// N3-06: GET /1/user/{user}/listens, playing-now and listen-count (ADR 0005
// §8.4, §9).
//
// The whole composition runs in-process (support/app.ts, 127.0.0.1:0) with
// the /1/ router mounted. Alice's and Bob's fixture records
// (tests/fixtures/read_models.json) are published into real signed
// repositories and applied through the production verifier and apply path
// into the app's database; r08 is created and deleted. Carol's 1,005 listens
// (only there to observe the count default and cap) are inserted directly.
// Alice signs in as `alice` (an account renamed to the dotless username),
// Bob and Carol never sign in and are addressed by their verified handles.
// Frozen clock 2026-01-15T12:00:00Z; no network.
//
//   r07 2026-01-15T11:00:00Z  r01 2026-01-15T11:00:00Z  r02 2026-01-14T11:00:00Z
//   r03 2026-01-08T12:00:00Z  r04 2025-12-16T12:00:00Z  r05 2025-01-15T12:00:00Z
//   r06 2025-01-14T11:00:00Z

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { recordingMsid } from '@atmusic/core/msid';
import { artistKey, trackKey } from '@atmusic/core/music-key';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import { ensureAccount, renameAccount } from '../../../src/credentials/accounts';
import type { Db } from '../../../src/do/db';
import { upsertNowPlaying } from '../../../src/do/read/now-playing';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { listenBrainzRoutes } from '../../../src/listenbrainz/routes';
import { closeApps, startApp, type TestApp } from '../support/app';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
const ALICE = fixture.users.Alice.did;
const BOB = fixture.users.Bob.did;
const CAROL = fixture.users.Carol.did;
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

async function seedFixture(app: TestApp): Promise<void> {
  const db = app.db;
  seedUser(db, ALICE, fixture.users.Alice.handle);
  seedUser(db, BOB, fixture.users.Bob.handle);
  seedUser(db, CAROL, fixture.users.Carol.handle);
  const keys = await fixtureKeys();
  const repos = new Map([
    [ALICE, new SignedRepo(ALICE, keys.alice, { clock: fixedClock() })],
    [BOB, new SignedRepo(BOB, keys.bob, { clock: fixedClock() })],
  ]);
  for (const s of fixture.scrobbles) {
    const repo = repos.get(s.owner);
    if (repo === undefined) continue;
    await repo.put(SCROBBLE, s.rkey, { ...s.record });
    await apply(db, repo, SCROBBLE, s.rkey);
  }
  const alice = repos.get(ALICE)!;
  await alice.delete(SCROBBLE, 'r08');
  await apply(db, alice, SCROBBLE, 'r08');

  const deps = { db, clock: app.clock };
  ensureAccount(deps, { did: ALICE, verifiedHandle: fixture.users.Alice.handle });
  expect(renameAccount(deps, { did: ALICE, username: 'alice' })).toMatchObject({ ok: true });

  // Carol: 1,005 listens, one per minute before now (direct rows; only the count is observed).
  db.tx(() => {
    for (let i = 1; i <= 1005; i++) {
      const at = toStorage(fromMs(Date.parse(NOW_ISO) - i * 60_000));
      const track = `Track ${i}`;
      db.run(
        `INSERT INTO scrobbles(uri, cid, did, rkey, revision, artist, track, album, listened_at, created_at,
           duration_seconds, recording_mbid, indexed_at, artist_key, track_key, album_key)
         VALUES (?, ?, ?, ?, '3laaaaaaaaaaa', 'Portishead', ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
        `at://${CAROL}/${SCROBBLE}/c${i}`,
        `bafyreic${i}`,
        CAROL,
        `c${i}`,
        track,
        at,
        at,
        toStorage(NOW_NS),
        artistKey('Portishead'),
        trackKey('Portishead', track)[1],
      );
    }
  });
}

async function started(): Promise<TestApp> {
  const app = await startApp({ routes: listenBrainzRoutes() });
  await seedFixture(app);
  return app;
}

interface Listen {
  listened_at: number;
  inserted_at: number;
  recording_msid: string;
  user_name: string;
  track_metadata: {
    artist_name: string;
    track_name: string;
    release_name?: string;
    additional_info: Record<string, unknown>;
  };
}
interface ListensBody {
  payload: {
    count: number;
    listens: Listen[];
    latest_listen_ts: number;
    oldest_listen_ts: number;
    user_id: string;
  };
}

async function listens(app: TestApp, path: string): Promise<ListensBody> {
  const res = await app.fetch(path);
  expect(res.status).toBe(200);
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  expect(res.headers.get('content-type')).toBe('application/json');
  return (await res.json()) as ListensBody;
}

const tracks = (b: ListensBody) => b.payload.listens.map((l) => l.track_metadata.track_name);

afterEach(closeApps);

describe('ListenBrainz reads (ADR §8.4)', () => {
  it('/1/user/alice/listens defaults to count 25, caps at 1000, applies exclusive min_ts/max_ts, reports latest/oldest_listen_ts, and echoes user_id as typed', async () => {
    const app = await started();

    // Alice's whole history, newest first ((listened_at, uri) DESC: r07 before r01).
    const all = await listens(app, '/1/user/alice/listens');
    expect(Object.keys(all.payload).sort()).toEqual([
      'count',
      'latest_listen_ts',
      'listens',
      'oldest_listen_ts',
      'user_id',
    ]);
    expect(all.payload.user_id).toBe('alice');
    expect(all.payload.count).toBe(7);
    expect(tracks(all)).toEqual([
      'No Surprises',
      'Jóga',
      'jóga',
      'Weird Fishes',
      'Karma Police',
      'Running Up That Hill',
      'Cloudbusting',
    ]);
    expect(all.payload.latest_listen_ts).toBe(unix('2026-01-15T11:00:00Z'));
    expect(all.payload.oldest_listen_ts).toBe(unix('2025-01-14T11:00:00Z'));
    // One listen in full: the record's fields, the index time, the MSID of the music keys.
    expect(all.payload.listens[0]).toEqual({
      listened_at: unix('2026-01-15T11:00:00Z'),
      inserted_at: unix(NOW_ISO),
      recording_msid: await recordingMsid('Radiohead', 'No Surprises'),
      user_name: 'alice',
      track_metadata: {
        artist_name: 'Radiohead',
        track_name: 'No Surprises',
        release_name: 'OK Computer',
        additional_info: {},
      },
    });
    // No album: no release_name key. Spelling variants share one MSID.
    expect(all.payload.listens[5]!.track_metadata).toEqual({
      artist_name: 'Kate Bush',
      track_name: 'Running Up That Hill',
      additional_info: {},
    });
    expect(all.payload.listens[1]!.recording_msid).toBe(all.payload.listens[2]!.recording_msid);

    // user_id echoes the path value as typed, whatever rule resolved it.
    expect((await listens(app, '/1/user/ALICE/listens')).payload.user_id).toBe('ALICE');
    const byDid = await listens(app, `/1/user/${ALICE}/listens`);
    expect([byDid.payload.user_id, byDid.payload.count]).toEqual([ALICE, 7]);
    expect(byDid.payload.listens[0]!.user_name).toBe('alice');

    // count: default 25, silently capped at 1,000.
    const carol = await listens(app, '/1/user/Carol.Test/listens');
    expect([carol.payload.user_id, carol.payload.count, carol.payload.listens.length]).toEqual(['Carol.Test', 25, 25]);
    expect(carol.payload.listens[0]!.track_metadata.track_name).toBe('Track 1');
    expect(carol.payload.listens[0]!.user_name).toBe('carol.test');
    expect((await listens(app, '/1/user/carol.test/listens?count=5000')).payload.count).toBe(1000);
    expect((await listens(app, '/1/user/carol.test/listens?count=1000')).payload.count).toBe(1000);
    expect((await listens(app, '/1/user/carol.test/listens?count=3')).payload.count).toBe(3);
    expect((await listens(app, '/1/user/alice/listens?count=0')).payload).toMatchObject({ count: 0, listens: [] });
    for (const [query, error] of [
      ['count=-1', "'count' should be a non-negative integer"],
      ['count=abc', 'Invalid count argument: abc'],
      ['min_ts=1.5', 'Invalid min_ts argument: 1.5'],
    ] as const) {
      const res = await app.fetch(`/1/user/alice/listens?${query}`);
      expect([res.status, await res.json()]).toEqual([400, { code: 400, error }]);
    }

    // min_ts and max_ts are exclusive.
    const r03 = unix('2026-01-08T12:00:00Z');
    const r02 = unix('2026-01-14T11:00:00Z');
    const r04 = unix('2025-12-16T12:00:00Z');
    expect(tracks(await listens(app, `/1/user/alice/listens?min_ts=${r03}`))).toEqual(['No Surprises', 'Jóga', 'jóga']);
    expect(tracks(await listens(app, `/1/user/alice/listens?min_ts=${r03 - 1}`))).toHaveLength(4);
    expect(tracks(await listens(app, `/1/user/alice/listens?max_ts=${r02}`))).toEqual([
      'Weird Fishes',
      'Karma Police',
      'Running Up That Hill',
      'Cloudbusting',
    ]);
    expect(tracks(await listens(app, `/1/user/alice/listens?min_ts=${r04}&max_ts=${r02}`))).toEqual(['Weird Fishes']);
    // With min_ts: the oldest `count` after it, reversed to newest first (r01 sorts before r07 ascending).
    expect(tracks(await listens(app, `/1/user/alice/listens?min_ts=${r03}&count=2`))).toEqual(['Jóga', 'jóga']);
    // Without: the newest `count`.
    expect(tracks(await listens(app, `/1/user/alice/listens?max_ts=${r02 + 1}&count=2`))).toEqual([
      'jóga',
      'Weird Fishes',
    ]);
    // The history span does not depend on the bounds.
    const bounded = await listens(app, `/1/user/alice/listens?min_ts=${r04}&max_ts=${r02}`);
    expect([bounded.payload.latest_listen_ts, bounded.payload.oldest_listen_ts]).toEqual([
      unix('2026-01-15T11:00:00Z'),
      unix('2025-01-14T11:00:00Z'),
    ]);
    // max_ts <= min_ts is a 400.
    for (const query of [`min_ts=${r02}&max_ts=${r03}`, `min_ts=${r02}&max_ts=${r02}`]) {
      const res = await app.fetch(`/1/user/alice/listens?${query}`);
      expect([res.status, await res.json()]).toEqual([
        400,
        { code: 400, error: 'max_ts should be greater than min_ts' },
      ]);
    }
  });

  it("an unknown user is 404 'Cannot find user: x'; playing-now with nothing playing has count 0 and listens []; listen-count is 7 for Alice", async () => {
    const app = await started();

    for (const path of ['/1/user/x/listens', '/1/user/x/playing-now', '/1/user/x/listen-count']) {
      const res = await app.fetch(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.json()).toEqual({ code: 404, error: 'Cannot find user: x' });
    }
    // A stale or foreign name is not found either: Bob never signed in, so `bob` is no username.
    expect((await app.fetch('/1/user/bob/listens')).status).toBe(404);
    // An inactive user is not found.
    app.db.run('UPDATE users SET active = 0 WHERE did = ?', CAROL);
    expect(await (await app.fetch('/1/user/carol.test/listen-count')).json()).toEqual({
      code: 404,
      error: 'Cannot find user: carol.test',
    });

    // Nothing playing.
    const idle = await app.fetch('/1/user/alice/playing-now');
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual({ payload: { count: 0, user_id: 'alice', playing_now: true, listens: [] } });

    // Something playing (the store's TTL rules, N2-06): listed with playing_now true.
    const deps = app.composed.core.deps;
    upsertNowPlaying(deps, {
      did: ALICE,
      artist: 'Massive Attack',
      track: 'Teardrop',
      album: 'Mezzanine',
      durationSeconds: 330,
      client: 'Navidrome',
      source: 'listenbrainz',
    });
    expect(await (await app.fetch('/1/user/Alice/playing-now')).json()).toEqual({
      payload: {
        count: 1,
        user_id: 'Alice',
        playing_now: true,
        listens: [
          {
            track_metadata: {
              artist_name: 'Massive Attack',
              track_name: 'Teardrop',
              release_name: 'Mezzanine',
              additional_info: { duration_ms: 330_000, submission_client: 'Navidrome' },
            },
            user_name: 'alice',
            playing_now: true,
          },
        ],
      },
    });
    // Not shared: count 0 again. Expired: count 0.
    const playing = async () =>
      (
        (await (await app.fetch('/1/user/alice/playing-now')).json()) as {
          payload: { count: number; listens: unknown[] };
        }
      ).payload;
    app.db.run('UPDATE accounts SET share_now_playing = 0 WHERE did = ?', ALICE);
    expect((await playing()).count).toBe(0);
    app.db.run('UPDATE accounts SET share_now_playing = 1 WHERE did = ?', ALICE);
    expect((await playing()).count).toBe(1);
    app.db.run('UPDATE now_playing SET expires_at_ms = ? WHERE did = ?', app.clock.nowMs(), ALICE);
    expect(await playing()).toEqual({
      count: 0,
      user_id: 'alice',
      playing_now: true,
      listens: [],
    });

    // listen-count: Alice 7 (r08 deleted), Bob 1.
    const count = await app.fetch('/1/user/alice/listen-count');
    expect(count.status).toBe(200);
    expect(await count.json()).toEqual({ payload: { count: 7 } });
    expect(await (await app.fetch('/1/user/bob.test/listen-count')).json()).toEqual({ payload: { count: 1 } });
  });
});
