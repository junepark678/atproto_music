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
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { Db, SqlParam } from '../../src/do/db';
import { type ApplyOptions, applyRecordProof } from '../../src/do/write/apply-record';
import { lastfmRoutes } from '../../src/lastfm/routes';
import { closeApps, startApp, type TestApp } from '../node/support/app';

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

// Large SQL-seeded growth probes stay in worker-bench (ADR 0005 §15.1).
// Each measured read traverses the production route, including candidate lookup,
// batched consensus, canonical display selection and entity statistics.
it('artist alias fallback exercises 1k and 10k candidates with explicit SQL work growth', async () => {
  const app = await entityApp();
  const base = app.db.one<Record<string, SqlParam>>("SELECT * FROM scrobbles WHERE rkey='r01'")!;
  const columns = Object.keys(base);
  const insert = `INSERT INTO scrobbles(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`;
  const mbid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const seed = (start: number, end: number) =>
    app.db.tx(() => {
      for (let id = start; id < end; id++) {
        const key = `candidate-artist-${id}`;
        const row = {
          ...base,
          uri: `at://${ALICE}/${SCROBBLE}/artist${id}`,
          rkey: `artist${id}`,
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
          JSON.stringify([mbid]),
        );
      }
    });
  const check = async (size: number) => {
    const all = vi.spyOn(app.db, 'all');
    const one = vi.spyOn(app.db, 'one');
    const result = await get(app, { method: 'artist.getInfo', mbid });
    const consensus = all.mock.calls.filter(([sql]) =>
      sql.includes('SELECT m.artist_key AS artistKey,j.value AS value'),
    );
    const queryCount = all.mock.calls.length + one.mock.calls.length;
    const [sql, ...params] = consensus[0]!;
    all.mockRestore();
    one.mockRestore();
    expect(result.status).toBe(200);
    expect(result.body.artist.mbid).toBe(mbid);
    expect(Number(result.body.artist.stats.playcount)).toBeGreaterThan(0);
    expect(consensus).toHaveLength(1);
    // Six fixed route/display reads plus one candidate read per alias row.
    // Consensus remains one batch at both scales; no wall-time verdict here.
    expect(queryCount).toBe(size + 6);
    const plan = app.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
    expect(plan.some((row) => row.detail.includes('SEARCH m'))).toBe(true);
    expect(
      app.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM mb_tracks WHERE artist_key LIKE 'candidate-artist-%'")!.n,
    ).toBe(size);
  };
  seed(0, 1_000);
  await check(1_000);
  seed(1_000, 10_000);
  await check(10_000);
});

it('batches 200 albums sharing one artist without rescanning that artist per album', async () => {
  const app = await entityApp();
  const base = app.db.one<Record<string, SqlParam>>("SELECT * FROM scrobbles WHERE rkey='r01'")!;
  const columns = Object.keys(base);
  const insert = `INSERT INTO scrobbles(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`;
  const release = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  app.db.tx(() => {
    for (let i = 0; i < 200; i++) {
      const albumKey = `shared-artist-album-${i}`;
      const row = {
        ...base,
        uri: `at://${ALICE}/${SCROBBLE}/album${i}`,
        rkey: `album${i}`,
        album: `Album ${i}`,
        album_key: albumKey,
      };
      app.db.run(insert, ...columns.map((column) => row[column as keyof typeof row]));
      app.db.run(
        "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,release_mbid,created_at_ms) VALUES(?,?,?,'matched',?,1)",
        base.artist_key!,
        base.track_key!,
        albumKey,
        release,
      );
    }
  });
  expect(
    app.db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM mb_tracks WHERE release_mbid=? AND album_key LIKE 'shared-artist-album-%'",
      release,
    )!.n,
  ).toBe(200);
  const all = vi.spyOn(app.db, 'all');
  const result = await get(app, { method: 'album.getInfo', mbid: release });
  const candidateReads = all.mock.calls.filter(([sql]) => sql.includes('WITH mk AS'));
  const consensus = all.mock.calls.filter(([sql]) =>
    sql.includes('SELECT artist_key AS artistKey,album_key AS albumKey,release_mbid AS value'),
  );
  const [sql, ...params] = candidateReads[0]!;
  all.mockRestore();
  expect(result.status).toBe(200);
  expect(result.body.album.mbid).toBe(release);
  expect(Number(result.body.album.playcount)).toBeGreaterThan(0);
  expect(candidateReads).toHaveLength(1);
  expect(consensus).toHaveLength(1);
  const plan = app.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
  expect(plan.some((row) => row.detail.includes('SEARCH s USING INDEX scrobbles_artist_global'))).toBe(false);
});

afterEach(async () => closeApps());
