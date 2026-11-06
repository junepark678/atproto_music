// GET /api/v1/users/{did}/profile (API.md `Profile`, ADR 0004 §5.8,
// docs/profiles.md; crates/server/src/http/profile.rs).
//
// - The path DID must be a syntactic DID: otherwise 422 `fields.did`, with no
//   IndexDO call.
// - One RPC, IndexRpc.profile. It returns null for an unknown, inactive or
//   suppressed user, which is 404 `not_found`; the DO decides that before any
//   identity request.
// - 200 is the eight-field Profile. `Cache-Control: no-store` is forced, so a
//   confirmed listen, deletion or deactivation shows on the next read.

import { isDid } from '@atmusic/core/syntax';
import { errorResponse, toErrorResponse } from './error';
import { noStoreJson } from './json';
import { invalidField } from './params';
import type { RequestCtx, RouteDef } from './types';

export const PROFILE_PATTERN = '/api/v1/users/{did}/profile';

/**
 * The `{did}` path segment as a DID, or 422 `fields.did`. A router that hands
 * over the raw segment may leave `:` percent-encoded; it is decoded once only
 * when the raw value is not already a DID (a DID may itself contain `%XX`).
 */
export function didParam(params: Record<string, string>): string {
  const raw = params.did;
  if (typeof raw === 'string' && isDid(raw)) return raw;
  if (typeof raw === 'string' && raw.includes('%')) {
    let decoded: string | null = null;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = null;
    }
    if (decoded !== null && isDid(decoded)) return decoded;
  }
  throw invalidField('did', 'Expected a DID.');
}

export async function getProfile(_req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  try {
    const did = didParam(params);
    const profile = await ctx.index.profile(did);
    if (profile === null) return errorResponse('not_found', undefined, ctx.requestId);
    return noStoreJson(profile, 200);
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
}

export const routes: RouteDef[] = [{ method: 'GET', pattern: PROFILE_PATTERN, handler: getProfile }];
