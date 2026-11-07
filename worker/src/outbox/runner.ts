// The server outbox runner (ADR 0005 §5.8, §3.3 `outbox` timer; ADR 0004
// §5.2 steps 3–5; N2-05). Ports web/src/outbox/runner.ts and
// crates/server/src/workers/outbox.rs `run_due` to the server: the clock, the
// randomness, the database and the PDS writers are injected.
//
// One run (`runOutbox`):
// - Takes the due operations (state queued, or running when a previous
//   process died mid-attempt, `due_at <= now`) whose predecessors are all
//   settled, live priority (0) before import priority (1), and within a
//   priority DID by DID in due order. So a due live operation always runs
//   before an earlier-due import operation. Nothing is ever sent before its
//   `due_at`.
// - Per DID: a DID whose account needs a new sign-in, or that has no usable
//   OAuth session, has its operations set to `blocked` — no attempt is
//   counted — until `resumeAfterSignIn` queues them again.
// - Per DID and priority, the point budget (budget.ts) decides how much may
//   be sent; what does not fit waits for the binding window to end, without
//   spending an attempt. Every write request an attempt sends is checked
//   (`ExecContext.afford`), bisection halves, singles and each delete of an
//   unfollow included, so the ledger is never overspent; an attempt the
//   budget stops is `deferred` (queued again, attempt not counted).
// - Several due creates of a DID go as one applyWrites batch (apply-writes.ts,
//   at most one batch per DID per run); everything else runs singly, at most
//   MAX_SINGLES_PER_RUN per run.
// - The attempt is persisted (`running`, attempts + 1) before the request is
//   sent. Transient failures retry after write-policy `nextDelayMs`
//   (min(300 s, base + U[0, base/4]) with base 1, 2, 4 … s, raised by a capped
//   Retry-After); there are exactly MAX_ATTEMPTS (10) sends and never an
//   eleventh. A row left `running` by a crashed process is resumed with the
//   same rkey and payload, and a row whose tenth attempt was interrupted gets
//   a read-only reconcile, never a send. That row is marked `running` for the
//   reconcile (`beginReconcile`, attempts unchanged) whether a crash left it
//   running or it was blocked and queued again after sign-in, so its outcome
//   is always persisted.
// - Within one DID, live work is never overtaken: a DID whose due, ready live
//   operations are not all done in its live lane (more than one applyWrites
//   batch holds, the per-DID bound, a budget deferral or park) does not run
//   its import lane in that run; the import lane waits with it.
// - After each success the record's hint is queued with `enqueueHints`
//   (source `notify`) in the same transaction as the success, so the verify
//   drain indexes it once proven. It does not go through the client notify
//   RPC and its abuse buckets. A DID without a `users` row is admitted
//   (`admit(…, 'notify', …)`) instead and its snapshot indexes the record. A
//   settings record is hinted either way (the drain verifies an opt-out even
//   for an unknown DID). Indexing stays proof-gated.
// - Returns when it should run next: now when due work is left that the run
//   did not park (its per-run bounds, or successors whose predecessors just
//   settled), else the earliest future due time, budget window end or writer
//   retry.
//
// Every transaction is synchronous and opens after the awaited request, so no
// transaction spans an await. Runs over one Db never overlap (a second call
// while one is in flight returns at once, `skipped`); the `outbox` extension
// timer (outboxExtension) serializes them in production.

import { nextDelayMs } from '@atmusic/core/write-policy';
import type { CoreExtension } from '../app/host';
import type { OperationKind, OperationRow } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import type { Db } from '../do/db';
import { admit } from '../do/ingest/admission';
import { enqueueHints, type HintInput } from '../do/ingest/hints';
import { loadUser } from '../do/write/account-state';
import { MAX_BATCH_WRITES, planBatch, sendCreateBatch } from './apply-writes';
import { batchDeleteExecutor } from './batch-delete-ops';
import { batchCreateExecutor } from './batch-ops';
import { chargePoints, checkBudget, observeRateLimit, WRITE_COST } from './budget';
import { scrobbleDeleteExecutor } from './delete-ops';
import { followDeleteExecutor, followPutExecutor } from './follow-ops';
import { loveDeleteExecutor, lovePutExecutor } from './love-ops';
import {
  accountNeedsSignIn,
  beginAttempts,
  beginReconcile,
  blockOperations,
  IMPORT_PRIORITY,
  insertOperation,
  MAX_ATTEMPTS,
  newOperationId,
  type OutboxCollections,
  outboxCollections,
  persistRunning,
  unblockOperations,
} from './operations';
import { type HintTarget, type Outcome, type PdsWriterSource, PdsXrpc } from './pds-writer';
import { scrobbleCreateExecutor } from './scrobble-ops';
import { settingsPutExecutor } from './settings-ops';

// ---------------------------------------------------------------------------
// Executors

export interface ExecContext {
  readonly m: ModuleDeps;
  readonly xrpc: PdsXrpc;
  readonly collections: OutboxCollections;
  /** Persists fields of the running row before a send, so a crash after this point resumes with them. */
  persist(patch: { swapCid?: string }): void;
  /**
   * Checks the point budget before a write request of `points`: null when it
   * may be sent now, else the `deferred` outcome to return (nothing sent).
   */
  afford(points: number): Outcome | null;
  /**
   * Queues the hints of records this attempt has already written or deleted,
   * now, before its next request (an unfollow's or unlove's deletes): a
   * record deleted by an attempt that is cut short later is no longer listed
   * by the next attempt, so its hint cannot wait for the operation's success.
   */
  hint(targets: readonly HintTarget[]): void;
  /** A value shared by every attempt of this run, built by `build` on first use. */
  memo<T>(key: string, build: () => T): T;
}

export interface Executor {
  /** One attempt: the PDS write and any reconcile it needs. */
  execute(op: OperationRow, ctx: ExecContext): Promise<Outcome>;
  /** Read-only check for a row whose tenth attempt was interrupted; never sends a write. */
  reconcile(op: OperationRow, ctx: ExecContext): Promise<Outcome>;
}

// A function, not a module-level table: the *-ops modules import types from
// this module, so nothing here may touch their bindings at evaluation time.
function executorFor(kind: OperationKind): Executor {
  switch (kind) {
    case 'scrobble.create':
      return scrobbleCreateExecutor;
    case 'scrobble.delete':
      return scrobbleDeleteExecutor;
    case 'follow.put':
      return followPutExecutor;
    case 'follow.delete':
      return followDeleteExecutor;
    case 'settings.put':
      return settingsPutExecutor;
    case 'love.put':
      return lovePutExecutor;
    case 'love.delete':
      return loveDeleteExecutor;
  }
}

/** Points an operation's first write costs (the budget check before it starts). */
export function estimatedCost(kind: OperationKind): number {
  switch (kind) {
    case 'scrobble.create':
    case 'follow.put':
    case 'love.put':
      return WRITE_COST.create;
    case 'settings.put':
      return WRITE_COST.update;
    default:
      return WRITE_COST.delete;
  }
}

/** A targeted batch-listen removal normally rewrites the container (2 points). */
function estimatedOperationCost(db: Db, op: OperationRow): number {
  if (
    op.kind === 'scrobble.delete' &&
    db.one('SELECT 1 AS x FROM batch_delete_children WHERE parent_operation_id=? LIMIT 1', op.id) !== null
  )
    return 0;
  if (op.kind === 'scrobble.delete' && op.collection.endsWith('.scrobbleBatch')) {
    const ids = db.all<{ listen_id: string }>(
      'SELECT listen_id FROM batch_delete_listens WHERE operation_id = ?',
      op.id,
    );
    if (ids.length > 0 && !ids.some(({ listen_id }) => listen_id === '*')) return WRITE_COST.update;
  }
  return estimatedCost(op.kind);
}

// ---------------------------------------------------------------------------
// The run

export interface OutboxDeps extends ModuleDeps {
  writers: PdsWriterSource;
  /** Called after a run queued hints (the composition re-arms the core lane for the drain). */
  onHintsQueued?: () => void;
}

/** Single (non-batched) operations started per run (ADR §3.3: 32 operations, or 1 applyWrites batch per DID). */
export const MAX_SINGLES_PER_RUN = 32;
/** DIDs looked at per priority per run; more means another run right away. */
export const MAX_DIDS_PER_RUN = 200;
/** Due operations of one DID and priority looked at per run. */
export const MAX_OPS_PER_DID = 250;
/** A writer source that threw (not a sign-in problem) is asked again after this. */
export const WRITER_ERROR_BACKOFF_MS = 5_000;

export interface OutboxRunReport {
  /** Operations started (an attempt persisted) or reconciled in this run. */
  attempted: number;
  /** Sizes of the applyWrites batches started, in order. */
  batches: number[];
  /** Operations set to blocked. */
  blocked: number;
  /** When the outbox should run next; null when nothing is scheduled. */
  nextDueMs: number | null;
  /** True when another run on the same Db was in flight and this one did nothing. */
  skipped: boolean;
}

/** Ready: no predecessor still queued, running or blocked. */
const READY = `NOT EXISTS (SELECT 1 FROM operation_deps d JOIN operations p ON p.id = d.pred_id
  WHERE d.op_id = o.id AND p.state IN ('queued','running','blocked'))`;
const DUE = `o.state IN ('queued','running')`;

function hasGrantedBatchScope(scope: string | undefined, prefix: string | null): boolean {
  if (scope === undefined) return false;
  const scopes = new Set(scope.split(/\s+/).filter(Boolean));
  return scopes.has('transition:generic') || (prefix !== null && scopes.has(`repo:${prefix}.scrobbleBatch`));
}

const inFlight = new WeakSet<Db>();

type DidState =
  | { kind: 'blocked' }
  | { kind: 'error' }
  | { kind: 'ok'; did: string; xrpc: PdsXrpc; batched: boolean; blocked: boolean };

class Run {
  readonly report: OutboxRunReport = { attempted: 0, batches: [], blocked: 0, nextDueMs: null, skipped: false };
  private readonly waits: number[] = [];
  private readonly parked = new Set<string>();
  private deferred = false;
  private singles = 0;
  private hinted = false;
  private readonly memos = new Map<string, unknown>();
  private readonly dids = new Map<string, DidState>();
  private readonly collections: OutboxCollections;
  private readonly eligibility: string;

  constructor(
    private readonly m: OutboxDeps,
    private readonly now: number,
    prefix: string,
  ) {
    this.collections = outboxCollections(prefix);
    this.eligibility = ` AND NOT (
        (o.origin = 'import' AND o.kind = 'scrobble.create' AND o.collection = '${this.collections.scrobble}'
         AND o.send_state = 'unsent'
         AND EXISTS (SELECT 1 FROM import_items i WHERE i.operation_id = o.id AND i.state = 'queued'))
        ${m.config.batchPublication ? '' : `OR o.collection = '${this.collections.scrobbleBatch}'`})`;
  }

  get db(): Db {
    return this.m.db;
  }

  async run(): Promise<OutboxRunReport> {
    const priorities = this.db
      .all<{ priority: number }>(
        `SELECT DISTINCT o.priority FROM operations o WHERE ${DUE} AND o.due_at <= ?${this.eligibility} ORDER BY o.priority`,
        this.now,
      )
      .map((r) => r.priority);
    lanes: for (const priority of priorities) {
      const dids = this.db.all<{ did: string }>(
        `SELECT o.did, min(o.due_at) AS d FROM operations o
         WHERE ${DUE} AND o.priority = ? AND o.due_at <= ?${this.eligibility} AND ${READY}
         GROUP BY o.did ORDER BY d, o.did LIMIT ?`,
        priority,
        this.now,
        MAX_DIDS_PER_RUN + 1,
      );
      if (dids.length > MAX_DIDS_PER_RUN) this.deferred = true;
      for (const { did } of dids.slice(0, MAX_DIDS_PER_RUN)) {
        if (this.singles >= MAX_SINGLES_PER_RUN) {
          // The rest waits for the next run, lower priorities included: live work is never overtaken.
          this.deferred = true;
          break lanes;
        }
        if (this.earlierLaneLeft(did, priority)) {
          // Its live work is not done (batch overflow, per-DID bound, deferral or a budget park):
          // the import lane waits with it, parked so it adds no wake-up of its own.
          this.parked.add(`${did}|${priority}`);
          continue;
        }
        const state = await this.didState(did);
        if (state.kind === 'blocked') continue;
        if (state.kind === 'error') {
          this.park(did, null, this.now + WRITER_ERROR_BACKOFF_MS);
          continue;
        }
        await this.runDid(state, priority);
      }
    }
    if (this.hinted) this.m.onHintsQueued?.();
    this.report.nextDueMs = this.nextDue();
    return this.report;
  }

  /** True when `did` still has due, ready work at a more urgent priority than `priority`. */
  private earlierLaneLeft(did: string, priority: number): boolean {
    return (
      this.db.one<{ x: number }>(
        `SELECT 1 AS x FROM operations o WHERE o.did = ? AND o.priority < ? AND ${DUE} AND o.due_at <= ?${this.eligibility} AND ${READY}
         LIMIT 1`,
        did,
        priority,
        this.now,
      ) !== null
    );
  }

  /** `did` (at `priority`, or every priority) waits until `untilMs` (budget window, writer retry). */
  private park(did: string, priority: number | null, untilMs: number): void {
    this.parked.add(`${did}|${priority ?? '*'}`);
    this.waits.push(untilMs);
  }

  /**
   * Now, when due work is left that this run did not park (the per-run bounds,
   * or successors whose predecessors just settled); else the earliest future
   * due time, budget window end or writer retry.
   */
  private nextDue(): number | null {
    const now = this.m.clock.nowMs();
    if (this.deferred) return now;
    const pending = this.db.all<{ did: string; priority: number }>(
      `SELECT DISTINCT o.did, o.priority FROM operations o WHERE ${DUE} AND o.due_at <= ?${this.eligibility} AND ${READY}`,
      now,
    );
    if (pending.some((p) => !this.parked.has(`${p.did}|${p.priority}`) && !this.parked.has(`${p.did}|*`))) return now;
    const row = this.db.one<{ next: number | null }>(
      `SELECT min(o.due_at) AS next FROM operations o WHERE ${DUE} AND o.due_at > ?${this.eligibility} AND ${READY}`,
      now,
    );
    const candidates = [...this.waits];
    if (row?.next !== null && row?.next !== undefined) candidates.push(row.next);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  private block(did: string): DidState {
    this.report.blocked += this.db.tx(() => blockOperations(this.db, did, this.m.clock.nowMs()));
    const state: DidState = { kind: 'blocked' };
    this.dids.set(did, state);
    return state;
  }

  private async didState(did: string): Promise<DidState> {
    const known = this.dids.get(did);
    if (known !== undefined) return known;
    if (accountNeedsSignIn(this.db, did)) return this.block(did);
    let writer: Awaited<ReturnType<PdsWriterSource['writerFor']>>;
    try {
      writer = await this.m.writers.writerFor(did);
    } catch (error) {
      this.m.log.log('warn', 'outbox.writer_failed', { did, error: error instanceof Error ? error.name : 'unknown' });
      const state: DidState = { kind: 'error' };
      this.dids.set(did, state);
      return state;
    }
    if (writer === null) return this.block(did);
    if (writer.did !== did) {
      this.m.log.log('error', 'outbox.writer_mismatch', { did });
      const state: DidState = { kind: 'error' };
      this.dids.set(did, state);
      return state;
    }
    const db = this.db;
    const clock = this.m.clock;
    const xrpc = new PdsXrpc(writer, clock, {
      beforeWrite: (points) => chargePoints(db, did, points, clock.nowMs()),
      afterWrite: (response, retryAfterMs) => observeRateLimit(db, did, response, clock.nowMs(), retryAfterMs),
    });
    const state: DidState = { kind: 'ok', did, xrpc, batched: false, blocked: false };
    this.dids.set(did, state);
    return state;
  }

  private readyOps(did: string, priority: number): OperationRow[] {
    const ops = this.db.all<OperationRow>(
      `SELECT o.* FROM operations o WHERE o.did = ? AND o.priority = ? AND ${DUE} AND o.due_at <= ?${this.eligibility} AND ${READY}
       ORDER BY o.due_at, o.rowid LIMIT ?`,
      did,
      priority,
      this.now,
      MAX_OPS_PER_DID + 1,
    );
    if (ops.length > MAX_OPS_PER_DID) this.deferred = true;
    return ops.slice(0, MAX_OPS_PER_DID);
  }

  private async runDid(state: Extract<DidState, { kind: 'ok' }>, priority: number): Promise<void> {
    const ops = this.readyOps(state.did, priority);
    const handled = new Set<string>();
    const batchable = ops.filter(
      (o) => o.kind === 'scrobble.create' && o.collection === this.collections.scrobble && o.attempts < MAX_ATTEMPTS,
    );
    if (batchable.length >= 2) {
      if (state.batched) {
        // One applyWrites batch per DID per run: the rest go in the next run.
        this.deferred = true;
        for (const o of batchable) handled.add(o.id);
      } else {
        const budget = checkBudget(this.db, state.did, priority, 2 * WRITE_COST.create, this.now);
        const fits = Math.min(MAX_BATCH_WRITES, Math.floor(budget.available / WRITE_COST.create));
        if (fits >= 2) {
          const batch = planBatch(state.did, batchable.slice(0, fits));
          if (batch.length >= 2) {
            await this.runBatch(state, batch);
            state.batched = true;
            for (const o of batchable) handled.add(o.id);
            if (batch.length < batchable.length) this.deferred = true;
          }
        } else if (fits < 1 && !budget.ok) {
          this.park(state.did, priority, budget.resumeAtMs);
          return;
        }
      }
    }
    for (const op of ops) {
      if (handled.has(op.id)) continue;
      if (state.blocked) return;
      if (this.singles >= MAX_SINGLES_PER_RUN) {
        this.deferred = true;
        return;
      }
      if (op.attempts < MAX_ATTEMPTS) {
        const budget = checkBudget(this.db, state.did, priority, estimatedOperationCost(this.db, op), this.now);
        if (!budget.ok) {
          // FIFO within the DID and priority: everything after it waits too.
          this.park(state.did, priority, budget.resumeAtMs);
          return;
        }
      }
      await this.runSingle(state, op);
      this.singles += 1;
    }
  }

  private context(state: Extract<DidState, { kind: 'ok' }>, op: OperationRow): ExecContext {
    const db = this.db;
    const clock = this.m.clock;
    return {
      m: this.m,
      xrpc: state.xrpc,
      collections: this.collections,
      persist: (patch) => persistRunning(db, op.id, patch, clock.nowMs()),
      afford: (points) => {
        const budget = checkBudget(db, state.did, op.priority, points, clock.nowMs());
        return budget.ok ? null : { kind: 'deferred', untilMs: budget.resumeAtMs };
      },
      hint: (targets) => {
        if (targets.length === 0) return;
        if (db.tx(() => queueHints(this.m, state.did, targets, clock.nowMs(), this.collections))) this.hinted = true;
      },
      memo: <T>(key: string, build: () => T): T => {
        if (!this.memos.has(key)) this.memos.set(key, build());
        return this.memos.get(key) as T;
      },
    };
  }

  private async safely(run: () => Promise<Outcome>): Promise<Outcome> {
    try {
      return await run();
    } catch (error) {
      this.m.log.log('error', 'outbox.internal_error', { error: error instanceof Error ? error.name : 'unknown' });
      return { kind: 'permanent', code: 'outbox_internal_error' };
    }
  }

  private async runSingle(state: Extract<DidState, { kind: 'ok' }>, op: OperationRow): Promise<void> {
    if (
      op.kind === 'scrobble.delete' &&
      this.db.one('SELECT 1 AS x FROM batch_delete_children WHERE parent_operation_id = ? LIMIT 1', op.id) !== null
    ) {
      this.settleBatchDeleteAggregate(op);
      return;
    }
    if (op.collection === this.collections.scrobbleBatch && !this.m.config.batchPublication) return;
    const executor =
      op.kind === 'scrobble.create' && op.collection === this.collections.scrobbleBatch
        ? batchCreateExecutor
        : op.kind === 'scrobble.delete' && op.collection === this.collections.scrobbleBatch
          ? batchDeleteExecutor
          : executorFor(op.kind);
    if (
      op.collection === this.collections.scrobbleBatch &&
      !hasGrantedBatchScope(state.xrpc.scope, this.m.config.prefix)
    ) {
      this.report.blocked += this.db.run(
        "UPDATE operations SET state = 'blocked', last_error = 'batch_scope_required', updated_at_ms = ? WHERE did = ? AND collection = ? AND state IN ('queued','running')",
        this.m.clock.nowMs(),
        op.did,
        this.collections.scrobbleBatch,
      ).rowsWritten;
      return;
    }
    this.report.attempted += 1;
    if (op.attempts >= MAX_ATTEMPTS) {
      // Only an interrupted tenth attempt leaves this (a crash, possibly then
      // blocked and queued again): that send may or may not have reached the
      // PDS, so look, and never send an eleventh. The row is running for the
      // look, so its outcome is persisted whatever state it came from.
      const reconciling = beginReconcile(this.db, op.id, this.m.clock.nowMs());
      if (reconciling === null) return;
      const outcome = await this.safely(() => executor.reconcile(reconciling, this.context(state, reconciling)));
      const final: Outcome =
        outcome.kind === 'succeeded' || outcome.kind === 'permanent' || outcome.kind === 'reauth'
          ? outcome
          : { kind: 'permanent', code: reconciling.last_error ?? 'attempts_exhausted' };
      this.settle(state, [[reconciling, final]], false);
      return;
    }
    const [started] = beginAttempts(this.db, [op.id], this.m.clock.nowMs());
    if (started === undefined) return;
    const outcome = await this.safely(() => executor.execute(started, this.context(state, started)));
    this.settle(state, [[started, outcome]], true);
  }

  /** Settles a split-delete receipt after every durable child operation is terminal. */
  private settleBatchDeleteAggregate(parent: OperationRow): void {
    this.db.tx(() => {
      const children = this.db.all<{ state: string }>(
        `SELECT c.state FROM batch_delete_children r JOIN operations c ON c.id=r.child_operation_id
         WHERE r.parent_operation_id=?`,
        parent.id,
      );
      if (children.length === 0) {
        this.db.run(
          "UPDATE operations SET state='failed',last_error='batch_delete_children_missing',updated_at_ms=? WHERE id=? AND state IN ('queued','running')",
          this.m.clock.nowMs(),
          parent.id,
        );
        return;
      }
      if (children.some(({ state }) => state === 'queued' || state === 'running' || state === 'blocked')) return;
      const failed = children.some(({ state }) => state !== 'succeeded');
      this.db.run(
        `UPDATE operations SET state=?,last_error=?,result_uri=?,updated_at_ms=? WHERE id=? AND state IN ('queued','running')`,
        failed ? 'failed' : 'succeeded',
        failed ? 'batch_delete_child_failed' : null,
        failed || parent.rkey === null ? null : `at://${parent.did}/${parent.collection}/${parent.rkey}`,
        this.m.clock.nowMs(),
        parent.id,
      );
    });
  }

  private async runBatch(state: Extract<DidState, { kind: 'ok' }>, batch: OperationRow[]): Promise<void> {
    const started = beginAttempts(
      this.db,
      batch.map((o) => o.id),
      this.m.clock.nowMs(),
    );
    if (started.length === 0) return;
    this.report.attempted += started.length;
    this.report.batches.push(started.length);
    // A lone survivor still goes as createRecord (sendCreateBatch does that).
    let outcomes: Map<string, Outcome>;
    try {
      outcomes = await sendCreateBatch(this.context(state, started[0] as OperationRow), started, (op) =>
        this.safely(() => scrobbleCreateExecutor.execute(op, this.context(state, op))),
      );
    } catch (error) {
      this.m.log.log('error', 'outbox.internal_error', { error: error instanceof Error ? error.name : 'unknown' });
      outcomes = new Map(started.map((op) => [op.id, { kind: 'permanent', code: 'outbox_internal_error' }]));
    }
    this.settle(
      state,
      started.map((op): [OperationRow, Outcome] => [
        op,
        outcomes.get(op.id) ?? { kind: 'transient', code: 'remote_write_unconfirmed' },
      ]),
      true,
    );
  }

  /** Persists outcomes and their hints in one transaction. `begun`: an attempt was counted for them now. */
  private settle(state: Extract<DidState, { kind: 'ok' }>, results: [OperationRow, Outcome][], begun: boolean): void {
    const db = this.db;
    const now = this.m.clock.nowMs();
    let reauth = false;
    let batchScopeHold = false;
    db.tx(() => {
      const hints: HintTarget[] = [];
      for (const [op, outcome] of results) {
        if (
          op.collection === this.collections.scrobbleBatch &&
          outcome.kind === 'reauth' &&
          outcome.code === 'batch_scope_required'
        ) {
          batchScopeHold = true;
          this.report.blocked += db.run(
            "UPDATE operations SET state = 'blocked', last_error = 'batch_scope_required', updated_at_ms = ? WHERE did = ? AND collection = ? AND state IN ('queued','running')",
            now,
            op.did,
            this.collections.scrobbleBatch,
          ).rowsWritten;
        } else if (
          op.collection === this.collections.scrobbleBatch &&
          outcome.kind === 'permanent' &&
          (outcome.code === 'batch_schema_required' || outcome.remoteError === 'InvalidRequest')
        ) {
          db.run(
            "UPDATE operations SET state = 'blocked', last_error = 'batch_schema_required', updated_at_ms = ? WHERE id = ? AND state = 'running'",
            now,
            op.id,
          );
          this.report.blocked += db.run(
            "UPDATE operations SET state = 'blocked', last_error = 'batch_schema_required', updated_at_ms = ? WHERE did = ? AND collection = ? AND state = 'queued'",
            now,
            op.did,
            this.collections.scrobbleBatch,
          ).rowsWritten;
        } else if (outcome.kind === 'split') this.splitBatch(op, outcome.children, now);
        else finish(this.m, op, outcome, now, begun);
        if (outcome.kind === 'succeeded') hints.push(...outcome.hints);
        if (outcome.kind === 'deferred') {
          // A smaller request may still fit (the next run sizes its batch by what is left);
          // otherwise the DID and priority wait for the binding window.
          if (checkBudget(db, state.did, op.priority, estimatedOperationCost(db, op), now).ok) this.deferred = true;
          else this.park(state.did, op.priority, outcome.untilMs);
        }
        if (
          outcome.kind === 'reauth' &&
          !(op.collection === this.collections.scrobbleBatch && outcome.code === 'batch_scope_required')
        )
          reauth = true;
      }
      if (hints.length > 0 && queueHints(this.m, state.did, hints, now, this.collections)) this.hinted = true;
      if (reauth) {
        const own = results.filter(([, o]) => o.kind === 'reauth').length;
        this.report.blocked += own + blockOperations(db, state.did, now);
      }
    });
    if (reauth) {
      state.blocked = true;
      this.dids.set(state.did, { kind: 'blocked' });
    }
    if (batchScopeHold) state.blocked = false;
  }

  /** Replace a definitely rejected batch with durable child containers atomically. */
  private splitBatch(
    parent: OperationRow,
    children: Array<{ id: string; rkey: string; prepared: { record: object; digest: string }; entryIds: string[] }>,
    now: number,
  ): void {
    const db = this.db;
    const mapping = db.all<{
      entry_id: string;
      job_id: string;
      seq: number;
      removal_operation_id: string | null;
      removed_at_ms: number | null;
    }>(
      'SELECT entry_id, job_id, seq, removal_operation_id, removed_at_ms FROM batch_entry_items WHERE operation_id = ? ORDER BY job_id, seq',
      parent.id,
    );
    if (mapping.length === 0) throw new Error('batch split has no durable entry mapping');
    const assigned = new Set<string>();
    const parentUri = `at://${parent.did}/${parent.collection}/${parent.rkey}`;
    const parentDeletes =
      parent.collection === this.collections.scrobbleBatch
        ? db.all<OperationRow>(
            "SELECT * FROM operations WHERE did=? AND collection=? AND kind='scrobble.delete' AND rkey=? AND state IN ('queued','blocked')",
            parent.did,
            parent.collection,
            parent.rkey,
          )
        : [];
    const parentIntents = new Map<string, string[]>();
    for (const removal of parentDeletes) {
      parentIntents.set(
        removal.id,
        db
          .all<{ listen_id: string }>('SELECT listen_id FROM batch_delete_listens WHERE operation_id=?', removal.id)
          .map(({ listen_id }) => listen_id),
      );
    }
    for (const removal of parentDeletes)
      db.run('DELETE FROM operation_deps WHERE op_id=? AND pred_id=?', removal.id, parent.id);
    for (const child of children) {
      const rows = mapping.filter((row) => child.entryIds.includes(row.entry_id));
      if (rows.length === 0) throw new Error('batch split child has no mapped entries');
      for (const row of rows) assigned.add(`${row.job_id}\u0000${row.seq}`);
      const created = insertOperation(
        db,
        {
          id: child.id,
          did: parent.did,
          kind: parent.kind,
          origin: parent.origin,
          priority: IMPORT_PRIORITY,
          collection: parent.collection,
          rkey: child.rkey,
          prepared: child.prepared,
          dueAt: now,
          importJobId: parent.import_job_id,
        },
        now,
      );
      const childRemovalByParent = new Map<string, string>();
      for (const removal of parentDeletes) {
        const intents = parentIntents.get(removal.id) ?? [];
        const wildcard = intents.includes('*');
        const targeted = wildcard ? child.entryIds : child.entryIds.filter((entryId) => intents.includes(entryId));
        if (targeted.length === 0) continue;
        const childRemoval = insertOperation(
          db,
          {
            id: newOperationId(this.m.random),
            did: removal.did,
            kind: 'scrobble.delete',
            origin: removal.origin,
            priority: removal.priority,
            collection: removal.collection,
            rkey: child.rkey,
            dueAt: now,
            predecessors: [created.id],
          },
          now,
        );
        childRemovalByParent.set(removal.id, childRemoval.id);
        db.run(
          'INSERT INTO batch_delete_children(parent_operation_id,child_operation_id) VALUES (?,?)',
          removal.id,
          childRemoval.id,
        );
        for (const id of wildcard ? ['*'] : targeted) {
          db.run('INSERT INTO batch_delete_listens(operation_id,listen_id) VALUES (?,?)', childRemoval.id, id);
        }
        db.run('DELETE FROM batch_delete_listens WHERE operation_id=?', removal.id);
        db.run('INSERT OR IGNORE INTO operation_deps(op_id,pred_id) VALUES (?,?)', removal.id, childRemoval.id);
        if (wildcard) {
          db.run(
            'UPDATE listen_removals SET record_uri=?,operation_id=? WHERE operation_id=? AND record_uri=?',
            `at://${parent.did}/${parent.collection}/${child.rkey}`,
            childRemoval.id,
            removal.id,
            parentUri,
          );
        } else {
          for (const id of targeted) {
            db.run(
              'UPDATE listen_removals SET record_uri=?,operation_id=? WHERE operation_id=? AND record_uri=? AND listen_id=?',
              `at://${parent.did}/${parent.collection}/${child.rkey}`,
              childRemoval.id,
              removal.id,
              parentUri,
              id,
            );
          }
        }
      }
      for (const row of rows) {
        const item = db.run(
          "UPDATE import_items SET operation_id = ? WHERE job_id = ? AND seq = ? AND operation_id = ? AND state = 'queued'",
          created.id,
          row.job_id,
          row.seq,
          parent.id,
        );
        const key = db.run(
          'UPDATE listen_keys SET operation_id = ? WHERE operation_id = ? AND dedupe_key = (SELECT dedupe_key FROM import_items WHERE job_id = ? AND seq = ?)',
          created.id,
          parent.id,
          row.job_id,
          row.seq,
        );
        if (item.rowsWritten !== 1 || key.rowsWritten !== 1) throw new Error('batch split membership changed');
        const removalOperationId =
          (row.removal_operation_id !== null && childRemovalByParent.has(row.removal_operation_id)
            ? row.removal_operation_id
            : parentDeletes.find((candidate) => {
                const intents = parentIntents.get(candidate.id) ?? [];
                return intents.includes('*') || intents.includes(row.entry_id);
              })?.id) ?? null;
        const childRemovalId =
          removalOperationId === null ? null : (childRemovalByParent.get(removalOperationId) ?? null);
        db.run(
          `INSERT INTO batch_entry_items(operation_id, entry_id, job_id, seq, removal_operation_id, removed_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
          created.id,
          row.entry_id,
          row.job_id,
          row.seq,
          childRemovalId,
          row.removed_at_ms,
        );
        if (childRemovalId !== null)
          db.run(
            'UPDATE import_items SET removal_operation_id=? WHERE job_id=? AND seq=?',
            childRemovalId,
            row.job_id,
            row.seq,
          );
      }
    }
    if (assigned.size !== mapping.length) throw new Error('batch split did not account for every entry');
    db.run(
      "UPDATE operations SET state = 'cancelled', last_error = 'batch_split', updated_at_ms = ? WHERE id = ? AND state = 'running'",
      now,
      parent.id,
    );
    db.run('DELETE FROM batch_entry_items WHERE operation_id = ?', parent.id);
  }
}

/** Persists one outcome on a running operation (synchronous; inside the caller's tx). */
function finish(m: ModuleDeps, op: OperationRow, outcome: Outcome, now: number, begun: boolean): void {
  const db = m.db;
  switch (outcome.kind) {
    case 'succeeded':
      if (op.kind === 'scrobble.delete' && outcome.note === 'record_not_ours') {
        db.run('DELETE FROM listen_removals WHERE operation_id = ?', op.id);
        db.run('DELETE FROM batch_delete_listens WHERE operation_id = ?', op.id);
      }
      db.run(
        `UPDATE operations SET state = 'succeeded', result_uri = ?, result_cid = ?, swap_cid = coalesce(?, swap_cid),
           last_error = ?, updated_at_ms = ? WHERE id = ? AND state = 'running'`,
        outcome.uri ?? null,
        outcome.cid ?? null,
        outcome.swapCid ?? null,
        outcome.note ?? null,
        now,
        op.id,
      );
      // A confirmed scrobble removal no longer needs the listen payload in
      // succeeded create receipts. Keep identity, result CID, idempotency key
      // and request hash so retries still resolve to their original receipt
      // rather than republishing a deleted listen. Failed/unresolved deletes
      // never erase the payload needed for investigation/reconciliation.
      if (op.kind === 'scrobble.delete' && outcome.note !== 'record_not_ours') {
        const successfulCreates = db.all<{ id: string; record_json: string | null }>(
          `SELECT id, record_json FROM operations WHERE did = ? AND collection = ? AND rkey = ?
             AND kind = 'scrobble.create' AND state = 'succeeded'`,
          op.did,
          op.collection,
          op.rkey,
        );
        if (m.config.prefix !== null && op.collection === outboxCollections(m.config.prefix).scrobbleBatch) {
          const removed = new Set(
            db
              .all<{ listen_id: string }>('SELECT listen_id FROM batch_delete_listens WHERE operation_id = ?', op.id)
              .map((row) => row.listen_id),
          );
          for (const create of successfulCreates) {
            if (create.record_json === null) continue;
            try {
              const record = JSON.parse(create.record_json) as { listens?: { id?: unknown }[] };
              if (Array.isArray(record.listens)) {
                record.listens = removed.has('*') ? [] : record.listens.filter((item) => !removed.has(String(item.id)));
                db.run(
                  'UPDATE operations SET record_json = ?, digest = NULL WHERE id = ?',
                  JSON.stringify(record),
                  create.id,
                );
              }
            } catch {
              /* Leave an unparseable forensic payload untouched. */
            }
          }
        } else {
          db.run(
            `UPDATE operations SET record_json = NULL, digest = NULL
             WHERE did = ? AND collection = ? AND rkey = ? AND kind = 'scrobble.create' AND state = 'succeeded'`,
            op.did,
            op.collection,
            op.rkey,
          );
        }
        if (m.config.prefix !== null && op.collection === outboxCollections(m.config.prefix).scrobbleBatch) {
          db.run(
            `UPDATE listen_removals SET removed_cid = COALESCE(removed_cid, (SELECT cid FROM scrobbles s
            WHERE s.record_uri = listen_removals.record_uri AND s.listen_id = listen_removals.listen_id))
            WHERE operation_id = ?`,
            op.id,
          );
          db.run('UPDATE batch_entry_items SET removed_at_ms = ? WHERE removal_operation_id = ?', now, op.id);
          db.run(
            "UPDATE import_items SET removed_at_ms = ?, record_json = '{}' WHERE removal_operation_id = ?",
            now,
            op.id,
          );
          db.run(
            `DELETE FROM listen_keys WHERE did = ?
               AND operation_id IN (SELECT operation_id FROM batch_entry_items WHERE removal_operation_id = ?)
               AND dedupe_key IN (SELECT dedupe_key FROM import_items WHERE removal_operation_id = ?)`,
            op.did,
            op.id,
            op.id,
          );
        }
      }
      return;
    case 'transient':
      if (op.attempts >= MAX_ATTEMPTS) {
        db.run(
          `UPDATE operations SET state = 'failed', last_error = ?, swap_cid = coalesce(?, swap_cid), updated_at_ms = ?
           WHERE id = ? AND state = 'running'`,
          outcome.code,
          outcome.swapCid ?? null,
          now,
          op.id,
        );
      } else {
        db.run(
          `UPDATE operations SET state = 'queued', last_error = ?, swap_cid = coalesce(?, swap_cid), due_at = ?,
             updated_at_ms = ? WHERE id = ? AND state = 'running'`,
          outcome.code,
          outcome.swapCid ?? null,
          now + nextDelayMs(op.attempts, m.random, outcome.retryAfterMs),
          now,
          op.id,
        );
      }
      return;
    case 'permanent':
      db.run(
        `UPDATE operations SET state = 'failed', last_error = ?, updated_at_ms = ? WHERE id = ? AND state = 'running'`,
        outcome.code,
        now,
        op.id,
      );
      return;
    case 'deferred':
      // The budget stopped the attempt before anything of it was left unconfirmed:
      // queued again at its due time, the attempt not counted; the run parks the DID.
      db.run(
        `UPDATE operations SET state = 'queued', attempts = attempts - ?, updated_at_ms = ?
         WHERE id = ? AND state = 'running'`,
        begun ? 1 : 0,
        now,
        op.id,
      );
      return;
    case 'reauth':
      // Not failed, and the attempt does not count (ADR §5.8 Re-authentication).
      db.run(
        `UPDATE operations SET state = 'blocked', attempts = attempts - ?, last_error = ?,
           updated_at_ms = ? WHERE id = ? AND state = 'running'`,
        begun ? 1 : 0,
        outcome.code ?? 'reauth_required',
        now,
        op.id,
      );
      return;
  }
}

/**
 * Queues the hints of records the outbox wrote or deleted (source `notify`),
 * or admits a DID the index does not know yet. Returns true when hints were queued.
 */
export function queueHints(
  m: ModuleDeps,
  did: string,
  targets: readonly HintTarget[],
  now: number,
  collections: OutboxCollections,
): boolean {
  const db = m.db;
  const known = loadUser(db, did) !== null;
  const wanted = targets.filter((t) => known || t.collection === collections.settings);
  if (!known && wanted.length < targets.length) admit(db, did, 'notify', now);
  if (wanted.length === 0) return false;
  const seen = new Set<string>();
  const hints: HintInput[] = [];
  for (const t of wanted) {
    const key = `${t.collection}/${t.rkey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({ did, collection: t.collection, rkey: t.rkey, source: 'notify', receiptMs: now });
  }
  enqueueHints(db, hints);
  return true;
}

/** One outbox run at `now` (see the header). */
export async function runOutbox(m: OutboxDeps, now: number = m.clock.nowMs()): Promise<OutboxRunReport> {
  const prefix = m.config.prefix;
  if (inFlight.has(m.db)) return { attempted: 0, batches: [], blocked: 0, nextDueMs: null, skipped: true };
  // Namespace ownership is not schema publication approval. Keep already-queued
  // work dormant until both reviewed references open the explicit publication gate.
  if (prefix === null || !m.config.publication)
    return { attempted: 0, batches: [], blocked: 0, nextDueMs: null, skipped: true };
  inFlight.add(m.db);
  try {
    return await new Run(m, now, prefix).run();
  } finally {
    inFlight.delete(m.db);
  }
}

/**
 * After a new sign-in (`onSessionUpdated`, ADR §5.8): the DID's blocked
 * operations are queued again, with their attempts unchanged. Returns how many.
 */
export function resumeAfterSignIn(m: Pick<ModuleDeps, 'db' | 'clock'>, did: string, kick?: () => void): number {
  const n = m.db.tx(() => unblockOperations(m.db, did, m.clock.nowMs()));
  if (n > 0) kick?.();
  return n;
}

export interface OutboxExtensionOptions {
  writers: PdsWriterSource;
  onHintsQueued?: () => void;
}

/**
 * The `outbox` extension timer for IndexCore (composition, N4-01): each run
 * reschedules itself at `nextDueMs`; `start` makes it due at once, so work
 * left by a previous process resumes. Ingress and the enqueue functions kick
 * it through `ExtensionContext.kick('outbox')`.
 */
export function outboxExtension(options: OutboxExtensionOptions): CoreExtension {
  return {
    name: 'outbox',
    timers: {
      outbox: async (now, ctx) => {
        const report = await runOutbox(
          {
            ...ctx.deps,
            writers: options.writers,
            ...(options.onHintsQueued !== undefined ? { onHintsQueued: options.onHintsQueued } : {}),
          },
          now,
        );
        if (report.skipped) return;
        if (report.nextDueMs !== null) ctx.schedule('outbox', report.nextDueMs, { force: true });
      },
    },
    start(ctx, now) {
      ctx.schedule('outbox', now);
    },
  };
}
