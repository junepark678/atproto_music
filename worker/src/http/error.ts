// The API error envelope (docs/planning/API.md "Shared shapes", ADR 0004 §9.1).
//
// Every failure a route serves is `{error:{code, message, requestId, fields?}}`
// with the status from @atmusic/core/errors DEFAULT_STATUS unless the route
// documents otherwise. Messages are fixed per code: a response never echoes an
// exception message, stack trace, file path or request input (M1.4.2
// safe_errors). Like crates/server/src/http/error.rs, every error response is
// `Cache-Control: no-store`, and `fields` is serialised with sorted keys
// (Rust BTreeMap order).

import type { ErrorEnvelope } from '@atmusic/core/api-types';
import { ApiError, DEFAULT_STATUS, type ErrorCode } from '@atmusic/core/errors';

/** The fixed, client-safe message for each code (api/examples/error-*.json where one exists). */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  bad_request: 'Malformed JSON, cursor, or request header.',
  invalid_json: 'The request body is not valid JSON.',
  invalid_cursor: 'The pagination cursor is invalid for this request.',
  unauthorized: 'A valid bearer token is required.',
  not_found: 'The resource is absent or inactive.',
  method_not_allowed: 'The method is not allowed for this resource.',
  payload_too_large: 'The request body exceeds the configured size limit.',
  validation_failed: 'A request field is invalid.',
  identity_mismatch: 'The handle and DID do not verify in both directions.',
  rate_limited: 'The request rate limit was exceeded.',
  internal_error: 'An internal error occurred.',
  upstream_error: 'The upstream request permanently failed.',
  not_ready: 'Index storage is not initialized.',
  queue_full: 'New-DID admission is exhausted; retry later.',
};

export interface ErrorOptions {
  /** Extra response headers, e.g. `Retry-After` on 429. `Cache-Control` is always `no-store`. */
  headers?: HeadersInit;
}

function assertErrorStatus(status: number): void {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new RangeError(`error responses need a 4xx or 5xx status, got ${status}`);
  }
}

/** Builds the envelope object (used by routes that need the body without a Response). */
export function errorBody(
  code: ErrorCode,
  requestId: string,
  fields?: Readonly<Record<string, string>>,
): ErrorEnvelope {
  const error: ErrorEnvelope['error'] = { code, message: ERROR_MESSAGES[code], requestId };
  if (fields !== undefined && Object.keys(fields).length > 0) {
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(fields).sort()) sorted[key] = fields[key] as string;
    error.fields = sorted;
  }
  return { error };
}

/**
 * `errorResponse(code, status, requestId, fields?)`: the JSON error envelope.
 * Pass `DEFAULT_STATUS[code]` (or `undefined`) for the API.md status.
 */
export function errorResponse(
  code: ErrorCode,
  status: number | undefined,
  requestId: string,
  fields?: Readonly<Record<string, string>>,
  options: ErrorOptions = {},
): Response {
  const resolved = status ?? DEFAULT_STATUS[code];
  assertErrorStatus(resolved);
  const headers = new Headers(options.headers);
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(errorBody(code, requestId, fields)), { status: resolved, headers });
}

/** 429 with `Retry-After` in whole seconds (at least 1). */
export function rateLimitedResponse(requestId: string, retryAfterSeconds: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return errorResponse('rate_limited', DEFAULT_STATUS.rate_limited, requestId, undefined, {
    headers: { 'retry-after': String(seconds) },
  });
}

/**
 * Maps anything a handler threw to an envelope. An ApiError keeps its code,
 * status and fields; everything else is a generic 500 that reveals nothing
 * about the failure (the caller logs the cause, never the client).
 */
export function toErrorResponse(err: unknown, requestId: string): Response {
  if (err instanceof ApiError) return errorResponse(err.code, err.status, requestId, err.fields);
  return errorResponse('internal_error', DEFAULT_STATUS.internal_error, requestId);
}
