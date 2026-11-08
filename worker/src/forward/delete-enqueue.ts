import type { Db } from '../do/db';
import { canonicalForwardDedupeKey } from '../outbox/forward-key';

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
  },
): number {
  const links = db.all<{ id: string; generation: number; service: string }>(
    'SELECT id,generation,service FROM linked_accounts WHERE did=?',
    args.did,
  );
  let queued = 0;
  for (const link of links) {
    const delivered = db.all<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM forward_outbox WHERE link_id=? AND generation=? AND did=? AND kind='scrobble' AND state='sent'`,
      link.id,
      link.generation,
      args.did,
    );
    if (!delivered.some((row) => canonicalForwardDedupeKey(link.generation, row.dedupe_key) === args.identityKey))
      continue;
    const state = link.service === 'listenbrainz' ? 'queued' : 'unsupported';
    const result = db.run(
      `INSERT OR IGNORE INTO listenbrainz_deletes
      (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,due_at,deadline_at,created_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'${state}',?,?,?,?)`,
      `${link.id}:${args.eventKey}`,
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
