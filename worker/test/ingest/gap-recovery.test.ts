// W4-01 gap recovery (ADR 0004 §5.5): scheduleGapRecovery / continueGapRecovery
// / maybeClearGap over the known DIDs, within the 1,024 pending snapshot-job
// bound, through the W2-05 checkpoint writer only. Proves the gap half of
// M4.2.1/expired_cursor and M4.4.2/convergence ("enter recovery state and
// schedule known repo backfills"; pending_gap clears only once all of that
// work completes), against real DO SQLite and, for the fixture accounts, the
// real snapshot path over the fixture network.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { seedReadModels } from '@atmusic/atproto/test-support/read-models';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { admit } from '../../src/do/ingest/admission';
import { cachedIdentityResolver } from '../../src/do/ingest/identity-cache';
import {
  continueGapRecovery,
  GAP_SCAN_DONE,
  maybeClearGap,
  type SnapshotStepReport,
  scheduleGapRecovery,
  snapshotStep,
} from '../../src/do/ingest/snapshot-job';
import { GAP_REASON, indexing, markConnected, recordEvent, updateCheckpointBookkeeping } from '../../src/do/status';
import type { HarnessDO } from '../harness/harness-do';
import { seedUser } from '../write/support';
import { type Deps, depsFor, kit } from './drain-support';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const T0 = Date.parse('2026-01-15T12:00:00Z');
const CAP = 1024;
const GET_BLOCKS = 'com.atproto.sync.getBlocks';

type Kit = Awaited<ReturnType<typeof kit>>;

function deps(db: Db, k: Kit): Deps {
  const base = depsFor(db, k, { plan: 'paid' });
  return {
    ...base,
    identity: cachedIdentityResolver(db, { transport: k.transport, clock: k.clock }),
    config: { ...base.config, ingestMode: 'socket' },
  };
}

async function runUntilIdle(m: Deps, now: number, max = 60): Promise<SnapshotStepReport[]> {
  const out: SnapshotStepReport[] = [];
  for (let i = 0; i < max; i++) {
    const r = await snapshotStep(m, now);
    if (r.outcome === 'idle') return out;
    out.push(r);
  }
  throw new Error(`snapshot jobs did not settle in ${max} slices`);
}

/** Alice, Bob and Carol admitted and fully snapshotted (complete jobs, active users). */
async function indexFixtureAccounts(db: Db, k: Kit): Promise<string[]> {
  const dids = [k.users.Alice.did, k.users.Bob.did, k.users.Carol.did];
  for (const did of dids) expect(admit(db, did, 'jetstream', T0).status).toBe('admitted');
  expect((await runUntilIdle(deps(db, k), T0)).map((r) => r.outcome)).toEqual(['complete', 'complete', 'complete']);
  return dids;
}

function checkpoint(db: Db) {
  return db.one<{
    pending_gap: number;
    gap_scan_after_did: string | null;
    connected: number;
    connected_at_ms: number | null;
    updated_at_ms: number;
    cursor: number | null;
    last_event_time_us: number | null;
    mode: string | null;
    host_index: number;
  }>(
    `SELECT pending_gap, gap_scan_after_did, connected, connected_at_ms, updated_at_ms, cursor, last_event_time_us,
       mode, host_index FROM ingest_checkpoint WHERE stream = 'jetstream'`,
  )!;
}

/** The checkpoint fields a gap scan must never move (stale and lag evidence, resume point). */
function evidence(db: Db) {
  const { connected, connected_at_ms, updated_at_ms, cursor, last_event_time_us, mode, host_index } = checkpoint(db);
  return { connected, connected_at_ms, updated_at_ms, cursor, last_event_time_us, mode, host_index };
}

function openJobs(db: Db): number {
  return db.one<{ n: number }>(
    `SELECT count(*) AS n FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','failed')`,
  )!.n;
}

function gapJobs(db: Db): Array<{ did: string; state: string }> {
  return db.all(`SELECT did, state FROM repo_jobs WHERE kind = 'snapshot' AND reason = ? ORDER BY did`, GAP_REASON);
}

/** `did:plc:` + 24 base32 characters; `2…` sorts before the fixture DIDs (`a…`, `b…`, `c…`). */
function syntheticDid(n: number): string {
  let s = '';
  let v = n;
  for (let i = 0; i < 6; i++) {
    s = '234567'[v % 6] + s;
    v = Math.floor(v / 6);
  }
  return `did:plc:${'2'.repeat(18)}${s}`;
}

describe('gap recovery', () => {
  it('gap schedules all known DIDs within 1,024 bound and clears pending_gap only after all complete', async () => {
    const k = await kit();
    const seed = await seedReadModels(k);

    await runInDurableObject(stubFor('gap-recovery-bound'), async (i: HarnessDO) => {
      const db = i.db;
      const m = deps(db, k);
      db.tx(() => {
        markConnected(db, T0);
        recordEvent(db, { cursor: 7, timeUs: T0 * 1000 });
        updateCheckpointBookkeeping(db, { pendingGap: false });
      });
      const fixture = await indexFixtureAccounts(db, k);
      expect(indexing(db, T0, { mode: 'socket' }).state).toBe('current');

      // 1,100 more known accounts, all sorting before the fixture DIDs.
      const synthetic = Array.from({ length: 1100 }, (_, n) => syntheticDid(n));
      expect([...synthetic].sort()).toEqual(synthetic);
      db.tx(() => {
        for (const did of synthetic) seedUser(db, did);
      });
      const known = [...synthetic, ...fixture];
      k.resetCalls();

      // The gap: recovery state at once, and the first batch of 200.
      const first = scheduleGapRecovery(db, T0);
      expect(first).toEqual({ scheduled: 200, already: 0, busy: false, done: false, after: known[199] });
      expect(checkpoint(db)).toMatchObject({ pending_gap: 1, gap_scan_after_did: known[199] });
      expect(indexing(db, T0, { mode: 'socket' })).toMatchObject({ state: 'recovering', caughtUp: false });

      // Later batches fill the queue to exactly the 1,024 bound and stop there.
      const batches = [first];
      for (;;) {
        const r = continueGapRecovery(db, T0)!;
        batches.push(r);
        if (r.busy) break;
      }
      expect(batches.map((b) => b.scheduled)).toEqual([200, 200, 200, 200, 200, 24]);
      expect(openJobs(db)).toBe(CAP);
      expect(checkpoint(db).gap_scan_after_did).toBe(known[CAP - 1]);
      // Still full: nothing more, the scan position is kept, and admission shares the bound.
      expect(continueGapRecovery(db, T0)).toEqual({
        scheduled: 0,
        already: 0,
        busy: true,
        done: false,
        after: known[CAP - 1],
      });
      expect(admit(db, 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz', 'jetstream', T0)).toEqual({
        status: 'busy',
        reason: 'pending_cap',
      });
      expect(openJobs(db)).toBe(CAP);
      expect(maybeClearGap(db)).toBe(false);

      // 100 of the synthetic accounts' snapshots finish (they have no repository
      // on the fixture network; their completion is written directly).
      db.run(
        `UPDATE repo_jobs SET state = 'complete' WHERE kind = 'snapshot' AND did IN (SELECT did FROM repo_jobs
           WHERE kind = 'snapshot' AND did < 'did:plc:a' ORDER BY did LIMIT 100)`,
      );
      // The scan resumes where it stopped: the last 76 synthetic DIDs and the three fixture accounts.
      expect(continueGapRecovery(db, T0)).toEqual({
        scheduled: 79,
        already: 0,
        busy: false,
        done: true,
        after: GAP_SCAN_DONE,
      });
      expect(openJobs(db)).toBe(CAP - 100 + 79);
      expect(continueGapRecovery(db, T0)).toBeNull();
      // Every known DID got a gap job, each exactly once.
      expect(gapJobs(db).map((j) => j.did)).toEqual(known);
      expect(maybeClearGap(db)).toBe(false);

      db.run(`UPDATE repo_jobs SET state = 'complete' WHERE kind = 'snapshot' AND did < 'did:plc:a'`);
      expect(maybeClearGap(db)).toBe(false);
      expect(checkpoint(db).pending_gap).toBe(1);
      expect(indexing(db, T0, { mode: 'socket' }).state).toBe('recovering');

      // The fixture accounts' gap snapshots run for real; pending_gap clears with the last.
      const reports = await runUntilIdle(m, T0);
      expect(reports.map((r) => [r.did, r.outcome, r.gapCleared])).toEqual([
        [fixture[0], 'complete', false],
        [fixture[1], 'complete', false],
        [fixture[2], 'complete', true],
      ]);
      expect(checkpoint(db)).toMatchObject({ pending_gap: 0, gap_scan_after_did: null });
      expect(gapJobs(db).every((j) => j.state === 'complete')).toBe(true);
      expect(indexing(db, T0, { mode: 'socket' })).toMatchObject({ state: 'current', caughtUp: true });
      expect(maybeClearGap(db)).toBe(false); // nothing left to clear
    });

    // The gap re-snapshots are incremental: no record block was fetched again.
    const records = [...seed.records.values()].filter((r) => r.state === 'present').map((r) => r.cid);
    for (const name of ['Alice', 'Bob', 'Carol'] as const) {
      const pds = k.pds[name];
      expect(pds.count('com.atproto.sync.getRepoStatus')).toBe(2);
      const cids = pds.calls.filter({ nsid: GET_BLOCKS }).flatMap((c) => c.params.cids ?? []);
      expect(cids.filter((cid) => records.includes(cid))).toEqual([]);
    }
  });

  it('gap scan batches and maybeClearGap leave connected, connected_at_ms, updated_at_ms, cursor and last_event_time_us unchanged and indexing() recovering until the last gap job completes', async () => {
    const k = await kit();
    await seedReadModels(k);

    await runInDurableObject(stubFor('gap-recovery-evidence'), async (i: HarnessDO) => {
      const db = i.db;
      const m = deps(db, k);
      const fixture = await indexFixtureAccounts(db, k);
      // A live connection: opened a minute ago, newest event one second ago, resume point 42.
      db.tx(() => {
        markConnected(db, T0 - 60_000);
        recordEvent(db, { cursor: 42, timeUs: (T0 - 1_000) * 1000 });
        updateCheckpointBookkeeping(db, { pendingGap: false, mode: 'socket', hostIndex: 1 });
      });
      const before = evidence(db);
      expect(before).toEqual({
        connected: 1,
        connected_at_ms: T0 - 60_000,
        updated_at_ms: T0 - 60_000,
        cursor: 42,
        last_event_time_us: (T0 - 1_000) * 1000,
        mode: 'socket',
        host_index: 1,
      });
      expect(indexing(db, T0, { mode: 'socket' })).toMatchObject({ state: 'current', lagSeconds: 1 });

      // Batches of two over the three known accounts.
      expect(scheduleGapRecovery(db, T0, { batch: 2 })).toEqual({
        scheduled: 2,
        already: 0,
        busy: false,
        done: false,
        after: fixture[1],
      });
      expect(evidence(db)).toEqual(before);
      const recovering = { state: 'recovering', caughtUp: false, lagSeconds: 1 };
      expect(indexing(db, T0, { mode: 'socket' })).toMatchObject(recovering);
      expect(maybeClearGap(db)).toBe(false);
      expect(evidence(db)).toEqual(before);

      expect(continueGapRecovery(db, T0, { batch: 2 })).toEqual({
        scheduled: 1,
        already: 0,
        busy: false,
        done: true,
        after: GAP_SCAN_DONE,
      });
      expect(evidence(db)).toEqual(before);
      expect(checkpoint(db)).toMatchObject({ pending_gap: 1, gap_scan_after_did: GAP_SCAN_DONE });
      expect(maybeClearGap(db)).toBe(false);
      expect(indexing(db, T0, { mode: 'socket' })).toMatchObject(recovering);

      // One gap snapshot per slice: recovering (globally and for every user still
      // in the queue) until the last one completes; the evidence never moves.
      const reports: SnapshotStepReport[] = [];
      for (let n = 0; n < 3; n++) {
        const r = await snapshotStep(m, T0);
        reports.push(r);
        expect(evidence(db)).toEqual(before);
        const global = indexing(db, T0, { mode: 'socket' });
        if (n < 2) {
          expect(global).toMatchObject(recovering);
          expect(checkpoint(db).pending_gap).toBe(1);
          expect(indexing(db, T0, { did: fixture[2]!, mode: 'socket' }).state).toBe('recovering');
        } else {
          expect(global).toMatchObject({ state: 'current', caughtUp: true, lagSeconds: 1 });
        }
      }
      expect(reports.map((r) => [r.did, r.outcome, r.gapCleared])).toEqual([
        [fixture[0], 'complete', false],
        [fixture[1], 'complete', false],
        [fixture[2], 'complete', true],
      ]);
      expect(checkpoint(db)).toMatchObject({ pending_gap: 0, gap_scan_after_did: null });
      expect(evidence(db)).toEqual(before);
      for (const did of fixture) {
        expect(indexing(db, T0, { did, mode: 'socket' })).toMatchObject({ state: 'current', caughtUp: true });
      }
      expect((await snapshotStep(m, T0)).outcome).toBe('idle');
      expect(evidence(db)).toEqual(before);
    });
  });
});
