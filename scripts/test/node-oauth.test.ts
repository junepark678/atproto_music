import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OAUTH_LIVE_BUDGETS, withBoundedRecovery } from '@atmusic/core/oauth-live-budget';
import { expect, test, vi } from 'vitest';
import * as admin from '../admin/atmusic-admin.ts';
import * as liveGate from '../live/live-gate.ts';
import {
  assertNoExistingFollow,
  browserRequest,
  expectedAuthorizationOrigin,
  handleResolutionMatchesDid,
  hasAllTwelveActions,
  isExpectedAuthorizationOrigin,
  NODE_OAUTH_ENV,
  spec,
} from '../live/node_oauth_check.ts';
import { NODE_ENV, type NodeGateIO, runNodeGate } from '../live/node-live-gate.ts';
import * as oauthBrowser from '../live/workers_oauth_check.ts';

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

test('the complete synthetic environment reaches only the injected runner and never initiates networking itself', async () => {
  const run = vi.fn(async () => ({ pds: [], subjects: [], results: { signIns: [], cleanup: 'synthetic test only' } }));
  const fetch = vi.fn(async () => {
    throw new Error('unexpected network request');
  });
  vi.stubGlobal('fetch', fetch);
  const result = capture();
  try {
    expect(await runNodeGate({ ...spec, run }, completeEnv(), result.io)).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    const evidence = JSON.parse(result.output().stdout) as { result: string; missing: string[] };
    expect(evidence.result).toBe('passed');
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

test('the OAuth grant validator accepts both repo scope encodings and requires every app collection action', () => {
  const collections = ['scrobble', 'follow', 'settings', 'love'].map((name) => `org.atproto.music.${name}`);
  const colonScope = `atproto ${collections.map((collection) => `repo:${collection}`).join(' ')}`;
  const queryScope = `atproto ${collections
    .map((collection) => `repo?collection=${encodeURIComponent(collection)}&action=create&action=update&action=delete`)
    .join(' ')}`;
  expect(hasAllTwelveActions('org.atproto.music', colonScope)).toBe(true);
  expect(hasAllTwelveActions('org.atproto.music', queryScope)).toBe(true);
  expect(hasAllTwelveActions('org.atproto.music', queryScope.replace('&action=delete', ''))).toBe(false);
});

// Keep spec.run and signIn real: mock only browser, public HTTP and Unix-socket boundaries.
async function runCallbackFailure(callbackBody: unknown, observerFailure?: 'throw' | 'structured') {
  const env = completeEnv();
  const origin = env[NODE_ENV.origin]!;
  const requests: { path: string; csrf?: string }[] = [];
  const locator = {
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
  };
  const page = {
    goto: vi.fn(async () => undefined),
    locator: () => locator,
    getByRole: () => locator,
    waitForURL: vi.fn(async () => undefined),
    url: () => origin,
    evaluate: vi.fn(async (_callback: unknown, arg: { path: string; csrf?: string }) => {
      requests.push(arg);
      if (arg.path === '/api/v1/auth/session') return { status: 200, json: callbackBody };
      if (arg.path === '/api/v1/auth/logout') return { status: 204, json: null };
      throw new Error(`unexpected browser request ${arg.path}`);
    }),
  };
  const closeContext = vi.fn(async () => undefined);
  const closeBrowser = vi.fn(async () => undefined);
  vi.spyOn(oauthBrowser, 'launchBrowser').mockResolvedValue({
    newContext: async () => ({ newPage: async () => page, close: closeContext }),
    close: closeBrowser,
  } as unknown as Awaited<ReturnType<typeof oauthBrowser.launchBrowser>>);
  vi.spyOn(liveGate, 'pdsInfo').mockImplementation(async (endpoint, implementation) => ({
    endpoint,
    implementation,
    version: 'test',
  }));
  vi.spyOn(liveGate, 'checkIdentityPds').mockResolvedValue('fixture.handle');
  const scope = `atproto ${['scrobble', 'follow', 'settings', 'love']
    .map((name) => `repo:org.atproto.music.${name}`)
    .join(' ')}`;
  vi.spyOn(liveGate, 'httpJson').mockImplementation(async (input) => {
    const url = new URL(input);
    let json: unknown;
    let status = 200;
    if (url.pathname === '/oauth/client-metadata.json') {
      json = {
        client_id: `${origin}/oauth/client-metadata.json`,
        token_endpoint_auth_method: 'private_key_jwt',
        dpop_bound_access_tokens: true,
        scope,
      };
    } else if (url.pathname === '/.well-known/oauth-protected-resource') {
      status = 404;
      json = null;
    } else if (url.pathname === '/xrpc/com.atproto.identity.resolveHandle') {
      json = { did: url.hostname.startsWith('pds-a.') ? env.ATMUSIC_LIVE_DID_A : env.ATMUSIC_LIVE_DID_B };
    } else throw new Error(`unexpected public request ${url.pathname}`);
    return { status, json, headers: new Headers() };
  });
  const observe = vi.spyOn(admin, 'sendOverSocket').mockImplementation(async (_socket, request) => {
    const phase = (request.body as { phase: string }).phase;
    if (phase === 'prepare_sign_out' && observerFailure === 'throw') throw new Error('observer unavailable');
    const body =
      phase === 'capture'
        ? {
            status: 'captured',
            tokenSub: env.ATMUSIC_LIVE_DID_A,
            issuerHost: new URL(env.ATMUSIC_LIVE_PDS_A!).hostname,
            sealedSessionObserved: true,
            clientAuthMethod: 'private_key_jwt',
            dpopBound: true,
            refreshTokenPresent: true,
            grantedScope: scope,
          }
        : phase === 'crud'
          ? { status: 'failed' }
          : phase === 'prepare_sign_out'
            ? { status: 'prepared', refreshTokenPresent: true, sessionVersionStable: true }
            : observerFailure === 'structured'
              ? { status: 'refresh_still_valid', localSessionAbsent: true, refreshRejected: false }
              : { status: 'revoked', localSessionAbsent: true, refreshRejected: true, refreshError: 'invalid_grant' };
    return { status: 200, body: JSON.stringify(body) };
  });
  const result = capture();
  try {
    // A returned callback goes directly to session validation. In the observer
    // case capture succeeds, then CRUD failure enters the real cleanup block.
    expect(await runNodeGate(spec, env, result.io)).toBe(1);
    expect(requests.filter((request) => request.path === '/api/v1/auth/logout')).toEqual([
      expect.objectContaining({ csrf: 'callback-csrf-token' }),
    ]);
    expect(closeContext).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
    const evidence = JSON.parse(result.output().stdout);
    expect(evidence.result).toBe('failed');
    if (observerFailure !== undefined) {
      expect(
        observe.mock.calls.some(([, request]) => (request.body as { phase: string }).phase === 'prepare_sign_out'),
      ).toBe(true);
      expect(evidence.failures).toContain('direct repository CRUD checks failed for PDS A');
      if (observerFailure === 'structured') {
        expect(evidence.cleanup).toContain('session removal or refresh-token revocation remains unverified');
      } else expect(evidence.cleanup).toContain('host sign-out preparation failed; app logout will still run');
    } else expect(evidence.failures[0]).toMatch(/sign-in (resolved to a different DID|returned no active app session)/);
  } finally {
    vi.restoreAllMocks();
  }
}

test.each([
  { did: 'did:plc:bcdefghijklmnopqrstuvwxy', csrfToken: 'callback-csrf-token' },
  { csrfToken: 'callback-csrf-token' },
  { did: 42, csrfToken: 'callback-csrf-token' },
])('production OAuth orchestration logs out after invalid callback session: %j', async (body) => {
  await runCallbackFailure(body);
});

test('production cleanup still logs out when host preparation throws after capture', async () => {
  await runCallbackFailure({ did: completeEnv().ATMUSIC_LIVE_DID_A, csrfToken: 'callback-csrf-token' }, 'throw');
});

test('production cleanup records an unsuccessful observation after app logout', async () => {
  await runCallbackFailure({ did: completeEnv().ATMUSIC_LIVE_DID_A, csrfToken: 'callback-csrf-token' }, 'structured');
});

test.each([false, true])('a valid 202 at phase expiry is reconciled before logout (ack URI: %s)', async (hasUri) => {
  const env = completeEnv();
  const did = env.ATMUSIC_LIVE_DID_A!;
  const origin = env[NODE_ENV.origin]!;
  const collection = 'org.atproto.music.scrobble';
  const rkey = 'record-key';
  const uri = `at://${did}/${collection}/${rkey}`;
  const deleteRoute = `/api/v1/scrobbles/${encodeURIComponent(uri)}`;
  const cid = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const scope = `atproto ${['scrobble', 'follow', 'settings', 'love'].map((name) => `repo:org.atproto.music.${name}`).join(' ')}`;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const events: string[] = [];
  const locator = { fill: async () => undefined, click: async () => undefined };
  const page = {
    goto: async () => undefined,
    locator: () => locator,
    getByRole: () => locator,
    waitForURL: async () => undefined,
    url: () => origin,
    evaluate: async (_callback: unknown, arg: { path: string; method: string }) => {
      events.push(`${arg.method} ${arg.path}`);
      if (arg.path === '/api/v1/auth/session') return { status: 200, json: { did, csrfToken: 'synthetic-csrf' } };
      if (arg.path === '/api/v1/auth/logout') return { status: 204, json: null };
      if (arg.path === '/api/v1/scrobbles' && arg.method === 'POST') {
        now = OAUTH_LIVE_BUDGETS.appPhaseMs;
        return {
          status: 202,
          json: { operation: { id: 'accepted-write', state: 'queued', ...(hasUri ? { uri } : {}) } },
        };
      }
      if (arg.path === '/api/v1/operations/accepted-write') {
        return { status: 200, json: { id: 'accepted-write', state: 'succeeded', kind: 'scrobble.create', uri, cid } };
      }
      if (arg.path === deleteRoute && arg.method === 'DELETE') {
        return { status: 202, json: { operation: { id: 'cleanup-delete', state: 'queued' } } };
      }
      if (arg.path === '/api/v1/operations/cleanup-delete') {
        return { status: 200, json: { id: 'cleanup-delete', state: 'succeeded', kind: 'scrobble.delete' } };
      }
      throw new Error(`unexpected browser request ${arg.path}`);
    },
  };
  vi.spyOn(oauthBrowser, 'launchBrowser').mockResolvedValue({
    newContext: async () => ({ newPage: async () => page, close: async () => undefined }),
    close: async () => undefined,
  } as unknown as Awaited<ReturnType<typeof oauthBrowser.launchBrowser>>);
  vi.spyOn(liveGate, 'pdsInfo').mockImplementation(async (endpoint, implementation) => ({
    endpoint,
    implementation,
    version: 'test',
  }));
  vi.spyOn(liveGate, 'checkIdentityPds').mockResolvedValue('fixture.handle');
  vi.spyOn(liveGate, 'httpJson').mockImplementation(async (input) => {
    const url = new URL(input);
    let status = 200;
    let json: unknown;
    if (url.pathname === '/oauth/client-metadata.json') {
      json = {
        client_id: `${origin}/oauth/client-metadata.json`,
        token_endpoint_auth_method: 'private_key_jwt',
        dpop_bound_access_tokens: true,
        scope,
      };
    } else if (url.pathname === '/.well-known/oauth-protected-resource') {
      status = 404;
      json = null;
    } else if (url.pathname === '/xrpc/com.atproto.identity.resolveHandle') {
      json = { did: url.hostname.startsWith('pds-a.') ? did : env.ATMUSIC_LIVE_DID_B };
    } else throw new Error(`unexpected HTTP ${url.pathname}`);
    return { status, json, headers: new Headers() };
  });
  const present = vi
    .spyOn(liveGate, 'verifyRecordAt')
    .mockResolvedValue({ state: 'present', cid, rev: '3jzfcijpj2z2a', commitCid: cid, pds: env.ATMUSIC_LIVE_PDS_A! });
  const absent = vi.spyOn(liveGate, 'verifyAbsent').mockImplementation(async () => {
    events.push('verified absence');
    return { method: 'exclusionProof', rev: '3jzfcijpj2z2b', commitCid: cid, pds: env.ATMUSIC_LIVE_PDS_A! };
  });
  vi.spyOn(admin, 'sendOverSocket').mockImplementation(async (_socket, request) => {
    const phase = (request.body as { phase: string }).phase;
    const body =
      phase === 'capture'
        ? {
            status: 'captured',
            tokenSub: did,
            issuerHost: new URL(env.ATMUSIC_LIVE_PDS_A!).hostname,
            sealedSessionObserved: true,
            clientAuthMethod: 'private_key_jwt',
            dpopBound: true,
            refreshTokenPresent: true,
            grantedScope: scope,
          }
        : phase === 'crud'
          ? { status: 'passed', cleanupVerified: true, crud: [] }
          : phase === 'prepare_sign_out'
            ? { status: 'prepared', refreshTokenPresent: true, sessionVersionStable: true }
            : { status: 'revoked', localSessionAbsent: true, refreshRejected: true, refreshError: 'invalid_grant' };
    return { status: 200, body: JSON.stringify(body) };
  });
  const result = capture();
  try {
    expect(await runNodeGate(spec, env, result.io)).toBe(1);
    expect(events).toContain(`DELETE ${deleteRoute}`);
    expect(present).toHaveBeenCalledWith(did, collection, rkey, expect.anything());
    expect(absent).toHaveBeenCalledOnce();
    expect(events.indexOf('verified absence')).toBeLessThan(events.indexOf('POST /api/v1/auth/logout'));
    expect(events.includes('GET /api/v1/operations/accepted-write')).toBe(!hasUri);
    const evidence = JSON.parse(result.output().stdout);
    expect(evidence.result).toBe('failed');
    expect(evidence.cleanup).toContain('1 accepted app write(s) reconciled during recovery');
  } finally {
    vi.restoreAllMocks();
  }
});

test('automated OAuth sign-in requires the configured PDS handle to resolve to its exact DID', () => {
  const did = 'did:plc:abcdefghijklmnopqrstuvwx';
  expect(handleResolutionMatchesDid(200, { did }, did)).toBe(true);
  expect(handleResolutionMatchesDid(200, { did: 'did:plc:bcdefghijklmnopqrstuvwxy' }, did)).toBe(false);
  expect(handleResolutionMatchesDid(200, { did: ['not', 'a', 'DID'] }, did)).toBe(false);
  expect(handleResolutionMatchesDid(404, { did }, did)).toBe(false);
  expect(handleResolutionMatchesDid(200, null, did)).toBe(false);
});

test('automated OAuth sign-in pins the authorization origin to valid PDS metadata', () => {
  const pds = 'https://pds-a.example.net';
  expect(
    expectedAuthorizationOrigin(pds, 200, {
      resource: pds,
      authorization_servers: ['https://login.example.org/oauth'],
    }),
  ).toBe('https://login.example.org');
  expect(expectedAuthorizationOrigin(pds, 404, null)).toBe(pds);

  for (const metadata of [
    { resource: pds, authorization_servers: ['https://login.example.org', 'https://attacker.example'] },
    { resource: 'https://attacker.example', authorization_servers: ['https://login.example.org'] },
    { resource: pds, authorization_servers: ['http://login.example.org'] },
    { resource: pds, authorization_servers: [null] },
    { resource: pds, authorization_servers: ['https://user:pass@login.example.org'] },
    { resource: pds, authorization_servers: ['https://login.example.org?next=attacker'] },
  ]) {
    expect(() => expectedAuthorizationOrigin(pds, 200, metadata)).toThrow();
  }
  expect(() => expectedAuthorizationOrigin('http://pds-a.example.net', 404, null)).toThrow();
  expect(() => expectedAuthorizationOrigin(pds, 500, null)).toThrow();
});

test('password entry accepts only the exact pinned authorization origin', () => {
  const expected = 'https://login.example.org';
  expect(isExpectedAuthorizationOrigin('https://login.example.org/oauth/authorize', expected)).toBe(true);
  for (const current of [
    'https://attacker.example/oauth/authorize',
    'https://login.example.org.attacker.example/oauth/authorize',
    'https://login.example.org:444/oauth/authorize',
    'not a URL',
  ]) {
    expect(isExpectedAuthorizationOrigin(current, expected)).toBe(false);
  }
});

test('the browser request deadline aborts a fetch that never responds', async () => {
  let evaluationSettled = false;
  let aborted = false;
  const page = {
    evaluate: async (callback: (arg: unknown) => Promise<unknown>, arg: unknown) => {
      try {
        return await callback(arg);
      } finally {
        evaluationSettled = true;
      }
    },
  } as unknown as import('@playwright/test').Page;
  const fetch = vi.fn(
    async (_input: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(
      withBoundedRecovery(
        async () => browserRequest(page, '/api/v1/auth/logout', 'POST', undefined, {}, undefined, 100),
        async (deadline) => {
          expect(aborted).toBe(true);
          expect(evaluationSettled).toBe(true);
          deadline.assertActive();
        },
        { appPhaseMs: 500, appCleanupMs: 500 },
      ),
    ).rejects.toThrow(/timed out/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(aborted).toBe(true);
    expect(evaluationSettled).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('the browser request deadline aborts a response body that never finishes', async () => {
  let aborted = false;
  const page = {
    evaluate: async (callback: (arg: unknown) => Promise<unknown>, arg: unknown) => callback(arg),
  } as unknown as import('@playwright/test').Page;
  const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
    const signal = init?.signal;
    return {
      status: 200,
      text: () =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    } as Response;
  });
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(browserRequest(page, '/api/v1/auth/logout', 'POST', undefined, {}, undefined, 100)).rejects.toThrow(
      /timed out/,
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(aborted).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a delayed Playwright evaluation does not fetch after expiry and settles before recovery starts', async () => {
  let evaluateCalls = 0;
  let evaluationSettled = false;
  const page = {
    evaluate: async (callback: (arg: unknown) => Promise<unknown> | unknown, arg: unknown) => {
      const callNumber = ++evaluateCalls;
      if (callNumber === 1) await new Promise((resolve) => setTimeout(resolve, 40));
      try {
        return await callback(arg);
      } finally {
        if (callNumber === 1) evaluationSettled = true;
      }
    },
  } as unknown as import('@playwright/test').Page;
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  let recoveryStarted = false;
  let settledAtRecovery: boolean | undefined;
  try {
    await expect(
      withBoundedRecovery(
        async (deadline) => {
          deadline.assertActive();
          await browserRequest(page, '/api/v1/auth/logout', 'POST', undefined, {}, undefined, 10);
        },
        async (deadline) => {
          recoveryStarted = true;
          settledAtRecovery = evaluationSettled;
          deadline.assertActive();
        },
        { appPhaseMs: 500, appCleanupMs: 500 },
      ),
    ).rejects.toThrow(/timed out/);
    expect(fetch).not.toHaveBeenCalled();
    expect(recoveryStarted).toBe(true);
    expect(settledAtRecovery).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('an evaluation that cannot be cancelled or settled prevents unsafe recovery', async () => {
  let evaluateCalls = 0;
  const page = {
    evaluate: async (callback: (arg: unknown) => Promise<unknown> | unknown, arg: unknown) => {
      evaluateCalls += 1;
      if (evaluateCalls === 1) return new Promise<never>(() => {});
      return callback(arg);
    },
  } as unknown as import('@playwright/test').Page;
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  let recoveryStarted = false;
  try {
    await expect(
      withBoundedRecovery(
        async () => browserRequest(page, '/api/v1/auth/logout', 'POST', undefined, {}, undefined, 10),
        async () => {
          recoveryStarted = true;
        },
        { appPhaseMs: 500, appCleanupMs: 500 },
      ),
    ).rejects.toThrow(/browser request cleanup failed/);
    expect(recoveryStarted).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('follow preflight searches every page and refuses any pre-existing record for the peer', async () => {
  const did = 'did:plc:abcdefghijklmnopqrstuvwx';
  const collection = 'org.atproto.music.follow';
  const peer = 'did:plc:bcdefghijklmnopqrstuvwxy';
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ records: [], cursor: 'page-two' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          records: [{ uri: `at://${did}/${collection}/noncanonical-key`, cid: 'bafyreia', value: { subject: peer } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(assertNoExistingFollow('https://pds.test', did, collection, peer)).rejects.toThrow(
      /already follow each other/,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]?.[0])).toContain('cursor=page-two');
  } finally {
    vi.unstubAllGlobals();
  }
});
