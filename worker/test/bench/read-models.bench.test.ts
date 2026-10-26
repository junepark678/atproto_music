// W6-02: read-model benchmark, on node:sqlite in the Node host (ported by
// N4-03; ADR 0004 §10; ADR 0005 §15.1, §15.3; AMENDMENTS-workers.md A1 for
// M6.2.3 benchmark_dataset / benchmark_results).
//
// Data. Every scrobble enters the database through the production path: a
// real signed repository (@atmusic/atproto/test-support/signed-repo,
// deterministic fixture keys on both curves), its head checked by the
// production `verifyCommit`, its MST walked by the production range walker
// (`step`, at most 2,000 entries per chunk, the ADR 0004 §5.9 slice bound),
// each chunk applied by `applySnapshotChunk` in one `db.tx` and the snapshot
// finished by `completeSnapshot`. Three databases, each a production Node
// composition (worker/test/composition/support.ts):
// - the M6.2.3 dataset: 100 users × 1,000 scrobbles = exactly 100,000 rows,
//   generator seed 7, the Rust benchmark_seed distribution;
// - the scale set: one user each with 1,000, 10,000, 50,000 and 100,000
//   scrobbles over two years, and a viewer following all four;
// - the Q10 worst cases.
//
// Measurements (ADR 0005 §15.3). node:sqlite has no rows-read counter, so the
// ADR 0004 §15 Q10 rows-read budgets are re-derived as EXPLAIN QUERY PLAN
// assertions on SQLite 3.54.1: the page statement of every history and feed
// read and every statement of a statistics miss that reads scrobbles must
// SEARCH its index (never SCAN scrobbles, and history and the global feed never
// sort in a temporary B-tree). The bounds the budgets enforced are pinned too:
// a deep page's search carries the keyset bound `(listened_at,uri)<(?,?)` and
// its seek (read from the EXPLAIN bytecode) starts at the cursor's last row,
// not at its anchor; a 7d, 30d or 365d statistics statement reads scrobbles
// only through `did=? AND listened_at>? AND listened_at<?`, never a DID-only
// search. Both W6-02 regressions are rebuilt on the real database as negative
// controls. A cached statistics hit is at most 3 (`all`)
// or 4 (a window) statements, each an indexed probe. Timings are reported,
// never asserted: the cold call after the database file was closed and
// reopened, and nearest-rank p50 and p95 of repeated synchronous module calls
// (`performance.now()` around the call; no I/O happens inside it). HTTP
// latency is measured around requests through the production Node
// composition (HTTP bridge → dispatcher → IndexCore); its p95 below 300 ms is
// the one timing verdict (M6.2.3). The suite validates its report against
// the schema of scripts/benchmark-read-models.ts and writes it there
// (to ATMUSIC_BENCH_OUT, default work/bench/read-models.json);
// the script renders docs/benchmarks/*.md from it.
// Measured and reported, never asserted (Q10 worst cases): a following feed
// whose few followees are sparse in a large global timeline, and a global
// timeline whose newest rows belong to an inactive owner. Uncached statistics
// above 50 ms are recorded as follow-ups, not failures.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { afterAll, describe, expect, inject, it } from 'vitest';
import type { FeedQuery, HistoryQuery, KeysetQuery, ModuleDeps, TimeKey } from '../../src/do/contracts';
import type { Db, SqlParam } from '../../src/do/db';
import { feed } from '../../src/do/read/feed';
import { history } from '../../src/do/read/history';
import { computeStatistics, statsStatements, statsWithCache, windowBounds } from '../../src/do/read/stats';
import { bumpStatsVersion, markInactive } from '../../src/do/write/account-state';
import { applySnapshotChunk, completeSnapshot } from '../../src/do/write/apply-snapshot';
import {
  closeHarnesses,
  FOLLOW,
  type Harness,
  harness,
  T0 as NOW_MS,
  PREFIX,
  resetControl,
  SCROBBLE,
  schema,
  seedSnapshotJob,
  seedUser,
} from '../composition/support';

const NOW_NS = fromMs(NOW_MS);

// ---------------------------------------------------------------------------
// Inputs from worker/vitest.bench.config.ts (`provide.bench`): the report
// schema and constants of scripts/benchmark-read-models.ts, the output path,
// the pacing and the host facts. The report types below mirror that schema,
// which validates every report this suite writes.

interface Percentiles {
  runs: number;
  p50Ms: number;
  p95Ms: number;
}

interface ReadMeasurement extends Percentiles {
  name: string;
  kind: 'history' | 'global' | 'following';
  scale: number | null;
  page: 'first' | 'deep';
  depth: number;
  rowsReturned: number;
  statements: number;
  coldMs: number;
  plan: string[];
  indexes: string[];
  planIndexed: boolean;
  /** Deep pages: whether the scrobbles index seek starts at the cursor's last row (null on a first page). */
  seekFromLast: boolean | null;
}

interface WindowCounts {
  topArtistCounts: number[];
  topTrackCounts: number[];
  topAlbumCounts: number[];
}

interface StatsMeasurement {
  scale: number;
  window: StatsWindow;
  windowRows: number;
  expected: WindowCounts & { windowRows: number; artistGroups: number; trackGroups: number; albumGroups: number };
  observed: WindowCounts & {
    windowRows: number;
    totalScrobbles: number;
    distinctArtists: number;
    distinctTracks: number;
  };
  uncached: Percentiles & { statements: number; coldMs: number; scrobblesPlans: string[][]; plansIndexed: boolean };
  cached: Percentiles & {
    probes: number;
    probeKinds: string[];
    probesIndexed: boolean;
    probeBudget: number;
    withinProbeBudget: boolean;
  };
  afterVersionBump: { cache: 'hit' | 'miss' | null; equalsUncached: boolean };
  equalsUncached: boolean;
  withinBudget: boolean;
}

interface WorstCase extends Percentiles {
  id: 'following-sparse-followees-first' | 'following-sparse-followees-deep' | 'global-hidden-newest-first';
  scenario: string;
  name: string;
  kind: 'global' | 'following';
  scale: null;
  page: 'first' | 'deep';
  depth: number;
  rowsReturned: number;
  statements: number;
  coldMs: number;
  plan: string[];
  denseP50Ms: number;
  asserted: false;
}

interface HostFacts {
  platform: string;
  arch: string;
  osRelease: string;
  cpuModel: string;
  logicalCpus: number;
  totalMemoryBytes: number;
  cgroupCpuMax: string | null;
  cgroupMemoryMax: string | null;
}

interface BenchReport {
  schema: string;
  generatedBy: string;
  frozenClock: string;
  environment: HostFacts & { runner: string; node: string; sqlite: string; timerIntegerMs: boolean };
  limit: number;
  plans: {
    source: string;
    sqlite: string;
    history: string;
    global: string;
    following: string;
    stats: string;
    statsProbesAll: number;
    statsProbesWindowed: number;
  };
  dataset: {
    seed: number;
    users: number;
    rowsPerUser: number;
    rows: number;
    activeUsers: number;
    verifiedCommits: number;
    chunks: number;
    maxChunkEntries: number;
    excluded: number;
    digest: string;
    distribution: Record<string, unknown>;
    seedMs: number;
  };
  scales: Array<{ scrobbles: number; did: string; curve: string; chunks: number; written: number; seedMs: number }>;
  reads: ReadMeasurement[];
  stats: StatsMeasurement[];
  worstCases: WorstCase[];
  timings: { history: Percentiles; feed: Percentiles; stats: Percentiles; statsCached: Percentiles };
  http: {
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
  };
  followUps: Array<{ id: string; summary: string; measured: number; threshold: number }>;
  passed: boolean;
}

interface BenchProvided {
  schema: { properties: { environment: { properties: Record<string, unknown> } } } & Record<string, unknown>;
  schemaId: string;
  pinnedSqlite: string;
  outPath: string;
  intervalMs: number;
  repoRoot: string;
  host: HostFacts;
  namedTests: string[];
}

declare module 'vitest' {
  interface ProvidedContext {
    bench: BenchProvided;
  }
}

const bench = inject('bench');
const PINNED_SQLITE = bench.pinnedSqlite;
const OUT_PATH = bench.outPath;

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateReport = ajv.compile(bench.schema);

/** AJV errors for `value` against the report schema; empty when valid. */
function reportErrors(value: unknown): string[] {
  if (validateReport(value)) return [];
  return (validateReport.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

type WriteOutcome = { ok: true; path: string; bytes: number; sha256: string } | { ok: false; errors: string[] };

/** Validates `text` and writes it to `path`; the size and SHA-256 are those of the bytes read back. */
function writeReport(text: string, path: string): WriteOutcome {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['body is not JSON'] };
  }
  const errors = reportErrors(value);
  if (errors.length > 0) return { ok: false, errors };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const written = readFileSync(path);
  return { ok: true, path, bytes: written.length, sha256: createHash('sha256').update(written).digest('hex') };
}

// ---------------------------------------------------------------------------
// Constants

const LIMIT = 20;
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
const STATS_WARM_REPEATS = 5;
const WARMUP_REQUESTS = 300;
const MEASURED_REQUESTS = 600;
const P95_RANK = Math.ceil(0.95 * MEASURED_REQUESTS); // 570: index 569 of the sorted 600
const TARGET_P95_MS = 300;
const STATS_FOLLOW_UP_MS = 50;
/** Hit request offset: every listen is at a half second, so a 250 ms shift of either bound crosses no row. */
const HIT_SHIFT_NS = 250_000_000n;
const NOW_ISO = '2026-01-15T12:00:00Z';
/** Cached-hit probe budgets (ADR 0004 §15 Q10): users row + cache row + ≤ 2 EXISTS (1 for `all`). */
const STATS_PROBES_ALL = 3;
const STATS_PROBES_WINDOWED = 4;
const probeBudget = (w: StatsWindow) => (w === 'all' ? STATS_PROBES_ALL : STATS_PROBES_WINDOWED);

// ---------------------------------------------------------------------------
// Query plans (SQLite 3.54.1 EXPLAIN QUERY PLAN detail lines)

/** History and following: a DID-bounded search of the owner/time index. */
const OWNER_SEARCH = /^SEARCH s USING (COVERING )?INDEX scrobbles_owner_time \(did=\?/;
/** The global feed walks the global time index in order. */
const GLOBAL_ORDERED = /^(SCAN|SEARCH) s USING (COVERING )?INDEX scrobbles_global_time\b/;
/** The following feed finds the viewer's edges by index. */
const FOLLOWS_SEARCH = /^SEARCH f USING (COVERING )?INDEX follows_actor_subject \(actor=\?\)/;
/** Statistics: every scrobbles statement searches by DID through one of the per-user indexes. */
const STATS_SEARCH =
  /^SEARCH (s|scrobbles) USING (COVERING )?INDEX (scrobbles_owner_time|scrobbles_stats|scrobbles_album_stats) \(did=\?/;
/** A full scan of the scrobbles table under any alias the read modules use. */
const FULL_SCAN = /^SCAN (s|scrobbles|d)( |$)(?!USING (COVERING )?INDEX scrobbles_global_time)/;
const TEMP_SORT = /USE TEMP B-TREE FOR (ORDER BY|.*ORDER BY)/;
/** Any search of the scrobbles table under the aliases the page and window statements use. */
const SCROBBLES_SEARCH = /^SEARCH (s|scrobbles) /;
/**
 * The ADR 0004 §15 Q10 rows-read bounds, re-derived as plan pins (ADR 0005 §15.3):
 * - a deep page's scrobbles search carries the keyset row-value bound on the
 *   index range (`(listened_at,uri)<(?,?)`), so the walk starts at the cursor
 *   and not at the top of the owner's (or the global) range; EXPLAIN QUERY
 *   PLAN cannot tell which row value keys the seek, so `seekKey` below also
 *   checks that the seek starts at the cursor's last row (the O(depth)
 *   regression W6-02 found keyed it by the anchor);
 * - a bounded statistics window (7d, 30d, 365d) reads scrobbles only through
 *   a search bounded by the DID and both window ends, so the rows read stay
 *   proportional to the window; a DID-only search there reads the whole user
 *   (the W6-02 regression: the inlined window CTE answered from
 *   `scrobbles_stats (did=?)`, 20,965 rows for a 959-row 7d window).
 */
const DEEP_OWNER_SEARCH =
  /^SEARCH s USING (COVERING )?INDEX scrobbles_owner_time \(did=\? AND \(listened_at,uri\)<\(\?,\?\)\)$/;
const DEEP_GLOBAL_SEARCH = /^SEARCH s USING (COVERING )?INDEX scrobbles_global_time \(\(listened_at,uri\)<\(\?,\?\)\)$/;
const WINDOW_SEARCH =
  /^SEARCH (s|scrobbles) USING (COVERING )?INDEX \w+ \(did=\? AND listened_at>\? AND listened_at<\?\)$/;

/** The pins as the report states them (the schema of scripts/benchmark-read-models.ts holds the same text). */
const PLAN_RULES = {
  history:
    "SEARCH scrobbles_owner_time (did=?), no SCAN, no temporary B-tree; a deep page's search is bounded by (listened_at,uri)<(?,?) and seeks from the cursor's last row",
  global:
    "scrobbles_global_time in order, no SCAN, no temporary B-tree; a deep page's search is bounded by (listened_at,uri)<(?,?) and seeks from the cursor's last row",
  following:
    "SEARCH scrobbles_owner_time per followee and follows_actor_subject, no SCAN; a deep page's search is bounded by (listened_at,uri)<(?,?) and seeks from the cursor's last row",
  stats:
    'every scrobbles statement SEARCHes scrobbles_owner_time or scrobbles_stats by DID, no SCAN; in a 7d, 30d or 365d window every scrobbles SEARCH is bounded by did=? AND listened_at>? AND listened_at<?',
} as const;

/** Whether a page statement's plan is the one ADR 0005 §15.3 pins for its kind and page. */
function pagePlanIndexed(kind: ReadMeasurement['kind'], plan: readonly string[], page: 'first' | 'deep'): boolean {
  if (plan.some((d) => FULL_SCAN.test(d))) return false;
  if (page === 'deep') {
    const deep = kind === 'global' ? DEEP_GLOBAL_SEARCH : DEEP_OWNER_SEARCH;
    const searches = plan.filter((d) => SCROBBLES_SEARCH.test(d));
    if (searches.length === 0 || !searches.every((d) => deep.test(d))) return false;
  }
  if (kind === 'history') return plan.some((d) => OWNER_SEARCH.test(d)) && !plan.some((d) => TEMP_SORT.test(d));
  if (kind === 'global') return plan.some((d) => GLOBAL_ORDERED.test(d)) && !plan.some((d) => TEMP_SORT.test(d));
  return plan.some((d) => OWNER_SEARCH.test(d)) && plan.some((d) => FOLLOWS_SEARCH.test(d));
}

/**
 * Whether an uncached statistics statement's plan is the one ADR 0005 §15.3
 * pins: a DID search of a per-user index and no scan of scrobbles, and for a
 * bounded window every scrobbles search bounded by both window ends.
 */
function statsPlanBounded(window: StatsWindow, plan: readonly string[]): boolean {
  if (plan.some((d) => FULL_SCAN.test(d)) || !plan.some((d) => STATS_SEARCH.test(d))) return false;
  if (WINDOW_DAYS[window] === null) return true;
  return plan.filter((d) => SCROBBLES_SEARCH.test(d)).every((d) => WINDOW_SEARCH.test(d));
}

interface ExplainRow {
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
  p4: unknown;
}

/**
 * The key the statement's one seek on `index` starts from (EXPLAIN bytecode,
 * as worker/test/read/keyset.test.ts reads it): each key register traced back
 * to the `Variable` opcode that loads it (`?N` → `params[N-1]`); a register
 * loaded otherwise (a column of an IN list) is `{ column: true }`. The cursor
 * is found by the index's root page, so no EXPLAIN comments are needed.
 */
function seekKey(db: Db, index: string, st: { sql: string; params: SqlParam[] }): unknown[] {
  const root = db.one<{ rootpage: number }>(
    "SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND name = ?",
    index,
  );
  if (root === null) throw new Error(`no index ${index}`);
  const program = db.all<ExplainRow>(`EXPLAIN ${st.sql}`, ...st.params);
  const open = program.filter((op) => op.opcode === 'OpenRead' && op.p2 === root.rootpage);
  if (open.length !== 1) throw new Error(`${index} is opened ${open.length} times`);
  const cursor = (open[0] as ExplainRow).p1;
  const seeks = program.filter((op) => /^Seek(GE|GT|LE|LT)$/.test(op.opcode) && op.p1 === cursor);
  if (seeks.length !== 1) throw new Error(`${seeks.length} seeks on ${index}`);
  const { p3: first, p4: count } = seeks[0] as ExplainRow;
  return Array.from({ length: Number(count) }, (_, k) => {
    let register = first + k;
    for (;;) {
      const writer = program.find((op) => ['Variable', 'SCopy', 'Copy'].includes(op.opcode) && op.p2 === register);
      if (writer === undefined) return { column: true };
      if (writer.opcode === 'Variable') return st.params[writer.p1 - 1];
      register = writer.p1;
    }
  });
}

/** Whether the seek key ends with the cursor's last row (time, then URI). */
function seeksFrom(key: readonly unknown[], last: TimeKey): boolean {
  return key.length >= 2 && key.at(-2) === last.t && key.at(-1) === last.uri;
}

/** The scrobbles index a page statement of `kind` walks. */
const pageIndex = (kind: ReadMeasurement['kind']) =>
  kind === 'global' ? 'scrobbles_global_time' : 'scrobbles_owner_time';

/**
 * The two-clause keyset form of a deep page statement: the anchor bound
 * `(t, uri) <= (upper)` added before the `(t, uri) < (last)` bound. It selects
 * the same rows (last <= upper) and plans identically, but SQLite seeks from
 * the anchor: the pre-fix `keysetWhere` that read O(depth) rows (W6-02).
 */
function anchorKeyedForm(st: Trace, keyset: KeysetQuery): Trace {
  const upper = keyset.upper as TimeKey;
  const last = keyset.last as TimeKey;
  const bound = ' AND (s.listened_at, s.uri) < (?, ?)';
  if (st.sql.split(bound).length !== 2) throw new Error('the page statement has one keyset bound');
  const at = st.params.findIndex((p, i) => p === last.t && st.params[i + 1] === last.uri);
  if (at < 0) throw new Error('the page statement binds the cursor last row');
  return {
    sql: st.sql.replace(bound, ` AND (s.listened_at, s.uri) <= (?, ?)${bound}`),
    params: [...st.params.slice(0, at), upper.t, upper.uri, ...st.params.slice(at)],
  };
}

function indexesOf(plan: readonly string[]): string[] {
  return [
    ...new Set(plan.flatMap((d) => [...d.matchAll(/USING (?:COVERING )?INDEX (\w+)/g)].map((m) => m[1] as string))),
  ];
}

// ---------------------------------------------------------------------------
// Timing

const nearestRank = (sorted: readonly number[], p: number) => sorted[Math.ceil(p * sorted.length) - 1] as number;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function percentilesOf(samples: readonly number[]): { runs: number; p50Ms: number; p95Ms: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return { runs: sorted.length, p50Ms: nearestRank(sorted, 0.5), p95Ms: nearestRank(sorted, 0.95) };
}

/** `fn` timed `n` times, one sample per call (ms). */
function samplesOf(n: number, fn: () => unknown): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The statistics oracle (computed in JavaScript from the generated records)

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
  h: Harness,
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
  const db = h.db;
  const generation = db.tx(() => {
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
      const res = db.tx(() =>
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
      if (res.outcome !== 'applied' || res.deleted !== 0) throw new Error(`chunk ${JSON.stringify(res)}`);
      out.chunks++;
      out.written += res.written;
      out.maxChunk = Math.max(out.maxChunk, entries.length);
    }
    if (r.done) break;
  }
  const done = db.tx(() =>
    completeSnapshot(db, { did, generation, headRev: verified.rev, accountActive: true, nowNs: NOW_NS }),
  );
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

/** A production composition of its own (INGEST_MODE off, refusing transport, frozen clock). */
async function benchHarness(label: string): Promise<Harness> {
  resetControl();
  return harness(label);
}

const datasetDb = once(async () => {
  const keys = await fixtureKeys();
  const h = await benchHarness('bench-dataset');
  const users = generateDataset(DATASET_SEED);
  const t0 = performance.now();
  const seeds: SeedResult[] = [];
  for (const [a, records] of users.entries()) {
    seeds.push(await seedRepo(h, datasetDid(a), keys.alice, scrobbleOps(records)));
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

const scaleDb = once(async () => {
  const keys = await fixtureKeys();
  const h = await benchHarness('bench-scale');
  const scaleKeys: TestKey[] = [keys.alice, keys.bob, keys.carol, keys.aliceRotated];
  const scales = [];
  const records = new Map<number, GenRecord[]>();
  for (const [i, n] of SCALES.entries()) {
    const key = scaleKeys[i] as TestKey;
    const t0 = performance.now();
    const generated = generateScale(n, DATASET_SEED + i + 1);
    records.set(n, generated);
    const seed = await seedRepo(h, SCALE_DIDS[n], key, scrobbleOps(generated));
    scales.push({ scrobbles: n, did: SCALE_DIDS[n], curve: key.curve, ...seed, seedMs: performance.now() - t0 });
  }
  await seedRepo(h, VIEWER, keys.bob, followOps(SCALES.map((n) => SCALE_DIDS[n])));
  return { h, scales, records };
});

function followOps(subjects: string[]) {
  return subjects.map((subject, i) => ({
    collection: FOLLOW,
    rkey: `f${i}`,
    record: { $type: FOLLOW, subject, createdAt: '2025-01-01T00:00:00Z' },
  }));
}

// The Q10 worst cases, on their own database so they cannot change the asserted reads:
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

const worstDb = once(async () => {
  const keys = await fixtureKeys();
  const h = await benchHarness('bench-worst');
  await seedRepo(
    h,
    WORST_DENSE,
    keys.alice,
    scrobbleOps(generateScale(WORST_DENSE_ROWS, 101, { startMs: WORST_VISIBLE_START_MS })),
  );
  for (const [i, did] of WORST_SPARSE.entries()) {
    // Offset by a few hours each, so the sparse accounts do not share timestamps.
    const startMs = WORST_VISIBLE_START_MS + (i + 1) * 3 * 3_600_000;
    await seedRepo(h, did, keys.bob, scrobbleOps(generateScale(WORST_SPARSE_ROWS, 111 + i, { startMs })));
  }
  await seedRepo(h, WORST_HIDDEN, keys.carol, scrobbleOps(generateScale(WORST_HIDDEN_ROWS, 121, { spacingMs: 1000 })));
  await seedRepo(h, WORST_VIEWER, keys.aliceRotated, followOps(WORST_SPARSE));
  const hidden = h.db.tx(() => markInactive(h.db, WORST_HIDDEN, 'deactivated'));
  if (!hidden.changed) throw new Error('worst case: the hidden owner was not deactivated');
  return { h };
});

afterAll(closeHarnesses);

// ---------------------------------------------------------------------------
// A tracing Db over the production adapter

interface Trace {
  sql: string;
  params: SqlParam[];
}

function tracingDb(inner: Db, trace: Trace[]): Db {
  return {
    all: <T>(query: string, ...p: SqlParam[]) => {
      trace.push({ sql: query, params: p });
      return inner.all<T>(query, ...p);
    },
    one: <T>(query: string, ...p: SqlParam[]) => {
      trace.push({ sql: query, params: p });
      return inner.one<T>(query, ...p);
    },
    run: (query: string, ...p: SqlParam[]) => {
      trace.push({ sql: query, params: p });
      return inner.run(query, ...p);
    },
    tx: (fn) => inner.tx(fn),
  };
}

const planOf = (db: Db, st: Trace) =>
  db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${st.sql}`, ...st.params).map((r) => r.detail);

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

function moduleDeps(h: Harness, db: Db): ModuleDeps {
  return {
    db,
    clock: fixedClock(),
    random: seededRandom(1),
    transport: refuse,
    identity: noIdentity,
    config: h.config.app,
    log: { log() {} },
  };
}

// ---------------------------------------------------------------------------
// History and feed measurements

interface ReadSpec {
  name: string;
  kind: ReadMeasurement['kind'];
  scale: number | null;
  /** Owners whose rows the page holds, for the independent reference query (null = every row). */
  owners: string[] | null;
  viewer?: string;
  depth: number | null;
}

interface MeasuredRead {
  measurement: ReadMeasurement;
  samples: number[];
  /** The page statement as the module ran it, and the cursor it continued. */
  statement: Trace;
  keyset: KeysetQuery;
}

const ORDER = 'ORDER BY listened_at DESC, uri DESC';

function ownersWhere(owners: string[] | null): { sql: string; params: SqlParam[] } {
  if (owners === null) return { sql: '1 = 1', params: [] };
  return { sql: `did IN (${owners.map(() => '?').join(', ')})`, params: owners };
}

async function measureRead(h: Harness, spec: ReadSpec): Promise<MeasuredRead> {
  // Cold: the database file is closed and reopened (an empty statement cache and page cache).
  await h.restart();
  const plain = h.db;
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
  const m = moduleDeps(h, tracingDb(plain, trace));
  const viewer = spec.viewer ?? VIEWER;
  const run =
    spec.kind === 'history'
      ? () => history(m, { did: (spec.owners as string[])[0] as string, ...keyset } satisfies HistoryQuery)
      : spec.kind === 'global'
        ? () => feed(m, { scope: 'global', ...keyset } satisfies FeedQuery)
        : () => feed(m, { scope: 'following', viewer, ...keyset } satisfies FeedQuery);

  const t0 = performance.now();
  const result = run();
  const coldMs = performance.now() - t0;
  const pageStatement = trace[0] as Trace;
  if (!pageStatement.sql.trimStart().startsWith('SELECT s.* FROM scrobbles s')) {
    throw new Error(`${spec.name}: unexpected first statement ${pageStatement.sql}`);
  }
  const statements = trace.length;
  const plan = planOf(plain, pageStatement);
  const page = spec.depth === null ? 'first' : 'deep';
  const seekFromLast =
    keyset.last === undefined ? null : seeksFrom(seekKey(plain, pageIndex(spec.kind), pageStatement), keyset.last);

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

  const samples = samplesOf(WARM_REPEATS, run);
  return {
    measurement: {
      name: spec.name,
      kind: spec.kind,
      scale: spec.scale,
      page,
      depth: spec.depth ?? 0,
      rowsReturned: result.rows.length,
      statements,
      coldMs,
      ...percentilesOf(samples),
      plan,
      indexes: indexesOf(plan),
      planIndexed: pagePlanIndexed(spec.kind, plan, page),
      seekFromLast,
    },
    samples,
    statement: pageStatement,
    keyset,
  };
}

const readMeasurements = once(async () => {
  const { h } = await scaleDb();
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
  const out: MeasuredRead[] = [];
  for (const spec of specs) out.push(await measureRead(h, spec));
  return out;
});

// ---------------------------------------------------------------------------
// Q10 worst cases: measured and reported, never asserted

type WorstCaseId = WorstCase['id'];

const worstCases = once(async () => {
  const { h } = await worstDb();
  const dense = await readMeasurements();
  const denseP50 = (name: string) => dense.find((r) => r.measurement.name === name)?.measurement.p50Ms ?? 0;
  const visibleRows = WORST_DENSE_ROWS + WORST_SPARSE.length * WORST_SPARSE_ROWS;
  const timeline = `${visibleRows.toLocaleString('en-US')}-row visible timeline`;
  const sparse = `the viewer follows only ${WORST_SPARSE.length} accounts with ${WORST_SPARSE_ROWS} listens each, spread over two years of a ${timeline}`;
  const sparseDepth = (WORST_SPARSE.length * WORST_SPARSE_ROWS) / 2;
  const specs: Array<{ id: WorstCaseId; scenario: string; dense: string; spec: ReadSpec }> = [
    {
      id: 'following-sparse-followees-first',
      scenario: `Following feed, first page: ${sparse}.`,
      dense: 'following first',
      spec: {
        name: 'worst following sparse first',
        kind: 'following',
        scale: null,
        owners: WORST_SPARSE,
        viewer: WORST_VIEWER,
        depth: null,
      },
    },
    {
      id: 'following-sparse-followees-deep',
      scenario: `Following feed, deep page (depth ${sparseDepth}): ${sparse}.`,
      dense: 'following first',
      spec: {
        name: 'worst following sparse deep',
        kind: 'following',
        scale: null,
        owners: WORST_SPARSE,
        viewer: WORST_VIEWER,
        depth: sparseDepth,
      },
    },
    {
      id: 'global-hidden-newest-first',
      scenario: `Global feed, first page: the newest ${WORST_HIDDEN_ROWS.toLocaleString('en-US')} rows belong to an owner deactivated by the production markInactive (rows kept, owner hidden), above a ${timeline}.`,
      dense: 'global first',
      spec: {
        name: 'worst global hidden newest first',
        kind: 'global',
        scale: null,
        owners: [WORST_DENSE, ...WORST_SPARSE],
        depth: null,
      },
    },
  ];
  const out: WorstCase[] = [];
  for (const s of specs) {
    const { measurement } = await measureRead(h, s.spec);
    out.push({
      id: s.id,
      scenario: s.scenario,
      name: measurement.name,
      kind: measurement.kind as WorstCase['kind'],
      scale: null,
      page: measurement.page,
      depth: measurement.depth,
      rowsReturned: measurement.rowsReturned,
      statements: measurement.statements,
      coldMs: measurement.coldMs,
      runs: measurement.runs,
      p50Ms: measurement.p50Ms,
      p95Ms: measurement.p95Ms,
      plan: measurement.plan,
      denseP50Ms: denseP50(s.dense),
      asserted: false,
    });
  }
  return out;
});

// ---------------------------------------------------------------------------
// Statistics measurements

interface MeasuredStats {
  measurement: StatsMeasurement;
  uncachedSamples: number[];
  cachedSamples: number[];
}

function lowerBound(window: StatsWindow): string | null {
  const days = WINDOW_DAYS[window];
  return days === null ? null : toStorage(fromMs(NOW_MS - days * 86_400_000));
}

async function measureStats(
  h: Harness,
  scale: number,
  did: string,
  window: StatsWindow,
  records: GenRecord[],
): Promise<MeasuredStats> {
  const expected = generatorWindow(records, window);
  await h.restart();
  const plain = h.db;
  const lower = lowerBound(window);
  const windowRows = (
    plain.one<{ n: number }>(
      `SELECT count(*) AS n FROM scrobbles WHERE did = ? AND listened_at <= ?${lower === null ? '' : ' AND listened_at >= ?'}`,
      ...(lower === null ? [did, toStorage(NOW_NS)] : [did, toStorage(NOW_NS), lower]),
    ) as { n: number }
  ).n;

  const trace: Trace[] = [];
  const db = tracingDb(plain, trace);
  const q = { did, window, limit: STATS_LIMIT, asOfNs: NOW_NS };
  const t0 = performance.now();
  const miss = statsWithCache(db, q);
  const coldMs = performance.now() - t0;
  expect(miss.cache, `${scale} ${window}`).toBe('miss');
  const missStats = miss.statistics as Statistics;
  const uncachedStatements = trace.length;
  const scrobblesPlans = trace
    .filter((t) => /^\s*(SELECT|WITH)\b/i.test(t.sql) && /\bscrobbles\b/.test(t.sql))
    .map((t) => planOf(plain, t));
  const plansIndexed = scrobblesPlans.length > 0 && scrobblesPlans.every((p) => statsPlanBounded(window, p));
  const uncachedSamples = samplesOf(STATS_WARM_REPEATS, () =>
    computeStatistics(plain, did, window, STATS_LIMIT, NOW_NS),
  );

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
    const plan = planOf(plain, p);
    // `SELECT EXISTS (…)` itself plans as SCAN CONSTANT ROW; no table may be scanned.
    return plan.some((d) => d.startsWith('SEARCH ')) && !plan.some((d) => /^SCAN (?!CONSTANT ROW$)/.test(d));
  });
  const fresh: Statistics = computeStatistics(plain, did, window, STATS_LIMIT, later.asOfNs);
  const equalsUncached = canonical(hit.statistics) === canonical(fresh);
  const cachedSamples = samplesOf(WARM_REPEATS, () => statsWithCache(plain, later));

  // Negative control for the hit: the production version bump (what every
  // scrobble insert, change or delete does) must make the next request
  // recompute, and the recomputation equals the fresh computation too.
  plain.tx(() => bumpStatsVersion(plain, did));
  const bumped = statsWithCache(plain, later);

  const budget = probeBudget(window);
  const withinProbeBudget = probes.length <= budget && probesIndexed;
  return {
    measurement: {
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
        statements: uncachedStatements,
        coldMs,
        ...percentilesOf(uncachedSamples),
        scrobblesPlans,
        plansIndexed,
      },
      cached: {
        probes: probes.length,
        probeKinds,
        probesIndexed,
        probeBudget: budget,
        withinProbeBudget,
        ...percentilesOf(cachedSamples),
      },
      afterVersionBump: { cache: bumped.cache, equalsUncached: canonical(bumped.statistics) === canonical(fresh) },
      equalsUncached,
      withinBudget: withinProbeBudget && plansIndexed && equalsUncached,
    },
    uncachedSamples,
    cachedSamples,
  };
}

const statsMeasurements = once(async () => {
  const { h, records } = await scaleDb();
  const out: MeasuredStats[] = [];
  for (const n of SCALES) {
    for (const w of WINDOWS) out.push(await measureStats(h, n, SCALE_DIDS[n], w, records.get(n) as GenRecord[]));
  }
  return out;
});

// ---------------------------------------------------------------------------
// HTTP latency on the M6.2.3 dataset

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
  const { h } = await datasetDb();
  const intervalMs = bench.intervalMs;
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
  const summary: BenchReport['http'] = {
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
    maxMs: sorted.at(-1) as number,
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
  const { h, users } = await datasetDb();
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
  const db = h.db;
  const count = (sql: string) => (db.one<{ n: number }>(sql) as { n: number }).n;
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
    ) as { min: number; max: number },
    dbDigest: await sha256Hex(dbLines.join('\n')),
    generatorDigest: await sha256Hex(generatorLines.join('\n')),
  };
});

// ---------------------------------------------------------------------------
// The report

type FollowUp = BenchReport['followUps'][number];

/** What the measured plan of each worst case means. */
const WORST_CASE_READING: Record<WorstCaseId, string> = {
  'following-sparse-followees-first':
    "SQLite walks each followee's scrobbles_owner_time range (up to L + 1 rows each) and merges the walks in a temporary B-tree, so the cost grows with the number of followees, not with the size of the global timeline.",
  'following-sparse-followees-deep':
    'The same per-followee walks start below the cursor, so a deep page costs no more than a first page.',
  'global-hidden-newest-first':
    "The scrobbles_global_time walk visits and discards every hidden row above the first visible one, each with its owner-visibility probe, so the cost grows linearly with the hidden owner's newest rows. Candidate fixes (not decided): keep hidden owners' rows out of the global walk, for example by deleting them on deactivation and re-snapshotting on reactivation, or a visibility column in the global index.",
};

/** The page statement's plan lines that touch scrobbles (the rest are visibility lookups). */
const scrobblesPlan = (plan: string[]) => plan.filter((d) => /\bs USING\b|TEMP B-TREE/.test(d));

function buildFollowUps(stats: StatsMeasurement[], worst: WorstCase[]): FollowUp[] {
  const followUps: FollowUp[] = [];
  // ADR 0004 §15 Q10: the worst cases are always recorded as follow-ups, with
  // their p50 against the dense read of the same kind.
  for (const w of worst) {
    followUps.push({
      id: `worst-${w.id}`,
      summary: `${w.scenario} p50 ${w.p50Ms.toFixed(3)} ms, p95 ${w.p95Ms.toFixed(3)} ms for ${w.rowsReturned} rows (the dense first page of this kind of read: p50 ${w.denseP50Ms.toFixed(3)} ms; scrobbles plan: ${scrobblesPlan(w.plan).join('; ')}). ${WORST_CASE_READING[w.id]} Measured and reported, not asserted (Q10).`,
      measured: w.p50Ms,
      threshold: w.denseP50Ms,
    });
  }
  // Every uncached statistics call over 50 ms (cold, or the p95 of repeated calls) is recorded.
  for (const s of stats) {
    const slowest = Math.max(s.uncached.coldMs, s.uncached.p95Ms);
    if (slowest <= STATS_FOLLOW_UP_MS) continue;
    followUps.push({
      id: `stats-${s.scale}-${s.window}-over-50ms`,
      summary: `Uncached ${s.window} statistics of the ${s.scale.toLocaleString('en-US')}-scrobble user (${s.windowRows.toLocaleString('en-US')} window rows) took ${slowest.toFixed(1)} ms on node:sqlite (cold ${s.uncached.coldMs.toFixed(1)} ms, p50 ${s.uncached.p50Ms.toFixed(1)} ms, p95 ${s.uncached.p95Ms.toFixed(1)} ms; a cached hit p50 ${s.cached.p50Ms.toFixed(3)} ms). Read-time aggregation is linear in the window rows; pre-aggregated per-user counters would bound it if such users appear.`,
      measured: slowest,
      threshold: STATS_FOLLOW_UP_MS,
    });
  }
  return followUps;
}

const report = once(async (): Promise<BenchReport> => {
  const facts = await datasetFacts();
  const data = await datasetDb();
  const scale = await scaleDb();
  const measuredReads = await readMeasurements();
  const measuredStats = await statsMeasurements();
  const worst = await worstCases();
  const http = await httpMeasurements();
  const reads = measuredReads.map((r) => r.measurement);
  const stats = measuredStats.map((s) => s.measurement);
  const samplesOfKind = (kinds: ReadMeasurement['kind'][]) =>
    measuredReads.filter((r) => kinds.includes(r.measurement.kind)).flatMap((r) => r.samples);
  const sqlite = (data.h.db.one<{ v: string }>('SELECT sqlite_version() AS v') as { v: string }).v;
  return {
    schema: bench.schemaId,
    generatedBy: 'worker/test/bench/read-models.bench.test.ts',
    frozenClock: NOW_ISO,
    environment: {
      runner:
        'node:sqlite in this Node process (vitest, environment node); HTTP through the production Node composition on 127.0.0.1',
      node: process.version,
      sqlite,
      ...bench.host,
      timerIntegerMs: http.latencies.every((x) => Number.isInteger(x)),
    },
    limit: LIMIT,
    plans: {
      source: 'ADR 0005 §15.3 (ADR 0004 §15 Q10 re-derived as query plans)',
      sqlite: PINNED_SQLITE,
      ...PLAN_RULES,
      statsProbesAll: STATS_PROBES_ALL,
      statsProbesWindowed: STATS_PROBES_WINDOWED,
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
    timings: {
      history: percentilesOf(samplesOfKind(['history'])),
      feed: percentilesOf(samplesOfKind(['global', 'following'])),
      stats: percentilesOf(measuredStats.flatMap((s) => s.uncachedSamples)),
      statsCached: percentilesOf(measuredStats.flatMap((s) => s.cachedSamples)),
    },
    http: http.summary,
    followUps: buildFollowUps(stats, worst),
    // Only asserted properties decide the verdict; the worst cases are reported, not asserted (Q10).
    passed:
      reads.every((r) => r.planIndexed && r.seekFromLast !== false) &&
      stats.every((s) => s.withinBudget) &&
      http.summary.passed,
  };
});

/** Every key of every object in `value`, recursively. */
function keysOf(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Named tests

describe('read-model benchmark', () => {
  it('seeded generator yields exactly 100,000 valid active rows with the documented per-user distribution', async () => {
    const { seeds, users } = await datasetDb();
    const facts = await datasetFacts();

    // The generator is a pure function of its seed.
    expect(JSON.stringify(generateDataset(DATASET_SEED))).toBe(JSON.stringify(users));
    expect(JSON.stringify(generateDataset(DATASET_SEED + 1))).not.toBe(JSON.stringify(users));
    expect(users.flat()).toHaveLength(100_000);

    // Every repository was a verified signed commit, applied in ≤ 2,000-entry chunks with no exclusion.
    expect(seeds).toHaveLength(DATASET_USERS);
    expect(seeds.every((s) => s.written === ROWS_PER_USER && s.chunks >= 1)).toBe(true);
    expect(Math.max(...seeds.map((s) => s.maxChunk))).toBeLessThanOrEqual(MAX_CHUNK_ENTRIES);

    // Database state: exactly 100,000 present rows of 100 visible, current users.
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

  it('the read-model bench records p50 and p95 for history, feed and stats on node:sqlite and asserts their query plans', async () => {
    const measured = await readMeasurements();
    const reads = measured.map((r) => r.measurement);
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
    const { h } = await scaleDb();
    expect(h.db.one<{ v: string }>('SELECT sqlite_version() AS v')?.v).toBe(PINNED_SQLITE);

    for (const r of reads) {
      expect(r.rowsReturned, r.name).toBe(LIMIT);
      // Timings are recorded (reported, never asserted beyond being well-formed).
      expect(r.runs, r.name).toBe(WARM_REPEATS);
      expect(r.p50Ms, r.name).toBeGreaterThan(0);
      expect(r.p50Ms, r.name).toBeLessThanOrEqual(r.p95Ms);
      expect(Number.isFinite(r.coldMs) && r.coldMs > 0, r.name).toBe(true);
      // The page statement's plan on SQLite 3.54.1 (ADR 0005 §15.3): no scan of scrobbles ...
      const text = r.plan.join(' | ');
      expect([r.name, text, r.plan.filter((d) => FULL_SCAN.test(d))]).toEqual([r.name, text, []]);
      if (r.kind === 'history') {
        // ... history searches the owner's range and never sorts ...
        expect([r.name, text, r.plan.some((d) => OWNER_SEARCH.test(d))]).toEqual([r.name, text, true]);
        expect([r.name, text, r.plan.filter((d) => TEMP_SORT.test(d))]).toEqual([r.name, text, []]);
        expect(r.indexes, r.name).toContain('scrobbles_owner_time');
      } else if (r.kind === 'global') {
        // ... the global feed walks the global index in order ...
        expect([r.name, text, r.plan.some((d) => GLOBAL_ORDERED.test(d))]).toEqual([r.name, text, true]);
        expect([r.name, text, r.plan.filter((d) => TEMP_SORT.test(d))]).toEqual([r.name, text, []]);
        expect(r.indexes, r.name).toContain('scrobbles_global_time');
      } else {
        // ... and the following feed searches each followee's range from the viewer's edges.
        expect([r.name, text, r.plan.some((d) => OWNER_SEARCH.test(d))]).toEqual([r.name, text, true]);
        expect([r.name, text, r.plan.some((d) => FOLLOWS_SEARCH.test(d))]).toEqual([r.name, text, true]);
        expect(r.indexes, r.name).toEqual(expect.arrayContaining(['scrobbles_owner_time', 'follows_actor_subject']));
      }
      if (r.page === 'deep') {
        // ... and a deep page starts at the cursor: the keyset row-value bound is on the
        // index range (the Q10 deep-page bound, L + 3 rows read under ADR 0004) ...
        const deep = r.kind === 'global' ? DEEP_GLOBAL_SEARCH : DEEP_OWNER_SEARCH;
        const searches = r.plan.filter((d) => SCROBBLES_SEARCH.test(d));
        expect([r.name, searches.length > 0 && searches.every((d) => deep.test(d))]).toEqual([r.name, true]);
        // ... and the seek is keyed by the cursor's last row, not by its anchor.
        expect(r.seekFromLast, r.name).toBe(true);
      } else {
        expect(r.seekFromLast, r.name).toBeNull();
      }
      expect(r.planIndexed, r.name).toBe(true);
    }
    // The seek keys themselves: the owner DID (or the followee IN-list column), then the last row.
    const { h: scaleH } = await scaleDb();
    for (const m of measured.filter((x) => x.measurement.page === 'deep')) {
      const last = m.keyset.last as TimeKey;
      const lead =
        m.measurement.kind === 'history'
          ? [m.statement.params[0]]
          : m.measurement.kind === 'following'
            ? [{ column: true }]
            : [];
      expect(seekKey(scaleH.db, pageIndex(m.measurement.kind), m.statement), m.measurement.name).toEqual([
        ...lead,
        last.t,
        last.uri,
      ]);
    }
    // The plan check is not vacuous: an unindexed plan of each kind is refused.
    for (const kind of ['history', 'global', 'following'] as const) {
      for (const page of ['first', 'deep'] as const) {
        expect(
          pagePlanIndexed(kind, ['SCAN s', 'SEARCH u USING INTEGER PRIMARY KEY (rowid=?)'], page),
          `${kind} ${page}`,
        ).toBe(false);
      }
      // An owner-range search with the follows edge lookup and a sorted merge is the following feed's plan only.
      const merged = [
        'SEARCH f USING COVERING INDEX follows_actor_subject (actor=?)',
        'SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at<?)',
        'USE TEMP B-TREE FOR ORDER BY',
      ];
      expect(pagePlanIndexed(kind, merged, 'first'), kind).toBe(kind === 'following');
    }
    // A deep page whose search lost the keyset bound (it walks from the top of the range) is refused,
    // while the same plan is a valid first page.
    const unbounded = {
      history: ['SEARCH s USING INDEX scrobbles_owner_time (did=?)'],
      global: ['SCAN s USING INDEX scrobbles_global_time'],
      following: [
        'SEARCH f USING COVERING INDEX follows_actor_subject (actor=?)',
        'SEARCH s USING INDEX scrobbles_owner_time (did=?)',
        'USE TEMP B-TREE FOR ORDER BY',
      ],
    } as const;
    for (const [kind, plan] of Object.entries(unbounded) as [ReadMeasurement['kind'], readonly string[]][]) {
      expect(pagePlanIndexed(kind, plan, 'first'), kind).toBe(true);
      expect(pagePlanIndexed(kind, plan, 'deep'), kind).toBe(false);
    }
    // The O(depth) regression W6-02 found, rebuilt on the real database: the two-clause
    // keyset form of the deepest history page returns the same rows and passes the plan
    // pin (EXPLAIN QUERY PLAN cannot tell the two apart), but its seek is keyed by the
    // anchor, so the seek check refuses it.
    const deepest = measured.find((x) => x.measurement.name === 'history 100000 deep') as MeasuredRead;
    const regressed = anchorKeyedForm(deepest.statement, deepest.keyset);
    const uris = (st: Trace) => scaleH.db.all<{ uri: string }>(st.sql, ...st.params).map((r) => r.uri);
    expect(uris(regressed)).toEqual(uris(deepest.statement));
    expect(uris(regressed)).toHaveLength(LIMIT + 1);
    expect(pagePlanIndexed('history', planOf(scaleH.db, regressed), 'deep')).toBe(true);
    const anchor = deepest.keyset.upper as TimeKey;
    const regressedKey = seekKey(scaleH.db, 'scrobbles_owner_time', regressed);
    expect(regressedKey).toEqual([SCALE_DIDS[100000], anchor.t, anchor.uri]);
    expect(seeksFrom(regressedKey, deepest.keyset.last as TimeKey)).toBe(false);
    // The other statements of a call (the indexing truth) are the same at every scale and depth.
    for (const kind of ['history', 'global', 'following'] as const) {
      const ofKind = reads.filter((r) => r.kind === kind);
      expect(new Set(ofKind.map((r) => r.statements)).size, kind).toBe(1);
      expect((ofKind[0] as ReadMeasurement).statements, kind).toBeGreaterThan(1);
    }

    // Statistics: every uncached statement that reads scrobbles searches a per-user index.
    const stats = (await statsMeasurements()).map((s) => s.measurement);
    expect(stats).toHaveLength(SCALES.length * WINDOWS.length);
    for (const s of stats) {
      const name = `${s.scale} ${s.window}`;
      expect(s.uncached.scrobblesPlans.length, name).toBeGreaterThanOrEqual(4);
      for (const plan of s.uncached.scrobblesPlans) {
        const text = plan.join(' | ');
        expect([name, text, plan.some((d) => STATS_SEARCH.test(d))]).toEqual([name, text, true]);
        expect([name, text, plan.filter((d) => FULL_SCAN.test(d))]).toEqual([name, text, []]);
        if (s.window !== 'all') {
          // A bounded window reads scrobbles only through the (did, listened_at) range of the
          // window (the Q10 bound: rows read proportional to the window, not to the user).
          const searches = plan.filter((d) => SCROBBLES_SEARCH.test(d));
          expect([name, text, searches.length > 0]).toEqual([name, text, true]);
          expect([name, text, searches.filter((d) => !WINDOW_SEARCH.test(d))]).toEqual([name, text, []]);
        }
        expect([name, text, statsPlanBounded(s.window, plan)]).toEqual([name, text, true]);
      }
      expect(s.uncached.plansIndexed, name).toBe(true);
      expect(s.uncached.runs, name).toBe(STATS_WARM_REPEATS);
      expect(s.uncached.p50Ms, name).toBeLessThanOrEqual(s.uncached.p95Ms);
      expect(s.cached.runs, name).toBe(WARM_REPEATS);
      expect(s.cached.p50Ms, name).toBeLessThanOrEqual(s.cached.p95Ms);
    }

    // The statistics pin is not vacuous. The regressed windowed plan W6-02 found (a DID-only
    // search of the covering scrobbles_stats index) is refused for a bounded window and is
    // the accepted `all` plan; a bounded search next to a DID-only one is refused too.
    const didOnly = ['SEARCH s USING COVERING INDEX scrobbles_stats (did=?)'];
    expect(statsPlanBounded('all', didOnly)).toBe(true);
    for (const w of ['7d', '30d', '365d'] as const) {
      expect(statsPlanBounded(w, didOnly), w).toBe(false);
      expect(
        statsPlanBounded(w, [
          'SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at>? AND listened_at<?)',
          ...didOnly,
        ]),
        w,
      ).toBe(false);
      expect(statsPlanBounded(w, ['SCAN s']), w).toBe(false);
    }
    // And rebuilt on the real database: the production 7d totals statement with its window
    // CTE inlined (the pre-fix form) answers the same totals but plans the DID-only search,
    // so the pin refuses it; the production (materialized) form passes.
    const tenK = SCALE_DIDS[10000];
    const totals = statsStatements(tenK, windowBounds('7d', NOW_NS), STATS_LIMIT).totals;
    expect(totals.sql).toContain('MATERIALIZED');
    const inlined = { sql: totals.sql.replace('MATERIALIZED ', ''), params: totals.params };
    expect(scaleH.db.one(inlined.sql, ...inlined.params)).toEqual(scaleH.db.one(totals.sql, ...totals.params));
    const inlinedPlan = planOf(scaleH.db, inlined);
    expect(inlinedPlan.filter((d) => SCROBBLES_SEARCH.test(d) && !WINDOW_SEARCH.test(d))).not.toEqual([]);
    expect(statsPlanBounded('7d', inlinedPlan)).toBe(false);
    expect(statsPlanBounded('7d', planOf(scaleH.db, totals))).toBe(true);

    // The report's per-kind p50 and p95 over every timed call.
    const value = await report();
    expect(value.timings.history.runs).toBe(8 * WARM_REPEATS);
    expect(value.timings.feed.runs).toBe(4 * WARM_REPEATS);
    expect(value.timings.stats.runs).toBe(stats.length * STATS_WARM_REPEATS);
    expect(value.timings.statsCached.runs).toBe(stats.length * WARM_REPEATS);
    for (const [kind, t] of Object.entries(value.timings)) {
      expect(t.p50Ms, kind).toBeGreaterThan(0);
      expect(t.p50Ms, kind).toBeLessThanOrEqual(t.p95Ms);
    }
  });

  it('stats cache hit within ADR Q10 probe budget and equals uncached result', async () => {
    const stats = (await statsMeasurements()).map((s) => s.measurement);
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
      expect(s.cached.withinProbeBudget, name).toBe(true);
      // The hit equals a fresh uncached computation at its asOf, and after a
      // production stats_version bump the next request recomputes (a miss)
      // and equals it as well.
      expect(s.equalsUncached, name).toBe(true);
      expect(s.afterVersionBump, name).toEqual({ cache: 'miss', equalsUncached: true });
      // Uncached: user, cache, totals, artists, tracks, albums, store.
      expect(s.uncached.statements, name).toBe(7);
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
    const value = await report();
    expect(reportErrors(value)).toEqual([]);
    // The schema is not vacuous: a negative count, a missing verdict and an
    // asserted worst case are refused.
    expect(reportErrors({ ...value, http: { ...value.http, errors: -1 } })).not.toEqual([]);
    const { passed: _passed, ...withoutVerdict } = value;
    expect(reportErrors(withoutVerdict)).not.toEqual([]);
    expect(reportErrors({ ...value, worstCases: value.worstCases.map((w) => ({ ...w, asserted: true })) })).not.toEqual(
      [],
    );
    // The verdict is the conjunction of every asserted property (a breach is
    // reported as failed, never hidden).
    expect(value.passed).toBe(
      value.reads.every((r) => r.planIndexed && r.seekFromLast !== false) &&
        value.stats.every((st) => st.withinBudget) &&
        value.http.passed,
    );
    expect(value.passed).toBe(true);
    expect(value.plans).toMatchObject({ sqlite: '3.54.1', statsProbesAll: 3, statsProbesWindowed: 4 });
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
      expect(w.denseP50Ms, w.id).toBeGreaterThan(0);
      expect(value.followUps.find((f) => f.id === `worst-${w.id}`)?.measured, w.id).toBe(w.p50Ms);
    }
    // The hidden owner's rows are walked and discarded through the global index.
    const hidden = value.worstCases.find((w) => w.id === 'global-hidden-newest-first') as WorstCase;
    expect(hidden.plan.some((d) => GLOBAL_ORDERED.test(d))).toBe(true);

    // The report is validated again and written; the size and SHA-256 are those of the bytes on disk.
    const body = JSON.stringify(value, null, 2);
    const written = writeReport(body, OUT_PATH);
    expect(written.ok, JSON.stringify(written)).toBe(true);
    if (!written.ok) return;
    expect(written.path).toBe(OUT_PATH);
    expect(written.bytes).toBe(new TextEncoder().encode(body).length);
    expect(written.sha256).toBe(await sha256Hex(body));
    expect(readFileSync(OUT_PATH, 'utf8')).toBe(body);
    // An invalid report is refused and nothing is written over the valid one.
    const bad = writeReport(JSON.stringify(withoutVerdict), OUT_PATH);
    expect(bad.ok).toBe(false);
    expect(readFileSync(OUT_PATH, 'utf8')).toBe(body);
    // The script's named tests are this suite's titles.
    expect(bench.namedTests).toHaveLength(6);
    expect(bench.namedTests).toEqual(
      expect.arrayContaining([
        'the read-model bench records p50 and p95 for history, feed and stats on node:sqlite and asserts their query plans',
        'stats cache hit within ADR Q10 probe budget and equals uncached result',
      ]),
    );
  });

  it('the benchmark report records node and sqlite versions and has no workerd, wrangler or vitestPlugin field', async () => {
    const value = await report();
    const { h } = await datasetDb();
    expect(value.environment.node).toBe(process.version);
    expect(value.environment.node).toMatch(/^v26\./);
    expect(value.environment.sqlite).toBe(h.db.one<{ v: string }>('SELECT sqlite_version() AS v')?.v);
    expect(value.environment.sqlite).toBe(PINNED_SQLITE);
    expect(value.environment.runner).toMatch(/node:sqlite/);
    // No field of the report, at any depth, names the Workers toolchain.
    const keys = keysOf(value);
    expect(keys.size).toBeGreaterThan(50);
    for (const forbidden of ['workerd', 'wrangler', 'vitestPlugin'])
      expect([forbidden, keys.has(forbidden)]).toEqual([forbidden, false]);
    // The schema refuses such a field (environment is closed).
    expect(reportErrors({ ...value, environment: { ...value.environment, workerd: '1.0.0' } })).not.toEqual([]);
    expect(Object.keys(bench.schema.properties.environment.properties)).toEqual(
      expect.arrayContaining(['node', 'sqlite']),
    );
    expect(Object.keys(bench.schema.properties.environment.properties)).not.toEqual(
      expect.arrayContaining(['workerd']),
    );
    // Neither the script nor this project's config refers to the Workers toolchain.
    for (const file of ['scripts/benchmark-read-models.ts', 'worker/vitest.bench.config.ts']) {
      const text = readFileSync(join(bench.repoRoot, file), 'utf8');
      expect(text.length, file).toBeGreaterThan(500);
      expect([file, text.match(/workerd|wrangler|vitestPlugin|vitest-plugin|cloudflare|miniflare/gi)]).toEqual([
        file,
        null,
      ]);
    }
  });
});
