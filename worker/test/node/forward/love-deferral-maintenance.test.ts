import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import type { CoreExtension, ExtensionContext } from '../../../src/app/host';
import type { Db, SqlParam } from '../../../src/do/db';
import { linkBackfillExtension } from '../../../src/forward/backfill';
import type { ForwardRuntime } from '../../../src/forward/forwarder';
import {
  LOVE_MAINTENANCE_VISITS,
  LOVE_MAINTENANCE_WIT_STEPS,
  LOVE_MAINTENANCE_WRITES,
  runDeferredLoveMaintenance,
} from '../../../src/forward/love-deferral-maintenance';
import { armLoveCoverage } from '../../../src/forward/love-deferral-storage';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { reopen, withMigratedDb } from '../../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';

function link(db: Parameters<typeof runDeferredLoveMaintenance>[0], generation = 1): void {
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
     VALUES('maintenance-link',?,'lastfm','remote',X'00','e1',?,'active',1,1)`,
    DID,
    generation,
  );
}

describe('deferred love maintenance', () => {
  it('keeps a completed run settled when interior validation leaves its newest decision unchanged', async () => {
    await withMigratedDb((db) => {
      link(db);
      db.run("UPDATE linked_accounts SET forward_scrobbles=0 WHERE id='maintenance-link'");
      for (const [id, kind] of [
        ['older-unlove', 'love.delete'],
        ['newer-love', 'love.put'],
      ] as const) {
        db.run(
          `INSERT INTO operations(id,did,kind,origin,priority,collection,state,due_at,created_at_ms,updated_at_ms)
           VALUES(?,?,?,'web',1,'com.example.atmusic.love','queued',1,1,1)`,
          id,
          DID,
          kind,
        );
        enqueueForwards(db, {
          did: DID,
          linkId: 'maintenance-link',
          now: id === 'older-unlove' ? 10 : 20,
          random: seededRandom(321),
          items: [
            {
              kind: kind === 'love.put' ? 'love' : 'unlove',
              operationId: id,
              payload: { artist: 'artist', track: 'track', origin: 'web' },
            },
          ],
        });
      }
      db.run("UPDATE linked_accounts SET forward_scrobbles=1,backfill_state='done',backfill_discovery_done=1");
      db.run('UPDATE forward_deferred_love_heads SET armed_seq=NULL,decided_seq=2,maintenance_seq=head_seq');
      runDeferredLoveMaintenance(db, 30);
      expect(db.one('SELECT backfill_state,backfill_discovery_done FROM linked_accounts')).toEqual({
        backfill_state: 'done',
        backfill_discovery_done: 1,
      });
      expect(db.one('SELECT armed_seq,decided_seq FROM forward_deferred_love_heads')).toEqual({
        armed_seq: null,
        decided_seq: 2,
      });
    });
  });

  it.each(['rr', 'wit', 'auth'] as const)(
    'rejects an unsafe %s pass successor before committing that lane',
    async (lane) => {
      await withMigratedDb((db) => {
        db.run(
          `INSERT INTO forward_deferred_love_maintenance(singleton,next_head_seq,next_group_seq,next_authority_seq,${lane}_passes)
        VALUES(1,2,2,2,?)`,
          String(Number.MAX_SAFE_INTEGER),
        );
        expect(() => runDeferredLoveMaintenance(db, 10)).toThrow();
        expect(
          db.one(`SELECT CAST(${lane}_passes AS TEXT) AS passes,${lane}_cursor AS cursor,${lane}_frontier AS frontier
        FROM forward_deferred_love_maintenance`),
        ).toEqual({ passes: String(Number.MAX_SAFE_INTEGER), cursor: 0, frontier: 0 });
      });
    },
  );

  it.each(['rr', 'wit', 'auth'] as const)('allows the last safe %s pass successor', async (lane) => {
    await withMigratedDb((db) => {
      db.run(
        `INSERT INTO forward_deferred_love_maintenance(singleton,next_head_seq,next_group_seq,next_authority_seq,${lane}_passes)
        VALUES(1,2,2,2,?)`,
        String(Number.MAX_SAFE_INTEGER - 1),
      );
      expect(runDeferredLoveMaintenance(db, 10).writes).toBeLessThanOrEqual(LOVE_MAINTENANCE_WRITES);
      expect(db.one(`SELECT CAST(${lane}_passes AS TEXT) AS passes FROM forward_deferred_love_maintenance`)).toEqual({
        passes: String(Number.MAX_SAFE_INTEGER),
      });
    });
  });

  it('does not arm a head or overflow the linked run revision when its successor is unsafe', async () => {
    await withMigratedDb((db) => {
      link(db);
      db.run(
        "UPDATE linked_accounts SET backfill_state='done',backfill_run_revision=?",
        String(Number.MAX_SAFE_INTEGER),
      );
      db.run(`INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,head_seq,created_at_ms)
        VALUES('maintenance-link',1,'artist','track',1,1)`);
      const head = db.one('SELECT * FROM forward_deferred_love_heads');
      expect(() =>
        db.tx(() => armLoveCoverage(db, { id: 'maintenance-link', generation: 1 }, 'artist', 'track')),
      ).toThrow();
      expect(db.one('SELECT * FROM forward_deferred_love_heads')).toEqual(head);
      expect(
        db.one('SELECT CAST(backfill_run_revision AS TEXT) AS revision,backfill_state FROM linked_accounts'),
      ).toEqual({ revision: String(Number.MAX_SAFE_INTEGER), backfill_state: 'done' });
      db.run('UPDATE linked_accounts SET backfill_run_revision=?', String(Number.MAX_SAFE_INTEGER - 1));
      expect(db.tx(() => armLoveCoverage(db, { id: 'maintenance-link', generation: 1 }, 'artist', 'track'))).toBe(true);
      expect(db.one('SELECT CAST(backfill_run_revision AS TEXT) AS revision FROM linked_accounts')).toEqual({
        revision: String(Number.MAX_SAFE_INTEGER),
      });
    });
  });

  it('starts frozen integer passes, removes cancellations, and stays within whole-call budgets', async () => {
    await withMigratedDb((db) => {
      link(db);
      db.run(
        `INSERT INTO operations(id,did,kind,origin,priority,collection,state,due_at,created_at_ms,updated_at_ms)
         VALUES('cancelled-op',?,'love.delete','web',1,'com.example.atmusic.love','cancelled',1,1,1)`,
        DID,
      );
      db.run(
        `INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,head_seq,next_seq,live_from_seq,created_at_ms)
         VALUES('maintenance-link',1,'artist','track',1,2,1,1)`,
      );
      db.run(
        `INSERT INTO forward_deferred_love_intents(link_id,generation,love_artist_key,love_track_key,intent_seq,kind,operation_id,
          origin_class,payload_json,intent_at_ms)
         VALUES('maintenance-link',1,'artist','track',1,'unlove','cancelled-op','operation','{}',1)`,
      );
      db.run('INSERT INTO forward_deferred_love_maintenance(singleton,next_head_seq) VALUES(1,2)');

      const first = runDeferredLoveMaintenance(db, 10);
      expect(first.writes).toBeLessThanOrEqual(LOVE_MAINTENANCE_WRITES);
      expect(first.visits).toBeLessThanOrEqual(LOVE_MAINTENANCE_VISITS);
      expect(first.witSteps).toBeLessThanOrEqual(LOVE_MAINTENANCE_WIT_STEPS);
      expect(first.perVisitWrites.every((writes) => writes <= 21)).toBe(true);
      expect(db.one('SELECT rr_frontier FROM forward_deferred_love_maintenance')).toEqual({ rr_frontier: 1 });
      const second = runDeferredLoveMaintenance(db, 11);
      expect(second.writes).toBeLessThanOrEqual(LOVE_MAINTENANCE_WRITES);
      expect(second.visits).toBeLessThanOrEqual(LOVE_MAINTENANCE_VISITS);
      expect(second.perVisitWrites.every((writes) => writes <= 21)).toBe(true);
      expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_intents')).toEqual({ n: 0 });
      expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_heads')).toEqual({ n: 0 });
    });
  });

  it('keeps earlier lane commits and uses the 30 second fallback after a later lane fails', async () => {
    await withMigratedDb((db) => {
      link(db);
      db.run("UPDATE linked_accounts SET backfill_state='done' WHERE id='maintenance-link'");
      const uri = `at://${DID}/com.example.atmusic.love/maintenance`;
      const rev = '3lbcdefghijkm';
      db.run(
        `INSERT INTO forward_deferred_love_maintenance(singleton,next_head_seq,next_authority_seq)
         VALUES(1,2,2)`,
      );
      db.run(
        `INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,head_seq,next_seq,created_at_ms)
         VALUES('maintenance-link',1,'artist','track',1,3,1)`,
      );
      db.run(
        `INSERT INTO forward_deferred_love_authorities(authorization_uri,authorization_rev,authority_seq,action,cid,state,due_seq,created_at_ms)
         VALUES(?,?,1,'delete','','conflicted',1,1)`,
        uri,
        rev,
      );
      for (const [seq, operationId] of [
        [1, 'maintenance-a'],
        [2, 'maintenance-b'],
      ] as const)
        db.run(
          `INSERT INTO forward_deferred_love_intents(link_id,generation,love_artist_key,love_track_key,intent_seq,kind,
             operation_id,origin_class,payload_json,authorization_uri,authorization_rev,intent_at_ms)
           VALUES('maintenance-link',1,'artist','track',?,'unlove',?,'authorized','{}',?,?,1)`,
          seq,
          operationId,
          uri,
          rev,
        );
      const failingDb: Db = {
        all: db.all.bind(db),
        one: db.one.bind(db),
        run(sql, ...params) {
          if (sql.includes('auth_frontier=')) throw new Error('injected auth failure');
          return db.run(sql, ...params);
        },
        tx: (fn) => db.tx(fn),
      };
      const logs: string[] = [];
      const fakeRuntime = {
        db: failingDb,
        random: seededRandom(32),
        log: { log: (_level: string, message: string) => logs.push(message) },
      } as unknown as ForwardRuntime;
      const timer = linkBackfillExtension(() => fakeRuntime).timers?.['link-backfill'];
      const scheduled: number[] = [];
      return timer!(2_000, {
        schedule: (_name, at) => {
          scheduled.push(at);
          return at;
        },
      } as ExtensionContext).then(() => {
        expect(db.one('SELECT operation_id FROM forward_deferred_love_intents ORDER BY intent_seq LIMIT 1')).toEqual({
          operation_id: 'maintenance-b',
        });
        expect(
          db.one("SELECT value FROM counters WHERE name='link_coverage' AND label='deferred_maintenance_inv'"),
        ).toEqual({
          value: 1,
        });
        expect(
          db.one("SELECT value FROM counters WHERE name='link_coverage' AND label='deferred_maintenance_auth'"),
        ).toBeNull();
        expect(scheduled).toEqual([32_000]);
        expect(logs).toContain('forward.deferred_love_maintenance_failed');
      });
    });
  });

  it('finds cancelled heads and old witness groups behind frozen integer cursors after arrivals', async () => {
    await withMigratedDb((db) => {
      link(db);
      db.run(
        `INSERT INTO operations(id,did,kind,origin,priority,collection,state,due_at,created_at_ms,updated_at_ms)
         VALUES('rr-cancel',?,'love.put','web',1,'com.example.atmusic.love','queued',1,1,1)`,
        DID,
      );
      db.run(
        'INSERT INTO forward_deferred_love_maintenance(singleton,next_head_seq,next_group_seq,next_authority_seq) VALUES(1,4,4,1)',
      );
      for (let seq = 1; seq <= 3; seq++) {
        const artist = `artist-${seq}`;
        const track = `track-${seq}`;
        db.run(
          `INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,head_seq,next_seq,created_at_ms)
           VALUES('maintenance-link',1,?,?,?,2,1)`,
          artist,
          track,
          seq,
        );
        db.run(
          `INSERT INTO forward_deferred_love_intents(link_id,generation,love_artist_key,love_track_key,intent_seq,kind,
             operation_id,origin_class,payload_json,intent_at_ms) VALUES('maintenance-link',1,?,?,1,'love',?,'operation','{}',1)`,
          artist,
          track,
          seq === 1 ? 'rr-cancel' : `live-${seq}`,
        );
        db.run(
          `INSERT INTO forward_deferred_love_witnesses(link_id,generation,operation_id,group_seq,kind,love_artist_key,love_track_key,created_at_ms)
           VALUES('maintenance-link',1,?,?,'love',?,?,1)`,
          `old-group-${seq}`,
          seq,
          artist,
          track,
        );
      }
      runDeferredLoveMaintenance(db, 10);
      runDeferredLoveMaintenance(db, 11);
      expect(db.one('SELECT rr_cursor,wit_cursor FROM forward_deferred_love_maintenance')).toEqual({
        rr_cursor: 1,
        wit_cursor: 1,
      });
      db.run("UPDATE operations SET state='cancelled' WHERE id='rr-cancel'");
      db.run("UPDATE linked_accounts SET generation=2 WHERE id='maintenance-link'");
      db.run(
        `INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,head_seq,next_seq,created_at_ms)
         VALUES('maintenance-link',2,'new-artist','new-track',4,2,1)`,
      );
      db.run(
        `INSERT INTO forward_deferred_love_intents(link_id,generation,love_artist_key,love_track_key,intent_seq,kind,operation_id,origin_class,payload_json,intent_at_ms)
         VALUES('maintenance-link',2,'new-artist','new-track',1,'love','new-op','operation','{}',1)`,
      );
      db.run(
        `INSERT INTO forward_deferred_love_witnesses(link_id,generation,operation_id,group_seq,kind,love_artist_key,love_track_key,created_at_ms)
         VALUES('maintenance-link',2,'new-group',4,'love','new-artist','new-track',1)`,
      );
      db.run('UPDATE forward_deferred_love_maintenance SET next_head_seq=5,next_group_seq=5');

      for (let tick = 0; tick < 16; tick++) runDeferredLoveMaintenance(db, 12 + tick);
      expect(db.one("SELECT 1 FROM forward_deferred_love_intents WHERE operation_id='rr-cancel'")).toBeNull();
      expect(
        db.one("SELECT 1 FROM forward_deferred_love_heads WHERE generation=1 AND love_artist_key='artist-1'"),
      ).toBeNull();
      expect(db.one("SELECT 1 FROM forward_deferred_love_witnesses WHERE operation_id='new-group'")).not.toBeNull();
      expect(db.one('SELECT 1 FROM forward_deferred_love_witnesses WHERE generation=1')).toBeNull();
      const state = db.one('SELECT rr_passes,wit_passes,auth_passes FROM forward_deferred_love_maintenance');
      expect(state).toMatchObject({
        rr_passes: expect.any(Number),
        wit_passes: expect.any(Number),
        auth_passes: expect.any(Number),
      });
    });
  });

  it('preserves a nearer retry, does nothing without a runtime, and swallows maintenance-log failure', async () => {
    await withMigratedDb(async (db) => {
      link(db);
      db.run("UPDATE linked_accounts SET backfill_next_attempt_ms=1200 WHERE id='maintenance-link'");
      const scheduled: number[] = [];
      const context = {
        schedule: (_name: string, at: number) => {
          scheduled.push(at);
          return at;
        },
      } as ExtensionContext;
      const nullTimer = linkBackfillExtension(() => null).timers?.['link-backfill'];
      await nullTimer!(1_000, context);
      expect(scheduled).toEqual([]);
      const idleRuntime = {
        db,
        random: seededRandom(33),
        log: { log: () => undefined },
      } as unknown as ForwardRuntime;
      const idleTimer = linkBackfillExtension(() => idleRuntime).timers?.['link-backfill'];
      expect(idleTimer).toBeTypeOf('function');
      await idleTimer!(1_000, context);
      expect(scheduled).toEqual([1_200]);
      db.run(
        "UPDATE linked_accounts SET backfill_state='done',backfill_next_attempt_ms=NULL WHERE id='maintenance-link'",
      );
      const failingDb: Db = {
        all: db.all.bind(db),
        one<T>(sql: string, ...params: SqlParam[]): T | null {
          if (sql.includes('total_changes()')) throw new Error('injected maintenance failure');
          return db.one<T>(sql, ...params);
        },
        run: db.run.bind(db),
        tx: (fn) => db.tx(fn),
      };
      const logFailureRuntime = {
        db: failingDb,
        random: seededRandom(34),
        log: {
          log: () => {
            throw new Error('injected logger failure');
          },
        },
      } as unknown as ForwardRuntime;
      const failureTimer = linkBackfillExtension(() => logFailureRuntime).timers?.['link-backfill'];
      expect(failureTimer).toBeTypeOf('function');
      await failureTimer!(2_000, context);
      expect(scheduled).toEqual([1_200, 32_000]);
    });
  });

  it('preserves the database across reopen and runs maintenance from the real backfill timer finally', async () => {
    await withMigratedDb((initial, _ctx) => {
      link(initial);
      initial.run('INSERT INTO forward_deferred_love_maintenance(singleton,next_group_seq) VALUES(1,2)');
      const db = reopen(initial);
      const scheduled: number[] = [];
      const fakeRuntime = {
        db,
        random: seededRandom(31),
        log: { log: () => undefined },
      } as unknown as ForwardRuntime;
      const extension = linkBackfillExtension(() => fakeRuntime) as CoreExtension;
      const timer = extension.timers?.['link-backfill'];
      expect(timer).toBeTypeOf('function');
      return timer!(1_000, {
        schedule: (_name, at) => {
          scheduled.push(at);
          return at;
        },
      } as ExtensionContext).then(() => {
        expect(scheduled).toEqual([31_000]);
        expect(db.one('SELECT updated_at_ms FROM forward_deferred_love_maintenance')).toEqual({ updated_at_ms: 1_000 });
        db.run("UPDATE linked_accounts SET generation=2 WHERE id='maintenance-link'");
        db.run(
          `INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,head_seq,maintenance_seq,created_at_ms)
           VALUES('maintenance-link',1,'old-artist','old-track',1,1,1)`,
        );
        return timer!(31_000, {
          schedule: (_name, at) => {
            scheduled.push(at);
            return at;
          },
        } as ExtensionContext).then(() => {
          expect(db.one('SELECT 1 AS present FROM forward_deferred_love_heads WHERE generation=1')).toBeNull();
          expect(scheduled).toEqual([31_000, 32_000]);
        });
      });
    });
  });
});
