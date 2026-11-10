// Loves through the server outbox (ADR 0005 §5.8, §6.3, §7.8; N2-05): one
// love per (artist_key, track_key), and unlove mirrors unfollow.

import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import { recordLiveEvidence } from '../../../src/do/ingest/live-evidence';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { settleRows } from '../../../src/forward/forward-outbox';
import { materializeLoveApiRecipientDecisions } from '../../../src/forward/love-api-materializer';
import { enqueueLove } from '../../../src/outbox/love-ops';
import { authorizedLiveOptions } from '../../write/support';
import { type Harness, LOVE, withHarness } from './support';

const projectionRandom = seededRandom(27);
async function projectLove(h: Harness, rkey: string, live = false) {
  const car = await h.kit.repos.Alice.getRecordCar(LOVE, rkey);
  const proof = await verifyRecordProof(car, {
    did: h.alice,
    collection: LOVE,
    rkey,
    signingKey: h.kit.users.Alice.key.didKey,
  });
  const nowNs = fromMs(h.kit.clock.nowMs());
  return h.db.tx(() =>
    applyRecordProof(h.db, proof, {
      prefix: 'com.example.atmusic',
      nowNs,
      receiptNs: nowNs,
      ...(live ? authorizedLiveOptions(h.db, proof, projectionRandom) : {}),
    }),
  );
}

it.each([false, true])('audit late SENT producer order early=%s', async (early) => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    h.link(h.alice, 'lastfm');
    const created = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Late artist', track: 'Late track' },
      origin: 'web',
    });
    if (!created.ok) throw Error('enqueue');
    await h.runUntilIdle();
    const op = h.op(created.operation.id);
    await projectLove(h, op.rkey!, true);
    const effect = h.db.one<{ id: string; generation: number }>(
      "SELECT id,generation FROM forward_outbox WHERE kind='love' AND dedupe_key=?",
      op.id,
    )!;
    if (early) settleRows(h.db, [effect.id], 'sent', h.m.clock.nowMs(), null, true, effect.generation);
    await h.kit.externalDelete('Alice', LOVE, op.rkey!);
    const car = await h.kit.repos.Alice.getRecordCar(LOVE, op.rkey!);
    const proof = await verifyRecordProof(car, {
      did: h.alice,
      collection: LOVE,
      rkey: op.rkey!,
      signingKey: h.kit.users.Alice.key.didKey,
    });
    recordLiveEvidence(
      h.db,
      {
        uri: `at://${h.alice}/${LOVE}/${op.rkey}`,
        did: h.alice,
        collection: LOVE,
        rkey: op.rkey!,
        rev: proof.commit.rev,
        action: 'delete',
      },
      h.m.clock.nowMs(),
    );
    expect((await projectLove(h, op.rkey!, true)).outcome).toBe('absent');
    const pending = h.db.one<{ sent_operation_id: string | null }>(
      'SELECT sent_operation_id FROM love_api_recipients WHERE uri=?',
      `at://${h.alice}/${LOVE}/${op.rkey}`,
    );
    expect(pending).not.toBeNull();
    expect(
      h.db.one('SELECT 1 FROM love_api_unlove_decisions WHERE uri=?', `at://${h.alice}/${LOVE}/${op.rkey}`),
    ).not.toBeNull();
    if (!early) expect(pending!.sent_operation_id).toBeNull();
    if (!early) {
      expect(materializeLoveApiRecipientDecisions(h.db, h.m.clock.nowMs(), h.m.random, 'audit')).toMatchObject({
        awaiting: 1,
        queued: 0,
        deferred: 0,
      });
      expect(h.db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove' AND dedupe_key=?", op.id)).toBeNull();
    }
    if (!early) settleRows(h.db, [effect.id], 'sent', h.m.clock.nowMs(), null, true, effect.generation);
    const result = materializeLoveApiRecipientDecisions(h.db, h.m.clock.nowMs(), h.m.random, 'audit');
    expect(result.queued).toBe(1);
  });
});
