// Workspace test runner (ADR 0004 §10.1). Each project brings its own config:
// packages/* and worker/vitest.*.config.ts run in workerd via cloudflareTest;
// web runs under happy-dom (web/vitest.config.ts, W1-10). The inline `scripts`
// project runs the Node-side tooling tests in scripts/test (they spawn npm,
// tsc and biome against disposable copies of the repository).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'worker/vitest.*.config.ts',
      'web',
      // Node-side tooling tests (scripts/test/**: W0-AMEND check-ts, W1-09 gen-config/check-bundle).
      // They spawn npm, tsc, biome, tsx and wrangler, hence the long default timeout.
      {
        test: {
          name: 'scripts',
          root: './scripts',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
        },
      },
    ],
    passWithNoTests: false,
  },
});
