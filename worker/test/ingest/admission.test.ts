// W3-04 admission.ts against real DO SQLite. Proves M1.3.4/queue_full and
// M4.2.2/backfill_limits (1,024 pending snapshot jobs, then busy with nothing
// written), the hourly new-DID budget under the injected clock, and the
// admission half of M5.3.3/pending_confirmed (an unknown DID's hint is never
// projected; it admits an inactive owner plus a snapshot job). Expectations
// are hardcoded.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import {
  admit,
  MAX_PENDING_SNAPSHOT_JOBS,
  reclaimSnapshotLeases,
  SNAPSHOT_LEASE_MS,
  scheduleSnapshot,
} from '../../src/do/ingest/admission';
import { drain } from '../../src/do/ingest/verify-drain';
import { indexing } from '../../src/do/status';
import type { HarnessDO } from '../harness/harness-do';
import { counterValue, depsFor, enqueue, GET_RECORD, hint, kit } from './drain-support';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const T0 = Date.parse('2026-01-15T12:00:00Z');
const T0_STORAGE = '2026-01-15T12:00:00.000000000Z';

/** Every table of the schema, in a stable order: "writes nothing" means all of them are unchanged. */
function everything(db: Db): Record<string, unknown[]> {
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY 1, 2`)]));
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A distinct, valid did:plc for every n. */
function did(n: number): string {
  let out = '';
  for (let v = n; out.length < 24; v = Math.floor(v / 32)) out = B32[v % 32] + out;
  return `did:plc:${out}`;
}

describe('admission', () => {
  it('unknown DID admitted inactive with snapshot job; hint itself not projected', async () => {
    const k = await kit();
    const carol = k.users.Carol.did;
    const S = k.collections.scrobble;
    await k.externalPut('Carol', S, 'r10', {
      $type: S,
      artist: 'Kate Bush',
      track: 'Running Up That Hill',
      listenedAt: '2026-01-15T11:00:00Z',
      createdAt: '2026-01-15T11:00:00Z',
    });
    k.resetCalls();

    await runInDurableObject(stubFor('admission-unknown'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      enqueue(db, [hint(k, carol, S, 'r10')]);
      const report = await drain(m, T0);
      expect(report.outcomes).toEqual([{ uri: `at://${carol}/${S}/r10`, outcome: 'admitted', detail: 'admitted' }]);

      // Inactive, recovering owner at a fresh global generation.
      expect(db.one('SELECT * FROM users WHERE did = ?', carol)).toEqual({
        did: carol,
        handle: null,
        handle_checked_at_ms: null,
        pds: null,
        joined_at: T0_STORAGE,
        indexed_at: null,
        active: 0,
        account_status: 'unknown',
        max_rev: null,
        indexing_state: 'recovering',
        generation: 1,
        stats_version: 0,
        last_snapshot_at_ms: null,
        last_status_check_ms: null,
        last_activity_ms: null,
      });
      expect(db.one('SELECT last_generation FROM backfill_generation')).toEqual({ last_generation: 1 });
      expect(db.all('SELECT * FROM repo_jobs')).toEqual([
        {
          did: carol,
          kind: 'snapshot',
          state: 'pending',
          generation: 1,
          reason: 'admission',
          head_rev: null,
          head_cid: null,
          frontier_json: null,
          restarts: 0,
          reactivate: 0,
          due_at: T0,
          attempts: 0,
          failure_code: null,
          updated_at_ms: T0,
        },
      ]);
      // The hint is consumed but never projected; no record state, no row.
      expect(db.all('SELECT * FROM hints')).toEqual([]);
      expect(db.all('SELECT * FROM scrobbles')).toEqual([]);
      expect(db.all('SELECT * FROM record_state')).toEqual([]);
      expect(db.all('SELECT * FROM admission')).toEqual([{ window_start_ms: T0, admitted: 1 }]);
      expect(counterValue(db, 'admitted', 'jetstream')).toBe(1);
      // Admission needs no remote call: no getRecord, no DID document.
      expect(k.pds.Carol.count(GET_RECORD)).toBe(0);
      expect(k.transport.calls.count()).toBe(0);
      // The DID reports recovering until a complete snapshot activates it.
      expect(indexing(db, T0, { mode: 'socket', did: carol })).toEqual({
        state: 'recovering',
        caughtUp: false,
        lastIndexedAt: null,
        lagSeconds: null,
      });
      expect(db.one('SELECT state FROM repo_jobs WHERE did = ?', carol)).toEqual({ state: 'pending' });

      // A second hint for the now-known (inactive) DID does not admit it again.
      expect(admit(db, carol, 'notify', T0)).toEqual({ status: 'known' });
      expect(db.one('SELECT last_generation FROM backfill_generation')).toEqual({ last_generation: 1 });
    });
  });

  it('1,024 pending jobs → next admission busy and writes nothing', async () => {
    await runInDurableObject(stubFor('admission-cap'), (i: HarnessDO) => {
      const db = i.db;
      // 1,023 queued jobs for known DIDs, each at its own generation.
      db.tx(() => {
        for (let n = 1; n < MAX_PENDING_SNAPSHOT_JOBS; n++) {
          db.run(`INSERT INTO users(did, joined_at, generation) VALUES (?, ?, ?)`, did(n), T0_STORAGE, n);
          db.run(
            `INSERT INTO repo_jobs(did, kind, state, generation, due_at, updated_at_ms)
             VALUES (?, 'snapshot', ?, ?, ?, ?)`,
            did(n),
            n % 2 === 0 ? 'pending' : 'failed',
            n,
            T0,
            T0,
          );
        }
        db.run('UPDATE backfill_generation SET last_generation = ?', MAX_PENDING_SNAPSHOT_JOBS - 1);
      });
      // A running and a complete job are not queued work.
      db.run(
        "INSERT INTO repo_jobs(did, kind, state, due_at, updated_at_ms) VALUES (?, 'snapshot', 'running', ?, ?)",
        did(5000),
        T0,
        T0,
      );
      db.run(
        "INSERT INTO repo_jobs(did, kind, state, due_at, updated_at_ms) VALUES (?, 'snapshot', 'complete', ?, ?)",
        did(5001),
        T0,
        T0,
      );

      // The 1,024th fits (hourly budget is not the limit here).
      expect(admit(db, did(1024), 'discovery', T0)).toEqual({ status: 'admitted', generation: 1024 });
      expect(
        db.one("SELECT count(*) AS n FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','failed')"),
      ).toEqual({
        n: 1024,
      });

      // The next one is busy and writes nothing at all.
      const before = everything(db);
      expect(admit(db, did(1025), 'discovery', T0)).toEqual({ status: 'busy', reason: 'pending_cap' });
      expect(everything(db)).toEqual(before);
      expect(db.one('SELECT did FROM users WHERE did = ?', did(1025))).toBeNull();
      // A known DID asking for a new snapshot is bounded the same way.
      db.run("UPDATE repo_jobs SET state = 'complete' WHERE did = ?", did(5000));
      db.run('INSERT INTO users(did, joined_at, generation) VALUES (?, ?, 7)', did(5000), T0_STORAGE);
      const before2 = everything(db);
      expect(scheduleSnapshot(db, did(5000), 'coalesced', T0)).toEqual({ status: 'busy' });
      expect(everything(db)).toEqual(before2);

      // One queued job completes: the next admission fits again, with a fresh generation.
      db.run("UPDATE repo_jobs SET state = 'complete' WHERE did = ?", did(2));
      expect(admit(db, did(1025), 'discovery', T0)).toEqual({ status: 'admitted', generation: 1025 });
      expect(db.one('SELECT active, indexing_state, generation FROM users WHERE did = ?', did(1025))).toEqual({
        active: 0,
        indexing_state: 'recovering',
        generation: 1025,
      });
      expect(
        db.one("SELECT state, generation, reason FROM repo_jobs WHERE did = ? AND kind = 'snapshot'", did(1025)),
      ).toEqual({
        state: 'pending',
        generation: 1025,
        reason: 'admission',
      });
      expect(counterValue(db, 'admitted', 'discovery')).toBe(2);
    });
  });

  it('scheduleSnapshot never discards or delays a walk: a started walk records one rescan request', async () => {
    await runInDurableObject(stubFor('admission-rescan'), (i: HarnessDO) => {
      const db = i.db;
      const H0 = 'bafyreih0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0';
      const FRONTIER = '{"stack":[],"lastKey":"com.example.atmusic.scrobble/r10"}';
      const jobs = [
        // [did, state, job generation, restarts, frontier, head, due_at, failure]
        [did(1), 'pending', 9, 0, null, null, T0 + 60_000, null], // queued, walk not started
        [did(2), 'pending', 9, 1, FRONTIER, H0, T0 + 60_000, null], // between slices at H0
        [did(3), 'running', 9, 2, FRONTIER, H0, T0 + 60_000, null], // a slice in flight at H0
        [did(4), 'failed', 9, 6, FRONTIER, H0, T0 + 3_600_000, 'repository_changed'], // in backoff
        [did(5), 'complete', 9, 3, null, H0, T0 + 60_000, null],
        [did(6), 'running', 8, 2, FRONTIER, H0, T0 + 60_000, null], // superseded by a deactivation
      ] as const;
      for (const [d, state, generation, restarts, frontier, head, due, failure] of jobs) {
        db.run('INSERT INTO users(did, joined_at, generation) VALUES (?, ?, 9)', d, T0_STORAGE);
        db.run(
          `INSERT INTO repo_jobs(did, kind, state, generation, reason, head_rev, head_cid, frontier_json, restarts,
             reactivate, due_at, attempts, failure_code, updated_at_ms)
           VALUES (?, 'snapshot', ?, ?, 'gap', '3l2aaaaaaaa22', ?, ?, ?, 1, ?, 0, ?, ?)`,
          d,
          state,
          generation,
          head,
          frontier,
          restarts,
          due,
          failure,
          T0 - 1_000,
        );
      }
      const users = db.all('SELECT * FROM users ORDER BY did');
      const jobRows = () =>
        db.all(
          `SELECT did, state, generation, reason, head_rev, head_cid, frontier_json, restarts, reactivate, due_at,
             attempts, failure_code, updated_at_ms FROM repo_jobs WHERE kind = 'snapshot' ORDER BY did`,
        );

      // Three requests in a row (an attacker's notify flood is many more): the
      // walks in progress keep their frontier, head, epoch, due time and lease.
      for (let n = 1; n <= 3; n++) {
        const results = jobs.map(([d]) => scheduleSnapshot(db, d, 'coalesced', T0 + n));
        expect(results).toEqual([
          { status: 'already', generation: 9, state: 'pending' },
          { status: 'already', generation: 9, state: 'pending' },
          { status: 'already', generation: 9, state: 'running' },
          { status: 'already', generation: 9, state: 'failed' },
          // The complete job (and then the superseded walk) is (re)created once,
          // after which it is a pending walk not yet started.
          n === 1 ? { status: 'scheduled', generation: 9 } : { status: 'already', generation: 9, state: 'pending' },
          n === 1 ? { status: 'scheduled', generation: 9 } : { status: 'already', generation: 9, state: 'pending' },
        ]);
      }
      const kept = { generation: 9, head_rev: '3l2aaaaaaaa22', reactivate: 1 };
      expect(jobRows()).toEqual([
        // Not started: its later claim covers every request; only pulled forward.
        {
          did: did(1),
          state: 'pending',
          reason: 'gap',
          head_cid: null,
          frontier_json: null,
          restarts: 0,
          due_at: T0 + 1,
          attempts: 0,
          failure_code: null,
          updated_at_ms: T0 + 3,
          ...kept,
        },
        // Paused between slices: it resumes its frontier at H0 when due, epoch unchanged;
        // three requests, one rescan when it completes.
        {
          did: did(2),
          state: 'pending',
          reason: 'gap',
          head_cid: H0,
          frontier_json: FRONTIER,
          restarts: 1,
          due_at: T0 + 60_000,
          attempts: 3,
          failure_code: null,
          updated_at_ms: T0 - 1_000,
          ...kept,
        },
        // In flight: still running with the lease token it claimed (T0 - 1000), so its
        // guarded writes still land.
        {
          did: did(3),
          state: 'running',
          reason: 'gap',
          head_cid: H0,
          frontier_json: FRONTIER,
          restarts: 2,
          due_at: T0 + 60_000,
          attempts: 3,
          failure_code: null,
          updated_at_ms: T0 - 1_000,
          ...kept,
        },
        // Failed: its backoff, failure and restarts are not reset by requests.
        {
          did: did(4),
          state: 'failed',
          reason: 'gap',
          head_cid: H0,
          frontier_json: FRONTIER,
          restarts: 6,
          due_at: T0 + 3_600_000,
          attempts: 0,
          failure_code: 'repository_changed',
          updated_at_ms: T0 - 1_000,
          ...kept,
        },
        // Complete: re-created fresh with the new reason.
        {
          did: did(5),
          state: 'pending',
          reason: 'coalesced',
          head_cid: null,
          frontier_json: null,
          restarts: 0,
          due_at: T0 + 1,
          attempts: 0,
          failure_code: null,
          updated_at_ms: T0 + 3,
          ...kept,
        },
        // A walk of generation 8: restarted fresh at generation 9 (its slice misses the
        // generation guard), then an ordinary not-started walk.
        {
          did: did(6),
          state: 'pending',
          reason: 'gap',
          head_cid: null,
          frontier_json: null,
          restarts: 0,
          due_at: T0 + 1,
          attempts: 0,
          failure_code: null,
          updated_at_ms: T0 + 3,
          ...kept,
        },
      ]);
      // The users rows are never written (a deactivation still supersedes the job).
      expect(db.all('SELECT * FROM users ORDER BY did')).toEqual(users);
      expect(counterValue(db, 'snapshot_scheduled', 'coalesced')).toBe(2);
      expect(counterValue(db, 'snapshot_rescan', 'coalesced')).toBe(6);
    });
  });

  it('reclaimSnapshotLeases returns orphaned running rows to pending with frontier, head and restarts kept', async () => {
    await runInDurableObject(stubFor('admission-reclaim'), (i: HarnessDO) => {
      const db = i.db;
      const H0 = 'bafyreih0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0h0';
      const FRONTIER = '{"stack":[],"lastKey":"com.example.atmusic.scrobble/r10"}';
      const jobs = [
        // [did, state, lease token updated_at_ms]
        [did(1), 'running', T0 - SNAPSHOT_LEASE_MS], // lease expired
        [did(2), 'running', T0 - SNAPSHOT_LEASE_MS + 1], // a live slice
        [did(3), 'pending', T0 - 2 * SNAPSHOT_LEASE_MS], // between slices: not running, untouched
        [did(4), 'running', T0 + 5_000], // a token ahead of the clock
      ] as const;
      for (const [d, state, token] of jobs) {
        db.run('INSERT INTO users(did, joined_at, generation) VALUES (?, ?, 4)', d, T0_STORAGE);
        db.run(
          `INSERT INTO repo_jobs(did, kind, state, generation, reason, head_rev, head_cid, frontier_json, restarts,
             due_at, attempts, updated_at_ms)
           VALUES (?, 'snapshot', ?, 4, 'admission', '3l2aaaaaaaa22', ?, ?, 2, ?, 1, ?)`,
          d,
          state,
          H0,
          FRONTIER,
          T0 + 60_000,
          token,
        );
      }
      const jobRows = () =>
        db.all(
          `SELECT did, state, head_cid, frontier_json, restarts, due_at, attempts, updated_at_ms FROM repo_jobs
           ORDER BY did`,
        );
      const walk = { head_cid: H0, frontier_json: FRONTIER, restarts: 2, attempts: 1 };
      expect(SNAPSHOT_LEASE_MS).toBe(900_000);

      // In a live instance: only the expired lease, fenced by a new token.
      expect(reclaimSnapshotLeases(db, T0)).toEqual([did(1)]);
      expect(jobRows()).toEqual([
        { did: did(1), state: 'pending', due_at: T0, updated_at_ms: T0, ...walk },
        { did: did(2), state: 'running', due_at: T0 + 60_000, updated_at_ms: T0 - SNAPSHOT_LEASE_MS + 1, ...walk },
        { did: did(3), state: 'pending', due_at: T0 + 60_000, updated_at_ms: T0 - 2 * SNAPSHOT_LEASE_MS, ...walk },
        { did: did(4), state: 'running', due_at: T0 + 60_000, updated_at_ms: T0 + 5_000, ...walk },
      ]);
      // A slice that held did(1)'s old lease misses its guard and writes nothing.
      expect(
        db.run(
          `UPDATE repo_jobs SET frontier_json = 'late' WHERE did = ? AND kind = 'snapshot'
             AND state = 'running' AND generation = 4 AND updated_at_ms = ?`,
          did(1),
          T0 - SNAPSHOT_LEASE_MS,
        ),
      ).toMatchObject({ rowsWritten: 0 });
      expect(db.one('SELECT frontier_json FROM repo_jobs WHERE did = ?', did(1))).toEqual({ frontier_json: FRONTIER });

      // At IndexDO start-up every running row is orphaned (after eviction no slice survives),
      // and each new token is strictly newer than the one its slice held, even ahead of the clock.
      expect(reclaimSnapshotLeases(db, T0, { all: true })).toEqual([did(2), did(4)]);
      expect(jobRows()).toEqual([
        { did: did(1), state: 'pending', due_at: T0, updated_at_ms: T0, ...walk },
        { did: did(2), state: 'pending', due_at: T0, updated_at_ms: T0, ...walk },
        { did: did(3), state: 'pending', due_at: T0 + 60_000, updated_at_ms: T0 - 2 * SNAPSHOT_LEASE_MS, ...walk },
        { did: did(4), state: 'pending', due_at: T0, updated_at_ms: T0 + 5_001, ...walk },
      ]);
      expect(counterValue(db, 'snapshot_reclaimed', 'lease')).toBe(1);
      expect(counterValue(db, 'snapshot_reclaimed', 'startup')).toBe(2);
      // Nothing left to reclaim.
      expect(reclaimSnapshotLeases(db, T0, { all: true })).toEqual([]);
    });
  });

  it('hourly budget enforced with injected clock', async () => {
    await runInDurableObject(stubFor('admission-hourly'), (i: HarnessDO) => {
      const db = i.db;
      const clock = fixedClock('2026-01-15T12:00:00Z');
      for (let n = 1; n <= 50; n++) {
        // Spread across the hour: the window is the clock hour [12:00, 13:00).
        clock.set(`2026-01-15T12:${String(n).padStart(2, '0')}:00Z`);
        expect(admit(db, did(n), 'notify', clock.nowMs())).toEqual({ status: 'admitted', generation: n });
      }
      expect(db.all('SELECT * FROM admission')).toEqual([{ window_start_ms: T0, admitted: 50 }]);

      // The 51st in the same hour is busy and writes nothing.
      clock.set('2026-01-15T12:59:59.999Z');
      const before = everything(db);
      expect(admit(db, did(51), 'notify', clock.nowMs())).toEqual({ status: 'busy', reason: 'hourly_budget' });
      expect(everything(db)).toEqual(before);

      // The next window opens at 13:00:00 by the injected clock.
      clock.advance(1);
      expect(clock.nowMs()).toBe(T0 + 3_600_000);
      expect(admit(db, did(51), 'notify', clock.nowMs())).toEqual({ status: 'admitted', generation: 51 });
      // The old window is pruned; the new one counts from 1.
      expect(db.all('SELECT * FROM admission')).toEqual([{ window_start_ms: T0 + 3_600_000, admitted: 1 }]);
      expect(db.one("SELECT count(*) AS n FROM users WHERE active = 0 AND indexing_state = 'recovering'")).toEqual({
        n: 51,
      });
      expect(counterValue(db, 'admitted', 'notify')).toBe(51);
      // A custom budget (e.g. a stricter deployment) is honoured the same way.
      expect(admit(db, did(52), 'notify', clock.nowMs(), { hourlyBudget: 1 })).toEqual({
        status: 'busy',
        reason: 'hourly_budget',
      });
    });
  });
});
