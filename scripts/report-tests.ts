// Turns a vitest JSON report into per-case evidence records (ADR 0004 §10.1,
// docs/planning/TESTING.md): for every executed test, its target
// (`<repo-relative file> › <describe> › <title>`), the command, the executed
// count, the result and the commit.
//
// Usage: npx tsx scripts/report-tests.ts <vitest-report.json> [--command "npm test"] [--out work/ts-test-cases.jsonl]
//
// Exits nonzero when the report is missing or malformed, when zero tests
// executed (a filtered or empty run is never evidence), when any test failed,
// or when vitest itself reported failure (for example a suite that failed to load).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

interface AssertionResult {
  ancestorTitles: string[];
  title: string;
  fullName: string;
  status: string;
  duration?: number | null;
  failureMessages?: string[];
}

interface FileResult {
  name: string;
  status: string;
  message?: string;
  assertionResults: AssertionResult[];
}

interface VitestJsonReport {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  success: boolean;
  testResults: FileResult[];
}

export interface CaseRecord {
  target: string;
  command: string;
  executed: number;
  result: 'passed' | 'failed' | 'skipped' | 'todo';
  commit: string;
}

export interface Summary {
  records: CaseRecord[];
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  fileFailures: string[];
  ok: boolean;
  reasons: string[];
}

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

function gitCommit(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return process.env.GITHUB_SHA ?? 'unknown';
  }
}

function isReport(value: unknown): value is VitestJsonReport {
  const v = value as VitestJsonReport;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.numTotalTests === 'number' &&
    typeof v.success === 'boolean' &&
    Array.isArray(v.testResults) &&
    v.testResults.every((f) => typeof f?.name === 'string' && Array.isArray(f.assertionResults))
  );
}

function mapStatus(status: string): CaseRecord['result'] {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'todo') return 'todo';
  return 'skipped'; // skipped, pending, disabled
}

export function summarize(report: unknown, command: string, commit: string, root = ROOT): Summary {
  const reasons: string[] = [];
  if (!isReport(report)) {
    return {
      records: [],
      executed: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      todo: 0,
      fileFailures: [],
      ok: false,
      reasons: ['not a vitest JSON report'],
    };
  }
  const records: CaseRecord[] = [];
  const fileFailures: string[] = [];
  for (const file of report.testResults) {
    const rel = relative(root, file.name).split('\\').join('/');
    if (file.status === 'failed' && file.assertionResults.every((a) => a.status !== 'failed')) {
      fileFailures.push(`${rel}: ${(file.message ?? 'suite failed').split('\n')[0]}`);
    }
    for (const a of file.assertionResults) {
      const result = mapStatus(a.status);
      records.push({
        target: [rel, ...a.ancestorTitles, a.title].join(' › '),
        command,
        executed: result === 'passed' || result === 'failed' ? 1 : 0,
        result,
        commit,
      });
    }
  }
  const count = (r: CaseRecord['result']) => records.filter((x) => x.result === r).length;
  const passed = count('passed');
  const failed = count('failed');
  const executed = passed + failed;
  if (executed === 0) reasons.push('zero tests executed');
  if (failed > 0) reasons.push(`${failed} test(s) failed`);
  if (fileFailures.length > 0) reasons.push(`${fileFailures.length} suite(s) failed outside a test`);
  if (!report.success) reasons.push('vitest reported success=false');
  if (report.numTotalTests !== records.length) {
    reasons.push(`report lists ${report.numTotalTests} tests but ${records.length} assertion results`);
  }
  return {
    records,
    executed,
    passed,
    failed,
    skipped: count('skipped'),
    todo: count('todo'),
    fileFailures,
    ok: reasons.length === 0,
    reasons,
  };
}

function parseArgs(argv: string[]): { report: string; command: string; out: string } {
  let report = '';
  let command = 'npm test';
  let out = 'work/ts-test-cases.jsonl';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--command') command = argv[++i] ?? command;
    else if (arg === '--out') out = argv[++i] ?? out;
    else if (arg !== undefined && report === '') report = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (report === '') throw new Error('usage: report-tests.ts <vitest-report.json> [--command CMD] [--out FILE]');
  return { report, command, out };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.report, 'utf8'));
  } catch (err) {
    console.error(`FAIL report-tests: cannot read ${args.report}: ${(err as Error).message}`);
    return 1;
  }
  const summary = summarize(parsed, args.command, gitCommit());
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(
    args.out,
    summary.records.map((r) => JSON.stringify(r)).join('\n') + (summary.records.length ? '\n' : ''),
  );
  for (const r of summary.records) {
    if (r.result !== 'passed') console.log(`${r.result.toUpperCase()} ${r.target}`);
  }
  for (const f of summary.fileFailures) console.log(`FAILED SUITE ${f}`);
  const line = `executed=${summary.executed} passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped} todo=${summary.todo} records=${args.out}`;
  if (!summary.ok) {
    console.error(`FAIL report-tests: ${summary.reasons.join('; ')} (${line})`);
    return 1;
  }
  console.log(`PASS report-tests: ${line}`);
  return 0;
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main();
}
