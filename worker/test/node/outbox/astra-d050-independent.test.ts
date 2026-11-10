import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { CredentialDeps } from '../../../src/credentials/accounts';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { Db } from '../../../src/do/db';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { executeAuthorizedRemovals, recordPendingRemoval } from '../../../src/do/ingest/live-pending-removals';
import { migrate } from '../../../src/do/migrate';
import { MIGRATIONS } from '../../../src/do/schema';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { type ForwardRuntime, runForward } from '../../../src/forward/forwarder';
import { LastfmClient } from '../../../src/forward/lastfm-client';
import { ListenbrainzClient } from '../../../src/forward/listenbrainz-client';
import { conflictDeferredLoveAuthority } from '../../../src/forward/love-coverage-authority';
import { noteForwardLoveCurrent } from '../../../src/forward/love-lanes';
import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { enqueueRevivedLoves } from '../../../src/musicbrainz/revive-loves';
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
const REVIVAL_MBID = '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae';
const DAY = 24 * 60 * 60 * 1000;
const REVIVAL_URI = `at://${ALICE}/com.example.atmusic.love/owned-revival`;
const REVIVAL_REV = '3lbcdefghijkm';
const [REVIVAL_ARTIST_KEY, REVIVAL_TRACK_KEY] = trackKey('Revival Artist', 'Revival Track');
const sweep = (db: Db, nowMs = NOW_MS) => db.tx(() => executeAuthorizedRemovals(db, { nowMs, random: rng, limit: 10 }));

function enqueueOwnedRevivalParent(db: Db, error: 'no_recording_mbid' | 'mbid_unresolved', generation = 1) {
  seedLink(db);
  if (generation !== 1) db.run("UPDATE linked_accounts SET generation=? WHERE id='replacement-link'", generation);
  enqueueHints(db, [
    {
      did: ALICE,
      collection: 'com.example.atmusic.love',
      rkey: 'owned-revival',
      source: 'jetstream',
      hintRev: REVIVAL_REV,
      live: { operation: 'delete' },
      receiptMs: NOW_MS,
    },
  ]);
  enqueueForwards(db, {
    did: ALICE,
    now: NOW_MS,
    random: rng,
    items: [
      {
        kind: 'unlove',
        operationId: 'owned-revival-parent',
        payload: { artist: 'Revival Artist', track: 'Revival Track', origin: 'web' },
        authorization: { uri: REVIVAL_URI, rev: REVIVAL_REV },
      },
    ],
  });
  db.run(
    "UPDATE forward_outbox SET state='ignored',last_error=? WHERE dedupe_key=?",
    error,
    generation === 1 ? 'owned-revival-parent' : `g${generation}:owned-revival-parent`,
  );
  expect(
    db.one(
      'SELECT kind,authorization_uri,authorization_rev FROM forward_deferred_love_witnesses WHERE operation_id=?',
      'owned-revival-parent',
    ),
  ).toEqual({ kind: 'unlove', authorization_uri: REVIVAL_URI, authorization_rev: REVIVAL_REV });
  return {
    uri: REVIVAL_URI,
    rev: REVIVAL_REV,
    parentOperationId: 'owned-revival-parent',
    childOperationId: `mb-match:${REVIVAL_MBID}:replacement-link:${REVIVAL_ARTIST_KEY}:${REVIVAL_TRACK_KEY}`,
    generation,
  };
}

function reviveOwnedParent(db: Db) {
  return enqueueRevivedLoves(
    db,
    { artistKey: REVIVAL_ARTIST_KEY, trackKey: REVIVAL_TRACK_KEY },
    REVIVAL_MBID,
    NOW_MS,
    16,
  );
}

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

for (const error of ['no_recording_mbid', 'mbid_unresolved'] as const) {
  for (const ownership of ['parent-love-witness', 'owned-unlove-child-key'] as const) {
    it(`preserves ${error} love revival with ${ownership}`, async () => {
      await withMigratedDb(async (db) => {
        if (ownership === 'owned-unlove-child-key') {
          enqueueOwnedRevivalParent(db, error);
          expect(reviveOwnedParent(db).enqueued).toBe(1);
          expect((await forward(db)).feedbacks).toEqual([{ recordingMbid: REVIVAL_MBID, score: 0 }]);
        } else {
          seedLink(db);
          db.run("UPDATE linked_accounts SET forward_scrobbles=0 WHERE id='replacement-link'");
        }
        const item = {
          kind: 'love' as const,
          operationId: 'preserved-love-parent',
          payload: { artist: 'Revival Artist', track: 'Revival Track', origin: 'web' },
        };
        if (ownership === 'parent-love-witness') {
          enqueueForwards(db, { did: ALICE, now: NOW_MS, random: rng, items: [item] });
          expect(
            db.one("SELECT kind FROM forward_deferred_love_witnesses WHERE operation_id='preserved-love-parent'"),
          ).toEqual({ kind: 'love' });
          db.run("UPDATE linked_accounts SET forward_scrobbles=1 WHERE id='replacement-link'");
        }
        enqueueForwards(db, { did: ALICE, now: NOW_MS, random: rng, items: [item] });
        db.run(
          "UPDATE forward_outbox SET state='ignored',last_error=? WHERE dedupe_key='preserved-love-parent'",
          error,
        );
        expect(reviveOwnedParent(db).enqueued).toBe(1);
        expect((await forward(db)).feedbacks).toEqual([{ recordingMbid: REVIVAL_MBID, score: 1 }]);
        if (ownership === 'owned-unlove-child-key') {
          expect(
            db.one(
              'SELECT kind,authorization_uri,authorization_rev FROM forward_deferred_love_witnesses WHERE operation_id=?',
              `mb-match:${REVIVAL_MBID}:replacement-link:${REVIVAL_ARTIST_KEY}:${REVIVAL_TRACK_KEY}`,
            ),
          ).toEqual({ kind: 'unlove', authorization_uri: REVIVAL_URI, authorization_rev: REVIVAL_REV });
        }
      });
    });
  }
}

for (const error of ['no_recording_mbid', 'mbid_unresolved'] as const) {
  it(`revives an owned ${error} unlove with an exact child witness and one ListenBrainz effect`, async () => {
    await withMigratedDb(async (db) => {
      const parent = enqueueOwnedRevivalParent(db, error);
      expect(reviveOwnedParent(db).enqueued).toBe(1);
      expect(
        db.one(
          'SELECT kind,group_seq,love_artist_key,love_track_key,authorization_uri,authorization_rev FROM forward_deferred_love_witnesses WHERE operation_id=?',
          parent.childOperationId,
        ),
      ).toEqual({
        kind: 'unlove',
        group_seq: 1,
        love_artist_key: REVIVAL_ARTIST_KEY,
        love_track_key: REVIVAL_TRACK_KEY,
        authorization_uri: REVIVAL_URI,
        authorization_rev: REVIVAL_REV,
      });
      expect((await forward(db)).feedbacks).toEqual([{ recordingMbid: REVIVAL_MBID, score: 0 }]);
    });
  });

  for (const fact of ['missing', 'conflicted'] as const) {
    it(`refuses owned ${error} revival when its exact authority is ${fact} before child creation`, async () => {
      await withMigratedDb(async (db) => {
        const parent = enqueueOwnedRevivalParent(db, error);
        if (fact === 'missing') db.run('DELETE FROM forward_deferred_love_authorities');
        else db.tx(() => conflictDeferredLoveAuthority(db, parent.uri, parent.rev));
        db.run('DELETE FROM live_pending_removal_events');
        db.run('DELETE FROM live_record_evidence');
        expect(reviveOwnedParent(db).enqueued).toBe(0);
        expect(db.one("SELECT 1 FROM forward_outbox WHERE dedupe_key LIKE 'mb-match:%'")).toBeNull();
        expect((await forward(db)).feedbacks).toEqual([]);
      });
    });
  }

  for (const fact of ['missing', 'conflicted'] as const) {
    it(`blocks owned ${error} child dispatch when its exact authority becomes ${fact}`, async () => {
      await withMigratedDb(async (db) => {
        const parent = enqueueOwnedRevivalParent(db, error);
        expect(reviveOwnedParent(db).enqueued).toBe(1);
        if (fact === 'missing') db.run('DELETE FROM forward_deferred_love_authorities');
        else db.tx(() => conflictDeferredLoveAuthority(db, parent.uri, parent.rev));
        db.run('DELETE FROM live_pending_removal_events');
        db.run('DELETE FROM live_record_evidence');
        expect((await forward(db)).feedbacks).toEqual([]);
        expect(db.one("SELECT state,last_error FROM forward_outbox WHERE dedupe_key LIKE 'mb-match:%'")).toEqual({
          state: 'ignored',
          last_error: fact === 'missing' ? 'authorization_unavailable' : 'authorization_conflicted',
        });
      });
    });
  }
}

for (const mismatch of ['kind', 'keys', 'authorization', 'namespace'] as const) {
  it(`does not revive an owned source when its ${mismatch} witness identity does not match`, async () => {
    await withMigratedDb((db) => {
      const generation = mismatch === 'namespace' ? 2 : 1;
      const parent = enqueueOwnedRevivalParent(db, 'mbid_unresolved', generation);
      if (mismatch === 'kind')
        db.run("UPDATE forward_deferred_love_witnesses SET kind='love' WHERE operation_id=?", parent.parentOperationId);
      if (mismatch === 'keys')
        db.run(
          "UPDATE forward_deferred_love_witnesses SET love_artist_key='wrong-key' WHERE operation_id=?",
          parent.parentOperationId,
        );
      if (mismatch === 'authorization')
        db.run(
          "UPDATE forward_deferred_love_witnesses SET authorization_rev='3lbcdefghijkn' WHERE operation_id=?",
          parent.parentOperationId,
        );
      if (mismatch === 'namespace')
        db.run(
          'UPDATE forward_outbox SET dedupe_key=? WHERE id=(SELECT id FROM forward_outbox WHERE dedupe_key=?)',
          'g1:owned-revival-parent',
          'g2:owned-revival-parent',
        );
      expect(reviveOwnedParent(db).enqueued).toBe(0);
      expect(
        db.one(
          "SELECT count(*) AS n FROM forward_outbox WHERE dedupe_key LIKE 'g%mb-match:%' OR dedupe_key LIKE 'mb-match:%'",
        ),
      ).toEqual({ n: 0 });
    });
  });
}

for (const mismatch of ['kind', 'keys', 'authorization'] as const) {
  it(`refuses to rebind an existing revival child witness with mismatched ${mismatch}`, async () => {
    await withMigratedDb((db) => {
      const parent = enqueueOwnedRevivalParent(db, 'mbid_unresolved');
      db.run(
        `INSERT INTO forward_deferred_love_witnesses(link_id,generation,operation_id,group_seq,kind,love_artist_key,
           love_track_key,authorization_uri,authorization_rev,created_at_ms) VALUES(?,1,?,1,?,?,?,?,?,?)`,
        'replacement-link',
        parent.childOperationId,
        mismatch === 'kind' ? 'love' : 'unlove',
        mismatch === 'keys' ? 'wrong-artist' : REVIVAL_ARTIST_KEY,
        REVIVAL_TRACK_KEY,
        REVIVAL_URI,
        mismatch === 'authorization' ? '3lbcdefghijkn' : REVIVAL_REV,
        NOW_MS,
      );
      expect(reviveOwnedParent(db).enqueued).toBe(0);
      expect(db.one("SELECT 1 FROM forward_outbox WHERE dedupe_key LIKE 'mb-match:%'")).toBeNull();
      expect(
        db.one(
          'SELECT kind,love_artist_key,authorization_rev FROM forward_deferred_love_witnesses WHERE operation_id=?',
          parent.childOperationId,
        ),
      ).toMatchObject({
        kind: mismatch === 'kind' ? 'love' : 'unlove',
        love_artist_key: mismatch === 'keys' ? 'wrong-artist' : REVIVAL_ARTIST_KEY,
        authorization_rev: mismatch === 'authorization' ? '3lbcdefghijkn' : REVIVAL_REV,
      });
    });
  });
}

it('does not downgrade an existing child witness when its parent witness is absent', async () => {
  await withMigratedDb((db) => {
    const parent = enqueueOwnedRevivalParent(db, 'mbid_unresolved');
    db.run('DELETE FROM forward_deferred_love_witnesses WHERE operation_id=?', parent.parentOperationId);
    db.run(
      `INSERT INTO forward_deferred_love_witnesses(link_id,generation,operation_id,group_seq,kind,love_artist_key,
         love_track_key,authorization_uri,authorization_rev,created_at_ms) VALUES(?,1,?,1,'unlove',?,?,?,?,?)`,
      'replacement-link',
      parent.childOperationId,
      REVIVAL_ARTIST_KEY,
      REVIVAL_TRACK_KEY,
      REVIVAL_URI,
      REVIVAL_REV,
      NOW_MS,
    );
    expect(reviveOwnedParent(db).enqueued).toBe(1);
    expect(
      db.one(
        'SELECT kind,group_seq,love_artist_key,love_track_key,authorization_uri,authorization_rev FROM forward_deferred_love_witnesses WHERE operation_id=?',
        parent.childOperationId,
      ),
    ).toEqual({
      kind: 'unlove',
      group_seq: 1,
      love_artist_key: REVIVAL_ARTIST_KEY,
      love_track_key: REVIVAL_TRACK_KEY,
      authorization_uri: REVIVAL_URI,
      authorization_rev: REVIVAL_REV,
    });
  });
});

it('rolls back the revived row, child witness, and current-target cache after a post-witness fault', async () => {
  await withMigratedDb((raw) => {
    const parent = enqueueOwnedRevivalParent(raw, 'mbid_unresolved');
    const db: Db = {
      all: raw.all.bind(raw),
      one: raw.one.bind(raw),
      run(sql, ...params) {
        const result = raw.run(sql, ...params);
        if (sql.includes('INSERT INTO mb_forward_love_current')) throw new Error('injected after revival cache update');
        return result;
      },
      tx: (fn) => raw.tx(fn),
    };
    expect(() => reviveOwnedParent(db)).toThrow('injected after revival cache update');
    expect(raw.one("SELECT count(*) AS n FROM forward_outbox WHERE dedupe_key LIKE 'mb-match:%'")).toEqual({ n: 0 });
    expect(
      raw.one(
        'SELECT count(*) AS n FROM forward_deferred_love_witnesses WHERE operation_id=?',
        parent.childOperationId,
      ),
    ).toEqual({ n: 0 });
    expect(raw.one('SELECT forward_rowid FROM mb_forward_love_current WHERE link_id=?', 'replacement-link')).toEqual(
      raw.one("SELECT rowid AS forward_rowid FROM forward_outbox WHERE dedupe_key='owned-revival-parent'"),
    );
    expect(
      raw.one(
        "SELECT retired_at_ms FROM forward_receipts WHERE link_id='replacement-link' AND kind='unlove' AND dedupe_key='owned-revival-parent'",
      ),
    ).toEqual({ retired_at_ms: null });
  });
});

for (const error of ['no_recording_mbid', 'mbid_unresolved'] as const) {
  it(`keeps genuine schema-55 legacy ${error} MBID revival under the original A2 contract`, async () => {
    await withMigratedDb(
      async (db) => {
        seedLink(db);
        db.run("UPDATE linked_accounts SET service='listenbrainz' WHERE id='replacement-link'");
        const now = NOW_MS;
        db.run(
          `INSERT INTO live_pending_removal_events(uri,rev,action,cid,conflicted,created_at_ms,expires_at_ms)
           VALUES(?,?,'delete','',0,?,?)`,
          REVIVAL_URI,
          REVIVAL_REV,
          now,
          now + DAY,
        );
        db.run(
          `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,last_error,
             created_at_ms,updated_at_ms,love_artist_key,love_track_key,authorization_uri,authorization_rev)
           VALUES('legacy-revival','replacement-link',1,?,'unlove','legacy-revival',?,'ignored',0,0,?,?,?, ?,?,?,?)`,
          ALICE,
          JSON.stringify({ artist: 'Revival Artist', track: 'Revival Track', origin: 'listenbrainz' }),
          error,
          now,
          now,
          REVIVAL_ARTIST_KEY,
          REVIVAL_TRACK_KEY,
          REVIVAL_URI,
          REVIVAL_REV,
        );
        const rowid = db.one<{ rowid: number }>("SELECT rowid FROM forward_outbox WHERE id='legacy-revival'")!.rowid;
        noteForwardLoveCurrent(db, 'replacement-link', REVIVAL_ARTIST_KEY, REVIVAL_TRACK_KEY, rowid);
        db.run(
          `INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms)
           VALUES('replacement-link',1,'unlove','legacy-revival',?)`,
          now,
        );
        expect(migrate(db).status).toBe('ready');
        expect(reviveOwnedParent(db).enqueued).toBe(1);
        expect(
          db.one("SELECT count(*) AS n FROM forward_deferred_love_witnesses WHERE operation_id LIKE 'mb-match:%'"),
        ).toEqual({
          n: 0,
        });
        expect((await forward(db)).feedbacks).toEqual([{ recordingMbid: REVIVAL_MBID, score: 0 }]);
      },
      { migrations: MIGRATIONS.slice(0, 55) },
    );
  });
}
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
