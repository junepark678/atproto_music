import { toStorage } from '@atmusic/core/timestamp';
import type { Db } from '../do/db';
import { storedForwardDedupeKey } from '../outbox/forward-key';

/** True while another non-removed projection row still represents this canonical listen. */
export function hasCanonicalListenSurvivor(
  db: Db,
  args: { did: string; listenedAt: number; artistKey: string; trackKey: string; excluding?: ReadonlySet<string> },
): boolean {
  const second = BigInt(args.listenedAt) * 1_000_000_000n;
  const rows = db.all<{ uri: string }>(
    `SELECT s.uri FROM scrobbles s WHERE s.did=? AND s.artist_key=? AND s.track_key=?
     AND s.listened_at>=? AND s.listened_at<?`,
    args.did,
    args.artistKey,
    args.trackKey,
    toStorage(second),
    toStorage(second + 1_000_000_000n),
  );
  return rows.some((row) => {
    if (args.excluding?.has(row.uri)) return false;
    // Only tombstones for this exact projected incarnation are removal intent.
    // In particular, a replacement tombstone for an older CID must not hide a
    // newly recreated row at the same AT URI.
    const current = db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE did=? AND uri=?', args.did, row.uri);
    if (current === null) return false;
    return (
      db.one(
        `SELECT 1 FROM linked_pull_tombstones WHERE did=? AND kind='listen' AND identity_key IN (?,?,?,?) LIMIT 1`,
        args.did,
        `uri:${row.uri}:${current.cid}`,
        `live:${row.uri}:${current.cid}`,
        `single-replaced:${row.uri}:${current.cid}`,
        `batch-replaced:${row.uri}:${current.cid}`,
      ) === null
    );
  });
}

/** Enqueue one local deletion only for a ListenBrainz listen proven delivered to that account generation. */
export function enqueueListenDelete(
  db: Db,
  args: {
    did: string;
    identityKey: string;
    eventKey: string;
    listenedAt: number;
    artistKey: string;
    trackKey: string;
    artist: string;
    track: string;
    sourcePath: string;
    now: number;
    excluding?: ReadonlySet<string>;
  },
): number {
  if (hasCanonicalListenSurvivor(db, args)) return 0;
  const links = db.all<{ id: string; generation: number; service: string }>(
    'SELECT id,generation,service FROM linked_accounts WHERE did=?',
    args.did,
  );
  let queued = 0;
  for (const link of links) {
    const delivered = db.one(
      `SELECT 1 FROM forward_outbox WHERE link_id=? AND generation=? AND did=? AND kind='scrobble' AND state='sent' AND dedupe_key=?`,
      link.id,
      link.generation,
      args.did,
      storedForwardDedupeKey(link.generation, args.identityKey),
    );
    if (delivered === null) continue;
    const state = link.service === 'listenbrainz' ? 'queued' : 'unsupported';
    const result = db.run(
      `INSERT OR IGNORE INTO listenbrainz_deletes
      (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,due_at,deadline_at,created_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'${state}',?,?,?,?)`,
      `${link.id}:g${link.generation}:${args.eventKey}`,
      args.eventKey,
      link.id,
      link.generation,
      args.did,
      args.identityKey,
      args.listenedAt,
      args.artistKey,
      args.trackKey,
      args.artist,
      args.track,
      args.sourcePath,
      args.now,
      args.now + 7 * 86400000,
      args.now,
      args.now,
    );
    if (result.rowsWritten) queued++;
  }
  return queued;
}
