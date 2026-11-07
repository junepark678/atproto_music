// An unknown removal send is never replayed against a later root (migration
// 14, outbox/removal-fence.ts). These tests reproduce Astra a176da7 F1: a
// removal admitted at H whose conditional write really committed D, while the
// client saw a crash after the server answer, a lost response, a 5xx or an
// invalid success body, followed by a recreation R of the original bytes,
// must never send again at R's root: a present target there cannot tell an
// unexecuted removal from a completed one followed by a recreation. It holds
// read-only (bounded backoff, never exhausted, across restart, reauth and the
// tenth reconcile) until an absence, a verified absence or an explicit later
// intent resolves it. The exact pinned request may go again only while the
// head is still its root; a definite rejection of the original send (and only
// of it) allows a new fence; a fresh intent is admitted (web, Last.fm,
// ListenBrainz) without waiting behind the held one and supersedes it once
// its targets are covered.

import { listenKey } from '@atmusic/core/listen-key';
import { recordingMsid } from '@atmusic/core/msid';
import { expect, it } from 'vitest';
import type { OperationRow } from '../../../src/app/rows';
import { visibleScrobblesFrom } from '../../../src/do/read/visibility';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { createJob } from '../../../src/imports/jobs';
import { writeSlice } from '../../../src/imports/writer';
import { removeScrobble } from '../../../src/lastfm/write-methods';
import { admitListenDelete } from '../../../src/listenbrainz/token-routes';
import { enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { HEAD_RETRY_MS, HOLD_MAX_MS } from '../../../src/outbox/removal-fence';
import { resumeAfterSignIn } from '../../../src/outbox/runner';
import { proofAt } from '../../write/support';
import { DELETE, GET, type Harness, HEAD, listenInput, PUT, remoteRecords, SCROBBLE, T0, withHarness } from './support';

const PREFIX = 'com.example.atmusic';
const BATCH = `${PREFIX}.scrobbleBatch`;
const RKEY = '3lb2uncertab2';
const SINGLE_RKEY = '3lb2uncertsi2';
const X = '3lb2batchidab';
const Y = '3lb2batchidac';
const Z = '3lb2batchidad';
const OPTIONS = { receiptNs: BigInt(T0) * 1_000_000n, nowNs: BigInt(T0) * 1_000_000n, prefix: PREFIX };
const UNRELATED = {
  $type: SCROBBLE,
  artist: 'Unrelated',
  track: 'J',
  listenedAt: '2026-01-14T12:00:00Z',
  createdAt: '2026-01-15T12:00:00Z',
};

const entry = (id: string, track: string, hour: number) => ({
  id,
  artist: 'Uncertain Artist',
  track,
  listenedAt: `2026-01-14T1${hour}:00:00Z`,
  createdAt: '2026-01-15T12:00:00Z',
});
const ORIGINAL = {
  $type: BATCH,
  createdAt: '2026-01-15T12:00:00Z',
  listens: [entry(X, 'X', 0), entry(Y, 'Y', 1), entry(Z, 'Z', 2)],
};
const SINGLE = {
  $type: SCROBBLE,
  artist: 'Single Artist',
  track: 'Single Track',
  listenedAt: '2026-01-14T12:00:00Z',
  createdAt: '2026-01-15T12:00:00Z',
};

type Kind = 'partial' | 'whole' | 'single';
type Proof = Awaited<ReturnType<typeof proofAt>>;
const KINDS = ['partial', 'whole', 'single'] as const;

const collectionOf = (kind: Kind) => (kind === 'single' ? SCROBBLE : BATCH);
const rkeyOf = (kind: Kind) => (kind === 'single' ? SINGLE_RKEY : RKEY);
const uriOf = (h: Harness, kind: Kind) => `at://${h.alice}/${collectionOf(kind)}/${rkeyOf(kind)}`;
const methodOf = (kind: Kind) => (kind === 'partial' ? PUT : DELETE);
const bytesOf = (kind: Kind) => (kind === 'single' ? SINGLE : ORIGINAL);
const proof = (h: Harness, kind: Kind) => proofAt(h.kit.repos.Alice, collectionOf(kind), rkeyOf(kind));
const apply = (h: Harness, p: Proof) => h.db.tx(() => applyRecordProof(h.db, p, OPTIONS)).outcome;
const visible = (h: Harness) =>
  h.db
    .all<{ listen_id: string | null }>(`SELECT s.listen_id FROM ${visibleScrobblesFrom()} ORDER BY s.listen_id`)
    .map((row) => row.listen_id ?? '*');
const writes = (h: Harness, from = 0) => h.writers.sent.slice(from).filter((r) => r.nsid === PUT || r.nsid === DELETE);
const advanceTo = (h: Harness, at: number) => {
  if (at > h.kit.clock.nowMs()) h.kit.clock.advance(at - h.kit.clock.nowMs());
};
const deps = (h: Harness, id: string) => h.db.all('SELECT pred_id FROM operation_deps WHERE op_id = ?', id);
const pinned = (op: OperationRow) =>
  JSON.parse(op.removal_send_json ?? 'null') as {
    method: string;
    body: Record<string, unknown>;
    head: { cid: string; rev: string };
  } | null;

/** The listen ids (or `*` for a single record) present on the owner's PDS at the key. */
async function remoteTargets(h: Harness, kind: Kind): Promise<string[]> {
  const found = (await remoteRecords(h.kit, 'Alice', collectionOf(kind))).find((r) => r.rkey === rkeyOf(kind));
  if (found === undefined) return [];
  if (kind === 'single') return ['*'];
  return (found.value as { listens: Array<{ id: string }> }).listens.map((l) => l.id);
}

/** The projected record A and an admitted removal (partial: X and Y of X, Y, Z). */
async function admit(h: Harness, kind: Kind) {
  h.seedUser(h.alice);
  await h.kit.externalPut('Alice', collectionOf(kind), rkeyOf(kind), bytesOf(kind));
  const a = await proof(h, kind);
  expect(apply(h, a)).toBe('applied');
  const removal = intent(h, kind);
  h.db.run('DELETE FROM hints');
  return { a, removal };
}

/** An explicit web removal intent of the kind's targets. */
function intent(h: Harness, kind: Kind, listenIds?: string[]): OperationRow {
  return kind === 'single'
    ? enqueueScrobbleDelete(h.m, { did: h.alice, uri: uriOf(h, kind), origin: 'web' })
    : enqueueBatchListenDelete(h.m, {
        did: h.alice,
        uri: uriOf(h, kind),
        listenIds: listenIds ?? (kind === 'whole' ? ['*'] : [X, Y]),
        origin: 'web',
      });
}

/**
 * The first request for `nsid` goes through `during(forward)`: `forward`
 * performs the real request (the PDS answers it), and whatever `during`
 * returns or throws is what the client sees.
 */
function intercept(h: Harness, nsid: string, during: (forward: () => Promise<Response>) => Promise<Response>): void {
  const writerFor = h.writers.writerFor.bind(h.writers);
  let once = false;
  h.writers.writerFor = async (did: string) => {
    const writer = await writerFor(did);
    if (writer === null) return null;
    return {
      ...writer,
      fetchHandler: async (path: string, init?: RequestInit) => {
        if (!once && path.includes(`/xrpc/${nsid}`)) {
          once = true;
          return during(() => writer.fetchHandler(path, init));
        }
        return writer.fetchHandler(path, init);
      },
    };
  };
}

/** After the `nth` answered request for `nsid`, run `during` before the client sees the answer. */
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

type Mode = 'crash' | 'lost' | 'invalid' | 'server-error';

/**
 * The removal's conditional write really commits D, the client never learns
 * it (mode), and R recreates the original bytes, verified, before the client
 * continues. Returns the proofs and the receipt as persisted then.
 */
async function ambiguousThenRecreated(h: Harness, kind: Kind, mode: Mode) {
  const { a, removal } = await admit(h, kind);
  let d: Proof | undefined;
  let r: Proof | undefined;
  const recreate = async () => {
    d = await proof(h, kind);
    await h.kit.externalPut('Alice', collectionOf(kind), rkeyOf(kind), bytesOf(kind));
    r = await proof(h, kind);
    expect(apply(h, r)).toBe('applied');
  };
  if (mode === 'crash') {
    const crashed = h.writers.crashOn(methodOf(kind), 'after_commit');
    void h.run();
    await crashed;
    await recreate();
  } else {
    intercept(h, methodOf(kind), async (forward) => {
      const answer = await forward();
      expect(answer.status).toBe(200);
      await recreate();
      if (mode === 'lost') throw new TypeError('connection reset after the server committed');
      if (mode === 'invalid') return Response.json([]);
      return Response.json({ error: 'InternalServerError', message: 'after commit' }, { status: 500 });
    });
    await h.runUntilIdle(10);
  }
  // D really happened at the very next commit after H.
  expect(d!.state === 'absent' || kind === 'partial').toBe(true);
  expect(d!.commit.rev > a.commit.rev).toBe(true);
  return { a, d: d!, r: r!, removal, persisted: h.op(removal.id) };
}

/** Restart, then run each due poll; returns the polls. */
async function poll(h: Harness, id: string, times: number) {
  const polls: Array<{ state: string; attempts: number; delay: number; code: string | null }> = [];
  for (let i = 0; i < times; i++) {
    advanceTo(h, h.op(id).due_at);
    await h.runUntilIdle(10);
    const row = h.op(id);
    polls.push({
      state: row.state,
      attempts: row.attempts,
      delay: row.due_at - h.kit.clock.nowMs(),
      code: row.last_error,
    });
  }
  return polls;
}

it.each(
  (['crash', 'lost', 'invalid', 'server-error'] as const).flatMap((mode) => KINDS.map((kind) => ({ mode, kind }))),
)(
  'F1 $kind, $mode after the PDS committed, then a verified recreation: never sent again at the later root; a fresh intent resolves it',
  async ({ mode, kind }) => {
    await withHarness(async (h) => {
      const { a, r, removal, persisted } = await ambiguousThenRecreated(h, kind, mode);
      // The exact request and its fence were durable before the send.
      const pin = pinned(persisted);
      expect(persisted).toMatchObject({ removal_send_state: 'pending', removal_reached: null, removal_done_rev: null });
      expect(persisted.removal_head_rev).toBe(a.commit.rev);
      expect(pin).toMatchObject({
        method: methodOf(kind),
        head: { cid: a.commit.cid, rev: a.commit.rev },
        body: { swapCommit: a.commit.cid, swapRecord: a.cid },
      });
      if (kind === 'partial') {
        expect((pin!.body.record as { listens: Array<{ id: string }> }).listens.map((l) => l.id)).toEqual([Z]);
      }

      h.restart();
      const mark = h.writers.sent.length;
      advanceTo(h, h.op(removal.id).due_at);
      await h.runUntilIdle(10);
      // Read-only: a head and a container read, never a write at R's root.
      expect(writes(h, mark)).toEqual([]);
      expect(h.op(removal.id)).toMatchObject({
        state: 'queued',
        last_error: 'removal_send_uncertain',
        removal_send_state: 'pending',
        removal_reached: null,
        removal_done_rev: null,
        attempts: 1,
      });
      // The pin is unchanged: never replaced by a newer fence.
      expect(h.op(removal.id).removal_send_json).toBe(persisted.removal_send_json);
      expect(h.op(removal.id).removal_head_rev).toBe(a.commit.rev);
      expect(await remoteTargets(h, kind)).toEqual(kind === 'single' ? ['*'] : [X, Y, Z]);
      // Its pending overlay still hides every target.
      expect(visible(h)).toEqual(kind === 'partial' ? [Z] : []);

      // Bounded backoff, no attempt spent by the hold, no exhaustion; a
      // reauth/unblock and the read-only tenth reconcile change nothing.
      const polls = await poll(h, removal.id, 10);
      expect(polls.every((p) => p.state === 'queued' && p.attempts === 1 && p.code === 'removal_send_uncertain')).toBe(
        true,
      );
      expect(polls.every((p) => p.delay >= HEAD_RETRY_MS && p.delay <= HOLD_MAX_MS)).toBe(true);
      expect(polls.at(-1)!.delay).toBe(HOLD_MAX_MS);
      resumeAfterSignIn(h.m, h.alice);
      h.db.run('UPDATE operations SET attempts = 10 WHERE id = ?', removal.id);
      h.restart();
      const tenth = await poll(h, removal.id, 2);
      expect(tenth.every((p) => p.state === 'queued' && p.attempts === 10 && p.code === 'removal_send_uncertain')).toBe(
        true,
      );
      expect(writes(h, mark)).toEqual([]);

      // An explicit later intent is admitted on its own (never behind the
      // held one), supersedes it, and alone removes R: one write.
      const fresh = intent(h, kind);
      expect(deps(h, fresh.id)).toEqual([]);
      expect(h.op(removal.id)).toMatchObject({
        state: 'cancelled',
        last_error: 'removal_superseded',
        removal_superseded_by: fresh.id,
      });
      const before = h.writers.sent.length;
      await h.runUntilIdle(10);
      // Fenced by R's root, the current head: the user's own later intent.
      expect(writes(h, before).map((w) => [w.nsid, w.body?.swapCommit])).toEqual([[methodOf(kind), r.commit.cid]]);
      expect(h.op(fresh.id)).toMatchObject({ state: 'succeeded', removal_done_basis: 'commit' });
      expect(await remoteTargets(h, kind)).toEqual(kind === 'partial' ? [Z] : []);
      // The superseded intent never runs again.
      await poll(h, fresh.id, 1);
      expect(h.op(removal.id).state).toBe('cancelled');
      expect(writes(h, before)).toHaveLength(1);
    });
  },
);

it.each(KINDS)(
  '%s: an unknown send while the head is still its root re-sends exactly the pinned request; a late original then commits nothing',
  async (kind) => {
    await withHarness(async (h) => {
      const { a, removal } = await admit(h, kind);
      // The request is accepted beyond the client's abort: held, then
      // delivered to the PDS late.
      let late: (() => Promise<Response>) | undefined;
      intercept(h, methodOf(kind), async (forward) => {
        late = forward;
        throw new DOMException('the client gave up', 'AbortError');
      });
      await h.runUntilIdle(10);
      const persisted = h.op(removal.id);
      expect(persisted).toMatchObject({ state: 'queued', removal_send_state: 'pending', attempts: 1 });
      // The read-back found the head still at H: nothing committed, retry.
      expect(h.kit.repos.Alice.head!.rev).toBe(a.commit.rev);

      h.restart();
      const mark = h.writers.sent.length;
      advanceTo(h, h.op(removal.id).due_at);
      await h.runUntilIdle(10);
      const resent = writes(h, mark);
      expect(resent).toHaveLength(1);
      expect(resent[0]!.body).toEqual(pinned(persisted)!.body);
      expect(h.op(removal.id)).toMatchObject({ state: 'succeeded', removal_reached: 'commit', attempts: 2 });
      expect(await remoteTargets(h, kind)).toEqual(kind === 'partial' ? [Z] : []);
      // The original finally reaches the PDS: one CAS on H, it can no longer
      // commit (the reference PDS answers the now-satisfied request with its
      // no-op, which commits nothing).
      const head = h.kit.repos.Alice.head!.rev;
      const answer = await late!();
      expect((await answer.json()) as Record<string, unknown>).not.toHaveProperty('commit');
      expect(h.kit.repos.Alice.head!.rev).toBe(head);
      expect(await remoteTargets(h, kind)).toEqual(kind === 'partial' ? [Z] : []);
    });
  },
);

it.each(KINDS)(
  '%s: a late original that commits before the retry leaves only an absence to read: nothing is sent again',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal } = await admit(h, kind);
      let late: (() => Promise<Response>) | undefined;
      intercept(h, methodOf(kind), async (forward) => {
        late = forward;
        throw new TypeError('request timed out');
      });
      await h.runUntilIdle(10);
      expect((await late!()).status).toBe(200);
      h.restart();
      const mark = h.writers.sent.length;
      advanceTo(h, h.op(removal.id).due_at);
      await h.runUntilIdle(10);
      expect(writes(h, mark)).toEqual([]);
      // The targets are absent (the put kept Z): reached and ordered by a read.
      expect(h.op(removal.id)).toMatchObject({ state: 'succeeded', removal_reached: 'absent' });
      expect(await remoteTargets(h, kind)).toEqual(kind === 'partial' ? [Z] : []);
    });
  },
);

it.each(KINDS)(
  '%s: a definite rejection of the original send (InvalidSwap, then 401) allows a new fence; the second send completes',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal } = await admit(h, kind);
      // An unrelated commit after the head read: the CAS refuses (400).
      after(h, HEAD, 1, async () => {
        await h.kit.externalPut('Alice', SCROBBLE, '3lb2unrelate2', UNRELATED);
      });
      // The next send is refused with a sign-in failure (401): also definite.
      after(h, methodOf(kind), 1, async () => {
        h.kit.pds.Alice.fail(
          { nsid: methodOf(kind) },
          { kind: 'status', status: 401, error: 'ExpiredToken', message: 'expired' },
          1,
        );
      });
      await h.runUntilIdle(10);
      // InvalidSwap retried at once at a fresh head; that send's 401 blocks.
      // Both refusals were of the pinned send itself: rejected, not pending.
      expect(h.op(removal.id)).toMatchObject({ state: 'blocked', removal_send_state: 'rejected', attempts: 0 });
      const statuses = h.writers.sent.filter((s) => s.nsid === methodOf(kind)).map((s) => s.status);
      expect(statuses).toEqual([400, 401]);
      await h.kit.externalPut('Alice', SCROBBLE, '3lb2unrelate3', UNRELATED);
      const newest = { cid: h.kit.repos.Alice.head!.cid, rev: h.kit.repos.Alice.head!.rev };
      resumeAfterSignIn(h.m, h.alice);
      const mark = h.writers.sent.length;
      await h.runUntilIdle(10);
      // A new fence at the newest head (the refused sends changed nothing).
      expect(writes(h, mark)).toHaveLength(1);
      expect(writes(h, mark)[0]!.body?.swapCommit).toBe(newest.cid);
      expect(h.op(removal.id).removal_head_rev).toBe(newest.rev);
      expect(h.op(removal.id)).toMatchObject({ state: 'succeeded', removal_done_basis: 'commit' });
      expect(await remoteTargets(h, kind)).toEqual(kind === 'partial' ? [Z] : []);
    });
  },
);

it.each(KINDS)(
  '%s: a definite rejection of a later re-send proves nothing about the unknown original: it holds',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal } = await admit(h, kind);
      // The original is answered 500 without reaching the repository (the
      // client cannot tell): unknown.
      intercept(h, methodOf(kind), async () =>
        Response.json({ error: 'InternalServerError', message: 'unknown' }, { status: 500 }),
      );
      await h.runUntilIdle(10);
      expect(h.op(removal.id)).toMatchObject({ state: 'queued', removal_send_state: 'pending' });
      const first = h.op(removal.id).removal_send_json;
      // The exact re-send meets an unrelated commit after its head read: 400.
      let reads = 0;
      after(h, GET, 1, async () => {
        reads += 1;
        await h.kit.externalPut('Alice', SCROBBLE, '3lb2unrelate2', UNRELATED);
      });
      const mark = h.writers.sent.length;
      advanceTo(h, h.op(removal.id).due_at);
      await h.runUntilIdle(10);
      expect(reads).toBe(1);
      expect(writes(h, mark).map((w) => w.status)).toEqual([400]);
      expect(writes(h, mark)[0]!.body).toEqual(JSON.parse(first!).body);
      // Still pending, the same pin: the head moved past it, so it holds.
      expect(h.op(removal.id)).toMatchObject({
        state: 'queued',
        removal_send_state: 'pending',
        removal_send_json: first,
        last_error: 'removal_send_uncertain',
      });
      await poll(h, removal.id, 3);
      expect(writes(h, mark)).toHaveLength(1);
    });
  },
);

it('partial: a fresh intent covering only X does not supersede the held removal of X and Y; covering Y too does', async () => {
  await withHarness(async (h) => {
    const { removal } = await ambiguousThenRecreated(h, 'partial', 'lost');
    const freshX = intent(h, 'partial', [X]);
    expect(deps(h, freshX.id)).toEqual([]);
    expect(h.op(removal.id).state).toBe('queued');
    let mark = h.writers.sent.length;
    await h.runUntilIdle(10);
    expect(writes(h, mark)).toHaveLength(1);
    expect(h.op(freshX.id).state).toBe('succeeded');
    expect(await remoteTargets(h, 'partial')).toEqual([Y, Z]);
    // The held removal never writes; its remaining target Y stays hidden.
    mark = h.writers.sent.length;
    await poll(h, removal.id, 2);
    expect(writes(h, mark)).toEqual([]);
    expect(h.op(removal.id)).toMatchObject({ state: 'queued', last_error: 'removal_send_uncertain' });
    expect(visible(h)).toEqual([Z]);
    const freshY = intent(h, 'partial', [Y]);
    expect(h.op(removal.id)).toMatchObject({ state: 'cancelled', removal_superseded_by: freshY.id });
    await h.runUntilIdle(10);
    expect(h.op(freshY.id).state).toBe('succeeded');
    expect(await remoteTargets(h, 'partial')).toEqual([Z]);
    expect(writes(h, mark)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fresh intent through the protocol admission paths

it.each(KINDS)(
  '%s via Last.fm library.removeScrobble: absorbed while nothing newer than the fence is verified; admitted once R is',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal } = await admit(h, kind);
      intercept(h, methodOf(kind), async (forward) => {
        await forward();
        await h.kit.externalPut('Alice', collectionOf(kind), rkeyOf(kind), bytesOf(kind));
        throw new TypeError('connection reset after the server committed');
      });
      await h.runUntilIdle(10);
      advanceTo(h, h.op(removal.id).due_at);
      await h.runUntilIdle(10);
      expect(h.op(removal.id)).toMatchObject({ state: 'queued', last_error: 'removal_send_uncertain' });
      const lastfm = () =>
        removeScrobble(h.m, {
          did: h.alice,
          artist: kind === 'single' ? 'Single Artist' : 'Uncertain Artist',
          track: kind === 'single' ? 'Single Track' : 'X',
          timestamp: Date.parse('2026-01-14T10:00:00Z') / 1000 + (kind === 'single' ? 7200 : 0),
        });
      // R is not verified yet: the projection is still H's. A repeat.
      const repeated = await lastfm();
      expect(repeated).toEqual([expect.objectContaining({ kind: 'delete_pending', deleteId: removal.id })]);
      expect(h.ops("kind = 'scrobble.delete'")).toHaveLength(1);
      // R verified: provably newer than the fence. A fresh intent.
      expect(apply(h, await proof(h, kind))).toBe('applied');
      const admitted = await lastfm();
      expect(admitted).toEqual([expect.objectContaining({ kind: 'delete_indexed' })]);
      const freshId = (admitted[0] as { deleteId: string }).deleteId;
      expect(deps(h, freshId)).toEqual([]);
      // A Last.fm removal names one listen: it covers the held single, not
      // the held X and Y, nor the held whole container.
      expect(h.op(removal.id).state).toBe(kind === 'single' ? 'cancelled' : 'queued');
      // A repeat now joins the fresh intent.
      expect(await lastfm()).toEqual([expect.objectContaining({ kind: 'delete_pending', deleteId: freshId })]);
      const mark = h.writers.sent.length;
      await h.runUntilIdle(10);
      expect(writes(h, mark)).toHaveLength(1);
      expect(h.op(freshId).state).toBe('succeeded');
      expect(await remoteTargets(h, kind)).toEqual(kind === 'single' ? [] : [Y, Z]);
    });
  },
);

it('ListenBrainz delete-listen of an own batch listen: absorbed until a newer verified incarnation, then a fresh intent', async () => {
  await withHarness(async (h) => {
    // The container is our own import batch (a succeeded create receipt).
    h.seedUser(h.alice);
    createJob(h.db, { id: 'job', did: h.alice, source: 'lastfm_json', remoteUser: null, now: T0 });
    h.db.run("UPDATE import_jobs SET state='writing' WHERE id='job'");
    for (let i = 0; i < 2; i++) {
      const input = listenInput(i);
      const key = await listenKey({
        did: h.alice,
        listenedAtNs: BigInt(Date.parse(input.listenedAt)) * 1_000_000n,
        artist: input.artist,
        track: input.track,
      });
      h.db.run(
        "INSERT INTO import_items(job_id,seq,dedupe_key,listened_at,record_json,state) VALUES ('job',?,?,?,?,'staged')",
        i,
        key,
        input.listenedAt.replace('.000Z', '.000000000Z'),
        JSON.stringify({ kind: 'listen', input }),
      );
    }
    await writeSlice(h.m, { id: 'job', did: h.alice }, T0);
    await h.runUntilIdle(10);
    const create = h.ops("kind = 'scrobble.create'")[0]!;
    expect(create.state).toBe('succeeded');
    const record = JSON.parse(create.record_json!) as { listens: Array<{ id: string; listenedAt: string }> };
    const uri = `at://${h.alice}/${BATCH}/${create.rkey}`;
    const target = record.listens[0]!;
    const original = (await remoteRecords(h.kit, 'Alice', BATCH)).find((r) => r.rkey === create.rkey)!.value;
    expect(apply(h, await proofAt(h.kit.repos.Alice, BATCH, create.rkey!))).toBe('applied');
    const removal = enqueueBatchListenDelete(h.m, { did: h.alice, uri, listenIds: [target.id], origin: 'web' });
    intercept(h, PUT, async (forward) => {
      await forward();
      await h.kit.externalPut('Alice', BATCH, create.rkey!, original);
      throw new TypeError('connection reset after the server committed');
    });
    await h.runUntilIdle(10);
    expect(h.op(removal.id)).toMatchObject({ state: 'queued', last_error: 'removal_send_uncertain' });
    const input = listenInput(0);
    // POST /1/delete-listen's admission, through the real MSID matcher.
    const msid = await recordingMsid(input.artist, input.track);
    const lb = () =>
      admitListenDelete(h.m, h.alice, BigInt(Math.floor(Date.parse(target.listenedAt) / 1000)), msid, () => {});
    await lb();
    expect(h.ops("kind = 'scrobble.delete'")).toHaveLength(1);
    expect(apply(h, await proofAt(h.kit.repos.Alice, BATCH, create.rkey!))).toBe('applied');
    await lb();
    const deletes = h.ops("kind = 'scrobble.delete'");
    expect(deletes).toHaveLength(2);
    const fresh = deletes.find((d) => d.id !== removal.id)!;
    expect(deps(h, fresh.id)).not.toContainEqual({ pred_id: removal.id });
    expect(h.op(removal.id)).toMatchObject({ state: 'cancelled', removal_superseded_by: fresh.id });
    const mark = h.writers.sent.length;
    await h.runUntilIdle(10);
    expect(writes(h, mark)).toHaveLength(1);
    expect(h.op(fresh.id).state).toBe('succeeded');
    const remaining = (await remoteRecords(h.kit, 'Alice', BATCH)).find((r) => r.rkey === create.rkey)!;
    expect((remaining.value as { listens: Array<{ id: string }> }).listens.map((l) => l.id)).toEqual([
      record.listens[1]!.id,
    ]);
  });
});

it.each(KINDS)(
  '%s: a send fenced before migration 14 (a fence, no send state) holds once the head moved; at its own root it may send',
  async (kind) => {
    await withHarness(async (h) => {
      const { a, removal } = await admit(h, kind);
      // As a pre-migration-14 attempt left it: the send fence at H, the
      // outcome unknown, nothing pinned.
      h.db.run(
        "UPDATE operations SET removal_head_rev = ?, attempts = 1, last_error = 'upstream_unavailable' WHERE id = ?",
        a.commit.rev,
        removal.id,
      );
      expect(h.op(removal.id).removal_send_state).toBeNull();
      // Still at H: the earlier send did not happen; the next one is pinned.
      const mark = h.writers.sent.length;
      await h.runUntilIdle(10);
      expect(writes(h, mark)).toHaveLength(1);
      expect(h.op(removal.id)).toMatchObject({ state: 'succeeded', removal_send_state: 'pending' });
    });
    await withHarness(async (h) => {
      const { a, removal } = await admit(h, kind);
      h.db.run(
        "UPDATE operations SET removal_head_rev = ?, attempts = 1, last_error = 'upstream_unavailable' WHERE id = ?",
        a.commit.rev,
        removal.id,
      );
      // That send committed D, and R recreated the original bytes (verified).
      if (kind === 'partial')
        await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, listens: [ORIGINAL.listens[2]] });
      else await h.kit.externalDelete('Alice', collectionOf(kind), rkeyOf(kind));
      await h.kit.externalPut('Alice', collectionOf(kind), rkeyOf(kind), bytesOf(kind));
      expect(apply(h, await proof(h, kind))).toBe('applied');
      const mark = h.writers.sent.length;
      await h.runUntilIdle(10);
      const polls = await poll(h, removal.id, 3);
      expect(writes(h, mark)).toEqual([]);
      expect(polls.every((p) => p.state === 'queued' && p.code === 'removal_send_uncertain')).toBe(true);
    });
  },
);
