// W4-03 accounts.ts: account status from the account's own PDS
// (com.atproto.sync.getRepoStatus), never from relay events (A17), against
// a real SQLite file and the fixture network. Proves M4.1.1/event_types (account
// changes come from a proof-fetch error and the getRepoStatus sweep) and
// M5.3.3/account_state (a followed account that is taken down leaves its
// followers' following feed at once and stays out of it, while reactivating,
// until a complete snapshot commits under the current generation).
//
// The index is seeded through the real ingestion path: the shared fixture is
// published as real signed commits on fake PDSs and every record goes through
// the production verify drain (getRecord proof → verifier → apply). Every
// expectation is hardcoded from TESTING.md / the fixture, never computed by the
// code under test.

import { FIXTURE_USERS, type FixtureKit, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import {
  checkStatus,
  claimStatusJob,
  GET_REPO_STATUS,
  nextStatusJobDue,
  reclaimStatusLeases,
  runStatusJob,
  scheduleStatusJobsTimer,
} from '../../src/do/ingest/accounts';
import { scheduleStatusCheck } from '../../src/do/ingest/admission';
import { statusSweep } from '../../src/do/ingest/sweeps';
import { drain } from '../../src/do/ingest/verify-drain';
import { feed } from '../../src/do/read/feed';
import { history } from '../../src/do/read/history';
import { profile } from '../../src/do/read/profile';
import { dueAt } from '../../src/do/timers';
import { completeSnapshot } from '../../src/do/write/apply-snapshot';
import { seedUser } from '../write/support';
import { type Deps, depsFor, enqueue, GET_RECORD, hint, hintRows, kit } from './drain-support';
import { withIngestIndex } from './node-index';

const T0 = Date.parse('2026-01-15T12:00:00Z');
const HOUR = 3_600_000;
const ALICE_HISTORY = ['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06'];

const rkey = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

function historyOf(m: Deps, did: string): string[] {
  return history(m, { did, limit: 100 }).rows.map((r) => rkey(r.uri));
}

function globalFeed(m: Deps): string[] {
  return feed(m, { scope: 'global', limit: 100 }).rows.map((r) => rkey(r.uri));
}

function followingFeed(m: Deps, viewer: string): string[] {
  return feed(m, { scope: 'following', viewer, limit: 100 }).rows.map((r) => rkey(r.uri));
}

function user(db: Db, did: string) {
  return db.one<Record<string, unknown>>('SELECT * FROM users WHERE did = ?', did);
}

function jobs(db: Db, did: string) {
  return db.all('SELECT kind, state, reason, reactivate, generation FROM repo_jobs WHERE did = ? ORDER BY kind', did);
}

const statusCalls = (k: FixtureKit, name: 'Alice' | 'Bob' | 'Carol') =>
  k.pds[name].calls.count({ nsid: GET_REPO_STATUS });

/** Publish the shared fixture and ingest every record through the production drain. */
async function seedIndexed(db: Db, m: Deps, k: FixtureKit): Promise<void> {
  const seed = await seedReadModels(k);
  for (const n of FIXTURE_USERS) seedUser(db, k.users[n].did);
  enqueue(
    db,
    [...seed.records.values()].map((r) => hint(k, r.did, r.collection, r.rkey)),
  );
  const report = await drain(m, k.clock.nowMs());
  expect(report.claimed).toBe(seed.records.size);
  expect(hintRows(db)).toEqual([]);
  k.resetCalls();
}

describe('account status', () => {
  it('deactivated status hides Alice immediately; Bob and Carol unaffected', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;
    const carol = k.users.Carol.did;

    await withIngestIndex(async (i) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);
      expect(historyOf(m, alice)).toEqual(ALICE_HISTORY);
      expect(globalFeed(m)).toEqual(['r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
      const aliceBefore = user(db, alice)!;
      const lastGeneration = db.one<{ g: number }>('SELECT last_generation AS g FROM backfill_generation')!.g;
      const bobBefore = user(db, bob)!;
      const carolBefore = user(db, carol)!;
      const scrobblesBefore = db.all('SELECT * FROM scrobbles ORDER BY uri');
      const followsBefore = db.all('SELECT * FROM follows ORDER BY uri');

      // Alice deactivates on her PDS. No relay account event exists (kinds=commit):
      // the next proof fetch for her reports it.
      k.pds.Alice.deactivate(alice);
      const S = k.collections.scrobble;
      enqueue(db, [hint(k, alice, S, 'r01', { source: 'notify' })]);
      const drained = await drain(m, T0);
      expect(drained.outcomes).toEqual([
        { uri: `at://${alice}/${S}/r01`, outcome: 'status_job', detail: 'RepoDeactivated' },
      ]);
      expect(k.pds.Alice.calls.count({ nsid: GET_RECORD })).toBe(1);
      expect(jobs(db, alice)).toEqual([
        {
          kind: 'status',
          state: 'pending',
          reason: 'RepoDeactivated',
          reactivate: 0,
          generation: aliceBefore.generation,
        },
      ]);
      // The drain itself hides nothing; the status job is due for the sweep slice.
      expect(user(db, alice)).toEqual(aliceBefore);
      expect(scheduleStatusJobsTimer(db, T0)).toBe(T0 + 60_000);

      const report = await statusSweep(m, T0 + 60_000);
      const now = T0 + 60_000;
      expect([...report.checked].sort((a, b) => a.did.localeCompare(b.did))).toEqual([
        { did: alice, source: 'job', outcome: 'inactive', detail: 'deactivated' },
        { did: bob, source: 'sweep', outcome: 'active' },
        { did: carol, source: 'sweep', outcome: 'active' },
      ]);
      // One getRepoStatus per account; identities came from identity_cache (no PLC call).
      expect([statusCalls(k, 'Alice'), statusCalls(k, 'Bob'), statusCalls(k, 'Carol')]).toEqual([1, 1, 1]);
      expect(k.pds.Alice.calls.filter({ nsid: GET_REPO_STATUS })[0]!.params).toEqual({ did: [alice] });
      expect(k.plc.count()).toBe(0);

      // Alice: hidden at once, generation moved (an in-flight snapshot can no longer activate her).
      const aliceAfter = user(db, alice)!;
      expect(aliceAfter).toEqual({
        ...aliceBefore,
        active: 0,
        account_status: 'deactivated',
        indexing_state: 'recovering',
        generation: lastGeneration + 1,
        last_status_check_ms: now,
      });
      expect(jobs(db, alice)).toEqual([
        {
          kind: 'status',
          state: 'complete',
          reason: 'RepoDeactivated',
          reactivate: 0,
          generation: aliceBefore.generation,
        },
      ]);
      expect(historyOf(m, alice)).toEqual([]);
      expect(await profile(m, alice)).toBeNull();
      expect(globalFeed(m)).toEqual(['r09', 'r10']);
      // Her rows stay stored (hidden, not deleted), so a reactivation re-snapshot is incremental.
      expect(db.all('SELECT * FROM scrobbles ORDER BY uri')).toEqual(scrobblesBefore);
      expect(db.all('SELECT * FROM follows ORDER BY uri')).toEqual(followsBefore);

      // Bob and Carol: only the check time moved; their data and visibility are unchanged.
      expect(user(db, bob)).toEqual({ ...bobBefore, last_status_check_ms: now });
      expect(user(db, carol)).toEqual({ ...carolBefore, last_status_check_ms: now });
      expect(historyOf(m, bob)).toEqual(['r09']);
      expect(historyOf(m, carol)).toEqual(['r10']);
      const bobProfile = await profile(m, bob);
      expect(bobProfile).toMatchObject({ did: bob, totalScrobbles: 1, followingCount: 0 });
      // Alice→Bob is hidden with its actor.
      expect(bobProfile?.followerCount).toBe(0);
      expect(await profile(m, carol)).toMatchObject({ did: carol, totalScrobbles: 1 });
      expect(jobs(db, bob)).toEqual([]);
      expect(jobs(db, carol)).toEqual([]);
      expect(db.all("SELECT label, value FROM counters WHERE name = 'account_hidden'")).toEqual([
        { label: 'deactivated', value: 1 },
      ]);

      // A second check of the still-deactivated account rewrites nothing but the check time.
      k.resetCalls();
      const again = await statusSweep(m, now + 2 * HOUR);
      expect(again.checked.map((c) => [c.did, c.outcome]).sort()).toEqual([
        [alice, 'inactive'],
        [bob, 'active'],
        [carol, 'active'],
      ]);
      expect(user(db, alice)).toEqual({ ...aliceAfter, last_status_check_ms: now + 2 * HOUR });
      expect([statusCalls(k, 'Alice'), statusCalls(k, 'Bob'), statusCalls(k, 'Carol')]).toEqual([1, 1, 1]);
      expect(dueAt(db, 'status-sweep')).toBe(now + 3 * HOUR);
    });
  });

  it('reactivated status schedules snapshot and keeps hidden until completion', async () => {
    // M5.3.3/account_state: Bob, whom Alice follows, is taken down and comes back.
    // His scrobble leaves Alice's following feed (and the global feed) while he is
    // inactive and while his reactivation snapshot is pending, and returns only
    // after that snapshot completes under the current generation.
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;
    const carol = k.users.Carol.did;

    await withIngestIndex(async (i) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);
      const genBefore = user(db, bob)!.generation as number;
      expect(followingFeed(m, alice)).toEqual(['r09']);
      expect(globalFeed(m)).toEqual(['r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
      expect(await profile(m, alice)).toMatchObject({ followingCount: 1 });

      // Takedown, seen by the hourly sweep.
      k.pds.Bob.takedown(bob);
      const first = await statusSweep(m, T0);
      expect([...first.checked].sort((a, b) => a.did.localeCompare(b.did))).toEqual([
        { did: alice, source: 'sweep', outcome: 'active' },
        { did: bob, source: 'sweep', outcome: 'inactive', detail: 'takendown' },
        { did: carol, source: 'sweep', outcome: 'active' },
      ]);
      const hidden = user(db, bob)!;
      expect(hidden).toMatchObject({ active: 0, account_status: 'takendown', indexing_state: 'recovering' });
      const genHidden = hidden.generation as number;
      expect(genHidden).toBeGreaterThan(genBefore);
      // Hidden from every read at once: the follower's following feed, the global feed,
      // his history and his profile. The follower herself is unaffected.
      expect(followingFeed(m, alice)).toEqual([]);
      expect(globalFeed(m)).toEqual(['r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
      expect(historyOf(m, bob)).toEqual([]);
      expect(await profile(m, bob)).toBeNull();
      expect(historyOf(m, alice)).toEqual(ALICE_HISTORY);
      // The Alice→Bob edge stays stored (hidden with its subject), so it comes back unchanged.
      expect(db.all('SELECT actor, subject FROM follows')).toEqual([{ actor: alice, subject: bob }]);

      // Active again on the PDS: the next hourly check schedules the reactivation snapshot,
      // and Bob stays hidden.
      k.pds.Bob.reactivate(bob);
      k.resetCalls();
      const t1 = T0 + HOUR;
      const second = await statusSweep(m, t1);
      expect(second.checked.find((c) => c.did === bob)).toEqual({
        did: bob,
        source: 'sweep',
        outcome: 'reactivating',
        detail: 'scheduled',
      });
      expect(statusCalls(k, 'Bob')).toBe(1);
      expect(user(db, bob)).toEqual({
        ...hidden,
        account_status: 'active',
        indexing_state: 'recovering',
        last_status_check_ms: t1,
      });
      expect(jobs(db, bob)).toEqual([
        { kind: 'snapshot', state: 'pending', reason: 'reactivation', reactivate: 1, generation: genHidden },
      ]);
      expect(db.one("SELECT due_at FROM repo_jobs WHERE did = ? AND kind = 'snapshot'", bob)).toEqual({ due_at: t1 });
      expect(dueAt(db, 'snapshot')).toBe(t1);
      expect(followingFeed(m, alice)).toEqual([]);
      expect(historyOf(m, bob)).toEqual([]);
      expect(await profile(m, bob)).toBeNull();

      // Still active an hour later and the snapshot not finished: nothing new, still hidden.
      const t2 = T0 + 2 * HOUR;
      const third = await statusSweep(m, t2);
      expect(third.checked.find((c) => c.did === bob)?.outcome).toBe('active');
      expect(jobs(db, bob)).toEqual([
        { kind: 'snapshot', state: 'pending', reason: 'reactivation', reactivate: 1, generation: genHidden },
      ]);
      expect(user(db, bob)).toMatchObject({ active: 0, generation: genHidden, last_status_check_ms: t2 });
      expect(followingFeed(m, alice)).toEqual([]);
      expect(historyOf(m, bob)).toEqual([]);

      // A snapshot of the generation before the takedown can no longer activate him.
      const head = k.repos.Bob.head!;
      const nowNs = BigInt(t2) * 1_000_000n;
      const stale = db.tx(() =>
        completeSnapshot(db, { did: bob, generation: genBefore, headRev: head.rev, accountActive: true, nowNs }),
      );
      expect(stale).toEqual({ outcome: 'superseded' });
      expect(user(db, bob)).toMatchObject({ active: 0, indexing_state: 'recovering' });
      expect(followingFeed(m, alice)).toEqual([]);
      expect(globalFeed(m)).toEqual(['r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);

      // The reactivation snapshot completes under the current generation: visible again,
      // in the follower's following feed too, with his history exactly as before.
      const done = db.tx(() =>
        completeSnapshot(db, { did: bob, generation: genHidden, headRev: head.rev, accountActive: true, nowNs }),
      );
      expect(done).toEqual({ outcome: 'complete', active: true });
      expect(user(db, bob)).toMatchObject({
        active: 1,
        account_status: 'active',
        indexing_state: 'current',
        last_snapshot_at_ms: t2,
      });
      expect(followingFeed(m, alice)).toEqual(['r09']);
      expect(globalFeed(m)).toEqual(['r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
      expect(historyOf(m, bob)).toEqual(['r09']);
      expect(await profile(m, bob)).toMatchObject({ did: bob, totalScrobbles: 1, followerCount: 1 });
    });
  });

  it('a status job orphaned in running by an eviction is reclaimed and run by a later sweep', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;
    const carol = k.users.Carol.did;

    await withIngestIndex(async (i) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);
      // Every account was just swept, so no sweep check is due: only the job can see Alice.
      db.run('UPDATE users SET last_status_check_ms = ?', T0);
      k.pds.Alice.deactivate(alice);
      enqueue(db, [hint(k, alice, k.collections.scrobble, 'r01', { source: 'notify' })]);
      expect((await drain(m, T0)).outcomes.map((o) => o.outcome)).toEqual(['status_job']);
      k.resetCalls();

      // An instance claims the job, then is evicted before finishing it.
      const claimedAt = T0 + 60_000;
      expect(db.tx(() => claimStatusJob(db, alice, claimedAt))).not.toBeNull();
      const jobRow = () =>
        db.one("SELECT state, due_at, attempts FROM repo_jobs WHERE did = ? AND kind = 'status'", alice);
      expect(jobRow()).toEqual({ state: 'running', due_at: claimedAt, attempts: 0 });
      // A running row is invisible to the due queries: without a reclaim it would stay forever.
      expect(nextStatusJobDue(db)).toBeNull();
      expect(scheduleStatusJobsTimer(db, claimedAt)).toBeNull();

      // The drain asks again while it is "running": the claim time (lease start) does not move.
      expect(scheduleStatusCheck(db, alice, 'RepoDeactivated', claimedAt + 10 * 60_000)).toEqual({
        status: 'scheduled',
      });
      expect(jobRow()).toEqual({ state: 'running', due_at: claimedAt, attempts: 0 });

      // A sweep inside the lease leaves the claim alone: nothing checked, Alice still visible.
      const early = await statusSweep(m, claimedAt + 14 * 60_000);
      expect(early).toMatchObject({ checked: [], reclaimed: [], passedOver: 0 });
      expect(statusCalls(k, 'Alice')).toBe(0);
      expect(jobRow()).toMatchObject({ state: 'running' });
      expect(historyOf(m, alice)).toEqual(ALICE_HISTORY);

      // The first sweep past the 15 min lease reclaims it and runs it in the same slice.
      const late = claimedAt + 15 * 60_000;
      const report = await statusSweep(m, late);
      expect(report.reclaimed).toEqual([alice]);
      expect(report.checked).toEqual([{ did: alice, source: 'job', outcome: 'inactive', detail: 'deactivated' }]);
      expect(statusCalls(k, 'Alice')).toBe(1);
      expect([statusCalls(k, 'Bob'), statusCalls(k, 'Carol')]).toEqual([0, 0]);
      expect(jobRow()).toEqual({ state: 'complete', due_at: late, attempts: 0 });
      expect(user(db, alice)).toMatchObject({ active: 0, account_status: 'deactivated', last_status_check_ms: late });
      expect(historyOf(m, alice)).toEqual([]);
      expect(historyOf(m, bob)).toEqual(['r09']);
      expect(historyOf(m, carol)).toEqual(['r10']);
      expect(db.all("SELECT label, value FROM counters WHERE name = 'status_reclaimed'")).toEqual([
        { label: 'lease', value: 1 },
      ]);

      // At IndexDO start-up every running row is orphaned, whatever its age.
      scheduleStatusCheck(db, bob, 'RepoTakendown', late);
      expect(db.tx(() => claimStatusJob(db, bob, late))).not.toBeNull();
      expect(reclaimStatusLeases(db, late + 1)).toEqual([]);
      expect(reclaimStatusLeases(db, late + 1, { all: true })).toEqual([bob]);
      expect(db.one("SELECT state, due_at FROM repo_jobs WHERE did = ? AND kind = 'status'", bob)).toEqual({
        state: 'pending',
        due_at: late,
      });
      expect(nextStatusJobDue(db)).toBe(late);
    });
  });
});

// How a PDS / PLC answer is read (Rust oracle crates/atproto/src/sync/accounts.rs
// `PdsAccountSource`): an answer about another DID is not an answer; an XRPC
// RepoNotFound is an inactive account; a gone DID document is a deleted account.
describe('account status answers', () => {
  it('a getRepoStatus answer naming another DID is rejected and changes no account', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;

    await withIngestIndex(async (i) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);
      const usersBefore = db.all('SELECT * FROM users ORDER BY did');
      const lastGeneration = db.one<{ g: number }>('SELECT last_generation AS g FROM backfill_generation')!.g;

      // Alice's PDS answers with an inactive status about Bob.
      k.pds.Alice.fail(
        { nsid: GET_REPO_STATUS },
        {
          kind: 'respond',
          respond: () =>
            new Response(JSON.stringify({ did: bob, active: false, status: 'takendown' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        },
      );
      expect(await checkStatus(m, alice, { now: T0 })).toEqual({ outcome: 'failed', error: 'response:invalid' });
      expect(k.pds.Alice.calls.filter({ nsid: GET_REPO_STATUS }).map((c) => [c.did, c.status, c.fault])).toEqual([
        [alice, 200, 'respond'],
      ]);

      // Neither Alice nor Bob changed: no row, generation, check time or visibility moved.
      expect(db.all('SELECT * FROM users ORDER BY did')).toEqual(usersBefore);
      expect(db.one<{ g: number }>('SELECT last_generation AS g FROM backfill_generation')!.g).toBe(lastGeneration);
      expect(historyOf(m, alice)).toEqual(ALICE_HISTORY);
      expect(historyOf(m, bob)).toEqual(['r09']);
      expect(followingFeed(m, alice)).toEqual(['r09']);
      expect(globalFeed(m)).toEqual(['r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
      expect(db.all("SELECT label, value FROM counters WHERE name = 'account_hidden'")).toEqual([]);
      expect(db.all("SELECT label, value FROM counters WHERE name = 'status_check_failed'")).toEqual([
        { label: 'response', value: 1 },
      ]);
      expect(db.all('SELECT * FROM host_backoff')).toEqual([]);

      // The PDS's own answer about Alice (active) is then accepted: only the check time moves.
      expect(await checkStatus(m, alice, { now: T0 + 1 })).toEqual({ outcome: 'active' });
      expect(user(db, alice)).toEqual({
        ...(usersBefore.find((u) => (u as { did: string }).did === alice) as Record<string, unknown>),
        last_status_check_ms: T0 + 1,
      });
    });
  });

  it('getRepoStatus RepoNotFound hides the account as not_found and moves its generation', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;
    const carol = k.users.Carol.did;

    await withIngestIndex(async (i) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);
      const aliceBefore = user(db, alice)!;
      const lastGeneration = db.one<{ g: number }>('SELECT last_generation AS g FROM backfill_generation')!.g;

      // The repo is gone from Alice's PDS: getRepoStatus answers 400 RepoNotFound.
      k.pds.Alice.removeAccount(alice);
      const report = await statusSweep(m, T0);
      expect([...report.checked].sort((a, b) => a.did.localeCompare(b.did))).toEqual([
        { did: alice, source: 'sweep', outcome: 'inactive', detail: 'not_found' },
        { did: bob, source: 'sweep', outcome: 'active' },
        { did: carol, source: 'sweep', outcome: 'active' },
      ]);
      expect(k.pds.Alice.calls.filter({ nsid: GET_REPO_STATUS }).map((c) => [c.did, c.status])).toEqual([[alice, 400]]);

      expect(user(db, alice)).toEqual({
        ...aliceBefore,
        active: 0,
        account_status: 'not_found',
        indexing_state: 'recovering',
        generation: lastGeneration + 1,
        last_status_check_ms: T0,
      });
      expect(historyOf(m, alice)).toEqual([]);
      expect(await profile(m, alice)).toBeNull();
      expect(globalFeed(m)).toEqual(['r09', 'r10']);
      expect(historyOf(m, bob)).toEqual(['r09']);
      expect(db.all("SELECT label, value FROM counters WHERE name = 'account_hidden'")).toEqual([
        { label: 'not_found', value: 1 },
      ]);
      // An account answer, not a host failure: the host is not paused.
      expect(db.all('SELECT * FROM host_backoff')).toEqual([]);
      expect(db.all("SELECT label, value FROM counters WHERE name = 'status_check_failed'")).toEqual([]);
    });
  });

  it('a DID document gone from PLC (410 tombstone, 404) hides the account as deleted', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;
    const carol = k.users.Carol.did;

    await withIngestIndex(async (i) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);
      const aliceBefore = user(db, alice)!;
      const bobBefore = user(db, bob)!;
      const carolBefore = user(db, carol)!;
      const lastGeneration = db.one<{ g: number }>('SELECT last_generation AS g FROM backfill_generation')!.g;

      // Alice's DID is tombstoned (410); Bob's document answers 404. The cached
      // identities expire (5 min TTL), so the sweep resolves every DID again.
      k.plc.tombstone(alice);
      k.plc.fail({ did: bob }, { kind: 'status', status: 404 });
      k.clock.advance(6 * 60_000);
      const now = k.clock.nowMs();
      const report = await statusSweep(m, now);
      expect([...report.checked].sort((a, b) => a.did.localeCompare(b.did))).toEqual(
        [
          { did: alice, source: 'sweep', outcome: 'inactive', detail: 'deleted' },
          { did: bob, source: 'sweep', outcome: 'inactive', detail: 'deleted' },
          { did: carol, source: 'sweep', outcome: 'active' },
        ].sort((a, b) => a.did.localeCompare(b.did)),
      );
      expect(k.plc.calls.filter({ did: alice }).map((c) => c.status)).toEqual([410]);
      expect(k.plc.calls.filter({ did: bob }).map((c) => c.status)).toEqual([404]);
      // A deleted account's PDS is never asked.
      expect([statusCalls(k, 'Alice'), statusCalls(k, 'Bob'), statusCalls(k, 'Carol')]).toEqual([0, 0, 1]);

      const gens = [user(db, alice)!.generation as number, user(db, bob)!.generation as number].sort((a, b) => a - b);
      expect(gens).toEqual([lastGeneration + 1, lastGeneration + 2]);
      expect(user(db, alice)).toEqual({
        ...aliceBefore,
        active: 0,
        account_status: 'deleted',
        indexing_state: 'recovering',
        generation: user(db, alice)!.generation,
        last_status_check_ms: now,
      });
      expect(user(db, bob)).toEqual({
        ...bobBefore,
        active: 0,
        account_status: 'deleted',
        indexing_state: 'recovering',
        generation: user(db, bob)!.generation,
        last_status_check_ms: now,
      });
      expect(user(db, carol)).toEqual({ ...carolBefore, last_status_check_ms: now });
      expect(historyOf(m, alice)).toEqual([]);
      expect(historyOf(m, bob)).toEqual([]);
      expect(await profile(m, alice)).toBeNull();
      expect(await profile(m, bob)).toBeNull();
      expect(globalFeed(m)).toEqual(['r10']);
      expect(historyOf(m, carol)).toEqual(['r10']);
      expect(db.all("SELECT label, value FROM counters WHERE name = 'account_hidden'")).toEqual([
        { label: 'deleted', value: 2 },
      ]);
      expect(db.all("SELECT label, value FROM counters WHERE name = 'status_check_failed'")).toEqual([]);
    });
  });
});

describe('status jobs', () => {
  it('a status job requested again while its check runs is pending again; a failed check backs off 1 s, 2 s, 4 s', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const OTHER = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz';

    await withIngestIndex(async (i) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);
      const jobRow = () =>
        db.one<{ state: string; attempts: number; due_at: number; failure_code: string | null; updated_at_ms: number }>(
          "SELECT state, attempts, due_at, failure_code, updated_at_ms FROM repo_jobs WHERE did = ? AND kind = 'status'",
          alice,
        );

      // 1. The drain asks again (a new RepoDeactivated proof error) while the check is in flight:
      //    the claim's lease token moved, so the answered job is pending again, not complete.
      expect(scheduleStatusCheck(db, alice, 'RepoDeactivated', T0)).toEqual({ status: 'scheduled' });
      let requested = 0;
      k.pds.Alice.fail(
        { nsid: GET_REPO_STATUS },
        {
          kind: 'respond',
          respond: () => {
            requested++;
            expect(scheduleStatusCheck(db, alice, 'RepoDeactivated', T0 + 5)).toEqual({ status: 'scheduled' });
            return Response.json({ did: alice, active: true });
          },
        },
      );
      expect(await runStatusJob(m, alice, T0)).toEqual({ outcome: 'active' });
      expect(requested).toBe(1);
      expect(jobRow()).toMatchObject({ state: 'pending', attempts: 0, due_at: T0, failure_code: null });
      expect(nextStatusJobDue(db)).toBe(T0);
      // The next run answers it for good.
      expect(await runStatusJob(m, alice, T0 + 10)).toEqual({ outcome: 'active' });
      expect(jobRow()).toMatchObject({ state: 'complete', attempts: 0, failure_code: null });
      expect(statusCalls(k, 'Alice')).toBe(2);
      expect(nextStatusJobDue(db)).toBeNull();

      // 2. Failed checks (an answer about another DID is no answer) back off 1 s, 2 s, 4 s.
      const T1 = T0 + HOUR;
      scheduleStatusCheck(db, alice, 'RepoDeactivated', T1);
      k.pds.Alice.fail(
        { nsid: GET_REPO_STATUS },
        { kind: 'respond', respond: () => Response.json({ did: OTHER, active: false }) },
        3,
      );
      expect(await runStatusJob(m, alice, T1)).toEqual({ outcome: 'failed', error: 'response:invalid' });
      expect(jobRow()).toMatchObject({
        state: 'failed',
        attempts: 1,
        due_at: T1 + 1_000,
        failure_code: 'response:invalid',
      });
      // Not due inside the backoff: nothing is claimed or fetched.
      expect(await runStatusJob(m, alice, T1 + 999)).toBeNull();
      expect(statusCalls(k, 'Alice')).toBe(3);
      expect(nextStatusJobDue(db)).toBe(T1 + 1_000);
      expect(await runStatusJob(m, alice, T1 + 1_000)).toMatchObject({ outcome: 'failed' });
      expect(jobRow()).toMatchObject({ state: 'failed', attempts: 2, due_at: T1 + 3_000 });
      expect(await runStatusJob(m, alice, T1 + 3_000)).toMatchObject({ outcome: 'failed' });
      expect(jobRow()).toMatchObject({ state: 'failed', attempts: 3, due_at: T1 + 7_000 });
      expect(statusCalls(k, 'Alice')).toBe(5);
      // The PDS answers again: complete, the failure cleared.
      expect(await runStatusJob(m, alice, T1 + 7_000)).toEqual({ outcome: 'active' });
      expect(jobRow()).toMatchObject({ state: 'complete', attempts: 0, failure_code: null });
      expect(db.all("SELECT label, value FROM counters WHERE name = 'status_check_failed'")).toEqual([
        { label: 'response', value: 3 },
      ]);
      // No failed check changed the account.
      expect(user(db, alice)).toMatchObject({ active: 1, account_status: 'active' });
      expect(historyOf(m, alice)).toEqual(ALICE_HISTORY);

      // 3. A failed check that was requested again meanwhile is due at once, not backed off.
      const T2 = T1 + HOUR;
      scheduleStatusCheck(db, alice, 'RepoDeactivated', T2);
      k.pds.Alice.fail(
        { nsid: GET_REPO_STATUS },
        {
          kind: 'respond',
          respond: () => {
            scheduleStatusCheck(db, alice, 'RepoTakendown', T2 + 5);
            return Response.json({ did: OTHER, active: true });
          },
        },
      );
      expect(await runStatusJob(m, alice, T2)).toMatchObject({ outcome: 'failed' });
      expect(jobRow()).toMatchObject({ state: 'failed', attempts: 1, due_at: T2, failure_code: 'response:invalid' });
      expect(nextStatusJobDue(db)).toBe(T2);
    });
  });
});
