// Error codes carried in the API error envelope `{error:{code, ...}}`.
// The vocabulary follows api/examples/error-*.json (the frozen contract
// fixtures) plus the codes ADR 0004 §9.4 adds for notify. Frozen in Wave 0:
// add a code here (and to DEFAULT_STATUS) rather than inventing one inline.

export const ERROR_CODES = [
  'bad_request', // 400: malformed request that is not JSON- or cursor-specific
  'invalid_json', // 400: request body is not strict JSON
  'invalid_cursor', // 400: cursor failed HMAC, version, binding or base64 checks
  'unauthorized', // 401: admin bearer token missing or wrong
  'not_found', // 404: unknown, inactive, suppressed, excluded or absent resource; unknown route
  'method_not_allowed', // 405
  'payload_too_large', // 413: request body over its cap (notify: 2 KiB)
  'validation_failed', // 422: query or body field invalid; `fields` names it (no clamping)
  'identity_mismatch', // 422: resolve found a handle whose two directions disagree
  'rate_limited', // 429: per-IP or per-DID bucket exhausted; Retry-After is set
  'internal_error', // 500
  'upstream_error', // 502: an identity or PDS request failed for a read that needs it
  'not_ready', // 503: storage not migrated, or schema newer than code
  'queue_full', // 503: admission budget or the pending snapshot cap is exhausted
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The HTTP status each code is served with unless a route documents otherwise. */
export const DEFAULT_STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  invalid_json: 400,
  invalid_cursor: 400,
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  validation_failed: 422,
  identity_mismatch: 422,
  rate_limited: 429,
  internal_error: 500,
  upstream_error: 502,
  not_ready: 503,
  queue_full: 503,
};

const CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && CODE_SET.has(value);
}

/**
 * A typed failure that a route turns into the error envelope. `fields` maps a
 * request field name (for example `limit` or `viewer`) to a short reason.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Readonly<Record<string, string>>,
    status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? DEFAULT_STATUS[code];
  }
}
