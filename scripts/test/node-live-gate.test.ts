import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import {
  NODE_ENV,
  type NodeGateBodyResult,
  type NodeGateEvidence,
  type NodeGateIO,
  type NodeGateSpec,
  runNodeGate,
} from '../live/node-live-gate.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = createRequire(resolve(REPO, 'package.json')).resolve('tsx/cli');
const GOOD_COMMIT = '1'.repeat(40);
const GOOD_BUNDLE = 'a'.repeat(64);

function validEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [NODE_ENV.origin]: 'https://music.atproto-music.org',
    [NODE_ENV.prefix]: 'org.atproto.music',
    [NODE_ENV.commit]: GOOD_COMMIT,
    [NODE_ENV.bundleSha256]: GOOD_BUNDLE,
    ATMUSIC_LIVE_ADMIN_TOKEN: 'operator-secret-token-value',
    ...extra,
  };
}

function ioCapture() {
  let stdout = '';
  let stderr = '';
  const files: Array<{ path: string; text: string }> = [];
  const io: NodeGateIO = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    writeEvidence: (path, text) => files.push({ path, text }),
    now: () => new Date('2026-08-15T12:00:00.000Z'),
  };
  return { io, files, output: () => ({ stdout, stderr }) };
}

const emptyBody: NodeGateBodyResult = { pds: [], subjects: [], results: { checked: true } };

function spec(run: NodeGateSpec['run'] = async () => emptyBody): NodeGateSpec {
  return {
    gate: 'ingest',
    script: 'scripts/live/node_ingest_check.ts',
    requirements: [
      {
        name: 'ATMUSIC_LIVE_TEST_PREREQUISITE',
        what: 'fixture-only prerequisite used by this harness regression',
        check: (value) => (value === 'ready' ? null : 'must equal ready'),
      },
    ],
    run,
  };
}

function documentFrom(text: string): NodeGateEvidence {
  return JSON.parse(text) as NodeGateEvidence;
}

test('missing and malformed prerequisites block before the body and list every problem', async () => {
  const body = vi.fn(async () => emptyBody);
  const capture = ioCapture();
  const exit = await runNodeGate(spec(body), {}, capture.io);
  const evidence = documentFrom(capture.output().stdout);

  expect(exit).toBe(2);
  expect(body).not.toHaveBeenCalled();
  expect(evidence.result).toBe('blocked');
  expect(evidence.runtime).toBe('node');
  expect(evidence.schemaVersion).toBe(3);
  expect(evidence.missing).toEqual(
    expect.arrayContaining([
      expect.stringContaining(NODE_ENV.commit),
      expect.stringContaining(NODE_ENV.bundleSha256),
      expect.stringContaining(NODE_ENV.origin),
      expect.stringContaining(NODE_ENV.prefix),
      expect.stringContaining('ATMUSIC_LIVE_TEST_PREREQUISITE'),
    ]),
  );
  expect(capture.output().stderr).toContain('no live request was made');
});

test('zero or malformed release identity is blocked and never reaches the body', async () => {
  const body = vi.fn(async () => emptyBody);
  for (const env of [
    validEnv({ [NODE_ENV.commit]: '0'.repeat(40), ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }),
    validEnv({ [NODE_ENV.bundleSha256]: '0'.repeat(64), ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }),
    validEnv({ [NODE_ENV.commit]: 'not-a-commit', ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }),
    validEnv({ [NODE_ENV.bundleSha256]: 'not-a-hash', ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }),
  ]) {
    const capture = ioCapture();
    expect(await runNodeGate(spec(body), env, capture.io)).toBe(2);
    expect(documentFrom(capture.output().stdout).result).toBe('blocked');
  }
  expect(body).not.toHaveBeenCalled();
});

test('a prefix rejected by the independent verifier is blocked before the body', async () => {
  const body = vi.fn(async () => emptyBody);
  const capture = ioCapture();
  const env = validEnv({
    [NODE_ENV.prefix]: 'org.123music',
    ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready',
  });

  expect(await runNodeGate(spec(body), env, capture.io)).toBe(2);
  expect(body).not.toHaveBeenCalled();
  expect(documentFrom(capture.output().stdout).missing).toContainEqual(
    expect.stringContaining(`${NODE_ENV.prefix}: invalid`),
  );
});

test('emits schema-v3 top-level identity for a successful injected body', async () => {
  const capture = ioCapture();
  const exit = await runNodeGate(
    spec(async ({ origin, lexiconPrefix, get }) => ({
      pds: [{ endpoint: 'https://pds-one.example.org', implementation: 'PDS', version: '1.0' }],
      subjects: [{ did: 'did:plc:abcdefghijklmnopqrstuvwx', uri: null }],
      results: { origin, lexiconPrefix, declared: get('ATMUSIC_LIVE_TEST_PREREQUISITE') },
    })),
    validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }),
    capture.io,
  );
  const evidence = documentFrom(capture.output().stdout);

  expect(exit).toBe(0);
  expect(evidence).toMatchObject({
    schemaVersion: 3,
    runtime: 'node',
    fixtureOnly: false,
    gate: 'ingest',
    result: 'passed',
    commit: GOOD_COMMIT,
    bundleSha256: GOOD_BUNDLE,
    recordedAt: '2026-08-15T12:00:00.000Z',
    origin: 'https://music.atproto-music.org',
    lexiconPrefix: 'org.atproto.music',
  });
});

test('injected failures are failed results with details and supplied secrets redacted', async () => {
  const capture = ioCapture();
  const env = validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' });
  const exit = await runNodeGate(
    spec(async () => {
      throw new Error(`revocation returned ${env.ATMUSIC_LIVE_ADMIN_TOKEN}`);
    }),
    env,
    capture.io,
  );
  const { stdout, stderr } = capture.output();
  const evidence = documentFrom(stdout);

  expect(exit).toBe(1);
  expect(evidence.result).toBe('failed');
  expect(evidence.failures?.[0]).toContain('[redacted]');
  expect(stdout).not.toContain(env.ATMUSIC_LIVE_ADMIN_TOKEN);
  expect(stderr).not.toContain(env.ATMUSIC_LIVE_ADMIN_TOKEN);
  expect(stdout).toContain('[redacted]');
});

test('secrets containing JSON escapes are redacted before serialization', async () => {
  const capture = ioCapture();
  const secret = 'private"\\\nkey-value';
  const env = validEnv({
    ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready',
    ATMUSIC_LIVE_PDS_PASSWORD: secret,
  });
  await runNodeGate(
    spec(async () => ({ ...emptyBody, results: { credential: secret } })),
    env,
    capture.io,
  );

  const stdout = capture.output().stdout;
  expect(stdout).not.toContain(secret);
  expect(documentFrom(stdout).results).toEqual({ credential: '[redacted]' });
});

test('a recorded nonfatal failure cannot be emitted as passed', async () => {
  const capture = ioCapture();
  const exit = await runNodeGate(
    spec(async (context) => {
      context.fail('the PDS did not return the expected state');
      return emptyBody;
    }),
    validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }),
    capture.io,
  );

  expect(exit).toBe(1);
  expect(documentFrom(capture.output().stdout)).toMatchObject({
    result: 'failed',
    failures: ['the PDS did not return the expected state'],
  });
});

test('body output cannot override the harness gate identity or failure classification', async () => {
  const capture = ioCapture();
  const exit = await runNodeGate(
    spec(async (context) => {
      context.fail('the expected record was missing');
      return {
        ...emptyBody,
        gate: 'ssrfProbe',
        result: 'passed',
        commit: '0'.repeat(40),
        bundleSha256: '0'.repeat(64),
        failures: [],
      } as unknown as NodeGateBodyResult;
    }),
    validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }),
    capture.io,
  );

  expect(exit).toBe(1);
  expect(documentFrom(capture.output().stdout)).toMatchObject({
    gate: 'ingest',
    result: 'failed',
    commit: GOOD_COMMIT,
    bundleSha256: GOOD_BUNDLE,
    failures: ['the expected record was missing'],
  });
});

test('evidence output path is written with the same redacted JSON document', async () => {
  const capture = ioCapture();
  const env = validEnv({
    ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready',
    [NODE_ENV.evidenceOut]: '/tmp/node-live-gate.json',
  });
  await runNodeGate(
    spec(async () => ({ ...emptyBody, results: { token: env.ATMUSIC_LIVE_ADMIN_TOKEN } })),
    env,
    capture.io,
  );
  expect(capture.files).toHaveLength(1);
  expect(capture.files[0]?.text).toBe(capture.output().stdout);
  expect(capture.files[0]?.text).not.toContain(env.ATMUSIC_LIVE_ADMIN_TOKEN);
});

test('importing the harness performs no work or output', () => {
  const moduleUrl = pathToFileURL(resolve(REPO, 'scripts/live/node-live-gate.ts')).href;
  const result = spawnSync(process.execPath, [TSX, '-e', `void import(${JSON.stringify(moduleUrl)})`], {
    cwd: REPO,
    env: { ...process.env, ATMUSIC_LIVE_ORIGIN: '', ATMUSIC_LIVE_EVIDENCE_OUT: '' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});
