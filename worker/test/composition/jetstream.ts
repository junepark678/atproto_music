// The fake Jetstream as a Node connector for the composition, acceptance and
// bench suites (ADR 0005 §3.4, §15.2; N4-03). TEST-ONLY.
//
// `jetstreamServer({...})` serves one FakeJetstream per host through
// `memoryLink` (packages/atproto/test-support/fake-jetstream.ts, N1-04): each
// connect runs the fake's own handshake (fault queue, call log, cursor and
// lookback checks) over an in-memory socket pair and hands the ingest socket a
// link that buffers its events until `start()`, as the production connectors
// do. A refusal rejects with the production `JetstreamConnectError`, so the
// ingest socket's `cursorRejected` and backoff handling run unchanged. An
// unknown host rejects like a failed DNS lookup: nothing reaches a network.
//
// The API is the one the workerd suites used (worker/test/fixtures/
// jetstream-server.ts, which N4-04 de-shims separately): `attempts`, `live`,
// `last`, `append` (mirrored into every host's log, so seqs agree), and
// `sever()` — the process dies with its socket: every link handed out stops
// delivering events (a dead process runs no handler) and the fake drops the
// server ends. It is fault injection at the ConnectJetstream interface only;
// the production socket code is unchanged.

import {
  FakeJetstream,
  type FakeJetstreamConnection,
  type JetstreamEvent,
  type JetstreamEventInput,
  memoryLink,
} from '@atmusic/atproto/test-support/fake-jetstream';
import type { Clock } from '@atmusic/core/deps';
import { type ConnectJetstream, JetstreamConnectError } from '../../src/do/ingest/jetstream-socket';

export interface ConnectAttempt {
  url: URL;
  host: string;
  /** The `cursor` query parameter, or null for the live tail. */
  cursor: number | null;
  /** 101 for an upgrade, else the refusal status; 0 when the connect failed before any answer. */
  status: number;
}

export interface JetstreamServer {
  readonly fakes: readonly FakeJetstream[];
  at(host: string): FakeJetstream;
  /** The connector compose() is given. */
  readonly connect: ConnectJetstream;
  /** Every connect, in order. */
  readonly attempts: ConnectAttempt[];
  /** Appends one event to every host's log (and its live sockets). */
  append(input: JetstreamEventInput): JetstreamEvent;
  /** Open server-side connections across hosts. */
  live(): FakeJetstreamConnection[];
  /** The most recent connection (any host). */
  last(): FakeJetstreamConnection;
  /** The process dies: its links go silent and the server ends close. */
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
  const inner = memoryLink(fakes, {
    connectError: (status, error, message) => new JetstreamConnectError(status, error, message),
  });
  const attempts: ConnectAttempt[] = [];
  const connections: FakeJetstreamConnection[] = [];
  const links: Array<{ severed: boolean }> = [];

  const connect: ConnectJetstream = async (url) => {
    const parsed = new URL(url);
    const raw = parsed.searchParams.get('cursor');
    const attempt: ConnectAttempt = {
      url: parsed,
      host: parsed.hostname,
      cursor: raw === null ? null : Number(raw),
      status: 0,
    };
    attempts.push(attempt);
    const fake = byHost.get(parsed.hostname.toLowerCase());
    const before = fake?.connections.length ?? 0;
    let link: Awaited<ReturnType<typeof inner>>;
    try {
      link = await inner(url);
    } catch (error) {
      if (error instanceof JetstreamConnectError) attempt.status = error.status ?? 0;
      throw error;
    }
    attempt.status = 101;
    if (fake !== undefined) connections.push(...fake.connections.slice(before));
    const entry = { severed: false };
    links.push(entry);
    return {
      url: link.url,
      start: (onEvent) =>
        link.start((e) => {
          if (!entry.severed) onEvent(e);
        }),
      close: (code, reason) => link.close(code, reason),
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
      return first as JetstreamEvent;
    },
    live: () => connections.filter((c) => !c.closed),
    last() {
      const c = connections.at(-1);
      if (c === undefined) throw new Error('fixture: no Jetstream connection yet');
      return c;
    },
    sever() {
      for (const l of links) l.severed = true;
      for (const c of connections) c.close(1001, 'process died');
    },
  };
}

/** Lets queued socket events and microtasks run (no clock involved). */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
