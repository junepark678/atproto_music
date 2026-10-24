// The verify drain: hints → identity → getRecord proof → verify → apply
// (ADR 0004 §5.4 "Verify drain", §7). Timer `drain` (W5-01 wires it).
//
// `drain(m, now, budget = m.config.budget)` takes up to `budget.drainHints`
// due hints (notify, then jetstream, then reconcile) that are not already in
// flight, claims them in the in-flight URI set, and works them with
// `budget.concurrentFetches` workers. For each hint, in order:
//
//  1. Re-read the row (it may have been coalesced or deleted meanwhile).
//     An unconfigured collection is dropped (counter `hint_dropped`).
//  2. Suppressed DID: the hint is dropped unless it is for `<p>.settings`
//     (only the opt-out record can lift an opt-out, ADR §5.3).
//  3. Unknown DID: `admit()` (admission.ts). The hint is never projected; the
//     admitted snapshot covers it. Busy → the hint backs off (`queue_full`).
//     A settings hint of an unknown DID is verified first, so an opt-out is
//     honoured even for a DID the index does not know (ADR §5.3).
//  4. Coalescing: 25 or more pending hints for one known DID → one snapshot
//     job (`reason='coalesced'`) and every hint of that DID is deleted, in one
//     transaction, before any fetch. When the snapshot cap is full the hints
//     are worked individually instead.
//  5. Identity: `resolveIdentity` (identity-cache.ts: identity_cache, 5 min
//     TTL, 1 h negative TTL). A definite failure or a transport failure backs
//     the hint off (no earlier than the negative entry's expiry).
//  6. Host pause: while `host_backoff` holds the DID's PDS host, the hint is
//     deferred to the end of the pause without counting an attempt.
//  7. Fetch `GET {pds}/xrpc/com.atproto.sync.getRecord?did&collection&rkey`
//     through SafeFetch (`getRecord` kind: 1 MiB cap, 10 s deadline, the full
//     URL/DoH/redirect policy), under the FetchLimiter (4 concurrent, 2 per
//     host, shared by every drain of this IndexDO instance).
//  8. Verify with `verifyProof` (commit-cache.ts: verifyRecordProof plus the
//     verified_commits signature cache). The CAR is verified under the
//     resolved `#atproto` key.
//  9. Apply in one `db.tx` that re-reads every guard (applyRecordProof, W2-04)
//     with the hint's receipt time as the +300 s bound, then deletes the hint.
//     If the hint changed while its proof was in flight (a newer event raised
//     its receipt time or claimed revision), the proof is still applied (it is
//     verified, and the per-URI guard keeps only the newest) but the hint is
//     kept and made due again, so the newer event is fetched too.
//
// Error mapping (ADR §5.4 "Errors"):
//  - 429, 5xx, timeout, network failure: `host_backoff` honouring Retry-After
//    / RateLimit-Reset (pds-budget.ts) and a hint backoff no earlier than it;
//  - RepoDeactivated, RepoTakendown, RepoSuspended, RepoNotFound: a `status`
//    repo job (W4-03 runs it), hint deleted;
//  - RecordNotFound (no exclusion proof), MethodNotImplemented / 404 / 501,
//    and the verifier's `no_proof`, `missing_block` or `car_malformed` (an
//    unparseable CAR): a snapshot (F4), hint deleted, nothing else changes —
//    in particular no row is deleted on a RecordNotFound;
//  - `bad_signature` / `key_unavailable`: one `resolveDid({fresh:true})` and a
//    re-verification of the same CAR under the fresh key; a second failure
//    fails closed (projection unchanged, counter `verify_failed`, backoff);
//  - every other verification failure fails closed the same way;
//  - a proof older than `users.max_rev` (or than the revision the hint
//    claimed) is a stale PDS: backoff, and after STALE_ATTEMPTS a snapshot;
//  - after MAX_HINT_ATTEMPTS failed attempts the hint gives up: counter
//    `hint_gave_up` and a snapshot.
// A rejection writes only `hints.attempts`/`last_error`/`due_at`, `counters`,
// caches (identity, verified commits, host pauses) and `repo_jobs`; the
// projection and checkpoint tables stay byte-identical (ADR §7.6).
//
// Budget: the slice reserves PROOF_FETCH_COST per fetch and
// IDENTITY_RESOLVE_COST per identity resolution that is not served from
// identity_cache, before starting it (SubrequestMeter); `PLAN=free` gives 40,
// Paid 200. A hint that does not fit is left due for the next alarm.
//
// Concurrency: every `db.tx` here is synchronous and opens after the awaited
// fetch/verify completed, so no transaction spans an await (ADR F3). The
// in-flight set (per Db, i.e. per IndexDO instance) keeps two drains (an alarm
// and an RPC-triggered one, or an alarm and a retry) from fetching one URI
// twice at once.

import { createSafeFetch, isSafeFetchError, type SafeFetch } from '@atmusic/atproto/net/safe-fetch';
import { VerifyError, type VerifyErrorCode } from '@atmusic/atproto/verify/types';
import { isTid } from '@atmusic/core/syntax';
import { fromMs, parseRfc3339 } from '@atmusic/core/timestamp';
import type { SliceBudget } from '../../config';
import type { ModuleDeps } from '../contracts';
import type { Db } from '../db';
import { cancel, schedule } from '../timers';
import { isSuppressed, loadUser } from '../write/account-state';
import { type ApplyResult, applyRecordProof } from '../write/apply-record';
import { collectionKind, incrementCounter } from '../write/keys';
import { admit, type ScheduleResult, scheduleSnapshot, scheduleStatusCheck } from './admission';
import { verifyProof } from './commit-cache';
import {
  backoffHint,
  countByDid,
  deferHint,
  deleteHint,
  deleteHintsForDid,
  type HintRow,
  nextHintDue,
  readHint,
  rearmHint,
  takeDue,
} from './hints';
import { cachedIdentity, resolveIdentity } from './identity-cache';
import {
  FetchLimiter,
  hostOf,
  hostPausedUntil,
  IDENTITY_RESOLVE_COST,
  PROOF_FETCH_COST,
  pauseFor,
  pauseHost,
  SubrequestMeter,
} from './pds-budget';

/** Pending hints for one DID at which they collapse into one snapshot job. */
export const COALESCE_THRESHOLD = 25;
/** Failed attempts after which a hint gives up and schedules a snapshot. */
export const MAX_HINT_ATTEMPTS = 20;
/** Stale-PDS attempts after which a hint schedules a snapshot. */
export const STALE_ATTEMPTS = 5;
/** The drain timer runs at most this often while hints are due (ADR §5.9). */
export const DRAIN_MIN_INTERVAL_MS = 2_000;

export const HINT_DROPPED_COUNTER = 'hint_dropped';
export const VERIFY_FAILED_COUNTER = 'verify_failed';
export const HINT_GAVE_UP_COUNTER = 'hint_gave_up';
export const COALESCED_COUNTER = 'coalesced';
export const FETCH_FAILED_COUNTER = 'proof_fetch_failed';

export const COALESCED_REASON = 'coalesced';

/** XRPC errors that mean the account is not servable: a `status` job. */
const ACCOUNT_STATUS_ERRORS = new Set(['RepoDeactivated', 'RepoTakendown', 'RepoSuspended', 'RepoNotFound']);
/** Verifier codes that mean "no usable proof here": a snapshot. */
const SNAPSHOT_CODES = new Set<string>(['no_proof', 'missing_block', 'car_malformed']);
/** Verifier codes that one fresh identity resolution may cure (key rotation). */
const FRESH_RETRY_CODES = new Set<string>(['bad_signature', 'key_unavailable']);

export type DrainOutcome =
  | ApplyResult['outcome']
  | 'rearmed'
  | 'skipped'
  | 'dropped'
  | 'admitted'
  | 'admission_busy'
  | 'coalesced'
  | 'identity_failed'
  | 'host_paused'
  | 'fetch_failed'
  | 'status_job'
  | 'snapshot_scheduled'
  | 'verify_failed'
  | 'stale'
  | 'gave_up'
  | 'budget';

export interface DrainReport {
  /** Hints claimed by this run. */
  claimed: number;
  /** Per claimed hint, in completion order. */
  outcomes: Array<{ uri: string; outcome: DrainOutcome; detail?: string }>;
  /** Subrequests reserved (an upper bound of what was actually sent). */
  subrequests: number;
}

interface DrainState {
  inFlight: Set<string>;
  limiter: FetchLimiter;
}

const states = new WeakMap<Db, DrainState>();

/** The in-memory drain state of one IndexDO instance (keyed by its Db). */
export function drainState(db: Db, budget: Pick<SliceBudget, 'concurrentFetches' | 'perHostConcurrency'>): DrainState {
  let state = states.get(db);
  if (state === undefined) {
    state = {
      inFlight: new Set(),
      limiter: new FetchLimiter({
        concurrentFetches: budget.concurrentFetches,
        perHostConcurrency: budget.perHostConcurrency,
      }),
    };
    states.set(db, state);
  }
  return state;
}

/**
 * Point the `drain` timer at the next due hint, no sooner than
 * DRAIN_MIN_INTERVAL_MS from now (the queue is the source of truth, so this
 * replaces whatever was stored), or cancel it when the queue is empty.
 */
export function scheduleDrainTimer(db: Db, now: number): number | null {
  const next = nextHintDue(db);
  if (next === null) {
    cancel(db, 'drain');
    return null;
  }
  return schedule(db, 'drain', Math.max(next, now + DRAIN_MIN_INTERVAL_MS), { force: true });
}

class RollbackAdmission extends Error {}

interface Ctx {
  m: ModuleDeps;
  prefix: string;
  now: number;
  meter: SubrequestMeter;
  limiter: FetchLimiter;
  safeFetch: SafeFetch;
  stop: boolean;
}

type Outcome = { outcome: DrainOutcome; detail?: string };

function counter(db: Db, name: string, label: string): void {
  incrementCounter(db, name, label);
}

/** A failed attempt; gives up (snapshot) once MAX_HINT_ATTEMPTS is reached. */
function fail(c: Ctx, row: HintRow, error: string, notBefore = 0, outcome: DrainOutcome = 'fetch_failed'): Outcome {
  const db = c.m.db;
  return db.tx((): Outcome => {
    const attempts = backoffHint(db, row.uri, c.now, error, notBefore);
    if (attempts === null) return { outcome: 'skipped' };
    if (attempts < MAX_HINT_ATTEMPTS) return { outcome, detail: error };
    const s = scheduleSnapshot(db, row.did, 'gave_up', c.now);
    // The snapshot queue is full: keep retrying (capped backoff) until it has room.
    if (s.status === 'busy') return { outcome, detail: error };
    // Scheduled, or nothing a snapshot could do (unknown or suppressed DID): give up.
    deleteHint(db, row.uri);
    counter(db, HINT_GAVE_UP_COUNTER, error);
    return { outcome: 'gave_up', detail: error };
  });
}

/** Replace the hint by a snapshot of its DID (`reason`); backs off when no snapshot can be scheduled. */
function snapshotInstead(c: Ctx, row: HintRow, reason: string): Outcome {
  const db = c.m.db;
  const scheduled = db.tx((): ScheduleResult => {
    const s = scheduleSnapshot(db, row.did, reason, c.now);
    if (s.status === 'scheduled' || s.status === 'already') deleteHint(db, row.uri);
    return s;
  });
  if (scheduled.status === 'scheduled' || scheduled.status === 'already') {
    return { outcome: 'snapshot_scheduled', detail: reason };
  }
  return fail(c, row, `${reason}:${scheduled.status}`);
}

function drop(c: Ctx, row: HintRow, reason: string): Outcome {
  const db = c.m.db;
  db.tx(() => {
    deleteHint(db, row.uri);
    counter(db, HINT_DROPPED_COUNTER, reason);
  });
  return { outcome: 'dropped', detail: reason };
}

function getRecordUrl(pds: string, row: HintRow): URL {
  const url = new URL('/xrpc/com.atproto.sync.getRecord', pds);
  url.searchParams.set('did', row.did);
  url.searchParams.set('collection', row.collection);
  url.searchParams.set('rkey', row.rkey);
  return url;
}

/** Apply a verified proof in one transaction; see the header, step 9. */
function applyVerified(c: Ctx, row: HintRow, proof: Parameters<typeof applyRecordProof>[1]): Outcome {
  const db = c.m.db;
  const receiptNs = parseRfc3339(row.receipt_time);
  if (receiptNs === null) throw new Error(`hint ${row.uri} has an unparseable receipt_time`);
  try {
    return db.tx((): Outcome => {
      const current = readHint(db, row.uri);
      const result = applyRecordProof(db, proof, { receiptNs, prefix: c.prefix, nowNs: fromMs(c.now) });
      if (result.outcome === 'stale_head') {
        return staleProof(c, row, current);
      }
      if (result.admit) {
        // The opt-out was lifted: admit a fresh snapshot in the same transaction.
        const a = admit(db, proof.commit.did, 'settings', c.now);
        if (a.status === 'busy') throw new RollbackAdmission();
      } else if (result.outcome === 'ignored' && proof.collection === `${c.prefix}.settings`) {
        // A settings record of a DID we do not know (and that is not opting out): admission.
        if (!isSuppressed(db, row.did) && loadUser(db, row.did) === null) {
          const a = admit(db, row.did, row.source, c.now);
          if (a.status === 'busy') throw new RollbackAdmission();
        }
      }
      if (current === null) return { outcome: result.outcome };
      const claimedNewer = current.hint_rev !== null && isTid(current.hint_rev) && proof.commit.rev < current.hint_rev;
      const changed = current.receipt_time !== row.receipt_time || current.hint_rev !== row.hint_rev;
      if (changed) {
        // A newer event arrived while this proof was in flight: fetch again.
        rearmHint(db, row.uri, c.now);
        return { outcome: 'rearmed', detail: result.outcome };
      }
      if (claimedNewer) return staleProof(c, row, current);
      deleteHint(db, row.uri);
      return result.reason === undefined
        ? { outcome: result.outcome }
        : { outcome: result.outcome, detail: result.reason };
    });
  } catch (error) {
    if (error instanceof RollbackAdmission) return fail(c, row, 'queue_full', 0, 'admission_busy');
    throw error;
  }
}

/** The PDS served a head older than one already applied or claimed: back off, then snapshot. */
function staleProof(c: Ctx, row: HintRow, current: HintRow | null): Outcome {
  const db = c.m.db;
  if (current === null) return { outcome: 'stale' };
  const attempts = backoffHint(db, row.uri, c.now, 'stale_head');
  if (attempts !== null && attempts >= STALE_ATTEMPTS) {
    const s = scheduleSnapshot(db, row.did, 'stale_head', c.now);
    if (s.status === 'scheduled' || s.status === 'already') {
      deleteHint(db, row.uri);
      return { outcome: 'snapshot_scheduled', detail: 'stale_head' };
    }
  }
  return { outcome: 'stale', detail: 'stale_head' };
}

async function processHint(c: Ctx, taken: HintRow): Promise<Outcome> {
  const db = c.m.db;
  const row = readHint(db, taken.uri);
  if (row === null) return { outcome: 'skipped' };
  if (row.due_at > c.now) return { outcome: 'skipped' };

  const kind = collectionKind(c.prefix, row.collection);
  if (kind === null) return drop(c, row, 'unconfigured');
  const suppressed = isSuppressed(db, row.did);
  if (suppressed && kind !== 'settings') return drop(c, row, 'suppressed');
  const user = suppressed ? null : loadUser(db, row.did);

  if (!suppressed && user === null && kind !== 'settings') {
    const outcome = db.tx((): Outcome => {
      const a = admit(db, row.did, row.source, c.now);
      if (a.status === 'admitted' || a.status === 'known') {
        deleteHint(db, row.uri);
        return { outcome: 'admitted', detail: a.status };
      }
      if (a.status === 'suppressed') {
        deleteHint(db, row.uri);
        counter(db, HINT_DROPPED_COUNTER, 'suppressed');
        return { outcome: 'dropped', detail: 'suppressed' };
      }
      return { outcome: 'admission_busy', detail: a.reason };
    });
    return outcome.outcome === 'admission_busy' ? fail(c, row, 'queue_full', 0, 'admission_busy') : outcome;
  }

  if (user !== null && countByDid(db, row.did) >= COALESCE_THRESHOLD) {
    const collapsed = db.tx((): number | null => {
      const s = scheduleSnapshot(db, row.did, COALESCED_REASON, c.now);
      if (s.status !== 'scheduled' && s.status !== 'already') return null;
      const n = deleteHintsForDid(db, row.did);
      counter(db, COALESCED_COUNTER, '');
      return n;
    });
    if (collapsed !== null) return { outcome: 'coalesced', detail: String(collapsed) };
  }

  // Identity (identity_cache first; a network resolution must fit the budget).
  if (cachedIdentity(db, row.did, c.m.clock.nowMs()) === null && !c.meter.tryReserve(IDENTITY_RESOLVE_COST)) {
    c.stop = true;
    return { outcome: 'budget' };
  }
  let id = await resolveIdentity(c.m, row.did);
  if (!id.ok) {
    if (id.kind === 'invalid') return fail(c, row, `identity:${id.code}`, id.retryAt, 'identity_failed');
    return fail(c, row, 'identity:transient', 0, 'identity_failed');
  }

  let host: string;
  try {
    host = hostOf(id.identity.pds);
  } catch {
    return fail(c, row, 'identity:invalid_pds', 0, 'identity_failed');
  }
  const pausedBefore = hostPausedUntil(db, host, c.now);
  if (pausedBefore !== null) {
    db.tx(() => deferHint(db, row.uri, pausedBefore, 'host_paused'));
    return { outcome: 'host_paused', detail: host };
  }
  if (!c.meter.tryReserve(PROOF_FETCH_COST)) {
    c.stop = true;
    return { outcome: 'budget' };
  }

  let body: Uint8Array;
  const release = await c.limiter.acquire(host);
  try {
    // Another worker may have paused the host while this one waited for a slot.
    const pausedNow = hostPausedUntil(db, host, c.now);
    if (pausedNow !== null) {
      db.tx(() => deferHint(db, row.uri, pausedNow, 'host_paused'));
      return { outcome: 'host_paused', detail: host };
    }
    body = (await c.safeFetch(getRecordUrl(id.identity.pds, row), { kind: 'getRecord' })).body;
  } catch (error) {
    return fetchFailed(c, row, host, error);
  } finally {
    release();
  }

  // Verify, with one fresh-identity retry for a signature failure (key rotation).
  const collection = row.collection;
  const opts = { did: row.did, collection, rkey: row.rkey };
  let freshTried = false;
  for (;;) {
    try {
      const verified = await verifyProof(db, body, { ...opts, signingKey: id.identity.signingKey }, c.now);
      return applyVerified(c, row, verified.proof);
    } catch (error) {
      const code = errorCode(error);
      if (code !== null && FRESH_RETRY_CODES.has(code) && !freshTried) {
        freshTried = true;
        if (!c.meter.tryReserve(IDENTITY_RESOLVE_COST)) {
          c.stop = true;
          return verifyFailed(c, row, code);
        }
        const fresh = await resolveIdentity(c.m, row.did, { fresh: true });
        // Same key as before: the CAR cannot verify under it either.
        if (!fresh.ok || fresh.identity.signingKey === id.identity.signingKey) return verifyFailed(c, row, code);
        id = fresh;
        continue;
      }
      if (code !== null && SNAPSHOT_CODES.has(code)) {
        db.tx(() => counter(db, VERIFY_FAILED_COUNTER, code));
        return snapshotInstead(c, row, code);
      }
      if (code !== null) return verifyFailed(c, row, code);
      c.m.log.log('error', 'drain.verify_error', { uri: row.uri, error: String(error) });
      return verifyFailed(c, row, 'verify_error');
    }
  }
}

function errorCode(error: unknown): VerifyErrorCode | null {
  return error instanceof VerifyError ? error.code : null;
}

/** Fail closed: the projection is untouched; count it and back off. */
function verifyFailed(c: Ctx, row: HintRow, code: string): Outcome {
  const db = c.m.db;
  c.m.log.log('warn', 'drain.verify_failed', { uri: row.uri, code });
  db.tx(() => counter(db, VERIFY_FAILED_COUNTER, code));
  const out = fail(c, row, `verify:${code}`, 0, 'verify_failed');
  return out.outcome === 'gave_up' ? out : { outcome: 'verify_failed', detail: code };
}

function fetchFailed(c: Ctx, row: HintRow, host: string, error: unknown): Outcome {
  const db = c.m.db;
  if (!isSafeFetchError(error)) {
    c.m.log.log('error', 'drain.fetch_error', { uri: row.uri, error: String(error) });
    return fail(c, row, 'fetch:error');
  }
  if (error.code === 'http_status') {
    const xrpc = error.xrpcError ?? '';
    if (ACCOUNT_STATUS_ERRORS.has(xrpc)) {
      const s = db.tx(() => {
        const r = scheduleStatusCheck(db, row.did, xrpc, c.now);
        if (r.status === 'scheduled') deleteHint(db, row.uri);
        return r;
      });
      if (s.status === 'scheduled') return { outcome: 'status_job', detail: xrpc };
      return fail(c, row, `fetch:${xrpc}`);
    }
    if (xrpc === 'RecordNotFound') return snapshotInstead(c, row, 'record_not_found');
    if (xrpc === 'MethodNotImplemented' || error.status === 404 || error.status === 501) {
      return snapshotInstead(c, row, 'get_record_unsupported');
    }
  }
  db.tx(() => counter(db, FETCH_FAILED_COUNTER, error.status === null ? error.code : `${error.code}_${error.status}`));
  const pause = pauseFor(error);
  if (pause !== null) {
    const until = db.tx(() => pauseHost(db, host, c.now, pause));
    return fail(c, row, error.status === null ? `fetch:${error.code}` : `fetch:http_${error.status}`, until);
  }
  return fail(c, row, error.status === null ? `fetch:${error.code}` : `fetch:http_${error.status}`);
}

/**
 * One drain slice. `budget` defaults to the configured plan's slice budget
 * (`PLAN=free`: 40 hints and 40 subrequests; Paid: 200 and 200).
 */
export async function drain(m: ModuleDeps, now: number, budget: SliceBudget = m.config.budget): Promise<DrainReport> {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError(`now must be epoch ms, got ${now}`);
  const report: DrainReport = { claimed: 0, outcomes: [], subrequests: 0 };
  const prefix = m.config.prefix;
  if (prefix === null) return report; // namespace gate closed: nothing is ingested

  const state = drainState(m.db, budget);
  const queue = takeDue(m.db, now, budget.drainHints, state.inFlight);
  for (const row of queue) state.inFlight.add(row.uri);
  report.claimed = queue.length;

  const c: Ctx = {
    m,
    prefix,
    now,
    meter: new SubrequestMeter(budget.subrequestsPerSlice),
    limiter: state.limiter,
    safeFetch: createSafeFetch({ transport: m.transport, clock: m.clock }),
    stop: false,
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const row = queue.shift();
      if (row === undefined) return;
      let out: Outcome;
      try {
        out = c.stop ? { outcome: 'budget' } : await processHint(c, row);
      } catch (error) {
        m.log.log('error', 'drain.hint_error', { uri: row.uri, error: String(error) });
        out = fail(c, row, 'internal');
      } finally {
        state.inFlight.delete(row.uri);
      }
      report.outcomes.push({ uri: row.uri, ...out });
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, budget.concurrentFetches) }, worker));
  } finally {
    for (const row of queue) state.inFlight.delete(row.uri);
  }
  report.subrequests = c.meter.reserved;
  m.db.tx(() => scheduleDrainTimer(m.db, now));
  return report;
}
