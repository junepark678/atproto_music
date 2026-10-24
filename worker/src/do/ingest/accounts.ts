// Account status checks (ADR 0004 §5.6 `status-sweep`, §5.4 "Errors",
// amendment A17; ADR 0003 generation semantics; Rust oracle
// crates/atproto/src/sync/accounts.rs `PdsAccountSource` / `AccountReconciler`).
//
// checkStatus(m, did) asks the account's own PDS, never a relay event:
//   1. a known, unsuppressed DID only (`unknown` otherwise; nothing is fetched);
//   2. the identity through identity_cache (identity-cache.ts `resolveIdentity`,
//      5 min TTL, 1 h negative TTL). A DID document that is gone (`did_not_found`,
//      a 404 / 410 tombstone) is a deleted account: hidden at once. Any other
//      identity failure changes nothing (`failed`);
//   3. while `host_backoff` holds the PDS host, nothing is fetched (`host_paused`);
//   4. `GET {pds}/xrpc/com.atproto.sync.getRepoStatus?did` through SafeFetch
//      (`json` kind, STATUS_BODY_MAX_BYTES cap, 10 s deadline, the full URL / DoH
//      / redirect policy) under the shared FetchLimiter (per-host cap). The answer
//      must be `{did: <the requested DID>, active: boolean}`, as in the oracle.
//      XRPC errors RepoNotFound / RepoDeactivated / RepoTakendown / RepoSuspended
//      are account answers too. 429 / 5xx / timeouts pause the host
//      (pds-budget.ts) and change nothing else;
//   5. one `db.tx` that re-reads the users row (the await may have raced a
//      disconnect or another check) and applies the answer:
//      - inactive (deactivated, takendown, suspended, deleted, desynchronized,
//        throttled, an unrecognised status, or RepoNotFound → `not_found`):
//        `markInactive` hides the account at once (active=0) and moves its
//        generation, so an in-flight snapshot can no longer activate it. An
//        account already hidden as inactive only has its status label updated:
//        its generation is not moved again;
//      - active, after an inactive status: `markReactivating` (the account stays
//        hidden, `account_status='active'`) plus `scheduleSnapshot(reason
//        'reactivation', reactivate)`. It becomes visible only when that
//        snapshot completes under the current generation (W4-01
//        `completeSnapshot`). The same happens for any hidden account whose
//        snapshot job is gone or complete (the schedule was refused as busy, or
//        a snapshot completed while the PDS reported it inactive), so a refused
//        schedule is retried by the next check. A hidden account with an open
//        snapshot (admission, or a reactivation already scheduled) is left to it;
//      - active otherwise: nothing but the check time;
//      - `users.last_status_check_ms = now` in every applied case.
//   Projection rows are never written or deleted here: a hidden account's rows
//   stay stored and hidden (ADR 0003), so a reactivation re-snapshot is
//   incremental.
//
// runStatusJobs / statusJobs: the `repo_jobs(did,'status')` rows the verify
// drain creates on a RepoDeactivated / RepoTakendown / RepoSuspended /
// RepoNotFound proof-fetch error (admission.ts `scheduleStatusCheck`). Each due
// job (pending, or failed with its backoff passed) is claimed (`running`, lease
// token `updated_at_ms = max(updated_at_ms + 1, now)`), checked, and then:
// - answered (or the DID is no longer known): `complete`, unless the job was
//   requested again while the check ran (the token moved), then `pending` again;
// - failed: `failed` with `attempts + 1`, `failure_code`, and `due_at = now +
//   statusJobBackoffMs(attempts)` (1 s doubling, capped at 1 h); the sweep also
//   keeps checking the DID meanwhile.
// sweeps.ts runs them at the start of every `status-sweep` slice, within the
// slice's 200 checks and subrequest budget, and `scheduleStatusJobsTimer` pulls
// that timer forward to the earliest due job (W5-01 calls it after a drain).
//
// Nothing here holds a transaction across an await: every `db.tx` opens after
// the fetch it depends on completed (ADR F3).

import { isIdentityError } from '@atmusic/atproto/identity/resolver';
import { createSafeFetch, isSafeFetchError, type SafeFetch } from '@atmusic/atproto/net/safe-fetch';
import type { AccountStatus, ModuleDeps } from '../contracts';
import type { Db } from '../db';
import { dueAt, schedule } from '../timers';
import { type InactiveStatus, isSuppressed, loadUser, markInactive, markReactivating } from '../write/account-state';
import { incrementCounter } from '../write/keys';
import { type ScheduleResult, scheduleSnapshot } from './admission';
import { cachedIdentity, resolveIdentity } from './identity-cache';
import {
  type FetchLimiter,
  hostOf,
  hostPausedUntil,
  IDENTITY_RESOLVE_COST,
  PROOF_FETCH_COST,
  pauseFor,
  pauseHost,
  SubrequestMeter,
} from './pds-budget';
import { drainState } from './verify-drain';

export const GET_REPO_STATUS = 'com.atproto.sync.getRepoStatus';
/** A getRepoStatus answer is a few hundred bytes; anything near this is hostile. */
export const STATUS_BODY_MAX_BYTES = 64 * 1024;
/** getRepoStatus plus the DoH A / AAAA pre-check of its host. */
export const STATUS_FETCH_COST = PROOF_FETCH_COST;
/** Most subrequests one check can reserve: an uncached identity and the status fetch. */
export const WORST_STATUS_CHECK_SUBREQUESTS = IDENTITY_RESOLVE_COST + STATUS_FETCH_COST;
export const REACTIVATION_REASON = 'reactivation';
export const STATUS_JOB_BACKOFF_BASE_MS = 1_000;
export const STATUS_JOB_BACKOFF_CAP_MS = 3_600_000;
/** A status job pulls the `status-sweep` timer no closer than this to now. */
export const STATUS_JOB_MIN_INTERVAL_MS = 60_000;

export const STATUS_CHECKED_COUNTER = 'status_checked';
export const STATUS_FAILED_COUNTER = 'status_check_failed';
export const ACCOUNT_HIDDEN_COUNTER = 'account_hidden';
export const ACCOUNT_REACTIVATING_COUNTER = 'account_reactivating';

/** XRPC errors that are an answer about the account, not a failure. */
const XRPC_STATUS: Readonly<Record<string, InactiveStatus>> = {
  RepoNotFound: 'not_found',
  RepoDeactivated: 'deactivated',
  RepoTakendown: 'takendown',
  RepoSuspended: 'suspended',
};

/** getRepoStatus `status` values (com.atproto.sync.getRepoStatus lexicon) for `active: false`. */
const WIRE_STATUS: Readonly<Record<string, InactiveStatus>> = {
  deactivated: 'deactivated',
  takendown: 'takendown',
  suspended: 'suspended',
  deleted: 'deleted',
  desynchronized: 'desynchronized',
  throttled: 'throttled',
};

const INACTIVE_STATUSES: ReadonlySet<AccountStatus> = new Set<AccountStatus>([
  'deactivated',
  'takendown',
  'suspended',
  'deleted',
  'desynchronized',
  'throttled',
  'not_found',
]);

export function isInactiveStatus(status: AccountStatus): status is InactiveStatus {
  return INACTIVE_STATUSES.has(status);
}

export type StatusCheckOutcome =
  /** The PDS says active and the account was not inactive: only the check time moved. */
  | { outcome: 'active' }
  /** The account is inactive; `changed` is false when it was already hidden as inactive. */
  | { outcome: 'inactive'; status: InactiveStatus; changed: boolean }
  /** Active again after an inactive status: hidden until the reactivation snapshot completes. */
  | { outcome: 'reactivating'; snapshot: ScheduleResult['status'] }
  /** Not a known (or a suppressed) DID: nothing fetched or written. */
  | { outcome: 'unknown' }
  /** The PDS host is paused until `until`: nothing fetched or written. */
  | { outcome: 'host_paused'; until: number }
  /** The slice's subrequest budget is spent: nothing fetched or written. */
  | { outcome: 'budget' }
  /** Identity, transport or response failure: no account state changed. */
  | { outcome: 'failed'; error: string };

export interface CheckOptions {
  /** Epoch ms of the check (defaults to the injected clock). */
  now?: number;
  /** The slice's subrequest meter; a check reserves its cost before any fetch. */
  meter?: SubrequestMeter;
  /** Defaults to the IndexDO instance's shared limiter (the drain's). */
  limiter?: FetchLimiter;
  safeFetch?: SafeFetch;
}

function assertEpochMs(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer of epoch ms, got ${value}`);
  }
}

type Answer = { active: true } | { active: false; status: InactiveStatus };

function statusUrl(pds: string, did: string): URL {
  const url = new URL(`/xrpc/${GET_REPO_STATUS}`, pds);
  url.searchParams.set('did', did);
  return url;
}

/** Parse a getRepoStatus body for `did`; null when it is not a valid answer about that DID. */
export function parseRepoStatus(body: Uint8Array, did: string): Answer | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (doc.did !== did || typeof doc.active !== 'boolean') return null;
  if (doc.active) return { active: true };
  // An inactive account with a status this code does not know is still inactive.
  const status = typeof doc.status === 'string' ? (WIRE_STATUS[doc.status] ?? 'deactivated') : 'deactivated';
  return { active: false, status };
}

function counter(db: Db, name: string, label: string): void {
  incrementCounter(db, name, label);
}

function failed(m: ModuleDeps, did: string, error: string): StatusCheckOutcome {
  m.db.tx(() => counter(m.db, STATUS_FAILED_COUNTER, error.split(':')[0] ?? error));
  m.log.log('warn', 'status.check_failed', { did, error });
  return { outcome: 'failed', error };
}

/** Does the account still need its reactivation snapshot scheduled? */
function reactivationOpen(db: Db, did: string): boolean {
  return (
    db.one<{ did: string }>(
      `SELECT did FROM repo_jobs WHERE did = ? AND kind = 'snapshot' AND state != 'complete'`,
      did,
    ) !== null
  );
}

/** Apply a definite answer in one transaction (see the header, step 5). */
function applyAnswer(m: ModuleDeps, did: string, answer: Answer, now: number): StatusCheckOutcome {
  const db = m.db;
  return db.tx((): StatusCheckOutcome => {
    if (isSuppressed(db, did)) return { outcome: 'unknown' };
    const user = loadUser(db, did);
    if (user === null) return { outcome: 'unknown' };
    let out: StatusCheckOutcome;
    if (!answer.active) {
      if (user.active === 0 && isInactiveStatus(user.account_status)) {
        // Already hidden as inactive: relabel only; the generation already moved.
        if (user.account_status !== answer.status) {
          db.run('UPDATE users SET account_status = ? WHERE did = ?', answer.status, did);
        }
        out = { outcome: 'inactive', status: answer.status, changed: false };
      } else {
        markInactive(db, did, answer.status);
        counter(db, ACCOUNT_HIDDEN_COUNTER, answer.status);
        out = { outcome: 'inactive', status: answer.status, changed: true };
      }
    } else if (user.active === 0 && (isInactiveStatus(user.account_status) || !reactivationOpen(db, did))) {
      markReactivating(db, did);
      const s = scheduleSnapshot(db, did, REACTIVATION_REASON, now, { reactivate: true });
      if (s.status === 'scheduled' || s.status === 'already') schedule(db, 'snapshot', now);
      counter(db, ACCOUNT_REACTIVATING_COUNTER, s.status);
      out = { outcome: 'reactivating', snapshot: s.status };
    } else {
      out = { outcome: 'active' };
    }
    db.run('UPDATE users SET last_status_check_ms = ? WHERE did = ?', now, did);
    counter(db, STATUS_CHECKED_COUNTER, out.outcome);
    return out;
  });
}

/** Check one DID's account status on its own PDS and apply the answer (see the header). */
export async function checkStatus(m: ModuleDeps, did: string, o: CheckOptions = {}): Promise<StatusCheckOutcome> {
  const db = m.db;
  const now = o.now ?? m.clock.nowMs();
  assertEpochMs('now', now);
  if (isSuppressed(db, did) || loadUser(db, did) === null) return { outcome: 'unknown' };

  if (o.meter !== undefined && cachedIdentity(db, did, m.clock.nowMs()) === null) {
    if (!o.meter.tryReserve(IDENTITY_RESOLVE_COST)) return { outcome: 'budget' };
  }
  const id = await resolveIdentity(m, did);
  if (!id.ok) {
    if (id.kind === 'invalid' && id.code === 'did_not_found') {
      // The DID document is gone (tombstoned): the account is deleted.
      return applyAnswer(m, did, { active: false, status: 'deleted' }, now);
    }
    return failed(m, did, id.kind === 'invalid' ? `identity:${id.code}` : 'identity:transient');
  }

  let host: string;
  try {
    host = hostOf(id.identity.pds);
  } catch {
    return failed(m, did, 'identity:invalid_pds');
  }
  const paused = hostPausedUntil(db, host, now);
  if (paused !== null) return { outcome: 'host_paused', until: paused };
  if (o.meter !== undefined && !o.meter.tryReserve(STATUS_FETCH_COST)) return { outcome: 'budget' };

  const safeFetch = o.safeFetch ?? createSafeFetch({ transport: m.transport, clock: m.clock });
  const limiter = o.limiter ?? drainState(db, m.config.budget).limiter;
  let body: Uint8Array;
  const release = await limiter.acquire(host);
  try {
    const pausedNow = hostPausedUntil(db, host, now);
    if (pausedNow !== null) return { outcome: 'host_paused', until: pausedNow };
    body = (await safeFetch(statusUrl(id.identity.pds, did), { kind: 'json', maxBytes: STATUS_BODY_MAX_BYTES })).body;
  } catch (error) {
    if (isSafeFetchError(error)) {
      const xrpc = error.code === 'http_status' ? (error.xrpcError ?? '') : '';
      const status = XRPC_STATUS[xrpc];
      if (status !== undefined) return applyAnswer(m, did, { active: false, status }, now);
      const pause = pauseFor(error);
      if (pause !== null) db.tx(() => pauseHost(db, host, now, pause));
      return failed(m, did, error.status === null ? `fetch:${error.code}` : `fetch:http_${error.status}`);
    }
    if (isIdentityError(error)) return failed(m, did, `identity:${error.code}`);
    m.log.log('error', 'status.fetch_error', { did, error: String(error) });
    return failed(m, did, 'fetch:error');
  } finally {
    release();
  }

  const answer = parseRepoStatus(body, did);
  if (answer === null) return failed(m, did, 'response:invalid');
  return applyAnswer(m, did, answer, now);
}

// ---------------------------------------------------------------------------
// `status` repo jobs (created by the verify drain)

export interface StatusJobRow {
  did: string;
  state: 'pending' | 'running' | 'complete' | 'failed';
  reason: string | null;
  attempts: number;
  due_at: number;
  updated_at_ms: number;
}

/** Backoff after `attempts` failed checks of one status job: 1 s, 2 s, 4 s, … capped at 1 h. */
export function statusJobBackoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 30);
  return Math.min(STATUS_JOB_BACKOFF_CAP_MS, STATUS_JOB_BACKOFF_BASE_MS * 2 ** exponent);
}

/** Due status jobs (pending, or failed with the backoff passed), oldest first. */
export function dueStatusJobs(db: Db, now: number, limit: number): StatusJobRow[] {
  if (limit <= 0) return [];
  return db.all<StatusJobRow>(
    `SELECT did, state, reason, attempts, due_at, updated_at_ms FROM repo_jobs
     WHERE kind = 'status' AND state IN ('pending','failed') AND due_at <= ?
     ORDER BY due_at, did LIMIT ?`,
    now,
    limit,
  );
}

/** Claim a due status job; its lease token, or null when it is no longer due. */
export function claimStatusJob(db: Db, did: string, now: number): number | null {
  return (
    db.one<{ updated_at_ms: number }>(
      `UPDATE repo_jobs SET state = 'running', updated_at_ms = max(updated_at_ms + 1, ?)
       WHERE did = ? AND kind = 'status' AND state IN ('pending','failed') AND due_at <= ?
       RETURNING updated_at_ms`,
      now,
      did,
      now,
    )?.updated_at_ms ?? null
  );
}

/** Finish a claimed status job after the check (see the header). */
export function finishStatusJob(db: Db, did: string, token: number, outcome: StatusCheckOutcome, now: number): void {
  db.tx(() => {
    const row = db.one<StatusJobRow>(
      `SELECT did, state, reason, attempts, due_at, updated_at_ms FROM repo_jobs WHERE did = ? AND kind = 'status'`,
      did,
    );
    if (row === null) return;
    const requestedAgain = row.state !== 'running' || row.updated_at_ms !== token;
    const answered =
      outcome.outcome === 'active' ||
      outcome.outcome === 'inactive' ||
      outcome.outcome === 'reactivating' ||
      outcome.outcome === 'unknown';
    if (answered) {
      db.run(
        `UPDATE repo_jobs SET state = ?, attempts = 0, failure_code = NULL, updated_at_ms = max(updated_at_ms + 1, ?)
         WHERE did = ? AND kind = 'status'`,
        requestedAgain ? 'pending' : 'complete',
        now,
        did,
      );
      return;
    }
    if (outcome.outcome === 'failed') {
      const attempts = row.attempts + 1;
      db.run(
        `UPDATE repo_jobs SET state = 'failed', attempts = ?, failure_code = ?, due_at = ?,
           updated_at_ms = max(updated_at_ms + 1, ?) WHERE did = ? AND kind = 'status'`,
        attempts,
        outcome.error,
        requestedAgain ? Math.min(row.due_at, now) : now + statusJobBackoffMs(attempts),
        now,
        did,
      );
      return;
    }
    // Not attempted (host paused, budget): back to pending, due when the host resumes.
    db.run(
      `UPDATE repo_jobs SET state = 'pending', due_at = ?, updated_at_ms = max(updated_at_ms + 1, ?)
       WHERE did = ? AND kind = 'status'`,
      outcome.outcome === 'host_paused' && !requestedAgain ? outcome.until : Math.min(row.due_at, now),
      now,
      did,
    );
  });
}

/** Run one claimed status job: check, then finish it. */
export async function runStatusJob(m: ModuleDeps, did: string, now: number, o: CheckOptions = {}) {
  const token = m.db.tx(() => claimStatusJob(m.db, did, now));
  if (token === null) return null;
  let outcome: StatusCheckOutcome;
  try {
    outcome = await checkStatus(m, did, { ...o, now });
  } catch (error) {
    m.log.log('error', 'status.job_error', { did, error: String(error) });
    outcome = { outcome: 'failed', error: 'internal' };
  }
  finishStatusJob(m.db, did, token, outcome, now);
  return outcome;
}

/** Earliest due_at of an open status job, or null. */
export function nextStatusJobDue(db: Db): number | null {
  return (
    db.one<{ next: number | null }>(
      `SELECT min(due_at) AS next FROM repo_jobs WHERE kind = 'status' AND state IN ('pending','failed')`,
    )?.next ?? null
  );
}

/**
 * Pull the `status-sweep` timer forward to the earliest open status job, but
 * no sooner than STATUS_JOB_MIN_INTERVAL_MS from now (a job the slice could not
 * afford must not spin the alarm), and never later than it already is.
 * Returns the stored due time, or null when no job is open.
 */
export function scheduleStatusJobsTimer(db: Db, now: number): number | null {
  const next = nextStatusJobDue(db);
  if (next === null) return null;
  const current = dueAt(db, 'status-sweep');
  const at = Math.max(next, now + STATUS_JOB_MIN_INTERVAL_MS);
  if (current !== null && current <= at) return current;
  return schedule(db, 'status-sweep', at);
}

/** A fresh subrequest meter for `checks` status checks (Free: the plan's slice limit). */
export function statusMeter(m: Pick<ModuleDeps, 'config'>, checks: number): SubrequestMeter {
  const budget = m.config.budget;
  const limit =
    m.config.plan === 'free'
      ? budget.subrequestsPerSlice
      : Math.max(budget.subrequestsPerSlice, checks * WORST_STATUS_CHECK_SUBREQUESTS);
  return new SubrequestMeter(limit);
}
