// Serves the W1-05 fake Jetstream (packages/atproto/test-support/fake-jetstream.ts)
// to the ingest socket through the Node host's own connector. TEST-ONLY.
//
// `jetstreamServer({...})` serves one FakeJetstream per host. The connector it
// returns is the production Node one (`connectJetstreamWs` from
// worker/src/node/jetstream-ws.ts, ADR 0005 §3.4: the JETSTREAM_URLS
// allow-list, the `ws` client options, the refusal status and XRPC error name,
// text and binary frames, close codes and buffering until `start`), whose
// injectable `ws` client constructor is replaced by an in-memory one: each
// connect runs the fake's own handshake through `memoryLink` (its fault queue,
// call log, path, upgrade and cursor checks, over an in-memory socket pair)
// and turns the outcome into the `ws` events the connector listens to
// (`open`, `message`, `close`, `error`, `unexpected-response`). Events reach
// the connector on a later task, as a socket's do, never in the microtasks of
// the code that sent them. Nothing opens a socket or reaches a network; a host
// that no fake serves is refused by the connector's allow-list before
// anything is dialled, like a failed DNS lookup.
//
// `append` mirrors one event into every host's log (as every Jetstream instance
// follows the same firehose), so seqs agree across hosts.
//
// Instance death. A deploy, restart or runtime update tears the index down
// with its socket. `sever()` stands in for that: every link handed out stops
// delivering events (a dead instance runs no handler) and the fake drops the
// server ends. It is fault injection at the connector interface only; the
// production link and socket code are unchanged.

import { EventEmitter } from 'node:events';
import {
  FakeJetstream,
  type FakeJetstreamConnection,
  type JetstreamEvent,
  type JetstreamEventInput,
  type MemoryJetstreamLink,
  MemoryLinkConnectError,
  type MemoryLinkEvent,
  memoryLink,
} from '@atmusic/atproto/test-support/fake-jetstream';
import type { Clock, Random } from '@atmusic/core/deps';
import type { ClientOptions } from 'ws';
import type { IngestMode } from '../../src/config';
import type { Logger, LogLevel, ModuleDeps } from '../../src/do/contracts';
import type { Db } from '../../src/do/db';
import type { ConnectJetstream } from '../../src/do/ingest/jetstream-socket';
import { connectJetstreamWs, type WsClientCtor } from '../../src/node/jetstream-ws';
import { harnessConfig } from '../node/support/with-index';

export interface ConnectAttempt {
  url: URL;
  host: string;
  /** The `cursor` query parameter, or null for the live tail. */
  cursor: number | null;
  /** The fake's answer: 101 for an upgrade, else the error status; 0 when it threw. */
  status: number;
}

export interface JetstreamServer {
  readonly fakes: readonly FakeJetstream[];
  /** The fake serving `host`. */
  at(host: string): FakeJetstream;
  /** The connector for `connect(m, connectJetstream, now)`. */
  readonly connect: ConnectJetstream;
  /** Every upgrade request, in order. */
  readonly attempts: ConnectAttempt[];
  /** Append one event to every host's log (and its live sockets). */
  append(input: JetstreamEventInput): JetstreamEvent;
  /** Open server-side connections across hosts. */
  live(): FakeJetstreamConnection[];
  /** The most recent connection (any host). */
  last(): FakeJetstreamConnection;
  /** The owning instance dies: its links go silent and the server ends close. */
  sever(): void;
}

export interface JetstreamServerOptions {
  clock: Clock;
  /** Hosts to serve (bare host names). Default: the harness JETSTREAM_URLS host. */
  hosts?: readonly string[];
  /** Existing fakes to serve instead (e.g. the read-model kit's `kit.jetstream`). */
  fakes?: readonly FakeJetstream[];
  lookbackHours?: number;
}

export const HARNESS_JETSTREAM_HOST = 'jetstream.example.test';

// ---------------------------------------------------------------------------
// The in-memory `ws` client

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

/** The close codes `ws` lets an endpoint send (its `isValidStatusCode`). */
function sendableCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999)
  );
}

interface ClientHooks {
  /** The memoryLink connector over the served fakes. */
  dial(url: string): Promise<MemoryJetstreamLink>;
  /** The handshake's answer (101 or the refusal status). */
  answered(status: number): void;
  /** Called after each handshake, so the server can collect the new connections. */
  settled(): void;
}

/**
 * What `ws`'s WebSocket is to connectJetstreamWs, in memory: the constructor
 * dials through memoryLink and every outcome becomes the `ws` event the
 * connector handles, emitted on a later task in order.
 */
class MemoryWsClient extends EventEmitter {
  readyState = WS_CONNECTING;
  /** The options the connector created this client with. */
  readonly options: ClientOptions;
  #link: MemoryJetstreamLink | null = null;
  #queue: Array<() => void> = [];
  #scheduled = false;
  #finished = false;

  constructor(address: string, options: ClientOptions, hooks: ClientHooks) {
    super();
    this.options = options;
    void this.#connect(address, hooks);
  }

  async #connect(address: string, hooks: ClientHooks): Promise<void> {
    let link: MemoryJetstreamLink;
    try {
      link = await hooks.dial(address);
    } catch (error) {
      hooks.settled();
      if (error instanceof MemoryLinkConnectError && error.status !== null) {
        hooks.answered(error.status);
        this.#refused(error.status, error.error);
      } else {
        this.#later(() => this.emit('error', error instanceof Error ? error : new Error(String(error))));
        this.#later(() => this.#finish(1006, ''));
      }
      return;
    }
    hooks.answered(101);
    hooks.settled();
    this.#link = link;
    this.#later(() => {
      if (this.#finished) return;
      this.readyState = WS_OPEN;
      this.emit('open');
      // Frames (the cursor replay included) arrive after the upgrade, on later tasks.
      link.start((event) => this.#later(() => this.#deliver(event)));
    });
  }

  /** A non-101 answer: `unexpected-response` with the status and the XRPC error body. */
  #refused(status: number, name: string | null): void {
    const body = Buffer.from(JSON.stringify(name === null ? {} : { error: name }), 'utf8');
    const res = Object.assign(new EventEmitter(), { statusCode: status });
    const req = { destroy: () => {} };
    this.#later(() => {
      this.emit('unexpected-response', req, res);
      this.#later(() => {
        res.emit('data', body);
        res.emit('end');
      });
    });
  }

  #deliver(event: MemoryLinkEvent): void {
    if (this.#finished) return;
    if (event.type === 'message') {
      const binary = typeof event.data !== 'string';
      const data =
        typeof event.data === 'string' ? Buffer.from(event.data, 'utf8') : Buffer.from(new Uint8Array(event.data));
      this.emit('message', data, binary);
    } else if (event.type === 'error') {
      this.emit('error', new Error(event.message));
    } else {
      // The peer's close: `ws` answers it with its own close frame, then reports the peer's code.
      this.#link?.close(sendableCloseCode(event.code) ? event.code : 1000, '');
      this.#finish(event.code, event.reason);
    }
  }

  #finish(code: number, reason: string): void {
    if (this.#finished) return;
    this.#finished = true;
    this.readyState = WS_CLOSED;
    this.emit('close', code, Buffer.from(reason, 'utf8'));
  }

  /**
   * Runs `fn` on a later task. What is queued when a task starts runs on it,
   * in order; what that work queues runs on the task after.
   */
  #later(fn: () => void): void {
    this.#queue.push(fn);
    this.#schedule();
  }

  #schedule(): void {
    if (this.#scheduled || this.#queue.length === 0) return;
    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      for (const run of this.#queue.splice(0)) run();
      this.#schedule();
    }, 0);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === WS_CLOSED || this.readyState === WS_CLOSING) return;
    if (code !== undefined && !sendableCloseCode(code)) {
      throw new TypeError('First argument must be a valid error code number');
    }
    if (this.#link === null) {
      this.terminate();
      return;
    }
    this.readyState = WS_CLOSING;
    this.#link.close(code, reason ?? '');
  }

  terminate(): void {
    if (this.#finished) return;
    // The connection drops: the server end sees 1006, this end reports 1006.
    this.#link?.close(1006, '');
    this.readyState = WS_CLOSING;
    this.#later(() => this.#finish(1006, ''));
  }
}

// ---------------------------------------------------------------------------
// The server

export function jetstreamServer(o: JetstreamServerOptions): JetstreamServer {
  const fakes =
    o.fakes ??
    (o.hosts ?? [HARNESS_JETSTREAM_HOST]).map(
      (host) =>
        new FakeJetstream({
          host,
          clock: o.clock,
          ...(o.lookbackHours === undefined ? {} : { lookbackHours: o.lookbackHours }),
        }),
    );
  const byHost = new Map(fakes.map((f) => [f.host.toLowerCase(), f]));
  const attempts: ConnectAttempt[] = [];
  const connections: FakeJetstreamConnection[] = [];
  const dial = memoryLink(fakes);
  /** Only the served hosts are on the connector's allow-list (JETSTREAM_URLS). */
  const jetstreamUrls = fakes.map((f) => `wss://${f.host}`);

  const links: Array<{ severed: boolean }> = [];
  const connect: ConnectJetstream = async (url) => {
    let attempt: ConnectAttempt | null = null;
    try {
      const parsed = new URL(url);
      const raw = parsed.searchParams.get('cursor');
      attempt = { url: parsed, host: parsed.hostname, cursor: raw === null ? null : Number(raw), status: 0 };
      attempts.push(attempt);
    } catch {
      // An invalid URL: the connector refuses it before anything is dialled.
    }
    const fake = attempt === null ? undefined : byHost.get(attempt.host.toLowerCase());
    const before = fake?.connections.length ?? 0;
    const hooks: ClientHooks = {
      dial,
      answered(status) {
        if (attempt !== null) attempt.status = status;
      },
      settled() {
        if (fake !== undefined) connections.push(...fake.connections.slice(before));
      },
    };
    const WebSocket = class extends MemoryWsClient {
      constructor(address: string, options: ClientOptions) {
        super(address, options, hooks);
      }
    } as unknown as WsClientCtor;
    const inner = await connectJetstreamWs(url, { jetstreamUrls, WebSocket });
    const entry = { severed: false };
    links.push(entry);
    return {
      url: inner.url,
      start: (onEvent) =>
        inner.start((e) => {
          if (!entry.severed) onEvent(e);
        }),
      close: (code, reason) => inner.close(code, reason),
    };
  };

  return {
    fakes,
    at(host) {
      const f = byHost.get(host.toLowerCase());
      if (f === undefined) throw new Error(`fixture: no Jetstream host ${host}`);
      return f;
    },
    connect,
    attempts,
    append(input) {
      let first: JetstreamEvent | undefined;
      for (const f of fakes) {
        const e = f.append(input);
        first ??= e;
      }
      return first!;
    },
    live: () => connections.filter((c) => !c.closed),
    last() {
      const c = connections.at(-1);
      if (c === undefined) throw new Error('fixture: no Jetstream connection yet');
      return c;
    },
    sever() {
      for (const l of links) l.severed = true;
      for (const c of connections) c.close(1001, 'instance torn down');
    },
  };
}

/** Let queued socket events and microtasks run (no clock involved). */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// ModuleDeps for the ingest socket suites

/** Zero jitter, for the exact reconnect-delay assertions (ADR §10.2). */
export const zeroJitter: Random = { bytes: (n) => new Uint8Array(n), float: () => 0 };

export interface IngestTestDeps extends ModuleDeps {
  log: Logger & { entries: Array<{ level: LogLevel; event: string; fields?: Record<string, unknown> }> };
}

export interface IngestDepsOptions {
  mode?: IngestMode;
  /** Bare Jetstream host names, in JETSTREAM_URLS order. */
  hosts?: readonly string[];
  random?: Random;
  lookbackHours?: number;
  prefix?: string;
}

/**
 * ModuleDeps over the given Db for the socket and mode suites: the harness
 * config (fixture prefix; worker/test/node/support/with-index.ts
 * `HARNESS_ENV`) with the given mode and hosts. Nothing in these suites
 * resolves identities or fetches proofs, so `transport` and `identity` reject.
 */
export function ingestDeps(db: Db, clock: Clock, o: IngestDepsOptions = {}): IngestTestDeps {
  const base = harnessConfig({
    ADMIN_TOKEN: '',
    ...(o.prefix === undefined ? {} : { LEXICON_PREFIX: o.prefix }),
    ...(o.mode === undefined ? {} : { INGEST_MODE: o.mode }),
    ...(o.hosts === undefined ? {} : { JETSTREAM_URLS: o.hosts.map((h) => `wss://${h}`).join(',') }),
    ...(o.lookbackHours === undefined ? {} : { JETSTREAM_LOOKBACK_HOURS: String(o.lookbackHours) }),
  });
  const entries: IngestTestDeps['log']['entries'] = [];
  const unused = (what: string) => () => Promise.reject(new Error(`ingest socket suites never call ${what}`));
  return {
    db,
    clock,
    random: o.random ?? zeroJitter,
    transport: unused('transport'),
    identity: { resolveDid: unused('resolveDid'), resolveHandle: unused('resolveHandle') },
    config: base,
    log: {
      entries,
      log(level, event, fields) {
        entries.push(fields === undefined ? { level, event } : { level, event, fields });
      },
    },
  };
}

/** The `jetstream` checkpoint row as stored. */
export function checkpointRow(db: Db) {
  return db.one<{
    cursor: number | null;
    last_event_time_us: number | null;
    connected: number;
    pending_gap: number;
    gap_scan_after_did: string | null;
    mode: string | null;
    host_index: number;
    connected_at_ms: number | null;
    updated_at_ms: number;
  }>("SELECT * FROM ingest_checkpoint WHERE stream = 'jetstream'")!;
}
