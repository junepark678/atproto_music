import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'worker-modules',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // test/node/** is the worker-node project (vitest.node.config.ts, plain Node).
    exclude: [
      'test/acceptance/**',
      'test/bench/**',
      'test/composition/**',
      'test/e2e/**',
      'test/fixtures/**',
      'test/node/**',
    ],
    // Isolation, not a longer timeout: these files keep the 5 s default.
    // Their flakes (notify.test.ts at 5,004 ms; migrate.test.ts in the nested
    // check-ts copy) came from CPU oversubscription: the scripts projects
    // spawn whole toolchains outside vitest's worker budget (deploy.test.ts
    // runs vite and wrangler; check-ts.test.ts runs a nested `check-ts.sh`,
    // i.e. a second full vitest run with its own workers) and worker-bench
    // indexes 1,000-row fixtures. Group 1 starts only after all of group 0
    // has finished, so these files share the CPU only with each other,
    // within the worker budget. worker-acceptance runs after this, in group 2,
    // and the nested gate (scripts-gate, root vitest.config.ts) last, alone,
    // in group 3, so the nested copy of these files gets the same isolation
    // in its own run. Tests whose work is legitimately heavy set their own
    // timeout (notify 600 requests: 60 s; stats-plan, snapshot-job).
    sequence: { groupOrder: 1 },
  },
});
