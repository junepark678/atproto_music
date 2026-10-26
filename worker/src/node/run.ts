// The Node process (ADR 0005 §3.9, §3.10, §3.11, §14.5; N3-07).
//
// `run(opts)` is everything the process does, and importing this module
// starts nothing: worker/src/node/main.ts (the production entry, the only
// module with a top-level effect) calls it with the process values, and the
// e2e entry (worker/test/e2e/node-entry.ts, N6-01) calls it with the fixture
// transport and the test-only config options. Arguments:
//
//   --version       print the git sha recorded at build time and exit 0
//   --check-config  validate the environment, config, secrets and the static
//                   files, then exit 0 (78 on any error); touches no database
//   --init          allow creating ATMUSIC_DB when it does not exist (once,
//                   from scripts/install-local.sh); the server then starts
//
// Startup order (ADR §3.10):
//  1. Refuse a forbidden runtime variable (NODE_OPTIONS, proxies, ...), then
//     parse the config and the secrets, then load ATMUSIC_ASSETS_DIR, which
//     must hold index.html. Any error exits 78 (EX_CONFIG) naming the
//     variable, before the database is opened.
//  2. Replace globalThis.fetch with the stub that rejects with TransportError
//     `unpinned_fetch` (§3.5 rule 1), so an outbound consumer that was not
//     handed the pinned transport fails loudly instead of bypassing the SSRF
//     policy. Open the database with locking_mode=EXCLUSIVE and the busy
//     timeout (production 5000 ms): another instance holding it exits 75
//     `database_locked` after the busy timeout, whatever admin socket path it
//     was given; a missing file exits 78 naming ATMUSIC_DB unless --init was
//     given, and nothing is created then.
//  3. Bind the admin socket (node/admin-socket.ts); a stale socket file is
//     replaced (the lock proves no other instance owns it).
//  4. A pending migration: under EXTEND_TIMEOUT_USEC (sent at once and every
//     20 s, node/systemd.ts), a pre-migration backup of a database that holds
//     a schema (node/backup.ts; a refused free-space check exits 78 naming
//     ATMUSIC_MIN_FREE_BYTES rather than migrating without a backup), then
//     the migration, then the backup's backup_runs row.
//  5–6. compose (node/compose.ts) with the production feature list
//     (node/features.ts, N4-01, which includes the daily `backup` timer), the
//     production transport (pinned, §3.5) handed to every outbound wire, the
//     identity resolver of the `identity` wire and the ws Jetstream connector
//     over the pinned lookup. Then the sign-in policy is reconciled once
//     (reconcileSignInPolicy via ProductionFeatures.startup, B20): a DID the
//     policy no longer admits loses its OAuth session, web sessions and
//     credentials before anything listens, and before any extension timer
//     (outbox, forward, import, keepalive, sweep, backup) runs: compose has
//     armed them, but each waits for the startup reconcile to finish, so a
//     second refused DID cannot write or forward while the first one's
//     upstream revoke is awaited. A reconcile that throws stops the startup
//     (exit 1) with every extension timer still closed.
//  7. Listen: an inherited LISTEN_FDS socket (systemd socket activation) wins
//     over ATMUSIC_LISTEN, which wins over 127.2.0.1:8888.
//  8. READY=1, then the watchdog (WATCHDOG=1 every WatchdogSec/3 while the
//     probes pass).
//
// SIGTERM (and SIGINT) runs the drain of node/shutdown.ts and resolves run()
// with 0. Exit codes: 0 after SIGTERM and for --version/--check-config, 78
// configuration, 75 database locked, 1 otherwise. `exit` is called once with
// the code run() resolves with.
//
// Everything a test needs to drive the process in-process is an injected
// option: the clock, randomness, timers, busy timeout and drain window, the
// signal source, the notify spawner, the statfs probe, the transport and the
// Jetstream connector. None of them relaxes a rule: the URL policy, the
// pinned transport and every verification stay on whatever is passed.

import { closeSync, constants, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Transport } from '@atmusic/atproto/transport';
import { type Clock, cryptoRandom, type Random, systemClock } from '@atmusic/core/deps';
import { createLogger, errorName } from '../app/index-core';
import { FileRevocations, revocationLogPath } from '../app/revocations';
import { ConfigError, type ConfigIssue } from '../config';
import type { Logger } from '../do/contracts';
import type { ConnectJetstream } from '../do/ingest/jetstream-socket';
import { closeSocket } from '../do/ingest/jetstream-socket';
import { migrate } from '../do/migrate';
import { socketAdminHandler } from '../http/admin';
import { type AdminSocket, AdminSocketError, bindAdminSocket, hostStatus, pruneKidSessions } from './admin-socket';
import { type HostTimers, nodeTimers } from './alarm';
import { createBackups } from './backup';
import { type ComposedApp, compose, type Feature, readSchemaState } from './compose';
import { checkRuntimeEnv, type NodeConfig, type NodeEnv, type ParseNodeConfigOptions, parseNodeConfig } from './config';
import { diskLowProbe, nodeStatfs, type StatfsFn } from './disk';
import {
  jetstreamConnector,
  type OutboundTransports,
  outboundIdentity,
  type ProductionFeatures,
  productionFeatures,
  sharedOutbound,
} from './features';
import {
  type BoundAddress,
  type BridgeOptions,
  type BridgeServer,
  createServer,
  ListenConfigError,
  type ListenTarget,
  socketActivation,
} from './http-bridge';
import { DEFAULT_PINNED_CAPS, pinnedTransport, unpinnedFetchStub } from './pinned-transport';
import { type LoadSecretsDeps, loadSecrets, type Secrets } from './secrets';
import { createShutdown, trackRequests } from './shutdown';
import { DatabaseLockedError, DatabaseMissingError, openSqliteDb, type SqliteDb } from './sqlite-db';
import { loadStaticAssets, type StaticAssets } from './static-assets';
import { createNotifier, keepExtending, type NotifySpawner, startWatchdog, watchdogIntervalMs } from './systemd';

/** The git sha esbuild embeds at build time (scripts/build-server.ts); absent when run from source. */
declare const __ATMUSIC_GIT_SHA__: string | undefined;

export const BUILD_GIT_SHA: string = typeof __ATMUSIC_GIT_SHA__ === 'string' ? __ATMUSIC_GIT_SHA__ : 'unknown';

export type ExitCode = 0 | 1 | 75 | 78;
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
/** EX_TEMPFAIL: another instance holds the database (never restarted, §14.1). */
export const EXIT_DATABASE_LOCKED = 75;
/** EX_CONFIG: a configuration error (never restarted, §14.1). */
export const EXIT_CONFIG = 78;

export const DB_FILE_MODE = 0o600;
export const STATE_DIR_MODE = 0o700;

/** Where the signals come from (process by default). */
export interface SignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

/** What a started process exposes to `onReady` (observation only). */
export interface RunningServer {
  readonly address: BoundAddress;
  readonly config: NodeConfig;
  readonly app: ComposedApp;
  readonly db: SqliteDb;
  readonly adminSocket: string;
  /** The production feature list run() composed (node/features.ts). */
  readonly features: ProductionFeatures;
  /** The drain run() starts on SIGTERM (for the e2e entry's own shutdown). */
  shutdown(signal?: string): Promise<void>;
}

export interface RunOptions {
  /** process.argv: [node, script, ...arguments]. */
  argv: readonly string[];
  env: NodeEnv;
  exit?: (code: ExitCode) => void;
  clock?: Clock;
  random?: Random;
  /** Default config.busyTimeoutMs (production 5000). */
  busyTimeoutMs?: number;
  /** Default config.drainMs (production 25000). */
  drainMs?: number;
  /** For LISTEN_PID and WATCHDOG_PID; default process.pid. */
  pid?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Default: the redacting JSON-line logger on the console (journald). */
  log?: Logger;
  /** Test entries only (the e2e entry, N6-01); main.ts never passes it. */
  configOptions?: ParseNodeConfigOptions;
  secretsDeps?: LoadSecretsDeps;
  /** Default: the pinned transport (ADR §3.5). */
  transport?: Transport;
  /**
   * Where each outbound wire takes its transport (node/features.ts); default
   * `transport` for every wire. The features test hands a spy per wire.
   */
  outbound?: OutboundTransports;
  /** Default: the ws connector over JETSTREAM_URLS through the `jetstream` wire's pinned lookup (ADR §3.4, §3.5). */
  connectJetstream?: ConnectJetstream;
  /** Composed after the production list (node/features.ts), which is always composed. */
  features?: readonly Feature[];
  timers?: HostTimers;
  /** Monotonic ms for the watchdog's loop-lag probe; default performance.now. */
  monotonicNow?: () => number;
  /** Default: systemd-notify on PATH, used only with NOTIFY_SOCKET. */
  notifySpawner?: NotifySpawner;
  statfs?: StatfsFn;
  signals?: SignalSource;
  /** Default createServer (node/http-bridge.ts). */
  serverFactory?: (options: BridgeOptions) => BridgeServer;
  onReady?: (server: RunningServer) => void;
}

interface Args {
  version: boolean;
  checkConfig: boolean;
  init: boolean;
}

function parseArgs(args: readonly string[]): Args | { unknown: string } {
  const out: Args = { version: false, checkConfig: false, init: false };
  for (const arg of args) {
    if (arg === '--version') out.version = true;
    else if (arg === '--check-config') out.checkConfig = true;
    else if (arg === '--init') out.init = true;
    else return { unknown: arg };
  }
  return out;
}

/** First entry of a systemd directory variable (colon-separated). */
function firstDir(value: string | undefined): string | null {
  const first = (value ?? '').split(':')[0] ?? '';
  return first === '' ? null : first;
}

/** The secret strings the logger must never print. */
function redactions(secrets: Secrets): string[] {
  const out: string[] = [];
  const cursor = Buffer.from(secrets.cursorKey);
  out.push(cursor.toString('base64'), cursor.toString('hex'), cursor.toString('base64url'));
  for (const { key } of secrets.encryptionKeys) {
    const b = Buffer.from(key);
    out.push(b.toString('base64'), b.toString('hex'), b.toString('base64url'));
  }
  for (const jwk of secrets.oauthSigningKeys) out.push(jwk.d);
  if (secrets.lastfm !== null) out.push(secrets.lastfm.sharedSecret);
  return out;
}

function describeIssues(issues: readonly ConfigIssue[]): string {
  return issues.map((i) => `${i.field}: ${i.message}`).join('; ');
}

export async function run(opts: RunOptions): Promise<ExitCode> {
  const stdout = opts.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = opts.stderr ?? ((text: string) => void process.stderr.write(text));
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? cryptoRandom;
  const timers = opts.timers ?? nodeTimers;
  const pid = opts.pid ?? process.pid;
  const env = opts.env;
  const signals: SignalSource = opts.signals ?? process;
  // A SIGTERM during startup is remembered and drained once the server is up
  // (instead of Node's default of dying mid-migration).
  let earlySignal = false;
  const onEarlySignal = (): void => {
    earlySignal = true;
  };
  let exited = false;
  const finish = (code: ExitCode): ExitCode => {
    signals.off('SIGTERM', onEarlySignal);
    signals.off('SIGINT', onEarlySignal);
    if (!exited) {
      exited = true;
      opts.exit?.(code);
    }
    return code;
  };
  let log: Logger = opts.log ?? createLogger([]);
  const configFailure = (issues: readonly ConfigIssue[]): ExitCode => {
    log.log('error', 'run.config_error', { fields: issues.map((i) => i.field) });
    stderr(`atmusic: configuration error: ${describeIssues(issues)}\n`);
    return finish(EXIT_CONFIG);
  };

  const args = parseArgs(opts.argv.slice(2));
  if ('unknown' in args) {
    return configFailure([{ field: 'argv', message: `unknown argument ${JSON.stringify(args.unknown)}` }]);
  }
  if (args.version) {
    stdout(`${BUILD_GIT_SHA}\n`);
    return finish(EXIT_OK);
  }

  // 1. Environment, config, secrets, static files.
  const forbidden = checkRuntimeEnv(env);
  if (forbidden !== null) return configFailure(forbidden.issues);
  let config: NodeConfig;
  let secrets: Secrets;
  try {
    config = parseNodeConfig(env, opts.configOptions ?? {});
    secrets = loadSecrets(env, opts.secretsDeps ?? {});
  } catch (error) {
    if (error instanceof ConfigError) return configFailure(error.issues);
    log.log('error', 'run.config_failed', { error: errorName(error) });
    stderr(`atmusic: configuration could not be read (${errorName(error)})\n`);
    return finish(EXIT_CONFIG);
  }
  if (opts.log === undefined) log = createLogger(redactions(secrets));
  let assets: StaticAssets;
  try {
    assets = loadStaticAssets(config.assetsDir, { random });
  } catch (error) {
    return configFailure([
      { field: 'ATMUSIC_ASSETS_DIR', message: `cannot be read (${errorName(error)}); build the web client first` },
    ]);
  }
  if (!assets.has('/index.html')) {
    return configFailure([
      { field: 'ATMUSIC_ASSETS_DIR', message: 'has no index.html; run `npm run build:web` (web/dist)' },
    ]);
  }
  if (args.checkConfig) {
    stdout('atmusic: configuration ok\n');
    return finish(EXIT_OK);
  }

  // 2. The global fetch stub, then the database.
  signals.on('SIGTERM', onEarlySignal);
  signals.on('SIGINT', onEarlySignal);
  globalThis.fetch = unpinnedFetchStub as typeof fetch;
  const busyTimeoutMs = opts.busyTimeoutMs ?? config.busyTimeoutMs;
  const drainMs = opts.drainMs ?? config.drainMs;
  const statfs = opts.statfs ?? nodeStatfs;
  const notifier = createNotifier({
    env,
    log,
    ...(opts.notifySpawner === undefined ? {} : { spawn: opts.notifySpawner }),
  });

  const cleanups: Array<() => void | Promise<void>> = [];
  const cleanup = async (): Promise<void> => {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (error) {
        log.log('error', 'run.cleanup_failed', { error: errorName(error) });
      }
    }
  };
  const fail = async (code: ExitCode, event: string, message: string, fields: Record<string, unknown> = {}) => {
    log.log('error', event, fields);
    stderr(`atmusic: ${message}\n`);
    await cleanup();
    return finish(code);
  };

  let db: SqliteDb;
  try {
    db = openDatabase(config.dbPath, busyTimeoutMs, args.init, log);
  } catch (error) {
    if (error instanceof DatabaseLockedError) {
      return fail(EXIT_DATABASE_LOCKED, 'run.database_locked', 'database_locked: another instance holds ATMUSIC_DB', {
        path: config.dbPath,
      });
    }
    if (error instanceof DatabaseMissingError) {
      return configFailure([
        { field: 'ATMUSIC_DB', message: `${config.dbPath} does not exist; run once with --init to create it` },
      ]);
    }
    return fail(EXIT_FAILURE, 'run.database_open_failed', `ATMUSIC_DB cannot be opened (${errorName(error)})`, {
      error: errorName(error),
    });
  }
  const openDb = db;
  cleanups.push(() => openDb.close());

  // 3. The admin socket.
  let adminSocket: AdminSocket;
  try {
    adminSocket = await bindAdminSocket({ path: config.adminSocket, log, random });
  } catch (error) {
    if (error instanceof AdminSocketError) {
      await cleanup();
      return configFailure([{ field: 'ATMUSIC_ADMIN_SOCKET', message: error.message }]);
    }
    return fail(EXIT_FAILURE, 'run.admin_socket_failed', `the admin socket failed (${errorName(error)})`);
  }
  const socket = adminSocket;
  cleanups.push(() => socket.close());

  // 4. Journal, backups, the pre-migration backup and the migration.
  const stateDir = firstDir(env.STATE_DIRECTORY) ?? dirname(config.dbPath);
  let revocations: FileRevocations;
  try {
    revocations = new FileRevocations({ path: revocationLogPath(stateDir), clock });
  } catch (error) {
    return fail(EXIT_FAILURE, 'run.journal_failed', `the revocation journal cannot be opened (${errorName(error)})`);
  }
  const journal = revocations;
  cleanups.push(() => journal.close());
  const backups = createBackups({
    db,
    dir: config.backupDir,
    clock,
    log,
    minFreeBytes: config.minFreeBytes,
    statfs,
    revocations,
  });
  cleanups.push(() => backups.idle());

  const schema = readSchemaState(db);
  if (schema.status === 'pending') {
    const extending = keepExtending(notifier, { timers });
    try {
      let preMigration: Awaited<ReturnType<typeof backups.run>> | null = null;
      if (schema.version > 0) {
        preMigration = await backups.run('pre_migration', { record: false });
        if (preMigration.status !== 'ok') {
          extending.stop();
          if (preMigration.error === 'low_disk') {
            await cleanup();
            return configFailure([
              {
                field: 'ATMUSIC_MIN_FREE_BYTES',
                message: 'the pre-migration backup needs the database size plus this floor free; not migrating',
              },
            ]);
          }
          return fail(EXIT_FAILURE, 'run.pre_migration_backup_failed', 'the pre-migration backup failed', {
            error: preMigration.error,
          });
        }
      }
      const result = migrate(db);
      log.log('info', 'run.migrated', { from: schema.version, status: result.status, version: result.version });
      if (preMigration !== null) backups.record(preMigration);
    } catch (error) {
      extending.stop();
      return fail(EXIT_FAILURE, 'run.migration_failed', `the migration failed (${errorName(error)})`, {
        error: errorName(error),
      });
    }
    extending.stop();
  }

  // 5–6. Composition, then the sign-in policy reconcile.
  const transport = opts.transport ?? pinnedTransport({ caps: DEFAULT_PINNED_CAPS });
  const outbound = opts.outbound ?? sharedOutbound(transport);
  const connectJetstream =
    opts.connectJetstream ?? jetstreamConnector(config.app.jetstreamUrls, outbound.transportFor('jetstream'));
  const diskLow = diskLowProbe(dirname(config.dbPath), config.minFreeBytes, statfs);
  let app: ComposedApp;
  let production: ProductionFeatures;
  try {
    production = await productionFeatures({
      config,
      secrets,
      clock,
      revocations,
      outbound,
      diskLow,
      backups,
    });
    app = await compose(config, secrets, {
      db,
      transport: outbound.transportFor('core'),
      identity: outboundIdentity(db, outbound, clock),
      connectJetstream,
      features: [...production.features, ...(opts.features ?? [])],
      clock,
      random,
      log,
      timers,
      assets,
      backup: backups,
      diskLow,
    });
  } catch (error) {
    return fail(EXIT_FAILURE, 'run.compose_failed', `startup failed (${errorName(error)})`, {
      error: errorName(error),
    });
  }
  const composed = app;
  const features = production;
  cleanups.push(() => composed.stop());
  if (composed.schema.status === 'ready') {
    try {
      // The extension timers compose armed wait for this (node/features.ts `startup`).
      const report = await features.startup();
      log.log('info', 'run.signin_reconciled', {
        policy: config.signinPolicy,
        signedOut: report.signedOut.length,
      });
    } catch (error) {
      return fail(EXIT_FAILURE, 'run.reconcile_failed', `the sign-in policy reconcile failed (${errorName(error)})`, {
        error: errorName(error),
      });
    }
  }
  socket.setHandler(
    socketAdminHandler({
      index: composed.core,
      hostStatus: () =>
        hostStatus({
          db: openDb,
          clock,
          backups,
          uploadDir: config.uploadDir,
          stateDir: dirname(config.dbPath),
          minFreeBytes: config.minFreeBytes,
          statfs,
          warnings: async () => (await composed.ready()).warnings,
        }),
      pruneKid: (kid) =>
        pruneKidSessions(
          { db: openDb, clock, signingKids: secrets.oauthSigningKeys.map((k) => k.kid), revocations: journal, log },
          kid,
        ),
      random,
    }),
  );

  // 7. Listen.
  let target: ListenTarget;
  try {
    target = socketActivation(env, pid) ?? { host: config.listen.host, port: config.listen.port };
  } catch (error) {
    await cleanup();
    if (error instanceof ListenConfigError) return configFailure([{ field: error.variable, message: error.message }]);
    throw error;
  }
  const server = (opts.serverFactory ?? createServer)({
    publicOrigin: config.publicOrigin,
    listen: target,
    handler: composed.handler,
    random,
  });
  const tracker = trackRequests(server.server);
  let address: BoundAddress;
  try {
    address = await server.start();
  } catch (error) {
    await server.close().catch(() => undefined);
    if (error instanceof ListenConfigError) {
      await cleanup();
      return configFailure([{ field: error.variable, message: error.message }]);
    }
    return fail(EXIT_FAILURE, 'run.listen_failed', `cannot listen (${errorName(error)})`, {
      error: errorName(error),
    });
  }

  // 8. READY=1, the watchdog, the signals.
  await notifier.ready();
  const watchdogMs = watchdogIntervalMs(env, pid);
  const watchdog =
    watchdogMs === null
      ? null
      : startWatchdog({
          notifier,
          intervalMs: watchdogMs,
          timers,
          log,
          ...(opts.monotonicNow === undefined ? {} : { now: opts.monotonicNow }),
          dbProbe: () => openDb.one<{ ok: number }>('SELECT 1 AS ok')?.ok === 1,
        });
  log.log('info', 'run.ready', {
    listen: address.authority,
    socketActivated: 'fd' in target,
    schema: composed.schema.status,
    watchdogMs,
  });

  return new Promise<ExitCode>((resolve) => {
    const shutdown = createShutdown({
      server,
      tracker,
      notifier,
      drainMs,
      timers,
      log,
      exit: (code) => {
        signals.off('SIGTERM', onSignal);
        signals.off('SIGINT', onSignal);
        resolve(finish(code));
      },
      closeJetstream: () => {
        closeSocket(composed.core.deps, clock.nowMs());
      },
      stopTimers: async () => {
        composed.stop();
        await composed.scheduler.whenIdle();
        await backups.idle();
      },
      closeServices: async () => {
        watchdog?.stop();
        await socket.close();
        journal.close();
        await closeTransport(transport);
      },
      closeDb: () => openDb.close(),
    });
    const onSignal = (): void => {
      void shutdown.shutdown('SIGTERM');
    };
    signals.on('SIGTERM', onSignal);
    signals.on('SIGINT', onSignal);
    signals.off('SIGTERM', onEarlySignal);
    signals.off('SIGINT', onEarlySignal);
    opts.onReady?.({
      address,
      config,
      app: composed,
      db: openDb,
      adminSocket: socket.path,
      features,
      shutdown: (signal) => shutdown.shutdown(signal),
    });
    if (earlySignal) void shutdown.shutdown('SIGTERM');
  });
}

/** Closes the transport's connection pool when it has one (the pinned transport). */
async function closeTransport(transport: Transport): Promise<void> {
  const closable = transport as Transport & { close?: () => Promise<void> };
  if (typeof closable.close === 'function') await closable.close();
}

/**
 * Opens ATMUSIC_DB. Without `init` a missing file throws DatabaseMissingError
 * and nothing is created; with it the directory (0700) and an empty 0600 file
 * are created first.
 */
function openDatabase(path: string, busyTimeoutMs: number, init: boolean, log: Logger): SqliteDb {
  try {
    return openSqliteDb(path, { busyTimeoutMs, log });
  } catch (error) {
    if (!(error instanceof DatabaseMissingError) || !init) throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: STATE_DIR_MODE });
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, DB_FILE_MODE));
    log.log('info', 'run.database_created', { path });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return openSqliteDb(path, { busyTimeoutMs, log });
}
