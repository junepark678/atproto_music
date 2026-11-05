// Disposable-copy tests for the Node backend acceptance gate,
// scripts/acceptance/node-backend.sh (N8-01; ADR 0005 §15).
//
// Each phase copies the repository (tracked plus untracked, non-ignored files)
// into a fresh temporary directory and runs the real node-backend.sh there with
// the real case map. The case-map, live-noenv and live steps run for real in
// the copy (no network: the live gates answer blocked without their variables,
// and the inventory is verified offline). The suites the gate would otherwise
// run for minutes, or that would recurse into this very file, are replaced by
// recording stubs inside the copy only:
// - scripts/check-ts.sh (the real one runs the scripts vitest project, i.e.
//   this file) emits one passed record per mapped test it is responsible for;
// - npx vitest / npx playwright, through a PATH shim, write pre-rendered JSON
//   reports covering the mapped worker/test/node, worker/test/acceptance and
//   web/tests targets; every other npx invocation (tsx) is forwarded;
// - scripts/e2e/scrobbler-e2e.ts, scripts/check-node-bundle.ts, the two
//   mapped python regression modules and scripts/check_goldens.sh are minimal
//   stand-ins that print or record exactly what the gate's closure consumes;
// - systemd-analyze is a recording shim, removed from PATH in the blocked phase.
// The stubs record every invocation; the gate's output directory is read back
// through summary.json, cases.jsonl and tests.jsonl. The real working tree is
// never touched.

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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TIMEOUT = 10 * 60_000;
const SEP = ' › ';
const SELF = 'bash scripts/acceptance/node-backend.sh';
const STEPS = [
  'check-ts',
  'node-tests',
  'e2e',
  'scrobbler-e2e',
  'python',
  'check-node-bundle',
  'case-map',
  'goldens',
  'systemd',
  'live-noenv',
  'live',
];
const GIT_SHA = 'c0ffee'.repeat(6).slice(0, 40);
const BUNDLE_SHA = 'ab'.repeat(32);
const SCROBBLER = 'scripts/e2e/scrobbler-e2e.ts';
const PYTHON_MODULES = ['scripts/test_live_evidence.py', 'scripts/test_validate_case_map.py'];
const SYNTHETIC_PREFIXES = [
  SELF,
  'python3 scripts/validate_contracts.py',
  'npx tsx scripts/check-node-bundle.ts',
  'python3 scripts/validate_case_map.py --check-tests',
];

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Summary {
  gate: string;
  commit: string;
  bundleSha256: string | null;
  steps: Record<string, { command: string; exit: string }>;
  tests: {
    executed: number;
    passed: number;
    failed: number;
    skipped: number;
    todo: number;
    bySource: Record<string, number>;
  };
  cases: { total: number; passed: number; failed: number; blocked: number; retired: number };
  live: { passed: number; failed: number; blocked: number };
  liveGates: { gate: string; script: string | null; result: string; missing: string[]; message: string }[];
  result: 'passed' | 'failed';
  problems: string[];
}

interface CaseRecord {
  case: string;
  result: string;
  targets: string[];
  commands: string[];
  count: number;
  notRun?: string[];
  failedTests?: string[];
  blockedBy?: string;
}

interface TestRecord {
  target: string;
  command: string;
  executed: number;
  result: string;
  commit: string;
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

function exec(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = childEnv()): Result {
  const r: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function gitStatus(): string {
  return exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], ROOT).stdout;
}

function realExecutable(name: string): string {
  const found = exec('bash', ['-c', `command -v ${name}`], ROOT).stdout.trim();
  expect(found, `${name} on PATH`).not.toBe('');
  return found;
}

/** The mapped test ids (target plus also) grouped by the stub that must produce them in the copy. */
function mappedTargets(): { caseMap: { case: string; target: string; also?: string[] }[]; refs: string[] } {
  const caseMap = JSON.parse(readFileSync(join(ROOT, 'docs/verification/ts-case-map.json'), 'utf8')) as {
    cases: { case: string; target: string; also?: string[] }[];
  };
  const refs = caseMap.cases.flatMap((c) => [c.target, ...(c.also ?? [])]).filter((t) => !t.startsWith('retired:'));
  return { caseMap: caseMap.cases, refs };
}

function stepOf(summary: Summary, step: string): { command: string; exit: string } {
  const entry = summary.steps[step];
  if (entry === undefined) throw new Error(`summary.json has no step ${step}`);
  return entry;
}

function prefixOf(ref: string): string {
  return ref.split(SEP, 1)[0] ?? '';
}

function nameOf(ref: string): string {
  return ref.slice(prefixOf(ref).length + SEP.length);
}

function isVitestTarget(ref: string): boolean {
  const p = prefixOf(ref);
  return p.startsWith('worker/test/node/') || p.startsWith('worker/test/acceptance/');
}

function isPlaywrightTarget(ref: string): boolean {
  return prefixOf(ref).startsWith('web/tests/');
}

function isCheckTsTarget(ref: string): boolean {
  const p = prefixOf(ref);
  return (
    !isVitestTarget(ref) &&
    !isPlaywrightTarget(ref) &&
    p !== SCROBBLER &&
    !PYTHON_MODULES.includes(p) &&
    !SYNTHETIC_PREFIXES.includes(p) &&
    !p.startsWith('npx tsx scripts/live/')
  );
}

function vitestReport(copy: string, refs: string[]): object {
  const byFile = new Map<string, string[]>();
  for (const ref of refs.filter(isVitestTarget)) {
    const list = byFile.get(prefixOf(ref)) ?? [];
    list.push(nameOf(ref));
    byFile.set(prefixOf(ref), list);
  }
  const testResults = [...byFile].map(([file, titles]) => ({
    name: join(copy, file),
    status: 'passed',
    assertionResults: titles.map((title) => ({ ancestorTitles: [], title, fullName: title, status: 'passed' })),
  }));
  return { numTotalTests: refs.filter(isVitestTarget).length, success: true, testResults };
}

function playwrightReport(copy: string, refs: string[]): object {
  const byFile = new Map<string, string[]>();
  for (const ref of refs.filter(isPlaywrightTarget)) {
    const file = prefixOf(ref).slice('web/tests/'.length);
    const list = byFile.get(file) ?? [];
    list.push(nameOf(ref));
    byFile.set(file, list);
  }
  return {
    config: { rootDir: join(copy, 'web/tests') },
    suites: [...byFile].map(([file, titles]) => ({
      title: file,
      file,
      specs: titles.map((title) => ({ title, file, tests: [{ status: 'expected' }] })),
      suites: [],
    })),
  };
}

function pythonStub(rel: string, refs: string[]): string {
  const names = refs.filter((r) => prefixOf(r) === rel).map(nameOf);
  const methods = names.map(
    (name, i) => `    def test_${i}(self):\n        ${JSON.stringify(name)}\n        self.assertTrue(True)\n`,
  );
  return `import unittest\n\n\nclass Stub(unittest.TestCase):\n${methods.join('\n')}\n\nif __name__ == '__main__':\n    unittest.main()\n`;
}

class DisposableCopy {
  readonly dir: string;
  readonly bin: string;
  readonly stubLog: string;
  readonly refs: string[];
  readonly caseMap: { case: string; target: string; also?: string[] }[];

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'atmusic-node-backend-'));
    this.bin = join(this.dir, '.gate-bin');
    this.stubLog = join(this.dir, 'stub-calls.log');
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
    // npx tsx (the live gates, report-tests.ts) resolves from the repository's installed packages; read-only.
    symlinkSync(join(ROOT, 'node_modules'), join(this.dir, 'node_modules'));
    const mapped = mappedTargets();
    this.refs = mapped.refs;
    this.caseMap = mapped.caseMap;
    mkdirSync(this.bin, { recursive: true });
    mkdirSync(join(this.dir, '.gate-stubs'), { recursive: true });
    this.writeCheckTsStub(0);
    this.writeGoldensStub(0);
    this.writeScrobblerStub();
    this.writeBundleStub();
    for (const rel of PYTHON_MODULES) writeFileSync(join(this.dir, rel), pythonStub(rel, this.refs));
    writeFileSync(join(this.dir, '.gate-stubs/vitest-report.json'), JSON.stringify(vitestReport(this.dir, this.refs)));
    writeFileSync(
      join(this.dir, '.gate-stubs/playwright-report.json'),
      JSON.stringify(playwrightReport(this.dir, this.refs)),
    );
    this.writeNpxShim();
    this.writeShim('systemd-analyze', `exit 0\n`);

    // The gate binds evidence to git HEAD and checks that `--out` paths are
    // ignored. Give this disposable source copy a real, clean git boundary.
    const init = exec('git', ['init', '--quiet'], this.dir);
    expect(init.status, init.stderr).toBe(0);
    const nameConfigured = exec('git', ['config', 'user.name', 'Node acceptance fixture'], this.dir);
    expect(nameConfigured.status, nameConfigured.stderr).toBe(0);
    const emailConfigured = exec('git', ['config', 'user.email', 'node-acceptance-fixture@example.invalid'], this.dir);
    expect(emailConfigured.status, emailConfigured.stderr).toBe(0);
    const added = exec('git', ['add', '-A'], this.dir);
    expect(added.status, added.stderr).toBe(0);
    const committed = exec('git', ['commit', '--quiet', '-m', 'disposable acceptance fixture'], this.dir);
    expect(committed.status, committed.stderr).toBe(0);
  }

  private record(name: string): string {
    return `printf '%s|%s|%s\\n' ${JSON.stringify(name)} "$*" "$PWD" >> ${JSON.stringify(this.stubLog)}\n`;
  }

  private writeShim(name: string, body: string): void {
    const path = join(this.bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${this.record(name)}${body}`);
    chmodSync(path, 0o755);
  }

  private writeNpxShim(): void {
    const realNpx = realExecutable('npx');
    this.writeShim(
      'npx',
      [
        'case "${1:-}" in',
        '  vitest)',
        '    for arg in "$@"; do case "$arg" in --outputFile.json=*) out="${arg#--outputFile.json=}";; esac; done',
        `    cp ${JSON.stringify(join(this.dir, '.gate-stubs/vitest-report.json'))} "$out"`,
        '    echo "vitest stub: report written to $out"',
        '    exit 0;;',
        '  playwright)',
        `    cp ${JSON.stringify(join(this.dir, '.gate-stubs/playwright-report.json'))} "$PLAYWRIGHT_JSON_OUTPUT_FILE"`,
        '    echo "playwright stub: report written to $PLAYWRIGHT_JSON_OUTPUT_FILE"',
        '    exit 0;;',
        `  *) exec ${JSON.stringify(realNpx)} "$@";;`,
        'esac',
        '',
      ].join('\n'),
    );
  }

  /** check-ts.sh stand-in: the contracts lines plus one passed record per mapped test it owns. */
  private writeCheckTsStub(status: number): void {
    const records = this.refs
      .filter(isCheckTsTarget)
      .map((target) =>
        JSON.stringify({ target, command: 'npm run check', executed: 1, result: 'passed', commit: 'unknown' }),
      );
    const contracts = this.refs
      .filter((r) => prefixOf(r) === 'python3 scripts/validate_contracts.py')
      .map((r) => `echo ${JSON.stringify(`PASS ${nameOf(r)}`)}`);
    writeFileSync(join(this.dir, '.gate-stubs/check-ts.jsonl'), records.map((r) => `${r}\n`).join(''));
    writeFileSync(
      join(this.dir, 'scripts/check-ts.sh'),
      [
        '#!/usr/bin/env bash',
        'set -u',
        this.record('check-ts').trimEnd(),
        'mkdir -p work',
        `cp ${JSON.stringify(join(this.dir, '.gate-stubs/check-ts.jsonl'))} work/ts-test-cases.jsonl`,
        'echo "==> contracts"',
        ...contracts,
        'echo "==> stub"',
        `echo "PASS check-ts (stub, exit ${status})"`,
        `exit ${status}`,
        '',
      ].join('\n'),
    );
    chmodSync(join(this.dir, 'scripts/check-ts.sh'), 0o755);
  }

  private writeGoldensStub(status: number): void {
    writeFileSync(
      join(this.dir, 'scripts/check_goldens.sh'),
      `#!/usr/bin/env bash\nset -u\n${this.record('goldens')}echo "goldens stub exit ${status}"\nexit ${status}\n`,
    );
    chmodSync(join(this.dir, 'scripts/check_goldens.sh'), 0o755);
  }

  /** scrobbler-e2e.ts stand-in: names every mapped title (for --check-tests) and records them as passed. */
  writeScrobblerStub(mode: 'passed' | 'failed' | 'missing' = 'passed'): void {
    const titles = this.refs.filter((r) => prefixOf(r) === SCROBBLER).map(nameOf);
    mkdirSync(join(this.dir, 'scripts/e2e'), { recursive: true });
    writeFileSync(
      join(this.dir, SCROBBLER),
      [
        '// scrobbler-e2e stand-in for scripts/test/node-backend.test.ts; mapped titles:',
        ...titles.map((t) => `// ${t}`),
        "import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        `const titles: string[] = ${JSON.stringify(titles)};`,
        `appendFileSync(${JSON.stringify(this.stubLog)}, \`scrobbler-e2e|\${process.argv.slice(2).join(' ')}|\${process.cwd()}\\n\`);`,
        "if (process.argv.length !== 4 || process.argv[2] !== '--out') process.exit(2);",
        'const out = process.argv[3]!;',
        'mkdirSync(out, { recursive: true });',
        "const marker = join(out, '.scrobbler-e2e');",
        'if (readdirSync(out).length > 0 && !existsSync(marker)) process.exit(2);',
        "writeFileSync(marker, 'scrobbler-e2e owned output\\n');",
        'const records = titles.map((title) => ({',
        `  target: \`${SCROBBLER} › \${title}\`,`,
        `  command: 'npx tsx ${SCROBBLER}',`,
        '  executed: 1,',
        `  result: '${mode === 'failed' ? 'failed' : 'passed'}',`,
        "  commit: process.env.ATMUSIC_ACCEPTANCE_COMMIT ?? 'unknown',",
        '}));',
        ...(mode === 'missing'
          ? ['for (const title of titles) console.log(`PASS ${title}`);']
          : [
              "writeFileSync(join(out, 'scrobbler-e2e.jsonl'), records.map((r) => `${JSON.stringify(r)}\\n`).join(''));",
            ]),
        'console.log(`scrobbler-e2e stub: ${titles.length} scenario(s)`);',
        `process.exitCode = ${mode === 'failed' ? 1 : 0};`,
        '',
      ].join('\n'),
    );
  }

  private writeBundleStub(): void {
    writeFileSync(
      join(this.dir, 'scripts/check-node-bundle.ts'),
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(this.stubLog)}, \`check-node-bundle||\${process.cwd()}\\n\`);`,
        "console.log('PASS check-node-bundle: stub bundle guard (scripts/test/node-backend.test.ts)');",
        `console.log('git sha ${GIT_SHA}');`,
        `console.log('bundle sha256 ${BUNDLE_SHA}  main.mjs');`,
        '',
      ].join('\n'),
    );
  }

  /** PATH with the shims first; with `withoutSystemdAnalyze`, a restricted PATH that has no systemd-analyze at all. */
  path(withoutSystemdAnalyze = false): string {
    const base = childEnv().PATH ?? '';
    if (!withoutSystemdAnalyze) return [this.bin, base].join(delimiter);
    const restricted = join(this.dir, '.gate-path-restricted');
    mkdirSync(restricted, { recursive: true });
    for (const dir of [this.bin, ...base.split(delimiter)]) {
      if (dir === '' || !existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        if (entry === 'systemd-analyze' || existsSync(join(restricted, entry))) continue;
        const candidate = join(dir, entry);
        try {
          if (!statSync(candidate).isFile() || !(statSync(candidate).mode & 0o111)) continue;
        } catch {
          continue;
        }
        symlinkSync(candidate, join(restricted, entry));
      }
    }
    return restricted;
  }

  gate(args: string[], options: { withoutSystemdAnalyze?: boolean; liveInventory?: string } = {}): Result {
    const env = childEnv();
    env.PATH = this.path(options.withoutSystemdAnalyze ?? false);
    if (options.liveInventory !== undefined) env.ATMUSIC_LIVE_INVENTORY = options.liveInventory;
    return exec('bash', ['scripts/acceptance/node-backend.sh', ...args], this.dir, env);
  }

  stub(name: 'check-ts' | 'goldens', status: number): void {
    if (name === 'check-ts') this.writeCheckTsStub(status);
    else this.writeGoldensStub(status);
  }

  /** Drop one mapped worker/test/node record from the vitest stub report (the case did not execute). */
  omitVitestTarget(target: string): void {
    const path = join(this.dir, '.gate-stubs/vitest-report.json');
    const report = JSON.parse(readFileSync(path, 'utf8')) as {
      numTotalTests: number;
      testResults: { name: string; assertionResults: { title: string }[] }[];
    };
    const file = report.testResults.find((f) => f.name === join(this.dir, prefixOf(target)));
    expect(file, target).toBeDefined();
    const before = file?.assertionResults.length ?? 0;
    if (file) file.assertionResults = file.assertionResults.filter((a) => a.title !== nameOf(target));
    expect(file?.assertionResults.length).toBe(before - 1);
    report.numTotalTests -= 1;
    writeFileSync(path, JSON.stringify(report));
  }

  calls(): string[] {
    const lines = existsSync(this.stubLog)
      ? readFileSync(this.stubLog, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
      : [];
    rmSync(this.stubLog, { force: true });
    return lines;
  }

  out(): string {
    return join(this.dir, 'work/acceptance/node-backend');
  }

  summary(out = this.out()): Summary {
    return JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as Summary;
  }

  jsonl<T>(name: string, out = this.out()): T[] {
    return readFileSync(join(out, name), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as T);
  }

  status(step: string, out = this.out()): string {
    return readFileSync(join(out, `${step}.status`), 'utf8').trim();
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const copies: DisposableCopy[] = [];
afterEach(() => {
  for (const copy of copies.splice(0)) copy.remove();
});

function freshCopy(): DisposableCopy {
  const copy = new DisposableCopy();
  copies.push(copy);
  return copy;
}

function stubNames(calls: string[]): string[] {
  return calls.map((c) => c.split('|')[0] ?? '');
}

describe('scripts/acceptance/node-backend.sh', () => {
  it(
    'node-backend.sh exits 1 when any step fails, when a mapped case did not execute, and on any --skip; it exits 2 on a usage error',
    () => {
      const before = gitStatus();
      const mapped = mappedTargets();
      const vitestTarget = mapped.refs.find((r) => prefixOf(r).startsWith('worker/test/node/'));
      expect(vitestTarget).toBeDefined();

      // 1. Every step passes: exit 0 with every mapped case executed and the live gates blocked, never passed.
      const copy = freshCopy();
      const pass = copy.gate([]);
      expect(pass.status, pass.stdout + pass.stderr).toBe(0);
      expect(pass.stdout).toMatch(
        /^PASS node-backend: .*live gate\(s\) and \d+ live case\(s\) are blocked, not passed$/m,
      );
      expect(pass.stdout).not.toMatch(/^FAIL acceptance:/m);
      const passed = copy.summary();
      expect(passed.gate).toBe('node-backend');
      expect(passed.result).toBe('passed');
      expect(passed.problems).toEqual([]);
      expect(passed.bundleSha256).toBe(BUNDLE_SHA);
      expect(Object.keys(passed.steps)).toEqual(STEPS);
      for (const step of STEPS) {
        expect(stepOf(passed, step).exit, step).toBe('0');
        expect(copy.status(step), step).toBe('0');
        expect(stepOf(passed, step).command, step).not.toBe('');
        expect(existsSync(join(copy.out(), `${step}.log`)), `${step}.log`).toBe(true);
        expect(existsSync(join(copy.out(), `${step}.command`)), `${step}.command`).toBe(true);
      }
      expect(pass.stdout).toMatch(/^==> check-ts: /m);
      expect(pass.stdout).toMatch(/^==> live: /m);
      expect(passed.cases.total).toBe(mapped.caseMap.length);
      expect(passed.cases.failed).toBe(0);
      expect(passed.cases.retired).toBe(mapped.caseMap.filter((c) => c.target.startsWith('retired:')).length);
      expect(passed.cases.passed + passed.cases.blocked + passed.cases.retired).toBe(passed.cases.total);
      expect(passed.cases.blocked).toBeGreaterThan(0);
      expect(passed.live.passed).toBe(0);
      expect(passed.live.failed).toBe(0);
      expect(passed.live.blocked).toBe(passed.liveGates.length);
      expect(passed.liveGates.length).toBeGreaterThan(0);
      for (const gate of passed.liveGates) expect(gate.result, gate.gate).toBe('blocked');
      expect(pass.stdout).toMatch(/^LIVE BLOCKED /m);
      expect(pass.stdout).not.toMatch(/^LIVE PASSED /m);
      expect(passed.tests.failed).toBe(0);
      expect(passed.tests.executed).toBeGreaterThan(0);
      for (const source of ['check-ts', 'node-tests', 'python', 'scrobbler-e2e', 'e2e']) {
        expect(passed.tests.bySource[source], source).toBeGreaterThan(0);
      }
      const cases = copy.jsonl<CaseRecord>('cases.jsonl');
      expect(cases.map((c) => c.case)).toEqual(mapped.caseMap.map((c) => c.case));
      for (const c of cases) {
        if (c.result === 'retired') continue;
        expect(c.count, c.case).toBeGreaterThan(0);
        expect(c.notRun, c.case).toBeUndefined();
        expect(c.failedTests, c.case).toBeUndefined();
        if (c.result === 'blocked') expect(c.blockedBy, c.case).toBeTruthy();
      }
      const tests = copy.jsonl<TestRecord>('tests.jsonl');
      expect(tests.length).toBe(passed.tests.passed + passed.tests.failed + passed.tests.skipped + passed.tests.todo);
      expect(tests.some((t) => t.target === vitestTarget && t.executed === 1 && t.result === 'passed')).toBe(true);
      expect(existsSync(join(copy.out(), '.node-backend-gate'))).toBe(true);
      expect(existsSync(join(copy.out(), 'live.json'))).toBe(true);
      const replayRecords = copy.jsonl<TestRecord>('scrobbler-e2e.jsonl');
      expect(replayRecords).toEqual(copy.jsonl<TestRecord>('scrobbler-e2e/scrobbler-e2e.jsonl'));
      expect(replayRecords.length).toBeGreaterThan(0);
      expect(tests.filter((t) => t.target.startsWith(`${SCROBBLER} › `))).toEqual(replayRecords);
      expect(cases.find((c) => c.case === 'M3.4.3/live_retries')?.result).toBe('passed');
      expect(cases.find((c) => c.case === 'M7.4.3/live_product')?.result).toBe('blocked');
      const calls = copy.calls();
      const names = stubNames(calls);
      expect(names.filter((n) => n === 'check-ts')).toHaveLength(1);
      expect(names.filter((n) => n === 'goldens')).toHaveLength(1);
      expect(names.filter((n) => n === 'scrobbler-e2e')).toHaveLength(1);
      expect(calls.find((c) => c.startsWith('scrobbler-e2e|'))).toBe(
        `scrobbler-e2e|--out ${join(copy.out(), 'scrobbler-e2e')}|${copy.dir}`,
      );
      expect(names.filter((n) => n === 'check-node-bundle')).toHaveLength(1);
      expect(names.filter((n) => n === 'systemd-analyze')).toHaveLength(1);
      expect(calls.find((c) => c.startsWith('systemd-analyze|'))).toContain(
        '--user verify config/systemd/atmusic.service config/systemd/atmusic.socket',
      );
      expect(
        calls.filter((c) => c.startsWith('npx|vitest run --project worker-node --project worker-acceptance')),
      ).toHaveLength(1);
      expect(calls.filter((c) => c.startsWith('npx|playwright test'))).toHaveLength(1);
      for (const call of calls) expect(call.endsWith(`|${copy.dir}`), call).toBe(true);

      // A zero-exit replay with only PASS log lines cannot reuse the preceding run's JSONL.
      copy.writeScrobblerStub('missing');
      const missingReplay = copy.gate([]);
      expect(missingReplay.status, missingReplay.stdout + missingReplay.stderr).toBe(1);
      expect(copy.status('scrobbler-e2e')).toBe('1');
      expect(copy.summary().tests.bySource['scrobbler-e2e']).toBe(0);
      expect(existsSync(join(copy.out(), 'scrobbler-e2e.jsonl'))).toBe(false);
      expect(existsSync(join(copy.out(), 'scrobbler-e2e/scrobbler-e2e.jsonl'))).toBe(false);
      expect(copy.jsonl<CaseRecord>('cases.jsonl').find((c) => c.case === 'M3.4.3/live_retries')?.notRun).toEqual(
        mapped.refs.filter((r) => prefixOf(r) === SCROBBLER),
      );
      copy.calls();

      // Failed JSONL records are ingested even when the replay process exits nonzero.
      copy.writeScrobblerStub('failed');
      const failedReplay = copy.gate([]);
      expect(failedReplay.status, failedReplay.stdout + failedReplay.stderr).toBe(1);
      expect(copy.summary().tests.bySource['scrobbler-e2e']).toBe(replayRecords.length);
      expect(copy.jsonl<CaseRecord>('cases.jsonl').find((c) => c.case === 'M3.4.3/live_retries')?.failedTests).toEqual(
        mapped.refs.filter((r) => prefixOf(r) === SCROBBLER),
      );
      copy.calls();
      copy.writeScrobblerStub();

      // 2. systemd-analyze unavailable: the deterministic step is blocked, never passed, and the gate fails.
      const blocked = copy.gate([], { withoutSystemdAnalyze: true });
      expect(blocked.status, blocked.stdout + blocked.stderr).toBe(1);
      expect(blocked.stdout).toMatch(/^==> systemd: /m);
      expect(blocked.stdout).toMatch(/BLOCKED after \d+s/);
      const blockedSummary = copy.summary();
      expect(blockedSummary.result).toBe('failed');
      expect(stepOf(blockedSummary, 'systemd').exit).toBe('blocked');
      expect(copy.status('systemd')).toBe('blocked');
      expect(
        blockedSummary.problems.some((p) =>
          /^step systemd is blocked \(.*\); a blocked deterministic step is never a pass$/.test(p),
        ),
      ).toBe(true);
      expect(blocked.stdout).toMatch(/^FAIL acceptance: step systemd is blocked/m);
      expect(blocked.stdout).toMatch(/^FAIL node-backend: /m);
      expect(blockedSummary.live.passed).toBe(0);
      expect(stubNames(copy.calls())).not.toContain('systemd-analyze');

      // 3. A failing step (goldens stub exit 1) fails the gate and names the step and its command.
      copy.stub('goldens', 1);
      const failing = copy.gate([]);
      expect(failing.status, failing.stdout + failing.stderr).toBe(1);
      const failedSummary = copy.summary();
      expect(failedSummary.result).toBe('failed');
      expect(stepOf(failedSummary, 'goldens').exit).toBe('1');
      expect(failedSummary.problems).toContain('step goldens (bash scripts/check_goldens.sh) exited 1');
      expect(failing.stdout).toMatch(/^FAIL acceptance: step goldens \(bash scripts\/check_goldens\.sh\) exited 1$/m);
      expect(stepOf(failedSummary, 'systemd').exit).toBe('0');
      copy.stub('goldens', 0);
      copy.calls();

      // 4. A mapped case whose test did not execute fails the gate even though every step exits 0.
      const omitted = freshCopy();
      omitted.omitVitestTarget(vitestTarget as string);
      const notRun = omitted.gate([]);
      expect(notRun.status, notRun.stdout + notRun.stderr).toBe(1);
      const notRunSummary = omitted.summary();
      for (const step of STEPS) expect(stepOf(notRunSummary, step).exit, step).toBe('0');
      expect(notRunSummary.result).toBe('failed');
      const omittedCases = mapped.caseMap.filter((c) => [c.target, ...(c.also ?? [])].includes(vitestTarget as string));
      expect(omittedCases.length).toBeGreaterThan(0);
      for (const c of omittedCases) {
        expect(
          notRunSummary.problems.some((p) => p.startsWith(`case ${c.case}: not executed: `)),
          c.case,
        ).toBe(true);
      }
      expect(notRun.stdout).toMatch(/^FAIL acceptance: case .*: not executed: /m);
      const notRunCases = omitted.jsonl<CaseRecord>('cases.jsonl');
      const omittedCase = omittedCases[0]?.case;
      const recorded = notRunCases.find((c) => c.case === omittedCase);
      expect(recorded?.result).toBe('failed');
      expect(recorded?.notRun?.some((n) => n.includes(vitestTarget as string))).toBe(true);
      // Self-referencing gate cases also fail when any mapped case did not run.
      const selfCases = mapped.caseMap.filter((c) => [c.target, ...(c.also ?? [])].some((r) => prefixOf(r) === SELF));
      expect(notRunSummary.cases.failed).toBe(new Set([...omittedCases, ...selfCases].map((c) => c.case)).size);

      // 5. A gate-level failure diagnostic in an inventory that is not release/prerequisite-bound stays blocked.
      const inventoryCopy = freshCopy();
      const sourceCommit = exec('git', ['rev-parse', 'HEAD'], inventoryCopy.dir).stdout.trim();
      const inventoryPath = join(inventoryCopy.dir, 'work/unbound-failure.json');
      mkdirSync(join(inventoryCopy.dir, 'work'), { recursive: true });
      writeFileSync(
        inventoryPath,
        JSON.stringify({
          schemaVersion: 3,
          runtime: 'node',
          fixtureOnly: false,
          release: { commit: sourceCommit, bundleSha256: BUNDLE_SHA },
          prerequisites: {
            ownedLexiconPrefix: 'dev.pythonplayer123.music',
            publicHttpsOrigin: 'https://music.214510.xyz',
            jetstreamCoverageVerified: false,
          },
          gates: {
            pdsCompat: {
              schemaVersion: 3,
              runtime: 'node',
              fixtureOnly: false,
              gate: 'pdsCompat',
              result: 'failed',
              recordedAt: '2026-11-04T00:00:00Z',
              testCommand: 'operator-run pds compatibility probe',
              commit: sourceCommit,
              bundleSha256: BUNDLE_SHA,
              origin: 'https://music.214510.xyz',
              lexiconPrefix: 'dev.pythonplayer123.music',
              failures: ['fixture diagnostic failure'],
              cleanup: 'no records created',
            },
          },
        }),
      );
      const unboundFailure = inventoryCopy.gate([], { liveInventory: inventoryPath });
      expect(unboundFailure.status, unboundFailure.stdout + unboundFailure.stderr).toBe(0);
      expect(inventoryCopy.status('live')).toBe('0');
      const unboundSummary = inventoryCopy.summary();
      expect(unboundSummary.liveGates.find((g) => g.gate === 'pdsCompat')?.result).toBe('blocked');
      expect(unboundSummary.live.failed).toBe(0);
      expect(unboundSummary.live.blocked).toBe(unboundSummary.liveGates.length);
      expect(unboundSummary.problems).toEqual([]);
      expect(unboundSummary.liveGates.find((g) => g.gate === 'pdsCompat')?.message).toContain(
        'the pdsCompat=failed diagnostic is not attributable',
      );
      inventoryCopy.calls();

      // 6. --skip disables a step: it is recorded as skipped and the gate fails; other steps still run.
      const skipped = copy.gate(['--skip', 'goldens', '--skip', 'e2e', '--skip', 'scrobbler-e2e']);
      expect(skipped.status, skipped.stdout + skipped.stderr).toBe(1);
      expect(skipped.stdout).toMatch(/^==> goldens: SKIPPED \(--skip goldens; a disabled step fails the gate\)$/m);
      const skippedSummary = copy.summary();
      expect(skippedSummary.result).toBe('failed');
      expect(stepOf(skippedSummary, 'goldens').exit).toBe('skipped');
      expect(stepOf(skippedSummary, 'e2e').exit).toBe('skipped');
      expect(copy.status('goldens')).toBe('skipped');
      expect(stepOf(skippedSummary, 'check-ts').exit).toBe('0');
      expect(stepOf(skippedSummary, 'systemd').exit).toBe('0');
      expect(skippedSummary.problems).toContain(
        'step goldens was disabled with --skip; a disabled step is never a pass',
      );
      expect(skippedSummary.problems).toContain('step e2e was disabled with --skip; a disabled step is never a pass');
      expect(skippedSummary.problems.some((p) => /^case .*: not executed: /.test(p))).toBe(true);
      expect(skippedSummary.tests.bySource.e2e).toBe(0);
      expect(skippedSummary.tests.bySource['scrobbler-e2e']).toBe(0);
      expect(stubNames(copy.calls())).not.toContain('goldens');

      // 7. Usage errors exit 2 before any step runs.
      for (const args of [['--bogus'], ['--skip', 'deploy'], ['--skip'], ['--out'], ['extra']]) {
        const usage = copy.gate(args);
        expect(usage.status, args.join(' ')).toBe(2);
        expect(usage.stderr, args.join(' ')).toMatch(/^usage: /m);
        expect(usage.stdout, args.join(' ')).not.toMatch(/^==> /m);
      }
      expect(copy.calls()).toEqual([]);

      // 8. --out refuses a non-empty directory this gate did not create, and leaves it untouched.
      const foreign = join(copy.dir, 'work/foreign-out');
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, 'keep.txt'), 'user data\n');
      const refused = copy.gate(['--out', foreign]);
      expect(refused.status, refused.stdout + refused.stderr).toBe(2);
      expect(refused.stderr).toMatch(
        /^node-backend: refusing --out .*foreign-out: it is not empty and was not created by this gate/m,
      );
      expect(readdirSync(foreign)).toEqual(['keep.txt']);
      expect(readFileSync(join(foreign, 'keep.txt'), 'utf8')).toBe('user data\n');
      expect(copy.calls()).toEqual([]);

      // An unignored in-checkout output path would break the replay's clean-source requirement.
      const dirtyOutputPath = join(copy.dir, 'fresh-out');
      const dirtyOutput = copy.gate(['--out', dirtyOutputPath]);
      expect(dirtyOutput.status, dirtyOutput.stdout + dirtyOutput.stderr).toBe(2);
      expect(dirtyOutput.stderr).toContain('output inside the source checkout must be git-ignored');
      expect(existsSync(dirtyOutputPath)).toBe(false);
      expect(copy.calls()).toEqual([]);

      // A fresh output directory under git-ignored work/ is accepted and gate-owned.
      const fresh = copy.gate(['--out', 'work/fresh-out', '--skip', 'live']);
      expect(fresh.status, fresh.stdout + fresh.stderr).toBe(1);
      const freshOut = join(copy.dir, 'work/fresh-out');
      expect(existsSync(join(freshOut, '.node-backend-gate'))).toBe(true);
      expect(stepOf(copy.summary(freshOut), 'live').exit).toBe('skipped');
      expect(copy.jsonl<TestRecord>('scrobbler-e2e/scrobbler-e2e.jsonl', freshOut)).toEqual(
        copy.jsonl<TestRecord>('scrobbler-e2e.jsonl', freshOut),
      );
      expect(copy.summary(freshOut).problems).toContain(
        'step live was disabled with --skip; a disabled step is never a pass',
      );
      for (const gate of copy.summary(freshOut).liveGates) expect(gate.result, gate.gate).toBe('blocked');
      copy.calls();

      expect(gitStatus()).toBe(before);
    },
    TIMEOUT,
  );
});
