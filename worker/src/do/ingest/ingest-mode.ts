// Ingest modes (ADR 0004 §5.5, §5.9; ADR 0005 §3.8): what the
// `jetstream-watchdog` timer does.
//
// - `socket` (the default): the long-lived socket of jetstream-socket.ts; the
//   watchdog runs every 60 s.
// - `off`: no socket. An open one is closed (marked disconnected); nothing
//   connects and the watchdog is not rescheduled.
//
// The Workers-era `pulse` mode (a 5 min cron-driven drain bounded to 20 s) was
// retired on the Node host by N7-01 (B17); INGEST_MODE no longer accepts it and
// no checkpoint row with that mode can be written.

import type { IngestMode } from '../../config';
import type { ModuleDeps } from '../contracts';
import { noteMode } from './checkpoint';
import {
  type ConnectJetstream,
  closeSocket,
  type SocketOptions,
  socketWatchdog,
  type WatchdogReport,
} from './jetstream-socket';

export interface IngestDeps extends Pick<SocketOptions, 'scheduleGapRecovery' | 'onTimersChanged'> {
  connectJetstream: ConnectJetstream;
}

export type IngestReport = { mode: 'off'; closed: boolean } | { mode: 'socket'; watchdog: WatchdogReport };

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
  return {
    mode: 'socket',
    watchdog: await socketWatchdog(m, d.connectJetstream, now, {
      ...(d.scheduleGapRecovery === undefined ? {} : { scheduleGapRecovery: d.scheduleGapRecovery }),
      ...(d.onTimersChanged === undefined ? {} : { onTimersChanged: d.onTimersChanged }),
    }),
  };
}
