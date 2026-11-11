import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import { settleRowsReturning } from '../../src/forward/forward-outbox';
import type { ForwardRuntime } from '../../src/forward/forwarder';
import { reclaimLoveApiProofRows } from '../../src/forward/love-api-maintenance';
import { materializeLoveApiRecipientDecisions } from '../../src/forward/love-api-materializer';
import {
  prepareLoveApiDirectAbsence,
  prepareLoveApiRecipientHandoff,
  prepareLoveApiWindowAbsence,
  recordLoveApiComparisonFact,
  releaseBroadCoveredLoveApiRecipients,
  sealLoveApiDirectAbsence,
} from '../../src/forward/love-api-recipients';
import {
  assertLoveApiDecisionBudget,
  assertLoveApiInvocationBudget,
  runLoveApiMaintenance,
} from '../../src/forward/love-api-scheduler';
import { recordVerifiedDeferredLoveAuthority } from '../../src/forward/love-coverage-authority';
import { enqueueApiRecipientUnlove, enqueueForwards } from '../../src/outbox/forward-enqueue';
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

function traceProductionSql(raw: Db): {
  db: Db;
  result(): { reads: number; mutationStatements: number; returnedRows: number; changedRows: number };
} {
  const before = total(raw);
  let reads = 0;
  let mutationStatements = 0;
  let returnedRows = 0;
  const mutation = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
  const db: Db = {
    all<T>(sql: string, ...params: SqlParam[]): T[] {
      const rows = raw.all<T>(sql, ...params);
      if (mutation.test(sql)) mutationStatements++;
      else reads++;
      returnedRows += rows.length;
      return rows;
    },
    one<T>(sql: string, ...params: SqlParam[]): T | null {
      reads++;
      const row = raw.one<T>(sql, ...params);
      if (row !== null) returnedRows++;
      return row;
    },
    run(sql: string, ...params: SqlParam[]) {
      mutationStatements++;
      return raw.run(sql, ...params);
    },
    tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
      return raw.tx(fn);
    },
  };
  return {
    db,
    result: () => ({ reads, mutationStatements, returnedRows, changedRows: total(raw) - before }),
  };
}

function assertActualDecisionUnit(
  scenario: string,
  result: Maintenance,
  expected: keyof Maintenance['decisions'],
): Record<string, unknown> {
  const transaction = result.transactions.find((row) => row.phase === 'l2-decision');
  const unit = result.lanes.find((row) => row.lane === 'decision');
  expect(transaction, `${scenario}: completed decision transaction`).toBeDefined();
  expect(unit, `${scenario}: decision lane unit`).toBeDefined();
  expect(transaction!.reads, `${scenario}: full decision reads`).toBeLessThanOrEqual(128);
  expect(transaction!.changedRows, `${scenario}: full decision changed rows`).toBeLessThanOrEqual(28);
  expect(transaction!.visits, `${scenario}: decision visits`).toBe(1);
  expect(transaction!.reads).toBe(unit!.reads);
  expect(transaction!.changedRows).toBe(unit!.changedRows);
  expect(transaction!.mutationStatements).toBeGreaterThanOrEqual(unit!.mutationStatements);
  expect(transaction!.returnedRows).toBeGreaterThanOrEqual(unit!.returnedRows);
  expect(result.decisions[expected], `${scenario}: expected ${expected} outcome`).toBe(1);
  expect(
    result.decisions.queued +
      result.decisions.deferred +
      result.decisions.replay +
      result.decisions.refused +
      result.decisions.awaiting +
      result.decisions.expired,
    `${scenario}: complete decision outcome accounting`,
  ).toBe(1);
  expect(result.writes).toBeLessThanOrEqual(96);
  expect(result.visits).toBeLessThanOrEqual(16);
  expect(result.writes - result.lanes.reduce((sum, lane) => sum + lane.work, 0)).toBeLessThanOrEqual(12);
  return {
    scenario,
    reads: transaction!.reads,
    mutationStatements: transaction!.mutationStatements,
    changedRows: transaction!.changedRows,
    returnedRows: transaction!.returnedRows,
    visits: transaction!.visits,
    outcome: result.decisions,
  };
}
const GEN2_URI = `at://${DID}/com.example.atmusic.love/r1`;
function seedGenerationTwoPending(db: Db, outboxState: 'queued' | 'held' | 'sent', storedKey = 'g2:op1') {
  seed(db, 1);
  const [artistKey, trackKeyValue] = trackKey('Artist', 'Track 1');
  db.run('DELETE FROM love_api_recipients');
  db.run("UPDATE linked_accounts SET generation=2 WHERE id='link'");
  db.run(
    `INSERT INTO love_api_recipients(
       did,uri,incarnation_key,link_id,generation,aggregate_seq,state,sent_operation_id,next_member_seq,created_at_ms,updated_at_ms)
     VALUES(?,?,'inc1','link',2,1,'sealed',NULL,2,1,1)`,
    DID,
    GEN2_URI,
  );
  db.run(
    `INSERT INTO love_api_unlove_decisions(
       did,uri,incarnation_key,link_id,generation,artist,track,artist_key,track_key,payload_json,
       authorization_uri,authorization_rev,fact_action,fact_cid,expires_at_ms,due_at_ms,created_at_ms)
     VALUES(?,?,'inc1','link',2,'Artist','Track 1',?,?,?,? ,?,'delete','',10000,1,1)`,
    DID,
    GEN2_URI,
    artistKey,
    trackKeyValue,
    JSON.stringify({ artist: 'Artist', track: 'Track 1', origin: 'web' }),
    GEN2_URI,
    REV,
  );
  db.run(
    `INSERT INTO love_api_recipient_members(link_id,generation,operation_id,did,uri,incarnation_key,member_seq,created_at_ms)
     VALUES('link',2,'op1',?,?,'inc1',1,1)`,
    DID,
    GEN2_URI,
  );
  db.run(
    `INSERT INTO forward_outbox(
       id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,generation)
     VALUES('current-member','link',?,'love',?,'{}',?,0,1,1,1,2)`,
    DID,
    storedKey,
    outboxState,
  );
}
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
    // Current full-transaction baseline: 64 production reads including both
    // total_changes() endpoints, coverage accounting and the final report meter.
    const result = runLoveApiMaintenance(db, 100, seededRandom(5), 'audit', injectDecisionReads(64));
    const decision = result.lanes.find((unit) => unit.lane === 'decision');
    const transaction = result.transactions.find((unit) => unit.phase === 'l2-decision');
    expect(decision).toMatchObject({ reads: 128, visits: 1 });
    expect(transaction).toMatchObject({ reads: 128, changedRows: decision!.changedRows });
    expect(decision!.returnedRows).toBeGreaterThanOrEqual(64);
    expect(result.decisions.deferred).toBe(1);
    expect(db.one('SELECT 1 FROM love_api_unlove_decisions')).toBeNull();
  }));

it('records the complete production scheduler decision-unit outcome matrix', async () => {
  const cases: Array<{
    name: string;
    outcome: keyof Maintenance['decisions'];
    cold?: boolean;
    configure(db: Db): Db;
  }> = [
    {
      name: 'active-queued',
      outcome: 'queued',
      configure(db) {
        db.run("UPDATE linked_accounts SET forward_scrobbles=1 WHERE id='link'");
        return db;
      },
    },
    {
      name: 'paused-deferred-retained-fact-after-A2-cleanup',
      outcome: 'deferred',
      configure(db) {
        db.run(
          `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
           SELECT authorization_uri,authorization_rev,action,cid,1,10000 FROM love_api_comparison_facts`,
        );
        db.run('DELETE FROM live_pending_removal_events');
        return db;
      },
    },
    {
      name: 'cold-paused-deferred',
      outcome: 'deferred',
      cold: true,
      configure(db) {
        db.run('DELETE FROM love_api_proof_state');
        return db;
      },
    },
    {
      name: 'terminal-replay',
      outcome: 'replay',
      configure(db) {
        db.run("UPDATE linked_accounts SET forward_scrobbles=1 WHERE id='link'");
        const candidate = {
          did: DID,
          uri: `at://${DID}/com.example.atmusic.love/r1`,
          incarnationKey: 'inc1',
          linkId: 'link',
          generation: 1,
        };
        const prepared = prepareLoveApiRecipientHandoff(db, candidate, 'matrix-session', 99);
        if (prepared.status !== 'ready') throw new Error(`expected ready replay fixture: ${prepared.status}`);
        expect(
          recordVerifiedDeferredLoveAuthority(
            db,
            prepared.envelope.authorization,
            { action: prepared.envelope.action, cid: prepared.envelope.cid },
            99,
          ),
        ).toBe('active');
        const broadOperationId = `love-delete:inc1:rev:${REV}`;
        expect(
          enqueueApiRecipientUnlove(db, {
            did: DID,
            linkId: 'link',
            generation: 1,
            broadOperationId,
            operationId: `${broadOperationId}:api-recipient`,
            envelope: prepared.envelope,
            now: 99,
            random: seededRandom(501),
          }),
        ).toEqual({ status: 'queued' });
        db.run("UPDATE forward_outbox SET state='sent' WHERE link_id='link' AND kind='unlove'");
        return db;
      },
    },
    {
      name: 'malformed-envelope-refused',
      outcome: 'refused',
      configure(db) {
        db.run("UPDATE love_api_unlove_decisions SET payload_json='{' WHERE link_id='link'");
        return db;
      },
    },
    {
      name: 'expired-fact',
      outcome: 'expired',
      configure(db) {
        db.run('UPDATE love_api_comparison_facts SET horizon_ms=50');
        db.run('UPDATE love_api_unlove_decisions SET expires_at_ms=50');
        return db;
      },
    },
    {
      name: 'conflicted-fact-refused',
      outcome: 'refused',
      configure(db) {
        db.run('UPDATE love_api_comparison_facts SET conflicted=1');
        return db;
      },
    },
    {
      name: 'stale-link-generation-refused',
      outcome: 'refused',
      configure(db) {
        db.run("UPDATE linked_accounts SET generation=2 WHERE id='link'");
        return db;
      },
    },
    {
      name: 'newer-incarnation-refused',
      outcome: 'refused',
      configure(db) {
        db.run(
          "UPDATE love_incarnations SET incarnation_key='inc2',state='present' WHERE uri=?",
          `at://${DID}/com.example.atmusic.love/r1`,
        );
        return db;
      },
    },
    {
      name: 'newer-relove-veto',
      outcome: 'refused',
      configure(db) {
        const uri = `at://${DID}/com.example.atmusic.love/newer-relove`;
        const [artistKey, trackKeyValue] = trackKey('Artist', 'Track 1');
        db.run("INSERT INTO users(did,joined_at) VALUES(?,'2026-01-15T12:00:00.000000000Z')", DID);
        db.run(
          `INSERT INTO loves(uri,did,rkey,cid,revision,artist,track,artist_key,track_key,created_at,indexed_at)
           VALUES(?,?,?,'newer-cid','3lbcdefghijmv','Artist','Track 1',?,?,'2026-01-15T12:00:00.000000000Z','2026-01-15T12:00:00.000000000Z')`,
          uri,
          DID,
          'newer-relove',
          artistKey,
          trackKeyValue,
        );
        return db;
      },
    },
    {
      name: 'active-love-put-awaiting',
      outcome: 'awaiting',
      configure(db) {
        db.run(
          `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,state,record_json,digest,due_at,created_at_ms,updated_at_ms)
           VALUES('matrix-active-love-put',?,'love.put','web',0,'com.example.atmusic.love','active-put','queued',?, 'digest',1,1,1)`,
          DID,
          JSON.stringify({ artist: 'Artist', track: 'Track 1' }),
        );
        return db;
      },
    },
    {
      name: 'missing-retained-fact-read-control',
      outcome: 'refused',
      configure(db) {
        const wrapped: Db = {
          all: <T>(sql: string, ...params: SqlParam[]) => db.all<T>(sql, ...params),
          one: <T>(sql: string, ...params: SqlParam[]) => {
            const row = db.one<T>(sql, ...params);
            return sql.includes('FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=?')
              ? null
              : row;
          },
          run: (sql: string, ...params: SqlParam[]) => db.run(sql, ...params),
          tx: <T>(fn: () => T extends Promise<unknown> ? never : T) => db.tx(fn),
        };
        return wrapped;
      },
    },
  ];
  const rows: Record<string, unknown>[] = [];
  for (const scenario of cases) {
    await withMigratedDb((raw) => {
      seed(raw, 1);
      const db = scenario.configure(raw);
      const before = total(raw);
      const result = runLoveApiMaintenance(db, 100, seededRandom(502), `matrix-${scenario.name}`);
      expect(total(raw) - before, `${scenario.name}: actual outer SQLite changes`).toBe(result.writes);
      const trace = assertActualDecisionUnit(scenario.name, result, scenario.outcome);
      rows.push(trace);
      if (scenario.cold) {
        const initialization = result.transactions.find(
          (transaction) => transaction.phase === 'l2-cold-singleton-init',
        );
        expect(initialization).toMatchObject({
          reads: 2,
          mutationStatements: 1,
          changedRows: 1,
          visits: 0,
        });
        trace.coldInitialization = initialization;
      }
    });
  }
  console.info(`L2_WHOLE_DECISION_OUTCOME_MATRIX ${JSON.stringify(rows)}`);
});

it('measures actual alias-page continuation across epoch and fresh-session invalidation', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    const mbid = '12345678-1234-1234-1234-123456789abc';
    db.run(
      'UPDATE love_api_unlove_decisions SET recording_mbid=?,payload_json=? WHERE uri=?',
      mbid,
      JSON.stringify({ artist: 'Artist', track: 'Track 1', recordingMbid: mbid, origin: 'web' }),
      uri,
    );
    db.run('INSERT INTO love_api_intent_epochs(did,epoch) VALUES(?,0)', DID);
    for (let index = 0; index < 17; index++) {
      const operationId = `cancelled-alias-${String(index).padStart(2, '0')}`;
      const loveKey = `alias-key-${String(index).padStart(2, '0')}`;
      db.run(
        `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,state,record_json,digest,due_at,created_at_ms,updated_at_ms)
         VALUES(?,?,'love.put','web',0,'com.example.atmusic.love',?,'cancelled',?,'digest',1,1,1)`,
        operationId,
        DID,
        operationId,
        JSON.stringify({ artist: `Alias ${index}`, track: `Track ${index}`, recordingMbid: mbid }),
      );
      db.run(
        `INSERT INTO linked_love_intents(did,love_key,intent,operation_id,updated_at_ms,recording_mbid)
         VALUES(?,?,'love',?,1,?)`,
        DID,
        loveKey,
        operationId,
        mbid,
      );
    }
    const run = (nowMs: number, session: string, expected: keyof Maintenance['decisions']) => {
      const result = runLoveApiMaintenance(db, nowMs, seededRandom(503), session);
      const trace = assertActualDecisionUnit(`alias-${session}-${nowMs}`, result, expected);
      return { result, trace };
    };
    const first = run(100, 'session-a', 'awaiting');
    const firstCursor = db.one<{ scan_session: string; alias_epoch: number; alias_cursor: string }>(
      'SELECT scan_session,alias_epoch,alias_cursor FROM love_api_unlove_decisions WHERE uri=?',
      uri,
    );
    expect(firstCursor).toMatchObject({ scan_session: 'session-a', alias_epoch: 0 });
    expect(firstCursor!.alias_cursor).not.toBe('');
    db.run('UPDATE love_api_intent_epochs SET epoch=1 WHERE did=?', DID);
    const second = run(1_100, 'session-a', 'awaiting');
    expect(
      db.one('SELECT scan_session,alias_epoch,alias_cursor FROM love_api_unlove_decisions WHERE uri=?', uri),
    ).toMatchObject({ scan_session: 'session-a', alias_epoch: 1, alias_cursor: firstCursor!.alias_cursor });
    const third = run(2_100, 'session-b', 'awaiting');
    expect(
      db.one('SELECT scan_session,alias_epoch,alias_cursor FROM love_api_unlove_decisions WHERE uri=?', uri),
    ).toMatchObject({ scan_session: 'session-b', alias_epoch: 1, alias_cursor: firstCursor!.alias_cursor });
    const fourth = run(3_100, 'session-b', 'deferred');
    expect(db.one('SELECT 1 FROM love_api_unlove_decisions WHERE uri=?', uri)).toBeNull();
    if (process.env.FINDING32_L2_COST_TRACE === '1')
      console.info(`L2_ALIAS_SESSION_MATRIX ${JSON.stringify([first.trace, second.trace, third.trace, fourth.trace])}`);
  }));

it('measures broad acceptance and covered-recipient release as separate production transactions', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    db.run("UPDATE linked_accounts SET forward_scrobbles=1 WHERE id='link'");
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
       SELECT authorization_uri,authorization_rev,action,cid,1,10000 FROM love_api_comparison_facts`,
    );
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    const operationId = `love-delete:inc1:rev:${REV}`;
    const broadTrace = traceProductionSql(db);
    const accepted = enqueueForwards(broadTrace.db, {
      did: DID,
      items: [
        {
          kind: 'unlove',
          operationId,
          payload: { artist: 'Artist', track: 'Track 1', origin: 'web' },
          authorization: { uri, rev: REV },
        },
      ],
      now: 100,
      random: seededRandom(504),
    });
    expect(accepted).toBe(1);
    const broad = broadTrace.result();
    const releaseTrace = traceProductionSql(db);
    expect(
      releaseBroadCoveredLoveApiRecipients(releaseTrace.db, {
        did: DID,
        uri,
        incarnationKey: 'inc1',
        rev: REV,
        operationId,
        artist: 'Artist',
        track: 'Track 1',
        recordingMbid: null,
        nowMs: 100,
      }),
    ).toBe(1);
    const release = releaseTrace.result();
    expect(db.one('SELECT state FROM love_api_recipients WHERE uri=?', uri)).toEqual({ state: 'released' });
    expect(db.one('SELECT 1 FROM love_api_unlove_decisions WHERE uri=?', uri)).toBeNull();
    expect(db.all("SELECT kind,dedupe_key FROM forward_outbox WHERE link_id='link'")).toEqual([
      { kind: 'unlove', dedupe_key: operationId },
    ]);
    if (process.env.FINDING32_L2_COST_TRACE === '1')
      console.info(`L2_BROAD_COVERED_PRODUCER_TRANSACTIONS ${JSON.stringify({ broad, release })}`);
  }));

it.each(['queued', 'held'] as const)(
  'retains an exactly bound generation-2 %s member while it is not SENT',
  async (state) =>
    withMigratedDb((db) => {
      seedGenerationTwoPending(db, state);
      let positiveAcks = 0;
      const first = runLoveApiMaintenance(db, 100, seededRandom(51), `generation-two-${state}`);
      const trace = assertActualDecisionUnit(`generation-two-${state}-awaiting`, first, 'awaiting');
      if (process.env.FINDING32_L2_COST_TRACE === '1')
        console.info(`L2_PENDING_${state.toUpperCase()}_DECISION_TRACE ${JSON.stringify(trace)}`);
      for (let tick = 1; tick < 8; tick++) {
        const result = runLoveApiMaintenance(db, 100 + tick, seededRandom(51), `generation-two-${state}`);
        positiveAcks += result.decisions.queued + result.decisions.deferred + result.decisions.replay;
      }
      expect(positiveAcks).toBe(0);
      expect(
        db.one('SELECT operation_id FROM love_api_recipient_members WHERE link_id=? AND generation=?', 'link', 2),
      ).toEqual({
        operation_id: 'op1',
      });
      expect(
        db.one('SELECT sent_operation_id FROM love_api_recipients WHERE link_id=? AND generation=?', 'link', 2),
      ).toEqual({
        sent_operation_id: null,
      });
    }),
);

it('promotes a generation-2 SENT row using its stored key and canonical binding operation id', async () =>
  withMigratedDb((db) => {
    seedGenerationTwoPending(db, 'sent');
    const result = runLoveApiMaintenance(db, 100, seededRandom(52), 'generation-two-sent');
    expect(result.decisions.queued + result.decisions.deferred + result.decisions.replay).toBe(0);
    expect(
      db.one('SELECT sent_operation_id FROM love_api_recipients WHERE link_id=? AND generation=?', 'link', 2),
    ).toEqual({
      sent_operation_id: 'op1',
    });
    expect(
      db.one('SELECT operation_id FROM love_api_recipient_members WHERE link_id=? AND generation=?', 'link', 2),
    ).toBeNull();
  }));

it.each([
  'wrong-stored-key',
  'wrong-outbox-did',
  'wrong-binding-did',
  'wrong-binding-uri',
  'wrong-incarnation',
] as const)('does not promote generation-2 SENT with %s identity', async (mismatch) =>
  withMigratedDb((db) => {
    seedGenerationTwoPending(db, 'sent', mismatch === 'wrong-stored-key' ? 'op1' : 'g2:op1');
    if (mismatch === 'wrong-outbox-did')
      db.run("UPDATE forward_outbox SET did='did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' WHERE id='current-member'");
    if (mismatch === 'wrong-binding-did')
      db.run("UPDATE love_api_bindings SET did='did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' WHERE operation_id='op1'");
    if (mismatch === 'wrong-binding-uri')
      db.run(
        "UPDATE love_api_bindings SET uri='at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/other' WHERE operation_id='op1'",
      );
    if (mismatch === 'wrong-incarnation')
      db.run("UPDATE love_api_bindings SET incarnation_key='other' WHERE operation_id='op1'");
    let positiveAcks = 0;
    for (let tick = 0; tick < 8; tick++) {
      const result = runLoveApiMaintenance(db, 100 + tick, seededRandom(53), `generation-two-${mismatch}`);
      positiveAcks += result.decisions.queued + result.decisions.deferred + result.decisions.replay;
    }
    expect(positiveAcks).toBe(0);
    expect(
      db.one('SELECT sent_operation_id FROM love_api_recipients WHERE link_id=? AND generation=?', 'link', 2),
    ).toEqual({
      sent_operation_id: null,
    });
  }),
);

it('accepts a late generation-2 SENT through the real RETURNING settlement contract', async () =>
  withMigratedDb((db) => {
    seedGenerationTwoPending(db, 'queued');
    const awaiting = runLoveApiMaintenance(db, 100, seededRandom(54), 'generation-two-before-settlement');
    const awaitingTrace = assertActualDecisionUnit('generation-two-before-settlement-awaiting', awaiting, 'awaiting');
    if (process.env.FINDING32_L2_COST_TRACE === '1')
      console.info(`L2_LATE_SENT_AWAITING_TRACE ${JSON.stringify(awaitingTrace)}`);
    expect(
      db.one('SELECT operation_id FROM love_api_recipient_members WHERE link_id=? AND generation=?', 'link', 2),
    ).toEqual({
      operation_id: 'op1',
    });
    const settled = settleRowsReturning(db, ['current-member'], 'sent', 200, null, true, 2);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ dedupe_key: 'g2:op1', generation: 2, state: 'sent' });
    expect(
      db.one('SELECT sent_operation_id FROM love_api_recipients WHERE link_id=? AND generation=?', 'link', 2),
    ).toEqual({
      sent_operation_id: 'op1',
    });
    expect(
      db.one('SELECT operation_id FROM love_api_recipient_members WHERE link_id=? AND generation=?', 'link', 2),
    ).toBeNull();
    const accepted = runLoveApiMaintenance(db, 1_100, seededRandom(54), 'generation-two-after-sent');
    const acceptedTrace = assertActualDecisionUnit('generation-two-after-sent', accepted, 'deferred');
    if (process.env.FINDING32_L2_COST_TRACE === '1')
      console.info(`L2_LATE_SENT_ACCEPTED_TRACE ${JSON.stringify(acceptedTrace)}`);
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
    const accepted = runLoveApiMaintenance(db, 100, seededRandom(5), 'cold-boundary', injectDecisionReads(64));
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

it('reserves the mandatory lane turn after stale cleanup with an unexpired comparison fact', async () =>
  withMigratedDb((db) => {
    seed(db, 1, 15);
    db.run('UPDATE love_api_recipients SET next_member_seq=16');
    db.run("UPDATE linked_accounts SET generation=2 WHERE id='link'");
    db.run('UPDATE love_api_unlove_decisions SET due_at_ms=1000');
    const frames: Array<{ committed: boolean; changes: number }> = [];
    let depth = 0;
    const observed: Db = {
      all: <T>(sql: string, ...params: SqlParam[]) => db.all<T>(sql, ...params),
      one: <T>(sql: string, ...params: SqlParam[]) => db.one<T>(sql, ...params),
      run: (sql: string, ...params: SqlParam[]) => db.run(sql, ...params),
      tx: <T>(fn: () => T extends Promise<unknown> ? never : T) => {
        const outer = depth === 0;
        const before = outer ? total(db) : 0;
        let committed = false;
        depth++;
        try {
          const result = db.tx(fn);
          committed = true;
          return result;
        } finally {
          depth--;
          if (outer) frames.push({ committed, changes: total(db) - before });
        }
      },
    };
    const result = runLoveApiMaintenance(observed, 100, seededRandom(57), 'metadata-tail');
    expect(result.writes).toBeLessThanOrEqual(96);
    expect(result.visits).toBeLessThanOrEqual(16);
    expect(result.transactions.at(-1)?.phase).toBe('l2-lane-turn');
    expect(db.one('SELECT lane_turn FROM love_api_proof_state WHERE singleton=1')).toEqual({ lane_turn: 1 });
    expect(db.one('SELECT horizon_ms FROM love_api_comparison_facts')).toEqual({ horizon_ms: 10_000 });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.committed)).toBe(true);
    expect(frames.reduce((sum, frame) => sum + frame.changes, 0)).toBe(result.writes);
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

it.each([15, 16] as const)(
  'drains stale generation-%s decision cascades within each17-row sweep unit',
  async (members) =>
    withMigratedDb((db) => {
      seed(db, 1, members);
      const uri = `at://${DID}/com.example.atmusic.love/r1`;
      db.run('UPDATE love_api_recipients SET next_member_seq=? WHERE uri=?', members + 1, uri);
      db.run("UPDATE linked_accounts SET generation=2 WHERE id='link'");
      db.run('UPDATE love_api_unlove_decisions SET due_at_ms=1000 WHERE uri=?', uri);
      let falsePositiveAcks = 0;
      const sweepUnits: number[] = [];
      for (let tick = 0; tick < 8; tick++) {
        const result = runLoveApiMaintenance(db, 100 + tick, seededRandom(55), `stale-sweep-${members}`);
        falsePositiveAcks += result.decisions.queued + result.decisions.deferred + result.decisions.replay;
        sweepUnits.push(...result.lanes.filter((lane) => lane.lane === 'sweep').map((lane) => lane.changedRows));
        expect(result.writes).toBeLessThanOrEqual(96);
        expect(result.visits).toBeLessThanOrEqual(16);
        if (db.one('SELECT 1 FROM love_api_recipients WHERE uri=?', uri) === null) break;
      }
      expect(falsePositiveAcks).toBe(0);
      expect(sweepUnits.every((rows) => rows <= 17)).toBe(true);
      expect(sweepUnits).toContain(members === 15 ? 17 : 16);
      if (members === 16) expect(sweepUnits).toContain(2);
      expect(db.one('SELECT 1 FROM love_api_recipient_members WHERE uri=?', uri)).toBeNull();
      expect(db.one('SELECT 1 FROM love_api_recipients WHERE uri=?', uri)).toBeNull();
      expect(db.one('SELECT 1 FROM love_api_unlove_decisions WHERE uri=?', uri)).toBeNull();
    }),
);

it.each([50, 10_000] as const)('keeps the stale-sweep fact horizon intact at %s', async (horizon) =>
  withMigratedDb((db) => {
    seed(db, 1, 16);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run('UPDATE love_api_comparison_facts SET horizon_ms=? WHERE authorization_uri=?', horizon, uri);
    db.run('UPDATE love_api_recipients SET next_member_seq=17 WHERE uri=?', uri);
    db.run("UPDATE linked_accounts SET generation=2 WHERE id='link'");
    db.run('UPDATE love_api_unlove_decisions SET due_at_ms=1000 WHERE uri=?', uri);
    for (let tick = 0; tick < 8; tick++)
      runLoveApiMaintenance(db, 100 + tick, seededRandom(56), `fact-horizon-${horizon}`);
    expect(db.one('SELECT 1 FROM love_api_recipients WHERE uri=?', uri)).toBeNull();
    expect(db.one('SELECT 1 FROM love_api_bindings WHERE operation_id=?', 'op1')).toBeNull();
    if (horizon <= 100)
      expect(db.one('SELECT 1 FROM love_api_comparison_facts WHERE authorization_uri=?', uri)).toBeNull();
    else
      expect(db.one('SELECT horizon_ms FROM love_api_comparison_facts WHERE authorization_uri=?', uri)).toEqual({
        horizon_ms: 10_000,
      });
  }),
);

it('reclaims an ownerless sealed aggregate and its last binding/fact dependency', async () =>
  withMigratedDb((db) => {
    seed(db, 1, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run('DELETE FROM love_api_unlove_decisions WHERE uri=?', uri);
    db.run('UPDATE love_api_comparison_facts SET horizon_ms=50 WHERE authorization_uri=?', uri);
    let falsePositiveAcks = 0;
    for (let tick = 0; tick < 16; tick++) {
      const result = runLoveApiMaintenance(db, 100 + tick, seededRandom(19), 'ownerless-cleanup');
      falsePositiveAcks += result.decisions.queued + result.decisions.deferred + result.decisions.replay;
      if (
        db.one('SELECT 1 FROM love_api_recipients WHERE uri=?', uri) === null &&
        db.one('SELECT 1 FROM love_api_bindings WHERE operation_id=?', 'op1') === null &&
        db.one('SELECT 1 FROM love_api_comparison_facts WHERE authorization_uri=?', uri) === null
      )
        break;
    }
    expect(falsePositiveAcks).toBe(0);
    expect(db.one('SELECT 1 FROM love_api_recipient_members WHERE uri=?', uri)).toBeNull();
    expect(db.one('SELECT 1 FROM love_api_recipients WHERE uri=?', uri)).toBeNull();
    expect(db.one('SELECT 1 FROM love_api_bindings WHERE operation_id=?', 'op1')).toBeNull();
    expect(db.one('SELECT 1 FROM love_api_comparison_facts WHERE authorization_uri=?', uri)).toBeNull();
  }));

it('preserves an ownerless sealed aggregate while a live window owns it', async () =>
  withMigratedDb((db) => {
    seed(db, 1, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run('DELETE FROM love_api_unlove_decisions WHERE uri=?', uri);
    db.run(
      `INSERT INTO live_pending_removals(
         uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,
         artist_key,track_key,artist,track,authorized_rev,created_at_ms,expires_at_ms)
       VALUES(?,?,'cid','love',? ,?,'','inc1','artist','track','Artist','Track',?,1,10000)`,
      uri,
      uri,
      REV,
      REV,
      REV,
    );
    db.run(
      `INSERT INTO love_api_window_owners(
         uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid,did,incarnation_key,link_id,generation,created_at_ms)
       VALUES(?,?,'cid',?,?,'',?,'inc1','link',1,1)`,
      uri,
      uri,
      REV,
      REV,
      DID,
    );
    let falsePositiveAcks = 0;
    for (let tick = 0; tick < 8; tick++) {
      const result = runLoveApiMaintenance(db, 100 + tick, seededRandom(20), 'window-owned');
      falsePositiveAcks += result.decisions.queued + result.decisions.deferred + result.decisions.replay;
    }
    expect(falsePositiveAcks).toBe(0);
    expect(db.one('SELECT 1 FROM love_api_recipients WHERE uri=?', uri)).not.toBeNull();
    expect(db.one('SELECT 1 FROM love_api_recipient_members WHERE uri=?', uri)).not.toBeNull();
    expect(db.one('SELECT 1 FROM love_api_window_owners WHERE uri=?', uri)).not.toBeNull();
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

it('uses indexed current-link aggregate seeks for broad release on the full Node schema', async () =>
  withMigratedDb((db) => {
    const source = readFileSync(new URL('../../src/forward/love-api-recipients.ts', import.meta.url), 'utf8');
    const query = source.match(/`(SELECT r\.link_id,r\.generation,d\.artist_key[\s\S]*?)`/)?.[1];
    expect(query).toBeTruthy();
    const plan = db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${query}`,
      DID,
      `at://${DID}/com.example.atmusic.love/r1`,
      'inc1',
      DID,
      `at://${DID}/com.example.atmusic.love/r1`,
      REV,
      'artist-key',
      'track-key',
    );
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toMatch(/SEARCH l/);
    expect(details).toMatch(/SEARCH r/);
    expect(details).not.toMatch(/\bSCAN\b|TEMP B-TREE/i);
  }));

it('keeps broad-candidate production SQL flat across old-generation match and miss history', () => {
  const run = spawnSync('python3', ['worker/test/bench/love-api-broad-candidate-growth.py'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(run.status, run.stderr || run.stdout).toBe(0);
  const traces = JSON.parse(run.stdout) as Array<{
    size: number;
    old_generations_only: { steps: number; rows: number };
    current_hit_after_history: { steps: number; rows: number };
    incarnation_miss: { steps: number; rows: number };
    did_miss: { steps: number; rows: number };
    uri_miss: { steps: number; rows: number };
    current_incarnation_miss: { steps: number; rows: number };
    old_prefix_control: { steps: number; rows: number };
  }>;
  expect(traces.map(({ size }) => size)).toEqual([100, 1000, 10000]);
  for (const key of [
    'old_generations_only',
    'current_hit_after_history',
    'incarnation_miss',
    'did_miss',
    'uri_miss',
    'current_incarnation_miss',
  ] as const)
    expect(traces.at(-1)![key].steps).toBeLessThanOrEqual(traces[0]![key].steps * 2);
  expect(traces.map(({ current_hit_after_history }) => current_hit_after_history.rows)).toEqual([1, 1, 1]);
  expect(traces.at(-1)!.old_prefix_control.steps).toBeGreaterThan(traces[0]!.old_prefix_control.steps * 20);
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

it('delayed preparation and the shared sealer persist the retained minimum before mismatch refusal', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run('UPDATE love_api_comparison_facts SET horizon_ms=50 WHERE authorization_uri=?', uri);
    db.run(
      `INSERT INTO live_pending_removals(
         uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,
         artist_key,track_key,artist,track,authorized_rev,created_at_ms,expires_at_ms)
       VALUES(?,?,'cid','love','',?,'','inc1','artist','track','Artist','Track',?,1,500)`,
      uri,
      uri,
      REV,
      REV,
    );
    db.run(
      `INSERT INTO love_api_window_owners(
         uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid,did,incarnation_key,link_id,generation,created_at_ms)
       VALUES(?,?,'cid','',?,'',?,'inc1','link',1,1)`,
      uri,
      uri,
      REV,
      DID,
    );
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
       VALUES(?,?,'delete','',1,500)`,
      uri,
      REV,
    );
    const args = {
      did: DID,
      uri,
      incarnationKey: 'inc1',
      linkId: 'link',
      generation: 1,
      memberUri: uri,
      removedCid: 'cid',
      windowLo: '',
      windowHi: REV,
      replacedByCid: '',
      rev: REV,
      action: 'delete',
      cid: '',
      windowExpiresAtMs: 500,
      nowMs: 30,
    };
    const prepared = prepareLoveApiWindowAbsence(db, args);
    expect(prepared).not.toBeNull();
    if (prepared === null || prepared === 'conflicted') throw new Error('delayed preparation failed');
    expect(prepared.horizonMs).toBe(50);
    const originalPayload = db.one('SELECT payload_json FROM love_api_unlove_decisions');
    expect(
      sealLoveApiDirectAbsence(db, prepared, {
        artist: 'Changed',
        track: 'Track 1',
        album: null,
        recordingMbid: null,
      }),
    ).toBe(false);
    expect(db.one('SELECT expires_at_ms FROM love_api_unlove_decisions')).toEqual({ expires_at_ms: 50 });
    expect(db.one('SELECT payload_json FROM love_api_unlove_decisions')).toEqual(originalPayload);
    expect(db.one('SELECT horizon_ms,conflicted FROM love_api_comparison_facts')).toEqual({
      horizon_ms: 50,
      conflicted: 0,
    });
    const wider = prepareLoveApiWindowAbsence(db, { ...args, nowMs: 40 });
    expect(wider).not.toBeNull();
    if (wider === null || wider === 'conflicted') throw new Error('wider delayed replay failed');
    expect(wider.horizonMs).toBe(50);
    expect(
      sealLoveApiDirectAbsence(db, wider, {
        artist: 'Artist',
        track: 'Track 1',
        album: null,
        recordingMbid: null,
      }),
    ).toBe(true);
    expect(db.one('SELECT expires_at_ms FROM love_api_unlove_decisions')).toEqual({ expires_at_ms: 50 });
  }));

it.each([30, 50, 60])('persists an accepted direct minimum before expiry refusal at now=%s', async (nowMs) =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run('UPDATE love_api_comparison_facts SET horizon_ms=50 WHERE authorization_uri=?', uri);
    db.run(
      `INSERT INTO live_record_evidence(uri,did,collection,rkey,del_rev,received_ms,expires_at_ms)
       VALUES(?,?,'com.example.atmusic.love','r1',?,20,500)`,
      uri,
      DID,
      REV,
    );
    const prepared = prepareLoveApiDirectAbsence(db, { did: DID, uri, incarnationKey: 'inc1', rev: REV, nowMs });
    if (prepared !== null && prepared !== 'conflicted')
      sealLoveApiDirectAbsence(db, prepared, { artist: 'Artist', track: 'Track 1', album: null, recordingMbid: null });
    expect(prepared === 'conflicted').toBe(nowMs >= 50);
    expect(db.one('SELECT expires_at_ms FROM love_api_unlove_decisions')).toEqual({ expires_at_ms: 50 });
    expect(
      db.one('SELECT horizon_ms,conflicted FROM love_api_comparison_facts WHERE authorization_uri=?', uri),
    ).toEqual({
      horizon_ms: 50,
      conflicted: 0,
    });
    expect(db.one('SELECT 1 FROM forward_deferred_love_witnesses')).toBeNull();
    expect(db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove'")).toBeNull();
  }),
);

it.each([30, 50, 60])('persists an accepted delayed minimum before expiry refusal at now=%s', async (nowMs) =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run('UPDATE love_api_comparison_facts SET horizon_ms=50 WHERE authorization_uri=?', uri);
    db.run(
      `INSERT INTO live_pending_removals(
         uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,
         artist_key,track_key,artist,track,authorized_rev,created_at_ms,expires_at_ms)
       VALUES(?,?,'cid','love','',?,'','inc1','artist','track','Artist','Track',?,1,500)`,
      uri,
      uri,
      REV,
      REV,
    );
    db.run(
      `INSERT INTO love_api_window_owners(
         uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid,did,incarnation_key,link_id,generation,created_at_ms)
       VALUES(?,?,'cid','',?,'',?,'inc1','link',1,1)`,
      uri,
      uri,
      REV,
      DID,
    );
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
       VALUES(?,?,'delete','',1,500)`,
      uri,
      REV,
    );
    const args = {
      did: DID,
      uri,
      incarnationKey: 'inc1',
      linkId: 'link',
      generation: 1,
      memberUri: uri,
      removedCid: 'cid',
      windowLo: '',
      windowHi: REV,
      replacedByCid: '',
      rev: REV,
      action: 'delete',
      cid: '',
      windowExpiresAtMs: 500,
      nowMs,
    };
    const prepared = prepareLoveApiWindowAbsence(db, args);
    if (prepared !== null && prepared !== 'conflicted')
      sealLoveApiDirectAbsence(db, prepared, { artist: 'Artist', track: 'Track 1', album: null, recordingMbid: null });
    expect(prepared === 'conflicted').toBe(nowMs >= 50);
    expect(db.one('SELECT expires_at_ms FROM love_api_unlove_decisions')).toEqual({ expires_at_ms: 50 });
    expect(
      db.one('SELECT horizon_ms,conflicted FROM love_api_comparison_facts WHERE authorization_uri=?', uri),
    ).toEqual({
      horizon_ms: 50,
      conflicted: 0,
    });
    expect(db.one('SELECT 1 FROM forward_deferred_love_witnesses')).toBeNull();
    expect(db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove'")).toBeNull();
  }),
);

it.each(['direct', 'window', 'event'] as const)(
  'persists the exact accepted decision minimum before earlier %s expiry refusal',
  async (expirySource) =>
    withMigratedDb((db) => {
      seed(db, 1);
      const uri = `${GEN2_URI}`;
      db.run('UPDATE love_api_comparison_facts SET horizon_ms=50 WHERE authorization_uri=?', uri);
      if (expirySource === 'direct') {
        db.run(
          `INSERT INTO live_record_evidence(uri,did,collection,rkey,del_rev,received_ms,expires_at_ms)
           VALUES(?,?,'com.example.atmusic.love','r1',?,20,50)`,
          uri,
          DID,
          REV,
        );
        expect(
          prepareLoveApiDirectAbsence(db, { did: DID, uri, incarnationKey: 'inc1', rev: REV, nowMs: 60 }),
        ).toBeNull();
      } else {
        db.run(
          `INSERT INTO live_pending_removals(
             uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,
             artist_key,track_key,artist,track,authorized_rev,created_at_ms,expires_at_ms)
           VALUES(?,?,'cid','love','',?,'','inc1','artist','track','Artist','Track',?,1,?)`,
          uri,
          uri,
          REV,
          REV,
          expirySource === 'window' ? 50 : 500,
        );
        db.run(
          `INSERT INTO love_api_window_owners(
             uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid,did,incarnation_key,link_id,generation,created_at_ms)
           VALUES(?,?,'cid','',?,'',?,'inc1','link',1,1)`,
          uri,
          uri,
          REV,
          DID,
        );
        db.run(
          `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
           VALUES(?,?,'delete','',1,?)`,
          uri,
          REV,
          expirySource === 'event' ? 50 : 500,
        );
        const prepared = prepareLoveApiWindowAbsence(db, {
          did: DID,
          uri,
          incarnationKey: 'inc1',
          linkId: 'link',
          generation: 1,
          memberUri: uri,
          removedCid: 'cid',
          windowLo: '',
          windowHi: REV,
          replacedByCid: '',
          rev: REV,
          action: 'delete',
          cid: '',
          windowExpiresAtMs: expirySource === 'window' ? 50 : 500,
          nowMs: 60,
        });
        expect(prepared).toBeNull();
      }
      expect(db.one('SELECT expires_at_ms FROM love_api_unlove_decisions')).toEqual({ expires_at_ms: 50 });
      expect(db.one('SELECT horizon_ms,conflicted FROM love_api_comparison_facts')).toEqual({
        horizon_ms: 50,
        conflicted: 0,
      });
      expect(db.one('SELECT 1 FROM forward_deferred_love_witnesses')).toBeNull();
      expect(db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove'")).toBeNull();
    }),
);

it.each([
  [0, false],
  [1, false],
  [0, true],
  [1, true],
] as const)(
  'preflights every batch minimum before refusal at position %s reversed=%s',
  async (refusalPosition, reversed) =>
    withMigratedDb((db) => {
      seed(db, 1);
      const uri = GEN2_URI;
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,
        forward_scrobbles,backfill_state,created_at_ms,updated_at_ms)
       VALUES('link2',?,'listenbrainz','remote2',X'00','e1',1,'active',0,'done',1,1)`,
        DID,
      );
      db.run(
        `INSERT INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,
        sent_operation_id,created_at_ms,updated_at_ms) VALUES(?,?,'inc1','link2',1,2,'sealed','op1',1,1)`,
        DID,
        uri,
      );
      db.run(
        `INSERT INTO love_api_unlove_decisions(
        did,uri,incarnation_key,link_id,generation,artist,track,artist_key,track_key,payload_json,
        authorization_uri,authorization_rev,fact_action,fact_cid,expires_at_ms,due_at_ms,created_at_ms)
       SELECT did,uri,incarnation_key,'link2',generation,artist,track,artist_key,track_key,payload_json,
        authorization_uri,authorization_rev,fact_action,fact_cid,expires_at_ms,due_at_ms,created_at_ms
       FROM love_api_unlove_decisions WHERE link_id='link'`,
      );
      db.run('UPDATE love_api_proof_state SET next_aggregate_seq=3');
      db.run('UPDATE love_api_comparison_facts SET horizon_ms=50');
      db.run(
        `INSERT INTO live_record_evidence(uri,did,collection,rkey,del_rev,received_ms,expires_at_ms)
       VALUES(?,?,'com.example.atmusic.love','r1',?,20,500)`,
        uri,
        DID,
        REV,
      );
      const prepared = prepareLoveApiDirectAbsence(db, { did: DID, uri, incarnationKey: 'inc1', rev: REV, nowMs: 30 });
      if (prepared === null || prepared === 'conflicted') throw new Error('exact absence preparation failed');
      const linkOrder = reversed ? ['link2', 'link'] : ['link', 'link2'];
      const refusedLink = linkOrder.splice(refusalPosition, 1)[0]!;
      db.run(
        'UPDATE love_api_unlove_decisions SET payload_json=? WHERE did=? AND uri=? AND link_id=?',
        JSON.stringify({ artist: 'Older', track: 'Track 1', origin: 'web' }),
        DID,
        uri,
        refusedLink,
      );
      if (reversed) prepared.recipients.reverse();
      const before = db.all(
        'SELECT did,uri,incarnation_key,link_id,generation,authorization_uri,authorization_rev,fact_action,fact_cid,payload_json FROM love_api_unlove_decisions ORDER BY link_id',
      );
      expect(
        sealLoveApiDirectAbsence(db, prepared, {
          artist: 'Artist',
          track: 'Track 1',
          album: null,
          recordingMbid: null,
        }),
      ).toBe(false);
      expect(db.all('SELECT link_id,expires_at_ms FROM love_api_unlove_decisions ORDER BY link_id')).toEqual([
        { link_id: 'link', expires_at_ms: 50 },
        { link_id: 'link2', expires_at_ms: 50 },
      ]);
      expect(
        db.all(
          'SELECT did,uri,incarnation_key,link_id,generation,authorization_uri,authorization_rev,fact_action,fact_cid,payload_json FROM love_api_unlove_decisions ORDER BY link_id',
        ),
      ).toEqual(before);
      expect(db.one('SELECT horizon_ms,conflicted FROM love_api_comparison_facts')).toEqual({
        horizon_ms: 50,
        conflicted: 0,
      });
      expect(db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove'")).toBeNull();
    }),
);

it('seals a matching two-recipient batch after both exact minima are applied', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = GEN2_URI;
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,
        forward_scrobbles,backfill_state,created_at_ms,updated_at_ms)
       VALUES('link2',?,'listenbrainz','remote2',X'00','e1',1,'active',0,'done',1,1)`,
      DID,
    );
    db.run(
      `INSERT INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,
        sent_operation_id,created_at_ms,updated_at_ms) VALUES(?,?,'inc1','link2',1,2,'sealed','op1',1,1)`,
      DID,
      uri,
    );
    db.run(
      `INSERT INTO love_api_unlove_decisions(
        did,uri,incarnation_key,link_id,generation,artist,track,artist_key,track_key,payload_json,
        authorization_uri,authorization_rev,fact_action,fact_cid,expires_at_ms,due_at_ms,created_at_ms)
       SELECT did,uri,incarnation_key,'link2',generation,artist,track,artist_key,track_key,payload_json,
        authorization_uri,authorization_rev,fact_action,fact_cid,expires_at_ms,due_at_ms,created_at_ms
       FROM love_api_unlove_decisions WHERE link_id='link'`,
    );
    db.run('UPDATE love_api_proof_state SET next_aggregate_seq=3');
    db.run('UPDATE love_api_comparison_facts SET horizon_ms=50');
    db.run(
      `INSERT INTO live_record_evidence(uri,did,collection,rkey,del_rev,received_ms,expires_at_ms)
       VALUES(?,?,'com.example.atmusic.love','r1',?,20,500)`,
      uri,
      DID,
      REV,
    );
    const prepared = prepareLoveApiDirectAbsence(db, { did: DID, uri, incarnationKey: 'inc1', rev: REV, nowMs: 30 });
    if (prepared === null || prepared === 'conflicted') throw new Error('exact absence preparation failed');
    expect(
      sealLoveApiDirectAbsence(db, prepared, {
        artist: 'Artist',
        track: 'Track 1',
        album: null,
        recordingMbid: null,
      }),
    ).toBe(true);
    expect(db.all('SELECT link_id,expires_at_ms FROM love_api_unlove_decisions ORDER BY link_id')).toEqual([
      { link_id: 'link', expires_at_ms: 50 },
      { link_id: 'link2', expires_at_ms: 50 },
    ]);
    expect(db.all('SELECT link_id,state FROM love_api_recipients ORDER BY link_id')).toEqual([
      { link_id: 'link', state: 'sealed' },
      { link_id: 'link2', state: 'sealed' },
    ]);
    const replay = prepareLoveApiDirectAbsence(db, { did: DID, uri, incarnationKey: 'inc1', rev: REV, nowMs: 30 });
    if (replay === null || replay === 'conflicted') throw new Error('exact replay preparation failed');
    db.run('UPDATE love_api_comparison_facts SET horizon_ms=20');
    expect(
      sealLoveApiDirectAbsence(db, replay, {
        artist: 'Artist',
        track: 'Track 1',
        album: null,
        recordingMbid: null,
      }),
    ).toBe(false);
    expect(db.all('SELECT link_id,expires_at_ms FROM love_api_unlove_decisions ORDER BY link_id')).toEqual([
      { link_id: 'link', expires_at_ms: 20 },
      { link_id: 'link2', expires_at_ms: 20 },
    ]);
  }));

it('rolls back every batch minimum when the owning transaction fails', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = GEN2_URI;
    db.run('UPDATE love_api_comparison_facts SET horizon_ms=50');
    db.run(
      `INSERT INTO live_record_evidence(uri,did,collection,rkey,del_rev,received_ms,expires_at_ms)
       VALUES(?,?,'com.example.atmusic.love','r1',?,20,500)`,
      uri,
      DID,
      REV,
    );
    const before = db.all('SELECT link_id,expires_at_ms FROM love_api_unlove_decisions ORDER BY link_id');
    expect(() =>
      db.tx(() => {
        const prepared = prepareLoveApiDirectAbsence(db, {
          did: DID,
          uri,
          incarnationKey: 'inc1',
          rev: REV,
          nowMs: 30,
        });
        if (prepared === null || prepared === 'conflicted') throw new Error('exact absence preparation failed');
        expect(
          sealLoveApiDirectAbsence(db, prepared, {
            artist: 'Artist',
            track: 'Track 1',
            album: null,
            recordingMbid: null,
          }),
        ).toBe(true);
        throw new Error('owning transaction failure');
      }),
    ).toThrow('owning transaction failure');
    expect(db.all('SELECT link_id,expires_at_ms FROM love_api_unlove_decisions ORDER BY link_id')).toEqual(before);
    expect(db.one('SELECT 1 FROM forward_deferred_love_witnesses')).toBeNull();
    expect(db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove'")).toBeNull();
  }));

it.each(['insert', 'same', 'mismatch'] as const)('uses reloaded minimum for prepared replay %s', async (mode) =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run(
      `INSERT INTO live_record_evidence(uri,did,collection,rkey,del_rev,received_ms,expires_at_ms)
       VALUES(?,?,'com.example.atmusic.love','r1',?,20,500)`,
      uri,
      DID,
      REV,
    );
    const prepared = prepareLoveApiDirectAbsence(db, { did: DID, uri, incarnationKey: 'inc1', rev: REV, nowMs: 30 });
    if (prepared === null || prepared === 'conflicted') throw new Error('direct preparation failed');
    expect(prepared.horizonMs).toBe(500);
    recordLoveApiComparisonFact(db, { uri, rev: REV, action: 'delete', cid: '', horizonMs: 50 }, 30);
    if (mode === 'insert') db.run('DELETE FROM love_api_unlove_decisions');
    const sealed = sealLoveApiDirectAbsence(db, prepared, {
      artist: mode === 'mismatch' ? 'Changed' : 'Artist',
      track: 'Track 1',
      album: null,
      recordingMbid: null,
    });
    expect(sealed).toBe(mode !== 'mismatch');
    expect(db.one('SELECT expires_at_ms FROM love_api_unlove_decisions')).toEqual({ expires_at_ms: 50 });
    expect(db.one('SELECT authorization_uri,authorization_rev FROM love_api_unlove_decisions')).toEqual({
      authorization_uri: uri,
      authorization_rev: REV,
    });
  }),
);

it('uses the existing decision original fact before refusing a different verified revision', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    const nextRev = '3lbcdefghijmv';
    db.run(
      'UPDATE love_api_comparison_facts SET horizon_ms=50 WHERE authorization_uri=? AND authorization_rev=?',
      uri,
      REV,
    );
    db.run(
      `INSERT INTO live_record_evidence(uri,did,collection,rkey,del_rev,received_ms,expires_at_ms)
       VALUES(?,?,'com.example.atmusic.love','r1',?,20,500)`,
      uri,
      DID,
      nextRev,
    );
    const original = db.one('SELECT payload_json,authorization_uri,authorization_rev FROM love_api_unlove_decisions');
    const prepared = prepareLoveApiDirectAbsence(db, {
      did: DID,
      uri,
      incarnationKey: 'inc1',
      rev: nextRev,
      nowMs: 30,
    });
    if (prepared === null || prepared === 'conflicted') throw new Error('new revision preparation failed');
    expect(prepared.horizonMs).toBe(500);
    expect(
      sealLoveApiDirectAbsence(db, prepared, { artist: 'Artist', track: 'Track 1', album: null, recordingMbid: null }),
    ).toBe(false);
    expect(db.one('SELECT expires_at_ms FROM love_api_unlove_decisions')).toEqual({ expires_at_ms: 50 });
    expect(db.one('SELECT payload_json,authorization_uri,authorization_rev FROM love_api_unlove_decisions')).toEqual(
      original,
    );
    expect(
      db.all(
        'SELECT authorization_rev,horizon_ms,conflicted FROM love_api_comparison_facts ORDER BY authorization_rev',
      ),
    ).toEqual([
      { authorization_rev: REV, horizon_ms: 50, conflicted: 0 },
      { authorization_rev: nextRev, horizon_ms: 500, conflicted: 0 },
    ]);
  }));

it('does not borrow a shorter fact from another URI when refusing a different revision', async () =>
  withMigratedDb((db) => {
    seed(db, 2);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    const unrelatedUri = `at://${DID}/com.example.atmusic.love/r2`;
    const nextRev = '3lbcdefghijmv';
    db.run(
      'UPDATE love_api_comparison_facts SET horizon_ms=50 WHERE authorization_uri=? AND authorization_rev=?',
      uri,
      REV,
    );
    db.run(
      'UPDATE love_api_comparison_facts SET horizon_ms=10 WHERE authorization_uri=? AND authorization_rev=?',
      unrelatedUri,
      REV,
    );
    db.run(
      `INSERT INTO live_record_evidence(uri,did,collection,rkey,del_rev,received_ms,expires_at_ms)
       VALUES(?,?,'com.example.atmusic.love','r1',?,20,500)`,
      uri,
      DID,
      nextRev,
    );
    const prepared = prepareLoveApiDirectAbsence(db, {
      did: DID,
      uri,
      incarnationKey: 'inc1',
      rev: nextRev,
      nowMs: 30,
    });
    if (prepared === null || prepared === 'conflicted') throw new Error('new revision preparation failed');
    expect(
      sealLoveApiDirectAbsence(db, prepared, { artist: 'Artist', track: 'Track 1', album: null, recordingMbid: null }),
    ).toBe(false);
    expect(db.one('SELECT expires_at_ms,authorization_rev FROM love_api_unlove_decisions WHERE uri=?', uri)).toEqual({
      expires_at_ms: 50,
      authorization_rev: REV,
    });
    expect(db.one('SELECT expires_at_ms FROM love_api_unlove_decisions WHERE uri=?', unrelatedUri)).toEqual({
      expires_at_ms: 10_000,
    });
    expect(
      db.one(
        'SELECT horizon_ms,conflicted FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=?',
        unrelatedUri,
        REV,
      ),
    ).toEqual({
      horizon_ms: 10,
      conflicted: 0,
    });
  }));

it('fails closed when the accepted original fact is conflicted', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    const nextRev = '3lbcdefghijmv';
    db.run(
      `INSERT INTO live_record_evidence(uri,did,collection,rkey,del_rev,received_ms,expires_at_ms)
       VALUES(?,?,'com.example.atmusic.love','r1',?,20,500)`,
      uri,
      DID,
      nextRev,
    );
    const prepared = prepareLoveApiDirectAbsence(db, {
      did: DID,
      uri,
      incarnationKey: 'inc1',
      rev: nextRev,
      nowMs: 30,
    });
    if (prepared === null || prepared === 'conflicted') throw new Error('new revision preparation failed');
    db.run(
      'UPDATE love_api_comparison_facts SET conflicted=1 WHERE authorization_uri=? AND authorization_rev=?',
      uri,
      REV,
    );
    expect(
      sealLoveApiDirectAbsence(db, prepared, { artist: 'Artist', track: 'Track 1', album: null, recordingMbid: null }),
    ).toBe(false);
    expect(db.one('SELECT expires_at_ms,authorization_rev FROM love_api_unlove_decisions')).toEqual({
      expires_at_ms: 10_000,
      authorization_rev: REV,
    });
    expect(db.one('SELECT authorization_rev FROM love_api_unlove_decisions')).not.toEqual({
      authorization_rev: nextRev,
    });
  }));

it('fails closed when the exact original-fact lookup is missing', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    const uri = `at://${DID}/com.example.atmusic.love/r1`;
    db.run(
      `INSERT INTO live_record_evidence(uri,did,collection,rkey,del_rev,received_ms,expires_at_ms)
       VALUES(?,?,'com.example.atmusic.love','r1',?,20,500)`,
      uri,
      DID,
      REV,
    );
    const prepared = prepareLoveApiDirectAbsence(db, { did: DID, uri, incarnationKey: 'inc1', rev: REV, nowMs: 30 });
    if (prepared === null || prepared === 'conflicted') throw new Error('direct preparation failed');
    recordLoveApiComparisonFact(db, { uri, rev: REV, action: 'delete', cid: '', horizonMs: 50 }, 30);
    const incomplete: Db = {
      all: <T>(sql: string, ...params: SqlParam[]) => db.all<T>(sql, ...params),
      one: <T>(sql: string, ...params: SqlParam[]) => {
        const row = db.one<Record<string, unknown>>(sql, ...params);
        if (row === null || !sql.includes('original.action AS original_action')) return row as T | null;
        return {
          ...row,
          original_action: null,
          original_cid: null,
          original_horizon_ms: null,
          original_conflicted: null,
        } as T;
      },
      run: (sql: string, ...params: SqlParam[]) => db.run(sql, ...params),
      tx: <T>(fn: () => T extends Promise<unknown> ? never : T) => db.tx(fn),
    };
    expect(
      sealLoveApiDirectAbsence(incomplete, prepared, {
        artist: 'Artist',
        track: 'Track 1',
        album: null,
        recordingMbid: null,
      }),
    ).toBe(false);
    expect(db.one('SELECT expires_at_ms,authorization_rev FROM love_api_unlove_decisions')).toEqual({
      expires_at_ms: 10_000,
      authorization_rev: REV,
    });
    expect(db.one('SELECT horizon_ms,conflicted FROM love_api_comparison_facts')).toEqual({
      horizon_ms: 50,
      conflicted: 0,
    });
  }));

it('validates owned pending members by durable cursor before awaiting a selected SENT proof', async () =>
  withMigratedDb((db) => {
    seed(db, 1, 1);
    let accepted = 0;
    const waiting = runLoveApiMaintenance(db, 100, seededRandom(5), 'audit');
    const waitingTrace = assertActualDecisionUnit('missing-outbox-member-awaiting', waiting, 'awaiting');
    if (process.env.FINDING32_L2_COST_TRACE === '1')
      console.info(`L2_MISSING_MEMBER_AWAITING_TRACE ${JSON.stringify(waitingTrace)}`);
    for (let tick = 1; tick < 8; tick++) {
      const result = runLoveApiMaintenance(db, 100 + tick * 1_000, seededRandom(5), 'audit');
      if (result.decisions.deferred === 1) {
        const trace = assertActualDecisionUnit('missing-outbox-member-released-and-deferred', result, 'deferred');
        if (process.env.FINDING32_L2_COST_TRACE === '1')
          console.info(`L2_MISSING_MEMBER_DEFERRED_TRACE ${JSON.stringify(trace)}`);
      }
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
    const waiting = runLoveApiMaintenance(db, 100, seededRandom(5), 'audit');
    const trace = assertActualDecisionUnit('queued-member-awaiting', waiting, 'awaiting');
    if (process.env.FINDING32_L2_COST_TRACE === '1') console.info(`L2_QUEUED_MEMBER_TRACE ${JSON.stringify(trace)}`);
    for (let tick = 1; tick < 8; tick++) runLoveApiMaintenance(db, 100 + tick, seededRandom(5), 'audit');
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
    const waiting = runLoveApiMaintenance(db, 100, seededRandom(5), 'audit');
    const waitingTrace = assertActualDecisionUnit('exact-sent-member-awaiting-before-sweep', waiting, 'awaiting');
    if (process.env.FINDING32_L2_COST_TRACE === '1')
      console.info(`L2_EXACT_SENT_MEMBER_AWAITING_TRACE ${JSON.stringify(waitingTrace)}`);
    expect(db.one('SELECT sent_operation_id FROM love_api_recipients')).toEqual({ sent_operation_id: 'pending-1-1' });
    expect(db.one('SELECT 1 FROM love_api_recipient_members')).toBeNull();
    let accepted = 0;
    const firstAfterSent = runLoveApiMaintenance(db, 1_100, seededRandom(5), 'audit');
    const settledTrace = assertActualDecisionUnit(
      'generation-two-late-sent-after-settlement',
      firstAfterSent,
      'deferred',
    );
    if (process.env.FINDING32_L2_COST_TRACE === '1')
      console.info(`L2_LATE_SENT_ACCEPTED_TRACE ${JSON.stringify(settledTrace)}`);
    accepted += firstAfterSent.decisions.queued + firstAfterSent.decisions.deferred + firstAfterSent.decisions.replay;
    for (let tick = 1; tick < 7; tick++) {
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
    const waiting = runLoveApiMaintenance(db, 100, seededRandom(5), 'audit');
    const waitingTrace = assertActualDecisionUnit('failed-member-awaiting-before-sweep', waiting, 'awaiting');
    if (process.env.FINDING32_L2_COST_TRACE === '1')
      console.info(`L2_FAILED_MEMBER_AWAITING_TRACE ${JSON.stringify(waitingTrace)}`);
    const refused = runLoveApiMaintenance(db, 1_100, seededRandom(5), 'audit');
    const refusedTrace = assertActualDecisionUnit('failed-member-removed-refused', refused, 'refused');
    if (process.env.FINDING32_L2_COST_TRACE === '1')
      console.info(`L2_FAILED_MEMBER_REFUSED_TRACE ${JSON.stringify(refusedTrace)}`);
    accepted += refused.decisions.queued + refused.decisions.deferred + refused.decisions.replay;
    for (let tick = 2; tick < 8; tick++) {
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

it('rolls back the exact 29th changed row inside a real decision transaction', async () =>
  withMigratedDb((db) => {
    seed(db, 1);
    db.run('CREATE TABLE l2_exact_write_amplifier(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)');
    for (let id = 1; id <= 15; id++) db.run('INSERT INTO l2_exact_write_amplifier VALUES(?,0)', id);
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
          db.run('UPDATE l2_exact_write_amplifier SET value=value+1');
        }
        return result;
      },
      tx: <T>(fn: () => T extends Promise<unknown> ? never : T) => db.tx(fn),
    };
    expect(() => runLoveApiMaintenance(amplified, 100, seededRandom(5), 'audit')).toThrow(
      /DECISION unit exceeded 28 changed rows: 29/,
    );
    expect(injected).toBe(true);
    expect(db.one<{ state: string }>('SELECT state FROM love_api_recipients')!.state).toBe('sealed');
    expect(db.one<{ n: number }>('SELECT count(*) AS n FROM love_api_unlove_decisions')!.n).toBe(1);
    expect(db.one<{ n: number }>('SELECT sum(value) AS n FROM l2_exact_write_amplifier')!.n).toBe(0);
    expect(db.one<{ n: number }>('SELECT count(*) AS n FROM forward_outbox')!.n).toBe(outboxBefore);
    expect(
      db.one<{ n: number }>(
        `SELECT count(*) AS n FROM counters
         WHERE name='link_coverage' AND label='api_love_maintenance_decision'`,
      )!.n,
    ).toBe(0);
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
