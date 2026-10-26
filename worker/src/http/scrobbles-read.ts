// Public scrobble reads (API.md, ADR 0004 §5.8): owner history and record
// lookup, plus the keyset pagination both scrobble lists share (the feed
// route in ./feed.ts uses it too). A port of crates/server/src/http/
// pagination.rs and scrobbles/read.rs.
//
// - GET /api/v1/users/{did}/scrobbles?limit&cursor: 200 Page<Scrobble>. A
//   path value that is not a DID is 422 `fields.did`; `limit` follows
//   params.ts (default 20, 1..=100, 422 `fields.limit`, never clamped); a
//   repeated `cursor` is 422 `fields.cursor`; a cursor that fails the HMAC,
//   version, base64 or binding checks is 400 `invalid_cursor` and never
//   restarts the traversal. Unknown query parameters are ignored, as in Rust.
// - GET /api/v1/scrobbles/{id}: `id` is the URL-encoded full AT URI. 200
//   `{scrobble}`; 404 `not_found` for unknown, absent (deleted), excluded and
//   inactive-owner records. A value that does not percent-decode, or does not
//   decode to a record AT URI, is 422 `fields.id` (the route's documented
//   422; Rust answered such paths 400 `invalid_path` or 404).
//
// Cursor semantics (docs/cursors.md, Rust Pagination::response_with):
// - asOf is the injected clock's now on a first page and the cursor's frozen
//   asOf afterwards, in the 30-character storage form.
// - A first page queries without an upper bound; when it has more rows its
//   `nextCursor` binds the route, takes the first row's `(listenedAt, uri)` as
//   the traversal anchor `upper` and the last row as `last`. Later pages keep
//   the anchor and asOf and advance `last`. An empty page has no next page
//   (nextCursor null), so it never needs an anchor.
// - `nextCursor` is null exactly when the DO reports no further row.
//
// Path values are read from the request URL's raw path (one percent-decode),
// so the result does not depend on whether the router decodes `{name}`
// segments; `params` is used only when the URL does not have the route's shape.

import type { Scrobble, ScrobblePage } from '@atmusic/core/api-types';
import {
  advanceCursor,
  type CursorBindingInput,
  type CursorPosition,
  cursorBindings,
  cursorPosition,
  decodeCursor,
  encodeCursor,
  type PageCursor,
  pageCursor,
} from '@atmusic/core/cursor';
import { ApiError } from '@atmusic/core/errors';
import { isDid, parseRecordUri } from '@atmusic/core/syntax';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import type { KeysetQuery, RowsResult, ScrobbleRow } from '../do/contracts';
import { toErrorResponse } from './error';
import { json } from './json';
import { invalidField, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, parseLimit, singleParam } from './params';
import type { RequestCtx, RouteDef } from './types';

export const HISTORY_PATTERN = '/api/v1/users/{did}/scrobbles';
export const LOOKUP_PATTERN = '/api/v1/scrobbles/{id}';

export const EXPECTED_DID = 'Expected a DID.';
export const EXPECTED_RECORD_URI = 'Expected a URL-encoded AT URI.';

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * The public Scrobble DTO of a stored row: the Rust ScrobbleRow serialisation
 * (field order kept, absent optionals omitted, private key columns dropped,
 * stored timestamps rendered verbatim, tests/goldens/timestamps.json).
 */
export function scrobbleDto(row: ScrobbleRow): Scrobble {
  return {
    uri: row.uri,
    cid: row.cid,
    did: row.did,
    revision: row.revision,
    artist: row.artist,
    track: row.track,
    ...(row.album === null ? {} : { album: row.album }),
    listenedAt: row.listened_at,
    createdAt: row.created_at,
    ...(row.duration_seconds === null ? {} : { durationSeconds: row.duration_seconds }),
    ...(row.recording_mbid === null ? {} : { recordingMbid: row.recording_mbid }),
    indexedAt: row.indexed_at,
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** An admitted list request: validated limit, decoded cursor, frozen asOf. */
export interface ListRequest {
  binding: CursorBindingInput;
  limit: number;
  cursor: PageCursor | null;
  /** 30-character storage form. */
  asOf: string;
}

/**
 * Admits `limit` and `cursor` (Rust `Pagination::from_query`): 422 before the
 * cursor is looked at, then 400 `invalid_cursor` unless the token verifies
 * for exactly `binding`. No RPC is made for a rejected request.
 */
export async function admitList(
  q: URLSearchParams,
  ctx: RequestCtx,
  binding: CursorBindingInput,
): Promise<ListRequest> {
  const limit = parseLimit(q, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
  const token = singleParam(q, 'cursor');
  const cursor = token === undefined ? null : await decodeCursor(ctx.cursorKey, token, binding);
  const asOf = cursor?.asOf ?? toStorage(fromMs(ctx.clock.nowMs()));
  return { binding, limit, cursor, asOf };
}

/** The DO keyset query for an admitted request. */
export function keysetOf(req: ListRequest): KeysetQuery {
  if (req.cursor === null) return { limit: req.limit };
  return {
    upper: { t: req.cursor.upper.timestamp, uri: req.cursor.upper.uri },
    last: { t: req.cursor.last.timestamp, uri: req.cursor.last.uri },
    limit: req.limit,
  };
}

/** A failure building the next cursor from stored rows is a server fault (500), never a client 400. */
function internal(cause: unknown): Error {
  return new Error('could not build the next cursor from stored rows', { cause });
}

function rowPosition(row: ScrobbleRow): CursorPosition {
  try {
    return cursorPosition(row.listened_at, row.uri);
  } catch (error) {
    throw internal(error);
  }
}

/** Rust `Pagination::response_with`: the next cursor when the DO reported more rows. */
export async function nextCursorFor(
  req: ListRequest,
  rows: readonly ScrobbleRow[],
  hasMore: boolean,
  ctx: RequestCtx,
): Promise<string | null> {
  if (!hasMore) return null;
  const first = rows[0];
  const lastRow = rows[rows.length - 1];
  if (first === undefined || lastRow === undefined) throw internal(new Error('hasMore with an empty page'));
  const last = rowPosition(lastRow);
  let next: PageCursor;
  try {
    next =
      req.cursor === null
        ? pageCursor(req.binding, rowPosition(first), last, req.asOf)
        : advanceCursor(req.cursor, last);
  } catch (error) {
    throw internal(error);
  }
  return encodeCursor(ctx.cursorKey, next);
}

/** The Page<Scrobble> body for a DO result. */
export async function scrobblePage(
  req: ListRequest,
  result: RowsResult<ScrobbleRow>,
  ctx: RequestCtx,
): Promise<ScrobblePage> {
  return {
    items: result.rows.map(scrobbleDto),
    nextCursor: await nextCursorFor(req, result.rows, result.hasMore, ctx),
    asOf: req.asOf,
    indexing: result.indexing,
  };
}

// ---------------------------------------------------------------------------
// Path values
// ---------------------------------------------------------------------------

/**
 * The single `{name}` segment of `pattern` in the request's raw path, percent-
 * decoded once; null when it does not decode. Falls back to `params[name]`
 * (taken as already decoded) when the URL does not have the pattern's shape.
 */
export function pathValue(req: Request, pattern: string, name: string, params: Record<string, string>): string | null {
  const patternParts = pattern.split('/');
  const pathParts = new URL(req.url).pathname.split('/');
  if (patternParts.length === pathParts.length) {
    let raw: string | undefined;
    let shaped = true;
    patternParts.forEach((part, k) => {
      const actual = pathParts[k] as string;
      if (part === `{${name}}`) raw = actual;
      else if (!(part.startsWith('{') && part.endsWith('}')) && part !== actual) shaped = false;
    });
    if (shaped && raw !== undefined) {
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    }
  }
  return params[name] ?? null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function history(req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  try {
    const did = pathValue(req, HISTORY_PATTERN, 'did', params);
    if (did === null || !isDid(did)) throw invalidField('did', EXPECTED_DID);
    const list = await admitList(new URL(req.url).searchParams, ctx, cursorBindings.history(did));
    const result = await ctx.index.history({ did, ...keysetOf(list) });
    return json(await scrobblePage(list, result, ctx), 200);
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
}

export async function lookup(req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  try {
    const uri = pathValue(req, LOOKUP_PATTERN, 'id', params);
    if (uri === null || parseRecordUri(uri) === null) throw invalidField('id', EXPECTED_RECORD_URI);
    const row = await ctx.index.lookup(uri);
    if (row === null) throw new ApiError('not_found', 'scrobble not found');
    return json({ scrobble: scrobbleDto(row) }, 200);
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
}

export const routes: RouteDef[] = [
  { method: 'GET', pattern: HISTORY_PATTERN, handler: history },
  { method: 'GET', pattern: LOOKUP_PATTERN, handler: lookup },
];
