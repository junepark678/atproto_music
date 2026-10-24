// The browser end-to-end stack (W6-03): Playwright's `webServer` command
// (playwright.config.ts). TEST-ONLY. Never deploys and never contacts
// Cloudflare, a real PDS, a relay or Jetstream: everything listens on
// 127.0.0.1.
//
//   npx tsx scripts/e2e/start-stack.ts
//
// Steps:
// 1. scripts/e2e/dev-env.ts: PLC, two PDSs (alice on pds1.test, bob on
//    pds2.test, bob with one seeded scrobble) and the browser's TLS proxy.
//    The network description goes to work/e2e/network.json for the tests.
// 2. vite build of web/ into work/e2e/dist.
// 3. scripts/gen-config.ts --env local (PUBLIC_ORIGIN http://127.0.0.1:8787,
//    the e2e prefix) into work/e2e/dist: the loopback-client hint.
// 4. The deployed `_headers` rules (gen-config `buildHeaders`: CSP, nosniff,
//    immutable /assets/*, no-cache index and metadata) into work/e2e/dist, so
//    Static Assets in wrangler dev serve exactly the production headers. The
//    local gen-config plan omits them because their CSP `connect-src 'self'
//    https:` blocks an http PDS; this stack's PDSs and PLC are https (through
//    the proxy), so the production CSP applies unchanged.
// 5. `wrangler dev --config worker/test/e2e/wrangler.e2e.jsonc --ip 127.0.0.1
//    --port 8787` with E2E_NETWORK and a fresh --persist-to directory.
//
// The process stays up until SIGTERM/SIGINT (Playwright sends SIGTERM), then
// stops wrangler and the dev-env.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { buildHeaders, main as genConfig, HEADERS_FILE, REPO_ROOT } from '../gen-config';
import {
  E2E_PREFIX,
  type E2ePorts,
  encodeWorkerNetwork,
  portsFromEnv,
  startDevEnv,
  workerNetwork,
  workerOrigin,
} from './dev-env';

export const WORK_DIR = join(REPO_ROOT, 'work', 'e2e');
export const DIST_DIR = join(WORK_DIR, 'dist');
export const STATE_DIR = join(WORK_DIR, 'state');
export const NETWORK_FILE = join(WORK_DIR, 'network.json');
export const E2E_WRANGLER_CONFIG = join(REPO_ROOT, 'worker', 'test', 'e2e', 'wrangler.e2e.jsonc');

const BIN = join(REPO_ROOT, 'node_modules', '.bin');

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with ${code ?? signal}`)),
    );
  });
}

/** Refuses to start when any port is taken (another stack would answer in our place). */
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

/** Waits until *this* stack's Worker answers: /health/live, and meta naming the e2e prefix. */
async function waitForWorker(origin: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited with ${child.exitCode}`);
    try {
      const live = await fetch(`${origin}/health/live`);
      const meta =
        live.status === 200
          ? ((await (await fetch(`${origin}/api/v1/meta`)).json()) as { lexiconPrefix?: unknown })
          : null;
      if (meta?.lexiconPrefix === E2E_PREFIX) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`wrangler dev did not answer ${origin} within ${timeoutMs} ms`);
}

export async function startStack(): Promise<{ stop(): Promise<void> }> {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  const ports = portsFromEnv();
  await assertPortsFree(ports);
  const originText = workerOrigin(ports);
  log('starting dev-env (PLC, pds1.test, pds2.test, browser proxy)');
  const devEnv = await startDevEnv(ports);
  let wrangler: ChildProcess | null = null;
  const stop = async () => {
    if (wrangler !== null && wrangler.exitCode === null) {
      const exited = new Promise((r) => wrangler?.once('exit', r));
      wrangler.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (wrangler.exitCode === null) wrangler.kill('SIGKILL');
    }
    await devEnv.close();
  };
  try {
    writeFileSync(NETWORK_FILE, `${JSON.stringify(devEnv.network, null, 2)}\n`);

    log('vite build → work/e2e/dist');
    await run(
      join(BIN, 'vite'),
      ['build', '--outDir', DIST_DIR, '--emptyOutDir', '--logLevel', 'warn'],
      join(REPO_ROOT, 'web'),
    );

    log('gen-config --env local');
    const status = genConfig(['--env', 'local', '--out', DIST_DIR], {
      ...process.env,
      PUBLIC_ORIGIN: originText,
      LEXICON_PREFIX: E2E_PREFIX,
    });
    if (status !== 0) throw new Error('gen-config refused the local configuration');
    writeFileSync(join(DIST_DIR, HEADERS_FILE), buildHeaders());

    const origin = new URL(originText);
    log(`wrangler dev on ${originText}`);
    wrangler = spawn(
      join(BIN, 'wrangler'),
      [
        'dev',
        '--config',
        E2E_WRANGLER_CONFIG,
        '--ip',
        origin.hostname,
        '--port',
        origin.port,
        '--persist-to',
        STATE_DIR,
        '--var',
        `E2E_NETWORK:${encodeWorkerNetwork(workerNetwork(devEnv.network))}`,
        '--show-interactive-dev-session=false',
        '--log-level',
        'warn',
      ],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', CI: 'true' },
      },
    );
    await waitForWorker(originText, wrangler, 120_000);
    log('ready');
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startStack().then(
    (stack) => {
      let stopping = false;
      const shutdown = () => {
        if (stopping) return;
        stopping = true;
        stack.stop().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    },
    (error: unknown) => {
      console.error('[e2e] stack failed to start:', error);
      process.exit(1);
    },
  );
}
