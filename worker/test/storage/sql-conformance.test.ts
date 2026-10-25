// SQL conformance of the Node host's SQLite (ADR 0005 §3.2): node:sqlite
// (SQLite 3.54.1) through the production adapter (worker/src/node/sqlite-db.ts),
// reached as DO storage through the `cloudflare:*` test shim (N2-02); before
// the port it ran on DO SQLite in workerd (ADR 0004 §3.2). Every expectation is
// SQLite's documented behaviour or the adapter's documented contract,
// hardcoded here; a runtime upgrade that changes one fails loudly.
//
// Named expectation changes (ADR 0005 §15.3): BEGIN/SAVEPOINT and PRAGMA are
// refused by the adapter's authorizer (SqlStatementRefusedError; the startup
// pragmas are read back through `pragmas()`), multi-statement text is refused
// instead of running every statement, and an integer above 2^53 on read
// throws SqlRangeError instead of losing precision. Two DO-only tests
// ("documents precision loss above", "multi-statement exec binds only the last
// statement") are replaced by the Node test at the end of this file
// (docs/verification/node-port-inventory.json).

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { type Db, doDb, SqlParamError } from '../../src/do/db';
import { SqlRangeError, SqlStatementRefusedError } from '../../src/node/sqlite-db';
import type { HarnessDO } from '../harness/harness-do';
import { sqliteDbOf } from '../node/support/do-storage-facade';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));
const T0 = '2026-01-15T12:00:00.000000000Z';
const SCROBBLE = 'com.example.atmusic.scrobble';
const FOLLOW = 'com.example.atmusic.follow';

function inDb(name: string, fn: (db: Db, storage: DurableObjectStorage) => void): Promise<void> {
  return runInDurableObject(stubFor(name), (_i: HarnessDO, state) => fn(doDb(state.storage), state.storage));
}

function addUser(db: Db, did: string, handle: string | null = null) {
  db.run('INSERT INTO users(did, handle, joined_at) VALUES (?, ?, ?)', did, handle, T0);
}

function addScrobble(db: Db, did: string, rkey: string, listenedAt = T0) {
  db.run(
    `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    `at://${did}/${SCROBBLE}/${rkey}`,
    `bafy-${rkey}`,
    did,
    rkey,
    '3lb2aaaaaaa2a',
    'Artist',
    'Track',
    listenedAt,
    T0,
    T0,
    'artist',
    'track',
  );
}

function addFollow(db: Db, actor: string, subject: string, rkey: string) {
  db.run(
    'INSERT INTO follows(uri,cid,actor,subject,revision,created_at,indexed_at) VALUES (?,?,?,?,?,?,?)',
    `at://${actor}/${FOLLOW}/${rkey}`,
    `bafy-${rkey}`,
    actor,
    subject,
    '3lb2aaaaaaa2a',
    T0,
    T0,
  );
}

/** Runs `fn` and returns the reason of the SqlStatementRefusedError it throws. */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SqlStatementRefusedError) return error.reason;
    throw error;
  }
  throw new Error('expected the statement to be refused');
}

/** Rows whose declared owner foreign key names no users row (what PRAGMA foreign_key_check reported). */
function orphans(db: Db): unknown[] {
  return db.all(
    `SELECT 'scrobbles' AS t, s.uri AS uri FROM scrobbles s LEFT JOIN users u ON u.did = s.did WHERE u.did IS NULL
     UNION ALL
     SELECT 'follows', f.uri FROM follows f LEFT JOIN users u ON u.did = f.actor WHERE u.did IS NULL`,
  );
}

/** Index of the first differing byte, the shorter length if one is a prefix, or -1 when equal. */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function tableDump(db: Db): unknown {
  return {
    users: db.all('SELECT * FROM users ORDER BY did'),
    scrobbles: db.all('SELECT * FROM scrobbles ORDER BY uri'),
    timers: db.all('SELECT * FROM timers ORDER BY name'),
  };
}

describe('DO SQLite conformance', () => {
  it('BEGIN and SAVEPOINT are rejected by exec', async () => {
    await inDb('conf-begin', (db, storage) => {
      addUser(db, 'did:plc:alice');
      const before = tableDump(db);
      for (const statement of [
        'BEGIN',
        'BEGIN TRANSACTION',
        'BEGIN IMMEDIATE',
        'SAVEPOINT sp1',
        'RELEASE sp1',
        'COMMIT',
        'ROLLBACK',
      ]) {
        // Node: the adapter's authorizer denies them (DO said "use transactionSync()").
        const reason = /^(SAVEPOINT|RELEASE)/.test(statement) ? 'savepoint' : 'transaction';
        expect(
          refusal(() => storage.sql.exec(statement)),
          statement,
        ).toBe(reason);
        expect(
          refusal(() => db.run(statement)),
          statement,
        ).toBe(reason);
      }
      // Also refused inside a transactionSync, and the throw rolls it back.
      expect(() =>
        storage.transactionSync(() => {
          storage.sql.exec("INSERT INTO timers(name, due_at) VALUES ('drain', 1)");
          storage.sql.exec('SAVEPOINT inner_sp');
        }),
      ).toThrow(SqlStatementRefusedError);
      expect(tableDump(db)).toEqual(before);
    });
  });

  it('RETURNING and ON CONFLICT DO UPDATE ... WHERE behave as SQLite', async () => {
    await inDb('conf-upsert', (db) => {
      const insertHint = `INSERT INTO hints(uri,did,collection,rkey,source,priority,hint_rev,receipt_time,due_at)
        VALUES (?, 'did:plc:alice', '${SCROBBLE}', 'r1', 'jetstream', ?, ?, ?, ?)`;
      const coalesce = `${insertHint}
        ON CONFLICT(uri) DO UPDATE SET
          due_at = min(hints.due_at, excluded.due_at),
          hint_rev = max(coalesce(hints.hint_rev, ''), coalesce(excluded.hint_rev, '')),
          priority = min(hints.priority, excluded.priority)
        RETURNING uri, due_at, hint_rev, priority, attempts`;
      const uri = `at://did:plc:alice/${SCROBBLE}/r1`;

      // Plain insert with RETURNING yields the stored row, defaults included.
      expect(db.all(`${insertHint} RETURNING uri, due_at, attempts, last_error`, uri, 1, '3lb2a', T0, 100)).toEqual([
        { uri, due_at: 100, attempts: 0, last_error: null },
      ]);
      // Coalescing upsert: min(due_at), max(hint_rev), RETURNING the updated row.
      expect(db.all(coalesce, uri, 2, '3lb2c', T0, 50)).toEqual([
        { uri, due_at: 50, hint_rev: '3lb2c', priority: 1, attempts: 0 },
      ]);
      expect(db.all(coalesce, uri, 0, '3lb2b', T0, 70)).toEqual([
        { uri, due_at: 50, hint_rev: '3lb2c', priority: 0, attempts: 0 },
      ]);
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM hints')).toEqual({ n: 1 });

      // Per-URI monotonic guard: DO UPDATE ... WHERE false updates nothing and
      // RETURNING yields no row.
      const guard = `INSERT INTO record_state(uri,did,collection,revision,cid,state,verified_at)
        VALUES (?, 'did:plc:alice', '${SCROBBLE}', ?, ?, ?, ?)
        ON CONFLICT(uri) DO UPDATE SET revision = excluded.revision, cid = excluded.cid, state = excluded.state
        WHERE excluded.revision > record_state.revision
        RETURNING revision, state, cid`;
      expect(db.all(guard, uri, '3lb2m', 'bafy-new', 'present', T0)).toEqual([
        { revision: '3lb2m', state: 'present', cid: 'bafy-new' },
      ]);
      expect(db.all(guard, uri, '3lb2k', null, 'absent', T0)).toEqual([]); // older: refused
      expect(db.run(guard, uri, '3lb2m', null, 'absent', T0)).toEqual({ rowsWritten: 0 }); // equal: refused
      expect(db.one('SELECT revision, state, cid FROM record_state')).toEqual({
        revision: '3lb2m',
        state: 'present',
        cid: 'bafy-new',
      });
      expect(db.all(guard, uri, '3lb2z', null, 'absent', T0)).toEqual([
        { revision: '3lb2z', state: 'absent', cid: null },
      ]);

      // DO NOTHING on conflict returns no row; UPDATE/DELETE ... RETURNING work.
      expect(db.all(`${insertHint} ON CONFLICT DO NOTHING RETURNING uri`, uri, 9, null, T0, 1)).toEqual([]);
      expect(db.all('UPDATE hints SET attempts = attempts + 1 WHERE uri = ? RETURNING attempts', uri)).toEqual([
        { attempts: 1 },
      ]);
      expect(db.all('DELETE FROM hints WHERE uri = ? RETURNING uri, due_at', uri)).toEqual([{ uri, due_at: 50 }]);
      expect(db.all('DELETE FROM hints RETURNING uri')).toEqual([]);
    });
  });

  it('partial unique index users_verified_handle allows many NULLs and rejects duplicates', async () => {
    await inDb('conf-handle', (db) => {
      // It is a partial index (WHERE handle IS NOT NULL), not a full UNIQUE
      // index: SQLite's catalog says so, and the planner cannot use it to
      // answer a handle IS NULL query, which a full index could.
      expect(
        db.one('SELECT "unique", partial FROM pragma_index_list(?) WHERE name = ?', 'users', 'users_verified_handle'),
      ).toEqual({ unique: 1, partial: 1 });
      expect(db.all('SELECT did FROM users INDEXED BY users_verified_handle WHERE handle = ?', 'x')).toEqual([]);
      expect(() => db.all('SELECT did FROM users INDEXED BY users_verified_handle WHERE handle IS NULL')).toThrow(
        /no query solution/,
      );
      addUser(db, 'did:plc:a');
      addUser(db, 'did:plc:b');
      addUser(db, 'did:plc:c');
      addUser(db, 'did:plc:d', 'alice.example.test');
      expect(() => addUser(db, 'did:plc:e', 'alice.example.test')).toThrow(/UNIQUE constraint failed: users\.handle/);
      expect(() => db.run("UPDATE users SET handle = 'alice.example.test' WHERE did = 'did:plc:a'")).toThrow(
        /UNIQUE constraint failed: users\.handle/,
      );
      addUser(db, 'did:plc:e', 'bob.example.test');
      // Clearing the older holder frees the handle for the new one.
      db.run("UPDATE users SET handle = NULL WHERE did = 'did:plc:d'");
      db.run("UPDATE users SET handle = 'alice.example.test' WHERE did = 'did:plc:a'");
      expect(db.all('SELECT did, handle FROM users ORDER BY did')).toEqual([
        { did: 'did:plc:a', handle: 'alice.example.test' },
        { did: 'did:plc:b', handle: null },
        { did: 'did:plc:c', handle: null },
        { did: 'did:plc:d', handle: null },
        { did: 'did:plc:e', handle: 'bob.example.test' },
      ]);
      // BINARY collation: handles differing only by case are distinct keys.
      addUser(db, 'did:plc:f', 'BOB.example.test');
      expect(db.one('SELECT count(*) AS n FROM users WHERE handle IS NULL')).toEqual({ n: 3 });
    });
  });

  it('FK ON DELETE CASCADE is enforced for scrobbles.did and follows.actor', async () => {
    await inDb('conf-fk', (db, storage) => {
      // Node: the adapter sets and reads back foreign_keys=ON at open; a module PRAGMA is denied.
      expect(sqliteDbOf(storage).pragmas().foreign_keys).toBe(1);
      expect(refusal(() => storage.sql.exec('PRAGMA foreign_keys'))).toBe('pragma');
      addUser(db, 'did:plc:alice');
      addUser(db, 'did:plc:bob');
      addScrobble(db, 'did:plc:alice', 'a1');
      addScrobble(db, 'did:plc:alice', 'a2');
      addScrobble(db, 'did:plc:bob', 'b1');
      addFollow(db, 'did:plc:alice', 'did:plc:bob', 'fa');
      addFollow(db, 'did:plc:bob', 'did:plc:alice', 'fb');
      db.run(
        "INSERT INTO record_state(uri,did,collection,revision,cid,state,verified_at) VALUES (?, 'did:plc:alice', ?, 'r', 'c', 'present', ?)",
        `at://did:plc:alice/${SCROBBLE}/a1`,
        SCROBBLE,
        T0,
      );

      // Inserts that reference an unknown user are refused.
      expect(() => addScrobble(db, 'did:plc:nobody', 'x1')).toThrow(/FOREIGN KEY constraint failed/);
      expect(() => addFollow(db, 'did:plc:nobody', 'did:plc:bob', 'fx')).toThrow(/FOREIGN KEY constraint failed/);
      // follows.subject is not a foreign key: following an unknown DID is stored.
      addFollow(db, 'did:plc:bob', 'did:plc:unknown', 'fu');
      // Module SQL cannot switch enforcement off (DO SQLite ignored it; Node denies it).
      expect(refusal(() => storage.sql.exec('PRAGMA foreign_keys = OFF'))).toBe('pragma');
      expect(sqliteDbOf(storage).pragmas().foreign_keys).toBe(1);
      expect(() => addScrobble(db, 'did:plc:nobody', 'x2')).toThrow(/FOREIGN KEY constraint failed/);

      db.run("DELETE FROM users WHERE did = 'did:plc:alice'");
      expect(db.all('SELECT uri FROM scrobbles ORDER BY uri')).toEqual([{ uri: `at://did:plc:bob/${SCROBBLE}/b1` }]);
      expect(db.all('SELECT actor, subject FROM follows ORDER BY uri')).toEqual([
        { actor: 'did:plc:bob', subject: 'did:plc:alice' },
        { actor: 'did:plc:bob', subject: 'did:plc:unknown' },
      ]);
      // Tables without a declared FK are not cascaded: disconnect must delete them explicitly.
      expect(db.one('SELECT count(*) AS n FROM record_state')).toEqual({ n: 1 });
    });
  });

  // M1.3.1/unique_record: inserting the same AT URI twice is a constraint
  // failure and the row count stays one (a plain INSERT never upserts).
  it('second plain INSERT of one scrobbles.uri fails with a constraint error and the row count stays one', async () => {
    await inDb('conf-unique-uri', (db, storage) => {
      addUser(db, 'did:plc:alice');
      const uri = `at://did:plc:alice/${SCROBBLE}/r1`;
      addScrobble(db, 'did:plc:alice', 'r1');
      const first = db.all('SELECT * FROM scrobbles');
      expect(first).toHaveLength(1);

      // Same uri, different payload: refused by the primary key, through doDb and raw exec.
      const insert = `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
      const params = [
        uri,
        'bafy-other',
        'did:plc:alice',
        'r1',
        '3lb2zzzzzzz2z',
        'Other',
        'Other',
        T0,
        T0,
        T0,
        'o',
        'o',
      ];
      expect(() => db.run(insert, ...params)).toThrow(/UNIQUE constraint failed: scrobbles\.uri/);
      expect(() => storage.sql.exec(insert, ...params)).toThrow(/UNIQUE constraint failed: scrobbles\.uri/);
      expect(() => addScrobble(db, 'did:plc:alice', 'r1')).toThrow(/UNIQUE constraint failed: scrobbles\.uri/);

      // Inside a transaction the failure aborts the whole unit: an earlier write in it is gone.
      expect(() =>
        db.tx(() => {
          db.run("INSERT INTO timers(name, due_at) VALUES ('drain', 1)");
          db.run(insert, ...params);
        }),
      ).toThrow(/UNIQUE constraint failed: scrobbles\.uri/);
      expect(db.all('SELECT * FROM timers')).toEqual([]);

      // Still exactly one row, byte-identical to the first insert.
      expect(db.one('SELECT count(*) AS n FROM scrobbles')).toEqual({ n: 1 });
      expect(db.one('SELECT count(*) AS n FROM scrobbles WHERE uri = ?', uri)).toEqual({ n: 1 });
      expect(db.all('SELECT * FROM scrobbles')).toEqual(first);
      expect(db.one('SELECT cid, revision, artist FROM scrobbles')).toEqual({
        cid: 'bafy-r1',
        revision: '3lb2aaaaaaa2a',
        artist: 'Artist',
      });
      // follows.uri is a primary key too.
      addUser(db, 'did:plc:bob');
      addFollow(db, 'did:plc:alice', 'did:plc:bob', 'f1');
      expect(() => addFollow(db, 'did:plc:alice', 'did:plc:bob', 'f1')).toThrow(
        /UNIQUE constraint failed: follows\.uri/,
      );
      expect(db.one('SELECT count(*) AS n FROM follows')).toEqual({ n: 1 });
    });
  });

  // M1.3.1/foreign_key: a row for a missing owner is rejected with no dangling row.
  it('INSERT of a scrobble or follow whose users row is missing is rejected and leaves no row', async () => {
    await inDb('conf-fk-missing-owner', (db, storage) => {
      expect(sqliteDbOf(storage).pragmas().foreign_keys).toBe(1);
      addUser(db, 'did:plc:bob');
      const before = { users: db.all('SELECT * FROM users'), timers: db.all('SELECT * FROM timers') };

      // No users row for did:plc:nobody: both owner foreign keys refuse.
      expect(() => addScrobble(db, 'did:plc:nobody', 's1')).toThrow(/FOREIGN KEY constraint failed/);
      expect(() => addFollow(db, 'did:plc:nobody', 'did:plc:bob', 'f1')).toThrow(/FOREIGN KEY constraint failed/);
      // INSERT OR IGNORE does not bypass a foreign key (SQLite ignores only
      // UNIQUE/NOT NULL/CHECK conflicts).
      expect(() =>
        db.run(
          'INSERT OR IGNORE INTO follows(uri,cid,actor,subject,revision,created_at,indexed_at) VALUES (?,?,?,?,?,?,?)',
          `at://did:plc:nobody/${FOLLOW}/f2`,
          'bafy-f2',
          'did:plc:nobody',
          'did:plc:bob',
          '3lb2aaaaaaa2a',
          T0,
          T0,
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);
      // In a transaction, the failure rolls back the other writes of the unit.
      expect(() =>
        db.tx(() => {
          db.run("INSERT INTO timers(name, due_at) VALUES ('drain', 1)");
          addScrobble(db, 'did:plc:nobody', 's2');
        }),
      ).toThrow(/FOREIGN KEY constraint failed/);

      // No dangling rows anywhere.
      expect(db.one('SELECT count(*) AS n FROM scrobbles')).toEqual({ n: 0 });
      expect(db.one('SELECT count(*) AS n FROM follows')).toEqual({ n: 0 });
      // PRAGMA foreign_key_check is denied on Node; the same check as a join.
      expect(refusal(() => db.all('PRAGMA foreign_key_check'))).toBe('pragma');
      expect(orphans(db)).toEqual([]);
      expect({ users: db.all('SELECT * FROM users'), timers: db.all('SELECT * FROM timers') }).toEqual(before);

      // Control: once the users row exists the same inserts succeed.
      addUser(db, 'did:plc:nobody');
      addScrobble(db, 'did:plc:nobody', 's1');
      addFollow(db, 'did:plc:nobody', 'did:plc:bob', 'f1');
      expect(db.all('SELECT did, rkey FROM scrobbles')).toEqual([{ did: 'did:plc:nobody', rkey: 's1' }]);
      expect(db.all('SELECT actor, subject FROM follows')).toEqual([
        { actor: 'did:plc:nobody', subject: 'did:plc:bob' },
      ]);
    });
  });

  it('BLOB round-trip in snapshot_blocks', async () => {
    await inDb('conf-blob', (db) => {
      const every = new Uint8Array(512);
      for (let i = 0; i < every.length; i++) every[i] = i & 0xff;
      const big = seededRandom(7).bytes(1024 * 1024); // 1 MiB, under the 2 MB row limit
      const insert = 'INSERT INTO snapshot_blocks(did, cid, bytes) VALUES (?, ?, ?)';
      db.run(insert, 'did:plc:alice', 'bafy-every', every.slice().buffer);
      db.run(insert, 'did:plc:alice', 'bafy-big', big.slice().buffer);
      db.run(insert, 'did:plc:bob', 'bafy-every', new ArrayBuffer(0));

      const bigHead = Array.from(big.slice(0, 4), (x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
      const rows = db.all<{ did: string; cid: string; bytes: ArrayBuffer; n: number; ty: string; head: string }>(
        'SELECT did, cid, bytes, length(bytes) AS n, typeof(bytes) AS ty, hex(substr(bytes, 1, 4)) AS head FROM snapshot_blocks ORDER BY did, cid',
      );
      expect(rows.map(({ did, cid, n, ty, head }) => ({ did, cid, n, ty, head }))).toEqual([
        { did: 'did:plc:alice', cid: 'bafy-big', n: 1_048_576, ty: 'blob', head: bigHead },
        { did: 'did:plc:alice', cid: 'bafy-every', n: 512, ty: 'blob', head: '00010203' },
        { did: 'did:plc:bob', cid: 'bafy-every', n: 0, ty: 'blob', head: '' },
      ]);
      for (const row of rows) expect(row.bytes).toBeInstanceOf(ArrayBuffer);
      // Byte-exact comparison (a plain loop: deep-equal over 1 MiB is slow).
      expect(firstDifference(new Uint8Array(rows[0]?.bytes ?? new ArrayBuffer(1)), big)).toBe(-1);
      expect(new Uint8Array(rows[1]?.bytes ?? new ArrayBuffer(1))).toEqual(every);
      expect(rows[2]?.bytes.byteLength).toBe(0);
      // A BLOB parameter compares by bytes.
      expect(db.one('SELECT cid FROM snapshot_blocks WHERE bytes = ?', every.slice().buffer)).toEqual({
        cid: 'bafy-every',
      });
      // (did, cid) is the key; a duplicate block is refused, OR IGNORE keeps the first.
      expect(() => db.run(insert, 'did:plc:alice', 'bafy-every', new Uint8Array([9]).buffer)).toThrow(
        /UNIQUE constraint failed/,
      );
      db.run(
        'INSERT OR IGNORE INTO snapshot_blocks(did, cid, bytes) VALUES (?, ?, ?)',
        'did:plc:alice',
        'bafy-every',
        new Uint8Array([9]).buffer,
      );
      expect(
        db.one(
          'SELECT length(bytes) AS n FROM snapshot_blocks WHERE did = ? AND cid = ?',
          'did:plc:alice',
          'bafy-every',
        ),
      ).toEqual({
        n: 512,
      });
    });
  });

  it('row-value comparison (a,b) < (?,?) and BINARY collation order equals UTF-8 code point order', async () => {
    await inDb('conf-order', (db) => {
      addUser(db, 'did:plc:alice');
      const t = (s: number) => `2026-01-15T11:59:${String(s).padStart(2, '0')}.000000000Z`;
      addScrobble(db, 'did:plc:alice', 'r1', t(10));
      addScrobble(db, 'did:plc:alice', 'r2', t(20));
      addScrobble(db, 'did:plc:alice', 'r3', t(20));
      addScrobble(db, 'did:plc:alice', 'r4', t(20));
      addScrobble(db, 'did:plc:alice', 'r5', t(30));
      const u = (rkey: string) => `at://did:plc:alice/${SCROBBLE}/${rkey}`;
      const page = (op: '<' | '<=', at: string, uri: string) =>
        db
          .all<{ rkey: string }>(
            `SELECT rkey FROM scrobbles WHERE did = ? AND (listened_at, uri) ${op} (?, ?)
             ORDER BY listened_at DESC, uri DESC`,
            'did:plc:alice',
            at,
            uri,
          )
          .map((r) => r.rkey);
      // Keyset pagination: equal timestamps tie-break by uri, strictly below the tuple.
      expect(page('<', t(20), u('r3'))).toEqual(['r2', 'r1']);
      expect(page('<=', t(20), u('r3'))).toEqual(['r3', 'r2', 'r1']);
      expect(page('<', t(30), u('r5'))).toEqual(['r4', 'r3', 'r2', 'r1']);
      expect(page('<', t(20), u('r2'))).toEqual(['r1']);
      expect(page('<', t(10), u('r1'))).toEqual([]);
      // A larger timestamp wins even with a smaller uri.
      expect(page('<=', t(30), u('r0'))).toEqual(['r4', 'r3', 'r2', 'r1']);

      // BINARY collation is UTF-8 byte order = code point order (Rust String Ord),
      // which differs from JavaScript's UTF-16 sort for astral characters.
      const names = [
        'a',
        'B',
        '\u00E9',
        '\uFFFF',
        '\u{1F600}',
        '\uE000',
        '\u{10FFFF}',
        'Z',
        '\u0080',
        '\u07FF',
        '\u0800',
      ];
      names.forEach((name, i) => {
        db.run('INSERT INTO timers(name, due_at) VALUES (?, ?)', name, i);
      });
      const sqlOrder = db.all<{ name: string }>('SELECT name FROM timers ORDER BY name').map((r) => r.name);
      const codePointOrder = [
        'B',
        'Z',
        'a',
        '\u0080',
        '\u00E9',
        '\u07FF',
        '\u0800',
        '\uE000',
        '\uFFFF',
        '\u{1F600}',
        '\u{10FFFF}',
      ];
      expect(sqlOrder).toEqual(codePointOrder);
      expect([...names].sort()).not.toEqual(codePointOrder); // JS sort puts astral before U+E000
      // Cross-check against raw UTF-8 bytes.
      const enc = new TextEncoder();
      const byBytes = [...names].sort((x, y) => {
        const a = enc.encode(x);
        const b = enc.encode(y);
        for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
        return a.length - b.length;
      });
      expect(byBytes).toEqual(codePointOrder);
      // Comparison operators and row values use the same collation.
      expect(
        db.one("SELECT ('\uE000' < '\u{1F600}') AS x, ('a' < 'B') AS y, (('k', '\uFFFF') < ('k', '\u{1F600}')) AS z"),
      ).toEqual({
        x: 1,
        y: 0,
        z: 1,
      });
    });
  });

  // ADR 0005 §3.2, §15.3 (N2-02): the Node replacement of the two DO-only
  // tests above it in the workerd suite ("integers up to 2^53-1 round-trip
  // exactly; documents precision loss above" and "multi-statement exec binds
  // only the last statement"), plus the BEGIN/SAVEPOINT/PRAGMA denials.
  it('on Node an integer above 2^53 is refused on read, multi-statement text is refused, and BEGIN, SAVEPOINT and PRAGMA are denied', async () => {
    await inDb('conf-node-refusals', (db, storage) => {
      // Integers up to 2^53 - 1 still round-trip exactly, through doDb and raw exec.
      const put = "INSERT INTO counters(name, label, value) VALUES ('n', ?, ?)";
      const values: Array<[string, number]> = [
        ['max_safe', Number.MAX_SAFE_INTEGER],
        ['jetstream_time_us', 1_768_478_400_123_456],
        ['jetstream_seq', 1_800_000_000_000_001],
        ['epoch_ms', 1_768_478_400_000],
        ['zero', 0],
      ];
      for (const [label, value] of values) expect(db.run(put, label, value)).toEqual({ rowsWritten: 1 });
      for (const [label, value] of values) {
        expect(
          db.one('SELECT value, CAST(value AS TEXT) AS t, typeof(value) AS ty FROM counters WHERE label = ?', label),
        ).toEqual({ value, t: String(value), ty: 'integer' });
        expect(storage.sql.exec('SELECT value FROM counters WHERE label = ?', label).one()).toEqual({ value });
      }

      // Above 2^53 - 1: SQLite stores the exact 64-bit integer (a literal in
      // the SQL text; no unsafe JS number can be bound), and reading it as a
      // number throws SqlRangeError (ERR_OUT_OF_RANGE) instead of returning
      // 9007199254740992 as the DO binding did. CAST(... AS TEXT) still reads it.
      storage.sql.exec("INSERT INTO counters(name, label, value) VALUES ('n', 'above', 9007199254740993)");
      const above = "SELECT value FROM counters WHERE label = 'above'";
      for (const read of [() => db.one(above), () => db.all(above), () => storage.sql.exec(above).toArray()]) {
        let error: unknown;
        try {
          read();
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(SqlRangeError);
        expect((error as SqlRangeError).code).toBe('ERR_OUT_OF_RANGE');
      }
      expect(
        db.one("SELECT CAST(value AS TEXT) AS t, typeof(value) AS ty FROM counters WHERE label = 'above'"),
      ).toEqual({ t: '9007199254740993', ty: 'integer' });
      expect(db.one("SELECT CAST(value + 1 AS TEXT) AS t FROM counters WHERE label = 'above'")).toEqual({
        t: '9007199254740994',
      });
      expect(() => db.one('SELECT 9223372036854775807 AS v')).toThrow(SqlRangeError);
      expect(db.one('SELECT CAST(9223372036854775807 AS TEXT) AS t')).toEqual({ t: '9223372036854775807' });
      // Binding is guarded on every path, raw exec included (DO raw exec took
      // 2^53 + 2 and bound `true` as TEXT 'true').
      for (const value of [2 ** 53 + 2, true]) {
        expect(() => storage.sql.exec('SELECT ? AS v', value)).toThrow(SqlParamError);
        expect(() => db.one('SELECT ? AS v', value as number)).toThrow(SqlParamError);
      }

      // Multi-statement text is refused before anything runs (DO ran every
      // statement and bound parameters into the last one).
      const timers = () => db.all('SELECT name, due_at FROM timers ORDER BY name');
      expect(timers()).toEqual([]);
      for (const text of [
        "INSERT INTO timers(name, due_at) VALUES ('first', 1); INSERT INTO timers(name, due_at) VALUES ('second', 2)",
        "INSERT INTO timers(name, due_at) VALUES ('first', 1); -- trailing comment\nSELECT 1",
        'SELECT 1 AS a; SELECT 2 AS b',
      ]) {
        expect(
          refusal(() => storage.sql.exec(text)),
          text,
        ).toBe('multiple_statements');
        expect(
          refusal(() => db.run(text)),
          text,
        ).toBe('multiple_statements');
      }
      expect(refusal(() => db.all('SELECT 1 AS a; SELECT ? AS b', 7))).toBe('multiple_statements');
      expect(timers()).toEqual([]);
      // One statement with a final `;`, or a `;` inside a literal or a comment, is one statement.
      expect(db.run("INSERT INTO timers(name, due_at) VALUES ('semi;colon', 1);")).toEqual({ rowsWritten: 1 });
      expect(db.all('SELECT name FROM timers /* ; */ ORDER BY name; ')).toEqual([{ name: 'semi;colon' }]);

      // BEGIN, SAVEPOINT and PRAGMA are denied for module SQL, inside a
      // transaction too, and the denial changes nothing.
      const before = tableDump(db);
      const denied: Array<[string, string]> = [
        ['BEGIN', 'transaction'],
        ['BEGIN IMMEDIATE', 'transaction'],
        ['COMMIT', 'transaction'],
        ['ROLLBACK', 'transaction'],
        ['SAVEPOINT sp1', 'savepoint'],
        ['RELEASE sp1', 'savepoint'],
        ['ROLLBACK TO sp1', 'savepoint'],
        ['PRAGMA foreign_keys', 'pragma'],
        ['PRAGMA foreign_keys = OFF', 'pragma'],
        ['PRAGMA journal_mode = DELETE', 'pragma'],
        ['PRAGMA user_version = 7', 'pragma'],
        ['SELECT * FROM pragma_foreign_key_check', 'pragma'],
        ["ATTACH DATABASE ':memory:' AS other", 'attach'],
      ];
      for (const [text, reason] of denied) {
        expect(
          refusal(() => storage.sql.exec(text)),
          text,
        ).toBe(reason);
        expect(
          refusal(() => db.all(text)),
          text,
        ).toBe(reason);
      }
      expect(() =>
        db.tx(() => {
          db.run("INSERT INTO timers(name, due_at) VALUES ('inside', 2)");
          db.run('PRAGMA foreign_keys = OFF');
        }),
      ).toThrow(SqlStatementRefusedError);
      expect(tableDump(db)).toEqual(before);
      // The startup pragmas are untouched, read back by the adapter itself.
      expect(sqliteDbOf(storage).pragmas()).toMatchObject({
        foreign_keys: 1,
        journal_mode: 'wal',
        synchronous: 2,
        locking_mode: 'exclusive',
      });
      // Transactions are the adapter's: db.tx (and storage.transactionSync) nest and commit.
      db.tx(() => {
        db.run("INSERT INTO timers(name, due_at) VALUES ('outer', 3)");
        expect(() =>
          storage.transactionSync(() => {
            db.run("INSERT INTO timers(name, due_at) VALUES ('inner', 4)");
            throw new Error('inner rolls back alone');
          }),
        ).toThrow('inner rolls back alone');
      });
      expect(timers()).toEqual([
        { name: 'outer', due_at: 3 },
        { name: 'semi;colon', due_at: 1 },
      ]);
    });
  });
});
