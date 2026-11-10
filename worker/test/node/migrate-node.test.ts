// migrate() over the Node Db (ADR 0005 §3.2; N1-01): one transaction on a
// fresh file, newer databases left untouched, the schema_compat rule, failing
// migrations rolled back, and durability across close and reopen. The
// compatibility cases use synthetic migration lists, so they do not depend on
// migration 2 (N1-10).

import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationLedgerError, type MigrationTarget, migrate } from '../../src/do/migrate';
import { MIGRATIONS, type Migration, SCHEMA_VERSION, TABLE_CLASS, TABLES } from '../../src/do/schema';
import { openSqliteDb, type SqliteDb } from '../../src/node/sqlite-db';
import { dumpDb, makeTempDir, reopen, TEST_BUSY_TIMEOUT_MS, withMigratedDb } from './support/node-db';

const T0 = '2026-01-15T12:00:00.000000000Z';

const M1: Migration = { version: 1, name: 'm1', statements: ['CREATE TABLE a(id INTEGER PRIMARY KEY, v TEXT)'] };
const M2: Migration = { version: 2, name: 'm2', statements: ['CREATE TABLE b(id INTEGER PRIMARY KEY)'] };
const M2_COMPAT: Migration = {
  version: 2,
  name: 'm2_compat',
  statements: [
    'CREATE TABLE schema_compat(min_compatible_version INTEGER NOT NULL)',
    'INSERT INTO schema_compat(min_compatible_version) VALUES (1)',
  ],
};
const M3: Migration = { version: 3, name: 'm3', statements: ['ALTER TABLE a ADD COLUMN w TEXT'] };

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** A fresh file database (not migrated), closed and removed after the test. */
function freshDb(): SqliteDb {
  const dir = makeTempDir('atmusic-migrate-');
  const db = openSqliteDb(join(dir, 'atmusic.db'), { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS, create: true });
  cleanup.push(() => {
    try {
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return db;
}

function ledger(db: SqliteDb) {
  return db.all<{ version: number; name: string }>('SELECT version, name FROM schema_migrations ORDER BY version');
}

/** The target as migrate sees it, recording the transaction depth of every exec. */
function recordingTarget(db: SqliteDb) {
  const events: Array<{ kind: 'tx' } | { kind: 'exec'; sql: string; depth: number }> = [];
  let depth = 0;
  const target: MigrationTarget = {
    exec: (sql, ...params) => {
      events.push({ kind: 'exec', sql, depth });
      return db.exec(sql, ...params);
    },
    tx: (fn) => {
      events.push({ kind: 'tx' });
      depth++;
      try {
        return db.tx(fn);
      } finally {
        depth--;
      }
    },
  };
  return { target, events };
}

describe('migrate over node:sqlite', () => {
  it('applies the exact allocated schema-57 proposal from schema 56 through the Node authorizer', () => {
    const db = freshDb();
    const ddl = readFileSync(
      new URL('../../../docs/planning/finding32-source-origin-revised57-proposal.sql', import.meta.url),
      'utf8',
    );
    const statements = ddl
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    const migration = MIGRATIONS.at(-1)!;
    expect(migration).toMatchObject({ version: 57, name: 'api_love_recipient_proof' });
    expect(createHash('sha256').update(ddl).digest('hex')).toBe(
      '54dc2d344097763e055b0f8f7f10d8f85993ccdaf0e31620b699726c35256a96',
    );
    expect(statements).toHaveLength(17);
    expect(migration.statements).toEqual(statements);
    expect(migrate(db, MIGRATIONS.slice(0, 56))).toEqual({ status: 'ready', version: 56 });
    expect(db.exec('SELECT max(version) AS version FROM schema_migrations')).toEqual([{ version: 56 }]);
    expect(migrate(db)).toEqual({ status: 'ready', version: 57 });

    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'love_api_%' ORDER BY name",
    );
    expect(tables).toHaveLength(8);
    const indexes = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'love_api_%' ORDER BY name",
    );
    expect(indexes).toHaveLength(9);
    expect(db.exec('SELECT max(version) AS version FROM schema_migrations')).toEqual([{ version: 57 }]);
    const verify = new DatabaseSync(':memory:');
    try {
      verify.exec('PRAGMA foreign_keys=ON');
      for (const { sql } of db.all<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL ORDER BY rowid",
      ))
        verify.exec(sql);
      expect(verify.prepare('PRAGMA table_info(love_api_bindings)').all()).toContainEqual(
        expect.objectContaining({ name: 'api_origin', notnull: 1, dflt_value: null }),
      );
      expect(verify.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      verify.close();
    }
  });

  it('migration 30 creates durable per-generation pull state, staging and tombstone tables', () => {
    const db = freshDb();
    migrate(db);
    expect(SCHEMA_VERSION).toBe(57);
    for (const table of [
      'linked_pull_state',
      'linked_pull_items',
      'live_pending_removal_events',
      'live_pending_removal_reconcile',
    ] as const) {
      expect(TABLES).toContain(table);
      expect(db.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table)).toEqual({
        name: table,
      });
    }
    expect(
      db.one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='linked_pull_state'")!.sql,
    ).toContain('love_boundary_ms');
    expect(TABLE_CLASS.linked_pull_state).toBe('non-derived');
    expect(TABLE_CLASS.linked_pull_items).toBe('non-derived');
    expect(
      db.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND name='operations_record_target'"),
    ).toEqual({
      name: 'operations_record_target',
    });
    expect(
      db.one<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='love_import_bridges_source_class'",
      ),
    ).toEqual({
      sql: "CREATE INDEX love_import_bridges_source_class ON love_import_bridges(did,uri,incarnation_key,state,(CASE WHEN source_service IN ('lastfm','lastfm_api','lastfm_json') THEN 1 WHEN source_service IN ('listenbrainz','listenbrainz_api','listenbrainz_zip') THEN 2 ELSE 0 END))",
    });
    expect(TABLE_CLASS.linked_pull_receipt_seed).toBe('non-derived');
    expect(TABLE_CLASS.linked_pull_projection_scan).toBe('non-derived');
    expect(TABLES).toContain('listenbrainz_deletes');
    expect(TABLE_CLASS.listenbrainz_deletes).toBe('non-derived');
    expect(TABLE_CLASS.live_record_evidence).toBe('non-derived');
    expect(TABLE_CLASS.live_acceptance_candidates).toBe('non-derived');
    expect(TABLE_CLASS.live_pending_removals).toBe('non-derived');
    expect(TABLE_CLASS.live_pending_removal_events).toBe('non-derived');
    expect(TABLE_CLASS.live_pending_removal_reconcile).toBe('non-derived');
    expect(
      db.one<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='forward_outbox_love_heads'",
      ),
    ).toEqual({ name: 'forward_outbox_love_heads' });
  });

  it('migration 54 adds the source-class index to a populated v53 database without rewriting bridges', () => {
    const db = freshDb();
    expect(migrate(db, MIGRATIONS.slice(0, 53))).toEqual({ status: 'ready', version: 53 });
    for (const [operation, source, state] of [
      ['bound-null', null, 'bound'],
      ['bound-junk', 'spotify', 'bound'],
      ['consumed-lb', 'listenbrainz_zip', 'consumed'],
    ] as const) {
      db.run(
        `INSERT INTO love_import_bridges(did,operation_id,uri,incarnation_key,source_service,state,created_at_ms)
         VALUES('did:plc:alice',?,?,?, ?,?,1)`,
        operation,
        `at://did:plc:alice/com.example.atmusic.love/${operation}`,
        `inc-${operation}`,
        source,
        state,
      );
    }
    const before = db.all('SELECT * FROM love_import_bridges ORDER BY operation_id');
    expect(migrate(db, MIGRATIONS.slice(0, 54))).toEqual({ status: 'ready', version: 54 });
    expect(db.all('SELECT * FROM love_import_bridges ORDER BY operation_id')).toEqual(before);
    const plan = db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT 1 FROM love_import_bridges INDEXED BY love_import_bridges_source_class
       WHERE did=? AND uri=? AND incarnation_key=? AND state='bound'
         AND (CASE WHEN source_service IN ('lastfm','lastfm_api','lastfm_json') THEN 1
                   WHEN source_service IN ('listenbrainz','listenbrainz_api','listenbrainz_zip') THEN 2 ELSE 0 END) IN (0,?) LIMIT 1`,
        'did:plc:alice',
        'at://did:plc:alice/com.example.atmusic.love/bound-null',
        'inc-bound-null',
        2,
      )
      .map((row) => row.detail)
      .join(' | ');
    expect(plan).toContain('COVERING INDEX love_import_bridges_source_class');
    expect(plan).toContain('<expr>=?');
  });

  it('migration 55 upgrades populated v54 links and outbox without seeding coverage state', () => {
    const db = freshDb();
    expect(migrate(db, MIGRATIONS.slice(0, 54))).toEqual({ status: 'ready', version: 54 });
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
       VALUES('active','did:plc:alice','lastfm','alice',X'00','key',1,1),
             ('disabled','did:plc:bob','listenbrainz','bob',X'00','key',2,2),
             ('revoked','did:plc:carol','lastfm','carol',X'00','key',3,3)`,
    );
    db.run("UPDATE linked_accounts SET forward_scrobbles=0 WHERE id='disabled'");
    db.run("UPDATE linked_accounts SET status='revoked' WHERE id='revoked'");
    for (const [id, linkId] of [
      ['f-active', 'active'],
      ['f-disabled', 'disabled'],
      ['f-revoked', 'revoked'],
    ] as const) {
      db.run(
        `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms)
         VALUES(?,?,?,'scrobble',?,'{}','sent',0,1,1,1)`,
        id,
        linkId,
        `did:plc:${linkId}`,
        id,
      );
    }
    const before = db.all(
      'SELECT id,link_id,generation,kind,dedupe_key,payload_json,state,created_at_ms FROM forward_outbox ORDER BY id',
    );
    expect(migrate(db, MIGRATIONS.slice(0, 55))).toEqual({ status: 'ready', version: 55 });
    expect(
      db.all(
        'SELECT id,link_id,generation,kind,dedupe_key,payload_json,state,created_at_ms FROM forward_outbox ORDER BY id',
      ),
    ).toEqual(before);
    expect(db.all('SELECT * FROM forward_receipts')).toEqual([]);
    expect(db.all('SELECT * FROM forward_link_gaps')).toEqual([]);
  });

  it('all MIGRATIONS apply in one transaction on a fresh file and schema_migrations lists every version', () => {
    const db = freshDb();
    const { target, events } = recordingTarget(db);

    expect(migrate(target)).toEqual({ status: 'ready', version: SCHEMA_VERSION });

    // One transaction, and every statement (DDL and ledger rows) ran inside it.
    expect(events.filter((e) => e.kind === 'tx')).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'tx' });
    const execs = events.filter((e) => e.kind === 'exec');
    const statementCount = MIGRATIONS.reduce((n, m) => n + m.statements.length, 0);
    expect(execs.length).toBeGreaterThanOrEqual(statementCount + MIGRATIONS.length);
    for (const e of execs) expect(e.depth, e.sql.slice(0, 60)).toBe(1);
    expect(db.raw.isTransaction).toBe(false);

    expect(ledger(db)).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((r) => r.name);
    for (const table of TABLES) expect(tables).toContain(table);
    expect(tables).toContain('schema_migrations');

    // Re-running is a no-op that changes nothing.
    const before = dumpDb(db);
    expect(migrate(db)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
    expect(dumpDb(db)).toEqual(before);
  });

  it('migration 4 adds the delete target index to a populated v3 file without changing rows or the compatibility floor', async () => {
    await withMigratedDb(
      (db) => {
        db.run(`INSERT INTO operations
        (id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms,follow_proof_json)
        VALUES ('kept','did:plc:alice','scrobble.delete','web',0,'com.example.atmusic.scrobble','r01','failed',1,1,1,'[]')`);
        const before = dumpDb(db);
        expect(migrate(db, MIGRATIONS.slice(0, 4))).toEqual({ status: 'ready', version: 4 });
        expect(ledger(db)).toEqual([
          { version: 1, name: 'initial_workers_schema' },
          { version: 2, name: 'node_schema' },
          { version: 3, name: 'follow_proof_baseline' },
          { version: 4, name: 'scrobble_delete_target_index' },
        ]);
        const after = dumpDb(db);
        expect({ ...after.tables, schema_migrations: before.tables.schema_migrations }).toEqual(before.tables);
        expect(db.one("SELECT sql FROM sqlite_master WHERE name='operations_scrobble_delete_target'")).toEqual({
          sql: "CREATE INDEX operations_scrobble_delete_target ON operations(did,rkey) WHERE kind = 'scrobble.delete'",
        });
        expect(db.all('SELECT min_compatible_version FROM schema_compat')).toEqual([{ min_compatible_version: 2 }]);
        for (const oldVersion of [2, 3]) {
          expect(migrate(db, MIGRATIONS.slice(0, oldVersion))).toEqual({ status: 'ready', version: 4 });
          expect(dumpDb(db)).toEqual(after);
        }
        const again = reopen(db, { migrate: false });
        expect(migrate(again, MIGRATIONS.slice(0, 4))).toEqual({ status: 'ready', version: 4 });
        expect(dumpDb(again)).toEqual(after);
      },
      { migrations: MIGRATIONS.slice(0, 3) },
    );
  });

  it('migration 8 upgrades a persisted zero-attempt reauth row as unknown, not unsent', async () => {
    await withMigratedDb(
      (db) => {
        db.run(
          `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,record_json,digest,state,attempts,
             due_at,last_error,result_uri,import_job_id,created_at_ms,updated_at_ms,send_started_at_ms)
           VALUES('legacy','did:plc:alice','scrobble.create','import',1,'com.example.atmusic.scrobble',
             '3mchjvhag222q','{"$type":"com.example.atmusic.scrobble"}','legacy-digest','blocked',0,
             1,'reauth_required',NULL,'legacy-job',1,1,NULL)`,
        );
        expect(migrate(db)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
        expect(
          db.one('SELECT state,attempts,send_started_at_ms,last_error,send_state FROM operations WHERE id=?', 'legacy'),
        ).toEqual({
          state: 'blocked',
          attempts: 0,
          send_started_at_ms: null,
          last_error: 'reauth_required',
          send_state: 'unknown',
        });
      },
      { migrations: MIGRATIONS.slice(0, 7) },
    );
  });

  it('a database with a newer schema version reports too_new and is not modified', async () => {
    await withMigratedDb(
      (db) => {
        db.run("INSERT INTO a(v) VALUES ('kept')");
        const before = dumpDb(db);

        // Code that knows only M1 opens a version-2 database with no schema_compat table.
        expect(migrate(db, [M1])).toEqual({ status: 'too_new', version: 2 });
        expect(dumpDb(db)).toEqual(before);
        expect(db.raw.isTransaction).toBe(false);

        // Also after a restart (reopen without migrating, then the old code's migrate).
        const again = reopen(db, { migrate: false });
        expect(migrate(again, [M1])).toEqual({ status: 'too_new', version: 2 });
        expect(migrate(again, [])).toEqual({ status: 'too_new', version: 2 });
        expect(dumpDb(again)).toEqual(before);
      },
      { migrations: [M1, M2] },
    );
  });

  it('a database at a newer version whose schema_compat.min_compatible_version is at most the code version opens ready; a larger min_compatible_version reports too_new', async () => {
    await withMigratedDb(
      (db) => {
        db.run("INSERT INTO a(v, w) VALUES ('row', 'new column')");
        const before = dumpDb(db);
        expect(db.all('SELECT min_compatible_version AS v FROM schema_compat')).toEqual([{ v: 1 }]);

        // Code at version 1 on a version-3 database with min_compatible_version 1: ready, untouched.
        expect(migrate(db, [M1])).toEqual({ status: 'ready', version: 3 });
        expect(dumpDb(db)).toEqual(before);
        // The old code still reads and writes the tables it knows.
        db.run("INSERT INTO a(v) VALUES ('from old code')");
        expect(db.all('SELECT v FROM a ORDER BY id')).toEqual([{ v: 'row' }, { v: 'from old code' }]);

        // Code at version 2 (min 1 <= 2) is ready too.
        expect(migrate(db, [M1, M2_COMPAT])).toEqual({ status: 'ready', version: 3 });

        // A min_compatible_version above the code version is too_new, and nothing changes.
        db.run('UPDATE schema_compat SET min_compatible_version = 2');
        const raised = dumpDb(db);
        expect(migrate(db, [M1])).toEqual({ status: 'too_new', version: 3 });
        expect(dumpDb(db)).toEqual(raised);
        // Equal to the code version is compatible.
        expect(migrate(db, [M1, M2_COMPAT])).toEqual({ status: 'ready', version: 3 });
        db.run('UPDATE schema_compat SET min_compatible_version = 3');
        expect(migrate(db, [M1, M2_COMPAT])).toEqual({ status: 'too_new', version: 3 });
        expect(migrate(db, [M1, M2_COMPAT, M3])).toEqual({ status: 'ready', version: 3 });

        // A compatible newer database written by different code (renamed m1) is refused.
        db.run('UPDATE schema_compat SET min_compatible_version = 1');
        const other: Migration = { ...M1, name: 'other_m1' };
        expect(() => migrate(db, [other])).toThrow(MigrationLedgerError);
        expect(db.raw.isTransaction).toBe(false);
      },
      { migrations: [M1, M2_COMPAT, M3] },
    );
  });

  it('a failing migration statement leaves schema_migrations and every table unchanged', async () => {
    const broken: Migration = {
      version: 2,
      name: 'broken',
      statements: [
        'CREATE TABLE b(id INTEGER PRIMARY KEY)',
        "INSERT INTO a(v) VALUES ('written by the broken migration')",
        'CREATE TABLE a(id INTEGER)', // already exists: fails after two good statements
      ],
    };
    await withMigratedDb(
      (db) => {
        db.run("INSERT INTO a(v) VALUES ('kept')");
        const before = dumpDb(db);
        expect(() => migrate(db, [M1, broken, M3])).toThrow(/table a already exists/);
        expect(dumpDb(db)).toEqual(before);
        expect(ledger(db)).toEqual([{ version: 1, name: 'm1' }]);
        expect(db.raw.isTransaction).toBe(false);
        // The fixed list applies afterwards.
        expect(migrate(db, [M1, M2, M3])).toEqual({ status: 'ready', version: 3 });
        expect(ledger(db).map((r) => r.version)).toEqual([1, 2, 3]);
      },
      { migrations: [M1] },
    );

    // On a fresh file a failing first migration leaves no table at all, not even the ledger.
    const db = freshDb();
    const failing: Migration = {
      version: 1,
      name: 'failing',
      statements: ['CREATE TABLE z(id INTEGER)', 'CREATE TABLE z(id INTEGER)'],
    };
    expect(() => migrate(db, [failing])).toThrow(/table z already exists/);
    expect(dumpDb(db)).toEqual({ objects: [], tables: {} });
  });

  it('rows survive close and reopen of the same file', async () => {
    await withMigratedDb((db, ctx) => {
      expect(ctx.migration).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      db.tx(() => {
        db.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', 'did:plc:alice', T0);
        db.run(
          `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          'at://did:plc:alice/com.example.atmusic.scrobble/3lb2abcdefg2a',
          'bafyreib2rxk3rh6kzwq',
          'did:plc:alice',
          '3lb2abcdefg2a',
          '3lb2abcdefg2a',
          'Björk',
          'Jóga',
          T0,
          T0,
          T0,
          'björk',
          'jóga',
        );
      });
      db.run(
        "INSERT INTO snapshot_blocks(did, cid, bytes) VALUES ('did:plc:alice', 'bafyblock', ?)",
        new Uint8Array([0, 1, 254, 255]).slice().buffer,
      );
      const before = dumpDb(db);

      const again = reopen(db);
      expect(again).not.toBe(db);
      expect(dumpDb(again)).toEqual(before);
      expect(again.all('SELECT did, artist, track FROM scrobbles')).toEqual([
        { did: 'did:plc:alice', artist: 'Björk', track: 'Jóga' },
      ]);
      const block = again.one<{ bytes: ArrayBuffer }>('SELECT bytes FROM snapshot_blocks');
      expect([...new Uint8Array(block!.bytes)]).toEqual([0, 1, 254, 255]);
      expect(ledger(again)).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
      expect(migrate(again)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      // The closed handle refuses further use.
      expect(() => db.all('SELECT 1')).toThrow(/closed/);

      // A second reopen still sees the same rows plus a write made in between.
      again.run("DELETE FROM snapshot_blocks WHERE cid = 'bafyblock'");
      const third = reopen(again);
      expect(third.one('SELECT count(*) AS n FROM snapshot_blocks')).toEqual({ n: 0 });
      expect(third.one('SELECT count(*) AS n FROM scrobbles')).toEqual({ n: 1 });
    });
  });
});
