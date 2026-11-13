import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import type { Db } from '../do/db';
import { noteForwardLoveCurrent } from './love-lanes';

function displayKeys(text: string): { artistKey: string; trackKey: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.artist !== 'string' || typeof record.track !== 'string') return null;
  let keys: readonly [string, string];
  try {
    keys = trackKey(record.artist, record.track);
  } catch (error) {
    if (error instanceof MusicKeyError) return null;
    throw error;
  }
  return { artistKey: keys[0], trackKey: keys[1] };
}

/** Normalizes a retained love row in any lifecycle state; caller owns its scan transaction. */
export function normalizeForwardLoveKeys(db: Db, row: { rowid: number; linkId: string; payloadJson: string }): void {
  const keys = displayKeys(row.payloadJson);
  if (!keys) return;
  db.run(
    `UPDATE forward_outbox SET love_artist_key=?,love_track_key=?,
       love_lane=CASE WHEN love_artist_key IS ? AND love_track_key IS ? THEN love_lane ELSE NULL END
     WHERE rowid=?`,
    keys.artistKey,
    keys.trackKey,
    keys.artistKey,
    keys.trackKey,
    row.rowid,
  );
  noteForwardLoveCurrent(db, row.linkId, keys.artistKey, keys.trackKey, row.rowid);
}

function components(text: string | null): { artistKey: string; trackKey: string; recordingMbid: string } | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.artist !== 'string' ||
    typeof record.track !== 'string' ||
    typeof record.recordingMbid !== 'string' ||
    record.recordingMbid.trim() === ''
  )
    return null;
  let keys: readonly [string, string];
  try {
    keys = trackKey(record.artist, record.track);
  } catch (error) {
    if (error instanceof MusicKeyError) return null;
    throw error;
  }
  return { artistKey: keys[0], trackKey: keys[1], recordingMbid: record.recordingMbid };
}

/** Indexes an immutable retained forward love; callers invoke in the insert transaction. */
export function indexForwardLoveTarget(
  db: Db,
  row: { rowid: number; linkId: string; generation: number; createdAtMs: number; payloadJson: string },
): void {
  const target = components(row.payloadJson);
  if (!target) return;
  db.run(
    `INSERT OR IGNORE INTO forward_love_recording_targets
      (forward_rowid,link_id,generation,artist_key,track_key,created_at_ms,recording_mbid)
     VALUES(?,?,?,?,?,?,?)`,
    row.rowid,
    row.linkId,
    row.generation,
    target.artistKey,
    target.trackKey,
    row.createdAtMs,
    target.recordingMbid,
  );
}

/** Indexes a durable love.put operation with the timestamp used by legacy selection. */
export function indexLoveOperationTarget(
  db: Db,
  row: { rowid: number; did: string; createdAtMs: number; recordJson: string | null },
): void {
  const target = components(row.recordJson);
  if (!target) return;
  db.run(
    `INSERT OR IGNORE INTO forward_love_operation_targets
      (operation_rowid,did,artist_key,track_key,created_at_ms,recording_mbid)
     VALUES(?,?,?,?,?,?)`,
    row.rowid,
    row.did,
    target.artistKey,
    target.trackKey,
    row.createdAtMs,
    target.recordingMbid,
  );
}
