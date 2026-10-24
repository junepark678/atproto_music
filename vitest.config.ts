// Workspace test runner (ADR 0004 §10.1). Each project brings its own config:
// packages/* and worker/vitest.*.config.ts run in workerd via cloudflareTest;
// web runs under happy-dom (web/vitest.config.ts, W1-10).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'worker/vitest.*.config.ts',
      'web',
      // Node-side build tooling tests (scripts/test/**, W1-09): they spawn tsx and wrangler.
      { test: { name: 'scripts', include: ['scripts/test/**/*.test.ts'], environment: 'node', testTimeout: 180_000 } },
    ],
    passWithNoTests: false,
  },
});
