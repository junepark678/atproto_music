// N2-06: the generalised range statistics engine and its exact cache (ADR 0005
// §10.2, §10.3, §15.4 "Range stats equal to the /api/v1 stats on the shared
// fixture").
//
// The shared fixture (tests/fixtures/read_models.json) is published into real
// signed repositories; every record goes through the production verifier
// (verifyRecordProof over the getRecord CAR) and the production apply path into
// a migrated node:sqlite file. The album-artist columns are written directly,
// because the apply path projects them only from N3-11 on (ADR §6.5). Every
// expectation is hardcoded from TESTING.md or computed by hand here; the /api/v1
// module (worker/src/do/read/stats.ts, untouched) is the equality reference.

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { artistKey } from '@atmusic/core/music-key';
import { lastfmPeriodBounds, listenBrainzRangeBounds } from '@atmusic/core/periods';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { Db } from '../../../src/do/db';
import {
  computeRangeStats,
  fromPeriod,
  globalArtistCounts,
  globalTrackCounts,
  type RangeAlbumItem,
  type RangeArtistItem,
  type RangeEntity,
  type RangeTrackItem,
  rangeStats,
  rangeStatsWithCache,
} from '../../../src/do/read/range-stats';
import { computeStatistics } from '../../../src/do/read/stats';
import { type ApplyOptions, applyRecordProof } from '../../../src/do/write/apply-record';
import { withMigratedDb } from '../support/node-db';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
const ALICE = fixture.users.Alice.did;
const BOB = fixture.users.Bob.did;
const CAROL = fixture.users.Carol.did;
const NOW_MS = Date.parse('2026-01-15T12:00:00Z');
const NOW_NS = fromMs(NOW_MS);
const OPTS: ApplyOptions = { receiptNs: NOW_NS, prefix: PREFIX, nowNs: NOW_NS };
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Seeding through the production verify → apply path

/** The users row admission plus a completed snapshot leave behind (test-only write). */
function seedUser(db: Db, did: string): void {
  const gen = db.one<{ g: number }>(
    'UPDATE backfill_generation SET last_generation = last_generation + 1 WHERE singleton = 1 RETURNING last_generation AS g',
  )!.g;
  db.run(
    `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, 1, 'active', 'current', ?)`,
    did,
    toStorage(NOW_NS),
    gen,
  );
}

async function applyVerified(db: Db, repo: SignedRepo, rkey: string): Promise<string> {
  const car = await repo.getRecordCar(SCROBBLE, rkey);
  const proof = await verifyRecordProof(car, {
    did: repo.did,
    collection: SCROBBLE,
    rkey,
    signingKey: repo.key.didKey,
  });
  return db.tx(() => applyRecordProof(db, proof, OPTS)).outcome;
}

async function put(db: Db, repo: SignedRepo, rkey: string, record: Record<string, unknown>): Promise<void> {
  await repo.put(SCROBBLE, rkey, record);
  expect(await applyVerified(db, repo, rkey)).toBe('applied');
}

const listen = (artist: string, track: string, at: string, album?: string) => ({
  $type: SCROBBLE,
  artist,
  track,
  listenedAt: at,
  createdAt: at,
  ...(album === undefined ? {} : { album }),
});

/** Alice's r01..r08 (r08 created then deleted) and Bob's r09, from the shared fixture. */
async function seedFixture(db: Db) {
  seedUser(db, ALICE);
  seedUser(db, BOB);
  const keys = await fixtureKeys();
  const alice = new SignedRepo(ALICE, keys.alice, { clock: fixedClock() });
  const bob = new SignedRepo(BOB, keys.bob, { clock: fixedClock() });
  for (const s of fixture.scrobbles) {
    if (s.owner === ALICE) await put(db, alice, s.rkey, { ...s.record });
    else if (s.owner === BOB) await put(db, bob, s.rkey, { ...s.record });
  }
  await alice.delete(SCROBBLE, 'r08');
  expect(await applyVerified(db, alice, 'r08')).toBe('absent');
  expect(db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles WHERE did = ?', ALICE)!.n).toBe(7);
  return { alice, bob, keys };
}

const deps = (db: Db, clock = fixedClock()) => ({ db, clock });

const overall = fromPeriod(lastfmPeriodBounds('overall', NOW_MS));
const sevenDays = fromPeriod(lastfmPeriodBounds('7day', NOW_MS));

/** The /api/v1 lists in the engine's shape, for equality. */
function v1Lists(db: Db, window: 'all' | '7d') {
  const s = computeStatistics(db, ALICE, window, 100, NOW_NS);
  return {
    totals: [s.totalScrobbles, s.distinctArtists, s.distinctTracks],
    artists: s.topArtists.map((a) => [a.artist, a.scrobbleCount]),
    tracks: s.topTracks.map((t) => [t.artist, t.track, t.scrobbleCount]),
    albums: s.topAlbums.map((a) => [a.artist, a.album, a.scrobbleCount]),
  };
}

function rangeLists(db: Db, bounds: typeof overall) {
  const q = <E extends RangeEntity>(entity: E) => ({ did: ALICE, entity, ...bounds, limit: null, offset: 0 });
  const artists = computeRangeStats(db, q('artists'));
  const tracks = computeRangeStats(db, q('tracks'));
  const albums = computeRangeStats(db, q('albums'));
  return {
    totals: [artists.totals.listens, artists.totals.artists, artists.totals.tracks],
    albumTotal: albums.totals.albums,
    artists: artists.items.map((a: RangeArtistItem) => [a.artist, a.count]),
    tracks: tracks.items.map((t: RangeTrackItem) => [t.artist, t.track, t.count]),
    albums: albums.items.map((a: RangeAlbumItem) => [a.artist, a.album, a.count]),
    artistKeys: artists.items.map((a) => [a.artistKey, a.count]),
  };
}

describe('range statistics engine', () => {
  it('Alice all-time: totals 7/3/6 and artists (radiohead,3),(björk,2),(kate bush,2), equal to /api/v1 stats window all', async () => {
    await withMigratedDb(async (db) => {
      await seedFixture(db);
      const got = rangeStats(deps(db), { did: ALICE, entity: 'artists', ...overall, limit: 10, offset: 0 });
      expect(got).not.toBeNull();
      expect(got!.totals).toEqual({ listens: 7, artists: 3, tracks: 6, albums: 4 });
      expect(got!.total).toBe(3);
      expect(got!.lower).toBeNull();
      // (−∞, now] is the half-open [.., now + 1 ns) over the storage form.
      expect(got!.upper).toBe('2026-01-15T12:00:00.000000001Z');
      expect(got!.items.map((a) => [a.rank, a.artistKey, a.artist, a.count])).toEqual([
        [1, 'radiohead', 'Radiohead', 3],
        [2, 'björk', 'Björk', 2],
        [3, 'kate bush', 'Kate Bush', 2],
      ]);

      const range = rangeLists(db, overall);
      const v1 = v1Lists(db, 'all');
      expect(range.totals).toEqual([7, 3, 6]);
      expect(range.totals).toEqual(v1.totals);
      expect(range.artists).toEqual(v1.artists);
      expect(range.tracks).toEqual(v1.tracks);
      // Without album artists the album-artist grouping equals the /api/v1 one.
      expect(range.albums).toEqual(v1.albums);
      expect(range.albums).toEqual([
        ['Björk', 'Homogenic', 2],
        ['Radiohead', 'OK Computer', 2],
        ['Kate Bush', 'Hounds of Love', 1],
        ['Radiohead', 'In Rainbows', 1],
      ]);
      expect(range.albumTotal).toBe(4);
      // Bob's r09 is not Alice's, and an unnamed range is never cached.
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM range_stats_cache')!.n).toBe(0);
      // Unknown and inactive users have no statistics.
      expect(rangeStats(deps(db), { did: CAROL, entity: 'artists', ...overall, limit: 10, offset: 0 })).toBeNull();
      db.run('UPDATE users SET active = 0 WHERE did = ?', BOB);
      expect(rangeStats(deps(db), { did: BOB, entity: 'artists', ...overall, limit: 10, offset: 0 })).toBeNull();
    });
  });

  it('[asOf−7 d, asOf] equals the /api/v1 7d window for totals and every top list', async () => {
    await withMigratedDb(async (db) => {
      await seedFixture(db);
      expect(sevenDays).toEqual({ lower: NOW_MS - 7 * DAY_MS, upper: NOW_MS, upperInclusive: true });
      const range = rangeLists(db, sevenDays);
      const v1 = v1Lists(db, '7d');
      // TESTING.md 7d: r01, r02, r03 (exactly asOf − 7 d, inclusive) and r07.
      expect(range.totals).toEqual([4, 2, 3]);
      expect(range.totals).toEqual(v1.totals);
      expect(range.artists).toEqual([
        ['Björk', 2],
        ['Radiohead', 2],
      ]);
      expect(range.artists).toEqual(v1.artists);
      expect(range.tracks).toEqual([
        ['Björk', 'Jóga', 2],
        ['Radiohead', 'No Surprises', 1],
        ['Radiohead', 'Weird Fishes', 1],
      ]);
      expect(range.tracks).toEqual(v1.tracks);
      expect(range.albums).toEqual([
        ['Björk', 'Homogenic', 2],
        ['Radiohead', 'In Rainbows', 1],
        ['Radiohead', 'OK Computer', 1],
      ]);
      expect(range.albums).toEqual(v1.albums);
      expect(range.albumTotal).toBe(3);

      // A half-open [asOf − 7 d, asOf) drops nothing here, while (asOf − 7 d, ..]
      // would drop r03: the lower bound is inclusive at nanosecond precision.
      const shifted = computeRangeStats(db, {
        did: ALICE,
        entity: 'tracks',
        lower: NOW_MS - 7 * DAY_MS + 1,
        upper: NOW_MS,
        upperInclusive: true,
        limit: null,
        offset: 0,
      });
      expect(shifted.totals.listens).toBe(3);
      expect(shifted.items.map((t) => t.trackKey)).toEqual(['jóga', 'no surprises']);
    });
  });

  it('offset/limit pages concatenate to the full ranking; album totals group by (album artist or artist, album)', async () => {
    await withMigratedDb(async (db) => {
      await seedFixture(db);
      const full = computeRangeStats(db, { did: ALICE, entity: 'tracks', ...overall, limit: null, offset: 0 });
      expect(full.items).toHaveLength(6);
      expect(full.total).toBe(6);
      const pages = [0, 2, 4, 6].map((offset) =>
        computeRangeStats(db, { did: ALICE, entity: 'tracks', ...overall, limit: 2, offset }),
      );
      expect(pages.map((p) => p.items.length)).toEqual([2, 2, 2, 0]);
      expect(pages.flatMap((p) => p.items)).toEqual(full.items);
      expect(full.items.map((t) => t.rank)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(pages.every((p) => p.total === 6 && p.totals.listens === 7)).toBe(true);
      expect(full.items.map((t) => [t.artistKey, t.trackKey, t.count])).toEqual([
        ['björk', 'jóga', 2],
        ['kate bush', 'cloudbusting', 1],
        ['kate bush', 'running up that hill', 1],
        ['radiohead', 'karma police', 1],
        ['radiohead', 'no surprises', 1],
        ['radiohead', 'weird fishes', 1],
      ]);
      // Display spelling is the newest row of the group (r01 over r02).
      expect(full.items[0]).toMatchObject({ artist: 'Björk', track: 'Jóga', album: 'Homogenic' });

      // Album-artist grouping: Carol's compilation listens.
      seedUser(db, CAROL);
      const carol = new SignedRepo(CAROL, (await fixtureKeys()).carol, { clock: fixedClock() });
      await put(db, carol, 'c1', listen('Massive Attack', 'Teardrop', '2026-01-10T10:00:00Z', 'Now 1'));
      await put(db, carol, 'c2', listen('Portishead', 'Roads', '2026-01-11T10:00:00Z', 'Now 1'));
      await put(db, carol, 'c3', listen('Portishead', 'Sour Times', '2026-01-12T10:00:00Z', 'Now 1'));
      await put(db, carol, 'c4', listen('Portishead', 'Glory Box', '2026-01-13T10:00:00Z', 'Dummy'));
      // N3-11 projects albumArtist; until then the columns are written directly.
      db.run(
        'UPDATE scrobbles SET album_artist = ?, album_artist_key = ? WHERE did = ? AND rkey IN (?, ?)',
        'Various Artists',
        artistKey('Various Artists'),
        CAROL,
        'c1',
        'c2',
      );
      const albums = computeRangeStats(db, { did: CAROL, entity: 'albums', ...overall, limit: null, offset: 0 });
      expect(albums.totals).toEqual({ listens: 4, artists: 2, tracks: 4, albums: 3 });
      expect(albums.total).toBe(3);
      expect(albums.items.map((a) => [a.artistKey, a.albumKey, a.artist, a.album, a.count])).toEqual([
        ['various artists', 'now 1', 'Various Artists', 'Now 1', 2],
        ['portishead', 'dummy', 'Portishead', 'Dummy', 1],
        ['portishead', 'now 1', 'Portishead', 'Now 1', 1],
      ]);
      // The /api/v1 statistics keep grouping by (artist, album).
      const v1 = computeStatistics(db, CAROL, 'all', 100, NOW_NS);
      expect(v1.topAlbums.map((a) => [a.artist, a.album, a.scrobbleCount])).toEqual([
        ['Portishead', 'Now 1', 2],
        ['Massive Attack', 'Now 1', 1],
        ['Portishead', 'Dummy', 1],
      ]);
      const page2 = computeRangeStats(db, { did: CAROL, entity: 'albums', ...overall, limit: 1, offset: 1 });
      expect(page2.items).toEqual([albums.items[1]]);
    });
  });

  it('a cache hit occurs only with unchanged stats_version and no row across a sliding bound, and equals the uncached result', async () => {
    await withMigratedDb(async (db) => {
      const { alice } = await seedFixture(db);
      // X: 200 s after asOf (accepted: within receipt + 300 s), beyond every upper bound at first.
      await put(db, alice, 'x1', listen('Radiohead', 'Reckoner', '2026-01-15T12:03:20Z', 'In Rainbows'));
      const clock = fixedClock();
      const m = deps(db, clock);
      const q = (o: { limit: number | null; offset: number }) =>
        ({
          did: ALICE,
          entity: 'tracks',
          ...fromPeriod(lastfmPeriodBounds('7day', clock.nowMs())),
          ...o,
          rangeKey: 'lastfm:7day',
        }) as const;
      const version = () => db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', ALICE)!.v;
      const row = () =>
        db.one<{ as_of: string; lower: string; upper: string; version: number }>(
          "SELECT as_of, lower, upper, version FROM range_stats_cache WHERE did = ? AND entity = 'tracks' AND range_key = 'lastfm:7day'",
          ALICE,
        );
      /** One request: the outcome, and the result equals the uncached computation. */
      const ask = (o: { limit: number | null; offset: number }) => {
        const got = rangeStatsWithCache(m, q(o));
        const { rangeKey: _, ...uncachedQuery } = q(o);
        expect(got.stats).toEqual(computeRangeStats(db, uncachedQuery));
        return got;
      };

      // (a) First request: miss, the full ranking is stored under the current version.
      const a = ask({ limit: 2, offset: 0 });
      expect([a.cache, a.write]).toEqual(['miss', 'stored']);
      expect(a.stats!.totals.listens).toBe(4);
      expect(row()).toEqual({
        as_of: '2026-01-15T12:00:00.000000000Z',
        lower: '2026-01-08T12:00:00.000000000Z',
        upper: '2026-01-15T12:00:00.000000001Z',
        version: version(),
      });
      // (b) Same bounds, another page: hit.
      expect(ask({ limit: 2, offset: 2 }).cache).toBe('hit');
      expect(ask({ limit: null, offset: 0 }).stats!.items).toHaveLength(3);

      // (c) +100 s: r03 (exactly the old lower bound) crossed the sliding lower bound → miss.
      clock.advance(100_000);
      const c = ask({ limit: 10, offset: 0 });
      expect(c.cache).toBe('miss');
      expect(c.stats!.totals.listens).toBe(3);
      expect(row()!.as_of).toBe('2026-01-15T12:01:40.000000000Z');
      // (d) +150 s: nothing crossed either bound since (c) → hit.
      clock.advance(50_000);
      expect(ask({ limit: 10, offset: 0 }).cache).toBe('hit');
      // (e) +250 s: X crossed the sliding upper bound → miss, and X now counts.
      clock.advance(100_000);
      const e = ask({ limit: 10, offset: 0 });
      expect(e.cache).toBe('miss');
      expect(e.stats!.totals.listens).toBe(4);
      expect(e.stats!.items.map((t) => t.trackKey)).toContain('reckoner');
      // (f) +260 s: hit again.
      clock.advance(10_000);
      expect(ask({ limit: 10, offset: 0 }).cache).toBe('hit');

      // (g) A new listen far outside the window bumps stats_version: miss although no row crossed.
      const before = version();
      await put(db, alice, 'x2', listen('Kate Bush', 'Babooshka', '2025-06-01T00:00:00Z'));
      expect(version()).toBeGreaterThan(before);
      const g = ask({ limit: 10, offset: 0 });
      expect(g.cache).toBe('miss');
      expect(g.stats!.items).toEqual(e.stats!.items);
      expect(row()!.version).toBe(version());
      expect(ask({ limit: 10, offset: 0 }).cache).toBe('hit');

      // A fixed calendar range has identical bounds all week: only the version decides.
      const week = (nowMs: number) =>
        ({
          did: ALICE,
          entity: 'artists',
          ...fromPeriod(listenBrainzRangeBounds('week', nowMs)),
          limit: null,
          offset: 0,
          rangeKey: 'lb:week',
        }) as const;
      expect(rangeStatsWithCache(m, week(clock.nowMs())).cache).toBe('miss');
      clock.advance(2 * DAY_MS);
      const w = rangeStatsWithCache(m, week(clock.nowMs()));
      expect(w.cache).toBe('hit');
      const { rangeKey: _w, ...weekQuery } = week(clock.nowMs());
      expect(w.stats).toEqual(computeRangeStats(db, weekQuery));
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM range_stats_cache WHERE did = ?', ALICE)!.n).toBe(2);
    });
  });

  it('global counts cover every visible listener of a track or artist', async () => {
    await withMigratedDb(async (db) => {
      const { bob } = await seedFixture(db);
      await put(db, bob, 'b2', listen('björk', 'JÓGA', '2026-01-12T10:00:00Z'));
      expect(globalTrackCounts(db, 'björk', 'jóga')).toEqual({ listeners: 2, playcount: 3 });
      expect(globalArtistCounts(db, 'radiohead')).toEqual({ listeners: 1, playcount: 3 });
      db.run('UPDATE users SET active = 0 WHERE did = ?', BOB);
      expect(globalTrackCounts(db, 'björk', 'jóga')).toEqual({ listeners: 1, playcount: 2 });
      expect(globalArtistCounts(db, 'massive attack')).toEqual({ listeners: 0, playcount: 0 });
    });
  });
});
