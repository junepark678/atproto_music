import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { AsyncTransactionError, type Db, doDb, MAX_SQL_PARAMS, SqlParamError } from '../../src/do/db';
import type { HarnessDO } from '../harness/harness-do';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));
const T0 = '2026-01-15T12:00:00.000000000Z';

/** Real DO storage whose sql.exec calls are counted (injected, test-only). */
function countingStorage(storage: DurableObjectStorage): { storage: DurableObjectStorage; execCalls: () => number } {
  let calls = 0;
  const sql = new Proxy(storage.sql, {
    get(target, prop, receiver) {
      if (prop === 'exec') {
        return (query: string, ...bindings: unknown[]) => {
          calls++;
          return target.exec(query, ...bindings);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const wrapped = new Proxy(storage, {
    get(target, prop) {
      if (prop === 'sql') return sql;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage: wrapped, execCalls: () => calls };
}

function counts(db: Db) {
  return db.one<{ users: number; scrobbles: number; counters: number; timers: number }>(
    `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM scrobbles) AS scrobbles,
            (SELECT count(*) FROM counters) AS counters, (SELECT count(*) FROM timers) AS timers`,
  );
}

function insertUserAndScrobble(db: Db, did: string, rkey: string) {
  db.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', did, T0);
  db.run(
    `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    `at://${did}/com.example.atmusic.scrobble/${rkey}`,
    'bafyreib2rxk3rh6kzwq',
    did,
    rkey,
    '3lb2abcdefg2a',
    'Björk',
    'Jóga',
    T0,
    T0,
    T0,
    'björk',
    'jóga',
  );
}

describe('doDb', () => {
  it('tx rolls back all writes when the callback throws', async () => {
    await runInDurableObject(stubFor('db-tx-rollback'), (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const boom = new Error('fail after writes');

      let thrown: unknown;
      try {
        db.tx(() => {
          insertUserAndScrobble(db, 'did:plc:alice', '3lb2aaaaaaa2a');
          db.run("INSERT INTO counters(name, label, value) VALUES ('excluded', 'too_long', 1)");
          db.run('UPDATE backfill_generation SET last_generation = last_generation + 1');
          // The writes are visible inside the transaction...
          expect(counts(db)).toEqual({ users: 1, scrobbles: 1, counters: 1, timers: 0 });
          throw boom;
        });
      } catch (err) {
        thrown = err;
      }
      // ...the original error propagates unchanged and nothing committed.
      expect(thrown).toBe(boom);
      expect(counts(db)).toEqual({ users: 0, scrobbles: 0, counters: 0, timers: 0 });
      expect(db.one('SELECT last_generation FROM backfill_generation')).toEqual({ last_generation: 0 });

      // A SQL error mid-transaction (FK violation) also rolls back earlier writes.
      expect(() =>
        db.tx(() => {
          db.run("INSERT INTO timers(name, due_at) VALUES ('drain', 1)");
          insertUserAndScrobble(db, 'did:plc:bob', '3lb2bbbbbbb2a');
          insertUserAndScrobble(db, 'did:plc:bob', '3lb2ccccccc2a'); // duplicate users PK
        }),
      ).toThrow(/UNIQUE constraint failed: users.did/);
      expect(counts(db)).toEqual({ users: 0, scrobbles: 0, counters: 0, timers: 0 });

      // A callback that returns a Promise is refused at runtime and rolled back
      // (the type of tx already rejects it; see the ts-expect-error below).
      const asyncFn = (() => {
        db.run("INSERT INTO timers(name, due_at) VALUES ('gc', 5)");
        return Promise.resolve(1);
      }) as unknown as () => number;
      expect(() => db.tx(asyncFn)).toThrow(AsyncTransactionError);
      expect(counts(db)).toEqual({ users: 0, scrobbles: 0, counters: 0, timers: 0 });

      // A successful callback commits and returns its value.
      const value = db.tx(() => {
        insertUserAndScrobble(db, 'did:plc:carol', '3lb2ddddddd2a');
        return db.run("INSERT INTO timers(name, due_at) VALUES ('snapshot', 9)").rowsWritten;
      });
      // rowsWritten is DO's billed count: the table row plus its PK index entry.
      expect(value).toBe(2);
      expect(counts(db)).toEqual({ users: 1, scrobbles: 1, counters: 0, timers: 1 });

      // Compile-time contract, checked by `npm run typecheck` (never invoked).
      const typeContract = () => {
        const n: number = db.tx(() => 1);
        // @ts-expect-error async callbacks are not allowed in db.tx
        db.tx(async () => 1);
        // @ts-expect-error Promise-returning callbacks are not allowed in db.tx
        db.tx(() => Promise.resolve(1));
        return n;
      };
      expect(typeof typeContract).toBe('function');
    });
  });

  it('101 bound parameters raise SqlParamError before execution', async () => {
    await runInDurableObject(stubFor('db-param-limit'), (_i: HarnessDO, state) => {
      const { storage, execCalls } = countingStorage(state.storage);
      const db = doDb(storage);
      const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');
      const sql = (n: number) => `INSERT INTO counters(name, label, value) SELECT 'p', 'n', max(${placeholders(n)})`;

      // 100 is the limit and is accepted (max() over 100 arguments).
      expect(MAX_SQL_PARAMS).toBe(100);
      const ok = Array.from({ length: 100 }, (_, i) => i + 1);
      expect(db.run(sql(100), ...ok)).toEqual({ rowsWritten: 2 }); // row + PK index entry
      expect(db.one('SELECT value FROM counters')).toEqual({ value: 100 });
      expect(execCalls()).toBe(2);

      const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
      for (const call of [
        () => db.run(sql(101), ...tooMany),
        () => db.all(`SELECT ${placeholders(101)}`, ...tooMany),
        () => db.one(`SELECT ${placeholders(101)}`, ...tooMany),
      ]) {
        let err: unknown;
        try {
          call();
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(SqlParamError);
        expect((err as SqlParamError).reason).toBe('too_many_params');
        expect((err as SqlParamError).index).toBeNull();
      }
      // None of the three reached SQLite, and nothing was written.
      expect(execCalls()).toBe(2);
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM counters').one()).toEqual({ n: 1 });
      // For contrast, raw exec reaches SQLite and fails there untyped.
      expect(() => state.storage.sql.exec(`SELECT ${placeholders(101)}`, ...tooMany)).toThrow(/too many SQL variables/);
    });
  });

  it('unsafe integer parameter is rejected', async () => {
    await runInDurableObject(stubFor('db-unsafe-int'), (_i: HarnessDO, state) => {
      const { storage, execCalls } = countingStorage(state.storage);
      const db = doDb(storage);
      const insert = "INSERT INTO counters(name, label, value) VALUES ('c', ?, ?)";

      const reject = (label: string, value: unknown, reason: string) => {
        let err: unknown;
        try {
          db.run(insert, label, value as number);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(SqlParamError);
        expect((err as SqlParamError).reason).toBe(reason);
        expect((err as SqlParamError).index).toBe(1);
      };
      reject('2^53', 2 ** 53, 'unsafe_integer');
      reject('-2^53', -(2 ** 53), 'unsafe_integer');
      reject('1e300', 1e300, 'unsafe_integer');
      reject('nan', Number.NaN, 'non_finite_number');
      reject('inf', Number.POSITIVE_INFINITY, 'non_finite_number');
      reject('bigint', 5n, 'unsupported_type');
      reject('bool', true, 'unsupported_type');
      reject('undef', undefined, 'unsupported_type');
      reject('u8', new Uint8Array([1]), 'unsupported_type');
      expect(execCalls()).toBe(0);
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM counters').one()).toEqual({ n: 0 });

      // The boundary value and finite reals pass through exactly.
      expect(db.run(insert, 'max', Number.MAX_SAFE_INTEGER)).toEqual({ rowsWritten: 2 });
      expect(db.one<{ value: number }>("SELECT value FROM counters WHERE label = 'max'")).toEqual({
        value: Number.MAX_SAFE_INTEGER,
      });
      expect(db.one<{ x: number }>('SELECT ? * 2 AS x', 1.25)).toEqual({ x: 2.5 });
      expect(execCalls()).toBe(3);
    });
  });

  // rowsWritten is the DO cursor's billed rows-written count, which includes
  // index b-tree entries: it is 0 exactly when nothing was written, but it is
  // not SQLite's changes() row count. Exact values for the pinned workerd.
  it('all/one/run map rows, nulls and rowsWritten', async () => {
    await runInDurableObject(stubFor('db-shapes'), (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      expect(db.one('SELECT * FROM timers')).toBeNull();
      expect(db.all('SELECT * FROM timers')).toEqual([]);
      expect(db.run("INSERT INTO timers(name, due_at) VALUES ('a', 1), ('b', 2), ('c', 3)")).toEqual({
        rowsWritten: 6, // 3 rows + 3 PK index entries
      });
      expect(db.run('UPDATE timers SET due_at = due_at + 1 WHERE due_at >= ?', 2)).toEqual({ rowsWritten: 2 });
      expect(db.run('UPDATE timers SET due_at = 0 WHERE name = ?', 'zzz')).toEqual({ rowsWritten: 0 });
      expect(db.all<{ name: string; due_at: number }>('SELECT name, due_at FROM timers ORDER BY name')).toEqual([
        { name: 'a', due_at: 1 },
        { name: 'b', due_at: 3 },
        { name: 'c', due_at: 4 },
      ]);
      expect(db.one('SELECT name FROM timers ORDER BY due_at DESC')).toEqual({ name: 'c' });
      expect(db.one('SELECT NULL AS v')).toEqual({ v: null });
      expect(db.run('DELETE FROM timers')).toEqual({ rowsWritten: 3 });
    });
  });
});
