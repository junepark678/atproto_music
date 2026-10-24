// Public follow edges: counts and the following/followers lists (ADR 0004
// §5.8 "Follow lists", docs/follows.md, API.md "duplicate external follow
// records"). Ports crates/storage/src/repositories/{follows,public}.rs
// `follow_page` / `public_counts` onto the Workers schema.
//
// - An edge `(actor, subject)` is visible when both its actor and its subject
//   are visible users (visibility.ts visibleFollowEdge: active and not
//   suppressed). Only verified present, valid follow records exist in
//   `follows` (absent and excluded ones live in record_state), so "active
//   record" is simply "a row of `follows`".
// - Duplicate records of one edge (an external writer may publish several
//   records with the same subject) collapse to one representative: the row
//   with the smallest URI of that `(actor, subject)` pair, as Rust's
//   `f.uri = (SELECT min(g.uri) …)`. SQLite BINARY collation is UTF-8 byte
//   order, which is code-point order, so this is Rust's `String` minimum. The
//   edge disappears only when no record of the pair remains.
// - Lists order by the representative's `(created_at, uri)` descending and
//   page with the keyset tuple from the cursor (`upper` is the traversal
//   anchor, `last` the last row returned), exactly like the scrobble reads.
// - Counts are distinct identities over visible edges (count(DISTINCT …)),
//   never a count of records, and have no cap.
//
// Every function here is a synchronous read: no write, no await.

import type { Follow } from '@atmusic/core/api-types';
import type { FollowListQuery, FollowRow, KeysetQuery, ModuleDeps, RowsResult } from '../contracts';
import type { Db, SqlParam } from '../db';
import { indexing } from '../status';
import { visibleFollowEdge } from './visibility';

/** Which side of the edge the list is keyed by. */
export type FollowDirection = 'following' | 'followers';

/** The largest page a module accepts (API.md list maximum). */
export const MAX_FOLLOW_PAGE = 100;

export interface FollowCounts {
  /** Distinct visible actors following `did`. */
  followerCount: number;
  /** Distinct visible subjects `did` follows. */
  followingCount: number;
}

const FOLLOW_COLUMNS = 'f.uri, f.cid, f.actor, f.subject, f.revision, f.created_at, f.indexed_at';

/** `f` is the representative of its `(actor, subject)` pair: the smallest URI. */
const REPRESENTATIVE = 'f.uri = (SELECT min(g.uri) FROM follows g WHERE g.actor = f.actor AND g.subject = f.subject)';

function keyColumn(direction: FollowDirection): string {
  return direction === 'following' ? 'f.actor' : 'f.subject';
}

/** Distinct visible edge counts for `did` (profile `followerCount` / `followingCount`). */
export function followCounts(db: Db, did: string): FollowCounts {
  const following =
    db.one<{ n: number }>(
      `SELECT count(DISTINCT f.subject) AS n FROM follows f WHERE f.actor = ? AND ${visibleFollowEdge('f')}`,
      did,
    )?.n ?? 0;
  const followers =
    db.one<{ n: number }>(
      `SELECT count(DISTINCT f.actor) AS n FROM follows f WHERE f.subject = ? AND ${visibleFollowEdge('f')}`,
      did,
    )?.n ?? 0;
  return { followerCount: followers, followingCount: following };
}

function checkLimit(limit: number, max: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new RangeError(`follow page limit must be an integer from 1 to ${max}, got ${limit}`);
  }
}

/**
 * One page of representative visible edges keyed by `did` on `direction`,
 * `(created_at, uri)` DESC, at or below `q.upper` and strictly below `q.last`.
 * Reads `limit + 1` rows to report `hasMore` without a second query.
 */
export function followPage(
  db: Db,
  did: string,
  direction: FollowDirection,
  q: KeysetQuery,
): { rows: FollowRow[]; hasMore: boolean } {
  checkLimit(q.limit, MAX_FOLLOW_PAGE);
  const where = [`${keyColumn(direction)} = ?`, visibleFollowEdge('f'), REPRESENTATIVE];
  const params: SqlParam[] = [did];
  if (q.upper !== undefined) {
    where.push('(f.created_at, f.uri) <= (?, ?)');
    params.push(q.upper.t, q.upper.uri);
  }
  if (q.last !== undefined) {
    where.push('(f.created_at, f.uri) < (?, ?)');
    params.push(q.last.t, q.last.uri);
  }
  params.push(q.limit + 1);
  const rows = db.all<FollowRow>(
    `SELECT ${FOLLOW_COLUMNS} FROM follows f WHERE ${where.join(' AND ')}
     ORDER BY f.created_at DESC, f.uri DESC LIMIT ?`,
    ...params,
  );
  const hasMore = rows.length > q.limit;
  if (hasMore) rows.length = q.limit;
  return { rows, hasMore };
}

/** Every representative visible edge `did` follows, newest first (the export's `follows`). */
export function allFollowing(db: Db, did: string): FollowRow[] {
  return db.all<FollowRow>(
    `SELECT ${FOLLOW_COLUMNS} FROM follows f WHERE f.actor = ? AND ${visibleFollowEdge('f')} AND ${REPRESENTATIVE}
     ORDER BY f.created_at DESC, f.uri DESC`,
    did,
  );
}

/** The public Follow DTO: stored columns verbatim, as the Rust `FollowRow` serialisation. */
export function followToDto(row: FollowRow): Follow {
  return { uri: row.uri, cid: row.cid, actor: row.actor, subject: row.subject, createdAt: row.created_at };
}

function list(m: ModuleDeps, q: FollowListQuery, direction: FollowDirection): RowsResult<FollowRow> {
  const { did, ...keyset } = q;
  const nowMs = m.clock.nowMs();
  const mode = m.config.ingestMode;
  // One synchronous transaction: the page and its indexing truth are one snapshot.
  return m.db.tx(() => {
    const page = followPage(m.db, did, direction, keyset);
    return { rows: page.rows, hasMore: page.hasMore, indexing: indexing(m.db, nowMs, { did, mode }) };
  });
}

/** IndexRpc.following: edges whose actor is `q.did`. An unknown or hidden DID gets an empty page. */
export function following(m: ModuleDeps, q: FollowListQuery): RowsResult<FollowRow> {
  return list(m, q, 'following');
}

/** IndexRpc.followers: edges whose subject is `q.did`. An unknown or hidden DID gets an empty page. */
export function followers(m: ModuleDeps, q: FollowListQuery): RowsResult<FollowRow> {
  return list(m, q, 'followers');
}
