// The Jetstream connector on Node (ADR 0005 §3.4, N1-04), over the `ws`
// package. Node's `fetch` refuses `Upgrade`, and the global WebSocket hides
// the handshake status, so `ws` is used: its `unexpected-response` event gives
// the refusal's status and body, which keeps `JetstreamConnectError` and its
// `cursorRejected` (a 400 `{"error":"OutdatedCursor"}`) working exactly as the
// Workers connector does (worker/src/do/ingest/jetstream-socket.ts). The
// ingest socket's `connect` / `socketWatchdog` take this connector unchanged.
//
// - URL. The subscribe URL is `https://host/xrpc/…` (`buildSubscribeUrl`);
//   `https:` maps to `wss:` (and `http:` to `ws:`, which is dialled only to a
//   loopback host: JETSTREAM_URLS itself only admits wss://, config.ts).
// - Allow-list. Only an origin listed in `jetstreamUrls` (JETSTREAM_URLS,
//   after the same https→wss mapping) is dialled. Anything else is refused
//   with JetstreamConnectError(null, …) before any socket is created.
// - Options. `perMessageDeflate: false`; `maxPayload: 1 MiB` (the 64 KiB
//   event parser bound in jetstream.ts and its counter are unchanged); a 10 s
//   handshake timeout (CONNECT_TIMEOUT_MS) that also bounds reading a refusal
//   body; no redirects; and `rejectUnauthorized: true` passed explicitly, so no
//   environment default (NODE_TLS_REJECT_UNAUTHORIZED=0) can disable
//   certificate checks (ADR §14.1, §20.4 item 16).
// - Refusals. A non-101 answer rejects with JetstreamConnectError(status, the
//   XRPC `error` name from the first 4 KiB of the body, …). A network failure
//   or timeout before the upgrade rejects with status null.
// - Events. Text frames become string `LinkEvent`s, binary frames an
//   `ArrayBuffer` of exactly the frame's bytes. Events are buffered from the
//   moment the socket exists until `start()`, as `linkOf` does, so nothing is
//   lost between the upgrade and listener registration.
// - Ending. `close(code = 1000)` sends a close frame (SIGTERM uses 1000). A
//   protocol violation by the server (a frame above maxPayload, invalid UTF-8,
//   a malformed frame) is delivered as an `error` event and then a `close`
//   with the code `ws` sent (1009, 1007, 1002), and the offending frame is
//   never delivered. A dropped TCP connection surfaces as close code 1006.

import type { ClientRequest, IncomingMessage } from 'node:http';
import WebSocket, { type ClientOptions } from 'ws';
import {
  CONNECT_TIMEOUT_MS,
  type ConnectJetstream,
  JetstreamConnectError,
  type JetstreamLink,
  type LinkEvent,
} from '../do/ingest/jetstream-socket';

/** Largest frame accepted from Jetstream (1 MiB); a larger one closes the link with 1009. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
const ERROR_BODY_LIMIT = 4096;

/** The `ws` client constructor (injectable so tests can observe the options it is created with). */
export type WsClientCtor = new (address: string, options: ClientOptions) => WebSocket;

export interface JetstreamWsOptions {
  /** JETSTREAM_URLS (`wss://host` origins). Only these origins are dialled. */
  jetstreamUrls: readonly string[];
  /** Handshake deadline. Default CONNECT_TIMEOUT_MS (10 s). */
  handshakeTimeoutMs?: number;
  /** Defaults to the `ws` package's WebSocket. */
  WebSocket?: WsClientCtor;
}

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** `https:`→`wss:`, `http:`→`ws:`; other schemes are kept (and refused by the caller unless ws/wss). */
function toWsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  return u;
}

function originOf(u: URL): string {
  return `${u.protocol}//${u.host}`.toLowerCase();
}

/** The dialable `ws:`/`wss:` URL for `url`, or the reason it is refused. */
export function jetstreamWsTarget(
  url: string,
  jetstreamUrls: readonly string[],
): { ok: true; url: URL } | { ok: false; reason: string } {
  const target = toWsUrl(url);
  if (target === null) return { ok: false, reason: 'invalid URL' };
  if (target.protocol !== 'wss:' && target.protocol !== 'ws:')
    return { ok: false, reason: `scheme ${target.protocol}` };
  if (target.protocol === 'ws:' && !LOOPBACK.test(target.hostname)) {
    return { ok: false, reason: 'plaintext ws:// only to a loopback host' };
  }
  if (target.username !== '' || target.password !== '') return { ok: false, reason: 'credentials in URL' };
  const allowed = new Set<string>();
  for (const entry of jetstreamUrls) {
    const u = toWsUrl(entry);
    if (u !== null) allowed.add(originOf(u));
  }
  if (!allowed.has(originOf(target))) return { ok: false, reason: `${target.host} is not in JETSTREAM_URLS` };
  return { ok: true, url: target };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}

/** The exact bytes of a `ws` message payload as an ArrayBuffer. */
function toArrayBuffer(data: WebSocket.RawData): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data.slice(0);
  const parts = Array.isArray(data) ? data : [data];
  const total = parts.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.byteLength;
  }
  return out.buffer;
}

/** A text frame's payload (UTF-8, already validated by `ws`). */
function toText(data: WebSocket.RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return (Array.isArray(data) ? Buffer.concat(data) : data).toString('utf8');
}

/** The close code `ws` sends for a server protocol violation (its receiver error codes). */
function protocolCloseCode(error: Error): number | null {
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== 'string' || !code.startsWith('WS_ERR_')) return null;
  if (code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') return 1009;
  if (code === 'WS_ERR_INVALID_UTF8') return 1007;
  return 1002;
}

/** The XRPC `error` name of a refusal body (first 4 KiB), or null. */
function readErrorName(res: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      res.removeAllListeners('data');
      const text = Buffer.concat(chunks).subarray(0, ERROR_BODY_LIMIT).toString('utf8');
      try {
        const body = JSON.parse(text) as { error?: unknown };
        resolve(typeof body.error === 'string' ? body.error.slice(0, 100) : null);
      } catch {
        resolve(null);
      }
    };
    res.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size >= ERROR_BODY_LIMIT) finish();
    });
    res.on('end', finish);
    res.on('close', finish);
    res.on('error', finish);
  });
}

/**
 * Dial `url` (an `https://` subscribe URL or its `wss://` form) and resolve
 * with a buffered JetstreamLink once the upgrade succeeds.
 */
export function connectJetstreamWs(url: string, opts: JetstreamWsOptions): Promise<JetstreamLink> {
  const target = jetstreamWsTarget(url, opts.jetstreamUrls);
  if (!target.ok) {
    return Promise.reject(
      new JetstreamConnectError(null, null, `jetstream connect refused: ${hostOf(url)}: ${target.reason}`),
    );
  }
  const timeoutMs = opts.handshakeTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const Ctor: WsClientCtor = opts.WebSocket ?? WebSocket;

  return new Promise<JetstreamLink>((resolve, reject) => {
    let settled = false;
    let opened = false;
    let ws: WebSocket;
    try {
      ws = new Ctor(target.url.toString(), {
        perMessageDeflate: false,
        maxPayload: MAX_PAYLOAD_BYTES,
        handshakeTimeout: timeoutMs,
        rejectUnauthorized: true,
        followRedirects: false,
      });
    } catch (error) {
      reject(new JetstreamConnectError(null, null, `jetstream connect failed: ${String(error)}`));
      return;
    }

    const queue: LinkEvent[] = [];
    let sink: ((e: LinkEvent) => void) | null = null;
    const deliver = (e: LinkEvent) => {
      if (sink === null) queue.push(e);
      else sink(e);
    };
    let violation: { code: number; message: string } | null = null;

    // The whole connect (handshake and reading a refusal body) is bounded.
    const deadline = setTimeout(() => {
      fail(new JetstreamConnectError(null, null, 'jetstream connect timed out'));
      ws.terminate();
    }, timeoutMs);
    const fail = (error: JetstreamConnectError) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error);
    };

    ws.on('unexpected-response', (req: ClientRequest, res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      void readErrorName(res).then((name) => {
        fail(new JetstreamConnectError(status, name, `jetstream refused the upgrade: ${status} ${name ?? ''}`));
        req.destroy();
        ws.terminate();
      });
    });

    ws.on('open', () => {
      if (settled) {
        ws.terminate();
        return;
      }
      settled = true;
      opened = true;
      clearTimeout(deadline);
      resolve({
        url,
        start(onEvent) {
          if (sink !== null) throw new Error('JetstreamLink already started');
          sink = onEvent;
          for (const e of queue.splice(0)) onEvent(e);
        },
        close(code = 1000, reason = '') {
          try {
            ws.close(code, reason);
          } catch {
            // already closing or closed, or a code `ws` refuses
            ws.terminate();
          }
        },
      });
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!opened) return;
      deliver({ type: 'message', data: isBinary ? toArrayBuffer(data) : toText(data) });
    });

    ws.on('error', (error: Error) => {
      if (!opened) {
        fail(new JetstreamConnectError(null, null, `jetstream connect failed: ${error.message}`));
        return;
      }
      const code = protocolCloseCode(error);
      if (code !== null) violation = { code, message: error.message };
      deliver({ type: 'error', message: error.message });
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (!opened) {
        fail(new JetstreamConnectError(null, null, `jetstream connect failed: closed with ${code}`));
        return;
      }
      // After a protocol violation the close code is the one we sent; `ws`
      // stops reading at the violation, so the server's echo is never parsed.
      if (violation !== null) deliver({ type: 'close', code: violation.code, reason: violation.message });
      else deliver({ type: 'close', code, reason: reason.toString('utf8') });
    });
  });
}

/** The connector for `connect(m, connectJetstream, now)` over JETSTREAM_URLS. */
export function createJetstreamWsConnector(opts: JetstreamWsOptions): ConnectJetstream {
  return (url: string) => connectJetstreamWs(url, opts);
}
