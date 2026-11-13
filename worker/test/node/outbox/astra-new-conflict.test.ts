import type { Clock } from '@atmusic/core/deps';
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { CredentialDeps } from '../../../src/credentials/accounts';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { Box } from '../../../src/crypto/box';
import type { Db } from '../../../src/do/db';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { executeAuthorizedRemovals } from '../../../src/do/ingest/live-pending-removals';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import type { DeleteForwardDeps } from '../../../src/forward/delete-forwarder';
import { runDeleteSlice } from '../../../src/forward/delete-forwarder';
import { type ForwardRuntime, runForward } from '../../../src/forward/forwarder';
import type { ListenbrainzClient } from '../../../src/forward/listenbrainz-client';
import { projectionListenKey } from '../../../src/forward/projection';
import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import {
  ALICE,
  authorizedLiveOptions,
  deleteProof,
  NOW_MS,
  OPTS,
  putProof,
  repoFor,
  SCROBBLE,
  scrobble,
  seedUser,
} from '../../write/support';
import { withMigratedDb } from '../support/node-db';

const record = scrobble({ artist: 'Björk', track: 'Jóga' });
const second = Date.parse(record.listenedAt as string) / 1000;
const [artistKey, musicTrackKey] = trackKey('Björk', 'Jóga');
const identity = projectionListenKey(ALICE, record.listenedAt as string, artistKey, musicTrackKey);
const live = (db: Db, proof: Awaited<ReturnType<typeof putProof>>) => authorizedLiveOptions(db, proof, rng);
function seedLink(db: Db) {
  seedUser(db, ALICE);
  const accountDeps: Pick<CredentialDeps, 'db' | 'clock'> = { db, clock: { nowMs: () => NOW_MS } };
  ensureAccount(accountDeps, { did: ALICE, verifiedHandle: null });
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
    VALUES ('replacement-link',?,'listenbrainz','alice',X'00','fixture',?,?)`,
    ALICE,
    NOW_MS,
    NOW_MS,
  );
}
function delivered(db: Db) {
  enqueueForwards(db, {
    did: ALICE,
    items: [{ kind: 'scrobble', listenKey: identity, payload: { listen: record } }],
    now: NOW_MS,
    random: seededRandom(
      620 +
        db.one<{ generation: number }>("SELECT generation FROM linked_accounts WHERE id='replacement-link'")!
          .generation,
    ),
  });
  db.run("UPDATE forward_outbox SET state='sent'");
}
const BATCH = `${SCROBBLE}Batch`;
const uri = (key: string, batch = false) => `at://${ALICE}/${batch ? BATCH : SCROBBLE}/${key}`;
const _batchRecord = (ids = ['2222222222222'], track = record.track) => {
  const { $type, ...entry } = record;
  return { $type: BATCH, createdAt: record.createdAt, listens: ids.map((id) => ({ ...entry, id, track })) };
};
async function drain(db: Db) {
  let now = NOW_MS,
    deletes = 0,
    lookups = 0;
  const clock = { nowMs: () => now };
  const deps: DeleteForwardDeps = {
    db,
    clock,
    random: seededRandom(9),
    box: { openText: () => 'fixture' } as unknown as Box,
    pacing: new UpstreamPacing(clock as Clock),
    client: {
      listWindowPage: async () => {
        lookups++;
        return {
          ok: true,
          rate: { remaining: 100, resetInS: 0 },
          value: [{ listenedAt: second, artist: 'Björk', track: 'Jóga', recordingMsid: 'fixture-msid' }],
        };
      },
      deleteListen: async () => {
        deletes++;
        return { ok: true, accepted: true, rate: { remaining: 100, resetInS: 0 } };
      },
    } as unknown as ListenbrainzClient,
  };
  for (let i = 0; i < 12; i++) {
    await runDeleteSlice(deps);
    now += 1000;
  }
  return { deletes, lookups };
}
async function forward(db: Db) {
  const submissions: Array<{ type: string; payload: unknown }> = [];
  const feedbacks: Array<{ recordingMbid: string; score: number }> = [];
  const clock = { nowMs: () => NOW_MS };
  const runtime = {
    db,
    clock,
    random: rng,
    log: { log: () => undefined },
    box: { openText: () => 'fixture' },
    pacing: new UpstreamPacing(clock),
    lastfm: null,
    listenbrainz: {
      submit: async (_token: string, type: string, payload: unknown) => {
        submissions.push({ type, payload });
        return { ok: true, value: null, rate: { remaining: 100, resetInS: 0 } };
      },
      feedback: async (_token: string, recordingMbid: string, score: number) => {
        feedbacks.push({ recordingMbid, score });
        return { ok: true, value: null, rate: { remaining: 100, resetInS: 0 } };
      },
    },
  } as unknown as ForwardRuntime;
  const report = await runForward(runtime, NOW_MS);
  return { submissions, feedbacks, report };
}

const rng = seededRandom(888);
const sweep = (db: Db, nowMs = NOW_MS) => db.tx(() => executeAuthorizedRemovals(db, { nowMs, random: rng, limit: 10 }));
it.each([false, true])('independent: delayed old event protects same-CID recreation=%s', async (recreated) => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  const again = await putProof(repo, SCROBBLE, 'a', record);
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    delivered(db);
    db.tx(() => applyRecordProof(db, gone, OPTS));
    expect(db.one('SELECT count(*) n FROM scrobbles')).toEqual({ n: 0 });
    expect(db.one('SELECT count(*) n FROM live_pending_removals')).toEqual({ n: 1 });
    expect((await drain(db)).deletes).toBe(0);
    if (recreated) db.tx(() => applyRecordProof(db, again, live(db, again)));
    enqueueHints(db, [
      {
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'a',
        source: 'jetstream',
        hintRev: gone.commit.rev,
        live: { operation: 'delete' },
        receiptMs: NOW_MS,
      },
    ]);
    db.run('DELETE FROM hints WHERE uri=?', uri('a'));
    sweep(db);
    const result = await drain(db);
    expect(result.deletes).toBe(recreated ? 0 : 1);
  });
});

it('fresh review: conflicted queued unlove must not reach upstream', async () => {
  const LOVE = 'com.example.atmusic.love';
  const key = '3333333333333';
  const recordingMbid = '00000000-0000-4000-8000-000000000001';
  const loveUri = `at://${ALICE}/${LOVE}/${key}`;
  const repo = await repoFor('alice');
  const first = await putProof(repo, LOVE, key, {
    $type: LOVE,
    artist: 'Björk',
    track: 'Jóga',
    recordingMbid,
    createdAt: '2026-01-15T11:00:00Z',
  });
  const gone = await deleteProof(repo, LOVE, key);
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    db.run("UPDATE forward_outbox SET state='sent' WHERE kind='love'");
    db.tx(() => applyRecordProof(db, gone, OPTS));
    expect(db.one('SELECT count(*) n FROM live_pending_removals')).toEqual({ n: 1 });
    enqueueHints(db, [
      {
        did: ALICE,
        collection: LOVE,
        rkey: key,
        source: 'jetstream',
        hintRev: gone.commit.rev,
        live: { operation: 'delete' },
        receiptMs: NOW_MS,
      },
    ]);
    sweep(db);
    expect(db.one("SELECT count(*) n FROM forward_outbox WHERE kind='unlove' AND state='queued'")).toEqual({ n: 1 });
    enqueueHints(db, [
      {
        did: ALICE,
        collection: LOVE,
        rkey: key,
        source: 'jetstream',
        hintRev: gone.commit.rev,
        live: { operation: 'create', cid: first.state === 'present' ? first.cid : '' },
        receiptMs: NOW_MS,
      },
    ]);
    expect(
      db.one('SELECT conflicted FROM live_pending_removal_events WHERE uri=? AND rev=?', loveUri, gone.commit.rev),
    ).toEqual({ conflicted: 1 });
    const result = await forward(db);
    console.log('conflicted queued unlove remote calls', result.feedbacks);
    expect(result.feedbacks).toEqual([]);
    expect(
      db.one(
        "SELECT count(*) n FROM forward_outbox WHERE kind='unlove' AND state='ignored' AND last_error='authorization_conflicted'",
      ),
    ).toEqual({ n: 1 });
    expect(db.one('SELECT count(*) n FROM live_pending_removals WHERE uri=?', loveUri)).toEqual({ n: 0 });
  });
});
