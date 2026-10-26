// Online backups of the one database file (ADR 0005 §14.5, §3.10, §5.5; N3-07).
//
// `createBackups(options)` is the host's BackupPort (app/host.ts): IndexCore's
// adminBackup (`POST /admin/backup` on the admin socket), the daily `backup`
// extension timer (03:30 UTC) and the startup pre-migration backup (run.ts)
// all go through `run(kind)`. Runs never overlap: a second call waits for the
// first. One run:
//
// 0. Free space. Refused unless the filesystem of the backup directory has at
//    least the database size (the file plus its WAL) plus
//    ATMUSIC_MIN_FREE_BYTES free, so a backup can never fill the disk under the
//    live database (§5.5). A refusal writes no file and is a failed run with
//    error `low_disk`.
// 1. node:sqlite's async `backup(db, '<name>.tmp', {rate: 100})` copies the
//    live database incrementally from its own connection, yielding to the
//    event loop between steps, so HTTP, timers and WATCHDOG=1 keep running.
//    Writes committed on that connection during the copy are carried into it
//    (SQLite updates a backup from its own source connection in place), so the
//    finished copy is the database as of one commit. The `.tmp` file is
//    created 0600 before SQLite opens it.
// 2. `PRAGMA integrity_check` runs in a worker thread on its own read-only
//    (immutable) connection to the copy, never on the live file, so a check of
//    a large index never blocks the main thread past `WatchdogSec`.
// 3. The copy is fsynced, renamed to `atmusic-YYYYMMDDTHHMMZ.db` (a second
//    backup in the same minute gets `-2`, `-3`, ...), the directory fsynced,
//    and the run recorded in `backup_runs` with its kind.
// 4. Retention over the plain `atmusic-*.db` files (daily and manual runs):
//    the newest file of each of the 7 newest UTC days, then the newest file
//    of each of the 4 newest ISO weeks among the older files. Pre-migration
//    copies (`atmusic-*.pre-migration.db`) and pre-restore copies
//    (`*.pre-restore.db`) are never deleted here; the owner deletes them.
// 5. The revocation journal (app/revocations.ts) is truncated to the entries
//    at or after the oldest backup file still in the directory (pre-migration
//    and pre-restore copies included), by the time in its name. That time is
//    the run's start rounded down to the minute, never later than the copy's
//    contents, so every backup that can be restored keeps its journal.
//
// Every failure is recorded (`backup_runs.ok = 0` with a short error name:
// `low_disk`, `integrity_check_failed`, `backup_failed`) and returned as a
// `failed` outcome; nothing here throws for a failed backup. The
// pre-migration backup runs before `backup_runs` exists on an old database,
// so run.ts takes it with `{record: false}` and records the outcome with
// `record()` once the migration has created the table.

import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { Clock } from '@atmusic/core/deps';
import type { CoreExtension } from '../app/host';
import { errorName } from '../app/index-core';
import type { BackupKind, BackupOutcome, Logger } from '../do/contracts';
import { BACKUP_KINDS } from '../do/schema';
import { freeBytes, nodeStatfs, type StatfsFn } from './disk';
import type { SqliteDb } from './sqlite-db';

/** Pages copied per backup step (ADR §14.5). */
export const BACKUP_RATE_PAGES = 100;
export const DAILY_RETAIN = 7;
export const WEEKLY_RETAIN = 4;
export const BACKUP_FILE_MODE = 0o600;
export const BACKUP_DIR_MODE = 0o700;
/** The daily backup's wall-clock time (UTC). */
export const DAILY_BACKUP_UTC = { hour: 3, minute: 30 } as const;

const STAMP = '\\d{8}T\\d{4}Z';
/** A daily or manual backup file. */
export const BACKUP_FILE = new RegExp(`^atmusic-(${STAMP})(?:-([1-9][0-9]*))?\\.db$`);
/** A pre-migration copy (kept until the owner deletes it). */
export const PRE_MIGRATION_FILE = new RegExp(`^atmusic-(${STAMP})(?:-([1-9][0-9]*))?\\.pre-migration\\.db$`);
/** A pre-restore copy (kept until the owner deletes it). */
export const PRE_RESTORE_FILE = new RegExp(`^atmusic-(${STAMP})(?:-([1-9][0-9]*))?\\.pre-restore\\.db$`);

const DAY_MS = 86_400_000;

export type BackupResult = Exclude<BackupOutcome, { status: 'not_supported' }>;

/** `YYYYMMDDTHHMMZ` of `ms` (UTC). */
export function backupStamp(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-01-15T12:00:00.000Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

/** The epoch ms of a `YYYYMMDDTHHMMZ` stamp, or null. */
export function parseBackupStamp(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(stamp);
  if (m === null) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return backupStamp(ms) === stamp ? ms : null;
}

export interface BackupFile {
  name: string;
  /** The time in the name. */
  timeMs: number;
  kind: 'regular' | 'pre_migration' | 'pre_restore';
}

/** Backup files in `names` (any other name is ignored). */
export function backupFiles(names: readonly string[]): BackupFile[] {
  const out: BackupFile[] = [];
  for (const name of names) {
    for (const [pattern, kind] of [
      [BACKUP_FILE, 'regular'],
      [PRE_MIGRATION_FILE, 'pre_migration'],
      [PRE_RESTORE_FILE, 'pre_restore'],
    ] as const) {
      const m = pattern.exec(name);
      if (m === null) continue;
      const timeMs = parseBackupStamp(m[1] as string);
      if (timeMs !== null) out.push({ name, timeMs, kind });
    }
  }
  return out;
}

/** Monday-based week number since the epoch (1970-01-01 was a Thursday). */
function weekOf(ms: number): number {
  return Math.floor((Math.floor(ms / DAY_MS) + 3) / 7);
}

/** The collision suffix of a backup file name (`-2` → 2; none → 1). */
function suffixOf(name: string): number {
  const m = /^atmusic-\d{8}T\d{4}Z-([1-9][0-9]*)\./.exec(name);
  return m === null ? 1 : Number(m[1]);
}

/** Order: newest first (time, then the collision suffix). */
function newestFirst(a: BackupFile, b: BackupFile): number {
  if (a.timeMs !== b.timeMs) return b.timeMs - a.timeMs;
  return suffixOf(b.name) - suffixOf(a.name);
}

/**
 * Which regular backup files to keep and which to delete: 7 daily, then 4
 * weekly among the older files (module comment). Other kinds are never listed.
 */
export function retentionPlan(
  files: readonly BackupFile[],
  daily = DAILY_RETAIN,
  weekly = WEEKLY_RETAIN,
): { keep: string[]; remove: string[] } {
  const regular = files.filter((f) => f.kind === 'regular').sort(newestFirst);
  const keep = new Set<string>();
  const days = new Set<number>();
  let oldestDaily: number | null = null;
  for (const f of regular) {
    if (days.size >= daily) break;
    const day = Math.floor(f.timeMs / DAY_MS);
    if (days.has(day)) continue;
    days.add(day);
    keep.add(f.name);
    oldestDaily = f.timeMs;
  }
  const weeks = new Set<number>();
  for (const f of regular) {
    if (weeks.size >= weekly) break;
    if (keep.has(f.name) || (oldestDaily !== null && f.timeMs >= oldestDaily)) continue;
    const week = weekOf(f.timeMs);
    if (weeks.has(week)) continue;
    weeks.add(week);
    keep.add(f.name);
  }
  return {
    keep: regular.filter((f) => keep.has(f.name)).map((f) => f.name),
    remove: regular.filter((f) => !keep.has(f.name)).map((f) => f.name),
  };
}

/** The next daily backup time strictly after `nowMs`. */
export function nextDailyBackupMs(nowMs: number): number {
  const day = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const today = day + (DAILY_BACKUP_UTC.hour * 60 + DAILY_BACKUP_UTC.minute) * 60_000;
  return today > nowMs ? today : today + DAY_MS;
}

// ---------------------------------------------------------------------------
// Integrity check in a worker thread

const INTEGRITY_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const sqlite = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const Database = sqlite.Database || sqlite.DatabaseSync;
let db = null;
try {
  const url = pathToFileURL(workerData.path);
  url.searchParams.set('mode', 'ro');
  url.searchParams.set('immutable', '1');
  db = new Database(url, { readOnly: true });
  const rows = db.prepare('PRAGMA integrity_check').all();
  parentPort.postMessage({ ok: true, messages: rows.map((row) => String(Object.values(row)[0])) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: (error && error.name) || 'Error' });
} finally {
  try { if (db) db.close(); } catch {}
}
`;

/** `PRAGMA integrity_check` of the file at `path`, in a worker thread on a read-only connection. */
export function integrityCheckInWorker(path: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const worker = new Worker(INTEGRITY_WORKER, { eval: true, workerData: { path } });
    let settled = false;
    worker.once('message', (message: { ok: boolean; messages?: string[]; error?: string }) => {
      settled = true;
      if (message.ok) resolve(message.messages ?? []);
      else reject(new Error(`integrity check could not run: ${message.error ?? 'Error'}`));
    });
    worker.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    worker.once('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`integrity check worker exited with ${code}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Backups

export interface BackupsOptions {
  db: SqliteDb;
  /** ATMUSIC_BACKUP_DIR. */
  dir: string;
  clock: Clock;
  log: Logger;
  /** ATMUSIC_MIN_FREE_BYTES. */
  minFreeBytes: number;
  statfs?: StatfsFn;
  /** The journal truncated after a completed backup (N1-08). */
  revocations?: { truncateBefore(ms: number): number };
  /** Pages per step; default BACKUP_RATE_PAGES. */
  rate?: number;
  /** Default: integrityCheckInWorker. */
  integrityCheck?: (path: string) => Promise<string[]>;
  /** Observes each backup step (remaining and total pages); never alters the run. */
  onProgress?: (progress: { totalPages: number; remainingPages: number }) => void;
}

export interface RunOptions {
  /** Default true. False: return the outcome without writing backup_runs (the pre-migration backup). */
  record?: boolean;
}

export interface BackupStatus {
  dir: string;
  lastSuccess: { kind: BackupKind; file: string; bytes: number | null; finishedAtMs: number; ageMs: number } | null;
  lastRun: {
    kind: BackupKind;
    ok: boolean;
    error: string | null;
    startedAtMs: number;
    finishedAtMs: number | null;
  } | null;
  files: { regular: number; preMigration: string[]; preRestore: string[] };
}

export interface Backups {
  run(kind: BackupKind, options?: RunOptions): Promise<BackupResult>;
  /** Writes the backup_runs row of an outcome taken with `{record: false}`. */
  record(outcome: BackupResult, startedAtMs?: number): void;
  status(): BackupStatus;
  /** Settles once no run is in progress. */
  idle(): Promise<void>;
}

function tableExists(db: SqliteDb, name: string): boolean {
  return db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name) !== null;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Creates the directory (0700) when missing. */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: BACKUP_DIR_MODE });
}

const KIND_SUFFIX: Record<BackupKind, string> = {
  daily: '.db',
  manual: '.db',
  pre_migration: '.pre-migration.db',
  pre_restore: '.pre-restore.db',
};

export function createBackups(options: BackupsOptions): Backups {
  const { db, dir, clock, log } = options;
  const statfs = options.statfs ?? nodeStatfs;
  const rate = options.rate ?? BACKUP_RATE_PAGES;
  const integrityCheck = options.integrityCheck ?? integrityCheckInWorker;
  if (!Number.isSafeInteger(rate) || rate < 1) throw new RangeError('backup rate must be a positive integer');
  let chain: Promise<unknown> = Promise.resolve();

  const recordRun = (outcome: BackupResult, startedAtMs: number, finishedAtMs: number): void => {
    try {
      if (!tableExists(db, 'backup_runs')) return;
      db.tx(() => {
        db.run(
          `INSERT INTO backup_runs(kind, started_at_ms, finished_at_ms, path, bytes, ok, error)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          outcome.kind,
          startedAtMs,
          finishedAtMs,
          outcome.status === 'ok' ? outcome.path : null,
          outcome.status === 'ok' ? outcome.bytes : null,
          outcome.status === 'ok' ? 1 : 0,
          outcome.status === 'ok' ? null : outcome.error,
        );
      });
    } catch (error) {
      log.log('error', 'backup.record_failed', { kind: outcome.kind, error: errorName(error) });
    }
  };

  const listDir = (): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };

  const finalName = (kind: BackupKind, startedAtMs: number, names: ReadonlySet<string>): string => {
    const stem = `atmusic-${backupStamp(startedAtMs)}`;
    const suffix = KIND_SUFFIX[kind];
    if (!names.has(`${stem}${suffix}`) && !names.has(`${stem}${suffix}.tmp`)) return `${stem}${suffix}`;
    for (let n = 2; ; n++) {
      const name = `${stem}-${n}${suffix}`;
      if (!names.has(name) && !names.has(`${name}.tmp`)) return name;
    }
  };

  const applyRetention = (): void => {
    const plan = retentionPlan(backupFiles(listDir()));
    for (const name of plan.remove) {
      try {
        unlinkSync(join(dir, name));
        log.log('info', 'backup.retention_removed', { file: name });
      } catch (error) {
        log.log('warn', 'backup.retention_failed', { file: name, error: errorName(error) });
      }
    }
    if (plan.remove.length > 0) fsyncPath(dir);
  };

  const truncateJournal = (): void => {
    const revocations = options.revocations;
    if (revocations === undefined) return;
    const files = backupFiles(listDir());
    if (files.length === 0) return;
    const oldest = Math.min(...files.map((f) => f.timeMs));
    try {
      const dropped = revocations.truncateBefore(oldest);
      log.log('info', 'backup.journal_truncated', { beforeMs: oldest, dropped });
    } catch (error) {
      log.log('error', 'backup.journal_truncate_failed', { error: errorName(error) });
    }
  };

  const once = async (kind: BackupKind, record: boolean): Promise<BackupResult> => {
    const startedAtMs = clock.nowMs();
    const finish = (outcome: BackupResult): BackupResult => {
      const finishedAtMs = clock.nowMs();
      if (record) recordRun(outcome, startedAtMs, finishedAtMs);
      if (outcome.status === 'ok') {
        log.log('info', 'backup.completed', { kind, file: outcome.path, bytes: outcome.bytes });
      } else {
        log.log('error', 'backup.failed', { kind, error: outcome.error });
      }
      return outcome;
    };
    const failed = (error: string): BackupResult => finish({ status: 'failed', kind, error });

    let tmp: string | null = null;
    try {
      ensureDir(dir);
      // Leftovers of a run that died: nothing else writes .tmp files here.
      for (const name of listDir()) {
        if (/^atmusic-.*\.db\.tmp(?:-journal)?$/.test(name)) removeQuietly(join(dir, name));
      }

      // 0. Free space.
      const needed = BigInt(fileSize(db.path) + fileSize(`${db.path}-wal`)) + BigInt(options.minFreeBytes);
      let free = -1n;
      try {
        free = freeBytes(dir, statfs);
      } catch {
        free = -1n;
      }
      if (free < needed) return failed('low_disk');

      // 1. Copy into a 0600 .tmp file.
      const name = finalName(kind, startedAtMs, new Set(listDir()));
      const target = join(dir, name);
      tmp = `${target}.tmp`;
      closeSync(openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, BACKUP_FILE_MODE));
      await sqlite.backup(db.raw, tmp, {
        rate,
        progress: (p: { totalPages: number; remainingPages: number }) => {
          try {
            options.onProgress?.({ totalPages: p.totalPages, remainingPages: p.remainingPages });
          } catch {
            // An observer never changes the run.
          }
        },
      });
      chmodSync(tmp, BACKUP_FILE_MODE);
      removeQuietly(`${tmp}-journal`);

      // 2. Integrity check of the copy, off the main thread.
      let messages: string[];
      try {
        messages = await integrityCheck(tmp);
      } catch (error) {
        log.log('error', 'backup.integrity_check_error', { error: errorName(error) });
        messages = [];
      }
      if (messages.length !== 1 || messages[0] !== 'ok') {
        removeQuietly(tmp);
        tmp = null;
        return failed('integrity_check_failed');
      }

      // 3. Durable rename.
      fsyncPath(tmp);
      renameSync(tmp, target);
      tmp = null;
      fsyncPath(dir);
      const bytes = statSync(target).size;
      const outcome = finish({
        status: 'ok',
        kind,
        path: target,
        bytes,
        startedAtMs,
        finishedAtMs: clock.nowMs(),
      });

      // 4–5. Retention, then the journal.
      try {
        applyRetention();
      } catch (error) {
        log.log('error', 'backup.retention_error', { error: errorName(error) });
      }
      truncateJournal();
      return outcome;
    } catch (error) {
      if (tmp !== null) {
        removeQuietly(tmp);
        removeQuietly(`${tmp}-journal`);
      }
      log.log('error', 'backup.error', { kind, error: errorName(error) });
      return failed('backup_failed');
    }
  };

  return {
    run(kind, runOptions = {}) {
      if (!(BACKUP_KINDS as readonly string[]).includes(kind)) {
        return Promise.reject(new RangeError(`unknown backup kind ${String(kind)}`));
      }
      const next = chain.then(() => once(kind, runOptions.record !== false));
      chain = next.catch(() => undefined);
      return next;
    },
    record(outcome, startedAtMs) {
      const started = startedAtMs ?? (outcome.status === 'ok' ? outcome.startedAtMs : clock.nowMs());
      const finished = outcome.status === 'ok' ? outcome.finishedAtMs : clock.nowMs();
      recordRun(outcome, started, finished);
    },
    status() {
      const now = clock.nowMs();
      let lastSuccess: BackupStatus['lastSuccess'] = null;
      let lastRun: BackupStatus['lastRun'] = null;
      if (tableExists(db, 'backup_runs')) {
        const ok = db.one<{ kind: BackupKind; path: string | null; bytes: number | null; finished_at_ms: number }>(
          `SELECT kind, path, bytes, finished_at_ms FROM backup_runs
           WHERE ok = 1 AND finished_at_ms IS NOT NULL ORDER BY finished_at_ms DESC, id DESC LIMIT 1`,
        );
        if (ok !== null) {
          lastSuccess = {
            kind: ok.kind,
            file: (ok.path ?? '').split('/').pop() ?? '',
            bytes: ok.bytes,
            finishedAtMs: ok.finished_at_ms,
            ageMs: Math.max(0, now - ok.finished_at_ms),
          };
        }
        const last = db.one<{
          kind: BackupKind;
          ok: number;
          error: string | null;
          started_at_ms: number;
          finished_at_ms: number | null;
        }>('SELECT kind, ok, error, started_at_ms, finished_at_ms FROM backup_runs ORDER BY id DESC LIMIT 1');
        if (last !== null) {
          lastRun = {
            kind: last.kind,
            ok: last.ok === 1,
            error: last.error,
            startedAtMs: last.started_at_ms,
            finishedAtMs: last.finished_at_ms,
          };
        }
      }
      const files = backupFiles(listDir());
      return {
        dir,
        lastSuccess,
        lastRun,
        files: {
          regular: files.filter((f) => f.kind === 'regular').length,
          preMigration: files
            .filter((f) => f.kind === 'pre_migration')
            .map((f) => f.name)
            .sort(),
          preRestore: files
            .filter((f) => f.kind === 'pre_restore')
            .map((f) => f.name)
            .sort(),
        },
      };
    },
    idle: () => chain.then(() => undefined),
  };
}

/**
 * The `backup` extension timer (ADR §3.3): one daily backup at 03:30 UTC,
 * rescheduled after every run whatever its outcome. The start hook schedules
 * the next 03:30 unless an earlier (overdue) one is already stored, which then
 * runs at once.
 */
export function backupExtension(backups: Pick<Backups, 'run'>): CoreExtension {
  return {
    name: 'backup',
    timers: {
      backup: async (now, ctx) => {
        try {
          await backups.run('daily');
        } finally {
          ctx.schedule('backup', nextDailyBackupMs(now), { force: true });
        }
      },
    },
    start(ctx, now) {
      ctx.schedule('backup', nextDailyBackupMs(now));
    },
  };
}
