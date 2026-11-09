// L1 growth evidence lives in worker-bench so Node's ordinary test timeout and
// fixture size remain small. Rows are seeded directly to isolate index work.

import { expect, it } from 'vitest';
import { LOVE_IMPORT_SOURCE_CLASS_SQL } from '../../src/do/schema';
import { withMigratedDb } from '../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const URI = `at://${DID}/com.example.atmusic.love/growth`;
const INCARNATION = 'growth-incarnation';

it('keeps retained provenance and source exclusion plans bounded as histories grow', async () => {
  await withMigratedDb((db) => {
    const operationInsert = `INSERT INTO operations
      (id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms)
      VALUES(?,?,'love.put','web',0,'com.example.atmusic.love',?,'succeeded',0,?,?)`;
    for (let i = 0; i < 10_000; i++) {
      const createdAt = i + 1;
      db.run(operationInsert, `history-${i}`, DID, `other-${i}`, createdAt, createdAt);
    }
    for (const [id, origin, createdAt] of [
      ['target-old', 'web', 20_001],
      ['target-new', 'import', 20_002],
    ] as const) {
      db.run(
        `INSERT INTO operations
         (id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms)
         VALUES(?,?,'love.put',?,0,'com.example.atmusic.love','target','succeeded',0,?,?)`,
        id,
        DID,
        origin,
        createdAt,
        createdAt,
      );
    }
    const provenanceSql = `SELECT origin FROM operations
      WHERE did=? AND collection=? AND rkey=? ORDER BY created_at_ms DESC LIMIT 1`;
    const provenancePlan = db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${provenanceSql}`, DID, 'com.example.atmusic.love', 'target')
      .map((row) => row.detail)
      .join(' | ');
    expect(provenancePlan).toContain('operations_record_target (did=? AND collection=? AND rkey=?)');
    expect(provenancePlan).not.toMatch(/TEMP B-TREE|operations_did_state/);
    expect(db.one(provenanceSql, DID, 'com.example.atmusic.love', 'target')).toEqual({ origin: 'import' });
    expect(db.one(provenanceSql, DID, 'com.example.atmusic.love', 'missing')).toBeNull();

    for (let i = 0; i < 10_000; i++) {
      db.run(
        `INSERT INTO love_import_bridges
         (did,operation_id,uri,incarnation_key,source_service,state,created_at_ms)
         VALUES(?,?,?,?,?,'bound',?)`,
        DID,
        `bridge-${i}`,
        URI,
        INCARNATION,
        'listenbrainz_zip',
        i,
      );
    }
    const bridgeSql = `SELECT 1 FROM love_import_bridges INDEXED BY love_import_bridges_source_class
      WHERE did=? AND uri=? AND incarnation_key=? AND state='bound'
        AND (${LOVE_IMPORT_SOURCE_CLASS_SQL}) IN (0,?) LIMIT 1`;
    const explain = (destination: number) =>
      db
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${bridgeSql}`, DID, URI, INCARNATION, destination)
        .map((row) => row.detail)
        .join(' | ');
    for (const destination of [1, 2]) {
      const plan = explain(destination);
      expect(plan).toContain('COVERING INDEX love_import_bridges_source_class');
      expect(plan).toContain('<expr>=?');
      expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
    }
    // Every bridge is an allowed ListenBrainz import for a Last.fm link. This
    // miss remains an indexed absence probe even at 10k matching bridge keys.
    expect(db.one(bridgeSql, DID, URI, INCARNATION, 1)).toBeNull();

    db.run(
      `INSERT INTO love_import_bridges
       (did,operation_id,uri,incarnation_key,source_service,state,created_at_ms)
       VALUES(?,?,?,?,'lastfm_json','bound',10001)`,
      DID,
      'trailing-disqualifier',
      URI,
      INCARNATION,
    );
    expect(db.one(bridgeSql, DID, URI, INCARNATION, 1)).toEqual({ 1: 1 });
  });
});
