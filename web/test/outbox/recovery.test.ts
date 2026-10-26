// Crash barriers and reconciliation (ADR 0004 §5.2, §9 A11/A12, §10.4;
// TESTING.md crash stages; case map M3.1.1, M3.2.1, M3.2.3, M3.3.2, M3.4.2,
// M5.3.1). A crash is simulated by abandoning a runner whose PDS request never
// answers (a barrier in the injected session), then re-instantiating the
// runner over the same IndexedDB with a new connection (`fx.reload()`).

import type { RecordStatus } from '@atmusic/core/api-types';
import { canonicalDigest } from '@atmusic/core/canonical';
import { followRkey, sha256Hex } from '@atmusic/core/record-key';
import { expect, it, vi } from 'vitest';
import { enqueueScrobbleDelete } from '../../src/outbox/delete-ops';
import { enqueueFollow } from '../../src/outbox/follow-ops';
import { outboxLockName, type Scheduler } from '../../src/outbox/runner';
import { enqueueScrobble } from '../../src/outbox/scrobble-ops';
import {
  ALICE,
  BOB,
  FakePdsSession,
  FOLLOW,
  memoryLocks,
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

async function enqueueListen(fx: OutboxFixture, input: object = SCROBBLE_INPUT) {
  const r = await enqueueScrobble({
    store: fx.store,
    did: ALICE,
    prefix: PREFIX,
    input,
    clock: fx.clock,
    random: fx.random,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.reason));
  return r.op;
}

/** Publishes one scrobble through the outbox and waits until the AppView reports it indexed. */
async function publishedListen(fx: OutboxFixture) {
  const op = await enqueueListen(fx);
  await runUntilIdle(fx.runner(), fx.clock);
  const row = (await fx.store.get(op.id))!;
  expect(row.state).toBe('indexed');
  return row;
}

async function deleteOp(fx: OutboxFixture, uri: string) {
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

it('crash before send: operation resumes with same rkey', async () => {
  const fx = await outboxFixture();
  const op = await enqueueListen(fx);

  // Barrier: the attempt is persisted, the request never leaves the tab.
  const crashed = fx.session.crashOn(CREATE, 'before_send');
  void fx.runner().runDue();
  await crashed;
  expect(fx.pds.count()).toBe(0);
  expect(await fx.store.get(op.id)).toMatchObject({ state: 'running', attempts: 1, rkey: op.rkey });

  // Reload later: a new connection and runner over the same IndexedDB.
  fx.clock.advance(120_000);
  await fx.reload();
  await runUntilIdle(fx.runner(), fx.clock);

  const rows = await fx.ops();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: op.id, rkey: op.rkey, uri: op.uri, state: 'indexed', attempts: 2 });
  expect(fx.session.sentTo(CREATE).map((r) => r.body?.rkey)).toEqual([op.rkey]);
  expect(fx.pds.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([200]);
  // Exactly one PDS record, at the persisted rkey, with the persisted payload.
  const listed = await fx.repo.list(SCROBBLE);
  expect(listed.map((r) => r.rkey)).toEqual([op.rkey]);
  expect(listed[0]!.value).toEqual(op.record);
  expect(await canonicalDigest(listed[0]!.value)).toBe(op.digest);
  expect(fx.appView.notified).toEqual([{ uri: op.uri }]);
});

it('crash after PDS commit before local ack: ambiguous create reconciles to success via digest', async () => {
  const fx = await outboxFixture();
  const op = await enqueueListen(fx);

  const crashedTab = fx.session;
  const crashed = crashedTab.crashOn(CREATE, 'after_commit');
  void fx.runner().runDue();
  await crashed;
  // The PDS committed; the tab never learned it.
  const committed = await remoteRecord(fx, SCROBBLE, op.rkey);
  expect(committed?.value).toEqual(op.record);
  expect(await fx.store.get(op.id)).toMatchObject({ state: 'running', attempts: 1 });

  fx.clock.advance(300_000);
  await fx.reload();
  await runUntilIdle(fx.runner(), fx.clock);

  // Resent at the same rkey → RecordAlreadyExists → getRecord → equal digest → success.
  expect(fx.pds.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([200, 400]);
  expect([...crashedTab.sentTo(CREATE), ...fx.session.sentTo(CREATE)].map((r) => r.body?.record)).toEqual([
    op.record,
    op.record,
  ]);
  expect([...crashedTab.sentTo(CREATE), ...fx.session.sentTo(CREATE)].map((r) => r.body?.rkey)).toEqual([
    op.rkey,
    op.rkey,
  ]);
  expect(fx.pds.count(GET)).toBe(1);
  expect(fx.pds.count('com.atproto.repo.putRecord')).toBe(0);
  const row = (await fx.store.get(op.id))!;
  expect(row).toMatchObject({ state: 'indexed', attempts: 2, cid: committed!.cid });
  expect(row.failureCode).toBeUndefined();
  // Still exactly one record, unchanged (its createdAt is the original one).
  const listed = await fx.repo.list(SCROBBLE);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ rkey: op.rkey, cid: committed!.cid });
  expect(fx.appView.notified).toEqual([{ uri: op.uri }]);
  expect(await fx.store.count(ALICE)).toBe(1);
});

it('remote record with different payload at rkey → remote_record_conflict, never overwritten', async () => {
  const fx = await outboxFixture();
  const op = await enqueueListen(fx);
  // Another writer already holds this rkey with a different listen.
  const other = { ...op.record, track: 'Hunter' };
  const theirs = await fx.repo.put(SCROBBLE, op.rkey, other);
  const theirCid = theirs.ops[0]!.cid;

  await runUntilIdle(fx.runner(), fx.clock);

  expect(await fx.store.get(op.id)).toMatchObject({
    state: 'failed',
    failureCode: 'remote_record_conflict',
    attempts: 1,
    dueAt: null,
  });
  expect(fx.pds.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([400]);
  expect(fx.pds.count(GET)).toBe(1);
  // Never overwritten, never deleted.
  expect(fx.pds.count('com.atproto.repo.putRecord')).toBe(0);
  expect(fx.pds.count(DELETE)).toBe(0);
  const remote = await remoteRecord(fx, SCROBBLE, op.rkey);
  expect(remote?.cid).toBe(theirCid);
  expect(remote?.value).toEqual(other);
  expect(fx.appView.notified).toEqual([]);
});

it('crash during delete resumes with swapRecord and verifies absence', async () => {
  const fx = await outboxFixture();
  const listen = await publishedListen(fx);
  const del = await deleteOp(fx, listen.uri);

  const crashed = fx.session.crashOn(DELETE, 'after_commit');
  void fx.runner().runDue();
  await crashed;
  // The PDS deleted it; locally the delete is still running with its swap CID persisted.
  expect(await remoteRecord(fx, SCROBBLE, listen.rkey)).toBeNull();
  expect(await fx.store.get(del.id)).toMatchObject({ state: 'running', attempts: 1, swapCid: listen.cid });

  fx.clock.advance(60_000);
  await fx.reload();
  await runUntilIdle(fx.runner(), fx.clock);

  // The resumed attempt sent the same swapRecord, got InvalidSwap, re-fetched: absent.
  const deletes = fx.session.sentTo(DELETE);
  expect(deletes).toHaveLength(1); // the reloaded session's log
  expect(deletes[0]!.body).toMatchObject({
    repo: ALICE,
    collection: SCROBBLE,
    rkey: listen.rkey,
    swapRecord: listen.cid,
  });
  expect(fx.pds.calls.filter({ nsid: DELETE }).map((c) => c.status)).toEqual([200, 400]);
  expect(await fx.store.get(del.id)).toMatchObject({ state: 'indexed', attempts: 2, dueAt: null });
  expect(await remoteRecord(fx, SCROBBLE, listen.rkey)).toBeNull();
  expect((await fx.appView.truth(listen.uri)).state).toBe('absent');
  expect(fx.appView.notified).toEqual([{ uri: listen.uri }, { uri: listen.uri }]);
});

it('RecordNotFound on first and repeated delete completes the operation as success', async () => {
  const fx = await outboxFixture();
  const listen = await publishedListen(fx);
  // Another client already removed it; the AppView still shows the old CID.
  await fx.repo.delete(SCROBBLE, listen.rkey);
  let stale = true;
  fx.appView.override(listen.uri, (truth) =>
    stale
      ? ({
          uri: listen.uri,
          state: 'indexed',
          cid: listen.cid!,
          revision: '3mchjvhag2322',
          indexing: truth.indexing,
        } as RecordStatus)
      : truth,
  );
  // This PDS answers RecordNotFound for a delete of an absent key.
  fx.pds.fail(
    { nsid: DELETE },
    { kind: 'status', status: 400, error: 'RecordNotFound', message: 'Could not locate record' },
    2,
  );

  const first = await deleteOp(fx, listen.uri);
  const runner = fx.runner();
  await runner.runDue();
  stale = false;
  await runUntilIdle(runner, fx.clock);

  stale = true;
  const repeated = await deleteOp(fx, listen.uri);
  await runner.runDue();
  stale = false;
  await runUntilIdle(runner, fx.clock);

  for (const op of [first, repeated]) {
    const row = (await fx.store.get(op.id))!;
    expect(row).toMatchObject({ state: 'indexed', attempts: 1, dueAt: null });
    expect(row.failureCode).toBeUndefined();
  }
  expect(fx.pds.calls.filter({ nsid: DELETE }).map((c) => c.status)).toEqual([400, 400]);
  expect(fx.session.sentTo(DELETE).every((r) => r.body?.swapRecord === listen.cid)).toBe(true);
  expect(fx.pds.faults.pending).toBe(0);
  expect(await remoteRecord(fx, SCROBBLE, listen.rkey)).toBeNull();
});

it('crash after follow createRecord before local ack reconciles to one record at the deterministic rkey', async () => {
  const fx = await outboxFixture();
  const r = await enqueueFollow({
    store: fx.store,
    did: ALICE,
    prefix: PREFIX,
    subject: BOB,
    clock: fx.clock,
    random: fx.random,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.reason));
  const op = r.op;
  const rkey = `f${await sha256Hex(BOB)}`;
  expect(op.rkey).toBe(rkey);
  expect(await followRkey(BOB)).toBe(rkey);

  const crashed = fx.session.crashOn(CREATE, 'after_commit');
  void fx.runner().runDue();
  await crashed;
  const committed = await remoteRecord(fx, FOLLOW, rkey);
  expect(committed?.value).toEqual(op.record);

  // Much later, so a rebuilt record would carry a different createdAt.
  fx.clock.advance(3_600_000);
  await fx.reload();
  await runUntilIdle(fx.runner(), fx.clock);

  expect(fx.pds.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([200, 400]);
  expect(fx.session.sentTo(CREATE).map((s) => s.body?.rkey)).toEqual([rkey]);
  const listed = await fx.repo.list(FOLLOW);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ rkey, cid: committed!.cid });
  expect((listed[0]!.value as { createdAt: string; subject: string }).createdAt).toBe(
    (op.record as { createdAt: string }).createdAt,
  );
  expect(await fx.store.get(op.id)).toMatchObject({ state: 'indexed', attempts: 2, cid: committed!.cid });
});

it('one runner per DID: a second tab waits for the Web Lock and takes over after the first stops', async () => {
  const fx = await outboxFixture();
  const locks = memoryLocks();
  // Sleeps until woken; time only moves by hand.
  const scheduler: Scheduler = {
    sleep: (_ms, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      }),
  };
  const tabA = fx.runner({ locks, scheduler });
  const sessionB = new FakePdsSession(fx.pds, ALICE);
  const tabB = fx.runner({ locks, scheduler, session: sessionB });
  const loopA = tabA.start();
  const loopB = tabB.start();

  const first = await enqueueListen(fx);
  tabA.wake();
  tabB.wake();
  await vi.waitFor(async () => expect((await fx.store.get(first.id))?.state).toBe('published'));
  expect(locks.holders(outboxLockName(ALICE))).toBe(1);
  expect(fx.session.sentTo(CREATE)).toHaveLength(1);
  expect(sessionB.sent).toEqual([]);

  await tabA.stop();
  await loopA;
  const second = await enqueueListen(fx, { ...SCROBBLE_INPUT, track: 'Hunter' });
  tabB.wake();
  await vi.waitFor(async () => expect((await fx.store.get(second.id))?.state).toBe('published'));
  expect(sessionB.sentTo(CREATE).map((s) => s.body?.rkey)).toEqual([second.rkey]);
  expect(fx.session.sentTo(CREATE)).toHaveLength(1);
  expect(fx.pds.count(CREATE)).toBe(2);

  await tabB.stop();
  await loopB;
  expect(locks.holders(outboxLockName(ALICE))).toBe(0);
});
