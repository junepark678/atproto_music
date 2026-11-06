// Per-IP rate buckets on the Node host (ADR 0005 §3.6, §8.7, §13; N1-06):
// rateKeyOf collapses an IPv6 /64 into one key, and a per-IP BucketSet built
// with onFull 'evict-lru' admits a new key at MAX_BUCKET_KEYS by dropping the
// least recently used bucket, while the default 'refuse' mode (the per-
// credential sets, and worker/test/http/limits.test.ts) is unchanged.

import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import { BucketSet, MAX_BUCKET_KEYS, type RateRule } from '../../src/http/limits';
import { rateKeyOf } from '../../src/node/client-ip';

/** The ListenBrainz per-IP rule of ADR 0005 §8.7: 30 requests per 10 s. */
const PER_IP_10S: RateRule = { capacity: 30, windowMs: 10_000 };

/** The n-th address inside 2001:db8:5:6::/64 (distinct interface ids). */
function inPrefix(n: number): string {
  const hi = Math.floor(n / 0x10000);
  const lo = n % 0x10000;
  return `2001:db8:5:6:${(n % 7).toString(16)}:${((n * 13) % 0xffff).toString(16)}:${hi.toString(16)}:${lo.toString(16)}`;
}

/** The n-th IPv4 address of 10.0.0.0/8 (a distinct /32 each). */
function v4(n: number): string {
  return `10.${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
}

describe('per-IP bucket sets on the Node host', () => {
  it('10,001 distinct addresses inside one IPv6 /64 share one bucket and the 31st request in 10 s from any of them is refused, while an address in another /64 is allowed', () => {
    const clock = fixedClock();
    const perIp = new BucketSet(PER_IP_10S, clock, { onFull: 'evict-lru' });

    const addresses = Array.from({ length: 10_001 }, (_, i) => inPrefix(i));
    expect(new Set(addresses).size).toBe(10_001);
    const keys = new Set(addresses.map(rateKeyOf));
    expect([...keys]).toEqual(['2001:db8:5:6::/64']);

    const decisions = addresses.map((address) => perIp.take(rateKeyOf(address)));
    // The first 30 pass, counting down; every later one, from whichever address, is refused.
    expect(decisions.slice(0, 30).map((d) => (d.allowed ? d.remaining : -1))).toEqual(
      Array.from({ length: 30 }, (_, i) => 29 - i),
    );
    expect(decisions[30]).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(decisions.slice(30).every((d) => !d.allowed)).toBe(true);
    expect(decisions.filter((d) => d.allowed)).toHaveLength(30);
    // One bucket, not 10,001: the set never grew per address.
    expect(perIp.size).toBe(1);

    // Another /64 (differing only in the fourth hextet) has its own bucket.
    const neighbour = '2001:db8:5:7::1';
    expect(rateKeyOf(neighbour)).toBe('2001:db8:5:7::/64');
    expect(perIp.take(rateKeyOf(neighbour))).toEqual({ allowed: true, remaining: 29 });
    expect(perIp.size).toBe(2);

    // The /64 refills at capacity/window: one token per 333.3 ms, all 30 after 10 s.
    clock.advance(333);
    expect(perIp.take(rateKeyOf(inPrefix(5))).allowed).toBe(false);
    clock.advance(1);
    expect(perIp.take(rateKeyOf(inPrefix(9_999))).allowed).toBe(true);
    clock.advance(10_000);
    const refilled = Array.from({ length: 31 }, (_, i) => perIp.take(rateKeyOf(inPrefix(i * 300))));
    expect(refilled.filter((d) => d.allowed)).toHaveLength(30);
    expect(refilled[30]?.allowed).toBe(false);
  });

  it('a per-IP BucketSet with onFull evict-lru and 10,000 live keys admits a new key by evicting the least recently used one; the default refuse mode still answers retryAfter for a new key', () => {
    expect(MAX_BUCKET_KEYS).toBe(10_000);
    const clock = fixedClock();
    const lru = new BucketSet(PER_IP_10S, clock, { onFull: 'evict-lru' });
    const refuse = new BucketSet(PER_IP_10S, clock);
    expect(lru.onFull).toBe('evict-lru');
    expect(refuse.onFull).toBe('refuse');
    expect(lru.maxKeys).toBe(MAX_BUCKET_KEYS);

    // 10,000 live keys, each with one token spent (so none is full and sweepable).
    for (let i = 0; i < MAX_BUCKET_KEYS; i++) {
      expect(lru.take(rateKeyOf(v4(i))).allowed).toBe(true);
      expect(refuse.take(rateKeyOf(v4(i))).allowed).toBe(true);
    }
    expect(lru.size).toBe(MAX_BUCKET_KEYS);
    expect(refuse.size).toBe(MAX_BUCKET_KEYS);

    // Key 0 is touched again, so key 1 is now the least recently used one.
    const zero = rateKeyOf(v4(0));
    expect(lru.take(zero)).toEqual({ allowed: true, remaining: 28 });

    // evict-lru: a new key is admitted with a fresh bucket; exactly the LRU key is gone.
    const fresh = rateKeyOf('198.51.100.200');
    expect(lru.take(fresh)).toEqual({ allowed: true, remaining: 29 });
    expect(lru.size).toBe(MAX_BUCKET_KEYS);
    expect(lru.has(fresh)).toBe(true);
    expect(lru.has(zero)).toBe(true);
    expect(lru.has(rateKeyOf(v4(1)))).toBe(false);
    expect(lru.has(rateKeyOf(v4(2)))).toBe(true);
    // The evicted key starts over with a fresh bucket, evicting the next LRU (key 2).
    expect(lru.take(rateKeyOf(v4(1)))).toEqual({ allowed: true, remaining: 29 });
    expect(lru.has(rateKeyOf(v4(2)))).toBe(false);
    expect(lru.size).toBe(MAX_BUCKET_KEYS);
    // A live key keeps its spent budget through all of this.
    expect(lru.take(zero)).toEqual({ allowed: true, remaining: 27 });

    // refuse (the default): the new key is refused with the retry-after of the
    // soonest refill (one spent token at 30/10 s refills in 334 ms → 1 s), and
    // the set does not change.
    expect(refuse.take(fresh)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(refuse.size).toBe(MAX_BUCKET_KEYS);
    expect(refuse.has(fresh)).toBe(false);
    expect(refuse.has(rateKeyOf(v4(1)))).toBe(true);
    // Once buckets have refilled to capacity they are swept and the new key fits.
    clock.advance(334);
    expect(refuse.take(fresh)).toEqual({ allowed: true, remaining: 29 });
    expect(refuse.size).toBe(1);

    // The numeric third argument (worker/src/do/ingest/notify.ts) still means maxKeys with refuse.
    const small = new BucketSet(PER_IP_10S, clock, 2);
    expect(small.maxKeys).toBe(2);
    expect(small.onFull).toBe('refuse');
    expect(() => new BucketSet(PER_IP_10S, clock, { onFull: 'drop' as 'refuse' })).toThrowError(RangeError);
  });
});
