// POST /api/v1/notify (ADR 0004 §5.4, §8 "Notify abuse", §9.4 N1; API.md).
//
// Admission, all before the IndexDO is called:
// - the body is read with a 2,048-byte cap (params.ts readJsonBody): over it
//   (declared Content-Length or streamed bytes) 413 `payload_too_large`, the
//   stream cancelled at the first byte over; an empty body, invalid UTF-8, a
//   BOM or anything JSON.parse refuses is 400 `invalid_json`;
// - strict shape: a JSON object with exactly one member, `uri` or `did`.
//   An unknown member, both or neither, or a non-object (array, string,
//   null…) is 422 `fields.body` (the Rust oracle's strict-body rule,
//   crates/server/src/http/auth_start.rs; a key is never echoed back);
// - `uri`: a record AT URI (`at://<did>/<nsid>/<rkey>`) whose DID is did:plc
//   or did:web and whose collection is one of the configured `<p>.scrobble`,
//   `<p>.follow`, `<p>.settings`; anything else (including every URI while the
//   namespace gate is closed) is 422 `fields.uri`;
// - `did`: a did:plc or did:web DID, else 422 `fields.did`.
// Then one RPC, `IndexRpc.notify(input, clientIp)`, with the client IP the
// Worker took from CF-Connecting-IP after stripping inbound x-atmusic-*
// headers (RequestCtx.clientIp). The DO applies the per-IP and per-DID buckets
// and does the work (worker/src/do/ingest/notify.ts):
// - `queued` → 202 `{state: "queued"}`;
// - `rate_limited` → 429 `rate_limited` with `Retry-After` (whole seconds);
// - `queue_full` → 503 `queue_full`.
// Every response is `Cache-Control: no-store`.

import type { NotifyAccepted, NotifyInput } from '@atmusic/core/api-types';
import { ApiError } from '@atmusic/core/errors';
import { isSupportedDid, parseRecordUri } from '@atmusic/core/syntax';
import { errorResponse, rateLimitedResponse, toErrorResponse } from './error';
import { json } from './json';
import { namespaceView } from './meta';
import { invalidField, readJsonBody } from './params';
import type { RequestCtx, RouteDef } from './types';

export const NOTIFY_PATTERN = '/api/v1/notify';
/** N1: the only JSON request body, capped at 2 KiB (OpenAPI `x-maxBodyBytes`). */
export const NOTIFY_MAX_BODY_BYTES = 2048;

/** As the Rust oracle's strict JSON bodies (auth_start.rs): `fields.body`, never an echoed key. */
const EXPECTED_BODY = 'Expected one string uri or did field and no unknown fields.';
const EXPECTED_URI = 'Expected a record AT URI in a configured collection.';
const EXPECTED_DID = 'Expected a did:plc or did:web DID.';

function invalid(fields: Record<string, string>): ApiError {
  return new ApiError('validation_failed', 'notify body is invalid', fields);
}

/** The configured collections for `prefix` (null: the namespace gate is closed). */
export function configuredCollections(prefix: string | null): ReadonlySet<string> {
  if (prefix === null) return new Set();
  return new Set([`${prefix}.scrobble`, `${prefix}.follow`, `${prefix}.settings`]);
}

/** A record URI in one of `collections`, or null. */
export function configuredRecordUri(
  value: unknown,
  collections: ReadonlySet<string>,
): { did: string; collection: string } | null {
  if (typeof value !== 'string') return null;
  const uri = parseRecordUri(value);
  if (uri === null || !collections.has(uri.collection)) return null;
  return { did: uri.did, collection: uri.collection };
}

/** The strict NotifyInput of a parsed body; throws a 422 ApiError otherwise. */
export function parseNotifyInput(body: unknown, prefix: string | null): NotifyInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid({ body: EXPECTED_BODY });
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || (keys[0] !== 'uri' && keys[0] !== 'did')) throw invalid({ body: EXPECTED_BODY });

  const record = body as Record<string, unknown>;
  if (keys[0] === 'uri') {
    const uri = configuredRecordUri(record.uri, configuredCollections(prefix));
    if (uri === null || !isSupportedDid(uri.did)) throw invalidField('uri', EXPECTED_URI);
    return { uri: record.uri as string };
  }
  const did = record.did;
  if (typeof did !== 'string' || !isSupportedDid(did)) throw invalidField('did', EXPECTED_DID);
  return { did };
}

export async function postNotify(req: Request, ctx: RequestCtx): Promise<Response> {
  try {
    const body = await readJsonBody(req, NOTIFY_MAX_BODY_BYTES);
    const input = parseNotifyInput(body, namespaceView(ctx.env).prefix);
    const outcome = await ctx.index.notify(input, ctx.clientIp);
    switch (outcome.status) {
      case 'queued': {
        const accepted: NotifyAccepted = { state: 'queued' };
        return json(accepted, 202);
      }
      case 'rate_limited':
        return rateLimitedResponse(ctx.requestId, outcome.retryAfterSeconds);
      case 'queue_full':
        return errorResponse('queue_full', undefined, ctx.requestId);
      default:
        return errorResponse('internal_error', undefined, ctx.requestId);
    }
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
}

export const routes: RouteDef[] = [{ method: 'POST', pattern: NOTIFY_PATTERN, handler: postNotify }];
