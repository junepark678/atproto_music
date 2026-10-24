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
// ties) enter DO SQLite through one range snapshot of a real signed
// repository (applySnapshotChunk + completeSnapshot, the production apply
// path). The page is read through the production `history` module; the
// reference pages come from independent SQL over the same storage.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config';
import type { KeysetQuery, ModuleDeps, TimeKey } from '../../src/do/contracts';
import { type Db, doDb, type SqlParam } from '../../src/do/db';
import { history, keysetWhere } from '../../src/do/read/history';
import { applySnapshotChunk, completeSnapshot } from '../../src/do/write/apply-snapshot';
import type { HarnessDO } from '../harness/harness-do';
import { NOW_MS, NOW_NS, PREFIX, SCROBBLE, scrobble, seedSnapshotJob, seedUser, stubFor } from '../write/support';

const DID = 'did:web:keyset.test';
const ROWS = 60;
const LIMIT = 5;
const ORDER = 'ORDER BY listened_at DESC, uri DESC';
const BOTH = ' AND (s.listened_at, s.uri) <= (?, ?) AND (s.listened_at, s.uri) < (?, ?)';
const LAST_ONLY = ' AND (s.listened_at, s.uri) < (?, ?)';

async function seeded(name: string) {
  const keys = await fixtureKeys();
  const stub = stubFor(name);
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
  await runInDurableObject(stub, (i: HarnessDO) => {
    const db = i.db;
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
  return stub;
}

interface Traced {
  sql: string;
  rowsRead: number;
}

/** The DO Db, recording each `all` statement's cursor rowsRead. */
function tracingDb(storage: DurableObjectStorage, trace: Traced[]): Db {
  const base = doDb(storage);
  return {
    ...base,
    all: <T>(query: string, ...params: SqlParam[]) => {
      const cursor = storage.sql.exec(query, ...params);
      const rows = cursor.toArray() as T[];
      trace.push({ sql: query, rowsRead: cursor.rowsRead });
      return rows;
    },
  };
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
    config: parseConfig(env, { allowFixturePrefix: true }),
    log: { log() {} },
  };
}

interface Reader {
  keys: TimeKey[];
  /** The production history page: URIs, hasMore and the page statement's trace. */
  page(q: KeysetQuery): { uris: string[]; hasMore: boolean; statement: Traced };
  /** Independent reference page: the given keyset SQL, limit + 1 probe. */
  reference(sql: string, params: SqlParam[]): { uris: string[]; hasMore: boolean; rowsRead: number };
  /** SQLite's own `a < b` for two text values (BINARY collation). */
  sqliteLess(a: string, b: string): boolean;
}

function reader(storage: DurableObjectStorage): Reader {
  const plain = doDb(storage);
  const keys = plain.all<TimeKey>(`SELECT listened_at AS t, uri FROM scrobbles WHERE did = ? ${ORDER}`, DID);
  return {
    keys,
    page(q) {
      const trace: Traced[] = [];
      const r = history(deps(tracingDb(storage, trace)), { did: DID, ...q });
      const statement = trace[0]!;
      expect(statement.sql.trimStart().startsWith('SELECT s.* FROM scrobbles s')).toBe(true);
      return { uris: r.rows.map((x) => x.uri), hasMore: r.hasMore, statement };
    },
    reference(sql, params) {
      const cursor = storage.sql.exec(
        `SELECT s.uri FROM scrobbles s WHERE s.did = ?${sql} ORDER BY s.listened_at DESC, s.uri DESC LIMIT ?`,
        DID,
        ...params,
        LIMIT + 1,
      );
      const uris = cursor.toArray().map((r) => r.uri as string);
      return { uris: uris.slice(0, LIMIT), hasMore: uris.length > LIMIT, rowsRead: cursor.rowsRead };
    },
    sqliteLess(a, b) {
      return (plain.one<{ lt: number }>('SELECT ? < ? AS lt', a, b)!.lt as number) === 1;
    },
  };
}

const both = (upper: TimeKey, last: TimeKey): SqlParam[] => [upper.t, upper.uri, last.t, last.uri];

describe('keysetWhere', () => {
  it('server-issued cursors (last <= upper, ASCII) emit only the last clause and return the two-clause page with O(limit) rows read', async () => {
    const stub = await seeded('keyset-server-cursors');
    await runInDurableObject(stub, (_i: HarnessDO, state) => {
      const r = reader(state.storage);
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
      // Rows read: the emitted form seeks from `last`; the two-clause form
      // seeks from the anchor and walks every row down to `last`.
      const deep: KeysetQuery = { upper: k[0]!, last: k[40]!, limit: LIMIT };
      const page = r.page(deep);
      const twoClause = r.reference(BOTH, both(k[0]!, k[40]!));
      expect(twoClause.rowsRead).toBeGreaterThan(40);
      expect(page.statement.rowsRead).toBeLessThan(40);
      expect(page.statement.rowsRead).toBeLessThanOrEqual(LIMIT + 3);
    });
  });

  it('last > upper falls back to both clauses and returns only rows at or below the anchor', async () => {
    const stub = await seeded('keyset-last-above-upper');
    await runInDurableObject(stub, (_i: HarnessDO, state) => {
      const r = reader(state.storage);
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
    const stub = await seeded('keyset-non-ascii');
    await runInDurableObject(stub, (_i: HarnessDO, state) => {
      const r = reader(state.storage);
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
});
