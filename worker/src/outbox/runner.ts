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
import { chargePoints, checkBudget, observeRateLimit, WRITE_COST } from './budget';
import { scrobbleDeleteExecutor } from './delete-ops';
import { followDeleteExecutor, followPutExecutor } from './follow-ops';
import { loveDeleteExecutor, lovePutExecutor } from './love-ops';
import {
  accountNeedsSignIn,
  beginAttempts,
  beginReconcile,
  blockOperations,
  MAX_ATTEMPTS,
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
  private readonly dids = new Map<string, DidState>();
  private readonly collections: OutboxCollections;

  constructor(
    private readonly m: OutboxDeps,
    private readonly now: number,
    prefix: string,
  ) {
    this.collections = outboxCollections(prefix);
  }

  get db(): Db {
    return this.m.db;
  }

  async run(): Promise<OutboxRunReport> {
    const priorities = this.db
      .all<{ priority: number }>(
        `SELECT DISTINCT o.priority FROM operations o WHERE ${DUE} AND o.due_at <= ? ORDER BY o.priority`,
        this.now,
      )
      .map((r) => r.priority);
    lanes: for (const priority of priorities) {
      const dids = this.db.all<{ did: string }>(
        `SELECT o.did, min(o.due_at) AS d FROM operations o
         WHERE ${DUE} AND o.priority = ? AND o.due_at <= ? AND ${READY}
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
      `SELECT DISTINCT o.did, o.priority FROM operations o WHERE ${DUE} AND o.due_at <= ? AND ${READY}`,
      now,
    );
    if (pending.some((p) => !this.parked.has(`${p.did}|${p.priority}`) && !this.parked.has(`${p.did}|*`))) return now;
    const row = this.db.one<{ next: number | null }>(
      `SELECT min(o.due_at) AS next FROM operations o WHERE ${DUE} AND o.due_at > ? AND ${READY}`,
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
      `SELECT o.* FROM operations o WHERE o.did = ? AND o.priority = ? AND ${DUE} AND o.due_at <= ? AND ${READY}
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
    const batchable = ops.filter((o) => o.kind === 'scrobble.create' && o.attempts < MAX_ATTEMPTS);
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
        const budget = checkBudget(this.db, state.did, priority, estimatedCost(op.kind), this.now);
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
    const executor = executorFor(op.kind);
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
    db.tx(() => {
      const hints: HintTarget[] = [];
      for (const [op, outcome] of results) {
        finish(this.m, op, outcome, now, begun);
        if (outcome.kind === 'succeeded') hints.push(...outcome.hints);
        if (outcome.kind === 'deferred') {
          // A smaller request may still fit (the next run sizes its batch by what is left);
          // otherwise the DID and priority wait for the binding window.
          if (checkBudget(db, state.did, op.priority, estimatedCost(op.kind), now).ok) this.deferred = true;
          else this.park(state.did, op.priority, outcome.untilMs);
        }
        if (outcome.kind === 'reauth') reauth = true;
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
  }
}

/** Persists one outcome on a running operation (synchronous; inside the caller's tx). */
function finish(m: ModuleDeps, op: OperationRow, outcome: Outcome, now: number, begun: boolean): void {
  const db = m.db;
  switch (outcome.kind) {
    case 'succeeded':
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
        `UPDATE operations SET state = 'blocked', attempts = attempts - ?, last_error = 'reauth_required',
           updated_at_ms = ? WHERE id = ? AND state = 'running'`,
        begun ? 1 : 0,
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
  if (prefix === null) return { attempted: 0, batches: [], blocked: 0, nextDueMs: null, skipped: false };
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
