// The SIGTERM drain (ADR 0005 §3.10; N3-07), driven through run() in-process
// with an injected exit, signal emitter, notify spawner, a 200 ms drain window
// and real timers (the drain window is a timer), plus createShutdown on its
// own for the production window.

import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_PREFIX } from '../../src/config';
import type { ConnectJetstream, JetstreamLink, LinkEvent } from '../../src/do/ingest/jetstream-socket';
import type { RouteDef } from '../../src/http/types';
import type { HostTimers } from '../../src/node/alarm';
import { nodeTimers } from '../../src/node/alarm';
import { PRODUCTION_DRAIN_MS, parseNodeConfig } from '../../src/node/config';
import { createServer } from '../../src/node/http-bridge';
import { type ExitCode, type RunningServer, run } from '../../src/node/run';
import { createShutdown, DEFAULT_DRAIN_MS, trackRequests } from '../../src/node/shutdown';
import { DatabaseLockedError, openSqliteDb } from '../../src/node/sqlite-db';
import { captureLog, testEnv, testSecretsDocument } from './support/app';
import { TEST_BUSY_TIMEOUT_MS } from './support/node-db';

const ORIGINAL_FETCH = globalThis.fetch;
const DRAIN_MS = 200;
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  globalThis.fetch = ORIGINAL_FETCH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeLink extends JetstreamLink {
  closes: Array<{ code: number | undefined; reason: string | undefined }>;
}

/** A Jetstream connector whose links stay open and record how they are closed. */
function recordingJetstream(): ConnectJetstream & { links: FakeLink[] } {
  const links: FakeLink[] = [];
  const connect: ConnectJetstream = async (url) => {
    let deliver: ((e: LinkEvent) => void) | null = null;
    const link: FakeLink = {
      url,
      closes: [],
      start(onEvent) {
        deliver = onEvent;
      },
      close(code, reason) {
        link.closes.push({ code, reason });
        deliver?.({ type: 'close', code: code ?? 1005, reason: reason ?? '' });
      },
    };
    links.push(link);
    return link;
  };
  return Object.assign(connect, { links });
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}
function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface SlowRoute {
  route: RouteDef;
  entered: Deferred;
  release: Deferred;
  aborted: () => boolean;
}

/** GET /api/v1/test/slow: waits for `release`, then answers 200 `done`. */
function slowRoute(): SlowRoute {
  const entered = deferred();
  const release = deferred();
  let aborted = false;
  return {
    entered,
    release,
    aborted: () => aborted,
    route: {
      method: 'GET',
      pattern: '/api/v1/test/slow',
      handler: async (req) => {
        req.signal.addEventListener('abort', () => {
          aborted = true;
        });
        entered.resolve();
        await release.promise;
        return new Response('done', { status: 200 });
      },
    },
  };
}

interface Started {
  result: Promise<ExitCode>;
  server: RunningServer;
  exits: ExitCode[];
  notes: string[];
  signals: EventEmitter;
  log: ReturnType<typeof captureLog>;
  jetstream: ReturnType<typeof recordingJetstream>;
  dbPath: string;
}

async function startServer(route: RouteDef): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-shutdown-'));
  dirs.push(dir);
  const dist = join(dir, 'web', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html>');
  const secrets = join(dir, 'secrets.json');
  writeFileSync(secrets, JSON.stringify(testSecretsDocument()));
  chmodSync(secrets, 0o600);
  const env = {
    ...testEnv(dir),
    ATMUSIC_ASSETS_DIR: dist,
    ATMUSIC_SECRETS_FILE: secrets,
    INGEST_MODE: 'socket',
    LEXICON_PREFIX: FIXTURE_PREFIX,
    NOTIFY_SOCKET: join(dir, 'notify.sock'),
  };
  const exits: ExitCode[] = [];
  const notes: string[] = [];
  const signals = new EventEmitter();
  const log = captureLog();
  const jetstream = recordingJetstream();
  let ready: (s: RunningServer) => void = () => {};
  const server = new Promise<RunningServer>((resolve) => {
    ready = resolve;
  });
  const result = run({
    argv: ['node', 'main.mjs', '--init'],
    env,
    exit: (code) => exits.push(code),
    clock: fixedClock(),
    random: seededRandom(7),
    busyTimeoutMs: TEST_BUSY_TIMEOUT_MS,
    drainMs: DRAIN_MS,
    log: log.logger,
    stdout: () => {},
    stderr: () => {},
    configOptions: { fixtureOrigins: true, allowFixturePrefix: true },
    transport: routerTransport({}) as FixtureTransport,
    connectJetstream: jetstream,
    timers: nodeTimers,
    signals,
    notifySpawner: async (states) => {
      notes.push(...states);
    },
    features: [{ name: 'test-slow', routes: [route] }],
    onReady: (s) => ready(s),
  });
  const started = await Promise.race([server, result.then((code) => Promise.reject(new Error(`run exited ${code}`)))]);
  cleanups.push(async () => {
    await started.shutdown('SIGTERM');
    await result;
  });
  // Ingestion is on: the Jetstream watchdog, due at start, opens a link.
  const deadline = Date.now() + 5_000;
  while (jetstream.links.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  return { result, server: started, exits, notes, signals, log, jetstream, dbPath: join(dir, 'state', 'atmusic.db') };
}

interface Answer {
  status: number;
  body: string;
}

/** A GET on its own connection; rejects when the connection is reset. */
function get(port: number, path: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` }, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** True when another connection can take the database lock (the server closed it). */
function databaseReleased(path: string): boolean {
  try {
    openSqliteDb(path, { busyTimeoutMs: 50 }).close();
    return true;
  } catch (error) {
    if (error instanceof DatabaseLockedError) return false;
    throw error;
  }
}

describe('shutdown', () => {
  it('SIGTERM closes the listener, lets an in-flight request finish within the injected drain window, closes Jetstream with 1000, closes the database and calls exit(0)', async () => {
    const slow = slowRoute();
    const s = await startServer(slow.route);
    const port = s.server.address.port;
    expect(s.jetstream.links).toHaveLength(1);
    expect(s.jetstream.links[0]?.closes).toEqual([]);
    expect(databaseReleased(s.dbPath)).toBe(false);

    const inFlight = get(port, '/api/v1/test/slow');
    await slow.entered.promise;
    const signalledAt = Date.now();
    s.signals.emit('SIGTERM');
    // The listener closes at once: new connections are refused.
    const deadline = Date.now() + 1_000;
    while ((await accepts(port)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(await accepts(port)).toBe(false);
    expect(s.exits).toEqual([]);
    // The request finishes inside the window.
    await new Promise((r) => setTimeout(r, 50));
    slow.release.resolve();
    expect(await inFlight).toEqual({ status: 200, body: 'done' });
    expect(await s.result).toBe(0);
    expect(Date.now() - signalledAt).toBeLessThan(DRAIN_MS + 2_000);
    expect(s.exits).toEqual([0]);
    expect(slow.aborted()).toBe(false);
    expect(s.jetstream.links[0]?.closes.map((c) => c.code)).toEqual([1000]);
    expect(databaseReleased(s.dbPath)).toBe(true);
    expect(s.notes).toContain('STOPPING=1');
    expect(s.notes.indexOf('READY=1')).toBeLessThan(s.notes.indexOf('STOPPING=1'));
    const events = s.log.logs.map((l) => l.event);
    expect(events).toContain('shutdown.completed');
    expect(s.log.logs.find((l) => l.event === 'shutdown.completed')?.drained).toBe(true);
    expect(events).not.toContain('shutdown.drain_expired');
    // The order: listener, Jetstream, database.
    expect(events.indexOf('shutdown.started')).toBeLessThan(events.indexOf('sqlite.closed'));
    expect(events.indexOf('sqlite.closed')).toBeLessThan(events.indexOf('shutdown.completed'));
  });

  it('a request still running when the injected drain window ends after SIGTERM is aborted, the database is closed and exit(0) is called; the production drain window is 25 s', async () => {
    const slow = slowRoute();
    const s = await startServer(slow.route);
    cleanups.push(async () => slow.release.resolve());
    const port = s.server.address.port;
    const inFlight = get(port, '/api/v1/test/slow').then(
      (answer) => ({ ok: true as const, answer }),
      (error: NodeJS.ErrnoException) => ({ ok: false as const, code: error.code }),
    );
    await slow.entered.promise;
    const signalledAt = Date.now();
    s.signals.emit('SIGTERM');
    expect(await s.result).toBe(0);
    const elapsed = Date.now() - signalledAt;
    expect(elapsed).toBeGreaterThanOrEqual(DRAIN_MS - 5);
    expect(elapsed).toBeLessThan(DRAIN_MS + 3_000);
    expect(s.exits).toEqual([0]);
    // The handler saw its signal abort and the client its connection reset.
    expect(slow.aborted()).toBe(true);
    const outcome = await inFlight;
    expect(outcome.ok).toBe(false);
    expect(['ECONNRESET', 'ECONNREFUSED', 'EPIPE']).toContain(outcome.ok ? '' : outcome.code);
    expect(databaseReleased(s.dbPath)).toBe(true);
    expect(s.jetstream.links[0]?.closes.map((c) => c.code)).toEqual([1000]);
    const expired = s.log.logs.find((l) => l.event === 'shutdown.drain_expired');
    expect(expired).toMatchObject({ inFlight: 1, drainMs: DRAIN_MS });
    expect(s.log.logs.find((l) => l.event === 'shutdown.completed')?.drained).toBe(false);

    // The production window: 25 s, the default of both the config and the drain.
    expect(PRODUCTION_DRAIN_MS).toBe(25_000);
    expect(DEFAULT_DRAIN_MS).toBe(25_000);
    expect(
      parseNodeConfig(
        { ...testEnv('/srv/atmusic'), ATMUSIC_LISTEN: '127.2.0.1:8888' },
        { fixtureOrigins: true, allowFixturePrefix: true, releaseRoot: '/srv/atmusic' },
      ).drainMs,
    ).toBe(25_000);
    // createShutdown without drainMs arms a 25 000 ms drain timer.
    const delays: number[] = [];
    const recording: HostTimers = {
      ...nodeTimers,
      setTimeout: (callback, delayMs) => {
        delays.push(delayMs);
        return nodeTimers.setTimeout(callback, delayMs === 25_000 ? 0 : delayMs);
      },
    };
    // One request held open, so the drain waits for the timer.
    const held = deferred();
    const bridge = createServer({
      publicOrigin: 'https://music.example.test',
      listen: { host: '127.0.0.1', port: 0 },
      handler: async () => {
        await held.promise;
        return new Response('x');
      },
    });
    await bridge.start();
    const tracker = trackRequests(bridge.server);
    const exits: number[] = [];
    const pending = get(bridge.address?.port ?? 0, '/').catch(() => null);
    while (tracker.active() === 0) await new Promise((r) => setTimeout(r, 2));
    await createShutdown({
      server: bridge,
      tracker,
      notifier: { stopping: async () => {}, flush: async () => {} },
      timers: recording,
      log: captureLog().logger,
      exit: (code) => exits.push(code),
      closeJetstream: () => {},
      stopTimers: async () => {},
      closeServices: async () => {},
      closeDb: () => {},
    }).shutdown();
    held.resolve();
    await pending;
    expect(delays[0]).toBe(25_000);
    expect(exits).toEqual([0]);
  });
});
