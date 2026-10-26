// Temporary-file databases for the worker-node tests (ADR 0005 §3.2, §15.1;
// N1-01). Every later worker-node test builds on these helpers:
//
//   await withMigratedDb((db) => { ... })   // a fresh, migrated file database
//   const again = reopen(db)                // close it and open the same file
//
// Each call gets its own temporary directory, removed afterwards together with
// the database, its WAL and anything else the test wrote there. The busy
// timeout is TEST_BUSY_TIMEOUT_MS, so no test waits for the production 5 s.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MigrateResult, migrate } from '../../../src/do/migrate';
import type { Migration } from '../../../src/do/schema';
import { type OpenSqliteDbOptions, openSqliteDb, type SqliteDb } from '../../../src/node/sqlite-db';

export const TEST_BUSY_TIMEOUT_MS = 200;

export interface TempDbContext {
  /** The temporary directory holding the database file; removed after the test. */
  dir: string;
  /** The database file path. */
  path: string;
  /** The migration result of the first open. */
  migration: MigrateResult;
  /** The currently open handle (updated by reopen). */
  current: SqliteDb;
}

export interface WithMigratedDbOptions {
  /** Migrations to apply instead of MIGRATIONS. */
  migrations?: readonly Migration[];
  /** Extra openSqliteDb options (busyTimeoutMs defaults to TEST_BUSY_TIMEOUT_MS). */
  open?: Omit<OpenSqliteDbOptions, 'create'>;
}

const contexts = new WeakMap<SqliteDb, TempDbContext>();

/** A fresh temporary directory (the caller removes it). */
export function makeTempDir(prefix = 'atmusic-node-db-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Runs `fn` over a migrated database in a new temporary file. The handle passed
 * to `fn` (or the latest one returned by `reopen`) is closed and the directory
 * removed afterwards, also when `fn` throws.
 */
export async function withMigratedDb<T>(
  fn: (db: SqliteDb, ctx: TempDbContext) => T | Promise<T>,
  options: WithMigratedDbOptions = {},
): Promise<T> {
  const dir = makeTempDir();
  const path = join(dir, 'atmusic.db');
  const openOptions = { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS, ...options.open };
  let ctx: TempDbContext | null = null;
  try {
    const db = openSqliteDb(path, { ...openOptions, create: true });
    const migration = migrate(db, options.migrations);
    ctx = { dir, path, migration, current: db };
    contexts.set(db, ctx);
    if (migration.status !== 'ready') throw new Error(`fresh database did not migrate: ${JSON.stringify(migration)}`);
    return await fn(db, ctx);
  } finally {
    try {
      ctx?.current.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export interface ReopenOptions {
  /** Run migrate() on the reopened handle, as a process restart does (default true). */
  migrate?: boolean;
  migrations?: readonly Migration[];
  open?: Omit<OpenSqliteDbOptions, 'create'>;
}

/**
 * Closes `db` and opens the same file again (with create: false), the Node
 * equivalent of a process restart. Returns the new handle; the old one is
 * closed. Only handles from withMigratedDb (or an earlier reopen) are accepted.
 */
export function reopen(db: SqliteDb, options: ReopenOptions = {}): SqliteDb {
  const ctx = contexts.get(db);
  if (ctx === undefined || ctx.current !== db) throw new Error('reopen() needs the current withMigratedDb handle');
  db.close();
  const next = openSqliteDb(ctx.path, { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS, ...options.open, create: false });
  ctx.current = next;
  contexts.set(next, ctx);
  if (options.migrate ?? true) {
    const result = migrate(next, options.migrations);
    if (result.status !== 'ready') throw new Error(`reopened database did not migrate: ${JSON.stringify(result)}`);
  }
  return next;
}

type Row = Record<string, unknown>;

export interface DbDump {
  /** sqlite_master rows (type, name, tbl_name, sql), sorted. */
  objects: Row[];
  /** Every table's rows, BLOBs as hex, sorted by their JSON form. */
  tables: Record<string, string[]>;
}

function jsonCell(value: unknown): unknown {
  return value instanceof ArrayBuffer ? `x'${Buffer.from(value).toString('hex')}'` : value;
}

/** A comparable snapshot of the whole schema and every row (module SQL only). */
export function dumpDb(db: SqliteDb): DbDump {
  const objects = db.all<Row>(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  const tables: Record<string, string[]> = {};
  for (const { name } of objects.filter((o) => o.type === 'table') as Array<{ name: string }>) {
    const rows = db.all<Row>(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
    tables[name] = rows
      .map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, jsonCell(v)]))))
      .sort();
  }
  return { objects, tables };
}
