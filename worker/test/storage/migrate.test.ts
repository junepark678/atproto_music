import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { doDb } from '../../src/do/db';
import { MigrationLedgerError, migrate } from '../../src/do/migrate';
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from '../../src/do/schema';
import type { HarnessDO } from '../harness/harness-do';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

// Hardcoded from ADR 0004 §6.1, not derived from schema.ts.
const EXPECTED_TABLES = [
  'admission',
  'backfill_generation',
  'counters',
  'follows',
  'hints',
  'host_backoff',
  'identity_cache',
  'indexing_status',
  'ingest_checkpoint',
  'record_state',
  'repo_jobs',
  'schema_migrations',
  'scrobbles',
  'snapshot_blocks',
  'stats_cache',
  'suppression',
  'timers',
  'users',
  'verified_commits',
];

const EXPECTED_INDEXES = [
  'follows_actor_subject',
  'follows_subject_actor',
  'hints_did',
  'hints_due',
  'repo_jobs_due',
  'scrobbles_global_time',
  'scrobbles_owner_time',
  'scrobbles_stats',
  'users_verified_handle',
];

interface MasterRow {
  type: string;
  name: string;
  sql: string | null;
}

function appObjects(storage: DurableObjectStorage): MasterRow[] {
  return storage.sql
    .exec<{ type: string; name: string; sql: string | null }>(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
    )
    .toArray();
}

function dumpAll(storage: DurableObjectStorage): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const table of [...TABLES, 'schema_migrations']) {
    out[table] = storage.sql.exec(`SELECT * FROM ${table} ORDER BY 1`).toArray();
  }
  return out;
}

function columns(storage: DurableObjectStorage, table: string): string[] {
  return storage.sql
    .exec<{ name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid', table)
    .toArray()
    .map((r) => r.name);
}

describe('migrate', () => {
  it('fresh DO applies migration 1 and seeds indexing_status/backfill_generation/ingest_checkpoint', async () => {
    const stub = stubFor('migrate-fresh');

    // Through the harness Worker's default fetch: the constructor migrated.
    const res = await exports.default.fetch('https://harness.test/harness/migrate-fresh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ migration: { status: 'ready', version: 1 } });

    await runInDurableObject(stub, (instance: HarnessDO, state) => {
      expect(instance.migration).toEqual({ status: 'ready', version: 1 });
      expect(SCHEMA_VERSION).toBe(1);

      const objects = appObjects(state.storage);
      expect(objects.filter((o) => o.type === 'table').map((o) => o.name)).toEqual(EXPECTED_TABLES);
      expect(objects.filter((o) => o.type === 'index').map((o) => o.name)).toEqual(EXPECTED_INDEXES);
      expect(objects.some((o) => o.type === 'trigger' || o.type === 'view')).toBe(false);

      const db = doDb(state.storage);
      expect(db.all('SELECT * FROM schema_migrations')).toEqual([{ version: 1, name: 'initial_workers_schema' }]);
      expect(db.all('SELECT * FROM indexing_status')).toEqual([
        { scope: 'global', state: 'recovering', caught_up: 0, last_indexed_at: null, lag_seconds: null },
      ]);
      expect(db.all('SELECT * FROM backfill_generation')).toEqual([{ singleton: 1, last_generation: 0 }]);
      expect(db.all('SELECT * FROM ingest_checkpoint')).toEqual([
        {
          stream: 'jetstream',
          cursor: null,
          last_event_time_us: null,
          connected: 0,
          pending_gap: 1,
          gap_scan_after_did: null,
          mode: null,
          host_index: 0,
          connected_at_ms: null,
          updated_at_ms: 0,
        },
      ]);
      // Every other table starts empty.
      for (const table of TABLES) {
        if (['indexing_status', 'backfill_generation', 'ingest_checkpoint'].includes(table)) continue;
        expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)).toEqual({ n: 0 });
      }

      // Column sets from ADR §6.1 (extensions included, dropped columns absent).
      expect(columns(state.storage, 'users')).toEqual([
        'did',
        'handle',
        'handle_checked_at_ms',
        'pds',
        'joined_at',
        'indexed_at',
        'active',
        'account_status',
        'max_rev',
        'indexing_state',
        'generation',
        'stats_version',
        'last_snapshot_at_ms',
        'last_status_check_ms',
        'last_activity_ms',
      ]);
      expect(columns(state.storage, 'scrobbles')).toContain('rkey');
      expect(columns(state.storage, 'scrobbles')).not.toContain('confirmed');
      expect(columns(state.storage, 'follows')).not.toContain('confirmed');
      expect(columns(state.storage, 'record_state')).toEqual([
        'uri',
        'did',
        'collection',
        'revision',
        'cid',
        'state',
        'reason',
        'verified_at',
      ]);
      expect(columns(state.storage, 'suppression')).toEqual(['did', 'suppressed_at', 'settings_uri', 'settings_rev']);
      expect(columns(state.storage, 'repo_jobs')).toEqual([
        'did',
        'kind',
        'state',
        'generation',
        'reason',
        'head_rev',
        'head_cid',
        'frontier_json',
        'restarts',
        'reactivate',
        'due_at',
        'attempts',
        'failure_code',
        'updated_at_ms',
      ]);
      expect(columns(state.storage, 'ingest_checkpoint')).toEqual([
        'stream',
        'cursor',
        'last_event_time_us',
        'connected',
        'pending_gap',
        'gap_scan_after_did',
        'mode',
        'host_index',
        'connected_at_ms',
        'updated_at_ms',
      ]);
      expect(columns(state.storage, 'hints')).toEqual([
        'uri',
        'did',
        'collection',
        'rkey',
        'source',
        'priority',
        'hint_rev',
        'receipt_time',
        'due_at',
        'attempts',
        'last_error',
      ]);
      expect(columns(state.storage, 'stats_cache')).toEqual(['did', 'win', 'lim', 'as_of', 'lower', 'version', 'body']);

      // A new user is inactive until its first complete snapshot.
      db.run("INSERT INTO users(did, joined_at) VALUES ('did:plc:alice', '2026-01-15T12:00:00.000000000Z')");
      expect(db.one('SELECT active, indexing_state, account_status, generation, stats_version FROM users')).toEqual({
        active: 0,
        indexing_state: 'recovering',
        account_status: 'unknown',
        generation: 0,
        stats_version: 0,
      });
      // CHECKs from the schema are live.
      expect(() => db.run("UPDATE users SET indexing_state = 'bogus'")).toThrow(/CHECK constraint failed/);
      expect(() =>
        db.run(
          "INSERT INTO hints(uri,did,collection,rkey,source,priority,receipt_time,due_at) VALUES ('at://x/c/r','did:plc:x','c','r','firehose',0,'2026-01-15T12:00:00.000000000Z',0)",
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        db.run(
          "INSERT INTO hints(uri,did,collection,rkey,source,priority,receipt_time,due_at) VALUES ('at://x/c/r','did:plc:x','c','r','notify',0,'2026-01-15T12:00:00Z',0)",
        ),
      ).toThrow(/CHECK constraint failed/);
    });
  });

  it('schema newer than code reports too_new', async () => {
    const stub = stubFor('migrate-too-new');
    await runInDurableObject(stub, (_instance: HarnessDO, state) => {
      state.storage.sql.exec("INSERT INTO schema_migrations(version, name) VALUES (2, 'from_newer_code')");
    });
    await runInDurableObject(stub, (_instance: HarnessDO, state) => {
      const before = { objects: appObjects(state.storage), data: dumpAll(state.storage) };
      expect(migrate(state.storage)).toEqual({ status: 'too_new', version: 2 });
      // Nothing was touched: no DDL, no ledger rows, no data.
      expect({ objects: appObjects(state.storage), data: dumpAll(state.storage) }).toEqual(before);
    });

    // A restarted DO (constructor migrate) reports too_new too, which
    // /health/ready turns into 503.
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance: HarnessDO) => {
      expect(instance.migration).toEqual({ status: 'too_new', version: 2 });
    });
    const res = await exports.default.fetch('https://harness.test/harness/migrate-too-new');
    expect(await res.json()).toEqual({ migration: { status: 'too_new', version: 2 } });
  });

  it('re-running migrate is a no-op', async () => {
    const stub = stubFor('migrate-rerun');
    await runInDurableObject(stub, (_instance: HarnessDO, state) => {
      const db = doDb(state.storage);
      db.run("INSERT INTO users(did, joined_at) VALUES ('did:plc:bob', '2026-01-15T12:00:00.000000000Z')");
      db.run('UPDATE backfill_generation SET last_generation = 7');
      db.run('UPDATE ingest_checkpoint SET pending_gap = 0, cursor = 1768478400000000');

      const before = { objects: appObjects(state.storage), data: dumpAll(state.storage) };
      expect(migrate(state.storage)).toEqual({ status: 'ready', version: 1 });
      expect(migrate(state.storage)).toEqual({ status: 'ready', version: 1 });
      expect({ objects: appObjects(state.storage), data: dumpAll(state.storage) }).toEqual(before);
      expect(db.all('SELECT * FROM schema_migrations')).toEqual([{ version: 1, name: 'initial_workers_schema' }]);
      // Seeds were not re-inserted over changed state.
      expect(db.all('SELECT * FROM indexing_status')).toHaveLength(1);
      expect(db.one('SELECT last_generation FROM backfill_generation')).toEqual({ last_generation: 7 });
    });

    // The constructor's migrate after eviction is also a no-op on the same storage.
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance: HarnessDO, state) => {
      expect(instance.migration).toEqual({ status: 'ready', version: 1 });
      const db = doDb(state.storage);
      expect(db.all('SELECT did FROM users')).toEqual([{ did: 'did:plc:bob' }]);
      expect(db.one('SELECT pending_gap, cursor FROM ingest_checkpoint')).toEqual({
        pending_gap: 0,
        cursor: 1768478400000000,
      });
    });
  });

  it('a ledger written by different code is refused and rolls back', async () => {
    const stub = stubFor('migrate-ledger-mismatch');
    await runInDurableObject(stub, (_instance: HarnessDO, state) => {
      state.storage.sql.exec("UPDATE schema_migrations SET name = 'someone_else' WHERE version = 1");
      const before = dumpAll(state.storage);
      const next = [...MIGRATIONS, { version: 2, name: 'second', statements: ['CREATE TABLE extra (x INTEGER)'] }];
      expect(() => migrate(state.storage, next)).toThrow(MigrationLedgerError);
      expect(appObjects(state.storage).some((o) => o.name === 'extra')).toBe(false);
      expect(dumpAll(state.storage)).toEqual(before);
    });
  });

  it('a later migration applies once, atomically, after migration 1', async () => {
    const stub = stubFor('migrate-next');
    await runInDurableObject(stub, (_instance: HarnessDO, state) => {
      const broken = [
        ...MIGRATIONS,
        { version: 2, name: 'second', statements: ['CREATE TABLE extra (x INTEGER)', 'THIS IS NOT SQL'] },
      ];
      expect(() => migrate(state.storage, broken)).toThrow();
      expect(appObjects(state.storage).some((o) => o.name === 'extra')).toBe(false);
      expect(state.storage.sql.exec('SELECT max(version) AS v FROM schema_migrations').one()).toEqual({ v: 1 });

      const good = [...MIGRATIONS, { version: 2, name: 'second', statements: ['CREATE TABLE extra (x INTEGER)'] }];
      expect(migrate(state.storage, good)).toEqual({ status: 'ready', version: 2 });
      expect(migrate(state.storage, good)).toEqual({ status: 'ready', version: 2 });
      expect(state.storage.sql.exec('SELECT version, name FROM schema_migrations ORDER BY version').toArray()).toEqual([
        { version: 1, name: 'initial_workers_schema' },
        { version: 2, name: 'second' },
      ]);
      // Code that only knows migration 1 now sees a newer schema.
      expect(migrate(state.storage)).toEqual({ status: 'too_new', version: 2 });
    });
  });
});
