// IndexDO: the one SQLite Durable Object (ADR 0004 §1.1, §4.4, §5.9), now a
// thin Workers wrapper around IndexCore (worker/src/app/index-core.ts; ADR
// 0005 §2.2, N1-02). N7-01 deletes it.
//
// Everything the DO did lives in IndexCore: the RPC methods of IndexRpc
// (worker/src/do/contracts.ts) plus AdminRpc.adminResnapshot
// (worker/src/http/admin.ts), the start-up, the timers and the alarm. This
// class only builds a Workers `Host` and delegates:
//  1. `buildDeps(env, ctx)` (protected; the test seam of ADR 0004 §4.4: test
//     entries under worker/test/**/entry.ts subclass it, until N4-03 and
//     N7-01). Production: the strict `parseConfig(env)` (the fixture prefix
//     is refused), systemClock, cryptoRandom, the global `fetch` transport,
//     the identity resolver over identity_cache, the production Jetstream
//     connector and the DO's own alarm storage. A config that does not parse
//     leaves the DO unable to answer: every RPC rejects, so /health/ready is
//     503 and meta `scaffold`.
//  2. The Workers Host: the deps' db, clock, random, transport, logger and
//     connector; `alarm` is the deps' alarm storage; the PITR port is the
//     DO's bookmark API. The Workers host has no extensions, so its extension
//     lane is empty and `extensionAlarm` is never used (it throws if it ever
//     were); it has no backup port, so adminBackup answers `not_supported`.
//  3. Inside `blockConcurrencyWhile` (no request or alarm runs before it
//     finishes): `migrate(ctx.storage)`, then `IndexCore.start()` when ready.
//
// Every name this module used to define is defined in app/index-core.ts and
// re-exported here, so router.ts, http/admin.ts and every test keep compiling
// until N2-01 repoints them.

import { DurableObject } from 'cloudflare:workers';
import { fetchTransport } from '@atmusic/atproto/transport';
import type { Did, Export, Indexing, NotifyInput, Profile, RecordStatus, Statistics } from '@atmusic/core/api-types';
import { cryptoRandom, systemClock } from '@atmusic/core/deps';
import type { Host } from '../app/host';
import {
  envLogger,
  errorName,
  guarded,
  IndexCore,
  type IndexDeps,
  NotReadyError,
  PITR_RESTART_DELAY_MS,
} from '../app/index-core';
import { parseConfig } from '../config';
import type { Env } from '../env';
import type { AdminRpc, ResnapshotOutcome } from '../http/admin';
import type {
  AdminStatus,
  BackupOutcome,
  FeedQuery,
  FollowListQuery,
  FollowRow,
  HistoryQuery,
  IndexRpc,
  NotifyOutcome,
  PitrResult,
  ResolveOutcome,
  RowsResult,
  ScrobbleRow,
  StatsQuery,
} from './contracts';
import { doDb } from './db';
import { cachedIdentityResolver } from './ingest/identity-cache';
import { connectJetstream } from './ingest/jetstream-socket';
import { type MigrateResult, migrate } from './migrate';
import type { AlarmStorage, RunReport } from './timers';

export {
  ADMIN_RESNAPSHOT_REASON,
  ALARM_SLICE_MS,
  createLogger,
  envLogger,
  GC_BLOCK_DIDS_PER_RUN,
  GC_HINTS_PER_RUN,
  GC_INTERVAL_MS,
  type GcReport,
  HINT_ERROR_RETENTION_MS,
  HINT_EXPIRED_COUNTER,
  HINT_EXPIRED_REASON,
  INDEX_ERROR_MESSAGE,
  INDEX_ERROR_NAME,
  INDEX_NAME,
  type IndexDeps,
  IndexError,
  type LogSink,
  NotReadyError,
  PITR_RESTART_DELAY_MS,
  PITR_WINDOW_MS,
  runGc,
} from '../app/index-core';

/** The Workers host has no extension timers; its extension lane is always empty. */
const NO_EXTENSION_ALARM: AlarmStorage = {
  setAlarm() {
    throw new TypeError('the Workers host has no extension timer lane');
  },
  deleteAlarm() {
    throw new TypeError('the Workers host has no extension timer lane');
  },
};

export class IndexDO extends DurableObject<Env> implements IndexRpc, AdminRpc {
  /** Null when buildDeps failed (see `depsError`). */
  protected readonly deps: IndexDeps | null;
  private readonly depsError: unknown = null;
  /** Null exactly when `deps` is. */
  private readonly core: IndexCore | null;

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
    this.core =
      deps === null
        ? null
        : new IndexCore(deps.config, workersHost(ctx, deps), [], {
            identity: deps.identity,
            ...(deps.pulseTimer === undefined ? {} : { pulseTimer: deps.pulseTimer }),
          });
    const core = this.core;
    void ctx.blockConcurrencyWhile(async () => {
      if (core !== null) {
        core.open(() => migrate(ctx.storage));
        return;
      }
      // Unconfigured: the storage is still migrated, but nothing starts and every RPC rejects.
      try {
        migrate(ctx.storage);
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', event: 'index.migration_failed', error: errorName(error) }));
      }
    });
  }

  /** Production dependencies (ADR 0004 §4.4). Test entries override this, and only this. */
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

  /** The last alarm's runDue report (operator and test introspection only). */
  get lastAlarm(): RunReport | null {
    return this.core?.lastAlarm ?? null;
  }

  override async alarm(): Promise<void> {
    await this.core?.alarm();
  }

  /** `body(core)`, or the not-configured rejection when buildDeps failed. JS-private: not an RPC method. */
  #call<T>(method: string, body: (core: IndexCore) => Promise<T>): Promise<T> {
    const core = this.core;
    if (core === null) {
      return guarded(method, null, () => {
        throw new NotReadyError(`index configuration is invalid (${errorName(this.depsError)})`);
      });
    }
    return body(core);
  }

  async ready(): Promise<MigrateResult> {
    return this.#call('ready', (c) => c.ready());
  }

  async indexing(did?: Did): Promise<Indexing> {
    return this.#call('indexing', (c) => c.indexing(did));
  }

  async history(q: HistoryQuery): Promise<RowsResult<ScrobbleRow>> {
    return this.#call('history', (c) => c.history(q));
  }

  async feed(q: FeedQuery): Promise<RowsResult<ScrobbleRow>> {
    return this.#call('feed', (c) => c.feed(q));
  }

  async lookup(uri: string): Promise<ScrobbleRow | null> {
    return this.#call('lookup', (c) => c.lookup(uri));
  }

  async recordStatus(uri: string): Promise<RecordStatus> {
    return this.#call('recordStatus', (c) => c.recordStatus(uri));
  }

  async stats(q: StatsQuery): Promise<Statistics | null> {
    return this.#call('stats', (c) => c.stats(q));
  }

  async profile(did: Did): Promise<Profile | null> {
    return this.#call('profile', (c) => c.profile(did));
  }

  async following(q: FollowListQuery): Promise<RowsResult<FollowRow>> {
    return this.#call('following', (c) => c.following(q));
  }

  async followers(q: FollowListQuery): Promise<RowsResult<FollowRow>> {
    return this.#call('followers', (c) => c.followers(q));
  }

  async exportUser(did: Did): Promise<Export | null> {
    return this.#call('exportUser', (c) => c.exportUser(did));
  }

  async resolveHandle(handle: string): Promise<ResolveOutcome> {
    return this.#call('resolveHandle', (c) => c.resolveHandle(handle));
  }

  async notify(input: NotifyInput, ip: string): Promise<NotifyOutcome> {
    return this.#call('notify', (c) => c.notify(input, ip));
  }

  /** Cron (scheduled.ts): the timers exist and the alarm is armed; in pulse mode a pulse is due now. */
  async ensureRunning(): Promise<void> {
    return this.#call('ensureRunning', (c) => c.ensureRunning());
  }

  async adminStatus(): Promise<AdminStatus> {
    return this.#call('adminStatus', (c) => c.adminStatus());
  }

  /**
   * A15: restore the whole IndexDO to its state at `atMs` (within the last 30
   * days). The bookmark is scheduled for the next session and the instance is
   * then aborted, so the next request opens the restored storage.
   */
  async adminPitr(atMs: number): Promise<PitrResult> {
    return this.#call('adminPitr', (c) => c.adminPitr(atMs));
  }

  /** The Workers host has no backup port: `not_supported`, nothing changed. */
  async adminBackup(): Promise<BackupOutcome> {
    return this.#call('adminBackup', (c) => c.adminBackup());
  }

  async adminResnapshot(did: Did): Promise<ResnapshotOutcome> {
    return this.#call('adminResnapshot', (c) => c.adminResnapshot(did));
  }
}

/** The Workers Host over the DO's state and the deps `buildDeps` returned. */
function workersHost(ctx: DurableObjectState, deps: IndexDeps): Host {
  return {
    db: deps.db,
    alarm: deps.alarms,
    extensionAlarm: NO_EXTENSION_ALARM,
    connectJetstream: deps.connectJetstream,
    transport: deps.transport,
    log: deps.log,
    clock: deps.clock,
    random: deps.random,
    pitr: {
      async restore(atMs) {
        const bookmark = await ctx.storage.getBookmarkForTime(atMs);
        await ctx.storage.onNextSessionRestoreBookmark(bookmark);
        deps.log.log('warn', 'admin.pitr_scheduled', { atMs });
        setTimeout(() => ctx.abort('point-in-time restore scheduled'), PITR_RESTART_DELAY_MS);
        return { bookmark };
      },
    },
  };
}
