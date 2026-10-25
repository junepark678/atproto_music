// N3-06: POST /1/feedback/recording-feedback and GET
// /1/feedback/user/{user}/get-feedback (ADR 0005 §8.6).
//
// The whole composition runs in-process (support/app.ts) with the /1/ router
// mounted. Alice's fixture records are applied through the production
// verifier and apply path; she is the account `alice` and holds a real
// ListenBrainz token (credentials/lb-tokens.ts). Feedback writes are observed
// as the `operations` rows the server outbox persists (N2-05); the love
// projection itself (N3-11) is not this package's, so get-feedback reads
// `loves` rows seeded directly with the production music keys. Frozen clock
// 2026-01-15T12:00:00Z; no network (the outbox never runs here).

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { recordingMsid } from '@atmusic/core/msid';
import { artistKey, trackKey } from '@atmusic/core/music-key';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import { MemoryRevocations } from '../../../src/app/revocations';
import type { OperationRow } from '../../../src/app/rows';
import { ensureAccount, renameAccount } from '../../../src/credentials/accounts';
import { createLbToken } from '../../../src/credentials/lb-tokens';
import type { Db } from '../../../src/do/db';
import { upsertNowPlaying } from '../../../src/do/read/now-playing';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { FEEDBACK_MESSAGES } from '../../../src/listenbrainz/feedback';
import { listenBrainzRoutes } from '../../../src/listenbrainz/routes';
import { acceptListens } from '../../../src/outbox/ingress';
import { closeApps, startApp, type TestApp } from '../support/app';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
const LOVE = `${PREFIX}.love`;
const ALICE = fixture.users.Alice.did;
const BOB = fixture.users.Bob.did;
const NOW_ISO = '2026-01-15T12:00:00Z';
const NOW_NS = fromMs(Date.parse(NOW_ISO));
const OPTS = { receiptNs: NOW_NS, prefix: PREFIX, nowNs: NOW_NS };
const unix = (iso: string) => Date.parse(iso) / 1000;

function seedUser(db: Db, did: string, handle: string): void {
  db.run(
    `INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, ?, 1, 'active', 'current', 1)`,
    did,
    handle,
    toStorage(NOW_NS),
  );
}

async function apply(db: Db, repo: SignedRepo, collection: string, rkey: string): Promise<void> {
  const car = await repo.getRecordCar(collection, rkey);
  const proof = await verifyRecordProof(car, { did: repo.did, collection, rkey, signingKey: repo.key.didKey });
  const outcome = db.tx(() => applyRecordProof(db, proof, OPTS)).outcome;
  expect(outcome).toBe(proof.state === 'present' ? 'applied' : 'absent');
}

interface Rig {
  app: TestApp;
  token: string;
  post(body: unknown, auth?: string | null): Promise<Response>;
  ops(): OperationRow[];
  /** How often the outbox was kicked. */
  kicks(): number;
}

async function started(): Promise<Rig> {
  let kicks = 0;
  const app = await startApp({ routes: listenBrainzRoutes({ kick: () => kicks++ }) });
  const db = app.db;
  seedUser(db, ALICE, fixture.users.Alice.handle);
  seedUser(db, BOB, fixture.users.Bob.handle);
  const keys = await fixtureKeys();
  const alice = new SignedRepo(ALICE, keys.alice, { clock: fixedClock() });
  const repos = new Map([
    [ALICE, alice],
    [BOB, new SignedRepo(BOB, keys.bob, { clock: fixedClock() })],
  ]);
  for (const s of fixture.scrobbles) {
    const repo = repos.get(s.owner);
    if (repo === undefined) continue;
    await repo.put(SCROBBLE, s.rkey, { ...s.record });
    await apply(db, repo, SCROBBLE, s.rkey);
  }
  await alice.delete(SCROBBLE, 'r08');
  await apply(db, alice, SCROBBLE, 'r08');
  const deps = { db, clock: app.clock, random: seededRandom(7), revocations: new MemoryRevocations(app.clock) };
  ensureAccount(deps, { did: ALICE, verifiedHandle: fixture.users.Alice.handle });
  expect(renameAccount(deps, { did: ALICE, username: 'alice' })).toMatchObject({ ok: true });
  const { token } = createLbToken(deps, { did: ALICE, label: 'test' });
  const rig: Rig = {
    app,
    token,
    post: (body, auth = `Token ${token}`) =>
      app.fetch('/1/feedback/recording-feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: auth }) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    ops: () => db.all<OperationRow>("SELECT * FROM operations WHERE kind LIKE 'love.%' ORDER BY rowid"),
    kicks: () => kicks,
  };
  return rig;
}

async function ok(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  expect(res.headers.get('x-ratelimit-limit')).toBe('100');
  expect(await res.json()).toEqual({ status: 'ok' });
}

const intent = (op: OperationRow) => {
  const { createdAt: _c, ...rest } = JSON.parse(op.record_json!) as Record<string, unknown>;
  return rest;
};

function seedLove(db: Db, rkey: string, artist: string, track: string, createdAt: string, mbid: string | null = null) {
  db.run(
    `INSERT INTO loves(uri, did, rkey, cid, artist, track, album, artist_key, track_key, recording_mbid, created_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    `at://${ALICE}/${LOVE}/${rkey}`,
    ALICE,
    rkey,
    `bafyrei${rkey}`,
    artist,
    track,
    artistKey(artist),
    trackKey(artist, track)[1],
    mbid,
    toStorage(fromMs(Date.parse(createdAt))),
    toStorage(NOW_NS),
  );
}

afterEach(closeApps);

describe('ListenBrainz feedback (ADR §8.6)', () => {
  it('score 1 queues a love, 0 an unlove, -1 clears the love; get-feedback lists loves with count, offset and total_count', async () => {
    const rig = await started();
    const { app } = rig;
    const joga = await recordingMsid('Björk', 'Jóga');

    // score 1: a love.put of the newest indexed listen of that MSID (r01's spelling and album).
    await ok(await rig.post({ recording_msid: joga, score: 1 }));
    // score 0: an unlove; score -1 ("hate"): an unlove too (no hate state).
    await ok(await rig.post({ recording_msid: joga.toUpperCase(), score: 0 }));
    await ok(await rig.post({ recording_msid: joga, score: -1 }));
    const ops = rig.ops();
    expect(ops.map((o) => [o.kind, o.origin, o.state, o.did, o.collection])).toEqual([
      ['love.put', 'listenbrainz', 'queued', ALICE, LOVE],
      ['love.delete', 'listenbrainz', 'queued', ALICE, LOVE],
      ['love.delete', 'listenbrainz', 'queued', ALICE, LOVE],
    ]);
    expect(intent(ops[0]!)).toEqual({ $type: LOVE, artist: 'Björk', track: 'Jóga', album: 'Homogenic' });
    expect(intent(ops[1]!)).toEqual({ artist: 'Björk', track: 'Jóga' });
    expect(intent(ops[2]!)).toEqual({ artist: 'Björk', track: 'Jóga' });
    // Love intents of one key run FIFO behind their predecessors.
    expect(app.db.all('SELECT op_id, pred_id FROM operation_deps ORDER BY rowid')).toEqual([
      { op_id: ops[1]!.id, pred_id: ops[0]!.id },
      { op_id: ops[2]!.id, pred_id: ops[0]!.id },
      { op_id: ops[2]!.id, pred_id: ops[1]!.id },
    ]);
    expect(rig.kicks()).toBe(3);

    // The stored MSID column (the N3-11 projection) and a recording MBID resolve too.
    app.db.run(
      "UPDATE scrobbles SET recording_msid = ? WHERE rkey = 'r03'",
      await recordingMsid('Radiohead', 'Weird Fishes'),
    );
    await ok(await rig.post({ recording_msid: await recordingMsid('Radiohead', 'Weird Fishes'), score: 1 }));
    const mbid = '6b9a509f-6907-4a6e-9345-2f12da09ba4b';
    app.db.run("UPDATE scrobbles SET recording_mbid = ? WHERE rkey = 'r04'", mbid);
    await ok(await rig.post({ recording_mbid: mbid.toUpperCase(), score: 1 }));
    const later = rig.ops().slice(3);
    expect(later.map(intent)).toEqual([
      { $type: LOVE, artist: 'Radiohead', track: 'Weird Fishes', album: 'In Rainbows' },
      { $type: LOVE, artist: 'Radiohead', track: 'Karma Police', album: 'OK Computer', recordingMbid: mbid },
    ]);

    // ListenBrainz's validation, verbatim where it has a text; nothing is stored.
    const before = rig.ops().length;
    for (const [body, error] of [
      [{ recording_msid: joga }, FEEDBACK_MESSAGES.missingKeys],
      [{ score: 1 }, FEEDBACK_MESSAGES.missingKeys],
      [{ recording_msid: joga, score: 1, extra: true }, FEEDBACK_MESSAGES.extraKeys],
      ['{not json', 'Invalid JSON document submitted.'],
    ] as const) {
      const res = await rig.post(body);
      expect([res.status, await res.json()]).toEqual([400, { code: 400, error }]);
    }
    for (const body of [
      { recording_msid: joga, score: 2 },
      { recording_msid: 'not-a-uuid', score: 1 },
      { recording_msid: null, score: 1 },
    ]) {
      const res = await rig.post(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/^Invalid JSON document submitted: /);
    }
    // The token is required: the 401s are ListenBrainz's.
    for (const [auth, error] of [
      [null, 'You need to provide an Authorization header.'],
      ['Token', 'Provided Authorization header is invalid.'],
      ['Token 0b4f5c1e-8a1d-4c6e-9f10-2a7c3b9d0e45', 'Invalid authorization token.'],
    ] as const) {
      const res = await rig.post({ recording_msid: joga, score: 1 }, auth);
      expect([res.status, await res.json()]).toEqual([401, { code: 401, error }]);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
    // Pano's lowercase scheme and Bearer are accepted.
    await ok(await rig.post({ recording_msid: joga, score: 1 }, `token ${rig.token}`));
    await ok(await rig.post({ recording_msid: joga, score: 1 }, `Bearer ${rig.token}`));
    expect(rig.ops().length).toBe(before + 2);

    // get-feedback: the user's loves, newest first.
    seedLove(app.db, '3laaaaaaaaaa1', 'Björk', 'Jóga', '2026-01-10T09:00:00Z');
    seedLove(app.db, '3laaaaaaaaaa2', 'Radiohead', 'Reckoner', '2026-01-12T09:00:00Z', mbid);
    seedLove(app.db, '3laaaaaaaaaa3', 'Kate Bush', 'Cloudbusting', '2026-01-14T09:00:00Z');
    const list = await app.fetch('/1/feedback/user/alice/get-feedback');
    expect(list.status).toBe(200);
    expect(list.headers.get('access-control-allow-origin')).toBe('*');
    expect(await list.json()).toEqual({
      feedback: [
        {
          user_id: 'alice',
          recording_msid: await recordingMsid('Kate Bush', 'Cloudbusting'),
          recording_mbid: null,
          score: 1,
          created: unix('2026-01-14T09:00:00Z'),
        },
        {
          user_id: 'alice',
          recording_msid: await recordingMsid('Radiohead', 'Reckoner'),
          recording_mbid: mbid,
          score: 1,
          created: unix('2026-01-12T09:00:00Z'),
        },
        {
          user_id: 'alice',
          recording_msid: joga,
          recording_mbid: null,
          score: 1,
          created: unix('2026-01-10T09:00:00Z'),
        },
      ],
      count: 3,
      total_count: 3,
      offset: 0,
    });
    const page = (await (
      await app.fetch('/1/feedback/user/alice/get-feedback?count=1&offset=1&metadata=true&score=1')
    ).json()) as Record<string, unknown>;
    expect(page).toEqual({
      feedback: [
        {
          user_id: 'alice',
          recording_msid: await recordingMsid('Radiohead', 'Reckoner'),
          recording_mbid: mbid,
          score: 1,
          created: unix('2026-01-12T09:00:00Z'),
          track_metadata: { artist_name: 'Radiohead', track_name: 'Reckoner' },
        },
      ],
      count: 1,
      total_count: 3,
      offset: 1,
    });
    expect(await (await app.fetch('/1/feedback/user/alice/get-feedback?offset=5')).json()).toEqual({
      feedback: [],
      count: 0,
      total_count: 3,
      offset: 5,
    });
    expect(await (await app.fetch('/1/feedback/user/alice/get-feedback?score=-1')).json()).toEqual({
      feedback: [],
      count: 0,
      total_count: 0,
      offset: 0,
    });
    const bad = await app.fetch('/1/feedback/user/alice/get-feedback?score=5');
    expect([bad.status, await bad.json()]).toEqual([400, { code: 400, error: FEEDBACK_MESSAGES.badScoreFilter }]);
    const unknown = await app.fetch('/1/feedback/user/x/get-feedback');
    expect([unknown.status, await unknown.json()]).toEqual([404, { code: 404, error: 'Cannot find user: x' }]);
  });

  it('an MSID of the current now-playing track or of a not-yet-indexed scrobble resolves to a love; an MSID with no candidate answers 200 ok and stores nothing', async () => {
    const rig = await started();
    const { app } = rig;
    const deps = app.composed.core.deps;

    // Now playing (not a record, not indexed): the love takes its names and album.
    upsertNowPlaying(deps, {
      did: ALICE,
      artist: 'Portishead',
      track: 'Glory Box',
      album: 'Dummy',
      source: 'listenbrainz',
    });
    await ok(await rig.post({ recording_msid: await recordingMsid('portishead', 'GLORY BOX'), score: 1 }));

    // A listen accepted moments ago: only a queued scrobble.create operation exists.
    const accepted = await acceptListens(deps, {
      did: ALICE,
      origin: 'listenbrainz',
      listens: [
        { input: { artist: 'Massive Attack', track: 'Angel', album: 'Mezzanine', listenedAt: '2026-01-15T11:55:00Z' } },
      ],
      receiptMs: app.clock.nowMs(),
    });
    expect(accepted.created).toBe(1);
    expect(app.db.one('SELECT count(*) AS n FROM scrobbles WHERE track = ?', 'Angel')).toEqual({ n: 0 });
    await ok(await rig.post({ recording_msid: await recordingMsid('Massive Attack', 'Angel'), score: 1 }));

    expect(rig.ops().map((o) => [o.kind, o.origin, intent(o)])).toEqual([
      ['love.put', 'listenbrainz', { $type: LOVE, artist: 'Portishead', track: 'Glory Box', album: 'Dummy' }],
      ['love.put', 'listenbrainz', { $type: LOVE, artist: 'Massive Attack', track: 'Angel', album: 'Mezzanine' }],
    ]);

    // No candidate: 200 ok, nothing stored.
    const snapshot = () => ({
      operations: app.db.one<{ n: number }>('SELECT count(*) AS n FROM operations')!.n,
      deps: app.db.one<{ n: number }>('SELECT count(*) AS n FROM operation_deps')!.n,
      forwards: app.db.one<{ n: number }>('SELECT count(*) AS n FROM forward_outbox')!.n,
    });
    const before = snapshot();
    expect(before.operations).toBe(3);
    await ok(await rig.post({ recording_msid: '0b4f5c1e-8a1d-4c6e-9f10-2a7c3b9d0e45', score: 1 }));
    await ok(await rig.post({ recording_mbid: '0b4f5c1e-8a1d-4c6e-9f10-2a7c3b9d0e45', score: 0 }));
    // Neither another user's track (Bob's indexed r09), nor a failed create, nor an expired now playing
    // is a candidate.
    const roads = await acceptListens(deps, {
      did: ALICE,
      origin: 'listenbrainz',
      listens: [{ input: { artist: 'Portishead', track: 'Roads', listenedAt: '2026-01-15T11:56:00Z' } }],
      receiptMs: app.clock.nowMs(),
    });
    const roadsOp = roads.results[0]!;
    expect(roadsOp.status).toBe('accepted');
    app.db.run("UPDATE operations SET state = 'failed' WHERE id = ?", (roadsOp as { operationId: string }).operationId);
    await ok(await rig.post({ recording_msid: await recordingMsid('Portishead', 'Roads'), score: 1 }));
    app.db.run('UPDATE now_playing SET expires_at_ms = ? WHERE did = ?', app.clock.nowMs(), ALICE);
    await ok(await rig.post({ recording_msid: await recordingMsid('Portishead', 'Glory Box'), score: 0 }));
    await ok(await rig.post({ recording_msid: await recordingMsid('Massive Attack', 'Teardrop'), score: 1 }));
    expect(snapshot()).toEqual({ ...before, operations: before.operations + 1 });
    expect(rig.ops()).toHaveLength(2);
  });
});
