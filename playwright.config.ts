// Browser end-to-end tests (W6-03; ADR 0004 §10.1 "Browser"): `npm run test:e2e`.
//
// One stack per run (scripts/e2e/start-stack.ts as the webServer): the
// production Worker with the e2e IndexDO entry under `wrangler dev`, the SPA
// built into work/e2e/dist, and @atproto/dev-env (PLC plus two PDSs). Chromium
// reaches the dev-env's https hosts only through the stack's proxy; every
// other destination is refused, so no test touches the real network.
//
// The suites share the stack and its state (the journey writes records), so
// they run serially in one worker. Ports come from E2E_*_PORT (defaults in
// scripts/e2e/dev-env.ts DEFAULT_PORTS).

import { defineConfig, devices } from '@playwright/test';
import { portsFromEnv, workerOrigin } from './scripts/e2e/dev-env';

const ports = portsFromEnv();
const origin = workerOrigin(ports);

export default defineConfig({
  testDir: 'web/tests',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/e2e',
  reporter: [['list']],
  use: {
    baseURL: origin,
    // The dev-env PDSs and PLC are https behind the stack's proxy, with a
    // self-signed certificate; loopback (the Worker) bypasses the proxy.
    proxy: { server: `http://127.0.0.1:${ports.proxy}`, bypass: '127.0.0.1' },
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx tsx scripts/e2e/start-stack.ts',
    url: `${origin}/health/live`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
});
