// Restore a backup over the Node host's database: disaster recovery only
// (ADR 0005 §14.5, §14.3, §20.1 rows 15-16, §20.4 rows 18-19; N4-02).
//
// Usage (from the release directory, ~/.local/lib/atmusic/current):
//   npx tsx scripts/admin/restore.ts [options] <backup-file>
//
//   --accept-loss       restore although the live database cannot be read (see 3)
//   --secrets FILE      the plaintext secrets document (0600); default: decrypt
//                       ~/.config/atmusic/secrets.cred with systemd-creds, else
//                       ~/.config/atmusic/secrets.json
//   --db PATH           the live database (default ATMUSIC_DB, else
//                       $XDG_STATE_HOME/atmusic/atmusic.db)
//   --state-dir DIR     where revocations.log lives (default
//                       $XDG_STATE_HOME/atmusic, the unit's STATE_DIRECTORY)
//   --listen HOST:PORT  where to probe /health/ready after the start (default
//                       ATMUSIC_LISTEN, else 127.2.0.1:8888)
//   --no-ready-check    do not probe /health/ready
//
// ATMUSIC_DB and ATMUSIC_LISTEN are also read from ~/.config/atmusic/atmusic.env
// when the environment does not set them.
//
// Rollback is never a restore (§14.3: a link switch, because migrations are
// additive). A restore runs, in this order:
//
// 0. Pre-flight, with the units still running: the backup must pass
//    integrity_check and foreign_key_check and hold a schema this code can
//    migrate; revocations.log must parse; atmusic.db.pre-restore must not
//    exist yet (the previous restore's copy is never overwritten).
// 1. `systemctl --user stop atmusic.socket atmusic.service`, then
//    `systemctl --user is-active atmusic.socket atmusic.service` must report
//    both stopped (`inactive`, or `failed`, which is also not running).
//    Stopping the socket unit matters: an inbound connection would otherwise
//    socket-activate the service while the database is moved aside.
// 2. The live database is examined on a READ-ONLY connection, whose open read
//    transaction is the second barrier (the server's locking_mode=EXCLUSIVE
//    cannot be taken while it is held, and a holder of it refuses the reader:
//    the restore then aborts). Nothing of the live main file or WAL is written
//    before the originals are preserved: closing a read-write connection would
//    checkpoint the WAL into the main file and delete it. The live database is
//    readable when its schema and ledger read and every non-derived TABLE_CLASS
//    table passes PRAGMA integrity_check(<table>) and a full read; damage
//    confined to derived tables (the rebuildable index, which comes from the
//    backup anyway) is reported and ignored. It is then copied, still under the
//    read-only barrier, to atmusic.db.pre-restore: a consistent node:sqlite
//    backup() copy when it is readable, the original files byte for byte
//    (atmusic.db.pre-restore and, when present, -wal and -journal) when it is
//    not. Only then is it reopened read-write with locking_mode=EXCLUSIVE (the
//    server's own single-writer lock, §3.2), held until the swap; a readable
//    database must not have moved in between. A refusal removes the empty -wal
//    and the -shm a read-only open may create, so it really changes nothing.
// 3. atmusic.db.restore.tmp is a copy of the backup, migrated to this code's
//    schema version (migrations are additive). Every table of the copy and of
//    the live database must be classified in TABLE_CLASS (worker/src/do/
//    schema.ts), else the restore aborts before anything is renamed.
//    - Readable live database: every non-derived table is replaced wholesale
//      by the live table's rows; only the derived tables (the rebuildable
//      index, its cursor and timers) keep the backup's rows. Every sign-in,
//      rename, credential, revocation, operation, listen key, forward row and
//      import stays exactly as it is live. (The schema ledger, schema_migrations
//      and schema_compat, describes the file: a live database at an older
//      schema version leaves the migrated copy its own; LEDGER_TABLES.)
//    - Unreadable (or missing) live database: everything non-derived written
//      after the backup's time is lost. The restore prints what that means and
//      refuses unless --accept-loss is given; with it, every web_sessions row
//      is deleted (everyone signs in to the web UI again) and revocations.log
//      is replayed (app/revocations.ts), so a credential, link or OAuth
//      session revoked after the backup stays revoked.
//    - Key check: every OAuth session, linked-account credential and issued
//      Last.fm app secret is opened with the configured encryption keys. An
//      OAuth session that does not open makes its account `reauth_required`
//      and blocks its queued operations, as the server does when it loses a
//      session (bff/oauth-client.ts). No ciphertext is changed, and only
//      counts and key ids are printed, never ciphertext or key material.
//    - The copy must pass integrity_check and foreign_key_check; a per-table
//      summary (rows and where they came from) is printed.
// 4. The swap, in this order, so that a crash between any two steps leaves
//    either the old file without a WAL (recoverable from
//    atmusic.db.pre-restore) or the complete restored file, never a restored
//    file paired with a stale WAL:
//    1. open the copy with journal_mode=DELETE (checkpointing and removing its
//       WAL), close it, and require that no atmusic.db.restore.tmp-wal, -shm
//       or -journal exists;
//    2. fsync the copy;
//    3. close the live database, delete atmusic.db-wal, -shm and -journal, and
//       fsync the directory;
//    4. rename the copy over atmusic.db and fsync the directory again.
//    The server sets journal_mode=WAL again when it starts (§3.2).
// 5. `systemctl --user start atmusic.socket atmusic.service`, then
//    /health/ready is probed on the listen address until it answers 200.
//
// A refusal or failure after step 1 leaves both units stopped and says how to
// start them. Exit status: 0 restored (and ready, unless --no-ready-check),
// 1 refused or failed, 2 usage or configuration error (nothing was stopped).
//
// `restore(options, deps)` takes the systemctl runner, the output, the clock,
// the busy timeout, the readiness probe and an observation hook (`onStep`) as
// injected dependencies, so the tests drive it with a fake systemd; `main`
// wires the real ones. None of them relaxes a check.

import { execFile } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import * as http from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import * as sqlite from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { type Clock, cryptoRandom, systemClock } from '@atmusic/core/deps';
import {
  parseRevocationLog,
  REVOCATION_LOG_NAME,
  type RevocationEntry,
  replayRevocations,
} from '../../worker/src/app/revocations.ts';
import {
  type Box,
  createBox,
  lastfmAppAad,
  linkedAad,
  linkedPurpose,
  oauthSessionAad,
  sealedKeyId,
} from '../../worker/src/crypto/box.ts';
import { migrate } from '../../worker/src/do/migrate.ts';
import { SCHEMA_VERSION, TABLE_CLASS, type TableClass } from '../../worker/src/do/schema.ts';
import { BACKUP_FILE, PRE_MIGRATION_FILE, PRE_RESTORE_FILE, parseBackupStamp } from '../../worker/src/node/backup.ts';
import { loadSecrets, parseSecrets, type Secrets } from '../../worker/src/node/secrets.ts';
import { openSqliteDb } from '../../worker/src/node/sqlite-db.ts';

export const EXIT_RESTORED = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const UNITS = ['atmusic.socket', 'atmusic.service'] as const;
export const PRE_RESTORE_SUFFIX = '.pre-restore';
export const RESTORE_TMP_SUFFIX = '.restore.tmp';
export const DEFAULT_LISTEN = '127.2.0.1:8888';
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export const DEFAULT_READY_TIMEOUT_MS = 60_000;
export const FILE_MODE = 0o600;

/** The steps `onStep` observes, in order (the swap steps are §14.5 step 4.1-4.4). */
export const RESTORE_STEPS = [
  'stopped',
  'live_opened',
  'pre_restore_copied',
  'merged',
  'temp_closed',
  'temp_fsynced',
  'live_wal_removed',
  'renamed',
  'started',
] as const;
export type RestoreStep = (typeof RESTORE_STEPS)[number];

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `systemctl --user <args>`. */
export type Systemctl = (args: readonly string[]) => Promise<CommandResult>;

export interface ListenAddress {
  host: string;
  port: number;
}

export interface ProbeAnswer {
  status: number;
  body: string;
}

export interface RestoreOptions {
  backupPath: string;
  dbPath: string;
  /** The directory of revocations.log (the unit's STATE_DIRECTORY). */
  stateDir: string;
  acceptLoss: boolean;
  secrets: Secrets;
  /** Where /health/ready is probed after the start; null skips the probe. */
  listen: ListenAddress | null;
}

export interface RestoreDeps {
  systemctl: Systemctl;
  out: (text: string) => void;
  err: (text: string) => void;
  clock?: Clock;
  /** SQLite busy timeout of the live database's exclusive open; default 5000. */
  busyTimeoutMs?: number;
  /** Observation only (tests); main() never passes it. */
  onStep?: (step: RestoreStep) => void | Promise<void>;
  /** Default: GET /health/ready over HTTP on the loopback listen address. */
  probe?: (listen: ListenAddress) => Promise<ProbeAnswer>;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
}

/** A refusal or failure: the message is printed, nothing after it runs. */
export class RestoreAbort extends Error {
  override readonly name = 'RestoreAbort';
}

// ---------------------------------------------------------------------------
// SQLite helpers (raw node:sqlite connections: restore runs no module SQL)

type NodeDatabase = sqlite.DatabaseSync;
type NodeDatabaseClass = new (path: string | URL, options?: sqlite.DatabaseSyncOptions) => NodeDatabase;
const DatabaseClass: NodeDatabaseClass =
  (sqlite as { Database?: NodeDatabaseClass }).Database ?? (sqlite.DatabaseSync as unknown as NodeDatabaseClass);

type Row = Record<string, unknown>;

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function primaryCode(error: unknown): number | null {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' ? code & 0xff : null;
}

function errorLabel(error: unknown): string {
  const code = (error as { errstr?: unknown } | null)?.errstr;
  if (typeof code === 'string' && code !== '') return code;
  return error instanceof Error ? error.name : typeof error;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function all(db: NodeDatabase, sql: string, ...params: sqlite.SQLInputValue[]): Row[] {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all(...params) as Row[];
}

function userTables(db: NodeDatabase): string[] {
  return all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
    .map((r) => String(r.name))
    .sort();
}

function columnsOf(db: NodeDatabase, table: string): string[] {
  return all(db, 'SELECT name FROM pragma_table_info(?) ORDER BY cid', table).map((r) => String(r.name));
}

function countRows(db: NodeDatabase, table: string): number {
  const row = all(db, `SELECT count(*) AS n FROM ${quoteIdent(table)}`)[0];
  return Number(row?.n ?? 0);
}

function integrityMessages(db: NodeDatabase): string[] {
  return all(db, 'PRAGMA integrity_check').map((r) => String(Object.values(r)[0]));
}

function foreignKeyViolations(db: NodeDatabase): number {
  return all(db, 'PRAGMA foreign_key_check').length;
}

function schemaVersion(db: NodeDatabase): number | null {
  const ledger = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
  if (ledger.length === 0) return null;
  const row = all(db, 'SELECT max(version) AS v FROM schema_migrations')[0];
  return row?.v === null || row?.v === undefined ? null : Number(row.v);
}

function classOf(table: string): TableClass | undefined {
  return (TABLE_CLASS as Readonly<Record<string, TableClass | undefined>>)[table];
}

function unclassified(tables: readonly string[]): string[] {
  return tables.filter((t) => classOf(t) === undefined);
}

const NON_DERIVED: readonly string[] = Object.entries(TABLE_CLASS)
  .filter(([, c]) => c === 'non-derived')
  .map(([t]) => t);

/** Opens `path` read-only and immutable (a backup file is never written). */
function openImmutable(path: string): NodeDatabase {
  const url = pathToFileURL(path);
  url.searchParams.set('mode', 'ro');
  url.searchParams.set('immutable', '1');
  return new DatabaseClass(url, { readOnly: true });
}

// ---------------------------------------------------------------------------
// Files

function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Copies `from` to a new 0600 file `to` and fsyncs it. */
function copyPrivate(from: string, to: string): void {
  closeSync(openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE));
  copyFileSync(from, to);
  chmodSync(to, FILE_MODE);
  fsyncPath(to);
}

const SIDE_FILES = ['-wal', '-shm', '-journal'] as const;
/** The raw pre-restore copy of an unreadable live database: the main file, its WAL and its rollback journal. */
const PRE_RESTORE_FILES = ['', '-wal', '-journal'] as const;

// ---------------------------------------------------------------------------
// The live database
//
// It is examined, and copied aside, without a read-write connection: closing
// the last read-write connection of a WAL database checkpoints the WAL into the
// main file and deletes it, so a refusal would change the very files it says it
// left alone, and the raw pre-restore copy of an unreadable database would no
// longer be the original pair. A read-only connection never writes the main
// file or the WAL (it may create the -shm index, which holds no data); its open
// read transaction is the lock barrier while the live state is examined and
// copied, because the server's locking_mode=EXCLUSIVE needs a lock that a
// reader's shared lock refuses (and a server holding it refuses the reader).
// Only once the originals are preserved is the database reopened read-write
// with locking_mode=EXCLUSIVE (§14.5 step 1), and held until the swap.

type LiveState =
  | {
      kind: 'readable';
      /** The read-only examining connection, then the exclusive read-write one; null in between. */
      db: NodeDatabase | null;
      version: number;
      tables: string[];
      /** Derived tables whose integrity_check fails: ignored, they come from the backup. */
      damagedDerived: string[];
    }
  | { kind: 'unreadable'; db: NodeDatabase | null; reason: string }
  | { kind: 'missing' };

function closeQuietly(db: NodeDatabase | null): void {
  if (db === null) return;
  try {
    if (db.isOpen) db.close();
  } catch {
    // closing on the way out
  }
}

function lockedAbort(): RestoreAbort {
  return new RestoreAbort(
    'another process holds the live database (its single-writer lock could not be shared or taken); nothing was changed',
  );
}

function isLocked(error: unknown): boolean {
  const code = primaryCode(error);
  return code === SQLITE_BUSY || code === SQLITE_LOCKED;
}

/** integrity_check of one table (and its indexes) is ok and, with `readRows`, every row reads. */
function tableIntact(db: NodeDatabase, table: string, readRows: boolean): boolean {
  try {
    const messages = all(db, `PRAGMA integrity_check(${quoteIdent(table)})`).map((r) => String(Object.values(r)[0]));
    if (messages.length !== 1 || messages[0] !== 'ok') return false;
    if (readRows) {
      const select = db.prepare(`SELECT * FROM ${quoteIdent(table)}`);
      select.setReadBigInts(true);
      for (const _row of select.iterate()) {
        // every row is read
      }
    }
    return true;
  } catch (error) {
    if (isLocked(error)) throw lockedAbort();
    return false;
  }
}

/**
 * Opens the live database read-only inside a read transaction (kept open: the
 * barrier) and decides whether its non-derived state can be carried over:
 * readable when the schema and ledger read and every non-derived TABLE_CLASS
 * table passes integrity_check(<table>) and a full read. Damage confined to
 * derived tables (the rebuildable index) does not make it unreadable.
 */
function examineLive(path: string, busyTimeoutMs: number): LiveState {
  if (!existsSync(path)) return { kind: 'missing' };
  const url = pathToFileURL(path);
  url.searchParams.set('mode', 'ro');
  let db: NodeDatabase;
  try {
    db = new DatabaseClass(url, { readOnly: true, timeout: busyTimeoutMs });
  } catch (error) {
    return { kind: 'unreadable', db: null, reason: errorLabel(error) };
  }
  let tables: string[];
  let version: number | null;
  try {
    db.exec('BEGIN');
    tables = userTables(db); // the first read takes the shared lock, held until the swap
    version = schemaVersion(db);
  } catch (error) {
    if (isLocked(error)) {
      closeQuietly(db);
      throw lockedAbort();
    }
    return { kind: 'unreadable', db, reason: errorLabel(error) };
  }
  if (version === null) return { kind: 'unreadable', db, reason: 'no schema_migrations ledger' };
  const damagedNonDerived: string[] = [];
  const damagedDerived: string[] = [];
  for (const table of tables) {
    const tableClass = classOf(table);
    if (tableClass === undefined) continue; // restore() aborts on it
    if (tableIntact(db, table, tableClass === 'non-derived')) continue;
    (tableClass === 'non-derived' ? damagedNonDerived : damagedDerived).push(table);
  }
  if (damagedNonDerived.length > 0) {
    return {
      kind: 'unreadable',
      db,
      reason: `integrity_check fails for the non-derived tables ${damagedNonDerived.join(', ')}`,
    };
  }
  return { kind: 'readable', db, version, tables, damagedDerived };
}

/**
 * Reopens the live database read-write with the server's own single-writer
 * lock (locking_mode=EXCLUSIVE, §3.2), after the originals are preserved. Null
 * when the file cannot be opened as a database at all (an unreadable one).
 */
function lockLive(path: string, busyTimeoutMs: number): NodeDatabase | null {
  const url = pathToFileURL(path);
  url.searchParams.set('mode', 'rw');
  let db: NodeDatabase;
  try {
    db = new DatabaseClass(url, { timeout: busyTimeoutMs });
  } catch {
    return null;
  }
  try {
    db.exec('PRAGMA locking_mode=EXCLUSIVE');
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
    return db;
  } catch (error) {
    closeQuietly(db);
    if (isLocked(error)) throw lockedAbort();
    return null;
  }
}

/** Identity, size and modification time of the live main file and WAL (they must not move under the lock change). */
function liveStamp(path: string): string {
  return ['', '-wal']
    .map((suffix) => {
      try {
        const s = statSync(`${path}${suffix}`, { bigint: true });
        return `${s.ino}:${s.size}:${s.mtimeNs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
        throw error;
      }
    })
    .join('/');
}

// ---------------------------------------------------------------------------
// The backup

interface BackupInfo {
  timeMs: number;
  version: number;
  rows: Record<string, number>;
}

function backupTime(path: string): number {
  const name = basename(path);
  for (const pattern of [BACKUP_FILE, PRE_MIGRATION_FILE, PRE_RESTORE_FILE]) {
    const m = pattern.exec(name);
    const ms = m === null ? null : parseBackupStamp(m[1] as string);
    if (ms !== null) return ms;
  }
  return Math.floor(statSync(path).mtimeMs);
}

function verifyBackup(path: string): BackupInfo {
  let db: NodeDatabase;
  try {
    db = openImmutable(path);
  } catch (error) {
    throw new RestoreAbort(`the backup cannot be opened (${errorLabel(error)})`);
  }
  try {
    const messages = integrityMessages(db);
    if (messages.length !== 1 || messages[0] !== 'ok') throw new RestoreAbort('the backup fails integrity_check');
    if (foreignKeyViolations(db) !== 0) throw new RestoreAbort('the backup fails foreign_key_check');
    const version = schemaVersion(db);
    if (version === null || version < 1) throw new RestoreAbort('the backup holds no atmusic schema');
    if (version > SCHEMA_VERSION) {
      throw new RestoreAbort(`the backup is at schema version ${version}, newer than this code (${SCHEMA_VERSION})`);
    }
    const tables = new Set(userTables(db));
    const rows: Record<string, number> = {};
    for (const t of NON_DERIVED) if (tables.has(t)) rows[t] = countRows(db, t);
    return { timeMs: backupTime(path), version, rows };
  } catch (error) {
    if (error instanceof RestoreAbort) throw error;
    throw new RestoreAbort(`the backup cannot be read (${errorLabel(error)})`);
  } finally {
    db.close();
  }
}

function readJournal(stateDir: string): RevocationEntry[] {
  const path = join(stateDir, REVOCATION_LOG_NAME);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new RestoreAbort(`${REVOCATION_LOG_NAME} cannot be read (${(error as NodeJS.ErrnoException).code})`);
  }
  try {
    return parseRevocationLog(text).entries;
  } catch (error) {
    throw new RestoreAbort(`${REVOCATION_LOG_NAME} is corrupt (${(error as Error).message})`);
  }
}

// ---------------------------------------------------------------------------
// Merge, key check

interface TableSummary {
  table: string;
  source: 'live' | 'backup';
  rows: number;
}

/** Replaces every non-derived table of `tmp` with the live table's rows (one transaction). */
/**
 * The schema ledger (non-derived) describes the file that holds it. From a live
 * database at an older schema version it would misstate the migrated copy (the
 * next start would re-run a migration over tables that exist), so then the
 * copy keeps its own; at the same version the two are identical.
 */
export const LEDGER_TABLES: readonly string[] = ['schema_migrations', 'schema_compat'];

function mergeLive(tmp: NodeDatabase, live: NodeDatabase, liveTables: readonly string[], keepLedger: boolean): void {
  const tmpTables = new Set(userTables(tmp));
  const fromLive = new Set(liveTables);
  tmp.exec('PRAGMA foreign_keys=OFF');
  tmp.exec('BEGIN IMMEDIATE');
  try {
    for (const table of NON_DERIVED) {
      if (!tmpTables.has(table)) throw new RestoreAbort(`the migrated copy has no table ${table}`);
      if (keepLedger && LEDGER_TABLES.includes(table)) continue;
      tmp.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
      if (!fromLive.has(table)) continue; // an older live schema: the table had no rows
      const tmpColumns = new Set(columnsOf(tmp, table));
      const liveColumns = columnsOf(live, table);
      const extra = liveColumns.filter((c) => !tmpColumns.has(c));
      if (extra.length > 0) {
        throw new RestoreAbort(`the live table ${table} has columns this code does not know (${extra.join(', ')})`);
      }
      const list = liveColumns.map(quoteIdent).join(', ');
      const insert = tmp.prepare(
        `INSERT INTO ${quoteIdent(table)} (${list}) VALUES (${liveColumns.map(() => '?').join(', ')})`,
      );
      const select = live.prepare(`SELECT ${list} FROM ${quoteIdent(table)}`);
      select.setReadBigInts(true);
      for (const row of select.iterate() as Iterable<Row>) {
        insert.run(...liveColumns.map((c) => row[c] as sqlite.SQLInputValue));
      }
    }
    tmp.exec('COMMIT');
  } catch (error) {
    try {
      tmp.exec('ROLLBACK');
    } catch {
      // already failing
    }
    throw error;
  } finally {
    tmp.exec('PRAGMA foreign_keys=ON');
  }
}

interface KeyCheck {
  oauth: { total: number; failed: string[]; keyIds: Set<string> };
  linked: { total: number; failed: number; keyIds: Set<string> };
  apps: { total: number; failed: number; keyIds: Set<string> };
  marked: number;
  blocked: number;
}

function sealedId(bytes: Uint8Array, fallback: unknown): string {
  try {
    return sealedKeyId(bytes);
  } catch {
    return String(fallback ?? 'unknown');
  }
}

function bytesOf(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(0);
}

/** Opens every sealed value; marks the accounts whose OAuth session does not open (module comment). */
function checkKeys(db: NodeDatabase, box: Box, now: number): KeyCheck {
  const out: KeyCheck = {
    oauth: { total: 0, failed: [], keyIds: new Set() },
    linked: { total: 0, failed: 0, keyIds: new Set() },
    apps: { total: 0, failed: 0, keyIds: new Set() },
    marked: 0,
    blocked: 0,
  };
  for (const row of all(db, 'SELECT did, ciphertext, key_id FROM oauth_sessions ORDER BY did')) {
    out.oauth.total++;
    const did = String(row.did);
    const sealed = bytesOf(row.ciphertext);
    let ok = false;
    try {
      const session = JSON.parse(box.openText('oauth-session', sealed, oauthSessionAad(did))) as {
        tokenSet?: { sub?: unknown };
      };
      ok = session?.tokenSet?.sub === did;
    } catch {
      ok = false;
    }
    if (!ok) {
      out.oauth.failed.push(did);
      out.oauth.keyIds.add(sealedId(sealed, row.key_id));
    }
  }
  for (const row of all(db, 'SELECT did, service, credential_ciphertext, key_id FROM linked_accounts ORDER BY id')) {
    out.linked.total++;
    const service = row.service === 'lastfm' ? 'lastfm' : 'listenbrainz';
    const sealed = bytesOf(row.credential_ciphertext);
    try {
      box.openText(linkedPurpose(service), sealed, linkedAad(String(row.did), service));
    } catch {
      out.linked.failed++;
      out.linked.keyIds.add(sealedId(sealed, row.key_id));
    }
  }
  for (const row of all(db, 'SELECT api_key, did, secret_ciphertext, key_id FROM lastfm_apps ORDER BY api_key')) {
    out.apps.total++;
    const sealed = bytesOf(row.secret_ciphertext);
    try {
      box.openText('lastfm-app', sealed, lastfmAppAad(String(row.api_key), String(row.did)));
    } catch {
      out.apps.failed++;
      out.apps.keyIds.add(sealedId(sealed, row.key_id));
    }
  }
  if (out.oauth.failed.length > 0) {
    // As the server does when a session is lost (bff/oauth-client.ts markSessionLost).
    const markAccount = db.prepare(
      "UPDATE accounts SET oauth_status = 'reauth_required', updated_at_ms = ? WHERE did = ? AND oauth_status = 'active'",
    );
    const blockOps = db.prepare(
      "UPDATE operations SET state = 'blocked', updated_at_ms = ? WHERE did = ? AND state = 'queued'",
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const did of out.oauth.failed) {
        out.marked += Number(markAccount.run(now, did).changes);
        out.blocked += Number(blockOps.run(now, did).changes);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// systemd and readiness

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

const STOPPED_STATES = new Set(['inactive', 'failed']);

function authority(listen: ListenAddress): string {
  return listen.host.includes(':') ? `[${listen.host}]:${listen.port}` : `${listen.host}:${listen.port}`;
}

/** GET /health/ready on the loopback listen address (the bridge accepts the listen address as Host). */
export function httpProbe(listen: ListenAddress): Promise<ProbeAnswer> {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      {
        host: listen.host,
        port: listen.port,
        path: '/health/ready',
        method: 'GET',
        headers: { host: authority(listen), accept: 'application/json' },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// restore()

export async function restore(options: RestoreOptions, deps: RestoreDeps): Promise<number> {
  const say = (text: string) => deps.out(`atmusic restore: ${text}\n`);
  const fail = (text: string) => deps.err(`atmusic restore: ${text}\n`);
  const clock = deps.clock ?? systemClock;
  const busyTimeoutMs = deps.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const step = async (name: RestoreStep) => {
    await deps.onStep?.(name);
  };

  const dbPath = resolve(options.dbPath);
  const dir = dirname(dbPath);
  const preRestore = `${dbPath}${PRE_RESTORE_SUFFIX}`;
  const tmp = `${dbPath}${RESTORE_TMP_SUFFIX}`;
  let stopped = false;
  let renamed = false;
  let live: LiveState | null = null;
  let tmpDb: NodeDatabase | null = null;
  /** A read-write connection to the live database was opened (from then on it may be checkpointed). */
  let liveWritable = false;
  /** The live -wal and -shm that did not exist before the read-only examination (it may create both, empty). */
  let createdSideFiles: string[] = [];

  const closeAll = () => {
    closeQuietly(tmpDb);
    tmpDb = null;
    if (live !== null && live.kind !== 'missing') closeQuietly(live.db);
    // The read-only connection may have created an empty -wal and the -shm index;
    // while no read-write connection was opened nothing else of the live files
    // changed, so those go too (a -wal only while it is still empty).
    if (!liveWritable) {
      for (const path of createdSideFiles) {
        try {
          if (path.endsWith('-wal') && existsSync(path) && statSync(path).size !== 0) continue;
          removeIfPresent(path);
        } catch {
          // best effort
        }
      }
    }
  };

  try {
    // 0. Pre-flight (the units are still running).
    if (!existsSync(options.backupPath) || !statSync(options.backupPath).isFile()) {
      throw new RestoreAbort(`the backup ${options.backupPath} is not a file`);
    }
    const backupReal = realpathSync(options.backupPath);
    for (const own of [dbPath, preRestore, tmp, ...SIDE_FILES.map((s) => `${dbPath}${s}`)]) {
      if (existsSync(own) && realpathSync(own) === backupReal) {
        throw new RestoreAbort('the backup must not be the live database or one of its own files');
      }
    }
    const backup = verifyBackup(options.backupPath);
    const journal = readJournal(options.stateDir);
    if (PRE_RESTORE_FILES.some((s) => existsSync(`${preRestore}${s}`))) {
      throw new RestoreAbort(
        `${preRestore} already exists (the copy a previous restore kept); move it away or delete it first`,
      );
    }
    const box = createBox(options.secrets.encryptionKeys, cryptoRandom);
    say(
      `backup ${options.backupPath}: schema version ${backup.version}, taken ${new Date(backup.timeMs).toISOString()}`,
    );

    // 1. Stop both units and require both stopped.
    const stop = await deps.systemctl(['stop', ...UNITS]);
    if (stop.code !== 0) {
      throw new RestoreAbort(
        `systemctl --user stop ${UNITS.join(' ')} failed (exit ${stop.code}); nothing was changed`,
      );
    }
    stopped = true;
    const active = await deps.systemctl(['is-active', ...UNITS]);
    const states = lines(active.stdout);
    if (states.length !== UNITS.length || !states.every((s) => STOPPED_STATES.has(s))) {
      const report = UNITS.map((u, i) => `${u}=${states[i] ?? 'unknown'}`).join(', ');
      throw new RestoreAbort(`the units are not both stopped (${report}); nothing was changed`);
    }
    say(`stopped ${UNITS.join(' and ')}`);
    await step('stopped');

    // 2. Examine the live database on a read-only connection whose read
    //    transaction is the lock barrier; nothing of the live files is written.
    createdSideFiles = ['-wal', '-shm'].map((s) => `${dbPath}${s}`).filter((path) => !existsSync(path));
    live = examineLive(dbPath, busyTimeoutMs);
    if (live.kind === 'readable') {
      if (live.version > SCHEMA_VERSION) {
        throw new RestoreAbort(
          `the live database is at schema version ${live.version}, newer than this code (${SCHEMA_VERSION}); restore with the newer release`,
        );
      }
      const stray = unclassified(live.tables);
      if (stray.length > 0) {
        throw new RestoreAbort(
          `the live database has tables missing from TABLE_CLASS (${stray.join(', ')}); nothing was renamed`,
        );
      }
      say(`the live database is readable (schema version ${live.version}); its non-derived tables are kept`);
      if (live.damagedDerived.length > 0) {
        say(
          `the live database's derived tables ${live.damagedDerived.join(', ')} fail integrity_check; derived tables come from the backup, so this loses nothing`,
        );
      }
    } else {
      const reason = live.kind === 'missing' ? 'it does not exist' : `it cannot be read: ${live.reason}`;
      const since = new Date(backup.timeMs).toISOString();
      const after = journal.filter((e) => e.at >= backup.timeMs).length;
      const report = [
        `the live database ${dbPath} is unusable (${reason}).`,
        `Restoring without it loses every non-derived change made after the backup (${since}):`,
        '  - sign-ins, new accounts and account renames;',
        '  - every web session: all web_sessions rows are deleted and everyone signs in to the web UI again;',
        '  - OAuth sessions refreshed since then (an older refresh token may fail with invalid_grant: reauth_required);',
        '  - app passwords, Last.fm sessions, ListenBrainz tokens, issued apps and links created since then;',
        '  - scrobbles and other writes accepted but not yet written to a PDS (queued operations, listen keys);',
        '  - forward queue rows and import progress.',
        `Revocations made since then are replayed from ${REVOCATION_LOG_NAME} (${journal.length} entries, ${after} after the backup), so nothing revoked comes back.`,
        `Rows of the backup's non-derived tables: ${
          Object.entries(backup.rows)
            .map(([t, n]) => `${t}=${n}`)
            .join(', ') || 'none'
        }.`,
      ];
      if (!options.acceptLoss) {
        fail(report.join('\n'));
        throw new RestoreAbort('refusing without --accept-loss; nothing was changed');
      }
      say(`${report.join('\n')}\n--accept-loss given: continuing`);
    }
    await step('live_opened');

    // 3a. The pre-restore copy, still under the read-only barrier and before any
    //     read-write connection to the live database exists.
    const copies: string[] = [];
    let stamp = '';
    if (live.kind === 'readable') {
      const copy = `${preRestore}.tmp`;
      removeIfPresent(copy);
      closeSync(openSync(copy, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE));
      await sqlite.backup(live.db as NodeDatabase, copy);
      chmodSync(copy, FILE_MODE);
      removeIfPresent(`${copy}-journal`);
      fsyncPath(copy);
      renameSync(copy, preRestore);
      copies.push(preRestore);
      fsyncPath(dir);
      stamp = liveStamp(dbPath);
      say(`copied the live database to ${preRestore}`);
    } else if (live.kind === 'unreadable') {
      // The original files, byte for byte (the -shm holds no data; an empty -wal
      // the read-only open created is not one of them).
      for (const suffix of PRE_RESTORE_FILES) {
        const path = `${dbPath}${suffix}`;
        if (suffix !== '' && !existsSync(path)) continue;
        if (createdSideFiles.includes(path) && statSync(path).size === 0) continue;
        copyPrivate(path, `${preRestore}${suffix}`);
        copies.push(`${preRestore}${suffix}`);
      }
      fsyncPath(dir);
      say(`copied the unreadable live files to ${copies.join(', ')}`);
    }

    // 3a'. Take the server's own exclusive lock, held until the swap (§14.5 step 1).
    if (live.kind !== 'missing') {
      closeQuietly(live.db);
      live.db = null;
      liveWritable = true;
      try {
        live.db = lockLive(dbPath, busyTimeoutMs);
        if (live.kind === 'readable') {
          if (live.db === null) throw new RestoreAbort('the live database could not be reopened read-write');
          if (liveStamp(dbPath) !== stamp) {
            throw new RestoreAbort('the live database changed while it was being copied (another process writes it)');
          }
        }
      } catch (error) {
        // This run's copies would block the next attempt (pre-flight refuses an existing pre-restore copy).
        closeQuietly(live.db);
        live.db = null;
        for (const path of copies) removeIfPresent(path);
        throw error;
      }
    }
    await step('pre_restore_copied');

    // 3b. Build the restored copy.
    for (const path of [tmp, ...SIDE_FILES.map((s) => `${tmp}${s}`)]) removeIfPresent(path);
    copyPrivate(options.backupPath, tmp);
    {
      const facade = openSqliteDb(tmp, { busyTimeoutMs });
      try {
        const migrated = migrate(facade);
        if (migrated.status !== 'ready' || migrated.version !== SCHEMA_VERSION) {
          throw new RestoreAbort(`the backup copy cannot be migrated to schema version ${SCHEMA_VERSION}`);
        }
        if (backup.version < SCHEMA_VERSION)
          say(`migrated the copy from version ${backup.version} to ${SCHEMA_VERSION}`);
        if (live.kind !== 'readable') {
          const sessions = facade.run('DELETE FROM web_sessions').rowsWritten;
          const replay = replayRevocations(facade, journal);
          const deleted = Object.entries(replay.deleted)
            .filter(([, n]) => n > 0)
            .map(([t, n]) => `${t}=${n}`)
            .join(', ');
          say(
            `deleted ${sessions} web sessions; replayed ${replay.entries} revocations (deleted: ${deleted || 'none'})`,
          );
        }
      } finally {
        facade.close();
      }
    }
    tmpDb = new DatabaseClass(tmp, { timeout: busyTimeoutMs });
    const tmpTables = userTables(tmpDb);
    const stray = unclassified(tmpTables);
    if (stray.length > 0) {
      throw new RestoreAbort(
        `the backup has tables missing from TABLE_CLASS (${stray.join(', ')}); nothing was renamed`,
      );
    }
    const keepLedger = live.kind === 'readable' && live.version < SCHEMA_VERSION;
    if (live.kind === 'readable') {
      mergeLive(tmpDb, live.db as NodeDatabase, live.tables, keepLedger);
      if (keepLedger) {
        say(
          `the live database is at schema version ${live.version}: the copy keeps its own ${LEDGER_TABLES.join(' and ')} (version ${SCHEMA_VERSION})`,
        );
      }
    }

    const keys = checkKeys(tmpDb, box, clock.nowMs());
    const configured = options.secrets.encryptionKeys.map((k) => k.id).join(', ');
    say(
      `keys: ${keys.oauth.total - keys.oauth.failed.length}/${keys.oauth.total} OAuth sessions, ` +
        `${keys.linked.total - keys.linked.failed}/${keys.linked.total} linked-account credentials and ` +
        `${keys.apps.total - keys.apps.failed}/${keys.apps.total} issued Last.fm app secrets open with the configured encryption keys (${configured})`,
    );
    if (keys.oauth.failed.length > 0) {
      fail(
        `${keys.oauth.failed.length} OAuth sessions do not open with the configured keys (sealed with key id ${[
          ...keys.oauth.keyIds,
        ].join(
          ', ',
        )}): ${keys.marked} accounts are now reauth_required and ${keys.blocked} queued operations blocked until their users sign in again; the stored ciphertext is unchanged`,
      );
    }
    if (keys.linked.failed > 0) {
      fail(
        `${keys.linked.failed} linked-account credentials do not open (key id ${[...keys.linked.keyIds].join(', ')}): the forwarder holds their rows and the users relink`,
      );
    }
    if (keys.apps.failed > 0) {
      fail(
        `${keys.apps.failed} issued Last.fm app secrets do not open (key id ${[...keys.apps.keyIds].join(', ')}): those apps must be issued again`,
      );
    }

    const integrity = integrityMessages(tmpDb);
    if (integrity.length !== 1 || integrity[0] !== 'ok')
      throw new RestoreAbort('the restored copy fails integrity_check');
    if (foreignKeyViolations(tmpDb) !== 0) throw new RestoreAbort('the restored copy fails foreign_key_check');
    const summary: TableSummary[] = userTables(tmpDb).map((table) => ({
      table,
      source:
        live?.kind === 'readable' && classOf(table) === 'non-derived' && !(keepLedger && LEDGER_TABLES.includes(table))
          ? 'live'
          : 'backup',
      rows: countRows(tmpDb as NodeDatabase, table),
    }));
    say(
      `tables:\n${summary.map((s) => `  ${s.table.padEnd(20)} ${String(s.rows).padStart(9)}  ${s.source}`).join('\n')}`,
    );
    tmpDb.close();
    tmpDb = null;
    await step('merged');

    // 4.1 journal_mode=DELETE: no WAL of the copy can be left behind.
    {
      const final = new DatabaseClass(tmp, { timeout: busyTimeoutMs });
      try {
        const mode = all(final, 'PRAGMA journal_mode=DELETE')[0];
        if (String(Object.values(mode ?? {})[0]) !== 'delete') {
          throw new RestoreAbort('the restored copy could not be switched to journal_mode=DELETE');
        }
      } finally {
        final.close();
      }
      const left = SIDE_FILES.map((s) => `${tmp}${s}`).filter((p) => existsSync(p));
      if (left.length > 0) throw new RestoreAbort(`the restored copy left ${left.map((p) => basename(p)).join(', ')}`);
    }
    await step('temp_closed');

    // 4.2 fsync the copy.
    fsyncPath(tmp);
    await step('temp_fsynced');

    // 4.3 Close the live database; no stale WAL may survive next to the restored file.
    if (live.kind !== 'missing') closeQuietly(live.db);
    for (const s of SIDE_FILES) removeIfPresent(`${dbPath}${s}`);
    fsyncPath(dir);
    await step('live_wal_removed');

    // 4.4 Rename over the live file.
    renameSync(tmp, dbPath);
    renamed = true;
    fsyncPath(dir);
    say(`restored ${dbPath}`);
    await step('renamed');

    // 5. Start both units, then wait for readiness.
    const start = await deps.systemctl(['start', ...UNITS]);
    if (start.code !== 0) {
      fail(`systemctl --user start ${UNITS.join(' ')} failed (exit ${start.code}); see journalctl --user -u atmusic`);
      return EXIT_FAILED;
    }
    say(`started ${UNITS.join(' and ')}`);
    await step('started');
    if (options.listen === null) return EXIT_RESTORED;
    const probe = deps.probe ?? httpProbe;
    const deadline = Date.now() + (deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    let last = 'no answer';
    for (;;) {
      try {
        const answer = await probe(options.listen);
        let status = '';
        try {
          status = String((JSON.parse(answer.body) as { status?: unknown }).status ?? '');
        } catch {
          status = '';
        }
        if (answer.status === 200 && status === 'ready') {
          say(`ready (GET /health/ready on ${authority(options.listen)} answered 200 ready)`);
          return EXIT_RESTORED;
        }
        last = `${answer.status} ${status}`.trim();
      } catch (error) {
        last = (error as NodeJS.ErrnoException).code ?? errorLabel(error);
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, deps.readyIntervalMs ?? 250));
    }
    fail(`not ready: /health/ready on ${authority(options.listen)} answered ${last}; see journalctl --user -u atmusic`);
    return EXIT_FAILED;
  } catch (error) {
    closeAll();
    if (!renamed) {
      for (const path of [tmp, ...SIDE_FILES.map((s) => `${tmp}${s}`), `${preRestore}.tmp`]) {
        try {
          removeIfPresent(path);
        } catch {
          // best effort
        }
      }
    }
    if (error instanceof RestoreAbort) fail(error.message);
    else fail(`failed (${errorLabel(error)})`);
    if (stopped) fail(`both units are left stopped; start them with: systemctl --user start ${UNITS.join(' ')}`);
    return EXIT_FAILED;
  } finally {
    closeAll();
  }
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `usage: npx tsx scripts/admin/restore.ts [--accept-loss] [--secrets FILE] [--db PATH]
         [--state-dir DIR] [--listen HOST:PORT] [--no-ready-check] <backup-file>
`;

export interface MainDeps {
  env?: Readonly<Record<string, string | undefined>>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  systemctl?: Systemctl;
  /** Decrypts the systemd credential to its plaintext JSON (default: systemd-creds --user decrypt). */
  decryptCredential?: (path: string) => Promise<string>;
  clock?: Clock;
  busyTimeoutMs?: number;
  onStep?: (step: RestoreStep) => void | Promise<void>;
  probe?: (listen: ListenAddress) => Promise<ProbeAnswer>;
  readyTimeoutMs?: number;
}

function run(file: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    execFile(file, [...args], { encoding: 'utf8', maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolvePromise({ code, stdout, stderr });
    });
  });
}

export const realSystemctl: Systemctl = (args) => run('systemctl', ['--user', ...args]);

async function realDecrypt(path: string): Promise<string> {
  const result = await run('systemd-creds', ['--user', 'decrypt', '--name=secrets', path, '-']);
  if (result.code !== 0) throw new Error(`systemd-creds decrypt failed (exit ${result.code})`);
  return result.stdout;
}

/** `KEY=VALUE` lines of an EnvironmentFile (comments and blank lines skipped, one level of quotes removed). */
export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m === null) continue;
    let value = (m[2] as string).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0] as string)) {
      value = value.slice(1, -1);
    }
    out[m[1] as string] = value;
  }
  return out;
}

/** `host:port` on 127.0.0.0/8 or [::1]; null otherwise. */
export function parseListen(text: string): ListenAddress | null {
  const v6 = /^\[(::1)\]:(\d{1,5})$/.exec(text);
  const v4 = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/.exec(text);
  const m = v6 ?? v4;
  if (m === null) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (v4 !== null && (m[1] as string).split('.').some((o) => Number(o) > 255)) return null;
  return { host: m[1] as string, port };
}

interface Args {
  backup: string;
  acceptLoss: boolean;
  secrets: string | null;
  db: string | null;
  stateDir: string | null;
  listen: string | null;
  readyCheck: boolean;
}

function parseArgs(argv: readonly string[]): Args | { usage: string } {
  const args: Args = {
    backup: '',
    acceptLoss: false,
    secrets: null,
    db: null,
    stateDir: null,
    listen: null,
    readyCheck: true,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = (): string | null => {
      const v = argv[i + 1];
      i++;
      return v === undefined || v === '' ? null : v;
    };
    switch (arg) {
      case '--accept-loss':
        args.acceptLoss = true;
        break;
      case '--no-ready-check':
        args.readyCheck = false;
        break;
      case '--secrets':
      case '--db':
      case '--state-dir':
      case '--listen': {
        const v = value();
        if (v === null) return { usage: `${arg} needs a value` };
        if (arg === '--secrets') args.secrets = v;
        else if (arg === '--db') args.db = v;
        else if (arg === '--state-dir') args.stateDir = v;
        else args.listen = v;
        break;
      }
      case '--help':
      case '-h':
        return { usage: '' };
      default:
        if (arg.startsWith('-')) return { usage: `unknown option ${arg}` };
        positional.push(arg);
    }
  }
  if (positional.length !== 1) return { usage: 'exactly one backup file is required' };
  args.backup = positional[0] as string;
  return args;
}

export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((text: string) => void process.stdout.write(text));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const parsed = parseArgs(argv);
  if ('usage' in parsed) {
    if (parsed.usage === '') {
      out(USAGE);
      return EXIT_RESTORED;
    }
    err(`atmusic restore: ${parsed.usage}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const home = env.HOME ?? '';
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  const stateHome = env.XDG_STATE_HOME || join(home, '.local', 'state');
  const configDir = join(configHome, 'atmusic');
  const envFile = readEnvFile(join(configDir, 'atmusic.env'));
  const setting = (name: string): string | undefined => env[name] || envFile[name] || undefined;

  const stateDir = resolve(parsed.stateDir ?? join(stateHome, 'atmusic'));
  const dbPath = resolve(parsed.db ?? setting('ATMUSIC_DB') ?? join(stateDir, 'atmusic.db'));
  let listen: ListenAddress | null = null;
  if (parsed.readyCheck) {
    const text = parsed.listen ?? setting('ATMUSIC_LISTEN') ?? DEFAULT_LISTEN;
    listen = parseListen(text);
    if (listen === null) {
      err(`atmusic restore: --listen/ATMUSIC_LISTEN must be <loopback address>:<port>, got ${JSON.stringify(text)}\n`);
      return EXIT_USAGE;
    }
  }

  // Secrets: --secrets, else the encrypted credential, else the plaintext fallback.
  let secrets: Secrets;
  try {
    if (parsed.secrets !== null) {
      secrets = loadSecrets({ ATMUSIC_SECRETS_FILE: resolve(parsed.secrets) });
    } else if (existsSync(join(configDir, 'secrets.cred'))) {
      const text = await (deps.decryptCredential ?? realDecrypt)(join(configDir, 'secrets.cred'));
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new Error('the decrypted credential is not JSON');
      }
      secrets = parseSecrets(doc);
    } else if (existsSync(join(configDir, 'secrets.json'))) {
      secrets = loadSecrets({ ATMUSIC_SECRETS_FILE: join(configDir, 'secrets.json') });
    } else {
      err(`atmusic restore: no secrets: pass --secrets FILE or create ${join(configDir, 'secrets.cred')}\n`);
      return EXIT_USAGE;
    }
  } catch (error) {
    const issues = (error as { issues?: { field: string; message: string }[] }).issues;
    const detail = Array.isArray(issues)
      ? issues.map((i) => `${i.field}: ${i.message}`).join('; ')
      : (error as Error).message;
    err(`atmusic restore: the secrets cannot be loaded (${detail})\n`);
    return EXIT_USAGE;
  }

  return restore(
    {
      backupPath: resolve(parsed.backup),
      dbPath,
      stateDir,
      acceptLoss: parsed.acceptLoss,
      secrets,
      listen,
    },
    {
      systemctl: deps.systemctl ?? realSystemctl,
      out,
      err,
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: deps.busyTimeoutMs }),
      ...(deps.onStep === undefined ? {} : { onStep: deps.onStep }),
      ...(deps.probe === undefined ? {} : { probe: deps.probe }),
      ...(deps.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: deps.readyTimeoutMs }),
    },
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
