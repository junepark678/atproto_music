// Scrobble deletes, cancellation and removal on the server (ADR 0005 §5.8,
// §7.5 library.removeScrobble; ADR 0004 §5.2 step 5; N2-05; ports
// web/test/outbox/delete.test.ts, cases M3.3.1/pending_create_delete and
// M3.3.2/create_in_flight).

import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { enqueueScrobbleDelete, removeScrobbleCreate } from '../../../src/outbox/delete-ops';
import { acceptListens } from '../../../src/outbox/ingress';
import { predecessorRows } from '../../../src/outbox/operations';
import {
  CREATE,
  DELETE,
  GET,
  type Harness,
  listenInput,
  remoteRecord,
  SCROBBLE,
  T0,
  withHarness,
  zeroJitter,
} from './support';

function count(db: Db, table: string, where = '1', ...params: string[]): number {
  return db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...params)!.n;
}

/** What the verify drain leaves for an indexed record (the proof's CID). */
function indexRecordState(h: Harness, rkey: string, cid: string): string {
  const uri = `at://${h.alice}/${SCROBBLE}/${rkey}`;
  h.db.run(
    `INSERT INTO record_state(uri, did, collection, revision, cid, state, verified_at) VALUES (?, ?, ?, ?, ?, 'present', ?)`,
    uri,
    h.alice,
    SCROBBLE,
    '3lbkzzzzzzz22',
    cid,
    toStorage(fromMs(T0)),
  );
  return uri;
}

function scrobble(listenedAt: string, track = 'Hyperballad') {
  return { $type: SCROBBLE, artist: 'Björk', track, listenedAt, createdAt: '2026-01-15T11:00:00Z' };
}

async function accept(h: Harness, i: number) {
  const r = await acceptListens(h.m, {
    did: h.alice,
    origin: 'lastfm',
    listens: [{ input: listenInput(i) }],
    receiptMs: h.kit.clock.nowMs(),
  });
  const first = r.results[0];
  if (first?.status !== 'accepted' || first.operationId === null) throw new Error('not accepted');
  return h.op(first.operationId);
}

it('delete uses swapRecord from record_state; InvalidSwap re-fetches and reconciles; a delete behind a pending create waits for it', async () => {
  await withHarness(
    async (h) => {
      h.seedUser(h.alice);
      // 1. An indexed record: swapRecord is record_state's CID, with no lookup first.
      const put1 = await h.kit.externalPut('Alice', SCROBBLE, '3kaaaaaaaaa22', scrobble('2026-01-15T10:00:00Z'));
      const uri1 = indexRecordState(h, '3kaaaaaaaaa22', put1.ops[0]!.cid!);
      const d1 = enqueueScrobbleDelete(h.m, { did: h.alice, uri: uri1, origin: 'web' });
      await h.runUntilIdle();
      expect(h.writers.sent.map((s) => [s.nsid, s.status])).toEqual([[DELETE, 200]]);
      expect(h.writers.sent[0]!.body).toEqual({
        repo: h.alice,
        collection: SCROBBLE,
        rkey: '3kaaaaaaaaa22',
        swapRecord: put1.ops[0]!.cid,
      });
      expect(h.op(d1.id)).toMatchObject({
        state: 'succeeded',
        attempts: 1,
        swap_cid: put1.ops[0]!.cid,
        result_uri: uri1,
      });
      expect(await remoteRecord(h.kit, 'Alice', SCROBBLE, '3kaaaaaaaaa22')).toBeNull();
      // The deletion is hinted (source notify), so the drain verifies the absence.
      expect(h.db.all('SELECT uri, source FROM hints')).toEqual([{ uri: uri1, source: 'notify' }]);

      // 2. Another client changed the record after it was indexed: InvalidSwap,
      //    re-fetch, retry with the CID the PDS now reports.
      const putOld = await h.kit.externalPut('Alice', SCROBBLE, '3kbbbbbbbbb22', scrobble('2026-01-15T10:05:00Z'));
      const uri2 = indexRecordState(h, '3kbbbbbbbbb22', putOld.ops[0]!.cid!);
      const putNew = await h.kit.externalPut(
        'Alice',
        SCROBBLE,
        '3kbbbbbbbbb22',
        scrobble('2026-01-15T10:05:00Z', 'Edited'),
      );
      const d2 = enqueueScrobbleDelete(h.m, { did: h.alice, uri: uri2, origin: 'web' });
      const mark = h.writers.sent.length;
      await h.run();
      expect(h.writers.sent.slice(mark).map((s) => [s.nsid, s.status, s.body?.swapRecord])).toEqual([
        [DELETE, 400, putOld.ops[0]!.cid],
        [GET, 200, undefined],
      ]);
      expect(h.op(d2.id)).toMatchObject({
        state: 'queued',
        attempts: 1,
        last_error: 'repository_changed',
        swap_cid: putNew.ops[0]!.cid,
        due_at: h.kit.clock.nowMs() + 1_000,
      });
      h.kit.clock.advance(1_000);
      await h.runUntilIdle();
      expect(h.writers.sent.slice(mark + 2).map((s) => [s.nsid, s.status, s.body?.swapRecord])).toEqual([
        [DELETE, 200, putNew.ops[0]!.cid],
      ]);
      expect(h.op(d2.id)).toMatchObject({ state: 'succeeded', attempts: 2 });
      expect(await remoteRecord(h.kit, 'Alice', SCROBBLE, '3kbbbbbbbbb22')).toBeNull();

      // 3. A delete behind a create that has not landed yet waits for it.
      h.kit.pds.Alice.serverError(CREATE, 503, 1);
      const create = await accept(h, 0);
      const d3 = enqueueScrobbleDelete(h.m, {
        did: h.alice,
        uri: `at://${h.alice}/${SCROBBLE}/${create.rkey}`,
        origin: 'lastfm',
      });
      expect(predecessorRows(h.db, d3.id).map((p) => p.id)).toEqual([create.id]);
      const mark3 = h.writers.sent.length;
      const first = await h.run();
      expect(h.writers.sent.slice(mark3).map((s) => [s.nsid, s.status])).toEqual([[CREATE, 503]]);
      expect(h.op(d3.id)).toMatchObject({ state: 'queued', attempts: 0 });
      // The delete is not due to run before its create: the next run is the create's retry.
      expect(first.nextDueMs).toBe(h.op(create.id).due_at);
      h.kit.clock.advance(1_000);
      await h.runUntilIdle();
      const created = h.op(create.id);
      expect(h.writers.sent.slice(mark3).map((s) => [s.nsid, s.status])).toEqual([
        [CREATE, 503],
        [CREATE, 200],
        [DELETE, 200],
      ]);
      // swapRecord is the CID our create published (nothing indexed yet).
      expect(h.writers.sent.at(-1)!.body?.swapRecord).toBe(created.result_cid);
      expect(h.op(d3.id)).toMatchObject({ state: 'succeeded', attempts: 1, swap_cid: created.result_cid });
      expect(await remoteRecord(h.kit, 'Alice', SCROBBLE, create.rkey!)).toBeNull();
    },
    { random: zeroJitter() },
  );
});

it('a still-queued create cancelled at removal sends nothing to the PDS and deletes its listen key and unsent forward rows; a running create gets a delete chained after it', async () => {
  await withHarness(async (h) => {
    h.account(h.alice);
    h.link(h.alice, 'lastfm');
    h.link(h.alice, 'listenbrainz');
    let kicks = 0;
    const kick = () => {
      kicks += 1;
    };

    // A queued create, never sent: cancelled.
    const queued = await accept(h, 0);
    const key = h.db.one<{ k: string }>('SELECT dedupe_key AS k FROM listen_keys WHERE operation_id = ?', queued.id)!.k;
    expect(count(h.db, 'forward_outbox', 'dedupe_key = ?', key)).toBe(2);
    const removed = removeScrobbleCreate(h.m, { did: h.alice, operationId: queued.id, origin: 'lastfm', kick });
    expect(removed).toMatchObject({ status: 'cancelled', operation: { id: queued.id, state: 'cancelled' } });
    expect(count(h.db, 'listen_keys', 'did = ?', h.alice)).toBe(0);
    expect(count(h.db, 'forward_outbox')).toBe(0);
    expect(await h.run()).toMatchObject({ attempted: 0, nextDueMs: null });
    expect(h.writers.sent).toEqual([]);
    expect(h.kit.pds.Alice.count()).toBe(0);
    // Another DID cannot remove it, and a deliberate re-scrobble is accepted again as new.
    expect(removeScrobbleCreate(h.m, { did: h.bob, operationId: queued.id, origin: 'lastfm' })).toEqual({
      status: 'not_found',
    });
    const again = await accept(h, 0);
    expect(again.id).not.toBe(queued.id);
    expect(count(h.db, 'listen_keys', 'did = ?', h.alice)).toBe(1);

    // A create whose request is in flight: a delete is chained after it.
    const paused = h.writers.pauseOn(CREATE);
    const running = h.run();
    await paused.reached;
    expect(h.op(again.id)).toMatchObject({ state: 'running', attempts: 1 });
    const chained = removeScrobbleCreate(h.m, { did: h.alice, operationId: again.id, origin: 'lastfm', kick });
    if (chained.status !== 'delete_chained') throw new Error(`unexpected ${chained.status}`);
    expect(chained.delete).toMatchObject({ kind: 'scrobble.delete', rkey: again.rkey, state: 'queued' });
    expect(predecessorRows(h.db, chained.delete.id).map((p) => p.id)).toEqual([again.id]);
    // The running create keeps its listen key and forward rows (the listen did happen).
    expect(count(h.db, 'forward_outbox')).toBe(2);
    paused.release();
    await running;
    await h.runUntilIdle();
    const created = h.op(again.id);
    expect(created.state).toBe('succeeded');
    expect(h.writers.order()).toEqual([CREATE, DELETE]);
    expect(h.writers.sent.at(-1)!.body).toMatchObject({ rkey: again.rkey, swapRecord: created.result_cid });
    expect(h.op(chained.delete.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
    expect(await remoteRecord(h.kit, 'Alice', SCROBBLE, again.rkey!)).toBeNull();
    expect(kicks).toBe(2);
  });
});

it('delete behind an unsent or in-flight create runs after it and leaves no record on the fake PDS', async () => {
  await withHarness(async (h) => {
    const create = await accept(h, 3);
    const del = enqueueScrobbleDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${SCROBBLE}/${create.rkey}`,
      origin: 'web',
    });
    await h.runUntilIdle();
    expect(h.writers.order()).toEqual([CREATE, DELETE]);
    expect([h.op(create.id).state, h.op(del.id).state]).toEqual(['succeeded', 'succeeded']);
    expect(await remoteRecord(h.kit, 'Alice', SCROBBLE, create.rkey!)).toBeNull();
  });
});
