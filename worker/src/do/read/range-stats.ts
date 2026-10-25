// The generalised statistics engine for the Last.fm 2.0 and ListenBrainz
// compatible APIs (ADR 0005 §10.2; N2-06). The /api/v1 statistics stay in
// ./stats.ts, unchanged (ADR §10.1 "/api/v1 windows").
//
// - Computed on read with the ADR 0004 §5.8 SQL shape (./stats.ts), generalised
//   to arbitrary half-open bounds `[lower, upper)` plus LIMIT/OFFSET. Bounds are
//   given in epoch ms; `upperInclusive` turns `[lower, upper]` (the rolling and
//   `this_*` ranges that end at now, packages/core/src/periods.ts) into the
//   exact half-open `[lower, upper + 1 ns)` over the nanosecond storage form.
// - Only a visible owner's rows count (./visibility.ts). An unknown, inactive
//   or suppressed DID has no statistics: `rangeStats` returns null.
// - Groups are the stored typed key components (write/keys.ts): artists by
//   `artist_key`; tracks by `(artist_key, track_key)`; albums by the
//   album-artist grouping `(coalesce(album_artist_key, artist_key), album_key)`
//   with `album_key IS NOT NULL` (ADR §6.5; the /api/v1 albums keep
//   `(artist_key, album_key)`).
// - Ranking: count descending, then the group tuple ascending in SQLite BINARY
//   collation (UTF-8 byte order = code-point order = the Rust tuple Ord).
// - Display text (and the MBIDs) come from the newest `(listened_at, uri)` row of
//   the group: `max(listened_at || ' ' || uri)` sorts as that tuple because the
//   storage timestamp is exactly 30 characters (a schema CHECK), so the URI
//   starts at character 32. A track's `durationSeconds` is the one of the newest
//   row that has a duration (ADR §7.9), else null. An album's display artist is
//   the newest row's album artist, else its artist.
// - Totals: listens, distinct artists, distinct tracks and distinct albums (the
//   album-artist grouping).
// - Paging is offset-based (a deep offset costs O(offset) index steps, bounded
//   by the user's history). `rank` is the 1-based position in the full ranking.
// - Results go through the exact cache in ./range-stats-cache.ts when the caller
//   names the range (`rangeKey`); unnamed ranges (arbitrary client bounds) are
//   computed every time, so a client cannot grow the cache without bound.
// - Global counts (`listeners`, global `playcount`) use the
//   scrobbles_track_global and scrobbles_artist_global indexes.
//
// Synchronous over `Db`: every statement of one request reads one consistent
// state.

import type { Did } from '@atmusic/core/api-types';
import type { PeriodBounds } from '@atmusic/core/periods';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import type { ModuleDeps } from '../contracts';
import type { Db, SqlParam } from '../db';
import {
  checkRangeKey,
  type RangeCacheWrite,
  readRangeCache,
  type StorageRange,
  writeRangeCache,
} from './range-stats-cache';
import type { Statement } from './stats';
import { visibleStatsUser } from './stats';
import { visibleScrobblesFrom } from './visibility';

export const RANGE_ENTITIES = ['artists', 'tracks', 'albums'] as const;
export type RangeEntity = (typeof RANGE_ENTITIES)[number];

/** A range in epoch ms. `lower` is inclusive (null: unbounded); `upper` is exclusive unless `upperInclusive`. */
export interface RangeBounds {
  lower: number | null;
  upper: number;
  upperInclusive?: boolean;
}

export interface RangeStatsQuery extends RangeBounds {
  did: Did;
  entity: RangeEntity;
  /** Page size; null returns the whole ranking from `offset`. */
  limit: number | null;
  offset: number;
  /**
   * A stable name for the range (`lastfm:7day`, `lb:this_month`). Only named
   * ranges are cached; the bounds may slide between requests of one name.
   */
  rangeKey?: string;
}

export interface RangeTotals {
  listens: number;
  artists: number;
  tracks: number;
  albums: number;
}

interface ItemBase {
  /** 1-based position in the full ranking. */
  rank: number;
  count: number;
  /** Storage timestamp of the group's newest listen. */
  newestListenedAt: string;
  artistMbids: string[] | null;
}

export interface RangeArtistItem extends ItemBase {
  artistKey: string;
  artist: string;
}

export interface RangeTrackItem extends ItemBase {
  artistKey: string;
  trackKey: string;
  artist: string;
  track: string;
  album: string | null;
  recordingMbid: string | null;
  releaseMbid: string | null;
  /** From the newest listen of the track that has a duration. */
  durationSeconds: number | null;
}

export interface RangeAlbumItem extends ItemBase {
  /** `coalesce(album_artist_key, artist_key)`. */
  artistKey: string;
  albumKey: string;
  /** Display artist: the newest row's album artist, else its artist. */
  artist: string;
  album: string;
  releaseMbid: string | null;
  releaseGroupMbid: string | null;
}

export interface RangeItemOf {
  artists: RangeArtistItem;
  tracks: RangeTrackItem;
  albums: RangeAlbumItem;
}

export type RangeItem = RangeItemOf[RangeEntity];

export interface RangeStats<E extends RangeEntity = RangeEntity> {
  did: Did;
  entity: E;
  /** Storage-form bounds actually used: `lower` inclusive (or null), `upper` exclusive. */
  lower: string | null;
  upper: string;
  totals: RangeTotals;
  /** Number of groups of `entity` in the range (the ranking length). */
  total: number;
  offset: number;
  limit: number | null;
  items: RangeItemOf[E][];
}

// ---------------------------------------------------------------------------
// Bounds and validation

/** Converts epoch-ms bounds into the storage-form half-open range. */
export function storageRange(b: RangeBounds): StorageRange {
  const upperNs = fromMs(b.upper) + (b.upperInclusive === true ? 1n : 0n);
  return { lower: b.lower === null ? null : toStorage(fromMs(b.lower)), upper: toStorage(upperNs) };
}

/** packages/core/src/periods.ts bounds as a range query's bounds. */
export function fromPeriod(bounds: PeriodBounds): RangeBounds {
  return { lower: bounds.lowerMs, upper: bounds.upperMs, upperInclusive: bounds.upperInclusive };
}

function checkQuery(q: RangeStatsQuery): void {
  if (typeof q.did !== 'string' || q.did === '') throw new RangeError('range statistics need a DID');
  if (!(RANGE_ENTITIES as readonly string[]).includes(q.entity)) {
    throw new RangeError(`unknown range statistics entity ${String(q.entity)}`);
  }
  if (q.limit !== null && (!Number.isSafeInteger(q.limit) || q.limit < 1)) {
    throw new RangeError(`range statistics limit must be a positive integer or null, got ${q.limit}`);
  }
  if (!Number.isSafeInteger(q.offset) || q.offset < 0) {
    throw new RangeError(`range statistics offset must be a non-negative integer, got ${q.offset}`);
  }
  if (q.lower !== null && !Number.isSafeInteger(q.lower)) throw new RangeError('lower must be integer epoch ms');
  if (!Number.isSafeInteger(q.upper)) throw new RangeError('upper must be integer epoch ms');
  if (q.rangeKey !== undefined) checkRangeKey(q.rangeKey);
}

// ---------------------------------------------------------------------------
// SQL

/**
 * `w`: the visible rows of the DID inside `[lower, upper)`. Materialized for
 * the totals of a bounded range, as in ./stats.ts, so the window is read once
 * through scrobbles_owner_time's (did, listened_at) range.
 */
function windowCte(range: StorageRange, o: { materialized?: boolean } = {}): string {
  const lower = range.lower === null ? '' : ' AND s.listened_at >= ?';
  return `w AS ${o.materialized === true ? 'MATERIALIZED ' : ''}(SELECT s.uri, s.listened_at, s.artist_key, s.track_key,
      s.album_key, s.album_artist_key, s.duration_seconds FROM ${visibleScrobblesFrom('s', 'u')}
    WHERE s.did = ? AND s.listened_at < ?${lower})`;
}

function windowParams(did: string, range: StorageRange): SqlParam[] {
  return range.lower === null ? [did, range.upper] : [did, range.upper, range.lower];
}

/** Every statement the engine runs for one query (exported for query-plan pins). */
export function rangeStatsStatements(did: string, range: StorageRange, limit: number | null, offset: number) {
  const w = windowCte(range);
  const p = windowParams(did, range);
  const totalsW = range.lower === null ? w : windowCte(range, { materialized: true });
  // LIMIT -1 is SQLite's "no limit"; OFFSET still applies.
  const page: SqlParam[] = [limit ?? -1, offset];
  return {
    totals: {
      sql: `WITH ${totalsW}
        SELECT (SELECT count(*) FROM w) AS listens,
               (SELECT count(DISTINCT artist_key) FROM w) AS artists,
               (SELECT count(*) FROM (SELECT 1 FROM w GROUP BY artist_key, track_key)) AS tracks,
               (SELECT count(*) FROM (SELECT 1 FROM w WHERE album_key IS NOT NULL
                  GROUP BY coalesce(album_artist_key, artist_key), album_key)) AS albums`,
      params: p,
    },
    artists: {
      sql: `WITH ${w},
        g AS (SELECT artist_key, count(*) AS c, max(listened_at || ' ' || uri) AS newest FROM w GROUP BY artist_key)
        SELECT g.artist_key AS artist_key, g.c AS c, d.listened_at AS newest_at, d.artist AS artist,
               d.artist_mbids AS artist_mbids
        FROM g JOIN scrobbles d ON d.uri = substr(g.newest, 32)
        ORDER BY g.c DESC, g.artist_key ASC LIMIT ? OFFSET ?`,
      params: [...p, ...page],
    },
    tracks: {
      sql: `WITH ${w},
        g AS (SELECT artist_key, track_key, count(*) AS c, max(listened_at || ' ' || uri) AS newest,
                     max(CASE WHEN duration_seconds IS NOT NULL THEN listened_at || ' ' || uri END) AS newest_dur
              FROM w GROUP BY artist_key, track_key)
        SELECT g.artist_key AS artist_key, g.track_key AS track_key, g.c AS c, d.listened_at AS newest_at,
               d.artist AS artist, d.track AS track, d.album AS album, d.recording_mbid AS recording_mbid,
               d.release_mbid AS release_mbid, d.artist_mbids AS artist_mbids, dd.duration_seconds AS duration_seconds
        FROM g JOIN scrobbles d ON d.uri = substr(g.newest, 32)
        LEFT JOIN scrobbles dd ON dd.uri = substr(g.newest_dur, 32)
        ORDER BY g.c DESC, g.artist_key ASC, g.track_key ASC LIMIT ? OFFSET ?`,
      params: [...p, ...page],
    },
    albums: {
      sql: `WITH ${w},
        g AS (SELECT coalesce(album_artist_key, artist_key) AS group_artist_key, album_key, count(*) AS c,
                     max(listened_at || ' ' || uri) AS newest
              FROM w WHERE album_key IS NOT NULL GROUP BY coalesce(album_artist_key, artist_key), album_key)
        SELECT g.group_artist_key AS artist_key, g.album_key AS album_key, g.c AS c, d.listened_at AS newest_at,
               coalesce(d.album_artist, d.artist) AS artist, d.album AS album, d.release_mbid AS release_mbid,
               d.release_group_mbid AS release_group_mbid, d.artist_mbids AS artist_mbids
        FROM g JOIN scrobbles d ON d.uri = substr(g.newest, 32)
        ORDER BY g.c DESC, g.group_artist_key ASC, g.album_key ASC LIMIT ? OFFSET ?`,
      params: [...p, ...page],
    },
  } satisfies Record<string, Statement>;
}

/** The stored JSON array of artist MBIDs, or null when absent or malformed. */
function parseMbids(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) && parsed.every((v) => typeof v === 'string') ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

interface ArtistRow {
  artist_key: string;
  c: number;
  newest_at: string;
  artist: string;
  artist_mbids: string | null;
}
interface TrackRow extends ArtistRow {
  track_key: string;
  track: string;
  album: string | null;
  recording_mbid: string | null;
  release_mbid: string | null;
  duration_seconds: number | null;
}
interface AlbumRow extends ArtistRow {
  album_key: string;
  album: string | null;
  release_mbid: string | null;
  release_group_mbid: string | null;
}

function readTotals(db: Db, st: Statement): RangeTotals {
  const t = db.one<RangeTotals>(st.sql, ...st.params);
  if (t === null) throw new Error('range statistics totals query returned no row');
  return { listens: t.listens, artists: t.artists, tracks: t.tracks, albums: t.albums };
}

function readItems(db: Db, entity: RangeEntity, st: Statement, offset: number): RangeItem[] {
  const rank = (i: number) => offset + i + 1;
  switch (entity) {
    case 'artists':
      return db.all<ArtistRow>(st.sql, ...st.params).map(
        (r, i): RangeArtistItem => ({
          rank: rank(i),
          count: r.c,
          newestListenedAt: r.newest_at,
          artistKey: r.artist_key,
          artist: r.artist,
          artistMbids: parseMbids(r.artist_mbids),
        }),
      );
    case 'tracks':
      return db.all<TrackRow>(st.sql, ...st.params).map(
        (r, i): RangeTrackItem => ({
          rank: rank(i),
          count: r.c,
          newestListenedAt: r.newest_at,
          artistKey: r.artist_key,
          trackKey: r.track_key,
          artist: r.artist,
          track: r.track,
          album: r.album,
          recordingMbid: r.recording_mbid,
          releaseMbid: r.release_mbid,
          artistMbids: parseMbids(r.artist_mbids),
          durationSeconds: r.duration_seconds,
        }),
      );
    case 'albums':
      return db.all<AlbumRow>(st.sql, ...st.params).map((r, i): RangeAlbumItem => {
        if (r.album === null) throw new Error('album group display row has no album');
        return {
          rank: rank(i),
          count: r.c,
          newestListenedAt: r.newest_at,
          artistKey: r.artist_key,
          albumKey: r.album_key,
          artist: r.artist,
          album: r.album,
          releaseMbid: r.release_mbid,
          releaseGroupMbid: r.release_group_mbid,
          artistMbids: parseMbids(r.artist_mbids),
        };
      });
  }
}

/**
 * The statistics of `q.did` over the range, straight from SQL (no cache, no
 * visibility check of the users row: rows of an invisible owner simply do not
 * match). Synchronous, so it reads one consistent state.
 */
export function computeRangeStats<E extends RangeEntity>(db: Db, q: RangeStatsQuery & { entity: E }): RangeStats<E> {
  checkQuery(q);
  const range = storageRange(q);
  const st = rangeStatsStatements(q.did, range, q.limit, q.offset);
  const totals = readTotals(db, st.totals);
  const items = readItems(db, q.entity, st[q.entity], q.offset) as RangeItemOf[E][];
  return {
    did: q.did,
    entity: q.entity,
    lower: range.lower,
    upper: range.upper,
    totals,
    total: totals[q.entity],
    offset: q.offset,
    limit: q.limit,
    items,
  };
}

// ---------------------------------------------------------------------------
// Cached entry point

/** What a cache row holds: the totals and the full ranking (rank 1…n). */
interface CachedRanking {
  totals: RangeTotals;
  items: RangeItem[];
}

/** How a request was served: `bypass` for an unnamed range (never cached). */
export type RangeCacheOutcome = 'hit' | 'miss' | 'bypass';

export interface RangeStatsResult<E extends RangeEntity = RangeEntity> {
  /** Null for an unknown, inactive or suppressed user. */
  stats: RangeStats<E> | null;
  /** Null when there was nothing to compute. */
  cache: RangeCacheOutcome | null;
  /** The cache write of a miss. */
  write?: RangeCacheWrite;
}

function page<E extends RangeEntity>(
  q: RangeStatsQuery & { entity: E },
  range: StorageRange,
  ranking: CachedRanking,
): RangeStats<E> {
  const end = q.limit === null ? undefined : q.offset + q.limit;
  return {
    did: q.did,
    entity: q.entity,
    lower: range.lower,
    upper: range.upper,
    totals: { ...ranking.totals },
    total: ranking.totals[q.entity],
    offset: q.offset,
    limit: q.limit,
    items: ranking.items.slice(q.offset, end) as RangeItemOf[E][],
  };
}

/** `rangeStats` plus how it was served (tests and logs observe the cache through this). */
export function rangeStatsWithCache<E extends RangeEntity>(
  m: Pick<ModuleDeps, 'db' | 'clock'>,
  q: RangeStatsQuery & { entity: E },
): RangeStatsResult<E> {
  checkQuery(q);
  const db = m.db;
  const user = visibleStatsUser(db, q.did);
  if (user === null) return { stats: null, cache: null };
  if (q.rangeKey === undefined) return { stats: computeRangeStats(db, q), cache: 'bypass' };

  const range = storageRange(q);
  const key = { did: q.did, entity: q.entity, rangeKey: q.rangeKey };
  const cached = readRangeCache<CachedRanking>(db, key, range, user);
  if (cached !== null) return { stats: page(q, range, cached), cache: 'hit' };

  const full = computeRangeStats(db, { ...q, limit: null, offset: 0 });
  const ranking: CachedRanking = { totals: full.totals, items: full.items };
  const nowMs = m.clock.nowMs();
  const write = writeRangeCache(db, key, range, user, ranking, { asOf: toStorage(fromMs(nowMs)), nowMs });
  return { stats: page(q, range, ranking), cache: 'miss', write };
}

/** The range statistics of a visible user, or null for an unknown, inactive or suppressed one. */
export function rangeStats<E extends RangeEntity>(
  m: Pick<ModuleDeps, 'db' | 'clock'>,
  q: RangeStatsQuery & { entity: E },
): RangeStats<E> | null {
  return rangeStatsWithCache(m, q).stats;
}

// ---------------------------------------------------------------------------
// Global counts (track.getInfo, artist.getInfo: ADR §7.9, §10.2)

export interface GlobalCounts {
  /** Distinct visible DIDs with at least one listen. */
  listeners: number;
  /** Every visible indexed listen. */
  playcount: number;
}

/** Listeners and playcount of one track over every visible user (scrobbles_track_global). */
export function globalTrackCounts(db: Db, artistKey: string, trackKey: string): GlobalCounts {
  const row = db.one<GlobalCounts>(
    `SELECT count(DISTINCT s.did) AS listeners, count(*) AS playcount FROM ${visibleScrobblesFrom('s', 'u')}
     WHERE s.artist_key = ? AND s.track_key = ?`,
    artistKey,
    trackKey,
  );
  return { listeners: row?.listeners ?? 0, playcount: row?.playcount ?? 0 };
}

/** Listeners and playcount of one artist over every visible user (scrobbles_artist_global). */
export function globalArtistCounts(db: Db, artistKey: string): GlobalCounts {
  const row = db.one<GlobalCounts>(
    `SELECT count(DISTINCT s.did) AS listeners, count(*) AS playcount FROM ${visibleScrobblesFrom('s', 'u')}
     WHERE s.artist_key = ?`,
    artistKey,
  );
  return { listeners: row?.listeners ?? 0, playcount: row?.playcount ?? 0 };
}
