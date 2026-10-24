// W4-03 sweeps.ts: the hourly account-status sweep and the daily identity
// sweep, against real DO SQLite and the fixture network (fake PDSs, PLC, DoH
// TXT and well-known handles; the production SafeFetch policy and identity
// resolver). Proves M5.2.1/handle_rename (A17 identity sweep) and the
// handle/PDS rules of ADR 0004 §5.6. History is seeded through the production
// verify drain from real signed commits; every expected value is hardcoded.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { testKey } from '@atmusic/atproto/test-support/keys';
import { FIXTURE_USERS, type FixtureKit, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { GET_REPO_STATUS } from '../../src/do/ingest/accounts';
import { identitySweep, statusSweep } from '../../src/do/ingest/sweeps';
import { drain } from '../../src/do/ingest/verify-drain';
import { history } from '../../src/do/read/history';
import { profile, resolveHandle } from '../../src/do/read/profile';
import { dueAt } from '../../src/do/timers';
import type { HarnessDO } from '../harness/harness-do';
import { seedUser } from '../write/support';
import { type Deps, depsFor, enqueue, hint, hintRows, kit } from './drain-support';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const T0 = Date.parse('2026-01-15T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ALICE_HISTORY = ['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06'];
const OUTSIDER = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz';

const rkey = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

function historyOf(m: Deps, did: string): string[] {
  return history(m, { did, limit: 100 }).rows.map((r) => rkey(r.uri));
}

function handles(db: Db): Record<string, string | null> {
  return Object.fromEntries(
    db
      .all<{ did: string; handle: string | null }>('SELECT did, handle FROM users ORDER BY did')
      .map((r) => [r.did, r.handle]),
  );
}

function projection(db: Db) {
  return {
    scrobbles: db.all('SELECT * FROM scrobbles ORDER BY uri'),
    follows: db.all('SELECT * FROM follows ORDER BY uri'),
    record_state: db.all('SELECT * FROM record_state ORDER BY uri'),
  };
}

function snapshotJobs(db: Db) {
  return db.all(`SELECT did, state, reason, generation FROM repo_jobs WHERE kind = 'snapshot' ORDER BY did`);
}

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

// ---------------------------------------------------------------------------
// Synthetic accounts for the cadence test: did:plc identifiers whose 24 base32
// characters sort by a one-letter group and then by index (the base32
// alphabet in byte order, so index order is SQLite BINARY order).

const B32 = '234567abcdefghijklmnopqrstuvwxyz';
function syntheticDid(group: 'o' | 'r', index: number): string {
  const enc = B32[(index >> 10) & 31]! + B32[(index >> 5) & 31]! + B32[index & 31]!;
  return `did:plc:${group}${'a'.repeat(20)}${enc}`;
}

describe('status sweep', () => {
  it('active-in-30d DIDs are checked hourly, others daily, 200 per run', async () => {
    const k = await kit();
    const pds = k.pds.Bob; // every synthetic account lives on one fixture PDS host
    const key = await testKey('secp256k1', 0x21, 'sweep-secp256k1');
    const O = Array.from({ length: 200 }, (_, i) => syntheticDid('o', i));
    const R = Array.from({ length: 32 }, (_, i) => syntheticDid('r', i));
    for (const did of [...O, ...R]) {
      await pds.addAccount(new SignedRepo(did, key, { clock: k.clock }));
      k.plc.register(did, { signingKey: key, pds: pds.origin, handle: null });
    }
    // Activity, relative to the second run at T0 + 1 h:
    // - O[0]: 30 days and 1 ms before it (idle → daily);
    // - O[1]: exactly 30 days before it (recent → hourly);
    // - O[2..99]: none; O[100..199]: 40 days before T0 (idle);
    // - R[*]: one day before T0 (recent).
    const activity = new Map<string, number | null>();
    O.forEach((did, i) => {
      activity.set(
        did,
        i === 0 ? T0 + HOUR - 30 * DAY - 1 : i === 1 ? T0 + HOUR - 30 * DAY : i < 100 ? null : T0 - 40 * DAY,
      );
    });
    for (const did of R) activity.set(did, T0 - DAY);

    await runInDurableObject(stubFor('sweep-cadence'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      for (const did of [...O, ...R]) {
        seedUser(db, did);
        db.run('UPDATE users SET last_activity_ms = ? WHERE did = ?', activity.get(did) ?? null, did);
      }
      const usersBefore = db.all('SELECT did, active, account_status, generation, handle FROM users ORDER BY did');
      k.resetCalls();

      const checkedDids = () =>
        pds.calls
          .filter({ nsid: GET_REPO_STATUS })
          .map((c) => c.params.did![0]!)
          .sort();
      const lastChecks = () =>
        Object.fromEntries(
          db
            .all<{ did: string; t: number | null }>('SELECT did, last_status_check_ms AS t FROM users')
            .map((r) => [r.did, r.t]),
        );
      const run = async (now: number) => {
        pds.calls.reset();
        const report = await statusSweep(m, now);
        expect(report.checked.every((c) => c.source === 'sweep' && c.outcome === 'active')).toBe(true);
        expect(dueAt(db, 'status-sweep')).toBe(now + HOUR);
        return report;
      };

      // Run 1 (T0): every DID is unchecked; 200 per run, in DID order → all of O.
      const r1 = await run(T0);
      expect(r1.checked.length).toBe(200);
      expect(checkedDids()).toEqual(O);
      let t = lastChecks();
      expect(O.every((d) => t[d] === T0)).toBe(true);
      expect(R.every((d) => t[d] === null)).toBe(true);

      // Run 2 (T0 + 1 h): the 32 never-checked R, plus O[1] (activity exactly 30 days
      // ago, hourly). O[0] (30 days and 1 ms) and the other idle DIDs are not due.
      const r2 = await run(T0 + HOUR);
      expect(r2.checked.length).toBe(33);
      expect(checkedDids()).toEqual([O[1]!, ...R].sort());
      t = lastChecks();
      expect(t[O[0]!]).toBe(T0);
      expect(t[O[1]!]).toBe(T0 + HOUR);

      // Run 3 (T0 + 2 h): the recent R again (hourly). O[1]'s activity is now more than
      // 30 days old, so it is daily and not due.
      const r3 = await run(T0 + 2 * HOUR);
      expect(r3.checked.length).toBe(32);
      expect(checkedDids()).toEqual(R);

      // Run 4 (T0 + 24 h): 199 O are due (checked at T0) and all 32 R (checked at
      // T0 + 2 h). Only 200 are taken, oldest check first: the 199 O, then R[0].
      const r4 = await run(T0 + DAY);
      expect(r4.checked.length).toBe(200);
      expect(checkedDids()).toEqual([...O.filter((d) => d !== O[1]), R[0]!].sort());
      t = lastChecks();
      expect(R.slice(1).every((d) => t[d] === T0 + 2 * HOUR)).toBe(true);
      expect(t[O[1]!]).toBe(T0 + HOUR);

      // Run 5 (T0 + 25 h): the 31 R left over plus R[0] (hourly) and O[1] (daily, last
      // checked at T0 + 1 h).
      const r5 = await run(T0 + 25 * HOUR);
      expect(r5.checked.length).toBe(33);
      expect(checkedDids()).toEqual([O[1]!, ...R].sort());

      // Checks of active accounts change nothing but the check time.
      expect(db.all('SELECT did, active, account_status, generation, handle FROM users ORDER BY did')).toEqual(
        usersBefore,
      );
      expect(db.all('SELECT * FROM repo_jobs')).toEqual([]);
      // Never-a-relay: every call went to the account's PDS (or PLC/DoH for its identity).
      expect(k.relay.calls.count()).toBe(0);
    });
  });
});

describe('identity sweep', () => {
  it('handle that no longer verifies becomes null; history retained', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;
    const carol = k.users.Carol.did;

    await runInDurableObject(stubFor('sweep-handle-null'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);

      const first = await identitySweep(m, T0);
      expect(first.checked.map((c) => [c.did, c.outcome]).sort()).toEqual([
        [alice, 'verified'],
        [bob, 'verified'],
        [carol, 'verified'],
      ]);
      expect(handles(db)).toEqual({ [alice]: 'alice.test', [bob]: 'bob.test', [carol]: 'carol.test' });
      // Fresh resolutions: one DID document fetch per account, no cache.
      expect(k.plc.count()).toBe(3);
      expect(dueAt(db, 'identity-sweep')).toBe(T0 + DAY);
      const before = projection(db);
      const aliceBefore = db.one(
        'SELECT active, account_status, generation, max_rev, stats_version FROM users WHERE did = ?',
        alice,
      );

      // alice.test now names another DID; Alice's document still claims it.
      k.doh.setTxt('_atproto.alice.test', [`did=${OUTSIDER}`]);
      k.handles.set('alice.test', OUTSIDER);
      // Carol's DID document is briefly unavailable (transient): her handle is kept.
      k.plc.fail({ did: carol }, { kind: 'status', status: 503 });
      k.resetCalls();

      // Not due before a day has passed.
      const early = await identitySweep(m, T0 + DAY - 1);
      expect(early.checked).toEqual([]);
      expect(k.plc.count()).toBe(0);

      const second = await identitySweep(m, T0 + DAY);
      expect(second.checked.map((c) => [c.did, c.outcome]).sort()).toEqual([
        [alice, 'cleared'],
        [bob, 'verified'],
        [carol, 'failed'],
      ]);
      expect(handles(db)).toEqual({ [alice]: null, [bob]: 'bob.test', [carol]: 'carol.test' });
      expect(db.one('SELECT handle_checked_at_ms AS t FROM users WHERE did = ?', carol)).toEqual({ t: T0 + DAY });
      expect(k.plc.count(alice)).toBe(1);
      expect(k.plc.count(carol)).toBe(1);

      // History, follows and the record guards are untouched; Alice stays visible.
      expect(projection(db)).toEqual(before);
      expect(
        db.one('SELECT active, account_status, generation, max_rev, stats_version FROM users WHERE did = ?', alice),
      ).toEqual(aliceBefore);
      expect(historyOf(m, alice)).toEqual(ALICE_HISTORY);
      const p = await profile(m, alice);
      expect(p).toMatchObject({ did: alice, handle: null, totalScrobbles: 7, followingCount: 1 });
      expect(snapshotJobs(db)).toEqual([]);
      expect(db.all("SELECT label, value FROM counters WHERE name = 'handle_cleared'")).toEqual([
        { label: 'unverified', value: 1 },
      ]);
    });
  });

  it('PDS change in DID doc schedules snapshot', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;

    await runInDurableObject(stubFor('sweep-pds-change'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);
      await identitySweep(m, T0);
      expect(db.all('SELECT did, pds FROM users ORDER BY did')).toEqual(
        FIXTURE_USERS.map((n) => ({ did: k.users[n].did, pds: k.users[n].origin })),
      );
      expect(snapshotJobs(db)).toEqual([]);
      const before = projection(db);
      const generation = db.one<{ generation: number }>(
        'SELECT generation FROM users WHERE did = ?',
        alice,
      )!.generation;

      // Alice migrates her repository to another PDS host and updates her DID document.
      await k.pds.Bob.addAccount(k.repos.Alice, { handle: 'alice.test' });
      k.plc.setPds(alice, k.pds.Bob.origin);
      k.pds.Alice.removeAccount(alice);

      const t1 = T0 + DAY;
      const report = await identitySweep(m, t1);
      expect(report.checked.find((c) => c.did === alice)).toEqual({
        did: alice,
        outcome: 'verified',
        handle: 'alice.test',
        pdsChanged: true,
        cleared: null,
      });
      expect(snapshotJobs(db)).toEqual([{ did: alice, state: 'pending', reason: 'pds_migration', generation }]);
      expect(db.one("SELECT due_at FROM repo_jobs WHERE did = ? AND kind = 'snapshot'", alice)).toEqual({ due_at: t1 });
      expect(dueAt(db, 'snapshot')).toBe(t1);
      expect(db.one('SELECT pds, active, account_status FROM users WHERE did = ?', alice)).toEqual({
        pds: k.pds.Bob.origin,
        active: 1,
        account_status: 'active',
      });
      // Migration is not deactivation: Alice stays visible, her rows unchanged, until the
      // snapshot from the new PDS re-verifies them.
      expect(projection(db)).toEqual(before);
      expect(historyOf(m, alice)).toEqual(ALICE_HISTORY);
      expect(db.all("SELECT label, value FROM counters WHERE name = 'pds_changed'")).toEqual([
        { label: 'scheduled', value: 1 },
      ]);

      // The next sweep sees the same endpoint: no further snapshot request.
      await identitySweep(m, t1 + DAY);
      expect(snapshotJobs(db)).toEqual([{ did: alice, state: 'pending', reason: 'pds_migration', generation }]);
      expect(db.all("SELECT label, value FROM counters WHERE name = 'pds_changed'")).toEqual([
        { label: 'scheduled', value: 1 },
      ]);
    });
  });

  it('renamed handle verifies on the next identity sweep and resolves to the same DID with unchanged history', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const RENAMED = 'alice-renamed.test';

    await runInDurableObject(stubFor('sweep-rename'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);
      await identitySweep(m, T0);
      expect(handles(db)[alice]).toBe('alice.test');
      const before = projection(db);
      const userBefore = db.one(
        'SELECT did, joined_at, active, generation, max_rev, stats_version FROM users WHERE did = ?',
        alice,
      );

      // Alice renames: the new handle publishes her DID; her document claims it.
      k.plc.setHandle(alice, RENAMED);
      k.doh.setTxt(`_atproto.${RENAMED}`, [`did=${alice}`]);
      k.handles.set(RENAMED, alice);
      // Until the next sweep the stored handle is the old one.
      await identitySweep(m, T0 + DAY - 1);
      expect(handles(db)[alice]).toBe('alice.test');

      k.resetCalls();
      const report = await identitySweep(m, T0 + DAY);
      expect(report.checked.find((c) => c.did === alice)).toEqual({
        did: alice,
        outcome: 'verified',
        handle: RENAMED,
        pdsChanged: false,
        cleared: null,
      });
      expect(k.plc.count(alice)).toBe(1);
      expect(handles(db)[alice]).toBe(RENAMED);

      // The new handle resolves to the same DID; the old one no longer verifies.
      expect(await resolveHandle(m, RENAMED)).toEqual({ status: 'ok', did: alice, handle: RENAMED });
      expect(await resolveHandle(m, 'alice.test')).toEqual({ status: 'mismatch' });
      expect(await profile(m, alice)).toMatchObject({ did: alice, handle: RENAMED, totalScrobbles: 7 });

      // Identity is the DID: history, follows, guards and the account row are unchanged.
      expect(projection(db)).toEqual(before);
      expect(
        db.one('SELECT did, joined_at, active, generation, max_rev, stats_version FROM users WHERE did = ?', alice),
      ).toEqual(userBefore);
      expect(historyOf(m, alice)).toEqual(ALICE_HISTORY);
      expect(snapshotJobs(db)).toEqual([]);
    });
  });

  it('a verified handle held by another account clears the older holder', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;

    await runInDurableObject(stubFor('sweep-handle-conflict'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      await seedIndexed(db, m, k);
      await identitySweep(m, T0);
      expect(handles(db)[alice]).toBe('alice.test');

      // Bob takes alice.test; Alice is not due for another check yet.
      k.plc.setHandle(bob, 'alice.test');
      k.doh.setTxt('_atproto.alice.test', [`did=${bob}`]);
      k.handles.set('alice.test', bob);
      db.run('UPDATE users SET handle_checked_at_ms = ? WHERE did != ?', T0 + DAY, bob);

      const report = await identitySweep(m, T0 + DAY);
      expect(report.checked).toEqual([
        { did: bob, outcome: 'verified', handle: 'alice.test', pdsChanged: false, cleared: alice },
      ]);
      expect(handles(db)).toEqual({ [alice]: null, [bob]: 'alice.test', [k.users.Carol.did]: 'carol.test' });
      expect(db.all("SELECT label, value FROM counters WHERE name = 'handle_conflict'")).toEqual([
        { label: '', value: 1 },
      ]);
      expect(historyOf(m, alice)).toEqual(ALICE_HISTORY);
      expect(historyOf(m, bob)).toEqual(['r09']);
    });
  });
});
