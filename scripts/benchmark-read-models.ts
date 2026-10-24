// Read-model benchmark runner (W6-02; ADR 0004 §10, AMENDMENTS-workers.md
// A1 for M6.2.3). It supersedes scripts/benchmark_read_models.py, whose Rust
// numbers stay in the docs as history.
//
// Usage:
//   npx tsx scripts/benchmark-read-models.ts [--paced] [--out <report.json>] [--no-docs]
//   npx tsx scripts/benchmark-read-models.ts --render <report.json>
//
// 1. Runs `vitest run --config vitest.bench.config.ts` in worker/: the suite
//    worker/test/bench/read-models.bench.test.ts seeds DO SQLite in local
//    workerd through the production verify + apply path, measures rows read,
//    synchronous DO time and HTTP latency, and hands its report to the
//    BENCH_SINK service binding, which runs here in Node (see
//    worker/vitest.bench.config.ts), validates it against
//    BENCH_REPORT_SCHEMA and writes it to `--out` (default
//    work/bench/read-models.json).
//    `--paced` spaces the HTTP requests 100 ms apart (10 requests/s: a 30 s
//    warmup of 300 requests, then 600 measured requests over 60 s), as M6.2.3
//    specifies. Without it (the repository gate) the same requests run back
//    to back and nothing sleeps.
// 2. Requires every named test of the suite to have passed (vitest JSON
//    reporter), re-validates the report and writes docs/benchmarks/
//    read_models.md and docs/benchmarks/stats.md from it (unless --no-docs).
//    `--render` only re-renders the docs from an existing report.
//
// Never contacts anything but the local workerd that vitest starts.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_REPORT_PATH = join(REPO_ROOT, 'work', 'bench', 'read-models.json');
export const READ_MODELS_DOC = join(REPO_ROOT, 'docs', 'benchmarks', 'read_models.md');
export const STATS_DOC = join(REPO_ROOT, 'docs', 'benchmarks', 'stats.md');
export const REPORT_SCHEMA_ID = 'atmusic/read-models-benchmark@1';
/** The interval of `--paced` runs: 10 requests per second. */
export const PACED_INTERVAL_MS = 100;

/** The suite's named tests (docs/planning/workers-waves.json W6-02). */
export const NAMED_TESTS: readonly string[] = [
  'history/feed rows read ≤ limit+2',
  'stats cache hit uses ≤3 probes and equals uncached result',
  'benchmark JSON is produced and schema-valid',
  'seeded generator yields exactly 100,000 valid active rows with the documented per-user distribution',
  '600 measured requests with zero errors report p95 and check it against the target',
];

// ---------------------------------------------------------------------------
// Report schema (shared with the suite through vitest `provide`)

const int = { type: 'integer', minimum: 0 } as const;
const num = { type: 'number', minimum: 0 } as const;
const str = { type: 'string', minLength: 1 } as const;
const nullableStr = { type: ['string', 'null'] } as const;
const WINDOWS = ['all', '7d', '30d', '365d'] as const;

const timing = {
  type: 'object',
  additionalProperties: false,
  required: ['rowsRead', 'statements', 'coldMs', 'warmMs'],
  properties: { rowsRead: int, statements: int, coldMs: num, warmMs: num },
} as const;

export const BENCH_REPORT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://atmusic.invalid/schemas/read-models-benchmark-1.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'generatedBy',
    'frozenClock',
    'environment',
    'limit',
    'dataset',
    'scales',
    'reads',
    'stats',
    'http',
    'followUps',
    'passed',
  ],
  properties: {
    schema: { const: REPORT_SCHEMA_ID },
    generatedBy: { const: 'worker/test/bench/read-models.bench.test.ts' },
    frozenClock: { const: '2026-01-15T12:00:00Z' },
    environment: {
      type: 'object',
      additionalProperties: false,
      required: [
        'runner',
        'node',
        'platform',
        'arch',
        'osRelease',
        'cpuModel',
        'logicalCpus',
        'totalMemoryBytes',
        'cgroupCpuMax',
        'cgroupMemoryMax',
        'workerd',
        'wrangler',
        'vitestPlugin',
        'timerIntegerMs',
      ],
      properties: {
        runner: str,
        node: str,
        platform: str,
        arch: str,
        osRelease: str,
        cpuModel: str,
        logicalCpus: { type: 'integer', minimum: 1 },
        totalMemoryBytes: { type: 'integer', minimum: 1 },
        cgroupCpuMax: nullableStr,
        cgroupMemoryMax: nullableStr,
        workerd: str,
        wrangler: str,
        vitestPlugin: str,
        timerIntegerMs: { type: 'boolean' },
      },
    },
    limit: { const: 20 },
    dataset: {
      type: 'object',
      additionalProperties: false,
      required: [
        'seed',
        'users',
        'rowsPerUser',
        'rows',
        'activeUsers',
        'verifiedCommits',
        'chunks',
        'maxChunkEntries',
        'excluded',
        'digest',
        'distribution',
        'seedMs',
      ],
      properties: {
        seed: { const: 7 },
        users: { const: 100 },
        rowsPerUser: { const: 1000 },
        rows: { const: 100000 },
        activeUsers: { const: 100 },
        verifiedCommits: { const: 100 },
        chunks: { type: 'integer', minimum: 100 },
        maxChunkEntries: { type: 'integer', minimum: 1, maximum: 2000 },
        excluded: { const: 0 },
        digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        distribution: {
          type: 'object',
          additionalProperties: false,
          required: [
            'artistsPerUser',
            'rowsPerArtist',
            'tracksPerUser',
            'rowsPerTrack',
            'albumsPerUser',
            'rowsPerAlbum',
            'spacingSeconds',
            'durationSeconds',
          ],
          properties: {
            artistsPerUser: { const: 100 },
            rowsPerArtist: { const: 10 },
            tracksPerUser: { const: 500 },
            rowsPerTrack: { const: 2 },
            albumsPerUser: { const: 50 },
            rowsPerAlbum: { const: 20 },
            spacingSeconds: { const: 60 },
            durationSeconds: {
              type: 'object',
              additionalProperties: false,
              required: ['min', 'max'],
              properties: { min: int, max: int },
            },
          },
        },
        seedMs: num,
      },
    },
    scales: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scrobbles', 'did', 'curve', 'chunks', 'written', 'seedMs'],
        properties: {
          scrobbles: { enum: [1000, 10000, 50000, 100000] },
          did: str,
          curve: { enum: ['secp256k1', 'p256'] },
          chunks: { type: 'integer', minimum: 1 },
          written: int,
          seedMs: num,
        },
      },
    },
    reads: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name',
          'kind',
          'scale',
          'page',
          'depth',
          'rowsReturned',
          'rowsRead',
          'indexRowsRead',
          'visibilityRowsRead',
          'indexBudget',
          'rowsReadBudget',
          'statements',
          'allStatementsRowsRead',
          'coldMs',
          'warmMs',
          'withinBudget',
        ],
        properties: {
          name: str,
          kind: { enum: ['history', 'global', 'following'] },
          scale: { type: ['integer', 'null'] },
          page: { enum: ['first', 'deep'] },
          depth: int,
          rowsReturned: int,
          rowsRead: int,
          indexRowsRead: int,
          visibilityRowsRead: int,
          indexBudget: int,
          rowsReadBudget: int,
          statements: int,
          allStatementsRowsRead: int,
          coldMs: num,
          warmMs: num,
          withinBudget: { type: 'boolean' },
        },
      },
    },
    stats: {
      type: 'array',
      minItems: 16,
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'scale',
          'window',
          'windowRows',
          'uncached',
          'cached',
          'rowsReadBudget',
          'equalsUncached',
          'withinBudget',
        ],
        properties: {
          scale: { enum: [1000, 10000, 50000, 100000] },
          window: { enum: WINDOWS },
          windowRows: int,
          uncached: {
            ...timing,
            required: [...timing.required, 'perStatement'],
            properties: { ...timing.properties, perStatement: { type: 'array', items: int } },
          },
          cached: {
            type: 'object',
            additionalProperties: false,
            required: ['rowsRead', 'statements', 'cacheProbes', 'probesIndexed', 'ms'],
            properties: {
              rowsRead: int,
              statements: int,
              cacheProbes: { type: 'integer', minimum: 1, maximum: 3 },
              probesIndexed: { type: 'boolean' },
              ms: num,
            },
          },
          rowsReadBudget: int,
          equalsUncached: { const: true },
          withinBudget: { type: 'boolean' },
        },
      },
    },
    http: {
      type: 'object',
      additionalProperties: false,
      required: [
        'endpoints',
        'warmupRequests',
        'measuredRequests',
        'warmupErrors',
        'errors',
        'paced',
        'intervalMs',
        'elapsedMs',
        'meanMs',
        'p50Ms',
        'p95Ms',
        'p95Rank',
        'p99Ms',
        'maxMs',
        'targetMs',
        'passed',
      ],
      properties: {
        endpoints: { type: 'array', minItems: 2, items: str },
        warmupRequests: { const: 300 },
        measuredRequests: { const: 600 },
        warmupErrors: int,
        errors: int,
        paced: { type: 'boolean' },
        intervalMs: int,
        elapsedMs: num,
        meanMs: num,
        p50Ms: num,
        p95Ms: num,
        p95Rank: { const: 570 },
        p99Ms: num,
        maxMs: num,
        targetMs: { const: 300 },
        passed: { type: 'boolean' },
      },
    },
    followUps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'summary', 'measured', 'threshold'],
        properties: { id: str, summary: str, measured: num, threshold: num },
      },
    },
    passed: { type: 'boolean' },
  },
} as const;

// ---------------------------------------------------------------------------
// Report types (the shape the schema above admits)

export interface ReadMeasurement {
  name: string;
  kind: 'history' | 'global' | 'following';
  scale: number | null;
  page: 'first' | 'deep';
  depth: number;
  rowsReturned: number;
  rowsRead: number;
  indexRowsRead: number;
  visibilityRowsRead: number;
  indexBudget: number;
  rowsReadBudget: number;
  statements: number;
  allStatementsRowsRead: number;
  coldMs: number;
  warmMs: number;
  withinBudget: boolean;
}

export interface StatsMeasurement {
  scale: number;
  window: (typeof WINDOWS)[number];
  windowRows: number;
  uncached: { rowsRead: number; statements: number; coldMs: number; warmMs: number; perStatement: number[] };
  cached: { rowsRead: number; statements: number; cacheProbes: number; probesIndexed: boolean; ms: number };
  rowsReadBudget: number;
  equalsUncached: true;
  withinBudget: boolean;
}

export interface BenchReport {
  schema: typeof REPORT_SCHEMA_ID;
  generatedBy: string;
  frozenClock: string;
  environment: {
    runner: string;
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
    timerIntegerMs: boolean;
  };
  limit: number;
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
    distribution: {
      artistsPerUser: number;
      rowsPerArtist: number;
      tracksPerUser: number;
      rowsPerTrack: number;
      albumsPerUser: number;
      rowsPerAlbum: number;
      spacingSeconds: number;
      durationSeconds: { min: number; max: number };
    };
    seedMs: number;
  };
  scales: Array<{
    scrobbles: number;
    did: string;
    curve: 'secp256k1' | 'p256';
    chunks: number;
    written: number;
    seedMs: number;
  }>;
  reads: ReadMeasurement[];
  stats: StatsMeasurement[];
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

/** AJV errors for `value` against BENCH_REPORT_SCHEMA; empty when valid. */
export function reportErrors(value: unknown): string[] {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(BENCH_REPORT_SCHEMA);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

// ---------------------------------------------------------------------------
// Markdown

const fmt = (n: number) => n.toLocaleString('en-US');
const ms = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(2));
const KIND_LABEL = { history: 'History', global: 'Global feed', following: 'Following feed' } as const;

function environmentRows(r: BenchReport): string[] {
  const e = r.environment;
  return [
    '| Item | Value |',
    '| --- | --- |',
    `| Runner | ${e.runner} |`,
    `| workerd / wrangler / @cloudflare/vitest-plugin | ${e.workerd} / ${e.wrangler} / ${e.vitestPlugin} |`,
    `| Node | ${e.node} |`,
    `| Host | ${e.platform} ${e.arch} ${e.osRelease}; ${e.cpuModel}; ${e.logicalCpus} logical CPUs; ${fmt(e.totalMemoryBytes)} bytes RAM |`,
    `| cgroup cpu.max / memory.max | ${e.cgroupCpuMax ?? 'not present'} / ${e.cgroupMemoryMax ?? 'not present'} |`,
    `| Timer | ${e.timerIntegerMs ? 'workerd reports integer milliseconds: single-call times are quantised to 1 ms; warm times are means of repeated calls' : 'sub-millisecond'} |`,
  ];
}

const FINDINGS = `## Regressions this benchmark found (fixed in W6-02)

- **Deep pages read O(depth) rows.** A cursor carries the traversal anchor (\`upper\`) and the last returned row (\`last\`). With both row-value bounds in the WHERE clause SQLite uses only one of them, the anchor, as the index range start, so it walked and filtered every row between the anchor and \`last\`: 5,023 rows read for a 20-row history page at depth 5,000. \`worker/src/do/read/history.ts\` \`keysetWhere\` now omits the anchor bound when \`last <= upper\` (every cursor the server issues), which selects the same rows; history and both feeds share it.
- **Windowed statistics read the whole user.** The totals statement referenced the window CTE three times; inlined, SQLite answered its DISTINCT/GROUP BY subqueries from the covering \`scrobbles_stats\` index searched by DID only, so a 7-day window of a 10,000-row user read 20,965 rows. \`worker/src/do/read/stats.ts\` now materializes the window for the totals statement of bounded windows, so rows read are proportional to the window (\`all\` keeps the inlined form, which already reads exactly the user's rows).`;

const RUST_READ_MODELS_HISTORY = `## History: Rust candidate (superseded, kept for reference)

The final Linux x86_64 musl backend candidate was measured on 2026-10-06 UTC. Artifact SHA256: \`89ec2297963533f98b8fefde4e300b9f196e6e22ea5c5148133c75b2190f0777\`. It ran 100 users × 1,000 records in a 2-CPU / 2 GiB container: 30 s warmup at a nominal 10 requests/s with 0 errors, then 600 measured requests (alternating history and global feed, \`limit=20\`) over 60 s with 0 errors, p95 9.568 ms and median 2.846 ms against the 300 ms target. History and feed plans used \`scrobbles_owner_time\` and \`scrobbles_global_time\`. The sanitized result is [read_models.json](read_models.json), produced by \`scripts/benchmark_read_models.py\` and checked by \`scripts/test_benchmark.py\`. Those wall-clock numbers measured an sqlx pool in a native process and do not transfer to DO SQLite in workerd (AMENDMENTS-workers.md A1).`;

const RUST_STATS_HISTORY = `## History: Rust candidate (superseded, kept for reference)

\`cargo test --locked -p atmusic-server --test stats_mutations\` ran \`delete_effect\`, \`update_artist\` and \`query_plan\` against isolated SQLite databases: fixed expected totals and rankings from \`docs/planning/TESTING.md\`, and for 100 DIDs × 1,000 signed records the captured production statistics SQL of all four windows planned as indexed DID/time searches, with a negative control that dropped the scrobble indexes in the owned temporary database and saw the global scan fail the check. The Workers equivalents are \`worker/test/read/stats-plan.test.ts\` (W3-02) and \`worker/test/acceptance/query-plans.test.ts\` (W6-01).`;

function reproduce(): string[] {
  return [
    '```sh',
    'npx tsx scripts/benchmark-read-models.ts --paced   # 10 requests/s, 30 s warmup, 60 s measurement; rewrites these docs',
    'npx tsx scripts/benchmark-read-models.ts           # the same requests back to back (what the repository gate runs)',
    'cd worker && npx vitest run --config vitest.bench.config.ts   # the suite alone; the report goes to work/bench/read-models.json',
    '```',
  ];
}

export function renderReadModelsDoc(r: BenchReport): string {
  const h = r.http;
  const d = r.dataset;
  const lines = [
    '# Read-model benchmark (DO SQLite in workerd)',
    '',
    `Generated by \`scripts/benchmark-read-models.ts\` from the report of \`${r.generatedBy}\`. Result: **${r.passed ? 'passed' : 'failed'}**. It supersedes the Rust numbers below (AMENDMENTS-workers.md A1): queries run on DO SQLite inside workerd, so rows read per query (the cursor's \`rowsRead\`, what Workers bill and bound) and the index plan are the reproducible quantities; workerd latency is recorded beside them. This is local workerd (\`@cloudflare/vitest-plugin\`), not a Cloudflare edge isolate, and no network is involved.`,
    '',
    '## Environment',
    '',
    ...environmentRows(r),
    '',
    '## Dataset (M6.2.3 `benchmark_dataset`)',
    '',
    `${fmt(d.users)} users × ${fmt(d.rowsPerUser)} scrobbles = ${fmt(d.rows)} active rows, generator seed ${d.seed}, frozen clock ${r.frozenClock}. Each repository is a real signed commit (deterministic fixture keys); its signature is checked with the production \`verifyCommit\` (${d.verifiedCommits} commits), its MST is walked by the production range walker in chunks of at most 2,000 entries (${fmt(d.chunks)} chunks, the largest ${fmt(d.maxChunkEntries)} entries), and every chunk goes through the production \`applySnapshotChunk\` and \`completeSnapshot\` (${d.excluded} exclusions). Per user: ${d.distribution.artistsPerUser} artists × ${d.distribution.rowsPerArtist}, ${d.distribution.tracksPerUser} tracks × ${d.distribution.rowsPerTrack}, ${d.distribution.albumsPerUser} albums × ${d.distribution.rowsPerAlbum}, one listen every ${d.distribution.spacingSeconds} s (user \`a\` offset by \`a\` seconds, as the Rust generator), durations ${d.distribution.durationSeconds.min}–${d.distribution.durationSeconds.max} s from the seeded generator. Row digest \`${d.digest}\`. Seeding took ${fmt(Math.round(d.seedMs))} ms.`,
    '',
    '## HTTP latency (M6.2.3 `benchmark_results`)',
    '',
    '| Measurement | Result |',
    '| --- | --- |',
    `| Path | production Worker handlers (\`createWorker\`) → JS RPC → IndexDO (TestIndexDO: production IndexDO with test clock/transport only) → DO SQLite |`,
    `| Requests | ${h.endpoints.map((e) => `\`${e}\``).join(' alternating with ')}; every response must be 200 with 20 items and match the OpenAPI \`ScrobblePage\` schema |`,
    `| Pacing | ${h.paced ? `${h.intervalMs} ms between request starts (${1000 / h.intervalMs} requests/s)` : 'back to back (no pacing; the repository gate never sleeps)'} |`,
    `| Warmup | ${h.warmupRequests} requests, ${h.warmupErrors} errors (excluded from the latencies) |`,
    `| Measured | ${h.measuredRequests} requests in ${fmt(Math.round(h.elapsedMs))} ms, ${h.errors} errors |`,
    `| p95 (nearest rank ${h.p95Rank} of ${h.measuredRequests}) | ${ms(h.p95Ms)} ms; target below ${h.targetMs} ms |`,
    `| Mean / median / p99 / max | ${ms(h.meanMs)} / ${ms(h.p50Ms)} / ${ms(h.p99Ms)} / ${ms(h.maxMs)} ms |`,
    `| Result | ${h.passed ? 'passed' : 'failed'} |`,
    '',
    '## Rows read per page (limit 20)',
    '',
    `A second user set in its own DO holds one user each with ${r.scales.map((s) => fmt(s.scrobbles)).join(', ')} scrobbles spread over two years, plus a viewer following all four (${fmt(r.scales.reduce((a, s) => a + s.scrobbles, 0))} rows). Deep pages continue a cursor whose anchor is the newest row and whose last row is halfway down. "Index" is the rows read by the same keyset walk without the visibility join (the budget the plan states, \`limit + 2\`, per followed account for the following feed); "visibility" is the rest: one owner lookup for history, one per candidate row for the feeds, plus the viewer's follow edges. Cold is the first call on a freshly constructed DO instance (after \`evictDurableObject\`); warm is the mean of 20 repeated calls. Times are the synchronous DO call (CPU-bound: no I/O happens inside it).`,
    '',
    '| Read | Scale | Page | Rows read | Index | Visibility | Budget (index / total) | Statements (rows read incl. indexing truth) | Cold ms | Warm ms | Within |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.reads.map(
      (x) =>
        `| ${KIND_LABEL[x.kind]} | ${x.scale === null ? 'all users' : fmt(x.scale)} | ${x.page}${x.page === 'deep' ? ` (${fmt(x.depth)})` : ''} | ${x.rowsRead} | ${x.indexRowsRead} | ${x.visibilityRowsRead} | ${x.indexBudget} / ${x.rowsReadBudget} | ${x.statements} (${x.allStatementsRowsRead}) | ${ms(x.coldMs)} | ${ms(x.warmMs)} | ${x.withinBudget ? 'yes' : 'no'} |`,
    ),
    '',
    'Statistics are in [stats.md](stats.md).',
    '',
    FINDINGS,
    '',
    '## Follow-ups',
    '',
    ...(r.followUps.length === 0
      ? ['None.']
      : r.followUps.map(
          (f) => `- \`${f.id}\`: ${f.summary} (measured ${ms(f.measured)}, threshold ${ms(f.threshold)})`,
        )),
    '',
    '## Reproduce',
    '',
    ...reproduce(),
    '',
    RUST_READ_MODELS_HISTORY,
    '',
  ];
  return lines.join('\n');
}

export function renderStatsDoc(r: BenchReport): string {
  const lines = [
    '# Statistics benchmark and cache (DO SQLite in workerd)',
    '',
    `Generated by \`scripts/benchmark-read-models.ts\` from the report of \`${r.generatedBy}\` (environment in [read_models.md](read_models.md)). Each user's statistics (limit 10) are computed uncached at asOf = ${r.frozenClock} through the production \`statsWithCache\` (a miss, which stores the body), then requested again 250 ms later: the exact cache may reuse the body only after its indexed EXISTS probes show that no row crossed either window bound (ADR 0004 §5.8). Every listen sits at a half-second, so the 250 ms shift is provably empty and the second request is a hit; the hit must equal a fresh uncached computation at the later asOf.`,
    '',
    '- **Uncached rows read** must stay within the budget `17 × window rows + 4 × limit + 16`, i.e. proportional to the rows in the window, not to the user. Derivation: the totals statement reads the window once through `scrobbles_owner_time` (index entry and table row) into a temporary table that its three aggregates read (5 per window row); each ranking statement reads the window (2), sorts it into its GROUP BY b-tree (at most 2) and fetches at most `limit` display rows by primary key; plus the user row, the cache row and the cache write.',
    '- **Cached**: the rows read and statements of the whole hit, including the visibility check of the user row; "probes" are the statements of the cache check itself (the cache row by primary key plus at most two EXISTS probes on `scrobbles_owner_time`), at most 3, each planned as an indexed SEARCH.',
    '- Cold is the first call on a freshly constructed DO instance; warm is the mean of 3 further uncached computations; cached is the mean of 20 hits.',
    '',
    '| Scale | Window | Window rows | Uncached rows read | Per statement (user, cache, totals, artists, tracks, albums, store) | Budget | Uncached cold / warm ms | Cached rows read | Probes | Cached ms | Equal | Within |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.stats.map(
      (s) =>
        `| ${fmt(s.scale)} | ${s.window} | ${fmt(s.windowRows)} | ${fmt(s.uncached.rowsRead)} | ${s.uncached.perStatement.join(', ')} | ${fmt(s.rowsReadBudget)} | ${ms(s.uncached.coldMs)} / ${ms(s.uncached.warmMs)} | ${s.cached.rowsRead} | ${s.cached.cacheProbes}${s.cached.probesIndexed ? '' : ' (not indexed)'} | ${ms(s.cached.ms)} | ${s.equalsUncached ? 'yes' : 'no'} | ${s.withinBudget ? 'yes' : 'no'} |`,
    ),
    '',
    'Query plans: `worker/test/read/stats-plan.test.ts` pins indexed DID/time searches for every statistics and cache-probe statement over 100 × 1,000 seeded rows, with a negative control that drops the scrobble indexes; `worker/test/acceptance/query-plans.test.ts` (W6-01) covers M6.2.3 `slow_query_detection`.',
    '',
    '## Follow-ups',
    '',
    ...(r.followUps.filter((f) => f.id.startsWith('stats')).length === 0
      ? ['None.']
      : r.followUps
          .filter((f) => f.id.startsWith('stats'))
          .map((f) => `- \`${f.id}\`: ${f.summary} (measured ${ms(f.measured)}, threshold ${ms(f.threshold)})`)),
    '',
    '## Reproduce',
    '',
    ...reproduce(),
    '',
    RUST_STATS_HISTORY,
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI

interface CliArgs {
  paced: boolean;
  out: string;
  docs: boolean;
  render: string | null;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { paced: false, out: DEFAULT_REPORT_PATH, docs: true, render: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--paced') args.paced = true;
    else if (a === '--no-docs') args.docs = false;
    else if (a === '--out' && argv[i + 1] !== undefined) args.out = resolve(argv[++i] as string);
    else if (a === '--render' && argv[i + 1] !== undefined) args.render = resolve(argv[++i] as string);
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

interface VitestJson {
  numTotalTests: number;
  numFailedTests: number;
  testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }>;
}

/** Names of NAMED_TESTS that did not pass in a vitest JSON report. */
export function missingNamedTests(report: VitestJson): string[] {
  const passed = new Set(
    report.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'passed').map((a) => a.title)),
  );
  return NAMED_TESTS.filter((t) => !passed.has(t));
}

function loadReport(path: string): BenchReport {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const errors = reportErrors(value);
  if (errors.length > 0) throw new Error(`${path} is not a valid benchmark report:\n${errors.join('\n')}`);
  return value as BenchReport;
}

function writeDocs(report: BenchReport): void {
  writeFileSync(READ_MODELS_DOC, renderReadModelsDoc(report));
  writeFileSync(STATS_DOC, renderStatsDoc(report));
  console.log(`benchmark: wrote ${relative(REPO_ROOT, READ_MODELS_DOC)} and ${relative(REPO_ROOT, STATS_DOC)}`);
}

export function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.render !== null) {
    writeDocs(loadReport(args.render));
    return 0;
  }
  mkdirSync(dirname(args.out), { recursive: true });
  rmSync(args.out, { force: true });
  const vitestJson = join(dirname(args.out), 'read-models.vitest.json');
  rmSync(vitestJson, { force: true });
  const run = spawnSync(
    'npx',
    [
      'vitest',
      'run',
      '--config',
      'vitest.bench.config.ts',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${vitestJson}`,
    ],
    {
      cwd: join(REPO_ROOT, 'worker'),
      stdio: 'inherit',
      env: { ...process.env, ATMUSIC_BENCH_OUT: args.out, ATMUSIC_BENCH_PACED: args.paced ? '1' : '0' },
    },
  );
  if (run.status !== 0) {
    console.error(`benchmark: vitest exited with status ${run.status ?? run.signal}`);
    return 1;
  }
  const missing = missingNamedTests(JSON.parse(readFileSync(vitestJson, 'utf8')) as VitestJson);
  if (missing.length > 0) {
    console.error(`benchmark: named tests did not pass:\n${missing.join('\n')}`);
    return 1;
  }
  const report = loadReport(args.out);
  console.log(
    `benchmark: ${relative(REPO_ROOT, args.out)} p95 ${report.http.p95Ms} ms (${report.http.errors} errors), passed=${report.passed}`,
  );
  if (args.docs) writeDocs(report);
  return report.passed ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
