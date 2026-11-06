// GET /api/v1/users/{did}/stats (API.md, ADR 0004 §5.8; the Rust oracle is
// crates/server/src/http/stats.rs).
//
// - `{did}` must be a syntactic DID (422 `fields.did`), checked before any
//   query parameter. The router hands the path segment over already
//   percent-decoded, as axum's `Path` does.
// - `window` is all|7d|30d|365d (default all), `limit` 1..=100 (default 10),
//   both 422 naming the field with no clamping; a repeated parameter is 422
//   too. Statistics have no cursor: `cursor` is 422 `fields.cursor`, as in
//   Rust. Other parameters are ignored.
// - asOf is the injected clock's now; the DO computes the exact statistics
//   (or serves the provably identical cached body) in one RPC.
// - Unknown or inactive users are 404 `not_found`.
// - 200 is the Statistics payload, `Cache-Control: no-store` (json()).

import { DEFAULT_STATUS } from '@atmusic/core/errors';
import { isDid } from '@atmusic/core/syntax';
import { fromMs } from '@atmusic/core/timestamp';
import { errorResponse, toErrorResponse } from './error';
import { json } from './json';
import { invalidField, parseLimit, parseWindow, STATS_LIMIT_DEFAULT, STATS_LIMIT_MAX } from './params';
import type { RequestCtx, RouteDef } from './types';

export const STATS_PATTERN = '/api/v1/users/{did}/stats';

export async function userStats(req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  try {
    const did = params.did;
    if (did === undefined || !isDid(did)) throw invalidField('did', 'Expected a DID.');
    const q = new URL(req.url).searchParams;
    if (q.has('cursor')) throw invalidField('cursor', 'Statistics do not use cursors.');
    const window = parseWindow(q);
    const limit = parseLimit(q, STATS_LIMIT_DEFAULT, STATS_LIMIT_MAX);
    const asOfNs = fromMs(ctx.clock.nowMs());
    const statistics = await ctx.index.stats({ did, window, limit, asOfNs });
    if (statistics === null) return errorResponse('not_found', DEFAULT_STATUS.not_found, ctx.requestId);
    return json(statistics, 200);
  } catch (err) {
    return toErrorResponse(err, ctx.requestId);
  }
}

export const routes: RouteDef[] = [{ method: 'GET', pattern: STATS_PATTERN, handler: userStats }];
