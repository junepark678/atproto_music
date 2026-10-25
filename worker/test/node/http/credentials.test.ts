// Credential management routes (ADR 0005 §5.7, §7.3, §8.2, §14.5; N3-10).
//
// Every test runs the real Node composition (support/app.ts startApp) with
// the credential-settings feature over the harness's migrated temporary
// database, the frozen clock (2026-01-15T12:00:00Z) and seeded randomness,
// and talks to it over HTTP on an ephemeral loopback port. Sessions are real
// `__Host-atmusic_session` rows (bff/sessions.ts) with the CSRF token the
// server derives (bff/csrf.ts over the box's CSRF key). The revocation
// journal is the in-memory one (app/revocations.ts), injected through the
// feature's `revocations` input. Every JSON answer is checked against
// api/openapi.yaml through AJV (acceptance/support/openapi.ts).
//
// The /2.0 and /1 dispatchers are other packages (N3-03..N3-06); to observe
// what a deleted Last.fm session key or ListenBrainz token answers, the third
// test mounts two protocol probes built only from the production verifiers
// (credentials/lastfm-auth.ts verifySessionKey, credentials/lb-tokens.ts
// verifyLbToken) and encoders (lastfm/encode.ts, listenbrainz/auth-header.ts),
// the same pieces those dispatchers authenticate with.

import { createHash } from 'node:crypto';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import { csrfToken } from '../../../src/bff/csrf';
import { createWebSessions, SESSION_COOKIE } from '../../../src/bff/sessions';
import { ensureAccount } from '../../../src/credentials/accounts';
import { createAppPassword } from '../../../src/credentials/app-passwords';
import { createLastfmApp, issuedAppSecret } from '../../../src/credentials/lastfm-apps';
import { createSession, getMobileSession, verifySessionKey } from '../../../src/credentials/lastfm-auth';
import { createLbToken, verifyLbToken } from '../../../src/credentials/lb-tokens';
import { createBox } from '../../../src/crypto/box';
import { credentialsFeature } from '../../../src/http/credentials';
import type { RouteDef } from '../../../src/http/types';
import { need } from '../../../src/http/types';
import { lastfmResponse } from '../../../src/lastfm/encode';
import { LastfmError } from '../../../src/lastfm/errors';
import { parseAuthorization, unauthorized } from '../../../src/listenbrainz/auth-header';
import { lbJson } from '../../../src/listenbrainz/errors';
import type { Feature } from '../../../src/node/compose';
import { checkResponse } from '../../acceptance/support/openapi';
import { closeApps, startApp, TEST_PUBLIC_ORIGIN, type TestApp } from '../support/app';

afterEach(closeApps);

const ALICE = 'did:plc:alice000000000000000000';
const BOB = 'did:plc:bob00000000000000000000';
const NOW = '2026-01-15T12:00:00.000000000Z';
const LATER = '2026-01-15T12:05:00.000000000Z';
const PASSWORD_RE = /^[A-Z2-7]{24}$/;
const UUID4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const blobHex = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b as ArrayBuffer).toString('hex');
const count = (app: TestApp, table: string): number =>
  app.db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? -1;

// ---------------------------------------------------------------------------
// Harness

/** Two protocol probes over the production verifiers (module comment). */
function protocolProbes(): Feature {
  const routes: RouteDef[] = [
    {
      method: 'GET',
      pattern: '/2.0/',
      async handler(req, ctx) {
        const deps = need(ctx, 'deps');
        const verified = verifySessionKey(deps, new URL(req.url).searchParams.get('sk'));
        if (!verified.ok) return lastfmResponse(new LastfmError(verified.code), 'json');
        return new Response(JSON.stringify({ user: { name: verified.value.name } }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    },
    {
      method: 'POST',
      pattern: '/1/submit-listens',
      async handler(req, ctx) {
        const deps = need(ctx, 'deps');
        const header = parseAuthorization(req.headers.get('authorization'));
        if (!header.ok) return unauthorized(header.failure);
        const verified = verifyLbToken(deps, header.token);
        if (verified === null) return unauthorized('invalid_token');
        return lbJson({ status: 'ok', user: verified.username });
      },
    },
  ];
  return { name: 'protocol-probes', routes };
}

interface World {
  app: TestApp;
  clock: FixedClock;
  journal: MemoryRevocations;
  signIn(did: string, handle: string): Signed;
}

interface Signed {
  did: string;
  token: string;
  cookie: string;
  csrf: string;
}

async function world(options: { probes?: boolean } = {}): Promise<World> {
  const clock = fixedClock();
  const journal = new MemoryRevocations(clock);
  const features: Feature[] = [credentialsFeature({ revocations: journal })];
  if (options.probes === true) features.push(protocolProbes());
  const app = await startApp({ clock, features });
  const random = seededRandom(0xc0ffee);
  // The server's CSRF key: the box over the same operator encryption keys.
  const csrfKey = createBox(app.secrets.encryptionKeys, seededRandom(1)).csrfKey();
  const sessions = createWebSessions({ db: app.db, clock, random, revocations: journal });
  return {
    app,
    clock,
    journal,
    signIn(did, handle) {
      app.db.run(
        "INSERT INTO users (did, handle, joined_at) VALUES (?, ?, '2026-01-15T12:00:00.000000000Z')",
        did,
        handle,
      );
      ensureAccount({ db: app.db, clock }, { did, verifiedHandle: handle });
      const issued = sessions.create(did);
      return {
        did,
        token: issued.token,
        cookie: `${SESSION_COOKIE}=${issued.token}`,
        csrf: csrfToken(csrfKey, issued.token),
      };
    },
  };
}

interface CallOptions {
  /** The session whose cookie is sent. */
  as?: Signed;
  /** The X-CSRF-Token: the session's by default, `false` for none, or a given value. */
  csrf?: string | false;
  /** The Origin header: PUBLIC_ORIGIN by default, null for none. */
  origin?: string | null;
  body?: unknown;
}

interface Answer {
  status: number;
  headers: Headers;
  text: string;
  body: unknown;
}

async function call(app: TestApp, method: string, path: string, options: CallOptions = {}): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (options.as !== undefined) {
    headers.cookie = options.as.cookie;
    if (options.csrf !== false) headers['x-csrf-token'] = options.csrf ?? options.as.csrf;
  }
  const origin = options.origin === undefined ? TEST_PUBLIC_ORIGIN : options.origin;
  if (origin !== null) headers.origin = origin;
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const res = await app.fetch(path, init);
  const text = await res.text();
  let body: unknown = null;
  if ((res.headers.get('content-type') ?? '').startsWith('application/json') && text !== '') body = JSON.parse(text);
  return { status: res.status, headers: res.headers, text, body };
}

/** The answer is the declared contract response for (method, path, status). */
function expectContract(method: string, path: string, answer: Answer): void {
  expect(checkResponse(method, path, { status: answer.status, headers: answer.headers, body: answer.body })).toBe(
    'valid',
  );
}

function expectError(answer: Answer, status: number, code: string): void {
  expect(answer.status).toBe(status);
  expect(answer.headers.get('cache-control')).toBe('no-store');
  expect(answer.body).toMatchObject({ error: { code } });
}

// ---------------------------------------------------------------------------

describe('GET /api/v1/account/credentials (ADR §5.7)', () => {
  it('GET /api/v1/account/credentials lists labels, client names and timestamps and no secret, hash or ciphertext', async () => {
    const { app, clock, journal, signIn } = await world();
    const alice = signIn(ALICE, 'alice.example.com');
    signIn(BOB, 'bob.example.com');
    const random = seededRandom(42);
    const box = createBox(app.secrets.encryptionKeys, random);
    const deps = { db: app.db, clock, random, revocations: journal, box };

    // Alice's credentials, made by the credential modules (as the protocol flows do).
    const password = createAppPassword(deps, { did: ALICE, label: 'Pano on phone' });
    const token = createLbToken(deps, { did: ALICE, label: 'Navidrome' });
    const issued = createLastfmApp(deps, { did: ALICE, name: 'multi-scrobbler' });
    const named = createSession(deps, { did: ALICE, apiKey: 'panoScrobbler', clientName: 'Pano Scrobbler' });
    const viaIssued = createSession(deps, { did: ALICE, apiKey: issued.apiKey });
    const anonymous = createSession(deps, { did: ALICE, apiKey: 'some-client-key' });
    // Bob's are never listed for Alice.
    const bobPassword = createAppPassword(deps, { did: BOB, label: 'Bob phone' });
    const bobSession = createSession(deps, { did: BOB, apiKey: 'panoScrobbler', clientName: 'Bob Pano' });

    // Five minutes later the token and one session key are used.
    clock.advance(5 * 60_000);
    expect(verifyLbToken(deps, token.token)).not.toBeNull();
    expect(verifySessionKey(deps, named.key).ok).toBe(true);

    const res = await call(app, 'GET', '/api/v1/account/credentials', { as: alice, csrf: false, origin: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expectContract('GET', '/api/v1/account/credentials', res);
    expect(res.body).toEqual({
      appPasswords: [{ id: password.id, label: 'Pano on phone', createdAt: NOW, lastUsedAt: null }],
      listenbrainzTokens: [{ id: token.id, label: 'Navidrome', createdAt: NOW, lastUsedAt: LATER }],
      lastfmApps: [{ apiKey: issued.apiKey, name: 'multi-scrobbler', createdAt: NOW }],
      lastfmSessions: expect.arrayContaining([
        { id: named.id, apiKey: 'panoScrobbler', clientName: 'Pano Scrobbler', createdAt: NOW, lastUsedAt: LATER },
        // No client name given: the issued app's name, else the api_key.
        { id: viaIssued.id, apiKey: issued.apiKey, clientName: 'multi-scrobbler', createdAt: NOW, lastUsedAt: null },
        {
          id: anonymous.id,
          apiKey: 'some-client-key',
          clientName: 'some-client-key',
          createdAt: NOW,
          lastUsedAt: null,
        },
      ]),
    });
    expect((res.body as { lastfmSessions: unknown[] }).lastfmSessions).toHaveLength(3);

    // No secret, hash or ciphertext in any spelling, and nothing of Bob's.
    const stored = [
      ...app.db.all<{ hash: ArrayBuffer }>('SELECT hash FROM app_passwords'),
      ...app.db.all<{ hash: ArrayBuffer }>('SELECT hash FROM lb_tokens'),
      ...app.db.all<{ hash: ArrayBuffer }>('SELECT sk_hash AS hash FROM lastfm_sessions'),
    ].map((r) => blobHex(r.hash));
    const sealed = app.db
      .all<{ c: ArrayBuffer }>('SELECT secret_ciphertext AS c FROM lastfm_apps')
      .flatMap((r) => [blobHex(r.c), Buffer.from(r.c).toString('base64'), Buffer.from(r.c).toString('base64url')]);
    expect(stored).toHaveLength(7);
    const forbidden = [
      password.password,
      password.password.toUpperCase(),
      token.token,
      issued.sharedSecret,
      named.key,
      viaIssued.key,
      anonymous.key,
      ...stored,
      ...sealed,
      bobPassword.id,
      bobSession.id,
      'Bob phone',
      'Bob Pano',
    ];
    for (const value of forbidden) expect(res.text).not.toContain(value);

    // Without a session the listing is the 401 envelope and lists nothing.
    const anon = await call(app, 'GET', '/api/v1/account/credentials', { origin: null });
    expectError(anon, 401, 'unauthenticated');
    expectContract('GET', '/api/v1/account/credentials', anon);
    expect(anon.text).not.toContain(password.id);
  });
});

describe('creating credentials (ADR §7.3, §8.2)', () => {
  it('creating an app password, ListenBrainz token or Last.fm app returns its secret once with no-store; no later response contains it', async () => {
    const { app, clock, journal, signIn } = await world();
    const alice = signIn(ALICE, 'alice.example.com');

    const pw = await call(app, 'POST', '/api/v1/account/app-passwords', {
      as: alice,
      body: { label: '  Pano on phone ' },
    });
    expect(pw.status).toBe(201);
    expect(pw.headers.get('cache-control')).toBe('no-store');
    expectContract('POST', '/api/v1/account/app-passwords', pw);
    const createdPw = pw.body as { id: string; label: string; password: string; createdAt: string };
    expect(createdPw).toMatchObject({ label: 'Pano on phone', createdAt: NOW });
    expect(createdPw.password).toMatch(PASSWORD_RE);

    const lb = await call(app, 'POST', '/api/v1/account/listenbrainz-tokens', {
      as: alice,
      body: { label: 'Navidrome' },
    });
    expect(lb.status).toBe(201);
    expect(lb.headers.get('cache-control')).toBe('no-store');
    expectContract('POST', '/api/v1/account/listenbrainz-tokens', lb);
    const createdLb = lb.body as { id: string; label: string; token: string; createdAt: string };
    expect(createdLb).toMatchObject({ label: 'Navidrome', createdAt: NOW });
    expect(createdLb.token).toMatch(UUID4_RE);

    const fm = await call(app, 'POST', '/api/v1/account/lastfm-apps', { as: alice, body: { name: 'multi-scrobbler' } });
    expect(fm.status).toBe(201);
    expect(fm.headers.get('cache-control')).toBe('no-store');
    expectContract('POST', '/api/v1/account/lastfm-apps', fm);
    const createdFm = fm.body as { apiKey: string; sharedSecret: string; name: string; createdAt: string };
    expect(createdFm).toMatchObject({ name: 'multi-scrobbler', createdAt: NOW });
    expect(createdFm.apiKey).toMatch(HEX32_RE);
    expect(createdFm.sharedSecret).toMatch(HEX32_RE);

    // Stored once each, as SHA-256 or sealed, for Alice; never the plaintext.
    const pwRow = app.db.one<{ id: string; did: string; label: string; hash: ArrayBuffer }>(
      'SELECT id, did, label, hash FROM app_passwords',
    );
    expect(count(app, 'app_passwords')).toBe(1);
    expect(pwRow).toMatchObject({ id: createdPw.id, did: ALICE, label: 'Pano on phone' });
    expect(blobHex(pwRow?.hash as ArrayBuffer)).toBe(sha256Hex(createdPw.password.toLowerCase()));
    const lbRow = app.db.one<{ id: string; did: string; hash: ArrayBuffer }>('SELECT id, did, hash FROM lb_tokens');
    expect(count(app, 'lb_tokens')).toBe(1);
    expect(lbRow).toMatchObject({ id: createdLb.id, did: ALICE });
    expect(blobHex(lbRow?.hash as ArrayBuffer)).toBe(sha256Hex(createdLb.token));
    const fmRow = app.db.one<{ api_key: string; did: string; secret_ciphertext: ArrayBuffer }>(
      'SELECT api_key, did, secret_ciphertext FROM lastfm_apps',
    );
    expect(count(app, 'lastfm_apps')).toBe(1);
    expect(fmRow).toMatchObject({ api_key: createdFm.apiKey, did: ALICE });
    expect(Buffer.from(fmRow?.secret_ciphertext as ArrayBuffer).includes(Buffer.from(createdFm.sharedSecret))).toBe(
      false,
    );
    // The sealed secret opens to the one shown (signature checks need it).
    const box = createBox(app.secrets.encryptionKeys, seededRandom(3));
    expect(issuedAppSecret({ db: app.db, box }, createdFm.apiKey)?.secret).toBe(createdFm.sharedSecret);
    // The shown credentials work in their protocols: the uppercase app password signs in.
    const deps = { db: app.db, clock, random: seededRandom(4), revocations: journal };
    const mobile = getMobileSession(deps, {
      apiKey: 'panoScrobbler',
      username: 'alice.example.com',
      password: createdPw.password,
    });
    expect(mobile.ok).toBe(true);
    expect(verifyLbToken(deps, createdLb.token)?.did).toBe(ALICE);

    // Every later response: listings, other creates, deletes, refusals, other routes.
    const secrets = [createdPw.password, createdPw.password.toLowerCase(), createdLb.token, createdFm.sharedSecret];
    const later: Answer[] = [
      await call(app, 'GET', '/api/v1/account/credentials', { as: alice, csrf: false, origin: null }),
      await call(app, 'POST', '/api/v1/account/app-passwords', { as: alice, body: { label: 'second' } }),
      await call(app, 'POST', '/api/v1/account/listenbrainz-tokens', { as: alice, body: { label: 'second' } }),
      await call(app, 'POST', '/api/v1/account/lastfm-apps', { as: alice, body: { name: 'second' } }),
      await call(app, 'POST', '/api/v1/account/app-passwords', { as: alice, body: { label: '' } }),
      await call(app, 'POST', '/api/v1/account/app-passwords', { as: alice, body: '{"label":"a","label":"b"}' }),
      await call(app, 'POST', '/api/v1/account/app-passwords', { as: alice, csrf: false, body: { label: 'x' } }),
      await call(app, 'DELETE', `/api/v1/account/app-passwords/${createdPw.id}`, { as: alice }),
      await call(app, 'DELETE', `/api/v1/account/app-passwords/${createdPw.id}`, { as: alice }),
      await call(app, 'GET', '/api/v1/account/credentials', { as: alice, csrf: false, origin: null }),
      await call(app, 'GET', '/api/v1/meta', { origin: null }),
    ];
    expect(later.map((a) => a.status)).toEqual([200, 201, 201, 201, 422, 422, 403, 204, 404, 200, 200]);
    expect(later[4]?.body).toMatchObject({
      error: { code: 'validation_failed', fields: { label: expect.any(String) } },
    });
    expect(later[5]?.body).toMatchObject({
      error: { code: 'validation_failed', fields: { body: expect.any(String) } },
    });
    // The second creates carry their own new secrets, never the first ones.
    const second = (later[1] as Answer).body as { password: string };
    expect(second.password).toMatch(PASSWORD_RE);
    expect(second.password).not.toBe(createdPw.password);
    for (const answer of later) {
      const everything = `${answer.text}\n${[...answer.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}`;
      for (const secret of secrets) expect(everything).not.toContain(secret);
    }
    // Nor did any log line carry one.
    for (const secret of secrets) expect(app.log.lines.join('\n')).not.toContain(secret);
  });
});

describe('deleting credentials (ADR §5.7, §14.5)', () => {
  it('after DELETE, the Last.fm session key gives 9 and the ListenBrainz token gives 401', async () => {
    const { app, clock, journal, signIn } = await world({ probes: true });
    const alice = signIn(ALICE, 'alice.example.com');
    const bob = signIn(BOB, 'bob.example.com');

    // Alice signs in a Last.fm client with an app password and makes a ListenBrainz token.
    const pw = await call(app, 'POST', '/api/v1/account/app-passwords', { as: alice, body: { label: 'Pano' } });
    const lb = await call(app, 'POST', '/api/v1/account/listenbrainz-tokens', { as: alice, body: { label: 'Navi' } });
    const fm = await call(app, 'POST', '/api/v1/account/lastfm-apps', { as: alice, body: { name: 'mine' } });
    expect([pw.status, lb.status, fm.status]).toEqual([201, 201, 201]);
    const password = (pw.body as { id: string; password: string }).password;
    const token = (lb.body as { id: string; token: string }).token;
    const apiKey = (fm.body as { apiKey: string }).apiKey;
    const deps = { db: app.db, clock, random: seededRandom(9), revocations: journal };
    const mobile = getMobileSession(deps, { apiKey: 'panoScrobbler', username: 'alice.example.com', password });
    if (!mobile.ok) throw new Error('getMobileSession failed');
    const sk = mobile.value.key;

    const listing = await call(app, 'GET', '/api/v1/account/credentials', { as: alice, csrf: false, origin: null });
    const sessionId = (listing.body as { lastfmSessions: { id: string }[] }).lastfmSessions[0]?.id as string;
    expect(sessionId).toBe(mobile.value.id);

    // Before: both authenticate.
    const fmBefore = await call(app, 'GET', `/2.0/?method=user.getInfo&api_key=k&format=json&sk=${sk}`, {
      origin: null,
    });
    expect(fmBefore.status).toBe(200);
    expect(fmBefore.body).toEqual({ user: { name: 'alice.example.com' } });
    const lbBefore = await app.fetch('/1/submit-listens', {
      method: 'POST',
      headers: { authorization: `Token ${token}` },
    });
    expect(lbBefore.status).toBe(200);
    expect(await lbBefore.json()).toEqual({ status: 'ok', user: 'alice.example.com' });

    // Bob cannot delete Alice's credentials: 404, nothing deleted, nothing journaled.
    for (const path of [
      `/api/v1/account/lastfm-sessions/${sessionId}`,
      `/api/v1/account/listenbrainz-tokens/${(lb.body as { id: string }).id}`,
    ]) {
      const refused = await call(app, 'DELETE', path, { as: bob });
      expectError(refused, 404, 'not_found');
      expectContract('DELETE', path, refused);
    }
    // A malformed id is 404 too.
    const malformed = await call(app, 'DELETE', '/api/v1/account/lastfm-sessions/not%20an%20id', { as: alice });
    expectError(malformed, 404, 'not_found');
    expect(count(app, 'lastfm_sessions')).toBe(1);
    expect(count(app, 'lb_tokens')).toBe(1);
    expect(journal.entries()).toEqual([]);

    // Alice deletes the session key and the token: 204, no body, no-store.
    const delSession = await call(app, 'DELETE', `/api/v1/account/lastfm-sessions/${sessionId}`, { as: alice });
    const delToken = await call(
      app,
      'DELETE',
      `/api/v1/account/listenbrainz-tokens/${(lb.body as { id: string }).id}`,
      {
        as: alice,
      },
    );
    for (const answer of [delSession, delToken]) {
      expect(answer.status).toBe(204);
      expect(answer.text).toBe('');
      expect(answer.headers.get('cache-control')).toBe('no-store');
    }
    expect(count(app, 'lastfm_sessions')).toBe(0);
    expect(count(app, 'lb_tokens')).toBe(0);
    // Journaled, ids only.
    expect(journal.entries()).toEqual([
      { kind: 'lastfm_session', id: sessionId, did: ALICE, at: clock.nowMs() },
      { kind: 'lb_token', id: (lb.body as { id: string }).id, did: ALICE, at: clock.nowMs() },
    ]);

    // After: the session key is Last.fm error 9, the token is ListenBrainz's 401.
    const fmAfter = await call(app, 'GET', `/2.0/?method=user.getInfo&api_key=k&format=json&sk=${sk}`, {
      origin: null,
    });
    expect(fmAfter.status).toBe(403);
    expect(fmAfter.body).toEqual({ error: 9, message: 'Invalid session key - Please re-authenticate' });
    const lbAfter = await app.fetch('/1/submit-listens', {
      method: 'POST',
      headers: { authorization: `Token ${token}` },
    });
    expect(lbAfter.status).toBe(401);
    expect(await lbAfter.json()).toEqual({ code: 401, error: 'Invalid authorization token.' });

    // Deleting again is 404; the app password and the issued app delete the same way.
    const again = await call(app, 'DELETE', `/api/v1/account/lastfm-sessions/${sessionId}`, { as: alice });
    expectError(again, 404, 'not_found');
    const delPw = await call(app, 'DELETE', `/api/v1/account/app-passwords/${(pw.body as { id: string }).id}`, {
      as: alice,
    });
    const delApp = await call(app, 'DELETE', `/api/v1/account/lastfm-apps/${apiKey}`, { as: alice });
    expect([delPw.status, delApp.status]).toEqual([204, 204]);
    const relogin = getMobileSession(deps, { apiKey: 'panoScrobbler', username: 'alice.example.com', password });
    expect(relogin).toEqual({ ok: false, code: 4 });
    expect(issuedAppSecret({ db: app.db, box: createBox(app.secrets.encryptionKeys, seededRandom(5)) }, apiKey)).toBe(
      null,
    );
    expect(journal.entries().map((e) => e.kind)).toEqual(['lastfm_session', 'lb_token', 'app_password', 'lastfm_app']);
  });
});

describe('credential mutations need a session and CSRF (ADR §5.6)', () => {
  it('every credential mutation without a session is 401 and without CSRF is 403', async () => {
    const { app, clock, journal, signIn } = await world();
    const alice = signIn(ALICE, 'alice.example.com');
    const bob = signIn(BOB, 'bob.example.com');
    const random = seededRandom(77);
    const deps = {
      db: app.db,
      clock,
      random,
      revocations: journal,
      box: createBox(app.secrets.encryptionKeys, random),
    };
    const password = createAppPassword(deps, { did: ALICE, label: 'Pano' });
    const token = createLbToken(deps, { did: ALICE, label: 'Navi' });
    const issued = createLastfmApp(deps, { did: ALICE, name: 'mine' });
    const session = createSession(deps, { did: ALICE, apiKey: 'panoScrobbler', clientName: 'Pano' });

    const mutations: { method: string; path: string; body?: unknown }[] = [
      { method: 'POST', path: '/api/v1/account/app-passwords', body: { label: 'new' } },
      { method: 'POST', path: '/api/v1/account/listenbrainz-tokens', body: { label: 'new' } },
      { method: 'POST', path: '/api/v1/account/lastfm-apps', body: { name: 'new' } },
      { method: 'DELETE', path: `/api/v1/account/app-passwords/${password.id}` },
      { method: 'DELETE', path: `/api/v1/account/listenbrainz-tokens/${token.id}` },
      { method: 'DELETE', path: `/api/v1/account/lastfm-apps/${issued.apiKey}` },
      { method: 'DELETE', path: `/api/v1/account/lastfm-sessions/${session.id}` },
    ];
    const snapshot = () => ({
      app_passwords: count(app, 'app_passwords'),
      lb_tokens: count(app, 'lb_tokens'),
      lastfm_apps: count(app, 'lastfm_apps'),
      lastfm_sessions: count(app, 'lastfm_sessions'),
      sessions: app.db.all<{ expires_at_ms: number; last_seen_ms: number }>(
        'SELECT expires_at_ms, last_seen_ms FROM web_sessions ORDER BY did',
      ),
    });
    const before = snapshot();
    expect(before).toMatchObject({ app_passwords: 1, lb_tokens: 1, lastfm_apps: 1, lastfm_sessions: 1 });

    // Two days on, so an admitted request would renew the session: a refused one must not.
    clock.advance(2 * 24 * 60 * 60_000);
    const refusals: [string, CallOptions, number, string][] = [
      ['no cookie', {}, 401, 'unauthenticated'],
      ['unknown cookie', { as: { ...alice, cookie: `${SESSION_COOKIE}=${'0'.repeat(64)}` } }, 401, 'unauthenticated'],
      ['no X-CSRF-Token', { as: alice, csrf: false }, 403, 'csrf_failed'],
      ["another session's token", { as: alice, csrf: bob.csrf }, 403, 'csrf_failed'],
      ['malformed token', { as: alice, csrf: 'zz' }, 403, 'csrf_failed'],
      ['no Origin', { as: alice, origin: null }, 403, 'csrf_failed'],
      ['foreign Origin', { as: alice, origin: 'https://evil.example' }, 403, 'csrf_failed'],
    ];
    for (const m of mutations) {
      for (const [why, options, status, code] of refusals) {
        const answer = await call(app, m.method, m.path, { ...options, body: m.body });
        expect({ why, path: m.path, status: answer.status }).toEqual({ why, path: m.path, status });
        expectError(answer, status, code);
        expectContract(m.method, m.path, answer);
        expect(answer.headers.get('set-cookie')).toBeNull();
      }
    }
    // Nothing was created, deleted, journaled or renewed.
    expect(snapshot()).toEqual(before);
    expect(journal.entries()).toEqual([]);

    // The same requests with the session and its CSRF token are admitted (and renew the cookie).
    const admitted: Answer[] = [];
    for (const m of mutations) {
      const answer = await call(app, m.method, m.path, { as: alice, body: m.body });
      expect({ path: m.path, status: answer.status }).toEqual({
        path: m.path,
        status: m.method === 'POST' ? 201 : 204,
      });
      admitted.push(answer);
    }
    expect(admitted[0]?.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=${alice.token};`);
    expect(snapshot()).toMatchObject({ app_passwords: 1, lb_tokens: 1, lastfm_apps: 1, lastfm_sessions: 0 });
    expect(journal.entries().map((e) => e.kind)).toEqual(['app_password', 'lb_token', 'lastfm_app', 'lastfm_session']);
  });
});
