// Backend acceptance on Node 26 (W6-01, ported by N4-03; ADR 0004 §10.1,
// §10.3, §10.4; ADR 0005 §15.1, §15.3).
//
// test/acceptance/entry.ts is the acceptance composition factory: the
// production Node composition (node/compose.ts over node:sqlite, the route
// table, dispatcher and HTTP bridge on 127.0.0.1:0) with dependencies
// overridden only through compose's options — the frozen clock, seeded
// Random, the fixture routerTransport and the memoryLink Jetstream. The shared
// fixture (tests/fixtures/read_models.json) is published as real signed
// commits and reaches the index only through fake Jetstream events, the
// production drain, admission and range snapshots, stepped through the core
// lane's NodeAlarm. Every HTTP response is validated against
// api/openapi.yaml with AJV. Restart is close-and-reopen of the same
// database file plus a recomposed app.
//
// The project runs in its own sequence group, after all other projects (see
// `sequence.groupOrder` below).

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'worker-acceptance',
    environment: 'node',
    include: ['test/acceptance/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Isolation: these files are CPU-heavy (query-plans signs and indexes
    // 100 × 1,000 records). Group 2 starts only after the default group (0)
    // and worker-modules and worker-node (group 1, the 5 s-timeout unit tests)
    // have finished, so the acceptance files never compete for CPU with the
    // unit tests. The nested gate (scripts-gate, group 3, root
    // vitest.config.ts) starts only after this group has finished.
    sequence: { groupOrder: 2 },
  },
});
