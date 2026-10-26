// The Node harness of the de-shimmed worker-modules suites (ADR 0005 §15.1
// step 2, N4-04). TEST-ONLY. It replaces worker/test/harness/local-index.ts
// and the `cloudflare:test` helpers for those suites:
//
//   runInDurableObject(stub, fn)  ->  withIndex((db, ix) => ...)
//   runDurableObjectAlarm(stub)   ->  runAlarmNow(core)          (IndexCore.runAlarmNow)
//   evictDurableObject(stub)      ->  ix.reopen() / reopen(db)   (close and reopen the same file)
//   env (harness vars)            ->  HARNESS_ENV, harnessConfig()
//   makeLocalIndex(state, impl)   ->  nodeIndex(db, impl)        (the module runs on the test's database)
//
// - `withIndex(fn)` runs `fn` over a fresh temporary-file database migrated
//   by node-db (N1-01: the production `openSqliteDb` with the test busy
//   timeout, then `migrate`). The directory, the database and its WAL are
//   removed afterwards, also when `fn` throws.
// - `ix.reopen()` closes the handle and opens the same file again with
//   `migrate` re-run, as a process restart does (TESTING.md: "restart reopens
//   same storage"). The old handle is closed: using it throws.
// - `indexCore(db)` builds the production IndexCore over the database with a
//   deterministic Host: two NodeAlarms (worker/src/node/alarm.ts) on manual
//   timers that never fire on their own, the frozen clock, a seeded Random, a
//   transport and a Jetstream connector that refuse everything, and a
//   recording logger. `runAlarmNow(core)` runs its core lane now.
// - `schemaAll(db, sql, ...)` answers a schema-introspection SELECT over one
//   of SQLite's schema pragma functions (`pragma_table_info`, ...), which the
//   production authorizer denies like every PRAGMA, from a schema-only
//   replica: an in-memory database holding exactly this database's
//   sqlite_master DDL and no rows. Nothing in the production adapter changes.
// - `fileIndexes()` is this test file's set of named databases (vitest
//   evaluates this module once per test file), in a temporary directory of
//   its own: the Node form of "one Durable Object per name, isolated per test
//   file" that the harness isolation tests check. `close()` removes it.
//
// Nothing here reaches a network: every outbound request and Jetstream
// connect is refused and recorded.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import type { Transport } from '@atmusic/atproto/transport';
import type { Clock, Random } from '@atmusic/core/deps';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import type { CoreExtension, Host } from '../../../src/app/host';
import { IndexCore } from '../../../src/app/index-core';
import { type AppConfig, parseConfig } from '../../../src/config';
import type { IndexRpc, Logger, LogLevel, ModuleDeps } from '../../../src/do/contracts';
import type { Db, SqlParam } from '../../../src/do/db';
import { type ConnectJetstream, JetstreamConnectError } from '../../../src/do/ingest/jetstream-socket';
import { type MigrateResult, migrate } from '../../../src/do/migrate';
import type { RunReport } from '../../../src/do/timers';
import { type HostTimers, NodeAlarm, type TimerHandle } from '../../../src/node/alarm';
import { openSqliteDb, type SqliteDb } from '../../../src/node/sqlite-db';
import {
  makeTempDir,
  type ReopenOptions,
  reopen,
  TEST_BUSY_TIMEOUT_MS,
  type TempDbContext,
  type WithMigratedDbOptions,
  withMigratedDb,
} from './node-db';

export { type ReopenOptions, reopen, TEST_BUSY_TIMEOUT_MS };

// ---------------------------------------------------------------------------
// Harness configuration

/**
 * The harness vars the shimmed suites read from `env` (the `vars` of
 * worker/test/harness/wrangler.harness.jsonc): the public test origin, the
 * fixture lexicon prefix, ingestion off and the reserved test hosts. The
 * CURSOR_KEY is test-only key material, never a production secret.
 */
export const HARNESS_ENV = Object.freeze({
  PUBLIC_ORIGIN: 'https://music.example.test',
  LEXICON_PREFIX: 'com.example.atmusic',
  NAMESPACE_OWNERSHIP_REF: '',
  INGEST_MODE: 'off',
  JETSTREAM_URLS: 'wss://jetstream.example.test',
  JETSTREAM_LOOKBACK_HOURS: '24',
  RELAY_URL: 'https://relay.example.test',
  PLAN: 'paid',
  DO_LOCATION_HINT: '',
  CURSOR_KEY: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
});

/** The AppConfig the harness vars parse to (fixture prefix allowed), with `overrides` applied to the vars. */
export function harnessConfig(overrides: Readonly<Record<string, string>> = {}): AppConfig {
  const vars = { ...HARNESS_ENV, ...overrides } as unknown as Parameters<typeof parseConfig>[0];
  return parseConfig(vars, { allowFixturePrefix: true });
}

// ---------------------------------------------------------------------------
// Deterministic module dependencies

export interface ManualTimer extends TimerHandle {
  readonly kind: 'timeout' | 'interval';
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
}

export interface ManualTimers extends HostTimers {
  /** Every timer ever created, cleared ones included. */
  readonly all: readonly ManualTimer[];
  /** Timers not yet cleared. */
  pending(): ManualTimer[];
}

/** HostTimers that record every timer and never fire one on their own. */
export function manualTimers(): ManualTimers {
  const all: ManualTimer[] = [];
  const create = (kind: ManualTimer['kind'], callback: () => void, delayMs: number): ManualTimer => {
    const timer: ManualTimer = { kind, callback, delayMs, cleared: false, unref: () => timer };
    all.push(timer);
    return timer;
  };
  const clear = (handle: TimerHandle) => {
    (handle as ManualTimer).cleared = true;
  };
  return {
    all,
    pending: () => all.filter((t) => !t.cleared),
    setTimeout: (callback, delayMs) => create('timeout', callback, delayMs),
    clearTimeout: clear,
    setInterval: (callback, intervalMs) => create('interval', callback, intervalMs),
    clearInterval: clear,
  };
}

export interface LogEntry {
  level: LogLevel;
  event: string;
  fields?: Record<string, unknown>;
}

/** A Logger that keeps every line in `entries`. */
export function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    log(level, event, fields) {
      entries.push(fields === undefined ? { level, event } : { level, event, fields });
    },
  };
}

/** A transport that refuses every request (no network in tests) and records its URL. */
export function refusingTransport(): Transport & { attempts: string[] } {
  const attempts: string[] = [];
  const transport = (async (req: Request) => {
    attempts.push(req.url);
    throw new Error(`no network in tests: ${req.method} ${req.url}`);
  }) as unknown as Transport & { attempts: string[] };
  transport.attempts = attempts;
  return transport;
}

/** A Jetstream connector that refuses every connect, like a failed DNS lookup, and records its URL. */
export function refusingJetstream(): ConnectJetstream & { attempts: string[] } {
  const attempts: string[] = [];
  const connect = (async (url: string) => {
    attempts.push(url);
    throw new JetstreamConnectError(null, null, `no Jetstream in tests: ${url}`);
  }) as unknown as ConnectJetstream & { attempts: string[] };
  connect.attempts = attempts;
  return connect;
}

/** An identity resolver that refuses every lookup. */
export function refusingIdentity(): IdentityResolver {
  return {
    resolveDid: async (did) => {
      throw new Error(`identity resolution not wired in this test: ${did}`);
    },
    resolveHandle: async (handle) => {
      throw new Error(`handle resolution not wired in this test: ${handle}`);
    },
  };
}

export interface ModuleDepsOptions {
  clock?: Clock;
  random?: Random;
  transport?: Transport;
  identity?: IdentityResolver;
  config?: AppConfig;
  log?: Logger;
}

/** ModuleDeps over `db`: frozen clock, seeded Random, refusing transport and identity, harness config. */
export function moduleDeps(db: Db, o: ModuleDepsOptions = {}): ModuleDeps {
  return {
    db,
    clock: o.clock ?? fixedClock(),
    random: o.random ?? seededRandom(1),
    transport: o.transport ?? refusingTransport(),
    identity: o.identity ?? refusingIdentity(),
    config: o.config ?? harnessConfig(),
    log: o.log ?? recordingLogger(),
  };
}

// ---------------------------------------------------------------------------
// withIndex

export interface TestIndex {
  /** The current handle (the latest one after `reopen`). */
  readonly db: SqliteDb;
  /** The temporary directory, removed after `withIndex`. */
  readonly dir: string;
  /** The database file. */
  readonly path: string;
  /** The migration result of the first open. */
  readonly migration: MigrateResult;
  /** Times the file was opened (1, plus one per reopen). */
  readonly opens: number;
  /** Closes the current handle and opens the same file again (migrate re-run by default). */
  reopen(options?: ReopenOptions): SqliteDb;
}

export type WithIndexOptions = WithMigratedDbOptions;

/**
 * Runs `fn` over a migrated database in a new temporary file (node-db). The
 * handle (or the latest one `reopen` returned) is closed and the directory
 * removed afterwards, also when `fn` throws.
 */
export function withIndex<T>(
  fn: (db: SqliteDb, ix: TestIndex) => T | Promise<T>,
  options: WithIndexOptions = {},
): Promise<T> {
  return withMigratedDb((db, ctx: TempDbContext) => {
    let opens = 1;
    const ix: TestIndex = {
      get db() {
        return ctx.current;
      },
      dir: ctx.dir,
      path: ctx.path,
      migration: ctx.migration,
      get opens() {
        return opens;
      },
      reopen(reopenOptions?: ReopenOptions) {
        const next = reopen(ctx.current, reopenOptions);
        opens++;
        return next;
      },
    };
    return fn(db, ix);
  }, options);
}

/**
 * Runs `fn` over a fresh, empty database file that no migration has touched
 * (no ledger table either): the Node form of a wiped Durable Object storage.
 * Removed afterwards like withIndex.
 */
export async function withEmptyDb<T>(fn: (db: SqliteDb, path: string) => T | Promise<T>): Promise<T> {
  const dir = makeTempDir('atmusic-empty-db-');
  const path = join(dir, 'atmusic.db');
  let db: SqliteDb | null = null;
  try {
    db = openSqliteDb(path, { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS, create: true });
    return await fn(db, path);
  } finally {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// IndexCore on the test database

export interface TestCore {
  core: IndexCore;
  host: Host;
  clock: FixedClock;
  /** The timers the two NodeAlarms arm; they never fire on their own. */
  timers: ManualTimers;
  /** The core lane's alarm (calls `core.alarm()` when woken). */
  alarm: NodeAlarm;
  /** The extension lane's alarm (calls `core.extensionAlarm()` when woken). */
  extensionAlarm: NodeAlarm;
  log: Logger & { entries: LogEntry[] };
  transport: Transport & { attempts: string[] };
  jetstream: ConnectJetstream & { attempts: string[] };
}

export interface TestCoreOptions {
  config?: AppConfig;
  extensions?: readonly CoreExtension[];
  identity?: IdentityResolver;
  clock?: FixedClock;
  random?: Random;
  transport?: Transport & { attempts: string[] };
  connectJetstream?: ConnectJetstream & { attempts: string[] };
  /** Record `migrate(db)` as the core's migration (default true); false leaves the core not ready. */
  markMigrated?: boolean;
}

/** The production IndexCore over `db` with the deterministic Host described in the file comment; not started. */
export function indexCore(db: SqliteDb, o: TestCoreOptions = {}): TestCore {
  const clock = o.clock ?? fixedClock();
  const timers = manualTimers();
  const log = recordingLogger();
  const transport = o.transport ?? refusingTransport();
  const jetstream = o.connectJetstream ?? refusingJetstream();
  let core: IndexCore | null = null;
  const alarm = new NodeAlarm({ name: 'core', clock, timers, log, onAlarm: () => core?.alarm() });
  const extensionAlarm = new NodeAlarm({
    name: 'extension',
    clock,
    timers,
    log,
    onAlarm: () => core?.extensionAlarm(),
  });
  const host: Host = {
    db,
    alarm,
    extensionAlarm,
    connectJetstream: jetstream,
    transport,
    log,
    clock,
    random: o.random ?? seededRandom(7),
  };
  core = new IndexCore(
    o.config ?? harnessConfig(),
    host,
    o.extensions ?? [],
    o.identity === undefined ? {} : { identity: o.identity },
  );
  if (o.markMigrated ?? true) core.markMigrated(migrate(db));
  return { core, host, clock, timers, alarm, extensionAlarm, log, transport, jetstream };
}

export interface TestAlarmOptions {
  clock?: Clock;
  /** What a fired alarm runs; by default it throws, as a Durable Object without an alarm() handler did. */
  onAlarm?: () => void | Promise<void>;
  log?: Logger;
}

/**
 * A NodeAlarm (the Node host's AlarmStorage, worker/src/node/alarm.ts) on
 * manual timers that never fire on their own, for suites that drive the
 * timer multiplexer directly. `nextDueMs()` is what DO `getAlarm()` was.
 */
export function testAlarm(o: TestAlarmOptions = {}): NodeAlarm & { readonly timers: ManualTimers } {
  const timers = manualTimers();
  const alarm = new NodeAlarm({
    name: 'test',
    clock: o.clock ?? fixedClock(),
    timers,
    log: o.log ?? recordingLogger(),
    onAlarm:
      o.onAlarm ??
      (() => {
        throw new Error('this test alarm has no alarm() handler');
      }),
  });
  return Object.assign(alarm, { timers });
}

/** Runs the core lane now (the Node replacement of runDurableObjectAlarm): `IndexCore.runAlarmNow()`. */
export function runAlarmNow(core: Pick<IndexCore, 'runAlarmNow'>): Promise<RunReport | null> {
  return core.runAlarmNow();
}

// ---------------------------------------------------------------------------
// nodeIndex: the IndexRpc adapter of makeLocalIndex, on the test's database

/** A DO module function: `(m: ModuleDeps, ...rpcArgs)`, sync or async. */
export type ModuleImpl = {
  [K in keyof IndexRpc]?: (
    m: ModuleDeps,
    ...args: Parameters<IndexRpc[K]>
  ) => Awaited<ReturnType<IndexRpc[K]>> | ReturnType<IndexRpc[K]>;
};

/** The frozen form: plain IndexRpc methods; `this` is the ModuleDeps. */
export type RpcImpl = Partial<IndexRpc> & ThisType<ModuleDeps>;

export interface NodeIndexCall {
  method: keyof IndexRpc;
  args: unknown[];
}

export type NodeIndex = IndexRpc & {
  /** Every RPC call, in order, implemented or not. */
  readonly calls: NodeIndexCall[];
  /** Every log line written by module functions through the default logger. */
  readonly logs: LogEntry[];
  /** Outbound requests attempted through the default (refusing) transport. */
  readonly networkAttempts: string[];
  readonly deps: ModuleDeps;
};

const METHODS: Record<keyof IndexRpc, true> = {
  ready: true,
  indexing: true,
  history: true,
  feed: true,
  lookup: true,
  recordStatus: true,
  stats: true,
  profile: true,
  following: true,
  followers: true,
  exportUser: true,
  resolveHandle: true,
  notify: true,
  ensureRunning: true,
  adminStatus: true,
  adminPitr: true,
  adminBackup: true,
};

export const NODE_INDEX_METHODS = Object.keys(METHODS) as (keyof IndexRpc)[];

export class NotWiredError extends Error {
  constructor(method: string) {
    super(`IndexRpc.${method} is not implemented by this local index`);
    this.name = 'NotWiredError';
  }
}

export interface NodeIndexOptions extends ModuleDepsOptions {
  /** `module` (default): `impl` is a ModuleImpl. `rpc`: `impl` is a Partial<IndexRpc>. */
  form?: 'module' | 'rpc';
}

/**
 * An IndexRpc whose methods run `impl` against `db` with deterministic deps
 * (`moduleDeps`). Methods without an implementation reject with
 * NotWiredError, so a test cannot silently call something it did not wire.
 */
export function nodeIndex(db: Db, impl: ModuleImpl, options?: ModuleDepsOptions & { form?: 'module' }): NodeIndex;
export function nodeIndex(db: Db, impl: RpcImpl, options: ModuleDepsOptions & { form: 'rpc' }): NodeIndex;
export function nodeIndex(db: Db, impl: ModuleImpl | RpcImpl, options: NodeIndexOptions = {}): NodeIndex {
  const { form = 'module', ...depsOptions } = options;
  const calls: NodeIndexCall[] = [];
  const log = recordingLogger();
  const transport = refusingTransport();
  const deps = moduleDeps(db, { log, transport, ...depsOptions });
  const index: Record<string, unknown> = {
    calls,
    logs: log.entries,
    networkAttempts: transport.attempts,
    deps,
  };
  for (const method of NODE_INDEX_METHODS) {
    index[method] = async (...args: unknown[]) => {
      calls.push({ method, args });
      const fn = (impl as Record<string, ((...a: unknown[]) => unknown) | undefined>)[method];
      if (fn === undefined) throw new NotWiredError(method);
      return form === 'rpc' ? fn.apply(deps, args) : fn(deps, ...args);
    };
  }
  return index as unknown as NodeIndex;
}

// ---------------------------------------------------------------------------
// Schema introspection

type Row = Record<string, unknown>;
type NodeDatabase = sqlite.DatabaseSync;
const DatabaseClass = (sqlite as unknown as { Database: new (path: string) => NodeDatabase }).Database;

const SCHEMA_PRAGMAS = ['table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list'];
/**
 * `SELECT <columns> FROM pragma_<schema function>(?) [WHERE ...] [ORDER BY ...]`
 * with no other FROM, JOIN or subquery: the only shape `schemaAll` answers.
 */
const INTROSPECTION = new RegExp(
  `^\\s*SELECT\\s+(?:(?!\\bFROM\\b)[^;])+?\\bFROM\\s+pragma_(?:${SCHEMA_PRAGMAS.join('|')})\\s*\\(\\s*\\?\\s*\\)` +
    '(?:\\s+WHERE\\s+(?:(?!\\b(?:FROM|JOIN|SELECT)\\b)[^;])+?)?' +
    '(?:\\s+ORDER\\s+BY\\s+(?:(?!\\b(?:FROM|JOIN|SELECT)\\b)[^;])+?)?\\s*$',
  'is',
);

/** `query` with string literals and quoted identifiers masked (their keywords never count). */
function maskQuoted(query: string): string {
  return query.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g, '_');
}

/** True when `query` is a schema-introspection SELECT that `schemaAll` answers. */
export function isSchemaIntrospection(query: string): boolean {
  return INTROSPECTION.test(maskQuoted(query));
}

function bindable(params: readonly SqlParam[]): sqlite.SQLInputValue[] {
  return params.map((value) => {
    if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return value;
  });
}

function plainValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/**
 * Runs a schema-introspection SELECT (`isSchemaIntrospection`) against a
 * schema-only replica of `db`: an in-memory database built from exactly the
 * DDL in `db`'s sqlite_master, holding no rows. Those pragma functions depend
 * on the schema only, so the answer is the one `db` itself would give.
 */
export function schemaAll<T = Row>(db: Db, query: string, ...params: SqlParam[]): T[] {
  if (!isSchemaIntrospection(query)) {
    throw new TypeError(`schemaAll answers only SELECT ... FROM pragma_<schema function>(?): ${query}`);
  }
  const ddl = db
    .all<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
    )
    .map((r) => r.sql);
  const replica = new DatabaseClass(':memory:');
  try {
    for (const statement of ddl) replica.exec(statement);
    const rows = replica.prepare(query).all(...bindable(params)) as Row[];
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plainValue(v)])) as T);
  } finally {
    replica.close();
  }
}

// ---------------------------------------------------------------------------
// This test file's named databases

/** Named, migrated databases in one temporary directory. */
export class IndexSet {
  readonly dir: string;
  readonly #open = new Map<string, SqliteDb>();
  readonly #created: string[] = [];
  readonly #migrations = new Map<string, MigrateResult[]>();
  #closed = false;

  constructor(prefix = 'atmusic-index-set-') {
    this.dir = makeTempDir(prefix);
  }

  /** The file of `name` (stable across reopen). */
  pathOf(name: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new TypeError(`index name ${JSON.stringify(name)} is not allowed`);
    return join(this.dir, `${name}.sqlite`);
  }

  /** The open handle of `name`; the database is created and migrated on first use. */
  get(name: string): SqliteDb {
    if (this.#closed) throw new Error('this index set was closed');
    const open = this.#open.get(name);
    if (open !== undefined) return open;
    const create = !this.#created.includes(name);
    const db = openSqliteDb(this.pathOf(name), { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS, create });
    if (create) this.#created.push(name);
    const result = migrate(db);
    this.#migrations.set(name, [...(this.#migrations.get(name) ?? []), result]);
    this.#open.set(name, db);
    return db;
  }

  /** The migration result of every open of `name`, in order. */
  migrations(name: string): readonly MigrateResult[] {
    return this.#migrations.get(name) ?? [];
  }

  /** Names whose database exists, in creation order. */
  names(): string[] {
    return [...this.#created];
  }

  /**
   * Replaces `name`'s database by an empty, unmigrated one at the same path
   * (the Node form of `storage.deleteAll()`): the handle is closed, the file
   * and its WAL removed, and a new file opened. Returns the open handle; a
   * later `get` returns it without migrating.
   */
  reset(name: string): SqliteDb {
    if (this.#closed) throw new Error('this index set was closed');
    const path = this.pathOf(name);
    this.#open.get(name)?.close();
    this.#open.delete(name);
    for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(p, { force: true });
    const db = openSqliteDb(path, { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS, create: true });
    if (!this.#created.includes(name)) this.#created.push(name);
    this.#open.set(name, db);
    return db;
  }

  /** Closes `name`'s handle; the next `get` reopens the same file and migrates again. */
  reopen(name: string): SqliteDb {
    this.#open.get(name)?.close();
    this.#open.delete(name);
    return this.get(name);
  }

  /** Closes every handle and removes the directory. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const db of this.#open.values()) db.close();
    this.#open.clear();
    rmSync(this.dir, { recursive: true, force: true });
  }

  get closed(): boolean {
    return this.#closed;
  }
}

let fileSet: IndexSet | null = null;

/**
 * This test file's IndexSet (one per evaluation of this module, which vitest
 * performs once per test file), in a temporary directory of its own. The
 * file removes it with `closeFileIndexes()` in afterAll.
 */
export function fileIndexes(): IndexSet {
  if (fileSet === null || fileSet.closed) fileSet = new IndexSet('atmusic-file-');
  return fileSet;
}

/** Closes this file's IndexSet and removes its directory. */
export function closeFileIndexes(): void {
  fileSet?.close();
  fileSet = null;
}
