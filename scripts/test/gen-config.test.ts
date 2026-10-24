// scripts/gen-config.ts (W1-09): build-time OAuth client metadata and the
// Static Assets _headers file. Every test runs the real CLI in a subprocess
// against a temporary output directory (the repository's web/public is never
// written), then asserts the files on disk; the _headers tests serve the
// generated files through wrangler's local Static Assets server and assert
// the HTTP responses.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, expect, test } from 'vitest';
import { unstable_dev } from 'wrangler';
import { FIXTURE_PREFIX, isValidPrefix, parseJsonc } from '../gen-config.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_CLI = createRequire(join(REPO, 'package.json')).resolve('tsx/cli');
const EXAMPLE_CONFIG = join(REPO, 'config', 'atmusic.workers.example.jsonc');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function genConfig(args: readonly string[], vars: Record<string, string> = {}): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PUBLIC_ORIGIN;
  delete env.LEXICON_PREFIX;
  delete env.ATMUSIC_ENV;
  Object.assign(env, vars);
  const res = spawnSync(process.execPath, [TSX_CLI, join(REPO, 'scripts', 'gen-config.ts'), ...args], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const temps: string[] = [];
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `atmusic-${label}-`));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** A copy of the example wrangler config with the given production vars. */
function wranglerWith(vars: { PUBLIC_ORIGIN?: string; LEXICON_PREFIX?: string }): string {
  const config = parseJsonc(readFileSync(EXAMPLE_CONFIG, 'utf8')) as { vars: Record<string, string> };
  Object.assign(config.vars, vars);
  const path = join(tempDir('wrangler'), 'wrangler.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

/** ADR 0004 §8, verbatim: pinned here, never imported from the module under test. */
const ADR_CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self' https:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'";

const EXPECTED_METADATA = {
  client_id: 'https://music.example.org/oauth/client-metadata.json',
  client_name: 'AT Protocol Music',
  client_uri: 'https://music.example.org',
  redirect_uris: ['https://music.example.org/oauth/callback'],
  scope: 'atproto repo:org.example.music.scrobble repo:org.example.music.follow repo:org.example.music.settings',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  application_type: 'web',
  dpop_bound_access_tokens: true,
};

function metadataValidator() {
  const openapi = JSON.parse(readFileSync(join(REPO, 'api', 'openapi.yaml'), 'utf8')) as {
    components: { schemas: Record<string, object> };
  };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(openapi.components.schemas.OAuthClientMetadata as object);
}

test('production metadata equals expected JSON for https://music.example.org with prefix org.example.music', () => {
  const out = tempDir('public');
  const res = genConfig(['--env', 'production', '--wrangler', EXAMPLE_CONFIG, '--out', out], {
    PUBLIC_ORIGIN: 'https://music.example.org',
    LEXICON_PREFIX: 'org.example.music',
  });
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  expect(listTree(out)).toEqual(['_headers', 'oauth/client-metadata.json']);

  const text = readFileSync(join(out, 'oauth', 'client-metadata.json'), 'utf8');
  const metadata = JSON.parse(text) as typeof EXPECTED_METADATA;
  expect(metadata).toStrictEqual(EXPECTED_METADATA);
  expect(text).toBe(`${JSON.stringify(EXPECTED_METADATA, null, 2)}\n`);
  // client_id is the document's own URL on the configured origin.
  expect(metadata.client_id).toBe(new URL('/oauth/client-metadata.json', 'https://music.example.org').href);

  // The contract schema (api/openapi.yaml OAuthClientMetadata) accepts it.
  const validate = metadataValidator();
  expect(validate(metadata), JSON.stringify(validate.errors)).toBe(true);

  // Unset inputs come from the wrangler env's vars: the same bytes, so no
  // request-time Host or forwarded header can influence the client_id.
  const fromConfig = tempDir('public');
  const res2 = genConfig(['--env', 'production', '--wrangler', EXAMPLE_CONFIG, '--out', fromConfig]);
  expect(res2.status).toBe(0);
  expect(readFileSync(join(fromConfig, 'oauth', 'client-metadata.json'), 'utf8')).toBe(text);

  // An origin other than the configured one is refused and nothing is written.
  const mismatch = tempDir('public');
  const res3 = genConfig(['--env', 'production', '--wrangler', EXAMPLE_CONFIG, '--out', mismatch], {
    PUBLIC_ORIGIN: 'https://attacker.example.net',
    LEXICON_PREFIX: 'org.example.music',
  });
  expect(res3.status).toBe(1);
  expect(res3.stderr).toContain('PUBLIC_ORIGIN differs from wrangler vars.PUBLIC_ORIGIN (https://music.example.org)');
  expect(listTree(mismatch)).toEqual([]);

  // Staging uses its own hostname, hence its own client_id.
  const staging = tempDir('public');
  const res4 = genConfig(['--env', 'staging', '--wrangler', EXAMPLE_CONFIG, '--out', staging]);
  expect(res4.status).toBe(0);
  const stagingMetadata = JSON.parse(readFileSync(join(staging, 'oauth', 'client-metadata.json'), 'utf8'));
  expect(stagingMetadata.client_id).toBe('https://music-staging.example.org/oauth/client-metadata.json');
  expect(stagingMetadata.redirect_uris).toEqual(['https://music-staging.example.org/oauth/callback']);
  expect(validate(stagingMetadata)).toBe(true);
});

test('refuses empty or fixture prefix for production', () => {
  const cases = [
    { prefix: '', reason: 'LEXICON_PREFIX is empty' },
    { prefix: FIXTURE_PREFIX, reason: `LEXICON_PREFIX ${FIXTURE_PREFIX} is fixture-only and must never be published` },
  ];
  for (const { prefix, reason } of cases) {
    // The wrangler config carries the same value, so the refusal is the prefix
    // rule itself and not a mismatch with the config.
    const wrangler = wranglerWith({ PUBLIC_ORIGIN: 'https://music.example.org', LEXICON_PREFIX: prefix });
    const out = tempDir('public');
    // A previous good build's metadata must survive the refusal untouched.
    mkdirSync(join(out, 'oauth'));
    const previous = `${JSON.stringify(EXPECTED_METADATA, null, 2)}\n`;
    writeFileSync(join(out, 'oauth', 'client-metadata.json'), previous);

    for (const vars of [{ LEXICON_PREFIX: prefix }, {}] as Record<string, string>[]) {
      const res = genConfig(['--env', 'production', '--wrangler', wrangler, '--out', out], vars);
      expect(res.status, `prefix "${prefix}" ${JSON.stringify(vars)}`).toBe(1);
      expect(res.stderr).toContain(`gen-config: refused: ${reason}`);
      expect(res.stdout).not.toContain('wrote');
      expect(listTree(out)).toEqual(['oauth/client-metadata.json']);
      expect(readFileSync(join(out, 'oauth', 'client-metadata.json'), 'utf8')).toBe(previous);
    }
  }

  // The same rule holds for staging, which is also a published client.
  const res = genConfig(['--env', 'staging', '--wrangler', EXAMPLE_CONFIG, '--out', tempDir('public')], {
    LEXICON_PREFIX: FIXTURE_PREFIX,
  });
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('fixture-only');

  // The real deployment config passes: its prefix is owned and non-fixture.
  const real = tempDir('public');
  expect(genConfig(['--env', 'production', '--out', real]).status).toBe(0);
  const realMetadata = JSON.parse(readFileSync(join(real, 'oauth', 'client-metadata.json'), 'utf8'));
  expect(realMetadata.client_id).toBe('https://music.214510.xyz/oauth/client-metadata.json');
  expect(realMetadata.scope).toBe(
    'atproto repo:dev.pythonplayer123.music.scrobble repo:dev.pythonplayer123.music.follow repo:dev.pythonplayer123.music.settings',
  );
});

test('local env writes only the loopback client-id hint and removes stale metadata', () => {
  const out = tempDir('public');
  mkdirSync(join(out, 'oauth'));
  writeFileSync(join(out, 'oauth', 'client-metadata.json'), '{"stale":true}\n');
  // A deployed build's _headers would make wrangler dev apply the strict CSP,
  // whose connect-src 'self' https: blocks the http:// loopback PDS/PLC.
  writeFileSync(join(out, '_headers'), `/*\n  Content-Security-Policy: ${ADR_CSP}\n`);
  const res = genConfig(['--env', 'local', '--out', out], { LEXICON_PREFIX: FIXTURE_PREFIX });
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  expect(listTree(out)).toEqual(['oauth/loopback-client.json']);
  expect(res.stdout).toContain(`wrote ${join(out, 'oauth', 'loopback-client.json')}`);
  expect(res.stdout).not.toContain('_headers');
  const hint = JSON.parse(readFileSync(join(out, 'oauth', 'loopback-client.json'), 'utf8'));
  const scope = `atproto repo:${FIXTURE_PREFIX}.scrobble repo:${FIXTURE_PREFIX}.follow repo:${FIXTURE_PREFIX}.settings`;
  expect(hint).toStrictEqual({
    client_id: `http://localhost?${new URLSearchParams({ redirect_uri: 'http://127.0.0.1:8787/oauth/callback', scope })}`,
    redirect_uri: 'http://127.0.0.1:8787/oauth/callback',
    scope,
  });
  const clientId = new URL(hint.client_id);
  expect(clientId.origin).toBe('http://localhost');
  expect(clientId.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/oauth/callback');
  expect(clientId.searchParams.get('scope')).toBe(scope);

  // A non-loopback local origin is refused.
  const bad = genConfig(['--env', 'local', '--out', tempDir('public')], { PUBLIC_ORIGIN: 'http://192.168.1.5:8787' });
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('PUBLIC_ORIGIN for local must be http://127.0.0.1');
});

test('refuses a deployed env whose resolved routes are missing or off the PUBLIC_ORIGIN host', () => {
  type Config = Record<string, unknown> & { env: Record<string, Record<string, unknown>> };
  const base = parseJsonc(readFileSync(EXAMPLE_CONFIG, 'utf8')) as Config;
  const run = (env: string, mutate: (config: Config) => void): CliResult & { out: string[] } => {
    const config = structuredClone(base);
    mutate(config);
    const path = join(tempDir('wrangler'), 'wrangler.json');
    writeFileSync(path, JSON.stringify(config));
    const out = tempDir('public');
    const res = genConfig(['--env', env, '--wrangler', path, '--out', out]);
    return { ...res, out: listTree(out) };
  };
  const refused = (res: CliResult & { out: string[] }, message: string) => {
    expect(res.status, message).toBe(1);
    expect(res.stderr).toContain(`gen-config: refused: ${message}`);
    expect(res.stdout).not.toContain('wrote');
    expect(res.out).toEqual([]);
  };

  // Staging without its own routes inherits the production custom domain
  // (wrangler deploys atmusic-staging there), so it is refused.
  refused(
    run('staging', (c) => {
      delete c.env.staging!.routes;
    }),
    'route music.example.org is not on PUBLIC_ORIGIN host music-staging.example.org',
  );
  // A top-level singular `route` deploys like `routes`.
  refused(
    run('production', (c) => {
      c.route = 'evil.example.net/*';
    }),
    'route evil.example.net is not on PUBLIC_ORIGIN host music.example.org',
  );
  refused(
    run('production', (c) => {
      delete c.routes;
      c.route = { pattern: 'evil.example.net/*', zone_name: 'example.net' };
    }),
    'route evil.example.net is not on PUBLIC_ORIGIN host music.example.org',
  );
  // ...and is inherited by a named env next to its own `routes`.
  refused(
    run('staging', (c) => {
      c.route = 'evil.example.net/*';
    }),
    'route evil.example.net is not on PUBLIC_ORIGIN host music-staging.example.org',
  );
  // No route at all, at the top level or in a named env with nothing to inherit.
  refused(
    run('production', (c) => {
      delete c.routes;
    }),
    'no route: a deployed env must route its custom domain, the PUBLIC_ORIGIN host',
  );
  refused(
    run('staging', (c) => {
      delete c.routes;
      c.env.staging!.routes = [];
    }),
    'no route: a deployed env must route its custom domain, the PUBLIC_ORIGIN host',
  );

  // Routes on the PUBLIC_ORIGIN host pass, in either spelling.
  const singular = run('production', (c) => {
    delete c.routes;
    c.route = 'music.example.org/*';
  });
  expect(singular.stderr).toBe('');
  expect(singular.status).toBe(0);
  expect(singular.out).toEqual(['_headers', 'oauth/client-metadata.json']);
  const own = run('staging', () => {});
  expect(own.status).toBe(0);
  expect(own.out).toEqual(['_headers', 'oauth/client-metadata.json']);
});

test('prefix rule and fixture prefix match worker/src/config.ts', async () => {
  const worker = (await import(pathToFileURL(join(REPO, 'worker', 'src', 'config.ts')).href)) as {
    FIXTURE_PREFIX: string;
    isValidPrefix(p: string): boolean;
  };
  expect(FIXTURE_PREFIX).toBe(worker.FIXTURE_PREFIX);
  const samples = [
    'org.example.music',
    'dev.pythonplayer123.music',
    'com.example.atmusic',
    'music',
    'Org.example',
    'org..example',
    'org.example/music',
    '1org.example',
    'org.-bad.example',
    `org.${'a'.repeat(64)}`,
    `org.${'a.'.repeat(130)}x`,
  ];
  for (const s of samples) expect(isValidPrefix(s), s).toBe(worker.isValidPrefix(s));
});

/** Serves a generated public dir through wrangler's local Static Assets server. */
async function serveGenerated(out: string) {
  const project = tempDir('assets-project');
  const assets = join(project, 'assets');
  mkdirSync(join(assets, 'assets'), { recursive: true });
  for (const file of listTree(out)) {
    mkdirSync(dirname(join(assets, file)), { recursive: true });
    writeFileSync(join(assets, file), readFileSync(join(out, file)));
  }
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>atmusic</title>\n');
  writeFileSync(join(assets, 'assets', 'index-3f2a9c1d.js'), 'export const app = 1;\n');
  mkdirSync(join(project, 'src'));
  writeFileSync(
    join(project, 'src', 'index.ts'),
    "export default { async fetch() { return new Response('worker', { status: 418 }); } };\n",
  );
  writeFileSync(
    join(project, 'wrangler.json'),
    JSON.stringify({
      name: 'atmusic-headers-test',
      main: 'src/index.ts',
      compatibility_date: '2026-10-01',
      assets: {
        directory: 'assets',
        binding: 'ASSETS',
        not_found_handling: 'single-page-application',
        run_worker_first: ['/api/*'],
      },
    }),
  );
  process.env.WRANGLER_SEND_METRICS = 'false';
  return unstable_dev(join(project, 'src', 'index.ts'), {
    config: join(project, 'wrangler.json'),
    experimental: { disableExperimentalWarning: true },
    logLevel: 'error',
    ip: '127.0.0.1',
  });
}

function generateProduction(): string {
  const out = tempDir('public');
  const res = genConfig(['--env', 'production', '--wrangler', EXAMPLE_CONFIG, '--out', out]);
  expect(res.status).toBe(0);
  return out;
}

test("_headers contains require-trusted-types-for and frame-ancestors 'none'", async () => {
  const out = generateProduction();
  const text = readFileSync(join(out, '_headers'), 'utf8');
  expect(text).toContain("require-trusted-types-for 'script'");
  expect(text).toContain("frame-ancestors 'none'");
  expect(text).toContain(`  Content-Security-Policy: ${ADR_CSP}\n`);

  const worker = await serveGenerated(out);
  try {
    for (const path of ['/', '/feed', '/assets/index-3f2a9c1d.js', '/oauth/client-metadata.json']) {
      const res = await worker.fetch(path, { redirect: 'manual' });
      expect(res.status, path).toBe(200);
      const csp = res.headers.get('content-security-policy');
      expect(csp, path).toBe(ADR_CSP);
      const directives = (csp ?? '').split(';').map((d) => d.trim());
      expect(directives).toEqual([
        "default-src 'self'",
        "script-src 'self'",
        "connect-src 'self' https:",
        "img-src 'self' data:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "require-trusted-types-for 'script'",
      ]);
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      await res.arrayBuffer();
    }
    // API responses come from the Worker, which sets its own headers.
    const api = await worker.fetch('/api/v1/meta');
    expect(api.status).toBe(418);
    expect(api.headers.get('content-security-policy')).toBeNull();
    await api.arrayBuffer();
  } finally {
    await worker.stop();
  }
});

test('_headers marks /assets/* public, max-age=31536000, immutable and /index.html and /oauth/client-metadata.json no-cache', async () => {
  const out = generateProduction();
  const worker = await serveGenerated(out);
  try {
    const asset = await worker.fetch('/assets/index-3f2a9c1d.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    // Exactly one value: no site-wide Cache-Control is comma-joined into it.
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await asset.text()).toBe('export const app = 1;\n');

    // Static Assets redirect /index.html to /, and serve index.html there.
    const indexHtml = await worker.fetch('/index.html', { redirect: 'manual' });
    expect(indexHtml.headers.get('cache-control')).toBe('no-cache');
    await indexHtml.arrayBuffer();
    const root = await worker.fetch('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toMatch(/^text\/html/);
    expect(root.headers.get('cache-control')).toBe('no-cache');
    expect(await root.text()).toContain('<title>atmusic</title>');

    const metadata = await worker.fetch('/oauth/client-metadata.json');
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('content-type')).toMatch(/^application\/json/);
    expect(metadata.headers.get('cache-control')).toBe('no-cache');
    expect(await metadata.json()).toStrictEqual(EXPECTED_METADATA);

    // The _headers file itself is configuration, not a served asset.
    const headersFile = await worker.fetch('/_headers');
    expect(await headersFile.text()).not.toContain('Content-Security-Policy:');
  } finally {
    await worker.stop();
  }
});
