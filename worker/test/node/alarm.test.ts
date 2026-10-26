// The Node scheduler (ADR 0005 §3.3; N1-03): NodeAlarm over one setTimeout with
// clamped, wall-clock re-arms and caught callback errors, the 30 s wake
// heartbeat, and the 5-minute ensureRunning interval that replaces the cron.
//
// Determinism: every test injects FakeTimers, a stepped timer queue that
// advances the frozen fixedClock (2026-01-15T12:00:00Z) with it. A machine
// suspend is a wall-clock jump (`clock.advance`) with no timer time passing.
// Nothing sleeps; one test at the end uses Node's real timers only to check
// that the default handles are unref'd and that a 40-day delay is clamped.

import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';
import type { Logger, LogLevel } from '../../src/do/contracts';
import { type AlarmStorage, TIMER_BACKOFF_BASE_MS, timerBackoffMs } from '../../src/do/timers';
import {
  ENSURE_RUNNING_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  type HostTimers,
  MAX_TIMER_DELAY_MS,
  NodeAlarm,
  NodeScheduler,
  startHeartbeat,
  type TimerHandle,
} from '../../src/node/alarm';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface LogEntry {
  level: LogLevel;
  event: string;
  fields: Record<string, unknown> | undefined;
}

function recordingLog(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    log(level, event, fields) {
      entries.push({ level, event, fields });
    },
  };
}

interface FakeEntry extends TimerHandle {
  id: number;
  kind: 'timeout' | 'interval';
  at: number;
  delayMs: number;
  callback: () => void;
  unrefed: boolean;
}

/** Flushes promise jobs (the callbacks' awaits) with Node's real event loop. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A stepped timer queue on monotonic time. `advance(ms)` runs every timer due
 * within `ms` in order, moving the wall clock forward by the same amounts, and
 * flushes promise jobs after each callback.
 */
class FakeTimers implements HostTimers {
  readonly #clock: FixedClock;
  #mono = 0;
  #nextId = 1;
  readonly #active = new Map<number, FakeEntry>();
  /** Every setTimeout delay ever requested, in order. */
  readonly timeoutDelays: number[] = [];

  constructor(clock: FixedClock) {
    this.#clock = clock;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    this.timeoutDelays.push(delayMs);
    return this.#add('timeout', callback, delayMs);
  }

  setInterval(callback: () => void, delayMs: number): TimerHandle {
    return this.#add('interval', callback, delayMs);
  }

  clearTimeout(handle: TimerHandle): void {
    this.#active.delete((handle as FakeEntry).id);
  }

  clearInterval(handle: TimerHandle): void {
    this.#active.delete((handle as FakeEntry).id);
  }

  /** The timers still scheduled. */
  active(): FakeEntry[] {
    return [...this.#active.values()];
  }

  async advance(ms: number): Promise<void> {
    const target = this.#mono + ms;
    for (;;) {
      const next = this.active()
        .filter((entry) => entry.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (next === undefined) break;
      this.#step(next.at);
      if (next.kind === 'interval') next.at += next.delayMs;
      else this.#active.delete(next.id);
      next.callback();
      await flush();
    }
    this.#step(target);
    await flush();
  }

  #step(to: number): void {
    this.#clock.advance(to - this.#mono);
    this.#mono = to;
  }

  #add(kind: FakeEntry['kind'], callback: () => void, delayMs: number): FakeEntry {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_TIMER_DELAY_MS) {
      throw new RangeError(`fake ${kind} got an out-of-range delay ${delayMs}`);
    }
    // Node runs a 0 ms interval every 1 ms; the scheduler never asks for one.
    const period = kind === 'interval' ? Math.max(delayMs, 1) : delayMs;
    const entry: FakeEntry = {
      id: this.#nextId++,
      kind,
      at: this.#mono + period,
      delayMs: period,
      callback,
      unrefed: false,
      unref() {
        entry.unrefed = true;
      },
    };
    this.#active.set(entry.id, entry);
    return entry;
  }
}

function setup() {
  const clock = fixedClock();
  const timers = new FakeTimers(clock);
  const log = recordingLog();
  return { clock, timers, log };
}

it('setAlarm(t) fires once at t; a later setAlarm replaces the pending one; deleteAlarm cancels it', async () => {
  const { clock, timers, log } = setup();
  const firedAt: number[] = [];
  const alarm = new NodeAlarm({ clock, timers, log, onAlarm: () => void firedAt.push(clock.nowMs()) });
  // It is the multiplexer's AlarmStorage.
  const storage: AlarmStorage = alarm;

  const t = clock.nowMs() + MINUTE;
  await storage.setAlarm(t);
  expect(alarm.nextDueMs()).toBe(t);
  expect(timers.active()).toHaveLength(1);
  expect(timers.active()[0]?.unrefed).toBe(true);

  await timers.advance(MINUTE - 1);
  expect(firedAt).toEqual([]);
  await timers.advance(1);
  expect(firedAt).toEqual([t]);
  // Consumed: nothing pending, no timer left, and it never fires again.
  expect(alarm.nextDueMs()).toBeNull();
  expect(timers.active()).toHaveLength(0);
  await timers.advance(DAY);
  expect(firedAt).toEqual([t]);

  // A later setAlarm replaces the pending one (in both directions).
  const early = clock.nowMs() + 10 * SECOND;
  const late = clock.nowMs() + 20 * SECOND;
  await alarm.setAlarm(early);
  await alarm.setAlarm(late);
  expect(alarm.nextDueMs()).toBe(late);
  expect(timers.active()).toHaveLength(1);
  await timers.advance(10 * SECOND);
  expect(firedAt).toEqual([t]);
  await timers.advance(10 * SECOND);
  expect(firedAt).toEqual([t, late]);

  const sooner = clock.nowMs() + 5 * SECOND;
  await alarm.setAlarm(clock.nowMs() + HOUR);
  await alarm.setAlarm(sooner);
  await timers.advance(5 * SECOND);
  expect(firedAt).toEqual([t, late, sooner]);

  // deleteAlarm cancels the pending alarm and its timer.
  await alarm.setAlarm(clock.nowMs() + 5 * SECOND);
  await storage.deleteAlarm();
  expect(alarm.nextDueMs()).toBeNull();
  expect(timers.active()).toHaveLength(0);
  await timers.advance(HOUR);
  expect(firedAt).toEqual([t, late, sooner]);

  // A due time already in the past fires on the next turn (delay 0).
  const past = clock.nowMs() - MINUTE;
  await alarm.setAlarm(past);
  expect(timers.timeoutDelays.at(-1)).toBe(0);
  await timers.advance(0);
  expect(firedAt).toHaveLength(4);
  expect(log.entries).toEqual([]);
});

it('a due time 40 days ahead is reached through clamped re-arms and fires exactly once', async () => {
  const { clock, timers, log } = setup();
  const firedAt: number[] = [];
  const alarm = new NodeAlarm({ clock, timers, log, onAlarm: () => void firedAt.push(clock.nowMs()) });

  const start = clock.nowMs();
  const due = start + 40 * DAY;
  await alarm.setAlarm(due);
  // 40 days (3,456,000,000 ms) is over Node's limit: the first delay is clamped.
  expect(timers.timeoutDelays).toEqual([MAX_TIMER_DELAY_MS]);

  await timers.advance(MAX_TIMER_DELAY_MS);
  // The clamped timer fired early by the wall clock: no callback, re-armed for the rest.
  expect(firedAt).toEqual([]);
  expect(timers.timeoutDelays).toEqual([MAX_TIMER_DELAY_MS, 40 * DAY - MAX_TIMER_DELAY_MS]);
  expect(alarm.nextDueMs()).toBe(due);

  await timers.advance(due - clock.nowMs() - 1);
  expect(firedAt).toEqual([]);
  await timers.advance(1);
  expect(firedAt).toEqual([due]);

  await timers.advance(40 * DAY);
  expect(firedAt).toEqual([due]);
  expect(timers.timeoutDelays).toHaveLength(2);
  expect(timers.timeoutDelays.every((delay) => delay <= MAX_TIMER_DELAY_MS)).toBe(true);
  expect(timers.active()).toHaveLength(0);
  expect(log.entries).toEqual([]);
});

it('a throwing callback is logged once, re-armed at now+backoff, and the process keeps running', async () => {
  const { clock, timers, log } = setup();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUnhandled);
  try {
    const calls: number[] = [];
    const alarm = new NodeAlarm({
      clock,
      timers,
      log,
      name: 'core',
      onAlarm: async () => {
        calls.push(clock.nowMs());
        if (calls.length === 1) throw new TypeError('secret-bearing message: token=abc');
        if (calls.length === 2) await Promise.reject(new RangeError('second'));
      },
    });

    const due = clock.nowMs() + SECOND;
    await alarm.setAlarm(due);
    await timers.advance(SECOND);
    expect(calls).toEqual([due]);
    // Logged once, by error name only, and re-armed at now + backoff(1) = now + 2 s.
    const retry1 = due + TIMER_BACKOFF_BASE_MS;
    expect(log.entries).toEqual([
      {
        level: 'error',
        event: 'alarm.callback_failed',
        fields: { alarm: 'core', error: 'TypeError', streak: 1, retryAtMs: retry1 },
      },
    ]);
    expect(JSON.stringify(log.entries)).not.toContain('token=abc');
    expect(alarm.nextDueMs()).toBe(retry1);
    expect(timers.active()).toHaveLength(1);

    // The retry runs; a rejection is caught the same way, with the next backoff.
    await timers.advance(TIMER_BACKOFF_BASE_MS - 1);
    expect(calls).toHaveLength(1);
    await timers.advance(1);
    expect(calls).toEqual([due, retry1]);
    const retry2 = retry1 + timerBackoffMs(2);
    expect(timerBackoffMs(2)).toBe(4_000);
    expect(log.entries).toHaveLength(2);
    expect(log.entries[1]?.fields).toEqual({ alarm: 'core', error: 'RangeError', streak: 2, retryAtMs: retry2 });
    expect(alarm.nextDueMs()).toBe(retry2);

    // The third run succeeds: no new log line, nothing pending, and the streak resets.
    await timers.advance(timerBackoffMs(2));
    expect(calls).toEqual([due, retry1, retry2]);
    expect(log.entries).toHaveLength(2);
    expect(alarm.nextDueMs()).toBeNull();
    expect(timers.active()).toHaveLength(0);

    // The alarm still works afterwards, and nothing escaped to the process.
    const later = clock.nowMs() + MINUTE;
    await alarm.setAlarm(later);
    await timers.advance(MINUTE);
    expect(calls).toEqual([due, retry1, retry2, later]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    process.off('uncaughtException', onUnhandled);
  }
});

it('a setAlarm made while the callback runs is armed only after it settles, so callbacks never overlap', async () => {
  const { clock, timers, log } = setup();
  const gate: { release?: () => void } = {};
  let concurrent = 0;
  let maxConcurrent = 0;
  const firedAt: number[] = [];
  const alarm = new NodeAlarm({
    clock,
    timers,
    log,
    onAlarm: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      firedAt.push(clock.nowMs());
      // The handler re-arms in-flight (as IndexCore.alarm's finally does) and then blocks.
      await alarm.setAlarm(clock.nowMs() + SECOND);
      if (firedAt.length === 1)
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      concurrent -= 1;
    },
  });

  const first = clock.nowMs() + SECOND;
  await alarm.setAlarm(first);
  await timers.advance(SECOND);
  expect(alarm.running).toBe(true);
  // No timer is armed while it runs, even though the re-armed time passes.
  expect(timers.active()).toHaveLength(0);
  await timers.advance(10 * SECOND);
  expect(firedAt).toEqual([first]);
  expect(alarm.wake()).toBe(false);

  gate.release!();
  await flush();
  expect(alarm.running).toBe(false);
  // The overdue re-arm fires at once (delay 0), and then once more a second later.
  expect(timers.timeoutDelays.at(-1)).toBe(0);
  await timers.advance(0);
  expect(firedAt).toEqual([first, clock.nowMs()]);
  await timers.advance(SECOND);
  expect(firedAt).toHaveLength(3);
  expect(maxConcurrent).toBe(1);
  alarm.stop();
  await alarm.whenIdle();
  expect(timers.active()).toHaveLength(0);
});

it('after the clock jumps 3 h with the timer not yet fired, the heartbeat fires the overdue alarm within 30 s', async () => {
  const { clock, timers, log } = setup();
  const watchedFiredAt: number[] = [];
  const unwatchedFiredAt: number[] = [];
  const watched = new NodeAlarm({
    clock,
    timers,
    log,
    name: 'core',
    onAlarm: () => void watchedFiredAt.push(clock.nowMs()),
  });
  // Control: the same alarm without a heartbeat stays stalled.
  const unwatched = new NodeAlarm({ clock, timers, log, onAlarm: () => void unwatchedFiredAt.push(clock.nowMs()) });
  const heartbeat = startHeartbeat(watched, HEARTBEAT_INTERVAL_MS, { clock, timers, log });

  const due = clock.nowMs() + HOUR;
  await watched.setAlarm(due);
  await unwatched.setAlarm(due);

  // The machine suspends for 3 h: the wall clock jumps, no timer time passes.
  clock.advance(3 * HOUR);
  const wokeAt = clock.nowMs();
  expect(watchedFiredAt).toEqual([]);

  let firedWithinMs: number | null = null;
  for (let elapsed = SECOND; elapsed <= HEARTBEAT_INTERVAL_MS; elapsed += SECOND) {
    await timers.advance(SECOND);
    if (watchedFiredAt.length > 0) {
      firedWithinMs = elapsed;
      break;
    }
  }
  expect(firedWithinMs).not.toBeNull();
  expect(firedWithinMs!).toBeLessThanOrEqual(HEARTBEAT_INTERVAL_MS);
  expect(watchedFiredAt).toEqual([wokeAt + firedWithinMs!]);
  expect(unwatchedFiredAt).toEqual([]);
  expect(log.entries).toEqual([
    {
      level: 'warn',
      event: 'heartbeat.overdue_fired',
      fields: { alarm: 'core', lateMs: wokeAt + firedWithinMs! - due },
    },
  ]);

  // When the stalled timer finally fires, the consumed alarm does not run again.
  await timers.advance(HOUR);
  expect(watchedFiredAt).toHaveLength(1);
  expect(unwatchedFiredAt).toHaveLength(1);
  // A heartbeat tick with nothing overdue wakes nothing.
  await timers.advance(5 * HEARTBEAT_INTERVAL_MS);
  expect(watchedFiredAt).toHaveLength(1);
  expect(log.entries).toHaveLength(1);

  // A lane due time read from elsewhere (min(timers.due_at)) also drives it.
  let laneDue: number | null = clock.nowMs() - MINUTE;
  const lane = {
    nextDueMs: () => laneDue,
    wake: () => {
      laneDue = null;
      return watched.wake();
    },
  };
  const laneHeartbeat = startHeartbeat([lane], HEARTBEAT_INTERVAL_MS, { clock, timers, log });
  await timers.advance(HEARTBEAT_INTERVAL_MS);
  expect(watchedFiredAt).toHaveLength(2);

  heartbeat.stop();
  laneHeartbeat.stop();
  watched.stop();
  unwatched.stop();
  expect(timers.active()).toHaveLength(0);
});

it('the ensureRunning interval calls ensureRunning exactly once per 5 minutes and stop() clears every timer', async () => {
  const { clock, timers, log } = setup();
  const calls: number[] = [];
  const core = {
    async ensureRunning() {
      calls.push(clock.nowMs());
      if (calls.length === 2) throw new Error('index not ready');
    },
  };
  const alarmCalls: number[] = [];
  const scheduler = new NodeScheduler({ clock, timers, log });
  const coreAlarm = scheduler.alarm({ name: 'core', onAlarm: () => void alarmCalls.push(clock.nowMs()) });
  const extensionAlarm = scheduler.alarm({ name: 'extension', onAlarm: () => void alarmCalls.push(clock.nowMs()) });
  scheduler.startHeartbeat();
  scheduler.startEnsureRunning(core);
  const start = clock.nowMs();
  await coreAlarm.setAlarm(start + DAY);
  await extensionAlarm.setAlarm(start + 2 * DAY);

  // Two alarms, the heartbeat and the ensureRunning interval; every one unref'd.
  expect(timers.active()).toHaveLength(4);
  expect(timers.active().every((entry) => entry.unrefed)).toBe(true);
  expect(
    timers
      .active()
      .filter((entry) => entry.kind === 'interval')
      .map((entry) => entry.delayMs),
  ).toEqual([HEARTBEAT_INTERVAL_MS, ENSURE_RUNNING_INTERVAL_MS]);

  await timers.advance(ENSURE_RUNNING_INTERVAL_MS - 1);
  expect(calls).toEqual([]);
  await timers.advance(1);
  expect(calls).toEqual([start + ENSURE_RUNNING_INTERVAL_MS]);

  // Exactly once per period; a failing call is logged by name and the next tick still runs.
  await timers.advance(ENSURE_RUNNING_INTERVAL_MS * 2);
  expect(calls).toEqual([1, 2, 3].map((n) => start + n * ENSURE_RUNNING_INTERVAL_MS));
  expect(log.entries).toEqual([
    { level: 'error', event: 'interval.ensure_running_failed', fields: { error: 'Error' } },
  ]);
  await timers.advance(HOUR - 3 * ENSURE_RUNNING_INTERVAL_MS);
  expect(calls).toHaveLength(12);
  expect(new Set(calls.map((at, i) => at - (start + (i + 1) * ENSURE_RUNNING_INTERVAL_MS)))).toEqual(new Set([0]));

  // stop() clears every timer: none is left, nothing runs, and nothing re-arms.
  scheduler.stop();
  expect(timers.active()).toEqual([]);
  await coreAlarm.setAlarm(clock.nowMs() + SECOND);
  expect(coreAlarm.wake()).toBe(false);
  expect(timers.active()).toEqual([]);
  await timers.advance(3 * DAY);
  expect(calls).toHaveLength(12);
  expect(alarmCalls).toEqual([]);
  await scheduler.whenIdle();
});

it("Node's real timers are unref'd and a 40-day delay is clamped without a TimeoutOverflowWarning", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => void warnings.push(warning.name);
  process.on('warning', onWarning);
  const refedTimeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  const scheduler = new NodeScheduler({ log: recordingLog() });
  try {
    const before = refedTimeouts();
    // Control: a plain ref'd timer is counted, so the check below is not vacuous.
    const control = setTimeout(() => {}, HOUR);
    expect(refedTimeouts()).toBe(before + 1);
    clearTimeout(control);

    const alarm = scheduler.alarm({ onAlarm: () => {} });
    await alarm.setAlarm(Date.now() + 40 * DAY);
    scheduler.startHeartbeat();
    scheduler.startEnsureRunning({ ensureRunning: () => {} });
    expect(refedTimeouts()).toBe(before);
    await flush();
    expect(warnings).not.toContain('TimeoutOverflowWarning');
    expect(alarm.nextDueMs()).not.toBeNull();
  } finally {
    scheduler.stop();
    process.off('warning', onWarning);
  }
});
