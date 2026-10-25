// scripts/build-server.ts (N3-07) and the bundled worker/dist/node/main.mjs as
// a real process (ADR 0005 §3.9, §3.10, §15.1). The bundle is built once, by
// build-server's CLI function in-process (as `npx tsx scripts/build-server.ts`
// would), into worker/dist/node of a disposable checkout: a committed copy of
// the sources the bundle needs whose node_modules links to the repository's,
// so the real worker/dist is never written while other suites fingerprint it.
// Each test then spawns `node main.mjs` with explicit timeouts. The processes
// bind only ephemeral loopback ports and temporary directories; systemd-notify
// is a stand-in script on PATH that appends its arguments to a file.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createECDH, createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2E_BUNDLE, gitSha, MAIN_BUNDLE, MAIN_METAFILE, main, NO_COMMIT_SHA, removeE2e } from '../build-server.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
/** The disposable checkout, its HEAD, its worker/dist/node and the bundle in it (set in beforeAll). */
let CHECKOUT = '';
let SHA = '';
let DEFAULT_OUT_DIR = '';
let MAIN = '';

/** Copies the sources main.mjs is built from, links node_modules, and commits the copy. */
function disposableCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), 'atmusic-build-checkout-'));
  for (const path of [
    'package.json',
    'worker/package.json',
    'worker/src',
    'packages/core/package.json',
    'packages/core/src',
    'packages/atproto/package.json',
    'packages/atproto/src',
  ]) {
    cpSync(join(REPO, path), join(root, path), { recursive: true });
  }
  writeFileSync(join(root, '.gitignore'), '/node_modules/\n/worker/dist/\n');
  mkdirSync(join(root, 'node_modules', '@atmusic'), { recursive: true });
  for (const entry of readdirSync(join(REPO, 'node_modules'))) {
    if (entry === '@atmusic' || entry.startsWith('.')) continue;
    symlinkSync(join(REPO, 'node_modules', entry), join(root, 'node_modules', entry));
  }
  symlinkSync(join('..', '..', 'packages', 'core'), join(root, 'node_modules', '@atmusic', 'core'));
  symlinkSync(join('..', '..', 'packages', 'atproto'), join(root, 'node_modules', '@atmusic', 'atproto'));
  symlinkSync(join('..', '..', 'worker'), join(root, 'node_modules', '@atmusic', 'worker'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=atmusic test',
        '-c',
        'user.email=test@example.test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    );
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'disposable checkout for build-server.test.ts');
  return root;
}
const ORIGIN = 'https://music.example.test';
const dirs: string[] = [];

/** A secrets document of deterministic test keys (the shape of ADR 0005 §3.8). */
function testSecretsDocument(): Record<string, unknown> {
  const d = createHash('sha256').update('atmusic build-server test signing key').digest();
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  return {
    cursorKey: Buffer.alloc(32, 0x5a).toString('base64'),
    encryptionKeys: [{ id: 'e1', key: Buffer.alloc(32, 0x3c).toString('base64') }],
    oauthSigningKeys: [
      {
        kty: 'EC',
        crv: 'P-256',
        kid: 'k1',
        d: d.toString('base64url'),
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
      },
    ],
  };
}
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const buildLog: string[] = [];
beforeAll(async () => {
  CHECKOUT = disposableCheckout();
  SHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CHECKOUT, encoding: 'utf8' }).trim();
  DEFAULT_OUT_DIR = join(CHECKOUT, 'worker', 'dist', 'node');
  MAIN = join(DEFAULT_OUT_DIR, MAIN_BUNDLE);
  const status = await main([], { out: (l) => buildLog.push(l), err: (l) => buildLog.push(l), root: CHECKOUT });
  expect(status, buildLog.join('\n')).toBe(0);
}, 120_000);

afterAll(() => {
  if (CHECKOUT !== '') rmSync(CHECKOUT, { recursive: true, force: true });
});

interface Fixture {
  dir: string;
  dbPath: string;
  notifyLog: string;
  env: Record<string, string>;
}

/** A temporary state, runtime and release layout, a 0600 secrets file and a stand-in systemd-notify. */
async function fixture(overrides: Record<string, string> = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-main-'));
  dirs.push(dir);
  const dist = join(dir, 'web', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>atmusic</title>');
  const secrets = join(dir, 'secrets.json');
  writeFileSync(secrets, JSON.stringify(testSecretsDocument()));
  chmodSync(secrets, 0o600);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemd-notify'), '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$NOTIFY_SOCKET.log"\n');
  chmodSync(join(bin, 'systemd-notify'), 0o755);
  const port = await freePort();
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    ATMUSIC_PUBLIC_ORIGIN: ORIGIN,
    ATMUSIC_LISTEN: `127.0.0.1:${port}`,
    ATMUSIC_CLIENT_IP_HEADER: 'none',
    ATMUSIC_SIGNIN_DIDS: 'did:plc:abcdefghijklmnopqrstuvwx',
    ATMUSIC_ASSETS_DIR: dist,
    ATMUSIC_SECRETS_FILE: secrets,
    STATE_DIRECTORY: join(dir, 'state'),
    XDG_RUNTIME_DIR: join(dir, 'run'),
    INGEST_MODE: 'off',
    JETSTREAM_URLS: 'wss://jetstream.example.test',
    JETSTREAM_LOOKBACK_HOURS: '24',
    RELAY_URL: 'https://relay.example.test',
    NOTIFY_SOCKET: join(dir, 'notify'),
    ...overrides,
  };
  return { dir, dbPath: join(dir, 'state', 'atmusic.db'), notifyLog: join(dir, 'notify.log'), env };
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

interface Proc {
  child: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; atMs: number }>;
}

function startMain(env: Record<string, string>, args: string[] = [], cwd = REPO): Proc {
  const child = spawn(process.execPath, [MAIN, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (c: Buffer) => {
    output += c.toString();
  });
  child.stderr?.on('data', (c: Buffer) => {
    output += c.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; atMs: number }>((r) =>
    child.on('exit', (code, signal) => r({ code, signal, atMs: Date.now() })),
  );
  return { child, output: () => output, exited };
}

async function runMain(env: Record<string, string>, args: string[] = [], cwd = REPO) {
  const p = startMain(env, args, cwd);
  const { code } = await p.exited;
  return { code, output: p.output() };
}

function notes(f: Fixture): string[] {
  return existsSync(f.notifyLog)
    ? readFileSync(f.notifyLog, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
    : [];
}

async function waitFor(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function get(
  target: { port: number } | { socketPath: string },
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const where =
      'port' in target
        ? { host: '127.0.0.1', port: target.port, headers: { host: 'music.example.test' } }
        : { socketPath: target.socketPath };
    const req = http.request({ ...where, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
      });
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const portOf = (f: Fixture) => Number(f.env.ATMUSIC_LISTEN?.split(':')[1]);

describe('build-server and main.mjs', () => {
  it('build-server writes worker/dist/node/main.mjs, `node main.mjs --check-config` with a test config exits 0, and `node main.mjs --version` prints the git sha recorded at build time', async () => {
    expect(buildLog[0]).toMatch(
      new RegExp(`^built ${MAIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(git ${SHA}, sha256 [0-9a-f]{64}\\)$`),
    );
    expect(statSync(MAIN).size).toBeGreaterThan(100_000);
    const meta = JSON.parse(readFileSync(join(DEFAULT_OUT_DIR, MAIN_METAFILE), 'utf8')) as {
      inputs: Record<string, unknown>;
    };
    expect(Object.keys(meta.inputs)).toContain('worker/src/node/main.ts');
    expect(Object.keys(meta.inputs)).toContain('worker/src/node/run.ts');
    expect(existsSync(`${MAIN}.map`)).toBe(true);
    // The sha is embedded in the bundle, not read from git at run time.
    expect(readFileSync(MAIN, 'utf8')).toContain(JSON.stringify(SHA));

    const f = await fixture();
    const version = await runMain({ PATH: f.env.PATH ?? '' }, ['--version'], f.dir);
    expect(version).toEqual({ code: 0, output: `${SHA}\n` });

    const check = await runMain(f.env, ['--check-config']);
    expect(check.code, check.output).toBe(0);
    expect(check.output).toContain('atmusic: configuration ok');
    // Validation only: no database, socket or notification.
    expect(existsSync(f.dbPath)).toBe(false);
    expect(existsSync(join(f.dir, 'run'))).toBe(false);
    expect(notes(f)).toEqual([]);
    // And it does validate: a broken setting is 78.
    const broken = await runMain({ ...f.env, ATMUSIC_CLIENT_IP_HEADER: 'forwarded' }, ['--check-config']);
    expect(broken.code).toBe(78);
    expect(broken.output).toContain('ATMUSIC_CLIENT_IP_HEADER: must be one of');

    // The sha is HEAD's; a repository without any commit records zeros (never
    // a release), and a directory outside git is an error.
    expect(gitSha(REPO)).toBe(REPO_SHA);
    expect(gitSha(CHECKOUT)).toBe(SHA);
    const empty = mkdtempSync(join(tmpdir(), 'atmusic-nogit-'));
    dirs.push(empty);
    expect(() => gitSha(empty)).toThrow(/git rev-parse HEAD failed/);
    execFileSync('git', ['init', '-q'], { cwd: empty });
    expect(gitSha(empty)).toBe(NO_COMMIT_SHA);
  }, 60_000);

  it('main.mjs started with ATMUSIC_PUBLIC_ORIGIN=http://127.0.0.1:1, or with LASTFM_API_ROOT=https://127.0.0.1/, exits 78 even with every test variable set', async () => {
    // Every variable a test setup might use to ask for fixture behaviour:
    // none of them relaxes anything in main.mjs.
    const testVariables = {
      NODE_ENV: 'test',
      VITEST: 'true',
      CI: '1',
      ATMUSIC_TEST: '1',
      ATMUSIC_FIXTURE_ORIGINS: '1',
      FIXTURE_ORIGINS: 'true',
      ATMUSIC_ALLOW_FIXTURE_PREFIX: '1',
      ACCEPTANCE_ALLOW_FIXTURE_PREFIX: '1',
      ATMUSIC_E2E: '1',
    };
    for (const [name, value] of [
      ['ATMUSIC_PUBLIC_ORIGIN', 'http://127.0.0.1:1'],
      ['LASTFM_API_ROOT', 'https://127.0.0.1/'],
    ] as const) {
      const f = await fixture({ ...testVariables, [name]: value });
      const result = await runMain(f.env, ['--init']);
      expect([name, result.code]).toEqual([name, 78]);
      expect(result.output).toContain(`configuration error: ${name}:`);
      expect(existsSync(f.dbPath)).toBe(false);
      expect(await get({ port: portOf(f) }, '/health/ready').catch((e: NodeJS.ErrnoException) => e.code)).toBe(
        'ECONNREFUSED',
      );
    }
  }, 60_000);

  it('the bundled main.mjs started with --init on a temporary state directory answers /health/ready, then on SIGTERM sends STOPPING=1 and exits 0 within 30 s', async () => {
    const f = await fixture();
    const p = startMain(f.env, ['--init']);
    await waitFor(() => notes(f).includes('READY=1') || p.child.exitCode !== null, 30_000, 'READY=1');
    expect(notes(f), p.output()).toContain('READY=1');
    const ready = await get({ port: portOf(f) }, '/health/ready');
    expect([ready.status, JSON.parse(ready.body)]).toEqual([200, { status: 'ready' }]);
    expect(statSync(f.dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.dir, 'run', 'atmusic', 'admin.sock')).isSocket()).toBe(true);

    const sentAt = Date.now();
    p.child.kill('SIGTERM');
    const exit = await p.exited;
    expect(exit).toMatchObject({ code: 0, signal: null });
    expect(exit.atMs - sentAt).toBeLessThan(30_000);
    expect(notes(f)).toEqual(['EXTEND_TIMEOUT_USEC=60000000', 'READY=1', 'STOPPING=1']);
    expect(p.output()).toContain('"event":"shutdown.completed"');
    // The admin socket is removed on the way out.
    expect(existsSync(join(f.dir, 'run', 'atmusic', 'admin.sock'))).toBe(false);
  }, 60_000);

  it('--e2e builds worker/dist/node/e2e.mjs from a given entry and exits 2 when the entry is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atmusic-e2e-entry-'));
    dirs.push(dir);
    const entry = join(dir, 'node-entry.ts');
    writeFileSync(
      entry,
      `import { run } from ${JSON.stringify(join(CHECKOUT, 'worker', 'src', 'node', 'run.ts'))};\nexport const start = run;\n`,
    );
    const out: string[] = [];
    try {
      expect(
        await main(['--e2e', '--entry', entry], { out: (l) => out.push(l), err: (l) => out.push(l), root: CHECKOUT }),
      ).toBe(0);
      const e2e = join(DEFAULT_OUT_DIR, E2E_BUNDLE);
      expect(out[0]).toContain(`built ${e2e} (git ${SHA}`);
      const meta = JSON.parse(readFileSync(join(DEFAULT_OUT_DIR, 'e2e.meta.json'), 'utf8')) as {
        inputs: Record<string, unknown>;
      };
      expect(Object.keys(meta.inputs)).toContain('worker/src/node/run.ts');
      expect(Object.keys(meta.inputs)).not.toContain('worker/src/node/main.ts');
      expect(existsSync(join(DEFAULT_OUT_DIR, 'e2e.inputs.json'))).toBe(true);
      // The e2e bundle loads without starting anything (run.ts has no top-level effect).
      const probe = spawn(
        process.execPath,
        ['--input-type=module', '-e', `const m = await import(${JSON.stringify(e2e)}); console.log(typeof m.start);`],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let probeOut = '';
      probe.stdout?.on('data', (c: Buffer) => {
        probeOut += c.toString();
      });
      expect(await new Promise((r) => probe.on('exit', (code) => r(code)))).toBe(0);
      expect(probeOut).toBe('function\n');

      // A missing entry: exit 2, nothing written.
      removeE2e(DEFAULT_OUT_DIR);
      const err: string[] = [];
      expect(
        await main(['--e2e', '--entry', join(dir, 'missing.ts')], {
          out: (l) => err.push(l),
          err: (l) => err.push(l),
          root: CHECKOUT,
        }),
      ).toBe(2);
      expect(err.join('\n')).toContain('does not exist');
      expect(existsSync(join(DEFAULT_OUT_DIR, E2E_BUNDLE))).toBe(false);
      // Usage errors are 2 as well.
      expect(await main(['--entry', entry], { out: () => {}, err: () => {}, root: CHECKOUT })).toBe(2);
      expect(await main(['--bogus'], { out: () => {}, err: () => {}, root: CHECKOUT })).toBe(2);
    } finally {
      removeE2e(DEFAULT_OUT_DIR);
    }
  }, 60_000);

  it('a second main.mjs on the same database exits 75 database_locked after the production busy timeout even with a different ATMUSIC_ADMIN_SOCKET, and a stale socket file is replaced', async () => {
    const f = await fixture();
    const first = startMain(f.env, ['--init']);
    await waitFor(() => notes(f).includes('READY=1') || first.child.exitCode !== null, 30_000, 'READY=1');
    expect(notes(f), first.output()).toContain('READY=1');
    const socketA = join(f.dir, 'run', 'atmusic', 'admin.sock');

    // The second instance: same database, its own socket and port.
    const otherSocket = join(f.dir, 'run2', 'admin.sock');
    const startedAt = Date.now();
    const second = await runMain({
      ...f.env,
      ATMUSIC_ADMIN_SOCKET: otherSocket,
      ATMUSIC_LISTEN: `127.0.0.1:${await freePort()}`,
      NOTIFY_SOCKET: join(f.dir, 'notify2'),
    });
    const elapsed = Date.now() - startedAt;
    expect(second.code, second.output).toBe(75);
    expect(second.output).toContain('database_locked');
    // The production busy timeout (5 s) was waited out, not a test value.
    expect(elapsed).toBeGreaterThanOrEqual(4_900);
    expect(elapsed).toBeLessThan(30_000);
    // It bound nothing and touched nothing of the first instance.
    expect(existsSync(otherSocket)).toBe(false);
    expect(statSync(socketA).isSocket()).toBe(true);
    expect((await get({ port: portOf(f) }, '/health/ready')).status).toBe(200);

    // The first dies without cleaning up: its socket file stays behind.
    first.child.kill('SIGKILL');
    expect((await first.exited).signal).toBe('SIGKILL');
    expect(statSync(socketA).isSocket()).toBe(true);
    await expect(get({ socketPath: socketA }, '/admin/status')).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    // A new instance replaces the stale socket and serves on it.
    const third = startMain({ ...f.env, NOTIFY_SOCKET: join(f.dir, 'notify3') });
    await waitFor(
      () => third.output().includes('"event":"run.ready"') || third.child.exitCode !== null,
      30_000,
      'ready',
    );
    expect(third.output()).toContain('"event":"admin.stale_socket_removed"');
    const status = await get({ socketPath: socketA }, '/admin/status');
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ schema: { status: 'ready' } });
    expect(statSync(socketA).mode & 0o777).toBe(0o600);
    third.child.kill('SIGTERM');
    expect((await third.exited).code).toBe(0);
  }, 60_000);

  it('main.mjs started with NODE_OPTIONS=--require=./x.js or NODE_TLS_REJECT_UNAUTHORIZED=0 exits 78 naming the variable and loads no preload', async () => {
    const f = await fixture();
    // The would-be preload counts every evaluation in a file.
    const cwd = join(f.dir, 'cwd');
    mkdirSync(cwd);
    const marker = join(f.dir, 'preload-count');
    writeFileSync(
      join(cwd, 'x.js'),
      `const fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\n`,
    );
    const options = await runMain({ ...f.env, NODE_OPTIONS: '--require=./x.js' }, ['--init'], cwd);
    expect(options.code).toBe(78);
    expect(options.output).toContain('configuration error: NODE_OPTIONS: must not be set');
    expect(options.output).not.toContain('--require=./x.js');
    // Node itself evaluates a NODE_OPTIONS preload once, before any module of
    // main.mjs runs (only the unit's UnsetEnvironment= can stop that, ADR
    // §14.1). main.mjs loads nothing more: no worker thread or child process
    // evaluates it again, because the refusal comes before any of them exists.
    expect(readFileSync(marker, 'utf8')).toBe('x');
    expect(existsSync(f.dbPath)).toBe(false);
    expect(existsSync(join(f.dir, 'run'))).toBe(false);
    expect(notes(f)).toEqual([]);

    const tls = await runMain({ ...f.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, ['--init'], cwd);
    expect(tls.code).toBe(78);
    expect(tls.output).toContain('configuration error: NODE_TLS_REJECT_UNAUTHORIZED: must not be set');
    expect(readFileSync(marker, 'utf8')).toBe('x');
    expect(existsSync(f.dbPath)).toBe(false);
    expect(readdirSync(f.dir).sort()).toEqual(['bin', 'cwd', 'preload-count', 'secrets.json', 'web']);
  }, 60_000);
});
