// Applies worker/src/do/schema.ts migrations (ADR 0004 §6). Frozen in Wave 0.
//
// All pending migrations run inside one transactionSync: either every
// statement and ledger row commits or none does. `schema_migrations` replaces
// PRAGMA user_version. A database whose ledger is ahead of this code is left
// untouched and reported as `too_new`, which /health/ready serves as 503.

import { MIGRATIONS, type Migration } from './schema';

export interface MigrateResult {
  status: 'ready' | 'too_new';
  /** Ready: the version now applied. Too new: the version found in storage. */
  version: number;
}

export class MigrationLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationLedgerError';
  }
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL CHECK(typeof(version) = 'integer' AND version >= 1),
  name TEXT NOT NULL
)`;

type MigrationStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

export function migrate(storage: MigrationStorage, migrations: readonly Migration[] = MIGRATIONS): MigrateResult {
  return storage.transactionSync(() => {
    storage.sql.exec(LEDGER_DDL);
    const applied = storage.sql
      .exec<{ version: number; name: string }>('SELECT version, name FROM schema_migrations ORDER BY version')
      .toArray();
    const latest = migrations[migrations.length - 1]?.version ?? 0;
    const current = applied[applied.length - 1]?.version ?? 0;

    if (current > latest) return { status: 'too_new', version: current };

    // The ledger must be exactly the prefix of our migrations: a gap or a
    // renamed migration means this storage was written by different code.
    applied.forEach((row, i) => {
      const expected = migrations[i];
      if (expected === undefined || expected.version !== row.version || expected.name !== row.name) {
        throw new MigrationLedgerError(`schema_migrations row ${row.version}:${row.name} does not match this code`);
      }
    });

    for (const migration of migrations) {
      if (migration.version <= current) continue;
      for (const statement of migration.statements) storage.sql.exec(statement);
      storage.sql.exec('INSERT INTO schema_migrations(version, name) VALUES (?, ?)', migration.version, migration.name);
    }
    return { status: 'ready', version: latest };
  });
}
