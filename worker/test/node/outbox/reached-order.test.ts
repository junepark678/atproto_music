// Durable no-replay knowledge apart from ordered visibility (migration 13,
// outbox/removal-fence.ts). These tests reproduce the Astra 5e18a99 findings:
// - F1: an absence whose closing head moved (or was unavailable, 503 or 401)
//   is not ordered at the head read before it. With X and Y targeted, B
//   (both present) committed after H, D removing both, and R recreating only
//   X before the closing head, the receipt must order the absence at a head
//   read after it: delayed B (Y included) stays hidden, R's X is visible, and
//   Y (never recreated) never reappears. X's presence never releases Y.
// - F2: a received successful answer without commit metadata (the installed
//   reference PDS's no-op, or an actual commit whose metadata was left out)
//   is no-replay knowledge at once: R recreated and proven before the
//   read-back, with D never ingested, is never written again, across a
//   restart, and a fresh intent still removes R.
// They also cover the read-only hold (a reached removal with no head read
// after it), the strictness of the `after` boundary, proof-driven release of
// the region it cannot order, and the success-answer validation.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cidOf } from '@atmusic/atproto/test-support/signed-repo';
import { expect, it } from 'vitest';
import { recordStatus } from '../../../src/do/ingest/notify';
import { exportUser } from '../../../src/do/read/export';
import { statsWithCache } from '../../../src/do/read/stats';
import { visibleScrobblesFrom } from '../../../src/do/read/visibility';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { answersRemoval, HEAD_RETRY_MS } from '../../../src/outbox/removal-fence';
import { resumeAfterSignIn } from '../../../src/outbox/runner';
import { proofAt } from '../../write/support';
import { DELETE, GET, type Harness, HEAD, PUT, remoteRecords, SCROBBLE, T0, withHarness } from './support';

const PREFIX = 'com.example.atmusic';
const BATCH = `${PREFIX}.scrobbleBatch`;
const RKEY = '3lb2reachedab';
const OTHER = '3lb2reachedac';
const SINGLE_RKEY = '3lb2singleab2';
const X = '3lb2batchidab';
const Y = '3lb2batchidac';
const Z = '3lb2batchidad';
const OPTIONS = { receiptNs: BigInt(T0) * 1_000_000n, nowNs: BigInt(T0) * 1_000_000n, prefix: PREFIX };

const entry = (id: string, track: string, hour: number) => ({
  id,
  artist: 'Reached Artist',
  track,
  listenedAt: `2026-01-14T1${hour}:00:00Z`,
  createdAt: '2026-01-15T12:00:00Z',
});
const LX = entry(X, 'X', 0);
const LY = entry(Y, 'Y', 1);
const LZ = entry(Z, 'Z', 2);
const ORIGINAL = { $type: BATCH, createdAt: '2026-01-15T12:00:00Z', listens: [LX, LY, LZ] };
const SINGLE = {
  $type: SCROBBLE,
  artist: 'Single Artist',
  track: 'Single Track',
  listenedAt: '2026-01-14T12:00:00Z',
  createdAt: '2026-01-15T12:00:00Z',
};

type Proof = Awaited<ReturnType<typeof proofAt>>;
type Kind = 'partial' | 'whole' | 'single';
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
const advanceTo = (h: Harness, at: number) => {
  if (at > h.kit.clock.nowMs()) h.kit.clock.advance(at - h.kit.clock.nowMs());
};

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

/** The projected three-listen container A and an admitted removal of `listenIds`. */
async function admitted(h: Harness, listenIds: string[]) {
  h.seedUser(h.alice);
  await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
  const a = await proof(h);
  expect(apply(h, a)).toBe('applied');
  const removal = enqueueBatchListenDelete(h.m, { did: h.alice, uri: container(h), listenIds, origin: 'web' });
  return { a, removal };
}

/** A projected single scrobble A and its admitted removal. */
async function admittedSingle(h: Harness) {
  h.seedUser(h.alice);
  await h.kit.externalPut('Alice', SCROBBLE, SINGLE_RKEY, SINGLE);
  const a = await proof(h, SCROBBLE, SINGLE_RKEY);
  expect(apply(h, a)).toBe('applied');
  const removal = enqueueScrobbleDelete(h.m, { did: h.alice, uri: singleUri(h), origin: 'web' });
  return { a, removal };
}

async function admit(h: Harness, kind: Kind) {
  if (kind === 'single') return admittedSingle(h);
  return admitted(h, kind === 'whole' ? ['*'] : [X]);
}

/** The installed reference handler (@atproto/pds 0.5.40) over the fixture repository's current record. */
async function referenceAnswer(h: Harness, name: 'deleteRecord' | 'putRecord', body: Record<string, unknown>) {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('@atproto/pds/package.json'));
  const mod = (await import(pathToFileURL(join(root, 'dist/api/com/atproto/repo', `${name}.js`)).href)) as {
    default: (server: unknown, ctx: unknown) => void;
  };
  let processWrites = 0;
  let handler:
    | ((req: { input: { body: unknown }; auth: unknown }) => Promise<{ body: Record<string, unknown> }>)
    | null = null;
  mod.default(
    {
      add: (_lexicon: unknown, config: { handler: typeof handler }) => {
        handler = config.handler;
      },
    },
    {
      authVerifier: { authorization: () => () => {}, findAccount: async () => ({ did: h.alice }) },
      actorStore: {
        transact: async (_did: string, fn: (txn: unknown) => unknown) =>
          fn({
            record: {
              getRecord: async () => {
                const current = await h.kit.repos.Alice.getRecord(body.collection as string, body.rkey as string);
                return current ? { cid: current.cid } : null;
              },
            },
            repo: {
              processWrites: async () => {
                processWrites += 1;
                throw new Error('processWrites (a mutation) reached');
              },
            },
          }),
      },
    },
  );
  const answer = await handler!({ input: { body }, auth: { credentials: { did: h.alice, type: 'access' } } });
  // The real handler skipped processWrites, so it enforced neither swap and
  // reported no commit: the requested state already existed.
  expect(processWrites).toBe(0);
  expect(answer.body.commit).toBeUndefined();
  return JSON.parse(JSON.stringify(answer.body)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// F1: an unstable absence, then a recreation of only one target

it.each([
  { kind: 'partial', closing: 'moved' },
  { kind: 'partial', closing: 'unavailable' },
  { kind: 'partial', closing: 'reauth' },
  { kind: 'whole', closing: 'moved' },
  { kind: 'whole', closing: 'unavailable' },
  { kind: 'whole', closing: 'reauth' },
] as const)(
  'F1 $kind, closing head $closing: removed Y stays hidden after delayed B, recreated X is visible, nothing is written',
  async ({ kind, closing }) => {
    await withHarness(async (h) => {
      const { a, removal } = await admitted(h, kind === 'whole' ? ['*'] : [X, Y]);
      let b: Proof | undefined;
      let d: Proof | undefined;
      let r: Proof | undefined;
      // After head H, before the container read: B (X, Y present), then D
      // removes both (the whole case removes the container).
      after(h, HEAD, 1, async () => {
        await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'B' });
        b = await proof(h);
        if (kind === 'whole') await h.kit.externalDelete('Alice', BATCH, RKEY);
        else await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, listens: [LZ] });
        d = await proof(h);
      });
      // The absent read is captured at D; before the client sees it, R
      // recreates only X. The closing head moved to R, or fails.
      after(h, GET, 1, async () => {
        await h.kit.externalPut('Alice', BATCH, RKEY, {
          ...ORIGINAL,
          listens: kind === 'whole' ? [LX] : [LX, LZ],
        });
        r = await proof(h);
        if (closing === 'unavailable') {
          h.kit.pds.Alice.fail({ nsid: HEAD }, { kind: 'status', status: 503, error: 'Unavailable', message: 'x' });
        }
        if (closing === 'reauth') {
          h.kit.pds.Alice.fail({ nsid: HEAD }, { kind: 'status', status: 401, error: 'ExpiredToken', message: 'x' });
        }
      });
      await h.runUntilIdle();
      if (closing === 'reauth') {
        // No-replay knowledge was persisted before the closing head failed;
        // nothing orders it yet, so the receipt is pending (all hidden).
        expect(h.op(removal.id)).toMatchObject({
          state: 'blocked',
          attempts: 0,
          removal_reached: 'absent',
          removal_done_rev: null,
        });
        expect(visible(h)).toEqual(kind === 'whole' ? [] : [Z]);
        h.restart();
        expect(resumeAfterSignIn(h.m, h.alice)).toBe(1);
        await h.runUntilIdle();
      }
      expect(b!.commit.rev > a.commit.rev && d!.commit.rev > b!.commit.rev && r!.commit.rev > d!.commit.rev).toBe(true);
      expect(writes(h)).toBe(0);
      // Ordered at the first head read after the absence (R), never at H.
      expect(h.op(removal.id)).toMatchObject({
        state: 'succeeded',
        removal_reached: 'absent',
        removal_head_rev: a.commit.rev,
        removal_done_rev: r!.commit.rev,
        removal_done_basis: 'after',
        removal_commit_rev: null,
      });
      // Delayed B is accepted by ingest (newer than A) but stays hidden: Y
      // was removed at D and never recreated; X's B version precedes R.
      expect(apply(h, b!)).toBe('applied');
      expect(visible(h)).toEqual(kind === 'whole' ? [] : [Z]);
      expect(total(h)).toBe(kind === 'whole' ? 0 : 1);
      expect(exported(h)).toEqual(kind === 'whole' ? [] : [`${container(h)}#${Z}`]);
      expect(status(h, `${container(h)}#${Y}`)).toMatchObject({ state: 'unknown' });
      // Proof of R: X is a later incarnation (at the boundary); Y is gone.
      expect(apply(h, r!)).toBe('applied');
      expect(visible(h)).toEqual(kind === 'whole' ? [X] : [X, Z]);
      expect(total(h)).toBe(kind === 'whole' ? 1 : 2);
      expect(await remoteIds(h)).toEqual(kind === 'whole' ? [X] : [X, Z]);

      // A fresh intent removes the later incarnation normally.
      const fresh = enqueueBatchListenDelete(h.m, { did: h.alice, uri: container(h), listenIds: [X], origin: 'web' });
      await h.runUntilIdle();
      expect(h.op(fresh.id)).toMatchObject({
        state: 'succeeded',
        removal_reached: 'commit',
        removal_done_basis: 'commit',
      });
      expect(await remoteIds(h)).toEqual(kind === 'whole' ? [] : [Z]);
    });
  },
);

// ---------------------------------------------------------------------------
// F2: a received success without commit metadata is never replayed

it.each(['partial', 'whole', 'single'] as const)(
  'F2 %s: the installed reference no-op answer, then R before the read-back (D never ingested), is never written again',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal } = await admit(h, kind);
      const collection = kind === 'single' ? SCROBBLE : BATCH;
      const rkey = kind === 'single' ? SINGLE_RKEY : RKEY;
      const original = kind === 'single' ? SINGLE : ORIGINAL;
      const method = kind === 'partial' ? PUT : DELETE;
      let b: Proof | undefined;
      let r: Proof | undefined;
      h.kit.pds.Alice.fail(
        { nsid: method },
        {
          kind: 'respond',
          respond: async () => {
            const request = h.writers.sent.at(-1)!.body as Record<string, unknown>;
            // Before the stale request is handled, other writers commit B and
            // then D, which already is exactly the requested result.
            await h.kit.externalPut('Alice', collection, rkey, { ...original, extra: 'B' });
            b = await proof(h, collection, rkey);
            if (kind === 'partial') await h.kit.externalPut('Alice', collection, rkey, request.record as object);
            else await h.kit.externalDelete('Alice', collection, rkey);
            const answer = await referenceAnswer(h, kind === 'partial' ? 'putRecord' : 'deleteRecord', request);
            // Recreated (original bytes) and proven before the read-back; D never is.
            await h.kit.externalPut('Alice', collection, rkey, original);
            r = await proof(h, collection, rkey);
            expect(apply(h, r)).toBe('applied');
            return Response.json(answer);
          },
        },
      );
      await h.runUntilIdle();
      expect(writes(h)).toBe(1);
      expect(h.op(removal.id)).toMatchObject({
        state: 'succeeded',
        removal_reached: 'success',
        removal_done_rev: r!.commit.rev,
        removal_done_basis: 'after',
        removal_commit_rev: null,
      });
      h.restart();
      const mark = h.writers.sent.length;
      await h.runUntilIdle();
      expect(writes(h, mark)).toBe(0);
      expect(await remoteRecords(h.kit, 'Alice', collection)).toHaveLength(1);
      // R is the current, later incarnation; delayed B is older than it.
      expect(apply(h, b!)).not.toBe('applied');
      expect(visible(h)).toEqual(kind === 'single' ? ['*'] : [X, Y, Z]);

      // A fresh intent removes R normally.
      const fresh =
        kind === 'single'
          ? enqueueScrobbleDelete(h.m, { did: h.alice, uri: singleUri(h), origin: 'web' })
          : enqueueBatchListenDelete(h.m, {
              did: h.alice,
              uri: container(h),
              listenIds: kind === 'whole' ? ['*'] : [X],
              origin: 'web',
            });
      await h.runUntilIdle();
      expect(h.op(fresh.id)).toMatchObject({ state: 'succeeded', removal_done_basis: 'commit' });
      if (kind === 'partial') expect(await remoteIds(h)).toEqual([Y, Z]);
      else expect(await remoteRecords(h.kit, 'Alice', collection)).toEqual([]);
    });
  },
);

it.each(['partial', 'whole', 'single'] as const)(
  'F2 %s: an actual commit answered without metadata, then R proven before the read-back (no D proof), is never written again',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal } = await admit(h, kind);
      const collection = kind === 'single' ? SCROBBLE : BATCH;
      const rkey = kind === 'single' ? SINGLE_RKEY : RKEY;
      const original = kind === 'single' ? SINGLE : ORIGINAL;
      const method = kind === 'partial' ? PUT : DELETE;
      const writerFor = h.writers.writerFor.bind(h.writers);
      let intercepted = false;
      let d: string | undefined;
      let r: Proof | undefined;
      h.writers.writerFor = async (did: string) => {
        const writer = await writerFor(did);
        if (writer === null) return null;
        return {
          ...writer,
          fetchHandler: async (path: string, init?: RequestInit) => {
            const response = await writer.fetchHandler(path, init);
            if (intercepted || !path.includes(`/xrpc/${method}`)) return response;
            intercepted = true;
            // The write committed D (not ingested); R is recreated and
            // proven before the client sees the answer, which omits `commit`.
            d = h.kit.repos.Alice.head!.rev;
            await h.kit.externalPut('Alice', collection, rkey, original);
            r = await proof(h, collection, rkey);
            expect(apply(h, r)).toBe('applied');
            const body = (await response.json()) as Record<string, unknown>;
            expect(body.commit).toMatchObject({ rev: d });
            delete body.commit;
            return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
          },
        };
      };
      await h.runUntilIdle();
      expect(h.op(removal.id)).toMatchObject({
        state: 'succeeded',
        removal_reached: 'success',
        removal_done_rev: r!.commit.rev,
        removal_done_basis: 'after',
        removal_commit_rev: null,
      });
      h.restart();
      const mark = h.writers.sent.length;
      await h.runUntilIdle();
      expect(writes(h, mark)).toBe(0);
      expect(await remoteRecords(h.kit, 'Alice', collection)).toHaveLength(1);
      expect(visible(h)).toEqual(kind === 'single' ? ['*'] : [X, Y, Z]);
      expect(h.db.one('SELECT 1 AS x FROM verified_membership WHERE last_absent_revision = ?', d!)).toBeNull();
    });
  },
);

// ---------------------------------------------------------------------------
// The read-only hold: reached, with no head read after it yet

it('a reached removal whose heads stay unavailable holds read-only with backoff; verified R alone does not order it; the next head does', async () => {
  await withHarness(async (h) => {
    const { a, removal } = await admitted(h, [X, Y]);
    let b: Proof | undefined;
    let r: Proof | undefined;
    after(h, HEAD, 1, async () => {
      await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, extra: 'B' });
      b = await proof(h);
      await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, listens: [LZ] });
    });
    after(h, GET, 1, async () => {
      await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, listens: [LX, LZ] });
      r = await proof(h);
      // The closing head, the next round's head and three later polls fail.
      h.kit.pds.Alice.fail({ nsid: HEAD }, { kind: 'status', status: 503, error: 'Unavailable', message: 'x' }, 5);
    });
    await h.runUntilIdle();
    const first = h.op(removal.id);
    expect(first).toMatchObject({
      state: 'queued',
      attempts: 0,
      last_error: 'removal_reached_unordered',
      removal_reached: 'absent',
      removal_head_rev: a.commit.rev,
      removal_done_rev: null,
    });
    const reachedAt = first.removal_reached_at_ms!;
    expect(first.due_at - h.kit.clock.nowMs()).toBe(HEAD_RETRY_MS);
    expect(writes(h)).toBe(0);
    // Pending: every target stays hidden, the untargeted sibling is visible.
    expect(visible(h)).toEqual([Z]);
    // The verifier sees R (X present, Y absent at R). Nothing orders R
    // against the absence, so X stays held and the receipt stays pending.
    expect(apply(h, r!)).toBe('applied');
    expect(apply(h, b!)).not.toBe('applied');
    expect(visible(h)).toEqual([Z]);

    const delays: number[] = [];
    for (let poll = 0; poll < 3; poll++) {
      advanceTo(h, h.op(removal.id).due_at);
      const mark = h.writers.sent.length;
      await h.runUntilIdle();
      // One head read per poll; nothing else, nothing written, no attempt.
      expect(h.writers.order().slice(mark)).toEqual([HEAD]);
      const held = h.op(removal.id);
      expect(held).toMatchObject({ state: 'queued', attempts: 0, last_error: 'removal_reached_unordered' });
      delays.push(held.due_at - h.kit.clock.nowMs());
      expect(visible(h)).toEqual([Z]);
    }
    // The wait doubles with the time since the state was reached (bounded).
    expect(delays).toEqual([HEAD_RETRY_MS, 2 * HEAD_RETRY_MS, 4 * HEAD_RETRY_MS]);
    expect(h.op(removal.id).removal_reached_at_ms).toBe(reachedAt);

    // The head is readable again: it is read after the absence and orders it.
    advanceTo(h, h.op(removal.id).due_at);
    await h.runUntilIdle();
    expect(writes(h)).toBe(0);
    // Holds never spent an attempt; the look that settles counts as one, as
    // every settlement by a read does.
    expect(h.op(removal.id)).toMatchObject({
      state: 'succeeded',
      attempts: 1,
      removal_done_rev: r!.commit.rev,
      removal_done_basis: 'after',
    });
    expect(visible(h)).toEqual([X, Z]);
    expect(await remoteIds(h)).toEqual([X, Z]);
  });
});

it('a tenth attempt answered by a no-op whose read-back head fails holds (counted, never failed) and the read-only reconcile orders it', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [X]);
    h.db.run('UPDATE operations SET attempts = 9 WHERE id = ?', removal.id);
    h.kit.pds.Alice.fail(
      { nsid: PUT },
      {
        kind: 'respond',
        respond: async () => {
          const request = h.writers.sent.at(-1)!.body as Record<string, unknown>;
          await h.kit.externalPut('Alice', BATCH, RKEY, request.record as object);
          const answer = await referenceAnswer(h, 'putRecord', request);
          h.kit.pds.Alice.fail({ nsid: HEAD }, { kind: 'status', status: 503, error: 'Unavailable', message: 'x' });
          return Response.json(answer);
        },
      },
    );
    await h.runUntilIdle();
    expect(writes(h)).toBe(1);
    expect(h.op(removal.id)).toMatchObject({
      state: 'queued',
      attempts: 10,
      last_error: 'removal_reached_unordered',
      removal_reached: 'success',
      removal_done_rev: null,
    });
    // Recreated before any head could be read after the answer.
    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    const r = await proof(h);
    apply(h, r);
    h.restart();
    advanceTo(h, h.op(removal.id).due_at);
    const mark = h.writers.sent.length;
    await h.runUntilIdle();
    expect(writes(h, mark)).toBe(0);
    expect(h.op(removal.id)).toMatchObject({
      state: 'succeeded',
      attempts: 10,
      removal_done_rev: r.commit.rev,
      removal_done_basis: 'after',
    });
    expect(visible(h)).toEqual([X, Y, Z]);
  });
});

// ---------------------------------------------------------------------------
// The `after` boundary is strict, and what it cannot order is released by proof

it('a recreation committed before an unrelated commit that moved the closing head stays hidden until verified at or above the boundary', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [X]);
    // Removed by another writer before this removal ran.
    await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, listens: [LY, LZ] });
    let r1: Proof | undefined;
    after(h, GET, 1, async () => {
      await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
      r1 = await proof(h);
      await h.kit.externalPut('Alice', BATCH, OTHER, { ...ORIGINAL, listens: [LZ] });
    });
    await h.runUntilIdle();
    const u = h.kit.repos.Alice.head!.rev;
    expect(u > r1!.commit.rev).toBe(true);
    expect(writes(h)).toBe(0);
    expect(h.op(removal.id)).toMatchObject({ state: 'succeeded', removal_done_rev: u, removal_done_basis: 'after' });
    // The settlement queued the container's verify hint.
    expect(h.db.one('SELECT source FROM hints WHERE uri = ?', container(h))).toMatchObject({ source: 'notify' });
    // R1's proof is below the boundary: it cannot be told apart from a
    // pre-removal version, so it stays hidden...
    expect(apply(h, r1!)).toBe('applied');
    expect(visible(h)).toEqual([Y, Z]);
    // ...until verified ingest proves the unchanged record at the current head.
    const again = await proof(h);
    expect(again.commit.rev).toBe(u);
    expect(apply(h, again)).toBe('applied');
    expect(visible(h)).toEqual([X, Y, Z]);
  });
});

// ---------------------------------------------------------------------------
// Which success answers certify the requested state

it("answersRemoval accepts this request's own answers (any commit metadata, unknown fields) and nothing else", () => {
  const uri = 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobbleBatch/3lb2reachedab';
  const record = { ...ORIGINAL, listens: [LZ] };
  const cid = cidOf(record);
  // deleteRecord: an object.
  expect(answersRemoval({}, { uri })).toBe(true);
  expect(answersRemoval({ commit: { cid: 'bad', rev: 'malformed' }, extra: 1 }, { uri })).toBe(true);
  expect(answersRemoval(null, { uri })).toBe(false);
  expect(answersRemoval([], { uri })).toBe(false);
  expect(answersRemoval('ok', { uri })).toBe(false);
  // putRecord: the same URI and the CID of exactly the bytes sent.
  expect(answersRemoval({ uri, cid }, { uri, record })).toBe(true);
  expect(answersRemoval({ uri, cid, validationStatus: 'unknown', future: { x: 1 } }, { uri, record })).toBe(true);
  expect(answersRemoval({ uri, cid, commit: { cid: 'bad', rev: 'malformed' } }, { uri, record })).toBe(true);
  expect(answersRemoval({ uri: `${uri}x`, cid }, { uri, record })).toBe(false);
  expect(answersRemoval({ uri, cid: cidOf(ORIGINAL) }, { uri, record })).toBe(false);
  expect(answersRemoval({ uri, cid: 'not-a-cid' }, { uri, record })).toBe(false);
  expect(answersRemoval({ uri }, { uri, record })).toBe(false);
  expect(answersRemoval({}, { uri, record })).toBe(false);
});

it.each([
  { name: 'another URI', answer: (uri: string, cid: string) => ({ uri: uri.replace('3lb2reachedab', OTHER), cid }) },
  { name: 'another CID', answer: (uri: string) => ({ uri, cid: cidOf(ORIGINAL) }) },
  { name: 'no CID', answer: (uri: string) => ({ uri }) },
  { name: 'an array', answer: () => [] },
])(
  'a 2xx put answer naming $name certifies nothing: the recreation found by the read-back is not settled as a later incarnation',
  async ({ answer }) => {
    await withHarness(async (h) => {
      const { removal } = await admitted(h, [X]);
      h.kit.pds.Alice.fail(
        { nsid: PUT },
        {
          kind: 'respond',
          respond: async () => {
            const request = h.writers.sent.at(-1)!.body as Record<string, unknown>;
            await h.kit.externalPut('Alice', BATCH, RKEY, request.record as object);
            const cid = cidOf(request.record);
            await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
            return Response.json(answer(container(h), cid));
          },
        },
      );
      await h.run();
      // The answer certifies nothing and the head moved past the pinned
      // send: a present X cannot tell an unexecuted put from a completed one
      // followed by a recreation, so it holds read-only (removal-fence.ts).
      expect(h.op(removal.id)).toMatchObject({
        state: 'queued',
        attempts: 1,
        last_error: 'removal_send_uncertain',
        removal_reached: null,
        removal_done_rev: null,
        removal_send_state: 'pending',
      });
      expect(visible(h)).toEqual([Y, Z]);
    });
  },
);
