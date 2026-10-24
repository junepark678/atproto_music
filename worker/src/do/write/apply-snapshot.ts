// Apply one verified range-snapshot chunk, and complete a snapshot (ADR 0004
// §5.7 steps 6 and 9; ADR 0003 generation semantics). Synchronous; W4-01 calls
// each inside one `db.tx`.
//
// Chunk (`applySnapshotChunk`), all at revision `headRev` (the signed head the
// walk started from):
// - Generation guard: nothing is written unless the DID is known, not
//   suppressed, and `users.generation == generation`. A deactivation or a
//   disconnect during the snapshot therefore stops it (`superseded`).
// - Per-URI guard: an entry whose record_state revision is >= headRev is left
//   alone. A newer live update or delete always wins; an older snapshot never
//   resurrects a newer deletion.
// - Entries with a record body whose CID differs from the stored CID are
//   validated and upserted like a live proof (excluded when invalid). Entries
//   without a body must carry the stored CID (the walker fetched only changed
//   records); anything else is a caller bug and throws, rolling back the tx.
// - Sweep: rows of the DID whose URI is in `(at://did/lo, at://did/hi]`, whose
//   key is absent from the chunk and whose revision is < headRev are deleted
//   and recorded `absent` at headRev.
// - `users.max_rev` is not advanced per chunk; `completeSnapshot` does that.
//   Until then the per-URI guard alone protects the URIs the chunk wrote.
//
// Completion (`completeSnapshot`): if `users.generation == generation` and the
// DID is not suppressed, `active` follows the fresh account status,
// `indexing_state='current'`, `last_snapshot_at_ms`, and
// `max_rev = max(max_rev, headRev)`. Otherwise nothing changes: `superseded`.

import { toMs, toStorage } from '@atmusic/core/timestamp';
import type { Db } from '../db';
import { isSuppressed, loadUser } from './account-state';
import { type ApplyOptions, applyRecordTarget } from './apply-record';
import {
  collectionKind,
  guardRevision,
  readRecordState,
  recordUri,
  splitKey,
  uriCollection,
  writeRecordState,
} from './keys';
import { applySettingsAt } from './suppression';

export interface SnapshotChunkEntry {
  /** `collection/rkey`. */
  key: string;
  /** The record CID at headRev (verified by the walker). */
  cid: string;
  /** The verified record body, present when the walker fetched it. */
  record?: unknown;
}

export interface SnapshotChunk {
  did: string;
  generation: number;
  headRev: string;
  /** Exclusive lower key bound; null for the start of the range. */
  intervalLo: string | null;
  /** Inclusive upper key bound. */
  intervalHi: string;
  /** Strictly ascending keys, all within (intervalLo, intervalHi]. */
  entries: readonly SnapshotChunkEntry[];
  /** When the snapshot data was received: the +300 s validation bound. */
  receiptNs: bigint;
  prefix: string;
  /** Now (injected clock), for indexed_at / verified_at. */
  nowNs: bigint;
}

export interface ChunkResult {
  outcome: 'applied' | 'superseded' | 'suppressed';
  /** Entries written (upserted, excluded) at headRev. */
  written: number;
  /** Entries left alone: CID unchanged, newer live state, or unconfigured collection. */
  unchanged: number;
  /** URIs swept to absent. */
  deleted: number;
}

function superseded(): ChunkResult {
  return { outcome: 'superseded', written: 0, unchanged: 0, deleted: 0 };
}

/** The stored CID of a URI: record_state, else a projection row. */
function storedCid(db: Db, uri: string): string | null {
  const state = readRecordState(db, uri);
  if (state !== null) return state.cid;
  const row = db.one<{ cid: string }>(
    'SELECT cid FROM scrobbles WHERE uri = ? UNION ALL SELECT cid FROM follows WHERE uri = ? LIMIT 1',
    uri,
    uri,
  );
  return row?.cid ?? null;
}

function checkChunk(c: SnapshotChunk): void {
  if (c.intervalLo !== null && !(c.intervalLo < c.intervalHi)) {
    throw new RangeError(`empty snapshot interval (${c.intervalLo}, ${c.intervalHi}]`);
  }
  let prev = c.intervalLo;
  for (const e of c.entries) {
    if ((prev !== null && !(e.key > prev)) || e.key > c.intervalHi) {
      throw new RangeError(`snapshot entry ${e.key} is out of order or outside (${c.intervalLo}, ${c.intervalHi}]`);
    }
    prev = e.key;
  }
}

export function applySnapshotChunk(db: Db, c: SnapshotChunk): ChunkResult {
  checkChunk(c);
  if (isSuppressed(db, c.did)) return superseded();
  const user = loadUser(db, c.did);
  if (user === null || user.generation !== c.generation) return superseded();

  const o: ApplyOptions = { receiptNs: c.receiptNs, prefix: c.prefix, nowNs: c.nowNs };
  const res: ChunkResult = { outcome: 'applied', written: 0, unchanged: 0, deleted: 0 };
  const present = new Set<string>();

  for (const e of c.entries) {
    const { collection, rkey } = splitKey(e.key);
    const uri = recordUri(c.did, collection, rkey);
    present.add(uri);
    const kind = collectionKind(c.prefix, collection);
    const guard = guardRevision(db, uri);
    if (kind === null || (guard !== null && guard >= c.headRev)) {
      res.unchanged++;
      continue;
    }
    const stored = storedCid(db, uri);
    if (e.record === undefined) {
      if (stored !== e.cid) throw new Error(`snapshot entry ${e.key} has no record body and an unknown CID`);
      res.unchanged++;
      continue;
    }
    if (stored === e.cid) {
      res.unchanged++;
      continue;
    }
    const target = { did: c.did, rkey, rev: c.headRev, present: { cid: e.cid, record: e.record } };
    if (kind === 'settings') {
      const s = applySettingsAt(db, target, o, { floor: false });
      if (s.suppressed) return { ...res, outcome: 'suppressed' };
      if (s.outcome === 'ignored' || s.outcome === 'noop_older') {
        res.unchanged++;
        continue;
      }
    } else {
      applyRecordTarget(db, { ...target, kind, collection, uri }, o);
    }
    res.written++;
  }

  // Sweep the interval: rows older than headRev whose key is not in the chunk.
  const lo = c.intervalLo === null ? `at://${c.did}/` : `at://${c.did}/${c.intervalLo}`;
  const hi = `at://${c.did}/${c.intervalHi}`;
  const candidates = db.all<{ uri: string }>(
    `SELECT uri FROM record_state WHERE did = ? AND uri > ? AND uri <= ? AND revision < ? AND state != 'absent'
     UNION SELECT uri FROM scrobbles WHERE did = ? AND uri > ? AND uri <= ? AND revision < ?
     UNION SELECT uri FROM follows WHERE actor = ? AND uri > ? AND uri <= ? AND revision < ?
     ORDER BY uri`,
    ...[c.did, lo, hi, c.headRev],
    ...[c.did, lo, hi, c.headRev],
    ...[c.did, lo, hi, c.headRev],
  );
  for (const { uri } of candidates) {
    if (present.has(uri)) continue;
    const guard = guardRevision(db, uri);
    if (guard !== null && guard >= c.headRev) continue;
    const collection = uriCollection(c.did, uri);
    const kind = collectionKind(c.prefix, collection);
    const rkey = uri.slice(`at://${c.did}/${collection}/`.length);
    if (kind === 'scrobble' || kind === 'follow') {
      applyRecordTarget(db, { did: c.did, kind, collection, rkey, uri, rev: c.headRev, present: null }, o);
    } else {
      // A settings record (or a row of a collection no longer configured):
      // proven absent at headRev. An absent settings record of an
      // unsuppressed user changes no suppression state.
      writeRecordState(db, {
        uri,
        did: c.did,
        collection,
        revision: c.headRev,
        cid: null,
        state: 'absent',
        reason: null,
        verified_at: toStorage(c.nowNs),
      });
    }
    res.deleted++;
  }
  return res;
}

export interface CompleteSnapshotInput {
  did: string;
  generation: number;
  headRev: string;
  /** The fresh getRepoStatus after the walk: active or not. */
  accountActive: boolean;
  /** Now (injected clock) in ns, for last_snapshot_at_ms. */
  nowNs: bigint;
}

export type CompleteResult = { outcome: 'complete'; active: boolean } | { outcome: 'superseded' };

export function completeSnapshot(db: Db, c: CompleteSnapshotInput): CompleteResult {
  if (isSuppressed(db, c.did)) return { outcome: 'superseded' };
  const user = loadUser(db, c.did);
  if (user === null || user.generation !== c.generation) return { outcome: 'superseded' };
  db.run(
    `UPDATE users SET active = ?, account_status = CASE WHEN ? = 1 THEN 'active' ELSE account_status END,
       indexing_state = 'current', last_snapshot_at_ms = ?, indexed_at = ?,
       max_rev = CASE WHEN max_rev IS NULL OR max_rev < ? THEN ? ELSE max_rev END
     WHERE did = ?`,
    c.accountActive ? 1 : 0,
    c.accountActive ? 1 : 0,
    toMs(c.nowNs),
    toStorage(c.nowNs),
    c.headRev,
    c.headRev,
    c.did,
  );
  return { outcome: 'complete', active: c.accountActive };
}
