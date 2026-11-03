import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import { NODE_OAUTH_ENV, spec } from '../live/node_oauth_check.ts';
import { NODE_ENV, type NodeGateIO, runNodeGate } from '../live/node-live-gate.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = createRequire(resolve(REPO, 'package.json')).resolve('tsx/cli');
const DRIVER = resolve(REPO, 'scripts/live/node_oauth_check.ts');

function cleanLiveEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('ATMUSIC_LIVE_')) delete env[name];
  return env;
}

function capture() {
  let stdout = '';
  let stderr = '';
  const io: NodeGateIO = {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    writeEvidence: () => {
      throw new Error('no evidence path was supplied');
    },
    now: () => new Date('2026-08-15T12:00:00.000Z'),
  };
  return { io, output: () => ({ stdout, stderr }) };
}

function completeEnv(): Record<string, string> {
  return {
    [NODE_ENV.commit]: '1'.repeat(40),
    [NODE_ENV.bundleSha256]: 'a'.repeat(64),
    [NODE_ENV.origin]: 'https://music.atproto-music.org',
    [NODE_ENV.prefix]: 'org.atproto.music',
    ATMUSIC_LIVE_DID_A: 'did:plc:abcdefghijklmnopqrstuvwx',
    ATMUSIC_LIVE_PDS_A: 'https://pds-a.atproto-music.org',
    ATMUSIC_LIVE_DID_B: 'did:plc:bcdefghijklmnopqrstuvwxy',
    ATMUSIC_LIVE_PDS_B: 'https://pds-b.music-host.net',
    ATMUSIC_LIVE_PDS_INDEPENDENCE_REF: 'operator evidence reference',
    ATMUSIC_LIVE_PDS_A_IMPLEMENTATION: '@atproto/pds',
    ATMUSIC_LIVE_PDS_B_IMPLEMENTATION: 'PDS implementation 2.1',
    [NODE_OAUTH_ENV.handleA]: 'alice.pds-a.example.net',
    [NODE_OAUTH_ENV.handleB]: 'bob.pds-b.example.net',
    [NODE_OAUTH_ENV.passwordA]: 'synthetic-account-password-a',
    [NODE_OAUTH_ENV.passwordB]: 'synthetic-account-password-b',
  };
}

test('with every ATMUSIC_LIVE_* unset it exits 2 with a blocked document naming the missing variables and makes no network request', () => {
  const result = spawnSync(process.execPath, [TSX, DRIVER], {
    cwd: REPO,
    env: cleanLiveEnv(),
    encoding: 'utf8',
    timeout: 30_000,
  });

  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain('no live request was made');
  const evidence = JSON.parse(result.stdout) as {
    schemaVersion: number;
    runtime: string;
    gate: string;
    result: string;
    missing: string[];
  };
  expect(evidence).toMatchObject({
    schemaVersion: 3,
    runtime: 'node',
    fixtureOnly: false,
    gate: 'oauth',
    result: 'blocked',
  });
  for (const name of [
    NODE_ENV.commit,
    NODE_ENV.bundleSha256,
    NODE_ENV.origin,
    NODE_ENV.prefix,
    'ATMUSIC_LIVE_DID_A',
    'ATMUSIC_LIVE_PDS_A',
    'ATMUSIC_LIVE_DID_B',
    'ATMUSIC_LIVE_PDS_B',
    'ATMUSIC_LIVE_PDS_INDEPENDENCE_REF',
    'ATMUSIC_LIVE_PDS_A_IMPLEMENTATION',
    'ATMUSIC_LIVE_PDS_B_IMPLEMENTATION',
    NODE_OAUTH_ENV.handleA,
    NODE_OAUTH_ENV.handleB,
  ]) {
    expect(
      evidence.missing.some((entry) => entry.startsWith(`${name}:`)),
      name,
    ).toBe(true);
  }
  expect(evidence.missing.some((entry) => entry.includes(NODE_OAUTH_ENV.passwordA))).toBe(true);
  expect(evidence.missing.some((entry) => entry.includes(NODE_OAUTH_ENV.passwordB))).toBe(true);
  expect(evidence.missing.some((entry) => entry.includes(NODE_OAUTH_ENV.interactive))).toBe(true);
});

test('a complete operator environment remains blocked before invoking OAuth or networking', async () => {
  const run = vi.fn(spec.run);
  const fetch = vi.fn(async () => {
    throw new Error('unexpected network request');
  });
  vi.stubGlobal('fetch', fetch);
  const result = capture();
  try {
    expect(await runNodeGate({ ...spec, run }, completeEnv(), result.io)).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const evidence = JSON.parse(result.output().stdout) as { result: string; missing: string[] };
    expect(evidence.result).toBe('blocked');
    expect(evidence.missing).toHaveLength(1);
    expect(
      evidence.missing.some((entry) => entry.includes('upstream revocation observations are not implemented')),
    ).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('importing the Node OAuth gate is inert', () => {
  const result = spawnSync(
    process.execPath,
    [TSX, '-e', `void import(${JSON.stringify(pathToFileURL(DRIVER).href)})`],
    {
      cwd: REPO,
      env: cleanLiveEnv(),
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});
