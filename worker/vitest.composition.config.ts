// Composition tests (W5-01) in real workerd against the real IndexDO.
//
// test/composition/wrangler.composition.jsonc binds INDEX to TestIndexDO
// (test/composition/entry.ts), a subclass of the production IndexDO that only
// overrides `buildDeps` (ADR 0004 §4.4 test seam). The tests drive the
// production Worker handlers (`createWorker` from src/router.ts) against that
// binding: real JS RPC, real DO SQLite, real alarms through
// runDurableObjectAlarm, and DO eviction for restarts.

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/composition/wrangler.composition.jsonc' } })],
  test: {
    name: 'worker-composition',
    include: ['test/composition/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
