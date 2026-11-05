// Shared synchronous database facade contract and parameter validation.
// The Node SQLite adapter implements the facade; these checks are covered by
// the storage conformance suite.

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
