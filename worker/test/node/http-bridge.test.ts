// The Node HTTP listener (ADR 0005 §3.6; N1-06): the WHATWG bridge over
// node:http on an ephemeral loopback port. Requests are written as raw bytes,
// so the request target, Host and body framing are exactly what a client
// (or a DNS-rebinding page, or a tunnel) sends.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seededRandom } from '@atmusic/core/test-support/random';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { UUID_PATTERN } from '../../src/http/request-id';
import {
  BODY_CAPS,
  type BodyPolicy,
  type BridgeHandler,
  type BridgeServer,
  bodyCapFor,
  bodyPolicyFor,
  createServer,
  DEFAULT_LISTEN,
  envelopePolicy,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  LASTFM_BODY_TOO_LARGE,
  LISTENBRAINZ_PAYLOAD_TOO_LARGE,
  ListenConfigError,
  parseListen,
  REQUEST_TIMEOUT_MS,
  socketActivation,
} from '../../src/node/http-bridge';

const ORIGIN = 'https://music.example.test';
const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const servers: BridgeServer[] = [];
const netServers: NetServer[] = [];
const sockets: Socket[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await server.close();
  for (const server of netServers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(
  handler: BridgeHandler,
  extra: { caps?: (p: string, m: string) => BodyPolicy; host?: string } = {},
) {
  const bridge = createServer({
    publicOrigin: ORIGIN,
    listen: { host: extra.host ?? '127.0.0.1', port: 0 },
    handler,
    caps: extra.caps,
    random: seededRandom(11),
  });
  servers.push(bridge);
  const address = await bridge.start();
  return { bridge, ...address };
}

/** A raw client: write bytes at will; `text` resolves with everything received once the server closes. */
function rawClient(port: number, host = '127.0.0.1') {
  const socket = connect({ host, port });
  sockets.push(socket);
  let received = '';
  const waiters: { pattern: RegExp; resolve: (text: string) => void }[] = [];
  socket.setEncoding('latin1');
  socket.on('data', (chunk: string) => {
    received += chunk;
    for (const w of waiters.splice(0)) {
      if (w.pattern.test(received)) w.resolve(received);
      else waiters.push(w);
    }
  });
  const ended = new Promise<string>((resolve) => {
    socket.on('end', () => resolve(received));
    socket.on('close', () => resolve(received));
  });
  socket.on('error', () => undefined);
  const connected = new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  return {
    socket,
    async write(bytes: string) {
      await connected;
      await new Promise<void>((resolve, reject) => socket.write(bytes, 'latin1', (e) => (e ? reject(e) : resolve())));
    },
    /** Resolves as soon as the received text matches. */
    until(pattern: RegExp) {
      if (pattern.test(received)) return Promise.resolve(received);
      return new Promise<string>((resolve) => waiters.push({ pattern, resolve }));
    },
    ended,
    received: () => received,
  };
}

/** One request on its own connection (`Connection: close`), answered in full. */
async function exchange(port: number, bytes: string, host = '127.0.0.1'): Promise<string> {
  const client = rawClient(port, host);
  await client.write(bytes);
  return client.ended;
}

function parseResponse(text: string): { status: number; headers: Record<string, string>; body: string } {
  const split = text.indexOf('\r\n\r\n');
  const head = text.slice(0, split).split('\r\n');
  const status = Number((head[0] ?? '').split(' ')[1]);
  const headers: Record<string, string> = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  let body = text.slice(split + 4);
  if (headers['transfer-encoding'] === 'chunked') {
    let out = '';
    for (;;) {
      const eol = body.indexOf('\r\n');
      const size = Number.parseInt(body.slice(0, eol), 16);
      if (!size) break;
      out += body.slice(eol + 2, eol + 2 + size);
      body = body.slice(eol + 2 + size + 2);
    }
    body = out;
  }
  return { status, headers, body };
}

describe('HTTP bridge', () => {
  it('the handler sees PUBLIC_ORIGIN + raw path; Host, X-Forwarded-Host and X-Forwarded-Proto never change request.url', async () => {
    const seen: { url: string; rawTarget: string; headers: Record<string, string>; peer: string | undefined }[] = [];
    const { port, authority } = await start((request, info) => {
      seen.push({
        url: request.url,
        rawTarget: info.rawTarget,
        headers: Object.fromEntries(request.headers),
        peer: info.peer,
      });
      return new Response('ok');
    });

    const path =
      '/api/v1/scrobbles/at%3A%2F%2Fdid%3Aplc%3Aabc%2Fcom.example.atmusic.scrobble%2F3k?limit=5&cursor=a%2Bb~';
    const forged =
      'X-Forwarded-Host: evil.example\r\nX-Forwarded-Proto: http\r\nForwarded: host=evil.example;proto=http\r\n';
    const cases: [string, string][] = [
      // Host is the public host, or the listen address: the URL is the same.
      [`GET ${path} HTTP/1.1\r\nHost: music.example.test\r\n${forged}`, `${ORIGIN}${path}`],
      [`GET ${path} HTTP/1.1\r\nHost: ${authority}\r\n${forged}`, `${ORIGIN}${path}`],
      [`GET ${path} HTTP/1.1\r\nHost: MUSIC.example.test:443\r\n`, `${ORIGIN}${path}`],
      // A target that a naive `new URL(target, base)` would read as another host.
      [`GET //evil.example/x?y=1 HTTP/1.1\r\nHost: ${authority}\r\n`, `${ORIGIN}//evil.example/x?y=1`],
      // The absolute form keeps only its path and query.
      [`GET http://evil.example:9/api/v1/meta?q=%20 HTTP/1.1\r\nHost: ${authority}\r\n`, `${ORIGIN}/api/v1/meta?q=%20`],
      [
        `GET /2.0/?method=track.scrobble&api_key=k HTTP/1.1\r\nHost: music.example.test\r\n`,
        `${ORIGIN}/2.0/?method=track.scrobble&api_key=k`,
      ],
    ];
    for (const [head, url] of cases) {
      const response = parseResponse(
        await exchange(
          port,
          `${head}X-Atmusic-Client-Ip: 198.51.100.9\r\nx-atmusic-anything: 1\r\nConnection: close\r\n\r\n`,
        ),
      );
      expect(response.status, head).toBe(200);
      expect(response.body).toBe('ok');
      const last = seen[seen.length - 1]!;
      expect(last.url, head).toBe(url);
      expect(new URL(last.url).origin).toBe(ORIGIN);
      // Inbound x-atmusic-* headers never reach the handler; the forwarded ones arrive untouched as data.
      expect(
        Object.keys(last.headers).filter((h) => h.startsWith('x-atmusic-')),
        head,
      ).toEqual([]);
      expect(last.peer).toBe('127.0.0.1');
    }
    expect(seen).toHaveLength(cases.length);
    expect(seen[0]!.headers['x-forwarded-host']).toBe('evil.example');
    expect(seen[0]!.rawTarget).toBe(path);
    expect(seen[4]!.rawTarget).toBe('/api/v1/meta?q=%20');
    // `OPTIONS *` has no origin-form path: 400 envelope, handler not called.
    const star = parseResponse(
      await exchange(port, `OPTIONS * HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`),
    );
    expect(star.status).toBe(400);
    expect(JSON.parse(star.body).error.code).toBe('bad_request');
    expect(seen).toHaveLength(cases.length);
  });

  it('a Host outside {public host, listen address} gets 421 misdirected_request', async () => {
    let calls = 0;
    const { port, authority } = await start(() => {
      calls++;
      return new Response('ok');
    });
    const otherPort = port === 65_535 ? port - 1 : port + 1;
    for (const host of [
      'evil.example',
      'music.example.test.evil.example',
      'localhost',
      `localhost:${port}`,
      `127.0.0.1:${otherPort}`,
      '127.0.0.1',
      'music.example.test:8443',
      `[::1]:${port}`,
    ]) {
      const response = parseResponse(
        await exchange(port, `GET /api/v1/meta HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
      );
      expect(response.status, host).toBe(421);
      expect(response.headers['content-type']).toBe('application/json');
      expect(response.headers['cache-control']).toBe('no-store');
      const body = JSON.parse(response.body) as { error: { code: string; message: string; requestId: string } };
      expect(body.error.code, host).toBe('misdirected_request');
      expect(body.error.message).toBe('This server does not serve the requested host.');
      expect(body.error.requestId).toMatch(UUID_PATTERN);
      expect(response.headers['x-request-id']).toBe(body.error.requestId);
      expect(response.body).not.toContain(host);
    }
    // HTTP/1.0 without any Host: 421 as well.
    const noHost = parseResponse(await exchange(port, 'GET /api/v1/meta HTTP/1.0\r\n\r\n'));
    expect(noHost.status).toBe(421);
    expect(calls).toBe(0);

    // The two allowed hosts reach the handler.
    for (const host of ['music.example.test', authority]) {
      const ok = parseResponse(await exchange(port, `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      expect(ok.status, host).toBe(200);
    }
    expect(calls).toBe(2);
  });

  it('a body over the route cap gets 413 after at most cap+1 bytes read; a client abort fires the handler AbortSignal', async () => {
    // The ADR table, as the production cap function.
    expect(bodyCapFor('/api/v1/notify', 'POST')).toBe(64 * 1024);
    expect(bodyCapFor('/2.0/', 'POST')).toBe(1024 * 1024);
    expect(bodyCapFor('/2.0', 'POST')).toBe(1024 * 1024);
    expect(bodyCapFor('/1/submit-listens', 'POST')).toBe(10_240_000);
    expect(bodyCapFor('/api/v1/imports/upload', 'POST')).toBe(64 * 1024 * 1024);
    expect(BODY_CAPS.default).toBe(65_536);

    const CAP = 16;
    const received: number[] = [];
    let handlerCalls = 0;
    let bodyError: unknown = null;
    let gotCap: () => void = () => undefined;
    const nextCapReached = () =>
      new Promise<void>((r) => {
        gotCap = r;
      });
    const signals: AbortSignal[] = [];
    let abortedHandler: (reason: unknown) => void = () => undefined;
    const handlerAborted = new Promise<unknown>((r) => {
      abortedHandler = r;
    });

    const { port, authority } = await start(
      async (request, info) => {
        handlerCalls++;
        signals.push(info.signal);
        const url = new URL(request.url);
        if (url.pathname === '/wait') {
          // Never answers on its own: only a disconnect ends it.
          await new Promise<void>((resolve) =>
            info.signal.addEventListener('abort', () => {
              abortedHandler(info.signal.reason);
              resolve();
            }),
          );
          return new Response('late');
        }
        let total = 0;
        const reader = request.body!.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            received.push(value.byteLength);
            if (total === CAP) gotCap();
          }
        } catch (error) {
          bodyError = error;
          return new Response('handler saw an error', { status: 400 });
        }
        return new Response(`read ${total}`);
      },
      { caps: (pathname) => envelopePolicy(pathname === '/small' ? CAP : BODY_CAPS.default) },
    );

    // Exactly the cap is accepted.
    const exact = parseResponse(
      await exchange(
        port,
        `POST /small HTTP/1.1\r\nHost: ${authority}\r\nContent-Length: ${CAP}\r\nConnection: close\r\n\r\n${'a'.repeat(CAP)}`,
      ),
    );
    expect(exact).toMatchObject({ status: 200, body: `read ${CAP}` });
    expect(handlerCalls).toBe(1);

    // A declared length over the cap: 413 before a single body byte is sent, handler never called.
    const declared = rawClient(port);
    await declared.write(`POST /small HTTP/1.1\r\nHost: ${authority}\r\nContent-Length: ${CAP + 1}\r\n\r\n`);
    const early = parseResponse(await declared.ended);
    expect(early.status).toBe(413);
    expect(early.headers.connection).toBe('close');
    const envelope = JSON.parse(early.body) as { error: { code: string; requestId: string } };
    expect(envelope.error.code).toBe('payload_too_large');
    expect(envelope.error.requestId).toMatch(UUID_PATTERN);
    expect(handlerCalls).toBe(1);

    // Chunked, no declared length: the cap's worth reaches the handler, and the
    // cap+1st byte draws the 413 while the client has not finished the body.
    received.length = 0;
    const capReached = nextCapReached();
    const chunked = rawClient(port);
    await chunked.write(`POST /small HTTP/1.1\r\nHost: ${authority}\r\nTransfer-Encoding: chunked\r\n\r\n`);
    await chunked.write(`${CAP.toString(16)}\r\n${'b'.repeat(CAP)}\r\n`);
    await capReached;
    expect(received.reduce((a, b) => a + b, 0)).toBe(CAP);
    expect(chunked.received()).toBe('');
    await chunked.write('1\r\nc\r\n');
    const late = parseResponse(await chunked.ended);
    expect(late.status).toBe(413);
    expect(JSON.parse(late.body).error.code).toBe('payload_too_large');
    // The handler never got more than the cap, its body stream failed, its signal aborted,
    // and its own later answer (400) was not what the client saw.
    expect(received.reduce((a, b) => a + b, 0)).toBe(CAP);
    expect((bodyError as Error).name).toBe('BodyTooLargeError');
    expect(signals[signals.length - 1]!.aborted).toBe(true);
    expect(handlerCalls).toBe(2);

    // A client that disconnects mid-request aborts the handler's signal (also request.signal).
    const waiting = rawClient(port);
    await waiting.write(`GET /wait HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    await expect.poll(() => handlerCalls).toBe(3);
    const signal = signals[signals.length - 1]!;
    expect(signal.aborted).toBe(false);
    waiting.socket.destroy();
    const reason = await handlerAborted;
    expect(signal.aborted).toBe(true);
    expect((reason as DOMException).name).toBe('AbortError');
  });

  it('over-cap answers follow the route protocol: /1/submit-listens runs the handler first (401 with zero body bytes read) and overflows into the verbatim ListenBrainz 400; /2.0 is Last.fm error 6; /api/v1 keeps the 413 envelope', {
    timeout: 30_000,
  }, async () => {
    // The production table: who pre-checks a declared length, and at what cap.
    expect(bodyPolicyFor('/1/submit-listens', 'POST')).toMatchObject({ limit: 10_240_000, precheckDeclared: false });
    expect(bodyPolicyFor('/1/delete-listen', 'POST')).toMatchObject({ limit: 65_536, precheckDeclared: true });
    expect(bodyPolicyFor('/2.0/', 'POST')).toMatchObject({ limit: 1_048_576, precheckDeclared: true });
    expect(bodyPolicyFor('/api/v1/notify', 'POST')).toMatchObject({ limit: 65_536, precheckDeclared: true });
    expect(LISTENBRAINZ_PAYLOAD_TOO_LARGE).toBe('Payload too large. Payload cannot exceed 10240000 bytes');

    const calls: { path: string; bytesAtEntry: number; bytesAtAnswer: number }[] = [];
    let handlerSawError: string | null = null;
    // The production policies (no `caps`): a stand-in for the routes' own token check.
    const { port, authority } = await start(async (request, info) => {
      const url = new URL(request.url);
      const entry = { path: url.pathname, bytesAtEntry: info.bodyBytesRead(), bytesAtAnswer: -1 };
      calls.push(entry);
      if (request.headers.get('authorization') !== 'Token good') {
        // A token lookup takes event-loop turns; the body must stay unread meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 50));
        entry.bytesAtAnswer = info.bodyBytesRead();
        return Response.json({ code: 401, error: 'Invalid authorization token.' }, { status: 401 });
      }
      try {
        await request.arrayBuffer();
      } catch (error) {
        handlerSawError = (error as Error).name;
        return new Response('handler answer after overflow', { status: 500 });
      }
      return Response.json({ status: 'ok' });
    });

    // Unauthenticated submit declaring 10 MiB (> 10,240,000): the handler runs, answers 401,
    // and has read zero body bytes although the client already sent 64 KiB of body.
    const anon = rawClient(port);
    await anon.write(
      `POST /1/submit-listens HTTP/1.1\r\nHost: ${authority}\r\nContent-Type: application/json\r\nContent-Length: 10485760\r\n\r\n`,
    );
    await anon.write('x'.repeat(65_536));
    // The bridge closes the connection: the unread body is never parsed as a request.
    const unauthorized = parseResponse(await anon.ended);
    expect(unauthorized.status).toBe(401);
    expect(JSON.parse(unauthorized.body)).toEqual({ code: 401, error: 'Invalid authorization token.' });
    expect(unauthorized.headers.connection).toBe('close');
    expect(calls).toEqual([{ path: '/1/submit-listens', bytesAtEntry: 0, bytesAtAnswer: 0 }]);

    // Authenticated, 10,240,001 bytes streamed: the bridge answers ListenBrainz's verbatim 400.
    const big = rawClient(port);
    await big.write(
      `POST /1/submit-listens HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: Token good\r\nContent-Length: 10240001\r\n\r\n`,
    );
    void big.write('y'.repeat(10_240_001)).catch(() => undefined);
    const overflow = parseResponse(await big.ended);
    expect(overflow.status).toBe(400);
    expect(overflow.headers['content-type']).toBe('application/json');
    expect(overflow.headers['x-request-id']).toMatch(UUID_PATTERN);
    // ADR 0005 §8.1: the bridge's own /1/ answer carries the full CORS set.
    expect(overflow.headers['access-control-allow-origin']).toBe('*');
    expect(overflow.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
    expect(overflow.headers['access-control-max-age']).toBe('21600');
    expect(JSON.parse(overflow.body)).toEqual({
      code: 400,
      error: 'Payload too large. Payload cannot exceed 10240000 bytes',
    });
    expect(handlerSawError).toBe('BodyTooLargeError');
    expect(calls).toHaveLength(2);

    // Exactly 10,240,000 bytes are accepted.
    const exact = parseResponse(
      await exchange(
        port,
        `POST /1/submit-listens HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: Token good\r\nContent-Length: 10240000\r\nConnection: close\r\n\r\n${'z'.repeat(10_240_000)}`,
      ),
    );
    expect(exact.status).toBe(200);
    expect(calls).toHaveLength(3);

    // Pre-checked routes answer a declared length over the cap without calling the handler.
    const declared = async (target: string, length: number, extra = '') =>
      parseResponse(
        await exchange(
          port,
          `POST ${target} HTTP/1.1\r\nHost: ${authority}\r\nContent-Length: ${length}\r\n${extra}Connection: close\r\n\r\n`,
        ),
      );
    const lfmXml = await declared('/2.0/', 1_048_577);
    expect(lfmXml.status).toBe(413);
    expect(lfmXml.headers['content-type']).toBe('text/xml; charset=utf-8');
    expect(lfmXml.headers['access-control-allow-origin']).toBe('*');
    expect(lfmXml.body).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="failed"><error code="6">${LASTFM_BODY_TOO_LARGE}</error></lfm>`,
    );
    for (const [target, extra] of [
      ['/2.0/?format=json', ''],
      ['/2.0', 'Accept: application/json\r\n'],
    ] as const) {
      const lfmJson = await declared(target, 1_048_577, extra);
      expect(lfmJson.status, target).toBe(413);
      expect(lfmJson.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(lfmJson.headers['access-control-allow-origin'], target).toBe('*');
      expect(JSON.parse(lfmJson.body)).toEqual({ error: 6, message: LASTFM_BODY_TOO_LARGE });
    }
    const lbOther = await declared('/1/delete-listen', 65_537);
    expect(lbOther.status).toBe(413);
    expect(JSON.parse(lbOther.body)).toEqual({ code: 413, error: 'The request body is too large.' });
    expect(lbOther.headers['content-type']).toBe('application/json');
    expect(lbOther.headers['access-control-allow-origin']).toBe('*');
    expect(lbOther.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
    expect(lbOther.headers['access-control-max-age']).toBe('21600');
    const api = await declared('/api/v1/notify', 65_537);
    expect(api.status).toBe(413);
    const envelope = JSON.parse(api.body) as { error: { code: string; requestId: string } };
    expect(envelope.error.code).toBe('payload_too_large');
    expect(api.headers['x-request-id']).toBe(envelope.error.requestId);
    // /api/v1 is not a CORS surface: its envelope gains no CORS headers.
    expect(api.headers['access-control-allow-origin']).toBeUndefined();
    expect(calls).toHaveLength(3);
  });

  it('HEAD returns headers and no body; the server has keepAliveTimeout 100000 and headersTimeout 60000', async () => {
    const methods: string[] = [];
    const { bridge, port, authority } = await start((request) => {
      methods.push(request.method);
      const headers = new Headers({ 'content-type': 'text/plain', 'content-length': '11', 'x-probe': 'yes' });
      headers.append('set-cookie', 'a=1; Path=/');
      headers.append('set-cookie', 'b=2; Path=/');
      return new Response('hello world', { headers });
    });
    expect(bridge.server.keepAliveTimeout).toBe(100_000);
    expect(bridge.server.headersTimeout).toBe(60_000);
    expect(bridge.server.requestTimeout).toBe(600_000);
    expect([KEEP_ALIVE_TIMEOUT_MS, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS]).toEqual([100_000, 60_000, 600_000]);

    // HEAD then GET pipelined on one keep-alive connection: a body after the
    // HEAD would corrupt the second response, so its exact framing proves none was sent.
    const text = await exchange(
      port,
      `HEAD /x HTTP/1.1\r\nHost: ${authority}\r\n\r\nGET /x HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
    );
    const second = text.indexOf('HTTP/1.1 200', 1);
    expect(second).toBeGreaterThan(0);
    const head = text.slice(0, second);
    expect(head.endsWith('\r\n\r\n')).toBe(true);
    const headResponse = parseResponse(head);
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers['x-probe']).toBe('yes');
    expect(headResponse.headers['content-length']).toBe('11');
    expect(headResponse.body).toBe('');
    expect(head.match(/set-cookie: /gi)).toHaveLength(2);
    const getResponse = parseResponse(text.slice(second));
    expect(getResponse.body).toBe('hello world');
    expect(methods).toEqual(['HEAD', 'GET']);
  });

  it('ATMUSIC_LISTEN 0.0.0.0:8888 and 192.168.1.2:8888 are startup errors; 127.2.0.1:8888 and [::1]:0 are accepted; LISTEN_FDS=1 with a non-loopback fd is refused', {
    timeout: 30_000,
  }, async () => {
    for (const value of [
      '0.0.0.0:8888',
      '192.168.1.2:8888',
      '[::]:8888',
      '[2001:db8::1]:8888',
      '[::ffff:127.0.0.1]:8888',
      'localhost:8888',
      '::1:8888',
      '127.0.0.1',
      '127.0.0.1:65536',
      '127.0.0.1:08888',
      '[127.0.0.1]:8888',
      '127.000.0.1:8888',
    ]) {
      expect(() => parseListen(value), value).toThrowError(ListenConfigError);
      expect(() => parseListen(value), value).toThrowError(/^ATMUSIC_LISTEN: /);
    }
    expect(DEFAULT_LISTEN).toBe('127.2.0.1:8888');
    expect(parseListen(undefined)).toEqual({ host: '127.2.0.1', port: 8888 });
    expect(parseListen('127.2.0.1:8888')).toEqual({ host: '127.2.0.1', port: 8888 });
    expect(parseListen('[::1]:0')).toEqual({ host: '::1', port: 0 });
    expect(parseListen('[0:0:0:0:0:0:0:1]:0')).toEqual({ host: '::1', port: 0 });
    expect(parseListen('127.255.0.9:1')).toEqual({ host: '127.255.0.9', port: 1 });

    // A non-loopback address handed to createServer directly is refused before anything is bound.
    const wide = createServer({
      publicOrigin: ORIGIN,
      listen: { host: '0.0.0.0', port: 0 },
      handler: () => new Response(''),
    });
    servers.push(wide);
    await expect(wide.start()).rejects.toThrowError(/^ATMUSIC_LISTEN: only loopback/);
    expect(wide.server.listening).toBe(false);
    expect(wide.address).toBeNull();

    // [::1]:0 binds and serves; the listen authority is a valid Host.
    const v6 = createServer({
      publicOrigin: ORIGIN,
      listen: parseListen('[::1]:0'),
      handler: () => new Response('v6'),
    });
    servers.push(v6);
    const bound = await v6.start();
    expect(bound.host).toBe('::1');
    expect(bound.authority).toBe(`[::1]:${bound.port}`);
    const v6Response = parseResponse(
      await exchange(bound.port, `GET / HTTP/1.1\r\nHost: ${bound.authority}\r\nConnection: close\r\n\r\n`, '::1'),
    );
    expect(v6Response).toMatchObject({ status: 200, body: 'v6' });

    // Socket activation is ours only when LISTEN_PID is our pid; more than one socket is refused.
    expect(socketActivation({}, 4242)).toBeNull();
    expect(socketActivation({ LISTEN_FDS: '1', LISTEN_PID: '4242' }, 4242)).toEqual({ fd: 3 });
    expect(socketActivation({ LISTEN_FDS: '1', LISTEN_PID: '4243' }, 4242)).toBeNull();
    expect(() => socketActivation({ LISTEN_FDS: '2', LISTEN_PID: '4242' }, 4242)).toThrowError(/^LISTEN_FDS: /);

    // A real inherited fd 3: the bridge (bundled with esbuild, run by plain node)
    // in a child process that systemd-style receives a socket at fd 3.
    const dir = mkdtempSync(join(tmpdir(), 'atmusic-bridge-fd-'));
    dirs.push(dir);
    await build({
      stdin: {
        contents: `export * from ${JSON.stringify(join(WORKER_ROOT, 'src/node/http-bridge.ts'))};`,
        resolveDir: WORKER_ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      outfile: join(dir, 'bridge.mjs'),
      logLevel: 'silent',
    });
    writeFileSync(
      join(dir, 'child.mjs'),
      `import { createServer, socketActivation } from './bridge.mjs';
const listen = socketActivation({ LISTEN_FDS: '1', LISTEN_PID: String(process.pid) }, process.pid);
const bridge = createServer({ publicOrigin: ${JSON.stringify(ORIGIN)}, listen, handler: () => new Response('fd') });
try {
  const bound = await bridge.start();
  process.stdout.write(JSON.stringify({ ok: true, host: bound.host, port: bound.port, listening: bridge.server.listening }));
  await bridge.close();
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, name: error.name, variable: error.variable, listening: bridge.server.listening }));
}
`,
    );
    const runChild = async (server: NetServer) => {
      const fd = (server as unknown as { _handle: { fd: number } })._handle.fd;
      expect(fd).toBeGreaterThan(2);
      const child = spawn(process.execPath, [join(dir, 'child.mjs')], {
        stdio: ['ignore', 'pipe', 'pipe', fd],
        env: { PATH: process.env.PATH ?? '' },
      });
      let out = '';
      let err = '';
      child.stdout!.on('data', (c: Buffer) => {
        out += c.toString();
      });
      child.stderr!.on('data', (c: Buffer) => {
        err += c.toString();
      });
      const code = await new Promise<number | null>((resolve) => child.on('exit', (exitCode) => resolve(exitCode)));
      expect(code, err).toBe(0);
      return JSON.parse(out) as { ok: boolean; name?: string; variable?: string; port?: number; host?: string };
    };

    // A unix-domain socket at fd 3 has no loopback address: refused, and the child's server is closed.
    const unixServer = createNetServer();
    netServers.push(unixServer);
    await new Promise<void>((r) => unixServer.listen(join(dir, 'activation.sock'), () => r()));
    expect(await runChild(unixServer)).toEqual({
      ok: false,
      name: 'ListenConfigError',
      variable: 'LISTEN_FDS',
      listening: false,
    });

    // The positive control: a loopback TCP socket at fd 3 is accepted.
    const tcpServer = createNetServer();
    netServers.push(tcpServer);
    await new Promise<void>((r) => tcpServer.listen(0, '127.0.0.1', () => r()));
    const tcpPort = (tcpServer.address() as { port: number }).port;
    expect(await runChild(tcpServer)).toEqual({ ok: true, host: '127.0.0.1', port: tcpPort, listening: true });
  });
});
