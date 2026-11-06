// The exact statistics cache (ADR 0004 §5.8 "Exact stats cache").
//
// `stats_cache(did, win, lim)` holds the body computed at `as_of` (asOf0) with
// window lower bound `lower` (lower0) and the owner's `users.stats_version` at
// that moment. The body is reused for a request at asOf1 (lower1) only when
// the window contents are provably identical:
//
// 1. `users.stats_version` is unchanged. Every insert, change or delete of one
//    of the DID's scrobble rows bumps it in the same transaction
//    (write/apply-record.ts applyRecordTarget), so the set and content of the
//    DID's rows are exactly those the body was computed from. The users row's
//    `generation` is checked as well (it is part of the stored body), so a
//    users row recreated with a reset version can never match an old body.
// 2. No row of the DID has `listened_at` between the two upper bounds:
//    `(min(asOf0, asOf1), max(asOf0, asOf1)]` (normally `(asOf0, asOf1]`).
// 3. No row of the DID has `listened_at` between the two lower bounds:
//    `[min(lower0, lower1), max(lower0, lower1))` (normally `[lower0, lower1)`).
//
// With the row set fixed (1), membership of a row in `[lower, upper]` can only
// differ between the two windows if its timestamp lies in one of the two
// difference intervals (2, 3), so the windows hold the same rows and every
// total, ranking and display spelling is the same. Both probes are indexed
// EXISTS searches on scrobbles_owner_time. A hit returns the body with the
// *current* asOf; the stored row is left as it is.
//
// The cache is written in its own transaction, guarded by the same version
// read the computation used, so a body is never stored under a version it was
// not computed from. Disconnect deletes a DID's rows (write/suppression.ts).

import type { Statistics, StatsWindow } from '@atmusic/core/api-types';
import type { Db } from '../db';
import type { Statement, StatsBounds } from './stats';

export interface StatsCacheKey {
  did: string;
  window: StatsWindow;
  limit: number;
}

/** The cache-validity inputs of a visible users row. */
export interface StatsUser {
  stats_version: number;
  generation: number;
}

export interface StatsCacheRow {
  as_of: string;
  lower: string | null;
  version: number;
  body: string;
}

interface CacheBody {
  generation: number;
  statistics: Statistics;
}

export function readCacheRow(db: Db, key: StatsCacheKey): StatsCacheRow | null {
  return db.one<StatsCacheRow>(
    'SELECT as_of, lower, version, body FROM stats_cache WHERE did = ? AND win = ? AND lim = ?',
    key.did,
    key.window,
    key.limit,
  );
}

function ordered(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * The EXISTS probes that must both be false for a cached window to equal the
 * requested one; null when the bounds cannot be compared (a lower bound on
 * one side only), which is a miss.
 */
export function cacheProbes(did: string, cached: StatsBounds, current: StatsBounds): Statement[] | null {
  if ((cached.lower === null) !== (current.lower === null)) return null;
  const probes: Statement[] = [];
  if (cached.upper !== current.upper) {
    const [lo, hi] = ordered(cached.upper, current.upper);
    probes.push({
      sql: 'SELECT EXISTS (SELECT 1 FROM scrobbles WHERE did = ? AND listened_at > ? AND listened_at <= ?) AS hit',
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

function parseBody(text: string): CacheBody | null {
  try {
    const parsed = JSON.parse(text) as Partial<CacheBody> | null;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof parsed.generation !== 'number' || parsed.statistics === null || typeof parsed.statistics !== 'object') {
      return null;
    }
    return parsed as CacheBody;
  } catch {
    return null;
  }
}

/** The cached statistics when provably identical to a fresh computation at `bounds`, else null. */
export function readCache(db: Db, key: StatsCacheKey, bounds: StatsBounds, user: StatsUser): Statistics | null {
  const row = readCacheRow(db, key);
  if (row === null || row.version !== user.stats_version) return null;
  const body = parseBody(row.body);
  if (
    body === null ||
    body.generation !== user.generation ||
    body.statistics.did !== key.did ||
    body.statistics.window !== key.window
  ) {
    return null;
  }
  const probes = cacheProbes(key.did, { upper: row.as_of, lower: row.lower }, bounds);
  if (probes === null) return null;
  for (const probe of probes) {
    const found = db.one<{ hit: number }>(probe.sql, ...probe.params);
    if (found === null || found.hit !== 0) return null;
  }
  return body.statistics;
}

/**
 * Store `statistics` (computed at `bounds` from the rows of version
 * `user.stats_version`) in its own transaction. The insert only happens while
 * the users row still has that version and generation.
 */
export function writeCache(
  db: Db,
  key: StatsCacheKey,
  bounds: StatsBounds,
  user: StatsUser,
  statistics: Statistics,
): void {
  const body: CacheBody = { generation: user.generation, statistics };
  db.tx(() => {
    db.run(
      `INSERT INTO stats_cache(did, win, lim, as_of, lower, version, body)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM users WHERE did = ? AND stats_version = ? AND generation = ?)
       ON CONFLICT(did, win, lim) DO UPDATE SET as_of = excluded.as_of, lower = excluded.lower,
         version = excluded.version, body = excluded.body`,
      key.did,
      key.window,
      key.limit,
      bounds.upper,
      bounds.lower,
      user.stats_version,
      JSON.stringify(body),
      key.did,
      user.stats_version,
      user.generation,
    );
  });
}
