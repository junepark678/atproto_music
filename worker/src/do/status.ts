// Indexing status truth (ADR 0004 §5.5, §6; API.md `indexing`). Ports the Rust
// `index_status::read` / `status_truth` semantics (crates/server/src/http/
// index_status.rs): the reported state is derived from durable evidence on
// every read, never trusted from a stored flag. The `state`, `caught_up` and
// `lag_seconds` columns of the seeded `indexing_status('global', …)` row are
// not consulted, so a stale `current` written there can never leak into a
// response; only its `last_indexed_at` high-water mark (written by
// `noteIndexed` below) is read.
//
// Global state, first matching rule wins:
// 1. `stale` when the effective ingest mode is `off` (nothing follows the
//    firehose, so the index cannot be current; recovery cannot progress).
// 2. `stale` when the upstream has not been followed recently:
//    - socket: `connected=0` for more than SOCKET_STALE_AFTER_MS (5 min);
//    - pulse: the last successful pulse started more than PULSE_STALE_AFTER_MS
//      (two 5-minute pulse intervals) ago, and no pulse is in progress.
//    As in Rust, `stale` is never upgraded to `recovering`.
// 3. `recovering` on first start (no cursor yet), while `pending_gap=1`, or
//    while any gap-recovery snapshot job (`reason = GAP_REASON`) is not
//    complete.
// 4. `current` otherwise.
//
// `caughtUp` is true only when the state is `current`, no hint is due that was
// received more than HINT_GRACE_MS (60 s) ago, no snapshot job is running, and,
// in socket mode, the socket is connected. A dropped socket is a potential gap
// (Rust: `pending_gap || !connected` forces `caught_up=false`), so it is never
// reported caught up, even inside the 5-minute window before it turns `stale`.
// In pulse mode `connected=0` between pulses is the normal state.
//
// `lastIndexedAt` is a monotone high-water mark, never a scan: the greatest
// `indexed_at` ever written, kept in `indexing_status('global').last_indexed_at`
// (global) and `users.indexed_at` (per user) by `noteIndexed`, which every
// projection write (W2-04 applyRecordProof, applySnapshotChunk,
// completeSnapshot) must call in the same transaction as the row it indexes.
// Both reads are a primary-key lookup (O(log n)); a `max(indexed_at)` over
// scrobbles/follows would scan the tables, which have no `indexed_at` index.
//
// `lagSeconds` is `floor((now − last_event_time_us) / 1e6)`, clamped at 0. It is
// null when no event has been received since the current connection opened
// (a quiet stream right after a connect is not "behind"), and null when no
// event was ever received.
//
// Per-user state (`did` given):
// - a `suppression` row or `users.indexing_state='suppressed'` → `suppressed`
//   (caughtUp false, lastIndexedAt null, lagSeconds null);
// - an unknown DID reports the global indexing (the index knows nothing more
//   specific about it);
// - otherwise `users.indexing_state`, raised to `recovering` while that DID has
//   a snapshot job that is not complete (activation, reactivation, PDS
//   migration, coalescing, gap recovery);
// - the user state never reports better than the global state: when the
//   global state is `recovering` or `stale`, a `current` user reports it, and
//   `stale` outranks `recovering` (severity current < recovering < stale);
// - caughtUp: the effective state is `current`, the socket is connected (socket
//   mode), and that DID has no due hint received more than 60 s ago and no
//   running snapshot job;
// - lastIndexedAt is that DID's `users.indexed_at`; lagSeconds is the global
//   ingest lag.
//
// Checkpoint write contract. The stale and lag rules read
// `ingest_checkpoint.updated_at_ms` as "disconnected since" (when
// `connected=0`) and "last event receipt" (when `connected=1`). That meaning
// only holds if every writer of the `jetstream` checkpoint goes through the
// writers exported here, which is binding on W3-04 (enqueueHints' checkpoint
// advance → recordEvent), W4-01 (gap scan / maybeClearGap →
// updateCheckpointBookkeeping), W4-02 (checkpoint.ts: connect → markConnected,
// each message → recordEvent, close/error/pulse end → markDisconnected, host
// rotation → updateCheckpointBookkeeping) and W5-01 (constructor "mark
// disconnected" → markDisconnected):
// - markConnected: `connected=1, connected_at_ms=now, updated_at_ms=now`;
// - recordEvent: `cursor, last_event_time_us, updated_at_ms=receiptMs`, kept
//   strictly after `connected_at_ms` so an event received in the connect
//   millisecond still counts as "received since connect";
// - markDisconnected: `connected=0, updated_at_ms=now`, written on the 1→0
//   transition only, so `updated_at_ms` is the instant the disconnection
//   began and a repeated write (constructor after eviction, a failed
//   reconnect) does not move it. A never-written checkpoint
//   (`updated_at_ms=0`) has no reference instant and is not reported stale
//   (it is first start).
// - updateCheckpointBookkeeping: `pending_gap`, `gap_scan_after_did`,
//   `host_index` and `mode` only; it never touches `updated_at_ms`,
//   `connected`, `connected_at_ms`, `cursor` or `last_event_time_us`.
// - In pulse mode `connected_at_ms` is the start of the last pulse whose
//   connection opened; a failed connect writes nothing.
// - Gap-recovery snapshot jobs carry `repo_jobs.reason = GAP_REASON`.
//
// `indexing` and `internalStatus` are synchronous reads: no write, no await.
// The writers are synchronous and are called inside the caller's `db.tx`.

import type { Indexing, IndexingState } from '@atmusic/core/api-types';
import { fromMs, parseRfc3339, toDto, toStorage } from '@atmusic/core/timestamp';
import type { IngestMode } from '../config';
import type { AdminStatus, RepoJobKind, RepoJobState } from './contracts';
import type { Db } from './db';

export const SOCKET_STALE_AFTER_MS = 5 * 60_000;
/** Pulse cadence: the `jetstream-watchdog` timer in pulse mode (ADR §5.9). */
export const PULSE_INTERVAL_MS = 5 * 60_000;
export const PULSE_STALE_AFTER_MS = 2 * PULSE_INTERVAL_MS;
/** A due hint older than this (by receipt) means the drain is behind. */
export const HINT_GRACE_MS = 60_000;
/** `repo_jobs.reason` of snapshot jobs scheduled by gap recovery (W4-01). */
export const GAP_REASON = 'gap';
/** The ingest_checkpoint stream this module reports. */
export const JETSTREAM_STREAM = 'jetstream';
/** The `indexing_status` row that holds the global `last_indexed_at` high-water mark. */
const GLOBAL_SCOPE = 'global';
/** Snapshot job states that are not complete, spelled out so the lookup seeks `repo_jobs_due`. */
const OPEN_JOB_STATES = `('pending','running','failed')`;

export interface IndexingOptions {
  /** Per-user scope; omitted for the global state. */
  did?: string;
  /** The effective ingest mode (`AppConfig.ingestMode`). */
  mode: IngestMode;
}

// ---------------------------------------------------------------------------
// Writers (the binding write contract; see the header).

/**
 * Raise the `lastIndexedAt` high-water marks to `indexedAtNs`: the global one
 * and, when `did` is given, that user's `users.indexed_at`. Monotone: an older
 * value never lowers either mark. Call it in the same transaction as every
 * projection write that sets a row's `indexed_at`.
 */
export function noteIndexed(db: Db, did: string | null, indexedAtNs: bigint): void {
  const at = toStorage(indexedAtNs);
  db.run(
    'UPDATE indexing_status SET last_indexed_at = ? WHERE scope = ? AND (last_indexed_at IS NULL OR last_indexed_at < ?)',
    at,
    GLOBAL_SCOPE,
    at,
  );
  if (did !== null) {
    db.run('UPDATE users SET indexed_at = ? WHERE did = ? AND (indexed_at IS NULL OR indexed_at < ?)', at, did, at);
  }
}

/** The upstream connection opened (socket connect, or a pulse whose connect succeeded). */
export function markConnected(db: Db, nowMs: number): void {
  db.run(
    'UPDATE ingest_checkpoint SET connected = 1, connected_at_ms = ?, updated_at_ms = ? WHERE stream = ?',
    nowMs,
    nowMs,
    JETSTREAM_STREAM,
  );
}

/**
 * A Jetstream message was received at `receiptMs` (including ignored ones):
 * advance the cursor and record the event time and receipt instant. Call it
 * in the same transaction as the hint enqueue (ADR §5.4).
 */
export function recordEvent(db: Db, event: { cursor: number; timeUs: number }, receiptMs: number): void {
  db.run(
    `UPDATE ingest_checkpoint SET cursor = ?, last_event_time_us = ?,
       updated_at_ms = max(?, coalesce(connected_at_ms, -1) + 1)
     WHERE stream = ?`,
    event.cursor,
    event.timeUs,
    receiptMs,
    JETSTREAM_STREAM,
  );
}

/**
 * The upstream connection closed (close, error, pulse end, or the IndexDO
 * constructor after an eviction). Writes only on the 1→0 transition, so the
 * recorded instant is when the disconnection began. Returns whether it wrote.
 */
export function markDisconnected(db: Db, nowMs: number): boolean {
  return (
    db.one<{ stream: string }>(
      'UPDATE ingest_checkpoint SET connected = 0, updated_at_ms = ? WHERE stream = ? AND connected = 1 RETURNING stream',
      nowMs,
      JETSTREAM_STREAM,
    ) !== null
  );
}

export interface CheckpointBookkeeping {
  pendingGap?: boolean;
  gapScanAfterDid?: string | null;
  hostIndex?: number;
  mode?: IngestMode | null;
}

/**
 * Write checkpoint fields that are not connection or event evidence (gap flag,
 * gap-scan progress, host rotation, mode). Never touches `updated_at_ms`, so
 * none of these writes can move the stale or lag reference instants.
 */
export function updateCheckpointBookkeeping(db: Db, fields: CheckpointBookkeeping): void {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (fields.pendingGap !== undefined) {
    sets.push('pending_gap = ?');
    params.push(fields.pendingGap ? 1 : 0);
  }
  if (fields.gapScanAfterDid !== undefined) {
    sets.push('gap_scan_after_did = ?');
    params.push(fields.gapScanAfterDid);
  }
  if (fields.hostIndex !== undefined) {
    sets.push('host_index = ?');
    params.push(fields.hostIndex);
  }
  if (fields.mode !== undefined) {
    sets.push('mode = ?');
    params.push(fields.mode);
  }
  if (sets.length === 0) return;
  db.run(`UPDATE ingest_checkpoint SET ${sets.join(', ')} WHERE stream = ?`, ...params, JETSTREAM_STREAM);
}

// ---------------------------------------------------------------------------
// Reads.

interface CheckpointRow {
  cursor: number | null;
  last_event_time_us: number | null;
  connected: number;
  pending_gap: number;
  host_index: number;
  connected_at_ms: number | null;
  updated_at_ms: number;
}

/** The seeded checkpoint as migration 1 leaves it, for a missing row. */
const FRESH_CHECKPOINT: CheckpointRow = {
  cursor: null,
  last_event_time_us: null,
  connected: 0,
  pending_gap: 1,
  host_index: 0,
  connected_at_ms: null,
  updated_at_ms: 0,
};

function readCheckpoint(db: Db): CheckpointRow {
  return (
    db.one<CheckpointRow>(
      `SELECT cursor, last_event_time_us, connected, pending_gap, host_index, connected_at_ms, updated_at_ms
       FROM ingest_checkpoint WHERE stream = ?`,
      JETSTREAM_STREAM,
    ) ?? FRESH_CHECKPOINT
  );
}

function exists(db: Db, sql: string, ...p: Array<string | number>): boolean {
  return (db.one<{ e: number }>(`SELECT EXISTS(${sql}) AS e`, ...p)?.e ?? 0) === 1;
}

function upstreamStale(cp: CheckpointRow, nowMs: number, mode: IngestMode): boolean {
  if (mode === 'off') return true;
  if (cp.connected === 1) return false;
  if (mode === 'socket') {
    // Disconnected since the 1→0 write; a never-written checkpoint has no reference.
    if (cp.updated_at_ms <= 0) return false;
    return nowMs - cp.updated_at_ms > SOCKET_STALE_AFTER_MS;
  }
  // pulse: measured from the start of the last successful pulse, or, before the
  // first pulse ever opened, from the first checkpoint write.
  const reference = cp.connected_at_ms ?? (cp.updated_at_ms > 0 ? cp.updated_at_ms : null);
  if (reference === null) return false;
  return nowMs - reference > PULSE_STALE_AFTER_MS;
}

/** Whether the upstream is followed right now: socket mode needs an open socket. */
function upstreamFollowed(cp: CheckpointRow, mode: IngestMode): boolean {
  return mode !== 'socket' || cp.connected === 1;
}

/** Ingest lag in whole seconds, or null when no event arrived since connect. */
export function lagSeconds(
  cp: Pick<CheckpointRow, 'last_event_time_us' | 'connected' | 'connected_at_ms' | 'updated_at_ms'>,
  nowMs: number,
): number | null {
  if (cp.last_event_time_us === null) return null;
  if (cp.connected === 1) {
    // Connected but no event write since the connect write: idle, lag unknown.
    if (cp.connected_at_ms === null || cp.updated_at_ms <= cp.connected_at_ms) return null;
  }
  const lag = Math.floor((nowMs * 1000 - cp.last_event_time_us) / 1_000_000);
  return lag > 0 ? lag : 0;
}

function globalState(db: Db, cp: CheckpointRow, nowMs: number, mode: IngestMode): IndexingState {
  if (upstreamStale(cp, nowMs, mode)) return 'stale';
  if (cp.cursor === null || cp.pending_gap === 1) return 'recovering';
  if (
    exists(
      db,
      `SELECT 1 FROM repo_jobs WHERE kind = 'snapshot' AND state IN ${OPEN_JOB_STATES} AND reason = ?`,
      GAP_REASON,
    )
  ) {
    return 'recovering';
  }
  return 'current';
}

function hintThreshold(nowMs: number): string {
  return toStorage(fromMs(nowMs - HINT_GRACE_MS));
}

/** A stored timestamp DTO-rendered, or null when absent or unparseable. */
function renderTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const ns = parseRfc3339(value);
  return ns === null ? null : toDto(ns);
}

function globalLastIndexedAt(db: Db): string | null {
  return renderTimestamp(
    db.one<{ last_indexed_at: string | null }>(
      'SELECT last_indexed_at FROM indexing_status WHERE scope = ?',
      GLOBAL_SCOPE,
    )?.last_indexed_at,
  );
}

const SEVERITY: Record<Exclude<IndexingState, 'suppressed'>, number> = { current: 0, recovering: 1, stale: 2 };

function worse(
  a: Exclude<IndexingState, 'suppressed'>,
  b: Exclude<IndexingState, 'suppressed'>,
): Exclude<IndexingState, 'suppressed'> {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function globalIndexing(db: Db, cp: CheckpointRow, nowMs: number, mode: IngestMode): Indexing {
  const state = globalState(db, cp, nowMs, mode);
  const caughtUp =
    state === 'current' &&
    upstreamFollowed(cp, mode) &&
    !exists(db, 'SELECT 1 FROM hints WHERE due_at <= ? AND receipt_time < ?', nowMs, hintThreshold(nowMs)) &&
    !exists(db, `SELECT 1 FROM repo_jobs WHERE kind = 'snapshot' AND state = 'running'`);
  return { state, caughtUp, lastIndexedAt: globalLastIndexedAt(db), lagSeconds: lagSeconds(cp, nowMs) };
}

/**
 * The Indexing DTO for the whole index, or for one DID when `did` is given.
 * `nowMs` is epoch milliseconds from the injected clock.
 */
export function indexing(db: Db, nowMs: number, opts: IndexingOptions): Indexing {
  const cp = readCheckpoint(db);
  const global = globalIndexing(db, cp, nowMs, opts.mode);
  if (opts.did === undefined) return global;
  const did = opts.did;

  const suppressed = exists(db, 'SELECT 1 FROM suppression WHERE did = ?', did);
  const user = db.one<{ indexing_state: IndexingState; indexed_at: string | null }>(
    'SELECT indexing_state, indexed_at FROM users WHERE did = ?',
    did,
  );
  if (suppressed || user?.indexing_state === 'suppressed') {
    return { state: 'suppressed', caughtUp: false, lastIndexedAt: null, lagSeconds: null };
  }
  if (user === null) return global;

  let state = user.indexing_state as Exclude<IndexingState, 'suppressed'>;
  if (exists(db, `SELECT 1 FROM repo_jobs WHERE did = ? AND kind = 'snapshot' AND state IN ${OPEN_JOB_STATES}`, did)) {
    state = worse(state, 'recovering');
  }
  // Never better than the global state.
  state = worse(state, global.state as Exclude<IndexingState, 'suppressed'>);

  const caughtUp =
    state === 'current' &&
    upstreamFollowed(cp, opts.mode) &&
    !exists(
      db,
      'SELECT 1 FROM hints WHERE did = ? AND due_at <= ? AND receipt_time < ?',
      did,
      nowMs,
      hintThreshold(nowMs),
    ) &&
    !exists(db, `SELECT 1 FROM repo_jobs WHERE did = ? AND kind = 'snapshot' AND state = 'running'`, did);

  return { state, caughtUp, lastIndexedAt: renderTimestamp(user.indexed_at), lagSeconds: global.lagSeconds };
}

export type InternalStatus = Omit<AdminStatus, 'schema'>;

/**
 * Admin view (`/internal/admin/status`, W5-01 adds the migration result):
 * the global indexing truth, the ingest checkpoint, hint counts, snapshot,
 * status and identity job counts by state, and every counter.
 */
export function internalStatus(db: Db, nowMs: number, opts: { mode: IngestMode }): InternalStatus {
  const cp = readCheckpoint(db);
  const hints = db.one<{ total: number; due: number }>(
    'SELECT count(*) AS total, coalesce(sum(due_at <= ?), 0) AS due FROM hints',
    nowMs,
  ) ?? { total: 0, due: 0 };
  const jobs: Record<RepoJobKind, Partial<Record<RepoJobState, number>>> = { snapshot: {}, status: {}, identity: {} };
  for (const row of db.all<{ kind: RepoJobKind; state: RepoJobState; n: number }>(
    'SELECT kind, state, count(*) AS n FROM repo_jobs GROUP BY kind, state ORDER BY kind, state',
  )) {
    jobs[row.kind][row.state] = row.n;
  }
  const counters = db.all<{ name: string; label: string; value: number }>(
    'SELECT name, label, value FROM counters ORDER BY name, label',
  );
  return {
    indexing: globalIndexing(db, cp, nowMs, opts.mode),
    ingest: {
      mode: opts.mode,
      cursor: cp.cursor,
      lastEventTimeUs: cp.last_event_time_us,
      connected: cp.connected === 1,
      pendingGap: cp.pending_gap === 1,
      hostIndex: cp.host_index,
    },
    hints: { total: hints.total, due: hints.due },
    jobs,
    counters,
  };
}
