// Shared setup for the ingest-core suites (W3-04). TEST-ONLY.
//
// ModuleDeps over the ingest suites' SQLite file (node-index.ts), wired to the fixture network
// (packages/atproto/test-support/read-models.ts `createFixtureKit`: real
// signed repositories on fake PDSs, fake PLC and DoH). The production SafeFetch
// policy, identity resolver, verifier and projection apply all run unchanged;
// only the Transport, the clock and the random source are injected.

import { createFixtureKit, type FixtureKit } from '@atmusic/atproto/test-support/read-models';
import { seededRandom } from '@atmusic/core/test-support/random';
import { BUDGETS, type Plan, parseConfig, type SliceBudget } from '../../src/config';
import type { Logger, LogLevel, ModuleDeps } from '../../src/do/contracts';
import type { Db } from '../../src/do/db';
import { enqueueHints, type HintInput } from '../../src/do/ingest/hints';
import { cachedIdentityResolver } from '../../src/do/ingest/identity-cache';
import { INGEST_TEST_ENV } from './node-index';

export const GET_RECORD = 'com.atproto.sync.getRecord';

export interface LogEntry {
  level: LogLevel;
  event: string;
  fields?: Record<string, unknown>;
}

export function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    log(level, event, fields) {
      entries.push(fields === undefined ? { level, event } : { level, event, fields });
    },
  };
}

export interface Deps extends ModuleDeps {
  log: Logger & { entries: LogEntry[] };
}

/** ModuleDeps for the test database's Db over the kit's fixture network (test entry config). */
export function depsFor(db: Db, kit: FixtureKit, o: { plan?: Plan } = {}): Deps {
  const base = parseConfig({ ...INGEST_TEST_ENV, ADMIN_TOKEN: '' }, { allowFixturePrefix: true });
  const plan = o.plan ?? base.plan;
  const config = { ...base, plan, budget: BUDGETS[plan] };
  return {
    db,
    clock: kit.clock,
    random: seededRandom(7),
    transport: kit.transport,
    identity: cachedIdentityResolver(db, { transport: kit.transport, clock: kit.clock }),
    config,
    log: recordingLogger(),
  };
}

export const kit = (): Promise<FixtureKit> => createFixtureKit();

/** One jetstream-style hint for `did`'s `collection/rkey`, received now. */
export function hint(k: FixtureKit, did: string, collection: string, rkey: string, extra: Partial<HintInput> = {}) {
  return { did, collection, rkey, source: 'jetstream' as const, receiptMs: k.clock.nowMs(), ...extra };
}

export function enqueue(db: Db, hints: HintInput[]): string[] {
  return enqueueHints(db, hints);
}

/** A paid budget with a lower hint count, for tests that step the drain. */
export function budget(o: Partial<SliceBudget> = {}): SliceBudget {
  return { ...BUDGETS.paid, ...o };
}

/** Rows of the tables a rejected proof must leave byte-identical (ADR 0004 §7.6). */
export function protectedTables(db: Db): Record<string, unknown[]> {
  return {
    scrobbles: db.all('SELECT * FROM scrobbles ORDER BY uri'),
    follows: db.all('SELECT * FROM follows ORDER BY uri'),
    record_state: db.all('SELECT * FROM record_state ORDER BY uri'),
    users: db.all('SELECT * FROM users ORDER BY did'),
    ingest_checkpoint: db.all('SELECT * FROM ingest_checkpoint ORDER BY stream'),
  };
}

export function hintRows(db: Db) {
  return db.all<{ uri: string; attempts: number; due_at: number; last_error: string | null }>(
    'SELECT uri, attempts, due_at, last_error FROM hints ORDER BY uri',
  );
}

export function snapshotJobs(db: Db) {
  return db.all<{ did: string; state: string; generation: number; reason: string | null }>(
    `SELECT did, state, generation, reason FROM repo_jobs WHERE kind = 'snapshot' ORDER BY did`,
  );
}

export function counterValue(db: Db, name: string, label = ''): number {
  return db.one<{ value: number }>('SELECT value FROM counters WHERE name = ? AND label = ?', name, label)?.value ?? 0;
}
