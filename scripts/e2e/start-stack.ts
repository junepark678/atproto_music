// The browser end-to-end stack (N6-01). Playwright's `webServer` command.
// TEST-ONLY. The Node e2e bundle reaches only the fixture allowlist through
// parent IPC; the browser uses the same hosts through a local TLS proxy.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { testSecretsDocument } from '../../worker/test/node/support/app';
import { buildHeaders, main as genConfig, HEADERS_FILE, REPO_ROOT } from '../gen-config';
import { E2E_PREFIX, type E2ePorts, portsFromEnv } from './dev-env';
import { APP_HOST, type FixtureWorld, startFixtureWorld } from './fixture-world';

export const WORK_DIR = join(REPO_ROOT, 'work', 'e2e');
export const DIST_DIR = join(WORK_DIR, 'dist');
export const STATE_DIR = join(WORK_DIR, 'state');
export const NETWORK_FILE = join(WORK_DIR, 'network.json');
export const STACK_LOCK_FILE = join(WORK_DIR, 'start-stack.lock');
export const E2E_BUNDLE = join(REPO_ROOT, 'worker', 'dist', 'node', 'e2e.mjs');
const SECRETS_FILE = join(STATE_DIR, 'secrets.json');
const RUNTIME_DIR = join(WORK_DIR, 'run');
export const CONTROL_TOKEN_FILE = join(STATE_DIR, 'control-token');
const CONTROL_TOKEN_HEADER = 'x-atmusic-e2e-control-token';
const COMMAND_TIMEOUT_MS = 10_000;
const BIN = join(REPO_ROOT, 'node_modules', '.bin');
let activeStop: (() => Promise<void>) | null = null;

interface WireMessage {
  type?: unknown;
  id?: unknown;
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
  status?: unknown;
  result?: unknown;
  error?: unknown;
  authority?: unknown;
}

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with ${code ?? signal}`)),
    );
  });
}

/** Refuses to start when any port is taken (another stack could answer in its place). */
async function assertPortsFree(ports: E2ePorts): Promise<void> {
  for (const [name, port] of Object.entries(ports)) {
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', () =>
        reject(new Error(`port ${port} (${name}) is in use; set E2E_${name.toUpperCase()}_PORT`)),
      );
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
    });
  }
}

/** Claims this workspace before checking ports or touching stack output. */
export async function acquireStackOwnership(ports: E2ePorts, lockPath = STACK_LOCK_FILE): Promise<() => void> {
  const token = randomBytes(16).toString('hex');
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      let owner = 'owner metadata unavailable';
      try {
        owner = readFileSync(lockPath, 'utf8').trim();
      } catch {
        // Keep the actionable path even if the lock was removed concurrently.
      }
      throw new Error(`another e2e stack owns this workspace (${lockPath}; ${owner})`);
    }
    throw error;
  }
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token })}\n`);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // Preserve the original write error; the lock path is included in the error context below.
    }
    throw new Error(`could not write e2e workspace lock ${lockPath}: ${messageOf(error)}`);
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    closeSync(fd);
    try {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: unknown };
      if (owner.token === token) unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  try {
    await assertPortsFree(ports);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

function ipcErrorResponse(error: unknown): {
  type: 'response';
  status: number;
  headers: [string, string][];
  body: string;
} {
  return {
    type: 'response',
    status: 599,
    headers: [],
    body: Buffer.from(error instanceof Error ? error.message : String(error)).toString('base64'),
  };
}

/** The only network router for node-entry's fixture transport. */
async function routeOutbound(
  message: WireMessage,
  world: FixtureWorld,
): Promise<{
  type: 'response';
  id: number;
  status: number;
  headers: [string, string][];
  body: string | null;
}> {
  if (
    !Number.isSafeInteger(message.id) ||
    typeof message.url !== 'string' ||
    typeof message.method !== 'string' ||
    !Array.isArray(message.headers) ||
    !(message.body === null || typeof message.body === 'string')
  ) {
    throw new TypeError('malformed e2e outbound IPC request');
  }
  const id = message.id as number;
  const url = new URL(message.url);
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || url.username || url.password) {
    throw new TypeError(`e2e router refused non-HTTPS/default-port URL ${url.origin}`);
  }

  if (!Object.hasOwn(world.network.hosts, url.hostname)) {
    throw new TypeError(`e2e router refused unknown host ${url.hostname}`);
  }
  const headers = new Headers(message.headers as [string, string][]);
  const init: RequestInit = { method: message.method, headers, redirect: 'manual' };
  if (message.body !== null && message.method !== 'GET' && message.method !== 'HEAD') {
    init.body = Buffer.from(message.body, 'base64');
  }
  const response = await world.route(new Request(url, init));
  const body = response.body === null ? null : Buffer.from(await response.arrayBuffer()).toString('base64');
  return {
    type: 'response',
    id,
    status: response.status,
    headers: [...response.headers],
    body,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function terminate(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
}

/** Starts the Node e2e bundle and serializes pump commands and IPC routing. */
export async function startStack(): Promise<{ stop(): Promise<void> }> {
  mkdirSync(WORK_DIR, { recursive: true });
  const ports = portsFromEnv();
  const releaseOwnership = await acquireStackOwnership(ports);
  try {
    rmSync(DIST_DIR, { recursive: true, force: true });
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  } catch (error) {
    releaseOwnership();
    throw error;
  }
  const originText = `https://${APP_HOST}`;
  log('starting HTTPS fixture world (FakeOAuthAs, FakePds, FakePlc, FakeDoh, browser proxy)');

  let world: FixtureWorld | null = null;
  let child: ChildProcess | null = null;
  let stopped = false;
  let expectedExit: ChildProcess | null = null;
  let stopPromise: Promise<void> | null = null;
  let restartTask: Promise<void> | null = null;
  let pumpTask: Promise<void> | null = null;
  let pumpTimer: NodeJS.Timeout | null = null;
  let wakePump: (() => void) | null = null;
  let resumePump: (() => void) | null = null;
  let pumpPaused = false;
  let pumpInFlight: Promise<void> | null = null;
  let commandId = 0;
  let generation = 0;
  let lastPumpWallMs = 0;
  let activeCommand: { id: number; resolve(value: unknown): void; reject(error: Error): void } | null = null;
  let controlServer: HttpServer | null = null;
  const sentCommits: unknown[] = [];

  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopped = true;
    if (pumpTimer !== null) {
      clearTimeout(pumpTimer);
      pumpTimer = null;
      wakePump?.();
      wakePump = null;
    }
    resumePump?.();
    resumePump = null;
    stopPromise = (async () => {
      try {
        await terminate(child);
        await restartTask?.catch(() => {});
        await terminate(child);
        await pumpTask?.catch(() => {});
      } finally {
        try {
          if (controlServer !== null) {
            await new Promise<void>((resolve) => controlServer?.close(() => resolve()));
            controlServer = null;
          }
          rmSync(CONTROL_TOKEN_FILE, { force: true });
          if (world !== null) await world.close();
        } finally {
          activeStop = null;
          releaseOwnership();
        }
      }
    })();
    return stopPromise;
  };
  activeStop = stop;

  try {
    world = await startFixtureWorld(ports);
    if (stopped) throw new Error('e2e stack stopped during startup');
    writeFileSync(NETWORK_FILE, `${JSON.stringify(world.network, null, 2)}\n`);

    log('vite build → work/e2e/dist');
    await run(
      join(BIN, 'vite'),
      ['build', '--outDir', DIST_DIR, '--emptyOutDir', '--logLevel', 'warn'],
      join(REPO_ROOT, 'web'),
    );
    if (stopped) throw new Error('e2e stack stopped during startup');

    log('gen-config for the local e2e origin');
    const status = genConfig(['--origin', originText, '--prefix', E2E_PREFIX, '--out', DIST_DIR], {
      ...process.env,
      PUBLIC_ORIGIN: originText,
      LEXICON_PREFIX: E2E_PREFIX,
    });
    if (status !== 0) throw new Error('gen-config refused the local configuration');
    writeFileSync(join(DIST_DIR, HEADERS_FILE), buildHeaders());

    log('build Node e2e bundle');
    await run(join(BIN, 'tsx'), ['scripts/build-server.ts', '--e2e'], REPO_ROOT);

    writeFileSync(SECRETS_FILE, `${JSON.stringify(testSecretsDocument())}\n`, { mode: 0o600 });
    chmodSync(SECRETS_FILE, 0o600);
    const controlToken = randomBytes(32).toString('hex');
    writeFileSync(CONTROL_TOKEN_FILE, controlToken, { mode: 0o600 });
    const signinDids = world.network.accounts.map((account) => account.did).join(',');
    const childStartWallMs = Date.now();
    world.advance(childStartWallMs - world.clockStartedWallMs);
    lastPumpWallMs = childStartWallMs;
    const makeChildEnv = (): NodeJS.ProcessEnv => ({
      ...process.env,
      ATMUSIC_PUBLIC_ORIGIN: originText,
      ATMUSIC_LISTEN: `127.0.0.1:${ports.worker}`,
      ATMUSIC_CLIENT_IP_HEADER: 'none',
      ATMUSIC_SIGNIN_DIDS: signinDids,
      ATMUSIC_SIGNIN_POLICY: 'allowlist',
      ATMUSIC_ASSETS_DIR: DIST_DIR,
      ATMUSIC_SECRETS_FILE: SECRETS_FILE,
      ATMUSIC_TEST_NOW_MS: String(world?.clock.nowMs()),
      ATMUSIC_TEST_JETSTREAM_COMMITS: Buffer.from(JSON.stringify(sentCommits)).toString('base64'),
      ATMUSIC_DB: join(STATE_DIR, 'atmusic.db'),
      STATE_DIRECTORY: STATE_DIR,
      XDG_RUNTIME_DIR: RUNTIME_DIR,
      LEXICON_PREFIX: E2E_PREFIX,
      NAMESPACE_OWNERSHIP_REF: 'dns:_lexicon.e2e.atmusic.test',
      NAMESPACE_PUBLICATION_REF: `sha256:${'0'.repeat(64)}`,
      INGEST_MODE: 'off',
      JETSTREAM_URLS: 'wss://jetstream.test',
      JETSTREAM_LOOKBACK_HOURS: '24',
      RELAY_URL: 'https://relay.test/',
    });
    const waitForHttp = async (proc: ChildProcess): Promise<void> => {
      const healthDeadline = Date.now() + 120_000;
      while (!stopped && child === proc && Date.now() < healthDeadline) {
        if (proc.exitCode !== null || proc.signalCode !== null)
          throw new Error(`Node e2e bundle exited with ${proc.exitCode ?? proc.signalCode}`);
        try {
          const local = `http://127.0.0.1:${ports.worker}`;
          const requestHeaders = { host: APP_HOST };
          const live = await fetch(`${local}/health/live`, { headers: requestHeaders });
          const meta =
            live.status === 200
              ? ((await (await fetch(`${local}/api/v1/meta`, { headers: requestHeaders })).json()) as {
                  lexiconPrefix?: unknown;
                })
              : null;
          if (meta?.lexiconPrefix === E2E_PREFIX) return;
        } catch {
          // The listener may not be ready yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`Node e2e bundle did not answer ${originText} within 120000 ms`);
    };
    const spawnNodeBundle = async (): Promise<ChildProcess> => {
      const proc = spawn(process.execPath, [E2E_BUNDLE, '--init'], {
        cwd: REPO_ROOT,
        env: makeChildEnv(),
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      child = proc;
      let queue = Promise.resolve();
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Node e2e bundle did not answer ${originText} within 120000 ms`)),
          120_000,
        );
        proc.on('message', (raw: unknown) => {
          const message = raw as WireMessage;
          if (message.type === 'ready') {
            clearTimeout(timeout);
            resolve();
          } else if (message.type === 'answer' && Number.isSafeInteger(message.id)) {
            if (child !== proc) return;
            const current = activeCommand;
            if (current !== null && current.id === message.id) {
              activeCommand = null;
              if (typeof message.error === 'string') current.reject(new Error(message.error));
              else current.resolve(message.result);
            }
          } else if (message.type === 'request') {
            // Requests are routed in arrival order. Responses are sent only after
            // each upstream body is fully read, so IPC never races a pump answer.
            queue = queue.then(async () => {
              try {
                const reply = await routeOutbound(message, world as FixtureWorld);
                if (child === proc && proc.connected) {
                  await new Promise<void>((res, rej) => proc.send(reply, (error) => (error ? rej(error) : res())));
                }
              } catch (error) {
                const failure = { ...ipcErrorResponse(error), id: message.id as number };
                if (child === proc && proc.connected) {
                  await new Promise<void>((res, rej) =>
                    proc.send(failure, (sendError) => (sendError ? rej(sendError) : res())),
                  );
                }
              }
            });
            void queue.catch((error) => console.error(`[e2e] outbound IPC router: ${messageOf(error)}`));
          }
        });
        proc.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        proc.once('exit', (code, signal) => {
          clearTimeout(timeout);
          if (child === proc && proc !== expectedExit && activeCommand !== null) {
            activeCommand.reject(new Error(`Node e2e bundle exited with ${code ?? signal}`));
            activeCommand = null;
          }
          if (child === proc && proc !== expectedExit && !stopped)
            reject(new Error(`Node e2e bundle exited with ${code ?? signal}`));
        });
      });
      await Promise.all([ready, waitForHttp(proc)]);
      return proc;
    };
    log(`Node e2e bundle on ${originText}`);
    child = await spawnNodeBundle();

    const sendCommand = (command: Record<string, unknown>): Promise<unknown> => {
      if (stopped || child?.connected !== true) return Promise.resolve(null);
      const id = ++commandId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (activeCommand?.id !== id) return;
          activeCommand = null;
          const action = typeof command.action === 'string' ? command.action : 'unknown';
          reject(
            new Error(
              `Node e2e bundle command ${id} (${action}, generation ${generation}) timed out after ${COMMAND_TIMEOUT_MS} ms; execution is unknown, so the command will not be retried`,
            ),
          );
        }, COMMAND_TIMEOUT_MS);
        activeCommand = {
          id,
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        };
        child?.send({ type: 'command', id, ...command }, (error) => {
          if (error) {
            if (activeCommand?.id === id) {
              activeCommand = null;
              clearTimeout(timeout);
              reject(error);
            }
          }
        });
      });
    };
    const pump = async (): Promise<void> => {
      if (stopped || child?.connected !== true) return;
      const commits = world?.drainCommits() ?? [];
      if (commits.length > 0) {
        const payload = commits.map(({ commit }) => commit);
        sentCommits.push(...payload);
        await sendCommand({ action: 'events', commits: payload });
      }
      const now = Date.now();
      const advance = Math.max(0, now - lastPumpWallMs);
      lastPumpWallMs = now;
      world?.advance(advance);
      await sendCommand({ action: 'pump', advance });
    };
    const pumpLoop = async (): Promise<void> => {
      while (!stopped) {
        if (pumpPaused) {
          await new Promise<void>((resolve) => {
            resumePump = resolve;
          });
          resumePump = null;
          continue;
        }
        const iteration = pump();
        pumpInFlight = iteration;
        try {
          await iteration;
        } catch (error) {
          if (restartTask === null) throw error;
        }
        if (pumpInFlight === iteration) pumpInFlight = null;
        if (stopped) return;
        if (pumpPaused) continue;
        await new Promise<void>((resolve) => {
          wakePump = resolve;
          pumpTimer = setTimeout(() => {
            pumpTimer = null;
            wakePump = null;
            resolve();
          }, 100);
        });
      }
    };
    pumpTask = pumpLoop();
    void pumpTask.catch((error) => {
      if (!stopped && restartTask === null) {
        console.error(`[e2e] pump failed: ${messageOf(error)}`);
        void stop().catch((stopError) => console.error(`[e2e] teardown failed: ${messageOf(stopError)}`));
      }
    });
    const restartBundle = (signal: NodeJS.Signals = 'SIGKILL'): Promise<void> => {
      if (restartTask !== null) return restartTask;
      restartTask = (async () => {
        if (stopped) throw new Error('cannot restart a stopped e2e stack');
        pumpPaused = true;
        if (pumpTimer !== null) {
          clearTimeout(pumpTimer);
          pumpTimer = null;
          wakePump?.();
          wakePump = null;
        }
        // A timeout or rejection leaves mutation completion unknown. Do not hide
        // it by restarting the child and replaying work against a fresh process.
        await pumpInFlight;
        const previous = child;
        if (previous === null) throw new Error('Node e2e bundle is not running');
        expectedExit = previous;
        previous.kill(signal);
        await waitForExit(previous);
        expectedExit = null;
        if (stopped) throw new Error('e2e stack stopped while restarting the Node bundle');
        world?.advance(Math.max(0, Date.now() - lastPumpWallMs));
        lastPumpWallMs = Date.now();
        await spawnNodeBundle();
        generation += 1;
        pumpPaused = false;
        resumePump?.();
        resumePump = null;
        wakePump?.();
      })().finally(() => {
        restartTask = null;
      });
      return restartTask;
    };
    controlServer = createHttpServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${ports.control}`);
      const suppliedToken = request.headers[CONTROL_TOKEN_HEADER];
      const provided = Buffer.from(typeof suppliedToken === 'string' ? suppliedToken : '');
      const expected = Buffer.from(controlToken);
      const authorized =
        request.headers.host === `127.0.0.1:${ports.control}` &&
        request.headers.origin === undefined &&
        provided.length === expected.length &&
        timingSafeEqual(provided, expected);
      if (!authorized) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      if (url.pathname === '/pump/pause') {
        pumpPaused = true;
        if (pumpTimer !== null) {
          clearTimeout(pumpTimer);
          pumpTimer = null;
          wakePump?.();
          wakePump = null;
        }
        const inFlight = pumpInFlight?.catch(() => {}) ?? Promise.resolve();
        void inFlight.then(() => {
          response.writeHead(204);
          response.end();
        });
        return;
      }
      if (url.pathname === '/pump/resume') {
        pumpPaused = false;
        resumePump?.();
        resumePump = null;
        wakePump?.();
        response.writeHead(204);
        response.end();
        return;
      }
      if (url.pathname !== '/restart') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const requestedSignal = url.searchParams.get('signal');
      const signal: NodeJS.Signals = requestedSignal === 'SIGTERM' ? 'SIGTERM' : 'SIGKILL';
      const previousPid = child?.pid ?? null;
      void restartBundle(signal).then(
        () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ generation, pid: child?.pid ?? null, previousPid }));
        },
        (error: unknown) => {
          pumpPaused = false;
          resumePump?.();
          resumePump = null;
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: messageOf(error) }));
          void stop().catch((stopError) => console.error(`[e2e] restart failure teardown: ${messageOf(stopError)}`));
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      controlServer?.once('error', reject);
      controlServer?.listen(ports.control, '127.0.0.1', resolve);
    });
    log('ready');
    return { stop };
  } catch (error) {
    await stop().catch((stopError) => console.error(`[e2e] teardown failed: ${messageOf(stopError)}`));
    activeStop = null;
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  let stack: Awaited<ReturnType<typeof startStack>> | null = null;
  let shutdown: Promise<void> | null = null;
  const close = () => {
    if (shutdown !== null) return shutdown;
    shutdown = stack?.stop() ?? activeStop?.() ?? Promise.resolve();
    return shutdown;
  };
  process.on('SIGTERM', () => void close().finally(() => process.exit(0)));
  process.on('SIGINT', () => void close().finally(() => process.exit(0)));
  startStack().then(
    (started) => {
      stack = started;
      if (shutdown !== null) void close();
    },
    (error: unknown) => {
      console.error('[e2e] stack failed to start:', error);
      process.exitCode = 1;
    },
  );
}
