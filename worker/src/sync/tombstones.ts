import type { Db } from '../do/db';

export function tombstoneListen(
  db: Db,
  args: {
    did: string;
    identity: string;
    second: number | null;
    artistKey: string | null;
    trackKey: string | null;
    nowMs: number;
  },
): void {
  db.run(
    `INSERT INTO linked_pull_tombstones(did,kind,identity_key,listen_second,artist_key,track_key,created_at_ms)
    VALUES(?,'listen',?,?,?,?,?) ON CONFLICT(did,kind,identity_key) DO NOTHING`,
    args.did,
    args.identity,
    args.second,
    args.artistKey,
    args.trackKey,
    args.nowMs,
  );
}

export function tombstoneLove(
  db: Db,
  args: { did: string; identity: string; loveKey: string; recordingMbid: string | null; nowMs: number },
): void {
  db.run(
    `INSERT INTO linked_pull_tombstones(did,kind,identity_key,love_key,recording_mbid,created_at_ms)
    VALUES(?,'love',?,?,?,?) ON CONFLICT(did,kind,identity_key) DO NOTHING`,
    args.did,
    args.identity,
    args.loveKey,
    args.recordingMbid,
    args.nowMs,
  );
}

export function isListenTombstoned(
  db: Db,
  did: string,
  second: number,
  artistKey?: string | null,
  trackKey?: string | null,
): boolean {
  return (
    db.one(
      `SELECT 1 FROM linked_pull_tombstones WHERE did=? AND kind='listen' AND listen_second=?
    AND (artist_key IS NULL OR ? IS NULL OR artist_key=?) AND (track_key IS NULL OR ? IS NULL OR track_key=?) LIMIT 1`,
      did,
      second,
      artistKey ?? null,
      artistKey ?? null,
      trackKey ?? null,
      trackKey ?? null,
    ) !== null
  );
}

export function isLoveTombstoned(db: Db, did: string, loveKey: string, recordingMbid: string | null): boolean {
  return (
    db.one(
      `SELECT 1 FROM linked_pull_tombstones WHERE did=? AND kind='love' AND (love_key=? OR (? IS NOT NULL AND recording_mbid=?)) LIMIT 1`,
      did,
      loveKey,
      recordingMbid,
      recordingMbid,
    ) !== null
  );
}
