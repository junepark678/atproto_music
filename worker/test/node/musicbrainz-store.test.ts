import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/do/migrate';
import { MIGRATIONS, SCHEMA_VERSION, TABLE_CLASS, TABLES } from '../../src/do/schema';
import { backfillLoveReviveKeys, enqueueRevivedLoves } from '../../src/musicbrainz/revive-loves';
import {
  advanceLoveReviveJob,
  deleteLoveReviveJob,
  enqueueTrack,
  loveReviveJobs,
  matchedArtistKeys,
  matchedArtistMbids,
  matchedEntityMbid,
  matchedRecordingKeys,
  matchedRecordingMbid,
  matchedReleaseKeys,
  matchedReleaseMbids,
  recordingByMbid,
  seedHistoricalTracks,
  stageLoveReviveJob,
} from '../../src/musicbrainz/store';
import { openSqliteDb } from '../../src/node/sqlite-db';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'mb-store-'));
  dirs.push(dir);
  const db = openSqliteDb(join(dir, 'db.sqlite'), { create: true, busyTimeoutMs: 200 });
  expect(migrate(db)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
  return db;
}

describe('MusicBrainz storage', () => {
  it('reads distinct matched reverse keys and rejects invalid IDs and non-matched rows', () => {
    const db = database();
    try {
      const recording = '66666666-6666-4666-8666-666666666666';
      const artist = '77777777-7777-4777-8777-777777777777';
      const release = '88888888-8888-4888-8888-888888888888';
      db.run(
        "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,artist_mbids,release_mbid,created_at_ms) VALUES('a','t','x','matched',?,?,?,1)",
        recording,
        JSON.stringify([artist]),
        release,
      );
      db.run(
        "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,artist_mbids,release_mbid,created_at_ms) VALUES('a','t','y','pending',?,?,?,2)",
        recording,
        JSON.stringify([artist]),
        release,
      );
      db.run(
        "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,artist_mbids,release_mbid,created_at_ms) VALUES('b','u','','matched',?,?,?,3)",
        recording,
        JSON.stringify([artist]),
        release,
      );
      expect(matchedRecordingKeys(db, recording)).toEqual([
        { artistKey: 'a', trackKey: 't' },
        { artistKey: 'b', trackKey: 'u' },
      ]);
      expect(matchedArtistKeys(db, artist)).toEqual(['a', 'b']);
      expect(matchedReleaseKeys(db, release)).toEqual([{ artistKey: 'a', albumKey: 'x' }]);
      expect(matchedArtistMbids(db, ['a', 'b', 'missing'])).toEqual(
        new Map([
          ['a', artist],
          ['b', artist],
          ['missing', null],
        ]),
      );
      expect(
        matchedReleaseMbids(db, [
          { artistKey: 'a', albumKey: 'x' },
          { artistKey: 'missing', albumKey: '' },
        ]),
      ).toEqual(
        new Map([
          [JSON.stringify(['a', 'x']), release],
          [JSON.stringify(['missing', '']), null],
        ]),
      );
      for (const read of [matchedRecordingKeys, matchedArtistKeys, matchedReleaseKeys])
        expect(read(db, 'bad')).toEqual([]);
      expect(matchedArtistMbids(db, ['a'])).toEqual(new Map([['a', artist]]));
      expect(matchedEntityMbid(db, 'artist', 'a')).toBe(artist);

      db.run(
        "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,artist_mbids,release_mbid,created_at_ms) VALUES('a','other','x','matched',?,?,4)",
        JSON.stringify([null, 'invalid', release]),
        'not-a-uuid',
      );
      expect(matchedArtistMbids(db, ['a']).get('a')).toBeNull();
      expect(matchedReleaseMbids(db, [{ artistKey: 'a', albumKey: 'x' }]).get(JSON.stringify(['a', 'x']))).toBe(
        release,
      );
    } finally {
      db.close();
    }
  });
  it('migration 18 stores bounded love revival jobs across reopen and supports cursor advance and deletion', () => {
    const db = database();
    const path = join(dirs[dirs.length - 1]!, 'db.sqlite');
    try {
      expect(MIGRATIONS.find((m) => m.version === 19)?.name).toBe('musicbrainz_love_revival_jobs');
      expect(TABLES).toContain('mb_love_revive_jobs');
      expect(TABLE_CLASS.mb_love_revive_jobs).toBe('non-derived');
      stageLoveReviveJob(
        db,
        { artistKey: 'artist', trackKey: 'track', albumKey: 'album' },
        '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
        10,
      );
      expect(loveReviveJobs(db, 1)).toMatchObject([
        { artistKey: 'artist', trackKey: 'track', albumKey: 'album', cursorLinkId: '' },
      ]);
    } finally {
      db.close();
    }
    const reopened = openSqliteDb(path, { busyTimeoutMs: 200 });
    try {
      const job = loveReviveJobs(reopened, 1)[0]!;
      advanceLoveReviveJob(reopened, job, 'link-cursor');
      expect(loveReviveJobs(reopened, 1)[0]?.cursorLinkId).toBe('link-cursor');
      deleteLoveReviveJob(reopened, job);
      expect(loveReviveJobs(reopened, 1)).toEqual([]);
    } finally {
      reopened.close();
    }
  });
  it('revives only the latest ignored love state per ListenBrainz link, idempotently and in bounded progressing slices', () => {
    const db = database();
    try {
      const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
      const addLink = (id: string, owner = did) =>
        db.run(
          `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms) VALUES(?,?,'listenbrainz','user',x'00','key',1,1)`,
          id,
          owner,
        );
      const addOp = (id: string, kind: string, body: object) =>
        db.run(
          `INSERT INTO operations(id,did,kind,origin,priority,collection,record_json,digest,state,due_at,created_at_ms,updated_at_ms) VALUES(?,?,?,'listenbrainz',0,'com.example.atmusic.love',?,zeroblob(32),'succeeded',0,1,1)`,
          id,
          did,
          kind,
          JSON.stringify(body),
        );
      const addRow = (
        id: string,
        link: string,
        kind: string,
        artist: string,
        track: string,
        state: string,
        error: string | null,
        time: number,
      ) =>
        db.run(
          `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,last_error,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,0,0,?,?,?)`,
          id,
          link,
          did,
          kind,
          id,
          JSON.stringify({ artist, track }),
          state,
          error,
          time,
          time,
        );
      addLink('link-a');
      addLink('link-b', 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb');
      addOp('op-love', 'love.put', { artist: 'Artist', track: 'Track', recordingMbid: null });
      addRow('old-ignored', 'link-a', 'love', 'Artist', 'Track', 'ignored', 'mbid_unresolved', 1);
      // The later unlove is current state, so revival must not replay the old love.
      addRow('new-ignored', 'link-a', 'unlove', 'Artist', 'Track', 'ignored', 'no_recording_mbid', 2);
      addRow('other-generation', 'link-b', 'love', 'Artist', 'Track', 'ignored', 'mbid_unresolved', 3);
      addRow('already-sent', 'link-b', 'unlove', 'Artist', 'Track', 'sent', null, 4);
      addOp('op-delete', 'love.delete', { artist: 'Artist', track: 'Track' });
      expect(backfillLoveReviveKeys(db, 100).scanned).toBe(4);
      // Current latest operation is love; update link B's latest row to sent to prove no revival there.
      const key = { artistKey: 'artist', trackKey: 'track' };
      expect(enqueueRevivedLoves(db, key, '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10', 10, 1).enqueued).toBe(1);
      const revived = db.one<{ kind: string; payload_json: string }>(
        "SELECT kind,payload_json FROM forward_outbox WHERE dedupe_key LIKE 'mb-match:%'",
      );
      expect(revived?.kind).toBe('unlove');
      expect(JSON.parse(revived!.payload_json)).toMatchObject({
        artist: 'Artist',
        track: 'Track',
        recordingMbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
      });
      expect(enqueueRevivedLoves(db, key, '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10', 11, 1).enqueued).toBe(0);
    } finally {
      db.close();
    }
  });
  it('bounds candidate rows scanned even when every latest link-generation row is ineligible', () => {
    const db = database();
    try {
      for (let i = 0; i < 205; i++) {
        const did = `did:plc:${String(i).padStart(24, 'b')}`;
        const link = `ineligible-${String(i).padStart(3, '0')}`;
        db.run(
          `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
           VALUES(?,?,'listenbrainz','user',x'00','key',1,1)`,
          link,
          did,
        );
        db.run(
          `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,love_artist_key,love_track_key)
           VALUES(?,?,?,'love',?,?,'sent',0,0,1,1,'artist','track')`,
          `sent-${i}`,
          link,
          did,
          `sent-${i}`,
          JSON.stringify({ artist: 'Artist', track: 'Track' }),
        );
      }
      let backfill = backfillLoveReviveKeys(db, 100);
      while (!backfill.complete) backfill = backfillLoveReviveKeys(db, 100);
      const key = { artistKey: 'artist', trackKey: 'track' };
      const one = enqueueRevivedLoves(db, key, '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10', 10, 100);
      expect(one).toMatchObject({ enqueued: 0, scanned: 100, complete: false });
      const two = enqueueRevivedLoves(db, key, '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10', 11, 100, one.cursorLinkId);
      expect(two).toMatchObject({ enqueued: 0, scanned: 100, complete: false });
      const three = enqueueRevivedLoves(db, key, '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10', 12, 100, two.cursorLinkId);
      expect(three).toMatchObject({ enqueued: 0, scanned: 5, complete: true });
      expect(new Set([one.cursorLinkId, two.cursorLinkId, three.cursorLinkId]).size).toBe(3);
    } finally {
      db.close();
    }
  });
  it('migrates the exact table as non-derived, and enqueue is idempotent while pending priority can increase', () => {
    const db = database();
    try {
      expect(TABLES).toContain('mb_tracks');
      expect(TABLE_CLASS.mb_tracks).toBe('non-derived');
      expect(MIGRATIONS.find((m) => m.version === 16)?.statements.join('\n')).toContain(
        'CREATE INDEX mb_tracks_due ON mb_tracks(status,next_attempt_ms,priority)',
      );
      enqueueTrack(db, { artistKey: 'artist', trackKey: 'track' }, 10);
      enqueueTrack(
        db,
        { artistKey: 'artist', trackKey: 'track', albumKey: null },
        20,
        5,
        '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
      );
      enqueueTrack(db, { artistKey: 'artist', trackKey: 'track' }, 30, 2);
      expect(db.one('SELECT * FROM mb_tracks')).toMatchObject({
        album_key: '',
        created_at_ms: 10,
        priority: 5,
        status: 'pending',
        submitted_recording_mbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
      });
    } finally {
      db.close();
    }
  });

  it('returns only matched valid UUIDs and resolves the Track S recording projection', () => {
    const db = database();
    try {
      const uuid = '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10';
      enqueueTrack(db, { artistKey: 'a', trackKey: 'pending' }, 1);
      enqueueTrack(db, { artistKey: 'a', trackKey: 'unmatched' }, 1);
      enqueueTrack(db, { artistKey: 'a', trackKey: 'bad' }, 1);
      enqueueTrack(db, { artistKey: 'a', trackKey: 'matched' }, 1);
      db.run("UPDATE mb_tracks SET status='unmatched', recording_mbid=? WHERE track_key='unmatched'", uuid);
      db.run(
        "UPDATE mb_tracks SET status='matched', recording_mbid='nope', title='bad', artist_credit='artist' WHERE track_key='bad'",
      );
      db.run(
        "UPDATE mb_tracks SET status='matched', recording_mbid=?, title='Song', artist_credit='Artist' WHERE track_key='matched'",
        uuid,
      );
      expect(matchedRecordingMbid(db, { artistKey: 'a', trackKey: 'pending' })).toBeNull();
      expect(matchedRecordingMbid(db, { artistKey: 'a', trackKey: 'unmatched' })).toBeNull();
      expect(matchedRecordingMbid(db, { artistKey: 'a', trackKey: 'bad' })).toBeNull();
      expect(matchedRecordingMbid(db, { artistKey: 'a', trackKey: 'matched' })).toBe(uuid);
      expect(recordingByMbid(db, uuid)).toEqual({ title: 'Song', artistCredit: 'Artist' });
      expect(recordingByMbid(db, 'bad')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('seeds bounded distinct history with an atomic cursor that resumes after reopening and preserves live priority', () => {
    const db = database();
    const path = join(dirs[dirs.length - 1]!, 'db.sqlite');
    try {
      db.run("INSERT INTO users(did,joined_at) VALUES ('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','2026-01-01T00:00:00Z')");
      const insert = (uri: string, artist: string, track: string, album: string | null) =>
        db.run(
          `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,album,listened_at,created_at,indexed_at,artist_key,track_key,album_key)
         VALUES(?,?,?,'r','3l','Artist','Track',?,'2026-01-15T12:00:00.000000000Z','2026-01-15T12:00:00Z','2026-01-15T12:00:00Z',?,?,?)`,
          uri,
          'cid',
          'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
          album,
          artist.toLowerCase(),
          track.toLowerCase(),
          album?.toLowerCase() ?? null,
        );
      insert('at://a/1', 'Artist', 'One', null);
      insert('at://a/2', 'Artist', 'One', null);
      insert('at://a/3', 'Artist', 'Two', 'Album');
      insert('at://a/4', 'Artist', 'Three', null);
      insert('at://a/5', 'Artist', 'Four', null);
      enqueueTrack(db, { artistKey: 'artist', trackKey: 'one' }, 5, 10);
      expect(seedHistoricalTracks(db, 10, 2)).toEqual({ insertedCandidates: 2, complete: false });
      expect(db.all('SELECT track_key FROM mb_tracks ORDER BY track_key')).toEqual([{ track_key: 'one' }]);
    } finally {
      db.close();
    }
    const reopened = openSqliteDb(path, { busyTimeoutMs: 200 });
    try {
      expect(seedHistoricalTracks(reopened, 20, 2)).toEqual({ insertedCandidates: 2, complete: false });
      expect(reopened.all('SELECT track_key,album_key,priority FROM mb_tracks ORDER BY track_key')).toEqual([
        { track_key: 'one', album_key: '', priority: 10 },
        { track_key: 'three', album_key: '', priority: 0 },
        { track_key: 'two', album_key: 'album', priority: 0 },
      ]);
      expect(seedHistoricalTracks(reopened, 30, 2)).toEqual({ insertedCandidates: 1, complete: false });
      expect(reopened.all("SELECT track_key FROM mb_tracks WHERE track_key='four'")).toEqual([{ track_key: 'four' }]);
      expect(seedHistoricalTracks(reopened, 40, 2)).toEqual({ insertedCandidates: 0, complete: true });
      expect(seedHistoricalTracks(reopened, 50, 2)).toEqual({ insertedCandidates: 0, complete: true });
    } finally {
      reopened.close();
    }
  });
});
