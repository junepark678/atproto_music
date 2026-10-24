// Bounded admission of new DIDs and snapshot scheduling (ADR 0004 §5.4 step 2,
// §5.7; ADR 0003 generation semantics; Rust oracle
// crates/storage/src/repositories/backfill.rs `discover_repository`,
// `request_backfill`). Synchronous; each exported writer is its own `db.tx`
// (DO transactionSync nests as a savepoint, so callers may also run them inside
// a larger transaction).
//
// admit(db, did, source, now):
// - a suppressed DID is never admitted (`suppressed`); a DID with a users row
//   is `known` (its account policy is left alone, as in the oracle);
// - two bounds, checked before anything is written:
//   - the hourly budget (default 50 new DIDs per fixed clock-hour window,
//     `admission(window_start_ms, admitted)`, injected clock);
//   - at most 1,024 pending snapshot jobs (`repo_jobs` kind snapshot, state
//     pending or failed: the queued work; the one running slice is not queued),
//     the oracle's `queued >= 1024` bound;
//   either one exhausted gives `busy` and writes nothing at all;
// - otherwise, in one transaction: a fresh global generation, `users(active=0,
//   indexing_state='recovering', generation)`, `repo_jobs(snapshot, pending,
//   generation, reason='admission')`, the window count, and
//   `counters('admitted', source)`. The hint that caused it is never projected:
//   activation needs a complete snapshot (W4-01 `completeSnapshot`).
//
// scheduleSnapshot(db, did, reason, now) — sweeps, gap recovery, coalescing,
// proof errors (no_proof, missing_block, unparseable CAR, give-up):
// - only for a known, unsuppressed DID (`unknown` / `suppressed` otherwise:
//   an unknown DID goes through `admit`);
// - the job runs at the user's current generation; the users row is never
//   written, so a deactivation (which moves the generation) still supersedes
//   it, and a proof rejection that schedules a snapshot leaves `users`
//   byte-identical (ADR §7.6);
// - no job, or a complete one: (re)created `pending`, due now, with `reason`,
//   a cleared frontier, restarts, attempts and failure; subject to the 1,024
//   pending cap (`busy`, nothing written);
// - an open job (pending, running or failed) is restarted at the newest head:
//   `state='pending'`, due now, `frontier_json` and `head_cid` cleared, reason
//   kept (a failed job also has its failure cleared). Every caller replaces
//   hints by this snapshot (coalescing deletes them; give-up, record_not_found,
//   stale_head, no_proof, missing_block delete the one hint), so the snapshot
//   must cover records written after any head an earlier walk started from: a
//   walk that resumed its old frontier (pending between slices or after a
//   backoff) or a running slice that kept going would finish at that older
//   head and never apply those records or deletes.
// - Walk epoch: when the job's walk had started (running, or a frontier or
//   head is persisted) the restart increments `restarts`, the walk epoch W4-01
//   compare-and-sets on (the W4-01 entry of docs/planning/workers-waves.json
//   holds the contract): every write of an in-flight slice (frontier, head,
//   state, applySnapshotChunk, completion) requires the row to still be
//   `running` with the generation, `restarts` and `head_cid` that slice
//   claimed, so a slice in flight across this restart writes nothing. A job
//   whose walk has not started keeps its `restarts`; a failed job (no slice
//   can be in flight) starts a fresh attempt at `restarts = 0`.
// - In every case `reactivate` is preserved (OR-ed with `o.reactivate`, never
//   cleared) and `head_rev`, the snapshot floor (apply-snapshot.ts), is kept.
//   The reason of an open job is kept so a gap-recovery job (`GAP_REASON`)
//   stays one until it completes (indexing() reads it).
//
// scheduleStatusCheck(db, did, reason, now) — a `status` repo job (the drain
// creates it on RepoDeactivated / RepoTakendown / RepoSuspended / RepoNotFound;
// W4-03 runs it). Known, unsuppressed DIDs only; not capped (one row per DID).

import { fromMs, toStorage } from '@atmusic/core/timestamp';
import type { RepoJobState } from '../contracts';
import type { Db } from '../db';
import { allocateGeneration, isSuppressed, loadUser } from '../write/account-state';
import { incrementCounter } from '../write/keys';

export const ADMISSION_HOURLY_BUDGET = 50;
export const MAX_PENDING_SNAPSHOT_JOBS = 1024;
export const ADMISSION_WINDOW_MS = 3_600_000;
export const ADMISSION_REASON = 'admission';
export const ADMITTED_COUNTER = 'admitted';
export const SNAPSHOT_SCHEDULED_COUNTER = 'snapshot_scheduled';

export type AdmissionSource = 'jetstream' | 'notify' | 'reconcile' | 'discovery' | 'settings';

export interface AdmissionLimits {
  hourlyBudget?: number;
  pendingCap?: number;
}

export type BusyReason = 'hourly_budget' | 'pending_cap';

export type AdmitResult =
  | { status: 'admitted'; generation: number }
  | { status: 'busy'; reason: BusyReason }
  | { status: 'known' }
  | { status: 'suppressed' };

function assertEpochMs(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer of epoch ms, got ${value}`);
  }
}

function limitOf(value: number | undefined, fallback: number, label: string): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return v;
}

/** Start of the fixed admission window containing `now`. */
export function admissionWindow(now: number): number {
  return now - (now % ADMISSION_WINDOW_MS);
}

/** Snapshot jobs queued for other DIDs (pending or failed), the 1,024 bound. */
export function pendingSnapshotJobs(db: Db, exceptDid: string | null = null): number {
  return (
    db.one<{ n: number }>(
      `SELECT count(*) AS n FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','failed') AND did != ?`,
      exceptDid ?? '',
    )?.n ?? 0
  );
}

/** New DIDs admitted in the window containing `now`. */
export function admittedThisWindow(db: Db, now: number): number {
  return (
    db.one<{ admitted: number }>('SELECT admitted FROM admission WHERE window_start_ms = ?', admissionWindow(now))
      ?.admitted ?? 0
  );
}

/** Admit an unknown DID: an inactive users row plus a pending snapshot job, or nothing. */
export function admit(
  db: Db,
  did: string,
  source: AdmissionSource,
  now: number,
  limits: AdmissionLimits = {},
): AdmitResult {
  assertEpochMs('now', now);
  const hourlyBudget = limitOf(limits.hourlyBudget, ADMISSION_HOURLY_BUDGET, 'hourlyBudget');
  const pendingCap = limitOf(limits.pendingCap, MAX_PENDING_SNAPSHOT_JOBS, 'pendingCap');
  return db.tx((): AdmitResult => {
    if (isSuppressed(db, did)) return { status: 'suppressed' };
    if (loadUser(db, did) !== null) return { status: 'known' };
    // Both bounds are read before the first write, so `busy` writes nothing.
    if (admittedThisWindow(db, now) >= hourlyBudget) return { status: 'busy', reason: 'hourly_budget' };
    if (pendingSnapshotJobs(db, did) >= pendingCap) return { status: 'busy', reason: 'pending_cap' };

    const window = admissionWindow(now);
    const generation = allocateGeneration(db);
    db.run(
      `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
       VALUES (?, ?, 0, 'unknown', 'recovering', ?)`,
      did,
      toStorage(fromMs(now)),
      generation,
    );
    // A leftover job row of this DID (none is expected: disconnect deletes them) is replaced.
    db.run(
      `INSERT INTO repo_jobs(did, kind, state, generation, reason, due_at, updated_at_ms)
       VALUES (?, 'snapshot', 'pending', ?, ?, ?, ?)
       ON CONFLICT(did, kind) DO UPDATE SET state = 'pending', generation = excluded.generation,
         reason = excluded.reason, frontier_json = NULL, restarts = 0, attempts = 0, failure_code = NULL,
         due_at = excluded.due_at, updated_at_ms = excluded.updated_at_ms`,
      did,
      generation,
      ADMISSION_REASON,
      now,
      now,
    );
    db.run('DELETE FROM admission WHERE window_start_ms < ?', window);
    db.run(
      `INSERT INTO admission(window_start_ms, admitted) VALUES (?, 1)
       ON CONFLICT(window_start_ms) DO UPDATE SET admitted = admitted + 1`,
      window,
    );
    incrementCounter(db, ADMITTED_COUNTER, source);
    return { status: 'admitted', generation };
  });
}

export type ScheduleResult =
  | { status: 'scheduled'; generation: number }
  | { status: 'already'; generation: number; state: RepoJobState }
  | { status: 'busy' }
  | { status: 'unknown' }
  | { status: 'suppressed' };

export interface ScheduleOptions {
  /** Carry the reactivation intent (status sweep: active again). Never clears it. */
  reactivate?: boolean;
  pendingCap?: number;
}

interface JobRow {
  state: RepoJobState;
  generation: number;
  reactivate: number;
}

/** Schedule (or pull forward) the snapshot job of a known DID. */
export function scheduleSnapshot(
  db: Db,
  did: string,
  reason: string,
  now: number,
  o: ScheduleOptions = {},
): ScheduleResult {
  assertEpochMs('now', now);
  if (typeof reason !== 'string' || reason === '') throw new TypeError('a snapshot needs a reason');
  const pendingCap = limitOf(o.pendingCap, MAX_PENDING_SNAPSHOT_JOBS, 'pendingCap');
  const reactivate = o.reactivate === true ? 1 : 0;
  return db.tx((): ScheduleResult => {
    if (isSuppressed(db, did)) return { status: 'suppressed' };
    const user = loadUser(db, did);
    if (user === null) return { status: 'unknown' };
    const job = db.one<JobRow>(
      `SELECT state, generation, reactivate FROM repo_jobs WHERE did = ? AND kind = 'snapshot'`,
      did,
    );
    const generation = user.generation;

    if (job !== null && job.state !== 'complete') {
      // Open job: keep its reason and restart it at the newest head (see the header).
      // SQLite evaluates every SET expression on the old row.
      db.run(
        `UPDATE repo_jobs SET state = 'pending', generation = ?, reactivate = max(reactivate, ?),
           due_at = min(due_at, ?), updated_at_ms = ?,
           failure_code = CASE WHEN state = 'failed' THEN NULL ELSE failure_code END,
           restarts = CASE
             WHEN state = 'failed' THEN 0
             WHEN state = 'running' OR frontier_json IS NOT NULL OR head_cid IS NOT NULL THEN restarts + 1
             ELSE restarts END,
           frontier_json = NULL, head_cid = NULL
         WHERE did = ? AND kind = 'snapshot'`,
        generation,
        reactivate,
        now,
        now,
        did,
      );
      if (job.state === 'pending') return { status: 'already', generation, state: job.state };
      incrementCounter(db, SNAPSHOT_SCHEDULED_COUNTER, reason);
      return { status: 'scheduled', generation };
    }

    if (pendingSnapshotJobs(db, did) >= pendingCap) return { status: 'busy' };
    db.run(
      `INSERT INTO repo_jobs(did, kind, state, generation, reason, reactivate, due_at, updated_at_ms)
       VALUES (?, 'snapshot', 'pending', ?, ?, ?, ?, ?)
       ON CONFLICT(did, kind) DO UPDATE SET state = 'pending', generation = excluded.generation,
         reason = excluded.reason, reactivate = max(repo_jobs.reactivate, excluded.reactivate),
         frontier_json = NULL, head_cid = NULL, restarts = 0, attempts = 0, failure_code = NULL,
         due_at = excluded.due_at, updated_at_ms = excluded.updated_at_ms`,
      did,
      generation,
      reason,
      reactivate,
      now,
      now,
    );
    incrementCounter(db, SNAPSHOT_SCHEDULED_COUNTER, reason);
    return { status: 'scheduled', generation };
  });
}

export type StatusCheckResult = { status: 'scheduled' } | { status: 'unknown' } | { status: 'suppressed' };

/** Schedule an account-status check (`repo_jobs(did,'status')`) for a known DID, due now. */
export function scheduleStatusCheck(db: Db, did: string, reason: string, now: number): StatusCheckResult {
  assertEpochMs('now', now);
  return db.tx((): StatusCheckResult => {
    if (isSuppressed(db, did)) return { status: 'suppressed' };
    const user = loadUser(db, did);
    if (user === null) return { status: 'unknown' };
    db.run(
      `INSERT INTO repo_jobs(did, kind, state, generation, reason, due_at, updated_at_ms)
       VALUES (?, 'status', 'pending', ?, ?, ?, ?)
       ON CONFLICT(did, kind) DO UPDATE SET
         reason = CASE WHEN repo_jobs.state IN ('complete','failed') THEN excluded.reason ELSE repo_jobs.reason END,
         state = CASE WHEN repo_jobs.state = 'running' THEN 'running' ELSE 'pending' END,
         generation = excluded.generation, due_at = min(repo_jobs.due_at, excluded.due_at),
         failure_code = NULL, updated_at_ms = excluded.updated_at_ms`,
      did,
      user.generation,
      reason,
      now,
      now,
    );
    return { status: 'scheduled' };
  });
}
