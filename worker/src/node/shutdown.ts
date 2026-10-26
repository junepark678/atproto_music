// The SIGTERM drain (ADR 0005 §3.10; N3-07). It restores the M1.4.3 drain
// that ADR 0004 §9.3 dropped.
//
// `createShutdown(deps).shutdown()` runs, once, in this order:
//  1. `STOPPING=1` to the service manager (systemd.ts);
//  2. stop accepting connections (the listening socket closes; idle
//     keep-alive connections are closed);
//  3. let in-flight requests finish, up to the drain window (`drainMs`;
//     production PRODUCTION_DRAIN_MS = 25 s, below the unit's
//     TimeoutStopSec=30s; tests inject about 200 ms). A request still running
//     when the window ends is aborted: its handler's AbortSignal fires and its
//     connection is closed;
//  4. close the Jetstream link with code 1000;
//  5. stop every timer and let the current timer slice (and a backup in
//     progress) end; slices are bounded;
//  6. close the admin socket, the watchdog and the database;
//  7. `exit(0)`.
//
// A step that fails is logged and the remaining steps still run; the exit
// status after SIGTERM is 0 (ADR §3.10). In-flight requests are counted at
// the node:http level (`trackRequests`), from the request event to the
// response's close, so a response body still streaming counts as in flight.

import type * as http from 'node:http';
import { errorName } from '../app/index-core';
import type { Logger } from '../do/contracts';
import { type HostTimers, nodeTimers } from './alarm';
import { PRODUCTION_DRAIN_MS } from './config';
import type { BridgeServer } from './http-bridge';
import type { Notifier } from './systemd';

/** The production drain window (ADR §3.10): 25 s. */
export const DEFAULT_DRAIN_MS = PRODUCTION_DRAIN_MS;
/** How long the final notifications may take before exit. */
export const NOTIFY_FLUSH_MS = 2_000;

export interface RequestTracker {
  /** Requests received whose response has not closed yet. */
  active(): number;
  /** Resolves once no request is in flight. */
  idle(): Promise<void>;
}

/** Counts in-flight requests of `server` from now on. */
export function trackRequests(server: http.Server): RequestTracker {
  let active = 0;
  let waiters: Array<() => void> = [];
  const settle = () => {
    if (active !== 0) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  };
  server.on('request', (_req: http.IncomingMessage, res: http.ServerResponse) => {
    active += 1;
    res.once('close', () => {
      active -= 1;
      settle();
    });
  });
  return {
    active: () => active,
    idle: () =>
      active === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push(resolve);
          }),
  };
}

export interface ShutdownDeps {
  /** The TCP listener (node/http-bridge.ts). */
  server: BridgeServer;
  tracker: RequestTracker;
  notifier: Pick<Notifier, 'stopping' | 'flush'>;
  /** Default DEFAULT_DRAIN_MS. */
  drainMs?: number;
  timers?: HostTimers;
  log: Logger;
  exit: (code: 0) => void;
  /** Step 4: closes the Jetstream link with 1000 (no-op without one). */
  closeJetstream(): void;
  /** Step 5: stops the timers and waits for the running slice. */
  stopTimers(): Promise<void>;
  /** Step 6, before the database: admin socket, watchdog, journal. */
  closeServices(): Promise<void>;
  /** Step 6: closes the database. */
  closeDb(): void;
}

export interface Shutdown {
  /** Runs the drain once; later calls return the same promise. */
  shutdown(signal?: string): Promise<void>;
  readonly started: boolean;
}

export function createShutdown(deps: ShutdownDeps): Shutdown {
  const timers = deps.timers ?? nodeTimers;
  const drainMs = deps.drainMs ?? DEFAULT_DRAIN_MS;
  if (!Number.isSafeInteger(drainMs) || drainMs < 0) throw new RangeError('drainMs must be a non-negative integer');
  const log = deps.log;
  let running: Promise<void> | null = null;

  const step = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      log.log('error', 'shutdown.step_failed', { step: name, error: errorName(error) });
    }
  };

  const run = async (signal: string): Promise<void> => {
    log.log('info', 'shutdown.started', { signal, drainMs, inFlight: deps.tracker.active() });
    // 1.
    void deps.notifier.stopping();
    // 2. No new connections; idle keep-alive connections go now.
    await step('stop_listening', () => {
      const server = deps.server.server;
      if (server.listening) server.close();
      server.closeIdleConnections();
    });
    // 3. The drain window.
    let timer: ReturnType<HostTimers['setTimeout']> | null = null;
    const expired = new Promise<'expired'>((resolve) => {
      timer = timers.setTimeout(() => resolve('expired'), drainMs);
    });
    const outcome = await Promise.race([deps.tracker.idle().then(() => 'drained' as const), expired]);
    if (timer !== null) timers.clearTimeout(timer);
    if (outcome === 'expired') {
      log.log('warn', 'shutdown.drain_expired', { inFlight: deps.tracker.active(), drainMs });
    }
    // Aborts whatever is still running and closes every connection.
    await step('close_server', () => deps.server.close());
    // 4–6.
    await step('close_jetstream', () => deps.closeJetstream());
    await step('stop_timers', () => deps.stopTimers());
    await step('close_services', () => deps.closeServices());
    await step('close_db', () => deps.closeDb());
    // The STOPPING=1 message, bounded.
    let flushTimer: ReturnType<HostTimers['setTimeout']> | null = null;
    await Promise.race([
      deps.notifier.flush(),
      new Promise<void>((resolve) => {
        flushTimer = timers.setTimeout(resolve, NOTIFY_FLUSH_MS);
      }),
    ]);
    if (flushTimer !== null) timers.clearTimeout(flushTimer);
    log.log('info', 'shutdown.completed', { signal, drained: outcome === 'drained' });
    // 7.
    deps.exit(0);
  };

  return {
    shutdown(signal = 'SIGTERM') {
      running ??= run(signal);
      return running;
    },
    get started() {
      return running !== null;
    },
  };
}
