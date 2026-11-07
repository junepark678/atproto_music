// Acceptance hardening of unknown removal sends (Astra de5abe1 F1, F3, F4,
// F6, F7; outbox/removal-fence.ts). Each case fails at de5abe1:
// - F1: a late ORIGINAL accepted at H arriving between a retry's head read
//   (H) and its record read (a recreation R) is not an observation at H: a
//   CID mismatch there never rejects the original. Only the same head read
//   again (a stable bracket) does.
// - F3: a read that cannot finish, a malformed value, or a still-present
//   target at the original root during the read-only tenth reconcile holds
//   (bounded, resumable, supersedable), never fails terminally.
// - F4: an existing (and transitive) dependency on a removal that holds
//   read-only never strands a later removal.
// - F6: a parseable but invalid pin is never sent and never re-pinned.
// - F7: a running executor superseded while its head or record read is
//   suspended never sends afterwards; its stale settlement changes nothing.

import { expect, it } from 'vitest';
import type { OperationRow } from '../../../src/app/rows';
import { visibleScrobblesFrom } from '../../../src/do/read/visibility';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { blockOperations } from '../../../src/outbox/operations';
import { HEAD_RETRY_MS, HOLD_MAX_MS } from '../../../src/outbox/removal-fence';
import { resumeAfterSignIn } from '../../../src/outbox/runner';
import { proofAt } from '../../write/support';
import { DELETE, GET, type Harness, HEAD, PUT, remoteRecords, SCROBBLE, T0, withHarness } from './support';

const PREFIX = 'com.example.atmusic';
const BATCH = `${PREFIX}.scrobbleBatch`;
const RKEY = '3lb2hardenbb2';
const SINGLE_RKEY = '3lb2hardensi2';
const X = '3lb2batchidab';
const Y = '3lb2batchidac';
const Z = '3lb2batchidad';
const OPTIONS = { receiptNs: BigInt(T0) * 1_000_000n, nowNs: BigInt(T0) * 1_000_000n, prefix: PREFIX };
const UNCERTAIN = 'removal_send_uncertain';
const UNRESOLVED = 'removal_send_unresolved';

const entry = (id: string, track: string, hour: number) => ({
  id,
  artist: 'Hardening Artist',
  track,
  listenedAt: `2026-01-14T1${hour}:00:00Z`,
  createdAt: '2026-01-15T12:00:00Z',
});
// An unknown field at the top and in an entry: the owner's bytes, kept.
const ORIGINAL = {
  $type: BATCH,
  createdAt: '2026-01-15T12:00:00Z',
  listens: [entry(X, 'X', 0), entry(Y, 'Y', 1), { ...entry(Z, 'Z', 2), unknownEntryField: { kept: [1, 2] } }],
  unknownTopField: 'kept',
};
const SINGLE = {
  $type: SCROBBLE,
  artist: 'Single Artist',
  track: 'Single Track',
  listenedAt: '2026-01-14T12:00:00Z',
  createdAt: '2026-01-15T12:00:00Z',
};
const UNRELATED = { ...SINGLE, artist: 'Unrelated', track: 'J' };

type Kind = 'partial' | 'whole' | 'single';
const KINDS = ['partial', 'whole', 'single'] as const;
type Pin = { method: string; body: Record<string, unknown>; head: Record<string, unknown> };

const collectionOf = (kind: Kind) => (kind === 'single' ? SCROBBLE : BATCH);
const rkeyOf = (kind: Kind) => (kind === 'single' ? SINGLE_RKEY : RKEY);
const uriOf = (h: Harness, kind: Kind) => `at://${h.alice}/${collectionOf(kind)}/${rkeyOf(kind)}`;
const methodOf = (kind: Kind) => (kind === 'partial' ? PUT : DELETE);
const bytesOf = (kind: Kind): Record<string, unknown> => (kind === 'single' ? SINGLE : ORIGINAL);
const proof = (h: Harness, kind: Kind) => proofAt(h.kit.repos.Alice, collectionOf(kind), rkeyOf(kind));
const apply = (h: Harness, p: Awaited<ReturnType<typeof proofAt>>) =>
  h.db.tx(() => applyRecordProof(h.db, p, OPTIONS)).outcome;
const visible = (h: Harness) =>
  h.db
    .all<{ listen_id: string | null }>(`SELECT s.listen_id FROM ${visibleScrobblesFrom()} ORDER BY s.listen_id`)
    .map((row) => row.listen_id ?? '*');
const writes = (h: Harness, from = 0) => h.writers.sent.slice(from).filter((r) => r.method === 'POST');
const advanceTo = (h: Harness, at: number) => {
  if (at > h.kit.clock.nowMs()) h.kit.clock.advance(at - h.kit.clock.nowMs());
};
const pinOf = (op: OperationRow) => JSON.parse(op.removal_send_json ?? 'null') as Pin;
const head = (h: Harness) => ({ cid: h.kit.repos.Alice.head!.cid, rev: h.kit.repos.Alice.head!.rev });

/** The listen ids (or `*` for a single record) present on the owner's PDS at the key. */
async function remoteTargets(h: Harness, kind: Kind): Promise<string[]> {
  const found = (await remoteRecords(h.kit, 'Alice', collectionOf(kind))).find((r) => r.rkey === rkeyOf(kind));
  if (found === undefined) return [];
  if (kind === 'single') return ['*'];
  return (found.value as { listens: Array<{ id: string }> }).listens.map((l) => l.id);
}

/** An explicit web removal intent of the kind's targets (partial: X and Y). */
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

/** The projected record A and an admitted removal of it. */
async function admit(h: Harness, kind: Kind) {
  h.seedUser(h.alice);
  await h.kit.externalPut('Alice', collectionOf(kind), rkeyOf(kind), bytesOf(kind));
  const a = await proof(h, kind);
  expect(apply(h, a)).toBe('applied');
  const removal = intent(h, kind);
  h.db.run('DELETE FROM hints');
  return { a, removal };
}

type Forward = () => Promise<Response>;
/** Wraps every later request: `on(nsid, forward)` decides what the client sees. */
function wrap(h: Harness, on: (nsid: string, forward: Forward, init?: RequestInit) => Promise<Response>): void {
  const writerFor = h.writers.writerFor.bind(h.writers);
  h.writers.writerFor = async (did: string) => {
    const writer = await writerFor(did);
    if (writer === null) return null;
    return {
      ...writer,
      fetchHandler: (path: string, init?: RequestInit) => {
        const nsid = path.replace(/^\/xrpc\//, '').split('?')[0]!;
        return on(nsid, () => writer.fetchHandler(path, init), init);
      },
    };
  };
}

/** After the `nth` answered request for `nsid`, run `during` before the client sees the answer. */
function after(h: Harness, nsid: string, nth: number, during: () => Promise<void>): void {
  let seen = 0;
  wrap(h, async (name, forward) => {
    const response = await forward();
    if (name === nsid && ++seen === nth) await during();
    return response;
  });
}

/**
 * The first send of the removal never reaches the PDS in time: the client
 * gives up (a pin is durable, the head is still H). `late` delivers that very
 * request later. With `commitThenRecreate`, the request is delivered at once
 * and R recreates the original bytes before the client sees a lost answer.
 */
async function unknownSend(h: Harness, kind: Kind, commitThenRecreate = false) {
  const { a, removal } = await admit(h, kind);
  let late: Forward | undefined;
  let once = false;
  wrap(h, async (nsid, forward) => {
    if (once || nsid !== methodOf(kind)) return forward();
    once = true;
    if (commitThenRecreate) {
      expect((await forward()).status).toBe(200);
      await h.kit.externalPut('Alice', collectionOf(kind), rkeyOf(kind), bytesOf(kind));
      throw new TypeError('connection reset after the server committed');
    }
    late = forward;
    throw new TypeError('the request timed out');
  });
  await h.runUntilIdle(10);
  const persisted = h.op(removal.id);
  expect(persisted).toMatchObject({ state: 'queued', removal_send_state: 'pending', removal_reached: null });
  return { a, removal, persisted, late: () => late!() };
}

/** Restart, then run each due poll; returns the polls. */
async function poll(h: Harness, id: string, times: number) {
  const polls: Array<{ state: string; attempts: number; delay: number; code: string | null }> = [];
  for (let i = 0; i < times; i++) {
    h.restart();
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

/** A later explicit intent supersedes the held removal and alone completes the requested state. */
async function freshResolves(h: Harness, kind: Kind, held: string) {
  const fresh = intent(h, kind);
  expect(h.op(held)).toMatchObject({
    state: 'cancelled',
    last_error: 'removal_superseded',
    removal_superseded_by: fresh.id,
  });
  const mark = h.writers.sent.length;
  // Ordinary retries (a stale indexed swapRecord is refused and re-read).
  for (let i = 0; i < 3 && h.op(fresh.id).state !== 'succeeded'; i++) {
    advanceTo(h, h.op(fresh.id).due_at);
    await h.runUntilIdle(10);
  }
  expect(h.op(fresh.id).state).toBe('succeeded');
  expect(await remoteTargets(h, kind)).toEqual(kind === 'partial' ? [Z] : []);
  expect(h.op(held).state).toBe('cancelled');
  return { fresh, writes: writes(h, mark) };
}

// ---------------------------------------------------------------------------
// F1: the late original between the retry's head read and its record read

it.each(KINDS.flatMap((kind) => (['changed', 'identical'] as const).map((cid) => ({ kind, cid }))))(
  'F1 $kind, $cid CID: the late original commits between the retry head (H) and record read; nothing is sent at R',
  async ({ kind, cid }) => {
    await withHarness(async (h) => {
      const { a, removal, persisted, late } = await unknownSend(h, kind);
      const pin = persisted.removal_send_json;
      const recreated = cid === 'changed' ? { ...bytesOf(kind), recreatedField: 'other CID' } : bytesOf(kind);
      let r: { cid: string; rev: string } | undefined;
      // The retry's head read answers H; only then does the original arrive.
      after(h, HEAD, 1, async () => {
        expect((await late()).status).toBe(200);
        await h.kit.externalPut('Alice', collectionOf(kind), rkeyOf(kind), recreated);
        r = head(h);
      });
      h.restart();
      advanceTo(h, h.op(removal.id).due_at);
      const mark = h.writers.sent.length;
      await h.runUntilIdle(10);
      const sent = writes(h, mark);
      // The first write after the mark is the late original itself (at H).
      expect(sent[0]).toMatchObject({ nsid: methodOf(kind), status: 200, body: pinOf(persisted).body });
      expect(sent[0]!.body?.swapCommit).toBe(a.commit.cid);
      // Changed CID: no write at all. Identical CID: only the exact pinned
      // request, refused by its own CAS (the head is R): a later send's
      // refusal says nothing about the original.
      if (cid === 'changed') expect(sent.slice(1)).toEqual([]);
      else expect(sent.slice(1).map((w) => [w.status, w.body])).toEqual([[400, pinOf(persisted).body]]);
      expect(h.op(removal.id)).toMatchObject({
        state: 'queued',
        last_error: UNCERTAIN,
        removal_send_state: 'pending',
        removal_send_json: pin,
        removal_head_rev: a.commit.rev,
        removal_reached: null,
        removal_done_rev: null,
      });
      expect(await remoteTargets(h, kind)).toEqual(kind === 'single' ? ['*'] : [X, Y, Z]);
      // Restarts and polls: still nothing sent at R.
      const before = h.writers.sent.length;
      const polls = await poll(h, removal.id, 3);
      expect(writes(h, before)).toEqual([]);
      expect(polls.every((p) => p.state === 'queued' && p.code === UNCERTAIN)).toBe(true);
      expect(polls.every((p) => p.delay >= HEAD_RETRY_MS && p.delay <= HOLD_MAX_MS)).toBe(true);
      expect(h.op(removal.id).removal_send_json).toBe(pin);
      // The user's own later intent is fenced by R's root.
      const fresh = await freshResolves(h, kind, removal.id);
      // (A single delete first tries the indexed, now stale, swapRecord: the
      // CAS refuses it and it re-reads; every send is at R's root.)
      expect(new Set(fresh.writes.map((w) => w.body?.swapCommit))).toEqual(new Set([r!.cid]));
      expect(fresh.writes.at(-1)!.status).toBe(200);
    });
  },
);

it.each(KINDS)(
  'F1 %s control: a CID mismatch inside a stable bracket at the root proves the pinned request impossible; a new fenced send follows',
  async (kind) => {
    await withHarness(async (h) => {
      const { a, removal, persisted } = await unknownSend(h, kind);
      // A valid pin whose swapRecord is not the record at its own root.
      const pin = pinOf(persisted);
      const other = (await proofAt(h.kit.repos.Alice, collectionOf(kind), rkeyOf(kind))) as { cid: string };
      const impossible = {
        ...pin,
        body: { ...pin.body, swapRecord: other.cid.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) },
      };
      h.db.run('UPDATE operations SET removal_send_json = ? WHERE id = ?', JSON.stringify(impossible), removal.id);
      // First retry: the closing head read is unavailable, so nothing is
      // known: it holds (root may be current), sends nothing, keeps the pin.
      let heads = 0;
      wrap(h, async (nsid, forward) => {
        if (nsid === HEAD && ++heads === 2) return Response.json({ error: 'Unavailable' }, { status: 503 });
        return forward();
      });
      const mark = h.writers.sent.length;
      await poll(h, removal.id, 1);
      expect(writes(h, mark)).toEqual([]);
      expect(h.op(removal.id)).toMatchObject({
        state: 'queued',
        last_error: UNRESOLVED,
        removal_send_state: 'pending',
        removal_send_json: JSON.stringify(impossible),
      });
      // Next retry: head H, the record read, head H again: rejected, then
      // one new send fenced by H with the CID actually read.
      await poll(h, removal.id, 1);
      const sent = writes(h, mark);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toMatchObject({ swapCommit: a.commit.cid, swapRecord: other.cid });
      expect(h.op(removal.id)).toMatchObject({ state: 'succeeded', removal_done_basis: 'commit' });
      expect(await remoteTargets(h, kind)).toEqual(kind === 'partial' ? [Z] : []);
    });
  },
);

// ---------------------------------------------------------------------------
// F3: read failures and the read-only tenth reconcile of an unknown send

it.each((['unavailable', 'malformed', 'same-root'] as const).flatMap((mode) => KINDS.map((kind) => ({ mode, kind }))))(
  'F3 $kind, tenth reconcile, $mode read: holds bounded and read-only; restart, reauth and supersession',
  async ({ mode, kind }) => {
    await withHarness(async (h) => {
      const { removal, persisted } = await unknownSend(h, kind, mode !== 'same-root');
      h.db.run('UPDATE operations SET attempts = 10 WHERE id = ?', removal.id);
      let failing = mode !== 'same-root';
      wrap(h, async (nsid, forward) => {
        if (!failing || nsid !== GET) return forward();
        return mode === 'unavailable'
          ? Response.json({ error: 'InternalServerError' }, { status: 503 })
          : Response.json({ uri: uriOf(h, kind), cid: persisted.swap_cid, value: [] });
      });
      const mark = h.writers.sent.length;
      const polls = await poll(h, removal.id, 3);
      expect(polls.every((p) => p.state === 'queued' && p.attempts === 10 && p.code === UNCERTAIN)).toBe(true);
      expect(polls.every((p) => p.delay >= HEAD_RETRY_MS && p.delay <= HOLD_MAX_MS)).toBe(true);
      expect(h.op(removal.id)).toMatchObject({
        removal_send_state: 'pending',
        removal_send_json: persisted.removal_send_json,
      });
      // A sign-in failure blocks it; after sign-in it is the same hold.
      blockOperations(h.db, h.alice, h.kit.clock.nowMs());
      expect(resumeAfterSignIn(h.m, h.alice)).toBe(1);
      const resumed = await poll(h, removal.id, 1);
      expect(resumed[0]).toMatchObject({ state: 'queued', attempts: 10, code: UNCERTAIN });
      expect(writes(h, mark)).toEqual([]);
      // Still unsettled, so a covering later intent supersedes it.
      failing = false;
      await freshResolves(h, kind, removal.id);
    });
  },
);

it.each(KINDS)(
  'F3 %s execute at the root: an unavailable read holds (no attempt spent); the next attempt re-sends the exact pin',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal, persisted } = await unknownSend(h, kind);
      let fails = 1;
      wrap(h, async (nsid, forward) => {
        if (nsid === GET && fails-- > 0) return Response.json({ error: 'InternalServerError' }, { status: 503 });
        return forward();
      });
      const mark = h.writers.sent.length;
      const first = await poll(h, removal.id, 1);
      expect(first[0]).toMatchObject({ state: 'queued', attempts: 1, code: UNRESOLVED });
      expect(writes(h, mark)).toEqual([]);
      await poll(h, removal.id, 1);
      expect(writes(h, mark).map((w) => w.body)).toEqual([pinOf(persisted).body]);
      expect(h.op(removal.id)).toMatchObject({ state: 'succeeded', removal_reached: 'commit', attempts: 2 });
    });
  },
);

it.each(KINDS)(
  'F3 %s: a 5xx answer to the tenth send of an unknown pin holds instead of exhausting; the reconcile never sends',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal, persisted } = await unknownSend(h, kind);
      h.db.run('UPDATE operations SET attempts = 9 WHERE id = ?', removal.id);
      // The tenth send is answered 503 by a gateway, never reaching the PDS.
      let refuse = true;
      const dispatched: unknown[] = [];
      wrap(h, async (nsid, forward, init) => {
        if (nsid === PUT || nsid === DELETE) dispatched.push(JSON.parse(String(init?.body)));
        if (refuse && nsid === methodOf(kind)) return Response.json({ error: 'Unavailable' }, { status: 503 });
        return forward();
      });
      const tenth = await poll(h, removal.id, 1);
      expect(dispatched).toEqual([pinOf(persisted).body]);
      expect(tenth[0]).toMatchObject({ state: 'queued', attempts: 10, code: UNCERTAIN });
      refuse = false;
      const reconciled = await poll(h, removal.id, 2);
      expect(reconciled.every((p) => p.state === 'queued' && p.attempts === 10 && p.code === UNCERTAIN)).toBe(true);
      expect(dispatched).toHaveLength(1);
      expect(h.op(removal.id).removal_send_json).toBe(persisted.removal_send_json);
      await freshResolves(h, kind, removal.id);
    });
  },
);

it.each(KINDS)(
  'F3 %s control: a removal without an unknown send keeps its failure policy at the tenth reconcile',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal } = await admit(h, kind);
      h.db.run("UPDATE operations SET attempts = 10, last_error = 'upstream_unavailable' WHERE id = ?", removal.id);
      wrap(h, async (nsid, forward) =>
        nsid === GET ? Response.json({ error: 'InternalServerError' }, { status: 503 }) : forward(),
      );
      await h.runUntilIdle(10);
      expect(h.op(removal.id)).toMatchObject({ state: 'failed', removal_send_state: null });
      expect(writes(h)).toEqual([]);
    });
  },
);

// ---------------------------------------------------------------------------
// F4: existing and transitive dependencies behind a read-only hold

it('F4: A (X, Y) holds; B (Z, admitted behind A) and fresh C (X, behind B) still run; A keeps holding Y', async () => {
  await withHarness(async (h) => {
    const { removal: a } = await admit(h, 'partial');
    const b = intent(h, 'partial', [Z]);
    expect(h.db.all('SELECT pred_id FROM operation_deps WHERE op_id = ?', b.id)).toEqual([{ pred_id: a.id }]);
    let once = false;
    wrap(h, async (nsid, forward) => {
      if (once || nsid !== PUT) return forward();
      once = true;
      await forward();
      await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
      throw new TypeError('connection reset after the server committed');
    });
    // One run: A's attempt only (B is not ready yet), then C is admitted
    // while B is still queued behind A.
    await h.run();
    expect(h.op(a.id)).toMatchObject({ state: 'queued', last_error: UNCERTAIN });
    expect(h.op(b.id)).toMatchObject({ state: 'queued', attempts: 0 });
    const c = intent(h, 'partial', [X]);
    // C is behind B (not A); B stays behind A: the edges are unchanged.
    expect(h.db.all('SELECT pred_id FROM operation_deps WHERE op_id = ?', c.id)).toEqual([{ pred_id: b.id }]);
    expect(h.op(a.id).state).toBe('queued');
    const mark = h.writers.sent.length;
    await h.runUntilIdle(10);
    await poll(h, a.id, 3);
    expect(h.op(b.id).state).toBe('succeeded');
    expect(h.op(c.id).state).toBe('succeeded');
    // B then C, each once; A never writes again.
    expect(
      writes(h, mark).map((w) => (w.body!.record as { listens: Array<{ id: string }> }).listens.map((l) => l.id)),
    ).toEqual([[X, Y], [Y]]);
    expect(await remoteTargets(h, 'partial')).toEqual([Y]);
    expect(h.op(a.id)).toMatchObject({ state: 'queued', last_error: UNCERTAIN, removal_send_state: 'pending' });
    // A's uncovered target stays hidden; nothing else is projected here.
    expect(visible(h)).toEqual([]);
    expect(h.db.all('SELECT op_id, pred_id FROM operation_deps ORDER BY op_id')).toHaveLength(2);
  });
});

it('F4 control: a removal behind one that may still re-send its pin at the root waits for that re-send', async () => {
  await withHarness(async (h) => {
    const { removal: a } = await admit(h, 'partial');
    const b = intent(h, 'partial', [Z]);
    expect(h.db.all('SELECT pred_id FROM operation_deps WHERE op_id = ?', b.id)).toEqual([{ pred_id: a.id }]);
    // A's first send never arrives: unknown, but the head is still its root.
    let once = false;
    wrap(h, async (nsid, forward) => {
      if (once || nsid !== PUT) return forward();
      once = true;
      throw new TypeError('the request timed out');
    });
    await h.runUntilIdle(10);
    const persisted = h.op(a.id);
    expect(persisted).toMatchObject({ state: 'queued', removal_send_state: 'pending' });
    expect(persisted.last_error).not.toBe(UNCERTAIN);
    // B never ran while A may still re-send at its root.
    expect(h.op(b.id)).toMatchObject({ state: 'queued', attempts: 0 });
    const mark = h.writers.sent.length;
    advanceTo(h, h.op(a.id).due_at);
    await h.runUntilIdle(10);
    const sent = writes(h, mark);
    // A's exact re-send first, then B at the new head.
    expect(sent.map((w) => w.status)).toEqual([200, 200]);
    expect(sent[0]!.body).toEqual(pinOf(persisted).body);
    expect(h.op(a.id).state).toBe('succeeded');
    expect(h.op(b.id).state).toBe('succeeded');
    expect(await remoteRecords(h.kit, 'Alice', BATCH)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F6: full pin validation (local persisted-state corruption, fail closed)

type Mutation = (pin: Pin, h: Harness) => unknown;
const MUTATIONS: Array<[string, Kind, Mutation | string]> = [
  ['unparseable JSON', 'partial', '{invalid'],
  ['an array', 'partial', '[]'],
  ['missing swapCommit', 'partial', (p) => ({ ...p, body: { ...p.body, swapCommit: undefined } })],
  ['missing swapRecord', 'partial', (p) => ({ ...p, body: { ...p.body, swapRecord: undefined } })],
  ['missing head', 'partial', (p) => ({ method: p.method, body: p.body })],
  ['swapCommit not the head CID', 'partial', (p) => ({ ...p, body: { ...p.body, swapCommit: p.body.swapRecord } })],
  [
    'a malformed head CID',
    'partial',
    (p) => ({ ...p, head: { ...p.head, cid: 'nope' }, body: { ...p.body, swapCommit: 'nope' } }),
  ],
  ['a head revision that is not a TID', 'partial', (p) => ({ ...p, head: { ...p.head, rev: 'not-a-tid' } })],
  ['a malformed swapRecord', 'partial', (p) => ({ ...p, body: { ...p.body, swapRecord: 'xyz' } })],
  ['another rkey', 'partial', (p) => ({ ...p, body: { ...p.body, rkey: '3lb2wrongkey2' } })],
  ['another repository', 'partial', (p, h) => ({ ...p, body: { ...p.body, repo: h.bob } })],
  ['another collection', 'partial', (p) => ({ ...p, body: { ...p.body, collection: SCROBBLE } })],
  ['another method', 'partial', (p) => ({ ...p, method: 'com.atproto.repo.createRecord' })],
  ['an extra body field', 'partial', (p) => ({ ...p, body: { ...p.body, validate: false } })],
  ['an extra pin field', 'partial', (p) => ({ ...p, note: 'extra' })],
  ['an array body', 'partial', (p) => ({ ...p, body: [p.body] })],
  ['an array record', 'partial', (p) => ({ ...p, body: { ...p.body, record: [p.body.record] } })],
  [
    'a record of another type',
    'partial',
    (p) => ({ ...p, body: { ...p.body, record: { ...(p.body.record as object), $type: SCROBBLE } } }),
  ],
  [
    'a record still listing a target',
    'partial',
    (p) => ({ ...p, body: { ...p.body, record: { ...ORIGINAL, listens: ORIGINAL.listens } } }),
  ],
  ['a record with no listens', 'partial', (p) => ({ ...p, body: { ...p.body, record: { ...ORIGINAL, listens: [] } } })],
  [
    'a put of a whole-container removal',
    'whole',
    (p) => ({ ...p, method: PUT, body: { ...p.body, record: { ...ORIGINAL, listens: [ORIGINAL.listens[2]] } } }),
  ],
  ['a put of a single record', 'single', (p) => ({ ...p, method: PUT, body: { ...p.body, record: SINGLE } })],
];

it.each(MUTATIONS)('F6 a pin with %s (%s) is never sent and never re-pinned', async (_name, kind, mutate) => {
  await withHarness(async (h) => {
    // Still at its root: a valid pin here would be re-sent at once.
    const { removal, persisted } = await unknownSend(h, kind);
    const corrupted = typeof mutate === 'string' ? mutate : JSON.stringify(mutate(pinOf(persisted), h));
    h.db.run('UPDATE operations SET removal_send_json = ? WHERE id = ?', corrupted, removal.id);
    const mark = h.writers.sent.length;
    const polls = await poll(h, removal.id, 3);
    expect(writes(h, mark)).toEqual([]);
    expect(polls.every((p) => p.state === 'queued' && p.code === UNCERTAIN)).toBe(true);
    expect(h.op(removal.id)).toMatchObject({
      removal_send_state: 'pending',
      removal_send_json: corrupted,
      attempts: 1,
    });
    await freshResolves(h, kind, removal.id);
  });
});

it.each(KINDS)(
  'F6 %s control: a valid pin is re-sent byte-for-byte, unknown fields and retained entries kept',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal, persisted } = await unknownSend(h, kind);
      if (kind === 'single') {
        // A single-record pin written before the check kept checkedHead's tag.
        const pin = pinOf(persisted);
        h.db.run(
          'UPDATE operations SET removal_send_json = ? WHERE id = ?',
          JSON.stringify({ ...pin, head: { kind: 'head', ...pin.head } }),
          removal.id,
        );
      }
      const mark = h.writers.sent.length;
      await poll(h, removal.id, 1);
      const sent = writes(h, mark);
      expect(sent).toHaveLength(1);
      expect(JSON.stringify(sent[0]!.body)).toBe(JSON.stringify(pinOf(persisted).body));
      expect(h.op(removal.id).state).toBe('succeeded');
      if (kind === 'partial') {
        const kept = (await remoteRecords(h.kit, 'Alice', BATCH)).find((r) => r.rkey === RKEY)!.value;
        expect(kept).toEqual({ ...ORIGINAL, listens: [ORIGINAL.listens[2]] });
      }
    });
  },
);

// ---------------------------------------------------------------------------
// F7: supersession while the executor is suspended

it.each(KINDS.flatMap((kind) => ([HEAD, GET] as const).map((at) => ({ kind, at }))))(
  'F7 $kind, superseded while the retry awaits $at: the old executor never sends; only the successor writes',
  async ({ kind, at }) => {
    await withHarness(async (h) => {
      const { removal } = await unknownSend(h, kind);
      let fresh: OperationRow | undefined;
      const dispatched: Array<{ old: string; fresh: string | null }> = [];
      wrap(h, async (nsid, forward) => {
        if (nsid === methodOf(kind)) {
          dispatched.push({ old: h.op(removal.id).state, fresh: fresh === undefined ? null : h.op(fresh.id).state });
        }
        return forward();
      });
      after(h, at, 1, async () => {
        fresh = intent(h, kind);
        expect(h.op(removal.id)).toMatchObject({ state: 'cancelled', removal_superseded_by: fresh.id });
      });
      const version = h.db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', h.alice)!.v;
      h.restart();
      advanceTo(h, h.op(removal.id).due_at);
      const mark = h.writers.sent.length;
      await h.runUntilIdle(10);
      // The only dispatch is the successor's own (running), never the old one's.
      expect(dispatched).toEqual([{ old: 'cancelled', fresh: 'running' }]);
      expect(writes(h, mark)).toHaveLength(1);
      expect(h.op(removal.id)).toMatchObject({ state: 'cancelled', removal_reached: null, removal_done_rev: null });
      expect(h.op(fresh!.id).state).toBe('succeeded');
      expect(await remoteTargets(h, kind)).toEqual(kind === 'partial' ? [Z] : []);
      // Admission and the successor's settlement move statistics, nothing else.
      expect(h.db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', h.alice)!.v).toBe(
        version + 2,
      );
    });
  },
);

it.each(KINDS)(
  'F7 %s: superseded after its request was transmitted: that send keeps its CAS; its stale completion settles nothing',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal, persisted } = await unknownSend(h, kind);
      let fresh: OperationRow | undefined;
      let once = false;
      wrap(h, async (nsid, forward) => {
        const response = await forward();
        if (!once && nsid === methodOf(kind)) {
          once = true;
          fresh = intent(h, kind);
        }
        return response;
      });
      const version = h.db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', h.alice)!.v;
      h.restart();
      advanceTo(h, h.op(removal.id).due_at);
      const mark = h.writers.sent.length;
      await h.run();
      // The old request was transmitted (and committed under its own CAS) …
      expect(writes(h, mark).map((w) => [w.status, w.body])).toEqual([[200, pinOf(persisted).body]]);
      // … but its completion changes nothing about the cancelled receipt.
      expect(h.op(removal.id)).toMatchObject({
        state: 'cancelled',
        removal_reached: null,
        removal_done_rev: null,
        removal_superseded_by: fresh!.id,
      });
      expect(h.db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', h.alice)!.v).toBe(
        version + 1,
      );
      // The successor's receipts (its listen removals) are untouched.
      const removals = h.db.all<{ operation_id: string }>('SELECT operation_id FROM listen_removals');
      expect(removals).toHaveLength(kind === 'single' ? 0 : kind === 'whole' ? 1 : 2);
      expect(removals.every((r) => r.operation_id === fresh!.id)).toBe(true);
      // The successor finds its requested state reached. A batch removal
      // reads first and writes nothing; a single delete with an indexed
      // swapRecord sends its own delete, which the PDS answers as the no-op
      // of an absent record (no commit).
      const rev = head(h).rev;
      await h.runUntilIdle(10);
      const later = writes(h, mark).slice(1);
      if (kind === 'single') {
        expect(later.map((w) => [w.nsid, w.status])).toEqual([[DELETE, 200]]);
        expect(head(h).rev).toBe(rev);
        expect(h.op(fresh!.id)).toMatchObject({ state: 'succeeded', removal_reached: 'success' });
      } else {
        expect(later).toEqual([]);
        expect(h.op(fresh!.id)).toMatchObject({ state: 'succeeded', removal_reached: 'absent' });
      }
    });
  },
);

it('F4 control: removals of a key without a held removal keep their ordering', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    await h.kit.externalPut('Alice', SCROBBLE, '3lb2unrelate2', UNRELATED);
    const first = enqueueScrobbleDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${SCROBBLE}/3lb2unrelate2`,
      origin: 'web',
    });
    const second = enqueueScrobbleDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${SCROBBLE}/3lb2unrelate2`,
      origin: 'web',
    });
    expect(h.db.all('SELECT pred_id FROM operation_deps WHERE op_id = ?', second.id)).toEqual([{ pred_id: first.id }]);
    await h.runUntilIdle(10);
    expect(h.op(first.id).state).toBe('succeeded');
    expect(h.op(second.id).state).toBe('succeeded');
    expect(writes(h)).toHaveLength(1);
  });
});
