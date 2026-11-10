// Loves through the server outbox (ADR 0005 §5.8, §6.3, §7.8; N2-05): one
// love per (artist_key, track_key), and unlove mirrors unfollow.

import { writeFileSync } from 'node:fs';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../../src/do/db';
import { cachedIdentityResolver } from '../../../src/do/ingest/identity-cache';
import { recordLiveEvidence } from '../../../src/do/ingest/live-evidence';
import {
  authorizePendingRemovals,
  executeAuthorizedRemovals,
  recordPendingRemoval,
} from '../../../src/do/ingest/live-pending-removals';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { settleRows } from '../../../src/forward/forward-outbox';
import { materializeLoveApiRecipientDecisions } from '../../../src/forward/love-api-materializer';
import { bumpLoveApiIntentEpoch, prepareLoveApiRecipientHandoff } from '../../../src/forward/love-api-recipients';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { authorizedLiveOptions } from '../../write/support';
import { CREATE, DELETE, GET, type Harness, LIST, LOVE, remoteRecords, withHarness } from './support';

function love(artist: string, track: string) {
  return { $type: LOVE, artist, track, createdAt: '2026-01-15T11:00:00Z' };
}

const projectionRandom = seededRandom(27);
const API_PARENT_REUSE_TRACE = {
  source: '5d573706bf07bb50e0c8b79cf1d34a3f6c56a975',
  reads: 26,
  changedRows: 13,
  recipients: 1,
} as const;
const API_PARENT_SCALE_TRACE = {
  0: { reads: 22, changedRows: 9 },
  2: { reads: 30, changedRows: 17 },
} as const;
const API_PARENT_PARTIAL_DELETE_TRACE = {
  source: '5d573706bf07bb50e0c8b79cf1d34a3f6c56a975',
  reads: 15,
  mutationStatements: 15,
  changedRows: 8,
  returnedRows: 10,
} as const;
const API_N1_ALLOWED_DELTA = { reads: 12, changedRows: 11 } as const;
const API_N1_MEASURED_DELTA = { reads: 10, changedRows: 9 } as const;
const API_N2_MARGINAL_REFERENCE = { reads: 3, changedRows: 4 } as const;
const API_N2_TOTAL_ALLOWED = {
  reads: API_N1_ALLOWED_DELTA.reads + API_N2_MARGINAL_REFERENCE.reads + 1,
  changedRows: API_N1_ALLOWED_DELTA.changedRows + API_N2_MARGINAL_REFERENCE.changedRows + 1,
} as const;

function assertApiPathBounds(recipientCount: 0 | 1 | 2, addedReads: number, addedChangedRows: number): void {
  if (recipientCount === 0) {
    if (addedReads > 3) throw new Error('N0 API read bound exceeded');
    if (addedChangedRows > 2) throw new Error('N0 API changed-row bound exceeded');
    return;
  }
  if (recipientCount === 1) {
    if (addedReads > API_N1_ALLOWED_DELTA.reads) throw new Error('N1 API read bound exceeded');
    if (addedChangedRows > API_N1_ALLOWED_DELTA.changedRows) throw new Error('N1 API changed-row bound exceeded');
    return;
  }
  if (addedReads > API_N2_TOTAL_ALLOWED.reads) throw new Error('N2 API total read bound exceeded');
  if (addedChangedRows > API_N2_TOTAL_ALLOWED.changedRows) throw new Error('N2 API total changed-row bound exceeded');
  if (addedReads - API_N1_MEASURED_DELTA.reads > API_N2_MARGINAL_REFERENCE.reads)
    throw new Error('N2 API marginal read bound exceeded');
  if (addedChangedRows - API_N1_MEASURED_DELTA.changedRows > API_N2_MARGINAL_REFERENCE.changedRows)
    throw new Error('N2 API marginal changed-row bound exceeded');
}

it('trips each measured API-path delta guard on its intended bound', () => {
  expect(() => assertApiPathBounds(0, 4, 2)).toThrow('N0 API read bound exceeded');
  expect(() => assertApiPathBounds(0, 3, 3)).toThrow('N0 API changed-row bound exceeded');
  expect(() => assertApiPathBounds(1, 13, 11)).toThrow('N1 API read bound exceeded');
  expect(() => assertApiPathBounds(1, 12, 12)).toThrow('N1 API changed-row bound exceeded');
  expect(() => assertApiPathBounds(2, 14, 13)).toThrow('N2 API marginal read bound exceeded');
  expect(() => assertApiPathBounds(2, 13, 14)).toThrow('N2 API marginal changed-row bound exceeded');
  expect(() => assertApiPathBounds(2, 17, 16)).toThrow('N2 API total read bound exceeded');
  expect(() => assertApiPathBounds(2, 16, 17)).toThrow('N2 API total changed-row bound exceeded');
});

function traceDb(raw: Db): {
  db: Db;
  result: () => {
    reads: number;
    mutationStatements: number;
    returnedRows: number;
    changedRows: number;
    statements: Array<{
      method: 'all' | 'one' | 'run';
      source: string;
      sql: string;
      returnedRows: number;
      changedRows: number;
    }>;
    transactions: Array<{
      name: string;
      parentName: string | null;
      depth: number;
      inclusive: true;
      reads: number;
      mutationStatements: number;
      changedRows: number;
      returnedRows: number;
      nestedTransactions: number;
      nestedOwners: string[];
    }>;
  };
} {
  let reads = 0;
  let mutationStatements = 0;
  let returnedRows = 0;
  const statements: Array<{
    method: 'all' | 'one' | 'run';
    source: string;
    sql: string;
    returnedRows: number;
    changedRows: number;
  }> = [];
  const active: Array<{
    name: string;
    parentName: string | null;
    depth: number;
    before: number;
    reads: number;
    mutationStatements: number;
    returnedRows: number;
    nestedTransactions: number;
    nestedOwners: string[];
  }> = [];
  const transactions: Array<{
    name: string;
    parentName: string | null;
    depth: number;
    inclusive: true;
    reads: number;
    mutationStatements: number;
    changedRows: number;
    returnedRows: number;
    nestedTransactions: number;
    nestedOwners: string[];
  }> = [];
  const mutation = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
  const callsite = () =>
    new Error().stack
      ?.split('\n')
      .slice(2)
      .find((line) => line.includes('/worker/src/'))
      ?.trim() ?? 'test-owned transaction';
  const account = (sql: string, count: number, method: 'all' | 'one' | 'run', changedRows: number) => {
    if (mutation.test(sql)) {
      mutationStatements++;
      for (const frame of active) frame.mutationStatements++;
    } else {
      reads++;
      for (const frame of active) frame.reads++;
    }
    returnedRows += count;
    for (const frame of active) frame.returnedRows += count;
    const source =
      new Error().stack
        ?.split('\n')
        .find((line) => line.includes('/worker/src/'))
        ?.trim() ?? 'test-owned';
    statements.push({ method, source, sql, returnedRows: count, changedRows });
  };
  const before = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
  const db: Db = {
    all<T>(sql: string, ...params: SqlParam[]): T[] {
      const changesBefore = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
      const rows = raw.all<T>(sql, ...params);
      const changesAfter = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
      account(sql, rows.length, 'all', changesAfter - changesBefore);
      return rows;
    },
    one<T>(sql: string, ...params: SqlParam[]): T | null {
      const changesBefore = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
      const row = raw.one<T>(sql, ...params);
      const changesAfter = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
      account(sql, row === null ? 0 : 1, 'one', changesAfter - changesBefore);
      return row;
    },
    run(sql: string, ...params: SqlParam[]) {
      const changesBefore = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
      const result = raw.run(sql, ...params);
      const changesAfter = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
      account(sql, 0, 'run', changesAfter - changesBefore);
      return result;
    },
    tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
      const transaction = {
        name: callsite(),
        parentName: active.at(-1)?.name ?? null,
        depth: active.length,
        before: raw.one<{ n: number }>('SELECT total_changes() AS n')!.n,
        reads: 0,
        mutationStatements: 0,
        returnedRows: 0,
        nestedTransactions: 0,
        nestedOwners: [] as string[],
      };
      for (const frame of active) {
        frame.nestedTransactions++;
        frame.nestedOwners.push(transaction.name);
      }
      active.push(transaction);
      try {
        return raw.tx(fn);
      } finally {
        const after = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
        transactions.push({
          name: transaction.name,
          parentName: transaction.parentName,
          depth: transaction.depth,
          inclusive: true,
          reads: transaction.reads,
          mutationStatements: transaction.mutationStatements,
          changedRows: after - transaction.before,
          returnedRows: transaction.returnedRows,
          nestedTransactions: transaction.nestedTransactions,
          nestedOwners: transaction.nestedOwners,
        });
        active.pop();
      }
    },
  };
  return {
    db,
    result: () => ({
      reads,
      mutationStatements,
      returnedRows,
      changedRows: raw.one<{ n: number }>('SELECT total_changes() AS n')!.n - before,
      transactions,
      statements,
    }),
  };
}

it('bumps the durable alias epoch for API love and unlove intents but not imports', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const put = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Alias artist', track: 'Alias track', recordingMbid: '12345678-1234-1234-1234-123456789abc' },
      origin: 'web',
    });
    expect(put.ok).toBe(true);
    expect(h.db.one('SELECT epoch FROM love_api_intent_epochs WHERE did=?', h.alice)).toEqual({ epoch: 1 });
    const remove = await enqueueUnlove(h.m, {
      did: h.alice,
      artist: 'Alias artist',
      track: 'Alias track',
      origin: 'web',
    });
    expect(remove.ok).toBe(true);
    expect(h.db.one('SELECT epoch FROM love_api_intent_epochs WHERE did=?', h.alice)).toEqual({ epoch: 2 });
    const imported = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Alias artist', track: 'Alias track' },
      origin: 'import',
    });
    expect(imported.ok).toBe(true);
    expect(h.db.one('SELECT epoch FROM love_api_intent_epochs WHERE did=?', h.alice)).toEqual({ epoch: 2 });
  });
});

/** Applies a fake-PDS commit through the production record-proof verifier and projector. */
async function projectLove(h: Harness, rkey: string, live = false) {
  const car = await h.kit.repos.Alice.getRecordCar(LOVE, rkey);
  const proof = await verifyRecordProof(car, {
    did: h.alice,
    collection: LOVE,
    rkey,
    signingKey: h.kit.users.Alice.key.didKey,
  });
  const nowNs = fromMs(h.kit.clock.nowMs());
  return h.db.tx(() =>
    applyRecordProof(h.db, proof, {
      prefix: 'com.example.atmusic',
      nowNs,
      receiptNs: nowNs,
      ...(live ? authorizedLiveOptions(h.db, proof, projectionRandom) : {}),
    }),
  );
}

it('a second love for the same (artist_key, track_key) succeeds without a new record; unlove deletes every matching listed love', async () => {
  await withHarness(async (h) => {
    const first = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Björk', track: 'Hyperballad' },
      origin: 'lastfm',
    });
    if (!first.ok) throw new Error(JSON.stringify(first.reason));
    await h.runUntilIdle();
    // One createRecord; the collection is never listed for a love.
    expect(h.writers.order()).toEqual([CREATE]);
    const created = h.op(first.operation.id);
    expect(created).toMatchObject({ state: 'succeeded', result_uri: `at://${h.alice}/${LOVE}/${created.rkey}` });
    expect((await remoteRecords(h.kit, 'Alice', LOVE)).map((r) => r.rkey)).toEqual([created.rkey]);
    expect((await projectLove(h, created.rkey!, true)).outcome).toBe('applied');
    expect(
      h.db.one<{ path: string }>('SELECT path FROM love_incarnations WHERE uri=?', created.result_uri!)?.path,
    ).toBe('api');
    const linkId = h.link(h.alice, 'lastfm');

    // The same key with other case and spacing: success with the existing record, nothing sent at all.
    const second = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: '  BJÖRK', track: 'hyperballad ' },
      origin: 'lastfm',
    });
    if (!second.ok) throw new Error(JSON.stringify(second.reason));
    await h.runUntilIdle();
    expect(h.writers.order()).toEqual([CREATE]);
    expect(h.op(second.operation.id)).toMatchObject({
      state: 'succeeded',
      attempts: 1,
      result_uri: created.result_uri,
      result_cid: created.result_cid,
    });
    expect(h.op(second.operation.id).rkey).toBe(second.operation.rkey);
    expect(h.op(second.operation.id).rkey).not.toBe(created.rkey);
    expect(h.op(second.operation.id).result_uri).toBe(`at://${h.alice}/${LOVE}/${created.rkey}`);
    const binding = h.db.one<{ uri: string; incarnation_key: string; api_origin: string }>(
      'SELECT uri,incarnation_key,api_origin FROM love_api_bindings WHERE did=? AND operation_id=?',
      h.alice,
      second.operation.id,
    );
    expect(binding).toMatchObject({ uri: created.result_uri, api_origin: 'lastfm' });
    const effect = h.db.one<{ id: string; generation: number }>(
      "SELECT id,generation FROM forward_outbox WHERE link_id=? AND kind='love' AND dedupe_key=?",
      linkId,
      second.operation.id,
    )!;
    expect(
      h.db.one(
        'SELECT 1 FROM love_api_recipient_members WHERE link_id=? AND operation_id=?',
        linkId,
        second.operation.id,
      ),
    ).not.toBeNull();
    settleRows(h.db, [effect.id], 'sent', h.kit.clock.nowMs() + 1, null, true, effect.generation);
    expect(
      h.db.one<{ sent_operation_id: string; state: string }>(
        `SELECT sent_operation_id,state FROM love_api_recipients
         WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?`,
        h.alice,
        created.result_uri,
        binding!.incarnation_key,
        linkId,
        effect.generation,
      ),
    ).toEqual({ sent_operation_id: second.operation.id, state: 'present' });
    expect(
      h.db.one(
        'SELECT 1 FROM love_api_recipient_members WHERE link_id=? AND operation_id=?',
        linkId,
        second.operation.id,
      ),
    ).toBeNull();
    expect(await remoteRecords(h.kit, 'Alice', LOVE)).toHaveLength(1);

    // Another app wrote a duplicate love of the same track, and a love of another track.
    await h.kit.externalPut('Alice', LOVE, '3kotherapp222', love('björk', 'HYPERBALLAD'));
    await h.kit.externalPut('Alice', LOVE, '3kunrelated22', love('Portishead', 'Roads'));
    const unlove = await enqueueUnlove(h.m, { did: h.alice, artist: 'Björk', track: 'Hyperballad', origin: 'lastfm' });
    if (!unlove.ok) throw new Error(JSON.stringify(unlove.reason));
    expect(unlove.operation).toMatchObject({ kind: 'love.delete', rkey: null });
    const mark = h.writers.sent.length;
    await h.runUntilIdle();
    const sent = h.writers.sent.slice(mark);
    expect(sent.map((s) => s.nsid)).toEqual([LIST, DELETE, DELETE]);
    expect(
      sent
        .filter((s) => s.nsid === DELETE)
        .map((s) => s.body?.rkey)
        .sort(),
    ).toEqual(['3kotherapp222', created.rkey].sort());
    expect(sent.filter((s) => s.nsid === DELETE).every((s) => typeof s.body?.swapRecord === 'string')).toBe(true);
    expect(
      h.db.all('SELECT state,expected_cid FROM love_delete_bridges WHERE operation_id=?', unlove.operation.id),
    ).toHaveLength(2);
    expect(h.op(unlove.operation.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
    expect((await remoteRecords(h.kit, 'Alice', LOVE)).map((r) => r.rkey)).toEqual(['3kunrelated22']);
    // The API delete bridge survives operation and outbox pruning; delayed
    // live proof echoes consume it without adding per-target unlove rows.
    const bridgeTargets = h.db.all<{ uri: string }>(
      'SELECT uri FROM love_delete_bridges WHERE operation_id=? ORDER BY uri',
      unlove.operation.id,
    );
    expect(bridgeTargets).toHaveLength(2);
    h.db.run('DELETE FROM operations WHERE id=?', unlove.operation.id);
    h.db.run('DELETE FROM forward_outbox');
    for (const target of bridgeTargets) {
      const rkey = target.uri.split('/').at(-1)!;
      expect((await projectLove(h, rkey, true)).outcome).toBe('absent');
    }
    expect(h.db.all('SELECT * FROM forward_outbox')).toHaveLength(0);
    expect(h.db.all('SELECT state FROM love_delete_bridges WHERE operation_id=?', unlove.operation.id)).toEqual([
      { state: 'consumed' },
      { state: 'consumed' },
    ]);
  });
});

for (const origin of ['web', 'lastfm', 'listenbrainz'] as const) {
  it(`binds a reused snapshot love with its exact ${origin} source through operation GC and file reopen`, async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const projectionRkey = '3ksnapshotbound';
      await h.kit.externalPut('Alice', LOVE, projectionRkey, love('Bound artist', 'Bound track'));
      expect((await projectLove(h, projectionRkey)).outcome).toBe('applied');
      const projectionUri = `at://${h.alice}/${LOVE}/${projectionRkey}`;
      expect(h.db.one<{ path: string }>('SELECT path FROM love_incarnations WHERE uri=?', projectionUri)).toEqual({
        path: 'snapshot',
      });
      const linkId = h.link(h.alice, 'lastfm');
      const apiPathTrace = traceDb(h.db);
      h.m = {
        ...h.m,
        db: apiPathTrace.db,
        identity: cachedIdentityResolver(apiPathTrace.db, { transport: h.m.transport, clock: h.m.clock }),
      };
      const reused = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: 'Bound artist', track: 'Bound track' },
        origin,
      });
      if (!reused.ok) throw new Error(JSON.stringify(reused.reason));
      await h.runUntilIdle();
      if (origin === 'web' && process.env.FINDING32_API_PHASE_TRACE_FILE !== undefined) {
        const metric = apiPathTrace.result();
        const boundRecipients =
          h.db.one<{ n: number }>('SELECT count(*) AS n FROM love_api_recipients WHERE did=?', h.alice)?.n ?? 0;
        const apiTransactionRows = metric.transactions.filter(
          (row) =>
            row.name.includes('enqueueLove') ||
            row.name.includes('bindApiLoveOperation') ||
            row.nestedOwners.some((owner) => owner.includes('bindApiLoveOperation')),
        );
        writeFileSync(
          process.env.FINDING32_API_PHASE_TRACE_FILE,
          JSON.stringify({ boundRecipients, apiTransactionRows, lifecycleInformational: metric }, null, 2),
          'utf8',
        );
      }
      if (origin === 'web') {
        const metric = apiPathTrace.result();
        const boundRecipients =
          h.db.one<{ n: number }>('SELECT count(*) AS n FROM love_api_recipients WHERE did=?', h.alice)?.n ?? 0;
        const addedReads = metric.reads - API_PARENT_REUSE_TRACE.reads;
        const addedChangedRows = metric.changedRows - API_PARENT_REUSE_TRACE.changedRows;
        expect(
          () => assertApiPathBounds(1, addedReads, addedChangedRows),
          JSON.stringify({
            source: API_PARENT_REUSE_TRACE.source,
            baseline: API_PARENT_REUSE_TRACE,
            current: metric,
            boundRecipients,
          }),
        ).not.toThrow();
      }
      const binding = h.db.one<{ api_origin: string; uri: string; incarnation_key: string }>(
        'SELECT api_origin,uri,incarnation_key FROM love_api_bindings WHERE did=? AND operation_id=?',
        h.alice,
        reused.operation.id,
      );
      expect(binding).toMatchObject({ api_origin: origin, uri: projectionUri });
      expect(
        h.db.one(
          'SELECT 1 FROM love_api_recipient_members WHERE link_id=? AND operation_id=?',
          linkId,
          reused.operation.id,
        ),
      ).not.toBeNull();
      h.db.run('DELETE FROM operations WHERE id=?', reused.operation.id);
      h.restart();
      expect(
        h.db.one<{ api_origin: string; uri: string; incarnation_key: string }>(
          'SELECT api_origin,uri,incarnation_key FROM love_api_bindings WHERE did=? AND operation_id=?',
          h.alice,
          reused.operation.id,
        ),
      ).toEqual(binding);
      expect(h.db.one('SELECT 1 FROM operations WHERE id=?', reused.operation.id)).toBeNull();
    });
  });
}

for (const recipientCount of [0, 2] as const) {
  it(`traces actual reused-snapshot API acceptance with ${recipientCount} recipient links`, async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const projectionRkey = `3kapi${recipientCount}bound`;
      await h.kit.externalPut('Alice', LOVE, projectionRkey, love('Bound artist', 'Bound track'));
      expect((await projectLove(h, projectionRkey)).outcome).toBe('applied');
      if (recipientCount > 0) h.link(h.alice, 'listenbrainz');
      if (recipientCount > 1) h.link(h.alice, 'lastfm');
      const apiPathTrace = traceDb(h.db);
      h.m = {
        ...h.m,
        db: apiPathTrace.db,
        identity: cachedIdentityResolver(apiPathTrace.db, { transport: h.m.transport, clock: h.m.clock }),
      };
      const accepted = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: 'Bound artist', track: 'Bound track' },
        origin: 'web',
      });
      if (!accepted.ok) throw new Error(JSON.stringify(accepted.reason));
      await h.runUntilIdle();
      const actualRecipients =
        h.db.one<{ n: number }>('SELECT count(*) AS n FROM love_api_recipients WHERE did=?', h.alice)?.n ?? 0;
      expect(actualRecipients).toBe(recipientCount);
      const metric = apiPathTrace.result();
      const parent = API_PARENT_SCALE_TRACE[recipientCount];
      const addedReads = metric.reads - parent.reads;
      const addedChangedRows = metric.changedRows - parent.changedRows;
      assertApiPathBounds(recipientCount, addedReads, addedChangedRows);
      if (process.env.FINDING32_API_SCALE_TRACE_DIR !== undefined) {
        writeFileSync(
          `${process.env.FINDING32_API_SCALE_TRACE_DIR}/current-n${recipientCount}.json`,
          JSON.stringify({ recipientCount, parent, addedReads, addedChangedRows, metric }, null, 2),
          'utf8',
        );
      }
    });
  });
}

it('traces the actual API love partial-delete comparison hook transaction', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    h.link(h.alice, 'lastfm');
    const rkey = '3kpartialmeter';
    await h.kit.externalPut('Alice', LOVE, rkey, love('Meter artist', 'Meter track'));
    expect((await projectLove(h, rkey)).outcome).toBe('applied');
    const reused = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Meter artist', track: 'Meter track' },
      origin: 'web',
    });
    if (!reused.ok) throw new Error(JSON.stringify(reused.reason));
    await h.runUntilIdle();

    await h.kit.externalDelete('Alice', LOVE, rkey);
    const absentCar = await h.kit.repos.Alice.getRecordCar(LOVE, rkey);
    const absentProof = await verifyRecordProof(absentCar, {
      did: h.alice,
      collection: LOVE,
      rkey,
      signingKey: h.kit.users.Alice.key.didKey,
    });
    const traced = traceDb(h.db);
    recordLiveEvidence(
      traced.db,
      {
        uri: `at://${h.alice}/${LOVE}/${rkey}`,
        did: h.alice,
        collection: LOVE,
        rkey,
        rev: absentProof.commit.rev,
        action: 'delete',
      },
      h.m.clock.nowMs(),
    );
    const nowNs = fromMs(h.m.clock.nowMs());
    const applyOptions = authorizedLiveOptions(traced.db, absentProof, projectionRandom);
    const result = traced.db.tx(() =>
      applyRecordProof(traced.db, absentProof, {
        ...applyOptions,
        nowNs,
        receiptNs: nowNs,
      }),
    );
    expect(result.outcome).toBe('absent');
    const metric = traced.result();
    if (process.env.FINDING32_PARTIAL_DELETE_TRACE_FILE !== undefined)
      writeFileSync(
        process.env.FINDING32_PARTIAL_DELETE_TRACE_FILE,
        JSON.stringify({ metric, result, fact: h.db.one('SELECT * FROM love_api_comparison_facts') }, null, 2),
        'utf8',
      );
    const factHook = metric.transactions.find((transaction) =>
      transaction.name.includes('recordLoveApiComparisonFact'),
    );
    expect(factHook).toBeDefined();
    const loveApiStatements = metric.statements.filter((statement) =>
      statement.source.includes('/forward/love-api-recipients.ts:'),
    );
    const completeHook = {
      reads: loveApiStatements.filter((statement) => !/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement.sql))
        .length,
      mutationStatements: loveApiStatements.filter((statement) =>
        /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement.sql),
      ).length,
      changedRows: loveApiStatements.reduce((sum, statement) => sum + statement.changedRows, 0),
    };
    // The fact-owner hook has its own 2/3/2 charge; the complete source-file
    // total also includes prepare/seal decision effects and must stay visible.
    expect(factHook).toMatchObject({ reads: 1, mutationStatements: 3, changedRows: 2 });
    expect(completeHook).toEqual({ reads: 3, mutationStatements: 5, changedRows: 4 });
    expect({
      reads: metric.reads - API_PARENT_PARTIAL_DELETE_TRACE.reads,
      mutationStatements: metric.mutationStatements - API_PARENT_PARTIAL_DELETE_TRACE.mutationStatements,
      changedRows: metric.changedRows - API_PARENT_PARTIAL_DELETE_TRACE.changedRows,
    }).toEqual({ reads: 3, mutationStatements: 6, changedRows: 5 });
  });
});

it('binds an API operation to a present import incarnation without treating API origin as an exclusion', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const projectionRkey = '3kimportbound';
    await h.kit.externalPut('Alice', LOVE, projectionRkey, love('Imported bound artist', 'Imported bound track'));
    h.db.run(
      `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
       VALUES(?,?,'import','lastfm',?,101)`,
      h.alice,
      `love-uri:${h.alice}:${LOVE}:${projectionRkey}`,
      h.kit.clock.nowMs(),
    );
    expect((await projectLove(h, projectionRkey)).outcome).toBe('applied');
    const projectionUri = `at://${h.alice}/${LOVE}/${projectionRkey}`;
    expect(
      h.db.one<{ path: string; source_service: string | null }>(
        'SELECT path,source_service FROM love_incarnations WHERE uri=?',
        projectionUri,
      ),
    ).toEqual({ path: 'import', source_service: 'lastfm' });
    const linkId = h.link(h.alice, 'lastfm');
    const reused = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Imported bound artist', track: 'Imported bound track' },
      origin: 'lastfm',
    });
    if (!reused.ok) throw new Error(JSON.stringify(reused.reason));
    await h.runUntilIdle();
    expect(
      h.db.one<{ api_origin: string }>(
        'SELECT api_origin FROM love_api_bindings WHERE did=? AND operation_id=?',
        h.alice,
        reused.operation.id,
      ),
    ).toEqual({ api_origin: 'lastfm' });
    expect(
      h.db.one(
        'SELECT 1 FROM love_api_recipient_members WHERE link_id=? AND operation_id=?',
        linkId,
        reused.operation.id,
      ),
    ).not.toBeNull();
  });
});

it('forwards a live deletion of an API-created love, and routes imported love deletion away from its source', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const lastfm = h.link(h.alice, 'lastfm');
    const listenbrainz = h.link(h.alice, 'listenbrainz');

    const apiPut = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'API artist', track: 'API track' },
      origin: 'web',
    });
    if (!apiPut.ok) throw new Error(JSON.stringify(apiPut.reason));
    await h.runUntilIdle();
    const apiRecord = h.op(apiPut.operation.id);
    expect((await projectLove(h, apiRecord.rkey!, true)).outcome).toBe('applied');
    await h.kit.externalDelete('Alice', LOVE, apiRecord.rkey!);
    expect((await projectLove(h, apiRecord.rkey!, true)).outcome).toBe('absent');

    const importedRkey = '3kimported01';
    await h.kit.externalPut('Alice', LOVE, importedRkey, love('Imported artist', 'Imported track'));
    h.db.run(
      `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
       VALUES (?,?,'import','lastfm',?,101)`,
      h.alice,
      `love-uri:${h.alice}:${LOVE}:${importedRkey}`,
      h.kit.clock.nowMs(),
    );
    expect((await projectLove(h, importedRkey, true)).outcome).toBe('applied');
    expect(
      h.db.one<{ source_service: string | null }>(
        'SELECT source_service FROM love_incarnations WHERE uri=?',
        `at://${h.alice}/${LOVE}/${importedRkey}`,
      ),
    ).toEqual({ source_service: 'lastfm' });
    expect(
      h.db.one(
        'SELECT 1 FROM love_api_bindings WHERE did=? AND uri=?',
        h.alice,
        `at://${h.alice}/${LOVE}/${importedRkey}`,
      ),
    ).toBeNull();
    await h.kit.externalDelete('Alice', LOVE, importedRkey);
    expect((await projectLove(h, importedRkey, true)).outcome).toBe('absent');

    const unknownRkey = '3kunknown001';
    await h.kit.externalPut('Alice', LOVE, unknownRkey, love('Unknown source', 'Unknown track'));
    h.db.run(
      `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
       VALUES (?,?,'import',NULL,?,102)`,
      h.alice,
      `love-uri:${h.alice}:${LOVE}:${unknownRkey}`,
      h.kit.clock.nowMs(),
    );
    expect((await projectLove(h, unknownRkey, true)).outcome).toBe('applied');
    await h.kit.externalDelete('Alice', LOVE, unknownRkey);
    expect((await projectLove(h, unknownRkey, true)).outcome).toBe('absent');

    const forwards = h.db.all<{ link_id: string; kind: string }>(
      "SELECT link_id,kind FROM forward_outbox WHERE kind IN ('love','unlove') ORDER BY rowid",
    );
    expect(forwards).toEqual([
      { link_id: lastfm, kind: 'love' },
      { link_id: listenbrainz, kind: 'love' },
      { link_id: lastfm, kind: 'unlove' },
      { link_id: listenbrainz, kind: 'unlove' },
      { link_id: listenbrainz, kind: 'unlove' },
    ]);
  });
});

it('reconstructs API source and trusted authority from retained L2 after operation, outbox, and A2 cleanup', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const linkId = h.link(h.alice, 'lastfm');
    const created = await enqueueLove(h.m, {
      did: h.alice,
      input: {
        artist: 'Proof artist',
        track: 'Proof track',
        album: 'Proof album',
        recordingMbid: '12345678-1234-1234-1234-123456789abc',
      },
      origin: 'listenbrainz',
    });
    if (!created.ok) throw new Error(JSON.stringify(created.reason));
    await h.runUntilIdle();
    const op = h.op(created.operation.id);
    expect((await projectLove(h, op.rkey!, true)).outcome).toBe('applied');
    const uri = `at://${h.alice}/${LOVE}/${op.rkey}`;
    const incarnation = h.db.one<{ incarnation_key: string }>(
      "SELECT incarnation_key FROM love_incarnations WHERE uri=? AND state='present'",
      uri,
    );
    expect(incarnation).not.toBeNull();
    expect(h.db.one('SELECT api_origin FROM love_api_bindings WHERE did=? AND operation_id=?', h.alice, op.id)).toEqual(
      {
        api_origin: 'listenbrainz',
      },
    );
    expect(
      h.db.one(
        'SELECT path FROM forward_admissions WHERE did=? AND identity_key=?',
        h.alice,
        `love-uri:${h.alice}:${LOVE}:${op.rkey}`,
      ),
    ).toBeNull();
    const effect = h.db.one<{ id: string; generation: number; kind: string; state: string; dedupe_key: string }>(
      "SELECT id,generation,kind,state,dedupe_key FROM forward_outbox WHERE link_id=? AND kind='love' AND dedupe_key=?",
      linkId,
      op.id,
    );
    expect(effect).not.toBeNull();
    expect(h.db.one('SELECT operation_id FROM love_api_recipient_members')).toEqual({ operation_id: op.id });
    settleRows(h.db, [effect!.id], 'sent', h.m.clock.nowMs(), null, true, effect!.generation);
    expect(h.db.one('SELECT sent_operation_id FROM love_api_recipients')).toEqual({ sent_operation_id: op.id });
    h.db.run('DELETE FROM operations WHERE id=?', op.id);
    h.db.run('DELETE FROM forward_outbox WHERE id=?', effect!.id);
    expect(h.db.one('SELECT 1 FROM operations WHERE id=?', op.id)).toBeNull();
    expect(h.db.one('SELECT 1 FROM forward_outbox WHERE id=?', effect!.id)).toBeNull();
    expect(h.db.one('SELECT api_origin FROM love_api_bindings WHERE did=? AND operation_id=?', h.alice, op.id)).toEqual(
      {
        api_origin: 'listenbrainz',
      },
    );

    await h.kit.externalDelete('Alice', LOVE, op.rkey!);
    const car = await h.kit.repos.Alice.getRecordCar(LOVE, op.rkey!);
    const proof = await verifyRecordProof(car, {
      did: h.alice,
      collection: LOVE,
      rkey: op.rkey!,
      signingKey: h.kit.users.Alice.key.didKey,
    });
    expect(proof.state).toBe('absent');
    recordLiveEvidence(
      h.db,
      { uri, did: h.alice, collection: LOVE, rkey: op.rkey!, rev: proof.commit.rev, action: 'delete' },
      h.m.clock.nowMs(),
    );
    expect((await projectLove(h, op.rkey!, true)).outcome).toBe('absent');
    expect(h.db.one('SELECT state FROM love_api_recipients')).toEqual({ state: 'sealed' });
    expect(
      h.db.one<{
        authorization_rev: string;
        fact_action: string;
        fact_cid: string;
        expires_at_ms: number;
        payload_json: string;
      }>('SELECT authorization_rev,fact_action,fact_cid,expires_at_ms,payload_json FROM love_api_unlove_decisions'),
    ).toMatchObject({
      authorization_rev: proof.commit.rev,
      fact_action: 'delete',
      fact_cid: '',
      payload_json: JSON.stringify({
        artist: 'Proof artist',
        track: 'Proof track',
        album: 'Proof album',
        recordingMbid: '12345678-1234-1234-1234-123456789abc',
        origin: 'listenbrainz',
      }),
    });
    expect(
      h.db.one('SELECT 1 FROM love_api_comparison_facts WHERE authorization_rev=?', proof.commit.rev),
    ).not.toBeNull();
    expect(h.db.one('SELECT 1 FROM linked_accounts WHERE id=?', linkId)).not.toBeNull();
    const alias = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Alias artist', track: 'Alias track', recordingMbid: '12345678-1234-1234-1234-123456789abc' },
      origin: 'web',
    });
    if (!alias.ok) throw new Error(JSON.stringify(alias.reason));
    const candidate = {
      did: h.alice,
      uri,
      incarnationKey: incarnation!.incarnation_key,
      linkId,
      generation: effect!.generation,
    };
    expect(prepareLoveApiRecipientHandoff(h.db, candidate, 'composition-after-proof', h.m.clock.nowMs())).toEqual({
      status: 'awaiting',
    });
    h.db.run('DELETE FROM operations WHERE id=?', alias.operation.id);
    h.db.run("DELETE FROM forward_outbox WHERE link_id=? AND kind='love' AND dedupe_key=?", linkId, alias.operation.id);
    expect(prepareLoveApiRecipientHandoff(h.db, candidate, 'composition-after-proof', h.m.clock.nowMs())).toEqual({
      status: 'vetoed',
    });
    h.db.run('DELETE FROM linked_love_intents WHERE did=? AND operation_id=?', h.alice, alias.operation.id);
    bumpLoveApiIntentEpoch(h.db, h.alice);
    expect(
      h.db.one(
        'SELECT action,cid,conflicted FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=?',
        uri,
        proof.commit.rev,
      ),
    ).toEqual({ action: 'delete', cid: '', conflicted: 0 });
    h.db.run('DELETE FROM live_pending_removal_events WHERE uri=? AND rev=?', uri, proof.commit.rev);
    h.db.run(
      'DELETE FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
      uri,
      proof.commit.rev,
    );
    expect(
      h.db.one('SELECT 1 FROM live_pending_removal_events WHERE uri=? AND rev=?', uri, proof.commit.rev),
    ).toBeNull();
    expect(
      h.db.one(
        'SELECT 1 FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
        uri,
        proof.commit.rev,
      ),
    ).toBeNull();
    const materializerTrace = traceDb(h.db);
    const materialized = materializeLoveApiRecipientDecisions(
      materializerTrace.db,
      h.m.clock.nowMs(),
      h.m.random,
      'composition-after-proof',
    );
    const materializerCost = materializerTrace.result();
    expect(materialized).toMatchObject({ visited: 1, queued: 1, deferred: 0, replay: 0, refused: 0 });
    expect(
      h.db.one(
        'SELECT action,cid,state FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
        uri,
        proof.commit.rev,
      ),
    ).toEqual({ action: 'delete', cid: '', state: 'active' });
    expect(materializerCost.changedRows, JSON.stringify(materializerCost)).toBeLessThanOrEqual(28);
    if (process.env.FINDING32_L2_COST_TRACE === '1')
      console.info(`L2_ACTUAL_CREATED_DECISION_TRACE ${JSON.stringify({ ...materializerCost, ...materialized })}`);
    const recipientOperationId = `love-delete:${incarnation!.incarnation_key}:rev:${proof.commit.rev}:api-recipient`;
    expect(
      h.db.one<{ kind: string; dedupe_key: string; state: string }>(
        "SELECT kind,dedupe_key,state FROM forward_outbox WHERE link_id=? AND kind='unlove' AND dedupe_key=?",
        linkId,
        recipientOperationId,
      ),
    ).toMatchObject({ kind: 'unlove', dedupe_key: recipientOperationId, state: 'queued' });
    expect(h.db.one('SELECT 1 FROM love_api_unlove_decisions')).toBeNull();
    expect(h.db.one('SELECT state FROM love_api_recipients')).toEqual({ state: 'released' });
  });
});

it('delayed signed absence seals the exact pending API member and waits for its SENT settlement', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    h.link(h.alice, 'lastfm');
    const created = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Delayed exact API', track: 'Wait for SENT' },
      origin: 'web',
    });
    if (!created.ok) throw new Error(JSON.stringify(created.reason));
    await h.runUntilIdle();
    const operation = h.op(created.operation.id);
    if (operation.rkey === null) throw new Error('API love has no accepted rkey');
    const presentCar = await h.kit.repos.Alice.getRecordCar(LOVE, operation.rkey);
    const presentProof = await verifyRecordProof(presentCar, {
      did: h.alice,
      collection: LOVE,
      rkey: operation.rkey,
      signingKey: h.kit.users.Alice.key.didKey,
    });
    expect(presentProof.state).toBe('present');
    if (presentProof.state !== 'present') throw new Error('expected signed present proof');
    expect((await projectLove(h, operation.rkey, true)).outcome).toBe('applied');
    const uri = `at://${h.alice}/${LOVE}/${operation.rkey}`;
    const incarnation = h.db.one<{ incarnation_key: string }>(
      "SELECT incarnation_key FROM love_incarnations WHERE uri=? AND state='present'",
      uri,
    )!;
    const loveRow = h.db.one<{
      uri: string;
      cid: string;
      artist_key: string;
      track_key: string;
      artist: string;
      track: string;
      recording_mbid: string | null;
    }>('SELECT uri,cid,artist_key,track_key,artist,track,recording_mbid FROM loves WHERE uri=?', uri)!;
    const effect = h.db.one<{ id: string; generation: number; link_id: string }>(
      "SELECT id,generation,link_id FROM forward_outbox WHERE kind='love' AND dedupe_key=?",
      operation.id,
    )!;
    expect(h.db.one('SELECT operation_id FROM love_api_recipient_members WHERE link_id=?', effect.link_id)).toEqual({
      operation_id: operation.id,
    });
    const removal = await h.kit.externalDelete('Alice', LOVE, operation.rkey);
    const absentCar = await h.kit.repos.Alice.getRecordCar(LOVE, operation.rkey);
    const absentProof = await verifyRecordProof(absentCar, {
      did: h.alice,
      collection: LOVE,
      rkey: operation.rkey,
      signingKey: h.kit.users.Alice.key.didKey,
    });
    expect(absentProof.state).toBe('absent');
    if (absentProof.state !== 'absent') throw new Error('expected signed absent proof');
    expect(removal.rev).toBe(absentProof.commit.rev);
    expect((await projectLove(h, operation.rkey, false)).outcome).toBe('absent');
    recordPendingRemoval(h.db, {
      did: h.alice,
      uri,
      kind: 'love',
      row: {
        uri: loveRow.uri,
        record_uri: null,
        listen_id: null,
        cid: loveRow.cid,
        listened_at: '',
        artist_key: loveRow.artist_key,
        track_key: loveRow.track_key,
        artist: loveRow.artist,
        track: loveRow.track,
        recording_mbid: loveRow.recording_mbid,
      },
      identityKey: incarnation.incarnation_key,
      windowLo: presentProof.commit.rev,
      windowHi: absentProof.commit.rev,
      replacedByCid: null,
      nowMs: h.m.clock.nowMs(),
    });
    recordLiveEvidence(
      h.db,
      { uri, did: h.alice, collection: LOVE, rkey: operation.rkey, rev: absentProof.commit.rev, action: 'delete' },
      h.m.clock.nowMs(),
    );
    authorizePendingRemovals(h.db, { uri, rev: absentProof.commit.rev, action: 'delete' }, h.m.clock.nowMs());
    const executed = executeAuthorizedRemovals(h.db, { uri, nowMs: h.m.clock.nowMs(), random: h.m.random, limit: 1 });
    expect(executed.groups).toBe(1);
    expect(h.db.one('SELECT state,sent_operation_id FROM love_api_recipients WHERE uri=?', uri)).toEqual({
      state: 'sealed',
      sent_operation_id: null,
    });
    expect(h.db.one('SELECT 1 FROM love_api_unlove_decisions WHERE uri=?', uri)).not.toBeNull();
    expect(h.db.all("SELECT id FROM forward_outbox WHERE kind='unlove' AND authorization_uri=?", uri)).toEqual([]);
    expect(
      materializeLoveApiRecipientDecisions(h.db, h.m.clock.nowMs(), h.m.random, 'delayed-before-sent'),
    ).toMatchObject({
      awaiting: 1,
      queued: 0,
      deferred: 0,
    });
    settleRows(h.db, [effect.id], 'sent', h.m.clock.nowMs(), null, true, effect.generation);
    const afterSent = materializeLoveApiRecipientDecisions(
      h.db,
      h.m.clock.nowMs() + 1_000,
      h.m.random,
      'delayed-after-sent',
    );
    expect(afterSent).toMatchObject({
      awaiting: 0,
      deferred: 0,
      queued: 1,
    });
    expect(h.db.one("SELECT kind,state FROM forward_outbox WHERE kind='unlove' AND authorization_uri=?", uri)).toEqual({
      kind: 'unlove',
      state: 'queued',
    });
  });
});

it('binds imported love source to the actual reused URI and preserves it after operation/outbox cleanup', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const lastfm = h.link(h.alice, 'lastfm');
    const listenbrainz = h.link(h.alice, 'listenbrainz');
    const existingRkey = '3kreusedlove1';
    await h.kit.externalPut('Alice', LOVE, existingRkey, love('Imported artist', 'Reused track'));
    expect((await projectLove(h, existingRkey, true)).outcome).toBe('applied');

    const accepted = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Imported artist', track: 'Reused track' },
      origin: 'import',
    });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.reason));
    h.db.run(
      'UPDATE forward_admissions SET source_service=? WHERE did=? AND identity_key=?',
      'lastfm',
      h.alice,
      `love-uri:${h.alice}:${LOVE}:${accepted.operation.rkey}`,
    );
    enqueueForwards(h.db, {
      did: h.alice,
      items: [
        {
          kind: 'love',
          operationId: accepted.operation.id,
          payload: { artist: 'Imported artist', track: 'Reused track', origin: 'import' },
        },
      ],
      excludeSourceService: 'lastfm',
      now: h.kit.clock.nowMs(),
      random: h.m.random,
    });
    await h.runUntilIdle();
    expect(h.op(accepted.operation.id)).toMatchObject({ result_uri: `at://${h.alice}/${LOVE}/${existingRkey}` });
    expect(
      h.db.one<{ uri: string; source_service: string | null; state: string }>(
        'SELECT uri,source_service,state FROM love_import_bridges WHERE did=? AND operation_id=?',
        h.alice,
        accepted.operation.id,
      ),
    ).toEqual({ uri: `at://${h.alice}/${LOVE}/${existingRkey}`, source_service: 'lastfm', state: 'bound' });

    h.db.run('DELETE FROM operations WHERE id=?', accepted.operation.id);
    h.db.run('DELETE FROM forward_outbox');
    await h.kit.externalPut('Alice', LOVE, existingRkey, {
      ...love('Imported artist', 'Reused track'),
      album: 'Changed',
    });
    expect((await projectLove(h, existingRkey, true)).outcome).toBe('applied');
    expect(h.db.all('SELECT * FROM forward_outbox')).toEqual([]);

    await h.kit.externalDelete('Alice', LOVE, existingRkey);
    expect((await projectLove(h, existingRkey, true)).outcome).toBe('absent');
    expect(
      h.db.all<{ link_id: string; kind: string }>(
        "SELECT link_id,kind FROM forward_outbox WHERE kind='unlove' ORDER BY rowid",
      ),
    ).toEqual([{ link_id: listenbrainz, kind: 'unlove' }]);
    expect(h.db.all("SELECT 1 AS hit FROM forward_outbox WHERE link_id=? AND kind='unlove'", lastfm)).toEqual([]);
  });
});

it('does not enqueue a love when the canonical live admission already exists without an incarnation row', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    h.link(h.alice, 'lastfm');
    const rkey = '3kpreexisting01';
    const put = await h.kit.externalPut('Alice', LOVE, rkey, love('Already admitted', 'Jóga'));
    const uri = `at://${h.alice}/${LOVE}/${rkey}`;
    h.db.run(
      `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
       VALUES (?,?,'live',NULL,?,103)`,
      h.alice,
      `love:${uri}:${put.rev}`,
      h.kit.clock.nowMs(),
    );

    expect((await projectLove(h, rkey, true)).outcome).toBe('applied');
    expect(h.db.all('SELECT * FROM forward_outbox')).toEqual([]);
    expect(h.db.one('SELECT path FROM love_incarnations WHERE uri=?', uri)).toEqual({ path: 'live' });
  });
});

it('an API unlove accepted remotely with a lost answer consumes durable target bridges on retry echo', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    h.link(h.alice, 'lastfm');
    await h.kit.externalPut('Alice', LOVE, '3kbridge001', love('Björk', 'Jóga'));
    await projectLove(h, '3kbridge001', true);
    const unlove = await enqueueUnlove(h.m, { did: h.alice, artist: 'Björk', track: 'Jóga', origin: 'web' });
    if (!unlove.ok) throw new Error(JSON.stringify(unlove.reason));
    const lost = h.writers.crashOn(DELETE, 'after_commit');
    void h.run();
    await lost;
    expect(await remoteRecords(h.kit, 'Alice', LOVE)).toHaveLength(0);
    expect(h.db.all('SELECT state FROM love_delete_bridges WHERE operation_id=?', unlove.operation.id)).toEqual([
      { state: 'pending' },
    ]);
    h.restart();
    await h.runUntilIdle();
    expect(h.op(unlove.operation.id).state).toBe('succeeded');
    h.db.run('DELETE FROM operations WHERE id=?', unlove.operation.id);
    h.db.run('DELETE FROM forward_outbox');
    expect((await projectLove(h, '3kbridge001', true)).outcome).toBe('absent');
    expect(h.db.all('SELECT * FROM forward_outbox')).toHaveLength(0);
    expect(h.db.all('SELECT state FROM love_delete_bridges WHERE operation_id=?', unlove.operation.id)).toEqual([
      { state: 'consumed' },
    ]);
  });
});

it('an InvalidSwap obsoletes the old target bridge and does not suppress a later same-URI love lifecycle', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    h.link(h.alice, 'lastfm');
    const rkey = '3kbridge002';
    await h.kit.externalPut('Alice', LOVE, rkey, love('Artist', 'Song'));
    await projectLove(h, rkey, true);
    const unlove = await enqueueUnlove(h.m, { did: h.alice, artist: 'Artist', track: 'Song', origin: 'web' });
    if (!unlove.ok) throw new Error(JSON.stringify(unlove.reason));
    const pause = h.writers.pauseOn(LIST);
    const pending = h.run();
    await pause.reached;
    await h.kit.externalPut('Alice', LOVE, rkey, { ...love('Artist', 'Song'), album: 'New CID' });
    pause.release();
    await pending;
    expect(h.db.all('SELECT state FROM love_delete_bridges WHERE operation_id=?', unlove.operation.id)).toEqual([
      { state: 'obsolete' },
    ]);
    h.db.run('DELETE FROM forward_outbox');
    await h.kit.externalDelete('Alice', LOVE, rkey);
    expect((await projectLove(h, rkey, true)).outcome).toBe('absent');
    await h.kit.externalPut('Alice', LOVE, rkey, love('Artist', 'Song'));
    expect((await projectLove(h, rkey, true)).outcome).toBe('applied');
    await h.kit.externalDelete('Alice', LOVE, rkey);
    expect((await projectLove(h, rkey, true)).outcome).toBe('absent');
    expect(
      h.db.all<{ kind: string }>("SELECT kind FROM forward_outbox WHERE kind IN ('love','unlove') ORDER BY rowid"),
    ).toEqual([{ kind: 'unlove' }, { kind: 'love' }, { kind: 'unlove' }]);
  });
});

it('a love whose create committed before its answer was lost is reconciled at its own rkey by digest, without a listing, and queues its notify hint; an unknown DID is admitted instead', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const r = await enqueueLove(h.m, { did: h.alice, input: { artist: 'A', track: 'B' }, origin: 'web' });
    if (!r.ok) throw new Error(JSON.stringify(r.reason));
    const crashed = h.writers.crashOn(CREATE, 'after_commit');
    void h.run();
    await crashed;
    h.restart();
    await h.runUntilIdle();
    // The second attempt's createRecord finds the record there; getRecord compares digests.
    expect(h.writers.order()).toEqual([CREATE, CREATE, GET]);
    const uri = `at://${h.alice}/${LOVE}/${r.operation.rkey}`;
    const remote = await remoteRecords(h.kit, 'Alice', LOVE);
    expect(remote.map((x) => x.rkey)).toEqual([r.operation.rkey]);
    expect(h.op(r.operation.id)).toMatchObject({
      state: 'succeeded',
      attempts: 2,
      result_uri: uri,
      result_cid: remote[0]!.cid,
    });
    expect(h.db.all('SELECT uri, source FROM hints')).toEqual([{ uri, source: 'notify' }]);
  });

  await withHarness(async (h) => {
    expect(h.db.all('SELECT did FROM users')).toEqual([]);
    const r = await enqueueLove(h.m, { did: h.bob, input: { artist: 'A', track: 'B' }, origin: 'web' });
    if (!r.ok) throw new Error(JSON.stringify(r.reason));
    const crashed = h.writers.crashOn(CREATE, 'after_commit');
    void h.run();
    await crashed;
    h.restart();
    await h.runUntilIdle();
    expect(h.op(r.operation.id)).toMatchObject({ state: 'succeeded', attempts: 2 });
    // The DID is not indexed yet: admitted, so its snapshot indexes the love.
    expect(h.db.all('SELECT did, active FROM users')).toEqual([{ did: h.bob, active: 0 }]);
    expect(h.db.all('SELECT did, kind, state FROM repo_jobs')).toEqual([
      { did: h.bob, kind: 'snapshot', state: 'pending' },
    ]);
    expect(h.db.all('SELECT uri FROM hints')).toEqual([]);
  });
});

it('love.put decides from local state, never listing: an indexed love from another app is reused with no request; love, unlove, love writes a new record; a love the index saw deleted elsewhere is written again', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    // Another app's love, already projected by the index.
    await h.kit.externalPut('Alice', LOVE, '3kotherapp222', love('Portishead', 'Roads'));
    const otherUri = `at://${h.alice}/${LOVE}/3kotherapp222`;
    const otherCid = (await remoteRecords(h.kit, 'Alice', LOVE))[0]!.cid;
    h.db.run(
      `INSERT INTO loves(uri, did, rkey, cid, artist, track, artist_key, track_key, created_at, indexed_at)
       VALUES (?, ?, '3kotherapp222', ?, 'Portishead', 'Roads', 'portishead', 'roads', ?, ?)`,
      otherUri,
      h.alice,
      otherCid,
      '2026-01-15T11:00:00.000000000Z',
      '2026-01-15T11:00:00.000000000Z',
    );
    const reused = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'PORTISHEAD', track: 'roads' },
      origin: 'web',
    });
    if (!reused.ok) throw new Error(JSON.stringify(reused.reason));
    await h.runUntilIdle();
    expect(h.writers.sent).toEqual([]);
    expect(h.op(reused.operation.id)).toMatchObject({
      state: 'succeeded',
      attempts: 1,
      result_uri: otherUri,
      result_cid: otherCid,
    });
    expect(h.db.all('SELECT uri, source FROM hints')).toEqual([{ uri: otherUri, source: 'notify' }]);
    expect((await projectLove(h, '3kotherapp222', true)).outcome).toBe('applied');
    expect(h.db.all('SELECT * FROM forward_outbox')).toHaveLength(0);

    // love, unlove, love of one key, each settled before the next is enqueued (the index has not run):
    // the third must not be taken for the first, which the unlove deleted.
    const ids: string[] = [];
    const rkeys: string[] = [];
    for (const step of ['love', 'unlove', 'love'] as const) {
      const r =
        step === 'love'
          ? await enqueueLove(h.m, { did: h.alice, input: { artist: 'Björk', track: 'Hyperballad' }, origin: 'web' })
          : await enqueueUnlove(h.m, { did: h.alice, artist: 'Björk', track: 'Hyperballad', origin: 'web' });
      if (!r.ok) throw new Error(JSON.stringify(r.reason));
      ids.push(r.operation.id);
      if (r.operation.rkey !== null) rkeys.push(r.operation.rkey);
      await h.runUntilIdle();
    }
    expect(h.writers.order()).toEqual([CREATE, LIST, DELETE, CREATE]);
    expect(ids.map((id) => h.op(id).state)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(h.op(ids[2]!).result_uri).toBe(`at://${h.alice}/${LOVE}/${rkeys[1]}`);
    expect((await remoteRecords(h.kit, 'Alice', LOVE)).map((r) => r.rkey).sort()).toEqual(
      ['3kotherapp222', rkeys[1]!].sort(),
    );

    // Another app deleted our love and the index recorded it absent: the next love is written again.
    const ours = h.op(ids[2]!);
    await h.kit.externalDelete('Alice', LOVE, ours.rkey!);
    h.db.run(
      `INSERT INTO record_state(uri, did, collection, revision, cid, state, verified_at)
       VALUES (?, ?, ?, '3kzzzzzzzzzz2', NULL, 'absent', '2026-01-15T12:00:00.000000000Z')`,
      ours.result_uri,
      h.alice,
      LOVE,
    );
    const again = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Björk', track: 'Hyperballad' },
      origin: 'web',
    });
    if (!again.ok) throw new Error(JSON.stringify(again.reason));
    const mark = h.writers.sent.length;
    await h.runUntilIdle();
    expect(h.writers.sent.slice(mark).map((s) => [s.nsid, s.body?.rkey])).toEqual([[CREATE, again.operation.rkey]]);
    expect(h.op(again.operation.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
    expect((await remoteRecords(h.kit, 'Alice', LOVE)).map((r) => r.rkey).sort()).toEqual(
      ['3kotherapp222', again.operation.rkey!].sort(),
    );
  });
});

it('a verified same-rkey overwrite invalidates an old love success after restart and creates the requested identity at a new persisted rkey', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const rkey = '3kotherapp222';
    const uri = `at://${h.alice}/${LOVE}/${rkey}`;
    await h.kit.externalPut('Alice', LOVE, rkey, love('Artist A', 'Track A'));
    expect((await projectLove(h, rkey)).outcome).toBe('applied');

    const oldSuccess = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Artist A', track: 'Track A' },
      origin: 'web',
    });
    if (!oldSuccess.ok) throw new Error(JSON.stringify(oldSuccess.reason));
    await h.runUntilIdle();
    expect(h.op(oldSuccess.operation.id)).toMatchObject({ state: 'succeeded', result_uri: uri });
    expect(h.writers.sent).toEqual([]);

    // A different valid record at the same URI is verified and replaces the projection.
    await h.kit.externalPut('Alice', LOVE, rkey, love('Artist B', 'Track B'));
    expect((await projectLove(h, rkey)).outcome).toBe('applied');
    expect(h.db.one('SELECT artist, track FROM loves WHERE uri = ?', uri)).toEqual({
      artist: 'Artist B',
      track: 'Track B',
    });

    h.restart();
    const requested = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Artist A', track: 'Track A' },
      origin: 'web',
    });
    if (!requested.ok) throw new Error(JSON.stringify(requested.reason));
    await h.runUntilIdle();

    const createdUri = `at://${h.alice}/${LOVE}/${requested.operation.rkey}`;
    expect(requested.operation.rkey).not.toBe(rkey);
    expect(h.op(requested.operation.id)).toMatchObject({ state: 'succeeded', result_uri: createdUri });
    expect(h.writers.order()).toEqual([CREATE]);
    expect(h.writers.sent[0]?.body).toMatchObject({ rkey: requested.operation.rkey });
    expect(await remoteRecords(h.kit, 'Alice', LOVE)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rkey, value: expect.objectContaining({ artist: 'Artist B', track: 'Track B' }) }),
        expect.objectContaining({
          rkey: requested.operation.rkey,
          value: expect.objectContaining({ artist: 'Artist A', track: 'Track A' }),
        }),
      ]),
    );
  });
});

for (const sequence of ['immediate', 'restart', 'queued'] as const) {
  it(`re-loving an indexed track after unlove creates its persisted key with stale deletion projection (${sequence})`, async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const first = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: 'Artist A', track: 'Track A' },
        origin: 'web',
      });
      if (!first.ok || first.operation.rkey === null) throw new Error('first love was not admitted');
      await h.runUntilIdle();
      expect((await projectLove(h, first.operation.rkey)).outcome).toBe('applied');

      const unlove = await enqueueUnlove(h.m, {
        did: h.alice,
        artist: 'Artist A',
        track: 'Track A',
        origin: 'web',
      });
      if (!unlove.ok) throw new Error('unlove was not admitted');
      if (sequence !== 'queued') {
        await h.runUntilIdle();
        expect(await remoteRecords(h.kit, 'Alice', LOVE)).toHaveLength(0);
        if (sequence === 'restart') h.restart();
      }

      const again = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: 'artist a', track: 'TRACK A' },
        origin: 'web',
      });
      if (!again.ok) throw new Error('re-love was not admitted');
      await h.runUntilIdle();
      const uri = `at://${h.alice}/${LOVE}/${again.operation.rkey}`;
      expect(again.operation.rkey).not.toBe(first.operation.rkey);
      expect(h.op(again.operation.id)).toMatchObject({ state: 'succeeded', result_uri: uri });
      expect(h.writers.order()).toEqual([CREATE, LIST, DELETE, CREATE]);
      expect(h.writers.sent.at(-1)?.body).toMatchObject({ rkey: again.operation.rkey });
      expect(await remoteRecords(h.kit, 'Alice', LOVE)).toEqual([
        expect.objectContaining({ rkey: again.operation.rkey }),
      ]);
    });
  });
}

it('a verified same-key metadata rewrite reuses the current CID without creating another love', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const rkey = '3kotherapp222';
    const uri = `at://${h.alice}/${LOVE}/${rkey}`;
    await h.kit.externalPut('Alice', LOVE, rkey, love('Artist A', 'Track A'));
    await projectLove(h, rkey);
    const oldSuccess = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Artist A', track: 'Track A' },
      origin: 'web',
    });
    if (!oldSuccess.ok) throw new Error(JSON.stringify(oldSuccess.reason));
    await h.runUntilIdle();
    const historicCid = h.op(oldSuccess.operation.id).result_cid;

    await h.kit.externalPut('Alice', LOVE, rkey, {
      ...love('ARTIST A', 'track a'),
      album: 'A verified metadata update',
    });
    await projectLove(h, rkey);
    const currentCid = h.db.one<{ cid: string }>('SELECT cid FROM loves WHERE uri = ?', uri)!.cid;
    expect(currentCid).not.toBe(historicCid);

    h.restart();
    const again = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Artist A', track: 'Track A' },
      origin: 'web',
    });
    if (!again.ok) throw new Error(JSON.stringify(again.reason));
    await h.runUntilIdle();
    expect(h.writers.sent).toEqual([]);
    expect(h.op(again.operation.id)).toMatchObject({ state: 'succeeded', result_uri: uri, result_cid: currentCid });
  });
});

for (const proofState of ['absent', 'excluded'] as const) {
  it(`a verified ${proofState} proof invalidates a historic love success`, async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rkey = '3kotherapp222';
      const uri = `at://${h.alice}/${LOVE}/${rkey}`;
      await h.kit.externalPut('Alice', LOVE, rkey, love('Artist A', 'Track A'));
      await projectLove(h, rkey);
      const oldSuccess = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: 'Artist A', track: 'Track A' },
        origin: 'web',
      });
      if (!oldSuccess.ok) throw new Error(JSON.stringify(oldSuccess.reason));
      await h.runUntilIdle();
      expect(h.op(oldSuccess.operation.id).result_uri).toBe(uri);

      if (proofState === 'absent') {
        await h.kit.externalDelete('Alice', LOVE, rkey);
        expect((await projectLove(h, rkey)).outcome).toBe('absent');
      } else {
        await h.kit.externalPut('Alice', LOVE, rkey, love('', 'Track A'));
        expect((await projectLove(h, rkey)).outcome).toBe('excluded');
      }

      h.restart();
      const requested = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: 'Artist A', track: 'Track A' },
        origin: 'web',
      });
      if (!requested.ok) throw new Error(JSON.stringify(requested.reason));
      await h.runUntilIdle();
      expect(requested.operation.rkey).not.toBe(rkey);
      expect(h.op(requested.operation.id)).toMatchObject({
        state: 'succeeded',
        result_uri: `at://${h.alice}/${LOVE}/${requested.operation.rkey}`,
      });
      expect(h.writers.order()).toEqual([CREATE]);
    });
  });
}

it('a successful but unindexed love remains reusable after restart', async () => {
  await withHarness(async (h) => {
    const first = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Artist A', track: 'Track A' },
      origin: 'web',
    });
    if (!first.ok) throw new Error(JSON.stringify(first.reason));
    await h.runUntilIdle();
    const firstRow = h.op(first.operation.id);
    expect(firstRow.state).toBe('succeeded');
    expect(h.db.one('SELECT uri FROM record_state WHERE uri = ?', firstRow.result_uri)).toBeNull();
    expect(h.writers.order()).toEqual([CREATE]);

    h.restart();
    const second = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'artist a', track: 'track a' },
      origin: 'web',
    });
    if (!second.ok) throw new Error(JSON.stringify(second.reason));
    await h.runUntilIdle();
    expect(h.op(second.operation.id)).toMatchObject({
      state: 'succeeded',
      attempts: 1,
      result_uri: firstRow.result_uri,
      result_cid: firstRow.result_cid,
    });
    expect(h.writers.order()).toEqual([CREATE]);
    expect(await remoteRecords(h.kit, 'Alice', LOVE)).toHaveLength(1);
  });
});

it('with more than 10,000 love records a love.put sends one createRecord and an unlove walks every listing page, deleting each match once', async () => {
  await withHarness(async (h) => {
    const n = 10_050;
    for (let start = 0; start < n; start += 1_000) {
      const ops = Array.from({ length: Math.min(1_000, n - start) }, (_, i) => ({
        action: 'put' as const,
        collection: LOVE,
        rkey: `3kbulk${String(start + i).padStart(7, '0')}`,
        record: love(`Bulk ${start + i}`, 'Song'),
      }));
      await h.kit.repos.Alice.writes(ops);
    }
    // Two other-app loves of the key, at the newest and the oldest end of the listing.
    await h.kit.externalPut('Alice', LOVE, '3kzzzzzzzzzz2', love('Björk', 'Hyperballad'));
    await h.kit.externalPut('Alice', LOVE, '3kaaaaaaaaaa2', love('BJÖRK', 'hyperballad'));

    const put = await enqueueLove(h.m, { did: h.alice, input: { artist: 'Air', track: 'La femme' }, origin: 'web' });
    if (!put.ok) throw new Error(JSON.stringify(put.reason));
    await h.runUntilIdle();
    expect(h.writers.order()).toEqual([CREATE]);
    expect(h.op(put.operation.id)).toMatchObject({ state: 'succeeded', attempts: 1 });

    const unlove = await enqueueUnlove(h.m, { did: h.alice, artist: 'Björk', track: 'Hyperballad', origin: 'web' });
    if (!unlove.ok) throw new Error(JSON.stringify(unlove.reason));
    const mark = h.writers.sent.length;
    await h.runUntilIdle();
    const sent = h.writers.sent.slice(mark);
    // 10,053 records: 101 pages of 100, each requested once, and one delete per match.
    expect(sent.filter((s) => s.nsid === LIST)).toHaveLength(101);
    expect(sent.filter((s) => s.nsid === DELETE).map((s) => s.body?.rkey)).toEqual(['3kzzzzzzzzzz2', '3kaaaaaaaaaa2']);
    expect(h.op(unlove.operation.id)).toMatchObject({ state: 'succeeded', attempts: 1, last_error: null });
    const left = await remoteRecords(h.kit, 'Alice', LOVE);
    expect(left).toHaveLength(n + 1);
    expect(left.some((r) => r.rkey === '3kzzzzzzzzzz2' || r.rkey === '3kaaaaaaaaaa2')).toBe(false);
  });
}, 120_000);
