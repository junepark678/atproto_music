import type { Db } from '../do/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (value: string): boolean => UUID.test(value);
export const MUSICBRAINZ_SEED_CHUNK = 100;
export const MUSICBRAINZ_REVIVE_CHUNK = 100;

export interface TrackKey {
  artistKey: string;
  trackKey: string;
  albumKey?: string | null;
}

// Local SQLite seam only: these operations never call MusicBrainz or any other
// upstream. Resolution and pacing belong to the timer layer.
export function enqueueTrack(
  db: Db,
  key: TrackKey,
  nowMs: number,
  priority = 0,
  submittedRecordingMbid?: string | null,
): void {
  db.run(
    `INSERT OR IGNORE INTO mb_tracks(artist_key,track_key,album_key,created_at_ms,priority,submitted_recording_mbid)
     VALUES(?,?,?,?,?,?)`,
    key.artistKey,
    key.trackKey,
    key.albumKey ?? '',
    nowMs,
    priority,
    submittedRecordingMbid ?? null,
  );
  if (priority > 0) {
    db.run(
      `UPDATE mb_tracks SET priority = ? WHERE artist_key = ? AND track_key = ? AND album_key = ?
       AND status = 'pending' AND priority < ?`,
      priority,
      key.artistKey,
      key.trackKey,
      key.albumKey ?? '',
      priority,
    );
  }
  if (submittedRecordingMbid != null) {
    db.run(
      `UPDATE mb_tracks SET submitted_recording_mbid = ? WHERE artist_key = ? AND track_key = ? AND album_key = ?
       AND status = 'pending' AND submitted_recording_mbid IS NULL`,
      submittedRecordingMbid,
      key.artistKey,
      key.trackKey,
      key.albumKey ?? '',
    );
  }
}

/** Seed at most one deterministic URI window; cursor and insertions commit together. */
export function seedHistoricalTracks(
  db: Db,
  nowMs: number,
  limit = MUSICBRAINZ_SEED_CHUNK,
): { insertedCandidates: number; complete: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MUSICBRAINZ_SEED_CHUNK)
    throw new RangeError('invalid MusicBrainz seed chunk size');
  return db.tx(() => {
    db.run("INSERT OR IGNORE INTO mb_seed_state(singleton,cursor_uri,complete) VALUES(1,'',0)");
    const state = db.one<{ cursor_uri: string; complete: number }>(
      'SELECT cursor_uri,complete FROM mb_seed_state WHERE singleton=1',
    );
    if (!state || state.complete === 1) return { insertedCandidates: 0, complete: true };
    const rows = db.all<{
      uri: string;
      artist_key: string;
      track_key: string;
      album_key: string | null;
      recording_mbid: string | null;
    }>(
      'SELECT uri,artist_key,track_key,album_key,recording_mbid FROM scrobbles WHERE uri>? ORDER BY uri LIMIT ?',
      state.cursor_uri,
      limit,
    );
    if (rows.length === 0) {
      db.run('UPDATE mb_seed_state SET complete=1 WHERE singleton=1');
      return { insertedCandidates: 0, complete: true };
    }
    for (const row of rows)
      enqueueTrack(
        db,
        { artistKey: row.artist_key, trackKey: row.track_key, albumKey: row.album_key },
        nowMs,
        0,
        row.recording_mbid,
      );
    const cursor = rows[rows.length - 1]?.uri;
    if (cursor !== undefined) db.run('UPDATE mb_seed_state SET cursor_uri=? WHERE singleton=1', cursor);
    return { insertedCandidates: rows.length, complete: false };
  });
}

export function matchedRecordingMbid(db: Db, key: TrackKey): string | null {
  const row = db.one<{ status: string; recording_mbid: string | null }>(
    `SELECT status,recording_mbid FROM mb_tracks WHERE artist_key=? AND track_key=? AND album_key=?`,
    key.artistKey,
    key.trackKey,
    key.albumKey ?? '',
  );
  return row?.status === 'matched' && row.recording_mbid && isUUID(row.recording_mbid) ? row.recording_mbid : null;
}

export function recordingByMbid(db: Db, mbid: string): { title: string; artistCredit: string } | null {
  if (!isUUID(mbid)) return null;
  const row = db.one<{ title: string | null; artist_credit: string | null }>(
    `SELECT title,artist_credit FROM mb_tracks WHERE status='matched' AND recording_mbid=? LIMIT 1`,
    mbid,
  );
  return row?.title !== null &&
    row?.title !== undefined &&
    row.artist_credit !== null &&
    row.artist_credit !== undefined
    ? { title: row.title, artistCredit: row.artist_credit }
    : null;
}

/** Return a local entity MBID only when every matching row agrees. */
export function matchedEntityMbid(db: Db, kind: 'artist' | 'release', key: string): string | null {
  const rows = db.all<{ value: string }>(
    kind === 'artist'
      ? `SELECT DISTINCT j.value AS value FROM mb_tracks m, json_each(m.artist_mbids) j WHERE m.status='matched' AND m.artist_key=?`
      : `SELECT DISTINCT release_mbid AS value FROM mb_tracks WHERE status='matched' AND album_key=? AND release_mbid IS NOT NULL`,
    key,
  );
  const values = [...new Set(rows.map((row) => row.value).filter(isUUID))];
  return values.length === 1 ? values[0]! : null;
}

export interface LoveReviveJob extends TrackKey {
  artistKey: string;
  trackKey: string;
  albumKey: string;
  recordingMbid: string;
  matchedAtMs: number;
  createdAtMs: number;
  cursorLinkId: string;
}

/** Stage/restart a bounded revival scan. Call in the match transaction. */
export function stageLoveReviveJob(db: Db, key: TrackKey, recordingMbid: string, nowMs: number): void {
  db.run(
    `INSERT INTO mb_love_revive_jobs(artist_key,track_key,album_key,recording_mbid,matched_at_ms,created_at_ms,cursor_link_id)
    VALUES(?,?,?,?,?,?, '') ON CONFLICT(artist_key,track_key,album_key) DO UPDATE SET
    recording_mbid=excluded.recording_mbid,matched_at_ms=excluded.matched_at_ms,cursor_link_id=''`,
    key.artistKey,
    key.trackKey,
    key.albumKey ?? '',
    recordingMbid,
    nowMs,
    nowMs,
  );
}

/** Read the next deterministic slice for a staged match job. */
export function loveReviveJobs(db: Db, limit = MUSICBRAINZ_REVIVE_CHUNK): LoveReviveJob[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MUSICBRAINZ_REVIVE_CHUNK)
    throw new RangeError('invalid MusicBrainz revival chunk size');
  return db.all<LoveReviveJob>(
    `SELECT artist_key AS artistKey,track_key AS trackKey,album_key AS albumKey,recording_mbid AS recordingMbid,
    matched_at_ms AS matchedAtMs,created_at_ms AS createdAtMs,cursor_link_id AS cursorLinkId
    FROM mb_love_revive_jobs ORDER BY matched_at_ms,artist_key,track_key,album_key LIMIT ?`,
    limit,
  );
}

export function advanceLoveReviveJob(db: Db, key: TrackKey, cursorLinkId: string): void {
  db.run(
    'UPDATE mb_love_revive_jobs SET cursor_link_id=? WHERE artist_key=? AND track_key=? AND album_key=?',
    cursorLinkId,
    key.artistKey,
    key.trackKey,
    key.albumKey ?? '',
  );
}

export function deleteLoveReviveJob(db: Db, key: TrackKey): void {
  db.run(
    'DELETE FROM mb_love_revive_jobs WHERE artist_key=? AND track_key=? AND album_key=?',
    key.artistKey,
    key.trackKey,
    key.albumKey ?? '',
  );
}
