// The production feature list (worker/src/node/features.ts; ADR 0005 §3.5
// rule 2, §3.10, B20; N4-01), composed exactly as production composes it:
// node/run.ts `run()` in-process (test/node/journey/world.ts), over the
// fixture network of fakes, the frozen clock and manual timers.
//
// 1. The pinned-transport spy. run() takes its outbound transports from one
//    `OutboundTransports` source; the test hands a spy source that records
//    every wire it is asked for and gives each wire its own recording
//    transport (whose pinned lookup is a recording spy as well), all routed to
//    the same fakes. A journey then exercises every outbound consumer: the
//    identity and handle resolvers (sign-in), the OAuth client (PAR, token,
//    resource metadata), SafeFetch (snapshot and proof reads), PdsWriter (the
//    outbox's DPoP writes), the Last.fm and ListenBrainz forward clients (link
//    and forward), the Last.fm and ListenBrainz import sources, and the
//    Jetstream connector (the core lane dials it). The check passes only when
//    each consumer's own traffic went through the spy of its own wire, the
//    global fetch (run()'s unpinned stub) was never called, and nothing went
//    unclassified. Then, for each wire in turn, the same journey runs with
//    that wire handed a transport that is NOT the spy (the bare fixture
//    router, which still reaches every fake): the journey still works, and the
//    check must name exactly that wire's consumers as missing.
// 2. The timers and the startup reconcile: the six extension timers are
//    registered (EXTENSION_TIMER_NAMES order) and armed, and a DID the sign-in
//    policy no longer admits has lost its sessions and credentials by the time
//    the listener binds, with the reconcile run exactly once.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FixtureTransport } from '@atmusic/atproto/test-support/router-transport';
import type { Transport } from '@atmusic/atproto/transport';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRevocations } from '../../src/app/revocations';
import { createWebSessions } from '../../src/bff/sessions';
import { ensureAccount } from '../../src/credentials/accounts';
import { createAppPassword } from '../../src/credentials/app-passwords';
import { createLbToken } from '../../src/credentials/lb-tokens';
import { migrate } from '../../src/do/migrate';
import { EXTENSION_TIMER_NAMES } from '../../src/do/timers';
import {
  checkedLookup,
  OUTBOUND_CONSUMERS,
  OUTBOUND_WIRES,
  type OutboundConsumer,
  type OutboundTransports,
  type OutboundWire,
} from '../../src/node/features';
import type { BridgeOptions } from '../../src/node/http-bridge';
import { createServer } from '../../src/node/http-bridge';
import { type PinnedLookup, TransportError } from '../../src/node/pinned-transport';
import { openSqliteDb } from '../../src/node/sqlite-db';
import { ALICE, closeWorlds, PDS_HOST, SCROBBLE, startWorld, T0, type User, World } from './journey/world';
import { TEST_BUSY_TIMEOUT_MS } from './support/node-db';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await closeWorlds();
  vi.useRealTimers();
});

const T0_S = T0 / 1000;
const WIRES = Object.keys(OUTBOUND_WIRES) as OutboundWire[];
const JETSTREAM_HOST = 'jetstream.example.test';

interface SpyRequest {
  wire: OutboundWire;
  method: string;
  host: string;
  path: string;
  /** The DoH query name, for DoH requests. */
  dnsName: string | null;
}

interface Spy {
  /** Every wire run() asked the source for, in order. */
  handed: OutboundWire[];
  requests: SpyRequest[];
  lookups: Array<{ wire: OutboundWire; hostname: string }>;
  source(router: FixtureTransport): OutboundTransports;
}

/**
 * The spy source. Every wire gets its own recording transport over the
 * fixture router, carrying a recording pinned lookup that answers a private
 * address, so the Jetstream connector's dial is observed and refused before
 * any socket connects. `bypass` hands that one wire the bare router instead.
 */
function spySource(bypass: OutboundWire | null = null): Spy {
  const spy: Spy = {
    handed: [],
    requests: [],
    lookups: [],
    source(router) {
      return {
        transportFor(wire) {
          spy.handed.push(wire);
          if (wire === bypass) return router as Transport;
          const lookup: PinnedLookup = async (hostname) => {
            spy.lookups.push({ wire, hostname });
            return [{ address: '10.0.0.7', family: 4 }];
          };
          return Object.assign(
            (req: Request) => {
              const url = new URL(req.url);
              spy.requests.push({
                wire,
                method: req.method,
                host: url.hostname,
                path: url.pathname,
                dnsName: url.pathname === '/dns-query' ? url.searchParams.get('name') : null,
              });
              return router(req);
            },
            {
              fixture: true as const,
              calls: router.calls,
              hostnames: router.hostnames,
              connectOptions: Object.freeze({ rejectUnauthorized: true as const, lookup }),
            },
          );
        },
      };
    },
  };
  return spy;
}

const PDS_WRITE_PATHS = new Set([
  '/xrpc/com.atproto.repo.createRecord',
  '/xrpc/com.atproto.repo.applyWrites',
  '/xrpc/com.atproto.repo.putRecord',
  '/xrpc/com.atproto.repo.deleteRecord',
]);

/** Which consumer a request through the spy of `wire` came from (null: none we know). */
function consumerOf(r: SpyRequest, asHost: string, dohHost: string, plcHost: string): OutboundConsumer | null {
  switch (r.wire) {
    case 'identity':
      // The DID document; the resolver's own SafeFetch pre-checks hosts with DoH A/AAAA queries.
      if (r.host === plcHost) return 'identity-resolver';
      if (r.host === dohHost && r.dnsName?.startsWith('_atproto.') === true) return 'handle-resolver';
      if (r.path === '/.well-known/atproto-did') return 'handle-resolver';
      if (r.host === dohHost) return 'identity-resolver';
      return null;
    case 'core':
      // SafeFetch is GET only: record, block and repo reads, relay listings and its DoH pre-check.
      return r.method === 'GET' ? 'safe-fetch' : null;
    case 'oauth':
      if (r.host === asHost) return 'oauth-client';
      if (r.host === PDS_HOST && r.method === 'POST' && PDS_WRITE_PATHS.has(r.path)) return 'pds-writer';
      if (r.host === PDS_HOST && r.path.startsWith('/.well-known/')) return 'oauth-client';
      return null;
    case 'forward':
      if (r.host === 'lastfm.test') return 'lastfm-forward';
      if (r.host === 'listenbrainz.test') return 'listenbrainz-forward';
      return null;
    case 'imports':
      if (r.host === 'lastfm.test') return 'lastfm-import';
      if (r.host === 'listenbrainz.test') return 'listenbrainz-import';
      return null;
    case 'jetstream':
      return null;
  }
}

interface Coverage {
  /** Consumers whose traffic never went through the spy of their own wire. */
  missing: OutboundConsumer[];
  /** Spied requests no consumer of their wire makes. */
  unclassified: SpyRequest[];
}

function coverage(w: World, spy: Spy): Coverage {
  const seen = new Set<OutboundConsumer>();
  const unclassified: SpyRequest[] = [];
  for (const r of spy.requests) {
    const consumer = consumerOf(r, w.as.host, w.doh.host, w.plc.host);
    if (consumer === null) unclassified.push(r);
    else seen.add(consumer);
  }
  if (spy.lookups.some((l) => l.wire === 'jetstream' && l.hostname === JETSTREAM_HOST)) seen.add('jetstream');
  return { missing: OUTBOUND_CONSUMERS.filter((c) => !seen.has(c)), unclassified };
}

/** One journey through every outbound consumer; asserts that each flow worked. */
async function exercise(w: World, alice: User): Promise<void> {
  // Sign-in: handle → DID (DoH), the DID document (PLC), PAR and token (the AS), the snapshot (SafeFetch).
  const session = await w.signIn(alice);
  expect(w.isCurrent(alice.did)).toBe(true);

  // Links: Last.fm auth.getSession and ListenBrainz validate-token (the forward clients).
  const start = await w.send('POST', '/api/v1/links/lastfm/start', { as: session });
  expect(start.status).toBe(200);
  const cb = new URL(new URL((start.body as { authorizeUrl: string }).authorizeUrl).searchParams.get('cb') as string);
  const lfToken = w.lastfm.issueToken();
  w.lastfm.authorizeToken(lfToken, 'alice_fm');
  expect((await w.send('GET', `${cb.pathname}${cb.search}&token=${lfToken}`, { as: session })).status).toBe(303);
  w.lb.addToken('alice_lb', 'alice-lb-link-token');
  const lbLink = await w.send('POST', '/api/v1/links/listenbrainz', {
    as: session,
    body: { token: 'alice-lb-link-token' },
  });
  expect(lbLink.status).toBe(201);

  // A web scrobble: the outbox's DPoP write (PdsWriter), the proof read (SafeFetch), both forwards.
  const posted = await w.send('POST', '/api/v1/scrobbles', {
    as: session,
    body: { artist: 'Stereolab', track: 'French Disko', listenedAt: '2026-01-15T11:55:00Z' },
    headers: { 'idempotency-key': 'features-spy-1' },
  });
  expect(posted.status).toBe(202);
  await w.until(
    () =>
      w.count('scrobbles', 'did = ?', alice.did) === 1 &&
      w.lastfm.scrobbles.length === 1 &&
      w.lb.submissions.some((s) => s.listenType === 'single'),
  );
  expect((await alice.repo.list(SCROBBLE)).length).toBe(1);

  // Imports: the Last.fm API source, then the ListenBrainz API source.
  w.lastfm.seedHistory('alice_fm', [
    { artist: 'Broadcast', track: 'Tears in the Typing Pool', uts: T0_S - 7200 },
    { artist: 'Broadcast', track: 'Pendulum', uts: T0_S - 7500 },
  ]);
  const lfImport = await w.send('POST', '/api/v1/imports', {
    as: session,
    body: { source: 'lastfm', username: 'alice_fm' },
  });
  expect(lfImport.status).toBe(202);
  const lfJob = (lfImport.body as { id: string }).id;
  await w.until(
    () => w.db.one<{ state: string }>('SELECT state FROM import_jobs WHERE id = ?', lfJob)?.state === 'done',
    {
      stepMs: 10_000,
    },
  );
  w.lb.seedListens('alice_lb', [
    { listened_at: T0_S - 9000, track_metadata: { artist_name: 'Pram', track_name: 'Loco' } },
    { listened_at: T0_S - 9300, track_metadata: { artist_name: 'Pram', track_name: 'Gravity' } },
  ]);
  const lbImport = await w.send('POST', '/api/v1/imports', {
    as: session,
    body: { source: 'listenbrainz', username: 'alice_lb' },
  });
  expect(lbImport.status).toBe(202);
  const lbJob = (lbImport.body as { id: string }).id;
  await w.until(
    () => w.db.one<{ state: string }>('SELECT state FROM import_jobs WHERE id = ?', lbJob)?.state === 'done',
    {
      stepMs: 10_000,
    },
  );
  expect((await alice.repo.list(SCROBBLE)).length).toBe(5);
}

/** Starts a world on `spy`, with run() building its own Jetstream connector and a recording global fetch. */
async function spiedWorld(spy: Spy): Promise<{ w: World; alice: User; unpinned: string[] }> {
  const { w, alice } = await startWorld({ outbound: (router) => spy.source(router), connectJetstream: null });
  // run() installed the unpinned stub as globalThis.fetch; record every call to it.
  const stub = globalThis.fetch;
  const unpinned: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    unpinned.push(input instanceof Request ? input.url : String(input));
    return stub(input, init);
  }) as typeof fetch;
  return { w, alice, unpinned };
}

describe('production features', () => {
  it('every outbound consumer of the production composition receives the injected spy transport, and leaving it out of any one consumer makes the test fail', async () => {
    // With the spy on every wire.
    const spy = spySource();
    const { w, alice, unpinned } = await spiedWorld(spy);
    expect(new Set(spy.handed)).toEqual(new Set(WIRES));
    await exercise(w, alice);
    const full = coverage(w, spy);
    expect(full.missing).toEqual([]);
    expect(full.unclassified).toEqual([]);
    expect(unpinned).toEqual([]);
    // The Jetstream connector dialled through the pinned lookup, which refused the private answer: no socket.
    expect(spy.lookups.filter((l) => l.wire === 'jetstream').map((l) => l.hostname)).toContain(JETSTREAM_HOST);
    expect(w.log.logs.some((l) => l.event === 'jetstream_connected')).toBe(false);
    // That lookup admits a host only when every answer is public (the pinned transport's rule).
    const answer = (answers: Array<{ address: string }>, all = false) =>
      new Promise<unknown[]>((resolve) => {
        checkedLookup(async () => answers)('jetstream.example.test', { all }, (...args: unknown[]) => resolve(args));
      });
    expect(await answer([{ address: '93.184.216.34' }])).toEqual([null, '93.184.216.34', 4]);
    expect(await answer([{ address: '93.184.216.34' }, { address: '2606:2800:220:1::1' }], true)).toEqual([
      null,
      [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ],
    ]);
    for (const answers of [
      [{ address: '93.184.216.34' }, { address: '127.2.0.1' }],
      [{ address: '192.168.1.2' }],
      [],
    ]) {
      const [error] = await answer(answers);
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).code).toBe(answers.length === 0 ? 'dns' : 'blocked_address');
    }
    await w.close();

    // The spy left out of one wire at a time: everything still works, and the check names that wire's consumers.
    for (const wire of WIRES) {
      const partial = spySource(wire);
      const run = await spiedWorld(partial);
      await exercise(run.w, run.alice);
      const result = coverage(run.w, partial);
      expect(result.missing, `spy left out of ${wire}`).toEqual(
        OUTBOUND_CONSUMERS.filter((c) => (OUTBOUND_WIRES[wire] as readonly OutboundConsumer[]).includes(c)),
      );
      expect(result.missing.length).toBeGreaterThan(0);
      expect(result.unclassified).toEqual([]);
      await run.w.close();
    }
  }, 180_000);

  it('the production features register the six extension timers in EXTENSION_TIMER_NAMES order and run reconcileSignInPolicy once at startup before listen', async () => {
    const REFUSED = 'did:plc:cccccccccccccccccccccccc';
    const w = new World({
      env: { ATMUSIC_SIGNIN_DIDS: ALICE },
      serverFactory: (options: BridgeOptions) => {
        const bridge = createServer(options);
        return {
          get server() {
            return bridge.server;
          },
          get address() {
            return bridge.address;
          },
          start: () => {
            atListen = observe();
            return bridge.start();
          },
          close: () => bridge.close(),
        };
      },
    });
    /** What the process had logged when it bound the listener. */
    const observe = () => w.log.logs.map((l) => l.event);
    let atListen: string[] | 'unset' = 'unset';

    // A database from an earlier run: a DID that was admitted then, and Alice, who still is.
    mkdirSync(dirname(w.dbPath), { recursive: true });
    const seed = openSqliteDb(w.dbPath, { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS, create: true });
    expect(migrate(seed).status).toBe('ready');
    const deps = { db: seed, clock: w.clock, random: seededRandom(77), revocations: new MemoryRevocations(w.clock) };
    for (const did of [REFUSED, ALICE]) {
      ensureAccount(deps, { did, verifiedHandle: null });
      createWebSessions(deps).create(did);
      createAppPassword(deps, { did, label: 'old' });
    }
    createLbToken(deps, { did: REFUSED, label: 'old' });
    seed.close();

    const server = await w.start();
    // When the listener bound, the reconcile had already run and revoked the refused DID.
    expect(atListen).not.toBe('unset');
    const before = atListen as unknown as string[];
    expect(before.filter((e) => e === 'run.signin_reconciled')).toHaveLength(1);
    expect(before.filter((e) => e === 'signin_policy_revoked')).toHaveLength(1);
    expect(before).not.toContain('run.ready');
    // Nothing has run since (manual timers): the database shows what the reconcile did.
    const refused = {
      webSessions: w.count('web_sessions', 'did = ?', REFUSED),
      appPasswords: w.count('app_passwords', 'did = ?', REFUSED),
      lbTokens: w.count('lb_tokens', 'did = ?', REFUSED),
      status: w.db.one<{ s: string }>('SELECT oauth_status AS s FROM accounts WHERE did = ?', REFUSED)?.s ?? null,
    };
    expect(refused).toEqual({ webSessions: 0, appPasswords: 0, lbTokens: 0, status: 'signed_out' });
    expect({
      webSessions: w.count('web_sessions', 'did = ?', ALICE),
      appPasswords: w.count('app_passwords', 'did = ?', ALICE),
      status: w.db.one<{ s: string }>('SELECT oauth_status AS s FROM accounts WHERE did = ?', ALICE)?.s ?? null,
    }).toEqual({ webSessions: 1, appPasswords: 1, status: 'active' });

    // The reconcile ran exactly once, after the database was opened and composed, before run.ready.
    const events = w.log.logs.map((l) => l.event);
    expect(events.filter((e) => e === 'run.signin_reconciled')).toHaveLength(1);
    expect(events.filter((e) => e === 'signin_policy_revoked')).toHaveLength(1);
    expect(w.log.logs.find((l) => l.event === 'signin_policy_revoked')).toMatchObject({ did: REFUSED });
    expect(w.log.logs.find((l) => l.event === 'run.signin_reconciled')).toMatchObject({
      policy: 'allowlist',
      signedOut: 1,
    });
    expect(events.indexOf('run.signin_reconciled')).toBeLessThan(events.indexOf('run.ready'));
    expect(events.indexOf('sqlite.opened')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('run.signin_reconciled')).toBeGreaterThan(events.indexOf('sqlite.opened'));

    // The six extension timers, in their fixed order, each with a handler and a stored due time.
    expect([...server.app.core.extensionLane.names]).toEqual([...EXTENSION_TIMER_NAMES]);
    expect(EXTENSION_TIMER_NAMES).toEqual(['outbox', 'forward', 'import', 'oauth-keepalive', 'expiry-sweep', 'backup']);
    const stored = w.db.all<{ name: string }>('SELECT name FROM timers ORDER BY name').map((r) => r.name);
    for (const name of EXTENSION_TIMER_NAMES) expect(stored).toContain(name);
    expect(server.features.features.map((f) => f.name)).toEqual([
      'web-sessions',
      'auth',
      'web-writes',
      'lastfm-auth',
      'lastfm',
      'listenbrainz',
      'links',
      'imports',
      'credential-settings',
      'outbox',
      'oauth-keepalive',
      'expiry-sweep',
      'meta',
      'backup',
    ]);
    // The extension alarm is armed (the earliest due time is now: the outbox, forward and import starts).
    expect(w.timers.pending().some((t) => t.kind === 'timeout')).toBe(true);

    await w.close();
  }, 60_000);
});
