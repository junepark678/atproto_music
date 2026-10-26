// The host boundary of the index (ADR 0005 §2.1, §3.1, §3.3; N1-02).
//
// `IndexCore` (app/index-core.ts) is host-neutral: everything it needs from
// the process around it arrives as a `Host`. The Workers wrapper
// (do/index-do.ts) builds one from the DO's storage until N7-01; the Node
// composition (node/compose.ts, N2-01) builds one from node:sqlite, two
// NodeAlarms (N1-03), the ws connector (N1-04) and the pinned transport
// (N1-05).
//
// Two alarm storages, one per timer lane (ADR §3.3): `alarm` arms the core
// lane (TIMER_NAMES) and `extensionAlarm` the extension lane
// (EXTENSION_TIMER_NAMES). Each lane has its own single-flight guard, keyed
// on its storage object, so the two must be distinct objects whenever the
// extension lane has handlers.
//
// Feature code reaches the core through `CoreExtension`s: each contributes
// handlers for extension timers (a name without a handler is never written or
// armed) and an optional start hook.
//
// Types only: nothing here is a value, so this module imports no runtime.

import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import type { Transport } from '@atmusic/atproto/transport';
import type { Clock, Random } from '@atmusic/core/deps';
import type { BackupKind, BackupOutcome, Logger, ModuleDeps, PitrResult } from '../do/contracts';
import type { Db } from '../do/db';
import type { PulseTimer } from '../do/ingest/ingest-mode';
import type { ConnectJetstream } from '../do/ingest/jetstream-socket';
import type { AlarmStorage, ExtensionTimerName, ScheduleOptions } from '../do/timers';

/** Online backups (ADR 0005 §14.5; implemented by worker/src/node/backup.ts, N3-07). */
export interface BackupPort {
  run(kind: BackupKind): Promise<Exclude<BackupOutcome, { status: 'not_supported' }>>;
}

/** Durable Objects point-in-time restore (ADR 0004 A15). Workers host only; removed by N7-01. */
export interface PitrPort {
  restore(atMs: number): Promise<PitrResult>;
}

export interface Host {
  /** The one synchronous SQLite facade (migrated before IndexCore starts). */
  db: Db;
  /** The core lane's alarm (TIMER_NAMES). */
  alarm: AlarmStorage;
  /** The extension lane's alarm (EXTENSION_TIMER_NAMES); a different object from `alarm`. */
  extensionAlarm: AlarmStorage;
  connectJetstream: ConnectJetstream;
  transport: Transport;
  /** Absent: adminBackup answers `not_supported` and changes nothing. */
  backup?: BackupPort;
  /** Absent: adminPitr rejects with NotSupportedError. Workers host only, until N7-01. */
  pitr?: PitrPort;
  log: Logger;
  clock: Clock;
  random: Random;
}

/** Optional overrides of what IndexCore otherwise derives from the Host. */
export interface IndexCoreOptions {
  /** Default: `cachedIdentityResolver(host.db, {transport, clock})`. */
  identity?: IdentityResolver;
  /** Measures the pulse's 20 s bound; default setTimeout (removed with pulse by N7-01). */
  pulseTimer?: PulseTimer;
}

/** What an extension sees of the core. */
export interface ExtensionContext {
  /** The core's module dependencies (the same db, clock, transport, identity, config and log). */
  readonly deps: ModuleDeps;
  /**
   * Upserts extension timer `name` (as `schedule` in timers.ts: keeps an
   * earlier due time unless `force`) and re-arms the extension alarm. Returns
   * the stored due time, or null without writing anything when no extension
   * registered a handler for `name`.
   */
  schedule(name: ExtensionTimerName, dueAtMs: number, options?: ScheduleOptions): number | null;
  /** Makes `name` due now and re-arms the extension alarm (the outbox kick). Null when `name` has no handler. */
  kick(name: ExtensionTimerName): number | null;
}

/** An extension timer's handler. It reschedules itself through `ctx.schedule`; one that does not is one-shot. */
export type ExtensionTimerHandler = (now: number, ctx: ExtensionContext) => Promise<void>;

export interface CoreExtension {
  /** For logs and errors only. */
  readonly name: string;
  /** Handlers by extension timer name; two extensions may not register the same name. */
  readonly timers?: Partial<Record<ExtensionTimerName, ExtensionTimerHandler>>;
  /**
   * Runs in `IndexCore.start()` after the core lane is armed, before the
   * extension lane is armed; typically schedules the extension's timers.
   */
  start?(ctx: ExtensionContext, now: number): void;
}
