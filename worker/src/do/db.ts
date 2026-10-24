// Thin synchronous facade over DO SQLite (ADR 0004 §4.4, F3). Frozen in Wave 0.
//
// - Parameters are checked before execution: at most 100 per statement (the D1
//   and DO limit) and every number a safe integer or a finite real. A violation
//   throws SqlParamError and the statement never reaches SQLite.
// - `tx` wraps `storage.transactionSync`: a throw rolls back every write in the
//   callback. Its type rejects a Promise-returning callback, and at runtime a
//   thenable result is refused (and rolled back) as well, because no
//   read-check-write may span an await. worker/test/storage/no-async-tx.test.ts
//   additionally lints every source file for async tx callbacks.
// - `run(...).rowsWritten` is the DO cursor's billed rows-written count. It
//   includes index b-tree entries (an insert into a table with a TEXT primary
//   key reports 2), so it is 0 exactly when nothing was written but it is not
//   SQLite's changes() count. Use RETURNING when a module needs affected rows.
// Raw DO SQL would bind `true` as the text 'true', round unsafe integers
// silently, and accept a Uint8Array view as a BLOB; the checks below refuse all
// three (pass `bytes.slice().buffer` for a BLOB), as the conformance suite
// documents (worker/test/storage/sql-conformance.test.ts).

export type SqlParam = string | number | null | ArrayBuffer;

export const MAX_SQL_PARAMS = 100;

export type SqlParamErrorReason = 'too_many_params' | 'unsafe_integer' | 'non_finite_number' | 'unsupported_type';

export class SqlParamError extends Error {
  constructor(
    readonly reason: SqlParamErrorReason,
    readonly index: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'SqlParamError';
  }
}

export class AsyncTransactionError extends Error {
  constructor() {
    super('db.tx callback returned a Promise; transactions must be synchronous');
    this.name = 'AsyncTransactionError';
  }
}

export interface Db {
  all<T>(sql: string, ...p: SqlParam[]): T[];
  one<T>(sql: string, ...p: SqlParam[]): T | null;
  run(sql: string, ...p: SqlParam[]): { rowsWritten: number };
  tx<T>(fn: () => T extends Promise<unknown> ? never : T): T;
}

export function checkParams(params: readonly unknown[]): asserts params is SqlParam[] {
  if (params.length > MAX_SQL_PARAMS) {
    throw new SqlParamError(
      'too_many_params',
      null,
      `${params.length} bound parameters exceed the limit of ${MAX_SQL_PARAMS}`,
    );
  }
  params.forEach((value, index) => {
    if (value === null || typeof value === 'string' || value instanceof ArrayBuffer) return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new SqlParamError('non_finite_number', index, `parameter ${index + 1} is not a finite number`);
      }
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new SqlParamError('unsafe_integer', index, `parameter ${index + 1} (${value}) is not a safe integer`);
      }
      return;
    }
    throw new SqlParamError('unsupported_type', index, `parameter ${index + 1} has unsupported type ${typeof value}`);
  });
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function doDb(storage: DurableObjectStorage): Db {
  const sql = storage.sql;
  return {
    all<T>(query: string, ...p: SqlParam[]): T[] {
      checkParams(p);
      return sql.exec(query, ...p).toArray() as T[];
    },
    one<T>(query: string, ...p: SqlParam[]): T | null {
      checkParams(p);
      const rows = sql.exec(query, ...p).toArray();
      return (rows[0] as T | undefined) ?? null;
    },
    run(query: string, ...p: SqlParam[]): { rowsWritten: number } {
      checkParams(p);
      const cursor = sql.exec(query, ...p);
      // Drain so every statement (and RETURNING rows) has fully executed.
      cursor.toArray();
      return { rowsWritten: cursor.rowsWritten };
    },
    tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
      return storage.transactionSync(() => {
        const result = fn() as unknown;
        if (isThenable(result)) {
          // Swallow the orphaned promise's rejection; the throw below rolls back.
          (result as Promise<unknown>).then(undefined, () => {});
          throw new AsyncTransactionError();
        }
        return result as T;
      });
    },
  };
}
