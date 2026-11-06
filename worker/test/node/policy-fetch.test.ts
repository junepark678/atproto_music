// policyFetch over the pinned transport (ADR 0005 §3.5, amendment B5; N1-05).
//
// Same rig as pinned-transport.test.ts: an injected lookup spy and an injected
// socket connector answering from an in-memory duplex with a scripted
// HTTP/1.1 server, so no real socket, DNS query or network is used. The
// deadline comes from an injected manual timer; nothing waits in real time.

import { type Duplex, duplexPair } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LookupAnswer,
  type PinnedLookup,
  type PinnedTlsOptions,
  type PinnedTransport,
  pinnedTransport,
  type SocketConnector,
  TransportError,
} from '../../src/node/pinned-transport';
import { bindPolicyFetch, createPolicyFetch, POLICY_DEADLINE_MS, type PolicyCaps } from '../../src/node/policy-fetch';

// ---------------------------------------------------------------------------
// In-memory network

interface SeenRequest {
  address: string;
  servername: string | undefined;
  method: string;
  path: string;
  /** Header lines in wire order, names lowercased. */
  headerLines: [string, string][];
  headers: Record<string, string>;
  body: Buffer;
}

type Reply =
  | { status: number; headers?: Record<string, string>; body?: string | Uint8Array }
  | { stall: true }
  | { raw: (socket: Duplex) => void };

type Handler = (request: SeenRequest) => Reply;

function serve(socket: Duplex, options: PinnedTlsOptions, handler: Handler, seen: SeenRequest[]): void {
  let buffer = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString('latin1').split('\r\n');
      const [method, path] = (head[0] as string).split(' ') as [string, string];
      const headerLines: [string, string][] = head.slice(1).map((line: string) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
      });
      const headers = Object.fromEntries(headerLines);
      const length = Number(headers['content-length'] ?? '0');
      if (buffer.length < end + 4 + length) return;
      const body = Buffer.from(buffer.subarray(end + 4, end + 4 + length));
      buffer = buffer.subarray(end + 4 + length);
      const request: SeenRequest = {
        address: options.host,
        servername: options.servername,
        method,
        path,
        headerLines,
        headers,
        body,
      };
      seen.push(request);
      const reply = handler(request);
      if ('stall' in reply) return;
      if ('raw' in reply) {
        reply.raw(socket);
        return;
      }
      const payload = typeof reply.body === 'string' ? Buffer.from(reply.body) : Buffer.from(reply.body ?? []);
      const out: Record<string, string> = { 'content-length': String(payload.length), ...(reply.headers ?? {}) };
      const lines = [`HTTP/1.1 ${reply.status} X`, ...Object.entries(out).map(([k, v]) => `${k}: ${v}`)];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      socket.write(payload);
    }
  });
}

interface Net {
  lookup: PinnedLookup;
  connector: SocketConnector;
  lookups: string[];
  connects: PinnedTlsOptions[];
  requests: SeenRequest[];
}

function fakeNet(answers: (hostname: string) => readonly LookupAnswer[], handler: Handler): Net {
  const lookups: string[] = [];
  const connects: PinnedTlsOptions[] = [];
  const requests: SeenRequest[] = [];
  return {
    lookups,
    connects,
    requests,
    lookup: async (hostname) => {
      lookups.push(hostname);
      return answers(hostname);
    },
    connector: (options) => {
      connects.push(options);
      const [client, server] = duplexPair();
      serve(server, options, handler, requests);
      return Promise.resolve(client);
    },
  };
}

interface ManualTimer {
  timeout(ms: number): AbortSignal;
  requested(): number[];
  fire(ms: number): void;
}

function manualTimer(): ManualTimer {
  const pending: { ms: number; controller: AbortController }[] = [];
  return {
    timeout(ms) {
      const controller = new AbortController();
      pending.push({ ms, controller });
      return controller.signal;
    },
    requested: () => pending.map((p) => p.ms),
    fire(ms) {
      for (const p of pending) {
        if (p.ms === ms && !p.controller.signal.aborted)
          p.controller.abort(new DOMException('deadline', 'TimeoutError'));
      }
    },
  };
}

async function settle(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
  expect(done()).toBe(true);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function expectTransportError(error: unknown, code: TransportError['code']): TransportError {
  expect(error).toBeInstanceOf(TransportError);
  expect(error).not.toBeInstanceOf(TypeError);
  expect((error as TransportError).code).toBe(code);
  return error as TransportError;
}

const PUBLIC = '93.184.215.14';
// The transport's own deadline is longer than policyFetch's, so the 10 s that
// fires in these tests is policyFetch's.
const TRANSPORT_CAPS = { maxResponseBytes: 1 << 20, maxRequestBytes: 1 << 20, deadlineMs: 60_000 };
const CAPS: PolicyCaps = { maxRequestBytes: 2048, maxResponseBytes: 1024 };

const transports: PinnedTransport[] = [];
afterEach(async () => {
  for (const t of transports.splice(0)) await t.agent.destroy();
});

function rig(answers: (hostname: string) => readonly LookupAnswer[], handler: Handler) {
  const net = fakeNet(answers, handler);
  const timer = manualTimer();
  const transport = pinnedTransport({
    lookup: net.lookup,
    connector: net.connector,
    caps: TRANSPORT_CAPS,
    timer: manualTimer(),
  });
  transports.push(transport);
  const policyFetch = createPolicyFetch({ transport, timer });
  return { net, timer, transport, policyFetch };
}

// ---------------------------------------------------------------------------

describe('policyFetch', () => {
  it('a POST with a form body is sent through the pinned agent with method, headers and body bytes intact, and a lookup answer of 10.0.0.5 is refused with blocked_address before any connect', async () => {
    const { net, policyFetch } = rig(
      (host) => [{ address: host === 'lan.example.com' ? '10.0.0.5' : PUBLIC }],
      () => ({
        status: 201,
        headers: { 'content-type': 'application/json', 'dpop-nonce': 'n-2' },
        body: '{"request_uri":"urn:ietf:params:oauth:request_uri:abc","expires_in":60}',
      }),
    );
    const form = new URLSearchParams({
      client_id: 'https://music.214510.xyz/oauth/client-metadata.json',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      login_hint: 'björk.example.com',
    });
    const response = await policyFetch(
      'https://as.example.com/oauth/par',
      {
        method: 'POST',
        headers: { dpop: 'eyJ0eXAiOiJkcG9wK2p3dCJ9.e30.sig', 'x-trace': 'one', accept: 'application/json' },
        body: form,
      },
      { caps: CAPS },
    );
    expect(response.status).toBe(201);
    expect(response.url).toBe('https://as.example.com/oauth/par');
    expect(response.headers.get('dpop-nonce')).toBe('n-2');
    expect(await response.json()).toEqual({ request_uri: 'urn:ietf:params:oauth:request_uri:abc', expires_in: 60 });

    expect(net.lookups).toEqual(['as.example.com']);
    expect(net.connects.map((c) => [c.host, c.servername, c.rejectUnauthorized])).toEqual([
      [PUBLIC, 'as.example.com', true],
    ]);
    expect(net.requests).toHaveLength(1);
    const sent = net.requests[0] as SeenRequest;
    expect(sent.address).toBe(PUBLIC);
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/oauth/par');
    expect(sent.headers.host).toBe('as.example.com');
    expect(sent.headers['content-type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    expect(sent.headers.dpop).toBe('eyJ0eXAiOiJkcG9wK2p3dCJ9.e30.sig');
    expect(sent.headers['x-trace']).toBe('one');
    expect(sent.headers.accept).toBe('application/json');
    const expected = Buffer.from(form.toString(), 'utf8');
    expect(sent.headers['content-length']).toBe(String(expected.length));
    expect(sent.body.equals(expected)).toBe(true);
    expect(sent.body.toString('utf8')).toContain('login_hint=bj%C3%B6rk.example.com');

    // Raw bytes and a Request input are carried the same way.
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const raw = await policyFetch(
      new Request('https://pds.example.com/xrpc/com.atproto.repo.uploadBlob', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      }),
      undefined,
      { caps: CAPS },
    );
    await raw.arrayBuffer();
    const blob = net.requests[1] as SeenRequest;
    expect([blob.method, blob.path, blob.headers['content-type']]).toEqual([
      'POST',
      '/xrpc/com.atproto.repo.uploadBlob',
      'application/octet-stream',
    ]);
    expect([...blob.body]).toEqual([...bytes]);

    // A host that resolves to the LAN is refused at the lookup: no connect.
    const connectsBefore = net.connects.length;
    const error = expectTransportError(
      await rejection(
        policyFetch('https://lan.example.com/oauth/token', { method: 'POST', body: form }, { caps: CAPS }),
      ),
      'blocked_address',
    );
    expect(error.reason).toBe('private_answer');
    expect(error.address).toBe('10.0.0.5');
    expect(net.lookups.at(-1)).toBe('lan.example.com');
    expect(net.connects.length).toBe(connectsBefore);
    expect(net.requests).toHaveLength(2);

    // A request body over the caller's cap is refused before any lookup.
    const lookupsBefore = net.lookups.length;
    const big = expectTransportError(
      await rejection(
        policyFetch(
          'https://as.example.com/oauth/par',
          { method: 'POST', body: 'x'.repeat(CAPS.maxRequestBytes + 1) },
          { caps: CAPS },
        ),
      ),
      'too_large',
    );
    expect(big.reason).toBe('request_body');
    expect(net.lookups.length).toBe(lookupsBefore);

    // bindPolicyFetch gives the (input, init) shape client libraries take.
    const bound = bindPolicyFetch(policyFetch, CAPS);
    const viaBound = await bound('https://as.example.com/oauth/par', { method: 'POST', body: form });
    expect(viaBound.status).toBe(201);
    await viaBound.arrayBuffer();
    expect((net.requests.at(-1) as SeenRequest).body.equals(expected)).toBe(true);
  });

  it('a 302 answer to a POST is a TransportError redirect and the Location is never requested; a response over its cap is too_large and a stalled response is timeout after the injected deadline', async () => {
    const { net, timer, policyFetch } = rig(
      () => [{ address: PUBLIC }],
      (req) => {
        switch (req.path) {
          case '/oauth/token':
            return { status: 302, headers: { location: 'https://evil.example.com/steal?code=abc' } };
          case '/declared':
            return { status: 200, body: 'x'.repeat(CAPS.maxResponseBytes + 1) };
          case '/exact':
            return { status: 200, body: 'x'.repeat(CAPS.maxResponseBytes) };
          case '/streamed':
            return {
              raw: (socket) => {
                socket.write('HTTP/1.1 200 X\r\ntransfer-encoding: chunked\r\n\r\n');
                for (let i = 0; i < 3; i++) socket.write(`200\r\n${'y'.repeat(512)}\r\n`);
                socket.write('0\r\n\r\n');
              },
            };
          case '/slow-body':
            return {
              raw: (socket) => {
                socket.write('HTTP/1.1 200 X\r\ncontent-length: 100\r\n\r\nhalf');
              },
            };
          default:
            return { stall: true };
        }
      },
    );

    // 302 to a POST.
    const redirect = expectTransportError(
      await rejection(
        policyFetch('https://as.example.com/oauth/token', { method: 'POST', body: 'grant_type=x' }, { caps: CAPS }),
      ),
      'redirect',
    );
    expect(redirect.status).toBe(302);
    expect(redirect.reason).toBe('http_302');
    expect(net.lookups).toEqual(['as.example.com']);
    expect(net.requests.map((r) => [r.method, r.path])).toEqual([['POST', '/oauth/token']]);
    // A caller asking to follow redirects gets the same refusal.
    expectTransportError(
      await rejection(
        policyFetch(
          'https://as.example.com/oauth/token',
          { method: 'POST', body: 'g', redirect: 'follow' },
          { caps: CAPS },
        ),
      ),
      'redirect',
    );
    expect(net.lookups).not.toContain('evil.example.com');
    expect(net.requests.every((r) => r.servername === 'as.example.com')).toBe(true);
    // policyFetch refuses the 3xx itself, also over a transport that hands one back.
    const seen: string[] = [];
    const passThrough = createPolicyFetch({
      transport: async (request) => {
        seen.push(`${request.method} ${request.url} ${request.redirect}`);
        return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } });
      },
      timer: manualTimer(),
    });
    const own = expectTransportError(
      await rejection(passThrough('https://as.example.com/oauth/token', { method: 'POST', body: 'g' }, { caps: CAPS })),
      'redirect',
    );
    expect(own.status).toBe(302);
    expect(seen).toEqual(['POST https://as.example.com/oauth/token manual']);

    // Over the response cap: declared, and streamed. Exactly the cap is fine.
    const declared = expectTransportError(
      await rejection(policyFetch('https://as.example.com/declared', undefined, { caps: CAPS })),
      'too_large',
    );
    expect(declared.reason).toBe('content_length');
    expect(declared.maxBytes).toBe(CAPS.maxResponseBytes);
    const exact = await policyFetch('https://as.example.com/exact', undefined, { caps: CAPS });
    expect((await exact.text()).length).toBe(CAPS.maxResponseBytes);
    const streamed = await policyFetch('https://as.example.com/streamed', undefined, { caps: CAPS });
    expect(streamed.status).toBe(200);
    const overflow = expectTransportError(await rejection(streamed.text()), 'too_large');
    expect(overflow.reason).toBe('streamed');

    // Every exchange asked for the 10 s deadline.
    expect(POLICY_DEADLINE_MS).toBe(10_000);
    expect(timer.requested().every((ms) => ms === 10_000)).toBe(true);
    expect(timer.requested().length).toBeGreaterThanOrEqual(5);

    // A stalled response: pending until the injected deadline fires, then timeout.
    let settled = false;
    const before = net.requests.length;
    const stalled = rejection(
      policyFetch('https://as.example.com/stall', { method: 'POST', body: 'a=1' }, { caps: CAPS }),
    ).finally(() => {
      settled = true;
    });
    await settle(() => net.requests.length === before + 1);
    expect(settled).toBe(false);
    timer.fire(10_000);
    const timeout = expectTransportError(await stalled, 'timeout');
    expect(timeout.reason).toBe('deadline');

    // A body that stalls after the headers also ends in timeout at the deadline.
    const slowTimer = manualTimer();
    const slow = createPolicyFetch({ transport: transports[0] as PinnedTransport, timer: slowTimer });
    const partial = await slow('https://as.example.com/slow-body', undefined, { caps: CAPS });
    expect(partial.status).toBe(200);
    const reading = rejection(partial.text());
    await settle(() => net.requests.some((r) => r.path === '/slow-body'));
    slowTimer.fire(10_000);
    expectTransportError(await reading, 'timeout');
  });

  it('http, an IP literal, a non-default port and a .local host are refused before any lookup, for GET and POST alike', async () => {
    const { net, policyFetch } = rig(
      () => [{ address: PUBLIC }],
      () => ({ status: 200, body: 'ok' }),
    );
    const refused: [string, string][] = [
      ['http://as.example.com/oauth/par', 'not_https'],
      ['https://10.0.0.5/oauth/par', 'ip_literal'],
      ['https://[fd00::1]/oauth/par', 'ip_literal'],
      ['https://0x7f.1/oauth/par', 'ip_literal'],
      ['https://as.example.com:8443/oauth/par', 'non_default_port'],
      ['https://nas.local/oauth/par', 'reserved_tld'],
      ['https://localhost/oauth/par', 'localhost'],
    ];
    for (const [url, reason] of refused) {
      for (const init of [{ method: 'GET' }, { method: 'POST', body: 'grant_type=refresh_token' }] as RequestInit[]) {
        const error = expectTransportError(await rejection(policyFetch(url, init, { caps: CAPS })), 'blocked_address');
        expect(error.reason, `${init.method} ${url}`).toBe(reason);
        // A Request object input is checked the same way.
        const viaRequest = expectTransportError(
          await rejection(policyFetch(new Request(url, init), undefined, { caps: CAPS })),
          'blocked_address',
        );
        expect(viaRequest.reason).toBe(reason);
      }
    }
    expect(net.lookups).toEqual([]);
    expect(net.connects).toEqual([]);
    expect(net.requests).toEqual([]);

    // Control: the same path on a public https host goes through, GET and POST.
    for (const init of [{ method: 'GET' }, { method: 'POST', body: 'grant_type=refresh_token' }] as RequestInit[]) {
      const response = await policyFetch('https://as.example.com/oauth/par', init, { caps: CAPS });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
    }
    expect(net.requests.map((r) => [r.method, r.path, r.address])).toEqual([
      ['GET', '/oauth/par', PUBLIC],
      ['POST', '/oauth/par', PUBLIC],
    ]);
  });
});
