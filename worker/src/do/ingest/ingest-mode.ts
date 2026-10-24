// Ingest modes (ADR 0004 §5.5, §5.9): what the `jetstream-watchdog` timer does.
//
// - `socket` (Paid default): the long-lived socket of jetstream-socket.ts; the
//   watchdog runs every 60 s.
// - `pulse` (Free default): each run connects from the cursor (gap detection
//   as in socket mode), drains until an event whose time is at least the
//   connect time arrives (the live tail) or PULSE_DRAIN_MAX_MS (20 s) pass,
//   then closes. The watchdog runs every PULSE_INTERVAL_MS (5 min); cron
//   (W5-01 scheduled.ts) may start one too, and a pulse already in progress is
//   joined, never doubled. A pulse that drains its full 20 s without any
//   event, from a recent cursor, moves the resume point to its connect
//   instant minus 60 s (jetstream-socket.ts "Quiet links", ADR §15 Q11), so a
//   quiet stream never ages into a gap. A pulse whose connect fails writes no connection
//   evidence (the last successful pulse start stays the stale reference) and
//   rotates the host.
// - `off`: no socket. An open one is closed (marked disconnected); nothing
//   connects and the watchdog is not rescheduled.
//
// The 20 s bound is measured by an injected PulseTimer, so tests step it
// without sleeping; production uses setTimeout.

import type { IngestMode } from '../../config';
import type { ModuleDeps } from '../contracts';
import type { Db } from '../db';
import { PULSE_INTERVAL_MS } from '../status';
import { schedule } from '../timers';
import { noteMode } from './checkpoint';
import {
  type ConnectJetstream,
  type ConnectResult,
  closeSocket,
  connect,
  type SocketOptions,
  socketStatus,
  socketWatchdog,
  type WatchdogReport,
} from './jetstream-socket';

export const PULSE_DRAIN_MAX_MS = 20_000;

export interface PulseTimer {
  after(ms: number): { done: Promise<void>; cancel(): void };
}

export const realPulseTimer: PulseTimer = {
  after(ms) {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });
    return {
      done,
      cancel: () => {
        if (handle !== undefined) clearTimeout(handle);
      },
    };
  },
};

export interface IngestDeps extends Pick<SocketOptions, 'scheduleGapRecovery' | 'onTimersChanged'> {
  connectJetstream: ConnectJetstream;
  pulseTimer?: PulseTimer;
}

export type PulseEnd = 'tail' | 'timeout' | 'closed';

export interface PulseReport {
  /** False when a pulse was already in progress (this call joined it). */
  started: boolean;
  connect: ConnectResult;
  endedBy: PulseEnd | null;
  /** Messages received on the pulse's link. */
  messages: number;
}

const pulses = new WeakMap<Db, Promise<PulseReport>>();

/** One pulse: connect, drain to the live tail or 20 s, close. */
export function pulse(m: ModuleDeps, d: IngestDeps, now: number): Promise<PulseReport> {
  const running = pulses.get(m.db);
  if (running !== undefined) return running.then((r) => ({ ...r, started: false }));
  const run = runPulse(m, d, now).finally(() => pulses.delete(m.db));
  pulses.set(m.db, run);
  return run;
}

async function runPulse(m: ModuleDeps, d: IngestDeps, now: number): Promise<PulseReport> {
  // The next pulse is durable before this one does any I/O.
  schedule(m.db, 'jetstream-watchdog', now + PULSE_INTERVAL_MS, { force: true });

  let endedBy: PulseEnd | null = null;
  let messages = 0;
  let resolveEnd: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  const finish = (reason: PulseEnd) => {
    if (endedBy !== null) return;
    endedBy = reason;
    // A full drain without a single event may confirm the quiet link healthy (ADR §15 Q11).
    if (reason !== 'closed') closeSocket(m, m.clock.nowMs(), { pulseDrained: reason === 'timeout' });
    resolveEnd();
  };

  const result = await connect(m, d.connectJetstream, now, {
    mode: 'pulse',
    ...(d.scheduleGapRecovery === undefined ? {} : { scheduleGapRecovery: d.scheduleGapRecovery }),
    ...(d.onTimersChanged === undefined ? {} : { onTimersChanged: d.onTimersChanged }),
    onOutcome(o) {
      messages += 1;
      const open = socketStatus(m).open;
      if (open === null) return;
      if ((o.kind === 'hint' || o.kind === 'ignored') && o.timeUs >= open.openedAtMs * 1000) finish('tail');
    },
    onEnd() {
      // Our own close (tail or timeout) already finished; anything else is the server's.
      finish('closed');
    },
  });
  if (!result.ok) return { started: true, connect: result, endedBy: null, messages: 0 };

  const timer = (d.pulseTimer ?? realPulseTimer).after(PULSE_DRAIN_MAX_MS);
  try {
    await Promise.race([ended, timer.done.then(() => finish('timeout'))]);
  } finally {
    timer.cancel();
  }
  return { started: true, connect: result, endedBy, messages };
}

export type IngestReport =
  | { mode: 'off'; closed: boolean }
  | { mode: 'socket'; watchdog: WatchdogReport }
  | { mode: 'pulse'; pulse: PulseReport };

/** The `jetstream-watchdog` timer handler: dispatches on the effective ingest mode. */
export async function jetstreamWatchdog(
  m: ModuleDeps,
  d: IngestDeps,
  now: number,
  mode: IngestMode = m.config.ingestMode,
): Promise<IngestReport> {
  if (mode === 'off') {
    const closed = closeSocket(m, now);
    noteMode(m.db, 'off');
    return { mode: 'off', closed };
  }
  if (mode === 'pulse') return { mode: 'pulse', pulse: await pulse(m, d, now) };
  return {
    mode: 'socket',
    watchdog: await socketWatchdog(m, d.connectJetstream, now, {
      ...(d.scheduleGapRecovery === undefined ? {} : { scheduleGapRecovery: d.scheduleGapRecovery }),
      ...(d.onTimersChanged === undefined ? {} : { onTimersChanged: d.onTimersChanged }),
    }),
  };
}
