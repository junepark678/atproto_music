// @atmusic/core tests run in plain Node 26 (ADR 0005 §2.2, §15.1; N0-01): the
// production host's own ICU normalize (Unicode 17) and WebCrypto. Core is pure
// and has no bindings; test/unicode-runtime.test.ts proves Node's ICU against
// the Rust oracle exactly as it did for workerd's.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
