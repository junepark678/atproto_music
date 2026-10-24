// Deploy tooling (W6-04; plan cases M1.4.1/invalid_config, M6.1.3/fresh_install;
// ADR 0004 §9.2 A1/A15/A19):
//
// - `bash scripts/deploy.sh --dry-run` runs in a disposable copy of the
//   repository (tracked plus untracked, non-ignored files) whose node_modules
//   links to the repository's, so gen-config, the web build and
//   `wrangler deploy --dry-run` write only inside the copy. `wrangler secret
//   list` is answered by a stub executable passed as WRANGLER (the operator
//   override deploy.sh documents); every stub call is logged, so the tests
//   assert which wrangler commands ran. Nothing touches the network.
// - `actionlint .github/workflows/deploy.yml` uses an installed actionlint
//   (ACTIONLINT, PATH or $GOPATH/bin), pinned at ACTIONLINT_VERSION. The test
//   fails when it is missing or a different version, so the gate can never
//   report it as passed without running it (the CI ts job and deploy.yml
//   install it with `go install …@v1.7.7`, checksum-verified by sum.golang.org).
// - `npx tsx scripts/admin/pitr-restore.ts` runs as a CLI and through `main`
//   with a counting fake fetch and the frozen clock 2026-01-15T12:00:00Z.

import { spawnSync } from 'node:child_process';
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
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main as pitrMain } from '../admin/pitr-restore.ts';
import { analyzeBundle } from '../check-bundle.ts';
import { buildClientMetadata, buildHeaders } from '../gen-config.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_CLI = createRequire(join(ROOT, 'package.json')).resolve('tsx/cli');
const ORIGIN = 'https://music.214510.xyz';
const PREFIX = 'dev.pythonplayer123.music';
const FIXTURE_PREFIX = 'com.example.atmusic';
const FROZEN_NOW = Date.parse('2026-01-15T12:00:00Z');
const WORKSPACES: Record<string, string> = {
  core: 'packages/core',
  atproto: 'packages/atproto',
  worker: 'worker',
  web: 'web',
};
/** Outputs of a deploy, relative to the repository root. */
const OUTPUTS = ['web/public/oauth/client-metadata.json', 'web/public/_headers', 'web/dist', 'worker/dist'];

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** This process's environment minus the outer npm/vitest run and any deploy override. */
function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|VITEST|INIT_CWD$|NODE_ENV$|TEST$|NODE_OPTIONS$)/.test(key)) continue;
    if (/^(LEXICON_PREFIX|PUBLIC_ORIGIN|WRANGLER|ADMIN_TOKEN|CLOUDFLARE_.*|STUB_.*)$/.test(key)) continue;
    env[key] = value;
  }
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.CI = 'true';
  env.WRANGLER_SEND_METRICS = 'false';
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function run(command: string, args: readonly string[], cwd: string, extra: Record<string, string | undefined>): Result {
  const r = spawnSync(command, args, {
    cwd,
    env: childEnv(extra),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 280_000,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function repositoryFiles(): string[] {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  expect(r.status, r.stderr).toBe(0);
  return [...new Set(r.stdout.split('\0').filter((f) => f !== ''))].sort().filter((f) => {
    try {
      lstatSync(join(ROOT, f));
      return true;
    } catch {
      return false;
    }
  });
}

/** Digest of a file or directory tree (absent → a fixed marker). */
function treeDigest(path: string): string {
  const hash = createHash('sha256');
  if (!existsSync(path)) return 'absent';
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p).sort()) walk(join(p, name));
    } else {
      hash.update(`${relative(path, p).split(sep).join('/')}\0`).update(readFileSync(p));
    }
  };
  walk(path);
  return hash.digest('hex');
}

/** The real repository's git status and deploy outputs, which no test may change. */
function realRepoFingerprint(): string {
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return [status.stdout, ...OUTPUTS.map((o) => treeDigest(join(ROOT, o)))].join('\n');
}

/** A disposable copy of the repository whose node_modules links to the real one. */
class DisposableCopy {
  readonly dir = mkdtempSync(join(tmpdir(), 'atmusic-deploy-'));
  readonly stubDir: string;
  readonly stub: string;

  constructor() {
    expect(relative(ROOT, this.dir).startsWith('..')).toBe(true);
    for (const file of repositoryFiles()) {
      const from = join(ROOT, file);
      const to = join(this.dir, file);
      mkdirSync(dirname(to), { recursive: true });
      const stat = lstatSync(from);
      if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      else {
        copyFileSync(from, to);
        chmodSync(to, stat.mode & 0o777);
      }
    }
    // Generated outputs the real checkout may have are never copied (they are ignored).
    for (const output of OUTPUTS) expect(existsSync(join(this.dir, output)), output).toBe(false);
    const source = join(ROOT, 'node_modules');
    expect(existsSync(source), 'run npm ci before the deploy tests').toBe(true);
    const target = join(this.dir, 'node_modules');
    mkdirSync(target);
    for (const entry of readdirSync(source)) {
      if (entry === '@atmusic' || entry === '.package-lock.json' || entry.startsWith('.vite')) continue;
      symlinkSync(join(source, entry), join(target, entry));
    }
    mkdirSync(join(target, '@atmusic'));
    for (const [name, dir] of Object.entries(WORKSPACES))
      symlinkSync(join('..', '..', dir), join(target, '@atmusic', name));

    // The wrangler stub: logs every call; `secret list` prints STUB_SECRETS
    // (comma-separated names) as wrangler's JSON, or fails with STUB_FAIL;
    // any other command fails, so an unexpected upload cannot pass silently.
    this.stubDir = mkdtempSync(join(tmpdir(), 'atmusic-wrangler-stub-'));
    this.stub = join(this.stubDir, 'wrangler');
    writeFileSync(
      this.stub,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$STUB_LOG"',
        'if [[ "$1 $2" == "secret list" ]]; then',
        '  if [[ -n "$STUB_FAIL" ]]; then echo "Authentication error [code: 10000]" >&2; exit 1; fi',
        '  printf "["; sep=""; IFS=,',
        '  for n in $STUB_SECRETS; do printf \'%s{"name":"%s","type":"secret_text"}\' "$sep" "$n"; sep=","; done',
        '  printf "]\\n"; exit 0',
        'fi',
        // `secret put` (only run by the test that executes deploy.sh's suggested
        // command): succeeds only when its --config resolves from the cwd.
        'if [[ "$1 $2" == "secret put" ]]; then',
        '  cfg=""; prev=""',
        '  for a in "$@"; do if [[ "$prev" == "--config" ]]; then cfg="$a"; fi; prev="$a"; done',
        '  if [[ -n "$cfg" && -f "$cfg" ]]; then exit 0; fi',
        '  if [[ -z "$cfg" ]]; then cfg="(none)"; fi',
        '  echo "stub wrangler: config $cfg not found from $PWD" >&2; exit 98',
        'fi',
        'echo "stub wrangler: unexpected command: $*" >&2',
        'exit 97',
        '',
      ].join('\n'),
    );
    chmodSync(this.stub, 0o755);
  }

  deploy(args: readonly string[], env: Record<string, string | undefined>): Result & { calls: string[] } {
    const log = join(this.stubDir, `calls-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    writeFileSync(log, '');
    const result = run('bash', ['scripts/deploy.sh', ...args], this.dir, {
      WRANGLER: this.stub,
      STUB_LOG: log,
      ...env,
    });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    return { ...result, calls };
  }

  /**
   * Runs the `npx wrangler secret put …` command a refusal suggests, exactly as
   * printed, from the copy's root with the stub as wrangler (stdin closed).
   */
  runSuggestedPut(stderr: string): Result & { calls: string[] } {
    const suggested = /`(npx wrangler secret put [^`]+)`/.exec(stderr)?.[1];
    expect(suggested, stderr).toBeDefined();
    const argv = (suggested as string).split(' ').slice(2); // drop `npx wrangler`
    const log = join(this.stubDir, `put-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    writeFileSync(log, '');
    const result = run(this.stub, argv, this.dir, { STUB_LOG: log });
    return { ...result, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  }

  path(file: string): string {
    return join(this.dir, file);
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
    rmSync(this.stubDir, { recursive: true, force: true });
  }
}

const SECRET_LIST_CALL = 'secret list --config worker/wrangler.jsonc --format json';

describe('bash scripts/deploy.sh --dry-run', () => {
  let copy: DisposableCopy;
  let before: string;

  beforeAll(() => {
    before = realRepoFingerprint();
    copy = new DisposableCopy();
  }, 120_000);

  afterAll(() => {
    copy?.dispose();
    expect(realRepoFingerprint()).toBe(before);
  });

  /** Nothing of a deploy was written in the copy. */
  function expectNoOutputs(): void {
    for (const output of OUTPUTS) expect(existsSync(copy.path(output)), output).toBe(false);
  }

  it('refuses empty/fixture prefix and missing secret with nonzero exit', () => {
    const withKey = { STUB_SECRETS: 'CURSOR_KEY,ADMIN_TOKEN' };

    // Empty LEXICON_PREFIX (an explicit empty override).
    const empty = copy.deploy(['--dry-run'], { ...withKey, LEXICON_PREFIX: '' });
    expect(empty.status, empty.stdout + empty.stderr).toBe(1);
    expect(empty.stderr).toContain('deploy: refused: LEXICON_PREFIX is empty');
    expect(empty.stderr).not.toContain('CURSOR_KEY');
    expect(empty.stdout).not.toContain('==> deploy: gen-config');
    expect(empty.calls).toEqual([SECRET_LIST_CALL]);
    expectNoOutputs();

    // The fixture prefix as an override.
    const fixture = copy.deploy(['--dry-run'], { ...withKey, LEXICON_PREFIX: FIXTURE_PREFIX });
    expect(fixture.status).toBe(1);
    expect(fixture.stderr).toContain(`deploy: refused: LEXICON_PREFIX ${FIXTURE_PREFIX} is fixture-only`);
    expect(fixture.calls).toEqual([SECRET_LIST_CALL]);
    expectNoOutputs();

    // The fixture prefix and an empty prefix configured in wrangler.jsonc itself.
    const configPath = copy.path('worker/wrangler.jsonc');
    const original = readFileSync(configPath, 'utf8');
    const configured = `"LEXICON_PREFIX": "${PREFIX}"`;
    expect(original.split(configured).length - 1).toBe(3); // production, free, staging
    try {
      for (const value of [FIXTURE_PREFIX, '']) {
        writeFileSync(configPath, original.replace(configured, `"LEXICON_PREFIX": "${value}"`));
        const r = copy.deploy(['--dry-run'], withKey);
        expect(r.status, `configured ${JSON.stringify(value)}`).toBe(1);
        expect(r.stderr).toContain(
          value === '' ? 'LEXICON_PREFIX is empty' : `LEXICON_PREFIX ${FIXTURE_PREFIX} is fixture-only`,
        );
        expect(r.calls).toEqual([SECRET_LIST_CALL]);
        expectNoOutputs();
      }
    } finally {
      writeFileSync(configPath, original);
    }

    // Valid owned prefix, but the Worker has no CURSOR_KEY secret.
    const missing = copy.deploy(['--dry-run'], { STUB_SECRETS: 'ADMIN_TOKEN' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('deploy: refused: the CURSOR_KEY secret is missing for env production');
    expect(missing.stderr).toContain(
      'set it with `npx wrangler secret put CURSOR_KEY --config worker/wrangler.jsonc` (value: openssl rand -hex 32)',
    );
    expect(missing.stderr).not.toContain('LEXICON_PREFIX');
    expect(missing.calls).toEqual([SECRET_LIST_CALL]);
    expectNoOutputs();
    // The suggested command works from the repository root as printed: run
    // with the stub as wrangler, its --config resolves from the root.
    expect(copy.runSuggestedPut(missing.stderr).status).toBe(0);

    // A named env checks that env's secrets.
    const staging = copy.deploy(['--dry-run', '--env', 'staging'], { STUB_SECRETS: '' });
    expect(staging.status).toBe(1);
    expect(staging.stderr).toContain('the CURSOR_KEY secret is missing for env staging');
    expect(staging.stderr).toContain(
      'set it with `npx wrangler secret put CURSOR_KEY --config worker/wrangler.jsonc --env staging`',
    );
    expect(staging.calls).toEqual([`${SECRET_LIST_CALL.replace(' --format', ' --env staging --format')}`]);
    expectNoOutputs();
    const put = copy.runSuggestedPut(staging.stderr);
    expect(put.status, put.stderr).toBe(0);
    expect(put.calls).toEqual(['secret put CURSOR_KEY --config worker/wrangler.jsonc --env staging']);
    // Negative control: the previous suggestion (no --config) cannot find the
    // config from the repository root.
    const withoutConfig = copy.runSuggestedPut('`npx wrangler secret put CURSOR_KEY --env staging`');
    expect(withoutConfig.status).toBe(98);
    expect(withoutConfig.stderr).toContain('config (none) not found');

    // Secrets that cannot be listed are not assumed present.
    const unlisted = copy.deploy(['--dry-run'], { STUB_FAIL: '1' });
    expect(unlisted.status).toBe(1);
    expect(unlisted.stderr).toContain('cannot confirm the CURSOR_KEY secret: `wrangler secret list` failed');
    expectNoOutputs();

    // Fixture prefix and missing secret together: both are reported.
    const both = copy.deploy(['--dry-run'], { LEXICON_PREFIX: FIXTURE_PREFIX, STUB_SECRETS: '' });
    expect(both.status).toBe(1);
    expect(both.stderr).toContain('is fixture-only');
    expect(both.stderr).toContain('the CURSOR_KEY secret is missing');
    expectNoOutputs();

    // A usage error is status 2 and runs nothing.
    const usage = copy.deploy(['--dry-run', '--env', 'prod'], withKey);
    expect(usage.status).toBe(2);
    expect(usage.calls).toEqual([]);
  });

  it('valid owned prefix and CURSOR_KEY run gen-config, the web build and wrangler deploy --dry-run with exit 0', () => {
    const r = copy.deploy(['--dry-run'], { STUB_SECRETS: 'CURSOR_KEY' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);

    // The steps ran in order, and nothing was uploaded: the only wrangler
    // call through WRANGLER was the read-only secret listing.
    const order = [
      'deploy: preflight ok: env production origin https://music.214510.xyz prefix dev.pythonplayer123.music, CURSOR_KEY present',
      '==> deploy: gen-config --env production',
      '==> deploy: web build (vite build)',
      '==> deploy: bundle guard and wrangler deploy --dry-run (check-bundle --release)',
      'PASS check-bundle',
      'DRY RUN OK: env production',
    ];
    let at = -1;
    for (const marker of order) {
      const next = r.stdout.indexOf(marker, at + 1);
      expect(next, marker).toBeGreaterThan(at);
      at = next;
    }
    expect(r.calls).toEqual([SECRET_LIST_CALL]);
    expect(r.stdout).toContain('deploy: dry run: would run wrangler versions upload --config worker/wrangler.jsonc');
    expect(r.stdout).toContain('deploy: dry run: would run wrangler versions deploy <version-id>@100% --yes');

    // gen-config wrote the production client metadata and headers, and the
    // web build copied them into web/dist.
    const metadata = buildClientMetadata(ORIGIN, PREFIX);
    expect(JSON.parse(readFileSync(copy.path('web/public/oauth/client-metadata.json'), 'utf8'))).toEqual(metadata);
    expect(metadata.client_id).toBe('https://music.214510.xyz/oauth/client-metadata.json');
    expect(JSON.parse(readFileSync(copy.path('web/dist/oauth/client-metadata.json'), 'utf8'))).toEqual(metadata);
    expect(readFileSync(copy.path('web/dist/_headers'), 'utf8')).toBe(buildHeaders());
    expect(readFileSync(copy.path('web/dist/index.html'), 'utf8')).toMatch(/<script type="module"[^>]+src="\/assets\//);

    // wrangler deploy --dry-run emitted the bundle, which passes the guard,
    // and the printed bundle SHA-256 is the one of these modules.
    const report = analyzeBundle(copy.path('worker/dist'));
    expect(report.violations).toEqual([]);
    expect(report.modules.length).toBeGreaterThan(0);
    expect(r.stdout).toContain(`deploy: bundle sha256 ${report.sha256}`);
    expect(r.stdout).toContain(
      `DRY RUN OK: env production origin ${ORIGIN} prefix ${PREFIX} bundle sha256 ${report.sha256}`,
    );
  });
});

/** An installed actionlint, or null. */
function findActionlint(): string | null {
  const candidates = [
    process.env.ACTIONLINT,
    ...(process.env.PATH ?? '').split(delimiter).map((d) => (d === '' ? undefined : join(d, 'actionlint'))),
    process.env.GOBIN === undefined ? undefined : join(process.env.GOBIN, 'actionlint'),
    join(process.env.GOPATH ?? join(homedir(), 'go'), 'bin', 'actionlint'),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && existsSync(candidate)) return candidate;
  }
  return null;
}

const ACTIONLINT = findActionlint();
/** The pinned actionlint, as installed by the ts job in ci.yml and by deploy.yml. */
const ACTIONLINT_VERSION = 'v1.7.7';

/** A GitHub Actions expression, `${{ expr }}`. */
const gh = (expr: string): string => `\${{ ${expr} }}`;

interface WorkflowStep {
  name: string;
  /** The step's `env:` keys and values. */
  env: Record<string, string>;
  /** The step's whole text (its `run`, `uses` and `with`). */
  text: string;
}

interface DeployJob {
  /** Workflow-level `env:` entries (column 0). */
  workflowEnv: Record<string, string>;
  /** The deploy job's own `env:` entries. */
  jobEnv: Record<string, string>;
  steps: WorkflowStep[];
}

/** `KEY: value` entries of the mapping indented by `indent` spaces after `header` at line `at`. */
function envBlock(lines: readonly string[], at: number, indent: number): Record<string, string> {
  const out: Record<string, string> = {};
  const entry = new RegExp(`^ {${indent}}([A-Za-z_][A-Za-z0-9_]*): (.*)$`);
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(#.*)?$/.test(line)) continue;
    const m = entry.exec(line);
    if (m === null) break;
    out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

/**
 * The deploy job of deploy.yml as plain text structure: workflow- and
 * job-level env and each step's name, env and text. It reads this file's
 * layout (job keys at 4 spaces, step items at 6, step keys at 8, step env at
 * 10); actionlint above proves the layout is the workflow GitHub runs.
 */
function parseDeployJob(text: string): DeployJob {
  const lines = text.split('\n');
  const workflowAt = lines.indexOf('env:');
  const jobAt = lines.indexOf('  deploy:');
  expect(jobAt, 'jobs.deploy').toBeGreaterThan(0);
  let jobEnvAt = -1;
  let stepsAt = -1;
  for (let i = jobAt + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^ {2}[A-Za-z]/.test(line)) break; // next job
    if (line === '    env:') jobEnvAt = i;
    if (line === '    steps:') stepsAt = i;
  }
  expect(stepsAt, 'jobs.deploy.steps').toBeGreaterThan(jobAt);
  const steps: WorkflowStep[] = [];
  let current: { start: number; lines: string[] } | null = null;
  const flush = () => {
    if (current === null) return;
    const block = current.lines;
    const name = block.map((l) => /^ {6}- name: (.*)$|^ {8}name: (.*)$/.exec(l)).find((m) => m !== null);
    const envAt = block.indexOf('        env:');
    steps.push({
      name: (name?.[1] ?? name?.[2] ?? block[0] ?? '').trim(),
      env: envAt === -1 ? {} : envBlock(block, envAt, 10),
      text: block.join('\n'),
    });
  };
  for (let i = stepsAt + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^ {0,5}\S/.test(line)) break; // left the steps list
    if (line.startsWith('      - ')) {
      flush();
      current = { start: i, lines: [line] };
    } else current?.lines.push(line);
  }
  flush();
  return {
    workflowEnv: workflowAt === -1 ? {} : envBlock(lines, workflowAt, 2),
    jobEnv: jobEnvAt === -1 ? {} : envBlock(lines, jobEnvAt, 6),
    steps,
  };
}

/** The steps that call the Cloudflare API through wrangler, and so need the credentials. */
const CREDENTIAL_STEPS = [
  'Preflight (owned prefix and origin, CURSOR_KEY secret present)',
  'Upload Worker version',
  'Deploy the version to 100%',
  'Initial deploy (applies Durable Object migrations)',
];
const CREDENTIALS: Record<string, string> = {
  CLOUDFLARE_API_TOKEN: gh('secrets.CLOUDFLARE_API_TOKEN'),
  CLOUDFLARE_ACCOUNT_ID: gh('vars.CLOUDFLARE_ACCOUNT_ID'),
};

/** Every way the workflow text exposes a Cloudflare credential beyond CREDENTIAL_STEPS. */
function credentialScopeProblems(text: string): string[] {
  const job = parseDeployJob(text);
  const problems: string[] = [];
  for (const [scope, env] of [
    ['workflow', job.workflowEnv],
    ['job', job.jobEnv],
  ] as const) {
    for (const key of Object.keys(env)) if (/^CLOUDFLARE_/.test(key)) problems.push(`${scope}-level env ${key}`);
  }
  for (const step of job.steps) {
    const wanted = CREDENTIAL_STEPS.includes(step.name);
    for (const [key, value] of Object.entries(CREDENTIALS)) {
      if (wanted && step.env[key] !== value) problems.push(`step "${step.name}" lacks ${key}: ${value}`);
      if (!wanted && key in step.env) problems.push(`step "${step.name}" sees ${key}`);
    }
    if (!wanted && /secrets\.CLOUDFLARE|CLOUDFLARE_API_TOKEN/.test(step.text)) {
      problems.push(`step "${step.name}" references the Cloudflare token`);
    }
  }
  for (const name of CREDENTIAL_STEPS) {
    if (!job.steps.some((s) => s.name === name)) problems.push(`no step "${name}"`);
  }
  // The token reaches the runner only through those step env entries.
  const tokenRefs = text.split(gh('secrets.CLOUDFLARE_API_TOKEN')).length - 1;
  if (tokenRefs !== CREDENTIAL_STEPS.length) problems.push(`${tokenRefs} token references`);
  return problems;
}

describe('actionlint .github/workflows/deploy.yml', () => {
  it('workflow is valid', () => {
    // A missing actionlint is a failure, never a skip.
    expect(
      ACTIONLINT,
      `actionlint not found (ACTIONLINT, PATH, $GOBIN or $GOPATH/bin); install it with: go install github.com/rhysd/actionlint/cmd/actionlint@${ACTIONLINT_VERSION}`,
    ).not.toBeNull();
    const actionlint = ACTIONLINT as string;
    const version = run(actionlint, ['-version'], ROOT, {});
    expect(version.status, version.stderr).toBe(0);
    // `go install` builds print v1.7.7; release binaries print 1.7.7.
    expect(version.stdout.split('\n')[0]?.replace(/^v/, '')).toBe(ACTIONLINT_VERSION.slice(1));
    const workflow = join(ROOT, '.github', 'workflows', 'deploy.yml');
    const ok = run(actionlint, ['-no-color', workflow], ROOT, {});
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout + ok.stderr).toBe('');

    // Negative control: a misspelt input reference in a copy is reported.
    const dir = mkdtempSync(join(tmpdir(), 'atmusic-actionlint-'));
    try {
      const broken = join(dir, 'deploy.yml');
      const text = readFileSync(workflow, 'utf8');
      expect(text).toContain(gh('inputs.environment'));
      writeFileSync(
        broken,
        text.replace(`ATMUSIC_ENV: ${gh('inputs.environment')}`, `ATMUSIC_ENV: ${gh('inputs.enviroment')}`),
      );
      const bad = run(actionlint, ['-no-color', broken], dir, {});
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain('enviroment');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // The deploy contract: manual dispatch only, an environment-protected job
    // with CLOUDFLARE_API_TOKEN, and the steps in order.
    const text = readFileSync(workflow, 'utf8');
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
    expect(text).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(text).toMatch(/^ {4}environment:\n {6}name: \$\{\{ inputs\.environment \}\}$/m);
    expect(text).toContain(`CLOUDFLARE_API_TOKEN: ${gh('secrets.CLOUDFLARE_API_TOKEN')}`);
    const steps = [
      'run: npm ci',
      'run: bash scripts/check-ts.sh',
      'run: bash scripts/deploy.sh --env "$ATMUSIC_ENV" --preflight',
      'run: npx tsx scripts/gen-config.ts --env "$ATMUSIC_ENV"',
      'run: npm run build:web',
      'npx tsx scripts/check-bundle.ts --env "$ATMUSIC_ENV" --release',
      'npx wrangler versions upload',
      'npx wrangler versions deploy "$VERSION_ID@100%" --yes',
      'run: bash scripts/deploy.sh --env "$ATMUSIC_ENV" --smoke-only',
    ];
    let at = -1;
    for (const step of steps) {
      const next = text.indexOf(step, at + 1);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    // The credentials are scoped to the Cloudflare-calling steps (detailed below).
    expect(credentialScopeProblems(text)).toEqual([]);
  });

  it('deploy credentials are scoped to the deploy step', () => {
    const workflow = join(ROOT, '.github', 'workflows', 'deploy.yml');
    const text = readFileSync(workflow, 'utf8');
    const job = parseDeployJob(text);

    // No workflow- or job-level credential, so the install, test and build
    // steps run without the token in their environment.
    expect(job.jobEnv).toEqual({ ATMUSIC_ENV: gh('inputs.environment'), WRANGLER_SEND_METRICS: "'false'" });
    expect(Object.keys(job.workflowEnv).filter((k) => k.startsWith('CLOUDFLARE_'))).toEqual([]);
    const byName = new Map(job.steps.map((step) => [step.name, step]));
    for (const name of [
      'Install pinned contract validator',
      'Install locked dependencies',
      'Install pinned actionlint (checked by the TypeScript gate)',
      'TypeScript gate',
      'Generate client metadata and _headers',
      'Build the SPA (vite build)',
      'Bundle guard and bundle SHA-256',
      'Smoke test /health/live, /health/ready and /api/v1/meta',
      'Record release evidence',
    ]) {
      const step = byName.get(name);
      expect(step, name).toBeDefined();
      expect(
        Object.keys(step?.env ?? {}).filter((k) => k.startsWith('CLOUDFLARE_')),
        name,
      ).toEqual([]);
    }
    expect(byName.get('Install locked dependencies')?.text).toContain('run: npm ci');
    expect(byName.get('Install pinned contract validator')?.text).toContain('pip install');
    expect(byName.get('TypeScript gate')?.text).toContain('run: bash scripts/check-ts.sh');

    // Exactly the steps that call the Cloudflare API get both values, and
    // each of them is a step that runs wrangler against the account.
    const withToken = job.steps.filter((s) => 'CLOUDFLARE_API_TOKEN' in s.env).map((s) => s.name);
    expect(withToken).toEqual(CREDENTIAL_STEPS);
    for (const name of CREDENTIAL_STEPS) {
      const step = byName.get(name) as WorkflowStep;
      expect(step.env.CLOUDFLARE_API_TOKEN, name).toBe(gh('secrets.CLOUDFLARE_API_TOKEN'));
      expect(step.env.CLOUDFLARE_ACCOUNT_ID, name).toBe(gh('vars.CLOUDFLARE_ACCOUNT_ID'));
      expect(step.text, name).toMatch(
        /deploy\.sh --env "\$ATMUSIC_ENV" --preflight|npx wrangler (versions upload|versions deploy|deploy) /,
      );
    }
    expect(credentialScopeProblems(text)).toEqual([]);

    // Negative controls: the previous job-level layout, and a credential
    // added to the test-suite step, are both reported.
    const jobLevel = text.replace(
      `      ATMUSIC_ENV: ${gh('inputs.environment')}\n`,
      `      ATMUSIC_ENV: ${gh('inputs.environment')}\n      CLOUDFLARE_API_TOKEN: ${gh('secrets.CLOUDFLARE_API_TOKEN')}\n`,
    );
    expect(jobLevel).not.toBe(text);
    expect(credentialScopeProblems(jobLevel)).toContain('job-level env CLOUDFLARE_API_TOKEN');
    const gate = text.replace(
      '      - name: TypeScript gate\n        run: bash scripts/check-ts.sh\n',
      `      - name: TypeScript gate\n        env:\n          CLOUDFLARE_API_TOKEN: ${gh('secrets.CLOUDFLARE_API_TOKEN')}\n        run: bash scripts/check-ts.sh\n`,
    );
    expect(gate).not.toBe(text);
    expect(credentialScopeProblems(gate)).toContain('step "TypeScript gate" sees CLOUDFLARE_API_TOKEN');
  });
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

function pitrHarness(respond: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    fetch: async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    },
    nowMs: () => FROZEN_NOW,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  };
  return { calls, out, err, deps };
}

describe('npx tsx scripts/admin/pitr-restore.ts --help', () => {
  const TOKEN = 'a'.repeat(16) + 'B'.repeat(16) + 'c'.repeat(8);

  it('prints usage and requires ADMIN_TOKEN', async () => {
    // The CLI: --help prints the usage, naming ADMIN_TOKEN, and exits 0.
    const help = run(process.execPath, [TSX_CLI, 'scripts/admin/pitr-restore.ts', '--help'], ROOT, {});
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Usage: ADMIN_TOKEN=<token> npx tsx scripts/admin/pitr-restore.ts --at');
    expect(help.stdout).toContain('ADMIN_TOKEN     required');
    expect(help.stdout).toContain('/internal/admin/pitr');

    // Without ADMIN_TOKEN the CLI refuses with status 2 before any request.
    const noToken = run(
      process.execPath,
      [
        TSX_CLI,
        'scripts/admin/pitr-restore.ts',
        '--at',
        '2026-01-15T11:00:00Z',
        '--origin',
        'https://music.example.org',
        '--yes',
      ],
      ROOT,
      {},
    );
    expect(noToken.status).toBe(2);
    expect(noToken.stderr).toContain('pitr-restore: ADMIN_TOKEN is required');
    expect(noToken.stdout).not.toContain('POST');

    // In process, with a counting fetch: no token → no request.
    const a = pitrHarness(() => new Response(null, { status: 500 }));
    expect(await pitrMain(['--at', '2026-01-15T11:00:00Z', '--yes'], {}, a.deps)).toBe(2);
    expect(a.calls).toHaveLength(0);
    expect(a.err.join('\n')).toContain('ADMIN_TOKEN is required');

    // A token shorter than the Worker's 32-character floor → no request.
    const short = pitrHarness(() => new Response(null, { status: 500 }));
    expect(await pitrMain(['--at', '2026-01-15T11:00:00Z', '--yes'], { ADMIN_TOKEN: 'x'.repeat(31) }, short.deps)).toBe(
      2,
    );
    expect(short.calls).toHaveLength(0);

    // With the token and --yes: exactly one POST to the configured
    // production origin's /internal/admin/pitr with the bearer token and
    // {atMs}; 202 prints the bookmark and never the token.
    const atMs = Date.parse('2026-01-15T11:00:00Z');
    const ok = pitrHarness(
      () =>
        new Response(JSON.stringify({ bookmark: 'bm-0001', atMs, restart: true }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(await pitrMain(['--at', '2026-01-15T11:00:00Z', '--yes'], { ADMIN_TOKEN: TOKEN }, ok.deps)).toBe(0);
    expect(ok.calls).toHaveLength(1);
    const call = ok.calls[0] as FetchCall;
    expect(call.url).toBe(`${ORIGIN}/internal/admin/pitr`);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('manual');
    expect(call.init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json',
    });
    expect(JSON.parse(call.init.body as string)).toEqual({ atMs });
    expect(ok.out.join('\n')).toContain('pitr-restore: scheduled: bookmark bm-0001');
    expect([...ok.out, ...ok.err].join('\n')).not.toContain(TOKEN);

    // Epoch-ms --at and an explicit --origin for a named env's host.
    const explicit = pitrHarness(
      () => new Response(JSON.stringify({ bookmark: 'bm-2', atMs, restart: true }), { status: 202 }),
    );
    expect(
      await pitrMain(
        ['--at', String(atMs), '--origin', 'https://music-staging.214510.xyz/', '--yes'],
        { ADMIN_TOKEN: TOKEN },
        explicit.deps,
      ),
    ).toBe(0);
    expect(explicit.calls.map((c) => c.url)).toEqual(['https://music-staging.214510.xyz/internal/admin/pitr']);

    // Refusals that send nothing: no --yes, outside the 30-day window, in
    // the future, a timezone-less time, a non-https origin.
    const refusals: string[][] = [
      ['--at', '2026-01-15T11:00:00Z'],
      ['--at', '2025-12-16T11:59:59Z', '--yes'],
      ['--at', '2026-01-15T12:00:01Z', '--yes'],
      ['--at', '2026-01-15T11:00:00', '--yes'],
      ['--at', '2026-01-15T11:00:00Z', '--origin', 'http://music.example.org', '--yes'],
    ];
    for (const argv of refusals) {
      const h = pitrHarness(() => new Response(null, { status: 500 }));
      expect(await pitrMain(argv, { ADMIN_TOKEN: TOKEN }, h.deps), argv.join(' ')).toBe(2);
      expect(h.calls, argv.join(' ')).toHaveLength(0);
    }
    // The window's lower bound itself is accepted (as the Worker accepts it).
    const edge = pitrHarness(
      () => new Response(JSON.stringify({ bookmark: 'b', atMs: 0, restart: true }), { status: 202 }),
    );
    expect(await pitrMain(['--at', '2025-12-16T12:00:00Z', '--yes'], { ADMIN_TOKEN: TOKEN }, edge.deps)).toBe(0);
    expect(edge.calls).toHaveLength(1);

    // --dry-run prints the request and sends nothing.
    const dry = pitrHarness(() => new Response(null, { status: 500 }));
    expect(await pitrMain(['--at', '2026-01-15T11:00:00Z', '--dry-run'], { ADMIN_TOKEN: TOKEN }, dry.deps)).toBe(0);
    expect(dry.calls).toHaveLength(0);
    expect(dry.out.join('\n')).toContain(`POST ${ORIGIN}/internal/admin/pitr {"atMs":${atMs}}`);

    // The Worker's refusals are status 1 with the reason.
    const envelope = (code: string, status: number) =>
      new Response(
        JSON.stringify({ error: { code, message: code, requestId: '00000000-0000-4000-8000-000000000000' } }),
        {
          status,
        },
      );
    for (const [status, code, text] of [
      [404, 'not_found', 'the admin routes are disabled'],
      [401, 'unauthorized', 'ADMIN_TOKEN does not match'],
      [422, 'invalid_request', 'refused with 422'],
    ] as const) {
      const h = pitrHarness(() => envelope(code, status));
      expect(await pitrMain(['--at', '2026-01-15T11:00:00Z', '--yes'], { ADMIN_TOKEN: TOKEN }, h.deps)).toBe(1);
      expect(h.calls).toHaveLength(1);
      expect(h.err.join('\n')).toContain(text);
      expect(h.err.join('\n')).not.toContain(TOKEN);
    }
  });

  it('an explicit --env is never overridden by an ambient PUBLIC_ORIGIN', async () => {
    const STAGING = 'https://music-staging.214510.xyz';
    const accepted = () => new Response(JSON.stringify({ bookmark: 'bm-s', atMs: 0, restart: true }), { status: 202 });
    const at = ['--at', '2026-01-15T11:00:00Z'];

    // The CLI: PUBLIC_ORIGIN=production with --env staging refuses with
    // status 2 and prints no request line (the reviewer's reproduction, which
    // previously printed `POST https://music.214510.xyz/internal/admin/pitr`).
    const cli = run(
      process.execPath,
      [TSX_CLI, 'scripts/admin/pitr-restore.ts', ...at, '--env', 'staging', '--dry-run'],
      ROOT,
      { ADMIN_TOKEN: TOKEN, PUBLIC_ORIGIN: ORIGIN },
    );
    expect(cli.status, cli.stdout + cli.stderr).toBe(2);
    expect(cli.stdout).not.toContain('POST');
    expect(cli.stderr).toContain(`PUBLIC_ORIGIN ${ORIGIN} in the environment disagrees with --env staging`);

    // In process with --yes: the same conflict sends nothing.
    const conflict = pitrHarness(accepted);
    expect(
      await pitrMain(
        [...at, '--env', 'staging', '--yes'],
        { ADMIN_TOKEN: TOKEN, PUBLIC_ORIGIN: ORIGIN },
        conflict.deps,
      ),
    ).toBe(2);
    expect(conflict.calls).toHaveLength(0);
    expect(conflict.out.join('\n')).not.toContain('POST');

    // --origin naming another origin than --env is refused too.
    const flagConflict = pitrHarness(accepted);
    expect(
      await pitrMain(
        [...at, '--env', 'staging', '--origin', ORIGIN, '--yes'],
        { ADMIN_TOKEN: TOKEN },
        flagConflict.deps,
      ),
    ).toBe(2);
    expect(flagConflict.calls).toHaveLength(0);
    expect(flagConflict.err.join('\n')).toContain(`--origin ${ORIGIN} disagrees with --env staging`);

    // --env staging alone, or with an agreeing PUBLIC_ORIGIN (trailing slash
    // ignored), resolves to staging: the target is printed, then one POST.
    for (const env of [{ ADMIN_TOKEN: TOKEN }, { ADMIN_TOKEN: TOKEN, PUBLIC_ORIGIN: `${STAGING}/` }]) {
      const h = pitrHarness(accepted);
      expect(await pitrMain([...at, '--env', 'staging', '--yes'], env, h.deps)).toBe(0);
      expect(h.calls.map((c) => c.url)).toEqual([`${STAGING}/internal/admin/pitr`]);
      expect(h.out[0]).toBe(`pitr-restore: target env staging origin ${STAGING}`);
    }

    // Without --env, PUBLIC_ORIGIN is still the default, and the printed
    // target says so.
    const ambient = pitrHarness(accepted);
    expect(await pitrMain([...at, '--yes'], { ADMIN_TOKEN: TOKEN, PUBLIC_ORIGIN: `${STAGING}` }, ambient.deps)).toBe(0);
    expect(ambient.calls.map((c) => c.url)).toEqual([`${STAGING}/internal/admin/pitr`]);
    expect(ambient.out[0]).toBe(`pitr-restore: target env (PUBLIC_ORIGIN) origin ${STAGING}`);

    // Without either, production's configured origin.
    const dflt = pitrHarness(accepted);
    expect(await pitrMain([...at, '--yes'], { ADMIN_TOKEN: TOKEN }, dflt.deps)).toBe(0);
    expect(dflt.calls.map((c) => c.url)).toEqual([`${ORIGIN}/internal/admin/pitr`]);
    expect(dflt.out[0]).toBe(`pitr-restore: target env production origin ${ORIGIN}`);
  });
});
