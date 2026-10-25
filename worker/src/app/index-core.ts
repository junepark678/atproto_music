// IndexCore: the host-neutral body of the index (ADR 0005 §2.2, §3.1, §3.3;
// N1-02), moved out of the IndexDO class of ADR 0004 §1.1, §4.4, §5.9.
//
// DO modules are plain functions `(m: ModuleDeps, args)`; IndexCore exposes
// them as the methods of IndexRpc (worker/src/do/contracts.ts) plus
// AdminRpc.adminResnapshot (worker/src/http/admin.ts). Everything it needs
// from its process arrives as a `Host` (app/host.ts): the db, the two lane
// alarms, the Jetstream connector, the transport, an optional backup port,
// the logger, the clock and the randomness. This module imports no
// `cloudflare:*` module and no value from env.ts (worker/test/composition/
// index-core.test.ts checks it); do/index-do.ts is the Workers wrapper until
// N7-01 and the Node composition (node/compose.ts, N2-01) the other host.
//
// Life cycle:
//  1. `new IndexCore(config, host, extensions, options)`. The identity
//     resolver defaults to the one over identity_cache.
//  2. The migration outcome is recorded (`open(migrate)`, or `markMigrated` /
//     `markMigrationFailed` when the host migrated before). `too_new` storage
//     (written by newer code) is left untouched: ready() reports it and
//     nothing else runs.
//  3. `start()`:
//     - the previous instance's socket did not survive: `noteRestart` →
//       W2-05 `markDisconnected`, which writes only on the 1→0 transition, so
//       a restart never moves the disconnect instant the stale rule measures;
//     - snapshot and status jobs left `running` by the previous instance go
//       back to `pending` (their slices died with it);
//     - the core timers exist (sweeps, discovery, gc, the Jetstream watchdog
//       due now unless ingestion is off) and agree with the queues, and the
//       core alarm is armed at `min(due_at)` of the core lane;
//     - every extension's start hook runs, then the extension alarm is armed
//       at `min(due_at)` of the extension lane.
//
// Two timer lanes (ADR 0005 §3.3). `alarm()` (driven by `Host.alarm`) runs
// `runDue` over the core lane with one handler per timer, in the fixed
// priority order drain → snapshot → jetstream-watchdog → status-sweep →
// identity-sweep → discovery → gc, then reconciles the timers with the queues
// and re-arms the core alarm. `extensionAlarm()` (driven by
// `Host.extensionAlarm`) runs the extension lane: the EXTENSION_TIMER_NAMES
// that some CoreExtension registered a handler for, in the order outbox →
// forward → import → oauth-keepalive → expiry-sweep → backup, and re-arms the
// extension alarm. A name without a handler is never written (the extension
// context refuses it) and never armed (the lane does not contain it). Each
// lane has its own single-flight guard (keyed on its alarm storage), so a
// kicked outbox never waits behind a snapshot slice and neither lane recovers
// or reschedules the other's claimed rows. Alarms are at-least-once and every
// handler is idempotent (ADR 0004 §5.9); a throwing handler is rescheduled at
// `now + timerBackoffMs(streak)` by `runDue`.
//
// Timers written outside an alarm (a Jetstream hint, notify, an admin
// resnapshot) are reconciled at once and the core alarm re-armed. The drain
// runs at most every 2 s, measured from the start of the previous drain, so
// a steady stream of hints is batched and can never starve it; the other
// queue timers are only ever pulled forward.
//
// RPC rejections (ADR 0004 §5.9 logging): no raw error leaves a method.
// NotReadyError, NotSupportedError, RangeError (argument validation) and
// ApiError keep their name and message but lose their stack and cause;
// anything else (a storage fault, a platform error, a module bug) is logged
// through the logger by method and error name only and rejects as a bare
// `IndexError: index operation failed`. Callers map every rejection to a
// generic envelope anyway (worker/src/http/error.ts).
//
// Gap recovery (ADR 0004 §5.5): the socket's gap handler schedules the
// snapshot scan (W4-01 `scheduleGapRecovery`) and one discovery pass
// (`requestGapDiscovery`), and `pending_gap` is held until that discovery
// pass has finished too: `maybeClearGap` (snapshot-job.ts) reads the pass in
// the same transaction that would clear the flag, so the hold and the clear
// are one commit (no crash can land between them), through the W2-05
// bookkeeping writer only.

import type { Did, Export, Indexing, NotifyInput, Profile, RecordStatus, Statistics } from '@atmusic/core/api-types';
import { ApiError } from '@atmusic/core/errors';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import type { AppConfig } from '../config';
import type {
  AdminStatus,
  BackupOutcome,
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
} from '../do/contracts';
import type { Db } from '../do/db';
import { reclaimStatusLeases, scheduleStatusJobsTimer } from '../do/ingest/accounts';
import { reclaimSnapshotLeases, scheduleSnapshot } from '../do/ingest/admission';
import { clearBlockCache } from '../do/ingest/block-cache';
import { noteRestart, readIngestCheckpoint } from '../do/ingest/checkpoint';
import { pruneVerifiedCommits } from '../do/ingest/commit-cache';
import { discover, ensureDiscoveryTimer, requestGapDiscovery } from '../do/ingest/discovery';
import { deleteHint, nextHintDue } from '../do/ingest/hints';
import { cachedIdentityResolver, pruneIdentityCache } from '../do/ingest/identity-cache';
import { type IngestDeps, jetstreamWatchdog, type PulseTimer } from '../do/ingest/ingest-mode';
import type { ConnectJetstream } from '../do/ingest/jetstream-socket';
import { notify, recordStatus } from '../do/ingest/notify';
import { clearExpiredHostPauses } from '../do/ingest/pds-budget';
import { maybeClearGap, SNAPSHOT_MIN_INTERVAL_MS, scheduleGapRecovery, snapshotStep } from '../do/ingest/snapshot-job';
import { identitySweep, statusSweep } from '../do/ingest/sweeps';
import { DRAIN_MIN_INTERVAL_MS, drain } from '../do/ingest/verify-drain';
import type { MigrateResult } from '../do/migrate';
import { exportUser } from '../do/read/export';
import { feed } from '../do/read/feed';
import { followers, following } from '../do/read/follows';
import { history } from '../do/read/history';
import { lookup } from '../do/read/lookup';
import { profile, resolveHandle } from '../do/read/profile';
import { stats } from '../do/read/stats';
import { indexing, internalStatus } from '../do/status';
import {
  type AlarmStorage,
  armAlarm,
  CORE_LANE,
  dueAt,
  EXTENSION_TIMER_NAMES,
  type ExtensionTimerName,
  type LaneHandlers,
  type RunReport,
  runDue,
  schedule,
  type TimerHandlers,
  type TimerLane,
  TimerReentryError,
} from '../do/timers';
import { incrementCounter } from '../do/write/keys';
import type { AdminRpc, ResnapshotOutcome } from '../http/admin';
import type { CoreExtension, ExtensionContext, ExtensionTimerHandler, Host, IndexCoreOptions } from './host';

/** The singleton's name: `INDEX.idFromName(INDEX_NAME)` (ADR 0004 §4.1). */
export const INDEX_NAME = 'index-v1';

/** gc cadence (ADR 0004 §5.9: daily). */
export const GC_INTERVAL_MS = 24 * 3_600_000;
/** gc: snapshot block caches of finished walks dropped per run. */
export const GC_BLOCK_DIDS_PER_RUN = 50;
/** gc: a hint still failing this long after its receipt is handed to a snapshot. */
export const HINT_ERROR_RETENTION_MS = 7 * 24 * 3_600_000;
/** gc: expired failing hints handled per run. */
export const GC_HINTS_PER_RUN = 200;
export const HINT_EXPIRED_REASON = 'hint_expired';
export const HINT_EXPIRED_COUNTER = 'hint_expired';
/** No new timer handler starts this long after a lane's run began (the DO alarm wall limit is 15 min). */
export const ALARM_SLICE_MS = 5 * 60_000;
/** Durable Objects keep 30 days of point-in-time history (ADR 0004 A15). */
export const PITR_WINDOW_MS = 30 * 24 * 3_600_000;
/** The restart into a restored bookmark is deferred so the RPC answer leaves first. */
export const PITR_RESTART_DELAY_MS = 50;
export const ADMIN_RESNAPSHOT_REASON = 'admin';

/**
 * Everything the Workers IndexDO's modules and its alarm need; built once per
 * instance by `IndexDO.buildDeps` (the ADR 0004 §4.4 test seam, kept until
 * N4-03 and N7-01).
 */
export interface IndexDeps extends ModuleDeps {
  connectJetstream: ConnectJetstream;
  /** Measures the pulse's 20 s bound; default setTimeout. */
  pulseTimer?: PulseTimer;
  /** Where the alarm is armed (production: `ctx.storage`). One object per instance. */
  alarms: AlarmStorage;
}

// ---------------------------------------------------------------------------
// Logging (Workers Logs, journald). Fields are structured; secrets never leave.

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

/** The Logger for `env`: redacts its CURSOR_KEY and ADMIN_TOKEN (structural, so any host's env fits). */
export function envLogger(env: { CURSOR_KEY?: string; ADMIN_TOKEN?: string }, sink?: LogSink): Logger {
  return createLogger([env.CURSOR_KEY, env.ADMIN_TOKEN], sink);
}

/** An error's name for logs: never its message, which may carry values. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// ---------------------------------------------------------------------------
// Errors

export class NotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotReadyError';
  }
}

export const NOT_SUPPORTED = 'not_supported';

/** The host has no port for this operation (adminPitr without a PITR port). */
export class NotSupportedError extends Error {
  constructor(message: string = NOT_SUPPORTED) {
    super(message);
    this.name = 'NotSupportedError';
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
  if (error instanceof NotSupportedError) return bare(new NotSupportedError(error.message));
  if (error instanceof RangeError) return bare(new RangeError(error.message));
  if (error instanceof ApiError) return bare(new ApiError(error.code, error.message, error.fields, error.status));
  const fields = { method, error: errorName(error) };
  if (log !== null) log.log('error', 'index.rpc_failed', fields);
  else console.error(JSON.stringify({ level: 'error', event: 'index.rpc_failed', ...fields }));
  return bare(new IndexError());
}

/** Runs one RPC method body; any rejection is replaced by `rpcRejection`. */
export async function guarded<T>(method: string, log: Logger | null, body: () => T | Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw rpcRejection(error, method, log);
  }
}

// ---------------------------------------------------------------------------
// IndexCore

export type LaneId = 'core' | 'extension';

const EXTENSION_NAME_SET = new Set<string>(EXTENSION_TIMER_NAMES);

export class IndexCore implements IndexRpc, AdminRpc {
  /** The module dependencies every DO module and extension runs with. */
  readonly deps: ModuleDeps;
  readonly host: Host;
  /** The extension lane: the extension names some extension registered, in EXTENSION_TIMER_NAMES order. */
  readonly extensionLane: TimerLane;
  /** What extensions use to schedule and kick their timers. */
  readonly extensionTimers: ExtensionContext;
  /** The last core-lane runDue report (operator and test introspection only). */
  lastAlarm: RunReport | null = null;
  /** The last extension-lane runDue report. */
  lastExtensionAlarm: RunReport | null = null;

  private readonly extensions: readonly CoreExtension[];
  private readonly extensionHandlers: LaneHandlers;
  private readonly ingest: IngestDeps;
  private migration: MigrateResult | null = null;
  private migrationError: unknown = null;
  /** When this instance's last drain started (the 2 s drain floor). */
  private lastDrainMs: number | null = null;

  constructor(
    config: AppConfig,
    host: Host,
    extensions: readonly CoreExtension[] = [],
    options: IndexCoreOptions = {},
  ) {
    this.host = host;
    this.deps = {
      db: host.db,
      clock: host.clock,
      random: host.random,
      transport: host.transport,
      identity: options.identity ?? cachedIdentityResolver(host.db, { transport: host.transport, clock: host.clock }),
      config,
      log: host.log,
    };
    this.extensions = [...extensions];

    const registered = new Map<ExtensionTimerName, ExtensionTimerHandler>();
    for (const extension of this.extensions) {
      for (const [name, handler] of Object.entries(extension.timers ?? {})) {
        if (handler === undefined) continue;
        if (!EXTENSION_NAME_SET.has(name)) {
          throw new TypeError(`extension ${extension.name}: ${name} is not an extension timer name`);
        }
        if (registered.has(name as ExtensionTimerName)) {
          throw new TypeError(`extension ${extension.name}: timer ${name} already has a handler`);
        }
        registered.set(name as ExtensionTimerName, handler);
      }
    }
    const names = Object.freeze(EXTENSION_TIMER_NAMES.filter((name) => registered.has(name)));
    if (names.length > 0 && host.extensionAlarm === host.alarm) {
      throw new TypeError('Host.extensionAlarm must be a different alarm storage from Host.alarm');
    }
    this.extensionLane = Object.freeze({ names });

    const context: ExtensionContext = {
      deps: this.deps,
      schedule: (name, dueAtMs, scheduleOptions) => {
        if (!registered.has(name)) return null;
        const db = this.deps.db;
        const due = db.tx(() => schedule(db, name, dueAtMs, scheduleOptions));
        this.armExtensionLane();
        return due;
      },
      kick: (name) => context.schedule(name, this.deps.clock.nowMs()),
    };
    this.extensionTimers = Object.freeze(context);
    const handlers: LaneHandlers = {};
    for (const [name, handler] of registered) handlers[name] = (now) => handler(now, context);
    this.extensionHandlers = handlers;

    this.ingest = {
      connectJetstream: host.connectJetstream,
      ...(options.pulseTimer === undefined ? {} : { pulseTimer: options.pulseTimer }),
      scheduleGapRecovery: (db, now) => {
        scheduleGapRecovery(db, now);
        requestGapDiscovery(db, now);
      },
      onTimersChanged: () => this.timersChanged(),
    };
  }

  // -------------------------------------------------------------------------
  // Migration outcome and start-up

  /** Records the outcome of the migration the host ran (or that `open` runs). */
  markMigrated(result: MigrateResult): void {
    this.migration = result;
    this.migrationError = null;
  }

  markMigrationFailed(error: unknown): void {
    this.migration = null;
    this.migrationError = error;
    this.deps.log.log('error', 'index.migration_failed', { error: errorName(error) });
  }

  /** Runs `migrate`, records its outcome and starts when the storage is ready. */
  open(migrate: () => MigrateResult): MigrateResult | null {
    let result: MigrateResult;
    try {
      result = migrate();
    } catch (error) {
      this.markMigrationFailed(error);
      return null;
    }
    this.markMigrated(result);
    if (result.status === 'ready') this.start();
    return result;
  }

  /**
   * noteRestart, lease reclaim, the core timers, the core alarm; then the
   * extensions' start hooks and the extension alarm. Throws NotReadyError
   * unless the storage is migrated and ready.
   */
  start(): void {
    if (this.migration?.status !== 'ready') throw new NotReadyError('index storage is not ready');
    const { db, clock } = this.deps;
    const now = clock.nowMs();
    noteRestart(db, now);
    reclaimSnapshotLeases(db, now, { all: true });
    reclaimStatusLeases(db, now, { all: true });
    this.ensureTimers(now, { startup: true });
    armAlarm(this.host.alarm, db, CORE_LANE);
    for (const extension of this.extensions) extension.start?.(this.extensionTimers, now);
    this.armExtensionLane();
  }

  /** True once the storage is migrated and ready. */
  get isReady(): boolean {
    return this.migrationError === null && this.migration?.status === 'ready';
  }

  // -------------------------------------------------------------------------
  // Timers and the two lanes

  /**
   * Every periodic core timer exists, and the queue timers agree with the
   * queues. At start-up the Jetstream watchdog is made due now (reconnect, or
   * the first pulse; with ingestion `off` it runs once to close and record the
   * mode); later calls (cron, the ensureRunning interval) only recreate it
   * when it is missing.
   */
  private ensureTimers(now: number, o: { startup?: boolean } = {}): void {
    const { db, config } = this.deps;
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
    this.reconcileTimers(now);
  }

  /**
   * Align the queue timers with their queues:
   * - `drain` at the next due hint, but no sooner than DRAIN_MIN_INTERVAL_MS
   *   after the last drain of this instance started (ADR 0004 §5.9: "at most
   *   every 2 s"; the hint queue itself schedules a new hint due at once). The
   *   floor is anchored to that start, not to now, so a steady stream of hints
   *   batches into one drain per 2 s and can never postpone it;
   * - `snapshot` pulled forward to the next due job (never later: no `force`);
   * - `status-sweep` pulled forward to the next status job.
   */
  private reconcileTimers(now: number): void {
    const { db } = this.deps;
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
    this.reconcileTimers(this.deps.clock.nowMs());
    armAlarm(this.host.alarm, this.deps.db, CORE_LANE);
  }

  /** Arms the extension alarm at the extension lane's next due time; nothing at all when the lane is empty. */
  private armExtensionLane(): number | null {
    if (this.extensionLane.names.length === 0) return null;
    return armAlarm(this.host.extensionAlarm, this.deps.db, this.extensionLane);
  }

  private coreHandlers(): TimerHandlers {
    const m = this.deps;
    const ingest = this.ingest;
    return {
      drain: async (now) => {
        this.lastDrainMs = now;
        await drain(m, now);
      },
      snapshot: async (now) => {
        // maybeClearGap (in the slice) holds pending_gap while the gap's discovery pass runs.
        await snapshotStep(m, now);
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
        // The gap's pass may just have ended: clear pending_gap if nothing else holds it.
        maybeClearGap(m.db);
      },
      gc: async (now) => {
        const report = runGc(m.db, now);
        schedule(m.db, 'gc', now + GC_INTERVAL_MS, { force: true });
        m.log.log('info', 'gc.done', { ...report });
      },
    };
  }

  /**
   * One run of a lane: `runDue` within ALARM_SLICE_MS, failures logged, and
   * the lane's alarm re-armed in `finally` (the core lane reconciles its queue
   * timers first). Returns the report, or null when nothing ran (storage not
   * ready, an empty extension lane, or a run already in flight on the lane).
   */
  async tick(lane: LaneId = 'core'): Promise<RunReport | null> {
    if (!this.isReady) return null;
    const core = lane === 'core';
    if (!core && this.extensionLane.names.length === 0) return null;
    const { db, clock, log } = this.deps;
    const storage = core ? this.host.alarm : this.host.extensionAlarm;
    const timerLane = core ? CORE_LANE : this.extensionLane;
    const handlers = core ? this.coreHandlers() : this.extensionHandlers;
    const now = clock.nowMs();
    try {
      const report = await runDue(
        storage,
        db,
        now,
        handlers,
        { maxRuns: timerLane.names.length, deadline: { clock, atMs: now + ALARM_SLICE_MS } },
        timerLane,
      );
      if (core) this.lastAlarm = report;
      else this.lastExtensionAlarm = report;
      for (const f of [...report.recovered, ...report.failed]) {
        log.log('warn', 'alarm.timer_failed', {
          ...(core ? {} : { lane }),
          timer: f.name,
          streak: f.streak,
          retryAtMs: f.retryAtMs,
          error: errorName(f.error),
        });
      }
      return report;
    } catch (error) {
      // A second run while one is in flight on this lane: that run re-arms when it ends.
      if (!(error instanceof TimerReentryError)) {
        log.log('error', 'alarm.failed', { ...(core ? {} : { lane }), error: errorName(error) });
      }
      return null;
    } finally {
      if (core) {
        this.reconcileTimers(clock.nowMs());
        armAlarm(storage, db, CORE_LANE);
      } else {
        armAlarm(storage, db, timerLane);
      }
    }
  }

  /** The core lane's alarm handler (`Host.alarm`). */
  async alarm(): Promise<void> {
    await this.tick('core');
  }

  /** The extension lane's alarm handler (`Host.extensionAlarm`). */
  async extensionAlarm(): Promise<void> {
    await this.tick('extension');
  }

  /** Runs the core lane now (tests and the Node heartbeat); same as `alarm()`, with the report. */
  runAlarmNow(): Promise<RunReport | null> {
    return this.tick('core');
  }

  // -------------------------------------------------------------------------
  // RPC

  /** The deps of a migrated instance; rejects otherwise. */
  private live(): ModuleDeps {
    if (this.migrationError !== null) throw new NotReadyError('index storage migration failed');
    if (this.migration?.status !== 'ready') throw new NotReadyError('index storage is not ready');
    return this.deps;
  }

  /** Runs a method body through `guarded` (no raw error leaves the core). */
  #rpc<T>(method: string, body: () => T | Promise<T>): Promise<T> {
    return guarded(method, this.deps.log, body);
  }

  async ready(): Promise<MigrateResult> {
    return this.#rpc('ready', () => {
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

  /**
   * Cron (scheduled.ts) and the Node 5-minute interval: the timers exist and
   * both alarms are armed; in pulse mode a pulse is due now.
   */
  async ensureRunning(): Promise<void> {
    return this.#rpc('ensureRunning', () => {
      const m = this.live();
      const now = m.clock.nowMs();
      if (m.config.ingestMode === 'pulse') m.db.tx(() => schedule(m.db, 'jetstream-watchdog', now));
      this.ensureTimers(now);
      armAlarm(this.host.alarm, m.db, CORE_LANE);
      this.armExtensionLane();
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
   * ADR 0004 A15: restore the whole index to its state at `atMs` (within the
   * last 30 days) through the host's PITR port. A host without one (Node)
   * rejects with NotSupportedError. Removed by N7-01.
   */
  async adminPitr(atMs: number): Promise<PitrResult> {
    return this.#rpc('adminPitr', async () => {
      const m = this.live();
      const pitr = this.host.pitr;
      if (pitr === undefined) throw new NotSupportedError(`${NOT_SUPPORTED}: this host has no point-in-time restore`);
      const now = m.clock.nowMs();
      if (!Number.isSafeInteger(atMs) || atMs > now || atMs < now - PITR_WINDOW_MS) {
        throw new RangeError('atMs must be integer epoch ms within the last 30 days');
      }
      return pitr.restore(atMs);
    });
  }

  /** One manual backup (ADR 0005 §14.5); `not_supported`, changing nothing, without a backup port. */
  async adminBackup(): Promise<BackupOutcome> {
    return this.#rpc('adminBackup', async (): Promise<BackupOutcome> => {
      this.live();
      const backup = this.host.backup;
      if (backup === undefined) return { status: NOT_SUPPORTED };
      return backup.run('manual');
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

// ---------------------------------------------------------------------------
// gc

export interface GcReport {
  blockDids: number;
  blocks: number;
  verifiedCommits: number;
  identities: number;
  hostPauses: number;
  expiredHints: number;
}

/**
 * gc (ADR 0004 §5.9): the snapshot block caches of walks that are no longer
 * open, verified-commit entries older than 7 days, identity_cache entries that
 * can no longer be served, expired host pauses, and hints that have kept
 * failing for HINT_ERROR_RETENTION_MS: such a hint is handed to a snapshot of
 * its DID (which covers the record at the signed head) and deleted; one whose
 * DID cannot be snapshotted (unknown, suppressed, queue full) is kept.
 *
 * Kept hints never block the others: hints of unknown or suppressed DIDs are
 * excluded from the selection itself, and once a new snapshot job is refused
 * (`busy`: the pending-job cap) the rest of the run selects only hints whose
 * DID already has an open snapshot job (those are `already`, never busy). The
 * selection pages by `(receipt_time, uri)` past every hint it examined, so up
 * to GC_HINTS_PER_RUN expired hints that can be handed over are handled per
 * run however many kept ones sort before them.
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
  const cutoff = toStorage(fromMs(now - HINT_ERROR_RETENTION_MS));
  let after: { receipt: string; uri: string } | null = null;
  let newJobsRefused = false;
  while (report.expiredHints < GC_HINTS_PER_RUN) {
    const page: Array<{ uri: string; did: string; receipt_time: string }> = db.all<{
      uri: string;
      did: string;
      receipt_time: string;
    }>(
      `SELECT h.uri, h.did, h.receipt_time FROM hints h
       WHERE h.last_error IS NOT NULL AND h.receipt_time < ?
         AND EXISTS (SELECT 1 FROM users u WHERE u.did = h.did)
         AND NOT EXISTS (SELECT 1 FROM suppression x WHERE x.did = h.did)
         AND (? = 0 OR EXISTS (SELECT 1 FROM repo_jobs j WHERE j.did = h.did AND j.kind = 'snapshot'
                                AND j.state IN ('pending','running','failed')))
         AND (? IS NULL OR h.receipt_time > ? OR (h.receipt_time = ? AND h.uri > ?))
       ORDER BY h.receipt_time, h.uri LIMIT ?`,
      cutoff,
      newJobsRefused ? 1 : 0,
      after?.receipt ?? null,
      after?.receipt ?? null,
      after?.receipt ?? null,
      after?.uri ?? null,
      GC_HINTS_PER_RUN - report.expiredHints,
    );
    if (page.length === 0) break;
    for (const hint of page) {
      after = { receipt: hint.receipt_time, uri: hint.uri };
      db.tx(() => {
        const s = scheduleSnapshot(db, hint.did, HINT_EXPIRED_REASON, now);
        if (s.status === 'busy') newJobsRefused = true;
        if (s.status !== 'scheduled' && s.status !== 'already') return;
        if (deleteHint(db, hint.uri)) {
          incrementCounter(db, HINT_EXPIRED_COUNTER, '');
          report.expiredHints += 1;
        }
      });
    }
  }
  return report;
}
