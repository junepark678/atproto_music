/// <reference types="vite/client" />

import { fixedClock } from '@atmusic/core/test-support/clock';
import {
  addSeconds,
  fromMs,
  MSG_BOUNDS,
  nowNs,
  parseRfc3339,
  STORAGE_LENGTH,
  toDto,
  toMs,
  toRecordDatetime,
  toStorage,
  validateTimestamp,
} from '@atmusic/core/timestamp';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import timestampsJson from '../../../tests/goldens/timestamps.json?raw';

interface Entry {
  input: string;
  accepted: boolean;
  epochNs: string | null;
  storage: string | null;
  dto: string | null;
  error: { code: string; field: string; message: string } | null;
}
interface Render {
  receiptInstant: string;
  epochNs: string;
  recordCreatedAt: string;
}
const golden = JSON.parse(timestampsJson) as {
  receiptTime: string;
  entries: Entry[];
  recordCreatedAtRenders: Render[];
};

const RECEIPT_NS = 1_768_478_400_000_000_000n; // 2026-01-15T12:00:00Z
const MAX_NS = 253_402_300_799_999_999_999n; // 9999-12-31T23:59:59.999999999Z
const MIN_NS = -62_167_219_200_000_000_000n; // 0000-01-01T00:00:00Z

it('storage form is fixed-width 30 chars and text order equals time order', () => {
  // Hand-picked instants across eras, digits and the epoch.
  const instants = [
    MIN_NS,
    -1n,
    0n,
    1n,
    999_999_999n,
    1_000_000_000n,
    946_684_799_000_000_000n,
    946_684_800_000_000_000n,
    RECEIPT_NS - 1n,
    RECEIPT_NS,
    RECEIPT_NS + 1n,
    MAX_NS,
  ];
  const rendered = instants.map(toStorage);
  expect(rendered[0]).toBe('0000-01-01T00:00:00.000000000Z');
  expect(rendered[1]).toBe('1969-12-31T23:59:59.999999999Z');
  expect(rendered[2]).toBe('1970-01-01T00:00:00.000000000Z');
  expect(rendered[9]).toBe('2026-01-15T12:00:00.000000000Z');
  expect(rendered[11]).toBe('9999-12-31T23:59:59.999999999Z');
  for (const s of rendered) {
    expect(s).toHaveLength(STORAGE_LENGTH);
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/);
  }
  // Strictly increasing instants render to strictly increasing text.
  expect([...rendered].sort()).toEqual(rendered);
  expect(new Set(rendered).size).toBe(rendered.length);

  // Property: for any two instants, string comparison equals numeric comparison,
  // and the storage form parses back to the same instant (seeded, deterministic).
  const ns = fc.bigInt({ min: 0n, max: MAX_NS });
  fc.assert(
    fc.property(ns, ns, (a, b) => {
      const sa = toStorage(a);
      const sb = toStorage(b);
      expect(sa).toHaveLength(30);
      expect(sb).toHaveLength(30);
      expect(sa < sb).toBe(a < b);
      expect(sa === sb).toBe(a === b);
      expect(parseRfc3339(sa)).toBe(a);
      expect(toDto(a)).toBe(sa);
    }),
    { seed: 20_260_115, numRuns: 3000 },
  );

  // Outside four-digit years the fixed width cannot hold: refused, never widened.
  expect(() => toStorage(MAX_NS + 1n)).toThrow(RangeError);
  expect(() => toStorage(MIN_NS - 1n)).toThrow(RangeError);
});

it('every timestamps.json vector round-trips to the Rust storage and DTO forms', () => {
  expect(golden.receiptTime).toBe('2026-01-15T12:00:00Z');
  expect(parseRfc3339(golden.receiptTime)).toBe(RECEIPT_NS);
  expect(golden.entries).toHaveLength(33);
  let accepted = 0;
  for (const e of golden.entries) {
    const result = validateTimestamp('listenedAt', e.input, RECEIPT_NS);
    expect({ input: e.input, ok: result.ok }).toEqual({ input: e.input, ok: e.accepted });
    if (result.ok) {
      accepted++;
      expect(result.ns).toBe(BigInt(e.epochNs ?? 'x'));
      expect(toStorage(result.ns)).toBe(e.storage);
      expect(toDto(result.ns)).toBe(e.dto);
      // The storage form is itself an accepted datetime denoting the same instant.
      expect(parseRfc3339(e.storage ?? '')).toBe(result.ns);
    } else {
      expect(result.reason).toEqual(e.error);
    }
  }
  expect(accepted).toBe(golden.entries.filter((e) => e.accepted).length);
  expect(accepted).toBeGreaterThan(0);
  expect(golden.entries.some((e) => e.error?.message === MSG_BOUNDS)).toBe(true);

  // Record createdAt renders (chrono AutoSi): 0, 3, 6 or 9 fraction digits.
  expect(golden.recordCreatedAtRenders).toHaveLength(9);
  for (const r of golden.recordCreatedAtRenders) {
    const n = parseRfc3339(r.receiptInstant);
    expect(n).toBe(BigInt(r.epochNs));
    expect(toRecordDatetime(BigInt(r.epochNs))).toBe(r.recordCreatedAt);
  }

  // ms helpers and the injected clock.
  expect(fromMs(1_768_478_400_123)).toBe(1_768_478_400_123_000_000n);
  expect(toMs(1_768_478_400_123_999_999n)).toBe(1_768_478_400_123);
  expect(toMs(-1n)).toBe(-1);
  expect(addSeconds(RECEIPT_NS, 300)).toBe(1_768_478_700_000_000_000n);
  expect(addSeconds(RECEIPT_NS, -1)).toBe(RECEIPT_NS - 1_000_000_000n);
  const clock = fixedClock();
  expect(nowNs(clock)).toBe(RECEIPT_NS);
  clock.advance(1);
  expect(toStorage(nowNs(clock))).toBe('2026-01-15T12:00:00.001000000Z');
  expect(() => fromMs(0.5)).toThrow(RangeError);
  expect(() => addSeconds(0n, 1.5)).toThrow(RangeError);
});
