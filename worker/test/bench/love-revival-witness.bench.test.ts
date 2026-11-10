// Growth fixtures are direct SQL only; the exercised lookup is the exact
// production parent/child witness primary-key query.

import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import { REVIVAL_WITNESS_LOOKUP_SQL } from '../../src/musicbrainz/revive-loves';
import { withMigratedDb } from '../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';

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

it('keeps parent and child witness PK lookups bounded with 1k and 10k unrelated witnesses', async () => {
  await withMigratedDb((db) => {
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
       VALUES('revival-growth-link',?,'listenbrainz','remote',X'00','e1',1,'active',1,1)`,
      DID,
    );
    for (const size of [1_000, 10_000]) {
      db.tx(() => {
        for (let seq = 1; seq <= size; seq++)
          db.run(
            `INSERT INTO forward_deferred_love_witnesses(link_id,generation,operation_id,group_seq,kind,love_artist_key,
               love_track_key,authorization_uri,authorization_rev,created_at_ms)
             VALUES('revival-growth-link',1,?,?, 'unlove','artist','track','at://did:example/love/key','rev',1)`,
            `witness-${size}-${String(seq).padStart(5, '0')}`,
            seq,
          );
      });
      const plan = db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${REVIVAL_WITNESS_LOOKUP_SQL}`,
        'revival-growth-link',
        1,
        `witness-${size}-${String(size).padStart(5, '0')}`,
      );
      expect(plan.map((row) => row.detail).join(' | ')).toMatch(
        /SEARCH forward_deferred_love_witnesses USING INDEX sqlite_autoindex_forward_deferred_love_witnesses_1 \(link_id=\? AND generation=\? AND operation_id=\?\)/,
      );
      const observed = observedDb(db);
      expect(
        observed.db.one<{ kind: string; group_seq: string; love_artist_key: string }>(
          REVIVAL_WITNESS_LOOKUP_SQL,
          'revival-growth-link',
          1,
          `witness-${size}-${String(size).padStart(5, '0')}`,
        ),
      ).toMatchObject({ kind: 'unlove', group_seq: String(size), love_artist_key: 'artist' });
      expect(observed.db.one(REVIVAL_WITNESS_LOOKUP_SQL, 'revival-growth-link', 1, 'not-present')).toBeNull();
      expect(observed.counts()).toEqual({ statements: 2, returnedRows: 1 });
    }
  });
}, 120_000);
