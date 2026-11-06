// N3-04: the Last.fm 2.0 entity read methods over HTTP (ADR 0005 §7.5, §7.9,
// §10.2): track.getInfo, artist.getInfo, album.getInfo and the getTopTags
// family.
//
// Alice's and Bob's fixture listens go through the production verifier and
// apply path, plus one extra signed listen of Bob's: Björk / Jóga at
// 2026-01-13T10:00Z with durationSeconds 305 and a recordingMbid. So Jóga has
// 3 listens (r01, r02, Bob's) by 2 listeners, and its newest listen with a
// duration is Bob's (305 s → "305000" ms). Alice loves Jóga (seeded directly:
// the love projection is N3-11's).

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { artistKey, trackKey } from '@atmusic/core/music-key';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { Db } from '../../../src/do/db';
import { type ApplyOptions, applyRecordProof } from '../../../src/do/write/apply-record';
import { lastfmRoutes } from '../../../src/lastfm/routes';
import { closeApps, startApp, type TestApp } from '../support/app';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
const ALICE = fixture.users.Alice.did;
const BOB = fixture.users.Bob.did;
const NOW_NS = fromMs(Date.parse('2026-01-15T12:00:00Z'));
const OPTS: ApplyOptions = { receiptNs: NOW_NS, prefix: PREFIX, nowNs: NOW_NS };
const API_KEY = 'entity-test-key';
const JOGA_MBID = '3c4f9c1e-5a2b-4d8e-9f10-2a7c3b9d0e45';

function seedUser(db: Db, did: string, handle: string, username: string): void {
  const gen = db.one<{ g: number }>(
    'UPDATE backfill_generation SET last_generation = last_generation + 1 WHERE singleton = 1 RETURNING last_generation AS g',
  )!.g;
  db.run(
    `INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, ?, 1, 'active', 'current', ?)`,
    did,
    handle,
    toStorage(NOW_NS),
    gen,
  );
  db.run('INSERT INTO accounts(did, username, created_at_ms, updated_at_ms) VALUES (?, ?, 1, 1)', did, username);
}

async function put(db: Db, repo: SignedRepo, rkey: string, record: Record<string, unknown>): Promise<void> {
  await repo.put(SCROBBLE, rkey, record);
  const proof = await verifyRecordProof(await repo.getRecordCar(SCROBBLE, rkey), {
    did: repo.did,
    collection: SCROBBLE,
    rkey,
    signingKey: repo.key.didKey,
  });
  expect(db.tx(() => applyRecordProof(db, proof, OPTS)).outcome).toBe('applied');
}

async function entityApp(): Promise<TestApp> {
  const app = await startApp({ routes: lastfmRoutes() });
  const db = app.db;
  seedUser(db, ALICE, 'alice.test', 'alice');
  seedUser(db, BOB, 'bob.test', 'bob');
  const keys = await fixtureKeys();
  const repos = {
    [ALICE]: new SignedRepo(ALICE, keys.alice, { clock: fixedClock() }),
    [BOB]: new SignedRepo(BOB, keys.bob, { clock: fixedClock() }),
  };
  for (const s of fixture.scrobbles) {
    const repo = repos[s.owner];
    if (repo !== undefined && s.state === 'confirmed') await put(db, repo, s.rkey, { ...s.record });
  }
  await put(db, repos[BOB]!, 'b1', {
    $type: SCROBBLE,
    artist: 'Björk',
    track: 'Jóga',
    album: 'Homogenic',
    listenedAt: '2026-01-13T10:00:00Z',
    createdAt: '2026-01-13T10:00:00Z',
    durationSeconds: 305,
    recordingMbid: JOGA_MBID,
  });
  db.run(
    `INSERT INTO loves(uri, did, rkey, cid, artist, track, album, artist_key, track_key, recording_mbid, created_at, indexed_at)
     VALUES (?, ?, '3laaaaaaaaaa1', 'bafyreilove', 'BJÖRK', 'jóga', NULL, ?, ?, NULL, ?, ?)`,
    `at://${ALICE}/${PREFIX}.love/3laaaaaaaaaa1`,
    ALICE,
    artistKey('BJÖRK'),
    trackKey('BJÖRK', 'jóga')[1],
    toStorage(NOW_NS),
    toStorage(NOW_NS),
  );
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

describe('Last.fm entity read methods', () => {
  it('track.getInfo with username returns duration in ms, listeners, playcount, userplaycount and userloved; an unknown track gives 6', async () => {
    const app = await entityApp();
    const alice = await get(app, { method: 'track.getInfo', artist: 'Björk', track: 'Jóga', username: 'alice' });
    expect(alice.status).toBe(200);
    expect(alice.body.track).toMatchObject({
      name: 'Jóga',
      url: 'https://www.last.fm/music/Bj%C3%B6rk/_/J%C3%B3ga',
      duration: '305000',
      listeners: '2',
      playcount: '3',
      userplaycount: '2',
      userloved: '1',
      artist: { name: 'Björk', mbid: '', url: 'https://www.last.fm/music/Bj%C3%B6rk' },
      album: { artist: 'Björk', title: 'Homogenic', mbid: '', url: 'https://www.last.fm/music/Bj%C3%B6rk/Homogenic' },
      toptags: { tag: [] },
    });
    // The newest listen (r01, Alice's) carries no recordingMbid.
    expect(alice.body.track.mbid).toBe('');

    // Another spelling, another user: the same track; Bob listened once and loves nothing.
    const bob = await get(app, { method: 'track.getInfo', artist: '  björk ', track: 'JÓGA', username: 'bob' });
    expect([bob.body.track.playcount, bob.body.track.userplaycount, bob.body.track.userloved]).toEqual(['3', '1', '0']);
    // Without username there is no user context.
    const anon = await get(app, { method: 'track.getInfo', artist: 'Björk', track: 'Jóga' });
    expect(anon.body.track.userplaycount).toBeUndefined();
    expect(anon.body.track.userloved).toBeUndefined();
    // By recording MBID.
    const byMbid = await get(app, { method: 'track.getInfo', mbid: JOGA_MBID });
    expect([byMbid.body.track.name, byMbid.body.track.playcount]).toEqual(['Jóga', '3']);
    // A track without a duration reports "0".
    const noDuration = await get(app, { method: 'track.getInfo', artist: 'Radiohead', track: 'Karma Police' });
    expect([noDuration.body.track.duration, noDuration.body.track.listeners]).toEqual(['0', '1']);

    // Unknown tracks (and names without a music key: over 256 scalars) are 6 with Last.fm's message.
    for (const params of [
      { artist: 'Björk', track: 'Army of Me' } as Record<string, string>,
      { artist: 'x'.repeat(300), track: 'Jóga' },
      { mbid: '00000000-0000-4000-8000-000000000000' },
    ]) {
      const res = await get(app, { method: 'track.getInfo', ...params });
      expect([res.status, res.body], JSON.stringify(params)).toEqual([400, { error: 6, message: 'Track not found' }]);
    }
    const missing = await get(app, { method: 'track.getInfo', artist: 'Björk' });
    expect([missing.status, missing.body.error]).toEqual([400, 6]);
    const unknownUser = await get(app, { method: 'track.getInfo', artist: 'Björk', track: 'Jóga', username: 'nobody' });
    expect(unknownUser.body).toEqual({ error: 6, message: 'User not found' });
  });

  it('artist.getInfo and album.getInfo report stats over every listener and the getTopTags family answers empty lists', async () => {
    const app = await entityApp();
    const artist = await get(app, { method: 'artist.getInfo', artist: 'radiohead', username: 'alice' });
    expect(artist.status).toBe(200);
    expect(artist.body.artist).toMatchObject({
      name: 'Radiohead',
      url: 'https://www.last.fm/music/Radiohead',
      stats: { listeners: '1', playcount: '3', userplaycount: '3' },
      similar: { artist: [] },
      tags: { tag: [] },
      bio: { summary: '', content: '' },
    });
    const bjork = await get(app, { method: 'artist.getInfo', artist: 'Björk', username: 'bob' });
    expect(bjork.body.artist.stats).toEqual({ listeners: '2', playcount: '3', userplaycount: '1' });
    const noArtist = await get(app, { method: 'artist.getInfo', artist: 'Nobody' });
    expect(noArtist.body).toEqual({ error: 6, message: 'The artist you supplied could not be found' });

    const album = await get(app, {
      method: 'album.getInfo',
      artist: 'Radiohead',
      album: 'ok computer',
      username: 'alice',
    });
    expect(album.status).toBe(200);
    expect(album.body.album).toMatchObject({
      name: 'OK Computer',
      artist: 'Radiohead',
      listeners: '1',
      playcount: '2',
      userplaycount: '2',
      stats: { listeners: '1', playcount: '2', userplaycount: '2' },
      url: 'https://www.last.fm/music/Radiohead/OK+Computer',
    });
    expect((album.body.album.tracks.track as Json[]).map((t) => [t.name, t['@attr'].rank])).toEqual([
      ['Karma Police', '1'],
      ['No Surprises', '2'],
    ]);
    const homogenic = await get(app, { method: 'album.getInfo', artist: 'Björk', album: 'Homogenic' });
    expect([homogenic.body.album.playcount, homogenic.body.album.listeners]).toEqual(['3', '2']);
    expect(homogenic.body.album.tracks.track).toHaveLength(1);
    const noAlbum = await get(app, { method: 'album.getInfo', artist: 'Radiohead', album: 'Kid A' });
    expect(noAlbum.body).toEqual({ error: 6, message: 'Album not found' });

    const userTags = await get(app, { method: 'user.getTopTags', user: 'alice' });
    expect(userTags.body).toEqual({ toptags: { tag: [], '@attr': { user: 'alice' } } });
    const trackTags = await get(app, { method: 'track.getTopTags', artist: 'Björk', track: 'Jóga' });
    expect(trackTags.body).toEqual({ toptags: { tag: [], '@attr': { artist: 'Björk', track: 'Jóga' } } });
    const artistTags = await get(app, { method: 'artist.getTopTags', artist: 'Björk' });
    expect(artistTags.body).toEqual({ toptags: { tag: [], '@attr': { artist: 'Björk' } } });
    const albumTags = await get(app, { method: 'album.getTopTags', artist: 'Björk', album: 'Homogenic' });
    expect(albumTags.body).toEqual({ toptags: { tag: [], '@attr': { artist: 'Björk', album: 'Homogenic' } } });
    const xml = await (
      await app.fetch(`/2.0/?${new URLSearchParams({ api_key: API_KEY, method: 'user.getTopTags', user: 'alice' })}`)
    ).text();
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="ok">\n  <toptags user="alice"/>\n</lfm>\n');
    const unknownUserTags = await get(app, { method: 'user.getTopTags', user: 'nobody' });
    expect(unknownUserTags.body.error).toBe(6);
  });
});
