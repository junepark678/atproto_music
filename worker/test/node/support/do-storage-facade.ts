// The Durable Object storage facade of the `cloudflare:*` test shim (ADR 0005
// §15.1, N2-02). TEST-ONLY: N7-01 deletes it with the shim.
//
// `openDoStorage(path)` gives the subset of `DurableObjectStorage` that the
// worker-modules suites and the code under test use, over one node:sqlite
// connection opened by the production adapter (`openSqliteDb`,
// worker/src/node/sqlite-db.ts, N1-01). Every statement therefore runs with
// the Node host's own rules, so `doDb(state.storage)` and `migrate(storage)`
// exercise the Node `Db` contract, not DO SQLite:
//
// - `sql.exec(query, ...params)` runs one module statement (`SqliteDb.exec`)
//   and returns a cursor with `toArray`, `one`, `raw`, `columnNames`,
//   `next` and iteration, and `rowsWritten` = SQLite's changes() for the
//   statement (0 when it wrote nothing). `rowsRead` throws: node:sqlite has no
//   rows-read counter (ADR §15.3 re-derives those budgets as plan pins).
//   Parameters follow the facade contract (`checkParams`), multi-statement
//   text is refused, BEGIN/SAVEPOINT/PRAGMA/ATTACH/DETACH are denied, and an
//   integer above 2^53 on read throws SqlRangeError (the named
//   sql-conformance changes, ADR §15.3).
// - Schema introspection. A SELECT whose only source is one schema pragma
//   function (`pragma_table_info`, `pragma_table_xinfo`, `pragma_index_list`,
//   `pragma_index_info`, `pragma_index_xinfo`, `pragma_foreign_key_list`) is
//   denied by the production authorizer like every PRAGMA; the facade then
//   answers it from a schema-only replica: an in-memory database holding
//   exactly the `sqlite_master` DDL of this database and no rows. Those six
//   functions depend on the schema only, so the answer is the one the file
//   database would give. Anything else (a PRAGMA statement, a data-dependent
//   pragma function such as `pragma_foreign_key_check`, a pragma function
//   joined with a table) stays denied. This keeps the schema suites of N1-10
//   (migrate.test.ts, schema-v2.test.ts) running unchanged on Node.
// - `transactionSync(fn)` is `SqliteDb.tx` (BEGIN IMMEDIATE, nested
//   SAVEPOINTs, a Promise-returning callback refused and rolled back).
// - `getAlarm`/`setAlarm`/`deleteAlarm` keep the alarm in an `AlarmCell` that
//   the shim keeps per Durable Object, so it survives eviction like a DO
//   alarm. The shim never fires it on its own: `runDurableObjectAlarm` does.
// - `deleteAll()` closes the connection, removes the database file (and its
//   WAL) and opens a fresh empty one at the same path. The alarm is kept.
// - `close()` closes the connection (eviction); every later call throws.

import { rmSync, statSync } from 'node:fs';
import * as sqlite from 'node:sqlite';
import type { SqlParam } from '../../../src/do/db';
import { openSqliteDb, type SqliteDb, SqlStatementRefusedError } from '../../../src/node/sqlite-db';
import { TEST_BUSY_TIMEOUT_MS } from './node-db';

type Row = Record<string, unknown>;
type Value = ArrayBuffer | string | number | null;

/** The Durable Object alarm, kept by the shim per object across evictions. */
export interface AlarmCell {
  at: number | null;
}

export interface FacadeCursor<T extends Row = Row> extends IterableIterator<T> {
  toArray(): T[];
  one(): T;
  raw<U extends Value[] = Value[]>(): IterableIterator<U>;
  readonly columnNames: string[];
  readonly rowsWritten: number;
  /** node:sqlite has no rows-read counter: reading it throws (ADR 0005 §15.3). */
  readonly rowsRead: number;
}

export interface FacadeSql {
  exec<T extends Row = Row>(query: string, ...bindings: unknown[]): FacadeCursor<T>;
  /** Bytes of the database file and its WAL. */
  readonly databaseSize: number;
}

export interface DoStorageFacade {
  readonly sql: FacadeSql;
  transactionSync<T>(fn: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
  /** Closes the connection (eviction). Idempotent. */
  close(): void;
  readonly closed: boolean;
  /** The database file this facade runs on. */
  readonly path: string;
  /** The production adapter's handle (for its own startup pragmas and the raw connection). */
  readonly db: SqliteDb;
}

export class RowsReadUnavailableError extends Error {
  constructor() {
    super('rowsRead is a Durable Object billing counter; node:sqlite has none (ADR 0005 §15.3: assert query plans)');
    this.name = 'RowsReadUnavailableError';
  }
}

const facades = new WeakSet<object>();
const handles = new WeakMap<object, () => SqliteDb>();

/** The SqliteDb behind a facade's storage (for the startup pragmas `pragmas()` reads back). */
export function sqliteDbOf(storage: unknown): SqliteDb {
  const get = typeof storage === 'object' && storage !== null ? handles.get(storage) : undefined;
  if (get === undefined) throw new TypeError('not a shim DurableObjectStorage');
  return get();
}

/** True for a storage object made by openDoStorage. */
export function isFacade(storage: unknown): boolean {
  return typeof storage === 'object' && storage !== null && facades.has(storage);
}

// ---------------------------------------------------------------------------
// Schema-only replica for the schema pragma functions

const SCHEMA_PRAGMAS = ['table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list'];
/**
 * `SELECT <columns> FROM pragma_<schema function>(<args>) [WHERE ...] [ORDER BY ...]`
 * with no other FROM, JOIN or subquery: the only shape answered from the replica.
 */
const INTROSPECTION = new RegExp(
  `^\\s*SELECT\\s+(?:(?!\\bFROM\\b)[^;])+?\\bFROM\\s+pragma_(?:${SCHEMA_PRAGMAS.join('|')})\\s*\\(\\s*\\?\\s*\\)` +
    '(?:\\s+WHERE\\s+(?:(?!\\b(?:FROM|JOIN|SELECT)\\b)[^;])+?)?' +
    '(?:\\s+ORDER\\s+BY\\s+(?:(?!\\b(?:FROM|JOIN|SELECT)\\b)[^;])+?)?\\s*$',
  'is',
);

/** `query` with string literals and quoted identifiers replaced by `_` (their keywords never count). */
function maskQuoted(query: string): string {
  return query.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g, '_');
}

/** True when `query` is a schema-introspection SELECT the replica answers. */
export function isSchemaIntrospection(query: string): boolean {
  return INTROSPECTION.test(maskQuoted(query));
}

type NodeDatabase = sqlite.DatabaseSync;
const DatabaseClass = (sqlite as unknown as { Database: new (path: string) => NodeDatabase }).Database;

function bindable(p: readonly SqlParam[]): sqlite.SQLInputValue[] {
  return p.map((value) => {
    if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return value;
  });
}

class SchemaReplica {
  private schema = '';
  private replica: NodeDatabase | null = null;

  query(db: SqliteDb, query: string, params: SqlParam[]): Row[] {
    const ddl = db
      .all<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
      )
      .map((r) => r.sql);
    const schema = ddl.join(';\n');
    if (this.replica === null || schema !== this.schema) {
      this.replica?.close();
      const replica = new DatabaseClass(':memory:');
      for (const statement of ddl) replica.exec(statement);
      this.replica = replica;
      this.schema = schema;
    }
    const statement = this.replica.prepare(query);
    return (statement.all(...bindable(params)) as Row[]).map((row) => ({ ...row }));
  }

  close(): void {
    this.replica?.close();
    this.replica = null;
  }
}

// ---------------------------------------------------------------------------
// Cursor

function makeCursor<T extends Row>(rows: T[], columnNames: () => string[], rowsWritten: number): FacadeCursor<T> {
  let index = 0;
  const cursor: FacadeCursor<T> = {
    toArray() {
      const rest = rows.slice(index);
      index = rows.length;
      return rest;
    },
    one() {
      const rest = rows.slice(index);
      index = rows.length;
      if (rest.length === 0) throw new Error('Expected exactly one result from SQL query, but got no results.');
      if (rest.length > 1) throw new Error('Expected exactly one result from SQL query, but got multiple results.');
      return rest[0] as T;
    },
    raw<U extends Value[] = Value[]>(): IterableIterator<U> {
      const names = columnNames();
      const source = cursor;
      const iterator: IterableIterator<U> = {
        next() {
          const step = source.next();
          if (step.done) return { done: true, value: undefined };
          return { done: false, value: names.map((name) => step.value[name] as Value) as U };
        },
        [Symbol.iterator]() {
          return iterator;
        },
      };
      return iterator;
    },
    get columnNames() {
      return columnNames();
    },
    rowsWritten,
    get rowsRead(): number {
      throw new RowsReadUnavailableError();
    },
    next() {
      if (index >= rows.length) return { done: true, value: undefined };
      const value = rows[index] as T;
      index++;
      return { done: false, value };
    },
    [Symbol.iterator]() {
      return cursor;
    },
  };
  return cursor;
}

// ---------------------------------------------------------------------------
// Facade

export interface OpenDoStorageOptions {
  /** Create the file when missing (a new Durable Object). Default false (eviction reopen). */
  create?: boolean;
  /** The object's alarm; a fresh cell when omitted. */
  alarm?: AlarmCell;
}

function fileSize(path: string): number {
  let total = 0;
  for (const p of [path, `${path}-wal`]) {
    try {
      total += statSync(p).size;
    } catch {
      // A missing WAL counts as 0.
    }
  }
  return total;
}

export function openDoStorage(path: string, options: OpenDoStorageOptions = {}): DoStorageFacade {
  const open = (create: boolean) => openSqliteDb(path, { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS, create });
  let db = open(options.create ?? false);
  let closed = false;
  const alarm = options.alarm ?? { at: null };
  const replica = new SchemaReplica();

  const live = (): SqliteDb => {
    if (closed) throw new Error('this Durable Object storage was closed (the object was evicted)');
    return db;
  };

  const changesNow = (d: SqliteDb): { total: number; last: number } => {
    const row = d.one<{ total: number; last: number }>('SELECT total_changes() AS total, changes() AS last');
    return row ?? { total: 0, last: 0 };
  };

  const sql: FacadeSql = {
    exec<T extends Row = Row>(query: string, ...bindings: unknown[]): FacadeCursor<T> {
      const d = live();
      const params = bindings as SqlParam[];
      let rows: T[];
      let rowsWritten = 0;
      try {
        const before = changesNow(d).total;
        rows = d.exec<T>(query, ...params);
        const after = changesNow(d);
        rowsWritten = after.total === before ? 0 : after.last;
      } catch (error) {
        if (error instanceof SqlStatementRefusedError && error.reason === 'pragma' && isSchemaIntrospection(query)) {
          rows = replica.query(d, query, params) as T[];
        } else {
          throw error;
        }
      }
      let names: string[] | null = null;
      const columnNames = () => {
        if (names === null) {
          const first = rows[0];
          names = first !== undefined ? Object.keys(first) : columnsOf(d, query);
        }
        return names;
      };
      return makeCursor(rows, columnNames, rowsWritten);
    },
    get databaseSize() {
      live();
      return fileSize(path);
    },
  };

  const facade: DoStorageFacade = {
    sql,
    transactionSync<T>(fn: () => T): T {
      return live().tx(fn as () => T extends Promise<unknown> ? never : T);
    },
    async getAlarm() {
      live();
      return alarm.at;
    },
    async setAlarm(scheduledTime: number | Date) {
      live();
      const at = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
      if (!Number.isFinite(at)) throw new TypeError('setAlarm needs a finite time');
      alarm.at = at;
    },
    async deleteAlarm() {
      live();
      alarm.at = null;
    },
    async deleteAll() {
      live().close();
      replica.close();
      for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(p, { force: true });
      db = open(true);
    },
    close() {
      if (closed) return;
      closed = true;
      replica.close();
      db.close();
    },
    get closed() {
      return closed;
    },
    path,
    get db() {
      return live();
    },
  };
  facades.add(facade);
  handles.set(facade, () => live());
  return facade;
}

/** Column names of a statement that returned no rows (prepared, never stepped). */
function columnsOf(db: SqliteDb, query: string): string[] {
  try {
    const statement = db.raw.prepare(query) as sqlite.StatementSync & { close?: () => void };
    try {
      return statement.columns().map((c) => c.name);
    } finally {
      statement.close?.();
    }
  } catch {
    return [];
  }
}
