import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { expect, test, vi } from 'vitest';
import { ENV } from '../live/live-gate.ts';
import { type IngestDependencies, NODE_INGEST_ENV, runNodeIngest, spec } from '../live/node_ingest_check.ts';
import { NODE_ENV, type NodeGateContext, type NodeGateIO, runNodeGate } from '../live/node-live-gate.ts';
import { OAUTH_ENV } from '../live/workers_oauth_check.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = createRequire(resolve(REPO, 'package.json')).resolve('tsx/cli');
const DID_A = 'did:plc:abcdefghijklmnopqrstuvwx';
const DID_B = 'did:plc:zyxwvutsrqponmlkjihgfedc';
const URI_A = `at://${DID_A}/org.atproto.music.scrobble/3jzfcijpj2z2a`;
const URI_B = `at://${DID_B}/org.atproto.music.scrobble/3jzfcijpj2z2b`;
const CID_A = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CID_B = 'bafyreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REV_PRESENT = '3jzfcijpj2z2a';
const REV_ABSENT = '3jzfcijpj2z2b';

const goodEnv: Record<string, string> = {
  [NODE_ENV.origin]: 'https://music.atproto-music.org',
  [NODE_ENV.prefix]: 'org.atproto.music',
  [NODE_ENV.commit]: '1'.repeat(40),
  [NODE_ENV.bundleSha256]: 'a'.repeat(64),
  [ENV.didA]: DID_A,
  [ENV.pdsA]: 'https://pds-a.music.net',
  [ENV.didB]: DID_B,
  [ENV.pdsB]: 'https://pds-b.music.net',
  [ENV.pdsAImplementation]: 'PDS A',
  [ENV.pdsBImplementation]: 'PDS B',
  [ENV.pdsIndependenceRef]: 'operator evidence ref',
  [ENV.jetstreamCoverageRef]: 'coverage evidence ref',
  [OAUTH_ENV.handleA]: 'alice.music.net',
  [OAUTH_ENV.handleB]: 'bob.music.net',
  [OAUTH_ENV.interactive]: '1',
  [NODE_INGEST_ENV.appPasswordB]: 'pds-b-app-password-test',
};

function makeContext(failures: string[] = [], cleanup: string[] = []): NodeGateContext {
  return {
    env: goodEnv,
    get: (name) => {
      const value = goodEnv[name];
      if (!value) throw new Error(`missing ${name}`);
      return value;
    },
    origin: goodEnv[NODE_ENV.origin]!,
    lexiconPrefix: goodEnv[NODE_ENV.prefix]!,
    log: () => undefined,
    fail: (message) => failures.push(message),
    cleanup: (message) => cleanup.push(message),
  };
}

function ioCapture() {
  let stdout = '';
  let stderr = '';
  const io: NodeGateIO = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    writeEvidence: () => undefined,
    now: () => new Date('2026-11-03T00:00:00.000Z'),
  };
  return { io, output: () => ({ stdout, stderr }) };
}

function assertVerifierPairing(body: Awaited<ReturnType<typeof runNodeIngest>>, cleanup: string[]) {
  const entry = {
    schemaVersion: 3,
    runtime: 'node',
    fixtureOnly: false,
    gate: 'ingest',
    result: 'passed',
    commit: goodEnv[NODE_ENV.commit],
    bundleSha256: goodEnv[NODE_ENV.bundleSha256],
    recordedAt: '2026-11-03T00:00:00.000Z',
    testCommand: 'npx tsx scripts/live/node_ingest_check.ts',
    origin: goodEnv[NODE_ENV.origin],
    lexiconPrefix: goodEnv[NODE_ENV.prefix],
    pds: body.pds,
    subjects: body.subjects,
    results: body.results,
    cleanup: cleanup.join('; '),
  };
  const prereq = {
    publicHttpsOrigin: goodEnv[NODE_ENV.origin],
    ownedLexiconPrefix: goodEnv[NODE_ENV.prefix],
    identities: [
      { did: DID_A, pds: goodEnv[ENV.pdsA] },
      { did: DID_B, pds: goodEnv[ENV.pdsB] },
    ],
  };
  const pdsCompat = {
    results: {
      perPds: [
        { endpoint: goodEnv[ENV.pdsA], getRecordExclusion: true },
        { endpoint: goodEnv[ENV.pdsB], getRecordExclusion: true },
      ],
    },
  };
  const script = [
    'import json, sys',
    "sys.path.insert(0, 'scripts')",
    'import verify_live_evidence as v',
    'data = json.load(sys.stdin)',
    "status, problems = v.node_gate_status('ingest', data['entry'], data['entry']['commit'], data['entry']['bundleSha256'], data['prereq'])",
    "pairing = v.absence_method_problems(data['entry'], data['pdsCompat'], data['prereq'])",
    "print(json.dumps({'status': status, 'problems': problems, 'pairing': pairing}))",
  ].join('\n');
  const output = execFileSync('python3', ['-c', script], {
    cwd: REPO,
    input: JSON.stringify({ entry, prereq, pdsCompat }),
    encoding: 'utf8',
  });
  expect(JSON.parse(output)).toEqual({ status: 'passed', problems: [], pairing: [] });
}

function mockDependencies(options: { failLocalDelete?: boolean } = {}) {
  const recordStates = new Map<string, string>();
  const browserCalls = { launched: 0, closed: 0, contextClosed: 0 };
  const browserRequests: Array<{ path: string; method: string; csrf?: string; extraHeaders?: Record<string, string> }> =
    [];
  const state = { localDeleteFailed: false };
  let currentUrl = 'about:blank';
  const locator = (label = '') => ({
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => {
      if (label === 'Sign in') currentUrl = 'https://pds-a.music.net/authorize';
      if (label === 'consent') currentUrl = `${goodEnv[NODE_ENV.origin]!}/feed`;
    }),
    press: vi.fn(async () => undefined),
    waitFor: vi.fn(async () => undefined),
    isVisible: vi.fn(async () => label === 'consent'),
    inputValue: vi.fn(async () => ''),
    first: vi.fn(() => locator(label)),
  });
  const page = {
    goto: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    url: () => currentUrl,
    locator: vi.fn(() => locator()),
    getByRole: vi.fn((_role: string, options?: { name?: string | RegExp }) => {
      const name = options?.name;
      return locator(name === 'Sign in' ? 'Sign in' : name instanceof RegExp ? 'consent' : 'button');
    }),
    waitForURL: vi.fn(async (predicate: (url: URL) => boolean) => {
      if (!predicate(new URL(currentUrl))) currentUrl = `${goodEnv[NODE_ENV.origin]!}/feed`;
    }),
    evaluate: vi.fn(
      async (
        _fn: unknown,
        args: { path: string; method: string; body?: unknown; csrf?: string; extraHeaders?: Record<string, string> },
      ) => {
        const { path, method, body } = args;
        browserRequests.push({ path, method, csrf: args.csrf, extraHeaders: args.extraHeaders });
        if (path === '/api/v1/auth/session')
          return { status: 200, json: { did: DID_A, csrfToken: 'csrf-session-value' } };
        if (path === '/api/v1/scrobbles' && method === 'POST') {
          return { status: 202, json: { operation: { id: 'local-create' } } };
        }
        if (path.endsWith('/local-create')) {
          return {
            status: 200,
            json: {
              operation: {
                id: 'local-create',
                state: 'succeeded',
                uri: URI_A,
                cid: CID_A,
                updatedAt: '2026-11-03T00:00:00.000Z',
              },
            },
          };
        }
        if (path.includes('/records/status?')) {
          const uri = new URL(path, goodEnv[NODE_ENV.origin]).searchParams.get('uri')!;
          return {
            status: 200,
            json: {
              state: recordStates.get(uri) ?? 'indexed',
              cid: uri === URI_A ? CID_A : CID_B,
              revision: REV_PRESENT,
            },
          };
        }
        if (path.startsWith('/api/v1/scrobbles/') && method === 'DELETE') {
          if (options.failLocalDelete) {
            state.localDeleteFailed = true;
            return { status: 503, json: { error: 'temporary failure' } };
          }
          recordStates.set(URI_A, 'absent');
          return { status: 202, json: { operation: { id: 'local-delete' } } };
        }
        if (path.endsWith('/local-delete')) {
          return {
            status: 200,
            json: { operation: { id: 'local-delete', state: 'succeeded', updatedAt: '2026-11-03T00:00:00.000Z' } },
          };
        }
        throw new Error(`unexpected browser request ${method} ${path} with ${JSON.stringify(body)}`);
      },
    ),
  } as unknown as Page;
  const browserContext = {
    newPage: async () => page,
    close: async () => {
      browserCalls.contextClosed++;
    },
  };
  const browser = {
    newContext: async () => browserContext,
    close: async () => {
      browserCalls.closed++;
    },
  };
  const deps: IngestDependencies = {
    browser: async () => {
      browserCalls.launched++;
      return browser as unknown as Browser;
    },
    pdsInfo: async (endpoint, implementation) => ({ endpoint, implementation, version: '1.2.3' }),
    httpJson: vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path.endsWith('com.atproto.server.createSession'))
        return { status: 200, headers: new Headers(), json: { did: DID_B, accessJwt: 'unused-test-jwt' } };
      if (path.endsWith('com.atproto.repo.createRecord')) {
        recordStates.set(URI_B, 'indexed');
        return { status: 200, headers: new Headers(), json: { uri: URI_B, cid: CID_B, commit: { rev: REV_PRESENT } } };
      }
      if (path.endsWith('com.atproto.repo.deleteRecord')) {
        recordStates.set(URI_B, 'absent');
        return { status: 200, headers: new Headers(), json: { commit: { rev: REV_ABSENT } } };
      }
      throw new Error(`unexpected PDS request ${path}`);
    }),
    verifyRecordAt: vi.fn(async (did) => ({
      state: 'present' as const,
      cid: did === DID_A ? CID_A : CID_B,
      rev: REV_PRESENT,
      commitCid: CID_A,
      pds: did === DID_A ? goodEnv[ENV.pdsA]! : goodEnv[ENV.pdsB]!,
    })),
    verifyAbsent: vi.fn(async (_did, _collection, _rkey, opts) => ({
      method: 'exclusionProof' as const,
      rev: REV_ABSENT,
      commitCid: CID_B,
      pds: goodEnv[ENV.pdsB]!,
      after: opts?.after,
    })),
    now: () => new Date('2026-11-03T00:00:02.000Z'),
    sleep: async () => undefined,
    checkIdentityPds: async () => undefined,
  };
  return { deps, browserCalls, browserRequests, state };
}

test('zero-network preflight blocks and names missing Node inputs', async () => {
  const capture = ioCapture();
  const run = vi.fn(spec.run);
  expect(await runNodeGate({ ...spec, run }, {}, capture.io)).toBe(2);
  const evidence = JSON.parse(capture.output().stdout) as { result: string; missing: string[] };
  expect(evidence.result).toBe('blocked');
  expect(evidence.missing).toEqual(
    expect.arrayContaining([
      expect.stringContaining(NODE_ENV.origin),
      expect.stringContaining(ENV.didA),
      expect.stringContaining(NODE_INGEST_ENV.appPasswordB),
    ]),
  );
  expect(run).not.toHaveBeenCalled();
});

test('importing the driver is inert', () => {
  const moduleUrl = pathToFileURL(resolve(REPO, 'scripts/live/node_ingest_check.ts')).href;
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

test('mocked app UI and PDS flow emits verifier-compatible CID and absence fields', async () => {
  const { deps, browserCalls, browserRequests } = mockDependencies();
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures).toEqual([]);
  expect(result.pds).toHaveLength(2);
  expect(result.subjects).toEqual([
    { did: DID_A, uri: URI_A },
    { did: DID_B, uri: URI_B },
  ]);
  expect(result.results.localPublish).toMatchObject({
    cid: CID_A,
    operationCid: CID_A,
    statusCid: CID_A,
    indexedCid: CID_A,
    verifiedCid: CID_A,
    lagMs: 2000,
  });
  expect(result.results.externalPublish).toMatchObject({
    cid: CID_B,
    pdsWriteCid: CID_B,
    statusCid: CID_B,
    indexedCid: CID_B,
    verifiedCid: CID_B,
  });
  expect(result.results.deleteReconcile).toEqual([
    expect.objectContaining({ uri: URI_A, via: 'app', absentVerified: true, method: 'exclusionProof' }),
    expect.objectContaining({ uri: URI_B, via: 'pdsB', absentVerified: true, method: 'exclusionProof' }),
  ]);
  expect(cleanup).toEqual(
    expect.arrayContaining([
      `${URI_A} deleted and reconciled absent (app)`,
      `${URI_B} deleted and reconciled absent (pdsB)`,
    ]),
  );
  expect(browserCalls).toEqual({ launched: 1, closed: 1, contextClosed: 1 });
  expect(deps.httpJson).toHaveBeenCalledTimes(3);
  expect(deps.httpJson).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({
      body: expect.objectContaining({
        identifier: goodEnv[OAUTH_ENV.handleB],
        password: goodEnv[NODE_INGEST_ENV.appPasswordB],
      }),
    }),
  );
  expect(browserRequests).toContainEqual(
    expect.objectContaining({
      path: '/api/v1/scrobbles',
      method: 'POST',
      csrf: 'csrf-session-value',
      extraHeaders: { 'idempotency-key': expect.any(String) },
    }),
  );
  expect(JSON.stringify(result)).not.toContain(goodEnv[NODE_INGEST_ENV.appPasswordB]);
  expect(JSON.stringify(result)).not.toContain('unused-test-jwt');
  assertVerifierPairing(result, cleanup);
});

test('cleanup failure marks the URI left behind and fails the gate', async () => {
  const { deps, state } = mockDependencies({ failLocalDelete: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(state.localDeleteFailed).toBe(true);
  expect(failures.some((failure) => failure.includes('DELETE /api/v1/scrobbles'))).toBe(true);
  expect(cleanup).toContain(`${URI_A} LEFT BEHIND: delete and reconcile manually`);
  expect(result.subjects).toEqual([
    { did: DID_A, uri: URI_A },
    { did: DID_B, uri: URI_B },
  ]);
});
