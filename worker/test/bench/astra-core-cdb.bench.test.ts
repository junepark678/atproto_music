import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import type { ForwardRuntime } from '../../src/forward/forwarder';
import { reclaimLoveApiProofRows } from '../../src/forward/love-api-maintenance';
import { materializeLoveApiRecipientDecisions } from '../../src/forward/love-api-materializer';
import { prepareLoveApiRecipientHandoff, sealLoveApiDirectAbsence } from '../../src/forward/love-api-recipients';
import {
  assertLoveApiDecisionBudget,
  assertLoveApiInvocationBudget,
  runLoveApiMaintenance,
} from '../../src/forward/love-api-scheduler';
import { withMigratedDb } from '../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
  REV = '3lbcdefghijmu';
type Maintenance = ReturnType<typeof runLoveApiMaintenance>;
function seed(db: Db, n: number, pending = 0) {
  db.run(
    `INSERT INTO love_api_proof_state(singleton,next_binding_seq,next_aggregate_seq,next_fact_seq) VALUES(1,?,?,?)`,
    n + 1,
    n + 1,
    n + 1,
  );
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,forward_scrobbles,backfill_state,created_at_ms,updated_at_ms) VALUES('link',?,'lastfm','remote',X'00','e1',1,'active',0,'done',1,1)`,
    DID,
  );
  for (let i = 1; i <= n; i++) {
    const uri = `at://${DID}/com.example.atmusic.love/r${i}`,
      inc = `inc${i}`,
      op = `op${i}`,
      artist = 'Artist',
      track = `Track ${i}`;
    const [a, t] = trackKey(artist, track);
    db.run(`INSERT INTO love_api_bindings VALUES(?,?,'web',?,?,?,1)`, DID, op, uri, inc, i);
    db.run(
      `INSERT INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,sent_operation_id,created_at_ms,updated_at_ms) VALUES(?,?,?,'link',1,?,'sealed',?,1,1)`,
      DID,
      uri,
      inc,
      i,
      op,
    );
    db.run(
      `INSERT INTO love_incarnations(uri,incarnation_key,state,path,updated_at_ms) VALUES(?,?,'absent','api',1)`,
      uri,
      inc,
    );
    db.run(`INSERT INTO love_api_comparison_facts VALUES(?,?,?,'delete','',10000,0,1)`, uri, REV, i);
    db.run(
      `INSERT INTO love_api_unlove_decisions(did,uri,incarnation_key,link_id,generation,artist,track,artist_key,track_key,payload_json,authorization_uri,authorization_rev,fact_action,fact_cid,expires_at_ms,due_at_ms,created_at_ms) VALUES(?,?,?,'link',1,?,?,?,?,?,?,?,'delete','',10000,1,1)`,
      DID,
      uri,
      inc,
      artist,
      track,
      a,
      t,
      JSON.stringify({ artist, track, origin: 'web' }),
      uri,
      REV,
    );
    for (let j = 1; j <= pending; j++)
      db.run(
        `INSERT INTO love_api_recipient_members VALUES('link',1,?,?,?,?,?,1)`,
        `pending-${i}-${j}`,
        DID,
        uri,
        inc,
        j,
      );
  }
}
const total = (db: Db) => db.one<{ n: number }>('SELECT total_changes() n')!.n;
it('trips the production invocation and decision budget guards at each bound', () => {
  expect(() => assertLoveApiInvocationBudget(97n, 0)).toThrow(/changed-row bound exceeded/);
  expect(() => assertLoveApiInvocationBudget(96n, 17)).toThrow(/visit bound exceeded/);
  expect(() => assertLoveApiDecisionBudget(129, 0n)).toThrow(/DECISION read bound exceeded/);
  expect(() => assertLoveApiDecisionBudget(128, 29n)).toThrow(/DECISION unit exceeded 28 changed rows/);
});
it.each([1, 8])('enforces combined invocation budget count=%i', async (n) =>
  withMigratedDb((db) => {
    seed(db, n);
    if (n === 1) db.run('DELETE FROM love_api_proof_state');
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms) SELECT authorization_uri,authorization_rev,action,cid,1,10000 FROM love_api_comparison_facts`,
    );
    let acknowledgements = 0;
    const traces = [] as Array<{
      writes: number;
      visits: number;
      reads: number;
      decisions: Record<string, number>;
      transactions: Maintenance['transactions'];
      units: Maintenance['lanes'];
    }>;
    for (let invocation = 0; invocation < n + 8 && acknowledgements < n; invocation++) {
      const before = total(db);
      const result = runLoveApiMaintenance(db, 100, seededRandom(5), 'audit');
      const observed = total(db) - before;
      expect(result.writes).toBe(observed);
      expect(observed).toBeLessThanOrEqual(96);
      expect(result.visits).toBeLessThanOrEqual(16);
      expect(result.lanes.filter((unit) => unit.lane === 'decision').every((unit) => unit.reads <= 128)).toBe(true);
      expect(result.lanes.filter((unit) => unit.lane === 'decision').every((unit) => unit.work <= 28)).toBe(true);
      acknowledgements += result.decisions.queued + result.decisions.deferred + result.decisions.replay;
      traces.push({
        writes: result.writes,
        visits: result.visits,
        reads: result.reads,
        decisions: result.decisions,
        transactions: result.transactions,
        units: result.lanes,
      });
    }
    console.log('L2_INVOCATION_MATRIX', JSON.stringify({ n, traces, acknowledgements }));
    expect(acknowledgements).toBe(n);
  }),
);
it('charges complete eight-decision and eight-orphan maintenance across shared invocation limits', async () =>
  withMigratedDb((db) => {
    seed(db, 8);
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
       SELECT authorization_uri,authorization_rev,action,cid,1,10000 FROM love_api_comparison_facts`,
    );
    for (let i = 1; i <= 8; i++)
      db.run(
        `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
        VALUES(?,?,'web',?,?,?,1)`,
        DID,
        `orphan-${i}`,
        `at://${DID}/com.example.atmusic.love/orphan${i}`,
        `orphan-inc-${i}`,
        8 + i,
      );
    const observations: Array<{ writes: number; visits: number; reads: number; decisions: number; reclaim: number }> =
      [];
    let acknowledgements = 0;
    for (let invocation = 0; invocation < 20; invocation++) {
      const before = total(db);
      const result = runLoveApiMaintenance(db, 100 + invocation, seededRandom(5), 'audit');
      const writes = total(db) - before;
      expect(result.writes).toBe(writes);
      expect(writes).toBeLessThanOrEqual(96);
      expect(result.visits).toBeLessThanOrEqual(16);
      expect(
        result.lanes.filter((unit) => unit.lane === 'decision').every((unit) => unit.work <= 28 && unit.reads <= 128),
      ).toBe(true);
      acknowledgements += result.decisions.queued + result.decisions.deferred + result.decisions.replay;
      observations.push({
        writes,
        visits: result.visits,
        reads: result.reads,
        decisions:
          result.decisions.queued + result.decisions.deferred + result.decisions.replay + result.decisions.refused,
        reclaim: result.reclaimUnits,
      });
      if (
        db.one('SELECT 1 FROM love_api_unlove_decisions LIMIT 1') === null &&
        db.one("SELECT 1 FROM love_api_bindings WHERE operation_id LIKE 'orphan-%' LIMIT 1") === null
      )
        break;
    }
    console.log('L2_EIGHT_DECISION_ORPHAN_BOUNDARY', JSON.stringify(observations));
    expect(db.one('SELECT 1 FROM love_api_unlove_decisions LIMIT 1')).toBeNull();
    expect(db.one("SELECT 1 FROM love_api_bindings WHERE operation_id LIKE 'orphan-%' LIMIT 1")).toBeNull();
    expect(acknowledgements).toBe(8);
  }));
it('expires pending decision before awaiting its member', async () =>
  withMigratedDb((db) => {
    seed(db, 1, 1);
    db.run('UPDATE love_api_comparison_facts SET horizon_ms=50');
    db.run('UPDATE love_api_unlove_decisions SET expires_at_ms=50');
    const m = materializeLoveApiRecipientDecisions(db, 100, seededRandom(5), 'audit');
    expect(m.expired).toBe(1);
    for (let tick = 0; tick < 8 && db.one('SELECT 1 FROM love_api_recipient_members') !== null; tick++)
      runLoveApiMaintenance(db, 100 + tick, seededRandom(5), 'audit');
    expect(db.one('SELECT 1 FROM love_api_recipient_members')).toBeNull();
    expect(db.one('SELECT 1 FROM love_api_recipients')).toBeNull();
  }));

it('releases stale generations through the aggregate cursor while preserving a live current generation', async () =>
  withMigratedDb((db) => {
    seed(db, 1, 1);
    db.run("UPDATE linked_accounts SET generation=2 WHERE id='link'");
    db.run("UPDATE love_incarnations SET state='absent' WHERE uri=?", `at://${DID}/com.example.atmusic.love/r1`);
    db.run(
      `INSERT INTO love_incarnations(uri,incarnation_key,state,path,updated_at_ms)
       VALUES(?,'inc-current','present','api',1)`,
      `at://${DID}/com.example.atmusic.love/current`,
    );
    db.run(
      `INSERT INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,created_at_ms,updated_at_ms)
       VALUES(?,?,'inc-current','link',2,2,'present',1,1)`,
      DID,
      `at://${DID}/com.example.atmusic.love/current`,
    );
    db.run(
      `INSERT INTO love_api_recipient_members(link_id,generation,operation_id,did,uri,incarnation_key,member_seq,created_at_ms)
       VALUES('link',1,'old-member',?,?,?,2,1)`,
      DID,
      `at://${DID}/com.example.atmusic.love/r1`,
      'inc1',
    );
    for (let tick = 0; tick < 12; tick++) runLoveApiMaintenance(db, 100 + tick, seededRandom(5), 'audit');
    expect(db.one('SELECT 1 FROM love_api_recipients WHERE generation=1')).toBeNull();
    expect(db.one("SELECT 1 FROM love_api_recipient_members WHERE operation_id='old-member'")).toBeNull();
    expect(db.one('SELECT state FROM love_api_recipients WHERE generation=2')).toEqual({ state: 'present' });
  }));
it('reclaims an initialized eight-binding page with measured changes', async () =>
  withMigratedDb((db) => {
    seed(db, 8);
    db.run('DELETE FROM love_api_unlove_decisions');
    db.run('DELETE FROM love_api_recipients');
    const before = total(db);
    const r = reclaimLoveApiProofRows(db, 100);
    const changed = total(db) - before;
    expect(r.visited).toBe(8);
    expect(changed).toBe(9);
  }));
it('audit mismatched replay must shorten stored decision', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    const ok = sealLoveApiDirectAbsence(
      db,
      {
        did: DID,
        uri,
        incarnationKey: 'inc1',
        rev: REV,
        action: 'delete',
        cid: '',
        horizonMs: 50,
        nowMs: 30,
        recipients: [
          {
            linkId: 'link',
            generation: 1,
            sentOperationId: 'op1',
            sentOrigin: 'web',
            pendingApiOperationId: null,
            pendingApiOrigin: null,
            hasPendingMembers: false,
          },
        ],
      },
      { artist: 'Changed', track: 'Track 1', album: null, recordingMbid: null },
    );
    expect(ok).toBe(false);
    expect(
      db.one<{ expires_at_ms: number }>('SELECT expires_at_ms FROM love_api_unlove_decisions')!.expires_at_ms,
    ).toBe(50);
  }));

it('audit retained fact without A2 source still authorizes handoff', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    const candidate = {
      did: DID,
      uri: `at://${DID}/com.example.atmusic.love/r1`,
      incarnationKey: 'inc1',
      linkId: 'link',
      generation: 1,
    };
    expect(prepareLoveApiRecipientHandoff(db, candidate, 'audit', 100).status).toBe('ready');
    const m = materializeLoveApiRecipientDecisions(db, 100, seededRandom(5), 'audit');
    expect(m.deferred).toBe(1);
  }));
it('audit expired no-pending control', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    db.run('UPDATE love_api_comparison_facts SET horizon_ms=50');
    db.run('UPDATE love_api_unlove_decisions SET expires_at_ms=50');
    expect(materializeLoveApiRecipientDecisions(db, 100, seededRandom(5), 'audit').expired).toBe(1);
  }));

it('rolls back actual decision cascade amplification before the decision commit', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    db.run('CREATE TABLE l2_meter_amplifier(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)');
    for (let i = 1; i <= 40; i++) db.run('INSERT INTO l2_meter_amplifier VALUES(?,0)', i);
    db.run(`INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
      SELECT authorization_uri,authorization_rev,action,cid,1,10000 FROM love_api_comparison_facts`);
    const outboxBefore = db.one<{ n: number }>('SELECT count(*) AS n FROM forward_outbox')!.n;
    let injected = false;
    const amplified: Db = {
      all: <T>(sql: string, ...params: SqlParam[]) => db.all<T>(sql, ...params),
      one: <T>(sql: string, ...params: SqlParam[]) => db.one<T>(sql, ...params),
      run: (sql: string, ...params: SqlParam[]) => {
        const result = db.run(sql, ...params);
        if (!injected && sql.includes("UPDATE love_api_recipients SET state='released'")) {
          injected = true;
          db.run('UPDATE l2_meter_amplifier SET value=value+1');
        }
        return result;
      },
      tx: <T>(fn: () => T extends Promise<unknown> ? never : T) => db.tx(fn),
    };
    expect(() => runLoveApiMaintenance(amplified, 100, seededRandom(5), 'audit')).toThrow(
      /DECISION unit exceeded 28 changed rows/,
    );
    expect(injected).toBe(true);
    expect(db.one<{ state: string }>('SELECT state FROM love_api_recipients')!.state).toBe('sealed');
    expect(db.one<{ n: number }>('SELECT count(*) AS n FROM love_api_unlove_decisions')!.n).toBe(1);
    expect(db.one<{ n: number }>('SELECT sum(value) AS n FROM l2_meter_amplifier')!.n).toBe(0);
    expect(db.one<{ n: number }>('SELECT count(*) AS n FROM forward_outbox')!.n).toBe(outboxBefore);
  }));
it('audit metadata-only timer should wait thirty seconds', async () =>
  withMigratedDb(async (db) => {
    seed(db, 1, 1);
    const { linkBackfillExtension } = await import('../../src/forward/backfill');
    const runtime = { db, random: seededRandom(3), log: { log() {} } } as unknown as ForwardRuntime;
    const ext = linkBackfillExtension(() => runtime);
    const schedules: Array<[string, number, { force: boolean }?]> = [];
    const timerContext = {
      schedule: (name: string, at: number, options?: { force: boolean }) => schedules.push([name, at, options]),
    };
    await ext.timers!['link-backfill']!(100, timerContext as never);
    expect(schedules.at(-1)?.[1]).toBe(30100);
  }));

it('audit useful L2 decision mutation should schedule a one-second wake', async () =>
  withMigratedDb(async (db) => {
    seed(db, 1);
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
       SELECT authorization_uri,authorization_rev,action,cid,1,10000 FROM love_api_comparison_facts`,
    );
    const { linkBackfillExtension } = await import('../../src/forward/backfill');
    const runtime = { db, random: seededRandom(3), log: { log() {} } } as unknown as ForwardRuntime;
    const ext = linkBackfillExtension(() => runtime);
    const schedules: Array<[string, number, { force: boolean }?]> = [];
    const timerContext = {
      schedule: (name: string, at: number, options?: { force: boolean }) => schedules.push([name, at, options]),
    };
    await ext.timers!['link-backfill']!(100, timerContext as never);
    expect(db.one('SELECT 1 FROM love_api_unlove_decisions')).toBeNull();
    expect(db.one('SELECT 1 FROM love_api_recipients')).toBeNull();
    expect(schedules.at(-1)?.[1]).toBe(1100);
  }));

it('audit L2 failure after a committed B2 lane preserves its work and the earlier backfill deadline', async () =>
  withMigratedDb(async (db) => {
    const { linkBackfillExtension } = await import('../../src/forward/backfill');
    seed(db, 1);
    db.run('DELETE FROM love_api_proof_state');
    db.run(
      "UPDATE linked_accounts SET forward_scrobbles=1,backfill_state='pending',backfill_next_attempt_ms=5100 WHERE id='link'",
    );
    db.run(
      `INSERT INTO forward_deferred_love_maintenance(singleton,next_head_seq,lane_turn)
       VALUES(1,2,2)`,
    );
    const failed: Db = {
      all: <T>(sql: string, ...params: SqlParam[]) => db.all<T>(sql, ...params),
      one: <T>(sql: string, ...params: SqlParam[]) => db.one<T>(sql, ...params),
      run: (sql: string, ...params: SqlParam[]) => {
        if (sql.startsWith('INSERT OR IGNORE INTO love_api_proof_state')) throw new Error('injected L2 lane failure');
        return db.run(sql, ...params);
      },
      tx: <T>(fn: () => T extends Promise<unknown> ? never : T) => db.tx(fn),
    };
    const runtime = { db: failed, random: seededRandom(3), log: { log() {} } } as unknown as ForwardRuntime;
    const ext = linkBackfillExtension(() => runtime);
    const schedules: number[] = [];
    await ext.timers!['link-backfill']!(100, {
      schedule: (_name: string, at: number) => schedules.push(at),
    } as never);
    expect(db.one('SELECT rr_cursor,rr_frontier,rr_passes FROM forward_deferred_love_maintenance')).toEqual({
      rr_cursor: 0,
      rr_frontier: 1,
      rr_passes: 1,
    });
    expect(db.one('SELECT 1 FROM love_api_proof_state WHERE singleton=1')).toBeNull();
    expect(schedules.at(-1)).toBe(5100);
  }));
