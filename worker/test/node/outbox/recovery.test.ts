// Crash barriers and ambiguous creates on the server (ADR 0005 §5.8, ADR 0004
// §5.2, A11; N2-05; ports web/test/outbox/recovery.test.ts, cases M3.2.1
// rkey_persistence, M3.2.3, M3.4.2). A "crash" is a writer request that never
// answers (before it is sent, or after the PDS committed); the database is
// then closed and reopened and a fresh runner continues, as a restarted
// process would.

import { canonicalDigest } from '@atmusic/core/canonical';
import { expect, it } from 'vitest';
import type { OperationRow } from '../../../src/app/rows';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { enqueueFollow } from '../../../src/outbox/follow-ops';
import { acceptListens } from '../../../src/outbox/ingress';
import {
  CREATE,
  DELETE,
  FOLLOW,
  GET,
  type Harness,
  listenInput,
  PUT,
  remoteRecord,
  remoteRecords,
  SCROBBLE,
  withHarness,
  zeroJitter,
} from './support';

async function enqueueOne(h: Harness, i: number): Promise<OperationRow> {
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

/** Successful write commits the fake PDS answered for `nsid`. */
function committed(h: Harness, nsid: string): number {
  return h.kit.pds.Alice.calls.filter({ nsid, status: 200 }).length;
}

it('crash before send, after PDS commit before local ack, after local commit, and during delete (database reopened) each end with exactly one PDS outcome', async () => {
  await withHarness(
    async (h) => {
      // 1. Crash before send: the attempt is persisted, the request never left.
      const a = await enqueueOne(h, 0);
      let crashed = h.writers.crashOn(CREATE, 'before_send');
      void h.run();
      await crashed;
      expect(h.op(a.id)).toMatchObject({ state: 'running', attempts: 1, rkey: a.rkey });
      expect(h.kit.pds.Alice.count(CREATE)).toBe(0);
      h.restart();
      await h.runUntilIdle();
      const remoteA = await remoteRecord(h.kit, 'Alice', SCROBBLE, a.rkey!);
      // Resumed with the same rkey and record: one create on the PDS.
      expect(h.op(a.id)).toMatchObject({ state: 'succeeded', attempts: 2, rkey: a.rkey, result_cid: remoteA!.cid });
      expect(await canonicalDigest(remoteA!.value)).toBe(a.digest);
      expect(committed(h, CREATE)).toBe(1);

      // 2. Crash after the PDS committed, before the local ack: reconciled by digest.
      const b = await enqueueOne(h, 1);
      crashed = h.writers.crashOn(CREATE, 'after_commit');
      void h.run();
      await crashed;
      expect(h.op(b.id)).toMatchObject({ state: 'running', attempts: 1 });
      const remoteB = await remoteRecord(h.kit, 'Alice', SCROBBLE, b.rkey!);
      expect(remoteB).not.toBeNull();
      h.restart();
      const before = h.writers.sent.length;
      await h.runUntilIdle();
      expect(h.writers.sent.slice(before).map((s) => [s.nsid, s.status])).toEqual([
        [CREATE, 400],
        [GET, 200],
      ]);
      expect(h.op(b.id)).toMatchObject({ state: 'succeeded', attempts: 2, result_cid: remoteB!.cid });
      expect(committed(h, CREATE)).toBe(2);
      expect((await remoteRecords(h.kit, 'Alice', SCROBBLE)).map((r) => r.rkey).sort()).toEqual(
        [a.rkey, b.rkey].sort(),
      );

      // 3. Crash after the local commit: a restarted runner has nothing left to send.
      h.restart();
      const settled = h.writers.sent.length;
      expect(await h.run()).toMatchObject({ attempted: 0, nextDueMs: null });
      expect(h.writers.sent.length).toBe(settled);
      expect(h.ops().map((o) => o.state)).toEqual(['succeeded', 'succeeded']);

      // 4. Crash during a delete: swapRecord was persisted before the send; the
      //    restarted runner resends it and verifies absence.
      const del = enqueueScrobbleDelete(h.m, {
        did: h.alice,
        uri: `at://${h.alice}/${SCROBBLE}/${a.rkey}`,
        origin: 'web',
      });
      crashed = h.writers.crashOn(DELETE, 'after_commit');
      void h.run();
      await crashed;
      expect(h.op(del.id)).toMatchObject({ state: 'running', attempts: 1, swap_cid: remoteA!.cid });
      expect(await remoteRecord(h.kit, 'Alice', SCROBBLE, a.rkey!)).toBeNull();
      h.restart();
      const beforeDelete = h.writers.sent.length;
      await h.runUntilIdle();
      const resent = h.writers.sent.slice(beforeDelete);
      expect(resent.map((s) => [s.nsid, s.status])).toEqual([
        [DELETE, 400],
        [GET, 400],
      ]);
      expect(resent[0]!.body).toMatchObject({ rkey: a.rkey, swapRecord: remoteA!.cid });
      expect(h.op(del.id)).toMatchObject({ state: 'succeeded', attempts: 2 });
      expect(committed(h, DELETE)).toBe(1);
      expect((await remoteRecords(h.kit, 'Alice', SCROBBLE)).map((r) => r.rkey)).toEqual([b.rkey]);
      // Never a putRecord.
      expect(h.writers.count(PUT)).toBe(0);
    },
    { random: zeroJitter() },
  );
});

it('an ambiguous create whose existing record has the same digest succeeds; a different digest is terminal remote_record_conflict and the record is never overwritten', async () => {
  await withHarness(async (h) => {
    // The same record is already at the rkey (a lost answer, another process): success, no overwrite.
    const same = await enqueueOne(h, 0);
    const existing = await h.kit.externalPut('Alice', SCROBBLE, same.rkey!, JSON.parse(same.record_json!));
    await h.runUntilIdle();
    expect(h.writers.sent.map((s) => [s.nsid, s.status])).toEqual([
      [CREATE, 400],
      [GET, 200],
    ]);
    expect(h.op(same.id)).toMatchObject({
      state: 'succeeded',
      attempts: 1,
      result_cid: existing.ops[0]!.cid,
      result_uri: `at://${h.alice}/${SCROBBLE}/${same.rkey}`,
    });

    // A different record at the rkey: terminal, and the remote record is kept as it was.
    const other = await enqueueOne(h, 1);
    const theirs = { ...(JSON.parse(other.record_json!) as Record<string, unknown>), track: 'Someone else' };
    const commit = await h.kit.externalPut('Alice', SCROBBLE, other.rkey!, theirs);
    const sentBefore = h.writers.sent.length;
    await h.runUntilIdle();
    h.kit.clock.advance(3_600_000);
    expect(await h.run()).toMatchObject({ attempted: 0, nextDueMs: null });
    expect(h.writers.sent.slice(sentBefore).map((s) => [s.nsid, s.status])).toEqual([
      [CREATE, 400],
      [GET, 200],
    ]);
    expect(h.op(other.id)).toMatchObject({ state: 'failed', last_error: 'remote_record_conflict', attempts: 1 });
    const remote = await remoteRecord(h.kit, 'Alice', SCROBBLE, other.rkey!);
    expect(remote).toMatchObject({ cid: commit.ops[0]!.cid, value: theirs });
    expect([h.writers.count(PUT), h.writers.count(DELETE)]).toEqual([0, 0]);
    // No hint for a record that is not ours.
    expect(h.db.all('SELECT rkey FROM hints ORDER BY rkey')).toEqual([]);
  });
});

it('crash before send: operation resumes with same rkey', async () => {
  await withHarness(async (h) => {
    const op = await enqueueOne(h, 0);
    const crashed = h.writers.crashOn(CREATE, 'before_send');
    void h.run();
    await crashed;
    h.restart();
    expect(h.op(op.id)).toMatchObject({ state: 'running', attempts: 1, rkey: op.rkey, digest: op.digest });
    await h.runUntilIdle();
    expect(h.writers.sent.filter((s) => s.nsid === CREATE).map((s) => s.body?.rkey)).toEqual([op.rkey, op.rkey]);
    expect(h.op(op.id)).toMatchObject({ state: 'succeeded', rkey: op.rkey });
    expect((await remoteRecords(h.kit, 'Alice', SCROBBLE)).map((r) => r.rkey)).toEqual([op.rkey]);
  });
});

it('crash after follow createRecord before local ack reconciles to one record at the deterministic rkey', async () => {
  await withHarness(async (h) => {
    const r = await enqueueFollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' });
    if (!r.ok) throw new Error(JSON.stringify(r.reason));
    const crashed = h.writers.crashOn(CREATE, 'after_commit');
    void h.run();
    await crashed;
    h.restart();
    await h.runUntilIdle();
    const records = await remoteRecords(h.kit, 'Alice', FOLLOW);
    expect(records.map((x) => x.rkey)).toEqual([r.operation.rkey]);
    expect(h.op(r.operation.id)).toMatchObject({ state: 'succeeded', result_cid: records[0]!.cid });
  });
});
