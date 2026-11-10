// Large direct-SQL history fixtures exercise the production bounded reclaimer.
import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import { LOVE_API_RECLAIM_PAGE, reclaimLoveApiProofRows } from '../../src/forward/love-api-maintenance';
import { type Harness, LOVE, withHarness } from '../node/outbox/support';

const PAGE_READ_BOUND = 10;
const PAGE_MUTATION_BOUND = 17;
const PAGE_CHANGED_BOUND = 16;
const PAGE_VISIT_BOUND = LOVE_API_RECLAIM_PAGE;

interface PassMetric {
  reads: number;
  mutations: number;
  returnedRows: number;
  changedRows: number;
  statements: Array<{ sql: string; params: SqlParam[] }>;
}

function observedDb(raw: Db) {
  const originalAll = raw.all.bind(raw);
  const originalOne = raw.one.bind(raw);
  const originalRun = raw.run.bind(raw);
  const mutation = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
  const statements: Array<{ sql: string; params: SqlParam[]; rows: number }> = [];
  let reads = 0;
  let mutations = 0;
  let returnedRows = 0;
  let before = 0;
  const db: Db = {
    all<T>(sql: string, ...params: SqlParam[]): T[] {
      const rows = originalAll<T>(sql, ...params);
      account(sql, params, rows.length);
      return rows;
    },
    one<T>(sql: string, ...params: SqlParam[]): T | null {
      const row = originalOne<T>(sql, ...params);
      account(sql, params, row === null ? 0 : 1);
      return row;
    },
    run(sql: string, ...params: SqlParam[]) {
      const result = originalRun(sql, ...params);
      account(sql, params, 0);
      return result;
    },
    tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
      return raw.tx(fn);
    },
  };
  function account(sql: string, params: SqlParam[], rows: number) {
    if (mutation.test(sql)) mutations++;
    else reads++;
    returnedRows += rows;
    statements.push({ sql, params, rows });
  }
  return {
    db,
    start() {
      reads = 0;
      mutations = 0;
      returnedRows = 0;
      statements.length = 0;
      before = originalOne<{ n: number }>('SELECT total_changes() AS n')!.n;
    },
    metric(): PassMetric {
      return {
        reads,
        mutations,
        returnedRows,
        changedRows: originalOne<{ n: number }>('SELECT total_changes() AS n')!.n - before,
        statements: [...statements],
      };
    },
    originalOne,
  };
}

function assertPageBounds(metric: PassMetric, visited: number): void {
  if (metric.reads > PAGE_READ_BOUND) throw new Error('origin reclaim read bound exceeded');
  if (metric.mutations > PAGE_MUTATION_BOUND) throw new Error('origin reclaim mutation bound exceeded');
  if (metric.changedRows > PAGE_CHANGED_BOUND) throw new Error('origin reclaim changed-row bound exceeded');
  if (visited > PAGE_VISIT_BOUND) throw new Error('origin reclaim visit bound exceeded');
}

function assertIndexedPlans(db: Db, statements: PassMetric['statements']): void {
  for (const statement of statements) {
    const plan = db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement.sql}`, ...statement.params)
      .map((row) => row.detail);
    const l2References = [...statement.sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(love_api_[a-z0-9_]+)/gi)].map(
      (match) => match[1]!.toLowerCase(),
    );
    const scansL2 = plan.some((detail) => {
      const match = detail.match(/\bSCAN\s+(?:TABLE\s+)?([a-z0-9_]+)/i);
      return match !== null && l2References.includes(match[1]!.toLowerCase());
    });
    if (scansL2 || plan.some((detail) => /TEMP B-TREE/i.test(detail)))
      throw new Error('origin reclaim query scans or sorts an L2 table');
  }
}

it('keeps selected origins and reclaims large unneeded binding history in finite bounded pages', async () => {
  const results: Array<{ size: number; passes: number; max: PassMetric; finalRelease: PassMetric[] }> = [];
  for (const size of [100, 1_000, 10_000]) {
    const result = await new Promise<(typeof results)[number]>((resolve, reject) => {
      void withHarness(async (h: Harness) => {
        try {
          h.seedUser(h.alice);
          const linkId = h.link(h.alice, 'listenbrainz');
          const retainedSeq = size;
          const retainedOperation = `api-op-${retainedSeq}`;
          const retainedUri = `at://${h.alice}/${LOVE}/retained${retainedSeq.toString(36)}`;
          const retainedIncarnation = `love:${retainedUri}:api:${retainedOperation}`;
          h.db.tx(() => {
            for (let seq = 1; seq <= size; seq++) {
              const operation = `api-op-${seq}`;
              const uri = `at://${h.alice}/${LOVE}/retained${seq.toString(36)}`;
              const incarnation = `love:${uri}:api:${operation}`;
              h.db.run(
                `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
                 VALUES(?,?,'listenbrainz',?,?,?,1)`,
                h.alice,
                operation,
                uri,
                incarnation,
                seq,
              );
            }
            h.db.run(
              `INSERT INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,
                 sent_operation_id,created_at_ms,updated_at_ms)
               VALUES(?,?,?, ?,1,1,'present',?,1,1)`,
              h.alice,
              retainedUri,
              retainedIncarnation,
              linkId,
              retainedOperation,
            );
            h.db.run(
              `INSERT INTO love_api_proof_state(singleton,next_binding_seq,reclaim_kind,binding_cursor,binding_frontier,reclaim_passes)
               VALUES(1,?,'binding',0,?,1)`,
              size + 1,
              size,
            );
          });

          const observed = observedDb(h.db);
          let passes = 0;
          let max: PassMetric | null = null;
          let visited = 0;
          while (h.db.one<{ count: number }>('SELECT count(*) AS count FROM love_api_bindings')!.count > 1) {
            if (passes > Math.ceil(size / LOVE_API_RECLAIM_PAGE)) throw new Error('origin reclaim did not finish');
            observed.start();
            const pass = reclaimLoveApiProofRows(observed.db, 10);
            const metric = observed.metric();
            assertPageBounds(metric, pass.visited);
            if (passes === 0) assertIndexedPlans(h.db, metric.statements);
            if (pass.lane !== 'binding') throw new Error(`expected binding lane, got ${pass.lane}`);
            passes++;
            visited += pass.visited;
            if (max === null || metric.reads > max.reads) max = metric;
          }
          expect(passes).toBe(Math.ceil(size / LOVE_API_RECLAIM_PAGE));
          expect(visited).toBe(size);
          expect(
            h.db.one<{ api_origin: string; binding_seq: number }>(
              'SELECT api_origin,binding_seq FROM love_api_bindings WHERE did=? AND operation_id=?',
              h.alice,
              retainedOperation,
            ),
          ).toEqual({ api_origin: 'listenbrainz', binding_seq: size });
          expect(h.db.one('SELECT count(*) AS count FROM love_api_bindings')).toEqual({ count: 1 });

          h.db.run(
            `UPDATE love_api_recipients SET state='released',sent_operation_id=NULL
             WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=1`,
            h.alice,
            retainedUri,
            retainedIncarnation,
            linkId,
          );
          const finalRelease: PassMetric[] = [];
          for (let step = 0; step < 4 && h.db.one('SELECT 1 FROM love_api_bindings') !== null; step++) {
            observed.start();
            const pass = reclaimLoveApiProofRows(observed.db, 11);
            const metric = observed.metric();
            assertPageBounds(metric, pass.visited);
            finalRelease.push(metric);
          }
          expect(h.db.one('SELECT 1 FROM love_api_bindings')).toBeNull();
          if (max === null) throw new Error('missing measured reclaim page');
          resolve({ size, passes, max, finalRelease });
        } catch (error) {
          reject(error);
        }
      }).catch(reject);
    });
    results.push(result);
  }
  const first = results[0]!.max;
  expect(results.map(({ max }) => [max.reads, max.mutations, max.changedRows])).toEqual(
    results.map(() => [first.reads, first.mutations, first.changedRows]),
  );
  expect(results.map(({ size, passes }) => [size, passes])).toEqual(
    [100, 1_000, 10_000].map((size) => [size, Math.ceil(size / LOVE_API_RECLAIM_PAGE)]),
  );
  expect(results.every(({ finalRelease }) => finalRelease.length <= 4)).toBe(true);
  console.log(
    JSON.stringify(
      results.map(({ size, passes, max, finalRelease }) => ({
        size,
        passes,
        page: {
          reads: max.reads,
          mutations: max.mutations,
          changedRows: max.changedRows,
          returnedRows: max.returnedRows,
        },
        releasePasses: finalRelease.map(({ reads, mutations, changedRows, returnedRows }) => ({
          reads,
          mutations,
          changedRows,
          returnedRows,
        })),
      })),
    ),
  );
});

it('trips the actual per-page read, mutation, changed-row and visit bounds', () => {
  const metric: PassMetric = { reads: 10, mutations: 17, changedRows: 16, returnedRows: 8, statements: [] };
  expect(() => assertPageBounds({ ...metric, reads: 11 }, 8)).toThrow('origin reclaim read bound exceeded');
  expect(() => assertPageBounds({ ...metric, mutations: 18 }, 8)).toThrow('origin reclaim mutation bound exceeded');
  expect(() => assertPageBounds({ ...metric, changedRows: 17 }, 8)).toThrow(
    'origin reclaim changed-row bound exceeded',
  );
  expect(() => assertPageBounds(metric, 9)).toThrow('origin reclaim visit bound exceeded');
});

it('trips scan and sort controls against actual SQLite plans for deliberately unbounded L2 SQL', async () => {
  await withHarness(async (h) => {
    const scan = 'SELECT * FROM love_api_bindings';
    expect(() => assertIndexedPlans(h.db, [{ sql: scan, params: [] }])).toThrow(
      'origin reclaim query scans or sorts an L2 table',
    );
    const sort = 'SELECT did,operation_id FROM love_api_bindings ORDER BY api_origin';
    expect(() => assertIndexedPlans(h.db, [{ sql: sort, params: [] }])).toThrow(
      'origin reclaim query scans or sorts an L2 table',
    );
  });
});
