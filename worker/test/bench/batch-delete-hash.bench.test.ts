import { listenKey } from '@atmusic/core/listen-key';
import { recordingMsid } from '@atmusic/core/msid';
import { newTid } from '@atmusic/core/record-key';
import { scrobbleBatchCollection } from '@atmusic/core/scrobble-batch';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, NS_PER_SECOND, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleDeps } from '../../src/do/contracts';
import { musicKeyColumns } from '../../src/do/write/keys';
import { batchMemberForListenKey } from '../../src/imports/batch-acceptance';
import { removeScrobble } from '../../src/lastfm/write-methods';
import { admitListenDelete } from '../../src/listenbrainz/token-routes';
import { insertOperation, prepare } from '../../src/outbox/operations';
import { withHarness } from '../node/outbox/support';

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

  it.each([
    ['removeScrobble', false],
    ['removeScrobble', true],
    ['admitListenDelete', false],
    ['admitListenDelete', true],
  ] as const)('%s stays bounded for a late member in a near-limit batch (explicit=%s)', async (method, explicit) =>
    withHarness(async (h) => {
      const did = h.alice;
      h.seedUser(did);
      h.account(did);
      const now = h.m.clock.nowMs();
      const listens = Array.from({ length: 7_000 }, (_, index) => ({
        id: newTid(h.m.clock, h.m.random),
        artist: 'A',
        track: `T${index.toString().padStart(4, '0')}`,
        listenedAt: new Date((100 + index) * 1000).toISOString(),
        createdAt: new Date(now).toISOString(),
      }));
      const target = listens.at(-1)!;
      target.artist = 'A';
      target.track = 'T6999';
      const record = { $type: `${h.m.config.prefix}.scrobbleBatch`, createdAt: new Date(now).toISOString(), listens };
      const recordJson = JSON.stringify(record);
      expect(recordJson.length).toBeGreaterThan(900_000);
      expect(recordJson.length).toBeLessThan(1_000_000);
      const rkey = newTid(h.m.clock, h.m.random);
      insertOperation(
        h.db,
        {
          id: 'batch-create',
          did,
          kind: 'scrobble.create',
          origin: 'import',
          collection: record.$type,
          rkey,
          prepared: await prepare(record),
          dueAt: now,
          importJobId: explicit ? 'batch-job' : null,
        },
        now,
      );
      if (explicit) {
        h.db.run(
          "INSERT INTO import_jobs(id,did,source,created_at_ms,updated_at_ms) VALUES('batch-job',?,'lastfm_api',?,?)",
          did,
          now,
          now,
        );
      }
      for (let index = 0; index < listens.length; index++) {
        const member = listens[index]!;
        const second = BigInt(100 + index);
        const key = await listenKey({
          did,
          listenedAtNs: second * NS_PER_SECOND,
          artist: member.artist,
          track: member.track,
        });
        h.db.run(
          "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,?,'batch-create','import',?,?)",
          did,
          key,
          now,
          Number(second),
        );
        if (explicit) {
          h.db.run(
            "INSERT INTO import_items(job_id,seq,dedupe_key,listened_at,record_json,state,operation_id) VALUES('batch-job',?,?,?,?, 'queued','batch-create')",
            index,
            key,
            toStorage(fromMs(Number(second) * 1000)),
            JSON.stringify(member),
          );
          h.db.run(
            "INSERT INTO batch_entry_items(operation_id,entry_id,job_id,seq) VALUES('batch-create',?,'batch-job',?)",
            member.id,
            index,
          );
        }
      }
      const targetMsid = await recordingMsid(target.artist, target.track);
      const digest = vi.spyOn(crypto.subtle, 'digest');
      try {
        if (method === 'removeScrobble') {
          await removeScrobble(h.m, { did, artist: target.artist, track: target.track, timestamp: 7_099 });
          expect(digest).toHaveBeenCalledTimes(4);
        } else {
          await admitListenDelete(h.m, did, 7_099n, targetMsid, () => {});
          expect(digest).toHaveBeenCalledTimes(explicit ? 3 : 1);
        }
        expect(
          JSON.parse(
            h.db.one<{ record_json: string }>("SELECT record_json FROM operations WHERE id='batch-create'")!
              .record_json,
          ).listens.length,
        ).toBe(method === 'removeScrobble' || explicit ? 6_999 : 7_000);
      } finally {
        digest.mockRestore();
      }
    }),
  );
});
