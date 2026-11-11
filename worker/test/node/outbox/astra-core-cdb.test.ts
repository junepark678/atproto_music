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
  { reverseSettlement: false, gcBeforeAbsence: true, allSent: true },
  { reverseSettlement: true, gcBeforeAbsence: false, allSent: true },
  { reverseSettlement: false, gcBeforeAbsence: false, allSent: false },
  { reverseSettlement: true, gcBeforeAbsence: true, allSent: false },
])(
  'handles snapshot same-incarnation API operation bindings safely (%o)',
  async ({ reverseSettlement, gcBeforeAbsence, allSent }) => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const lastfm = h.link(h.alice, 'lastfm');
      const listenbrainz = h.link(h.alice, 'listenbrainz');
      const rkey = '3ksnapshotmultio';
      const recordingMbid = '12345678-1234-1234-1234-123456789abc';
      await h.kit.externalPut('Alice', LOVE, rkey, {
        $type: LOVE,
        artist: 'Snapshot reuse artist',
        track: 'Snapshot reuse track',
        recordingMbid,
        createdAt: '2026-01-15T11:00:00Z',
      });
      expect((await projectLove(h, rkey)).outcome).toBe('applied');
      const uri = `at://${h.alice}/${LOVE}/${rkey}`;
      expect(h.db.one('SELECT path FROM love_incarnations WHERE uri=?', uri)).toEqual({ path: 'snapshot' });

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
      for (const operation of settlementOrder)
        for (const row of loveRows.filter(({ dedupe_key }) => dedupe_key === operation.id))
          settleRows(
            h.db,
            [row.id],
            allSent ? 'sent' : 'ignored',
            h.m.clock.nowMs(),
            allSent ? null : 'fixture_terminal_ignore',
            true,
            row.generation,
          );
      expect(h.db.all('SELECT 1 FROM love_api_recipient_members')).toEqual([]);
      expect(
        h.db.all<{ link_id: string; sent_operation_id: string }>(
          'SELECT link_id,sent_operation_id FROM love_api_recipients ORDER BY link_id',
        ),
      ).toEqual([
        { link_id: lastfm, sent_operation_id: allSent ? operations[reverseSettlement ? 1 : 0]!.id : null },
        { link_id: listenbrainz, sent_operation_id: allSent ? operations[reverseSettlement ? 1 : 0]!.id : null },
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
          allSent ? 2 : 0,
        );
      };
      if (gcBeforeAbsence) cleanApiHistory();

      await h.kit.externalDelete('Alice', LOVE, rkey);
      const absentProof = await verifyRecordProof(await h.kit.repos.Alice.getRecordCar(LOVE, rkey), {
        did: h.alice,
        collection: LOVE,
        rkey,
        signingKey: h.kit.users.Alice.key.didKey,
      });
      if (absentProof.state !== 'absent') throw Error('expected signed snapshot absence');
      recordLiveEvidence(
        h.db,
        { uri, did: h.alice, collection: LOVE, rkey, rev: absentProof.commit.rev, action: 'delete' },
        h.kit.clock.nowMs(),
      );
      expect((await projectLove(h, rkey, true)).outcome).toBe('absent');
      if (!gcBeforeAbsence) cleanApiHistory();
      if (!allSent) {
        // Bindings and a terminal negative outcome never establish recipient
        // proof. The aggregate remains inert until ordinary bounded expiry.
        expect(h.db.all('SELECT state FROM love_api_recipients ORDER BY link_id')).toEqual([
          { state: 'present' },
          { state: 'present' },
        ]);
        expect(h.db.all("SELECT 1 FROM forward_outbox WHERE kind='unlove'")).toEqual([]);
        expect(
          materializeLoveApiRecipientDecisions(h.db, h.m.clock.nowMs(), h.m.random, 'snapshot-no-sent'),
        ).toMatchObject({ queued: 0, deferred: 0, replay: 0 });
        return;
      }
      expect(h.db.all('SELECT state FROM love_api_recipients ORDER BY link_id')).toEqual([
        { state: 'sealed' },
        { state: 'sealed' },
      ]);
      const result = materializeLoveApiRecipientDecisions(h.db, h.m.clock.nowMs(), h.m.random, 'snapshot-multi-api');
      expect(result).toMatchObject({ visited: 2, queued: 2, deferred: 0, refused: 0 });
      expect(
        h.db.all<{ link_id: string; kind: string; state: string; dedupe_key: string }>(
          `SELECT link_id,kind,state,dedupe_key FROM forward_outbox WHERE kind='unlove' ORDER BY link_id`,
        ),
      ).toEqual([
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
          dedupe_key: `love-delete:${h.db.one<{ incarnation_key: string }>('SELECT incarnation_key FROM love_incarnations WHERE uri=?', uri)!.incarnation_key}:rev:${absentProof.commit.rev}:api-recipient`,
        },
      ]);
    });
  },
);
