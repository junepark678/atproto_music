// Deterministic Node *candidate* packaging. No activation/publication or live
// verdict. Refuse dirty sources, stale bundles, tag/version mismatch and test
// hosts. B11 identity is git SHA + main.mjs SHA-256, never a static ELF claim.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { gitSha, NO_COMMIT_SHA, REPO_ROOT } from './build-server';
import { runGuard } from './check-node-bundle';

const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
export function checkTag(tag: string, version: string, lockVersion: string): void {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) || tag !== `v${version}` || version !== lockVersion)
    throw new Error('Node tag/package.json/package-lock.json version mismatch');
}
function files(root: string, path = ''): string[] {
  return readdirSync(join(root, path))
    .sort()
    .flatMap((name) => {
      const rel = join(path, name);
      const stat = lstatSync(join(root, rel));
      if (stat.isSymbolicLink()) throw new Error(`symlink refused in candidate: ${rel}`);
      if (stat.isDirectory()) return files(root, rel);
      if (!stat.isFile()) throw new Error(`non-regular candidate file: ${rel}`);
      return [rel];
    });
}
export interface CandidateOptions {
  tag: string;
  out: string;
  dist?: string;
  assets?: string;
  root?: string;
}
export function packageCandidate(options: CandidateOptions): string {
  const root = options.root ?? REPO_ROOT;
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
    version?: unknown;
    packages?: Record<string, { version?: unknown }>;
  };
  const lockVersion = lock?.version;
  const rootLockVersion = lock?.packages?.['']?.version;
  if (typeof lockVersion !== 'string' || typeof rootLockVersion !== 'string')
    throw new Error('package-lock root package metadata missing');
  checkTag(options.tag, version, lockVersion);
  checkTag(options.tag, version, rootLockVersion);
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (status.trim()) throw new Error('candidate requires a clean committed checkout; dirty evidence is not a release');
  const commit = gitSha(root);
  if (commit === NO_COMMIT_SHA) throw new Error('candidate requires a real commit');
  const dist = options.dist ?? join(root, 'worker/dist/node');
  const assets = options.assets ?? join(root, 'web/dist');
  if (process.version !== `v${readFileSync(join(root, '.nvmrc'), 'utf8').trim()}`)
    throw new Error('candidate must run on pinned .nvmrc Node');
  const guardLog: string[] = [];
  if (runGuard({ root, dist }, { out: (s) => guardLog.push(s), err: (s) => guardLog.push(s) }) !== 0)
    throw new Error(`bundle guard failed: ${guardLog.join('; ')}`);
  const info = JSON.parse(readFileSync(join(dist, 'build-info.json'), 'utf8')) as {
    main: { gitSha: string; sha256: string };
  };
  if (info.main.gitSha !== commit || info.main.sha256 !== hash(join(dist, 'main.mjs')))
    throw new Error('bundle differs from build-info identity');
  const inputs = JSON.parse(readFileSync(join(dist, 'main.inputs.json'), 'utf8')) as Record<string, string>;
  if (Object.keys(inputs).length < 60) throw new Error('missing/non-vacuous source inputs required');
  for (const [path, digest] of Object.entries(inputs)) {
    const source = resolve(root, path);
    if (relative(root, source).startsWith('..') || hash(source) !== digest)
      throw new Error(`stale/invalid bundle input: ${path}`);
  }
  const versionProbe = spawnSync(process.execPath, [join(dist, 'main.mjs'), '--version'], {
    encoding: 'utf8',
    env: {},
    timeout: 30_000,
  });
  if (versionProbe.status !== 0 || versionProbe.stdout.trim() !== commit)
    throw new Error('bundle git SHA does not match checkout');
  const stage = mkdtempSync(join(tmpdir(), 'atmusic-node-candidate-'));
  try {
    const packagedDist = join(stage, 'worker', 'dist', 'node');
    mkdirSync(packagedDist, { recursive: true });
    for (const name of ['main.mjs', 'main.mjs.map', 'main.meta.json', 'main.inputs.json']) {
      if (!lstatSync(join(dist, name)).isFile()) throw new Error(`regular bundle file required: ${name}`);
      cpSync(join(dist, name), join(packagedDist, name));
    }
    const assetFiles = files(assets);
    if (!assetFiles.includes('index.html')) throw new Error('candidate assets require index.html');
    for (const name of assetFiles) {
      const dest = join(stage, 'web/dist', name);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(assets, name), dest);
    }
    const payloadHashes = Object.fromEntries(files(stage).map((path) => [path, hash(join(stage, path))]));
    writeFileSync(
      join(stage, 'candidate.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: 'node-candidate-not-accepted',
          version,
          tag: options.tag,
          commit,
          bundleSha256: payloadHashes['worker/dist/node/main.mjs'],
          packageLockSha256: hash(join(root, 'package-lock.json')),
          runtime: {
            node: process.version,
            sqlite: process.versions.sqlite,
            required: readFileSync(join(root, '.nvmrc'), 'utf8').trim(),
          },
          files: payloadHashes,
          notAccepted: [
            'browser migration',
            'full packaged backend acceptance',
            'live evidence',
            'installer activation',
            'systemd unit installation and provenance',
            'admin and restore tooling (not packaged)',
            'web asset build/source provenance',
            'production backup, restore, and rollback rehearsal',
          ],
        },
        null,
        2,
      )}\n`,
    );
    const tar = execFileSync(
      'tar',
      [
        '--sort=name',
        '--mtime=@0',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '--mode=u=rwX,go=rX',
        '--format=posix',
        '--pax-option=delete=atime,delete=ctime',
        '-cf',
        '-',
        '-C',
        stage,
        '.',
      ],
      { maxBuffer: 100_000_000 },
    );
    mkdirSync(options.out, { recursive: true });
    const name = `atmusic-${version}-node-candidate.tar.gz`;
    writeFileSync(join(options.out, name), gzipSync(tar));
    writeFileSync(join(options.out, 'SHA256SUMS'), `${hash(join(options.out, name))}  ${name}\n`);
    return join(options.out, name);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function main(argv: readonly string[]): number {
  if (argv.length !== 4 || argv[0] !== '--tag' || !argv[1] || argv[2] !== '--out' || !argv[3]) {
    console.error('usage: package-node-release.ts --tag vX.Y.Z --out DIR');
    return 2;
  }
  try {
    console.log(packageCandidate({ tag: argv[1], out: resolve(argv[3]) }));
    return 0;
  } catch (error) {
    console.error(`package-node-release: ${String(error)}`);
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
