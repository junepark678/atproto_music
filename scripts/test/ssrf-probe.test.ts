// Offline tests for scripts/live/ssrf_probe.ts: the emitted Node probe artifact,
// fail-before-network blocking, host/address hardening, and outcome
// classification through the real pinned transport over fake network
// primitives. Nothing here opens a socket or resolves a name.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { duplexPair } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PINNED_CAPS,
  pinnedTransport,
  TransportError,
  unpinnedFetchStub,
} from '@atmusic/worker/node/pinned-transport';
import { afterAll, describe, expect, test } from 'vitest';
import { NODE_ENV, NODE_EXIT_CODES, type NodeGateIO, runNodeGate } from '../live/node-live-gate.ts';
import {
  addressClass,
  checkProbeResult,
  LITERAL_TARGETS,
  observePinnedLookup,
  PROBE_RESULT_KIND,
  PROBE_RESULT_SCHEMA_VERSION,
  type ProbeOutcome,
  type ProbeResult,
  parseHosts,
  parseProbeArgs,
  probeResultExitCode,
  probeTargets,
  probeTargetsFor,
  SSRF_ENV,
  spec,
  writePrivateProbeResult,
} from '../live/ssrf_probe.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DRIVER = resolve(REPO, 'scripts/live/ssrf_probe.ts');
const HOSTS =
  'rfc1918=rfc1918.probe.example.org,loopback=loopback.probe.example.org,metadata=metadata.probe.example.org';
const ORIGIN = 'https://music.atproto-music.org';

// Preloaded into every spawned process: any attempt to resolve, connect or
// fetch terminates the process with status 97, so a passing spawn proves the
// command made no network call.
const NET_TRAP = `
import dns from 'node:dns';
import { createRequire } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
const trip = (what) => () => { process.stderr.write('network call during emission: ' + what + '\\n'); process.exit(97); };
globalThis.__SSRF_NETWORK_TRAP_INSTALLED = true;
dns.lookup = trip('dns.lookup'); dns.resolve = trip('dns.resolve'); dns.resolve4 = trip('dns.resolve4'); dns.resolve6 = trip('dns.resolve6');
dns.promises.lookup = trip('dns.promises.lookup'); dns.promises.resolve = trip('dns.promises.resolve');
net.connect = trip('net.connect'); net.createConnection = trip('net.createConnection');
tls.connect = trip('tls.connect');
http.request = trip('http.request'); http.get = trip('http.get'); https.request = trip('https.request'); https.get = trip('https.get');
globalThis.fetch = trip('fetch');
createRequire(import.meta.url)('node:module').syncBuiltinESMExports();
`;

const scratch = mkdtempSync(join(tmpdir(), 'ssrf-probe-test-'));
const trapPath = join(scratch, 'net-trap.mjs');
writeFileSync(trapPath, NET_TRAP);
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function liveEnvUnset(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('ATMUSIC_LIVE_')) delete env[name];
  }
  return env;
}

function spawnDriver(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--import=tsx', '--import', trapPath, DRIVER, ...args], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
    cwd: REPO,
  });
}

function spawnScript(path: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--import=tsx', '--import', trapPath, path], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
    cwd: REPO,
  });
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

function completeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    [NODE_ENV.commit]: '1'.repeat(40),
    [NODE_ENV.bundleSha256]: 'a'.repeat(64),
    [NODE_ENV.origin]: ORIGIN,
    [NODE_ENV.prefix]: 'org.atproto.music',
    [SSRF_ENV.hosts]: HOSTS,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// --emit-probe

describe('scripts/live/ssrf_probe.ts › --emit-probe', () => {
  test('writes a Node probe script and prints no wrangler command; no file under scripts/live mentions wrangler', () => {
    const dir = `work/ssrf-probe-test-${process.pid}`;
    const abs = resolve(REPO, dir);
    rmSync(abs, { recursive: true, force: true });
    try {
      const run = spawnDriver(['--emit-probe', dir], liveEnvUnset());
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      const probePath = resolve(abs, 'probe.ts');
      expect(existsSync(probePath)).toBe(true);
      expect(run.stdout).toContain(`wrote ${probePath}`);
      expect(run.stdout).toContain(`npx tsx ./${dir}/probe.ts`);
      expect(run.stdout.toLowerCase()).not.toContain('wrangler');

      const source = readFileSync(probePath, 'utf8');
      expect(source.toLowerCase()).not.toContain('wrangler');
      expect(source).toContain("from '@atmusic/worker/node/pinned-transport'");
      expect(source).toContain(
        'pinnedTransport({ caps: DEFAULT_PINNED_CAPS, lookup: observedLookup.lookup, connector: tlsSocketConnector })',
      );
      expect(source).toContain('observePinnedLookup(systemLookup)');
      expect(source).toContain("from '../../scripts/live/ssrf_probe.ts'");
      // The emitted probe only runs when invoked explicitly; importing it must not be a side effect of the gate.
      expect(readFileSync(DRIVER, 'utf8')).not.toMatch(/from '[^']*\/probe\.ts'/);
    } finally {
      rmSync(abs, { recursive: true, force: true });
    }
    expect(readFileSync(DRIVER, 'utf8').toLowerCase()).not.toContain('wrangler');
  });

  test('the network trap intercepts fetch in the actual tsx child process', () => {
    const target = join(scratch, 'trap-child.mjs');
    writeFileSync(
      target,
      "if (globalThis.__SSRF_NETWORK_TRAP_INSTALLED !== true) process.exit(98); globalThis.fetch('https://example.invalid');\n",
    );
    const run = spawnScript(target, liveEnvUnset());
    expect(run.status).toBe(97);
    expect(run.stderr).toContain('network call during emission: fetch');
  });

  test('refuses a directory outside the repository and a malformed invocation', () => {
    const outside = spawnDriver(['--emit-probe', join(scratch, 'elsewhere')], liveEnvUnset());
    expect(outside.status).not.toBe(0);
    expect(outside.stderr).toContain('probe script could not be emitted');
    expect(existsSync(join(scratch, 'elsewhere', 'probe.ts'))).toBe(false);

    const usage = spawnDriver(['--emit-probe', 'a', 'b'], liveEnvUnset());
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('usage');

    const unknown = spawnDriver(['--emit-worker'], liveEnvUnset());
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown arguments');
  });

  test('malformed runner arguments cannot echo unknown option values and do not open a socket', () => {
    const dir = `work/ssrf-probe-args-${process.pid}`;
    const abs = resolve(REPO, dir);
    rmSync(abs, { recursive: true, force: true });
    try {
      expect(spawnDriver(['--emit-probe', dir], liveEnvUnset()).status).toBe(0);
      const probe = resolve(abs, 'probe.ts');
      const secret = 'synthetic-private-argument-secret';
      // The generated runner is invoked with its untrusted arguments below.
      const malformed = spawnSync(
        process.execPath,
        ['--import=tsx', '--import', trapPath, probe, `--unknown=${secret}`],
        { env: liveEnvUnset(), encoding: 'utf8', timeout: 60_000, cwd: REPO },
      );
      expect(malformed.status).toBe(2);
      expect(malformed.stdout).not.toContain(secret);
      expect(malformed.stderr).not.toContain(secret);
      expect(malformed.stderr).toContain('invalid probe arguments');
      expect(malformed.stderr).not.toContain('network call during emission');
    } finally {
      rmSync(abs, { recursive: true, force: true });
    }
  });

  test('private result writer creates an owner-only file and refuses replacement', () => {
    const path = join(scratch, 'private-result.json');
    writePrivateProbeResult(path, '{"safe":true}\n');
    expect(readFileSync(path, 'utf8')).toBe('{"safe":true}\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writePrivateProbeResult(path, '{}')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Blocked before any network

describe('scripts/live/ssrf_probe.ts › prerequisites', () => {
  test('with nothing set the driver prints blocked with every missing name and exits 2', () => {
    const run = spawnDriver([], liveEnvUnset());
    expect(run.status).toBe(NODE_EXIT_CODES.blocked);
    expect(run.stdout).toContain('blocked');
    for (const name of [
      ...Object.values(NODE_ENV).filter((n) => n !== NODE_ENV.evidenceOut),
      ...Object.values(SSRF_ENV),
    ]) {
      expect(run.stdout).toContain(name);
    }
    expect(run.stdout.toLowerCase()).not.toContain('wrangler');
  });

  test('a missing or relative probe result path blocks before anything is read', async () => {
    const missing = capturedIO();
    expect(await runNodeGate(spec, completeEnv(), missing.io)).toBe(NODE_EXIT_CODES.blocked);
    expect(missing.output().stdout).toContain(SSRF_ENV.probeResult);
    expect(missing.output().stdout).toContain('no live request was made');

    const relative = capturedIO();
    expect(await runNodeGate(spec, completeEnv({ [SSRF_ENV.probeResult]: 'result.json' }), relative.io)).toBe(
      NODE_EXIT_CODES.blocked,
    );
    expect(relative.output().stdout).toContain('absolute path');

    const absent = capturedIO();
    expect(
      await runNodeGate(spec, completeEnv({ [SSRF_ENV.probeResult]: join(scratch, 'absent.json') }), absent.io),
    ).toBe(NODE_EXIT_CODES.blocked);
    expect(absent.output().stdout).toContain('does not exist');
  });

  test('a malformed host list blocks with the parse problem', async () => {
    const io = capturedIO();
    const env = completeEnv({ [SSRF_ENV.hosts]: 'rfc1918=10.0.0.1,loopback=lo.example.org,metadata=md.example.org' });
    expect(await runNodeGate(spec, env, io.io)).toBe(NODE_EXIT_CODES.blocked);
    expect(io.output().stdout).toContain('canonical label=host pairs');
    expect(io.output().stdout).not.toContain('10.0.0.1');
  });
});

// ---------------------------------------------------------------------------
// Host parsing and address classification

describe('scripts/live/ssrf_probe.ts › parseHosts', () => {
  test('accepts canonical label=host lists', () => {
    expect(parseHosts(HOSTS)).toEqual({
      rfc1918: 'rfc1918.probe.example.org',
      loopback: 'loopback.probe.example.org',
      metadata: 'metadata.probe.example.org',
    });
    expect(parseHosts(`${HOSTS},extra=extra.probe.example.org`).extra).toBe('extra.probe.example.org');
  });

  test.each([
    ['', 'empty entry'],
    ['rfc1918=a.example.org,,loopback=b.example.org,metadata=c.example.org', 'empty entry'],
    ['rfc1918=a.example.org, loopback=b.example.org,metadata=c.example.org', 'whitespace'],
    ['rfc1918=a.example.org,loopback=b.example.org', 'missing required label metadata'],
    ['rfc1918=a.example.org,rfc1918=b.example.org,loopback=c.example.org,metadata=d.example.org', 'duplicate label'],
    ['rfc1918=a.example.org,loopback=a.example.org,metadata=d.example.org', 'listed twice'],
    ['RFC1918=a.example.org,loopback=b.example.org,metadata=c.example.org', 'label'],
    ['rfc1918.x=a.example.org,loopback=b.example.org,metadata=c.example.org', 'label'],
    ['rfc1918=A.example.org,loopback=b.example.org,metadata=c.example.org', 'lowercase'],
    ['rfc1918=10.0.0.1,loopback=b.example.org,metadata=c.example.org', 'IP literal'],
    ['rfc1918=[::1],loopback=b.example.org,metadata=c.example.org', 'bare DNS name'],
    ['rfc1918=::1,loopback=b.example.org,metadata=c.example.org', 'bare DNS name'],
    ['rfc1918=a.example.org:443,loopback=b.example.org,metadata=c.example.org', 'bare DNS name'],
    ['rfc1918=https://a.example.org,loopback=b.example.org,metadata=c.example.org', 'bare DNS name'],
    ['rfc1918=a.example.org/x,loopback=b.example.org,metadata=c.example.org', 'bare DNS name'],
    ['rfc1918=u@a.example.org,loopback=b.example.org,metadata=c.example.org', 'bare DNS name'],
    ['rfc1918=a%2eexample.org,loopback=b.example.org,metadata=c.example.org', 'bare DNS name'],
    ['rfc1918=fe80::1%eth0,loopback=b.example.org,metadata=c.example.org', 'bare DNS name'],
    ['rfc1918=a.example.org.,loopback=b.example.org,metadata=c.example.org', 'trailing dot'],
    ['rfc1918=0x7f.0x1,loopback=b.example.org,metadata=c.example.org', 'canonicalizes this host to an IP literal'],
    ['rfc1918=a.example.123,loopback=b.example.org,metadata=c.example.org', 'numeric top-level'],
    ['rfc1918=example,loopback=b.example.org,metadata=c.example.org', 'single-label'],
    ['rfc1918=a.localhost,loopback=b.example.org,metadata=c.example.org', 'localhost'],
    ['rfc1918=-a.example.org,loopback=b.example.org,metadata=c.example.org', 'malformed DNS label'],
    ['rfc1918=a_b.example.org,loopback=b.example.org,metadata=c.example.org', 'malformed DNS label'],
    ['rfc1918=ä.example.org,loopback=b.example.org,metadata=c.example.org', 'printable ASCII'],
    ['rfc1918=a.example.org\n,loopback=b.example.org,metadata=c.example.org', 'whitespace'],
    ['rfc1918=,loopback=b.example.org,metadata=c.example.org', 'empty host'],
    ['rfc1918,loopback=b.example.org,metadata=c.example.org', 'label=host'],
  ])('rejects %j', (text, problem) => {
    expect(() => parseHosts(text)).toThrow(problem);
  });
});

describe('scripts/live/ssrf_probe.ts › addressClass', () => {
  test.each([
    ['10.0.0.1', 'rfc1918'],
    ['172.16.0.1', 'rfc1918'],
    ['172.31.255.255', 'rfc1918'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'rfc1918'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'metadata'],
    ['169.254.1.1', 'linkLocal'],
    ['100.64.0.1', 'cgnat'],
    ['0.0.0.0', 'other'],
    ['224.0.0.1', 'other'],
    ['192.0.2.1', 'documentation'],
    ['8.8.8.8', 'public'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::ffff:10.0.0.1', 'rfc1918'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['fd00:ec2::254', 'metadata'],
    ['fd00:ec2::255', 'ula'],
    ['fd12::1', 'ula'],
    ['fe80::1', 'linkLocal'],
    ['2001:db8::1', 'documentation'],
    ['2606:4700::1111', 'public'],
    ['::', 'other'],
    ['2002:0a00:0001::1', 'other'],
    // Ambiguous or non-canonical textual forms are never trusted as a class.
    ['2130706433', 'other'],
    ['0177.0.0.1', 'other'],
    ['0x7f.0.0.1', 'other'],
    ['127.1', 'other'],
    ['010.0.0.1', 'other'],
    ['10.0.0.1 ', 'other'],
    ['fe80::1%eth0', 'other'],
    ['[fe80::1%25eth0]', 'other'],
    ['::ffff:0177.0.0.1', 'other'],
    ['', 'other'],
    ['example.org', 'other'],
  ])('%s → %s', (ip, cls) => {
    expect(addressClass(ip)).toBe(cls);
  });
});

// ---------------------------------------------------------------------------
// Outcomes through the real pinned transport over fake network primitives

type Answers = (hostname: string) => Promise<{ address: string; family?: 4 | 6 }[]>;

function manualTimer() {
  const pending: { ms: number; controller: AbortController }[] = [];
  return {
    timeout(ms: number): AbortSignal {
      const controller = new AbortController();
      pending.push({ ms, controller });
      return controller.signal;
    },
    fireAll() {
      for (const p of pending.splice(0)) p.controller.abort(new DOMException('deadline', 'TimeoutError'));
    },
  };
}

function fakeNet(answers: Answers, serve?: (server: import('node:stream').Duplex) => void) {
  const lookups: string[] = [];
  const connects: unknown[] = [];
  return {
    lookups,
    connects,
    lookup: async (hostname: string) => {
      lookups.push(hostname);
      return answers(hostname);
    },
    connector: (options: unknown) => {
      connects.push(options);
      const [client, server] = duplexPair();
      if (serve) serve(server);
      return Promise.resolve(client);
    },
  };
}

const CAPS = { maxResponseBytes: 1 << 20, maxRequestBytes: 1 << 20, deadlineMs: 60_000 };

async function probeOne(
  target: { label: string; host: string; kind: 'controlledName' | 'literal' },
  net: ReturnType<typeof fakeNet>,
  timer = manualTimer(),
): Promise<ProbeOutcome> {
  const observed = observePinnedLookup(net.lookup);
  const transport = pinnedTransport({ caps: CAPS, lookup: observed.lookup, connector: net.connector, timer });
  try {
    const [outcome] = await probeTargets([target], { transport, lookup: observed });
    return outcome as ProbeOutcome;
  } finally {
    await transport.close();
  }
}

describe('scripts/live/ssrf_probe.ts › probeTargets', () => {
  test('a private IP literal is refused by policy without a lookup or a connection', async () => {
    const net = fakeNet(() => Promise.reject(new Error('must not resolve a literal')));
    const outcome = await probeOne({ label: 'rfc1918', host: LITERAL_TARGETS.rfc1918, kind: 'literal' }, net);
    expect(outcome.safeFetch).toEqual({ outcome: 'refused', code: 'private_literal' });
    expect(outcome.resolved).toEqual({ addresses: ['10.0.0.1'], classes: ['rfc1918'] });
    expect(outcome.raw).toHaveLength(1);
    expect(outcome.raw[0]).toMatchObject({ url: 'https://10.0.0.1/', outcome: 'refused', code: 'private_literal' });
    expect(net.lookups).toEqual([]);
    expect(net.connects).toEqual([]);
  });

  test('a controlled name resolving to a private answer is refused by policy with no connection', async () => {
    const net = fakeNet(() => Promise.resolve([{ address: '192.168.1.1', family: 4 }]));
    const outcome = await probeOne(
      { label: 'rfc1918', host: 'rfc1918.probe.example.org', kind: 'controlledName' },
      net,
    );
    expect(outcome.safeFetch).toEqual({ outcome: 'refused', code: 'private_answer' });
    expect(outcome.resolved).toEqual({ addresses: ['192.168.1.1'], classes: ['rfc1918'] });
    expect(net.connects).toEqual([]);
  });

  test('a mixed answer set (public and metadata) is refused and the mix is recorded', async () => {
    const net = fakeNet(() => Promise.resolve([{ address: '93.184.216.34' }, { address: '169.254.169.254' }]));
    const outcome = await probeOne(
      { label: 'metadata', host: 'metadata.probe.example.org', kind: 'controlledName' },
      net,
    );
    expect(outcome.safeFetch).toEqual({ outcome: 'refused', code: 'private_answer' });
    expect(outcome.resolved.classes).toEqual(['public', 'metadata']);
    expect(net.connects).toEqual([]);
  });

  test('evidence records the exact lookup answers used by the transport', async () => {
    let calls = 0;
    const net = fakeNet(async () => {
      calls += 1;
      return calls === 1
        ? [{ address: '10.0.0.1', family: 4 }]
        : [
            { address: '93.184.216.34', family: 4 },
            { address: '192.0.2.1', family: 4 },
          ];
    });
    const outcome = await probeOne({ label: 'extra', host: 'changing.example.org', kind: 'controlledName' }, net);
    expect(calls).toBe(1);
    expect(outcome.resolved.addresses).toEqual(['10.0.0.1']);
    expect(outcome.resolved.classes).toEqual(['rfc1918']);
    expect(outcome.safeFetch).toEqual({ outcome: 'refused', code: 'private_answer' });
  });

  test('a DNS failure is reported as dns, not as a refusal', async () => {
    const net = fakeNet(() => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })));
    const outcome = await probeOne(
      { label: 'loopback', host: 'loopback.probe.example.org', kind: 'controlledName' },
      net,
    );
    expect(outcome.safeFetch).toEqual({ outcome: 'dns', code: 'ENOTFOUND' });
    expect(outcome.resolved).toEqual({ addresses: [], classes: [], error: 'ENOTFOUND' });
    const empty = fakeNet(() => Promise.resolve([]));
    const none = await probeOne(
      { label: 'loopback', host: 'loopback.probe.example.org', kind: 'controlledName' },
      empty,
    );
    expect(none.safeFetch).toEqual({ outcome: 'dns', code: 'no_answers' });
  });

  test('a public answer that never responds is reported as timeout', async () => {
    const timer = manualTimer();
    const net = fakeNet(() => Promise.resolve([{ address: '93.184.216.34' }]));
    const observed = observePinnedLookup(net.lookup);
    const transport = pinnedTransport({ caps: CAPS, lookup: observed.lookup, connector: net.connector, timer });
    try {
      const pending = probeTargets([{ label: 'extra', host: 'slow.probe.example.org', kind: 'controlledName' }], {
        transport,
        lookup: observed,
      });
      for (let i = 0; i < 50 && net.connects.length === 0; i++) await new Promise((r) => setImmediate(r));
      timer.fireAll();
      const [outcome] = await pending;
      expect(outcome?.safeFetch.outcome).toBe('timeout');
      expect(['deadline', 'aborted', 'connect_deadline']).toContain(outcome?.safeFetch.code);
    } finally {
      await transport.close();
    }
  });

  test('a public answer that responds is reported as fetched with its status, body discarded', async () => {
    const net = fakeNet(
      () => Promise.resolve([{ address: '93.184.216.34' }]),
      (server) => {
        server.on('data', () => {
          server.write('HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\nsecret');
          server.end();
        });
      },
    );
    const outcome = await probeOne({ label: 'extra', host: 'open.probe.example.org', kind: 'controlledName' }, net);
    expect(outcome.safeFetch).toEqual({ outcome: 'fetched', code: 'status_200' });
    expect(JSON.stringify(outcome)).not.toContain('secret');
  });

  test('the unpinned-fetch stub is reported as unpinned_fetch', async () => {
    const [outcome] = await probeTargets([{ label: 'loopback', host: LITERAL_TARGETS.loopback, kind: 'literal' }], {
      transport: unpinnedFetchStub,
    });
    expect(outcome?.safeFetch).toEqual({ outcome: 'unpinned_fetch', code: 'unpinned_fetch' });
  });

  test('arbitrary transport exceptions are reduced to fixed diagnostics', async () => {
    const secret = 'synthetic-network-error-secret';
    let invoked = false;
    const transport: import('@atmusic/atproto/transport').Transport = async () => {
      invoked = true;
      throw Object.assign(new Error(`connection failed with ${secret}`), { code: secret });
    };
    const [outcome] = await probeTargets(
      [{ label: 'rfc1918', host: 'rfc1918.probe.example.org', kind: 'controlledName' }],
      { transport },
    );
    expect(invoked).toBe(true);
    expect(outcome?.safeFetch).toEqual({ outcome: 'error', code: 'unknown' });
    expect(outcome?.raw[0]?.message).toBe('request failed with an unclassified error');
    expect(JSON.stringify(outcome)).not.toContain(secret);

    const transportSecret = 'synthetic-transport-reason-secret';
    const [transportFailure] = await probeTargets(
      [{ label: 'rfc1918', host: 'rfc1918.probe.example.org', kind: 'controlledName' }],
      {
        transport: async () => {
          throw new TransportError('connect', `private details ${transportSecret}`, { reason: transportSecret });
        },
      },
    );
    expect(transportFailure?.safeFetch).toEqual({ outcome: 'connect', code: 'connect' });
    expect(transportFailure?.raw[0]?.message).toBe('connection did not complete');
    expect(JSON.stringify(transportFailure)).not.toContain(transportSecret);

    const dnsSecret = 'synthetic-dns-detail-secret';
    const dnsNet = fakeNet(() => Promise.reject(Object.assign(new Error(dnsSecret), { code: dnsSecret })));
    const dnsFailure = await probeOne(
      { label: 'rfc1918', host: 'rfc1918.probe.example.org', kind: 'controlledName' },
      dnsNet,
    );
    expect(dnsFailure.safeFetch).toEqual({ outcome: 'dns', code: 'dns' });
    expect(dnsFailure.resolved.error).toBe('unknown');
    expect(JSON.stringify(dnsFailure)).not.toContain(dnsSecret);
  });

  test('builds one controlled-name target per host plus the three literals', () => {
    const targets = probeTargetsFor(parseHosts(HOSTS));
    expect(targets.map((t) => `${t.kind}:${t.label}:${t.host}`)).toEqual([
      'controlledName:rfc1918:rfc1918.probe.example.org',
      'controlledName:loopback:loopback.probe.example.org',
      'controlledName:metadata:metadata.probe.example.org',
      'literal:rfc1918:10.0.0.1',
      'literal:loopback:127.0.0.1',
      'literal:metadata:169.254.169.254',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Gate body over a recorded result

function recordedResult(mutate: (result: ProbeResult) => void = () => undefined): ProbeResult {
  const hosts = parseHosts(HOSTS);
  const result: ProbeResult = {
    schemaVersion: PROBE_RESULT_SCHEMA_VERSION,
    kind: PROBE_RESULT_KIND,
    recordedAt: '2026-08-15T11:59:00.000Z',
    hostname: 'origin-host',
    origin: ORIGIN,
    transport: 'pinned',
    caps: { ...DEFAULT_PINNED_CAPS },
    hosts,
    targets: probeTargetsFor(hosts).map((target) => {
      const literal = target.kind === 'literal';
      const address = literal
        ? target.host
        : ({ rfc1918: '10.1.2.3', loopback: '127.0.0.2', metadata: '169.254.169.254' }[target.label] as string);
      const code = literal ? 'private_literal' : 'private_answer';
      return {
        target,
        resolved: { addresses: [address], classes: [addressClass(address)] },
        raw: [
          {
            url: `https://${target.host}/`,
            outcome: 'refused',
            code,
            message: 'destination refused by transport policy',
            elapsedMs: 1,
          },
        ],
        safeFetch: { outcome: 'refused', code },
      };
    }),
  };
  mutate(result);
  return result;
}

function setOutcome(
  result: ProbeResult,
  index: number,
  outcome: ProbeOutcome['safeFetch']['outcome'],
  code: string,
): void {
  const target = result.targets[index] as ProbeOutcome;
  target.safeFetch = { outcome, code };
  target.raw[0]!.outcome = outcome;
  target.raw[0]!.code = code;
}

async function runGateWith(result: unknown) {
  const path = join(scratch, `result-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(result));
  const io = capturedIO();
  let evidence = '';
  const gateIO: NodeGateIO = { ...io.io, writeEvidence: (_path, text) => (evidence = text) };
  const code = await runNodeGate(
    spec,
    completeEnv({ [SSRF_ENV.probeResult]: path, [NODE_ENV.evidenceOut]: 'captured-evidence.json' }),
    gateIO,
  );
  return { code, evidence, ...io.output() };
}

describe('scripts/live/ssrf_probe.ts › gate body', () => {
  test('preserves valid observations but keeps acceptance blocked until the contract is approved', async () => {
    const run = await runGateWith(recordedResult());
    expect(run.stderr).toContain(
      'BLOCKED: ssrfProbe Node live gate observations were recorded but acceptance is disabled',
    );
    expect(run.stderr).not.toContain('PASS: ssrfProbe');
    expect(run.code).toBe(NODE_EXIT_CODES.blocked);
    const doc = JSON.parse(run.stdout);
    expect(doc.gate).toBe('ssrfProbe');
    expect(doc.result).toBe('blocked');
    expect(doc.missing.join('\n')).toContain('acceptance is disabled');
    expect(doc.results.targets).toHaveLength(6);
    expect(doc.results.probe.transport).toBe('pinned');
    expect(doc.results.targets[0].raw[0]).toEqual({ outcome: 'refused', code: 'private_answer', elapsedMs: 1 });
    expect(doc.results.targets[0].raw[0]).not.toHaveProperty('message');
    expect(doc.results.targets[0].raw[0]).not.toHaveProperty('url');
    expect(doc.results.targets[0].target).not.toHaveProperty('host');
    expect(JSON.stringify(doc.results)).not.toContain('rfc1918.probe.example.org');
    expect(JSON.stringify(doc.results)).not.toContain('10.1.2.3');
  });

  test.each([
    [
      'dns',
      (r: ProbeResult) => {
        setOutcome(r, 0, 'dns', 'ENOTFOUND');
      },
      'pinned transport outcome dns is not a policy refusal',
    ],
    [
      'timeout',
      (r: ProbeResult) => {
        setOutcome(r, 1, 'timeout', 'deadline');
      },
      'pinned transport outcome timeout is not a policy refusal',
    ],
    [
      'unpinned_fetch',
      (r: ProbeResult) => {
        setOutcome(r, 2, 'unpinned_fetch', 'unpinned_fetch');
      },
      'pinned transport outcome unpinned_fetch is not a policy refusal',
    ],
    [
      'fetched',
      (r: ProbeResult) => {
        setOutcome(r, 3, 'fetched', 'status_200');
      },
      'pinned transport outcome fetched is not a policy refusal',
    ],
    [
      'refused for the wrong reason',
      (r: ProbeResult) => {
        (r.targets[0] as ProbeOutcome).safeFetch = { outcome: 'refused', code: 'not_https' };
      },
      'unexpected policy code',
    ],
    [
      'mixed address classes',
      (r: ProbeResult) => {
        (r.targets[0] as ProbeOutcome).resolved = {
          addresses: ['10.0.0.1', '93.184.216.34'],
          classes: ['rfc1918', 'public'],
        };
      },
      'address classes do not match the required label class',
    ],
    [
      'no resolved addresses',
      (r: ProbeResult) => {
        (r.targets[2] as ProbeOutcome).resolved = { addresses: [], classes: [] };
      },
      'no resolved addresses',
    ],
    [
      'missing target',
      (r: ProbeResult) => {
        r.targets.pop();
      },
      'expected target 6 is missing',
    ],
    [
      'foreign target',
      (r: ProbeResult) => {
        r.targets.push({
          ...(r.targets[0] as ProbeOutcome),
          target: { label: 'rfc1918', host: 'other.example.org', kind: 'controlledName' },
        });
      },
      'target identity is not configured',
    ],
    [
      'empty raw',
      (r: ProbeResult) => {
        (r.targets[0] as ProbeOutcome).raw = [];
      },
      'exactly one valid attempt',
    ],
    [
      'null attempt',
      (r: ProbeResult) => {
        (r.targets[0] as { raw: unknown[] }).raw = [null];
      },
      'exactly one valid attempt',
    ],
    [
      'resolved class mismatch',
      (r: ProbeResult) => {
        (r.targets[0] as ProbeOutcome).resolved.classes = ['public'];
      },
      'address classes do not match',
    ],
    [
      'wrong origin',
      (r: ProbeResult) => {
        r.origin = 'https://elsewhere.example.org';
      },
      'probe origin',
    ],
    [
      'wrong hosts',
      (r: ProbeResult) => {
        r.hosts = { ...r.hosts, metadata: 'x.example.org' };
      },
      'probe controlled-host list does not match configuration',
    ],
    [
      'unpinned transport',
      (r: ProbeResult) => {
        (r as { transport: string }).transport = 'fetch';
      },
      'probe transport',
    ],
    [
      'wrong kind',
      (r: ProbeResult) => {
        (r as { kind: string }).kind = 'other';
      },
      'probe result kind',
    ],
  ])('fails on %s', async (_name, mutate, message) => {
    const run = await runGateWith(recordedResult(mutate));
    expect(run.code).toBe(NODE_EXIT_CODES.failed);
    const doc = JSON.parse(run.stdout);
    expect(doc.result).toBe('failed');
    expect(doc.failures.join('\n')).toContain(message);
  });

  test('rejects missing hostname and altered pinned transport caps', async () => {
    const missingHostname: unknown = { ...recordedResult() };
    delete (missingHostname as Record<string, unknown>).hostname;
    expect(checkProbeResult(missingHostname, parseHosts(HOSTS), ORIGIN)).toContain('probe hostname is malformed');
    const alteredCaps = recordedResult();
    (alteredCaps.caps as { deadlineMs: number }).deadlineMs += 1;
    expect(checkProbeResult(alteredCaps, parseHosts(HOSTS), ORIGIN)).toContain(
      'probe transport caps do not match the production pinned defaults',
    );
  });

  test('copies only allowlisted observations into evidence', async () => {
    const result = recordedResult() as ProbeResult & { attackerField?: string };
    result.attackerField = 'synthetic-secret';
    (result.targets[0] as ProbeOutcome & { secret?: string }).secret = 'synthetic-secret';
    const run = await runGateWith(result);
    expect(run.code).toBe(NODE_EXIT_CODES.blocked);
    expect(run.stdout).not.toContain('synthetic-secret');
    const doc = JSON.parse(run.stdout);
    expect(doc.results.targets[0]).not.toHaveProperty('secret');
    expect(doc.results.targets[0].raw[0]).not.toHaveProperty('message');
    expect(doc.results).not.toHaveProperty('attackerField');

    const malformedDiagnostic = recordedResult();
    malformedDiagnostic.targets[0]!.raw[0]!.message = 'diagnostic synthetic-secret';
    const rejected = await runGateWith(malformedDiagnostic);
    expect(rejected.code).toBe(NODE_EXIT_CODES.failed);
    expect(rejected.stdout).not.toContain('synthetic-secret');
    expect(rejected.stderr).not.toContain('synthetic-secret');
    expect(rejected.evidence).not.toContain('synthetic-secret');
  });

  test('malformed address strings fail without being copied into evidence', async () => {
    const result = recordedResult();
    (result.targets[0] as ProbeOutcome).resolved.addresses = ['synthetic-private-secret'];
    const run = await runGateWith(result);
    expect(run.code).toBe(NODE_EXIT_CODES.failed);
    expect(run.stdout).not.toContain('synthetic-private-secret');
    expect(run.stderr).not.toContain('synthetic-private-secret');
    expect(JSON.parse(run.stdout).results.targets).toEqual([]);
  });

  test.each([
    ['object hostname', 'hostname', { secret: 'synthetic-host-secret' }, 'synthetic-host-secret'],
    ['string hostname', 'hostname', 'bad hostname synthetic-private-host-secret', 'synthetic-private-host-secret'],
    ['object timestamp', 'recordedAt', { secret: 'synthetic-time-secret' }, 'synthetic-time-secret'],
    ['string timestamp', 'recordedAt', 'synthetic-time-secret', 'synthetic-time-secret'],
  ])('invalid %s is absent from stdout and evidence', async (_label, field, value, secret) => {
    const result = recordedResult() as unknown as Record<string, unknown>;
    result[field as string] = value;
    const run = await runGateWith(result);
    expect(run.code).toBe(NODE_EXIT_CODES.failed);
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
    expect(run.evidence).not.toContain(secret);
    const document = JSON.parse(run.evidence);
    expect(document.results.probe).not.toHaveProperty(field as string);
  });

  test('fails (not blocks) on an unreadable result file', async () => {
    const run = await runGateWith('not an object');
    expect(run.code).toBe(NODE_EXIT_CODES.failed);
    expect(JSON.parse(run.stdout).failures.join('\n')).toContain('not a JSON object');
    const path = join(scratch, 'garbage.json');
    writeFileSync(path, '{');
    const io = capturedIO();
    expect(await runNodeGate(spec, completeEnv({ [SSRF_ENV.probeResult]: path }), io.io)).toBe(NODE_EXIT_CODES.failed);
    expect(JSON.parse(io.output().stdout).failures.join('\n')).toContain('unreadable');
  });

  test('checkProbeResult rejects a non-object', () => {
    expect(checkProbeResult(null, parseHosts(HOSTS), ORIGIN)).toEqual(['probe result is not a JSON object']);
  });

  test('the emitted runner exit code requires complete validation of every target and address class', () => {
    const valid = recordedResult();
    expect(probeResultExitCode(valid, parseHosts(HOSTS), ORIGIN)).toBe(0);

    const wrongClass = recordedResult((result) => {
      const target = result.targets[0] as ProbeOutcome;
      target.resolved = { addresses: ['127.0.0.1'], classes: ['loopback'] };
    });
    expect(probeResultExitCode(wrongClass, parseHosts(HOSTS), ORIGIN)).toBe(1);

    const mixed = recordedResult((result) => {
      const target = result.targets[0] as ProbeOutcome;
      target.resolved = {
        addresses: ['10.1.2.3', '93.184.216.34'],
        classes: ['rfc1918', 'public'],
      };
    });
    expect(probeResultExitCode(mixed, parseHosts(HOSTS), ORIGIN)).toBe(1);
  });
});

describe('scripts/live/ssrf_probe.ts › parseProbeArgs', () => {
  test('parses the emitted probe command line', () => {
    expect(parseProbeArgs(['--origin', `${ORIGIN}/`, '--hosts', HOSTS, '--out', '/tmp/r.json'])).toEqual({
      origin: ORIGIN,
      hosts: parseHosts(HOSTS),
      out: '/tmp/r.json',
    });
    expect(() =>
      parseProbeArgs(['--origin', 'http://x.example.org', '--hosts', HOSTS, '--out', '/tmp/r.json']),
    ).toThrow('https');
    expect(() => parseProbeArgs(['--origin', ORIGIN, '--hosts', HOSTS, '--out', 'r.json'])).toThrow('absolute');
    expect(() => parseProbeArgs(['--origin', ORIGIN, '--hosts', HOSTS])).toThrow('--out is required');
    expect(() => parseProbeArgs(['--bogus'])).toThrow('unknown argument');
  });
});
