import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { fromMs } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { stageLovePage } from '../../../src/sync/pull-staging';
import { writePullSlice } from '../../../src/sync/pull-writer';
import { LOVE, remoteRecords, withHarness } from '../outbox/support';

it.each([false, true])('a newer signed incarnation releases the delete fence (GC=%s)', async (gc) =>
  withHarness(async (h) => {
    const did = h.alice;
    const apply = async (rkey: string) => {
      const proof = await verifyRecordProof(await h.kit.repos.Alice.getRecordCar(LOVE, rkey), {
        did,
        collection: LOVE,
        rkey,
        signingKey: h.kit.users.Alice.key.didKey,
      });
      const ns = fromMs(h.m.clock.nowMs());
      return h.db.tx(() =>
        applyRecordProof(h.db, proof, {
          prefix: h.m.config.prefix!,
          nowNs: ns,
          receiptNs: ns,
          forwarding: { random: h.m.random },
        }),
      );
    };
    const linkId = h.link(did, 'listenbrainz');
    h.db.run("UPDATE linked_accounts SET remote_user='remote' WHERE id=?", linkId);
    h.db.run(
      "INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,updated_at_ms) VALUES(?,1,'listenbrainz','remote',0,1)",
      linkId,
    );
    stageLovePage(h.db, {
      did,
      linkId,
      generation: 1,
      sourceService: 'listenbrainz',
      sourceAccount: 'remote',
      proposedCursor: null,
      proposedBoundaryMs: 100,
      proposedBoundaryKey: null,
      nowMs: 2,
      items: [{ itemKey: 'love', artist: 'Artist', track: 'Track', payload: { artist: 'Artist', track: 'Track' } }],
    });
    expect(
      (await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) })).accepted,
    ).toBe(1);
    await h.runUntilIdle();
    const rkey = (await remoteRecords(h.kit, 'Alice', LOVE))[0]!.rkey;
    const original = (await h.kit.repos.Alice.getRecord(LOVE, rkey))!.value as Record<string, unknown>;
    await apply(rkey);
    await enqueueUnlove(h.m, { did, artist: 'Artist', track: 'Track', origin: 'web' });
    await h.runUntilIdle();
    expect(await remoteRecords(h.kit, 'Alice', LOVE)).toHaveLength(0);
    if (gc) h.db.run('DELETE FROM operations');
    h.restart();
    // Another client recreates the same URI; the missed delete is superseded by a newer signed present proof.
    await h.kit.repos.Alice.put(LOVE, rkey, { ...original, album: 'New incarnation' });
    expect((await apply(rkey)).outcome).toBe('applied');
    const next = await enqueueLove(h.m, { did, origin: 'web', input: { artist: 'Artist', track: 'Track' } });
    if (!next.ok) throw Error('enqueue');
    await h.runUntilIdle();
    expect(await remoteRecords(h.kit, 'Alice', LOVE)).toHaveLength(1);
    expect(h.op(next.operation.id)?.result_uri).toBe(`at://${did}/${LOVE}/${rkey}`);
  }),
);
