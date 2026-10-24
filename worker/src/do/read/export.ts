// Public export of one DID's indexed public records (ADR 0004 §9.2 A9, §9.4
// N3; API.md `/api/v1/users/{did}/export`). Ports
// crates/storage/src/repositories/export.rs `export_account_with_relay`, now
// public instead of owner-authenticated.
//
// `{schemaVersion: 1, did, exportedAt, indexing, scrobbles, follows}` is read
// in ONE synchronous transaction, so the records and the indexing metadata are
// a single consistent snapshot:
// - unknown, inactive or suppressed DID: null (404);
// - scrobbles: the DID's visible rows, `(listened_at, uri)` DESC, as the
//   public Scrobble DTO (stored columns verbatim; absent optionals omitted;
//   music grouping keys never serialised);
// - follows: the DID's representative visible edges (follows.ts), newest
//   first, as the public Follow DTO; an edge to a subject DID this index has
//   never seen is kept (Rust export.rs hides only suppressed or inactive
//   subjects);
// - indexing: the per-DID truth (status.ts);
// - exportedAt: the injected clock, rendered as every response timestamp.
// Only `scrobbles`, `follows` and `users` are read: no record_state reasons,
// hints, jobs, identity cache, counters or configuration can reach the body,
// and the server holds no credentials to leak (A3).

import type { Export, Scrobble } from '@atmusic/core/api-types';
import { fromMs, toDto } from '@atmusic/core/timestamp';
import type { ModuleDeps, ScrobbleRow } from '../contracts';
import type { Db } from '../db';
import { indexing } from '../status';
import { allFollowing, followToDto } from './follows';
import { activeUser, visibleScrobblesFrom } from './visibility';

export const EXPORT_SCHEMA_VERSION = 1;

const SCROBBLE_COLUMNS =
  's.uri, s.cid, s.did, s.rkey, s.revision, s.artist, s.track, s.album, s.listened_at, s.created_at, ' +
  's.duration_seconds, s.recording_mbid, s.indexed_at, s.artist_key, s.track_key, s.album_key';

/** The public Scrobble DTO, field for field the Rust `ScrobbleRow` serialisation. */
export function scrobbleToDto(row: ScrobbleRow): Scrobble {
  // Rust field order; absent optionals are omitted (skip_serializing_if).
  return {
    uri: row.uri,
    cid: row.cid,
    did: row.did,
    revision: row.revision,
    artist: row.artist,
    track: row.track,
    ...(row.album === null ? {} : { album: row.album }),
    listenedAt: row.listened_at,
    createdAt: row.created_at,
    ...(row.duration_seconds === null ? {} : { durationSeconds: row.duration_seconds }),
    ...(row.recording_mbid === null ? {} : { recordingMbid: row.recording_mbid }),
    indexedAt: row.indexed_at,
  };
}

function visibleUser(db: Db, did: string): boolean {
  return db.one<{ did: string }>(`SELECT u.did FROM users u WHERE u.did = ? AND ${activeUser('u')}`, did) !== null;
}

/** IndexRpc.exportUser: null (404) for unknown, inactive or suppressed users. */
export function exportUser(m: ModuleDeps, did: string): Export | null {
  const nowMs = m.clock.nowMs();
  const mode = m.config.ingestMode;
  return m.db.tx((): Export | null => {
    if (!visibleUser(m.db, did)) return null;
    const scrobbles = m.db.all<ScrobbleRow>(
      `SELECT ${SCROBBLE_COLUMNS} FROM ${visibleScrobblesFrom('s', 'u')} WHERE s.did = ?
       ORDER BY s.listened_at DESC, s.uri DESC`,
      did,
    );
    const follows = allFollowing(m.db, did);
    return {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      did,
      exportedAt: toDto(fromMs(nowMs)),
      indexing: indexing(m.db, nowMs, { did, mode }),
      scrobbles: scrobbles.map(scrobbleToDto),
      follows: follows.map(followToDto),
    };
  });
}
