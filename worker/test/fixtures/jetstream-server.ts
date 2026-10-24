// Adapts the W1-05 fake Jetstream (packages/atproto/test-support/fake-jetstream.ts)
// to a WebSocketPair connector for the ingest socket. TEST-ONLY.
//
// `jetstreamServer({...})` serves one FakeJetstream per host. The connector it
// returns is the production one (`createJetstreamConnector` from
// worker/src/do/ingest/jetstream-socket.ts: `fetch(url, {Upgrade:
// 'websocket'})`, then `resp.webSocket.accept()`) over an in-memory fetch that
// routes by host to the fakes, so the production upgrade, status and accept
// handling run unchanged. An unknown host rejects like a failed DNS lookup:
// nothing can reach the real network.
//
// `append` mirrors one event into every host's log (as every Jetstream instance
// follows the same firehose), so seqs agree across hosts.
//
// Sockets belong to the Durable Object that opened them: drive the fake (send,
// close, append) only inside runInDurableObject for that DO.
//
// Instance death. An open outbound WebSocket holds a Durable Object (workerd
// refuses a graceful eviction: "still has active references"); in production
// a deploy or runtime update tears the instance down with its socket. `sever()`
// stands in for that: every link handed out stops delivering events (a dead
// instance runs no handler) and the fake drops the server ends, which releases
// the sockets so `evictDurableObject` can proceed. It is fault injection at the
// connector interface only; the production link and socket code are unchanged.

import { env } from 'cloudflare:workers';
import {
  FakeJetstream,
  type FakeJetstreamConnection,
  type JetstreamEvent,
  type JetstreamEventInput,
} from '@atmusic/atproto/test-support/fake-jetstream';
import type { Clock, Random } from '@atmusic/core/deps';
import { type IngestMode, parseConfig } from '../../src/config';
import type { Logger, LogLevel, ModuleDeps } from '../../src/do/contracts';
import type { Db } from '../../src/do/db';
import { type ConnectJetstream, createJetstreamConnector } from '../../src/do/ingest/jetstream-socket';

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
  /** The owning instance dies: its links go silent and the server ends close (call inside that DO). */
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

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const raw = url.searchParams.get('cursor');
    const attempt: ConnectAttempt = { url, host: url.hostname, cursor: raw === null ? null : Number(raw), status: 0 };
    attempts.push(attempt);
    const fake = byHost.get(url.hostname.toLowerCase());
    if (fake === undefined) throw new TypeError(`fixture: no Jetstream at ${url.hostname} (DNS failure)`);
    const before = fake.connections.length;
    const res = await fake.fetch(req);
    attempt.status = res.status;
    connections.push(...fake.connections.slice(before));
    return res;
  };

  const production = createJetstreamConnector({ fetch: route });
  const links: Array<{ severed: boolean }> = [];
  const connect: ConnectJetstream = async (url) => {
    const inner = await production(url);
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

/** Let queued WebSocket events and microtasks run (no clock involved). */
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
 * ModuleDeps over the harness DO's Db for the socket and mode suites: the
 * harness config (fixture prefix) with the given mode and hosts. Nothing in
 * these suites resolves identities or fetches proofs, so `transport` and
 * `identity` reject.
 */
export function ingestDeps(db: Db, clock: Clock, o: IngestDepsOptions = {}): IngestTestDeps {
  const base = parseConfig(
    {
      ...env,
      ADMIN_TOKEN: '',
      ...(o.prefix === undefined ? {} : { LEXICON_PREFIX: o.prefix }),
      ...(o.mode === undefined ? {} : { INGEST_MODE: o.mode }),
      ...(o.hosts === undefined ? {} : { JETSTREAM_URLS: o.hosts.map((h) => `wss://${h}`).join(',') }),
      ...(o.lookbackHours === undefined ? {} : { JETSTREAM_LOOKBACK_HOURS: String(o.lookbackHours) }),
    },
    { allowFixturePrefix: true },
  );
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
