// W4-01 snapshot-job.ts: resumable range snapshots (ADR 0004 §5.7) against real
// DO SQLite and the fixture network (real signed repositories on fake PDSs,
// fake PLC and DoH, the production SafeFetch policy, identity resolver,
// commit verifier, range walker and projection apply). Proves
// M4.2.2/historical_seed and M4.2.3/pds_migration, plus the job lifecycle
// obligations of the W4-01 plan entry (resume after eviction, missing_block
// restarts, getRepo fallback, coalescing during a walk). Every expectation is
// hardcoded from TESTING.md or comes from the fixture signer, never from the
// code under test.

import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import {
  type FixtureKit,
  followRkey,
  type SeedResult,
  seedReadModels,
} from '@atmusic/atproto/test-support/read-models';
import type { FixtureTransport } from '@atmusic/atproto/test-support/router-transport';
import { describe, expect, it } from 'vitest';
import { BUDGETS, type Plan, type SliceBudget } from '../../src/config';
import type { RepoJobRow } from '../../src/do/contracts';
import type { Db } from '../../src/do/db';
import { admit, reclaimSnapshotLeases, scheduleSnapshot } from '../../src/do/ingest/admission';
import { cachedIdentityResolver } from '../../src/do/ingest/identity-cache';
import {
  REPOSITORY_CHANGED,
  REPOSITORY_CHANGED_BACKOFF_MS,
  type SnapshotStepReport,
  snapshotStep,
} from '../../src/do/ingest/snapshot-job';
import { drain } from '../../src/do/ingest/verify-drain';
import { history } from '../../src/do/read/history';
import { markConnected, recordEvent, updateCheckpointBookkeeping } from '../../src/do/status';
import { dueAt } from '../../src/do/timers';
import type { HarnessDO } from '../harness/harness-do';
import { counterValue, type Deps, depsFor, enqueue, hint, kit, protectedTables } from './drain-support';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const T0 = Date.parse('2026-01-15T12:00:00Z');
const GET_BLOCKS = 'com.atproto.sync.getBlocks';
const GET_REPO = 'com.atproto.sync.getRepo';
const LATEST = 'com.atproto.sync.getLatestCommit';
const STATUS = 'com.atproto.sync.getRepoStatus';
/** TESTING.md: Alice's history, newest first (r07 and r01 share 11:00; URI breaks the tie). */
const ALICE_HISTORY = ['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06'];

// ---------------------------------------------------------------------------
// Helpers (test-only)

type Before = (req: Request, url: URL) => Promise<Response | undefined> | Response | undefined;

/** The kit's fixture transport plus extra fake PDS hosts and a pre-request hook. */
function wrap(base: FixtureTransport, o: { extra?: FakePds[]; before?: Before } = {}): FixtureTransport {
  const extra = o.extra ?? [];
  const t = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const early = await o.before?.(req, url);
    if (early !== undefined) return early;
    const pds = extra.find((p) => p.host === url.hostname);
    return pds ? pds.fetch(req) : base(req);
  };
  return Object.assign(t, {
    fixture: true as const,
    calls: base.calls,
    hostnames: () => [...base.hostnames(), ...extra.map((p) => p.host)],
  });
}

/** ModuleDeps over the harness Db, following the upstream in socket mode (so `indexing()` can be current). */
function deps(db: Db, k: FixtureKit, o: { plan?: Plan; transport?: FixtureTransport } = {}): Deps {
  const base = depsFor(db, k, { plan: o.plan ?? 'paid' });
  const transport = o.transport ?? k.transport;
  return {
    ...base,
    transport,
    identity: cachedIdentityResolver(db, { transport, clock: k.clock }),
    config: { ...base.config, ingestMode: 'socket' },
  };
}

/** A connected socket with a cursor and no gap: the global indexing state is `current`. */
function followUpstream(db: Db): void {
  db.tx(() => {
    markConnected(db, T0);
    recordEvent(db, { cursor: 1, timeUs: T0 * 1000 });
    updateCheckpointBookkeeping(db, { pendingGap: false });
  });
}

async function runUntilIdle(m: Deps, now: number, budget?: SliceBudget, max = 60): Promise<SnapshotStepReport[]> {
  const out: SnapshotStepReport[] = [];
  for (let i = 0; i < max; i++) {
    const r = await snapshotStep(m, now, budget);
    if (r.outcome === 'idle') return out;
    out.push(r);
  }
  throw new Error(`snapshot jobs did not settle in ${max} slices`);
}

function job(db: Db, did: string): RepoJobRow | null {
  return db.one<RepoJobRow>(`SELECT * FROM repo_jobs WHERE did = ? AND kind = 'snapshot'`, did);
}

function scrobbles(db: Db, did: string) {
  return db.all<{ uri: string; cid: string; revision: string }>(
    'SELECT uri, cid, revision FROM scrobbles WHERE did = ? ORDER BY uri',
    did,
  );
}

function follows(db: Db, did: string) {
  return db.all<{ uri: string; cid: string; subject: string; revision: string }>(
    'SELECT uri, cid, subject, revision FROM follows WHERE actor = ? ORDER BY uri',
    did,
  );
}

function recordStates(db: Db, did: string) {
  return db.all<{ uri: string; cid: string | null; state: string; revision: string }>(
    'SELECT uri, cid, state, revision FROM record_state WHERE did = ? ORDER BY uri',
    did,
  );
}

function cachedCids(db: Db, did: string): string[] {
  return db.all<{ cid: string }>('SELECT cid FROM snapshot_blocks WHERE did = ? ORDER BY cid', did).map((r) => r.cid);
}

/** The visible history page of `did` (the production read module). */
function historyRkeys(m: Deps, did: string): string[] {
  return history(m, { did, limit: 100 }).rows.map((r) => r.rkey);
}

const getBlocksCids = (pds: FakePds) => pds.calls.filter({ nsid: GET_BLOCKS }).flatMap((c) => c.params.cids ?? []);

/** Alice's records as the fixture signer produced them. */
function aliceRecords(k: FixtureKit, seed: SeedResult, followUri: string) {
  const alice = k.users.Alice.did;
  const S = k.collections.scrobble;
  const scrobbleRows = ['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07'].map((rkey) => {
    const uri = `at://${alice}/${S}/${rkey}`;
    return { uri, cid: seed.records.get(uri)!.cid };
  });
  const follow = { uri: followUri, cid: seed.records.get(followUri)!.cid };
  return { scrobbleRows, follow };
}

async function seeded() {
  const k = await kit();
  const seed = await seedReadModels(k);
  const alice = k.users.Alice.did;
  const followUri = `at://${alice}/${k.collections.follow}/${await followRkey(k.users.Bob.did)}`;
  return { k, seed, alice, followUri, ...aliceRecords(k, seed, followUri) };
}

/** Let pending microtasks and I/O callbacks run (no clock involved). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------

describe('snapshot jobs', () => {
  it('new DID snapshot imports r01–r07 and activates; r08 absent', async () => {
    const { k, seed, alice, scrobbleRows, follow } = await seeded();
    const S = k.collections.scrobble;
    const head = seed.heads.Alice;
    const r08 = `at://${alice}/${S}/r08`;
    expect(seed.records.get(r08)!.state).toBe('deleted');
    // Every block the walk may need: the commit, each MST node and each record (all keys are in range).
    const reachable = await k.repos.Alice.reachable(k.repos.Alice.head!.data);

    await runInDurableObject(stubFor('snapshot-historical-seed'), async (i: HarnessDO) => {
      const db = i.db;
      const m = deps(db, k);
      followUpstream(db);
      // The real admission path: an unknown DID becomes an inactive owner plus a snapshot job.
      expect(admit(db, alice, 'jetstream', T0)).toEqual({ status: 'admitted', generation: 1 });
      expect(historyRkeys(m, alice)).toEqual([]);
      expect(history(m, { did: alice, limit: 20 }).indexing.state).toBe('recovering');

      const reports = await runUntilIdle(m, T0);
      expect(reports.map((r) => [r.did, r.outcome, r.source, r.restarts])).toEqual([
        [alice, 'complete', 'getBlocks', 0],
      ]);

      // Exactly r01–r07 and the Alice→Bob follow, at the signed head, with the signer's CIDs.
      expect(scrobbles(db, alice)).toEqual(scrobbleRows.map((r) => ({ ...r, revision: head.rev })));
      expect(follows(db, alice)).toEqual([{ ...follow, subject: k.users.Bob.did, revision: head.rev }]);
      expect(recordStates(db, alice)).toEqual(
        [follow, ...scrobbleRows].map((r) => ({ ...r, state: 'present', revision: head.rev })),
      );
      // r08 was created and deleted before the snapshot: no row, no state, not in history.
      expect(db.one('SELECT uri FROM scrobbles WHERE uri = ?', r08)).toBeNull();
      expect(db.one('SELECT uri FROM record_state WHERE uri = ?', r08)).toBeNull();

      // Activated and current, visible through the production history read.
      expect(
        db.one(
          'SELECT active, account_status, indexing_state, max_rev, last_snapshot_at_ms, pds FROM users WHERE did = ?',
          alice,
        ),
      ).toEqual({
        active: 1,
        account_status: 'active',
        indexing_state: 'current',
        max_rev: head.rev,
        last_snapshot_at_ms: T0,
        pds: k.users.Alice.origin,
      });
      expect(historyRkeys(m, alice)).toEqual(ALICE_HISTORY);
      const page = history(m, { did: alice, limit: 2 });
      expect(page.rows.map((r) => r.rkey)).toEqual(['r07', 'r01']);
      expect(page.indexing).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T12:00:00.000000000Z',
        lagSeconds: 0,
      });

      // The job is complete, its block cache cleared, and nothing else is scheduled.
      const done = job(db, alice)!;
      expect([done.state, done.reason, done.failure_code, done.frontier_json, done.head_cid, done.head_rev]).toEqual([
        'complete',
        'admission',
        null,
        null,
        null,
        head.rev,
      ]);
      expect(cachedCids(db, alice)).toEqual([]);
      expect(counterValue(db, 'snapshot_completed', 'admission')).toBe(1);
      expect(dueAt(db, 'snapshot')).toBeNull();
      // Bob and Carol are untouched.
      expect(db.all('SELECT did FROM users ORDER BY did')).toEqual([{ did: alice }]);
    });

    // Remote calls: status before and after, one getLatestCommit, every needed
    // block requested exactly once (commit, MST nodes, the eight records).
    const pds = k.pds.Alice;
    expect(pds.count(STATUS, alice)).toBe(2);
    expect(pds.count(LATEST, alice)).toBe(1);
    expect(pds.count(GET_REPO)).toBe(0);
    const requested = getBlocksCids(pds);
    expect(new Set(requested).size).toBe(requested.length);
    expect(new Set(requested)).toEqual(new Set([head.cid, ...reachable]));
    expect(k.plc.count(alice)).toBe(1);
    expect(k.pds.Bob.count()).toBe(0);
    expect(k.pds.Carol.count()).toBe(0);
  });

  it('job resumes across alarms from persisted frontier after DO eviction', async () => {
    const { k, seed, alice, follow, scrobbleRows } = await seeded();
    const head = seed.heads.Alice;
    const stub = stubFor('snapshot-resume-eviction');
    const budget: SliceBudget = { ...BUDGETS.free, maxEntriesPerSlice: 3 };
    let hang = false;
    let hung = 0;
    /** The production resolver, except that while `hang` is set a resolution never settles. */
    const withHang = (m: Deps): Deps => ({
      ...m,
      identity: {
        resolveDid: (did, o) => {
          if (!hang) return m.identity.resolveDid(did, o);
          hung++;
          return new Promise(() => {}); // dies with the instance
        },
        resolveHandle: (handle) => m.identity.resolveHandle(handle),
      },
    });
    const saved: { job?: RepoJobRow; cached?: string[]; orphan?: Promise<unknown>; instance?: HarnessDO } = {};

    // Slice 1 (Free plan): three entries applied, the frontier persisted, still hidden.
    await runInDurableObject(stub, async (i: HarnessDO) => {
      const db = i.db;
      const m = deps(db, k, { plan: 'free' });
      admit(db, alice, 'jetstream', T0);
      const before = k.transport.calls.entries.length;
      const r = await snapshotStep(m, T0, budget);
      expect([r.outcome, r.entries, r.chunks]).toEqual(['paused', 3, 1]);
      // The Free plan's 40 subrequests per step: reserved and actually sent.
      expect(r.subrequests).toBeLessThanOrEqual(40);
      expect(k.transport.calls.entries.length - before).toBeLessThanOrEqual(40);
      const persisted = job(db, alice)!;
      saved.job = persisted;
      expect(persisted).toMatchObject({ state: 'pending', head_cid: head.cid, head_rev: head.rev, restarts: 0 });
      expect(persisted.frontier_json).not.toBeNull();
      // Keys in order: the follow, then r01, r02.
      expect(follows(db, alice).map((f) => f.uri)).toEqual([follow.uri]);
      expect(scrobbles(db, alice).map((s) => s.uri)).toEqual(scrobbleRows.slice(0, 2).map((s) => s.uri));
      expect(db.one('SELECT active FROM users WHERE did = ?', alice)).toEqual({ active: 0 });
      expect(historyRkeys(m, alice)).toEqual([]);
      saved.cached = cachedCids(db, alice);
      expect(saved.cached.length).toBeGreaterThan(0);
    });
    const callsSlice1 = k.pds.Alice.calls.entries.length;

    const persisted = saved.job!;
    const cachedBefore = saved.cached!;
    // Six minutes later the cached identity has expired (5 min TTL). Slice 2
    // claims the job and dies with the instance while it re-resolves the DID.
    k.clock.advance(6 * 60_000);
    const t1 = T0 + 6 * 60_000;
    await runInDurableObject(stub, async (i: HarnessDO) => {
      const db = i.db;
      const m = withHang(deps(db, k, { plan: 'free' }));
      hang = true;
      saved.orphan = snapshotStep(m, t1, budget);
      saved.orphan.catch(() => {});
      await until(() => hung === 1, 'the hanging identity resolution');
      saved.instance = i;
      const running = job(db, alice)!;
      expect(running.state).toBe('running');
      expect(running.updated_at_ms).toBeGreaterThan(persisted.updated_at_ms);
      expect(running.frontier_json).toBe(persisted.frontier_json);
    });
    expect(saved.orphan).toBeDefined();
    // The instance is evicted with the slice in flight; its storage is kept.
    // (Graceful eviction waits for the instance's requests to drain, including
    // slice 1's finished fetches, whose 10 s SafeFetch deadline timers are still
    // armed: this takes ~10 s of wall time. The orphaned slice itself never
    // settles, so the outcome does not depend on that timing.)
    const evicted = saved.instance!;
    await evictDurableObject(stub);
    hang = false;

    // The new instance reclaims the orphan at start-up and resumes from the persisted frontier.
    await runInDurableObject(stub, async (i: HarnessDO) => {
      const db = i.db;
      expect(i).not.toBe(evicted);
      const m = deps(db, k, { plan: 'free' });
      const orphaned = job(db, alice)!;
      expect(orphaned.state).toBe('running');
      // Not yet past its 15-minute lease, so only the start-up reclaim (all: true) frees it.
      expect(reclaimSnapshotLeases(db, t1)).toEqual([]);
      expect(reclaimSnapshotLeases(db, t1, { all: true })).toEqual([alice]);
      const reclaimed = job(db, alice)!;
      expect(reclaimed).toMatchObject({
        state: 'pending',
        frontier_json: persisted.frontier_json,
        head_cid: head.cid,
        restarts: 0,
        due_at: T0,
      });
      expect(reclaimed.updated_at_ms).toBeGreaterThan(orphaned.updated_at_ms);
      expect(counterValue(db, 'snapshot_reclaimed', 'startup')).toBe(1);

      const slices: number[] = [];
      for (;;) {
        const before = k.transport.calls.entries.length;
        const r = await snapshotStep(m, t1, budget);
        if (r.outcome === 'idle') break;
        slices.push(k.transport.calls.entries.length - before);
        expect(r.subrequests).toBeLessThanOrEqual(40);
        expect(['paused', 'complete']).toContain(r.outcome);
        if (r.outcome === 'complete') break;
      }
      expect(slices.every((n) => n <= 40)).toBe(true);
      expect(slices.length).toBeGreaterThanOrEqual(2);

      // Same final state as an uninterrupted import; restarts never moved.
      expect(scrobbles(db, alice)).toEqual(scrobbleRows.map((r) => ({ ...r, revision: head.rev })));
      expect(follows(db, alice).map((f) => [f.uri, f.cid])).toEqual([[follow.uri, follow.cid]]);
      expect(job(db, alice)).toMatchObject({ state: 'complete', restarts: 0, frontier_json: null });
      expect(historyRkeys(m, alice)).toEqual(ALICE_HISTORY);
    });

    // Resumed, not restarted: after the reclaim no getLatestCommit, no record
    // already applied and no cached node was requested again.
    const after = k.pds.Alice.calls.entries.slice(callsSlice1);
    expect(after.filter((c) => c.nsid === LATEST)).toEqual([]);
    const requestedAfter = after.filter((c) => c.nsid === GET_BLOCKS).flatMap((c) => c.params.cids ?? []);
    const applied = [follow.cid, scrobbleRows[0]!.cid, scrobbleRows[1]!.cid];
    expect(requestedAfter.filter((cid) => applied.includes(cid) || cachedBefore.includes(cid))).toEqual([]);
    // Each record not yet applied is fetched once after the reclaim (the walk picks up where it stopped).
    const pending = scrobbleRows.slice(2).map((r) => r.cid);
    expect(requestedAfter.filter((cid) => pending.includes(cid)).sort()).toEqual([...pending].sort());
    expect(k.pds.Alice.count(LATEST)).toBe(1);
  }, 40_000);

  it('BlockNotFound mid-walk restarts at new head reusing cache; >5 restarts → repository_changed', async () => {
    // Part 1: the PDS garbage-collects the head the walk started from.
    {
      const { k, seed, alice, follow, scrobbleRows } = await seeded();
      const S = k.collections.scrobble;
      const h1 = seed.heads.Alice;
      const r07 = `at://${alice}/${S}/r07`;
      const budget: SliceBudget = { ...BUDGETS.paid, maxEntriesPerSlice: 2 };
      await runInDurableObject(stubFor('snapshot-restart-gc'), async (i: HarnessDO) => {
        const db = i.db;
        const m = deps(db, k);
        admit(db, alice, 'jetstream', T0);
        const first = await snapshotStep(m, T0, budget);
        expect([first.outcome, first.entries]).toEqual(['paused', 2]);
        expect(job(db, alice)).toMatchObject({ head_cid: h1.cid, restarts: 0 });
        expect(follows(db, alice).map((f) => f.uri)).toEqual([follow.uri]);
        expect(scrobbles(db, alice).map((s) => s.uri)).toEqual([scrobbleRows[0]!.uri]);
        const cachedBefore = cachedCids(db, alice);

        // r07 (not walked yet) is deleted and the old head garbage-collected.
        const h2 = await k.externalDelete('Alice', S, 'r07');
        const dropped = await k.pds.Alice.gc(alice);
        expect(dropped).toContain(scrobbleRows[6]!.cid);
        const reachableH2 = await k.repos.Alice.reachable(k.repos.Alice.head!.data);
        const callsBefore = k.pds.Alice.calls.entries.length;

        const reports = await runUntilIdle(m, T0, budget);
        expect(reports.at(-1)!.outcome).toBe('complete');
        expect(reports.reduce((n, r) => n + r.restarts, 0)).toBe(1);

        const calls = k.pds.Alice.calls.entries.slice(callsBefore);
        // The walk hit BlockNotFound once, then fetched the new head once.
        expect(calls.filter((c) => c.nsid === GET_BLOCKS && c.status === 400)).toHaveLength(1);
        expect(calls.filter((c) => c.nsid === LATEST)).toHaveLength(1);
        const restartAt = calls.findIndex((c) => c.nsid === LATEST);
        const requestedAfter = calls
          .slice(restartAt + 1)
          .filter((c) => c.nsid === GET_BLOCKS)
          .flatMap((c) => c.params.cids ?? []);
        // Reused: neither the records already applied nor a cached node still in the new tree.
        const reusable = cachedBefore.filter((cid) => reachableH2.has(cid));
        expect(reusable.length).toBeGreaterThan(0);
        expect(requestedAfter.filter((cid) => reusable.includes(cid))).toEqual([]);
        expect(requestedAfter).not.toContain(follow.cid);
        expect(requestedAfter).not.toContain(scrobbleRows[0]!.cid);

        // Converged on the new head: r07 never appears, everything else verified at h2.
        expect(scrobbles(db, alice).map((s) => s.uri)).toEqual(scrobbleRows.slice(0, 6).map((s) => s.uri));
        expect(db.one('SELECT uri FROM scrobbles WHERE uri = ?', r07)).toBeNull();
        expect(recordStates(db, alice).map((s) => [s.uri, s.revision])).toEqual(
          [follow, ...scrobbleRows.slice(0, 6)].map((r) => [r.uri, h2.rev]),
        );
        expect(job(db, alice)).toMatchObject({ state: 'complete', restarts: 1, head_rev: h2.rev });
        expect(db.one('SELECT active, max_rev FROM users WHERE did = ?', alice)).toEqual({
          active: 1,
          max_rev: h2.rev,
        });
        expect(counterValue(db, 'snapshot_restarts')).toBe(1);
        expect(historyRkeys(m, alice)).toEqual(['r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
      });
    }

    // Part 2: the repository changes under every walk, more than five times.
    {
      const { k, alice, scrobbleRows } = await seeded();
      const S = k.collections.scrobble;
      let churn = 0;
      const transport = wrap(k.transport, {
        before: async (_req, url) => {
          const head = k.repos.Alice.head!.cid;
          if (url.hostname === k.users.Alice.host && url.pathname === `/xrpc/${GET_BLOCKS}`) {
            if (!url.searchParams.getAll('cids').includes(head)) {
              // A write lands and the PDS garbage-collects before serving the walk's nodes.
              churn++;
              await k.repos.Alice.put(S, `churn${churn}`, { $type: S, artist: 'A', track: `T${churn}` });
              await k.pds.Alice.gc(alice);
            }
          }
          return undefined;
        },
      });
      await runInDurableObject(stubFor('snapshot-restart-bound'), async (i: HarnessDO) => {
        const db = i.db;
        const m = deps(db, k, { transport });
        admit(db, alice, 'jetstream', T0);
        const before = protectedTables(db);
        const r = await snapshotStep(m, T0);
        expect([r.outcome, r.detail, r.restarts]).toEqual(['failed', REPOSITORY_CHANGED, 5]);
        expect(job(db, alice)).toMatchObject({
          state: 'failed',
          failure_code: 'repository_changed',
          restarts: 6,
          due_at: T0 + 30 * 60_000,
          frontier_json: null,
          head_cid: null,
        });
        expect(REPOSITORY_CHANGED_BACKOFF_MS).toBe(30 * 60_000);
        // One head at the start plus one per restart; six walks each hit BlockNotFound.
        expect(k.pds.Alice.count(LATEST)).toBe(6);
        expect(k.pds.Alice.calls.filter({ nsid: GET_BLOCKS, status: 400 })).toHaveLength(6);
        expect(churn).toBe(6);
        expect(counterValue(db, 'snapshot_restarts')).toBe(5);
        expect(counterValue(db, 'snapshot_failed', 'repository_changed')).toBe(1);
        // Failed closed: the projection and the account are untouched; still hidden.
        expect(protectedTables(db)).toEqual(before);
        expect(historyRkeys(m, alice)).toEqual([]);

        // Not before its backoff; afterwards a fresh walk (restarts reset by the claim) completes.
        expect((await snapshotStep(m, T0 + 60_000)).outcome).toBe('idle');
        const calm = deps(db, k);
        const later = T0 + 30 * 60_000;
        const retry = await runUntilIdle(calm, later);
        expect(retry.map((x) => x.outcome)).toEqual(['complete']);
        expect(job(db, alice)).toMatchObject({ state: 'complete', restarts: 0 });
        expect(scrobbles(db, alice).map((s) => s.uri)).toEqual(scrobbleRows.map((s) => s.uri));
      });
    }
  });

  it('getBlocks unsupported falls back to getRepo stream and converges identically', async () => {
    const { k, seed, alice } = await seeded();
    const head = seed.heads.Alice;
    const projection = (db: Db) => ({
      scrobbles: db.all('SELECT * FROM scrobbles ORDER BY uri'),
      follows: db.all('SELECT * FROM follows ORDER BY uri'),
      record_state: db.all('SELECT * FROM record_state ORDER BY uri'),
      users: db.all('SELECT * FROM users ORDER BY did'),
    });

    // Reference: the getBlocks walk.
    const ref: { value?: ReturnType<typeof projection> } = {};
    await runInDurableObject(stubFor('snapshot-fallback-reference'), async (i: HarnessDO) => {
      const db = i.db;
      admit(db, alice, 'jetstream', T0);
      const reports = await runUntilIdle(deps(db, k), T0);
      expect(reports.map((r) => [r.outcome, r.source])).toEqual([['complete', 'getBlocks']]);
      ref.value = projection(db);
    });
    const reference = ref.value!;
    expect(reference.scrobbles).toHaveLength(7);
    k.resetCalls();

    // Same repository, getBlocks answering 501: the getRepo stream, then local slices.
    k.pds.Alice.getBlocksSupported = false;
    await runInDurableObject(stubFor('snapshot-fallback-getrepo'), async (i: HarnessDO) => {
      const db = i.db;
      const m = deps(db, k);
      admit(db, alice, 'jetstream', T0);
      const budget: SliceBudget = { ...BUDGETS.paid, maxEntriesPerSlice: 3 };
      const first = await snapshotStep(m, T0, budget);
      expect([first.outcome, first.source, first.entries]).toEqual(['paused', 'getRepo', 3]);
      const frontier = JSON.parse(job(db, alice)!.frontier_json!) as { source: string; walk: { headCid: string } };
      expect([frontier.source, frontier.walk.headCid]).toEqual(['getRepo', head.cid]);
      // Every block of the repository is cached, so later slices need no PDS block request.
      const blocks = (await k.repos.Alice.reachable(k.repos.Alice.head!.data)).size + 1;
      expect(cachedCids(db, alice)).toHaveLength(blocks);
      const callsAfterFirst = k.pds.Alice.calls.entries.length;

      const rest = await runUntilIdle(m, T0, budget);
      expect(rest.map((r) => r.source)).toEqual(rest.map(() => 'getRepo'));
      expect(rest.at(-1)!.outcome).toBe('complete');
      // The later slices made one request in total: the closing getRepoStatus.
      expect(k.pds.Alice.calls.entries.slice(callsAfterFirst).map((c) => c.nsid)).toEqual([STATUS]);

      expect(projection(db)).toEqual(reference);
      expect(cachedCids(db, alice)).toEqual([]);
      expect(counterValue(db, 'snapshot_getrepo_fallback')).toBe(1);
      expect(historyRkeys(m, alice)).toEqual(ALICE_HISTORY);
    });
    const pds = k.pds.Alice;
    expect(pds.calls.filter({ nsid: GET_BLOCKS }).map((c) => c.status)).toEqual([501]);
    expect(pds.count(GET_REPO, alice)).toBe(1);
    expect(pds.count(LATEST, alice)).toBe(1);
    expect(pds.count(STATUS, alice)).toBe(2);
  });

  it('PDS migration A→B fetches from B and preserves URIs/CIDs', async () => {
    const { k, alice, followUri, scrobbleRows, follow } = await seeded();
    const S = k.collections.scrobble;
    const pdsA = k.pds.Alice;
    const pdsB = new FakePds('pds-alice-b.example.test', { clock: k.clock });
    const transport = wrap(k.transport, { extra: [pdsB] });
    const r11: { cid?: string } = {};

    await runInDurableObject(stubFor('snapshot-pds-migration'), async (i: HarnessDO) => {
      const db = i.db;
      admit(db, alice, 'jetstream', T0);
      expect((await runUntilIdle(deps(db, k, { transport }), T0)).map((r) => r.outcome)).toEqual(['complete']);
      const before = [...follows(db, alice), ...scrobbles(db, alice)].map((r) => [r.uri, r.cid]);
      expect(before).toEqual([follow, ...scrobbleRows].map((r) => [r.uri, r.cid]));
      expect(db.one('SELECT pds FROM users WHERE did = ?', alice)).toEqual({ pds: pdsA.origin });

      // Alice moves her repository to B; A no longer hosts it; a new record lands on B.
      await pdsB.addAccount(k.repos.Alice, { handle: k.users.Alice.handle });
      pdsA.removeAccount(alice);
      k.plc.setPds(alice, pdsB.origin);
      const put = await k.repos.Alice.put(S, 'r11', {
        $type: S,
        artist: 'Björk',
        track: 'Jóga',
        listenedAt: '2026-01-15T11:50:00Z',
        createdAt: '2026-01-15T11:50:00Z',
      });
      const r11Cid = put.ops[0]!.cid!;
      r11.cid = r11Cid;
      k.resetCalls();

      // The identity sweep (W4-03) would schedule this on the changed PDS.
      expect(scheduleSnapshot(db, alice, 'pds_migration', T0).status).toBe('scheduled');
      const reports = await runUntilIdle(deps(db, k, { transport }), T0);
      expect(reports.map((r) => r.outcome)).toEqual(['complete']);

      // Same DID URIs and CIDs, plus r11, all verified at B's head.
      const headB = k.repos.Alice.head!;
      expect([...follows(db, alice), ...scrobbles(db, alice)].map((r) => [r.uri, r.cid])).toEqual([
        ...before,
        [`at://${alice}/${S}/r11`, r11Cid],
      ]);
      expect(recordStates(db, alice).every((s) => s.revision === headB.rev && s.state === 'present')).toBe(true);
      expect(db.one('SELECT pds, active, max_rev FROM users WHERE did = ?', alice)).toEqual({
        pds: pdsB.origin,
        active: 1,
        max_rev: headB.rev,
      });
      expect(db.one('SELECT pds FROM identity_cache WHERE did = ?', alice)).toEqual({ pds: pdsB.origin });
      expect(historyRkeys(deps(db, k), alice)).toEqual(['r11', ...ALICE_HISTORY]);
      expect(follows(db, alice).map((f) => f.uri)).toEqual([followUri]);
    });

    // A was asked once, by the stale cached identity, and answered RepoNotFound;
    // one fresh PLC resolution moved every later request to B.
    expect(pdsA.calls.entries.map((c) => [c.nsid, c.status])).toEqual([[STATUS, 400]]);
    expect(k.plc.count(alice)).toBe(1);
    expect(pdsB.count(STATUS, alice)).toBe(2);
    expect(pdsB.count(LATEST, alice)).toBe(1);
    // Only changed blocks came from B: no record that was already indexed.
    const requested = getBlocksCids(pdsB);
    expect(requested).toContain(r11.cid);
    for (const r of [follow, ...scrobbleRows]) expect(requested).not.toContain(r.cid);
  });

  it('a slice in flight while 25 hints coalesce keeps its lease and its completion re-walks the newest head', async () => {
    const { k, seed, alice, follow, scrobbleRows } = await seeded();
    const S = k.collections.scrobble;
    const h1 = seed.heads.Alice;
    let gate: (() => void) | null = null;
    let held = false;
    const transport = wrap(k.transport, {
      before: async (_req, url) => {
        if (
          gate === null &&
          !held &&
          url.pathname === `/xrpc/${GET_BLOCKS}` &&
          url.searchParams.getAll('cids').length
        ) {
          const cids = url.searchParams.getAll('cids');
          if (!cids.includes(h1.cid)) {
            held = true;
            await new Promise<void>((resolve) => {
              gate = resolve;
            });
          }
        }
        return undefined;
      },
    });

    await runInDurableObject(stubFor('snapshot-coalesce-in-flight'), async (i: HarnessDO) => {
      const db = i.db;
      const m = deps(db, k, { transport });
      admit(db, alice, 'jetstream', T0);
      const budget: SliceBudget = { ...BUDGETS.paid, maxEntriesPerSlice: 4 };
      const slice = snapshotStep(m, T0, budget);
      await until(() => gate !== null, 'the walk to reach its first node fetch');
      const running = job(db, alice)!;
      expect(running).toMatchObject({ state: 'running', head_cid: h1.cid, attempts: 0 });

      // 24 new records and the deletion of r01 land; 25 hints coalesce into the job.
      const rkeys: string[] = [];
      for (let n = 0; n < 24; n++) {
        const rkey = `n${String(n).padStart(2, '0')}`;
        rkeys.push(rkey);
        await k.externalPut('Alice', S, rkey, {
          $type: S,
          artist: 'Portishead',
          track: `Roads ${n}`,
          listenedAt: '2026-01-15T11:55:00Z',
          createdAt: '2026-01-15T11:55:00Z',
        });
      }
      await k.externalDelete('Alice', S, 'r01');
      enqueue(
        db,
        [...rkeys, 'r01'].map((rkey) => hint(k, alice, S, rkey)),
      );
      const drained = await drain(m, T0);
      expect(drained.outcomes).toContainEqual({ uri: `at://${alice}/${S}/n00`, outcome: 'coalesced', detail: '25' });
      expect(db.one('SELECT count(*) AS n FROM hints')).toEqual({ n: 0 });
      // The request did not touch the walk: same state, frontier, head and lease token.
      const absorbed = job(db, alice)!;
      expect(absorbed).toMatchObject({
        state: 'running',
        attempts: 1,
        head_cid: h1.cid,
        frontier_json: running.frontier_json,
        updated_at_ms: running.updated_at_ms,
        restarts: 0,
      });

      gate!();
      const first = await slice;
      expect([first.outcome, first.entries]).toEqual(['paused', 4]);
      expect(job(db, alice)!.frontier_json).not.toBe(running.frontier_json);
      // The chunk of the old head applied: the follow and r01..r03 at h1.
      expect(scrobbles(db, alice).map((s) => [s.uri, s.revision])).toEqual(
        scrobbleRows.slice(0, 3).map((s) => [s.uri, h1.rev]),
      );

      const reports = await runUntilIdle(m, T0, budget);
      expect(reports.filter((r) => r.outcome === 'rescan')).toHaveLength(1);
      expect(reports.at(-1)!.outcome).toBe('complete');
      expect(k.pds.Alice.count(LATEST)).toBe(2);
      expect(counterValue(db, 'snapshot_rescan_started', 'admission')).toBe(1);

      // The newest head: r01 deleted, the 24 new records present.
      const h2 = k.repos.Alice.head!;
      const r01 = `at://${alice}/${S}/r01`;
      expect(db.one('SELECT uri FROM scrobbles WHERE uri = ?', r01)).toBeNull();
      expect(db.one('SELECT state, revision FROM record_state WHERE uri = ?', r01)).toEqual({
        state: 'absent',
        revision: h2.rev,
      });
      const expected = [...rkeys.map((r) => `at://${alice}/${S}/${r}`), ...scrobbleRows.slice(1).map((s) => s.uri)];
      expect(scrobbles(db, alice).map((s) => s.uri)).toEqual(expected.sort());
      expect(follows(db, alice).map((f) => f.uri)).toEqual([follow.uri]);
      expect(job(db, alice)).toMatchObject({ state: 'complete', attempts: 0, head_rev: h2.rev });
      expect(db.one('SELECT active, max_rev FROM users WHERE did = ?', alice)).toEqual({ active: 1, max_rev: h2.rev });
    });
  });
});
