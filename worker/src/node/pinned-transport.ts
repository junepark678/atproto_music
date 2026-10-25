// The pinned outbound transport of the Node host (ADR 0005 §3.5, amendment B5).
//
// On Node a bad fetch could reach the owner's LAN, 127.x and our own listener
// (127.2.0.1:8888). Every production `Transport` therefore runs over one undici
// `Agent` whose connector:
//
//   1. resolves the hostname once through the (injectable) lookup;
//   2. applies `isAllowedAddress` (packages/atproto/src/net/url-policy.ts, the
//      port of the Rust oracle's `public_ip`) to EVERY answer, refusing the
//      whole destination when any answer is non-public or there are none (the
//      oracle's `SafeClient::destination`);
//   3. connects only to an address it checked: the socket stage is handed the
//      literal address (`host`) with the hostname only as TLS `servername`, so
//      nothing resolves the name a second time (this closes the A5 DoH
//      rebinding residual);
//   4. always uses `rejectUnauthorized: true`, explicitly, so neither
//      NODE_TLS_REJECT_UNAUTHORIZED nor any caller option can weaken TLS.
//
// Every failure rejects with `TransportError {code}`, never a raw TypeError:
// @atproto/oauth-client deletes a session on a TypeError, and a network blip
// must not sign anyone out (ADR 0005 §3.5).
//
// The lookup and the socket stage (`connector`, tls.connect-shaped) are
// injected interfaces; tests pass a lookup spy and an in-memory duplex, and
// production passes neither. There is no option that relaxes any check.
//
// Redirects are never followed. A request sent with `redirect: 'manual'` (all
// SafeFetch and policyFetch requests) gets its 3xx back as a bodiless Response,
// so the caller's own refusal decides the error (SafeFetch's permanent
// `redirect_refused`, policyFetch's TransportError `redirect`); a 3xx to any
// other request is TransportError `redirect`.
//
// The transport's response cap is a backstop only: DEFAULT_PINNED_CAPS keeps it
// strictly larger than every SafeFetch kind cap, so SafeFetch's own
// `body_too_large` (and policyFetch's `too_large`) trips first.
//
// `unpinnedFetchStub` is what run() installs as globalThis.fetch (N3-07), so a
// consumer that forgot its transport fails loudly instead of bypassing pinning.

import { promises as dns } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import type { Duplex } from 'node:stream';
import { type ConnectionOptions, connect as tlsConnect } from 'node:tls';
import type { DeadlineTimer } from '@atmusic/atproto/net/safe-fetch';
import { isAllowedAddress } from '@atmusic/atproto/net/url-policy';
import type { Transport } from '@atmusic/atproto/transport';
import { Agent, type Dispatcher } from 'undici';

// ---------------------------------------------------------------------------
// Errors

export const TRANSPORT_ERROR_CODES = [
  'blocked_address', // a URL-policy refusal, or a lookup answer / IP literal that is not public
  'dns', // the lookup failed or returned nothing usable
  'connect', // the socket or TLS stage failed (refused, reset, certificate), or the request was unusable
  'timeout', // the deadline (or the caller's signal) fired before the exchange finished
  'too_large', // a request or response body over its cap
  'redirect', // a 3xx answer to a request that did not ask for redirect:'manual'; Location is never followed
  'unpinned_fetch', // the global fetch stub was called
] as const;

export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

export interface TransportErrorDetails {
  /** Short machine-readable cause, e.g. `private_answer`, `content_length`, `http_302`. */
  reason?: string;
  /** HTTP status for `redirect`. */
  status?: number;
  /** The address that was refused, for `blocked_address` answers. */
  address?: string;
  /** The cap that was exceeded, for `too_large`. */
  maxBytes?: number;
  cause?: unknown;
}

/**
 * A network-level failure. Deliberately extends Error and not TypeError (see
 * the module comment).
 */
export class TransportError extends Error {
  readonly reason: string | null;
  readonly status: number | null;
  readonly address: string | null;
  readonly maxBytes: number | null;

  constructor(
    readonly code: TransportErrorCode,
    message?: string,
    details: TransportErrorDetails = {},
  ) {
    super(
      message ?? (details.reason ? `${code}: ${details.reason}` : code),
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = 'TransportError';
    this.reason = details.reason ?? null;
    this.status = details.status ?? null;
    this.address = details.address ?? null;
    this.maxBytes = details.maxBytes ?? null;
  }
}

export function isTransportError(value: unknown, code?: TransportErrorCode): value is TransportError {
  return value instanceof TransportError && (code === undefined || value.code === code);
}

const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);

/** The first TransportError on `error`'s cause chain, if any. */
function findTransportError(error: unknown): TransportError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth++) {
    if (current instanceof TransportError) return current;
    if (current instanceof AggregateError) {
      for (const inner of current.errors) {
        const found = findTransportError(inner);
        if (found) return found;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Map anything a request can throw to a TransportError: an existing one (also
 * found on the cause chain) is kept; an abort of `signal` is `timeout`;
 * undici's and Node's timeout codes are `timeout`; everything else is
 * `fallback` (default `connect`).
 */
export function toTransportError(
  error: unknown,
  signal?: AbortSignal | null,
  fallback: TransportErrorCode = 'connect',
): TransportError {
  const found = findTransportError(error);
  if (found) return found;
  if (signal?.aborted) {
    return new TransportError('timeout', 'deadline exceeded', { reason: 'deadline', cause: error });
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TIMEOUT_ERROR_CODES.has(code)) {
    return new TransportError('timeout', `transport timed out (${code})`, { reason: code, cause: error });
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new TransportError('timeout', 'request aborted', { reason: 'aborted', cause: error });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new TransportError(fallback, `transport failed: ${detail}`, {
    reason: typeof code === 'string' ? code : 'transport',
    cause: error,
  });
}

// ---------------------------------------------------------------------------
// Injected interfaces

export interface LookupAnswer {
  address: string;
  /** 4 or 6; derived from the address when absent. */
  family?: number;
  highWaterMark?: number;
}

/** Resolve a hostname to every address it has. Production: dns.lookup({all:true}). */
export type PinnedLookup = (hostname: string) => Promise<readonly LookupAnswer[]>;

/**
 * The TLS options the socket stage receives: always the literal checked
 * address as `host`, the hostname as `servername`, and `rejectUnauthorized:
 * true`. Its `lookup` answers only with that same address.
 */
export type PinnedTlsOptions = ConnectionOptions & {
  host: string;
  port: number;
  family?: number;
  highWaterMark?: number;
  rejectUnauthorized: true;
  lookup: LookupFunction;
};

/**
 * The socket stage: open a connected (TLS) duplex for `options`. Production is
 * `tls.connect`, resolved on `secureConnect`; tests pass an in-memory duplex.
 * When `signal` aborts the stage must give up and destroy what it opened.
 */
export type SocketConnector = (options: PinnedTlsOptions, signal: AbortSignal) => Promise<Duplex>;

export interface PinnedTransportCaps {
  /** Largest response body the transport passes on (SafeFetch and policyFetch lower it per call). */
  maxResponseBytes: number;
  /** Largest request body the transport sends. */
  maxRequestBytes: number;
  /** Deadline for one exchange: connect, headers and body. */
  deadlineMs: number;
  /** Deadline for lookup plus connect; defaults to `deadlineMs`. */
  connectTimeoutMs?: number;
}

export interface PinnedTransportOptions {
  lookup?: PinnedLookup;
  connector?: SocketConnector;
  caps: PinnedTransportCaps;
  /** Deadline source; defaults to AbortSignal.timeout. */
  timer?: DeadlineTimer;
}

export type PinnedTransport = Transport & {
  /** The undici Agent every request of this transport dispatches through. */
  readonly agent: Agent;
  /** The connect options the Agent's connector applies to every socket. */
  readonly connectOptions: Readonly<{ rejectUnauthorized: true; lookup: PinnedLookup }>;
  close(): Promise<void>;
};

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * Production caps. The response cap is a backstop strictly larger than the
 * largest SafeFetch kind (getRepo, 32 MiB; policyFetch callers must keep their
 * caps below it too), so the caller's own cap (and its error code: SafeFetch `body_too_large`, which
 * getRepo turns into the permanent `car_too_large`) always trips first, for a
 * declared Content-Length and for streamed bytes alike. The deadline is
 * SafeFetch's and policyFetch's 10 s.
 */
export const DEFAULT_PINNED_CAPS: Readonly<PinnedTransportCaps> = Object.freeze({
  maxResponseBytes: 64 * MiB,
  maxRequestBytes: 4 * MiB,
  deadlineMs: 10_000,
});

const defaultTimer: DeadlineTimer = { timeout: (ms) => AbortSignal.timeout(ms) };

/** Production lookup: every A/AAAA answer, in resolver order. */
export const systemLookup: PinnedLookup = async (hostname) => dns.lookup(hostname, { all: true, order: 'verbatim' });

/** Production socket stage: tls.connect, resolved once the handshake has verified the peer. */
export const tlsSocketConnector: SocketConnector = (options, signal) =>
  new Promise<Duplex>((resolve, reject) => {
    const socket = tlsConnect(options);
    const onAbort = () => {
      socket.destroy();
      reject(new TransportError('timeout', 'connect deadline exceeded', { reason: 'connect_deadline' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('secureConnect', () => {
      signal.removeEventListener('abort', onAbort);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 60_000);
      resolve(socket);
    });
    socket.once('error', (error) => {
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      reject(error);
    });
  });

function assertCap(name: string, value: number | undefined, optional = false): void {
  if (optional && value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`pinnedTransport caps.${name} must be a positive safe integer, got ${String(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Address checking

function familyOf(answer: LookupAnswer): 4 | 6 {
  if (answer.family === 4 || answer.family === 6) return answer.family;
  return isIP(answer.address) === 6 ? 6 : 4;
}

/** Strip the brackets URL hostnames put around IPv6 literals. */
function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * The checked address set for `hostname`: an IP literal is checked itself
 * (no lookup); a name is looked up once and refused when the answer set is
 * empty or ANY answer is not public.
 */
async function checkedAddresses(hostname: string, lookup: PinnedLookup): Promise<{ address: string; family: 4 | 6 }[]> {
  const host = bareHost(hostname);
  if (host === '') throw new TransportError('blocked_address', 'no host to connect to', { reason: 'no_host' });
  const literal = isIP(host);
  if (literal !== 0) {
    if (!isAllowedAddress(host)) {
      throw new TransportError('blocked_address', `${host} is not a public address`, {
        reason: 'private_literal',
        address: host,
      });
    }
    return [{ address: host, family: literal === 6 ? 6 : 4 }];
  }

  let answers: readonly LookupAnswer[];
  try {
    answers = await lookup(host);
  } catch (error) {
    if (error instanceof TransportError) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    throw new TransportError(
      'dns',
      `lookup of ${host} failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        reason: typeof code === 'string' ? code : 'lookup',
        cause: error,
      },
    );
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new TransportError('dns', `${host} has no addresses`, { reason: 'no_answers' });
  }
  const checked: { address: string; family: 4 | 6 }[] = [];
  for (const answer of answers) {
    const address = typeof answer?.address === 'string' ? answer.address : '';
    if (!isAllowedAddress(address)) {
      throw new TransportError('blocked_address', `${host} resolves to a non-public address`, {
        reason: 'private_answer',
        address,
      });
    }
    checked.push({ address, family: familyOf(answer) });
  }
  return checked;
}

/** A Node LookupFunction that answers only with an already-checked address. */
function fixedLookup(pinned: { address: string; family: 4 | 6 }): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  }) as LookupFunction;
}

// ---------------------------------------------------------------------------
// The transport

interface ConnectParams {
  hostname: string;
  host?: string;
  protocol: string;
  port: string | number;
  servername?: string | null;
}

type ConnectCallback = (...args: [null, Duplex] | [Error, null]) => void;

/** Convert a Fetch Headers object to undici's flat [name, value, ...] form. */
function flatHeaders(headers: Headers): string[] {
  const out: string[] = [];
  headers.forEach((value, name) => {
    out.push(name, value);
  });
  return out;
}

/** Response headers (undici's object form, arrays for repeats) → Headers. */
function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.append(name, value);
  }
  return headers;
}

/** Read a request body fully, refusing more than `maxBytes`. */
async function readRequestBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > maxBytes) {
        reader.cancel('too_large').catch(() => {});
        throw new TransportError('too_large', `request body exceeds ${maxBytes} bytes`, {
          reason: 'request_body',
          maxBytes,
        });
      }
      chunks.push(step.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader may still hold its lock; the stream is done either way.
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

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

export function pinnedTransport(options: PinnedTransportOptions): PinnedTransport {
  const caps = options.caps;
  assertCap('maxResponseBytes', caps?.maxResponseBytes);
  assertCap('maxRequestBytes', caps?.maxRequestBytes);
  assertCap('deadlineMs', caps?.deadlineMs);
  assertCap('connectTimeoutMs', caps?.connectTimeoutMs, true);
  const lookup = options.lookup ?? systemLookup;
  const connector = options.connector ?? tlsSocketConnector;
  const timer = options.timer ?? defaultTimer;
  const connectTimeoutMs = caps.connectTimeoutMs ?? caps.deadlineMs;

  const connectOptions = Object.freeze({ rejectUnauthorized: true as const, lookup });

  function connect(params: ConnectParams, callback: ConnectCallback): void {
    const signal = timer.timeout(connectTimeoutMs);
    let settled = false;
    const finish = (error: Error | null, socket: Duplex | null) => {
      if (settled) {
        socket?.destroy();
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) callback(error, null);
      else callback(null, socket as Duplex);
    };
    const onAbort = () =>
      finish(new TransportError('timeout', 'connect deadline exceeded', { reason: 'connect_deadline' }), null);
    signal.addEventListener('abort', onAbort, { once: true });

    (async () => {
      if (params.protocol !== 'https:') {
        throw new TransportError('blocked_address', 'only https destinations are reachable', { reason: 'not_https' });
      }
      const hostname = bareHost(params.hostname);
      const port = Number(params.port) || 443;
      const addresses = await checkedAddresses(hostname, connectOptions.lookup);
      const servername = isIP(hostname) === 0 ? hostname : undefined;
      let last: unknown = null;
      for (const pinned of addresses) {
        if (signal.aborted || settled) return null;
        const tlsOptions: PinnedTlsOptions = {
          ...(servername === undefined ? {} : { servername }),
          host: pinned.address,
          port,
          family: pinned.family,
          lookup: fixedLookup(pinned),
          ALPNProtocols: ['http/1.1'],
          highWaterMark: 16 * KiB,
          rejectUnauthorized: connectOptions.rejectUnauthorized,
        };
        try {
          return await connector(tlsOptions, signal);
        } catch (error) {
          last = error;
        }
      }
      throw toTransportError(last, signal, 'connect');
    })().then(
      (socket) => {
        if (socket) finish(null, socket);
      },
      (error: unknown) => finish(toTransportError(error, signal, 'connect'), null),
    );
  }

  const agent = new Agent({
    connect: connect as unknown as Agent.Options['connect'],
    headersTimeout: caps.deadlineMs,
    bodyTimeout: caps.deadlineMs,
  });

  const transport = (async (request: Request): Promise<Response> => {
    const deadline = timer.timeout(caps.deadlineMs);
    const signal = request.signal ? AbortSignal.any([deadline, request.signal]) : deadline;

    let url: URL;
    try {
      url = new URL(request.url);
    } catch (error) {
      throw new TransportError('blocked_address', 'unparseable request URL', { reason: 'unparseable', cause: error });
    }
    if (url.protocol !== 'https:') {
      throw new TransportError('blocked_address', 'only https destinations are reachable', { reason: 'not_https' });
    }

    let body: Uint8Array | null;
    try {
      body = await raceAbort(readRequestBody(request, caps.maxRequestBytes), signal);
    } catch (error) {
      throw toTransportError(error, signal);
    }

    let answer: Dispatcher.ResponseData;
    try {
      answer = await raceAbort(
        agent.request({
          origin: url.origin,
          path: `${url.pathname}${url.search}`,
          method: request.method as Dispatcher.HttpMethod,
          headers: flatHeaders(request.headers),
          body: body === null ? null : Buffer.from(body.buffer, body.byteOffset, body.byteLength),
          signal,
        }),
        signal,
      );
    } catch (error) {
      throw toTransportError(error, signal);
    }

    const status = answer.statusCode;
    if (status >= 300 && status < 400 && request.redirect !== 'manual') {
      dropBody(answer.body);
      throw new TransportError('redirect', `redirect refused (HTTP ${status})`, { reason: `http_${status}`, status });
    }
    let headers: Headers;
    try {
      headers = toHeaders(answer.headers);
    } catch (error) {
      dropBody(answer.body);
      throw new TransportError('connect', 'unusable response headers', { reason: 'bad_headers', cause: error });
    }
    if (status >= 300 && status < 400) {
      // redirect:'manual': hand the 3xx back unfollowed and bodiless (its
      // body, whatever its declared length, is never read); the caller
      // refuses it with its own error code.
      dropBody(answer.body);
      return new Response(null, { status, headers });
    }
    const declared = headers.get('content-length');
    if (declared !== null && /^\s*\d+\s*$/.test(declared) && Number(declared.trim()) > caps.maxResponseBytes) {
      dropBody(answer.body);
      throw new TransportError('too_large', `response body exceeds ${caps.maxResponseBytes} bytes`, {
        reason: 'content_length',
        maxBytes: caps.maxResponseBytes,
      });
    }
    if (status < 200 || status > 599) {
      dropBody(answer.body);
      throw new TransportError('connect', `unusable HTTP status ${status}`, { reason: 'bad_status', status });
    }
    if (NULL_BODY_STATUSES.has(status) || request.method === 'HEAD') {
      dropBody(answer.body);
      return new Response(null, { status, headers });
    }
    return new Response(responseStream(answer.body, caps.maxResponseBytes, signal), { status, headers });
  }) as PinnedTransport;

  Object.defineProperties(transport, {
    agent: { value: agent, enumerable: true },
    connectOptions: { value: connectOptions, enumerable: true },
    close: { value: () => agent.close() },
  });
  return transport;
}

/** Destroy an undici body we will not read; its abort error is expected and swallowed. */
function dropBody(body: Dispatcher.ResponseData['body']): void {
  body.on('error', () => {});
  body.destroy();
}

/** Settle with `promise`, or reject with `timeout` as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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

/**
 * A web stream over undici's body that errors with TransportError: `too_large`
 * past `maxBytes` (the upstream is destroyed, nothing more is pulled),
 * `timeout` when `signal` aborts, `connect` when the connection breaks.
 */
function responseStream(
  body: Dispatcher.ResponseData['body'],
  maxBytes: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let total = 0;
  let onAbort: (() => void) | null = null;
  const stop = () => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    onAbort = null;
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        dropBody(body);
        try {
          controller.error(toTransportError(signal.reason, signal));
        } catch {
          // Already closed or errored.
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      let step: IteratorResult<Buffer>;
      try {
        step = await iterator.next();
      } catch (error) {
        stop();
        dropBody(body);
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
      total += chunk.byteLength;
      if (total > maxBytes) {
        stop();
        dropBody(body);
        controller.error(
          new TransportError('too_large', `response body exceeds ${maxBytes} bytes`, { reason: 'streamed', maxBytes }),
        );
        return;
      }
      controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    },
    cancel() {
      stop();
      dropBody(body);
    },
  });
}

// ---------------------------------------------------------------------------
// The global fetch stub

/**
 * Installed as globalThis.fetch by run() (N3-07) before anything is composed:
 * every outbound consumer must be handed the pinned transport or policyFetch,
 * and one that falls back to the global fetch fails here instead of reaching
 * an unchecked address.
 */
export const unpinnedFetchStub = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  throw new TransportError('unpinned_fetch', `unpinned global fetch refused for ${target}`, {
    reason: 'unpinned_fetch',
  });
};
