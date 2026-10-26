// N3-06: GET /1/stats/user/{user}/{artists|releases|release-groups|recordings},
// listening-activity and daily-activity (ADR 0005 §8.5, §10.1, §10.2).
//
// The whole composition runs in-process (support/app.ts) with the /1/ router
// mounted. Alice's and Bob's fixture records (tests/fixtures/read_models.json)
// are applied through the production verifier and apply path; Alice is the
// account `alice`. Frozen clock 2026-01-15T12:00:00Z (a Thursday). Expected
// rankings are worked out by hand from the fixture (count descending, then
// the music keys in byte order; display text from the newest listen):
//
//   artists   radiohead 3 (r03 r04 r07), björk 2 (r01 r02), kate bush 2 (r05 r06)
//   albums    björk/homogenic 2, radiohead/ok computer 2, kate bush/hounds of love 1,
//             radiohead/in rainbows 1 (r05 has no album)
//   tracks    björk/jóga 2, then kate bush/cloudbusting, kate bush/running up that hill,
//             radiohead/karma police, radiohead/no surprises, radiohead/weird fishes
//
// Ranges at that instant: week = [Mon 2026-01-05, Mon 2026-01-12) holds r03;
// this_week = [2026-01-12, now] holds r01 r02 r07; year = 2025 holds r04 r05 r06;
// month = December 2025 holds r04 only, so Bob (r09 today) has none.

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import { ensureAccount, renameAccount } from '../../../src/credentials/accounts';
import type { Db } from '../../../src/do/db';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { listenBrainzRoutes } from '../../../src/listenbrainz/routes';
import { closeApps, startApp, type TestApp } from '../support/app';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
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

async function started(): Promise<TestApp> {
  const app = await startApp({ routes: listenBrainzRoutes() });
  const db = app.db;
  seedUser(db, ALICE, fixture.users.Alice.handle);
  seedUser(db, BOB, fixture.users.Bob.handle);
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
  return app;
}

type Payload = Record<string, unknown> & { count: number; offset: number };

async function payload(app: TestApp, path: string): Promise<Payload> {
  const res = await app.fetch(path);
  expect(res.status).toBe(200);
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  return ((await res.json()) as { payload: Payload }).payload;
}

async function errorOf(app: TestApp, path: string): Promise<[number, unknown]> {
  const res = await app.fetch(path);
  return [res.status, await res.json()];
}

const ALL_TIME = { range: 'all_time', from_ts: unix('2002-01-01T00:00:00Z'), to_ts: unix(NOW_ISO) };
const nulls = { artists: null, caa_id: null, caa_release_mbid: null };

afterEach(closeApps);

describe('ListenBrainz statistics (ADR §8.5)', () => {
  it('artists, releases, release-groups and recordings payloads carry the documented keys, total_*_count and null MBIDs for range all_time', async () => {
    const app = await started();

    const artists = await payload(app, '/1/stats/user/alice/artists');
    expect(artists).toEqual({
      user_id: 'alice',
      artists: [
        { artist_mbid: null, artist_name: 'Radiohead', listen_count: 3 },
        { artist_mbid: null, artist_name: 'Björk', listen_count: 2 },
        { artist_mbid: null, artist_name: 'Kate Bush', listen_count: 2 },
      ],
      count: 3,
      total_artist_count: 3,
      offset: 0,
      ...ALL_TIME,
      last_updated: unix(NOW_ISO),
    });

    const releases = await payload(app, '/1/stats/user/alice/releases?range=all_time');
    expect(releases).toEqual({
      user_id: 'alice',
      releases: [
        {
          artist_mbids: [],
          release_mbid: null,
          release_name: 'Homogenic',
          listen_count: 2,
          artist_name: 'Björk',
          ...nulls,
        },
        {
          artist_mbids: [],
          release_mbid: null,
          release_name: 'OK Computer',
          listen_count: 2,
          artist_name: 'Radiohead',
          ...nulls,
        },
        {
          artist_mbids: [],
          release_mbid: null,
          release_name: 'Hounds of Love',
          listen_count: 1,
          artist_name: 'Kate Bush',
          ...nulls,
        },
        {
          artist_mbids: [],
          release_mbid: null,
          release_name: 'In Rainbows',
          listen_count: 1,
          artist_name: 'Radiohead',
          ...nulls,
        },
      ],
      count: 4,
      total_release_count: 4,
      offset: 0,
      ...ALL_TIME,
      last_updated: unix(NOW_ISO),
    });

    const groups = await payload(app, '/1/stats/user/alice/release-groups');
    expect(Object.keys(groups).sort()).toEqual(
      [
        'count',
        'from_ts',
        'last_updated',
        'offset',
        'range',
        'release_groups',
        'to_ts',
        'total_release_group_count',
        'user_id',
      ].sort(),
    );
    expect(groups.total_release_group_count).toBe(4);
    expect(groups.release_groups).toEqual([
      {
        artist_mbids: [],
        release_group_mbid: null,
        release_group_name: 'Homogenic',
        listen_count: 2,
        artist_name: 'Björk',
        ...nulls,
      },
      {
        artist_mbids: [],
        release_group_mbid: null,
        release_group_name: 'OK Computer',
        listen_count: 2,
        artist_name: 'Radiohead',
        ...nulls,
      },
      {
        artist_mbids: [],
        release_group_mbid: null,
        release_group_name: 'Hounds of Love',
        listen_count: 1,
        artist_name: 'Kate Bush',
        ...nulls,
      },
      {
        artist_mbids: [],
        release_group_mbid: null,
        release_group_name: 'In Rainbows',
        listen_count: 1,
        artist_name: 'Radiohead',
        ...nulls,
      },
    ]);

    const recordings = await payload(app, '/1/stats/user/alice/recordings');
    expect(recordings.total_recording_count).toBe(6);
    expect([recordings.count, recordings.offset, recordings.range, recordings.user_id]).toEqual([
      6,
      0,
      'all_time',
      'alice',
    ]);
    const recording = (track: string, artist: string, release: string | null, n: number) => ({
      artist_name: artist,
      artist_mbids: [],
      recording_mbid: null,
      release_name: release,
      release_mbid: null,
      track_name: track,
      listen_count: n,
      ...nulls,
    });
    expect(recordings.recordings).toEqual([
      recording('Jóga', 'Björk', 'Homogenic', 2),
      recording('Cloudbusting', 'Kate Bush', 'Hounds of Love', 1),
      recording('Running Up That Hill', 'Kate Bush', null, 1),
      recording('Karma Police', 'Radiohead', 'OK Computer', 1),
      recording('No Surprises', 'Radiohead', 'OK Computer', 1),
      recording('Weird Fishes', 'Radiohead', 'In Rainbows', 1),
    ]);
  });

  it("range=decade is 400 'Invalid range: decade'; a range with no listens is 204; count and offset page the ranking", async () => {
    const app = await started();

    for (const entity of [
      'artists',
      'releases',
      'release-groups',
      'recordings',
      'listening-activity',
      'daily-activity',
    ]) {
      expect(await errorOf(app, `/1/stats/user/alice/${entity}?range=decade`)).toEqual([
        400,
        { code: 400, error: 'Invalid range: decade' },
      ]);
      // The user is resolved first.
      expect(await errorOf(app, `/1/stats/user/nobody/${entity}?range=decade`)).toEqual([
        404,
        { code: 404, error: 'Cannot find user: nobody' },
      ]);
    }
    expect(await errorOf(app, '/1/stats/user/alice/artists?range=')).toEqual([
      400,
      { code: 400, error: 'Invalid range: ' },
    ]);

    // No listens in the range: 204 with an empty body (and the CORS set).
    for (const path of [
      '/1/stats/user/bob.test/artists?range=month',
      '/1/stats/user/bob.test/recordings?range=year',
      '/1/stats/user/bob.test/listening-activity?range=year',
      '/1/stats/user/bob.test/daily-activity?range=month',
    ]) {
      const res = await app.fetch(path);
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.text()).toBe('');
    }
    // Calendar ranges anchored on now.
    const week = await payload(app, '/1/stats/user/alice/artists?range=week');
    expect([week.artists, week.from_ts, week.to_ts, week.range]).toEqual([
      [{ artist_mbid: null, artist_name: 'Radiohead', listen_count: 1 }],
      unix('2026-01-05T00:00:00Z'),
      unix('2026-01-12T00:00:00Z'),
      'week',
    ]);
    expect((await payload(app, '/1/stats/user/alice/artists?range=this_week')).artists).toEqual([
      { artist_mbid: null, artist_name: 'Björk', listen_count: 2 },
      { artist_mbid: null, artist_name: 'Radiohead', listen_count: 1 },
    ]);

    // count and offset page the full ranking; the total stays the ranking's length.
    const names = (p: Payload) => (p.artists as Array<{ artist_name: string }>).map((a) => a.artist_name);
    const second = await payload(app, '/1/stats/user/alice/artists?count=1&offset=1');
    expect([names(second), second.count, second.total_artist_count, second.offset]).toEqual([['Björk'], 1, 3, 1]);
    const third = await payload(app, '/1/stats/user/alice/artists?count=2&offset=2');
    expect([names(third), third.count, third.total_artist_count]).toEqual([['Kate Bush'], 1, 3]);
    const past = await payload(app, '/1/stats/user/alice/artists?offset=10');
    expect([names(past), past.count, past.total_artist_count, past.offset]).toEqual([[], 0, 3, 10]);
    const none = await payload(app, '/1/stats/user/alice/recordings?count=0');
    expect([none.recordings, none.count, none.total_recording_count]).toEqual([[], 0, 6]);
    const tracks = await payload(app, '/1/stats/user/alice/recordings?count=2&offset=4');
    expect((tracks.recordings as Array<{ track_name: string }>).map((r) => r.track_name)).toEqual([
      'No Surprises',
      'Weird Fishes',
    ]);
    expect(await errorOf(app, '/1/stats/user/alice/artists?count=-1')).toEqual([
      400,
      { code: 400, error: "'count' should be a non-negative integer" },
    ]);
    expect(await errorOf(app, '/1/stats/user/alice/artists?offset=abc')).toEqual([
      400,
      { code: 400, error: 'Invalid offset argument: abc' },
    ]);
  });

  it('listening-activity for week and year and daily-activity have the ADR bucket counts and labels', async () => {
    const app = await started();
    type Bucket = { from_ts: number; to_ts: number; time_range: string; listen_count: number };

    // week: the previous Monday-to-Monday week and the one before, by day.
    const week = await payload(app, '/1/stats/user/alice/listening-activity?range=week');
    const days = week.listening_activity as Bucket[];
    expect([week.user_id, week.range, week.from_ts, week.to_ts, week.last_updated]).toEqual([
      'alice',
      'week',
      unix('2025-12-29T00:00:00Z'),
      unix('2026-01-12T00:00:00Z'),
      unix(NOW_ISO),
    ]);
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({
      from_ts: unix('2025-12-29T00:00:00Z'),
      to_ts: unix('2025-12-30T00:00:00Z'),
      time_range: 'Monday 29 December 2025',
      listen_count: 0,
    });
    expect(days[13]!.time_range).toBe('Sunday 11 January 2026');
    expect(days.filter((d) => d.listen_count > 0)).toEqual([
      {
        from_ts: unix('2026-01-08T00:00:00Z'),
        to_ts: unix('2026-01-09T00:00:00Z'),
        time_range: 'Thursday 08 January 2026',
        listen_count: 1,
      },
    ]);

    // year: 2024 and 2025, by month.
    const year = await payload(app, '/1/stats/user/alice/listening-activity?range=year');
    const months = year.listening_activity as Bucket[];
    expect([year.from_ts, year.to_ts]).toEqual([unix('2024-01-01T00:00:00Z'), unix('2026-01-01T00:00:00Z')]);
    expect(months.map((b) => b.time_range)).toEqual(
      [2024, 2025].flatMap((y) =>
        [
          'January',
          'February',
          'March',
          'April',
          'May',
          'June',
          'July',
          'August',
          'September',
          'October',
          'November',
          'December',
        ].map((month) => `${month} ${y}`),
      ),
    );
    expect(months.filter((b) => b.listen_count > 0).map((b) => [b.time_range, b.listen_count])).toEqual([
      ['January 2025', 2],
      ['December 2025', 1],
    ]);
    expect(months[12]).toEqual({
      from_ts: unix('2025-01-01T00:00:00Z'),
      to_ts: unix('2025-02-01T00:00:00Z'),
      time_range: 'January 2025',
      listen_count: 2,
    });

    // all_time: only years with listens.
    const allTime = await payload(app, '/1/stats/user/alice/listening-activity');
    expect((allTime.listening_activity as Bucket[]).map((b) => [b.time_range, b.listen_count])).toEqual([
      ['2025', 3],
      ['2026', 4],
    ]);

    // daily-activity: the zero-filled Monday-first 7 × 24 UTC grid.
    const daily = await payload(app, '/1/stats/user/alice/daily-activity');
    const grid = daily.daily_activity as Record<string, Array<{ hour: number; listen_count: number }>>;
    expect([daily.user_id, daily.range, daily.from_ts, daily.to_ts]).toEqual([
      'alice',
      'all_time',
      ALL_TIME.from_ts,
      ALL_TIME.to_ts,
    ]);
    expect(Object.keys(grid)).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    for (const hours of Object.values(grid)) expect(hours.map((h) => h.hour)).toEqual([...Array(24).keys()]);
    const nonZero = Object.entries(grid).flatMap(([day, hours]) =>
      hours.filter((h) => h.listen_count > 0).map((h) => [day, h.hour, h.listen_count]),
    );
    expect(nonZero).toEqual([
      ['Tuesday', 11, 1],
      ['Tuesday', 12, 1],
      ['Wednesday', 11, 1],
      ['Wednesday', 12, 1],
      ['Thursday', 11, 2],
      ['Thursday', 12, 1],
    ]);
    // this_week: r02 (Wednesday 11:00), r01 and r07 (Thursday 11:00).
    const thisWeek = await payload(app, '/1/stats/user/alice/daily-activity?range=this_week');
    const cells = Object.entries(thisWeek.daily_activity as typeof grid).flatMap(([day, hours]) =>
      hours.filter((h) => h.listen_count > 0).map((h) => [day, h.hour, h.listen_count]),
    );
    expect(cells).toEqual([
      ['Wednesday', 11, 1],
      ['Thursday', 11, 2],
    ]);
  });
});
