// @atmusic/core tests run inside workerd (real ICU normalize, real WebCrypto),
// ADR 0004 §10.1. Core has no bindings, so no wrangler config is needed.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: { compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'] },
    }),
  ],
  test: {
    name: 'core',
    include: ['test/**/*.test.ts'],
  },
});
