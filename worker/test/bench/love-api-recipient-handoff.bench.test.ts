import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import { settleRows } from '../../src/forward/forward-outbox';
import {
  API_RECIPIENT_EXACT_EFFECT_SQL,
  type ApiRecipientUnloveArgs,
  enqueueApiRecipientUnlove,
} from '../../src/outbox/forward-enqueue';
import { withMigratedDb } from '../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const URI = `at://${DID}/com.example.atmusic.love/recipient`;
const REV = '3lbcdefghijmu';
const INCARNATION = `love:${URI}:import:bench-api-op`;
const BROAD = `love-delete:${INCARNATION}:rev:${REV}`;
const NARROW = `${BROAD}:api-recipient`;
const NOW = 100;

const LEGACY_EFFECT_SQL =
  'SELECT id,did,generation,kind,dedupe_key,state,love_artist_key,love_track_key,payload_json,authorization_uri,authorization_rev FROM forward_outbox WHERE link_id=? AND dedupe_key=? ORDER BY rowid';
const LEGACY_BRIDGE_SQL = `SELECT source_service FROM love_import_bridges WHERE did=? AND uri=? AND incarnation_key=? AND state IN ('bound','consumed')`;

interface RecipientHandoffVmResult {
  size: number;
  exactPlan: string[];
  oldEffectPlan: string[];
  oldBridgePlan: string[];
  exactMissSteps: number;
  exactMissRows: number;
  exactHitSteps: number;
  exactHitRows: number;
  exactLoveHitSteps: number;
  exactLoveHitRows: number;
  oldEffectSteps: number;
  oldEffectRows: number;
  oldBridgeSteps: number;
  oldBridgeRows: number;
  bridgeMissSteps: number;
  bridgeMissRows: number;
}

interface RecipientHandoffBenchResult {
  size: number;
  traces: Record<string, unknown>;
  exactPlan: string;
  vm: RecipientHandoffVmResult;
}

function insertLink(db: Db, id: string, service: 'lastfm' | 'listenbrainz', forward: 0 | 1): void {
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,
       forward_scrobbles,backfill_state,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,X'00','e1',1,'active',?,'done',1,1)`,
    id,
    DID,
    service,
    id,
    forward,
  );
}

function insertGrowthRows(db: Db, size: number): void {
  const [artistKey, trackKeyValue] = trackKey('growth unrelated', 'history row');
  db.tx(() => {
    for (let i = 0; i < size; i++) {
      db.run(
        `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,
           created_at_ms,updated_at_ms,love_artist_key,love_track_key)
         VALUES(?, 'growth-link',1,?,'love',?,'{}','queued',0,0,1,1,?,?)`,
        `unrelated-love-${i}`,
        DID,
        `unrelated-${i}`,
        artistKey,
        trackKeyValue,
      );
      db.run(
        `INSERT INTO love_import_bridges(did,operation_id,uri,incarnation_key,source_service,state,created_at_ms)
         VALUES(?,?,?,?,'lastfm','bound',1)`,
        DID,
        `unrelated-bridge-${i}`,
        URI,
        INCARNATION,
      );
    }
    db.run(
      `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,
         created_at_ms,updated_at_ms)
       VALUES('growth-exact-hit','growth-link',1,?,'unlove','exact-hit','{}','queued',0,0,1,1)`,
      DID,
    );
  });
}

function args(
  linkId: string,
  forwardSourceExclusions: readonly ('lastfm' | 'listenbrainz')[] = [],
): ApiRecipientUnloveArgs {
  return {
    did: DID,
    linkId,
    generation: 1,
    broadOperationId: BROAD,
    operationId: NARROW,
    envelope: {
      did: DID,
      recordUri: URI,
      incarnationKey: INCARNATION,
      apiOperationId: 'bench-api-op',
      projectionRkey: 'recipient',
      source: 'web',
      sourceExclusions: forwardSourceExclusions,
      projection: { artist: 'Measured Artist', track: 'Measured Track' },
      authorization: { uri: URI, rev: REV },
    },
    now: NOW,
    random: seededRandom(51),
  };
}

function instrument(db: Db) {
  const originalAll = db.all.bind(db);
  const originalOne = db.one.bind(db);
  const originalRun = db.run.bind(db);
  let active = false;
  let reads = 0;
  let mutations = 0;
  let returnedRows = 0;
  let bridgeQueries = 0;
  let unboundedOutboxIdentityQueries = 0;
  const mutation = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
  db.all = ((sql: string, ...params: SqlParam[]) => {
    if (active) {
      if (mutation.test(sql)) mutations++;
      else reads++;
      if (/\bFROM\s+love_import_bridges\b/i.test(sql)) bridgeQueries++;
      if (
        /\bFROM\s+forward_outbox\b/i.test(sql) &&
        /\blink_id\s*=\s*\?/i.test(sql) &&
        /\bdedupe_key\s*=\s*\?/i.test(sql)
      ) {
        if (!/\bkind\s*=\s*\?/i.test(sql) || /\bORDER\s+BY\s+rowid\b/i.test(sql)) unboundedOutboxIdentityQueries++;
      }
    }
    const rows = originalAll(sql, ...params);
    if (active) returnedRows += rows.length;
    return rows;
  }) as typeof db.all;
  db.one = ((sql: string, ...params: SqlParam[]) => {
    if (active) {
      reads++;
      if (/\bFROM\s+love_import_bridges\b/i.test(sql)) bridgeQueries++;
      if (
        /\bFROM\s+forward_outbox\b/i.test(sql) &&
        /\blink_id\s*=\s*\?/i.test(sql) &&
        /\bdedupe_key\s*=\s*\?/i.test(sql)
      ) {
        if (!/\bkind\s*=\s*\?/i.test(sql) || /\bORDER\s+BY\s+rowid\b/i.test(sql)) unboundedOutboxIdentityQueries++;
      }
    }
    const row = originalOne(sql, ...params);
    if (active && row !== null) returnedRows++;
    return row;
  }) as typeof db.one;
  db.run = ((sql: string, ...params: SqlParam[]) => {
    if (active) mutations++;
    return originalRun(sql, ...params);
  }) as typeof db.run;
  const measure = <T>(fn: () => T) => {
    reads = 0;
    mutations = 0;
    returnedRows = 0;
    bridgeQueries = 0;
    unboundedOutboxIdentityQueries = 0;
    const before = originalOne<{ n: number }>('SELECT total_changes() AS n')!.n;
    active = true;
    const value = fn();
    active = false;
    const changedRows = originalOne<{ n: number }>('SELECT total_changes() AS n')!.n - before;
    return {
      value,
      cost: { reads, mutations, returnedRows, changedRows, bridgeQueries, unboundedOutboxIdentityQueries },
    };
  };
  return {
    measure,
    restore() {
      db.all = originalAll;
      db.one = originalOne;
      db.run = originalRun;
    },
  };
}

it('keeps the production recipient handoff flat across 1k/10k same-link and matching-bridge history', async () => {
  const results: RecipientHandoffBenchResult[] = [];
  for (const size of [1_000, 10_000]) {
    await withMigratedDb(async (db, ctx) => {
      db.run("INSERT INTO users(did,joined_at) VALUES(?,'2026-01-15T12:00:00Z')", DID);
      insertLink(db, 'growth-link', 'listenbrainz', 0);
      insertLink(db, 'replay-link', 'lastfm', 1);
      db.run(
        `INSERT INTO live_pending_removal_events(uri,rev,action,cid,conflicted,created_at_ms,expires_at_ms)
         VALUES(?,?,'delete','',0,1,999999)`,
        URI,
        REV,
      );
      insertGrowthRows(db, size);
      const observed = instrument(db);
      const missingUri = `at://${DID}/com.example.atmusic.love/missing-authority`;
      const missingRev = '3lbcdefghijkm';
      const missingIncarnation = `love:${missingUri}:api:missing-op`;
      const missingBroad = `love-delete:${missingIncarnation}:rev:${missingRev}`;
      const missingArgs: ApiRecipientUnloveArgs = {
        ...args('growth-link'),
        broadOperationId: missingBroad,
        operationId: `${missingBroad}:api-recipient`,
        envelope: {
          ...args('growth-link').envelope,
          recordUri: missingUri,
          incarnationKey: missingIncarnation,
          apiOperationId: 'missing-op',
          projectionRkey: 'missing-authority',
          authorization: { uri: missingUri, rev: missingRev },
        },
      };
      const authorityRefusal = observed.measure(() => enqueueApiRecipientUnlove(db, missingArgs));
      const cold = observed.measure(() => enqueueApiRecipientUnlove(db, args('growth-link')));
      const warm = observed.measure(() => enqueueApiRecipientUnlove(db, args('growth-link')));
      const refused = observed.measure(() => enqueueApiRecipientUnlove(db, args('growth-link', ['listenbrainz'])));
      const queued = observed.measure(() => enqueueApiRecipientUnlove(db, args('replay-link')));
      const effect = db.one<{ id: string; generation: number }>(
        "SELECT id,generation FROM forward_outbox WHERE link_id='replay-link' AND kind='unlove'",
      )!;
      settleRows(db, [effect.id], 'sent', NOW + 1, null, true, effect.generation);
      const replay = observed.measure(() => enqueueApiRecipientUnlove(db, args('replay-link')));

      expect(cold.value).toMatchObject({ status: 'deferred' });
      expect(authorityRefusal.value).toMatchObject({ status: 'refused', reason: 'authority_missing' });
      expect(authorityRefusal.cost.changedRows).toBeLessThanOrEqual(13);
      expect(warm.value).toMatchObject({ status: 'deferred' });
      expect(refused.value).toMatchObject({ status: 'refused', reason: 'source_excluded' });
      expect(queued.value).toMatchObject({ status: 'queued' });
      expect(replay.value).toMatchObject({ status: 'replay' });
      expect(cold.cost.changedRows).toBeLessThanOrEqual(13);
      expect(warm.cost.changedRows).toBe(0);
      expect(refused.cost.changedRows).toBe(0);
      expect(replay.cost.changedRows).toBe(0);
      expect(
        [cold.cost, warm.cost, refused.cost, queued.cost, replay.cost].every((cost) => cost.bridgeQueries === 0),
      ).toBe(true);
      expect(
        [cold.cost, warm.cost, refused.cost, queued.cost, replay.cost].every(
          (cost) => cost.unboundedOutboxIdentityQueries === 0,
        ),
      ).toBe(true);

      const exactPlan = db
        .all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${API_RECIPIENT_EXACT_EFFECT_SQL}`,
          'growth-link',
          'unlove',
          'missing-key',
        )
        .map((row) => row.detail)
        .join(' ');
      expect(exactPlan).toMatch(/SEARCH forward_outbox USING .*\(link_id=\? AND kind=\? AND dedupe_key=\?\)/);
      expect(exactPlan).not.toMatch(/SCAN|TEMP B-TREE/);

      // The guards are wired to the production adapter's actual Db calls. This
      // deliberate old-query control proves the monitors catch both regressions.
      const oldEffectControl = observed.measure(() => db.all(LEGACY_EFFECT_SQL, 'growth-link', 'not-present'));
      const oldBridgeControl = observed.measure(() => db.all(LEGACY_BRIDGE_SQL, DID, URI, INCARNATION));
      expect(oldEffectControl.cost.unboundedOutboxIdentityQueries).toBe(1);
      expect(oldBridgeControl.cost.bridgeQueries).toBe(1);
      expect(oldBridgeControl.value).toHaveLength(size);

      const traces = {
        authorityRefusal: authorityRefusal.cost,
        cold: cold.cost,
        warm: warm.cost,
        refused: refused.cost,
        queued: queued.cost,
        replay: replay.cost,
      };
      db.close();
      const vm = JSON.parse(
        execFileSync(
          process.env.PYTHON ?? 'python3',
          [fileURLToPath(new URL('./support/love-api-recipient-handoff-vm.py', import.meta.url)), ctx.path],
          {
            input: JSON.stringify({
              size,
              exactSql: API_RECIPIENT_EXACT_EFFECT_SQL,
              exactMissKey: 'missing-key',
              exactHitKey: 'exact-hit',
              exactLoveHitKey: `unrelated-${size - 1}`,
              oldEffectSql: LEGACY_EFFECT_SQL,
              oldBridgeSql: LEGACY_BRIDGE_SQL,
              linkId: 'growth-link',
              did: DID,
              uri: URI,
              incarnationKey: INCARNATION,
            }),
            encoding: 'utf8',
          },
        ),
      ) as RecipientHandoffVmResult;
      expect(vm.exactMissRows).toBe(0);
      expect(vm.exactHitRows).toBe(1);
      expect(vm.exactLoveHitRows).toBe(1);
      expect(vm.oldEffectRows).toBe(0);
      expect(vm.oldBridgeRows).toBe(size);
      results.push({ size, traces, exactPlan, vm });
    });
  }
  expect(results).toHaveLength(2);
  const small = results[0]!;
  const large = results[1]!;
  expect(large.vm.exactMissSteps).toBeLessThanOrEqual(small.vm.exactMissSteps * 1.25 + 2);
  expect(large.vm.exactHitSteps).toBeLessThanOrEqual(small.vm.exactHitSteps * 1.25 + 2);
  expect(large.vm.exactLoveHitSteps).toBeLessThanOrEqual(small.vm.exactLoveHitSteps * 1.25 + 2);
  expect(large.vm.oldEffectSteps).toBeGreaterThan(small.vm.oldEffectSteps * 3);
  expect(large.vm.oldBridgeSteps).toBeGreaterThan(small.vm.oldBridgeSteps * 3);
  console.log(JSON.stringify({ apiRecipientHandoffGrowth: results }));
});
