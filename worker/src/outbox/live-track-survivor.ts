import type { Db } from '../do/db';

/** Exact canonical-key lookup backed by loves_owner_track; returns at most one row. */
export const PRESENT_TRACK_LOVE_SQL = `SELECT 1 AS hit FROM loves INDEXED BY loves_owner_track
  WHERE did=? AND artist_key=? AND track_key=? LIMIT 1`;

export function hasPresentTrackLove(db: Db, did: string, artistKey: string, trackKey: string): boolean {
  return db.one(PRESENT_TRACK_LOVE_SQL, did, artistKey, trackKey) !== null;
}
