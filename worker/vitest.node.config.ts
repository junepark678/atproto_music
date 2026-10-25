// The Node host's test project (ADR 0005 §3, §15.1; N0-01): worker/test/node/**
// runs in plain Node 26 (node:sqlite, node:crypto/OpenSSL, the bundled undici),
// never inside workerd. worker/vitest.modules.config.ts excludes these files.
//
// Timeouts: the project keeps vitest's default 5 s test timeout. No test here
// waits for a production duration (busy timeout, drain window and alarm
// delays are injected, ADR §3.2, §3.10); a test that starts a listener or a
// timer and legitimately needs longer sets its own timeout. Process-level
// tests that spawn the built main.mjs live in scripts/test with explicit
// timeouts, and large-fixture suites live only in worker-bench (ADR §15.1),
// never under test/node/**.
//
// Isolation: group 1, with worker-modules (the other 5 s-timeout unit tests),
// after the default group (0) whose scripts project spawns whole toolchains.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'worker-node',
    environment: 'node',
    include: ['test/node/**/*.test.ts'],
    sequence: { groupOrder: 1 },
  },
});
