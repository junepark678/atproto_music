// @ts-expect-error Node APIs are used only by the test runner; the browser project has no Node type dependency.
import { execFileSync } from 'node:child_process';
// @ts-expect-error Node APIs are used only by the test runner; the browser project has no Node type dependency.
import { readdirSync, readFileSync } from 'node:fs';
// @ts-expect-error Node APIs are used only by the test runner; the browser project has no Node type dependency.
import { dirname, join, resolve } from 'node:path';
// @ts-expect-error Node APIs are used only by the test runner; the browser project has no Node type dependency.
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '..');

beforeAll(() => {
  execFileSync('npm', ['run', 'build', '--workspace', '@atmusic/web'], { cwd: repoRoot, stdio: 'pipe' });
}, 60_000);

function files(dir: string): string[] {
  return (readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>).flatMap(
    (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    },
  );
}

it('the built SPA contains no @atproto/oauth-client code, no PDS hostname and no IndexedDB outbox', () => {
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
  expect(bundle).not.toMatch(/indexedDB\s*\.\s*open/);
});
