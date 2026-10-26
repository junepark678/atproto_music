// Disconnect / reconnect through the signed settings record (ADR 0004 §5.3,
// §9 A10; API.md disconnect; case map M7.2.3/disconnect_text).

import { expect, it } from 'vitest';
import { enqueueDisconnect, enqueueReconnect } from '../../src/outbox/settings-ops';
import { ALICE, outboxFixture, PREFIX, remoteRecord, runUntilIdle, SETTINGS } from '../support/fake-pds-browser';

const PUT = 'com.atproto.repo.putRecord';
const SELF_URI = `at://${ALICE}/${SETTINGS}/self`;

it('disconnect writes settings/self disabled and notifies', async () => {
  const fx = await outboxFixture();
  fx.appView.pendingPolls = 2; // the AppView needs a few polls to verify the proof
  const r = await enqueueDisconnect({
    store: fx.store,
    did: ALICE,
    prefix: PREFIX,
    clock: fx.clock,
    random: fx.random,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.reason));
  const op = r.op;
  expect(op).toMatchObject({
    kind: 'settings_put',
    collection: SETTINGS,
    rkey: 'self',
    uri: SELF_URI,
    state: 'queued',
  });
  expect(op.record).toEqual({ $type: SETTINGS, indexing: 'disabled', createdAt: expect.any(String) });
  expect(Date.parse(op.record!.createdAt as string)).toBe(fx.clock.nowMs());

  const jumps = await runUntilIdle(fx.runner(), fx.clock);

  // putRecord at the literal key, exactly the persisted record.
  expect(fx.session.sentTo(PUT).map((s) => s.body)).toEqual([
    { repo: ALICE, collection: SETTINGS, rkey: 'self', record: op.record },
  ]);
  expect(fx.pds.calls.filter({ nsid: PUT }).map((c) => c.status)).toEqual([200]);
  const remote = await remoteRecord(fx, SETTINGS, 'self');
  expect(remote?.value).toEqual(op.record);
  // notify {uri}, then records/status until the DID shows as suppressed.
  expect(fx.appView.notified).toEqual([{ uri: SELF_URI }]);
  expect(fx.appView.statusPolls).toEqual([SELF_URI, SELF_URI, SELF_URI]);
  expect(jumps).toEqual([1_000, 2_000, 4_000]);
  expect((await fx.appView.truth(SELF_URI)).indexing.state).toBe('suppressed');
  expect(await fx.store.get(op.id)).toMatchObject({ state: 'indexed', attempts: 1, cid: remote!.cid, dueAt: null });
});

it('reconnect after disconnect runs FIFO and the last choice wins on the PDS', async () => {
  const fx = await outboxFixture();
  const args = { store: fx.store, did: ALICE, prefix: PREFIX, clock: fx.clock, random: fx.random };
  const off = await enqueueDisconnect(args);
  fx.clock.advance(1_000);
  const on = await enqueueReconnect(args);
  if (!off.ok || !on.ok) throw new Error('enqueue failed');
  expect(on.op.predecessorIds).toEqual([off.op.id]);

  await runUntilIdle(fx.runner(), fx.clock);

  expect(fx.session.sentTo(PUT).map((s) => (s.body!.record as { indexing: string }).indexing)).toEqual([
    'disabled',
    'enabled',
  ]);
  expect((await remoteRecord(fx, SETTINGS, 'self'))?.value).toEqual(on.op.record);
  expect((await fx.appView.truth(SELF_URI)).indexing.state).toBe('current');
  expect(await fx.store.get(on.op.id)).toMatchObject({ state: 'indexed', attempts: 1 });
  expect(await fx.store.get(off.op.id)).toMatchObject({ state: 'published', dueAt: null });
});
