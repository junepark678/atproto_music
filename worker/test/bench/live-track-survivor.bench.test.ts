// Direct SQL fixtures compare index-backed existence work at two table sizes.
// The test asserts statements, returned rows and plans, never elapsed time.

import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import { hasPresentTrackLove, PRESENT_TRACK_LOVE_SQL } from '../../src/outbox/live-track-survivor';
import { withMigratedDb } from '../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const TIMESTAMP = '2026-01-15T12:00:00.000000000Z';

function observed(db: Db) {
  let statements = 0;
  let returnedRows = 0;
  const proxy: Db = {
    all<T>(sql: string, ...params: SqlParam[]): T[] {
      statements++;
      const rows = db.all<T>(sql, ...params);
      returnedRows += rows.length;
      return rows;
    },
    one<T>(sql: string, ...params: SqlParam[]): T | null {
      statements++;
      const row = db.one<T>(sql, ...params);
      if (row !== null) returnedRows++;
      return row;
    },
    run(sql: string, ...params: SqlParam[]) {
      statements++;
      return db.run(sql, ...params);
    },
    tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
      return db.tx(fn);
    },
  };
  return { db: proxy, counts: () => ({ statements, returnedRows }) };
}

it('keeps canonical love survivor lookup indexed and bounded at 1k and 10k direct rows', async () => {
  await withMigratedDb((db) => {
    db.run("INSERT INTO users(did,joined_at,indexing_state) VALUES(?,'2026-01-15T00:00:00.000000000Z','current')", DID);
    const insert = (n: number) => {
      const suffix = String(n).padStart(5, '0');
      db.run(
        `INSERT INTO loves(uri,did,rkey,cid,artist,track,artist_key,track_key,created_at,indexed_at)
         VALUES(?,?,?,'cid','Artist','Track',?,?,?,?)`,
        `at://${DID}/com.example.atmusic.love/${suffix}`,
        DID,
        suffix,
        `artist-${suffix}`,
        `track-${suffix}`,
        TIMESTAMP,
        TIMESTAMP,
      );
    };
    const assertPlanAndLookup = (size: number) => {
      const plan = db
        .all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${PRESENT_TRACK_LOVE_SQL}`,
          DID,
          `artist-${String(size).padStart(5, '0')}`,
          `track-${String(size).padStart(5, '0')}`,
        )
        .map((row) => row.detail)
        .join(' | ');
      expect(plan).toMatch(/SEARCH loves USING (COVERING )?INDEX loves_owner_track/);
      expect(plan).not.toMatch(/SCAN loves|TEMP B-TREE/i);
      const measured = observed(db);
      const key = String(size).padStart(5, '0');
      expect(hasPresentTrackLove(measured.db, DID, `artist-${key}`, `track-${key}`)).toBe(true);
      expect(measured.counts()).toEqual({ statements: 1, returnedRows: 1 });
      const absent = observed(db);
      expect(hasPresentTrackLove(absent.db, DID, 'missing-artist', 'missing-track')).toBe(false);
      expect(absent.counts()).toEqual({ statements: 1, returnedRows: 0 });
    };

    db.tx(() => {
      for (let n = 1; n <= 1_000; n++) insert(n);
    });
    assertPlanAndLookup(1_000);
    db.tx(() => {
      for (let n = 1_001; n <= 10_000; n++) insert(n);
    });
    assertPlanAndLookup(10_000);
  });
});
