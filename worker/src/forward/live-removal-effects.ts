import type { Db } from '../do/db';
import { tombstoneListen } from '../sync/tombstones';
import { enqueueListenDelete, hasCanonicalListenSurvivor } from './delete-enqueue';

export interface LiveRemovedListen {
  uri: string;
  cid: string;
  listened_at: string;
  artist_key: string;
  track_key: string;
  artist: string;
  track: string;
  recording_mbid: string | null;
}

/** Shared direct and delayed live removal path; exclusion always covers the complete removed set. */
export function executeListenRemovals(
  db: Db,
  args: {
    did: string;
    rows: readonly LiveRemovedListen[];
    authRev: string;
    authUri?: string;
    now: number;
    identity: (row: LiveRemovedListen) => string;
    tombstoneIdentity: (row: LiveRemovedListen) => string;
  },
): number {
  const excluding = new Set(args.rows.map((row) => row.uri));
  let queued = 0;
  for (const row of args.rows) {
    const listenedAt = Math.floor(Date.parse(row.listened_at) / 1000);
    if (
      hasCanonicalListenSurvivor(db, {
        did: args.did,
        listenedAt,
        artistKey: row.artist_key,
        trackKey: row.track_key,
        excluding,
      })
    )
      continue;
    tombstoneListen(db, {
      did: args.did,
      identity: args.tombstoneIdentity(row),
      second: listenedAt,
      artistKey: row.artist_key,
      trackKey: row.track_key,
      nowMs: args.now,
    });
    queued += enqueueListenDelete(db, {
      did: args.did,
      identityKey: args.identity(row),
      eventKey: `${args.identity(row)}:${row.cid}:rev:${args.authRev}`,
      listenedAt,
      artistKey: row.artist_key,
      trackKey: row.track_key,
      artist: row.artist,
      track: row.track,
      sourcePath: 'live',
      authorizationUri: args.authUri,
      authorizationRev: args.authRev,
      now: args.now,
      excluding,
    });
  }
  return queued;
}
