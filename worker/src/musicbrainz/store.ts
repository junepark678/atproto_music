import type { Db } from '../do/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (value: string): boolean => UUID.test(value);

export interface TrackKey {
  artistKey: string;
  trackKey: string;
  albumKey?: string | null;
}

// Local SQLite seam only: these operations never call MusicBrainz or any other
// upstream. Resolution and pacing belong to the timer layer.
export function enqueueTrack(db: Db, key: TrackKey, nowMs: number, priority = 0): void {
  db.run(
    `INSERT OR IGNORE INTO mb_tracks(artist_key,track_key,album_key,created_at_ms,priority)
     VALUES(?,?,?,?,?)`,
    key.artistKey,
    key.trackKey,
    key.albumKey ?? '',
    nowMs,
    priority,
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

export function recordingByMbid(
  db: Db,
  mbid: string,
): { title: string; artistCredit: string } | null {
  if (!isUUID(mbid)) return null;
  const row = db.one<{ title: string | null; artist_credit: string | null }>(
    `SELECT title,artist_credit FROM mb_tracks WHERE status='matched' AND recording_mbid=? LIMIT 1`,
    mbid,
  );
  return row?.title !== null && row?.title !== undefined && row.artist_credit !== null && row.artist_credit !== undefined
    ? { title: row.title, artistCredit: row.artist_credit }
    : null;
}
