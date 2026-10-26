// Migrations (ADR 0004 §6; ADR 0005 §3.2) over the Node harness
// (worker/test/node/support/with-index.ts, N4-04): each name is a migrated
// SQLite file of this test file's IndexSet, which runs `migrate` whenever the
// file is opened, as the process does at startup; `fileIndexes().reopen(name)`
// is the restart (formerly evictDurableObject), and `fileIndexes().migrations(name)`
// the result of each open (formerly the harness DO constructor's). The
// readiness the harness Worker reported is asked of the production
// /health/ready handler over an IndexCore on that database.

import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { MigrationLedgerError, migrate } from '../../src/do/migrate';
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from '../../src/do/schema';
import { ready } from '../../src/http/health';
import type { RequestCtx } from '../../src/http/types';
import type { SqliteDb } from '../../src/node/sqlite-db';
import { closeFileIndexes, fileIndexes, indexCore, schemaAll } from '../node/support/with-index';

afterAll(() => closeFileIndexes());

/** The named database of this test file (created and migrated on first open). */
const stubFor = (name: string): SqliteDb => fileIndexes().get(name);
/** The migration result of the latest open of `name` (what the restarted process saw). */
const lastMigration = (name: string) => fileIndexes().migrations(name).at(-1);

/** GET `url` through the production /health/ready handler, with an IndexCore over `name`'s database as the index. */
async function readyOf(name: string, url: string): Promise<Response> {
  const { core } = indexCore(stubFor(name));
  return ready(new Request(url), { index: core, requestId: 'req-migrate' } as unknown as RequestCtx);
}

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

function indexShape(db: Db, table: string, index: string) {
  const [list] = schemaAll<{ unique: number; partial: number }>(
    db,
    'SELECT "unique", partial FROM pragma_index_list(?) WHERE name = ?',
    table,
    index,
  );
  const cols = schemaAll<{ name: string; desc: number }>(
    db,
    'SELECT name, "desc" FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno',
    index,
  ).map((c): [string, number] => [c.name, c.desc]);
  return [list?.unique, list?.partial, cols];
}

interface MasterRow {
  type: string;
  name: string;
  sql: string | null;
}

function appObjects(db: Db): MasterRow[] {
  return db.all<MasterRow>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
  );
}

function dumpAll(db: Db): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const table of [...TABLES, 'schema_migrations']) {
    out[table] = db.all(`SELECT * FROM ${table} ORDER BY 1`);
  }
  return out;
}

function columns(db: Db, table: string): string[] {
  return schemaAll<{ name: string }>(db, 'SELECT name FROM pragma_table_info(?) ORDER BY cid', table).map(
    (r) => r.name,
  );
}

const SEEDED_BY_MIGRATION_1 = ['indexing_status', 'backfill_generation', 'ingest_checkpoint'];

/** The ledger a database fully migrated by this code holds: one row per migration. */
const LEDGER = MIGRATIONS.map((m) => ({ version: m.version, name: m.name }));
/** The version a synthetic migration written by newer code would carry. */
const NEXT = SCHEMA_VERSION + 1;

/** The three singleton rows migration 1 inserts, unchanged by later migrations. */
function expectMigration1Seeds(db: Db): void {
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
}

/**
 * Makes the database look written by newer code that this code cannot run
 * on: a ledger row past SCHEMA_VERSION and `schema_compat` raised to it, as
 * only a non-additive migration may do (ADR 0005 §3.2). Raising the
 * compatibility floor keeps the case too_new under the compatibility rule too.
 */
function writeByIncompatibleNewerCode(db: Db, version: number): void {
  db.run('INSERT INTO schema_migrations(version, name) VALUES (?, ?)', version, 'from_newer_code');
  db.run('UPDATE schema_compat SET min_compatible_version = ?', version);
}

describe('migrate', () => {
  it('fresh DO applies migration 1 and seeds indexing_status/backfill_generation/ingest_checkpoint', async () => {
    const db = stubFor('migrate-fresh');

    // Through the production readiness route: the open migrated.
    // Deterministic: a fresh database, no clock and no network. scripts/test/
    // check-ts.test.ts deliberately inverts the next assertion in a disposable
    // copy (its negative control), so "expected 200 not to be 200" at this line
    // in a nested check-ts.sh run is that inversion working, not a flake here;
    // that test fails only if the nested run has other failures besides it.
    const res = await readyOf('migrate-fresh', 'https://harness.test/harness/migrate-fresh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });

    // The open applied every migration, migration 1 first, and
    // migration 1 seeded its three singleton rows; every other table starts
    // empty (schema_compat holds migration 2's row, schema-v2.test.ts).
    {
      expect(lastMigration('migrate-fresh')).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      const ledger = db.all('SELECT version, name FROM schema_migrations ORDER BY version');
      expect(ledger).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
      expect(ledger[0]).toEqual({ version: 1, name: 'initial_workers_schema' });
      const objects = appObjects(db);
      const names = (type: string) => objects.filter((o) => o.type === type).map((o) => o.name);
      expect(EXPECTED_TABLES.filter((t) => !names('table').includes(t))).toEqual([]);
      expect(EXPECTED_INDEXES.filter((i) => !names('index').includes(i))).toEqual([]);
      expectMigration1Seeds(db);
      for (const table of TABLES) {
        if ([...SEEDED_BY_MIGRATION_1, 'schema_migrations', 'schema_compat'].includes(table)) continue;
        expect([table, db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)]).toEqual([table, { n: 0 }]);
      }
    }

    // Migration 1 alone, applied to a wiped database: the frozen DDL of ADR 0004 §6.1.
    {
      const db = fileIndexes().reset('migrate-fresh-v1');
      expect(appObjects(db)).toEqual([]);
      expect(migrate(db, MIGRATIONS.slice(0, 1))).toEqual({ status: 'ready', version: 1 });

      const objects = appObjects(db);
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
        expect([o.name, indexShape(db, table, o.name)]).toEqual([o.name, EXPECTED_INDEX_SHAPE[o.name]]);
      }

      expect(db.all('SELECT * FROM schema_migrations')).toEqual([{ version: 1, name: 'initial_workers_schema' }]);
      expectMigration1Seeds(db);
      // Every other table starts empty.
      for (const table of EXPECTED_TABLES) {
        if ([...SEEDED_BY_MIGRATION_1, 'schema_migrations'].includes(table)) continue;
        expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)).toEqual({ n: 0 });
      }

      // Column sets from ADR §6.1 (extensions included, dropped columns absent).
      expect(columns(db, 'users')).toEqual([
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
      expect(columns(db, 'scrobbles')).toContain('rkey');
      expect(columns(db, 'scrobbles')).not.toContain('confirmed');
      expect(columns(db, 'follows')).not.toContain('confirmed');
      expect(columns(db, 'record_state')).toEqual([
        'uri',
        'did',
        'collection',
        'revision',
        'cid',
        'state',
        'reason',
        'verified_at',
      ]);
      expect(columns(db, 'suppression')).toEqual(['did', 'suppressed_at', 'settings_uri', 'settings_rev']);
      expect(columns(db, 'repo_jobs')).toEqual([
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
      expect(columns(db, 'ingest_checkpoint')).toEqual([
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
      expect(columns(db, 'hints')).toEqual([
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
      expect(columns(db, 'stats_cache')).toEqual(['did', 'win', 'lim', 'as_of', 'lower', 'version', 'body']);

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
    }
  });

  it('schema newer than code reports too_new', async () => {
    const name = 'migrate-too-new';
    const newer = NEXT;
    writeByIncompatibleNewerCode(stubFor(name), newer);
    {
      const db = stubFor(name);
      const before = { objects: appObjects(db), data: dumpAll(db) };
      expect(migrate(db)).toEqual({ status: 'too_new', version: newer });
      // Nothing was touched: no DDL, no ledger rows, no data.
      expect({ objects: appObjects(db), data: dumpAll(db) }).toEqual(before);
    }

    // A restarted process (migrate at open) reports too_new too, which
    // /health/ready turns into 503.
    const db = fileIndexes().reopen(name);
    expect(lastMigration(name)).toEqual({ status: 'too_new', version: newer });
    expect(await indexCore(db).core.ready()).toEqual({ status: 'too_new', version: newer });
    const res = await readyOf(name, 'https://harness.test/harness/migrate-too-new');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'not_ready' } });
  });

  it('re-running migrate is a no-op', async () => {
    const name = 'migrate-rerun';
    {
      const db = stubFor(name);
      db.run("INSERT INTO users(did, joined_at) VALUES ('did:plc:bob', '2026-01-15T12:00:00.000000000Z')");
      db.run('UPDATE backfill_generation SET last_generation = 7');
      db.run('UPDATE ingest_checkpoint SET pending_gap = 0, cursor = 1768478400000000');

      const before = { objects: appObjects(db), data: dumpAll(db) };
      expect(migrate(db)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      expect(migrate(db)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      expect({ objects: appObjects(db), data: dumpAll(db) }).toEqual(before);
      expect(db.all('SELECT * FROM schema_migrations ORDER BY version')).toEqual(LEDGER);
      // Seeds were not re-inserted over changed state.
      expect(db.all('SELECT * FROM indexing_status')).toHaveLength(1);
      expect(db.all('SELECT * FROM schema_compat')).toHaveLength(1);
      expect(db.one('SELECT last_generation FROM backfill_generation')).toEqual({ last_generation: 7 });
    }

    // The migrate at reopen (a restart) is also a no-op on the same file.
    {
      const db = fileIndexes().reopen(name);
      expect(lastMigration(name)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      expect(db.all('SELECT did FROM users')).toEqual([{ did: 'did:plc:bob' }]);
      expect(db.one('SELECT pending_gap, cursor FROM ingest_checkpoint')).toEqual({
        pending_gap: 0,
        cursor: 1768478400000000,
      });
    }
  });

  it('a ledger written by different code is refused and rolls back', async () => {
    const db = stubFor('migrate-ledger-mismatch');
    db.run("UPDATE schema_migrations SET name = 'someone_else' WHERE version = 1");
    const before = dumpAll(db);
    const next = [...MIGRATIONS, { version: NEXT, name: 'next', statements: ['CREATE TABLE extra (x INTEGER)'] }];
    expect(() => migrate(db, next)).toThrow(MigrationLedgerError);
    expect(appObjects(db).some((o) => o.name === 'extra')).toBe(false);
    expect(dumpAll(db)).toEqual(before);
  });

  // M1.3.2/migration_rollback and M6.1.3/upgrade_failure: a valid statement
  // followed by invalid SQL persists neither; the version stays the previous
  // one and the existing database (DDL and data) survives, also across a
  // restart with the broken code.
  it('a migration whose second statement is invalid persists neither statement and keeps the previous schema version', async () => {
    const name = 'migrate-rollback';
    const broken = [
      ...MIGRATIONS,
      {
        version: NEXT,
        name: 'next',
        // A valid statement, then invalid SQL (incomplete input).
        statements: ['ALTER TABLE users ADD COLUMN nickname TEXT', "INSERT INTO timers(name, due_at) VALUES ('v2', 1"],
      },
    ];
    let before: { objects: MasterRow[]; data: Record<string, unknown[]> } | undefined;
    {
      const db = stubFor(name);
      expect(lastMigration(name)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      // Existing data that the failed upgrade must not delete.
      db.run("INSERT INTO users(did, joined_at) VALUES ('did:plc:alice', '2026-01-15T12:00:00.000000000Z')");
      db.run("INSERT INTO timers(name, due_at) VALUES ('drain', 5)");
      before = { objects: appObjects(db), data: dumpAll(db) };

      expect(() => migrate(db, broken)).toThrow(/syntax error|incomplete input/);

      // Neither the valid first statements nor the invalid one persisted.
      expect(columns(db, 'users')).not.toContain('nickname');
      expect(db.all("SELECT name FROM timers WHERE name = 'v2'")).toEqual([]);
      // The ledger still ends at SCHEMA_VERSION, and nothing else changed.
      expect(db.all('SELECT version, name FROM schema_migrations ORDER BY version')).toEqual(LEDGER);
      expect({ objects: appObjects(db), data: dumpAll(db) }).toEqual(before);
      // The current code still sees a ready schema at its own version.
      expect(migrate(db)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
    }

    // After a restart (reopening the same file) the database is the same and
    // the old code reports ready at its version.
    {
      const db = fileIndexes().reopen(name);
      expect(lastMigration(name)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      expect({ objects: appObjects(db), data: dumpAll(db) }).toEqual(before);
      // Retrying the broken upgrade fails the same way and still changes nothing.
      expect(() => migrate(db, broken)).toThrow(/syntax error|incomplete input/);
      expect({ objects: appObjects(db), data: dumpAll(db) }).toEqual(before);
    }
    const res = await readyOf(name, 'https://harness.test/harness/migrate-rollback');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });

    // Control on a separate database: with a valid second statement the same first
    // statement does persist, so the rollback above is what removed it.
    {
      const db = stubFor('migrate-rollback-control');
      const fixed = [
        ...MIGRATIONS,
        {
          version: NEXT,
          name: 'next',
          statements: [
            'ALTER TABLE users ADD COLUMN nickname TEXT',
            "INSERT INTO timers(name, due_at) VALUES ('v2', 1)",
          ],
        },
      ];
      expect(migrate(db, fixed)).toEqual({ status: 'ready', version: NEXT });
      expect(columns(db, 'users')).toContain('nickname');
      expect(db.all('SELECT name, due_at FROM timers')).toEqual([{ name: 'v2', due_at: 1 }]);
    }
  });

  it('a later migration applies once, atomically, after migration 1', async () => {
    {
      const db = stubFor('migrate-next');
      const broken = [
        ...MIGRATIONS,
        { version: NEXT, name: 'next', statements: ['CREATE TABLE extra (x INTEGER)', 'THIS IS NOT SQL'] },
      ];
      expect(() => migrate(db, broken)).toThrow();
      expect(appObjects(db).some((o) => o.name === 'extra')).toBe(false);
      expect(db.exec('SELECT max(version) AS v FROM schema_migrations')).toEqual([{ v: SCHEMA_VERSION }]);

      // The synthetic next migration also raises the compatibility floor (as
      // only a non-additive migration may, ADR 0005 §3.2), so the code that
      // knows only MIGRATIONS cannot run on the result.
      const good = [
        ...MIGRATIONS,
        {
          version: NEXT,
          name: 'next',
          statements: ['CREATE TABLE extra (x INTEGER)', `UPDATE schema_compat SET min_compatible_version = ${NEXT}`],
        },
      ];
      expect(migrate(db, good)).toEqual({ status: 'ready', version: NEXT });
      expect(migrate(db, good)).toEqual({ status: 'ready', version: NEXT });
      expect(db.exec('SELECT version, name FROM schema_migrations ORDER BY version')).toEqual([
        ...LEDGER,
        { version: NEXT, name: 'next' },
      ]);
      expect(LEDGER[0]).toEqual({ version: 1, name: 'initial_workers_schema' });
      // Code that only knows MIGRATIONS now sees a newer schema.
      expect(migrate(db)).toEqual({ status: 'too_new', version: NEXT });
    }
  });

  // ADR 0005 §3.2, §6.4 (N1-10): migration 2 makes the code version 2, and a
  // database at that version is ready for that code, across restarts.
  it('SCHEMA_VERSION is 2 and a v2 database opened by v2 code is ready', async () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(MIGRATIONS.map((m) => [m.version, m.name])).toEqual([
      [1, 'initial_workers_schema'],
      [2, 'node_schema'],
    ]);

    const name = 'migrate-v2-ready';
    const res = await readyOf(name, 'https://harness.test/harness/migrate-v2-ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });

    let before: { objects: MasterRow[]; data: Record<string, unknown[]> } | undefined;
    {
      expect(lastMigration(name)).toEqual({ status: 'ready', version: 2 });
      const db = stubFor(name);
      expect(db.all('SELECT version, name FROM schema_migrations ORDER BY version')).toEqual([
        { version: 1, name: 'initial_workers_schema' },
        { version: 2, name: 'node_schema' },
      ]);
      expect(db.all('SELECT min_compatible_version FROM schema_compat')).toEqual([{ min_compatible_version: 2 }]);
      // A row in a migration-2 table survives reopening.
      db.run(
        "INSERT INTO accounts(did, username, created_at_ms, updated_at_ms) VALUES ('did:plc:alice', 'alice.test', 1, 1)",
      );
      before = { objects: appObjects(db), data: dumpAll(db) };
      expect(migrate(db)).toEqual({ status: 'ready', version: 2 });
      expect({ objects: appObjects(db), data: dumpAll(db) }).toEqual(before);
    }

    // Reopened by the same code (a restart keeps the file): ready at 2, untouched.
    {
      const db = fileIndexes().reopen(name);
      expect(lastMigration(name)).toEqual({ status: 'ready', version: 2 });
      expect(fileIndexes().migrations(name)).toHaveLength(2);
      expect({ objects: appObjects(db), data: dumpAll(db) }).toEqual(before);
      expect(db.all('SELECT did, username FROM accounts')).toEqual([{ did: 'did:plc:alice', username: 'alice.test' }]);
    }
  });
});
