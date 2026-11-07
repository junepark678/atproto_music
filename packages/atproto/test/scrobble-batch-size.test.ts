import { encode } from '@atcute/cbor';
import type { ScrobbleBatchEntry, ScrobbleBatchRecord } from '@atmusic/core/scrobble-batch';
import {
  MAX_CBOR_BYTES,
  MAX_CREATE_BODY_BYTES,
  MAX_WRITE_BODY_BYTES,
  packScrobbleBatchEntries,
} from '@atmusic/core/scrobble-batch';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  fitsScrobbleBatch,
  jsonBodyBytes,
  measureScrobbleBatch,
  scrobbleBatchSizer,
  sendableScrobbleBatch,
} from '../src/scrobble-batch-size';

const record = {
  $type: 'org.example.music.scrobbleBatch',
  createdAt: '2026-01-15T12:00:00.000Z',
  listens: [
    {
      id: '3jzfcijpj2z2a',
      artist: 'Björk',
      track: 'Jóga',
      listenedAt: '2026-01-15T11:59:00.000Z',
      createdAt: '2026-01-15T12:00:00.000Z',
    },
  ],
};
const request = {
  repo: 'did:plc:abcdefghijklmnopqrstuvwx',
  collection: 'org.example.music.scrobbleBatch',
  rkey: '3jzfcijpj2z2a',
};

// An independent oracle: exact DAG-CBOR and JSON byte counts computed by
// arithmetic over the value, sharing no code with either encoder.
const utf8Bytes = (s: string) => {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
};
const header = (n: number) => (n < 24 ? 1 : n < 0x100 ? 2 : n < 0x10000 ? 3 : n < 2 ** 32 ? 5 : 9);
function cborSize(v: unknown): number {
  if (v === null || typeof v === 'boolean') return 1;
  if (typeof v === 'number') return header(v < 0 ? -1 - v : v);
  if (typeof v === 'string') return header(utf8Bytes(v)) + utf8Bytes(v);
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + cborSize(x), header(v.length));
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.reduce((n, [k, x]) => n + cborSize(k) + cborSize(x), header(entries.length));
}
function jsonStringSize(s: string): number {
  let n = 2;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '"' || ch === '\\' || ch === '\b' || ch === '\f' || ch === '\n' || ch === '\r' || ch === '\t') n += 2;
    else if (c < 0x20) n += 6;
    else n += utf8Bytes(ch);
  }
  return n;
}
function jsonSize(v: unknown): number {
  if (v === null) return 4;
  if (typeof v === 'boolean') return v ? 4 : 5;
  if (typeof v === 'number') return String(v).length;
  if (typeof v === 'string') return jsonStringSize(v);
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + jsonSize(x), 2 + Math.max(0, v.length - 1));
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.reduce((n, [k, x]) => n + jsonStringSize(k) + 1 + jsonSize(x), 2 + Math.max(0, entries.length - 1));
}
const independent = (candidate: ScrobbleBatchRecord) => ({
  cborBytes: cborSize(candidate),
  createBodyBytes: jsonSize({ ...request, record: candidate }),
});

/** Arbitrary entries within the validator's field bounds, escape-rich and multibyte text included. */
const text = (max: number) =>
  fc
    .array(
      fc.oneof(
        fc.constantFrom('a', 'é', '雪', '🎵', '"', '\\', '\n', '\u0001', '\u001f', ' ', ' '),
        fc.string({ maxLength: 1 }),
      ),
      { minLength: 1, maxLength: max },
    )
    .map((parts) => parts.join(''))
    .filter((s) => s.length > 0 && utf8Bytes(s) <= 1_024);
const uuid = fc.uuid();
const entry: fc.Arbitrary<ScrobbleBatchEntry> = fc
  .record(
    {
      id: fc.constant('3jzfcijpj2z2a'),
      artist: text(256),
      track: text(256),
      album: text(256),
      albumArtist: text(256),
      listenedAt: fc.constantFrom('1970-01-01T00:00:00Z', '2026-01-15T11:59:00.123456789Z'),
      createdAt: fc.constantFrom('2026-01-15T12:00:00.000Z'),
      durationSeconds: fc.constantFrom(1, 23, 24, 255, 256, 9_999, 65_535, 65_536, 86_400),
      trackNumber: fc.constantFrom(1, 23, 24, 255, 256, 9_999),
      recordingMbid: uuid,
      releaseMbid: uuid,
      releaseGroupMbid: uuid,
      artistMbids: fc.array(uuid, { minLength: 1, maxLength: 10 }),
      isrc: fc.constant('USRC17607839'),
      submissionClient: text(64),
      musicService: fc.constantFrom('spotify.com', 'listenbrainz.org'),
    },
    { requiredKeys: ['id', 'artist', 'track', 'listenedAt', 'createdAt'] },
  )
  .map((value) => ({ ...value }) as ScrobbleBatchEntry);

describe('scrobbleBatch size', () => {
  it('counts DAG-CBOR and exact UTF-8 JSON request bytes', () => {
    const measured = measureScrobbleBatch(record, request);
    const expectedBody = JSON.stringify({ ...request, record });
    expect(measured.createBodyBytes).toBe(new TextEncoder().encode(expectedBody).byteLength);
    expect(measured).toEqual(independent(record));
    expect(measured.cborBytes).toBe(new Uint8Array(encode(record)).byteLength);
    expect(fitsScrobbleBatch(measured)).toBe(true);
  });

  it('uses inclusive exact bounds', () => {
    expect(fitsScrobbleBatch({ cborBytes: MAX_CBOR_BYTES, createBodyBytes: MAX_CREATE_BODY_BYTES })).toBe(true);
    expect(fitsScrobbleBatch({ cborBytes: MAX_CBOR_BYTES + 1, createBodyBytes: 1 })).toBe(false);
    expect(fitsScrobbleBatch({ cborBytes: 1, createBodyBytes: MAX_CREATE_BODY_BYTES + 1 })).toBe(false);
    // A durable container stays sendable up to the hard write ceiling, above the packing target.
    expect(sendableScrobbleBatch({ cborBytes: MAX_CBOR_BYTES, createBodyBytes: MAX_WRITE_BODY_BYTES })).toBe(true);
    expect(sendableScrobbleBatch({ cborBytes: 1, createBodyBytes: MAX_WRITE_BODY_BYTES + 1 })).toBe(false);
    expect(sendableScrobbleBatch({ cborBytes: MAX_CBOR_BYTES + 1, createBodyBytes: 1 })).toBe(false);
  });

  it('counts non-ASCII as UTF-8 bytes rather than JS string length', () => {
    const unicodeRecord: ScrobbleBatchRecord = { ...record, listens: [{ ...record.listens[0]!, artist: '🎵' }] };
    const measured = measureScrobbleBatch(unicodeRecord, request);
    expect(measured.createBodyBytes).toBeGreaterThan(JSON.stringify(unicodeRecord).length);
    expect(measured).toEqual(independent(unicodeRecord));
  });

  it('checks independently encoded records immediately below and above each byte cap', () => {
    const make = (track: string): ScrobbleBatchRecord => ({ ...record, listens: [{ ...record.listens[0]!, track }] });
    const largest = (limit: number, size: (candidate: ScrobbleBatchRecord) => number, char: string) => {
      let low = 0;
      let high = limit + 1;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (size(make(char.repeat(middle))) <= limit) low = middle;
        else high = middle;
      }
      return low;
    };
    // ASCII, a JSON escape (two bytes in JSON, one in CBOR), a control character
    // (six JSON bytes) and multibyte text: the body limit binds first every time.
    for (const char of ['x', '"', '\u0001', '雪', '🎵']) {
      const length = largest(MAX_CREATE_BODY_BYTES, (candidate) => independent(candidate).createBodyBytes, char);
      const at = make(char.repeat(length));
      const over = make(char.repeat(length + 1));
      expect(independent(at).createBodyBytes).toBeLessThanOrEqual(MAX_CREATE_BODY_BYTES);
      expect(independent(over).createBodyBytes).toBeGreaterThan(MAX_CREATE_BODY_BYTES);
      expect(independent(at).cborBytes).toBeLessThan(MAX_CBOR_BYTES);
      expect(measureScrobbleBatch(at, request)).toEqual(independent(at));
      expect(measureScrobbleBatch(over, request)).toEqual(independent(over));
      expect(fitsScrobbleBatch(measureScrobbleBatch(at, request))).toBe(true);
      expect(fitsScrobbleBatch(measureScrobbleBatch(over, request))).toBe(false);
    }
  });

  it('the additive sizer equals whole-record encoding across every CBOR array-header width', () => {
    fc.assert(
      fc.property(
        fc.array(entry, { minLength: 1, maxLength: 40 }),
        fc.constantFrom(1, 23, 24, 255, 256, 1_000, 2_500),
        (pool, count) => {
          const listens = Array.from({ length: count }, (_, i) => pool[i % pool.length] as ScrobbleBatchEntry);
          const envelope = { $type: record.$type, createdAt: record.createdAt };
          const sizer = scrobbleBatchSizer(envelope, request);
          const frame = sizer.frame(count);
          const sum = listens.reduce(
            (n, item) => {
              const own = sizer.entry(item);
              return {
                cborBytes: n.cborBytes + own.cborBytes,
                createBodyBytes: n.createBodyBytes + own.createBodyBytes,
              };
            },
            { cborBytes: frame.cborBytes, createBodyBytes: frame.createBodyBytes },
          );
          const whole = { ...envelope, listens };
          expect(sum).toEqual(measureScrobbleBatch(whole, request));
          expect(sum).toEqual(independent(whole));
        },
      ),
      { numRuns: 60 },
    );
  });

  it('a container of validated entries never has more DAG-CBOR than JSON', () => {
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1, maxLength: 30 }), (listens) => {
        const candidate = { ...record, listens };
        expect(independent(candidate).cborBytes).toBeLessThan(jsonSize(candidate));
        expect(new Uint8Array(encode(candidate)).byteLength).toBeLessThan(jsonBodyBytes(candidate));
      }),
      { numRuns: 300 },
    );
  });

  it('packs >1,000 escape-rich listens to the largest fitting prefix; the next listen is rejected', () => {
    const listens = Array.from({ length: 9_000 }, (_, i) => ({
      ...record.listens[0]!,
      id: `3jzfcij${String(i)
        .padStart(6, '2')
        .replace(/[0189]/g, 'a')}`,
      artist: `Sigur Rós "${i % 13}"`,
      track: `Hoppípolla\\${i}\n🎵`,
      album: `Takk… ${'雪'.repeat(20)}`,
    }));
    const envelope = { $type: record.$type, createdAt: record.createdAt };
    const measure = (entries: readonly ScrobbleBatchEntry[]) =>
      measureScrobbleBatch({ ...envelope, listens: [...entries] }, request);
    const packed = packScrobbleBatchEntries(listens, { measure, sizer: scrobbleBatchSizer(envelope, request) });
    expect(packed.length).toBeGreaterThan(1);
    let offset = 0;
    for (const [i, group] of packed.entries()) {
      expect(group.entries.length).toBeGreaterThan(i < packed.length - 1 ? 1_000 : 0);
      expect(measure(group.entries)).toEqual({ cborBytes: group.cborBytes, createBodyBytes: group.createBodyBytes });
      expect(group.createBodyBytes).toBeLessThanOrEqual(MAX_CREATE_BODY_BYTES);
      offset += group.entries.length;
      const next = listens[offset];
      if (i < packed.length - 1 && next !== undefined)
        expect(measure([...group.entries, next]).createBodyBytes).toBeGreaterThan(MAX_CREATE_BODY_BYTES);
    }
    expect(offset).toBe(listens.length);
  });
});
