// Export the exact historical source needed by static test audits. Requires
// both pinned Git objects already present; does not fetch missing history.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE = '3d953a91d771a6003472161a5b18329a8ebe2d9c';
const WAVE_START = 'e309f52c0c8fba3cb0949edf7284d932b09edb4f';
const MODULE_DIRS = ['harness', 'storage', 'ingest', 'read', 'write', 'http'].map((d) => `worker/test/${d}/`);
const WAVE_FILES = [
  'worker/test/storage/migrate.test.ts',
  'worker/test/write/support.ts',
  'worker/test/fixtures/jetstream-server.ts',
];
const OUT = join(ROOT, 'scripts/test/fixtures/node-history-sources.json');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

for (const commit of [BASELINE, WAVE_START]) git('cat-file', '-e', `${commit}^{commit}`);
const baselineFiles = git('ls-tree', '-r', '--name-only', BASELINE, '--', ...MODULE_DIRS)
  .split('\n')
  .filter((file) => file.endsWith('.test.ts'));
if (baselineFiles.length < 40) throw new Error(`Unexpected baseline file count: ${baselineFiles.length}`);
const collect = (commit, files) => Object.fromEntries(files.map((file) => [file, git('show', `${commit}:${file}`)]));
const fixture = {
  baselineCommit: BASELINE,
  waveStartCommit: WAVE_START,
  baselineSources: collect(BASELINE, baselineFiles),
  waveStartSources: collect(WAVE_START, WAVE_FILES),
};
const text = `${JSON.stringify(fixture, null, 2)}\n`;
const manifest = {
  baselineCommit: BASELINE,
  waveStartCommit: WAVE_START,
  generationCommand: 'node scripts/test/regenerate-history-baselines.mjs',
  format: 'JSON map of repository-relative paths to exact historical UTF-8 source text',
  fixtureSha256: sha256(text),
  baselineFileCount: baselineFiles.length,
  waveStartFileCount: WAVE_FILES.length,
};
writeFileSync(OUT, text);
writeFileSync(join(ROOT, 'scripts/test/fixtures/node-history-sources.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
