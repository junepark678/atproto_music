// Worker module tests in real workerd against the harness DO (ADR 0004 §10.1).
//
// Pinned @cloudflare/vitest-plugin 1.4.4 (W0-01 verified the exports):
// - `cloudflareTest` is exported by the package root (used below).
// - `cloudflare:test` provides `runInDurableObject`, `runDurableObjectAlarm`,
//   `evictDurableObject` (DO eviction keeping storage; also
//   `evictAllDurableObjects`), `createScheduledController`,
//   `createExecutionContext`, `waitOnExecutionContext`, `listDurableObjectIds`
//   and `reset`. The bindings come from `import { env } from "cloudflare:workers"`.
// worker/test/harness/local-index.test.ts asserts these helpers at runtime.
//
// worker/vitest.acceptance.config.ts (W6-01) runs the real IndexDO instead.

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/harness/wrangler.harness.jsonc' } })],
  test: {
    name: 'worker-modules',
    include: ['test/**/*.test.ts'],
    exclude: ['test/acceptance/**', 'test/bench/**', 'test/composition/**', 'test/e2e/**', 'test/fixtures/**'],
  },
});
