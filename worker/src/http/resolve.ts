// GET /api/v1/resolve?handle= (API.md, docs/profiles.md;
// crates/server/src/http/resolve.rs).
//
// - Query admission as the Rust `ResolveQuery` (deny_unknown_fields): exactly
//   one `handle`, nothing else; it must be a syntactic handle outside the
//   spec-reserved TLDs. Any failure is 422 `validation_failed` with
//   `fields.handle`, before the IndexDO is called.
// - The handle is normalised (lowercase) and resolved through the IndexDO
//   (IndexRpc.resolveHandle), which uses the DO's cached identity resolver and
//   verifies both directions. The read creates no user, job or hint.
// - 200 `{did, handle, verified: true}`; unresolved 404 `not_found`; the two
//   directions disagree 422 `identity_mismatch` with `fields.handle`; an
//   unavailable or unsafe upstream 502 `upstream_error`.
// - Every response is `Cache-Control: no-store`.

import type { Resolve } from '@atmusic/core/api-types';
import { isDisallowedHandleTld, isHandle, normalizeHandle } from '@atmusic/core/syntax';
import { errorResponse, toErrorResponse } from './error';
import { noStoreJson } from './json';
import { invalidField } from './params';
import type { RequestCtx, RouteDef } from './types';

export const RESOLVE_PATTERN = '/api/v1/resolve';

const EXPECTED_HANDLE = 'Expected a handle.';
const VERIFICATION_FAILED = 'Handle verification failed.';

/** The single valid `handle` query parameter, normalised; 422 `fields.handle` otherwise. */
export function handleQuery(q: URLSearchParams): string {
  for (const name of q.keys()) {
    if (name !== 'handle') throw invalidField('handle', EXPECTED_HANDLE);
  }
  const values = q.getAll('handle');
  const raw = values[0];
  if (values.length !== 1 || raw === undefined || !isHandle(raw) || isDisallowedHandleTld(raw)) {
    throw invalidField('handle', EXPECTED_HANDLE);
  }
  return normalizeHandle(raw);
}

export async function getResolve(req: Request, ctx: RequestCtx): Promise<Response> {
  try {
    const handle = handleQuery(new URL(req.url).searchParams);
    const outcome = await ctx.index.resolveHandle(handle);
    switch (outcome.status) {
      case 'ok': {
        const body: Resolve = { did: outcome.did, handle: outcome.handle, verified: true };
        return noStoreJson(body, 200);
      }
      case 'not_found':
        return errorResponse('not_found', undefined, ctx.requestId);
      case 'mismatch':
        return errorResponse('identity_mismatch', undefined, ctx.requestId, { handle: VERIFICATION_FAILED });
      default:
        return errorResponse('upstream_error', undefined, ctx.requestId);
    }
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
}

export const routes: RouteDef[] = [{ method: 'GET', pattern: RESOLVE_PATTERN, handler: getResolve }];
