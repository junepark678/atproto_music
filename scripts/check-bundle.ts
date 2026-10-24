// Production bundle guard (ADR 0004 §4.4 "Test seam", §8 "Test seams", A19;
// W1-09).
//
// Usage:
//   npx tsx scripts/check-bundle.ts [--config worker/wrangler.jsonc]
//     [--env production|staging|free] [--outdir worker/dist] [--release]
//
// 1. Checks the env's deploy values in the wrangler config: PUBLIC_ORIGIN is an
//    https origin, every route is on its host, and LEXICON_PREFIX is a valid,
//    owned (non-empty, non-fixture) prefix. assets.not_found_handling, when
//    set, must be "none" (ADR §15 Q9: the Worker answers every asset miss;
//    the platform SPA fallback is refused).
// 2. If the assets directory holds generated client metadata or _headers, they
//    must equal what scripts/gen-config.ts generates for exactly these values,
//    so a build whose origin or prefix differs from the configured ones is
//    refused.
// 3. Runs `wrangler deploy --dry-run --outdir <outdir>` and asserts, over the
//    emitted modules:
//    - total gzip size ≤ 3 MiB;
//    - no `test-support`, `fixedClock`, `routerTransport`/`router-transport` or
//      `node:crypto` string, and no import of `crypto`/`node:crypto`;
//    - no bundled module from a test-support directory, the router transport or
//      @atcute/crypto's `secp256k1-node` build (checked in the source map's
//      module list as well as the code).
// 4. Prints each module's SHA-256 and the bundle SHA-256 (the release checksum
//    of A19): SHA-256 of the `sha256sum`-format manifest of the modules, sorted
//    by path.
//
// Without --release, a missing Worker entry (worker/src/index.ts arrives with
// W5-01) skips steps 3–4 after step 1 and exits 0 with a SKIP line, and a
// missing assets directory is replaced by an empty one for the dry run. With
// --release (deploy) the entry, the built assets, their client metadata and
// _headers are all required.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  buildClientMetadata,
  buildHeaders,
  DEFAULT_WRANGLER_CONFIG,
  deployedValueIssues,
  type EnvName,
  HEADERS_FILE,
  METADATA_FILE,
  REPO_ROOT,
  readJsonc,
  wranglerEnvSection,
} from './gen-config.ts';

export const MAX_GZIP_BYTES = 3 * 1024 * 1024;
export const DEFAULT_OUT_DIR = join(REPO_ROOT, 'worker', 'dist');

/** Strings that must not occur anywhere in the emitted Worker code. */
export const FORBIDDEN_STRINGS: readonly string[] = [
  'test-support',
  'fixedClock',
  'routerTransport',
  'router-transport',
  'node:crypto',
  'secp256k1-node',
];

/** Patterns over the bundled module paths (source map `sources`). */
export const FORBIDDEN_MODULES: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /(^|\/)test-support\//, what: 'a test-support module' },
  { pattern: /(^|\/)router-transport(\.[a-z]+)?$/, what: 'the fixture router transport' },
  { pattern: /secp256k1-node(\.[a-z]+)?$/, what: "@atcute/crypto's secp256k1-node build" },
  { pattern: /(^|\/)worker\/test\//, what: 'a worker test module' },
];

const CRYPTO_IMPORT = /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'](?:node:)?crypto["']/;

export interface BundleModule {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BundleReport {
  modules: BundleModule[];
  gzipBytes: number;
  sha256: string;
  violations: string[];
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/** Analyses a `wrangler deploy --dry-run --outdir` directory. */
export function analyzeBundle(outDir: string, maxGzipBytes = MAX_GZIP_BYTES): BundleReport {
  const violations: string[] = [];
  const files = listFiles(outDir).map((full) => ({ full, path: relative(outDir, full).split(sep).join('/') }));
  const moduleFiles = files.filter((f) => !f.path.endsWith('.map') && f.path !== 'README.md');
  const mapFiles = files.filter((f) => f.path.endsWith('.map'));
  if (moduleFiles.length === 0) violations.push(`no Worker modules were emitted in ${outDir}`);

  const modules: BundleModule[] = [];
  let gzipBytes = 0;
  for (const file of moduleFiles) {
    const data = readFileSync(file.full);
    modules.push({ path: file.path, bytes: data.length, sha256: sha256Hex(data) });
    gzipBytes += gzipSync(data, { level: 9 }).length;
    const text = data.toString('utf8');
    for (const needle of FORBIDDEN_STRINGS) {
      if (text.includes(needle)) violations.push(`${file.path} contains forbidden string "${needle}"`);
    }
    const imported = CRYPTO_IMPORT.exec(text);
    if (imported !== null) violations.push(`${file.path} imports Node crypto (${imported[0]})`);
  }
  if (gzipBytes > maxGzipBytes) {
    violations.push(`gzip size ${gzipBytes} bytes exceeds the ${maxGzipBytes}-byte limit`);
  }

  for (const map of mapFiles) {
    let sources: unknown;
    try {
      sources = (JSON.parse(readFileSync(map.full, 'utf8')) as { sources?: unknown }).sources;
    } catch {
      violations.push(`${map.path} is not a valid source map`);
      continue;
    }
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (typeof source !== 'string') continue;
      for (const { pattern, what } of FORBIDDEN_MODULES) {
        if (pattern.test(source)) violations.push(`bundle includes ${what}: ${source}`);
      }
    }
  }

  const manifest = modules
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((m) => `${m.sha256}  ${m.path}\n`)
    .join('');
  return { modules, gzipBytes, sha256: sha256Hex(manifest), violations };
}

/** Deep structural equality for parsed JSON. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Checks generated assets against the configured origin and prefix. */
export function assetIssues(assetsDir: string, origin: string, prefix: string, release: boolean): string[] {
  const issues: string[] = [];
  const metadataPath = join(assetsDir, METADATA_FILE);
  if (existsSync(metadataPath)) {
    let built: unknown;
    try {
      built = JSON.parse(readFileSync(metadataPath, 'utf8'));
    } catch {
      built = null;
    }
    if (!jsonEqual(built, buildClientMetadata(origin, prefix))) {
      issues.push(
        `${metadataPath} does not match PUBLIC_ORIGIN ${origin} and LEXICON_PREFIX ${prefix}; rerun gen-config and the web build`,
      );
    }
  } else if (release) {
    issues.push(`${metadataPath} is missing; run gen-config and the web build first`);
  }
  const headersPath = join(assetsDir, HEADERS_FILE);
  if (existsSync(headersPath)) {
    if (readFileSync(headersPath, 'utf8') !== buildHeaders()) {
      issues.push(`${headersPath} differs from the headers gen-config generates`);
    }
  } else if (release) {
    issues.push(`${headersPath} is missing; run gen-config and the web build first`);
  }
  return issues;
}

interface CliArgs {
  config: string;
  env: Exclude<EnvName, 'local'>;
  outDir: string;
  release: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { config: DEFAULT_WRANGLER_CONFIG, env: 'production', outDir: DEFAULT_OUT_DIR, release: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--release') {
      args.release = true;
    } else if ((flag === '--config' || flag === '--env' || flag === '--outdir') && value !== undefined) {
      if (flag === '--config') args.config = resolve(value);
      else if (flag === '--outdir') args.outDir = resolve(value);
      else if (value === 'production' || value === 'staging' || value === 'free') args.env = value;
      else throw new Error(`--env must be production, staging or free (got ${value})`);
      i++;
    } else {
      throw new Error(
        `unknown or incomplete argument ${flag}; usage: check-bundle.ts [--config <wrangler config>] [--env <env>] [--outdir <dir>] [--release]`,
      );
    }
  }
  return args;
}

function wranglerBin(): string {
  const require = createRequire(join(REPO_ROOT, 'package.json'));
  return join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
}

export function main(argv: readonly string[]): number {
  const fail = (issues: readonly string[]) => {
    for (const issue of issues) console.error(`FAIL check-bundle: ${issue}`);
    return 1;
  };
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return fail([err instanceof Error ? err.message : String(err)]);
  }

  let section: ReturnType<typeof wranglerEnvSection>;
  try {
    section = wranglerEnvSection(readJsonc(args.config), args.env);
  } catch (err) {
    return fail([`cannot read ${args.config}: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const origin = section.vars.PUBLIC_ORIGIN ?? '';
  const prefix = (section.vars.LEXICON_PREFIX ?? '').trim();
  console.log(`check-bundle: config ${args.config} env ${args.env} origin ${origin} prefix ${prefix || '(empty)'}`);
  const configIssues = deployedValueIssues(origin, prefix, section.routeHosts);
  if (section.assetsNotFoundHandling !== null && section.assetsNotFoundHandling !== 'none') {
    configIssues.push(
      `assets.not_found_handling is ${JSON.stringify(section.assetsNotFoundHandling)}; ADR 0004 §15 Q9 requires "none" so the Worker answers every asset miss`,
    );
  }
  if (configIssues.length > 0) return fail(configIssues);

  const configDir = dirname(args.config);
  const entry = section.main === null ? null : resolve(configDir, section.main);
  if (entry === null || !existsSync(entry)) {
    const msg = `Worker entry ${entry ?? '(main unset)'} does not exist`;
    if (args.release) return fail([msg]);
    console.log(`SKIP check-bundle: ${msg} yet (W5-01); config checks passed, bundle not built`);
    return 0;
  }

  const assetsDir = section.assetsDirectory === null ? null : resolve(configDir, section.assetsDirectory);
  let emptyAssets: string | null = null;
  const issues: string[] = [];
  if (assetsDir !== null && existsSync(assetsDir)) {
    issues.push(...assetIssues(assetsDir, origin, prefix, args.release));
  } else if (args.release) {
    issues.push(`assets directory ${assetsDir ?? '(unset)'} does not exist; run gen-config and the web build first`);
  } else if (assetsDir !== null) {
    emptyAssets = mkdtempSync(join(tmpdir(), 'atmusic-assets-'));
    console.log(`check-bundle: NOTE ${assetsDir} does not exist; dry run uses an empty assets directory`);
  }
  if (issues.length > 0) return fail(issues);

  rmSync(args.outDir, { recursive: true, force: true });
  const wranglerArgs = [wranglerBin(), 'deploy', '--dry-run', '--outdir', args.outDir, '--config', args.config];
  if (section.wranglerEnv !== null) wranglerArgs.push('--env', section.wranglerEnv);
  if (emptyAssets !== null) wranglerArgs.push('--assets', emptyAssets);
  try {
    execFileSync(process.execPath, wranglerArgs, {
      cwd: configDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message: string };
    const detail = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim() || e.message;
    return fail([`wrangler deploy --dry-run failed:\n${detail}`]);
  } finally {
    if (emptyAssets !== null) rmSync(emptyAssets, { recursive: true, force: true });
  }

  const report = analyzeBundle(args.outDir);
  for (const m of report.modules) {
    console.log(`check-bundle: module ${m.path} ${m.bytes} bytes sha256 ${m.sha256}`);
  }
  console.log(`check-bundle: gzip ${report.gzipBytes} bytes (limit ${MAX_GZIP_BYTES})`);
  if (report.violations.length > 0) return fail(report.violations);
  console.log(`check-bundle: bundle sha256 ${report.sha256}`);
  console.log('PASS check-bundle');
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
