// Read-model benchmark runner (W6-02; ported to the Node host by N4-03:
// ADR 0005 §15.1, §15.3). It supersedes scripts/benchmark_read_models.py,
// whose Rust numbers stay in the docs as history.
//
// Usage:
//   npx tsx scripts/benchmark-read-models.ts [--paced] [--out <report.json>] [--no-docs]
//   npx tsx scripts/benchmark-read-models.ts --render <report.json>
//
// 1. Runs `vitest run --config vitest.bench.config.ts` in worker/: the suite
//    worker/test/bench/read-models.bench.test.ts seeds node:sqlite through the
//    production verify + apply path, measures synchronous module time (p50 and
//    p95 of repeated calls), the query plan of every page and statistics
//    statement, and HTTP latency through the production Node composition,
//    then validates its report against BENCH_REPORT_SCHEMA (handed to it with
//    vitest `provide`, worker/vitest.bench.config.ts) and writes it to
//    `ATMUSIC_BENCH_OUT` (default work/bench/read-models.json).
//    node:sqlite has no rows-read counter, so the ADR 0004 §15 Q10 rows-read
//    budgets are re-derived as EXPLAIN QUERY PLAN assertions on SQLite 3.54.1
//    (ADR 0005 §15.3); timings are reported, and only the HTTP p95 target is
//    a verdict.
//    `--paced` spaces the HTTP requests 100 ms apart (10 requests/s: a 30 s
//    warmup of 300 requests, then 600 measured requests over 60 s), as M6.2.3
//    specifies. Without it (the repository gate) the same requests run back
//    to back and nothing sleeps.
// 2. Re-validates the report and writes docs/benchmarks/read_models.md and
//    docs/benchmarks/stats.md from it (unless --no-docs), also when the run
//    failed, so a failure is documented; exits 0 only when vitest passed,
//    every named test of the suite passed (vitest JSON reporter) and the
//    report's verdict is passed.
//    `--render` only re-renders the docs from an existing report.
//
// Never contacts anything: the suite runs in-process on the loopback address.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_REPORT_PATH = join(REPO_ROOT, 'work', 'bench', 'read-models.json');
export const READ_MODELS_DOC = join(REPO_ROOT, 'docs', 'benchmarks', 'read_models.md');
export const STATS_DOC = join(REPO_ROOT, 'docs', 'benchmarks', 'stats.md');
export const REPORT_SCHEMA_ID = 'atmusic/read-models-benchmark@3';
/** The interval of `--paced` runs: 10 requests per second. */
export const PACED_INTERVAL_MS = 100;
/** The SQLite the plans are pinned on (ADR 0005 §0 D1, §15.3). */
export const PINNED_SQLITE = '3.54.1';

export const BENCH_TEST_FILE = 'worker/test/bench/read-models.bench.test.ts';

/** The W6-02 titles the Node port kept (docs/verification/node-port-inventory.json). */
const KEPT_TESTS: readonly string[] = [
  'stats cache hit within ADR Q10 probe budget and equals uncached result',
  'benchmark JSON is produced and schema-valid',
  'seeded generator yields exactly 100,000 valid active rows with the documented per-user distribution',
  '600 measured requests with zero errors report p95 and check it against the target',
];

/** The titles docs/planning/node-waves.json declares for the suite file. */
export function nodeWaveTests(
  nodeWaves: unknown = readJson(join(REPO_ROOT, 'docs', 'planning', 'node-waves.json')),
): string[] {
  const waves = nodeWaves as Array<{ packages: Array<{ tests: string[] }> }>;
  return waves
    .flatMap((w) => w.packages.flatMap((p) => p.tests))
    .filter((id) => id.startsWith(`${BENCH_TEST_FILE} › `))
    .map((id) => id.slice(BENCH_TEST_FILE.length + 3));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** The suite's named tests: the kept W6-02 titles and those node-waves.json declares (N4-03). */
export function namedTests(): string[] {
  return [...KEPT_TESTS, ...nodeWaveTests()];
}

// ---------------------------------------------------------------------------
// Report schema

const int = { type: 'integer', minimum: 0 } as const;
const num = { type: 'number', minimum: 0 } as const;
const str = { type: 'string', minLength: 1 } as const;
const nullableStr = { type: ['string', 'null'] } as const;
const counts = { type: 'array', items: { type: 'integer', minimum: 1 } } as const;
const plan = { type: 'array', minItems: 1, items: str } as const;
const WINDOWS = ['all', '7d', '30d', '365d'] as const;

/** Nearest-rank p50 and p95 of `runs` timed calls (ms). */
const percentiles = {
  type: 'object',
  additionalProperties: false,
  required: ['runs', 'p50Ms', 'p95Ms'],
  properties: { runs: { type: 'integer', minimum: 1 }, p50Ms: num, p95Ms: num },
} as const;

const timing = {
  type: 'object',
  additionalProperties: false,
  required: ['statements', 'coldMs', 'runs', 'p50Ms', 'p95Ms'],
  properties: { statements: int, coldMs: num, ...percentiles.properties },
} as const;

export const BENCH_REPORT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://atmusic.invalid/schemas/read-models-benchmark-3.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'generatedBy',
    'frozenClock',
    'environment',
    'limit',
    'plans',
    'dataset',
    'scales',
    'reads',
    'stats',
    'worstCases',
    'timings',
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
        'sqlite',
        'platform',
        'arch',
        'osRelease',
        'cpuModel',
        'logicalCpus',
        'totalMemoryBytes',
        'cgroupCpuMax',
        'cgroupMemoryMax',
        'timerIntegerMs',
      ],
      properties: {
        runner: str,
        node: { type: 'string', pattern: '^v[0-9]+\\.[0-9]+\\.[0-9]+' },
        sqlite: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' },
        platform: str,
        arch: str,
        osRelease: str,
        cpuModel: str,
        logicalCpus: { type: 'integer', minimum: 1 },
        totalMemoryBytes: { type: 'integer', minimum: 1 },
        cgroupCpuMax: nullableStr,
        cgroupMemoryMax: nullableStr,
        timerIntegerMs: { type: 'boolean' },
      },
    },
    limit: { const: 20 },
    plans: {
      type: 'object',
      additionalProperties: false,
      required: [
        'source',
        'sqlite',
        'history',
        'global',
        'following',
        'stats',
        'statsProbesAll',
        'statsProbesWindowed',
      ],
      properties: {
        source: { const: 'ADR 0005 §15.3 (ADR 0004 §15 Q10 re-derived as query plans)' },
        sqlite: { const: PINNED_SQLITE },
        history: { const: 'SEARCH scrobbles_owner_time, no SCAN, no temporary B-tree' },
        global: { const: 'scrobbles_global_time in order, no SCAN, no temporary B-tree' },
        following: { const: 'SEARCH scrobbles_owner_time per followee and follows_actor_subject, no SCAN' },
        stats: { const: 'every scrobbles statement SEARCHes scrobbles_owner_time or scrobbles_stats, no SCAN' },
        statsProbesAll: { const: 3 },
        statsProbesWindowed: { const: 4 },
      },
    },
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
          'statements',
          'coldMs',
          'runs',
          'p50Ms',
          'p95Ms',
          'plan',
          'indexes',
          'planIndexed',
        ],
        properties: {
          name: str,
          kind: { enum: ['history', 'global', 'following'] },
          scale: { type: ['integer', 'null'] },
          page: { enum: ['first', 'deep'] },
          depth: int,
          rowsReturned: int,
          statements: int,
          coldMs: num,
          ...percentiles.properties,
          plan,
          indexes: { type: 'array', items: str },
          planIndexed: { type: 'boolean' },
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
          'expected',
          'observed',
          'uncached',
          'cached',
          'afterVersionBump',
          'equalsUncached',
          'withinBudget',
        ],
        properties: {
          scale: { enum: [1000, 10000, 50000, 100000] },
          window: { enum: WINDOWS },
          windowRows: int,
          expected: {
            type: 'object',
            additionalProperties: false,
            required: [
              'windowRows',
              'artistGroups',
              'trackGroups',
              'albumGroups',
              'topArtistCounts',
              'topTrackCounts',
              'topAlbumCounts',
            ],
            properties: {
              windowRows: int,
              artistGroups: int,
              trackGroups: int,
              albumGroups: int,
              topArtistCounts: counts,
              topTrackCounts: counts,
              topAlbumCounts: counts,
            },
          },
          observed: {
            type: 'object',
            additionalProperties: false,
            required: [
              'windowRows',
              'totalScrobbles',
              'distinctArtists',
              'distinctTracks',
              'topArtistCounts',
              'topTrackCounts',
              'topAlbumCounts',
            ],
            properties: {
              windowRows: int,
              totalScrobbles: int,
              distinctArtists: int,
              distinctTracks: int,
              topArtistCounts: counts,
              topTrackCounts: counts,
              topAlbumCounts: counts,
            },
          },
          uncached: {
            ...timing,
            required: [...timing.required, 'scrobblesPlans', 'plansIndexed'],
            properties: {
              ...timing.properties,
              scrobblesPlans: { type: 'array', minItems: 1, items: plan },
              plansIndexed: { type: 'boolean' },
            },
          },
          cached: {
            type: 'object',
            additionalProperties: false,
            required: [
              'probes',
              'probeKinds',
              'probesIndexed',
              'probeBudget',
              'withinProbeBudget',
              'runs',
              'p50Ms',
              'p95Ms',
            ],
            properties: {
              probes: { type: 'integer', minimum: 1 },
              probeKinds: {
                type: 'array',
                minItems: 1,
                items: { enum: ['users', 'cache', 'exists', 'other'] },
              },
              probesIndexed: { type: 'boolean' },
              probeBudget: { enum: [3, 4] },
              withinProbeBudget: { type: 'boolean' },
              ...percentiles.properties,
            },
          },
          afterVersionBump: {
            type: 'object',
            additionalProperties: false,
            required: ['cache', 'equalsUncached'],
            properties: { cache: { enum: ['hit', 'miss', null] }, equalsUncached: { type: 'boolean' } },
          },
          equalsUncached: { type: 'boolean' },
          withinBudget: { type: 'boolean' },
        },
      },
    },
    worstCases: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'scenario',
          'name',
          'kind',
          'scale',
          'page',
          'depth',
          'rowsReturned',
          'statements',
          'coldMs',
          'runs',
          'p50Ms',
          'p95Ms',
          'plan',
          'denseP50Ms',
          'asserted',
        ],
        properties: {
          id: {
            enum: ['following-sparse-followees-first', 'following-sparse-followees-deep', 'global-hidden-newest-first'],
          },
          scenario: str,
          name: str,
          kind: { enum: ['global', 'following'] },
          scale: { type: 'null' },
          page: { enum: ['first', 'deep'] },
          depth: int,
          rowsReturned: int,
          statements: int,
          coldMs: num,
          ...percentiles.properties,
          plan,
          denseP50Ms: num,
          asserted: { const: false },
        },
      },
    },
    timings: {
      type: 'object',
      additionalProperties: false,
      required: ['history', 'feed', 'stats', 'statsCached'],
      properties: { history: percentiles, feed: percentiles, stats: percentiles, statsCached: percentiles },
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

export interface Percentiles {
  runs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface ReadMeasurement extends Percentiles {
  name: string;
  kind: 'history' | 'global' | 'following';
  scale: number | null;
  page: 'first' | 'deep';
  depth: number;
  rowsReturned: number;
  /** Every statement of the call (page statement plus indexing truth). */
  statements: number;
  coldMs: number;
  /** EXPLAIN QUERY PLAN of the page statement. */
  plan: string[];
  /** Indexes the plan names. */
  indexes: string[];
  planIndexed: boolean;
}

interface WindowCounts {
  topArtistCounts: number[];
  topTrackCounts: number[];
  topAlbumCounts: number[];
}

export interface StatsMeasurement {
  scale: number;
  window: (typeof WINDOWS)[number];
  windowRows: number;
  expected: WindowCounts & { windowRows: number; artistGroups: number; trackGroups: number; albumGroups: number };
  observed: WindowCounts & {
    windowRows: number;
    totalScrobbles: number;
    distinctArtists: number;
    distinctTracks: number;
  };
  uncached: Percentiles & {
    statements: number;
    coldMs: number;
    /** EXPLAIN QUERY PLAN of every statement of the miss that reads scrobbles. */
    scrobblesPlans: string[][];
    plansIndexed: boolean;
  };
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

export interface WorstCase extends Percentiles {
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
  /** p50 of the same kind of read, first page, on the dense scale set (for comparison only). */
  denseP50Ms: number;
  asserted: false;
}

export interface BenchReport {
  schema: typeof REPORT_SCHEMA_ID;
  generatedBy: string;
  frozenClock: string;
  environment: {
    runner: string;
    node: string;
    sqlite: string;
    platform: string;
    arch: string;
    osRelease: string;
    cpuModel: string;
    logicalCpus: number;
    totalMemoryBytes: number;
    cgroupCpuMax: string | null;
    cgroupMemoryMax: string | null;
    timerIntegerMs: boolean;
  };
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

/** AJV errors for `value` against BENCH_REPORT_SCHEMA; empty when valid. */
export function reportErrors(value: unknown): string[] {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(BENCH_REPORT_SCHEMA);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

/** The host facts the report's environment records (besides node, sqlite and the timer resolution). */
export function hostFacts(readFile: (path: string) => string | null): {
  platform: string;
  arch: string;
  osRelease: string;
  cpuModel: string;
  logicalCpus: number;
  totalMemoryBytes: number;
  cgroupCpuMax: string | null;
  cgroupMemoryMax: string | null;
} {
  return {
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpuModel: cpus()[0]?.model.trim() || 'unknown',
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    cgroupCpuMax: readFile('/sys/fs/cgroup/cpu.max'),
    cgroupMemoryMax: readFile('/sys/fs/cgroup/memory.max'),
  };
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
    `| Node / SQLite | ${e.node} / ${e.sqlite} |`,
    `| Host | ${e.platform} ${e.arch} ${e.osRelease}; ${e.cpuModel}; ${e.logicalCpus} logical CPUs; ${fmt(e.totalMemoryBytes)} bytes RAM |`,
    `| cgroup cpu.max / memory.max | ${e.cgroupCpuMax ?? 'not present'} / ${e.cgroupMemoryMax ?? 'not present'} |`,
    `| Timer | ${e.timerIntegerMs ? 'integer milliseconds' : 'sub-millisecond (performance.now)'} |`,
  ];
}

function planSection(r: BenchReport): string[] {
  const p = r.plans;
  const off = r.reads.filter((x) => !x.planIndexed);
  return [
    `## Query plans (${p.source}), SQLite ${p.sqlite}`,
    '',
    'node:sqlite reports no rows read, so the ADR 0004 §15 Q10 rows-read budgets are re-derived as EXPLAIN QUERY PLAN pins on the SQLite the Node host runs. They are hard assertions in `the read-model bench records p50 and p95 for history, feed and stats on node:sqlite and asserts their query plans`; timings are reported, never asserted.',
    '',
    '| Read | Required plan |',
    '| --- | --- |',
    `| History | ${p.history} |`,
    `| Global feed | ${p.global} |`,
    `| Following feed | ${p.following} |`,
    `| Statistics (uncached) | ${p.stats} |`,
    `| Statistics (cached hit) | at most ${p.statsProbesWindowed} indexed probes for a window, ${p.statsProbesAll} for \`all\` |`,
    '',
    off.length === 0
      ? `Met: all ${r.reads.length} history and feed page statements plan as required.`
      : `**Not met** for ${off.length} of ${r.reads.length} reads: ${off.map((x) => x.name).join(', ')}.`,
  ];
}

function worstCaseSection(r: BenchReport): string[] {
  return [
    '## Worst cases (measured and reported, not asserted)',
    '',
    'ADR 0004 §15 Q10 names two worst cases outside the dense data. The suite measures them on their own database, so they cannot change the asserted reads. Every page is checked against an independent `OFFSET` query over the visible rows before it is timed; the dense p50 is the same kind of read, first page, on the dense scale set, for comparison only. Each one is listed under Follow-ups.',
    '',
    '| Case | Scenario | Page | p50 / p95 ms | Dense p50 ms | Page statement plan (scrobbles steps; the full plan is in the JSON) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.worstCases.map(
      (w) =>
        `| \`${w.id}\` | ${w.scenario} | ${w.page}${w.page === 'deep' ? ` (${fmt(w.depth)})` : ''} | ${ms(w.p50Ms)} / ${ms(w.p95Ms)} | ${ms(w.denseP50Ms)} | ${w.plan
          .filter((d) => /\bs USING\b|TEMP B-TREE/.test(d))
          .map((d) => `\`${d}\``)
          .join('; ')} |`,
    ),
  ];
}

function probeBudgetSection(r: BenchReport): string[] {
  const p = r.plans;
  const over = r.stats.filter((x) => !x.cached.withinProbeBudget);
  return [
    `## Cache-hit probe budget: at most ${p.statsProbesWindowed} statements for a window, ${p.statsProbesAll} for \`all\``,
    '',
    `The budget counts **every statement of the hit**, and each one must plan as an indexed SEARCH. A windowed hit reads the users row (\`stats_version\` and \`generation\`), the cache row and two EXISTS probes, one per moved window bound: ${p.statsProbesWindowed}. \`all\` has no lower bound, so it needs one EXISTS probe: ${p.statsProbesAll}. The suite asserts it in \`stats cache hit within ADR Q10 probe budget and equals uncached result\`.`,
    '',
    over.length === 0
      ? `Met: all ${r.stats.length} cached hits are within the budget.`
      : `**Not met** for ${over.length} of ${r.stats.length} cached hits.`,
  ];
}

const RUST_READ_MODELS_HISTORY = `## History: Rust candidate (superseded, kept for reference)

The final Linux x86_64 musl backend candidate was measured on 2026-10-06 UTC. Artifact SHA256: \`89ec2297963533f98b8fefde4e300b9f196e6e22ea5c5148133c75b2190f0777\`. It ran 100 users × 1,000 records in a 2-CPU / 2 GiB container: 30 s warmup at a nominal 10 requests/s with 0 errors, then 600 measured requests (alternating history and global feed, \`limit=20\`) over 60 s with 0 errors, p95 9.568 ms and median 2.846 ms against the 300 ms target. History and feed plans used \`scrobbles_owner_time\` and \`scrobbles_global_time\`. The sanitized result is [read_models.json](read_models.json), produced by \`scripts/benchmark_read_models.py\` and checked by \`scripts/test_benchmark.py\`.`;

const RUST_STATS_HISTORY = `## History: Rust candidate (superseded, kept for reference)

\`cargo test --locked -p atmusic-server --test stats_mutations\` ran \`delete_effect\`, \`update_artist\` and \`query_plan\` against isolated SQLite databases: fixed expected totals and rankings from \`docs/planning/TESTING.md\`, and for 100 DIDs × 1,000 signed records the captured production statistics SQL of all four windows planned as indexed DID/time searches, with a negative control that dropped the scrobble indexes in the owned temporary database and saw the global scan fail the check.`;

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
  const t = r.timings;
  const lines = [
    '# Read-model benchmark (node:sqlite on the Node host)',
    '',
    `Generated by \`scripts/benchmark-read-models.ts\` from the report of \`${r.generatedBy}\`. Result: **${r.passed ? 'passed' : 'failed'}**. Queries run on node:sqlite (SQLite ${r.environment.sqlite}) in the Node process that serves them (ADR 0005); the index plan is the reproducible quantity and is asserted, timings are recorded beside it. No network is involved.`,
    '',
    '## Environment',
    '',
    ...environmentRows(r),
    '',
    '## Dataset (M6.2.3 `benchmark_dataset`)',
    '',
    `${fmt(d.users)} users × ${fmt(d.rowsPerUser)} scrobbles = ${fmt(d.rows)} active rows, generator seed ${d.seed}, frozen clock ${r.frozenClock}. Each repository is a real signed commit (deterministic fixture keys); its signature is checked with the production \`verifyCommit\` (${d.verifiedCommits} commits), its MST is walked by the production range walker in chunks of at most 2,000 entries (${fmt(d.chunks)} chunks, the largest ${fmt(d.maxChunkEntries)} entries), and every chunk goes through the production \`applySnapshotChunk\` and \`completeSnapshot\` (${d.excluded} exclusions). Per user: ${d.distribution.artistsPerUser} artists × ${d.distribution.rowsPerArtist}, ${d.distribution.tracksPerUser} tracks × ${d.distribution.rowsPerTrack}, ${d.distribution.albumsPerUser} albums × ${d.distribution.rowsPerAlbum}, one listen every ${d.distribution.spacingSeconds} s, durations ${d.distribution.durationSeconds.min}–${d.distribution.durationSeconds.max} s from the seeded generator. Row digest (SHA-256) \`${d.digest}\`. Seeding took ${fmt(Math.round(d.seedMs))} ms.`,
    '',
    '## HTTP latency (M6.2.3 `benchmark_results`)',
    '',
    '| Measurement | Result |',
    '| --- | --- |',
    '| Path | HTTP bridge on 127.0.0.1:0 → production dispatcher and route table → IndexCore → node:sqlite |',
    `| Requests | ${h.endpoints.map((e) => `\`${e}\``).join(' alternating with ')}; every response must be 200 with 20 items and match the OpenAPI \`ScrobblePage\` schema |`,
    `| Pacing | ${h.paced ? `${h.intervalMs} ms between request starts (${1000 / h.intervalMs} requests/s)` : 'back to back (no pacing; the repository gate never sleeps)'} |`,
    `| Warmup | ${h.warmupRequests} requests, ${h.warmupErrors} errors (excluded from the latencies) |`,
    `| Measured | ${h.measuredRequests} requests in ${fmt(Math.round(h.elapsedMs))} ms, ${h.errors} errors |`,
    `| p95 (nearest rank ${h.p95Rank} of ${h.measuredRequests}) | ${ms(h.p95Ms)} ms; target below ${h.targetMs} ms |`,
    `| Mean / median / p99 / max | ${ms(h.meanMs)} / ${ms(h.p50Ms)} / ${ms(h.p99Ms)} / ${ms(h.maxMs)} ms |`,
    `| Result | ${h.passed ? 'passed' : 'failed'} |`,
    '',
    '## Module time per page (limit 20)',
    '',
    `A second user set holds one user each with ${r.scales.map((s) => fmt(s.scrobbles)).join(', ')} scrobbles spread over two years, plus a viewer following all four (${fmt(r.scales.reduce((a, s) => a + s.scrobbles, 0))} rows). Deep pages continue a cursor whose anchor is the newest row and whose last row is halfway down. Cold is the first call after the database file was closed and reopened; p50 and p95 are nearest ranks over repeated calls of the synchronous module (no I/O happens inside it). All history pages: p50 ${ms(t.history.p50Ms)} ms, p95 ${ms(t.history.p95Ms)} ms (${t.history.runs} calls); all feed pages: p50 ${ms(t.feed.p50Ms)} ms, p95 ${ms(t.feed.p95Ms)} ms (${t.feed.runs} calls).`,
    '',
    '| Read | Scale | Page | Statements | Cold ms | p50 ms | p95 ms | Indexes in the page plan | Plan as required |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.reads.map(
      (x) =>
        `| ${KIND_LABEL[x.kind]} | ${x.scale === null ? 'all users' : fmt(x.scale)} | ${x.page}${x.page === 'deep' ? ` (${fmt(x.depth)})` : ''} | ${x.statements} | ${ms(x.coldMs)} | ${ms(x.p50Ms)} | ${ms(x.p95Ms)} | ${x.indexes.map((i) => `\`${i}\``).join(', ')} | ${x.planIndexed ? 'yes' : 'no'} |`,
    ),
    '',
    'Statistics are in [stats.md](stats.md).',
    '',
    ...planSection(r),
    '',
    ...worstCaseSection(r),
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
  const t = r.timings;
  const lines = [
    '# Statistics benchmark and cache (node:sqlite on the Node host)',
    '',
    `Generated by \`scripts/benchmark-read-models.ts\` from the report of \`${r.generatedBy}\` (environment in [read_models.md](read_models.md)). Each user's statistics (limit 10) are computed uncached at asOf = ${r.frozenClock} through the production \`statsWithCache\` (a miss, which stores the body), then requested again 250 ms later: the exact cache may reuse the body only after its indexed EXISTS probes show that no row crossed either window bound (ADR 0004 §5.8). Every listen sits at a half-second, so the 250 ms shift is provably empty and the second request is a hit; the hit must equal a fresh uncached computation at the later asOf. Then the production \`bumpStatsVersion\` invalidates the body, and the next request must be a miss that again equals that computation. The miss is checked against an oracle computed in JavaScript from the generated records, not from SQL.`,
    '',
    `Every uncached statement that reads scrobbles must SEARCH \`scrobbles_owner_time\` or \`scrobbles_stats\` (never SCAN scrobbles) on SQLite ${r.plans.sqlite}. Uncached over all scales and windows: p50 ${ms(t.stats.p50Ms)} ms, p95 ${ms(t.stats.p95Ms)} ms (${t.stats.runs} calls); cached hits: p50 ${ms(t.statsCached.p50Ms)} ms, p95 ${ms(t.statsCached.p95Ms)} ms (${t.statsCached.runs} calls).`,
    '',
    '| Scale | Window | Window rows | Statements | Uncached cold / p50 / p95 ms | Plans indexed | Probes (budget) | Cached p50 / p95 ms | Hit equal | After version bump | Within |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.stats.map(
      (s) =>
        `| ${fmt(s.scale)} | ${s.window} | ${fmt(s.windowRows)} | ${s.uncached.statements} | ${ms(s.uncached.coldMs)} / ${ms(s.uncached.p50Ms)} / ${ms(s.uncached.p95Ms)} | ${s.uncached.plansIndexed ? 'yes' : 'no'} | ${s.cached.probes} of ${s.cached.probeBudget} (${s.cached.probeKinds.join(', ')})${s.cached.probesIndexed ? '' : ' (not indexed)'}${s.cached.withinProbeBudget ? '' : ' **over**'} | ${ms(s.cached.p50Ms)} / ${ms(s.cached.p95Ms)} | ${s.equalsUncached ? 'yes' : 'no'} | ${s.afterVersionBump.cache ?? 'none'}, ${s.afterVersionBump.equalsUncached ? 'equal' : 'not equal'} | ${s.withinBudget ? 'yes' : 'no'} |`,
    ),
    '',
    ...probeBudgetSection(r),
    '',
    'Query plans: `worker/test/read/stats-plan.test.ts` pins indexed DID/time searches for every statistics and cache-probe statement over 100 × 1,000 seeded rows, with a negative control that drops the scrobble indexes; `worker/test/acceptance/query-plans.test.ts` covers M6.2.3 `slow_query_detection`.',
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

/** Names of the named tests that did not pass in a vitest JSON report. */
export function missingNamedTests(report: VitestJson, named: readonly string[] = namedTests()): string[] {
  const passed = new Set(
    report.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'passed').map((a) => a.title)),
  );
  return named.filter((t) => !passed.has(t));
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
  const missing = existsSync(vitestJson)
    ? missingNamedTests(JSON.parse(readFileSync(vitestJson, 'utf8')) as VitestJson)
    : namedTests();
  // A failing run still documents what it measured: a valid report is
  // rendered (its verdict says failed), and the exit status stays nonzero.
  const report = existsSync(args.out) ? loadReport(args.out) : null;
  if (report !== null) {
    console.log(
      `benchmark: ${relative(REPO_ROOT, args.out)} p95 ${report.http.p95Ms} ms (${report.http.errors} errors), passed=${report.passed}`,
    );
    if (args.docs) writeDocs(report);
  } else {
    console.error(`benchmark: no report at ${relative(REPO_ROOT, args.out)}`);
  }
  if (run.status !== 0) console.error(`benchmark: vitest exited with status ${run.status ?? run.signal}`);
  if (missing.length > 0) console.error(`benchmark: named tests did not pass:\n${missing.join('\n')}`);
  return run.status === 0 && missing.length === 0 && report?.passed === true ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
