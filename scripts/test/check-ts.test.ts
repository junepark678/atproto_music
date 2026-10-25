// Disposable-copy negative controls for the TypeScript gate, scripts/check-ts.sh
// (ADR 0004 A18; plan cases M1.2.2/ci_format_failure, M1.2.2/ci_assertion_failure,
// M7.1.1/strict_type_failure and M7.1.1/web_build), and the Node port's gate
// changes (ADR 0005 §15.1, N0-01): the worker-node project, core under Node, the
// Node build and bundle-guard steps, `--projects` and work/gate-durations.json.
//
// Gate duration (ADR 0005 §15.1): every control that runs the nested gate
// limits its vitest step with `--projects <the project it exercises>` and has a
// 180 s timeout (GATE_TIMEOUT), instead of running a second full gate.
//
// Every test copies the repository (tracked plus untracked, non-ignored files,
// as `git ls-files` lists them) into a fresh temporary directory, breaks the
// copy, runs the real gate commands there, and asserts both the failure and
// that the real working tree is byte-for-byte unchanged. The copy never
// contains this file, so the gate it runs cannot recurse into these tests.
//
// Copies other than the npm ci one get a node_modules whose entries link to the
// repository's installed packages, except the @atmusic workspace links, which
// point at the copy's own packages so that tsc, biome and vitest see the copy's
// sources. No test touches the network: npm ci runs with --offline, from the
// npm cache that the CI job's own `npm ci` (or a local install) filled.

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = 'scripts/test/check-ts.test.ts';
/** Tests that install, build or typecheck a copy without running the nested gate. */
const TIMEOUT = 15 * 60_000;
/** Every nested negative control: a `scripts/check-ts.sh` run limited by --projects (ADR 0005 §15.1). */
const GATE_TIMEOUT = 180_000;
const WORKSPACES: Record<string, string> = {
  core: 'packages/core',
  atproto: 'packages/atproto',
  worker: 'worker',
  web: 'web',
};

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout then stderr. */
  output: string;
}

/**
 * The environment for commands in a copy: this process's environment without
 * the variables that npm and vitest set for the outer run (npm_config_* would
 * point nested npm commands at the real repository's prefix).
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|VITEST|INIT_CWD$|NODE_ENV$|TEST$|NODE_OPTIONS$)/.test(key)) continue;
    env[key] = value;
  }
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.CI = 'true';
  // The copy's own fresh git repository has no main checkout, so check-ts.sh
  // there cannot find the pinned contract-validator venv the way it does in a
  // worktree. Activate the one the real tree's gate uses (an active venv,
  // ./.venv, or the main checkout's .venv), so a nested gate that reaches the
  // contracts step runs it as the outer gate does.
  const venv = contractsVenv();
  if (venv !== undefined && env.VIRTUAL_ENV === undefined) {
    env.VIRTUAL_ENV = venv;
    env.PATH = `${join(venv, 'bin')}:${env.PATH ?? ''}`;
  }
  return env;
}

let venvCache: { path: string | undefined } | undefined;
function contractsVenv(): string | undefined {
  if (venvCache === undefined) {
    const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const candidates = [
      process.env.VIRTUAL_ENV,
      join(ROOT, '.venv'),
      common.status === 0 ? join(common.stdout.trim(), '..', '.venv') : undefined,
    ];
    const found = candidates.find((c) => c !== undefined && existsSync(join(c, 'bin', 'activate')));
    venvCache = { path: found === undefined ? undefined : realpathSync(found) };
  }
  return venvCache.path;
}

function exec(command: string, args: string[], cwd: string): Result {
  const r: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd,
    env: childEnv(),
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: r.stdout + r.stderr };
}

/** Repository-relative paths of tracked and untracked, non-ignored files that exist. */
function repositoryFiles(): string[] {
  const r = exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], ROOT);
  expect(r.status, r.stderr).toBe(0);
  const files = [...new Set(r.stdout.split('\0').filter((f) => f !== ''))].sort();
  return files.filter((f) => {
    try {
      lstatSync(join(ROOT, f));
      return true;
    } catch {
      return false; // tracked but deleted in the working tree
    }
  });
}

/** A digest of the real working tree: git status plus every listed file's path and bytes. */
function fingerprint(): string {
  const hash = createHash('sha256');
  const status = exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ROOT);
  expect(status.status, status.stderr).toBe(0);
  hash.update(status.stdout);
  for (const file of repositoryFiles()) {
    const path = join(ROOT, file);
    hash.update(`${file}\0`);
    hash.update(lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

class DisposableCopy {
  readonly dir: string;

  constructor(options: { linkNodeModules: boolean }) {
    this.dir = mkdtempSync(join(tmpdir(), 'atmusic-check-ts-'));
    // The copy must be outside the repository, or tools would walk up into it.
    expect(relative(ROOT, this.dir).startsWith('..')).toBe(true);
    const files = repositoryFiles().filter((f) => f !== SELF);
    expect(files).toContain('scripts/check-ts.sh');
    for (const file of files) {
      const from = join(ROOT, file);
      const to = join(this.dir, file);
      mkdirSync(dirname(to), { recursive: true });
      const stat = lstatSync(from);
      if (stat.isSymbolicLink()) {
        symlinkSync(readlinkSync(from), to);
      } else {
        copyFileSync(from, to);
        chmodSync(to, stat.mode & 0o777);
      }
    }
    expect(existsSync(join(this.dir, SELF))).toBe(false);
    // An empty git repository (no commit), so tests run by the copied gate
    // that list files with `git ls-files --others --exclude-standard`
    // (scripts/test/deploy.test.ts) see the copy's files as in a checkout.
    const init = exec('git', ['init', '-q'], this.dir);
    expect(init.status, init.stderr).toBe(0);
    if (options.linkNodeModules) this.linkNodeModules();
  }

  private linkNodeModules(): void {
    const source = join(ROOT, 'node_modules');
    expect(existsSync(source), 'run npm ci before the gate tests').toBe(true);
    const target = join(this.dir, 'node_modules');
    mkdirSync(target);
    for (const entry of readdirSync(source)) {
      // Caches stay per copy; the workspace links are recreated below.
      if (entry === '@atmusic' || entry === '.package-lock.json' || entry.startsWith('.vite')) continue;
      symlinkSync(join(source, entry), join(target, entry));
    }
    mkdirSync(join(target, '@atmusic'));
    for (const [name, dir] of Object.entries(WORKSPACES)) {
      symlinkSync(join('..', '..', dir), join(target, '@atmusic', name));
      expect(realpathSync(join(target, '@atmusic', name))).toBe(realpathSync(join(this.dir, dir)));
    }
  }

  path(file: string): string {
    return join(this.dir, file);
  }

  read(file: string): string {
    return readFileSync(this.path(file), 'utf8');
  }

  write(file: string, text: string): void {
    mkdirSync(dirname(this.path(file)), { recursive: true });
    writeFileSync(this.path(file), text);
  }

  /** Replaces exactly one occurrence of `from`, failing if it is absent or ambiguous. */
  replaceOnce(file: string, from: string, to: string): void {
    const text = this.read(file);
    expect(text.split(from).length - 1, `${file}: occurrences of ${JSON.stringify(from)}`).toBe(1);
    this.write(file, text.replace(from, to));
  }

  run(command: string, ...args: string[]): Result {
    return exec(command, args, this.dir);
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

interface JsonReport {
  numFailedTests: number;
  numPassedTests: number;
  success: boolean;
  testResults: { name: string; assertionResults: { title: string; status: string }[] }[];
}

function readReport(path: string): JsonReport {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonReport;
}

const failedTitles = (report: JsonReport) =>
  report.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'failed').map((a) => a.title));

const copies: DisposableCopy[] = [];
function disposableCopy(options: { linkNodeModules: boolean }): DisposableCopy {
  const copy = new DisposableCopy(options);
  copies.push(copy);
  return copy;
}

afterEach(() => {
  for (const copy of copies.splice(0)) copy.dispose();
});

/** work/gate-durations.json as scripts/check-ts.sh writes it. */
interface GateDurations {
  schemaVersion: number;
  projects: string[] | null;
  result: 'passed' | 'failed';
  exitCode: number;
  totalSeconds: number;
  steps: { name: string; seconds: number; status: 'passed' | 'failed' }[];
}

/** One nested `check-ts.sh` run of this file, with its wall-clock time. */
interface GateRun {
  test: string;
  args: string[];
  seconds: number;
}
/** Every nested gate run of this file so far, in order (the duration test checks them). */
const gateRuns: GateRun[] = [];

/** Runs the copy's `scripts/check-ts.sh` with `args` and records its wall-clock time. */
function runGate(copy: DisposableCopy, test: string, ...args: string[]): Result & { seconds: number } {
  const start = performance.now();
  const result = copy.run('bash', 'scripts/check-ts.sh', ...args);
  const seconds = (performance.now() - start) / 1000;
  gateRuns.push({ test, args, seconds });
  return { ...result, seconds };
}

/** The `==> <step>` headings check-ts.sh printed, in order. */
const stepHeadings = (output: string) => [...output.matchAll(/^==> (.+)$/gm)].map((m) => m[1]!);

// A typed consumer of an API payload (api/examples/meta.json).
const PROBE = 'packages/core/test/strict-type-probe.ts';
const probe = (lagSeconds: string) => `import type { Meta } from '../src/api-types';

export const meta: Meta = {
  name: 'atproto_music',
  version: '0.1.0',
  stage: 'backend',
  capabilities: ['read', 'stats', 'follows', 'notify', 'indexing'],
  lexiconPrefix: null,
  indexing: { state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: ${lagSeconds} },
};
`;

// Resolves the workspace's projects the way `npm test` does, in a child Node
// process (a Vitest instance inside this test run would inherit its state).
const RESOLVE_PROJECTS = `
import { createVitest } from 'vitest/node';
const vitest = await createVitest('test', { watch: false, run: true, root: process.cwd() });
const files = {};
for (const spec of await vitest.globTestSpecifications()) {
  (files[spec.project.name] ||= []).push(spec.moduleId);
}
const projects = vitest.projects.map((p) => ({
  name: p.name,
  environment: p.config.environment,
  groupOrder: p.config.sequence.groupOrder,
  files: (files[p.name] || []).map((f) => f.slice(process.cwd().length + 1)).sort(),
}));
await vitest.close();
process.stdout.write(JSON.stringify(projects));
`;

interface ResolvedProject {
  name: string;
  environment: string;
  groupOrder: number;
  files: string[];
}

/** The vitest projects of the tree at `cwd`, resolved as `npm test` resolves them. */
function resolveProjects(cwd: string): Map<string, ResolvedProject> {
  const r = exec('node', ['--input-type=module', '-e', RESOLVE_PROJECTS], cwd);
  expect(r.status, r.output).toBe(0);
  const projects = JSON.parse(r.stdout) as ResolvedProject[];
  return new Map(projects.map((p) => [p.name, p]));
}

describe('scripts/check-ts.sh', () => {
  it('the nested gate runs alone in the last sequence group, after worker-modules', () => {
    const byName = resolveProjects(ROOT);
    const projects = [...byName.values()];
    const gate = byName.get('scripts-gate');
    const modules = byName.get('worker-modules');
    expect(gate?.files).toEqual([SELF]);
    expect(modules?.files.length).toBeGreaterThan(0);
    for (const p of projects) {
      if (p.name === 'scripts-gate') continue;
      // No other project runs this file, and none shares or follows its group:
      // the nested `check-ts.sh` (a full vitest run with 5 s default timeouts
      // and its own workers) never competes with another project for CPU.
      expect(p.files, p.name).not.toContain(SELF);
      expect(p.groupOrder, p.name).toBeLessThan(gate?.groupOrder ?? Number.NEGATIVE_INFINITY);
      // worker-modules (the 5 s-timeout unit tests) shares its group with no
      // project that spawns toolchains or indexes bench fixtures; worker-node
      // (ADR 0005 §15.1, the other 5 s-timeout unit tests) is the one project
      // placed with it.
      if (p.name !== 'worker-modules' && p.name !== 'worker-node') {
        expect(p.groupOrder, p.name).not.toBe(modules?.groupOrder);
      }
    }
    expect(byName.get('worker-node')?.groupOrder).toBe(modules?.groupOrder);
    expect(byName.get('scripts')?.files).toContain('scripts/test/deploy.test.ts');
    expect(byName.get('scripts')?.groupOrder).toBeLessThan(modules?.groupOrder ?? 0);
  });

  it(
    'a misformatted file in a disposable copy fails the biome step and leaves the repository unchanged',
    () => {
      const before = fingerprint();
      const original = readFileSync(join(ROOT, 'worker/src/config.ts'), 'utf8');
      const copy = disposableCopy({ linkNodeModules: true });

      // Control: the unmodified copy passes the biome step.
      const clean = copy.run('npm', 'run', '--silent', 'lint');
      expect(clean.status, clean.output).toBe(0);

      // Formatting only (spacing and quote style): it still typechecks and means the same.
      const misformatted = 'export   const FIXTURE_PREFIX   =   "com.example.atmusic"  ;';
      copy.replaceOnce('worker/src/config.ts', "export const FIXTURE_PREFIX = 'com.example.atmusic';", misformatted);

      // The gate stops at biome, before its test step; --projects only keeps a
      // regression (biome passing) from turning into a second full vitest run.
      const gate = runGate(copy, 'misformatted file', '--projects', 'worker-node');
      expect(gate.status, gate.output).not.toBe(0);
      // It got past typecheck and stopped at biome, naming the file and the formatter.
      expect(gate.output).toContain('==> typecheck (tsc -b)');
      expect(gate.output).toContain('==> lint (biome)');
      expect(gate.output).not.toContain('==> test (vitest');
      expect(gate.output).not.toContain('PASS check-ts');
      expect(gate.output).toMatch(/worker\/src\/config\.ts format/);
      expect(gate.output).toContain('Formatter would have printed the following content');
      // The gate reports; it does not rewrite the file.
      expect(copy.read('worker/src/config.ts')).toContain(misformatted);

      // The repository itself is untouched.
      expect(readFileSync(join(ROOT, 'worker/src/config.ts'), 'utf8')).toBe(original);
      expect(fingerprint()).toBe(before);
    },
    GATE_TIMEOUT,
  );

  it(
    'an inverted assertion in a disposable copy makes check-ts.sh exit nonzero',
    () => {
      const before = fingerprint();
      const copy = disposableCopy({ linkNodeModules: true });
      const file = 'worker/test/storage/migrate.test.ts';
      const title = 'fresh DO applies migration 1 and seeds indexing_status/backfill_generation/ingest_checkpoint';

      // Control: unmodified, the readiness test passes in the copy.
      const control = copy.run('npx', 'vitest', 'run', file, '--reporter=json', '--outputFile=work/control.json');
      expect(control.status, control.output).toBe(0);
      const controlReport = readReport(copy.path('work/control.json'));
      expect(controlReport.numFailedTests).toBe(0);
      expect(
        controlReport.testResults.flatMap((f) => f.assertionResults.map((a) => [a.title, a.status])),
      ).toContainEqual([title, 'passed']);

      // Invert the readiness assertion: the migrated harness DO answers 200.
      copy.replaceOnce(
        file,
        "harness/migrate-fresh');\n    expect(res.status).toBe(200);",
        "harness/migrate-fresh');\n    expect(res.status).not.toBe(200);",
      );

      // The nested run is limited to the project this file belongs to (ADR 0005 §15.1).
      const gate = runGate(copy, 'inverted assertion', '--projects', 'worker-modules');
      expect(gate.status, gate.output).not.toBe(0);
      expect(gate.output).toContain('==> test (vitest, projects: worker-modules)');
      expect(gate.output).toContain(`FAILED ${file} › migrate › ${title}`);
      expect(gate.output).toMatch(/FAIL report-tests: 1 test\(s\) failed/);
      // The run cannot be marked green: later steps never ran.
      expect(gate.output).not.toContain('==> contracts');
      expect(gate.output).not.toContain('PASS check-ts');

      // The gate's own report shows exactly the inverted test failing among executed tests.
      const report = readReport(copy.path('work/ts-test-report.json'));
      expect(report.success).toBe(false);
      expect(failedTitles(report)).toEqual([title]);
      expect(report.numPassedTests).toBeGreaterThan(0);
      const cases = copy
        .read('work/ts-test-cases.jsonl')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { target: string; result: string });
      expect(cases.filter((c) => c.result === 'failed').map((c) => c.target)).toEqual([`${file} › migrate › ${title}`]);

      expect(fingerprint()).toBe(before);
    },
    GATE_TIMEOUT,
  );

  it(
    'a wrong API field type in a disposable copy fails tsc -b',
    () => {
      const before = fingerprint();
      const copy = disposableCopy({ linkNodeModules: true });

      // Control: a correctly typed consumer typechecks.
      copy.write(PROBE, probe('0'));
      const ok = copy.run('npx', 'tsc', '-b');
      expect(ok.status, ok.output).toBe(0);

      // A wrong field type in the consumer fails tsc -b at that field.
      copy.write(PROBE, probe("'0'"));
      const wrongValue = copy.run('npx', 'tsc', '-b');
      expect(wrongValue.status, wrongValue.output).not.toBe(0);
      expect(wrongValue.output).toMatch(/packages\/core\/test\/strict-type-probe\.ts\(9,\d+\): error TS2322/);
      expect(wrongValue.output).toContain("Type 'string' is not assignable to type 'number'");

      // A wrong field type in the API contract module fails the correct consumer.
      copy.write(PROBE, probe('0'));
      copy.replaceOnce(
        'packages/core/src/api-types.ts',
        '  lagSeconds: number | null;',
        '  lagSeconds: string | null;',
      );
      const wrongContract = copy.run('npx', 'tsc', '-b');
      expect(wrongContract.status, wrongContract.output).not.toBe(0);
      expect(wrongContract.output).toMatch(/packages\/core\/test\/strict-type-probe\.ts\(9,\d+\): error TS2322/);
      expect(wrongContract.output).toContain("Type 'number' is not assignable to type 'string'");
      copy.replaceOnce(
        'packages/core/src/api-types.ts',
        '  lagSeconds: string | null;',
        '  lagSeconds: number | null;',
      );

      // No any-cast bypass: the cast silences tsc, but the gate's biome step rejects it.
      copy.write(PROBE, probe("'0' as any"));
      const cast = copy.run('npx', 'tsc', '-b');
      expect(cast.status, cast.output).toBe(0);
      const lint = copy.run('npm', 'run', '--silent', 'lint');
      expect(lint.status, lint.output).not.toBe(0);
      expect(lint.output).toContain('noExplicitAny');
      expect(lint.output).toContain('strict-type-probe.ts');

      expect(fingerprint()).toBe(before);
    },
    TIMEOUT,
  );

  it(
    'a worker/src file that reads the test-only HARNESS binding fails tsc -b in a disposable copy',
    () => {
      const before = fingerprint();
      const copy = disposableCopy({ linkNodeModules: true });
      const reader = "import { env } from 'cloudflare:workers';\n\nexport const harness = env.HARNESS;\n";

      // Control: test code sees the harness's Cloudflare.Env augmentation.
      copy.write('worker/test/harness/env-probe.ts', reader);
      const test = copy.run('npx', 'tsc', '-b');
      expect(test.status, test.output).toBe(0);

      // Production code does not: the augmentation stays out of its typecheck.
      copy.write('worker/src/env-probe.ts', reader);
      const src = copy.run('npx', 'tsc', '-b');
      expect(src.status, src.output).not.toBe(0);
      expect(src.output).toMatch(/worker\/src\/env-probe\.ts\(3,\d+\): error TS2339/);
      expect(src.output).toContain("Property 'HARNESS' does not exist");
      expect(src.output).not.toContain('worker/test/harness/env-probe.ts');

      expect(fingerprint()).toBe(before);
    },
    TIMEOUT,
  );

  it(
    'npm ci, tsc -b and the web production build pass and leave package-lock.json unchanged',
    () => {
      const before = fingerprint();
      const lock = sha256(join(ROOT, 'package-lock.json'));
      const manifest = sha256(join(ROOT, 'package.json'));
      const copy = disposableCopy({ linkNodeModules: false });
      expect(existsSync(copy.path('node_modules'))).toBe(false);
      expect(sha256(copy.path('package-lock.json'))).toBe(lock);

      const install = copy.run('npm', 'ci', '--offline', '--no-audit', '--no-fund');
      expect(install.status, install.output).toBe(0);
      // The workspaces are linked to the copy's own packages.
      for (const [name, dir] of Object.entries(WORKSPACES)) {
        expect(realpathSync(copy.path(`node_modules/@atmusic/${name}`))).toBe(realpathSync(copy.path(dir)));
      }

      const typecheck = copy.run('npx', 'tsc', '-b');
      expect(typecheck.status, typecheck.output).toBe(0);
      expect(existsSync(copy.path('.tsbuild/tsconfig.tsbuildinfo'))).toBe(true);
      expect(existsSync(copy.path('worker/test/.tsbuild/tsconfig.tsbuildinfo'))).toBe(true);

      const build = copy.run('npm', 'run', 'build:web');
      expect(build.status, build.output).toBe(0);
      expect(readFileSync(copy.path('web/dist/index.html'), 'utf8')).toMatch(/<html/i);

      // Neither step rewrote the lockfile or the root manifest.
      expect(sha256(copy.path('package-lock.json'))).toBe(lock);
      expect(sha256(copy.path('package.json'))).toBe(manifest);
      expect(sha256(join(ROOT, 'package-lock.json'))).toBe(lock);
      expect(fingerprint()).toBe(before);
    },
    TIMEOUT,
  );

  // ADR 0005 §15.1 (N0-01) from here on.

  it(
    'the gate runs the worker-node project and fails with its status when a worker-node test fails in the disposable copy, with the nested run limited by --projects worker-node',
    () => {
      const before = fingerprint();
      const copy = disposableCopy({ linkNodeModules: true });
      const file = 'worker/test/node/scaffold.test.ts';
      const title = 'the installed undici version equals process.versions.undici';
      const target = `${file} › worker-node scaffold › ${title}`;

      // The full gate's vitest step includes worker-node, a plain-Node project
      // (environment 'node') that owns test/node/**; worker-modules does not run it.
      const projects = resolveProjects(copy.dir);
      expect(projects.get('worker-node')?.environment).toBe('node');
      expect(projects.get('worker-node')?.files).toContain(file);
      expect(projects.get('worker-modules')?.files).not.toContain(file);

      // Invert one worker-node assertion.
      copy.replaceOnce(
        file,
        'expect(installed.version).toBe(process.versions.undici);',
        'expect(installed.version).not.toBe(process.versions.undici);',
      );

      const gate = runGate(copy, 'worker-node failure', '--projects', 'worker-node');
      // check-ts.sh exits with vitest's own status (1 for failed tests), not just "nonzero".
      expect(gate.status, gate.output).toBe(1);
      expect(gate.output).toContain('vitest exited with status 1');
      expect(stepHeadings(gate.output)).toEqual([
        'typecheck (tsc -b)',
        'lint (biome)',
        'test (vitest, projects: worker-node)',
      ]);
      expect(gate.output).toContain(`FAILED ${target}`);
      expect(gate.output).toMatch(/FAIL report-tests: 1 test\(s\) failed/);
      expect(gate.output).not.toContain('PASS check-ts');

      // The nested run executed the worker-node project only: every result is a
      // test/node file, with exactly the inverted test failing.
      const report = readReport(copy.path('work/ts-test-report.json'));
      expect(report.success).toBe(false);
      expect(failedTitles(report)).toEqual([title]);
      const files = report.testResults.map((f) => relative(realpathSync(copy.dir), realpathSync(f.name)));
      expect(files).toContain(file);
      for (const f of files) expect(f.startsWith('worker/test/node/'), f).toBe(true);
      expect(report.numPassedTests).toBeGreaterThanOrEqual(3);
      const cases = copy
        .read('work/ts-test-cases.jsonl')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { target: string; command: string; result: string });
      expect(cases.filter((c) => c.result === 'failed').map((c) => c.target)).toEqual([target]);
      expect(new Set(cases.map((c) => c.command))).toEqual(new Set(['npm test -- --project worker-node']));

      // The duration report ends at the failed step with the same status.
      const durations = JSON.parse(copy.read('work/gate-durations.json')) as GateDurations;
      expect(durations.result).toBe('failed');
      expect(durations.exitCode).toBe(1);
      expect(durations.projects).toEqual(['worker-node']);
      expect(durations.steps.map((s) => [s.name, s.status])).toEqual([
        ['typecheck (tsc -b)', 'passed'],
        ['lint (biome)', 'passed'],
        ['test (vitest, projects: worker-node)', 'failed'],
      ]);

      expect(fingerprint()).toBe(before);
    },
    GATE_TIMEOUT,
  );

  it(
    'the core project reports environment node and still executes all of its tests',
    () => {
      const before = fingerprint();
      // The resolved config: core runs in plain Node, not in workerd.
      const core = resolveProjects(ROOT).get('core');
      expect(core?.environment).toBe('node');
      const declared = readdirSync(join(ROOT, 'packages/core/test'))
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => `packages/core/test/${f}`)
        .sort();
      expect(declared.length).toBeGreaterThanOrEqual(13);
      expect(core?.files).toEqual(declared);

      // An actual run in a disposable copy executes every one of its 47 tests,
      // all passing, none skipped, in every test file.
      const copy = disposableCopy({ linkNodeModules: true });
      const run = copy.run(
        'npx',
        'vitest',
        'run',
        '--project',
        'core',
        '--reporter=json',
        '--outputFile=work/core.json',
      );
      expect(run.status, run.output).toBe(0);
      const report = JSON.parse(copy.read('work/core.json')) as JsonReport & {
        numTotalTests: number;
        numPendingTests: number;
        numTodoTests: number;
      };
      expect(report.success).toBe(true);
      expect(report.numTotalTests).toBe(47);
      expect(report.numPassedTests).toBe(47);
      expect(report.numFailedTests).toBe(0);
      expect(report.numPendingTests).toBe(0);
      expect(report.numTodoTests).toBe(0);
      const byFile = new Map(
        report.testResults.map((f) => [
          relative(realpathSync(copy.dir), realpathSync(f.name)),
          f.assertionResults.map((a) => a.status),
        ]),
      );
      expect([...byFile.keys()].sort()).toEqual(declared);
      for (const [file, statuses] of byFile) {
        expect(statuses.length, file).toBeGreaterThan(0);
        expect(new Set(statuses), file).toEqual(new Set(['passed']));
      }
      // The runtime-neutral Unicode checks ran under Node with their titles kept (ADR 0005 §15.3).
      const unicode = report.testResults.find((f) => f.name.endsWith('packages/core/test/unicode-runtime.test.ts'));
      expect(unicode?.assertionResults.map((a) => [a.title, a.status])).toEqual([
        ['workerd ICU NFKC matches oracle corpus', 'passed'],
        ['code points unassigned in Unicode 16.0.0 stay NFKC-inert normalization boundaries', 'passed'],
        ['generated casefold/white-space tables are up to date with data file', 'passed'],
      ]);

      expect(fingerprint()).toBe(before);
    },
    TIMEOUT,
  );

  it(
    'check-ts.sh runs scripts/check-node-bundle.ts and build-server.ts --check only when those files exist, and a failing check-node-bundle.ts fails the gate in the disposable copy',
    () => {
      const before = fingerprint();
      const copy = disposableCopy({ linkNodeModules: true });
      const BUILD = 'scripts/build-server.ts';
      const GUARD = 'scripts/check-node-bundle.ts';
      const buildHeading = 'Node server build (build-server.ts --check)';
      const guardHeading = 'Node bundle guard (check-node-bundle.ts)';
      // Start from neither file (N3-07 adds the real ones later).
      rmSync(copy.path(BUILD), { force: true });
      rmSync(copy.path(GUARD), { force: true });

      // 1. Only a failing guard: the build step is skipped, the guard runs and
      //    its exit status (3) is the gate's.
      copy.write(
        GUARD,
        "console.error('check-node-bundle stub: unpinned fetch path in main.mjs');\nprocess.exitCode = 3;\n",
      );
      const failing = runGate(copy, 'failing guard', '--projects', 'worker-node');
      expect(failing.status, failing.output).toBe(3);
      const failingSteps = stepHeadings(failing.output);
      expect(failingSteps).not.toContain(buildHeading);
      expect(failingSteps.at(-1)).toBe(guardHeading);
      // Every earlier step ran and passed first, the Workers bundle guard included.
      expect(failingSteps).toContain('test (vitest, projects: worker-node)');
      expect(failingSteps).toContain('production bundle guard (check-bundle.ts)');
      expect(failing.output).toContain('check-node-bundle stub: unpinned fetch path in main.mjs');
      expect(failing.output).not.toContain('PASS check-ts');
      const failed = JSON.parse(copy.read('work/gate-durations.json')) as GateDurations;
      expect(failed.exitCode).toBe(3);
      expect(failed.steps.at(-1)).toMatchObject({ name: guardHeading, status: 'failed' });
      expect(failed.steps.slice(0, -1).every((s) => s.status === 'passed')).toBe(true);

      // 2. Only build-server.ts: it runs with --check, the guard step is skipped.
      rmSync(copy.path(GUARD));
      copy.write(
        BUILD,
        "import { mkdirSync, writeFileSync } from 'node:fs';\n\nmkdirSync('work', { recursive: true });\nwriteFileSync('work/build-server-argv.json', JSON.stringify(process.argv.slice(2)));\nconsole.log('build-server stub: built');\n",
      );
      const building = runGate(copy, 'build-server only', '--projects', 'worker-node');
      expect(building.status, building.output).toBe(0);
      const buildingSteps = stepHeadings(building.output);
      expect(buildingSteps.at(-1)).toBe(buildHeading);
      expect(buildingSteps).not.toContain(guardHeading);
      expect(building.output).toContain('build-server stub: built');
      expect(JSON.parse(copy.read('work/build-server-argv.json'))).toEqual(['--check']);
      expect(building.output).toContain('PASS check-ts (vitest projects: worker-node)');

      expect(fingerprint()).toBe(before);
    },
    GATE_TIMEOUT,
  );

  // Declared last: it also checks the wall-clock time of every nested gate run
  // recorded by the controls above (vitest runs a file's tests in order).
  it(
    'check-ts.sh writes work/gate-durations.json with one wall-clock duration per step, and each nested negative control finishes inside its 180 s timeout',
    ({ task }) => {
      const before = fingerprint();
      const copy = disposableCopy({ linkNodeModules: true });
      rmSync(copy.path('work'), { recursive: true, force: true });

      // A malformed --projects is refused before any step runs.
      const bad = copy.run('bash', 'scripts/check-ts.sh', '--projects');
      expect(bad.status, bad.output).toBe(2);
      expect(stepHeadings(bad.output)).toEqual([]);
      expect(existsSync(copy.path('work/gate-durations.json'))).toBe(false);

      const gate = runGate(copy, 'durations', '--projects', 'worker-node');
      expect(gate.status, gate.output).toBe(0);
      expect(gate.output).toContain('PASS check-ts (vitest projects: worker-node)');
      const headings = stepHeadings(gate.output);
      expect(headings.slice(0, 4)).toEqual([
        'typecheck (tsc -b)',
        'lint (biome)',
        'test (vitest, projects: worker-node)',
        'contracts (validate_contracts.py)',
      ]);

      // One entry per step that ran, in the order the gate printed them.
      const durations = JSON.parse(copy.read('work/gate-durations.json')) as GateDurations;
      expect(durations.schemaVersion).toBe(1);
      expect(durations.result).toBe('passed');
      expect(durations.exitCode).toBe(0);
      expect(durations.projects).toEqual(['worker-node']);
      expect(durations.steps.map((s) => s.name)).toEqual(headings);
      for (const s of durations.steps) {
        expect(s.status, s.name).toBe('passed');
        expect(Number.isFinite(s.seconds) && s.seconds >= 0, `${s.name}: ${s.seconds}`).toBe(true);
      }
      // Wall-clock: the steps fit inside the gate's total, which fits inside what this test measured.
      const sum = durations.steps.reduce((n, s) => n + s.seconds, 0);
      expect(sum).toBeLessThanOrEqual(durations.totalSeconds + 0.01);
      expect(durations.totalSeconds).toBeLessThanOrEqual(gate.seconds + 0.01);
      // The vitest step is real time, not a placeholder: it spans the nested vitest run.
      const testStep = durations.steps.find((s) => s.name === 'test (vitest, projects: worker-node)');
      expect(testStep?.seconds).toBeGreaterThan(0.5);

      // Every nested negative control in this file has the 180 s budget ...
      const tests = (task.suite?.tasks ?? []).filter((t) => t.type === 'test');
      const controls = [
        'a misformatted file in a disposable copy fails the biome step and leaves the repository unchanged',
        'an inverted assertion in a disposable copy makes check-ts.sh exit nonzero',
        'the gate runs the worker-node project and fails with its status when a worker-node test fails in the disposable copy, with the nested run limited by --projects worker-node',
        'check-ts.sh runs scripts/check-node-bundle.ts and build-server.ts --check only when those files exist, and a failing check-node-bundle.ts fails the gate in the disposable copy',
        task.name,
      ];
      for (const name of controls) {
        const t = tests.find((x) => x.name === name);
        expect(t, name).toBeDefined();
        expect(t?.type === 'test' ? t.timeout : undefined, name).toBe(GATE_TIMEOUT);
      }
      // ... every recorded nested gate run was limited by --projects, and each
      // finished inside it (this one always; the others when they ran in this
      // vitest run before this test).
      expect(gateRuns.map((r) => r.test)).toContain('durations');
      for (const r of gateRuns) {
        expect(r.args[0], r.test).toBe('--projects');
        expect(r.seconds, `${r.test}: ${r.seconds.toFixed(1)} s`).toBeLessThan(GATE_TIMEOUT / 1000);
      }

      expect(fingerprint()).toBe(before);
    },
    GATE_TIMEOUT,
  );
});
