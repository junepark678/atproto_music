// Follow and unfollow through the server outbox (ADR 0005 §5.8, ADR 0004
// §5.2 step 6; N2-05; ports web/test/outbox/follows.test.ts, cases M5.3.1
// and M7.3.3).

import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { enqueueFollow, enqueueUnfollow } from '../../../src/outbox/follow-ops';
import { predecessorRows } from '../../../src/outbox/operations';
import { CREATE, DELETE, FOLLOW, LIST, remoteRecords, withHarness } from './support';

const CAROL = 'did:plc:carolcarolcarolcarolcaro';

function follow(subject: string) {
  return { $type: FOLLOW, subject, createdAt: '2025-01-01T00:00:00Z' };
}

it('follow rkey is f+hex(sha256(subject)); unfollow deletes every matching listed record and keeps unrelated ones; PUT, DELETE, PUT run in order', async () => {
  await withHarness(async (h) => {
    const rkey = `f${createHash('sha256').update(h.bob, 'utf8').digest('hex')}`;

    // Follow: createRecord at the deterministic rkey.
    const put = await enqueueFollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' });
    if (!put.ok) throw new Error(JSON.stringify(put.reason));
    expect(put.operation).toMatchObject({ kind: 'follow.put', rkey, collection: FOLLOW, state: 'queued' });
    await h.runUntilIdle();
    expect(h.writers.sent.map((s) => [s.nsid, s.body?.rkey])).toEqual([[CREATE, rkey]]);
    expect(
      (await remoteRecords(h.kit, 'Alice', FOLLOW)).map((r) => [r.rkey, (r.value as { subject: string }).subject]),
    ).toEqual([[rkey, h.bob]]);

    // Another client wrote a duplicate follow of Bob at another rkey, and a follow of Carol.
    await h.kit.externalPut('Alice', FOLLOW, '3kdupdupdup22', follow(h.bob));
    await h.kit.externalPut('Alice', FOLLOW, '3kcarolcarol2', follow(CAROL));
    const del = await enqueueUnfollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' });
    if (!del.ok) throw new Error(JSON.stringify(del.reason));
    const mark = h.writers.sent.length;
    await h.runUntilIdle();
    const deletes = h.writers.sent.slice(mark).filter((s) => s.nsid === DELETE);
    expect(h.writers.sent.slice(mark).map((s) => s.nsid)).toEqual([LIST, DELETE, DELETE]);
    expect(deletes.map((d) => d.body?.rkey).sort()).toEqual(['3kdupdupdup22', rkey].sort());
    expect(deletes.every((d) => typeof d.body?.swapRecord === 'string')).toBe(true);
    expect(h.op(del.operation.id)).toMatchObject({ kind: 'follow.delete', state: 'succeeded', attempts: 1 });
    expect((await remoteRecords(h.kit, 'Alice', FOLLOW)).map((r) => r.rkey)).toEqual(['3kcarolcarol2']);

    // PUT, DELETE, PUT for one subject: separate ids, FIFO behind their predecessors.
    const ids: string[] = [];
    for (const step of ['put', 'delete', 'put'] as const) {
      const r =
        step === 'put'
          ? await enqueueFollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' })
          : await enqueueUnfollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' });
      if (!r.ok) throw new Error(JSON.stringify(r.reason));
      ids.push(r.operation.id);
    }
    expect(new Set(ids).size).toBe(3);
    expect(predecessorRows(h.db, ids[1]!).map((p) => p.id)).toEqual([ids[0]]);
    expect(predecessorRows(h.db, ids[2]!).map((p) => p.id)).toEqual([ids[0], ids[1]]);
    const mark2 = h.writers.sent.length;
    const reports = await h.runUntilIdle();
    // One intent per run: each waits for the one before it.
    expect(reports.filter((r) => r.attempted > 0).map((r) => r.attempted)).toEqual([1, 1, 1]);
    expect(h.writers.sent.slice(mark2).map((s) => [s.nsid, s.status])).toEqual([
      [CREATE, 200],
      [LIST, 200],
      [DELETE, 200],
      [CREATE, 200],
    ]);
    expect(ids.map((id) => h.op(id).state)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    const final = await remoteRecords(h.kit, 'Alice', FOLLOW);
    expect(final.map((r) => r.rkey).sort()).toEqual(['3kcarolcarol2', rkey].sort());
  });
});

it('unfollow with no matching record succeeds with zero deleteRecord calls', async () => {
  await withHarness(async (h) => {
    await h.kit.externalPut('Alice', FOLLOW, '3kcarolcarol2', follow(CAROL));
    const del = await enqueueUnfollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' });
    if (!del.ok) throw new Error(JSON.stringify(del.reason));
    await h.runUntilIdle();
    expect(h.writers.order()).toEqual([LIST]);
    expect(h.op(del.operation.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
    expect((await remoteRecords(h.kit, 'Alice', FOLLOW)).map((r) => r.rkey)).toEqual(['3kcarolcarol2']);
  });
});

it('an unfollow cut short after some deletes queues the hint of every record it deleted, across attempts', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const rkey = `f${createHash('sha256').update(h.bob, 'utf8').digest('hex')}`;
    const put = await enqueueFollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' });
    if (!put.ok) throw new Error(JSON.stringify(put.reason));
    await h.runUntilIdle();
    // Two more follows of Bob by another client; the listing is newest rkey first: zz…, f…, 3k….
    await h.kit.externalPut('Alice', FOLLOW, '3kdupdupdup22', follow(h.bob));
    await h.kit.externalPut('Alice', FOLLOW, 'zzdupdupdup22', follow(h.bob));
    h.db.run('DELETE FROM hints');

    const del = await enqueueUnfollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' });
    if (!del.ok) throw new Error(JSON.stringify(del.reason));
    const mark = h.writers.sent.length;
    // Attempt 1: zz… is deleted (200), then the PDS answers 500 to the next delete.
    const paused = h.writers.pauseOn(DELETE);
    const first = h.run();
    await paused.reached;
    h.kit.pds.Alice.serverError(DELETE, 500, 1);
    paused.release();
    await first;
    expect(h.writers.sent.slice(mark).map((s) => [s.nsid, s.body?.rkey ?? null, s.status])).toEqual([
      [LIST, null, 200],
      [DELETE, 'zzdupdupdup22', 200],
      [DELETE, rkey, 500],
    ]);
    expect(h.op(del.operation.id)).toMatchObject({ state: 'queued', attempts: 1 });
    // The deleted record is hinted already, though the operation has not succeeded.
    expect(h.db.all('SELECT uri, source FROM hints ORDER BY uri')).toEqual([
      { uri: `at://${h.alice}/${FOLLOW}/zzdupdupdup22`, source: 'notify' },
    ]);

    // Attempt 2 lists again (zz… is gone) and deletes the other two.
    h.kit.clock.advance(2_000);
    await h.runUntilIdle();
    expect(h.writers.sent.slice(mark + 3).map((s) => [s.nsid, s.body?.rkey ?? null, s.status])).toEqual([
      [LIST, null, 200],
      [DELETE, rkey, 200],
      [DELETE, '3kdupdupdup22', 200],
    ]);
    expect(h.op(del.operation.id)).toMatchObject({ state: 'succeeded', attempts: 2 });
    expect(await remoteRecords(h.kit, 'Alice', FOLLOW)).toEqual([]);
    expect(h.db.all<{ uri: string }>('SELECT uri FROM hints ORDER BY uri').map((r) => r.uri)).toEqual(
      [
        `at://${h.alice}/${FOLLOW}/3kdupdupdup22`,
        `at://${h.alice}/${FOLLOW}/${rkey}`,
        `at://${h.alice}/${FOLLOW}/zzdupdupdup22`,
      ].sort(),
    );
    expect(h.db.all('SELECT DISTINCT source FROM hints')).toEqual([{ source: 'notify' }]);
  });
});
