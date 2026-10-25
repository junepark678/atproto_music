// Last.fm 2.0 error codes, messages and HTTP statuses (ADR 0005 §7.6; N2-07).
//
// Clients must read `lfm/@status` or the JSON `error` member; the HTTP status
// is a convenience (Last.fm's own pairing is UNVERIFIED, ADR §7.6). The table
// below is the ADR's, verbatim. encode.ts renders a LastfmError as
//   JSON  {"error": <code>, "message": "<text>"}
//   XML   <lfm status="failed"><error code="N">text</error></lfm>
// with the table's status and, for 29, a Retry-After header.
//
// A message is shown to the client as is: callers must never put a credential
// (sk, token, password, api_sig) into one (ADR §13 "Error envelopes never echo
// credentials").

export interface LastfmErrorSpec {
  readonly message: string;
  readonly status: number;
}

/** ADR 0005 §7.6, code → default message and HTTP status. */
export const LASTFM_ERRORS = {
  2: { message: 'Invalid service', status: 400 },
  3: { message: 'Invalid Method', status: 400 },
  4: { message: 'Authentication Failed', status: 403 },
  5: { message: 'Invalid format', status: 400 },
  6: { message: 'Invalid parameters', status: 400 },
  7: { message: 'Invalid resource specified', status: 400 },
  8: { message: 'Operation failed', status: 500 },
  9: { message: 'Invalid session key - Please re-authenticate', status: 403 },
  10: { message: 'Invalid API key', status: 403 },
  11: { message: 'Service Offline', status: 503 },
  13: { message: 'Invalid method signature supplied', status: 403 },
  14: { message: 'This token has not been authorized', status: 403 },
  15: { message: 'This token has expired', status: 403 },
  16: { message: 'There was a temporary error processing your request', status: 503 },
  26: { message: 'Suspended API key', status: 403 },
  29: { message: 'Rate Limit Exceeded', status: 429 },
} as const satisfies Record<number, LastfmErrorSpec>;

export type LastfmErrorCode = keyof typeof LASTFM_ERRORS;

/** Every code of the table, ascending. */
export const LASTFM_ERROR_CODES: readonly LastfmErrorCode[] = Object.keys(LASTFM_ERRORS)
  .map(Number)
  .sort((a, b) => a - b) as LastfmErrorCode[];

/** ADR §7.1: a write or auth method called with GET. */
export const POST_REQUIRED_MESSAGE = 'Invalid Method - this method must be called with POST';

/** Retry-After (seconds) for a 29 that does not name its own. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

export interface LastfmErrorOptions {
  /** Seconds for the Retry-After header; used only with code 29. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

/** A protocol-level Last.fm failure, rendered by encode.ts. */
export class LastfmError extends Error {
  override readonly name = 'LastfmError';
  readonly code: LastfmErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: LastfmErrorCode, message?: string, options: LastfmErrorOptions = {}) {
    const spec = LASTFM_ERRORS[code];
    if (spec === undefined) throw new TypeError(`unknown Last.fm error code ${String(code)}`);
    super(message ?? spec.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = spec.status;
    if (code === 29) {
      const seconds = options.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
      this.retryAfterSeconds = Math.max(1, Math.ceil(seconds));
    } else {
      this.retryAfterSeconds = undefined;
    }
  }
}

export function isLastfmError(value: unknown): value is LastfmError {
  return value instanceof LastfmError;
}

/** The HTTP status of `code` (ADR §7.6). */
export function lastfmHttpStatus(code: LastfmErrorCode): number {
  return LASTFM_ERRORS[code].status;
}
