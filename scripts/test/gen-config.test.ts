import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { SPA_ROUTES } from '../../packages/core/src/spa-routes.ts';
import { CLIENT_NAME, CSP, deployedValueIssues, planGenConfig, wranglerEnvSection } from '../gen-config.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = createRequire(join(REPO, 'package.json')).resolve('tsx/cli');
function temp(): string {
  return mkdtempSync(join(tmpdir(), 'atmusic-gen-config-'));
}
function run(args: string[], vars: Record<string, string> = {}) {
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : temp();
  const env = { ...process.env, ...vars };
  delete env.ATMUSIC_PUBLIC_ORIGIN;
  delete env.LEXICON_PREFIX;
  const result = spawnSync(process.execPath, [TSX, join(REPO, 'scripts/gen-config.ts'), ...args, '--out', out], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { ...result, out };
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)).map((p) => `${e.name}/${p}`) : [e.name]))
    .sort();
}

test('Node defaults come from the example env and only headers are emitted', () => {
  const out = temp();
  try {
    const result = run(['--out', out]);
    expect(result.status).toBe(0);
    expect(files(out)).toEqual(['_headers']);
    const headers = readFileSync(join(out, '_headers'), 'utf8');
    expect(headers).toContain("connect-src 'self'");
    expect(headers).not.toContain('https:;');
    expect(headers).not.toContain('oauth');
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain("require-trusted-types-for 'script'");
    expect(headers).toContain('/assets/*\n  Cache-Control: public, max-age=31536000, immutable');
    expect(headers).toContain('/\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache');
    expect(CSP).toContain("connect-src 'self'");
    expect(CLIENT_NAME).toBe('AT Protocol Music');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('deployment validation recognizes Wrangler bare custom-domain patterns', () => {
  const section = wranglerEnvSection(
    {
      vars: { PUBLIC_ORIGIN: 'https://music.example.org', LEXICON_PREFIX: 'org.example.music' },
      routes: [{ pattern: 'music.example.org', custom_domain: true }],
    },
    'production',
  );
  expect(section.routeHosts).toEqual(['music.example.org']);
  expect(deployedValueIssues(section.vars.PUBLIC_ORIGIN!, section.vars.LEXICON_PREFIX!, section.routeHosts)).toEqual(
    [],
  );
  expect(
    wranglerEnvSection(
      {
        vars: { PUBLIC_ORIGIN: 'https://music.example.org' },
        routes: [{ pattern: 'music.example.org/*', custom_domain: true }],
      },
      'production',
    ).routeHosts,
  ).toEqual([]);
});

test('--origin and --prefix override example values; stale OAuth metadata is removed', () => {
  const out = temp();
  try {
    const oauth = join(out, 'oauth');
    mkdirSync(oauth, { recursive: true });
    writeFileSync(join(oauth, 'client-metadata.json'), '{}');
    writeFileSync(join(oauth, 'loopback-client.json'), '{}');
    const result = run(['--origin', 'https://music.test', '--prefix', 'org.example.music', '--out', out]);
    expect(result.status).toBe(0);
    expect(files(out)).toEqual(['_headers']);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("gen-config writes no oauth/client-metadata.json, sets connect-src 'self', and the SPA routes include /lastfm/authorize and /settings/* but not /oauth/callback", () => {
  const out = temp();
  try {
    const result = run(['--origin', 'https://music.test', '--prefix', 'org.example.music', '--out', out]);
    expect(result.status).toBe(0);
    expect(files(out)).toEqual(['_headers']);
    expect(readFileSync(join(out, '_headers'), 'utf8')).toContain("connect-src 'self'");
    const paths = SPA_ROUTES.map(({ path }) => path);
    expect(paths).toContain('/lastfm/authorize');
    expect(paths).toContain('/settings/links');
    expect(paths).toContain('/settings/imports');
    expect(paths).toContain('/settings/credentials');
    expect(paths).not.toContain('/oauth/callback');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('environment values override the example and invalid origins are refused without writes', () => {
  const out = temp();
  try {
    const result = run(['--out', out], {
      ATMUSIC_PUBLIC_ORIGIN: 'https://override.test',
      LEXICON_PREFIX: 'org.example.music',
    });
    expect(result.status).toBe(0);
    expect(files(out)).toEqual(['_headers']);
    expect(() => planGenConfig({ origin: 'https://bad.test/path', prefix: 'org.example.music' })).toThrow(/origin/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
