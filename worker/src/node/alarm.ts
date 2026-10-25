// The Node host's scheduler (ADR 0005 §3.3, N1-03): the alarm that drives a
// timer lane, the wake heartbeat and the in-process ensureRunning interval
// that replaces the Workers cron trigger.
//
// NodeAlarm implements the timer multiplexer's AlarmStorage
// (`worker/src/do/timers.ts`) over one setTimeout, with the Durable Object
// alarm semantics the multiplexer was written against:
// - One pending alarm. `setAlarm(t)` replaces it, `deleteAlarm()` cancels it,
//   and a due alarm is cleared before its callback starts, so a callback that
//   does not call `setAlarm` again is one-shot (`IndexCore.alarm()` re-arms in
//   `finally`, as index-do.ts does).
// - Wall-clock due time. libuv timers count monotonic time and Node refuses
//   delays above 2^31−1 ms (it warns and fires after 1 ms instead). The delay
//   is therefore clamped to MAX_TIMER_DELAY_MS, and a timer that fires before
//   the wall-clock due time (a clamped delay, or a clock set back) re-arms for
//   the rest instead of running the callback early.
// - One callback at a time. No timer is armed while the callback runs; a
//   `setAlarm` from inside the callback (or from an RPC meanwhile) is recorded
//   and armed when the callback settles, at once if it is already overdue.
// - Retries. A DO alarm whose handler throws is retried by the platform; a
//   Node timer is not. Every callback error (a synchronous throw or a
//   rejection) is caught, logged once by error name only (never the message,
//   which may carry request data), and the alarm is re-armed at
//   `now + backoffMs(streak)` (2 s, 4 s, ... 5 min, the multiplexer's own
//   backoff), or earlier when the callback had already set an earlier alarm.
//   A success resets the streak. No error ever escapes to the process.
//
// The heartbeat (`startHeartbeat`, every 30 s) covers timers that stall while
// the machine is suspended: the monotonic clock stops during a suspend, so a
// pending setTimeout fires late by the length of the suspend. Each tick it
// compares every target's due time (min(timers.due_at) of its lane, or the
// alarm's own armed time, which `armAlarm` keeps equal to it) with the wall
// clock and wakes every overdue target.
//
// The ensureRunning interval (`startEnsureRunning`, every 5 min) calls
// `ensureRunning()` exactly once per tick, like the `*/5 * * * *` cron did
// (worker/src/scheduled.ts): it restores the periodic timers and re-arms a
// lost alarm. A tick is skipped while the previous call is still running, and
// a failure is logged (error name only) and left to the next tick.
//
// Every timer comes from an injected HostTimers (Node's by default) and is
// unref'd, so the scheduler never keeps the process alive on its own; the HTTP
// listener and the Jetstream socket do. Time comes from an injected Clock.
// `stop()` (on each piece, or on a NodeScheduler for all of them) clears every
// timer for shutdown, and nothing re-arms after it.

import {
  clearInterval as nodeClearInterval,
  clearTimeout as nodeClearTimeout,
  setInterval as nodeSetInterval,
  setTimeout as nodeSetTimeout,
} from 'node:timers';
import { type Clock, systemClock } from '@atmusic/core/deps';
import type { Logger } from '../do/contracts';
import { type AlarmStorage, timerBackoffMs } from '../do/timers';

/** The largest delay a Node timer accepts (2^31−1 ms, about 24.8 days). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** The wake heartbeat's period (ADR 0005 §3.3). */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** The ensureRunning interval's period, the old cron cadence (ADR 0005 §3.3). */
export const ENSURE_RUNNING_INTERVAL_MS = 5 * 60_000;

/** A timer handle; Node's Timeout has `unref`, a fake may too. */
export interface TimerHandle {
  unref?(): unknown;
}

/** The timer functions the scheduler uses, injectable for fake timers. */
export interface HostTimers {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(callback: () => void, intervalMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/** Node's own timers (node:timers). */
export const nodeTimers: HostTimers = {
  setTimeout: (callback, delayMs) => nodeSetTimeout(callback, delayMs),
  clearTimeout: (handle) => nodeClearTimeout(handle as ReturnType<typeof nodeSetTimeout>),
  setInterval: (callback, intervalMs) => nodeSetInterval(callback, intervalMs),
  clearInterval: (handle) => nodeClearInterval(handle as ReturnType<typeof nodeSetInterval>),
};

/** Something with timers to clear at shutdown. */
export interface Stoppable {
  stop(): void;
}

/** What the heartbeat watches: one timer lane. */
export interface WakeTarget {
  /** The wall-clock time the lane is due (min(timers.due_at) of its names), or null. */
  nextDueMs(): number | null;
  /** Runs the lane now. False when it did not start (already running, or stopped). */
  wake(): boolean;
}

/** What the ensureRunning interval drives (IndexCore, or anything with the method). */
export interface EnsureRunningTarget {
  ensureRunning(): void | Promise<void>;
}

export interface SchedulerDeps {
  log: Logger;
  /** Wall clock; `systemClock` by default. */
  clock?: Clock;
  /** Timer functions; Node's by default. */
  timers?: HostTimers;
}

export interface NodeAlarmOptions extends SchedulerDeps {
  /** The alarm callback (`IndexCore.alarm()` for the core lane, its extension twin for the other). */
  onAlarm: () => void | Promise<void>;
  /** A label for the logs ("core", "extension"). */
  name?: string;
  /** Retry delay after `streak` consecutive callback failures; the multiplexer's backoff by default. */
  backoffMs?: (streak: number) => number;
}

const RESOLVED: Promise<void> = Promise.resolve();

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function unref(handle: TimerHandle): TimerHandle {
  handle.unref?.();
  return handle;
}

function assertIntervalMs(intervalMs: number): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`interval must be an integer number of ms in [1, ${MAX_TIMER_DELAY_MS}], got ${intervalMs}`);
  }
}

/** One DO-style alarm over one unref'd setTimeout (see the file comment). */
export class NodeAlarm implements AlarmStorage, WakeTarget, Stoppable {
  readonly name: string;
  readonly #onAlarm: () => void | Promise<void>;
  readonly #clock: Clock;
  readonly #timers: HostTimers;
  readonly #log: Logger;
  readonly #backoffMs: (streak: number) => number;

  #dueAt: number | null = null;
  #handle: TimerHandle | null = null;
  #busy = false;
  #idle: Promise<void> = RESOLVED;
  #stopped = false;
  #streak = 0;

  constructor(options: NodeAlarmOptions) {
    this.name = options.name ?? 'alarm';
    this.#onAlarm = options.onAlarm;
    this.#clock = options.clock ?? systemClock;
    this.#timers = options.timers ?? nodeTimers;
    this.#log = options.log;
    this.#backoffMs = options.backoffMs ?? timerBackoffMs;
  }

  /** Sets (or replaces) the pending alarm at wall-clock epoch ms `scheduledTime`. */
  setAlarm(scheduledTime: number | Date): Promise<void> {
    const ms = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
    if (!Number.isSafeInteger(ms)) {
      throw new RangeError(`setAlarm needs an integer epoch ms, got ${String(scheduledTime)}`);
    }
    this.#dueAt = ms;
    this.#arm();
    return RESOLVED;
  }

  /** Cancels the pending alarm. A callback already running finishes. */
  deleteAlarm(): Promise<void> {
    this.#dueAt = null;
    this.#disarm();
    return RESOLVED;
  }

  /** The pending alarm's due time, or null. */
  nextDueMs(): number | null {
    return this.#dueAt;
  }

  /** True while the callback runs. */
  get running(): boolean {
    return this.#busy;
  }

  /**
   * Runs the callback now (the heartbeat's wake). A pending alarm that is due
   * is consumed; a later one stays pending. False while the callback already
   * runs, or after `stop()`.
   */
  wake(): boolean {
    if (this.#stopped || this.#busy) return false;
    this.#fire();
    return true;
  }

  /** Settles once no callback is running. */
  whenIdle(): Promise<void> {
    return this.#idle;
  }

  /** Clears the timer for shutdown; nothing is armed or fired afterwards. */
  stop(): void {
    this.#stopped = true;
    this.#disarm();
  }

  #disarm(): void {
    if (this.#handle !== null) {
      this.#timers.clearTimeout(this.#handle);
      this.#handle = null;
    }
  }

  #arm(): void {
    this.#disarm();
    if (this.#stopped || this.#busy || this.#dueAt === null) return;
    const delay = Math.min(Math.max(this.#dueAt - this.#clock.nowMs(), 0), MAX_TIMER_DELAY_MS);
    this.#handle = unref(this.#timers.setTimeout(() => this.#onTimer(), delay));
  }

  #onTimer(): void {
    this.#handle = null;
    if (this.#stopped || this.#busy || this.#dueAt === null) return;
    // Early by the wall clock (a clamped delay, or a clock set back): re-arm for the rest.
    if (this.#clock.nowMs() < this.#dueAt) this.#arm();
    else this.#fire();
  }

  #fire(): void {
    this.#disarm();
    if (this.#dueAt !== null && this.#dueAt <= this.#clock.nowMs()) this.#dueAt = null;
    this.#busy = true;
    this.#idle = this.#run().then(() => {
      this.#busy = false;
      this.#arm();
    });
  }

  async #run(): Promise<void> {
    try {
      await this.#onAlarm();
      this.#streak = 0;
    } catch (error) {
      this.#streak += 1;
      const retryAtMs = this.#clock.nowMs() + this.#backoffMs(this.#streak);
      if (this.#dueAt === null || retryAtMs < this.#dueAt) this.#dueAt = retryAtMs;
      try {
        this.#log.log('error', 'alarm.callback_failed', {
          alarm: this.name,
          error: errorName(error),
          streak: this.#streak,
          retryAtMs: this.#dueAt,
        });
      } catch {
        // A broken log sink must not stop the retry from being armed.
      }
    }
  }
}

/**
 * Every `intervalMs` (30 s), wakes each target whose due time has passed by
 * the wall clock. A target's due time is normally reached by its own timer;
 * after a suspend that timer is late by the suspend's length, and the
 * heartbeat fires it within one period of the wake-up instead.
 */
export function startHeartbeat(
  core: WakeTarget | readonly WakeTarget[],
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  deps: SchedulerDeps,
): Stoppable {
  assertIntervalMs(intervalMs);
  const targets: readonly WakeTarget[] = Array.isArray(core) ? core : [core as WakeTarget];
  const clock = deps.clock ?? systemClock;
  const timers = deps.timers ?? nodeTimers;
  const tick = (): void => {
    for (const [index, target] of targets.entries()) {
      try {
        const due = target.nextDueMs();
        const now = clock.nowMs();
        if (due === null || due > now) continue;
        if (target.wake()) {
          deps.log.log('warn', 'heartbeat.overdue_fired', {
            alarm: target instanceof NodeAlarm ? target.name : index,
            lateMs: now - due,
          });
        }
      } catch (error) {
        deps.log.log('error', 'heartbeat.wake_failed', { alarm: index, error: errorName(error) });
      }
    }
  };
  let handle: TimerHandle | null = unref(timers.setInterval(tick, intervalMs));
  return {
    stop() {
      if (handle !== null) timers.clearInterval(handle);
      handle = null;
    },
  };
}

/**
 * Every `intervalMs` (5 min), calls `core.ensureRunning()` once, as the cron
 * trigger did. A tick while the previous call is still pending is skipped.
 * Errors are logged by name and never escape; the next tick tries again. The
 * first call is one period after the start (composition calls ensureRunning
 * itself at startup).
 */
export function startEnsureRunning(
  core: EnsureRunningTarget,
  intervalMs: number = ENSURE_RUNNING_INTERVAL_MS,
  deps: SchedulerDeps,
): Stoppable {
  assertIntervalMs(intervalMs);
  const timers = deps.timers ?? nodeTimers;
  let inFlight = false;
  let stopped = false;
  const call = async (): Promise<void> => {
    try {
      await core.ensureRunning();
    } catch (error) {
      try {
        deps.log.log('error', 'interval.ensure_running_failed', { error: errorName(error) });
      } catch {
        // Nothing else to do; the next tick tries again.
      }
    } finally {
      inFlight = false;
    }
  };
  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    void call();
  };
  let handle: TimerHandle | null = unref(timers.setInterval(tick, intervalMs));
  return {
    stop() {
      stopped = true;
      if (handle !== null) timers.clearInterval(handle);
      handle = null;
    },
  };
}

/**
 * The process's scheduler: creates the lane alarms and the two intervals with
 * shared deps, and `stop()` clears every timer it created, for shutdown.
 */
export class NodeScheduler implements Stoppable {
  readonly #deps: SchedulerDeps;
  readonly #alarms: NodeAlarm[] = [];
  readonly #intervals: Stoppable[] = [];
  #stopped = false;

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
  }

  /** A new alarm on the shared clock, timers and log. */
  alarm(options: Omit<NodeAlarmOptions, keyof SchedulerDeps>): NodeAlarm {
    const alarm = new NodeAlarm({ ...this.#deps, ...options });
    if (this.#stopped) alarm.stop();
    this.#alarms.push(alarm);
    return alarm;
  }

  /** The wake heartbeat over `core` (by default every alarm created so far). */
  startHeartbeat(core: WakeTarget | readonly WakeTarget[] = [...this.#alarms], intervalMs?: number): Stoppable {
    return this.#track(startHeartbeat(core, intervalMs, this.#deps));
  }

  /** The ensureRunning interval over `core`. */
  startEnsureRunning(core: EnsureRunningTarget, intervalMs?: number): Stoppable {
    return this.#track(startEnsureRunning(core, intervalMs, this.#deps));
  }

  /** Settles once no alarm callback is running. */
  async whenIdle(): Promise<void> {
    await Promise.all(this.#alarms.map((alarm) => alarm.whenIdle()));
  }

  /** Clears every alarm and interval; nothing is armed or fired afterwards. */
  stop(): void {
    this.#stopped = true;
    for (const alarm of this.#alarms) alarm.stop();
    for (const interval of this.#intervals) interval.stop();
  }

  #track(interval: Stoppable): Stoppable {
    if (this.#stopped) interval.stop();
    this.#intervals.push(interval);
    return interval;
  }
}
