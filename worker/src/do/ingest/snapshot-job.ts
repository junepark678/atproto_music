// Resumable range-snapshot jobs (ADR 0004 §5.7; ADR 0003 generation rules)
// and gap recovery (§5.5). Timer `snapshot` (W5-01 wires it to snapshotStep).
//
// A snapshot imports one DID's music records from its signed repository head:
// activation of an admitted DID, reactivation, gap recovery, PDS migration,
// coalesced hint bursts and proof errors all end here. One
// `repo_jobs(did,'snapshot')` row holds the walk; `snapshotStep` runs one
// bounded slice of the oldest due job.
//
// One slice (`snapshotStep(m, now, budget)`):
//  1. `reclaimSnapshotLeases(db, now)` returns rows whose lease is older than
//     SNAPSHOT_LEASE_MS to `pending` (IndexDO also calls it with `all` at
//     start-up), and the gap scan advances one batch (below).
//  2. Claim: one compare-and-set statement takes the oldest due row,
//     `pending` (or `failed` with its backoff `due_at` passed) → `running`,
//     with the lease token `updated_at_ms = max(updated_at_ms + 1, now)`. A
//     fresh walk (`failed`, or `pending` with frontier_json and head_cid NULL)
//     gets `attempts = 0`; a `failed` claim also clears frontier, head,
//     restarts and failure. A `running` row is never claimed.
//  3. Generation: a job whose generation is no longer the user's (a
//     deactivation since it was scheduled) is closed `superseded`.
//  4. A fresh walk: identity (identity_cache, 5 min TTL), getRepoStatus (must
//     be active), getLatestCommit, then the commit through getBlocks, verified
//     under the resolved `#atproto` key (verify/commit.ts). Its rev must not
//     be below `users.max_rev` or the snapshot floor `repo_jobs.head_rev`
//     (stale PDS, ADR §7.5). head_cid / head_rev / frontier_json are written
//     under the lease.
//  5. Walk: `walker.step` over the key range `[p., p/)` with the BlockCache
//     over snapshot_blocks (block-cache.ts) and `knownCid` from record_state,
//     scrobbles and follows, so only changed records are fetched. Each chunk
//     is applied in one db.tx with `applySnapshotChunk` (W2-04) and the new
//     frontier, under the lease. Before applying, every entry the walker
//     emitted without a body must still carry the stored CID (a live proof
//     can change it while the step awaits); otherwise the slice pauses and
//     the next one re-steps from the previous frontier.
//  6. Finish: getRepoStatus again, then `completeSnapshot` in the guarded
//     db.tx. `attempts > 0` (a request arrived after the claim, see
//     admission.ts `scheduleSnapshot`) sends the job back to `pending` as a
//     fresh walk (frontier, head and restarts cleared, due now) keeping the
//     CID cache, so the rescan of the newest head is incremental. Otherwise the
//     job is `complete` and the cache is cleared. A generation change makes
//     the completion `superseded`: nothing is activated, the job is closed
//     and the cache cleared.
//  7. The slice stops when its subrequest budget (Free: the plan's 40, Paid:
//     200; each SafeFetch is reserved as SNAPSHOT_FETCH_COST: the request and
//     an A and AAAA DoH pre-check, an uncached identity as
//     IDENTITY_RESOLVE_COST) or its entry budget (2,000) is spent: the job goes
//     back to `pending`, due now, with its frontier.
//
// Lease: every write of a slice (head at walk start, each chunk with its
// frontier, a missing_block restart, the pause, a failure, the completion)
// is one statement or transaction guarded by `state='running' AND
// generation=? AND updated_at_ms=?` on its own row, which sets a new token the
// slice keeps. Snapshot block-cache rows are written only inside those
// transactions. A guard miss (generation change, reclaim, a request that
// restarted a superseded walk) means the slice lost the job: it writes
// nothing more and ends (`lost`).
//
// Errors:
//  - `missing_block` mid-walk (BlockNotFound: the PDS garbage-collected the old
//    head): `restarts + 1`, then the walk restarts from the beginning of the
//    range at the new head, reusing the CID cache. `restarts > 5` →
//    `failed`, `failure_code='repository_changed'`, due after
//    REPOSITORY_CHANGED_BACKOFF_MS. `restarts` counts only these.
//  - getBlocks unsupported (MethodNotImplemented, 404, 501): the job switches
//    to the getRepo stream (32 MiB cap); every block is CID-checked into
//    snapshot_blocks and the same walker runs over a cache-only source. The
//    source is remembered in the frontier, so later slices stay cache-only.
//  - `bad_signature` / `key_unavailable` on the head: one fresh identity
//    resolution and a re-verification, then fail closed.
//  - RepoNotFound (or another Repo* error), or a getRepoStatus `active:false`
//    body, from a PDS chosen by a cached identity: one fresh resolution; a
//    changed PDS (migration A→B, whether A answers RepoNotFound or reports the
//    account deactivated) is retried at once. Otherwise the account is
//    deactivated (generation.ts) and the job closed (`inactive`).
//  - 429 / 5xx / timeout: the host is paused (pds-budget.ts) and the walk is
//    paused with its frontier, backing off; after MAX_TRANSIENT_ERRORS in a
//    row it fails (`pds_unavailable`).
//  - Any other verification failure fails closed: `failed` with the code and
//    SNAPSHOT_FAILURE_BACKOFF_MS, the projection untouched (and, for
//    cid_mismatch / mst_invalid, the cache dropped).
//
// Gap recovery (§5.5), through `ingest_checkpoint` and the W2-05 writer
// `updateCheckpointBookkeeping` only (never ingest_checkpoint SQL, so neither
// `updated_at_ms`, `connected`, `connected_at_ms`, `cursor` nor
// `last_event_time_us` can move):
//  - `scheduleGapRecovery(db, now)` (W4-02, on a gap at connect) sets
//    `pending_gap = 1`, restarts the scan at the first DID and schedules its
//    first batch;
//  - `continueGapRecovery(db, now)` (every snapshot slice) schedules the next
//    batch of GAP_SCAN_BATCH known DIDs after `gap_scan_after_did` with
//    `reason = GAP_REASON`, within the 1,024 pending-job cap of
//    `scheduleSnapshot`: a full queue stops the batch and the scan resumes
//    there once jobs complete. An open job that absorbs the request (a walk in
//    progress, an unstarted or a failed one: `scheduleSnapshot` 'already')
//    is re-tagged `reason = GAP_REASON` too, since its completion (a rescan of
//    the newest head when its walk had started) is what covers the gap. A
//    finished scan stores GAP_SCAN_DONE;
//  - `maybeClearGap(db)` clears `pending_gap` only when the scan is finished
//    and no gap-sourced job (`reason = GAP_REASON`) remains open.
//  The seeded first-start gap (`pending_gap = 1` with no scan) is left alone
//  until a scan is started, so nothing clears it before the first connect.
//
// Timer: `snapshotStep` re-arms the `snapshot` timer from the job table
// (`scheduleSnapshotTimer`): the earliest due job, or the next gap-scan batch
// only while the queue has a free slot (a full queue waits for the next due
// job, not SNAPSHOT_MIN_INTERVAL_MS polling); writers that create jobs outside a slice
// (admission, the drain, sweeps) leave the arming to IndexDO (W5-01), which
// can call `scheduleSnapshotTimer` after them.
//
// Concurrency: every db.tx here is synchronous and opens after the awaited
// fetch/verify completed, so no transaction spans an await (ADR F3).

import { BytesWrapper, CidLinkWrapper, decode } from '@atcute/cbor';
import type { ResolvedIdentity } from '@atmusic/atproto/identity/types';
import {
  createSafeFetch,
  isSafeFetchError,
  type SafeFetch,
  type SafeFetchError,
  type SafeFetchOptions,
} from '@atmusic/atproto/net/safe-fetch';
import { type BlockSource, cacheOnlySource, isBlockSourceError } from '@atmusic/atproto/snapshot/block-source';
import { getBlocksSource } from '@atmusic/atproto/snapshot/getblocks-source';
import { streamRepoIntoCache } from '@atmusic/atproto/snapshot/getrepo-source';
import { type KeyRange, prefixRange } from '@atmusic/atproto/snapshot/range';
import { initialState, type StepResult, step, type WalkState } from '@atmusic/atproto/snapshot/walker';
import { verifyCommit } from '@atmusic/atproto/verify/commit';
import { type VerifiedCommit, VerifyError } from '@atmusic/atproto/verify/types';
import { isTid } from '@atmusic/core/syntax';
import { fromMs } from '@atmusic/core/timestamp';
import type { SliceBudget } from '../../config';
import type { ModuleDeps, RepoJobRow } from '../contracts';
import type { Db, SqlParam } from '../db';
import { GAP_REASON, JETSTREAM_STREAM, updateCheckpointBookkeeping } from '../status';
import { cancel, schedule } from '../timers';
import type { InactiveStatus } from '../write/account-state';
import { loadUser, markInactive } from '../write/account-state';
import { applySnapshotChunk, completeSnapshot, type SnapshotChunkEntry } from '../write/apply-snapshot';
import { collectionKind, incrementCounter, recordUri, splitKey } from '../write/keys';
import {
  MAX_PENDING_SNAPSHOT_JOBS,
  pendingSnapshotJobs,
  reclaimSnapshotLeases,
  type ScheduleResult,
  scheduleSnapshot,
  scheduleStatusCheck,
} from './admission';
import { clearBlockCache, SnapshotBlockCache } from './block-cache';
import { checkGeneration } from './generation';
import { cachedIdentity, resolveIdentity } from './identity-cache';
import { hostOf, hostPausedUntil, IDENTITY_RESOLVE_COST, pauseFor, pauseHost, SubrequestMeter } from './pds-budget';

/** missing_block restarts allowed per walk (ADR §5.7 step 8); the next one fails the job. */
export const MAX_SNAPSHOT_RESTARTS = 5;
export const REPOSITORY_CHANGED = 'repository_changed';
/** Backoff of a job failed with `repository_changed` (not derived from `attempts`). */
export const REPOSITORY_CHANGED_BACKOFF_MS = 30 * 60_000;
/** Backoff of a job that failed closed (verification, identity, policy). */
export const SNAPSHOT_FAILURE_BACKOFF_MS = 10 * 60_000;
/** Pause after a transient PDS error: base · 2^(errors−1), capped. */
export const TRANSIENT_PAUSE_BASE_MS = 5_000;
export const TRANSIENT_PAUSE_CAP_MS = 3_600_000;
/** Consecutive transient errors after which the walk fails (`pds_unavailable`). */
export const MAX_TRANSIENT_ERRORS = 10;
/** Subrequests reserved per SafeFetch: the request plus an A and an AAAA DoH lookup. */
export const SNAPSHOT_FETCH_COST = 3;
/** Known DIDs examined per gap-scan batch. */
export const GAP_SCAN_BATCH = 200;
/**
 * `gap_scan_after_did` values: NULL = no scan scheduled (the seeded first-start
 * gap stays pending until W4-02 starts one), GAP_SCAN_START = scan from the
 * first DID, a DID = resume after it, GAP_SCAN_DONE = passed the last DID.
 */
export const GAP_SCAN_START = '';
export const GAP_SCAN_DONE = '~done';
/** The snapshot timer runs at most this often while jobs are due. */
export const SNAPSHOT_MIN_INTERVAL_MS = 1_000;

export const SNAPSHOT_COMPLETED_COUNTER = 'snapshot_completed';
export const SNAPSHOT_FAILED_COUNTER = 'snapshot_failed';
export const SNAPSHOT_RESTART_COUNTER = 'snapshot_restarts';
export const SNAPSHOT_SUPERSEDED_COUNTER = 'snapshot_superseded';
export const SNAPSHOT_RESCAN_STARTED_COUNTER = 'snapshot_rescan_started';
export const SNAPSHOT_FALLBACK_COUNTER = 'snapshot_getrepo_fallback';
export const GAP_RECOVERY_COUNTER = 'gap_recovery';

/** `failure_code` of a job closed because its generation is no longer current. */
export const SUPERSEDED = 'superseded';
/** `failure_code` of a job closed because the account is not active. */
export const INACTIVE = 'inactive';

const FRONTIER_VERSION = 1;
/** Fetch budget handed to the walker over a cache-only source (no subrequests). */
const LOCAL_FETCHES = 1_000_000;
const NSID_STATUS = 'com.atproto.sync.getRepoStatus';
const NSID_LATEST = 'com.atproto.sync.getLatestCommit';
const ACCOUNT_ERRORS: Readonly<Record<string, InactiveStatus>> = {
  RepoDeactivated: 'deactivated',
  RepoTakendown: 'takendown',
  RepoSuspended: 'suspended',
  RepoNotFound: 'not_found',
};
const INACTIVE_STATUSES = new Set<string>([
  'deactivated',
  'takendown',
  'suspended',
  'deleted',
  'desynchronized',
  'throttled',
  'not_found',
]);

export type BlockSourceKind = 'getBlocks' | 'getRepo';

/** The persisted walk: `repo_jobs.frontier_json`. */
export interface Frontier {
  v: typeof FRONTIER_VERSION;
  source: BlockSourceKind;
  walk: WalkState;
  /** Consecutive transient PDS errors (reset by progress). */
  errors: number;
}

export type SnapshotOutcome =
  | 'idle'
  | 'paused'
  | 'complete'
  | 'rescan'
  | 'superseded'
  | 'suppressed'
  | 'inactive'
  | 'failed'
  | 'lost';

export interface SnapshotStepReport {
  /** The claimed DID, or null when no job was due. */
  did: string | null;
  outcome: SnapshotOutcome;
  detail?: string;
  /** Chunks applied (applySnapshotChunk calls that wrote under the lease). */
  chunks: number;
  /** Entries handed to applySnapshotChunk. */
  entries: number;
  /** Rows written (upserted or excluded) and swept to absent. */
  written: number;
  deleted: number;
  /** SafeFetch requests sent. */
  fetches: number;
  /** Subrequests reserved (an upper bound of what was actually sent). */
  subrequests: number;
  /** missing_block restarts in this slice. */
  restarts: number;
  source: BlockSourceKind | null;
  gap: GapScanReport | null;
  gapCleared: boolean;
}

// ---------------------------------------------------------------------------
// Internal signals

const LOST: unique symbol = Symbol('lease lost');

class LeaseLost extends Error {
  constructor() {
    super('snapshot lease lost');
    this.name = 'LeaseLost';
  }
}

class BudgetExhausted extends Error {
  constructor() {
    super('snapshot slice budget exhausted');
    this.name = 'BudgetExhausted';
  }
}

class AccountUnavailable extends Error {
  constructor(readonly status: InactiveStatus) {
    super(`account is ${status}`);
    this.name = 'AccountUnavailable';
  }
}

class IdentityFailed extends Error {
  constructor(
    readonly code: string,
    readonly retryAt: number | null,
  ) {
    super(`identity: ${code}`);
    this.name = 'IdentityFailed';
  }
}

class StaleHead extends Error {
  constructor(rev: string) {
    super(`PDS head ${rev} is below the stored floor`);
    this.name = 'StaleHead';
  }
}

class BadResponse extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BadResponse';
  }
}

class HostPaused extends Error {
  constructor(readonly until: number) {
    super(`PDS host paused until ${until}`);
    this.name = 'HostPaused';
  }
}

const RETRY: unique symbol = Symbol('retry chunk');

/** Thrown inside a chunk transaction to roll it back and re-step (see the header, step 5). */
class RetryChunk extends Error {}

// ---------------------------------------------------------------------------
// Small helpers

function isMissingBlock(e: unknown): boolean {
  return e instanceof VerifyError && e.code === 'missing_block';
}

function keyParts(key: string): [string, string] {
  const { collection, rkey } = splitKey(key);
  return [collection, rkey];
}

function assertEpochMs(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be epoch ms, got ${value}`);
}

/** The CID currently stored for `uri`: record_state, else a projection row. */
function storedCid(db: Db, uri: string): string | null {
  const state = db.one<{ cid: string | null }>('SELECT cid FROM record_state WHERE uri = ?', uri);
  if (state !== null) return state.cid;
  const row = db.one<{ cid: string }>(
    'SELECT cid FROM scrobbles WHERE uri = ? UNION ALL SELECT cid FROM follows WHERE uri = ? LIMIT 1',
    uri,
    uri,
  );
  return row?.cid ?? null;
}

const MAX_RECORD_DEPTH = 64;

/** dag-cbor value → atproto JSON form (links `{$link}`, bytes `{$bytes}`). */
function jsonForm(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof CidLinkWrapper) return { $link: value.$link };
  if (value instanceof BytesWrapper) return { $bytes: value.$bytes };
  if (depth > MAX_RECORD_DEPTH) throw new RangeError('record nests too deeply');
  if (Array.isArray(value)) return value.map((v) => jsonForm(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonForm(v, depth + 1)]));
}

/**
 * A signed record block as the validator sees it. A block that is not
 * decodable dag-cbor (or nests too deeply) is still the signed record at that
 * key: it is handed over as `null`, which validation excludes with a reason,
 * rather than blocking the whole snapshot.
 */
function recordValue(bytes: Uint8Array): unknown {
  try {
    return jsonForm(decode(bytes), 1);
  } catch {
    return null;
  }
}

function transientPauseMs(errors: number): number {
  const exp = Math.min(Math.max(errors - 1, 0), 30);
  return Math.min(TRANSIENT_PAUSE_BASE_MS * 2 ** exp, TRANSIENT_PAUSE_CAP_MS);
}

function parseFrontier(json: string | null): Frontier | null {
  if (json === null) return null;
  try {
    const f = JSON.parse(json) as Frontier;
    if (
      f !== null &&
      typeof f === 'object' &&
      f.v === FRONTIER_VERSION &&
      (f.source === 'getBlocks' || f.source === 'getRepo') &&
      f.walk !== null &&
      typeof f.walk === 'object' &&
      Number.isSafeInteger(f.errors)
    ) {
      return f;
    }
  } catch {
    // fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claim

/**
 * Claim the oldest due snapshot job: one compare-and-set statement (see the
 * header, step 2). Returns the claimed row (with its new lease token) or null.
 */
export function claimSnapshotJob(db: Db, now: number): RepoJobRow | null {
  assertEpochMs('now', now);
  return db.one<RepoJobRow>(
    `UPDATE repo_jobs SET state = 'running',
       attempts = CASE WHEN state = 'failed' OR (frontier_json IS NULL AND head_cid IS NULL) THEN 0 ELSE attempts END,
       restarts = CASE WHEN state = 'failed' THEN 0 ELSE restarts END,
       frontier_json = CASE WHEN state = 'failed' THEN NULL ELSE frontier_json END,
       head_cid = CASE WHEN state = 'failed' THEN NULL ELSE head_cid END,
       failure_code = CASE WHEN state = 'failed' THEN NULL ELSE failure_code END,
       updated_at_ms = max(updated_at_ms + 1, ?)
     WHERE kind = 'snapshot' AND state IN ('pending','failed') AND due_at <= ?
       AND did = (SELECT did FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','failed') AND due_at <= ?
                  ORDER BY due_at, did LIMIT 1)
     RETURNING *`,
    now,
    now,
    now,
  );
}

// ---------------------------------------------------------------------------
// The slice

interface HeadResult {
  commit: VerifiedCommit;
  source: BlockSourceKind;
}

class Slice {
  readonly db: Db;
  readonly did: string;
  readonly generation: number;
  token: number;
  restarts: number;
  frontier: Frontier | null;
  identity: ResolvedIdentity | null = null;
  identityFresh = false;
  readonly meter: SubrequestMeter;
  readonly safeFetch: SafeFetch;
  readonly cache: SnapshotBlockCache;
  readonly range: KeyRange;
  readonly report: SnapshotStepReport;
  private entriesLeft: number;

  constructor(
    readonly m: ModuleDeps,
    readonly prefix: string,
    readonly now: number,
    budget: SliceBudget,
    job: RepoJobRow,
    report: SnapshotStepReport,
  ) {
    this.db = m.db;
    this.did = job.did;
    this.generation = job.generation;
    this.token = job.updated_at_ms;
    this.restarts = job.restarts;
    this.frontier = job.head_cid === null ? null : parseFrontier(job.frontier_json);
    this.meter = new SubrequestMeter(budget.subrequestsPerSlice);
    this.entriesLeft = budget.maxEntriesPerSlice;
    this.range = prefixRange(prefix);
    this.report = report;
    const inner = createSafeFetch({ transport: m.transport, clock: m.clock });
    const reserve = () => {
      if (!this.meter.tryReserve(SNAPSHOT_FETCH_COST)) throw new BudgetExhausted();
      this.report.fetches++;
    };
    const metered = ((url: string | URL, o: SafeFetchOptions) => {
      reserve();
      return inner(url, o);
    }) as SafeFetch;
    metered.stream = (url, o) => {
      reserve();
      return inner.stream(url, o);
    };
    this.safeFetch = metered;
    this.cache = new SnapshotBlockCache(this.db, this.did, {
      onOverflow: () => {
        if (this.write('', [], () => true) === LOST) throw new LeaseLost();
      },
    });
  }

  // ---- lease-guarded writes ---------------------------------------------

  /**
   * One guarded transaction: the lease guard and `set` on the job row, the
   * buffered cache rows, then `fn`. LOST (and nothing written) on a miss.
   */
  write<T>(set: string, params: SqlParam[], fn: () => T): T | typeof LOST;
  write<T>(set: string, params: SqlParam[], fn: () => T, retryable: true): T | typeof LOST | typeof RETRY;
  write<T>(set: string, params: SqlParam[], fn: () => T, retryable = false): T | typeof LOST | typeof RETRY {
    const db = this.db;
    let token = this.token;
    let out: T | typeof LOST;
    // `fn` is synchronous (every caller passes a plain function); the cast only
    // satisfies db.tx's Promise-rejecting signature for a generic T.
    const body = (): T | typeof LOST => {
      const row = db.one<{ updated_at_ms: number }>(
        `UPDATE repo_jobs SET ${set === '' ? '' : `${set}, `}updated_at_ms = max(updated_at_ms + 1, ?)
           WHERE did = ? AND kind = 'snapshot' AND state = 'running' AND generation = ? AND updated_at_ms = ?
           RETURNING updated_at_ms`,
        ...params,
        this.now,
        this.did,
        this.generation,
        this.token,
      );
      if (row === null) return LOST;
      token = row.updated_at_ms;
      this.cache.flush();
      return fn();
    };
    try {
      out = db.tx(body as () => never) as T | typeof LOST;
    } catch (e) {
      // Rolled back: the token and the buffered blocks are as before.
      if (retryable && e instanceof RetryChunk) return RETRY;
      throw e;
    }
    if (out === LOST) {
      // The slice lost its job: nothing it buffered is ever written.
      this.cache.discard();
      return LOST;
    }
    this.token = token;
    this.cache.discard(); // written by the committed transaction
    return out;
  }

  private outcome(o: SnapshotOutcome | typeof LOST): SnapshotOutcome {
    return o === LOST ? 'lost' : o;
  }

  pause(dueAt: number, frontier: Frontier | null = this.frontier): SnapshotOutcome {
    return this.outcome(
      this.write(
        `state = 'pending', due_at = ?, frontier_json = ?`,
        [dueAt, frontier === null ? null : JSON.stringify(frontier)],
        () => 'paused' as const,
      ),
    );
  }

  fail(code: string, backoffMs: number, o: { restarts?: number; clearCache?: boolean } = {}): SnapshotOutcome {
    const r = this.write(
      `state = 'failed', failure_code = ?, due_at = ?, frontier_json = NULL, head_cid = NULL, restarts = ?`,
      [code, this.now + backoffMs, o.restarts ?? this.restarts],
      () => {
        if (o.clearCache) clearBlockCache(this.db, this.did);
        incrementCounter(this.db, SNAPSHOT_FAILED_COUNTER, code);
        return 'failed' as const;
      },
    );
    if (r !== LOST) {
      this.report.detail = code;
      this.m.log.log('warn', 'snapshot.failed', { did: this.did, code });
    }
    return this.outcome(r);
  }

  /** Close a job that no longer belongs to the account's current life. */
  closeSuperseded(): SnapshotOutcome {
    return this.outcome(
      this.write(`state = 'complete', failure_code = ?, frontier_json = NULL, head_cid = NULL`, [SUPERSEDED], () => {
        clearBlockCache(this.db, this.did);
        incrementCounter(this.db, SNAPSHOT_SUPERSEDED_COUNTER, '');
        return 'superseded' as const;
      }),
    );
  }

  /** The account is not active: hide it (new generation) and close the job. */
  closeInactive(status: InactiveStatus): SnapshotOutcome {
    const r = this.write(
      `state = 'complete', failure_code = ?, frontier_json = NULL, head_cid = NULL`,
      [INACTIVE],
      () => {
        markInactive(this.db, this.did, status);
        clearBlockCache(this.db, this.did);
        return 'inactive' as const;
      },
    );
    if (r !== LOST) this.report.detail = status;
    return this.outcome(r);
  }

  // ---- identity and fetches ----------------------------------------------

  private async resolve(fresh: boolean): Promise<ResolvedIdentity> {
    const cached = !fresh && this.identity === null;
    if (fresh || cached) {
      const fromCache = !fresh && cachedIdentity(this.db, this.did, this.m.clock.nowMs()) !== null;
      if (!fromCache && !this.meter.tryReserve(IDENTITY_RESOLVE_COST)) throw new BudgetExhausted();
      const r = await resolveIdentity(this.m, this.did, fresh ? { fresh: true } : {});
      if (!r.ok) {
        if (r.kind === 'invalid') throw new IdentityFailed(r.code, r.retryAt);
        throw new IdentityFailed('transient', null);
      }
      this.identity = r.identity;
      this.identityFresh = fresh || !r.fromCache;
    }
    return this.identity!;
  }

  async pds(): Promise<string> {
    return (await this.resolve(false)).pds;
  }

  /**
   * Run `fn` against the resolved PDS. An account error from a PDS that a
   * cached identity named (a Repo* XRPC error, or a getRepoStatus body with
   * `active: false`, which is how a PDS answers for an account migrated away
   * and deactivated there) gets one fresh resolution; a changed PDS
   * (migration) is retried at once, anything else is AccountUnavailable.
   */
  async sync<T>(fn: (pds: string) => Promise<T>): Promise<T> {
    for (;;) {
      const pds = await this.pds();
      const paused = hostPausedUntil(this.db, hostOf(pds), this.now);
      if (paused !== null) throw new HostPaused(paused);
      try {
        return await fn(pds);
      } catch (e) {
        let status: InactiveStatus | undefined;
        if (e instanceof AccountUnavailable) status = e.status;
        else if (isSafeFetchError(e) && e.code === 'http_status') status = ACCOUNT_ERRORS[e.xrpcError ?? ''];
        if (status === undefined) throw e;
        if (!this.identityFresh) {
          const before = this.identity!;
          const after = await this.resolve(true);
          if (after.pds !== before.pds) continue;
        }
        throw new AccountUnavailable(status);
      }
    }
  }

  private async xrpcJson(pds: string, nsid: string): Promise<Record<string, unknown>> {
    const url = new URL(`/xrpc/${nsid}`, pds);
    url.searchParams.set('did', this.did);
    const { body } = await this.safeFetch(url, { kind: 'json' });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new BadResponse(`${nsid} returned invalid JSON`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadResponse(`${nsid} returned a non-object`);
    }
    return value as Record<string, unknown>;
  }

  /** getRepoStatus: true when active; throws AccountUnavailable otherwise. */
  async repoStatus(): Promise<void> {
    await this.sync(async (pds) => {
      const s = await this.xrpcJson(pds, NSID_STATUS);
      if (s.active === true) return;
      if (s.active !== false) throw new BadResponse('getRepoStatus without a boolean active');
      const status = typeof s.status === 'string' && INACTIVE_STATUSES.has(s.status) ? s.status : 'deactivated';
      throw new AccountUnavailable(status as InactiveStatus);
    });
  }

  private blockSource(pds: string): BlockSource {
    return getBlocksSource({ safeFetch: this.safeFetch, pds, did: this.did });
  }

  private async verify(blocks: ReadonlyMap<string, Uint8Array>, cid: string): Promise<VerifiedCommit> {
    let id = await this.resolve(false);
    try {
      return await verifyCommit(blocks, cid, { did: this.did, signingKey: id.signingKey });
    } catch (e) {
      if (!(e instanceof VerifyError) || (e.code !== 'bad_signature' && e.code !== 'key_unavailable')) throw e;
      if (this.identityFresh) throw e;
      const before = id.signingKey;
      id = await this.resolve(true);
      if (id.signingKey === before) throw e;
      return verifyCommit(blocks, cid, { did: this.did, signingKey: id.signingKey });
    }
  }

  /** getLatestCommit, then the commit through getBlocks (or the getRepo stream), verified. */
  async verifiedHead(preferred: BlockSourceKind): Promise<HeadResult> {
    if (preferred === 'getBlocks') {
      const latest = await this.sync((pds) => this.xrpcJson(pds, NSID_LATEST));
      const cid = latest.cid;
      if (typeof cid !== 'string' || typeof latest.rev !== 'string' || !isTid(latest.rev)) {
        throw new BadResponse('getLatestCommit without a cid and a TID rev');
      }
      try {
        const blocks = await this.sync((pds) => this.blockSource(pds).get([cid]));
        if (!blocks.has(cid)) throw new VerifyError('missing_block', `commit ${cid} is missing from getBlocks`);
        return { commit: await this.verify(blocks, cid), source: 'getBlocks' };
      } catch (e) {
        if (!isBlockSourceError(e, 'unsupported')) throw e;
        this.db.tx(() => incrementCounter(this.db, SNAPSHOT_FALLBACK_COUNTER, ''));
      }
    }
    // getRepo fallback: stream the whole repository into the cache; its root is the head.
    const streamed = await this.sync((pds) =>
      streamRepoIntoCache({ safeFetch: this.safeFetch, pds, did: this.did, cache: this.cache }),
    );
    const bytes = this.cache.get(streamed.root);
    if (bytes === null) throw new VerifyError('missing_block', `getRepo CAR lacks its root ${streamed.root}`);
    return { commit: await this.verify(new Map([[streamed.root, bytes]]), streamed.root), source: 'getRepo' };
  }

  /** Refuse a head below `users.max_rev` or the snapshot floor (stale PDS). */
  checkFloors(rev: string): void {
    const user = loadUser(this.db, this.did);
    const floor = this.db.one<{ head_rev: string | null }>(
      "SELECT head_rev FROM repo_jobs WHERE did = ? AND kind = 'snapshot'",
      this.did,
    );
    if ((user?.max_rev != null && rev < user.max_rev) || (floor?.head_rev != null && rev < floor.head_rev)) {
      throw new StaleHead(rev);
    }
  }

  /** Persist a new head and its fresh frontier (walk start or restart). */
  setHead(head: HeadResult): Frontier {
    this.checkFloors(head.commit.rev);
    const frontier: Frontier = {
      v: FRONTIER_VERSION,
      source: head.source,
      walk: initialState(head.commit, this.range),
      errors: 0,
    };
    const r = this.write(
      `head_cid = ?, head_rev = CASE WHEN head_rev IS NULL OR head_rev < ? THEN ? ELSE head_rev END, frontier_json = ?`,
      [head.commit.cid, head.commit.rev, head.commit.rev, JSON.stringify(frontier)],
      () => true,
    );
    if (r === LOST) throw new LeaseLost();
    this.frontier = frontier;
    this.report.source = head.source;
    return frontier;
  }

  async start(): Promise<Frontier> {
    await this.repoStatus();
    return this.setHead(await this.verifiedHead('getBlocks'));
  }

  /** missing_block: count the restart (or fail past the bound), then restart at the new head. */
  async restart(): Promise<Frontier | SnapshotOutcome> {
    const next = this.restarts + 1;
    if (next > MAX_SNAPSHOT_RESTARTS) {
      return this.fail(REPOSITORY_CHANGED, REPOSITORY_CHANGED_BACKOFF_MS, { restarts: next });
    }
    const r = this.write('restarts = ?', [next], () => incrementCounter(this.db, SNAPSHOT_RESTART_COUNTER, ''));
    if (r === LOST) return 'lost';
    this.restarts = next;
    this.report.restarts++;
    const preferred = this.frontier?.source ?? 'getBlocks';
    return this.setHead(await this.verifiedHead(preferred));
  }

  // ---- the walk -----------------------------------------------------------

  private knownCid = (key: string): string | null => storedCid(this.db, `at://${this.did}/${key}`);

  private include = (key: string): boolean => {
    const { collection } = splitKey(key);
    return collectionKind(this.prefix, collection) !== null;
  };

  /** Apply one step's chunk with the new frontier, under the lease. */
  private applyStep(r: StepResult, next: Frontier): SnapshotOutcome | 'ok' | 'retry' {
    const db = this.db;
    const entries: SnapshotChunkEntry[] = r.entries.map((e) =>
      e.recordBytes === undefined
        ? { key: e.key, cid: e.cid }
        : { key: e.key, cid: e.cid, record: recordValue(e.recordBytes) },
    );
    const nowNs = fromMs(this.now);
    const result = this.write(
      'frontier_json = ?',
      [JSON.stringify(next)],
      () => {
        // A body-less entry must still carry the stored CID (see the header, step 5).
        for (const e of entries) {
          if (e.record === undefined && storedCid(db, recordUri(this.did, ...keyParts(e.key))) !== e.cid) {
            throw new RetryChunk();
          }
        }
        if (r.interval === null) return 'ok' as const;
        const chunk = applySnapshotChunk(db, {
          did: this.did,
          generation: this.generation,
          headRev: next.walk.headRev,
          intervalLo: r.interval[0],
          intervalHi: r.interval[1] ?? this.range[1],
          entries,
          receiptNs: nowNs,
          prefix: this.prefix,
          nowNs,
        });
        if (chunk.outcome === 'suppressed') return 'suppressed' as const;
        if (chunk.outcome === 'superseded' || chunk.outcome === 'stale') {
          db.run(
            `UPDATE repo_jobs SET state = 'complete', failure_code = ?, frontier_json = NULL, head_cid = NULL
           WHERE did = ? AND kind = 'snapshot'`,
            SUPERSEDED,
            this.did,
          );
          clearBlockCache(db, this.did);
          incrementCounter(db, SNAPSHOT_SUPERSEDED_COUNTER, chunk.outcome);
          return 'superseded' as const;
        }
        this.report.chunks++;
        this.report.entries += entries.length;
        this.report.written += chunk.written;
        this.report.deleted += chunk.deleted;
        return 'ok' as const;
      },
      true,
    );
    if (result === LOST) return 'lost';
    if (result === RETRY) return 'retry';
    if (result === 'ok') this.frontier = next;
    return result;
  }

  async walk(): Promise<SnapshotOutcome> {
    for (;;) {
      const frontier = this.frontier!;
      if (frontier.walk.stack.length === 0) return this.complete();
      if (this.entriesLeft <= 0) return this.pause(this.now);
      const local = frontier.source === 'getRepo';
      const maxFetches = local ? LOCAL_FETCHES : Math.floor(this.meter.remaining / SNAPSHOT_FETCH_COST);
      if (maxFetches < 1) return this.pause(this.now);
      const opts = { maxFetches, maxEntries: this.entriesLeft, knownCid: this.knownCid, include: this.include };
      // After a getRepo stream the walk is local (no subrequests, no PDS); otherwise
      // every batch is a getBlocks request to the PDS the identity names now.
      const r = local
        ? await step(frontier.walk, cacheOnlySource(this.cache), this.cache, opts)
        : await this.sync((pds) => step(frontier.walk, this.blockSource(pds), this.cache, opts));
      this.entriesLeft -= r.entries.length;
      const next: Frontier = { ...frontier, walk: r.state, errors: 0 };
      const applied = this.applyStep(r, next);
      if (applied === 'retry') return this.pause(this.now);
      if (applied !== 'ok') return applied;
      if (!r.done && r.fetches === 0 && r.interval === null) return this.pause(this.now);
    }
  }

  /** The walk covered the range: status check, then completeSnapshot under the lease. */
  async complete(): Promise<SnapshotOutcome> {
    const frontier = this.frontier!;
    let active = true;
    try {
      await this.repoStatus();
    } catch (e) {
      if (!(e instanceof AccountUnavailable)) throw e;
      active = false;
    }
    const db = this.db;
    const pds = this.identity?.pds ?? null;
    const r = this.write('', [], (): SnapshotOutcome => {
      const job = db.one<{ attempts: number; reason: string | null }>(
        "SELECT attempts, reason FROM repo_jobs WHERE did = ? AND kind = 'snapshot'",
        this.did,
      )!;
      const done = completeSnapshot(db, {
        did: this.did,
        generation: this.generation,
        headRev: frontier.walk.headRev,
        accountActive: active,
        nowNs: fromMs(this.now),
      });
      if (done.outcome === 'superseded') {
        db.run(
          `UPDATE repo_jobs SET state = 'complete', failure_code = ?, frontier_json = NULL, head_cid = NULL
           WHERE did = ? AND kind = 'snapshot'`,
          SUPERSEDED,
          this.did,
        );
        clearBlockCache(db, this.did);
        incrementCounter(db, SNAPSHOT_SUPERSEDED_COUNTER, 'completion');
        return 'superseded';
      }
      if (done.outcome === 'complete') {
        if (pds !== null) db.run('UPDATE users SET pds = ? WHERE did = ?', pds, this.did);
        if (!active) scheduleStatusCheck(db, this.did, 'snapshot_inactive', this.now);
      }
      if (done.outcome === 'stale' || job.attempts > 0) {
        // A request arrived during the walk (or a newer head owns the floor):
        // re-walk the newest head, incrementally (the cache is kept).
        db.run(
          `UPDATE repo_jobs SET state = 'pending', frontier_json = NULL, head_cid = NULL, restarts = 0,
             failure_code = NULL, due_at = ? WHERE did = ? AND kind = 'snapshot'`,
          this.now,
          this.did,
        );
        incrementCounter(db, SNAPSHOT_RESCAN_STARTED_COUNTER, job.reason ?? '');
        return 'rescan';
      }
      db.run(
        `UPDATE repo_jobs SET state = 'complete', frontier_json = NULL, head_cid = NULL, failure_code = NULL
         WHERE did = ? AND kind = 'snapshot'`,
        this.did,
      );
      clearBlockCache(db, this.did);
      incrementCounter(db, SNAPSHOT_COMPLETED_COUNTER, job.reason ?? '');
      return 'complete';
    });
    if (r !== LOST) this.m.log.log('info', 'snapshot.finished', { did: this.did, outcome: r, active });
    return this.outcome(r);
  }

  // ---- the slice ----------------------------------------------------------

  async run(): Promise<SnapshotOutcome> {
    const gen = checkGeneration(this.db, this.did, this.generation);
    if (gen !== 'current') return this.closeSuperseded();
    if (this.frontier !== null) this.report.source = this.frontier.source;
    for (;;) {
      try {
        if (this.frontier === null) await this.start();
        return await this.walk();
      } catch (e) {
        if (!isMissingBlock(e)) return this.handle(e);
      }
      // missing_block: restart at the new head; a new head that is itself not
      // servable counts as the next restart, up to the bound.
      for (;;) {
        try {
          const r = await this.restart();
          if (typeof r === 'string') return r;
          break;
        } catch (e) {
          if (!isMissingBlock(e)) return this.handle(e);
        }
      }
    }
  }

  handle(e: unknown): SnapshotOutcome {
    if (e instanceof LeaseLost) return 'lost';
    if (e instanceof BudgetExhausted) return this.pause(this.now);
    if (e instanceof HostPaused) return this.pause(e.until);
    if (e instanceof AccountUnavailable) return this.closeInactive(e.status);
    if (e instanceof StaleHead) return this.fail('stale_head', SNAPSHOT_FAILURE_BACKOFF_MS);
    if (e instanceof IdentityFailed) {
      const backoff = e.retryAt !== null && e.retryAt > this.now ? e.retryAt - this.now : TRANSIENT_PAUSE_BASE_MS;
      if (e.code === 'transient') return this.transient(this.frontier, `identity:${e.code}`, backoff);
      return this.fail(`identity:${e.code}`, Math.max(backoff, SNAPSHOT_FAILURE_BACKOFF_MS));
    }
    if (e instanceof VerifyError) {
      const dropCache = e.code === 'cid_mismatch' || e.code === 'mst_invalid';
      return this.fail(e.code, SNAPSHOT_FAILURE_BACKOFF_MS, { clearCache: dropCache });
    }
    if (e instanceof BadResponse) return this.fail('bad_response', SNAPSHOT_FAILURE_BACKOFF_MS);
    if (isSafeFetchError(e)) return this.fetchFailed(e);
    this.m.log.log('error', 'snapshot.error', { did: this.did, error: String(e) });
    return this.fail('internal', SNAPSHOT_FAILURE_BACKOFF_MS);
  }

  private fetchFailed(e: SafeFetchError): SnapshotOutcome {
    const code = e.status === null ? `fetch:${e.code}` : `fetch:http_${e.status}`;
    const pause = pauseFor(e);
    if (pause === null) return this.fail(code, SNAPSHOT_FAILURE_BACKOFF_MS);
    let until = this.now + pause;
    const pds = this.identity?.pds;
    if (pds !== undefined) {
      until = this.db.tx(() => pauseHost(this.db, hostOf(pds), this.now, pause));
    }
    return this.transient(this.frontier, code, until - this.now);
  }

  /** A transient failure: pause with the frontier (backing off), or fail after too many in a row. */
  private transient(frontier: Frontier | null, code: string, minPauseMs: number): SnapshotOutcome {
    if (frontier === null) return this.fail(code, Math.max(minPauseMs, TRANSIENT_PAUSE_BASE_MS));
    const errors = frontier.errors + 1;
    if (errors > MAX_TRANSIENT_ERRORS) return this.fail('pds_unavailable', SNAPSHOT_FAILURE_BACKOFF_MS);
    this.report.detail = code;
    return this.pause(this.now + Math.max(minPauseMs, transientPauseMs(errors)), { ...frontier, errors });
  }
}

// ---------------------------------------------------------------------------
// The step

function emptyReport(): SnapshotStepReport {
  return {
    did: null,
    outcome: 'idle',
    chunks: 0,
    entries: 0,
    written: 0,
    deleted: 0,
    fetches: 0,
    subrequests: 0,
    restarts: 0,
    source: null,
    gap: null,
    gapCleared: false,
  };
}

/**
 * One snapshot slice (see the header). `budget` defaults to the configured
 * plan's slice budget (`PLAN=free`: 40 subrequests; Paid: 200), with at most
 * `maxEntriesPerSlice` entries applied.
 */
export async function snapshotStep(
  m: ModuleDeps,
  now: number,
  budget: SliceBudget = m.config.budget,
): Promise<SnapshotStepReport> {
  assertEpochMs('now', now);
  const report = emptyReport();
  const prefix = m.config.prefix;
  if (prefix === null) return report; // namespace gate closed: nothing is ingested
  const db = m.db;

  reclaimSnapshotLeases(db, now);
  report.gap = continueGapRecovery(db, now);
  const job = claimSnapshotJob(db, now);
  if (job !== null) {
    report.did = job.did;
    const slice = new Slice(m, prefix, now, budget, job, report);
    try {
      report.outcome = await slice.run();
    } catch (error) {
      if (error instanceof LeaseLost) {
        report.outcome = 'lost';
      } else {
        m.log.log('error', 'snapshot.slice_error', { did: job.did, error: String(error) });
        report.outcome = slice.fail('internal', SNAPSHOT_FAILURE_BACKOFF_MS);
      }
    }
    report.subrequests = slice.meter.reserved;
  }
  report.gapCleared = maybeClearGap(db);
  db.tx(() => scheduleSnapshotTimer(db, now));
  return report;
}

/**
 * Point the `snapshot` timer at the next due job (no sooner than
 * SNAPSHOT_MIN_INTERVAL_MS from now), or at the next gap-scan batch while the
 * scan can make progress; cancel it when there is neither. A scan blocked by
 * a full queue (MAX_PENDING_SNAPSHOT_JOBS pending or failed jobs: its next
 * batch would be `busy`) waits for the next due job like no scan at all, since
 * only a slice that claims or closes a job frees a slot; the DO does not wake
 * every SNAPSHOT_MIN_INTERVAL_MS through a backoff or host pause to do nothing.
 * The job table is the source of truth, so this replaces whatever was stored.
 */
export function scheduleSnapshotTimer(db: Db, now: number): number | null {
  const next =
    db.one<{ next: number | null }>(
      `SELECT min(due_at) AS next FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','failed')`,
    )?.next ?? null;
  const scanCanProgress = gapScanActive(db) && pendingSnapshotJobs(db) < MAX_PENDING_SNAPSHOT_JOBS;
  if (next === null && !scanCanProgress) {
    cancel(db, 'snapshot');
    return null;
  }
  const soonest = now + SNAPSHOT_MIN_INTERVAL_MS;
  const due = scanCanProgress || next === null ? soonest : Math.max(next, soonest);
  return schedule(db, 'snapshot', due, { force: true });
}

// ---------------------------------------------------------------------------
// Gap recovery

export interface GapScanOptions {
  /** Known DIDs examined per batch (default GAP_SCAN_BATCH). */
  batch?: number;
  /** The pending snapshot-job cap (default MAX_PENDING_SNAPSHOT_JOBS, 1,024). */
  pendingCap?: number;
}

export interface GapScanReport {
  /** Jobs created (or restarted) with `reason = GAP_REASON`. */
  scheduled: number;
  /** DIDs whose open job absorbed the request (pulled forward or one rescan). */
  already: number;
  /** The pending-job cap stopped this batch; the scan resumes after `after`. */
  busy: boolean;
  /** The scan has passed the last known DID. */
  done: boolean;
  /** The stored `gap_scan_after_did`. */
  after: string | null;
}

interface GapCheckpoint {
  pending_gap: number;
  gap_scan_after_did: string | null;
}

function readGap(db: Db): GapCheckpoint | null {
  return db.one<GapCheckpoint>(
    'SELECT pending_gap, gap_scan_after_did FROM ingest_checkpoint WHERE stream = ?',
    JETSTREAM_STREAM,
  );
}

function gapScanActive(db: Db): boolean {
  const cp = readGap(db);
  return (
    cp !== null && cp.pending_gap === 1 && cp.gap_scan_after_did !== null && cp.gap_scan_after_did !== GAP_SCAN_DONE
  );
}

/** Known DIDs a gap can have missed events for: indexed or being indexed, not known inactive. */
const KNOWN_ACTIVE = `account_status IN ('active','unknown') AND NOT EXISTS (SELECT 1 FROM suppression x WHERE x.did = users.did)`;

function scanBatch(db: Db, now: number, after: string | null, o: GapScanOptions): GapScanReport {
  // `after` is GAP_SCAN_START ('') or the last DID handled; every DID sorts after ''.
  const batch = o.batch ?? GAP_SCAN_BATCH;
  if (!Number.isSafeInteger(batch) || batch < 1) throw new RangeError('gap scan batch must be a positive integer');
  const pendingCap = o.pendingCap ?? MAX_PENDING_SNAPSHOT_JOBS;
  const dids = db
    .all<{ did: string }>(
      `SELECT did FROM users WHERE did > ? AND ${KNOWN_ACTIVE} ORDER BY did LIMIT ?`,
      after ?? '',
      batch,
    )
    .map((r) => r.did);
  const report: GapScanReport = { scheduled: 0, already: 0, busy: false, done: false, after };
  let last = after;
  for (const did of dids) {
    const s: ScheduleResult = scheduleSnapshot(db, did, GAP_REASON, now, { pendingCap });
    if (s.status === 'busy') {
      report.busy = true;
      break;
    }
    if (s.status === 'scheduled') report.scheduled++;
    else if (s.status === 'already') report.already++;
    if (s.status === 'scheduled' || s.status === 'already') {
      // The open job now carries this gap's work, whether it was created here or
      // absorbed the request (a walk in progress re-walks the newest head at its
      // completion; a failed or unstarted one walks fresh): it becomes gap work,
      // so maybeClearGap and indexing() wait for it. `reason` is not part of the
      // slice lease, so a slice in flight keeps its job.
      db.run(
        `UPDATE repo_jobs SET reason = ? WHERE did = ? AND kind = 'snapshot' AND state IN ('pending','running','failed')`,
        GAP_REASON,
        did,
      );
    }
    last = did;
  }
  report.done = !report.busy && dids.length < batch;
  report.after = report.done ? GAP_SCAN_DONE : last;
  updateCheckpointBookkeeping(db, { gapScanAfterDid: report.after });
  return report;
}

/**
 * A gap was detected (W4-02: no cursor, a cursor older than the lookback, or
 * a rejected cursor): `pending_gap = 1`, the scan restarts at the first known
 * DID, and its first batch is scheduled. One transaction.
 */
export function scheduleGapRecovery(db: Db, now: number, o: GapScanOptions = {}): GapScanReport {
  assertEpochMs('now', now);
  return db.tx((): GapScanReport => {
    updateCheckpointBookkeeping(db, { pendingGap: true, gapScanAfterDid: GAP_SCAN_START });
    incrementCounter(db, GAP_RECOVERY_COUNTER, '');
    return scanBatch(db, now, GAP_SCAN_START, o);
  });
}

/** The next batch of a gap scan in progress; null when no scan is in progress. */
export function continueGapRecovery(db: Db, now: number, o: GapScanOptions = {}): GapScanReport | null {
  assertEpochMs('now', now);
  return db.tx((): GapScanReport | null => {
    const cp = readGap(db);
    if (!gapScanActive(db) || cp === null) return null;
    return scanBatch(db, now, cp.gap_scan_after_did, o);
  });
}

/**
 * Clear `pending_gap` once the gap scan has finished and no gap-sourced
 * snapshot job (`reason = GAP_REASON`) is still open. Returns whether it cleared.
 */
export function maybeClearGap(db: Db): boolean {
  return db.tx((): boolean => {
    const cp = readGap(db);
    if (cp === null || cp.pending_gap !== 1 || cp.gap_scan_after_did !== GAP_SCAN_DONE) return false;
    const open = db.one<{ e: number }>(
      `SELECT EXISTS(SELECT 1 FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','running','failed')
         AND reason = ?) AS e`,
      GAP_REASON,
    );
    if (open?.e === 1) return false;
    updateCheckpointBookkeeping(db, { pendingGap: false, gapScanAfterDid: null });
    return true;
  });
}
