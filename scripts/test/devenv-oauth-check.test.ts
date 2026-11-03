import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const good = {
  ATMUSIC_DEVENV_PDS_URL: 'http://127.0.0.1:2583',
  ATMUSIC_DEVENV_HTTPS_ORIGIN: 'https://music.example.test',
  ATMUSIC_DEVENV_CLIENT_ID: 'https://music.example.test/oauth/client-metadata.json',
  ATMUSIC_DEVENV_CLIENT_SECRET: 'private-test-secret',
};

test('imports and all preflight paths are inert across transports', async () => {
  const attempts: string[] = [];
  const restorers: (() => void)[] = [];
  const trap = (target: object, key: string) => {
    if (!(key in target)) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value: () => {
        attempts.push(key);
        throw new Error(`Forbidden transport: ${key}`);
      },
    });
    restorers.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    });
  };
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    trap(globalThis, 'fetch');
    trap(globalThis, 'WebSocket');
    for (const [name, keys] of Object.entries({
      'node:http': ['request', 'get'],
      'node:https': ['request', 'get'],
      'node:net': ['connect', 'createConnection', 'createServer'],
      'node:tls': ['connect', 'createServer'],
      'node:dns': ['lookup', 'resolve', 'resolve4', 'resolve6'],
      'node:dns/promises': ['lookup', 'resolve', 'resolve4', 'resolve6'],
      'node:child_process': ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
      undici: ['fetch', 'request', 'stream', 'pipeline', 'connect', 'upgrade', 'WebSocket', 'Client', 'Pool', 'Agent'],
    })) {
      const module = require(name);
      for (const key of keys) trap(module, key);
    }
    trap(require('node:net').Socket.prototype, 'connect');
    syncBuiltinESMExports();
    const { runDevenvOauthCheck, DEVENV_OAUTH_ENV } = await import('../live/devenv_oauth_check.ts');
    expect(output).not.toHaveBeenCalled();
    const run = (env: Record<string, string | undefined>) => {
      output.mockClear();
      expect(runDevenvOauthCheck(env)).toBe(2);
      const text = String(output.mock.calls[0]?.[0]);
      expect(text).not.toContain(good.ATMUSIC_DEVENV_CLIENT_SECRET);
      const evidence = JSON.parse(text);
      expect(evidence).toMatchObject({
        schemaVersion: 3,
        runtime: 'node',
        fixtureOnly: true,
        gate: 'devenvOauth',
        result: 'blocked',
      });
      return evidence;
    };
    expect(run({}).missing).toEqual(DEVENV_OAUTH_ENV);
    for (const name of DEVENV_OAUTH_ENV) {
      expect(run({ ...good, [name]: undefined }).missing).toEqual([name]);
      expect(run({ ...good, [name]: ' ' }).missing).toEqual([name]);
    }
    for (const origin of [
      'http://localhost',
      'broken',
      'https://user:pass@example.test',
      'https://example.test/path',
      'https://example.test?q=1',
      'https://example.test/#x',
    ]) {
      expect(run({ ...good, ATMUSIC_DEVENV_HTTPS_ORIGIN: origin }).invalid).toContain('ATMUSIC_DEVENV_HTTPS_ORIGIN');
    }
    expect(run({ ...good, ATMUSIC_DEVENV_PDS_URL: 'file:///tmp/pds' }).invalid).toContain('ATMUSIC_DEVENV_PDS_URL');
    expect(run(good).reason).toContain('not implemented');
    expect(attempts).toEqual([]);
  } finally {
    for (const restore of restorers.reverse()) restore();
    syncBuiltinESMExports();
    output.mockRestore();
  }
});

test('CLI exits 2 and emits blocked advisory evidence without prerequisites', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ATMUSIC_')));
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/live/devenv_oauth_check.ts')], {
    env,
    encoding: 'utf8',
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ gate: 'devenvOauth', fixtureOnly: true, result: 'blocked' });
});
