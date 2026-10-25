// policyFetch: the fetch-shaped path for every outbound request that is not a
// SafeFetch read (ADR 0005 §3.5, amendment B5). The OAuth client (PAR, token,
// revoke, metadata; N2-03), PdsWriter (N2-05), the forward clients (N3-08) and
// the import sources (N3-09) use it, POSTs included.
//
// It applies SafeFetch's rules, in order:
//
//   1. the URL policy (`checkUrl`, packages/atproto/src/net/url-policy.ts):
//      https only, default port, no credentials or fragment, no IP literal,
//      no reserved or local suffix; refused before anything is looked up;
//   2. the request body is buffered under the caller's request-body cap;
//   3. transport(new Request(url, {redirect: 'manual', signal: 10 s deadline}));
//   4. any 3xx (or opaque redirect) is TransportError `redirect`; Location is
//      never read or requested;
//   5. the response body is streamed under the caller's response-body cap and
//      the deadline, and errors with TransportError past either.
//
// Non-2xx answers other than 3xx are returned as they are: the OAuth client
// and the protocol clients read their error bodies. There is no DoH pre-check;
// the pinned transport's connect-time address check is the address policy.
// Every failure is a TransportError, never a raw TypeError (see
// pinned-transport.ts).
//
// The Transport is injected: production passes the pinned transport; tests
// pass the pinned transport over an in-memory connector, or a fixture
// transport (test-support only), whose `fixture: true` mark admits the
// reserved fixture TLDs exactly as it does for SafeFetch.

import { type DeadlineTimer, systemTimer } from '@atmusic/atproto/net/safe-fetch';
import { checkUrl, isFixtureTransport } from '@atmusic/atproto/net/url-policy';
import type { Transport } from '@atmusic/atproto/transport';
import { TransportError, toTransportError } from './pinned-transport';

/** The deadline for one exchange (headers and body), as SafeFetch's. */
export const POLICY_DEADLINE_MS = 10_000;

export interface PolicyCaps {
  /** Largest request body this caller may send. */
  maxRequestBytes: number;
  /** Largest response body this caller accepts. */
  maxResponseBytes: number;
}

export interface PolicyFetchOptions {
  caps: PolicyCaps;
}

export type PolicyFetch = (
  input: string | URL | Request,
  init: RequestInit | undefined,
  options: PolicyFetchOptions,
) => Promise<Response>;

/** policyFetch with one caller's caps bound: the `fetch` an HTTP client library takes. */
export type BoundPolicyFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CreatePolicyFetchOptions {
  transport: Transport;
  /** Deadline source; defaults to AbortSignal.timeout. */
  timer?: DeadlineTimer;
}

function assertCaps(caps: PolicyCaps | undefined): asserts caps is PolicyCaps {
  for (const name of ['maxRequestBytes', 'maxResponseBytes'] as const) {
    const value = caps?.[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`policyFetch caps.${name} must be a non-negative safe integer, got ${String(value)}`);
    }
  }
}

function inputUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Read a body stream fully under `maxBytes`, honouring `signal`. */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  reason: string,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const aborted = new Promise<never>((_, reject) => {
    const fire = () => reject(toTransportError(signal.reason, signal));
    if (signal.aborted) fire();
    else signal.addEventListener('abort', fire, { once: true });
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const step = await Promise.race([reader.read(), aborted]);
      if (step.done) break;
      const chunk = step.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        reader.cancel('too_large').catch(() => {});
        throw new TransportError('too_large', `request body exceeds ${maxBytes} bytes`, { reason, maxBytes });
      }
      chunks.push(chunk);
    }
  } catch (error) {
    reader.cancel('aborted').catch(() => {});
    throw toTransportError(error, signal);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read after cancel keeps the lock; the stream is cancelled.
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * A pull-through view of a response body that errors with TransportError
 * `too_large` past `maxBytes` (cancelling the source), `timeout` when the
 * deadline aborts, and keeps any TransportError the source raised.
 */
function cappedBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let total = 0;
  let onAbort: (() => void) | null = null;
  const stop = () => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    onAbort = null;
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        reader.cancel('deadline').catch(() => {});
        try {
          controller.error(toTransportError(signal.reason, signal));
        } catch {
          // Already closed.
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (error) {
        stop();
        controller.error(toTransportError(error, signal));
        return;
      }
      if (signal.aborted) return; // onAbort has errored the stream.
      if (step.done) {
        stop();
        controller.close();
        return;
      }
      const chunk = step.value;
      if (!(chunk instanceof Uint8Array)) {
        stop();
        reader.cancel('bad_chunk').catch(() => {});
        controller.error(
          new TransportError('connect', 'response stream yielded a non-byte chunk', { reason: 'bad_chunk' }),
        );
        return;
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        stop();
        reader.cancel('too_large').catch(() => {});
        controller.error(
          new TransportError('too_large', `response body exceeds ${maxBytes} bytes`, { reason: 'streamed', maxBytes }),
        );
        return;
      }
      controller.enqueue(chunk);
    },
    cancel(reason) {
      stop();
      reader.cancel(reason).catch(() => {});
    },
  });
}

function discard(response: Response): void {
  if (response.body) response.body.cancel().catch(() => {});
}

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

export function createPolicyFetch(options: CreatePolicyFetchOptions): PolicyFetch {
  const transport = options.transport;
  if (typeof transport !== 'function') throw new TypeError('createPolicyFetch needs a transport');
  const timer = options.timer ?? systemTimer;
  const fixture = isFixtureTransport(transport);

  return async (input, init, fetchOptions) => {
    const caps = fetchOptions?.caps;
    assertCaps(caps);

    // 1. URL policy, before anything else happens.
    const checked = checkUrl(inputUrl(input), { fixture });
    if (!checked.ok) {
      throw new TransportError('blocked_address', `destination refused: ${checked.reason}`, { reason: checked.reason });
    }
    const url = checked.url;

    const deadline = timer.timeout(POLICY_DEADLINE_MS);
    let draft: Request;
    try {
      draft = new Request(input instanceof Request ? input : url.href, init);
    } catch (error) {
      throw new TransportError(
        'connect',
        `request rejected: ${error instanceof Error ? error.message : String(error)}`,
        {
          reason: 'invalid_request',
          cause: error,
        },
      );
    }
    const signal = AbortSignal.any([deadline, draft.signal]);

    // 2. Buffer the request body under its cap.
    const body =
      draft.body === null ? null : await readBounded(draft.body, caps.maxRequestBytes, signal, 'request_body');

    const request = new Request(url.href, {
      method: draft.method,
      headers: draft.headers,
      body,
      redirect: 'manual',
      signal,
    });

    // 3. One exchange through the transport, under the deadline.
    let response: Response;
    try {
      response = await raceDeadline(transport(request), signal);
    } catch (error) {
      throw toTransportError(error, signal);
    }

    // 4. Redirects are refused; Location is never read.
    const status = response.status;
    if ((response.type as string) === 'opaqueredirect' || (status >= 300 && status < 400)) {
      discard(response);
      throw new TransportError('redirect', `redirect refused (HTTP ${status})`, { reason: `http_${status}`, status });
    }

    // 5. The response body under its cap and the deadline.
    const declared = response.headers.get('content-length');
    if (declared !== null && /^\s*\d+\s*$/.test(declared) && Number(declared.trim()) > caps.maxResponseBytes) {
      discard(response);
      throw new TransportError('too_large', `response body exceeds ${caps.maxResponseBytes} bytes`, {
        reason: 'content_length',
        maxBytes: caps.maxResponseBytes,
      });
    }
    const nullBody = response.body === null || NULL_BODY_STATUSES.has(status) || draft.method === 'HEAD';
    if (nullBody) discard(response);
    let out: Response;
    try {
      out = new Response(
        nullBody ? null : cappedBody(response.body as ReadableStream<Uint8Array>, caps.maxResponseBytes, signal),
        { status, statusText: response.statusText, headers: response.headers },
      );
    } catch (error) {
      discard(response);
      throw toTransportError(error, signal);
    }
    Object.defineProperty(out, 'url', { value: url.href });
    return out;
  };
}

/** Bind one caller's caps, giving the plain `fetch` shape a client library expects. */
export function bindPolicyFetch(policyFetch: PolicyFetch, caps: PolicyCaps): BoundPolicyFetch {
  assertCaps(caps);
  const bound = { caps: { ...caps } };
  return (input, init) => policyFetch(input, init, bound);
}

/** Settle with `promise`, or reject with TransportError `timeout` as soon as `signal` aborts. */
function raceDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(toTransportError(signal.reason, signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(toTransportError(signal.reason, signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
