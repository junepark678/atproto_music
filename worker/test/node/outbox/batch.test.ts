// applyWrites batching and bisection, and the PdsWriter path (ADR 0005 §5.8
// "Batching", "Writer port", §3.5; N2-05).

import { expect, it } from 'vitest';
import type { OperationRow } from '../../../src/app/rows';
import { encodeBatch, MAX_BATCH_BYTES } from '../../../src/outbox/apply-writes';
import { acceptListens } from '../../../src/outbox/ingress';
import { prepare } from '../../../src/outbox/operations';
import { enqueueScrobbleCreates, insertScrobbleCreate } from '../../../src/outbox/scrobble-ops';
import {
  APPLY,
  CREATE,
  GET,
  type Harness,
  listenInput,
  remoteRecords,
  SCROBBLE,
  T0,
  withHarness,
  zeroJitter,
} from './support';

async function importCreates(h: Harness, n: number, did = h.alice): Promise<OperationRow[]> {
  const r = await enqueueScrobbleCreates(h.m, {
    did,
    origin: 'import',
    inputs: Array.from({ length: n }, (_, i) => listenInput(i)),
    importJobId: 'job-1',
  });
  if (!r.ok) throw new Error(JSON.stringify(r.reason));
  return r.operations;
}

/** Records written per rkey by the fake PDS's commits. */
function commitCounter(h: Harness, name: 'Alice' | 'Bob'): Map<string, number> {
  const writes = new Map<string, number>();
  h.kit.pds[name].onCommit((_did, commit) => {
    for (const op of commit.ops) {
      if (op.action === 'delete') continue;
      writes.set(op.rkey, (writes.get(op.rkey) ?? 0) + 1);
    }
  });
  return writes;
}

it('437 import creates go as applyWrites batches of 200, 200 and 37; a 250 KB-record set splits to stay under 1,000,000 bytes', async () => {
  await withHarness(async (h) => {
    const ops = await importCreates(h, 437);
    expect(ops.every((o) => o.priority === 1 && o.origin === 'import' && o.import_job_id === 'job-1')).toBe(true);
    const reports = await h.runUntilIdle();
    expect(reports.flatMap((r) => r.batches)).toEqual([200, 200, 37]);
    expect(h.writers.order()).toEqual([APPLY, APPLY, APPLY]);
    expect(h.writers.sent.map((s) => (s.body!.writes as unknown[]).length)).toEqual([200, 200, 37]);
    // FIFO: the batches carry the operations in their persisted order and rkeys.
    expect(h.writers.sent.flatMap((s) => (s.body!.writes as { rkey: string }[]).map((w) => w.rkey))).toEqual(
      ops.map((o) => o.rkey),
    );
    expect(h.ops().every((o) => o.state === 'succeeded' && o.attempts === 1 && o.result_cid !== null)).toBe(true);
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(437);
    // 437 creates × 3 points, charged before sending and confirmed by the PDS headers.
    expect(h.db.one('SELECT points FROM pds_budget WHERE did = ? AND window = ?', h.alice, 'hour')).toEqual({
      points: 1311,
    });
    expect(h.kit.pds.Alice.pointsRemaining(h.alice)).toBe(5000 - 1311);

    // Six records of about 250 KB each: four would exceed the 1,000,000-byte body limit.
    const big = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        prepare({
          $type: SCROBBLE,
          artist: `Long ${i}`,
          track: 'x'.repeat(250_000),
          listenedAt: new Date(T0 - (i + 1) * 60_000).toISOString(),
          createdAt: '2026-01-15T12:00:00Z',
        }),
      ),
    );
    const bigOps = h.db.tx(() =>
      big.map((prepared) => insertScrobbleCreate(h.m, { did: h.bob, origin: 'import', prepared }, T0)),
    );
    expect(encodeBatch(h.bob, bigOps.slice(0, 4)).bytes).toBeGreaterThan(MAX_BATCH_BYTES);
    const mark = h.seen.length;
    const bigReports = await h.runUntilIdle();
    expect(bigReports.flatMap((r) => r.batches)).toEqual([3, 3]);
    const applies = h.seen.slice(mark).filter((s) => s.url.endsWith(`/xrpc/${APPLY}`));
    expect(applies).toHaveLength(2);
    for (const request of applies) {
      expect(request.bytes).toBeGreaterThan(750_000);
      expect(request.bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
    // The fake PDS (jsonLimit 1,000,000) accepted both; nothing was refused as 413.
    expect(h.kit.pds.Bob.calls.filter({ nsid: APPLY }).map((c) => c.status)).toEqual([200, 200]);
    expect(bigOps.every((o) => h.op(o.id).state === 'succeeded')).toBe(true);
    expect(await remoteRecords(h.kit, 'Bob', SCROBBLE)).toHaveLength(6);
  });
});

it('a batch failing because one rkey exists is bisected; the other 199 are written once and the existing one is reconciled by digest', async () => {
  await withHarness(async (h) => {
    const ops = await importCreates(h, 200);
    const existing = ops[137]!;
    // The same record is already at one rkey (a batch that landed before a crash, or a lost answer).
    const prior = await h.kit.externalPut('Alice', SCROBBLE, existing.rkey!, JSON.parse(existing.record_json!));
    const writes = commitCounter(h, 'Alice');

    const reports = await h.runUntilIdle();
    expect(reports.flatMap((r) => r.batches)).toEqual([200]);
    // Bisected down to the one create, which reconciles by digest: no second write at its rkey.
    const applyStatuses = h.writers.sent.filter((s) => s.nsid === APPLY).map((s) => s.status);
    expect(applyStatuses[0]).toBe(400);
    expect(applyStatuses.filter((s) => s === 400).length).toBeGreaterThan(1);
    expect(h.writers.sent.filter((s) => s.nsid === CREATE).map((s) => [s.body?.rkey, s.status])).toEqual([
      [existing.rkey, 400],
    ]);
    expect(h.writers.sent.filter((s) => s.nsid === GET).map((s) => s.status)).toEqual([200]);
    for (const op of ops) {
      expect(writes.get(op.rkey!) ?? 0).toBe(op.id === existing.id ? 0 : 1);
    }
    expect([...writes.values()].reduce((a, b) => a + b, 0)).toBe(199);
    // Every operation succeeded with its one counted attempt; the existing record kept its CID.
    for (const op of ops) expect(h.op(op.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
    expect(h.op(existing.id).result_cid).toBe(prior.ops[0]!.cid);
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(200);
  });
});

it('a 200-write batch whose answer was lost after the PDS committed is reconciled with getRecord reads, spending no write points; a batch refused with 500 is read back and written once', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const ops = await importCreates(h, 200);
    const writes = commitCounter(h, 'Alice');
    const crashed = h.writers.crashOn(APPLY, 'after_commit');
    void h.run();
    await crashed;
    expect(h.kit.pds.Alice.pointsRemaining(h.alice)).toBe(5000 - 600);
    h.restart();

    const mark = h.writers.sent.length;
    const reports = await h.runUntilIdle();
    const after = h.writers.sent.slice(mark);
    // Every member is looked up, none is written again.
    expect(after.map((s) => s.nsid)).toEqual(Array(200).fill(GET));
    expect(after.every((s) => s.status === 200)).toBe(true);
    expect(reports.flatMap((r) => r.batches)).toEqual([200]);
    expect(reports.at(-1)!.nextDueMs).toBeNull();
    // Each record was committed once, by the batch whose answer was lost.
    for (const op of ops) expect(writes.get(op.rkey!)).toBe(1);
    expect([...writes.values()].reduce((a, b) => a + b, 0)).toBe(200);
    expect(h.kit.pds.Alice.pointsRemaining(h.alice)).toBe(5000 - 600);
    expect(h.db.all(`SELECT window, points FROM pds_budget WHERE did = ? ORDER BY window`, h.alice)).toEqual([
      { window: 'day', points: 600 },
      { window: 'hour', points: 600 },
    ]);
    const remote = new Map((await remoteRecords(h.kit, 'Alice', SCROBBLE)).map((r) => [r.rkey, r.cid]));
    for (const op of ops) {
      expect(h.op(op.id)).toMatchObject({ state: 'succeeded', attempts: 2, result_cid: remote.get(op.rkey!) });
    }
    // Each reconciled record is hinted like a written one.
    expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM hints WHERE source = 'notify'`)!.n).toBe(200);
  });

  await withHarness(
    async (h) => {
      const ops = await importCreates(h, 200);
      const writes = commitCounter(h, 'Alice');
      h.kit.pds.Alice.serverError(APPLY, 500, 1);
      await h.run();
      expect(h.ops().every((o) => o.state === 'queued' && o.attempts === 1)).toBe(true);
      h.kit.clock.advance(1_000);
      const mark = h.writers.sent.length;
      await h.runUntilIdle();
      // The 500 may have committed: every member is read (absent), then the batch is written once.
      expect(h.writers.sent.slice(mark).map((s) => [s.nsid, s.status])).toEqual([
        ...Array(200).fill([GET, 400]),
        [APPLY, 200],
      ]);
      for (const op of ops) {
        expect(writes.get(op.rkey!)).toBe(1);
        expect(h.op(op.id)).toMatchObject({ state: 'succeeded', attempts: 2 });
      }
    },
    { random: zeroJitter() },
  );
});

it('PdsWriter requests reach the fake PDS through policyFetch, and a 3xx from the PDS is a retryable TransportError redirect, never followed', async () => {
  await withHarness(
    async (h) => {
      const r = await acceptListens(h.m, {
        did: h.alice,
        origin: 'web',
        listens: [{ input: listenInput(0) }],
        receiptMs: T0,
      });
      const id = r.results[0]?.status === 'accepted' ? r.results[0].operationId! : '';
      h.kit.pds.Alice.redirect(CREATE, `https://${h.kit.users.Bob.host}/xrpc/${CREATE}`);

      await h.run();
      // The request went through policyFetch to the fake PDS (manual redirects, the writer's credentials) …
      expect(h.seen.map((s) => [s.method, new URL(s.url).host, s.redirect, s.authorization])).toEqual([
        ['POST', h.kit.users.Alice.host, 'manual', `Bearer ${h.kit.users.Alice.token}`],
      ]);
      expect(h.kit.pds.Alice.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([302]);
      // … and the 302 became TransportError `redirect`: transient, Location never requested.
      expect(h.kit.pds.Bob.count()).toBe(0);
      expect(h.op(id)).toMatchObject({ state: 'queued', attempts: 1, last_error: 'transport_redirect' });
      expect(h.op(id).due_at).toBe(T0 + 1_000);

      h.kit.clock.advance(1_000);
      await h.runUntilIdle();
      expect(h.seen.map((s) => new URL(s.url).host)).toEqual([h.kit.users.Alice.host, h.kit.users.Alice.host]);
      expect(h.kit.pds.Alice.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([302, 200]);
      expect(h.op(id)).toMatchObject({ state: 'succeeded', attempts: 2, last_error: null });
      expect(h.kit.pds.Bob.count()).toBe(0);
    },
    { random: zeroJitter() },
  );
});
