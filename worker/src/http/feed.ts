// GET /api/v1/feed?scope&viewer&limit&cursor (API.md, ADR 0004 §5.8, §9.2 A8).
// A port of crates/server/src/http/feed.rs with the session replaced by the
// public `viewer` parameter.
//
// Admission order (no RPC is made for a rejected request):
// 1. `scope` is global|following, default global; anything else (or a repeat)
//    is 422 `fields.scope` (params.ts).
// 2. `viewer`: a repeat, or a supplied value that is not a DID, is 422
//    `fields.viewer` for either scope (the parameter schema is Did). For
//    `following` a missing viewer is 422 `fields.viewer`.
// 3. `limit` and `cursor` as in ./scrobbles-read.ts. The cursor binding is
//    `globalFeed()` (viewer null: a global cursor never carries a viewer, and
//    the viewer neither filters nor binds the global feed) or
//    `followingFeed(viewer)`. A cursor issued for another query, scope or
//    viewer is 400 `invalid_cursor`.
// An unknown viewer gets 200 with an empty page; the viewer is public input,
// not authentication.

import { cursorBindings } from '@atmusic/core/cursor';
import { isDid } from '@atmusic/core/syntax';
import { toErrorResponse } from './error';
import { json } from './json';
import { invalidField, parseScope, singleParam } from './params';
import { admitList, EXPECTED_DID, keysetOf, scrobblePage } from './scrobbles-read';
import type { RequestCtx, RouteDef } from './types';

export const FEED_PATTERN = '/api/v1/feed';
export const VIEWER_REQUIRED = 'Required for scope=following.';

export async function feed(req: Request, ctx: RequestCtx): Promise<Response> {
  try {
    const q = new URL(req.url).searchParams;
    const scope = parseScope(q);
    const viewer = singleParam(q, 'viewer');
    if (viewer !== undefined && !isDid(viewer)) throw invalidField('viewer', EXPECTED_DID);
    if (scope === 'following' && viewer === undefined) throw invalidField('viewer', VIEWER_REQUIRED);
    const following = scope === 'following' ? (viewer as string) : null;
    const binding = following === null ? cursorBindings.globalFeed() : cursorBindings.followingFeed(following);
    const list = await admitList(q, ctx, binding);
    const result = await ctx.index.feed(
      following === null ? { scope, ...keysetOf(list) } : { scope, viewer: following, ...keysetOf(list) },
    );
    return json(await scrobblePage(list, result, ctx), 200);
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
}

export const routes: RouteDef[] = [{ method: 'GET', pattern: FEED_PATTERN, handler: feed }];
