// Retry policy for owner-authorised PDS writes (ADR 0004 §5.2 step 3, §9 A12).
//
// Ports crates/atproto/src/pds/write.rs `retry_delay` and the response routing of
// write.rs `send` (InvalidSwap, already-exists and reconcile.rs `missing`, then
// reconcile.rs `classify` for everything else):
// - transient failures (network, 5xx, 429) retry after
//   min(300 s, max(base + U[0, base/4], Retry-After)), base = 1000 * 2^(attempt-1) ms;
// - there are exactly MAX_ATTEMPTS sends, never an eleventh;
// - an "already exists" create is ambiguous: the caller must getRecord and compare
//   canonical digests (canonical.ts), and must never overwrite the remote record;
// - a 404 / 400 RecordNotFound is not a verdict either (`missing`): the caller must
//   look the record up; absence completes a delete (Rust Lookup::Absent).
//
// Pure: time and randomness are injected (deps.ts), nothing here sleeps or fetches.

import type { Clock, Random } from './deps';

/** Exactly ten sends per operation (ADR §5.2); the runner never sends an eleventh. */
export const MAX_ATTEMPTS = 10;

/** Every delay, including jitter and Retry-After, is capped at five minutes. */
export const MAX_DELAY_MS = 300_000;

const BASE_MS = 1_000;

/**
 * Delay before the next attempt, after `attempt` (1-based) failed transiently.
 *
 * `base = 1000 * 2^(attempt - 1)` ms (capped at 300 s), jitter is a uniform integer
 * in [0, floor(base / 4)] drawn from `random.float()` (inclusive, like the Rust
 * `gen_range(0..=base/4)`), and a server `Retry-After` (in ms) can only raise the
 * delay. The result never exceeds 300 s.
 */
export function nextDelayMs(attempt: number, random: Random, retryAfterMs?: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs < 0)) {
    throw new RangeError(`retryAfterMs must be a finite non-negative number, got ${retryAfterMs}`);
  }
  // 2^(attempt-1) overflows to Infinity for huge attempts; the cap keeps it exact.
  const base = Math.min(MAX_DELAY_MS, BASE_MS * 2 ** (attempt - 1));
  const jitterSpan = Math.floor(base / 4);
  const u = random.float();
  if (!(u >= 0 && u < 1)) throw new RangeError(`Random.float() must be in [0, 1), got ${u}`);
  const jitter = Math.min(jitterSpan, Math.floor(u * (jitterSpan + 1)));
  const raised = Math.max(base + jitter, Math.ceil(retryAfterMs ?? 0));
  return Math.min(MAX_DELAY_MS, raised);
}

export type WriteOperation = 'create' | 'put' | 'delete';

/**
 * - `transient`: retry with `nextDelayMs`, up to MAX_ATTEMPTS sends.
 * - `permanent`: fail the operation now.
 * - `ambiguous_create`: the create may have landed; getRecord and compare digests
 *   (equal: success; different: remote_record_conflict; never overwrite).
 * - `missing`: the PDS says the record is not there (404 / RecordNotFound). Like the
 *   Rust `missing()` route to `lookup()`, the caller looks the record up instead of
 *   failing: for a delete, absence is success; for a create/put, a present record
 *   whose digest matches is success and absence is transient remote_write_unconfirmed.
 */
export type FailureKind = 'transient' | 'permanent' | 'ambiguous_create' | 'missing';

export type FailureCode =
  // transient
  | 'upstream_transport_error' // fetch threw (offline, DNS, TLS, abort/timeout) or the body failed to read / was over 64 KiB
  | 'upstream_rate_limited' // 429
  | 'upstream_unavailable' // 5xx
  | 'repository_changed' // InvalidSwap: re-fetch, reconcile, retry
  // ambiguous
  | 'record_already_exists' // create hit an existing rkey: getRecord + digest compare
  // missing
  | 'record_not_found' // 404 / RecordNotFound: look up; absent completes a delete
  // permanent
  | 'invalid_record'
  | 'forbidden_scope'
  | 'sign_in_required'
  | 'upstream_rejected';

export interface Classification {
  kind: FailureKind;
  code: FailureCode;
  /** Server-requested wait in ms (Retry-After or RateLimit-Reset), uncapped; transient only. */
  retryAfterMs?: number;
  /** The XRPC error name from the body, when there was one. */
  error?: string;
}

/**
 * A completed non-2xx PDS response. `body` is the parsed JSON body, the JSON text,
 * or its bytes; a `Response` object's unread stream is not parsed (use
 * `classifyResponse` for that).
 */
export interface ResponseLike {
  status: number;
  headers?: Headers | Readonly<Record<string, string | undefined>>;
  body?: unknown;
}

export interface ClassifyOptions {
  /** The write that failed; only a create can be ambiguous. Default 'create'. */
  operation?: WriteOperation;
  /** Needed to turn an HTTP-date Retry-After or a RateLimit-Reset epoch into a delay. */
  clock?: Clock;
}

/** The PDS answer shapes that mean "a record already exists at this rkey". */
const ALREADY_EXISTS_ERRORS: ReadonlySet<string> = new Set(['RecordAlreadyExists', 'AlreadyExists']);
const ALREADY_EXISTS_MESSAGE = /already exists|already a value at key/i;

function headerValue(headers: ResponseLike['headers'], name: string): string | undefined {
  if (headers === undefined || headers === null) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | undefined>)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
}

const DELTA_SECONDS = /^\d{1,10}$/;

/**
 * Server-requested wait in ms: `Retry-After` as delta-seconds or an HTTP-date,
 * else `RateLimit-Reset` as epoch seconds (what atproto PDSs send on 429). Dates
 * need a clock; malformed or past values are ignored.
 */
export function retryAfterFromHeaders(headers: ResponseLike['headers'], clock?: Clock): number | undefined {
  const retryAfter = headerValue(headers, 'retry-after')?.trim();
  if (retryAfter !== undefined && retryAfter !== '') {
    if (DELTA_SECONDS.test(retryAfter)) return Number(retryAfter) * 1_000;
    if (clock !== undefined && /[a-z]/i.test(retryAfter)) {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) {
        const wait = at - clock.nowMs();
        return wait > 0 ? wait : undefined;
      }
    }
    return undefined;
  }
  const reset = headerValue(headers, 'ratelimit-reset')?.trim();
  if (reset !== undefined && clock !== undefined && DELTA_SECONDS.test(reset)) {
    const wait = Number(reset) * 1_000 - clock.nowMs();
    return wait > 0 ? wait : undefined;
  }
  return undefined;
}

interface XrpcBody {
  error?: string;
  message?: string;
}

function parseBody(body: unknown): XrpcBody {
  let value: unknown = body;
  try {
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      const bytes =
        body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } else if (typeof body === 'string') {
      value = JSON.parse(body);
    }
  } catch {
    return {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const out: XrpcBody = {};
  if (typeof record.error === 'string') out.error = record.error;
  if (typeof record.message === 'string') out.message = record.message;
  return out;
}

function classifyStatus(
  status: number,
  body: XrpcBody,
  headers: ResponseLike['headers'],
  options: ClassifyOptions,
): Classification {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RangeError(`not an HTTP status: ${status}`);
  }
  if (status >= 200 && status < 300) {
    throw new RangeError(`classify is for failed writes; got success status ${status}`);
  }
  const operation = options.operation ?? 'create';
  const named = body.error !== undefined ? { error: body.error } : {};

  // "Already exists" on a create is checked before the 5xx rule: some PDS
  // implementations surface a duplicate rkey as a 500 with that message, and
  // treating it as transient would resend into the same conflict ten times.
  const alreadyExists =
    (body.error !== undefined && ALREADY_EXISTS_ERRORS.has(body.error)) ||
    (body.message !== undefined && ALREADY_EXISTS_MESSAGE.test(body.message));
  if (operation === 'create' && alreadyExists && (status === 400 || status === 409 || status >= 500)) {
    return { kind: 'ambiguous_create', code: 'record_already_exists', ...named };
  }

  if (status === 429 || status >= 500) {
    const retryAfterMs = retryAfterFromHeaders(headers, options.clock);
    return {
      kind: 'transient',
      code: status === 429 ? 'upstream_rate_limited' : 'upstream_unavailable',
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...named,
    };
  }
  if (status === 400 && body.error === 'InvalidSwap') {
    return { kind: 'transient', code: 'repository_changed', ...named };
  }
  // Rust reconcile.rs `missing`: any 404, or a 400 RecordNotFound, for every
  // operation. write.rs routes these to lookup(), never to classify().
  if (status === 404 || (status === 400 && body.error === 'RecordNotFound')) {
    return { kind: 'missing', code: 'record_not_found', ...named };
  }
  switch (body.error) {
    case 'InvalidRecord':
      return { kind: 'permanent', code: 'invalid_record', ...named };
    case 'Forbidden':
    case 'InsufficientScope':
      return { kind: 'permanent', code: 'forbidden_scope', ...named };
    case 'InvalidToken':
    case 'ExpiredToken':
      return { kind: 'permanent', code: 'sign_in_required', ...named };
  }
  if (status === 401) return { kind: 'permanent', code: 'sign_in_required', ...named };
  if (status === 403) return { kind: 'permanent', code: 'forbidden_scope', ...named };
  return { kind: 'permanent', code: 'upstream_rejected', ...named };
}

/**
 * A fetch `Response` (or anything with the Body mixin) or a streamed/Blob body
 * cannot be read synchronously; classifying it by status alone would turn a 400
 * RecordAlreadyExists into a permanent rejection and skip the digest reconcile.
 */
function hasUnreadBody(value: object): boolean {
  if (typeof Response !== 'undefined' && value instanceof Response) return true;
  const v = value as { arrayBuffer?: unknown; bodyUsed?: unknown; body?: unknown };
  if (typeof v.arrayBuffer === 'function' || typeof v.bodyUsed === 'boolean') return true;
  const body = v.body;
  return (
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) ||
    (typeof Blob !== 'undefined' && body instanceof Blob)
  );
}

function isResponseLike(value: unknown): value is ResponseLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Error) &&
    typeof (value as { status?: unknown }).status === 'number'
  );
}

/**
 * Classifies a failed write: a non-2xx response, or whatever the send threw.
 *
 * - A thrown value carrying a numeric `status` (an XRPC client error such as
 *   `XRPCError`/`ClientResponseError`) is classified by status and its `error` name.
 * - Any other thrown value (fetch's TypeError, an AbortError/TimeoutError
 *   DOMException, a socket reset) is a transient network failure.
 * - 429 and 5xx are transient and carry the server's requested wait.
 * - A create answered with RecordAlreadyExists / "already exists" is ambiguous_create.
 * - 400 InvalidSwap is transient (repository_changed).
 * - 404 or 400 RecordNotFound is `missing` (look the record up; see FailureKind).
 * - Everything else is permanent.
 *
 * A fetch `Response`, or a response-like whose body is a stream or Blob, throws a
 * TypeError: its body must be read first, so use `classifyResponse`.
 */
export function classify(failure: unknown, options: ClassifyOptions = {}): Classification {
  if (isResponseLike(failure)) {
    if (hasUnreadBody(failure)) {
      throw new TypeError('classify() cannot read a Response or streamed body; use await classifyResponse(response)');
    }
    return classifyStatus(failure.status, parseBody(failure.body), failure.headers, options);
  }
  if (failure !== null && typeof failure === 'object') {
    const e = failure as { status?: unknown; error?: unknown; message?: unknown; headers?: unknown };
    if (typeof e.status === 'number' && e.status >= 100 && e.status <= 599 && Number.isInteger(e.status)) {
      const body: XrpcBody = {};
      if (typeof e.error === 'string') body.error = e.error;
      if (typeof e.message === 'string') body.message = e.message;
      const headers =
        e.headers !== null && typeof e.headers === 'object' ? (e.headers as ResponseLike['headers']) : undefined;
      return classifyStatus(e.status, body, headers, options);
    }
  }
  return { kind: 'transient', code: 'upstream_transport_error' };
}

/** XRPC error bodies are tiny; never buffer an unbounded body to classify it. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * The body could not be read in full (the stream errored, or it is over the
 * limit). Like Rust safe_client.rs (`transport_error` / `BodyTooLarge`, which
 * write.rs maps to transient `upstream_transport_error`), this is a transport
 * failure, never a status-only verdict: a truncated 400 RecordAlreadyExists or
 * InvalidSwap must be retried, not ended as a permanent rejection. A 429/5xx
 * still carries the server's requested wait.
 */
function unreadableBody(response: Response, options: ClassifyOptions): Classification {
  const status = response.status;
  const retryAfterMs =
    status === 429 || status >= 500 ? retryAfterFromHeaders(response.headers, options.clock) : undefined;
  return {
    kind: 'transient',
    code: 'upstream_transport_error',
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/**
 * Reads a fetch `Response` body (bounded) and classifies it. A body that fails
 * to read or exceeds 64 KiB is a transient `upstream_transport_error`.
 */
export async function classifyResponse(response: Response, options: ClassifyOptions = {}): Promise<Classification> {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new RangeError(`not an HTTP status: ${response.status}`);
  }
  if (response.status >= 200 && response.status < 300) {
    throw new RangeError(`classify is for failed writes; got success status ${response.status}`);
  }
  let body: Uint8Array | undefined;
  if (response.body !== null) {
    const declared = response.headers.get('content-length');
    if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > MAX_ERROR_BODY_BYTES) {
      await response.body.cancel().catch(() => undefined);
      return unreadableBody(response, options);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ERROR_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          return unreadableBody(response, options);
        }
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      return unreadableBody(response, options);
    }
    body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  return classify({ status: response.status, headers: response.headers, body }, options);
}
