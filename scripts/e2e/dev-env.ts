// The browser end-to-end network (W6-03; ADR 0004 §10.1 "Browser"). TEST-ONLY
// Node infrastructure: nothing here is imported by worker/src or web/src.
//
// What it starts, all on 127.0.0.1:
// - a PLC directory (@atproto/dev-env TestPlc);
// - two PDSs (TestPds): alice on pds1; bob (with one seeded scrobble) and
//   carol on pds2. alice and bob, on separate PDSs, are the MVP journey's two
//   accounts (web/tests/mvp.spec.ts); carol is the accessibility suite's
//   keyboard-only user (web/tests/accessibility.spec.ts), so neither suite
//   writes into the other's account. Each
//   PDS's public URL is `https://<host>` with a reserved `.test` host
//   (pds1.test, pds2.test), so the DID documents name https endpoints on the
//   default port, exactly what the production identity policy accepts; the
//   PDSs themselves listen on plain http loopback ports;
// - a TLS-terminating forward proxy for the browser. Playwright's Chromium is
//   configured with it (playwright.config.ts): a CONNECT to one of the
//   dev-env hosts (pds1.test, pds2.test and plc.directory, which the browser
//   OAuth library resolves did:plc DIDs against) is answered with a
//   self-signed certificate (the browser context ignores certificate errors)
//   and forwarded to that host's loopback port. Every other destination is
//   refused and recorded, so the browser can never reach the real network.
//
// Why a proxy and not `allowHttp`: the SPA's OAuth client never sets the
// library's `allowHttp` (web/src/oauth/client.ts), so the authorization server
// and the PDS must be https. The proxy gives the real library, unmodified, a
// real https PDS and a real OAuth provider (PAR, PKCE, DPoP with nonces).
//
// The Worker (wrangler dev, worker/test/e2e/entry.ts) reaches the same hosts
// through its own e2e Transport, which maps exactly these hosts to the same
// loopback ports; `workerNetwork()` is the description it receives.
//
// The e2e lexicon prefix is E2E_PREFIX (`test.atmusic.e2e`, NSID authority
// `e2e.atmusic.test` under the RFC 6761 reserved `.test` TLD, so it can never
// be owned or published). The fixture prefix com.example.atmusic cannot be
// used here: by the namespace invariant it never enables publication, and
// the SPA's write path (scrobble, follow, disconnect) is offered only with
// publication (A20).

import { createHash, createPrivateKey, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { buildScrobbleRecord } from '@atmusic/core/scrobble';
import type { TestPds } from '@atproto/dev-env';
import type { Locator, Page } from '@playwright/test';

/** The e2e lexicon prefix (see the header comment). Never the fixture or the production prefix. */
export const E2E_PREFIX = 'test.atmusic.e2e';
/** The PLC host the browser OAuth library (and the Worker) resolve did:plc against. */
export const PLC_HOST = 'plc.directory';

export interface E2ePorts {
  worker: number;
  plc: number;
  pds1: number;
  pds2: number;
  proxy: number;
}

/** Fixed loopback ports (playwright.config.ts needs the proxy port before anything starts). */
export const DEFAULT_PORTS: Readonly<E2ePorts> = { worker: 8787, plc: 2582, pds1: 2583, pds2: 2584, proxy: 2580 };

/** The SPA/Worker origin for `ports` (an atproto loopback client must use 127.0.0.1). */
export function workerOrigin(ports: Pick<E2ePorts, 'worker'>): string {
  return `http://127.0.0.1:${ports.worker}`;
}

export function portsFromEnv(env: NodeJS.ProcessEnv = process.env): E2ePorts {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > 65535) throw new RangeError(`${name} must be a TCP port`);
    return n;
  };
  return {
    worker: read('E2E_WORKER_PORT', DEFAULT_PORTS.worker),
    plc: read('E2E_PLC_PORT', DEFAULT_PORTS.plc),
    pds1: read('E2E_PDS1_PORT', DEFAULT_PORTS.pds1),
    pds2: read('E2E_PDS2_PORT', DEFAULT_PORTS.pds2),
    proxy: read('E2E_PROXY_PORT', DEFAULT_PORTS.proxy),
  };
}

export type AccountName = 'alice' | 'bob' | 'carol';

export interface E2eAccount {
  name: AccountName;
  handle: string;
  did: string;
  password: string;
  /** The PDS public host (`pds1.test`). */
  pdsHost: string;
  /** The PDS loopback port (direct http access for test assertions). */
  pdsPort: number;
}

/** What the tests and the Worker learn about the running network (work/e2e/network.json). */
export interface E2eNetwork {
  prefix: string;
  workerOrigin: string;
  proxyPort: number;
  plcPort: number;
  /** Public host → loopback port, for every host the proxy and the Worker transport serve. */
  hosts: Record<string, number>;
  accounts: E2eAccount[];
  /** URIs of records created by the setup (bob's seed scrobble). */
  seeded: { bobScrobble: string };
}

/** The Worker's view: hosts and verified handles only (passed as the E2E_NETWORK var). */
export interface WorkerNetwork {
  hosts: Record<string, number>;
  handles: Record<string, string>;
}

export function workerNetwork(net: E2eNetwork): WorkerNetwork {
  return { hosts: net.hosts, handles: Object.fromEntries(net.accounts.map((a) => [a.handle, a.did])) };
}

/** base64url(JSON) so the value survives `wrangler dev --var NAME:VALUE`. */
export function encodeWorkerNetwork(net: WorkerNetwork): string {
  return Buffer.from(JSON.stringify(net), 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------
// A self-signed certificate (P-256, ecdsa-with-SHA256), DER-encoded by hand so
// the e2e stack needs neither openssl nor an extra dependency.

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...c: Buffer[]) => der(0x30, ...c);

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [40 * (parts[0] as number) + (parts[1] as number)];
  for (const part of parts.slice(2)) {
    const stack: number[] = [];
    let v = part;
    do {
      stack.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < stack.length - 1; i++) stack[i] = (stack[i] as number) | 0x80;
    out.push(...stack);
  }
  return der(0x06, Buffer.from(out));
}

function utcTime(ms: number): Buffer {
  const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return der(0x17, Buffer.from(text, 'ascii'));
}

export interface SelfSignedCert {
  keyPem: string;
  certPem: string;
}

/** A self-signed server certificate for `dnsNames`, valid from one day ago for 30 days. */
export function selfSignedCert(dnsNames: readonly string[], nowMs: number = Date.now()): SelfSignedCert {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('atmusic e2e dev-env', 'utf8')))));
  const serial = createHash('sha256').update(spki).digest().subarray(0, 8);
  serial[0] = (serial[0] as number) & 0x7f; // positive INTEGER
  const san = seq(...dnsNames.map((n) => der(0x82, Buffer.from(n, 'ascii'))));
  const extensions = der(
    0xa3,
    seq(
      seq(oid('2.5.29.17'), der(0x04, san)), // subjectAltName
      seq(oid('2.5.29.19'), der(0x04, seq())), // basicConstraints: not a CA
    ),
  );
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, serial),
    ecdsaSha256,
    name,
    seq(utcTime(nowMs - 86_400_000), utcTime(nowMs + 30 * 86_400_000)),
    name,
    spki,
    extensions,
  );
  const signature = sign('sha256', tbs, privateKey); // DER ECDSA-Sig-Value
  const cert = seq(tbs, ecdsaSha256, der(0x03, Buffer.from([0]), signature));
  const certPem = `-----BEGIN CERTIFICATE-----\n${cert
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  // Fail here, not in the TLS handshake, if the encoding is wrong.
  const parsed = new X509Certificate(certPem);
  if (!parsed.verify(publicKey) || !parsed.checkPrivateKey(createPrivateKey(keyPem))) {
    throw new Error('self-signed certificate does not verify');
  }
  return { keyPem, certPem };
}

// ---------------------------------------------------------------------------
// The browser's forward proxy.

export interface BrowserProxy {
  port: number;
  /** `host:port` of every refused CONNECT or plain proxy request, in order. */
  refused: string[];
  /** Requests forwarded per public host. */
  forwarded: Map<string, number>;
  close(): Promise<void>;
}

function forward(req: IncomingMessage, res: ServerResponse, port: number): void {
  const upstream = httpRequest(
    { host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('e2e proxy: upstream failed');
  });
  req.pipe(upstream);
}

/**
 * Starts the proxy on 127.0.0.1:`port`. `hosts` maps a public https host to
 * its loopback http port; nothing else is reachable through it.
 */
export async function startBrowserProxy(
  port: number,
  hosts: Readonly<Record<string, number>>,
  workerPort: number,
): Promise<BrowserProxy> {
  const cert = selfSignedCert(Object.keys(hosts));
  const secureContext = createSecureContext({ key: cert.keyPem, cert: cert.certPem });
  const refused: string[] = [];
  const forwarded = new Map<string, number>();
  const sockets = new Set<Socket>();

  // Decrypted requests arriving through a CONNECT tunnel.
  const inner = createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:443$/, '').toLowerCase();
    const target = Object.hasOwn(hosts, host) ? hosts[host] : undefined;
    if (target === undefined) {
      refused.push(`${host}:443`);
      res.writeHead(421, { 'content-type': 'text/plain' }).end('e2e proxy: host not served');
      return;
    }
    forwarded.set(host, (forwarded.get(host) ?? 0) + 1);
    forward(req, res, target);
  });

  const proxy: Server = createServer((req, res) => {
    // A plain-http proxy request (absolute URL). Only the dev-env loopback
    // ports are reachable this way (Chromium normally bypasses the proxy for
    // loopback anyway).
    let url: URL | null = null;
    try {
      url = new URL(req.url ?? '');
    } catch {
      url = null;
    }
    const loopbackPorts = new Set([...Object.values(hosts), workerPort].map(String));
    if (url === null || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !loopbackPorts.has(url.port)) {
      refused.push(url === null ? String(req.url) : url.host);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('e2e proxy: destination refused');
      return;
    }
    req.url = `${url.pathname}${url.search}`;
    forward(req, res, Number(url.port));
  });
  proxy.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    const target = req.url ?? '';
    const sep = target.lastIndexOf(':');
    const host = target.slice(0, sep).toLowerCase();
    if (target.slice(sep + 1) !== '443' || !Object.hasOwn(hosts, host)) {
      refused.push(target);
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) client.unshift(head);
    const tls = new TLSSocket(client, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
    tls.on('error', () => tls.destroy());
    inner.emit('connection', tls);
  });
  proxy.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    port: (proxy.address() as AddressInfo).port,
    refused,
    forwarded,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      inner.close();
    },
  };
}

// ---------------------------------------------------------------------------
// The dev-env services.

export interface DevEnv {
  network: E2eNetwork;
  proxy: BrowserProxy;
  close(): Promise<void>;
}

/** Account passwords: fixed (the network is local and lives only for one run). */
const PASSWORDS: Readonly<Record<AccountName, string>> = {
  alice: 'alice-e2e-password',
  bob: 'bob-e2e-password',
  carol: 'carol-e2e-password',
};

async function createAccount(pds: TestPds, name: AccountName, pdsHost: string): Promise<E2eAccount> {
  const handle = `${name}.test`;
  const agent = pds.getAgent();
  const res = await agent.createAccount({ email: `${name}@e2e.test`, handle, password: PASSWORDS[name] });
  return { name, handle, did: res.data.did, password: PASSWORDS[name], pdsHost, pdsPort: pds.port };
}

/** Bob's one scrobble, written with his password session so his profile exists once indexed. */
async function seedBob(pds: TestPds, bob: E2eAccount): Promise<string> {
  const agent = pds.getAgent();
  await agent.login({ identifier: bob.handle, password: bob.password });
  const built = buildScrobbleRecord(
    { artist: 'Kate Bush', track: 'Running Up That Hill', album: 'Hounds of Love', listenedAt: isoSeconds(Date.now()) },
    E2E_PREFIX,
    { nowMs: () => Date.now() },
  );
  if (!built.ok) throw new Error(`seed record invalid: ${built.reason.field}`);
  const res = await agent.com.atproto.repo.createRecord({
    repo: bob.did,
    collection: `${E2E_PREFIX}.scrobble`,
    record: built.record as unknown as Record<string, unknown>,
  });
  return res.data.uri;
}

function isoSeconds(ms: number): string {
  return `${new Date(ms - 60_000).toISOString().slice(0, 19)}Z`;
}

export async function startDevEnv(ports: E2ePorts = portsFromEnv()): Promise<DevEnv> {
  // Loaded here, not at module scope: playwright.config.ts and the specs
  // import this module's constants and must not load the PDS stack.
  const { mockResolvers, TestPds, TestPlc } = await import('@atproto/dev-env');
  const closers: Array<() => Promise<void>> = [];
  const close = async () => {
    for (const c of closers.reverse()) await c().catch(() => undefined);
  };
  try {
    const plc = await TestPlc.create({ port: ports.plc });
    closers.push(() => plc.close());
    const plcUrl = `http://127.0.0.1:${plc.port}`;
    const pds1 = await TestPds.create({ port: ports.pds1, hostname: 'pds1.test', didPlcUrl: plcUrl });
    closers.push(() => pds1.close());
    const pds2 = await TestPds.create({ port: ports.pds2, hostname: 'pds2.test', didPlcUrl: plcUrl });
    closers.push(() => pds2.close());
    // Each PDS resolves its own DIDs (OAuth, handle checks) against its loopback port.
    mockResolvers(pds1.ctx.idResolver, pds1);
    mockResolvers(pds2.ctx.idResolver, pds2);

    const alice = await createAccount(pds1, 'alice', 'pds1.test');
    const bob = await createAccount(pds2, 'bob', 'pds2.test');
    const bobScrobble = await seedBob(pds2, bob);
    const carol = await createAccount(pds2, 'carol', 'pds2.test');

    const hosts: Record<string, number> = { 'pds1.test': pds1.port, 'pds2.test': pds2.port, [PLC_HOST]: plc.port };
    const proxy = await startBrowserProxy(ports.proxy, hosts, ports.worker);
    closers.push(() => proxy.close());

    const network: E2eNetwork = {
      prefix: E2E_PREFIX,
      workerOrigin: workerOrigin(ports),
      proxyPort: proxy.port,
      plcPort: plc.port,
      hosts,
      accounts: [alice, bob, carol],
      seeded: { bobScrobble },
    };
    return { network, proxy, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Helpers for the specs (web/tests/*.spec.ts).

/** work/e2e/network.json, written by scripts/e2e/start-stack.ts. */
export const NETWORK_PATH = fileURLToPath(new URL('../../work/e2e/network.json', import.meta.url));

export function readNetwork(): E2eNetwork {
  return JSON.parse(readFileSync(NETWORK_PATH, 'utf8')) as E2eNetwork;
}

export function account(net: E2eNetwork, name: AccountName): E2eAccount {
  const found = net.accounts.find((a) => a.name === name);
  if (found === undefined) throw new Error(`no ${name} in ${NETWORK_PATH}`);
  return found;
}

/** A PDS's public XRPC read, straight to its loopback port (test assertions only). */
export async function pdsListRecords(
  acct: E2eAccount,
  collection: string,
): Promise<Array<{ uri: string; cid: string; value: Record<string, unknown> }>> {
  const url = new URL(`http://127.0.0.1:${acct.pdsPort}/xrpc/com.atproto.repo.listRecords`);
  url.searchParams.set('repo', acct.did);
  url.searchParams.set('collection', collection);
  url.searchParams.set('limit', '100');
  const res = await fetch(url);
  if (res.status !== 200) throw new Error(`listRecords ${collection} for ${acct.name}: HTTP ${res.status}`);
  return ((await res.json()) as { records: Array<{ uri: string; cid: string; value: Record<string, unknown> }> })
    .records;
}

/** Presses Tab until `target` has focus (it may already have it, e.g. autofocus); at most `max` presses. */
async function tabUntilFocused(page: Page, target: Locator, label: string, max = 40): Promise<void> {
  const focused = () => target.evaluate((el) => el.matches(':focus'));
  for (let i = 0; i <= max; i++) {
    if (await focused()) return;
    if (i < max) await page.keyboard.press('Tab');
  }
  throw new Error(`${label}: not reached with ${max} Tab presses`);
}

/**
 * The dev-env PDS's own authorization pages (@atproto/oauth-provider UI),
 * after the SPA redirected there: the password, then consent. `keyboard`
 * drives them with Tab/Enter only.
 */
export async function authorizeOnDevPds(
  page: Page,
  acct: E2eAccount,
  options: { keyboard?: boolean } = {},
): Promise<void> {
  await page.waitForURL((url) => url.host === acct.pdsHost && url.pathname === '/oauth/authorize', {
    timeout: 30_000,
  });
  const password = page.getByLabel('Password', { exact: true });
  await password.waitFor();
  if (options.keyboard === true) {
    // A real Tab loop (no programmatic focus): the provider's own pages must
    // be operable from the keyboard as a user meets them.
    await tabUntilFocused(page, password, 'PDS password field');
    await page.keyboard.type(acct.password);
    await page.keyboard.press('Enter');
    const authorize = page.getByRole('button', { name: 'Authorize' });
    await authorize.waitFor();
    await tabUntilFocused(page, authorize, 'PDS Authorize button');
    await page.keyboard.press('Enter');
  } else {
    await password.fill(acct.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Authorize' }).click();
  }
}
