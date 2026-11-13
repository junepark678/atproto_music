import { listenKey } from '@atmusic/core/listen-key';
import { newTid } from '@atmusic/core/record-key';
import { scrobbleBatchCollection } from '@atmusic/core/scrobble-batch';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { NS_PER_SECOND } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleDeps } from '../../src/do/contracts';
import { musicKeyColumns } from '../../src/do/write/keys';
import { batchMemberForListenKey } from '../../src/imports/batch-acceptance';

const PREFIX = 'com.example.atmusic';
const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const RECEIPT = '2026-01-15T12:00:00Z';
const RECEIPT_MS = Date.parse(RECEIPT);
const LISTENED_AT = '1970-01-01T00:01:40Z';
const LISTEN_COUNT = 8_000;

describe('near-limit batch removal lookup', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hashes only the matching late member and stays bounded on repeated lookups', async () => {
    const clock = fixedClock(RECEIPT);
    const random = seededRandom(91);
    const listens = Array.from({ length: LISTEN_COUNT }, (_, index) => ({
      id: newTid(clock, random),
      artist: 'Batch fixture artist',
      track: `Unrelated track ${index.toString().padStart(5, '0')}`,
      listenedAt: LISTENED_AT,
      createdAt: '2026-01-15T12:00:00Z',
    }));
    const target = listens.at(-1)!;
    target.artist = 'Target artist';
    target.track = 'Target track';
    const recordJson = JSON.stringify({
      $type: scrobbleBatchCollection(PREFIX),
      createdAt: '2026-01-15T12:00:00Z',
      listens,
    });
    expect(recordJson.length).toBeGreaterThan(900_000);

    const targetKey = await listenKey({
      did: DID,
      listenedAtNs: 100n * NS_PER_SECOND,
      artist: target.artist,
      track: target.track,
    });
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const deps = {
      config: { prefix: PREFIX },
      clock: { nowMs: () => RECEIPT_MS },
    } as unknown as ModuleDeps;
    const targetColumns = musicKeyColumns(target.artist, target.track, null);
    const tuple = {
      artistKey: targetColumns.artist_key,
      trackKey: targetColumns.track_key,
      listenedSecond: 100n,
    };

    expect(await batchMemberForListenKey(deps, { did: DID, recordJson, listenKey: targetKey, tuple })).toBe(target.id);
    expect(digest).toHaveBeenCalledTimes(1);

    digest.mockClear();
    expect(await batchMemberForListenKey(deps, { did: DID, recordJson, listenKey: targetKey, tuple })).toBe(target.id);
    expect(digest).toHaveBeenCalledTimes(1);
  });
});
