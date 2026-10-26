// A fake Jetstream: an append-only event log with a monotonic `seq`, inclusive
// cursor replay, a retention (lookback) bound, and a socket driver the test
// controls. TEST-ONLY.
//
// Hosts (ADR 0005 §3.4, N1-04):
// - `fetch(req)` answers an upgrade with a 101 Response carrying the client
//   end of a socket pair: workerd's WebSocketPair when the host has one (kept
//   for the workerd suites until N7-01), else the in-memory
//   `MemoryWebSocketPair` below. Where the host's Response refuses status 101
//   (Node/undici), the 101 and `webSocket` are set on a stand-in Response.
// - `memoryLink(fakes)` is an in-memory JetstreamLink connector that works on
//   any host: it runs the same handshake (faults, call log, cursor checks)
//   over a MemoryWebSocketPair and hands back a link that buffers its events
//   until `start()`, as the production connectors do.
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

/** The two ends of a socket pair: the client end goes to the connector, the server end stays with the fake. */
export interface SocketPair {
  client: WorkerdWebSocket;
  server: WorkerdWebSocket;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

function copyData(data: string | ArrayBufferLike | ArrayBufferView): string | ArrayBuffer {
  if (typeof data === 'string') return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  }
  return new Uint8Array(data).slice().buffer;
}

function closeEvent(code: number, reason: string): Event {
  const Ctor = (globalThis as { CloseEvent?: typeof CloseEvent }).CloseEvent;
  if (Ctor) return new Ctor('close', { code, reason, wasClean: true });
  return Object.assign(new Event('close'), { code, reason, wasClean: true });
}

function messageEvent(data: string | ArrayBuffer): Event {
  const Ctor = (globalThis as { MessageEvent?: typeof MessageEvent }).MessageEvent;
  if (Ctor) return new Ctor('message', { data });
  return Object.assign(new Event('message'), { data });
}

/**
 * One end of an in-memory WebSocket pair with workerd's semantics: events
 * queue until `accept()`, then are dispatched in order, each asynchronously
 * (a microtask, never a timer); `send` copies its data (binary arrives as an
 * ArrayBuffer); `close(code, reason)` delivers a close event with that code
 * to the peer (1005 when no code is given) and a socket that has sent its
 * close refuses further sends. No I/O, no timers: it works on any host.
 */
export class MemoryWebSocket extends EventTarget {
  static readonly CONNECTING = WS_CONNECTING;
  static readonly OPEN = WS_OPEN;
  static readonly CLOSING = WS_CLOSING;
  static readonly CLOSED = WS_CLOSED;
  readonly CONNECTING = WS_CONNECTING;
  readonly OPEN = WS_OPEN;
  readonly CLOSING = WS_CLOSING;
  readonly CLOSED = WS_CLOSED;
  readyState: number = WS_OPEN;
  binaryType: BinaryType = 'arraybuffer';
  readonly bufferedAmount = 0;
  readonly extensions = '';
  readonly protocol = '';
  readonly url: string | null = null;
  /** Close code this end sent, or null. */
  sentCloseCode: number | null = null;
  private peer: MemoryWebSocket | null = null;
  private accepted = false;
  private receivedClose = false;
  private draining = false;
  private readonly inbox: Event[] = [];

  /** Pairs two ends (MemoryWebSocketPair does this). */
  static link(a: MemoryWebSocket, b: MemoryWebSocket): void {
    a.peer = b;
    b.peer = a;
  }

  accept(): void {
    if (this.accepted) throw new TypeError('WebSocket already accepted');
    this.accepted = true;
    this.drain();
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.sentCloseCode !== null) throw new TypeError("Can't call WebSocket send() after close().");
    this.peer?.enqueue(messageEvent(copyData(data)));
  }

  close(code?: number, reason?: string): void {
    if (this.sentCloseCode !== null) return;
    const sent = code ?? 1005;
    this.sentCloseCode = sent;
    this.readyState = this.receivedClose ? WS_CLOSED : WS_CLOSING;
    this.peer?.enqueue(closeEvent(sent, reason ?? ''));
  }

  private enqueue(ev: Event): void {
    if (this.readyState === WS_CLOSED) return;
    this.inbox.push(ev);
    this.drain();
  }

  private drain(): void {
    if (!this.accepted || this.draining || this.inbox.length === 0) return;
    this.draining = true;
    queueMicrotask(() => {
      this.draining = false;
      const ev = this.inbox.shift();
      if (ev === undefined) return;
      if (ev.type === 'close') {
        this.receivedClose = true;
        this.readyState = this.sentCloseCode !== null ? WS_CLOSED : WS_CLOSING;
      }
      this.dispatchEvent(ev);
      this.drain();
    });
  }
}

/** An in-memory stand-in for workerd's WebSocketPair, with the same shape (`0` client, `1` server). */
export class MemoryWebSocketPair {
  readonly 0: MemoryWebSocket;
  readonly 1: MemoryWebSocket;
  constructor() {
    this[0] = new MemoryWebSocket();
    this[1] = new MemoryWebSocket();
    MemoryWebSocket.link(this[0], this[1]);
  }
}

/** An in-memory socket pair (any host). */
export function memoryPair(): SocketPair {
  const pair = new MemoryWebSocketPair();
  return {
    client: pair[0] as unknown as WorkerdWebSocket,
    server: pair[1] as unknown as WorkerdWebSocket,
  };
}

/** The host's WebSocketPair when it has one (workerd), else the in-memory pair. */
function webSocketPair(): SocketPair {
  const Ctor = (globalThis as { WebSocketPair?: WebSocketPairCtor }).WebSocketPair;
  if (!Ctor) return memoryPair();
  const pair = new Ctor();
  return { client: pair[0], server: pair[1] };
}

/**
 * A 101 Response carrying `client` as its `webSocket`. workerd builds it
 * natively; a host whose Response refuses status 101 (Node/undici throw a
 * RangeError) gets a stand-in Response with `status`, `ok`, `statusText` and
 * `webSocket` set on the instance.
 */
function upgradeResponse(client: WorkerdWebSocket): Response {
  try {
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  const res = new Response(null, { status: 200 });
  Object.defineProperties(res, {
    status: { value: 101 },
    ok: { value: false },
    statusText: { value: 'Switching Protocols' },
    webSocket: { value: client },
  });
  return res;
}

export type CursorResolution =
  | { ok: true; events: JetstreamEvent[] }
  | { ok: false; reason: 'outdated_cursor'; floorUs: number };

/** A handshake's outcome: a refusal Response (no socket), or an accepted upgrade's client end. */
export type Handshake = { kind: 'refused'; response: Response } | { kind: 'upgraded'; client: WorkerdWebSocket };

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

  /** The HTTP face: a refusal, or a 101 whose `webSocket` is the client end (workerd's pair, else in-memory). */
  readonly fetch = async (req: Request): Promise<Response> => {
    const answer = await this.handshake(req, webSocketPair);
    return answer.kind === 'refused' ? answer.response : upgradeResponse(answer.client);
  };

  /**
   * One subscribe handshake over sockets from `pair`: faults first, then the
   * path, upgrade header and cursor checks, then the accepted connection with
   * its replay sent. Every attempt is logged in `calls`.
   */
  async handshake(req: Request, pair: () => SocketPair): Promise<Handshake> {
    const refused = (response: Response): Handshake => ({ kind: 'refused', response });
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
      return refused(res);
    }
    if (url.pathname !== SUBSCRIBE_PATH && url.pathname !== '/subscribe') {
      log(404, null);
      return refused(xrpcError(404, 'NotFound', `no such endpoint ${url.pathname}`));
    }
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      log(426, null);
      return refused(xrpcError(426, 'InvalidRequest', 'expected a websocket upgrade'));
    }
    const rawCursor = url.searchParams.get('cursor');
    if (rawCursor !== null && !/^[0-9]{1,16}$/.test(rawCursor)) {
      log(400, null);
      return refused(xrpcError(400, 'InvalidRequest', 'cursor must be a non-negative integer'));
    }
    const cursor = rawCursor === null ? null : Number(rawCursor);
    const resolved = this.resolveCursor(cursor);
    if (!resolved.ok) {
      log(400, null);
      return refused(
        xrpcError(400, 'OutdatedCursor', `cursor ${cursor} is older than the ${this.lookbackHours} h lookback`),
      );
    }
    const collections = [...url.searchParams.getAll('collections'), ...url.searchParams.getAll('wantedCollections')];
    const kinds = url.searchParams.getAll('kinds');
    const { client, server } = pair();
    server.accept();
    const conn = new FakeJetstreamConnection(url, cursor, collections, kinds, client, server);
    this.connections.push(conn);
    for (const e of resolved.events) if (conn.wants(e)) conn.send(e);
    log(101, null);
    return { kind: 'upgraded', client };
  }
}

export function fakeJetstream(o?: FakeJetstreamOptions): FakeJetstream {
  return new FakeJetstream(o);
}

// ---------------------------------------------------------------------------
// memoryLink: an in-memory JetstreamLink connector (any host)

/** Structurally the worker's `LinkEvent` (worker/src/do/ingest/jetstream-socket.ts). */
export type MemoryLinkEvent =
  | { type: 'message'; data: string | ArrayBuffer }
  | { type: 'close'; code: number; reason: string }
  | { type: 'error'; message: string };

/** Structurally the worker's `JetstreamLink`: events are buffered until `start`. */
export interface MemoryJetstreamLink {
  readonly url: string;
  start(onEvent: (e: MemoryLinkEvent) => void): void;
  close(code?: number, reason?: string): void;
}

/** The default refusal: the same fields and `cursorRejected` rule as the worker's JetstreamConnectError. */
export class MemoryLinkConnectError extends Error {
  constructor(
    readonly status: number | null,
    readonly error: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryLinkConnectError';
  }

  get cursorRejected(): boolean {
    return this.status === 400 && this.error !== null && /cursor/i.test(this.error);
  }
}

export interface MemoryLinkOptions {
  /**
   * Builds the error for a refused or failed connect. The worker suites pass
   * `(s, e, m) => new JetstreamConnectError(s, e, m)` so the ingest socket's
   * `instanceof` and `cursorRejected` handling run unchanged.
   */
  connectError?: (status: number | null, error: string | null, message: string) => Error;
}

export type MemoryConnector = (url: string) => Promise<MemoryJetstreamLink>;

const ERROR_BODY_LIMIT = 4096;

/** The XRPC `error` name of a refusal body (first 4 KiB), or null. */
async function refusalName(res: Response): Promise<string | null> {
  if (res.body === null) return null;
  const reader = res.body.getReader();
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

/** Accepts `ws` and buffers its events until the owner starts the link (as the worker's `linkOf`). */
function bufferedLink(ws: WorkerdWebSocket, url: string): MemoryJetstreamLink {
  ws.accept();
  const queue: MemoryLinkEvent[] = [];
  let sink: ((e: MemoryLinkEvent) => void) | null = null;
  const deliver = (e: MemoryLinkEvent) => {
    if (sink === null) queue.push(e);
    else sink(e);
  };
  ws.addEventListener('message', (ev) => {
    const data = (ev as MessageEvent).data as unknown;
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

/**
 * An in-memory Jetstream connector over one or more fakes, routed by the URL's
 * host. Each connect runs the fake's own handshake (fault queue, call log,
 * cursor and lookback checks) over a MemoryWebSocketPair: an upgrade resolves
 * to a buffered link; a refusal rejects with `connectError(status, xrpcError,
 * message)`; an unknown host rejects like a failed DNS lookup (status null)
 * without reaching any fake. `wss:`/`ws:` URLs are mapped to `https:`/`http:`
 * for the handshake request. Works on any host: no WebSocketPair, no sockets.
 */
export function memoryLink(
  fakes: FakeJetstream | readonly FakeJetstream[],
  o: MemoryLinkOptions = {},
): MemoryConnector {
  const list: readonly FakeJetstream[] = fakes instanceof FakeJetstream ? [fakes] : fakes;
  const byHost = new Map(list.map((f) => [f.host.toLowerCase(), f]));
  const fail = o.connectError ?? ((status, error, message) => new MemoryLinkConnectError(status, error, message));
  return async (url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw fail(null, null, `jetstream connect failed: invalid URL ${url}`);
    }
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    else if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    const fake = byHost.get(parsed.hostname.toLowerCase());
    if (fake === undefined) throw fail(null, null, `jetstream connect failed: no Jetstream at ${parsed.hostname}`);
    let answer: Handshake;
    try {
      answer = await fake.handshake(new Request(parsed, { headers: { upgrade: 'websocket' } }), memoryPair);
    } catch (error) {
      throw fail(null, null, `jetstream connect failed: ${String(error)}`);
    }
    if (answer.kind === 'refused') {
      const status = answer.response.status;
      const name = await refusalName(answer.response).catch(() => null);
      throw fail(status, name, `jetstream refused the upgrade: ${status} ${name ?? ''}`);
    }
    return bufferedLink(answer.client, url);
  };
}
