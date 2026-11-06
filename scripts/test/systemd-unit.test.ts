// config/systemd/atmusic.service and atmusic.socket (ADR 0005 §14.1, §3.6,
// §3.8, §3.10; N4-02). The service unit must be byte-identical to the ADR's
// §14.1 block, and its directives must agree with the code they configure
// (the listen default, the exit codes that are never restarted, the
// credential name, the forbidden runtime variables). The socket unit's fd is
// handed to the real HTTP bridge in a child process exactly as systemd hands
// it to the service (fd 3, LISTEN_FDS=1, LISTEN_PID = the child's pid), on an
// ephemeral port of the unit's loopback address; nothing binds 127.2.0.1:8888
// and no real systemctl runs.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LISTEN, FORBIDDEN_RUNTIME_ENV } from '../../worker/src/node/config.ts';
import { EXIT_CONFIG, EXIT_DATABASE_LOCKED } from '../../worker/src/node/run.ts';
import { SECRETS_CREDENTIAL_NAME } from '../../worker/src/node/secrets.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICE = join(REPO, 'config', 'systemd', 'atmusic.service');
const SOCKET = join(REPO, 'config', 'systemd', 'atmusic.socket');
const ADR = join(REPO, 'docs', 'adr', '0005-local-node-host-and-compat-apis.md');

interface Directive {
  section: string;
  key: string;
  value: string;
}

/** systemd unit syntax: [Section], Key=Value, comments (# ;) and blank lines. */
function parseUnit(text: string): Directive[] {
  const out: Directive[] = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([A-Za-z]+)\]$/.exec(line);
    if (header !== null) {
      section = header[1] as string;
      continue;
    }
    const eq = line.indexOf('=');
    expect(eq, `not a directive: ${line}`).toBeGreaterThan(0);
    out.push({ section, key: line.slice(0, eq), value: line.slice(eq + 1) });
  }
  return out;
}

function values(units: Directive[], section: string, key: string): string[] {
  return units.filter((d) => d.section === section && d.key === key).map((d) => d.value);
}

function only(units: Directive[], section: string, key: string): string {
  const found = values(units, section, key);
  expect(found, `${section}.${key}`).toHaveLength(1);
  return found[0] as string;
}

/** The ```ini block of ADR §14.1. */
function adrServiceBlock(): string {
  const adr = readFileSync(ADR, 'utf8');
  const start = adr.indexOf('### 14.1 systemd user units');
  expect(start).toBeGreaterThan(0);
  const open = adr.indexOf('```ini\n', start);
  const close = adr.indexOf('\n```', open + 7);
  expect(open).toBeGreaterThan(start);
  return `${adr.slice(open + '```ini\n'.length, close)}\n`;
}

const service = () => parseUnit(readFileSync(SERVICE, 'utf8'));

const dirs: string[] = [];
const children: ChildProcess[] = [];
const servers: NetServer[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('systemd units', () => {
  it('atmusic.service has Type=notify, NotifyAccess=all, WatchdogSec, TimeoutStartSec=15min, RestartPreventExitStatus=78 75, StateDirectory=atmusic with mode 0700, LoadCredentialEncrypted=secrets and ATMUSIC_LISTEN=127.2.0.1:8888', () => {
    // Exactly the reviewed unit of ADR §14.1.
    expect(readFileSync(SERVICE, 'utf8')).toBe(adrServiceBlock());

    const unit = service();
    expect(unit.map((d) => d.section).filter((s, i, a) => a.indexOf(s) === i)).toEqual(['Unit', 'Service', 'Install']);
    expect(only(unit, 'Service', 'Type')).toBe('notify');
    // systemd-notify children send READY/WATCHDOG/EXTEND_TIMEOUT_USEC (node/systemd.ts).
    expect(only(unit, 'Service', 'NotifyAccess')).toBe('all');
    expect(only(unit, 'Service', 'WatchdogSec')).toBe('60s');
    expect(only(unit, 'Service', 'WatchdogSignal')).toBe('SIGKILL');
    expect(only(unit, 'Service', 'TimeoutStartSec')).toBe('15min');
    // TimeoutStopSec must exceed the production drain window of 25 s (§3.10).
    expect(only(unit, 'Service', 'TimeoutStopSec')).toBe('30s');

    // The never-restarted exit codes are the ones run() uses.
    const prevent = only(unit, 'Service', 'RestartPreventExitStatus').split(/\s+/).map(Number);
    expect(prevent).toEqual([78, 75]);
    expect([EXIT_CONFIG, EXIT_DATABASE_LOCKED]).toEqual(prevent);
    expect(only(unit, 'Service', 'Restart')).toBe('on-failure');

    expect(only(unit, 'Service', 'StateDirectory')).toBe('atmusic');
    expect(only(unit, 'Service', 'StateDirectoryMode')).toBe('0700');
    expect(only(unit, 'Service', 'RuntimeDirectory')).toBe('atmusic');
    expect(only(unit, 'Service', 'RuntimeDirectoryMode')).toBe('0700');
    expect(only(unit, 'Service', 'UMask')).toBe('0077');

    // The credential the server reads from $CREDENTIALS_DIRECTORY/secrets.
    const credential = only(unit, 'Service', 'LoadCredentialEncrypted');
    expect(credential).toBe(`${SECRETS_CREDENTIAL_NAME}:%E/atmusic/secrets.cred`);
    expect(values(unit, 'Service', 'LoadCredential')).toEqual([]);

    const environment = values(unit, 'Service', 'Environment').flatMap((v) => v.split(/\s+/));
    expect(environment).toContain('ATMUSIC_LISTEN=127.2.0.1:8888');
    expect(`ATMUSIC_LISTEN=${DEFAULT_LISTEN}`).toBe('ATMUSIC_LISTEN=127.2.0.1:8888');
    expect(environment).toContain('ATMUSIC_PUBLIC_ORIGIN=https://music.214510.xyz');
    expect(only(unit, 'Service', 'EnvironmentFile')).toBe('-%E/atmusic/atmusic.env');

    expect(only(unit, 'Service', 'ExecStart')).toBe(
      '/usr/bin/node --enable-source-maps %h/.local/lib/atmusic/current/worker/dist/node/main.mjs',
    );
    expect(only(unit, 'Service', 'WorkingDirectory')).toBe('%h/.local/lib/atmusic/current');
    expect(only(unit, 'Install', 'WantedBy')).toBe('default.target');
  });

  it('atmusic.service sets no secret in Environment= and contains no MemoryDenyWriteExecute, PrivateNetwork or IPAddressDeny', () => {
    const unit = service();
    const assignments = values(unit, 'Service', 'Environment').flatMap((v) => v.split(/\s+/));
    expect(assignments.length).toBeGreaterThan(0);
    const names = assignments.map((a) => a.slice(0, a.indexOf('=')));
    // Only non-secret configuration; the secrets come only from the credential.
    expect(names.sort()).toEqual(['ATMUSIC_LISTEN', 'ATMUSIC_PUBLIC_ORIGIN', 'NODE_ENV']);
    for (const name of names) expect(name).not.toMatch(/secret|key|token|password|cursor|cred/i);
    for (const value of assignments.map((a) => a.slice(a.indexOf('=') + 1))) {
      // No long random-looking literal (base64 or hex of a key) anywhere in an assignment.
      expect(value).not.toMatch(/[A-Za-z0-9+/_-]{32,}/);
    }
    expect(names).not.toContain('ATMUSIC_SECRETS_FILE');
    expect(names).not.toContain('CREDENTIALS_DIRECTORY');
    for (const key of ['SetCredential', 'SetCredentialEncrypted', 'PassEnvironment']) {
      expect(values(unit, 'Service', key), key).toEqual([]);
    }

    // Forbidden or unreliable directives (§14.1).
    const keys = new Set(unit.map((d) => d.key));
    for (const forbidden of ['MemoryDenyWriteExecute', 'PrivateNetwork', 'IPAddressDeny', 'IPAddressAllow']) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    // Outbound traffic needs the inet families; the admin socket needs AF_UNIX.
    expect(only(unit, 'Service', 'RestrictAddressFamilies').split(/\s+/)).toEqual(['AF_INET', 'AF_INET6', 'AF_UNIX']);
    expect(only(unit, 'Service', 'NoNewPrivileges')).toBe('yes');
    expect(only(unit, 'Service', 'ProtectSystem')).toBe('strict');
  });

  it('atmusic.service unsets NODE_OPTIONS, NODE_TLS_REJECT_UNAUTHORIZED, NODE_EXTRA_CA_CERTS, NODE_USE_ENV_PROXY, NODE_PATH, HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy, NO_PROXY, no_proxy, ALL_PROXY, all_proxy, SSL_CERT_FILE and SSL_CERT_DIR', () => {
    const unit = service();
    const lines = values(unit, 'Service', 'UnsetEnvironment');
    expect(lines).toEqual([
      'NODE_OPTIONS NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS NODE_USE_ENV_PROXY NODE_PATH',
      'HTTP_PROXY http_proxy HTTPS_PROXY https_proxy NO_PROXY no_proxy ALL_PROXY all_proxy',
      'SSL_CERT_FILE SSL_CERT_DIR',
    ]);
    const unset = lines.flatMap((l) => l.split(/\s+/));
    expect(new Set(unset).size).toBe(unset.length);
    // Exactly the variables run() refuses with exit 78 (config.ts), no more, no fewer.
    expect([...unset].sort()).toEqual([...FORBIDDEN_RUNTIME_ENV].sort());
    expect(unset).toHaveLength(15);
    // UnsetEnvironment= applies after EnvironmentFile=, so atmusic.env cannot set them either.
    const keys = unit.filter((d) => d.section === 'Service').map((d) => d.key);
    expect(keys.indexOf('UnsetEnvironment')).toBeGreaterThan(keys.indexOf('EnvironmentFile'));
  });

  it('atmusic.socket listens on 127.2.0.1:8888 and the bridge accepts its fd as loopback', async () => {
    const socket = parseUnit(readFileSync(SOCKET, 'utf8'));
    const listen = only(socket, 'Socket', 'ListenStream');
    expect(listen).toBe('127.2.0.1:8888');
    expect(listen).toBe(DEFAULT_LISTEN);
    // One listening socket handed to the one service (no per-connection instances).
    expect(only(socket, 'Socket', 'Accept')).toBe('no');
    expect(values(socket, 'Socket', 'Service')).toEqual([]);
    expect(socket.filter((d) => d.section === 'Socket').map((d) => d.key)).toEqual(['ListenStream', 'Accept']);
    expect(only(socket, 'Install', 'WantedBy')).toBe('sockets.target');
    const [host] = listen.split(':') as [string, string];

    const dir = mkdtempSync(join(tmpdir(), 'atmusic-socket-unit-'));
    dirs.push(dir);
    const entry = join(dir, 'entry.mjs');
    await build({
      stdin: {
        contents: `import { createServer, socketActivation } from ${JSON.stringify(join(REPO, 'worker/src/node/http-bridge.ts'))};
// systemd sets LISTEN_PID to the service's own pid.
const env = { ...process.env, LISTEN_PID: String(process.pid) };
const target = socketActivation(env, process.pid);
const server = createServer({
  publicOrigin: 'https://music.example.test',
  listen: target,
  handler: () => new Response('served on the inherited socket'),
});
try {
  const bound = await server.start();
  console.log(JSON.stringify({ ok: true, target, host: bound.host, port: bound.port }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, target, error: error.name, variable: error.variable }));
  process.exit(1);
}
process.on('SIGTERM', () => { void server.close().then(() => process.exit(0)); });
`,
        resolveDir: REPO,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      outfile: entry,
      logLevel: 'silent',
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      external: ['bufferutil', 'utf-8-validate'],
    });

    /** Starts the bundled bridge with `listener` as fd 3; resolves with its first output line and exit. */
    const startChild = async (listener: NetServer) => {
      const fd = (listener as unknown as { _handle: { fd: number } })._handle.fd;
      const child = spawn(process.execPath, [entry], {
        stdio: ['ignore', 'pipe', 'pipe', fd],
        env: { PATH: process.env.PATH ?? '', LISTEN_FDS: '1' },
      });
      children.push(child);
      const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
      let output = '';
      child.stdout?.on('data', (c: Buffer) => {
        output += c.toString();
      });
      child.stderr?.on('data', (c: Buffer) => {
        output += c.toString();
      });
      const deadline = Date.now() + 20_000;
      while (!output.includes('\n') && child.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 20));
      return { child, exited, first: JSON.parse(output.split('\n')[0] as string) as Record<string, unknown> };
    };

    // The unit's loopback address, on an ephemeral port (127.2.0.1:8888 itself is never bound here).
    const inet = createNetServer();
    servers.push(inet);
    await new Promise<void>((r) => inet.listen(0, host, () => r()));
    const port = (inet.address() as { port: number }).port;
    const served = await startChild(inet);
    expect(served.first).toEqual({ ok: true, target: { fd: 3 }, host: '127.2.0.1', port });
    // From now on only the child accepts on the socket.
    await new Promise<void>((r) => inet.close(() => r()));
    servers.splice(servers.indexOf(inet), 1);
    const answer = await new Promise<{ status: number; body: string }>((ok, fail) => {
      const req = http.request({ host, port, path: '/', headers: { host: `${host}:${port}` }, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
        });
        res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', fail);
      req.end();
    });
    expect(answer).toEqual({ status: 200, body: 'served on the inherited socket' });
    served.child.kill('SIGTERM');
    expect(await served.exited).toBe(0);

    // Control: the same bridge refuses an inherited socket that is not loopback TCP.
    const unix = createNetServer();
    servers.push(unix);
    await new Promise<void>((r) => unix.listen(join(dir, 'not-inet.sock'), () => r()));
    const refused = await startChild(unix);
    expect(refused.first).toEqual({ ok: false, target: { fd: 3 }, error: 'ListenConfigError', variable: 'LISTEN_FDS' });
    expect(await refused.exited).toBe(1);
  }, 60_000);
});
