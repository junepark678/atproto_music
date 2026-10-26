// The Node harness of the de-shimmed read, write and http suites (ADR 0005
// §15.1 step 2, N4-06). TEST-ONLY.
//
// These suites used to reach a harness Durable Object through the
// `cloudflare:*` test shim (runInDurableObject, evictDurableObject, env). They
// now run on node-db (worker/test/node/support/node-db.ts, N1-01) directly:
//
// - `openTestDb()` is a fresh migrated database in its own temporary file,
//   opened by the production adapter (withMigratedDb), held open until the
//   end of the test file and then closed and removed with its directory.
//   `reopen()` closes it and opens the same file again (node-db's reopen):
//   the Node equivalent of evictDurableObject, a process restart.
// - `makeDbIndex(state, impl)` is the IndexRpc adapter of
//   worker/test/harness/local-index.ts (makeLocalIndex) over such a database:
//   module functions `(m: ModuleDeps, ...args)` (or plain RPC methods with
//   `{form: 'rpc'}`) run against the database with deterministic
//   dependencies (frozen clock, seeded random, a transport that refuses all
//   network); a method without an implementation rejects with NotWiredError.
// - `HARNESS_ENV` holds the variables the harness Worker had
//   (worker/test/harness/wrangler.harness.jsonc), so the suites keep parsing
//   the same configuration and deriving the same cursor key.

import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import type { Transport } from '@atmusic/atproto/transport';
import type { Clock, Random } from '@atmusic/core/deps';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterAll } from 'vitest';
import { type AppConfig, parseConfig } from '../../src/config';
import type { IndexRpc, Logger, LogLevel, ModuleDeps } from '../../src/do/contracts';
import type { Db } from '../../src/do/db';
import type { EnvSecrets, EnvVars } from '../../src/env';
import type { SqliteDb } from '../../src/node/sqlite-db';
import { reopen as reopenDb, withMigratedDb } from '../node/support/node-db';

// ---------------------------------------------------------------------------
// Environment

/** The harness Worker's variables (wrangler.harness.jsonc); CURSOR_KEY is test-only key material. */
export const HARNESS_ENV: Readonly<EnvVars & Pick<EnvSecrets, 'CURSOR_KEY'>> = Object.freeze({
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

// ---------------------------------------------------------------------------
// Databases

/** A migrated temporary-file database, open until the end of the test file. */
export interface TestDb {
  /** The current handle (a new one after `reopen`). */
  readonly db: SqliteDb;
  /** The database file. */
  readonly path: string;
  /** Closes the connection and opens the same file again (a restart); returns the new handle. */
  reopen(): SqliteDb;
}

const open = new Set<{ release: () => void; done: Promise<unknown> }>();

/**
 * A fresh migrated database through withMigratedDb, held open until the
 * file's afterAll (or `closeTestDbs()`), which closes the latest handle and
 * removes the directory.
 */
export function openTestDb(): Promise<TestDb> {
  return new Promise<TestDb>((resolveDb, reject) => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let settled = false;
    const done = withMigratedDb(async (_first, ctx) => {
      const testDb: TestDb = {
        get db() {
          return ctx.current;
        },
        path: ctx.path,
        reopen() {
          return reopenDb(ctx.current);
        },
      };
      settled = true;
      resolveDb(testDb);
      await held;
    });
    const entry = { release, done };
    open.add(entry);
    done.then(
      () => open.delete(entry),
      (error: unknown) => {
        open.delete(entry);
        if (!settled) reject(error);
      },
    );
  });
}

/** Closes every database openTestDb opened in this file and removes their directories. */
export async function closeTestDbs(): Promise<void> {
  const entries = [...open];
  for (const e of entries) e.release();
  await Promise.all(entries.map((e) => e.done));
}

// Vitest evaluates this module once per test file, so this hook belongs to
// the file that imported it.
afterAll(closeTestDbs);

/** Where an index finds its database: a TestDb (follows reopen) or a fixed handle. */
export type DbSource = TestDb | Db;

function dbOf(source: DbSource): Db {
  return 'reopen' in source ? source.db : source;
}

// ---------------------------------------------------------------------------
// IndexRpc over a database (makeLocalIndex without a Durable Object)

/** A DO module function: `(m: ModuleDeps, ...rpcArgs)`, sync or async. */
export type ModuleImpl = {
  [K in keyof IndexRpc]?: (
    m: ModuleDeps,
    ...args: Parameters<IndexRpc[K]>
  ) => Awaited<ReturnType<IndexRpc[K]>> | ReturnType<IndexRpc[K]>;
};

/** The frozen form: plain IndexRpc methods; `this` is the ModuleDeps with the database. */
export type RpcImpl = Partial<IndexRpc> & ThisType<ModuleDeps>;

export interface DbIndexState {
  db: DbSource;
  clock?: Clock;
  random?: Random;
  transport?: Transport;
  identity?: IdentityResolver;
  config?: AppConfig;
  log?: Logger;
}

export interface LocalIndexCall {
  method: keyof IndexRpc;
  args: unknown[];
}

export interface LogEntry {
  level: LogLevel;
  event: string;
  fields?: Record<string, unknown>;
}

export type LocalIndex = IndexRpc & {
  /** Every RPC call, in order, implemented or not. */
  readonly calls: LocalIndexCall[];
  /** Every log line written by module functions through the default logger. */
  readonly logs: LogEntry[];
  /** Outbound requests attempted through the default (refusing) transport. */
  readonly networkAttempts: string[];
  readonly deps: Omit<ModuleDeps, 'db'>;
};

export class NotWiredError extends Error {
  constructor(method: string) {
    super(`IndexRpc.${method} is not implemented by this local index`);
    this.name = 'NotWiredError';
  }
}

export function makeDbIndex(state: DbIndexState, impl: ModuleImpl, options?: { form?: 'module' }): LocalIndex;
export function makeDbIndex(state: DbIndexState, impl: RpcImpl, options: { form: 'rpc' }): LocalIndex;
export function makeDbIndex(
  state: DbIndexState,
  impl: ModuleImpl | RpcImpl,
  options: { form?: 'module' | 'rpc' } = {},
): LocalIndex {
  const form = options.form ?? 'module';
  const calls: LocalIndexCall[] = [];
  const logs: LogEntry[] = [];
  const networkAttempts: string[] = [];

  const refusingTransport: Transport = async (req) => {
    networkAttempts.push(req.url);
    throw new Error(`no network in tests: ${req.method} ${req.url}`);
  };
  const deps: Omit<ModuleDeps, 'db'> = {
    clock: state.clock ?? fixedClock(),
    random: state.random ?? seededRandom(1),
    transport: state.transport ?? refusingTransport,
    identity: state.identity ?? {
      resolveDid: async (did) => {
        throw new Error(`identity resolution not wired in this test: ${did}`);
      },
      resolveHandle: async (handle) => {
        throw new Error(`handle resolution not wired in this test: ${handle}`);
      },
    },
    config: state.config ?? parseConfig(HARNESS_ENV, { allowFixturePrefix: true }),
    log: state.log ?? {
      log(level, event, fields) {
        logs.push(fields === undefined ? { level, event } : { level, event, fields });
      },
    },
  };

  // IndexRpc methods are created on first access, keyed by property name, so
  // this file holds no copy of the method list to fall out of step with
  // contracts.ts (a method added or removed there needs no edit here). `then`
  // stays undefined so the index is never mistaken for a thenable.
  const own: Record<string, unknown> = { calls, logs, networkAttempts, deps };
  const methods = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const methodFor = (name: string) => {
    let rpc = methods.get(name);
    if (rpc === undefined) {
      const method = name as keyof IndexRpc;
      rpc = async (...args: unknown[]) => {
        calls.push({ method, args });
        const fn = (impl as Record<string, ((...a: unknown[]) => unknown) | undefined>)[method];
        if (fn === undefined) throw new NotWiredError(method);
        const m: ModuleDeps = { ...deps, db: dbOf(state.db) };
        return form === 'rpc' ? fn.apply(m, args) : fn(m, ...args);
      };
      methods.set(name, rpc);
    }
    return rpc;
  };
  return new Proxy(own, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return Object.hasOwn(target, prop) ? target[prop] : methodFor(prop);
    },
  }) as unknown as LocalIndex;
}

/** Runs `fn` against the database's current handle (what runInDurableObject did for the harness DO). */
export async function inTestDb<T>(store: TestDb, fn: (db: Db) => T | Promise<T>): Promise<T> {
  return fn(store.db);
}
