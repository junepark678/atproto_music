// GET /api/v1/users/{did}/following and /followers (API.md Page<Follow>,
// ADR 0004 §5.8 "Follow lists", docs/follows.md;
// crates/server/src/http/{follows/read,pagination}.rs).
//
// Admission, in the Rust order: the path DID (422 `fields.did`), then `limit`
// (default 20, 1..=100, no clamping, 422 `fields.limit`; a repeated
// parameter is 422 naming it), then `cursor` (400 `invalid_cursor` for any
// failure: HMAC, version, bad base64, or a binding for another list or DID).
// The cursor binds the list (`following` | `followers`) and the DID.
//
// Paging is the authenticated keyset traversal of docs/cursors.md, as
// pagination.rs:
// - the first page has no bounds; `asOf` is now (injected clock);
// - when more rows exist, `nextCursor` carries the traversal anchor
//   (`upper` = the first page's first row), the last row returned and the
//   frozen `asOf`; later pages return rows at or below the anchor and strictly
//   below the last row, so an edge added above the anchor never appears and
//   equal `createdAt` values are ordered by the full URI;
// - the last page has `nextCursor: null`.
// Items are the representative edges (smallest URI per actor/subject pair),
// and `indexing` is the DID's truth from the same DO transaction.

import type { Follow, Page } from '@atmusic/core/api-types';
import {
  advanceCursor,
  type CursorBinding,
  type CursorPosition,
  cursorBindings,
  cursorPosition,
  decodeCursor,
  encodeCursor,
  type PageCursor,
  pageCursor,
} from '@atmusic/core/cursor';
import { nowNs, toDto } from '@atmusic/core/timestamp';
import type { FollowRow, KeysetQuery } from '../do/contracts';
import { followToDto } from '../do/read/follows';
import { toErrorResponse } from './error';
import { json } from './json';
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, parseLimit, singleParam } from './params';
import { didParam } from './profile';
import type { RequestCtx, RouteDef } from './types';

export const FOLLOWING_PATTERN = '/api/v1/users/{did}/following';
export const FOLLOWERS_PATTERN = '/api/v1/users/{did}/followers';

type Direction = 'following' | 'followers';

function position(row: FollowRow): CursorPosition {
  return cursorPosition(row.created_at, row.uri);
}

function keyset(cursor: PageCursor | null, limit: number): KeysetQuery {
  if (cursor === null) return { limit };
  return {
    upper: { t: cursor.upper.timestamp, uri: cursor.upper.uri },
    last: { t: cursor.last.timestamp, uri: cursor.last.uri },
    limit,
  };
}

async function nextCursor(
  ctx: RequestCtx,
  binding: CursorBinding,
  cursor: PageCursor | null,
  rows: FollowRow[],
  asOf: string,
): Promise<string> {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === undefined || last === undefined) throw new Error('a page with more rows has at least one row');
  const next =
    cursor === null
      ? pageCursor(binding, position(first), position(last), asOf)
      : advanceCursor(cursor, position(last));
  return encodeCursor(ctx.cursorKey, next);
}

async function followList(req: Request, ctx: RequestCtx, params: Record<string, string>, direction: Direction) {
  try {
    const did = didParam(params);
    const q = new URL(req.url).searchParams;
    const limit = parseLimit(q, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
    const token = singleParam(q, 'cursor');
    const binding = direction === 'following' ? cursorBindings.following(did) : cursorBindings.followers(did);
    const cursor = token === undefined ? null : await decodeCursor(ctx.cursorKey, token, binding);
    const asOf = cursor?.asOf ?? toDto(nowNs(ctx.clock));

    const query = { did, ...keyset(cursor, limit) };
    const result = direction === 'following' ? await ctx.index.following(query) : await ctx.index.followers(query);
    const rows = result.rows.slice(0, limit);
    const page: Page<Follow> = {
      items: rows.map(followToDto),
      nextCursor: result.hasMore ? await nextCursor(ctx, binding, cursor, rows, asOf) : null,
      asOf,
      indexing: result.indexing,
    };
    return json(page, 200);
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
}

export function getFollowing(req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  return followList(req, ctx, params, 'following');
}

export function getFollowers(req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  return followList(req, ctx, params, 'followers');
}

export const routes: RouteDef[] = [
  { method: 'GET', pattern: FOLLOWING_PATTERN, handler: getFollowing },
  { method: 'GET', pattern: FOLLOWERS_PATTERN, handler: getFollowers },
];
