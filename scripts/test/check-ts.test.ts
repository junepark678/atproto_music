// Disposable-copy negative controls for the TypeScript gate, scripts/check-ts.sh
// (ADR 0004 A18; plan cases M1.2.2/ci_format_failure, M1.2.2/ci_assertion_failure,
// M7.1.1/strict_type_failure and M7.1.1/web_build).
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
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = 'scripts/test/check-ts.test.ts';
const TIMEOUT = 15 * 60_000;
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
  return env;
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

describe('scripts/check-ts.sh', () => {
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

      const gate = copy.run('bash', 'scripts/check-ts.sh');
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
    TIMEOUT,
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

      const gate = copy.run('bash', 'scripts/check-ts.sh');
      expect(gate.status, gate.output).not.toBe(0);
      expect(gate.output).toContain('==> test (vitest, all projects)');
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
    TIMEOUT,
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
});
