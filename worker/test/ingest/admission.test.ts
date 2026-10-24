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
import { admit, MAX_PENDING_SNAPSHOT_JOBS, scheduleSnapshot } from '../../src/do/ingest/admission';
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
