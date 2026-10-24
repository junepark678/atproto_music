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
//   (ACTIONLINT, PATH or $GOPATH/bin); without one that test is reported as
//   skipped, never as passed.
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
    expect(missing.stderr).toContain('wrangler secret put CURSOR_KEY');
    expect(missing.stderr).not.toContain('LEXICON_PREFIX');
    expect(missing.calls).toEqual([SECRET_LIST_CALL]);
    expectNoOutputs();

    // A named env checks that env's secrets.
    const staging = copy.deploy(['--dry-run', '--env', 'staging'], { STUB_SECRETS: '' });
    expect(staging.status).toBe(1);
    expect(staging.stderr).toContain('the CURSOR_KEY secret is missing for env staging');
    expect(staging.stderr).toContain('wrangler secret put CURSOR_KEY --env staging');
    expect(staging.calls).toEqual([`${SECRET_LIST_CALL.replace(' --format', ' --env staging --format')}`]);
    expectNoOutputs();

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

/** A GitHub Actions expression, `${{ expr }}`. */
const gh = (expr: string): string => `\${{ ${expr} }}`;

describe('actionlint .github/workflows/deploy.yml', () => {
  it.skipIf(ACTIONLINT === null)('workflow is valid', () => {
    const actionlint = ACTIONLINT as string;
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
});
