// Loves through the server outbox (ADR 0005 §5.8, §6.3, §7.8; N2-05): one
// love per (artist_key, track_key), and unlove mirrors unfollow.

import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { fromMs } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { CREATE, DELETE, GET, type Harness, LIST, LOVE, remoteRecords, withHarness } from './support';

function love(artist: string, track: string) {
  return { $type: LOVE, artist, track, createdAt: '2026-01-15T11:00:00Z' };
}

/** Applies a fake-PDS commit through the production record-proof verifier and projector. */
async function projectLove(h: Harness, rkey: string) {
  const car = await h.kit.repos.Alice.getRecordCar(LOVE, rkey);
  const proof = await verifyRecordProof(car, {
    did: h.alice,
    collection: LOVE,
    rkey,
    signingKey: h.kit.users.Alice.key.didKey,
  });
  const nowNs = fromMs(h.kit.clock.nowMs());
  return h.db.tx(() => applyRecordProof(h.db, proof, { prefix: 'com.example.atmusic', nowNs, receiptNs: nowNs }));
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
    // One createRecord; the collection is never listed for a love.
    expect(h.writers.order()).toEqual([CREATE]);
    const created = h.op(first.operation.id);
    expect(created).toMatchObject({ state: 'succeeded', result_uri: `at://${h.alice}/${LOVE}/${created.rkey}` });
    expect((await remoteRecords(h.kit, 'Alice', LOVE)).map((r) => r.rkey)).toEqual([created.rkey]);

    // The same key with other case and spacing: success with the existing record, nothing sent at all.
    const second = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: '  BJÖRK', track: 'hyperballad ' },
      origin: 'lastfm',
    });
    if (!second.ok) throw new Error(JSON.stringify(second.reason));
    await h.runUntilIdle();
    expect(h.writers.order()).toEqual([CREATE]);
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
    expect(
      h.db.all('SELECT state,expected_cid FROM love_delete_bridges WHERE operation_id=?', unlove.operation.id),
    ).toHaveLength(2);
    expect(h.op(unlove.operation.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
    expect((await remoteRecords(h.kit, 'Alice', LOVE)).map((r) => r.rkey)).toEqual(['3kunrelated22']);
  });
});

it('a love whose create committed before its answer was lost is reconciled at its own rkey by digest, without a listing, and queues its notify hint; an unknown DID is admitted instead', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const r = await enqueueLove(h.m, { did: h.alice, input: { artist: 'A', track: 'B' }, origin: 'web' });
    if (!r.ok) throw new Error(JSON.stringify(r.reason));
    const crashed = h.writers.crashOn(CREATE, 'after_commit');
    void h.run();
    await crashed;
    h.restart();
    await h.runUntilIdle();
    // The second attempt's createRecord finds the record there; getRecord compares digests.
    expect(h.writers.order()).toEqual([CREATE, CREATE, GET]);
    const uri = `at://${h.alice}/${LOVE}/${r.operation.rkey}`;
    const remote = await remoteRecords(h.kit, 'Alice', LOVE);
    expect(remote.map((x) => x.rkey)).toEqual([r.operation.rkey]);
    expect(h.op(r.operation.id)).toMatchObject({
      state: 'succeeded',
      attempts: 2,
      result_uri: uri,
      result_cid: remote[0]!.cid,
    });
    expect(h.db.all('SELECT uri, source FROM hints')).toEqual([{ uri, source: 'notify' }]);
  });

  await withHarness(async (h) => {
    expect(h.db.all('SELECT did FROM users')).toEqual([]);
    const r = await enqueueLove(h.m, { did: h.bob, input: { artist: 'A', track: 'B' }, origin: 'web' });
    if (!r.ok) throw new Error(JSON.stringify(r.reason));
    const crashed = h.writers.crashOn(CREATE, 'after_commit');
    void h.run();
    await crashed;
    h.restart();
    await h.runUntilIdle();
    expect(h.op(r.operation.id)).toMatchObject({ state: 'succeeded', attempts: 2 });
    // The DID is not indexed yet: admitted, so its snapshot indexes the love.
    expect(h.db.all('SELECT did, active FROM users')).toEqual([{ did: h.bob, active: 0 }]);
    expect(h.db.all('SELECT did, kind, state FROM repo_jobs')).toEqual([
      { did: h.bob, kind: 'snapshot', state: 'pending' },
    ]);
    expect(h.db.all('SELECT uri FROM hints')).toEqual([]);
  });
});

it('love.put decides from local state, never listing: an indexed love from another app is reused with no request; love, unlove, love writes a new record; a love the index saw deleted elsewhere is written again', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    // Another app's love, already projected by the index.
    await h.kit.externalPut('Alice', LOVE, '3kotherapp222', love('Portishead', 'Roads'));
    const otherUri = `at://${h.alice}/${LOVE}/3kotherapp222`;
    const otherCid = (await remoteRecords(h.kit, 'Alice', LOVE))[0]!.cid;
    h.db.run(
      `INSERT INTO loves(uri, did, rkey, cid, artist, track, artist_key, track_key, created_at, indexed_at)
       VALUES (?, ?, '3kotherapp222', ?, 'Portishead', 'Roads', 'portishead', 'roads', ?, ?)`,
      otherUri,
      h.alice,
      otherCid,
      '2026-01-15T11:00:00.000000000Z',
      '2026-01-15T11:00:00.000000000Z',
    );
    const reused = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'PORTISHEAD', track: 'roads' },
      origin: 'web',
    });
    if (!reused.ok) throw new Error(JSON.stringify(reused.reason));
    await h.runUntilIdle();
    expect(h.writers.sent).toEqual([]);
    expect(h.op(reused.operation.id)).toMatchObject({
      state: 'succeeded',
      attempts: 1,
      result_uri: otherUri,
      result_cid: otherCid,
    });
    expect(h.db.all('SELECT uri, source FROM hints')).toEqual([{ uri: otherUri, source: 'notify' }]);

    // love, unlove, love of one key, each settled before the next is enqueued (the index has not run):
    // the third must not be taken for the first, which the unlove deleted.
    const ids: string[] = [];
    const rkeys: string[] = [];
    for (const step of ['love', 'unlove', 'love'] as const) {
      const r =
        step === 'love'
          ? await enqueueLove(h.m, { did: h.alice, input: { artist: 'Björk', track: 'Hyperballad' }, origin: 'web' })
          : await enqueueUnlove(h.m, { did: h.alice, artist: 'Björk', track: 'Hyperballad', origin: 'web' });
      if (!r.ok) throw new Error(JSON.stringify(r.reason));
      ids.push(r.operation.id);
      if (r.operation.rkey !== null) rkeys.push(r.operation.rkey);
      await h.runUntilIdle();
    }
    expect(h.writers.order()).toEqual([CREATE, LIST, DELETE, CREATE]);
    expect(ids.map((id) => h.op(id).state)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(h.op(ids[2]!).result_uri).toBe(`at://${h.alice}/${LOVE}/${rkeys[1]}`);
    expect((await remoteRecords(h.kit, 'Alice', LOVE)).map((r) => r.rkey).sort()).toEqual(
      ['3kotherapp222', rkeys[1]!].sort(),
    );

    // Another app deleted our love and the index recorded it absent: the next love is written again.
    const ours = h.op(ids[2]!);
    await h.kit.externalDelete('Alice', LOVE, ours.rkey!);
    h.db.run(
      `INSERT INTO record_state(uri, did, collection, revision, cid, state, verified_at)
       VALUES (?, ?, ?, '3kzzzzzzzzzz2', NULL, 'absent', '2026-01-15T12:00:00.000000000Z')`,
      ours.result_uri,
      h.alice,
      LOVE,
    );
    const again = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Björk', track: 'Hyperballad' },
      origin: 'web',
    });
    if (!again.ok) throw new Error(JSON.stringify(again.reason));
    const mark = h.writers.sent.length;
    await h.runUntilIdle();
    expect(h.writers.sent.slice(mark).map((s) => [s.nsid, s.body?.rkey])).toEqual([[CREATE, again.operation.rkey]]);
    expect(h.op(again.operation.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
    expect((await remoteRecords(h.kit, 'Alice', LOVE)).map((r) => r.rkey).sort()).toEqual(
      ['3kotherapp222', again.operation.rkey!].sort(),
    );
  });
});

it('a verified same-rkey overwrite invalidates an old love success after restart and creates the requested identity at a new persisted rkey', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const rkey = '3kotherapp222';
    const uri = `at://${h.alice}/${LOVE}/${rkey}`;
    await h.kit.externalPut('Alice', LOVE, rkey, love('Artist A', 'Track A'));
    expect((await projectLove(h, rkey)).outcome).toBe('applied');

    const oldSuccess = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Artist A', track: 'Track A' },
      origin: 'web',
    });
    if (!oldSuccess.ok) throw new Error(JSON.stringify(oldSuccess.reason));
    await h.runUntilIdle();
    expect(h.op(oldSuccess.operation.id)).toMatchObject({ state: 'succeeded', result_uri: uri });
    expect(h.writers.sent).toEqual([]);

    // A different valid record at the same URI is verified and replaces the projection.
    await h.kit.externalPut('Alice', LOVE, rkey, love('Artist B', 'Track B'));
    expect((await projectLove(h, rkey)).outcome).toBe('applied');
    expect(h.db.one('SELECT artist, track FROM loves WHERE uri = ?', uri)).toEqual({
      artist: 'Artist B',
      track: 'Track B',
    });

    h.restart();
    const requested = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Artist A', track: 'Track A' },
      origin: 'web',
    });
    if (!requested.ok) throw new Error(JSON.stringify(requested.reason));
    await h.runUntilIdle();

    const createdUri = `at://${h.alice}/${LOVE}/${requested.operation.rkey}`;
    expect(requested.operation.rkey).not.toBe(rkey);
    expect(h.op(requested.operation.id)).toMatchObject({ state: 'succeeded', result_uri: createdUri });
    expect(h.writers.order()).toEqual([CREATE]);
    expect(h.writers.sent[0]?.body).toMatchObject({ rkey: requested.operation.rkey });
    expect(await remoteRecords(h.kit, 'Alice', LOVE)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rkey, value: expect.objectContaining({ artist: 'Artist B', track: 'Track B' }) }),
        expect.objectContaining({
          rkey: requested.operation.rkey,
          value: expect.objectContaining({ artist: 'Artist A', track: 'Track A' }),
        }),
      ]),
    );
  });
});

for (const sequence of ['immediate', 'restart', 'queued'] as const) {
  it(`re-loving an indexed track after unlove creates its persisted key with stale deletion projection (${sequence})`, async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const first = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: 'Artist A', track: 'Track A' },
        origin: 'web',
      });
      if (!first.ok || first.operation.rkey === null) throw new Error('first love was not admitted');
      await h.runUntilIdle();
      expect((await projectLove(h, first.operation.rkey)).outcome).toBe('applied');

      const unlove = await enqueueUnlove(h.m, {
        did: h.alice,
        artist: 'Artist A',
        track: 'Track A',
        origin: 'web',
      });
      if (!unlove.ok) throw new Error('unlove was not admitted');
      if (sequence !== 'queued') {
        await h.runUntilIdle();
        expect(await remoteRecords(h.kit, 'Alice', LOVE)).toHaveLength(0);
        if (sequence === 'restart') h.restart();
      }

      const again = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: 'artist a', track: 'TRACK A' },
        origin: 'web',
      });
      if (!again.ok) throw new Error('re-love was not admitted');
      await h.runUntilIdle();
      const uri = `at://${h.alice}/${LOVE}/${again.operation.rkey}`;
      expect(again.operation.rkey).not.toBe(first.operation.rkey);
      expect(h.op(again.operation.id)).toMatchObject({ state: 'succeeded', result_uri: uri });
      expect(h.writers.order()).toEqual([CREATE, LIST, DELETE, CREATE]);
      expect(h.writers.sent.at(-1)?.body).toMatchObject({ rkey: again.operation.rkey });
      expect(await remoteRecords(h.kit, 'Alice', LOVE)).toEqual([
        expect.objectContaining({ rkey: again.operation.rkey }),
      ]);
    });
  });
}

it('a verified same-key metadata rewrite reuses the current CID without creating another love', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const rkey = '3kotherapp222';
    const uri = `at://${h.alice}/${LOVE}/${rkey}`;
    await h.kit.externalPut('Alice', LOVE, rkey, love('Artist A', 'Track A'));
    await projectLove(h, rkey);
    const oldSuccess = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Artist A', track: 'Track A' },
      origin: 'web',
    });
    if (!oldSuccess.ok) throw new Error(JSON.stringify(oldSuccess.reason));
    await h.runUntilIdle();
    const historicCid = h.op(oldSuccess.operation.id).result_cid;

    await h.kit.externalPut('Alice', LOVE, rkey, {
      ...love('ARTIST A', 'track a'),
      album: 'A verified metadata update',
    });
    await projectLove(h, rkey);
    const currentCid = h.db.one<{ cid: string }>('SELECT cid FROM loves WHERE uri = ?', uri)!.cid;
    expect(currentCid).not.toBe(historicCid);

    h.restart();
    const again = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Artist A', track: 'Track A' },
      origin: 'web',
    });
    if (!again.ok) throw new Error(JSON.stringify(again.reason));
    await h.runUntilIdle();
    expect(h.writers.sent).toEqual([]);
    expect(h.op(again.operation.id)).toMatchObject({ state: 'succeeded', result_uri: uri, result_cid: currentCid });
  });
});

for (const proofState of ['absent', 'excluded'] as const) {
  it(`a verified ${proofState} proof invalidates a historic love success`, async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rkey = '3kotherapp222';
      const uri = `at://${h.alice}/${LOVE}/${rkey}`;
      await h.kit.externalPut('Alice', LOVE, rkey, love('Artist A', 'Track A'));
      await projectLove(h, rkey);
      const oldSuccess = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: 'Artist A', track: 'Track A' },
        origin: 'web',
      });
      if (!oldSuccess.ok) throw new Error(JSON.stringify(oldSuccess.reason));
      await h.runUntilIdle();
      expect(h.op(oldSuccess.operation.id).result_uri).toBe(uri);

      if (proofState === 'absent') {
        await h.kit.externalDelete('Alice', LOVE, rkey);
        expect((await projectLove(h, rkey)).outcome).toBe('absent');
      } else {
        await h.kit.externalPut('Alice', LOVE, rkey, love('', 'Track A'));
        expect((await projectLove(h, rkey)).outcome).toBe('excluded');
      }

      h.restart();
      const requested = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: 'Artist A', track: 'Track A' },
        origin: 'web',
      });
      if (!requested.ok) throw new Error(JSON.stringify(requested.reason));
      await h.runUntilIdle();
      expect(requested.operation.rkey).not.toBe(rkey);
      expect(h.op(requested.operation.id)).toMatchObject({
        state: 'succeeded',
        result_uri: `at://${h.alice}/${LOVE}/${requested.operation.rkey}`,
      });
      expect(h.writers.order()).toEqual([CREATE]);
    });
  });
}

it('a successful but unindexed love remains reusable after restart', async () => {
  await withHarness(async (h) => {
    const first = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'Artist A', track: 'Track A' },
      origin: 'web',
    });
    if (!first.ok) throw new Error(JSON.stringify(first.reason));
    await h.runUntilIdle();
    const firstRow = h.op(first.operation.id);
    expect(firstRow.state).toBe('succeeded');
    expect(h.db.one('SELECT uri FROM record_state WHERE uri = ?', firstRow.result_uri)).toBeNull();
    expect(h.writers.order()).toEqual([CREATE]);

    h.restart();
    const second = await enqueueLove(h.m, {
      did: h.alice,
      input: { artist: 'artist a', track: 'track a' },
      origin: 'web',
    });
    if (!second.ok) throw new Error(JSON.stringify(second.reason));
    await h.runUntilIdle();
    expect(h.op(second.operation.id)).toMatchObject({
      state: 'succeeded',
      attempts: 1,
      result_uri: firstRow.result_uri,
      result_cid: firstRow.result_cid,
    });
    expect(h.writers.order()).toEqual([CREATE]);
    expect(await remoteRecords(h.kit, 'Alice', LOVE)).toHaveLength(1);
  });
});

it('with more than 10,000 love records a love.put sends one createRecord and an unlove walks every listing page, deleting each match once', async () => {
  await withHarness(async (h) => {
    const n = 10_050;
    for (let start = 0; start < n; start += 1_000) {
      const ops = Array.from({ length: Math.min(1_000, n - start) }, (_, i) => ({
        action: 'put' as const,
        collection: LOVE,
        rkey: `3kbulk${String(start + i).padStart(7, '0')}`,
        record: love(`Bulk ${start + i}`, 'Song'),
      }));
      await h.kit.repos.Alice.writes(ops);
    }
    // Two other-app loves of the key, at the newest and the oldest end of the listing.
    await h.kit.externalPut('Alice', LOVE, '3kzzzzzzzzzz2', love('Björk', 'Hyperballad'));
    await h.kit.externalPut('Alice', LOVE, '3kaaaaaaaaaa2', love('BJÖRK', 'hyperballad'));

    const put = await enqueueLove(h.m, { did: h.alice, input: { artist: 'Air', track: 'La femme' }, origin: 'web' });
    if (!put.ok) throw new Error(JSON.stringify(put.reason));
    await h.runUntilIdle();
    expect(h.writers.order()).toEqual([CREATE]);
    expect(h.op(put.operation.id)).toMatchObject({ state: 'succeeded', attempts: 1 });

    const unlove = await enqueueUnlove(h.m, { did: h.alice, artist: 'Björk', track: 'Hyperballad', origin: 'web' });
    if (!unlove.ok) throw new Error(JSON.stringify(unlove.reason));
    const mark = h.writers.sent.length;
    await h.runUntilIdle();
    const sent = h.writers.sent.slice(mark);
    // 10,053 records: 101 pages of 100, each requested once, and one delete per match.
    expect(sent.filter((s) => s.nsid === LIST)).toHaveLength(101);
    expect(sent.filter((s) => s.nsid === DELETE).map((s) => s.body?.rkey)).toEqual(['3kzzzzzzzzzz2', '3kaaaaaaaaaa2']);
    expect(h.op(unlove.operation.id)).toMatchObject({ state: 'succeeded', attempts: 1, last_error: null });
    const left = await remoteRecords(h.kit, 'Alice', LOVE);
    expect(left).toHaveLength(n + 1);
    expect(left.some((r) => r.rkey === '3kzzzzzzzzzz2' || r.rkey === '3kaaaaaaaaaa2')).toBe(false);
  });
}, 120_000);
