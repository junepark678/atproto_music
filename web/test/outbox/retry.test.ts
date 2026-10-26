// Outbox retry schedule and attempt cap (ADR 0004 §5.2 step 3, §10.4; TESTING.md
// "Outbox tests"; case map M3.2.2). Delays and attempts are counted as fetches
// against the fake PDS, with the frozen clock moved by hand and nothing sleeping.

import { MAX_ATTEMPTS, nextDelayMs } from '@atmusic/core/write-policy';
import { expect, it } from 'vitest';
import { enqueueScrobble } from '../../src/outbox/scrobble-ops';
import {
  ALICE,
  outboxFixture,
  PREFIX,
  remoteRecord,
  runUntilIdle,
  SCROBBLE,
  SCROBBLE_INPUT,
} from '../support/fake-pds-browser';

const CREATE = 'com.atproto.repo.createRecord';

async function enqueue(fx: Awaited<ReturnType<typeof outboxFixture>>) {
  const r = await enqueueScrobble({
    store: fx.store,
    did: ALICE,
    prefix: PREFIX,
    input: SCROBBLE_INPUT,
    clock: fx.clock,
    random: fx.random,
  });
  if (!r.ok) throw new Error(`enqueue failed: ${JSON.stringify(r.reason)}`);
  return r.op;
}

it('zero jitter delays 1,2,4,…,256,300 and exactly 10 attempts with no 11th request', async () => {
  const fx = await outboxFixture({ jitter: 'zero' });
  fx.pds.serverError(CREATE, 503, Number.POSITIVE_INFINITY);
  const op = await enqueue(fx);

  // Persisted before the first attempt.
  expect(await fx.store.count(ALICE)).toBe(1);
  expect(await fx.store.get(op.id)).toMatchObject({ state: 'queued', attempts: 0, dueAt: fx.clock.nowMs() });
  expect(fx.pds.count()).toBe(0);

  const runner = fx.runner();
  const delays: number[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await runner.runDue();
    const row = (await fx.store.get(op.id))!;
    expect(fx.pds.count(CREATE)).toBe(attempt);
    expect(row.attempts).toBe(attempt);
    expect(row.lastError).toBe('upstream_unavailable');
    if (attempt === MAX_ATTEMPTS) break;
    expect(row.state).toBe('queued');
    const delay = row.dueAt! - fx.clock.nowMs();
    delays.push(delay);
    // Not one millisecond early.
    fx.clock.advance(delay - 1);
    await runner.runDue();
    expect(fx.pds.count(CREATE)).toBe(attempt);
    fx.clock.advance(1);
  }
  expect(delays).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256].map((s) => s * 1000));

  // After the tenth failure the operation is terminal; the capped tenth delay
  // (300 s) passes without an eleventh request, also for a fresh runner.
  const failed = (await fx.store.get(op.id))!;
  expect(failed).toMatchObject({ state: 'failed', failureCode: 'upstream_unavailable', attempts: 10, dueAt: null });
  expect(nextDelayMs(MAX_ATTEMPTS, fx.random)).toBe(300_000);
  fx.clock.advance(300_000);
  expect(await runner.runDue()).toBeNull();
  await fx.reload();
  expect(await fx.runner().runDue()).toBeNull();
  expect(fx.pds.count(CREATE)).toBe(10);
  expect(fx.pds.count()).toBe(10);

  // Every attempt sent the same persisted rkey and payload; nothing was created.
  const sent = fx.pds.calls.filter({ nsid: CREATE });
  expect(sent).toHaveLength(10);
  expect(sent.every((c) => c.status === 503)).toBe(true);
  expect(await remoteRecord(fx, SCROBBLE, op.rkey)).toBeNull();
  expect(fx.appView.notified).toEqual([]);
  expect(await fx.store.count(ALICE)).toBe(1);
});

it('Retry-After 20 raises next delay to 20s', async () => {
  const fx = await outboxFixture({ jitter: 'zero' });
  fx.pds.rateLimit(CREATE, 20);
  const op = await enqueue(fx);
  const runner = fx.runner();

  await runner.runDue();
  const afterFirst = (await fx.store.get(op.id))!;
  expect(fx.pds.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([429]);
  expect(afterFirst).toMatchObject({ state: 'queued', attempts: 1, lastError: 'upstream_rate_limited' });
  // Zero jitter would give 1 s; the server asked for 20 s.
  expect(afterFirst.dueAt! - fx.clock.nowMs()).toBe(20_000);

  fx.clock.advance(19_999);
  await runner.runDue();
  expect(fx.pds.count(CREATE)).toBe(1);

  fx.clock.advance(1);
  await runner.runDue();
  expect(fx.pds.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([429, 200]);
  await runUntilIdle(runner, fx.clock);

  const done = (await fx.store.get(op.id))!;
  expect(done).toMatchObject({ state: 'indexed', attempts: 2, dueAt: null });
  expect(done.failureCode).toBeUndefined();
  const remote = await remoteRecord(fx, SCROBBLE, op.rkey);
  expect(remote?.value).toEqual(op.record);
  expect(done.cid).toBe(remote?.cid);
  expect(fx.appView.notified).toEqual([{ uri: op.uri }]);
});

it('nonrecoverable PDS error fails the operation after exactly one request', async () => {
  const fx = await outboxFixture({ jitter: 'zero' });
  fx.pds.fail(
    { nsid: CREATE },
    { kind: 'status', status: 400, error: 'InvalidRecord', message: 'Invalid record' },
    Number.POSITIVE_INFINITY,
  );
  const op = await enqueue(fx);
  const runner = fx.runner();

  expect(await runUntilIdle(runner, fx.clock)).toEqual([]);
  fx.clock.advance(3_600_000);
  expect(await runner.runDue()).toBeNull();

  expect(await fx.store.get(op.id)).toMatchObject({
    state: 'failed',
    failureCode: 'invalid_record',
    attempts: 1,
    dueAt: null,
  });
  // One request in total: no retry, no getRecord, no notify.
  expect(fx.pds.count()).toBe(1);
  expect(fx.pds.count(CREATE)).toBe(1);
  expect(fx.session.sent.map((r) => r.nsid)).toEqual([CREATE]);
  expect(fx.appView.notified).toEqual([]);
  expect(fx.appView.statusPolls).toEqual([]);
  expect(await remoteRecord(fx, SCROBBLE, op.rkey)).toBeNull();
});

it('a crash during the tenth attempt is reconciled read-only, never with an eleventh create', async () => {
  const fx = await outboxFixture({ jitter: 'zero' });
  fx.pds.serverError(CREATE, 500, 9);
  const op = await enqueue(fx);
  const runner = fx.runner();
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    await runner.runDue();
    fx.clock.advance((await fx.store.get(op.id))!.dueAt! - fx.clock.nowMs());
  }
  expect(fx.pds.count(CREATE)).toBe(9);

  // The tenth send commits on the PDS, then the tab dies.
  const crashed = fx.session.crashOn(CREATE, 'after_commit');
  void runner.runDue();
  await crashed;
  expect(await fx.store.get(op.id)).toMatchObject({ state: 'running', attempts: 10 });

  await fx.reload();
  await runUntilIdle(fx.runner(), fx.clock);
  expect(fx.pds.count(CREATE)).toBe(10);
  expect(fx.session.sentTo(CREATE)).toEqual([]);
  expect(fx.session.sentTo('com.atproto.repo.getRecord')).toHaveLength(1);
  const remote = await remoteRecord(fx, SCROBBLE, op.rkey);
  expect(await fx.store.get(op.id)).toMatchObject({ state: 'indexed', attempts: 10, cid: remote!.cid });
});

it('a notify answered 503 is retried before records/status polling', async () => {
  const fx = await outboxFixture();
  fx.appView.notifyFailures = 1;
  const op = await enqueue(fx);
  const jumps = await runUntilIdle(fx.runner(), fx.clock);

  expect(fx.appView.notified).toEqual([{ uri: op.uri }, { uri: op.uri }]);
  expect(fx.appView.statusPolls).toEqual([op.uri]);
  expect(jumps).toEqual([1_000]);
  expect(await fx.store.get(op.id)).toMatchObject({ state: 'indexed', notified: true, attempts: 1 });
  expect(fx.pds.count(CREATE)).toBe(1);
});
