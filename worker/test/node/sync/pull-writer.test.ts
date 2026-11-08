import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { listenKey } from '@atmusic/core/listen-key';
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, NS_PER_SECOND } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import type { LinkedAccountRow } from '../../../src/app/rows';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { linkDto } from '../../../src/forward/links';
import { retainedForwardProvenance } from '../../../src/forward/projection';
import { removeScrobbleCreate } from '../../../src/outbox/delete-ops';
import { seedLegacyListenSecondSlice } from '../../../src/outbox/listen-second-receipts';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { insertOperation, newOperationId, outboxCollections, prepare } from '../../../src/outbox/operations';
import { insertPullLoveAdmission } from '../../../src/sync/pull-love-admissions';
import { stageLovePage, stagePullPage } from '../../../src/sync/pull-staging';
import { writePullSlice } from '../../../src/sync/pull-writer';
import { isListenTombstoned, tombstoneListen } from '../../../src/sync/tombstones';
import { LOVE, remoteRecords, withHarness } from '../outbox/support';

async function setup(h: Parameters<Parameters<typeof withHarness>[0]>[0], did = 'did:plc:pullwriter') {
  h.seedUser(did);
  h.account(did);
  const linkId = h.link(did, 'listenbrainz');
  h.db.run("UPDATE linked_accounts SET remote_user='remote' WHERE id=?", linkId);
  h.db.run(
    "INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,updated_at_ms) VALUES(?,1,'listenbrainz','remote',0,1)",
    linkId,
  );
  return { did, linkId };
}

describe('linked pull staged writer', () => {
  it('rechecks a concurrent accepted love alias in the final writer transaction', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      const recordingMbid = '00000000-0000-4000-8000-000000000004';
      stageLovePage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedBoundaryMs: 100,
        proposedBoundaryKey: null,
        nowMs: 2,
        items: [
          {
            itemKey: 'staged',
            artist: 'Artist',
            track: 'Track',
            recordingMbid,
            payload: { artist: 'Artist', track: 'Track', recordingMbid },
          },
        ],
      });
      const [artistKey, trackKeyValue] = trackKey('Artist', 'Track');
      const result = await writePullSlice(h.m, {
        linkId,
        generation: 1,
        available: async () => {
          insertPullLoveAdmission(h.db, {
            did,
            linkId: 'concurrent-lastfm-link',
            generation: 3,
            operationId: 'concurrent-accepted-love',
            loveKey: `${artistKey}\u0000${trackKeyValue}`,
            recordingMbid,
            sourceService: 'lastfm',
            sourceAccount: 'other-remote-account',
            nowMs: 3,
          });
          return { available: true };
        },
      });
      expect(result).toMatchObject({ accepted: 0, duplicate: 1 });
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='love.put'", did)).toEqual({ n: 0 });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
    });
  });

  it.each([false, true])(
    'keeps love key, MBID aliases and source admission through PDS success before projection (operation GC=%s)',
    async (collectOperation) => {
      await withHarness(async (h) => {
        const { did, linkId } = await setup(h, h.alice);
        const targetLink = h.link(did, 'lastfm');
        const recordingMbid = '00000000-0000-4000-8000-000000000001';
        const pulled = {
          itemKey: 'source-love',
          artist: 'Artist',
          track: 'Original title',
          recordingMbid,
          payload: { artist: 'Artist', track: 'Original title', recordingMbid },
        };
        stageLovePage(h.db, {
          linkId,
          generation: 1,
          sourceService: 'listenbrainz',
          sourceAccount: 'remote',
          did,
          proposedCursor: null,
          proposedBoundaryMs: 100,
          proposedBoundaryKey: null,
          nowMs: 2,
          items: [pulled],
        });
        expect(
          await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) }),
        ).toMatchObject({ accepted: 1, duplicate: 0 });
        const accepted = h.db.one<{
          operation_id: string;
          state: string;
          source_service: string;
          source_account: string;
        }>(
          'SELECT operation_id,state,source_service,source_account FROM linked_pull_love_admissions WHERE did=?',
          did,
        )!;
        expect(accepted).toMatchObject({ state: 'accepted', source_service: 'listenbrainz', source_account: 'remote' });
        expect(
          h.db.all<{ link_id: string; kind: string }>(
            "SELECT link_id,kind FROM forward_outbox WHERE did=? AND kind='love'",
            did,
          ),
        ).toEqual([{ link_id: targetLink, kind: 'love' }]);

        await h.runUntilIdle();
        expect(h.db.one('SELECT state FROM operations WHERE id=?', accepted.operation_id)).toMatchObject({
          state: 'succeeded',
        });
        expect(await remoteRecords(h.kit, 'Alice', `${h.m.config.prefix}.love`)).toHaveLength(1);
        expect(
          h.db.one<{ state: string; uri: string; source_service: string }>(
            'SELECT state,uri,source_service FROM linked_pull_love_admissions WHERE did=? AND operation_id=?',
            did,
            accepted.operation_id,
          ),
        ).toMatchObject({ state: 'present', source_service: 'listenbrainz' });

        if (collectOperation) h.db.run('DELETE FROM operations WHERE id=?', accepted.operation_id);
        h.restart();
        const echo = stageLovePage(h.db, {
          linkId,
          generation: 1,
          sourceService: 'listenbrainz',
          sourceAccount: 'remote',
          did,
          proposedCursor: null,
          proposedBoundaryMs: 100,
          proposedBoundaryKey: null,
          nowMs: 4,
          items: [
            {
              itemKey: 'normalized-key-echo',
              artist: ' artist ',
              track: 'ORIGINAL TITLE ',
              payload: { artist: ' artist ', track: 'ORIGINAL TITLE ' },
            },
            {
              itemKey: 'corrected-title-echo',
              artist: 'Artist',
              track: 'Corrected title',
              recordingMbid,
              payload: { artist: 'Artist', track: 'Corrected title', recordingMbid },
            },
          ],
        });
        expect(echo).toEqual(['duplicate', 'duplicate']);
        expect(
          await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) }),
        ).toMatchObject({ accepted: 0 });

        const remoteLove = (await remoteRecords(h.kit, 'Alice', LOVE))[0]!;
        const proof = await verifyRecordProof(await h.kit.repos.Alice.getRecordCar(LOVE, remoteLove.rkey), {
          did,
          collection: LOVE,
          rkey: remoteLove.rkey,
          signingKey: h.kit.users.Alice.key.didKey,
        });
        const nowNs = fromMs(h.kit.clock.nowMs());
        h.db.tx(() =>
          applyRecordProof(h.db, proof, {
            prefix: h.m.config.prefix!,
            nowNs,
            receiptNs: nowNs,
            forwarding: { random: seededRandom(0x61) },
          }),
        );
        expect(
          h.db.one<{ path: string; source_service: string }>(
            'SELECT path,source_service FROM love_incarnations WHERE uri=?',
            `at://${did}/${LOVE}/${remoteLove.rkey}`,
          ),
        ).toEqual({
          path: 'import',
          source_service: 'listenbrainz',
        });
        await h.runUntilIdle();
        expect(await remoteRecords(h.kit, 'Alice', `${h.m.config.prefix}.love`)).toHaveLength(1);
        expect(h.db.all("SELECT link_id FROM forward_outbox WHERE did=? AND kind='love'", did)).toEqual([
          { link_id: targetLink },
        ]);
      });
    },
  );

  it('lets explicit local unlove tombstone the accepted aliases and explicit re-love create a new intent', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h, h.alice);
      const recordingMbid = '00000000-0000-4000-8000-000000000002';
      stageLovePage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedBoundaryMs: 100,
        proposedBoundaryKey: null,
        nowMs: 2,
        items: [
          {
            itemKey: 'pulled',
            artist: 'Artist',
            track: 'Original title',
            recordingMbid,
            payload: { artist: 'Artist', track: 'Original title', recordingMbid },
          },
        ],
      });
      await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      await h.runUntilIdle();
      const unlove = await enqueueUnlove(h.m, { did, artist: 'Artist', track: 'Original title', origin: 'web' });
      expect(unlove.ok).toBe(true);
      expect(h.db.one('SELECT state FROM linked_pull_love_admissions WHERE did=?', did)).toEqual({ state: 'retired' });
      expect(h.db.one('SELECT recording_mbid FROM linked_love_intents WHERE did=?', did)).toEqual({
        recording_mbid: recordingMbid,
      });
      await h.runUntilIdle();
      expect(await remoteRecords(h.kit, 'Alice', `${h.m.config.prefix}.love`)).toHaveLength(0);
      h.restart();

      const oldEcho = stageLovePage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedBoundaryMs: 100,
        proposedBoundaryKey: null,
        nowMs: 5,
        items: [
          {
            itemKey: 'old-mbid-title-echo',
            artist: 'Artist',
            track: 'Corrected title',
            recordingMbid,
            payload: { artist: 'Artist', track: 'Corrected title', recordingMbid },
          },
        ],
      });
      expect(oldEcho).toEqual(['tombstoned']);

      const relove = await enqueueLove(h.m, {
        did,
        input: { artist: 'Artist', track: 'Corrected title', recordingMbid },
        origin: 'web',
      });
      expect(relove.ok).toBe(true);
      const [artistKey, correctedTrackKey] = trackKey('Artist', 'Corrected title');
      expect(
        h.db.one<{ intent: string }>(
          'SELECT intent FROM linked_love_intents WHERE did=? AND love_key=?',
          did,
          `${artistKey}\u0000${correctedTrackKey}`,
        ),
      ).toEqual({ intent: 'love' });
      expect(h.db.one("SELECT count(*) AS n FROM linked_pull_tombstones WHERE did=? AND kind='love'", did)).toEqual({
        n: 0,
      });
      await h.runUntilIdle();
      expect(await remoteRecords(h.kit, 'Alice', `${h.m.config.prefix}.love`)).toHaveLength(1);
      if (relove.ok) h.db.run('DELETE FROM operations WHERE id=?', relove.operation.id);
      h.restart();
      expect(
        stageLovePage(h.db, {
          linkId,
          generation: 1,
          sourceService: 'listenbrainz',
          sourceAccount: 'remote',
          did,
          proposedCursor: null,
          proposedBoundaryMs: 100,
          proposedBoundaryKey: null,
          nowMs: 6,
          items: [
            {
              itemKey: 'old-name-after-local-relove',
              artist: 'Artist',
              track: 'Original title',
              recordingMbid,
              payload: { artist: 'Artist', track: 'Original title', recordingMbid },
            },
          ],
        }),
      ).toEqual(['duplicate']);
    });
  });

  it('rechecks legacy pending single and batch member seconds before accepting staged pulls', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      h.m.config.batchPublication = true;
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: 'page',
        proposedWatermarkMs: 200000,
        nowMs: 2,
        items: [
          {
            itemKey: 'single-echo',
            listenedAtMs: 100000,
            payload: { artist: 'Different', track: 'Single', listenedAt: '1970-01-01T00:01:40Z' },
          },
          {
            itemKey: 'batch-echo',
            listenedAtMs: 200000,
            payload: { artist: 'Different', track: 'Batch', listenedAt: '1970-01-01T00:03:20Z' },
          },
        ],
      });
      const prefix = h.m.config.prefix!;
      const singleId = newOperationId(h.m.random);
      const single = await prepare({
        $type: `${prefix}.scrobble`,
        artist: 'Legacy',
        track: 'Single',
        listenedAt: '1970-01-01T00:01:40Z',
        createdAt: new Date(3).toISOString(),
      });
      insertOperation(
        h.db,
        {
          id: singleId,
          did,
          kind: 'scrobble.create',
          origin: 'web',
          collection: outboxCollections(prefix).scrobble,
          rkey: '3klegacysingle01',
          prepared: single,
          dueAt: 3,
        },
        3,
      );
      const singleReceipt = await listenKey({
        did,
        listenedAtNs: 100n * NS_PER_SECOND,
        artist: 'Legacy',
        track: 'Single',
      });
      h.db.run(
        "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,?,?,'web',3,NULL)",
        did,
        singleReceipt,
        singleId,
      );
      const batchId = newOperationId(h.m.random);
      const batch = await prepare({
        $type: `${prefix}.scrobbleBatch`,
        createdAt: new Date(3).toISOString(),
        listens: [{ id: '3klegacyentry001', artist: 'Legacy', track: 'Batch', listenedAt: '1970-01-01T00:03:20Z' }],
      });
      insertOperation(
        h.db,
        {
          id: batchId,
          did,
          kind: 'scrobble.create',
          origin: 'import',
          collection: outboxCollections(prefix).scrobbleBatch,
          rkey: '3klegacybatch001',
          prepared: batch,
          dueAt: 3,
        },
        3,
      );
      const batchReceipt = await listenKey({
        did,
        listenedAtNs: 200n * NS_PER_SECOND,
        artist: 'Legacy',
        track: 'Batch',
      });
      h.db.run(
        "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,?,?,'import',3,NULL)",
        did,
        batchReceipt,
        batchId,
      );
      for (let i = 0; i < 4; i++) {
        const seeded = await seedLegacyListenSecondSlice(h.db, 4 + i);
        if (!seeded.more) break;
      }
      const result = await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      expect(result.duplicate).toBe(2);
      expect(result.accepted).toBe(0);
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
    });
  });

  it('holds staged acceptance when legacy pending-second coverage cannot be established', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: 'page',
        proposedWatermarkMs: 100000,
        nowMs: 2,
        items: [
          {
            itemKey: 'staged',
            listenedAtMs: 100000,
            payload: { artist: 'Artist', track: 'Track', listenedAt: '1970-01-01T00:01:40Z' },
          },
        ],
      });
      const opId = newOperationId(h.m.random);
      const prepared = await prepare({
        $type: `${h.m.config.prefix}.scrobble`,
        artist: 'Legacy',
        track: 'Unreadable',
        listenedAt: '1970-01-01T00:08:20Z',
        createdAt: new Date(3).toISOString(),
      });
      insertOperation(
        h.db,
        {
          id: opId,
          did,
          kind: 'scrobble.create',
          origin: 'web',
          collection: outboxCollections(h.m.config.prefix!).scrobble,
          rkey: '3klegacyunreadable',
          prepared,
          dueAt: 3,
        },
        3,
      );
      h.db.run(
        "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,'legacy-unknown-second',?,'web',3,NULL)",
        did,
        opId,
      );
      h.db.run("UPDATE operations SET record_json='not-json' WHERE id=?", opId);
      const result = await writePullSlice(h.m, {
        linkId,
        generation: 1,
        available: async () => ({ available: true }),
      });
      expect(result.held).toBe('legacy_dedupe_coverage');
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 1 });
      expect(h.db.one('SELECT hold_reason FROM linked_pull_state WHERE link_id=?', linkId)).toEqual({
        hold_reason: 'legacy_dedupe_coverage',
      });
    });
  });

  it('holds staged pages on absent session and resumes once when the real writer becomes available', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedWatermarkMs: 100000,
        nowMs: 2,
        items: [
          {
            itemKey: 'listen',
            listenedAtMs: 100000,
            payload: { artist: 'Artist', track: 'Track', listenedAt: '1970-01-01T00:01:40Z' },
          },
        ],
      });
      const unavailable = await writePullSlice(h.m, {
        linkId,
        generation: 1,
        available: async () => ({ available: false, reason: 'session_missing' }),
      });
      expect(unavailable.held).toBe('session_missing');
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 1 });
      expect(h.db.one('SELECT hold_reason FROM linked_pull_state WHERE link_id=?', linkId)).toEqual({
        hold_reason: 'session_missing',
      });
      const linked = h.db.one<LinkedAccountRow>('SELECT * FROM linked_accounts WHERE id=?', linkId)!;
      expect(linkDto(linked, h.db).sync).toMatchObject({ holdReason: 'session_missing', needsReauth: true });
      h.restart();
      const available = await writePullSlice(h.m, {
        linkId,
        generation: 1,
        available: async () => ({ available: true }),
      });
      expect(available.accepted).toBe(1);
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
      expect(h.db.one("SELECT origin,state FROM operations WHERE did=? AND kind='scrobble.create'", did)).toMatchObject(
        { origin: 'import' },
      );
      const again = await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      expect(again.accepted).toBe(0);
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='scrobble.create'", did)).toEqual({
        n: 1,
      });
    });
  });

  it('rechecks account generation and dedupe in the acceptance transaction, and accepts a linked love through import operations', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stageLovePage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedBoundaryMs: 10,
        proposedBoundaryKey: null,
        nowMs: 2,
        items: [{ itemKey: 'love', artist: 'Artist', track: 'Track', payload: { artist: 'Artist', track: 'Track' } }],
      });
      const originalRestore = async () => {
        h.db.run("UPDATE linked_accounts SET generation=2,remote_user='new-account' WHERE id=?", linkId);
        return { available: true as const };
      };
      await writePullSlice(h.m, { linkId, generation: 1, available: originalRestore });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 1 });
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='love.put'", did)).toEqual({ n: 0 });
      h.db.run("UPDATE linked_accounts SET generation=1,remote_user='remote' WHERE id=?", linkId);
      const result = await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      expect(result.accepted).toBe(1);
      expect(h.db.one("SELECT origin FROM operations WHERE did=? AND kind='love.put'", did)).toEqual({
        origin: 'import',
      });
    });
  });

  it('does not create an operation when a tombstone appears during async session restoration', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedWatermarkMs: 100000,
        nowMs: 2,
        items: [
          {
            itemKey: 'listen',
            listenedAtMs: 100000,
            payload: { artist: 'Artist', track: 'Track', listenedAt: '1970-01-01T00:01:40Z' },
          },
        ],
      });
      const result = await writePullSlice(h.m, {
        linkId,
        generation: 1,
        available: async () => {
          tombstoneListen(h.db, { did, identity: 'withdrawn', second: 100, artistKey: null, trackKey: null, nowMs: 3 });
          return { available: true };
        },
      });
      expect(result.tombstoned).toBe(1);
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='scrobble.create'", did)).toEqual({
        n: 0,
      });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
    });
  });

  it('settles a listen as duplicate when another writer accepts its second during async preparation', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedWatermarkMs: 100000,
        nowMs: 2,
        items: [
          {
            itemKey: 'listen',
            listenedAtMs: 100000,
            payload: { artist: 'Artist', track: 'Track', listenedAt: '1970-01-01T00:01:40Z' },
          },
        ],
      });
      const result = await writePullSlice(h.m, {
        linkId,
        generation: 1,
        available: async () => {
          h.db.run(
            "INSERT INTO listen_keys(did,dedupe_key,source,created_at_ms,listen_second) VALUES(?,'racing','web',3,100)",
            did,
          );
          return { available: true };
        },
      });
      expect(result.duplicate).toBe(1);
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='scrobble.create'", did)).toEqual({
        n: 0,
      });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
    });
  });

  it('routes imported linked listens through the scrobbleBatch collection when batch publication is enabled', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      h.m.config.batchPublication = true;
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedWatermarkMs: 100000,
        nowMs: 2,
        items: [
          {
            itemKey: 'listen',
            listenedAtMs: 100000,
            payload: { artist: 'Artist', track: 'Track', listenedAt: '1970-01-01T00:01:40Z' },
          },
        ],
      });
      await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      const operation = h.db.one<{ collection: string; record_json: string }>(
        "SELECT collection,record_json FROM operations WHERE did=? AND kind='scrobble.create'",
        did,
      )!;
      expect(operation.collection).toBe(`${h.m.config.prefix}.scrobbleBatch`);
      expect(JSON.parse(operation.record_json)).toMatchObject({ listens: [{ artist: 'Artist', track: 'Track' }] });
    });
  });

  it('packs the eligible linked listens into one maximal container and commits every member receipt atomically', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedWatermarkMs: 104000,
        nowMs: 2,
        items: Array.from({ length: 5 }, (_, i) => ({
          itemKey: `remote-${i}`,
          listenedAtMs: 100000 + i * 1000,
          payload: { artist: 'Artist', track: `Track ${i}`, listenedAt: new Date(100000 + i * 1000).toISOString() },
        })),
      });
      const result = await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      expect(result.accepted).toBe(5);
      const operations = h.db.all<{ record_json: string }>(
        "SELECT record_json FROM operations WHERE did=? AND kind='scrobble.create'",
        did,
      );
      expect(operations).toHaveLength(1);
      expect(JSON.parse(operations[0]!.record_json).listens).toHaveLength(5);
      expect(
        h.db.one(
          "SELECT count(*) AS n FROM listen_keys WHERE did=? AND operation_id=(SELECT id FROM operations WHERE did=? AND kind='scrobble.create')",
          did,
          did,
        ),
      ).toEqual({ n: 5 });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
    });
  });

  it('tombstones the exact selected pending batch member instead of an arbitrary sibling', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      h.m.config.batchPublication = true;
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedWatermarkMs: 200000,
        nowMs: 2,
        items: [
          {
            itemKey: 'first',
            listenedAtMs: 100000,
            payload: { artist: 'Artist', track: 'First', listenedAt: '1970-01-01T00:01:40Z' },
          },
          {
            itemKey: 'second',
            listenedAtMs: 200000,
            payload: { artist: 'Artist', track: 'Second', listenedAt: '1970-01-01T00:03:20Z' },
          },
        ],
      });
      await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      const operation = h.db.one<{ id: string; record_json: string }>(
        "SELECT id,record_json FROM operations WHERE did=? AND collection LIKE '%scrobbleBatch'",
        did,
      )!;
      const listens = (
        JSON.parse(operation.record_json) as {
          listens: Array<{ id: string; artist: string; track: string; listenedAt: string }>;
        }
      ).listens;
      const selected = listens[1]!;
      const sibling = listens[0]!;
      const [selectedArtist, selectedTrack] = trackKey(selected.artist, selected.track);
      const [siblingArtist, siblingTrack] = trackKey(sibling.artist, sibling.track);
      expect(
        removeScrobbleCreate(h.m, { did, operationId: operation.id, listenId: selected.id, origin: 'web' }).status,
      ).toBe('delete_chained');
      expect(isListenTombstoned(h.db, did, 200, selectedArtist, selectedTrack)).toBe(true);
      expect(isListenTombstoned(h.db, did, 100, siblingArtist, siblingTrack)).toBe(false);
    });
  });

  it('keeps canonical listen identity and source provenance after the operation is collected', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      h.m.config.batchPublication = false;
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedWatermarkMs: 100000,
        nowMs: 2,
        items: [
          {
            itemKey: 'remote-id',
            listenedAtMs: 100000,
            payload: { artist: 'Artist', track: 'Track', listenedAt: '1970-01-01T00:01:40Z' },
          },
        ],
      });
      await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      const canonical = await listenKey({ did, listenedAtNs: 100000000000n, artist: 'Artist', track: 'Track' });
      expect(h.db.one('SELECT dedupe_key FROM listen_keys WHERE did=?', did)).toEqual({ dedupe_key: canonical });
      h.db.run('DELETE FROM operations WHERE did=?', did);
      expect(retainedForwardProvenance(h.db, did, canonical)).toEqual({
        path: 'import',
        sourceService: 'listenbrainz',
      });
    });
  });

  it('stores complete love record fields in the cross-service forwarding payload', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      h.link(did, 'lastfm');
      const recordingMbid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      stageLovePage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedBoundaryMs: 10,
        proposedBoundaryKey: null,
        nowMs: 2,
        items: [
          {
            itemKey: 'love',
            artist: 'Artist',
            track: 'Track',
            recordingMbid,
            payload: { artist: 'Artist', track: 'Track', recordingMbid },
          },
        ],
      });
      await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      const outbox = h.db.one<{ payload_json: string }>(
        "SELECT payload_json FROM forward_outbox WHERE did=? AND kind='love'",
        did,
      );
      expect(JSON.parse(outbox!.payload_json)).toMatchObject({
        artist: 'Artist',
        track: 'Track',
        recordingMbid,
        origin: 'import',
      });
      expect(
        h.db.all<{ service: string }>(
          "SELECT l.service FROM forward_outbox f JOIN linked_accounts l ON l.id=f.link_id WHERE f.did=? AND f.kind='love'",
          did,
        ),
      ).toEqual([{ service: 'lastfm' }]);
    });
  });

  it('settles a staged love when a local unlove wins before operation acceptance', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stageLovePage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedBoundaryMs: 10,
        proposedBoundaryKey: null,
        nowMs: 2,
        items: [{ itemKey: 'love', artist: 'Artist', track: 'Track', payload: { artist: 'Artist', track: 'Track' } }],
      });
      await enqueueUnlove(h.m, { did, artist: 'Artist', track: 'Track', origin: 'web' });
      const result = await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      expect(result.tombstoned).toBe(1);
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='love.put'", did)).toEqual({ n: 0 });
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='love.delete'", did)).toEqual({
        n: 1,
      });
    });
  });
});
