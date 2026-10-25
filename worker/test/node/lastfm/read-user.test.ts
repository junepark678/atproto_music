// N3-04: the Last.fm 2.0 user read methods over HTTP (ADR 0005 §7.2, §7.5,
// §7.9, §9): user.getRecentTracks, user.getTrackScrobbles, user.getInfo,
// user.getLovedTracks, user.getFriends and library.getArtists.
//
// The app is the real Node composition (support/app.ts) with the /2.0 routes
// mounted. Alice's and Bob's fixture records (tests/fixtures/read_models.json)
// are published into real signed repositories and applied through the
// production verifier and apply path; the follow Alice → Bob too. Loves (the
// N3-11 projection is not in this wave) and now-playing rows are seeded
// directly, with the production music keys. Expected values are worked out by
// hand from the fixture:
//
//   r07 Radiohead / No Surprises      2026-01-15T11:00:00Z  (uri DESC puts r07 before r01)
//   r01 Björk / Jóga                  2026-01-15T11:00:00Z
//   r02 "  BJÖRK  " / jóga            2026-01-14T11:00:00Z
//   r03 Radiohead / Weird Fishes      2026-01-08T12:00:00Z
//   r04 Radiohead / Karma Police      2025-12-16T12:00:00Z
//   r05 Kate Bush / Running Up That Hill 2025-01-15T12:00:00Z
//   r06 Kate Bush / Cloudbusting      2025-01-14T11:00:00Z   (r08 deleted)
//   Bob: r09 Massive Attack / Teardrop 2026-01-15T11:30:00Z

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { artistKey, trackKey } from '@atmusic/core/music-key';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import { createSession } from '../../../src/credentials/lastfm-auth';
import type { Db } from '../../../src/do/db';
import { upsertNowPlaying } from '../../../src/do/read/now-playing';
import { type ApplyOptions, applyRecordProof } from '../../../src/do/write/apply-record';
import { lastfmRoutes } from '../../../src/lastfm/routes';
import { closeApps, startApp, TEST_PUBLIC_ORIGIN, type TestApp } from '../support/app';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
const FOLLOW = `${PREFIX}.follow`;
const LOVE = `${PREFIX}.love`;
const ALICE = fixture.users.Alice.did;
const BOB = fixture.users.Bob.did;
const CAROL = fixture.users.Carol.did;
const NOW_ISO = '2026-01-15T12:00:00Z';
const NOW_NS = fromMs(Date.parse(NOW_ISO));
const OPTS: ApplyOptions = { receiptNs: NOW_NS, prefix: PREFIX, nowNs: NOW_NS };
const ALICE_JOINED = '2025-01-01T00:00:00Z';
const BOB_JOINED = '2025-06-01T00:00:00Z';
const API_KEY = 'pano-test-key';
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden');

const unix = (iso: string) => Date.parse(iso) / 1000;
const storage = (iso: string) => toStorage(fromMs(Date.parse(iso)));

// ---------------------------------------------------------------------------
// Seeding

function seedUser(db: Db, did: string, handle: string, joined: string, username: string | null): void {
  const gen = db.one<{ g: number }>(
    'UPDATE backfill_generation SET last_generation = last_generation + 1 WHERE singleton = 1 RETURNING last_generation AS g',
  )!.g;
  db.run(
    `INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, ?, 1, 'active', 'current', ?)`,
    did,
    handle,
    storage(joined),
    gen,
  );
  if (username !== null) {
    db.run(
      'INSERT INTO accounts(did, username, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)',
      did,
      username,
      Date.parse(joined),
      Date.parse(joined),
    );
  }
}

async function apply(db: Db, repo: SignedRepo, collection: string, rkey: string): Promise<string> {
  const car = await repo.getRecordCar(collection, rkey);
  const proof = await verifyRecordProof(car, { did: repo.did, collection, rkey, signingKey: repo.key.didKey });
  return db.tx(() => applyRecordProof(db, proof, OPTS)).outcome;
}

async function put(db: Db, repo: SignedRepo, collection: string, rkey: string, record: Record<string, unknown>) {
  await repo.put(collection, rkey, record);
  expect(await apply(db, repo, collection, rkey)).toBe('applied');
}

const followRkey = (subject: string) => `f${createHash('sha256').update(subject).digest('hex')}`;

/** Alice and Bob with their fixture listens, Alice → Bob; Carol has an account and nothing else. */
async function seedFixture(db: Db) {
  seedUser(db, ALICE, 'alice.test', ALICE_JOINED, 'alice');
  seedUser(db, BOB, 'bob.test', BOB_JOINED, 'bob');
  seedUser(db, CAROL, 'carol.test', BOB_JOINED, 'carol');
  const keys = await fixtureKeys();
  const alice = new SignedRepo(ALICE, keys.alice, { clock: fixedClock() });
  const bob = new SignedRepo(BOB, keys.bob, { clock: fixedClock() });
  for (const s of fixture.scrobbles) {
    if (s.owner === ALICE) await put(db, alice, SCROBBLE, s.rkey, { ...s.record });
    else if (s.owner === BOB) await put(db, bob, SCROBBLE, s.rkey, { ...s.record });
  }
  await alice.delete(SCROBBLE, 'r08');
  expect(await apply(db, alice, SCROBBLE, 'r08')).toBe('absent');
  await put(db, alice, FOLLOW, followRkey(BOB), { $type: FOLLOW, subject: BOB, createdAt: '2026-01-10T00:00:00Z' });
  return { alice, bob };
}

function seedLove(db: Db, did: string, rkey: string, artist: string, track: string, createdAt: string): void {
  db.run(
    `INSERT INTO loves(uri, did, rkey, cid, artist, track, album, artist_key, track_key, recording_mbid, created_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
    `at://${did}/${LOVE}/${rkey}`,
    did,
    rkey,
    `bafyrei${rkey}`,
    artist,
    track,
    artistKey(artist),
    trackKey(artist, track)[1],
    storage(createdAt),
    storage(NOW_ISO),
  );
}

async function fixtureApp(): Promise<TestApp> {
  const app = await startApp({ routes: lastfmRoutes() });
  await seedFixture(app.db);
  return app;
}

// ---------------------------------------------------------------------------
// Requests

// biome-ignore lint/suspicious/noExplicitAny: parsed protocol bodies
type Json = Record<string, any>;

async function get(
  app: TestApp,
  params: Record<string, string>,
): Promise<{ status: number; body: Json; res: Response }> {
  const res = await app.fetch(`/2.0/?${new URLSearchParams({ api_key: API_KEY, format: 'json', ...params })}`);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Json, res };
}

async function getXml(app: TestApp, params: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await app.fetch(`/2.0/?${new URLSearchParams({ api_key: API_KEY, ...params })}`);
  return { status: res.status, text: await res.text() };
}

const names = (items: Json[]) => items.map((t) => t.name as string);

afterEach(async () => {
  await closeApps();
});

describe('Last.fm user read methods', () => {
  it('user.getRecentTracks for Alice lists r07, r01, r02 ... newest first with date.uts; limit 2 gives totalPages 4; the nowplaying row appears on page 1 only', async () => {
    const app = await fixtureApp();
    const all = await get(app, { method: 'user.getRecentTracks', user: 'alice' });
    expect(all.status).toBe(200);
    expect(all.res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const tracks = all.body.recenttracks.track as [Json, ...Json[]];
    expect(names(tracks)).toEqual([
      'No Surprises',
      'Jóga',
      'jóga',
      'Weird Fishes',
      'Karma Police',
      'Running Up That Hill',
      'Cloudbusting',
    ]);
    expect(tracks.map((t) => t.date.uts)).toEqual(
      [
        '2026-01-15T11:00:00Z',
        '2026-01-15T11:00:00Z',
        '2026-01-14T11:00:00Z',
        '2026-01-08T12:00:00Z',
        '2025-12-16T12:00:00Z',
        '2025-01-15T12:00:00Z',
        '2025-01-14T11:00:00Z',
      ].map((iso) => String(unix(iso))),
    );
    expect(tracks[0]).toMatchObject({
      artist: { mbid: '', '#text': 'Radiohead' },
      album: { mbid: '', '#text': 'OK Computer' },
      url: 'https://www.last.fm/music/Radiohead/_/No+Surprises',
      streamable: '0',
      date: { uts: '1768474800', '#text': '15 Jan 2026, 11:00' },
    });
    expect(tracks[0].image).toHaveLength(4);
    expect(all.body.recenttracks['@attr']).toEqual({
      user: 'alice',
      page: '1',
      perPage: '50',
      totalPages: '1',
      total: '7',
    });

    const paged = await get(app, { method: 'user.getRecentTracks', user: 'alice', limit: '2' });
    expect(paged.body.recenttracks['@attr']).toEqual({
      user: 'alice',
      page: '1',
      perPage: '2',
      totalPages: '4',
      total: '7',
    });
    expect(names(paged.body.recenttracks.track)).toEqual(['No Surprises', 'Jóga']);
    const last = await get(app, { method: 'user.getRecentTracks', user: 'alice', limit: '2', page: '4' });
    expect(names(last.body.recenttracks.track)).toEqual(['Cloudbusting']);

    // A current now-playing entry: prepended on page 1 only, in addition to limit, with no date.
    upsertNowPlaying(
      { db: app.db, clock: app.clock },
      { did: ALICE, artist: 'Portishead', track: 'Roads', album: 'Dummy', durationSeconds: 300, source: 'lastfm' },
    );
    const page1 = await get(app, { method: 'user.getRecentTracks', user: 'alice', limit: '2' });
    const p1 = page1.body.recenttracks.track as [Json, ...Json[]];
    expect(names(p1)).toEqual(['Roads', 'No Surprises', 'Jóga']);
    expect(p1[0]['@attr']).toEqual({ nowplaying: 'true' });
    expect(p1[0].date).toBeUndefined();
    expect(p1.slice(1).every((t) => t['@attr'] === undefined)).toBe(true);
    expect(page1.body.recenttracks['@attr']).toMatchObject({ perPage: '2', totalPages: '4', total: '7' });
    const page2 = await get(app, { method: 'user.getRecentTracks', user: 'alice', limit: '2', page: '2' });
    expect(names(page2.body.recenttracks.track)).toEqual(['jóga', 'Weird Fishes']);
    expect((page2.body.recenttracks.track as Json[]).some((t) => t['@attr']?.nowplaying)).toBe(false);
    const xml = await getXml(app, { method: 'user.getRecentTracks', user: 'alice', limit: '1' });
    expect(xml.text).toContain('<track nowplaying="true">');
    expect(xml.text.match(/<track nowplaying/g)).toHaveLength(1);

    // An account that does not share now playing shows none.
    app.db.run('UPDATE accounts SET share_now_playing = 0 WHERE did = ?', ALICE);
    const hidden = await get(app, { method: 'user.getRecentTracks', user: 'alice', limit: '2' });
    expect(names(hidden.body.recenttracks.track)).toEqual(['No Surprises', 'Jóga']);

    // limit is clamped to 200; a malformed one is 6.
    const big = await get(app, { method: 'user.getRecentTracks', user: 'alice', limit: '5000' });
    expect(big.body.recenttracks['@attr'].perPage).toBe('200');
    const bad = await get(app, { method: 'user.getRecentTracks', user: 'alice', limit: 'ten' });
    expect([bad.status, bad.body.error]).toEqual([400, 6]);
  });

  it('extended=1 returns artist objects and loved 0/1; from/to bounds are exclusive', async () => {
    const app = await fixtureApp();
    seedLove(app.db, ALICE, '3laaaaaaaaaa1', 'radiohead', 'NO SURPRISES', '2026-01-15T11:05:00Z');

    const ext = await get(app, { method: 'user.getRecentTracks', user: 'alice', limit: '3', extended: '1' });
    const tracks = ext.body.recenttracks.track as [Json, ...Json[]];
    expect(names(tracks)).toEqual(['No Surprises', 'Jóga', 'jóga']);
    expect(tracks[0].artist).toEqual({
      url: 'https://www.last.fm/music/Radiohead',
      name: 'Radiohead',
      image: ['small', 'medium', 'large', 'extralarge'].map((size) => ({ size, '#text': '' })),
      mbid: '',
    });
    expect(tracks.map((t) => t.loved)).toEqual(['1', '0', '0']);

    // §7.3: a valid sk names the caller, and the loved flags are the caller's.
    // Bob loves Jóga, which both of Alice's spellings (r01, r02) match by music key.
    seedLove(app.db, BOB, '3lbbbbbbbbbb1', 'Björk', 'Jóga', '2026-01-15T11:10:00Z');
    const bobSk = createSession(
      { db: app.db, clock: app.clock, random: seededRandom(11) },
      { did: BOB, apiKey: API_KEY },
    ).key;
    const extended = { method: 'user.getRecentTracks', user: 'alice', limit: '3', extended: '1' };
    const asBob = await get(app, { ...extended, sk: bobSk });
    expect(asBob.status).toBe(200);
    expect(asBob.body.recenttracks['@attr'].user).toBe('alice');
    const bobView = asBob.body.recenttracks.track as Json[];
    expect(names(bobView)).toEqual(['No Surprises', 'Jóga', 'jóga']);
    expect(bobView.map((t) => t.loved)).toEqual(['0', '1', '1']);
    // No sk, or an unknown one (ignored, never 9): the listed user's loves.
    const anon = await get(app, extended);
    expect((anon.body.recenttracks.track as Json[]).map((t) => t.loved)).toEqual(['1', '0', '0']);
    const stale = await get(app, { ...extended, sk: '0'.repeat(32) });
    expect(stale.status).toBe(200);
    expect((stale.body.recenttracks.track as Json[]).map((t) => t.loved)).toEqual(['1', '0', '0']);
    // The now-playing row follows the same rule.
    upsertNowPlaying(
      { db: app.db, clock: app.clock },
      { did: ALICE, artist: 'björk', track: 'JÓGA', album: null, durationSeconds: 300, source: 'lastfm' },
    );
    const npBob = (await get(app, { ...extended, sk: bobSk })).body.recenttracks.track as Json[];
    expect([npBob[0]!['@attr'], npBob[0]!.loved]).toEqual([{ nowplaying: 'true' }, '1']);
    const npAnon = (await get(app, extended)).body.recenttracks.track as Json[];
    expect([npAnon[0]!['@attr'], npAnon[0]!.loved]).toEqual([{ nowplaying: 'true' }, '0']);
    // Back to Alice's view for the plain-listing checks below.
    app.db.run('DELETE FROM now_playing');

    const plain = await get(app, { method: 'user.getRecentTracks', user: 'alice', limit: '3' });
    const p = plain.body.recenttracks.track as [Json, ...Json[]];
    expect(p[0].artist).toEqual({ mbid: '', '#text': 'Radiohead' });
    expect(p.every((t) => !('loved' in t))).toBe(true);

    // Exclusive bounds: from < uts < to.
    const r03 = String(unix('2026-01-08T12:00:00Z'));
    const r02 = String(unix('2026-01-14T11:00:00Z'));
    const between = await get(app, { method: 'user.getRecentTracks', user: 'alice', from: r03, to: r02 });
    expect(between.body.recenttracks.track).toEqual([]);
    expect(between.body.recenttracks['@attr']).toMatchObject({ total: '0', totalPages: '0' });
    const widened = await get(app, {
      method: 'user.getRecentTracks',
      user: 'alice',
      from: String(Number(r03) - 1),
      to: String(Number(r02) + 1),
    });
    expect(names(widened.body.recenttracks.track)).toEqual(['jóga', 'Weird Fishes']);
    expect(widened.body.recenttracks['@attr'].total).toBe('2');
    const fromOnly = await get(app, { method: 'user.getRecentTracks', user: 'alice', from: r03 });
    expect(names(fromOnly.body.recenttracks.track)).toEqual(['No Surprises', 'Jóga', 'jóga']);
    const badBound = await get(app, { method: 'user.getRecentTracks', user: 'alice', from: '-5' });
    expect([badBound.status, badBound.body.error]).toEqual([400, 6]);
  });

  it('user.getInfo for Alice reports playcount 7, artist_count 3, track_count 6 and registered.unixtime from joinedAt', async () => {
    const app = await fixtureApp();
    const joined = unix(ALICE_JOINED);
    const info = await get(app, { method: 'user.getInfo', user: 'alice' });
    expect(info.status).toBe(200);
    expect(info.body).toEqual({
      user: {
        name: 'alice',
        realname: '',
        url: `${TEST_PUBLIC_ORIGIN}/u/${ALICE}`,
        country: 'None',
        age: '0',
        gender: 'n',
        subscriber: '0',
        playcount: '7',
        artist_count: '3',
        track_count: '6',
        album_count: '4',
        playlists: '0',
        bootstrap: '0',
        registered: { unixtime: String(joined), '#text': joined },
        type: 'user',
        image: ['small', 'medium', 'large', 'extralarge'].map((size) => ({ size, '#text': '' })),
      },
    });
    const xml = await getXml(app, { method: 'user.getInfo', user: 'alice' });
    expect(xml.text).toContain(`<registered unixtime="${joined}">${joined}</registered>`);
    expect(xml.text).toContain('<playcount>7</playcount>');

    // The verified handle and the DID name the same user; Bob's counts are his own.
    const byHandle = await get(app, { method: 'user.getInfo', user: 'alice.test' });
    expect(byHandle.body.user.playcount).toBe('7');
    const byDid = await get(app, { method: 'user.getInfo', user: ALICE });
    expect(byDid.body.user.name).toBe('alice');
    const bob = await get(app, { method: 'user.getInfo', user: 'bob' });
    expect([bob.body.user.playcount, bob.body.user.artist_count, bob.body.user.registered.unixtime]).toEqual([
      '1',
      '1',
      String(unix(BOB_JOINED)),
    ]);

    // Unknown and inactive users are 6.
    const unknown = await get(app, { method: 'user.getInfo', user: 'nobody' });
    expect([unknown.status, unknown.body]).toEqual([400, { error: 6, message: 'User not found' }]);
    app.db.run('UPDATE users SET active = 0 WHERE did = ?', BOB);
    const inactive = await get(app, { method: 'user.getInfo', user: 'bob' });
    expect(inactive.body.error).toBe(6);
  });

  it('user.getLovedTracks, user.getFriends (accounts Alice follows: Bob) and library.getArtists return the expected rows', async () => {
    const app = await fixtureApp();
    seedLove(app.db, ALICE, '3laaaaaaaaaa1', 'Björk', 'Jóga', '2026-01-10T09:00:00Z');
    seedLove(app.db, ALICE, '3laaaaaaaaaa2', 'Radiohead', 'Reckoner', '2026-01-12T09:00:00Z');
    seedLove(app.db, BOB, '3lbbbbbbbbbb1', 'Portishead', 'Roads', '2026-01-14T09:00:00Z');

    const loved = await get(app, { method: 'user.getLovedTracks', user: 'alice' });
    expect(loved.status).toBe(200);
    const lt = loved.body.lovedtracks.track as Json[];
    expect(names(lt)).toEqual(['Reckoner', 'Jóga']);
    expect(lt[0]).toMatchObject({
      mbid: '',
      url: 'https://www.last.fm/music/Radiohead/_/Reckoner',
      date: { uts: String(unix('2026-01-12T09:00:00Z')), '#text': '12 Jan 2026, 09:00' },
      artist: { name: 'Radiohead', mbid: '', url: 'https://www.last.fm/music/Radiohead' },
      streamable: { fulltrack: '0', '#text': '0' },
    });
    expect(loved.body.lovedtracks['@attr']).toEqual({
      user: 'alice',
      page: '1',
      perPage: '50',
      totalPages: '1',
      total: '2',
    });
    const lovedPage = await get(app, { method: 'user.getLovedTracks', user: 'alice', limit: '1', page: '2' });
    expect(names(lovedPage.body.lovedtracks.track)).toEqual(['Jóga']);
    expect(lovedPage.body.lovedtracks['@attr']).toMatchObject({ totalPages: '2', total: '2' });

    const friends = await get(app, { method: 'user.getFriends', user: 'alice' });
    expect(friends.status).toBe(200);
    expect(friends.body.friends.user).toEqual([
      {
        name: 'bob',
        realname: '',
        image: ['small', 'medium', 'large', 'extralarge'].map((size) => ({ size, '#text': '' })),
        url: `${TEST_PUBLIC_ORIGIN}/u/${BOB}`,
        country: 'None',
        age: '0',
        gender: 'n',
        subscriber: '0',
        playcount: '1',
        playlists: '0',
        bootstrap: '0',
        registered: { unixtime: String(unix(BOB_JOINED)), '#text': String(unix(BOB_JOINED)) },
        type: 'user',
      },
    ]);
    expect(friends.body.friends['@attr']).toEqual({
      user: 'alice',
      page: '1',
      perPage: '50',
      totalPages: '1',
      total: '1',
    });
    const bobsFriends = await get(app, { method: 'user.getFriends', user: 'bob' });
    expect(bobsFriends.body.friends.user).toEqual([]);

    const artists = await get(app, { method: 'library.getArtists', user: 'alice' });
    expect(artists.status).toBe(200);
    const a = artists.body.artists.artist as Json[];
    expect(a.map((x) => [x.name, x.playcount])).toEqual([
      ['Radiohead', '3'],
      ['Björk', '2'],
      ['Kate Bush', '2'],
    ]);
    expect(a[1]).toMatchObject({
      tagcount: '0',
      mbid: '',
      url: 'https://www.last.fm/music/Bj%C3%B6rk',
      streamable: '0',
    });
    expect(artists.body.artists['@attr']).toEqual({
      user: 'alice',
      page: '1',
      perPage: '50',
      totalPages: '1',
      total: '3',
    });
    const second = await get(app, { method: 'library.getArtists', user: 'alice', limit: '2', page: '2' });
    expect(names(second.body.artists.artist)).toEqual(['Kate Bush']);
    expect(second.body.artists['@attr']).toMatchObject({ perPage: '2', totalPages: '2', total: '3' });
  });

  it("user.getTrackScrobbles for Alice and one track lists only that track's listens newest first and matches its XML and JSON goldens", async () => {
    const app = await fixtureApp();
    const golden = (name: string, ext: 'xml' | 'json') => readFileSync(join(GOLDEN, `${name}.${ext}`), 'utf8');

    const xml = await getXml(app, { method: 'user.getTrackScrobbles', user: 'alice', artist: 'Björk', track: 'Jóga' });
    expect(xml.status).toBe(200);
    expect(xml.text).toBe(golden('user.getTrackScrobbles-alice', 'xml'));
    const json = await get(app, { method: 'user.getTrackScrobbles', user: 'alice', artist: 'Björk', track: 'Jóga' });
    expect(json.body).toStrictEqual(JSON.parse(golden('user.getTrackScrobbles-alice', 'json')));
    // Every spelling of the track counts; only that track's listens appear.
    const variant = await get(app, {
      method: 'user.getTrackScrobbles',
      user: 'alice',
      artist: ' BJÖRK',
      track: 'JÓGA',
    });
    expect(variant.body).toStrictEqual(json.body);
    expect(names(json.body.trackscrobbles.track).every((n) => n.toLowerCase() === 'jóga')).toBe(true);

    // A track Alice never played: the empty golden (a list, never an object).
    const none = await getXml(app, {
      method: 'user.getTrackScrobbles',
      user: 'alice',
      artist: 'Radiohead',
      track: 'Creep',
    });
    expect(none.text).toBe(golden('user.getTrackScrobbles-0', 'xml'));
    const noneJson = await get(app, {
      method: 'user.getTrackScrobbles',
      user: 'alice',
      artist: 'Radiohead',
      track: 'Creep',
    });
    expect(noneJson.body).toStrictEqual(JSON.parse(golden('user.getTrackScrobbles-0', 'json')));

    // artist and track are required.
    const missing = await get(app, { method: 'user.getTrackScrobbles', user: 'alice', artist: 'Björk' });
    expect([missing.status, missing.body.error]).toEqual([400, 6]);
  });

  it('a Pano-shaped decoder (PageEntries with a required list and @attr) parses user.getRecentTracks, user.getLovedTracks, user.getTopTracks and user.getFriends JSON for a user with zero listens and with exactly one listen', async () => {
    const app = await fixtureApp();
    // Bob: exactly one listen (r09), one love and one follow. Carol: nothing at all.
    seedLove(app.db, BOB, '3lbbbbbbbbbb1', 'Massive Attack', 'Teardrop', '2026-01-15T11:31:00Z');
    const keys = await fixtureKeys();
    const bobRepo = new SignedRepo(BOB, keys.bob, { clock: fixedClock() });
    await put(app.db, bobRepo, FOLLOW, followRkey(ALICE), {
      $type: FOLLOW,
      subject: ALICE,
      createdAt: '2026-01-11T00:00:00Z',
    });

    // Pano's PageEntries<T>: `{<item>: List<T>, "@attr": PageAttr}` with no
    // single-object fallback; PageAttr fields are strings; T needs its fields.
    const decodePage = (body: Json, root: string, item: string, decodeItem: (v: Json) => string): string[] => {
      const container = body[root];
      if (container === null || typeof container !== 'object') throw new Error(`${root}: not an object`);
      const entries = container[item];
      if (!Array.isArray(entries)) throw new Error(`${root}.${item}: not a list`);
      const attr = container['@attr'];
      for (const k of ['user', 'page', 'perPage', 'totalPages', 'total']) {
        if (typeof attr?.[k] !== 'string') throw new Error(`${root}.@attr.${k}: missing string`);
      }
      if (Number(attr.total) !== entries.length) throw new Error(`${root}: total ${attr.total} != ${entries.length}`);
      return entries.map(decodeItem);
    };
    const str = (v: unknown, what: string): string => {
      if (typeof v !== 'string') throw new Error(`${what}: not a string`);
      return v;
    };
    const imagesOf = (v: Json) => {
      if (!Array.isArray(v.image) || v.image.some((i: Json) => typeof i['#text'] !== 'string'))
        throw new Error('image');
    };
    const track = (v: Json) => {
      imagesOf(v);
      const artist = str(v.artist?.['#text'] ?? v.artist?.name, 'artist');
      return `${artist} - ${str(v.name, 'name')}`;
    };
    const friend = (v: Json) => {
      imagesOf(v);
      str(v.url, 'url');
      return str(v.name, 'name');
    };
    const cases = [
      ['user.getRecentTracks', 'recenttracks', 'track', track],
      ['user.getLovedTracks', 'lovedtracks', 'track', track],
      ['user.getTopTracks', 'toptracks', 'track', track],
      ['user.getFriends', 'friends', 'user', friend],
    ] as const;

    for (const [method, root, item, decode] of cases) {
      const zero = await get(app, { method, user: 'carol' });
      expect(zero.status, method).toBe(200);
      expect(decodePage(zero.body, root, item, decode), method).toEqual([]);
      expect(zero.body[root][item], method).toEqual([]);

      const one = await get(app, { method, user: 'bob' });
      expect(one.status, method).toBe(200);
      expect(Array.isArray(one.body[root][item]), method).toBe(true);
      expect(decodePage(one.body, root, item, decode), method).toEqual([
        method === 'user.getFriends' ? 'alice' : 'Massive Attack - Teardrop',
      ]);
    }
  });
});
