// The Jetstream socket (ADR 0004 §5.5 `socket` mode) and the connector shared
// with `pulse` mode (worker/src/do/ingest/ingest-mode.ts).
//
// Connector. `connectJetstream(url)` is the only network edge. Production
// (`createJetstreamConnector()`) does `fetch(httpsUrl, {headers:{Upgrade:
// 'websocket'}})` and then `resp.webSocket.accept()`, and wraps the socket in a
// JetstreamLink that buffers events until the owner starts it, so nothing is
// lost between accept() and listener registration. A non-101 answer throws
// JetstreamConnectError (status plus the XRPC error name); a 400 naming a
// cursor error is a rejected cursor. Tests inject a connector over the fake
// Jetstream (worker/test/fixtures/jetstream-server.ts), built with the same
// factory.
//
// `connect(m, connectJetstream, now)`:
// - the URL comes from `buildSubscribeUrl` (always `kinds=commit`, exactly the
//   scrobble, follow and settings collections) on host
//   `JETSTREAM_URLS[host_index]`, with the checkpoint cursor;
// - gap detection: no cursor, a cursor older than JETSTREAM_LOOKBACK_HOURS, or
//   a rejected cursor (then retried once without one) → connect from the live
//   tail, and on success `pending_gap=1`, the stored cursor moved to the tail
//   (a `time_us` cursor at the attempt instant) and gap recovery in the
//   connect transaction (checkpoint.ts), so the next reconnect resumes from
//   the tail and the gap is handled once;
// - success → `markConnected` (checkpoint.ts `noteConnected`) and the watchdog,
//   in one transaction; a failed connect writes no connection evidence,
//   rotates `host_index` and, in socket mode, schedules the watchdog with
//   backoff. If that post-upgrade transaction throws, the accepted socket is
//   closed with 1011 and the attempt is handled as a failed connect.
// - events: message → `onMessage` (jetstream.ts); close and error → mark
//   disconnected, rotate `host_index` across JETSTREAM_URLS and schedule the
//   watchdog at the reconnect backoff: 1 s base, exponential, 60 s cap, plus
//   injected jitter (`m.random`). The backoff streak resets once a connection
//   has stayed open STABLE_CONNECTION_MS.
//
// `socketWatchdog` (the `jetstream-watchdog` timer, every 60 s):
// - reconnects only if the socket is closed (and its backoff has passed);
// - does a planned refresh 15 min after a connection opened: close, then
//   connect again from the stored cursor on the same host;
// - never reconnects because the stream is silent.
//
// Quiet links (ADR §15 Q11). A link that received no message (other than the
// inclusive re-delivery of the event its resume point names) is confirmed
// healthy at its open instant when it ends by our own close after its whole
// confirmation window: a socket link at its planned refresh (open
// continuously for PLANNED_REFRESH_MS), or a pulse that drained its full 20 s
// (ingest-mode.ts) from a cursor at most QUIET_PULSE_MAX_BACKLOG_MS older than
// the pulse (a short drain proves nothing about a long replay). Then, before
// the close, the resume point moves to `open instant − 60 s`
// (checkpoint.ts `noteHealthyResume`), so a stream with no wanted events for
// longer than JETSTREAM_LOOKBACK_HOURS never looks like a gap. A close or an
// error from the server, a local failure, a superseding connect or a link
// that saw any message confirms nothing: the cursor stays where its last event
// put it, and a disconnect longer than the lookback is still a gap.
//
// In-memory state (the open link, the backoff streak) lives per Db wrapper,
// which IndexDO creates once per instance; after an eviction the new instance
// starts with no socket, and `noteRestart` (checkpoint.ts) records the drop.
// Timers written outside an alarm (by socket events) are reported through
// `onTimersChanged`, so IndexDO (W5-01) can re-arm the alarm.

import { buildSubscribeUrl } from '@atmusic/atproto/jetstream/events';
import type { AppConfig } from '../../config';
import type { ModuleDeps } from '../contracts';
import type { Db } from '../db';
import { dueAt, schedule } from '../timers';
import {
  exactCursorTimeUs,
  type GapReason,
  gapOnConnect,
  noteConnected,
  noteDisconnected,
  noteHealthyResume,
  noteHostIndex,
  readIngestCheckpoint,
  type ScheduleGapRecovery,
  tailCursor,
} from './checkpoint';
import { configuredCollections, type MessageOutcome, onBinaryMessage, onMessage } from './jetstream';

export const WATCHDOG_INTERVAL_MS = 60_000;
export const PLANNED_REFRESH_MS = 15 * 60_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 60_000;
/** Jitter adds up to this fraction of the exponential delay (still capped). */
export const RECONNECT_JITTER = 0.2;
/** A connection open at least this long resets the backoff streak. */
export const STABLE_CONNECTION_MS = 60_000;
/**
 * A quiet pulse confirms its open instant healthy only when it started from a
 * cursor at most this much older than the pulse (three pulse intervals).
 */
export const QUIET_PULSE_MAX_BACKLOG_MS = 15 * 60_000;
/** Deadline for the upgrade request. */
export const CONNECT_TIMEOUT_MS = 10_000;
const ERROR_BODY_LIMIT = 4096;

// ---------------------------------------------------------------------------
// Connector

export type LinkEvent =
  | { type: 'message'; data: string | ArrayBuffer }
  | { type: 'close'; code: number; reason: string }
  | { type: 'error'; message: string };

/** An accepted Jetstream WebSocket whose events are buffered until `start`. */
export interface JetstreamLink {
  readonly url: string;
  start(onEvent: (e: LinkEvent) => void): void;
  close(code?: number, reason?: string): void;
}

export type ConnectJetstream = (url: string) => Promise<JetstreamLink>;

export class JetstreamConnectError extends Error {
  constructor(
    readonly status: number | null,
    readonly error: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'JetstreamConnectError';
  }

  /** Jetstream refused the cursor (e.g. 400 OutdatedCursor). */
  get cursorRejected(): boolean {
    return this.status === 400 && this.error !== null && /cursor/i.test(this.error);
  }
}

type AcceptableWebSocket = WebSocket & { accept(): void };

/** Accepts `ws` and buffers its events until the owner starts the link. */
export function linkOf(ws: AcceptableWebSocket, url: string): JetstreamLink {
  ws.accept();
  const queue: LinkEvent[] = [];
  let sink: ((e: LinkEvent) => void) | null = null;
  const deliver = (e: LinkEvent) => {
    if (sink === null) queue.push(e);
    else sink(e);
  };
  ws.addEventListener('message', (ev) => {
    const data = ev.data;
    deliver({ type: 'message', data: typeof data === 'string' ? data : (data as ArrayBuffer) });
  });
  ws.addEventListener('close', (ev) => deliver({ type: 'close', code: ev.code, reason: ev.reason }));
  ws.addEventListener('error', (ev) =>
    deliver({ type: 'error', message: (ev as ErrorEvent).message ?? 'websocket error' }),
  );
  return {
    url,
    start(onEvent) {
      if (sink !== null) throw new Error('JetstreamLink already started');
      sink = onEvent;
      for (const e of queue.splice(0)) onEvent(e);
    },
    close(code = 1000, reason = '') {
      try {
        ws.close(code, reason);
      } catch {
        // already closing or closed
      }
    },
  };
}

async function errorName(resp: Response): Promise<string | null> {
  if (resp.body === null) return null;
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, ERROR_BODY_LIMIT));
  let at = 0;
  for (const c of chunks) {
    const n = Math.min(c.byteLength, bytes.length - at);
    bytes.set(c.subarray(0, n), at);
    at += n;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown };
    return typeof body.error === 'string' ? body.error.slice(0, 100) : null;
  } catch {
    return null;
  }
}

export interface ConnectorOptions {
  /** Defaults to the global `fetch` (Workers outbound WebSocket upgrade). */
  fetch?: (req: Request) => Promise<Response>;
  timeoutMs?: number;
}

/** The production connector: `fetch` with `Upgrade: websocket`, then `accept()`. */
export function createJetstreamConnector(o: ConnectorOptions = {}): ConnectJetstream {
  const timeoutMs = o.timeoutMs ?? CONNECT_TIMEOUT_MS;
  return async (url: string) => {
    const doFetch = o.fetch ?? ((req: Request) => fetch(req));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('jetstream connect timed out')), timeoutMs);
    let resp: Response;
    try {
      resp = await doFetch(new Request(url, { headers: { Upgrade: 'websocket' }, signal: controller.signal }));
    } catch (error) {
      throw new JetstreamConnectError(null, null, `jetstream connect failed: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    const ws = (resp as Response & { webSocket?: AcceptableWebSocket | null }).webSocket;
    if (resp.status !== 101 || ws === null || ws === undefined) {
      const name = await errorName(resp).catch(() => null);
      throw new JetstreamConnectError(resp.status, name, `jetstream refused the upgrade: ${resp.status} ${name ?? ''}`);
    }
    return linkOf(ws, url);
  };
}

/** Production connector over the global fetch. */
export const connectJetstream: ConnectJetstream = createJetstreamConnector();

// ---------------------------------------------------------------------------
// Socket state (per IndexDO instance)

export type LinkMode = 'socket' | 'pulse';

export interface SocketOptions {
  /** W4-01's scheduleGapRecovery, wired by W5-01 (see checkpoint.ts). */
  scheduleGapRecovery?: ScheduleGapRecovery;
  /** A socket event wrote a timer outside an alarm: re-arm the alarm (W5-01). */
  onTimersChanged?: () => void;
  /** Called after every message outcome on the current link (pulse uses it to detect the tail). */
  onOutcome?: (o: MessageOutcome) => void;
  /** Called once when the current link ends (close, error or local failure). */
  onEnd?: (cause: EndCause) => void;
}

export type EndCause = 'close' | 'error' | 'local_failure' | 'cursor_rejected' | 'superseded';

export interface OpenLink {
  link: JetstreamLink;
  url: string;
  mode: LinkMode;
  hostIndex: number;
  /** The cursor the URL carried; null for the live tail. */
  cursor: number | null;
  /** The stored resume point when the link opened (the tail cursor of a gap connect). */
  resumeCursor: number | null;
  /** The exact event time of that resume point (µs), when known. */
  startTimeUs: number | null;
  gap: GapReason | null;
  openedAtMs: number;
  refreshAtMs: number;
  messages: number;
  /** Messages other than the inclusive re-delivery of `resumeCursor`'s event. */
  activity: number;
}

interface SocketState {
  current: OpenLink | null;
  options: SocketOptions;
  connecting: Promise<ConnectResult> | null;
  /** Consecutive failed connects / unstable connections. */
  streak: number;
  /** No reconnect before this instant (backoff). */
  nextAttemptAtMs: number;
  /**
   * An OutdatedCursor notice: the next connect starts from the live tail with
   * a gap. In memory only; if the instance dies first, the reconnect offers the
   * stored cursor again and Jetstream refuses it again.
   */
  forceTail: boolean;
}

const states = new WeakMap<Db, SocketState>();

function stateOf(m: Pick<ModuleDeps, 'db'>): SocketState {
  let s = states.get(m.db);
  if (s === undefined) {
    s = { current: null, options: {}, connecting: null, streak: 0, nextAttemptAtMs: 0, forceTail: false };
    states.set(m.db, s);
  }
  return s;
}

/** A read-only view of this instance's link (for status and tests). */
export function socketStatus(m: Pick<ModuleDeps, 'db'>): {
  open: OpenLink | null;
  streak: number;
  nextAttemptAtMs: number;
} {
  const s = stateOf(m);
  return { open: s.current, streak: s.streak, nextAttemptAtMs: s.nextAttemptAtMs };
}

/** Reconnect delay after the `streak`-th consecutive failure (1 s, 2 s, 4 s, … 60 s, plus jitter, capped). */
export function reconnectDelayMs(streak: number, jitter: number): number {
  const exponent = Math.min(Math.max(streak, 1) - 1, 30);
  const base = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** exponent);
  const j = Number.isFinite(jitter) && jitter > 0 ? Math.min(jitter, 1) : 0;
  return Math.min(RECONNECT_CAP_MS, Math.floor(base * (1 + RECONNECT_JITTER * j)));
}

function hostCount(config: AppConfig): number {
  return Math.max(config.jetstreamUrls.length, 1);
}

/** The subscribe URL for host `hostIndex` (mod the host count), resuming at `cursor` or at the live tail. */
export function subscribeUrl(m: Pick<ModuleDeps, 'config'>, hostIndex: number, cursor: number | null): string {
  const urls = m.config.jetstreamUrls;
  const host = urls[hostIndex % hostCount(m.config)];
  if (host === undefined) throw new TypeError('JETSTREAM_URLS is empty');
  return buildSubscribeUrl(host, configuredCollections(m), cursor ?? undefined);
}

// ---------------------------------------------------------------------------
// Connect

export type ConnectResult =
  | { ok: true; url: string; hostIndex: number; gap: GapReason | null; reused: boolean }
  | {
      ok: false;
      reason: 'off' | 'failed';
      url?: string;
      status?: number | null;
      error?: string | null;
      /** The next attempt (socket mode backoff). */
      retryAtMs?: number;
    };

function bump(m: ModuleDeps, s: SocketState, now: number): number {
  s.streak += 1;
  const delay = reconnectDelayMs(s.streak, m.random.float());
  s.nextAttemptAtMs = now + delay;
  return s.nextAttemptAtMs;
}

/**
 * Open the Jetstream link for `mode` (default: the configured effective mode).
 * Resolves once the link is open (or failed). At most one connect runs at a
 * time; a second call while one is in flight joins it.
 */
export function connect(
  m: ModuleDeps,
  connectJetstream: ConnectJetstream,
  now: number,
  options: SocketOptions & { mode?: LinkMode } = {},
): Promise<ConnectResult> {
  const s = stateOf(m);
  if (s.connecting !== null) return s.connecting;
  const mode = options.mode ?? m.config.ingestMode;
  if (mode === 'off' || configuredCollections(m).length === 0 || m.config.jetstreamUrls.length === 0) {
    return Promise.resolve({ ok: false, reason: 'off' });
  }
  if (s.current !== null && s.current.mode === mode) {
    return Promise.resolve({ ok: true, url: s.current.url, hostIndex: s.current.hostIndex, gap: null, reused: true });
  }
  if (s.current !== null) dropLink(m, s, 'superseded', now);
  s.options = options;
  const run = doConnect(m, s, connectJetstream, now, mode).finally(() => {
    s.connecting = null;
  });
  s.connecting = run;
  return run;
}

async function doConnect(
  m: ModuleDeps,
  s: SocketState,
  connector: ConnectJetstream,
  now: number,
  mode: LinkMode,
): Promise<ConnectResult> {
  const cp = readIngestCheckpoint(m.db);
  const hostIndex = cp.hostIndex % hostCount(m.config);
  let gap: GapReason | null = s.forceTail ? 'cursor_rejected' : gapOnConnect(cp, now, m.config.jetstreamLookbackHours);
  let cursor = gap === null ? cp.cursor : null;
  let url = subscribeUrl(m, hostIndex, cursor);
  let link: JetstreamLink;
  try {
    try {
      link = await connector(url);
    } catch (error) {
      if (!(error instanceof JetstreamConnectError && error.cursorRejected && cursor !== null)) throw error;
      // Jetstream refused the stored cursor: a gap. Resume from the live tail.
      m.log.log('warn', 'jetstream_cursor_rejected', { cursor, status: error.status, error: error.error });
      gap = 'cursor_rejected';
      cursor = null;
      url = subscribeUrl(m, hostIndex, null);
      link = await connector(url);
    }
  } catch (error) {
    const e = error instanceof JetstreamConnectError ? error : null;
    return connectFailed(m, s, mode, hostIndex, now, url, {
      status: e?.status ?? null,
      error: e?.error ?? null,
      detail: e === null ? String(error) : null,
    });
  }

  // The upgrade was accepted. The connection evidence and the watchdog are
  // written in one transaction; if that throws (e.g. the injected
  // scheduleGapRecovery), nothing of it is stored, the accepted socket is
  // closed (it would otherwise queue frames and pin the instance), and the
  // attempt counts as a failed connect: host rotated, backoff bumped.
  const openedAtMs = m.clock.nowMs();
  try {
    m.db.tx(() => {
      noteConnected(m.db, openedAtMs, {
        mode,
        hostIndex,
        gap,
        attemptMs: now,
        ...(s.options.scheduleGapRecovery === undefined ? {} : { scheduleGapRecovery: s.options.scheduleGapRecovery }),
      });
      if (mode === 'socket') {
        schedule(
          m.db,
          'jetstream-watchdog',
          Math.min(openedAtMs + WATCHDOG_INTERVAL_MS, openedAtMs + PLANNED_REFRESH_MS),
          { force: true },
        );
      }
    });
  } catch (error) {
    link.close(1011, 'local_failure');
    m.log.log('error', 'jetstream_connect_bookkeeping_failed', { error: String(error) });
    return connectFailed(m, s, mode, hostIndex, now, url, {
      status: null,
      error: 'local_failure',
      detail: String(error),
    });
  }
  s.forceTail = false;
  const open: OpenLink = {
    link,
    url,
    mode,
    hostIndex,
    cursor,
    resumeCursor: gap === null ? cp.cursor : tailCursor(now),
    startTimeUs: gap === null ? exactCursorTimeUs(cp) : tailCursor(now),
    gap,
    openedAtMs,
    refreshAtMs: openedAtMs + PLANNED_REFRESH_MS,
    messages: 0,
    activity: 0,
  };
  s.current = open;
  m.log.log('info', 'jetstream_connected', {
    host: new URL(url).host,
    mode,
    cursor,
    gap,
  });
  link.start((e) => onLinkEvent(m, s, open, e));
  return { ok: true, url, hostIndex, gap, reused: false };
}

/**
 * A failed connect (refused or failed upgrade, or local bookkeeping that threw
 * after the upgrade): writes no connection evidence, rotates `host_index` and,
 * in socket mode, bumps the backoff and schedules the watchdog.
 */
function connectFailed(
  m: ModuleDeps,
  s: SocketState,
  mode: LinkMode,
  hostIndex: number,
  now: number,
  url: string,
  f: { status: number | null; error: string | null; detail: string | null },
): ConnectResult {
  const next = (hostIndex + 1) % hostCount(m.config);
  let retryAtMs: number | undefined;
  m.db.tx(() => {
    noteHostIndex(m.db, next);
    if (mode === 'socket') {
      retryAtMs = bump(m, s, now);
      schedule(m.db, 'jetstream-watchdog', retryAtMs, { force: true });
    }
  });
  m.log.log('warn', 'jetstream_connect_failed', {
    host: new URL(url).host,
    status: f.status,
    error: f.error ?? f.detail,
    nextHostIndex: next,
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
  });
  return {
    ok: false,
    reason: 'failed',
    url,
    status: f.status,
    error: f.error,
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
  };
}

// ---------------------------------------------------------------------------
// Link events

function onLinkEvent(m: ModuleDeps, s: SocketState, open: OpenLink, e: LinkEvent): void {
  if (s.current !== open) return; // a superseded or dropped link: its events are not ours
  const now = m.clock.nowMs();
  if (e.type === 'message') {
    let outcome: MessageOutcome;
    try {
      outcome = typeof e.data === 'string' ? onMessage(m, e.data, now) : onBinaryMessage(m);
    } catch (error) {
      // Nothing was written (one transaction). Drop the link so the stream
      // resumes from the unchanged cursor instead of skipping this event.
      m.log.log('error', 'jetstream_message_failed', { error: String(error) });
      dropLink(m, s, 'local_failure', now);
      return;
    }
    open.messages += 1;
    const replay = (outcome.kind === 'hint' || outcome.kind === 'ignored') && outcome.seq === open.resumeCursor;
    if (!replay) open.activity += 1;
    if (outcome.kind === 'hint') s.options.onTimersChanged?.();
    if (outcome.kind === 'notice' && outcome.notice.type === 'error' && /cursor/i.test(outcome.notice.name)) {
      s.forceTail = true;
      dropLink(m, s, 'cursor_rejected', now);
      return;
    }
    s.options.onOutcome?.(outcome);
    return;
  }
  m.log.log('warn', 'jetstream_disconnected', {
    host: new URL(open.url).host,
    cause: e.type,
    ...(e.type === 'close' ? { code: e.code } : { message: e.message }),
  });
  dropLink(m, s, e.type, now);
}

/**
 * Is `open`, ended now by our own close, confirmed healthy at its open
 * instant (see the header, "Quiet links")? Only a link that received no
 * message beyond the re-delivery of its resume point's own event qualifies.
 */
function quietAndHealthy(open: OpenLink, now: number, end: 'planned_refresh' | 'pulse_drained'): boolean {
  if (open.activity !== 0 || open.resumeCursor === null) return false;
  if (end === 'planned_refresh') return open.mode === 'socket' && now - open.openedAtMs >= PLANNED_REFRESH_MS;
  return (
    open.mode === 'pulse' &&
    open.startTimeUs !== null &&
    open.startTimeUs >= (open.openedAtMs - QUIET_PULSE_MAX_BACKLOG_MS) * 1000
  );
}

/**
 * End the current link: detach it, close it, mark disconnected and, for a
 * close or error, rotate the host and schedule the reconnect with backoff.
 * `healthy`: the link is confirmed healthy at its open instant (quietAndHealthy),
 * so the resume point moves forward first, in the same transaction.
 */
function dropLink(m: ModuleDeps, s: SocketState, cause: EndCause, now: number, o: { healthy?: boolean } = {}): void {
  const open = s.current;
  if (open === null) return;
  s.current = null;
  open.link.close(cause === 'local_failure' ? 1011 : 1000, cause);
  const failed = cause === 'close' || cause === 'error';
  const rotate = failed ? (open.hostIndex + 1) % hostCount(m.config) : undefined;
  if (now - open.openedAtMs >= STABLE_CONNECTION_MS) s.streak = 0;
  m.db.tx(() => {
    if (o.healthy === true) {
      const resume = noteHealthyResume(m.db, open.openedAtMs, open.resumeCursor!);
      if (resume !== null) m.log.log('info', 'jetstream_quiet_resume', { mode: open.mode, cursor: resume });
    }
    noteDisconnected(m.db, now, rotate === undefined ? {} : { hostIndex: rotate });
    if (open.mode !== 'socket' || cause === 'superseded') return;
    if (cause === 'cursor_rejected') {
      s.nextAttemptAtMs = now;
      schedule(m.db, 'jetstream-watchdog', now, { force: true });
    } else {
      schedule(m.db, 'jetstream-watchdog', bump(m, s, now), { force: true });
    }
  });
  if (open.mode === 'socket' && cause !== 'superseded') s.options.onTimersChanged?.();
  s.options.onEnd?.(cause);
}

/**
 * Close this instance's link, if any (off mode, mode change, shutdown, pulse
 * end). Marks disconnected. `pulseDrained`: a pulse closing after its full
 * drain window (ingest-mode.ts), which may confirm a quiet link healthy.
 */
export function closeSocket(m: ModuleDeps, now: number, o: { pulseDrained?: boolean } = {}): boolean {
  const s = stateOf(m);
  const open = s.current;
  if (open === null) return false;
  const healthy = o.pulseDrained === true && quietAndHealthy(open, now, 'pulse_drained');
  dropLink(m, s, 'superseded', now, { healthy });
  return true;
}

// ---------------------------------------------------------------------------
// Watchdog

export type WatchdogAction = 'none' | 'connected' | 'refreshed' | 'backoff' | 'failed' | 'busy' | 'off';

export interface WatchdogReport {
  action: WatchdogAction;
  connect?: ConnectResult;
  /** The next watchdog due time. */
  nextAtMs: number | null;
}

/**
 * The `jetstream-watchdog` timer handler in socket mode. Reconnects only a
 * closed socket, refreshes a connection 15 min after it opened, and never acts
 * on silence. Always leaves the timer scheduled.
 */
export async function socketWatchdog(
  m: ModuleDeps,
  connectJetstream: ConnectJetstream,
  now: number,
  options: SocketOptions = {},
): Promise<WatchdogReport> {
  const s = stateOf(m);
  if (s.connecting !== null) {
    schedule(m.db, 'jetstream-watchdog', now + WATCHDOG_INTERVAL_MS);
    return { action: 'busy', nextAtMs: now + WATCHDOG_INTERVAL_MS };
  }
  const open = s.current;
  if (open !== null && open.mode === 'socket') {
    if (now < open.refreshAtMs) {
      const next = Math.min(now + WATCHDOG_INTERVAL_MS, open.refreshAtMs);
      schedule(m.db, 'jetstream-watchdog', next, { force: true });
      return { action: 'none', nextAtMs: next };
    }
    // Planned refresh: the connection is healthy, so no backoff and no rotation;
    // a quiet one also moves the resume point forward (Q11, see the header).
    m.log.log('info', 'jetstream_planned_refresh', { host: new URL(open.url).host });
    dropLink(m, s, 'superseded', now, { healthy: quietAndHealthy(open, now, 'planned_refresh') });
    s.streak = 0;
    const result = await connect(m, connectJetstream, now, { ...options, mode: 'socket' });
    return { action: result.ok ? 'refreshed' : 'failed', connect: result, nextAtMs: nextWatchdog(m) };
  }
  if (now < s.nextAttemptAtMs) {
    schedule(m.db, 'jetstream-watchdog', s.nextAttemptAtMs, { force: true });
    return { action: 'backoff', nextAtMs: s.nextAttemptAtMs };
  }
  const result = await connect(m, connectJetstream, now, { ...options, mode: 'socket' });
  return { action: result.ok ? 'connected' : 'failed', connect: result, nextAtMs: nextWatchdog(m) };
}

function nextWatchdog(m: ModuleDeps): number | null {
  return dueAt(m.db, 'jetstream-watchdog');
}
