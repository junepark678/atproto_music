// The per-DID PDS point budget, priorities, re-authentication and the hint
// path after writes (ADR 0005 §5.8; review round 1 finding 22; N2-05). The
// fake PDS enforces the reference limits (5,000 points per hour, 35,000 per
// day; create 3) and sends RateLimit-* headers on every write.

import { expect, it } from 'vitest';
import type { OperationRow } from '../../../src/app/rows';
import { snapshotStep } from '../../../src/do/ingest/snapshot-job';
import { drain } from '../../../src/do/ingest/verify-drain';
import { acceptListens } from '../../../src/outbox/ingress';
import { resumeAfterSignIn } from '../../../src/outbox/runner';
import { enqueueScrobbleCreates } from '../../../src/outbox/scrobble-ops';
import { APPLY, CREATE, GET, type Harness, listenInput, remoteRecords, SCROBBLE, T0, withHarness } from './support';

const HOUR = 3_600_000;

async function importCreates(h: Harness, n: number, offset = 0): Promise<OperationRow[]> {
  const r = await enqueueScrobbleCreates(h.m, {
    did: h.alice,
    origin: 'import',
    inputs: Array.from({ length: n }, (_, i) => listenInput(offset + i, { artist: 'Imported' })),
  });
  if (!r.ok) throw new Error(JSON.stringify(r.reason));
  return r.operations;
}

/** Live listens in protocol batches of 50 (as /2.0 track.scrobble sends them). */
async function liveListens(h: Harness, n: number, offset = 0): Promise<void> {
  for (let start = 0; start < n; start += 50) {
    const listens = Array.from({ length: Math.min(50, n - start) }, (_, i) => ({
      input: listenInput(offset + start + i, { artist: 'Live' }),
    }));
    const r = await acceptListens(h.m, { did: h.alice, origin: 'lastfm', listens, receiptMs: h.kit.clock.nowMs() });
    expect(r.created).toBe(listens.length);
  }
}

function states(h: Harness, origin: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of h.db.all<{ state: string; n: number }>(
    'SELECT state, count(*) AS n FROM operations WHERE origin = ? GROUP BY state',
    origin,
  )) {
    out[r.state] = r.n;
  }
  return out;
}

function hourPoints(h: Harness): number | undefined {
  return h.db.one<{ points: number }>(`SELECT points FROM pds_budget WHERE did = ? AND window = 'hour'`, h.alice)
    ?.points;
}

/** Writes by the user's other apps, straight to their PDS: `n` Bluesky likes per applyWrites. */
async function otherAppWrites(h: Harness, batches: number, n = 200): Promise<void> {
  for (let b = 0; b < batches; b++) {
    const writes = Array.from({ length: n }, (_, i) => ({
      $type: 'com.atproto.repo.applyWrites#create',
      collection: 'app.bsky.feed.like',
      value: {
        $type: 'app.bsky.feed.like',
        subject: {
          uri: `at://${h.bob}/app.bsky.feed.post/3k${String(b * n + i).padStart(11, '2')}`,
          cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
        },
        createdAt: '2026-01-15T12:00:00Z',
      },
    }));
    const res = await h.kit.transport(
      new Request(`${h.kit.users.Alice.origin}/xrpc/${APPLY}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${h.kit.users.Alice.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repo: h.alice, writes }),
      }),
    );
    expect(res.status).toBe(200);
  }
}

it('with 5,000 points per hour, import creates stop at 833 while live creates continue to 90% of the limit; RateLimit-Remaining below reserve pauses imports until RateLimit-Reset', async () => {
  await withHarness(async (h) => {
    h.account(h.alice, { import_share_pct: 50 });
    await importCreates(h, 1000);
    const imports = await h.runUntilIdle();
    // 50 % of 5,000 is 2,500 points: 833 creates (2,499 points), the last batch sized to fit.
    expect(imports.flatMap((r) => r.batches)).toEqual([200, 200, 200, 200, 33]);
    expect(states(h, 'import')).toEqual({ succeeded: 833, queued: 167 });
    expect(
      h.db.one(`SELECT count(*) AS n FROM operations WHERE origin = 'import' AND state = 'queued' AND attempts > 0`),
    ).toEqual({ n: 0 });
    expect(hourPoints(h)).toBe(2499);
    expect(h.kit.pds.Alice.pointsRemaining(h.alice)).toBe(2501);
    // Paused until the hour window ends, not retried in a loop.
    expect(imports.at(-1)!.nextDueMs).toBe(T0 + HOUR);

    // Live creates continue, up to 90 % of the limit (4,500 points).
    await liveListens(h, 700);
    const live = await h.runUntilIdle();
    expect(live.flatMap((r) => r.batches)).toEqual([200, 200, 200, 67]);
    expect(states(h, 'lastfm')).toEqual({ succeeded: 667, queued: 33 });
    expect(states(h, 'import')).toEqual({ succeeded: 833, queued: 167 });
    expect(hourPoints(h)).toBe(4500);
    expect(h.kit.pds.Alice.pointsRemaining(h.alice)).toBe(500);
    expect(live.at(-1)!.nextDueMs).toBe(T0 + HOUR);
    // Nothing was refused by the PDS: the budget kept every write under its limit.
    expect(h.kit.pds.Alice.calls.filter({ status: 429 })).toEqual([]);
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(1500);
  });

  // The user's own activity in other apps used the same budget: the PDS headers win over the ledger.
  await withHarness(async (h) => {
    h.account(h.alice, { import_share_pct: 50 });
    await otherAppWrites(h, 4); // 2,400 points this hour, unknown to the ledger
    await importCreates(h, 400);
    const reports = await h.runUntilIdle();
    expect(reports[0]!.batches).toEqual([200]);
    // RateLimit-Remaining is now 2,000, below the reserve (1 − 50 %) × 5,000: imports pause.
    expect(h.kit.pds.Alice.pointsRemaining(h.alice)).toBe(2000);
    expect(
      h.db.one(
        `SELECT points, limit_hint, remaining_hint, reset_at_ms FROM pds_budget WHERE did = ? AND window = 'hour'`,
        h.alice,
      ),
    ).toEqual({
      points: 3000,
      limit_hint: 5000,
      remaining_hint: 2000,
      reset_at_ms: T0 + HOUR,
    });
    const paused = await h.run();
    expect([paused.attempted, paused.nextDueMs]).toEqual([0, T0 + HOUR]);
    // Live writes still go (90 % leaves 1,500 points).
    await liveListens(h, 10);
    expect((await h.runUntilIdle()).flatMap((r) => r.batches)).toEqual([10]);
    expect(states(h, 'import')).toEqual({ succeeded: 200, queued: 200 });

    h.kit.clock.set(new Date(T0 + HOUR - 1).toISOString());
    expect((await h.run()).attempted).toBe(0);
    expect(h.writers.count(APPLY)).toBe(2);
    // At RateLimit-Reset the window is new and the imports resume.
    h.kit.clock.advance(1);
    const resumed = await h.runUntilIdle();
    expect(resumed.flatMap((r) => r.batches)).toEqual([200]);
    expect(states(h, 'import')).toEqual({ succeeded: 400 });
  });
});

it('bisection halves and singles are budget-checked: a bisected import never spends past its share, and what the budget stops waits for the window without spending attempts', async () => {
  await withHarness(async (h) => {
    h.account(h.alice, { import_share_pct: 50 });
    await otherAppWrites(h, 2); // 1,200 points this hour; the import share leaves 1,300
    const ops = await importCreates(h, 200);
    // The same records already sit at four rkeys, so the batch and its halves are refused.
    const existing = [0, 60, 137, 190].map((i) => ops[i]!);
    const prior = new Map<string, string | null>();
    for (const op of existing) {
      const commit = await h.kit.externalPut('Alice', SCROBBLE, op.rkey!, JSON.parse(op.record_json!));
      prior.set(op.id, commit.ops[0]!.cid);
    }
    const written = new Map<string, number>();
    h.kit.pds.Alice.onCommit((_did, commit) => {
      for (const op of commit.ops) if (op.action !== 'delete') written.set(op.rkey, (written.get(op.rkey) ?? 0) + 1);
    });

    const reports = await h.runUntilIdle();
    expect(reports[0]!.batches).toEqual([200]);
    // Points charged for every request the runner sent, as the PDS counts them.
    const charged = h.writers.sent.reduce(
      (sum, s) => sum + (s.nsid === APPLY ? 3 * (s.body!.writes as unknown[]).length : s.nsid === CREATE ? 3 : 0),
      0,
    );
    expect(charged).toBeGreaterThan(600);
    // The other apps' 1,200 points and ours stay within the 2,500-point import share.
    expect(1200 + charged).toBeLessThanOrEqual(2500);
    expect(5000 - h.kit.pds.Alice.pointsRemaining(h.alice)).toBe(1200 + charged);
    expect(hourPoints(h)!).toBeLessThanOrEqual(2500);
    expect(h.kit.pds.Alice.calls.filter({ status: 429 })).toEqual([]);
    // What the budget stopped is queued again with its attempt refunded, and the DID waits for the window.
    const waiting = h.ops(`state = 'queued'`);
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((o) => o.attempts === 0)).toBe(true);
    expect(h.ops(`state NOT IN ('queued','succeeded')`)).toEqual([]);
    // The share is used up to what one more create cannot fit, then the DID waits for the window.
    expect(2500 - (1200 + charged)).toBeLessThan(3);
    expect(reports.at(-1)!.nextDueMs).toBe(T0 + HOUR);
    const sentBefore = h.writers.sent.length;
    expect(await h.run()).toMatchObject({ attempted: 0, nextDueMs: T0 + HOUR });
    expect(h.writers.sent.length).toBe(sentBefore);

    // A new window: the rest completes; the existing records are reconciled by digest, never overwritten.
    h.kit.clock.set(new Date(T0 + HOUR).toISOString());
    await h.runUntilIdle();
    for (const op of ops) expect(h.op(op.id).state).toBe('succeeded');
    for (const op of existing) {
      expect(h.op(op.id).result_cid).toBe(prior.get(op.id));
      expect(written.get(op.rkey!) ?? 0).toBe(0);
    }
    for (const op of ops) if (!prior.has(op.id)) expect(written.get(op.rkey!)).toBe(1);
    expect(h.writers.sent.filter((s) => s.nsid === GET).map((s) => s.status)).toEqual(Array(4).fill(200));
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(200);
  });
}, 60_000); // hundreds of fake-PDS round trips; the nested check-ts control runs it under the full suite's load

it('a due live operation always runs before an earlier-due import operation', async () => {
  await withHarness(async (h) => {
    const imports = await importCreates(h, 3);
    h.kit.clock.advance(5_000);
    await liveListens(h, 1);
    const live = h.ops(`origin = 'lastfm'`)[0]!;
    expect(imports.every((o) => o.due_at < live.due_at)).toBe(true);

    const report = await h.run();
    // The live create first (createRecord), then the import batch.
    expect(h.writers.sent.map((s) => s.nsid)).toEqual([CREATE, APPLY]);
    expect(h.writers.sent[0]!.body?.rkey).toBe(live.rkey);
    expect((h.writers.sent[1]!.body!.writes as { rkey: string }[]).map((w) => w.rkey)).toEqual(
      imports.map((o) => o.rkey),
    );
    expect(report.batches).toEqual([3]);
    expect(h.ops().every((o) => o.state === 'succeeded')).toBe(true);
    // The PDS committed them in that order too.
    const commits = h.kit.pds.Alice.calls.filter({ status: 200 }).map((c) => c.nsid);
    expect(commits).toEqual([CREATE, APPLY]);
  });
});

it("due live creates that overflow one applyWrites batch hold back the same DID's earlier-due import until they are all sent", async () => {
  await withHarness(async (h) => {
    const [imported] = await importCreates(h, 1);
    h.kit.clock.advance(5_000);
    await liveListens(h, 250);

    const first = await h.run();
    // One batch per DID per run: 200 live creates; the import does not go ahead of the other 50.
    expect(h.writers.order()).toEqual([APPLY]);
    expect(first.batches).toEqual([200]);
    expect(first.nextDueMs).toBe(h.kit.clock.nowMs());
    expect(states(h, 'lastfm')).toEqual({ succeeded: 200, queued: 50 });
    expect(states(h, 'import')).toEqual({ queued: 1 });

    const rest = await h.runUntilIdle();
    expect(rest.flatMap((r) => r.batches)).toEqual([50]);
    expect(h.writers.order()).toEqual([APPLY, APPLY, CREATE]);
    expect(h.writers.sent[2]!.body?.rkey).toBe(imported!.rkey);
    expect(states(h, 'lastfm')).toEqual({ succeeded: 250 });
    expect(states(h, 'import')).toEqual({ succeeded: 1 });
    expect((await remoteRecords(h.kit, 'Alice', SCROBBLE)).length).toBe(251);
  });
});

it("a reauth_required DID's operations become blocked without spending attempts and complete after sign-in", async () => {
  await withHarness(async (h) => {
    h.account(h.alice);
    await liveListens(h, 2);
    // The session is gone (refresh refused): the writer source has no writer for the DID.
    h.writers.signedOut.add(h.alice);
    const report = await h.run();
    expect(report).toMatchObject({ attempted: 0, blocked: 2, nextDueMs: null });
    expect(h.ops().map((o) => [o.state, o.attempts, o.last_error])).toEqual([
      ['blocked', 0, 'reauth_required'],
      ['blocked', 0, 'reauth_required'],
    ]);
    expect(h.writers.sent).toEqual([]);

    // The account is marked reauth_required: a new listen is still accepted and waits blocked.
    h.db.run(`UPDATE accounts SET oauth_status = 'reauth_required' WHERE did = ?`, h.alice);
    await liveListens(h, 1, 10);
    expect(h.ops().map((o) => o.state)).toEqual(['blocked', 'blocked', 'blocked']);
    h.kit.clock.advance(HOUR);
    expect((await h.run()).attempted).toBe(0);

    // A PDS 401 in the middle of an attempt also blocks, and that attempt is not counted.
    h.writers.signedOut.delete(h.alice);
    h.db.run(`UPDATE accounts SET oauth_status = 'active' WHERE did = ?`, h.alice);
    h.kit.pds.Alice.fail({ nsid: APPLY }, { kind: 'status', status: 401, error: 'InvalidToken', message: 'expired' });
    let kicks = 0;
    expect(resumeAfterSignIn(h.m, h.alice, () => (kicks += 1))).toBe(3);
    expect(kicks).toBe(1);
    await h.run();
    expect(h.writers.sent.map((s) => [s.nsid, s.status])).toEqual([[APPLY, 401]]);
    expect(h.ops().map((o) => [o.state, o.attempts])).toEqual([
      ['blocked', 0],
      ['blocked', 0],
      ['blocked', 0],
    ]);

    // After sign-in they complete, each with exactly one counted attempt.
    expect(resumeAfterSignIn(h.m, h.alice)).toBe(3);
    await h.runUntilIdle();
    expect(h.ops().map((o) => [o.state, o.attempts, o.last_error])).toEqual([
      ['succeeded', 1, null],
      ['succeeded', 1, null],
      ['succeeded', 1, null],
    ]);
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(3);
  });
});

it('after a 200-write applyWrites batch all 200 URIs are queued as notify hints with no rate_limited outcome, and the verify drain indexes them through proofs', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    await liveListens(h, 200);
    const report = await h.run();
    expect(report.batches).toEqual([200]);
    const ops = h.ops();
    expect(ops.every((o) => o.state === 'succeeded')).toBe(true);

    // Every URI is a notify hint, queued with the success: no client notify RPC, no abuse bucket.
    const hints = h.db.all<{ uri: string; source: string; priority: number }>(
      'SELECT uri, source, priority FROM hints ORDER BY uri',
    );
    expect(hints).toEqual(
      ops.map((o) => ({ uri: o.result_uri, source: 'notify', priority: 0 })).sort((a, b) => (a.uri! < b.uri! ? -1 : 1)),
    );
    expect(h.log.entries.filter((e) => JSON.stringify(e).includes('rate_limited'))).toEqual([]);
    expect(h.db.all(`SELECT name FROM counters WHERE name LIKE '%rate%'`)).toEqual([]);

    // The verify drain works them: 200 hints of one DID collapse into one snapshot,
    // whose slices verify the signed repository and index every record.
    h.kit.clock.advance(2_000);
    const drained = await drain(h.m, h.kit.clock.nowMs());
    expect(drained.claimed).toBe(200);
    expect(drained.outcomes[0]).toMatchObject({ outcome: 'coalesced', detail: '200' });
    expect(drained.outcomes.slice(1).every((o) => o.outcome === 'skipped')).toBe(true);
    expect(h.db.all(`SELECT did, kind, state, reason FROM repo_jobs`)).toEqual([
      { did: h.alice, kind: 'snapshot', state: 'pending', reason: 'coalesced' },
    ]);
    expect(h.db.one<{ n: number }>('SELECT count(*) AS n FROM hints')!.n).toBe(0);
    for (let slice = 0; slice < 20; slice++) {
      h.kit.clock.advance(60_000);
      const step = await snapshotStep(h.m, h.kit.clock.nowMs());
      if (step.outcome === 'complete' || step.did === null) break;
    }
    const indexed = h.db.all<{ uri: string; cid: string }>('SELECT uri, cid FROM scrobbles ORDER BY uri');
    expect(indexed).toEqual(
      ops.map((o) => ({ uri: o.result_uri, cid: o.result_cid })).sort((a, b) => (a.uri! < b.uri! ? -1 : 1)),
    );
    expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM record_state WHERE state = 'present'`)!.n).toBe(200);
  });
});
