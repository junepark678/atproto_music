// The keyset predicate shared by history and both feeds
// (worker/src/do/read/history.ts `keysetWhere`). When the cursor's last
// returned row is provably at or below its anchor (`last <= upper`, decided
// in JavaScript only for ASCII keys) the anchor clause is implied and only
// `< last` is emitted, so the index seek starts at `last` instead of at the
// anchor. Otherwise (`last > upper`, or a non-ASCII key whose UTF-16 order
// may differ from SQLite's UTF-8 byte order) both clauses are emitted. Every
// case must return exactly the page the two-clause form returns.
//
// 60 scrobbles of one user (20 seconds × 3 equal timestamps, so URIs break
// ties) enter SQLite through one range snapshot of a real signed
// repository (applySnapshotChunk + completeSnapshot, the production apply
// path). The page is read through the production `history` module; the
// reference pages come from independent SQL over the same storage.
//
// On Node (ADR 0005 §15.3, N2-02) the DO's rowsRead budgets (ADR 0004 §15
// Q10) are plan assertions on SQLite 3.54.1: node:sqlite has no rows-read
// counter. The page statement's index seek is shown, in SQLite's own program
// (EXPLAIN), to be keyed by the bound `last` values, so the walk starts at
// `last` and the LIMIT stops it after limit + 1 rows; the two-clause form's
// seek is keyed by the anchor and walks every row down to `last`.

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config';
import type { KeysetQuery, ModuleDeps, TimeKey } from '../../src/do/contracts';
import type { Db, SqlParam } from '../../src/do/db';
import { feed } from '../../src/do/read/feed';
import { history, keysetWhere } from '../../src/do/read/history';
import { applySnapshotChunk, completeSnapshot } from '../../src/do/write/apply-snapshot';
import {
  FOLLOW,
  NOW_MS,
  NOW_NS,
  NOW_STORAGE,
  PREFIX,
  SCROBBLE,
  scrobble,
  seedSnapshotJob,
  seedUser,
} from '../write/support';
import { HARNESS_ENV, inTestDb, openTestDb } from './node-harness';

const DID = 'did:web:keyset.test';
const ROWS = 60;
const LIMIT = 5;
const ORDER = 'ORDER BY listened_at DESC, uri DESC';
const BOTH = ' AND (s.listened_at, s.uri) <= (?, ?) AND (s.listened_at, s.uri) < (?, ?)';
const LAST_ONLY = ' AND (s.listened_at, s.uri) < (?, ?)';

async function seeded() {
  const keys = await fixtureKeys();
  const store = await openTestDb();
  const repo = new SignedRepo(DID, keys.alice, { clock: fixedClock() });
  const commit = await repo.writes(
    Array.from({ length: ROWS }, (_, j) => {
      const at = new Date(NOW_MS - (Math.floor(j / 3) + 1) * 60_000).toISOString().replace('.000Z', 'Z');
      return {
        action: 'put' as const,
        collection: SCROBBLE,
        rkey: `k${String(j).padStart(2, '0')}`,
        record: scrobble({ artist: `Artist ${j % 7}`, track: `Track ${j}`, listenedAt: at, createdAt: at }),
      };
    }),
  );
  const entries = commit.ops
    .map((op) => ({ key: op.path, cid: op.cid!, record: op.record }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  await inTestDb(store, (db) => {
    const generation = seedUser(db, DID, { active: false });
    seedSnapshotJob(db, DID, generation);
    const chunk = db.tx(() =>
      applySnapshotChunk(db, {
        did: DID,
        generation,
        headRev: commit.rev,
        intervalLo: null,
        intervalHi: `${PREFIX}/`,
        entries,
        receiptNs: NOW_NS,
        prefix: PREFIX,
        nowNs: NOW_NS,
      }),
    );
    expect(chunk).toEqual({ outcome: 'applied', written: ROWS, unchanged: 0, deleted: 0 });
    const done = db.tx(() =>
      completeSnapshot(db, { did: DID, generation, headRev: commit.rev, accountActive: true, nowNs: NOW_NS }),
    );
    expect(done).toEqual({ outcome: 'complete', active: true });
  });
  return store;
}

interface Traced {
  sql: string;
  params: SqlParam[];
}

/** The database's Db, recording each `all` statement and its parameters. */
function tracingDb(base: Db, trace: Traced[]): Db {
  return {
    ...base,
    all: <T>(query: string, ...params: SqlParam[]) => {
      const rows = base.all<T>(query, ...params);
      trace.push({ sql: query, params });
      return rows;
    },
  };
}

/** The SQLite the plan pins of this file were derived on (ADR 0005 §0 D1). */
const PINNED_SQLITE = '3.54.1';

interface ExplainRow {
  addr: number;
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
  p4: string | number | null;
  comment: string | null;
}

/**
 * The bound values that key the index seek on `index` in SQLite's program for
 * `sql`: the seek opcode's key registers, each traced back to the `Variable`
 * opcode that loads it (`?N` → `params[N-1]`); a register loaded otherwise (a
 * column of an IN list, say) is `{ column: true }`.
 */
function seekKey(db: Db, index: string, sql: string, params: SqlParam[]): unknown[] {
  const program = db.all<ExplainRow>(`EXPLAIN ${sql}`, ...params);
  const open = program.filter((op) => op.opcode === 'OpenRead' && (op.comment ?? '').endsWith(`; ${index}`));
  expect(open, `${index} is opened once`).toHaveLength(1);
  const cursor = open[0]!.p1;
  const seeks = program.filter((op) => /^Seek(GE|GT|LE|LT)$/.test(op.opcode) && op.p1 === cursor);
  expect(seeks, `one seek on ${index}`).toHaveLength(1);
  const { p3: first, p4: count } = seeks[0]!;
  return Array.from({ length: Number(count) }, (_, k) => {
    let register = first + k;
    for (;;) {
      const writer = program.find((op) => ['Variable', 'SCopy', 'Copy'].includes(op.opcode) && op.p2 === register);
      if (writer === undefined) return { column: true };
      if (writer.opcode === 'Variable') return params[writer.p1 - 1];
      register = writer.p1;
    }
  });
}

function queryPlan(db: Db, sql: string, params: SqlParam[]): string[] {
  return db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail);
}

function deps(db: Db): ModuleDeps {
  return {
    db,
    clock: fixedClock(),
    random: seededRandom(1),
    transport: async () => {
      throw new TypeError('no network in module tests');
    },
    identity: {
      resolveDid: async () => {
        throw new TypeError('no identity resolution in module tests');
      },
      resolveHandle: async () => {
        throw new TypeError('no identity resolution in module tests');
      },
    },
    config: parseConfig(HARNESS_ENV, { allowFixturePrefix: true }),
    log: { log() {} },
  };
}

interface Reader {
  keys: TimeKey[];
  /** The production history page: URIs, hasMore and the page statement's trace. */
  page(q: KeysetQuery): { uris: string[]; hasMore: boolean; statement: Traced };
  /** Independent reference page: the given keyset SQL, limit + 1 probe. */
  reference(sql: string, params: SqlParam[]): { uris: string[]; hasMore: boolean; statement: Traced };
  /** SQLite's own `a < b` for two text values (BINARY collation). */
  sqliteLess(a: string, b: string): boolean;
}

function reader(plain: Db): Reader {
  const keys = plain.all<TimeKey>(`SELECT listened_at AS t, uri FROM scrobbles WHERE did = ? ${ORDER}`, DID);
  return {
    keys,
    page(q) {
      const trace: Traced[] = [];
      const r = history(deps(tracingDb(plain, trace)), { did: DID, ...q });
      const statement = trace[0]!;
      expect(statement.sql.trimStart().startsWith('SELECT s.* FROM scrobbles s')).toBe(true);
      return { uris: r.rows.map((x) => x.uri), hasMore: r.hasMore, statement };
    },
    reference(sql, params) {
      const statement: Traced = {
        sql: `SELECT s.uri FROM scrobbles s WHERE s.did = ?${sql} ORDER BY s.listened_at DESC, s.uri DESC LIMIT ?`,
        params: [DID, ...params, LIMIT + 1],
      };
      const uris = plain.all<{ uri: string }>(statement.sql, ...statement.params).map((r) => r.uri);
      return { uris: uris.slice(0, LIMIT), hasMore: uris.length > LIMIT, statement };
    },
    sqliteLess(a, b) {
      return (plain.one<{ lt: number }>('SELECT ? < ? AS lt', a, b)!.lt as number) === 1;
    },
  };
}

const both = (upper: TimeKey, last: TimeKey): SqlParam[] => [upper.t, upper.uri, last.t, last.uri];

describe('keysetWhere', () => {
  it('server-issued cursors (last <= upper, ASCII) emit only the last clause and return the two-clause page with O(limit) rows read', async () => {
    const store = await seeded();
    await inTestDb(store, (db) => {
      const r = reader(db);
      expect(r.keys).toHaveLength(ROWS);
      const k = r.keys;
      // Anchor at the newest row, last at several depths; plus equal keys and
      // two rows that share a timestamp (URI tie-break).
      const cases: Array<[TimeKey, TimeKey, number]> = [
        ...[0, 1, 2, 3, 29, 40, 53].map((d): [TimeKey, TimeKey, number] => [k[0]!, k[d]!, d]),
        [k[10]!, k[10]!, 10],
        [k[3]!, k[4]!, 4],
      ];
      expect(k[3]!.t).toBe(k[4]!.t);
      for (const [upper, last, depth] of cases) {
        const name = `upper ${upper.uri} last ${last.uri}`;
        const q: KeysetQuery = { upper, last, limit: LIMIT };
        expect(keysetWhere(q, 's.listened_at', 's.uri'), name).toEqual({
          sql: LAST_ONLY,
          params: [last.t, last.uri],
        });
        const page = r.page(q);
        const twoClause = r.reference(BOTH, both(upper, last));
        // The two-clause page is the next LIMIT rows after `last`.
        expect(twoClause.uris, name).toEqual(k.slice(depth + 1, depth + 1 + LIMIT).map((x) => x.uri));
        expect({ uris: page.uris, hasMore: page.hasMore }, name).toEqual({
          uris: twoClause.uris,
          hasMore: twoClause.hasMore,
        });
      }
      // Rows read (Node, ADR 0005 §15.3: from SQLite's program, not a
      // counter): the emitted form's seek is keyed by `last`, so it reads
      // from `last` and stops after LIMIT + 1 rows; the two-clause form's seek
      // is keyed by the anchor and walks every row down to `last` (41 here).
      const deep: KeysetQuery = { upper: k[0]!, last: k[40]!, limit: LIMIT };
      const page = r.page(deep);
      const twoClause = r.reference(BOTH, both(k[0]!, k[40]!));
      const plain: Db = db;
      expect(seekKey(plain, 'scrobbles_owner_time', page.statement.sql, page.statement.params)).toEqual([
        DID,
        k[40]!.t,
        k[40]!.uri,
      ]);
      expect(seekKey(plain, 'scrobbles_owner_time', twoClause.statement.sql, twoClause.statement.params)).toEqual([
        DID,
        k[0]!.t,
        k[0]!.uri,
      ]);
      expect(queryPlan(plain, page.statement.sql, page.statement.params).join('\n')).not.toMatch(/TEMP B-TREE/);
    });
  });

  it('last > upper falls back to both clauses and returns only rows at or below the anchor', async () => {
    const store = await seeded();
    await inTestDb(store, (db) => {
      const r = reader(db);
      const k = r.keys;
      // Different timestamps, and one shared timestamp where only the URI orders them.
      expect(k[3]!.t).toBe(k[5]!.t);
      const cases: Array<[TimeKey, TimeKey, number]> = [
        [k[30]!, k[10]!, 30],
        [k[5]!, k[3]!, 5],
        [k[50]!, k[0]!, 50],
      ];
      for (const [upper, last, anchorIndex] of cases) {
        const name = `upper ${upper.uri} last ${last.uri}`;
        const q: KeysetQuery = { upper, last, limit: LIMIT };
        expect(keysetWhere(q, 's.listened_at', 's.uri'), name).toEqual({ sql: BOTH, params: both(upper, last) });
        const page = r.page(q);
        const twoClause = r.reference(BOTH, both(upper, last));
        const expected = k.slice(anchorIndex, anchorIndex + LIMIT).map((x) => x.uri);
        expect(twoClause.uris, name).toEqual(expected);
        expect({ uris: page.uris, hasMore: page.hasMore }, name).toEqual({
          uris: twoClause.uris,
          hasMore: twoClause.hasMore,
        });
        // Dropping the anchor here would be wrong: `< last` alone returns rows above the anchor.
        expect(r.reference(LAST_ONLY, [last.t, last.uri]).uris, name).not.toEqual(expected);
      }
    });
  });

  it('non-ASCII keys fall back to both clauses and return the two-clause page', async () => {
    const store = await seeded();
    await inTestDb(store, (db) => {
      const r = reader(db);
      const k = r.keys;
      const p = k[20]!;
      const bmp = `${p.uri}｡`; // U+FF61: UTF-8 EF BD A1, UTF-16 FF61
      const astral = `${p.uri}\u{1F600}`; // U+1F600: UTF-8 F0 9F 98 80, UTF-16 D83D DE00
      // The hazard the fallback avoids: JavaScript and SQLite order these two differently.
      expect(astral < bmp).toBe(true);
      expect(r.sqliteLess(bmp, astral)).toBe(true);
      expect(r.sqliteLess(astral, bmp)).toBe(false);

      const cases: Array<[string, TimeKey, TimeKey]> = [
        // last <= upper in both orders, but non-ASCII: not decided in JS.
        ['accented last', k[0]!, { t: p.t, uri: `${p.uri}é` }],
        // JS says last < upper; SQLite says last > upper.
        ['astral last, BMP upper', { t: p.t, uri: bmp }, { t: p.t, uri: astral }],
        // JS says last > upper; SQLite says last < upper.
        ['BMP last, astral upper', { t: p.t, uri: astral }, { t: p.t, uri: bmp }],
        // Non-ASCII anchor far above an ASCII last.
        ['non-ASCII anchor', { t: k[0]!.t, uri: `${k[0]!.uri}é` }, k[30]!],
      ];
      for (const [name, upper, last] of cases) {
        const q: KeysetQuery = { upper, last, limit: LIMIT };
        expect(keysetWhere(q, 's.listened_at', 's.uri'), name).toEqual({ sql: BOTH, params: both(upper, last) });
        const page = r.page(q);
        const twoClause = r.reference(BOTH, both(upper, last));
        expect(twoClause.uris.length, name).toBe(LIMIT);
        expect({ uris: page.uris, hasMore: page.hasMore }, name).toEqual({
          uris: twoClause.uris,
          hasMore: twoClause.hasMore,
        });
      }
      // Stored URIs are ASCII, so no stored row lies between the two non-ASCII
      // keys: the last-only form selects the same rows in these cases too.
      for (const [, upper, last] of cases.slice(1, 3)) {
        expect(r.reference(LAST_ONLY, [last.t, last.uri]).uris).toEqual(r.reference(BOTH, both(upper, last)).uris);
      }
    });
  });

  // ADR 0005 §15.3 (N2-02): the Q10 page-statement budgets (ADR 0004 §15 Q10:
  // history ≤ L+3 rows, global feed ≤ 2(L+1)+1, following feed ≤ 4(L+1)+1 plus
  // the viewer's edges), which the DO measured with rowsRead, as plan
  // assertions: a seek keyed by `last` on the time index, rows in index order
  // (no sort) for history and the global feed, so LIMIT ends the walk after
  // L + 1 candidates; the following feed merges one such seek per followee.
  it('history and feed page statements use the single-clause seek plan on SQLite 3.54.1 (Q10 budgets as plan assertions)', async () => {
    expect(process.versions.sqlite).toBe(PINNED_SQLITE);
    const store = await seeded();
    await inTestDb(store, (db) => {
      const plain: Db = db;
      const r = reader(db);
      const k = r.keys;
      // A visible viewer following the seeded owner, for the following feed.
      const VIEWER = 'did:web:viewer.keyset.test';
      seedUser(plain, VIEWER);
      plain.run(
        'INSERT INTO follows(uri, cid, actor, subject, revision, created_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        `at://${VIEWER}/${FOLLOW}/f1`,
        'bafy-follow',
        VIEWER,
        DID,
        '3lb2aaaaaaa2a',
        NOW_STORAGE,
        NOW_STORAGE,
      );

      const upper = k[0]!;
      const last = k[40]!;
      const q: KeysetQuery = { upper, last, limit: LIMIT };
      const expected = k.slice(41, 41 + LIMIT).map((x) => x.uri);
      const traced = (run: (m: ModuleDeps) => { rows: Array<{ uri: string }>; hasMore: boolean }) => {
        const trace: Traced[] = [];
        const page = run(deps(tracingDb(db, trace)));
        const statement = trace.find((t) => t.sql.trimStart().startsWith('SELECT s.* FROM scrobbles s'));
        expect(statement).toBeDefined();
        return { uris: page.rows.map((x) => x.uri), hasMore: page.hasMore, statement: statement! };
      };
      const pages = {
        history: traced((m) => history(m, { did: DID, ...q })),
        global: traced((m) => feed(m, { scope: 'global', ...q })),
        following: traced((m) => feed(m, { scope: 'following', viewer: VIEWER, ...q })),
      };

      for (const [name, page] of Object.entries(pages)) {
        // The same page as the two-clause reference, and only the `last` clause emitted.
        expect([name, page.uris, page.hasMore]).toEqual([name, expected, true]);
        expect(page.statement.sql, name).toContain(LAST_ONLY);
        expect(page.statement.sql, name).not.toContain('<= (?, ?)');
      }

      // EXPLAIN QUERY PLAN pins: the scrobbles step of each page statement.
      const scrobbleSteps = (page: { statement: Traced }) =>
        queryPlan(plain, page.statement.sql, page.statement.params).filter((d) => /\bs\b/.test(d) || /TEMP/.test(d));
      expect(scrobbleSteps(pages.history)).toEqual([
        'SEARCH s USING INDEX scrobbles_owner_time (did=? AND (listened_at,uri)<(?,?))',
      ]);
      expect(scrobbleSteps(pages.global)).toEqual([
        'SEARCH s USING INDEX scrobbles_global_time ((listened_at,uri)<(?,?))',
      ]);
      expect(scrobbleSteps(pages.following)).toEqual([
        'SEARCH s USING INDEX scrobbles_owner_time (did=? AND (listened_at,uri)<(?,?))',
        'USE TEMP B-TREE FOR ORDER BY',
      ]);
      // No plan step of any page statement scans a table.
      for (const [name, page] of Object.entries(pages)) {
        const plan = queryPlan(plain, page.statement.sql, page.statement.params);
        expect([name, plan.filter((d) => /^SCAN /.test(d))]).toEqual([name, []]);
      }

      // SQLite's program: each seek on the time index is keyed by the bound
      // `last` values (the owner DID first on scrobbles_owner_time; for the
      // following feed the DID comes from the followee IN list).
      expect(
        seekKey(plain, 'scrobbles_owner_time', pages.history.statement.sql, pages.history.statement.params),
      ).toEqual([DID, last.t, last.uri]);
      expect(
        seekKey(plain, 'scrobbles_global_time', pages.global.statement.sql, pages.global.statement.params),
      ).toEqual([last.t, last.uri]);
      expect(
        seekKey(plain, 'scrobbles_owner_time', pages.following.statement.sql, pages.following.statement.params),
      ).toEqual([{ column: true }, last.t, last.uri]);

      // Negative control: the two-clause form of the same page (the reference
      // reads only uri, hence COVERING) shows the same index range in EXPLAIN
      // QUERY PLAN, which cannot tell the two apart; its seek is keyed by the
      // anchor, so it walks from the anchor down past `last` (the 41 rows the
      // DO counted).
      const twoClause = r.reference(BOTH, both(upper, last));
      expect(twoClause.uris).toEqual(expected);
      expect(queryPlan(plain, twoClause.statement.sql, twoClause.statement.params)).toEqual([
        'SEARCH s USING COVERING INDEX scrobbles_owner_time (did=? AND (listened_at,uri)<(?,?))',
      ]);
      expect(seekKey(plain, 'scrobbles_owner_time', twoClause.statement.sql, twoClause.statement.params)).toEqual([
        DID,
        upper.t,
        upper.uri,
      ]);
    });
  });
});
