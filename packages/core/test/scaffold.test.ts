import { cryptoRandom, systemClock } from '@atmusic/core/deps';
import { DEFAULT_STATUS, ERROR_CODES, isErrorCode } from '@atmusic/core/errors';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';

const FROZEN_MS = Date.UTC(2026, 0, 15, 12, 0, 0, 0); // 1768478400000

describe('test-support determinism', () => {
  it('fixedClock starts at 2026-01-15T12:00:00Z and advance/set are exact', () => {
    const clock = fixedClock();
    expect(FROZEN_MS).toBe(1_768_478_400_000);
    expect(clock.nowMs()).toBe(FROZEN_MS);
    // It never moves on its own.
    expect(clock.nowMs()).toBe(FROZEN_MS);

    clock.advance(1);
    expect(clock.nowMs()).toBe(FROZEN_MS + 1);
    clock.advance(300_000);
    expect(clock.nowMs()).toBe(FROZEN_MS + 300_001);
    clock.advance(-300_001);
    expect(clock.nowMs()).toBe(FROZEN_MS);
    clock.advance(7 * 86_400_000);
    expect(new Date(clock.nowMs()).toISOString()).toBe('2026-01-22T12:00:00.000Z');

    clock.set('2025-01-15T12:00:00Z');
    expect(clock.nowMs()).toBe(Date.UTC(2025, 0, 15, 12));
    clock.set('2026-01-15T12:00:00.999Z');
    expect(clock.nowMs()).toBe(FROZEN_MS + 999);

    expect(fixedClock('2026-01-08T12:00:00Z').nowMs()).toBe(FROZEN_MS - 7 * 86_400_000);

    // Fractional or unsafe steps and ambiguous instants are refused, not rounded.
    expect(() => clock.advance(0.5)).toThrow(RangeError);
    expect(() => clock.advance(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(() => clock.set('2026-01-15')).toThrow(RangeError);
    expect(() => clock.set('2026-01-15T12:00:00+01:00')).toThrow(RangeError);
    expect(() => clock.set('2026-02-30T12:00:00Z')).toThrow(RangeError);
    expect(clock.nowMs()).toBe(FROZEN_MS + 999);

    // The production clock is a different object that reads real time.
    expect(systemClock.nowMs()).toBeGreaterThan(FROZEN_MS);
  });

  it('seeded Random is reproducible across runs', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const bytesA = a.bytes(37);
    const bytesB = b.bytes(37);
    expect(bytesA).toBeInstanceOf(Uint8Array);
    expect(bytesA.length).toBe(37);
    expect(Array.from(bytesA)).toEqual(Array.from(bytesB));
    const floatsA = Array.from({ length: 64 }, () => a.float());
    const floatsB = Array.from({ length: 64 }, () => b.float());
    expect(floatsA).toEqual(floatsB);
    for (const f of floatsA) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }

    // Golden: the first outputs for seed 1 are fixed forever, so a change in
    // the generator (which would silently change every TID and jitter in the
    // fixtures) fails here.
    const golden = seededRandom(1);
    const firstWords = [golden.nextUint32(), golden.nextUint32(), golden.nextUint32(), golden.nextUint32()];
    const again = seededRandom(1);
    expect([again.nextUint32(), again.nextUint32(), again.nextUint32(), again.nextUint32()]).toEqual(firstWords);
    // Reference values from an independent Python xorshift128/splitmix32.
    expect(firstWords).toEqual([3898016280, 503430273, 2109199260, 1781707058]);
    expect(Array.from(seededRandom(1).bytes(4))).toEqual([
      firstWords[0]! & 0xff,
      (firstWords[0]! >>> 8) & 0xff,
      (firstWords[0]! >>> 16) & 0xff,
      firstWords[0]! >>> 24,
    ]);

    // Different seeds diverge; the stream is not constant.
    expect(Array.from(seededRandom(2).bytes(16))).not.toEqual(Array.from(seededRandom(1).bytes(16)));
    expect(new Set(floatsA).size).toBe(64);

    // The production source is crypto-backed and supports large requests.
    expect(cryptoRandom.bytes(70_000).length).toBe(70_000);
    const f = cryptoRandom.float();
    expect(f >= 0 && f < 1).toBe(true);
  });
});

describe('error vocabulary', () => {
  it('every error code has a default HTTP status and the ADR codes are present', () => {
    for (const code of [
      'invalid_cursor',
      'queue_full',
      'rate_limited',
      'not_found',
      'validation_failed',
      'payload_too_large',
    ]) {
      expect(isErrorCode(code)).toBe(true);
    }
    expect(isErrorCode('invalid_idempotency_key')).toBe(false);
    expect(Object.keys(DEFAULT_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    expect(DEFAULT_STATUS.invalid_cursor).toBe(400);
    expect(DEFAULT_STATUS.payload_too_large).toBe(413);
    expect(DEFAULT_STATUS.validation_failed).toBe(422);
    expect(DEFAULT_STATUS.rate_limited).toBe(429);
    expect(DEFAULT_STATUS.queue_full).toBe(503);
  });
});
