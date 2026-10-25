// N3-03: the Last.fm auth methods, the /api/auth redirects and
// POST /api/v1/lastfm/authorize (ADR 0005 §7.3, §7.4, §13).
//
// Each test runs the real Node composition in process (test/node/support/app.ts:
// a migrated temporary database, the frozen clock 2026-01-15T12:00:00Z, a
// seeded Random, no network) with the `lastfm-auth` feature and a /2.0 route
// that runs the auth and write method tables through `handleLastfmMethod`
// (the N3-04 dispatcher mounts the same tables). Requests are signed here with
// node:crypto's MD5, independently of signature.ts, and every observable
// outcome (HTTP status, body, database rows) is asserted.

import { createHash } from 'node:crypto';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { LastfmTokenRow } from '../../../src/app/rows';
import { csrfToken } from '../../../src/bff/csrf';
import { createWebSessions, SESSION_COOKIE } from '../../../src/bff/sessions';
import { type CredentialDeps, ensureAccount } from '../../../src/credentials/accounts';
import { createAppPassword } from '../../../src/credentials/app-passwords';
import { createLastfmApp } from '../../../src/credentials/lastfm-apps';
import { AUTH_TOKEN_UNSUPPORTED } from '../../../src/credentials/lastfm-auth';
import { callbackNavigation, lastfmAuthFeature } from '../../../src/http/lastfm-authorize';
import type { RouteDef } from '../../../src/http/types';
import { authMethods, handleLastfmMethod } from '../../../src/lastfm/auth-methods';
import { POST_REQUIRED_MESSAGE } from '../../../src/lastfm/errors';
import { writeMethods } from '../../../src/lastfm/write-methods';
import { closeApps, startApp, TEST_PUBLIC_ORIGIN, type TestApp } from '../support/app';

const ALICE = 'did:plc:alice000000000000000000';
const ALICE_HANDLE = 'alice.bsky.social';
const PANO = 'panoScrobbler';
const PANO_SECRET = 'panoScrobbler';
const UNKNOWN_KEY = '0123456789abcdef0123456789abcdef';
const HEX32 = /^[0-9a-f]{32}$/;

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** api_sig per ADR §7.4, computed independently: byte-ordered names, name+value, secret, MD5. */
function sign(params: Record<string, string>, secret: string): string {
  const names = Object.keys(params)
    .filter((n) => n !== 'format' && n !== 'callback' && n !== 'api_sig')
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return md5(names.map((n) => n + params[n]).join('') + secret);
}

const TABLE = { ...authMethods, ...writeMethods };
const PROTOCOL_ROUTES: RouteDef[] = (['GET', 'POST'] as const).map((method) => ({
  method,
  pattern: '/2.0/',
  handler: (req, ctx) => handleLastfmMethod(TABLE, req, ctx),
}));

interface Rig {
  app: TestApp;
  deps: CredentialDeps;
  /** A cookie session for ALICE: the Cookie header and the X-CSRF-Token. */
  cookie: string;
  csrf: string;
}

async function rig(env?: Record<string, string>): Promise<Rig> {
  const clock = fixedClock();
  const revocations = new MemoryRevocations(clock);
  const app = await startApp({
    clock,
    features: [lastfmAuthFeature({ revocations })],
    routes: PROTOCOL_ROUTES,
    ...(env !== undefined ? { env } : {}),
  });
  const deps: CredentialDeps = { db: app.db, clock, random: seededRandom(11), revocations };
  app.db.run(
    "INSERT INTO users (did, handle, joined_at) VALUES (?, ?, '2026-01-15T12:00:00.000000000Z')",
    ALICE,
    ALICE_HANDLE,
  );
  ensureAccount(deps, { did: ALICE, verifiedHandle: ALICE_HANDLE });
  const web = createWebSessions(deps).create(ALICE);
  const csrfKey = app.composed.app.lastfmAuth.csrfKey;
  return { app, deps, cookie: `${SESSION_COOKIE}=${web.token}`, csrf: csrfToken(csrfKey, web.token) };
}

afterEach(closeApps);

type Fmt = 'json' | 'xml';

/** A signed /2.0 call. `secret` null leaves api_sig as given in `params`. */
async function call(
  app: TestApp,
  params: Record<string, string>,
  options: { secret?: string | null; method?: 'GET' | 'POST'; format?: Fmt; headers?: Record<string, string> } = {},
): Promise<Response> {
  const p: Record<string, string> = { ...params };
  const secret = options.secret === undefined ? PANO_SECRET : options.secret;
  if (secret !== null) p.api_sig = sign(p, secret);
  if ((options.format ?? 'json') === 'json') p.format = 'json';
  const body = new URLSearchParams(p).toString();
  if ((options.method ?? 'POST') === 'GET') return app.fetch(`/2.0/?${body}`, { headers: options.headers });
  return app.fetch('/2.0/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...options.headers },
    body,
  });
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function approve(r: Rig, body: Record<string, unknown>): Promise<Response> {
  return r.app.fetch('/api/v1/lastfm/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: r.cookie,
      origin: TEST_PUBLIC_ORIGIN,
      'x-csrf-token': r.csrf,
    },
    body: JSON.stringify(body),
  });
}

function tokenRow(app: TestApp, token: string): LastfmTokenRow | undefined {
  return app.db
    .all<LastfmTokenRow>('SELECT * FROM lastfm_tokens')
    .find((row) => Buffer.from(row.token_hash).toString('hex') === sha256(token));
}

function sessionCount(app: TestApp): number {
  return app.db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_sessions')!.n;
}

describe('Last.fm auth methods and approval', () => {
  it('desktop flow: auth.getToken, POST /api/v1/lastfm/authorize, then auth.getSession returns session name, 32-hex key and subscriber 0 in XML and JSON', async () => {
    const r = await rig();
    const { app } = r;
    const keys: string[] = [];
    for (const format of ['json', 'xml'] as const) {
      // 1. auth.getToken (signed, GET allowed).
      const tokenRes = await call(app, { method: 'auth.getToken', api_key: PANO }, { method: 'GET' });
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.headers.get('access-control-allow-origin')).toBeNull();
      const token = (await jsonOf(tokenRes)).token as string;
      expect(token).toMatch(HEX32);
      expect(tokenRow(app, token)).toMatchObject({ api_key: PANO, state: 'issued', did: null });

      // Not yet approved: 14.
      const early = await call(app, { method: 'auth.getSession', api_key: PANO, token });
      expect(early.status).toBe(403);
      expect(await jsonOf(early)).toEqual({ error: 14, message: 'This token has not been authorized' });

      // 2. The client opens /api/auth/?api_key&token, which 302s to the SPA page.
      const redirect = await app.fetch(`/api/auth/?api_key=${PANO}&token=${token}`);
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get('location')).toBe(`/lastfm/authorize?api_key=${PANO}&token=${token}`);

      // 3. The signed-in user approves.
      const approved = await approve(r, { apiKey: PANO, token });
      expect(approved.status).toBe(200);
      expect(approved.headers.get('cache-control')).toBe('no-store');
      expect(await approved.json()).toEqual({ token });
      expect(tokenRow(app, token)).toMatchObject({ state: 'authorized', did: ALICE });

      // 4. auth.getSession consumes the token.
      const res = await call(app, { method: 'auth.getSession', api_key: PANO, token }, { format });
      expect(res.status).toBe(200);
      const text = await res.text();
      let name: string;
      let key: string;
      if (format === 'json') {
        expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
        const body = JSON.parse(text) as { session: { name: string; key: string; subscriber: number } };
        expect(Object.keys(body)).toEqual(['session']);
        expect(body.session.subscriber).toBe(0);
        ({ name, key } = body.session);
      } else {
        expect(res.headers.get('content-type')).toBe('text/xml; charset=utf-8');
        const m =
          /^<\?xml version="1.0" encoding="UTF-8"\?>\n<lfm status="ok">\n {2}<session>\n {4}<name>([^<]*)<\/name>\n {4}<key>([^<]*)<\/key>\n {4}<subscriber>0<\/subscriber>\n {2}<\/session>\n<\/lfm>\n$/.exec(
            text,
          );
        expect(m, text).not.toBeNull();
        name = m![1]!;
        key = m![2]!;
      }
      expect(name).toBe(ALICE_HANDLE);
      expect(key).toMatch(HEX32);
      keys.push(key);
      expect(tokenRow(app, token)?.state).toBe('consumed');
      const stored = app.db.one<{ did: string; api_key: string; client_name: string | null }>(
        'SELECT did, api_key, client_name FROM lastfm_sessions WHERE lower(hex(sk_hash)) = ?',
        sha256(key),
      );
      expect(stored).toEqual({ did: ALICE, api_key: PANO, client_name: 'Pano Scrobbler' });

      // Single use: a second getSession with the same token is 4.
      const again = await call(app, { method: 'auth.getSession', api_key: PANO, token });
      expect(again.status).toBe(403);
      expect((await jsonOf(again)).error).toBe(4);
    }
    expect(new Set(keys).size).toBe(2);
    expect(sessionCount(app)).toBe(2);
  });

  it('GET /api/auth and GET /api/auth/ with api_key and cb both 302 to /lastfm/authorize keeping the query string; approval yields cb?token= or cb&token=; javascript:, data:, vbscript: and file: callbacks are refused', async () => {
    const r = await rig();
    const { app } = r;
    const query = `api_key=${UNKNOWN_KEY}&cb=https%3A%2F%2Fplayer.example%2Fcb`;
    for (const path of ['/api/auth', '/api/auth/']) {
      const res = await app.fetch(`${path}?${query}`);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location'), path).toBe(`/lastfm/authorize?${query}`);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await res.text()).toBe('');
    }
    // An app deep link is allowed.
    const pano = await app.fetch('/api/auth?api_key=panoScrobbler&cb=pano://lastfm-callback');
    expect(pano.status).toBe(302);
    expect(pano.headers.get('location')).toBe('/lastfm/authorize?api_key=panoScrobbler&cb=pano://lastfm-callback');

    // Web flow approval: no token in, an authorized token out.
    const approved = await approve(r, { apiKey: UNKNOWN_KEY });
    expect(approved.status).toBe(200);
    const { token } = (await approved.json()) as { token: string };
    expect(token).toMatch(HEX32);
    expect(tokenRow(app, token)).toMatchObject({ api_key: UNKNOWN_KEY, state: 'authorized', did: ALICE });
    expect(callbackNavigation('https://player.example/cb', token)).toBe(`https://player.example/cb?token=${token}`);
    expect(callbackNavigation('https://player.example/cb?state=s1', token)).toBe(
      `https://player.example/cb?state=s1&token=${token}`,
    );
    expect(callbackNavigation('pano://lastfm-callback', token)).toBe(`pano://lastfm-callback?token=${token}`);
    // The client then redeems it (unknown api_key: a well-formed api_sig is enough).
    const session = await call(
      app,
      { method: 'auth.getSession', api_key: UNKNOWN_KEY, token, api_sig: 'f'.repeat(32) },
      { secret: null },
    );
    expect(session.status).toBe(200);
    expect(((await jsonOf(session)).session as { name: string }).name).toBe(ALICE_HANDLE);

    // Refused schemes: 422 naming cb, no redirect, nothing stored.
    const before = app.db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_tokens')!.n;
    for (const cb of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '/relative/path',
    ]) {
      for (const path of ['/api/auth', '/api/auth/']) {
        const res = await app.fetch(`${path}?api_key=${UNKNOWN_KEY}&cb=${encodeURIComponent(cb)}`);
        expect(res.status, `${path} ${cb}`).toBe(422);
        expect(res.headers.get('location')).toBeNull();
        const body = (await res.json()) as { error: { code: string; fields: Record<string, string> } };
        expect(body.error.code).toBe('validation_failed');
        expect(Object.keys(body.error.fields)).toEqual(['cb']);
      }
      expect(callbackNavigation(cb, token), cb).toBeNull();
    }
    // A missing api_key is refused as well.
    const noKey = await app.fetch('/api/auth?cb=https%3A%2F%2Fplayer.example%2Fcb');
    expect(noKey.status).toBe(422);
    expect(app.db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_tokens')!.n).toBe(before);
  });

  it('auth.getMobileSession with username and app password over POST returns a session; GET gives 3; a wrong password gives 4; authToken gives 4; the 11th failed attempt for one (username, IP) in 15 min gives 29 while the same username from another IP still succeeds', async () => {
    const r = await rig({ ATMUSIC_CLIENT_IP_HEADER: 'x-real-ip' });
    const { app } = r;
    const { password } = createAppPassword(r.deps, { did: ALICE, label: 'phone' });
    const from = (ip: string) => ({ headers: { 'x-real-ip': ip } });
    const mobile = (pw: string, ip: string, extra: Record<string, string> = {}) =>
      call(
        app,
        { method: 'auth.getMobileSession', api_key: PANO, username: 'alice.bsky.social', password: pw, ...extra },
        from(ip),
      );

    const ok = await mobile(password, '192.0.2.1');
    expect(ok.status).toBe(200);
    const session = (await jsonOf(ok)).session as { name: string; key: string; subscriber: number };
    expect(session).toEqual({ name: ALICE_HANDLE, key: expect.stringMatching(HEX32), subscriber: 0 });
    expect(sessionCount(app)).toBe(1);

    const viaGet = await call(
      app,
      { method: 'auth.getMobileSession', api_key: PANO, username: ALICE_HANDLE, password },
      { method: 'GET', ...from('192.0.2.1') },
    );
    expect(viaGet.status).toBe(400);
    expect(await jsonOf(viaGet)).toEqual({ error: 3, message: POST_REQUIRED_MESSAGE });

    const wrong = await mobile('a'.repeat(24), '192.0.2.1');
    expect(wrong.status).toBe(403);
    expect(await jsonOf(wrong)).toEqual({ error: 4, message: 'Authentication Failed' });

    const legacy = await call(
      app,
      { method: 'auth.getMobileSession', api_key: PANO, username: ALICE_HANDLE, authToken: md5(`alice${md5('pw')}`) },
      from('192.0.2.1'),
    );
    expect(legacy.status).toBe(403);
    expect(await jsonOf(legacy)).toEqual({ error: 4, message: AUTH_TOKEN_UNSUPPORTED });
    expect(sessionCount(app)).toBe(1);

    // Ten failures from one IP are answered 4; the 11th is 29 before the password is looked at.
    const ipA = '198.51.100.7';
    for (let i = 0; i < 10; i++) {
      const res = await mobile(`wrong-${i}`.padEnd(24, 'x'), ipA);
      expect(res.status, `attempt ${i + 1}`).toBe(403);
      expect((await jsonOf(res)).error).toBe(4);
    }
    const eleventh = await mobile('still-wrong'.padEnd(24, 'x'), ipA);
    expect(eleventh.status).toBe(429);
    expect(Number(eleventh.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await jsonOf(eleventh)).toEqual({ error: 29, message: 'Rate Limit Exceeded' });
    // Even the right password is refused from that (user, IP) pair, and the DID spelling shares the budget.
    expect((await mobile(password, ipA)).status).toBe(429);
    const byDid = await call(
      app,
      { method: 'auth.getMobileSession', api_key: PANO, username: ALICE, password },
      from(ipA),
    );
    expect(byDid.status).toBe(429);
    expect(sessionCount(app)).toBe(1);

    // The same username from another IP still signs in.
    const ipB = '203.0.113.9';
    const other = await mobile(password, ipB);
    expect(other.status).toBe(200);
    expect(((await jsonOf(other)).session as { name: string }).name).toBe(ALICE_HANDLE);
    expect(sessionCount(app)).toBe(2);
  });

  it('an issued api_key with a bad signature gives 13; the panoScrobbler pair is verified; an unknown api_key with a well-formed signature is accepted', async () => {
    const r = await rig();
    const { app } = r;
    const issued = createLastfmApp(
      { ...r.deps, box: app.composed.app.lastfmAuth.box },
      { did: ALICE, name: 'My Player' },
    );
    const tokens = () => app.db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_tokens')!.n;
    const getToken = (apiKey: string, secret: string | null, extra: Record<string, string> = {}) =>
      call(app, { method: 'auth.getToken', api_key: apiKey, ...extra }, { secret });
    const expect13 = async (res: Response) => {
      expect(res.status).toBe(403);
      expect(await jsonOf(res)).toEqual({ error: 13, message: 'Invalid method signature supplied' });
    };

    // Issued key: mandatory and verified under its own secret.
    await expect13(await getToken(issued.apiKey, 'not-the-secret'));
    await expect13(await getToken(issued.apiKey, PANO_SECRET));
    await expect13(await getToken(issued.apiKey, null));
    await expect13(await getToken(issued.apiKey, null, { api_sig: 'f'.repeat(32) }));
    const good = await getToken(issued.apiKey, issued.sharedSecret);
    expect(good.status).toBe(200);
    expect((await jsonOf(good)).token).toMatch(HEX32);
    expect(tokens()).toBe(1);

    // The known public pair: verified, case-insensitively, never just shape-checked.
    await expect13(await getToken(PANO, 'wrong'));
    await expect13(await getToken(PANO, null, { api_sig: 'f'.repeat(32) }));
    const upper = { method: 'auth.getToken', api_key: PANO };
    const pano = await call(app, { ...upper, api_sig: sign(upper, PANO_SECRET).toUpperCase() }, { secret: null });
    expect(pano.status).toBe(200);
    expect(tokens()).toBe(2);

    // Unknown key: a 32-hex api_sig is accepted unverified; a malformed or missing one is 13.
    const unknown = await getToken(UNKNOWN_KEY, null, { api_sig: '0123456789ABCDEF0123456789abcdef' });
    expect(unknown.status).toBe(200);
    expect(tokenRow(app, (await jsonOf(unknown)).token as string)).toMatchObject({ api_key: UNKNOWN_KEY });
    await expect13(await getToken(UNKNOWN_KEY, null, { api_sig: 'not-hex' }));
    await expect13(await getToken(UNKNOWN_KEY, null));
    expect(tokens()).toBe(3);

    // A missing api_key is 10 before any signature is looked at.
    const noKey = await call(app, { method: 'auth.getToken' }, { secret: null });
    expect(noKey.status).toBe(403);
    expect((await jsonOf(noKey)).error).toBe(10);
  });

  it("multi-scrobbler's exact URL /api/auth?api_key=K&cb=http://localhost:9078/librefm/callback?state=x approves to a navigation that ends with &token=<32 hex>", async () => {
    const r = await rig();
    const { app } = r;
    const K = UNKNOWN_KEY;
    const res = await app.fetch(`/api/auth?api_key=${K}&cb=http://localhost:9078/librefm/callback?state=x`);
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toBe(`/lastfm/authorize?api_key=${K}&cb=http://localhost:9078/librefm/callback?state=x`);

    // What the approval page reads from its own URL, then sends.
    const page = new URL(location, TEST_PUBLIC_ORIGIN);
    expect(page.pathname).toBe('/lastfm/authorize');
    const cb = page.searchParams.get('cb')!;
    expect(cb).toBe('http://localhost:9078/librefm/callback?state=x');
    const approved = await approve(r, { apiKey: page.searchParams.get('api_key') });
    expect(approved.status).toBe(200);
    const { token } = (await approved.json()) as { token: string };
    const navigation = callbackNavigation(cb, token);
    expect(navigation).toMatch(/^http:\/\/localhost:9078\/librefm\/callback\?state=x&token=[0-9a-f]{32}$/);
    expect(navigation!.endsWith(`&token=${token}`)).toBe(true);

    // multi-scrobbler then calls auth.getSession with the token from its callback.
    const tokenFromCallback = new URL(navigation!).searchParams.get('token')!;
    const session = await call(
      app,
      { method: 'auth.getSession', api_key: K, token: tokenFromCallback, api_sig: 'a'.repeat(32) },
      { secret: null, format: 'xml' },
    );
    expect(session.status).toBe(200);
    expect(await session.text()).toContain(`<name>${ALICE_HANDLE}</name>`);
    expect(tokenRow(app, token)?.state).toBe('consumed');
  });
});
