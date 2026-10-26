// migrate() over the Node Db (ADR 0005 §3.2; N1-01): one transaction on a
// fresh file, newer databases left untouched, the schema_compat rule, failing
// migrations rolled back, and durability across close and reopen. The
// compatibility cases use synthetic migration lists, so they do not depend on
// migration 2 (N1-10).

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationLedgerError, type MigrationTarget, migrate } from '../../src/do/migrate';
import { MIGRATIONS, type Migration, SCHEMA_VERSION, TABLES } from '../../src/do/schema';
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
