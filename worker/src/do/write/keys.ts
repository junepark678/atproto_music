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
// - ADR 0005 §6.5 (N3-11): `album_artist_key` is the artist music key of a
//   scrobble's `albumArtist`, and `recording_msid` the ListenBrainz MSID of its
//   (artist_key, track_key) (§8.4, packages/core/src/msid.ts). The projection
//   runs synchronously inside `db.tx` and WebCrypto digests are asynchronous,
//   so the MSID's UUIDv5 SHA-1 (FIPS 180-4) is computed by `sha1` below,
//   without node:crypto (this module is also in the Workers bundle, whose
//   guard refuses Node built-ins). SHA-1 here is only the UUIDv5 name hash,
//   never a security primitive. It equals the WebCrypto `recordingMsid` of
//   core (worker/test/node/write/apply-fields.test.ts asserts the equality).
// - The configured collections are `<p>.scrobble`, `<p>.follow`,
//   `<p>.settings` and `<p>.love` (ADR 0005 §6.3, B12).

import { loveCollection } from '@atmusic/core/love';
import { RECORDING_MSID_NAMESPACE } from '@atmusic/core/msid';
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

/** The artist music key of an album artist (ADR 0005 §6.5); throws `MusicKeyError` for an invalid display string. */
export function albumArtistKey(albumArtist: string): string {
  return artistKey(albumArtist);
}

/** FIPS 180-4 SHA-1 of `data` (20 bytes). Synchronous; used only for the UUIDv5 name hash. */
export function sha1(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8;
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + 4 * i);
    for (let i = 16; i < 80; i++) {
      const x = (w[i - 3] as number) ^ (w[i - 8] as number) ^ (w[i - 14] as number) ^ (w[i - 16] as number);
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + (w[i] as number)) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  for (const [i, h] of [h0, h1, h2, h3, h4].entries()) outView.setUint32(4 * i, h);
  return out;
}

const MSID_NAMESPACE_BYTES = Uint8Array.from(RECORDING_MSID_NAMESPACE.replaceAll('-', '').match(/../g) ?? [], (b) =>
  Number.parseInt(b, 16),
);

/**
 * The ListenBrainz `recording_msid` of stored grouping keys (ADR 0005 §8.4):
 * RFC 9562 UUIDv5 under RECORDING_MSID_NAMESPACE of
 * UTF-8(artist_key ‖ U+0000 ‖ track_key), lowercase hyphenated. Synchronous
 * twin of core's `recordingMsidOfKey`.
 */
export function recordingMsidOf(artist_key: string, track_key: string): string {
  if (!artist_key.isWellFormed() || !track_key.isWellFormed()) {
    throw new RangeError('track key contains a lone surrogate');
  }
  const name = new TextEncoder().encode(`${artist_key}\u0000${track_key}`);
  const input = new Uint8Array(MSID_NAMESPACE_BYTES.length + name.length);
  input.set(MSID_NAMESPACE_BYTES, 0);
  input.set(name, MSID_NAMESPACE_BYTES.length);
  const bytes = sha1(input).slice(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export type CollectionKind = 'scrobble' | 'follow' | 'settings' | 'love';

/** Which configured collection `collection` is under `prefix`, or null when it is none of the four. */
export function collectionKind(prefix: string, collection: string): CollectionKind | null {
  const c = collectionsFor(prefix);
  if (collection === c.scrobble) return 'scrobble';
  if (collection === c.follow) return 'follow';
  if (collection === c.settings) return 'settings';
  if (collection === loveCollection(prefix)) return 'love';
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
 * `loves` has no revision column: a love row is only ever written together
 * with its record_state row, which carries the guard.
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
