// The Node host's HTTP listener (ADR 0005 §3.6; N1-06): a node:http server
// bridged to WHATWG Request/Response, so every existing handler is reused.
//
// - **Request URL** is PUBLIC_ORIGIN followed by the raw request target (path
//   and query exactly as received; the absolute form keeps only its path).
//   Host, X-Forwarded-Host and X-Forwarded-Proto never change it.
// - **Host check.** Host must be the public host (with or without the scheme's
//   default port) or the listen address (`127.2.0.1:8888`, `[::1]:<port>`),
//   else 421 `misdirected_request`. This stops DNS-rebinding pages in the
//   owner's browser from reaching the loopback port.
// - **Bodies** are streamed to the handler under a per-route cap (`bodyCapFor`,
//   the ADR table; injectable). A Content-Length over the cap is answered 413
//   before any body byte is read. Otherwise the bridge stops consuming the
//   body as soon as more than `cap` bytes have arrived (the cap+1st byte),
//   never hands the handler more than `cap` bytes, errors the handler's body
//   stream, aborts its signal, and answers 413 itself, whatever the handler
//   later returns. GET and HEAD carry no body.
// - **Disconnects.** When the client goes away before the response is
//   complete, the handler's AbortSignal (also `request.signal`) is aborted.
// - **HEAD** answers the handler's headers without a body.
// - **Headers.** Every inbound `x-atmusic-*` header is dropped before the
//   handler sees the request. The response carries the handler's headers
//   (each Set-Cookie separately). A response sent while the request body is
//   still unread closes the connection, so the rest is never parsed as a
//   request.
// - **Timeouts:** keepAliveTimeout 100 s (above cloudflared's 90 s origin idle
//   timeout), headersTimeout 60 s, requestTimeout 600 s.
// - **Bind.** `parseListen(ATMUSIC_LISTEN)` accepts only loopback IP literals
//   (127.0.0.0/8 or ::1) with a port; anything else is a ListenConfigError.
//   `socketActivation(env, pid)` returns the inherited fd 3 when LISTEN_FDS=1
//   and LISTEN_PID is our pid; after `listen({fd})` the socket's local address
//   is checked and a non-loopback socket (an IP socket elsewhere, or a unix
//   socket) is closed and refused.
// - Errors the bridge answers itself (400, 413, 421, 500) use the API error
//   envelope with a request id from the injected Random; a handler that throws
//   gets the generic 500, and its error is never echoed.

import { once } from 'node:events';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cryptoRandom, type Random } from '@atmusic/core/deps';
import { errorResponse, toErrorResponse } from '../http/error';
import { newRequestId } from '../http/request-id';
import { formatIp, parseIp } from './client-ip';

export const KEEP_ALIVE_TIMEOUT_MS = 100_000;
export const HEADERS_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 600_000;

/** ATMUSIC_LISTEN when it is unset (ADR 0005 §3.6). */
export const DEFAULT_LISTEN = '127.2.0.1:8888';
/** The first inherited socket of systemd socket activation (sd_listen_fds). */
export const SD_LISTEN_FDS_START = 3;

/** Body caps of ADR 0005 §3.6, in bytes. */
export const BODY_CAPS = {
  default: 64 * 1024,
  lastfm: 1024 * 1024,
  submitListens: 10_240_000,
  importUpload: 64 * 1024 * 1024,
} as const;

/** The cap for a request to `pathname` (the URL path, still percent-encoded). */
export function bodyCapFor(pathname: string, method: string): number {
  if (pathname === '/2.0' || pathname.startsWith('/2.0/')) return BODY_CAPS.lastfm;
  if (pathname === '/1/submit-listens') return BODY_CAPS.submitListens;
  if (method === 'POST' && pathname === '/api/v1/imports/upload') return BODY_CAPS.importUpload;
  return BODY_CAPS.default;
}

export class ListenConfigError extends Error {
  override readonly name = 'ListenConfigError';
  constructor(
    readonly variable: 'ATMUSIC_LISTEN' | 'LISTEN_FDS',
    message: string,
  ) {
    super(`${variable}: ${message}`);
  }
}

export interface ListenAddress {
  /** An IP literal: `127.2.0.1`, `::1`. */
  readonly host: string;
  readonly port: number;
}
export interface ListenFd {
  readonly fd: number;
}
export type ListenTarget = ListenAddress | ListenFd;

/** The address actually bound, after `start()`. */
export interface BoundAddress {
  readonly host: string;
  readonly port: number;
  /** `host:port`, `[v6]:port`: the Host value a direct client sends. */
  readonly authority: string;
}

/** 127.0.0.0/8 or ::1; also ::ffff:127.0.0.0/104, how a dual-stack socket names an IPv4 loopback peer. */
export function isLoopbackAddress(host: string): boolean {
  const ip = parseIp(host);
  if (ip === null) return false;
  if (ip.family === 4) return ip.bytes[0] === 127;
  return ip.bytes.every((byte, i) => byte === (i === 15 ? 1 : 0));
}

function authorityOf(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * ATMUSIC_LISTEN: `<IPv4>:<port>` or `[<IPv6>]:<port>`, loopback only.
 * Unset or empty means `127.2.0.1:8888`.
 */
export function parseListen(value: string | undefined): ListenAddress {
  const text = value === undefined || value === '' ? DEFAULT_LISTEN : value;
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):([0-9]{1,5})$/.exec(text);
  if (match === null) throw new ListenConfigError('ATMUSIC_LISTEN', 'expected <IPv4>:<port> or [<IPv6>]:<port>');
  const host = (match[1] ?? match[2]) as string;
  const port = Number(match[3]);
  const digits = match[3] as string;
  if (port > 65_535 || (digits.length > 1 && digits.startsWith('0'))) {
    throw new ListenConfigError('ATMUSIC_LISTEN', 'invalid port');
  }
  const ip = parseIp(host);
  // An IPv6 literal only in brackets, an IPv4 literal only without them.
  if (ip === null || (match[1] !== undefined) !== host.includes(':')) {
    throw new ListenConfigError('ATMUSIC_LISTEN', 'the host must be an IP literal');
  }
  if (!isLoopbackAddress(host) || (match[1] !== undefined && ip.family === 4)) {
    throw new ListenConfigError('ATMUSIC_LISTEN', 'only loopback addresses (127.0.0.0/8 or ::1) may be bound');
  }
  return { host: formatIp(ip), port };
}

/**
 * systemd socket activation: `{fd: 3}` when LISTEN_FDS=1 and LISTEN_PID is
 * `pid`; null when no socket was passed to this process. More than one socket
 * is a ListenConfigError. The loopback check runs after `listen({fd})`.
 */
export function socketActivation(env: Readonly<Record<string, string | undefined>>, pid: number): ListenFd | null {
  const fds = env.LISTEN_FDS;
  if (fds === undefined || fds === '') return null;
  if (env.LISTEN_PID !== String(pid)) return null;
  if (fds !== '1') throw new ListenConfigError('LISTEN_FDS', `expected exactly one socket, got ${JSON.stringify(fds)}`);
  return { fd: SD_LISTEN_FDS_START };
}

// ---------------------------------------------------------------------------
// Server

export interface BridgeRequestInfo {
  /** The TCP peer address as the socket reports it (`127.0.0.1`, `::1`). */
  readonly peer: string | undefined;
  /** The request target as received (path and query; the absolute form reduced to them). */
  readonly rawTarget: string;
  /** Aborted when the client disconnects, the body overflows, or the server closes. */
  readonly signal: AbortSignal;
}

export type BridgeHandler = (request: Request, info: BridgeRequestInfo) => Response | Promise<Response>;

export interface BridgeOptions {
  /** `https://music.214510.xyz`: the only source of request URLs. */
  publicOrigin: string;
  listen: ListenTarget;
  handler: BridgeHandler;
  /** Body cap per request; `bodyCapFor` by default. */
  caps?: (pathname: string, method: string) => number;
  /** Request ids of the bridge's own error answers; cryptoRandom in production. */
  random?: Random;
}

export interface BridgeServer {
  readonly server: http.Server;
  /** Null until `start()` resolves. */
  readonly address: BoundAddress | null;
  /** Binds and resolves with the bound address; a refused fd rejects with ListenConfigError. */
  start(): Promise<BoundAddress>;
  /** Stops accepting, aborts in-flight handlers, and closes every connection. */
  close(): Promise<void>;
}

class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError';
}

/** The path-and-query of a request target, or null for `*` and other non-origin forms. */
export function originFormOf(target: string): string | null {
  if (target.startsWith('/')) return target;
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/.exec(target);
  if (absolute === null) return null;
  const rest = target.slice(absolute[0].length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

export function createServer(options: BridgeOptions): BridgeServer {
  const origin = new URL(options.publicOrigin);
  if (origin.origin !== options.publicOrigin.replace(/\/$/, '') || origin.pathname !== '/' || origin.search !== '') {
    throw new TypeError(`publicOrigin must be a bare origin, got ${options.publicOrigin}`);
  }
  const publicOrigin = origin.origin;
  const defaultPort = origin.protocol === 'https:' ? '443' : origin.protocol === 'http:' ? '80' : '';
  const publicHosts = new Set([origin.host.toLowerCase()]);
  if (origin.port === '' && defaultPort !== '') publicHosts.add(`${origin.hostname.toLowerCase()}:${defaultPort}`);

  const caps = options.caps ?? bodyCapFor;
  const random = options.random ?? cryptoRandom;
  const inFlight = new Set<AbortController>();
  let bound: BoundAddress | null = null;

  const server = http.createServer({
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    headersTimeout: HEADERS_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });
  // node:http also takes these from the options object; set them explicitly so
  // the values are visible on the server whatever the Node default.
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  const hostAllowed = (host: string | undefined): boolean => {
    if (host === undefined) return false;
    const lower = host.toLowerCase();
    return publicHosts.has(lower) || (bound !== null && lower === bound.authority.toLowerCase());
  };

  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    // A failure while writing (the socket already gone) must never become an
    // unhandled rejection that takes the process down.
    handle(req, res).catch(() => res.destroy());
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const controller = new AbortController();
    inFlight.add(controller);
    let answered = false;
    res.on('close', () => {
      inFlight.delete(controller);
      if (!res.writableFinished && !controller.signal.aborted) {
        controller.abort(new DOMException('The client disconnected.', 'AbortError'));
      }
    });

    const answer = async (response: Response): Promise<void> => {
      if (answered) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      answered = true;
      await writeResponse(req, res, method, response);
    };
    const bridgeError = (code: Parameters<typeof errorResponse>[0], status: number): Response => {
      const requestId = newRequestId(random);
      const response = errorResponse(code, status, requestId);
      response.headers.set('x-request-id', requestId);
      return response;
    };

    if (!hostAllowed(req.headers.host)) {
      const requestId = newRequestId(random);
      await answer(
        new Response(
          JSON.stringify({
            error: {
              code: 'misdirected_request',
              message: 'This server does not serve the requested host.',
              requestId,
            },
          }),
          {
            status: 421,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': requestId },
          },
        ),
      );
      return;
    }

    const rawTarget = originFormOf(req.url ?? '');
    let url: URL | null = null;
    if (rawTarget !== null) {
      try {
        // String concatenation, never `new URL(target, origin)`: a target such
        // as `//evil.example/x` must stay a path of the public origin.
        url = new URL(publicOrigin + rawTarget);
      } catch {
        url = null;
      }
    }
    if (rawTarget === null || url === null || url.origin !== publicOrigin) {
      await answer(bridgeError('bad_request', 400));
      return;
    }

    const cap = caps(url.pathname, method);
    const declared = req.headers['content-length'];
    if (declared !== undefined && /^[0-9]+$/.test(declared) && Number(declared) > cap) {
      await answer(bridgeError('payload_too_large', 413));
      return;
    }

    const headers = new Headers();
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] as string;
      if (name.toLowerCase().startsWith('x-atmusic-')) continue;
      try {
        headers.append(name, req.rawHeaders[i + 1] as string);
      } catch {
        // A header undici refuses (never produced by node's parser in practice) is dropped.
      }
    }

    const overflow = () => {
      if (!controller.signal.aborted) controller.abort(new BodyTooLargeError(`body exceeds ${cap} bytes`));
      void answer(bridgeError('payload_too_large', 413));
    };
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const init: RequestInit & { duplex?: 'half' } = { method, headers, signal: controller.signal };
    if (hasBody) {
      init.body = bodyStream(req, cap, overflow);
      init.duplex = 'half';
    }

    let request: Request;
    try {
      request = new Request(url.href, init);
    } catch {
      await answer(bridgeError('bad_request', 400));
      return;
    }

    let response: Response;
    try {
      response = await options.handler(request, {
        peer: req.socket.remoteAddress,
        rawTarget,
        signal: controller.signal,
      });
    } catch (error) {
      response = toErrorResponse(error, newRequestId(random));
    }
    if (!(response instanceof Response))
      response = toErrorResponse(new TypeError('handler result'), newRequestId(random));
    await answer(response);
  }

  return {
    server,
    get address() {
      return bound;
    },
    async start() {
      const target = options.listen;
      if (!('fd' in target) && !isLoopbackAddress(target.host)) {
        throw new ListenConfigError('ATMUSIC_LISTEN', 'only loopback addresses (127.0.0.0/8 or ::1) may be bound');
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        if ('fd' in target) server.listen({ fd: target.fd });
        else server.listen({ host: target.host, port: target.port, exclusive: true });
      });
      const address = server.address();
      if (address === null || typeof address === 'string' || !isLoopbackAddress((address as AddressInfo).address)) {
        await closeServer(server);
        throw new ListenConfigError(
          'fd' in target ? 'LISTEN_FDS' : 'ATMUSIC_LISTEN',
          'the listening socket is not bound to a loopback address',
        );
      }
      const host = address.address.toLowerCase().startsWith('::ffff:') ? address.address.slice(7) : address.address;
      bound = { host, port: address.port, authority: authorityOf(host, address.port) };
      return bound;
    },
    async close() {
      for (const controller of inFlight) controller.abort(new DOMException('The server is closing.', 'AbortError'));
      await closeServer(server);
    },
  };
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    server.closeAllConnections();
    return;
  }
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

/** The request body as a stream, capped (module comment). */
function bodyStream(req: http.IncomingMessage, cap: number, onOverflow: () => void): ReadableStream<Uint8Array> {
  let total = 0;
  let finished = false;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        req.pause();
        req.on('data', (chunk: Buffer) => {
          if (finished) return;
          total += chunk.byteLength;
          if (total > cap) {
            finished = true;
            req.pause();
            controller.error(new BodyTooLargeError(`body exceeds ${cap} bytes`));
            onOverflow();
            return;
          }
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 0) <= 0) req.pause();
        });
        req.on('end', () => {
          if (finished) return;
          finished = true;
          controller.close();
        });
        req.on('error', (error) => {
          if (finished) return;
          finished = true;
          controller.error(error);
        });
      },
      pull() {
        if (!finished) req.resume();
      },
      cancel() {
        finished = true;
        req.pause();
      },
    },
    { highWaterMark: 1 },
  );
}

const NO_BODY_STATUS = new Set([101, 204, 205, 304]);

async function writeResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  response: Response,
): Promise<void> {
  if (res.destroyed || res.headersSent) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  res.statusCode = response.status;
  if (response.statusText !== '') res.statusMessage = response.statusText;
  const cookies = response.headers.getSetCookie();
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie') continue;
    res.setHeader(name, value);
  }
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  // Unread request bytes must never be parsed as the next request.
  if (!req.complete) res.setHeader('connection', 'close');

  const body = response.body;
  if (body === null || method === 'HEAD' || NO_BODY_STATUS.has(response.status)) {
    await body?.cancel().catch(() => undefined);
    res.end();
    return;
  }
  const reader = body.getReader();
  const closed = new Promise<'closed'>((resolve) => res.once('close', () => resolve('closed')));
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), closed]);
      if (next === 'closed') {
        await reader.cancel().catch(() => undefined);
        return;
      }
      if (next.done) break;
      if (!res.write(next.value)) {
        const drained = await Promise.race([once(res, 'drain').then(() => 'drained' as const), closed]);
        if (drained === 'closed') {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
    res.end();
  } catch {
    // The handler's body stream failed mid-response: the status is already
    // sent, so the only honest signal left is an aborted connection.
    await reader.cancel().catch(() => undefined);
    res.destroy();
  }
}
