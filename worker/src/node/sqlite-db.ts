// The Node host's storage adapter: the frozen `Db` facade (worker/src/do/db.ts)
// over one node:sqlite connection (ADR 0005 §3.2, N1-01).
//
// - One connection per process, opened with startup pragmas that are read back
//   and asserted: journal_mode=WAL, synchronous=FULL (a scrobble acknowledged
//   with 200 survives a power cut), foreign_keys=ON, journal_size_limit=64 MiB
//   and locking_mode=EXCLUSIVE. The locking mode is set before the first WAL
//   access, so WAL runs without shared memory and this connection holds the
//   database lock for its whole life: it is the single-writer lock (ADR §3.2,
//   §3.10). A second process or connection on the same file gets SQLITE_BUSY
//   after the busy timeout, which `openSqliteDb` reports as DatabaseLockedError.
// - The busy timeout is injected (`busyTimeoutMs`; production 5000, read back
//   through PRAGMA busy_timeout), so no test waits for the production value.
// - A missing file is refused (`create: false`, the default) by opening it in
//   SQLite's read-write-no-create mode; nothing is created on disk.
// - `tx` nests: the outermost call is BEGIN IMMEDIATE ... COMMIT, inner calls are
//   SAVEPOINT sp<n> ... RELEASE with ROLLBACK TO on a throw. A callback that
//   returns a Promise is refused (AsyncTransactionError) and rolled back.
// - The parameter contract is the DO facade's (`checkParams`): at most 100
//   parameters, safe integers and finite reals, strings, null and ArrayBuffer.
//   Integers bind as SQLite INTEGER (node:sqlite would bind every JS number as
//   REAL) and ArrayBuffers as BLOB; BLOB reads come back as ArrayBuffer.
// - `run().rowsWritten` is SQLite's changes() for the statement, and 0 when the
//   statement wrote nothing (node:sqlite reports the previous DML's count for a
//   SELECT or DDL statement, which is detected through total_changes()).
// - Module SQL is one statement: a tokenizer refuses a `;` outside literals,
//   quoted identifiers and comments that is not the end of the text (node:sqlite
//   would silently ignore the tail; trigger bodies, which hold `;`, are refused
//   too, and the schema has none, ADR 0004 §6). An authorizer denies TRANSACTION,
//   SAVEPOINT, PRAGMA (including pragma table-valued functions), ATTACH and
//   DETACH; only the adapter's own statements are exempt, while a private flag
//   is set. Refusals throw SqlStatementRefusedError before anything executes.
// - An integer above 2^53 on read throws SqlRangeError instead of a rounded
//   number (the DO lost precision silently).
// - The number of bind values must equal the statement's placeholder count, as
//   DO SQLite requires ("Wrong number of parameter bindings for SQL query.");
//   node:sqlite would bind NULL to a missing value. The count comes from the
//   same scan as the single-statement check (`?` and `?NNN` outside literals,
//   quoted identifiers and comments), is cached with the statement, and a
//   mismatch throws SqlParamCountError before anything is bound. Named
//   parameters (`:name`, `@name`, `$name`, `#name`) are refused: the facade
//   binds positionally only.
// - Prepared statements are cached in a 256-entry LRU keyed by SQL text.

import * as sqlite from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../do/contracts';
import { AsyncTransactionError, checkParams, type Db, type SqlParam } from '../do/db';

/** node:sqlite's `Database` class, read structurally (@types/node 26.6.5 declares only the `DatabaseSync` alias). */
type NodeDatabase = sqlite.DatabaseSync;
/** node:sqlite statements have `close()` (Node 26); @types/node 26.6.5 does not declare it yet. */
type NodeStatement = sqlite.StatementSync & { close(): void };
type NodeDatabaseClass = new (path: string | URL, options?: sqlite.DatabaseSyncOptions) => NodeDatabase;

const DatabaseClass: NodeDatabaseClass | undefined = (sqlite as { Database?: NodeDatabaseClass }).Database;

/** Production busy timeout (ADR 0005 §3.2); tests inject about 200 ms. */
export const PRODUCTION_BUSY_TIMEOUT_MS = 5000;
/** PRAGMA journal_size_limit (ADR 0005 §3.2). */
export const JOURNAL_SIZE_LIMIT = 67_108_864;
/** Prepared statements kept per connection (ADR 0005 §3.2). */
export const STATEMENT_CACHE_SIZE = 256;

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CANTOPEN = 14;
const SQLITE_AUTH = 23;

export type SqlRefusalReason =
  | 'multiple_statements'
  | 'named_parameter'
  | 'transaction'
  | 'savepoint'
  | 'pragma'
  | 'attach'
  | 'detach';

/** Module SQL the adapter does not execute (ADR 0005 §3.2). Nothing ran. */
export class SqlStatementRefusedError extends Error {
  constructor(
    readonly reason: SqlRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'SqlStatementRefusedError';
  }
}

/**
 * The bind values do not match the statement's placeholders (DO SQLite throws
 * "Wrong number of parameter bindings for SQL query."). Nothing was bound or run.
 */
export class SqlParamCountError extends Error {
  readonly reason = 'wrong_param_count';
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Wrong number of parameter bindings for SQL query. (the statement has ${expected}, got ${actual})`);
    this.name = 'SqlParamCountError';
  }
}

/** A read returned an integer outside the safe JS range (node:sqlite ERR_OUT_OF_RANGE). */
export class SqlRangeError extends Error {
  readonly code = 'ERR_OUT_OF_RANGE';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SqlRangeError';
  }
}

/** Another connection or process holds the database lock (ADR 0005 §3.10, exit 75). */
export class DatabaseLockedError extends Error {
  readonly code = 'SQLITE_BUSY';
  readonly errcode = SQLITE_BUSY;
  constructor(
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(`database_locked: ${path} is held by another connection`, options);
    this.name = 'DatabaseLockedError';
  }
}

/** The database file does not exist and `create` was not requested (ADR 0005 §3.2, exit 78). */
export class DatabaseMissingError extends Error {
  readonly code = 'database_missing';
  constructor(
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(`database_missing: ${path} does not exist`, options);
    this.name = 'DatabaseMissingError';
  }
}

/** A startup pragma did not read back as set. The connection is closed. */
export class SqlitePragmaError extends Error {
  constructor(
    readonly pragma: keyof SqlitePragmas,
    readonly expected: string | number,
    readonly actual: unknown,
  ) {
    super(`PRAGMA ${pragma} reads back ${String(actual)}, expected ${String(expected)}`);
    this.name = 'SqlitePragmaError';
  }
}

/** The enclosing transaction was rolled back by SQLite itself (for example on SQLITE_FULL). */
export class TransactionAbortedError extends Error {
  constructor() {
    super('the enclosing db.tx transaction was rolled back by SQLite; no further statement may run in it');
    this.name = 'TransactionAbortedError';
  }
}

export interface SqlitePragmas {
  journal_mode: string;
  synchronous: number;
  foreign_keys: number;
  journal_size_limit: number;
  locking_mode: string;
  busy_timeout: number;
}

export interface OpenSqliteDbOptions {
  log?: Logger;
  /** SQLite busy timeout; production 5000 (the default), tests about 200. */
  busyTimeoutMs?: number;
  /** Create the file when it is missing. Default false: a missing file throws DatabaseMissingError. */
  create?: boolean;
}

export interface SqliteDb extends Db {
  /** Runs one module statement and returns its rows (the migration target's `exec`). */
  exec<T = Record<string, unknown>>(sql: string, ...p: SqlParam[]): T[];
  /** Finalizes every cached statement and closes the connection. Idempotent; refused inside `tx`. */
  close(): void;
  /** Reads the startup pragmas and the busy timeout back from SQLite. */
  pragmas(): SqlitePragmas;
  /** The underlying connection (online backups). Its SQL is module SQL: the authorizer applies. */
  readonly raw: NodeDatabase;
  readonly path: string;
}

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Statement tokenizer

export interface SqlScan {
  /** At most one statement: every top-level `;` is followed only by whitespace, comments and `;`. */
  single: boolean;
  /** The placeholder count SQLite reports (sqlite3_bind_parameter_count): the highest `?`/`?NNN` index. */
  params: number;
  /** The first named parameter (`:a`, `@a`, `$a`, `#a`) outside literals and comments, if any. */
  named: string | null;
}

function isIdentChar(c: string | undefined): boolean {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code >= 0x80
  );
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

/**
 * Scans `sql` the way SQLite's tokenizer does for the parts the adapter checks:
 * string and blob literals, quoted identifiers ("x", `x`, [x]) and comments are
 * skipped; top-level `;` ends a statement; `?` takes the next index after the
 * highest so far and `?NNN` takes NNN, so the placeholder count is the highest
 * index (SQLite's rule); `$` inside an unquoted identifier is part of it.
 */
export function scanSql(sql: string): SqlScan {
  let i = 0;
  const n = sql.length;
  let ended = false; // a top-level `;` was seen
  let single = true;
  let params = 0;
  let named: string | null = null;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const eol = sql.indexOf('\n', i + 2);
      i = eol === -1 ? n : eol + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    if (c === ';') {
      ended = true;
      i++;
      continue;
    }
    // Any other token after a top-level `;` starts a second statement.
    if (ended) single = false;
    if (c === "'" || c === '"' || c === '`') {
      // A doubled quote is an escaped quote inside the literal or identifier.
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const end = sql.indexOf(']', i + 1);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '?') {
      let j = i + 1;
      while (isDigit(sql[j])) j++;
      // An out-of-range ?NNN (?0, above the variable limit) fails at prepare.
      const index = j === i + 1 ? params + 1 : Number(sql.slice(i + 1, j));
      if (index > params) params = index;
      i = j;
      continue;
    }
    if ((c === ':' || c === '@' || c === '$' || c === '#') && isIdentChar(next)) {
      let j = i + 1;
      while (isIdentChar(sql[j]) || sql[j] === '$') j++;
      named ??= sql.slice(i, j);
      i = j;
      continue;
    }
    if (isIdentChar(c)) {
      // An unquoted identifier, keyword or number; `$` may continue an identifier.
      let j = i + 1;
      while (isIdentChar(sql[j]) || sql[j] === '$') j++;
      i = j;
      continue;
    }
    i++;
  }
  return { single, params, named };
}

/** True when `sql` holds at most one statement (see `scanSql`). */
export function isSingleStatement(sql: string): boolean {
  return scanSql(sql).single;
}

// ---------------------------------------------------------------------------
// Value conversion

function bindable(p: readonly SqlParam[]): sqlite.SQLInputValue[] {
  return p.map((value) => {
    if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return value;
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function plainRow(row: Row): Row {
  const out: Row = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    out[key] = value instanceof Uint8Array ? toArrayBuffer(value) : value;
  }
  return out;
}

function errcodeOf(error: unknown): number | undefined {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' ? code : undefined;
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function wrapReadError(error: unknown): unknown {
  if ((error as { code?: unknown } | null)?.code === 'ERR_OUT_OF_RANGE') {
    return new SqlRangeError(
      `an integer read from SQLite is outside the safe JavaScript range: ${(error as Error).message}`,
      { cause: error },
    );
  }
  return error;
}

const DENIED: ReadonlyMap<number, SqlRefusalReason> = new Map([
  [sqlite.constants.SQLITE_TRANSACTION, 'transaction'],
  [sqlite.constants.SQLITE_SAVEPOINT, 'savepoint'],
  [sqlite.constants.SQLITE_PRAGMA, 'pragma'],
  [sqlite.constants.SQLITE_ATTACH, 'attach'],
  [sqlite.constants.SQLITE_DETACH, 'detach'],
]);

// ---------------------------------------------------------------------------
// Open

function openConnection(path: string, busyTimeoutMs: number, create: boolean): NodeDatabase {
  if (DatabaseClass === undefined) throw new Error('node:sqlite does not export Database (Node >= 26 required)');
  if (create) return new DatabaseClass(path, { timeout: busyTimeoutMs });
  // mode=rw: open read-write and never create, so a missing file stays missing.
  const url = pathToFileURL(path);
  url.searchParams.set('mode', 'rw');
  try {
    return new DatabaseClass(url, { timeout: busyTimeoutMs });
  } catch (error) {
    if (errcodeOf(error) === SQLITE_CANTOPEN) throw new DatabaseMissingError(path, { cause: error });
    throw error;
  }
}

function validateBusyTimeout(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 2 ** 31 - 1) {
    throw new RangeError(`busyTimeoutMs must be an integer between 0 and 2^31-1, got ${ms}`);
  }
}

export function openSqliteDb(path: string, options: OpenSqliteDbOptions = {}): SqliteDb {
  const busyTimeoutMs = options.busyTimeoutMs ?? PRODUCTION_BUSY_TIMEOUT_MS;
  validateBusyTimeout(busyTimeoutMs);
  if (path === '' || path === ':memory:' || path.startsWith('file:')) {
    throw new RangeError('openSqliteDb needs a filesystem path');
  }
  const raw = openConnection(path, busyTimeoutMs, options.create ?? false);

  let privileged = false;
  // The action the authorizer last denied; read through a call so that
  // control-flow narrowing never assumes it is still null.
  let denied: SqlRefusalReason | null = null;
  const lastDenied = (): SqlRefusalReason | null => denied;
  const asAdapter = <T>(fn: () => T): T => {
    const was = privileged;
    privileged = true;
    try {
      return fn();
    } finally {
      privileged = was;
    }
  };

  const readPragmas = (): SqlitePragmas =>
    asAdapter(() => {
      const value = (name: string): unknown => {
        const statement = raw.prepare(`PRAGMA ${name}`) as NodeStatement;
        try {
          const row = statement.get() as Row | undefined;
          return row === undefined ? undefined : Object.values(row)[0];
        } finally {
          statement.close();
        }
      };
      return {
        journal_mode: String(value('journal_mode')),
        synchronous: Number(value('synchronous')),
        foreign_keys: Number(value('foreign_keys')),
        journal_size_limit: Number(value('journal_size_limit')),
        locking_mode: String(value('locking_mode')),
        busy_timeout: Number(value('busy_timeout')),
      };
    });

  try {
    // locking_mode first: it must precede the first WAL access (ADR §3.2).
    raw.exec('PRAGMA locking_mode=EXCLUSIVE');
    raw.exec('PRAGMA journal_mode=WAL');
    raw.exec('PRAGMA synchronous=FULL');
    raw.exec('PRAGMA foreign_keys=ON');
    raw.exec(`PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT}`);
    // Take the write lock now; in exclusive mode it is held until close.
    raw.exec('BEGIN IMMEDIATE');
    raw.exec('COMMIT');
    const actual = readPragmas();
    const expected: SqlitePragmas = {
      journal_mode: 'wal',
      synchronous: 2,
      foreign_keys: 1,
      journal_size_limit: JOURNAL_SIZE_LIMIT,
      locking_mode: 'exclusive',
      busy_timeout: busyTimeoutMs,
    };
    for (const key of Object.keys(expected) as Array<keyof SqlitePragmas>) {
      if (actual[key] !== expected[key]) throw new SqlitePragmaError(key, expected[key], actual[key]);
    }
  } catch (error) {
    try {
      raw.close();
    } catch {
      // Already failing; the original error is the one to report.
    }
    const code = errcodeOf(error);
    if (code === SQLITE_BUSY || code === SQLITE_LOCKED) throw new DatabaseLockedError(path, { cause: error });
    throw error;
  }

  raw.setAuthorizer((action) => {
    if (privileged) return sqlite.constants.SQLITE_OK;
    const reason = DENIED.get(action);
    if (reason === undefined) return sqlite.constants.SQLITE_OK;
    denied = reason;
    return sqlite.constants.SQLITE_DENY;
  });

  /** A prepared module statement and its placeholder count. */
  interface Cached {
    statement: NodeStatement;
    params: number;
  }
  const cache = new Map<string, Cached>();
  const totalChanges = asAdapter(() => raw.prepare('SELECT total_changes() AS n') as NodeStatement);
  let depth = 0;
  let closed = false;

  /** The typed refusal for an authorizer denial (at prepare or, for pragma functions, at step time). */
  const refusalOf = (error: unknown): SqlStatementRefusedError | null => {
    const reason = lastDenied();
    if (errcodeOf(error) !== SQLITE_AUTH || reason === null) return null;
    return new SqlStatementRefusedError(reason, `module SQL may not use ${reason} statements`);
  };

  const prepare = (sql: string): Cached => {
    const hit = cache.get(sql);
    if (hit !== undefined) {
      cache.delete(sql);
      cache.set(sql, hit);
      return hit;
    }
    const scan = scanSql(sql);
    if (!scan.single) {
      throw new SqlStatementRefusedError('multiple_statements', 'module SQL must be a single statement');
    }
    if (scan.named !== null) {
      throw new SqlStatementRefusedError(
        'named_parameter',
        `module SQL binds positionally; named parameter ${scan.named} is not supported`,
      );
    }
    denied = null;
    let statement: NodeStatement;
    try {
      statement = raw.prepare(sql) as NodeStatement;
    } catch (error) {
      throw refusalOf(error) ?? error;
    } finally {
      denied = null;
    }
    const entry: Cached = { statement, params: scan.params };
    cache.set(sql, entry);
    if (cache.size > STATEMENT_CACHE_SIZE) {
      const [oldestSql, oldest] = cache.entries().next().value as [string, Cached];
      cache.delete(oldestSql);
      oldest.statement.close();
    }
    return entry;
  };

  /** Checks, prepares and guards one module statement; the value count must match its placeholders. */
  const statementFor = (sql: string, p: readonly unknown[]): NodeStatement => {
    if (closed) throw new Error('the database is closed');
    checkParams(p);
    if (depth > 0 && !raw.isTransaction) throw new TransactionAbortedError();
    const { statement, params } = prepare(sql);
    if (p.length !== params) throw new SqlParamCountError(params, p.length);
    return statement;
  };

  /** Runs one module statement; maps authorizer denials and out-of-range reads to typed errors. */
  const execute = <R>(
    sql: string,
    p: SqlParam[],
    step: (statement: NodeStatement, args: sqlite.SQLInputValue[]) => R,
  ): R => {
    const statement = statementFor(sql, p);
    denied = null;
    try {
      return step(statement, bindable(p));
    } catch (error) {
      const refused = refusalOf(error);
      if (refused !== null) {
        // Never keep a statement that cannot run.
        cache.delete(sql);
        statement.close();
        throw refused;
      }
      throw wrapReadError(error);
    } finally {
      denied = null;
    }
  };

  const readAll = (sql: string, p: SqlParam[]): Row[] =>
    execute(sql, p, (statement, args) => (statement.all(...args) as Row[]).map(plainRow));

  const readChanges = (): number => Number((totalChanges.get() as { n: number | bigint }).n);

  const tx = <T>(fn: () => T extends Promise<unknown> ? never : T): T => {
    if (closed) throw new Error('the database is closed');
    if (depth === 0) {
      asAdapter(() => raw.exec('BEGIN IMMEDIATE'));
      depth = 1;
      try {
        const result = fn() as unknown;
        if (isThenable(result)) {
          // Swallow the orphaned promise's rejection; the throw below rolls back.
          (result as Promise<unknown>).then(undefined, () => {});
          throw new AsyncTransactionError();
        }
        asAdapter(() => raw.exec('COMMIT'));
        return result as T;
      } catch (error) {
        if (raw.isTransaction) asAdapter(() => raw.exec('ROLLBACK'));
        throw error;
      } finally {
        depth = 0;
      }
    }
    if (!raw.isTransaction) throw new TransactionAbortedError();
    const name = `sp${depth}`;
    asAdapter(() => raw.exec(`SAVEPOINT ${name}`));
    depth++;
    try {
      const result = fn() as unknown;
      if (isThenable(result)) {
        (result as Promise<unknown>).then(undefined, () => {});
        throw new AsyncTransactionError();
      }
      asAdapter(() => raw.exec(`RELEASE ${name}`));
      return result as T;
    } catch (error) {
      if (raw.isTransaction) {
        asAdapter(() => {
          raw.exec(`ROLLBACK TO ${name}`);
          raw.exec(`RELEASE ${name}`);
        });
      }
      throw error;
    } finally {
      depth--;
    }
  };

  const db: SqliteDb = {
    path,
    raw,
    all<T>(sql: string, ...p: SqlParam[]): T[] {
      return readAll(sql, p) as T[];
    },
    one<T>(sql: string, ...p: SqlParam[]): T | null {
      return execute(sql, p, (statement, args) => {
        const row = statement.get(...args) as Row | undefined;
        return row === undefined ? null : (plainRow(row) as T);
      });
    },
    run(sql: string, ...p: SqlParam[]): { rowsWritten: number } {
      return execute(sql, p, (statement, args) => {
        const before = readChanges();
        const changes = Number(statement.run(...args).changes);
        return { rowsWritten: readChanges() === before ? 0 : changes };
      });
    },
    exec<T = Row>(sql: string, ...p: SqlParam[]): T[] {
      return readAll(sql, p) as T[];
    },
    tx,
    pragmas(): SqlitePragmas {
      if (closed) throw new Error('the database is closed');
      return readPragmas();
    },
    close(): void {
      if (closed) return;
      if (depth > 0) throw new Error('close() inside db.tx');
      closed = true;
      for (const { statement } of cache.values()) statement.close();
      cache.clear();
      totalChanges.close();
      raw.close();
      options.log?.log('info', 'sqlite.closed', { path });
    },
  };
  options.log?.log('info', 'sqlite.opened', { path, busyTimeoutMs });
  return db;
}
