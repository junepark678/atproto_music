// Narrow deterministic acceptance, not the final M1–M6 backend/live gate.
// Build real main + fixture host, guard shared inputs, execute the subprocess
// fault journey against exactly those bytes, reject omitted/skipped cases.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as build, gitSha, REPO_ROOT } from '../build-server';
import { runGuard } from '../check-node-bundle';
import { type CaseRecord, summarize } from '../report-tests';

export const REQUIRED_RECOVERY_TARGETS = [
  'scripts/test/node-recovery.test.ts › oauth_refresh_recovery: rotated refresh credentials and the same app-session cookie survive a child-process restart',
  'scripts/test/node-recovery.test.ts › federation_process_recovery: second-PDS create/update/delete survive SIGKILL during proof and converge',
  'scripts/test/node-recovery.test.ts › packaged_recovery: SIGKILL after create and delete commits reconciles durable operations, views, cursor and checkpoint on the same database',
  'scripts/test/node-recovery.test.ts › packaged_follow_feed_recovery: second-PDS create, update and delete persist through process restarts',
] as const;
export const NOT_COVERED = [
  'browser BFF migration',
  'immediate local deletion tombstones',
  'backup restore in this packaged journey',
  'full backend case-map closure',
  'constrained paced benchmark',
  'installer activation',
  'live PDS/Jetstream/OAuth/soak',
];
export const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export function recoveryAccounting(records: readonly CaseRecord[]): string[] {
  return REQUIRED_RECOVERY_TARGETS.flatMap((target) => {
    const matching = records.filter((r) => r.target === target);
    return matching.length === 1 && matching[0]?.executed === 1 && matching[0].result === 'passed'
      ? []
      : [`required case unexecuted or not passed: ${target}`];
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length !== 2 || argv[0] !== '--out' || !argv[1]) {
    console.error('usage: node-recovery.ts --out DIR (dedicated output; never the full backend acceptance gate)');
    return 2;
  }
  const out = resolve(argv[1]);
  mkdirSync(out, { recursive: true });
  const marker = join(out, '.node-recovery-output');
  if (!existsSync(marker) && readdirSync(out).length !== 0) {
    console.error('refusing non-empty output directory without .node-recovery-output marker');
    return 2;
  }
  writeFileSync(marker, 'dedicated node subprocess recovery output\n');
  // A stale report must never stand in for this invocation.
  const reportPath = join(out, 'vitest.json');
  const summaryPath = join(out, 'summary.json');
  rmSync(reportPath, { force: true });
  rmSync(summaryPath, { force: true });
  const dist = join(out, 'bundle');
  const log: string[] = [];
  const io = { out: (s: string) => log.push(s), err: (s: string) => log.push(s) };
  let code = await build(['--check', '--outdir', dist], io);
  if (code === 0) code = runGuard({ dist }, io);
  const commit = gitSha();
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim() !== '';
  const bundleHashes = code === 0 ? { main: sha256(join(dist, 'main.mjs')), e2e: sha256(join(dist, 'e2e.mjs')) } : null;
  const command = 'npx vitest run --project scripts scripts/test/node-recovery.test.ts --reporter=json';
  let records: CaseRecord[] = [];
  const problems: string[] = [];
  if (code === 0) {
    const run = spawnSync(
      'npx',
      [
        'vitest',
        'run',
        '--project',
        'scripts',
        'scripts/test/node-recovery.test.ts',
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 10_000_000,
        env: { ...process.env, ATMUSIC_RECOVERY_DIST: dist },
      },
    );
    log.push(run.stdout ?? '', run.stderr ?? '');
    if (run.status !== 0)
      problems.push(`vitest exited ${run.status}: ${run.error?.message ?? run.signal ?? 'test failure'}`);
    try {
      const summary = summarize(
        JSON.parse(readFileSync(reportPath, 'utf8')),
        command,
        `${commit}${dirty ? '+dirty' : ''}`,
      );
      records = summary.records;
      problems.push(...summary.reasons);
      // Prove the bundle under test did not change during execution.
      if (sha256(join(dist, 'main.mjs')) !== bundleHashes?.main || sha256(join(dist, 'e2e.mjs')) !== bundleHashes.e2e)
        problems.push('bundle changed during acceptance');
    } catch (error) {
      problems.push(`missing or malformed execution report: ${String(error)}`);
    }
  } else problems.push(`build/guard exited ${code}`);
  problems.push(...recoveryAccounting(records));
  writeFileSync(join(out, 'run.log'), `${log.join('\n')}\n`);
  writeFileSync(join(out, 'cases.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  writeFileSync(
    summaryPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scope: 'node-subprocess-recovery-only',
        commit,
        dirty,
        node: process.version,
        sqlite: process.versions.sqlite,
        bundles: bundleHashes,
        command,
        executed: records.reduce((n, r) => n + r.executed, 0),
        result: problems.length ? 'failed' : 'passed',
        problems,
        notCovered: NOT_COVERED,
        artifacts: { log: sha256(join(out, 'run.log')), cases: sha256(join(out, 'cases.jsonl')) },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`${problems.length ? 'FAIL' : 'PASS'} node subprocess recovery (not full acceptance): ${summaryPath}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
