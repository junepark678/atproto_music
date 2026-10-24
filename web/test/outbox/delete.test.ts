// Scrobble deletes in the SPA outbox (ADR 0004 §5.2 step 5, §9 A12/A13;
// API.md deletion clarification; case map M3.3.1, M3.3.2, M3.3.3, M7.2.3).

import type { Scrobble } from '@atmusic/core/api-types';
import type { ScrobbleRecord } from '@atmusic/core/scrobble';
import { expect, it } from 'vitest';
import { enqueueScrobbleDelete } from '../../src/outbox/delete-ops';
import { overlayScrobbles } from '../../src/outbox/overlay';
import { enqueueScrobble } from '../../src/outbox/scrobble-ops';
import type { OutboxOperation } from '../../src/outbox/store';
import {
  ALICE,
  BOB,
  type OutboxFixture,
  outboxFixture,
  PREFIX,
  remoteRecord,
  runUntilIdle,
  SCROBBLE,
  SCROBBLE_INPUT,
} from '../support/fake-pds-browser';

const CREATE = 'com.atproto.repo.createRecord';
const DELETE = 'com.atproto.repo.deleteRecord';
const GET = 'com.atproto.repo.getRecord';

async function create(fx: OutboxFixture, track: string) {
  const r = await enqueueScrobble({
    store: fx.store,
    did: ALICE,
    prefix: PREFIX,
    input: { ...SCROBBLE_INPUT, track },
    clock: fx.clock,
    random: fx.random,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.reason));
  return r.op;
}

async function remove(fx: OutboxFixture, uri: string) {
  const r = await enqueueScrobbleDelete({
    store: fx.store,
    did: ALICE,
    prefix: PREFIX,
    uri: uri as `at://${string}`,
    clock: fx.clock,
    random: fx.random,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.reason));
  return r.op;
}

/** The AppView's Scrobble DTO for a published outbox row. */
function dto(fx: OutboxFixture, row: OutboxOperation): Scrobble {
  const r = row.record as unknown as ScrobbleRecord;
  return {
    uri: row.uri,
    cid: row.cid!,
    did: row.did,
    revision: fx.repo.head!.rev,
    artist: r.artist,
    track: r.track,
    ...(r.album !== undefined ? { album: r.album } : {}),
    listenedAt: r.listenedAt,
    createdAt: r.createdAt,
    ...(r.durationSeconds !== undefined ? { durationSeconds: r.durationSeconds } : {}),
    indexedAt: '2026-01-15T12:00:01.000000000Z',
  };
}

it('pending deletion hidden in owner overlay; failure visible', async () => {
  const fx = await outboxFixture();
  const a = await create(fx, 'Jóga');
  const b = await create(fx, 'Hunter');
  const runner = fx.runner();
  await runUntilIdle(runner, fx.clock);
  const page = [dto(fx, (await fx.store.get(a.id))!), dto(fx, (await fx.store.get(b.id))!)];
  // Someone else's item in the same (feed) page with a colliding rkey is never touched.
  const bobs: Scrobble = { ...page[0]!, uri: `at://${BOB}/${SCROBBLE}/${a.rkey}`, did: BOB };
  const feed = [...page, bobs];

  const before = overlayScrobbles(feed, await fx.ops(), ALICE);
  expect(before.items.map((i) => i.scrobble.uri)).toEqual([a.uri, b.uri, bobs.uri]);
  expect(before.items.every((i) => i.local === undefined)).toBe(true);

  // Hidden as soon as the delete is persisted, before any request.
  fx.pds.fail({ nsid: DELETE }, { kind: 'status', status: 403, error: 'Forbidden', message: 'scope' });
  const del = await remove(fx, a.uri);
  const pending = overlayScrobbles(feed, await fx.ops(), ALICE);
  expect(pending.hidden).toEqual([a.uri]);
  expect(pending.items.map((i) => i.scrobble.uri)).toEqual([b.uri, bobs.uri]);
  expect(fx.pds.count(DELETE)).toBe(0);

  // The PDS refuses the delete: terminal failure, after one request.
  await runUntilIdle(runner, fx.clock);
  expect(await fx.store.get(del.id)).toMatchObject({ state: 'failed', failureCode: 'forbidden_scope', attempts: 1 });
  expect(fx.pds.count(DELETE)).toBe(1);
  expect(await remoteRecord(fx, SCROBBLE, a.rkey)).not.toBeNull();

  // The failure is visible: the record is back, marked, and removal is not claimed.
  const failed = overlayScrobbles(feed, await fx.ops(), ALICE);
  expect(failed.hidden).toEqual([]);
  expect(failed.items.map((i) => i.scrobble.uri)).toEqual([a.uri, b.uri, bobs.uri]);
  expect(failed.items[0]!.local).toEqual({
    opId: del.id,
    kind: 'scrobble_delete',
    state: 'failed',
    failureCode: 'forbidden_scope',
  });
  expect(failed.items[1]!.local).toBeUndefined();

  // A failed create stays visible in the owner's pending list with its code.
  fx.pds.fail({ nsid: CREATE }, { kind: 'status', status: 400, error: 'InvalidRecord', message: 'bad' });
  const c = await create(fx, 'Bachelorette');
  await runUntilIdle(runner, fx.clock);
  const withFailedCreate = overlayScrobbles(feed, await fx.ops(), ALICE);
  expect(withFailedCreate.pending).toEqual([
    {
      uri: c.uri,
      record: c.record,
      local: { opId: c.id, kind: 'scrobble_create', state: 'failed', failureCode: 'invalid_record' },
    },
  ]);
  expect(withFailedCreate.items).toHaveLength(3);
  expect(await fx.store.count(ALICE)).toBe(4);
});

it('delete behind an unsent or in-flight create runs after it and leaves no record on the fake PDS', async () => {
  const fx = await outboxFixture();
  const runner = fx.runner();

  // Unsent: the create is still queued when the delete is enqueued.
  const unsent = await create(fx, 'Jóga');
  const del1 = await remove(fx, unsent.uri);
  expect(del1.predecessorIds).toEqual([unsent.id]);
  expect(overlayScrobbles([], await fx.ops(), ALICE).pending).toEqual([]);
  await runUntilIdle(runner, fx.clock);

  const order1 = fx.session.sent.filter((r) => r.nsid === CREATE || r.nsid === DELETE);
  expect(order1.map((r) => [r.nsid, r.body?.rkey])).toEqual([
    [CREATE, unsent.rkey],
    [DELETE, unsent.rkey],
  ]);
  const createdCid = (await fx.store.get(unsent.id))!.cid;
  expect(order1[1]!.body?.swapRecord).toBe(createdCid);
  expect(await remoteRecord(fx, SCROBBLE, unsent.rkey)).toBeNull();
  expect(await fx.store.get(unsent.id)).toMatchObject({ state: 'published', dueAt: null });
  expect(await fx.store.get(del1.id)).toMatchObject({ state: 'indexed', attempts: 1 });

  // In flight: the createRecord request is on the wire when the delete is enqueued.
  const inflight = await create(fx, 'Hunter');
  const gate = fx.session.hold(CREATE);
  const pass = runner.runDue();
  await gate.reached;
  expect((await fx.store.get(inflight.id))!.state).toBe('running');
  const del2 = await remove(fx, inflight.uri);
  expect(del2.predecessorIds).toEqual([inflight.id]);
  gate.release();
  await pass;
  await runUntilIdle(runner, fx.clock);

  const order2 = fx.session.sent.filter((r) => r.nsid === CREATE || r.nsid === DELETE).slice(2);
  expect(order2.map((r) => [r.nsid, r.body?.rkey])).toEqual([
    [CREATE, inflight.rkey],
    [DELETE, inflight.rkey],
  ]);
  expect(fx.pds.calls.filter({ nsid: DELETE }).map((c) => c.status)).toEqual([200, 200]);
  expect(await remoteRecord(fx, SCROBBLE, inflight.rkey)).toBeNull();
  expect(await fx.repo.list(SCROBBLE)).toEqual([]);
  expect(await fx.store.get(del2.id)).toMatchObject({ state: 'indexed', attempts: 1 });
  expect((await fx.appView.truth(inflight.uri)).state).toBe('absent');

  // In retry backoff: the create's first attempt got a 503, and the delete is
  // enqueued while the create waits for its retry.
  const backoff = await create(fx, 'Bachelorette');
  fx.pds.serverError(CREATE, 503);
  const mark = fx.session.sent.length;
  await runner.runDue();
  const waiting = (await fx.store.get(backoff.id))!;
  expect(waiting).toMatchObject({ state: 'queued', attempts: 1, lastError: 'upstream_unavailable' });
  expect(waiting.dueAt!).toBeGreaterThan(fx.clock.nowMs());
  const del3 = await remove(fx, backoff.uri);
  expect(del3.predecessorIds).toEqual([backoff.id]);
  // The delete is due now, but its create is unsettled: no pass sends anything
  // for it, and the store refuses to start its attempt.
  expect(await runner.runDue()).toBe(waiting.dueAt);
  expect(fx.session.sent.length).toBe(mark + 1);
  expect(await fx.store.beginAttempt(del3.id, fx.clock.nowMs())).toBeNull();
  expect(await fx.store.get(del3.id)).toMatchObject({ state: 'queued', attempts: 0 });
  await runUntilIdle(runner, fx.clock);

  // Nothing touched the rkey before the create's retry: no getRecord, no deleteRecord.
  const order3 = fx.session.sent.slice(mark);
  expect(order3.map((r) => [r.nsid, r.body?.rkey ?? r.params.rkey])).toEqual([
    [CREATE, backoff.rkey],
    [CREATE, backoff.rkey],
    [DELETE, backoff.rkey],
  ]);
  expect(fx.pds.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([200, 200, 503, 200]);
  const backoffCid = (await fx.store.get(backoff.id))!.cid;
  expect(order3[2]!.body?.swapRecord).toBe(backoffCid);
  expect(await remoteRecord(fx, SCROBBLE, backoff.rkey)).toBeNull();
  expect(await fx.repo.list(SCROBBLE)).toEqual([]);
  expect(await fx.store.get(backoff.id)).toMatchObject({ state: 'published', attempts: 2, dueAt: null });
  expect(await fx.store.get(del3.id)).toMatchObject({ state: 'indexed', attempts: 1 });
});

it('delete of a create that lost its rkey to another writer completes locally and never deletes their record', async () => {
  const fx = await outboxFixture();
  const runner = fx.runner();

  // Queued behind the create: another writer holds the rkey with another listen.
  const behind = await create(fx, 'Jóga');
  const theirs = { ...behind.record, track: 'Hunter' };
  const theirCid = (await fx.repo.put(SCROBBLE, behind.rkey, theirs)).ops[0]!.cid;
  const del1 = await remove(fx, behind.uri);
  expect(del1.predecessorIds).toEqual([behind.id]);

  // Enqueued after the create already failed: no predecessor, same rule.
  const after = await create(fx, 'Bachelorette');
  const theirs2 = { ...after.record, track: 'Isobel' };
  const theirCid2 = (await fx.repo.put(SCROBBLE, after.rkey, theirs2)).ops[0]!.cid;
  await runUntilIdle(runner, fx.clock);
  expect(await fx.store.get(after.id)).toMatchObject({ state: 'failed', failureCode: 'remote_record_conflict' });
  const del2 = await remove(fx, after.uri);
  expect(del2.predecessorIds).toEqual([]);
  await runUntilIdle(runner, fx.clock);

  expect(await fx.store.get(behind.id)).toMatchObject({ state: 'failed', failureCode: 'remote_record_conflict' });
  for (const del of [del1, del2]) {
    const row = (await fx.store.get(del.id))!;
    expect(row).toMatchObject({ state: 'indexed', localCompletion: 'record_not_ours', dueAt: null });
    expect(row.swapCid).toBeUndefined();
    expect(row.failureCode).toBeUndefined();
  }
  // Only the creates and their reconciling getRecords reached the PDS.
  expect(fx.session.sent.map((r) => r.nsid)).toEqual([CREATE, GET, CREATE, GET]);
  expect(fx.pds.count(DELETE)).toBe(0);
  expect(fx.pds.count('com.atproto.repo.putRecord')).toBe(0);
  expect(await remoteRecord(fx, SCROBBLE, behind.rkey)).toMatchObject({ cid: theirCid, value: theirs });
  expect(await remoteRecord(fx, SCROBBLE, after.rkey)).toMatchObject({ cid: theirCid2, value: theirs2 });
  expect(fx.appView.notified).toEqual([]);

  // The owner's view keeps the other writer's record visible and drops the failed local create.
  const page: Scrobble[] = [
    {
      uri: behind.uri,
      cid: theirCid!,
      did: ALICE,
      revision: fx.repo.head!.rev,
      artist: SCROBBLE_INPUT.artist,
      track: 'Hunter',
      listenedAt: SCROBBLE_INPUT.listenedAt,
      createdAt: '2026-01-15T12:00:00.000Z',
      indexedAt: '2026-01-15T12:00:01.000000000Z',
    },
  ];
  const view = overlayScrobbles(page, await fx.ops(), ALICE);
  expect(view.hidden).toEqual([]);
  expect(view.items).toEqual([{ scrobble: page[0] }]);
  expect(view.pending).toEqual([]);
});

it('InvalidSwap after another client changed the record re-fetches the CID and retries the delete', async () => {
  const fx = await outboxFixture({ jitter: 'zero' });
  const runner = fx.runner();
  const listen = await create(fx, 'Jóga');
  await runUntilIdle(runner, fx.clock);
  const oldCid = (await fx.store.get(listen.id))!.cid!;
  // Another client edits the record; the AppView still reports the old CID.
  const edited = { ...listen.record, track: 'Jóga (live)' };
  const newCid = (await fx.repo.put(SCROBBLE, listen.rkey, edited)).ops[0]!.cid;
  fx.appView.override(listen.uri, (truth) => (truth.state === 'indexed' ? { ...truth, cid: oldCid } : truth));

  const del = await remove(fx, listen.uri);
  await runner.runDue();
  const afterFirst = (await fx.store.get(del.id))!;
  expect(afterFirst).toMatchObject({ state: 'queued', attempts: 1, lastError: 'repository_changed', swapCid: newCid });
  expect(afterFirst.dueAt! - fx.clock.nowMs()).toBe(1_000);
  fx.appView.clearOverride(listen.uri);
  await runUntilIdle(runner, fx.clock);

  expect(fx.session.sentTo(DELETE).map((r) => r.body?.swapRecord)).toEqual([oldCid, newCid]);
  expect(fx.pds.calls.filter({ nsid: DELETE }).map((c) => c.status)).toEqual([400, 200]);
  expect(await remoteRecord(fx, SCROBBLE, listen.rkey)).toBeNull();
  expect(await fx.store.get(del.id)).toMatchObject({ state: 'indexed', attempts: 2 });
});
