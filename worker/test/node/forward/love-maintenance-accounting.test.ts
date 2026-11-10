import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { LinkedAccountRow } from '../../../src/app/rows';
import type { Db } from '../../../src/do/db';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { runLoveCoverageChunk } from '../../../src/forward/love-coverage';
import { conflictDeferredLoveAuthority } from '../../../src/forward/love-coverage-authority';
import { runDeferredLoveMaintenance } from '../../../src/forward/love-deferral-maintenance';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { withMigratedDb } from '../support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';

function seedLink(db: Db, done = false): void {
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,
       forward_scrobbles,backfill_state,created_at_ms,updated_at_ms)
     VALUES('cost',?,'lastfm','remote',X'00','e1',1,'active',1,?,1,1)`,
    DID,
    done ? 'done' : 'running',
  );
}

it.each([false, true])('prunes sixteen intents and rearms a surviving DUE decision, done=%s', async (done) => {
  await withMigratedDb((db) => {
    seedLink(db, done);
    db.run('INSERT INTO forward_deferred_love_maintenance(singleton,lane_turn,next_head_seq) VALUES(1,1,2)');
    db.run(`INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,
        head_seq,next_seq,live_from_seq,maintenance_seq,created_at_ms)
      VALUES('cost',1,'a','t',1,18,17,1,1)`);
    for (let seq = 1; seq <= 17; seq++)
      db.run(
        `INSERT INTO forward_deferred_love_intents(link_id,generation,love_artist_key,love_track_key,
           intent_seq,kind,operation_id,origin_class,payload_json,intent_at_ms)
         VALUES('cost',1,'a','t',?,'unlove',?,'unclassified','{}',1)`,
        seq,
        `op-${seq}`,
      );

    const result = runDeferredLoveMaintenance(db, 10);
    const firstDue = result.unitCosts.find((unit) => unit.lane === 'due');
    expect(firstDue).toMatchObject({ reserved: 21, actual: done ? 21 : 20 });
    expect(result.writes).toBeLessThanOrEqual(128);
    expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_intents')).toEqual({ n: 1 });
    expect(db.one('SELECT operation_id FROM forward_deferred_love_intents')).toEqual({ operation_id: 'op-17' });
    expect(db.one('SELECT armed_seq FROM forward_deferred_love_heads')).toEqual({ armed_seq: expect.any(Number) });
    expect(db.one('SELECT backfill_state FROM linked_accounts')).toEqual({ backfill_state: 'running' });
  });
});

it('makes progress on the DUE boundary produced by real writers and conflicted coverage', async () => {
  await withMigratedDb((db) => {
    seedLink(db, true);
    db.run('UPDATE linked_accounts SET forward_scrobbles=0');
    const random = seededRandom(821);
    const uri = `at://${DID}/com.example.atmusic.love/valid`;
    const rev = '3lbcdefghijkl';
    const enqueue = (operationId: string, authorized: boolean) =>
      enqueueForwards(db, {
        did: DID,
        linkId: 'cost',
        now: 10,
        random,
        items: [
          {
            kind: 'unlove',
            operationId,
            payload: { artist: 'a', track: 't' },
            ...(authorized ? { authorization: { uri, rev } } : {}),
          },
        ],
      });
    enqueue('surviving-U', false);
    enqueueHints(db, [
      {
        did: DID,
        collection: 'com.example.atmusic.love',
        rkey: 'valid',
        source: 'jetstream',
        hintRev: rev,
        live: { operation: 'delete' },
        receiptMs: 10,
      },
    ]);
    for (let seq = 0; seq < 17; seq++) enqueue(`authorized-${seq}`, true);
    db.tx(() => conflictDeferredLoveAuthority(db, uri, rev));
    db.run("UPDATE linked_accounts SET forward_scrobbles=1,backfill_state='running'");
    runLoveCoverageChunk(db, db.one<LinkedAccountRow>('SELECT * FROM linked_accounts')!, 11, random, 16);
    // This supported rotation reaches the real writer-produced disarmed head
    // before INV or RR can mask the DUE reservation boundary.
    db.run('UPDATE forward_deferred_love_maintenance SET lane_turn=1');
    expect(db.one('SELECT armed_seq,decided_seq FROM forward_deferred_love_heads')).toEqual({
      armed_seq: null,
      decided_seq: null,
    });
    const result = runDeferredLoveMaintenance(db, 12);
    expect(result.unitCosts.find((unit) => unit.lane === 'due')).toMatchObject({ reserved: 21, actual: 20 });
    expect(result.writes).toBeLessThanOrEqual(128);
    expect(() => runDeferredLoveMaintenance(db, 13)).not.toThrow();
    expect(db.one('SELECT operation_id FROM forward_deferred_love_intents')).toEqual({ operation_id: 'surviving-U' });
    expect(db.one('SELECT armed_seq FROM forward_deferred_love_heads')).toEqual({ armed_seq: expect.any(Number) });
  });
});

it.each(['initialization', 'cursor', 'counter', 'turn'] as const)(
  'rolls back amplified %s metadata before that transaction commits',
  async (stage) => {
    await withMigratedDb((raw) => {
      seedLink(raw);
      if (stage !== 'initialization') {
        raw.run(`INSERT INTO forward_deferred_love_maintenance(singleton,lane_turn,next_authority_seq,auth_frontier)
          VALUES(1,4,2,1)`);
        raw.run(`INSERT INTO forward_deferred_love_authorities(authorization_uri,authorization_rev,authority_seq,
            action,cid,state,created_at_ms) VALUES('authority','rev',1,'delete','','active',1)`);
      }
      let injected = false;
      const db: Db = {
        all: raw.all.bind(raw),
        one: raw.one.bind(raw),
        tx: (fn) => raw.tx(fn),
        run(sql, ...params) {
          const result = raw.run(sql, ...params);
          const matches =
            stage === 'initialization'
              ? sql.includes('INSERT OR IGNORE INTO forward_deferred_love_maintenance')
              : stage === 'cursor'
                ? sql.includes('SET rr_cursor=')
                : stage === 'counter'
                  ? sql.includes('INSERT INTO counters')
                  : sql.includes('SET lane_turn=');
          if (matches && !injected) {
            injected = true;
            const extra = stage === 'turn' ? 129 : stage === 'counter' ? 16 : 1;
            // Real SQLite writes, original facade result unchanged: spare work
            // allowance must never conceal expansion of a metadata statement.
            for (let index = 0; index < extra; index++)
              raw.run("UPDATE linked_accounts SET updated_at_ms=updated_at_ms+1 WHERE id='cost'");
          }
          return result;
        },
      };
      expect(() => runDeferredLoveMaintenance(db, 10)).toThrow(/metadata exceeded reserved cost/);
      expect(injected).toBe(true);
      expect(raw.one('SELECT updated_at_ms FROM linked_accounts')).toEqual({ updated_at_ms: 1 });
      if (stage === 'initialization') {
        expect(raw.one('SELECT * FROM forward_deferred_love_maintenance')).toBeNull();
      } else if (stage === 'turn') {
        // Earlier AUTH data and its counter committed; only the failed final
        // transaction rolls back, and this invocation never retries it.
        expect(raw.one('SELECT * FROM forward_deferred_love_authorities')).toBeNull();
        expect(raw.one("SELECT value FROM counters WHERE label='deferred_maintenance_auth'")).toEqual({ value: 1 });
        expect(raw.one('SELECT lane_turn FROM forward_deferred_love_maintenance')).toEqual({ lane_turn: 4 });
      } else {
        expect(raw.one('SELECT state FROM forward_deferred_love_authorities')).toEqual({ state: 'active' });
        expect(raw.one("SELECT value FROM counters WHERE label='deferred_maintenance_auth'")).toBeNull();
        expect(raw.one('SELECT auth_cursor FROM forward_deferred_love_maintenance')).toEqual({ auth_cursor: 0 });
      }
    });
  },
);
