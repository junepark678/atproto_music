// TEST-ONLY Node e2e network. Every upstream is an in-process fake and every
// public HTTPS host is explicitly routed by the parent IPC transport.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { FakeOAuthAs } from '@atmusic/atproto/test-support/fake-oauth-as';
import { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import { FakePlc } from '@atmusic/atproto/test-support/fake-plc';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { buildScrobbleRecord } from '@atmusic/core/scrobble';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
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

export interface FixtureWorld {
  network: E2eNetwork;
  clock: FixedClock;
  clockStartedWallMs: number;
  advance(ms: number): void;
  route(request: Request): Promise<Response>;
  drainCommits(): Array<{ did: string; commit: unknown }>;
  close(): Promise<void>;
}

async function serveFixtureHandler(
  handler: (request: Request) => Promise<Response>,
  hostOverride?: string,
): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const server: Server = createServer(async (incoming, outgoing) => {
    try {
      const request = await webRequest(incoming, hostOverride);
      const response = await handler(request);
      const body = response.body === null ? null : Buffer.from(await response.arrayBuffer());
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(body);
    } catch {
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

async function webRequest(incoming: IncomingMessage, hostOverride?: string): Promise<Request> {
  const host = hostOverride ?? incoming.headers.host ?? 'fixture.test';
  const method = incoming.method ?? 'GET';
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
  }
  const body = Buffer.concat(chunks);
  return new Request(`https://${host}${incoming.url ?? '/'}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' || body.length === 0 ? {} : { body, duplex: 'half' as const }),
  });
}

/** Creates deterministic AS/PDS/PLC/DoH fakes, reachable only through this map. */
export async function startFixtureWorld(ports: E2ePorts): Promise<FixtureWorld> {
  const clockStartedWallMs = Date.now();
  const clock = fixedClock(new Date(FIXTURE_NOW_MS).toISOString());
  const keys = await fixtureKeys();
  const as = new FakeOAuthAs({ clock, random: seededRandom(101) });
  const pds1 = new FakePds(PDS1_HOST, { clock, authorizationServer: as });
  const pds2 = new FakePds(PDS2_HOST, { clock, authorizationServer: as });
  const plc = new FakePlc();
  const doh = new FakeDoh();
  const accounts: E2eAccount[] = [];
  const pdsByName = { alice: pds1, bob: pds2, carol: pds2 };
  const pdsHosts = { alice: PDS1_HOST, bob: PDS2_HOST, carol: PDS2_HOST };
  const pendingCommits: Array<{ did: string; commit: unknown }> = [];
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
    pds.onCommit((commitDid, commit) => pendingCommits.push({ did: commitDid, commit }));
    plc.register(did, { signingKey: key, pds: `https://${pdsHosts[name]}`, handle });
    doh.setTxt(`_atproto.${handle}`, [`did=${did}`]);
    as.addAccount(did, { handle });
    accounts.push({
      name,
      handle,
      did,
      password: `${name}-e2e-password`,
      pdsHost: pdsHosts[name],
      pdsPort: name === 'alice' ? ports.pds1 : ports.pds2,
    });
  }
  const localApp = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const init: RequestInit = { method: req.method, headers: req.headers, redirect: 'manual' };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
    return fetch(`http://127.0.0.1:${ports.worker}${url.pathname}${url.search}`, init);
  };
  const transport: FixtureTransport = routerTransport({
    pds: [pds1, pds2],
    plc,
    doh,
    hosts: {
      [APP_HOST]: localApp,
      [AS_HOST]: (req) => as.fetch(req),
      [RELAY_HOST]: async (req) =>
        new Response(JSON.stringify({ repos: [] }), {
          status: new URL(req.url).pathname.endsWith('listReposByCollection') ? 200 : 501,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      [LASTFM_HOST]: async (req) => {
        const json = new URL(req.url).searchParams.get('format') === 'json';
        return new Response(
          json
            ? JSON.stringify({ lfm: { status: 'failed', error: { code: 10, '#text': 'e2e fixture' } } })
            : '<?xml version="1.0"?><lfm status="failed"><error code="10">e2e fixture</error></lfm>',
          { status: 200, headers: { 'content-type': json ? 'application/json' : 'text/xml; charset=utf-8' } },
        );
      },
      [LISTENBRAINZ_HOST]: async () =>
        new Response(JSON.stringify({ error: 'e2e fixture' }), {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    },
    handles: Object.fromEntries(accounts.map(({ handle, did }) => [handle, did])),
  });
  as.connect(transport);
  const fixtureServers = await Promise.all([
    serveFixtureHandler((request) => transport(request), PDS1_HOST),
    serveFixtureHandler((request) => transport(request), PDS2_HOST),
    serveFixtureHandler((request) => transport(request)),
    serveFixtureHandler((request) => transport(request)),
    serveFixtureHandler((request) => transport(request)),
    serveFixtureHandler((request) => transport(request)),
    serveFixtureHandler((request) => transport(request)),
    serveFixtureHandler((request) => transport(request)),
    serveFixtureHandler((request) => transport(request)),
  ]);
  const hosts: Record<string, number> = {
    [APP_HOST]: ports.worker,
    [PDS1_HOST]: fixtureServers[0]!.port,
    [PDS2_HOST]: fixtureServers[1]!.port,
    [PLC_HOST]: fixtureServers[2]!.port,
    [DOH_HOST]: fixtureServers[3]!.port,
    [AS_HOST]: fixtureServers[4]!.port,
    [RELAY_HOST]: fixtureServers[5]!.port,
    'alice.test': fixtureServers[6]!.port,
    'bob.test': fixtureServers[6]!.port,
    'carol.test': fixtureServers[6]!.port,
    [LASTFM_HOST]: fixtureServers[7]!.port,
    [LISTENBRAINZ_HOST]: fixtureServers[8]!.port,
  };
  for (const account of accounts) account.pdsPort = hosts[account.pdsHost]!;
  const proxy = await startBrowserProxy(ports.proxy, hosts, ports.worker);
  const network: E2eNetwork = {
    prefix: E2E_PREFIX,
    fixtureNowMs: FIXTURE_NOW_MS,
    workerOrigin: `https://${APP_HOST}`,
    proxyPort: proxy.port,
    plcPort: hosts[PLC_HOST]!,
    hosts,
    accounts,
    seeded: { bobScrobble: `at://${accounts[1]!.did}/${E2E_PREFIX}.scrobble/bob-seed` },
  };
  return {
    network,
    clock,
    clockStartedWallMs,
    advance: (ms) => clock.advance(ms),
    route: (request) => transport(request),
    drainCommits: () => pendingCommits.splice(0),
    async close() {
      await proxy.close();
      await Promise.all(fixtureServers.map((server) => server.close()));
    },
  };
}
