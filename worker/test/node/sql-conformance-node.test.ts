// SQL conformance of the Node Db over the real migrated schema (ADR 0005 §3.2,
// §15.4 "Node adapter conformance"; N1-01): what the DO suite
// (worker/test/storage/sql-conformance.test.ts) pins for Durable Object SQLite,
// checked here on node:sqlite where the adapter's rules differ or add to it.

import { describe, expect, it } from 'vitest';
import { SqlStatementRefusedError } from '../../src/node/sqlite-db';
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
