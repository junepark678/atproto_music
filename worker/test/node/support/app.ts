// The in-process app harness of the worker-node route tests (ADR 0005 §15.1,
// §15.2; N2-01). Wave-3 route packages mount their RouteDefs and Features
// with it:
//
//   const app = await startApp({ routes: myRoutes, transport: routerTransport({...}) });
//   const res = await app.fetch('/api/v1/meta');
//   ...
//   await app.close();          // or closeApps() in afterEach
//
// startApp builds the real composition (worker/src/node/compose.ts) over:
// - a fresh temporary directory holding a migrated database file (opened with
//   the test busy timeout), the release root and its `web/dist`;
// - a NodeConfig from the real parseNodeConfig with the test-only
//   `fixtureOrigins` and `allowFixturePrefix` options: public origin
//   https://music.example.test, listen 127.0.0.1:0, LEXICON_PREFIX the fixture
//   prefix, INGEST_MODE off, client-IP mode none (overridable through `env`);
// - secrets from the real parseSecrets over a document of deterministic test
//   keys (`testSecretsDocument`);
// - the fixture transport (default: a router with no hosts, so any outbound
//   request fails like a failed DNS lookup and never reaches a network), a
//   Jetstream connector that refuses every connect, fixedClock and a seeded
//   Random;
// - manual timers: the scheduler's timers are recorded and never fire on
//   their own, so nothing runs behind a test's back (`timers.pending()` lists
//   what is armed);
// - a capturing logger: the real redacting JSON-line logger writing into
//   `logs` (parsed) and `lines` (raw).
// The app listens on 127.0.0.1:0 through the real HTTP bridge; `fetch(path)`
// sends a request to it (the Host is the bound address, which the bridge
// accepts as the listen address).

import { createECDH, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import type { Transport } from '@atmusic/atproto/transport';
import type { Clock, Random } from '@atmusic/core/deps';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { createLogger } from '../../../src/app/index-core';
import { FIXTURE_PREFIX } from '../../../src/config';
import type { Db } from '../../../src/do/db';
import type { ConnectJetstream } from '../../../src/do/ingest/jetstream-socket';
import { JetstreamConnectError } from '../../../src/do/ingest/jetstream-socket';
import { migrate } from '../../../src/do/migrate';
import type { RouteDef } from '../../../src/http/types';
import type { HostTimers, TimerHandle } from '../../../src/node/alarm';
import { type ComposedApp, compose, type Feature } from '../../../src/node/compose';
import { type NodeConfig, type NodeEnv, parseNodeConfig } from '../../../src/node/config';
import { type BoundAddress, type BridgeServer, createServer } from '../../../src/node/http-bridge';
import { parseSecrets, type Secrets } from '../../../src/node/secrets';
import { openSqliteDb, type SqliteDb } from '../../../src/node/sqlite-db';
import { TEST_BUSY_TIMEOUT_MS } from './node-db';

export const TEST_PUBLIC_ORIGIN = 'https://music.example.test';
export const TEST_SIGNIN_DID = 'did:plc:abcdefghijklmnopqrstuvwx';

/** The minimal SPA the harness writes into `<release>/web/dist` unless `dist` is given. */
export const DEFAULT_DIST: Readonly<Record<string, string>> = {
  'index.html': '<!doctype html><title>atmusic</title><script type="module" src="/assets/app.js"></script>',
  'assets/app.js': 'console.log("atmusic");',
};

// ---------------------------------------------------------------------------
// Secrets

export interface TestJwk {
  kty: 'EC';
  crv: 'P-256';
  kid: string;
  d: string;
  x: string;
  y: string;
}

/** A P-256 private JWK derived deterministically from `seed`. */
export function testJwk(kid: string, seed: string): TestJwk {
  const d = createHash('sha256').update(seed).digest();
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  return {
    kty: 'EC',
    crv: 'P-256',
    kid,
    d: d.toString('base64url'),
    x: point.subarray(1, 33).toString('base64url'),
    y: point.subarray(33, 65).toString('base64url'),
  };
}

/** A valid secrets document (ADR 0005 §3.8) of deterministic test values. */
export function testSecretsDocument(): Record<string, unknown> {
  return {
    cursorKey: Buffer.alloc(32, 0x5a).toString('base64'),
    encryptionKeys: [{ id: 'e1', key: Buffer.alloc(32, 0x3c).toString('base64') }],
    oauthSigningKeys: [testJwk('k1', 'atmusic test signing key one')],
  };
}

/** `testSecretsDocument()` through the real parseSecrets. */
export function testSecrets(): Secrets {
  return parseSecrets(testSecretsDocument());
}

// ---------------------------------------------------------------------------
// Timers and logs

interface ManualTimer extends TimerHandle {
  readonly kind: 'timeout' | 'interval';
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
}

export interface ManualTimers extends HostTimers {
  /** Every timer ever created, cleared ones included. */
  readonly all: readonly ManualTimer[];
  /** Timers not yet cleared. */
  pending(): ManualTimer[];
}

/** HostTimers that record and never fire on their own. */
export function manualTimers(): ManualTimers {
  const all: ManualTimer[] = [];
  const create = (kind: ManualTimer['kind'], callback: () => void, delayMs: number): ManualTimer => {
    const timer: ManualTimer = { kind, callback, delayMs, cleared: false, unref: () => timer };
    all.push(timer);
    return timer;
  };
  const clear = (handle: TimerHandle) => {
    (handle as ManualTimer).cleared = true;
  };
  return {
    all,
    pending: () => all.filter((t) => !t.cleared),
    setTimeout: (callback, delayMs) => create('timeout', callback, delayMs),
    clearTimeout: clear,
    setInterval: (callback, intervalMs) => create('interval', callback, intervalMs),
    clearInterval: clear,
  };
}

export type LogLine = Record<string, unknown> & { level: string; event: string };

export interface CapturedLog {
  /** Raw lines exactly as the logger wrote them. */
  readonly lines: string[];
  /** The same lines parsed. */
  readonly logs: LogLine[];
  readonly logger: ReturnType<typeof createLogger>;
}

/** The production logger writing into memory. */
export function captureLog(secrets: readonly string[] = []): CapturedLog {
  const lines: string[] = [];
  const logs: LogLine[] = [];
  const push = (line: string) => {
    lines.push(line);
    logs.push(JSON.parse(line) as LogLine);
  };
  return { lines, logs, logger: createLogger(secrets, { log: push, warn: push, error: push }) };
}

// ---------------------------------------------------------------------------
// The app

/** A Jetstream connector that refuses every connect and counts the attempts. */
export function refusingJetstream(): ConnectJetstream & { attempts: string[] } {
  const attempts: string[] = [];
  const connect: ConnectJetstream = async (url) => {
    attempts.push(url);
    throw new JetstreamConnectError(null, null, 'jetstream connect refused by the test harness');
  };
  return Object.assign(connect, { attempts });
}

export interface StartAppOptions {
  /** Routes mounted as one extra feature (`test-routes`). */
  routes?: readonly RouteDef[];
  features?: readonly Feature[];
  clock?: Clock;
  /** Default: a router transport with no hosts. */
  transport?: Transport;
  connectJetstream?: ConnectJetstream;
  random?: Random;
  /**
   * Files of `<release>/web/dist` (path → content, `_headers` included), or
   * null for no dist directory at all. Default DEFAULT_DIST.
   */
  dist?: Readonly<Record<string, string | Uint8Array>> | null;
  /** Environment overrides (undefined removes a default). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Default: testSecrets(). */
  secrets?: Secrets;
  /** Wraps the database handed to compose (fault injection through the Db interface). */
  wrapDb?: (db: SqliteDb) => Db;
  /** Default: never low. */
  diskLow?: () => boolean;
}

export interface TestApp {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  readonly address: BoundAddress;
  readonly composed: ComposedApp;
  readonly config: NodeConfig;
  readonly secrets: Secrets;
  readonly db: SqliteDb;
  /** The temporary release root (also STATE_DIRECTORY's parent); removed by close(). */
  readonly dir: string;
  /** `<dir>/web/dist`. */
  readonly distDir: string;
  readonly transport: Transport;
  readonly clock: Clock;
  readonly timers: ManualTimers;
  readonly log: CapturedLog;
  /** Sends `init` to `path` (path and query) on the running app. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Stops the listener, the timers and the database, and removes the directory. Idempotent. */
  close(): Promise<void>;
}

const running = new Set<TestApp>();

function writeFiles(root: string, files: Readonly<Record<string, string | Uint8Array>>): void {
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** The harness environment for a release root `dir`. */
export function testEnv(dir: string): Record<string, string | undefined> {
  return {
    ATMUSIC_PUBLIC_ORIGIN: TEST_PUBLIC_ORIGIN,
    ATMUSIC_LISTEN: '127.0.0.1:0',
    ATMUSIC_CLIENT_IP_HEADER: 'none',
    ATMUSIC_SIGNIN_DIDS: TEST_SIGNIN_DID,
    STATE_DIRECTORY: join(dir, 'state'),
    XDG_RUNTIME_DIR: join(dir, 'run'),
    LEXICON_PREFIX: FIXTURE_PREFIX,
    NAMESPACE_OWNERSHIP_REF: '',
    INGEST_MODE: 'off',
    JETSTREAM_URLS: 'wss://jetstream.example.test',
    JETSTREAM_LOOKBACK_HOURS: '24',
    RELAY_URL: 'https://relay.example.test',
  };
}

export async function startApp(options: StartAppOptions = {}): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-app-'));
  let db: SqliteDb | null = null;
  let composed: ComposedApp | null = null;
  let bridge: BridgeServer | null = null;
  try {
    const distDir = join(dir, 'web', 'dist');
    if (options.dist !== null) writeFiles(distDir, options.dist ?? DEFAULT_DIST);
    const env: NodeEnv = { ...testEnv(dir), ...options.env };
    const config = parseNodeConfig(env, { fixtureOrigins: true, allowFixturePrefix: true, releaseRoot: dir });
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = openSqliteDb(config.dbPath, { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS, create: true });
    const migration = migrate(db);
    if (migration.status !== 'ready') throw new Error(`test database did not migrate: ${JSON.stringify(migration)}`);

    const secrets = options.secrets ?? testSecrets();
    const clock = options.clock ?? fixedClock();
    const random = options.random ?? seededRandom(0x5eed);
    const transport: Transport = options.transport ?? (routerTransport({}) as FixtureTransport);
    const timers = manualTimers();
    const log = captureLog([Buffer.from(secrets.cursorKey).toString('base64')]);
    const features: Feature[] = [...(options.features ?? [])];
    if (options.routes !== undefined) features.push({ name: 'test-routes', routes: options.routes });

    composed = await compose(config, secrets, {
      db: options.wrapDb ? options.wrapDb(db) : db,
      transport,
      connectJetstream: options.connectJetstream ?? refusingJetstream(),
      features,
      clock,
      random,
      log: log.logger,
      timers,
      diskLow: options.diskLow ?? (() => false),
    });
    const handler = composed.handler;
    bridge = createServer({
      publicOrigin: config.publicOrigin,
      listen: config.listen,
      handler,
      random,
    });
    const address = await bridge.start();
    const url = `http://${address.authority}`;

    let closed = false;
    const openDb = db;
    const openComposed = composed;
    const openBridge = bridge;
    const app: TestApp = {
      url,
      address,
      composed,
      config,
      secrets,
      db,
      dir,
      distDir,
      transport,
      clock,
      timers,
      log,
      fetch: (path, init) => fetch(`${url}${path}`, { redirect: 'manual', ...init }),
      async close() {
        if (closed) return;
        closed = true;
        running.delete(app);
        try {
          await openBridge.close();
        } finally {
          openComposed.stop();
          openDb.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
    running.add(app);
    return app;
  } catch (error) {
    await bridge?.close().catch(() => undefined);
    composed?.stop();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Closes every app startApp returned that is still running (for afterEach). */
export async function closeApps(): Promise<void> {
  for (const app of [...running]) await app.close();
}
