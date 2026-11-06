// POST /api/v1/notify (ADR 0004 §5.4, §8 "Notify abuse", §9.4 N1; API.md).
//
// Admission, all before the IndexDO is called:
// - the body is read with a 2,048-byte cap (params.ts readJsonBody): over it
//   (declared Content-Length or streamed bytes) 413 `payload_too_large`, the
//   stream cancelled at the first byte over; an empty body, invalid UTF-8, a
//   BOM or anything JSON.parse refuses is 400 `invalid_json`;
// - strict shape: a JSON object with exactly one member, `uri` or `did`.
//   An unknown member, both or neither, a member given twice
//   (`{"uri":…,"uri":…}`, which JSON.parse silently collapses to the last
//   value), or a non-object (array, string, null…) is 422 `fields.body` (the
//   Rust oracle's strict-body rule: its serde `deny_unknown_fields` structs
//   also reject a duplicate field, crates/server/src/http/auth_start.rs; a
//   key is never echoed back);
// - `uri`: a record AT URI (`at://<did>/<nsid>/<rkey>`) whose DID is did:plc
//   or did:web and whose collection is one of the configured `<p>.scrobble`,
//   `<p>.follow`, `<p>.settings`, `<p>.love` (ADR 0005 §6.3; the same set
//   admits GET /api/v1/records/status); anything else (including every URI
//   while the namespace gate is closed) is 422 `fields.uri`;
// - `did`: a did:plc or did:web DID, else 422 `fields.did`.
// Then one RPC, `IndexRpc.notify(input, clientIp)`, with the client IP the
// Worker took from CF-Connecting-IP after stripping inbound x-atmusic-*
// headers (RequestCtx.clientIp). The DO applies the per-IP and per-DID buckets
// and does the work (worker/src/do/ingest/notify.ts):
// - `queued` → 202 `{state: "queued"}`;
// - `rate_limited` → 429 `rate_limited` with `Retry-After` (whole seconds);
// - `queue_full` → 503 `queue_full`.
// When the IndexDO cannot answer (the RPC rejects: not ready, misconfigured,
// overloaded or reset), the request is 503 `not_ready`, the only 5xx the
// OpenAPI contract declares for notify; a hint is safe to resend later.
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

const isJsonSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/**
 * The decoded member names of the top-level object in `text`, in order, or
 * null when `text` is not an object. `text` must already be valid JSON
 * (JSON.parse accepted it), so the scan only tracks strings and nesting.
 */
export function topLevelKeys(text: string): string[] | null {
  let i = 0;
  const skipSpace = () => {
    while (isJsonSpace(text[i])) i++;
  };
  /** The end (exclusive) of the string token that starts at `start` (a `"`). */
  const stringEnd = (start: number) => {
    let j = start + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    return j + 1;
  };
  skipSpace();
  if (text[i] !== '{') return null;
  i++;
  const keys: string[] = [];
  for (;;) {
    skipSpace();
    if (text[i] === ',') {
      i++;
      skipSpace();
    }
    if (text[i] === '}' || i >= text.length) return keys;
    const end = stringEnd(i);
    keys.push(JSON.parse(text.slice(i, end)) as string);
    i = end;
    skipSpace();
    i++; // the ':'
    // Skip the value: whole strings, and the nesting depth of objects and arrays.
    for (let depth = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') i = stringEnd(i) - 1;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
    }
  }
}

function invalid(fields: Record<string, string>): ApiError {
  return new ApiError('validation_failed', 'notify body is invalid', fields);
}

/** The configured collections for `prefix` (null: the namespace gate is closed). */
export function configuredCollections(prefix: string | null): ReadonlySet<string> {
  if (prefix === null) return new Set();
  return new Set([`${prefix}.scrobble`, `${prefix}.follow`, `${prefix}.settings`, `${prefix}.love`]);
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

/**
 * The strict NotifyInput of a parsed body; throws a 422 ApiError otherwise.
 * `text` is the body's JSON text when known: a member it names more than
 * once is a 422 `fields.body` before any field is validated, as serde
 * rejects a duplicate field in the Rust oracle.
 */
export function parseNotifyInput(body: unknown, prefix: string | null, text?: string): NotifyInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid({ body: EXPECTED_BODY });
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || (keys[0] !== 'uri' && keys[0] !== 'did')) throw invalid({ body: EXPECTED_BODY });
  if (text !== undefined && topLevelKeys(text)?.length !== 1) throw invalid({ body: EXPECTED_BODY });

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

/**
 * The capped, parsed body and its text. The text comes from a clone that is
 * read only after readJsonBody accepted the original (so it is at most
 * 2 KiB); on a refusal the clone is cancelled together with the original.
 */
async function readNotifyBody(req: Request): Promise<{ body: unknown; text: string }> {
  const copy = req.clone();
  let body: unknown;
  try {
    body = await readJsonBody(req, NOTIFY_MAX_BODY_BYTES);
  } catch (error) {
    if (copy.body !== null) await copy.body.cancel().catch(() => undefined);
    throw error;
  }
  return { body, text: await copy.text() };
}

export async function postNotify(req: Request, ctx: RequestCtx): Promise<Response> {
  try {
    const { body, text } = await readNotifyBody(req);
    const input = parseNotifyInput(body, namespaceView(ctx.env).prefix, text);
    let outcome: Awaited<ReturnType<RequestCtx['index']['notify']>>;
    try {
      outcome = await ctx.index.notify(input, ctx.clientIp);
    } catch (error) {
      // An ApiError the index chose keeps its status; an index that cannot answer is a 503.
      if (error instanceof ApiError) throw error;
      return errorResponse('not_ready', undefined, ctx.requestId);
    }
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
