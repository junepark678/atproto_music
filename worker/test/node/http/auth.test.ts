// N3-01: the auth routes (ADR 0005 §5.3, §5.5–§5.7, §14.5; contract v1.2).
//
// Every test mounts the real auth feature (worker/src/http/auth.ts and
// http/oauth-docs.ts over bff/*) in the real Node composition through
// test/node/support/app.ts, and drives it over HTTP against local fakes only:
// the fake OAuth AS (as.test), a fake PDS whose accounts take DPoP tokens, the
// fake PLC directory and the fake DoH resolver, all behind one router
// transport. The fake AS fetches our client metadata and JWKS from the running
// app itself (music.example.test routes back into it), so every
// private_key_jwt assertion is verified against what /oauth/jwks.json serves.
// Faults are injected only in front of that transport. The clock is frozen at
// 2026-01-15T12:00:00Z (fixedClock, and Date for the OAuth library's iat).
// Assertions are on HTTP status, headers and bodies (checked against
// api/openapi.yaml), the database rows, the revocation journal and the fakes'
// call logs and revocations.

import { createHmac } from 'node:crypto';
import { FakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { FakeOAuthAs } from '@atmusic/atproto/test-support/fake-oauth-as';
import { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import { FakePlc } from '@atmusic/atproto/test-support/fake-plc';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import { buildClientMetadata } from '../../../src/bff/client-metadata';
import type { SignInPolicy } from '../../../src/bff/reconcile';
import { createAppPassword, revokeAppPassword } from '../../../src/credentials/app-passwords';
import { createLastfmApp } from '../../../src/credentials/lastfm-apps';
import { createAuthorizedToken, createSession } from '../../../src/credentials/lastfm-auth';
import { createLbToken } from '../../../src/credentials/lb-tokens';
import { createBox } from '../../../src/crypto/box';
import { hashTokenHex } from '../../../src/crypto/tokens';
import type { Db } from '../../../src/do/db';
import { authFeature } from '../../../src/http/auth';
import type { Feature } from '../../../src/node/compose';
import type { Secrets } from '../../../src/node/secrets';
import type { SqliteDb } from '../../../src/node/sqlite-db';
import { sessionWriter } from '../../../src/outbox/pds-writer';
import { outboxExtension } from '../../../src/outbox/runner';
import { enqueueScrobbleCreates } from '../../../src/outbox/scrobble-ops';
import { checkResponse } from '../../acceptance/support/openapi';
import {
  closeApps,
  startApp,
  TEST_PUBLIC_ORIGIN,
  TEST_SIGNIN_DID,
  type TestApp,
  testJwk,
  testSecrets,
} from '../support/app';

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const PDS_HOST = 'pds.example.test';
const APP_HOST = new URL(TEST_PUBLIC_ORIGIN).host;
const ALICE = TEST_SIGNIN_DID;
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const SCROBBLE = `${FIXTURE_PREFIX}.scrobble`;
const BINDING_COOKIE = '__Host-atmusic_oauth';
const SESSION_COOKIE = '__Host-atmusic_session';
const CLEAR_BINDING = `${BINDING_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
const CLEAR_SESSION = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
const BINDING_SET = /^__Host-atmusic_oauth=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/;
const SESSION_SET = /^__Host-atmusic_session=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await closeApps();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The world

interface User {
  did: string;
  handle: string;
  repo: SignedRepo;
}

interface WorldOptions {
  /** The sign-in policy object the feature reads (mutable by the test); default the configuration's. */
  signIn?: SignInPolicy;
  /** Mount the outbox extension with writers over the feature's OAuth service. */
  outbox?: boolean;
  /** Wraps the database compose gets (to record writes). */
  wrapDb?: (db: SqliteDb) => Db;
}

interface Body {
  status: number;
  headers: Headers;
  body: unknown;
  cookies: string[];
}

async function read(res: Response): Promise<Body> {
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  return {
    status: res.status,
    headers: res.headers,
    body: text !== '' && type.startsWith('application/json') ? JSON.parse(text) : text,
    cookies: res.headers.getSetCookie(),
  };
}

/** The value a Set-Cookie list installs for `name` (non-empty), or null. */
function cookieValue(cookies: readonly string[], name: string): string | null {
  for (const c of cookies) {
    const m = new RegExp(`^${name}=([^;]*);`).exec(c);
    if (m !== null && m[1] !== '') return m[1] as string;
  }
  return null;
}

function contract(method: string, path: string, r: Body): string {
  return checkResponse(method, path, { status: r.status, headers: r.headers, body: r.body });
}

async function world(o: WorldOptions = {}) {
  const clock: FixedClock = fixedClock();
  const keys = await fixtureKeys();
  const as = new FakeOAuthAs({ clock, random: seededRandom(101) });
  const pds = new FakePds(PDS_HOST, { clock, authorizationServer: as });
  const plc = new FakePlc();
  const doh = new FakeDoh();
  const revocations = new MemoryRevocations(clock);
  const secrets: Secrets = testSecrets();

  let app: TestApp | null = null;
  /** The fake AS fetches our documents from the running app. */
  const self = async (req: Request): Promise<Response> => {
    if (app === null) throw new Error('the app is not running yet');
    const url = new URL(req.url);
    return app.fetch(`${url.pathname}${url.search}`, { method: req.method });
  };
  const router = routerTransport({ pds: [pds], plc, doh, hosts: { [as.host]: as.fetch, [APP_HOST]: self } });
  as.connect(router);
  const state = {
    /** Answer a request instead of the router (a Response promise), or null to pass it on. */
    intercept: null as ((req: Request) => Promise<Response> | null) | null,
  };
  const transport: FixtureTransport = Object.assign((req: Request) => state.intercept?.(req) ?? router(req), {
    fixture: true as const,
    calls: router.calls,
    hostnames: router.hostnames,
  });

  const auth = await authFeature(secrets, {
    revocations,
    ...(o.signIn === undefined ? {} : { signIn: o.signIn }),
  });
  const features: Feature[] = [auth];
  if (o.outbox === true) {
    features.push({
      name: 'outbox',
      extensions: [
        outboxExtension({
          writers: {
            writerFor: async (did) => {
              if (app === null) return null;
              return sessionWriter(await app.composed.app.auth.oauth.restore(did));
            },
          },
        }),
      ],
    });
  }
  app = await startApp({
    features,
    transport,
    clock,
    secrets,
    random: seededRandom(0x5eed),
    ...(o.wrapDb === undefined ? {} : { wrapDb: o.wrapDb }),
  });
  const running: TestApp = app;
  const db = running.db;

  const w = {
    app: running,
    db,
    clock,
    as,
    pds,
    plc,
    revocations,
    secrets,
    state,
    /** Every request the router answered (the fakes and the AS's fetches of our documents). */
    calls: router.calls,
    advance(ms: number) {
      clock.advance(ms);
      vi.setSystemTime(clock.nowMs());
    },
    async addUser(did: string, name: string): Promise<User> {
      const handle = `${name}.test`;
      const repo = new SignedRepo(did, keys.alice, { clock });
      await pds.addAccount(repo, { handle, auth: 'dpop' });
      plc.register(did, { signingKey: keys.alice, pds: pds.origin, handle });
      doh.setTxt(`_atproto.${handle}`, [`did=${did}`]);
      as.addAccount(did, { handle });
      return { did, handle, repo };
    },
    start(body: unknown, headers: Record<string, string> | Array<[string, string]> = { origin: TEST_PUBLIC_ORIGIN }) {
      const h = new Headers(headers);
      h.set('content-type', 'application/json');
      return running.fetch('/api/v1/auth/start', { method: 'POST', headers: h, body: JSON.stringify(body) });
    },
    /** POST auth/start for `handle`: the authorize URL and the login-binding cookie value. */
    async begin(handle: string): Promise<{ authorizeUrl: string; binding: string }> {
      const r = await read(await w.start({ handle }));
      if (r.status !== 200) throw new Error(`auth/start answered ${r.status}: ${JSON.stringify(r.body)}`);
      const binding = cookieValue(r.cookies, BINDING_COOKIE);
      if (binding === null) throw new Error('auth/start set no login-binding cookie');
      return { authorizeUrl: (r.body as { authorizeUrl: string }).authorizeUrl, binding };
    },
    /** The browser at the fake AS: the callback path and query it is redirected to. */
    async browse(authorizeUrl: string): Promise<string> {
      const res = await router(new Request(authorizeUrl));
      const location = res.headers.get('location');
      if (res.status !== 303 || location === null) throw new Error(`authorize answered ${res.status}`);
      const back = new URL(location);
      if (`${back.origin}${back.pathname}` !== `${TEST_PUBLIC_ORIGIN}/oauth/callback`) {
        throw new Error(`redirected to ${back.origin}${back.pathname}`);
      }
      return `${back.pathname}${back.search}`;
    },
    callback(path: string, binding: string | null) {
      return running.fetch(path, binding === null ? {} : { headers: { cookie: `${BINDING_COOKIE}=${binding}` } });
    },
    /** A full sign-in through the routes; returns the session cookie value. */
    async signIn(user: User): Promise<string> {
      const { authorizeUrl, binding } = await w.begin(user.handle);
      const r = await read(await w.callback(await w.browse(authorizeUrl), binding));
      if (r.status !== 303) throw new Error(`callback answered ${r.status}: ${JSON.stringify(r.body)}`);
      const token = cookieValue(r.cookies, SESSION_COOKIE);
      if (token === null) throw new Error('the callback set no session cookie');
      return token;
    },
    sessionGet(token: string | null) {
      return running.fetch(
        '/api/v1/auth/session',
        token === null ? {} : { headers: { cookie: `${SESSION_COOKIE}=${token}` } },
      );
    },
    async csrf(token: string): Promise<string> {
      const r = await read(await w.sessionGet(token));
      return (r.body as { csrfToken: string }).csrfToken;
    },
    count(table: string, where = '1 = 1', ...params: string[]): number {
      return db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...params)?.n ?? -1;
    },
    accountStatus(did: string): string | null {
      return db.one<{ s: string }>('SELECT oauth_status AS s FROM accounts WHERE did = ?', did)?.s ?? null;
    },
    tokenSuccesses(): number {
      return as.calls.entries.filter((c) => c.path === '/oauth/token' && c.status === 200).length;
    },
  };
  return w;
}

type World = Awaited<ReturnType<typeof world>>;

/** Rows that hold a sign-in: OAuth sessions, web sessions, accounts. */
/** PAR requests the fake AS accepted (a DPoP nonce retry sends a second, refused one). */
function parsAccepted(w: World): number {
  return w.as.calls.entries.filter((c) => c.path === '/oauth/par' && c.status >= 200 && c.status < 300).length;
}

function signInRows(w: World): { oauth: number; web: number; accounts: number } {
  return { oauth: w.count('oauth_sessions'), web: w.count('web_sessions'), accounts: w.count('accounts') };
}

// ---------------------------------------------------------------------------

describe('the auth routes', () => {
  it('POST /api/v1/auth/start {handle} returns an authorizeUrl at the fake AS; a malformed handle is 422 fields.handle; the 11th request in a minute from one IP is 429', async () => {
    const w = await world();
    const alice = await w.addUser(ALICE, 'alice');

    const ok = await read(await w.start({ handle: alice.handle }));
    expect(ok.status).toBe(200);
    expect(contract('POST', '/api/v1/auth/start', ok)).toBe('valid');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const url = new URL((ok.body as { authorizeUrl: string }).authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://as.test/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(`${TEST_PUBLIC_ORIGIN}/oauth/client-metadata.json`);
    expect(url.searchParams.get('request_uri')).toMatch(/^urn:ietf:params:oauth:request_uri:/);
    expect(parsAccepted(w)).toBe(1);
    expect(w.count('oauth_states')).toBe(1);

    for (const handle of ['not a handle', 'alice', 'alice.example', '']) {
      const bad = await read(await w.start({ handle }));
      expect(bad.status).toBe(422);
      expect(contract('POST', '/api/v1/auth/start', bad)).toBe('valid');
      expect(bad.body).toMatchObject({
        error: { code: 'validation_failed', fields: { handle: 'Expected a handle.' } },
      });
      expect(bad.cookies).toEqual([]);
    }
    const extra = await read(await w.start({ handle: alice.handle, returnTo: '/x' }));
    expect(extra.status).toBe(422);
    expect(extra.body).toMatchObject({ error: { fields: { handle: 'Expected a handle.' } } });
    // Malformed input never reached the AS and stored no state.
    expect(parsAccepted(w)).toBe(1);
    expect(w.count('oauth_states')).toBe(1);

    // Requests 7-10 are admitted; the 11th in the same minute from the same IP is refused.
    for (let i = 7; i <= 10; i++) expect((await w.start({ handle: alice.handle })).status).toBe(200);
    expect(w.count('oauth_states')).toBe(5);
    const limited = await read(await w.start({ handle: alice.handle }));
    expect(limited.status).toBe(429);
    expect(contract('POST', '/api/v1/auth/start', limited)).toBe('valid');
    expect(limited.body).toMatchObject({ error: { code: 'rate_limited' } });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(limited.cookies).toEqual([]);
    expect(w.count('oauth_states')).toBe(5);
    expect(parsAccepted(w)).toBe(5);

    // The bucket refills: six seconds later one request is admitted again.
    w.advance(6_000);
    expect((await w.start({ handle: alice.handle })).status).toBe(200);
  });

  it('GET /oauth/callback sets the session cookie, creates the account and 303s to /; error=access_denied 303s to /signin?error=denied with no cookie', async () => {
    const w = await world();
    const alice = await w.addUser(ALICE, 'alice');

    const { authorizeUrl, binding } = await w.begin(alice.handle);
    const res = await read(await w.callback(await w.browse(authorizeUrl), binding));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.cookies).toHaveLength(2);
    expect(res.cookies).toContain(CLEAR_BINDING);
    const sessionSet = res.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';
    expect(sessionSet).toMatch(SESSION_SET);
    const token = cookieValue(res.cookies, SESSION_COOKIE) as string;

    // The account, the web session (hash only) and the sealed OAuth session exist.
    expect(w.db.all('SELECT did, username, oauth_status FROM accounts')).toEqual([
      { did: ALICE, username: 'alice.test', oauth_status: 'active' },
    ]);
    const web = w.db.all<{ did: string; h: string }>('SELECT did, hex(token_hash) AS h FROM web_sessions');
    expect(web).toEqual([{ did: ALICE, h: hashTokenHex(token).toUpperCase() }]);
    expect(w.db.all('SELECT did, client_kid FROM oauth_sessions')).toEqual([{ did: ALICE, client_kid: 'k1' }]);
    expect(w.count('oauth_states')).toBe(0);
    expect(w.as.sessions(ALICE).filter((s) => s.revoked === null)).toHaveLength(1);

    // The AS reports access_denied: 303 to the sign-in page, the binding cleared, nothing stored.
    const before = signInRows(w);
    w.as.nextAuthorize({ error: 'access_denied' });
    const second = await w.begin(alice.handle);
    const back = await w.browse(second.authorizeUrl);
    expect(new URLSearchParams(back.split('?')[1]).get('error')).toBe('access_denied');
    const denied = await read(await w.callback(back, second.binding));
    expect(denied.status).toBe(303);
    expect(denied.headers.get('location')).toBe('/signin?error=denied');
    expect(denied.cookies).toEqual([CLEAR_BINDING]);
    expect(signInRows(w)).toEqual(before);
    expect(w.count('oauth_states')).toBe(0);
    expect(w.tokenSuccesses()).toBe(1);
  });

  it('GET /api/v1/auth/session returns did, handle, username, csrfToken and status, or 401 without a cookie', async () => {
    const w = await world();
    const alice = await w.addUser(ALICE, 'alice');

    const anonymous = await read(await w.sessionGet(null));
    expect(anonymous.status).toBe(401);
    expect(contract('GET', '/api/v1/auth/session', anonymous)).toBe('valid');
    expect(anonymous.body).toMatchObject({ error: { code: 'unauthenticated', message: 'No valid session cookie.' } });
    const unknown = await read(await w.sessionGet('ab'.repeat(32)));
    expect(unknown.status).toBe(401);

    const token = await w.signIn(alice);
    const r = await read(await w.sessionGet(token));
    expect(r.status).toBe(200);
    expect(contract('GET', '/api/v1/auth/session', r)).toBe('valid');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.cookies).toEqual([]); // not due for renewal yet
    const csrfKey = createBox(w.secrets.encryptionKeys, seededRandom(1)).csrfKey();
    const expected = createHmac('sha256', csrfKey).update('atmusic.csrf.v1\0').update(token).digest('hex');
    expect(r.body).toEqual({
      did: ALICE,
      handle: 'alice.test',
      username: 'alice.test',
      csrfToken: expected,
      status: 'active',
      expiresAt: '2026-02-14T12:00:00.000000000Z',
    });

    // A DID whose OAuth session needs a new sign-in reports reauth_required.
    w.db.run("UPDATE accounts SET oauth_status = 'reauth_required' WHERE did = ?", ALICE);
    const reauth = await read(await w.sessionGet(token));
    expect(reauth.status).toBe(200);
    expect(contract('GET', '/api/v1/auth/session', reauth)).toBe('valid');
    expect((reauth.body as { status: string }).status).toBe('reauth_required');
  });

  it('POST /api/v1/auth/logout requires CSRF, clears the cookie, deletes the session and revokes upstream when no protocol credential remains', async () => {
    const w = await world();
    const alice = await w.addUser(ALICE, 'alice');
    const deps = { db: w.db, clock: w.clock, random: seededRandom(7), revocations: w.revocations };

    // 1. With an app password, logout keeps the OAuth session (the scrobbler still needs it).
    const first = await w.signIn(alice);
    const password = createAppPassword(deps, { did: ALICE, label: 'phone' });
    const cookie = `${SESSION_COOKIE}=${first}`;
    const csrf = await w.csrf(first);
    const noCsrf = await read(
      await w.app.fetch('/api/v1/auth/logout', { method: 'POST', headers: { cookie, origin: TEST_PUBLIC_ORIGIN } }),
    );
    expect(noCsrf.status).toBe(403);
    expect(contract('POST', '/api/v1/auth/logout', noCsrf)).toBe('valid');
    expect(noCsrf.body).toMatchObject({ error: { code: 'csrf_failed' } });
    const foreign = await read(
      await w.app.fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': csrf },
      }),
    );
    expect(foreign.status).toBe(403);
    expect(w.count('web_sessions')).toBe(1);
    expect(w.revocations.entries()).toEqual([]);

    const kept = await read(
      await w.app.fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { cookie, origin: TEST_PUBLIC_ORIGIN, 'x-csrf-token': csrf },
      }),
    );
    expect(kept.status).toBe(204);
    expect(kept.body).toBe('');
    expect(kept.cookies).toEqual([CLEAR_SESSION]);
    expect(w.count('web_sessions')).toBe(0);
    expect(w.revocations.entries().map((e) => e.kind)).toEqual(['web_session']);
    expect(w.revocations.entries()[0]).toMatchObject({ kind: 'web_session', hash: hashTokenHex(first), did: ALICE });
    expect(w.as.revocations).toEqual([]);
    expect(w.count('oauth_sessions')).toBe(1);
    expect(w.accountStatus(ALICE)).toBe('active');
    expect((await w.sessionGet(first)).status).toBe(401);

    // 2. Without a protocol credential, logout also revokes the OAuth session upstream.
    expect(revokeAppPassword(deps, ALICE, password.id)).toBe(true);
    const second = await w.signIn(alice);
    const revokedBefore = w.as.revocations.length; // the re-sign-in replaced the previous AS session
    const current = w.as.sessions(ALICE).find((s) => s.revoked === null);
    const out = await read(
      await w.app.fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE}=${second}`,
          origin: TEST_PUBLIC_ORIGIN,
          'x-csrf-token': await w.csrf(second),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ everywhere: true }),
      }),
    );
    expect(out.status).toBe(204);
    expect(out.cookies).toEqual([CLEAR_SESSION]);
    expect(w.count('web_sessions')).toBe(0);
    expect(w.count('oauth_sessions')).toBe(0);
    expect(w.accountStatus(ALICE)).toBe('signed_out');
    const upstream = w.as.revocations.slice(revokedBefore);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]).toMatchObject({ source: 'endpoint', sub: ALICE, sessionId: current?.id, known: true });
    expect(w.as.sessions(ALICE).every((s) => s.revoked !== null)).toBe(true);
    expect(
      w.revocations
        .entries()
        .slice(-2)
        .map((e) => e.kind),
    ).toEqual(['web_session', 'oauth_session']);
  });

  it('GET /oauth/client-metadata.json and /oauth/jwks.json answer with Cache-Control max-age=300 and no Set-Cookie', async () => {
    const w = await world();
    const alice = await w.addUser(ALICE, 'alice');
    const token = await w.signIn(alice);
    const cookie = `${SESSION_COOKIE}=${token}; ${BINDING_COOKIE}=${'cd'.repeat(32)}`;

    const variants: Array<Record<string, string>> = [{}, { cookie }];
    for (const headers of variants) {
      const meta = await read(await w.app.fetch('/oauth/client-metadata.json', { headers }));
      expect(meta.status).toBe(200);
      expect(contract('GET', '/oauth/client-metadata.json', meta)).toBe('valid');
      expect(meta.headers.get('cache-control')).toBe('public, max-age=300');
      expect(meta.cookies).toEqual([]);
      expect(meta.body).toEqual(
        buildClientMetadata({ publicOrigin: TEST_PUBLIC_ORIGIN, prefix: FIXTURE_PREFIX, transitionGeneric: false }),
      );
      expect((meta.body as { scope: string }).scope).toBe(
        `atproto repo:${FIXTURE_PREFIX}.scrobble repo:${FIXTURE_PREFIX}.follow repo:${FIXTURE_PREFIX}.settings repo:${FIXTURE_PREFIX}.love`,
      );

      const jwks = await read(await w.app.fetch('/oauth/jwks.json', { headers }));
      expect(jwks.status).toBe(200);
      expect(contract('GET', '/oauth/jwks.json', jwks)).toBe('valid');
      expect(jwks.headers.get('cache-control')).toBe('public, max-age=300');
      expect(jwks.cookies).toEqual([]);
      const k1 = testJwk('k1', 'atmusic test signing key one');
      expect(jwks.body).toEqual({
        keys: [{ kty: 'EC', crv: 'P-256', x: k1.x, y: k1.y, kid: 'k1', alg: 'ES256', use: 'sig' }],
      });
      expect(JSON.stringify(jwks.body)).not.toContain(k1.d);
    }
    // HEAD: the same headers, no body, still no cookie.
    const head = await w.app.fetch('/oauth/jwks.json', { method: 'HEAD', headers: { cookie } });
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('public, max-age=300');
    expect(head.headers.getSetCookie()).toEqual([]);
    expect(await head.text()).toBe('');
    // The fake AS fetched both documents from these routes and verified our assertion with them.
    expect(w.calls.count({ host: APP_HOST, path: '/oauth/client-metadata.json', status: 200 })).toBeGreaterThanOrEqual(
      1,
    );
    expect(w.calls.count({ host: APP_HOST, path: '/oauth/jwks.json', status: 200 })).toBeGreaterThanOrEqual(1);
    expect(w.tokenSuccesses()).toBe(1);
  });

  it('POST /api/v1/auth/start with a foreign or duplicate Origin is 403 csrf_failed and stores no state; a valid start sets __Host-atmusic_oauth with HttpOnly, Secure, SameSite=Lax, Path=/ and Max-Age=600', async () => {
    const w = await world();
    const alice = await w.addUser(ALICE, 'alice');
    const refusals: Array<Record<string, string> | Array<[string, string]>> = [
      { origin: 'https://evil.example' },
      { origin: 'http://music.example.test' },
      { origin: 'https://music.example.test:8443' },
      { origin: 'null' },
      {},
      [
        ['origin', TEST_PUBLIC_ORIGIN],
        ['origin', TEST_PUBLIC_ORIGIN],
      ],
      { origin: `${TEST_PUBLIC_ORIGIN}, ${TEST_PUBLIC_ORIGIN}` },
    ];
    for (const headers of refusals) {
      const r = await read(await w.start({ handle: alice.handle }, headers));
      expect(r.status).toBe(403);
      expect(contract('POST', '/api/v1/auth/start', r)).toBe('valid');
      expect(r.body).toMatchObject({ error: { code: 'csrf_failed', message: 'Origin or X-CSRF-Token check failed.' } });
      expect(r.cookies).toEqual([]);
    }
    expect(w.count('oauth_states')).toBe(0);
    expect(w.as.count('/oauth/par')).toBe(0);
    expect(w.count('identity_cache')).toBe(0);

    const ok = await read(await w.start({ handle: alice.handle }));
    expect(ok.status).toBe(200);
    expect(ok.cookies).toHaveLength(1);
    expect(ok.cookies[0]).toMatch(BINDING_SET);
    // The state is bound to SHA-256 of exactly that cookie value.
    const binding = cookieValue(ok.cookies, BINDING_COOKIE) as string;
    expect(w.db.all('SELECT hex(session_binding) AS b FROM oauth_states')).toEqual([
      { b: hashTokenHex(binding).toUpperCase() },
    ]);
  });

  it('a callback URL replayed from another cookie jar, or sent without __Host-atmusic_oauth, is 403 oauth_binding_mismatch, stores no session and sets no session cookie', async () => {
    const w = await world();
    const alice = await w.addUser(ALICE, 'alice');

    // The attacker's flow, its callback URL delivered to a victim whose jar holds its own binding.
    const attacker = await w.begin(alice.handle);
    const victim = await w.begin(alice.handle);
    const attackerCallback = await w.browse(attacker.authorizeUrl);
    for (const [path, binding] of [
      [attackerCallback, victim.binding],
      [await w.browse(victim.authorizeUrl), null],
    ] as const) {
      const r = await read(await w.callback(path, binding));
      expect(r.status).toBe(403);
      expect(contract('GET', '/oauth/callback', r)).toBe('valid');
      expect(r.body).toMatchObject({
        error: {
          code: 'oauth_binding_mismatch',
          message: 'The sign-in could not be bound to this browser or identity.',
        },
      });
      expect(r.cookies).toEqual([CLEAR_BINDING]);
    }
    // A malformed or repeated binding cookie counts as none.
    const third = await w.begin(alice.handle);
    const thirdPath = await w.browse(third.authorizeUrl);
    const repeated = await read(
      await w.app.fetch(thirdPath, {
        headers: { cookie: `${BINDING_COOKIE}=${third.binding}; ${BINDING_COOKIE}=${third.binding}` },
      }),
    );
    expect(repeated.status).toBe(403);
    expect(repeated.cookies).toEqual([CLEAR_BINDING]);

    // Nothing was exchanged or stored, and each state is consumed: the right cookie cannot finish it now.
    expect(w.tokenSuccesses()).toBe(0);
    expect(signInRows(w)).toEqual({ oauth: 0, web: 0, accounts: 0 });
    expect(w.count('oauth_states')).toBe(0);
    const late = await read(await w.callback(attackerCallback, attacker.binding));
    expect(late.status).toBe(403);
    expect(signInRows(w)).toEqual({ oauth: 0, web: 0, accounts: 0 });
  });

  it('a callback with a replayed, expired or unknown state, or an AS error, stores no session, sets no session cookie and clears __Host-atmusic_oauth', async () => {
    const w = await world();
    const alice = await w.addUser(ALICE, 'alice');

    // Replayed: the callback URL of a completed sign-in, sent again with the same cookie.
    const done = await w.begin(alice.handle);
    const donePath = await w.browse(done.authorizeUrl);
    expect((await w.callback(donePath, done.binding)).status).toBe(303);
    const afterFirst = { rows: signInRows(w), tokens: w.tokenSuccesses(), as: w.as.sessions(ALICE).length };
    expect(afterFirst.rows).toEqual({ oauth: 1, web: 1, accounts: 1 });

    const expired = await w.begin(alice.handle);
    const expiredPath = await w.browse(expired.authorizeUrl);
    w.advance(600_001);
    const cases: Array<[string, string, string | null]> = [
      ['replayed', donePath, done.binding],
      ['expired', expiredPath, expired.binding],
      [
        'unknown',
        `/oauth/callback?state=${'x'.repeat(22)}&code=c&iss=${encodeURIComponent('https://as.test')}`,
        done.binding,
      ],
    ];
    for (const [, path, binding] of cases) {
      const r = await read(await w.callback(path, binding));
      expect(r.status).toBe(403);
      expect(contract('GET', '/oauth/callback', r)).toBe('valid');
      expect(r.body).toMatchObject({ error: { code: 'oauth_binding_mismatch' } });
      expect(r.cookies).toEqual([CLEAR_BINDING]);
    }
    // An AS error.
    w.as.nextAuthorize({ error: 'access_denied' });
    const refused = await w.begin(alice.handle);
    const r = await read(await w.callback(await w.browse(refused.authorizeUrl), refused.binding));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/signin?error=denied');
    expect(r.cookies).toEqual([CLEAR_BINDING]);

    // Nothing beyond the first sign-in was exchanged or stored.
    expect(signInRows(w)).toEqual(afterFirst.rows);
    expect(w.tokenSuccesses()).toBe(afterFirst.tokens);
    expect(w.as.sessions(ALICE)).toHaveLength(afterFirst.as);
    expect(w.count('oauth_states')).toBe(0);
  });

  it('under the allowlist policy a DID outside ATMUSIC_SIGNIN_DIDS is 403 signin_not_allowed at start and at the callback, its OAuth session is revoked and nothing is stored', async () => {
    const policy: { signinPolicy: 'allowlist'; signinDids: string[] } = {
      signinPolicy: 'allowlist',
      signinDids: [ALICE],
    };
    const w = await world({ signIn: policy });
    expect(w.app.config.signinPolicy).toBe('allowlist');
    expect(w.app.config.signinDids).toEqual([ALICE]);
    await w.addUser(ALICE, 'alice');
    const bob = await w.addUser(BOB, 'bob');

    // At start: the handle resolves to a refused DID; nothing reaches the AS.
    const atStart = await read(await w.start({ handle: bob.handle }));
    expect(atStart.status).toBe(403);
    expect(contract('POST', '/api/v1/auth/start', atStart)).toBe('valid');
    expect(atStart.body).toMatchObject({
      error: { code: 'signin_not_allowed', message: 'This account may not sign in here.' },
    });
    expect(atStart.cookies).toEqual([]);
    expect(w.count('oauth_states')).toBe(0);
    expect(w.as.count('/oauth/par')).toBe(0);

    // At the callback: the DID was allowed when sign-in started and is refused when it completes.
    policy.signinDids = [ALICE, BOB];
    const { authorizeUrl, binding } = await w.begin(bob.handle);
    const back = await w.browse(authorizeUrl);
    policy.signinDids = [ALICE];
    const atCallback = await read(await w.callback(back, binding));
    expect(atCallback.status).toBe(403);
    expect(contract('GET', '/oauth/callback', atCallback)).toBe('valid');
    expect(atCallback.body).toMatchObject({ error: { code: 'signin_not_allowed' } });
    expect(atCallback.cookies).toEqual([CLEAR_BINDING]);
    // The code was exchanged, and the new session revoked at the AS and deleted here.
    expect(w.tokenSuccesses()).toBe(1);
    const bobAs = w.as.sessions(BOB);
    expect(bobAs).toHaveLength(1);
    expect(bobAs[0]?.revoked?.source).toBe('endpoint');
    expect(w.as.revocations).toMatchObject([{ source: 'endpoint', sub: BOB, sessionId: bobAs[0]?.id }]);
    // Nothing is stored for the DID: no session, account, web session, users row or snapshot job.
    expect(signInRows(w)).toEqual({ oauth: 0, web: 0, accounts: 0 });
    expect(w.count('users', 'did = ?', BOB)).toBe(0);
    expect(w.count('repo_jobs', 'did = ?', BOB)).toBe(0);
    expect(w.count('oauth_states')).toBe(0);
  });

  it('a first sign-in of a DID with zero records admits it for indexing and its snapshot sets indexing_state current', async () => {
    const w = await world();
    const alice = await w.addUser(ALICE, 'alice');
    expect(await alice.repo.list(SCROBBLE)).toEqual([]);
    expect(w.count('users')).toBe(0);

    await w.signIn(alice);
    // Admitted at sign-in: an inactive users row and a pending snapshot job, from the notify source.
    expect(w.db.all('SELECT did, active, indexing_state FROM users')).toEqual([
      { did: ALICE, active: 0, indexing_state: 'recovering' },
    ]);
    expect(w.db.all("SELECT did, state, reason FROM repo_jobs WHERE kind = 'snapshot'")).toEqual([
      { did: ALICE, state: 'pending', reason: 'admission' },
    ]);
    expect(w.db.one("SELECT value FROM counters WHERE name = 'admitted' AND label = 'notify'")).toEqual({ value: 1 });

    // The sign-in armed the snapshot timer (SNAPSHOT_MIN_INTERVAL_MS from now); the core lane runs it
    // against the fake PDS.
    expect(w.db.one("SELECT due_at FROM timers WHERE name = 'snapshot'")).toEqual({ due_at: T0 + 1_000 });
    w.advance(1_000);
    for (let i = 0; i < 20; i++) {
      const row = w.db.one<{ s: string }>('SELECT indexing_state AS s FROM users WHERE did = ?', ALICE);
      if (row?.s === 'current') break;
      await w.app.composed.core.runAlarmNow();
    }
    expect(w.db.one('SELECT active, indexing_state, last_snapshot_at_ms FROM users WHERE did = ?', ALICE)).toEqual({
      active: 1,
      indexing_state: 'current',
      last_snapshot_at_ms: T0 + 1_000,
    });
    expect(w.count('scrobbles', 'did = ?', ALICE)).toBe(0);
    expect(w.pds.count('com.atproto.sync.getLatestCommit', ALICE)).toBeGreaterThanOrEqual(1);
    // Signing in again does not admit the DID a second time.
    await w.signIn(alice);
    expect(w.db.one("SELECT value FROM counters WHERE name = 'admitted' AND label = 'notify'")).toEqual({ value: 1 });
  });

  it('DELETE /api/v1/account/connection without CSRF is 403; with it the fake AS records a revocation, every web session, credential and link of the DID is gone and journaled, its queued operations are cancelled, the account is signed_out and the cookie is cleared', async () => {
    const w = await world();
    const alice = await w.addUser(ALICE, 'alice');
    const random = seededRandom(9);
    const deps = { db: w.db, clock: w.clock, random, revocations: w.revocations };

    const first = await w.signIn(alice);
    const token = await w.signIn(alice); // a second browser: two web sessions
    const password = createAppPassword(deps, { did: ALICE, label: 'phone' });
    const lb = createLbToken(deps, { did: ALICE, label: 'navidrome' });
    const issued = createLastfmApp(
      { ...deps, box: createBox(w.secrets.encryptionKeys, random) },
      { did: ALICE, name: 'Mine' },
    );
    const lfm = createSession(deps, { did: ALICE, apiKey: issued.apiKey, clientName: 'Pano' });
    expect(createAuthorizedToken(deps, { did: ALICE, apiKey: issued.apiKey }).ok).toBe(true);
    w.db.run(
      `INSERT INTO linked_accounts (id, did, service, remote_user, credential_ciphertext, key_id, created_at_ms, updated_at_ms)
       VALUES ('link-1', ?, 'lastfm', 'alice_fm', x'00', 'e1', ?, ?)`,
      ALICE,
      T0,
      T0,
    );
    w.db.run(
      `INSERT INTO forward_outbox (id, link_id, did, kind, dedupe_key, payload_json, due_at, created_at_ms, updated_at_ms)
       VALUES ('fw-1', 'link-1', ?, 'scrobble', 'k-1', '{}', ?, ?, ?)`,
      ALICE,
      T0,
      T0,
      T0,
    );
    const m = { ...w.app.composed.core.deps };
    const queued = await enqueueScrobbleCreates(m, {
      did: ALICE,
      origin: 'web',
      inputs: [
        { artist: 'A', track: 'One', listenedAt: '2026-01-15T11:00:00Z' },
        { artist: 'A', track: 'Two', listenedAt: '2026-01-15T11:01:00Z' },
        { artist: 'A', track: 'Sent', listenedAt: '2026-01-15T11:02:00Z' },
      ],
    });
    if (!queued.ok) throw new Error('enqueue failed');
    const [one, two, sent] = queued.operations.map((o) => o.id) as [string, string, string];
    // `sent` has been attempted once already: it may exist on the PDS, so it is not cancelled.
    w.db.run("UPDATE operations SET attempts = 1, state = 'queued' WHERE id = ?", sent);
    const journalBefore = w.revocations.entries().length;
    const asBefore = w.as.revocations.length;
    const current = w.as.sessions(ALICE).find((s) => s.revoked === null);
    const cookie = `${SESSION_COOKIE}=${token}`;

    const refusals: Array<Record<string, string>> = [
      { cookie },
      { cookie, origin: TEST_PUBLIC_ORIGIN },
      { cookie, origin: TEST_PUBLIC_ORIGIN, 'x-csrf-token': '00'.repeat(32) },
    ];
    for (const headers of refusals) {
      const refused = await read(await w.app.fetch('/api/v1/account/connection', { method: 'DELETE', headers }));
      expect(refused.status).toBe(403);
      expect(contract('DELETE', '/api/v1/account/connection', refused)).toBe('valid');
      expect(refused.body).toMatchObject({ error: { code: 'csrf_failed' } });
      expect(refused.cookies).toEqual([]);
    }
    expect(w.count('web_sessions')).toBe(2);
    expect(w.count('app_passwords')).toBe(1);
    expect(w.as.revocations).toHaveLength(asBefore);
    expect(w.revocations.entries()).toHaveLength(journalBefore);
    const unauth = await read(await w.app.fetch('/api/v1/account/connection', { method: 'DELETE' }));
    expect(unauth.status).toBe(401);

    const res = await read(
      await w.app.fetch('/api/v1/account/connection', {
        method: 'DELETE',
        headers: { cookie, origin: TEST_PUBLIC_ORIGIN, 'x-csrf-token': await w.csrf(token) },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.body).toBe('');
    expect(res.cookies).toEqual([CLEAR_SESSION]);

    // The AS revoked the DID's current session.
    const upstream = w.as.revocations.slice(asBefore);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]).toMatchObject({ source: 'endpoint', sub: ALICE, sessionId: current?.id, known: true });
    expect(w.as.sessions(ALICE).every((s) => s.revoked !== null)).toBe(true);
    // Everything of the DID is gone.
    for (const table of [
      'web_sessions',
      'oauth_sessions',
      'app_passwords',
      'lb_tokens',
      'lastfm_apps',
      'lastfm_sessions',
      'lastfm_tokens',
      'linked_accounts',
      'forward_outbox',
    ]) {
      expect([table, w.count(table, 'did = ?', ALICE)]).toEqual([table, 0]);
    }
    // ...and each deletion is journaled.
    const journal = w.revocations.entries().slice(journalBefore);
    expect(journal.map((e) => e.kind).sort()).toEqual(
      [
        'account_disconnect',
        'app_password',
        'lastfm_app',
        'lastfm_session',
        'lb_token',
        'linked_account',
        'oauth_session',
        'web_session',
        'web_session',
      ].sort(),
    );
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'web_session', hash: hashTokenHex(first), did: ALICE }),
        expect.objectContaining({ kind: 'web_session', hash: hashTokenHex(token), did: ALICE }),
        expect.objectContaining({ kind: 'app_password', id: password.id, did: ALICE }),
        expect.objectContaining({ kind: 'lb_token', id: lb.id, did: ALICE }),
        expect.objectContaining({ kind: 'lastfm_app', id: issued.apiKey, did: ALICE }),
        expect.objectContaining({ kind: 'lastfm_session', id: lfm.id, did: ALICE }),
        expect.objectContaining({ kind: 'linked_account', id: 'link-1', did: ALICE }),
      ]),
    );
    // Never-sent operations are cancelled; the attempted one waits blocked for a new sign-in.
    const states = Object.fromEntries(
      w.db.all<{ id: string; state: string }>('SELECT id, state FROM operations').map((r) => [r.id, r.state]),
    );
    expect(states).toEqual({ [one]: 'cancelled', [two]: 'cancelled', [sent]: 'blocked' });
    expect(w.count('listen_keys', 'operation_id IN (?, ?)', one, two)).toBe(0);
    expect(w.accountStatus(ALICE)).toBe('signed_out');
    // The cookie no longer works.
    expect((await w.sessionGet(token)).status).toBe(401);
    expect((await w.sessionGet(first)).status).toBe(401);
  });

  it('signing in again while operations are queued and blocked ends with oauth_status active and the operations sent to the fake PDS, never reauth_required', async () => {
    const writes: Array<{ sql: string; rows: number }> = [];
    const w = await world({
      outbox: true,
      wrapDb: (db) => ({
        all: (sql, ...p) => db.all(sql, ...p),
        one: (sql, ...p) => db.one(sql, ...p),
        tx: (fn) => db.tx(fn),
        run(sql, ...p) {
          const r = db.run(sql, ...p);
          writes.push({ sql, rows: r.rowsWritten });
          return r;
        },
      }),
    });
    const alice = await w.addUser(ALICE, 'alice');
    await w.signIn(alice);
    const m = w.app.composed.core.deps;
    const queued = await enqueueScrobbleCreates(m, {
      did: ALICE,
      origin: 'web',
      inputs: [
        { artist: 'A', track: 'Queued', listenedAt: '2026-01-15T11:00:00Z' },
        { artist: 'A', track: 'Blocked', listenedAt: '2026-01-15T11:01:00Z' },
      ],
    });
    if (!queued.ok) throw new Error('enqueue failed');
    const [a, b] = queued.operations.map((o) => o.id) as [string, string];
    w.db.run("UPDATE operations SET state = 'blocked', last_error = 'reauth_required' WHERE id = ?", b);
    const firstAs = w.as.sessions(ALICE)[0];
    writes.length = 0;

    await w.signIn(alice);
    expect(w.accountStatus(ALICE)).toBe('active');
    const states = () =>
      Object.fromEntries(
        w.db.all<{ id: string; state: string }>('SELECT id, state FROM operations').map((r) => [r.id, r.state]),
      );
    expect(states()).toEqual({ [a]: 'queued', [b]: 'queued' });
    // No statement of the re-sign-in ever set reauth_required or blocked anything.
    expect(
      writes.filter((x) => x.rows > 0 && /SET (oauth_status = 'reauth_required'|state = 'blocked')/.test(x.sql)),
    ).toEqual([]);
    // The previous AS session was replaced by the new one.
    expect(firstAs?.revoked?.source).toBe('endpoint');
    expect(w.as.sessions(ALICE).filter((s) => s.revoked === null)).toHaveLength(1);

    // The outbox (kicked by the sign-in) sends both creates to the fake PDS with the new session.
    expect(w.app.timers.pending().length).toBeGreaterThan(0);
    await w.app.composed.core.extensionAlarm();
    expect(states()).toEqual({ [a]: 'succeeded', [b]: 'succeeded' });
    const records = await alice.repo.list(SCROBBLE);
    expect(records.map((r) => (r.value as { track: string }).track).sort()).toEqual(['Blocked', 'Queued']);
    expect(w.accountStatus(ALICE)).toBe('active');
  });

  it('a PLC timeout during the callback binding check answers 502 oauth_upstream, sets no session cookie, and a retried sign-in succeeds without the fake AS having revoked the first new session', async () => {
    const w = await world();
    const alice = await w.addUser(ALICE, 'alice');
    const { authorizeUrl, binding } = await w.begin(alice.handle);
    const back = await w.browse(authorizeUrl);

    // The callback's first PLC request (the library's issuer check, through our identity module) is
    // answered; the second (our binding check) times out.
    let plcCalls = 0;
    w.state.intercept = (req) => {
      if (new URL(req.url).hostname !== 'plc.directory') return null;
      plcCalls += 1;
      if (plcCalls !== 2) return null;
      return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
    };
    const r = await read(await w.callback(back, binding));
    w.state.intercept = null;
    expect(plcCalls).toBe(2);
    expect(r.status).toBe(502);
    expect(contract('GET', '/oauth/callback', r)).toBe('valid');
    expect(r.body).toMatchObject({
      error: { code: 'oauth_upstream', message: 'The authorization server or identity lookup failed.' },
    });
    expect(r.cookies).toEqual([CLEAR_BINDING]);
    expect(w.count('web_sessions')).toBe(0);
    // The new session is kept, here and at the AS: nothing was revoked.
    expect(w.as.revocations).toEqual([]);
    const firstNew = w.as.sessions(ALICE);
    expect(firstNew).toHaveLength(1);
    expect(firstNew[0]?.revoked).toBeNull();
    expect(w.count('oauth_sessions', 'did = ?', ALICE)).toBe(1);

    // The user retries and signs in.
    const token = await w.signIn(alice);
    const session = await read(await w.sessionGet(token));
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ did: ALICE, status: 'active' });
    expect(w.accountStatus(ALICE)).toBe('active');
    expect(w.count('web_sessions')).toBe(1);
    // The 502 revoked nothing; the only revocation is the library replacing that session on the
    // retry's own code exchange (oauth-client.js:196-205), after its new tokens were issued.
    expect(w.as.revocations).toMatchObject([{ source: 'endpoint', sub: ALICE, sessionId: firstNew[0]?.id }]);
    expect(w.as.sessions(ALICE).filter((s) => s.revoked === null)).toHaveLength(1);
    expect(w.tokenSuccesses()).toBe(2);
  });
});
