// SQL conformance of the Node Db over the real migrated schema (ADR 0005 §3.2,
// §15.4 "Node adapter conformance"; N1-01): what the DO suite
// (worker/test/storage/sql-conformance.test.ts) pins for Durable Object SQLite,
// checked here on node:sqlite where the adapter's rules differ or add to it.

import { describe, expect, it } from 'vitest';
import { SqlParamCountError, SqlStatementRefusedError } from '../../src/node/sqlite-db';
import { dumpDb, withMigratedDb } from './support/node-db';

const T0 = '2026-01-15T12:00:00.000000000Z';
const DID = 'did:plc:alice';

const SCROBBLE = `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;

function scrobbleParams(did: string, rkey: string) {
  return [
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
  ] as const;
}

describe('sql conformance on node:sqlite', () => {
  it('foreign keys are enforced and PRAGMA foreign_keys=OFF from module SQL is denied', async () => {
    await withMigratedDb((db) => {
      expect(db.pragmas().foreign_keys).toBe(1);

      // A scrobble or follow whose users row is missing is rejected and leaves no row.
      expect(() => db.run(SCROBBLE, ...scrobbleParams(DID, '3lb2aaaaaaa2a'))).toThrow(/FOREIGN KEY constraint failed/);
      expect(() =>
        db.run(
          "INSERT INTO follows(uri,cid,actor,subject,revision,created_at,indexed_at) VALUES ('at://x/f/1','c',?,'did:plc:bob','r',?,?)",
          DID,
          T0,
          T0,
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(db.one('SELECT (SELECT count(*) FROM scrobbles) AS s, (SELECT count(*) FROM follows) AS f')).toEqual({
        s: 0,
        f: 0,
      });

      // With the parent present the insert succeeds, and ON DELETE CASCADE removes children.
      db.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', DID, T0);
      expect(db.run(SCROBBLE, ...scrobbleParams(DID, '3lb2aaaaaaa2a'))).toEqual({ rowsWritten: 1 });
      expect(db.run('DELETE FROM users WHERE did = ?', DID)).toEqual({ rowsWritten: 1 });
      expect(db.one('SELECT count(*) AS n FROM scrobbles')).toEqual({ n: 0 });

      // Module SQL cannot switch enforcement off, in any spelling, in or out of a transaction.
      const before = dumpDb(db);
      for (const sql of [
        'PRAGMA foreign_keys=OFF',
        'PRAGMA foreign_keys = 0',
        'pragma main.foreign_keys=false',
        'PRAGMA defer_foreign_keys=ON',
        'PRAGMA ignore_check_constraints=ON',
        'SELECT * FROM pragma_foreign_keys',
        'SELECT * FROM pragma_foreign_key_check',
      ]) {
        let thrown: unknown = null;
        try {
          db.run(sql);
        } catch (error) {
          thrown = error;
        }
        expect(thrown, sql).toBeInstanceOf(SqlStatementRefusedError);
        expect((thrown as SqlStatementRefusedError).reason, sql).toBe('pragma');
        expect(() => db.tx(() => db.run(sql))).toThrow(SqlStatementRefusedError);
      }
      expect(dumpDb(db)).toEqual(before);
      expect(db.pragmas().foreign_keys).toBe(1);

      // Enforcement is still on after every refused attempt.
      expect(() => db.run(SCROBBLE, ...scrobbleParams(DID, '3lb2bbbbbbb2a'))).toThrow(/FOREIGN KEY constraint failed/);
      expect(db.one('SELECT count(*) AS n FROM scrobbles')).toEqual({ n: 0 });
    });
  });

  it('a bind value count that differs from the placeholder count throws SqlParamCountError before binding, as DO SQLite does, and writes nothing', async () => {
    await withMigratedDb((db) => {
      const caught = (fn: () => unknown): unknown => {
        try {
          fn();
        } catch (error) {
          return error;
        }
        return null;
      };
      const expectCount = (error: unknown, expected: number, actual: number) => {
        expect(error).toBeInstanceOf(SqlParamCountError);
        const e = error as SqlParamCountError;
        expect(e.reason).toBe('wrong_param_count');
        expect([e.expected, e.actual]).toEqual([expected, actual]);
        // DO SQLite's message (workerd: "Wrong number of parameter bindings for SQL query.").
        expect(e.message).toMatch(/^Wrong number of parameter bindings for SQL query\./);
      };
      const before = dumpDb(db);
      const INSERT_USER = 'INSERT INTO users(did, joined_at) VALUES (?, ?)';

      // Too few: node:sqlite alone would bind NULL to joined_at; too many: an untyped range error.
      // Every facade entry point refuses, on a fresh and on a cached statement alike.
      for (let round = 0; round < 2; round++) {
        expectCount(
          caught(() => db.run(INSERT_USER, DID)),
          2,
          1,
        );
        expectCount(
          caught(() => db.run(INSERT_USER, DID, T0, T0)),
          2,
          3,
        );
        expectCount(
          caught(() => db.all('SELECT did FROM users WHERE did = ?')),
          1,
          0,
        );
        expectCount(
          caught(() => db.one('SELECT count(*) AS n FROM users', DID)),
          0,
          1,
        );
        expectCount(
          caught(() => db.exec('SELECT did FROM users WHERE did = ? AND joined_at = ?', DID)),
          2,
          1,
        );
      }
      // Inside a transaction the throw rolls back the writes made before it.
      expectCount(
        caught(() =>
          db.tx(() => {
            db.run(INSERT_USER, DID, T0);
            db.run("INSERT INTO timers(name, due_at) VALUES ('drain', ?)");
          }),
        ),
        1,
        0,
      );
      expect(dumpDb(db)).toEqual(before);

      // SQLite's numbering: `?` takes the next index after the highest so far, `?NNN` takes NNN,
      // and the count is the highest index.
      expect(db.one('SELECT ?1 AS a, ?1 AS b', 7)).toEqual({ a: 7, b: 7 });
      expect(db.one('SELECT ?2 AS b, ?1 AS a', 'x', 'y')).toEqual({ a: 'x', b: 'y' });
      expectCount(
        caught(() => db.one('SELECT ?3 AS c', 1)),
        3,
        1,
      );
      expect(db.one('SELECT ? AS a, ?5 AS e, ? AS f', 1, 2, 3, 4, 5, 6)).toEqual({ a: 1, e: 5, f: 6 });
      expectCount(
        caught(() => db.one('SELECT ? AS a, ?5 AS e, ? AS f', 1, 2, 3)),
        6,
        3,
      );

      // `?`, `:`, `@` and `$` inside literals, quoted identifiers and comments are not placeholders,
      // and `$` inside an unquoted identifier is part of it.
      expect(
        db.one(
          `SELECT '?:a@b$c' AS "q?", ? AS [w?] /* ? :x */, 1 AS a$b -- ? @y
`,
          'v',
        ),
      ).toEqual({ 'q?': '?:a@b$c', 'w?': 'v', a$b: 1 });

      // Named parameters are refused before anything runs: the facade binds positionally.
      for (const sql of [
        'SELECT did FROM users WHERE did = :did',
        'SELECT did FROM users WHERE did = @did',
        'SELECT did FROM users WHERE did = $did',
        'DELETE FROM users WHERE did = :did',
      ]) {
        const error = caught(() => db.run(sql, DID));
        expect(error, sql).toBeInstanceOf(SqlStatementRefusedError);
        expect((error as SqlStatementRefusedError).reason, sql).toBe('named_parameter');
      }

      // A matching count still writes.
      expect(db.run(INSERT_USER, DID, T0)).toEqual({ rowsWritten: 1 });
      expect(db.all('SELECT did, joined_at FROM users')).toEqual([{ did: DID, joined_at: T0 }]);
    });
  });

  it('a statement error inside a nested tx keeps earlier writes of the outer transaction when the inner error is caught', async () => {
    await withMigratedDb((db) => {
      db.tx(() => {
        db.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', DID, T0);
        expect(() =>
          db.tx(() => {
            db.run("INSERT INTO timers(name, due_at) VALUES ('drain', 1)");
            db.run(SCROBBLE, ...scrobbleParams('did:plc:nobody', '3lb2ccccccc2a'));
          }),
        ).toThrow(/FOREIGN KEY constraint failed/);
      });
      expect(db.all('SELECT did FROM users')).toEqual([{ did: DID }]);
      expect(db.one('SELECT count(*) AS n FROM timers')).toEqual({ n: 0 });
    });
  });
});
