// The identity_cache table behind identity resolution (ADR 0004 §5.4 step 4,
// §6.1; M2.1.1 cache_expiry).
//
// - Positive entries: a resolved identity is served for IDENTITY_TTL_MS (5 min)
//   after `fetched_at_ms` by the injected clock: an entry aged 299 s is served,
//   one aged 300 s or more is refetched (`age < TTL`).
// - Negative entries: a definite identity failure (IdentityError: the DID
//   document is gone, malformed, for another DID, or has no usable `#atproto`
//   key or PDS) is remembered for IDENTITY_NEGATIVE_TTL_MS (1 h) in
//   `neg_until_ms`; until then the DID is not re-resolved and the positive
//   fields are cleared, so a stale identity is never served. Transport-level
//   failures (SafeFetchError: timeout, 429/5xx, blocked destination) are
//   never cached; the caller backs off instead.
// - `fresh: true` (the bad_signature retry, the identity sweep) bypasses both
//   entries and rewrites the row with what it found.
// - A put whose signing key differs from the cached one also forgets the DID's
//   `verified_commits` (commit-cache.ts): a cached signature check was made
//   under the old key, and trust is current-head trust under the current key
//   (ADR §7).
//
// `identityCache(db, clock)` is the hook packages/atproto's
// `createIdentityResolver` takes (`IdentityCache`); `cachedIdentityResolver`
// wires the two, which is how IndexDO (W5-01) builds `ModuleDeps.identity`.
// `resolveIdentity(m, did)` adds the negative entries around `m.identity`.
// Every DB access here is a single statement, so nothing spans an await.

import { IdentityError, isIdentityError } from '@atmusic/atproto/identity/did-doc';
import { createIdentityResolver, type IdentityCache } from '@atmusic/atproto/identity/resolver';
import type { IdentityResolver, ResolvedIdentity } from '@atmusic/atproto/identity/types';
import type { DeadlineTimer } from '@atmusic/atproto/net/safe-fetch';
import type { Transport } from '@atmusic/atproto/transport';
import type { Clock } from '@atmusic/core/deps';
import type { ModuleDeps } from '../contracts';
import type { Db } from '../db';
import { forgetVerifiedCommits } from './commit-cache';

export const IDENTITY_TTL_MS = 5 * 60_000;
export const IDENTITY_NEGATIVE_TTL_MS = 60 * 60_000;

export interface IdentityCacheRow {
  did: string;
  doc_json: string | null;
  signing_key: string | null;
  pds: string | null;
  handle: string | null;
  fetched_at_ms: number;
  neg_until_ms: number | null;
}

export function readIdentityRow(db: Db, did: string): IdentityCacheRow | null {
  return db.one<IdentityCacheRow>('SELECT * FROM identity_cache WHERE did = ?', did);
}

/** The cached identity of `did` when it is still fresh at `now`, else null. */
export function cachedIdentity(db: Db, did: string, now: number): ResolvedIdentity | null {
  const row = readIdentityRow(db, did);
  if (row === null || row.neg_until_ms !== null) return null;
  if (row.signing_key === null || row.pds === null) return null;
  if (!(now - row.fetched_at_ms < IDENTITY_TTL_MS) || row.fetched_at_ms > now) return null;
  return {
    did: row.did,
    pds: row.pds,
    signingKey: row.signing_key,
    handle: row.handle,
    fetchedAtMs: row.fetched_at_ms,
  };
}

/** Whether `did` has a negative entry at `now`; its expiry instant, or null. */
export function negativeUntil(db: Db, did: string, now: number): number | null {
  const row = readIdentityRow(db, did);
  return row?.neg_until_ms != null && row.neg_until_ms > now ? row.neg_until_ms : null;
}

/** Store a successful resolution (positive entry, negative entry cleared). */
export function putIdentity(db: Db, identity: ResolvedIdentity, docJson: string | null): void {
  db.tx(() => {
    const previous = readIdentityRow(db, identity.did);
    if (previous?.signing_key != null && previous.signing_key !== identity.signingKey) {
      forgetVerifiedCommits(db, identity.did);
    }
    db.run(
      `INSERT INTO identity_cache(did, doc_json, signing_key, pds, handle, fetched_at_ms, neg_until_ms)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(did) DO UPDATE SET doc_json = excluded.doc_json, signing_key = excluded.signing_key,
         pds = excluded.pds, handle = excluded.handle, fetched_at_ms = excluded.fetched_at_ms, neg_until_ms = NULL`,
      identity.did,
      docJson,
      identity.signingKey,
      identity.pds,
      identity.handle,
      identity.fetchedAtMs,
    );
  });
}

/** Remember a definite failure for IDENTITY_NEGATIVE_TTL_MS; the positive fields are cleared. */
export function putNegative(db: Db, did: string, now: number): number {
  const until = now + IDENTITY_NEGATIVE_TTL_MS;
  db.run(
    `INSERT INTO identity_cache(did, doc_json, signing_key, pds, handle, fetched_at_ms, neg_until_ms)
     VALUES (?, NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(did) DO UPDATE SET doc_json = NULL, signing_key = NULL, pds = NULL, handle = NULL,
       fetched_at_ms = excluded.fetched_at_ms, neg_until_ms = excluded.neg_until_ms`,
    did,
    now,
    until,
  );
  return until;
}

/** Drop entries that can no longer be served (gc): stale positives and expired negatives. */
export function pruneIdentityCache(db: Db, now: number): number {
  return db.all(
    `DELETE FROM identity_cache WHERE (neg_until_ms IS NULL AND fetched_at_ms <= ?)
       OR (neg_until_ms IS NOT NULL AND neg_until_ms <= ?) RETURNING did`,
    now - IDENTITY_TTL_MS,
    now,
  ).length;
}

/** The `IdentityCache` hook over identity_cache, read with the injected clock. */
export function identityCache(db: Db, clock: Clock): IdentityCache {
  return {
    get: (did) => cachedIdentity(db, did, clock.nowMs()),
    put: (identity, docJson) => putIdentity(db, identity, docJson),
  };
}

export interface CachedResolverOptions {
  transport: Transport;
  clock: Clock;
  timer?: DeadlineTimer;
}

/** The IdentityResolver IndexDO puts in ModuleDeps: packages/atproto's resolver over identity_cache. */
export function cachedIdentityResolver(db: Db, o: CachedResolverOptions): IdentityResolver {
  return createIdentityResolver({
    transport: o.transport,
    clock: o.clock,
    cache: identityCache(db, o.clock),
    ...(o.timer === undefined ? {} : { timer: o.timer }),
  });
}

export type IdentityOutcome =
  | { ok: true; identity: ResolvedIdentity; fromCache: boolean }
  /** Definite failure (now negatively cached), or a negative entry still in force. */
  | { ok: false; kind: 'invalid'; code: string; retryAt: number }
  /** Transport-level failure: not cached; the caller backs off. */
  | { ok: false; kind: 'transient'; error: unknown };

/**
 * Resolve `did` through `m.identity` with the negative cache in front of it.
 * `fresh: true` bypasses every cache entry.
 */
export async function resolveIdentity(
  m: Pick<ModuleDeps, 'db' | 'clock' | 'identity'>,
  did: string,
  o: { fresh?: boolean } = {},
): Promise<IdentityOutcome> {
  const now = m.clock.nowMs();
  if (o.fresh !== true) {
    const negative = negativeUntil(m.db, did, now);
    if (negative !== null) return { ok: false, kind: 'invalid', code: 'negative_cache', retryAt: negative };
  }
  if (o.fresh !== true) {
    const hit = cachedIdentity(m.db, did, now);
    if (hit !== null) return { ok: true, identity: hit, fromCache: true };
  }
  try {
    const identity = await m.identity.resolveDid(did, o.fresh === true ? { fresh: true } : undefined);
    if (identity.did !== did) throw new IdentityError('did_mismatch', `resolver returned ${identity.did} for ${did}`);
    // A resolver built with `identityCache` has already stored it (with the
    // document); one built without the hook is cached here.
    const row = readIdentityRow(m.db, did);
    if (row === null || row.fetched_at_ms !== identity.fetchedAtMs || row.signing_key !== identity.signingKey) {
      putIdentity(m.db, identity, null);
    }
    return { ok: true, identity, fromCache: false };
  } catch (error) {
    if (isIdentityError(error)) {
      const retryAt = putNegative(m.db, did, m.clock.nowMs());
      return { ok: false, kind: 'invalid', code: error.code, retryAt };
    }
    return { ok: false, kind: 'transient', error };
  }
}
