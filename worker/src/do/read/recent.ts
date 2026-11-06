// Recent listens for the protocol APIs (ADR 0005 §7.9 user.getRecentTracks and
// user.getTrackScrobbles, §8.4 GET /1/user/{user}/listens; N2-06).
//
// Two query shapes over the owner's visible scrobbles (./visibility.ts; only
// proof-verified rows exist in `scrobbles`, so pending operations and staged
// imports never appear):
//
// - Paged (Last.fm): `{did, after?, before?, limit, page | offset, artist?, track?}`.
//   `after`/`before` are UNIX seconds and exclusive at second precision, as a
//   client sees `date.uts = floor(t)`: `after < floor(t) < before`, that is
//   `t >= (after + 1) s` and `t < before s`. Newest first by
//   `(listened_at DESC, uri DESC)`; offset paging over the bounded set with
//   `total` and `totalPages = ceil(total / limit)`. An `artist` + `track`
//   filter (user.getTrackScrobbles) matches by music key (write/keys.ts), so
//   every spelling variant of the track counts; a name that has no key
//   matches nothing.
// - Timestamp (ListenBrainz): `{did, minTs?, maxTs?, count}`. `min_ts`/`max_ts`
//   are exclusive in the same way; `maxTs <= minTs` is a ListensQueryError
//   ("max_ts should be greater than min_ts"). `count` is capped at 1,000. With
//   `minTs`, the oldest `count` listens after it are taken and reversed, so the
//   output is always newest first. `latestListenTs`/`oldestListenTs` describe
//   the user's whole visible history (UNIX s, floor).
//
// An unknown, inactive or suppressed user yields null (Last.fm error 6,
// ListenBrainz 404); the protocol layers resolve names first (./user-lookup.ts).

import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import { NS_PER_SECOND, toStorage } from '@atmusic/core/timestamp';
import type { ScrobbleRowV2 } from '../../app/rows';
import type { ModuleDeps } from '../contracts';
import type { Db, SqlParam } from '../db';
import { activeUser, visibleScrobblesFrom } from './visibility';

/** 9999-12-31T23:59:59Z, the last second the storage form can hold. */
export const MAX_UNIX_SECONDS = 253_402_300_799;
/** ListenBrainz MAX_ITEMS_PER_GET: larger counts are silently capped. */
export const LISTENS_MAX_COUNT = 1000;

export interface RecentPageQuery {
  did: string;
  /** Exclusive lower bound, UNIX seconds. */
  after?: number | null;
  /** Exclusive upper bound, UNIX seconds. */
  before?: number | null;
  limit: number;
  /** 1-based page; exclusive with `offset` (default page 1). */
  page?: number;
  offset?: number;
  /** user.getTrackScrobbles: both or neither. */
  artist?: string;
  track?: string;
}

export interface ListensQuery {
  did: string;
  /** Exclusive lower bound, UNIX seconds. */
  minTs?: number | null;
  /** Exclusive upper bound, UNIX seconds. */
  maxTs?: number | null;
  count: number;
}

export interface OffsetPage<T> {
  rows: T[];
  total: number;
  totalPages: number;
  page: number;
  perPage: number;
  offset: number;
}

export type RecentPage = OffsetPage<ScrobbleRowV2>;

export interface ListensPage {
  /** Newest first. */
  rows: ScrobbleRowV2[];
  latestListenTs: number | null;
  oldestListenTs: number | null;
}

export type ListensQueryErrorCode = 'max_ts_not_greater';

/** A ListenBrainz query the API answers with 400 and `message`. */
export class ListensQueryError extends Error {
  constructor(
    readonly code: ListensQueryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ListensQueryError';
  }
}

// ---------------------------------------------------------------------------
// Shared helpers

function checkDid(did: string): void {
  if (typeof did !== 'string' || did === '') throw new RangeError('recent listens need a DID');
}

function checkSeconds(name: string, s: number | null | undefined): void {
  if (s === null || s === undefined) return;
  if (!Number.isSafeInteger(s) || s < 0 || s > MAX_UNIX_SECONDS) {
    throw new RangeError(`${name} must be UNIX seconds in 0..${MAX_UNIX_SECONDS}, got ${s}`);
  }
}

/** The storage timestamp of a whole UNIX second. */
export function secondsToStorage(s: number): string {
  return toStorage(BigInt(s) * NS_PER_SECOND);
}

/** floor(t) in UNIX seconds of a 30-character storage timestamp. */
export function storageToUnixSeconds(ts: string): number {
  const ms = Date.parse(`${ts.slice(0, 19)}Z`);
  if (!Number.isSafeInteger(ms)) throw new RangeError(`not a storage timestamp: ${ts}`);
  return Math.floor(ms / 1000);
}

/**
 * The exclusive-in-seconds bounds as SQL over `s.listened_at`:
 * `t >= (after + 1) s` and `t < before s`.
 */
function secondsWhere(after: number | null | undefined, before: number | null | undefined) {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (after !== null && after !== undefined && after < MAX_UNIX_SECONDS) {
    clauses.push('s.listened_at >= ?');
    params.push(secondsToStorage(after + 1));
  } else if (after === MAX_UNIX_SECONDS) {
    clauses.push('0');
  }
  if (before !== null && before !== undefined) {
    clauses.push('s.listened_at < ?');
    params.push(secondsToStorage(before));
  }
  return { sql: clauses.map((c) => ` AND ${c}`).join(''), params };
}

/** `{limit, offset}` of a 1-based page or a raw offset (exactly one of them, page 1 by default). */
export function offsetOf(
  limit: number,
  page: number | undefined,
  offset: number | undefined,
): { offset: number; page: number } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
  if (page !== undefined && offset !== undefined) throw new RangeError('give a page or an offset, not both');
  if (offset !== undefined) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError(`offset must be non-negative, got ${offset}`);
    return { offset, page: Math.floor(offset / limit) + 1 };
  }
  const p = page ?? 1;
  if (!Number.isSafeInteger(p) || p < 1) throw new RangeError(`page must be a positive integer, got ${p}`);
  const o = (p - 1) * limit;
  if (!Number.isSafeInteger(o)) throw new RangeError('page offset is out of range');
  return { offset: o, page: p };
}

/** Whether `did` is a visible user. */
export function isVisibleUser(db: Db, did: string): boolean {
  return db.one<{ ok: number }>(`SELECT 1 AS ok FROM users u WHERE u.did = ? AND ${activeUser('u')}`, did) !== null;
}

// ---------------------------------------------------------------------------
// Paged (Last.fm)

export function recentPage(m: Pick<ModuleDeps, 'db'>, q: RecentPageQuery): RecentPage | null {
  checkDid(q.did);
  checkSeconds('after', q.after);
  checkSeconds('before', q.before);
  const { offset, page } = offsetOf(q.limit, q.page, q.offset);
  if ((q.artist === undefined) !== (q.track === undefined)) {
    throw new RangeError('a track filter needs both artist and track');
  }
  const db = m.db;
  if (!isVisibleUser(db, q.did)) return null;
  const empty: RecentPage = { rows: [], total: 0, totalPages: 0, page, perPage: q.limit, offset };

  let filter = '';
  const filterParams: SqlParam[] = [];
  if (q.artist !== undefined && q.track !== undefined) {
    let key: readonly [string, string];
    try {
      key = trackKey(q.artist, q.track);
    } catch (err) {
      if (err instanceof MusicKeyError) return empty;
      throw err;
    }
    filter = ' AND s.artist_key = ? AND s.track_key = ?';
    filterParams.push(key[0], key[1]);
  }
  const bounds = secondsWhere(q.after, q.before);
  const where = `s.did = ?${filter}${bounds.sql}`;
  const params: SqlParam[] = [q.did, ...filterParams, ...bounds.params];

  const total =
    db.one<{ n: number }>(`SELECT count(*) AS n FROM ${visibleScrobblesFrom('s', 'u')} WHERE ${where}`, ...params)?.n ??
    0;
  if (total === 0) return empty;
  const rows = db.all<ScrobbleRowV2>(
    `SELECT s.* FROM ${visibleScrobblesFrom('s', 'u')} WHERE ${where}
     ORDER BY s.listened_at DESC, s.uri DESC LIMIT ? OFFSET ?`,
    ...params,
    q.limit,
    offset,
  );
  return { rows, total, totalPages: Math.ceil(total / q.limit), page, perPage: q.limit, offset };
}

// ---------------------------------------------------------------------------
// Timestamp (ListenBrainz)

export function listensByTimestamp(m: Pick<ModuleDeps, 'db'>, q: ListensQuery): ListensPage | null {
  checkDid(q.did);
  checkSeconds('min_ts', q.minTs);
  checkSeconds('max_ts', q.maxTs);
  if (!Number.isSafeInteger(q.count) || q.count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${q.count}`);
  }
  const minTs = q.minTs ?? null;
  const maxTs = q.maxTs ?? null;
  if (minTs !== null && maxTs !== null && maxTs <= minTs) {
    throw new ListensQueryError('max_ts_not_greater', 'max_ts should be greater than min_ts');
  }
  const db = m.db;
  if (!isVisibleUser(db, q.did)) return null;

  const span = db.one<{ latest: string | null; oldest: string | null }>(
    `SELECT max(s.listened_at) AS latest, min(s.listened_at) AS oldest FROM ${visibleScrobblesFrom('s', 'u')}
     WHERE s.did = ?`,
    q.did,
  );
  const latestListenTs = span?.latest == null ? null : storageToUnixSeconds(span.latest);
  const oldestListenTs = span?.oldest == null ? null : storageToUnixSeconds(span.oldest);

  const count = Math.min(q.count, LISTENS_MAX_COUNT);
  let rows: ScrobbleRowV2[] = [];
  if (count > 0) {
    const bounds = secondsWhere(minTs, maxTs);
    const ascending = minTs !== null;
    rows = db.all<ScrobbleRowV2>(
      `SELECT s.* FROM ${visibleScrobblesFrom('s', 'u')} WHERE s.did = ?${bounds.sql}
       ORDER BY s.listened_at ${ascending ? 'ASC' : 'DESC'}, s.uri ${ascending ? 'ASC' : 'DESC'} LIMIT ?`,
      q.did,
      ...bounds.params,
      count,
    );
    if (ascending) rows.reverse();
  }
  return { rows, latestListenTs, oldestListenTs };
}

// ---------------------------------------------------------------------------
// Entry point

export type RecentQuery = RecentPageQuery | ListensQuery;

function isListensQuery(q: RecentQuery): q is ListensQuery {
  return 'count' in q;
}

/** Either query shape; see the module comment. */
export function recentListens(m: Pick<ModuleDeps, 'db'>, q: RecentPageQuery): RecentPage | null;
export function recentListens(m: Pick<ModuleDeps, 'db'>, q: ListensQuery): ListensPage | null;
export function recentListens(m: Pick<ModuleDeps, 'db'>, q: RecentQuery): RecentPage | ListensPage | null {
  if (isListensQuery(q)) {
    if ('limit' in q) throw new RangeError('give count (ListenBrainz) or limit (Last.fm), not both');
    return listensByTimestamp(m, q);
  }
  return recentPage(m, q);
}
