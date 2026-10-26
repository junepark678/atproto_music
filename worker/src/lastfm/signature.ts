// Last.fm 2.0 request signatures and their method-scoped policy
// (ADR 0005 §7.3, §7.4, §7.5; N2-07).
//
// Computation (§7.4): every received parameter except `api_sig`, `format` and
// `callback` (`method` included), sorted by NAME in UTF-8 byte order
// (`artist[10]` before `artist[1]`, `Z` before `a`), concatenated as
// name + value with the decoded UTF-8 values, the secret appended, MD5 in hex.
// We sign exactly what we received, so a parameter a client left out (Pano
// drops empty values) is simply absent.
//
// Comparison is case-insensitive (both sides lowercased) and constant-time.
//
// Policy (§7.3, §7.4) — ONLY for methods whose §7.5 Auth column contains `sig`
// (requiresSignature): the auth.* methods and the write methods.
//   - Issued app key, or a known public pair (ATMUSIC_LASTFM_KNOWN_CLIENTS,
//     default panoScrobbler:panoScrobbler): api_sig must verify, else 13.
//   - Unknown api_key: the client signed with its own embedded secret, which we
//     cannot know. api_sig must be present and 32 hex characters, else 13; it is
//     not verified. Authorisation rests on the high-entropy sk, token or app
//     password (the GNU FM / Libre.fm / Maloja / multi-scrobbler model).
// For every other method api_sig is ignored whether present, absent or wrong.
//
// This is Last.fm request signing only. It has no bearing on atproto
// signature, CID, MST or identity verification, which are unchanged.

import { constantTimeEqual } from '../crypto/constant-time';
import { md5Hex } from '../crypto/md5';
import { LastfmError } from './errors';
import { LastfmParams } from './params';

/** Parameters that never take part in api_sig. */
export const UNSIGNED_PARAMS: ReadonlySet<string> = new Set(['api_sig', 'format', 'callback']);

/** ADR §7.5 methods whose Auth column contains `sig`. */
export const SIGNED_METHODS = [
  'auth.getToken',
  'auth.getSession',
  'auth.getMobileSession',
  'track.scrobble',
  'track.updateNowPlaying',
  'track.love',
  'track.unlove',
  'library.removeScrobble',
] as const;

/** ADR §7.5 read methods (Auth column "none"); api_sig is ignored for these. */
export const READ_METHODS = [
  'user.getTrackScrobbles',
  'user.getRecentTracks',
  'user.getInfo',
  'user.getTopArtists',
  'user.getTopAlbums',
  'user.getTopTracks',
  'user.getLovedTracks',
  'user.getWeeklyChartList',
  'user.getWeeklyArtistChart',
  'user.getWeeklyAlbumChart',
  'user.getWeeklyTrackChart',
  'user.getFriends',
  'library.getArtists',
  'track.getInfo',
  'artist.getInfo',
  'album.getInfo',
  'user.getTopTags',
  'artist.getTopTags',
  'track.getTopTags',
  'album.getTopTags',
] as const;

const SIGNED_LOWER: ReadonlySet<string> = new Set(SIGNED_METHODS.map((m) => m.toLowerCase()));

/**
 * True for the methods whose §7.5 Auth column contains `sig`. The match is
 * case-insensitive, so a dispatcher that resolves method names without regard
 * to case can never reach a signed method through an unsigned spelling.
 */
export function requiresSignature(method: string): boolean {
  return SIGNED_LOWER.has(method.toLowerCase());
}

const utf8 = new TextEncoder();

function compareBytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

type ParamSource = LastfmParams | Iterable<readonly [string, string]>;

function pairsOf(params: ParamSource): ReadonlyArray<readonly [string, string]> {
  return params instanceof LastfmParams ? [...params.entries()] : [...params];
}

/** The string that is hashed before the secret is appended: sorted name+value pairs. */
export function signatureBaseString(params: ParamSource): string {
  const pairs = pairsOf(params).filter(([name]) => !UNSIGNED_PARAMS.has(name));
  pairs.sort(([a], [b]) => compareBytes(a, b));
  return pairs.map(([name, value]) => name + value).join('');
}

/** Lowercase hex api_sig of `params` under `secret` (MD5 of the UTF-8 bytes). */
export function computeSignature(params: ParamSource, secret: string): string {
  return md5Hex(signatureBaseString(params) + secret);
}

const HEX32 = /^[0-9a-fA-F]{32}$/;

/** True when `apiSig` has the form of an api_sig: 32 hex characters, either case. */
export function isSignatureShaped(apiSig: string | undefined): apiSig is string {
  return apiSig !== undefined && HEX32.test(apiSig);
}

/** Constant-time, case-insensitive check of `apiSig` against params + secret. */
export function verifySignature(params: ParamSource, secret: string, apiSig: string | undefined): boolean {
  if (!isSignatureShaped(apiSig)) return false;
  return constantTimeEqual(computeSignature(params, secret), apiSig.toLowerCase());
}

export interface KnownClientPair {
  readonly apiKey: string;
  readonly sharedSecret: string;
}

export interface SignaturePolicyDeps {
  /** ATMUSIC_LASTFM_KNOWN_CLIENTS (node/config.ts lastfmKnownClients). */
  readonly knownClients: readonly KnownClientPair[];
  /** The opened secret of an issued app key (credentials/lastfm-apps.ts), or null. */
  issuedSecret(apiKey: string): string | null | Promise<string | null>;
}

export type SignatureCheck =
  /** A read method: api_sig was not looked at. */
  | { readonly required: false }
  /** api_sig verified under a known public pair or an issued app's secret. */
  | { readonly required: true; readonly keyKind: 'known' | 'issued'; readonly verified: true }
  /** Unknown api_key: api_sig had the right form and could not be verified. */
  | { readonly required: true; readonly keyKind: 'unknown'; readonly verified: false };

const NOT_REQUIRED: SignatureCheck = Object.freeze({ required: false });

/**
 * Applies the §7.4 policy to one request. Resolves for a read method without
 * looking at api_sig; for a signed method it throws LastfmError 13 when the
 * signature fails, and 10 when api_key is missing.
 */
export async function enforceSignaturePolicy(
  method: string,
  params: LastfmParams,
  deps: SignaturePolicyDeps,
): Promise<SignatureCheck> {
  if (!requiresSignature(method)) return NOT_REQUIRED;
  const apiKey = params.get('api_key');
  if (apiKey === undefined || apiKey === '') throw new LastfmError(10);
  const apiSig = params.get('api_sig');

  const known = deps.knownClients.find((c) => c.apiKey === apiKey);
  if (known !== undefined) {
    if (!verifySignature(params, known.sharedSecret, apiSig)) throw new LastfmError(13);
    return { required: true, keyKind: 'known', verified: true };
  }
  const issued = await deps.issuedSecret(apiKey);
  if (issued !== null) {
    if (!verifySignature(params, issued, apiSig)) throw new LastfmError(13);
    return { required: true, keyKind: 'issued', verified: true };
  }
  if (!isSignatureShaped(apiSig)) throw new LastfmError(13);
  return { required: true, keyKind: 'unknown', verified: false };
}
