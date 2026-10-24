// A fake Jetstream: an append-only event log with a monotonic `seq`, inclusive
// cursor replay, a retention (lookback) bound, and a WebSocketPair driver the
// test controls. TEST-ONLY; WebSocketPair exists only in workerd.
//
// Wire format, one JSON text frame per event (Jetstream commit shape plus the
// v2 `seq` cursor):
//   {"did","seq","time_us","kind":"commit","commit":{"rev","operation","collection","rkey","record"?,"cid"?}}
//
// Cursor semantics (network.bsky.jetstream.subscribeEvents):
// - a cursor below 1e15 is a `seq`; replay is inclusive (every event with seq >= cursor);
// - a cursor at or above 1e15 is a `time_us`; replay starts at the first event with time_us >= cursor;
// - a cursor is refused (HTTP 400 OutdatedCursor, no upgrade) when any event it
//   asks for has aged out of the lookback window, or a time cursor is older
//   than the window;
// - no cursor starts at the live tail.

import type { Clock } from '@atmusic/core/deps';
import { CallLog, type Fault, FaultQueue, faultName, faultResponse, paramsOf, xrpcError } from './router-transport';
import type { CommitResult } from './signed-repo';

export const JETSTREAM_HOST = 'jetstream.example.test';
export const SUBSCRIBE_NSID = 'network.bsky.jetstream.subscribeEvents';
export const SUBSCRIBE_PATH = `/xrpc/${SUBSCRIBE_NSID}`;
/** Cursor values at or above this are microsecond timestamps, below it sequence numbers. */
export const TIME_CURSOR_MIN = 1_000_000_000_000_000;

const FIXTURE_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

export interface JetstreamCommit {
  rev: string;
  operation: 'create' | 'update' | 'delete';
  collection: string;
  rkey: string;
  record?: unknown;
  cid?: string;
}

interface EventBase {
  seq: number;
  timeUs: number;
  did: string;
}

export type JetstreamEvent =
  | (EventBase & { kind: 'commit'; commit: JetstreamCommit })
  | (EventBase & { kind: 'identity'; identity: { did: string; handle?: string; seq: number; time: string } })
  | (EventBase & {
      kind: 'account';
      account: { did: string; active: boolean; status?: string; seq: number; time: string };
    });

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type JetstreamEventInput = DistributiveOmit<JetstreamEvent, 'seq' | 'timeUs'> & { timeUs?: number };

/** The JSON text frame for an event. */
export function encodeEvent(e: JetstreamEvent): string {
  const { seq, timeUs, did, ...rest } = e;
  return JSON.stringify({ did, seq, time_us: timeUs, ...rest });
}

export interface FakeJetstreamOptions {
  host?: string;
  clock?: Clock;
  /** Retention window. Default 24 h (the deployed JETSTREAM_LOOKBACK_HOURS). */
  lookbackHours?: number;
  /** First sequence number. Default 1. */
  startSeq?: number;
}

/** What a workerd WebSocket adds to the DOM type. */
type WorkerdWebSocket = WebSocket & { accept(): void };
type WebSocketPairCtor = new () => { 0: WorkerdWebSocket; 1: WorkerdWebSocket };

function webSocketPair(): { client: WorkerdWebSocket; server: WorkerdWebSocket } {
  const Ctor = (globalThis as { WebSocketPair?: WebSocketPairCtor }).WebSocketPair;
  if (!Ctor) throw new Error('fake Jetstream sockets need workerd (WebSocketPair)');
  const pair = new Ctor();
  return { client: pair[0], server: pair[1] };
}

export type CursorResolution =
  | { ok: true; events: JetstreamEvent[] }
  | { ok: false; reason: 'outdated_cursor'; floorUs: number };

/** One subscriber socket, driven by the test. */
export class FakeJetstreamConnection {
  /** Frames sent to the client, in order. */
  readonly sent: string[] = [];
  /** Frames the client sent (e.g. options_update). */
  readonly received: string[] = [];
  closed = false;
  closeCode: number | null = null;
  /** Highest seq delivered on this socket. */
  lastSeq: number | null = null;

  constructor(
    readonly url: URL,
    readonly cursor: number | null,
    readonly collections: readonly string[],
    readonly kinds: readonly string[],
    readonly client: WebSocket,
    private readonly server: WorkerdWebSocket,
  ) {
    server.addEventListener('message', (ev) => {
      this.received.push(typeof ev.data === 'string' ? ev.data : '[binary]');
    });
    server.addEventListener('close', (ev) => {
      if (!this.closed) {
        this.closed = true;
        this.closeCode = ev.code;
        try {
          server.close(ev.code === 1005 ? 1000 : ev.code, 'client closed');
        } catch {
          // already closed
        }
      }
    });
  }

  wants(e: JetstreamEvent): boolean {
    if (this.kinds.length > 0 && !this.kinds.includes(e.kind)) return false;
    if (e.kind === 'commit' && this.collections.length > 0) return this.collections.includes(e.commit.collection);
    return true;
  }

  /** Send an event (or any raw text frame, e.g. malformed JSON) to the client. */
  send(event: JetstreamEvent | string): void {
    if (this.closed) throw new Error('fake Jetstream socket is closed');
    if (typeof event === 'string') {
      this.sent.push(event);
      this.server.send(event);
      return;
    }
    const text = encodeEvent(event);
    this.sent.push(text);
    this.lastSeq = event.seq;
    this.server.send(text);
  }

  /** Close from the server side; the client sees a close event with `code`. */
  close(code = 1000, reason = 'fixture close'): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.server.close(code, reason);
  }

  /** Deliver an `error` event to the client's listeners, then drop the socket (1011). */
  error(message = 'fixture socket error'): void {
    const ErrorEventCtor = (globalThis as { ErrorEvent?: typeof ErrorEvent }).ErrorEvent;
    const ev = ErrorEventCtor ? new ErrorEventCtor('error', { message }) : new Event('error');
    this.client.dispatchEvent(ev);
    this.close(1011, message);
  }
}

export class FakeJetstream {
  readonly host: string;
  readonly calls = new CallLog();
  /** Faults for the connect request (e.g. a 503 before upgrade). */
  readonly faults = new FaultQueue();
  readonly events: JetstreamEvent[] = [];
  readonly connections: FakeJetstreamConnection[] = [];
  lookbackHours: number;
  private readonly clock: Clock;
  private nextSeq: number;
  private lastTimeUs = 0;

  constructor(o: FakeJetstreamOptions = {}) {
    this.host = o.host ?? JETSTREAM_HOST;
    this.clock = o.clock ?? { nowMs: () => FIXTURE_NOW_MS };
    this.lookbackHours = o.lookbackHours ?? 24;
    this.nextSeq = o.startSeq ?? 1;
  }

  /** Oldest time_us still replayable. */
  floorUs(): number {
    return (this.clock.nowMs() - this.lookbackHours * 3_600_000) * 1000;
  }

  /** Append one event (seq assigned, time_us from the clock unless given) and send it to live sockets. */
  append(input: JetstreamEventInput): JetstreamEvent {
    const timeUs = Math.max(input.timeUs ?? this.clock.nowMs() * 1000, this.lastTimeUs + 1);
    this.lastTimeUs = timeUs;
    const e = { ...input, seq: this.nextSeq++, timeUs } as JetstreamEvent;
    this.events.push(e);
    for (const c of this.connections) if (!c.closed && c.wants(e)) c.send(e);
    return e;
  }

  /** One commit event per op of a signed commit, in op order. */
  appendCommit(commit: CommitResult): JetstreamEvent[] {
    return commit.ops.map((op) =>
      this.append({
        kind: 'commit',
        did: commit.did,
        commit: {
          rev: commit.rev,
          operation: op.action,
          collection: op.collection,
          rkey: op.rkey,
          ...(op.action === 'delete' ? {} : { record: op.record, cid: op.cid! }),
        },
      }),
    );
  }

  /** The events a cursor asks for, or a refusal when part of them aged out. */
  resolveCursor(cursor: number | null): CursorResolution {
    if (cursor === null) return { ok: true, events: [] };
    const floor = this.floorUs();
    if (cursor >= TIME_CURSOR_MIN) {
      if (cursor < floor) return { ok: false, reason: 'outdated_cursor', floorUs: floor };
      return { ok: true, events: this.events.filter((e) => e.timeUs >= cursor) };
    }
    const wanted = this.events.filter((e) => e.seq >= cursor);
    if (wanted.some((e) => e.timeUs < floor)) return { ok: false, reason: 'outdated_cursor', floorUs: floor };
    return { ok: true, events: wanted };
  }

  /** Open sockets. */
  live(): FakeJetstreamConnection[] {
    return this.connections.filter((c) => !c.closed);
  }

  readonly fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const log = (status: number, fault: Fault | null) =>
      this.calls.record({
        service: 'jetstream',
        host: this.host,
        method: req.method,
        path: url.pathname,
        nsid: url.pathname === SUBSCRIBE_PATH ? SUBSCRIBE_NSID : null,
        params: paramsOf(url),
        did: null,
        status,
        fault: fault ? faultName(fault) : null,
      });
    const fault = this.faults.take({ nsid: SUBSCRIBE_NSID, did: null, path: url.pathname });
    if (fault) {
      if (fault.kind === 'hang') log(0, fault); // the call arrived; it just never answers
      const res = await faultResponse(fault, req);
      log(res.status, fault);
      return res;
    }
    if (url.pathname !== SUBSCRIBE_PATH && url.pathname !== '/subscribe') {
      log(404, null);
      return xrpcError(404, 'NotFound', `no such endpoint ${url.pathname}`);
    }
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      log(426, null);
      return xrpcError(426, 'InvalidRequest', 'expected a websocket upgrade');
    }
    const rawCursor = url.searchParams.get('cursor');
    if (rawCursor !== null && !/^[0-9]{1,16}$/.test(rawCursor)) {
      log(400, null);
      return xrpcError(400, 'InvalidRequest', 'cursor must be a non-negative integer');
    }
    const cursor = rawCursor === null ? null : Number(rawCursor);
    const resolved = this.resolveCursor(cursor);
    if (!resolved.ok) {
      log(400, null);
      return xrpcError(400, 'OutdatedCursor', `cursor ${cursor} is older than the ${this.lookbackHours} h lookback`);
    }
    const collections = [...url.searchParams.getAll('collections'), ...url.searchParams.getAll('wantedCollections')];
    const kinds = url.searchParams.getAll('kinds');
    const { client, server } = webSocketPair();
    server.accept();
    const conn = new FakeJetstreamConnection(url, cursor, collections, kinds, client, server);
    this.connections.push(conn);
    for (const e of resolved.events) if (conn.wants(e)) conn.send(e);
    log(101, null);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  };
}

export function fakeJetstream(o?: FakeJetstreamOptions): FakeJetstream {
  return new FakeJetstream(o);
}
