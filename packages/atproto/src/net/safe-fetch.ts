// SafeFetch: the only way server code reaches an attacker-chosen URL
// (ADR 0004 §8, amendment A5). Policy, in order:
//
//   1. checkUrl: https, default port, no credentials/fragment, public hostname;
//   2. DoH A/AAAA pre-check (doh.ts), except for the pinned DoH host;
//   3. transport(new Request(url, {redirect:'manual', signal: 10 s deadline}));
//   4. any 3xx (or opaque redirect) is `redirect_refused`; Location is never read;
//   5. non-2xx is `http_status` with Retry-After / RateLimit-Reset parsed;
//   6. the body is streamed under the per-kind cap and cancelled on overflow.
//
// The Transport is injected (production: globalThis.fetch via fetchTransport).
// A Transport marked `fixture: true` (test-support only) additionally admits
// the reserved fixture TLDs and documentation addresses; nothing can switch
// any check off.

import type { Clock } from '@atmusic/core/deps';
import { fetchTransport, type Transport } from '../transport';
import { cappedStream, declaredLength, raceDeadline, readCapped, SafeFetchError } from './body';
import { DOH_HOST, resolvePublic } from './doh';
import { assertUrl, isFixtureTransport } from './url-policy';

export { isSafeFetchError, SafeFetchError, type SafeFetchErrorCode } from './body';

export type FetchKind = 'didDoc' | 'json' | 'getRecord' | 'getBlocks' | 'getRepo';

const KiB = 1024;
const MiB = 1024 * KiB;

/** Default (and maximum) body cap per kind. */
export const KIND_CAPS: Readonly<Record<FetchKind, number>> = {
  didDoc: 64 * KiB,
  json: 1 * MiB,
  getRecord: 1 * MiB,
  getBlocks: 8 * MiB,
  getRepo: 32 * MiB,
};

export const DEFAULT_ACCEPT: Readonly<Record<FetchKind, string>> = {
  didDoc: 'application/did+ld+json, application/json',
  json: 'application/json',
  getRecord: 'application/vnd.ipld.car',
  getBlocks: 'application/vnd.ipld.car',
  getRepo: 'application/vnd.ipld.car',
};

export const SAFE_FETCH_DEADLINE_MS = 10_000;
/** Error bodies are read only to learn the XRPC error name. */
const ERROR_BODY_MAX_BYTES = 64 * KiB;

/** Source of the per-request deadline signal. Production: AbortSignal.timeout. */
export interface DeadlineTimer {
  timeout(ms: number): AbortSignal;
}

export const systemTimer: DeadlineTimer = { timeout: (ms) => AbortSignal.timeout(ms) };

export interface SafeFetchOptions {
  kind: FetchKind;
  /** Accept header; defaults per kind. */
  accept?: string;
  /** Lower the kind's cap; a value above it is a programming error. */
  maxBytes?: number;
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface SafeStreamResponse {
  url: string;
  status: number;
  headers: Headers;
  /** Errors with `body_too_large` past the cap and `timeout` past the deadline. */
  body: ReadableStream<Uint8Array>;
}

export interface SafeFetch {
  (url: string | URL, options: SafeFetchOptions): Promise<SafeResponse>;
  /** Same policy, but the body is handed over as a capped stream (getRepo CAR parsing). */
  stream(url: string | URL, options: SafeFetchOptions): Promise<SafeStreamResponse>;
}

export interface CreateSafeFetchOptions {
  transport?: Transport;
  clock: Clock;
  /**
   * Assert fixture mode. Fixture relaxations follow the Transport's own
   * `fixture: true` mark; passing a value that disagrees with it throws.
   */
  fixture?: boolean;
  /** Injected deadline source (tests step it by hand); defaults to AbortSignal.timeout. */
  timer?: DeadlineTimer;
}

function capFor(options: SafeFetchOptions): number {
  const cap = KIND_CAPS[options.kind];
  if (cap === undefined) throw new TypeError(`unknown SafeFetch kind: ${String(options.kind)}`);
  if (options.maxBytes === undefined) return cap;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > cap) {
    throw new RangeError(`maxBytes for ${options.kind} must be an integer in [0, ${cap}], got ${options.maxBytes}`);
  }
  return options.maxBytes;
}

/** Retry-After as a non-negative delay in ms: delta-seconds or an HTTP-date. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isSafeInteger(ms) ? ms : null;
  }
  // HTTP-date (RFC 9110 §5.6.7): IMF-fixdate and the obsolete forms all name GMT.
  if (!/GMT$/.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * RateLimit-Reset as a non-negative delay in ms. atproto PDSs send epoch
 * seconds; the IETF draft sends delta-seconds. Values of at least 10^9 (2001
 * onwards as epoch seconds; ~31 years as a delta) are read as epoch seconds.
 */
export function parseRateLimitReset(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n * 1000)) return null;
  return n >= 1_000_000_000 ? Math.max(0, n * 1000 - nowMs) : n * 1000;
}

function parseXrpcError(bytes: Uint8Array | null): { xrpcError: string | null; xrpcMessage: string | null } {
  if (!bytes || bytes.byteLength === 0) return { xrpcError: null, xrpcMessage: null };
  try {
    const doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (typeof doc === 'object' && doc !== null) {
      const { error, message } = doc as { error?: unknown; message?: unknown };
      return {
        xrpcError: typeof error === 'string' ? error : null,
        xrpcMessage: typeof message === 'string' ? message : null,
      };
    }
  } catch {
    // Not JSON: the status alone classifies it.
  }
  return { xrpcError: null, xrpcMessage: null };
}

function discard(response: Response): void {
  if (response.body) response.body.cancel().catch(() => {});
}

export function createSafeFetch(options: CreateSafeFetchOptions): SafeFetch {
  const transport = options.transport ?? fetchTransport;
  const clock = options.clock;
  const timer = options.timer ?? systemTimer;
  const fixture = isFixtureTransport(transport);
  if (options.fixture !== undefined && options.fixture !== fixture) {
    throw new TypeError(
      options.fixture
        ? 'fixture mode requires a Transport marked fixture:true'
        : 'a fixture Transport cannot run in production mode',
    );
  }

  async function open(
    input: string | URL,
    fetchOptions: SafeFetchOptions,
  ): Promise<{ response: Response; url: string; cap: number; signal: AbortSignal }> {
    const cap = capFor(fetchOptions);
    const { url, host } = assertUrl(input, { fixture });
    const signal = timer.timeout(SAFE_FETCH_DEADLINE_MS);

    if (host !== DOH_HOST) await resolvePublic(host, transport, clock, { signal });

    const request = new Request(url.href, {
      method: 'GET',
      headers: { accept: fetchOptions.accept ?? DEFAULT_ACCEPT[fetchOptions.kind] },
      redirect: 'manual',
      signal,
    });

    let response: Response;
    try {
      response = await raceDeadline(transport(request), signal);
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      if (signal.aborted) throw new SafeFetchError('timeout', 'deadline exceeded', { reason: 'deadline' });
      throw new SafeFetchError('network_error', `transport failed: ${String(error)}`, { reason: 'transport' });
    }

    const status = response.status;
    if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
      discard(response);
      throw new SafeFetchError('redirect_refused', `redirect refused (HTTP ${status})`, {
        reason: 'redirect',
        status,
      });
    }
    if (status < 200 || status >= 300) {
      let errorBody: Uint8Array | null = null;
      try {
        errorBody = await readCapped(response, Math.min(cap, ERROR_BODY_MAX_BYTES), signal);
      } catch (error) {
        if (error instanceof SafeFetchError && error.code === 'timeout') throw error;
        // An oversized or broken error body does not change the classification.
      }
      const now = clock.nowMs();
      throw new SafeFetchError('http_status', `upstream HTTP ${status}`, {
        reason: `http_${status}`,
        status,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now),
        rateLimitResetMs: parseRateLimitReset(response.headers.get('ratelimit-reset'), now),
        ...parseXrpcError(errorBody),
      });
    }
    return { response, url: url.href, cap, signal };
  }

  const safeFetch = (async (input, fetchOptions) => {
    const { response, url, cap, signal } = await open(input, fetchOptions);
    const body = await readCapped(response, cap, signal);
    return { url, status: response.status, headers: response.headers, body };
  }) as SafeFetch;

  safeFetch.stream = async (input, fetchOptions) => {
    const { response, url, cap, signal } = await open(input, fetchOptions);
    const declared = declaredLength(response.headers);
    if (declared !== null && declared > cap) {
      discard(response);
      throw new SafeFetchError('body_too_large', `response body exceeds ${cap} bytes`, {
        reason: 'content_length',
        maxBytes: cap,
      });
    }
    return { url, status: response.status, headers: response.headers, body: cappedStream(response.body, cap, signal) };
  };

  return safeFetch;
}
