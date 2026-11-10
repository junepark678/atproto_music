import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { CredentialDeps } from '../../../src/credentials/accounts';
import { ensureAccount } from '../../../src/credentials/accounts';
import { createBox } from '../../../src/crypto/box';
import type { Db } from '../../../src/do/db';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { readLiveEvidence } from '../../../src/do/ingest/live-evidence';
import { executeAuthorizedRemovals, recordPendingRemoval } from '../../../src/do/ingest/live-pending-removals';
import { migrate } from '../../../src/do/migrate';
import { MIGRATIONS } from '../../../src/do/schema';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { runLinkBackfill } from '../../../src/forward/backfill';
import { expireRows, HELD_RETENTION_MS, holdLinkRows, settleRows } from '../../../src/forward/forward-outbox';
import { type ForwardRuntime, runForward } from '../../../src/forward/forwarder';
import { LastfmClient } from '../../../src/forward/lastfm-client';
import { patchLink, saveLink } from '../../../src/forward/links';
import { ListenbrainzClient } from '../../../src/forward/listenbrainz-client';
import { conflictDeferredLoveAuthority } from '../../../src/forward/love-coverage-authority';
import { remoteLoveState } from '../../../src/forward/love-delivery';
import { noteForwardLoveCurrent } from '../../../src/forward/love-lanes';
import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { enqueueRevivedLoves } from '../../../src/musicbrainz/revive-loves';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { cancelUnsent } from '../../../src/outbox/operations';
import {
  ALICE,
  authorizedLiveOptions,
  deleteProof,
  liveApplyOptions,
  NOW_MS,
  OPTS,
  putProof,
  repoFor,
  SCROBBLE,
  scrobble,
  seedUser,
} from '../../write/support';
import { testSecrets } from '../support/app';
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
async function forward(db: Db, now = NOW_MS) {
  const submissions: Array<{ type: string; payload: unknown }> = [];
  const feedbacks: Array<{ recordingMbid: string; score: number }> = [];
  const clock = { nowMs: () => now };
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
  const report = await runForward(runtime, now);
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

for (const source of ['lastfm', 'listenbrainz'] as const) {
  it(`enforces source exclusion at production enqueue and wire dispatch for ${source}`, async () => {
    await withMigratedDb(async (db) => {
      seedLink(db);
      const target = source === 'listenbrainz' ? 'excluded-target-lastfm' : 'excluded-target-listenbrainz';
      const targetService = source === 'listenbrainz' ? 'lastfm' : 'listenbrainz';
      if (source === 'lastfm') db.run("UPDATE linked_accounts SET service='lastfm' WHERE id='replacement-link'");
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
         VALUES(?,?,?,'target',X'00','fixture',?,?)`,
        target,
        ALICE,
        targetService,
        NOW_MS,
        NOW_MS,
      );
      const operationId = `source-excluded-${source}`;
      expect(
        enqueueForwards(db, {
          did: ALICE,
          excludeSourceService: source,
          items: [
            {
              kind: 'unlove',
              operationId,
              payload: {
                artist: 'Excluded Artist',
                track: 'Excluded Track',
                origin: source,
                recordingMbid: REVIVAL_MBID,
              },
            },
          ],
          now: NOW_MS,
          random: rng,
        }),
      ).toBe(1);
      expect(
        db.all<{ link_id: string }>(
          'SELECT link_id FROM forward_outbox WHERE dedupe_key=? ORDER BY link_id',
          operationId,
        ),
      ).toEqual([{ link_id: target }]);
      const sent = await forward(db);
      expect(sent.report.requests).toBe(1);
      expect(
        db.one<{ state: string }>(
          'SELECT state FROM forward_outbox WHERE link_id=? AND dedupe_key=?',
          target,
          operationId,
        ),
      ).toEqual({ state: 'sent' });
      expect(
        db.one<{ n: number }>(
          'SELECT count(*) AS n FROM forward_outbox WHERE link_id=? AND dedupe_key=?',
          'replacement-link',
          operationId,
        ),
      ).toEqual({ n: 0 });
    });
  });
}

it('keeps equal-millisecond love/unlove FIFO through settlement and uses the delivery ledger after row cleanup', async () => {
  await withMigratedDb(async (db) => {
    seedLink(db);
    const items = [
      {
        kind: 'love' as const,
        operationId: 'fifo-love-1',
        payload: { artist: 'FIFO Artist', track: 'FIFO Track', recordingMbid: REVIVAL_MBID },
      },
      {
        kind: 'unlove' as const,
        operationId: 'fifo-unlove',
        payload: { artist: 'FIFO Artist', track: 'FIFO Track', recordingMbid: REVIVAL_MBID },
      },
      {
        kind: 'love' as const,
        operationId: 'fifo-love-2',
        payload: { artist: 'FIFO Artist', track: 'FIFO Track', recordingMbid: REVIVAL_MBID },
      },
    ];
    expect(enqueueForwards(db, { did: ALICE, items, now: NOW_MS, random: rng })).toBe(3);
    const feedback: number[] = [];
    for (let attempt = 0; attempt < 4 && feedback.length < items.length; attempt++)
      feedback.push(...(await forward(db)).feedbacks.map((row) => row.score));
    expect(feedback).toEqual([1, 0, 1]);
    const [fifoArtist, fifoTrack] = trackKey('FIFO Artist', 'FIFO Track');
    expect(remoteLoveState(db, { id: 'replacement-link', generation: 1 }, fifoArtist, fifoTrack)).toBe('love');
    expect(
      db.one(
        'SELECT last_sent_kind,last_sent_dedupe_key FROM forward_love_delivery WHERE link_id=? AND love_artist_key=? AND love_track_key=?',
        'replacement-link',
        fifoArtist,
        fifoTrack,
      ),
    ).toEqual({ last_sent_kind: 'love', last_sent_dedupe_key: 'fifo-love-2' });
    db.run("DELETE FROM forward_outbox WHERE link_id='replacement-link' AND kind IN ('love','unlove')");
    expect(remoteLoveState(db, { id: 'replacement-link', generation: 1 }, fifoArtist, fifoTrack)).toBe('love');
  });
});

it('resumes a held love through same-remote relink and sends it exactly once', async () => {
  await withMigratedDb(async (db) => {
    seedLink(db);
    const operationId = 'held-resumed-love';
    expect(
      enqueueForwards(db, {
        did: ALICE,
        items: [
          {
            kind: 'love',
            operationId,
            payload: { artist: 'Held Artist', track: 'Held Track', recordingMbid: REVIVAL_MBID },
          },
        ],
        now: NOW_MS,
        random: rng,
      }),
    ).toBe(1);
    const row = db.one<{ id: string }>('SELECT id FROM forward_outbox WHERE dedupe_key=?', operationId)!;
    expect(holdLinkRows(db, 'replacement-link', NOW_MS, 1)).toBe(1);
    const relinked = saveLink(
      {
        db,
        clock: { nowMs: () => NOW_MS },
        random: rng,
        box: createBox(testSecrets().encryptionKeys, rng),
      },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice', credential: 'replacement-token' },
    );
    expect(relinked).toMatchObject({ created: false, resumed: 1, link: { generation: 1 } });
    expect(db.one('SELECT state FROM forward_outbox WHERE id=?', row.id)).toEqual({ state: 'queued' });
    expect((await forward(db)).feedbacks).toEqual([{ recordingMbid: REVIVAL_MBID, score: 1 }]);
    expect((await forward(db)).feedbacks).toEqual([]);
  });
});

it('expires a held row without transport and retains its local receipt', async () => {
  await withMigratedDb(async (db) => {
    seedLink(db);
    const operationId = 'held-expired-unlove';
    enqueueForwards(db, {
      did: ALICE,
      items: [
        {
          kind: 'unlove',
          operationId,
          payload: { artist: 'Expired Artist', track: 'Expired Track', recordingMbid: REVIVAL_MBID },
        },
      ],
      now: NOW_MS,
      random: rng,
    });
    const row = db.one<{ id: string }>('SELECT id FROM forward_outbox WHERE dedupe_key=?', operationId)!;
    expect(holdLinkRows(db, 'replacement-link', NOW_MS, 1)).toBe(1);
    db.run('UPDATE forward_outbox SET updated_at_ms=? WHERE id=?', NOW_MS - HELD_RETENTION_MS - 1, row.id);
    expect(expireRows(db, NOW_MS).held).toBe(1);
    expect(db.one('SELECT state,last_error FROM forward_outbox WHERE id=?', row.id)).toEqual({
      state: 'expired',
      last_error: 'held_expired',
    });
    expect(
      db.one(
        "SELECT retired_at_ms FROM forward_receipts WHERE link_id='replacement-link' AND kind='unlove' AND dedupe_key=?",
        operationId,
      ),
    ).toEqual({ retired_at_ms: null });
    expect((await forward(db)).feedbacks).toEqual([]);
  });
});

it('does not settle or dispatch a stale-generation row after a real remote rotation', async () => {
  await withMigratedDb(async (db) => {
    seedLink(db);
    const operationId = 'stale-generation-love';
    enqueueForwards(db, {
      did: ALICE,
      items: [
        {
          kind: 'love',
          operationId,
          payload: { artist: 'Stale Artist', track: 'Stale Track', recordingMbid: REVIVAL_MBID },
        },
      ],
      now: NOW_MS,
      random: rng,
    });
    const row = db.one<{ id: string; generation: number }>(
      'SELECT id,generation FROM forward_outbox WHERE dedupe_key=?',
      operationId,
    )!;
    const rotated = saveLink(
      {
        db,
        clock: { nowMs: () => NOW_MS },
        random: seededRandom(889),
        box: createBox(testSecrets().encryptionKeys, rng),
      },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice-v2', credential: 'replacement-token' },
    );
    expect(rotated.link.generation).toBe(2);
    settleRows(db, [row.id], 'sent', NOW_MS + 1, null, true, row.generation);
    expect(db.one('SELECT state FROM forward_outbox WHERE id=?', row.id)).toEqual({ state: 'expired' });
    expect((await forward(db)).feedbacks).toEqual([]);
    expect(db.one('SELECT count(*) AS n FROM forward_love_delivery')).toEqual({ n: 0 });
  });
});

for (const service of ['listenbrainz', 'lastfm'] as const) {
  for (const priorState of ['queued', 'held', 'sent', 'failed', 'expired', 'ignored', 'cancelled'] as const) {
    it(`runs deferred coverage from a real ${service} link with prior love ${priorState}`, async () => {
      await withMigratedDb(async (db) => {
        seedLink(db);
        db.run('UPDATE linked_accounts SET service=? WHERE id=?', service, 'replacement-link');
        const payload = { artist: 'Prior State Artist', track: 'Prior State Track', recordingMbid: REVIVAL_MBID };
        if (priorState === 'cancelled')
          db.run(
            `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,record_json,digest,state,due_at,
               created_at_ms,updated_at_ms,send_state)
             VALUES('prior-love-operation',?,'love.put','web',0,'com.example.atmusic.love','prior-love',?,?,'queued',?,?,?,'unsent')`,
            ALICE,
            JSON.stringify(payload),
            'prior-love-digest',
            NOW_MS,
            NOW_MS,
            NOW_MS,
          );
        enqueueForwards(db, {
          did: ALICE,
          items: [{ kind: 'love', operationId: 'prior-love-operation', payload }],
          now: NOW_MS,
          random: rng,
        });
        const loveRow = db.one<{ id: string }>(
          "SELECT id FROM forward_outbox WHERE link_id='replacement-link' AND kind='love'",
        )!;
        if (priorState === 'held') expect(holdLinkRows(db, 'replacement-link', NOW_MS, 1)).toBe(1);
        else if (
          priorState === 'sent' ||
          priorState === 'failed' ||
          priorState === 'expired' ||
          priorState === 'ignored'
        )
          settleRows(
            db,
            [loveRow.id],
            priorState,
            NOW_MS + 1,
            priorState === 'ignored' ? 'fixture_ignored' : 'fixture',
          );
        else if (priorState === 'cancelled') expect(cancelUnsent(db, 'prior-love-operation', NOW_MS + 1)).toBe(true);

        const [priorArtistKey, priorTrackKey] = trackKey(payload.artist, payload.track);
        expect(remoteLoveState(db, { id: 'replacement-link', generation: 1 }, priorArtistKey, priorTrackKey)).toBe(
          priorState === 'queued' || priorState === 'held' || priorState === 'sent' ? 'love' : 'none',
        );

        patchLink({ db, clock: { nowMs: () => NOW_MS + 2 } }, ALICE, 'replacement-link', {
          forwardScrobbles: false,
        });
        db.run(
          `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,record_json,digest,state,due_at,
             created_at_ms,updated_at_ms,send_state)
           VALUES('deferred-unlove-operation',?,'love.delete','web',0,'com.example.atmusic.love','remove-prior-love',?,?,'queued',?,?,?,'unsent')`,
          ALICE,
          JSON.stringify(payload),
          'deferred-unlove-digest',
          NOW_MS + 3,
          NOW_MS + 3,
          NOW_MS + 3,
        );
        enqueueForwards(db, {
          did: ALICE,
          items: [{ kind: 'unlove', operationId: 'deferred-unlove-operation', payload }],
          now: NOW_MS + 3,
          random: rng,
        });
        if (priorState === 'held') {
          const resumed = saveLink(
            {
              db,
              clock: { nowMs: () => NOW_MS + 4 },
              random: rng,
              box: createBox(testSecrets().encryptionKeys, rng),
            },
            { did: ALICE, service, remoteUser: 'alice', credential: 'same-remote-credential' },
          );
          expect(resumed.resumed).toBe(1);
        }
        patchLink({ db, clock: { nowMs: () => NOW_MS + 5 } }, ALICE, 'replacement-link', {
          forwardScrobbles: true,
        });
        db.run("UPDATE users SET indexing_state='current' WHERE did=?", ALICE);
        for (let turn = 0; turn < 8; turn++) await runLinkBackfill(db, rng, NOW_MS + 10 + turn);
        const unloveQueued = db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove' AND state='queued'") !== null;
        expect(unloveQueued).toBe(priorState === 'queued' || priorState === 'held' || priorState === 'sent');
        if (unloveQueued) {
          for (let turn = 0; turn < 8; turn++) {
            await forward(db, NOW_MS + 1_000 + turn * 1_000);
            if (db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove' AND state='sent'") !== null) break;
          }
          expect(db.one("SELECT state FROM forward_outbox WHERE kind='unlove'")).toEqual({ state: 'sent' });
        } else {
          expect(db.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove'")).toEqual({ n: 0 });
        }
      });
    });
  }
}

it('lets a verified surviving love projection veto deferred unlove, then sends one after verified removal', async () => {
  const repo = await repoFor('alice');
  const collection = 'com.example.atmusic.love';
  const rkey = 'survivor-wire-control';
  const makeRecord = (track: string, createdAt: string) => ({
    $type: collection,
    artist: 'Survivor Artist',
    track,
    recordingMbid: REVIVAL_MBID,
    createdAt,
  });
  const initial = await putProof(repo, collection, rkey, makeRecord('Survivor Track', '2026-01-15T11:00:00Z'));

  await withMigratedDb(async (db) => {
    seedLink(db);
    const uri = `at://${ALICE}/${collection}/${rkey}`;
    const applyVerified = (
      proof: Awaited<ReturnType<typeof putProof | typeof deleteProof>>,
      action: 'create' | 'update' | 'delete',
      now: number,
    ) => {
      enqueueHints(db, [
        {
          did: ALICE,
          collection,
          rkey,
          source: 'jetstream',
          hintRev: proof.commit.rev,
          live: proof.state === 'absent' ? { operation: 'delete' as const } : { operation: action, cid: proof.cid },
          receiptMs: now,
        },
      ]);
      db.tx(() =>
        applyRecordProof(db, proof, {
          ...liveApplyOptions(proof, rng, action),
          live: { random: rng, evidence: readLiveEvidence(db, uri, now), legacyRev: null },
        }),
      );
    };
    applyVerified(initial, 'create', NOW_MS);
    expect((await forward(db)).feedbacks).toEqual([{ recordingMbid: REVIVAL_MBID, score: 1 }]);

    patchLink({ db, clock: { nowMs: () => NOW_MS + 1 } }, ALICE, 'replacement-link', { forwardScrobbles: false });
    const firstDelete = await deleteProof(repo, collection, rkey);
    applyVerified(firstDelete, 'delete', NOW_MS + 2);
    expect(db.one("SELECT count(*) AS n FROM forward_deferred_love_intents WHERE kind='unlove'")).toEqual({ n: 1 });

    const survivor = await putProof(repo, collection, rkey, makeRecord('Survivor Track', '2026-01-15T11:01:00Z'));
    applyVerified(survivor, 'create', NOW_MS + 3);
    expect(db.one('SELECT count(*) AS n FROM loves WHERE did=?', ALICE)).toEqual({ n: 1 });

    patchLink({ db, clock: { nowMs: () => NOW_MS + 2 } }, ALICE, 'replacement-link', { forwardScrobbles: true });
    db.run("UPDATE users SET indexing_state='current' WHERE did=?", ALICE);
    for (let turn = 0; turn < 8; turn++) await runLinkBackfill(db, rng, NOW_MS + 3 + turn);
    expect(db.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove'")).toEqual({ n: 0 });
    expect((await forward(db)).feedbacks).not.toContainEqual({ recordingMbid: REVIVAL_MBID, score: 0 });
    const [survivorArtistKey, survivorTrackKey] = trackKey('Survivor Artist', 'Survivor Track');
    expect(remoteLoveState(db, { id: 'replacement-link', generation: 1 }, survivorArtistKey, survivorTrackKey)).toBe(
      'love',
    );

    patchLink({ db, clock: { nowMs: () => NOW_MS + 20 } }, ALICE, 'replacement-link', { forwardScrobbles: false });
    const finalDelete = await deleteProof(repo, collection, rkey);
    applyVerified(finalDelete, 'delete', NOW_MS + 21);
    expect(db.one('SELECT count(*) AS n FROM loves WHERE did=?', ALICE)).toEqual({ n: 0 });
    patchLink({ db, clock: { nowMs: () => NOW_MS + 21 } }, ALICE, 'replacement-link', { forwardScrobbles: true });
    for (let turn = 0; turn < 8; turn++) await runLinkBackfill(db, rng, NOW_MS + 22 + turn);
    const removedFeedbacks: Array<{ recordingMbid: string; score: number }> = [];
    for (let turn = 0; turn < 8; turn++) {
      removedFeedbacks.push(...(await forward(db, NOW_MS + 1_000 + turn * 1_000)).feedbacks);
      if (db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove' AND state='sent'") !== null) break;
    }
    expect(
      removedFeedbacks,
      JSON.stringify({
        outbox: db.all(
          "SELECT kind,state,last_error,due_at,dedupe_key FROM forward_outbox WHERE kind IN ('love','unlove')",
        ),
        intents: db.all(
          'SELECT kind,operation_id,intent_seq,authorization_uri,authorization_rev FROM forward_deferred_love_intents',
        ),
        heads: db.all('SELECT head_seq,next_seq,live_from_seq,armed_seq,decided_seq FROM forward_deferred_love_heads'),
        link: db.one(
          "SELECT forward_scrobbles,backfill_state,backfill_discovery_done FROM linked_accounts WHERE id='replacement-link'",
        ),
        counters: db.all("SELECT label,value FROM counters WHERE name='link_coverage' ORDER BY label"),
      }),
    ).toContainEqual({ recordingMbid: REVIVAL_MBID, score: 0 });
    expect(db.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove' AND state='sent'")).toEqual({ n: 1 });
  });
});

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
