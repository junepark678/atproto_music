// ADR 0003 generation rules for snapshot jobs (ADR 0004 §5.6, §5.7 step 9).
//
// - A generation names one "life" of an account in the index. Values come
//   from the global `backfill_generation` allocator, so one is never reused.
//   Admission allocates the first; `deactivate` (explicit deactivation:
//   getRepoStatus inactive, a Repo* error, the snapshot's own status check)
//   allocates a new one. Nothing else moves `users.generation`.
// - A snapshot job runs at the generation it was scheduled under
//   (`repo_jobs.generation`). Every slice write is guarded by that value on
//   its own row (snapshot-job.ts), and applySnapshotChunk / completeSnapshot
//   (W2-04) compare it with `users.generation`. So once the account is
//   deactivated, a walk in flight can neither apply a chunk nor activate the
//   account: its completion is `superseded`, and the account stays hidden.
// - Deactivation hides the account at once (`active = 0`) and is the only
//   thing that clears the reactivation intent (`repo_jobs.reactivate`).
// - Reactivation keeps the account hidden, sets the intent and schedules a
//   snapshot at the current generation. The account becomes visible again
//   only when that snapshot completes (`completeSnapshot` under the matching
//   generation).
// - Ordinary rescheduling (gap recovery, coalescing, proof errors, PDS
//   migration, rescans) preserves the intent: `scheduleSnapshot` only ever
//   ORs `reactivate` in, and a walk started at an older generation is
//   restarted at the current one rather than resumed.
//
// Synchronous; each writer is its own `db.tx` (nests as a savepoint).

import type { Db } from '../db';
import {
  type InactiveStatus,
  isSuppressed,
  loadUser,
  type MarkInactiveResult,
  markInactive,
  markReactivating,
} from '../write/account-state';
import { type ScheduleResult, scheduleSnapshot } from './admission';

/** `repo_jobs.reason` of the snapshot a reactivation schedules. */
export const REACTIVATION_REASON = 'reactivation';

/** Explicit deactivation: hide now, move the generation, clear the reactivation intent. */
export function deactivate(db: Db, did: string, status: InactiveStatus): MarkInactiveResult {
  return db.tx(() => markInactive(db, did, status));
}

export type ReactivateResult = { changed: false } | { changed: true; schedule: ScheduleResult };

/**
 * The account is active again: it stays hidden (`active = 0`,
 * `indexing_state = 'recovering'`) and a snapshot with the reactivation
 * intent is scheduled at the current generation, in one transaction.
 */
export function reactivate(db: Db, did: string, now: number): ReactivateResult {
  return db.tx((): ReactivateResult => {
    const r = markReactivating(db, did);
    if (!r.changed) return { changed: false };
    return { changed: true, schedule: scheduleSnapshot(db, did, REACTIVATION_REASON, now, { reactivate: true }) };
  });
}

/** Ordinary rescheduling: the reactivation intent (if any) is preserved, never set or cleared. */
export function rescheduleSnapshot(db: Db, did: string, reason: string, now: number): ScheduleResult {
  return scheduleSnapshot(db, did, reason, now);
}

export type GenerationCheck = 'current' | 'superseded' | 'suppressed' | 'unknown';

/**
 * Whether a job scheduled at `generation` still belongs to the account's
 * current life. Reads only.
 */
export function checkGeneration(db: Db, did: string, generation: number): GenerationCheck {
  if (isSuppressed(db, did)) return 'suppressed';
  const user = loadUser(db, did);
  if (user === null) return 'unknown';
  return user.generation === generation ? 'current' : 'superseded';
}
