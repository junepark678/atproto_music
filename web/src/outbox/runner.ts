// The outbox runner (ADR 0004 §5.2 steps 3–5, §9 A12): one runner per DID,
// elected with `navigator.locks.request('atmusic-outbox:' + did)`, with the
// clock, randomness and scheduler injected.
//
// Write phase (state queued/running):
// - An operation runs only when it is due and every predecessor is settled
//   (published, indexed or failed), so a delete waits for the create of the
//   same URI and follow intents for one subject run FIFO.
// - The attempt is persisted (`running`, attempts + 1) before the request is
//   sent. Transient failures retry after write-policy `nextDelayMs`; there are
//   exactly MAX_ATTEMPTS (10) sends and never an eleventh.
// - A row left `running` by a crashed or closed tab is resumed with the same
//   rkey and payload; the per-kind executors make that safe (ambiguous create →
//   getRecord + digest; delete → InvalidSwap/absent reconcile). A row that
//   crashed during its tenth attempt gets a read-only reconcile, no send.
//
// Track phase (state published): send notify, then poll records/status with a
// backoff of 1 s doubling up to 60 s, until the AppView reports indexed (or
// absent for a delete), excluded, or the poll budget runs out.
//
// Ports crates/server/src/workers/outbox.rs (`run_due`) and
// crates/atproto/src/pds/write.rs. The SPA trusts its own PDS for the owner's
// view; public visibility still waits for the AppView's signed proof.

import type { AtUri, Did, NotifyAccepted, NotifyInput, RecordStatus } from '@atmusic/core/api-types';
import type { Clock, Random } from '@atmusic/core/deps';
import { type Collections, collectionsFor } from '@atmusic/core/namespace';
import {
  type Classification,
  classify,
  classifyResponse,
  MAX_ATTEMPTS,
  nextDelayMs,
  type WriteOperation,
} from '@atmusic/core/write-policy';
import { ApiError } from '../api/client';
import type { PdsSession } from '../oauth/types';
import { scrobbleDeleteExecutor } from './delete-ops';
import { followCreateExecutor, followDeleteExecutor } from './follow-ops';
import { scrobbleCreateExecutor } from './scrobble-ops';
import { settingsDeleteExecutor, settingsPutExecutor } from './settings-ops';
import { isSettled, isUnsent, type OperationKind, type OutboxOperation, type OutboxStore } from './store';

// ---------------------------------------------------------------------------
// Injected interfaces
// ---------------------------------------------------------------------------

/** The two AppView routes the outbox uses; `ApiClient` (web/src/api/client.ts) implements both. */
export interface AppViewApi {
  notify(input: NotifyInput): Promise<NotifyAccepted>;
  recordStatus(uri: AtUri): Promise<RecordStatus>;
}

/** Waits `ms` (Infinity = until aborted). Must resolve, not reject, when `signal` aborts. */
export interface Scheduler {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** The part of the Web Locks API the runner uses (`navigator.locks`). */
export interface OutboxLocks {
  request(
    name: string,
    options: { mode: 'exclusive'; signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void>;
}

const MAX_TIMER_MS = 2 ** 31 - 1;

export const timerScheduler: Scheduler = {
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(ms)) {
        timer = setTimeout(
          () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
          Math.min(MAX_TIMER_MS, Math.max(0, ms)),
        );
      }
    });
  },
};

/** `navigator.locks`, adapted; throws when the browser has no Web Locks (never run unelected). */
export function webLocks(): OutboxLocks {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks === undefined || typeof locks.request !== 'function') {
    throw new Error('the outbox needs the Web Locks API (navigator.locks) to elect one runner per DID');
  }
  return {
    request: (name, options, callback) => locks.request(name, options, () => callback()),
  };
}

export function outboxLockName(did: Did): string {
  return `atmusic-outbox:${did}`;
}

// ---------------------------------------------------------------------------
// PDS access through the session
// ---------------------------------------------------------------------------

/** What an attempt (or a reconcile) concluded. `patch` fields are persisted with the new state. */
export type Outcome =
  | { kind: 'published'; patch?: Partial<OutboxOperation> }
  | { kind: 'transient'; code: string; retryAfterMs?: number; patch?: Partial<OutboxOperation> }
  | { kind: 'permanent'; code: string; patch?: Partial<OutboxOperation> };

export type RecordLookup =
  | { kind: 'present'; uri: string; cid: string; value: unknown }
  | { kind: 'absent' }
  | { kind: 'failed'; outcome: Outcome };

export interface ListedRecord {
  uri: string;
  cid: string;
  value: unknown;
}

export type XrpcResult = { ok: true; status: number; body: unknown } | { ok: false; failure: Classification };

const MAX_SUCCESS_BODY_BYTES = 1024 * 1024;

/** XRPC over `PdsSession.fetchHandler`; every failure is classified with write-policy. */
export class PdsXrpc {
  constructor(
    private readonly session: PdsSession,
    private readonly clock: Clock,
  ) {}

  get did(): Did {
    return this.session.did;
  }

  /** POST a procedure. `operation` decides whether "already exists" is ambiguous. */
  procedure(nsid: string, body: Record<string, unknown>, operation: WriteOperation): Promise<XrpcResult> {
    return this.send(
      `/xrpc/${nsid}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      },
      operation,
    );
  }

  query(nsid: string, params: Record<string, string>): Promise<XrpcResult> {
    const search = new URLSearchParams(params).toString();
    return this.send(`/xrpc/${nsid}?${search}`, { method: 'GET', headers: { accept: 'application/json' } }, 'put');
  }

  private async send(path: string, init: RequestInit, operation: WriteOperation): Promise<XrpcResult> {
    let response: Response;
    try {
      response = await this.session.fetchHandler(path, init);
    } catch (error) {
      return { ok: false, failure: classify(error, { operation, clock: this.clock }) };
    }
    if (response.status < 200 || response.status > 299) {
      return { ok: false, failure: await classifyResponse(response, { operation, clock: this.clock }) };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { ok: false, failure: { kind: 'transient', code: 'upstream_transport_error' } };
    }
    if (text.length > MAX_SUCCESS_BODY_BYTES) {
      return { ok: false, failure: { kind: 'transient', code: 'upstream_transport_error' } };
    }
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { ok: true, status: response.status, body };
  }

  /** `com.atproto.repo.getRecord` on the owner's own PDS (authoritative for the owner's view). */
  async getRecord(collection: string, rkey: string): Promise<RecordLookup> {
    const result = await this.query('com.atproto.repo.getRecord', { repo: this.did, collection, rkey });
    if (!result.ok) {
      if (result.failure.kind === 'missing') return { kind: 'absent' };
      return { kind: 'failed', outcome: failureOutcome(result.failure) };
    }
    const body = result.body as { uri?: unknown; cid?: unknown; value?: unknown } | null;
    const expected = `at://${this.did}/${collection}/${rkey}`;
    if (body === null || typeof body !== 'object' || typeof body.cid !== 'string') {
      return { kind: 'failed', outcome: { kind: 'transient', code: 'invalid_pds_response' } };
    }
    if (body.uri !== expected) {
      return { kind: 'failed', outcome: { kind: 'permanent', code: 'remote_record_identity_mismatch' } };
    }
    return { kind: 'present', uri: expected, cid: body.cid, value: body.value };
  }

  /** Every record of one collection in the owner's repo (`listRecords`, 100 per page, bounded). */
  async listAll(
    collection: string,
    maxPages = 100,
  ): Promise<{ ok: true; records: ListedRecord[] } | { ok: false; outcome: Outcome }> {
    const records: ListedRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = { repo: this.did, collection, limit: '100' };
      if (cursor !== undefined) params.cursor = cursor;
      const result = await this.query('com.atproto.repo.listRecords', params);
      if (!result.ok) return { ok: false, outcome: failureOutcome(result.failure) };
      const body = result.body as { records?: unknown; cursor?: unknown } | null;
      if (body === null || typeof body !== 'object' || !Array.isArray(body.records)) {
        return { ok: false, outcome: { kind: 'transient', code: 'invalid_pds_response' } };
      }
      for (const item of body.records as unknown[]) {
        const r = item as { uri?: unknown; cid?: unknown; value?: unknown } | null;
        if (r === null || typeof r !== 'object' || typeof r.uri !== 'string' || typeof r.cid !== 'string') {
          return { ok: false, outcome: { kind: 'transient', code: 'invalid_pds_response' } };
        }
        records.push({ uri: r.uri, cid: r.cid, value: r.value });
      }
      if (typeof body.cursor !== 'string' || body.cursor === '' || body.records.length === 0) {
        return { ok: true, records };
      }
      cursor = body.cursor;
    }
    return { ok: false, outcome: { kind: 'permanent', code: 'too_many_records' } };
  }
}

/** A classified failure as an attempt outcome (`ambiguous_create`/`missing` must be handled by the caller first). */
export function failureOutcome(failure: Classification): Outcome {
  if (failure.kind === 'transient') {
    return failure.retryAfterMs !== undefined
      ? { kind: 'transient', code: failure.code, retryAfterMs: failure.retryAfterMs }
      : { kind: 'transient', code: failure.code };
  }
  if (failure.kind === 'permanent') return { kind: 'permanent', code: failure.code };
  // ambiguous_create / missing reaching here means the caller could not decide.
  return { kind: 'transient', code: 'remote_write_unconfirmed' };
}

// ---------------------------------------------------------------------------
// Executors (one per operation kind, in the *-ops.ts modules)
// ---------------------------------------------------------------------------

export interface ExecContext {
  pds: PdsXrpc;
  api: AppViewApi;
  clock: Clock;
  prefix: string;
  collections: Collections;
  /** True when this attempt resumes a row a crashed runner left `running`. */
  resumed: boolean;
  /**
   * Persists fields of the running row before a send (e.g. the delete's
   * `swapCid`), so a crash after this point resumes with them.
   */
  persist(patch: Partial<OutboxOperation>): Promise<void>;
}

/** How the track phase reads the AppView's answers. */
export type TrackVerdict =
  | { kind: 'indexed' }
  | { kind: 'excluded'; reason: string }
  /** Stop polling; the operation stays `published` (e.g. the DID is suppressed). */
  | { kind: 'stop' }
  | { kind: 'continue' };

export interface Executor {
  /** One attempt: the PDS write and any reconcile it needs. */
  execute(op: OutboxOperation, ctx: ExecContext): Promise<Outcome>;
  /** Read-only check for a row whose tenth attempt was interrupted; never sends a write. */
  reconcile(op: OutboxOperation, ctx: ExecContext): Promise<Outcome>;
  /** URIs whose records/status tracks the publication (empty: nothing to track). */
  trackUris(op: OutboxOperation): AtUri[];
  /** `statuses[i]` answers `trackUris(op)[i]`; null when that poll failed. */
  verdict(op: OutboxOperation, statuses: readonly (RecordStatus | null)[]): TrackVerdict;
}

// A function, not a module-level table: the *-ops modules import helpers from
// this module, so nothing here may touch their bindings at evaluation time.
function executorFor(kind: OperationKind): Executor {
  switch (kind) {
    case 'scrobble_create':
      return scrobbleCreateExecutor;
    case 'scrobble_delete':
      return scrobbleDeleteExecutor;
    case 'follow_create':
      return followCreateExecutor;
    case 'follow_delete':
      return followDeleteExecutor;
    case 'settings_put':
      return settingsPutExecutor;
    case 'settings_delete':
      return settingsDeleteExecutor;
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** records/status polls after notify: 1 s, then doubling, at most 60 s apart. */
export const MAX_POLL_DELAY_MS = 60_000;
/** Poll budget (about 25 minutes); afterwards the row stays `published` and polling stops. */
export const MAX_POLLS = 30;

export function pollDelayMs(pollsDone: number): number {
  return Math.min(MAX_POLL_DELAY_MS, 1_000 * 2 ** Math.min(pollsDone, 16));
}

export interface RunnerDeps {
  store: OutboxStore;
  session: PdsSession;
  api: AppViewApi;
  clock: Clock;
  random: Random;
  /** The deployment's lexicon prefix (meta.lexiconPrefix); rows outside its collections are refused. */
  prefix: string;
  scheduler?: Scheduler;
  /** Defaults to `webLocks()` when `start()` is called. */
  locks?: OutboxLocks;
  /** Called after every persisted change (UI refresh). */
  onChange?: (op: OutboxOperation) => void;
  /** Unexpected errors in the background loop. */
  onError?: (error: unknown) => void;
}

/** Upper bound on steps in one `runDue` pass, so a bug can never spin forever. */
const MAX_STEPS_PER_PASS = 1_000;
const ERROR_BACKOFF_MS = 5_000;

export class OutboxRunner {
  readonly did: Did;
  private readonly collections: Collections;
  private readonly pds: PdsXrpc;
  private loop: Promise<void> | null = null;
  private stopCtl: AbortController | null = null;
  private wakeCtl: AbortController | null = null;
  private wakePending = false;

  constructor(private readonly deps: RunnerDeps) {
    this.did = deps.session.did;
    this.collections = collectionsFor(deps.prefix);
    this.pds = new PdsXrpc(deps.session, deps.clock);
  }

  /**
   * Runs every operation that is due now, in FIFO order, until none is left;
   * returns the earliest future due time (null: nothing scheduled). Production
   * code calls it only from `start()`, under the per-DID Web Lock.
   */
  async runDue(): Promise<number | null> {
    // Rows whose step could not start in this pass (a lost race) are not retried in it.
    const skipped = new Set<string>();
    for (let step = 0; step < MAX_STEPS_PER_PASS; step++) {
      const ops = await this.deps.store.list(this.did);
      const now = this.deps.clock.nowMs();
      const byId = new Map(ops.map((op) => [op.id, op]));
      const ready = (op: OutboxOperation) =>
        op.dueAt !== null && (op.state === 'published' || (isUnsent(op.state) && this.predecessorsSettled(op, byId)));
      const next = ops.find((op) => !skipped.has(op.id) && ready(op) && (op.dueAt as number) <= now);
      if (next === undefined) {
        let earliest: number | null = null;
        for (const op of ops) {
          if (!ready(op)) continue;
          // A skipped row is looked at again after a back-off, never in a hot loop.
          const due = skipped.has(op.id) ? Math.max(op.dueAt as number, now + ERROR_BACKOFF_MS) : (op.dueAt as number);
          if (earliest === null || due < earliest) earliest = due;
        }
        return earliest;
      }
      if (next.state === 'published') await this.track(next, ops, now);
      else if (!(await this.write(next, now))) skipped.add(next.id);
    }
    return this.deps.clock.nowMs();
  }

  private predecessorsSettled(op: OutboxOperation, byId: Map<string, OutboxOperation>): boolean {
    return op.predecessorIds.every((id) => {
      const p = byId.get(id);
      return p === undefined || isSettled(p.state);
    });
  }

  private context(id: string, resumed: boolean): ExecContext {
    return {
      pds: this.pds,
      api: this.deps.api,
      clock: this.deps.clock,
      prefix: this.deps.prefix,
      collections: this.collections,
      resumed,
      persist: async (patch) => {
        const updated = await this.deps.store.update(id, (row) => {
          if (row.state !== 'running') return null;
          Object.assign(row, patch);
          row.updatedAt = this.deps.clock.nowMs();
          return row;
        });
        this.changed(updated);
      },
    };
  }

  private changed(op: OutboxOperation | null): void {
    if (op !== null) this.deps.onChange?.(op);
  }

  /** One write step; false when the attempt could not start. */
  private async write(op: OutboxOperation, now: number): Promise<boolean> {
    const executor = executorFor(op.kind);
    const resumed = op.state === 'running';
    if (op.attempts >= MAX_ATTEMPTS) {
      // Only a crash during the tenth attempt leaves this: that send may or may
      // not have reached the PDS, so look, and never send an eleventh.
      const outcome = await this.safely(() => executor.reconcile(op, this.context(op.id, true)));
      await this.finish(op.id, executor, outcome.kind === 'published' ? outcome : this.exhausted(outcome, op), now);
      return true;
    }
    const started = await this.deps.store.beginAttempt(op.id, now);
    if (started === null) return false;
    this.changed(started);
    const outcome = await this.safely(() => executor.execute(started, this.context(op.id, resumed)));
    await this.finish(op.id, executor, outcome, this.deps.clock.nowMs());
    return true;
  }

  private exhausted(outcome: Outcome, op: OutboxOperation): Outcome {
    if (outcome.kind === 'permanent') return outcome;
    return { kind: 'permanent', code: op.lastError ?? 'attempts_exhausted' };
  }

  private async safely(run: () => Promise<Outcome>): Promise<Outcome> {
    try {
      return await run();
    } catch (error) {
      this.deps.onError?.(error);
      return { kind: 'permanent', code: 'outbox_internal_error' };
    }
  }

  private async finish(id: string, executor: Executor, outcome: Outcome, now: number): Promise<void> {
    const updated = await this.deps.store.update(id, (op) => {
      Object.assign(op, outcome.patch ?? {});
      op.updatedAt = now;
      switch (outcome.kind) {
        case 'published':
          op.state = 'published';
          delete op.failureCode;
          delete op.lastError;
          op.notified = false;
          op.polls = 0;
          if (executor.trackUris(op).length === 0) {
            op.state = 'indexed';
            op.dueAt = null;
          } else {
            op.dueAt = now;
          }
          return op;
        case 'transient':
          op.lastError = outcome.code;
          if (op.attempts >= MAX_ATTEMPTS) {
            op.state = 'failed';
            op.failureCode = outcome.code;
            op.dueAt = null;
          } else {
            op.state = 'queued';
            op.dueAt = now + nextDelayMs(op.attempts, this.deps.random, outcome.retryAfterMs);
          }
          return op;
        case 'permanent':
          op.state = 'failed';
          op.failureCode = outcome.code;
          op.dueAt = null;
          return op;
      }
    });
    this.changed(updated);
  }

  private async track(op: OutboxOperation, ops: readonly OutboxOperation[], now: number): Promise<void> {
    const executor = executorFor(op.kind);
    const uris = executor.trackUris(op);
    // A newer, not-failed operation on the same URI (a delete after a create, a
    // follow after an unfollow) decides what the AppView will show; this one's
    // expectation can no longer come true, so it stops tracking (stays published).
    const superseded = ops.some(
      (later) =>
        later.seq > op.seq &&
        later.state !== 'failed' &&
        uris.some((uri) => later.uri === uri || later.targets?.some((t) => t.uri === uri)),
    );
    if (superseded) {
      const updated = await this.deps.store.update(op.id, (row) => {
        if (row.state !== 'published') return null;
        row.dueAt = null;
        row.updatedAt = now;
        return row;
      });
      this.changed(updated);
      return;
    }
    // notify is retried at every step until accepted (429/503/network are transient).
    const notified = op.notified || (await this.notifyAll(uris));
    if (op.polls === 0) {
      // First step after publication: the hint is out; give the AppView a second.
      const updated = await this.deps.store.update(op.id, (row) => {
        if (row.state !== 'published') return null;
        row.notified = notified;
        row.polls = 1;
        row.dueAt = now + pollDelayMs(0);
        row.updatedAt = now;
        return row;
      });
      this.changed(updated);
      return;
    }
    const statuses: (RecordStatus | null)[] = [];
    for (const uri of uris) {
      try {
        statuses.push(await this.deps.api.recordStatus(uri));
      } catch {
        statuses.push(null);
      }
    }
    const verdict = executor.verdict(op, statuses);
    const after = this.deps.clock.nowMs();
    const updated = await this.deps.store.update(op.id, (row) => {
      if (row.state !== 'published') return null;
      row.notified = notified;
      row.updatedAt = after;
      switch (verdict.kind) {
        case 'indexed':
          row.state = 'indexed';
          row.dueAt = null;
          break;
        case 'excluded':
          row.state = 'failed';
          row.failureCode = 'record_excluded';
          row.reason = verdict.reason;
          row.dueAt = null;
          break;
        case 'stop':
          row.dueAt = null;
          break;
        case 'continue':
          row.dueAt = row.polls >= MAX_POLLS ? null : after + pollDelayMs(row.polls);
          break;
      }
      row.polls += 1;
      return row;
    });
    this.changed(updated);
  }

  /** notify `{uri}` for each URI. A rejected hint (400/413/422) is not retried; 429/503/network are. */
  private async notifyAll(uris: readonly AtUri[]): Promise<boolean> {
    let all = true;
    for (const uri of uris) {
      try {
        await this.deps.api.notify({ uri });
      } catch (error) {
        const retryable = !(error instanceof ApiError) || error.status === 429 || error.status >= 500;
        if (retryable) all = false;
      }
    }
    return all;
  }

  // ---- background loop ----------------------------------------------------

  /**
   * Elects this tab as the DID's runner (waiting while another tab holds the
   * lock), then runs due work and sleeps until the next due time or `wake()`.
   * Resolves after `stop()`.
   */
  start(): Promise<void> {
    if (this.loop !== null) return this.loop;
    const stopCtl = new AbortController();
    this.stopCtl = stopCtl;
    const locks = this.deps.locks ?? webLocks();
    const scheduler = this.deps.scheduler ?? timerScheduler;
    this.loop = locks
      .request(outboxLockName(this.did), { mode: 'exclusive', signal: stopCtl.signal }, async () => {
        while (!stopCtl.signal.aborted) {
          let next: number | null;
          try {
            next = await this.runDue();
          } catch (error) {
            this.deps.onError?.(error);
            next = this.deps.clock.nowMs() + ERROR_BACKOFF_MS;
          }
          if (stopCtl.signal.aborted) break;
          if (this.wakePending) {
            this.wakePending = false;
            continue;
          }
          const wait = next === null ? Number.POSITIVE_INFINITY : Math.max(0, next - this.deps.clock.nowMs());
          if (wait === 0) continue;
          const wakeCtl = new AbortController();
          this.wakeCtl = wakeCtl;
          await scheduler.sleep(wait, wakeCtl.signal);
          this.wakeCtl = null;
          this.wakePending = false;
        }
      })
      .catch((error: unknown) => {
        if (stopCtl.signal.aborted) return;
        throw error;
      })
      .finally(() => {
        this.loop = null;
      });
    return this.loop;
  }

  /** New work was enqueued (or the network came back): run now instead of sleeping. */
  wake(): void {
    this.wakePending = true;
    this.wakeCtl?.abort();
  }

  /** Stops the loop and releases the lock; a running attempt finishes first. */
  async stop(): Promise<void> {
    this.stopCtl?.abort();
    this.wakeCtl?.abort();
    await this.loop?.catch(() => undefined);
  }
}

export function createOutboxRunner(deps: RunnerDeps): OutboxRunner {
  return new OutboxRunner(deps);
}
