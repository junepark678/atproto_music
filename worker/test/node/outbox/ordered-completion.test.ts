// Ordered removal completion (migration 12, outbox/removal-fence.ts).
//
// A removal settles only with an ordered completion boundary
// `removal_done_rev`: an enforced commit, an absence bracketed by the same
// head before and after its read (or read after an earlier completion), or a
// verified absence after the send fence. These tests reproduce the Astra
// 79560fe findings:
// - F1: a head read before an absent read does not order that absence. An
//   intermediate version B committed after the head and removed at D before
//   the read must stay hidden when its delayed proof arrives.
// - F2: a 2xx without usable commit metadata (the reference PDS's no-op
//   delete of an absent record and put of the stored bytes, which check no
//   swap) is not a compare-and-swap success.
// - F3: a completed removal (a known commit, or a verified absence after its
//   send) never replays against a verified later recreation R, across a
//   failed read-back and a restart; a fresh intent still removes R.
// They also keep the six recovery controls (recreation after the absent read
// was captured, before local settlement) and the fail-closed head rules.

import { expect, it } from 'vitest';
import { recordStatus } from '../../../src/do/ingest/notify';
import { exportUser } from '../../../src/do/read/export';
import { statsWithCache } from '../../../src/do/read/stats';
import { visibleScrobblesFrom } from '../../../src/do/read/visibility';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { proofAt } from '../../write/support';
import { DELETE, GET, type Harness, HEAD, PUT, remoteRecords, SCROBBLE, T0, withHarness } from './support';

const PREFIX = 'com.example.atmusic';
const BATCH = `${PREFIX}.scrobbleBatch`;
const RKEY = '3lb2orderedab';
const SINGLE_RKEY = '3lb2singleab2';
const TARGET = '3lb2batchidab';
const SIBLING = '3lb2batchidac';
const OPTIONS = { receiptNs: BigInt(T0) * 1_000_000n, nowNs: BigInt(T0) * 1_000_000n, prefix: PREFIX };

const entry = (id: string, track: string) => ({
  id,
  artist: 'Ordered Artist',
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
const SINGLE = {
  $type: SCROBBLE,
  artist: 'Single Artist',
  track: 'Single Track',
  listenedAt: '2026-01-14T12:00:00Z',
  createdAt: '2026-01-15T12:00:00Z',
};

type Proof = Awaited<ReturnType<typeof proofAt>>;
const container = (h: Harness) => `at://${h.alice}/${BATCH}/${RKEY}`;
const singleUri = (h: Harness) => `at://${h.alice}/${SCROBBLE}/${SINGLE_RKEY}`;
const proof = (h: Harness, collection = BATCH, rkey = RKEY) => proofAt(h.kit.repos.Alice, collection, rkey);
const apply = (h: Harness, p: Proof) => h.db.tx(() => applyRecordProof(h.db, p, OPTIONS)).outcome;
const visible = (h: Harness) =>
  h.db
    .all<{ listen_id: string | null }>(`SELECT s.listen_id FROM ${visibleScrobblesFrom()} ORDER BY s.listen_id`)
    .map((row) => row.listen_id ?? '*');
const total = (h: Harness) =>
  statsWithCache(h.db, { did: h.alice, window: 'all', limit: 10, asOfNs: OPTIONS.nowNs }).statistics?.totalScrobbles;
const exported = (h: Harness) => (exportUser(h.m, h.alice)?.scrobbles ?? []).map((s) => s.uri);
const status = (h: Harness, uri: string) => {
  h.db.run('DELETE FROM hints');
  return recordStatus(h.m, uri);
};
const writes = (h: Harness, from = 0) =>
  h.writers.sent.slice(from).filter((r) => r.nsid === PUT || r.nsid === DELETE).length;
const remoteIds = async (h: Harness) =>
  (await remoteRecords(h.kit, 'Alice', BATCH)).flatMap((r) =>
    (r.value as { listens: Array<{ id: string }> }).listens.map((e) => e.id),
  );

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

/** A projected two-listen container A and an admitted removal of `listenIds`. */
async function admitted(h: Harness, listenIds: string[]) {
  h.seedUser(h.alice);
  await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
  const a = await proof(h);
  expect(apply(h, a)).toBe('applied');
  const removal = enqueueBatchListenDelete(h.m, { did: h.alice, uri: container(h), listenIds, origin: 'web' });
  return { a, removal };
}

/** A single scrobble record A (projected unless `indexed` is false) and its admitted removal. */
async function admittedSingle(h: Harness, indexed = true) {
  h.seedUser(h.alice);
  await h.kit.externalPut('Alice', SCROBBLE, SINGLE_RKEY, SINGLE);
  const a = await proof(h, SCROBBLE, SINGLE_RKEY);
  if (indexed) expect(apply(h, a)).toBe('applied');
  const removal = enqueueScrobbleDelete(h.m, { did: h.alice, uri: singleUri(h), origin: 'web' });
  return { a, removal };
}

/** An interrupted tenth send: the next run only reconciles, read-only. */
function interruptedTenth(h: Harness, id: string, sentHead: string): void {
  h.db.run(
    "UPDATE operations SET state='running', attempts=10, send_state='unknown', send_started_at_ms=?, removal_head_rev=? WHERE id=?",
    T0,
    sentHead,
    id,
  );
}

/** The batch surfaces once the delayed proof B was applied after settlement. */
async function expectBatchHidden(h: Harness, kind: 'partial' | 'whole') {
  expect(visible(h)).toEqual(kind === 'whole' ? [] : [SIBLING]);
  expect(total(h)).toBe(kind === 'whole' ? 0 : 1);
  expect(exported(h)).toEqual(kind === 'whole' ? [] : [`${container(h)}#${SIBLING}`]);
  expect(status(h, `${container(h)}#${TARGET}`)).toMatchObject({ state: 'unknown' });
  expect(await remoteIds(h)).toEqual(kind === 'whole' ? [] : [SIBLING]);
}

// ---------------------------------------------------------------------------
// F1: the head was read before an absence it did not order

it.each([
  { mode: 'execute', kind: 'partial' },
  { mode: 'execute', kind: 'whole' },
  { mode: 'tenth', kind: 'partial' },
  { mode: 'tenth', kind: 'whole' },
] as const)(
  'F1 batch $mode $kind: an absence read after B and D committed past the head settles at D, and delayed B stays hidden',
  async ({ mode, kind }) => {
    await withHarness(async (h) => {
      const { a, removal } = await admitted(h, kind === 'whole' ? ['*'] : [TARGET]);
      if (mode === 'tenth') interruptedTenth(h, removal.id, a.commit.rev);
      let b: Proof | undefined;
      let d: Proof | undefined;
      // After head H was answered, before the container read: another writer
      // commits a target-containing B, then removes the target at D.
      after(h, HEAD, 1, async () => {
        await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'B after the checked head' });
        b = await proof(h);
        if (kind === 'whole') await h.kit.externalDelete('Alice', BATCH, RKEY);
        else await h.kit.externalPut('Alice', BATCH, RKEY, WITHOUT_TARGET);
        d = await proof(h);
      });
      await h.runUntilIdle();
      expect(b!.commit.rev > a.commit.rev && d!.commit.rev > b!.commit.rev).toBe(true);
      // The first bracket saw the head move (absent at some moment after H);
      // the next read, after D, makes the boundary exact. Nothing was written.
      expect(h.op(removal.id)).toMatchObject({
        state: 'succeeded',
        removal_done_rev: d!.commit.rev,
        removal_done_basis: 'absent',
        removal_commit_rev: null,
      });
      expect(writes(h)).toBe(0);
      expect(apply(h, b!)).toBe('applied');
      await expectBatchHidden(h, kind);
    });
  },
);

it.each(['initial-no-index', 'invalid-swap', 'missing', 'tenth'] as const)(
  'F1 single %s: an absence after B and D committed past the head settles at D, and delayed B stays hidden',
  async (mode) => {
    await withHarness(async (h) => {
      const { a, removal } = await admittedSingle(h, mode !== 'initial-no-index');
      if (mode === 'tenth') interruptedTenth(h, removal.id, a.commit.rev);
      let b: Proof | undefined;
      let d: Proof | undefined;
      after(h, HEAD, 1, async () => {
        await h.kit.externalPut('Alice', SCROBBLE, SINGLE_RKEY, { ...SINGLE, extra: 'B' });
        b = await proof(h, SCROBBLE, SINGLE_RKEY);
        await h.kit.externalDelete('Alice', SCROBBLE, SINGLE_RKEY);
        d = await proof(h, SCROBBLE, SINGLE_RKEY);
      });
      if (mode === 'missing') {
        h.kit.pds.Alice.fail(
          { nsid: DELETE },
          { kind: 'status', status: 400, error: 'RecordNotFound', message: 'gone' },
        );
      }
      await h.runUntilIdle();
      expect(h.op(removal.id)).toMatchObject({
        state: 'succeeded',
        removal_done_rev: d!.commit.rev,
        removal_done_basis: 'absent',
        removal_commit_rev: null,
      });
      expect(apply(h, b!)).toBe('applied');
      expect(visible(h)).toEqual([]);
      expect(total(h)).toBe(0);
      expect(exported(h)).toEqual([]);
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toEqual([]);
    });
  },
);

it.each([
  { status: 500, error: 'InternalServerError' },
  { status: 400, error: 'RecordNotFound' },
])(
  'F1 a failed write ($error) followed by B and D settles only at the ordered absence D',
  async ({ status: code, error }) => {
    await withHarness(async (h) => {
      const { removal } = await admitted(h, [TARGET]);
      h.kit.pds.Alice.fail({ nsid: PUT }, { kind: 'status', status: code, error, message: 'write did not commit' });
      let b: Proof | undefined;
      let d: Proof | undefined;
      after(h, PUT, 1, async () => {
        await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'B' });
        b = await proof(h);
        await h.kit.externalPut('Alice', BATCH, RKEY, WITHOUT_TARGET);
        d = await proof(h);
      });
      await h.runUntilIdle();
      expect(h.op(removal.id)).toMatchObject({
        state: 'succeeded',
        removal_done_rev: d!.commit.rev,
        removal_done_basis: 'absent',
        removal_commit_rev: null,
      });
      expect(h.writers.count(PUT)).toBe(1);
      expect(apply(h, b!)).toBe('applied');
      await expectBatchHidden(h, 'partial');
    });
  },
);

// ---------------------------------------------------------------------------
// F2: a 2xx without a usable commit is not a compare-and-swap success

it.each(['partial', 'whole', 'single'] as const)(
  'F2 %s: a stale write answered by the reference no-op (200, no commit, no swap checked) settles only at the ordered absence',
  async (kind) => {
    await withHarness(async (h) => {
      let b: Proof | undefined;
      let d: Proof | undefined;
      let removal: { id: string };
      if (kind === 'single') {
        ({ removal } = await admittedSingle(h));
        // After head H, before the delete: B, then the record is removed at D.
        after(h, HEAD, 1, async () => {
          await h.kit.externalPut('Alice', SCROBBLE, SINGLE_RKEY, { ...SINGLE, extra: 'B' });
          b = await proof(h, SCROBBLE, SINGLE_RKEY);
          await h.kit.externalDelete('Alice', SCROBBLE, SINGLE_RKEY);
          d = await proof(h, SCROBBLE, SINGLE_RKEY);
        });
      } else {
        ({ removal } = await admitted(h, kind === 'whole' ? ['*'] : [TARGET]));
        // After the container read, before the write: B, then D already is
        // exactly the requested result (the same bytes, or no record).
        after(h, GET, 1, async () => {
          await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'B' });
          b = await proof(h);
          if (kind === 'whole') await h.kit.externalDelete('Alice', BATCH, RKEY);
          else await h.kit.externalPut('Alice', BATCH, RKEY, WITHOUT_TARGET);
          d = await proof(h);
        });
      }
      await h.runUntilIdle();
      const write = h.writers.sent.find((r) => r.nsid === (kind === 'partial' ? PUT : DELETE))!;
      // The stale swapCommit was never checked: the no-op answered 200 and
      // committed nothing.
      expect(write.status).toBe(200);
      expect(write.body).toMatchObject({ swapCommit: expect.any(String) });
      expect(h.kit.repos.Alice.head!.rev).toBe(d!.commit.rev);
      expect(h.op(removal.id)).toMatchObject({
        state: 'succeeded',
        removal_done_rev: d!.commit.rev,
        removal_done_basis: 'absent',
        removal_commit_rev: null,
      });
      expect(apply(h, b!)).toBe('applied');
      if (kind === 'single') {
        expect(visible(h)).toEqual([]);
        expect(exported(h)).toEqual([]);
      } else await expectBatchHidden(h, kind);
    });
  },
);

// ---------------------------------------------------------------------------
// F3: a completed removal never replays against a verified later recreation

it.each(['known-success', 'lost-response-verified-absence'] as const)(
  'F3 %s: a restart after a completed removal settles without writing, and the verified recreation R stays visible',
  async (mode) => {
    await withHarness(async (h) => {
      const { removal } = await admitted(h, [TARGET]);
      if (mode === 'known-success') {
        // The PUT commits and answers its commit; the read-back fails.
        after(h, PUT, 1, async () => {
          h.kit.pds.Alice.fail(
            { nsid: GET },
            { kind: 'status', status: 500, error: 'InternalServerError', message: 'x' },
          );
        });
        await h.runUntilIdle();
      } else {
        const crashed = h.writers.crashOn(PUT, 'after_commit');
        void h.run();
        await crashed;
      }
      const first = h.op(removal.id);
      const d = await proof(h);
      if (mode === 'known-success') {
        expect(first).toMatchObject({
          state: 'queued',
          removal_commit_rev: d.commit.rev,
          removal_done_rev: d.commit.rev,
          removal_done_basis: 'commit',
        });
      } else expect(first).toMatchObject({ state: 'running', removal_commit_rev: null, removal_done_rev: null });
      expect(apply(h, d)).toBe('applied');
      // The owner recreates the identical listen at R; this index verifies it.
      await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
      const r = await proof(h);
      expect(apply(h, r)).toBe('applied');
      h.restart();
      const due = h.op(removal.id).due_at;
      if (due > h.kit.clock.nowMs()) h.kit.clock.advance(due - h.kit.clock.nowMs());
      const mark = h.writers.sent.length;
      await h.runUntilIdle();
      expect(writes(h, mark)).toBe(0);
      expect(h.op(removal.id)).toMatchObject({
        state: 'succeeded',
        removal_done_rev: d.commit.rev,
        removal_done_basis: mode === 'known-success' ? 'commit' : 'verified',
      });
      expect(await remoteIds(h)).toEqual([TARGET, SIBLING]);
      expect(visible(h)).toEqual([TARGET, SIBLING]);
      expect(total(h)).toBe(2);
      expect(status(h, `${container(h)}#${TARGET}`)).toMatchObject({ state: 'indexed', revision: r.commit.rev });

      // A fresh intent removes the later incarnation normally.
      const fresh = enqueueBatchListenDelete(h.m, {
        did: h.alice,
        uri: container(h),
        listenIds: [TARGET],
        origin: 'web',
      });
      await h.runUntilIdle();
      expect(h.op(fresh.id)).toMatchObject({ state: 'succeeded', removal_done_basis: 'commit' });
      expect(await remoteIds(h)).toEqual([SIBLING]);
      expect(visible(h)).toEqual([SIBLING]);
    });
  },
);

it('F3 a known commit whose first read-back already sees the recreation R settles without a second write', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    let d: Proof | undefined;
    let r: Proof | undefined;
    after(h, PUT, 1, async () => {
      d = await proof(h);
      apply(h, d);
      await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
      r = await proof(h);
      apply(h, r);
    });
    await h.runUntilIdle();
    const due = h.op(removal.id).due_at;
    if (due > h.kit.clock.nowMs()) h.kit.clock.advance(due - h.kit.clock.nowMs());
    await h.runUntilIdle();
    expect(h.writers.count(PUT)).toBe(1);
    expect(h.op(removal.id)).toMatchObject({
      state: 'succeeded',
      removal_commit_rev: d!.commit.rev,
      removal_done_rev: d!.commit.rev,
      removal_done_basis: 'commit',
    });
    expect(r!.commit.rev > d!.commit.rev).toBe(true);
    expect(await remoteIds(h)).toEqual([TARGET, SIBLING]);
    expect(visible(h)).toEqual([TARGET, SIBLING]);
  });
});

it('F3 single: a lost delete answer with a verified absence never deletes the byte-identical recreation R', async () => {
  await withHarness(async (h) => {
    const { removal } = await admittedSingle(h);
    const crashed = h.writers.crashOn(DELETE, 'after_commit');
    void h.run();
    await crashed;
    expect(h.op(removal.id)).toMatchObject({ state: 'running', removal_done_rev: null });
    const d = await proof(h, SCROBBLE, SINGLE_RKEY);
    expect(apply(h, d)).toBe('absent');
    await h.kit.externalPut('Alice', SCROBBLE, SINGLE_RKEY, SINGLE);
    const r = await proof(h, SCROBBLE, SINGLE_RKEY);
    expect(apply(h, r)).toBe('applied');
    // Same bytes: the persisted swapRecord would match R exactly.
    expect(r.state === 'present' && r.cid).toBe(h.op(removal.id).swap_cid);
    h.restart();
    const mark = h.writers.sent.length;
    await h.runUntilIdle();
    expect(writes(h, mark)).toBe(0);
    expect(h.op(removal.id)).toMatchObject({
      state: 'succeeded',
      removal_done_rev: d.commit.rev,
      removal_done_basis: 'verified',
    });
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(1);
    expect(visible(h)).toEqual(['*']);

    const fresh = enqueueScrobbleDelete(h.m, { did: h.alice, uri: singleUri(h), origin: 'web' });
    await h.runUntilIdle();
    expect(h.op(fresh.id)).toMatchObject({ state: 'succeeded', removal_done_basis: 'commit' });
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toEqual([]);
    expect(visible(h)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Preserved controls: recreation after the recovery's absent read was
// captured, before local settlement, stays visible with no extra write.

it.each([
  { mode: 'lost-response', kind: 'partial' },
  { mode: 'lost-response', kind: 'whole' },
  { mode: 'known-commit-readback-failed', kind: 'partial' },
  { mode: 'known-commit-readback-failed', kind: 'whole' },
  { mode: 'tenth-lost-response', kind: 'partial' },
  { mode: 'tenth-lost-response', kind: 'whole' },
] as const)(
  'control $mode $kind: a recreation right after the recovery read is a later incarnation',
  async ({ mode, kind }) => {
    await withHarness(async (h) => {
      const { removal } = await admitted(h, kind === 'whole' ? ['*'] : [TARGET]);
      const method = kind === 'whole' ? DELETE : PUT;
      if (mode === 'known-commit-readback-failed') {
        after(h, method, 1, async () => {
          h.kit.pds.Alice.fail(
            { nsid: GET },
            { kind: 'status', status: 500, error: 'InternalServerError', message: 'x' },
          );
        });
        await h.runUntilIdle();
      } else {
        const crashed = h.writers.crashOn(method, 'after_commit');
        void h.run();
        await crashed;
      }
      expect(apply(h, await proof(h))).toBe(kind === 'whole' ? 'absent' : 'applied');
      h.restart();
      if (mode === 'tenth-lost-response') {
        h.db.run("UPDATE operations SET state='running', attempts=10, send_state='unknown' WHERE id=?", removal.id);
      } else {
        const due = h.op(removal.id).due_at;
        if (due > h.kit.clock.nowMs()) h.kit.clock.advance(due - h.kit.clock.nowMs());
      }
      let r: Proof | undefined;
      after(h, GET, 1, async () => {
        await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
        r = await proof(h);
        apply(h, r);
      });
      const mark = h.writers.sent.length;
      await h.runUntilIdle();
      expect(r).toBeDefined();
      expect(writes(h, mark)).toBe(0);
      expect(h.op(removal.id).state).toBe('succeeded');
      expect(visible(h)).toEqual([TARGET, SIBLING]);
      expect(exported(h)).toHaveLength(2);
    });
  },
);

// ---------------------------------------------------------------------------
// Ordering and fail-closed rules of the bracket itself

it('a first absence whose head moved, then a recreation before the next read: complete without a write, R visible', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    // Removed by another writer before this removal ran (the index never saw it).
    await h.kit.externalPut('Alice', BATCH, RKEY, WITHOUT_TARGET);
    const d = h.kit.repos.Alice.head!;
    let r: Proof | undefined;
    after(h, GET, 1, async () => {
      await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
      r = await proof(h);
      apply(h, r);
    });
    await h.runUntilIdle();
    expect(writes(h)).toBe(0);
    expect(r!.commit.rev > d.rev).toBe(true);
    // The absence was read at D, but the head closing that read is R: the
    // first head read after it. Absent at some version at or below R, so R
    // (at, not below, the boundary) is a later incarnation. The re-read finds
    // the target present, so the boundary stays `after`, never D.
    expect(h.op(removal.id)).toMatchObject({
      state: 'succeeded',
      removal_reached: 'absent',
      removal_done_rev: r!.commit.rev,
      removal_done_basis: 'after',
    });
    expect(h.writers.order()).toEqual([HEAD, GET, HEAD, GET]);
    expect(visible(h)).toEqual([TARGET, SIBLING]);
  });
});

it('an unavailable head closing the bracket certifies nothing; the next ordered read does, and nothing is written', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    await h.kit.externalPut('Alice', BATCH, RKEY, WITHOUT_TARGET);
    const d = h.kit.repos.Alice.head!;
    after(h, GET, 1, async () => {
      h.kit.pds.Alice.fail({ nsid: HEAD }, { kind: 'status', status: 503, error: 'Unavailable', message: 'x' });
    });
    await h.runUntilIdle();
    // The absence is no-replay knowledge at once; the next head D is the
    // first read after it (`after` D), and the stable bracket around the
    // next read (D, absent, D) makes that exact at the same revision.
    expect(h.writers.order()).toEqual([HEAD, GET, HEAD, HEAD, GET, HEAD]);
    expect(h.writers.sent.map((r) => r.status)).toEqual([200, 200, 503, 200, 200, 200]);
    expect(writes(h)).toBe(0);
    expect(h.op(removal.id)).toMatchObject({
      state: 'succeeded',
      removal_reached: 'absent',
      removal_done_rev: d.rev,
      removal_done_basis: 'absent',
    });
  });
});

it('a head older than the persisted send fence waits without reading, writing or settling', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    h.db.run(
      "UPDATE operations SET state='running', attempts=1, send_state='unknown', send_started_at_ms=?, removal_head_rev='3zzzzzzzzzzz2' WHERE id=?",
      T0,
      removal.id,
    );
    await h.run();
    expect(h.writers.order()).toEqual([HEAD]);
    // No attempt spent (the one persisted before stays the only one).
    expect(h.op(removal.id)).toMatchObject({
      state: 'queued',
      attempts: 1,
      last_error: 'repository_head_behind_fence',
      removal_done_rev: null,
    });
    expect(visible(h)).toEqual([SIBLING]);
  });
});

it('an unavailable head after a send is a counted transient failure, never an uncounted wait', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    h.kit.pds.Alice.fail({ nsid: PUT }, { kind: 'status', status: 500, error: 'InternalServerError', message: 'x' });
    after(h, PUT, 1, async () => {
      h.kit.pds.Alice.fail({ nsid: HEAD }, { kind: 'status', status: 503, error: 'Unavailable', message: 'x' });
    });
    await h.run();
    expect(h.op(removal.id)).toMatchObject({
      state: 'queued',
      attempts: 1,
      last_error: 'repository_head_unavailable',
      removal_done_rev: null,
    });
  });
});

it('a receipt settled under migration 11 (no completion boundary) keeps its head rule', async () => {
  await withHarness(async (h) => {
    const { a, removal } = await admitted(h, [TARGET]);
    interruptedTenth(h, removal.id, a.commit.rev);
    let b: Proof | undefined;
    after(h, HEAD, 1, async () => {
      await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'B' });
      b = await proof(h);
      await h.kit.externalPut('Alice', BATCH, RKEY, WITHOUT_TARGET);
    });
    await h.runUntilIdle();
    expect(apply(h, b!)).toBe('applied');
    expect(visible(h)).toEqual([SIBLING]);
    // The same receipt as migration 11 left it: only its head H decides.
    h.db.run('UPDATE operations SET removal_done_rev = NULL, removal_done_basis = NULL WHERE id = ?', removal.id);
    expect(h.op(removal.id).removal_head_rev).toBe(a.commit.rev);
    expect(visible(h)).toEqual([TARGET, SIBLING]);
  });
});
