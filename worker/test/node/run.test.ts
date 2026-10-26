// run() (ADR 0005 §3.2, §3.5, §3.6, §3.8, §3.10; N3-07), driven in-process
// with an injected exit, frozen clock, seeded randomness, manual timers, a
// signal emitter, a 200 ms busy timeout and drain window, the empty fixture
// router transport and a refusing Jetstream connector. The one test that needs
// a real inherited socket at fd 3 bundles a tiny entry that imports run.ts
// with esbuild and runs it under plain node, as systemd would.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { connect, createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/do/migrate';
import { MIGRATIONS } from '../../src/do/schema';
import { readSchemaState } from '../../src/node/compose';
import { FORBIDDEN_RUNTIME_ENV } from '../../src/node/config';
import type { BridgeOptions, BridgeServer, ListenTarget } from '../../src/node/http-bridge';
import { createServer } from '../../src/node/http-bridge';
import { isTransportError } from '../../src/node/pinned-transport';
import { type ExitCode, type RunningServer, type RunOptions, run } from '../../src/node/run';
import { openSqliteDb } from '../../src/node/sqlite-db';
import { captureLog, manualTimers, refusingJetstream, testEnv, testSecretsDocument } from './support/app';
import { TEST_BUSY_TIMEOUT_MS } from './support/node-db';

const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL_FETCH = globalThis.fetch;
const dirs: string[] = [];
const running: Array<{ result: Promise<ExitCode>; server: Promise<RunningServer> }> = [];
const netServers: NetServer[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    const server = await Promise.race([r.server, r.result.then(() => null)]).catch(() => null);
    if (server !== null) await server.shutdown('SIGTERM');
    await r.result;
  }
  for (const s of netServers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
  globalThis.fetch = ORIGINAL_FETCH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  dir: string;
  env: Record<string, string | undefined>;
  dbPath: string;
}

/** A release root with web/dist and a 0600 secrets file, and the harness environment. */
function fixture(options: { dist?: Record<string, string>; env?: Record<string, string | undefined> } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-run-'));
  dirs.push(dir);
  const dist = join(dir, 'web', 'dist');
  for (const [path, content] of Object.entries(options.dist ?? { 'index.html': '<!doctype html><title>t</title>' })) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  const secrets = join(dir, 'secrets.json');
  writeFileSync(secrets, JSON.stringify(testSecretsDocument()));
  chmodSync(secrets, 0o600);
  const env = { ...testEnv(dir), ATMUSIC_ASSETS_DIR: dist, ATMUSIC_SECRETS_FILE: secrets, ...options.env };
  return { dir, env, dbPath: join(dir, 'state', 'atmusic.db') };
}

interface Started {
  result: Promise<ExitCode>;
  server: Promise<RunningServer>;
  exits: ExitCode[];
  stderr: string[];
  log: ReturnType<typeof captureLog>;
  signals: EventEmitter;
}

function start(env: Record<string, string | undefined>, args: string[], extra: Partial<RunOptions> = {}): Started {
  const exits: ExitCode[] = [];
  const stderr: string[] = [];
  const log = captureLog();
  const signals = new EventEmitter();
  let onReady: (s: RunningServer) => void = () => {};
  const server = new Promise<RunningServer>((resolve) => {
    onReady = resolve;
  });
  const result = run({
    argv: ['node', 'main.mjs', ...args],
    env,
    exit: (code) => exits.push(code),
    clock: fixedClock(),
    random: seededRandom(0x5eed),
    busyTimeoutMs: TEST_BUSY_TIMEOUT_MS,
    drainMs: 200,
    log: log.logger,
    stdout: () => {},
    stderr: (text) => stderr.push(text),
    configOptions: { fixtureOrigins: true, allowFixturePrefix: true },
    transport: routerTransport({}) as FixtureTransport,
    connectJetstream: refusingJetstream(),
    timers: manualTimers(),
    signals,
    onReady: (s) => onReady(s),
    ...extra,
  });
  const started = { result, server, exits, stderr, log, signals };
  running.push({ result, server });
  return started;
}

interface HttpAnswer {
  status: number;
  body: string;
}

function get(port: number, path: string, host = `127.0.0.1:${port}`): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Resolves true when a TCP connection to the port is accepted, false when refused. */
function accepts(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function freePort(host = '127.0.0.1'): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A database at migration 1 only, padded with `pages` pages of rows, closed. */
function legacyDatabase(path: string, pages: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = openSqliteDb(path, { create: true, busyTimeoutMs: TEST_BUSY_TIMEOUT_MS });
  try {
    expect(migrate(db, MIGRATIONS.slice(0, 1))).toEqual({ status: 'ready', version: 1 });
    db.run('CREATE TABLE padding (x BLOB NOT NULL)');
    db.tx(() => {
      for (let i = 0; i < pages; i++) db.run('INSERT INTO padding (x) VALUES (randomblob(3900))');
    });
  } finally {
    db.close();
  }
}

/** A BridgeServer that records its listen target and refuses to bind (never binds anything). */
function refusingServerFactory(targets: ListenTarget[]): (options: BridgeOptions) => BridgeServer {
  return (options) => {
    targets.push(options.listen);
    const bridge = createServer({ ...options, listen: { host: '127.0.0.1', port: 0 } });
    return {
      server: bridge.server,
      get address() {
        return null;
      },
      start: () => Promise.reject(new Error('test: the listen target was recorded, nothing is bound')),
      close: () => bridge.close(),
    };
  };
}

describe('run()', () => {
  it('migrations finish before listen: the port accepts no connection until the database is migrated', async () => {
    const port = await freePort();
    const f = fixture({ env: { ATMUSIC_LISTEN: `127.0.0.1:${port}` } });
    // A database at version 1, large enough that the pre-migration backup
    // spans many event-loop turns.
    legacyDatabase(f.dbPath, 1500);
    expect(await accepts(port)).toBe(false);

    // The log events already written when run() asks the bridge to bind.
    let atListen: string[] | null = null;
    const attempts: Array<{ accepted: boolean; migrated: boolean }> = [];
    let migrated = false;
    const factory = (options: BridgeOptions): BridgeServer => {
      const bridge = createServer(options);
      return {
        server: bridge.server,
        get address() {
          return bridge.address;
        },
        start: () => {
          atListen = started.log.logs.map((l) => l.event);
          return bridge.start();
        },
        close: () => bridge.close(),
      };
    };
    const started: Started = start(f.env, [], { serverFactory: factory });
    // Connection attempts while run() starts up.
    let stop = false;
    const prober = (async () => {
      while (!stop) {
        migrated = started.log.logs.some((l) => l.event === 'run.migrated');
        attempts.push({ accepted: await accepts(port), migrated });
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const server = await started.server;
    stop = true;
    await prober;

    // The pre-migration backup and the migration were both done before the bind.
    const before = (atListen ?? []).filter((e) => e === 'backup.completed' || e === 'run.migrated');
    expect(before).toEqual(['backup.completed', 'run.migrated']);
    expect(started.log.logs.filter((l) => l.event === 'run.migrated').length).toBe(1);
    // Every attempt before the migration was logged was refused, and there were some.
    const beforeMigration = attempts.filter((a) => !a.migrated);
    expect(beforeMigration.length).toBeGreaterThan(0);
    expect(beforeMigration.every((a) => !a.accepted)).toBe(true);
    // After ready the database is at the latest version and the port answers.
    expect(readSchemaState(server.db)).toEqual({ status: 'ready', version: MIGRATIONS.length });
    expect(server.address.port).toBe(port);
    const ready = await get(port, '/health/ready');
    expect([ready.status, JSON.parse(ready.body)]).toEqual([200, { status: 'ready' }]);
  }, 30_000);

  it('an inherited LISTEN_FDS socket wins over ATMUSIC_LISTEN, which wins over the 127.2.0.1:8888 default', async () => {
    // 1. In-process: the target run() asks the bridge for, by precedence.
    const targets: ListenTarget[] = [];
    const f1 = fixture({ env: { ATMUSIC_LISTEN: '127.0.0.1:0', LISTEN_FDS: '1', LISTEN_PID: '4242' } });
    const fd = start(f1.env, ['--init'], { pid: 4242, serverFactory: refusingServerFactory(targets) });
    expect(await fd.result).toBe(1);
    expect(targets).toEqual([{ fd: 3 }]);

    // LISTEN_FDS meant for another process (LISTEN_PID differs): ATMUSIC_LISTEN, really bound.
    const f2 = fixture({ env: { ATMUSIC_LISTEN: '127.0.0.1:0', LISTEN_FDS: '1', LISTEN_PID: '4243' } });
    const recorded: ListenTarget[] = [];
    const listen = start(f2.env, ['--init'], {
      pid: 4242,
      serverFactory: (options) => {
        recorded.push(options.listen);
        return createServer(options);
      },
    });
    const bound = await listen.server;
    expect(recorded).toEqual([{ host: '127.0.0.1', port: 0 }]);
    expect(bound.address.host).toBe('127.0.0.1');
    expect(bound.address.port).toBeGreaterThan(0);
    expect((await get(bound.address.port, '/health/ready')).status).toBe(200);

    // Neither: the 127.2.0.1:8888 default (recorded, never bound by this test).
    const f3 = fixture({ env: { ATMUSIC_LISTEN: undefined } });
    const defaults: ListenTarget[] = [];
    const fallback = start(f3.env, ['--init'], { serverFactory: refusingServerFactory(defaults) });
    expect(await fallback.result).toBe(1);
    expect(defaults).toEqual([{ host: '127.2.0.1', port: 8888 }]);

    // 2. A real inherited socket at fd 3 (systemd socket activation): run()
    //    under plain node serves on it, and ATMUSIC_LISTEN's port stays closed.
    const dir = mkdtempSync(join(tmpdir(), 'atmusic-run-fd-'));
    dirs.push(dir);
    await build({
      stdin: {
        contents: `import { run } from ${JSON.stringify(join(WORKER_ROOT, 'src/node/run.ts'))};
const code = await run({
  argv: process.argv,
  // systemd sets LISTEN_PID to the service's own pid.
  env: { ...process.env, LISTEN_PID: String(process.pid) },
  configOptions: { allowFixturePrefix: true },
  busyTimeoutMs: 200,
  drainMs: 200,
  exit: (status) => process.exit(status),
});
process.exit(code);
`,
        resolveDir: WORKER_ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      outfile: join(dir, 'entry.mjs'),
      logLevel: 'silent',
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
      external: ['bufferutil', 'utf-8-validate'],
    });
    const inherited = createNetServer();
    netServers.push(inherited);
    await new Promise<void>((resolve) => inherited.listen(0, '127.0.0.1', () => resolve()));
    const inheritedPort = (inherited.address() as { port: number }).port;
    const configuredPort = await freePort();
    const f4 = fixture({
      env: {
        ATMUSIC_LISTEN: `127.0.0.1:${configuredPort}`,
        LISTEN_FDS: '1',
        PATH: process.env.PATH ?? '',
        // The child runs main-like: no fixture origins, a real https origin.
        LEXICON_PREFIX: '',
      },
    });
    const handle = (inherited as unknown as { _handle: { fd: number } })._handle.fd;
    const child = spawn(process.execPath, [join(dir, 'entry.mjs'), '--init'], {
      stdio: ['ignore', 'pipe', 'pipe', handle],
      env: f4.env as NodeJS.ProcessEnv,
    });
    let output = '';
    child.stdout?.on('data', (c: Buffer) => {
      output += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      output += c.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    // Only the child may accept on the inherited socket from now on.
    await new Promise<void>((resolve) => inherited.close(() => resolve()));
    netServers.splice(netServers.indexOf(inherited), 1);
    const deadline = Date.now() + 30_000;
    while (!output.includes('"run.ready"') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(output, output).toContain('"socketActivated":true');
    const answer = await get(inheritedPort, '/health/ready');
    expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { status: 'ready' }]);
    expect(await accepts(configuredPort)).toBe(false);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 60_000);

  it('startup with an ATMUSIC_ASSETS_DIR lacking index.html exits 78 naming ATMUSIC_ASSETS_DIR and never listens', async () => {
    const f = fixture({ dist: { 'assets/app.js': 'console.log(1);' } });
    const targets: ListenTarget[] = [];
    const started = start(f.env, ['--init'], { serverFactory: refusingServerFactory(targets) });
    expect(await started.result).toBe(78);
    expect(started.exits).toEqual([78]);
    expect(started.stderr.join('')).toMatch(/^atmusic: configuration error: ATMUSIC_ASSETS_DIR: has no index\.html/);
    expect(started.log.logs.find((l) => l.event === 'run.config_error')?.fields).toEqual(['ATMUSIC_ASSETS_DIR']);
    // Refused before the database and the listener.
    expect(targets).toEqual([]);
    expect(existsSync(f.dbPath)).toBe(false);

    // A missing directory is the same refusal.
    const missing = fixture();
    const env = { ...missing.env, ATMUSIC_ASSETS_DIR: join(missing.dir, 'no-such-dist') };
    const again = start(env, ['--init'], { serverFactory: refusingServerFactory(targets) });
    expect(await again.result).toBe(78);
    expect(again.stderr.join('')).toContain('ATMUSIC_ASSETS_DIR: cannot be read');
    expect(targets).toEqual([]);
  });

  it('without --init a missing ATMUSIC_DB exits 78 and creates no file; with --init the file is created and migrated', async () => {
    const f = fixture();
    const targets: ListenTarget[] = [];
    const refused = start(f.env, [], { serverFactory: refusingServerFactory(targets) });
    expect(await refused.result).toBe(78);
    expect(refused.exits).toEqual([78]);
    expect(refused.stderr.join('')).toContain('ATMUSIC_DB:');
    expect(refused.stderr.join('')).toContain('run once with --init');
    expect(existsSync(f.dbPath)).toBe(false);
    expect(existsSync(dirname(f.dbPath)) ? readdirSync(dirname(f.dbPath)) : []).toEqual([]);
    expect(targets).toEqual([]);

    const created = start(f.env, ['--init']);
    const server = await created.server;
    expect(statSync(f.dbPath).mode & 0o777).toBe(0o600);
    expect(readSchemaState(server.db)).toEqual({ status: 'ready', version: MIGRATIONS.length });
    expect(
      server.db
        .all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
        .map((r) => r.version),
    ).toEqual(MIGRATIONS.map((m) => m.version));
    // A fresh database has nothing to protect: no pre-migration copy.
    expect(created.log.logs.some((l) => l.event === 'backup.completed')).toBe(false);
    expect((await get(server.address.port, '/health/ready')).status).toBe(200);
    await server.shutdown();
    expect(await created.result).toBe(0);

    // The file stays: a restart without --init opens it.
    const again = start(f.env, []);
    const reopened = await again.server;
    expect(readSchemaState(reopened.db).status).toBe('ready');
  });

  it('with NODE_OPTIONS or NODE_TLS_REJECT_UNAUTHORIZED in the injected environment run() exits 78 naming it before opening the database', async () => {
    for (const [name, value] of [
      ['NODE_OPTIONS', '--require=./x.js'],
      ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ] as const) {
      const f = fixture({ env: { [name]: value } });
      const targets: ListenTarget[] = [];
      const started = start(f.env, ['--init'], { serverFactory: refusingServerFactory(targets) });
      expect(await started.result).toBe(78);
      expect(started.exits).toEqual([78]);
      expect(started.stderr.join('')).toContain(`configuration error: ${name}: must not be set`);
      expect(started.stderr.join('')).not.toContain(value === '0' ? '=0' : value);
      expect(existsSync(f.dbPath)).toBe(false);
      expect(existsSync(join(f.dir, 'run', 'atmusic', 'admin.sock'))).toBe(false);
      expect(targets).toEqual([]);
      // Refused before the global fetch is replaced.
      expect(globalThis.fetch).toBe(ORIGINAL_FETCH);
    }
    // Every other forbidden variable is refused the same way, even when empty.
    for (const name of FORBIDDEN_RUNTIME_ENV) {
      const f = fixture({ env: { [name]: '' } });
      const started = start(f.env, ['--init']);
      expect([name, await started.result]).toEqual([name, 78]);
      expect(started.stderr.join('')).toContain(`${name}: must not be set`);
      expect(existsSync(f.dbPath)).toBe(false);
    }
  });

  it('after run() starts, a call to globalThis.fetch rejects with TransportError unpinned_fetch and the composed app still serves /health/ready', async () => {
    const f = fixture();
    const started = start(f.env, ['--init']);
    const server = await started.server;
    expect(globalThis.fetch).not.toBe(ORIGINAL_FETCH);
    const error = await globalThis.fetch('https://example.com/xrpc/x').then(
      () => null,
      (e: unknown) => e,
    );
    expect(isTransportError(error, 'unpinned_fetch')).toBe(true);
    expect((error as Error).name).toBe('TransportError');
    expect((error as Error).message).toContain('https://example.com/xrpc/x');
    const request = await globalThis.fetch(new Request('https://pds.example/x')).catch((e: unknown) => e);
    expect(isTransportError(request, 'unpinned_fetch')).toBe(true);
    const ready = await get(server.address.port, '/health/ready');
    expect([ready.status, JSON.parse(ready.body)]).toEqual([200, { status: 'ready' }]);
  });
});
