// Public profiles and explicit handle resolution (ADR 0004 §5.8 "Profiles",
// docs/profiles.md, API.md `Profile` and `/resolve`). Ports
// crates/server/src/http/{profile,resolve}.rs.
//
// profile(m, did):
// 1. One synchronous read decides visibility first: an unknown, inactive or
//    suppressed DID is `null` (404) and no identity request is ever made for
//    it. The same transaction reads the counts and the indexing truth:
//    - totalScrobbles: visible scrobble rows of the DID;
//    - followerCount / followingCount: distinct visible edges (follows.ts);
//    - joinedAt / indexedAt: the stored columns verbatim (Rust serialises the
//      stored strings).
// 2. Only then is the identity resolved, through the DO's (cached) resolver.
//    The resolver reports a handle only when it verified both directions
//    (DID document alias → handle → the same DID); anything else — no claim,
//    a mismatch, an unavailable resolver or upstream — is `handle: null`. A
//    stored alias is never evidence on its own, and an identity failure never
//    hides the known user's music data.
//
// resolveHandle(m, handle) — the IndexRpc for GET /api/v1/resolve:
// handle → DID (DoH TXT or /.well-known/atproto-did) → that DID's document
// (cached resolver) → the document's verified handle must be the requested
// one. It creates no user, job or hint. Outcomes, as the Rust oracle's
// `resolution_error` mapping:
// - `ok` only for a verified round trip;
// - `not_found`: no DID published for the handle, or the DID document is
//   gone (404/410); also a handle the URL policy refuses (a reserved name the
//   HTTP layer's syntax gate did not already reject: it can never resolve);
// - `mismatch`: the two directions disagree (the document claims another
//   handle or none, ambiguous TXT answers, a document for another DID);
// - `upstream_error`: anything else (timeouts, 5xx, a blocked destination, a
//   malformed document).

import { type IdentityErrorCode, isIdentityError } from '@atmusic/atproto/identity/resolver';
import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import { isSafeFetchError } from '@atmusic/atproto/net/safe-fetch';
import type { Profile } from '@atmusic/core/api-types';
import { isHandle, normalizeHandle } from '@atmusic/core/syntax';
import type { ModuleDeps, ResolveOutcome } from '../contracts';
import type { Db } from '../db';
import { indexing } from '../status';
import { followCounts } from './follows';
import { activeUser, visibleScrobblesFrom } from './visibility';

/** The profile without its handle: everything one synchronous read decides. */
export type ProfileCore = Omit<Profile, 'handle'>;

/** The visible user's profile data, or null when the DID is unknown, inactive or suppressed. */
export function readProfileCore(db: Db, did: string, nowMs: number, mode: ModuleDeps['config']['ingestMode']) {
  return db.tx((): ProfileCore | null => {
    const user = db.one<{ did: string; joined_at: string; indexed_at: string | null }>(
      `SELECT u.did, u.joined_at, u.indexed_at FROM users u WHERE u.did = ? AND ${activeUser('u')}`,
      did,
    );
    if (user === null) return null;
    const total =
      db.one<{ n: number }>(`SELECT count(*) AS n FROM ${visibleScrobblesFrom('s', 'u')} WHERE s.did = ?`, did)?.n ?? 0;
    const counts = followCounts(db, did);
    return {
      did: user.did,
      joinedAt: user.joined_at,
      indexedAt: user.indexed_at,
      totalScrobbles: total,
      followerCount: counts.followerCount,
      followingCount: counts.followingCount,
      indexing: indexing(db, nowMs, { did, mode }),
    };
  });
}

/**
 * The handle the resolver verified in both directions for `did`, or null.
 * Failures are swallowed: an unverifiable identity only removes the display
 * claim (docs/profiles.md).
 */
export async function verifiedHandle(identity: IdentityResolver, did: string): Promise<string | null> {
  try {
    const resolved = await identity.resolveDid(did);
    if (resolved.did !== did || resolved.handle === null || !isHandle(resolved.handle)) return null;
    return normalizeHandle(resolved.handle);
  } catch {
    return null;
  }
}

/** IndexRpc.profile: null (404) for unknown, inactive or suppressed users, before any identity request. */
export async function profile(m: ModuleDeps, did: string): Promise<Profile | null> {
  const core = readProfileCore(m.db, did, m.clock.nowMs(), m.config.ingestMode);
  if (core === null) return null;
  const handle = await verifiedHandle(m.identity, did);
  // Field order as the Rust `Profile` struct.
  return {
    did: core.did,
    handle,
    joinedAt: core.joinedAt,
    indexedAt: core.indexedAt,
    totalScrobbles: core.totalScrobbles,
    followerCount: core.followerCount,
    followingCount: core.followingCount,
    indexing: core.indexing,
  };
}

const NOT_FOUND_CODES: ReadonlySet<IdentityErrorCode> = new Set<IdentityErrorCode>([
  'handle_not_found',
  'did_not_found',
  // Syntax and reserved names are refused by the HTTP layer (422); what can
  // still arrive is a host the URL policy refuses, which never resolves.
  'invalid_handle',
  'invalid_did',
]);

const MISMATCH_CODES: ReadonlySet<IdentityErrorCode> = new Set<IdentityErrorCode>(['ambiguous_handle', 'did_mismatch']);

/** Map a resolver failure to the resolve outcome (Rust `resolution_error`). */
export function classifyIdentityFailure(error: unknown): Exclude<ResolveOutcome, { status: 'ok' }> {
  if (isIdentityError(error)) {
    if (NOT_FOUND_CODES.has(error.code)) return { status: 'not_found' };
    if (MISMATCH_CODES.has(error.code)) return { status: 'mismatch' };
    return { status: 'upstream_error' };
  }
  if (isSafeFetchError(error, 'http_status') && (error.status === 404 || error.status === 410)) {
    return { status: 'not_found' };
  }
  return { status: 'upstream_error' };
}

function failure(m: ModuleDeps, stage: 'handle' | 'did', error: unknown): ResolveOutcome {
  const outcome = classifyIdentityFailure(error);
  if (outcome.status === 'upstream_error') {
    // The error code only: never the handle, URL or upstream body.
    const code = isIdentityError(error) || isSafeFetchError(error) ? error.code : 'unexpected';
    m.log.log('warn', 'resolve_upstream_error', { stage, code });
  }
  return outcome;
}

/** IndexRpc.resolveHandle: a verified handle ⇄ DID round trip through the DO's cached resolver. */
export async function resolveHandle(m: ModuleDeps, input: string): Promise<ResolveOutcome> {
  if (typeof input !== 'string' || !isHandle(input)) return { status: 'not_found' };
  const handle = normalizeHandle(input);
  let did: string;
  try {
    did = await m.identity.resolveHandle(handle);
  } catch (error) {
    return failure(m, 'handle', error);
  }
  let claimed: string | null;
  try {
    const identity = await m.identity.resolveDid(did);
    if (identity.did !== did) return { status: 'mismatch' };
    claimed = identity.handle;
  } catch (error) {
    return failure(m, 'did', error);
  }
  if (claimed === null || normalizeHandle(claimed) !== handle) return { status: 'mismatch' };
  return { status: 'ok', did, handle };
}
