// The exact range-statistics cache (ADR 0005 §10.3; N2-06). The ADR 0004 §5.8
// exact-cache argument (worker/src/do/read/stats-cache.ts), generalised from the
// four /api/v1 windows to arbitrary half-open ranges `[lower, upper)`.
//
// `range_stats_cache(did, entity, range_key)` holds the FULL ranked list and the
// totals of one entity over one named range, computed from the rows of the
// owner's `users.stats_version` at that moment, together with the storage-form
// bounds it was computed for (`lower` inclusive or NULL, `upper` exclusive). A
// request for the same (did, entity, range_key) at bounds [lower1, upper1) is
// served from the row only when the window contents are provably identical:
//
// 1. `users.stats_version` is unchanged, and the users row's `generation` equals
//    the one stored in the body. Every insert, change or delete of one of the
//    DID's scrobble rows bumps the version in the same transaction
//    (write/apply-record.ts), so the DID's row set is exactly the one the body
//    was computed from; a recreated users row (reset version) cannot match an
//    old body because its generation differs.
// 2. No row of the DID has `listened_at` in `[min(upper0, upper1), max(upper0, upper1))`.
// 3. No row of the DID has `listened_at` in `[min(lower0, lower1), max(lower0, lower1))`
//    (a lower bound on one side only is a miss).
//
// With the row set fixed (1), a row's membership in `[lower0, upper0)` and in
// `[lower1, upper1)` can only differ when its timestamp lies in one of the two
// difference intervals (2, 3), so both windows hold the same rows and every
// total, ranking and display spelling is the same. A fixed calendar range has
// identical bounds, so (1) alone decides; a sliding range (one that ends at
// now) needs the probes. Both probes are indexed EXISTS searches on
// scrobbles_owner_time. A hit is served with the request's bounds; the stored
// row is left as it was.
//
// Writes happen in their own transaction and only while the users row still
// has the version and generation the computation read, so a body is never
// stored under a version it was not computed from. Bodies over 4 MiB (UTF-8)
// are not stored (ADR §10.3). `range_stats_cache` is a derived table
// (schema.ts TABLE_CLASS): a restore or a disconnect may drop it at any time.

import type { Db } from '../db';
import type { StatsUser } from './stats-cache';

/** Bodies larger than this many UTF-8 bytes are never cached (ADR 0005 §10.3). */
export const MAX_CACHED_BODY_BYTES = 4 * 1024 * 1024;

/** A caller-chosen name for a range (`lastfm:7day`, `lb:week`, `lastfm:week:1108296000`). */
export const RANGE_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Storage-form bounds: `lower` inclusive (null: unbounded), `upper` exclusive. */
export interface StorageRange {
  lower: string | null;
  upper: string;
}

export interface RangeCacheKey {
  did: string;
  entity: string;
  rangeKey: string;
}

export interface RangeCacheRow {
  as_of: string;
  lower: string | null;
  upper: string | null;
  version: number;
  body: string;
}

/** What a cache row's body holds: the users generation plus the caller's payload. */
interface CacheEnvelope<T> {
  generation: number;
  entity: string;
  payload: T;
}

export function checkRangeKey(rangeKey: string): void {
  if (typeof rangeKey !== 'string' || !RANGE_KEY.test(rangeKey)) {
    throw new RangeError(`range key must match ${RANGE_KEY.source}, got ${JSON.stringify(rangeKey)}`);
  }
}

export function readRangeCacheRow(db: Db, key: RangeCacheKey): RangeCacheRow | null {
  return db.one<RangeCacheRow>(
    'SELECT as_of, lower, upper, version, body FROM range_stats_cache WHERE did = ? AND entity = ? AND range_key = ?',
    key.did,
    key.entity,
    key.rangeKey,
  );
}

function ordered(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** One prepared probe: SQL text plus its bound parameters. */
export interface Probe {
  sql: string;
  params: string[];
}

/**
 * The EXISTS probes that must all be false for the cached range to hold the
 * same rows as the requested one; null when the bounds cannot be compared (a
 * lower bound on one side only), which is a miss.
 */
export function rangeCacheProbes(did: string, cached: StorageRange, current: StorageRange): Probe[] | null {
  if ((cached.lower === null) !== (current.lower === null)) return null;
  const probes: Probe[] = [];
  if (cached.upper !== current.upper) {
    const [lo, hi] = ordered(cached.upper, current.upper);
    probes.push({
      sql: 'SELECT EXISTS (SELECT 1 FROM scrobbles WHERE did = ? AND listened_at >= ? AND listened_at < ?) AS hit',
      params: [did, lo, hi],
    });
  }
  if (cached.lower !== null && current.lower !== null && cached.lower !== current.lower) {
    const [lo, hi] = ordered(cached.lower, current.lower);
    probes.push({
      sql: 'SELECT EXISTS (SELECT 1 FROM scrobbles WHERE did = ? AND listened_at >= ? AND listened_at < ?) AS hit',
      params: [did, lo, hi],
    });
  }
  return probes;
}

function parseEnvelope<T>(text: string): CacheEnvelope<T> | null {
  try {
    const parsed = JSON.parse(text) as Partial<CacheEnvelope<T>> | null;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof parsed.generation !== 'number' || typeof parsed.entity !== 'string') return null;
    if (parsed.payload === null || typeof parsed.payload !== 'object') return null;
    return parsed as CacheEnvelope<T>;
  } catch {
    return null;
  }
}

/** The cached payload when provably identical to a fresh computation over `range`, else null. */
export function readRangeCache<T>(db: Db, key: RangeCacheKey, range: StorageRange, user: StatsUser): T | null {
  const row = readRangeCacheRow(db, key);
  if (row === null || row.version !== user.stats_version || row.upper === null) return null;
  const body = parseEnvelope<T>(row.body);
  if (body === null || body.generation !== user.generation || body.entity !== key.entity) return null;
  const probes = rangeCacheProbes(key.did, { lower: row.lower, upper: row.upper }, range);
  if (probes === null) return null;
  for (const probe of probes) {
    const found = db.one<{ hit: number }>(probe.sql, ...probe.params);
    if (found === null || found.hit !== 0) return null;
  }
  return body.payload;
}

/** `stale`: the users row changed since the computation read it, so nothing was stored. */
export type RangeCacheWrite = 'stored' | 'stale' | 'too_large';

/**
 * Store `payload` (computed over `range` from the rows of `user.stats_version`)
 * in its own transaction, guarded by that version and generation. A body over
 * MAX_CACHED_BODY_BYTES is not stored.
 */
export function writeRangeCache<T>(
  db: Db,
  key: RangeCacheKey,
  range: StorageRange,
  user: StatsUser,
  payload: T,
  at: { asOf: string; nowMs: number },
): RangeCacheWrite {
  const envelope: CacheEnvelope<T> = { generation: user.generation, entity: key.entity, payload };
  const body = JSON.stringify(envelope);
  // UTF-16 length bounds the UTF-8 length from below; encode only when it could fit.
  if (body.length > MAX_CACHED_BODY_BYTES || new TextEncoder().encode(body).length > MAX_CACHED_BODY_BYTES) {
    return 'too_large';
  }
  const written = db.tx(() =>
    db.run(
      `INSERT INTO range_stats_cache(did, entity, range_key, as_of, lower, upper, version, body, created_at_ms)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM users WHERE did = ? AND stats_version = ? AND generation = ?)
       ON CONFLICT(did, entity, range_key) DO UPDATE SET as_of = excluded.as_of, lower = excluded.lower,
         upper = excluded.upper, version = excluded.version, body = excluded.body,
         created_at_ms = excluded.created_at_ms`,
      key.did,
      key.entity,
      key.rangeKey,
      at.asOf,
      range.lower,
      range.upper,
      user.stats_version,
      body,
      at.nowMs,
      key.did,
      user.stats_version,
      user.generation,
    ),
  );
  return written.rowsWritten > 0 ? 'stored' : 'stale';
}
