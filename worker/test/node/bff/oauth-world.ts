// The OAuth test world for the BFF suites (ADR 0005 §5.10, §15.2; N2-03).
// TEST-ONLY. Not a test file: the oauth-client, oauth-stores, keepalive and
// reconcile suites import it.
//
// Everything runs over local fakes reached through the router transport: the
// fake AS (packages/atproto/test-support/fake-oauth-as.ts), a fake PDS whose
// accounts are added with `auth: 'dpop'`, the fake PLC directory and the fake
// DoH resolver. Our client metadata and JWKS are served at
// https://music.214510.xyz by client-metadata.ts's own response builders, so
// the fake AS verifies every private_key_jwt assertion against our real JWKS.
//
// Two router transports share the fakes:
//   - `oauthTransport` is what policyFetch (and so the OAuth library) uses. It
//     can reach plc.directory too, so a library-built DID resolver would be
//     visible in its call log; it records every request to an AS host.
//   - `identityTransport` is what our identity module uses (SafeFetch, DoH).
//     `identityIntercept` lets a test inject a fault in front of it.
//
// Determinism: the clock is fixedClock (2026-01-15T12:00:00Z) and every random
// value comes from seeded Randoms. @atproto/oauth-client reads Date.now() for
// the assertion and DPoP `iat` and the token expiry, so the suites fake Date
// (vi.useFakeTimers({toFake: ['Date']})) and `advance` moves both together.
// Deadlines use a manual timer, so nothing waits for a real 10 s timeout.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createIdentityResolver } from '@atmusic/atproto/identity/resolver';
import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import type { DeadlineTimer } from '@atmusic/atproto/net/safe-fetch';
import { FakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { FakeOAuthAs, FIXTURE_CLIENT_KEYS } from '@atmusic/atproto/test-support/fake-oauth-as';
import { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import { FakePlc } from '@atmusic/atproto/test-support/fake-plc';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import type { Transport } from '@atmusic/atproto/transport';
import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import type { OAuthSession } from '@atproto/oauth-client-node';
import { vi } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import {
  buildClientMetadata,
  type ClientMetadataDocument,
  clientMetadataResponse,
  jwksResponse,
  OAUTH_JWKS_PATH,
  OAUTH_METADATA_PATH,
} from '../../../src/bff/client-metadata';
import { loadOAuthKeyset, type OAuthKeyset } from '../../../src/bff/keyset';
import { createOAuthService, type OAuthService, type OAuthServiceDeps } from '../../../src/bff/oauth-client';
import { type Box, createBox } from '../../../src/crypto/box';
import type { Logger, LogLevel } from '../../../src/do/contracts';
import type { Db } from '../../../src/do/db';
import { createPolicyFetch } from '../../../src/node/policy-fetch';
import { parseSecrets, type Secrets } from '../../../src/node/secrets';

export const ORIGIN = 'https://music.214510.xyz';
export const CLIENT_ID = `${ORIGIN}${OAUTH_METADATA_PATH}`;
export const PREFIX = FIXTURE_PREFIX;
export const SCROBBLE = `${PREFIX}.scrobble`;
export const PDS_HOST = 'pds.example.test';
export const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
export const DAY_MS = 86_400_000;

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A valid did:plc for user number `i` (0..1023). */
export function didFor(i: number): string {
  return `did:plc:${'a'.repeat(22)}${B32[(i >> 5) & 31]}${B32[i & 31]}`;
}

export const sha256 = (data: string | Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());
export const hex = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b as ArrayBuffer).toString('hex');

/** Fake Date at the frozen instant; call in beforeEach, with vi.useRealTimers() in afterEach. */
export function freezeDate(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
}

export interface LogLine {
  level: LogLevel;
  event: string;
  fields: Record<string, unknown>;
}

export interface ManualTimer extends DeadlineTimer {
  /** Abort every deadline handed out so far, as if it had expired. */
  expireAll(): void;
}

export function manualTimer(): ManualTimer {
  const pending = new Set<AbortController>();
  return {
    timeout() {
      const c = new AbortController();
      pending.add(c);
      return c.signal;
    },
    expireAll() {
      for (const c of pending) c.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      pending.clear();
    },
  };
}

export interface CapturedRequest {
  url: string;
  path: string;
  method: string;
  headers: Headers;
  body: string;
  /** The AS's answer; 0 while pending or when the request threw. */
  status: number;
}

export interface WorldUser {
  name: string;
  did: string;
  handle: string;
  repo: SignedRepo;
  pds: FakePds;
}

export interface WorldOptions {
  /** Signing keys of the keyset, in order (default ['k1']). */
  signingKids?: Array<'k1' | 'k2' | 'k3'>;
  /** Public keys announced in addition. */
  announcedKids?: Array<'k1' | 'k2' | 'k3'>;
  /** A second AS and PDS (as2.test, pds2.example.test). */
  secondServer?: boolean;
}

export interface IdentityCall {
  did: string;
  fresh: boolean;
}

type FixtureKey = (typeof FIXTURE_CLIENT_KEYS)[keyof typeof FIXTURE_CLIENT_KEYS];

const publicOf = (k: FixtureKey) => ({ kty: k.kty, crv: k.crv, kid: k.kid, alg: k.alg, x: k.x, y: k.y });

function fixtureKey(kid: string): FixtureKey {
  if (!Object.hasOwn(FIXTURE_CLIENT_KEYS, kid)) throw new Error(`no fixture client key ${kid}`);
  return FIXTURE_CLIENT_KEYS[kid as keyof typeof FIXTURE_CLIENT_KEYS];
}

export function secretsFor(signingKids: readonly string[], announcedKids: readonly string[] = []): Secrets {
  return parseSecrets({
    cursorKey: Buffer.alloc(32, 0x22).toString('base64'),
    encryptionKeys: [{ id: 'e1', key: Buffer.alloc(32, 0x11).toString('base64') }],
    oauthSigningKeys: signingKids.map((kid) => ({ ...fixtureKey(kid) })),
    oauthAnnouncedKeys: announcedKids.map((kid) => publicOf(fixtureKey(kid))),
  });
}

export async function createWorld(db: Db, o: WorldOptions = {}) {
  const clock: FixedClock = fixedClock();
  vi.setSystemTime(clock.nowMs());
  const random = seededRandom(4242);
  const keys = await fixtureKeys();
  const as = new FakeOAuthAs({ clock, random: seededRandom(101) });
  const pds = new FakePds(PDS_HOST, { clock, authorizationServer: as });
  const as2 = o.secondServer ? new FakeOAuthAs({ host: 'as2.test', clock, random: seededRandom(202) }) : null;
  const pds2 = as2 ? new FakePds('pds2.example.test', { clock, authorizationServer: as2 }) : null;
  const plc = new FakePlc();
  const doh = new FakeDoh();
  const pdsList = pds2 ? [pds, pds2] : [pds];

  let secrets = secretsFor(o.signingKids ?? ['k1'], o.announcedKids ?? []);
  const metadata: ClientMetadataDocument = buildClientMetadata({
    publicOrigin: ORIGIN,
    prefix: PREFIX,
    transitionGeneric: false,
  });
  /** What https://music.214510.xyz currently publishes. */
  const published: { metadata: ClientMetadataDocument; keyset: OAuthKeyset } = {
    metadata,
    keyset: await loadOAuthKeyset(secrets),
  };
  const clientApp = (req: Request): Response => {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === OAUTH_METADATA_PATH) return clientMetadataResponse(published.metadata);
    if (req.method === 'GET' && url.pathname === OAUTH_JWKS_PATH) return jwksResponse(published.keyset);
    return new Response('{"error":"not_found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  };

  const hosts: Record<string, (req: Request) => Response | Promise<Response>> = {
    [as.host]: as.fetch,
    [new URL(ORIGIN).host]: clientApp,
  };
  if (as2) hosts[as2.host] = as2.fetch;
  const oauthRouter = routerTransport({ pds: pdsList, plc, doh, hosts });
  const identityRouter = routerTransport({ pds: pdsList, plc, doh });
  as.connect(oauthRouter);
  as2?.connect(oauthRouter);

  const asHosts = new Set([as.host, as2?.host].filter((h): h is string => h !== undefined));
  const captured: CapturedRequest[] = [];
  const oauthTransport: FixtureTransport = Object.assign(
    async (req: Request) => {
      const url = new URL(req.url);
      world.oauthObserver?.(req);
      if (!asHosts.has(url.hostname)) return oauthRouter(req);
      const entry: CapturedRequest = {
        url: req.url,
        path: url.pathname,
        method: req.method,
        headers: new Headers(req.headers),
        body: await req.clone().text(),
        status: 0,
      };
      captured.push(entry);
      const res = await oauthRouter(req);
      entry.status = res.status;
      return res;
    },
    { fixture: true as const, calls: oauthRouter.calls, hostnames: oauthRouter.hostnames },
  );

  const world = {
    clock,
    random,
    keys,
    as,
    as2,
    pds,
    pds2,
    plc,
    doh,
    /** The current handle (tests replace it after reopen()). */
    db,
    published,
    oauthRouter,
    identityRouter,
    oauthTransport,
    captured,
    timer: manualTimer(),
    /** Set to intercept identity-module requests: return a Response promise to answer instead, or null to pass. */
    identityIntercept: null as ((req: Request) => Promise<Response> | null) | null,
    identityCalls: [] as IdentityCall[],
    /** Called with every request the OAuth client sends, before it is routed. */
    oauthObserver: null as ((req: Request) => void) | null,
    logs: [] as LogLine[],
    users: [] as WorldUser[],
    secrets,
    keyset: published.keyset,
    box: null as unknown as Box,
    revocations: new MemoryRevocations(clock),
    identity: null as unknown as IdentityResolver,
    log: null as unknown as Logger,
    advance(ms: number) {
      clock.advance(ms);
      vi.setSystemTime(clock.nowMs());
    },
    /** Change the keyset: a new keyset for the next service, and the published JWKS (the AS refetches it after its 10-minute cache). */
    async setKeys(signingKids: Array<'k1' | 'k2' | 'k3'>, announcedKids: Array<'k1' | 'k2' | 'k3'> = []) {
      secrets = secretsFor(signingKids, announcedKids);
      world.secrets = secrets;
      world.keyset = await loadOAuthKeyset(secrets);
      published.keyset = world.keyset;
      as.clearClientCache();
    },
    service(over: Partial<OAuthServiceDeps> = {}): OAuthService {
      return createOAuthService({
        db: world.db,
        clock,
        random,
        log: world.log,
        identity: world.identity,
        policyFetch: createPolicyFetch({ transport: oauthTransport, timer: world.timer }),
        box: world.box,
        keyset: world.keyset,
        clientMetadata: metadata,
        revocations: world.revocations,
        ...over,
      });
    },
    async addUser(name: string, opts: { server?: 2 } = {}): Promise<WorldUser> {
      const did = didFor(world.users.length + 1);
      const handle = `${name}.test`;
      const server = opts.server === 2 && pds2 ? pds2 : pds;
      const auth = opts.server === 2 && as2 ? as2 : as;
      const repo = new SignedRepo(did, keys.alice, { clock });
      await server.addAccount(repo, { handle, auth: 'dpop' });
      plc.register(did, { signingKey: keys.alice, pds: server.origin, handle });
      doh.setTxt(`_atproto.${handle}`, [`did=${did}`]);
      auth.addAccount(did, { handle });
      const user = { name, did, handle, repo, pds: server };
      world.users.push(user);
      return user;
    },
    /** The browser step: follow the authorization URL at the fake AS and return the callback query. */
    async browse(url: URL): Promise<URLSearchParams> {
      const res = await oauthRouter(new Request(url));
      const location = res.headers.get('location');
      if (res.status !== 303 || location === null) throw new Error(`authorize answered ${res.status}`);
      const back = new URL(location);
      if (`${back.origin}${back.pathname}` !== `${ORIGIN}/oauth/callback`) throw new Error(`redirected to ${location}`);
      return back.searchParams;
    },
    /** A fresh login-binding cookie value and its hash. */
    binding() {
      const cookie = hex(random.bytes(32));
      return { cookie, hash: sha256(cookie) };
    },
    /** Full sign-in through `svc`: authorize with the user's handle, the AS step, then the callback. */
    async signIn(svc: OAuthService, user: WorldUser) {
      const b = world.binding();
      const started = await svc.authorize(user.handle, { bindingHash: b.hash });
      const params = await world.browse(started.url);
      return svc.callback(params, { bindingHash: b.hash });
    },
    /** createRecord through the session's fetchHandler (DPoP, nonce retry, refresh). */
    async writeScrobble(session: OAuthSession, n: number | string) {
      return session.fetchHandler('/xrpc/com.atproto.repo.createRecord', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: session.did,
          collection: SCROBBLE,
          record: { $type: SCROBBLE, artist: 'Artist', track: `Track ${n}`, listenedAt: '2026-01-15T11:00:00.000Z' },
        }),
      });
    },
    seedAccount(did: string, username: string, status: 'active' | 'reauth_required' | 'signed_out' = 'active') {
      world.db.run(
        'INSERT INTO accounts (did, username, oauth_status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)',
        did,
        username,
        status,
        clock.nowMs(),
        clock.nowMs(),
      );
    },
    seedOperation(id: string, did: string, state: string, dueAt = clock.nowMs()) {
      world.db.run(
        `INSERT INTO operations (id, did, kind, origin, priority, collection, rkey, record_json, digest, state, attempts, due_at, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'scrobble.create', 'web', 0, ?, ?, '{}', 'd', ?, 0, ?, ?, ?)`,
        id,
        did,
        SCROBBLE,
        `rk${id}`,
        state,
        dueAt,
        clock.nowMs(),
        clock.nowMs(),
      );
    },
    accountStatus(did: string): string | null {
      return world.db.one<{ s: string }>('SELECT oauth_status AS s FROM accounts WHERE did = ?', did)?.s ?? null;
    },
    operationStates(did: string): string[] {
      return world.db
        .all<{ state: string }>('SELECT state FROM operations WHERE did = ? ORDER BY id', did)
        .map((r) => r.state);
    },
    sessionRows(): Array<{ did: string; client_kid: string; generation: number; last_refresh_ms: number }> {
      return world.db.all('SELECT did, client_kid, generation, last_refresh_ms FROM oauth_sessions ORDER BY did');
    },
    stateRows(): number {
      return world.db.one<{ n: number }>('SELECT count(*) AS n FROM oauth_states')?.n ?? -1;
    },
    /** The decrypted stored session of `did` (null when absent). */
    storedSession(did: string): {
      tokenSet: { access_token: string; refresh_token?: string; sub: string; iss: string };
      dpopJwk: Record<string, string>;
      authMethod: { method: string; kid?: string };
    } | null {
      const row = world.db.one<{ ciphertext: ArrayBuffer }>('SELECT ciphertext FROM oauth_sessions WHERE did = ?', did);
      if (row === null) return null;
      return JSON.parse(world.box.openText('oauth-session', new Uint8Array(row.ciphertext), did));
    },
    /** AS requests to `path` (bodies included), in order. */
    asRequests(path: string): CapturedRequest[] {
      return captured.filter((c) => c.path === path);
    },
    /** Token responses the AS answered with 200 since `from` (an index into as.calls.entries). */
    tokenSuccesses(from = 0): number {
      return as.calls.entries.slice(from).filter((c) => c.path === '/oauth/token' && c.status === 200).length;
    },
  };

  world.box = createBox(secrets.encryptionKeys, random);
  world.log = {
    log(level, event, fields = {}) {
      world.logs.push({ level, event, fields });
    },
  };
  const identityTransport: Transport = Object.assign(
    (req: Request) => world.identityIntercept?.(req) ?? identityRouter(req),
    { fixture: true as const },
  );
  const base = createIdentityResolver({ transport: identityTransport, clock, timer: world.timer });
  world.identity = {
    resolveDid(did, opts) {
      world.identityCalls.push({ did, fresh: opts?.fresh === true });
      return base.resolveDid(did, opts);
    },
    resolveHandle: (handle) => base.resolveHandle(handle),
  };
  return world;
}

export type World = Awaited<ReturnType<typeof createWorld>>;

/** Decode a compact JWS without verifying it. */
export function decodeJws(jws: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = jws.split('.');
  return {
    header: JSON.parse(Buffer.from(h as string, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p as string, 'base64url').toString('utf8')),
  };
}

/** Every byte the database file and its WAL / journal side files hold right now. */
export function rawDbBytes(path: string): Buffer {
  const dir = dirname(path);
  const name = basename(path);
  const files = readdirSync(dir).filter((f) => f === name || f.startsWith(`${name}-`));
  if (!files.includes(name) || !existsSync(path)) throw new Error('database file missing');
  return Buffer.concat(files.sort().map((f) => readFileSync(join(dir, f))));
}

/** Whether `haystack` contains `needle` as UTF-8 text or as raw bytes. */
export function containsBytes(haystack: Buffer, needle: string | Uint8Array): boolean {
  const n = typeof needle === 'string' ? Buffer.from(needle, 'utf8') : Buffer.from(needle);
  return n.length > 0 && haystack.indexOf(n) !== -1;
}

/** Wait (real event-loop turns, no timers) until `cond()` holds. */
export async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 20_000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('the condition never held');
}

export interface Hold {
  reached: boolean;
  release(): void;
}

/**
 * A service whose OAuth transport can hold the next request to an AS path open
 * until the test releases it (fault injection through the injected
 * policyFetch transport only).
 */
export function gatedService(w: World) {
  const holds = new Map<string, Hold & { promise: Promise<void> }>();
  const transport = Object.assign(
    async (req: Request) => {
      const path = new URL(req.url).pathname;
      const h = holds.get(path);
      if (h !== undefined) {
        holds.delete(path);
        h.reached = true;
        await h.promise;
      }
      return w.oauthTransport(req);
    },
    { fixture: true as const, calls: w.oauthTransport.calls, hostnames: w.oauthTransport.hostnames },
  );
  const svc = w.service({ policyFetch: createPolicyFetch({ transport, timer: w.timer }) });
  const hold = (path: string): Hold => {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    const h = { reached: false, release, promise };
    holds.set(path, h);
    return h;
  };
  return { svc, hold };
}
