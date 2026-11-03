// N7-01 ingest-mode.ts: the `off` mode against the production SQLite adapter
// (a temporary file, node-index.ts) and the fake Jetstream's sockets
// (test/fixtures/jetstream-server.ts), plus the retirement of the Workers-era
// `pulse` mode, PLAN tier, DO_LOCATION_HINT and free budget (ADR 0005 §3.8,
// B17). Alarms are stepped with runDue after advancing the frozen clock;
// nothing sleeps. Expectations are hardcoded.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Indexing } from '@atmusic/core/api-types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';
import { ConfigError, DEFAULT_SLICE_BUDGET, type IngestMode, parseConfig } from '../../src/config';
import type { Db } from '../../src/do/db';
import { type IngestDeps, jetstreamWatchdog } from '../../src/do/ingest/ingest-mode';
import { connect } from '../../src/do/ingest/jetstream-socket';
import { indexing } from '../../src/do/status';
import { type AlarmStorage, dueAt, runDue, TIMER_NAMES, type TimerHandlers } from '../../src/do/timers';
import { checkpointRow, flush, type IngestTestDeps, ingestDeps, jetstreamServer } from '../fixtures/jetstream-server';
import { INGEST_TEST_ENV, withIngestIndex } from './node-index';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const status = (db: Db, nowMs: number, mode: IngestMode): Indexing => indexing(db, nowMs, { mode });

/** One alarm through the timer multiplexer, where only the watchdog does work. */
function step(storage: AlarmStorage, m: IngestTestDeps, d: IngestDeps) {
  const handlers = Object.fromEntries(TIMER_NAMES.map((n) => [n, async () => {}])) as unknown as TimerHandlers;
  handlers['jetstream-watchdog'] = async (now) => {
    await jetstreamWatchdog(m, d, now);
  };
  return runDue(storage, m.db, m.clock.nowMs(), handlers, { maxRuns: 10 }).then((report) => {
    expect(report.failed).toEqual([]);
    return report;
  });
}

/** The source text of one of the four N7-01 files, read from disk. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../src');
const source = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.map((i) => i.field);
    throw err;
  }
  return [];
}

it('INGEST_MODE accepts socket and off only, parseConfig has no PLAN, DO_LOCATION_HINT or budget tier, and no pulse timer or pulse code path remains in config.ts, ingest-mode.ts, jetstream-socket.ts or index-core.ts', () => {
  // The harness env still names the Workers-era vars for the integrator's
  // env.ts rewrite; parseConfig neither reads nor types them.
  const { PLAN: _plan, DO_LOCATION_HINT: _hint, CURSOR_KEY: _key, ...vars } = INGEST_TEST_ENV;
  const options = { allowFixturePrefix: true };
  for (const mode of ['socket', 'off'] as const) {
    const cfg = parseConfig({ ...vars, INGEST_MODE: mode }, options);
    expect(cfg.ingestMode).toBe(mode);
    expect(cfg.budget).toEqual(DEFAULT_SLICE_BUDGET);
    expect(cfg.budget.subrequestsPerSlice).toBe(200);
    expect(cfg).not.toHaveProperty('plan');
    expect(Object.keys(cfg)).not.toContain('doLocationHint');
  }
  // No default: an empty or unknown mode names the field, as does the retired pulse.
  for (const mode of ['', 'pulse', 'poll', 'PULSE']) {
    let caught: ConfigError | undefined;
    try {
      parseConfig({ ...vars, INGEST_MODE: mode }, options);
    } catch (err) {
      if (err instanceof ConfigError) caught = err;
      else throw err;
    }
    expect(caught?.issues, mode).toEqual([{ field: 'INGEST_MODE', message: 'must be socket or off' }]);
  }
  // One fixed budget is configured; there is no tier to select by PLAN.
  expect(DEFAULT_SLICE_BUDGET).toEqual({
    drainHints: 200,
    subrequestsPerSlice: 200,
    maxEntriesPerSlice: 2000,
    concurrentFetches: 4,
    perHostConcurrency: 2,
  });
  expect(issuesOf(() => parseConfig({ ...vars, INGEST_MODE: 'off', JETSTREAM_URLS: '' }, options))).toEqual([]);

  // Source text: the retired symbols are gone (comments may still name the
  // retirement, so the checks target code tokens, not the word).
  const config = source('config.ts');
  const ingestMode = source('do/ingest/ingest-mode.ts');
  const socket = source('do/ingest/jetstream-socket.ts');
  const indexCore = source('app/index-core.ts');
  const nodeConfig = source('node/config.ts');
  const drain = source('do/ingest/verify-drain.ts');
  const accounts = source('do/ingest/accounts.ts');
  const sweeps = source('do/ingest/sweeps.ts');
  for (const [name, text] of [
    ['config.ts', config],
    ['ingest-mode.ts', ingestMode],
    ['jetstream-socket.ts', socket],
    ['index-core.ts', indexCore],
  ] as const) {
    for (const token of [
      "'pulse'",
      '"pulse"',
      'PulseTimer',
      'pulseTimer',
      'PULSE_DRAIN_MAX_MS',
      'env.PLAN',
      'env.DO_LOCATION_HINT',
      'doLocationHint',
      'LOCATION_HINTS',
      'BUDGETS.free',
    ]) {
      expect(text.includes(token), `${name} still contains ${token}`).toBe(false);
    }
  }
  expect(config).toMatch(/must be socket or off/);
  expect(config).not.toMatch(/^\s*free:\s*\{/m);
  expect(ingestMode).not.toMatch(/export (async )?function pulse\b/);
  expect(socket).not.toMatch(/onOutcome|onEnd|LinkMode|QUIET_PULSE/);
  // parseNodeConfig refuses the vars (ADR 0005 §3.8) and no longer supplies PLAN.
  expect(nodeConfig).not.toMatch(/PLAN:\s*'paid'/);
  expect(nodeConfig).not.toMatch(/DO_LOCATION_HINT:\s*''/);
  for (const [name, text] of [
    ['verify-drain.ts', drain],
    ['accounts.ts', accounts],
    ['sweeps.ts', sweeps],
  ] as const) {
    expect(text, `${name} still selects a plan tier`).not.toMatch(/config\.plan|plan === ['"]free['"]/);
  }
});

it('off mode never connects, closes an open socket, and does not reschedule the watchdog', async () => {
  const clock = fixedClock();
  const offServer = jetstreamServer({ clock });
  await withIngestIndex(async (i) => {
    const m = ingestDeps(i.db, clock, { mode: 'off' });
    expect(m.config.ingestMode).toBe('off');
    const d: IngestDeps = { connectJetstream: offServer.connect };
    const before = checkpointRow(i.db);
    for (let n = 0; n < 3; n++) {
      expect(await jetstreamWatchdog(m, d, clock.nowMs())).toEqual({ mode: 'off', closed: false });
      clock.advance(5 * MINUTE);
    }
    expect(await connect(m, offServer.connect, clock.nowMs())).toEqual({ ok: false, reason: 'off' });
    expect(offServer.attempts).toEqual([]);
    expect(offServer.fakes[0]!.calls.count()).toBe(0);
    expect(checkpointRow(i.db)).toEqual({ ...before, mode: 'off' });
    expect(dueAt(i.db, 'jetstream-watchdog')).toBeNull();
    expect((await step(i.storage, m, d)).ran).toEqual([]);
    expect(status(i.db, clock.nowMs(), 'off').state).toBe('stale');

    // A socket opened under socket mode is closed by the next off-mode watchdog.
    const socketMode = { ...m, config: { ...m.config, ingestMode: 'socket' as const } };
    expect(await connect(socketMode, offServer.connect, clock.nowMs())).toMatchObject({ ok: true });
    expect(offServer.attempts.length).toBe(1);
    clock.advance(SECOND);
    expect(await jetstreamWatchdog(m, d, clock.nowMs())).toEqual({ mode: 'off', closed: true });
    await flush();
    expect(offServer.last().closed).toBe(true);
    expect(checkpointRow(i.db)).toMatchObject({ connected: 0, updated_at_ms: clock.nowMs(), mode: 'off' });
    expect(offServer.attempts.length).toBe(1);
    // An explicit mode argument overrides the configured one the same way.
    expect(await jetstreamWatchdog(socketMode, d, clock.nowMs(), 'off')).toEqual({ mode: 'off', closed: false });
    expect(offServer.attempts.length).toBe(1);
  });
});
