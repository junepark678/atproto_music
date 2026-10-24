import type { Random } from '@atmusic/core/deps';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import {
  classify,
  classifyResponse,
  MAX_ATTEMPTS,
  MAX_DELAY_MS,
  nextDelayMs,
  retryAfterFromHeaders,
} from '@atmusic/core/write-policy';
import { describe, expect, it } from 'vitest';

/** Zero jitter (ADR §10.2): float() is always 0. */
function constantRandom(value: number): Random & { calls: number } {
  const r = {
    calls: 0,
    bytes: (n: number) => new Uint8Array(n),
    float: () => {
      r.calls++;
      return value;
    },
  };
  return r;
}
const zero = () => constantRandom(0);
const LARGEST_BELOW_ONE = 1 - 2 ** -53;

describe('retry delays', () => {
  it('zero jitter yields 1s,2s,4s,8s,16s,32s,64s,128s,256s,300s', () => {
    expect(MAX_ATTEMPTS).toBe(10);
    expect(MAX_DELAY_MS).toBe(300_000);
    const random = zero();
    const delays = Array.from({ length: MAX_ATTEMPTS }, (_, i) => nextDelayMs(i + 1, random));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000]);
    // One jitter draw per delay, no hidden extra randomness.
    expect(random.calls).toBe(10);
    // The cap holds for every later (or absurd) attempt number.
    expect(nextDelayMs(11, zero())).toBe(300_000);
    expect(nextDelayMs(2_000, zero())).toBe(300_000);
    // Attempts are 1-based integers.
    expect(() => nextDelayMs(0, zero())).toThrow(RangeError);
    expect(() => nextDelayMs(1.5, zero())).toThrow(RangeError);
    expect(() => nextDelayMs(Number.NaN, zero())).toThrow(RangeError);
  });

  it('Retry-After 20 raises a 1s or 2s delay to 20s and is capped at 300s', () => {
    // Directly, in ms.
    expect(nextDelayMs(1, zero(), 20_000)).toBe(20_000);
    expect(nextDelayMs(2, zero(), 20_000)).toBe(20_000);
    // Retry-After never lowers a longer backoff.
    expect(nextDelayMs(6, zero(), 20_000)).toBe(32_000);
    expect(nextDelayMs(1, zero(), 0)).toBe(1_000);
    // Capped at 300 s, also together with maximal jitter.
    expect(nextDelayMs(1, zero(), 600_000)).toBe(300_000);
    expect(nextDelayMs(1, zero(), 300_000)).toBe(300_000);
    expect(nextDelayMs(9, constantRandom(LARGEST_BELOW_ONE), 299_000)).toBe(300_000);
    expect(() => nextDelayMs(1, zero(), -1)).toThrow(RangeError);
    expect(() => nextDelayMs(1, zero(), Number.POSITIVE_INFINITY)).toThrow(RangeError);

    // End to end from the PDS answer: `Retry-After: 20` on a 429 and a 503.
    const clock = fixedClock();
    const rateLimited = classify({ status: 429, headers: new Headers({ 'Retry-After': '20' }) }, { clock });
    expect(rateLimited).toEqual({ kind: 'transient', code: 'upstream_rate_limited', retryAfterMs: 20_000 });
    expect(nextDelayMs(1, zero(), rateLimited.retryAfterMs)).toBe(20_000);
    expect(nextDelayMs(2, zero(), rateLimited.retryAfterMs)).toBe(20_000);
    const unavailable = classify({ status: 503, headers: { 'retry-after': '20' } });
    expect(unavailable).toEqual({ kind: 'transient', code: 'upstream_unavailable', retryAfterMs: 20_000 });
    const huge = classify({ status: 429, headers: { 'Retry-After': '3600' } });
    expect(huge.retryAfterMs).toBe(3_600_000);
    expect(nextDelayMs(1, zero(), huge.retryAfterMs)).toBe(300_000);

    // HTTP-date form, relative to the injected clock (2026-01-15T12:00:00Z).
    expect(retryAfterFromHeaders({ 'Retry-After': 'Thu, 15 Jan 2026 12:00:20 GMT' }, clock)).toBe(20_000);
    expect(retryAfterFromHeaders({ 'Retry-After': 'Thu, 15 Jan 2026 11:59:00 GMT' }, clock)).toBeUndefined();
    expect(retryAfterFromHeaders({ 'Retry-After': 'Thu, 15 Jan 2026 12:00:20 GMT' })).toBeUndefined();
    // atproto PDS RateLimit-Reset (epoch seconds), used only without Retry-After.
    expect(retryAfterFromHeaders({ 'RateLimit-Reset': String(1_768_478_400 + 20) }, clock)).toBe(20_000);
    expect(retryAfterFromHeaders({ 'RateLimit-Reset': '1768478420', 'Retry-After': '5' }, clock)).toBe(5_000);
    // Malformed values are ignored, never turned into a negative or NaN delay.
    for (const bad of ['-5', '2.5', 'soon', '', '99999999999']) {
      expect(retryAfterFromHeaders({ 'Retry-After': bad }, clock), bad).toBeUndefined();
    }
    expect(classify({ status: 429, headers: { 'Retry-After': 'soon' } })).toEqual({
      kind: 'transient',
      code: 'upstream_rate_limited',
    });
  });

  it('jitter stays within [base, base*1.25] for seeded random', () => {
    const seen = new Map<number, Set<number>>();
    for (let seed = 1; seed <= 200; seed++) {
      const random = seededRandom(seed);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const base = Math.min(300_000, 1_000 * 2 ** (attempt - 1));
        const delay = nextDelayMs(attempt, random);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(base);
        expect(delay).toBeLessThanOrEqual(Math.min(300_000, base * 1.25));
        const set = seen.get(attempt) ?? new Set<number>();
        set.add(delay);
        seen.set(attempt, set);
      }
    }
    // The jitter is real: attempts below the cap get many distinct delays...
    for (let attempt = 1; attempt <= 9; attempt++) expect(seen.get(attempt)!.size).toBeGreaterThan(100);
    // ...and attempt 10 (base 512 s) is pinned to the 300 s cap.
    expect([...seen.get(10)!]).toEqual([300_000]);

    // Both ends of U[0, base/4] are reachable and inclusive, as in the Rust gen_range(0..=base/4).
    expect(nextDelayMs(1, zero())).toBe(1_000);
    expect(nextDelayMs(1, constantRandom(LARGEST_BELOW_ONE))).toBe(1_250);
    expect(nextDelayMs(8, constantRandom(LARGEST_BELOW_ONE))).toBe(160_000);
    expect(nextDelayMs(9, constantRandom(LARGEST_BELOW_ONE))).toBe(300_000); // 256 s + 64 s, capped
    // A broken Random is refused rather than producing an out-of-range delay.
    expect(() => nextDelayMs(1, constantRandom(1))).toThrow(RangeError);
    expect(() => nextDelayMs(1, constantRandom(-0.1))).toThrow(RangeError);

    // Same seed, same delays.
    const a = seededRandom(99);
    const b = seededRandom(99);
    const runA = Array.from({ length: MAX_ATTEMPTS }, (_, i) => nextDelayMs(i + 1, a));
    const runB = Array.from({ length: MAX_ATTEMPTS }, (_, i) => nextDelayMs(i + 1, b));
    expect(runA).toEqual(runB);
  });
});

describe('failure classification', () => {
  it('classify maps 429/5xx/network to transient and RecordAlreadyExists to ambiguous_create', async () => {
    // Transient: 429, every 5xx, and anything the send threw.
    expect(classify({ status: 429 })).toEqual({ kind: 'transient', code: 'upstream_rate_limited' });
    for (const status of [500, 502, 503, 504, 599]) {
      expect(classify({ status, body: { error: 'InternalServerError', message: 'Internal Server Error' } })).toEqual({
        kind: 'transient',
        code: 'upstream_unavailable',
        error: 'InternalServerError',
      });
    }
    expect(classify(new TypeError('Failed to fetch'))).toEqual({ kind: 'transient', code: 'upstream_transport_error' });
    expect(classify(new DOMException('aborted', 'AbortError'))).toEqual({
      kind: 'transient',
      code: 'upstream_transport_error',
    });
    expect(classify(new DOMException('timed out', 'TimeoutError')).kind).toBe('transient');
    expect(classify(new Error('socket hang up')).kind).toBe('transient');
    expect(classify(undefined).kind).toBe('transient');

    // Ambiguous create: the RecordAlreadyExists / "already exists" shapes.
    const exists = { status: 400, body: { error: 'RecordAlreadyExists', message: 'Record already exists' } };
    expect(classify(exists)).toEqual({
      kind: 'ambiguous_create',
      code: 'record_already_exists',
      error: 'RecordAlreadyExists',
    });
    // As JSON text, as bytes, and as a thrown XRPC client error (status + error name).
    expect(classify({ status: 400, body: JSON.stringify(exists.body) }).kind).toBe('ambiguous_create');
    expect(classify({ status: 400, body: new TextEncoder().encode(JSON.stringify(exists.body)) }).kind).toBe(
      'ambiguous_create',
    );
    const xrpcError = Object.assign(new Error('Record already exists'), { status: 400, error: 'RecordAlreadyExists' });
    expect(classify(xrpcError)).toEqual({
      kind: 'ambiguous_create',
      code: 'record_already_exists',
      error: 'RecordAlreadyExists',
    });
    expect(classify({ status: 409, body: { error: 'InvalidRequest', message: 'record already exists' } }).kind).toBe(
      'ambiguous_create',
    );
    // A duplicate rkey surfaced as a 500 with that message is ambiguous, not resent.
    expect(
      classify({ status: 500, body: { error: 'InternalServerError', message: 'There is already a value at key: x/y' } })
        .kind,
    ).toBe('ambiguous_create');
    // Only creates can be ambiguous; for a delete or put the same answer is a plain rejection.
    expect(classify(exists, { operation: 'delete' })).toEqual({
      kind: 'permanent',
      code: 'upstream_rejected',
      error: 'RecordAlreadyExists',
    });
    expect(classify(exists, { operation: 'put' }).kind).toBe('permanent');

    // Permanent: everything else (one request, no retry).
    const permanent: Array<[number, unknown, string]> = [
      [400, { error: 'InvalidRecord', message: 'bad' }, 'invalid_record'],
      [400, { error: 'InvalidRequest', message: 'Input/rkey must be a valid Record Key' }, 'upstream_rejected'],
      [400, 'not json', 'upstream_rejected'],
      [400, undefined, 'upstream_rejected'],
      [401, { error: 'ExpiredToken' }, 'sign_in_required'],
      [401, { error: 'InvalidToken' }, 'sign_in_required'],
      [401, undefined, 'sign_in_required'],
      [403, { error: 'InsufficientScope' }, 'forbidden_scope'],
      [403, undefined, 'forbidden_scope'],
      [409, { error: 'RecordNotFound' }, 'upstream_rejected'],
      [413, undefined, 'upstream_rejected'],
      [302, undefined, 'upstream_rejected'],
    ];
    for (const [status, body, code] of permanent) {
      const result = classify({ status, body });
      expect(result.kind, `${status} ${JSON.stringify(body)}`).toBe('permanent');
      expect(result.code, `${status} ${JSON.stringify(body)}`).toBe(code);
      expect(result.retryAfterMs).toBeUndefined();
    }
    // 404 / 400 RecordNotFound is never a verdict (Rust write.rs routes reconcile::missing
    // to lookup()): the runner looks the record up, and absence completes a delete.
    for (const operation of ['create', 'put', 'delete'] as const) {
      expect(classify({ status: 404 }, { operation })).toEqual({ kind: 'missing', code: 'record_not_found' });
      expect(classify({ status: 400, body: { error: 'RecordNotFound' } }, { operation })).toEqual({
        kind: 'missing',
        code: 'record_not_found',
        error: 'RecordNotFound',
      });
      expect(classify({ status: 404, body: { error: 'InvalidRecord' } }, { operation }).kind).toBe('missing');
    }
    expect(
      (await classifyResponse(new Response('{"error":"RecordNotFound"}', { status: 400 }), { operation: 'delete' }))
        .kind,
    ).toBe('missing');

    // InvalidSwap means the repo moved under a swap: re-fetch and retry (Rust: repository_changed).
    expect(classify({ status: 400, body: { error: 'InvalidSwap' } }, { operation: 'delete' })).toEqual({
      kind: 'transient',
      code: 'repository_changed',
      error: 'InvalidSwap',
    });

    // classify is for failures only; a success or a non-status is a caller bug.
    expect(() => classify({ status: 200 })).toThrow(RangeError);
    expect(() => classify({ status: 0 })).toThrow(RangeError);

    // A real fetch Response cannot be classified synchronously: its body is an unread
    // stream, and status alone would turn RecordAlreadyExists into a permanent failure.
    const unread = new Response('{"error":"RecordAlreadyExists","message":"Record already exists"}', { status: 400 });
    expect(() => classify(unread)).toThrow(/classifyResponse/);
    expect(() => classify(new Response(null, { status: 429 }))).toThrow(TypeError);
    expect(() => classify({ status: 400, body: new Response('{"error":"InvalidSwap"}').body })).toThrow(TypeError);
    expect(() => classify({ status: 400, body: new Blob(['{"error":"InvalidRecord"}']) })).toThrow(TypeError);
    // The rejected Response is left unread, so classifyResponse still sees its body.
    expect(unread.bodyUsed).toBe(false);
    expect(await classifyResponse(unread)).toEqual({
      kind: 'ambiguous_create',
      code: 'record_already_exists',
      error: 'RecordAlreadyExists',
    });
    expect(await classifyResponse(new Response('{"error":"InvalidSwap"}', { status: 400 }))).toEqual({
      kind: 'transient',
      code: 'repository_changed',
      error: 'InvalidSwap',
    });
    expect(await classifyResponse(new Response('{"error":"ExpiredToken"}', { status: 400 }))).toEqual({
      kind: 'permanent',
      code: 'sign_in_required',
      error: 'ExpiredToken',
    });

    // Real fetch Responses, body read by classifyResponse.
    const fromResponse = await classifyResponse(
      new Response(JSON.stringify({ error: 'RecordAlreadyExists' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(fromResponse).toEqual({
      kind: 'ambiguous_create',
      code: 'record_already_exists',
      error: 'RecordAlreadyExists',
    });
    expect(await classifyResponse(new Response(null, { status: 429, headers: { 'retry-after': '20' } }))).toEqual({
      kind: 'transient',
      code: 'upstream_rate_limited',
      retryAfterMs: 20_000,
    });
    expect(await classifyResponse(new Response('{"error":"InvalidRecord"}', { status: 400 }))).toEqual({
      kind: 'permanent',
      code: 'invalid_record',
      error: 'InvalidRecord',
    });
    // An oversized error body is not buffered; the status alone decides.
    const big = await classifyResponse(
      new Response(`{"error":"RecordAlreadyExists","pad":"${'x'.repeat(70_000)}"}`, { status: 400 }),
    );
    expect(big).toEqual({ kind: 'permanent', code: 'upstream_rejected' });
  });
});
