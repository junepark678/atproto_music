import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import { validateScrobbleRecord } from '@atmusic/core/scrobble';
import {
  type AdditiveBatchSizer,
  BATCH_MAX_LISTENS,
  buildScrobbleBatchRecord,
  formatScrobbleBatchListenUri,
  MAX_CBOR_BYTES,
  MAX_CREATE_BODY_BYTES,
  MAX_INGEST_CBOR_BYTES,
  MAX_SWAP_CID_CHARS,
  MAX_WRITE_BODY_BYTES,
  MIN_ENTRY_JSON_BYTES,
  newBatchPrefix,
  PDS_JSON_BODY_LIMIT_BYTES,
  PUT_SWAP_RESERVE_BYTES,
  packScrobbleBatchEntries,
  parseScrobbleBatchListenUri,
  validateScrobbleBatchRecord,
  WRITE_SAFETY_MARGIN_BYTES,
} from '@atmusic/core/scrobble-batch';
import { fixedClock } from '@atmusic/core/test-support/clock';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const receipt = 1_768_478_400_000_000_000n;
const validEntry = (over: Record<string, unknown> = {}) => ({
  id: '3jzfcijpj2z2a',
  artist: 'Björk',
  track: 'Jóga',
  listenedAt: '2026-01-15T11:00:00Z',
  createdAt: '2026-01-15T11:00:00Z',
  ...over,
});
const envelope = (listens: unknown[], over: Record<string, unknown> = {}) => ({
  $type: `${FIXTURE_PREFIX}.scrobbleBatch`,
  createdAt: '2026-01-15T12:00:00Z',
  listens,
  ...over,
});

describe('scrobbleBatch contract', () => {
  it('validates each entry through the single scrobble validator and preserves createdAt', () => {
    const result = validateScrobbleBatchRecord(
      envelope([validEntry({ durationSeconds: 60, unknownRemote: true })]),
      FIXTURE_PREFIX,
      receipt,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.listens).toHaveLength(1);
    expect(result.row.listens[0]?.row.record.createdAt).toBe('2026-01-15T11:00:00Z');
    expect(result.row.record.listens[0]).toEqual({
      id: '3jzfcijpj2z2a',
      artist: 'Björk',
      track: 'Jóga',
      listenedAt: '2026-01-15T11:00:00Z',
      createdAt: '2026-01-15T11:00:00Z',
      durationSeconds: 60,
    });
  });

  it('property-checks single/batch parity across every optional scrobble field', () => {
    const optionalValues: Record<string, unknown> = {
      album: 'Album',
      durationSeconds: 240,
      recordingMbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
      albumArtist: 'Björk',
      trackNumber: 7,
      artistMbids: ['3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10'],
      releaseMbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
      releaseGroupMbid: '4f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
      isrc: 'USRC17607839',
      submissionClient: 'Pano Scrobbler',
      musicService: 'spotify.com',
    };
    fc.assert(
      fc.property(fc.subarray(Object.keys(optionalValues)), (fields) => {
        const optional = Object.fromEntries(fields.map((field) => [field, optionalValues[field]]));
        const entry = validEntry(optional);
        const single = validateScrobbleRecord(
          { $type: `${FIXTURE_PREFIX}.scrobble`, ...entry },
          FIXTURE_PREFIX,
          receipt,
        );
        const batch = validateScrobbleBatchRecord(envelope([entry]), FIXTURE_PREFIX, receipt);
        expect(single.ok).toBe(true);
        expect(batch.ok).toBe(true);
        if (!single.ok || !batch.ok) return;
        expect(batch.row.listens[0]?.row).toEqual(single.row);
        expect(batch.row.record.listens[0]?.createdAt).toBe(entry.createdAt);
      }),
      { numRuns: 100 },
    );
  });

  it('property-checks that invalid required or optional fields produce the same single failure and batch drop', () => {
    const invalids: Array<[string, unknown]> = [
      ['artist', ''],
      ['track', 'x'.repeat(257)],
      ['album', ' '],
      ['durationSeconds', 0],
      ['recordingMbid', 'not-a-uuid'],
      ['albumArtist', ' '],
      ['trackNumber', 10_000],
      ['artistMbids', []],
      ['releaseMbid', 'bad'],
      ['releaseGroupMbid', 'bad'],
      ['isrc', 'usrc17607839'],
      ['submissionClient', ' '],
      ['musicService', 'localhost'],
    ];
    fc.assert(
      fc.property(fc.constantFrom(...invalids), ([field, value]) => {
        const entry = validEntry({ [field]: value });
        const single = validateScrobbleRecord(
          { $type: `${FIXTURE_PREFIX}.scrobble`, ...entry },
          FIXTURE_PREFIX,
          receipt,
        );
        const batch = validateScrobbleBatchRecord(envelope([entry]), FIXTURE_PREFIX, receipt);
        expect(batch.ok).toBe(true);
        if (!batch.ok) return;
        if (single.ok) {
          expect(batch.row.dropped).toEqual([]);
          expect(batch.row.listens[0]?.row.record).toEqual(single.row.record);
          expect(batch.row.listens[0]?.row.dropped).toEqual(single.row.dropped);
        } else {
          expect(batch.row.dropped).toEqual([{ id: entry.id, reason: single.reason }]);
          expect(batch.row.listens).toEqual([]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('drops only invalid entries while malformed envelope bounds reject the whole record', () => {
    const result = validateScrobbleBatchRecord(
      envelope([validEntry(), validEntry({ id: '3jzfcijpj2z2b', artist: '' })]),
      FIXTURE_PREFIX,
      receipt,
    );
    expect(result.ok && result.row.listens).toHaveLength(1);
    expect(result.ok && result.row.dropped.map((x) => x.id)).toEqual(['3jzfcijpj2z2b']);
    expect(validateScrobbleBatchRecord(envelope([]), FIXTURE_PREFIX, receipt)).toMatchObject({
      ok: false,
      reason: { field: 'listens' },
    });
    expect(validateScrobbleBatchRecord(envelope([validEntry(), validEntry()]), FIXTURE_PREFIX, receipt)).toMatchObject({
      ok: false,
      reason: { field: 'listens' },
    });
  });

  it('builds a batch with stable TID entry ids and a separate envelope timestamp', () => {
    const result = buildScrobbleBatchRecord(
      [{ id: '3jzfcijpj2z2a', listen: { artist: ' Björk ', track: 'Jóga', listenedAt: '2026-01-15T11:00:00Z' } }],
      FIXTURE_PREFIX,
      fixedClock('2026-01-15T12:00:00Z'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.createdAt).toBe('2026-01-15T12:00:00Z');
      expect(result.record.listens[0]).toMatchObject({
        id: '3jzfcijpj2z2a',
        artist: 'Björk',
        createdAt: '2026-01-15T12:00:00Z',
      });
      expect(result.record.listens[0]).not.toHaveProperty('$type');
    }
  });
});

describe('batch listen URI', () => {
  const uri = 'at://did:plc:abcdefghijklmnopqrstuvwx/org.example.music.scrobbleBatch/3jzfcijpj2z2a';
  it('round trips a listen fragment and returns fragment-free proof target', () => {
    const listenUri = formatScrobbleBatchListenUri(uri, '3jzfcijpj2z2b');
    expect(listenUri).toBe(`${uri}#3jzfcijpj2z2b`);
    expect(parseScrobbleBatchListenUri(listenUri)).toEqual({ containerUri: uri, listenId: '3jzfcijpj2z2b' });
  });

  it('rejects malformed authority, non-batch collections and bad fragments', () => {
    for (const value of [
      'at://not-a-did/org.example.music.scrobbleBatch/rkey#3jzfcijpj2z2a',
      'at://did:plc:abcdefghijklmnopqrstuvwx/org.example.music.scrobble/rkey#3jzfcijpj2z2a',
      'at://did:plc:abcdefghijklmnopqrstuvwx/org.example.music.scrobbleBatch/rkey#3jzfcijpj2z2a',
      'at://did:plc:abcdefghijklmnopqrstuvwx/Org.example.music.scrobbleBatch/3jzfcijpj2z2a#3jzfcijpj2z2a',
      `${uri}#bad`,
      `${uri}#3jzfcijpj2z2a#extra`,
    ])
      expect(parseScrobbleBatchListenUri(value)).toBeNull();
  });
});

it('packs in stable order under both supplied exact size limits', () => {
  const result = packScrobbleBatchEntries([1, 2, 3], {
    maxCount: 2,
    measure: (entries) => ({ cborBytes: entries.length * 4, createBodyBytes: entries.length * 5 }),
  });
  expect(result.map((x) => x.entries)).toEqual([[1, 2], [3]]);
  expect(() =>
    packScrobbleBatchEntries([1], { measure: () => ({ cborBytes: MAX_CBOR_BYTES + 1, createBodyBytes: 1 }) }),
  ).toThrow(/exceeds/);
  expect(() =>
    packScrobbleBatchEntries([1], { measure: () => ({ cborBytes: 1, createBodyBytes: MAX_CREATE_BODY_BYTES + 1 }) }),
  ).toThrow(/exceeds/);
  expect(() =>
    packScrobbleBatchEntries([1], {
      maxCborBytes: MAX_CBOR_BYTES + 1,
      measure: () => ({ cborBytes: 1, createBodyBytes: 1 }),
    }),
  ).toThrow(/hard limit/);
  expect(() =>
    packScrobbleBatchEntries([1], {
      maxCount: BATCH_MAX_LISTENS + 1,
      measure: () => ({ cborBytes: 1, createBodyBytes: 1 }),
    }),
  ).toThrow(/maxCount/);
});

const B32 = '234567abcdefghijklmnopqrstuvwxyz';
/** The i-th of a run of distinct valid TIDs. */
const tid = (i: number) => {
  let out = '';
  for (let n = i, k = 0; k < 6; k++, n = Math.floor(n / 32)) out = (B32[n % 32] as string) + out;
  return `3jzfcij${out}`;
};

describe('scrobbleBatch capacity limits', () => {
  it('derives every write bound from the verified 1,000,000-byte PDS limit with a 1 % margin', () => {
    expect(PDS_JSON_BODY_LIMIT_BYTES).toBe(1_000_000);
    expect(WRITE_SAFETY_MARGIN_BYTES).toBe(10_000);
    expect(MAX_WRITE_BODY_BYTES).toBe(990_000);
    // `,"swapCommit":"` + CID + `"` and the same for swapRecord, CIDs at their longest accepted length.
    const swaps = `,"swapCommit":"${'b'.repeat(MAX_SWAP_CID_CHARS)}","swapRecord":"${'b'.repeat(MAX_SWAP_CID_CHARS)}"`;
    expect(new TextEncoder().encode(swaps).byteLength).toBe(PUT_SWAP_RESERVE_BYTES);
    expect(PUT_SWAP_RESERVE_BYTES).toBe(546);
    expect(MAX_CREATE_BODY_BYTES).toBe(989_454);
    expect(MAX_CBOR_BYTES).toBe(990_000);
    expect(MAX_INGEST_CBOR_BYTES).toBe(2_000_000);
  });

  it('proves the shortest valid entry and that the 10,000-entry ceiling never binds before the byte limits', () => {
    const minimal = {
      id: tid(0),
      artist: 'a',
      track: 'a',
      listenedAt: '1970-01-01T00:00:00Z',
      createdAt: '1970-01-01T00:00:00Z',
    };
    const one = validateScrobbleBatchRecord(envelope([minimal]), FIXTURE_PREFIX, receipt);
    expect(one.ok && one.row.listens.length).toBe(1);
    expect(new TextEncoder().encode(JSON.stringify(minimal)).byteLength).toBe(MIN_ENTRY_JSON_BYTES);
    // Every required field is already at its shortest valid spelling.
    for (const shorter of [
      { artist: '' },
      { artist: ' ' },
      { track: '' },
      { listenedAt: '1970-01-01T00:00Z' },
      { createdAt: '1970-01-01' },
      { id: '3jzfcij2222' },
    ]) {
      const result = validateScrobbleBatchRecord(envelope([{ ...minimal, ...shorter }]), FIXTURE_PREFIX, receipt);
      expect(result.ok && result.row.listens.length).toBe(0);
    }
    // n valid entries take at least n·MIN + (n − 1) JSON bytes (comma separators).
    const most = (bytes: number) => Math.floor((bytes + 1) / (MIN_ENTRY_JSON_BYTES + 1));
    expect(most(PDS_JSON_BODY_LIMIT_BYTES)).toBe(8_403);
    expect(most(MAX_CREATE_BODY_BYTES)).toBe(8_314);
    expect(most(PDS_JSON_BODY_LIMIT_BYTES)).toBeLessThan(BATCH_MAX_LISTENS);
    const listens = (n: number) => Array.from({ length: n }, (_, i) => ({ ...minimal, id: tid(i) }));
    const fitsLimit = listens(8_403);
    expect(new TextEncoder().encode(JSON.stringify(fitsLimit)).byteLength - 2).toBeLessThanOrEqual(1_000_000);
    expect(new TextEncoder().encode(JSON.stringify(listens(8_404))).byteLength - 2).toBeGreaterThan(1_000_000);
    // The ceiling itself still admits 10,000 valid entries and refuses 10,001.
    const atCeiling = validateScrobbleBatchRecord(envelope(listens(BATCH_MAX_LISTENS)), FIXTURE_PREFIX, receipt);
    expect(atCeiling.ok && atCeiling.row.listens.length).toBe(BATCH_MAX_LISTENS);
    expect(
      validateScrobbleBatchRecord(envelope(listens(BATCH_MAX_LISTENS + 1)), FIXTURE_PREFIX, receipt),
    ).toMatchObject({ ok: false, reason: { field: 'listens' } });
  });
});

describe('additive batch packing', () => {
  interface Item {
    cbor: number;
    body: number;
  }
  const sizer: AdditiveBatchSizer<Item> = {
    frame: (n) => ({ cborBytes: 40 + (n < 24 ? 1 : n < 256 ? 2 : 3), createBodyBytes: 100 + Math.max(0, n - 1) }),
    entry: (item) => ({ cborBytes: item.cbor, createBodyBytes: item.body }),
  };
  const counted = () => {
    const calls = { groups: 0, items: 0 };
    const measure = (items: readonly Item[]) => {
      calls.groups += 1;
      calls.items += items.length;
      const frame = sizer.frame(items.length);
      return {
        cborBytes: frame.cborBytes + items.reduce((n, item) => n + item.cbor, 0),
        createBodyBytes: frame.createBodyBytes + items.reduce((n, item) => n + item.body, 0),
      };
    };
    return { calls, measure };
  };

  it('packs exactly like whole-group measuring, verifying each boundary with linear work', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ cbor: fc.integer({ min: 1, max: 900 }), body: fc.integer({ min: 1, max: 1_000 }) }), {
          maxLength: 300,
        }),
        fc.integer({ min: 1_200, max: 20_000 }),
        fc.integer({ min: 2, max: 400 }),
        (items, limit, maxCount) => {
          const options = { maxCount, maxCborBytes: limit, maxCreateBodyBytes: limit };
          const whole = counted();
          const additive = counted();
          const expected = packScrobbleBatchEntries(items, { ...options, measure: whole.measure });
          const actual = packScrobbleBatchEntries(items, { ...options, measure: additive.measure, sizer });
          expect(actual).toEqual(expected);
          // Every group but the last is full; the additive path measures each group and its rejected successor once.
          expect(additive.calls.groups).toBeLessThanOrEqual(2 * actual.length);
          expect(additive.calls.items).toBeLessThanOrEqual(2 * items.length + actual.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('measures thousands of entries in linear work where whole-group measuring is quadratic', () => {
    const items = Array.from({ length: 5_000 }, (_, i) => ({ cbor: 150 + (i % 7), body: 180 + (i % 11) }));
    const additive = counted();
    const packed = packScrobbleBatchEntries(items, { measure: additive.measure, sizer });
    expect(packed.map((group) => group.entries.length).reduce((a, b) => a + b, 0)).toBe(5_000);
    expect(packed[0]?.entries.length).toBeGreaterThan(1_000);
    expect(additive.calls.items).toBeLessThanOrEqual(2 * items.length + packed.length);
    const whole = counted();
    packScrobbleBatchEntries(items.slice(0, 2_000), { measure: whole.measure });
    // The generic path measures every prefix: about n²/2 items for one group of n.
    expect(whole.calls.items).toBeGreaterThan(1_000_000);
  });

  it('throws when the sizer disagrees with the encoded group, and on one entry too large by itself', () => {
    const wrong: AdditiveBatchSizer<Item> = {
      ...sizer,
      entry: (item) => ({ cborBytes: item.cbor, createBodyBytes: item.body - 1 }),
    };
    expect(() =>
      packScrobbleBatchEntries([{ cbor: 1, body: 2 }], { measure: counted().measure, sizer: wrong }),
    ).toThrow(/disagree/);
    // A sizer right about the group but over-counting the next entry would end the group early.
    const over: AdditiveBatchSizer<Item & { big?: boolean }> = {
      ...sizer,
      entry: (item) => ({ cborBytes: item.cbor, createBodyBytes: item.big === true ? item.body * 10 : item.body }),
    };
    expect(() =>
      packScrobbleBatchEntries(
        [
          { cbor: 1, body: 400 },
          { cbor: 1, body: 400, big: true },
        ],
        { maxCreateBodyBytes: 1_000, measure: counted().measure, sizer: over },
      ),
    ).toThrow(/stopped before a fitting entry/);
    expect(() =>
      packScrobbleBatchEntries([{ cbor: 1, body: MAX_CREATE_BODY_BYTES }], { measure: counted().measure, sizer }),
    ).toThrow(/exceeds/);
  });

  it('BatchPrefix leaves its group unchanged when an entry does not fit', () => {
    const prefix = newBatchPrefix(sizer, { maxCreateBodyBytes: 1_000 });
    expect(prefix.tryAdd({ cbor: 10, body: 500 })).toBe(true);
    expect(prefix.sizes()).toEqual({ cborBytes: 51, createBodyBytes: 600 });
    expect(prefix.tryAdd({ cbor: 10, body: 400 })).toBe(false);
    expect(prefix.entries).toHaveLength(1);
    expect(prefix.sizes()).toEqual({ cborBytes: 51, createBodyBytes: 600 });
    expect(prefix.tryAdd({ cbor: 10, body: 399 })).toBe(true);
    expect(prefix.sizes()).toEqual({ cborBytes: 61, createBodyBytes: 1_000 });
  });
});
