import { listenKey } from '@atmusic/core/listen-key';
import { trackKey } from '@atmusic/core/music-key';
import { NS_PER_SECOND, parseRfc3339, toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import { seedIndexedListenSecondSlice } from '../../../src/outbox/listen-second-receipts';
import { insertOperation, newOperationId, outboxCollections, prepare } from '../../../src/outbox/operations';
import { stagePullPage } from '../../../src/sync/pull-staging';
import { withHarness } from '../outbox/support';

async function linkSetup(h: Parameters<Parameters<typeof withHarness>[0]>[0]) {
  const did = h.alice;
  h.account(did);
  const linkId = h.link(did, 'listenbrainz');
  h.db.run("UPDATE linked_accounts SET remote_user='remote' WHERE id=?", linkId);
  h.db.run(
    "INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,updated_at_ms) VALUES(?,1,'listenbrainz','remote',0,1)",
    linkId,
  );
  return { did, linkId };
}

function stage(
  h: Parameters<Parameters<typeof withHarness>[0]>[0],
  did: string,
  linkId: string,
  second: number,
  key: string,
) {
  return stagePullPage(h.db, {
    linkId,
    generation: 1,
    sourceService: 'listenbrainz',
    sourceAccount: 'remote',
    did,
    proposedCursor: key,
    proposedWatermarkMs: second * 1000,
    nowMs: 10,
    items: [{ itemKey: key, listenedAtMs: second * 1000, payload: { artist: 'Corrected', track: key } }],
  });
}

describe('legacy listen-second receipt lifecycle', () => {
  it('backfills a pending legacy single before real PDS success can outlive its operation', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await linkSetup(h);
      const second = 1_768_384_800;
      const listenedAt = new Date(second * 1000).toISOString();
      const canonical = await listenKey({
        did,
        listenedAtNs: parseRfc3339(listenedAt)!,
        artist: 'Original',
        track: 'Name',
      });
      const prepared = await prepare({
        $type: `${h.m.config.prefix}.scrobble`,
        artist: 'Original',
        track: 'Name',
        listenedAt,
        createdAt: new Date(h.m.clock.nowMs()).toISOString(),
      });
      const opId = newOperationId(h.m.random);
      insertOperation(
        h.db,
        {
          id: opId,
          did,
          kind: 'scrobble.create',
          origin: 'import',
          collection: outboxCollections(h.m.config.prefix!).scrobble,
          rkey: '3kreceiptlegacy001',
          prepared,
          dueAt: h.m.clock.nowMs(),
        },
        h.m.clock.nowMs(),
      );
      h.db.run(
        "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,?,?,'import',?,NULL)",
        did,
        canonical,
        opId,
        h.m.clock.nowMs(),
      );

      expect(() => stage(h, did, linkId, second, 'before-publish')).toThrow(/coverage incomplete/);
      await h.runUntilIdle();
      expect(h.op(opId).state).toBe('succeeded');
      expect(h.db.one('SELECT listen_second FROM listen_keys WHERE did=? AND dedupe_key=?', did, canonical)).toEqual({
        listen_second: second,
      });

      // The Jetstream projection may still be behind; operation GC must not erase dedupe coverage.
      h.db.run('DELETE FROM operations WHERE id=?', opId);
      expect(stage(h, did, linkId, second, 'after-operation-gc')).toEqual(['duplicate']);
      expect(h.db.one('SELECT count(*) AS n FROM operations WHERE did=?', did)).toEqual({ n: 0 });
    });
  });

  it('backfills exact legacy batch members and holds unknown orphan receipts until indexed projection repair', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await linkSetup(h);
      const second = 1_768_384_900;
      const listenedAt = new Date(second * 1000).toISOString();
      const canonical = await listenKey({
        did,
        listenedAtNs: parseRfc3339(listenedAt)!,
        artist: 'Batch Original',
        track: 'Member',
      });
      const prepared = await prepare({
        $type: `${h.m.config.prefix}.scrobbleBatch`,
        createdAt: new Date(h.m.clock.nowMs()).toISOString(),
        listens: [
          {
            id: '3kreceiptbatch001',
            artist: 'Unrelated',
            track: 'Sibling',
            listenedAt: new Date((second - 10) * 1000).toISOString(),
          },
          { id: '3kreceiptbatch002', artist: 'Batch Original', track: 'Member', listenedAt },
        ],
      });
      const opId = newOperationId(h.m.random);
      insertOperation(
        h.db,
        {
          id: opId,
          did,
          kind: 'scrobble.create',
          origin: 'import',
          collection: outboxCollections(h.m.config.prefix!).scrobbleBatch,
          rkey: '3kreceiptbatch003',
          prepared,
          dueAt: h.m.clock.nowMs(),
        },
        h.m.clock.nowMs(),
      );
      h.db.run(
        "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,?,?,'import',?,NULL)",
        did,
        canonical,
        opId,
        h.m.clock.nowMs(),
      );
      expect(() => stage(h, did, linkId, second, 'batch-pending')).toThrow(/coverage incomplete/);
      await h.runUntilIdle();
      expect(h.db.one('SELECT listen_second FROM listen_keys WHERE did=? AND dedupe_key=?', did, canonical)).toEqual({
        listen_second: second,
      });
      h.db.run('DELETE FROM operations WHERE id=?', opId);
      expect(stage(h, did, linkId, second, 'batch-after-gc')).toEqual(['duplicate']);

      const unknownAt = toStorage(BigInt(second + 20) * NS_PER_SECOND);
      const unknown = await listenKey({
        did,
        listenedAtNs: parseRfc3339(unknownAt)!,
        artist: 'Indexed',
        track: 'Recovered',
      });
      h.db.run(
        "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,?,NULL,'web',?,NULL)",
        did,
        unknown,
        h.m.clock.nowMs(),
      );
      expect(() => stage(h, did, linkId, second + 20, 'orphan-unknown')).toThrow(/coverage incomplete/);
      const indexedAt = unknownAt;
      const [artistKey, indexedTrackKey] = trackKey('Indexed', 'Recovered');
      h.db.run(
        `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
         VALUES(?, 'cid', ?, 'indexed', 'rev', 'Indexed', 'Recovered', ?, ?, ?, ?, ?)`,
        `at://${did}/com.example.atmusic.scrobble/indexed`,
        did,
        indexedAt,
        indexedAt,
        indexedAt,
        artistKey,
        indexedTrackKey,
      );
      expect(await seedIndexedListenSecondSlice(h.db, did, h.m.clock.nowMs())).toMatchObject({
        processed: 1,
        more: false,
      });
      expect(h.db.one('SELECT listen_second FROM listen_keys WHERE did=? AND dedupe_key=?', did, unknown)).toEqual({
        listen_second: second + 20,
      });
      expect(stage(h, did, linkId, second + 21, 'resolved-resume')).toEqual(['accepted']);
    });
  });
});
