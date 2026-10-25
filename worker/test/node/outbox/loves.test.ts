// Loves through the server outbox (ADR 0005 §5.8, §6.3, §7.8; N2-05): one
// love per (artist_key, track_key), and unlove mirrors unfollow.

import { expect, it } from 'vitest';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { CREATE, DELETE, LIST, LOVE, remoteRecords, withHarness } from './support';

function love(artist: string, track: string) {
  return { $type: LOVE, artist, track, createdAt: '2026-01-15T11:00:00Z' };
}

it('a second love for the same (artist_key, track_key) succeeds without a new record; unlove deletes every matching listed love', async () => {
  await withHarness(async (h) => {
    const first = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Björk', track: 'Hyperballad' },
      origin: 'lastfm',
    });
    if (!first.ok) throw new Error(JSON.stringify(first.reason));
    await h.runUntilIdle();
    expect(h.writers.order()).toEqual([LIST, CREATE]);
    const created = h.op(first.operation.id);
    expect(created).toMatchObject({ state: 'succeeded', result_uri: `at://${h.alice}/${LOVE}/${created.rkey}` });
    expect((await remoteRecords(h.kit, 'Alice', LOVE)).map((r) => r.rkey)).toEqual([created.rkey]);

    // The same key with other case and spacing: success with the existing record, nothing written.
    const second = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: '  BJÖRK', track: 'hyperballad ' },
      origin: 'lastfm',
    });
    if (!second.ok) throw new Error(JSON.stringify(second.reason));
    await h.runUntilIdle();
    expect(h.writers.order()).toEqual([LIST, CREATE, LIST]);
    expect(h.op(second.operation.id)).toMatchObject({
      state: 'succeeded',
      attempts: 1,
      result_uri: created.result_uri,
      result_cid: created.result_cid,
    });
    expect(await remoteRecords(h.kit, 'Alice', LOVE)).toHaveLength(1);

    // Another app wrote a duplicate love of the same track, and a love of another track.
    await h.kit.externalPut('Alice', LOVE, '3kotherapp222', love('björk', 'HYPERBALLAD'));
    await h.kit.externalPut('Alice', LOVE, '3kunrelated22', love('Portishead', 'Roads'));
    const unlove = await enqueueUnlove(h.m, { did: h.alice, artist: 'Björk', track: 'Hyperballad', origin: 'lastfm' });
    if (!unlove.ok) throw new Error(JSON.stringify(unlove.reason));
    expect(unlove.operation).toMatchObject({ kind: 'love.delete', rkey: null });
    const mark = h.writers.sent.length;
    await h.runUntilIdle();
    const sent = h.writers.sent.slice(mark);
    expect(sent.map((s) => s.nsid)).toEqual([LIST, DELETE, DELETE]);
    expect(
      sent
        .filter((s) => s.nsid === DELETE)
        .map((s) => s.body?.rkey)
        .sort(),
    ).toEqual(['3kotherapp222', created.rkey].sort());
    expect(sent.filter((s) => s.nsid === DELETE).every((s) => typeof s.body?.swapRecord === 'string')).toBe(true);
    expect(h.op(unlove.operation.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
    expect((await remoteRecords(h.kit, 'Alice', LOVE)).map((r) => r.rkey)).toEqual(['3kunrelated22']);
  });
});
