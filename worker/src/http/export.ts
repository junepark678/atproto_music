// GET /api/v1/users/{did}/export (ADR 0004 §9.2 A9, §9.4 N3; API.md).
//
// - The path DID must be a syntactic DID: otherwise 422 `fields.did`.
// - One RPC, IndexRpc.exportUser, which reads the whole export in one
//   synchronous DO transaction; null (unknown, inactive or suppressed) is 404.
// - 200 is `{schemaVersion: 1, did, exportedAt, indexing, scrobbles, follows}`
//   as a JSON attachment `music-export.json`, `Cache-Control: no-store`.

import { errorResponse, toErrorResponse } from './error';
import { noStoreJson } from './json';
import { didParam } from './profile';
import type { RequestCtx, RouteDef } from './types';

export const EXPORT_PATTERN = '/api/v1/users/{did}/export';
export const EXPORT_DISPOSITION = 'attachment; filename="music-export.json"';

export async function getExport(_req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  try {
    const did = didParam(params);
    const body = await ctx.index.exportUser(did);
    if (body === null) return errorResponse('not_found', undefined, ctx.requestId);
    return noStoreJson(body, 200, { 'content-disposition': EXPORT_DISPOSITION });
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
}

export const routes: RouteDef[] = [{ method: 'GET', pattern: EXPORT_PATTERN, handler: getExport }];
