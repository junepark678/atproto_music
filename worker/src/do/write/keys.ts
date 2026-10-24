// Projection keys (ADR 0004 §5.4, §5.7, §6.1). Synchronous helpers shared by
// the apply modules; every caller runs inside `db.tx`.
//
// - Music grouping keys: @atmusic/core/music-key (W1-02) computes them; this
//   module maps them to the `scrobbles` columns. `artist_key` is the
//   normalized artist; `track_key` and `album_key` hold the normalized track
//   and album components of the typed tuple keys, so grouping by
//   (artist_key, track_key) or (artist_key, album_key) is grouping by the tuple
//   (the Rust projection stores exactly these components, crates/atproto
//   src/sync/apply.rs). An omitted album has no key (no album bucket).
// - The per-URI guard: `record_state(uri)` holds the newest verified revision
//   of every URI this index has seen, present, absent or excluded. An older
//   proof can never overwrite or resurrect it.
// - Record keys: a snapshot entry key is `collection/rkey`; its URI is
//   `at://<did>/<key>`. NSIDs and record keys are ASCII, so URI text order
//   (SQLite BINARY) equals key order for one DID.

import { albumKey, artistKey, trackKey } from '@atmusic/core/music-key';
import { collectionsFor } from '@atmusic/core/namespace';
import { formatAtUri } from '@atmusic/core/syntax';
import type { Db } from '../db';

export interface MusicKeyColumns {
  artist_key: string;
  track_key: string;
  album_key: string | null;
}

/** The grouping key columns of one scrobble. Throws `MusicKeyError` for an invalid display string. */
export function musicKeyColumns(artist: string, track: string, album: string | null): MusicKeyColumns {
  const track_ = trackKey(artist, track);
  const album_ = albumKey(artist, album);
  return { artist_key: artistKey(artist), track_key: track_[1], album_key: album_ === null ? null : album_[1] };
}

export type CollectionKind = 'scrobble' | 'follow' | 'settings';

/** Which configured collection `collection` is under `prefix`, or null when it is none of the three. */
export function collectionKind(prefix: string, collection: string): CollectionKind | null {
  const c = collectionsFor(prefix);
  if (collection === c.scrobble) return 'scrobble';
  if (collection === c.follow) return 'follow';
  if (collection === c.settings) return 'settings';
  return null;
}

/** `at://<did>/<collection>/<rkey>`; throws a RangeError on invalid syntax. */
export function recordUri(did: string, collection: string, rkey: string): string {
  return formatAtUri(did, collection, rkey);
}

/** Split a snapshot entry key `collection/rkey`. */
export function splitKey(key: string): { collection: string; rkey: string } {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1 || key.indexOf('/', slash + 1) !== -1) {
    throw new RangeError(`not a collection/rkey key: ${JSON.stringify(key)}`);
  }
  return { collection: key.slice(0, slash), rkey: key.slice(slash + 1) };
}

/** The collection segment of a record URI of `did`. */
export function uriCollection(did: string, uri: string): string {
  const base = `at://${did}/`;
  if (!uri.startsWith(base)) throw new RangeError(`URI ${uri} is not owned by ${did}`);
  return splitKey(uri.slice(base.length)).collection;
}

export type RecordStateKind = 'present' | 'absent' | 'excluded';

export interface RecordStateRow {
  uri: string;
  did: string;
  collection: string;
  revision: string;
  cid: string | null;
  state: RecordStateKind;
  reason: string | null;
  verified_at: string;
}

export function readRecordState(db: Db, uri: string): RecordStateRow | null {
  return db.one<RecordStateRow>(
    'SELECT uri, did, collection, revision, cid, state, reason, verified_at FROM record_state WHERE uri = ?',
    uri,
  );
}

/** Upsert the per-URI state. Callers have already checked the revision guard. */
export function writeRecordState(db: Db, row: RecordStateRow): void {
  db.run(
    `INSERT INTO record_state(uri, did, collection, revision, cid, state, reason, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET did = excluded.did, collection = excluded.collection,
       revision = excluded.revision, cid = excluded.cid, state = excluded.state,
       reason = excluded.reason, verified_at = excluded.verified_at`,
    row.uri,
    row.did,
    row.collection,
    row.revision,
    row.cid,
    row.state,
    row.reason,
    row.verified_at,
  );
}

/**
 * The newest revision this index holds for `uri`: record_state, or a
 * projection row (which always has a record_state row when written by these
 * modules; the max keeps the guard monotonic even if one were missing).
 */
export function guardRevision(db: Db, uri: string): string | null {
  const row = db.one<{ rev: string | null }>(
    `SELECT max(rev) AS rev FROM (
       SELECT revision AS rev FROM record_state WHERE uri = ?
       UNION ALL SELECT revision FROM scrobbles WHERE uri = ?
       UNION ALL SELECT revision FROM follows WHERE uri = ?)`,
    uri,
    uri,
    uri,
  );
  return row?.rev ?? null;
}

/** Counter name for excluded remote records; the label is the reason (ADR 0004 §5.4). */
export const EXCLUDED_COUNTER = 'excluded';

/** `counters(name, label) += 1`. */
export function incrementCounter(db: Db, name: string, label: string): void {
  db.run(
    `INSERT INTO counters(name, label, value) VALUES (?, ?, 1)
     ON CONFLICT(name, label) DO UPDATE SET value = value + 1`,
    name,
    label,
  );
}
