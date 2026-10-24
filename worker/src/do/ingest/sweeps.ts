// The account-status and identity sweeps (ADR 0004 §5.6, §5.9; amendment
// A17). Timers `status-sweep` (hourly) and `identity-sweep` (daily); W5-01
// wires `statusSweep` / `identitySweep` as their runDue handlers. Each handler
// reschedules its own timer.
//
// statusSweep(m, now): one bounded slice of at most STATUS_SWEEP_BATCH (200)
// checks (accounts.ts `checkStatus`):
//   1. first the due `status` repo jobs the verify drain created (accounts.ts
//      `runStatusJob`), oldest first;
//   2. then the known DIDs whose check is due, round-robin by
//      `last_status_check_ms` (never-checked first, then oldest check, then
//      DID): a DID whose `last_activity_ms` lies in the last 30 days
//      (`last_activity_ms >= now - 30 d`) is due one hour after its last check,
//      every other DID (no activity, or older activity) one day after. So
//      deactivation shows within 1 h for active users and 24 h for the rest,
//      unless a proof fetch reports it sooner.
//   The swept DIDs are checked with `concurrentFetches` workers under the
//   shared per-host limiter. A check that the host pause or the subrequest
//   budget skipped keeps its `last_status_check_ms`, so it stays first in line.
//   Every check that reached an answer or failed moves it, so a host that keeps
//   failing cannot starve the others. An answered check also completes an open
//   `status` job of that DID (the sweep answer supersedes it).
//   Then `status-sweep` is due again in one hour, or sooner when a status job
//   falls due earlier (`scheduleStatusJobsTimer`).
//
// identitySweep(m, now): at most IDENTITY_SWEEP_BATCH (200) known DIDs whose
// `handle_checked_at_ms` is NULL or at least one day old, oldest first. For
// each, the DID document is re-resolved with `fresh: true` (no cache; the
// resolver rewrites identity_cache) and the handle is verified in both
// directions by the resolver (DoH TXT `_atproto.<handle>` or
// `https://<handle>/.well-known/atproto-did` must name the same DID). Then, in
// one transaction that re-reads the users row:
//   - verified handle → `users.handle` (lowercase). If another users row holds
//     that handle (the unique index `users_verified_handle`), the older holder's
//     handle is cleared first (counter `handle_conflict`): a handle names at
//     most one account, the one it verifies for now;
//   - no verified handle (mismatch, no claim, the claim no longer resolves to
//     this DID, a definite identity failure) → `users.handle = NULL`. When the
//     resolver reported no verified handle although the document still claims
//     one, the claim is re-resolved once (`resolveHandle`), so a transport
//     failure during verification (a timeout, a 5xx) leaves the stored handle
//     unchanged instead of clearing it; a definite answer (another DID, no
//     DID published, an ambiguous TXT) clears it;
//   - a `#atproto_pds` endpoint different from the known one (`users.pds`, or
//     before the first sweep the identity_cache entry the drain left) schedules
//     a snapshot `reason='pds_migration'` (admission.ts `scheduleSnapshot`), and
//     `users.pds` records the new endpoint. If the snapshot queue is full, the
//     old endpoint is kept, so the next sweep detects the change again;
//   - `handle_checked_at_ms = now` (also after a failure, for round-robin
//     fairness; a transport failure changes nothing else).
//   Projection rows (history, follows, stats) are never touched: a handle is a
//   display claim, and identity is the DID (MVP.md "DID and AT URI identity").
//   Then `identity-sweep` is due again in one day.
//
// Both sweeps reserve subrequests before every network step (pds-budget.ts
// SubrequestMeter): Free uses the plan's 40 per slice; Paid backstops at the
// batch's worst case (so a full batch fits) under the 10,000 per invocation.
// No `db.tx` spans an await.

import { claimedHandle, type DidDocument, isIdentityError } from '@atmusic/atproto/identity/did-doc';
import { createSafeFetch, isSafeFetchError } from '@atmusic/atproto/net/safe-fetch';
import { isHandle, normalizeHandle } from '@atmusic/core/syntax';
import type { ModuleDeps } from '../contracts';
import type { Db } from '../db';
import { schedule } from '../timers';
import { isSuppressed, loadUser } from '../write/account-state';
import { incrementCounter } from '../write/keys';
import {
  checkStatus,
  dueStatusJobs,
  runStatusJob,
  type StatusCheckOutcome,
  scheduleStatusJobsTimer,
  statusMeter,
} from './accounts';
import { scheduleSnapshot } from './admission';
import { readIdentityRow, resolveIdentity } from './identity-cache';
import { IDENTITY_RESOLVE_COST, SubrequestMeter } from './pds-budget';
import { drainState } from './verify-drain';

export const STATUS_SWEEP_BATCH = 200;
export const IDENTITY_SWEEP_BATCH = 200;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** Activity this recent makes a DID due hourly; older (or none) daily. */
export const RECENT_ACTIVITY_MS = 30 * DAY_MS;
export const STATUS_SWEEP_INTERVAL_MS = HOUR_MS;
export const ACTIVE_STATUS_INTERVAL_MS = HOUR_MS;
export const IDLE_STATUS_INTERVAL_MS = DAY_MS;
export const IDENTITY_SWEEP_INTERVAL_MS = DAY_MS;
export const HANDLE_RECHECK_INTERVAL_MS = DAY_MS;
/** A handle re-resolution: DoH TXT, then possibly the well-known fetch and its DoH pre-check. */
export const HANDLE_RECHECK_COST = 4;
export const PDS_MIGRATION_REASON = 'pds_migration';

export const HANDLE_CONFLICT_COUNTER = 'handle_conflict';
export const HANDLE_CLEARED_COUNTER = 'handle_cleared';
export const IDENTITY_SWEEP_FAILED_COUNTER = 'identity_sweep_failed';
export const PDS_CHANGED_COUNTER = 'pds_changed';

function assertEpochMs(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer of epoch ms, got ${value}`);
  }
}

/** Run `items` through `n` concurrent workers; results in completion order. */
async function pool<T, R>(items: readonly T[], n: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const queue = [...items];
  const out: R[] = [];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      out.push(await work(item));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, n) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// status-sweep

/** Known DIDs whose status check is due at `now`, in round-robin order. */
export function dueStatusDids(db: Db, now: number, limit: number, exclude: ReadonlySet<string> = new Set()): string[] {
  if (limit <= 0) return [];
  const rows = db.all<{ did: string }>(
    `SELECT did FROM users
     WHERE last_status_check_ms IS NULL
        OR last_status_check_ms <= ? - CASE WHEN last_activity_ms IS NOT NULL AND last_activity_ms >= ?
                                            THEN ? ELSE ? END
     ORDER BY last_status_check_ms IS NOT NULL, last_status_check_ms, did
     LIMIT ?`,
    now,
    now - RECENT_ACTIVITY_MS,
    ACTIVE_STATUS_INTERVAL_MS,
    IDLE_STATUS_INTERVAL_MS,
    limit + exclude.size,
  );
  return rows
    .map((r) => r.did)
    .filter((did) => !exclude.has(did))
    .slice(0, limit);
}

export interface SweepEntry {
  did: string;
  source: 'job' | 'sweep';
  outcome: StatusCheckOutcome['outcome'];
  detail?: string;
}

export interface StatusSweepReport {
  checked: SweepEntry[];
  subrequests: number;
  /** The `status-sweep` timer's next due time. */
  nextDueAt: number;
}

function detailOf(o: StatusCheckOutcome): string | undefined {
  switch (o.outcome) {
    case 'inactive':
      return o.status;
    case 'reactivating':
      return o.snapshot;
    case 'failed':
      return o.error;
    default:
      return undefined;
  }
}

/** One status-sweep slice (see the header). */
export async function statusSweep(m: ModuleDeps, now: number): Promise<StatusSweepReport> {
  assertEpochMs('now', now);
  const db = m.db;
  const meter = statusMeter(m, STATUS_SWEEP_BATCH);
  const limiter = drainState(db, m.config.budget).limiter;
  // One SafeFetch per slice, so its DoH pre-check cache is shared by every check.
  const safeFetch = createSafeFetch({ transport: m.transport, clock: m.clock });
  const checked: SweepEntry[] = [];

  const jobs = dueStatusJobs(db, now, STATUS_SWEEP_BATCH);
  const jobDids = new Set(jobs.map((j) => j.did));
  const sweepDids = dueStatusDids(db, now, STATUS_SWEEP_BATCH - jobs.length, jobDids);
  const work: Array<{ did: string; source: 'job' | 'sweep' }> = [
    ...jobs.map((j) => ({ did: j.did, source: 'job' as const })),
    ...sweepDids.map((did) => ({ did, source: 'sweep' as const })),
  ];

  await pool(work, m.config.budget.concurrentFetches, async ({ did, source }) => {
    let outcome: StatusCheckOutcome | null;
    try {
      outcome =
        source === 'job'
          ? await runStatusJob(m, did, now, { meter, limiter, safeFetch })
          : await checkStatus(m, did, { now, meter, limiter, safeFetch });
    } catch (error) {
      m.log.log('error', 'status_sweep.error', { did, error: String(error) });
      outcome = { outcome: 'failed', error: 'internal' };
    }
    if (outcome === null) return;
    if (source === 'sweep') afterSweepCheck(db, did, outcome, now);
    const detail = detailOf(outcome);
    checked.push(
      detail === undefined
        ? { did, source, outcome: outcome.outcome }
        : { did, source, outcome: outcome.outcome, detail },
    );
  });

  const nextDueAt = db.tx(() => {
    const hourly = schedule(db, 'status-sweep', now + STATUS_SWEEP_INTERVAL_MS, { force: true });
    return scheduleStatusJobsTimer(db, now) ?? hourly;
  });
  return { checked, subrequests: meter.reserved, nextDueAt };
}

/** Bookkeeping after a swept (not job-driven) check (see the header). */
function afterSweepCheck(db: Db, did: string, outcome: StatusCheckOutcome, now: number): void {
  db.tx(() => {
    switch (outcome.outcome) {
      case 'active':
      case 'inactive':
      case 'reactivating':
        // The sweep answered: an open status job of this DID is answered too.
        db.run(
          `UPDATE repo_jobs SET state = 'complete', attempts = 0, failure_code = NULL,
             updated_at_ms = max(updated_at_ms + 1, ?)
           WHERE did = ? AND kind = 'status' AND state IN ('pending','failed')`,
          now,
          did,
        );
        return;
      case 'failed':
        // Attempted: move it back in the round-robin.
        db.run('UPDATE users SET last_status_check_ms = ? WHERE did = ?', now, did);
        return;
      default:
        // Not attempted (paused host, budget, gone): stays first in line.
        return;
    }
  });
}

// ---------------------------------------------------------------------------
// identity-sweep

/** Known DIDs whose handle check is due at `now`, oldest check first. */
export function dueIdentityDids(db: Db, now: number, limit: number): string[] {
  if (limit <= 0) return [];
  return db
    .all<{ did: string }>(
      `SELECT did FROM users WHERE handle_checked_at_ms IS NULL OR handle_checked_at_ms <= ?
       ORDER BY handle_checked_at_ms IS NOT NULL, handle_checked_at_ms, did LIMIT ?`,
      now - HANDLE_RECHECK_INTERVAL_MS,
      limit,
    )
    .map((r) => r.did);
}

export type IdentityCheckOutcome =
  | { outcome: 'verified'; handle: string; pdsChanged: boolean; cleared: string | null }
  | { outcome: 'cleared'; pdsChanged: boolean }
  | { outcome: 'kept'; reason: string }
  | { outcome: 'failed'; error: string }
  | { outcome: 'unknown' }
  | { outcome: 'budget' };

export interface IdentitySweepReport {
  checked: Array<{ did: string } & IdentityCheckOutcome>;
  subrequests: number;
  nextDueAt: number;
}

function documentClaim(db: Db, did: string): string | null {
  const json = readIdentityRow(db, did)?.doc_json ?? null;
  if (json === null) return null;
  try {
    return claimedHandle(JSON.parse(json) as Pick<DidDocument, 'alsoKnownAs'>);
  } catch {
    return null;
  }
}

type HandleVerdict = { kind: 'handle'; handle: string | null } | { kind: 'transient'; reason: string };

/**
 * The handle to store for `did`: the resolver's verified handle, or (when it
 * found none although the document claims one) one re-resolution of the claim
 * that tells a transport failure from a definite mismatch.
 */
async function handleVerdict(
  m: ModuleDeps,
  did: string,
  verified: string | null,
  meter: SubrequestMeter,
): Promise<HandleVerdict> {
  if (verified !== null && isHandle(verified)) return { kind: 'handle', handle: normalizeHandle(verified) };
  const claim = documentClaim(m.db, did);
  if (claim === null) return { kind: 'handle', handle: null };
  if (!meter.tryReserve(HANDLE_RECHECK_COST)) return { kind: 'transient', reason: 'budget' };
  try {
    const resolved = await m.identity.resolveHandle(claim);
    return { kind: 'handle', handle: resolved === did ? normalizeHandle(claim) : null };
  } catch (error) {
    if (isIdentityError(error)) return { kind: 'handle', handle: null };
    return { kind: 'transient', reason: isSafeFetchError(error) ? `handle:${error.code}` : 'handle:error' };
  }
}

/** Re-resolve one DID, verify its handle and detect a PDS change (see the header). */
export async function checkIdentity(
  m: ModuleDeps,
  did: string,
  now: number,
  meter: SubrequestMeter,
): Promise<IdentityCheckOutcome> {
  const db = m.db;
  if (isSuppressed(db, did) || loadUser(db, did) === null) return { outcome: 'unknown' };
  if (!meter.tryReserve(IDENTITY_RESOLVE_COST)) return { outcome: 'budget' };
  // Read before the fresh resolution rewrites identity_cache.
  const cachedPds = readIdentityRow(db, did)?.pds ?? null;
  const id = await resolveIdentity(m, did, { fresh: true });

  if (!id.ok) {
    if (id.kind === 'transient') {
      db.tx(() => {
        db.run('UPDATE users SET handle_checked_at_ms = ? WHERE did = ?', now, did);
        incrementCounter(db, IDENTITY_SWEEP_FAILED_COUNTER, 'transient');
      });
      return { outcome: 'failed', error: 'identity:transient' };
    }
    // A definite failure: the handle cannot verify for this DID any more.
    return db.tx((): IdentityCheckOutcome => {
      const had = loadUser(db, did);
      if (had === null || isSuppressed(db, did)) return { outcome: 'unknown' };
      db.run('UPDATE users SET handle = NULL, handle_checked_at_ms = ? WHERE did = ?', now, did);
      incrementCounter(db, IDENTITY_SWEEP_FAILED_COUNTER, id.code);
      if (had.handle !== null) incrementCounter(db, HANDLE_CLEARED_COUNTER, id.code);
      return { outcome: 'cleared', pdsChanged: false };
    });
  }

  const verdict = await handleVerdict(m, did, id.identity.handle, meter);
  const pds = id.identity.pds;
  return db.tx((): IdentityCheckOutcome => {
    if (isSuppressed(db, did)) return { outcome: 'unknown' };
    const user = loadUser(db, did);
    if (user === null) return { outcome: 'unknown' };

    // PDS migration: a different endpoint than the one we know.
    const known = user.pds ?? cachedPds;
    let pdsChanged = false;
    let storePds = pds;
    if (known !== null && known !== pds) {
      const s = scheduleSnapshot(db, did, PDS_MIGRATION_REASON, now);
      if (s.status === 'scheduled' || s.status === 'already') {
        pdsChanged = true;
        schedule(db, 'snapshot', now);
        incrementCounter(db, PDS_CHANGED_COUNTER, s.status);
      } else {
        // Queue full: keep the old endpoint so the next sweep sees the change again.
        storePds = known;
      }
    }

    if (verdict.kind === 'transient') {
      db.run('UPDATE users SET pds = ?, handle_checked_at_ms = ? WHERE did = ?', storePds, now, did);
      incrementCounter(db, IDENTITY_SWEEP_FAILED_COUNTER, verdict.reason);
      return { outcome: 'kept', reason: verdict.reason };
    }

    if (verdict.handle === null) {
      db.run('UPDATE users SET pds = ?, handle = NULL, handle_checked_at_ms = ? WHERE did = ?', storePds, now, did);
      if (user.handle !== null) incrementCounter(db, HANDLE_CLEARED_COUNTER, 'unverified');
      return { outcome: 'cleared', pdsChanged };
    }

    // A verified handle names one account: clear an older holder first (unique index).
    const holder = db.one<{ did: string }>('SELECT did FROM users WHERE handle = ? AND did != ?', verdict.handle, did);
    if (holder !== null) {
      db.run('UPDATE users SET handle = NULL WHERE did = ?', holder.did);
      incrementCounter(db, HANDLE_CONFLICT_COUNTER, '');
    }
    db.run(
      'UPDATE users SET pds = ?, handle = ?, handle_checked_at_ms = ? WHERE did = ?',
      storePds,
      verdict.handle,
      now,
      did,
    );
    return { outcome: 'verified', handle: verdict.handle, pdsChanged, cleared: holder?.did ?? null };
  });
}

/** A fresh subrequest meter for one identity-sweep slice (Free: the plan's slice limit). */
function identityMeter(m: Pick<ModuleDeps, 'config'>): SubrequestMeter {
  const budget = m.config.budget;
  if (m.config.plan === 'free') return new SubrequestMeter(budget.subrequestsPerSlice);
  return new SubrequestMeter(
    Math.max(budget.subrequestsPerSlice, IDENTITY_SWEEP_BATCH * (IDENTITY_RESOLVE_COST + HANDLE_RECHECK_COST)),
  );
}

/** One identity-sweep slice (see the header). */
export async function identitySweep(m: ModuleDeps, now: number): Promise<IdentitySweepReport> {
  assertEpochMs('now', now);
  const db = m.db;
  const meter = identityMeter(m);
  const checked: IdentitySweepReport['checked'] = [];
  const dids = dueIdentityDids(db, now, IDENTITY_SWEEP_BATCH);
  // Each check's write is one transaction that re-reads the handle holders, so
  // concurrent checks of two DIDs claiming one handle cannot both keep it.
  await pool(dids, m.config.budget.concurrentFetches, async (did) => {
    let out: IdentityCheckOutcome;
    try {
      out = await checkIdentity(m, did, now, meter);
    } catch (error) {
      m.log.log('error', 'identity_sweep.error', { did, error: String(error) });
      out = { outcome: 'failed', error: 'internal' };
    }
    checked.push({ did, ...out });
  });
  const nextDueAt = db.tx(() => schedule(db, 'identity-sweep', now + IDENTITY_SWEEP_INTERVAL_MS, { force: true }));
  return { checked, subrequests: meter.reserved, nextDueAt };
}
