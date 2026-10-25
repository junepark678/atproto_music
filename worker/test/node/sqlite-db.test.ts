// The node:sqlite Db adapter (ADR 0005 §3.2, §3.10; N1-01): startup pragmas
// and the single-writer lock, nested transactions, the frozen parameter and
// BLOB contract, refused module SQL, >2^53 reads and the statement LRU.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AsyncTransactionError, MAX_SQL_PARAMS, SqlParamError } from '../../src/do/db';
import {
  DatabaseLockedError,
  DatabaseMissingError,
  JOURNAL_SIZE_LIMIT,
  openSqliteDb,
  PRODUCTION_BUSY_TIMEOUT_MS,
  type SqliteDb,
  SqlRangeError,
  SqlStatementRefusedError,
  STATEMENT_CACHE_SIZE,
} from '../../src/node/sqlite-db';
import { dumpDb, makeTempDir, reopen, TEST_BUSY_TIMEOUT_MS, withMigratedDb } from './support/node-db';

const T0 = '2026-01-15T12:00:00.000000000Z';

const dirs: string[] = [];
const open: SqliteDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new database file in its own temporary directory, closed after the test. */
function scratch(options: { busyTimeoutMs?: number } = { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS }) {
  const dir = makeTempDir('atmusic-sqlite-db-');
  dirs.push(dir);
  const path = join(dir, 'scratch.db');
  const db = openSqliteDb(path, { ...options, create: true });
  open.push(db);
  return { db, dir, path };
}

function names(db: SqliteDb): string[] {
  return db.all<{ name: string }>('SELECT name FROM t ORDER BY name').map((r) => r.name);
}

/** SQL texts of the statements currently prepared on the connection (SQLite's sqlite_stmt). */
function preparedSql(db: SqliteDb): string[] {
  return db.all<{ sql: string }>('SELECT sql FROM sqlite_stmt').map((r) => r.sql);
}

describe('openSqliteDb', () => {
  it('open sets journal_mode=wal, synchronous=2, foreign_keys=1, journal_size_limit=67108864 and locking_mode=exclusive, and PRAGMA busy_timeout reads back the injected busyTimeoutMs (5000 by default)', () => {
    const expected = {
      journal_mode: 'wal',
      synchronous: 2,
      foreign_keys: 1,
      journal_size_limit: 67_108_864,
      locking_mode: 'exclusive',
    };
    expect(JOURNAL_SIZE_LIMIT).toBe(67_108_864);
    expect(PRODUCTION_BUSY_TIMEOUT_MS).toBe(5000);

    // Default busy timeout: the production 5000 ms (nothing waits on it here).
    const { db, path } = scratch({});
    expect(db.pragmas()).toEqual({ ...expected, busy_timeout: 5000 });
    db.run('CREATE TABLE t(name TEXT PRIMARY KEY)');
    db.run("INSERT INTO t(name) VALUES ('a')");
    // WAL without shared memory: exclusive locking was set before the first WAL access.
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(existsSync(`${path}-shm`)).toBe(false);

    // An injected busy timeout reads back as given, on a fresh file and on reopen.
    const injected = scratch({ busyTimeoutMs: TEST_BUSY_TIMEOUT_MS });
    expect(injected.db.pragmas()).toEqual({ ...expected, busy_timeout: 200 });
    injected.db.close();
    const again = openSqliteDb(injected.path, { busyTimeoutMs: 321 });
    open.push(again);
    expect(again.pragmas()).toEqual({ ...expected, busy_timeout: 321 });
    expect(existsSync(`${injected.path}-shm`)).toBe(false);

    // The pragmas are the adapter's: module SQL can neither read nor change them.
    expect(() => again.one('PRAGMA busy_timeout')).toThrow(SqlStatementRefusedError);
    expect(() => again.run('PRAGMA synchronous=OFF')).toThrow(SqlStatementRefusedError);
    expect(again.pragmas().synchronous).toBe(2);
    expect(() => openSqliteDb(injected.path, { busyTimeoutMs: -1 })).toThrow(RangeError);
  });

  it('while one connection holds the database, a second openSqliteDb on the same file with busyTimeoutMs 200 fails with SQLITE_BUSY after about 200 ms and changes nothing', async () => {
    await withMigratedDb((first, ctx) => {
      first.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', 'did:plc:alice', T0);
      // The holder is a reopened handle on an existing file (the restart case).
      const holder = reopen(first);
      const before = dumpDb(holder);
      const filesBefore = readdirSync(ctx.dir).sort();

      const started = performance.now();
      let thrown: unknown = null;
      try {
        open.push(openSqliteDb(ctx.path, { busyTimeoutMs: 200 }));
      } catch (error) {
        thrown = error;
      }
      const elapsed = performance.now() - started;

      expect(thrown).toBeInstanceOf(DatabaseLockedError);
      expect(thrown).toMatchObject({ code: 'SQLITE_BUSY', errcode: 5, path: ctx.path });
      expect((thrown as Error).message).toMatch(/^database_locked/);
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(2000);

      // Nothing changed: same files, same schema and rows, and the holder still writes.
      expect(readdirSync(ctx.dir).sort()).toEqual(filesBefore);
      expect(dumpDb(holder)).toEqual(before);
      expect(holder.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', 'did:plc:bob', T0)).toEqual({
        rowsWritten: 1,
      });
      expect(holder.all('SELECT did FROM users ORDER BY did')).toEqual([
        { did: 'did:plc:alice' },
        { did: 'did:plc:bob' },
      ]);
      expect(holder.pragmas().locking_mode).toBe('exclusive');
    });
  });

  it('openSqliteDb with create false on a missing path throws and creates no file', () => {
    const dir = makeTempDir('atmusic-sqlite-missing-');
    dirs.push(dir);
    const path = join(dir, 'atmusic.db');

    expect(() => openSqliteDb(path, { busyTimeoutMs: 200, create: false })).toThrow(DatabaseMissingError);
    // create: false is the default.
    let thrown: unknown = null;
    try {
      openSqliteDb(path, { busyTimeoutMs: 200 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DatabaseMissingError);
    expect(thrown).toMatchObject({ code: 'database_missing', path });
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('Db over node:sqlite', () => {
  it('nested tx: an inner throw rolls back only its savepoint, an outer throw rolls back everything, an async callback is refused and nothing commits', () => {
    const { db } = scratch();
    db.run('CREATE TABLE t(name TEXT PRIMARY KEY)');

    // Inner throw: only that savepoint's writes are undone; the outer commits.
    const boom = new Error('inner boom');
    const value = db.tx(() => {
      db.run("INSERT INTO t(name) VALUES ('outer-1')");
      expect(() =>
        db.tx(() => {
          db.run("INSERT INTO t(name) VALUES ('inner-lost')");
          db.tx(() => db.run("INSERT INTO t(name) VALUES ('inner-nested-lost')"));
          throw boom;
        }),
      ).toThrow(boom);
      const kept = db.tx(() => {
        db.run("INSERT INTO t(name) VALUES ('inner-kept')");
        return 'kept';
      });
      db.run("INSERT INTO t(name) VALUES ('outer-2')");
      expect(names(db)).toEqual(['inner-kept', 'outer-1', 'outer-2']);
      return kept;
    });
    expect(value).toBe('kept');
    expect(names(db)).toEqual(['inner-kept', 'outer-1', 'outer-2']);
    expect(db.raw.isTransaction).toBe(false);

    // Outer throw after a successful inner tx: everything rolls back.
    const outer = new Error('outer boom');
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t(name) VALUES ('o-lost')");
        db.tx(() => db.run("INSERT INTO t(name) VALUES ('i-lost')"));
        throw outer;
      }),
    ).toThrow(outer);
    expect(names(db)).toEqual(['inner-kept', 'outer-1', 'outer-2']);
    expect(db.raw.isTransaction).toBe(false);

    // A SQL error inside the outer tx (duplicate key) rolls back earlier writes too.
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t(name) VALUES ('dup-lost')");
        db.run("INSERT INTO t(name) VALUES ('outer-1')");
      }),
    ).toThrow(/UNIQUE constraint failed: t.name/);
    expect(names(db)).toEqual(['inner-kept', 'outer-1', 'outer-2']);

    // Promise-returning callbacks are refused at runtime and rolled back.
    const asyncOuter = (() => {
      db.run("INSERT INTO t(name) VALUES ('async-outer-lost')");
      return Promise.resolve(1);
    }) as unknown as () => number;
    expect(() => db.tx(asyncOuter)).toThrow(AsyncTransactionError);
    expect(names(db)).toEqual(['inner-kept', 'outer-1', 'outer-2']);
    expect(db.raw.isTransaction).toBe(false);

    const asyncInner = (() => {
      db.run("INSERT INTO t(name) VALUES ('async-inner-lost')");
      return Promise.reject(new Error('never observed'));
    }) as unknown as () => number;
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t(name) VALUES ('around-async-lost')");
        db.tx(asyncInner);
      }),
    ).toThrow(AsyncTransactionError);
    expect(names(db)).toEqual(['inner-kept', 'outer-1', 'outer-2']);
    expect(db.raw.isTransaction).toBe(false);

    // The refused inner savepoint alone is rolled back when the outer catches it.
    db.tx(() => {
      db.run("INSERT INTO t(name) VALUES ('survivor')");
      expect(() => db.tx(asyncInner)).toThrow(AsyncTransactionError);
    });
    expect(names(db)).toEqual(['inner-kept', 'outer-1', 'outer-2', 'survivor']);

    // The data is durable: a reopened connection sees exactly the committed rows.
    const path = db.path;
    db.close();
    open.splice(open.indexOf(db), 1);
    const again = openSqliteDb(path, { busyTimeoutMs: 200 });
    open.push(again);
    expect(names(again)).toEqual(['inner-kept', 'outer-1', 'outer-2', 'survivor']);

    // Compile-time contract, checked by `npm run typecheck` (never invoked).
    const typeContract = () => {
      const n: number = again.tx(() => 1);
      // @ts-expect-error async callbacks are not allowed in db.tx
      again.tx(async () => 1);
      // @ts-expect-error Promise-returning callbacks are not allowed in db.tx
      again.tx(() => Promise.resolve(1));
      return n;
    };
    expect(typeof typeContract).toBe('function');
  });

  it('BLOB parameters round-trip as byte-identical ArrayBuffer and run() reports rowsWritten equal to changes', () => {
    const { db } = scratch();
    db.run('CREATE TABLE b(id INTEGER PRIMARY KEY, bytes BLOB NOT NULL)');
    const all = new Uint8Array(256).map((_, i) => i);
    const empty = new ArrayBuffer(0);
    // A view into a larger buffer: only its bytes are sent (slice().buffer).
    const view = new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 4);

    expect(
      db.run('INSERT INTO b(id, bytes) VALUES (1, ?), (2, ?), (3, ?)', all.buffer, empty, view.slice().buffer),
    ).toEqual({ rowsWritten: 3 });
    const rows = db.all<{ id: number; bytes: ArrayBuffer; ty: string; n: number }>(
      'SELECT id, bytes, typeof(bytes) AS ty, length(bytes) AS n FROM b ORDER BY id',
    );
    expect(rows.map((r) => [r.id, r.ty, r.n])).toEqual([
      [1, 'blob', 256],
      [2, 'blob', 0],
      [3, 'blob', 3],
    ]);
    for (const row of rows) {
      expect(row.bytes).toBeInstanceOf(ArrayBuffer);
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    }
    expect([...new Uint8Array(rows[0]!.bytes)]).toEqual([...all]);
    expect(rows[1]!.bytes.byteLength).toBe(0);
    expect([...new Uint8Array(rows[2]!.bytes)]).toEqual([8, 7, 6]);
    // The returned buffer is a copy: mutating it changes nothing stored.
    new Uint8Array(rows[0]!.bytes)[0] = 255;
    const reread = db.one<{ bytes: ArrayBuffer }>('SELECT bytes FROM b WHERE id = 1');
    expect(new Uint8Array(reread!.bytes)[0]).toBe(0);
    // A BLOB parameter compares equal to the stored value.
    expect(db.one('SELECT id FROM b WHERE bytes = ?', all.slice().buffer)).toEqual({ id: 1 });
    // A Uint8Array view is refused, as by the DO facade (pass bytes.slice().buffer).
    expect(() => db.run('INSERT INTO b(id, bytes) VALUES (4, ?)', view as never)).toThrow(SqlParamError);

    // rowsWritten is SQLite's changes() for the statement...
    const changes = () => db.one<{ c: number }>('SELECT changes() AS c')!.c;
    expect(db.run('UPDATE b SET bytes = ? WHERE id >= 2', new ArrayBuffer(1))).toEqual({ rowsWritten: 2 });
    expect(changes()).toBe(2);
    expect(db.run('DELETE FROM b WHERE id = 99')).toEqual({ rowsWritten: 0 });
    expect(changes()).toBe(0);
    expect(db.run('INSERT INTO b(id, bytes) VALUES (5, ?) RETURNING id', empty)).toEqual({ rowsWritten: 1 });
    expect(changes()).toBe(1);
    // ...and 0 for statements that write nothing, never the previous DML's count.
    expect(db.run('SELECT * FROM b')).toEqual({ rowsWritten: 0 });
    expect(db.run('CREATE TABLE c(x INTEGER)')).toEqual({ rowsWritten: 0 });
    expect(db.one<{ n: number }>('SELECT count(*) AS n FROM b')).toEqual({ n: 4 });
  });

  it('module SQL with two statements, BEGIN, SAVEPOINT, PRAGMA or ATTACH throws a typed error and leaves every table unchanged', () => {
    const { db, dir } = scratch();
    db.run('CREATE TABLE t(name TEXT PRIMARY KEY)');
    db.run('CREATE TABLE u(id INTEGER PRIMARY KEY, parent TEXT REFERENCES t(name))');
    db.run("INSERT INTO t(name) VALUES ('a')");
    db.run("INSERT INTO u(id, parent) VALUES (1, 'a')");
    const before = dumpDb(db);
    const attached = join(dir, 'other.db');

    const refused: Array<[string, string]> = [
      ["INSERT INTO t(name) VALUES ('b'); DELETE FROM u", 'multiple_statements'],
      ["DELETE FROM u; INSERT INTO t(name) VALUES ('c')", 'multiple_statements'],
      ["INSERT INTO t(name) VALUES ('x;y') ; DROP TABLE u", 'multiple_statements'],
      ['BEGIN', 'transaction'],
      ['BEGIN IMMEDIATE', 'transaction'],
      ['COMMIT', 'transaction'],
      ['ROLLBACK', 'transaction'],
      ['SAVEPOINT s1', 'savepoint'],
      ['RELEASE s1', 'savepoint'],
      ['PRAGMA foreign_keys=OFF', 'pragma'],
      ['PRAGMA journal_mode=DELETE', 'pragma'],
      ["SELECT * FROM pragma_table_info('t')", 'pragma'],
      [`ATTACH DATABASE '${attached}' AS other`, 'attach'],
      ['DETACH DATABASE other', 'detach'],
    ];
    for (const [sql, reason] of refused) {
      for (const call of [() => db.run(sql), () => db.all(sql), () => db.one(sql), () => db.exec(sql)]) {
        let thrown: unknown = null;
        try {
          call();
        } catch (error) {
          thrown = error;
        }
        expect(thrown, sql).toBeInstanceOf(SqlStatementRefusedError);
        expect((thrown as SqlStatementRefusedError).reason, sql).toBe(reason);
      }
      // Refused inside a transaction as well, and the transaction rolls back.
      expect(() =>
        db.tx(() => {
          db.run("INSERT INTO t(name) VALUES ('in-tx')");
          db.run(sql);
        }),
      ).toThrow(SqlStatementRefusedError);
      expect(dumpDb(db), sql).toEqual(before);
    }
    expect(db.raw.isTransaction).toBe(false);
    expect(existsSync(attached)).toBe(false);
    // The raw connection is module SQL too: the authorizer applies to it.
    expect(() => db.raw.exec('PRAGMA foreign_keys=OFF')).toThrow(/not authorized/);
    expect(db.pragmas().foreign_keys).toBe(1);

    // One statement with semicolons inside literals, identifiers and comments,
    // or a trailing semicolon and comment, is accepted.
    expect(db.run("INSERT INTO t(name) VALUES ('semi;colon') /* ; */ -- ;\n")).toEqual({ rowsWritten: 1 });
    expect(db.run("INSERT INTO t(\"name\") VALUES ('it'';s');  -- done")).toEqual({ rowsWritten: 1 });
    expect(names(db)).toEqual(['a', "it';s", 'semi;colon']);
  });

  it('more than 100 parameters, an unsafe integer, true or Infinity is refused before binding', () => {
    const { db } = scratch();
    db.run('CREATE TABLE p(v)');
    const tooMany = `INSERT INTO p(v) VALUES ${Array.from({ length: MAX_SQL_PARAMS + 1 }, () => '(?)').join(',')}`;
    const atLimit = `INSERT INTO p(v) VALUES ${Array.from({ length: MAX_SQL_PARAMS }, () => '(?)').join(',')}`;
    const cases: Array<[string, unknown[], string]> = [
      [tooMany, Array.from({ length: MAX_SQL_PARAMS + 1 }, (_, i) => i), 'too_many_params'],
      ['INSERT INTO p(v) VALUES (?) -- unsafe', [2 ** 53], 'unsafe_integer'],
      ['INSERT INTO p(v) VALUES (?) -- negative unsafe', [-(2 ** 53) - 2], 'unsafe_integer'],
      ['INSERT INTO p(v) VALUES (?) -- boolean', [true], 'unsupported_type'],
      ['INSERT INTO p(v) VALUES (?) -- bigint', [1n], 'unsupported_type'],
      ['INSERT INTO p(v) VALUES (?) -- infinity', [Number.POSITIVE_INFINITY], 'non_finite_number'],
      ['INSERT INTO p(v) VALUES (?) -- nan', [Number.NaN], 'non_finite_number'],
    ];
    for (const [sql, params, reason] of cases) {
      for (const call of [
        () => db.run(sql, ...(params as never[])),
        () => db.all(sql, ...(params as never[])),
        () => db.one(sql, ...(params as never[])),
        () => db.exec(sql, ...(params as never[])),
      ]) {
        let thrown: unknown = null;
        try {
          call();
        } catch (error) {
          thrown = error;
        }
        expect(thrown, reason).toBeInstanceOf(SqlParamError);
        expect((thrown as SqlParamError).reason).toBe(reason);
      }
      // Refused before binding: the statement was never even prepared.
      expect(preparedSql(db)).not.toContain(sql);
    }
    expect(db.one('SELECT count(*) AS n FROM p')).toEqual({ n: 0 });

    // The limit itself, and safe integers, reals, text and null are accepted;
    // integers bind as INTEGER and reals as REAL.
    expect(db.run(atLimit, ...Array.from({ length: MAX_SQL_PARAMS }, (_, i) => i))).toEqual({ rowsWritten: 100 });
    expect(
      db.one(
        'SELECT typeof(?) AS a, typeof(?) AS b, typeof(?) AS c, typeof(?) AS d, json_array(?, ?) AS j',
        7,
        2.5,
        's',
        null,
        Number.MAX_SAFE_INTEGER,
        0.5,
      ),
    ).toEqual({ a: 'integer', b: 'real', c: 'text', d: 'null', j: '[9007199254740991,0.5]' });
  });

  it('reading an integer above 2^53 throws SqlRangeError instead of returning a rounded number', () => {
    const { db } = scratch();
    db.run('CREATE TABLE n(label TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    db.run("INSERT INTO n(label, value) VALUES ('max_safe', 9007199254740991)");
    db.run("INSERT INTO n(label, value) VALUES ('above', 9007199254740993)");
    db.run("INSERT INTO n(label, value) VALUES ('below', -9007199254740993)");

    expect(db.one("SELECT value FROM n WHERE label = 'max_safe'")).toEqual({ value: Number.MAX_SAFE_INTEGER });
    for (const read of [
      () => db.one("SELECT value FROM n WHERE label = 'above'"),
      () => db.all('SELECT value FROM n ORDER BY label'),
      () => db.exec("SELECT value FROM n WHERE label = 'below'"),
      () => db.one('SELECT 9223372036854775807 AS v'),
    ]) {
      let thrown: unknown = null;
      try {
        read();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SqlRangeError);
      expect(thrown).toMatchObject({ name: 'SqlRangeError', code: 'ERR_OUT_OF_RANGE' });
    }
    // The stored value is exact; only CAST(... AS TEXT) reads it.
    expect(db.one("SELECT CAST(value AS TEXT) AS t, typeof(value) AS ty FROM n WHERE label = 'above'")).toEqual({
      t: '9007199254740993',
      ty: 'integer',
    });
  });

  it('300 distinct statements leave at most 256 prepared statements cached', () => {
    const { db } = scratch();
    expect(STATEMENT_CACHE_SIZE).toBe(256);
    const sqlOf = (i: number) => `SELECT ${i} AS n`;
    for (let i = 0; i < 300; i++) {
      expect(db.one(sqlOf(i))).toEqual({ n: i });
      // Statement 0 stays recently used, so the LRU keeps it.
      if (i % 50 === 0) expect(db.one(sqlOf(0))).toEqual({ n: 0 });
    }
    const prepared = preparedSql(db);
    const module = prepared.filter((sql) => /^SELECT \d+ AS n$/.test(sql));
    // The sqlite_stmt query itself is one of the cached module statements.
    expect(module.length + 1).toBeLessThanOrEqual(256);
    expect(module.length).toBe(255);
    expect(prepared.filter((sql) => sql !== 'SELECT total_changes() AS n').length).toBeLessThanOrEqual(256);
    expect(module).toContain(sqlOf(0));
    expect(module).toContain(sqlOf(299));
    expect(module).not.toContain(sqlOf(1));
    expect(module).not.toContain(sqlOf(44));
    // An evicted statement is prepared again on demand and still works.
    expect(db.one(sqlOf(1))).toEqual({ n: 1 });
    expect(preparedSql(db)).toContain(sqlOf(1));
  });
});
