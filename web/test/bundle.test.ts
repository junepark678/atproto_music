// @ts-expect-error Node APIs are used only by the test runner; the browser project has no Node type dependency.
import { readdirSync, readFileSync } from 'node:fs';
// @ts-expect-error Node APIs are used only by the test runner; the browser project has no Node type dependency.
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const webRoot = resolve('.');
function files(dir: string): string[] {
  return (readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>).flatMap(
    (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    },
  );
}

it('contains a Node-session SPA without browser OAuth, PDS hosts, or IndexedDB outbox code', () => {
  const src = files(join(webRoot, 'src')).filter((path) => /\.(ts|tsx)$/.test(path));
  const assets = files(join(webRoot, 'dist')).filter((path) => /\.(js|html)$/.test(path));
  expect(src.length).toBeGreaterThan(0);
  expect(assets.length).toBeGreaterThan(0);
  const source = src.map((path) => readFileSync(path, 'utf8')).join('\n');
  const bundle = assets.map((path) => readFileSync(path, 'utf8')).join('\n');
  expect(source).not.toMatch(/from\s+['"][^'"]*\/oauth(?:\/|['"])/);
  expect(bundle).not.toMatch(/@atproto\/oauth-client/);
  expect(bundle).not.toMatch(/(?:https?:\/\/)?(?:bsky\.social|bsky\.network)/i);
  expect(bundle).not.toContain('indexedDB.open');
});
