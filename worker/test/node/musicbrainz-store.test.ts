import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/do/migrate';
import { MIGRATIONS, SCHEMA_VERSION, TABLE_CLASS, TABLES } from '../../src/do/schema';
import { enqueueTrack, matchedRecordingMbid, recordingByMbid, seedHistoricalTracks } from '../../src/musicbrainz/store';
import { openSqliteDb } from '../../src/node/sqlite-db';

const dirs: string[] = [];
afterEach(() =>
  dirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  }),
);

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'mb-store-'));
  dirs.push(dir);
  const db = openSqliteDb(join(dir, 'db.sqlite'), { create: true, busyTimeoutMs: 200 });
  expect(migrate(db)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
  return db;
}

describe('MusicBrainz storage', () => {
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
