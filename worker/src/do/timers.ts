// The IndexDO alarm multiplexer (ADR 0004 §5.9, §6 `timers`).
//
// Every background task is a row `timers(name PK, due_at)` with `due_at` in
// INTEGER epoch ms. The DO has one alarm, always armed at `min(due_at)`.
// `alarm()` (W5-01) calls `runDue`, then `armAlarm`.
//
// - `schedule` is an upsert that keeps the earlier due time unless `force`.
// - `runDue` runs the due timers once each, in the fixed priority order
//   TIMER_NAMES, within a budget. Each handler reschedules itself through
//   `schedule`; a handler that does not is one-shot. A handler that throws (or
//   rejects) is force-rescheduled at `now + timerBackoffMs(streak)` and the
//   remaining timers still run.
// - Claiming a timer renames its row to `~running:<name>` (keeping its
//   due_at) and bumps a durable failure streak in `counters`, in one
//   transaction, before the handler starts. So the handler's own `schedule`
//   inserts a fresh row instead of losing to the old, earlier due time, and a
//   DO that dies mid-handler (eviction, crash, exceeded limits) leaves the
//   claimed row behind. The next `runDue` on a fresh instance treats such an
//   orphan as a failure: it is rescheduled with backoff, never dropped.
//   Alarms are at-least-once, and every step is idempotent (ADR §5.9).
// - One `runDue` at a time per DO storage. The guard is keyed on the storage
//   object passed to `runDue`/`armAlarm` (the instance's `ctx.storage`, which
//   is one object for the instance's lifetime and a new one after eviction),
//   not on the Db wrapper, so every `doDb(storage)` wrapper over it shares
//   one guard. A second call while a handler is in flight throws
//   TimerReentryError, until the in-flight run is TIMER_RUN_TIMEOUT_MS old (by
//   the callers' `now`; the platform's alarm wall-time limit). Then the
//   in-flight run counts as hung: the later call takes over, its claim is
//   treated as a failure (rescheduled with backoff) and the hung run, if it
//   ever settles, changes nothing further.
// - While a run is in flight, `armAlarm` arms no earlier than that run's
//   takeover time, whatever rows exist (the claim, a fresh row its handler or
//   an RPC scheduled, any other due timer), because no `runDue` before then
//   can start. So the alarm is never armed into a run it cannot start.
//   `alarm()` re-arms after `runDue` returns, which restores `min(due_at)`.
// - Counters: `timer_failures/<name>` counts failures (monotonic) and
//   `timer_failure_streak/<name>` holds the consecutive failures (deleted on
//   success); both appear in adminStatus.
//
// Everything is synchronous except `runDue`, so no read-check-write spans an
// await. Time comes from the caller (`now`), never from Date.now().

import type { Clock } from '@atmusic/core/deps';
import type { Db } from './db';

/** Priority order of `runDue` (ADR §5.9). */
export const TIMER_NAMES = [
  'drain',
  'snapshot',
  'jetstream-watchdog',
  'status-sweep',
  'identity-sweep',
  'discovery',
  'gc',
] as const;

export type TimerName = (typeof TIMER_NAMES)[number];

export type TimerHandler = (now: number) => Promise<void>;
export type TimerHandlers = Record<TimerName, TimerHandler>;

export interface ScheduleOptions {
  /** Replace the stored due time even when it is earlier. */
  force?: boolean;
}

export interface RunBudget {
  /** Maximum number of handlers started by this call (a non-negative integer). */
  maxRuns: number;
  /** Start no further handler once `clock.nowMs() >= atMs`. */
  deadline?: { clock: Clock; atMs: number };
}

export interface TimerFailure {
  name: TimerName;
  error: unknown;
  /** The due time it was rescheduled to. */
  retryAtMs: number;
  /** Consecutive failures including this one. */
  streak: number;
}

export interface RunReport {
  /** Handlers that resolved, in the order they ran. */
  ran: TimerName[];
  /** Handlers that threw or rejected, in the order they ran. */
  failed: TimerFailure[];
  /** Due timers left for the next alarm because the budget ran out. */
  deferred: TimerName[];
  /**
   * Claimed rows left by an instance that died mid-handler, or by a hung run
   * on this instance that this call took over, now rescheduled.
   */
  recovered: TimerFailure[];
  /** True when a later call took over this run while a handler was hung. */
  superseded: boolean;
}

/** Age (by `now`) after which an in-flight run is hung and may be taken over. */
export const TIMER_RUN_TIMEOUT_MS = 15 * 60_000;
export const TIMER_BACKOFF_BASE_MS = 2_000;
export const TIMER_BACKOFF_CAP_MS = 300_000;
export const TIMER_FAILURES_COUNTER = 'timer_failures';
export const TIMER_STREAK_COUNTER = 'timer_failure_streak';

const RUNNING_PREFIX = '~running:';
const PRIORITY = new Map<string, number>(TIMER_NAMES.map((name, i) => [name, i]));
const RUNNING_NAMES = TIMER_NAMES.map((name) => RUNNING_PREFIX + name);
const KNOWN_PLACEHOLDERS = [...TIMER_NAMES, ...RUNNING_NAMES].map(() => '?').join(',');

interface ActiveRun {
  /** From this `now` on, a later runDue may take the run over. */
  takeoverAtMs: number;
}

/**
 * The run in progress, per DO storage object (never per Db wrapper), so a
 * re-entrant runDue through any wrapper over that storage cannot steal claimed
 * rows.
 */
const active = new WeakMap<object, ActiveRun>();

export type AlarmStorage = Pick<DurableObjectStorage, 'setAlarm' | 'deleteAlarm'>;

export class TimerReentryError extends Error {
  constructor() {
    super('runDue is already running on this Durable Object storage');
    this.name = 'TimerReentryError';
  }
}

export function isTimerName(value: unknown): value is TimerName {
  return typeof value === 'string' && PRIORITY.has(value);
}

function assertTimerName(name: unknown): asserts name is TimerName {
  if (!isTimerName(name)) throw new TypeError(`unknown timer name: ${String(name)}`);
}

function assertEpochMs(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer of epoch ms, got ${value}`);
  }
}

/** Backoff after `streak` consecutive failures: 2 s, 4 s, 8 s, ... capped at 5 min. */
export function timerBackoffMs(streak: number): number {
  const exponent = Math.min(Math.max(streak, 1) - 1, 30);
  return Math.min(TIMER_BACKOFF_CAP_MS, TIMER_BACKOFF_BASE_MS * 2 ** exponent);
}

/**
 * Upserts timer `name` at `dueAtMs`. An existing earlier due time is kept
 * unless `force`. Returns the stored due time.
 */
export function schedule(db: Db, name: TimerName, dueAtMs: number, options: ScheduleOptions = {}): number {
  assertTimerName(name);
  assertEpochMs('dueAtMs', dueAtMs);
  const update = options.force ? 'excluded.due_at' : 'MIN(timers.due_at, excluded.due_at)';
  const row = db.one<{ due_at: number }>(
    `INSERT INTO timers(name, due_at) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET due_at = ${update}
     RETURNING due_at`,
    name,
    dueAtMs,
  );
  return row!.due_at;
}

/** Removes timer `name`. Returns whether it was scheduled. */
export function cancel(db: Db, name: TimerName): boolean {
  assertTimerName(name);
  return db.all('DELETE FROM timers WHERE name = ? RETURNING name', name).length > 0;
}

/** The stored due time of `name`, or null when it is not scheduled. */
export function dueAt(db: Db, name: TimerName): number | null {
  assertTimerName(name);
  return db.one<{ due_at: number }>('SELECT due_at FROM timers WHERE name = ?', name)?.due_at ?? null;
}

/**
 * `min(due_at)` over the known timers, including a claimed row (`~running:`)
 * an earlier instance left behind (it still needs a run to be recovered). Rows
 * with other names are ignored. Null when nothing is scheduled.
 */
export function nextDue(db: Db): number | null {
  const row = db.one<{ next: number | null }>(
    `SELECT MIN(due_at) AS next FROM timers WHERE name IN (${KNOWN_PLACEHOLDERS})`,
    ...TIMER_NAMES,
    ...RUNNING_NAMES,
  );
  return row?.next ?? null;
}

/**
 * Arms the DO alarm at `nextDue(db)`, or deletes it when nothing is due.
 * While a `runDue` on this storage is in flight, the alarm is armed no earlier
 * than that run's takeover time, since no `runDue` can start before it.
 * Returns the armed time. The storage write is queued synchronously; the DO
 * output gate holds outgoing messages until it is durable.
 */
export function armAlarm(storage: AlarmStorage, db: Db): number | null {
  const min = nextDue(db);
  const run = active.get(storage);
  const next = min === null || run === undefined ? min : Math.max(min, run.takeoverAtMs);
  if (next === null) void storage.deleteAlarm();
  else void storage.setAlarm(next);
  return next;
}

function bumpCounter(db: Db, counter: string, name: TimerName): number {
  const row = db.one<{ value: number }>(
    `INSERT INTO counters(name, label, value) VALUES (?, ?, 1)
     ON CONFLICT(name, label) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    counter,
    name,
  );
  return row!.value;
}

function streakOf(db: Db, name: TimerName): number {
  return (
    db.one<{ value: number }>('SELECT value FROM counters WHERE name = ? AND label = ?', TIMER_STREAK_COUNTER, name)
      ?.value ?? 0
  );
}

/** Moves a due row to its claimed name and bumps its streak. False when it is no longer due. */
function claim(db: Db, name: TimerName, now: number): boolean {
  return db.tx(() => {
    const claimed = db.all(
      'UPDATE timers SET name = ? WHERE name = ? AND due_at <= ? RETURNING due_at',
      RUNNING_PREFIX + name,
      name,
      now,
    );
    if (claimed.length === 0) return false;
    bumpCounter(db, TIMER_STREAK_COUNTER, name);
    return true;
  });
}

function succeed(db: Db, name: TimerName): void {
  db.tx(() => {
    db.run('DELETE FROM timers WHERE name = ?', RUNNING_PREFIX + name);
    db.run('DELETE FROM counters WHERE name = ? AND label = ?', TIMER_STREAK_COUNTER, name);
  });
}

/** Drops the claimed row and force-reschedules with backoff from the current streak. */
function fail(db: Db, name: TimerName, now: number, error: unknown): TimerFailure {
  return db.tx(() => {
    db.run('DELETE FROM timers WHERE name = ?', RUNNING_PREFIX + name);
    const streak = Math.max(streakOf(db, name), 1);
    const retryAtMs = schedule(db, name, now + timerBackoffMs(streak), { force: true });
    bumpCounter(db, TIMER_FAILURES_COUNTER, name);
    return { name, error, retryAtMs, streak };
  });
}

function recoverOrphans(db: Db, now: number, reason: string): TimerFailure[] {
  const orphans = db.all<{ name: string }>(
    `SELECT name FROM timers WHERE name IN (${RUNNING_NAMES.map(() => '?').join(',')})`,
    ...RUNNING_NAMES,
  );
  return orphans
    .map((row) => row.name.slice(RUNNING_PREFIX.length) as TimerName)
    .sort((a, b) => PRIORITY.get(a)! - PRIORITY.get(b)!)
    .map((name) => fail(db, name, now, new Error(reason)));
}

/**
 * Runs every timer with `due_at <= now` once, in priority order, until the
 * budget runs out. The caller re-arms the alarm afterwards (`armAlarm`).
 *
 * `storage` is the DO storage that `db` wraps (pass the same object to
 * `armAlarm`); it is used only as the identity of the run guard, so every Db
 * wrapper over one storage shares it. Throws TimerReentryError while another
 * run on this storage is in flight and younger than TIMER_RUN_TIMEOUT_MS;
 * takes an older one over.
 */
export async function runDue(
  storage: AlarmStorage,
  db: Db,
  now: number,
  handlers: TimerHandlers,
  budget: RunBudget,
): Promise<RunReport> {
  assertEpochMs('now', now);
  if (!Number.isSafeInteger(budget.maxRuns) || budget.maxRuns < 0) {
    throw new RangeError(`budget.maxRuns must be a non-negative safe integer, got ${budget.maxRuns}`);
  }
  const previous = active.get(storage);
  if (previous !== undefined && now < previous.takeoverAtMs) throw new TimerReentryError();
  const run: ActiveRun = { takeoverAtMs: now + TIMER_RUN_TIMEOUT_MS };
  active.set(storage, run);
  try {
    const recovered = recoverOrphans(
      db,
      now,
      previous === undefined
        ? 'timer handler did not complete (instance lost mid-run)'
        : `timer handler did not complete within ${TIMER_RUN_TIMEOUT_MS} ms (hung run taken over)`,
    );
    const due = db
      .all<{ name: string }>('SELECT name FROM timers WHERE due_at <= ?', now)
      .map((row) => row.name)
      .filter(isTimerName)
      .sort((a, b) => PRIORITY.get(a)! - PRIORITY.get(b)!);

    const report: RunReport = { ran: [], failed: [], deferred: [], recovered, superseded: false };
    let started = 0;
    for (const name of due) {
      const outOfTime = budget.deadline !== undefined && budget.deadline.clock.nowMs() >= budget.deadline.atMs;
      if (started >= budget.maxRuns || outOfTime) {
        const stillDue = dueAt(db, name);
        if (stillDue !== null && stillDue <= now) report.deferred.push(name);
        continue;
      }
      // An earlier handler may have cancelled or postponed this one.
      if (!claim(db, name, now)) continue;
      started++;
      let failure: { error: unknown } | null = null;
      try {
        await handlers[name](now);
      } catch (error) {
        failure = { error };
      }
      // Taken over while hung: the claim was already rescheduled (and may
      // have been claimed again by the newer run), so touch nothing.
      if (active.get(storage) !== run) {
        report.superseded = true;
        return report;
      }
      if (failure !== null) {
        report.failed.push(fail(db, name, now, failure.error));
        continue;
      }
      succeed(db, name);
      report.ran.push(name);
    }
    return report;
  } finally {
    if (active.get(storage) === run) active.delete(storage);
  }
}
