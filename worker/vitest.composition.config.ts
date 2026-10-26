// Composition tests on Node 26 (W5-01, ported by N4-03; ADR 0005 §15.1,
// §15.3).
//
// test/composition/support.ts is the Node composition factory that replaced
// the workerd test entry: the production composition (node/compose.ts over
// node:sqlite, the production route table, dispatcher and static files, the
// real HTTP bridge on 127.0.0.1:0) with dependencies overridden only through
// compose's options — the frozen clock, seeded randomness, the fixture
// transport, the memoryLink (or loopback `ws`) Jetstream, manual timers and a
// Db wrapper for recording and fault injection. Restart is close-and-reopen
// of the same database file plus a recomposed app. admin.test.ts drives run()
// (N3-07) for the admin unix socket. Nothing here imports cloudflare:*.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'worker-composition',
    environment: 'node',
    include: ['test/composition/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
