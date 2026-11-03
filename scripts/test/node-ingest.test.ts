import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { systemClock } from '@atmusic/core/deps';
import { buildScrobbleRecord } from '@atmusic/core/scrobble';
import type { Browser, Page } from '@playwright/test';
import { expect, test, vi } from 'vitest';
import { ENV } from '../live/live-gate.ts';
import {
  browserRequest,
  deadlineTimer,
  type IngestDependencies,
  NODE_INGEST_ENV,
  recoverPdsCreate,
  runNodeIngest,
  spec,
} from '../live/node_ingest_check.ts';
import { NODE_ENV, type NodeGateContext, type NodeGateIO, runNodeGate } from '../live/node-live-gate.ts';
import { startOwnedChromium } from '../live/owned-chromium.ts';
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

function makeContext(
  failures: string[] = [],
  cleanup: string[] = [],
  env: Record<string, string> = goodEnv,
): NodeGateContext {
  return {
    env,
    get: (name) => {
      const value = env[name];
      if (!value) throw new Error(`missing ${name}`);
      return value;
    },
    origin: env[NODE_ENV.origin]!,
    lexiconPrefix: env[NODE_ENV.prefix]!,
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
        {
          endpoint: goodEnv[ENV.pdsB],
          getRecordExclusion:
            ((body.results.deleteReconcile as Array<{ via: string; method: string }> | undefined) ?? []).find(
              (entry) => entry.via === 'pdsB',
            )?.method === 'exclusionProof',
        },
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

function mockDependencies(
  options: {
    failLocalDelete?: boolean;
    operationStates?: string[];
    losePdsCreateResponse?: boolean;
    loseAppCreateResponse?: boolean;
    pdsReadAbsent?: boolean;
    losePdsDeleteResponse?: boolean;
    loseAppDeleteResponse?: boolean;
    snapshotPdsB?: boolean;
    staleAbsence?: boolean;
    wrongPdsCid?: boolean;
    wrongPdsCreateUri?: boolean;
    mismatchIdentity?: boolean;
    stallStatus?: boolean;
    malformedAppAck?: boolean;
    wrongProofRecord?: boolean;
    appProofMismatch?: boolean;
    contextCloseMode?: 'reject' | 'hang';
    browserCloseMode?: 'reject' | 'hang';
  } = {},
) {
  const recordStates = new Map<string, string>();
  let externalUri = URI_B;
  let operationPolls = 0;
  let appCreatePosts = 0;
  let appDeletePosts = 0;
  let pdsDeletePosts = 0;
  let pdsRecord: object | null = null;
  let appRecord: object | null = null;
  const browserCalls = { launched: 0, closed: 0, contextClosed: 0 };
  const browserRequests: Array<{
    path: string;
    method: string;
    body?: unknown;
    csrf?: string;
    extraHeaders?: Record<string, string>;
  }> = [];
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
    close: vi.fn(async () => undefined),
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
        browserRequests.push({ path, method, body, csrf: args.csrf, extraHeaders: args.extraHeaders });
        if (path === '/api/v1/auth/session')
          return { status: 200, json: { did: DID_A, csrfToken: 'csrf-session-value' } };
        if (path === '/api/v1/scrobbles' && method === 'POST') {
          appCreatePosts++;
          const built = buildScrobbleRecord(body, 'org.atproto.music', systemClock);
          appRecord = built.ok ? built.record : null;
          if (options.loseAppCreateResponse && appCreatePosts === 1) throw new Error('response lost after app commit');
          if (options.malformedAppAck && appCreatePosts === 1) return { status: 202, json: { operation: { id: '' } } };
          return { status: 202, json: { operation: { id: 'local-create' } } };
        }
        if (path.endsWith('/local-create')) {
          const state = options.operationStates?.[operationPolls++] ?? 'succeeded';
          return {
            status: 200,
            json: {
              id: 'local-create',
              state,
              ...(state === 'succeeded' ? { uri: URI_A, cid: CID_A } : {}),
              updatedAt: '2026-11-03T00:00:00.000Z',
            },
          };
        }
        if (path.includes('/records/status?')) {
          if (options.stallStatus) return new Promise<never>(() => {});
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
          appDeletePosts++;
          if (options.failLocalDelete) {
            state.localDeleteFailed = true;
            return { status: 503, json: { error: 'temporary failure' } };
          }
          recordStates.set(URI_A, 'absent');
          if (options.loseAppDeleteResponse) throw new Error('app delete response lost after commit');
          return { status: 202, json: { operation: { id: 'local-delete' } } };
        }
        if (path.endsWith('/local-delete')) {
          return {
            status: 200,
            json: { id: 'local-delete', state: 'succeeded', updatedAt: '2026-11-03T00:00:00.000Z' },
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
      if (options.contextCloseMode === 'reject') throw new Error('context close failed');
      if (options.contextCloseMode === 'hang') return new Promise<void>(() => {});
    },
  };
  const browser = {
    newContext: async () => browserContext,
    close: async () => {
      browserCalls.closed++;
      if (options.browserCloseMode === 'reject') throw new Error('browser close failed');
      if (options.browserCloseMode === 'hang') return new Promise<void>(() => {});
    },
  };
  const deps: IngestDependencies = {
    browser: async () => {
      browserCalls.launched++;
      return browser as unknown as Browser;
    },
    pdsInfo: async (endpoint, implementation) => ({ endpoint, implementation, version: '1.2.3' }),
    httpJson: vi.fn(async (url: string | URL, init?: { body?: unknown }) => {
      const path = new URL(url).pathname;
      if (path.endsWith('com.atproto.server.createSession'))
        return { status: 200, headers: new Headers(), json: { did: DID_B, accessJwt: 'unused-test-jwt' } };
      if (path.endsWith('com.atproto.repo.createRecord')) {
        const request = init?.body as { repo: string; collection: string; rkey: string; record: object };
        externalUri = `at://${request.repo}/${request.collection}/${request.rkey}`;
        pdsRecord = request.record;
        recordStates.set(externalUri, 'indexed');
        if (options.losePdsCreateResponse) throw new Error('socket reset after remote commit');
        return {
          status: 200,
          headers: new Headers(),
          json: {
            uri: options.wrongPdsCreateUri ? `at://${DID_B}/org.atproto.music.scrobble/2zzzzzzzzzzzz` : externalUri,
            cid: CID_B,
            commit: { rev: REV_PRESENT },
          },
        };
      }
      if (path.endsWith('com.atproto.repo.getRecord'))
        if (options.pdsReadAbsent) return { status: 404, headers: new Headers(), json: null };
      if (path.endsWith('com.atproto.repo.getRecord'))
        return {
          status: 200,
          headers: new Headers(),
          json: { uri: externalUri, cid: CID_B, value: pdsRecord },
        };
      if (path.endsWith('com.atproto.repo.deleteRecord')) {
        pdsDeletePosts++;
        recordStates.set(externalUri, 'absent');
        if (options.losePdsDeleteResponse) throw new Error('PDS delete response lost after commit');
        return { status: 200, headers: new Headers(), json: { commit: { rev: REV_ABSENT } } };
      }
      throw new Error(`unexpected PDS request ${path}`);
    }),
    verifyRecordAt: vi.fn(async (did) => ({
      state: 'present' as const,
      cid: did === DID_A ? CID_A : options.wrongPdsCid ? CID_A : CID_B,
      ...(did === DID_A
        ? {
            record: options.appProofMismatch ? { ...appRecord, artist: 'different app payload' } : appRecord,
          }
        : {
            record: options.wrongProofRecord ? { artist: 'different record' } : pdsRecord,
          }),
      rev: REV_PRESENT,
      commitCid: CID_A,
      pds: did === DID_A ? goodEnv[ENV.pdsA]! : goodEnv[ENV.pdsB]!,
    })),
    verifyAbsent: vi.fn(async (did, _collection, _rkey, opts) => {
      if (options.failLocalDelete && did === DID_A) throw new Error('record still present');
      const snapshot = options.snapshotPdsB && did === DID_B;
      return {
        method: snapshot ? ('snapshot' as const) : ('exclusionProof' as const),
        ...(snapshot ? { exclusionProofUnavailable: 'MethodNotImplemented', keysEnumerated: 3 } : {}),
        rev: options.staleAbsence ? REV_PRESENT : REV_ABSENT,
        commitCid: CID_B,
        pds: did === DID_A ? goodEnv[ENV.pdsA]! : goodEnv[ENV.pdsB]!,
        after: opts?.after,
      };
    }),
    now: () => new Date('2026-11-03T00:00:02.000Z'),
    sleep: async () => undefined,
    checkIdentityPds: async (did) => {
      if (options.mismatchIdentity && did === DID_B) throw new Error('identity PDS mismatch');
    },
  };
  return { deps, browserCalls, browserRequests, state, deletePosts: () => ({ appDeletePosts, pdsDeletePosts }) };
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

test.each([undefined, '', '60'])(
  'harness accepts omitted, empty, or valid optional ingest timeout (%s)',
  async (value) => {
    const { deps } = mockDependencies();
    const env = { ...goodEnv };
    if (value === undefined) delete env[NODE_INGEST_ENV.timeoutSeconds];
    else env[NODE_INGEST_ENV.timeoutSeconds] = value;
    const capture = ioCapture();
    const ingestSpec = { ...spec, run: (context: NodeGateContext) => runNodeIngest(context, deps) };
    expect(await runNodeGate(ingestSpec, env, capture.io)).toBe(0);
    expect((JSON.parse(capture.output().stdout) as { result: string }).result).toBe('passed');
  },
);

test.each(['bad', '0', '-1', '3601'])('invalid ingest timeout %s blocks before invoking the body', async (value) => {
  const run = vi.fn(async () => ({ pds: [], subjects: [], results: {} }));
  const capture = ioCapture();
  expect(await runNodeGate({ ...spec, run }, { ...goodEnv, [NODE_INGEST_ENV.timeoutSeconds]: value }, capture.io)).toBe(
    2,
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
  const { deps, browserCalls, browserRequests } = mockDependencies({
    operationStates: ['queued', 'running', 'succeeded'],
  });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures).toEqual([]);
  expect(result.pds).toHaveLength(2);
  expect(result.subjects).toEqual([
    expect.objectContaining({ did: DID_A, uri: URI_A, unresolved: false }),
    expect.objectContaining({ did: DID_B, uri: expect.stringMatching(/^at:\/\//) }),
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
    expect.objectContaining({ via: 'pdsB', absentVerified: true, method: 'exclusionProof' }),
  ]);
  expect(cleanup).toEqual(
    expect.arrayContaining([
      `${URI_A} deleted and reconciled absent (app)`,
      expect.stringMatching(/deleted and reconciled absent \(pdsB\)$/),
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

test.each(['failed', 'cancelled', 'blocked'])(
  'terminal operation state %s fails promptly and retains unresolved intent',
  async (state) => {
    const { deps } = mockDependencies({ operationStates: [state] });
    const failures: string[] = [];
    const cleanup: string[] = [];
    const result = await runNodeIngest(makeContext(failures, cleanup), deps);

    expect(failures).toContain('Node ingest failed during app scrobble operation');
    expect(result.subjects[0]).toMatchObject({ did: DID_A, uri: null, unresolved: true, operationId: 'local-create' });
  },
);

test('committed PDS create with a lost response is recovered by key, verified, conditionally deleted, and still fails', async () => {
  const { deps } = mockDependencies({ losePdsCreateResponse: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures).toContain('Node ingest failed during PDS B scrobble submission');
  expect(deps.httpJson).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({ body: expect.objectContaining({ swapRecord: CID_B }) }),
  );
  expect(result.subjects[1]).toMatchObject({ did: DID_B, unresolved: false });
  expect(cleanup.some((line) => line.includes('deleted and reconciled absent (pdsB)'))).toBe(true);
});

test('PDS create URI mismatch is rejected and cleanup only uses the preallocated key after digest proof', async () => {
  const { deps } = mockDependencies({ wrongPdsCreateUri: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures).toContain('Node ingest failed during PDS B scrobble submission');
  expect(deps.httpJson).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({ body: expect.objectContaining({ swapRecord: CID_B }) }),
  );
  expect(result.subjects[1]).toMatchObject({ did: DID_B, unresolved: false });
});

test('lost app acknowledgement replays the exact idempotency key and payload for cleanup', async () => {
  const { deps, browserRequests } = mockDependencies({ loseAppCreateResponse: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures).toContain('Node ingest failed during app scrobble submission');
  const posts = browserRequests.filter((request) => request.path === '/api/v1/scrobbles' && request.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0]?.extraHeaders).toEqual(posts[1]?.extraHeaders);
  expect(posts[0]?.body).toEqual(posts[1]?.body);
  expect(result.subjects[0]).toMatchObject({ did: DID_A, uri: URI_A, unresolved: false });
});

test.each([
  ['normal app publish', {}],
  ['recovered app publish', { loseAppCreateResponse: true }],
] as const)('%s rejects wrong content with a matching CID and never deletes it', async (_label, options) => {
  const { deps, deletePosts } = mockDependencies({ ...options, appProofMismatch: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures).toContain(
    `Node ingest failed during ${'loseAppCreateResponse' in options ? 'app scrobble submission' : 'app scrobble indexing'}`,
  );
  expect(deps.verifyRecordAt).toHaveBeenCalledWith(
    DID_A,
    'org.atproto.music.scrobble',
    expect.any(String),
    expect.any(Number),
  );
  expect(deletePosts().appDeletePosts).toBe(0);
  expect(result.subjects[0]).toMatchObject({ did: DID_A, uri: URI_A, unresolved: true });
  expect(cleanup.some((line) => line.includes(`${URI_A} LEFT BEHIND`))).toBe(true);
});

test.each([
  ['normal app publish', {}, []],
  ['recovered app publish', { loseAppCreateResponse: true }, ['Node ingest failed during app scrobble submission']],
] as const)('%s verifies the BFF-normalized record and permits cleanup', async (_label, options, expectedFailures) => {
  const { deps, deletePosts } = mockDependencies(options);
  const failures: string[] = [];
  const result = await runNodeIngest(makeContext(failures), deps);

  expect(failures).toEqual(expectedFailures);
  expect(deps.verifyRecordAt).toHaveBeenCalledWith(
    DID_A,
    'org.atproto.music.scrobble',
    expect.any(String),
    expect.any(Number),
  );
  expect(deletePosts().appDeletePosts).toBe(1);
  expect(result.subjects[0]).toMatchObject({ did: DID_A, uri: URI_A, unresolved: false });
});

test('malformed app acknowledgement is recovered through the original idempotency key', async () => {
  const { deps, browserRequests } = mockDependencies({ malformedAppAck: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures).toContain('Node ingest failed during app scrobble submission');
  const posts = browserRequests.filter((request) => request.path === '/api/v1/scrobbles' && request.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0]?.extraHeaders).toEqual(posts[1]?.extraHeaders);
  expect(posts[0]?.body).toEqual(posts[1]?.body);
  expect(result.subjects[0]).toMatchObject({ did: DID_A, uri: URI_A, unresolved: false });
});

test('PDS absence after an ambiguous create remains unresolved and is never treated as clean', async () => {
  const { deps } = mockDependencies({ losePdsCreateResponse: true, pdsReadAbsent: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures).toContain('Node ingest failed during PDS B scrobble submission');
  expect(failures).toContain(
    'PDS B create remains unresolved after an absence observation; a delayed commit is still possible',
  );
  expect(deps.httpJson).not.toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({ body: expect.objectContaining({ swapRecord: expect.any(String) }) }),
  );
  expect(result.subjects[1]).toMatchObject({ did: DID_B, unresolved: true, uri: expect.stringMatching(/^at:\/\//) });
});

test('PDS delete response loss is reconciled without replaying the conditional delete', async () => {
  const { deps, deletePosts } = mockDependencies({ losePdsDeleteResponse: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures).toContain('Node ingest failed during PDS B delete reconciliation');
  expect(deletePosts().pdsDeletePosts).toBe(1);
  expect(result.subjects[1]).toMatchObject({ did: DID_B, unresolved: false });
});

test('app delete response loss remains unresolved without submitting a second DELETE', async () => {
  const { deps, deletePosts } = mockDependencies({ loseAppDeleteResponse: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures).toContain('Node ingest failed during app delete reconciliation');
  expect(deletePosts().appDeletePosts).toBe(1);
  expect(result.subjects[0]).toMatchObject({ did: DID_A, unresolved: true });
});

test('mixed PDS exclusion and snapshot methods remain paired to their own operators', async () => {
  const { deps } = mockDependencies({ snapshotPdsB: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures).toEqual([]);
  expect((result.results.deleteReconcile as Array<Record<string, unknown>>)[1]).toMatchObject({
    via: 'pdsB',
    method: 'snapshot',
    exclusionProofUnavailable: 'MethodNotImplemented',
    keysEnumerated: 3,
  });
  assertVerifierPairing(result, cleanup);
});

test('stale absence revisions remain unresolved without replaying either delete', async () => {
  const { deps, deletePosts } = mockDependencies({ staleAbsence: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(failures.length).toBeGreaterThan(0);
  expect(deletePosts()).toEqual({ appDeletePosts: 1, pdsDeletePosts: 1 });
  expect(result.subjects.every((subject) => subject.unresolved)).toBe(true);
});

test('PDS CID and verified-content mismatches fail acceptance without deleting an unverified record', async () => {
  const mismatch = mockDependencies({ wrongPdsCid: true });
  const failures: string[] = [];
  const mismatchResult = await runNodeIngest(makeContext(failures, []), mismatch.deps);
  expect(failures).toContain('Node ingest failed during PDS B scrobble indexing');
  expect(mismatch.deletePosts()).toMatchObject({ pdsDeletePosts: 0 });
  expect(mismatchResult.subjects[1]).toMatchObject({ did: DID_B, unresolved: true });

  const wrongContent = mockDependencies({ wrongProofRecord: true });
  const contentFailures: string[] = [];
  const contentResult = await runNodeIngest(makeContext(contentFailures, []), wrongContent.deps);
  expect(contentFailures).toContain('Node ingest failed during PDS B scrobble indexing');
  expect(wrongContent.deletePosts()).toMatchObject({ pdsDeletePosts: 0 });
  expect(contentResult.subjects[1]).toMatchObject({ did: DID_B, unresolved: true });
});

test('identity/PDS mismatch blocks before browser launch', async () => {
  const identity = mockDependencies({ mismatchIdentity: true });
  const identityFailures: string[] = [];
  await runNodeIngest(makeContext(identityFailures, []), identity.deps);
  expect(identityFailures).toContain('Node ingest failed during PDS identity checks');
  expect(identity.browserCalls.launched).toBe(0);
});

test('successful recovery spends only the remaining deadline on independent proof', async () => {
  const { deps } = mockDependencies();
  const record = { artist: 'recovery', track: 'bounded' };
  let proofTimeout = Number.POSITIVE_INFINITY;
  deps.httpJson = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      status: 200,
      headers: new Headers(),
      json: { uri: `at://${DID_B}/org.atproto.music.scrobble/3jzfcijpj2z2b`, cid: CID_B, value: record },
    };
  });
  deps.verifyRecordAt = vi.fn(async (_did, _collection, _rkey, timeoutMs) => {
    proofTimeout = timeoutMs ?? Number.POSITIVE_INFINITY;
    return {
      state: 'present' as const,
      cid: CID_B,
      rev: REV_PRESENT,
      commitCid: CID_A,
      pds: goodEnv[ENV.pdsB]!,
      record,
    };
  });
  const deadlineAt = performance.now() + 250;
  const recovered = await recoverPdsCreate(
    deps,
    goodEnv[ENV.pdsB]!,
    DID_B,
    'org.atproto.music.scrobble',
    '3jzfcijpj2z2b',
    record,
    deadlineAt,
  );
  expect(recovered).toMatchObject({ uri: URI_B, cid: CID_B, rev: REV_PRESENT });
  expect(proofTimeout).toBeLessThan(210);
});

test('stalled browser response and body consumption are bounded by the shared total timeout', async () => {
  const { deps, browserCalls } = mockDependencies({ stallStatus: true });
  const failures: string[] = [];
  const env = { ...goodEnv, [NODE_INGEST_ENV.timeoutSeconds]: '1' };
  await runNodeIngest(makeContext(failures, [], env), deps);

  expect(failures).toContain('Node ingest failed during app scrobble indexing');
  expect(browserCalls.closed).toBe(1);
  expect(browserCalls.contextClosed).toBe(1);
});

test('a browser launch resolving after its phase deadline is closed', async () => {
  const { deps, browserCalls } = mockDependencies();
  const startBrowser = deps.browser;
  deps.browser = async (timeoutMs) => {
    await new Promise((resolve) => setTimeout(resolve, 850));
    return startBrowser(timeoutMs);
  };
  const failures: string[] = [];
  await runNodeIngest(makeContext(failures, [], { ...goodEnv, [NODE_INGEST_ENV.timeoutSeconds]: '1' }), deps);
  expect(failures).toContain('Node ingest failed during PDS identity checks');
  await vi.waitFor(() => expect(browserCalls.closed).toBe(1), { timeout: 1_000 });
});

test('a forever-pending browser launch is terminated before evidence can return', async () => {
  const { deps } = mockDependencies();
  let fixturePid: number | undefined;
  let fixtureClosed = false;
  deps.browser = (timeoutMs) => {
    const fixture = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fixturePid = fixture.pid;
    return new Promise((_resolve, reject) => {
      const timeout = setTimeout(() => fixture.kill('SIGTERM'), timeoutMs);
      fixture.once('close', () => {
        fixtureClosed = true;
        clearTimeout(timeout);
        reject(new Error('simulated Playwright launch timeout'));
      });
    });
  };
  const failures: string[] = [];
  const cleanup: string[] = [];
  const started = performance.now();
  await runNodeIngest(makeContext(failures, cleanup, { ...goodEnv, [NODE_INGEST_ENV.timeoutSeconds]: '1' }), deps);
  const emittedFailures = [...failures];
  const emittedCleanup = [...cleanup];
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(performance.now() - started).toBeLessThan(1_300);
  expect(fixturePid).toBeDefined();
  expect(fixtureClosed).toBe(true);
  expect(failures).toEqual(emittedFailures);
  expect(cleanup).toEqual(emittedCleanup);
  expect(failures).toContain('Node ingest failed during PDS identity checks');
});

test('Node ingest reaps the actual owned startup process before returning timeout evidence', async () => {
  const { deps } = mockDependencies();
  const fixtureDir = await mkdtemp(join(tmpdir(), 'atmusic-ingest-test-'));
  const pidFile = join(fixtureDir, 'pid');
  deps.startBrowser = (timeoutMs) =>
    startOwnedChromium(false, timeoutMs, 250, {
      executablePath: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
    });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const startedAt = performance.now();
  await runNodeIngest(makeContext(failures, cleanup, { ...goodEnv, [NODE_INGEST_ENV.timeoutSeconds]: '1' }), deps);
  const pid = Number(await readFile(pidFile, 'utf8'));
  const emittedFailures = [...failures];
  const emittedCleanup = [...cleanup];

  expect(performance.now() - startedAt).toBeLessThan(1_300);
  expect(() => process.kill(pid, 0)).toThrow();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(failures).toEqual(emittedFailures);
  expect(cleanup).toEqual(emittedCleanup);
  expect(failures).toContain('Node ingest failed during PDS identity checks');
  await rm(fixtureDir, { recursive: true, force: true });
});

test.each([1_100, 1_500])('browser startup scheduled at %d ms is canceled at the launch deadline', async (launchMs) => {
  const { deps, browserCalls } = mockDependencies();
  const startBrowser = deps.browser;
  let fixtureClosed = false;
  deps.browser = (timeoutMs) => {
    const fixture = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    return new Promise((resolve, reject) => {
      const finishTimer = setTimeout(() => startBrowser(timeoutMs).then(resolve, reject), launchMs);
      const timeout = setTimeout(() => fixture.kill('SIGTERM'), timeoutMs);
      fixture.once('close', () => {
        fixtureClosed = true;
        clearTimeout(finishTimer);
        clearTimeout(timeout);
        reject(new Error('simulated Playwright launch timeout'));
      });
    });
  };
  const failures: string[] = [];
  const cleanup: string[] = [];
  const started = performance.now();
  await runNodeIngest(makeContext(failures, cleanup, { ...goodEnv, [NODE_INGEST_ENV.timeoutSeconds]: '1' }), deps);
  const elapsedMs = performance.now() - started;
  const emittedFailures = [...failures];
  const emittedCleanup = [...cleanup];
  await new Promise((resolve) => setTimeout(resolve, launchMs + 20));

  expect(elapsedMs).toBeLessThan(1_100);
  expect(fixtureClosed).toBe(true);
  expect(browserCalls.launched).toBe(0);
  expect(failures).toEqual(emittedFailures);
  expect(cleanup).toEqual(emittedCleanup);
  expect(failures).toContain('Node ingest failed during PDS identity checks');
});

test('a rejected browser launch remains bounded and does not claim a discarded context', async () => {
  const { deps, browserCalls } = mockDependencies();
  deps.browser = async () => {
    throw new Error('launch rejected');
  };
  const failures: string[] = [];
  const cleanup: string[] = [];
  await runNodeIngest(makeContext(failures, cleanup), deps);
  expect(failures).toContain('Node ingest failed during PDS identity checks');
  expect(browserCalls.contextClosed).toBe(0);
  expect(cleanup).not.toContain(
    `${DID_A}: browser context discarded; no sign-out or upstream revocation claim was made`,
  );
});

test.each(['reject', 'hang'] as const)(
  'context close %s leaves actionable evidence within the total deadline',
  async (mode) => {
    const { deps } = mockDependencies({ contextCloseMode: mode });
    const failures: string[] = [];
    const cleanup: string[] = [];
    const started = performance.now();
    await runNodeIngest(makeContext(failures, cleanup, { ...goodEnv, [NODE_INGEST_ENV.timeoutSeconds]: '1' }), deps);
    expect(performance.now() - started).toBeLessThan(1_300);
    expect(failures).toContain('browser context close failed during teardown');
    expect(cleanup).toContain(
      `${DID_A}: browser context closure was not confirmed; inspect the runner process and close any remaining session`,
    );
    expect(cleanup).not.toContain(
      `${DID_A}: browser context discarded; no sign-out or upstream revocation claim was made`,
    );
  },
);

test('a late browser with a hanging close cannot extend the absolute ingest deadline', async () => {
  const { deps } = mockDependencies({ browserCloseMode: 'hang' });
  const startBrowser = deps.browser;
  deps.browser = async (timeoutMs) => {
    await new Promise((resolve) => setTimeout(resolve, 850));
    return startBrowser(timeoutMs);
  };
  const failures: string[] = [];
  const cleanup: string[] = [];
  const started = performance.now();
  await runNodeIngest(makeContext(failures, cleanup, { ...goodEnv, [NODE_INGEST_ENV.timeoutSeconds]: '1' }), deps);
  expect(performance.now() - started).toBeLessThan(1_300);
  expect(cleanup).toContain('late browser launch unresolved; inspect the runner process for a browser left open');
});

test('cleanup failure marks the URI left behind and fails the gate', async () => {
  const { deps, state } = mockDependencies({ failLocalDelete: true });
  const failures: string[] = [];
  const cleanup: string[] = [];
  const result = await runNodeIngest(makeContext(failures, cleanup), deps);

  expect(state.localDeleteFailed).toBe(true);
  expect(failures).toContain('Node ingest failed during app delete reconciliation');
  expect(failures).toContain(`delete operation for ${URI_A} is unknown and remains unresolved`);
  expect(cleanup).toContain(
    `${URI_A} LEFT BEHIND: delete outcome is uncertain; reconcile without replaying the mutation`,
  );
  expect(result.subjects).toEqual([
    expect.objectContaining({ did: DID_A, uri: URI_A, unresolved: true }),
    expect.objectContaining({ did: DID_B, uri: expect.stringMatching(/^at:\/\//) }),
  ]);
});

test('deadline timers round fractional milliseconds and refuse to start after expiry', () => {
  const timer = deadlineTimer(performance.now() + 250);
  expect(timer.timeout(200.25)).toBeInstanceOf(AbortSignal);
  expect(() => deadlineTimer(performance.now() - 1).timeout(100)).toThrow('Node ingest deadline exceeded');
});

test('browser request deadline remains active through response body consumption', async () => {
  let aborted = false;
  const fetcher = vi.fn(async (_input: string | URL, init: RequestInit = {}) => {
    const signal = init.signal as AbortSignal;
    return {
      status: 200,
      text: () =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    } as Response;
  });
  vi.stubGlobal('fetch', fetcher);
  const page = {
    evaluate: async (fn: unknown, args: unknown) => (fn as (value: unknown) => Promise<unknown>)(args),
  } as unknown as Page;
  await expect(browserRequest(page, '/api/v1/slow', 'GET', undefined, undefined, {}, 10)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(aborted).toBe(true);
  vi.unstubAllGlobals();
});
