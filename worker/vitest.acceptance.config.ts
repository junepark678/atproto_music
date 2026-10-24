// Backend acceptance in real workerd against the real IndexDO (W6-01,
// ADR 0004 §10.1, §10.3, §10.4).
//
// test/acceptance/wrangler.acceptance.jsonc binds INDEX to TestIndexDO
// (test/acceptance/entry.ts), the production IndexDO whose only override is
// `buildDeps` (frozen clock, seeded Random, fixture routerTransport, the
// WebSocketPair Jetstream connector). The shared fixture
// (tests/fixtures/read_models.json) is published as real signed commits and
// reaches the index only through fake Jetstream events, the production drain,
// admission and range snapshots, stepped with runDurableObjectAlarm. Every
// HTTP response is validated against api/openapi.yaml with AJV.

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/acceptance/wrangler.acceptance.jsonc' } })],
  test: {
    name: 'worker-acceptance',
    include: ['test/acceptance/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
