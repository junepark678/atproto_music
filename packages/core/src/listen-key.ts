// Listen keys: idempotent protocol ingress and import dedupe (ADR 0005 §7.7,
// §11.2, §12.2; N1-12).
//
// listen key = lowercase hex SHA-256 over
//   "atmusic:listen-key:v1" ‖ field(did) ‖ field(floor(listenedAt in s), decimal)
//   ‖ field(artist_key) ‖ field(normalized track)
// where field(x) is the 4-byte big-endian UTF-8 length of x followed by its
// UTF-8 bytes, so distinct inputs never concatenate to the same bytes, and the
// domain tag keeps it apart from every other SHA-256 dedupe key (for example the
// now-playing forward key of §12.2, which hashes ms instead of s). The artist and
// track components are `trackKey` (music-key.ts), so case, NFKC and White_Space
// variants of a listen in the same second share one key, while another second
// or another DID does not.

import { type TrackKey, trackKey } from './music-key';
import { isDid } from './syntax';
import { NS_PER_SECOND } from './timestamp';

export const LISTEN_KEY_DOMAIN = 'atmusic:listen-key:v1';

export interface ListenKeyInput {
  readonly did: string;
  /** listenedAt as nanoseconds since the Unix epoch; only its floor in seconds counts. */
  readonly listenedAtNs: bigint;
  readonly artist: string;
  readonly track: string;
}

/** floor(ns / 1e9), rounding toward negative infinity. */
export function floorSeconds(ns: bigint): bigint {
  const s = ns / NS_PER_SECOND;
  return ns % NS_PER_SECOND < 0n ? s - 1n : s;
}

function framed(parts: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = parts.map((part) => encoder.encode(part));
  const out = new Uint8Array(encoded.reduce((n, bytes) => n + 4 + bytes.length, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length);
    out.set(bytes, offset + 4);
    offset += 4 + bytes.length;
  }
  return out;
}

/** The listen key of a DID, a whole UNIX second and a computed track key. */
export async function listenKeyOf(did: string, seconds: bigint, key: TrackKey): Promise<string> {
  if (!isDid(did)) throw new RangeError('listen key needs a syntactically valid DID');
  const [artist, track] = key;
  if (!artist.isWellFormed() || !track.isWellFormed()) throw new RangeError('track key contains a lone surrogate');
  const tag = new TextEncoder().encode(LISTEN_KEY_DOMAIN);
  const body = framed([did, seconds.toString(), artist, track]);
  const input = new Uint8Array(tag.length + body.length);
  input.set(tag, 0);
  input.set(body, tag.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The listen key of a listen. Throws `MusicKeyError` for an invalid artist or
 * track display string and `RangeError` for an invalid DID.
 */
export async function listenKey(input: ListenKeyInput): Promise<string> {
  const key = trackKey(input.artist, input.track);
  return listenKeyOf(input.did, floorSeconds(input.listenedAtNs), key);
}
