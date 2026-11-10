import { describe, expect, it } from 'vitest';
import type { Db, SqlParam } from '../../../src/do/db';
import {
  bindApiLoveCreatedOperation,
  bindApiLoveOperation,
  compareLoveApiComparisonFact,
  prepareLoveApiDirectAbsence,
  recordLoveApiComparisonFact,
  sealLoveApiDirectAbsence,
} from '../../../src/forward/love-api-recipients';
import { withMigratedDb } from '../../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const URI = `at://${DID}/com.example.atmusic.love/retained-fact`;
const REV = '3lbcdefghijmu';
const CID = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function insertBindingFixture(db: Db) {
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
     VALUES('binding-link',?,'lastfm','remote',X'00','e1',3,'active',1,1)`,
    DID,
  );
  db.run(
    `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms)
     VALUES('bound-love-op',?,'love.put','listenbrainz',0,'com.example.atmusic.love','request-rkey','running',1,1,1)`,
    DID,
  );
  db.run(
    `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
     VALUES(?,'snapshot-incarnation','present','snapshot',NULL,1)`,
    URI,
  );
  db.run(
    `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
     VALUES(?,?,'api',NULL,1,1)`,
    DID,
    `love-uri:${DID}:com.example.atmusic.love:request-rkey`,
  );
  db.run(
    `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms)
     VALUES('bound-love-op','binding-link',3,?,'love','g3:bound-love-op','{}','queued',0,1,1,1)`,
    DID,
  );
}

describe('L2 retained comparison fact', () => {
  it('measures cold and replay create-binding handoffs from actual SQLite changes', async () => {
    await withMigratedDb((raw) => {
      insertBindingFixture(raw);
      raw.run('DELETE FROM love_incarnations WHERE uri=?', URI);
      const mutation = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
      let reads = 0;
      let mutations = 0;
      let returnedRows = 0;
      const traced: Db = {
        all<T>(sql: string, ...params: SqlParam[]): T[] {
          if (mutation.test(sql)) mutations += 1;
          else reads += 1;
          const rows = raw.all<T>(sql, ...params);
          returnedRows += rows.length;
          return rows;
        },
        one<T>(sql: string, ...params: SqlParam[]): T | null {
          reads += 1;
          const row = raw.one<T>(sql, ...params);
          if (row !== null) returnedRows += 1;
          return row;
        },
        run(sql: string, ...params: SqlParam[]) {
          mutations += 1;
          return raw.run(sql, ...params);
        },
        tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
          return raw.tx(fn);
        },
      };
      const before = raw.one<{ total: number }>('SELECT total_changes() AS total')!.total;
      const accepted = bindApiLoveCreatedOperation(traced, {
        did: DID,
        uri: URI,
        collection: 'com.example.atmusic.love',
        operationId: 'bound-love-op',
        admissionIdentityKey: `love-uri:${DID}:com.example.atmusic.love:request-rkey`,
        nowMs: 10,
      });
      const after = raw.one<{ total: number }>('SELECT total_changes() AS total')!.total;
      const trace = { changedRows: after - before, reads, mutationStatements: mutations, returnedRows };
      expect(accepted).toBe(true);
      expect(trace.changedRows).toBeLessThanOrEqual(13);
      expect(
        raw.one('SELECT api_origin FROM love_api_bindings WHERE did=? AND operation_id=?', DID, 'bound-love-op'),
      ).toEqual({
        api_origin: 'listenbrainz',
      });
      reads = 0;
      mutations = 0;
      returnedRows = 0;
      const replayBefore = raw.one<{ total: number }>('SELECT total_changes() AS total')!.total;
      expect(
        bindApiLoveCreatedOperation(traced, {
          did: DID,
          uri: URI,
          collection: 'com.example.atmusic.love',
          operationId: 'bound-love-op',
          admissionIdentityKey: `love-uri:${DID}:com.example.atmusic.love:request-rkey`,
          nowMs: 11,
        }),
      ).toBe(true);
      const replayAfter = raw.one<{ total: number }>('SELECT total_changes() AS total')!.total;
      const replayTrace = {
        changedRows: replayAfter - replayBefore,
        reads,
        mutationStatements: mutations,
        returnedRows,
      };
      expect(replayTrace.changedRows).toBe(0);
      reads = 0;
      mutations = 0;
      returnedRows = 0;
      const refusedBefore = raw.one<{ total: number }>('SELECT total_changes() AS total')!.total;
      expect(
        bindApiLoveCreatedOperation(traced, {
          did: DID,
          uri: `at://${DID}/com.example.atmusic.love/rebound-uri`,
          collection: 'com.example.atmusic.love',
          operationId: 'bound-love-op',
          admissionIdentityKey: `love-uri:${DID}:com.example.atmusic.love:request-rkey`,
          nowMs: 12,
        }),
      ).toBe(false);
      const refusedAfter = raw.one<{ total: number }>('SELECT total_changes() AS total')!.total;
      const refusedTrace = {
        changedRows: refusedAfter - refusedBefore,
        reads,
        mutationStatements: mutations,
        returnedRows,
      };
      expect(refusedTrace.changedRows).toBe(0);
      if (process.env.FINDING32_L2_COST_TRACE === '1') {
        console.info(`L2_CREATE_BIND_TRACE ${JSON.stringify(trace)}`);
        console.info(`L2_CREATE_BIND_REPLAY_TRACE ${JSON.stringify(replayTrace)}`);
        console.info(`L2_CREATE_BIND_REFUSAL_TRACE ${JSON.stringify(refusedTrace)}`);
      }
    });
  });

  it('seals a direct absence from the exact live delete tuple and retained API source', async () => {
    await withMigratedDb((db) => {
      insertBindingFixture(db);
      expect(
        bindApiLoveOperation(db, {
          did: DID,
          uri: URI,
          incarnationKey: 'snapshot-incarnation',
          operationId: 'bound-love-op',
          admissionIdentityKey: `love-uri:${DID}:com.example.atmusic.love:request-rkey`,
          nowMs: 10,
        }),
      ).toBe(true);
      db.run("UPDATE love_api_recipients SET sent_operation_id='bound-love-op'");
      db.run(
        `INSERT INTO live_record_evidence(uri,did,collection,rkey,del_rev,received_ms,expires_at_ms)
         VALUES(?,?,?,'retained-fact',?,20,90000)`,
        URI,
        DID,
        'com.example.atmusic.love',
        REV,
      );
      const prepared = prepareLoveApiDirectAbsence(db, {
        did: DID,
        uri: URI,
        incarnationKey: 'snapshot-incarnation',
        rev: REV,
        nowMs: 30,
      });
      if (prepared === null || prepared === 'conflicted') throw new Error('exact live delete fact was refused');
      expect(
        sealLoveApiDirectAbsence(db, prepared, {
          artist: 'Björk',
          track: 'Jóga',
          album: null,
          recordingMbid: null,
        }),
      ).toBe(true);
      expect(db.one('SELECT state FROM love_api_recipients')).toEqual({ state: 'sealed' });
      expect(db.one('SELECT fact_action,fact_cid,expires_at_ms,payload_json FROM love_api_unlove_decisions')).toEqual({
        fact_action: 'delete',
        fact_cid: '',
        expires_at_ms: 90000,
        payload_json: JSON.stringify({ artist: 'Björk', track: 'Jóga', origin: 'listenbrainz' }),
      });
    });
  });

  it('binds an API admission to the exact current generation within the handoff write allowance', async () => {
    await withMigratedDb((raw) => {
      insertBindingFixture(raw);
      let reads = 0;
      let mutations = 0;
      let returnedRows = 0;
      const mutation = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
      const traced: Db = {
        all<T>(sql: string, ...params: SqlParam[]): T[] {
          if (mutation.test(sql)) mutations += 1;
          else reads += 1;
          const rows = raw.all<T>(sql, ...params);
          returnedRows += rows.length;
          return rows;
        },
        one<T>(sql: string, ...params: SqlParam[]): T | null {
          reads += 1;
          const row = raw.one<T>(sql, ...params);
          if (row !== null) returnedRows += 1;
          return row;
        },
        run(sql: string, ...params: SqlParam[]) {
          mutations += 1;
          return raw.run(sql, ...params);
        },
        tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
          return raw.tx(fn);
        },
      };
      const before = raw.one<{ total: number }>('SELECT total_changes() AS total')!.total;
      const accepted = bindApiLoveOperation(traced, {
        did: DID,
        uri: URI,
        incarnationKey: 'snapshot-incarnation',
        operationId: 'bound-love-op',
        admissionIdentityKey: `love-uri:${DID}:com.example.atmusic.love:request-rkey`,
        nowMs: 10,
      });
      const after = raw.one<{ total: number }>('SELECT total_changes() AS total')!.total;
      const trace = { changedRows: after - before, reads, mutationStatements: mutations, returnedRows };
      expect(accepted).toBe(true);
      expect(trace.changedRows).toBeLessThanOrEqual(13);
      expect(
        raw.one<{ api_origin: string }>(
          'SELECT api_origin FROM love_api_bindings WHERE did=? AND operation_id=?',
          DID,
          'bound-love-op',
        ),
      ).toEqual({ api_origin: 'listenbrainz' });
      if (process.env.FINDING32_L2_COST_TRACE === '1') console.info(`L2_BIND_TRACE ${JSON.stringify(trace)}`);
    });
  });

  it('does not infer an absent fact and refuses invalid delete/update domains', async () => {
    await withMigratedDb((db) => {
      expect(compareLoveApiComparisonFact(db, { uri: URI, rev: REV, action: 'delete', cid: '' }, 10)).toBe(false);
      expect(
        recordLoveApiComparisonFact(db, { uri: URI, rev: REV, action: 'delete', cid: 'opaque', horizonMs: 100 }, 10),
      ).toBe(false);
      expect(
        recordLoveApiComparisonFact(db, { uri: URI, rev: REV, action: 'update', cid: 'bad-cid', horizonMs: 100 }, 10),
      ).toBe(false);
      expect(db.one('SELECT 1 FROM love_api_comparison_facts')).toBeNull();
      expect(db.one('SELECT 1 FROM forward_deferred_love_authorities')).toBeNull();
    });
  });

  it('keeps the minimum horizon and makes an exact tuple mismatch sticky in L2 and B2', async () => {
    await withMigratedDb((db: Db) => {
      const deletion = { uri: URI, rev: REV, action: 'delete' as const, cid: '', horizonMs: 90_000 };
      expect(recordLoveApiComparisonFact(db, deletion, 10)).toBe(true);
      expect(recordLoveApiComparisonFact(db, { ...deletion, horizonMs: 60_000 }, 20)).toBe(true);
      expect(compareLoveApiComparisonFact(db, { uri: URI, rev: REV, action: 'delete', cid: '' }, 30)).toBe(false);
      expect(
        db.one<{ horizon_ms: number; conflicted: number; created_at_ms: number }>(
          'SELECT horizon_ms,conflicted,created_at_ms FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=?',
          URI,
          REV,
        ),
      ).toEqual({ horizon_ms: 60_000, conflicted: 0, created_at_ms: 10 });

      expect(compareLoveApiComparisonFact(db, { uri: URI, rev: REV, action: 'update', cid: CID }, 40)).toBe(true);
      expect(compareLoveApiComparisonFact(db, { uri: URI, rev: REV, action: 'delete', cid: '' }, 50)).toBe(true);
      expect(
        db.one<{ conflicted: number }>(
          'SELECT conflicted FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=?',
          URI,
          REV,
        ),
      ).toEqual({ conflicted: 1 });
      expect(
        db.one<{ state: string; action: string; cid: string }>(
          'SELECT state,action,cid FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
          URI,
          REV,
        ),
      ).toEqual({ state: 'conflicted', action: 'delete', cid: '' });
    });
  });
});
