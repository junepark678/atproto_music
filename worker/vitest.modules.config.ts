// Worker module tests on Node 26 against the harness DO through the
// `cloudflare:*` test shim (ADR 0005 §15.1, N2-02).
//
// The suites under test/{harness,storage,ingest,read,write,http} were written
// for workerd (ADR 0004 §10.1). They run here unchanged apart from the named
// expectation changes of ADR 0005 §15.3: `cloudflare:test` and
// `cloudflare:workers` resolve to the shim under test/node/support/, whose
// Durable Objects keep their storage in one SQLite file each (node:sqlite,
// opened by the production adapter) in a temporary directory of the test file.
// test/node/support/workerd-globals.ts defines the in-memory `WebSocketPair`
// and removes that directory after the file. N4-04 to N4-06 de-shim the
// suites by directory; N7-01 deletes the shim and these aliases.
//
// worker/test/harness/local-index.test.ts asserts the shim's helpers at runtime.
// worker/vitest.acceptance.config.ts (W6-01) runs the real IndexDO instead.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const support = (file: string) => fileURLToPath(new URL(`./test/node/support/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:test': support('cloudflare-test-shim.ts'),
      'cloudflare:workers': support('cloudflare-workers-shim.ts'),
    },
  },
  test: {
    name: 'worker-modules',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: [support('workerd-globals.ts')],
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
