import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import { checkDeployment, pdsInfo } from '../live/live-gate.ts';
import { spec } from '../live/node_pds_compat_check.ts';
import { NODE_ENV, type NodeGateIO, runNodeGate } from '../live/node-live-gate.ts';
import { checkPds } from '../live/pds_compat_check.ts';

vi.mock('../live/live-gate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../live/live-gate.ts')>();
  return { ...actual, checkDeployment: vi.fn(), pdsInfo: vi.fn() };
});
vi.mock('../live/pds_compat_check.ts', () => ({ checkPds: vi.fn() }));

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

function completeEnv(): NodeJS.ProcessEnv {
  return {
    [NODE_ENV.commit]: '1'.repeat(40),
    [NODE_ENV.bundleSha256]: 'a'.repeat(64),
    [NODE_ENV.origin]: 'https://music.atproto-music.org',
    [NODE_ENV.prefix]: 'org.atproto.music',
    ATMUSIC_LIVE_DID_A: 'did:plc:abcdefghijklmnopqrstuvwx',
    ATMUSIC_LIVE_PDS_A: 'https://pds-a.atproto-music.org',
    ATMUSIC_LIVE_DID_B: 'did:plc:bcdefghijklmnopqrstuvwxy',
    ATMUSIC_LIVE_PDS_B: 'https://pds-b.music-host.net',
    ATMUSIC_LIVE_PDS_A_IMPLEMENTATION: '@atproto/pds',
    ATMUSIC_LIVE_PDS_B_IMPLEMENTATION: 'PDS fork 2.1',
    ATMUSIC_LIVE_PDS_INDEPENDENCE_REF: 'operator evidence link',
    ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF: 'coverage report link',
  };
}

function setMockObservations(getRecordInclusion: boolean): void {
  vi.mocked(checkDeployment).mockResolvedValue({ version: '1.0', stage: 'production' });
  vi.mocked(pdsInfo).mockImplementation(async (endpoint, implementation) => ({
    endpoint: new URL(endpoint).origin,
    implementation,
    version: '1.0.0',
  }));
  vi.mocked(checkPds).mockImplementation(async (_context, did, endpoint) => ({
    compat: {
      endpoint,
      did,
      getRecordInclusion,
      getRecordExclusion: true,
      getBlocks: true,
      getRepoStatus: true,
      snapshotAbsence: null,
      notes: [],
    },
    subject: { did, uri: `at://${did}/org.atproto.music.scrobble/2222222222222` },
  }));
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

test('two complete PDS observations produce Node v3 compatibility evidence', async () => {
  setMockObservations(true);
  const capture = capturedIO();
  try {
    expect(await runNodeGate(spec, completeEnv(), capture.io), capture.output().stdout).toBe(0);
    const evidence = JSON.parse(capture.output().stdout) as {
      pds: unknown[];
      subjects: unknown[];
      results: { perPds: Array<Record<string, unknown>> };
    };
    expect(evidence.pds).toHaveLength(2);
    expect(evidence.subjects).toHaveLength(2);
    expect(evidence.results.perPds).toHaveLength(2);
    expect(evidence.results.perPds.every((pds) => pds.getRecordInclusion === true)).toBe(true);
    expect(checkPds).toHaveBeenCalledTimes(2);
  } finally {
    vi.resetAllMocks();
  }
});

test('a missing mandatory inclusion proof fails rather than passing', async () => {
  setMockObservations(false);
  const capture = capturedIO();
  try {
    expect(await runNodeGate(spec, completeEnv(), capture.io)).toBe(1);
    expect(JSON.parse(capture.output().stdout)).toMatchObject({
      gate: 'pdsCompat',
      result: 'failed',
      failures: expect.arrayContaining([expect.stringContaining('no verified getRecord inclusion proof')]),
    });
  } finally {
    vi.resetAllMocks();
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
