// TEST-ONLY Node e2e network. The deterministic identity fakes live together
// in one child and are reached over a Host-routed loopback HTTP listener.
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { FakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { FakeOAuthAs } from '@atmusic/atproto/test-support/fake-oauth-as';
import { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import { FakePlc } from '@atmusic/atproto/test-support/fake-plc';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { type CommitResult, SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { buildScrobbleRecord } from '@atmusic/core/scrobble';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { FakeListenBrainz } from '../../worker/test/node/support/fake-listenbrainz';
import type { E2eAccount, E2eNetwork, E2ePorts } from './dev-env';
import { E2E_PREFIX, PLC_HOST, startBrowserProxy } from './dev-env';

export const FIXTURE_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
export const APP_HOST = 'music.e2e.test';
export const AS_HOST = 'as.test';
export const PDS1_HOST = 'pds1.test';
export const PDS2_HOST = 'pds2.test';
export const DOH_HOST = 'cloudflare-dns.com';
export const RELAY_HOST = 'relay.test';
const LASTFM_HOST = 'ws.audioscrobbler.com';
const LISTENBRAINZ_HOST = 'api.listenbrainz.org';
export const E2E_LISTENBRAINZ_TOKEN = 'e2e-listenbrainz-token';
export const E2E_LISTENBRAINZ_USER = 'e2e-listener';
export const FIXTURE_WRITER_DID = 'did:plc:dddddddddddddddddddddddd';
const ENTRY = fileURLToPath(import.meta.url);
const IPC_TIMEOUT_MS = 10_000;

export interface FixtureWorld {
  network: E2eNetwork;
  clock: FixedClock;
  clockStartedWallMs: number;
  advance(ms: number): void;
  route(request: Request): Promise<Response>;
  drainCommits(): Array<{ did: string; commit: CommitResult }>;
  close(): Promise<void>;
}

type ChildCommand =
  | { type: 'command'; id: number; action: 'advance'; ms: number }
  | { type: 'command'; id: number; action: 'stop' };
type ChildReply =
  | { type: 'ready'; role: 'identity'; port: number; accounts: E2eAccount[]; fixtureNowMs: number }
  | { type: 'commits'; commits: Array<{ did: string; commit: CommitResult }> }
  | { type: 'answer'; id: number; result?: unknown; error?: string };

function send(reply: ChildReply): void {
  if (!process.send) throw new Error('identity child IPC is unavailable');
  process.send(reply);
}

async function webRequest(incoming: IncomingMessage, hostFallback: string): Promise<Request> {
  const host =
    incoming.headers['x-fixture-host']?.toString() ?? incoming.headers.host?.replace(/:\d+$/, '') ?? hostFallback;
  const method = incoming.method ?? 'GET';
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2)
    headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
  const body = Buffer.concat(chunks);
  return new Request(`https://${host}${incoming.url ?? '/'}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' || body.length === 0 ? {} : { body, duplex: 'half' as const }),
  });
}

async function serve(
  handler: (request: Request) => Promise<Response>,
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer(async (incoming, outgoing) => {
    try {
      let request = await webRequest(incoming, PDS1_HOST);
      // Direct test evidence uses 127.0.0.1 and a repo DID, with no Host header.
      // Resolve that one assertion-only form to the account's owning PDS.
      const url = new URL(request.url);
      if ((incoming.headers.host ?? '').startsWith('127.0.0.1:') && url.pathname.endsWith('/listRecords')) {
        const repo = url.searchParams.get('repo');
        const pdsHost = repo === null ? undefined : didToPds.get(repo);
        if (pdsHost) request = new Request(`https://${pdsHost}${url.pathname}${url.search}`, request);
      }
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(response.body === null ? null : Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      process.stderr.write(
        `identity fixture request failed: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'text/plain' });
      outgoing.end('fixture handler failed');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const didToPds = new Map<string, string>();

/** Shared deterministic fixture construction, used only inside the identity child. */
async function runIdentityChild(
  workerPort: number,
  withPlaywrightListenBrainz: boolean,
  appHost = '127.0.0.1',
  publicHost = APP_HOST,
): Promise<void> {
  if (!process.send) throw new Error('identity child requires IPC');
  const clock = fixedClock(new Date(FIXTURE_NOW_MS).toISOString());
  const keys = await fixtureKeys();
  const as = new FakeOAuthAs({ clock, random: seededRandom(101) });
  const pds1 = new FakePds(PDS1_HOST, { clock, authorizationServer: as });
  const pds2 = new FakePds(PDS2_HOST, { clock, authorizationServer: as });
  const plc = new FakePlc();
  const doh = new FakeDoh();
  const listenbrainz = withPlaywrightListenBrainz ? new FakeListenBrainz({ clock, host: LISTENBRAINZ_HOST }) : null;
  if (listenbrainz) {
    listenbrainz.addToken(E2E_LISTENBRAINZ_USER, E2E_LISTENBRAINZ_TOKEN);
    listenbrainz.seedListens(
      E2E_LISTENBRAINZ_USER,
      Array.from({ length: 12 }, (_, index) => ({
        listened_at: Math.floor(FIXTURE_NOW_MS / 1000) - 3600 - index * 86400,
        track_metadata: { artist_name: `Fixture Artist ${index + 1}`, track_name: `Fixture Track ${index + 1}` },
      })),
    );
  }
  const accounts: E2eAccount[] = [];
  const pdsByName = { alice: pds1, bob: pds2, carol: pds2 };
  const pdsHosts = { alice: PDS1_HOST, bob: PDS2_HOST, carol: PDS2_HOST };
  const pendingCommits: Array<{ did: string; commit: CommitResult }> = [];
  for (const [index, name] of (['alice', 'bob', 'carol'] as const).entries()) {
    const did = `did:plc:${String.fromCharCode(97 + index).repeat(24)}`;
    const handle = `${name}.test`;
    const pds = pdsByName[name];
    const key = keys[name];
    const repo = new SignedRepo(did, key, { clock });
    if (name === 'bob') {
      const listenedAt = `${new Date(FIXTURE_NOW_MS - 60_000).toISOString().slice(0, 19)}Z`;
      const built = buildScrobbleRecord(
        { artist: 'Kate Bush', track: 'Running Up That Hill', album: 'Hounds of Love', listenedAt },
        E2E_PREFIX,
        clock,
      );
      if (!built.ok) throw new Error(`seed scrobble invalid: ${built.reason.field}`);
      await repo.put(`${E2E_PREFIX}.scrobble`, 'bob-seed', built.record);
    }
    await pds.addAccount(repo, { handle, auth: 'dpop' });
    pds.onCommit((commitDid, commit) => {
      const entry = { did: commitDid, commit };
      pendingCommits.push(entry);
      process.send?.({ type: 'commits', commits: [entry] });
    });
    plc.register(did, { signingKey: key, pds: `https://${pdsHosts[name]}`, handle });
    doh.setTxt(`_atproto.${handle}`, [`did=${did}`]);
    as.addAccount(did, { handle });
    didToPds.set(did, pdsHosts[name]);
    accounts.push({ name, handle, did, password: `${name}-e2e-password`, pdsHost: pdsHosts[name], pdsPort: 0 });
  }
  // A private fixture-auth account gives process tests a deterministic way to
  // exercise FakePds writes without changing the OAuth-backed browser accounts.
  await pds1.addAccount(new SignedRepo(FIXTURE_WRITER_DID, keys.alice, { clock }), { auth: 'fixture' });
  const relay = async (req: Request): Promise<Response> =>
    new Response(JSON.stringify({ repos: [] }), {
      status: new URL(req.url).pathname.endsWith('listReposByCollection') ? 200 : 501,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  const localApp = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const init: RequestInit = { method: req.method, headers: req.headers, redirect: 'manual' };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
    return fetch(`http://${appHost}:${workerPort}${url.pathname}${url.search}`, init);
  };
  const transport: FixtureTransport = routerTransport({
    pds: [pds1, pds2],
    plc,
    doh,
    hosts: {
      [publicHost]:
        workerPort > 0
          ? localApp
          : async () => new Response('application host is not part of the identity fixture', { status: 501 }),
      [AS_HOST]: (req) => as.fetch(req),
      [RELAY_HOST]: relay,
      [LASTFM_HOST]: async (req) => {
        const json = new URL(req.url).searchParams.get('format') === 'json';
        return new Response(
          json
            ? JSON.stringify({ lfm: { status: 'failed', error: { code: 10, '#text': 'e2e fixture' } } })
            : '<?xml version="1.0"?><lfm status="failed"><error code="10">e2e fixture</error></lfm>',
          {
            status: 200,
            headers: { 'content-type': json ? 'application/json' : 'text/xml; charset=utf-8' },
          },
        );
      },
      [LISTENBRAINZ_HOST]: (req) =>
        listenbrainz?.fetch(req) ?? new Response('unavailable in identity-only fixture', { status: 501 }),
    },
    handles: Object.fromEntries(accounts.map(({ handle, did }) => [handle, did])),
  });
  as.connect(transport);
  const http = await serve((request) => transport(request));
  send({
    type: 'ready',
    role: 'identity',
    port: http.port,
    accounts: accounts.map((account) => ({ ...account, pdsPort: http.port })),
    fixtureNowMs: FIXTURE_NOW_MS,
  });
  let closing: Promise<void> | null = null;
  process.on('message', (raw: unknown) => {
    const message = raw as Partial<ChildCommand>;
    if (message.type !== 'command' || !Number.isSafeInteger(message.id)) return;
    const reply = (result?: unknown, error?: unknown) =>
      send({
        type: 'answer',
        id: message.id!,
        result,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
      });
    try {
      if (message.action === 'advance' && typeof message.ms === 'number' && message.ms >= 0) {
        clock.advance(message.ms);
        reply(true);
      } else if (message.action === 'stop') {
        closing ??= http.close();
        void closing.then(() => reply(true));
      } else throw new Error('invalid identity child command');
    } catch (error) {
      reply(undefined, error);
    }
  });
  process.on('SIGTERM', () => {
    void http.close().finally(() => process.exit(0));
  });
}

function ipc(child: ChildProcess, message: ChildCommand, timeoutMs = IPC_TIMEOUT_MS): Promise<unknown> {
  if (!child.connected) return Promise.reject(new Error('identity child IPC is closed'));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('message', onMessage);
      reject(new Error(`identity child command ${message.id} timed out`));
    }, timeoutMs);
    const onMessage = (raw: unknown) => {
      const answer = raw as Partial<ChildReply>;
      if (answer.type !== 'answer' || answer.id !== message.id) return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      if (typeof answer.error === 'string') reject(new Error(answer.error));
      else resolve(answer.result);
    };
    child.on('message', onMessage);
    child.send(message, (error) => {
      if (error) {
        clearTimeout(timeout);
        child.off('message', onMessage);
        reject(error);
      }
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    await ipc(child, { type: 'command', id: 1, action: 'stop' }, 2_000);
  } catch {
    /* signal cleanup below */
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

export async function startIdentityFixture(
  workerPort = 0,
  withPlaywrightListenBrainz = false,
  appHost = '127.0.0.1',
  publicHost = APP_HOST,
): Promise<{
  child: ChildProcess;
  port: number;
  accounts: E2eAccount[];
  route(request: Request): Promise<Response>;
  drainCommits(): Array<{ did: string; commit: CommitResult }>;
  advance(ms: number): Promise<void>;
  close(): Promise<void>;
}> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      ENTRY,
      '--identity-child',
      String(workerPort),
      withPlaywrightListenBrainz ? 'playwright' : 'identity',
      appHost,
      publicHost,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  const startup = new Promise<{ port: number; accounts: E2eAccount[] }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('identity fake failed to announce ready')), IPC_TIMEOUT_MS);
    const onMessage = (raw: unknown) => {
      const message = raw as Partial<ChildReply>;
      if (message.type !== 'ready' || message.role !== 'identity') return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      if (Number.isSafeInteger(message.port) && Array.isArray(message.accounts))
        resolve({ port: message.port!, accounts: message.accounts as E2eAccount[] });
      else reject(new Error('identity fake announced invalid readiness'));
    };
    child.on('message', onMessage);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`identity fake exited during startup (${code ?? signal})`));
    });
  });
  try {
    const ready = await startup;
    const commits: Array<{ did: string; commit: CommitResult }> = [];
    child.on('message', (raw: unknown) => {
      const message = raw as Partial<ChildReply>;
      if (message.type === 'commits' && Array.isArray(message.commits)) commits.push(...message.commits);
    });
    let id = 1;
    let closed = false;
    return {
      child,
      ...ready,
      async route(request) {
        if (closed) throw new Error('identity fixture is closed');
        const url = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.set('x-fixture-host', url.host);
        const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
        if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();
        return fetch(`http://127.0.0.1:${ready.port}${url.pathname}${url.search}`, init);
      },
      drainCommits: () => commits.splice(0),
      async advance(ms) {
        if (closed) throw new Error('identity fixture is closed');
        await ipc(child, { type: 'command', id: ++id, action: 'advance', ms });
      },
      async close() {
        if (closed) return;
        closed = true;
        await stopChild(child);
      },
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

/** Starts the deterministic identity process and browser TLS proxy. */
export async function startFixtureWorld(ports: E2ePorts): Promise<FixtureWorld> {
  const clockStartedWallMs = Date.now();
  const identity = await startIdentityFixture(ports.worker, true);
  const identityHosts = [
    PDS1_HOST,
    PDS2_HOST,
    PLC_HOST,
    DOH_HOST,
    AS_HOST,
    RELAY_HOST,
    'alice.test',
    'bob.test',
    'carol.test',
    LASTFM_HOST,
    LISTENBRAINZ_HOST,
  ];
  const hosts: Record<string, number> = Object.fromEntries(identityHosts.map((host) => [host, identity.port]));
  hosts[APP_HOST] = ports.worker;
  let proxy: Awaited<ReturnType<typeof startBrowserProxy>>;
  try {
    proxy = await startBrowserProxy(ports.proxy, hosts, ports.worker);
  } catch (error) {
    await identity.close();
    throw error;
  }
  const clock = fixedClock(new Date(FIXTURE_NOW_MS).toISOString());
  const accounts = identity.accounts.map((account) => ({ ...account, pdsPort: identity.port }));
  const network: E2eNetwork = {
    prefix: E2E_PREFIX,
    fixtureNowMs: FIXTURE_NOW_MS,
    workerOrigin: `https://${APP_HOST}`,
    proxyPort: proxy.port,
    plcPort: identity.port,
    hosts,
    accounts,
    seeded: { bobScrobble: `at://${accounts[1]!.did}/${E2E_PREFIX}.scrobble/bob-seed` },
  };
  let closed = false;
  let advanceTask = Promise.resolve();
  return {
    network,
    clock,
    clockStartedWallMs,
    advance(ms) {
      if (closed) throw new Error('fixture world is closed');
      clock.advance(ms);
      advanceTask = advanceTask.then(() => identity.advance(ms));
    },
    async route(request) {
      if (closed) throw new Error('fixture world is closed');
      await advanceTask;
      return identity.route(request);
    },
    drainCommits: () => identity.drainCommits(),
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([proxy.close(), identity.close()]);
    },
  };
}

if (process.argv[2] === '--identity-child')
  await runIdentityChild(Number(process.argv[3]), process.argv[4] === 'playwright', process.argv[5], process.argv[6]);
