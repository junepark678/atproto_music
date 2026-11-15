// The legacy listen-second seeder runs once a minute in the linked-pull timer
// until every legacy listen key has a known second. Its candidate queries must
// answer their EXISTS through the partial index of migration 58: on a real
// owner database (~117k listen keys) the plain did-prefix lookup made one call
// take ~25 s synchronously, which tripped the systemd watchdog.
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { LEGACY_SEED_MORE_SQL, LEGACY_SEED_NEXT_SQL } from '../../../src/outbox/listen-second-receipts';
import { withMigratedDb } from '../support/node-db';

/** EXPLAIN QUERY PLAN over a schema-only replica of `db` (the production authorizer denies EXPLAIN). */
function planOf(ddl: readonly string[], sql: string): string[] {
  const replica = new DatabaseSync(':memory:');
  try {
    for (const statement of ddl) replica.exec(statement);
    return replica
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(0)
      .map((row) => String((row as { detail: string }).detail));
  } finally {
    replica.close();
  }
}

it.each([
  ['next candidate', LEGACY_SEED_NEXT_SQL],
  ['more remaining', LEGACY_SEED_MORE_SQL],
])(
  'the legacy seeder %s query answers its EXISTS through listen_keys_unknown_second_operation',
  async (_label, sql) => {
    await withMigratedDb((db) => {
      const ddl = db
        .all<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL ORDER BY rowid",
        )
        .map((row) => row.sql);
      const plan = planOf(ddl, sql);
      const exists = plan.filter((detail) => /\bk\b/.test(detail) || detail.includes('listen_keys'));
      expect(exists.join(' | ')).toContain('listen_keys_unknown_second_operation');
      expect(exists.join(' | ')).not.toContain('sqlite_autoindex_listen_keys_1');
    });
  },
);
