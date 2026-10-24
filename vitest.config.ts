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
      // Node-side tooling tests (scripts/test/**: W1-09 gen-config/check-bundle,
      // deploy, pitr-restore, secret-scan). They spawn npm, tsc, biome, tsx and
      // wrangler, hence the long default timeout.
      {
        test: {
          name: 'scripts',
          root: './scripts',
          include: ['test/**/*.test.ts'],
          exclude: ['test/check-ts.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
        },
      },
      // W0-AMEND check-ts: negative controls that run the whole gate
      // (scripts/check-ts.sh, with its own full vitest run and default 5 s
      // timeouts) in a disposable copy. The nested run starts its own
      // vitest workers outside this run's worker budget, so it must not share
      // the CPU with any other project: it runs alone, in the last sequence
      // group, after worker-modules (1) and worker-acceptance (2). The copy
      // omits check-ts.test.ts, so the nested run never recurses and this
      // project is empty there. scripts/test/check-ts.test.ts asserts the order.
      {
        test: {
          name: 'scripts-gate',
          root: './scripts',
          include: ['test/check-ts.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
          sequence: { groupOrder: 3 },
        },
      },
    ],
    passWithNoTests: false,
  },
});
