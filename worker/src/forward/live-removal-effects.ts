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
  // Tombstones do not change scrobbles, and the full exclusion set stays fixed
  // for this synchronous invocation. The first result therefore remains valid
  // for every member with the same canonical tuple.
  const survivorByCanonical = new Map<string, boolean>();
  const enqueuedEventKeys = new Set<string>();
  let queued = 0;
  for (const row of args.rows) {
    const listenedAt = Math.floor(Date.parse(row.listened_at) / 1000);
    const canonicalKey = JSON.stringify([args.did, listenedAt, row.artist_key, row.track_key]);
    let hasSurvivor = survivorByCanonical.get(canonicalKey);
    if (hasSurvivor === undefined) {
      hasSurvivor = hasCanonicalListenSurvivor(db, {
        did: args.did,
        listenedAt,
        artistKey: row.artist_key,
        trackKey: row.track_key,
        excluding,
      });
      survivorByCanonical.set(canonicalKey, hasSurvivor);
    }
    if (hasSurvivor) continue;
    tombstoneListen(db, {
      did: args.did,
      identity: args.tombstoneIdentity(row),
      second: listenedAt,
      artistKey: row.artist_key,
      trackKey: row.track_key,
      nowMs: args.now,
    });
    const identityKey = args.identity(row);
    const eventKey = `${identityKey}:${row.cid}:rev:${args.authRev}`;
    if (enqueuedEventKeys.has(eventKey)) continue;
    enqueuedEventKeys.add(eventKey);
    queued += enqueueListenDelete(db, {
      did: args.did,
      identityKey,
      eventKey,
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
      survivorAlreadyChecked: true,
    });
  }
  return queued;
}
