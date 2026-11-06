// The signed opt-out record through the server outbox (ADR 0005 §5.7, §5.8;
// ADR 0004 §5.3, A10; N2-05; ports web/test/outbox/settings.test.ts, case
// M7.2.3/disconnect_text).

import { expect, it } from 'vitest';
import { drain } from '../../../src/do/ingest/verify-drain';
import { enqueueSettings } from '../../../src/outbox/settings-ops';
import { PUT, remoteRecord, SETTINGS, withHarness } from './support';

it('disable writes settings/self {indexing:disabled} then notifies; enable writes indexing:enabled at a newer revision', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const uri = `at://${h.alice}/${SETTINGS}/self`;

    const off = await enqueueSettings(h.m, { did: h.alice, indexing: 'disabled', origin: 'web' });
    if (!off.ok) throw new Error(JSON.stringify(off.reason));
    await h.runUntilIdle();
    expect(
      h.writers.sent.map((s) => [s.nsid, s.body?.rkey, (s.body?.record as { indexing?: string })?.indexing]),
    ).toEqual([[PUT, 'self', 'disabled']]);
    const disabled = await remoteRecord(h.kit, 'Alice', SETTINGS, 'self');
    expect(disabled?.value).toMatchObject({ $type: SETTINGS, indexing: 'disabled' });
    expect(h.op(off.operation.id)).toMatchObject({ state: 'succeeded', result_uri: uri, result_cid: disabled!.cid });
    const rev1 = h.kit.repos.Alice.head!.rev;
    // Then notifies: the record's hint is queued (source notify), and the drain applies the opt-out from its proof.
    expect(h.db.all('SELECT uri, source FROM hints')).toEqual([{ uri, source: 'notify' }]);
    const report = await drain(h.m, h.kit.clock.nowMs());
    expect(report.outcomes).toEqual([{ uri, outcome: 'applied' }]);
    expect(h.db.one('SELECT did FROM suppression WHERE did = ?', h.alice)).toEqual({ did: h.alice });

    h.kit.clock.advance(60_000);
    const on = await enqueueSettings(h.m, { did: h.alice, indexing: 'enabled', origin: 'web' });
    if (!on.ok) throw new Error(JSON.stringify(on.reason));
    await h.runUntilIdle();
    const enabled = await remoteRecord(h.kit, 'Alice', SETTINGS, 'self');
    expect(enabled?.value).toMatchObject({ $type: SETTINGS, indexing: 'enabled' });
    const rev2 = h.kit.repos.Alice.head!.rev;
    expect(rev2 > rev1).toBe(true);
    expect(h.op(on.operation.id)).toMatchObject({ state: 'succeeded', result_cid: enabled!.cid });
    expect(h.writers.count(PUT)).toBe(2);
    expect(h.db.all('SELECT uri, source FROM hints')).toEqual([{ uri, source: 'notify' }]);
    const lifted = await drain(h.m, h.kit.clock.nowMs());
    expect(lifted.outcomes).toEqual([{ uri, outcome: 'applied' }]);
    expect(h.db.one('SELECT did FROM suppression WHERE did = ?', h.alice)).toBeNull();
  });
});

it('reconnect after disconnect runs FIFO and the last choice wins on the PDS', async () => {
  await withHarness(async (h) => {
    const off = await enqueueSettings(h.m, { did: h.alice, indexing: 'disabled', origin: 'web' });
    const on = await enqueueSettings(h.m, { did: h.alice, indexing: 'enabled', origin: 'web' });
    if (!off.ok || !on.ok) throw new Error('enqueue failed');
    await h.runUntilIdle();
    expect(h.writers.sent.map((s) => (s.body?.record as { indexing?: string })?.indexing)).toEqual([
      'disabled',
      'enabled',
    ]);
    expect((await remoteRecord(h.kit, 'Alice', SETTINGS, 'self'))?.value).toMatchObject({ indexing: 'enabled' });
  });
});
