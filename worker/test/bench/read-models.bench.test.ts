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
// Budgets (hard assertions; ADR 0004 §15 Q10, decided 2026-10-25, which
// replaced the plan's `limit + 2` and "≤ 3 probes"; AMENDMENTS-workers.md
// "Read-path budgets"):
// - history/feed, on the production PAGE STATEMENT's cursor `rowsRead` only,
//   at the default limit L, at every scale and depth: history ≤ L + 3,
//   global feed ≤ 2(L + 1) + 1, following feed ≤ 4(L + 1) + 1 + the viewer's
//   visible follow edges (dense data). The other statements of the call (the
//   indexing truth) are not budgeted; they are reported separately as
//   whole-call totals and asserted to read the same rows at every scale and
//   depth. The index walk without the visibility join is a diagnostic only.
// - statistics: every uncached statement is bounded by its window rows W and
//   group counts G, both taken from the generator (not from SQL): totals
//   ≤ 5W + 6, each ranking ≤ 2W + 2G + 2, plus the users row, the cache row
//   and the cache store (derivation at `statementBudgets`).
// - a cached statistics hit, over EVERY statement the hit runs (each planned
//   as an indexed SEARCH): ≤ 3 for `all`, ≤ 4 for a window (users row for
//   stats_version/generation, cache row, ≤ 2 EXISTS). The hit must equal a
//   fresh uncached computation, and after a stats_version bump the next
//   request must be a miss that again equals it.
// - HTTP: 300 warmup + 600 measured requests, zero errors, nearest-rank p95
//   below 300 ms.
// Measured and reported, never asserted (Q10 worst cases, docs/benchmarks
// follow-ups): a following feed whose few followees are sparse in a large
// global timeline, and a global timeline whose newest rows belong to an
// inactive owner. 100k-scrobble all-time statistics above 50 ms are recorded
// as a follow-up, not a failure.

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
import { bumpStatsVersion, markInactive } from '../../src/do/write/account-state';
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

// ADR 0004 §15 Q10 read-path budgets, on the page statement's cursor rowsRead at limit L = LIMIT.
/** Q10 history: L + 1 probe rows, the owner's users row, 1 keyset boundary row = L + 3. */
const Q10_HISTORY_BUDGET = LIMIT + 1 + 1 + 1;
/** Q10 global feed: L + 1 probe rows, one owner-visibility probe per candidate, + 1 = 2(L + 1) + 1. */
const Q10_GLOBAL_BUDGET = 2 * (LIMIT + 1) + 1;
/** Q10 following feed (dense data): 4(L + 1) + 1 plus the viewer's visible follow edges. */
const Q10_FOLLOWING_WALKS = 4;
const q10FollowingBudget = (visibleEdges: number) => Q10_FOLLOWING_WALKS * (LIMIT + 1) + 1 + visibleEdges;
/** Q10 cached stats hit, every statement: users row + cache row + ≤ 2 EXISTS (1 for `all`). */
const Q10_STATS_PROBES_ALL = 1 + 1 + 1;
const Q10_STATS_PROBES_WINDOWED = 1 + 1 + 2;
const q10ProbeBudget = (w: StatsWindow) => (w === 'all' ? Q10_STATS_PROBES_ALL : Q10_STATS_PROBES_WINDOWED);
const BUDGET_RULE = {
  history: 'L+3',
  global: '2(L+1)+1',
  following: '4(L+1)+1+edges',
} as const;

const STATS_LIMIT = 10;
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

/** Rows read by one visibility join (`visibleScrobblesFrom`): the owner's users row + the suppression probe. */
const VISIBILITY_ROWS = 2;
/** The cache store (worker/src/do/read/stats-cache.ts writeCache): its guard reads the users row; the upsert ≤ 1 row. */
const CACHE_STORE_ROWS = 2;

/**
 * Uncached statistics: the rows-read bound of each statement statsWithCache
 * runs on a miss, in order, from the window rows W and the group counts of
 * the window (artist, (artist, track), (artist, album) with an album), all
 * taken from the generator, never from SQL. Derivation (stats.ts
 * statsStatements, schema.ts indexes):
 * - users row by primary key: 1; cache row by primary key: ≤ 1.
 * - totals: a bounded window is read once through scrobbles_owner_time
 *   (index entry + table row: 2W) into a MATERIALIZED temporary table that
 *   the three aggregates read (3W), with one visibility join: 5W + 2. `all`
 *   inlines the window three times through the covering scrobbles_stats
 *   index (3W) with three visibility joins: 3W + 6. Both ≤ 5W + 6.
 * - each ranking statement: the window through scrobbles_owner_time (index
 *   entry + table row: ≤ 2W), one display row per group by primary key
 *   (≤ 2 per group: ≤ 2G) and one visibility join: ≤ 2W + 2G + 2.
 * - the cache store: ≤ 2.
 * Each term is linear in the window, so the whole miss never reads the
 * user's rows outside the window.
 */
function statementBudgets(f: GeneratorWindow): number[] {
  const w = f.windowRows;
  const ranking = (groups: number) => 2 * w + 2 * groups + VISIBILITY_ROWS;
  return [
    1,
    1,
    5 * w + 3 * VISIBILITY_ROWS,
    ranking(f.artistGroups),
    ranking(f.trackGroups),
    ranking(f.albumGroups),
    CACHE_STORE_ROWS,
  ];
}

/** The statistics of a window computed in JavaScript from the generated records (the independent oracle). */
interface GeneratorWindow {
  windowRows: number;
  artistGroups: number;
  trackGroups: number;
  albumGroups: number;
  topArtistCounts: number[];
  topTrackCounts: number[];
  topAlbumCounts: number[];
}

function generatorWindow(records: GenRecord[], window: StatsWindow): GeneratorWindow {
  const days = WINDOW_DAYS[window];
  const lowerMs = days === null ? Number.NEGATIVE_INFINITY : NOW_MS - days * 86_400_000;
  const artists = new Map<string, number>();
  const tracks = new Map<string, number>();
  const albums = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  let windowRows = 0;
  for (const { record } of records) {
    const r = record as { artist: string; track: string; album?: string; listenedAt: string };
    const t = Date.parse(r.listenedAt);
    if (t > NOW_MS || t < lowerMs) continue;
    windowRows++;
    bump(artists, r.artist);
    bump(tracks, `${r.artist}\0${r.track}`);
    if (r.album !== undefined) bump(albums, `${r.artist}\0${r.album}`);
  }
  const top = (m: Map<string, number>) => [...m.values()].sort((a, b) => b - a).slice(0, STATS_LIMIT);
  return {
    windowRows,
    artistGroups: artists.size,
    trackGroups: tracks.size,
    albumGroups: albums.size,
    topArtistCounts: top(artists),
    topTrackCounts: top(tracks),
    topAlbumCounts: top(albums),
  };
}

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

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
 * listen without an album. `o.startMs` moves the newest listen that far
 * back; `o.spacingMs` replaces the even two-year spacing.
 */
function generateScale(n: number, seed: number, o: { startMs?: number; spacingMs?: number } = {}): GenRecord[] {
  const rnd = seededRandom(seed);
  const spacingMs = o.spacingMs ?? Math.floor((730 * 86_400) / n) * 1000;
  const startMs = o.startMs ?? 0;
  return Array.from({ length: n }, (_, j) => {
    const at = new Date(NOW_MS - 500 - startMs - j * spacingMs).toISOString();
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
  const records = new Map<number, GenRecord[]>();
  for (const [i, n] of SCALES.entries()) {
    const key = scaleKeys[i]!;
    const t0 = performance.now();
    const generated = generateScale(n, DATASET_SEED + i + 1);
    records.set(n, generated);
    const seed = await seedRepo(h.stub, SCALE_DIDS[n], key, scrobbleOps(generated));
    scales.push({ scrobbles: n, did: SCALE_DIDS[n], curve: key.curve, ...seed, seedMs: performance.now() - t0 });
  }
  await seedRepo(h.stub, VIEWER, keys.bob, followOps(SCALES.map((n) => SCALE_DIDS[n])));
  return { h, scales, records };
});

function followOps(subjects: string[]) {
  return subjects.map((subject, i) => ({
    collection: FOLLOW,
    rkey: `f${i}`,
    record: { $type: FOLLOW, subject, createdAt: '2025-01-01T00:00:00Z' },
  }));
}

// The Q10 worst cases, in their own DO so they cannot change the asserted reads:
// - a large dense timeline (WORST_DENSE_ROWS listens of one user over two
//   years) in which WORST_SPARSE accounts have WORST_SPARSE_ROWS listens each,
//   spread over the same two years, and a viewer following only those;
// - an owner whose WORST_HIDDEN_ROWS listens, one per second, are the newest
//   of the whole timeline, deactivated through the production markInactive
//   (rows kept, owner hidden).
const WORST_DENSE = 'did:web:worst-dense.test';
const WORST_SPARSE = ['did:web:worst-sparse-0.test', 'did:web:worst-sparse-1.test', 'did:web:worst-sparse-2.test'];
const WORST_HIDDEN = 'did:web:worst-hidden.test';
const WORST_VIEWER = 'did:web:worst-viewer.test';
const WORST_DENSE_ROWS = 20_000;
const WORST_SPARSE_ROWS = 20;
const WORST_HIDDEN_ROWS = 1_000;
/** Every visible listen is older than the hidden owner's oldest one. */
const WORST_VISIBLE_START_MS = (WORST_HIDDEN_ROWS + 1_000) * 1000;

const worstDo = once(async () => {
  const keys = await fixtureKeys();
  const h = harness('bench-worst');
  await seedRepo(
    h.stub,
    WORST_DENSE,
    keys.alice,
    scrobbleOps(generateScale(WORST_DENSE_ROWS, 101, { startMs: WORST_VISIBLE_START_MS })),
  );
  for (const [i, did] of WORST_SPARSE.entries()) {
    // Offset by a few hours each, so the sparse accounts do not share timestamps.
    const startMs = WORST_VISIBLE_START_MS + (i + 1) * 3 * 3_600_000;
    await seedRepo(h.stub, did, keys.bob, scrobbleOps(generateScale(WORST_SPARSE_ROWS, 111 + i, { startMs })));
  }
  await seedRepo(
    h.stub,
    WORST_HIDDEN,
    keys.carol,
    scrobbleOps(generateScale(WORST_HIDDEN_ROWS, 121, { spacingMs: 1000 })),
  );
  await seedRepo(h.stub, WORST_VIEWER, keys.aliceRotated, followOps(WORST_SPARSE));
  const hidden = await runInDurableObject(h.stub, (_i, state) => {
    const db = doDb(state.storage);
    return db.tx(() => markInactive(db, WORST_HIDDEN, 'deactivated'));
  });
  if (!hidden.changed) throw new Error('worst case: the hidden owner was not deactivated');
  return { h };
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
  /** The page statement's cursor rowsRead: the quantity the Q10 budget bounds. */
  rowsRead: number;
  /** Diagnostic: rows read by the same keyset walk without the visibility join (summed per walked account). */
  indexRowsRead: number;
  /** Diagnostic: rowsRead - indexRowsRead (clamped at 0). */
  visibilityRowsRead: number;
  /** The ADR 0004 §15 Q10 budget of the page statement (Q10_* above). */
  budget: number;
  budgetRule: (typeof BUDGET_RULE)[ReadMeasurement['kind']];
  /** Every statement of the call: the page statement plus the indexing-truth reads (not budgeted). */
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
  /** Owners whose rows the page holds, for the independent reference query (null = every row). */
  owners: string[] | null;
  /** Owners walked one by one for the index diagnostic (null = one walk of the global index). */
  walkOwners: string[] | null;
  viewer?: string;
  depth: number | null;
}

/** A read measured on its page statement, with that statement's EXPLAIN QUERY PLAN. */
interface MeasuredRead {
  name: string;
  kind: ReadMeasurement['kind'];
  scale: number | null;
  page: 'first' | 'deep';
  depth: number;
  rowsReturned: number;
  rowsRead: number;
  indexRowsRead: number;
  visibilityRowsRead: number;
  statements: number;
  allStatementsRowsRead: number;
  coldMs: number;
  warmMs: number;
  plan: string[];
}

const ORDER = 'ORDER BY listened_at DESC, uri DESC';

function ownersWhere(owners: string[] | null): { sql: string; params: SqlParam[] } {
  if (owners === null) return { sql: '1 = 1', params: [] };
  return { sql: `did IN (${owners.map(() => '?').join(', ')})`, params: owners };
}

async function measureRead(stub: Stub, spec: ReadSpec): Promise<MeasuredRead> {
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
    const viewer = spec.viewer ?? VIEWER;
    const run =
      spec.kind === 'history'
        ? () => history(m, { did: spec.owners![0]!, ...keyset } satisfies HistoryQuery)
        : spec.kind === 'global'
          ? () => feed(m, { scope: 'global', ...keyset } satisfies FeedQuery)
          : () => feed(m, { scope: 'following', viewer, ...keyset } satisfies FeedQuery);

    const t0 = performance.now();
    const result = run();
    const coldMs = performance.now() - t0;
    const pageStatement = trace[0]!;
    if (!pageStatement.sql.trimStart().startsWith('SELECT s.* FROM scrobbles s')) {
      throw new Error(`${spec.name}: unexpected first statement ${pageStatement.sql}`);
    }
    const statements = trace.length;
    const allStatementsRowsRead = trace.reduce((a, t) => a + t.rowsRead, 0);
    const plan = plain
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${pageStatement.sql}`, ...pageStatement.params)
      .map((r) => r.detail);

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
    expect(expected, spec.name).toHaveLength(LIMIT);
    expect(
      result.rows.map((r) => r.uri),
      spec.name,
    ).toEqual(expected);
    expect(result.hasMore, spec.name).toBe(true);

    // Diagnostic only: the same keyset walk without the visibility join, to
    // show how the page statement's rows split between the index walk and
    // the visibility lookups.
    const k = keysetWhere(keyset, 'listened_at', 'uri');
    const walk = (where: string, params: SqlParam[]) =>
      rowsReadOf(state.storage, `SELECT uri FROM scrobbles WHERE ${where}${k.sql} ${ORDER} LIMIT ?`, [
        ...params,
        ...k.params,
        LIMIT + 1,
      ]);
    const indexRowsRead =
      spec.walkOwners === null
        ? walk('1 = 1', [])
        : spec.walkOwners.reduce((sum, did) => sum + walk('did = ?', [did]), 0);

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
      statements,
      allStatementsRowsRead,
      coldMs,
      warmMs,
      plan,
    };
  });
}

/** The Q10 budget of a read of the dense scale set, from the constants above. */
function q10Budget(kind: ReadMeasurement['kind']): number {
  if (kind === 'history') return Q10_HISTORY_BUDGET;
  if (kind === 'global') return Q10_GLOBAL_BUDGET;
  // The scale viewer's follow edges are all visible: every subject is an active user.
  return q10FollowingBudget(SCALES.length);
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
        walkOwners: [SCALE_DIDS[n]],
        depth,
      });
    }
  }
  for (const depth of [null, total / 2]) {
    const page = depth === null ? 'first' : 'deep';
    specs.push({ name: `global ${page}`, kind: 'global', scale: null, owners: null, walkOwners: null, depth });
    specs.push({
      name: `following ${page}`,
      kind: 'following',
      scale: null,
      owners: followed,
      walkOwners: followed,
      depth,
    });
  }
  const out: ReadMeasurement[] = [];
  for (const spec of specs) {
    const { plan: _plan, ...m } = await measureRead(h.stub, spec);
    const budget = q10Budget(spec.kind);
    out.push({ ...m, budget, budgetRule: BUDGET_RULE[spec.kind], withinBudget: m.rowsRead <= budget });
  }
  return out;
});

// ---------------------------------------------------------------------------
// Q10 worst cases: measured and reported, never asserted

type WorstCaseId =
  | 'following-sparse-followees-first'
  | 'following-sparse-followees-deep'
  | 'global-hidden-newest-first';

interface WorstCase extends MeasuredRead {
  id: WorstCaseId;
  scenario: string;
  /** The dense-data Q10 budget of the same kind of read, for comparison only. */
  denseBudget: number;
  asserted: false;
}

const worstCases = once(async () => {
  const { h } = await worstDo();
  const visibleRows = WORST_DENSE_ROWS + WORST_SPARSE.length * WORST_SPARSE_ROWS;
  const timeline = `${visibleRows.toLocaleString('en-US')}-row visible timeline`;
  const sparse = `the viewer follows only ${WORST_SPARSE.length} accounts with ${WORST_SPARSE_ROWS} listens each, spread over two years of a ${timeline}`;
  const sparseDepth = (WORST_SPARSE.length * WORST_SPARSE_ROWS) / 2;
  const specs: Array<{ id: WorstCaseId; scenario: string; denseBudget: number; spec: ReadSpec }> = [
    {
      id: 'following-sparse-followees-first',
      scenario: `Following feed, first page: ${sparse}.`,
      denseBudget: q10FollowingBudget(WORST_SPARSE.length),
      spec: {
        name: 'worst following sparse first',
        kind: 'following',
        scale: null,
        owners: WORST_SPARSE,
        walkOwners: WORST_SPARSE,
        viewer: WORST_VIEWER,
        depth: null,
      },
    },
    {
      id: 'following-sparse-followees-deep',
      scenario: `Following feed, deep page (depth ${sparseDepth}): ${sparse}.`,
      denseBudget: q10FollowingBudget(WORST_SPARSE.length),
      spec: {
        name: 'worst following sparse deep',
        kind: 'following',
        scale: null,
        owners: WORST_SPARSE,
        walkOwners: WORST_SPARSE,
        viewer: WORST_VIEWER,
        depth: sparseDepth,
      },
    },
    {
      id: 'global-hidden-newest-first',
      scenario: `Global feed, first page: the newest ${WORST_HIDDEN_ROWS.toLocaleString('en-US')} rows belong to an owner deactivated by the production markInactive (rows kept, owner hidden), above a ${timeline}.`,
      denseBudget: Q10_GLOBAL_BUDGET,
      spec: {
        name: 'worst global hidden newest first',
        kind: 'global',
        scale: null,
        owners: [WORST_DENSE, ...WORST_SPARSE],
        walkOwners: null,
        depth: null,
      },
    },
  ];
  const out: WorstCase[] = [];
  for (const s of specs) {
    const m = await measureRead(h.stub, s.spec);
    out.push({ ...m, id: s.id, scenario: s.scenario, denseBudget: s.denseBudget, asserted: false });
  }
  return out;
});

// ---------------------------------------------------------------------------
// Statistics measurements

interface StatsObserved {
  /** count(*) of the window by plain SQL. */
  windowRows: number;
  totalScrobbles: number;
  distinctArtists: number;
  distinctTracks: number;
  topArtistCounts: number[];
  topTrackCounts: number[];
  topAlbumCounts: number[];
}

interface StatsMeasurement {
  scale: number;
  window: StatsWindow;
  windowRows: number;
  /** The independent oracle: the window computed in JavaScript from the generated records. */
  expected: GeneratorWindow;
  /** What SQL and the production miss returned. */
  observed: StatsObserved;
  uncached: {
    rowsRead: number;
    statements: number;
    coldMs: number;
    warmMs: number;
    perStatement: number[];
    /** statementBudgets(expected), in the same order as perStatement. */
    statementBudgets: number[];
  };
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
  /** The next request after a production bumpStatsVersion: it must recompute (a miss) and still be equal. */
  afterVersionBump: { cache: 'hit' | 'miss' | null; equalsUncached: boolean };
  /** Sum of uncached.statementBudgets. */
  rowsReadBudget: number;
  /** The hit body, compared key-order-independently with a fresh uncached computation at the hit's asOf. */
  equalsUncached: boolean;
  withinBudget: boolean;
}

function lowerBound(window: StatsWindow): string | null {
  const days = WINDOW_DAYS[window];
  return days === null ? null : toStorage(fromMs(NOW_MS - days * 86_400_000));
}

async function measureStats(
  stub: Stub,
  scale: number,
  did: string,
  window: StatsWindow,
  records: GenRecord[],
): Promise<StatsMeasurement> {
  const expected = generatorWindow(records, window);
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
    const missStats = miss.statistics!;
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
    const equalsUncached = canonical(hit.statistics) === canonical(fresh);
    const cachedMs = meanMs(WARM_REPEATS, () => statsWithCache(plain, later));

    // Negative control for the hit: the production version bump (what every
    // scrobble insert, change or delete does) must make the next request
    // recompute, and the recomputation equals the fresh computation too.
    plain.tx(() => bumpStatsVersion(plain, did));
    const bumped = statsWithCache(plain, later);

    const budgets = statementBudgets(expected);
    const probeBudget = q10ProbeBudget(window);
    const withinProbeBudget = probes.length <= probeBudget && probesIndexed;
    const rowsReadBudget = budgets.reduce((a, b) => a + b, 0);
    const withinStatementBudgets =
      perStatement.length === budgets.length && perStatement.every((r, i) => r <= budgets[i]!);
    return {
      scale,
      window,
      windowRows,
      expected,
      observed: {
        windowRows,
        totalScrobbles: missStats.totalScrobbles,
        distinctArtists: missStats.distinctArtists,
        distinctTracks: missStats.distinctTracks,
        topArtistCounts: missStats.topArtists.map((a) => a.scrobbleCount),
        topTrackCounts: missStats.topTracks.map((t) => t.scrobbleCount),
        topAlbumCounts: missStats.topAlbums.map((a) => a.scrobbleCount),
      },
      uncached: {
        rowsRead: uncachedRows,
        statements: uncachedStatements,
        coldMs,
        warmMs,
        perStatement,
        statementBudgets: budgets,
      },
      cached: {
        rowsRead: probes.reduce((a, t) => a + t.rowsRead, 0),
        probes: probes.length,
        probeKinds,
        probesIndexed,
        probeBudget,
        withinProbeBudget,
        ms: cachedMs,
      },
      afterVersionBump: { cache: bumped.cache, equalsUncached: canonical(bumped.statistics) === canonical(fresh) },
      rowsReadBudget,
      equalsUncached,
      withinBudget: withinStatementBudgets && uncachedRows <= rowsReadBudget && withinProbeBudget && equalsUncached,
    };
  });
}

const statsMeasurements = once(async () => {
  const { h, records } = await scaleDo();
  const out: StatsMeasurement[] = [];
  for (const n of SCALES) {
    for (const w of WINDOWS) out.push(await measureStats(h.stub, n, SCALE_DIDS[n], w, records.get(n)!));
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

/** `{ group size: number of groups }` of the stored rows grouped by `columns` (fixed identifiers). */
function histogram(db: Db, columns: string): Record<string, number> {
  const rows = db.all<{ c: number; n: number }>(
    `SELECT c, count(*) AS n FROM (SELECT count(*) AS c FROM scrobbles GROUP BY ${columns}) GROUP BY c ORDER BY c`,
  );
  return Object.fromEntries(rows.map((r) => [String(r.c), r.n]));
}

/** The same histogram computed from the generated records, grouped per user by `key`. */
function generatorHistogram(users: GenRecord[][], key: (r: Record<string, unknown>) => string): Record<string, number> {
  const sizes = new Map<number, number>();
  for (const records of users) {
    const groups = new Map<string, number>();
    for (const { record } of records) groups.set(key(record), (groups.get(key(record)) ?? 0) + 1);
    for (const c of groups.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  }
  return Object.fromEntries([...sizes.entries()].sort(([a], [b]) => a - b).map(([c, n]) => [String(c), n]));
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
      // Group-size histograms: { rows per group: number of groups } over every user.
      artistGroups: histogram(db, 'did, artist_key'),
      trackGroups: histogram(db, 'did, artist_key, track_key'),
      albumGroups: histogram(db, 'did, album_key'),
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

type FollowUp = { id: string; summary: string; measured: number; threshold: number };

/** What the measured plan of each worst case means; the numbers come from the measurement. */
const WORST_CASE_READING: Record<WorstCaseId, string> = {
  'following-sparse-followees-first':
    "SQLite walks each followee's scrobbles_owner_time range (up to L + 1 rows each) and merges the walks in a temporary B-tree, so rows read grow with the number of followees, not with the size of the global timeline.",
  'following-sparse-followees-deep':
    'The same per-followee walks start below the cursor, so a deep page costs no more than a first page.',
  'global-hidden-newest-first':
    "The scrobbles_global_time walk visits and discards every hidden row above the first visible one, each with its owner-visibility probe, so rows read grow linearly with the hidden owner's newest rows. Candidate fixes (not decided): keep hidden owners' rows out of the global walk, for example by deleting them on deactivation and re-snapshotting on reactivation, or a visibility column in the global index.",
};

/** The page statement's plan lines that touch scrobbles (the rest are visibility lookups). */
const scrobblesPlan = (plan: string[]) => plan.filter((d) => /\bs USING\b|TEMP B-TREE/.test(d));

function buildFollowUps(stats: StatsMeasurement[], worst: WorstCase[]): FollowUp[] {
  const followUps: FollowUp[] = [];
  // ADR 0004 §15 Q10: the two worst cases are always recorded as follow-ups,
  // with their measured page-statement rows read against the dense budget.
  for (const w of worst) {
    followUps.push({
      id: `worst-${w.id}`,
      summary: `${w.scenario} The page statement read ${w.rowsRead.toLocaleString('en-US')} rows for ${w.rowsReturned} returned (the dense-data Q10 budget of this kind of read is ${w.denseBudget}; index walk ${w.indexRowsRead.toLocaleString('en-US')}, visibility ${w.visibilityRowsRead.toLocaleString('en-US')}; scrobbles plan: ${scrobblesPlan(w.plan).join('; ')}). ${WORST_CASE_READING[w.id]} Measured and reported, not asserted (Q10).`,
      measured: w.rowsRead,
      threshold: w.denseBudget,
    });
  }
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
  const worst = await worstCases();
  const http = await httpMeasurements();
  return {
    schema: 'atmusic/read-models-benchmark@2',
    generatedBy: 'worker/test/bench/read-models.bench.test.ts',
    frozenClock: NOW_ISO,
    environment: {
      runner: 'local workerd via @cloudflare/vitest-plugin (miniflare); not a Cloudflare edge isolate',
      ...bench.host,
      timerIntegerMs: http.latencies.every((x) => Number.isInteger(x)),
    },
    limit: LIMIT,
    budgets: {
      source: 'ADR 0004 §15 Q10',
      scope: 'page statement rowsRead (history/feed); every statement of a cached statistics hit',
      history: Q10_HISTORY_BUDGET,
      global: Q10_GLOBAL_BUDGET,
      following: q10FollowingBudget(SCALES.length),
      followingVisibleEdges: SCALES.length,
      statsProbesAll: Q10_STATS_PROBES_ALL,
      statsProbesWindowed: Q10_STATS_PROBES_WINDOWED,
    },
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
    worstCases: worst,
    http: http.summary,
    followUps: buildFollowUps(stats, worst),
    // Only asserted budgets decide the verdict; the worst cases are reported, not asserted (Q10).
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
    // Each user: every artist exactly 10 rows, every (artist, track) 2, every
    // album name 20. The stored group-size histograms equal the documented
    // distribution (100 users × 100 artists, × 500 tracks, × 50 albums) and
    // the histograms computed from the generated records.
    const documented = {
      artistGroups: { '10': DATASET_USERS * 100 },
      trackGroups: { '2': DATASET_USERS * 500 },
      albumGroups: { '20': DATASET_USERS * 50 },
    };
    const field = (name: string) => (r: Record<string, unknown>) => String(r[name]);
    expect({
      artistGroups: generatorHistogram(users, field('artist')),
      trackGroups: generatorHistogram(users, (r) => `${r.artist}\0${r.track}`),
      albumGroups: generatorHistogram(users, field('album')),
    }).toEqual(documented);
    expect({
      artistGroups: facts.artistGroups,
      trackGroups: facts.trackGroups,
      albumGroups: facts.albumGroups,
    }).toEqual(documented);
    // Durations: exactly the generated extremes, inside the documented 120–419 s.
    const durations = users.flat().map((r) => (r.record as { durationSeconds: number }).durationSeconds);
    const generated = { min: Math.min(...durations), max: Math.max(...durations) };
    expect(generated.min).toBeGreaterThanOrEqual(120);
    expect(generated.max).toBeLessThanOrEqual(419);
    expect(facts.duration).toEqual(generated);
    // The stored rows are exactly the generated records.
    expect(facts.dbDigest).toBe(facts.generatorDigest);
  });

  it('history/feed page statement rows read within ADR Q10 budgets', async () => {
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
    // The following budget's edge term: the scale viewer's follow edges, by
    // plain SQL (all four subjects are active, so every edge is visible), and
    // Q10's 4(L + 1) walk term matches the four dense followed accounts.
    const { h } = await scaleDo();
    const edges = await runInDurableObject(h.stub, (_i, state) =>
      doDb(state.storage).all<{ subject: string }>(
        'SELECT subject FROM follows WHERE actor = ? ORDER BY subject',
        VIEWER,
      ),
    );
    expect(edges.map((e) => e.subject)).toEqual(SCALES.map((n) => SCALE_DIDS[n]).sort());
    expect(Q10_FOLLOWING_WALKS).toBe(edges.length);
    const expectedBudget = {
      history: LIMIT + 3,
      global: 2 * (LIMIT + 1) + 1,
      following: 4 * (LIMIT + 1) + 1 + edges.length,
    } as const;
    expect(expectedBudget).toEqual({ history: 23, global: 43, following: 89 });

    for (const r of reads) {
      expect(r.rowsReturned, r.name).toBe(LIMIT);
      expect(r.budget, r.name).toBe(expectedBudget[r.kind]);
      // ADR 0004 §15 Q10, a hard assertion on the production page statement's
      // cursor rowsRead. The lower bound keeps it from passing vacuously: the
      // page statement reads at least its limit + 1 probe rows.
      expect(r.rowsRead, `${r.name}: page statement rowsRead`).toBeLessThanOrEqual(expectedBudget[r.kind]);
      expect(r.rowsRead, `${r.name}: page statement rowsRead`).toBeGreaterThanOrEqual(LIMIT + 1);
      expect(r.withinBudget, r.name).toBe(true);
    }
    // Rows read do not grow with the user's size or the cursor depth.
    const historyRows = reads.filter((r) => r.kind === 'history').map((r) => r.rowsRead);
    expect(Math.max(...historyRows) - Math.min(...historyRows)).toBeLessThanOrEqual(1);
    // Whole-call totals are reported separately and not budgeted: the other
    // statements of a call (the indexing truth) read the same rows, and run
    // the same number of statements, at every scale and depth.
    for (const kind of ['history', 'global', 'following'] as const) {
      const ofKind = reads.filter((r) => r.kind === kind);
      expect(new Set(ofKind.map((r) => r.allStatementsRowsRead - r.rowsRead)).size, kind).toBe(1);
      expect(new Set(ofKind.map((r) => r.statements)).size, kind).toBe(1);
      expect(ofKind[0]!.statements, kind).toBeGreaterThan(1);
    }
  });

  it('stats cache hit within ADR Q10 probe budget and equals uncached result', async () => {
    const stats = await statsMeasurements();
    expect(stats.map((s) => `${s.scale} ${s.window}`)).toEqual(SCALES.flatMap((n) => WINDOWS.map((w) => `${n} ${w}`)));
    for (const s of stats) {
      const name = `${s.scale} ${s.window}`;
      // The window and the miss match the generator-side oracle (computed in
      // JavaScript from the generated records, not from SQL).
      const e = s.expected;
      expect(e.windowRows, name).toBeGreaterThan(0);
      if (s.window === 'all') expect(e.windowRows, name).toBe(s.scale);
      expect(s.observed, name).toEqual({
        windowRows: e.windowRows,
        totalScrobbles: e.windowRows,
        distinctArtists: e.artistGroups,
        distinctTracks: e.trackGroups,
        topArtistCounts: e.topArtistCounts,
        topTrackCounts: e.topTrackCounts,
        topAlbumCounts: e.topAlbumCounts,
      });

      // ADR 0004 §15 Q10, hard: every statement of the hit is an indexed
      // probe: the users row, the cache row, then one EXISTS (`all` has no
      // lower bound) or two (a window).
      const budget = s.window === 'all' ? 3 : 4;
      expect(s.cached.probeKinds, name).toEqual(
        s.window === 'all' ? ['users', 'cache', 'exists'] : ['users', 'cache', 'exists', 'exists'],
      );
      expect(s.cached.probes, name).toBeLessThanOrEqual(budget);
      expect(s.cached.probeBudget, name).toBe(budget);
      expect(s.cached.probesIndexed, name).toBe(true);
      // The whole hit reads O(1) rows, whatever the window holds.
      expect(s.cached.rowsRead, name).toBeLessThanOrEqual(s.cached.probes);
      // The hit equals a fresh uncached computation at its asOf, and after a
      // production stats_version bump the next request recomputes (a miss)
      // and equals it as well.
      expect(s.equalsUncached, name).toBe(true);
      expect(s.afterVersionBump, name).toEqual({ cache: 'miss', equalsUncached: true });

      // Uncached: user, cache, totals, artists, tracks, albums, store; each
      // within its window-derived bound (statementBudgets), so the miss is
      // linear in the window rows, never in the user's rows.
      expect(s.uncached.statements, name).toBe(7);
      const w = e.windowRows;
      expect(s.uncached.statementBudgets, name).toEqual([
        1,
        1,
        5 * w + 6,
        2 * w + 2 * e.artistGroups + 2,
        2 * w + 2 * e.trackGroups + 2,
        2 * w + 2 * e.albumGroups + 2,
        2,
      ]);
      s.uncached.perStatement.forEach((rows, i) => {
        expect(rows, `${name}: statement ${i}`).toBeLessThanOrEqual(s.uncached.statementBudgets[i]!);
      });
      // The window walk itself is real: totals read at least the window once.
      expect(s.uncached.perStatement[2], name).toBeGreaterThanOrEqual(w);
      expect(s.withinBudget, name).toBe(true);
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
    // The schema is not vacuous: a negative count, a missing verdict and an
    // asserted worst case are refused.
    expect(validate({ ...value, http: { ...value.http, errors: -1 } })).toBe(false);
    const { passed: _passed, ...withoutVerdict } = value;
    expect(validate(withoutVerdict)).toBe(false);
    expect(validate({ ...value, worstCases: value.worstCases.map((w) => ({ ...w, asserted: true })) })).toBe(false);
    // The verdict is the conjunction of every asserted budget (a breach is
    // reported as failed, never hidden), and every read carries its Q10 budget.
    expect(value.passed).toBe(
      value.reads.every((r) => r.rowsRead <= value.budgets[r.kind]) &&
        value.stats.every((st) => st.withinBudget) &&
        value.http.passed,
    );
    expect(
      value.reads.every((r) => r.budget === value.budgets[r.kind] && r.withinBudget === r.rowsRead <= r.budget),
    ).toBe(true);
    expect(value.budgets).toMatchObject({
      history: 23,
      global: 43,
      following: 89,
      statsProbesAll: 3,
      statsProbesWindowed: 4,
    });
    expect(value.dataset.rows).toBe(100_000);
    expect(value.reads).toHaveLength(12);
    expect(value.stats).toHaveLength(16);
    expect(value.http.measuredRequests).toBe(600);
    // The Q10 worst cases: measured on correct pages (measureRead compares each
    // page with an independent OFFSET query), reported, and each listed as a follow-up.
    expect(value.worstCases.map((w) => w.id)).toEqual([
      'following-sparse-followees-first',
      'following-sparse-followees-deep',
      'global-hidden-newest-first',
    ]);
    for (const w of value.worstCases) {
      expect(w.rowsReturned, w.id).toBe(LIMIT);
      expect(w.rowsRead, w.id).toBeGreaterThanOrEqual(LIMIT + 1);
      expect(value.followUps.find((f) => f.id === `worst-${w.id}`)?.measured, w.id).toBe(w.rowsRead);
    }
    // The hidden owner's rows are walked and discarded: the visibility probes
    // of the global page cover at least those rows.
    const hidden = value.worstCases.find((w) => w.id === 'global-hidden-newest-first')!;
    expect(hidden.rowsRead).toBeGreaterThan(WORST_HIDDEN_ROWS);

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
