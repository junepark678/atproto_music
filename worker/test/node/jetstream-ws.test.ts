// N1-04 (ADR 0005 §3.4, §15.2 loopback exception): the `ws` Jetstream
// connector against our own loopback servers on 127.0.0.1 port 0. Nothing
// here reaches a real network: every server is created by the test and
// closed in afterEach. No test sleeps; each waits on a socket event.

import { once } from 'node:events';
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { buildSubscribeUrl } from '@atmusic/atproto/jetstream/events';
import { afterEach, expect, it } from 'vitest';
import WebSocket, { type ClientOptions, WebSocketServer } from 'ws';
import { CONNECT_TIMEOUT_MS, JetstreamConnectError, type LinkEvent } from '../../src/do/ingest/jetstream-socket';
import { connectJetstreamWs, createJetstreamWsConnector, MAX_PAYLOAD_BYTES } from '../../src/node/jetstream-ws';

const COLLECTIONS = ['com.example.atmusic.scrobble', 'com.example.atmusic.follow'];

// TEST-ONLY self-signed P-256 certificate for 127.0.0.1 (valid 2026-10-25 to
// 2126-10-01). It is trusted by nothing: the TLS test proves the connector
// refuses it even when NODE_TLS_REJECT_UNAUTHORIZED=0 would accept it.
const TEST_ONLY_TLS_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg93MaalmLVOBfgluZ',
  'ZfQLIZXvHoRWebN47EqmR02buY+hRANCAART9ENno/T0gtlaXAbOJgpIM8PslMAa',
  'KUFAYenKEVNTRUe9EJOdOp40nKJGovPfNYb7eDFJoKVcLm7AKWKTWvMR',
  '-----END PRIVATE KEY-----',
].join('\n');
const TEST_ONLY_TLS_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBjzCCATagAwIBAgIUSbSZju2wwTAOeRtEcwQFOZwM7M0wCgYIKoZIzj0EAwIw',
  'FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAyNTE1MTYyNloYDzIxMjYxMDAx',
  'MTUxNjI2WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO',
  'PQMBBwNCAART9ENno/T0gtlaXAbOJgpIM8PslMAaKUFAYenKEVNTRUe9EJOdOp40',
  'nKJGovPfNYb7eDFJoKVcLm7AKWKTWvMRo2QwYjAdBgNVHQ4EFgQUzBK8Zq5IOOjE',
  '707ptrl+6dLPnM0wHwYDVR0jBBgwFoAUzBK8Zq5IOOjE707ptrl+6dLPnM0wDwYD',
  'VR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMAoGCCqGSM49BAMCA0cAMEQC',
  'IDLQq4EB+sMnwACDX8gogHUCj5R6haUo2IKvxG5Bq2msAiATzi60bXcw+Zo28hB+',
  'ZGvIrY+aAM+3c+7IXqvmtDlg8A==',
  '-----END CERTIFICATE-----',
].join('\n');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function listen(server: HttpServer | NetServer): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

interface Accepted {
  ws: WebSocket;
  req: IncomingMessage;
  socket: Duplex;
}

/** A loopback Jetstream: an HTTP(S) server whose upgrades are answered by `onUpgrade` (default: accept). */
async function loopbackJetstream(
  o: {
    tls?: boolean;
    onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer, accept: () => void) => void;
  } = {},
) {
  const server = o.tls
    ? createHttpsServer({ key: TEST_ONLY_TLS_KEY, cert: TEST_ONLY_TLS_CERT })
    : createHttpServer((_req, res) => res.writeHead(426).end());
  const wss = new WebSocketServer({ noServer: true });
  const accepted: Accepted[] = [];
  const upgrades: IncomingMessage[] = [];
  const waiting: Array<(a: Accepted) => void> = [];
  const sockets = new Set<Socket>();
  let tcpConnections = 0;
  server.on('connection', (s: Socket) => {
    tcpConnections += 1;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrades.push(req);
    const accept = () =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        const a = { ws, req, socket };
        accepted.push(a);
        waiting.shift()?.(a);
      });
    if (o.onUpgrade) o.onUpgrade(req, socket, head, accept);
    else accept();
  });
  const port = await listen(server);
  cleanups.push(async () => {
    for (const c of wss.clients) c.terminate();
    for (const s of sockets) s.destroy();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const scheme = o.tls ? 'https' : 'http';
  return {
    port,
    origin: `${o.tls ? 'wss' : 'ws'}://127.0.0.1:${port}`,
    /** A subscribe URL as buildSubscribeUrl makes it, on this server. */
    subscribeUrl: (cursor?: number) =>
      buildSubscribeUrl(`https://127.0.0.1:${port}`, COLLECTIONS, cursor).replace(/^https:/, `${scheme}:`),
    accepted,
    upgrades,
    tcpConnections: () => tcpConnections,
    /** The next accepted server-side socket. */
    nextAccepted: () =>
      new Promise<Accepted>((resolve) => {
        waiting.push(resolve);
      }),
  };
}

/** A sink that records link events and resolves `until(pred)` when the predicate holds. */
function recorder() {
  const events: LinkEvent[] = [];
  const waiters: Array<{ pred: () => boolean; resolve: () => void }> = [];
  const check = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred()) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  };
  return {
    events,
    sink: (e: LinkEvent) => {
      events.push(e);
      check();
    },
    until: (pred: () => boolean) =>
      new Promise<void>((resolve) => {
        if (pred()) resolve();
        else waiters.push({ pred, resolve });
      }),
  };
}

/** A `ws` constructor that records the options each client is created with (and otherwise is `ws`). */
function recordingCtor() {
  const created: Array<{ address: string; options: ClientOptions }> = [];
  class Recording extends WebSocket {
    constructor(address: string, options: ClientOptions) {
      created.push({ address, options });
      super(address, options);
    }
  }
  return { created, Ctor: Recording };
}

it('frames from a loopback ws server on port 0 arrive as LinkEvents in order, buffered until start()', async () => {
  const js = await loopbackJetstream();
  const serverSide = js.nextAccepted();
  const url = js.subscribeUrl(42);
  const connect = createJetstreamWsConnector({ jetstreamUrls: [js.origin] });
  const link = await connect(url);
  expect(link.url).toBe(url);
  const { ws: server, req } = await serverSide;

  // The https→wss style mapping kept the path and query; no compression was offered.
  expect(req.url).toBe(url.slice(`http://127.0.0.1:${js.port}`.length));
  expect(new URL(url).searchParams.get('cursor')).toBe('42');
  expect(req.headers['sec-websocket-extensions']).toBeUndefined();

  // Three frames, then a ping. The client answers the ping only after it has
  // parsed every frame before it, so at the pong all three were received by
  // the link while no one had started it.
  const binary = Uint8Array.from([0, 1, 2, 254, 255]);
  server.send('{"seq":1}');
  server.send(binary, { binary: true });
  server.send('{"seq":3,"name":"Jóga"}');
  const pong = once(server, 'pong');
  server.ping();
  await pong;

  const r = recorder();
  link.start(r.sink);
  // Delivered synchronously inside start(), in order, from the buffer.
  expect(r.events).toHaveLength(3);
  expect(r.events[0]).toEqual({ type: 'message', data: '{"seq":1}' });
  const second = r.events[1] as { type: 'message'; data: ArrayBuffer };
  expect(second.type).toBe('message');
  expect(second.data).toBeInstanceOf(ArrayBuffer);
  expect(second.data.byteLength).toBe(5);
  expect([...new Uint8Array(second.data)]).toEqual([...binary]);
  expect(r.events[2]).toEqual({ type: 'message', data: '{"seq":3,"name":"Jóga"}' });
  expect(() => link.start(() => {})).toThrow('already started');

  // After start(), frames are delivered live.
  server.send('{"seq":4}');
  await r.until(() => r.events.length === 4);
  expect(r.events[3]).toEqual({ type: 'message', data: '{"seq":4}' });
  expect(js.accepted).toHaveLength(1);
  link.close();
});

it('a 400 handshake with {"error":"OutdatedCursor"} rejects with JetstreamConnectError status 400 and cursorRejected true', async () => {
  const refusal = (status: number, contentType: string, body: string) => (socket: Duplex) => {
    socket.end(
      `HTTP/1.1 ${status} Refused\r\nContent-Type: ${contentType}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  };
  const outdated = refusal(
    400,
    'application/json',
    JSON.stringify({ error: 'OutdatedCursor', message: 'cursor is older than the lookback' }),
  );
  const js = await loopbackJetstream({ onUpgrade: (_req, socket) => outdated(socket) });
  const url = js.subscribeUrl(7);
  const err = await connectJetstreamWs(url, { jetstreamUrls: [js.origin] }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(JetstreamConnectError);
  expect(err).toMatchObject({ status: 400, error: 'OutdatedCursor', cursorRejected: true });
  expect(js.upgrades).toHaveLength(1);
  expect(new URL(js.upgrades[0]!.url!, 'http://x').searchParams.get('cursor')).toBe('7');
  expect(js.accepted).toHaveLength(0);

  // A refusal without a cursor error name is not a rejected cursor.
  const busy = refusal(503, 'text/plain', 'try later');
  const js2 = await loopbackJetstream({ onUpgrade: (_req, socket) => busy(socket) });
  const err2 = await connectJetstreamWs(js2.subscribeUrl(7), { jetstreamUrls: [js2.origin] }).catch((e: unknown) => e);
  expect(err2).toBeInstanceOf(JetstreamConnectError);
  expect(err2).toMatchObject({ status: 503, error: null, cursorRejected: false });
});

it('a frame above maxPayload closes the link with 1009 and is never delivered', async () => {
  expect(MAX_PAYLOAD_BYTES).toBe(1024 * 1024);
  const js = await loopbackJetstream();
  const serverSide = js.nextAccepted();
  const link = await connectJetstreamWs(js.subscribeUrl(), { jetstreamUrls: [js.origin] });
  const { ws: server } = await serverSide;
  const r = recorder();
  link.start(r.sink);
  const serverClosed = once(server, 'close') as Promise<[number, Buffer]>;

  server.send('a'.repeat(MAX_PAYLOAD_BYTES)); // exactly the limit: delivered
  server.send('b'.repeat(MAX_PAYLOAD_BYTES + 1)); // one byte over: refused
  server.send('{"after":true}'); // never read
  await r.until(() => r.events.some((e) => e.type === 'close'));

  const messages = r.events.filter((e): e is Extract<LinkEvent, { type: 'message' }> => e.type === 'message');
  expect(messages).toHaveLength(1);
  expect((messages[0]!.data as string).length).toBe(MAX_PAYLOAD_BYTES);
  expect((messages[0]!.data as string)[0]).toBe('a');
  const ends = r.events.filter((e) => e.type !== 'message');
  expect(ends).toHaveLength(2);
  expect(ends[0]).toMatchObject({ type: 'error', message: expect.stringMatching(/max payload/i) });
  expect(ends[1]).toMatchObject({ type: 'close', code: 1009 });
  // The close frame the server received carries 1009 as well.
  const [code] = await serverClosed;
  expect(code).toBe(1009);
});

it('close(1000) sends a close frame; a dropped TCP connection surfaces close code 1006', async () => {
  const js = await loopbackJetstream();
  const connect = createJetstreamWsConnector({ jetstreamUrls: [js.origin] });

  // Our close: the server receives a close frame with 1000; the link sees the echo.
  let serverSide = js.nextAccepted();
  const link = await connect(js.subscribeUrl());
  const first = await serverSide;
  const r = recorder();
  link.start(r.sink);
  const serverClosed = once(first.ws, 'close') as Promise<[number, Buffer]>;
  link.close(1000);
  const [code, reason] = await serverClosed;
  expect(code).toBe(1000);
  expect(reason.toString()).toBe('');
  await r.until(() => r.events.length === 1);
  expect(r.events).toEqual([{ type: 'close', code: 1000, reason: '' }]);

  // A dropped TCP connection (no close frame): close code 1006, no error frame read.
  serverSide = js.nextAccepted();
  const link2 = await connect(js.subscribeUrl());
  const second = await serverSide;
  const r2 = recorder();
  link2.start(r2.sink);
  second.socket.destroy();
  await r2.until(() => r2.events.some((e) => e.type === 'close'));
  expect(r2.events.filter((e) => e.type === 'close')).toEqual([{ type: 'close', code: 1006, reason: '' }]);
  expect(r2.events.filter((e) => e.type === 'message')).toEqual([]);
});

it('a URL whose host is not in JETSTREAM_URLS is refused before any connection attempt', async () => {
  // A raw TCP listener counts every connection attempt made to it.
  let attempts = 0;
  const tcp = createNetServer((s) => {
    attempts += 1;
    s.destroy();
  });
  const port = await listen(tcp);
  cleanups.push(() => new Promise<void>((resolve) => tcp.close(() => resolve())));
  const rec = recordingCtor();
  const subscribe = (origin: string) =>
    buildSubscribeUrl('https://jetstream.example.test', COLLECTIONS, 5).replace(
      'https://jetstream.example.test',
      origin,
    );
  const refused = [
    // Another port on the same host.
    { url: subscribe(`http://127.0.0.1:${port}`), allowed: [`ws://127.0.0.1:${port + 1}`] },
    // Another host on the same port.
    { url: subscribe(`http://127.0.0.1:${port}`), allowed: [`ws://localhost:${port}`] },
    // Nothing configured.
    { url: subscribe(`http://127.0.0.1:${port}`), allowed: [] },
    // A production-shaped list that does not name the host.
    { url: subscribe('https://jetstream.evil.example'), allowed: ['wss://jetstream1.us-east.bsky.network'] },
    // Plaintext to a non-loopback host, even if listed.
    { url: subscribe('http://jetstream.example.test'), allowed: ['ws://jetstream.example.test'] },
    // Not a websocket scheme.
    { url: subscribe('ftp://127.0.0.1'), allowed: ['ftp://127.0.0.1'] },
    // Credentials in the URL.
    { url: subscribe(`http://user:pw@127.0.0.1:${port}`), allowed: [`ws://127.0.0.1:${port}`] },
  ];
  for (const c of refused) {
    const err = await connectJetstreamWs(c.url, { jetstreamUrls: c.allowed, WebSocket: rec.Ctor }).catch(
      (e: unknown) => e,
    );
    expect(err, c.url).toBeInstanceOf(JetstreamConnectError);
    expect(err, c.url).toMatchObject({ status: null, error: null, cursorRejected: false });
    expect((err as Error).message).toMatch(/^jetstream connect refused: /);
  }
  expect(rec.created).toHaveLength(0);

  // Positive control: the same listener, once listed, is dialled (the TCP
  // connection arrives, the handshake then fails because it is not a ws server).
  const arrived = once(tcp, 'connection');
  const err = await connectJetstreamWs(subscribe(`http://127.0.0.1:${port}`), {
    jetstreamUrls: [`ws://127.0.0.1:${port}`],
    WebSocket: rec.Ctor,
  }).catch((e: unknown) => e);
  await arrived;
  expect(err).toBeInstanceOf(JetstreamConnectError);
  expect(err).toMatchObject({ status: null });
  expect((err as Error).message).toMatch(/^jetstream connect failed: /);
  expect(rec.created.map((c) => c.address)).toEqual([subscribe(`ws://127.0.0.1:${port}`)]);
  expect(attempts).toBe(1);
});

it('the ws client is created with rejectUnauthorized true even when NODE_TLS_REJECT_UNAUTHORIZED=0 is set in the test process', async () => {
  const js = await loopbackJetstream({ tls: true });
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    // Control: with the variable set, a `ws` client created without the
    // option accepts the untrusted certificate and completes the upgrade.
    const controlAccepted = js.nextAccepted();
    const control = new WebSocket(`${js.origin}/xrpc/network.bsky.jetstream.subscribeEvents`);
    await once(control, 'open');
    await controlAccepted;
    control.terminate();
    expect(js.upgrades).toHaveLength(1);

    // The connector creates its client with rejectUnauthorized: true (and the
    // other §3.4 options), so the same certificate is refused at TLS: no
    // upgrade request reaches the server.
    const rec = recordingCtor();
    const url = js.subscribeUrl(9);
    expect(url.startsWith(`https://127.0.0.1:${js.port}/`)).toBe(true);
    const err = await connectJetstreamWs(url, { jetstreamUrls: [js.origin], WebSocket: rec.Ctor }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JetstreamConnectError);
    expect(err).toMatchObject({ status: null, error: null });
    expect((err as Error).message).toMatch(/self[- ]signed certificate/i);
    expect(rec.created).toHaveLength(1);
    expect(rec.created[0]!.address).toBe(url.replace(/^https:/, 'wss:'));
    expect(rec.created[0]!.options).toMatchObject({
      rejectUnauthorized: true,
      perMessageDeflate: false,
      maxPayload: MAX_PAYLOAD_BYTES,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      followRedirects: false,
    });
    expect(CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(js.upgrades).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});
