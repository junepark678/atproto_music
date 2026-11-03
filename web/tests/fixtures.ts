import { readFileSync } from 'node:fs';
import { type APIRequestContext, test as base, expect } from '@playwright/test';
import { portsFromEnv } from '../../scripts/e2e/dev-env';
import { CONTROL_TOKEN_FILE } from '../../scripts/e2e/start-stack';

function apiContextOptions() {
  return {
    // API probes need no browser cookie and can use the app's loopback listener
    // directly. Browser journeys still use the HTTPS fixture origin + proxy.
    baseURL: `http://127.0.0.1:${portsFromEnv().worker}`,
  };
}

export async function createApiContext(playwright: import('@playwright/test').Playwright): Promise<APIRequestContext> {
  const request = await playwright.request.newContext(apiContextOptions());
  return request;
}

async function controlNode(path: string): Promise<Response> {
  const token = readFileSync(CONTROL_TOKEN_FILE, 'utf8');
  return fetch(`http://127.0.0.1:${portsFromEnv().control}${path}`, {
    method: 'POST',
    headers: { 'x-atmusic-e2e-control-token': token },
  });
}

export async function pauseNodePump(): Promise<void> {
  const response = await controlNode('/pump/pause');
  if (response.status !== 204) throw new Error(`Could not pause Node e2e pump (${response.status})`);
}

export async function restartNode(signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL'): Promise<{
  generation: number;
  pid: number;
  previousPid: number;
}> {
  const response = await controlNode(`/restart?signal=${encodeURIComponent(signal)}`);
  if (!response.ok) throw new Error(`Node e2e restart failed (${response.status}): ${await response.text()}`);
  const result = (await response.json()) as { generation?: unknown; pid?: unknown; previousPid?: unknown };
  if (
    typeof result.generation !== 'number' ||
    typeof result.pid !== 'number' ||
    typeof result.previousPid !== 'number' ||
    result.pid === result.previousPid
  )
    throw new Error('Node e2e restart did not report a new process');
  return result as { generation: number; pid: number; previousPid: number };
}

export const test = base.extend<{ request: APIRequestContext }>({
  request: async ({ playwright }, use) => {
    const request = await createApiContext(playwright);
    await use(request);
    await request.dispose();
  },
});

export { expect };
