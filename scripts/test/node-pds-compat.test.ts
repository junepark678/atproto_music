import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import { spec } from '../live/node_pds_compat_check.ts';
import { NODE_ENV, type NodeGateIO, runNodeGate } from '../live/node-live-gate.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = createRequire(resolve(REPO, 'package.json')).resolve('tsx/cli');
const DRIVER = resolve(REPO, 'scripts/live/node_pds_compat_check.ts');

function liveEnvUnset(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('ATMUSIC_LIVE_')) delete env[name];
  }
  return env;
}

function capturedIO() {
  let stdout = '';
  let stderr = '';
  const io: NodeGateIO = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    writeEvidence: () => {
      throw new Error('test should not write evidence');
    },
    now: () => new Date('2026-08-15T12:00:00.000Z'),
  };
  return { io, output: () => ({ stdout, stderr }) };
}

test('no environment exits 2 with the Node blocked document and every PDS prerequisite', () => {
  const result = spawnSync(process.execPath, [TSX, DRIVER], {
    cwd: REPO,
    env: liveEnvUnset(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  const evidence = JSON.parse(result.stdout) as {
    schemaVersion: number;
    runtime: string;
    gate: string;
    result: string;
    missing: string[];
  };

  expect(result.status).toBe(2);
  expect(evidence).toMatchObject({ schemaVersion: 3, runtime: 'node', gate: 'pdsCompat', result: 'blocked' });
  for (const name of [
    NODE_ENV.commit,
    NODE_ENV.bundleSha256,
    NODE_ENV.origin,
    NODE_ENV.prefix,
    'ATMUSIC_LIVE_DID_A',
    'ATMUSIC_LIVE_PDS_A',
    'ATMUSIC_LIVE_DID_B',
    'ATMUSIC_LIVE_PDS_B',
    'ATMUSIC_LIVE_PDS_A_IMPLEMENTATION',
    'ATMUSIC_LIVE_PDS_B_IMPLEMENTATION',
    'ATMUSIC_LIVE_PDS_INDEPENDENCE_REF',
    'ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF',
  ]) {
    expect(evidence.missing.map((entry) => entry.slice(0, entry.indexOf(':')))).toContain(name);
  }
  expect(evidence.missing.join('\n')).not.toContain('ATMUSIC_LIVE_WORKER_VERSION_ID');
  expect(evidence.missing.join('\n')).not.toContain('ATMUSIC_LIVE_ADMIN_TOKEN');
  expect(result.stderr).toContain('no live request was made');
});

test('driver requirements block before any network hook is reached', async () => {
  const capture = capturedIO();
  const fetchSpy = vi.fn(async () => {
    throw new Error('network should not be touched');
  });
  vi.stubGlobal('fetch', fetchSpy);
  try {
    const exit = await runNodeGate(spec, {}, capture.io);
    expect(exit).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(capture.output().stdout).result).toBe('blocked');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('importing the Node PDS compatibility driver performs no work or output', () => {
  const moduleUrl = pathToFileURL(DRIVER).href;
  const importExpression = ['void import(', JSON.stringify(moduleUrl), ')'].join('');
  const result = spawnSync(process.execPath, [TSX, '-e', importExpression], {
    cwd: REPO,
    env: liveEnvUnset(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});
