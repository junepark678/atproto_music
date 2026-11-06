// N3-04: the Last.fm 2.0 chart read methods over HTTP (ADR 0005 §7.5, §7.9,
// §10.1, §10.2): user.getTop{Artists,Albums,Tracks}, user.getWeeklyChartList
// and user.getWeekly{Artist,Album,Track}Chart.
//
// Alice's fixture listens (tests/fixtures/read_models.json) go through the
// production verifier and apply path into the real Node composition. The
// frozen clock is 2026-01-15T12:00:00Z (a Thursday): the current chart week
// started on Sunday 2026-01-11T12:00:00Z, so the last complete week is
// [2026-01-04T12:00Z, 2026-01-11T12:00Z), which holds only r03 (Weird Fishes,
// 2026-01-08T12:00Z). Alice's first listen, r06 (2025-01-14T11:00Z, a
// Tuesday), lies in the week of Sunday 2025-01-12T12:00Z: 53 weeks in all.

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { lastfmPeriodBounds } from '@atmusic/core/periods';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { Db } from '../../../src/do/db';
import { fromPeriod, rangeStats } from '../../../src/do/read/range-stats';
import { type ApplyOptions, applyRecordProof } from '../../../src/do/write/apply-record';
import { lastfmRoutes } from '../../../src/lastfm/routes';
import { closeApps, startApp, type TestApp } from '../support/app';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
const ALICE = fixture.users.Alice.did;
const NOW_ISO = '2026-01-15T12:00:00Z';
const NOW_NS = fromMs(Date.parse(NOW_ISO));
const NOW_MS = Date.parse(NOW_ISO);
const OPTS: ApplyOptions = { receiptNs: NOW_NS, prefix: PREFIX, nowNs: NOW_NS };
const API_KEY = 'chart-test-key';

const unix = (iso: string) => Date.parse(iso) / 1000;

async function seedAlice(db: Db): Promise<void> {
  const gen = db.one<{ g: number }>(
    'UPDATE backfill_generation SET last_generation = last_generation + 1 WHERE singleton = 1 RETURNING last_generation AS g',
  )!.g;
  db.run(
    `INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, 'alice.test', ?, 1, 'active', 'current', ?)`,
    ALICE,
    toStorage(NOW_NS),
    gen,
  );
  db.run("INSERT INTO accounts(did, username, created_at_ms, updated_at_ms) VALUES (?, 'alice', 1, 1)", ALICE);
  const repo = new SignedRepo(ALICE, (await fixtureKeys()).alice, { clock: fixedClock() });
  for (const s of fixture.scrobbles.filter((x) => x.owner === ALICE && x.state === 'confirmed')) {
    await repo.put(SCROBBLE, s.rkey, { ...s.record });
    const proof = await verifyRecordProof(await repo.getRecordCar(SCROBBLE, s.rkey), {
      did: ALICE,
      collection: SCROBBLE,
      rkey: s.rkey,
      signingKey: repo.key.didKey,
    });
    expect(db.tx(() => applyRecordProof(db, proof, OPTS)).outcome).toBe('applied');
  }
}

async function chartApp(): Promise<TestApp> {
  const app = await startApp({ routes: lastfmRoutes() });
  await seedAlice(app.db);
  return app;
}

// biome-ignore lint/suspicious/noExplicitAny: parsed protocol bodies
type Json = Record<string, any>;

async function get(app: TestApp, params: Record<string, string>): Promise<{ status: number; body: Json }> {
  const res = await app.fetch(`/2.0/?${new URLSearchParams({ api_key: API_KEY, format: 'json', ...params })}`);
  return { status: res.status, body: (await res.json()) as Json };
}

afterEach(async () => {
  await closeApps();
});

describe('Last.fm chart read methods', () => {
  it('getTopArtists overall and 7day equal the range-stats rankings with @attr.rank; limit clamps to 1000; period=2week gives 6', async () => {
    const app = await chartApp();
    const m = { db: app.db, clock: app.clock };

    const expected: Record<string, Array<[string, string, string]>> = {
      // Worked out by hand: count desc, then artist_key ascending (björk < kate bush < radiohead).
      overall: [
        ['Radiohead', '3', '1'],
        ['Björk', '2', '2'],
        ['Kate Bush', '2', '3'],
      ],
      // [now − 7 d, now]: r07, r01, r02, r03.
      '7day': [
        ['Björk', '2', '1'],
        ['Radiohead', '2', '2'],
      ],
    };
    for (const period of ['overall', '7day'] as const) {
      const res = await get(app, { method: 'user.getTopArtists', user: 'alice', period });
      expect(res.status, period).toBe(200);
      const artists = res.body.topartists.artist as Json[];
      const got = artists.map((a) => [a.name, a.playcount, a['@attr'].rank]);
      expect(got, period).toEqual(expected[period]);
      const engine = rangeStats(m, {
        did: ALICE,
        entity: 'artists',
        ...fromPeriod(lastfmPeriodBounds(period, NOW_MS)),
        limit: 50,
        offset: 0,
      })!;
      expect(got, period).toEqual(engine.items.map((i) => [i.artist, String(i.count), String(i.rank)]));
      expect(res.body.topartists['@attr'], period).toEqual({
        user: 'alice',
        page: '1',
        perPage: '50',
        totalPages: '1',
        total: String(engine.total),
      });
      expect(artists[0]).toMatchObject({
        mbid: '',
        streamable: '0',
        url: `https://www.last.fm/music/${period === 'overall' ? 'Radiohead' : 'Bj%C3%B6rk'}`,
      });
    }
    // An absent period is overall; ranks continue across pages.
    const page2 = await get(app, { method: 'user.getTopArtists', user: 'alice', limit: '2', page: '2' });
    expect((page2.body.topartists.artist as Json[]).map((a) => [a.name, a['@attr'].rank])).toEqual([
      ['Kate Bush', '3'],
    ]);
    expect(page2.body.topartists['@attr']).toMatchObject({ page: '2', perPage: '2', totalPages: '2', total: '3' });
    const xml = await (
      await app.fetch(`/2.0/?${new URLSearchParams({ api_key: API_KEY, method: 'user.getTopArtists', user: 'alice' })}`)
    ).text();
    expect(xml).toContain('<artist rank="1">\n      <name>Radiohead</name>\n      <playcount>3</playcount>');

    // limit is clamped to 1000.
    const big = await get(app, { method: 'user.getTopArtists', user: 'alice', limit: '5000' });
    expect(big.body.topartists['@attr'].perPage).toBe('1000');
    expect(big.body.topartists.artist).toHaveLength(3);

    // An unknown period is 6, for every top list.
    for (const method of ['user.getTopArtists', 'user.getTopAlbums', 'user.getTopTracks']) {
      const bad = await get(app, { method, user: 'alice', period: '2week' });
      expect([bad.status, bad.body.error], method).toEqual([400, 6]);
    }

    // Top tracks and albums come from the same engine; albums group by album artist.
    const tracks = await get(app, { method: 'user.getTopTracks', user: 'alice' });
    const t = tracks.body.toptracks.track as Json[];
    expect(t[0]).toMatchObject({
      name: 'Jóga',
      playcount: '2',
      duration: '0',
      '@attr': { rank: '1' },
      artist: { name: 'Björk', mbid: '', url: 'https://www.last.fm/music/Bj%C3%B6rk' },
      streamable: { fulltrack: '0', '#text': '0' },
    });
    expect(tracks.body.toptracks['@attr'].total).toBe('6');
    const albums = await get(app, { method: 'user.getTopAlbums', user: 'alice' });
    expect((albums.body.topalbums.album as Json[]).map((a) => [a.name, a.artist.name, a.playcount])).toEqual([
      ['Homogenic', 'Björk', '2'],
      ['OK Computer', 'Radiohead', '2'],
      ['Hounds of Love', 'Kate Bush', '1'],
      ['In Rainbows', 'Radiohead', '1'],
    ]);
  });

  it('getWeeklyChartList lists Sunday 12:00 UTC weeks and getWeeklyTrackChart without from/to returns the last complete week', async () => {
    const app = await chartApp();
    const list = await get(app, { method: 'user.getWeeklyChartList', user: 'alice' });
    expect(list.status).toBe(200);
    expect(list.body.weeklychartlist['@attr']).toEqual({ user: 'alice' });
    const charts = list.body.weeklychartlist.chart as Json[];
    expect(charts).toHaveLength(53);
    expect(charts[0]).toEqual({
      from: String(unix('2025-01-12T12:00:00Z')),
      to: String(unix('2025-01-19T12:00:00Z')),
      '#text': '',
    });
    expect(charts.at(-1)).toEqual({
      from: String(unix('2026-01-11T12:00:00Z')),
      to: String(unix('2026-01-18T12:00:00Z')),
      '#text': '',
    });
    for (const [i, c] of charts.entries()) {
      const from = new Date(Number(c.from) * 1000);
      expect([from.getUTCDay(), from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds()]).toEqual([0, 12, 0, 0]);
      expect(Number(c.to) - Number(c.from)).toBe(604_800);
      if (i > 0) expect(c.from).toBe(charts[i - 1]!.to);
    }

    // Default: the last complete week [2026-01-04T12:00Z, 2026-01-11T12:00Z), only r03.
    const week = await get(app, { method: 'user.getWeeklyTrackChart', user: 'alice' });
    expect(week.status).toBe(200);
    expect(week.body.weeklytrackchart['@attr']).toEqual({
      user: 'alice',
      from: String(unix('2026-01-04T12:00:00Z')),
      to: String(unix('2026-01-11T12:00:00Z')),
    });
    expect(week.body.weeklytrackchart.track).toEqual([
      {
        artist: { mbid: '', '#text': 'Radiohead' },
        image: ['small', 'medium', 'large', 'extralarge'].map((size) => ({ size, '#text': '' })),
        name: 'Weird Fishes',
        mbid: '',
        playcount: '1',
        url: 'https://www.last.fm/music/Radiohead/_/Weird+Fishes',
        '@attr': { rank: '1' },
      },
    ]);
    const artists = await get(app, { method: 'user.getWeeklyArtistChart', user: 'alice' });
    expect((artists.body.weeklyartistchart.artist as Json[]).map((a) => [a.name, a.playcount])).toEqual([
      ['Radiohead', '1'],
    ]);
    const albums = await get(app, { method: 'user.getWeeklyAlbumChart', user: 'alice' });
    expect((albums.body.weeklyalbumchart.album as Json[]).map((a) => [a.name, a.artist['#text']])).toEqual([
      ['In Rainbows', 'Radiohead'],
    ]);

    // Explicit [from, to): the current week holds r07, r01 and r02.
    const current = await get(app, {
      method: 'user.getWeeklyTrackChart',
      user: 'alice',
      from: String(unix('2026-01-11T12:00:00Z')),
      to: String(unix('2026-01-18T12:00:00Z')),
    });
    expect((current.body.weeklytrackchart.track as Json[]).map((x) => [x.name, x.playcount, x['@attr'].rank])).toEqual([
      ['Jóga', '2', '1'],
      ['No Surprises', '1', '2'],
    ]);
    // An empty week is an empty list, never an object or a missing key.
    const empty = await get(app, { method: 'user.getWeeklyArtistChart', user: 'alice', from: '1', to: '2' });
    expect(empty.body.weeklyartistchart.artist).toEqual([]);
    // from without to is 6.
    const half = await get(app, { method: 'user.getWeeklyTrackChart', user: 'alice', from: '1' });
    expect([half.status, half.body.error]).toEqual([400, 6]);
    // from/to past year 9999 (MAX_UNIX_SECONDS) are an invalid parameter (6),
    // never an internal failure (8) with an error log.
    const outOfRange: Array<[string, string, string]> = [
      ['user.getWeeklyTrackChart', '0', '300000000000'],
      ['user.getWeeklyArtistChart', '0', '9007199254740991'],
      ['user.getWeeklyAlbumChart', '300000000000', '300000604800'],
    ];
    for (const [method, from, to] of outOfRange) {
      const res = await get(app, { method, user: 'alice', from, to });
      expect([res.status, res.body.error, res.body.message]).toEqual([
        400,
        6,
        `Invalid parameters - ${from === '0' ? 'to' : 'from'} is out of range`,
      ]);
    }
    expect(app.log.logs.filter((l) => l.event === 'lastfm.method_failed')).toEqual([]);
    // Every request was logged (7 above plus these), so the absence is not vacuous.
    const requestLines = app.log.logs.filter((l) => l.event === 'request');
    expect(requestLines).toHaveLength(7 + outOfRange.length);
    expect(requestLines.slice(-outOfRange.length).map((l) => l.lastfmMethod)).toEqual(outOfRange.map(([m]) => m));
  });
});
