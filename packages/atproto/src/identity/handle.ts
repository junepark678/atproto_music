// Handle resolution and bidirectional handle verification
// (https://atproto.com/specs/handle; ADR 0004 §5.6; W2-02).
//
// `resolveHandle(handle)` follows the Rust oracle's `handle_did`
// (crates/atproto/src/identity.rs), sequentially:
//
//   0. Host policy before any lookup: a handle under a reserved TLD (the URL
//      policy's set — arpa, example, invalid, local, localhost, onion, test,
//      plus alt and internal) is `invalid_handle`, with no DoH or HTTPS
//      request. The oracle refuses these in `SafeClient::txt` and in its
//      address lookup (`reject_reserved_domain`); here the TXT path does not
//      go through SafeFetch, so the gate is explicit. Only a fixture transport
//      admits the fixture TLDs `.test` / `.example`, exactly as checkUrl does.
//   1. DoH TXT `_atproto.<handle>` through the pinned dns-json endpoint
//      (net/doh.ts), when the extra label still fits in 253 characters. The
//      `did=` values that are resolvable DIDs are collected as a set: two or
//      more distinct DIDs are `ambiguous_handle` (no HTTPS fallback), exactly
//      one is the answer. A failed TXT lookup or no `did=` value falls through.
//   2. `https://<handle>/.well-known/atproto-did` through SafeFetch: URL policy,
//      DoH pre-check, any 3xx refused (redirects are never followed), 10 s
//      deadline, small body cap. The response must be `text/plain` and its
//      trimmed body a resolvable DID.
//
// The HTTPS lookup is made only when DNS gave no answer, so a handle that
// publishes TXT costs one DoH request and no attacker-chosen fetch.
//
// We call this directly rather than through @atcute/identity-resolver's
// handle resolvers: its composite resolver starts the HTTPS request in
// parallel with DNS for every strategy, its DoH resolver treats two identical
// TXT records as ambiguous and stops at an invalid first `did=` value, and its
// well-known resolver accepts any content-type. Each differs from the oracle.
//
// `verifyHandle(did, doc)` is the bidirectional check: the document's claimed
// handle (first valid `at://` alias) must resolve back to the same DID.
// Anything else — no claim, a lookup failure, or a different DID — is null.

import type { Clock } from '@atmusic/core/deps';
import { isHandle, MAX_HANDLE_LENGTH } from '@atmusic/core/syntax';
import { queryDoh, RR_TXT } from '../net/doh';
import { createSafeFetch, type DeadlineTimer, isSafeFetchError, type SafeFetch, systemTimer } from '../net/safe-fetch';
import { checkUrl, isFixtureTransport } from '../net/url-policy';
import { fetchTransport, type Transport } from '../transport';
import { claimedHandle, type DidDocument, IdentityError, isResolvableDid } from './did-doc';

const TXT_LABEL = '_atproto.';
const DID_PREFIX = 'did=';
/** A DID is at most 2048 bytes; leave room for surrounding whitespace. */
export const WELL_KNOWN_MAX_BYTES = 4096;
const DOH_DEADLINE_MS = 10_000;

export interface HandleResolverOptions {
  transport?: Transport;
  clock: Clock;
  /** Deadline source for SafeFetch and the TXT lookup; defaults to AbortSignal.timeout. */
  timer?: DeadlineTimer;
  /** A SafeFetch already built over `transport` (shared DoH pre-check cache). */
  safeFetch?: SafeFetch;
}

export interface HandleResolver {
  /** Handle → DID; throws IdentityError (or a transport SafeFetchError) when unresolved. */
  resolveHandle(handle: string): Promise<string>;
  /** The document's claimed handle when it resolves back to `did`, else null. */
  verifyHandle(did: string, doc: Pick<DidDocument, 'alsoKnownAs'>): Promise<string | null>;
}

/** Validate and lowercase a handle, or throw `invalid_handle`. */
export function normalizeHandleInput(handle: string): string {
  if (typeof handle !== 'string' || handle.length > MAX_HANDLE_LENGTH || !isHandle(handle)) {
    throw new IdentityError('invalid_handle', 'invalid handle');
  }
  return handle.toLowerCase();
}

/**
 * The text of one dns-json TXT `data` field: one or more quoted
 * character-strings (`"a" "b"`) are unescaped and concatenated; an unquoted
 * value is taken as is.
 */
export function txtData(data: string): string {
  const text = data.trim();
  if (!text.startsWith('"')) return text;
  let out = '';
  const re = /"((?:[^"\\]|\\.)*)"\s*/gy;
  let consumed = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out += (m[1] as string).replace(/\\(\d{3}|.)/g, (_, esc: string) =>
      esc.length === 3 ? String.fromCharCode(Number(esc)) : esc,
    );
    consumed = re.lastIndex;
  }
  return consumed === text.length ? out : text;
}

export function createHandleResolver(options: HandleResolverOptions): HandleResolver {
  const transport = options.transport ?? fetchTransport;
  const timer = options.timer ?? systemTimer;
  const safeFetch = options.safeFetch ?? createSafeFetch({ transport, clock: options.clock, timer });
  const fixture = isFixtureTransport(transport);

  /** Refuse a handle whose host the URL policy refuses (reserved TLDs), before any lookup. */
  function assertResolvableHost(handle: string): void {
    const check = checkUrl(`https://${handle}/`, { fixture });
    if (!check.ok) throw new IdentityError('invalid_handle', `handle host refused by URL policy: ${check.reason}`);
  }

  async function txtDids(handle: string): Promise<Set<string> | null> {
    if (handle.length + TXT_LABEL.length > MAX_HANDLE_LENGTH) return null; // label would not fit: HTTPS only
    let answers: Awaited<ReturnType<typeof queryDoh>>;
    try {
      answers = await queryDoh(`${TXT_LABEL}${handle}`, RR_TXT, transport, {
        signal: timer.timeout(DOH_DEADLINE_MS),
      });
    } catch {
      return null; // as the oracle: a failed TXT lookup falls through to HTTPS
    }
    const dids = new Set<string>();
    for (const rr of answers) {
      if (rr.type !== RR_TXT) continue;
      const value = txtData(rr.data);
      if (!value.startsWith(DID_PREFIX)) continue;
      const did = value.slice(DID_PREFIX.length);
      if (isResolvableDid(did)) dids.add(did);
    }
    return dids;
  }

  async function wellKnownDid(handle: string): Promise<string> {
    let res: Awaited<ReturnType<SafeFetch>>;
    try {
      res = await safeFetch(`https://${handle}/.well-known/atproto-did`, {
        kind: 'json',
        accept: 'text/plain',
        maxBytes: WELL_KNOWN_MAX_BYTES,
      });
    } catch (error) {
      if (isSafeFetchError(error, 'http_status') && (error.status === 404 || error.status === 410)) {
        throw new IdentityError('handle_not_found', `no DID published for ${handle}`, { cause: error });
      }
      throw error;
    }
    const mime = (res.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (mime !== 'text/plain') {
      throw new IdentityError('invalid_handle_response', `/.well-known/atproto-did is ${mime || 'untyped'}`);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(res.body);
    } catch {
      throw new IdentityError('invalid_handle_response', '/.well-known/atproto-did is not UTF-8');
    }
    const did = text.trim();
    if (!isResolvableDid(did)) {
      throw new IdentityError('invalid_handle_response', '/.well-known/atproto-did is not a resolvable DID');
    }
    return did;
  }

  async function resolveHandle(input: string): Promise<string> {
    const handle = normalizeHandleInput(input);
    assertResolvableHost(handle);
    const dids = await txtDids(handle);
    if (dids !== null && dids.size > 1) {
      throw new IdentityError('ambiguous_handle', `${handle} publishes ${dids.size} different DIDs`);
    }
    if (dids !== null && dids.size === 1) return dids.values().next().value as string;
    return wellKnownDid(handle);
  }

  async function verifyHandle(did: string, doc: Pick<DidDocument, 'alsoKnownAs'>): Promise<string | null> {
    const claim = claimedHandle(doc);
    if (claim === null) return null;
    try {
      return (await resolveHandle(claim)) === did ? claim : null;
    } catch {
      return null;
    }
  }

  return { resolveHandle, verifyHandle };
}
