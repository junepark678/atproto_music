// Direct-SQL growth fixture for the production reused-snapshot API binding path.
// The same file also runs against the clean #209 source archive, which has no
// L2 binding tables, to collect the exact source baseline at each history size.

import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { fromMs } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import { cachedIdentityResolver } from '../../src/do/ingest/identity-cache';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { enqueueLove } from '../../src/outbox/love-ops';
import { type Harness, LOVE, withHarness } from '../node/outbox/support';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const SOURCE = '5d573706bf07bb50e0c8b79cf1d34a3f6c56a975';
const PARENT = {
  1: { reads: 26, mutations: 15, changedRows: 13, returnedRows: 19 },
  2: { reads: 30, mutations: 19, changedRows: 17, returnedRows: 22 },
} as const;
const EXPECTED_L2_DELTA = {
  1: { reads: 10, changedRows: 8 },
  2: { reads: 13, changedRows: 12 },
} as const;
const OLD_BINDING_SCAN_SQL = 'SELECT operation_id FROM love_api_bindings';
const OLD_BINDING_SORT_SQL = 'SELECT operation_id FROM love_api_bindings WHERE did=? ORDER BY created_at_ms DESC';

interface Statement {
  method: 'all' | 'one' | 'run';
  sql: string;
  params: SqlParam[];
  source: string;
  returnedRows: number;
  changedRows: number;
}

function observedDb(raw: Db) {
  const originalAll = raw.all.bind(raw);
  const originalOne = raw.one.bind(raw);
  const originalRun = raw.run.bind(raw);
  let active = false;
  let reads = 0;
  let mutations = 0;
  let returnedRows = 0;
  let changesBefore = 0;
  const statements: Statement[] = [];
  const mutation = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
  const account = (
    method: Statement['method'],
    sql: string,
    params: SqlParam[],
    rowCount: number,
    changedRows: number,
  ) => {
    if (mutation.test(sql)) mutations++;
    else reads++;
    returnedRows += rowCount;
    const source =
      new Error().stack
        ?.split('\n')
        .find((line) => line.includes('/worker/src/'))
        ?.trim() ?? 'test-owned';
    statements.push({ method, sql, params, source, returnedRows: rowCount, changedRows });
  };
  const db: Db = {
    all<T>(sql: string, ...params: SqlParam[]): T[] {
      const before = originalOne<{ n: number }>('SELECT total_changes() AS n')!.n;
      const rows = originalAll<T>(sql, ...params);
      const after = originalOne<{ n: number }>('SELECT total_changes() AS n')!.n;
      if (active) account('all', sql, params, rows.length, after - before);
      return rows;
    },
    one<T>(sql: string, ...params: SqlParam[]): T | null {
      const before = originalOne<{ n: number }>('SELECT total_changes() AS n')!.n;
      const row = originalOne<T>(sql, ...params);
      const after = originalOne<{ n: number }>('SELECT total_changes() AS n')!.n;
      if (active) account('one', sql, params, row === null ? 0 : 1, after - before);
      return row;
    },
    run(sql: string, ...params: SqlParam[]) {
      const before = originalOne<{ n: number }>('SELECT total_changes() AS n')!.n;
      const result = originalRun(sql, ...params);
      const after = originalOne<{ n: number }>('SELECT total_changes() AS n')!.n;
      if (active) account('run', sql, params, 0, after - before);
      return result;
    },
    tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
      return raw.tx(fn);
    },
  };
  return {
    db,
    start() {
      reads = 0;
      mutations = 0;
      returnedRows = 0;
      statements.length = 0;
      changesBefore = originalOne<{ n: number }>('SELECT total_changes() AS n')!.n;
      active = true;
    },
    stop() {
      active = false;
      const l2Statements = statements.filter((statement) =>
        statement.source.includes('/forward/love-api-recipients.ts:'),
      );
      const changedRows = l2Statements.reduce((sum, statement) => sum + statement.changedRows, 0);
      return {
        reads,
        mutations,
        changedRows: originalOne<{ n: number }>('SELECT total_changes() AS n')!.n - changesBefore,
        returnedRows,
        statements: [...statements],
        l2Statements,
        l2ChangedRows: changedRows,
      };
    },
    measure<T>(fn: () => T) {
      this.start();
      const value = fn();
      const metric = this.stop();
      return { value, metric };
    },
    original: raw,
  };
}

function seedHistory(db: Db, size: number, hasL2Bindings: boolean): void {
  db.tx(() => {
    for (let index = 1; index <= size; index++) {
      const rkey = `history${index.toString(36)}`;
      const uri = `at://${DID}/${LOVE}/${rkey}`;
      const operationId = `history-api-op-${index}`;
      db.run(
        `INSERT INTO loves(uri,did,rkey,cid,artist,track,album,artist_key,track_key,recording_mbid,created_at,indexed_at)
         VALUES(?,?,?,'bafybeigdyrzt5sfp7udm7hu76uhy26nf3d3h5dz4pf4h7xj6zft2nq4e','History artist',?,NULL,?,?,NULL,
           '2026-01-15T11:00:00.000000000Z','2026-01-15T11:00:00.000000000Z')`,
        uri,
        DID,
        rkey,
        `History track ${index}`,
        `history-artist-key-${index}`,
        `history-track-key-${index}`,
      );
      const incarnationKey = `love:${uri}:api:${operationId}`;
      db.run(
        `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
         VALUES(?,?,'present','api',NULL,1)`,
        uri,
        incarnationKey,
      );
      if (hasL2Bindings)
        db.run(
          `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
           VALUES(?,?,'web',?,?,?,1)`,
          DID,
          operationId,
          uri,
          incarnationKey,
          index,
        );
    }
    if (hasL2Bindings) {
      db.run(
        `INSERT INTO love_api_proof_state(singleton,next_binding_seq) VALUES(1,?)
         ON CONFLICT(singleton) DO UPDATE SET next_binding_seq=excluded.next_binding_seq`,
        size + 1,
      );
    }
  });
}

function l2TableAliases(sql: string): Set<string> {
  const aliases = new Set<string>();
  const references = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(love_api_[a-z0-9_]+)(?:\s+(?:AS\s+)?([a-z][a-z0-9_]*))?/gi;
  for (const match of sql.matchAll(references)) {
    aliases.add(match[1]!.toLowerCase());
    const possibleAlias = match[2]?.toLowerCase();
    if (possibleAlias !== undefined && !['set', 'where', 'values', 'on', 'returning'].includes(possibleAlias))
      aliases.add(possibleAlias);
  }
  return aliases;
}

function checkL2Plans(db: Db, statements: Statement[]) {
  const plans = statements.map((statement) => {
    const details = db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement.sql}`, ...statement.params)
      .map((row) => row.detail);
    const aliases = l2TableAliases(statement.sql);
    const scanOfL2 = details.filter((detail) => {
      const scan = detail.match(/\bSCAN\s+(?:TABLE\s+)?([a-z0-9_]+)/i)?.[1]?.toLowerCase();
      return scan !== undefined && aliases.has(scan);
    });
    return { sql: statement.sql, source: statement.source, details, scanOfL2 };
  });
  expect(plans.flatMap((plan) => plan.scanOfL2)).toEqual([]);
  expect(plans.flatMap((plan) => plan.details.filter((detail) => /TEMP B-TREE/i.test(detail)))).toEqual([]);
  return plans;
}

function assertGrowthDelta(readDelta: number, changedRowDelta: number, recipients: 1 | 2): void {
  const expected = EXPECTED_L2_DELTA[recipients];
  if (readDelta !== expected.reads || changedRowDelta !== expected.changedRows)
    throw new Error(`API growth delta changed for N${recipients}`);
}

function assertFlatAcrossHistory(metrics: Array<{ reads: number; mutations: number; changedRows: number }>): void {
  const first = metrics[0];
  if (
    first === undefined ||
    metrics.some(
      (metric) =>
        metric.reads !== first.reads ||
        metric.mutations !== first.mutations ||
        metric.changedRows !== first.changedRows,
    )
  )
    throw new Error('API work grew with prior love history');
}

function assertSafePlans(plans: Array<{ scanOfL2: string[]; details: string[] }>): void {
  if (plans.some((plan) => plan.scanOfL2.length > 0 || plan.details.some((detail) => /TEMP B-TREE/i.test(detail))))
    throw new Error('L2 API query plan scans or sorts a table');
}

it('trips the intended API growth and indexed-plan oracles', () => {
  expect(() => assertGrowthDelta(11, 8, 1)).toThrow('API growth delta changed for N1');
  expect(() => assertGrowthDelta(10, 9, 1)).toThrow('API growth delta changed for N1');
  expect(() =>
    assertFlatAcrossHistory([
      { reads: 36, mutations: 25, changedRows: 21 },
      { reads: 37, mutations: 25, changedRows: 21 },
    ]),
  ).toThrow('API work grew with prior love history');
  expect(() => assertSafePlans([{ scanOfL2: ['love_api_bindings'], details: ['SCAN love_api_bindings'] }])).toThrow(
    'L2 API query plan scans or sorts a table',
  );
  expect(() => assertSafePlans([{ scanOfL2: [], details: ['USE TEMP B-TREE FOR ORDER BY'] }])).toThrow(
    'L2 API query plan scans or sorts a table',
  );
});

async function measureScenario(recipientCount: 1 | 2, historySize: number) {
  return await new Promise<{
    hasL2Bindings: boolean;
    metric: ReturnType<ReturnType<typeof observedDb>['stop']>;
    plans: ReturnType<typeof checkL2Plans>;
    recipients: number;
    historyCount: number;
    scanControl: { returnedRows: number; plan: string[] };
    sortControl: { returnedRows: number; plan: string[] };
  }>((resolve, reject) => {
    void withHarness(async (h: Harness) => {
      try {
        h.seedUser(h.alice);
        const hasL2Bindings =
          h.db.one<{ n: number }>(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='love_api_bindings'",
          )?.n === 1;
        seedHistory(h.db, historySize, hasL2Bindings);
        const historyCount = h.db.one<{ n: number }>('SELECT count(*) AS n FROM loves WHERE did=?', h.alice)?.n ?? 0;
        const historyBindingCount = hasL2Bindings
          ? (h.db.one<{ n: number }>('SELECT count(*) AS n FROM love_api_bindings WHERE did=?', h.alice)?.n ?? 0)
          : 0;
        expect(historyCount).toBe(historySize);
        if (hasL2Bindings) expect(historyBindingCount).toBe(historySize);

        const targetRkey = `target${recipientCount}${historySize.toString(36)}`;
        await h.kit.externalPut('Alice', LOVE, targetRkey, {
          $type: LOVE,
          artist: 'Measured target artist',
          track: 'Measured target track',
          createdAt: '2026-01-15T11:00:00Z',
        });
        const car = await h.kit.repos.Alice.getRecordCar(LOVE, targetRkey);
        const proof = await verifyRecordProof(car, {
          did: h.alice,
          collection: LOVE,
          rkey: targetRkey,
          signingKey: h.kit.users.Alice.key.didKey,
        });
        const nowNs = fromMs(h.m.clock.nowMs());
        h.db.tx(() =>
          applyRecordProof(h.db, proof, {
            prefix: 'com.example.atmusic',
            nowNs,
            receiptNs: nowNs,
          }),
        );

        h.link(h.alice, 'lastfm');
        if (recipientCount === 2) h.link(h.alice, 'listenbrainz');

        const observed = observedDb(h.db);
        h.m = {
          ...h.m,
          db: observed.db,
          identity: cachedIdentityResolver(observed.db, { transport: h.m.transport, clock: h.m.clock }),
        };
        observed.start();
        const accepted = await enqueueLove(h.m, {
          did: h.alice,
          input: { artist: 'Measured target artist', track: 'Measured target track' },
          origin: 'web',
        });
        if (!accepted.ok) throw new Error(JSON.stringify(accepted.reason));
        await h.runUntilIdle();
        const metric = observed.stop();
        const recipients = hasL2Bindings
          ? (h.db.one<{ n: number }>(
              'SELECT count(*) AS n FROM love_api_recipients WHERE did=? AND uri=?',
              h.alice,
              `at://${h.alice}/${LOVE}/${targetRkey}`,
            )?.n ?? 0)
          : recipientCount;
        if (hasL2Bindings) expect(recipients).toBe(recipientCount);
        const plans = hasL2Bindings ? checkL2Plans(h.db, metric.l2Statements) : [];

        const scan = hasL2Bindings
          ? observed.measure(() => observed.db.all(OLD_BINDING_SCAN_SQL))
          : { value: [], metric: { returnedRows: 0 } };
        const scanPlan = hasL2Bindings
          ? h.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${OLD_BINDING_SCAN_SQL}`).map((row) => row.detail)
          : [];
        const sort = hasL2Bindings ? observed.measure(() => observed.db.all(OLD_BINDING_SORT_SQL, h.alice)) : null;
        const sortPlan = hasL2Bindings
          ? h.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${OLD_BINDING_SORT_SQL}`, h.alice).map((row) => row.detail)
          : [];
        if (hasL2Bindings) {
          expect(scan.value).toHaveLength(historyBindingCount + 1);
          expect(scanPlan.some((detail) => /SCAN/i.test(detail))).toBe(true);
          expect(sort).not.toBeNull();
          expect(sort!.value).toHaveLength(historyBindingCount + 1);
          expect(sortPlan.some((detail) => /TEMP B-TREE/i.test(detail))).toBe(true);
        }
        resolve({
          hasL2Bindings,
          metric,
          plans,
          recipients,
          historyCount,
          scanControl: { returnedRows: scan.metric.returnedRows, plan: scanPlan },
          sortControl: { returnedRows: sort?.metric.returnedRows ?? 0, plan: sortPlan },
        });
      } catch (error) {
        reject(error);
      }
    }).catch(reject);
  });
}

it('keeps current API binding work flat across N1/N2 and 100/1k/10k same-DID love history', async () => {
  const results = [] as Array<{
    recipients: 1 | 2;
    history: number;
    metric: Awaited<ReturnType<typeof measureScenario>>['metric'];
    l2Statements: number;
  }>;
  let current = false;
  for (const recipients of [1, 2] as const) {
    for (const history of [100, 1_000, 10_000]) {
      const result = await measureScenario(recipients, history);
      current ||= result.hasL2Bindings;
      results.push({ recipients, history, metric: result.metric, l2Statements: result.metric.l2Statements.length });
      if (result.hasL2Bindings) {
        const parent = PARENT[recipients];
        assertGrowthDelta(
          result.metric.reads - parent.reads,
          result.metric.changedRows - parent.changedRows,
          recipients,
        );
        expect(result.metric.l2Statements.length).toBeGreaterThan(0);
        expect(result.plans).not.toHaveLength(0);
        assertSafePlans(result.plans);
        expect(result.scanControl.returnedRows).toBe(history + 1);
        expect(result.sortControl.returnedRows).toBe(history + 1);
      }
    }
  }
  if (current) {
    for (const recipients of [1, 2] as const) {
      const series = results.filter((result) => result.recipients === recipients);
      assertFlatAcrossHistory(series.map((result) => result.metric));
      expect(series.map((result) => result.l2Statements)).toEqual([
        series[0]!.l2Statements,
        series[0]!.l2Statements,
        series[0]!.l2Statements,
      ]);
    }
    const n1 = EXPECTED_L2_DELTA[1];
    const n2 = EXPECTED_L2_DELTA[2];
    expect(n2.reads - n1.reads).toBeLessThanOrEqual(3);
    expect(n2.changedRows - n1.changedRows).toBeLessThanOrEqual(4);
    expect(n2.reads).toBeLessThanOrEqual(12 + 3 + 1);
    expect(n2.changedRows).toBeLessThanOrEqual(11 + 4 + 1);
    const smallControl = await measureScenario(1, 100);
    const largeControl = await measureScenario(1, 10_000);
    expect(largeControl.scanControl.returnedRows).toBeGreaterThan(smallControl.scanControl.returnedRows);
    expect(largeControl.sortControl.returnedRows).toBeGreaterThan(smallControl.sortControl.returnedRows);
  } else {
    for (const recipients of [1, 2] as const) {
      const series = results.filter((result) => result.recipients === recipients);
      expect(series.map((result) => result.metric.reads)).toEqual(series.map(() => PARENT[recipients].reads));
      expect(series.map((result) => result.metric.changedRows)).toEqual(
        series.map(() => PARENT[recipients].changedRows),
      );
    }
  }
  console.log(
    JSON.stringify({
      source: SOURCE,
      current,
      results: results.map(({ recipients, history, metric, l2Statements }) => ({
        recipients,
        history,
        reads: metric.reads,
        mutations: metric.mutations,
        changedRows: metric.changedRows,
        returnedRows: metric.returnedRows,
        l2Statements,
        l2ChangedRows: metric.l2ChangedRows,
      })),
    }),
  );
});
