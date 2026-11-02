// N5-02 protocol-read benchmark report renderer. The bench suite that measures
// these reads will emit this receipt; this runner validates it and renders the
// durable Markdown report.
//
// Usage:
//   npx tsx scripts/benchmark-protocol-reads.ts <receipt.json> [--out <report.json>] [--no-docs]
//   npx tsx scripts/benchmark-protocol-reads.ts --render <receipt.json>
//
// Receipt schema (atmusic/protocol-reads-benchmark@1): {schema, generatedBy,
// generatedAt, dataset:{listens}, plans:{source,topTracks,recentTracks,
// listenbrainzAllTime,listeningActivityYear}, reads:{topTracks:{cached,
// uncached},recentTracksPage500,listenbrainzAllTime,listeningActivityYear}}.
// Each read has {runs,p50Ms,p95Ms}, using nearest-rank percentiles. Plans are
// non-empty EXPLAIN QUERY PLAN detail arrays and may not contain SCAN scrobbles.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const REPORT_SCHEMA_ID = 'atmusic/protocol-reads-benchmark@1';
export const DEFAULT_DOC = resolve('docs/benchmarks/node-protocol-reads.md');
const names = ['topTracks', 'recentTracksPage500', 'listenbrainzAllTime', 'listeningActivityYear'] as const;
type Timing = { runs: number; p50Ms: number; p95Ms: number };
export interface ProtocolReadsReport {
  schema: typeof REPORT_SCHEMA_ID;
  generatedBy: string;
  generatedAt: string;
  dataset: { listens: number };
  plans: { source: string; topTracks: string[]; recentTracks: string[]; listenbrainzAllTime: string[]; listeningActivityYear: string[] };
  reads: { topTracks: { cached: Timing; uncached: Timing }; recentTracksPage500: Timing; listenbrainzAllTime: Timing; listeningActivityYear: Timing };
}

function record(v: unknown): v is Record<string, any> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
export function validateReport(v: unknown): asserts v is ProtocolReadsReport {
  if (!record(v) || v.schema !== REPORT_SCHEMA_ID || typeof v.generatedBy !== 'string' || !v.generatedBy || typeof v.generatedAt !== 'string' || !Number.isFinite(Date.parse(v.generatedAt)) || !record(v.dataset) || !Number.isInteger(v.dataset.listens) || v.dataset.listens < 1 || !record(v.plans) || typeof v.plans.source !== 'string' || !record(v.reads) || !record(v.reads.topTracks)) throw Error('invalid protocol-read report envelope');
  for (const key of ['topTracks', 'recentTracks', 'listenbrainzAllTime', 'listeningActivityYear']) {
    const plan = v.plans[key];
    if (!Array.isArray(plan) || plan.length === 0 || !plan.every((s: unknown) => typeof s === 'string' && s.length > 0) || plan.some((s: string) => /SCAN\s+scrobbles\b/i.test(s))) throw Error(`invalid or unbounded query plan: ${key}`);
  }
  for (const key of names) for (const timing of (key === 'topTracks' ? [v.reads.topTracks.cached, v.reads.topTracks.uncached] : [v.reads[key]])) {
    if (!record(timing) || !Number.isInteger(timing.runs) || timing.runs < 1 || !Number.isFinite(timing.p50Ms) || timing.p50Ms < 0 || !Number.isFinite(timing.p95Ms) || timing.p95Ms < timing.p50Ms) throw Error(`invalid timing/percentiles: ${key}`);
  }
}
export function renderReport(r: ProtocolReadsReport): string {
  const rows: Array<[string, Timing]> = [['top-tracks cached', r.reads.topTracks.cached], ['top-tracks uncached', r.reads.topTracks.uncached], ['recent-tracks page 500', r.reads.recentTracksPage500], ['ListenBrainz all_time stats', r.reads.listenbrainzAllTime], ['ListenBrainz listening-activity year', r.reads.listeningActivityYear]];
  return `# Node protocol-read benchmark\n\nGenerated: ${r.generatedAt}  \nReceipt: \`${r.generatedBy}\`  \nDataset: ${r.dataset.listens.toLocaleString()} listens\n\n| Read | Runs | p50 (ms) | p95 (ms) |\n|---|---:|---:|---:|\n${rows.map(([n,t])=>`| ${n} | ${t.runs} | ${t.p50Ms} | ${t.p95Ms} |`).join('\n')}\n\n## Query plans\n\n${Object.entries(r.plans).filter(([k])=>k!=='source').map(([k,p])=>`### ${k}\n\n${(p as string[]).map(x=>`- ${x}`).join('\n')}`).join('\n\n')}\n\nPlan source: ${r.plans.source}\n`;
}
export function main(args = process.argv.slice(2)): number {
  const renderOnly = args[0] === '--render';
  const input = args[renderOnly ? 1 : 0];
  if (!input) { console.error('Usage: benchmark-protocol-reads.ts [--render] <receipt.json> [--out <report.json>] [--no-docs]'); return 2; }
  try {
    const report = JSON.parse(readFileSync(resolve(input), 'utf8')) as unknown;
    validateReport(report);
    const outFlag = args.indexOf('--out');
    const out = outFlag >= 0 ? resolve(args[outFlag + 1]!) : resolve('work/bench/protocol-reads.json');
    if (!renderOnly) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`); }
    if (!args.includes('--no-docs')) { mkdirSync(dirname(DEFAULT_DOC), { recursive: true }); writeFileSync(DEFAULT_DOC, renderReport(report)); }
    return 0;
  } catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) process.exitCode = main();
