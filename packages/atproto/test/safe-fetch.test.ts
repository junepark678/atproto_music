// SafeFetch (ADR 0004 §8, A5): M2.1.2/redirect_rebinding and M2.1.2/fetch_bounds.
// Any 3xx is refused (the plan's four-redirect input collapses to the first
// 3xx), bodies are capped while streaming, and the 10 s deadline is stepped by
// hand through an injected DeadlineTimer — nothing sleeps.
import { DOH_HOST } from '@atmusic/atproto/net/doh';
import {
  createSafeFetch,
  type DeadlineTimer,
  KIND_CAPS,
  SAFE_FETCH_DEADLINE_MS,
  SafeFetchError,
} from '@atmusic/atproto/net/safe-fetch';
import type { Transport } from '@atmusic/atproto/transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';

type Handler = (req: Request) => Response | Promise<Response>;

/** Public DoH answers for every name; per-host handlers; every request recorded. */
function fakeNet(handlers: Record<string, Handler>, privateHosts: string[] = []) {
  const requests: Request[] = [];
  const dohNames: string[] = [];
  const transport: Transport = async (req) => {
    const url = new URL(req.url);
    if (url.hostname === DOH_HOST) {
      const name = url.searchParams.get('name') ?? '';
      const type = Number(url.searchParams.get('type'));
      dohNames.push(name);
      const data = privateHosts.includes(name)
        ? type === 1
          ? '10.0.0.7'
          : 'fd00::7'
        : type === 1
          ? '93.184.215.14'
          : '2606:4700::6810:84e5';
      return Response.json({ Status: 0, Answer: [{ name, type, TTL: 300, data }] });
    }
    requests.push(req);
    const handler = handlers[url.hostname];
    if (!handler) return new Response('no route', { status: 599 });
    return handler(req);
  };
  return { transport, requests, dohNames };
}

/** A DeadlineTimer whose signals fire only when the test says so. */
function manualTimer(): DeadlineTimer & { requested: number[]; fire(): void } {
  const controllers: AbortController[] = [];
  const requested: number[] = [];
  return {
    requested,
    timeout(ms) {
      requested.push(ms);
      const c = new AbortController();
      controllers.push(c);
      return c.signal;
    },
    fire() {
      for (const c of controllers) c.abort(new DOMException('deadline', 'TimeoutError'));
    },
  };
}

async function failure(p: Promise<unknown>): Promise<SafeFetchError> {
  const result = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(result).toBeInstanceOf(SafeFetchError);
  return result as SafeFetchError;
}

/** A lazily pulled body of `chunks` × `chunkSize` bytes that counts pulls and cancels. */
function countingBody(chunks: number, chunkSize: number) {
  const stats = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (stats.pulls >= chunks) {
          controller.close();
          return;
        }
        stats.pulls++;
        controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
}

/** A body that delivers `prefix` bytes, then errors as a mid-body connection reset would. */
function resettingBody(prefix: number) {
  const stats = { pulls: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        stats.pulls++;
        if (stats.pulls === 1) {
          controller.enqueue(new Uint8Array(prefix).fill(0x7b));
          return;
        }
        controller.error(new TypeError('connection reset'));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
}

describe('SafeFetch', () => {
  it('3xx response is refused and Location is not followed', async () => {
    for (const status of [300, 301, 302, 303, 304, 307, 308]) {
      const net = fakeNet(
        {
          'pds.example.com': () =>
            new Response(null, { status, headers: { location: 'https://metadata.example.net/latest/meta-data/' } }),
          'metadata.example.net': () => Response.json({ secret: true }),
        },
        ['metadata.example.net'],
      );
      const safeFetch = createSafeFetch({ transport: net.transport, clock: fixedClock() });
      const error = await failure(safeFetch('https://pds.example.com/.well-known/did.json', { kind: 'didDoc' }));
      expect({ status, code: error.code, httpStatus: error.status }).toEqual({
        status,
        code: 'redirect_refused',
        httpStatus: status,
      });
      // Exactly one outbound request, to the original URL; the Location host is
      // neither resolved nor contacted.
      expect(net.requests.map((r) => r.url)).toEqual(['https://pds.example.com/.well-known/did.json']);
      expect(net.dohNames).toEqual(['pds.example.com', 'pds.example.com']);
      const [req] = net.requests;
      expect(req?.redirect).toBe('manual');
      expect(req?.method).toBe('GET');
      // No credentials of any kind: the only header is accept.
      expect([...(req?.headers.keys() ?? [])]).toEqual(['accept']);
      expect(req?.headers.get('accept')).toBe('application/did+ld+json, application/json');
    }

    // A 3xx pointing at an IP literal is refused the same way (never parsed, never fetched).
    const net = fakeNet({
      'pds.example.com': () => new Response('', { status: 302, headers: { location: 'https://127.0.0.1/' } }),
    });
    const safeFetch = createSafeFetch({ transport: net.transport, clock: fixedClock() });
    expect((await failure(safeFetch('https://pds.example.com/x', { kind: 'json' }))).code).toBe('redirect_refused');
    expect(net.requests).toHaveLength(1);
  });

  it('body over cap aborts with body_too_large and does not buffer the rest', async () => {
    const CHUNK = 64 * 1024;
    const bodies: Array<ReturnType<typeof countingBody>> = [];
    const net = fakeNet({
      // 64 chunks × 64 KiB = 4 MiB offered against the 1 MiB json cap.
      'big.example.com': () => {
        const body = countingBody(64, CHUNK);
        bodies.push(body);
        return new Response(body.stream, { headers: { 'content-type': 'application/json' } });
      },
      // Exactly at the cap, and one byte over (the plan's body=1048577).
      'exact.example.com': () => new Response(new Uint8Array(KIND_CAPS.json).fill(0x20)),
      'plusone.example.com': () => new Response(new Uint8Array(KIND_CAPS.json + 1).fill(0x20)),
      // Declared Content-Length over the didDoc cap: refused before any read.
      'declared.example.com': () => {
        const body = countingBody(2, CHUNK);
        bodies.push(body);
        return new Response(body.stream, { headers: { 'content-length': String(2 * CHUNK) } });
      },
    });
    const safeFetch = createSafeFetch({ transport: net.transport, clock: fixedClock() });

    const big = await failure(safeFetch('https://big.example.com/x', { kind: 'json' }));
    expect({ code: big.code, reason: big.reason, maxBytes: big.maxBytes }).toEqual({
      code: 'body_too_large',
      reason: 'streamed',
      maxBytes: 1_048_576,
    });
    // 16 chunks fill the cap and the 17th crosses it; a couple more may be in
    // flight inside the runtime's pipe, but the remaining ~3 MiB are never pulled.
    expect(bodies[0]?.stats.pulls).toBeGreaterThanOrEqual(17);
    expect(bodies[0]?.stats.pulls).toBeLessThanOrEqual(20);
    await new Promise((r) => setTimeout(r, 0));
    expect(bodies[0]?.stats.cancelled).toBe(true);

    const exact = await safeFetch('https://exact.example.com/x', { kind: 'json' });
    expect(exact.body.byteLength).toBe(1_048_576);
    const plusOne = await failure(safeFetch('https://plusone.example.com/x', { kind: 'json' }));
    expect(plusOne.code).toBe('body_too_large');

    const declared = await failure(safeFetch('https://declared.example.com/did.json', { kind: 'didDoc' }));
    expect({ code: declared.code, reason: declared.reason, maxBytes: declared.maxBytes }).toEqual({
      code: 'body_too_large',
      reason: 'content_length',
      maxBytes: 65_536,
    });
    expect(bodies[1]?.stats.pulls).toBe(0);

    // The streaming form enforces the same cap (getRepo-style consumer), lowered via maxBytes.
    const streamed = await safeFetch.stream('https://big.example.com/x', { kind: 'getRepo', maxBytes: 3 * CHUNK });
    const reader = streamed.body.getReader();
    let received = 0;
    const streamError = await (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return null;
          received += value.byteLength;
        }
      } catch (e) {
        return e;
      }
    })();
    expect((streamError as SafeFetchError).code).toBe('body_too_large');
    expect(received).toBe(3 * CHUNK); // the consumer never saw a byte past the cap
    expect(bodies[2]?.stats.pulls).toBeLessThanOrEqual(7);

    // Caps per kind are fixed; maxBytes can only lower them.
    expect(KIND_CAPS).toEqual({
      didDoc: 65_536,
      json: 1_048_576,
      getRecord: 1_048_576,
      getBlocks: 8_388_608,
      getRepo: 33_554_432,
    });
    await expect(
      safeFetch('https://exact.example.com/x', { kind: 'json', maxBytes: KIND_CAPS.json + 1 }),
    ).rejects.toThrow(RangeError);
  });

  it('10s deadline yields timeout', async () => {
    // Headers never arrive and the transport ignores the signal: the deadline still wins.
    let calledHang!: () => void;
    const hangCalled = new Promise<void>((r) => {
      calledHang = r;
    });
    // Headers arrive, then the body stalls.
    const stalled = { cancelled: false };
    let calledStall!: () => void;
    const stallCalled = new Promise<void>((r) => {
      calledStall = r;
    });
    const net = fakeNet({
      'hang.example.com': () => {
        calledHang();
        return new Promise<Response>(() => {});
      },
      'stall.example.com': () => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(10));
          },
          pull() {
            calledStall();
            return new Promise<void>(() => {});
          },
          cancel() {
            stalled.cancelled = true;
          },
        });
        return new Response(stream);
      },
    });

    const timer = manualTimer();
    const safeFetch = createSafeFetch({ transport: net.transport, clock: fixedClock(), timer });
    const pending = safeFetch('https://hang.example.com/xrpc/x', { kind: 'json' });
    await hangCalled;
    expect(timer.requested).toEqual([SAFE_FETCH_DEADLINE_MS]);
    expect(SAFE_FETCH_DEADLINE_MS).toBe(10_000);
    // The same deadline signal is attached to the outbound Request.
    expect(net.requests[0]?.signal.aborted).toBe(false);
    timer.fire();
    const hung = await failure(pending);
    expect(hung.code).toBe('timeout');
    expect(net.requests[0]?.signal.aborted).toBe(true);

    const timer2 = manualTimer();
    const safeFetch2 = createSafeFetch({ transport: net.transport, clock: fixedClock(), timer: timer2 });
    const pending2 = safeFetch2('https://stall.example.com/xrpc/x', { kind: 'json' });
    await stallCalled;
    timer2.fire();
    const stall = await failure(pending2);
    expect(stall.code).toBe('timeout');
    await new Promise((r) => setTimeout(r, 0));
    expect(stalled.cancelled).toBe(true);
    expect(net.requests.map((r) => new URL(r.url).hostname)).toEqual(['hang.example.com', 'stall.example.com']);

    // A deadline that fires during the DoH pre-check stops before the target is contacted.
    let dohCalled!: () => void;
    const dohSeen = new Promise<void>((r) => {
      dohCalled = r;
    });
    const targets: string[] = [];
    const slowDns: Transport = async (req) => {
      if (new URL(req.url).hostname === DOH_HOST) {
        dohCalled();
        return new Promise<Response>(() => {});
      }
      targets.push(req.url);
      return new Response('{}');
    };
    const timer3 = manualTimer();
    const safeFetch3 = createSafeFetch({ transport: slowDns, clock: fixedClock(), timer: timer3 });
    const pending3 = safeFetch3('https://slow-dns.example.com/x', { kind: 'json' });
    await dohSeen;
    timer3.fire();
    expect((await failure(pending3)).code).toBe('timeout');
    expect(targets).toEqual([]);
  });

  it('Retry-After and RateLimit-Reset are parsed into typed error', async () => {
    const clock = fixedClock(); // 2026-01-15T12:00:00Z
    const nowSec = clock.nowMs() / 1000;
    const net = fakeNet({
      'seconds.example.com': () =>
        Response.json(
          { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' },
          { status: 429, headers: { 'retry-after': '20', 'ratelimit-reset': String(nowSec + 45) } },
        ),
      'date.example.com': () =>
        new Response('Service Unavailable', {
          status: 503,
          headers: { 'retry-after': 'Thu, 15 Jan 2026 12:01:30 GMT', 'ratelimit-reset': '7' },
        }),
      'past.example.com': () =>
        new Response(null, {
          status: 503,
          headers: { 'retry-after': 'Thu, 15 Jan 2026 11:00:00 GMT', 'ratelimit-reset': String(nowSec - 60) },
        }),
      'garbage.example.com': () =>
        new Response(null, { status: 502, headers: { 'retry-after': 'soon', 'ratelimit-reset': '-5' } }),
      'missing.example.com': () =>
        Response.json({ error: 'RecordNotFound', message: 'Could not locate record' }, { status: 400 }),
    });
    const safeFetch = createSafeFetch({ transport: net.transport, clock });

    const shape = (e: SafeFetchError) => ({
      code: e.code,
      status: e.status,
      retryAfterMs: e.retryAfterMs,
      rateLimitResetMs: e.rateLimitResetMs,
      xrpcError: e.xrpcError,
    });
    expect(shape(await failure(safeFetch('https://seconds.example.com/x', { kind: 'getRecord' })))).toEqual({
      code: 'http_status',
      status: 429,
      retryAfterMs: 20_000,
      rateLimitResetMs: 45_000,
      xrpcError: 'RateLimitExceeded',
    });
    expect(shape(await failure(safeFetch('https://date.example.com/x', { kind: 'getBlocks' })))).toEqual({
      code: 'http_status',
      status: 503,
      retryAfterMs: 90_000,
      rateLimitResetMs: 7_000,
      xrpcError: null,
    });
    expect(shape(await failure(safeFetch('https://past.example.com/x', { kind: 'json' })))).toEqual({
      code: 'http_status',
      status: 503,
      retryAfterMs: 0,
      rateLimitResetMs: 0,
      xrpcError: null,
    });
    expect(shape(await failure(safeFetch('https://garbage.example.com/x', { kind: 'json' })))).toEqual({
      code: 'http_status',
      status: 502,
      retryAfterMs: null,
      rateLimitResetMs: null,
      xrpcError: null,
    });
    const missing = await failure(safeFetch('https://missing.example.com/x', { kind: 'getRecord' }));
    expect(shape(missing)).toEqual({
      code: 'http_status',
      status: 400,
      retryAfterMs: null,
      rateLimitResetMs: null,
      xrpcError: 'RecordNotFound',
    });
    expect(missing.xrpcMessage).toBe('Could not locate record');
    // Each attempt is exactly one request: no hidden retries.
    expect(net.requests).toHaveLength(5);
    expect(net.requests[0]?.headers.get('accept')).toBe('application/vnd.ipld.car');

    // Headers already arrived, then the (optional) error body stalls until the
    // deadline fires: the status and backoff headers still classify it; only
    // the body-derived XRPC fields are lost, and the stalled body is cancelled.
    const stalledBody = { pulled: false, cancelled: false };
    let bodyPulled!: () => void;
    const pulled = new Promise<void>((r) => {
      bodyPulled = r;
    });
    const stallNet = fakeNet({
      'stall429.example.com': () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                stalledBody.pulled = true;
                bodyPulled();
                return new Promise<void>(() => {});
              },
              cancel() {
                stalledBody.cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 429, headers: { 'retry-after': '120', 'ratelimit-reset': String(nowSec + 30) } },
        ),
    });
    const timer = manualTimer();
    const stallFetch = createSafeFetch({ transport: stallNet.transport, clock, timer });
    const pending = stallFetch('https://stall429.example.com/xrpc/x', { kind: 'json' });
    await pulled;
    timer.fire();
    const stalled = await failure(pending);
    expect({ ...shape(stalled), xrpcMessage: stalled.xrpcMessage }).toEqual({
      code: 'http_status',
      status: 429,
      retryAfterMs: 120_000,
      rateLimitResetMs: 30_000,
      xrpcError: null,
      xrpcMessage: null,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(stalledBody).toEqual({ pulled: true, cancelled: true });
    expect(stallNet.requests).toHaveLength(1);
    expect(timer.requested).toEqual([SAFE_FETCH_DEADLINE_MS]);
  });

  it('mid-body connection reset is a typed network_error, not a raw TypeError', async () => {
    const bodies: Array<ReturnType<typeof resettingBody>> = [];
    const net = fakeNet({
      'reset.example.com': () => {
        const body = resettingBody(10);
        bodies.push(body);
        return new Response(body.stream, { headers: { 'content-type': 'application/json' } });
      },
      // Same reset inside an error body: the status still classifies it.
      'reset503.example.com': () => new Response(resettingBody(10).stream, { status: 503 }),
    });
    const timer = manualTimer();
    const safeFetch = createSafeFetch({ transport: net.transport, clock: fixedClock(), timer });

    const buffered = await failure(safeFetch('https://reset.example.com/xrpc/x', { kind: 'json' }));
    expect({ code: buffered.code, reason: buffered.reason, maxBytes: buffered.maxBytes }).toEqual({
      code: 'network_error',
      reason: 'body_stream',
      maxBytes: null,
    });
    expect(buffered.message).toContain('connection reset');
    expect(bodies[0]?.stats.pulls).toBe(2);

    // The streaming form surfaces the same typed error to its consumer, after the bytes that did arrive.
    const streamed = await safeFetch.stream('https://reset.example.com/xrpc/x', { kind: 'getRepo' });
    expect(streamed.status).toBe(200);
    const reader = streamed.body.getReader();
    let received = 0;
    const streamError = await (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return null;
          received += value.byteLength;
        }
      } catch (e) {
        return e;
      }
    })();
    expect(streamError).toBeInstanceOf(SafeFetchError);
    expect({ code: (streamError as SafeFetchError).code, reason: (streamError as SafeFetchError).reason }).toEqual({
      code: 'network_error',
      reason: 'body_stream',
    });
    expect(received).toBe(10);

    const status = await failure(safeFetch('https://reset503.example.com/xrpc/x', { kind: 'json' }));
    expect({ code: status.code, status: status.status, xrpcError: status.xrpcError }).toEqual({
      code: 'http_status',
      status: 503,
      xrpcError: null,
    });

    // One request per call (no retry), and the deadline never fired.
    expect(net.requests.map((r) => new URL(r.url).hostname)).toEqual([
      'reset.example.com',
      'reset.example.com',
      'reset503.example.com',
    ]);
    expect(timer.requested).toEqual([SAFE_FETCH_DEADLINE_MS, SAFE_FETCH_DEADLINE_MS, SAFE_FETCH_DEADLINE_MS]);
  });
});
