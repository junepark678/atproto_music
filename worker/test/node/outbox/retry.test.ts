// Outbox retry schedule and attempt cap on the server (ADR 0005 §5.8, ADR 0004
// §5.2 step 3; N2-05; ports web/test/outbox/retry.test.ts, cases M3.2.2).
// Delays and attempts are counted as requests the fake PDS received, with the
// frozen clock moved by hand and nothing sleeping.

import { MAX_ATTEMPTS, nextDelayMs } from '@atmusic/core/write-policy';
import { expect, it } from 'vitest';
import { acceptListens } from '../../../src/outbox/ingress';
import { outboxExtension } from '../../../src/outbox/runner';
import { CREATE, GET, type Harness, listenInput, remoteRecord, SCROBBLE, T0, withHarness, zeroJitter } from './support';

async function enqueueOne(h: Harness, i = 0) {
  const r = await acceptListens(h.m, {
    did: h.alice,
    origin: 'web',
    listens: [{ input: listenInput(i) }],
    receiptMs: h.kit.clock.nowMs(),
  });
  const first = r.results[0];
  if (first?.status !== 'accepted' || first.operationId === null) throw new Error('not accepted');
  return h.op(first.operationId);
}

it('retry delays are 1, 2, 4 ... s capped at 300 s with zero jitter; Retry-After: 20 gives 20 s; exactly 10 attempts and no 11th PDS request', async () => {
  await withHarness(
    async (h) => {
      h.kit.pds.Alice.serverError(CREATE, 503, Number.POSITIVE_INFINITY);
      const op = await enqueueOne(h);
      // Persisted before the first attempt.
      expect(h.op(op.id)).toMatchObject({ state: 'queued', attempts: 0, due_at: T0 });
      expect(h.kit.pds.Alice.count()).toBe(0);

      const delays: number[] = [];
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const report = await h.run();
        const row = h.op(op.id);
        expect(h.kit.pds.Alice.count(CREATE)).toBe(attempt);
        expect([row.attempts, row.last_error]).toEqual([attempt, 'upstream_unavailable']);
        if (attempt === MAX_ATTEMPTS) break;
        expect(row.state).toBe('queued');
        const delay = row.due_at - h.kit.clock.nowMs();
        expect(report.nextDueMs).toBe(row.due_at);
        delays.push(delay);
        // Not one millisecond early.
        h.kit.clock.advance(delay - 1);
        expect((await h.run()).attempted).toBe(0);
        expect(h.kit.pds.Alice.count(CREATE)).toBe(attempt);
        h.kit.clock.advance(1);
      }
      expect(delays).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256].map((s) => s * 1000));
      // The tenth delay would be capped at 300 s; there is no eleventh attempt to wait for.
      expect(nextDelayMs(MAX_ATTEMPTS, zeroJitter())).toBe(300_000);
      expect(nextDelayMs(20, zeroJitter())).toBe(300_000);
      expect(h.op(op.id)).toMatchObject({ state: 'failed', last_error: 'upstream_unavailable', attempts: 10 });
      h.kit.clock.advance(3_600_000);
      expect(await h.run()).toMatchObject({ attempted: 0, nextDueMs: null });
      // A restarted process sends nothing more either.
      h.restart();
      expect(await h.run()).toMatchObject({ attempted: 0, nextDueMs: null });
      expect(h.kit.pds.Alice.count(CREATE)).toBe(10);
      expect(h.kit.pds.Alice.count()).toBe(10);
      // Every attempt sent the same persisted rkey and record.
      const sent = h.writers.sent.filter((s) => s.nsid === CREATE);
      expect(sent.map((s) => [s.body?.rkey, s.status])).toEqual(Array(10).fill([op.rkey, 503]));
      expect(sent.every((s) => JSON.stringify(s.body?.record) === op.record_json)).toBe(true);
      expect(await remoteRecord(h.kit, 'Alice', SCROBBLE, op.rkey!)).toBeNull();
    },
    { random: zeroJitter() },
  );

  // Retry-After: 20 raises the first delay from 1 s to 20 s.
  await withHarness(
    async (h) => {
      h.kit.pds.Alice.rateLimit(CREATE, 20);
      const op = await enqueueOne(h);
      await h.run();
      expect(h.op(op.id)).toMatchObject({ state: 'queued', attempts: 1, last_error: 'upstream_rate_limited' });
      expect(h.op(op.id).due_at - h.kit.clock.nowMs()).toBe(20_000);
      h.kit.clock.advance(19_999);
      await h.run();
      expect(h.kit.pds.Alice.count(CREATE)).toBe(1);
      h.kit.clock.advance(1);
      await h.runUntilIdle();
      expect(h.kit.pds.Alice.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([429, 200]);
      expect(h.op(op.id)).toMatchObject({ state: 'succeeded', attempts: 2 });
    },
    { random: zeroJitter() },
  );
});

it('Retry-After 20 raises next delay to 20s', async () => {
  await withHarness(
    async (h) => {
      h.kit.pds.Alice.rateLimit(CREATE, 20);
      const op = await enqueueOne(h);
      await h.run();
      const afterFirst = h.op(op.id);
      expect(h.kit.pds.Alice.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([429]);
      expect(afterFirst).toMatchObject({ state: 'queued', attempts: 1, last_error: 'upstream_rate_limited' });
      // Zero jitter would give 1 s; the server asked for 20 s.
      expect(afterFirst.due_at - h.kit.clock.nowMs()).toBe(20_000);
      h.kit.clock.advance(20_000);
      await h.runUntilIdle();
      const done = h.op(op.id);
      const remote = await remoteRecord(h.kit, 'Alice', SCROBBLE, op.rkey!);
      expect(done).toMatchObject({ state: 'succeeded', attempts: 2, last_error: null, result_cid: remote?.cid });
      expect(remote?.value).toEqual(JSON.parse(op.record_json!));
    },
    { random: zeroJitter() },
  );
});

it('nonrecoverable PDS error fails the operation after exactly one request', async () => {
  await withHarness(async (h) => {
    h.kit.pds.Alice.fail(
      { nsid: CREATE },
      { kind: 'status', status: 400, error: 'InvalidRecord', message: 'Invalid record' },
      Number.POSITIVE_INFINITY,
    );
    const op = await enqueueOne(h);
    await h.runUntilIdle();
    h.kit.clock.advance(3_600_000);
    expect(await h.run()).toMatchObject({ attempted: 0, nextDueMs: null });
    expect(h.op(op.id)).toMatchObject({ state: 'failed', last_error: 'invalid_record', attempts: 1 });
    // One request in total: no retry, no getRecord, no hint.
    expect(h.writers.order()).toEqual([CREATE]);
    expect(h.kit.pds.Alice.count()).toBe(1);
    expect(h.db.one<{ n: number }>('SELECT count(*) AS n FROM hints')!.n).toBe(0);
  });
});

it('a crash during the tenth attempt is reconciled read-only, never with an eleventh create', async () => {
  await withHarness(
    async (h) => {
      h.kit.pds.Alice.serverError(CREATE, 500, 9);
      const op = await enqueueOne(h);
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
        await h.run();
        h.kit.clock.advance(h.op(op.id).due_at - h.kit.clock.nowMs());
      }
      expect(h.kit.pds.Alice.count(CREATE)).toBe(9);
      // The tenth send commits on the PDS, then the process dies.
      const crashed = h.writers.crashOn(CREATE, 'after_commit');
      void h.run();
      await crashed;
      expect(h.op(op.id)).toMatchObject({ state: 'running', attempts: 10 });

      h.restart();
      const before = h.writers.sent.length;
      await h.runUntilIdle();
      expect(h.writers.sent.slice(before).map((s) => s.nsid)).toEqual([GET]);
      expect(h.kit.pds.Alice.count(CREATE)).toBe(10);
      const remote = await remoteRecord(h.kit, 'Alice', SCROBBLE, op.rkey!);
      expect(h.op(op.id)).toMatchObject({ state: 'succeeded', attempts: 10, result_cid: remote!.cid });
    },
    { random: zeroJitter() },
  );
});

it('the outbox extension timer runs due work and reschedules itself at the next retry', async () => {
  await withHarness(
    async (h) => {
      h.kit.pds.Alice.serverError(CREATE, 503, 1);
      const op = await enqueueOne(h);
      const scheduled: [string, number, unknown][] = [];
      const ctx = {
        deps: h.m,
        schedule: (name: 'outbox', dueAtMs: number, options?: unknown) => {
          scheduled.push([name, dueAtMs, options]);
          return dueAtMs;
        },
        kick: () => null,
      };
      const extension = outboxExtension({ writers: h.writers });
      expect(extension.name).toBe('outbox');
      extension.start?.(ctx as never, T0);
      expect(scheduled).toEqual([['outbox', T0, undefined]]);
      await extension.timers!.outbox!(T0, ctx as never);
      expect(h.op(op.id)).toMatchObject({ state: 'queued', attempts: 1 });
      expect(scheduled.at(-1)).toEqual(['outbox', T0 + 1_000, { force: true }]);
      h.kit.clock.advance(1_000);
      await extension.timers!.outbox!(T0 + 1_000, ctx as never);
      expect(h.op(op.id)).toMatchObject({ state: 'succeeded', attempts: 2 });
      // Nothing is left: the timer is not rescheduled (one-shot until the next kick).
      expect(scheduled).toHaveLength(2);
    },
    { random: zeroJitter() },
  );
});
