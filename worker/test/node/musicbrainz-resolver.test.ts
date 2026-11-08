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
  const client = createMusicBrainzClient({ fetch, apiRoot: `https://${MUSICBRAINZ_HOST}/ws/2/`, version: 'test' });
  const resolver = createMusicBrainzResolver({ db, client, clock, enabled });
  return { db, clock, fake, resolver };
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
  expect(x.db.one('SELECT status FROM mb_tracks')).toEqual({ status: 'unmatched' });
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
    client: createMusicBrainzClient({ fetch, apiRoot: `https://${MUSICBRAINZ_HOST}/ws/2/`, version: 'test' }),
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
