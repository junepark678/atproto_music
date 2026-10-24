// Account state transitions on the `users` row (ADR 0004 §5.6, §5.7; ADR 0003
// generation semantics). Synchronous; every caller runs inside `db.tx`.
//
// - Generations come from the global `backfill_generation` allocator, so a
//   value is never reused, not even for an account recreated after a
//   disconnect. `completeSnapshot` activates only when the snapshot's
//   generation still equals `users.generation`.
// - Deactivation (`markInactive`) hides the account at once (active=0) and
//   moves `users.generation` to a fresh value, so an in-flight snapshot can no
//   longer activate it. As explicit deactivation it also clears the snapshot
//   job's reactivation intent. Projection rows stay stored and hidden.
// - Reactivation (`markReactivating`) keeps the account hidden and sets
//   `reactivate=1` on its snapshot job; it becomes visible only when a complete
//   snapshot commits under the current generation.
// - Suppressed (disconnected) DIDs have no users row; both transitions are
//   no-ops for them and for unknown DIDs.

import { toMs, toStorage } from '@atmusic/core/timestamp';
import type { AccountStatus, UserRow } from '../contracts';
import type { Db } from '../db';

export function loadUser(db: Db, did: string): UserRow | null {
  return db.one<UserRow>('SELECT * FROM users WHERE did = ?', did);
}

export function isSuppressed(db: Db, did: string): boolean {
  return db.one<{ did: string }>('SELECT did FROM suppression WHERE did = ?', did) !== null;
}

/** Reserve the next global generation (strictly greater than every earlier one). */
export function allocateGeneration(db: Db): number {
  const row = db.one<{ last_generation: number }>(
    `UPDATE backfill_generation SET last_generation = last_generation + 1
     WHERE singleton = 1 AND last_generation < ? RETURNING last_generation`,
    Number.MAX_SAFE_INTEGER,
  );
  if (row === null) throw new Error('backfill generation exhausted or missing');
  return row.last_generation;
}

/**
 * After a verified proof at `rev` was applied: `max_rev = max(max_rev, rev)`,
 * `indexed_at`, and `last_activity_ms`.
 */
export function advanceUser(db: Db, did: string, rev: string, nowNs: bigint): void {
  db.run(
    `UPDATE users SET max_rev = CASE WHEN max_rev IS NULL OR max_rev < ? THEN ? ELSE max_rev END,
       indexed_at = ?, last_activity_ms = ? WHERE did = ?`,
    rev,
    rev,
    toStorage(nowNs),
    toMs(nowNs),
    did,
  );
}

/**
 * A verified head at `rev` was (or is being) applied by a snapshot:
 * `max_rev = max(max_rev, rev)`. Live proofs older than that head are then
 * `stale_head`, so they can neither delete a record present at the head nor
 * resurrect one deleted before it while the snapshot is in progress.
 */
export function raiseMaxRev(db: Db, did: string, rev: string): void {
  db.run(
    'UPDATE users SET max_rev = CASE WHEN max_rev IS NULL OR max_rev < ? THEN ? ELSE max_rev END WHERE did = ?',
    rev,
    rev,
    did,
  );
}

/** Invalidate the exact statistics cache of `did` (ADR 0004 §5.8). */
export function bumpStatsVersion(db: Db, did: string): void {
  db.run('UPDATE users SET stats_version = stats_version + 1 WHERE did = ?', did);
}

export type InactiveStatus = Exclude<AccountStatus, 'unknown' | 'active'>;

const INACTIVE: readonly InactiveStatus[] = [
  'deactivated',
  'takendown',
  'suspended',
  'deleted',
  'desynchronized',
  'throttled',
  'not_found',
];

export type MarkInactiveResult = { changed: false } | { changed: true; generation: number };

/**
 * The account is inactive (getRepoStatus, or a Repo* proof-fetch error):
 * hide it now and supersede any in-flight snapshot.
 */
export function markInactive(db: Db, did: string, status: InactiveStatus): MarkInactiveResult {
  if (!INACTIVE.includes(status)) throw new RangeError(`not an inactive account status: ${String(status)}`);
  if (isSuppressed(db, did) || loadUser(db, did) === null) return { changed: false };
  const generation = allocateGeneration(db);
  db.run(
    `UPDATE users SET active = 0, account_status = ?, indexing_state = 'recovering', generation = ?
     WHERE did = ?`,
    status,
    generation,
    did,
  );
  // Only explicit deactivation clears a pending reactivation intent (ADR 0003).
  db.run("UPDATE repo_jobs SET reactivate = 0 WHERE did = ? AND kind = 'snapshot'", did);
  return { changed: true, generation };
}

export type MarkReactivatingResult = { changed: false } | { changed: true; jobFlagged: boolean };

/**
 * getRepoStatus reports the account active again: it stays hidden, and its
 * snapshot job (if one exists) carries the reactivation intent. The caller
 * schedules the snapshot (`scheduleSnapshot` preserves `reactivate`).
 */
export function markReactivating(db: Db, did: string): MarkReactivatingResult {
  if (isSuppressed(db, did) || loadUser(db, did) === null) return { changed: false };
  db.run(`UPDATE users SET active = 0, account_status = 'active', indexing_state = 'recovering' WHERE did = ?`, did);
  const flagged = db.all<{ did: string }>(
    "UPDATE repo_jobs SET reactivate = 1 WHERE did = ? AND kind = 'snapshot' RETURNING did",
    did,
  );
  return { changed: true, jobFlagged: flagged.length > 0 };
}
