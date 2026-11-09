import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { CredentialDeps } from '../../../src/credentials/accounts';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { Db } from '../../../src/do/db';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { executeAuthorizedRemovals, recordPendingRemoval } from '../../../src/do/ingest/live-pending-removals';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { type ForwardRuntime, runForward } from '../../../src/forward/forwarder';
import { LastfmClient } from '../../../src/forward/lastfm-client';
import { ListenbrainzClient } from '../../../src/forward/listenbrainz-client';
import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { enqueueRevivedLoves } from '../../../src/musicbrainz/revive-loves';
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
const [artistKey, musicTrackKey] = trackKey('Björk', 'Jóga');
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
const uri = (key: string) => `at://${ALICE}/${SCROBBLE}/${key}`;
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
    lastfm: new LastfmClient({
      apiRoot: 'https://lastfm.invalid/2.0/',
      apiKey: 'fixture',
      sharedSecret: 'fixture',
      fetch: async (_url, init) => {
        const body = new URLSearchParams(String(init?.body));
        feedbacks.push({ recordingMbid: body.get('method')!, score: 0 });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    }),
    listenbrainz: new ListenbrainzClient({
      apiRoot: 'https://listenbrainz.invalid/',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        feedbacks.push({ recordingMbid: body.recording_mbid, score: body.score });
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    }),
  } as unknown as ForwardRuntime;
  const report = await runForward(runtime, NOW_MS);
  return { submissions, feedbacks, report };
}

const rng = seededRandom(888);
const sweep = (db: Db, nowMs = NOW_MS) => db.tx(() => executeAuthorizedRemovals(db, { nowMs, random: rng, limit: 10 }));

it.each(['listenbrainz', 'lastfm'])('independent direct and delayed dispatch %s', async (service) => {
  for (const direct of [false, true])
    for (const conflict of [false, true]) {
      const LOVE = 'com.example.atmusic.love',
        key = '3333333333333';
      const loveUri = `at://${ALICE}/${LOVE}/${key}`;
      const repo = await repoFor('alice');
      const first = await putProof(repo, LOVE, key, {
        $type: LOVE,
        artist: 'Björk',
        track: 'Jóga',
        recordingMbid: '00000000-0000-4000-8000-000000000001',
        createdAt: '2026-01-15T11:00:00Z',
      });
      const gone = await deleteProof(repo, LOVE, key);
      await withMigratedDb(async (db) => {
        seedLink(db);
        db.run('UPDATE linked_accounts SET service=?', service);
        db.tx(() => applyRecordProof(db, first, live(db, first)));
        db.run("UPDATE forward_outbox SET state='sent'");
        const hint = (operation: 'delete' | 'create') =>
          enqueueHints(db, [
            {
              did: ALICE,
              collection: LOVE,
              rkey: key,
              source: 'jetstream',
              hintRev: gone.commit.rev,
              live:
                operation === 'delete' ? { operation } : { operation, cid: first.state === 'present' ? first.cid : '' },
              receiptMs: NOW_MS,
            },
          ]);
        if (direct) hint('delete');
        db.tx(() => applyRecordProof(db, gone, direct ? live(db, gone) : OPTS));
        if (!direct) {
          hint('delete');
          sweep(db);
        }
        expect(db.one("SELECT count(*) n FROM forward_outbox WHERE kind='unlove' AND state='queued'")).toEqual({
          n: 1,
        });
        if (conflict) {
          hint('create');
          expect(
            db.one(
              'SELECT conflicted FROM live_pending_removal_events WHERE uri=? AND rev=?',
              loveUri,
              gone.commit.rev,
            ),
          ).toEqual({ conflicted: 1 });
        }
        const calls = (await forward(db)).feedbacks;
        console.log({ service, direct, conflict, calls });
        expect.soft(calls.length, JSON.stringify({ service, direct, conflict })).toBe(conflict ? 0 : 1);
      });
    }
});
it('independent revival must preserve the delayed unlove authorization', async () => {
  const LOVE = 'com.example.atmusic.love',
    key = '3333333333333',
    loveUri = `at://${ALICE}/${LOVE}/${key}`;
  const repo = await repoFor('alice');
  const first = await putProof(repo, LOVE, key, {
    $type: LOVE,
    artist: 'Björk',
    track: 'Jóga',
    createdAt: '2026-01-15T11:00:00Z',
  });
  const gone = await deleteProof(repo, LOVE, key);
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    db.run("UPDATE forward_outbox SET state='sent'");
    db.tx(() => applyRecordProof(db, gone, OPTS));
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
    db.run("UPDATE mb_tracks SET status='unmatched'");
    await forward(db);
    console.log('before revive', db.all('SELECT kind,state,last_error,authorization_uri FROM forward_outbox'));
    const revived = enqueueRevivedLoves(
      db,
      { artistKey, trackKey: musicTrackKey },
      '00000000-0000-4000-8000-000000000001',
      NOW_MS,
      100,
    );
    expect(revived.enqueued).toBe(1);
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
    console.log('revived', db.all('SELECT kind,state,last_error,authorization_uri FROM forward_outbox'));
    const calls = (await forward(db)).feedbacks;
    console.log('revived calls', calls);
    expect(calls).toEqual([]);
  });
});

it('independent conflict before MBID revival survives TTL cleanup and restart with zero HTTP effects', async () => {
  const LOVE = 'com.example.atmusic.love',
    key = '3333333333333',
    loveUri = `at://${ALICE}/${LOVE}/${key}`;
  const repo = await repoFor('alice');
  const first = await putProof(repo, LOVE, key, {
    $type: LOVE,
    artist: 'Björk',
    track: 'Jóga',
    createdAt: '2026-01-15T11:00:00Z',
  });
  const gone = await deleteProof(repo, LOVE, key);
  await withMigratedDb(async (initialDb) => {
    let db = initialDb;
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    db.run("UPDATE forward_outbox SET state='sent'");
    db.tx(() => applyRecordProof(db, gone, OPTS));
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
    db.run("UPDATE mb_tracks SET status='unmatched'");
    await forward(db);
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
      db.one("SELECT state,last_error,authorization_uri,authorization_rev FROM forward_outbox WHERE kind='unlove'"),
    ).toMatchObject({
      state: 'ignored',
      last_error: 'authorization_conflicted',
      authorization_uri: loveUri,
      authorization_rev: gone.commit.rev,
    });
    const revived = enqueueRevivedLoves(
      db,
      { artistKey, trackKey: musicTrackKey },
      '00000000-0000-4000-8000-000000000001',
      NOW_MS,
      100,
    );
    expect(revived.enqueued).toBe(0);
    db.run(
      'UPDATE live_pending_removal_events SET expires_at_ms=?,cleanup_due_ms=? WHERE uri=? AND rev=?',
      NOW_MS - 1,
      NOW_MS,
      loveUri,
      gone.commit.rev,
    );
    db.tx(() => executeAuthorizedRemovals(db, { nowMs: NOW_MS, random: rng, limit: 0 }));
    expect(
      db.one('SELECT 1 FROM live_pending_removal_events WHERE uri=? AND rev=?', loveUri, gone.commit.rev),
    ).toBeNull();
    db = reopen(db);
    const replayRevival = enqueueRevivedLoves(
      db,
      { artistKey, trackKey: musicTrackKey },
      '00000000-0000-4000-8000-000000000001',
      NOW_MS,
      100,
    );
    expect(replayRevival.enqueued).toBe(0);
    expect((await forward(db)).feedbacks).toEqual([]);
  });
});
it('independent retention must see a window inserted behind its durable frontier', async () => {
  await withMigratedDb((db) => {
    seedLink(db);
    const u = uri('retention'),
      rev = 'mmmmmmmmmmmmm';
    for (let i = 0; i < 128; i++)
      db.run(
        `INSERT INTO live_pending_removals(uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,artist_key,track_key,artist,track,created_at_ms,expires_at_ms) VALUES(?,?,'old','scrobble','nnnnnnnnnnnnn','zzzzzzzzzzzzz','','k','a','t','A','T',1,?)`,
        u,
        String(i).padStart(4, '0'),
        NOW_MS + 1000000,
      );
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,conflicted,scan_complete,created_at_ms,expires_at_ms,cleanup_due_ms) VALUES(?,?,'delete',1,1,1,?,?)`,
      u,
      rev,
      NOW_MS - 1,
      NOW_MS,
    );
    db.tx(() => executeAuthorizedRemovals(db, { nowMs: NOW_MS, random: rng, limit: 0 }));
    recordPendingRemoval(db, {
      did: ALICE,
      uri: u,
      kind: 'scrobble',
      row: {
        uri: u,
        cid: 'old',
        record_uri: null,
        listen_id: null,
        listened_at: record.listenedAt as string,
        artist_key: 'a',
        track_key: 't',
        artist: 'A',
        track: 'T',
        recording_mbid: null,
      },
      identityKey: 'new-window',
      windowLo: 'aaaaaaaaaaaaa',
      windowHi: 'ppppppppppppp',
      replacedByCid: null,
      nowMs: NOW_MS + 1,
    });
    db.tx(() => executeAuthorizedRemovals(db, { nowMs: NOW_MS + 60000, random: rng, limit: 0 }));
    expect(db.one('SELECT 1 FROM live_pending_removals WHERE identity_key=?', 'new-window')).not.toBeNull();
    expect(db.one('SELECT 1 FROM live_pending_removal_events WHERE uri=? AND rev=?', u, rev)).not.toBeNull();
  });
});
