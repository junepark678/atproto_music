// W1-08: the IndexDO alarm multiplexer (ADR 0004 §5.9) against real DO SQLite
// in workerd (the harness DO applies the production migrations).
//
// Alarm calls are asserted through an injected recording AlarmStorage: the
// frozen fixture instant (2026-01-15) is in the wall-clock past, so a real
// alarm armed at a fixture time would fire at once into the harness DO, which
// has no alarm() handler. Real `storage.setAlarm/getAlarm/deleteAlarm` are
// exercised with FAR_FUTURE due times instead, which never fire during a run.

import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import { type Db, doDb } from '../../src/do/db';
import { SCHEMA_VERSION } from '../../src/do/schema';
import {
  type AlarmStorage,
  armAlarm,
  cancel,
  dueAt,
  nextDue,
  runDue,
  schedule,
  TIMER_FAILURES_COUNTER,
  TIMER_NAMES,
  TIMER_RUN_TIMEOUT_MS,
  TIMER_STREAK_COUNTER,
  type TimerHandlers,
  type TimerName,
  TimerReentryError,
  timerBackoffMs,
} from '../../src/do/timers';
import type { HarnessDO } from '../harness/harness-do';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const NOW = Date.parse('2026-01-15T12:00:00Z');
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 2200-01-15T12:00:00Z: an alarm here never fires while the suite runs. */
const FAR_FUTURE = Date.UTC(2200, 0, 15, 12, 0, 0);
const UNLIMITED = { maxRuns: 100 };

type AlarmCall = { op: 'set'; at: number } | { op: 'delete' };

function recordingAlarms(): { storage: AlarmStorage; calls: AlarmCall[] } {
  const calls: AlarmCall[] = [];
  const storage: AlarmStorage = {
    async setAlarm(at: number | Date) {
      calls.push({ op: 'set', at: typeof at === 'number' ? at : at.getTime() });
    },
    async deleteAlarm() {
      calls.push({ op: 'delete' });
    },
  };
  return { storage, calls };
}

function timerRows(db: Db) {
  return db.all<{ name: string; due_at: number }>('SELECT name, due_at FROM timers ORDER BY name');
}

function timerCounters(db: Db) {
  return db.all<{ name: string; label: string; value: number }>(
    'SELECT name, label, value FROM counters WHERE name IN (?, ?) ORDER BY name DESC, label',
    TIMER_FAILURES_COUNTER,
    TIMER_STREAK_COUNTER,
  );
}

type Behaviour = (now: number, name: TimerName) => Promise<void> | void;

/** Handlers that record each call (name, now) and then do `behaviour[name]`. */
function recordingHandlers(behaviour: Partial<Record<TimerName, Behaviour>> = {}) {
  const calls: Array<{ name: TimerName; now: number }> = [];
  const handlers = Object.fromEntries(
    TIMER_NAMES.map((name) => [
      name,
      async (now: number) => {
        calls.push({ name, now });
        await behaviour[name]?.(now, name);
      },
    ]),
  ) as TimerHandlers;
  return { handlers, calls };
}

describe('timers', () => {
  it('nextDue is the minimum and alarm is armed to it', async () => {
    await runInDurableObject(stubFor('timers-next-due'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const alarms = recordingAlarms();

      // Nothing scheduled: no due time, and the alarm is deleted, not set.
      expect(nextDue(db)).toBeNull();
      expect(armAlarm(alarms.storage, db)).toBeNull();
      expect(alarms.calls).toEqual([{ op: 'delete' }]);

      schedule(db, 'gc', NOW + DAY);
      schedule(db, 'status-sweep', NOW + HOUR);
      schedule(db, 'drain', NOW + 2 * SECOND);
      schedule(db, 'discovery', NOW + DAY + 1);
      // A row this code does not own (e.g. left by older code) never drives the alarm.
      db.run("INSERT INTO timers(name, due_at) VALUES ('legacy-timer', 0)");

      expect(nextDue(db)).toBe(NOW + 2 * SECOND);
      expect(armAlarm(alarms.storage, db)).toBe(NOW + 2 * SECOND);
      expect(alarms.calls).toEqual([{ op: 'delete' }, { op: 'set', at: NOW + 2 * SECOND }]);

      // Cancelling the minimum moves the alarm to the next one.
      expect(cancel(db, 'drain')).toBe(true);
      expect(cancel(db, 'drain')).toBe(false);
      expect(nextDue(db)).toBe(NOW + HOUR);
      expect(armAlarm(alarms.storage, db)).toBe(NOW + HOUR);
      expect(alarms.calls.at(-1)).toEqual({ op: 'set', at: NOW + HOUR });

      // An earlier schedule lowers the minimum.
      schedule(db, 'snapshot', NOW + 500);
      expect(armAlarm(alarms.storage, db)).toBe(NOW + 500);
      expect(alarms.calls.at(-1)).toEqual({ op: 'set', at: NOW + 500 });

      for (const name of TIMER_NAMES) cancel(db, name);
      expect(timerRows(db)).toEqual([{ name: 'legacy-timer', due_at: 0 }]);
      expect(nextDue(db)).toBeNull();
      expect(armAlarm(alarms.storage, db)).toBeNull();
      expect(alarms.calls).toEqual([
        { op: 'delete' },
        { op: 'set', at: NOW + 2 * SECOND },
        { op: 'set', at: NOW + HOUR },
        { op: 'set', at: NOW + 500 },
        { op: 'delete' },
      ]);
    });

    // The same against the real DO alarm.
    await runInDurableObject(stubFor('timers-next-due-real'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      expect(await state.storage.getAlarm()).toBeNull();
      schedule(db, 'identity-sweep', FAR_FUTURE + DAY);
      schedule(db, 'jetstream-watchdog', FAR_FUTURE + MINUTE);
      expect(armAlarm(state.storage, db)).toBe(FAR_FUTURE + MINUTE);
      expect(await state.storage.getAlarm()).toBe(FAR_FUTURE + MINUTE);

      cancel(db, 'jetstream-watchdog');
      expect(armAlarm(state.storage, db)).toBe(FAR_FUTURE + DAY);
      expect(await state.storage.getAlarm()).toBe(FAR_FUTURE + DAY);

      cancel(db, 'identity-sweep');
      expect(armAlarm(state.storage, db)).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('schedule keeps earlier due unless forced', async () => {
    await runInDurableObject(stubFor('timers-schedule'), (_i: HarnessDO, state) => {
      const db = doDb(state.storage);

      expect(schedule(db, 'drain', NOW + 10 * SECOND)).toBe(NOW + 10 * SECOND);
      // Later: ignored.
      expect(schedule(db, 'drain', NOW + 20 * SECOND)).toBe(NOW + 10 * SECOND);
      expect(timerRows(db)).toEqual([{ name: 'drain', due_at: NOW + 10 * SECOND }]);
      // Equal: unchanged.
      expect(schedule(db, 'drain', NOW + 10 * SECOND)).toBe(NOW + 10 * SECOND);
      // Earlier: wins.
      expect(schedule(db, 'drain', NOW + 5 * SECOND)).toBe(NOW + 5 * SECOND);
      expect(dueAt(db, 'drain')).toBe(NOW + 5 * SECOND);
      // Forced later: replaces.
      expect(schedule(db, 'drain', NOW + 30 * SECOND, { force: true })).toBe(NOW + 30 * SECOND);
      expect(timerRows(db)).toEqual([{ name: 'drain', due_at: NOW + 30 * SECOND }]);
      // Forced earlier: replaces too.
      expect(schedule(db, 'drain', NOW + SECOND, { force: true })).toBe(NOW + SECOND);
      // `force: false` is the default rule.
      expect(schedule(db, 'drain', NOW + MINUTE, { force: false })).toBe(NOW + SECOND);

      // Timers are independent rows.
      expect(schedule(db, 'gc', NOW + DAY)).toBe(NOW + DAY);
      expect(timerRows(db)).toEqual([
        { name: 'drain', due_at: NOW + SECOND },
        { name: 'gc', due_at: NOW + DAY },
      ]);

      // After cancel, any due time is accepted again.
      expect(cancel(db, 'drain')).toBe(true);
      expect(dueAt(db, 'drain')).toBeNull();
      expect(schedule(db, 'drain', NOW + HOUR)).toBe(NOW + HOUR);

      // Invalid input never reaches the table.
      const before = timerRows(db);
      expect(() => schedule(db, 'nope' as TimerName, NOW)).toThrow(TypeError);
      expect(() => cancel(db, '~running:drain' as TimerName)).toThrow(TypeError);
      expect(() => schedule(db, 'drain', -1)).toThrow(RangeError);
      expect(() => schedule(db, 'drain', NOW + 0.5)).toThrow(RangeError);
      expect(() => schedule(db, 'drain', Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
      expect(() => schedule(db, 'drain', Number.NaN)).toThrow(RangeError);
      expect(timerRows(db)).toEqual(before);
    });
  });

  it('runDue executes only due timers in priority order', async () => {
    await runInDurableObject(stubFor('timers-run-due'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      // Scheduled in scrambled order; four are due (one exactly at now).
      schedule(db, 'gc', NOW - DAY);
      schedule(db, 'discovery', NOW + HOUR);
      schedule(db, 'identity-sweep', NOW);
      schedule(db, 'status-sweep', NOW + 1);
      schedule(db, 'jetstream-watchdog', NOW - 5 * SECOND);
      schedule(db, 'snapshot', NOW + MINUTE);
      schedule(db, 'drain', NOW - SECOND);

      const claimedDuring: Array<number | null> = [];
      const { handlers, calls } = recordingHandlers({
        // Self-rescheduling handlers. The rescheduled time is later than the
        // old due time and still sticks, because the claimed row is gone.
        drain: (now) => {
          claimedDuring.push(dueAt(db, 'drain'));
          // Asking for "again now" does not run it twice in one call.
          schedule(db, 'drain', now);
        },
        'jetstream-watchdog': (now) => void schedule(db, 'jetstream-watchdog', now + MINUTE),
        'identity-sweep': (now) => void schedule(db, 'identity-sweep', now + DAY),
        // gc does not reschedule itself: it is one-shot.
      });

      const report = await runDue(state.storage, db, NOW, handlers, UNLIMITED);

      expect(calls).toEqual([
        { name: 'drain', now: NOW },
        { name: 'jetstream-watchdog', now: NOW },
        { name: 'identity-sweep', now: NOW },
        { name: 'gc', now: NOW },
      ]);
      expect(report).toEqual({
        ran: ['drain', 'jetstream-watchdog', 'identity-sweep', 'gc'],
        failed: [],
        deferred: [],
        recovered: [],
        superseded: false,
      });
      // While drain ran, its old row was claimed.
      expect(claimedDuring).toEqual([null]);
      expect(timerRows(db)).toEqual([
        { name: 'discovery', due_at: NOW + HOUR },
        { name: 'drain', due_at: NOW },
        { name: 'identity-sweep', due_at: NOW + DAY },
        { name: 'jetstream-watchdog', due_at: NOW + MINUTE },
        { name: 'snapshot', due_at: NOW + MINUTE },
        { name: 'status-sweep', due_at: NOW + 1 },
      ]);
      // Successful runs leave no failure bookkeeping.
      expect(timerCounters(db)).toEqual([]);
      const alarms = recordingAlarms();
      expect(armAlarm(alarms.storage, db)).toBe(NOW);
      expect(alarms.calls).toEqual([{ op: 'set', at: NOW }]);
    });

    // Budget: maxRuns, then a deadline; an earlier handler can cancel a later one.
    await runInDurableObject(stubFor('timers-run-due-budget'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      for (const name of TIMER_NAMES) schedule(db, name, NOW - MINUTE);
      const clock = fixedClock();
      const { handlers, calls } = recordingHandlers({
        snapshot: () => void cancel(db, 'jetstream-watchdog'),
        'status-sweep': () => clock.advance(10 * SECOND),
      });

      const first = await runDue(state.storage, db, NOW, handlers, { maxRuns: 2 });
      expect(calls.map((c) => c.name)).toEqual(['drain', 'snapshot']);
      expect(first.ran).toEqual(['drain', 'snapshot']);
      // jetstream-watchdog was cancelled by snapshot, so it is not deferred.
      expect(first.deferred).toEqual(['status-sweep', 'identity-sweep', 'discovery', 'gc']);
      expect(timerRows(db).map((r) => r.name)).toEqual(['discovery', 'gc', 'identity-sweep', 'status-sweep']);

      const second = await runDue(state.storage, db, NOW, handlers, {
        maxRuns: 100,
        deadline: { clock, atMs: NOW + 5 * SECOND },
      });
      // status-sweep pushed the clock past the deadline: nothing else starts.
      expect(calls.map((c) => c.name)).toEqual(['drain', 'snapshot', 'status-sweep']);
      expect(second).toEqual({
        ran: ['status-sweep'],
        failed: [],
        deferred: ['identity-sweep', 'discovery', 'gc'],
        recovered: [],
        superseded: false,
      });

      const third = await runDue(state.storage, db, NOW, handlers, { maxRuns: 0 });
      expect(third.ran).toEqual([]);
      expect(third.deferred).toEqual(['identity-sweep', 'discovery', 'gc']);
      expect(calls).toHaveLength(3);

      // Not due yet at an earlier now: nothing runs, nothing deferred.
      const early = await runDue(state.storage, db, NOW - 2 * MINUTE, handlers, UNLIMITED);
      expect(early).toEqual({ ran: [], failed: [], deferred: [], recovered: [], superseded: false });
      expect(calls).toHaveLength(3);

      await runDue(state.storage, db, NOW, handlers, UNLIMITED);
      expect(calls.map((c) => c.name)).toEqual([
        'drain',
        'snapshot',
        'status-sweep',
        'identity-sweep',
        'discovery',
        'gc',
      ]);
      expect(timerRows(db)).toEqual([]);

      // A re-entrant call on the same database is refused and runs nothing.
      schedule(db, 'gc', NOW);
      let inner: unknown = null;
      const reentrant = recordingHandlers({
        gc: async () => {
          inner = await runDue(state.storage, db, NOW, handlers, UNLIMITED).catch((e: unknown) => e);
        },
      });
      expect((await runDue(state.storage, db, NOW, reentrant.handlers, UNLIMITED)).ran).toEqual(['gc']);
      expect(inner).toBeInstanceOf(TimerReentryError);
      expect(calls).toHaveLength(6);
    });
  });

  it('throwing handler is rescheduled with backoff and others still run', async () => {
    await runInDurableObject(stubFor('timers-backoff'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const clock = fixedClock();
      for (const name of ['drain', 'snapshot', 'status-sweep', 'gc'] as const) schedule(db, name, NOW);

      let snapshotFails = true;
      const { handlers, calls } = recordingHandlers({
        drain: (now) => void schedule(db, 'drain', now + 2 * SECOND),
        snapshot: async (now) => {
          // It even asked to run again immediately before failing: the
          // backoff still wins, so a failing handler cannot spin the alarm.
          if (snapshotFails) {
            schedule(db, 'snapshot', now);
            throw new Error('snapshot exploded');
          }
          schedule(db, 'snapshot', now + MINUTE);
        },
        // Throws synchronously, before any await.
        'status-sweep': () => {
          throw new TypeError('sync failure');
        },
        gc: (now) => void schedule(db, 'gc', now + DAY),
      });

      const first = await runDue(state.storage, db, clock.nowMs(), handlers, UNLIMITED);
      expect(calls.map((c) => c.name)).toEqual(['drain', 'snapshot', 'status-sweep', 'gc']);
      expect(first.ran).toEqual(['drain', 'gc']);
      expect(first.failed.map(({ error, ...rest }) => ({ ...rest, message: (error as Error).message }))).toEqual([
        { name: 'snapshot', retryAtMs: NOW + 2 * SECOND, streak: 1, message: 'snapshot exploded' },
        { name: 'status-sweep', retryAtMs: NOW + 2 * SECOND, streak: 1, message: 'sync failure' },
      ]);
      expect(timerRows(db)).toEqual([
        { name: 'drain', due_at: NOW + 2 * SECOND },
        { name: 'gc', due_at: NOW + DAY },
        { name: 'snapshot', due_at: NOW + 2 * SECOND },
        { name: 'status-sweep', due_at: NOW + 2 * SECOND },
      ]);
      expect(timerCounters(db)).toEqual([
        { name: TIMER_FAILURES_COUNTER, label: 'snapshot', value: 1 },
        { name: TIMER_FAILURES_COUNTER, label: 'status-sweep', value: 1 },
        { name: TIMER_STREAK_COUNTER, label: 'snapshot', value: 1 },
        { name: TIMER_STREAK_COUNTER, label: 'status-sweep', value: 1 },
      ]);

      // Backoff doubles with the consecutive-failure streak.
      clock.advance(2 * SECOND);
      const second = await runDue(state.storage, db, clock.nowMs(), handlers, UNLIMITED);
      expect(second.ran).toEqual(['drain']);
      expect(second.failed.map((f) => [f.name, f.streak, f.retryAtMs])).toEqual([
        ['snapshot', 2, NOW + 2 * SECOND + 4 * SECOND],
        ['status-sweep', 2, NOW + 2 * SECOND + 4 * SECOND],
      ]);
      expect(dueAt(db, 'snapshot')).toBe(NOW + 6 * SECOND);

      // Recovery resets the streak but keeps the failure total; the handler's
      // own reschedule applies again.
      snapshotFails = false;
      clock.advance(4 * SECOND);
      const third = await runDue(state.storage, db, clock.nowMs(), handlers, UNLIMITED);
      expect(third.ran).toEqual(['drain', 'snapshot']);
      expect(third.failed.map((f) => [f.name, f.streak, f.retryAtMs])).toEqual([
        ['status-sweep', 3, NOW + 6 * SECOND + 8 * SECOND],
      ]);
      expect(dueAt(db, 'snapshot')).toBe(NOW + 6 * SECOND + MINUTE);
      expect(timerCounters(db)).toEqual([
        { name: TIMER_FAILURES_COUNTER, label: 'snapshot', value: 2 },
        { name: TIMER_FAILURES_COUNTER, label: 'status-sweep', value: 3 },
        { name: TIMER_STREAK_COUNTER, label: 'status-sweep', value: 3 },
      ]);
      expect(calls.filter((c) => c.name === 'snapshot')).toHaveLength(3);
      expect(calls.filter((c) => c.name === 'gc')).toHaveLength(1);

      // The alarm follows the earliest of the rescheduled timers.
      const alarms = recordingAlarms();
      expect(armAlarm(alarms.storage, db)).toBe(NOW + 6 * SECOND + 2 * SECOND);
      expect(alarms.calls).toEqual([{ op: 'set', at: NOW + 8 * SECOND }]);
    });

    expect([1, 2, 3, 4, 8, 9, 100].map(timerBackoffMs)).toEqual([
      2_000, 4_000, 8_000, 16_000, 256_000, 300_000, 300_000,
    ]);
  });

  it('hung handler is taken over and rescheduled on the same instance', async () => {
    await runInDurableObject(stubFor('timers-hung'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      // The recording fake stands in for the DO storage: runDue and armAlarm
      // share its identity as the run guard, and no real alarm is armed at a
      // (wall-clock past) fixture time.
      const alarms = recordingAlarms();
      const storage = alarms.storage;
      schedule(db, 'drain', NOW);
      schedule(db, 'gc', NOW + DAY);

      // drain hangs until the test rejects it.
      let rejectHung: (error: Error) => void = () => {};
      const hung = recordingHandlers({
        drain: () =>
          new Promise<void>((_resolve, reject) => {
            rejectHung = reject;
          }),
      });
      const hungRun = runDue(storage, db, NOW, hung.handlers, UNLIMITED);
      expect(hung.calls).toEqual([{ name: 'drain', now: NOW }]);
      expect(timerRows(db)).toEqual([
        { name: 'gc', due_at: NOW + DAY },
        { name: '~running:drain', due_at: NOW },
      ]);

      // While it is in flight the alarm is armed at the takeover time, not at
      // the claim's past due time (which nextDue still reports).
      const takeoverAt = NOW + TIMER_RUN_TIMEOUT_MS;
      expect(nextDue(db)).toBe(NOW);
      expect(armAlarm(storage, db)).toBe(takeoverAt);
      expect(alarms.calls).toEqual([{ op: 'set', at: takeoverAt }]);

      // Before the timeout a second call is refused and changes nothing.
      const next = recordingHandlers({ drain: (now) => void schedule(db, 'drain', now + 2 * SECOND) });
      await expect(runDue(storage, db, takeoverAt - 1, next.handlers, UNLIMITED)).rejects.toBeInstanceOf(
        TimerReentryError,
      );
      expect(next.calls).toEqual([]);
      expect(timerCounters(db)).toEqual([{ name: TIMER_STREAK_COUNTER, label: 'drain', value: 1 }]);

      // At the timeout the second call on the same instance takes over: the
      // hung drain counts as a failure and is rescheduled with backoff.
      const takeover = await runDue(storage, db, takeoverAt, next.handlers, UNLIMITED);
      expect(takeover.recovered.map(({ error, ...rest }) => ({ ...rest, message: (error as Error).message }))).toEqual([
        {
          name: 'drain',
          retryAtMs: takeoverAt + 2 * SECOND,
          streak: 1,
          message: `timer handler did not complete within ${TIMER_RUN_TIMEOUT_MS} ms (hung run taken over)`,
        },
      ]);
      expect(takeover).toMatchObject({ ran: [], failed: [], deferred: [], superseded: false });
      expect(next.calls).toEqual([]);
      expect(timerRows(db)).toEqual([
        { name: 'drain', due_at: takeoverAt + 2 * SECOND },
        { name: 'gc', due_at: NOW + DAY },
      ]);
      expect(timerCounters(db)).toEqual([
        { name: TIMER_FAILURES_COUNTER, label: 'drain', value: 1 },
        { name: TIMER_STREAK_COUNTER, label: 'drain', value: 1 },
      ]);
      expect(armAlarm(storage, db)).toBe(takeoverAt + 2 * SECOND);
      expect(alarms.calls.at(-1)).toEqual({ op: 'set', at: takeoverAt + 2 * SECOND });

      // The rescheduled drain runs again on the same instance. While its new
      // claim is held, the hung handler finally rejects: the superseded run
      // stops and touches neither the new claim nor the failure counters.
      const retryAt = takeoverAt + 2 * SECOND;
      let staleReport: unknown = null;
      let duringNewClaim: unknown = null;
      const retry = recordingHandlers({
        drain: async (now) => {
          rejectHung(new Error('late failure from the hung handler'));
          staleReport = await hungRun;
          duringNewClaim = timerRows(db);
          schedule(db, 'drain', now + 2 * SECOND);
        },
      });
      const retried = await runDue(storage, db, retryAt, retry.handlers, UNLIMITED);
      expect(staleReport).toEqual({ ran: [], failed: [], deferred: [], recovered: [], superseded: true });
      expect(duringNewClaim).toEqual([
        { name: 'gc', due_at: NOW + DAY },
        { name: '~running:drain', due_at: retryAt },
      ]);
      expect(retried).toEqual({ ran: ['drain'], failed: [], deferred: [], recovered: [], superseded: false });
      expect(retry.calls).toEqual([{ name: 'drain', now: retryAt }]);
      expect(timerRows(db)).toEqual([
        { name: 'drain', due_at: retryAt + 2 * SECOND },
        { name: 'gc', due_at: NOW + DAY },
      ]);
      // Success cleared the streak; the hung run's late rejection added no failure.
      expect(timerCounters(db)).toEqual([{ name: TIMER_FAILURES_COUNTER, label: 'drain', value: 1 }]);
      expect(nextDue(db)).toBe(retryAt + 2 * SECOND);

      // The guard is released: a normal call runs again.
      expect((await runDue(storage, db, retryAt + 2 * SECOND, retry.handlers, UNLIMITED)).ran).toEqual(['drain']);
    });

    // Rows scheduled during the hang (a fresh drain, another due timer) do not
    // pull the alarm before the takeover time, and a run at the armed time
    // starts instead of throwing TimerReentryError.
    await runInDurableObject(stubFor('timers-hung-fresh-rows'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const alarms = recordingAlarms();
      const storage = alarms.storage;
      schedule(db, 'drain', NOW);
      const hung = recordingHandlers({ drain: () => new Promise<void>(() => {}) });
      void runDue(storage, db, NOW, hung.handlers, UNLIMITED);
      const takeoverAt = NOW + TIMER_RUN_TIMEOUT_MS;

      expect(schedule(db, 'drain', NOW + SECOND)).toBe(NOW + SECOND);
      expect(schedule(db, 'snapshot', NOW + 500)).toBe(NOW + 500);
      expect(schedule(db, 'gc', takeoverAt + HOUR)).toBe(takeoverAt + HOUR);
      expect(timerRows(db)).toEqual([
        { name: 'drain', due_at: NOW + SECOND },
        { name: 'gc', due_at: takeoverAt + HOUR },
        { name: 'snapshot', due_at: NOW + 500 },
        { name: '~running:drain', due_at: NOW },
      ]);
      expect(nextDue(db)).toBe(NOW);
      expect(armAlarm(storage, db)).toBe(takeoverAt);
      expect(alarms.calls).toEqual([{ op: 'set', at: takeoverAt }]);
      // Any earlier run is refused and changes nothing.
      const next = recordingHandlers();
      for (const at of [NOW + 500, NOW + SECOND, takeoverAt - 1]) {
        await expect(runDue(storage, db, at, next.handlers, UNLIMITED)).rejects.toBeInstanceOf(TimerReentryError);
      }
      expect(next.calls).toEqual([]);
      expect(timerCounters(db)).toEqual([{ name: TIMER_STREAK_COUNTER, label: 'drain', value: 1 }]);

      // The alarm firing at the armed time starts: it takes the hung run over
      // and runs the other due timer.
      const fired = await runDue(storage, db, takeoverAt, next.handlers, UNLIMITED);
      expect(fired.recovered.map((f) => [f.name, f.retryAtMs])).toEqual([['drain', takeoverAt + 2 * SECOND]]);
      expect(fired.ran).toEqual(['snapshot']);
      expect(next.calls).toEqual([{ name: 'snapshot', now: takeoverAt }]);
      expect(timerRows(db)).toEqual([
        { name: 'drain', due_at: takeoverAt + 2 * SECOND },
        { name: 'gc', due_at: takeoverAt + HOUR },
      ]);
      // With the guard released the alarm follows min(due_at) again.
      expect(armAlarm(storage, db)).toBe(takeoverAt + 2 * SECOND);
      expect(alarms.calls.at(-1)).toEqual({ op: 'set', at: takeoverAt + 2 * SECOND });
    });
  });

  it('Db wrappers over one storage share the run guard', async () => {
    await runInDurableObject(stubFor('timers-two-wrappers'), async (_i: HarnessDO, state) => {
      const db1 = doDb(state.storage);
      const db2 = doDb(state.storage);
      expect(db1).not.toBe(db2);
      schedule(db1, 'drain', NOW);

      let release: () => void = () => {};
      const first = recordingHandlers({
        drain: (now) =>
          new Promise<void>((resolve) => {
            release = () => {
              schedule(db1, 'drain', now + 2 * SECOND);
              resolve();
            };
          }),
      });
      const run1 = runDue(state.storage, db1, NOW, first.handlers, UNLIMITED);
      expect(first.calls).toEqual([{ name: 'drain', now: NOW }]);

      // A second run through the other wrapper sees the live claim as live,
      // not as an orphan: refused, nothing recovered or rescheduled.
      const second = recordingHandlers();
      await expect(runDue(state.storage, db2, NOW + 1, second.handlers, UNLIMITED)).rejects.toBeInstanceOf(
        TimerReentryError,
      );
      expect(second.calls).toEqual([]);
      expect(timerRows(db2)).toEqual([{ name: '~running:drain', due_at: NOW }]);
      expect(timerCounters(db2)).toEqual([{ name: TIMER_STREAK_COUNTER, label: 'drain', value: 1 }]);

      release();
      expect(await run1).toEqual({ ran: ['drain'], failed: [], deferred: [], recovered: [], superseded: false });
      expect(first.calls).toHaveLength(1);
      expect(timerRows(db2)).toEqual([{ name: 'drain', due_at: NOW + 2 * SECOND }]);
      // The successful run is not recorded as a failure.
      expect(timerCounters(db2)).toEqual([]);

      // Guard released: the other wrapper runs normally.
      expect(await runDue(state.storage, db2, NOW + 2 * SECOND, second.handlers, UNLIMITED)).toEqual({
        ran: ['drain'],
        failed: [],
        deferred: [],
        recovered: [],
        superseded: false,
      });
    });
  });

  it('state survives DO eviction (same storage)', async () => {
    const stub = stubFor('timers-evict');
    let pendingRun: Promise<unknown> | null = null;
    let before: HarnessDO | null = null;

    await runInDurableObject(stub, async (instance: HarnessDO, state) => {
      before = instance;
      const db = instance.db;
      schedule(db, 'drain', NOW - SECOND);
      schedule(db, 'snapshot', NOW);
      schedule(db, 'status-sweep', NOW + HOUR);
      schedule(db, 'gc', NOW + DAY);

      // One completed run with a failure, so a streak exists before eviction.
      const failing = recordingHandlers({
        snapshot: () => {
          throw new Error('pds down');
        },
        drain: (now) => void schedule(db, 'drain', now + 2 * SECOND),
      });
      const report = await runDue(state.storage, db, NOW, failing.handlers, UNLIMITED);
      expect(report.ran).toEqual(['drain']);
      expect(report.failed.map((f) => [f.name, f.retryAtMs])).toEqual([['snapshot', NOW + 2 * SECOND]]);

      // Then a run that dies with the instance: drain never settles.
      const hanging = recordingHandlers({ drain: () => new Promise<void>(() => {}) });
      pendingRun = runDue(state.storage, db, NOW + 2 * SECOND, hanging.handlers, UNLIMITED);
      expect(hanging.calls).toEqual([{ name: 'drain', now: NOW + 2 * SECOND }]);
    });
    expect(pendingRun).not.toBeNull();

    const persisted = [
      { name: 'gc', due_at: NOW + DAY },
      { name: 'snapshot', due_at: NOW + 2 * SECOND },
      { name: 'status-sweep', due_at: NOW + HOUR },
      { name: '~running:drain', due_at: NOW + 2 * SECOND },
    ];
    const counters = [
      { name: TIMER_FAILURES_COUNTER, label: 'snapshot', value: 1 },
      { name: TIMER_STREAK_COUNTER, label: 'drain', value: 1 },
      { name: TIMER_STREAK_COUNTER, label: 'snapshot', value: 1 },
    ];
    await runInDurableObject(stub, (instance: HarnessDO) => {
      expect(timerRows(instance.db)).toEqual(persisted);
      expect(timerCounters(instance.db)).toEqual(counters);
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance: HarnessDO, state) => {
      expect(instance).not.toBe(before);
      expect(instance.migration).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      const db = instance.db;
      // Same rows, same counters, same next due (the orphaned claim included).
      expect(timerRows(db)).toEqual(persisted);
      expect(timerCounters(db)).toEqual(counters);
      expect(nextDue(db)).toBe(NOW + 2 * SECOND);
      const alarms = recordingAlarms();
      expect(armAlarm(alarms.storage, db)).toBe(NOW + 2 * SECOND);
      expect(alarms.calls).toEqual([{ op: 'set', at: NOW + 2 * SECOND }]);

      // The new instance recovers the lost drain run with backoff (streak 1
      // from its claim) and continues snapshot's streak to 2.
      const after = NOW + 2 * SECOND;
      const { handlers, calls } = recordingHandlers({
        snapshot: (now) => void schedule(db, 'snapshot', now + MINUTE),
        drain: (now) => void schedule(db, 'drain', now + 2 * SECOND),
      });
      const report = await runDue(state.storage, db, after, handlers, UNLIMITED);
      expect(report.superseded).toBe(false);
      expect(report.recovered.map(({ error, ...rest }) => rest)).toEqual([
        { name: 'drain', retryAtMs: after + 2 * SECOND, streak: 1 },
      ]);
      expect(calls).toEqual([{ name: 'snapshot', now: after }]);
      expect(report.ran).toEqual(['snapshot']);
      expect(timerRows(db)).toEqual([
        { name: 'drain', due_at: after + 2 * SECOND },
        { name: 'gc', due_at: NOW + DAY },
        { name: 'snapshot', due_at: after + MINUTE },
        { name: 'status-sweep', due_at: NOW + HOUR },
      ]);
      expect(timerCounters(db)).toEqual([
        { name: TIMER_FAILURES_COUNTER, label: 'drain', value: 1 },
        { name: TIMER_FAILURES_COUNTER, label: 'snapshot', value: 1 },
        { name: TIMER_STREAK_COUNTER, label: 'drain', value: 1 },
      ]);

      // And the recovered timer runs normally afterwards.
      const later = await runDue(state.storage, db, after + 2 * SECOND, handlers, UNLIMITED);
      expect(later.ran).toEqual(['drain']);
      expect(timerCounters(db)).toEqual([
        { name: TIMER_FAILURES_COUNTER, label: 'drain', value: 1 },
        { name: TIMER_FAILURES_COUNTER, label: 'snapshot', value: 1 },
      ]);
    });

    // The real DO alarm survives eviction too, and re-arming from the table
    // gives the same time.
    const real = stubFor('timers-evict-real-alarm');
    await runInDurableObject(real, async (instance: HarnessDO, state) => {
      schedule(instance.db, 'discovery', FAR_FUTURE + DAY);
      schedule(instance.db, 'jetstream-watchdog', FAR_FUTURE + MINUTE);
      expect(armAlarm(state.storage, instance.db)).toBe(FAR_FUTURE + MINUTE);
    });
    await evictDurableObject(real);
    await runInDurableObject(real, async (instance: HarnessDO, state) => {
      expect(await state.storage.getAlarm()).toBe(FAR_FUTURE + MINUTE);
      expect(timerRows(instance.db)).toEqual([
        { name: 'discovery', due_at: FAR_FUTURE + DAY },
        { name: 'jetstream-watchdog', due_at: FAR_FUTURE + MINUTE },
      ]);
      expect(armAlarm(state.storage, instance.db)).toBe(FAR_FUTURE + MINUTE);
      expect(await state.storage.getAlarm()).toBe(FAR_FUTURE + MINUTE);
    });
  });
});
