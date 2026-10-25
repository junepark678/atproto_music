// The pinned outbound transport (ADR 0005 §3.5, amendment B5; N1-05).
//
// No real socket, DNS query or network: the lookup is an injected spy and the
// socket stage is an injected connector that records the options it was asked
// to connect with and answers from an in-memory duplex (node:stream
// duplexPair) running a minimal scripted HTTP/1.1 server. Deadlines come from
// an injected manual timer, so nothing waits in real time. The one TLS test
// runs Node's real tls.connect over the same kind of in-memory duplex.

import { type Duplex, duplexPair } from 'node:stream';
import { TLSSocket, connect as tlsConnect } from 'node:tls';
import { createSafeFetch, isSafeFetchError, KIND_CAPS, type SafeFetchError } from '@atmusic/atproto/net/safe-fetch';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { Agent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PINNED_CAPS,
  isTransportError,
  type LookupAnswer,
  type PinnedLookup,
  type PinnedTlsOptions,
  type PinnedTransport,
  pinnedTransport,
  type SocketConnector,
  TransportError,
  tlsSocketConnector,
  unpinnedFetchStub,
} from '../../src/node/pinned-transport';

// ---------------------------------------------------------------------------
// In-memory network

interface SeenRequest {
  /** The address the connector was asked to connect to. */
  address: string;
  servername: string | undefined;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

type Reply =
  | { status: number; headers?: Record<string, string>; body?: string | Uint8Array; close?: boolean }
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
      const headers: Record<string, string> = {};
      for (const line of head.slice(1)) {
        const colon = line.indexOf(':');
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const length = Number(headers['content-length'] ?? '0');
      if (buffer.length < end + 4 + length) return;
      const body = Buffer.from(buffer.subarray(end + 4, end + 4 + length));
      buffer = buffer.subarray(end + 4 + length);
      const request: SeenRequest = {
        address: options.host,
        servername: options.servername,
        method,
        path,
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
      const lines = [`HTTP/1.1 ${reply.status} X`];
      const out: Record<string, string> = { 'content-length': String(payload.length), ...(reply.headers ?? {}) };
      if (reply.close) out.connection = 'close';
      for (const [k, v] of Object.entries(out)) lines.push(`${k}: ${v}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      socket.write(payload);
      if (reply.close) socket.end();
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

function fakeNet(
  answers: (hostname: string, call: number) => readonly LookupAnswer[],
  handler: Handler,
  connectFails?: (options: PinnedTlsOptions) => Error | 'hang' | null,
): Net {
  const lookups: string[] = [];
  const connects: PinnedTlsOptions[] = [];
  const requests: SeenRequest[] = [];
  return {
    lookups,
    connects,
    requests,
    lookup: async (hostname) => {
      lookups.push(hostname);
      return answers(hostname, lookups.length);
    },
    connector: (options, signal) => {
      connects.push(options);
      const failure = connectFails?.(options) ?? null;
      if (failure === 'hang') {
        return new Promise<Duplex>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('connector gave up')), { once: true });
        });
      }
      if (failure) return Promise.reject(failure);
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
        if (p.ms === ms && !p.controller.signal.aborted) {
          p.controller.abort(new DOMException('deadline', 'TimeoutError'));
        }
      }
    },
  };
}

/** Let in-memory I/O run until `done()` holds (bounded; no real-time wait). */
async function settle(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
  expect(done()).toBe(true);
}

const PUBLIC = '93.184.215.14';
const PUBLIC_V6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2c';
const CAPS = { maxResponseBytes: 2048, maxRequestBytes: 4096, deadlineMs: 10_000, connectTimeoutMs: 5_000 };

const transports: PinnedTransport[] = [];
function track(transport: PinnedTransport): PinnedTransport {
  transports.push(transport);
  return transport;
}
afterEach(async () => {
  for (const t of transports.splice(0)) await t.agent.destroy();
});

const ok: Handler = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });

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
  expect((error as TransportError).name).toBe('TransportError');
  expect((error as TransportError).code).toBe(code);
  expect(isTransportError(error, code)).toBe(true);
  return error as TransportError;
}

const DOH_ADDRESS = '104.16.249.249';

/**
 * A network where cloudflare-dns.com answers SafeFetch's DoH pre-check with
 * PUBLIC for pds.example.com, and every other request goes to `handler`.
 */
function safeFetchNet(handler: Handler): Net {
  return fakeNet(
    (host) => [{ address: host === 'cloudflare-dns.com' ? DOH_ADDRESS : PUBLIC }],
    (req) => {
      if (req.servername === 'cloudflare-dns.com') {
        const type = new URL(`https://x${req.path}`).searchParams.get('type');
        const answer = type === '1' ? [{ name: 'pds.example.com', type: 1, TTL: 300, data: PUBLIC }] : [];
        return {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
          body: JSON.stringify({ Status: 0, Answer: answer }),
        };
      }
      return handler(req);
    },
  );
}

/** Requests that reached pds.example.com (not the DoH resolver). */
function pdsRequests(net: Net): SeenRequest[] {
  return net.requests.filter((r) => r.servername === 'pds.example.com');
}

/** A chunked response of `chunks` chunks of `chunkBytes` bytes each. */
function chunkedReply(chunks: number, chunkBytes: number): Reply {
  return {
    raw: (socket) => {
      socket.write('HTTP/1.1 200 X\r\ncontent-type: application/vnd.ipld.car\r\ntransfer-encoding: chunked\r\n\r\n');
      const chunk = Buffer.alloc(chunkBytes, 0x61);
      for (let i = 0; i < chunks; i++) {
        socket.write(`${chunkBytes.toString(16)}\r\n`);
        socket.write(chunk);
        socket.write('\r\n');
      }
      socket.write('0\r\n\r\n');
    },
  };
}

// ---------------------------------------------------------------------------

describe('pinned transport', () => {
  it('answers 10.0.0.5, 127.2.0.1, ::1, 169.254.169.254, 100.64.0.1 and fd00::1 are refused with blocked_address before any connect', async () => {
    const blocked = ['10.0.0.5', '127.2.0.1', '::1', '169.254.169.254', '100.64.0.1', 'fd00::1'];
    for (const address of blocked) {
      const net = fakeNet(() => [{ address }], ok);
      const transport = track(pinnedTransport({ lookup: net.lookup, connector: net.connector, caps: CAPS }));
      const error = expectTransportError(
        await rejection(transport(new Request('https://pds.example.com/xrpc/com.atproto.sync.getLatestCommit'))),
        'blocked_address',
      );
      expect(error.reason).toBe('private_answer');
      expect(error.address).toBe(address);
      expect(net.lookups).toEqual(['pds.example.com']);
      expect(net.connects).toHaveLength(0);
      expect(net.requests).toHaveLength(0);
    }

    // A mixed answer set is refused as a whole: one bad answer poisons it.
    const mixed = fakeNet(() => [{ address: PUBLIC }, { address: '10.0.0.5' }], ok);
    const t2 = track(pinnedTransport({ lookup: mixed.lookup, connector: mixed.connector, caps: CAPS }));
    expectTransportError(await rejection(t2(new Request('https://pds.example.com/'))), 'blocked_address');
    expect(mixed.connects).toHaveLength(0);

    // An empty answer set is a dns failure, not a connect.
    const empty = fakeNet(() => [], ok);
    const t3 = track(pinnedTransport({ lookup: empty.lookup, connector: empty.connector, caps: CAPS }));
    expectTransportError(await rejection(t3(new Request('https://pds.example.com/'))), 'dns');
    expect(empty.connects).toHaveLength(0);

    // Control: public answers (v4 and v6) do connect, to exactly those addresses.
    for (const address of [PUBLIC, PUBLIC_V6]) {
      const net = fakeNet(() => [{ address }], ok);
      const transport = track(pinnedTransport({ lookup: net.lookup, connector: net.connector, caps: CAPS }));
      const response = await transport(new Request('https://pds.example.com/xrpc/x'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(net.connects.map((c) => c.host)).toEqual([address]);
      expect(net.requests.map((r) => [r.address, r.method, r.path, r.headers.host])).toEqual([
        [address, 'GET', '/xrpc/x', 'pds.example.com'],
      ]);
    }
  });

  it('a rebinding lookup (public first, 127.0.0.1 second) never connects to loopback: the connected address is the checked one', async () => {
    // Each connection resolves once; the server closes after every answer, so
    // the second request needs a fresh connection and a fresh lookup.
    const net = fakeNet(
      (_host, call) => [{ address: call === 1 ? PUBLIC : '127.0.0.1' }],
      () => ({ status: 200, body: 'first', close: true }),
    );
    const transport = track(pinnedTransport({ lookup: net.lookup, connector: net.connector, caps: CAPS }));

    const first = await transport(new Request('https://rebind.example.com/a'));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('first');
    expect(net.lookups).toEqual(['rebind.example.com']);
    expect(net.connects).toHaveLength(1);
    // The socket stage got the literal checked address, with the name only as
    // SNI/certificate name, and a lookup that can only answer that address.
    const pinned = net.connects[0] as PinnedTlsOptions;
    expect(pinned.host).toBe(PUBLIC);
    expect(pinned.servername).toBe('rebind.example.com');
    const relookup = await new Promise<unknown[]>((resolve) =>
      pinned.lookup('rebind.example.com', { all: true }, (...args: unknown[]) => resolve(args)),
    );
    expect(relookup).toEqual([null, [{ address: PUBLIC, family: 4 }]]);
    expect(net.requests.map((r) => r.address)).toEqual([PUBLIC]);

    await settle(() => true);
    const error = expectTransportError(
      await rejection(transport(new Request('https://rebind.example.com/b'))),
      'blocked_address',
    );
    expect(error.address).toBe('127.0.0.1');
    expect(net.lookups).toEqual(['rebind.example.com', 'rebind.example.com']);
    // Never a second connect, and never to loopback.
    expect(net.connects.map((c) => c.host)).toEqual([PUBLIC]);
    expect(net.requests.map((r) => r.path)).toEqual(['/a']);

    // An IP-literal request URL is checked itself, without a lookup.
    const literal = fakeNet(() => [{ address: PUBLIC }], ok);
    const t2 = track(pinnedTransport({ lookup: literal.lookup, connector: literal.connector, caps: CAPS }));
    expectTransportError(await rejection(t2(new Request('https://127.0.0.1/'))), 'blocked_address');
    expect(literal.lookups).toEqual([]);
    expect(literal.connects).toEqual([]);
  });

  it('connection refused, timeout, oversized body and any 3xx reject with TransportError, never TypeError', async () => {
    // Connection refused.
    const refused = fakeNet(
      () => [{ address: PUBLIC }],
      ok,
      () => Object.assign(new Error(`connect ECONNREFUSED ${PUBLIC}:443`), { code: 'ECONNREFUSED' }),
    );
    const t1 = track(pinnedTransport({ lookup: refused.lookup, connector: refused.connector, caps: CAPS }));
    const e1 = expectTransportError(await rejection(t1(new Request('https://pds.example.com/'))), 'connect');
    expect(e1.reason).toBe('ECONNREFUSED');
    expect(refused.connects).toHaveLength(1);

    // A failing lookup is dns.
    const nx = fakeNet(() => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND nx.example.com'), { code: 'ENOTFOUND' });
    }, ok);
    const tnx = track(pinnedTransport({ lookup: nx.lookup, connector: nx.connector, caps: CAPS }));
    const enx = expectTransportError(await rejection(tnx(new Request('https://nx.example.com/'))), 'dns');
    expect(enx.reason).toBe('ENOTFOUND');

    // A connect that hangs times out at the injected connect deadline.
    const hangTimer = manualTimer();
    const hang = fakeNet(
      () => [{ address: PUBLIC }],
      ok,
      () => 'hang',
    );
    const th = track(pinnedTransport({ lookup: hang.lookup, connector: hang.connector, caps: CAPS, timer: hangTimer }));
    const hanging = rejection(th(new Request('https://pds.example.com/')));
    await settle(() => hang.connects.length === 1);
    expect(hangTimer.requested()).toEqual([10_000, 5_000]);
    hangTimer.fire(5_000);
    const eh = expectTransportError(await hanging, 'timeout');
    expect(eh.reason).toBe('connect_deadline');

    // A response that never arrives times out at the injected deadline.
    const timer = manualTimer();
    const stall = fakeNet(
      () => [{ address: PUBLIC }],
      () => ({ stall: true }),
    );
    const t2 = track(pinnedTransport({ lookup: stall.lookup, connector: stall.connector, caps: CAPS, timer }));
    let settled = false;
    const pending = rejection(t2(new Request('https://pds.example.com/slow'))).finally(() => {
      settled = true;
    });
    await settle(() => stall.requests.length === 1);
    expect(settled).toBe(false);
    timer.fire(10_000);
    expectTransportError(await pending, 'timeout');

    // Oversized body: declared, and streamed (chunked, no Content-Length).
    const big = fakeNet(
      () => [{ address: PUBLIC }],
      (req) =>
        req.path === '/declared'
          ? { status: 200, body: 'x'.repeat(CAPS.maxResponseBytes + 1) }
          : {
              raw: (socket) => {
                socket.write('HTTP/1.1 200 X\r\ntransfer-encoding: chunked\r\n\r\n');
                for (let i = 0; i < 4; i++) socket.write(`400\r\n${'y'.repeat(1024)}\r\n`);
                socket.write('0\r\n\r\n');
              },
            },
    );
    const t3 = track(pinnedTransport({ lookup: big.lookup, connector: big.connector, caps: CAPS }));
    const e3 = expectTransportError(await rejection(t3(new Request('https://pds.example.com/declared'))), 'too_large');
    expect(e3.reason).toBe('content_length');
    const streamed = await t3(new Request('https://pds.example.com/streamed'));
    expect(streamed.status).toBe(200);
    const e4 = expectTransportError(await rejection(streamed.arrayBuffer()), 'too_large');
    expect(e4.reason).toBe('streamed');
    expect(e4.maxBytes).toBe(CAPS.maxResponseBytes);

    // An oversized request body is refused before any lookup.
    const before = big.lookups.length;
    const e5 = expectTransportError(
      await rejection(
        t3(
          new Request('https://pds.example.com/upload', {
            method: 'POST',
            body: new Uint8Array(CAPS.maxRequestBytes + 1),
          }),
        ),
      ),
      'too_large',
    );
    expect(e5.reason).toBe('request_body');
    expect(big.lookups.length).toBe(before);

    // Every 3xx, and the Location is never requested.
    for (const status of [301, 302, 303, 307, 308]) {
      const redirect = fakeNet(
        () => [{ address: PUBLIC }],
        () => ({ status, headers: { location: 'https://internal.example.com/admin' } }),
      );
      const t4 = track(pinnedTransport({ lookup: redirect.lookup, connector: redirect.connector, caps: CAPS }));
      const e6 = expectTransportError(await rejection(t4(new Request('https://pds.example.com/r'))), 'redirect');
      expect(e6.status).toBe(status);
      expect(redirect.lookups).toEqual(['pds.example.com']);
      expect(redirect.requests.map((r) => r.path)).toEqual(['/r']);
    }
  });

  it('http URLs, IP literals, non-default ports and .local hosts are still refused by the SafeFetch policy in front', async () => {
    const net = fakeNet(
      (host) => [{ address: host === 'cloudflare-dns.com' ? '104.16.249.249' : PUBLIC }],
      (req) => {
        if (req.servername === 'cloudflare-dns.com') {
          const type = new URL(`https://x${req.path}`).searchParams.get('type');
          const answer = type === '1' ? [{ name: 'pds.example.com', type: 1, TTL: 300, data: PUBLIC }] : [];
          return {
            status: 200,
            headers: { 'content-type': 'application/dns-json' },
            body: JSON.stringify({ Status: 0, Answer: answer }),
          };
        }
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"did":"did:plc:abc"}' };
      },
    );
    const transport = track(pinnedTransport({ lookup: net.lookup, connector: net.connector, caps: CAPS }));
    const safeFetch = createSafeFetch({ transport, clock: fixedClock() });

    const refused: [string, string][] = [
      ['http://pds.example.com/xrpc/com.atproto.repo.getRecord', 'not_https'],
      ['https://10.0.0.5/xrpc/com.atproto.repo.getRecord', 'ip_literal'],
      ['https://[::1]/xrpc/com.atproto.repo.getRecord', 'ip_literal'],
      ['https://2130706433/xrpc/com.atproto.repo.getRecord', 'ip_literal'],
      ['https://pds.example.com:8443/xrpc/com.atproto.repo.getRecord', 'non_default_port'],
      ['https://printer.local/xrpc/com.atproto.repo.getRecord', 'reserved_tld'],
    ];
    for (const [url, reason] of refused) {
      const error = await rejection(safeFetch(url, { kind: 'json' }));
      expect(isSafeFetchError(error, 'blocked_destination'), url).toBe(true);
      expect((error as SafeFetchError).reason, url).toBe(reason);
    }
    // Refused in front: the pinned transport never looked anything up or connected.
    expect(net.lookups).toEqual([]);
    expect(net.connects).toEqual([]);
    expect(net.requests).toEqual([]);

    // Control: a public https URL goes through SafeFetch's DoH pre-check and
    // its GET, both over the pinned transport, to checked addresses only.
    const response = await safeFetch('https://pds.example.com/xrpc/com.atproto.identity.resolveHandle', {
      kind: 'json',
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({ did: 'did:plc:abc' });
    expect(new Set(net.lookups)).toEqual(new Set(['cloudflare-dns.com', 'pds.example.com']));
    expect(
      net.requests.filter((r) => r.servername === 'pds.example.com').map((r) => [r.address, r.method, r.path]),
    ).toEqual([[PUBLIC, 'GET', '/xrpc/com.atproto.identity.resolveHandle']]);
    expect(net.requests.filter((r) => r.servername === 'cloudflare-dns.com').map((r) => r.address)).toEqual([
      '104.16.249.249',
      '104.16.249.249',
    ]);
    for (const c of net.connects) expect([PUBLIC, '104.16.249.249']).toContain(c.host);
  });

  it('the undici Agent is built with rejectUnauthorized true, and calling unpinnedFetchStub rejects with TransportError unpinned_fetch', async () => {
    const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    // The environment cannot weaken it.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const net = fakeNet(() => [{ address: PUBLIC }], ok);
      const transport = track(pinnedTransport({ lookup: net.lookup, connector: net.connector, caps: CAPS }));
      expect(transport.agent).toBeInstanceOf(Agent);
      expect(transport.connectOptions.rejectUnauthorized).toBe(true);
      expect(transport.connectOptions.lookup).toBe(net.lookup);
      expect(Object.isFrozen(transport.connectOptions)).toBe(true);

      // Every socket the Agent opens is asked for with rejectUnauthorized true,
      // the checked address and the hostname as servername.
      const response = await transport(new Request('https://pds.example.com/'));
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(net.connects).toHaveLength(1);
      expect(net.connects[0]).toMatchObject({
        host: PUBLIC,
        port: 443,
        servername: 'pds.example.com',
        rejectUnauthorized: true,
        ALPNProtocols: ['http/1.1'],
      });

      // The production socket stage (tls.connect) really verifies: run it over
      // an in-memory duplex against a peer with a self-signed certificate. It
      // is refused through the whole pinned transport...
      const tlsNet = fakeNet(() => [{ address: PUBLIC }], ok);
      const tlsPeers: TLSSocket[] = [];
      const overMemory: SocketConnector = (options, signal) => {
        tlsNet.connects.push(options);
        const [client, server] = duplexPair();
        tlsPeers.push(new TLSSocket(server, { isServer: true, key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }));
        tlsPeers.at(-1)?.on('error', () => {});
        return tlsSocketConnector({ ...options, socket: client }, signal);
      };
      const tlsTransport = track(pinnedTransport({ lookup: tlsNet.lookup, connector: overMemory, caps: CAPS }));
      const refused = expectTransportError(
        await rejection(tlsTransport(new Request('https://pds.example.com/'))),
        'connect',
      );
      expect(refused.reason).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
      expect(tlsNet.connects.map((c) => c.rejectUnauthorized)).toEqual([true]);

      // ...while the same peer is accepted when verification is off, so the
      // refusal above is the verification and not a broken handshake.
      const [client, server] = duplexPair();
      const peer = new TLSSocket(server, { isServer: true, key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT });
      peer.on('error', () => {});
      const unverified = tlsConnect({ socket: client, servername: 'pds.example.com', rejectUnauthorized: false });
      await new Promise<void>((resolve, reject) => {
        unverified.once('secureConnect', () => resolve());
        unverified.once('error', reject);
      });
      expect(unverified.authorized).toBe(false);
      unverified.destroy();
      peer.destroy();
      for (const p of tlsPeers) p.destroy();
    } finally {
      if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
    }

    // The global-fetch stub refuses every call with a TransportError.
    for (const input of [
      'https://pds.example.com/',
      new URL('https://plc.directory/did:plc:abc'),
      new Request('https://bsky.social/'),
    ]) {
      const error = expectTransportError(
        await rejection(unpinnedFetchStub(input, { method: 'POST' })),
        'unpinned_fetch',
      );
      expect(error.message).toContain('unpinned global fetch refused');
    }
  });

  it("a 3xx to a redirect:'manual' request is handed back unfollowed, so SafeFetch over the pinned transport refuses it as redirect_refused", async () => {
    // Directly: the transport returns the 3xx bodiless with its Location, and
    // never requests the Location.
    const direct = fakeNet(
      () => [{ address: PUBLIC }],
      () => ({ status: 302, headers: { location: 'https://internal.example.com/admin' }, body: 'moved' }),
    );
    const td = track(pinnedTransport({ lookup: direct.lookup, connector: direct.connector, caps: CAPS }));
    const handedBack = await td(new Request('https://pds.example.com/r', { redirect: 'manual' }));
    expect(handedBack.status).toBe(302);
    expect(handedBack.headers.get('location')).toBe('https://internal.example.com/admin');
    expect(handedBack.body).toBeNull();
    expect(direct.lookups).toEqual(['pds.example.com']);
    expect(direct.requests.map((r) => [r.address, r.path])).toEqual([[PUBLIC, '/r']]);

    // Through SafeFetch (which sends redirect:'manual'): every 3xx is its own
    // permanent redirect_refused with the status, never network_error, for
    // the buffered and the streamed read alike.
    for (const status of [301, 302, 303, 307, 308]) {
      const net = safeFetchNet(() => ({
        status,
        headers: { location: 'https://internal.example.com/admin', 'content-length': String(64 * 1024 * 1024) },
      }));
      const transport = track(pinnedTransport({ lookup: net.lookup, connector: net.connector, caps: CAPS }));
      const safeFetch = createSafeFetch({ transport, clock: fixedClock(), timer: manualTimer() });

      const buffered = await rejection(
        safeFetch('https://pds.example.com/xrpc/com.atproto.repo.getRecord', { kind: 'getRecord' }),
      );
      expect(isSafeFetchError(buffered, 'redirect_refused'), String(status)).toBe(true);
      expect((buffered as SafeFetchError).status).toBe(status);
      expect((buffered as SafeFetchError).reason).toBe('redirect');

      const streamed = await rejection(
        safeFetch.stream('https://pds.example.com/xrpc/com.atproto.sync.getRepo', { kind: 'getRepo' }),
      );
      expect(isSafeFetchError(streamed, 'redirect_refused'), String(status)).toBe(true);
      expect((streamed as SafeFetchError).status).toBe(status);

      // The Location host was never looked up or connected to.
      expect(net.lookups).not.toContain('internal.example.com');
      expect(net.connects.map((c) => c.host).every((h) => h === PUBLIC || h === DOH_ADDRESS)).toBe(true);
      expect(pdsRequests(net).map((r) => r.path)).toEqual([
        '/xrpc/com.atproto.repo.getRecord',
        '/xrpc/com.atproto.sync.getRepo',
      ]);
    }
  });

  it('SafeFetch getRepo over pinnedTransport(DEFAULT_PINNED_CAPS) is body_too_large for a declared and a streamed overflow, never network_error', async () => {
    const getRepoCap = KIND_CAPS.getRepo;
    // The transport cap is a backstop strictly above every SafeFetch kind cap.
    expect(DEFAULT_PINNED_CAPS.maxResponseBytes).toBeGreaterThan(Math.max(...Object.values(KIND_CAPS)));

    const url = 'https://pds.example.com/xrpc/com.atproto.sync.getRepo?did=did:plc:abc';
    // Declared: Content-Length one byte over the getRepo cap.
    const declaredNet = safeFetchNet(() => ({
      raw: (socket) => {
        socket.write(
          `HTTP/1.1 200 X\r\ncontent-type: application/vnd.ipld.car\r\ncontent-length: ${getRepoCap + 1}\r\n\r\n`,
        );
        socket.write(Buffer.alloc(1024, 0x61));
      },
    }));
    const declaredTransport = track(
      pinnedTransport({ lookup: declaredNet.lookup, connector: declaredNet.connector, caps: DEFAULT_PINNED_CAPS }),
    );
    const declaredFetch = createSafeFetch({ transport: declaredTransport, clock: fixedClock(), timer: manualTimer() });
    for (const read of [
      () => declaredFetch.stream(url, { kind: 'getRepo' }),
      () => declaredFetch(url, { kind: 'getRepo' }),
    ]) {
      const error = await rejection(read());
      expect(isSafeFetchError(error, 'body_too_large')).toBe(true);
      expect((error as SafeFetchError).reason).toBe('content_length');
      expect((error as SafeFetchError).maxBytes).toBe(getRepoCap);
    }
    expect(pdsRequests(declaredNet)).toHaveLength(2);

    // Streamed: chunked, no Content-Length, 34 MiB in 1 MiB chunks.
    const MiB = 1024 * 1024;
    const streamedNet = safeFetchNet(() => chunkedReply(34, MiB));
    const streamedTransport = track(
      pinnedTransport({ lookup: streamedNet.lookup, connector: streamedNet.connector, caps: DEFAULT_PINNED_CAPS }),
    );
    const streamedFetch = createSafeFetch({ transport: streamedTransport, clock: fixedClock(), timer: manualTimer() });
    const opened = await streamedFetch.stream(url, { kind: 'getRepo' });
    expect(opened.status).toBe(200);
    const reader = opened.body.getReader();
    let read = 0;
    let streamError: unknown = null;
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        read += step.value.byteLength;
      }
    } catch (error) {
      streamError = error;
    }
    expect(isSafeFetchError(streamError, 'body_too_large')).toBe(true);
    expect((streamError as SafeFetchError).reason).toBe('streamed');
    expect((streamError as SafeFetchError).maxBytes).toBe(getRepoCap);
    expect(read).toBeLessThanOrEqual(getRepoCap);

    const buffered = await rejection(streamedFetch(url, { kind: 'getRepo' }));
    expect(isSafeFetchError(buffered, 'body_too_large')).toBe(true);
    expect((buffered as SafeFetchError).reason).toBe('streamed');

    // Control: a body of exactly the getRepo cap passes the transport whole.
    const exactNet = safeFetchNet(() => chunkedReply(32, MiB));
    const exactTransport = track(
      pinnedTransport({ lookup: exactNet.lookup, connector: exactNet.connector, caps: DEFAULT_PINNED_CAPS }),
    );
    const exactFetch = createSafeFetch({ transport: exactTransport, clock: fixedClock(), timer: manualTimer() });
    const exact = await exactFetch(url, { kind: 'getRepo' });
    expect(exact.status).toBe(200);
    expect(exact.body.byteLength).toBe(getRepoCap);
  });
});

// A throwaway self-signed P-256 certificate for pds.example.com (test only,
// trusted by nothing), so tls.connect has something to refuse.
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0mVmAzNJIsBMaV1/
OH/WhyCSiiHG9ceHM3bNmJGRLhuhRANCAAT8wv9OoGUQdhuUNdDeox1eQr890WlV
4lkBf5+vXiTax1pHuqwmRlmLe1h1N9pRfB/9JhRMzPF/q7AbM1oLPRPa
-----END PRIVATE KEY-----
`;
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIBqDCCAU2gAwIBAgIUHuQKQlWnCO5rnpOHJLshfaJIcxowCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPcGRzLmV4YW1wbGUuY29tMCAXDTI2MTAyNTE1MTYwMVoYDzIx
MjYxMDAxMTUxNjAxWjAaMRgwFgYDVQQDDA9wZHMuZXhhbXBsZS5jb20wWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAT8wv9OoGUQdhuUNdDeox1eQr890WlV4lkBf5+v
XiTax1pHuqwmRlmLe1h1N9pRfB/9JhRMzPF/q7AbM1oLPRPao28wbTAdBgNVHQ4E
FgQUUjcx3cMyaci0T/kbI8+B1JV5l6QwHwYDVR0jBBgwFoAUUjcx3cMyaci0T/kb
I8+B1JV5l6QwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgg9wZHMuZXhhbXBs
ZS5jb20wCgYIKoZIzj0EAwIDSQAwRgIhAKStkhW1LtUtoWeCjfuWwJszDgvHod8o
+nrNOwBiIgxaAiEA3sULJmyN3hw+isRyi7l63LZlIiG6IY2h9D+/LOLlsZI=
-----END CERTIFICATE-----
`;
