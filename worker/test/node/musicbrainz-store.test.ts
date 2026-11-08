import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/do/migrate';
import { MIGRATIONS, SCHEMA_VERSION, TABLE_CLASS, TABLES } from '../../src/do/schema';
import { openSqliteDb } from '../../src/node/sqlite-db';
import { enqueueTrack, matchedRecordingMbid, recordingByMbid } from '../../src/musicbrainz/store';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

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
      expect(MIGRATIONS.at(-1)?.statements.join('\n')).toContain('CREATE INDEX mb_tracks_due ON mb_tracks(status,next_attempt_ms,priority)');
      enqueueTrack(db, { artistKey: 'artist', trackKey: 'track' }, 10);
      enqueueTrack(db, { artistKey: 'artist', trackKey: 'track', albumKey: null }, 20, 5, '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10');
      enqueueTrack(db, { artistKey: 'artist', trackKey: 'track' }, 30, 2);
      expect(db.one('SELECT * FROM mb_tracks')).toMatchObject({ album_key: '', created_at_ms: 10, priority: 5, status: 'pending', submitted_recording_mbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10' });
    } finally { db.close(); }
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
      db.run("UPDATE mb_tracks SET status='matched', recording_mbid='nope', title='bad', artist_credit='artist' WHERE track_key='bad'");
      db.run("UPDATE mb_tracks SET status='matched', recording_mbid=?, title='Song', artist_credit='Artist' WHERE track_key='matched'", uuid);
      expect(matchedRecordingMbid(db, { artistKey: 'a', trackKey: 'pending' })).toBeNull();
      expect(matchedRecordingMbid(db, { artistKey: 'a', trackKey: 'unmatched' })).toBeNull();
      expect(matchedRecordingMbid(db, { artistKey: 'a', trackKey: 'bad' })).toBeNull();
      expect(matchedRecordingMbid(db, { artistKey: 'a', trackKey: 'matched' })).toBe(uuid);
      expect(recordingByMbid(db, uuid)).toEqual({ title: 'Song', artistCredit: 'Artist' });
      expect(recordingByMbid(db, 'bad')).toBeNull();
    } finally { db.close(); }
  });
});
