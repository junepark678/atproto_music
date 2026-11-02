// The browser end-to-end stack (N6-01). Playwright's `webServer` command.
// TEST-ONLY. The Node e2e bundle reaches only the fixture allowlist through
// parent IPC; the browser uses the same hosts through a local TLS proxy.

import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { buildHeaders, main as genConfig, HEADERS_FILE, REPO_ROOT } from '../gen-config';
import { testSecretsDocument } from '../../worker/test/node/support/app';
import {
  E2E_PREFIX,
  type E2ePorts,
  portsFromEnv,
} from './dev-env';
import { APP_HOST, startFixtureWorld, type FixtureWorld } from './fixture-world';

export const WORK_DIR = join(REPO_ROOT, 'work', 'e2e');
export const DIST_DIR = join(WORK_DIR, 'dist');
export const STATE_DIR = join(WORK_DIR, 'state');
export const NETWORK_FILE = join(WORK_DIR, 'network.json');
export const E2E_BUNDLE = join(REPO_ROOT, 'worker', 'dist', 'node', 'e2e.mjs');
const SECRETS_FILE = join(STATE_DIR, 'secrets.json');
const RUNTIME_DIR = join(WORK_DIR, 'run');
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

function ipcErrorResponse(error: unknown): { type: 'response'; status: number; headers: [string, string][]; body: string } {
  return {
    type: 'response',
    status: 599,
    headers: [],
    body: Buffer.from(error instanceof Error ? error.message : String(error)).toString('base64'),
  };
}

/** The only network router for node-entry's fixture transport. */
async function routeOutbound(message: WireMessage, world: FixtureWorld): Promise<{
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
  rmSync(DIST_DIR, { recursive: true, force: true });
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });

  const ports = portsFromEnv();
  await assertPortsFree(ports);
  const originText = `https://${APP_HOST}`;
  log('starting HTTPS fixture world (FakeOAuthAs, FakePds, FakePlc, FakeDoh, browser proxy)');

  let world: FixtureWorld | null = null;
  let child: ChildProcess | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let pumpTask: Promise<void> | null = null;
  let pumpTimer: NodeJS.Timeout | null = null;
  let wakePump: (() => void) | null = null;
  let commandId = 0;
  let lastPumpWallMs = 0;
  let activeCommand: { id: number; resolve(value: unknown): void; reject(error: Error): void } | null = null;
  let outboundQueue = Promise.resolve();

  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopped = true;
    if (pumpTimer !== null) {
      clearTimeout(pumpTimer);
      pumpTimer = null;
      wakePump?.();
      wakePump = null;
    }
    stopPromise = (async () => {
      try {
        await terminate(child);
        await pumpTask?.catch(() => {});
      } finally {
        if (world !== null) await world.close();
        activeStop = null;
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
    const signinDids = world.network.accounts.map((account) => account.did).join(',');
    const childStartWallMs = Date.now();
    world.advance(childStartWallMs - world.clockStartedWallMs);
    lastPumpWallMs = childStartWallMs;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ATMUSIC_PUBLIC_ORIGIN: originText,
      ATMUSIC_LISTEN: `127.0.0.1:${ports.worker}`,
      ATMUSIC_CLIENT_IP_HEADER: 'none',
      ATMUSIC_SIGNIN_DIDS: signinDids,
      ATMUSIC_SIGNIN_POLICY: 'allowlist',
      ATMUSIC_ASSETS_DIR: DIST_DIR,
      ATMUSIC_SECRETS_FILE: SECRETS_FILE,
      ATMUSIC_TEST_NOW_MS: String(world.clock.nowMs()),
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
    };
    log(`Node e2e bundle on ${originText}`);
    child = spawn(process.execPath, [E2E_BUNDLE, '--init'], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Node e2e bundle did not answer ${originText} within 120000 ms`)), 120_000);
      child?.on('message', (raw: unknown) => {
        const message = raw as WireMessage;
        if (message.type === 'ready') {
          clearTimeout(timeout);
          resolve();
        } else if (message.type === 'answer' && Number.isSafeInteger(message.id)) {
          const current = activeCommand;
          if (current !== null && current.id === message.id) {
            activeCommand = null;
            if (typeof message.error === 'string') current.reject(new Error(message.error));
            else current.resolve(message.result);
          }
        } else if (message.type === 'request') {
          // Requests are routed in arrival order. Responses are sent only after
          // each upstream body is fully read, so IPC never races a pump answer.
          outboundQueue = outboundQueue.then(async () => {
            try {
              const reply = await routeOutbound(message, world as FixtureWorld);
              if (child?.connected) {
                await new Promise<void>((res, rej) =>
                  child?.send(reply, (error) => (error ? rej(error) : res())),
                );
              }
            } catch (error) {
              const failure = { ...ipcErrorResponse(error), id: message.id as number };
              if (child?.connected) {
                await new Promise<void>((res, rej) =>
                  child?.send(failure, (sendError) => (sendError ? rej(sendError) : res())),
                );
              }
            }
          });
          void outboundQueue.catch((error) => console.error(`[e2e] outbound IPC router: ${messageOf(error)}`));
        }
      });
      child?.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child?.once('exit', (code, signal) => {
        clearTimeout(timeout);
        if (activeCommand !== null) {
          activeCommand.reject(new Error(`Node e2e bundle exited with ${code ?? signal}`));
          activeCommand = null;
        }
        if (!stopped) reject(new Error(`Node e2e bundle exited with ${code ?? signal}`));
      });
    });

    const healthDeadline = Date.now() + 120_000;
    const waitForHttp = async (): Promise<void> => {
      while (!stopped && Date.now() < healthDeadline) {
        if (child?.exitCode !== null && child?.exitCode !== undefined) {
          throw new Error(`Node e2e bundle exited with ${child.exitCode}`);
        }
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
    await Promise.all([ready, waitForHttp()]);

    const sendCommand = (command: Record<string, unknown>): Promise<unknown> => {
      if (stopped || child?.connected !== true) return Promise.resolve(null);
      const id = ++commandId;
      return new Promise((resolve, reject) => {
        activeCommand = { id, resolve, reject };
        child?.send({ type: 'command', id, ...command }, (error) => {
          if (error) {
            activeCommand = null;
            reject(error);
          }
        });
      });
    };
    const pump = async (): Promise<void> => {
      if (stopped || child?.connected !== true) return;
      const commits = world?.drainCommits() ?? [];
      if (commits.length > 0) {
        await sendCommand({ action: 'events', commits: commits.map(({ commit }) => commit) });
      }
      const now = Date.now();
      const advance = Math.max(0, now - lastPumpWallMs);
      lastPumpWallMs = now;
      world?.advance(advance);
      await sendCommand({ action: 'pump', advance });
    };
    const pumpLoop = async (): Promise<void> => {
      while (!stopped) {
        await pump();
        if (stopped) return;
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
      if (!stopped) {
        console.error(`[e2e] pump failed: ${messageOf(error)}`);
        void stop().catch((stopError) => console.error(`[e2e] teardown failed: ${messageOf(stopError)}`));
      }
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
