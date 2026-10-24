// Retry policy for owner-authorised PDS writes (ADR 0004 §5.2 step 3, §9 A12).
//
// Ports crates/atproto/src/pds/write.rs `retry_delay` and
// crates/atproto/src/pds/reconcile.rs `classify`:
// - transient failures (network, 5xx, 429) retry after
//   min(300 s, max(base + U[0, base/4], Retry-After)), base = 1000 * 2^(attempt-1) ms;
// - there are exactly MAX_ATTEMPTS sends, never an eleventh;
// - an "already exists" create is ambiguous: the caller must getRecord and compare
//   canonical digests (canonical.ts), and must never overwrite the remote record.
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

export type FailureKind = 'transient' | 'permanent' | 'ambiguous_create';

export type FailureCode =
  // transient
  | 'upstream_transport_error' // fetch threw: offline, DNS, TLS, abort/timeout
  | 'upstream_rate_limited' // 429
  | 'upstream_unavailable' // 5xx
  | 'repository_changed' // InvalidSwap: re-fetch, reconcile, retry
  // ambiguous
  | 'record_already_exists' // create hit an existing rkey: getRecord + digest compare
  // permanent
  | 'invalid_record'
  | 'forbidden_scope'
  | 'sign_in_required'
  | 'record_not_found'
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
  switch (body.error) {
    case 'InvalidRecord':
      return { kind: 'permanent', code: 'invalid_record', ...named };
    case 'Forbidden':
    case 'InsufficientScope':
      return { kind: 'permanent', code: 'forbidden_scope', ...named };
    case 'InvalidToken':
    case 'ExpiredToken':
      return { kind: 'permanent', code: 'sign_in_required', ...named };
    case 'RecordNotFound':
      return { kind: 'permanent', code: 'record_not_found', ...named };
  }
  if (status === 401) return { kind: 'permanent', code: 'sign_in_required', ...named };
  if (status === 403) return { kind: 'permanent', code: 'forbidden_scope', ...named };
  if (status === 404) return { kind: 'permanent', code: 'record_not_found', ...named };
  return { kind: 'permanent', code: 'upstream_rejected', ...named };
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
 * - Everything else is permanent.
 */
export function classify(failure: unknown, options: ClassifyOptions = {}): Classification {
  if (isResponseLike(failure)) {
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

/** Reads a fetch `Response` body (bounded) and classifies it. */
export async function classifyResponse(response: Response, options: ClassifyOptions = {}): Promise<Classification> {
  let body: Uint8Array | undefined;
  if (response.body !== null) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ERROR_BODY_BYTES) {
          chunks.length = 0;
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    } catch {
      chunks.length = 0;
    }
    if (chunks.length > 0) {
      body = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
  }
  return classify({ status: response.status, headers: response.headers, body }, options);
}
