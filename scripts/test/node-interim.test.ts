// Disposable-copy tests for the interim per-wave acceptance gate,
// scripts/acceptance/node-interim.sh (N0-02; ADR 0005 §2.2, §15.3, B10).
//
// Each test copies the repository (tracked plus untracked, non-ignored files)
// into a fresh temporary directory and runs the real node-interim.sh there.
// The python, case-map and live-noenv steps run for real in the copy. Two
// steps are replaced by recording stubs inside the copy only:
// - scripts/check-ts.sh, because the real gate runs this very test file (the
//   scripts vitest project) and would recurse; check-ts.sh has its own
//   disposable-copy controls in scripts/test/check-ts.test.ts;
// - scripts/check_goldens.sh, which rebuilds the Rust oracle with cargo; the
//   real gate runs it, and it has its own --self-test.
// The stubs record every invocation, so the test asserts that node-interim
// ran each step exactly once with the expected command, and makes a step fail
// by changing its stub's exit status. The real working tree is never touched.

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TIMEOUT = 10 * 60_000;
const CHECK_TS_TEST = 'scripts/test/check-ts.test.ts';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface StepSummary {
  command: string;
  result: 'passed' | 'failed' | 'skipped' | 'pending';
  exit?: number | null;
  pendingUntilWave?: number;
}

interface Summary {
  gate: string;
  wave: number;
  steps: Record<string, StepSummary>;
  pending: { e2e: number | null; liveEvidence: number; caseMapClosure: number };
  python: { passed: number; failed: number; skipped: number };
  liveGates: string[];
  result: 'passed' | 'failed';
  problems: string[];
}

/** This process's environment without the variables npm and vitest set for the outer run. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|VITEST|INIT_CWD$|NODE_ENV$|TEST$|NODE_OPTIONS$|ATMUSIC_LIVE_)/.test(key)) continue;
    env[key] = value;
  }
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return env;
}

function exec(command: string, args: string[], cwd: string): Result {
  const r: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd,
    env: childEnv(),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function gitStatus(): string {
  const r = exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], ROOT);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** A recording stub: appends `<name> <argv>` and its working directory to stub-calls.log, then exits `status`. */
function writeStub(path: string, name: string, status: number): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nprintf '%s|%s|%s\\n' '${name}' "$*" "$PWD" >> "$(dirname "$0")/../stub-calls.log"\nexit ${status}\n`,
  );
  chmodSync(path, 0o755);
}

class DisposableCopy {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'atmusic-node-interim-'));
    const listed = exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], ROOT);
    expect(listed.status, listed.stderr).toBe(0);
    for (const file of new Set(listed.stdout.split('\0').filter((f) => f !== ''))) {
      const source = join(ROOT, file);
      if (!existsSync(source) || lstatSync(source).isDirectory()) continue;
      const target = join(this.dir, file);
      mkdirSync(dirname(target), { recursive: true });
      if (lstatSync(source).isSymbolicLink()) continue;
      copyFileSync(source, target);
      if (lstatSync(source).mode & 0o111) chmodSync(target, 0o755);
    }
    // npx tsx (the live gates) resolves from the repository's installed packages; read-only.
    symlinkSync(join(ROOT, 'node_modules'), join(this.dir, 'node_modules'));
    writeStub(join(this.dir, 'scripts/check-ts.sh'), 'check-ts', 0);
    writeStub(join(this.dir, 'scripts/check_goldens.sh'), 'goldens', 0);
    // Inside scripts/test/check-ts.test.ts's disposable copy, which omits that file by design (so its
    // nested gate never recurses), the case map's targets in it are restored as titles only.
    if (!existsSync(join(ROOT, CHECK_TS_TEST))) {
      const map = JSON.parse(readFileSync(join(ROOT, 'docs/verification/ts-case-map.json'), 'utf8')) as {
        cases: { target: string; also?: string[] }[];
      };
      const titles = map.cases
        .flatMap((c) => [c.target, ...(c.also ?? [])])
        .filter((t) => t.startsWith(`${CHECK_TS_TEST} › `))
        .map((t) => t.slice(CHECK_TS_TEST.length + 3));
      writeFileSync(join(this.dir, CHECK_TS_TEST), titles.map((t) => `it(${JSON.stringify(t)}, () => {});\n`).join(''));
    }
  }

  gate(...args: string[]): Result {
    return exec('bash', ['scripts/acceptance/node-interim.sh', ...args], this.dir);
  }

  stub(name: 'check-ts' | 'goldens', status: number): void {
    writeStub(join(this.dir, name === 'check-ts' ? 'scripts/check-ts.sh' : 'scripts/check_goldens.sh'), name, status);
  }

  calls(): string[] {
    const log = join(this.dir, 'stub-calls.log');
    const lines = existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
      : [];
    rmSync(log, { force: true });
    return lines;
  }

  summary(out: string): Summary {
    return JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as Summary;
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const copies: DisposableCopy[] = [];
afterEach(() => {
  for (const copy of copies.splice(0)) copy.remove();
});

function liveGates(): string[] {
  return readdirSync(join(ROOT, 'scripts/live'))
    .filter((f) => f.endsWith('.ts') && /^export const spec/m.test(readFileSync(join(ROOT, 'scripts/live', f), 'utf8')))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
}

describe('scripts/acceptance/node-interim.sh', () => {
  it(
    'node-interim.sh --wave 0 in a disposable copy runs check-ts, the Python regressions, the case map with --node-wave 0, goldens and live no-env, prints Playwright as pending until wave 6, and exits 1 when any run step fails',
    () => {
      const before = gitStatus();
      const copy = new DisposableCopy();
      copies.push(copy);
      const out = join(copy.dir, 'out');
      const gates = liveGates();
      expect(gates.length).toBeGreaterThanOrEqual(5);

      // 1. Every step of wave 0 runs and passes: exit 0.
      const pass = copy.gate('--wave', '0', '--out', out);
      expect(pass.status, pass.stdout + pass.stderr).toBe(0);
      expect(pass.stdout).toContain('==> check-ts: npm run check');
      expect(pass.stdout).toContain('==> python: python3 -m unittest');
      expect(pass.stdout).toContain('==> case-map: python3 scripts/validate_case_map.py --check-tests --node-wave 0');
      expect(pass.stdout).toContain('==> goldens: bash scripts/check_goldens.sh');
      expect(pass.stdout).toContain('==> live-noenv: npx tsx scripts/live/<gate>.ts (no env)');
      expect(pass.stdout).toMatch(/^==> e2e: pending until wave 6 /m);
      expect(pass.stdout).toContain('==> live evidence: pending until wave 6');
      expect(pass.stdout).toContain('==> case-map closure over executed test records: pending until wave 8');
      expect(pass.stdout).toContain('PASS node-interim: wave 0; every step of this wave passed');
      // check-ts ran through `npm run check` (the stub is what package.json's script runs), goldens once, both in the copy.
      expect(copy.calls()).toEqual([`check-ts||${copy.dir}`, `goldens||${copy.dir}`]);
      const passed = copy.summary(out);
      expect(passed.result).toBe('passed');
      expect(passed.problems).toEqual([]);
      expect(passed.wave).toBe(0);
      expect(Object.fromEntries(Object.entries(passed.steps).map(([k, v]) => [k, v.result]))).toEqual({
        'check-ts': 'passed',
        python: 'passed',
        'case-map': 'passed',
        goldens: 'passed',
        'live-noenv': 'passed',
        e2e: 'pending',
      });
      expect(passed.steps.e2e!.pendingUntilWave).toBe(6);
      expect(passed.pending).toEqual({ e2e: 6, liveEvidence: 6, caseMapClosure: 8 });
      // The Python regressions really ran, one record per test, including this package's validator tests.
      expect(passed.python.failed).toBe(0);
      expect(passed.python.passed).toBeGreaterThan(20);
      const records = readFileSync(join(out, 'python.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { target: string; result: string });
      expect(records).toContainEqual(
        expect.objectContaining({
          target: 'scripts/test_validate_case_map.py › a case target declared only in node-waves.json is accepted',
          result: 'passed',
        }),
      );
      // The case map ran with --node-wave 0: later-wave targets are pending under their package.
      const caseMap = readFileSync(join(out, 'case-map.log'), 'utf8');
      expect(caseMap).toMatch(/^PENDING case map: M2\.2\.2\/wrong_origin: .* pending \(wave 3, N3-01\)$/m);
      expect(caseMap).toMatch(/^PENDING case map: M3\.4\.3\/live_retries: .* pending \(wave 8, N8-01\)$/m);
      expect(caseMap).toContain('PASS case map: 258 unique cases');
      // 39 since N3-11 retargeted M1.1.1/version_policy to its wave-3 four-collection title.
      expect(caseMap).toMatch(/^PENDING case map: M1\.1\.1\/version_policy: .* pending \(wave 3, N3-11\)$/m);
      // 50 since N4-03 retargeted the restart, admin, query-plan and bench cases to its wave-4 titles
      // (and M1.4.3/drain_success to N3-07's SIGTERM drain test).
      expect(caseMap).toMatch(/^PENDING case map: M6\.2\.2\/metrics_auth: .* pending \(wave 4, N4-03\)$/m);
      expect(caseMap).toContain('of node waves <= 0 exists; 50 targets of later node waves pending');
      // Every live gate ran with no environment and answered blocked (exit 2) with its missing names.
      expect(passed.liveGates).toEqual(gates);
      for (const gate of gates) {
        expect(readFileSync(join(out, `live-noenv-${gate}.exit`), 'utf8').trim()).toBe('2');
        const doc = JSON.parse(readFileSync(join(out, `live-noenv-${gate}.json`), 'utf8')) as {
          result: string;
          missing: string[];
        };
        expect(doc.result).toBe('blocked');
        expect(doc.missing.length).toBeGreaterThan(0);
      }

      // 2. A failing check-ts fails the gate (exit 1); the other steps still run and pass.
      copy.stub('check-ts', 3);
      const tsFail = copy.gate('--wave', '0', '--out', out);
      expect(tsFail.status, tsFail.stdout).toBe(1);
      expect(copy.calls()).toEqual([`check-ts||${copy.dir}`, `goldens||${copy.dir}`]);
      const tsSummary = copy.summary(out);
      expect(tsSummary.result).toBe('failed');
      expect(tsSummary.steps['check-ts']!.result).toBe('failed');
      expect(tsSummary.steps['check-ts']!.exit).not.toBe(0);
      expect(tsSummary.steps.python!.result).toBe('passed');
      expect(tsSummary.steps['case-map']!.result).toBe('passed');
      expect(tsSummary.steps['live-noenv']!.result).toBe('passed');
      expect(tsSummary.problems).toEqual([expect.stringMatching(/^step check-ts \(npm run check\) exited [1-9]/)]);
      expect(tsFail.stdout).toMatch(/^FAIL node-interim: step check-ts \(npm run check\) exited [1-9]/m);
      expect(tsFail.stdout).not.toContain('PASS node-interim');

      // 3. A failing goldens step alone fails the gate.
      copy.stub('check-ts', 0);
      copy.stub('goldens', 1);
      const goldensFail = copy.gate('--wave', '0', '--out', out);
      expect(goldensFail.status, goldensFail.stdout).toBe(1);
      copy.calls();
      const goldens = copy.summary(out);
      expect(goldens.problems).toEqual(['step goldens (bash scripts/check_goldens.sh) exited 1']);
      expect(goldens.steps['check-ts']!.result).toBe('passed');

      // 4. A case map that cites a superseded amendment fails the case-map step (run for real).
      copy.stub('goldens', 0);
      const mapPath = join(copy.dir, 'docs/verification/ts-case-map.json');
      const map = JSON.parse(readFileSync(mapPath, 'utf8')) as {
        cases: { case: string; target: string; reason?: string }[];
      };
      const entry = map.cases.find((c) => c.case === 'M2.2.2/par_pkce')!;
      entry.target = 'retired:A3';
      entry.reason = 'The browser library performs PAR.';
      writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
      const mapFail = copy.gate('--wave', '0', '--out', out);
      expect(mapFail.status, mapFail.stdout).toBe(1);
      copy.calls();
      const mapSummary = copy.summary(out);
      expect(mapSummary.steps['case-map']!.result).toBe('failed');
      expect(readFileSync(join(out, 'case-map.log'), 'utf8')).toContain(
        'FAIL case map: M2.2.2/par_pkce: retired:A3 cites ADR 0004 amendment A3, superseded by B3',
      );

      // 5. From wave 6 Playwright is a run step (here disabled, which is a failure, never a pass).
      const wave6 = copy.gate(
        '--wave',
        '6',
        '--out',
        out,
        ...['check-ts', 'python', 'case-map', 'goldens', 'live-noenv', 'e2e'].flatMap((s) => ['--skip', s]),
      );
      expect(wave6.status).toBe(1);
      expect(copy.calls()).toEqual([]);
      const six = copy.summary(out);
      expect(six.steps.e2e).toEqual({ command: 'npx playwright test', result: 'skipped' });
      expect(six.pending.e2e).toBeNull();

      // 6. Usage errors exit 2: no wave, a wave outside 0-7, an unknown step, a foreign non-empty --out.
      expect(copy.gate().status).toBe(2);
      expect(copy.gate('--wave', '9').status).toBe(2);
      expect(copy.gate('--wave', '0', '--skip', 'deploy').status).toBe(2);
      const foreign = join(copy.dir, 'foreign');
      mkdirSync(foreign);
      writeFileSync(join(foreign, 'keep.txt'), 'not the gate output\n');
      const refused = copy.gate('--wave', '0', '--out', foreign);
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain('refusing --out');
      expect(readFileSync(join(foreign, 'keep.txt'), 'utf8')).toBe('not the gate output\n');
      expect(copy.calls()).toEqual([]);

      expect(gitStatus()).toBe(before);
    },
    TIMEOUT,
  );
});
