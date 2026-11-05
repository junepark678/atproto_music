import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import {
  assertNoExistingFollow,
  browserRequest,
  expectedAuthorizationOrigin,
  handleResolutionMatchesDid,
  hasAllTwelveActions,
  isExpectedAuthorizationOrigin,
  NODE_OAUTH_ENV,
  spec,
  validatedCallbackSession,
} from '../live/node_oauth_check.ts';
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

test('a successful callback is signed out when the returned session has the wrong DID, and the gate fails', async () => {
  const expectedDid = 'did:plc:abcdefghijklmnopqrstuvwx';
  const callbackDid = 'did:plc:bcdefghijklmnopqrstuvwxy';
  const requests: { input: string | URL; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetch);
  const page = {
    evaluate: async (callback: (arg: unknown) => Promise<unknown>, arg: unknown) => callback(arg),
  } as unknown as import('@playwright/test').Page;
  const result = capture();
  const callbackBody = { did: callbackDid, csrfToken: 'callback-csrf-token' };
  const failingSpec = {
    ...spec,
    run: async () => {
      const activeSession: { value: { did: string; csrf: string } | null } = { value: null };
      let appSignOutCompleted = false;
      try {
        validatedCallbackSession({ status: 200, json: callbackBody }, 'A', expectedDid, (session) => {
          activeSession.value = session;
        });
      } finally {
        if (activeSession.value !== null && !appSignOutCompleted) {
          const logout = await browserRequest(page, '/api/v1/auth/logout', 'POST', activeSession.value.csrf, {});
          appSignOutCompleted = logout.status === 204;
        }
      }
      return { pds: [], subjects: [], results: {} };
    },
  };

  try {
    expect(await runNodeGate(failingSpec, completeEnv(), result.io)).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(requests[0]?.input).toBe('/api/v1/auth/logout');
    expect(requests[0]?.init?.method).toBe('POST');
    const requestHeaders = requests[0]?.init?.headers as Record<string, string> | undefined;
    expect(requestHeaders?.['x-csrf-token']).toBe('callback-csrf-token');
    expect(JSON.parse(result.output().stdout)).toMatchObject({
      result: 'failed',
      failures: ['PDS A sign-in resolved to a different DID'],
    });
  } finally {
    vi.unstubAllGlobals();
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
  const page = {
    evaluate: async (callback: (arg: unknown) => Promise<unknown>, arg: unknown) => callback(arg),
  } as unknown as import('@playwright/test').Page;
  const fetch = vi.fn(
    async (_input: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(browserRequest(page, '/api/v1/auth/logout', 'POST', undefined, {}, undefined, 20)).rejects.toThrow(
      /timed out/,
    );
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('the browser request deadline aborts a response body that never finishes', async () => {
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
        }),
    } as Response;
  });
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(browserRequest(page, '/api/v1/auth/logout', 'POST', undefined, {}, undefined, 20)).rejects.toThrow(
      /timed out/,
    );
    expect(fetch).toHaveBeenCalledOnce();
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
