// Error codes carried in the API error envelope `{error:{code, ...}}`.
// OpenAPI types `code` as a plain string; this union is the vocabulary.
// Frozen in Wave 0: add a code here (and to DEFAULT_STATUS) rather than
// inventing one inline.
//
// - The eight codes of api/examples/error-*.json are a subset: bad_request,
//   not_found, payload_too_large, validation_failed, rate_limited,
//   upstream_error, not_ready and queue_full (N1 notify admission).
//   scripts/validate_contracts.py (error_codes) checks that every example code
//   is defined here and served with its DEFAULT_STATUS.
// - invalid_cursor, invalid_json, identity_mismatch, method_not_allowed,
//   rate_limited and not_found keep the Rust oracle's names.
// - The other Rust oracle codes are renamed (recorded in
//   docs/planning/AMENDMENTS-workers.md, "Error code vocabulary"):
//   invalid_query and invalid_path → validation_failed, body_too_large →
//   payload_too_large, invalid_body → bad_request, upstream_unavailable →
//   upstream_error, storage_not_ready and storage_unavailable → not_ready.
// - unauthorized (admin bearer token) and internal_error have no example.

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
