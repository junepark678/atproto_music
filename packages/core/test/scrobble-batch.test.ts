import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import {
  buildScrobbleBatchRecord,
  formatScrobbleBatchListenUri,
  packScrobbleBatchEntries,
  parseScrobbleBatchListenUri,
  validateScrobbleBatchRecord,
} from '@atmusic/core/scrobble-batch';
import { fixedClock } from '@atmusic/core/test-support/clock';
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
  expect(() => packScrobbleBatchEntries([1], { measure: () => ({ cborBytes: 64_001, createBodyBytes: 1 }) })).toThrow(
    /exceeds/,
  );
  expect(() =>
    packScrobbleBatchEntries([1], {
      maxCborBytes: 64_001,
      measure: () => ({ cborBytes: 1, createBodyBytes: 1 }),
    }),
  ).toThrow(/hard limit/);
});
