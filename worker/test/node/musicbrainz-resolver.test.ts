import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { afterEach, expect, it } from 'vitest';
import { migrate } from '../../src/do/migrate';
import { SCHEMA_VERSION } from '../../src/do/schema';
import { createMusicBrainzClient, MB_CAPS } from '../../src/musicbrainz/client';
import { createMusicBrainzResolver } from '../../src/musicbrainz/resolver';
import { backfillLoveReviveKeys } from '../../src/musicbrainz/revive-loves';
import { enqueueTrack } from '../../src/musicbrainz/store';
import { bindPolicyFetch, createPolicyFetch } from '../../src/node/policy-fetch';
import { openSqliteDb } from '../../src/node/sqlite-db';
import { FakeMusicBrainz, MUSICBRAINZ_HOST } from './support/fake-musicbrainz';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => {
    rmSync(d, { recursive: true, force: true });
  });
});
function setup(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'mb-resolver-'));
  dirs.push(dir);
  const db = openSqliteDb(join(dir, 'db.sqlite'), { create: true, busyTimeoutMs: 200 });
  expect(migrate(db)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
  const clock = fixedClock();
  const fake = new FakeMusicBrainz();
  const fetch = bindPolicyFetch(
    createPolicyFetch({ transport: routerTransport({ hosts: { [MUSICBRAINZ_HOST]: fake } }) }),
    MB_CAPS,
  );
  const client = createMusicBrainzClient({
    fetch,
    apiRoot: `https://${MUSICBRAINZ_HOST}/ws/2/`,
    version: 'test',
    nowMs: () => clock.nowMs(),
  });
  const resolver = createMusicBrainzResolver({ db, client, clock, enabled });
  return { db, clock, fake, resolver, path: join(dir, 'db.sqlite') };
}
const uuid = '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10';
const candidate = (score = 95, artistName = 'Artist') => ({
  id: uuid,
  title: 'Track',
  score,
  'artist-credit': [
    { name: artistName, artist: { id: uuid, name: 'Artist alias' }, joinphrase: ' feat. ' },
    { name: 'Guest', artist: { name: 'Guest' } },
  ],
  releases: [
    {
      id: uuid,
      title: 'Album',
      status: 'Official',
      date: '2001',
      'release-group': { id: uuid, 'primary-type': 'Album' },
    },
  ],
  length: 210000,
  isrcs: ['USAAA0000001'],
});

it('matches submitted MBID, captures full credit and metadata, and keeps no egress when disabled', async () => {
  const x = setup();
  enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'track', albumKey: 'album' }, x.clock.nowMs(), 0, uuid);
  x.fake.response = { status: 200, body: candidate() };
  expect(await x.resolver.run()).toMatchObject({ requests: 1 });
  expect(x.db.one('SELECT status,matched_by,artist_credit,release_title,duration_ms FROM mb_tracks')).toEqual({
    status: 'matched',
    matched_by: 'mbid',
    artist_credit: 'Artist feat. Guest',
    release_title: 'Album',
    duration_ms: 210000,
  });
});

it('rejects absent/low scores and wrong credited artist names', async () => {
  const x = setup();
  enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'track' }, x.clock.nowMs());
  x.fake.response = { status: 200, body: { recordings: [{ ...candidate(89), score: undefined }] } };
  await x.resolver.run();
  expect(x.db.one('SELECT status,attempts FROM mb_tracks')).toEqual({ status: 'pending', attempts: 1 });
});

it('searches and accepts a top score only when title and the displayed credited artist name match', async () => {
  const x = setup();
  enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'track', albumKey: 'album' }, x.clock.nowMs());
  x.fake.response = { status: 200, body: { recordings: [candidate(90)] } };
  await x.resolver.run();
  expect(x.db.one('SELECT status,matched_by,score,artist_credit FROM mb_tracks')).toEqual({
    status: 'matched',
    matched_by: 'search',
    score: 90,
    artist_credit: 'Artist feat. Guest',
  });
  const y = setup();
  enqueueTrack(y.db, { artistKey: 'artist', trackKey: 'track' }, y.clock.nowMs());
  y.fake.response = { status: 200, body: { recordings: [candidate(89)] } };
  await y.resolver.run();
  expect(y.db.one('SELECT status FROM mb_tracks')).toEqual({ status: 'unmatched' });
});

it('404 records a fallback phase and searches only after the global 1000ms interval, including after restart', async () => {
  const x = setup();
  enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'track' }, x.clock.nowMs(), 0, uuid);
  x.fake.onRequest = (r) =>
    new URL(r.url).pathname.endsWith(uuid)
      ? { status: 404, body: {} }
      : { status: 200, body: { recordings: [candidate()] } };
  expect((await x.resolver.run()).requests).toBe(1);
  expect((await x.resolver.run()).requests).toBe(0);
  x.clock.advance(1000);
  expect((await x.resolver.run()).requests).toBe(1);
  enqueueTrack(x.db, { artistKey: 'other', trackKey: 'song' }, x.clock.nowMs());
  expect((await setupResolverOnExistingDb(x.db, x.clock, x.fake).run()).requests).toBe(0);
});

function setupResolverOnExistingDb(
  db: ReturnType<typeof openSqliteDb>,
  clock: ReturnType<typeof fixedClock>,
  fake: FakeMusicBrainz,
) {
  const fetch = bindPolicyFetch(
    createPolicyFetch({ transport: routerTransport({ hosts: { [MUSICBRAINZ_HOST]: fake } }) }),
    MB_CAPS,
  );
  return createMusicBrainzResolver({
    db,
    clock,
    client: createMusicBrainzClient({
      fetch,
      apiRoot: `https://${MUSICBRAINZ_HOST}/ws/2/`,
      version: 'test',
      nowMs: () => clock.nowMs(),
    }),
  });
}

it('honors 503 Retry-After globally and kill switch sends no requests', async () => {
  const x = setup();
  enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'track' }, x.clock.nowMs());
  x.fake.response = { status: 503, body: {}, headers: { 'retry-after': '30' } };
  await x.resolver.run();
  enqueueTrack(x.db, { artistKey: 'other', trackKey: 'track' }, x.clock.nowMs());
  expect(x.resolver.availableAt()).toBe(x.clock.nowMs() + 30_000);
  expect((await setupResolverOnExistingDb(x.db, x.clock, x.fake).run()).requests).toBe(0);
  const disabled = setup(false);
  enqueueTrack(disabled.db, { artistKey: 'a', trackKey: 'b' }, disabled.clock.nowMs());
  expect((await disabled.resolver.run()).requests).toBe(0);
  expect(disabled.fake.requests).toHaveLength(0);
});

it('a resolver match atomically revives an ignored love, and rollback leaves no partial match or job', async () => {
  const x = setup();
  const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
  enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'track' }, x.clock.nowMs());
  x.db.run(
    "INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms) VALUES('lb-a',?,'listenbrainz','user',x'00','key',1,1)",
    did,
  );
  x.db.run(
    "INSERT INTO operations(id,did,kind,origin,priority,collection,record_json,digest,state,due_at,created_at_ms,updated_at_ms) VALUES('love-a',?,'love.put','listenbrainz',0,'com.example.atmusic.love',?,zeroblob(32),'succeeded',0,1,1)",
    did,
    JSON.stringify({ artist: 'Artist', track: 'Track' }),
  );
  x.db.run(
    "INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,last_error,created_at_ms,updated_at_ms) VALUES('old','lb-a',?,'love','old','{\"artist\":\"Artist\",\"track\":\"Track\"}','ignored',0,0,'mbid_unresolved',1,1)",
    did,
  );
  x.fake.response = { status: 200, body: { recordings: [candidate()] } };
  expect((await x.resolver.run()).requests).toBe(1);
  expect(x.db.one("SELECT status,recording_mbid FROM mb_tracks WHERE artist_key='artist'")).toEqual({
    status: 'matched',
    recording_mbid: uuid,
  });
  expect(
    x.db.one("SELECT kind,state,payload_json FROM forward_outbox WHERE dedupe_key LIKE 'mb-match:%'"),
  ).toMatchObject({ kind: 'love', state: 'queued' });
  expect(x.db.all('SELECT * FROM mb_love_revive_jobs')).toEqual([]);

  const y = setup();
  enqueueTrack(y.db, { artistKey: 'artist', trackKey: 'track' }, y.clock.nowMs());
  y.db.run(
    "INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms) VALUES('lb-a',?,'listenbrainz','user',x'00','key',1,1)",
    did,
  );
  y.db.run(
    "INSERT INTO operations(id,did,kind,origin,priority,collection,record_json,digest,state,due_at,created_at_ms,updated_at_ms) VALUES('love-a',?,'love.put','listenbrainz',0,'com.example.atmusic.love',?,zeroblob(32),'succeeded',0,1,1)",
    did,
    JSON.stringify({ artist: 'Artist', track: 'Track' }),
  );
  y.db.run(
    "INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,last_error,created_at_ms,updated_at_ms) VALUES('old','lb-a',?,'love','old','{\"artist\":\"Artist\",\"track\":\"Track\"}','ignored',0,0,'no_recording_mbid',1,1)",
    did,
  );
  y.db.raw.exec(
    "CREATE TRIGGER fail_revival BEFORE INSERT ON forward_outbox WHEN NEW.dedupe_key LIKE 'mb-match:%' BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  y.fake.response = { status: 200, body: { recordings: [candidate()] } };
  await expect(y.resolver.run()).rejects.toThrow('injected');
  expect(y.db.one("SELECT status FROM mb_tracks WHERE artist_key='artist'")).toEqual({ status: 'pending' });
  expect(y.db.all('SELECT * FROM mb_love_revive_jobs')).toEqual([]);
  expect(y.db.one("SELECT count(*) AS n FROM forward_outbox WHERE dedupe_key LIKE 'mb-match:%'")).toEqual({ n: 0 });
});

it('drains >100 revival targets across a SQLite restart under the total run budget without another MB request', async () => {
  const x = setup();
  enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'track' }, x.clock.nowMs());
  for (let i = 0; i < 101; i++) {
    const suffix = String(i).padStart(2, '0');
    const did = `did:plc:${String(i).padStart(24, 'a')}`;
    const link = `lb-${suffix}`;
    x.db.run(
      "INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms) VALUES(?,?,'listenbrainz','user',x'00','key',1,1)",
      link,
      did,
    );
    x.db.run(
      "INSERT INTO operations(id,did,kind,origin,priority,collection,record_json,digest,state,due_at,created_at_ms,updated_at_ms) VALUES(?,?,'love.put','listenbrainz',0,'com.example.atmusic.love',?,zeroblob(32),'succeeded',0,1,1)",
      `op-${suffix}`,
      did,
      JSON.stringify({ artist: 'Artist', track: 'Track' }),
    );
    x.db.run(
      "INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,last_error,created_at_ms,updated_at_ms) VALUES(?,?,?,'love',?,?, 'ignored',0,0,?,?,?)",
      `old-${suffix}`,
      link,
      did,
      `old-${suffix}`,
      JSON.stringify({ artist: 'Artist', track: 'Track' }),
      i % 2 ? 'mbid_unresolved' : 'no_recording_mbid',
      i + 1,
      i + 1,
    );
  }
  x.fake.response = { status: 200, body: { recordings: [candidate()] } };
  const backfillRun = await x.resolver.run();
  expect(backfillRun.requests).toBe(0);
  expect((await x.resolver.run()).requests).toBe(1);
  const afterMatch = x.db.one<{ n: number }>(
    "SELECT count(*) AS n FROM forward_outbox WHERE dedupe_key LIKE 'mb-match:%'",
  )!.n;
  expect(afterMatch).toBe(98);
  expect(afterMatch).toBeLessThanOrEqual(100);
  expect(x.db.one<{ n: number }>('SELECT count(*) AS n FROM mb_love_revive_jobs')!.n).toBe(1);
  expect(x.resolver.availableAt()).toBeGreaterThan(x.clock.nowMs());
  x.db.close();
  const reopened = openSqliteDb(x.path, { busyTimeoutMs: 200 });
  const resumed = setupResolverOnExistingDb(reopened, x.clock, x.fake);
  const didLast = `did:plc:${String(99).padStart(24, 'a')}`;
  reopened.run(
    "INSERT INTO operations(id,did,kind,origin,priority,collection,record_json,digest,state,due_at,created_at_ms,updated_at_ms) VALUES('op-last-unlove',?,'love.delete','listenbrainz',0,'com.example.atmusic.love',?,zeroblob(32),'succeeded',0,2,2)",
    didLast,
    JSON.stringify({ artist: 'Artist', track: 'Track' }),
  );
  reopened.run(
    "UPDATE forward_outbox SET kind='unlove',payload_json=?,created_at_ms=200,updated_at_ms=200 WHERE link_id='lb-99' AND dedupe_key='old-99'",
    JSON.stringify({ artist: 'Artist', track: 'Track' }),
  );
  const beforeCalls = x.fake.requests.length;
  const second = await resumed.run();
  expect(second.requests).toBe(0);
  expect(x.fake.requests).toHaveLength(beforeCalls);
  const rows = reopened.all<{ n: number }>(
    "SELECT count(*) AS n FROM forward_outbox WHERE dedupe_key LIKE 'mb-match:%'",
  );
  expect(rows[0]?.n).toBe(101);
  expect(reopened.one<{ n: number }>('SELECT count(*) AS n FROM mb_love_revive_jobs')!.n).toBe(0);
  const lastPayload = reopened.one<{ kind: string; payload_json: string }>(
    "SELECT kind,payload_json FROM forward_outbox WHERE link_id='lb-99' AND dedupe_key LIKE 'mb-match:%'",
  );
  expect(lastPayload?.kind).toBe('unlove');
  expect(JSON.parse(lastPayload!.payload_json)).toMatchObject({
    artist: 'Artist',
    track: 'Track',
    recordingMbid: uuid,
  });
  expect(
    reopened.one<{ n: number }>(
      "SELECT count(DISTINCT link_id) AS n FROM forward_outbox WHERE dedupe_key LIKE 'mb-match:%'",
    )!.n,
  ).toBe(101);
  reopened.close();
});

it('charges match-triggered revival to one total 100-row budget across three same-run matches', async () => {
  const x = setup();
  const tracks = ['song 0', 'song 1', 'song 2'];
  for (const track of tracks) enqueueTrack(x.db, { artistKey: 'artist', trackKey: track }, x.clock.nowMs());
  for (let i = 0; i < 60; i++) {
    const did = `did:plc:${String(i).padStart(24, 'c')}`;
    const link = `budget-${String(i).padStart(2, '0')}`;
    x.db.run(
      "INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms) VALUES(?,?,'listenbrainz','user',x'00','key',1,1)",
      link,
      did,
    );
    for (let j = 0; j < tracks.length; j++) {
      const track = tracks[j]!;
      x.db.run(
        `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,last_error,created_at_ms,updated_at_ms,love_artist_key,love_track_key)
         VALUES(?,?,?,'love',?,?,'ignored',0,0,'mbid_unresolved',1,1,'artist',?)`,
        `budget-${i}-${j}`,
        link,
        did,
        `budget-${i}-${j}`,
        JSON.stringify({ artist: 'Artist', track }),
        track,
      );
    }
  }
  while (!backfillLoveReviveKeys(x.db, 100).complete) {}
  let responseIndex = 0;
  x.fake.onRequest = () => {
    const n = responseIndex++;
    x.clock.advance(1100);
    const track = tracks[n] ?? tracks[2]!;
    return {
      status: 200,
      body: {
        recordings: [
          {
            ...candidate(),
            title: track,
            'artist-credit': [{ name: 'Artist', artist: { id: uuid, name: 'Artist' }, joinphrase: '' }],
          },
        ],
      },
    };
  };
  const result = await x.resolver.run();
  expect(result.requests).toBe(2);
  const revived = x.db.one<{ n: number }>(
    "SELECT count(*) AS n FROM forward_outbox WHERE dedupe_key LIKE 'mb-match:%'",
  )!.n;
  expect(revived).toBe(98);
  expect(revived).toBeLessThanOrEqual(100);
  expect(x.db.one<{ n: number }>("SELECT count(*) AS n FROM mb_tracks WHERE status='matched'")!.n).toBe(2);
});
it('persists an HTTP-date 503 deadline globally across tracks and resolver restart', async () => {
  const x = setup();
  const deadline = x.clock.nowMs() + 3_600_000;
  enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'track' }, x.clock.nowMs());
  x.fake.response = { status: 503, body: {}, headers: { 'retry-after': new Date(deadline).toUTCString() } };
  await x.resolver.run();
  enqueueTrack(x.db, { artistKey: 'other', trackKey: 'song' }, x.clock.nowMs(), 10);
  expect(x.resolver.availableAt()).toBe(deadline);
  const restarted = setupResolverOnExistingDb(x.db, x.clock, x.fake);
  expect((await restarted.run()).requests).toBe(0);
  x.clock.advance(3_600_000 - 1);
  expect((await setupResolverOnExistingDb(x.db, x.clock, x.fake).run()).requests).toBe(0);
  x.clock.advance(1);
  x.fake.response = { status: 200, body: { recordings: [candidate()] } };
  expect((await setupResolverOnExistingDb(x.db, x.clock, x.fake).run()).requests).toBeGreaterThan(0);
});

it('backs off malformed external candidates across restarts while healthy queued rows progress', async () => {
  const malformed = [
    { ...candidate(), title: '   ' },
    { ...candidate(), 'artist-credit': [{ name: '   ', artist: { id: uuid } }] },
    { ...candidate(), score: Number.NaN },
    { ...candidate(), score: Number.POSITIVE_INFINITY },
    { ...candidate(), score: -1 },
    { ...candidate(), length: -1 },
    { ...candidate(), length: 1.5 },
    { ...candidate(), length: Number.POSITIVE_INFINITY },
    { ...candidate(), releases: [{ id: uuid, title: '   ', status: 'Official' }] },
  ];
  for (const value of malformed) {
    const x = setup();
    enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'track' }, x.clock.nowMs());
    x.fake.response = { status: 200, body: { recordings: [value] } };
    expect((await x.resolver.run()).requests).toBe(1);
    expect(x.db.one('SELECT status,attempts,next_attempt_ms FROM mb_tracks')).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    expect(
      x.db.one<{ next_attempt_ms: number }>('SELECT next_attempt_ms FROM mb_tracks')!.next_attempt_ms,
    ).toBeGreaterThan(x.clock.nowMs());
    const restarted = setupResolverOnExistingDb(x.db, x.clock, x.fake);
    x.clock.advance(60_000);
    x.fake.response = { status: 200, body: { recordings: [value] } };
    await restarted.run();
    expect(x.db.one('SELECT status,attempts FROM mb_tracks')).toMatchObject({ status: 'pending', attempts: 2 });
  }
  const x = setup();
  enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'bad' }, x.clock.nowMs());
  enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'track' }, x.clock.nowMs(), 1);
  x.fake.onRequest = (request) =>
    new URL(request.url).searchParams.get('query')?.includes('bad')
      ? { status: 200, body: { recordings: [{ ...candidate(), title: '   ' }] } }
      : { status: 200, body: { recordings: [candidate()] } };
  expect((await x.resolver.run()).requests).toBe(1);
  x.clock.advance(1000);
  expect((await setupResolverOnExistingDb(x.db, x.clock, x.fake).run()).requests).toBe(1);
  expect(x.db.all('SELECT track_key,status,attempts FROM mb_tracks ORDER BY track_key')).toEqual([
    { track_key: 'bad', status: 'pending', attempts: 1 },
    { track_key: 'track', status: 'matched', attempts: 0 },
  ]);
});

it('moves a malformed candidate to failed for 30 days after eight persisted attempts', async () => {
  const x = setup();
  enqueueTrack(x.db, { artistKey: 'artist', trackKey: 'track' }, x.clock.nowMs());
  x.fake.response = { status: 200, body: { recordings: [{ ...candidate(), title: '   ' }] } };
  for (let attempt = 1; attempt <= 8; attempt++) {
    const resolver = setupResolverOnExistingDb(x.db, x.clock, x.fake);
    await resolver.run();
    if (attempt < 8) {
      const next = x.db.one<{ next_attempt_ms: number }>('SELECT next_attempt_ms FROM mb_tracks')!.next_attempt_ms;
      x.clock.advance(Math.max(next - x.clock.nowMs(), resolver.availableAt() - x.clock.nowMs()));
    }
  }
  expect(x.db.one('SELECT status,attempts FROM mb_tracks')).toEqual({ status: 'failed', attempts: 8 });
  expect(
    x.db.one<{ next_attempt_ms: number }>('SELECT next_attempt_ms FROM mb_tracks')!.next_attempt_ms - x.clock.nowMs(),
  ).toBe(30 * 86_400_000);
});
