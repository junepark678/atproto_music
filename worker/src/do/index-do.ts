// IndexDO: the one SQLite Durable Object (ADR 0004 §1.1, §4.4, §5.9).
//
// DO modules are plain functions `(m: ModuleDeps, args)`; this class is the
// only place that exposes them, as the RPC methods of IndexRpc
// (worker/src/do/contracts.ts) plus AdminRpc.adminResnapshot
// (worker/src/http/admin.ts).
//
// Constructor (inside `blockConcurrencyWhile`, so no request or alarm runs
// before it finishes):
//  1. `buildDeps(env, ctx)` (protected; the test seam of ADR §4.4: test entries
//     under worker/test/**/entry.ts subclass it). Production: the strict
//     `parseConfig(env)` (the fixture prefix is refused), systemClock,
//     cryptoRandom, the global `fetch` transport, the identity resolver over
//     identity_cache, the production Jetstream connector and the DO's own
//     alarm storage. A config that does not parse leaves the DO unable to
//     answer: every RPC rejects, so /health/ready is 503 and meta `scaffold`.
//  2. `migrate(ctx.storage)`. `too_new` storage (written by newer code) is
//     left untouched: ready() reports it and nothing else runs.
//  3. The previous instance's socket did not survive: `noteRestart` →
//     W2-05 `markDisconnected`, which writes only on the 1→0 transition, so a
//     restart never moves the disconnect instant the stale rule measures.
//  4. Snapshot and status jobs left `running` by the previous instance go back
//     to `pending` (their slices died with it).
//  5. The timers exist (sweeps, discovery, gc, the Jetstream watchdog due now
//     unless ingestion is off) and agree with the queues, and the alarm is
//     armed at `min(due_at)`.
//
// `alarm()` runs `runDue` (timers.ts) with one handler per timer, in the
// fixed priority order drain → snapshot → jetstream-watchdog → status-sweep →
// identity-sweep → discovery → gc, then reconciles the timers with the queues
// and re-arms the alarm. Alarms are at-least-once and every handler is
// idempotent (ADR §5.9).
//
// Timers written outside an alarm (a Jetstream hint, notify, an admin
// resnapshot) are reconciled at once and the alarm re-armed. The drain runs
// at most every 2 s, measured from the start of the previous drain, so a
// steady stream of hints is batched and can never starve it; the other queue
// timers are only ever pulled forward.
//
// RPC rejections (ADR §5.9 logging): workerd reports every rejected RPC
// promise in the DO's own log stream (Workers Logs) with the error's message
// and stack, outside the redacting Logger. So no raw error leaves an RPC
// method: NotReadyError, RangeError (argument validation) and ApiError keep
// their name and message but lose their stack and cause; anything else (a
// storage fault, a platform error, a module bug) is logged through deps.log by
// method and error name only and rejects as a bare
// `IndexError: index operation failed`. Callers map every rejection to a
// generic envelope anyway (worker/src/http/error.ts).
//
// Gap recovery (ADR §5.5): the socket's gap handler schedules the snapshot
// scan (W4-01 `scheduleGapRecovery`) and one discovery pass
// (`requestGapDiscovery`), and `pending_gap` is held until that discovery
// pass has finished too (discovery.ts: "W5-01 keeps pending_gap set until
// then"), through the W2-05 bookkeeping writer only.

import { DurableObject } from 'cloudflare:workers';
import { fetchTransport } from '@atmusic/atproto/transport';
import type { Did, Export, Indexing, NotifyInput, Profile, RecordStatus, Statistics } from '@atmusic/core/api-types';
import { cryptoRandom, systemClock } from '@atmusic/core/deps';
import { ApiError } from '@atmusic/core/errors';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { parseConfig } from '../config';
import type { Env } from '../env';
import type { AdminRpc, ResnapshotOutcome } from '../http/admin';
import type {
  AdminStatus,
  FeedQuery,
  FollowListQuery,
  FollowRow,
  HistoryQuery,
  IndexRpc,
  Logger,
  LogLevel,
  ModuleDeps,
  NotifyOutcome,
  PitrResult,
  ResolveOutcome,
  RowsResult,
  ScrobbleRow,
  StatsQuery,
} from './contracts';
import { type Db, doDb } from './db';
import { reclaimStatusLeases, scheduleStatusJobsTimer } from './ingest/accounts';
import { reclaimSnapshotLeases, scheduleSnapshot } from './ingest/admission';
import { clearBlockCache } from './ingest/block-cache';
import { noteRestart, readIngestCheckpoint } from './ingest/checkpoint';
import { pruneVerifiedCommits } from './ingest/commit-cache';
import { discover, ensureDiscoveryTimer, gapDiscoveryPending, requestGapDiscovery } from './ingest/discovery';
import { deleteHint, nextHintDue } from './ingest/hints';
import { cachedIdentityResolver, pruneIdentityCache } from './ingest/identity-cache';
import { type IngestDeps, jetstreamWatchdog, type PulseTimer } from './ingest/ingest-mode';
import { type ConnectJetstream, connectJetstream } from './ingest/jetstream-socket';
import { notify, recordStatus } from './ingest/notify';
import { clearExpiredHostPauses } from './ingest/pds-budget';
import {
  GAP_SCAN_DONE,
  maybeClearGap,
  SNAPSHOT_MIN_INTERVAL_MS,
  scheduleGapRecovery,
  snapshotStep,
} from './ingest/snapshot-job';
import { identitySweep, statusSweep } from './ingest/sweeps';
import { DRAIN_MIN_INTERVAL_MS, drain } from './ingest/verify-drain';
import { type MigrateResult, migrate } from './migrate';
import { exportUser } from './read/export';
import { feed } from './read/feed';
import { followers, following } from './read/follows';
import { history } from './read/history';
import { lookup } from './read/lookup';
import { profile, resolveHandle } from './read/profile';
import { stats } from './read/stats';
import { indexing, internalStatus, updateCheckpointBookkeeping } from './status';
import {
  type AlarmStorage,
  armAlarm,
  dueAt,
  type RunReport,
  runDue,
  schedule,
  TIMER_NAMES,
  type TimerHandlers,
  TimerReentryError,
} from './timers';
import { incrementCounter } from './write/keys';

/** The singleton's name: `INDEX.idFromName(INDEX_NAME)` (ADR §4.1). */
export const INDEX_NAME = 'index-v1';

/** gc cadence (ADR §5.9: daily). */
export const GC_INTERVAL_MS = 24 * 3_600_000;
/** gc: snapshot block caches of finished walks dropped per run. */
export const GC_BLOCK_DIDS_PER_RUN = 50;
/** gc: a hint still failing this long after its receipt is handed to a snapshot. */
export const HINT_ERROR_RETENTION_MS = 7 * 24 * 3_600_000;
/** gc: expired failing hints handled per run. */
export const GC_HINTS_PER_RUN = 200;
export const HINT_EXPIRED_REASON = 'hint_expired';
export const HINT_EXPIRED_COUNTER = 'hint_expired';
/** No new timer handler starts this long after the alarm began (the alarm wall limit is 15 min). */
export const ALARM_SLICE_MS = 5 * 60_000;
/** Durable Objects keep 30 days of point-in-time history (ADR A15). */
export const PITR_WINDOW_MS = 30 * 24 * 3_600_000;
/** The restart into a restored bookmark is deferred so the RPC answer leaves first. */
export const PITR_RESTART_DELAY_MS = 50;
export const ADMIN_RESNAPSHOT_REASON = 'admin';

/** Everything IndexDO's modules and its alarm need; built once per instance. */
export interface IndexDeps extends ModuleDeps {
  connectJetstream: ConnectJetstream;
  /** Measures the pulse's 20 s bound; default setTimeout. */
  pulseTimer?: PulseTimer;
  /** Where the alarm is armed (production: `ctx.storage`). One object per instance. */
  alarms: AlarmStorage;
}

// ---------------------------------------------------------------------------
// Logging (Workers Logs). Fields are structured; secrets never leave.

export interface LogSink {
  log(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

const MIN_SECRET_CHARS = 8;
const SENSITIVE_KEY = /authorization|cookie|token|secret|password|cursor_?key/i;
const BEARER_VALUE = /\b(Bearer)\s+[^\s",]+/gi;

/**
 * The production Logger: one JSON line per event to the console (Workers
 * Logs). `secrets` (CURSOR_KEY, ADMIN_TOKEN) are replaced wherever they
 * occur, as is any `Bearer <value>`, and a field whose key names a credential
 * is dropped to `[redacted]`. Callers still never pass record contents.
 */
export function createLogger(secrets: readonly (string | undefined)[], sink: LogSink = console): Logger {
  const needles = [
    ...new Set(secrets.filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_CHARS)),
  ]
    .flatMap((s) => [s, s.toLowerCase(), s.toUpperCase()])
    .sort((a, b) => b.length - a.length);
  const scrub = (text: string): string => {
    let out = text;
    for (const n of needles) out = out.split(n).join('[redacted]');
    return out.replace(BEARER_VALUE, '$1 [redacted]');
  };
  return {
    log(level: LogLevel, event: string, fields?: Record<string, unknown>) {
      const record: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields ?? {})) {
        record[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : value;
      }
      let line: string;
      try {
        line = JSON.stringify({ ...record, level, event }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      } catch {
        line = JSON.stringify({ level, event, unserialisable: true });
      }
      line = scrub(line);
      if (level === 'error') sink.error(line);
      else if (level === 'warn') sink.warn(line);
      else sink.log(line);
    },
  };
}

/** The Logger for `env`: redacts its CURSOR_KEY and ADMIN_TOKEN. */
export function envLogger(env: Pick<Env, 'CURSOR_KEY' | 'ADMIN_TOKEN'>, sink?: LogSink): Logger {
  return createLogger([env.CURSOR_KEY, env.ADMIN_TOKEN], sink);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// ---------------------------------------------------------------------------

export class NotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotReadyError';
  }
}

export const INDEX_ERROR_NAME = 'IndexError';
export const INDEX_ERROR_MESSAGE = 'index operation failed';

/** The only rejection an RPC method gives for an unexpected failure: no detail, no stack. */
export class IndexError extends Error {
  constructor() {
    super(INDEX_ERROR_MESSAGE);
    this.name = INDEX_ERROR_NAME;
  }
}

/**
 * `error` (freshly built by `rpcRejection`) with its stack reduced to
 * `name: message`, so no frame or file path crosses the RPC boundary.
 */
function bare<E extends Error>(error: E): E {
  Object.defineProperty(error, 'stack', {
    value: `${error.name}: ${error.message}`,
    configurable: true,
    writable: true,
  });
  return error;
}

/**
 * What an RPC method rejects with for `error` (see "RPC rejections" above):
 * always a new error, so neither the original stack nor a `cause` crosses.
 */
function rpcRejection(error: unknown, method: string, log: Logger | null): Error {
  if (error instanceof NotReadyError) return bare(new NotReadyError(error.message));
  if (error instanceof RangeError) return bare(new RangeError(error.message));
  if (error instanceof ApiError) return bare(new ApiError(error.code, error.message, error.fields, error.status));
  const fields = { method, error: errorName(error) };
  if (log !== null) log.log('error', 'index.rpc_failed', fields);
  else console.error(JSON.stringify({ level: 'error', event: 'index.rpc_failed', ...fields }));
  return bare(new IndexError());
}

/** Runs one RPC method body; any rejection is replaced by `rpcRejection`. */
async function guarded<T>(method: string, log: Logger | null, body: () => T | Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw rpcRejection(error, method, log);
  }
}

export interface GcReport {
  blockDids: number;
  blocks: number;
  verifiedCommits: number;
  identities: number;
  hostPauses: number;
  expiredHints: number;
}

export class IndexDO extends DurableObject<Env> implements IndexRpc, AdminRpc {
  /** Null when buildDeps failed (see `depsError`). */
  protected readonly deps: IndexDeps | null;
  private readonly depsError: unknown = null;
  private migration: MigrateResult | null = null;
  private migrationError: unknown = null;
  private readonly ingest: IngestDeps | null;
  /** The last alarm's runDue report (operator and test introspection only). */
  lastAlarm: RunReport | null = null;
  /** When this instance's last drain started (the 2 s drain floor). */
  private lastDrainMs: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    let deps: IndexDeps | null = null;
    try {
      deps = this.buildDeps(env, ctx);
    } catch (error) {
      this.depsError = error;
      // No config, so no logger: log without fields that could carry values.
      console.error(JSON.stringify({ level: 'error', event: 'index.config_invalid', error: errorName(error) }));
    }
    this.deps = deps;
    this.ingest =
      deps === null
        ? null
        : {
            connectJetstream: deps.connectJetstream,
            ...(deps.pulseTimer === undefined ? {} : { pulseTimer: deps.pulseTimer }),
            scheduleGapRecovery: (db, now) => {
              scheduleGapRecovery(db, now);
              requestGapDiscovery(db, now);
            },
            onTimersChanged: () => this.timersChanged(),
          };
    void ctx.blockConcurrencyWhile(async () => {
      try {
        this.migration = migrate(ctx.storage);
      } catch (error) {
        this.migrationError = error;
        deps?.log.log('error', 'index.migration_failed', { error: errorName(error) });
        return;
      }
      if (deps !== null && this.migration.status === 'ready') this.start(deps);
    });
  }

  /** Production dependencies (ADR §4.4). Test entries override this, and only this. */
  protected buildDeps(env: Env, ctx: DurableObjectState): IndexDeps {
    const config = parseConfig(env);
    const db = doDb(ctx.storage);
    const clock = systemClock;
    const transport = fetchTransport;
    return {
      db,
      clock,
      random: cryptoRandom,
      transport,
      identity: cachedIdentityResolver(db, { transport, clock }),
      config,
      log: envLogger(env),
      connectJetstream,
      alarms: ctx.storage,
    };
  }

  // -------------------------------------------------------------------------
  // Start-up, timers, alarm

  private start(deps: IndexDeps): void {
    const { db, clock } = deps;
    const now = clock.nowMs();
    noteRestart(db, now);
    reclaimSnapshotLeases(db, now, { all: true });
    reclaimStatusLeases(db, now, { all: true });
    this.ensureTimers(deps, now, { startup: true });
    armAlarm(deps.alarms, db);
  }

  /**
   * Every periodic timer exists, and the queue timers agree with the queues.
   * At start-up the Jetstream watchdog is made due now (reconnect, or the first
   * pulse; with ingestion `off` it runs once to close and record the mode);
   * later calls (cron) only recreate it when it is missing.
   */
  private ensureTimers(deps: IndexDeps, now: number, o: { startup?: boolean } = {}): void {
    const { db, config } = deps;
    db.tx(() => {
      for (const name of ['status-sweep', 'identity-sweep', 'gc'] as const) {
        if (dueAt(db, name) === null) schedule(db, name, now);
      }
      const watchdogWanted = config.ingestMode !== 'off' || readIngestCheckpoint(db).mode !== 'off';
      if (watchdogWanted && (o.startup === true || !timerRowExists(db, 'jetstream-watchdog'))) {
        schedule(db, 'jetstream-watchdog', now);
      }
    });
    ensureDiscoveryTimer(db, now);
    this.reconcileTimers(deps, now);
  }

  /**
   * Align the queue timers with their queues:
   * - `drain` at the next due hint, but no sooner than DRAIN_MIN_INTERVAL_MS
   *   after the last drain of this instance started (ADR §5.9: "at most every
   *   2 s"; the hint queue itself schedules a new hint due at once). The floor
   *   is anchored to that start, not to now, so a steady stream of hints
   *   batches into one drain per 2 s and can never postpone it;
   * - `snapshot` pulled forward to the next due job (never later: no `force`);
   * - `status-sweep` pulled forward to the next status job.
   */
  private reconcileTimers(deps: IndexDeps, now: number): void {
    const { db } = deps;
    db.tx(() => {
      const hint = nextHintDue(db);
      if (hint !== null) {
        const target = this.lastDrainMs === null ? hint : Math.max(hint, this.lastDrainMs + DRAIN_MIN_INTERVAL_MS);
        if (dueAt(db, 'drain') !== target) schedule(db, 'drain', target, { force: true });
      }
      const job =
        db.one<{ next: number | null }>(
          `SELECT min(due_at) AS next FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','failed')`,
        )?.next ?? null;
      if (job !== null) schedule(db, 'snapshot', Math.max(job, now + SNAPSHOT_MIN_INTERVAL_MS));
      scheduleStatusJobsTimer(db, now);
    });
  }

  /** A socket event or an RPC wrote queue rows outside an alarm. */
  private timersChanged(): void {
    const deps = this.deps;
    if (deps === null) return;
    this.reconcileTimers(deps, deps.clock.nowMs());
    armAlarm(deps.alarms, deps.db);
  }

  private handlers(deps: IndexDeps): TimerHandlers {
    const m: ModuleDeps = deps;
    const ingest = this.ingest as IngestDeps;
    return {
      drain: async (now) => {
        this.lastDrainMs = now;
        await drain(m, now);
      },
      snapshot: async (now) => {
        const report = await snapshotStep(m, now);
        if (report.gapCleared) holdGapForDiscovery(m.db);
      },
      'jetstream-watchdog': async (now) => {
        await jetstreamWatchdog(m, ingest, now);
      },
      'status-sweep': async (now) => {
        await statusSweep(m, now);
      },
      'identity-sweep': async (now) => {
        await identitySweep(m, now);
      },
      discovery: async (now) => {
        await discover(m, now);
        if (!gapDiscoveryPending(m.db)) maybeClearGap(m.db);
      },
      gc: async (now) => {
        const report = runGc(m.db, now);
        schedule(m.db, 'gc', now + GC_INTERVAL_MS, { force: true });
        m.log.log('info', 'gc.done', { ...report });
      },
    };
  }

  override async alarm(): Promise<void> {
    const deps = this.deps;
    if (deps === null || this.migration?.status !== 'ready') return;
    const { db, clock, alarms, log } = deps;
    const now = clock.nowMs();
    try {
      const report = await runDue(alarms, db, now, this.handlers(deps), {
        maxRuns: TIMER_NAMES.length,
        deadline: { clock, atMs: now + ALARM_SLICE_MS },
      });
      this.lastAlarm = report;
      for (const f of [...report.recovered, ...report.failed]) {
        log.log('warn', 'alarm.timer_failed', {
          timer: f.name,
          streak: f.streak,
          retryAtMs: f.retryAtMs,
          error: errorName(f.error),
        });
      }
    } catch (error) {
      // A second alarm while a run is in flight: that run re-arms when it ends.
      if (!(error instanceof TimerReentryError)) log.log('error', 'alarm.failed', { error: errorName(error) });
    } finally {
      this.reconcileTimers(deps, clock.nowMs());
      armAlarm(alarms, db);
    }
  }

  // -------------------------------------------------------------------------
  // RPC

  /** The deps of a migrated, configured instance; rejects otherwise. */
  private live(): IndexDeps {
    if (this.deps === null) throw new NotReadyError(`index configuration is invalid (${errorName(this.depsError)})`);
    if (this.migrationError !== null) throw new NotReadyError('index storage migration failed');
    if (this.migration?.status !== 'ready') throw new NotReadyError('index storage is not ready');
    return this.deps;
  }

  /** Runs an RPC method body through `guarded` (no raw error leaves the DO). JS-private: not an RPC method. */
  #rpc<T>(method: string, body: () => T | Promise<T>): Promise<T> {
    return guarded(method, this.deps?.log ?? null, body);
  }

  async ready(): Promise<MigrateResult> {
    return this.#rpc('ready', () => {
      if (this.deps === null) throw new NotReadyError(`index configuration is invalid (${errorName(this.depsError)})`);
      if (this.migrationError !== null || this.migration === null) {
        throw new NotReadyError('index storage migration failed');
      }
      return this.migration;
    });
  }

  async indexing(did?: Did): Promise<Indexing> {
    return this.#rpc('indexing', () => {
      const m = this.live();
      const mode = m.config.ingestMode;
      return indexing(m.db, m.clock.nowMs(), did === undefined ? { mode } : { did, mode });
    });
  }

  async history(q: HistoryQuery): Promise<RowsResult<ScrobbleRow>> {
    return this.#rpc('history', () => history(this.live(), q));
  }

  async feed(q: FeedQuery): Promise<RowsResult<ScrobbleRow>> {
    return this.#rpc('feed', () => feed(this.live(), q));
  }

  async lookup(uri: string): Promise<ScrobbleRow | null> {
    return this.#rpc('lookup', () => lookup(this.live(), uri));
  }

  async recordStatus(uri: string): Promise<RecordStatus> {
    return this.#rpc('recordStatus', () => recordStatus(this.live(), uri));
  }

  async stats(q: StatsQuery): Promise<Statistics | null> {
    return this.#rpc('stats', () => stats(this.live(), q));
  }

  async profile(did: Did): Promise<Profile | null> {
    return this.#rpc('profile', () => profile(this.live(), did));
  }

  async following(q: FollowListQuery): Promise<RowsResult<FollowRow>> {
    return this.#rpc('following', () => following(this.live(), q));
  }

  async followers(q: FollowListQuery): Promise<RowsResult<FollowRow>> {
    return this.#rpc('followers', () => followers(this.live(), q));
  }

  async exportUser(did: Did): Promise<Export | null> {
    return this.#rpc('exportUser', () => exportUser(this.live(), did));
  }

  async resolveHandle(handle: string): Promise<ResolveOutcome> {
    return this.#rpc('resolveHandle', () => resolveHandle(this.live(), handle));
  }

  async notify(input: NotifyInput, ip: string): Promise<NotifyOutcome> {
    return this.#rpc('notify', () => {
      const m = this.live();
      const outcome = notify(m, input, ip, m.clock.nowMs());
      this.timersChanged();
      return outcome;
    });
  }

  /** Cron (scheduled.ts): the timers exist and the alarm is armed; in pulse mode a pulse is due now. */
  async ensureRunning(): Promise<void> {
    return this.#rpc('ensureRunning', () => {
      const m = this.live();
      const now = m.clock.nowMs();
      if (m.config.ingestMode === 'pulse') m.db.tx(() => schedule(m.db, 'jetstream-watchdog', now));
      this.ensureTimers(m, now);
      armAlarm(m.alarms, m.db);
    });
  }

  async adminStatus(): Promise<AdminStatus> {
    return this.#rpc('adminStatus', () => {
      const m = this.live();
      return {
        schema: this.migration as MigrateResult,
        ...internalStatus(m.db, m.clock.nowMs(), { mode: m.config.ingestMode }),
      };
    });
  }

  /**
   * A15: restore the whole IndexDO to its state at `atMs` (within the last 30
   * days). The bookmark is scheduled for the next session and the instance is
   * then aborted, so the next request opens the restored storage.
   */
  async adminPitr(atMs: number): Promise<PitrResult> {
    return this.#rpc('adminPitr', async () => {
      const m = this.live();
      const now = m.clock.nowMs();
      if (!Number.isSafeInteger(atMs) || atMs > now || atMs < now - PITR_WINDOW_MS) {
        throw new RangeError('atMs must be integer epoch ms within the last 30 days');
      }
      const bookmark = await this.ctx.storage.getBookmarkForTime(atMs);
      await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
      m.log.log('warn', 'admin.pitr_scheduled', { atMs });
      setTimeout(() => this.ctx.abort('point-in-time restore scheduled'), PITR_RESTART_DELAY_MS);
      return { bookmark };
    });
  }

  async adminResnapshot(did: Did): Promise<ResnapshotOutcome> {
    return this.#rpc('adminResnapshot', () => {
      const m = this.live();
      const result = scheduleSnapshot(m.db, did, ADMIN_RESNAPSHOT_REASON, m.clock.nowMs());
      this.timersChanged();
      return { status: result.status };
    });
  }
}

/** A scheduled row for `name`, or the claimed row of a run in progress. */
function timerRowExists(db: Db, name: 'jetstream-watchdog'): boolean {
  return db.one('SELECT 1 AS x FROM timers WHERE name IN (?, ?)', name, `~running:${name}`) !== null;
}

/**
 * The snapshot slice cleared `pending_gap` (scan finished, no gap job open)
 * while the gap's discovery pass is still running: set it again until that
 * pass ends (the discovery handler then clears it with `maybeClearGap`).
 */
function holdGapForDiscovery(db: Db): void {
  if (!gapDiscoveryPending(db)) return;
  db.tx(() => updateCheckpointBookkeeping(db, { pendingGap: true, gapScanAfterDid: GAP_SCAN_DONE }));
}

/**
 * gc (ADR §5.9): the snapshot block caches of walks that are no longer open,
 * verified-commit entries older than 7 days, identity_cache entries that can
 * no longer be served, expired host pauses, and hints that have kept failing
 * for HINT_ERROR_RETENTION_MS: such a hint is handed to a snapshot of its DID
 * (which covers the record at the signed head) and deleted; one whose DID
 * cannot be snapshotted (unknown, suppressed, queue full) is kept.
 */
export function runGc(db: Db, now: number): GcReport {
  const report: GcReport = {
    blockDids: 0,
    blocks: 0,
    verifiedCommits: 0,
    identities: 0,
    hostPauses: 0,
    expiredHints: 0,
  };
  const finished = db.all<{ did: string }>(
    `SELECT DISTINCT b.did FROM snapshot_blocks b WHERE NOT EXISTS (
       SELECT 1 FROM repo_jobs j WHERE j.did = b.did AND j.kind = 'snapshot' AND j.state IN ('pending','running','failed'))
     LIMIT ?`,
    GC_BLOCK_DIDS_PER_RUN,
  );
  for (const { did } of finished) {
    report.blocks += db.tx(() => clearBlockCache(db, did));
    report.blockDids += 1;
  }
  db.tx(() => {
    report.verifiedCommits = pruneVerifiedCommits(db, now);
    report.identities = pruneIdentityCache(db, now);
    report.hostPauses = clearExpiredHostPauses(db, now);
  });
  const expired = db.all<{ uri: string; did: string }>(
    'SELECT uri, did FROM hints WHERE last_error IS NOT NULL AND receipt_time < ? ORDER BY receipt_time LIMIT ?',
    toStorage(fromMs(now - HINT_ERROR_RETENTION_MS)),
    GC_HINTS_PER_RUN,
  );
  for (const hint of expired) {
    db.tx(() => {
      const s = scheduleSnapshot(db, hint.did, HINT_EXPIRED_REASON, now);
      if (s.status !== 'scheduled' && s.status !== 'already') return;
      if (deleteHint(db, hint.uri)) {
        incrementCounter(db, HINT_EXPIRED_COUNTER, '');
        report.expiredHints += 1;
      }
    });
  }
  return report;
}
