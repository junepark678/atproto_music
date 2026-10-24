// Follow and unfollow through the SPA outbox (ADR 0004 §5.2 step 6; API.md
// deletion clarification; case map M5.3.1, M7.3.3).

import { followRkey } from '@atmusic/core/record-key';
import { expect, it } from 'vitest';
import { enqueueFollow, enqueueUnfollow } from '../../src/outbox/follow-ops';
import { followIntent } from '../../src/outbox/overlay';
import {
  ALICE,
  BOB,
  CAROL,
  FOLLOW,
  type OutboxFixture,
  outboxFixture,
  PREFIX,
  runUntilIdle,
} from '../support/fake-pds-browser';

const CREATE = 'com.atproto.repo.createRecord';
const DELETE = 'com.atproto.repo.deleteRecord';
const LIST = 'com.atproto.repo.listRecords';

async function intent(fx: OutboxFixture, follow: boolean, subject: string) {
  const args = { store: fx.store, did: ALICE, prefix: PREFIX, subject, clock: fx.clock, random: fx.random };
  const r = follow ? await enqueueFollow(args) : await enqueueUnfollow(args);
  if (!r.ok) throw new Error(JSON.stringify(r.reason));
  return r.op;
}

function followValue(subject: string, createdAt: string) {
  return { $type: FOLLOW, subject, createdAt };
}

it('PUT, DELETE, PUT for one subject execute in order with separate ids', async () => {
  const fx = await outboxFixture();
  const put1 = await intent(fx, true, BOB);
  fx.clock.advance(1_000);
  const del = await intent(fx, false, BOB);
  fx.clock.advance(1_000);
  const put2 = await intent(fx, true, BOB);

  expect(new Set([put1.id, del.id, put2.id]).size).toBe(3);
  expect(del.predecessorIds).toEqual([put1.id]);
  expect(put2.predecessorIds).toEqual([put1.id, del.id]);
  const rkey = await followRkey(BOB);
  expect([put1.rkey, del.rkey, put2.rkey]).toEqual([rkey, rkey, rkey]);
  expect(followIntent(await fx.ops(), ALICE, BOB)).toMatchObject({
    intent: 'follow',
    local: { opId: put2.id, state: 'queued' },
  });

  await runUntilIdle(fx.runner(), fx.clock);

  // FIFO on the PDS: create, list + delete (with swap), create again.
  const writes = fx.session.sent.filter((r) => r.nsid === CREATE || r.nsid === DELETE || r.nsid === LIST);
  expect(writes.map((r) => r.nsid)).toEqual([CREATE, LIST, DELETE, CREATE]);
  expect(writes[0]!.body?.record).toEqual(put1.record);
  const firstCid = (await fx.store.get(put1.id))!.cid;
  expect(writes[2]!.body).toMatchObject({ rkey, swapRecord: firstCid });
  expect(writes[3]!.body?.record).toEqual(put2.record);

  // The last intent wins: one record, the second follow's createdAt.
  const listed = await fx.repo.list(FOLLOW);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ rkey, value: put2.record });
  const [r1, r2, r3] = [await fx.store.get(put1.id), await fx.store.get(del.id), await fx.store.get(put2.id)];
  expect(r1).toMatchObject({ state: 'published', attempts: 1, dueAt: null });
  expect(r2).toMatchObject({
    state: 'published',
    attempts: 1,
    dueAt: null,
    targets: [{ uri: put1.uri, rkey, cid: firstCid }],
  });
  expect(r3).toMatchObject({ state: 'indexed', attempts: 1, dueAt: null, cid: listed[0]!.cid });
  expect(r1!.updatedAt).toBeLessThanOrEqual(r2!.updatedAt);
  expect(followIntent(await fx.ops(), ALICE, BOB)).toMatchObject({
    intent: 'follow',
    local: { opId: put2.id, state: 'indexed' },
  });
});

it('unfollow deletes all duplicate matching records and keeps unrelated subject', async () => {
  const fx = await outboxFixture();
  const at = '2026-01-14T10:00:00.000Z';
  const bobRkey = await followRkey(BOB);
  const carolRkey = await followRkey(CAROL);
  // The deterministic record, a duplicate written by another client at a TID, and Carol.
  const main = (await fx.repo.put(FOLLOW, bobRkey, followValue(BOB, at))).ops[0]!.cid;
  const dup = (await fx.repo.put(FOLLOW, '3lzzzzzzzzz22', followValue(BOB, '2026-01-14T11:00:00.000Z'))).ops[0]!.cid;
  const carol = (await fx.repo.put(FOLLOW, carolRkey, followValue(CAROL, at))).ops[0]!.cid;

  const op = await intent(fx, false, BOB);
  await runUntilIdle(fx.runner(), fx.clock);

  expect(fx.pds.count(LIST)).toBe(1);
  const deletes = fx.session.sentTo(DELETE).map((r) => r.body);
  expect(deletes).toHaveLength(2);
  expect(deletes).toEqual(
    expect.arrayContaining([
      { repo: ALICE, collection: FOLLOW, rkey: bobRkey, swapRecord: main },
      { repo: ALICE, collection: FOLLOW, rkey: '3lzzzzzzzzz22', swapRecord: dup },
    ]),
  );
  const remaining = await fx.repo.list(FOLLOW);
  expect(remaining.map((r) => [r.rkey, r.cid])).toEqual([[carolRkey, carol]]);
  const row = (await fx.store.get(op.id))!;
  expect(row).toMatchObject({ state: 'indexed', attempts: 1, dueAt: null });
  expect(row.targets?.map((t) => t.rkey).sort()).toEqual(['3lzzzzzzzzz22', bobRkey].sort());
  expect(fx.appView.notifiedUris().sort()).toEqual(
    [`at://${ALICE}/${FOLLOW}/${bobRkey}`, `at://${ALICE}/${FOLLOW}/3lzzzzzzzzz22`].sort(),
  );
});

it('unfollow with no matching record succeeds with zero deleteRecord calls', async () => {
  const fx = await outboxFixture();
  const carolRkey = await followRkey(CAROL);
  const carol = (await fx.repo.put(FOLLOW, carolRkey, followValue(CAROL, '2026-01-14T10:00:00.000Z'))).ops[0]!.cid;

  const op = await intent(fx, false, BOB);
  await runUntilIdle(fx.runner(), fx.clock);

  expect(fx.pds.count(LIST)).toBe(1);
  expect(fx.pds.count(DELETE)).toBe(0);
  expect(fx.session.sentTo(DELETE)).toEqual([]);
  expect(await fx.store.get(op.id)).toMatchObject({ state: 'indexed', attempts: 1, dueAt: null, targets: [] });
  expect((await fx.repo.list(FOLLOW)).map((r) => [r.rkey, r.cid])).toEqual([[carolRkey, carol]]);
  expect(fx.appView.notified).toEqual([]);
});
