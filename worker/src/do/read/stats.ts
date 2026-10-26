// Exact, read-time statistics (ADR 0004 §5.8; API.md Statistics;
// crates/storage/src/repositories/stats.rs is the oracle).
//
// - Window: `listened_at ∈ [asOf − N·86400 s, asOf]`, both bounds inclusive at
//   nanosecond precision; `all` has no lower bound but still excludes rows
//   after asOf, so a future-dated record (accepted up to receipt + 300 s)
//   counts only once asOf reaches it (tests/goldens/windows.json).
// - Only a visible owner's rows count (visibility.ts). An unknown, inactive or
//   suppressed DID has no statistics: `stats` returns null and the route
//   answers 404.
// - Groups are the stored typed key components (write/keys.ts): artists by
//   `artist_key`, tracks by `(artist_key, track_key)`, albums by
//   `(artist_key, album_key)` with `album_key IS NOT NULL` (an omitted album
//   creates no bucket).
// - Ranking: count descending, then the group tuple ascending in SQLite BINARY
//   collation (UTF-8 byte order = code-point order = Rust `String`/tuple Ord).
// - Display spelling is the newest `(listened_at, uri)` row of the group:
//   `max(listened_at || ' ' || uri)` sorts as that tuple because the storage
//   timestamp is exactly 30 characters (a schema CHECK), so the URI starts at
//   character 32.
// - Totals: all listens, distinct artist keys, distinct track tuples.
//
// The window predicate is a plain range on `(did, listened_at)` (no
// `? IS NULL OR` term), so SQLite searches scrobbles_owner_time / scrobbles_stats
// for every statement; worker/test/read/stats-plan.test.ts pins the plans.
// Results go through the exact cache in stats-cache.ts.

import type { Did, Statistics, StatsWindow, TopAlbum, TopArtist, TopTrack } from '@atmusic/core/api-types';
import { STATS_WINDOWS } from '@atmusic/core/api-types';
import { NS_PER_SECOND, toDto, toStorage } from '@atmusic/core/timestamp';
import type { ModuleDeps, StatsQuery } from '../contracts';
import type { Db, SqlParam } from '../db';
import { readCache, type StatsUser, writeCache } from './stats-cache';
import { activeUser, visibleScrobblesFrom } from './visibility';

export const STATS_MIN_LIMIT = 1;
export const STATS_MAX_LIMIT = 100;

/** Window length in days; `all` has none. */
export const WINDOW_DAYS: Readonly<Record<StatsWindow, number | null>> = {
  all: null,
  '7d': 7,
  '30d': 30,
  '365d': 365,
};

const NS_PER_DAY = 86_400n * NS_PER_SECOND;

/** Storage-form window bounds: `upper` = asOf, `lower` = asOf − N days (null for `all`). Both inclusive. */
export interface StatsBounds {
  upper: string;
  lower: string | null;
}

export function windowBounds(window: StatsWindow, asOfNs: bigint): StatsBounds {
  if (!STATS_WINDOWS.includes(window)) throw new RangeError(`unknown statistics window ${String(window)}`);
  const days = WINDOW_DAYS[window];
  return {
    upper: toStorage(asOfNs),
    lower: days === null ? null : toStorage(asOfNs - BigInt(days) * NS_PER_DAY),
  };
}

export function checkStatsLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < STATS_MIN_LIMIT || limit > STATS_MAX_LIMIT) {
    throw new RangeError(`statistics limit must be an integer in ${STATS_MIN_LIMIT}..${STATS_MAX_LIMIT}, got ${limit}`);
  }
}

/** One prepared statement: SQL text plus its bound parameters. */
export interface Statement {
  sql: string;
  params: SqlParam[];
}

/**
 * `w`: the visible rows of the DID inside the window. `materialized` makes
 * SQLite evaluate it once (through the `(did, listened_at)` range) into a
 * temporary table; see the totals statement.
 */
function windowCte(bounds: StatsBounds, o: { materialized?: boolean } = {}): string {
  const lower = bounds.lower === null ? '' : ' AND s.listened_at >= ?';
  return `w AS ${o.materialized === true ? 'MATERIALIZED ' : ''}(SELECT s.uri, s.listened_at, s.artist_key, s.track_key, s.album_key FROM ${visibleScrobblesFrom('s', 'u')}
    WHERE s.did = ? AND s.listened_at <= ?${lower})`;
}

function windowParams(did: string, bounds: StatsBounds): SqlParam[] {
  return bounds.lower === null ? [did, bounds.upper] : [did, bounds.upper, bounds.lower];
}

/** Every statement `computeStatistics` runs, in order (exported for the query-plan suite). */
export function statsStatements(did: string, bounds: StatsBounds, limit: number) {
  checkStatsLimit(limit);
  const w = windowCte(bounds);
  const p = windowParams(did, bounds);
  // The totals statement reads `w` three times. Inlined, SQLite answers the
  // DISTINCT/GROUP BY subqueries from the covering scrobbles_stats index,
  // which is searched by DID only: a windowed request then read every row of
  // the DID twice, not just the window (W6-02 benchmark: 20,965 rows read for
  // a 959-row 7d window of a 10,000-row user). Materialized, the window is
  // read once through scrobbles_owner_time's (did, listened_at) range, so the
  // rows read stay proportional to the window. `all` has no lower bound, so
  // the inlined form already reads exactly the DID's rows and stays inlined.
  // Accepted by ADR 0004 §15 Q10; the per-statement rows-read bounds are
  // asserted by worker/test/bench/read-models.bench.test.ts.
  const totalsW = bounds.lower === null ? w : windowCte(bounds, { materialized: true });
  return {
    totals: {
      sql: `WITH ${totalsW}
        SELECT (SELECT count(*) FROM w) AS listens,
               (SELECT count(DISTINCT artist_key) FROM w) AS artists,
               (SELECT count(*) FROM (SELECT 1 FROM w GROUP BY artist_key, track_key)) AS tracks`,
      params: p,
    },
    artists: {
      sql: `WITH ${w},
        g AS (SELECT artist_key, count(*) AS c, max(listened_at || ' ' || uri) AS newest FROM w GROUP BY artist_key)
        SELECT d.artist AS artist, g.c AS c FROM g JOIN scrobbles d ON d.uri = substr(g.newest, 32)
        ORDER BY g.c DESC, g.artist_key ASC LIMIT ?`,
      params: [...p, limit],
    },
    tracks: {
      sql: `WITH ${w},
        g AS (SELECT artist_key, track_key, count(*) AS c, max(listened_at || ' ' || uri) AS newest
              FROM w GROUP BY artist_key, track_key)
        SELECT d.artist AS artist, d.track AS track, g.c AS c FROM g JOIN scrobbles d ON d.uri = substr(g.newest, 32)
        ORDER BY g.c DESC, g.artist_key ASC, g.track_key ASC LIMIT ?`,
      params: [...p, limit],
    },
    albums: {
      sql: `WITH ${w},
        g AS (SELECT artist_key, album_key, count(*) AS c, max(listened_at || ' ' || uri) AS newest
              FROM w WHERE album_key IS NOT NULL GROUP BY artist_key, album_key)
        SELECT d.artist AS artist, d.album AS album, g.c AS c FROM g JOIN scrobbles d ON d.uri = substr(g.newest, 32)
        ORDER BY g.c DESC, g.artist_key ASC, g.album_key ASC LIMIT ?`,
      params: [...p, limit],
    },
  } satisfies Record<string, Statement>;
}

/**
 * The statistics of `did` over `window` at `asOfNs`, straight from SQL (no
 * cache, no visibility check of the user row: rows of an invisible owner
 * simply do not match). Synchronous, so it reads one consistent state.
 */
export function computeStatistics(db: Db, did: Did, window: StatsWindow, limit: number, asOfNs: bigint): Statistics {
  const bounds = windowBounds(window, asOfNs);
  const st = statsStatements(did, bounds, limit);
  const totals = db.one<{ listens: number; artists: number; tracks: number }>(st.totals.sql, ...st.totals.params);
  if (totals === null) throw new Error('statistics totals query returned no row');
  const topArtists: TopArtist[] = db
    .all<{ artist: string; c: number }>(st.artists.sql, ...st.artists.params)
    .map((r) => ({ artist: r.artist, scrobbleCount: r.c }));
  const topTracks: TopTrack[] = db
    .all<{ artist: string; track: string; c: number }>(st.tracks.sql, ...st.tracks.params)
    .map((r) => ({ artist: r.artist, track: r.track, scrobbleCount: r.c }));
  const topAlbums: TopAlbum[] = db
    .all<{ artist: string; album: string | null; c: number }>(st.albums.sql, ...st.albums.params)
    .map((r) => {
      if (r.album === null) throw new Error('album group display row has no album');
      return { artist: r.artist, album: r.album, scrobbleCount: r.c };
    });
  return {
    did,
    window,
    asOf: toDto(asOfNs),
    totalScrobbles: totals.listens,
    distinctArtists: totals.artists,
    distinctTracks: totals.tracks,
    topArtists,
    topTracks,
    topAlbums,
  };
}

/** The visible users row of `did` (the cache version inputs), or null for unknown/inactive/suppressed. */
export function visibleStatsUser(db: Db, did: string): StatsUser | null {
  return db.one<StatsUser>(
    `SELECT u.stats_version AS stats_version, u.generation AS generation FROM users u
     WHERE u.did = ? AND ${activeUser('u')}`,
    did,
  );
}

export type CacheOutcome = 'hit' | 'miss';

export interface StatsResult {
  /** Null for an unknown, inactive or suppressed user (404). */
  statistics: Statistics | null;
  /** Whether a provably identical cached body served the request; null when there was nothing to compute. */
  cache: CacheOutcome | null;
}

/** `stats` plus how it was served (tests and logs observe the cache through this). */
export function statsWithCache(db: Db, q: StatsQuery): StatsResult {
  checkStatsLimit(q.limit);
  const bounds = windowBounds(q.window, q.asOfNs);
  const user = visibleStatsUser(db, q.did);
  if (user === null) return { statistics: null, cache: null };

  const key = { did: q.did, window: q.window, limit: q.limit };
  const cached = readCache(db, key, bounds, user);
  if (cached !== null) return { statistics: { ...cached, asOf: toDto(q.asOfNs) }, cache: 'hit' };

  const statistics = computeStatistics(db, q.did, q.window, q.limit, q.asOfNs);
  writeCache(db, key, bounds, user, statistics);
  return { statistics, cache: 'miss' };
}

/** IndexRpc.stats: the exact statistics, or null for unknown or inactive users (404). */
export function stats(m: ModuleDeps, q: StatsQuery): Statistics | null {
  return statsWithCache(m.db, q).statistics;
}
