// W4-01 generation.ts with snapshot-job.ts: ADR 0003 generation rules for
// deactivation and reactivation (ADR 0004 §5.6, §5.7 step 9), against real DO
// SQLite and the fixture network. Proves M4.2.3/deactivate_reactivate: an
// inactive account is hidden at once, and a reactivated one stays hidden until
// a complete snapshot under its current generation commits. Every expectation
// is hardcoded from TESTING.md or comes from the fixture signer.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { followRkey, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import type { FixtureTransport } from '@atmusic/atproto/test-support/router-transport';
import { describe, expect, it } from 'vitest';
import { BUDGETS, type SliceBudget } from '../../src/config';
import type { RepoJobRow } from '../../src/do/contracts';
import type { Db } from '../../src/do/db';
import { admit } from '../../src/do/ingest/admission';
import { deactivate, REACTIVATION_REASON, reactivate, rescheduleSnapshot } from '../../src/do/ingest/generation';
import { cachedIdentityResolver } from '../../src/do/ingest/identity-cache';
import { type SnapshotStepReport, snapshotStep } from '../../src/do/ingest/snapshot-job';
import { history } from '../../src/do/read/history';
import { markConnected, recordEvent, updateCheckpointBookkeeping } from '../../src/do/status';
import type { HarnessDO } from '../harness/harness-do';
import { counterValue, type Deps, depsFor, kit } from './drain-support';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const T0 = Date.parse('2026-01-15T12:00:00Z');
const STATUS = 'com.atproto.sync.getRepoStatus';
/** TESTING.md: Alice's history, newest first. */
const ALICE_HISTORY = ['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06'];

function deps(db: Db, k: Awaited<ReturnType<typeof kit>>, transport: FixtureTransport = k.transport): Deps {
  const base = depsFor(db, k, { plan: 'paid' });
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

function user(db: Db, did: string) {
  return db.one<{
    active: number;
    account_status: string;
    indexing_state: string;
    generation: number;
    last_snapshot_at_ms: number | null;
  }>('SELECT active, account_status, indexing_state, generation, last_snapshot_at_ms FROM users WHERE did = ?', did);
}

const visible = (m: Deps, did: string) => history(m, { did, limit: 100 }).rows.map((r) => r.rkey);
const indexingOf = (m: Deps, did: string) => history(m, { did, limit: 1 }).indexing;
const stored = (db: Db, did: string) =>
  db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles WHERE did = ?', did)!.n;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('deactivation and reactivation', () => {
  it('deactivate Alice hides her; reactivation stays hidden until snapshot completes, then current', async () => {
    const k = await kit();
    const seed = await seedReadModels(k);
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;

    await runInDurableObject(stubFor('reactivation-hidden-until-snapshot'), async (i: HarnessDO) => {
      const db = i.db;
      const m = deps(db, k);
      followUpstream(db);
      admit(db, alice, 'jetstream', T0);
      admit(db, bob, 'jetstream', T0);
      expect((await runUntilIdle(m, T0)).map((r) => [r.did, r.outcome])).toEqual([
        [alice, 'complete'],
        [bob, 'complete'],
      ]);
      expect(visible(m, alice)).toEqual(ALICE_HISTORY);
      expect(visible(m, bob)).toEqual(['r09']);
      const g1 = user(db, alice)!.generation;

      // getRepoStatus reports Alice deactivated: hidden at once, a new generation.
      k.pds.Alice.deactivate(alice);
      const d = deactivate(db, alice, 'deactivated');
      expect(d.changed).toBe(true);
      const g2 = (d as { generation: number }).generation;
      expect(g2).toBeGreaterThan(g1);
      expect(user(db, alice)).toEqual({
        active: 0,
        account_status: 'deactivated',
        indexing_state: 'recovering',
        generation: g2,
        last_snapshot_at_ms: T0,
      });
      expect(visible(m, alice)).toEqual([]);
      expect(indexingOf(m, alice).state).toBe('recovering');
      // Hidden, not erased: the rows stay stored. Bob is unaffected.
      expect(stored(db, alice)).toBe(7);
      expect(visible(m, bob)).toEqual(['r09']);
      expect(indexingOf(m, bob)).toMatchObject({ state: 'current', caughtUp: true });

      // Active again: still hidden; a snapshot with the reactivation intent at the current generation.
      k.pds.Alice.reactivate(alice);
      k.resetCalls();
      expect(reactivate(db, alice, T0)).toEqual({ changed: true, schedule: { status: 'scheduled', generation: g2 } });
      expect(job(db, alice)).toMatchObject({
        state: 'pending',
        generation: g2,
        reason: REACTIVATION_REASON,
        reactivate: 1,
        frontier_json: null,
      });
      // Ordinary rescheduling preserves the intent (and the reason of the open job).
      expect(rescheduleSnapshot(db, alice, 'coalesced', T0).status).toBe('already');
      expect(job(db, alice)).toMatchObject({ reactivate: 1, reason: REACTIVATION_REASON, generation: g2 });
      expect(user(db, alice)).toMatchObject({ active: 0, account_status: 'active', indexing_state: 'recovering' });
      expect(visible(m, alice)).toEqual([]);

      // The snapshot runs in slices; between them Alice stays hidden.
      const budget: SliceBudget = { ...BUDGETS.paid, maxEntriesPerSlice: 3 };
      const outcomes: string[] = [];
      for (;;) {
        const r = await snapshotStep(m, T0, budget);
        if (r.outcome === 'idle') break;
        outcomes.push(r.outcome);
        if (r.outcome === 'complete') break;
        expect(r.outcome).toBe('paused');
        expect(user(db, alice)!.active).toBe(0);
        expect(visible(m, alice)).toEqual([]);
        expect(indexingOf(m, alice)).toMatchObject({ state: 'recovering', caughtUp: false });
      }
      expect(outcomes).toEqual(['paused', 'paused', 'complete']);

      // Complete under the current generation: visible and current again.
      expect(visible(m, alice)).toEqual(ALICE_HISTORY);
      expect(indexingOf(m, alice)).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T12:00:00.000000000Z',
        lagSeconds: 0,
      });
      expect(user(db, alice)).toEqual({
        active: 1,
        account_status: 'active',
        indexing_state: 'current',
        generation: g2,
        last_snapshot_at_ms: T0,
      });
      expect(job(db, alice)).toMatchObject({ state: 'complete', generation: g2, failure_code: null, reactivate: 1 });
      // The reactivation snapshot re-verified the same signed records (CIDs from the signer).
      const S = k.collections.scrobble;
      const uris = ['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07'].map((r) => `at://${alice}/${S}/${r}`);
      expect(db.all('SELECT uri, cid FROM scrobbles WHERE did = ? ORDER BY uri', alice)).toEqual(
        uris.map((uri) => ({ uri, cid: seed.records.get(uri)!.cid })),
      );
      const followUri = `at://${alice}/${k.collections.follow}/${await followRkey(bob)}`;
      expect(db.one('SELECT cid FROM follows WHERE uri = ?', followUri)).toEqual({
        cid: seed.records.get(followUri)!.cid,
      });
      // Status checked before and after the walk; Bob's PDS untouched.
      expect(k.pds.Alice.count(STATUS, alice)).toBe(2);
      expect(k.pds.Bob.count()).toBe(0);
    });
  });

  it('deactivation during in-flight snapshot makes completion superseded', async () => {
    const k = await kit();
    await seedReadModels(k);
    const alice = k.users.Alice.did;
    let statusCalls = 0;
    let release: (() => void) | null = null;
    // The closing getRepoStatus is answered (active), then held before it reaches the slice.
    const transport = Object.assign(
      async (req: Request): Promise<Response> => {
        const res = await k.transport(req);
        if (new URL(req.url).pathname === `/xrpc/${STATUS}` && ++statusCalls === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return res;
      },
      { fixture: true as const, calls: k.transport.calls, hostnames: () => k.transport.hostnames() },
    );

    await runInDurableObject(stubFor('reactivation-superseded'), async (i: HarnessDO) => {
      const db = i.db;
      const m = deps(db, k, transport);
      followUpstream(db);
      const g1 = (admit(db, alice, 'jetstream', T0) as { generation: number }).generation;
      const inFlight = snapshotStep(m, T0);
      for (let n = 0; n < 500 && release === null; n++) await tick();
      expect(release).not.toBeNull();
      // The whole range was applied under g1; only the completion is outstanding.
      expect(job(db, alice)).toMatchObject({ state: 'running', generation: g1 });
      expect(stored(db, alice)).toBe(7);

      // A status sweep sees the account deactivated meanwhile.
      const d = deactivate(db, alice, 'deactivated');
      expect(d.changed).toBe(true);
      const g2 = (d as { generation: number }).generation;
      release!();
      const r = await inFlight;
      expect([r.did, r.outcome]).toEqual([alice, 'superseded']);

      // Nothing was activated: hidden, not current, no snapshot time; the job is closed.
      expect(user(db, alice)).toEqual({
        active: 0,
        account_status: 'deactivated',
        indexing_state: 'recovering',
        generation: g2,
        last_snapshot_at_ms: null,
      });
      expect(visible(m, alice)).toEqual([]);
      expect(job(db, alice)).toMatchObject({
        state: 'complete',
        failure_code: 'superseded',
        generation: g1,
        frontier_json: null,
        head_cid: null,
      });
      expect(db.one('SELECT count(*) AS n FROM snapshot_blocks WHERE did = ?', alice)).toEqual({ n: 0 });
      expect(counterValue(db, 'snapshot_superseded', 'completion')).toBe(1);
      expect(counterValue(db, 'snapshot_completed', 'admission')).toBe(0);
      expect((await snapshotStep(m, T0)).outcome).toBe('idle');

      // Reactivation: a fresh walk at g2. A deactivation again between its slices
      // supersedes it at the next claim, before any request is made.
      expect(reactivate(db, alice, T0)).toEqual({ changed: true, schedule: { status: 'scheduled', generation: g2 } });
      const budget: SliceBudget = { ...BUDGETS.paid, maxEntriesPerSlice: 2 };
      expect((await snapshotStep(m, T0, budget)).outcome).toBe('paused');
      const g3 = (deactivate(db, alice, 'takendown') as { generation: number }).generation;
      const before = k.pds.Alice.calls.entries.length;
      const closed = await snapshotStep(m, T0, budget);
      expect(closed.outcome).toBe('superseded');
      expect(k.pds.Alice.calls.entries.length).toBe(before);
      expect(job(db, alice)).toMatchObject({ state: 'complete', failure_code: 'superseded', generation: g2 });
      expect(user(db, alice)).toMatchObject({ active: 0, account_status: 'takendown', generation: g3 });
      expect(visible(m, alice)).toEqual([]);

      // Only a snapshot under the current generation activates.
      expect(reactivate(db, alice, T0)).toEqual({ changed: true, schedule: { status: 'scheduled', generation: g3 } });
      expect((await runUntilIdle(m, T0)).map((x) => x.outcome)).toEqual(['complete']);
      expect(user(db, alice)).toMatchObject({ active: 1, indexing_state: 'current', generation: g3 });
      expect(visible(m, alice)).toEqual(ALICE_HISTORY);
    });
  });
});
