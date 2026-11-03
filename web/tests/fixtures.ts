import {
  expect,
  test as base,
  type APIRequestContext,
} from '@playwright/test';
import { portsFromEnv } from '../../scripts/e2e/dev-env';

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

export const test = base.extend<{ request: APIRequestContext }>({
  request: async ({ playwright }, use) => {
    const request = await createApiContext(playwright);
    await use(request);
    await request.dispose();
  },
});

export { expect };
