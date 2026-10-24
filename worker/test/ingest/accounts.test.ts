// W4-03 accounts.ts: account status from the account's own PDS
// (com.atproto.sync.getRepoStatus), never from relay events (A17), against
// real DO SQLite and the fixture network. Proves M4.1.1/event_types (account
// changes come from a proof-fetch error and the getRepoStatus sweep) and
// M5.3.3/account_state (deactivation hides at once; reactivation stays hidden
// until a complete snapshot commits under the current generation).
//
// The index is seeded through the real ingestion path: the shared fixture is
// published as real signed commits on fake PDSs and every record goes through
// the production verify drain (getRecord proof → verifier → apply). Every
// expectation is hardcoded from TESTING.md / the fixture, never computed by the
// code under test.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { FIXTURE_USERS, type FixtureKit, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { GET_REPO_STATUS, scheduleStatusJobsTimer } from '../../src/do/ingest/accounts';
import { statusSweep } from '../../src/do/ingest/sweeps';
import { drain } from '../../src/do/ingest/verify-drain';
import { feed } from '../../src/do/read/feed';
import { history } from '../../src/do/read/history';
import { profile } from '../../src/do/read/profile';
import { dueAt } from '../../src/do/timers';
import { completeSnapshot } from '../../src/do/write/apply-snapshot';
import type { HarnessDO } from '../harness/harness-do';
import { seedUser } from '../write/support';
import { type Deps, depsFor, enqueue, GET_RECORD, hint, hintRows, kit } from './drain-support';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

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

    await runInDurableObject(stubFor('accounts-deactivate'), async (i: HarnessDO) => {
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
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;

    await runInDurableObject(stubFor('accounts-reactivate'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);
      const genBefore = user(db, alice)!.generation as number;

      // Takedown, seen by the hourly sweep.
      k.pds.Alice.takedown(alice);
      const first = await statusSweep(m, T0);
      expect(first.checked.find((c) => c.did === alice)).toEqual({
        did: alice,
        source: 'sweep',
        outcome: 'inactive',
        detail: 'takendown',
      });
      const hidden = user(db, alice)!;
      expect(hidden).toMatchObject({ active: 0, account_status: 'takendown', indexing_state: 'recovering' });
      const genHidden = hidden.generation as number;
      expect(genHidden).toBeGreaterThan(genBefore);
      expect(historyOf(m, alice)).toEqual([]);

      // Active again on the PDS: the next hourly check schedules the reactivation snapshot,
      // and Alice stays hidden.
      k.pds.Alice.reactivate(alice);
      k.resetCalls();
      const t1 = T0 + HOUR;
      const second = await statusSweep(m, t1);
      expect(second.checked.find((c) => c.did === alice)).toEqual({
        did: alice,
        source: 'sweep',
        outcome: 'reactivating',
        detail: 'scheduled',
      });
      expect(statusCalls(k, 'Alice')).toBe(1);
      expect(user(db, alice)).toEqual({
        ...hidden,
        account_status: 'active',
        indexing_state: 'recovering',
        last_status_check_ms: t1,
      });
      expect(jobs(db, alice)).toEqual([
        { kind: 'snapshot', state: 'pending', reason: 'reactivation', reactivate: 1, generation: genHidden },
      ]);
      expect(db.one("SELECT due_at FROM repo_jobs WHERE did = ? AND kind = 'snapshot'", alice)).toEqual({ due_at: t1 });
      expect(dueAt(db, 'snapshot')).toBe(t1);
      expect(historyOf(m, alice)).toEqual([]);
      expect(await profile(m, alice)).toBeNull();

      // Still active an hour later and the snapshot not finished: nothing new, still hidden.
      const t2 = T0 + 2 * HOUR;
      const third = await statusSweep(m, t2);
      expect(third.checked.find((c) => c.did === alice)?.outcome).toBe('active');
      expect(jobs(db, alice)).toEqual([
        { kind: 'snapshot', state: 'pending', reason: 'reactivation', reactivate: 1, generation: genHidden },
      ]);
      expect(user(db, alice)).toMatchObject({ active: 0, generation: genHidden, last_status_check_ms: t2 });
      expect(historyOf(m, alice)).toEqual([]);

      // A snapshot of the generation before the takedown can no longer activate her.
      const head = k.repos.Alice.head!;
      const nowNs = BigInt(t2) * 1_000_000n;
      const stale = db.tx(() =>
        completeSnapshot(db, { did: alice, generation: genBefore, headRev: head.rev, accountActive: true, nowNs }),
      );
      expect(stale).toEqual({ outcome: 'superseded' });
      expect(user(db, alice)).toMatchObject({ active: 0, indexing_state: 'recovering' });
      expect(historyOf(m, alice)).toEqual([]);

      // The reactivation snapshot completes under the current generation: visible again,
      // with her history exactly as before.
      const done = db.tx(() =>
        completeSnapshot(db, { did: alice, generation: genHidden, headRev: head.rev, accountActive: true, nowNs }),
      );
      expect(done).toEqual({ outcome: 'complete', active: true });
      expect(user(db, alice)).toMatchObject({
        active: 1,
        account_status: 'active',
        indexing_state: 'current',
        last_snapshot_at_ms: t2,
      });
      expect(historyOf(m, alice)).toEqual(ALICE_HISTORY);
      expect(await profile(m, bob)).toMatchObject({ followerCount: 1 });
    });
  });
});
