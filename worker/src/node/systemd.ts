// systemd service notifications (ADR 0005 §3.10, §14.1; N3-07).
//
// The unit is `Type=notify` with `NotifyAccess=all` and `WatchdogSec=60s`
// (§14.1). The process tells the service manager:
//
// - `EXTEND_TIMEOUT_USEC=60000000` while the startup pre-migration backup and
//   migration run, sent at once and then every 20 s (`keepExtending`), so a
//   long upgrade is never killed by `TimeoutStartSec` and restarted in a loop;
// - `READY=1` once the listener is bound (run.ts sends it after `listen`);
// - `WATCHDOG=1` every `WatchdogSec/3` (`startWatchdog`), but only while the
//   event-loop-lag probe (the tick arrived less than 5 s late) and the
//   database probe (`SELECT 1`) both pass: a wedged loop or a dead connection
//   stops the pings and systemd restarts the service;
// - `STOPPING=1` first thing on SIGTERM (shutdown.ts).
//
// Node cannot send a datagram to a unix socket itself, so every message goes
// through an injected `NotifySpawner`. The production spawner runs the
// `systemd-notify` binary (found once on PATH, then spawned by absolute path)
// with the states as arguments, and an environment that holds NOTIFY_SOCKET
// and nothing else: secrets never live in process.env (ADR §3.8), and the
// child gets none of the service's variables either. `systemd-notify` waits
// for the manager to process the message (its default barrier), so a READY=1
// is never attributed to an already exited child. Messages are sent one at a
// time, in call order.
//
// Without NOTIFY_SOCKET (a manual start, the tests by default) every
// notification is a no-op. A failing spawn is logged and never thrown: losing
// a notification must not take the service down (a missing WATCHDOG=1 is what
// the watchdog itself is for).
//
// Timers and the monotonic clock are injected, so the tests step the watchdog
// and the extension keeper instead of waiting 20 s.

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { errorName } from '../app/index-core';
import type { Logger } from '../do/contracts';
import { type HostTimers, nodeTimers, type Stoppable, type TimerHandle } from './alarm';

/** The value of EXTEND_TIMEOUT_USEC: one minute more each time (ADR §3.10). */
export const EXTEND_TIMEOUT_USEC = 60_000_000;
/** How often EXTEND_TIMEOUT_USEC is repeated while startup work runs. */
export const EXTEND_INTERVAL_MS = 20_000;
/** A watchdog tick later than this is a stalled event loop: no WATCHDOG=1 for it. */
export const WATCHDOG_MAX_LAG_MS = 5_000;

export const READY = 'READY=1';
export const STOPPING = 'STOPPING=1';
export const WATCHDOG = 'WATCHDOG=1';

/** Sends `states` (`KEY=value` strings) to the socket in `env.NOTIFY_SOCKET`; resolves once delivered. */
export type NotifySpawner = (states: readonly string[], env: { NOTIFY_SOCKET: string }) => Promise<void>;

export class SystemdNotifyError extends Error {
  override readonly name = 'SystemdNotifyError';
}

/** The first executable `systemd-notify` on `path` (a PATH value), or null. */
export function findSystemdNotify(path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'systemd-notify');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** The production spawner: `<binary> <states...>` with only NOTIFY_SOCKET in its environment. */
export function systemdNotifySpawner(binary: string): NotifySpawner {
  if (!isAbsolute(binary)) throw new TypeError('systemd-notify must be given as an absolute path');
  return (states, env) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(binary, [...states], {
        env: { NOTIFY_SOCKET: env.NOTIFY_SOCKET },
        stdio: 'ignore',
        shell: false,
      });
      child.once('error', (error) => reject(new SystemdNotifyError(`systemd-notify failed: ${errorName(error)}`)));
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new SystemdNotifyError(`systemd-notify exited with ${signal ?? code}`));
      });
    });
}

export interface NotifierOptions {
  /** The process environment: NOTIFY_SOCKET and PATH are read. */
  env: Readonly<Record<string, string | undefined>>;
  /** Default: systemdNotifySpawner over the systemd-notify found on env.PATH. */
  spawn?: NotifySpawner;
  log: Logger;
}

export interface Notifier {
  /** True when NOTIFY_SOCKET is set and a spawner is available. */
  readonly enabled: boolean;
  /** Sends the states in order after every earlier message; never rejects. */
  notify(...states: string[]): Promise<void>;
  ready(): Promise<void>;
  stopping(): Promise<void>;
  watchdog(): Promise<void>;
  extendTimeout(usec?: number): Promise<void>;
  /** Settles once every message sent so far was handled. */
  flush(): Promise<void>;
}

export function createNotifier(options: NotifierOptions): Notifier {
  const socket = options.env.NOTIFY_SOCKET;
  const log = options.log;
  let spawner: NotifySpawner | null = null;
  if (socket !== undefined && socket !== '') {
    if (options.spawn !== undefined) {
      spawner = options.spawn;
    } else {
      const binary = findSystemdNotify(options.env.PATH);
      if (binary === null) log.log('error', 'systemd.notify_unavailable', { reason: 'systemd-notify not on PATH' });
      else spawner = systemdNotifySpawner(binary);
    }
  }
  let chain: Promise<void> = Promise.resolve();
  const notify = (...states: string[]): Promise<void> => {
    if (spawner === null || socket === undefined) return chain;
    const send = spawner;
    chain = chain.then(async () => {
      try {
        await send(states, { NOTIFY_SOCKET: socket });
      } catch (error) {
        log.log('warn', 'systemd.notify_failed', {
          states: states.map((s) => s.split('=')[0]),
          error: errorName(error),
        });
      }
    });
    return chain;
  };
  return {
    enabled: spawner !== null,
    notify,
    ready: () => notify(READY),
    stopping: () => notify(STOPPING),
    watchdog: () => notify(WATCHDOG),
    extendTimeout: (usec = EXTEND_TIMEOUT_USEC) => notify(`EXTEND_TIMEOUT_USEC=${usec}`),
    flush: () => chain,
  };
}

/**
 * The watchdog ping period in ms: `WatchdogSec/3` from WATCHDOG_USEC, or null
 * when the manager asked for no watchdog (unset, 0, or WATCHDOG_PID naming
 * another process).
 */
export function watchdogIntervalMs(env: Readonly<Record<string, string | undefined>>, pid: number): number | null {
  const usecText = env.WATCHDOG_USEC;
  if (usecText === undefined || !/^[1-9][0-9]*$/.test(usecText)) return null;
  const pidText = env.WATCHDOG_PID;
  if (pidText !== undefined && pidText !== '' && pidText !== String(pid)) return null;
  const usec = Number(usecText);
  if (!Number.isSafeInteger(usec)) return null;
  return Math.max(1, Math.floor(usec / 3 / 1000));
}

export interface KeepExtendingOptions {
  timers?: HostTimers;
  intervalMs?: number;
  usec?: number;
}

/** EXTEND_TIMEOUT_USEC now and every `intervalMs` until `stop()`. */
export function keepExtending(notifier: Notifier, options: KeepExtendingOptions = {}): Stoppable {
  const timers = options.timers ?? nodeTimers;
  const usec = options.usec ?? EXTEND_TIMEOUT_USEC;
  void notifier.extendTimeout(usec);
  const handle: TimerHandle = timers.setInterval(() => {
    void notifier.extendTimeout(usec);
  }, options.intervalMs ?? EXTEND_INTERVAL_MS);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(handle);
    },
  };
}

export interface WatchdogOptions {
  notifier: Notifier;
  intervalMs: number;
  /** True while the database answers (SELECT 1). */
  dbProbe: () => boolean;
  timers?: HostTimers;
  /** Monotonic milliseconds; default performance.now. */
  now?: () => number;
  maxLagMs?: number;
  log: Logger;
}

export interface WatchdogReport {
  sent: number;
  skipped: number;
}

/** WATCHDOG=1 every `intervalMs`, only while both probes pass (module comment). */
export function startWatchdog(options: WatchdogOptions): Stoppable & { report(): WatchdogReport } {
  const timers = options.timers ?? nodeTimers;
  const now = options.now ?? (() => performance.now());
  const maxLag = options.maxLagMs ?? WATCHDOG_MAX_LAG_MS;
  const report: WatchdogReport = { sent: 0, skipped: 0 };
  let last = now();
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    const at = now();
    const lag = at - last - options.intervalMs;
    last = at;
    let dbOk = false;
    try {
      dbOk = options.dbProbe();
    } catch {
      dbOk = false;
    }
    if (lag >= maxLag || !dbOk) {
      report.skipped += 1;
      options.log.log('warn', 'systemd.watchdog_skipped', { lagMs: Math.round(lag), db: dbOk });
      return;
    }
    report.sent += 1;
    void options.notifier.watchdog();
  };
  const handle = timers.setInterval(tick, options.intervalMs);
  handle.unref?.();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(handle);
    },
    report: () => ({ ...report }),
  };
}
