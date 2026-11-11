// Loves through the server outbox (ADR 0005 §5.8, §6.3, §7.8; N2-05): one
// love per (artist_key, track_key), and unlove mirrors unfollow.

import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../../src/do/db';
import { recordLiveEvidence } from '../../../src/do/ingest/live-evidence';
import {
  authorizePendingRemovals,
  executeAuthorizedRemovals,
  recordPendingRemovals,
} from '../../../src/do/ingest/live-pending-removals';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { settleRows } from '../../../src/forward/forward-outbox';
import { reclaimLoveApiProofRows } from '../../../src/forward/love-api-maintenance';
import { materializeLoveApiRecipientDecisions } from '../../../src/forward/love-api-materializer';
import { enqueueLove } from '../../../src/outbox/love-ops';
import { cancelUnsentForDid } from '../../../src/outbox/operations';
import { authorizedLiveOptions } from '../../write/support';
import { type Harness, LOVE, withHarness } from './support';

const projectionRandom = seededRandom(27);
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

it.each([false, true])('keeps broad-covered producer order single-effect early=%s', async (early) => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    h.link(h.alice, 'lastfm');
    const created = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Late artist', track: 'Late track' },
      origin: 'web',
    });
    if (!created.ok) throw Error('enqueue');
    await h.runUntilIdle();
    const op = h.op(created.operation.id);
    await projectLove(h, op.rkey!, true);
    const effect = h.db.one<{ id: string; generation: number }>(
      "SELECT id,generation FROM forward_outbox WHERE kind='love' AND dedupe_key=?",
      op.id,
    )!;
    if (early) settleRows(h.db, [effect.id], 'sent', h.m.clock.nowMs(), null, true, effect.generation);
    await h.kit.externalDelete('Alice', LOVE, op.rkey!);
    const car = await h.kit.repos.Alice.getRecordCar(LOVE, op.rkey!);
    const proof = await verifyRecordProof(car, {
      did: h.alice,
      collection: LOVE,
      rkey: op.rkey!,
      signingKey: h.kit.users.Alice.key.didKey,
    });
    recordLiveEvidence(
      h.db,
      {
        uri: `at://${h.alice}/${LOVE}/${op.rkey}`,
        did: h.alice,
        collection: LOVE,
        rkey: op.rkey!,
        rev: proof.commit.rev,
        action: 'delete',
      },
      h.m.clock.nowMs(),
    );
    expect((await projectLove(h, op.rkey!, true)).outcome).toBe('absent');
    const pending = h.db.one<{ sent_operation_id: string | null }>(
      'SELECT sent_operation_id FROM love_api_recipients WHERE uri=?',
      `at://${h.alice}/${LOVE}/${op.rkey}`,
    );
    expect(pending).not.toBeNull();
    const incarnationKey = h.db.one<{ incarnation_key: string }>(
      'SELECT incarnation_key FROM love_incarnations WHERE uri=?',
      `at://${h.alice}/${LOVE}/${op.rkey}`,
    )!.incarnation_key;
    const broadOperationId = `love-delete:${incarnationKey}:rev:${proof.commit.rev}`;
    expect(h.db.one('SELECT state FROM love_api_recipients WHERE uri=?', `at://${h.alice}/${LOVE}/${op.rkey}`)).toEqual(
      {
        state: 'released',
      },
    );
    expect(
      h.db.one('SELECT 1 FROM love_api_unlove_decisions WHERE uri=?', `at://${h.alice}/${LOVE}/${op.rkey}`),
    ).toBeNull();
    expect(
      h.db.one<{ kind: string; dedupe_key: string; state: string }>(
        "SELECT kind,dedupe_key,state FROM forward_outbox WHERE kind='unlove' AND authorization_uri=?",
        `at://${h.alice}/${LOVE}/${op.rkey}`,
      ),
    ).toEqual({ kind: 'unlove', dedupe_key: broadOperationId, state: 'queued' });
    if (!early) expect(pending!.sent_operation_id).toBeNull();
    if (!early) {
      expect(materializeLoveApiRecipientDecisions(h.db, h.m.clock.nowMs(), h.m.random, 'audit')).toMatchObject({
        visited: 0,
        awaiting: 0,
        queued: 0,
        deferred: 0,
      });
    }
    if (!early) settleRows(h.db, [effect.id], 'sent', h.m.clock.nowMs(), null, true, effect.generation);
    const result = materializeLoveApiRecipientDecisions(h.db, h.m.clock.nowMs(), h.m.random, 'audit');
    expect(result).toMatchObject({ visited: 0, queued: 0, deferred: 0, replay: 0 });
    expect(
      h.db.one(
        "SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove' AND authorization_uri=?",
        `at://${h.alice}/${LOVE}/${op.rkey}`,
      ),
    ).toEqual({ n: 1 });
  });
});

it.each(['direct', 'delayed'] as const)(
  'selects the older SENT API operation after a newer reused-incarnation member is ignored across both services (%s absence)',
  async (absencePath) => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const lastfm = h.link(h.alice, 'lastfm');
      const listenbrainz = h.link(h.alice, 'listenbrainz');
      const input = { artist: 'Reused API batch artist', track: 'Reused API batch track' };
      const older = await enqueueLove(h.m, { did: h.alice, input, origin: 'web' });
      if (!older.ok) throw Error('older API love enqueue refused');
      await h.runUntilIdle();
      const firstRecord = h.op(older.operation.id);
      expect(firstRecord.rkey).not.toBeNull();
      expect((await projectLove(h, firstRecord.rkey!, true)).outcome).toBe('applied');

      // A distinct API operation and request rkey reuses the current projection.
      const newer = await enqueueLove(h.m, { did: h.alice, input, origin: 'lastfm' });
      if (!newer.ok) throw Error('newer API love enqueue refused');
      await h.runUntilIdle();
      const secondRecord = h.op(newer.operation.id);
      expect(secondRecord.rkey).not.toBeNull();
      expect(secondRecord.rkey).not.toBe(firstRecord.rkey);
      const bindings = h.db.all<{
        operation_id: string;
        api_origin: string;
        uri: string;
        incarnation_key: string;
      }>(
        `SELECT operation_id,api_origin,uri,incarnation_key FROM love_api_bindings
       WHERE did=? AND operation_id IN (?,?) ORDER BY binding_seq`,
        h.alice,
        older.operation.id,
        newer.operation.id,
      );
      expect(bindings).toHaveLength(2);
      expect(bindings.map(({ operation_id, api_origin }) => [operation_id, api_origin])).toEqual([
        [older.operation.id, 'web'],
        [newer.operation.id, 'lastfm'],
      ]);
      expect(new Set(bindings.map(({ uri }) => uri)).size).toBe(1);
      expect(new Set(bindings.map(({ incarnation_key }) => incarnation_key)).size).toBe(1);
      expect(bindings[0]!.uri.endsWith(`/${firstRecord.rkey}`)).toBe(true);
      expect(bindings[1]!.uri.endsWith(`/${secondRecord.rkey}`)).toBe(false);

      const terminalRows = h.db.all<{ id: string; link_id: string; generation: number; dedupe_key: string }>(
        `SELECT id,link_id,generation,dedupe_key FROM forward_outbox
       WHERE kind='love' AND dedupe_key IN (?,?) ORDER BY link_id,dedupe_key`,
        older.operation.id,
        newer.operation.id,
      );
      expect(terminalRows).toHaveLength(4);
      expect(new Set(terminalRows.map(({ link_id }) => link_id))).toEqual(new Set([lastfm, listenbrainz]));
      const olderRows = terminalRows.filter((row) => row.dedupe_key === older.operation.id);
      const newerRows = terminalRows.filter((row) => row.dedupe_key === newer.operation.id);
      expect(olderRows).toHaveLength(2);
      expect(newerRows).toHaveLength(2);
      for (const row of olderRows) settleRows(h.db, [row.id], 'sent', h.m.clock.nowMs(), null, true, row.generation);
      for (const row of newerRows)
        settleRows(h.db, [row.id], 'ignored', h.m.clock.nowMs(), 'fixture_terminal_ignore', true, row.generation);
      expect(
        h.db.all('SELECT link_id,operation_id FROM love_api_recipient_members ORDER BY link_id,operation_id'),
      ).toEqual([]);
      expect(h.db.all('SELECT link_id,sent_operation_id,state FROM love_api_recipients ORDER BY link_id')).toEqual([
        { link_id: lastfm, sent_operation_id: older.operation.id, state: 'present' },
        { link_id: listenbrainz, sent_operation_id: older.operation.id, state: 'present' },
      ]);

      const presentProof = await verifyRecordProof(await h.kit.repos.Alice.getRecordCar(LOVE, firstRecord.rkey!), {
        did: h.alice,
        collection: LOVE,
        rkey: firstRecord.rkey!,
        signingKey: h.kit.users.Alice.key.didKey,
      });
      if (presentProof.state !== 'present') throw Error('expected signed present proof');
      const deleteCommit = await h.kit.externalDelete('Alice', LOVE, firstRecord.rkey!);
      const absentCar = await h.kit.repos.Alice.getRecordCar(LOVE, firstRecord.rkey!);
      const absentProof = await verifyRecordProof(absentCar, {
        did: h.alice,
        collection: LOVE,
        rkey: firstRecord.rkey!,
        signingKey: h.kit.users.Alice.key.didKey,
      });
      const liveDelete = {
        uri: bindings[0]!.uri,
        did: h.alice,
        collection: LOVE,
        rkey: firstRecord.rkey!,
        rev: absentProof.commit.rev,
        action: 'delete' as const,
      };
      if (absencePath === 'delayed') {
        const currentLove = h.db.one<{
          uri: string;
          cid: string;
          artist_key: string;
          track_key: string;
          artist: string;
          track: string;
          recording_mbid: string | null;
        }>('SELECT uri,cid,artist_key,track_key,artist,track,recording_mbid FROM loves WHERE uri=?', bindings[0]!.uri)!;
        recordPendingRemovals(h.db, [
          {
            did: h.alice,
            uri: bindings[0]!.uri,
            kind: 'love',
            row: {
              ...currentLove,
              listened_at: new Date(h.kit.clock.nowMs()).toISOString(),
              record_uri: null,
              listen_id: null,
            },
            identityKey: bindings[0]!.incarnation_key,
            windowLo: presentProof.commit.rev,
            windowHi: deleteCommit.rev,
            replacedByCid: null,
            nowMs: h.kit.clock.nowMs(),
          },
        ]);
      }
      if (absencePath === 'direct') {
        recordLiveEvidence(h.db, liveDelete, h.kit.clock.nowMs());
        const rollbackTables = [
          'loves',
          'record_state',
          'love_incarnations',
          'love_api_recipients',
          'love_api_recipient_members',
          'love_api_unlove_decisions',
          'love_api_comparison_facts',
          'love_api_window_owners',
          'forward_outbox',
          'forward_deferred_love_heads',
          'forward_deferred_love_intents',
          'forward_deferred_love_witnesses',
          'forward_deferred_love_authorities',
          'live_pending_removals',
          'counters',
        ];
        const snapshot = () =>
          Object.fromEntries(rollbackTables.map((table) => [table, h.db.all(`SELECT * FROM ${table} ORDER BY rowid`)]));
        const beforeFailedProducer = snapshot();
        let broadInserts = 0;
        let firstEffectReachedOuterTransaction = false;
        const faultedDb: Db = {
          all<T>(sql: string, ...params: SqlParam[]): T[] {
            return h.db.all<T>(sql, ...params);
          },
          one<T>(sql: string, ...params: SqlParam[]): T | null {
            return h.db.one<T>(sql, ...params);
          },
          run(sql: string, ...params: SqlParam[]) {
            if (/^\s*INSERT INTO forward_outbox\b/i.test(sql)) {
              broadInserts++;
              if (broadInserts === 2) {
                firstEffectReachedOuterTransaction =
                  h.db.one<{ n: number }>("SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove'")?.n === 1;
                throw new Error('injected second recipient effect failure');
              }
            }
            return h.db.run(sql, ...params);
          },
          tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
            return h.db.tx(fn);
          },
        };
        expect(() =>
          h.db.tx(() =>
            applyRecordProof(faultedDb, absentProof, authorizedLiveOptions(faultedDb, absentProof, projectionRandom)),
          ),
        ).toThrow('injected second recipient effect failure');
        expect(broadInserts).toBe(2);
        expect(firstEffectReachedOuterTransaction).toBe(true);
        expect(snapshot()).toEqual(beforeFailedProducer);
      }
      expect(
        h.db.tx(() => applyRecordProof(h.db, absentProof, authorizedLiveOptions(h.db, absentProof, projectionRandom)))
          .outcome,
      ).toBe('absent');
      if (absencePath === 'delayed') {
        recordLiveEvidence(h.db, liveDelete, h.kit.clock.nowMs());
        h.db.tx(() =>
          authorizePendingRemovals(
            h.db,
            { uri: bindings[0]!.uri, rev: absentProof.commit.rev, action: 'delete' },
            h.kit.clock.nowMs(),
          ),
        );
        const result = h.db.tx(() =>
          executeAuthorizedRemovals(h.db, {
            uri: bindings[0]!.uri,
            nowMs: h.kit.clock.nowMs(),
            random: h.m.random,
            limit: 1,
          }),
        );
        expect(result.groups).toBe(1);
        expect(h.db.one('SELECT 1 FROM love_api_unlove_decisions WHERE uri=?', bindings[0]!.uri)).toBeNull();
      }

      const incarnation = bindings[0]!.incarnation_key;
      const broadOperationId = `love-delete:${incarnation}:rev:${absentProof.commit.rev}`;
      expect(h.db.one('SELECT 1 FROM love_api_unlove_decisions WHERE uri=?', bindings[0]!.uri)).toBeNull();
      expect(
        h.db.all<{ link_id: string; generation: number; dedupe_key: string; state: string }>(
          `SELECT link_id,generation,dedupe_key,state FROM forward_outbox
         WHERE kind='unlove' AND dedupe_key=? ORDER BY link_id`,
          broadOperationId,
        ),
      ).toEqual([
        { link_id: lastfm, generation: 1, dedupe_key: broadOperationId, state: 'queued' },
        { link_id: listenbrainz, generation: 1, dedupe_key: broadOperationId, state: 'queued' },
      ]);
      expect(
        h.db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove' AND dedupe_key LIKE '%:api-recipient'"),
      ).toBeNull();
    });
  },
);

it.each([
  { reverseSettlement: false, gcBeforeAbsence: true, outcomes: ['sent', 'ignored'] as const },
  { reverseSettlement: false, gcBeforeAbsence: false, outcomes: ['ignored', 'sent'] as const },
  { reverseSettlement: false, gcBeforeAbsence: false, outcomes: ['sent', 'sent'] as const },
  { reverseSettlement: true, gcBeforeAbsence: false, outcomes: ['sent', 'sent'] as const },
  { reverseSettlement: false, gcBeforeAbsence: false, outcomes: ['sent', 'pending'] as const },
  { reverseSettlement: false, gcBeforeAbsence: false, outcomes: ['failed', 'sent'] as const },
  { reverseSettlement: true, gcBeforeAbsence: true, outcomes: ['expired', 'ignored'] as const },
  {
    reverseSettlement: true,
    gcBeforeAbsence: true,
    outcomes: ['ignored', 'ignored'] as const,
    absencePath: 'delayed-import' as const,
  },
  {
    reverseSettlement: true,
    gcBeforeAbsence: true,
    outcomes: ['sent', 'sent'] as const,
    absencePath: 'delayed-import' as const,
  },
  {
    reverseSettlement: false,
    gcBeforeAbsence: false,
    outcomes: ['ignored', 'sent'] as const,
    absencePath: 'delayed-import' as const,
  },
])(
  'handles snapshot same-incarnation API operation bindings safely (%o)',
  async ({ reverseSettlement, gcBeforeAbsence, outcomes, absencePath = 'direct' }) => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const lastfm = h.link(h.alice, 'lastfm');
      const listenbrainz = h.link(h.alice, 'listenbrainz');
      const rkey = '3ksnapshotmultio';
      const recordingMbid = '12345678-1234-1234-1234-123456789abc';
      if (absencePath === 'delayed-import') {
        // Seed the ordinary import admission; the signed projector persists
        // its source service before the API operations reuse this incarnation.
        h.db.run(
          `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
           VALUES(?,?,'import','lastfm',?,101)`,
          h.alice,
          `love-uri:${h.alice}:${LOVE}:${rkey}`,
          h.m.clock.nowMs(),
        );
      }
      await h.kit.externalPut('Alice', LOVE, rkey, {
        $type: LOVE,
        artist: 'Snapshot reuse artist',
        track: 'Snapshot reuse track',
        recordingMbid,
        createdAt: '2026-01-15T11:00:00Z',
      });
      expect((await projectLove(h, rkey)).outcome).toBe('applied');
      const uri = `at://${h.alice}/${LOVE}/${rkey}`;
      expect(h.db.one('SELECT path FROM love_incarnations WHERE uri=?', uri)).toEqual({
        path: absencePath === 'delayed-import' ? 'import' : 'snapshot',
      });

      const operations: Array<{ id: string; rkey: string | null }> = [];
      for (const origin of ['web', 'lastfm'] as const) {
        const accepted = await enqueueLove(h.m, {
          did: h.alice,
          input: { artist: 'Snapshot reuse artist', track: 'Snapshot reuse track', recordingMbid },
          origin,
        });
        if (!accepted.ok) throw Error(`API love refused: ${accepted.reason.code}`);
        operations.push(accepted.operation);
        await h.runUntilIdle();
        expect(h.op(accepted.operation.id)).toMatchObject({ state: 'succeeded', result_uri: uri });
      }
      expect(new Set(operations.map((operation) => operation.rkey)).size).toBe(2);
      expect(
        h.db.all<{ operation_id: string; api_origin: string; uri: string; incarnation_key: string }>(
          `SELECT operation_id,api_origin,uri,incarnation_key FROM love_api_bindings ORDER BY binding_seq`,
        ),
      ).toEqual([
        expect.objectContaining({ operation_id: operations[0]!.id, api_origin: 'web', uri }),
        expect.objectContaining({ operation_id: operations[1]!.id, api_origin: 'lastfm', uri }),
      ]);
      const loveRows = h.db.all<{ id: string; link_id: string; generation: number; dedupe_key: string }>(
        `SELECT id,link_id,generation,dedupe_key FROM forward_outbox
         WHERE kind='love' AND dedupe_key IN (?,?) ORDER BY link_id,dedupe_key`,
        operations[0]!.id,
        operations[1]!.id,
      );
      expect(loveRows).toHaveLength(4);
      expect(new Set(loveRows.map(({ link_id }) => link_id))).toEqual(new Set([lastfm, listenbrainz]));
      const settlementOrder = reverseSettlement ? [...operations].reverse() : operations;
      const selectedSentOperation = settlementOrder.find(
        (operation) => outcomes[operations.indexOf(operation)] === 'sent',
      );
      for (const operation of settlementOrder) {
        const operationOutcome = outcomes[operations.indexOf(operation)]!;
        if (operationOutcome === 'pending') continue;
        for (const row of loveRows.filter(({ dedupe_key }) => dedupe_key === operation.id))
          settleRows(
            h.db,
            [row.id],
            operationOutcome,
            h.m.clock.nowMs(),
            operationOutcome === 'sent' ? null : `fixture_terminal_${operationOutcome}`,
            true,
            row.generation,
          );
      }
      const pendingOperation = operations.find((_operation, index) => outcomes[index] === 'pending');
      expect(
        h.db.all<{ link_id: string; operation_id: string }>(
          'SELECT link_id,operation_id FROM love_api_recipient_members ORDER BY link_id,operation_id',
        ),
      ).toEqual(
        pendingOperation === undefined
          ? []
          : [lastfm, listenbrainz].map((link_id) => ({ link_id, operation_id: pendingOperation.id })),
      );
      expect(
        h.db.all<{ link_id: string; sent_operation_id: string }>(
          'SELECT link_id,sent_operation_id FROM love_api_recipients ORDER BY link_id',
        ),
      ).toEqual([
        { link_id: lastfm, sent_operation_id: selectedSentOperation?.id ?? null },
        { link_id: listenbrainz, sent_operation_id: selectedSentOperation?.id ?? null },
      ]);

      const cleanApiHistory = () => {
        h.db.run('DELETE FROM operations WHERE id IN (?,?)', operations[0]!.id, operations[1]!.id);
        h.db.run(
          "DELETE FROM forward_outbox WHERE kind='love' AND dedupe_key IN (?,?)",
          operations[0]!.id,
          operations[1]!.id,
        );
        for (let pass = 0; pass < 6; pass++) reclaimLoveApiProofRows(h.db, h.m.clock.nowMs());
        expect(h.db.all('SELECT operation_id FROM love_api_bindings ORDER BY operation_id')).toHaveLength(
          selectedSentOperation === undefined ? 0 : 2,
        );
      };
      if (gcBeforeAbsence) cleanApiHistory();

      const presentProof = await verifyRecordProof(await h.kit.repos.Alice.getRecordCar(LOVE, rkey), {
        did: h.alice,
        collection: LOVE,
        rkey,
        signingKey: h.kit.users.Alice.key.didKey,
      });
      await h.kit.externalDelete('Alice', LOVE, rkey);
      const absentProof = await verifyRecordProof(await h.kit.repos.Alice.getRecordCar(LOVE, rkey), {
        did: h.alice,
        collection: LOVE,
        rkey,
        signingKey: h.kit.users.Alice.key.didKey,
      });
      if (absentProof.state !== 'absent') throw Error('expected signed snapshot absence');
      const liveDelete = {
        uri,
        did: h.alice,
        collection: LOVE,
        rkey,
        rev: absentProof.commit.rev,
        action: 'delete' as const,
      };
      if (absencePath === 'direct') {
        recordLiveEvidence(h.db, liveDelete, h.kit.clock.nowMs());
        expect((await projectLove(h, rkey, true)).outcome).toBe('absent');
      } else {
        const nowMs = h.kit.clock.nowMs();
        const currentLove = h.db.one<{
          uri: string;
          cid: string;
          artist_key: string;
          track_key: string;
          artist: string;
          track: string;
          recording_mbid: string | null;
        }>('SELECT uri,cid,artist_key,track_key,artist,track,recording_mbid FROM loves WHERE uri=?', uri);
        if (currentLove === null) throw new Error('snapshot love projection missing before delayed absence');
        recordPendingRemovals(h.db, [
          {
            did: h.alice,
            uri,
            kind: 'love',
            row: {
              ...currentLove,
              listened_at: new Date(nowMs).toISOString(),
              record_uri: null,
              listen_id: null,
            },
            identityKey: h.db.one<{ incarnation_key: string }>(
              'SELECT incarnation_key FROM love_incarnations WHERE uri=?',
              uri,
            )!.incarnation_key,
            windowLo: presentProof.commit.rev,
            windowHi: absentProof.commit.rev,
            replacedByCid: null,
            ...(absencePath === 'delayed-import' ? { loveSourceService: 'lastfm' } : {}),
            nowMs,
          },
        ]);
        const nowNs = fromMs(nowMs);
        expect(
          h.db.tx(() =>
            applyRecordProof(h.db, absentProof, {
              ...authorizedLiveOptions(h.db, absentProof, projectionRandom),
              prefix: 'com.example.atmusic',
              nowNs,
              receiptNs: nowNs,
            }),
          ).outcome,
        ).toBe('absent');
        recordLiveEvidence(h.db, liveDelete, nowMs);
        h.db.tx(() => authorizePendingRemovals(h.db, { uri, rev: absentProof.commit.rev, action: 'delete' }, nowMs));
        expect(
          h.db.tx(() =>
            executeAuthorizedRemovals(h.db, {
              uri,
              nowMs,
              random: h.m.random,
              limit: 1,
            }),
          ).groups,
        ).toBe(1);
      }
      if (!gcBeforeAbsence && pendingOperation === undefined) cleanApiHistory();
      if (selectedSentOperation === undefined) {
        // Bindings and a terminal negative outcome never establish recipient
        // proof. An import-source-excluded link stays present; the other link
        // can still be covered by the independently accepted broad effect.
        expect(
          h.db.all<{ link_id: string; state: string }>(
            'SELECT link_id,state FROM love_api_recipients ORDER BY link_id',
          ),
        ).toEqual(
          [
            { link_id: lastfm, state: 'present' },
            { link_id: listenbrainz, state: absencePath === 'delayed-import' ? 'released' : 'present' },
          ].sort((left, right) => left.link_id.localeCompare(right.link_id)),
        );
        expect(
          h.db.all<{ link_id: string; dedupe_key: string }>(
            "SELECT link_id,dedupe_key FROM forward_outbox WHERE kind='unlove' ORDER BY link_id",
          ),
        ).toEqual(
          absencePath === 'delayed-import'
            ? [
                {
                  link_id: listenbrainz,
                  dedupe_key: `love-delete:${h.db.one<{ incarnation_key: string }>('SELECT incarnation_key FROM love_incarnations WHERE uri=?', uri)!.incarnation_key}:rev:${absentProof.commit.rev}`,
                },
              ]
            : [],
        );
        expect(
          h.db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove' AND dedupe_key LIKE '%:api-recipient'"),
        ).toBeNull();
        expect(
          materializeLoveApiRecipientDecisions(h.db, h.m.clock.nowMs(), h.m.random, 'snapshot-no-sent'),
        ).toMatchObject({ queued: 0, deferred: 0, replay: 0 });
        return;
      }
      const positiveLinks = absencePath === 'delayed-import' ? [lastfm] : [lastfm, listenbrainz];
      const releasedLinks = absencePath === 'delayed-import' ? [listenbrainz] : [];
      expect(
        h.db.all<{ link_id: string; state: string }>('SELECT link_id,state FROM love_api_recipients ORDER BY link_id'),
      ).toEqual(
        [
          ...positiveLinks.map((link_id) => ({ link_id, state: 'sealed' })),
          ...releasedLinks.map((link_id) => ({ link_id, state: 'released' })),
        ].sort((left, right) => left.link_id.localeCompare(right.link_id)),
      );
      const result = materializeLoveApiRecipientDecisions(h.db, h.m.clock.nowMs(), h.m.random, 'snapshot-multi-api');
      if (pendingOperation === undefined) {
        expect(result).toMatchObject({
          visited: positiveLinks.length,
          queued: positiveLinks.length,
          deferred: 0,
          refused: 0,
        });
      } else {
        expect(result).toMatchObject({
          visited: positiveLinks.length,
          queued: 0,
          awaiting: positiveLinks.length,
          deferred: 0,
          refused: 0,
        });
        for (const row of loveRows.filter(({ dedupe_key }) => dedupe_key === pendingOperation.id))
          settleRows(h.db, [row.id], 'sent', h.kit.clock.nowMs(), null, true, row.generation);
        const resumed = materializeLoveApiRecipientDecisions(
          h.db,
          h.kit.clock.nowMs() + 1_000,
          h.m.random,
          'late-sibling-sent',
        );
        expect(resumed).toMatchObject({ visited: positiveLinks.length, queued: positiveLinks.length, refused: 0 });
      }
      expect(
        h.db.all<{ link_id: string; kind: string; state: string; dedupe_key: string }>(
          `SELECT link_id,kind,state,dedupe_key FROM forward_outbox WHERE kind='unlove' ORDER BY link_id`,
        ),
      ).toEqual([
        ...(absencePath === 'delayed-import'
          ? [
              {
                link_id: lastfm,
                kind: 'unlove',
                state: 'queued',
                dedupe_key: `love-delete:${h.db.one<{ incarnation_key: string }>('SELECT incarnation_key FROM love_incarnations WHERE uri=?', uri)!.incarnation_key}:rev:${absentProof.commit.rev}:api-recipient`,
              },
              {
                link_id: listenbrainz,
                kind: 'unlove',
                state: 'queued',
                dedupe_key: `love-delete:${h.db.one<{ incarnation_key: string }>('SELECT incarnation_key FROM love_incarnations WHERE uri=?', uri)!.incarnation_key}:rev:${absentProof.commit.rev}`,
              },
            ]
          : positiveLinks.map((link_id) => ({
              link_id,
              kind: 'unlove',
              state: 'queued',
              dedupe_key: `love-delete:${h.db.one<{ incarnation_key: string }>('SELECT incarnation_key FROM love_incarnations WHERE uri=?', uri)!.incarnation_key}:rev:${absentProof.commit.rev}:api-recipient`,
            }))),
      ]);
      if (pendingOperation !== undefined) {
        expect(
          materializeLoveApiRecipientDecisions(h.db, h.kit.clock.nowMs(), h.m.random, 'late-sibling-sent'),
        ).toMatchObject({ queued: 0, refused: 0 });
        expect(h.db.all("SELECT kind FROM forward_outbox WHERE kind='unlove'")).toHaveLength(positiveLinks.length);
      }
    });
  },
);

it('does not treat a cancelled-before-PDS API admission as SENT proof', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    h.link(h.alice, 'lastfm');
    const listenbrainz = h.link(h.alice, 'listenbrainz');
    const rkey = '3kcancelledapi';
    const artist = 'Cancelled API artist';
    const track = 'Cancelled before PDS';
    h.db.run(
      `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
       VALUES(?,?,'import','lastfm',?,111)`,
      h.alice,
      `love-uri:${h.alice}:${LOVE}:${rkey}`,
      h.m.clock.nowMs(),
    );
    await h.kit.externalPut('Alice', LOVE, rkey, {
      $type: LOVE,
      artist,
      track,
      createdAt: '2026-01-15T11:00:00Z',
    });
    expect((await projectLove(h, rkey)).outcome).toBe('applied');
    const uri = `at://${h.alice}/${LOVE}/${rkey}`;
    const accepted = await enqueueLove(h.m, { did: h.alice, input: { artist, track }, origin: 'web' });
    if (!accepted.ok) throw new Error(`API love refused: ${accepted.reason.code}`);
    expect(h.op(accepted.operation.id)).toMatchObject({ state: 'queued' });
    expect(h.db.one('SELECT uri FROM love_api_bindings WHERE operation_id=?', accepted.operation.id)).toBeNull();
    expect(cancelUnsentForDid(h.db, h.alice, h.m.clock.nowMs())).toEqual([accepted.operation.id]);
    expect(h.op(accepted.operation.id)).toMatchObject({ state: 'cancelled' });
    expect(
      h.db.one("SELECT 1 FROM forward_outbox WHERE kind='love' AND dedupe_key=?", accepted.operation.id),
    ).toBeNull();

    await h.kit.externalDelete('Alice', LOVE, rkey);
    const proof = await verifyRecordProof(await h.kit.repos.Alice.getRecordCar(LOVE, rkey), {
      did: h.alice,
      collection: LOVE,
      rkey,
      signingKey: h.kit.users.Alice.key.didKey,
    });
    if (proof.state !== 'absent') throw new Error('expected signed deletion after cancellation');
    recordLiveEvidence(
      h.db,
      { uri, did: h.alice, collection: LOVE, rkey, rev: proof.commit.rev, action: 'delete' },
      h.m.clock.nowMs(),
    );
    expect((await projectLove(h, rkey, true)).outcome).toBe('absent');
    expect(
      h.db.all<{ link_id: string }>('SELECT link_id FROM love_api_recipients WHERE uri=? ORDER BY link_id', uri),
    ).toEqual([]);
    expect(h.db.one('SELECT 1 FROM love_api_unlove_decisions WHERE uri=?', uri)).toBeNull();
    const incarnation = h.db.one<{ incarnation_key: string }>(
      'SELECT incarnation_key FROM love_incarnations WHERE uri=?',
      uri,
    )!.incarnation_key;
    expect(
      h.db.all<{ link_id: string; dedupe_key: string }>(
        "SELECT link_id,dedupe_key FROM forward_outbox WHERE kind='unlove' ORDER BY link_id",
      ),
    ).toEqual([{ link_id: listenbrainz, dedupe_key: `love-delete:${incarnation}:rev:${proof.commit.rev}` }]);
    expect(
      h.db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove' AND dedupe_key LIKE '%:api-recipient'"),
    ).toBeNull();
  });
});

it('rolls back the first real recipient handoff when the second decision handoff throws', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const lastfm = h.link(h.alice, 'lastfm');
    const listenbrainz = h.link(h.alice, 'listenbrainz');
    const records = [
      { rkey: '3kbatchlastfm', source: 'lastfm' as const, artist: 'Batch Last.fm', track: 'Batch One' },
      { rkey: '3kbatchlisten', source: 'listenbrainz' as const, artist: 'Batch ListenBrainz', track: 'Batch Two' },
    ];
    const decisions: Array<{ uri: string; incarnationKey: string; rev: string; source: 'lastfm' | 'listenbrainz' }> =
      [];

    for (const record of records) {
      h.db.run(
        `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
         VALUES(?,?,'import',?,?,?)`,
        h.alice,
        `love-uri:${h.alice}:${LOVE}:${record.rkey}`,
        record.source,
        h.m.clock.nowMs(),
        100 + records.indexOf(record),
      );
      await h.kit.externalPut('Alice', LOVE, record.rkey, {
        $type: LOVE,
        artist: record.artist,
        track: record.track,
        createdAt: '2026-01-15T11:00:00Z',
      });
      expect((await projectLove(h, record.rkey)).outcome).toBe('applied');
      const uri = `at://${h.alice}/${LOVE}/${record.rkey}`;
      const accepted = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: record.artist, track: record.track },
        origin: 'web',
      });
      if (!accepted.ok) throw new Error(`API love refused: ${accepted.reason.code}`);
      await h.runUntilIdle();
      expect(h.op(accepted.operation.id)).toMatchObject({ state: 'succeeded', result_uri: uri });
      const binding = h.db.one<{ uri: string; incarnation_key: string }>(
        'SELECT uri,incarnation_key FROM love_api_bindings WHERE operation_id=?',
        accepted.operation.id,
      );
      expect(binding).toEqual({ uri, incarnation_key: expect.any(String) });
      const loveRows = h.db.all<{ id: string; generation: number }>(
        "SELECT id,generation FROM forward_outbox WHERE did=? AND kind='love' AND dedupe_key=? ORDER BY link_id",
        h.alice,
        accepted.operation.id,
      );
      expect(loveRows).toHaveLength(2);
      for (const row of loveRows) settleRows(h.db, [row.id], 'sent', h.m.clock.nowMs(), null, true, row.generation);

      const incarnation = binding!.incarnation_key;
      await h.kit.externalDelete('Alice', LOVE, record.rkey);
      const proof = await verifyRecordProof(await h.kit.repos.Alice.getRecordCar(LOVE, record.rkey), {
        did: h.alice,
        collection: LOVE,
        rkey: record.rkey,
        signingKey: h.kit.users.Alice.key.didKey,
      });
      if (proof.state !== 'absent') throw new Error('expected signed absence for batch recipient fixture');
      recordLiveEvidence(
        h.db,
        { uri, did: h.alice, collection: LOVE, rkey: record.rkey, rev: proof.commit.rev, action: 'delete' },
        h.m.clock.nowMs(),
      );
      expect((await projectLove(h, record.rkey, true)).outcome).toBe('absent');
      decisions.push({ uri, incarnationKey: incarnation, rev: proof.commit.rev, source: record.source });
    }

    expect(
      h.db.all<{ link_id: string; uri: string; generation: number }>(
        'SELECT link_id,uri,generation FROM love_api_unlove_decisions ORDER BY uri,link_id',
      ),
    ).toEqual(
      [
        { link_id: lastfm, uri: decisions[0]!.uri, generation: 1 },
        { link_id: listenbrainz, uri: decisions[1]!.uri, generation: 1 },
      ].sort((left, right) => left.uri.localeCompare(right.uri)),
    );

    const rollbackTables = [
      'love_api_recipients',
      'love_api_recipient_members',
      'love_api_unlove_decisions',
      'love_api_comparison_facts',
      'love_api_window_owners',
      'forward_outbox',
      'forward_receipts',
      'forward_deferred_love_heads',
      'forward_deferred_love_intents',
      'forward_deferred_love_witnesses',
      'forward_deferred_love_authorities',
      'counters',
    ];
    const snapshot = () =>
      Object.fromEntries(rollbackTables.map((table) => [table, h.db.all(`SELECT * FROM ${table} ORDER BY rowid`)]));
    const before = snapshot();
    let handoffInserts = 0;
    let firstEffectReachedTransaction = false;
    const faultedDb: Db = {
      all<T>(sql: string, ...params: SqlParam[]): T[] {
        return h.db.all<T>(sql, ...params);
      },
      one<T>(sql: string, ...params: SqlParam[]): T | null {
        return h.db.one<T>(sql, ...params);
      },
      run(sql: string, ...params: SqlParam[]) {
        if (/^\s*INSERT INTO forward_outbox\b/i.test(sql) && params[4] === 'unlove') {
          handoffInserts++;
          if (handoffInserts === 2) {
            firstEffectReachedTransaction =
              h.db.one<{ n: number }>(
                "SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove' AND dedupe_key LIKE '%:api-recipient'",
              )?.n === 1;
            throw new Error('injected second recipient handoff failure');
          }
        }
        return h.db.run(sql, ...params);
      },
      tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
        return h.db.tx(fn);
      },
    };
    expect(() =>
      materializeLoveApiRecipientDecisions(faultedDb, h.m.clock.nowMs(), h.m.random, 'second-handoff-fault'),
    ).toThrow('injected second recipient handoff failure');
    expect(handoffInserts).toBe(2);
    expect(firstEffectReachedTransaction).toBe(true);
    expect(snapshot()).toEqual(before);

    expect(
      materializeLoveApiRecipientDecisions(h.db, h.m.clock.nowMs(), h.m.random, 'second-handoff-success'),
    ).toMatchObject({
      visited: 2,
      queued: 2,
      deferred: 0,
      replay: 0,
      refused: 0,
    });
    expect(
      h.db.all<{ link_id: string; authorization_uri: string; dedupe_key: string }>(
        "SELECT link_id,authorization_uri,dedupe_key FROM forward_outbox WHERE kind='unlove' AND dedupe_key LIKE '%:api-recipient' ORDER BY link_id",
      ),
    ).toEqual(
      [
        {
          link_id: lastfm,
          authorization_uri: decisions[0]!.source === 'lastfm' ? decisions[0]!.uri : decisions[1]!.uri,
          dedupe_key: `love-delete:${decisions[0]!.source === 'lastfm' ? decisions[0]!.incarnationKey : decisions[1]!.incarnationKey}:rev:${decisions[0]!.source === 'lastfm' ? decisions[0]!.rev : decisions[1]!.rev}:api-recipient`,
        },
        {
          link_id: listenbrainz,
          authorization_uri: decisions[0]!.source === 'listenbrainz' ? decisions[0]!.uri : decisions[1]!.uri,
          dedupe_key: `love-delete:${decisions[0]!.source === 'listenbrainz' ? decisions[0]!.incarnationKey : decisions[1]!.incarnationKey}:rev:${decisions[0]!.source === 'listenbrainz' ? decisions[0]!.rev : decisions[1]!.rev}:api-recipient`,
        },
      ].sort((left, right) => left.link_id.localeCompare(right.link_id)),
    );
  });
});

it('refuses one production handoff child while its materializer-batch sibling queues once', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const lastfm = h.link(h.alice, 'lastfm');
    const records = [
      { rkey: '3kmixedacklf', source: 'lastfm' as const, linkId: lastfm },
      { rkey: '3kmixedacklf2', source: 'lastfm' as const, linkId: lastfm },
    ];
    const acceptedApiOperations: Array<{ uri: string; incarnationKey: string; operationId: string; rkey: string }> = [];
    const acceptedChildren: Array<{ uri: string; incarnationKey: string; rev: string; operationId: string }> = [];
    const absences: Array<{ uri: string; rkey: string; proof: Parameters<typeof applyRecordProof>[1] }> = [];

    // Both children are produced through the API reuse executor and a real
    // signed PDS absence. Their materializer candidates share one atomic
    // production page; no handoff result is fabricated by the fixture.
    for (const [index, record] of records.entries()) {
      const input = { artist: `Mixed handoff ${record.source}`, track: `Sibling ${index}` };
      const uri = `at://${h.alice}/${LOVE}/${record.rkey}`;
      h.db.run(
        `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
         VALUES(?,?,'import',?,?,?)`,
        h.alice,
        `love-uri:${h.alice}:${LOVE}:${record.rkey}`,
        record.source,
        h.m.clock.nowMs(),
        100 + index,
      );
      await h.kit.externalPut('Alice', LOVE, record.rkey, {
        $type: LOVE,
        ...input,
        createdAt: '2026-01-15T11:00:00Z',
      });
      expect((await projectLove(h, record.rkey)).outcome).toBe('applied');
      const accepted = await enqueueLove(h.m, { did: h.alice, input, origin: 'web' });
      if (!accepted.ok) throw new Error(`API reuse refused: ${accepted.reason.code}`);
      await h.runUntilIdle();
      expect(h.op(accepted.operation.id)).toMatchObject({ state: 'succeeded', result_uri: uri });
      const binding = h.db.one<{ incarnation_key: string }>(
        'SELECT incarnation_key FROM love_api_bindings WHERE did=? AND operation_id=?',
        h.alice,
        accepted.operation.id,
      )!;
      const loveEffect = h.db.one<{ id: string; generation: number }>(
        "SELECT id,generation FROM forward_outbox WHERE did=? AND link_id=? AND kind='love' AND dedupe_key=?",
        h.alice,
        record.linkId,
        accepted.operation.id,
      );
      expect(loveEffect).not.toBeNull();
      settleRows(h.db, [loveEffect!.id], 'sent', h.m.clock.nowMs(), null, true, loveEffect!.generation);
      acceptedApiOperations.push({
        uri,
        incarnationKey: binding.incarnation_key,
        operationId: accepted.operation.id,
        rkey: record.rkey,
      });
    }
    // Apply both deletes to the signed repo before asking for their proof CARs;
    // each CAR then carries the same current commit revision for the producer Tx.
    for (const child of acceptedApiOperations) await h.kit.externalDelete('Alice', LOVE, child.rkey);
    for (const child of acceptedApiOperations) {
      const proof = await verifyRecordProof(await h.kit.repos.Alice.getRecordCar(LOVE, child.rkey), {
        did: h.alice,
        collection: LOVE,
        rkey: child.rkey,
        signingKey: h.kit.users.Alice.key.didKey,
      });
      if (proof.state !== 'absent') throw new Error('expected signed absence');
      recordLiveEvidence(
        h.db,
        { uri: child.uri, did: h.alice, collection: LOVE, rkey: child.rkey, rev: proof.commit.rev, action: 'delete' },
        h.m.clock.nowMs(),
      );
      absences.push({ uri: child.uri, rkey: child.rkey, proof });
      acceptedChildren.push({ ...child, rev: proof.commit.rev });
    }
    // The real projector processes both signed record changes in one owning
    // synchronous producer transaction; subsequent materialization is one page.
    h.db.tx(() => {
      const nowNs = fromMs(h.m.clock.nowMs());
      for (const absence of absences) {
        const options = authorizedLiveOptions(h.db, absence.proof, projectionRandom);
        expect(
          applyRecordProof(h.db, absence.proof, { ...options, prefix: 'com.example.atmusic', nowNs, receiptNs: nowNs })
            .outcome,
        ).toBe('absent');
      }
    });
    expect(
      h.db.all<{ link_id: string; uri: string; generation: number }>(
        'SELECT link_id,uri,generation FROM love_api_unlove_decisions ORDER BY uri',
      ),
    ).toEqual([
      { link_id: lastfm, uri: acceptedChildren[0]!.uri, generation: 1 },
      { link_id: lastfm, uri: acceptedChildren[1]!.uri, generation: 1 },
    ]);

    // A durable envelope corruption is a real filtered refusal for one child;
    // its sibling still traverses the handoff. Preparation detects this exact
    // immutable-row mismatch before authority or effect writes.
    h.db.run(
      `UPDATE love_api_unlove_decisions SET payload_json='{}'
       WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=1`,
      h.alice,
      acceptedChildren[0]!.uri,
      acceptedChildren[0]!.incarnationKey,
      lastfm,
    );
    const result = materializeLoveApiRecipientDecisions(h.db, h.m.clock.nowMs(), h.m.random, 'mixed-ack');
    expect(result).toMatchObject({ visited: 2, queued: 1, deferred: 0, replay: 0, refused: 1 });
    expect(
      h.db.all<{ link_id: string; uri: string; state: string }>(
        'SELECT link_id,uri,state FROM love_api_recipients WHERE did=? ORDER BY uri,link_id',
        h.alice,
      ),
    ).toEqual([
      { link_id: lastfm, uri: acceptedChildren[0]!.uri, state: 'released' },
      { link_id: lastfm, uri: acceptedChildren[1]!.uri, state: 'released' },
    ]);
    expect(
      h.db.all<{ link_id: string; generation: number; dedupe_key: string; authorization_uri: string }>(
        "SELECT link_id,generation,dedupe_key,authorization_uri FROM forward_outbox WHERE did=? AND kind='unlove' ORDER BY link_id",
        h.alice,
      ),
    ).toEqual([
      {
        link_id: lastfm,
        generation: 1,
        dedupe_key: `love-delete:${acceptedChildren[1]!.incarnationKey}:rev:${acceptedChildren[1]!.rev}:api-recipient`,
        authorization_uri: acceptedChildren[1]!.uri,
      },
    ]);
    expect(
      h.db.one(
        "SELECT 1 FROM forward_outbox WHERE authorization_uri=? AND kind='unlove' AND dedupe_key LIKE '%:api-recipient'",
        acceptedChildren[0]!.uri,
      ),
    ).toBeNull();
    expect(
      h.db.one(
        'SELECT 1 FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
        acceptedChildren[0]!.uri,
        acceptedChildren[0]!.rev,
      ),
    ).toBeNull();
    expect(
      h.db.one(
        'SELECT 1 FROM forward_deferred_love_witnesses WHERE link_id=? AND generation=1 AND operation_id=?',
        lastfm,
        `love-delete:${acceptedChildren[0]!.incarnationKey}:rev:${acceptedChildren[0]!.rev}:api-recipient`,
      ),
    ).toBeNull();
    expect(
      h.db.one(
        'SELECT action,cid,state FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
        acceptedChildren[1]!.uri,
        acceptedChildren[1]!.rev,
      ),
    ).toEqual({ action: 'delete', cid: '', state: 'active' });
    expect(
      h.db.one(
        'SELECT authorization_uri,authorization_rev,action,cid,horizon_ms,conflicted FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=?',
        acceptedChildren[0]!.uri,
        acceptedChildren[0]!.rev,
      ),
    ).toMatchObject({
      authorization_uri: acceptedChildren[0]!.uri,
      authorization_rev: acceptedChildren[0]!.rev,
      action: 'delete',
      cid: '',
      conflicted: 0,
    });
  });
});
