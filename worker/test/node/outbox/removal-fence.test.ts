// Server-checked removal fences (migration 11, outbox/removal-fence.ts) and
// verified nonmembership of first-tracked entries (keys.ts noteBatchEntries).
//
// A removal write carries swapCommit = the owner's repository head read just
// before it, persisted as `removal_head_rev` before the send. Every revision
// at or below it precedes the removal: a delayed proof of any version there,
// whatever its CID and whether or not this index ever saw it, is the removed
// incarnation, while a present proof above it is a later one. These tests
// reproduce the Astra 52b5b08 findings N1 (an unobserved intermediate
// version), N2 (a delayed absence and restore that preceded the write) and
// N3 (membership first tracked after an upgrade or after a removal), plus the
// CAS concurrency, lost-response and fail-closed paths.

import { expect, it } from 'vitest';
import { recordStatus } from '../../../src/do/ingest/notify';
import { exportUser } from '../../../src/do/read/export';
import { statsWithCache } from '../../../src/do/read/stats';
import { visibleScrobblesFrom } from '../../../src/do/read/visibility';
import { MIGRATIONS } from '../../../src/do/schema';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { removeScrobble } from '../../../src/lastfm/write-methods';
import { enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { proofAt } from '../../write/support';
import { withMigratedDb } from '../support/node-db';
import { DELETE, GET, type Harness, HEAD, PUT, remoteRecords, SCROBBLE, T0, withHarness } from './support';

const PREFIX = 'com.example.atmusic';
const BATCH = `${PREFIX}.scrobbleBatch`;
const RKEY = '3lb2fencedab2';
const OTHER = '3lb2fencedzz2';
const TARGET = '3lb2batchidab';
const SIBLING = '3lb2batchidac';
const OPTIONS = { receiptNs: BigInt(T0) * 1_000_000n, nowNs: BigInt(T0) * 1_000_000n, prefix: PREFIX };

const entry = (id: string, track: string) => ({
  id,
  artist: 'Fence Artist',
  track,
  listenedAt: id === TARGET ? '2026-01-14T12:00:00Z' : '2026-01-14T13:00:00Z',
  createdAt: '2026-01-15T12:00:00Z',
});
const ORIGINAL = {
  $type: BATCH,
  createdAt: '2026-01-15T12:00:00Z',
  listens: [entry(TARGET, 'Target'), entry(SIBLING, 'Sibling')],
};
const WITHOUT_TARGET = { ...ORIGINAL, listens: [entry(SIBLING, 'Sibling')] };

const container = (h: Harness) => `at://${h.alice}/${BATCH}/${RKEY}`;
const visible = (h: Harness) =>
  h.db
    .all<{ listen_id: string }>(`SELECT s.listen_id FROM ${visibleScrobblesFrom()} ORDER BY s.listen_id`)
    .map((row) => row.listen_id);
const proof = (h: Harness, rkey = RKEY, collection = BATCH) => proofAt(h.kit.repos.Alice, collection, rkey);
const apply = (h: Harness, p: Awaited<ReturnType<typeof proof>>) =>
  h.db.tx(() => applyRecordProof(h.db, p, OPTIONS)).outcome;
const total = (h: Harness) =>
  statsWithCache(h.db, { did: h.alice, window: 'all', limit: 10, asOfNs: OPTIONS.nowNs }).statistics?.totalScrobbles;
const status = (h: Harness, id: string) => {
  h.db.run('DELETE FROM hints');
  return recordStatus(h.m, `${container(h)}#${id}`);
};
const exported = (h: Harness) => (exportUser(h.m, h.alice)?.scrobbles ?? []).map((s) => s.uri);
const remoteIds = async (h: Harness) =>
  (await remoteRecords(h.kit, 'Alice', BATCH)).flatMap((r) =>
    (r.value as { listens: Array<{ id: string }> }).listens.map((e) => e.id),
  );
const membership = (h: Harness, id: string) =>
  h.db.one<{ state: string; last_absent_revision: string | null }>(
    'SELECT state, last_absent_revision FROM verified_membership WHERE record_uri = ? AND listen_id = ?',
    container(h),
    id,
  );
const removeTargetViaLastfm = (h: Harness) =>
  removeScrobble(h.m, {
    did: h.alice,
    artist: 'Fence Artist',
    track: 'Target',
    timestamp: Date.parse('2026-01-14T12:00:00Z') / 1000,
  });

/** After the `nth` answered request for `nsid`, run `during` (once) before the client sees the answer. */
function after(h: Harness, nsid: string, nth: number, during: () => Promise<void>): void {
  const writerFor = h.writers.writerFor.bind(h.writers);
  let seen = 0;
  h.writers.writerFor = async (did: string) => {
    const writer = await writerFor(did);
    if (writer === null) return null;
    return {
      ...writer,
      fetchHandler: async (path: string, init?: RequestInit) => {
        const response = await writer.fetchHandler(path, init);
        if (path.includes(`/xrpc/${nsid}`) && ++seen === nth) await during();
        return response;
      },
    };
  };
}

/** A projected two-listen container and an admitted removal of `listenIds`. */
async function admitted(h: Harness, listenIds: string[]) {
  h.seedUser(h.alice);
  await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
  const a = await proof(h);
  expect(apply(h, a)).toBe('applied');
  expect(visible(h)).toEqual([TARGET, SIBLING]);
  const removal = enqueueBatchListenDelete(h.m, { did: h.alice, uri: container(h), listenIds, origin: 'web' });
  return { a, removal };
}

// ---------------------------------------------------------------------------
// N1: an intermediate pre-removal version this index never saw

it.each([{ when: 'during the read-back, before local settlement' }, { when: 'after settlement' }])(
  'N1: a delayed proof of an unobserved intermediate version applied $when stays removed',
  async ({ when }) => {
    await withHarness(async (h) => {
      const { a, removal } = await admitted(h, [TARGET]);
      // Two unrelated edits B and C; the index never sees either.
      await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'B' });
      const b = await proof(h);
      await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'C' });
      const c = await proof(h);
      let outcome = '';
      if (when.startsWith('during')) {
        after(h, GET, 2, async () => {
          outcome = apply(h, b);
        });
      }
      await h.runUntilIdle();
      if (!when.startsWith('during')) outcome = apply(h, b);
      expect(outcome).toBe('applied');

      const op = h.op(removal.id);
      expect(op).toMatchObject({ state: 'succeeded', removal_head_rev: c.commit.rev });
      expect(op.removal_commit_rev! > c.commit.rev).toBe(true);
      // B's CID was never evidence; the head fence covers it anyway.
      const evidence = h.db.all<{ cid: string }>(
        'SELECT cid FROM listen_removal_cids WHERE operation_id = ?',
        removal.id,
      );
      expect(evidence.map((e) => e.cid)).not.toContain(b.state === 'present' ? b.cid : '');
      expect(b.commit.rev > a.commit.rev && b.commit.rev < op.removal_head_rev!).toBe(true);

      expect(await remoteIds(h)).toEqual([SIBLING]);
      expect(visible(h)).toEqual([SIBLING]);
      expect(status(h, TARGET).state).not.toBe('indexed');
      expect(exported(h)).not.toContain(`${container(h)}#${TARGET}`);
      expect(total(h)).toBe(1);
    });
  },
);

// ---------------------------------------------------------------------------
// N2: an absence and a restore that preceded the write, delivered late

it('N2: a delayed absence and byte-identical restore from before the write do not retire the receipt', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    await h.kit.externalPut('Alice', BATCH, RKEY, WITHOUT_TARGET);
    const b = await proof(h);
    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    const c = await proof(h);
    let during: { visible: string[]; total: number | undefined } | null = null;
    after(h, GET, 2, async () => {
      expect([apply(h, b), apply(h, c)]).toEqual(['applied', 'applied']);
      // The verified absence at B is recorded truthfully,
      expect(membership(h, TARGET)).toEqual({ state: 'present', last_absent_revision: b.commit.rev });
      during = { visible: visible(h), total: total(h) };
    });
    await h.runUntilIdle();
    const op = h.op(removal.id);
    // C's CID is the swapRecord, and B/C are at or below the checked head.
    expect(op).toMatchObject({ state: 'succeeded', swap_cid: c.state === 'present' ? c.cid : null });
    expect(op.removal_head_rev).toBe(c.commit.rev);
    expect(during).toEqual({ visible: [SIBLING], total: 1 });
    // but B precedes the removal, so it cannot end the receipt after settlement.
    expect(await remoteIds(h)).toEqual([SIBLING]);
    expect(visible(h)).toEqual([SIBLING]);
    expect(status(h, TARGET).state).not.toBe('indexed');
    expect(exported(h)).not.toContain(`${container(h)}#${TARGET}`);
    expect(total(h)).toBe(1);
  });
});

it('N2 (single record): a delayed absence and restore from before the delete keep the record removed', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const rkey = '3lb2singleab2';
    const record = {
      $type: SCROBBLE,
      artist: 'Fence Artist',
      track: 'Single',
      listenedAt: '2026-01-14T12:00:00Z',
      createdAt: '2026-01-15T12:00:00Z',
    };
    await h.kit.externalPut('Alice', SCROBBLE, rkey, record);
    expect(apply(h, await proof(h, rkey, SCROBBLE))).toBe('applied');
    const uri = `at://${h.alice}/${SCROBBLE}/${rkey}`;
    const del = enqueueScrobbleDelete(h.m, { did: h.alice, uri, origin: 'web' });
    await h.kit.externalDelete('Alice', SCROBBLE, rkey);
    const b = await proof(h, rkey, SCROBBLE);
    await h.kit.externalPut('Alice', SCROBBLE, rkey, record);
    const c = await proof(h, rkey, SCROBBLE);
    await h.runUntilIdle();
    expect(h.op(del.id)).toMatchObject({ state: 'succeeded', removal_head_rev: c.commit.rev });
    expect([apply(h, b), apply(h, c)]).toEqual(['absent', 'applied']);
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toEqual([]);
    expect(h.db.all(`SELECT s.uri FROM ${visibleScrobblesFrom()}`)).toEqual([]);
    // A restore committed after the delete is a later incarnation and visible.
    await h.kit.externalPut('Alice', SCROBBLE, rkey, record);
    expect(apply(h, await proof(h, rkey, SCROBBLE))).toBe('applied');
    expect(h.db.all(`SELECT s.uri FROM ${visibleScrobblesFrom()}`)).toEqual([{ uri }]);
  });
});

// ---------------------------------------------------------------------------
// Head CAS concurrency

it('ABA between the head read and the write (remove + identical restore) is InvalidSwap, then fenced at the fresh head', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    let b: Awaited<ReturnType<typeof proof>> | null = null;
    let c: Awaited<ReturnType<typeof proof>> | null = null;
    after(h, HEAD, 1, async () => {
      await h.kit.externalPut('Alice', BATCH, RKEY, WITHOUT_TARGET);
      b = await proof(h);
      await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
      c = await proof(h);
    });
    await h.runUntilIdle();
    const puts = h.writers.sent.filter((r) => r.nsid === PUT);
    // The record CID is the same again (ABA), but the commit moved: the first write is refused.
    expect(puts.map((r) => r.status)).toEqual([400, 200]);
    expect(puts[0]!.body!.swapRecord).toBe(puts[1]!.body!.swapRecord);
    expect(puts[0]!.body!.swapCommit).not.toBe(puts[1]!.body!.swapCommit);
    const op = h.op(removal.id);
    expect(op).toMatchObject({ state: 'succeeded', attempts: 1, removal_head_rev: c!.commit.rev });
    // The restored incarnation C (before the write) is what the write removed.
    expect([apply(h, b!), apply(h, c!)]).toEqual(['applied', 'applied']);
    expect(await remoteIds(h)).toEqual([SIBLING]);
    expect(visible(h)).toEqual([SIBLING]);
  });
});

it('a commit to another record between the head read and the write retries in the same attempt', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    after(h, GET, 1, async () => {
      await h.kit.externalPut('Alice', BATCH, OTHER, WITHOUT_TARGET);
    });
    await h.runUntilIdle();
    // The second PUT committed (its commit is the boundary); the read-back
    // after it reads the head before the container.
    expect(h.writers.order().filter((n) => n !== GET)).toEqual([HEAD, PUT, HEAD, PUT, HEAD]);
    expect(h.writers.sent.filter((r) => r.nsid === PUT).map((r) => r.status)).toEqual([400, 200]);
    expect(h.op(removal.id)).toMatchObject({ state: 'succeeded', attempts: 1, last_error: null });
    expect(h.op(removal.id)).toMatchObject({
      removal_commit_rev: h.kit.repos.Alice.head!.rev,
      removal_done_rev: h.kit.repos.Alice.head!.rev,
      removal_done_basis: 'commit',
    });
    // The target is gone from its container; the other record is untouched.
    expect((await remoteIds(h)).sort()).toEqual([SIBLING, SIBLING]);
  });
});

it('a committed write whose success answer omits commit metadata settles at the ordered absence after it', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'B' });
    const b = await proof(h);
    const head = h.kit.repos.Alice.head!;
    h.kit.pds.Alice.fail(
      { nsid: PUT },
      {
        kind: 'respond',
        respond: async () => {
          // The PDS commits the edit but answers without `commit`.
          await h.kit.repos.Alice.put(BATCH, RKEY, { ...ORIGINAL, extra: 'B', listens: WITHOUT_TARGET.listens });
          return Response.json({
            uri: container(h),
            cid: 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
          });
        },
      },
    );
    await h.runUntilIdle();
    // The send fence stays the pre-send head; without a usable commit the
    // boundary is the head of the stable head/read/head bracket that found
    // the target gone (the metadata-free commit itself).
    expect(h.op(removal.id)).toMatchObject({
      state: 'succeeded',
      removal_head_rev: head.rev,
      removal_commit_rev: null,
      removal_done_rev: h.kit.repos.Alice.head!.rev,
      removal_done_basis: 'absent',
    });
    expect(h.writers.count(PUT)).toBe(1);
    expect(apply(h, b)).toBe('applied');
    expect(visible(h)).toEqual([SIBLING]);
  });
});

it('a lost write response: the head persisted before the send survives the restart and fences the receipt', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'B' });
    const b = await proof(h);
    const head = h.kit.repos.Alice.head!;
    const crashed = h.writers.crashOn(PUT, 'after_commit');
    void h.run();
    await crashed;
    expect(h.op(removal.id)).toMatchObject({ state: 'running', removal_head_rev: head.rev, removal_commit_rev: null });
    expect(await remoteIds(h)).toEqual([SIBLING]);
    h.restart();
    const mark = h.writers.sent.length;
    await h.runUntilIdle();
    // The restarted attempt reads, finds the target gone, and never writes again.
    expect(
      h.writers.sent
        .slice(mark)
        .map((r) => r.nsid)
        .filter((n) => n === PUT || n === DELETE),
    ).toEqual([]);
    const op = h.op(removal.id);
    expect(op.state).toBe('succeeded');
    expect(op.removal_head_rev! >= head.rev).toBe(true);
    expect(apply(h, b)).toBe('applied');
    expect(visible(h)).toEqual([SIBLING]);
  });
});

it('an interrupted tenth attempt reconciles read-only and keeps its persisted head', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'B' });
    const b = await proof(h);
    const sentHead = h.kit.repos.Alice.head!.rev;
    // The tenth send committed (simulated) and its answer was lost.
    await h.kit.externalPut('Alice', BATCH, RKEY, WITHOUT_TARGET);
    h.db.run(
      "UPDATE operations SET state='running', attempts=10, send_state='unknown', send_started_at_ms=?, removal_head_rev=? WHERE id=?",
      T0,
      sentHead,
      removal.id,
    );
    await h.run();
    // Read-only: the absence is ordered by the head read after it.
    expect(h.writers.order()).toEqual([HEAD, GET, HEAD]);
    const op = h.op(removal.id);
    expect(op).toMatchObject({
      state: 'succeeded',
      attempts: 10,
      removal_done_rev: h.kit.repos.Alice.head!.rev,
      removal_done_basis: 'absent',
    });
    expect(op.removal_head_rev! >= sentHead).toBe(true);
    expect(apply(h, b)).toBe('applied');
    expect(visible(h)).toEqual([SIBLING]);
  });
});

// ---------------------------------------------------------------------------
// Fail closed: no write without a usable head

it.each([
  { name: 'unavailable (501)', code: 'repository_head_unavailable' },
  { name: 'malformed', code: 'repository_head_unavailable' },
  { name: 'behind the verified index', code: 'repository_head_behind_index' },
])(
  'a repository head that is $name holds the removal without writing or spending an attempt',
  async ({ name, code }) => {
    await withHarness(async (h) => {
      const { removal } = await admitted(h, [TARGET]);
      if (name.startsWith('unavailable')) h.kit.pds.Alice.serverError(HEAD, 501, 1);
      else if (name === 'malformed') {
        h.kit.pds.Alice.fail({ nsid: HEAD }, { kind: 'respond', respond: () => Response.json({ cid: 'x', rev: 'y' }) });
      } else {
        const old = h.kit.repos.Alice.head!;
        await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'B' });
        expect(apply(h, await proof(h))).toBe('applied');
        h.kit.pds.Alice.serveStaleHead(h.alice, old.cid);
      }
      await h.run();
      expect(h.op(removal.id)).toMatchObject({
        state: 'queued',
        attempts: 0,
        last_error: code,
        removal_head_rev: null,
      });
      expect(h.writers.count(PUT) + h.writers.count(DELETE)).toBe(0);
      // Still hidden while held; it proceeds once the head is usable.
      expect(visible(h)).toEqual([SIBLING]);
      h.kit.pds.Alice.clearStaleHead(h.alice);
      h.kit.clock.advance(5_000);
      await h.runUntilIdle();
      expect(h.op(removal.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
      expect(await remoteIds(h)).toEqual([SIBLING]);
    });
  },
);

// ---------------------------------------------------------------------------
// Positive: a later incarnation, including before settlement

it.each([
  { name: 'the same bytes', restored: ORIGINAL },
  { name: 'new bytes', restored: { ...ORIGINAL, extra: 'restored' } },
])(
  'a restore of $name committed after the fenced removal and proved before settlement is visible',
  async ({ restored }) => {
    await withHarness(async (h) => {
      const { removal } = await admitted(h, [TARGET]);
      after(h, GET, 2, async () => {
        await h.kit.externalPut('Alice', BATCH, RKEY, restored);
        expect(apply(h, await proof(h))).toBe('applied');
      });
      await h.runUntilIdle();
      expect(h.op(removal.id).state).toBe('succeeded');
      expect(visible(h)).toEqual([TARGET, SIBLING]);
      expect(status(h, TARGET).state).toBe('indexed');
      expect(total(h)).toBe(2);
      expect(await removeTargetViaLastfm(h)).toHaveLength(1);
      await h.runUntilIdle();
      expect(await remoteIds(h)).toEqual([SIBLING]);
      expect(visible(h)).toEqual([SIBLING]);
    });
  },
);

it('a pending or failed removal still hides a restore proved above any head', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    for (const state of ['queued', 'running', 'blocked', 'failed']) {
      h.db.run(
        'UPDATE operations SET state = ?, removal_head_rev = ? WHERE id = ?',
        state,
        '2222222222222',
        removal.id,
      );
      expect(visible(h)).toEqual([SIBLING]);
    }
  });
});

// ---------------------------------------------------------------------------
// N3: verified nonmembership of entries tracked for the first time

/** A projected v9 database (no verified_membership): rows built with current code, copied into the old schema. */
async function projectedAtV9(h: Harness): Promise<void> {
  h.seedUser(h.alice);
  await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
  const a = await proof(h);
  await withMigratedDb(async (scratch) => {
    const copy = (from: typeof scratch, to: typeof scratch, table: string) => {
      for (const row of from.all<Record<string, unknown>>(`SELECT * FROM ${table}`)) {
        const cols = Object.keys(row);
        to.run(
          `INSERT OR REPLACE INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
          ...cols.map((c) => row[c] as string | number | null),
        );
      }
    };
    copy(h.db, scratch, 'users');
    expect(scratch.tx(() => applyRecordProof(scratch, a, OPTIONS)).outcome).toBe('applied');
    for (const table of ['users', 'scrobbles', 'record_state']) copy(scratch, h.db, table);
  });
  expect(h.db.one("SELECT name FROM sqlite_master WHERE name = 'verified_membership'")).toBeNull();
  h.restart();
  expect(h.db.one<{ v: number }>('SELECT max(version) AS v FROM schema_migrations')!.v).toBe(MIGRATIONS.length);
  expect(visible(h)).toEqual([TARGET, SIBLING]);
}

it.each([
  { kind: 'whole', ids: ['*'] },
  { kind: 'partial', ids: [TARGET] },
])(
  'N3: after a real v9 upgrade, a $kind removal, verified absence and identical restore keep truthful membership',
  async ({ kind, ids }) => {
    await withHarness(
      async (h) => {
        await projectedAtV9(h);
        const removal = enqueueBatchListenDelete(h.m, {
          did: h.alice,
          uri: container(h),
          listenIds: ids,
          origin: 'web',
        });
        await h.runUntilIdle();
        expect(h.op(removal.id).state).toBe('succeeded');
        const b = await proof(h);
        expect(apply(h, b)).toBe(kind === 'whole' ? 'absent' : 'applied');
        expect(status(h, TARGET)).toMatchObject({ state: 'absent', revision: b.commit.rev });
        await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
        const c = await proof(h);
        expect(apply(h, c)).toBe('applied');
        h.restart();
        // The entry's first row inherits the verified boundary B.
        expect(membership(h, TARGET)).toEqual({ state: 'present', last_absent_revision: b.commit.rev });
        expect(membership(h, SIBLING)?.last_absent_revision ?? null).toBe(kind === 'whole' ? b.commit.rev : null);
        expect(visible(h)).toEqual([TARGET, SIBLING]);
        expect(status(h, TARGET)).toMatchObject({ state: 'indexed', revision: c.commit.rev });
        expect(exported(h)).toContain(`${container(h)}#${TARGET}`);
        expect(total(h)).toBe(2);
        // A legacy receipt (no head fence) is retired by the same truthful membership.
        h.db.run(
          'UPDATE operations SET removal_head_rev = NULL, removal_commit_rev = NULL, removal_done_rev = NULL, removal_done_basis = NULL WHERE id = ?',
          removal.id,
        );
        expect(visible(h)).toEqual([TARGET, SIBLING]);
        expect(await removeTargetViaLastfm(h)).toHaveLength(1);
        await h.runUntilIdle();
        expect(await remoteIds(h)).toEqual([SIBLING]);
        expect(visible(h)).toEqual([SIBLING]);
      },
      { migrations: MIGRATIONS.slice(0, 9) },
    );
  },
);

it('N3: a partial removal before the first projection records the entry absent; its identical restore is a new incarnation', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    const removal = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: container(h),
      listenIds: [TARGET],
      origin: 'web',
    });
    await h.runUntilIdle();
    expect(h.op(removal.id).state).toBe('succeeded');
    const b = await proof(h);
    expect(apply(h, b)).toBe('applied');
    expect(membership(h, TARGET)).toBeNull();
    expect(status(h, TARGET)).toMatchObject({ state: 'absent', revision: b.commit.rev });
    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    expect(apply(h, await proof(h))).toBe('applied');
    // The previous valid version B did not list it: that is its boundary.
    expect(membership(h, TARGET)).toEqual({ state: 'present', last_absent_revision: b.commit.rev });
    h.db.run(
      'UPDATE operations SET removal_head_rev = NULL, removal_commit_rev = NULL, removal_done_rev = NULL, removal_done_basis = NULL WHERE id = ?',
      removal.id,
    );
    expect(visible(h)).toEqual([TARGET, SIBLING]);
  });
});

it('N3: an excluded (invalid) container version proves no entry absent', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, listens: [{ id: SIBLING }] });
    expect(apply(h, await proof(h))).toBe('excluded');
    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    expect(apply(h, await proof(h))).toBe('applied');
    expect(membership(h, TARGET)).toEqual({ state: 'present', last_absent_revision: null });
  });
});
