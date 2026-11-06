// Build the Node server bundle (ADR 0005 §3.9; N3-07).
//
// Usage:
//   npx tsx scripts/build-server.ts [--check] [--outdir <dir>]
//   npx tsx scripts/build-server.ts --e2e [--entry <path>] [--outdir <dir>]
//
// Node 26 cannot run this TypeScript by type stripping (parameter properties,
// extensionless imports), so esbuild (0.28.2) bundles it: `platform: node`,
// `format: esm`, `target: node26`, linked source maps, every dependency
// bundled except ws's optional native addons. The git sha (`git rev-parse
// HEAD`) is embedded as `__ATMUSIC_GIT_SHA__`, which `main.mjs --version`
// prints (B11). Every build writes its esbuild metafile next to the bundle,
// which scripts/check-node-bundle.ts reads.
//
//   (default)  worker/src/node/main.ts → <outdir>/main.mjs, main.meta.json
//   --check    the same, then runs `node main.mjs --version` and fails unless
//              it prints the embedded sha; it also builds e2e.mjs when
//              worker/test/e2e/node-entry.ts exists, and otherwise removes a
//              stale e2e.mjs, so the guard never compares against an old
//              e2e bundle. check-ts.sh runs this mode.
//   --e2e      worker/test/e2e/node-entry.ts (or --entry <path>) →
//              <outdir>/e2e.mjs, e2e.meta.json. The e2e entry imports
//              worker/src/node/run.ts, never main.ts (N6-01). Exit 2 when the
//              entry does not exist.
//
// <outdir> defaults to worker/dist/node. Exit status: 0 built, 1 build or
// check failure, 2 usage error or missing entry.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Metafile } from 'esbuild';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_DIR = join(REPO_ROOT, 'worker', 'dist', 'node');
export const MAIN_ENTRY = join(REPO_ROOT, 'worker', 'src', 'node', 'main.ts');
export const E2E_ENTRY = join(REPO_ROOT, 'worker', 'test', 'e2e', 'node-entry.ts');
export const MAIN_BUNDLE = 'main.mjs';
export const E2E_BUNDLE = 'e2e.mjs';
export const MAIN_METAFILE = 'main.meta.json';
export const E2E_METAFILE = 'e2e.meta.json';
/** Build facts the guard prints: the sha embedded in each bundle. */
export const BUILD_INFO = 'build-info.json';

/**
 * In an ESM bundle, the bundled CommonJS dependencies (ws, undici) call
 * `require` for node built-ins; esbuild's shim refuses that, so the bundle
 * defines a real one.
 */
const REQUIRE_BANNER =
  "import { createRequire as __atmusicCreateRequire } from 'node:module';\n" +
  'const require = __atmusicCreateRequire(import.meta.url);';

export class BuildUsageError extends Error {
  override readonly name = 'BuildUsageError';
}

/** Recorded when the repository has no commit yet (never a release: B11 needs a real sha). */
export const NO_COMMIT_SHA = '0'.repeat(40);

/**
 * `git rev-parse HEAD` of `root`; NO_COMMIT_SHA in a repository without any
 * commit (the gate's disposable copies). Not being in a git work tree at all
 * is an error.
 */
export function gitSha(root = REPO_ROOT): string {
  const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.error !== undefined) throw head.error;
  const sha = (head.stdout ?? '').trim();
  if (head.status === 0 && /^[0-9a-f]{40}$/.test(sha)) return sha;
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (inside.status === 0 && (inside.stdout ?? '').trim() === 'true' && sha === '') return NO_COMMIT_SHA;
  throw new Error(`git rev-parse HEAD failed in ${root}: ${(head.stderr ?? '').trim() || sha}`);
}

export interface BundleResult {
  outfile: string;
  metafilePath: string;
  metafile: Metafile;
  sha256: string;
  gitSha: string;
}

export interface BuildBundleOptions {
  entry: string;
  outfile: string;
  metafilePath: string;
  gitSha: string;
  root?: string;
}

/** `<dir>/main.meta.json` → `<dir>/main.inputs.json`. */
export function inputHashesPath(metafilePath: string): string {
  return metafilePath.replace(/\.meta\.json$/, '.inputs.json');
}

/** One esbuild bundle of `entry` (module comment). */
export async function buildBundle(options: BuildBundleOptions): Promise<BundleResult> {
  const root = options.root ?? REPO_ROOT;
  mkdirSync(dirname(options.outfile), { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: [options.entry],
    outfile: options.outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    sourcemap: 'linked',
    metafile: true,
    logLevel: 'warning',
    legalComments: 'none',
    define: { __ATMUSIC_GIT_SHA__: JSON.stringify(options.gitSha) },
    banner: { js: REQUIRE_BANNER },
    // ws's optional native speed-ups; ws falls back to JavaScript without them.
    external: ['bufferutil', 'utf-8-validate'],
  });
  writeFileSync(options.metafilePath, `${JSON.stringify(result.metafile, null, 1)}\n`);
  // The content hash of every repository source input as it was bundled, so
  // the guard can prove main.mjs and e2e.mjs were built from identical code.
  const inputHashes: Record<string, string> = {};
  for (const input of Object.keys(result.metafile.inputs).sort()) {
    if (input.includes('node_modules/') || input.includes(':')) continue;
    inputHashes[input] = createHash('sha256')
      .update(readFileSync(join(root, input)))
      .digest('hex');
  }
  writeFileSync(inputHashesPath(options.metafilePath), `${JSON.stringify(inputHashes, null, 1)}\n`);
  const sha256 = createHash('sha256').update(readFileSync(options.outfile)).digest('hex');
  return {
    outfile: options.outfile,
    metafilePath: options.metafilePath,
    metafile: result.metafile,
    sha256,
    gitSha: options.gitSha,
  };
}

function writeBuildInfo(outDir: string, key: 'main' | 'e2e', result: BundleResult | null): void {
  const path = join(outDir, BUILD_INFO);
  let info: Record<string, unknown> = {};
  try {
    info = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    info = {};
  }
  if (result === null) delete info[key];
  else info[key] = { gitSha: result.gitSha, sha256: result.sha256 };
  writeFileSync(path, `${JSON.stringify(info, null, 1)}\n`);
}

/** The default paths of a checkout at `root`. */
export function layout(root: string): { outDir: string; mainEntry: string; e2eEntry: string } {
  return {
    outDir: join(root, 'worker', 'dist', 'node'),
    mainEntry: join(root, 'worker', 'src', 'node', 'main.ts'),
    e2eEntry: join(root, 'worker', 'test', 'e2e', 'node-entry.ts'),
  };
}

export function buildMain(outDir: string, sha: string, root = REPO_ROOT): Promise<BundleResult> {
  return buildBundle({
    entry: layout(root).mainEntry,
    outfile: join(outDir, MAIN_BUNDLE),
    metafilePath: join(outDir, MAIN_METAFILE),
    gitSha: sha,
    root,
  });
}

export function buildE2e(outDir: string, sha: string, entry = E2E_ENTRY, root = REPO_ROOT): Promise<BundleResult> {
  return buildBundle({
    entry,
    outfile: join(outDir, E2E_BUNDLE),
    metafilePath: join(outDir, E2E_METAFILE),
    gitSha: sha,
    root,
  });
}

/** Removes an e2e bundle left by an earlier build. */
export function removeE2e(outDir: string): void {
  for (const name of [E2E_BUNDLE, `${E2E_BUNDLE}.map`, E2E_METAFILE, inputHashesPath(E2E_METAFILE)]) {
    rmSync(join(outDir, name), { force: true });
  }
}

interface Args {
  check: boolean;
  e2e: boolean;
  entry: string | null;
  outDir: string;
}

export function parseArgs(argv: readonly string[], cwd = process.cwd(), root = REPO_ROOT): Args {
  const args: Args = { check: false, e2e: false, entry: null, outDir: layout(root).outDir };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--check') args.check = true;
    else if (arg === '--e2e') args.e2e = true;
    else if (arg === '--entry' || arg === '--outdir') {
      const value = argv[i + 1];
      if (value === undefined || value === '') throw new BuildUsageError(`${arg} needs a path`);
      const path = isAbsolute(value) ? value : resolve(cwd, value);
      if (arg === '--entry') args.entry = path;
      else args.outDir = path;
      i++;
    } else {
      throw new BuildUsageError(`unknown argument ${arg}`);
    }
  }
  if (args.entry !== null && !args.e2e) throw new BuildUsageError('--entry is only valid with --e2e');
  if (args.check && args.e2e) throw new BuildUsageError('--check and --e2e are separate modes');
  return args;
}

export interface MainIo {
  out(line: string): void;
  err(line: string): void;
  cwd?: string;
  /** The checkout to build (default: this script's repository). */
  root?: string;
}

const defaultIo: MainIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** The CLI; returns the exit status. */
export async function main(argv: readonly string[], io: MainIo = defaultIo): Promise<number> {
  const root = io.root ?? REPO_ROOT;
  const paths = layout(root);
  let args: Args;
  try {
    args = parseArgs(argv, io.cwd, root);
  } catch (error) {
    if (error instanceof BuildUsageError) {
      io.err(`build-server: ${error.message}`);
      io.err('usage: build-server.ts [--check] [--outdir DIR] | --e2e [--entry PATH] [--outdir DIR]');
      return 2;
    }
    throw error;
  }
  try {
    const sha = gitSha(root);
    if (args.e2e) {
      const entry = args.entry ?? paths.e2eEntry;
      if (!existsSync(entry)) {
        io.err(`build-server: the e2e entry ${entry} does not exist`);
        return 2;
      }
      const e2e = await buildE2e(args.outDir, sha, entry, root);
      writeBuildInfo(args.outDir, 'e2e', e2e);
      io.out(`built ${e2e.outfile} (git ${sha}, sha256 ${e2e.sha256})`);
      return 0;
    }
    const main = await buildMain(args.outDir, sha, root);
    writeBuildInfo(args.outDir, 'main', main);
    io.out(`built ${main.outfile} (git ${sha}, sha256 ${main.sha256})`);
    if (!args.check) return 0;

    const version = spawnSync(process.execPath, [main.outfile, '--version'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      timeout: 60_000,
    });
    if (version.status !== 0 || version.stdout.trim() !== sha) {
      io.err(
        `build-server --check: \`node ${main.outfile} --version\` exited ${version.status} printing ${JSON.stringify(
          version.stdout.trim(),
        )}, expected ${sha}`,
      );
      return 1;
    }
    io.out(`check: main.mjs --version prints ${sha}`);
    if (existsSync(paths.e2eEntry)) {
      const e2e = await buildE2e(args.outDir, sha, paths.e2eEntry, root);
      writeBuildInfo(args.outDir, 'e2e', e2e);
      io.out(`built ${e2e.outfile} (git ${sha}, sha256 ${e2e.sha256})`);
    } else {
      removeE2e(args.outDir);
      writeBuildInfo(args.outDir, 'e2e', null);
      io.out('check: no worker/test/e2e/node-entry.ts yet (N6-01); no e2e bundle');
    }
    return 0;
  } catch (error) {
    io.err(`build-server: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
