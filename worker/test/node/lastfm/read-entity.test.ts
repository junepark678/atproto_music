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
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { Db, SqlParam } from '../../../src/do/db';
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

  it('track.getInfo fills only missing recording MBID and duration from a local matched row', async () => {
    const app = await entityApp();
    const keys = [artistKey('Björk'), trackKey('Björk', 'Jóga')[1]];
    const albumKey =
      app.db.one<{ album_key: string | null }>(
        'SELECT album_key FROM scrobbles WHERE artist_key=? AND track_key=? ORDER BY listened_at DESC LIMIT 1',
        ...keys,
      )?.album_key ?? '';
    app.db.run(
      'UPDATE scrobbles SET recording_mbid=NULL,duration_seconds=NULL WHERE artist_key=? AND track_key=?',
      ...keys,
    );
    app.db.run(
      `UPDATE mb_tracks SET status='matched',recording_mbid=?,title='Jóga',artist_credit='Björk',duration_ms=240000
      WHERE artist_key=? AND track_key=? AND album_key=?`,
      JOGA_MBID,
      ...keys,
      albumKey,
    );
    const filled = await get(app, { method: 'track.getInfo', artist: 'Björk', track: 'Jóga' });
    expect([filled.body.track.mbid, filled.body.track.duration]).toEqual([JOGA_MBID, '240000']);

    app.db.run(
      'UPDATE scrobbles SET recording_mbid=?,duration_seconds=305 WHERE artist_key=? AND track_key=? AND album_key=?',
      '00000000-0000-4000-8000-000000000111',
      ...keys,
      albumKey,
    );
    const retained = await get(app, { method: 'track.getInfo', artist: 'Björk', track: 'Jóga' });
    expect([retained.body.track.mbid, retained.body.track.duration]).toEqual([
      '00000000-0000-4000-8000-000000000111',
      '305000',
    ]);

    const unmatched = await get(app, { method: 'track.getInfo', artist: 'Radiohead', track: 'Karma Police' });
    expect([unmatched.body.track.mbid, unmatched.body.track.duration]).toEqual(['', '0']);
  });

  it('resolves name-reported local MBIDs back to the same visible entity and stats', async () => {
    const app = await entityApp();
    const trackMbid = '66666666-6666-4666-8666-666666666666';
    const artistMbid = '77777777-7777-4777-8777-777777777777';
    const releaseMbid = '88888888-8888-4888-8888-888888888888';
    const [bak, btk] = trackKey('Björk', 'Jóga');
    const albumKey = app.db.one<{ album_key: string }>(
      'SELECT album_key FROM scrobbles WHERE artist_key=? AND track_key=? ORDER BY listened_at DESC,uri DESC LIMIT 1',
      bak,
      btk,
    )!.album_key;
    app.db.run('UPDATE scrobbles SET recording_mbid=NULL WHERE artist_key=? AND track_key=?', bak, btk);
    app.db.run(
      "UPDATE mb_tracks SET status='matched',recording_mbid=? WHERE artist_key=? AND track_key=? AND album_key=?",
      trackMbid,
      bak,
      btk,
      albumKey,
    );
    const byNameTrack = await get(app, { method: 'track.getInfo', artist: 'Björk', track: 'Jóga', username: 'alice' });
    const byIdTrack = await get(app, { method: 'track.getInfo', mbid: trackMbid, username: 'alice' });
    expect(byNameTrack.body.track.mbid).toBe(trackMbid);
    expect(byIdTrack.body.track).toMatchObject({
      name: byNameTrack.body.track.name,
      playcount: byNameTrack.body.track.playcount,
      listeners: byNameTrack.body.track.listeners,
      userplaycount: byNameTrack.body.track.userplaycount,
    });

    const [rTrackAk, rTrackTk] = trackKey('Radiohead', 'Karma Police');
    const rTrackAlbumKey = app.db.one<{ album_key: string }>(
      'SELECT album_key FROM scrobbles WHERE artist_key=? AND track_key=? ORDER BY listened_at DESC,uri DESC LIMIT 1',
      rTrackAk,
      rTrackTk,
    )!.album_key;
    app.db.run(
      "UPDATE mb_tracks SET status='matched',recording_mbid=? WHERE artist_key=? AND track_key=? AND album_key=?",
      trackMbid,
      rTrackAk,
      rTrackTk,
      rTrackAlbumKey,
    );
    const otherCanonicalName = await get(app, { method: 'track.getInfo', artist: 'Radiohead', track: 'Karma Police' });
    const newestCanonicalId = await get(app, { method: 'track.getInfo', mbid: trackMbid });
    expect(otherCanonicalName.body.track.mbid).toBe(trackMbid);
    expect(newestCanonicalId.body.track.name).toBe('Jóga');
    expect(newestCanonicalId.body.track.playcount).toBe(byNameTrack.body.track.playcount);

    const rak = artistKey('Radiohead');
    const radioAlbumKey = app.db.one<{ album_key: string }>(
      "SELECT album_key FROM scrobbles WHERE artist='Radiohead' AND album='OK Computer' LIMIT 1",
    )!.album_key;
    app.db.run(
      "UPDATE mb_tracks SET status='matched',artist_mbids=? WHERE artist_key=? AND album_key=?",
      JSON.stringify([artistMbid]),
      rak,
      radioAlbumKey,
    );
    const byNameArtist = await get(app, { method: 'artist.getInfo', artist: 'Radiohead', username: 'alice' });
    const byIdArtist = await get(app, { method: 'artist.getInfo', mbid: artistMbid, username: 'alice' });
    expect(byNameArtist.body.artist.mbid).toBe(artistMbid);
    expect(byIdArtist.body.artist.stats).toEqual(byNameArtist.body.artist.stats);

    app.db.run(
      "UPDATE mb_tracks SET status='matched',release_mbid=? WHERE artist_key=? AND album_key=?",
      releaseMbid,
      rak,
      radioAlbumKey,
    );
    const byNameAlbum = await get(app, {
      method: 'album.getInfo',
      artist: 'Radiohead',
      album: 'OK Computer',
      username: 'alice',
    });
    const byIdAlbum = await get(app, { method: 'album.getInfo', mbid: releaseMbid, username: 'alice' });
    expect(byNameAlbum.body.album.mbid).toBe(releaseMbid);
    expect(byIdAlbum.body.album).toMatchObject({
      artist: byNameAlbum.body.album.artist,
      playcount: byNameAlbum.body.album.playcount,
      listeners: byNameAlbum.body.album.listeners,
      userplaycount: byNameAlbum.body.album.userplaycount,
    });
    expect(byIdAlbum.body.album.tracks.track).toHaveLength(byNameAlbum.body.album.tracks.track.length);
  });

  it('resolves an artist MBID emitted by artist.getInfo back through artist.getInfo', async () => {
    const app = await entityApp();
    const mbid = '66666666-6666-4666-8666-666666666667';
    const key = artistKey('Radiohead');
    const albumKey = app.db.one<{ album_key: string }>(
      "SELECT album_key FROM scrobbles WHERE artist='Radiohead' AND album='OK Computer' LIMIT 1",
    )!.album_key;
    app.db.run(
      "UPDATE mb_tracks SET status='matched',artist_mbids=? WHERE artist_key=? AND album_key=?",
      JSON.stringify([mbid]),
      key,
      albumKey,
    );
    expect((await get(app, { method: 'artist.getInfo', artist: 'Radiohead' })).body.artist.mbid).toBe(mbid);
    expect((await get(app, { method: 'artist.getInfo', mbid })).status).toBe(200);
  });

  it('resolves a release MBID emitted by album.getInfo back through album.getInfo', async () => {
    const app = await entityApp();
    const mbid = '66666666-6666-4666-8666-666666666668';
    const key = artistKey('Radiohead');
    const albumKey = app.db.one<{ album_key: string }>(
      "SELECT album_key FROM scrobbles WHERE artist='Radiohead' AND album='OK Computer' LIMIT 1",
    )!.album_key;
    app.db.run(
      "UPDATE mb_tracks SET status='matched',release_mbid=? WHERE artist_key=? AND album_key=?",
      mbid,
      key,
      albumKey,
    );
    expect(
      (await get(app, { method: 'album.getInfo', artist: 'Radiohead', album: 'OK Computer' })).body.album.mbid,
    ).toBe(mbid);
    expect((await get(app, { method: 'album.getInfo', mbid })).status).toBe(200);
  });

  it('keeps compilation album groups distinct, rejects disputed cache aliases, and ignores inactive-only evidence', async () => {
    const app = await entityApp();
    const vaMbid = '99999999-9999-4999-8999-999999999991';
    const ownMbid = '99999999-9999-4999-8999-999999999992';
    const vaKey = artistKey('Various Artists');
    const [bak, btk] = trackKey('Björk', 'Jóga');
    const [rak, rtk] = trackKey('Radiohead', 'Karma Police');
    for (const [ak, tk, title, groupKey] of [
      [bak, btk, 'Björk', vaKey],
      [rak, rtk, 'Radiohead', rak],
    ] as const) {
      app.db.run(
        'UPDATE scrobbles SET album=?,album_key=?,album_artist=?,album_artist_key=?,release_mbid=NULL WHERE artist_key=? AND track_key=?',
        'Hits',
        'hits',
        title === 'Björk' ? 'Various Artists' : null,
        groupKey,
        ak,
        tk,
      );
    }
    app.db.run(
      "UPDATE mb_tracks SET status='matched',album_key='hits',release_mbid=? WHERE artist_key=? AND track_key=?",
      vaMbid,
      bak,
      btk,
    );
    app.db.run(
      "UPDATE mb_tracks SET status='matched',album_key='hits',release_mbid=? WHERE artist_key=? AND track_key=?",
      ownMbid,
      rak,
      rtk,
    );
    const va = await get(app, { method: 'album.getInfo', mbid: vaMbid });
    const own = await get(app, { method: 'album.getInfo', mbid: ownMbid });
    expect([va.body.album.artist, own.body.album.artist]).toEqual(['Various Artists', 'Radiohead']);

    const disputed = '99999999-9999-4999-8999-999999999993';
    app.db.run(
      "UPDATE mb_tracks SET status='matched',artist_mbids=? WHERE artist_key=? AND album_key='hits'",
      JSON.stringify([disputed]),
      bak,
    );
    app.db.run(
      "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,artist_mbids,created_at_ms) VALUES(?,?,'hits','matched',?,1)",
      bak,
      trackKey('Björk', 'Other Track')[1],
      JSON.stringify(['99999999-9999-4999-8999-999999999994']),
    );
    const disputedByName = await get(app, { method: 'artist.getInfo', artist: 'Björk' });
    const disputedById = await get(app, { method: 'artist.getInfo', mbid: disputed });
    expect(disputedByName.body.artist.mbid).toBe('');
    expect(disputedById.body.error).toBe(6);

    const hiddenMbid = '99999999-9999-4999-8999-999999999995';
    const [kak, ktk] = trackKey('Radiohead', 'Karma Police');
    app.db.run('UPDATE scrobbles SET recording_mbid=NULL WHERE artist_key=? AND track_key=?', kak, ktk);
    app.db.run(
      "UPDATE mb_tracks SET status='matched',recording_mbid=? WHERE artist_key=? AND track_key=? AND album_key='hits'",
      hiddenMbid,
      kak,
      ktk,
    );
    app.db.run('UPDATE users SET active=0 WHERE did=?', ALICE);
    app.db.run('UPDATE users SET active=0 WHERE did=?', BOB);
    const hiddenByInactive = await get(app, { method: 'track.getInfo', mbid: hiddenMbid });
    expect([hiddenByInactive.status, hiddenByInactive.body.error]).toEqual([400, 6]);

    app.db.run('UPDATE users SET active=1 WHERE did=?', ALICE);
    app.db.run('UPDATE users SET active=1 WHERE did=?', BOB);
    app.db.run(
      "INSERT INTO suppression(did,suppressed_at) VALUES(?,'2026-01-15T12:00:00Z'),(?,'2026-01-15T12:00:00Z')",
      ALICE,
      BOB,
    );
    const hiddenBySuppression = await get(app, { method: 'track.getInfo', mbid: hiddenMbid });
    expect([hiddenBySuppression.status, hiddenBySuppression.body.error]).toEqual([400, 6]);

    app.db.run('DELETE FROM suppression WHERE did IN (?,?)', ALICE, BOB);
    const affected = app.db.all<{ did: string; rkey: string }>(
      'SELECT DISTINCT did,rkey FROM scrobbles WHERE artist_key=? AND track_key=?',
      kak,
      ktk,
    );
    for (const row of affected) {
      app.db.run(
        `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms)
         VALUES(?,?,'scrobble.delete','web',0,?,?,'queued',1,1,1)`,
        `hidden-${row.did}-${row.rkey}`,
        row.did,
        SCROBBLE,
        row.rkey,
      );
    }
    const hiddenByQueuedDelete = await get(app, { method: 'track.getInfo', mbid: hiddenMbid });
    expect([hiddenByQueuedDelete.status, hiddenByQueuedDelete.body.error]).toEqual([400, 6]);
  });

  it('artist and album info fill missing MBIDs only when local matches agree, preserving submitted IDs', async () => {
    const app = await entityApp();
    const artistMbid = '11111111-1111-4111-8111-111111111111';
    const releaseMbid = '22222222-2222-4222-8222-222222222222';
    const ak = artistKey('Radiohead');
    const albumKey = app.db.one<{ album_key: string }>(
      "SELECT album_key FROM scrobbles WHERE artist='Radiohead' AND album='OK Computer' LIMIT 1",
    )!.album_key;
    app.db.run(
      "UPDATE mb_tracks SET status='matched',artist_mbids=?,release_mbid=? WHERE artist_key=? AND album_key=?",
      JSON.stringify([artistMbid]),
      releaseMbid,
      ak,
      albumKey,
    );
    expect((await get(app, { method: 'artist.getInfo', artist: 'Radiohead' })).body.artist.mbid).toBe(artistMbid);
    expect(
      (await get(app, { method: 'album.getInfo', artist: 'Radiohead', album: 'OK Computer' })).body.album.mbid,
    ).toBe(releaseMbid);

    const other = '33333333-3333-4333-8333-333333333333';
    app.db.run(
      'UPDATE mb_tracks SET artist_mbids=? WHERE artist_key=? AND track_key<>?',
      JSON.stringify([other]),
      ak,
      trackKey('Radiohead', 'Karma Police')[1],
    );
    expect((await get(app, { method: 'artist.getInfo', artist: 'Radiohead' })).body.artist.mbid).toBe('');
    app.db.run("UPDATE scrobbles SET release_mbid=? WHERE artist='Radiohead' AND album='OK Computer'", other);
    expect(
      (await get(app, { method: 'album.getInfo', artist: 'Radiohead', album: 'OK Computer' })).body.album.mbid,
    ).toBe(other);
  });

  it('scopes release fallback to the artist and shared album title tuple on track and album reads', async () => {
    const app = await entityApp();
    const releaseForBjork = '44444444-4444-4444-8444-444444444444';
    const releaseForRadiohead = '55555555-5555-4555-8555-555555555555';
    const sharedAlbumKey = 'greatest hits';
    const cases = [
      { artist: 'Björk', track: 'Jóga', release: releaseForBjork },
      { artist: 'Radiohead', track: 'Karma Police', release: releaseForRadiohead },
    ];
    for (const item of cases) {
      const [ak, tk] = trackKey(item.artist, item.track);
      app.db.run(
        'UPDATE scrobbles SET album=?,album_key=?,release_mbid=NULL WHERE artist_key=? AND track_key=?',
        'Greatest Hits',
        sharedAlbumKey,
        ak,
        tk,
      );
      app.db.run(
        `UPDATE mb_tracks SET status='matched',album_key=?,release_mbid=? WHERE artist_key=? AND track_key=?`,
        sharedAlbumKey,
        item.release,
        ak,
        tk,
      );
    }
    for (const item of cases) {
      const track = await get(app, { method: 'track.getInfo', artist: item.artist, track: item.track });
      const album = await get(app, { method: 'album.getInfo', artist: item.artist, album: 'Greatest Hits' });
      expect(track.body.track.album.mbid).toBe(item.release);
      expect(album.body.album.mbid).toBe(item.release);
    }
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

const M = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const N = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function compilation(mode: string) {
  const app = await entityApp();
  const keys = await fixtureKeys();
  for (const [did, key, artist, rkey, time] of [
    [ALICE, keys.alice, 'Probe A', 'probea', '2026-01-14T10:00:00Z'],
    [BOB, keys.bob, 'Probe B', 'probeb', '2026-01-14T11:00:00Z'],
  ] as const) {
    await put(app.db, new SignedRepo(did, key, { clock: fixedClock('2026-01-15T12:00:01Z') }), rkey, {
      $type: SCROBBLE,
      artist,
      track: 'Probe Song',
      album: 'Probe Hits',
      albumArtist: 'Various Artists',
      listenedAt: time,
      createdAt: time,
      ...(artist === 'Probe B' && mode === 'submitted' ? { releaseMbid: N } : {}),
    });
  }
  app.db.run("UPDATE mb_tracks SET status='matched',release_mbid=? WHERE artist_key=?", M, artistKey('Probe A'));
  if (mode === 'other' || mode === 'same' || mode === 'disputed') {
    app.db.run(
      "UPDATE mb_tracks SET status='matched',release_mbid=? WHERE artist_key=?",
      mode === 'same' ? M : N,
      artistKey('Probe B'),
    );
  }
  if (mode === 'disputed')
    app.db.run(
      "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,release_mbid,created_at_ms) VALUES(?,'other','probe hits','matched',?,1)",
      artistKey('Probe B'),
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
  if (mode === 'null-display') app.db.run("UPDATE scrobbles SET album=NULL WHERE rkey='probeb'");
  if (mode === 'inactive') app.db.run('UPDATE users SET active=0 WHERE did=?', BOB);
  if (mode === 'suppressed')
    app.db.run("INSERT INTO suppression(did,suppressed_at) VALUES(?,'2026-01-15T12:00:00Z')", BOB);
  if (mode === 'deleted')
    app.db.run(
      "INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms) VALUES('probe-delete',?,'scrobble.delete','web',0,?,'probeb','queued',1,1,1)",
      BOB,
      SCROBBLE,
    );
  return app;
}
describe('compilation MBID aliases use the newest visible group display', () => {
  it.each(['unmatched', 'other', 'submitted', 'disputed', 'null-display'])(
    'rejects a stale compilation alias when newest artist is %s',
    async (mode) => {
      const app = await compilation(mode);
      const byName = await get(app, { method: 'album.getInfo', artist: 'Various Artists', album: 'Probe Hits' });
      const byId = await get(app, { method: 'album.getInfo', mbid: M });

      if (mode === 'null-display') expect(byName.body.error).toBe(6);
      else expect(byName.body.album.mbid).not.toBe(M);
      expect(byId.body.error).toBe(6);
    },
  );
  it.each(['same', 'inactive', 'suppressed', 'deleted'])(
    'accepts correct compilation alias with %s newest artist',
    async (mode) => {
      const app = await compilation(mode);
      const byName = await get(app, { method: 'album.getInfo', artist: 'Various Artists', album: 'Probe Hits' });
      const byId = await get(app, { method: 'album.getInfo', mbid: M });
      expect(byName.body.album.mbid).toBe(M);
      expect(byId.status).toBe(200);
      expect(byId.body.album).toEqual(byName.body.album);
    },
  );
});

it('batches candidate albums sharing an artist without rescanning that artist per album', async () => {
  const app = await compilation('same');
  const base = app.db.one<Record<string, SqlParam>>("SELECT * FROM scrobbles WHERE rkey='probea'")!;
  const columns = Object.keys(base);
  const insert = `INSERT INTO scrobbles(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`;
  app.db.tx(() => {
    for (let i = 0; i < 200; i++) {
      const row = {
        ...base,
        uri: `at://${ALICE}/${SCROBBLE}/candidate${i}`,
        rkey: `candidate${i}`,
        album_key: `candidate${i}`,
      };
      app.db.run(insert, ...columns.map((c) => row[c as keyof typeof row]));
      app.db.run(
        "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,release_mbid,created_at_ms) VALUES(?,? ,?,'matched',?,1)",
        base.artist_key!,
        base.track_key!,
        row.album_key,
        M,
      );
    }
  });
  const spy = vi.spyOn(app.db, 'all');
  const result = await get(app, { method: 'album.getInfo', mbid: M });
  const queries = spy.mock.calls.filter(([sql]) => sql.includes('WITH mk AS'));
  const consensusQueries = spy.mock.calls.filter(([sql]) =>
    sql.includes('SELECT artist_key AS artistKey,album_key AS albumKey,release_mbid AS value'),
  );
  spy.mockRestore();
  expect(result.status).toBe(200);
  expect(result.body.album.playcount).toBe('2');
  expect(queries).toHaveLength(1);
  expect(consensusQueries).toHaveLength(1);
  const [sql, ...params] = queries[0]!;
  const plan = app.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
  expect(plan.some((row) => row.detail.includes('SEARCH s USING INDEX scrobbles_artist_global'))).toBe(false);
});

it('batches artist consensus across 1,000 candidate artists with bounded SQL growth', async () => {
  const app = await entityApp();
  const base = app.db.one<Record<string, SqlParam>>("SELECT * FROM scrobbles WHERE rkey='r01'")!;
  const columns = Object.keys(base);
  const insert = `INSERT INTO scrobbles(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`;
  app.db.tx(() => {
    for (let i = 0; i < 1_000; i++) {
      const key = `candidate-artist-${i}`;
      const row = {
        ...base,
        uri: `at://${ALICE}/${SCROBBLE}/artist${i}`,
        rkey: `artist${i}`,
        artist: key,
        artist_key: key,
        album_artist: key,
        album_artist_key: key,
      };
      app.db.run(insert, ...columns.map((column) => row[column as keyof typeof row]));
      app.db.run(
        "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,artist_mbids,created_at_ms) VALUES(?,?,?,'matched',?,1)",
        key,
        base.track_key!,
        base.album_key!,
        JSON.stringify([M]),
      );
    }
  });
  const allSpy = vi.spyOn(app.db, 'all');
  const oneSpy = vi.spyOn(app.db, 'one');
  const result = await get(app, { method: 'artist.getInfo', mbid: M });
  const consensusQueries = allSpy.mock.calls.filter(([sql]) =>
    sql.includes('SELECT m.artist_key AS artistKey,j.value AS value'),
  );
  const [consensusSql, ...consensusParams] = consensusQueries[0]!;
  const totalStatements = allSpy.mock.calls.length + oneSpy.mock.calls.length;
  allSpy.mockRestore();
  oneSpy.mockRestore();
  expect(result.status).toBe(200);
  expect(result.body.artist.stats.playcount).toBe('1');
  expect(consensusQueries).toHaveLength(1);
  expect(totalStatements).toBeLessThanOrEqual(1_020);
  const plan = app.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${consensusSql}`, ...consensusParams);
  expect(plan.some((row) => row.detail.includes('SEARCH m'))).toBe(true);
});

it('keeps submitted name-based artist and album IDs independent of cached consensus reads', async () => {
  const app = await entityApp();
  const ak = artistKey('Radiohead');
  app.db.run('UPDATE scrobbles SET artist_mbids=?,release_mbid=? WHERE artist_key=?', JSON.stringify([M]), N, ak);
  app.db.run("UPDATE mb_tracks SET status='matched',artist_mbids='invalid-cache-json' WHERE artist_key=?", ak);
  const spy = vi.spyOn(app.db, 'all');
  const artist = await get(app, { method: 'artist.getInfo', artist: 'Radiohead' });
  const album = await get(app, { method: 'album.getInfo', artist: 'Radiohead', album: 'OK Computer' });
  const consensusReads = spy.mock.calls.filter(
    ([sql]) =>
      sql.includes('SELECT DISTINCT j.value AS value FROM mb_tracks') ||
      sql.includes('SELECT DISTINCT release_mbid AS value FROM mb_tracks'),
  );
  spy.mockRestore();
  expect(artist.status).toBe(200);
  expect(artist.body.artist.mbid).toBe(M);
  expect(album.status).toBe(200);
  expect(album.body.album.mbid).toBe(N);
  expect(consensusReads).toHaveLength(0);
});
