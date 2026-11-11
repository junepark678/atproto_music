import { spawnSync } from 'node:child_process';
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import type { ForwardRuntime } from '../../src/forward/forwarder';
import { reclaimLoveApiProofRows } from '../../src/forward/love-api-maintenance';
import { materializeLoveApiRecipientDecisions } from '../../src/forward/love-api-materializer';
import {
  prepareLoveApiDirectAbsence,
  prepareLoveApiRecipientHandoff,
  sealLoveApiDirectAbsence,
} from '../../src/forward/love-api-recipients';
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
  expect(() => assertLoveApiInvocationBudget(96n, 16)).not.toThrow();
  expect(() => assertLoveApiInvocationBudget(97n, 0)).toThrow(/changed-row bound exceeded/);
  expect(() => assertLoveApiInvocationBudget(96n, 17)).toThrow(/visit bound exceeded/);
  expect(() => assertLoveApiDecisionBudget(128, 28n)).not.toThrow();
  expect(() => assertLoveApiDecisionBudget(129, 0n)).toThrow(/DECISION read bound exceeded/);
  expect(() => assertLoveApiDecisionBudget(128, 29n)).toThrow(/DECISION unit exceeded 28 changed rows/);
});

const injectDecisionReads =
  (count: number) =>
  (db: Db): void => {
    for (let index = 0; index < count; index++) {
      expect(db.one<{ probe: number }>('SELECT 1 AS probe')).toEqual({ probe: 1 });
    }
  };

it('commits an actual decision at 128 full-transaction reads, including all meter and finalization SQL', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
       SELECT authorization_uri,authorization_rev,action,cid,1,10000 FROM love_api_comparison_facts`,
    );
    // Frozen full-transaction baseline: 63 production reads including both
    // total_changes() endpoints, coverage accounting and the final report meter.
    const result = runLoveApiMaintenance(db, 100, seededRandom(5), 'audit', injectDecisionReads(65));
    const decision = result.lanes.find((unit) => unit.lane === 'decision');
    const transaction = result.transactions.find((unit) => unit.phase === 'l2-decision');
    expect(decision).toMatchObject({ reads: 128, visits: 1 });
    expect(transaction).toMatchObject({ reads: 128, changedRows: decision!.changedRows });
    expect(decision!.returnedRows).toBeGreaterThanOrEqual(65);
    expect(result.decisions.deferred).toBe(1);
    expect(db.one('SELECT 1 FROM love_api_unlove_decisions')).toBeNull();
  }));

it('rolls back a whole decision when its actual metered SQL reaches 129 reads', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
       SELECT authorization_uri,authorization_rev,action,cid,1,10000 FROM love_api_comparison_facts`,
    );
    const beforeOutbox = db.one<{ count: number }>('SELECT count(*) AS count FROM forward_outbox')!.count;
    const beforeCoverage = db.all("SELECT name,label,value FROM counters WHERE name='link_coverage' ORDER BY label");
    expect(() => runLoveApiMaintenance(db, 100, seededRandom(5), 'audit', injectDecisionReads(66))).toThrow(
      /L2 DECISION read bound exceeded: 129\/128/,
    );
    expect(db.one<{ state: string }>('SELECT state FROM love_api_recipients')).toEqual({ state: 'sealed' });
    expect(db.one('SELECT 1 FROM love_api_unlove_decisions')).not.toBeNull();
    expect(db.one<{ count: number }>('SELECT count(*) AS count FROM forward_outbox')!.count).toBe(beforeOutbox);
    expect(db.one('SELECT 1 FROM forward_deferred_love_authorities')).toBeNull();
    expect(db.all("SELECT name,label,value FROM counters WHERE name='link_coverage' ORDER BY label")).toEqual(
      beforeCoverage,
    );
    expect(db.one<{ lane_turn: number }>('SELECT lane_turn FROM love_api_proof_state WHERE singleton=1')).toEqual({
      lane_turn: 0,
    });
  }));

it('keeps cold singleton initialization separately metered while bounding the cold decision transaction', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    db.run('DELETE FROM love_api_proof_state');
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
       SELECT authorization_uri,authorization_rev,action,cid,1,10000 FROM love_api_comparison_facts`,
    );
    const accepted = runLoveApiMaintenance(db, 100, seededRandom(5), 'cold-boundary', injectDecisionReads(65));
    expect(accepted.transactions.find((row) => row.phase === 'l2-cold-singleton-init')).toMatchObject({
      changedRows: 1,
      visits: 0,
    });
    expect(accepted.transactions.find((row) => row.phase === 'l2-decision')).toMatchObject({
      reads: 128,
      visits: 1,
    });
    expect(accepted.decisions.deferred).toBe(1);
  }));

it('rolls back an over-bound cold decision after separately committing singleton initialization', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    db.run('DELETE FROM love_api_proof_state');
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
       SELECT authorization_uri,authorization_rev,action,cid,1,10000 FROM love_api_comparison_facts`,
    );
    const beforeOutbox = db.one<{ count: number }>('SELECT count(*) AS count FROM forward_outbox')!.count;
    const beforeDecision = db.all('SELECT * FROM love_api_unlove_decisions');
    expect(() => runLoveApiMaintenance(db, 100, seededRandom(5), 'cold-over-bound', injectDecisionReads(66))).toThrow(
      /L2 DECISION read bound exceeded: 129\/128/,
    );
    expect(db.one<{ state: string }>('SELECT state FROM love_api_recipients')).toEqual({ state: 'sealed' });
    expect(db.all('SELECT * FROM love_api_unlove_decisions')).toEqual(beforeDecision);
    expect(db.one<{ count: number }>('SELECT count(*) AS count FROM forward_outbox')!.count).toBe(beforeOutbox);
    expect(db.one<{ lane_turn: number }>('SELECT lane_turn FROM love_api_proof_state WHERE singleton=1')).toEqual({
      lane_turn: 0,
    });
  }));

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
      if (n === 1 && invocation === 0)
        expect(result.transactions.find((transaction) => transaction.phase === 'l2-cold-singleton-init')).toMatchObject(
          {
            reads: 2,
            mutationStatements: 1,
            changedRows: 1,
          },
        );
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
    const observations: Array<{
      writes: number;
      visits: number;
      reads: number;
      decisions: number;
      reclaim: number;
      transactions: Maintenance['transactions'];
      units: Maintenance['lanes'];
    }> = [];
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
        transactions: result.transactions,
        units: result.lanes,
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
it('rolls back a production reclaim page when its actual row scan exceeds reserved visits', async () =>
  withMigratedDb((db) => {
    seed(db, 0);
    for (let i = 1; i <= 6; i++)
      db.run(
        `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
         VALUES(?,?,'web',?,?,?,1)`,
        DID,
        `overvisit-${i}`,
        `at://${DID}/com.example.atmusic.love/overvisit${i}`,
        `overvisit-inc-${i}`,
        i,
      );
    const exceeded: Db = {
      all: <T>(sql: string, ...params: SqlParam[]) => {
        if (sql.includes('SELECT did,operation_id,uri,incarnation_key,binding_seq FROM love_api_bindings')) {
          const [cursor, frontier, limit] = params;
          if (typeof cursor === 'number' && typeof frontier === 'number' && typeof limit === 'number')
            return db.all<T>(sql, cursor, frontier, limit + 1);
        }
        return db.all<T>(sql, ...params);
      },
      one: <T>(sql: string, ...params: SqlParam[]) => db.one<T>(sql, ...params),
      run: (sql: string, ...params: SqlParam[]) => db.run(sql, ...params),
      tx: <T>(fn: () => T extends Promise<unknown> ? never : T) => db.tx(fn),
    };
    expect(() => runLoveApiMaintenance(exceeded, 100, seededRandom(5), 'audit')).toThrow(
      /L2 RECLAIM visit bound exceeded: 6\/5/,
    );
    expect(
      db.one<{ n: number }>("SELECT count(*) AS n FROM love_api_bindings WHERE operation_id LIKE 'overvisit-%'"),
    ).toEqual({ n: 6 });
    expect(
      db.one<{ cursor: number; frontier: number }>(
        'SELECT binding_cursor AS cursor,binding_frontier AS frontier FROM love_api_proof_state WHERE singleton=1',
      ),
    ).toEqual({ cursor: 0, frontier: 0 });
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
    for (let tick = 0; tick < 36; tick++) runLoveApiMaintenance(db, 100 + tick, seededRandom(5), 'audit');
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

it('retains a binding through any same-incarnation decision, then releases it in bounded reclaim', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    db.run("UPDATE love_api_recipients SET state='released',sent_operation_id=NULL");
    reclaimLoveApiProofRows(db, 100);
    expect(db.one("SELECT 1 FROM love_api_bindings WHERE operation_id='op1'")).not.toBeNull();
    expect(db.one('SELECT 1 FROM love_api_unlove_decisions')).not.toBeNull();
    db.run('DELETE FROM love_api_unlove_decisions');
    for (let pass = 0; pass < 6; pass++) reclaimLoveApiProofRows(db, 100 + pass);
    expect(db.one("SELECT 1 FROM love_api_bindings WHERE operation_id='op1'")).toBeNull();
  }));

it('bounds production binding-delete work for matching old-generation history at 100/1k/10k', () => {
  const result = spawnSync('python3', ['worker/test/bench/love-api-binding-delete-growth.py'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const traces = JSON.parse(result.stdout) as Array<{
    decisions: number;
    matching: { vm_steps: number; deleted: number };
    nonmatching: { vm_steps: number; deleted: number };
    oldMatching: { vm_steps: number; deleted: number };
  }>;
  expect(traces.map((trace) => trace.decisions)).toEqual([100, 1000, 10000]);
  expect(traces.at(-1)!.matching.vm_steps).toBeLessThanOrEqual(traces[0]!.matching.vm_steps * 2);
  expect(traces.at(-1)!.nonmatching.vm_steps).toBeLessThanOrEqual(traces[0]!.nonmatching.vm_steps * 2);
  expect(traces.at(-1)!.oldMatching.vm_steps).toBeGreaterThan(traces[0]!.oldMatching.vm_steps * 50);
});
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
    expect(db.one<{ artist: string; track: string }>('SELECT artist,track FROM love_api_unlove_decisions')).toEqual({
      artist: 'Artist',
      track: 'Track 1',
    });
    expect(db.one<{ conflicted: number }>('SELECT conflicted FROM love_api_comparison_facts')).toEqual({
      conflicted: 0,
    });
    expect(
      sealLoveApiDirectAbsence(
        db,
        {
          did: DID,
          uri,
          incarnationKey: 'inc1',
          rev: REV,
          action: 'delete',
          cid: '',
          horizonMs: 500,
          nowMs: 40,
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
        { artist: 'Artist', track: 'Track 1', album: null, recordingMbid: null },
      ),
    ).toBe(true);
    expect(
      db.one<{ expires_at_ms: number; payload_json: string }>(
        'SELECT expires_at_ms,payload_json FROM love_api_unlove_decisions',
      ),
    ).toEqual({
      expires_at_ms: 50,
      payload_json: JSON.stringify({ artist: 'Artist', track: 'Track 1', origin: 'web' }),
    });
    expect(db.one<{ conflicted: number }>('SELECT conflicted FROM love_api_comparison_facts')).toEqual({
      conflicted: 0,
    });
  }));

it('persists retained-fact minimum before refusing a mismatched direct replay', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run('UPDATE love_api_comparison_facts SET horizon_ms=50');
    db.run(
      `INSERT INTO live_record_evidence(uri,did,collection,rkey,up_rev,up_action,up_cid,del_rev,conflict_rev,received_ms,expires_at_ms)
       VALUES(?,?,?,'r1',NULL,NULL,NULL,?,NULL,1,500)`,
      uri,
      DID,
      'com.example.atmusic.love',
      REV,
    );
    const prepared = prepareLoveApiDirectAbsence(db, {
      did: DID,
      uri,
      incarnationKey: 'inc1',
      rev: REV,
      nowMs: 30,
    });
    expect(prepared).not.toBeNull();
    if (prepared === null || prepared === 'conflicted') throw new Error('direct fact preparation failed');
    expect(prepared.horizonMs).toBe(50);
    expect(
      sealLoveApiDirectAbsence(db, prepared, {
        artist: 'Payload mismatch',
        track: 'Track 1',
        album: null,
        recordingMbid: null,
      }),
    ).toBe(false);
    expect(db.one<{ expires_at_ms: number }>('SELECT expires_at_ms FROM love_api_unlove_decisions')).toEqual({
      expires_at_ms: 50,
    });
    expect(
      db.one<{ horizon_ms: number; conflicted: number }>('SELECT horizon_ms,conflicted FROM love_api_comparison_facts'),
    ).toEqual({
      horizon_ms: 50,
      conflicted: 0,
    });
    const widerReplay = prepareLoveApiDirectAbsence(db, {
      did: DID,
      uri,
      incarnationKey: 'inc1',
      rev: REV,
      nowMs: 40,
    });
    expect(widerReplay).not.toBeNull();
    if (widerReplay === null || widerReplay === 'conflicted') throw new Error('wider direct replay preparation failed');
    expect(widerReplay.horizonMs).toBe(50);
    expect(
      sealLoveApiDirectAbsence(db, widerReplay, {
        artist: 'Artist',
        track: 'Track 1',
        album: null,
        recordingMbid: null,
      }),
    ).toBe(true);
    expect(db.one<{ expires_at_ms: number }>('SELECT expires_at_ms FROM love_api_unlove_decisions')).toEqual({
      expires_at_ms: 50,
    });
  }));

it('validates owned pending members by durable cursor before awaiting a selected SENT proof', async () =>
  withMigratedDb((db) => {
    seed(db, 1, 1);
    let accepted = 0;
    for (let tick = 0; tick < 8; tick++) {
      const result = runLoveApiMaintenance(db, 100 + tick * 1_000, seededRandom(5), 'audit');
      accepted += result.decisions.queued + result.decisions.deferred + result.decisions.replay;
    }
    expect(db.one('SELECT 1 FROM love_api_recipient_members')).toBeNull();
    expect(accepted).toBe(1);
    expect(db.one('SELECT 1 FROM love_api_recipients')).toBeNull();
  }));

it('keeps a genuinely queued, exactly bound member awaiting during cursor validation', async () =>
  withMigratedDb((db) => {
    seed(db, 1, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run(
      `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
       VALUES(?,'pending-1-1','web',?,'inc1',2,1)`,
      DID,
      uri,
    );
    db.run(
      `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,generation)
       VALUES('queued-member','link',?,'love','pending-1-1','{}','queued',0,1,1,1,1)`,
      DID,
    );
    for (let tick = 0; tick < 8; tick++) runLoveApiMaintenance(db, 100 + tick, seededRandom(5), 'audit');
    expect(db.one('SELECT operation_id FROM love_api_recipient_members')).toEqual({ operation_id: 'pending-1-1' });
    expect(db.one('SELECT 1 FROM love_api_unlove_decisions')).not.toBeNull();
    expect(db.one('SELECT sent_operation_id FROM love_api_recipients')).toEqual({ sent_operation_id: 'op1' });
  }));

it('promotes an exact API SENT member before handoff and accepts it on the following pass', async () =>
  withMigratedDb((db) => {
    seed(db, 1, 1);
    db.run('UPDATE love_api_recipients SET sent_operation_id=NULL');
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run(
      `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
       VALUES(?,'pending-1-1','web',?,'inc1',2,1)`,
      DID,
      uri,
    );
    db.run(
      `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,generation)
       VALUES('sent-member','link',?,'love','pending-1-1','{}','sent',1,1,1,1,1)`,
      DID,
    );
    runLoveApiMaintenance(db, 100, seededRandom(5), 'audit');
    expect(db.one('SELECT sent_operation_id FROM love_api_recipients')).toEqual({ sent_operation_id: 'pending-1-1' });
    expect(db.one('SELECT 1 FROM love_api_recipient_members')).toBeNull();
    let accepted = 0;
    for (let tick = 0; tick < 7; tick++) {
      const result = runLoveApiMaintenance(db, 1_100 + tick * 1_000, seededRandom(5), 'audit');
      accepted += result.decisions.queued + result.decisions.deferred + result.decisions.replay;
    }
    expect(accepted).toBe(1);
  }));

it('discards a failed pending member without treating it as positive API delivery', async () =>
  withMigratedDb((db) => {
    seed(db, 1, 1);
    db.run('UPDATE love_api_recipients SET sent_operation_id=NULL');
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run(
      `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
       VALUES(?,'pending-1-1','web',?,'inc1',2,1)`,
      DID,
      uri,
    );
    db.run(
      `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,generation)
       VALUES('failed-member','link',?,'love','pending-1-1','{}','failed',1,1,1,1,1)`,
      DID,
    );
    let accepted = 0;
    for (let tick = 0; tick < 8; tick++) {
      const result = runLoveApiMaintenance(db, 100 + tick * 1_000, seededRandom(5), 'audit');
      accepted += result.decisions.queued + result.decisions.deferred + result.decisions.replay;
    }
    expect(accepted).toBe(0);
    expect(db.one('SELECT 1 FROM love_api_recipient_members')).toBeNull();
    expect(db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove'")).toBeNull();
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

it.each(['coverage counter', 'lane turn'])('rolls back actual %s metadata amplification', async (target) =>
  withMigratedDb((db) => {
    seed(db, 1);
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
       SELECT authorization_uri,authorization_rev,action,cid,1,10000 FROM love_api_comparison_facts`,
    );
    db.run('CREATE TABLE l2_metadata_amplifier(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)');
    for (let id = 1; id <= 40; id++) db.run('INSERT INTO l2_metadata_amplifier VALUES(?,0)', id);
    if (target === 'coverage counter')
      db.raw.exec(`CREATE TRIGGER l2_metadata_amplify AFTER INSERT ON counters
        WHEN NEW.name='link_coverage' AND NEW.label='api_love_maintenance_decision'
        BEGIN UPDATE l2_metadata_amplifier SET value=value+1; END`);
    else
      db.raw.exec(`CREATE TRIGGER l2_metadata_amplify AFTER UPDATE OF lane_turn ON love_api_proof_state
        BEGIN UPDATE l2_metadata_amplifier SET value=value+1; END`);

    if (target === 'coverage counter') {
      expect(() => runLoveApiMaintenance(db, 100, seededRandom(5), 'audit')).toThrow(
        /L2 coverage counter exceeded metadata reservation/,
      );
      expect(db.one("SELECT 1 FROM counters WHERE name='link_coverage'")).toBeNull();
      expect(db.one<{ state: string }>('SELECT state FROM love_api_recipients')).toEqual({ state: 'sealed' });
      expect(db.one('SELECT 1 FROM love_api_unlove_decisions')).not.toBeNull();
    } else {
      expect(() => runLoveApiMaintenance(db, 100, seededRandom(5), 'audit')).toThrow(
        /L2 lane turn exceeded its metadata reservation/,
      );
      expect(db.one<{ lane_turn: number }>('SELECT lane_turn FROM love_api_proof_state WHERE singleton=1')).toEqual({
        lane_turn: 0,
      });
    }
    expect(db.one<{ n: number }>('SELECT sum(value) AS n FROM l2_metadata_amplifier')!.n).toBe(0);
  }),
);
it('audit metadata-only timer should wait thirty seconds', async () =>
  withMigratedDb(async (db) => {
    seed(db, 1, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run(
      `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
       VALUES(?,'pending-1-1','web',?,'inc1',2,1)`,
      DID,
      uri,
    );
    db.run(
      `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,generation)
       VALUES('queued-member','link',?,'love','pending-1-1','{}','queued',0,1,1,1,1)`,
      DID,
    );
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
