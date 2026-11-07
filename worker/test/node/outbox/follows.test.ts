// Follow and unfollow through the server outbox (ADR 0005 §5.8, ADR 0004
// §5.2 step 6; N2-05; ports web/test/outbox/follows.test.ts, cases M5.3.1
// and M7.3.3).

import { createHash } from 'node:crypto';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { followRkey } from '@atmusic/core/record-key';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import type { OperationRow } from '../../../src/app/rows';
import { MIGRATIONS } from '../../../src/do/schema';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { enqueueFollow, enqueueUnfollow } from '../../../src/outbox/follow-ops';
import { insertOperation, predecessorRows } from '../../../src/outbox/operations';
import { reopen, withMigratedDb } from '../support/node-db';
import { CREATE, DELETE, FOLLOW, LIST, PREFIX, remoteRecords, T0, withHarness } from './support';

const CAROL = 'did:plc:carolcarolcarolcarolcaro';

it('rejects an operation whose DID has no account before writing operations or dependencies', async () => {
  await withHarness(async (h) => {
    h.db.run('DELETE FROM accounts WHERE did = ?', h.alice);

    expect(() =>
      insertOperation(
        h.db,
        {
          id: 'missing-owner',
          did: h.alice,
          kind: 'scrobble.create',
          origin: 'web',
          collection: `${PREFIX}.scrobble`,
          rkey: 'missing-owner',
          prepared: { record: { artist: 'Björk', track: 'Jóga' }, digest: 'digest' },
          dueAt: T0,
          predecessors: [],
        },
        T0,
      ),
    ).toThrow('operation owner account does not exist');
    expect(h.db.one<{ n: number }>('SELECT count(*) AS n FROM operations')?.n).toBe(0);
    expect(h.db.one<{ n: number }>('SELECT count(*) AS n FROM operation_deps')?.n).toBe(0);
  });
});

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

it('repeated follow and unfollow reuse the latest intent across admission, retry, restart and success, but opposite intents remain FIFO', async () => {
  await withHarness(async (h) => {
    const put = () => enqueueFollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' });
    const del = () => enqueueUnfollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' });
    const id = (r: Awaited<ReturnType<typeof put>>) => {
      if (!r.ok) throw new Error(JSON.stringify(r.reason));
      return r.operation.id;
    };
    // Concurrent admissions both finish hashing before the synchronous tx.
    const [first, duplicate] = await Promise.all([put(), put()]);
    const a = id(first);
    expect(id(duplicate)).toBe(a);
    expect(h.ops()).toHaveLength(1);
    h.kit.pds.Alice.serverError(CREATE, 503, 1);
    await h.run();
    const scheduled = h.op(a);
    expect(scheduled).toMatchObject({ state: 'queued', attempts: 1 });
    h.kit.clock.advance(100);
    expect(id(await put())).toBe(a);
    expect(h.op(a)).toEqual(scheduled); // no regenerated payload/digest or reset backoff
    h.restart();
    expect(id(await put())).toBe(a);
    h.kit.clock.advance(2_000);
    await h.runUntilIdle();
    expect(h.op(a)).toMatchObject({ state: 'succeeded', attempts: 2 });
    const remote = await remoteRecords(h.kit, 'Alice', FOLLOW);
    expect(remote).toHaveLength(1);
    expect(id(await put())).toBe(a);
    expect(h.ops()).toHaveLength(1);
    expect((await h.run()).attempted).toBe(0);

    const b = id(await del());
    expect(id(await del())).toBe(b);
    const c = id(await put());
    expect(id(await put())).toBe(c);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(predecessorRows(h.db, c).map((p) => p.id)).toEqual([b]);
    await h.runUntilIdle();
    expect([a, b, c].map((key) => h.op(key).state)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(await remoteRecords(h.kit, 'Alice', FOLLOW)).toHaveLength(1);
    expect(h.writers.sent.filter((s) => s.nsid === DELETE)).toHaveLength(1);

    // Failed/cancelled latest intent is not a permanent suppression of new work.
    h.db.run("UPDATE operations SET state = 'failed' WHERE id = ?", c);
    const d = id(await put());
    expect(d).not.toBe(c);
    h.db.run("UPDATE operations SET state = 'cancelled' WHERE id = ?", d);
    expect(id(await put())).not.toBe(d);
    // Actor and subject are both in the admission identity.
    const other = await enqueueFollow(h.m, { did: h.bob, subject: h.alice, origin: 'web' });
    expect(id(other)).not.toBe(a);
  });
});

it('follow duplicates while running or blocked keep attempts, payload and dependencies unchanged', async () => {
  await withHarness(async (h) => {
    const first = await enqueueFollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' });
    if (!first.ok) throw new Error('invalid follow');
    const reached = h.writers.crashOn(CREATE, 'before_send');
    void h.run();
    await reached;
    const running = h.op(first.operation.id);
    expect(running).toMatchObject({ state: 'running', attempts: 1 });
    const repeat = await enqueueFollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' });
    expect(repeat).toEqual({ ok: true, operation: running });
    h.restart();
    h.writers.signedOut.add(h.alice);
    await h.run();
    const blocked = h.op(running.id);
    expect(blocked).toMatchObject({ state: 'blocked', attempts: 1 });
    expect(await enqueueFollow(h.m, { did: h.alice, subject: h.bob, origin: 'web' })).toEqual({
      ok: true,
      operation: blocked,
    });
    expect(h.ops()).toHaveLength(1);
    expect(predecessorRows(h.db, running.id)).toEqual([]);
  });
});

for (const create of [true, false]) {
  for (const timing of ['proof-before-ack', 'equal-timestamp'] as const) {
    it(`${create ? 'follow' : 'unfollow'} refreshes a succeeded receipt after contrary ${timing} proof, preserving consecutive reuse`, async () => {
      await withHarness(async (h) => {
        h.seedUser(h.alice);
        const rkey = await followRkey(h.bob);
        const uri = `at://${h.alice}/${FOLLOW}/${rkey}`;
        // Begin with a verified contradiction. Its unchanged revision is
        // indexing lag after a write, not grounds for a fresh duplicate.
        await h.kit.externalPut('Alice', FOLLOW, create ? 'unrelated' : rkey, follow(create ? CAROL : h.bob));
        const project = async (key: string) => {
          const car = await h.kit.repos.Alice.getRecordCar(FOLLOW, key);
          const proof = await verifyRecordProof(car, {
            did: h.alice,
            collection: FOLLOW,
            rkey: key,
            signingKey: h.kit.users.Alice.key.didKey,
          });
          const nowNs = fromMs(h.kit.clock.nowMs());
          expect(
            h.db.tx(() => applyRecordProof(h.db, proof, { prefix: PREFIX, nowNs, receiptNs: nowNs })).outcome,
          ).toBe(proof.state === 'present' ? 'applied' : 'absent');
          return proof.commit.rev;
        };
        const baseline = await project(rkey);
        const enqueue = () =>
          (create ? enqueueFollow : enqueueUnfollow)(h.m, {
            did: h.alice,
            subject: h.bob,
            origin: 'web',
          });
        const first = await enqueue();
        if (!first.ok) throw new Error('invalid intent');
        expect(await enqueue()).toEqual(first);
        const pause = h.writers.pauseOn(create ? CREATE : DELETE);
        const run = h.run();
        await pause.reached; // Remote commit exists, but no acknowledgement/settlement yet.
        expect(h.op(first.operation.id).state).toBe('running');
        // While running, even a newly verified proof does not fork the intent.
        await project(rkey);
        expect(await enqueue()).toEqual({ ok: true, operation: h.op(first.operation.id) });
        const contraryKey = create || timing === 'proof-before-ack' ? rkey : 'other-client-duplicate';
        const contradict = async () => {
          if (create) await h.kit.externalDelete('Alice', FOLLOW, rkey);
          else await h.kit.externalPut('Alice', FOLLOW, contraryKey, follow(h.bob));
          const rev = await project(contraryKey);
          expect(rev).not.toBe(baseline);
        };
        if (timing === 'proof-before-ack') {
          await contradict();
          h.kit.clock.advance(1); // Delayed settlement is strictly AFTER the proof.
        }
        pause.release();
        await run;
        expect(h.op(first.operation.id).state).toBe('succeeded');
        if (timing === 'equal-timestamp') await contradict();
        const verifiedAt = h.db.one<{ verified_at: string }>(
          'SELECT verified_at FROM record_state WHERE uri = ?',
          create ? uri : `at://${h.alice}/${FOLLOW}/${contraryKey}`,
        )!.verified_at;
        const settledAt = toStorage(fromMs(h.op(first.operation.id).updated_at_ms));
        if (timing === 'equal-timestamp') expect(verifiedAt).toBe(settledAt);
        else expect(verifiedAt < settledAt).toBe(true);
        h.restart(); // Admission's causal baseline is durable, not an in-memory latch.
        const fresh = await enqueue();
        if (!fresh.ok) throw new Error('invalid intent');
        expect(fresh.operation.id).not.toBe(first.operation.id);
        expect(await enqueue()).toEqual(fresh);
        await h.runUntilIdle();
        expect(h.op(fresh.operation.id).state).toBe('succeeded');
        // Until a newer contrary proof, the admission-time contradiction is
        // merely stale local indexing: repeated intents still reuse success.
        expect(h.ops()).toHaveLength(2);
        const repeat = await enqueue();
        expect(repeat.ok && repeat.operation.id).toBe(fresh.operation.id);
        const matching = (await remoteRecords(h.kit, 'Alice', FOLLOW)).filter(
          (r) => (r.value as { subject: string }).subject === h.bob,
        );
        expect(matching).toHaveLength(create ? 1 : 0);
      });
    });
  }
}

it('v2 follow receipts migrate without data loss; legacy success refreshes conservatively and retains v2 compatibility', async () => {
  await withMigratedDb(
    async (db) => {
      const did = 'did:plc:alicealicealicealicealic';
      const subject = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
      const rkey = await followRkey(subject);
      db.run(
        `INSERT INTO operations(id, did, kind, origin, priority, collection, rkey, record_json, digest,
      state, attempts, due_at, created_at_ms, updated_at_ms)
      VALUES ('legacy', ?, 'follow.put', 'web', 0, ?, ?, ?, 'legacy-digest', 'succeeded', 1, 0, 0, 0)`,
        did,
        FOLLOW,
        rkey,
        JSON.stringify(follow(subject)),
      );
      db.run(
        `INSERT INTO accounts(did, username, oauth_status, import_share_pct, daily_listen_cap, created_at_ms, updated_at_ms)
         VALUES (?, 'legacy-owner', 'active', 50, 3000, 0, 0)`,
        did,
      );
      const before = db.one<Omit<OperationRow, 'follow_proof_json'>>('SELECT * FROM operations WHERE id = ?', 'legacy');
      if (before === null) throw new Error('missing legacy operation');
      const upgraded = reopen(db);
      expect(upgraded.one('SELECT * FROM operations WHERE id = ?', 'legacy')).toEqual({
        ...before,
        follow_proof_json: null,
        send_started_at_ms: null,
        send_state: 'unknown',
        legacy_absent_at_ms: null,
      });
      expect(upgraded.one('SELECT min_compatible_version FROM schema_compat')).toEqual({ min_compatible_version: 2 });
      // No baseline was recorded by v2: a contradiction must cause a refresh
      // rather than silently inventing a clock-based baseline at migration.
      upgraded.run(
        `INSERT INTO record_state(uri, did, collection, revision, state, verified_at)
      VALUES (?, ?, ?, '3aaaaaaaaaaaa', 'absent', '2026-01-15T12:00:00.000000000Z')`,
        `at://${did}/${FOLLOW}/${rkey}`,
        did,
        FOLLOW,
      );
      // Only admission deps are used; no network, credentials, or executor.
      await withHarness(async (h) => {
        const m = { ...h.m, db: upgraded };
        const fresh = await enqueueFollow(m, { did, subject, origin: 'web' });
        if (!fresh.ok) throw new Error('invalid follow');
        expect(fresh.operation.id).not.toBe('legacy');
        expect(await enqueueFollow(m, { did, subject, origin: 'web' })).toEqual(fresh);
        expect(upgraded.one<OperationRow>('SELECT * FROM operations WHERE id = ?', 'legacy')).toEqual({
          ...before,
          follow_proof_json: null,
          send_started_at_ms: null,
          send_state: 'unknown',
          legacy_absent_at_ms: null,
        });
      });
    },
    { migrations: MIGRATIONS.slice(0, 2) },
  );
});
