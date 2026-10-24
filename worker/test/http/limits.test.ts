// Notify rate buckets (ADR 0004 §8, M6.2.1 rate_boundary and bounded_state):
// exact refill under the injected clock, and a bounded key set.

import { fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';
import { BucketSet, DID_RATE, IP_RATE, MAX_BUCKET_KEYS, type RateDecision, TokenBucket } from '../../src/http/limits';

const IP = '203.0.113.7';

function takeN(set: BucketSet, key: string, n: number): RateDecision[] {
  return Array.from({ length: n }, () => set.take(key));
}
const allowed = (ds: RateDecision[]) => ds.filter((d) => d.allowed).length;

it('bucket refills exactly with injected clock; 61st request in a minute is limited', () => {
  expect(IP_RATE).toEqual({ capacity: 60, windowMs: 60_000 });
  expect(DID_RATE).toEqual({ capacity: 600, windowMs: 3_600_000 });

  const clock = fixedClock();
  const ips = new BucketSet(IP_RATE, clock);

  // 60 requests at one instant pass, counting down; the 61st is limited.
  const burst = takeN(ips, IP, 60);
  expect(burst.every((d) => d.allowed)).toBe(true);
  expect(burst.map((d) => (d.allowed ? d.remaining : -1))).toEqual(Array.from({ length: 60 }, (_, i) => 59 - i));
  expect(ips.take(IP)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  // Another IP has its own bucket.
  expect(ips.take('198.51.100.1')).toEqual({ allowed: true, remaining: 59 });

  // Exactly one token returns every 1,000 ms: not at 999 ms, exactly at 1,000 ms.
  clock.advance(999);
  expect(ips.take(IP)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  clock.advance(1);
  expect(ips.take(IP)).toEqual({ allowed: true, remaining: 0 });
  expect(ips.take(IP).allowed).toBe(false);

  // After 59 more seconds exactly 59 more requests pass.
  clock.advance(59_000);
  expect(allowed(takeN(ips, IP, 70))).toBe(59);

  // Within the minute that started at t0 + 1 s, the IP got 1 + 59 = 60 requests; a full
  // idle minute restores the whole burst and no more.
  clock.advance(60_000);
  expect(allowed(takeN(ips, IP, 61))).toBe(60);
  clock.advance(10 * 60_000);
  expect(allowed(takeN(ips, IP, 100))).toBe(60);

  // A clock stepping backwards mints nothing.
  clock.advance(-30_000);
  expect(ips.take(IP).allowed).toBe(false);
  clock.advance(30_000);
  expect(ips.take(IP).allowed).toBe(false);
  clock.advance(1_000);
  expect(ips.take(IP).allowed).toBe(true);

  // Per DID: 600 per hour, one token every 6 s, Retry-After rounded up to whole seconds.
  const didClock = fixedClock();
  const did = new TokenBucket(DID_RATE, didClock);
  expect(allowed(Array.from({ length: 601 }, () => did.take()))).toBe(600);
  expect(did.take()).toEqual({ allowed: false, retryAfterSeconds: 6 });
  didClock.advance(5_001);
  expect(did.take()).toEqual({ allowed: false, retryAfterSeconds: 1 });
  didClock.advance(998);
  expect(did.take()).toEqual({ allowed: false, retryAfterSeconds: 1 });
  expect(did.tokens()).toBe(0);
  didClock.advance(1);
  expect(did.tokens()).toBe(1);
  expect(did.take()).toEqual({ allowed: true, remaining: 0 });
  expect(did.isFull()).toBe(false);
  didClock.advance(3_600_000);
  expect(did.isFull()).toBe(true);
  expect(did.tokens()).toBe(600);

  expect(() => new TokenBucket({ capacity: 0, windowMs: 1000 }, clock)).toThrow(RangeError);
  expect(() => new BucketSet({ capacity: 1, windowMs: 1.5 }, clock)).toThrow(RangeError);
});

it('10,001 distinct IP keys keep BucketSet at its cap and expired buckets are evicted', () => {
  expect(MAX_BUCKET_KEYS).toBe(10_000);
  const clock = fixedClock();
  const set = new BucketSet(IP_RATE, clock);
  const key = (i: number) => `10.${(i >> 16) & 0xff}.${(i >> 8) & 0xff}.${i & 0xff}`;

  for (let i = 0; i < 10_000; i++) expect(set.take(key(i)).allowed).toBe(true);
  expect(set.size).toBe(10_000);

  // The 10,001st distinct key is refused and the set does not grow.
  expect(set.take(key(10_000))).toEqual({ allowed: false, retryAfterSeconds: 1 });
  expect(set.size).toBe(10_000);
  expect(set.has(key(10_000))).toBe(false);
  // Known keys keep working at the cap.
  expect(set.take(key(0))).toEqual({ allowed: true, remaining: 58 });
  expect(set.size).toBe(10_000);

  // After 1 s every bucket that spent one token is full again, so it is evicted.
  // key(0) spent two and stays; the new key is admitted.
  clock.advance(1_000);
  expect(set.take(key(10_000))).toEqual({ allowed: true, remaining: 59 });
  expect(set.size).toBe(2);
  expect(set.has(key(0))).toBe(true);
  expect(set.has(key(1))).toBe(false);
  expect(set.has(key(9_999))).toBe(false);
  // An evicted key starts again from a full bucket: eviction loses no limit.
  expect(allowed(takeN(set, key(1), 61))).toBe(60);
  expect(set.size).toBe(3);

  // Without pressure, one sweep per window drops every idle bucket.
  clock.advance(IP_RATE.windowMs);
  expect(set.take('192.0.2.1').allowed).toBe(true);
  expect(set.size).toBe(1);

  // A set that is full of busy buckets refuses new keys until the soonest one refills.
  const small = new BucketSet(IP_RATE, clock, 3);
  takeN(small, 'a', 60);
  takeN(small, 'b', 30);
  takeN(small, 'c', 10);
  expect(small.take('d')).toEqual({ allowed: false, retryAfterSeconds: 10 });
  expect(small.size).toBe(3);
  clock.advance(10_000);
  expect(small.take('d').allowed).toBe(true);
  expect(small.size).toBe(3);
  expect(small.has('c')).toBe(false);
});
