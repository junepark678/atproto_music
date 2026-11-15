// Migration 58 indexes operation-id lookups on listen_keys and import_items.
// The legacy listen-second seeder runs them once a minute in the linked-pull
// timer, and import rebatching runs them per candidate inside one transaction.
// Before the indexes each lookup scanned the table: on a real owner database
// (~117k listen keys) one seeder call took ~25 s synchronously, which tripped
// the systemd watchdog, and rebatching 1,000 singles held a ~20 s transaction.
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  REBATCH_ITEMS_OF_OPERATION_SQL,
  REBATCH_KEYS_OF_OPERATION_SQL,
  REBATCH_REPOINT_ITEMS_SQL,
  REBATCH_REPOINT_KEYS_SQL,
} from '../../../src/imports/rebatch';
import { LEGACY_SEED_MORE_SQL, LEGACY_SEED_NEXT_SQL } from '../../../src/outbox/listen-second-receipts';
import { withMigratedDb } from '../support/node-db';

/** EXPLAIN QUERY PLAN over a schema-only replica of the migrated schema (the production authorizer denies EXPLAIN). */
function planOf(ddl: readonly string[], sql: string, params: number): string {
  const replica = new DatabaseSync(':memory:');
  try {
    for (const statement of ddl) replica.exec(statement);
    return replica
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from({ length: params }, () => 'x'))
      .map((row) => String((row as { detail: string }).detail))
      .join(' | ');
  } finally {
    replica.close();
  }
}

async function migratedDdl(): Promise<string[]> {
  return withMigratedDb((db) =>
    db
      .all<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL ORDER BY rowid",
      )
      .map((row) => row.sql),
  );
}

it.each([
  ['the legacy seeder next candidate', LEGACY_SEED_NEXT_SQL, 1, 'listen_keys_operation_second'],
  ['the legacy seeder more remaining', LEGACY_SEED_MORE_SQL, 1, 'listen_keys_operation_second'],
  ['rebatch keys of an operation', REBATCH_KEYS_OF_OPERATION_SQL, 1, 'listen_keys_operation_second'],
  ['rebatch key repointing', REBATCH_REPOINT_KEYS_SQL, 2, 'listen_keys_operation_second'],
  ['rebatch items of an operation', REBATCH_ITEMS_OF_OPERATION_SQL, 1, 'import_items_operation'],
  ['rebatch item repointing', REBATCH_REPOINT_ITEMS_SQL, 2, 'import_items_operation'],
] as const)('%s looks listen keys or import items up through %s, never a scan', async (_label, sql, params, index) => {
  const plan = planOf(await migratedDdl(), sql, params);
  expect(plan).toContain(index);
  expect(plan).not.toMatch(/SCAN (listen_keys|import_items|k\b|i\b)/);
  expect(plan).not.toContain('sqlite_autoindex_listen_keys_1');
});
