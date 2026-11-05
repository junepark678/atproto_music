import childProcess, { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import { createRequire } from 'node:module';
import net from 'node:net';
import { resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { expect, test, vi } from 'vitest';
import {
  NODE_ENV,
  type NodeGateBodyResult,
  type NodeGateEvidence,
  type NodeGateIO,
  type NodeGateSpec,
  redactNodeGateOutput,
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

const emptyBody: NodeGateBodyResult = { pds: [], subjects: [], results: { checked: true, contract: true } };

function spec(run: NodeGateSpec['run'] = async () => emptyBody): NodeGateSpec {
  return {
    gate: 'oauth',
    script: 'scripts/live/node_ingest_check.ts',
    requirements: [
      {
        name: 'ATMUSIC_LIVE_TEST_PREREQUISITE',
        what: 'fixture-only prerequisite used by this harness regression',
        check: (value) => (value === 'ready' ? null : 'must equal ready'),
      },
    ],
    observations: [{ key: 'contract', accept: (value) => (value === true ? null : 'must be true') }],
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
      results: { origin, lexiconPrefix, declared: get('ATMUSIC_LIVE_TEST_PREREQUISITE'), contract: true },
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
    gate: 'oauth',
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
    spec(async () => ({ ...emptyBody, results: { credential: secret, contract: true } })),
    env,
    capture.io,
  );

  const stdout = capture.output().stdout;
  expect(stdout).not.toContain(secret);
  expect(documentFrom(stdout).results).toEqual({ credential: '[redacted]', contract: true });
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
    gate: 'oauth',
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
    spec(async () => ({ ...emptyBody, results: { token: env.ATMUSIC_LIVE_ADMIN_TOKEN, contract: true } })),
    env,
    capture.io,
  );
  expect(capture.files).toHaveLength(1);
  expect(capture.files[0]?.text).toBe(capture.output().stdout);
  expect(capture.files[0]?.text).not.toContain(env.ATMUSIC_LIVE_ADMIN_TOKEN);
});

test('unknown OAuth URL parameters and nested encoded URLs are stripped from every evidence channel', async () => {
  const capture = ioCapture();
  const secretCode = 'unknown-code-7f91';
  const secretState = 'unknown-state-a832';
  const secretRequest = 'opaque-request-uri-bb51';
  const nested = encodeURIComponent(
    `https://issuer.example/callback?code=${secretCode}&state=${secretState}#${secretRequest}`,
  );
  const deeplyNested = encodeURIComponent(
    encodeURIComponent(
      encodeURIComponent(
        `https://issuer.example/callback?code=${secretCode}&state=${secretState}&request_uri=${secretRequest}`,
      ),
    ),
  );
  let beyondLimit = `https://issuer.example/callback?code=${secretCode}&state=${secretState}`;
  for (let i = 0; i < 20; i++) beyondLimit = encodeURIComponent(beyondLimit);
  const encodedQuote = `https://issuer.example/callback?next=%2522%2526code%253D${secretCode}&state=${secretState}`;
  const mixedEscapeUrl = `https://issuer.example/cb%5Cu003fcode%3D${secretCode}%26state%3D${secretState}`;
  const nestedMixedEscapeUrl = encodeURIComponent(encodeURIComponent(mixedEscapeUrl));
  const escapedUrl = String.raw`https:\/\/issuer.example\/cb\u003fcode=${secretCode}\u0026state=${secretState}`;
  const reverseOrderUrl = encodeURIComponent(
    String.raw`https://issuer.example/cb\u003fcode=${secretCode}\u0026state=${secretState}`,
  );
  const percentThenEscapeUrl = `https://issuer.example/cb%255Cu003fcode=${secretCode}%255Cu0026state=${secretState}`;
  const backslashHexUrl = String.raw`https://issuer.example/cb\x3fcode=synthetic-code`;
  const bracedUnicodeUrl = String.raw`https://issuer.example/cb\u{3f}code=synthetic-code`;
  const encodeDepth = (value: string, depth: number) => {
    let encoded = value;
    for (let i = 0; i < depth; i++) encoded = encodeURIComponent(encoded);
    return encoded;
  };
  const boundaryDepthUrl = encodeDepth(
    String.raw`https://issuer.example/cb\u003fcode=${secretCode}&state=${secretState}`,
    15,
  );
  const exhaustedDepthUrl = encodeDepth(
    String.raw`https://issuer.example/cb\u003fcode=${secretCode}&state=${secretState}`,
    16,
  );
  const mixedBeyondBudgetUrl = encodeDepth(String.raw`https://issuer.example/cb\u{3f}code=synthetic-code`, 15);
  const apostropheUrl = `https://issuer.example/c'b?code=${secretCode}&state=${secretState}`;
  const env = validEnv({
    ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready',
    [NODE_ENV.evidenceOut]: '/tmp/evidence.json',
  });
  await runNodeGate(
    spec(async (context) => {
      context.log(`navigation https://issuer.example/cb?code=${secretCode}&state=${secretState}`);
      context.log(`mixed ${mixedEscapeUrl}`);
      context.cleanup(`retry ${nested}`);
      context.fail(`callback https://issuer.example/cb?request_uri=${secretRequest}`);
      return {
        ...emptyBody,
        results: {
          nested,
          deeplyNested,
          beyondLimit,
          encodedQuote,
          mixedEscapeUrl,
          nestedMixedEscapeUrl,
          escapedUrl,
          reverseOrderUrl,
          percentThenEscapeUrl,
          backslashHexUrl,
          bracedUnicodeUrl,
          boundaryDepthUrl,
          exhaustedDepthUrl,
          mixedBeyondBudgetUrl,
          apostropheUrl,
          contract: true,
          escaped: `https:\\\\issuer.example\\callback?code=${secretCode}`,
        },
      };
    }),
    env,
    capture.io,
  );
  const { stdout, stderr } = capture.output();
  const evidenceOutput = capture.files.map((f) => f.text).join('\n');
  for (const channel of [stdout, stderr, evidenceOutput]) {
    expect(channel).not.toContain(secretCode);
    expect(channel).not.toContain(secretState);
    expect(channel).not.toContain(secretRequest);
    expect(channel).not.toContain('synthetic-code');
    expect(channel).not.toContain('%253A');
  }
  expect(stdout).toContain('https://issuer.example/cb');
  expect(stdout).not.toContain('cb%5Cu003f');
  expect(() => JSON.parse(capture.files[0]!.text)).not.toThrow();
  expect(() => JSON.parse(stdout)).not.toThrow();
  expect(stderr).toContain('FAIL: oauth Node live gate failed');
  expect(() => JSON.parse(stdout)).not.toThrow();

  const thrown = ioCapture();
  const credentialUrl = `https://user:password@issuer.example/callback?code=${secretCode}&state=${secretState}#${secretRequest}`;
  await runNodeGate(
    spec(async () => {
      throw new Error(`unexpected runner failure at ${credentialUrl}`);
    }),
    env,
    thrown.io,
  );
  const thrownOutput = `${thrown.output().stdout}\n${thrown.output().stderr}\n${thrown.files.map((f) => f.text).join('\n')}`;
  expect(thrownOutput).not.toContain('user:password');
  expect(thrownOutput).not.toContain(secretCode);
  expect(thrownOutput).not.toContain(secretState);
  expect(thrownOutput).not.toContain(secretRequest);
});

test('malformed and depth-bounded HTTP URL escapes fail closed across evidence channels', async () => {
  const secret = 'callback-private-182735';
  const deeplyEncode = (url: string) => {
    let encoded = url;
    for (let depth = 0; depth < 16; depth++) encoded = encodeURIComponent(encoded);
    return encoded;
  };
  const candidates = [
    `https://issuer.example/cb%FF%5Cu003fcode%3D${secret}`,
    deeplyEncode(String.raw`https://issuer.example/cb\x3fcode=${secret}`),
    deeplyEncode(String.raw`https://issuer.example/cb\u{3f}code=${secret}`),
    String.raw`https://issuer.example/cb\u{110000}code=${secret}`,
    String.raw`https://issuer.example/cb\xZZcode=${secret}`,
    `http://private-user:private-password@issuer.example/cb?code=${secret}#${secret}`,
    `http://issuer.example/cb%FF%5Cu003fcode%3D${secret}`,
  ];
  for (const candidate of candidates) {
    const capture = ioCapture();
    await runNodeGate(
      spec(async (context) => {
        context.log(candidate);
        context.cleanup(candidate);
        context.fail(candidate);
        return { ...emptyBody, results: { candidate, [candidate]: candidate } };
      }),
      validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready', [NODE_ENV.evidenceOut]: '/tmp/evidence.json' }),
      capture.io,
    );
    expect(capture.files).toHaveLength(1);
    for (const output of [capture.output().stdout, capture.output().stderr, capture.files[0]!.text]) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain('private-user');
      expect(output).not.toContain('private-password');
    }
    expect(() => JSON.parse(capture.files[0]!.text)).not.toThrow();
  }
});

test('optional requirements skip missing values but validate supplied values', async () => {
  const body = vi.fn(async () => emptyBody);
  const optionalSpec = spec(body);
  optionalSpec.requirements = [
    ...optionalSpec.requirements,
    {
      name: 'ATMUSIC_OPTIONAL',
      what: 'optional input',
      optional: true,
      check: (value) => (value === 'ok' ? null : 'invalid'),
    },
  ];
  for (const value of [undefined, '']) {
    const env = validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' });
    if (value !== undefined) env.ATMUSIC_OPTIONAL = value;
    expect(await runNodeGate(optionalSpec, env, ioCapture().io)).toBe(0);
  }
  for (const value of ['bad', '0', '-1', '3601']) {
    const env = validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready', ATMUSIC_OPTIONAL: value });
    expect(await runNodeGate(optionalSpec, env, ioCapture().io)).toBe(2);
  }
});

test('observations fail for missing, undefined, rejected, and throwing validators', async () => {
  for (const results of [{}, { proof: undefined }, { proof: 'placeholder' }]) {
    const capture = ioCapture();
    const custom = {
      ...spec(async () => ({ pds: [], subjects: [], results })),
      observations: [{ key: 'proof', accept: (value: unknown) => (value === 'verified' ? null : 'not verified') }],
    } satisfies NodeGateSpec;
    expect(await runNodeGate(custom, validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }), capture.io)).toBe(1);
    expect(documentFrom(capture.output().stdout).result).toBe('failed');
  }
  const thrown = ioCapture();
  const custom = {
    ...spec(async () => ({ pds: [], subjects: [], results: { proof: true } })),
    observations: [
      {
        key: 'proof',
        accept: () => {
          throw new Error('validator exploded');
        },
      },
    ],
  } satisfies NodeGateSpec;
  expect(await runNodeGate(custom, validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }), thrown.io)).toBe(1);
  expect(documentFrom(thrown.output().stdout).failures?.join(' ')).toContain('validator exploded');
});

test('an explicit informational block needs no approved contract but cannot bypass failures or known contracts', async () => {
  for (const gate of ['ssrfProbe', 'socketSoak'] as const) {
    for (const failed of [false, true]) {
      const candidate: NodeGateSpec = {
        ...spec(async (context) => {
          context.block('acceptance contract is not approved');
          if (failed) context.fail('probe failed');
          return { pds: [], subjects: [], results: { diagnostic: true } };
        }),
        gate,
        observations: undefined,
      };
      const capture = ioCapture();
      expect(await runNodeGate(candidate, validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }), capture.io)).toBe(
        failed ? 1 : 2,
      );
      expect(documentFrom(capture.output().stdout).result).toBe(failed ? 'failed' : 'blocked');
    }
  }
  const capture = ioCapture();
  expect(
    await runNodeGate(
      {
        ...spec(async (context) => {
          context.block('informational');
          return { pds: [], subjects: [], results: {} };
        }),
        gate: 'ingest',
        observations: undefined,
      },
      validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }),
      capture.io,
    ),
  ).toBe(1);
});

test('URL redaction preserves diagnostic words but strips raw and escaped URL credentials', () => {
  const env = validEnv();
  for (const diagnostic of ['http_status', 'https_status', 'http_error', 'http500']) {
    expect(redactNodeGateOutput(diagnostic, env)).toBe(diagnostic);
  }
  for (const url of [
    'https://issuer.example/cb?code=private-callback-value',
    String.raw`https\u003a\u002f\u002fissuer.example/cb?code=private-callback-value`,
    'https%3A%2F%2Fissuer.example%2Fcb%3Fcode%3Dprivate-callback-value',
  ])
    expect(redactNodeGateOutput(url, env)).not.toContain('private-callback-value');
});

test('every gate with an empty body fails unless it receives its gate observation contract', async () => {
  for (const gate of ['oauth', 'ingest', 'pdsCompat', 'ssrfProbe', 'socketSoak'] as const) {
    const candidate: NodeGateSpec = {
      ...spec(async () => ({ pds: [], subjects: [], results: {} })),
      gate,
      observations: undefined,
    };
    const capture = ioCapture();
    expect(await runNodeGate(candidate, validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }), capture.io)).toBe(1);
    expect(documentFrom(capture.output().stdout).result).toBe('failed');
  }
});

test('built-in ingest and PDS contracts reject no-op results; explicit contracts can pass or reject', async () => {
  for (const gate of ['ingest', 'pdsCompat'] as const) {
    const capture = ioCapture();
    expect(
      await runNodeGate(
        { ...spec(async () => ({ pds: [], subjects: [], results: {} })), gate },
        validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }),
        capture.io,
      ),
    ).toBe(1);
  }
  const good = ioCapture();
  const explicit: NodeGateSpec = {
    ...spec(async () => ({ pds: [], subjects: [], results: { proof: 'verified' } })),
    observations: [{ key: 'proof', accept: (value) => (value === 'verified' ? null : 'not verified') }],
  };
  expect(await runNodeGate(explicit, validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }), good.io)).toBe(0);
  const bad = ioCapture();
  expect(
    await runNodeGate(
      { ...explicit, run: async () => ({ pds: [], subjects: [], results: { proof: 'nope' } }) },
      validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }),
      bad.io,
    ),
  ).toBe(1);
});

test('local checks run only after prerequisites and block before body on errors or exceptions', async () => {
  const localChecks = vi.fn(() => ['local artifact missing']);
  const unexpected = () => {
    throw new Error('blocked path attempted external work');
  };
  const tripwires = [
    vi.spyOn(globalThis, 'fetch').mockImplementation(unexpected),
    vi.spyOn(dns, 'lookup').mockImplementation(unexpected),
    vi.spyOn(dns.promises, 'lookup').mockImplementation(unexpected),
    vi.spyOn(dns, 'resolve').mockImplementation(unexpected),
    vi.spyOn(dns, 'resolve4').mockImplementation(unexpected),
    vi.spyOn(dns, 'resolve6').mockImplementation(unexpected),
    vi.spyOn(dns, 'resolveTxt').mockImplementation(unexpected),
    vi.spyOn(dns.promises, 'resolve').mockImplementation(unexpected),
    vi.spyOn(dns.promises, 'resolve4').mockImplementation(unexpected),
    vi.spyOn(dns.promises, 'resolve6').mockImplementation(unexpected),
    vi.spyOn(net, 'connect').mockImplementation(unexpected),
    vi.spyOn(net, 'createConnection').mockImplementation(unexpected),
    vi.spyOn(tls, 'connect').mockImplementation(unexpected),
    vi.spyOn(childProcess, 'spawn').mockImplementation(unexpected),
    vi.spyOn(chromium, 'launch').mockImplementation(unexpected),
  ];
  const body = vi.fn(async () => emptyBody);
  const candidate = { ...spec(body), localChecks };
  try {
    const invalid = ioCapture();
    expect(await runNodeGate(candidate, {}, invalid.io)).toBe(2);
    expect(localChecks).not.toHaveBeenCalled();
    const valid = ioCapture();
    expect(await runNodeGate(candidate, validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }), valid.io)).toBe(2);
    expect(documentFrom(valid.output().stdout).missing).toContain('local artifact missing');
    const throws = ioCapture();
    expect(
      await runNodeGate(
        {
          ...candidate,
          localChecks: () => {
            throw new Error('git unavailable');
          },
        },
        validEnv({ ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready' }),
        throws.io,
      ),
    ).toBe(2);
    expect(documentFrom(throws.output().stdout).missing?.join(' ')).toContain('git unavailable');
    expect(body).not.toHaveBeenCalled();
    for (const tripwire of tripwires) expect(tripwire).not.toHaveBeenCalled();
  } finally {
    for (const tripwire of tripwires) tripwire.mockRestore();
  }
});

test('redacts KEY, COOKIE, CSRF secrets and absolute home/runtime paths in every evidence channel', async () => {
  const env = validEnv({
    ATMUSIC_LIVE_TEST_PREREQUISITE: 'ready',
    ATMUSIC_LIVE_SIGNING_KEY: 'signing-key-value',
    ATMUSIC_LIVE_SESSION_COOKIE: 'cookie-value-123',
    ATMUSIC_LIVE_CSRF: 'csrf-secret-value',
    [NODE_ENV.evidenceOut]: '/tmp/live-evidence.json',
  });
  const capture = ioCapture();
  await runNodeGate(
    spec(async (context) => {
      context.log(`/home/june/private ${env.ATMUSIC_LIVE_SIGNING_KEY}`);
      context.cleanup(`/Users/june/private ${env.ATMUSIC_LIVE_SESSION_COOKIE}`);
      context.fail(`/run/user/1000/private ${env.ATMUSIC_LIVE_CSRF} /run/user/1000`);
      return {
        ...emptyBody,
        results: { '/home/june/private': `/run/user/1000/x ${env.ATMUSIC_LIVE_SIGNING_KEY}`, contract: true },
      };
    }),
    env,
    capture.io,
  );
  const outputs = [capture.output().stdout, capture.output().stderr, ...capture.files.map(({ text }) => text)].join(
    '\n',
  );
  for (const secret of [
    'signing-key-value',
    'cookie-value-123',
    'csrf-secret-value',
    '/home/june/',
    '/Users/june/',
    '/run/user/1000/',
    '/run/user/1000',
  ]) {
    expect(outputs).not.toContain(secret);
  }
  expect(capture.files[0]?.path).toBe('/tmp/live-evidence.json');
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
