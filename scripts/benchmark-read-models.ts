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
// 2. Re-validates the report and writes docs/benchmarks/read_models.md and
//    docs/benchmarks/stats.md from it (unless --no-docs), also when the run
//    failed, so a budget breach is documented; exits 0 only when vitest
//    passed, every named test of the suite passed (vitest JSON reporter) and
//    the report's verdict is passed.
//    `--render` only re-renders the docs from an existing report.
//
// Never contacts anything but the local workerd that vitest starts.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_REPORT_PATH = join(REPO_ROOT, 'work', 'bench', 'read-models.json');
export const READ_MODELS_DOC = join(REPO_ROOT, 'docs', 'benchmarks', 'read_models.md');
export const STATS_DOC = join(REPO_ROOT, 'docs', 'benchmarks', 'stats.md');
export const REPORT_SCHEMA_ID = 'atmusic/read-models-benchmark@2';
/** The interval of `--paced` runs: 10 requests per second. */
export const PACED_INTERVAL_MS = 100;

/** The suite's named tests (docs/planning/workers-waves.json W6-02, budgets per ADR 0004 §15 Q10). */
export const NAMED_TESTS: readonly string[] = [
  'history/feed page statement rows read within ADR Q10 budgets',
  'stats cache hit within ADR Q10 probe budget and equals uncached result',
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
const counts = { type: 'array', items: { type: 'integer', minimum: 1 } } as const;
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
    'budgets',
    'dataset',
    'scales',
    'reads',
    'stats',
    'worstCases',
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
    budgets: {
      type: 'object',
      additionalProperties: false,
      required: [
        'source',
        'scope',
        'history',
        'global',
        'following',
        'followingVisibleEdges',
        'statsProbesAll',
        'statsProbesWindowed',
      ],
      properties: {
        source: { const: 'ADR 0004 §15 Q10' },
        scope: str,
        history: { const: 23 },
        global: { const: 43 },
        following: { const: 89 },
        followingVisibleEdges: { const: 4 },
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
          'rowsRead',
          'indexRowsRead',
          'visibilityRowsRead',
          'budget',
          'budgetRule',
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
          budget: int,
          budgetRule: { enum: ['L+3', '2(L+1)+1', '4(L+1)+1+edges'] },
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
          'expected',
          'observed',
          'uncached',
          'cached',
          'afterVersionBump',
          'rowsReadBudget',
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
            required: [...timing.required, 'perStatement', 'statementBudgets'],
            properties: {
              ...timing.properties,
              perStatement: { type: 'array', items: int },
              statementBudgets: { type: 'array', items: int },
            },
          },
          cached: {
            type: 'object',
            additionalProperties: false,
            required: ['rowsRead', 'probes', 'probeKinds', 'probesIndexed', 'probeBudget', 'withinProbeBudget', 'ms'],
            properties: {
              rowsRead: int,
              probes: { type: 'integer', minimum: 1 },
              probeKinds: {
                type: 'array',
                minItems: 1,
                items: { enum: ['users', 'cache', 'exists', 'other'] },
              },
              probesIndexed: { type: 'boolean' },
              probeBudget: { enum: [3, 4] },
              withinProbeBudget: { type: 'boolean' },
              ms: num,
            },
          },
          afterVersionBump: {
            type: 'object',
            additionalProperties: false,
            required: ['cache', 'equalsUncached'],
            properties: { cache: { enum: ['hit', 'miss', null] }, equalsUncached: { type: 'boolean' } },
          },
          rowsReadBudget: int,
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
          'rowsRead',
          'indexRowsRead',
          'visibilityRowsRead',
          'statements',
          'allStatementsRowsRead',
          'coldMs',
          'warmMs',
          'plan',
          'denseBudget',
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
          rowsRead: int,
          indexRowsRead: int,
          visibilityRowsRead: int,
          statements: int,
          allStatementsRowsRead: int,
          coldMs: num,
          warmMs: num,
          plan: { type: 'array', minItems: 1, items: str },
          denseBudget: int,
          asserted: { const: false },
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
  /** Diagnostic: the same keyset walk without the visibility join. */
  indexRowsRead: number;
  /** Diagnostic: rowsRead - indexRowsRead. */
  visibilityRowsRead: number;
  /** The ADR 0004 §15 Q10 budget of the page statement's rowsRead. */
  budget: number;
  budgetRule: 'L+3' | '2(L+1)+1' | '4(L+1)+1+edges';
  /** Every statement of the call (page statement plus indexing truth); not budgeted. */
  statements: number;
  allStatementsRowsRead: number;
  coldMs: number;
  warmMs: number;
  withinBudget: boolean;
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
  uncached: {
    rowsRead: number;
    statements: number;
    coldMs: number;
    warmMs: number;
    perStatement: number[];
    statementBudgets: number[];
  };
  cached: {
    rowsRead: number;
    probes: number;
    probeKinds: string[];
    probesIndexed: boolean;
    probeBudget: number;
    withinProbeBudget: boolean;
    ms: number;
  };
  afterVersionBump: { cache: 'hit' | 'miss' | null; equalsUncached: boolean };
  rowsReadBudget: number;
  equalsUncached: boolean;
  withinBudget: boolean;
}

export interface WorstCase {
  id: 'following-sparse-followees-first' | 'following-sparse-followees-deep' | 'global-hidden-newest-first';
  scenario: string;
  name: string;
  kind: 'global' | 'following';
  scale: null;
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
  denseBudget: number;
  asserted: false;
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
  budgets: {
    source: string;
    scope: string;
    history: number;
    global: number;
    following: number;
    followingVisibleEdges: number;
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

const FINDINGS = `## Regressions this benchmark found (production fixes accepted by ADR 0004 §15 Q10)

W6-02 found two regressions and fixed them in \`worker/src/do/read/history.ts\` (W3-01) and \`worker/src/do/read/stats.ts\` (W3-02). ADR 0004 §15 Q10 (2026-10-25) **accepted** both fixes into W3-01/W3-02 ownership. Without them, deep pages read O(depth) rows and windowed statistics exceed their rows-read bounds. \`worker/test/read/keyset.test.ts\` covers the \`keysetWhere\` fallback, which keeps the anchor clause when \`last > upper\` or a key is non-ASCII.

- **Deep pages read O(depth) rows.** A cursor carries the traversal anchor (\`upper\`) and the last returned row (\`last\`). With both row-value bounds in the WHERE clause, SQLite used only the anchor as the index range start. It walked and filtered every row between the anchor and \`last\`: 5,023 rows read for a 20-row history page at depth 5,000. The fix: \`keysetWhere\` omits the anchor bound when \`last <= upper\`, which is true of every cursor the server issues. It selects the same rows, and history and both feeds share it.
- **Windowed statistics read the whole user.** The totals statement referenced the window CTE three times. Inlined, SQLite answered its DISTINCT/GROUP BY subqueries from the covering \`scrobbles_stats\` index searched by DID only, so a 7-day window of a 10,000-row user read 20,965 rows. The fix: \`statsStatements\` materializes the window for the totals statement of bounded windows, so rows read are proportional to the window. \`all\` keeps the inlined form, which already reads exactly the user's rows.`;

/** Where each kind of page statement's rows go (the Q10 budget terms), from the measured split. */
const BUDGET_TERMS = {
  history:
    "L + 1 probe rows from `scrobbles_owner_time`, the owner's `users` row once (the visibility join), and on a deep page 1 keyset boundary row that the row-value seek on the DESC index steps over",
  global:
    'L + 1 probe rows from `scrobbles_global_time`, each with one owner-visibility probe (a `users` row by primary key), plus 1 boundary row',
  following:
    "the IN walk reads up to L + 1 rows from each followed account's `scrobbles_owner_time` range before the merge (4 dense followed accounts: 4(L + 1)), plus 1, plus the viewer's visible follow edges",
} as const;

function budgetSection(r: BenchReport): string[] {
  const b = r.budgets;
  const over = r.reads.filter((x) => !x.withinBudget);
  const head = [
    `## Rows-read budgets (${b.source}), page statement only`,
    '',
    `The budgets bound the production **page statement**'s cursor \`rowsRead\` at the default limit L = ${r.limit}. They are hard assertions in \`history/feed page statement rows read within ADR Q10 budgets\`, derived from named constants in the suite. The rest of the call (the indexing-truth reads) is outside the budget. It appears only in the "Whole call" column, and the suite checks that it reads the same number of rows at every scale and depth.`,
    '',
    '| Read | Rule | Budget | Terms |',
    '| --- | --- | --- | --- |',
    `| History | L + 3 | ${b.history} | ${BUDGET_TERMS.history} |`,
    `| Global feed | 2(L + 1) + 1 | ${b.global} | ${BUDGET_TERMS.global} |`,
    `| Following feed (dense data) | 4(L + 1) + 1 + edges | ${b.following} (${b.followingVisibleEdges} visible edges) | ${BUDGET_TERMS.following} |`,
    '',
  ];
  if (over.length === 0) {
    return [...head, `Met: all ${r.reads.length} history and feed page statements are within their budgets.`];
  }
  return [
    ...head,
    `**Not met** for ${over.length} of ${r.reads.length} reads. These reads fail the suite and this report's verdict:`,
    '',
    '| Read | Page | Rows read | Budget | Index walk | Visibility |',
    '| --- | --- | --- | --- | --- | --- |',
    ...over.map(
      (x) =>
        `| ${KIND_LABEL[x.kind]}${x.scale === null ? '' : ` ${fmt(x.scale)}`} | ${x.page} | ${x.rowsRead} | ${x.budget} | ${x.indexRowsRead} | ${x.visibilityRowsRead} |`,
    ),
  ];
}

function worstCaseSection(r: BenchReport): string[] {
  return [
    '## Worst cases (measured and reported, not asserted)',
    '',
    `ADR 0004 §15 Q10 names two worst cases outside the dense-data budgets. The suite measures them in their own DO, so they cannot change the asserted reads. Every page is checked against an independent \`OFFSET\` query over the visible rows before it is measured. The budget shown is the dense-data Q10 budget of the same kind of read, for comparison only; the worst cases do not count toward the verdict. Each one is listed under Follow-ups.`,
    '',
    '| Case | Scenario | Page | Rows read (page statement) | Dense budget | Index walk | Visibility | Whole call | Page statement plan (scrobbles steps; the full plan is in the JSON) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.worstCases.map(
      (w) =>
        `| \`${w.id}\` | ${w.scenario} | ${w.page}${w.page === 'deep' ? ` (${fmt(w.depth)})` : ''} | ${fmt(w.rowsRead)} | ${w.denseBudget} | ${fmt(w.indexRowsRead)} | ${fmt(w.visibilityRowsRead)} | ${w.statements} statements, ${fmt(w.allStatementsRowsRead)} rows | ${w.plan
          .filter((d) => /\bs USING\b|TEMP B-TREE/.test(d))
          .map((d) => `\`${d}\``)
          .join('; ')} |`,
    ),
  ];
}

function probeBudgetSection(r: BenchReport): string[] {
  const b = r.budgets;
  const over = r.stats.filter((x) => !x.cached.withinProbeBudget);
  const head = [
    `## Cache-hit probe budget (${b.source}): at most ${b.statsProbesWindowed} statements for a window, ${b.statsProbesAll} for \`all\``,
    '',
    `The budget counts **every statement of the hit**, and each one must plan as an indexed SEARCH. A windowed hit reads the users row (\`stats_version\` and \`generation\`), the cache row and two EXISTS probes, one per moved window bound: ${b.statsProbesWindowed}. \`all\` has no lower bound, so it needs one EXISTS probe: ${b.statsProbesAll}. The suite asserts this budget as a hard check in \`stats cache hit within ADR Q10 probe budget and equals uncached result\`.`,
    '',
  ];
  if (over.length === 0) {
    return [...head, `Met: all ${r.stats.length} cached hits are within the budget.`];
  }
  const windows = [...new Set(over.map((x) => x.window))];
  return [
    ...head,
    `**Not met** for ${over.length} of ${r.stats.length} cached hits (windows: ${windows.join(', ')}). These hits fail the suite and this report's verdict.`,
  ];
}

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
    `${fmt(d.users)} users × ${fmt(d.rowsPerUser)} scrobbles = ${fmt(d.rows)} active rows, generator seed ${d.seed}, frozen clock ${r.frozenClock}. Each repository is a real signed commit (deterministic fixture keys); its signature is checked with the production \`verifyCommit\` (${d.verifiedCommits} commits), its MST is walked by the production range walker in chunks of at most 2,000 entries (${fmt(d.chunks)} chunks, the largest ${fmt(d.maxChunkEntries)} entries), and every chunk goes through the production \`applySnapshotChunk\` and \`completeSnapshot\` (${d.excluded} exclusions). Per user: ${d.distribution.artistsPerUser} artists × ${d.distribution.rowsPerArtist}, ${d.distribution.tracksPerUser} tracks × ${d.distribution.rowsPerTrack}, ${d.distribution.albumsPerUser} albums × ${d.distribution.rowsPerAlbum}, one listen every ${d.distribution.spacingSeconds} s (user \`a\` offset by \`a\` seconds, as the Rust generator), durations ${d.distribution.durationSeconds.min}–${d.distribution.durationSeconds.max} s from the seeded generator. Row digest (SHA-256) \`${d.digest}\`. Seeding took ${fmt(Math.round(d.seedMs))} ms.`,
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
    `A second user set in its own DO holds one user each with ${r.scales.map((s) => fmt(s.scrobbles)).join(', ')} scrobbles spread over two years, plus a viewer following all four (${fmt(r.scales.reduce((a, s) => a + s.scrobbles, 0))} rows). Deep pages continue a cursor whose anchor is the newest row and whose last row is halfway down. "Rows read" is the production page statement's cursor \`rowsRead\`: the only quantity the ${r.budgets.source} budget bounds (next section). "Whole call" is every statement of the call, the page statement plus the indexing-truth reads. It is reported separately and is not budgeted. "Index" and "visibility" are diagnostics only: the rows the same keyset walk reads without the visibility join (summed per followed account for the following feed), and the rest (owner lookups, follow edges). Cold is the first call on a freshly constructed DO instance (after \`evictDurableObject\`); warm is the mean of 20 repeated calls. Times are the synchronous DO call (CPU-bound: no I/O happens inside it).`,
    '',
    '| Read | Scale | Page | Rows read (page statement) | Budget (rule) | Index | Visibility | Whole call: statements, rows read (not budgeted) | Cold ms | Warm ms | Within |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.reads.map(
      (x) =>
        `| ${KIND_LABEL[x.kind]} | ${x.scale === null ? 'all users' : fmt(x.scale)} | ${x.page}${x.page === 'deep' ? ` (${fmt(x.depth)})` : ''} | ${x.rowsRead} | ${x.budget} (${x.budgetRule}) | ${x.indexRowsRead} | ${x.visibilityRowsRead} | ${x.statements}, ${x.allStatementsRowsRead} | ${ms(x.coldMs)} | ${ms(x.warmMs)} | ${x.withinBudget ? 'yes' : 'no'} |`,
    ),
    '',
    'Statistics are in [stats.md](stats.md).',
    '',
    ...budgetSection(r),
    '',
    ...worstCaseSection(r),
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
    `Generated by \`scripts/benchmark-read-models.ts\` from the report of \`${r.generatedBy}\` (environment in [read_models.md](read_models.md)). Each user's statistics (limit 10) are computed uncached at asOf = ${r.frozenClock} through the production \`statsWithCache\` (a miss, which stores the body), then requested again 250 ms later: the exact cache may reuse the body only after its indexed EXISTS probes show that no row crossed either window bound (ADR 0004 §5.8). Every listen sits at a half-second, so the 250 ms shift is provably empty and the second request is a hit; the hit must equal a fresh uncached computation at the later asOf. Then the production \`bumpStatsVersion\` (what every scrobble insert, change or delete runs) invalidates the body, and the next request must be a miss that again equals that computation. The miss is checked against an oracle computed in JavaScript from the generated records, not from SQL: window rows, distinct artists and tracks, and the top-10 counts of artists, tracks and albums.`,
    '',
    "- **Uncached rows read**: each statement of the miss has its own bound, computed from the window rows W and the window's group counts G. The generator supplies both, not SQL. The bound per statement, in order:",
    '  - users row by primary key: 1. Cache row by primary key: at most 1.',
    "  - totals: at most 5W + 6. A bounded window is read once through `scrobbles_owner_time` (index entry and table row, 2W) into a materialized temporary table that the three aggregates read (3W), with one visibility join (the owner's `users` row and the suppression probe, 2 rows). `all` inlines the window three times through the covering `scrobbles_stats` index (3W) with three visibility joins (6 rows).",
    '  - each ranking (artists, tracks, albums): at most 2W + 2G + 2. The window walk reads an index entry and a table row per row, each group fetches one display row by primary key, and the visibility join adds 2.',
    '  - the cache store: at most 2.',
    '  Every term is linear in the window, so a miss never reads the user\'s rows outside the window. "Budget" in the table is the sum of the per-statement bounds.',
    `- **Cached**: the ${r.budgets.source} budget counts every statement of the hit: at most ${r.budgets.statsProbesWindowed} for a window and ${r.budgets.statsProbesAll} for \`all\` (next section). "Cached rows read" is the sum over those statements.`,
    '- Cold is the first call on a freshly constructed DO instance; warm is the mean of 3 further uncached computations; cached is the mean of 20 hits.',
    '',
    '| Scale | Window | Window rows | Uncached rows read | Per statement (user, cache, totals, artists, tracks, albums, store) | Per-statement bounds | Budget | Uncached cold / warm ms | Cached rows read | Probes (budget) | Cached ms | Hit equal | After version bump | Within |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.stats.map(
      (s) =>
        `| ${fmt(s.scale)} | ${s.window} | ${fmt(s.windowRows)} | ${fmt(s.uncached.rowsRead)} | ${s.uncached.perStatement.join(', ')} | ${s.uncached.statementBudgets.join(', ')} | ${fmt(s.rowsReadBudget)} | ${ms(s.uncached.coldMs)} / ${ms(s.uncached.warmMs)} | ${s.cached.rowsRead} | ${s.cached.probes} of ${s.cached.probeBudget} (${s.cached.probeKinds.join(', ')})${s.cached.probesIndexed ? '' : ' (not indexed)'}${s.cached.withinProbeBudget ? '' : ' **over**'} | ${ms(s.cached.ms)} | ${s.equalsUncached ? 'yes' : 'no'} | ${s.afterVersionBump.cache ?? 'none'}, ${s.afterVersionBump.equalsUncached ? 'equal' : 'not equal'} | ${s.withinBudget ? 'yes' : 'no'} |`,
    ),
    '',
    ...probeBudgetSection(r),
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
  const missing = existsSync(vitestJson)
    ? missingNamedTests(JSON.parse(readFileSync(vitestJson, 'utf8')) as VitestJson)
    : [...NAMED_TESTS];
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
