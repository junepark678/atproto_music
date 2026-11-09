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

/**
 * Retire live repository-removal intent after a later, accepted projection
 * proves that the same canonical listen incarnation is present again. Keep
 * the row as history so pull suppression remains durable. API (`uri:`)
 * removals are deliberately left active while their operation is pending.
 */
export function archiveMatchingLiveListenTombstones(
  db: Db,
  args: { did: string; uri: string; cid: string; second: number; artistKey: string; trackKey: string },
): void {
  const candidates = db.all<{ identity_key: string }>(
    `SELECT identity_key FROM linked_pull_tombstones WHERE did=? AND kind='listen'
     AND listen_second=? AND artist_key=? AND track_key=?`,
    args.did,
    args.second,
    args.artistKey,
    args.trackKey,
  );
  for (const { identity_key } of candidates) {
    const livePrefix = `live:${args.uri}`;
    const singlePrefix = `single-replaced:${args.uri}`;
    const batchPrefix = `batch-replaced:${args.uri}`;
    const uriPrefix = `uri:${args.uri}`;
    const prefix = [uriPrefix, livePrefix, singlePrefix, batchPrefix].find((candidate) =>
      identity_key.startsWith(candidate),
    );
    if (prefix === undefined) continue;
    const suffix = identity_key.slice(prefix.length);
    // URIs can be prefixes of other URIs; require a CID, batch member, or the
    // exact legacy CID-less identity. A member identity includes #member:CID.
    if (suffix !== '' && !suffix.startsWith(':') && !suffix.startsWith('#member:')) continue;
    if (suffix.startsWith(':') && suffix.slice(1) !== args.cid) continue;
    if (suffix.startsWith('#member:') && suffix.slice('#member:'.length) !== args.cid) continue;
    if (prefix === uriPrefix) {
      const record = db.one<{ record_uri: string | null }>(
        'SELECT record_uri FROM scrobbles WHERE did=? AND uri=?',
        args.did,
        args.uri,
      );
      const recordUri = record?.record_uri ?? args.uri.split('#member:', 1)[0] ?? args.uri;
      const [collection = '', ...rkeyParts] = recordUri.slice(`at://${args.did}/`.length).split('/');
      const pendingApiRemoval = db.one(
        `SELECT 1 FROM operations WHERE did=? AND kind='scrobble.delete' AND collection=? AND rkey=?
         AND state IN ('queued','running','blocked') LIMIT 1`,
        args.did,
        collection,
        rkeyParts.join('/'),
      );
      if (pendingApiRemoval !== null) continue;
    }
    db.run(
      `UPDATE linked_pull_tombstones SET identity_key=?
       WHERE did=? AND kind='listen' AND identity_key=?`,
      `history:${identity_key}`,
      args.did,
      identity_key,
    );
  }
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
