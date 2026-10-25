// Applies worker/src/do/schema.ts migrations (ADR 0004 §6; ADR 0005 §3.2).
//
// All pending migrations run inside one transaction: either every statement
// and ledger row commits or none does. `schema_migrations` replaces PRAGMA
// user_version.
//
// Targets. `migrate` runs over a `MigrationTarget {exec, tx}`: the Node `Db`
// (worker/src/node/sqlite-db.ts) is one. The Durable Object storage overload
// (`sql` + `transactionSync`) is kept for index-do.ts until N7-01.
//
// Compatibility rule (ADR 0005 §3.2). Code at version n opening a database at
// version m > n reads `schema_compat.min_compatible_version` (when that table
// is absent, the database version m itself). When it is at most n the database
// is `ready`: every later migration is additive, so this code ignores tables
// and columns it does not know. Otherwise it is `too_new`, which /health/ready
// serves as 503. Either way a newer database is never modified.

import type { SqlParam } from './db';
import { MIGRATIONS, type Migration } from './schema';

export interface MigrateResult {
  status: 'ready' | 'too_new';
  /**
   * The schema version found in (ready: now applied to) the database. A ready
   * database written by newer, compatible code reports its own newer version.
   */
  version: number;
}

export class MigrationLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationLedgerError';
  }
}

/** What migrate needs from a database: one-statement exec returning rows, and a synchronous transaction. */
export interface MigrationTarget {
  exec(sql: string, ...params: SqlParam[]): unknown[];
  tx<T>(fn: () => T extends Promise<unknown> ? never : T): T;
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL CHECK(typeof(version) = 'integer' AND version >= 1),
  name TEXT NOT NULL
)`;

type MigrationStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

function isDurableObjectStorage(target: MigrationStorage | MigrationTarget): target is MigrationStorage {
  return 'transactionSync' in target && 'sql' in target;
}

function doTarget(storage: MigrationStorage): MigrationTarget {
  return {
    exec: (sql, ...params) => storage.sql.exec(sql, ...params).toArray(),
    tx: <T>(fn: () => T extends Promise<unknown> ? never : T): T => storage.transactionSync(() => fn() as T),
  };
}

/**
 * The database's `schema_compat.min_compatible_version`, or null when the
 * table is absent. Several rows (never written by our migrations) count as
 * their maximum, and a non-integer value as the database version: both
 * conservative.
 */
function minCompatibleVersion(target: MigrationTarget, databaseVersion: number): number | null {
  const table = target.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_compat'");
  if (table.length === 0) return null;
  const rows = target.exec('SELECT min_compatible_version AS v FROM schema_compat') as Array<{ v: unknown }>;
  if (rows.length === 0) return databaseVersion;
  let max = 0;
  for (const { v } of rows) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) return databaseVersion;
    max = Math.max(max, v);
  }
  return max;
}

function checkLedgerPrefix(
  applied: ReadonlyArray<{ version: number; name: string }>,
  migrations: readonly Migration[],
) {
  // The ledger must start with exactly our migrations: a gap or a renamed
  // migration means this storage was written by different code.
  applied.slice(0, migrations.length).forEach((row, i) => {
    const expected = migrations[i];
    if (expected === undefined || expected.version !== row.version || expected.name !== row.name) {
      throw new MigrationLedgerError(`schema_migrations row ${row.version}:${row.name} does not match this code`);
    }
  });
}

export function migrate(
  target: MigrationTarget | MigrationStorage,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrateResult {
  const db = isDurableObjectStorage(target) ? doTarget(target) : target;
  return db.tx((): MigrateResult => {
    db.exec(LEDGER_DDL);
    const applied = db.exec('SELECT version, name FROM schema_migrations ORDER BY version') as Array<{
      version: number;
      name: string;
    }>;
    const latest = migrations[migrations.length - 1]?.version ?? 0;
    const current = applied[applied.length - 1]?.version ?? 0;

    if (current > latest) {
      const minCompatible = minCompatibleVersion(db, current) ?? current;
      if (minCompatible > latest) return { status: 'too_new', version: current };
      checkLedgerPrefix(applied, migrations);
      return { status: 'ready', version: current };
    }

    checkLedgerPrefix(applied, migrations);
    if (applied.length > migrations.length) {
      throw new MigrationLedgerError('schema_migrations has more rows than this code has migrations');
    }

    for (const migration of migrations) {
      if (migration.version <= current) continue;
      for (const statement of migration.statements) db.exec(statement);
      db.exec('INSERT INTO schema_migrations(version, name) VALUES (?, ?)', migration.version, migration.name);
    }
    return { status: 'ready', version: latest };
  });
}
