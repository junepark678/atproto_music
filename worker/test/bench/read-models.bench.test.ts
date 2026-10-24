// W6-02: read-model benchmark on DO SQLite in workerd (ADR 0004 §10;
// AMENDMENTS-workers.md A1 for M6.2.3 benchmark_dataset / benchmark_results).
//
// Data. Every scrobble enters DO SQLite through the production path: a real
// signed repository (@atmusic/atproto/test-support/signed-repo, deterministic
// fixture keys on both curves), its head checked by the production
// `verifyCommit`, its MST walked by the production range walker (`step`, at
// most 2,000 entries per chunk, the ADR §5.9 slice bound), each chunk applied
// by `applySnapshotChunk` in one `db.tx` and the snapshot finished by
// `completeSnapshot`. Two DOs, both TestIndexDO (the production IndexDO with
// test dependencies only, test/composition/entry.ts):
// - the M6.2.3 dataset: 100 users × 1,000 scrobbles = exactly 100,000 rows,
//   generator seed 7, the Rust benchmark_seed distribution;
// - the scale set: one user each with 1,000, 10,000, 50,000 and 100,000
//   scrobbles over two years, and a viewer following all four.
//
// Measurements. Rows read are the DO SQL cursor's `rowsRead`, captured by a
// tracing Db (the frozen Db interface over the same `storage.sql`) handed to
// the production read modules. Wall time is `performance.now()` around the
// synchronous module call inside the DO (no I/O happens inside it, so it is
// CPU-bound time); HTTP latency is measured around production Worker requests
// (createWorker → JS RPC → IndexDO). The report goes to the BENCH_SINK service
// binding (Node side, worker/vitest.bench.config.ts), which validates it and
// writes work/bench/read-models.json; scripts/benchmark-read-models.ts renders
// docs/benchmarks/*.md from it.
//
// Budgets (asserted):
// - history/feed: the W6-02 budget as the plan states it: the production page
//   statement's cursor `rowsRead` is at most limit + 2, for history, the
//   global feed and the following feed, at every scale and depth. The index
//   walk without the visibility join is measured beside it only to explain
//   where the rows go; it is not a budget. Reads over limit + 2 fail this
//   suite and are reported as budget breaches (no reinterpretation of the
//   budget here; changing it is an owner amendment of workers-waves.json).
// - statistics: uncached rows read ≤ 17 × window rows + 4 × limit + 16, i.e.
//   proportional to the window, never to the user's total rows.
// - a cached statistics hit: the plan's "≤ 3 index probes", counted over
//   every statement the hit runs, each planned as an indexed SEARCH. That
//   includes the users-row lookup, which supplies stats_version and
//   generation, the cache-validity inputs of ADR §5.8 (and the 404 check), so
//   a windowed hit (users row + cache row + 2 EXISTS = 4) is reported as a
//   breach; excluding that lookup would be a reinterpretation of the budget,
//   which is the owner's call, as for history/feed. The hit must equal a
//   fresh uncached computation.
// - HTTP: 300 warmup + 600 measured requests, zero errors, nearest-rank p95
//   below 300 ms.
// 100k-scrobble all-time statistics above 50 ms are recorded as a follow-up,
// not a failure.

import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { decode } from '@atcute/cbor';
import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import { MemoryBlockCache } from '@atmusic/atproto/snapshot/block-source';
import { prefixRange } from '@atmusic/atproto/snapshot/range';
import { initialState, step } from '@atmusic/atproto/snapshot/walker';
import { fixtureKeys, type TestKey } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import type { Transport } from '@atmusic/atproto/transport';
import { verifyCommit } from '@atmusic/atproto/verify/commit';
import type { Statistics, StatsWindow } from '@atmusic/core/api-types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, inject, it } from 'vitest';
import { parseConfig } from '../../src/config';
import type { FeedQuery, HistoryQuery, KeysetQuery, ModuleDeps, TimeKey } from '../../src/do/contracts';
import { checkParams, type Db, doDb, type SqlParam } from '../../src/do/db';
import { feed } from '../../src/do/read/feed';
import { history, keysetWhere } from '../../src/do/read/history';
import { computeStatistics, statsWithCache } from '../../src/do/read/stats';
import { applySnapshotChunk, completeSnapshot } from '../../src/do/write/apply-snapshot';
import type { TestIndexDO } from '../composition/entry';
import { compositionEnv, type Harness, harness, schema } from '../composition/support';
import { FOLLOW, NOW_MS, NOW_NS, PREFIX, SCROBBLE, seedSnapshotJob, seedUser } from '../write/support';

// ---------------------------------------------------------------------------
// Node-side inputs (worker/vitest.bench.config.ts)

interface BenchProvided {
  schema: Record<string, unknown>;
  intervalMs: number;
  host: {
    node: string;
    platform: string;
    arch: string;
    osRelease: string;
    cpuModel: string;
    logicalCpus: number;
    totalMemoryBytes: number;
    cgroupCpuMax: string | null;
    cgroupMemoryMax: string | null;
    workerd: string;
    wrangler: string;
    vitestPlugin: string;
  };
}

declare module 'vitest' {
  interface ProvidedContext {
    bench: BenchProvided;
  }
}

const sinkEnv = env as unknown as { BENCH_SINK: Fetcher };

// ---------------------------------------------------------------------------
// Constants

type Stub = DurableObjectStub<TestIndexDO>;

const LIMIT = 20;
/** W6-02: "history and feed at most limit+2 rows read" (the page statement's cursor rowsRead). */
const READ_BUDGET = LIMIT + 2;
const STATS_LIMIT = 10;
/** W6-02: "cached stats hit ≤ 3 index probes" (every statement of the hit). */
const PROBE_BUDGET = 3;
const WINDOWS: StatsWindow[] = ['all', '7d', '30d', '365d'];
const WINDOW_DAYS: Record<StatsWindow, number | null> = { all: null, '7d': 7, '30d': 30, '365d': 365 };
const MAX_CHUNK_ENTRIES = 2_000;
const MAX_FETCHES = 200;
const DATASET_SEED = 7;
const DATASET_USERS = 100;
const ROWS_PER_USER = 1_000;
const SCALES = [1_000, 10_000, 50_000, 100_000] as const;
const WARM_REPEATS = 20;
const STATS_WARM_REPEATS = 3;
const WARMUP_REQUESTS = 300;
const MEASURED_REQUESTS = 600;
const P95_RANK = Math.ceil(0.95 * MEASURED_REQUESTS); // 570: index 569 of the sorted 600
const TARGET_P95_MS = 300;
const STATS_FOLLOW_UP_MS = 50;
/** Hit request offset: every listen is at a half second, so a 250 ms shift of either bound crosses no row. */
const HIT_SHIFT_NS = 250_000_000n;
const NOW_ISO = '2026-01-15T12:00:00Z';

/**
 * Uncached statistics budget. Totals: the window is read once through
 * scrobbles_owner_time (index entry + table row: 2 per row) into a temporary
 * table that three aggregates read (3 per row). Each of the three ranking
 * statements reads the window (2 per row), sorts it into its GROUP BY b-tree
 * (≤ 2 per row) and fetches ≤ limit display rows. Plus the user row, the
 * cache row and the cache write: 5W + 3 × (4W + limit) + small ≤ 17W + 4·limit + 16.
 */
const statsBudget = (windowRows: number) => 17 * windowRows + 4 * STATS_LIMIT + 16;

// ---------------------------------------------------------------------------
// Deterministic generators

interface GenRecord {
  rkey: string;
  record: Record<string, unknown>;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

function datasetDid(a: number): string {
  return `did:web:benchmark-${pad(a, 3)}.test`;
}

/**
 * The M6.2.3 dataset (crates/server/tests/common/bulk_repo.rs seed_benchmark):
 * user a, record n: artist n % 100, track n % 500, album n % 50, listened
 * n × 60 + a seconds before the frozen clock; plus a duration of 120–419 s
 * drawn from the seeded generator in (a, n) order.
 */
function generateDataset(seed: number): GenRecord[][] {
  const rnd = seededRandom(seed);
  return Array.from({ length: DATASET_USERS }, (_, a) =>
    Array.from({ length: ROWS_PER_USER }, (_, n) => ({
      rkey: `r${pad(n, 4)}`,
      record: {
        $type: SCROBBLE,
        artist: `Artist ${pad(n % 100, 3)}`,
        track: `Track ${pad(n % 500, 4)}`,
        album: `Album ${pad(n % 50, 3)}`,
        listenedAt: isoSeconds(NOW_MS - (n * 60 + a) * 1000),
        createdAt: NOW_ISO,
        durationSeconds: 120 + Math.floor(rnd.float() * 300),
      },
    })),
  );
}

/**
 * A scale user: `n` listens evenly over 730 days, each at a half second
 * (see HIT_SHIFT_NS), skewed over 400 artists, 25 track names, every 7th
 * listen without an album.
 */
function generateScale(n: number, seed: number): GenRecord[] {
  const rnd = seededRandom(seed);
  const spacingMs = Math.floor((730 * 86_400) / n) * 1000;
  return Array.from({ length: n }, (_, j) => {
    const at = new Date(NOW_MS - 500 - j * spacingMs).toISOString();
    const record: Record<string, unknown> = {
      $type: SCROBBLE,
      artist: `Artist ${Math.floor(rnd.float() ** 2 * 400)}`,
      track: `Track ${Math.floor(rnd.float() * 25)}`,
      listenedAt: at,
      createdAt: at,
    };
    if (j % 7 !== 0) record.album = `Album ${Math.floor(rnd.float() * 8)}`;
    return { rkey: `s${pad(j, 6)}`, record };
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Seeding through the production verify + apply path

interface SeedResult {
  chunks: number;
  written: number;
  maxChunk: number;
}

async function seedRepo(
  stub: Stub,
  did: string,
  key: TestKey,
  records: ReadonlyArray<{ collection: string; rkey: string; record: unknown }>,
): Promise<SeedResult> {
  const repo = new SignedRepo(did, key, { clock: fixedClock() });
  await repo.writes(records.map((r) => ({ action: 'put' as const, ...r })));
  const head = repo.head;
  if (head === null) throw new Error('no commit');
  // The signature, DID, version and rev are checked against the key's did:key.
  const verified = await verifyCommit(new Map([[head.cid, head.bytes]]), head.cid, { did, signingKey: key.didKey });
  const range = prefixRange(PREFIX);
  const cache = new MemoryBlockCache();
  const source = { get: async (cids: string[]) => (await repo.getBlocks(cids)).blocks };
  const generation = await runInDurableObject(stub, (_i, state) => {
    const db = doDb(state.storage);
    const g = seedUser(db, did, { active: false });
    seedSnapshotJob(db, did, g);
    return g;
  });
  let walk = initialState(verified, range);
  const out: SeedResult = { chunks: 0, written: 0, maxChunk: 0 };
  for (;;) {
    const r = await step(walk, source, cache, {
      maxFetches: MAX_FETCHES,
      maxEntries: MAX_CHUNK_ENTRIES,
      knownCid: () => null,
    });
    walk = r.state;
    const interval = r.interval;
    if (interval !== null) {
      const entries = r.entries.map((e) => {
        if (e.recordBytes === undefined) throw new Error(`walker returned ${e.key} without its record`);
        return { key: e.key, cid: e.cid, record: decode(e.recordBytes) };
      });
      const res = await runInDurableObject(stub, (_i, state) => {
        const db = doDb(state.storage);
        return db.tx(() =>
          applySnapshotChunk(db, {
            did,
            generation,
            headRev: verified.rev,
            intervalLo: interval[0],
            intervalHi: interval[1] ?? range[1],
            entries,
            receiptNs: NOW_NS,
            prefix: PREFIX,
            nowNs: NOW_NS,
          }),
        );
      });
      if (res.outcome !== 'applied' || res.deleted !== 0) throw new Error(`chunk ${JSON.stringify(res)}`);
      out.chunks++;
      out.written += res.written;
      out.maxChunk = Math.max(out.maxChunk, entries.length);
    }
    if (r.done) break;
  }
  const done = await runInDurableObject(stub, (_i, state) => {
    const db = doDb(state.storage);
    return db.tx(() =>
      completeSnapshot(db, { did, generation, headRev: verified.rev, accountActive: true, nowNs: NOW_NS }),
    );
  });
  if (done.outcome !== 'complete' || !done.active) throw new Error(`completion ${JSON.stringify(done)}`);
  return out;
}

const scrobbleOps = (records: GenRecord[]) => records.map((r) => ({ collection: SCROBBLE, ...r }));

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    p ??= fn();
    return p;
  };
}

const datasetDo = once(async () => {
  const keys = await fixtureKeys();
  const h = harness('bench-dataset');
  const users = generateDataset(DATASET_SEED);
  const t0 = performance.now();
  const seeds: SeedResult[] = [];
  for (const [a, records] of users.entries()) {
    seeds.push(await seedRepo(h.stub, datasetDid(a), keys.alice, scrobbleOps(records)));
  }
  return { h, users, seeds, seedMs: performance.now() - t0 };
});

const SCALE_DIDS: Record<(typeof SCALES)[number], string> = {
  1000: 'did:web:scale-1k.test',
  10000: 'did:web:scale-10k.test',
  50000: 'did:web:scale-50k.test',
  100000: 'did:web:scale-100k.test',
};
const VIEWER = 'did:web:viewer.test';

const scaleDo = once(async () => {
  const keys = await fixtureKeys();
  const h = harness('bench-scale');
  const scaleKeys: TestKey[] = [keys.alice, keys.bob, keys.carol, keys.aliceRotated];
  const scales = [];
  for (const [i, n] of SCALES.entries()) {
    const key = scaleKeys[i]!;
    const t0 = performance.now();
    const seed = await seedRepo(h.stub, SCALE_DIDS[n], key, scrobbleOps(generateScale(n, DATASET_SEED + i + 1)));
    scales.push({ scrobbles: n, did: SCALE_DIDS[n], curve: key.curve, ...seed, seedMs: performance.now() - t0 });
  }
  const follows = SCALES.map((n, i) => ({
    collection: FOLLOW,
    rkey: `f${i}`,
    record: { $type: FOLLOW, subject: SCALE_DIDS[n], createdAt: '2025-01-01T00:00:00Z' },
  }));
  await seedRepo(h.stub, VIEWER, keys.bob, follows);
  return { h, scales };
});

// ---------------------------------------------------------------------------
// Rows read: a tracing Db over the same DO SQL storage

interface Trace {
  sql: string;
  params: SqlParam[];
  rowsRead: number;
}

function tracingDb(storage: DurableObjectStorage, trace: Trace[]): Db {
  const sql = storage.sql;
  const base = doDb(storage);
  const exec = (query: string, params: SqlParam[]) => {
    checkParams(params);
    const cursor = sql.exec(query, ...params);
    const rows = cursor.toArray();
    trace.push({ sql: query, params, rowsRead: cursor.rowsRead });
    return { cursor, rows };
  };
  return {
    all: <T>(query: string, ...p: SqlParam[]) => exec(query, p).rows as T[],
    one: <T>(query: string, ...p: SqlParam[]) => (exec(query, p).rows[0] as T | undefined) ?? null,
    run: (query: string, ...p: SqlParam[]) => ({ rowsWritten: exec(query, p).cursor.rowsWritten }),
    tx: base.tx,
  };
}

function rowsReadOf(storage: DurableObjectStorage, query: string, params: SqlParam[]): number {
  const cursor = storage.sql.exec(query, ...params);
  cursor.toArray();
  return cursor.rowsRead;
}

const refuse: Transport = async (req) => {
  throw new TypeError(`benchmark: no network for ${new URL(req.url).host}`);
};
const noIdentity: IdentityResolver = {
  resolveDid: async () => {
    throw new TypeError('benchmark: no identity resolution');
  },
  resolveHandle: async () => {
    throw new TypeError('benchmark: no identity resolution');
  },
};

function moduleDeps(db: Db): ModuleDeps {
  return {
    db,
    clock: fixedClock(),
    random: seededRandom(1),
    transport: refuse,
    identity: noIdentity,
    config: parseConfig(compositionEnv, { allowFixturePrefix: true }),
    log: { log() {} },
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** `fn` run `n` times; the mean wall time in ms. */
function meanMs(n: number, fn: () => unknown): number {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
}

// ---------------------------------------------------------------------------
// History and feed measurements

interface ReadMeasurement {
  name: string;
  kind: 'history' | 'global' | 'following';
  scale: number | null;
  page: 'first' | 'deep';
  depth: number;
  rowsReturned: number;
  rowsRead: number;
  /** Diagnostic: rows read by the same keyset walk without the visibility join (summed per followed account). */
  indexRowsRead: number;
  /** Diagnostic: rowsRead - indexRowsRead (clamped at 0). */
  visibilityRowsRead: number;
  /** The plan's W6-02 budget: limit + 2 rows read by the page statement. */
  budget: number;
  statements: number;
  allStatementsRowsRead: number;
  coldMs: number;
  warmMs: number;
  withinBudget: boolean;
}

interface ReadSpec {
  name: string;
  kind: ReadMeasurement['kind'];
  scale: number | null;
  /** Owners whose rows the read covers (history: one; global: null = all; following: the followed). */
  owners: string[] | null;
  depth: number | null;
}

const ORDER = 'ORDER BY listened_at DESC, uri DESC';

function ownersWhere(owners: string[] | null): { sql: string; params: SqlParam[] } {
  if (owners === null) return { sql: '1 = 1', params: [] };
  return { sql: `did IN (${owners.map(() => '?').join(', ')})`, params: owners };
}

async function measureRead(stub: Stub, spec: ReadSpec): Promise<ReadMeasurement> {
  await evictDurableObject(stub);
  return runInDurableObject(stub, (_i, state) => {
    const plain = doDb(state.storage);
    const ow = ownersWhere(spec.owners);
    const keyAt = (offset: number) => {
      const key = plain.one<TimeKey>(
        `SELECT listened_at AS t, uri FROM scrobbles WHERE ${ow.sql} ${ORDER} LIMIT 1 OFFSET ?`,
        ...ow.params,
        offset,
      );
      if (key === null) throw new Error(`${spec.name}: no row at offset ${offset}`);
      return key;
    };
    // A cursor as the HTTP layer builds it: anchor = newest row, last = the row at `depth`.
    const keyset: KeysetQuery =
      spec.depth === null ? { limit: LIMIT } : { upper: keyAt(0), last: keyAt(spec.depth), limit: LIMIT };
    const trace: Trace[] = [];
    const m = moduleDeps(tracingDb(state.storage, trace));
    const run =
      spec.kind === 'history'
        ? () => history(m, { did: spec.owners![0]!, ...keyset } satisfies HistoryQuery)
        : spec.kind === 'global'
          ? () => feed(m, { scope: 'global', ...keyset } satisfies FeedQuery)
          : () => feed(m, { scope: 'following', viewer: VIEWER, ...keyset } satisfies FeedQuery);

    const t0 = performance.now();
    const result = run();
    const coldMs = performance.now() - t0;
    const pageStatement = trace[0]!;
    if (!pageStatement.sql.trimStart().startsWith('SELECT s.* FROM scrobbles s')) {
      throw new Error(`${spec.name}: unexpected first statement ${pageStatement.sql}`);
    }
    const statements = trace.length;
    const allStatementsRowsRead = trace.reduce((a, t) => a + t.rowsRead, 0);

    // The page is exactly the next LIMIT rows of an independent OFFSET query.
    const offset = spec.depth === null ? 0 : spec.depth + 1;
    const expected = plain
      .all<{ uri: string }>(
        `SELECT uri FROM scrobbles WHERE ${ow.sql} ${ORDER} LIMIT ? OFFSET ?`,
        ...ow.params,
        LIMIT,
        offset,
      )
      .map((r) => r.uri);
    expect(
      result.rows.map((r) => r.uri),
      spec.name,
    ).toEqual(expected);
    expect(result.hasMore, spec.name).toBe(true);

    // Diagnostic only: the same keyset walk without the visibility join, to
    // show how the page statement's rows split between the index walk and
    // the visibility lookups. The budget below applies to the page statement.
    const k = keysetWhere(keyset, 'listened_at', 'uri');
    const walk = (where: string, params: SqlParam[]) =>
      rowsReadOf(state.storage, `SELECT uri FROM scrobbles WHERE ${where}${k.sql} ${ORDER} LIMIT ?`, [
        ...params,
        ...k.params,
        LIMIT + 1,
      ]);
    const indexRowsRead =
      spec.owners === null ? walk('1 = 1', []) : spec.owners.reduce((sum, did) => sum + walk('did = ?', [did]), 0);

    const warmMs = meanMs(WARM_REPEATS, run);
    const rowsRead = pageStatement.rowsRead;
    return {
      name: spec.name,
      kind: spec.kind,
      scale: spec.scale,
      page: spec.depth === null ? 'first' : 'deep',
      depth: spec.depth ?? 0,
      rowsReturned: result.rows.length,
      rowsRead,
      indexRowsRead,
      // Clamped: the following feed's single IN walk can read one boundary row
      // fewer than the per-account control walks together.
      visibilityRowsRead: Math.max(0, rowsRead - indexRowsRead),
      budget: READ_BUDGET,
      statements,
      allStatementsRowsRead,
      coldMs,
      warmMs,
      withinBudget: rowsRead <= READ_BUDGET,
    };
  });
}

const readMeasurements = once(async () => {
  const { h } = await scaleDo();
  const total = SCALES.reduce((a, n) => a + n, 0);
  const followed = SCALES.map((n) => SCALE_DIDS[n]);
  const specs: ReadSpec[] = [];
  for (const n of SCALES) {
    for (const depth of [null, n / 2]) {
      specs.push({
        name: `history ${n} ${depth === null ? 'first' : 'deep'}`,
        kind: 'history',
        scale: n,
        owners: [SCALE_DIDS[n]],
        depth,
      });
    }
  }
  for (const depth of [null, total / 2]) {
    const page = depth === null ? 'first' : 'deep';
    specs.push({ name: `global ${page}`, kind: 'global', scale: null, owners: null, depth });
    specs.push({ name: `following ${page}`, kind: 'following', scale: null, owners: followed, depth });
  }
  const out: ReadMeasurement[] = [];
  for (const spec of specs) out.push(await measureRead(h.stub, spec));
  return out;
});

// ---------------------------------------------------------------------------
// Statistics measurements

interface StatsMeasurement {
  scale: number;
  window: StatsWindow;
  windowRows: number;
  uncached: { rowsRead: number; statements: number; coldMs: number; warmMs: number; perStatement: number[] };
  cached: {
    rowsRead: number;
    /** Every statement of the hit; each is an index probe counted against the budget. */
    probes: number;
    probeKinds: string[];
    probesIndexed: boolean;
    probeBudget: number;
    withinProbeBudget: boolean;
    ms: number;
  };
  rowsReadBudget: number;
  equalsUncached: true;
  withinBudget: boolean;
}

function lowerBound(window: StatsWindow): string | null {
  const days = WINDOW_DAYS[window];
  return days === null ? null : toStorage(fromMs(NOW_MS - days * 86_400_000));
}

async function measureStats(stub: Stub, scale: number, did: string, window: StatsWindow): Promise<StatsMeasurement> {
  await evictDurableObject(stub);
  return runInDurableObject(stub, (_i, state) => {
    const plain = doDb(state.storage);
    const lower = lowerBound(window);
    const windowRows = plain.one<{ n: number }>(
      `SELECT count(*) AS n FROM scrobbles WHERE did = ? AND listened_at <= ?${lower === null ? '' : ' AND listened_at >= ?'}`,
      ...(lower === null ? [did, toStorage(NOW_NS)] : [did, toStorage(NOW_NS), lower]),
    )!.n;

    const trace: Trace[] = [];
    const db = tracingDb(state.storage, trace);
    const q = { did, window, limit: STATS_LIMIT, asOfNs: NOW_NS };
    const t0 = performance.now();
    const miss = statsWithCache(db, q);
    const coldMs = performance.now() - t0;
    expect(miss.cache, `${scale} ${window}`).toBe('miss');
    expect(miss.statistics?.totalScrobbles).toBe(windowRows);
    const perStatement = trace.map((t) => t.rowsRead);
    const uncachedRows = perStatement.reduce((a, b) => a + b, 0);
    const uncachedStatements = trace.length;
    const warmMs = meanMs(STATS_WARM_REPEATS, () => computeStatistics(plain, did, window, STATS_LIMIT, NOW_NS));

    // A request 250 ms later: both bounds move across no row, so the body is reused.
    trace.length = 0;
    const later = { ...q, asOfNs: NOW_NS + HIT_SHIFT_NS };
    const hit = statsWithCache(db, later);
    expect(hit.cache, `${scale} ${window}`).toBe('hit');
    const probes = [...trace];
    // Every statement of the hit is counted: the users row (stats_version and
    // generation, the cache-validity inputs, and the 404 check), the cache row
    // by primary key, then the EXISTS probes on scrobbles_owner_time.
    const probeKinds = probes.map((p) =>
      /FROM users u/.test(p.sql)
        ? 'users'
        : /FROM stats_cache/.test(p.sql)
          ? 'cache'
          : /EXISTS/.test(p.sql)
            ? 'exists'
            : 'other',
    );
    const probesIndexed = probes.every((p) => {
      const plan = plain.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${p.sql}`, ...p.params).map((r) => r.detail);
      // `SELECT EXISTS (…)` itself plans as SCAN CONSTANT ROW; no table may be scanned.
      return plan.some((d) => d.startsWith('SEARCH ')) && !plan.some((d) => /^SCAN (?!CONSTANT ROW$)/.test(d));
    });
    const fresh: Statistics = computeStatistics(plain, did, window, STATS_LIMIT, later.asOfNs);
    expect(hit.statistics).toEqual(fresh);
    expect({ ...miss.statistics, asOf: fresh.asOf }).toEqual(fresh);
    const cachedMs = meanMs(WARM_REPEATS, () => statsWithCache(plain, later));

    const rowsReadBudget = statsBudget(windowRows);
    return {
      scale,
      window,
      windowRows,
      uncached: { rowsRead: uncachedRows, statements: uncachedStatements, coldMs, warmMs, perStatement },
      cached: {
        rowsRead: probes.reduce((a, t) => a + t.rowsRead, 0),
        probes: probes.length,
        probeKinds,
        probesIndexed,
        probeBudget: PROBE_BUDGET,
        withinProbeBudget: probes.length <= PROBE_BUDGET && probesIndexed,
        ms: cachedMs,
      },
      rowsReadBudget,
      equalsUncached: true,
      withinBudget: uncachedRows <= rowsReadBudget && probes.length <= PROBE_BUDGET && probesIndexed,
    };
  });
}

const statsMeasurements = once(async () => {
  const { h } = await scaleDo();
  const out: StatsMeasurement[] = [];
  for (const n of SCALES) {
    for (const w of WINDOWS) out.push(await measureStats(h.stub, n, SCALE_DIDS[n], w));
  }
  return out;
});

// ---------------------------------------------------------------------------
// HTTP latency on the M6.2.3 dataset

interface HttpSummary {
  endpoints: string[];
  warmupRequests: number;
  measuredRequests: number;
  warmupErrors: number;
  errors: number;
  paced: boolean;
  intervalMs: number;
  elapsedMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p95Rank: number;
  p99Ms: number;
  maxMs: number;
  targetMs: number;
  passed: boolean;
}

const nearestRank = (sorted: number[], p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;

async function oneRequest(h: Harness, i: number): Promise<{ ms: number; ok: boolean; status: string }> {
  const did = datasetDid(Math.floor(i / 2) % DATASET_USERS);
  const path =
    i % 2 === 0 ? `/api/v1/users/${did}/scrobbles?limit=${LIMIT}` : `/api/v1/feed?scope=global&limit=${LIMIT}`;
  const t0 = performance.now();
  try {
    const r = await h.request(path);
    const ms = performance.now() - t0;
    const body = r.body as { items?: Array<{ did?: string }>; nextCursor?: unknown } | null;
    const ok =
      r.status === 200 &&
      body !== null &&
      Array.isArray(body.items) &&
      body.items.length === LIMIT &&
      typeof body.nextCursor === 'string' &&
      (i % 2 === 1 || body.items.every((item) => item.did === did)) &&
      schema('ScrobblePage', r.body) === 'valid';
    return { ms, ok, status: String(r.status) };
  } catch (error) {
    return { ms: performance.now() - t0, ok: false, status: `throw:${(error as Error).name}` };
  }
}

const httpMeasurements = once(async () => {
  const { h } = await datasetDo();
  const intervalMs = inject('bench').intervalMs;
  const statuses: Record<string, number> = {};
  const latencies: number[] = [];
  let warmupErrors = 0;
  let errors = 0;
  const start = performance.now();
  let measuredStart = start;
  for (let i = 0; i < WARMUP_REQUESTS + MEASURED_REQUESTS; i++) {
    if (intervalMs > 0) {
      const wait = start + i * intervalMs - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (i === WARMUP_REQUESTS) measuredStart = performance.now();
    const r = await oneRequest(h, i);
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    if (i < WARMUP_REQUESTS) {
      if (!r.ok) warmupErrors++;
      continue;
    }
    latencies.push(r.ms);
    if (!r.ok) errors++;
  }
  const elapsedMs = performance.now() - measuredStart;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95Ms = nearestRank(sorted, 0.95);
  const summary: HttpSummary = {
    endpoints: [`/api/v1/users/{did}/scrobbles?limit=${LIMIT}`, `/api/v1/feed?scope=global&limit=${LIMIT}`],
    warmupRequests: WARMUP_REQUESTS,
    measuredRequests: latencies.length,
    warmupErrors,
    errors,
    paced: intervalMs > 0,
    intervalMs,
    elapsedMs,
    meanMs: mean(latencies),
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms,
    p95Rank: P95_RANK,
    p99Ms: nearestRank(sorted, 0.99),
    maxMs: sorted.at(-1)!,
    targetMs: TARGET_P95_MS,
    passed: latencies.length === MEASURED_REQUESTS && errors === 0 && warmupErrors === 0 && p95Ms < TARGET_P95_MS,
  };
  return { summary, latencies, statuses };
});

// ---------------------------------------------------------------------------
// Dataset facts (asserted by the dataset test, reported in the JSON)

interface PerUser {
  did: string;
  n: number;
  artists: number;
  tracks: number;
  albums: number;
  newest: string;
  oldest: string;
}

function rowLine(uri: string, artist: string, track: string, album: string | null, at: string, d: number | null) {
  return [uri, artist, track, album ?? '', at, d ?? ''].join('\t');
}

const datasetFacts = once(async () => {
  const { h, users } = await datasetDo();
  const generatorLines = users
    .flatMap((records, a) =>
      records.map((r) => {
        const x = r.record as {
          artist: string;
          track: string;
          album: string;
          listenedAt: string;
          durationSeconds: number;
        };
        return rowLine(
          `at://${datasetDid(a)}/${SCROBBLE}/${r.rkey}`,
          x.artist,
          x.track,
          x.album,
          toStorage(fromMs(Date.parse(x.listenedAt))),
          x.durationSeconds,
        );
      }),
    )
    .sort();
  const facts = await runInDurableObject(h.stub, (_i, state) => {
    const db = doDb(state.storage);
    const count = (sql: string) => db.one<{ n: number }>(sql)!.n;
    const dbLines = db
      .all<{ uri: string; artist: string; track: string; album: string | null; listened_at: string; d: number | null }>(
        'SELECT uri, artist, track, album, listened_at, duration_seconds AS d FROM scrobbles ORDER BY uri',
      )
      .map((r) => rowLine(r.uri, r.artist, r.track, r.album, r.listened_at, r.d));
    return {
      rows: count('SELECT count(*) AS n FROM scrobbles'),
      users: count('SELECT count(*) AS n FROM users'),
      activeUsers: count(
        "SELECT count(*) AS n FROM users WHERE active = 1 AND account_status = 'active' AND indexing_state = 'current'",
      ),
      presentStates: count("SELECT count(*) AS n FROM record_state WHERE state = 'present'"),
      excluded:
        count("SELECT count(*) AS n FROM record_state WHERE state != 'present'") +
        count("SELECT coalesce(sum(value), 0) AS n FROM counters WHERE name = 'excluded'"),
      perUser: db.all<PerUser>(
        `SELECT did, count(*) AS n, count(DISTINCT artist_key) AS artists,
           (SELECT count(*) FROM (SELECT 1 FROM scrobbles t WHERE t.did = s.did GROUP BY artist_key, track_key)) AS tracks,
           count(DISTINCT album_key) AS albums, max(listened_at) AS newest, min(listened_at) AS oldest
         FROM scrobbles s GROUP BY did ORDER BY did`,
      ),
      offArtist: count(
        'SELECT count(*) AS n FROM (SELECT count(*) AS c FROM scrobbles GROUP BY did, artist_key) WHERE c != 10',
      ),
      offTrack: count(
        'SELECT count(*) AS n FROM (SELECT count(*) AS c FROM scrobbles GROUP BY did, artist_key, track_key) WHERE c != 2',
      ),
      offAlbum: count(
        'SELECT count(*) AS n FROM (SELECT count(*) AS c FROM scrobbles GROUP BY did, album_key) WHERE c != 20',
      ),
      duration: db.one<{ min: number; max: number }>(
        'SELECT min(duration_seconds) AS min, max(duration_seconds) AS max FROM scrobbles',
      )!,
      dbText: dbLines.join('\n'),
    };
  });
  const { dbText, ...rest } = facts;
  return {
    ...rest,
    dbDigest: await sha256Hex(dbText),
    generatorDigest: await sha256Hex(generatorLines.join('\n')),
  };
});

// ---------------------------------------------------------------------------
// The report

function buildFollowUps(stats: StatsMeasurement[]) {
  const followUps: Array<{ id: string; summary: string; measured: number; threshold: number }> = [];
  // The plan names 100k all-time; every uncached statistics call over 50 ms is recorded the same way.
  for (const s of stats) {
    const slowest = Math.max(s.uncached.coldMs, s.uncached.warmMs);
    if (slowest <= STATS_FOLLOW_UP_MS) continue;
    followUps.push({
      id: `stats-${s.scale}-${s.window}-over-50ms`,
      summary: `Uncached ${s.window} statistics of the ${s.scale.toLocaleString('en-US')}-scrobble user (${s.windowRows.toLocaleString('en-US')} window rows) took ${slowest.toFixed(1)} ms in workerd (cold ${s.uncached.coldMs.toFixed(1)} ms, warm ${s.uncached.warmMs.toFixed(1)} ms; a cached hit ${s.cached.ms.toFixed(2)} ms). Read-time aggregation is linear in the window rows; pre-aggregated per-user counters would bound it if such users appear.`,
      measured: slowest,
      threshold: STATS_FOLLOW_UP_MS,
    });
  }
  return followUps;
}

const report = once(async () => {
  const bench = inject('bench');
  const facts = await datasetFacts();
  const data = await datasetDo();
  const scale = await scaleDo();
  const reads = await readMeasurements();
  const stats = await statsMeasurements();
  const http = await httpMeasurements();
  return {
    schema: 'atmusic/read-models-benchmark@1',
    generatedBy: 'worker/test/bench/read-models.bench.test.ts',
    frozenClock: NOW_ISO,
    environment: {
      runner: 'local workerd via @cloudflare/vitest-plugin (miniflare); not a Cloudflare edge isolate',
      ...bench.host,
      timerIntegerMs: http.latencies.every((x) => Number.isInteger(x)),
    },
    limit: LIMIT,
    dataset: {
      seed: DATASET_SEED,
      users: facts.users,
      rowsPerUser: ROWS_PER_USER,
      rows: facts.rows,
      activeUsers: facts.activeUsers,
      verifiedCommits: data.seeds.length,
      chunks: data.seeds.reduce((a, s) => a + s.chunks, 0),
      maxChunkEntries: Math.max(...data.seeds.map((s) => s.maxChunk)),
      excluded: facts.excluded,
      digest: facts.dbDigest,
      distribution: {
        artistsPerUser: 100,
        rowsPerArtist: 10,
        tracksPerUser: 500,
        rowsPerTrack: 2,
        albumsPerUser: 50,
        rowsPerAlbum: 20,
        spacingSeconds: 60,
        durationSeconds: facts.duration,
      },
      seedMs: data.seedMs,
    },
    scales: scale.scales.map((s) => ({
      scrobbles: s.scrobbles,
      did: s.did,
      curve: s.curve,
      chunks: s.chunks,
      written: s.written,
      seedMs: s.seedMs,
    })),
    reads,
    stats,
    http: http.summary,
    followUps: buildFollowUps(stats),
    passed: reads.every((r) => r.withinBudget) && stats.every((s) => s.withinBudget) && http.summary.passed,
  };
});

// ---------------------------------------------------------------------------
// Named tests

describe('read-model benchmark', () => {
  it('seeded generator yields exactly 100,000 valid active rows with the documented per-user distribution', async () => {
    const { seeds, users } = await datasetDo();
    const facts = await datasetFacts();

    // The generator is a pure function of its seed.
    expect(JSON.stringify(generateDataset(DATASET_SEED))).toBe(JSON.stringify(users));
    expect(JSON.stringify(generateDataset(DATASET_SEED + 1))).not.toBe(JSON.stringify(users));
    expect(users.flat()).toHaveLength(100_000);

    // Every repository was a verified signed commit, applied in ≤ 2,000-entry chunks with no exclusion.
    expect(seeds).toHaveLength(DATASET_USERS);
    expect(seeds.every((s) => s.written === ROWS_PER_USER && s.chunks >= 1)).toBe(true);
    expect(Math.max(...seeds.map((s) => s.maxChunk))).toBeLessThanOrEqual(MAX_CHUNK_ENTRIES);

    // DO state: exactly 100,000 present rows of 100 visible, current users.
    expect(facts.rows).toBe(100_000);
    expect(facts.presentStates).toBe(100_000);
    expect(facts.excluded).toBe(0);
    expect(facts.users).toBe(DATASET_USERS);
    expect(facts.activeUsers).toBe(DATASET_USERS);
    expect(facts.perUser).toHaveLength(DATASET_USERS);
    facts.perUser.forEach((u, a) => {
      expect(u).toEqual({
        did: datasetDid(a),
        n: 1000,
        artists: 100,
        tracks: 500,
        albums: 50,
        newest: toStorage(fromMs(NOW_MS - a * 1000)),
        oldest: toStorage(fromMs(NOW_MS - (999 * 60 + a) * 1000)),
      });
    });
    // Each user: every artist exactly 10 rows, every (artist, track) 2, every album name 20.
    expect([facts.offArtist, facts.offTrack, facts.offAlbum]).toEqual([0, 0, 0]);
    expect(facts.duration.min).toBeGreaterThanOrEqual(120);
    expect(facts.duration.max).toBeLessThanOrEqual(419);
    // The stored rows are exactly the generated records.
    expect(facts.dbDigest).toBe(facts.generatorDigest);
  });

  it('history/feed rows read ≤ limit+2', async () => {
    const reads = await readMeasurements();
    expect(reads.map((r) => r.name)).toEqual([
      'history 1000 first',
      'history 1000 deep',
      'history 10000 first',
      'history 10000 deep',
      'history 50000 first',
      'history 50000 deep',
      'history 100000 first',
      'history 100000 deep',
      'global first',
      'following first',
      'global deep',
      'following deep',
    ]);
    for (const r of reads) {
      expect(r.rowsReturned, r.name).toBe(LIMIT);
      expect(r.budget, r.name).toBe(LIMIT + 2);
      expect(r.withinBudget, r.name).toBe(r.rowsRead <= LIMIT + 2);
      // The plan's budget, on the production page statement's cursor rowsRead.
      // Soft, so every read over budget is listed, not only the first.
      expect.soft(r.rowsRead, `${r.name}: page statement rowsRead`).toBeLessThanOrEqual(LIMIT + 2);
    }
    // Rows read do not grow with the user's size or the cursor depth.
    const history = reads.filter((r) => r.kind === 'history').map((r) => r.rowsRead);
    expect(Math.max(...history) - Math.min(...history)).toBeLessThanOrEqual(1);
  });

  it('stats cache hit uses ≤3 probes and equals uncached result', async () => {
    const stats = await statsMeasurements();
    expect(stats).toHaveLength(SCALES.length * WINDOWS.length);
    for (const s of stats) {
      const name = `${s.scale} ${s.window}`;
      // equalsUncached is only set after toEqual against a fresh computation (measureStats).
      expect(s.equalsUncached, name).toBe(true);
      // What the hit runs: the users row, the cache row, then one EXISTS probe
      // (`all` has no lower bound) or two (a window).
      expect(s.cached.probeKinds, name).toEqual(
        s.window === 'all' ? ['users', 'cache', 'exists'] : ['users', 'cache', 'exists', 'exists'],
      );
      expect(s.cached.probes, name).toBe(s.cached.probeKinds.length);
      expect(s.cached.probesIndexed, name).toBe(true);
      // The whole hit reads O(1) rows, whatever the window holds.
      expect(s.cached.rowsRead, name).toBeLessThanOrEqual(s.cached.probes);
      // Uncached statistics are bounded by the window rows, not by the user's rows.
      expect(s.uncached.rowsRead, name).toBeLessThanOrEqual(s.rowsReadBudget);
      expect(s.cached.probeBudget, name).toBe(PROBE_BUDGET);
      expect(s.cached.withinProbeBudget, name).toBe(s.cached.probes <= PROBE_BUDGET && s.cached.probesIndexed);
      expect(s.withinBudget, name).toBe(s.cached.withinProbeBudget && s.uncached.rowsRead <= s.rowsReadBudget);
      // The plan's budget over every statement of the hit. Soft, so every
      // breach is listed, not only the first.
      expect.soft(s.cached.probes, `${name}: cache-hit index probes`).toBeLessThanOrEqual(PROBE_BUDGET);
    }
    // The windows are real ranges at every scale (all ⊋ 365d ⊋ 30d ⊋ 7d).
    for (const n of SCALES) {
      const rows = WINDOWS.map((w) => stats.find((s) => s.scale === n && s.window === w)!.windowRows);
      expect(rows[0]).toBe(n);
      expect(rows[0]! > rows[3]! && rows[3]! > rows[2]! && rows[2]! > rows[1]! && rows[1]! > 0).toBe(true);
    }
  });

  it('600 measured requests with zero errors report p95 and check it against the target', async () => {
    const { summary, latencies, statuses } = await httpMeasurements();
    expect(statuses).toEqual({ '200': WARMUP_REQUESTS + MEASURED_REQUESTS });
    expect(summary.warmupErrors).toBe(0);
    expect(summary.measuredRequests).toBe(MEASURED_REQUESTS);
    expect(latencies).toHaveLength(MEASURED_REQUESTS);
    expect(summary.errors).toBe(0);
    const sorted = [...latencies].sort((a, b) => a - b);
    expect(summary.p95Rank).toBe(570);
    expect(summary.p95Ms).toBe(sorted[569]);
    expect(summary.p95Ms).toBeLessThan(TARGET_P95_MS);
    expect(summary.passed).toBe(true);
  });

  it('benchmark JSON is produced and schema-valid', async () => {
    const bench = inject('bench');
    const value = await report();
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(bench.schema);
    expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
    // The schema is not vacuous: a negative count and a missing verdict are refused.
    expect(validate({ ...value, http: { ...value.http, errors: -1 } })).toBe(false);
    const { passed: _passed, ...withoutVerdict } = value;
    expect(validate(withoutVerdict)).toBe(false);
    // The verdict is the conjunction of every asserted budget (a breach is
    // reported as failed, never hidden), and every read carries the plan budget.
    expect(value.passed).toBe(
      value.reads.every((r) => r.withinBudget && r.rowsRead <= LIMIT + 2) &&
        value.stats.every((st) => st.withinBudget) &&
        value.http.passed,
    );
    expect(value.reads.every((r) => r.budget === LIMIT + 2 && r.withinBudget === r.rowsRead <= r.budget)).toBe(true);
    expect(value.dataset.rows).toBe(100_000);
    expect(value.reads).toHaveLength(12);
    expect(value.stats).toHaveLength(16);
    expect(value.http.measuredRequests).toBe(600);

    // The Node-side sink validates again, writes the file and answers with the SHA-256 of what it wrote.
    const body = JSON.stringify(value, null, 2);
    const res = await sinkEnv.BENCH_SINK.fetch('http://bench-sink/report', { method: 'POST', body });
    const answer = (await res.json()) as { path?: string; bytes?: number; sha256?: string; errors?: string[] };
    expect(res.status, JSON.stringify(answer.errors)).toBe(200);
    expect(answer.bytes).toBe(new TextEncoder().encode(body).length);
    expect(answer.sha256).toBe(await sha256Hex(body));
    expect(answer.path).toMatch(/\.json$/);
    // An invalid report is refused by the sink too.
    const bad = await sinkEnv.BENCH_SINK.fetch('http://bench-sink/report', {
      method: 'POST',
      body: JSON.stringify(withoutVerdict),
    });
    expect(bad.status).toBe(422);
  });
});
