// Typed SafeFetch failures and bounded response bodies (ADR 0004 §8).
//
// Every outbound body is read through `readCapped` (or `cappedStream`), which
// counts bytes as they arrive and cancels the upstream stream the moment the
// cap is exceeded, so an oversized body is never buffered past the cap and no
// parser ever sees it. A declared Content-Length above the cap is refused
// before the first read.

export const SAFE_FETCH_ERROR_CODES = [
  'blocked_destination', // URL/host policy or DoH pre-check refused the destination
  'redirect_refused', // any 3xx (or an opaque redirect); Location is never followed
  'timeout', // the 10 s deadline fired before headers or the full body arrived
  'body_too_large', // declared or streamed body over the per-kind cap
  'http_status', // non-2xx, non-3xx status; Retry-After / RateLimit-Reset parsed
  'dns_failed', // the DoH lookup itself failed (status, malformed JSON, SERVFAIL)
  'network_error', // the transport rejected for a reason other than the deadline
] as const;

export type SafeFetchErrorCode = (typeof SAFE_FETCH_ERROR_CODES)[number];

export interface SafeFetchErrorDetails {
  /** Short machine-readable cause, e.g. `ip_literal`, `private_answer`, `content_length`. */
  reason?: string;
  /** HTTP status for `http_status` and `redirect_refused`. */
  status?: number;
  /** Delay in ms parsed from Retry-After (delta-seconds or HTTP-date), relative to the injected clock. */
  retryAfterMs?: number | null;
  /** Delay in ms until RateLimit-Reset, relative to the injected clock. */
  rateLimitResetMs?: number | null;
  /** XRPC `error` name from a JSON error body, when the body parsed. */
  xrpcError?: string | null;
  /** XRPC `message` from a JSON error body, when present. */
  xrpcMessage?: string | null;
  /** The cap that was exceeded, for `body_too_large`. */
  maxBytes?: number;
}

export class SafeFetchError extends Error {
  readonly reason: string | null;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly rateLimitResetMs: number | null;
  readonly xrpcError: string | null;
  readonly xrpcMessage: string | null;
  readonly maxBytes: number | null;

  constructor(
    readonly code: SafeFetchErrorCode,
    message?: string,
    details: SafeFetchErrorDetails = {},
  ) {
    super(message ?? (details.reason ? `${code}: ${details.reason}` : code));
    this.name = 'SafeFetchError';
    this.reason = details.reason ?? null;
    this.status = details.status ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.rateLimitResetMs = details.rateLimitResetMs ?? null;
    this.xrpcError = details.xrpcError ?? null;
    this.xrpcMessage = details.xrpcMessage ?? null;
    this.maxBytes = details.maxBytes ?? null;
  }
}

export function isSafeFetchError(value: unknown, code?: SafeFetchErrorCode): value is SafeFetchError {
  return value instanceof SafeFetchError && (code === undefined || value.code === code);
}

function assertCap(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative safe integer, got ${maxBytes}`);
  }
}

function tooLarge(maxBytes: number, reason: string): SafeFetchError {
  return new SafeFetchError('body_too_large', `response body exceeds ${maxBytes} bytes`, { reason, maxBytes });
}

function timedOut(): SafeFetchError {
  return new SafeFetchError('timeout', 'deadline exceeded', { reason: 'deadline' });
}

/** Fire-and-forget cancel: a hostile stream must not be able to hang us in cancel(). */
function cancelQuietly(target: { cancel(reason?: unknown): Promise<void> }, reason: unknown): void {
  try {
    target.cancel(reason).catch(() => {});
  } catch {
    // Already locked/errored: nothing left to release.
  }
}

/**
 * Settle with `promise`, or reject with `timeout` as soon as `signal` aborts.
 * The deadline is enforced here even when a transport ignores the signal.
 */
export function raceDeadline<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(timedOut());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timedOut());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted ? timedOut() : error);
      },
    );
  });
}

/** The declared Content-Length, or null when absent or not a plain decimal. */
export function declaredLength(headers: Headers): number | null {
  const raw = headers.get('content-length');
  if (raw === null || !/^\s*\d+\s*$/.test(raw)) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Read `response.body` fully, but never more than `maxBytes`. On overflow the
 * upstream stream is cancelled and `body_too_large` is thrown; nothing past
 * the chunk that crossed the cap is pulled. With `signal`, an abort while
 * reading cancels the stream and throws `timeout`.
 */
export async function readCapped(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  assertCap(maxBytes);
  const declared = declaredLength(response.headers);
  if (declared !== null && declared > maxBytes) {
    if (response.body) cancelQuietly(response.body, 'body_too_large');
    throw tooLarge(maxBytes, 'content_length');
  }
  const body = response.body;
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await raceDeadline(reader.read(), signal);
      } catch (error) {
        cancelQuietly(reader, 'aborted');
        throw error;
      }
      if (step.done) break;
      const chunk = step.value;
      if (!(chunk instanceof Uint8Array)) {
        cancelQuietly(reader, 'bad_chunk');
        throw new SafeFetchError('network_error', 'response stream yielded a non-byte chunk', { reason: 'bad_chunk' });
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        cancelQuietly(reader, 'body_too_large');
        throw tooLarge(maxBytes, 'streamed');
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read after cancel keeps the lock; the stream is already cancelled.
    }
  }

  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * A pull-through view of `source` that errors with `body_too_large` (and
 * cancels `source`) as soon as more than `maxBytes` have passed, and with
 * `timeout` when `signal` aborts. For incremental parsers (getRepo CAR stream).
 */
export function cappedStream(
  source: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  assertCap(maxBytes);
  if (source === null) {
    return new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  }
  const reader = source.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await raceDeadline(reader.read(), signal);
      } catch (error) {
        cancelQuietly(reader, 'aborted');
        controller.error(error);
        return;
      }
      if (step.done) {
        controller.close();
        return;
      }
      const chunk = step.value;
      if (!(chunk instanceof Uint8Array)) {
        cancelQuietly(reader, 'bad_chunk');
        controller.error(new SafeFetchError('network_error', 'response stream yielded a non-byte chunk'));
        return;
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        cancelQuietly(reader, 'body_too_large');
        controller.error(tooLarge(maxBytes, 'streamed'));
        return;
      }
      controller.enqueue(chunk);
    },
    cancel(reason) {
      cancelQuietly(reader, reason);
    },
  });
}
