// The Jetstream ingest checkpoint as the socket and pulse modules see it
// (ADR 0004 §5.4, §5.5, §6.1 `ingest_checkpoint`). Synchronous.
//
// This module reads `ingest_checkpoint` and writes it only through the W2-05
// writers in worker/src/do/status.ts, never with its own SQL (the source guard
// in worker/test/storage/status.test.ts fails otherwise). The status truth
// depends on that: the 5-minute socket stale rule reads `updated_at_ms` as the
// disconnect instant, and lagSeconds reads `last_event_time_us` as the newest
// event of the most recent connection.
//
// - A successful connect (socket or pulse) → `noteConnected` → `markConnected`,
//   plus the mode, the host index and, when the connect found a gap, the gap
//   entry, in one transaction.
// - Each message → `recordEvent`, in onMessage's transaction through
//   `enqueueHints` (worker/src/do/ingest/hints.ts), never here.
// - Close, error, pulse end and an instance restart → `noteDisconnected` /
//   `noteRestart` → `markDisconnected` (written on the 1→0 transition only).
// - Host rotation and mode → `updateCheckpointBookkeeping`.
// - A failed connect writes no connection or event evidence: neither
//   `connected`, `connected_at_ms`, `updated_at_ms`, `cursor` nor
//   `last_event_time_us` (it may rotate `host_index`, which is bookkeeping).
//
// Gap detection on (re)connect (ADR §5.5): no cursor (first start), a cursor
// older than JETSTREAM_LOOKBACK_HOURS (its event time, or an upper bound of it
// after a quiet connection; see `cursorTimeUs`), or a cursor Jetstream
// rejects. A gap sets `pending_gap=1`, moves the stored resume point to the
// live tail (so the same gap is not re-detected on every reconnect) and calls
// the gap-recovery scheduler, then the stream resumes from the live tail. The scheduler is W4-01's `scheduleGapRecovery`
// (worker/src/do/ingest/snapshot-job.ts). W4-01 is not merged into this
// package's base, so it is injected through the `ScheduleGapRecovery`
// interface below, and W5-01 wires the real one into IndexDO. Without it only
// `pending_gap=1` is written, which keeps `indexing()` recovering (never a
// false `current`).

import type { IngestMode } from '../../config';
import type { Db } from '../db';
import { JETSTREAM_STREAM, markConnected, markDisconnected, updateCheckpointBookkeeping } from '../status';

/** Jetstream cursors at or above this are unix microseconds; below it, sequence numbers. */
export const TIME_CURSOR_MIN = 1_000_000_000_000_000;

export type GapReason = 'no_cursor' | 'cursor_too_old' | 'cursor_rejected';

/**
 * Gap recovery (W4-01 `scheduleGapRecovery`): schedules bounded snapshot
 * batches over the known active DIDs and a discovery pass. Synchronous; it
 * runs inside the connect transaction, after `pending_gap=1` is written.
 */
export type ScheduleGapRecovery = (db: Db, nowMs: number) => void;

export interface IngestCheckpoint {
  /** The resume point (Jetstream inclusive cursor), never cleared. */
  cursor: number | null;
  /** Newest event of the most recent connection; null until its first event. */
  lastEventTimeUs: number | null;
  connected: boolean;
  pendingGap: boolean;
  gapScanAfterDid: string | null;
  mode: IngestMode | null;
  hostIndex: number;
  connectedAtMs: number | null;
  /** The disconnect instant while `connected` is false (0: never written). */
  updatedAtMs: number;
}

interface Row {
  cursor: number | null;
  last_event_time_us: number | null;
  connected: number;
  pending_gap: number;
  gap_scan_after_did: string | null;
  mode: IngestMode | null;
  host_index: number;
  connected_at_ms: number | null;
  updated_at_ms: number;
}

/** The checkpoint as migration 1 seeds it, for a missing row. */
const FRESH: IngestCheckpoint = {
  cursor: null,
  lastEventTimeUs: null,
  connected: false,
  pendingGap: true,
  gapScanAfterDid: null,
  mode: null,
  hostIndex: 0,
  connectedAtMs: null,
  updatedAtMs: 0,
};

export function readIngestCheckpoint(db: Db): IngestCheckpoint {
  const row = db.one<Row>(
    `SELECT cursor, last_event_time_us, connected, pending_gap, gap_scan_after_did, mode, host_index,
            connected_at_ms, updated_at_ms
     FROM ingest_checkpoint WHERE stream = ?`,
    JETSTREAM_STREAM,
  );
  if (row === null) return { ...FRESH };
  return {
    cursor: row.cursor,
    lastEventTimeUs: row.last_event_time_us,
    connected: row.connected === 1,
    pendingGap: row.pending_gap === 1,
    gapScanAfterDid: row.gap_scan_after_did,
    mode: row.mode,
    hostIndex: row.host_index,
    connectedAtMs: row.connected_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/**
 * The event time of the stored cursor in unix microseconds, or an upper bound
 * of it, or null when neither is known.
 * - A time cursor (production Jetstream: `seq` is `time_us`; also the tail
 *   cursor a gap connect stores) is its own time.
 * - A sequence cursor's time is `last_event_time_us` while the most recent
 *   connection is the one whose event wrote it.
 * - Once a later connection opened without receiving an event
 *   (`markConnected` cleared `last_event_time_us`), the cursor's event came
 *   from an earlier connection, so it predates the most recent connect:
 *   `connected_at_ms` (or, if that was never written, the disconnect instant
 *   `updated_at_ms`) bounds it from above. The bound never reports a gap that
 *   is not there, and keeps the age check working after quiet connections
 *   instead of leaving it to Jetstream to refuse the cursor.
 */
export function cursorTimeUs(
  cp: Pick<IngestCheckpoint, 'cursor' | 'lastEventTimeUs'> &
    Partial<Pick<IngestCheckpoint, 'connectedAtMs' | 'updatedAtMs'>>,
): number | null {
  if (cp.cursor === null) return null;
  if (cp.cursor >= TIME_CURSOR_MIN) return cp.cursor;
  if (cp.lastEventTimeUs !== null) return cp.lastEventTimeUs;
  if (cp.connectedAtMs !== undefined && cp.connectedAtMs !== null) return cp.connectedAtMs * 1000;
  if (cp.updatedAtMs !== undefined && cp.updatedAtMs > 0) return cp.updatedAtMs * 1000;
  return null;
}

/** Whether connecting from the stored checkpoint at `nowMs` would leave a gap, and why. */
export function gapOnConnect(
  cp: Pick<IngestCheckpoint, 'cursor' | 'lastEventTimeUs'> &
    Partial<Pick<IngestCheckpoint, 'connectedAtMs' | 'updatedAtMs'>>,
  nowMs: number,
  lookbackHours: number,
): GapReason | null {
  if (cp.cursor === null) return 'no_cursor';
  const at = cursorTimeUs(cp);
  if (at !== null && at < (nowMs - lookbackHours * 3_600_000) * 1000) return 'cursor_too_old';
  return null;
}

/**
 * The resume point a gap connect stores: the live tail as a `time_us` cursor
 * at the instant the tail subscription was requested (`attemptMs`, taken
 * before the upgrade). Every event the tail can deliver is at or after it, and
 * everything before it belongs to the gap recovery scheduled in the same
 * transaction. At or above TIME_CURSOR_MIN for any instant after 2001-09-09.
 */
export function tailCursor(attemptMs: number): number {
  return Math.max(Math.floor(attemptMs) * 1000, TIME_CURSOR_MIN);
}

export interface ConnectedNote {
  mode: Exclude<IngestMode, 'off'>;
  hostIndex: number;
  gap: GapReason | null;
  /** When the connect attempt began (before the upgrade); the tail cursor of a gap connect. Default: `nowMs`. */
  attemptMs?: number;
  scheduleGapRecovery?: ScheduleGapRecovery;
}

/**
 * A connection opened at `nowMs`: `markConnected` (clears the lag evidence),
 * the mode and host index, and, on a gap, `pending_gap=1`, the resume point
 * moved to the live tail (`tailCursor`) and gap recovery, all in one
 * transaction. So the gap is durable before the first live event can move the
 * cursor past the evidence of it, and it is handled once: a later reconnect
 * (planned refresh, pulse, drop) resumes from the tail instead of re-reading
 * the abandoned cursor, re-detecting the gap and scheduling recovery again.
 */
export function noteConnected(db: Db, nowMs: number, note: ConnectedNote): void {
  db.tx(() => {
    markConnected(db, nowMs, note.gap === null ? {} : { tailCursor: tailCursor(note.attemptMs ?? nowMs) });
    updateCheckpointBookkeeping(db, {
      mode: note.mode,
      hostIndex: note.hostIndex,
      ...(note.gap === null ? {} : { pendingGap: true }),
    });
    if (note.gap !== null) note.scheduleGapRecovery?.(db, nowMs);
  });
}

/**
 * A connection closed (close, error, pulse end) at `nowMs`. `markDisconnected`
 * writes only on the 1→0 transition; `hostIndex` records a rotation. Returns
 * whether the disconnect instant was written.
 */
export function noteDisconnected(db: Db, nowMs: number, o: { hostIndex?: number } = {}): boolean {
  return db.tx(() => {
    const wrote = markDisconnected(db, nowMs);
    if (o.hostIndex !== undefined) updateCheckpointBookkeeping(db, { hostIndex: o.hostIndex });
    return wrote;
  });
}

/** IndexDO start-up after an eviction or deploy: no socket survives (W5-01 constructor). */
export function noteRestart(db: Db, nowMs: number): boolean {
  return noteDisconnected(db, nowMs);
}

/** Host rotation without a connection change (a failed connect). */
export function noteHostIndex(db: Db, hostIndex: number): void {
  updateCheckpointBookkeeping(db, { hostIndex });
}

/** The effective ingest mode, when it changed. */
export function noteMode(db: Db, mode: IngestMode): void {
  if (readIngestCheckpoint(db).mode !== mode) updateCheckpointBookkeeping(db, { mode });
}
