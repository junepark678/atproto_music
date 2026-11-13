import type { Clock } from '@atmusic/core/deps';
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { CredentialDeps } from '../../../src/credentials/accounts';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { Box } from '../../../src/crypto/box';
import type { Db, SqlParam } from '../../../src/do/db';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { LIVE_EVIDENCE_TTL_MS } from '../../../src/do/ingest/live-evidence';
import {
  authorizePendingRemovals,
  executeAuthorizedRemovals,
  type PendingListen,
  recordPendingRemoval,
} from '../../../src/do/ingest/live-pending-removals';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import type { DeleteForwardDeps } from '../../../src/forward/delete-forwarder';
import { runDeleteSlice } from '../../../src/forward/delete-forwarder';
import { type ForwardRuntime, runForward } from '../../../src/forward/forwarder';
import type { ListenbrainzClient } from '../../../src/forward/listenbrainz-client';
import { lateAccept } from '../../../src/forward/live-acceptance';
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
import { reopen, withMigratedDb } from '../support/node-db';

const record = scrobble({ artist: 'Björk', track: 'Jóga' });
const second = Date.parse(record.listenedAt as string) / 1000;
const [artistKey, musicTrackKey] = trackKey('Björk', 'Jóga');
const identity = projectionListenKey(ALICE, record.listenedAt as string, artistKey, musicTrackKey);
const live = (db: Db, proof: Awaited<ReturnType<typeof putProof>>) => authorizedLiveOptions(db, proof, rng);

it.each(
  (['conflict-first', 'valid-first', 'no-conflict'] as const).flatMap((order) =>
    (['before-window', 'after-window'] as const).flatMap((arrival) =>
      (['earlier', 'later'] as const).map((validRevision) => ({ order, arrival, validRevision })),
    ),
  ),
)('authorizes an independent $validRevision delete: $order, $arrival', async ({ order, arrival, validRevision }) => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const earlierDelete = await deleteProof(repo, SCROBBLE, 'a');
  const middle = await putProof(repo, SCROBBLE, 'a', scrobble({ artist: 'Other', track: 'Middle' }));
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  if (first.state !== 'present' || middle.state !== 'present') throw new Error('expected present fixture proofs');
  const valid = validRevision === 'earlier' ? earlierDelete : gone;
  await withMigratedDb(async (db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, first, live(db, first))).outcome).toBe('applied');
    delivered(db);
    const enqueueValid = () =>
      enqueueHints(db, [
        {
          did: ALICE,
          collection: SCROBBLE,
          rkey: 'a',
          source: 'jetstream',
          hintRev: valid.commit.rev,
          live: { operation: 'delete' },
          receiptMs: NOW_MS,
        },
      ]);
    const enqueueConflict = () => {
      for (const cid of [middle.cid, first.cid])
        enqueueHints(db, [
          {
            did: ALICE,
            collection: SCROBBLE,
            rkey: 'a',
            source: 'jetstream',
            hintRev: middle.commit.rev,
            live: { operation: 'update', cid },
            receiptMs: NOW_MS,
          },
        ]);
    };
    const events = () => {
      if (order === 'valid-first') enqueueValid();
      if (order !== 'no-conflict') enqueueConflict();
      if (order !== 'valid-first') enqueueValid();
    };
    if (arrival === 'before-window') events();
    expect(db.tx(() => applyRecordProof(db, gone, OPTS)).outcome).toBe('absent');
    if (arrival === 'after-window') events();
    sweep(db);
    expect((await drain(db)).deletes).toBe(1);
  });
});

it.each(['valid-before-conflict', 'valid-after-conflict', 'no-alternative', 'ineligible-alternative'] as const)(
  'reconsiders retained authorizations after conflict: %s',
  async (order) => {
    const repo = await repoFor('alice');
    const first = await putProof(repo, SCROBBLE, 'a', record);
    const older = await deleteProof(repo, SCROBBLE, 'a');
    const middle = await putProof(repo, SCROBBLE, 'a', scrobble({ artist: 'Other', track: 'Middle' }));
    const newer = await deleteProof(repo, SCROBBLE, 'a');
    if (first.state !== 'present' || middle.state !== 'present') throw new Error('expected present fixture proofs');
    await withMigratedDb(async (db) => {
      seedLink(db);
      expect(db.tx(() => applyRecordProof(db, first, live(db, first))).outcome).toBe('applied');
      delivered(db);
      expect(db.tx(() => applyRecordProof(db, newer, OPTS)).outcome).toBe('absent');
      const event = (rev: string, operation: 'delete' | 'update', cid?: string) =>
        enqueueHints(db, [
          {
            did: ALICE,
            collection: SCROBBLE,
            rkey: 'a',
            source: 'jetstream',
            hintRev: rev,
            live: { operation, cid },
            receiptMs: NOW_MS,
          },
        ]);
      event(older.commit.rev, 'delete');
      event(middle.commit.rev, 'update', middle.cid);
      event(middle.commit.rev, 'update', first.cid);
      if (order === 'valid-before-conflict') event(newer.commit.rev, 'delete');
      event(older.commit.rev, 'update', first.cid);
      if (order === 'valid-after-conflict') event(newer.commit.rev, 'delete');
      if (order === 'ineligible-alternative') event(newer.commit.rev, 'update', middle.cid);
      const originalExpiry = db.one<{ expires_at_ms: number }>(
        'SELECT expires_at_ms FROM live_pending_removals',
      )!.expires_at_ms;
      for (let i = 0; i < 5; i++) sweep(db);
      const validAlternative = order === 'valid-before-conflict' || order === 'valid-after-conflict';
      expect((await drain(db)).deletes).toBe(validAlternative ? 1 : 0);
      if (!validAlternative) {
        expect(db.one('SELECT authorized_rev,expires_at_ms FROM live_pending_removals')).toEqual({
          authorized_rev: null,
          expires_at_ms: originalExpiry,
        });
        expect(
          db.one(
            'SELECT 1 FROM live_pending_removal_events WHERE uri=? AND rev=? AND conflicted=1',
            uri('a'),
            older.commit.rev,
          ),
        ).not.toBeNull();
      }
    });
  },
);

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
const batchRecord = (ids = ['2222222222222'], track = record.track) => {
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

import { readLiveEvidence } from '../../../src/do/ingest/live-evidence';

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

it('delayed removal excludes the complete batch of removed copies and deletes after the final canonical copy goes', async () => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const batch = await putProof(repo, BATCH, 'b', batchRecord(['2222222222222', '3333333333333']));
  const removeSingle = await deleteProof(repo, SCROBBLE, 'a');
  const removeBatch = await deleteProof(repo, BATCH, 'b');
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    db.tx(() => applyRecordProof(db, batch, live(db, batch)));
    delivered(db);
    db.tx(() => applyRecordProof(db, removeSingle, OPTS));
    enqueueHints(db, [
      {
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'a',
        source: 'jetstream',
        hintRev: removeSingle.commit.rev,
        live: { operation: 'delete' },
        receiptMs: NOW_MS,
      },
    ]);
    sweep(db);
    expect((await drain(db)).deletes).toBe(0);
    expect(db.one('SELECT count(*) n FROM listenbrainz_deletes')).toEqual({ n: 0 });
    db.tx(() => applyRecordProof(db, removeBatch, OPTS));
    enqueueHints(db, [
      {
        did: ALICE,
        collection: BATCH,
        rkey: 'b',
        source: 'jetstream',
        hintRev: removeBatch.commit.rev,
        live: { operation: 'delete' },
        receiptMs: NOW_MS,
      },
    ]);
    sweep(db);
    expect((await drain(db)).deletes).toBe(1);
    expect(db.one('SELECT count(*) n FROM listenbrainz_deletes')).toEqual({ n: 1 });
  });
});

it('replacement with delayed matching update deletes the old listen and late-forwards the new one', async () => {
  const repo = await repoFor('alice');
  const old = await putProof(repo, SCROBBLE, 'replacement', record);
  const replacementRecord = scrobble({ artist: 'Björk', track: 'Army of Me' });
  const replacement = await putProof(repo, SCROBBLE, 'replacement', replacementRecord);
  if (old.state !== 'present' || replacement.state !== 'present') throw new Error('expected present records');
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, old, live(db, old)));
    delivered(db);
    db.tx(() =>
      applyRecordProof(db, replacement, {
        ...OPTS,
        liveCandidates: true,
        live: { random: rng, evidence: null, legacyRev: null },
      }),
    );
    expect(db.one('SELECT count(*) n FROM live_pending_removals')).toEqual({ n: 1 });
    expect(db.one('SELECT count(*) n FROM live_acceptance_candidates')).toEqual({ n: 1 });
    enqueueHints(db, [
      {
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'replacement',
        source: 'jetstream',
        hintRev: replacement.commit.rev,
        live: { operation: 'update', cid: replacement.cid },
        receiptMs: NOW_MS,
      },
    ]);
    sweep(db);
    const accepted = db.tx(() =>
      lateAccept(db, {
        uri: uri('replacement'),
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'replacement',
        evidence: readLiveEvidence(db, uri('replacement'), NOW_MS),
        raceFloorRev: '0000000000000',
        nowMs: NOW_MS,
        random: rng,
      }),
    );
    expect(accepted).toBe(1);
    expect((await drain(db)).deletes).toBe(1);
    const result = await forward(db);
    expect(result.submissions).toHaveLength(1);
    expect(result.submissions[0]).toMatchObject({ type: 'single' });
  });
});

it('authorizes the original and recreated incarnations independently when both deletes precede the drain', async () => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'two-deletes', record);
  const firstDelete = await deleteProof(repo, SCROBBLE, 'two-deletes');
  const recreated = await putProof(repo, SCROBBLE, 'two-deletes', record);
  if (recreated.state !== 'present') throw new Error('expected recreated record');
  const secondDelete = await deleteProof(repo, SCROBBLE, 'two-deletes');
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    delivered(db);
    db.tx(() => applyRecordProof(db, firstDelete, OPTS));
    db.tx(() => applyRecordProof(db, recreated, live(db, recreated)));
    db.tx(() => applyRecordProof(db, secondDelete, OPTS));
    enqueueHints(db, [
      {
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'two-deletes',
        source: 'jetstream',
        hintRev: firstDelete.commit.rev,
        live: { operation: 'delete' },
        receiptMs: NOW_MS,
      },
      {
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'two-deletes',
        source: 'jetstream',
        hintRev: recreated.commit.rev,
        live: { operation: 'create', cid: recreated.cid },
        receiptMs: NOW_MS,
      },
      {
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'two-deletes',
        source: 'jetstream',
        hintRev: secondDelete.commit.rev,
        live: { operation: 'delete' },
        receiptMs: NOW_MS,
      },
    ]);
    for (let i = 0; i < 4; i++) sweep(db);
    expect(db.one('SELECT count(*) n FROM listenbrainz_deletes')).toEqual({ n: 2 });
    // The two authorized incarnations produce independent durable delete rows;
    // the remote lookup/delete protocol sends the actual deletion once because
    // the first accepted removal makes the identical listen absent upstream.
    expect((await drain(db)).deletes).toBe(1);
  });
});
it('independent: exact stale replay cannot extend pending TTL', async () => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  await withMigratedDb((db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    delivered(db);
    const row = db.one<PendingListen>('SELECT * FROM scrobbles WHERE uri=?', uri('a'))!;
    db.tx(() => applyRecordProof(db, gone, OPTS));
    const original = db.one<{ expires_at_ms: number }>(
      'SELECT expires_at_ms FROM live_pending_removals',
    )!.expires_at_ms;
    recordPendingRemoval(db, {
      did: ALICE,
      uri: uri('a'),
      kind: 'scrobble',
      row,
      identityKey: identity,
      windowLo: first.commit.rev,
      windowHi: gone.commit.rev,
      replacedByCid: null,
      nowMs: NOW_MS + LIVE_EVIDENCE_TTL_MS - 1,
    });
    expect(db.one<{ expires_at_ms: number }>('SELECT expires_at_ms FROM live_pending_removals')!.expires_at_ms).toBe(
      original,
    );
  });
});
it('independent: conflict remains disqualifying after newer evidence arrives', async () => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  const next = await putProof(repo, SCROBBLE, 'a', record);
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    delivered(db);
    db.tx(() => applyRecordProof(db, gone, OPTS));
    for (const [rev, operation, cid] of [
      [gone.commit.rev, 'delete', undefined],
      [gone.commit.rev, 'create', first.state === 'present' ? first.cid : ''],
      [next.commit.rev, 'create', next.state === 'present' ? next.cid : ''],
    ] as const)
      enqueueHints(db, [
        {
          did: ALICE,
          collection: SCROBBLE,
          rkey: 'a',
          source: 'jetstream',
          hintRev: rev,
          live: { operation, cid },
          receiptMs: NOW_MS,
        },
      ]);
    sweep(db);
    expect((await drain(db)).deletes).toBe(0);
  });
});
it('independent: delayed love removal protects a newer external recreation', async () => {
  const LOVE = 'com.example.atmusic.love';
  const key = '2222222222222';
  const repo = await repoFor('alice');
  const loved = { $type: LOVE, artist: 'Björk', track: 'Jóga', createdAt: '2026-01-15T11:00:00Z' };
  const first = await putProof(repo, LOVE, key, loved);
  const gone = await deleteProof(repo, LOVE, key);
  const again = await putProof(repo, LOVE, key, loved);
  await withMigratedDb((db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    db.run("UPDATE forward_outbox SET state='sent'");
    expect(db.one('SELECT count(*) n FROM loves')).toEqual({ n: 1 });
    db.tx(() => applyRecordProof(db, gone, OPTS));
    expect(db.one('SELECT count(*) n FROM live_pending_removals')).toEqual({ n: 1 });
    db.tx(() => applyRecordProof(db, again, live(db, again)));
    expect(db.one('SELECT count(*) n FROM loves')).toEqual({ n: 1 });
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
    expect(db.one("SELECT count(*) n FROM forward_outbox WHERE kind='unlove'")).toEqual({ n: 0 });
  });
});

it('forwards one delayed unlove after the signed delete event', async () => {
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
    const result = await forward(db);
    expect(result.feedbacks).toEqual([{ recordingMbid, score: 0 }]);
    expect(db.one("SELECT count(*) n FROM forward_outbox WHERE kind='unlove' AND state='sent'")).toEqual({ n: 1 });
    expect(db.one('SELECT count(*) n FROM live_pending_removals WHERE uri=?', loveUri)).toEqual({ n: 0 });
  });
});
it('independent: group failure rolls back effects and keeps authorization under caller transaction', async () => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  await withMigratedDb((db, _ctx) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    delivered(db);
    db.tx(() => applyRecordProof(db, gone, OPTS));
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
    const failing: Db = {
      all: db.all.bind(db),
      one: db.one.bind(db),
      tx: db.tx.bind(db),
      run(sql, ...args) {
        if (sql.startsWith('DELETE FROM live_pending_removals INDEXED BY')) throw new Error('injected');
        return db.run(sql, ...args);
      },
    };
    expect(() => db.tx(() => executeAuthorizedRemovals(failing, { nowMs: NOW_MS, random: rng, limit: 10 }))).toThrow(
      'injected',
    );
    expect(db.one('SELECT count(*) n FROM listenbrainz_deletes')).toEqual({ n: 0 });
    expect(db.one('SELECT count(*) n FROM linked_pull_tombstones')).toEqual({ n: 0 });
    expect(db.one('SELECT authorized_rev FROM live_pending_removals')).toEqual({ authorized_rev: gone.commit.rev });
  });
});
it('independent: intersecting windows are all considered for matching authorization', async () => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  const newer = await putProof(repo, SCROBBLE, 'b', record);
  await withMigratedDb((db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    const row = db.one<PendingListen>('SELECT * FROM scrobbles')!;
    const common = {
      did: ALICE,
      uri: uri('a'),
      kind: 'scrobble' as const,
      row,
      identityKey: identity,
      windowLo: first.commit.rev,
      nowMs: NOW_MS,
    };
    recordPendingRemoval(db, { ...common, windowHi: gone.commit.rev, replacedByCid: 'wrong' });
    recordPendingRemoval(db, { ...common, windowHi: newer.commit.rev, replacedByCid: 'matching' });
    authorizePendingRemovals(db, { uri: uri('a'), rev: gone.commit.rev, action: 'update', cid: 'matching' }, NOW_MS);
    expect(db.one("SELECT authorized_rev FROM live_pending_removals WHERE replaced_by_cid='matching'")).toEqual({
      authorized_rev: gone.commit.rev,
    });
  });
});

it.each([130])('resumes bounded authorization scans across %s same-URI windows and a restart', async (count) => {
  const eventRev = '3mchjvhag2322';
  const high = 'zzzzzzzzzzzzz';
  const row = {
    uri: uri('a'),
    record_uri: null,
    listen_id: null,
    cid: 'removed-cid',
    listened_at: record.listenedAt as string,
    artist_key: artistKey,
    track_key: musicTrackKey,
    artist: 'Björk',
    track: 'Jóga',
    recording_mbid: null,
  };
  await withMigratedDb((initial, ctx) => {
    let db = initial;
    seedLink(db);
    for (let i = 0; i < count; i++)
      recordPendingRemoval(db, {
        did: ALICE,
        uri: uri('a'),
        kind: 'scrobble',
        row,
        identityKey: identity,
        windowLo: String(i).padStart(13, '0'),
        windowHi: high,
        replacedByCid: i === count - 1 ? 'matching' : `wrong-${i}`,
        nowMs: NOW_MS,
      });
    const trace: string[] = [];
    const tracked = (target: Db): Db => ({
      all<T>(sql: string, ...params: SqlParam[]): T[] {
        if (sql.includes('live_pending_removals_page')) {
          trace.push(sql);
          const page = target.all<T>(sql, ...params);
          expect(page.length).toBeLessThanOrEqual(128);
          return page;
        }
        return target.all<T>(sql, ...params);
      },
      one: target.one.bind(target),
      run: target.run.bind(target),
      tx: target.tx.bind(target),
    });
    authorizePendingRemovals(tracked(db), { uri: uri('a'), rev: eventRev, action: 'update', cid: 'matching' }, NOW_MS);
    expect(
      db.one('SELECT scan_complete FROM live_pending_removal_events WHERE uri=? AND rev=?', uri('a'), eventRev),
    ).toEqual({ scan_complete: 0 });
    db = reopen(db);
    ctx.current = db;
    // A matching window inserted after the cursor passed its key is authorized
    // from the retained event journal at insertion time.
    recordPendingRemoval(db, {
      did: ALICE,
      uri: uri('a'),
      kind: 'scrobble',
      row,
      identityKey: identity,
      windowLo: '0000000000000',
      windowHi: high,
      replacedByCid: 'matching',
      nowMs: NOW_MS,
    });
    authorizePendingRemovals(db, { uri: uri('a'), rev: eventRev, action: 'update', cid: 'matching' }, NOW_MS);
    for (let page = 0; page < Math.ceil(count / 128) + 3; page++) {
      executeAuthorizedRemovals(tracked(db), { nowMs: NOW_MS, random: rng, uri: uri('a'), limit: 1 });
      if (
        db.one<{ scan_complete: number }>(
          'SELECT scan_complete FROM live_pending_removal_events WHERE uri=? AND rev=?',
          uri('a'),
          eventRev,
        )?.scan_complete === 1
      )
        break;
      db = reopen(db);
      ctx.current = db;
    }
    for (let i = 0; i < 3; i++)
      executeAuthorizedRemovals(tracked(db), { nowMs: NOW_MS, random: rng, uri: uri('a'), limit: 10 });
    expect(
      db.one('SELECT scan_complete FROM live_pending_removal_events WHERE uri=? AND rev=?', uri('a'), eventRev),
    ).toEqual({ scan_complete: 1 });
    expect(
      db.one<{ value: number }>("SELECT value FROM counters WHERE name='live_admission' AND label='pending_groups_run'")
        ?.value,
    ).toBe(2);
    const before = db.one<{ n: number }>('SELECT count(*) AS n FROM live_pending_removals')?.n;
    authorizePendingRemovals(db, { uri: uri('a'), rev: eventRev, action: 'update', cid: 'matching' }, NOW_MS);
    executeAuthorizedRemovals(db, { nowMs: NOW_MS, random: rng, uri: uri('a'), limit: 10 });
    expect(db.one<{ n: number }>('SELECT count(*) AS n FROM live_pending_removals')?.n).toBe(before);
    expect(trace.length).toBeGreaterThanOrEqual(Math.floor(count / 128));
    expect(trace.every((sql) => sql.includes('LIMIT ?'))).toBe(true);
    expect(
      db
        .all<{ detail: string }>(
          'EXPLAIN QUERY PLAN SELECT kind,window_lo,window_hi,replaced_by_cid,member_uri,removed_cid,authorized_rev,conflict_invalidated FROM live_pending_removals INDEXED BY live_pending_removals_page WHERE uri=? AND window_hi>=? AND (window_hi,window_lo,replaced_by_cid,kind,member_uri,removed_cid)>(?,?,?,?,?,?) ORDER BY window_hi,window_lo,replaced_by_cid,kind,member_uri,removed_cid LIMIT ?',
          uri('a'),
          eventRev,
          '',
          '',
          '',
          '',
          '',
          '',
          128,
        )
        .map((x) => x.detail)
        .join(' '),
    ).toContain('live_pending_removals_page');
  });
});
