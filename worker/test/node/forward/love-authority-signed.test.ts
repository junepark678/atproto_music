import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { readLiveEvidence } from '../../../src/do/ingest/live-evidence';
import { executeAuthorizedRemovals } from '../../../src/do/ingest/live-pending-removals';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { runLoveCoverageChunk } from '../../../src/forward/love-coverage';
import { type enqueueForwards, enqueueLiveUnlove } from '../../../src/outbox/forward-enqueue';
import { ALICE as DID, deleteProof, liveApplyOptions, PREFIX, putProof, repoFor, seedUser } from '../../write/support';
import { withMigratedDb } from '../support/node-db';

const NOW_MS = Date.parse('2026-01-15T12:00:00Z');
const random = seededRandom(837);

function addPausedLink(db: Parameters<typeof enqueueForwards>[0]): void {
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,forward_scrobbles,
       status,backfill_state,created_at_ms,updated_at_ms)
     VALUES('signed-authority',?,'listenbrainz','remote',X'00','e1',1,1,'active','done',1,1)`,
    DID,
  );
}

describe('signed delete callers and manual signed-update authority enqueues', () => {
  for (const delayed of [false, true]) {
    for (const action of ['delete', 'update'] as const) {
      it(`${action === 'update' ? 'manually enqueues update authority after' : 'removes through the delete caller with'} ${delayed ? 'late' : 'early'} signed evidence`, async () => {
        const repo = await repoFor('alice');
        const collection = `${PREFIX}.love`;
        const rkey = '3lbqlove01ab';
        const first = await putProof(repo, collection, rkey, {
          $type: collection,
          artist: 'Artist A',
          track: 'Track T',
          createdAt: '2026-01-15T11:00:00Z',
        });
        const next =
          action === 'delete'
            ? await deleteProof(repo, collection, rkey)
            : await putProof(repo, collection, rkey, {
                $type: collection,
                artist: 'Artist B',
                track: 'Track T',
                createdAt: '2026-01-15T11:00:00Z',
              });

        await withMigratedDb((db) => {
          seedUser(db, DID);
          addPausedLink(db);
          const uri = `at://${DID}/${collection}/${rkey}`;
          expect(first.state).toBe('present');
          if (first.state !== 'present') return;
          enqueueHints(db, [
            {
              did: DID,
              collection,
              rkey,
              source: 'jetstream',
              hintRev: first.commit.rev,
              live: { operation: 'create', cid: first.cid },
              receiptMs: NOW_MS,
            },
          ]);
          db.tx(() =>
            applyRecordProof(db, first, {
              ...liveApplyOptions(first, random, 'create'),
              live: { random, evidence: readLiveEvidence(db, uri, NOW_MS), legacyRev: null },
            }),
          );
          expect(db.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='love'")).toEqual({ n: 1 });
          db.run("UPDATE forward_outbox SET state='sent'");
          db.run("UPDATE linked_accounts SET forward_scrobbles=0 WHERE id='signed-authority'");
          const hint = () =>
            enqueueHints(db, [
              {
                did: DID,
                collection,
                rkey,
                source: 'jetstream',
                hintRev: next.commit.rev,
                live: { operation: action, ...(next.state === 'present' ? { cid: next.cid } : {}) },
                receiptMs: NOW_MS + 1,
              },
            ]);
          if (!delayed) hint();
          const proofAction = action === 'delete' ? 'delete' : 'update';
          db.tx(() =>
            applyRecordProof(db, next, {
              ...liveApplyOptions(next, random, proofAction),
              live: { random, evidence: readLiveEvidence(db, uri, NOW_MS + 1), legacyRev: null },
            }),
          );
          if (delayed) {
            hint();
            if (action === 'delete') executeAuthorizedRemovals(db, { nowMs: NOW_MS + 1, random, limit: 16 });
          }
          // The inherited love update projector does not emit this effect. This branch
          // tests trusted materialization through an explicit enqueuer, not caller wiring.
          if (action === 'update')
            enqueueLiveUnlove(db, {
              did: DID,
              linkId: 'signed-authority',
              now: NOW_MS + 1,
              random,
              operationId: `signed-update:${next.commit.rev}`,
              payload: { artist: 'Artist A', track: 'Track T', origin: 'web' },
              authorization: { uri, rev: next.commit.rev },
            });
          expect(db.one("SELECT count(*) AS n FROM forward_deferred_love_intents WHERE kind='unlove'")).toEqual({
            n: 1,
          });
          expect(db.one('SELECT action FROM forward_deferred_love_authorities')).toEqual({ action });

          const link = db.one("SELECT * FROM linked_accounts WHERE id='signed-authority'")!;
          db.run("UPDATE linked_accounts SET forward_scrobbles=1,backfill_state='running',backfill_discovery_done=1");
          expect(runLoveCoverageChunk(db, link as never, NOW_MS + 2, random, 16)).toBe(1);
          expect(db.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove'")).toEqual({ n: 1 });
          expect(db.one("SELECT retired_at_ms FROM forward_receipts WHERE kind='unlove'")).toEqual({
            retired_at_ms: null,
          });
        });
      });
    }
  }
});
