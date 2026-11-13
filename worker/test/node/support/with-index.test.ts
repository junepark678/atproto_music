import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SqlStatementRefusedError } from '../../../src/node/sqlite-db';
import { closeFileIndexes, fileIndexes, schemaAll, withIndex } from './with-index';

afterAll(() => closeFileIndexes());

describe('schemaAll replica lifecycle', () => {
  it('reuses DDL while it is unchanged and follows index, table, replacement and rollback changes', async () => {
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
    try {
      await withIndex((db) => {
        db.exec('CREATE TABLE schema_cache_probe (id INTEGER PRIMARY KEY, payload BLOB)');
        const info = () =>
          schemaAll<{ name: string; cid: number; pk: number }>(
            db,
            'SELECT name, cid, pk FROM pragma_table_info(?) WHERE name = ? ORDER BY cid',
            'schema_cache_probe',
            'id',
          );

        expect(info()).toEqual([{ name: 'id', cid: 0, pk: 1 }]);
        const firstReplayCount = exec.mock.calls.length;
        expect(firstReplayCount).toBeGreaterThan(0);
        expect(info()).toEqual([{ name: 'id', cid: 0, pk: 1 }]);
        expect(exec).toHaveBeenCalledTimes(firstReplayCount);

        const blob = new Uint8Array([1, 2]).buffer;
        expect(
          schemaAll<{ bytes: Uint8Array; integer_value: number }>(
            db,
            "SELECT X'0102' AS bytes, 9007199254740991 AS integer_value FROM pragma_table_info(?) WHERE name = ? AND ? = X'0102'",
            'schema_cache_probe',
            'id',
            blob,
          ),
        ).toEqual([{ bytes: new Uint8Array([1, 2]), integer_value: Number.MAX_SAFE_INTEGER }]);

        const beforeIndex = exec.mock.calls.length;
        db.exec('CREATE INDEX schema_cache_probe_payload ON schema_cache_probe(payload)');
        expect(
          schemaAll<{ name: string }>(
            db,
            'SELECT name FROM pragma_index_list(?) WHERE name = ?',
            'schema_cache_probe',
            'schema_cache_probe_payload',
          ),
        ).toEqual([{ name: 'schema_cache_probe_payload' }]);
        const afterIndex = exec.mock.calls.length;
        expect(afterIndex).toBeGreaterThan(beforeIndex);
        schemaAll(db, 'SELECT name FROM pragma_index_list(?)', 'schema_cache_probe');
        expect(exec).toHaveBeenCalledTimes(afterIndex);

        db.exec('DROP INDEX schema_cache_probe_payload');
        expect(
          schemaAll(
            db,
            'SELECT name FROM pragma_index_list(?) WHERE name = ?',
            'schema_cache_probe',
            'schema_cache_probe_payload',
          ),
        ).toEqual([]);

        db.exec('DROP TABLE schema_cache_probe');
        expect(schemaAll(db, 'SELECT name FROM pragma_table_info(?)', 'schema_cache_probe')).toEqual([]);
        db.exec('CREATE TABLE schema_cache_probe (replacement TEXT NOT NULL)');
        expect(
          schemaAll<{ name: string; is_required: number }>(
            db,
            'SELECT name, "notnull" AS is_required FROM pragma_table_info(?)',
            'schema_cache_probe',
          ),
        ).toEqual([{ name: 'replacement', is_required: 1 }]);

        expect(() =>
          db.tx(() => {
            db.exec('ALTER TABLE schema_cache_probe ADD COLUMN rolled_back INTEGER');
            expect(
              schemaAll(
                db,
                'SELECT name FROM pragma_table_info(?) WHERE name = ?',
                'schema_cache_probe',
                'rolled_back',
              ),
            ).toEqual([{ name: 'rolled_back' }]);
            throw new Error('rollback schema change');
          }),
        ).toThrow('rollback schema change');
        expect(
          schemaAll(db, 'SELECT name FROM pragma_table_info(?) WHERE name = ?', 'schema_cache_probe', 'rolled_back'),
        ).toEqual([]);

        expect(() => schemaAll(db, 'SELECT name FROM users')).toThrow(TypeError);
        expect(() => db.all('SELECT name FROM pragma_table_info(?)', 'users')).toThrow(SqlStatementRefusedError);
      });
    } finally {
      exec.mockRestore();
    }
  });

  it('keeps same-named schemas independent and closes cached replicas on reset, reopen and set teardown', () => {
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    try {
      const set = fileIndexes();
      const a = set.get('schema-cache-a');
      const b = set.get('schema-cache-b');
      a.exec('CREATE TABLE schema_cache_probe (from_a TEXT)');
      b.exec('CREATE TABLE schema_cache_probe (from_b INTEGER)');
      expect(schemaAll(a, 'SELECT name FROM pragma_table_info(?)', 'schema_cache_probe')).toEqual([{ name: 'from_a' }]);
      expect(schemaAll(b, 'SELECT name FROM pragma_table_info(?)', 'schema_cache_probe')).toEqual([{ name: 'from_b' }]);

      const beforeReset = close.mock.calls.length;
      const blank = set.reset('schema-cache-a');
      expect(close.mock.calls.length).toBeGreaterThanOrEqual(beforeReset + 2);
      expect(schemaAll(blank, 'SELECT name FROM pragma_table_info(?)', 'schema_cache_probe')).toEqual([]);

      const beforeReopen = close.mock.calls.length;
      const reopened = set.reopen('schema-cache-b');
      expect(close.mock.calls.length).toBeGreaterThanOrEqual(beforeReopen + 2);
      expect(schemaAll(reopened, 'SELECT name FROM pragma_table_info(?)', 'schema_cache_probe')).toEqual([
        { name: 'from_b' },
      ]);
      expect(schemaAll(reopened, 'SELECT name FROM pragma_table_info(?)', 'users')).toContainEqual({ name: 'did' });

      const beforeSetClose = close.mock.calls.length;
      set.close();
      expect(close.mock.calls.length).toBeGreaterThan(beforeSetClose);
      expect(set.closed).toBe(true);
    } finally {
      close.mockRestore();
    }
  });
});
