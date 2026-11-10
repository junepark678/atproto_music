// Growth fixtures are direct SQL only: the test measures indexed maintenance
// queries and returned work, not request-path ingestion or elapsed time.

import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import {
  LOVE_MAINTENANCE_VISITS,
  LOVE_MAINTENANCE_WIT_STEPS,
  LOVE_MAINTENANCE_WRITES,
  runDeferredLoveMaintenance,
} from '../../src/forward/love-deferral-maintenance';
import { withMigratedDb } from '../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const SIZE = 100_000;

function observedDb(db: Db) {
  let statements = 0;
  let returnedRows = 0;
  const observed: Db = {
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
  return { db: observed, counts: () => ({ statements, returnedRows }) };
}

it('keeps RR, WIT, AUTH plans and maintenance result work bounded at 1k and 100k direct rows', async () => {
  await withMigratedDb((raw) => {
    raw.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
       VALUES('growth-link',?,'lastfm','remote',X'00','e1',1,'active',1,1)`,
      DID,
    );
    raw.run(
      `INSERT INTO forward_deferred_love_maintenance(singleton,next_head_seq,next_group_seq,next_authority_seq)
       VALUES(1,?,?,?)`,
      SIZE + 1,
      SIZE + 1,
      SIZE + 1,
    );
    raw.tx(() => {
      for (let seq = 1; seq <= SIZE; seq++) {
        const suffix = String(seq).padStart(6, '0');
        raw.run(
          `INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,head_seq,created_at_ms)
           VALUES('growth-link',1,?,?,?,1)`,
          `artist-${suffix}`,
          `track-${suffix}`,
          seq,
        );
        raw.run(
          `INSERT INTO forward_deferred_love_witnesses(link_id,generation,operation_id,group_seq,kind,love_artist_key,love_track_key,created_at_ms)
           VALUES('growth-link',1,?,?,'love',?,?,1)`,
          `operation-${suffix}`,
          seq,
          `artist-${suffix}`,
          `track-${suffix}`,
        );
        raw.run(
          `INSERT INTO forward_deferred_love_authorities(authorization_uri,authorization_rev,authority_seq,action,cid,state,due_seq,created_at_ms)
           VALUES(?, 'rev', ?, 'delete', '', ?, ?, 1)`,
          `at://${DID}/com.example.atmusic.love/${suffix}`,
          seq,
          seq === SIZE ? 'active' : 'conflicted',
          seq === SIZE ? null : seq,
        );
      }
    });

    const plans = [
      raw.all<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT head_seq FROM forward_deferred_love_heads WHERE head_seq>? AND head_seq<=? ORDER BY head_seq LIMIT 1',
        1,
        SIZE,
      ),
      raw.all<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT group_seq FROM forward_deferred_love_witnesses INDEXED BY forward_deferred_love_witnesses_group WHERE group_seq>? AND group_seq<=? ORDER BY group_seq,link_id,generation LIMIT 1',
        1,
        SIZE,
      ),
      raw.all<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT authorization_uri,authorization_rev,authority_seq,state FROM forward_deferred_love_authorities WHERE authority_seq>? AND authority_seq<=? ORDER BY authority_seq LIMIT 8',
        1,
        SIZE,
      ),
    ].map((rows) => rows.map((row) => row.detail).join(' | '));
    expect(plans[0]).toMatch(/SEARCH .*forward_deferred_love_heads.*head_seq/);
    expect(plans[1]).toMatch(/SEARCH .*forward_deferred_love_witnesses.*forward_deferred_love_witnesses_group/);
    expect(plans[2]).toMatch(/SEARCH .*forward_deferred_love_authorities.*authority_seq/);

    const smallUnfiltered = raw.all(
      'SELECT authority_seq,state FROM forward_deferred_love_authorities WHERE authority_seq>? AND authority_seq<=? ORDER BY authority_seq LIMIT 8',
      0,
      1_000,
    );
    const largeUnfiltered = raw.all(
      'SELECT authority_seq,state FROM forward_deferred_love_authorities WHERE authority_seq>? AND authority_seq<=? ORDER BY authority_seq LIMIT 8',
      0,
      SIZE,
    );
    const smallFilteredControl = raw.all(
      "SELECT authority_seq,state FROM forward_deferred_love_authorities WHERE state='active' AND authority_seq>? AND authority_seq<=? ORDER BY authority_seq LIMIT 8",
      0,
      1_000,
    );
    const largeFilteredControl = raw.all(
      "SELECT authority_seq,state FROM forward_deferred_love_authorities WHERE state='active' AND authority_seq>? AND authority_seq<=? ORDER BY authority_seq LIMIT 8",
      0,
      SIZE,
    );
    expect(smallUnfiltered).toHaveLength(8);
    expect(largeUnfiltered).toHaveLength(8);
    expect(smallFilteredControl).toHaveLength(0);
    expect(largeFilteredControl).toHaveLength(1);
    expect(
      raw.one(
        "SELECT count(*) AS n FROM forward_deferred_love_authorities WHERE authority_seq<=? AND state='conflicted'",
        1_000,
      ),
    ).toEqual({ n: 1_000 });
    expect(
      raw.one(
        "SELECT count(*) AS n FROM forward_deferred_love_authorities WHERE authority_seq<=? AND state='conflicted'",
        SIZE,
      ),
    ).toEqual({ n: SIZE - 1 });

    const observed = observedDb(raw);
    const result = runDeferredLoveMaintenance(observed.db, 10);
    expect(result.writes).toBeLessThanOrEqual(128);
    expect(result.visits).toBeLessThanOrEqual(16);
    expect(result.witSteps).toBeLessThanOrEqual(4);
    expect(observed.counts().returnedRows).toBeLessThanOrEqual(20);
    expect(observed.counts().statements).toBeLessThanOrEqual(80);
  });
}, 120_000);

function link(db: Parameters<typeof runDeferredLoveMaintenance>[0], generation = 1): void {
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
     VALUES('maintenance-link',?,'lastfm','remote',X'00','e1',?,'active',1,1)`,
    DID,
    generation,
  );
}

function seedFairnessRows(db: Db, start: number, count: number): void {
  db.tx(() => {
    for (let seq = start; seq < start + count; seq++) {
      const suffix = String(seq).padStart(6, '0');
      const uri = `at://${DID}/com.example.atmusic.love/${suffix}`;
      db.run(
        `INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,head_seq,created_at_ms)
         VALUES('maintenance-link',1,?,?,?,1)`,
        `artist-${suffix}`,
        `track-${suffix}`,
        seq,
      );
      db.run(
        `INSERT INTO forward_deferred_love_witnesses(link_id,generation,operation_id,group_seq,kind,love_artist_key,
           love_track_key,created_at_ms) VALUES('maintenance-link',1,?,?,'love',?,?,1)`,
        `witness-${suffix}`,
        seq,
        `artist-${suffix}`,
        `track-${suffix}`,
      );
      db.run(
        `INSERT INTO forward_deferred_love_authorities(authorization_uri,authorization_rev,authority_seq,action,cid,
           state,due_seq,created_at_ms) VALUES(?,'rev',?,'delete','','active',NULL,1)`,
        uri,
        seq,
      );
      db.run(
        `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,
           created_at_ms,updated_at_ms,authorization_uri,authorization_rev)
         VALUES(?,?,1,?,'unlove',?,'{}','queued',0,0,1,1,?,'rev')`,
        `effect-${suffix}`,
        'maintenance-link',
        DID,
        `effect-${suffix}`,
        uri,
      );
    }
    db.run(
      'UPDATE forward_deferred_love_maintenance SET next_head_seq=?,next_group_seq=?,next_authority_seq=? WHERE singleton=1',
      start + count,
      start + count,
      start + count,
    );
  });
}

it('reaches 600-item WIT and AUTH orphans behind frozen frontiers under continuous arrivals; extending-frontier control starves', async () => {
  await withMigratedDb((db) => {
    link(db);
    db.run(
      'INSERT INTO forward_deferred_love_maintenance(singleton,next_head_seq,next_group_seq,next_authority_seq) VALUES(1,601,601,601)',
    );
    seedFairnessRows(db, 1, 600);
    runDeferredLoveMaintenance(db, 9);
    const first = runDeferredLoveMaintenance(db, 10);
    expect(first.writes).toBeLessThanOrEqual(LOVE_MAINTENANCE_WRITES);
    expect(first.visits).toBeLessThanOrEqual(LOVE_MAINTENANCE_VISITS);
    expect(first.witSteps).toBeLessThanOrEqual(LOVE_MAINTENANCE_WIT_STEPS);
    const firstCursor = db.one<{
      rr_cursor: number;
      rr_frontier: number;
      wit_cursor: number;
      wit_frontier: number;
      auth_cursor: number;
      auth_frontier: number;
    }>(
      'SELECT rr_cursor,rr_frontier,wit_cursor,wit_frontier,auth_cursor,auth_frontier FROM forward_deferred_love_maintenance',
    );
    expect(firstCursor).toEqual({
      rr_cursor: 1,
      rr_frontier: 600,
      wit_cursor: 1,
      wit_frontier: 600,
      auth_cursor: 8,
      auth_frontier: 600,
    });

    db.run("UPDATE forward_deferred_love_witnesses SET generation=0 WHERE operation_id='witness-000001'");
    db.run("DELETE FROM forward_outbox WHERE id='effect-000001'");
    let tick = 0;
    for (; tick < 650; tick++) {
      seedFairnessRows(db, 601 + tick * 120, 120);
      const result = runDeferredLoveMaintenance(db, 11 + tick);
      expect(result.writes).toBeLessThanOrEqual(LOVE_MAINTENANCE_WRITES);
      expect(result.visits).toBeLessThanOrEqual(LOVE_MAINTENANCE_VISITS);
      expect(result.witSteps).toBeLessThanOrEqual(LOVE_MAINTENANCE_WIT_STEPS);
      const witness = db.one(
        "SELECT 1 AS present FROM forward_deferred_love_witnesses WHERE operation_id='witness-000001'",
      );
      const authority = db.one(
        "SELECT 1 AS present FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev='rev'",
        `at://${DID}/com.example.atmusic.love/000001`,
      );
      if (witness === null && authority === null) break;
    }
    expect(tick).toBeLessThan(650);
    expect(
      db.one(
        "SELECT 1 AS present FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev='rev'",
        `at://${DID}/com.example.atmusic.love/000001`,
      ),
    ).toBeNull();
    expect(
      db.one("SELECT 1 AS present FROM forward_deferred_love_witnesses WHERE operation_id='witness-000001'"),
    ).toBeNull();
  });

  await withMigratedDb((db) => {
    link(db);
    db.run(
      'INSERT INTO forward_deferred_love_maintenance(singleton,next_head_seq,next_group_seq,next_authority_seq) VALUES(1,601,601,601)',
    );
    seedFairnessRows(db, 1, 600);
    runDeferredLoveMaintenance(db, 10);
    runDeferredLoveMaintenance(db, 11);
    expect(db.one('SELECT wit_cursor,auth_cursor FROM forward_deferred_love_maintenance')).toEqual({
      wit_cursor: 1,
      auth_cursor: 8,
    });
    db.run("UPDATE forward_deferred_love_witnesses SET generation=0 WHERE operation_id='witness-000001'");
    db.run("DELETE FROM forward_outbox WHERE id='effect-000001'");
    for (let tick = 0; tick < 80; tick++) {
      const start = 601 + tick * 120;
      seedFairnessRows(db, start, 120);
      db.run(
        `UPDATE forward_deferred_love_maintenance
         SET wit_frontier=next_group_seq-1,auth_frontier=next_authority_seq-1 WHERE singleton=1`,
      );
      const result = runDeferredLoveMaintenance(db, 12 + tick);
      expect(result.writes).toBeLessThanOrEqual(LOVE_MAINTENANCE_WRITES);
      expect(result.visits).toBeLessThanOrEqual(LOVE_MAINTENANCE_VISITS);
      expect(result.witSteps).toBeLessThanOrEqual(LOVE_MAINTENANCE_WIT_STEPS);
    }
    expect(
      db.one("SELECT 1 AS present FROM forward_deferred_love_witnesses WHERE operation_id='witness-000001'"),
    ).not.toBeNull();
    expect(
      db.one(
        "SELECT 1 AS present FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev='rev'",
        `at://${DID}/com.example.atmusic.love/000001`,
      ),
    ).not.toBeNull();
  });
}, 120_000);
