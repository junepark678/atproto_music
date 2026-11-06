// GET /api/v1/records/status?uri= (ADR 0004 §9.4 N2; API.md `RecordStatus`).
//
// - Query admission as the strict Rust query structs (deny_unknown_fields):
//   exactly one `uri` and nothing else; it must be a record AT URI
//   (`at://<did>/<nsid>/<rkey>`) in a configured collection (OpenAPI
//   `RecordUriQuery`). Anything else is 422 `validation_failed` with
//   `fields.uri`, before the IndexDO is called.
// - One RPC, IndexRpc.recordStatus (worker/src/do/ingest/notify.ts), a single
//   synchronous DO read: `indexed` (a visible row, with its cid and revision),
//   `pending` (a hint or open snapshot job), `absent` or `excluded` (from
//   record_state; `reason` only for excluded), else `unknown`; plus the per-DID
//   `indexing`. The read creates no user, hint or job.
// - 200 `{uri, state, cid?, revision?, reason?, indexing}`, always
//   `Cache-Control: no-store` (it changes as proofs apply).

import type { RecordStatus } from '@atmusic/core/api-types';
import { toErrorResponse } from './error';
import { noStoreJson } from './json';
import { namespaceView } from './meta';
import { configuredCollections, configuredRecordUri } from './notify';
import { invalidField } from './params';
import type { RequestCtx, RouteDef } from './types';

export const RECORD_STATUS_PATTERN = '/api/v1/records/status';

const EXPECTED_URI = 'Expected a record AT URI in a configured collection.';

/** The single valid `uri` query parameter; 422 `fields.uri` otherwise. */
export function recordUriQuery(q: URLSearchParams, prefix: string | null): string {
  for (const name of q.keys()) {
    if (name !== 'uri') throw invalidField('uri', EXPECTED_URI);
  }
  const values = q.getAll('uri');
  const raw = values[0];
  if (values.length !== 1 || raw === undefined || configuredRecordUri(raw, configuredCollections(prefix)) === null) {
    throw invalidField('uri', EXPECTED_URI);
  }
  return raw;
}

/** The response body with only the members its state allows (OpenAPI `RecordStatus` if/then rules). */
function body(s: RecordStatus): RecordStatus {
  const out: RecordStatus = { uri: s.uri, state: s.state, indexing: s.indexing };
  if (s.state !== 'unknown') {
    if (s.cid !== undefined) out.cid = s.cid;
    if (s.revision !== undefined) out.revision = s.revision;
  }
  if (s.state === 'excluded' && s.reason !== undefined) out.reason = s.reason;
  return out;
}

export async function getRecordStatus(req: Request, ctx: RequestCtx): Promise<Response> {
  try {
    const uri = recordUriQuery(new URL(req.url).searchParams, namespaceView(ctx.env).prefix);
    const status = await ctx.index.recordStatus(uri);
    return noStoreJson(body(status), 200);
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
}

export const routes: RouteDef[] = [{ method: 'GET', pattern: RECORD_STATUS_PATTERN, handler: getRecordStatus }];
