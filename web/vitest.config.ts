// SPA tests: vitest under happy-dom, with fake-indexeddb where a test needs
// IndexedDB (ADR 0004 §10.1). Picked up by the root vitest.config.ts project
// list as the `web` project. No test reaches the network: the API client and
// the PDS session take an injected fetch.

import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No HMR or devtools bridge in tests; JSX still compiles against preact.
  plugins: [preact({ prefreshEnabled: false, devToolsEnabled: false })],
  test: {
    name: 'web',
    environment: 'happy-dom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
