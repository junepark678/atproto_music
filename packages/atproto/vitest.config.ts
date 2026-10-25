// @atmusic/atproto tests run in plain Node 26 (ADR 0005 §2.2, §15.1; N1-04):
// the production host's own WebCrypto (OpenSSL ECDSA P-256), web streams,
// fetch types and ICU. The package itself stays host-neutral (web platform APIs
// only, tsconfig.json). test-support/fake-jetstream.ts serves its sockets
// through an in-memory WebSocket pair when workerd's WebSocketPair is absent,
// and its memoryLink() connector works on any host.
//
// Timeout: workerd does not advance its clock during pure CPU work, so the
// 5 s default never bit the CPU-bound verification suites there (signed CAR
// goldens, MST walks, ECDSA). On Node the timeout is wall-clock and the gate
// runs this project alongside the toolchain-spawning `scripts` project, so a
// suite that takes about 2 s alone can exceed 5 s; none of these tests waits
// on a timer or a production duration. 30 s keeps a real hang visible.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'atproto',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
