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

// Golden: the exact stored DDL of every table and index of migration 1,
// whitespace-normalized. Hand-checked against ADR 0004 §6.1 and, for the
// kept tables and their indexes, crates/storage/migrations/0001-0004 (the
// oracle). Pins column order, types, NOT NULL, DEFAULTs, every CHECK, FKs,
// primary keys, index columns, DESC order and the partial WHERE. Any schema
// change must come as a new migration, never by editing this golden.
const GOLDEN_DDL: ReadonlyArray<{ type: 'table' | 'index'; name: string; sql: string }> = [
  {
    type: 'index',
    name: 'follows_actor_subject',
    sql: 'CREATE INDEX follows_actor_subject ON follows(actor,subject,uri)',
  },
  {
    type: 'index',
    name: 'follows_subject_actor',
    sql: 'CREATE INDEX follows_subject_actor ON follows(subject,actor,uri)',
  },
  {
    type: 'index',
    name: 'hints_did',
    sql: 'CREATE INDEX hints_did ON hints(did)',
  },
  {
    type: 'index',
    name: 'hints_due',
    sql: 'CREATE INDEX hints_due ON hints(due_at)',
  },
  {
    type: 'index',
    name: 'repo_jobs_due',
    sql: 'CREATE INDEX repo_jobs_due ON repo_jobs(kind,state,due_at,did)',
  },
  {
    type: 'index',
    name: 'scrobbles_global_time',
    sql: 'CREATE INDEX scrobbles_global_time ON scrobbles(listened_at DESC,uri DESC)',
  },
  {
    type: 'index',
    name: 'scrobbles_owner_time',
    sql: 'CREATE INDEX scrobbles_owner_time ON scrobbles(did,listened_at DESC,uri DESC)',
  },
  {
    type: 'index',
    name: 'scrobbles_stats',
    sql: 'CREATE INDEX scrobbles_stats ON scrobbles(did,artist_key,track_key,listened_at)',
  },
  {
    type: 'index',
    name: 'users_verified_handle',
    sql: 'CREATE UNIQUE INDEX users_verified_handle ON users(handle) WHERE handle IS NOT NULL',
  },
  {
    type: 'table',
    name: 'admission',
    sql: 'CREATE TABLE admission (window_start_ms INTEGER PRIMARY KEY NOT NULL, admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted >= 0))',
  },
  {
    type: 'table',
    name: 'backfill_generation',
    sql: "CREATE TABLE backfill_generation (singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1), last_generation INTEGER NOT NULL CHECK(typeof(last_generation) = 'integer' AND last_generation >= 0))",
  },
  {
    type: 'table',
    name: 'counters',
    sql: "CREATE TABLE counters (name TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', value INTEGER NOT NULL DEFAULT 0 CHECK(value >= 0), PRIMARY KEY(name,label))",
  },
  {
    type: 'table',
    name: 'follows',
    sql: "CREATE TABLE follows (uri TEXT PRIMARY KEY NOT NULL, cid TEXT NOT NULL, actor TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE, subject TEXT NOT NULL, revision TEXT NOT NULL, created_at TEXT NOT NULL CHECK(length(created_at) = 30 AND substr(created_at, 30, 1) = 'Z'), indexed_at TEXT NOT NULL, CHECK(actor != subject))",
  },
  {
    type: 'table',
    name: 'hints',
    sql: "CREATE TABLE hints (uri TEXT PRIMARY KEY NOT NULL, did TEXT NOT NULL, collection TEXT NOT NULL, rkey TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('jetstream','notify','reconcile')), priority INTEGER NOT NULL, hint_rev TEXT, receipt_time TEXT NOT NULL CHECK(length(receipt_time) = 30 AND substr(receipt_time, 30, 1) = 'Z'), due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), last_error TEXT)",
  },
  {
    type: 'table',
    name: 'host_backoff',
    sql: 'CREATE TABLE host_backoff (host TEXT PRIMARY KEY NOT NULL, until_ms INTEGER NOT NULL)',
  },
  {
    type: 'table',
    name: 'identity_cache',
    sql: 'CREATE TABLE identity_cache (did TEXT PRIMARY KEY NOT NULL, doc_json TEXT, signing_key TEXT, pds TEXT, handle TEXT, fetched_at_ms INTEGER NOT NULL, neg_until_ms INTEGER)',
  },
  {
    type: 'table',
    name: 'indexing_status',
    sql: "CREATE TABLE indexing_status (scope TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL CHECK(state IN ('current','recovering','stale','suppressed')), caught_up INTEGER NOT NULL DEFAULT 0 CHECK(caught_up IN (0,1)), last_indexed_at TEXT, lag_seconds INTEGER CHECK(lag_seconds >= 0))",
  },
  {
    type: 'table',
    name: 'ingest_checkpoint',
    sql: "CREATE TABLE ingest_checkpoint (stream TEXT PRIMARY KEY NOT NULL, cursor INTEGER CHECK(cursor >= 0), last_event_time_us INTEGER CHECK(last_event_time_us >= 0), connected INTEGER NOT NULL DEFAULT 0 CHECK(connected IN (0,1)), pending_gap INTEGER NOT NULL DEFAULT 1 CHECK(pending_gap IN (0,1)), gap_scan_after_did TEXT, mode TEXT CHECK(mode IN ('socket','pulse','off')), host_index INTEGER NOT NULL DEFAULT 0 CHECK(host_index >= 0), connected_at_ms INTEGER, updated_at_ms INTEGER NOT NULL DEFAULT 0)",
  },
  {
    type: 'table',
    name: 'record_state',
    sql: "CREATE TABLE record_state (uri TEXT PRIMARY KEY NOT NULL, did TEXT NOT NULL, collection TEXT NOT NULL, revision TEXT NOT NULL, cid TEXT, state TEXT NOT NULL CHECK(state IN ('present','absent','excluded')), reason TEXT, verified_at TEXT NOT NULL, CHECK(state = 'absent' OR cid IS NOT NULL), CHECK(state != 'excluded' OR reason IS NOT NULL))",
  },
  {
    type: 'table',
    name: 'repo_jobs',
    sql: "CREATE TABLE repo_jobs (did TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('snapshot','status','identity')), state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete','failed')), generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation) = 'integer' AND generation >= 0), reason TEXT, head_rev TEXT, head_cid TEXT, frontier_json TEXT, restarts INTEGER NOT NULL DEFAULT 0 CHECK(restarts >= 0), reactivate INTEGER NOT NULL DEFAULT 0 CHECK(reactivate IN (0,1)), due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), failure_code TEXT, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(did,kind))",
  },
  {
    // The ledger (worker/src/do/migrate.ts); SQLite drops IF NOT EXISTS.
    type: 'table',
    name: 'schema_migrations',
    sql: "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL CHECK(typeof(version) = 'integer' AND version >= 1), name TEXT NOT NULL)",
  },
  {
    type: 'table',
    name: 'scrobbles',
    sql: "CREATE TABLE scrobbles (uri TEXT PRIMARY KEY NOT NULL, cid TEXT NOT NULL, did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE, rkey TEXT NOT NULL, revision TEXT NOT NULL, artist TEXT NOT NULL, track TEXT NOT NULL, album TEXT, listened_at TEXT NOT NULL CHECK(length(listened_at) = 30 AND substr(listened_at, 30, 1) = 'Z'), created_at TEXT NOT NULL, duration_seconds INTEGER CHECK(duration_seconds BETWEEN 1 AND 86400), recording_mbid TEXT, indexed_at TEXT NOT NULL, artist_key TEXT NOT NULL, track_key TEXT NOT NULL, album_key TEXT)",
  },
  {
    type: 'table',
    name: 'snapshot_blocks',
    sql: 'CREATE TABLE snapshot_blocks (did TEXT NOT NULL, cid TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(did,cid))',
  },
  {
    type: 'table',
    name: 'stats_cache',
    sql: "CREATE TABLE stats_cache (did TEXT NOT NULL, win TEXT NOT NULL CHECK(win IN ('all','7d','30d','365d')), lim INTEGER NOT NULL CHECK(lim BETWEEN 1 AND 100), as_of TEXT NOT NULL, lower TEXT, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(did,win,lim))",
  },
  {
    type: 'table',
    name: 'suppression',
    sql: 'CREATE TABLE suppression (did TEXT PRIMARY KEY NOT NULL, suppressed_at TEXT NOT NULL, settings_uri TEXT, settings_rev TEXT)',
  },
  {
    type: 'table',
    name: 'timers',
    sql: 'CREATE TABLE timers (name TEXT PRIMARY KEY NOT NULL, due_at INTEGER NOT NULL)',
  },
  {
    type: 'table',
    name: 'users',
    sql: "CREATE TABLE users (did TEXT PRIMARY KEY NOT NULL, handle TEXT, handle_checked_at_ms INTEGER, pds TEXT, joined_at TEXT NOT NULL, indexed_at TEXT, active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)), account_status TEXT NOT NULL DEFAULT 'unknown' CHECK(account_status IN ('unknown','active','deactivated','takendown','suspended','deleted','desynchronized','throttled','not_found')), max_rev TEXT, indexing_state TEXT NOT NULL DEFAULT 'recovering' CHECK(indexing_state IN ('current','recovering','stale','suppressed')), generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation) = 'integer' AND generation >= 0), stats_version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(stats_version) = 'integer' AND stats_version >= 0), last_snapshot_at_ms INTEGER, last_status_check_ms INTEGER, last_activity_ms INTEGER)",
  },
  {
    type: 'table',
    name: 'verified_commits',
    sql: 'CREATE TABLE verified_commits (did TEXT NOT NULL, commit_cid TEXT NOT NULL, rev TEXT NOT NULL, verified_at_ms INTEGER NOT NULL, PRIMARY KEY(did,commit_cid))',
  },
];

// Index structure from SQLite's own catalog, independent of the DDL text:
// [unique, partial, [[column, desc], ...]] for every key column.
const EXPECTED_INDEX_SHAPE: Record<string, [number, number, Array<[string, number]>]> = {
  follows_actor_subject: [
    0,
    0,
    [
      ['actor', 0],
      ['subject', 0],
      ['uri', 0],
    ],
  ],
  follows_subject_actor: [
    0,
    0,
    [
      ['subject', 0],
      ['actor', 0],
      ['uri', 0],
    ],
  ],
  hints_did: [0, 0, [['did', 0]]],
  hints_due: [0, 0, [['due_at', 0]]],
  repo_jobs_due: [
    0,
    0,
    [
      ['kind', 0],
      ['state', 0],
      ['due_at', 0],
      ['did', 0],
    ],
  ],
  scrobbles_global_time: [
    0,
    0,
    [
      ['listened_at', 1],
      ['uri', 1],
    ],
  ],
  scrobbles_owner_time: [
    0,
    0,
    [
      ['did', 0],
      ['listened_at', 1],
      ['uri', 1],
    ],
  ],
  scrobbles_stats: [
    0,
    0,
    [
      ['did', 0],
      ['artist_key', 0],
      ['track_key', 0],
      ['listened_at', 0],
    ],
  ],
  users_verified_handle: [1, 1, [['handle', 0]]],
};

const normalizeDdl = (sql: string) => sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

function indexShape(storage: DurableObjectStorage, table: string, index: string) {
  const list = storage.sql
    .exec<{ unique: number; partial: number }>(
      'SELECT "unique", partial FROM pragma_index_list(?) WHERE name = ?',
      table,
      index,
    )
    .one();
  const cols = storage.sql
    .exec<{ name: string; desc: number }>(
      'SELECT name, "desc" FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno',
      index,
    )
    .toArray()
    .map((c): [string, number] => [c.name, c.desc]);
  return [list.unique, list.partial, cols];
}

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
    // Deterministic: a fresh DO name, no clock and no network. scripts/test/
    // check-ts.test.ts deliberately inverts the next assertion in a disposable
    // copy (its negative control), so "expected 200 not to be 200" at this line
    // in a nested check-ts.sh run is that inversion working, not a flake here;
    // that test fails only if the nested run has other failures besides it.
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

      // The full frozen DDL (also proves the golden lists exactly the
      // expected tables and indexes, and that schema_migrations is pinned).
      expect(
        objects.map((o) => ({ type: o.type, name: o.name, sql: o.sql === null ? null : normalizeDdl(o.sql) })),
      ).toEqual(GOLDEN_DDL);
      expect(GOLDEN_DDL.filter((o) => o.type === 'table').map((o) => o.name)).toEqual(EXPECTED_TABLES);
      for (const o of objects.filter((x) => x.type === 'index')) {
        const table = GOLDEN_DDL.find((g) => g.name === o.name)?.sql.match(/ ON (\w+)\(/)?.[1] ?? '';
        expect([o.name, indexShape(state.storage, table, o.name)]).toEqual([o.name, EXPECTED_INDEX_SHAPE[o.name]]);
      }

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

  // M1.3.2/migration_rollback and M6.1.3/upgrade_failure: a valid statement
  // followed by invalid SQL persists neither; the version stays the previous
  // one and the existing database (DDL and data) survives, also across a
  // restart with the broken code.
  it('a migration whose second statement is invalid persists neither statement and keeps the previous schema version', async () => {
    const stub = stubFor('migrate-rollback');
    const broken = [
      ...MIGRATIONS,
      {
        version: 2,
        name: 'second',
        // A valid statement, then invalid SQL (incomplete input).
        statements: ['ALTER TABLE users ADD COLUMN nickname TEXT', "INSERT INTO timers(name, due_at) VALUES ('v2', 1"],
      },
    ];
    let before: { objects: MasterRow[]; data: Record<string, unknown[]> } | undefined;
    await runInDurableObject(stub, (instance: HarnessDO, state) => {
      expect(instance.migration).toEqual({ status: 'ready', version: 1 });
      const db = doDb(state.storage);
      // Existing data that the failed upgrade must not delete.
      db.run("INSERT INTO users(did, joined_at) VALUES ('did:plc:alice', '2026-01-15T12:00:00.000000000Z')");
      db.run("INSERT INTO timers(name, due_at) VALUES ('drain', 5)");
      before = { objects: appObjects(state.storage), data: dumpAll(state.storage) };

      expect(() => migrate(state.storage, broken)).toThrow(/syntax error|incomplete input/);

      // Neither the valid first statements nor the invalid one persisted.
      expect(columns(state.storage, 'users')).not.toContain('nickname');
      expect(db.all("SELECT name FROM timers WHERE name = 'v2'")).toEqual([]);
      // The ledger still says version 1, and nothing else changed.
      expect(db.all('SELECT version, name FROM schema_migrations ORDER BY version')).toEqual([
        { version: 1, name: 'initial_workers_schema' },
      ]);
      expect({ objects: appObjects(state.storage), data: dumpAll(state.storage) }).toEqual(before);
      // The current code still sees a ready version-1 schema.
      expect(migrate(state.storage)).toEqual({ status: 'ready', version: 1 });
    });

    // After a restart (eviction keeps storage) the database is the same and
    // the old code reports ready at version 1.
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance: HarnessDO, state) => {
      expect(instance.migration).toEqual({ status: 'ready', version: 1 });
      expect({ objects: appObjects(state.storage), data: dumpAll(state.storage) }).toEqual(before);
      // Retrying the broken upgrade fails the same way and still changes nothing.
      expect(() => migrate(state.storage, broken)).toThrow(/syntax error|incomplete input/);
      expect({ objects: appObjects(state.storage), data: dumpAll(state.storage) }).toEqual(before);
    });
    const res = await exports.default.fetch('https://harness.test/harness/migrate-rollback');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ migration: { status: 'ready', version: 1 } });

    // Control on a separate DO: with a valid second statement the same first
    // statement does persist, so the rollback above is what removed it.
    await runInDurableObject(stubFor('migrate-rollback-control'), (_instance: HarnessDO, state) => {
      const fixed = [
        ...MIGRATIONS,
        {
          version: 2,
          name: 'second',
          statements: [
            'ALTER TABLE users ADD COLUMN nickname TEXT',
            "INSERT INTO timers(name, due_at) VALUES ('v2', 1)",
          ],
        },
      ];
      expect(migrate(state.storage, fixed)).toEqual({ status: 'ready', version: 2 });
      expect(columns(state.storage, 'users')).toContain('nickname');
      expect(doDb(state.storage).all('SELECT name, due_at FROM timers')).toEqual([{ name: 'v2', due_at: 1 }]);
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
