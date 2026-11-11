// Regenerate the offline schema-56 producer fixture from its exact historical
// source commit. Requires the full Git object and the repository's locked
// dependencies already installed (`npm ci --ignore-scripts`); never fetches.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../worker/src/do/schema.ts';
import { migrate } from '../../worker/src/do/migrate.ts';
import { openSqliteDb } from '../../worker/src/node/sqlite-db.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = '5d573706bf07bb50e0c8b79cf1d34a3f6c56a975';
const FIXTURES = join(ROOT, 'scripts/test/fixtures');
const TEST_SOURCE = join(FIXTURES, 'schema56-parent-producer.test.ts.txt');
const OUT_SQL = join(FIXTURES, 'schema56-parent-producer.sql');
const OUT_META = join(FIXTURES, 'schema56-parent-producer.json');
const OUT_MANIFEST = join(FIXTURES, 'schema56-parent-producer.manifest.json');

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function canonicalSchema(db) {
  const sql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
  return (typeof db.prepare === 'function' ? db.prepare(sql).all() : db.exec(sql))
    .map(({ type, name, tbl_name, sql }) => `${type}\t${name}\t${tbl_name}\t${String(sql).replace(/\\s+/g, ' ').trim()}`)
    .join('\n');
}

if (!existsSync(join(ROOT, 'node_modules/.bin/vitest')))
  throw new Error('Locked dependencies are missing; install explicitly with npm ci --ignore-scripts before regeneration.');
execFileSync('git', ['cat-file', '-e', `${SOURCE}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
const temp = mkdtempSync(join(tmpdir(), 'atmusic-schema56-regenerate-'));
try {
  const archiveDir = join(temp, 'source');
  const outputDb = join(temp, 'schema56.db');
  const testPath = join(archiveDir, 'worker/test/node/outbox/schema56-producer-restore.test.ts');
  const tar = execFileSync('git', ['archive', '--format=tar', SOURCE], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('mkdir', ['-p', archiveDir]);
  execFileSync('tar', ['-xf', '-', '-C', archiveDir], { input: tar, maxBuffer: 8 * 1024 * 1024 });
  symlinkSync(join(ROOT, 'node_modules'), join(archiveDir, 'node_modules'), 'dir');
  execFileSync('mkdir', ['-p', dirname(testPath)]);
  copyFileSync(TEST_SOURCE, testPath);
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules/.bin/vitest'), 'run', '--config', 'vitest.node.config.ts', 'test/node/outbox/schema56-producer-restore.test.ts', '--maxWorkers', '1'],
    { cwd: join(archiveDir, 'worker'), env: { ...process.env, ATMUSIC_SCHEMA56_OUTPUT: outputDb }, stdio: 'inherit' },
  );

  const metadata = JSON.parse(readFileSync(`${outputDb}.json`, 'utf8'));
  const dump = execFileSync('sqlite3', ['-batch', outputDb, '.dump'], { maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(OUT_SQL, dump);
  writeFileSync(OUT_META, `${JSON.stringify(metadata, null, 2)}\n`);

  const scratchPath = join(temp, 'schema56-ddl.db');
  const scratch = openSqliteDb(scratchPath, { create: true });
  const producer = new DatabaseSync(outputDb, { readOnly: true });
  try {
    const result = migrate(scratch, MIGRATIONS.slice(0, 56));
    if (result.status !== 'ready' || result.version !== 56) throw new Error('Current migrations did not build schema 56.');
    const producerDdl = canonicalSchema(producer);
    const scratchDdl = canonicalSchema(scratch);
    if (producerDdl !== scratchDdl) throw new Error('Producer database schema differs from canonical migrations 1–56.');
    const manifest = {
      sourceCommit: SOURCE,
      generationCommand: 'node --import tsx scripts/test/regenerate-schema56-fixture.mjs',
      fixtureFormat: 'sqlite3 .dump SQL plus JSON producer metadata; test runs only load these checked-in text outputs',
      producerTest: 'scripts/test/fixtures/schema56-parent-producer.test.ts',
      producerGeneration: 'Run once from the exact schema-56 source archive; CI replays the exported SQL and does not rerun old producer code.',
      schemaVersion: 56,
      canonicalMigration1To56DdlSha256: sha256(scratchDdl),
      sqlSha256: sha256(dump),
      metadataSha256: sha256(`${JSON.stringify(metadata, null, 2)}\n`),
    };
    writeFileSync(OUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    producer.close();
    scratch.close();
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
