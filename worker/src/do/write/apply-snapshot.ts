// Apply one verified range-snapshot chunk, and complete a snapshot (ADR 0004
// §5.7 steps 6 and 9; ADR 0003 generation semantics; ADR 0004 §7.5
// monotonicity). Synchronous; W4-01 calls each inside one `db.tx`.
//
// Chunk (`applySnapshotChunk`), all at revision `headRev` (the signed head the
// walk started from):
// - Generation guard: nothing is written unless the DID is known, not
//   suppressed, has a `repo_jobs(did,'snapshot')` row (as in the Rust oracle,
//   no job means `superseded`) and `users.generation == generation`. A
//   deactivation or a disconnect during the snapshot therefore stops it.
// - Snapshot floor: `repo_jobs.head_rev` is the newest verified head a
//   snapshot of this DID has started from, applied or completed. W4-01 records
//   it when it starts or restarts a walk (only ever raising it: a new head is
//   refused below `users.max_rev`, ADR §7.5), and every accepted chunk and
//   completion raises it to `headRev`. A chunk whose `headRev` is below it is
//   `stale` and changes nothing: the newer head's walk owns the projection. An
//   older snapshot would otherwise delete records present at the newer head
//   (its unchanged entries) or resurrect records deleted before it (URIs it
//   never saw have no record_state). `users.max_rev` is deliberately not the
//   floor here: live proofs raise it during the walk, and the current walk's
//   chunks must still apply (behind the per-URI guard) in that race.
// - Per-URI guard: an entry whose record_state revision is >= headRev is left
//   alone. A newer live update or delete always wins; an older snapshot never
//   resurrects a newer deletion.
// - Entries with a record body whose CID differs from the stored CID are
//   validated and upserted like a live proof (excluded when invalid). Entries
//   without a body must carry the stored CID (the walker fetched only changed
//   records); anything else is a caller bug and throws, rolling back the tx.
// - Entries whose CID equals the stored CID keep their projection row, but
//   their record_state revision is rewritten to headRev (the Rust oracle
//   rewrites every snapshot row to the snapshot revision), so the per-URI
//   guard covers the verified head for them too. A scrobble or batch
//   container is reaffirmed like a live proof of the same bytes
//   (apply-record reaffirmRecordTarget): its projection rows' revisions,
//   verified membership and, across a succeeded removal's cutoff, statistics
//   move to headRev with it, so a later hint at that head is a true no-op.
// - Sweep: rows of the DID whose URI is in `(at://did/lo, at://did/hi]`, whose
//   key is absent from the chunk and whose revision is < headRev are deleted
//   and recorded `absent` at headRev.
// - Per-DID floor: once the guards pass, `users.max_rev = max(max_rev,
//   headRev)` in the same transaction as the chunk's writes. URIs absent at
//   headRev may have no record_state at all, so the per-URI guard alone does
//   not cover the verified head: without the floor a stale-PDS proof at
//   max_rev <= rev < headRev, applied between chunks or before completion,
//   could resurrect a record deleted before headRev. With the floor such a
//   proof is `stale_head`.
//
// - ADR 0005 §6.5 (N3-11): `<p>.love` entries are in the snapshot key range
//   `[<p>., <p>/)` and are applied like scrobbles and follows (validated and
//   upserted into `loves`, excluded when invalid, swept to absent when the
//   chunk no longer holds them); scrobble entries project the §6.2 columns,
//   album_artist_key and recording_msid through apply-record. `loves` has no
//   revision column: its record_state row is the per-URI guard.
// - ADR 0006: a `<p>.scrobbleBatch` container is one record keyed by its
//   fragment-free URI. Its listens' rows carry it in `record_uri`; the sweep
//   deletes every listen of a container absent at headRev (bumping
//   stats_version) exactly like a single, never by fragment URI.
//
// Completion (`completeSnapshot`): if `users.generation == generation`, the
// DID is not suppressed and its snapshot job exists, then a `headRev` below
// the snapshot floor is `stale` and changes nothing (it neither declares the
// account current nor activates it; the newer head's completion does).
// Otherwise `active` follows the fresh account status,
// `indexing_state='current'`, `last_snapshot_at_ms`, and (again, for a
// snapshot with no chunks) `max_rev` and the snapshot floor rise to headRev.
// A generation or suppression mismatch changes nothing: `superseded`.

import type { Random } from '@atmusic/core/deps';
import { toMs, toStorage } from '@atmusic/core/timestamp';
import { lateAccept } from '../../forward/live-acceptance';
import type { Db } from '../db';
import { enqueueHints } from '../ingest/hints';
import { isStale, LIVE_REHINT_DELAY_MS, readLiveEvidence } from '../ingest/live-evidence';
import { noteIndexed } from '../status';
import { isSuppressed, loadUser, raiseMaxRev } from './account-state';
import { type ApplyOptions, applyRecordTarget, reaffirmRecordTarget } from './apply-record';
import {
  type CollectionKind,
  collectionKind,
  guardRevision,
  incrementCounter,
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
  /** Verified head before this walk; missing/unknown floors fail closed for live authority. */
  raceFloorRev?: string | null;
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
  random?: Random;
}

export interface ChunkResult {
  /** `stale`: headRev is below the snapshot floor; nothing changed. */
  outcome: 'applied' | 'superseded' | 'suppressed' | 'stale';
  /** Entries written (upserted, excluded) at headRev. */
  written: number;
  /** Entries left alone: CID unchanged, newer live state, or unconfigured collection. */
  unchanged: number;
  /** URIs swept to absent. */
  deleted: number;
}

function refused(outcome: 'superseded' | 'stale'): ChunkResult {
  return { outcome, written: 0, unchanged: 0, deleted: 0 };
}

type Admission = { ok: true } | { ok: false; outcome: 'superseded' | 'stale' };

/**
 * The guards shared by chunks and completion; reads only. `superseded` for a
 * suppressed or unknown DID, a missing snapshot job or another generation;
 * `stale` for a head below the snapshot floor (`repo_jobs.head_rev`).
 */
function admit(db: Db, did: string, generation: number, headRev: string): Admission {
  if (isSuppressed(db, did)) return { ok: false, outcome: 'superseded' };
  const user = loadUser(db, did);
  if (user === null || user.generation !== generation) return { ok: false, outcome: 'superseded' };
  const job = db.one<{ head_rev: string | null }>(
    "SELECT head_rev FROM repo_jobs WHERE did = ? AND kind = 'snapshot'",
    did,
  );
  if (job === null) return { ok: false, outcome: 'superseded' };
  if (job.head_rev !== null && headRev < job.head_rev) return { ok: false, outcome: 'stale' };
  return { ok: true };
}

/** The accepted head becomes the snapshot floor and the per-DID floor (see above). */
function raiseFloors(db: Db, did: string, headRev: string): void {
  db.run(
    `UPDATE repo_jobs SET head_rev = ? WHERE did = ? AND kind = 'snapshot'
       AND (head_rev IS NULL OR head_rev < ?)`,
    headRev,
    did,
    headRev,
  );
  raiseMaxRev(db, did, headRev);
}

/**
 * An entry verified at headRev with the CID already stored: keep the
 * projection row, move its record_state revision up to headRev (state and
 * reason unchanged). A projection row without record_state is a verified
 * present record.
 */
function reaffirm(
  db: Db,
  c: SnapshotChunk,
  target: { uri: string; collection: string; rkey: string; kind: CollectionKind },
  cid: string,
  canCandidate: boolean,
): void {
  const { uri, collection, rkey, kind } = target;
  if (kind === 'scrobble' || kind === 'scrobbleBatch') {
    // The same bytes at a newer revision: everything a live proof of them
    // writes (projection revisions, membership, statistics), not only the
    // per-URI revision, so a removal cutoff they cross is decided as it would
    // be live and a later hint at this head is truly a no-op.
    const observedEvidence = readLiveEvidence(db, uri, Number(c.nowNs / 1_000_000n));
    // The first admission snapshot represents owned history. Jetstream evidence
    // that happens to match it cannot grant live forwarding authority.
    const evidence = canCandidate ? observedEvidence : null;
    reaffirmRecordTarget(db, { did: c.did, kind, collection, rkey, uri, rev: c.headRev }, cid, {
      receiptNs: c.receiptNs,
      prefix: c.prefix,
      nowNs: c.nowNs,
      ...(c.random
        ? { live: { random: c.random, evidence, legacyRev: null, raceFloorRev: c.raceFloorRev }, liveCandidates: true }
        : {}),
    });
    if (c.random)
      lateAccept(db, {
        uri,
        did: c.did,
        collection,
        rkey,
        evidence,
        raceFloorRev: c.raceFloorRev ?? null,
        nowMs: Number(c.nowNs / 1_000_000n),
        random: c.random,
      });
    return;
  }
  const verifiedAt = toStorage(c.nowNs);
  if (readRecordState(db, uri) === null) {
    writeRecordState(db, {
      uri,
      did: c.did,
      collection,
      revision: c.headRev,
      cid,
      state: 'present',
      reason: null,
      verified_at: verifiedAt,
    });
    return;
  }
  db.run(
    'UPDATE record_state SET revision = ?, verified_at = ? WHERE uri = ? AND revision < ?',
    c.headRev,
    verifiedAt,
    uri,
    c.headRev,
  );
}

/** The stored CID of a URI: record_state, else a projection row. */
function storedCid(db: Db, uri: string): string | null {
  const state = readRecordState(db, uri);
  if (state !== null) return state.cid;
  const row = db.one<{ cid: string }>(
    `SELECT cid FROM scrobbles WHERE uri = ? UNION ALL SELECT cid FROM scrobbles WHERE record_uri = ?
     UNION ALL SELECT cid FROM follows WHERE uri = ? UNION ALL SELECT cid FROM loves WHERE uri = ? LIMIT 1`,
    uri,
    uri,
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
  const admission = admit(db, c.did, c.generation, c.headRev);
  if (!admission.ok) return refused(admission.outcome);
  raiseFloors(db, c.did, c.headRev);

  const o: ApplyOptions = { receiptNs: c.receiptNs, prefix: c.prefix, nowNs: c.nowNs };
  const canCandidate = loadUser(db, c.did)?.last_snapshot_at_ms !== null;
  const res: ChunkResult = { outcome: 'applied', written: 0, unchanged: 0, deleted: 0 };
  const present = new Set<string>();

  for (const e of c.entries) {
    const { collection, rkey } = splitKey(e.key);
    const uri = recordUri(c.did, collection, rkey);
    present.add(uri);
    const kind = collectionKind(c.prefix, collection);
    const observedEvidence = readLiveEvidence(db, uri, Number(c.nowNs / 1_000_000n));
    const evidence = canCandidate ? observedEvidence : null;
    if (isStale(observedEvidence, c.headRev)) {
      const hintRev = [observedEvidence?.up_rev, observedEvidence?.del_rev]
        .filter((rev): rev is string => rev !== null && rev !== undefined)
        .sort()
        .at(-1)!;
      enqueueHints(db, [
        {
          did: c.did,
          collection,
          rkey,
          source: 'reconcile',
          hintRev,
          receiptMs: Number(c.nowNs / 1_000_000n),
          dueAt: Number(c.nowNs / 1_000_000n) + LIVE_REHINT_DELAY_MS,
        },
      ]);
      incrementCounter(db, 'live_admission', 'walk_stale_skip');
      res.unchanged++;
      continue;
    }
    const guard = guardRevision(db, uri);
    if (kind === null) {
      res.unchanged++;
      continue;
    }
    if (guard !== null && guard >= c.headRev) {
      if (
        canCandidate &&
        c.random &&
        evidence?.up_rev !== null &&
        evidence?.up_rev !== undefined &&
        evidence.up_rev <= c.headRev
      )
        lateAccept(db, {
          uri,
          did: c.did,
          collection,
          rkey,
          evidence,
          raceFloorRev: c.raceFloorRev ?? null,
          nowMs: Number(c.nowNs / 1_000_000n),
          random: c.random,
        });
      if (evidence && c.headRev >= (evidence.up_rev ?? '') && c.headRev >= (evidence.del_rev ?? ''))
        db.run('DELETE FROM live_record_evidence WHERE uri=? AND conflict_rev IS NULL', uri);
      res.unchanged++;
      continue;
    }
    const stored = storedCid(db, uri);
    if (e.record === undefined && stored !== e.cid) {
      throw new Error(`snapshot entry ${e.key} has no record body and an unknown CID`);
    }
    if (stored === e.cid) {
      reaffirm(db, c, { uri, collection, rkey, kind }, e.cid, canCandidate);
      if (c.random)
        lateAccept(db, {
          uri,
          did: c.did,
          collection,
          rkey,
          evidence,
          raceFloorRev: c.raceFloorRev ?? null,
          nowMs: Number(c.nowNs / 1_000_000n),
          random: c.random,
        });
      if (evidence && c.headRev >= (evidence.up_rev ?? '') && c.headRev >= (evidence.del_rev ?? ''))
        db.run('DELETE FROM live_record_evidence WHERE uri=? AND conflict_rev IS NULL', uri);
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
      applyRecordTarget(
        db,
        { ...target, kind, collection, uri },
        {
          ...o,
          ...(c.random
            ? {
                live: { random: c.random, evidence, legacyRev: null, raceFloorRev: c.raceFloorRev },
                liveCandidates: canCandidate,
              }
            : {}),
        },
      );
      if (c.random)
        lateAccept(db, {
          uri,
          did: c.did,
          collection,
          rkey,
          evidence,
          raceFloorRev: c.raceFloorRev ?? null,
          nowMs: Number(c.nowNs / 1_000_000n),
          random: c.random,
        });
      if (evidence && c.headRev >= (evidence.up_rev ?? '') && c.headRev >= (evidence.del_rev ?? ''))
        db.run('DELETE FROM live_record_evidence WHERE uri=? AND conflict_rev IS NULL', uri);
    }
    res.written++;
  }
  // Projection rows were stamped with indexed_at: raise the high-water marks (W2-05).
  if (res.written > 0) noteIndexed(db, c.did, c.nowNs);

  // Sweep the interval: rows older than headRev whose key is not in the chunk.
  const lo = c.intervalLo === null ? `at://${c.did}/` : `at://${c.did}/${c.intervalLo}`;
  const hi = `at://${c.did}/${c.intervalHi}`;
  const candidates = db.all<{ uri: string }>(
    `SELECT uri FROM record_state WHERE did = ? AND uri > ? AND uri <= ? AND revision < ? AND state != 'absent'
     UNION SELECT uri FROM scrobbles WHERE did = ? AND record_uri IS NULL AND uri > ? AND uri <= ? AND revision < ?
     UNION SELECT record_uri AS uri FROM scrobbles WHERE did = ? AND record_uri IS NOT NULL AND record_uri > ? AND record_uri <= ? AND revision < ?
     UNION SELECT uri FROM follows WHERE actor = ? AND uri > ? AND uri <= ? AND revision < ?
     UNION SELECT uri FROM loves WHERE did = ? AND uri > ? AND uri <= ?
     ORDER BY uri`,
    ...[c.did, lo, hi, c.headRev],
    ...[c.did, lo, hi, c.headRev],
    ...[c.did, lo, hi, c.headRev],
    ...[c.did, lo, hi, c.headRev],
    ...[c.did, lo, hi],
  );
  for (const { uri } of candidates) {
    if (present.has(uri)) continue;
    const guard = guardRevision(db, uri);
    if (guard !== null && guard >= c.headRev) continue;
    const collection = uriCollection(c.did, uri);
    const kind = collectionKind(c.prefix, collection);
    const rkey = uri.slice(`at://${c.did}/${collection}/`.length);
    const observedEvidence = readLiveEvidence(db, uri, Number(c.nowNs / 1_000_000n));
    const evidence = canCandidate ? observedEvidence : null;
    if (isStale(observedEvidence, c.headRev)) {
      const hintRev = [observedEvidence?.up_rev, observedEvidence?.del_rev]
        .filter((rev): rev is string => rev !== null && rev !== undefined)
        .sort()
        .at(-1)!;
      enqueueHints(db, [
        {
          did: c.did,
          collection,
          rkey,
          source: 'reconcile',
          hintRev,
          receiptMs: Number(c.nowNs / 1_000_000n),
          dueAt: Number(c.nowNs / 1_000_000n) + LIVE_REHINT_DELAY_MS,
        },
      ]);
      incrementCounter(db, 'live_admission', 'walk_stale_skip');
      res.unchanged++;
      continue;
    }
    if (kind === 'scrobble' || kind === 'scrobbleBatch' || kind === 'follow' || kind === 'love') {
      // A batch container is swept as one record: every projected listen of
      // it is deleted and stats_version moves (apply-record deleteProjection).
      applyRecordTarget(
        db,
        { did: c.did, kind, collection, rkey, uri, rev: c.headRev, present: null },
        {
          ...o,
          ...(c.random
            ? {
                live: { random: c.random, evidence, legacyRev: null, raceFloorRev: c.raceFloorRev },
                liveCandidates: canCandidate,
              }
            : {}),
        },
      );
      if (c.random)
        lateAccept(db, {
          uri,
          did: c.did,
          collection,
          rkey,
          evidence,
          raceFloorRev: c.raceFloorRev ?? null,
          nowMs: Number(c.nowNs / 1_000_000n),
          random: c.random,
        });
      if (evidence && c.headRev >= (evidence.up_rev ?? '') && c.headRev >= (evidence.del_rev ?? ''))
        db.run('DELETE FROM live_record_evidence WHERE uri=? AND conflict_rev IS NULL', uri);
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

export type CompleteResult = { outcome: 'complete'; active: boolean } | { outcome: 'superseded' | 'stale' };

export function completeSnapshot(db: Db, c: CompleteSnapshotInput): CompleteResult {
  const admission = admit(db, c.did, c.generation, c.headRev);
  if (!admission.ok) return { outcome: admission.outcome };
  db.run(
    `UPDATE users SET active = ?, account_status = CASE WHEN ? = 1 THEN 'active' ELSE account_status END,
       indexing_state = 'current', last_snapshot_at_ms = ?
     WHERE did = ?`,
    c.accountActive ? 1 : 0,
    c.accountActive ? 1 : 0,
    toMs(c.nowNs),
    c.did,
  );
  noteIndexed(db, c.did, c.nowNs);
  raiseFloors(db, c.did, c.headRev);
  // A completed snapshot can add eligible repository history beyond a link's
  // existing keyset cursor (or after it reached done). Schedule a fresh scan
  // durably; the run revision fences any async page still in flight.
  db.run(
    `DELETE FROM link_backfill_items WHERE link_id IN
       (SELECT id FROM linked_accounts WHERE did=? AND status='active' AND forward_scrobbles=1)`,
    c.did,
  );
  db.run(
    `UPDATE linked_accounts SET backfill_state='pending', backfill_cursor=NULL, backfill_total=0, backfill_done=0,
       backfill_failures=0, backfill_next_attempt_ms=NULL, backfill_run_revision=backfill_run_revision+1,
       backfill_discovery_cursor=NULL, backfill_discovery_done=0, backfill_last_error=NULL
     WHERE did=? AND status='active' AND forward_scrobbles=1`,
    c.did,
  );
  return { outcome: 'complete', active: c.accountActive };
}
