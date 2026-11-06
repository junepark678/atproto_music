// Online backups (ADR 0005 §14.5, §3.10, §5.5; N3-07): node:sqlite's async
// backup into a 0600 .tmp file, the integrity check in a worker thread on the
// copy, the durable rename and the backup_runs row, retention, the
// pre-migration backup at startup, backups under load, the free-space floor
// and the revocation journal's truncation.

import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRevocations } from '../../src/app/revocations';
import { migrate } from '../../src/do/migrate';
import { MIGRATIONS } from '../../src/do/schema';
import { backupFiles, backupStamp, createBackups, integrityCheckInWorker, retentionPlan } from '../../src/node/backup';
import { readSchemaState } from '../../src/node/compose';
import type { StatfsFn } from '../../src/node/disk';
import { type ExitCode, type RunningServer, type RunOptions, run } from '../../src/node/run';
import { openSqliteDb, type SqliteDb } from '../../src/node/sqlite-db';
import { createNotifier, startWatchdog } from '../../src/node/systemd';
import {
  captureLog,
  closeApps,
  manualTimers,
  refusingJetstream,
  startApp,
  testEnv,
  testSecretsDocument,
} from './support/app';
import { TEST_BUSY_TIMEOUT_MS, withMigratedDb } from './support/node-db';

const ORIGINAL_FETCH = globalThis.fetch;
const DAY = 86_400_000;
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  await closeApps();
  globalThis.fetch = ORIGINAL_FETCH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `atmusic-backup-${label}-`));
  dirs.push(dir);
  return dir;
}

/** The rows of `sql` in a database file, read on its own read-only connection. */
function readCopy<T>(path: string, sql: string): T[] {
  const url = pathToFileURL(path);
  url.searchParams.set('immutable', '1');
  const db = new sqlite.DatabaseSync(url, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function regularFiles(dir: string): string[] {
  return backupFiles(readdirSync(dir))
    .filter((f) => f.kind === 'regular')
    .map((f) => f.name)
    .sort();
}

// --- run() harness (pre-migration backup, low disk) ---------------------------

interface Started {
  result: Promise<ExitCode>;
  server: Promise<RunningServer>;
  log: ReturnType<typeof captureLog>;
  stderr: string[];
}

function runFixture(): { dir: string; env: Record<string, string | undefined>; dbPath: string } {
  const dir = tempDir('run');
  const dist = join(dir, 'web', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html>');
  const secrets = join(dir, 'secrets.json');
  writeFileSync(secrets, JSON.stringify(testSecretsDocument()));
  chmodSync(secrets, 0o600);
  return {
    dir,
    env: { ...testEnv(dir), ATMUSIC_ASSETS_DIR: dist, ATMUSIC_SECRETS_FILE: secrets },
    dbPath: join(dir, 'state', 'atmusic.db'),
  };
}

function startRun(env: Record<string, string | undefined>, args: string[], extra: Partial<RunOptions> = {}): Started {
  const log = captureLog();
  const stderr: string[] = [];
  let ready: (s: RunningServer) => void = () => {};
  const server = new Promise<RunningServer>((resolve) => {
    ready = resolve;
  });
  const result = run({
    argv: ['node', 'main.mjs', ...args],
    env,
    exit: () => {},
    clock: fixedClock(),
    random: seededRandom(3),
    busyTimeoutMs: TEST_BUSY_TIMEOUT_MS,
    drainMs: 200,
    log: log.logger,
    stdout: () => {},
    stderr: (t) => stderr.push(t),
    configOptions: { fixtureOrigins: true, allowFixturePrefix: true },
    transport: routerTransport({}) as FixtureTransport,
    connectJetstream: refusingJetstream(),
    timers: manualTimers(),
    signals: new EventEmitter(),
    onReady: (s) => ready(s),
    ...extra,
  });
  cleanups.push(async () => {
    const s = await Promise.race([server, result.then(() => null)]);
    if (s !== null) await s.shutdown();
    await result;
  });
  return { result, server, log, stderr };
}

function socketRequest(socketPath: string, method: string, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        text += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A database at migration 1 with one marker row, closed. */
function legacyDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = openSqliteDb(path, { create: true, busyTimeoutMs: TEST_BUSY_TIMEOUT_MS });
  try {
    expect(migrate(db, MIGRATIONS.slice(0, 1))).toEqual({ status: 'ready', version: 1 });
    db.run("INSERT INTO counters(name, label, value) VALUES ('legacy_marker', '', 41)");
  } finally {
    db.close();
  }
}

describe('backups', () => {
  it('a backup is written by node:sqlite backup() as .tmp, passes integrity_check in a worker thread on the copy, is renamed to atmusic-YYYYMMDDTHHMMZ.db with mode 0600 and recorded in backup_runs', async () => {
    await withMigratedDb(async (db, ctx) => {
      db.run("INSERT INTO counters(name, label, value) VALUES ('before_backup', '', 7)");
      const dir = join(ctx.dir, 'backups');
      const clock = fixedClock();
      const final = join(dir, 'atmusic-20260115T1200Z.db');
      const checks: Array<{ path: string; tmpExists: boolean; finalExists: boolean; mode: number }> = [];
      const workers: number[] = [];
      const onWorker = (w: { threadId: number }) => workers.push(w.threadId);
      process.on('worker', onWorker);
      try {
        const backups = createBackups({
          db,
          dir,
          clock,
          log: captureLog().logger,
          minFreeBytes: 0,
          integrityCheck: async (path) => {
            checks.push({
              path,
              tmpExists: existsSync(path),
              finalExists: existsSync(final),
              mode: statSync(path).mode & 0o777,
            });
            return integrityCheckInWorker(path);
          },
        });
        const outcome = await backups.run('manual');
        expect(outcome).toEqual({
          status: 'ok',
          kind: 'manual',
          path: final,
          bytes: statSync(final).size,
          startedAtMs: clock.nowMs(),
          finishedAtMs: clock.nowMs(),
        });
      } finally {
        process.off('worker', onWorker);
      }
      // The check ran on the .tmp copy, before the rename, in a worker thread.
      expect(checks).toEqual([{ path: `${final}.tmp`, tmpExists: true, finalExists: false, mode: 0o600 }]);
      expect(workers.length).toBe(1);
      expect(readdirSync(dir)).toEqual(['atmusic-20260115T1200Z.db']);
      expect(statSync(final).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(backupStamp(clock.nowMs())).toBe('20260115T1200Z');
      // The copy is the database, and passes integrity_check.
      expect(readCopy<{ value: number }>(final, "SELECT value FROM counters WHERE name = 'before_backup'")).toEqual([
        { value: 7 },
      ]);
      expect(await integrityCheckInWorker(final)).toEqual(['ok']);
      expect(
        db.all('SELECT kind, started_at_ms, finished_at_ms, path, bytes, ok, error FROM backup_runs ORDER BY id'),
      ).toEqual([
        {
          kind: 'manual',
          started_at_ms: clock.nowMs(),
          finished_at_ms: clock.nowMs(),
          path: final,
          bytes: statSync(final).size,
          ok: 1,
          error: null,
        },
      ]);

      // A second backup in the same minute gets a suffix (and, the newest of
      // its day, replaces the first under the one-per-day retention); a failed
      // integrity check writes no file and records the failure.
      const second = await createBackups({ db, dir, clock, log: captureLog().logger, minFreeBytes: 0 }).run('daily');
      expect(second).toMatchObject({ status: 'ok', path: join(dir, 'atmusic-20260115T1200Z-2.db') });
      expect(readdirSync(dir)).toEqual(['atmusic-20260115T1200Z-2.db']);
      const corrupt = await createBackups({
        db,
        dir,
        clock,
        log: captureLog().logger,
        minFreeBytes: 0,
        integrityCheck: async () => ['*** in database main ***', 'Page 3: btreeInitPage() returns error code 11'],
      }).run('manual');
      expect(corrupt).toEqual({ status: 'failed', kind: 'manual', error: 'integrity_check_failed' });
      expect(readdirSync(dir)).toEqual(['atmusic-20260115T1200Z-2.db']);
      expect(db.all('SELECT kind, ok, error FROM backup_runs ORDER BY id')).toEqual([
        { kind: 'manual', ok: 1, error: null },
        { kind: 'daily', ok: 1, error: null },
        { kind: 'manual', ok: 0, error: 'integrity_check_failed' },
      ]);
      // The worker's check is real: a damaged copy does not pass it.
      const damaged = join(ctx.dir, 'damaged.db');
      const bytes = Buffer.from(readFileSync(join(dir, 'atmusic-20260115T1200Z-2.db')));
      bytes.fill(0x55, 4096 * 2, 4096 * 3);
      writeFileSync(damaged, bytes);
      const verdict = await integrityCheckInWorker(damaged).catch((error: Error) => [`rejected: ${error.message}`]);
      expect(verdict).not.toEqual(['ok']);
      expect(verdict.length).toBeGreaterThan(0);
    });
  });

  it('after 40 simulated days, retention keeps exactly 7 daily and 4 weekly files and never deletes a pre_migration copy', async () => {
    await withMigratedDb(async (db, ctx) => {
      const dir = join(ctx.dir, 'backups');
      const clock = fixedClock('2026-01-01T03:30:00Z');
      const backups = createBackups({
        db,
        dir,
        clock,
        log: captureLog().logger,
        minFreeBytes: 0,
        integrityCheck: async () => ['ok'],
      });
      const pre = await backups.run('pre_migration');
      expect(pre).toMatchObject({ status: 'ok', path: join(dir, 'atmusic-20260101T0330Z.pre-migration.db') });
      const made: number[] = [];
      for (let day = 0; day < 40; day++) {
        clock.advance(DAY);
        made.push(clock.nowMs());
        expect((await backups.run('daily')).status).toBe('ok');
      }
      const kept = regularFiles(dir);
      expect(kept).toHaveLength(11);
      const keptTimes = backupFiles(kept).map((f) => f.timeMs);
      // The 7 newest days, one file each.
      const newest7 = made.slice(-7);
      for (const t of newest7) expect(keptTimes).toContain(t);
      // 4 weekly: older than the dailies, in 4 distinct Monday-based weeks,
      // each the newest backup of its week.
      const weekOf = (ms: number) => Math.floor((Math.floor(ms / DAY) + 3) / 7);
      const weekly = keptTimes.filter((t) => t < (newest7[0] as number)).sort((a, b) => a - b);
      expect(weekly).toHaveLength(4);
      expect(new Set(weekly.map(weekOf)).size).toBe(4);
      for (const t of weekly) {
        const sameWeek = made.filter((m) => weekOf(m) === weekOf(t) && m < (newest7[0] as number));
        expect(t).toBe(Math.max(...sameWeek));
      }
      // The pre-migration copy (the oldest file) is still there.
      expect(existsSync(join(dir, 'atmusic-20260101T0330Z.pre-migration.db'))).toBe(true);
      expect(backups.status().files.preMigration).toEqual(['atmusic-20260101T0330Z.pre-migration.db']);
      expect(readdirSync(dir).length).toBe(12);
      // Every run is recorded, deleted files included.
      expect(db.one<{ n: number }>("SELECT count(*) AS n FROM backup_runs WHERE kind = 'daily' AND ok = 1")?.n).toBe(
        40,
      );
      // The plan itself never lists another kind.
      expect(retentionPlan(backupFiles(['atmusic-20250101T0000Z.pre-migration.db'])).remove).toEqual([]);
    });
  }, 60_000);

  it('startup with a pending migration writes a pre-migration backup before migrating', async () => {
    const f = runFixture();
    legacyDatabase(f.dbPath);
    const started = startRun(f.env, []);
    const server = await started.server;
    const backupDir = join(f.dir, 'state', 'backups');
    const copy = join(backupDir, 'atmusic-20260115T1200Z.pre-migration.db');
    expect(readdirSync(backupDir)).toEqual(['atmusic-20260115T1200Z.pre-migration.db']);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    // The copy is the database before the migration: version 1, with its data.
    expect(readCopy<{ v: number }>(copy, 'SELECT max(version) AS v FROM schema_migrations')).toEqual([{ v: 1 }]);
    expect(readCopy(copy, "SELECT name FROM sqlite_master WHERE name = 'backup_runs'")).toEqual([]);
    expect(readCopy<{ value: number }>(copy, "SELECT value FROM counters WHERE name = 'legacy_marker'")).toEqual([
      { value: 41 },
    ]);
    // The live database is migrated, and the backup recorded once the table existed.
    expect(readSchemaState(server.db)).toEqual({ status: 'ready', version: MIGRATIONS.length });
    expect(server.db.all('SELECT kind, ok, path FROM backup_runs')).toEqual([
      { kind: 'pre_migration', ok: 1, path: copy },
    ]);
    const events = started.log.logs.map((l) => l.event);
    expect(events.indexOf('backup.completed')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('backup.completed')).toBeLessThan(events.indexOf('run.migrated'));
    expect(started.log.logs.find((l) => l.event === 'backup.completed')?.kind).toBe('pre_migration');

    // A refused free-space check exits 78 naming ATMUSIC_MIN_FREE_BYTES and does not migrate.
    const g = runFixture();
    legacyDatabase(g.dbPath);
    const low = startRun(g.env, [], { statfs: () => ({ bavail: 1n, bsize: 1n }) });
    expect(await low.result).toBe(78);
    expect(low.stderr.join('')).toContain('ATMUSIC_MIN_FREE_BYTES');
    const check = openSqliteDb(g.dbPath, { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS });
    try {
      expect(readSchemaState(check)).toEqual({ status: 'pending', version: 1 });
    } finally {
      check.close();
    }
    expect(existsSync(join(g.dir, 'state', 'backups')) ? regularFiles(join(g.dir, 'state', 'backups')) : []).toEqual(
      [],
    );
  });

  it('while a rate-limited backup runs, 1,000 committed writes and an HTTP request are served and WATCHDOG=1 is still sent, and the copy is a consistent snapshot that passes integrity_check', async () => {
    const app = await startApp();
    const db: SqliteDb = app.db;
    db.run('CREATE TABLE load_rows (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
    db.run('CREATE TABLE load_total (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), n INTEGER NOT NULL)');
    db.run('INSERT INTO load_total (singleton, n) VALUES (1, 0)');
    // About 2,500 pages: at a rate of 20 pages per step, well over 100 steps
    // (a lower rate than production's 100 keeps the fixture small).
    db.tx(() => {
      for (let i = 0; i < 2_500; i++) db.run('INSERT INTO load_rows (payload) VALUES (randomblob(3900))');
      db.run('UPDATE load_total SET n = 2500');
    });
    const write = () =>
      db.tx(() => {
        db.run('INSERT INTO load_rows (payload) VALUES (randomblob(16))');
        db.run('UPDATE load_total SET n = n + 1');
      });

    const notes: string[] = [];
    const notifier = createNotifier({
      env: { NOTIFY_SOCKET: '/run/test/notify' },
      log: captureLog().logger,
      spawn: async (states) => {
        notes.push(...states);
      },
    });
    const watchdog = startWatchdog({
      notifier,
      intervalMs: 1,
      log: captureLog().logger,
      dbProbe: () => db.one<{ ok: number }>('SELECT 1 AS ok')?.ok === 1,
    });
    cleanups.push(async () => watchdog.stop());

    let writes = 0;
    let steps = 0;
    let running = true;
    let httpDuring: number | null = null;
    let watchdogDuring = 0;
    const backups = createBackups({
      db,
      dir: join(app.dir, 'backups'),
      clock: app.clock,
      log: captureLog().logger,
      minFreeBytes: 0,
      rate: 20,
      onProgress: () => {
        steps += 1;
        // Ten committed transactions between backup steps.
        for (let i = 0; i < 10 && writes < 1000; i++) {
          write();
          writes += 1;
        }
      },
    });
    const response = app.fetch('/health/ready').then(async (res) => {
      if (running) httpDuring = res.status;
      return res.status;
    });
    const notesBefore = notes.length;
    const pending = backups.run('manual');
    const ticker = (async () => {
      while (running) {
        watchdogDuring = notes.slice(notesBefore).filter((n) => n === 'WATCHDOG=1').length;
        await new Promise((r) => setImmediate(r));
      }
    })();
    const outcome = await pending;
    const writesWhileRunning = writes;
    running = false;
    await ticker;
    expect(outcome.status).toBe('ok');
    expect(steps).toBeGreaterThanOrEqual(100);
    expect(writesWhileRunning).toBe(1000);
    expect(await response).toBe(200);
    expect(httpDuring).toBe(200);
    expect(watchdogDuring).toBeGreaterThan(0);
    expect(watchdog.report().sent).toBeGreaterThan(0);
    // The live database has every write.
    expect(db.one<{ n: number }>('SELECT n FROM load_total')?.n).toBe(3_500);
    expect(db.one<{ n: number }>('SELECT count(*) AS n FROM load_rows')?.n).toBe(3_500);
    // The copy is one consistent commit: its counter equals its row count.
    const path = outcome.status === 'ok' ? outcome.path : '';
    const [total] = readCopy<{ n: number }>(path, 'SELECT n FROM load_total');
    const [rows] = readCopy<{ n: number }>(path, 'SELECT count(*) AS n FROM load_rows');
    expect(total?.n).toBe(rows?.n);
    expect(total?.n).toBeGreaterThanOrEqual(2_500);
    expect(await integrityCheckInWorker(path)).toEqual(['ok']);
  }, 60_000);

  it('with free space below the database size plus ATMUSIC_MIN_FREE_BYTES the backup writes no file, records a failed backup_runs row with error low_disk, and adminStatus reports it', async () => {
    const f = runFixture();
    const minFree = 2_147_483_648;
    let free = 1n << 50n;
    const statfs: StatfsFn = () => ({ bavail: free, bsize: 1n });
    const started = startRun(f.env, ['--init'], { statfs });
    const server = await started.server;
    const dbBytes = statSync(f.dbPath).size + (existsSync(`${f.dbPath}-wal`) ? statSync(`${f.dbPath}-wal`).size : 0);
    // One byte short of the database size plus the floor (above the floor alone).
    free = BigInt(dbBytes + minFree - 1);
    const answer = await socketRequest(server.adminSocket, 'POST', '/admin/backup');
    expect(answer).toEqual({ status: 507, json: { status: 'failed', kind: 'manual', error: 'low_disk' } });
    const backupDir = join(f.dir, 'state', 'backups');
    expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toEqual([]);
    expect(server.db.all('SELECT kind, ok, error, path, bytes FROM backup_runs')).toEqual([
      { kind: 'manual', ok: 0, error: 'low_disk', path: null, bytes: null },
    ]);
    const status = await socketRequest(server.adminSocket, 'GET', '/admin/status');
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({
      backup: { ageMs: null, lastSuccess: null, lastRun: { kind: 'manual', ok: false, error: 'low_disk' } },
      disk: { freeBytes: dbBytes + minFree - 1, minFreeBytes: minFree, low: false },
    });

    // With enough space the same request succeeds.
    free = BigInt(dbBytes + minFree + 1_000_000);
    const ok = await socketRequest(server.adminSocket, 'POST', '/admin/backup');
    expect(ok.status).toBe(200);
    expect(regularFiles(backupDir)).toEqual(['atmusic-20260115T1200Z.db']);
    // Below the floor itself readiness warns too.
    free = 1n;
    const low = await socketRequest(server.adminSocket, 'GET', '/admin/status');
    expect(low.json).toMatchObject({ warnings: ['low_disk'], disk: { low: true } });
  });

  it('a completed backup truncates revocations.log to the events newer than the oldest backup file in the directory', async () => {
    await withMigratedDb(async (db, ctx) => {
      const dir = join(ctx.dir, 'backups');
      const clock: FixedClock = fixedClock('2026-01-01T10:00:00Z');
      const journal = new FileRevocations({ path: join(ctx.dir, 'revocations.log'), clock });
      cleanups.push(async () => journal.close());
      let free = 1n << 50n;
      const backups = createBackups({
        db,
        dir,
        clock,
        log: captureLog().logger,
        minFreeBytes: 0,
        statfs: () => ({ bavail: free, bsize: 1n }),
        revocations: journal,
        integrityCheck: async () => ['ok'],
      });
      const did = 'did:plc:abcdefghijklmnopqrstuvwx';
      const ids = () => journal.entries().map((e) => ('id' in e ? e.id : e.kind));

      journal.record({ kind: 'app_password', id: 'a-day0', did });
      clock.advance(DAY);
      expect((await backups.run('pre_migration')).status).toBe('ok'); // file at day 1
      expect(ids()).toEqual([]); // day 0 is older than every backup
      clock.advance(DAY);
      journal.record({ kind: 'app_password', id: 'b-day2', did });
      clock.advance(DAY);
      journal.record({ kind: 'lb_token', id: 'c-day3', did });
      clock.advance(DAY);
      expect((await backups.run('daily')).status).toBe('ok'); // file at day 4
      // The pre-migration copy (day 1) is the oldest file: day 2 and 3 stay.
      expect(ids()).toEqual(['b-day2', 'c-day3']);

      // A failed backup truncates nothing.
      free = 0n;
      clock.advance(DAY);
      journal.record({ kind: 'lb_token', id: 'd-day5', did });
      expect((await backups.run('manual')).status).toBe('failed');
      expect(ids()).toEqual(['b-day2', 'c-day3', 'd-day5']);

      // The owner deletes the pre-migration copy: the day-4 file is now the oldest.
      unlinkSync(join(dir, 'atmusic-20260102T1000Z.pre-migration.db'));
      free = 1n << 50n;
      clock.advance(DAY);
      expect((await backups.run('daily')).status).toBe('ok'); // file at day 6
      expect(ids()).toEqual(['d-day5']);
      expect(regularFiles(dir)).toEqual(['atmusic-20260105T1000Z.db', 'atmusic-20260107T1000Z.db']);
    });
  });
});
