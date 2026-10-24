// @atmusic/atproto tests run inside workerd (ADR 0004 §10.1): real WebCrypto
// ECDSA, real streams and fetch types, and the same esbuild resolution that
// selects the noble build of @atcute/crypto.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  test: {
    name: 'atproto',
    include: ['test/**/*.test.ts'],
  },
});
