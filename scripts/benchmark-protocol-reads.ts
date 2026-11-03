// N5-02 protocol-read benchmark report renderer. The bench suite that measures
// these reads will emit this receipt; this runner validates it and renders the
// durable Markdown report.
//
// Usage:
//   npx tsx scripts/benchmark-protocol-reads.ts <receipt.json> [--out <report.json>] [--no-docs]
//   npx tsx scripts/benchmark-protocol-reads.ts --render <receipt.json>
//
// Receipt schema (atmusic/protocol-reads-benchmark@2): {schema, generatedBy,
// generatedAt, dataset:{listens,seed,clock,applyPathRecords,operations}, plans:{...},
// reads:{...}. Every plan preserves executed SQL beside EXPLAIN rows so alias
// scans can be rejected without mistaking CTE scans for scrobbles table scans.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPORT_SCHEMA_ID = 'atmusic/protocol-reads-benchmark@2';
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DOC = resolve(REPO_ROOT, 'docs/benchmarks/node-protocol-reads.md');
const names = ['topTracks', 'recentTracksPage500', 'listenbrainzAllTime', 'listeningActivityYear'] as const;
export type Timing = { runs: number; p50Ms: number; p95Ms: number };
export interface QueryPlanStatement {
  sql: string;
  details: string[];
}
export interface ProtocolReadsReport {
  schema: typeof REPORT_SCHEMA_ID;
  generatedBy: string;
  generatedAt: string;
  dataset: {
    listens: number;
    seed: number;
    clock: string;
    applyPathRecords: number;
    operations: {
      total: number;
      scrobbleCreateSucceeded: number;
      scrobbleDelete: {
        queued: number;
        running: number;
        blocked: number;
        failed: number;
        succeededMatchingCid: number;
        succeededStaleCid: number;
      };
      visibleScrobbles: number;
      hiddenScrobbles: number;
    };
  };
  plans: {
    source: string;
    topTracks: QueryPlanStatement[];
    recentTracks: QueryPlanStatement[];
    listenbrainzAllTime: QueryPlanStatement[];
    listeningActivityYear: QueryPlanStatement[];
  };
  reads: {
    topTracks: { cached: Timing; uncached: Timing };
    recentTracksPage500: Timing;
    listenbrainzAllTime: Timing;
    listeningActivityYear: Timing;
  };
}

function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const SQL_KEYWORDS = new Set([
  'AS',
  'ON',
  'WHERE',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'CROSS',
  'GROUP',
  'ORDER',
  'LIMIT',
  'UNION',
  'SET',
  'USING',
  'NATURAL',
  'HAVING',
  'EXCEPT',
  'INTERSECT',
]);
function scrobblesAliases(sql: string): string[] {
  const aliases: string[] = [];
  const pattern = /\b(?:FROM|JOIN)\s+scrobbles(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  for (const match of sql.matchAll(pattern)) {
    const candidate = match[1];
    aliases.push(candidate === undefined || SQL_KEYWORDS.has(candidate.toUpperCase()) ? 'scrobbles' : candidate);
  }
  return aliases;
}

/** Validate the executed scrobbles statement against its actual EXPLAIN rows. */
export function validatePlanStatement(v: unknown): asserts v is QueryPlanStatement {
  if (
    !record(v) ||
    typeof v.sql !== 'string' ||
    !Array.isArray(v.details) ||
    v.details.length === 0 ||
    !v.details.every((x) => typeof x === 'string' && x.length > 0)
  ) {
    throw Error('invalid query plan statement');
  }
  const aliases = scrobblesAliases(v.sql);
  if (aliases.length === 0) throw Error('query plan statement does not reference scrobbles');
  const details = v.details as string[];
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (details.some((detail) => new RegExp(`\\bSCAN\\s+${escaped}(?:\\s|$)`, 'i').test(detail))) {
      throw Error(`query plan scans scrobbles alias ${alias}`);
    }
  }
  const driver = aliases[0]!;
  const escapedDriver = driver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    !details.some((detail) =>
      new RegExp(
        `\\bSEARCH\\s+${escapedDriver}\\s+USING\\s+(?:COVERING\\s+)?INDEX\\s+scrobbles_(?:stats|owner_time)\\b`,
        'i',
      ).test(detail),
    )
  ) {
    throw Error(`query plan does not use scrobbles_stats or scrobbles_owner_time for ${driver}`);
  }
}

export function validateReport(v: unknown): asserts v is ProtocolReadsReport {
  if (
    !record(v) ||
    v.schema !== REPORT_SCHEMA_ID ||
    typeof v.generatedBy !== 'string' ||
    !v.generatedBy ||
    typeof v.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.generatedAt)) ||
    !record(v.dataset) ||
    typeof v.dataset.listens !== 'number' ||
    !Number.isInteger(v.dataset.listens) ||
    v.dataset.listens < 1 ||
    typeof v.dataset.seed !== 'number' ||
    !Number.isSafeInteger(v.dataset.seed) ||
    typeof v.dataset.clock !== 'string' ||
    !Number.isFinite(Date.parse(v.dataset.clock)) ||
    typeof v.dataset.applyPathRecords !== 'number' ||
    !Number.isInteger(v.dataset.applyPathRecords) ||
    v.dataset.applyPathRecords < 1 ||
    !record(v.dataset.operations) ||
    typeof v.dataset.operations.total !== 'number' ||
    !Number.isSafeInteger(v.dataset.operations.total) ||
    v.dataset.operations.total < 1 ||
    typeof v.dataset.operations.scrobbleCreateSucceeded !== 'number' ||
    !Number.isSafeInteger(v.dataset.operations.scrobbleCreateSucceeded) ||
    v.dataset.operations.scrobbleCreateSucceeded < 0 ||
    !record(v.dataset.operations.scrobbleDelete) ||
    !['queued', 'running', 'blocked', 'failed', 'succeededMatchingCid', 'succeededStaleCid'].every(
      (state) =>
        typeof v.dataset.operations.scrobbleDelete[state] === 'number' &&
        Number.isSafeInteger(v.dataset.operations.scrobbleDelete[state]) &&
        (v.dataset.operations.scrobbleDelete[state] as number) >= 0,
    ) ||
    typeof v.dataset.operations.visibleScrobbles !== 'number' ||
    !Number.isSafeInteger(v.dataset.operations.visibleScrobbles) ||
    typeof v.dataset.operations.hiddenScrobbles !== 'number' ||
    !Number.isSafeInteger(v.dataset.operations.hiddenScrobbles) ||
    v.dataset.operations.visibleScrobbles + v.dataset.operations.hiddenScrobbles !== v.dataset.listens ||
    v.dataset.operations.total !==
      v.dataset.operations.scrobbleCreateSucceeded +
        Object.values(v.dataset.operations.scrobbleDelete).reduce(
          (sum, value) => sum + (typeof value === 'number' ? value : Number.NaN),
          0,
        ) ||
    !record(v.plans) ||
    typeof v.plans.source !== 'string' ||
    !record(v.reads) ||
    !record(v.reads.topTracks) ||
    !record(v.reads.topTracks.cached) ||
    !record(v.reads.topTracks.uncached)
  )
    throw Error('invalid protocol-read report envelope');
  for (const key of ['topTracks', 'recentTracks', 'listenbrainzAllTime', 'listeningActivityYear']) {
    const plans = v.plans[key];
    if (!Array.isArray(plans) || plans.length === 0) throw Error(`invalid query plan set: ${key}`);
    for (const plan of plans) {
      try {
        validatePlanStatement(plan);
      } catch (error) {
        throw Error(
          `invalid or unbounded query plan: ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  for (const key of names)
    for (const timing of key === 'topTracks'
      ? [v.reads.topTracks.cached, v.reads.topTracks.uncached]
      : [v.reads[key]]) {
      if (
        !record(timing) ||
        typeof timing.runs !== 'number' ||
        !Number.isInteger(timing.runs) ||
        timing.runs < 1 ||
        typeof timing.p50Ms !== 'number' ||
        !Number.isFinite(timing.p50Ms) ||
        timing.p50Ms < 0 ||
        typeof timing.p95Ms !== 'number' ||
        !Number.isFinite(timing.p95Ms) ||
        timing.p95Ms < timing.p50Ms
      )
        throw Error(`invalid timing/percentiles: ${key}`);
    }
}
export function renderReport(r: ProtocolReadsReport): string {
  const rows: Array<[string, Timing]> = [
    ['top-tracks cached', r.reads.topTracks.cached],
    ['top-tracks uncached', r.reads.topTracks.uncached],
    ['recent-tracks page 500', r.reads.recentTracksPage500],
    ['ListenBrainz all_time stats', r.reads.listenbrainzAllTime],
    ['ListenBrainz listening-activity year', r.reads.listeningActivityYear],
  ];
  const budgets: Record<string, number | null> = {
    'top-tracks cached': 20,
    'top-tracks uncached': 250,
    'recent-tracks page 500': 100,
    'ListenBrainz all_time stats': null,
    'ListenBrainz listening-activity year': null,
  };
  return `# Node protocol-read benchmark\n\n- Generated: ${r.generatedAt}\n- Receipt: \`${r.generatedBy}\`\n- Dataset: ${r.dataset.listens.toLocaleString()} listens, seed ${r.dataset.seed}, fixed clock ${r.dataset.clock}; apply-path parity sample ${r.dataset.applyPathRecords} records; ${r.dataset.operations.total.toLocaleString()} operations (${r.dataset.operations.scrobbleCreateSucceeded.toLocaleString()} succeeded scrobble creates, ${r.dataset.operations.scrobbleDelete.queued + r.dataset.operations.scrobbleDelete.running + r.dataset.operations.scrobbleDelete.blocked + r.dataset.operations.scrobbleDelete.failed + r.dataset.operations.scrobbleDelete.succeededMatchingCid + r.dataset.operations.scrobbleDelete.succeededStaleCid} scrobble deletes); ${r.dataset.operations.visibleScrobbles.toLocaleString()} visible / ${r.dataset.operations.hiddenScrobbles.toLocaleString()} hidden listens\n\nThe main fixture inserts the 100,000-listen projection through direct SQL after production record normalization, then seeds a deterministic history of succeeded create operations and delete operations spanning queued, running, blocked, failed, succeeded with matching CID, and succeeded with stale CID. The operation count is deliberately bounded for a reproducible pre-index measurement and is reported explicitly; it does not claim to model a user's lifetime operation history. The parity sample compares signed repository verification and the production apply path against equivalent direct inserts. Reads are measured through the Node HTTP composition; fixture setup, cache invalidation, and report writing are outside each timed sample. Each read has ten samples. Requests are top tracks (period=overall), recent tracks (page 500, limit 200), ListenBrainz recordings (range=all_time, count=100), and listening activity (range=year). The ListenBrainz stats query-plan sample is a cold cache miss and its timing samples clear the cache before each request.\n\nTimings are observations from this run. Budget comparisons are informational and are not acceptance assertions. The ADR §10.3 report-only budgets are uncached top tracks p95 <250 ms, cached top tracks p95 <20 ms, and recent tracks page 500 p95 <100 ms. With ten samples, nearest-rank p95 is the slowest sample. No budget is specified for the ListenBrainz reads.\n\n| Read | Runs | p50 (ms) | p95 (ms) | Report-only p95 budget |\n|---|---:|---:|---:|---:|\n${rows.map(([n, t]) => `| ${n} | ${t.runs} | ${t.p50Ms.toFixed(2)} | ${t.p95Ms.toFixed(2)} | ${budgets[n] === null ? 'not specified' : `< ${budgets[n]} ms`} |`).join('\n')}\n\n## Query plans\n\n${Object.entries(
    r.plans,
  )
    .filter(([k]) => k !== 'source')
    .map(
      ([k, p]) =>
        `### ${k}\n\n${(p as QueryPlanStatement[])
          .map(
            (x, index) =>
              `#### Statement ${index + 1}\n\n\`\`\`sql\n${x.sql}\n\`\`\`\n\n${x.details.map((detail) => `- ${detail}`).join('\n')}`,
          )
          .join('\n\n')}`,
    )
    .join('\n\n')}\n\nPlan source: ${r.plans.source}\n`;
}
export function main(args = process.argv.slice(2)): number {
  const renderOnly = args[0] === '--render';
  const input = args[renderOnly ? 1 : 0];
  if (!input) {
    console.error('Usage: benchmark-protocol-reads.ts [--render] <receipt.json> [--out <report.json>] [--no-docs]');
    return 2;
  }
  try {
    const report = JSON.parse(readFileSync(resolve(input), 'utf8')) as unknown;
    validateReport(report);
    const outFlag = args.indexOf('--out');
    const out = outFlag >= 0 ? resolve(args[outFlag + 1]!) : resolve(REPO_ROOT, 'work/bench/protocol-reads.json');
    if (!renderOnly) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (!args.includes('--no-docs')) {
      mkdirSync(dirname(DEFAULT_DOC), { recursive: true });
      writeFileSync(DEFAULT_DOC, renderReport(report));
    }
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname))
  process.exitCode = main();
