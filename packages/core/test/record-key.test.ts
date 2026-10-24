import type { Clock } from '@atmusic/core/deps';
import { followRkey, isDidSyntax, isTid, newTid, parseTid, RecordKeyError } from '@atmusic/core/record-key';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import golden from '../../../tests/goldens/follow_rkeys.json';

const FROZEN_MS = 1_768_478_400_000; // 2026-01-15T12:00:00Z

interface GoldenEntry {
  subject: string;
  rkey: string | null;
  error: { code: string; field: string; message: string } | null;
}

describe('follow rkey', () => {
  it('followRkey equals follow_rkeys.json', async () => {
    const entries = (golden as { entries: GoldenEntry[] }).entries;
    // The golden covers accepted and rejected subjects; never an empty pass.
    expect(entries.length).toBe(12);
    expect(entries.filter((e) => e.rkey !== null).length).toBe(8);
    expect(entries.filter((e) => e.error !== null).length).toBe(4);

    for (const entry of entries) {
      if (entry.rkey !== null) {
        const rkey = await followRkey(entry.subject);
        expect(rkey, entry.subject).toBe(entry.rkey);
        expect(rkey).toMatch(/^f[0-9a-f]{64}$/);
        expect(isDidSyntax(entry.subject)).toBe(true);
      } else {
        expect(entry.error).not.toBeNull();
        const failure = await followRkey(entry.subject).then(
          () => null,
          (e: unknown) => e,
        );
        expect(failure, JSON.stringify(entry.subject)).toBeInstanceOf(RecordKeyError);
        // Same {code, field, message} as the Rust ValidationError JSON.
        expect(JSON.parse(JSON.stringify(failure))).toEqual(entry.error);
        expect(isDidSyntax(entry.subject)).toBe(false);
      }
    }

    // Hardcoded from the Rust contract test (crates/core/tests/contracts.rs follow_rkey):
    // deterministic, subject-specific, and no normalisation (case is significant).
    const bob = await followRkey('did:plc:bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(bob).toBe('f9a71cc1369cb0ae7a6fa16d2b9ecdc8d3ba62a9c519fe9af11a322c90e9ef6f2');
    expect(await followRkey('did:plc:bbbbbbbbbbbbbbbbbbbbbbbb')).toBe(bob);
    expect(await followRkey('did:plc:BBBBBBBBBBBBBBBBBBBBBBBB')).not.toBe(bob);
    expect(await followRkey('did:plc:cccccccccccccccccccccccc')).not.toBe(bob);

    // validate_did_syntax edge cases beyond the golden: method must be lowercase,
    // % escapes must be complete hex, no trailing ':', 2,048-byte cap, no non-ASCII.
    for (const bad of [
      'did:PLC:abc',
      'did:web:a%2',
      'did:web:a%zz',
      'did:web:a:',
      'did::abc',
      'DID:plc:abc',
      `did:plc:${'a'.repeat(2_041)}`,
      'did:plc:abé',
      'did:plc:a/b',
    ]) {
      await expect(followRkey(bad), bad).rejects.toBeInstanceOf(RecordKeyError);
    }
    expect(await followRkey(`did:plc:${'a'.repeat(2_040)}`)).toMatch(/^f[0-9a-f]{64}$/);
    expect(await followRkey('did:web:a%2Fb')).toMatch(/^f[0-9a-f]{64}$/);
  });
});

describe('TID', () => {
  it('TIDs are monotonic and valid for fixed clock and seeded random', () => {
    const clock = fixedClock();
    expect(clock.nowMs()).toBe(FROZEN_MS);
    const random = seededRandom(1);

    // Golden values from an independent Python encoder: µs = FROZEN_MS * 1000,
    // clock id = first seeded(1) word 3898016280 & 0x3ff = 536.
    const first = newTid(clock, random);
    expect(first).toBe('3mchjvhag22ks');
    expect(parseTid(first)).toEqual({ micros: BigInt(FROZEN_MS) * 1000n, clockId: 536 });
    // The clock stands still: the timestamp part still strictly increases.
    const tids = [first, newTid(clock, random), newTid(clock, random)];
    expect(tids.slice(1)).toEqual(['3mchjvhag23ks', '3mchjvhag24ks']);

    for (let i = 0; i < 497; i++) tids.push(newTid(clock, random)); // 500 TIDs in one ms
    expect(parseTid(tids[499]!).micros).toBe(BigInt(FROZEN_MS) * 1000n + 499n);
    clock.advance(1);
    tids.push(newTid(clock, random)); // index 500: back on the clock's µs
    expect(tids[500]).toBe('3mchjvhagzcks');
    expect(parseTid(tids[500]!).micros).toBe(BigInt(FROZEN_MS + 1) * 1000n);
    // A clock that moves backwards never produces a smaller TID.
    clock.set('2026-01-15T11:00:00Z');
    tids.push(newTid(clock, random));
    tids.push(newTid(clock, random));
    expect(parseTid(tids[502]!).micros).toBe(BigInt(FROZEN_MS + 1) * 1000n + 2n);
    // More than 1,000 TIDs in one ms run ahead of the clock instead of colliding.
    clock.set('2026-01-15T12:00:00.002Z');
    for (let i = 0; i < 1_500; i++) tids.push(newTid(clock, random));
    expect(parseTid(tids.at(-1)!).micros).toBe(BigInt(FROZEN_MS + 2) * 1000n + 1_499n);
    clock.advance(1);
    tids.push(newTid(clock, random));
    expect(parseTid(tids.at(-1)!).micros).toBe(BigInt(FROZEN_MS + 2) * 1000n + 1_500n);

    for (const tid of tids) {
      expect(tid).toHaveLength(13);
      expect(isTid(tid)).toBe(true);
      // Top bit 0 => first char in the low half of the alphabet.
      expect('234567ab').toContain(tid[0]);
      const { micros, clockId } = parseTid(tid);
      expect(micros < 2n ** 53n).toBe(true);
      expect(micros >= BigInt(FROZEN_MS) * 1000n).toBe(true);
      expect(clockId).toBe(536);
    }
    // Strictly increasing both as strings (base32-sortable) and as timestamps.
    for (let i = 1; i < tids.length; i++) {
      expect(tids[i - 1]! < tids[i]!, `${tids[i - 1]} < ${tids[i]}`).toBe(true);
      expect(parseTid(tids[i - 1]!).micros < parseTid(tids[i]!).micros).toBe(true);
    }
    expect(new Set(tids).size).toBe(tids.length);
    expect(tids.length).toBe(2_004);

    // Determinism: a fresh clock and the same seed reproduce the exact sequence.
    const replayClock = fixedClock();
    const replayRandom = seededRandom(1);
    const replay = Array.from({ length: 500 }, () => newTid(replayClock, replayRandom));
    expect(replay).toEqual(tids.slice(0, 500));

    // Another seed gives another clock id; the sequence per clock is independent.
    const other = newTid(fixedClock(), seededRandom(7));
    expect(parseTid(other).micros).toBe(BigInt(FROZEN_MS) * 1000n);
    expect(other).not.toBe(first);

    // Bad clocks are refused, not truncated.
    const fractional: Clock = { nowMs: () => 1.5 };
    expect(() => newTid(fractional, seededRandom(1))).toThrow(RangeError);
    expect(() => newTid({ nowMs: () => -1 }, seededRandom(1))).toThrow(RangeError);
    // Syntax: wrong length, alphabet or top bit is rejected.
    for (const bad of ['3mchjvhag22k', '3mchjvhag22ks2', '3mchjvhag22k1', 'kmchjvhag22ks', '3MCHJVHAG22KS']) {
      expect(isTid(bad), bad).toBe(false);
      expect(() => parseTid(bad)).toThrow(SyntaxError);
    }
  });
});
