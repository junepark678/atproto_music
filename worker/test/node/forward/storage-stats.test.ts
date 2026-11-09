import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import type { Db, SqlParam } from '../../../src/do/db';
import {
  FORWARD_STORAGE_STATS_REFRESH_MS,
  FORWARD_STORAGE_STATS_SLICE_SIZE,
  readForwardStorageStats,
  refreshForwardStorageStats,
} from '../../../src/forward/storage-stats';
import { reopen, withMigratedDb } from '../../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';

function trace(db: Db, queries: string[], limits: SqlParam[]): Db {
  return {
    all<T>(sql: string, ...params: SqlParam[]): T[] {
      if (
        /SELECT .* FROM forward_(admissions|outbox)|SELECT .* FROM love_(incarnations|delete_bridges|import_bridges)/s.test(
          sql,
        )
      ) {
        queries.push(sql);
        limits.push(params.at(-1) ?? null);
      }
      return db.all<T>(sql, ...params);
    },
    one: db.one.bind(db),
    run: db.run.bind(db),
    tx: db.tx.bind(db),
  };
}

describe('forward storage statistics refresh', () => {
  it('includes durable live evidence, candidates, and pending removals in bounded marker statistics', async () => {
    await withMigratedDb((db) => {
      const uri = `at://${DID}/com.example.atmusic.scrobble/r1`;
      db.run(
        `INSERT INTO live_record_evidence(uri,did,collection,rkey,up_rev,up_action,up_cid,del_rev,conflict_rev,received_ms,expires_at_ms)
         VALUES(?,?,?,?,?,'create',?,NULL,NULL,?,?)`,
        uri,
        DID,
        'com.example.atmusic.scrobble',
        'r1',
        '2222222222222',
        'bafycid',
        1,
        9999999999999,
      );
      db.run(
        `INSERT INTO live_pending_removals
         (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,listened_at,
          artist_key,track_key,artist,track,recording_mbid,authorized_rev,created_at_ms,expires_at_ms)
         VALUES(?,?,?,'scrobble','','3333333333333','',?,1,'artist-key','track-key','Artist','Track',NULL,NULL,1,?)`,
        uri,
        uri,
        'bafycid',
        'listen-key',
        9999999999999,
      );
      db.run(
        `INSERT INTO live_acceptance_candidates(uri,identity_key,kind,member_uri,cid,created_at_ms,expires_at_ms)
         VALUES(?,?,'scrobble',?,?,1,?)`,
        uri,
        'listen-key',
        uri,
        'bafycid',
        9999999999999,
      );
      let complete = false;
      for (let i = 0; i < 20 && !complete; i++) complete = refreshForwardStorageStats(db, 10);
      expect(complete).toBe(true);
      expect(readForwardStorageStats(db)).toMatchObject({
        markers: { rows: 3 },
        tables: {
          live_record_evidence: { rows: 1 },
          live_acceptance_candidates: { rows: 1 },
          live_pending_removals: { rows: 1 },
        },
      });
    });
  });

  it('keyset scans bounded pages, resumes after restart, and publishes only a complete cycle', async () => {
    await withMigratedDb((initial, context) => {
      const clock = fixedClock();
      const now = clock.nowMs();
      const queries: string[] = [];
      const limits: SqlParam[] = [];
      let db = initial;
      for (let seq = 0; seq < FORWARD_STORAGE_STATS_SLICE_SIZE * 2 + 5; seq++) {
        db.run(
          `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
           VALUES (?,?, 'live', NULL, ?,?)`,
          DID,
          `key-${String(seq).padStart(4, '0')}`,
          now,
          seq + 1,
        );
      }

      const scan = () => refreshForwardStorageStats(trace(db, queries, limits), clock.nowMs());
      expect(scan()).toBe(false);
      expect(db.one('SELECT rows_seen FROM forward_storage_scan WHERE table_key=?', 'forward_admissions')).toEqual({
        rows_seen: FORWARD_STORAGE_STATS_SLICE_SIZE,
      });
      expect(readForwardStorageStats(db).refreshedAtMs).toBeNull();
      expect(readForwardStorageStats(db).markers.rows).toBeNull();

      db = reopen(db);
      clock.advance(10_000);
      expect(scan()).toBe(false);
      expect(db.one('SELECT rows_seen FROM forward_storage_scan WHERE table_key=?', 'forward_admissions')).toEqual({
        rows_seen: FORWARD_STORAGE_STATS_SLICE_SIZE * 2,
      });
      expect(readForwardStorageStats(db).refreshedAtMs).toBeNull();

      clock.advance(10_000);
      expect(scan()).toBe(true);
      const stats = readForwardStorageStats(db);
      const admissionBytes =
        205 * (Buffer.byteLength(DID) + Buffer.byteLength('live')) +
        Array.from({ length: 205 }, (_, seq) => Buffer.byteLength(`key-${String(seq).padStart(4, '0')}`)).reduce(
          (total, length) => total + length,
          0,
        );
      expect(stats).toMatchObject({
        refreshedAtMs: clock.nowMs(),
        markers: { rows: 205, logicalBytesEstimate: admissionBytes },
        tables: { forward_admissions: { rows: 205, logicalBytesEstimate: admissionBytes } },
      });
      expect(
        db.one('SELECT rows_seen,complete FROM forward_storage_scan WHERE table_key=?', 'forward_admissions'),
      ).toEqual({
        rows_seen: 0,
        complete: 0,
      });

      const pageQueries = queries.filter((sql) => sql.includes('FROM forward_admissions'));
      expect(pageQueries).toHaveLength(3);
      expect(pageQueries.every((sql) => sql.includes('LIMIT ?'))).toBe(true);
      expect(limits.length).toBeGreaterThan(0);
      expect(limits.every((limit) => limit === FORWARD_STORAGE_STATS_SLICE_SIZE)).toBe(true);
      expect(pageQueries.slice(1).every((sql) => sql.includes('WHERE (did,identity_key) > (?,?)'))).toBe(true);
      expect(pageQueries.every((sql) => !/count\s*\(|sum\s*\(/i.test(sql))).toBe(true);

      db.run(
        `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
         VALUES (?,'key-after-cache','live',NULL,?,206)`,
        DID,
        clock.nowMs(),
      );
      expect(refreshForwardStorageStats(db, clock.nowMs() + FORWARD_STORAGE_STATS_REFRESH_MS - 1)).toBe(false);
      expect(readForwardStorageStats(db).markers.rows).toBe(205);

      clock.advance(FORWARD_STORAGE_STATS_REFRESH_MS);
      expect(refreshForwardStorageStats(db, clock.nowMs())).toBe(false);
      expect(readForwardStorageStats(db).markers.rows).toBe(205);
      expect(db.one('SELECT rows_seen FROM forward_storage_scan WHERE table_key=?', 'forward_admissions')).toEqual({
        rows_seen: FORWARD_STORAGE_STATS_SLICE_SIZE,
      });
      expect(context.current).toBe(db);
    });
  });
});
