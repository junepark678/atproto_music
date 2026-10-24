// scripts/check-bundle.ts (W1-09): the production bundle guard. Each test
// builds a disposable copy of the Worker (worker/src plus the real
// worker/wrangler.jsonc) in a temp dir whose node_modules links to the
// repository's, runs the real CLI (which runs `wrangler deploy --dry-run`),
// and asserts the exit status, the printed report and the emitted bundle. The
// repository's worker/ is never modified.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { analyzeBundle } from '../check-bundle.ts';
import { buildClientMetadata, buildHeaders, parseJsonc } from '../gen-config.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_CLI = createRequire(join(REPO, 'package.json')).resolve('tsx/cli');
const REAL_ENTRY = join(REPO, 'worker', 'src', 'index.ts');
const ORIGIN = 'https://music.214510.xyz';
const PREFIX = 'dev.pythonplayer123.music';

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function checkBundle(args: readonly string[]): CliResult {
  const res = spawnSync(process.execPath, [TSX_CLI, join(REPO, 'scripts', 'check-bundle.ts'), ...args], {
    cwd: REPO,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    encoding: 'utf8',
    timeout: 170_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const temps: string[] = [];
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `atmusic-${label}-`));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function treeDigest(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(`${relative(dir, full).split(sep).join('/')}\0`).update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

/**
 * Until W5-01 adds worker/src/index.ts, the copy gets a stand-in production
 * entry that exercises the real worker/src/config.ts (which names the fixture
 * prefix only to refuse it).
 */
const STAND_IN_ENTRY = `import { DurableObject } from 'cloudflare:workers';
import { parseConfig } from './config';

export class IndexDO extends DurableObject {}

export default {
  async fetch(_request: Request, env: Parameters<typeof parseConfig>[0]): Promise<Response> {
    return new Response(parseConfig(env).publicOrigin);
  },
};
`;

interface WorkerCopy {
  dir: string;
  config: string;
  entry: string;
  outDir: string;
}

/** A disposable Worker project: worker/src copy, the real wrangler config with a local assets dir. */
function workerCopy(options: { assets?: 'none' | 'empty' } = {}): WorkerCopy {
  const dir = tempDir('worker-copy');
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
  cpSync(join(REPO, 'worker', 'src'), join(dir, 'src'), { recursive: true });
  const entry = join(dir, 'src', 'index.ts');
  if (!existsSync(REAL_ENTRY)) writeFileSync(entry, STAND_IN_ENTRY);
  const config = parseJsonc(readFileSync(join(REPO, 'worker', 'wrangler.jsonc'), 'utf8')) as {
    $schema?: string;
    assets: { directory: string };
  };
  delete config.$schema;
  config.assets.directory = 'assets';
  if (options.assets === 'empty') mkdirSync(join(dir, 'assets'));
  const configPath = join(dir, 'wrangler.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { dir, config: configPath, entry, outDir: join(dir, 'dist') };
}

function printedBundleHash(stdout: string): string | null {
  return /^check-bundle: bundle sha256 ([0-9a-f]{64})$/m.exec(stdout)?.[1] ?? null;
}

/** The release checksum, computed independently of check-bundle: sha256 of the sorted sha256sum manifest. */
function independentBundleHash(outDir: string): string {
  const modules = readdirSync(outDir)
    .filter((name) => !name.endsWith('.map') && name !== 'README.md')
    .sort();
  const manifest = modules
    .map(
      (name) =>
        `${createHash('sha256')
          .update(readFileSync(join(outDir, name)))
          .digest('hex')}  ${name}\n`,
    )
    .join('');
  return createHash('sha256').update(manifest).digest('hex');
}

test('fails when a test-support import is injected into a temp copy of the entry', () => {
  const repoWorkerBefore = treeDigest(join(REPO, 'worker', 'src'));
  const copy = workerCopy();

  // The clean copy passes and prints its bundle checksum.
  const clean = checkBundle(['--config', copy.config, '--outdir', copy.outDir]);
  expect(clean.stderr).toBe('');
  expect(clean.status).toBe(0);
  expect(clean.stdout).toContain('PASS check-bundle');
  const hash = printedBundleHash(clean.stdout);
  expect(hash).toBe(independentBundleHash(copy.outDir));
  const bundle = readFileSync(join(copy.outDir, 'index.js'), 'utf8');
  expect(bundle).toMatch(/export {[^}]*\bIndexDO\b/);
  expect(bundle).not.toContain('test-support');

  // Inject a test-support import into the copy of the entry.
  const original = readFileSync(copy.entry, 'utf8');
  writeFileSync(
    copy.entry,
    `import { fixedClock } from '@atmusic/core/test-support/clock';\n${original}\n(globalThis as Record<string, unknown>).__probe = fixedClock;\n`,
  );
  const injected = checkBundle(['--config', copy.config, '--outdir', copy.outDir]);
  expect(injected.status).toBe(1);
  expect(injected.stdout).not.toContain('PASS check-bundle');
  expect(printedBundleHash(injected.stdout)).toBeNull();
  expect(injected.stderr).toContain('FAIL check-bundle: index.js contains forbidden string "test-support"');
  expect(injected.stderr).toContain('FAIL check-bundle: index.js contains forbidden string "fixedClock"');
  expect(injected.stderr).toMatch(
    /FAIL check-bundle: bundle includes a test-support module: .*core\/test-support\/clock\.ts/,
  );
  // The guard looked at a real bundle that does contain the injected module.
  expect(readFileSync(join(copy.outDir, 'index.js'), 'utf8')).toContain('fixedClock');

  // The repository's Worker sources are untouched.
  expect(treeDigest(join(REPO, 'worker', 'src'))).toBe(repoWorkerBefore);
});

test('fails when node:crypto is imported into a temp copy of the entry', () => {
  const copy = workerCopy();
  const original = readFileSync(copy.entry, 'utf8');
  writeFileSync(
    copy.entry,
    `import { createHash } from 'node:crypto';\n${original}\n(globalThis as Record<string, unknown>).__probe = createHash;\n`,
  );
  const res = checkBundle(['--config', copy.config, '--outdir', copy.outDir]);
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('contains forbidden string "node:crypto"');
  expect(res.stderr).toContain('imports Node crypto');
  expect(res.stdout).not.toContain('PASS check-bundle');
});

test('refuses built client metadata or _headers that differ from the configured origin and prefix', () => {
  const copy = workerCopy({ assets: 'empty' });
  const assets = join(copy.dir, 'assets');
  mkdirSync(join(assets, 'oauth'));
  writeFileSync(join(assets, '_headers'), buildHeaders());
  const write = (origin: string, prefix: string) =>
    writeFileSync(
      join(assets, 'oauth', 'client-metadata.json'),
      `${JSON.stringify(buildClientMetadata(origin, prefix), null, 2)}\n`,
    );

  write(ORIGIN, PREFIX);
  const ok = checkBundle(['--config', copy.config, '--outdir', copy.outDir, '--release']);
  expect(ok.stderr).toBe('');
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain('PASS check-bundle');

  for (const [origin, prefix] of [
    ['https://music.example.org', PREFIX],
    [ORIGIN, 'org.example.music'],
    [ORIGIN, 'com.example.atmusic'],
  ] as const) {
    write(origin, prefix);
    rmSync(copy.outDir, { recursive: true, force: true });
    const res = checkBundle(['--config', copy.config, '--outdir', copy.outDir, '--release']);
    expect(res.status, `${origin} ${prefix}`).toBe(1);
    expect(res.stderr).toContain(`does not match PUBLIC_ORIGIN ${ORIGIN} and LEXICON_PREFIX ${PREFIX}`);
    expect(existsSync(copy.outDir)).toBe(false);
  }

  write(ORIGIN, PREFIX);
  writeFileSync(join(assets, '_headers'), buildHeaders().replace("frame-ancestors 'none'; ", ''));
  const headers = checkBundle(['--config', copy.config, '--outdir', copy.outDir, '--release']);
  expect(headers.status).toBe(1);
  expect(headers.stderr).toContain('differs from the headers gen-config generates');
});

test('refuses a wrangler config with a fixture or empty prefix or a route off the PUBLIC_ORIGIN host', () => {
  const copy = workerCopy();
  const base = readFileSync(copy.config, 'utf8');
  const cases: { vars?: Record<string, string>; route?: string; message: string }[] = [
    { vars: { LEXICON_PREFIX: 'com.example.atmusic' }, message: 'fixture-only and must never be published' },
    { vars: { LEXICON_PREFIX: '' }, message: 'LEXICON_PREFIX is empty' },
    { vars: { PUBLIC_ORIGIN: 'http://music.214510.xyz' }, message: 'PUBLIC_ORIGIN must be an https origin' },
    { route: 'other.214510.xyz', message: 'route other.214510.xyz is not on PUBLIC_ORIGIN host' },
  ];
  for (const { vars, route, message } of cases) {
    const config = JSON.parse(base) as { vars: Record<string, string>; routes: { pattern: string }[] };
    Object.assign(config.vars, vars);
    if (route !== undefined) config.routes[0]!.pattern = route;
    writeFileSync(copy.config, JSON.stringify(config));
    const res = checkBundle(['--config', copy.config, '--outdir', copy.outDir]);
    expect(res.status, message).toBe(1);
    expect(res.stderr).toContain(message);
    expect(existsSync(copy.outDir)).toBe(false);
  }
});

test('missing Worker entry skips after config checks, and fails with --release', () => {
  const copy = workerCopy();
  rmSync(copy.entry);
  const gate = checkBundle(['--config', copy.config, '--outdir', copy.outDir]);
  expect(gate.status).toBe(0);
  expect(gate.stdout).toMatch(/^SKIP check-bundle: Worker entry .*index\.ts does not exist/m);
  expect(gate.stdout).not.toContain('PASS check-bundle');
  expect(existsSync(copy.outDir)).toBe(false);

  const release = checkBundle(['--config', copy.config, '--outdir', copy.outDir, '--release']);
  expect(release.status).toBe(1);
  expect(release.stderr).toMatch(/FAIL check-bundle: Worker entry .*index\.ts does not exist/);
});

test('analyzeBundle enforces the gzip limit and rejects secp256k1-node and router-transport modules', () => {
  const dir = tempDir('dist');
  writeFileSync(join(dir, 'index.js'), `export default {};\n${'x'.repeat(4096)}\n`);
  writeFileSync(
    join(dir, 'index.js.map'),
    JSON.stringify({
      version: 3,
      sources: [
        'src/index.ts',
        '../node_modules/@atcute/crypto/dist/keypairs/secp256k1-node.js',
        '../packages/atproto/test-support/router-transport.ts',
      ],
      mappings: '',
    }),
  );
  writeFileSync(join(dir, 'README.md'), 'not a module\n');
  const report = analyzeBundle(dir, 16);
  expect(report.modules.map((m) => m.path)).toEqual(['index.js']);
  expect(report.violations).toEqual([
    `gzip size ${report.gzipBytes} bytes exceeds the 16-byte limit`,
    "bundle includes @atcute/crypto's secp256k1-node build: ../node_modules/@atcute/crypto/dist/keypairs/secp256k1-node.js",
    'bundle includes a test-support module: ../packages/atproto/test-support/router-transport.ts',
    'bundle includes the fixture router transport: ../packages/atproto/test-support/router-transport.ts',
  ]);
  expect(report.sha256).toBe(independentBundleHash(dir));
  expect(analyzeBundle(dir).violations).not.toContain(
    `gzip size ${report.gzipBytes} bytes exceeds the ${3 * 1024 * 1024}-byte limit`,
  );
});
