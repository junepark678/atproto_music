// Growth fixtures are direct SQL only: the test measures indexed maintenance
// queries and returned work, not request-path ingestion or elapsed time.

import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import { runDeferredLoveMaintenance } from '../../src/forward/love-deferral-maintenance';
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
