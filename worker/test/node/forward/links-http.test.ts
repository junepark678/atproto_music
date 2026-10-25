// Link routes (ADR 0005 §12.1, §5.6, §13, §14.5; api/openapi.yaml v1.2
// links_*; N3-08): the Last.fm web-auth link flow with single-use states
// bound to the web session, ListenBrainz token linking through
// validate-token, sealed credentials, PATCH and DELETE.
//
// The real composition (support/app.ts) over a migrated file database, the
// frozen clock 2026-01-15T12:00:00Z and a seeded Random; Last.fm and
// ListenBrainz are the fakes of support/ at lastfm.test and listenbrainz.test
// behind the fixture router (no network). Every JSON answer is checked
// against the contract with AJV (acceptance/support/openapi.ts).

import { createHash } from 'node:crypto';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { LinkedAccountRow } from '../../../src/app/rows';
import { csrfToken } from '../../../src/bff/csrf';
import { createWebSessions, SESSION_COOKIE, type WebSessions } from '../../../src/bff/sessions';
import { ensureAccount } from '../../../src/credentials/accounts';
import { type Box, BoxError, createBox, linkedAad } from '../../../src/crypto/box';
import { LINK_STATE_TTL_MS, sweepExpiredLinkStates } from '../../../src/forward/links';
import { linksFeature } from '../../../src/http/links';
import { parseSecrets } from '../../../src/node/secrets';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { checkResponse } from '../../acceptance/support/openapi';
import { closeApps, startApp, TEST_PUBLIC_ORIGIN, type TestApp, testSecretsDocument } from '../support/app';
import { FakeLastfm, md5Hex } from '../support/fake-lastfm';
import { FakeListenBrainz } from '../support/fake-listenbrainz';

const API_KEY = '0123456789abcdef0123456789abcdef';
const SECRET = 'owner-shared-secret-for-tests';
const ALICE = 'did:plc:alicealicealicealicealic';
const BOB = 'did:plc:bobbobbobbobbobbobbobbobb';
const UPSTREAM_ENV = {
  LASTFM_API_ROOT: 'https://lastfm.test/2.0/',
  LASTFM_AUTH_URL: 'https://lastfm.test/api/auth/',
  LISTENBRAINZ_API_ROOT: 'https://listenbrainz.test/',
};

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

interface World {
  app: TestApp;
  clock: FixedClock;
  lastfm: FakeLastfm;
  lb: FakeListenBrainz;
  journal: MemoryRevocations;
  sessions: WebSessions;
  box: Box;
  /** Cookie (and, for unsafe requests, Origin + X-CSRF-Token) headers of `token`. */
  headers(token: string, unsafe?: boolean): Record<string, string>;
  /** A new web session of `did`; returns its token. */
  signIn(did: string): string;
}

async function world(options: { lastfmKey?: boolean } = {}): Promise<World> {
  const clock = fixedClock();
  const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
  const lb = new FakeListenBrainz({ clock });
  const journal = new MemoryRevocations(clock);
  const doc = testSecretsDocument();
  const secrets = parseSecrets(
    options.lastfmKey === false ? doc : { ...doc, lastfm: { apiKey: API_KEY, sharedSecret: SECRET } },
  );
  const app = await startApp({
    clock,
    secrets,
    transport: routerTransport({ hosts: { 'lastfm.test': lastfm, 'listenbrainz.test': lb } }),
    features: [linksFeature({ revocations: journal })],
    env: UPSTREAM_ENV,
  });
  for (const did of [ALICE, BOB]) ensureAccount({ db: app.db, clock }, { did, verifiedHandle: null });
  const sessions = createWebSessions({ db: app.db, clock, random: seededRandom(42), revocations: journal });
  const box = createBox(secrets.encryptionKeys, seededRandom(3));
  return {
    app,
    clock,
    lastfm,
    lb,
    journal,
    sessions,
    box,
    headers: (token, unsafe = false) => ({
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(unsafe ? { origin: TEST_PUBLIC_ORIGIN, 'x-csrf-token': csrfToken(box.csrfKey(), token) } : {}),
    }),
    signIn: (did) => sessions.create(did).token,
  };
}

afterEach(async () => {
  await closeApps();
});

async function call(w: World, method: string, path: string, init: { token: string; body?: unknown }) {
  const unsafe = method !== 'GET';
  const res = await w.app.fetch(path, {
    method,
    headers: {
      ...w.headers(init.token, unsafe),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  const body = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
  return { res, body };
}

function links(w: World): LinkedAccountRow[] {
  return w.app.db.all<LinkedAccountRow>('SELECT * FROM linked_accounts ORDER BY created_at_ms, id');
}

function linkStates(w: World): Array<{ state_hash: string; did: string; session_hash: string; expires_at_ms: number }> {
  return w.app.db.all(
    'SELECT lower(hex(state_hash)) AS state_hash, did, lower(hex(session_hash)) AS session_hash, expires_at_ms FROM link_states',
  );
}

function bytes(blob: ArrayBuffer | Uint8Array): Uint8Array {
  return blob instanceof Uint8Array ? blob : new Uint8Array(blob);
}

function containsText(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle, 'utf8'));
}

/** POST start for `token`; returns the state carried by the cb. */
async function startLastfm(w: World, token: string): Promise<{ state: string; authorizeUrl: URL }> {
  const { res, body } = await call(w, 'POST', '/api/v1/links/lastfm/start', { token });
  expect(res.status).toBe(200);
  expect(checkResponse('POST', '/api/v1/links/lastfm/start', { status: res.status, headers: res.headers, body })).toBe(
    'valid',
  );
  const authorizeUrl = new URL(body?.authorizeUrl as string);
  const cb = new URL(authorizeUrl.searchParams.get('cb') as string);
  return { state: cb.searchParams.get('state') as string, authorizeUrl };
}

describe('link routes', () => {
  it('Last.fm link start returns LASTFM_AUTH_URL with our api_key and a cb carrying a single-use state; the callback calls signed auth.getSession and stores the sk sealed; reusing the state is 400', async () => {
    const w = await world();
    const token = w.signIn(ALICE);

    const { state, authorizeUrl } = await startLastfm(w, token);
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe('https://lastfm.test/api/auth/');
    expect([...authorizeUrl.searchParams.keys()]).toEqual(['api_key', 'cb']);
    expect(authorizeUrl.searchParams.get('api_key')).toBe(API_KEY);
    const cb = new URL(authorizeUrl.searchParams.get('cb') as string);
    expect(`${cb.origin}${cb.pathname}`).toBe(`${TEST_PUBLIC_ORIGIN}/api/v1/links/lastfm/callback`);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    // Stored only as hashes, bound to this session's token hash, valid 600 s.
    expect(linkStates(w)).toEqual([
      {
        state_hash: sha256Hex(state),
        did: ALICE,
        session_hash: sha256Hex(token),
        expires_at_ms: w.clock.nowMs() + LINK_STATE_TTL_MS,
      },
    ]);
    expect(LINK_STATE_TTL_MS).toBe(600_000);

    // The user approves on Last.fm; Last.fm redirects back with ?state&token.
    const lfToken = w.lastfm.issueToken(undefined, API_KEY);
    w.lastfm.authorizeToken(lfToken, 'alice_fm');
    const callback = `/api/v1/links/lastfm/callback?state=${state}&token=${lfToken}`;
    const first = await w.app.fetch(callback, { headers: w.headers(token) });
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe('/settings/links');

    // One signed auth.getSession, which the fake accepted only because api_sig verified.
    const getSession = w.lastfm.calls.filter({ nsid: 'auth.getSession' });
    expect(getSession).toHaveLength(1);
    expect(getSession[0]?.status).toBe(200);
    expect(getSession[0]?.method).toBe('POST');
    expect(getSession[0]?.params.api_key).toEqual([API_KEY]);
    expect(getSession[0]?.params.api_sig?.[0]).toMatch(/^[0-9a-f]{32}$/);

    // The sk is stored sealed: the ciphertext opens to the session key under this row's AAD only.
    const sk = md5Hex('fake-lastfm-session:alice_fm:1');
    const [row, ...rest] = links(w);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      did: ALICE,
      service: 'lastfm',
      remote_user: 'alice_fm',
      status: 'active',
      key_id: 'e1',
    });
    const sealed = bytes(row?.credential_ciphertext as ArrayBuffer);
    expect(containsText(sealed, sk)).toBe(false);
    expect(w.box.openText('linked-lastfm', sealed, linkedAad(ALICE, 'lastfm'))).toBe(sk);
    expect(() => w.box.openText('linked-lastfm', sealed, linkedAad(BOB, 'lastfm'))).toThrow(BoxError);
    expect(linkStates(w)).toEqual([]);

    // Reusing the state: 400, no second upstream call, the link unchanged.
    const again = await w.app.fetch(callback, { headers: w.headers(token) });
    expect(again.status).toBe(400);
    const againBody = (await again.json()) as { error: { code: string } };
    expect(checkResponse('GET', callback, { status: 400, headers: again.headers, body: againBody })).toBe('valid');
    expect(againBody.error.code).toBe('bad_request');
    expect(w.lastfm.calls.count({ nsid: 'auth.getSession' })).toBe(1);
    expect(links(w)).toEqual([row]);
    // A malformed query (a repeated state) is 400 as well, before any state is looked at.
    const repeated = await w.app.fetch(`${callback}&state=${state}`, { headers: w.headers(token) });
    expect(repeated.status).toBe(400);
    const repeatedBody = (await repeated.json()) as { error: { code: string } };
    expect(checkResponse('GET', callback, { status: 400, headers: repeated.headers, body: repeatedBody })).toBe(
      'valid',
    );
    expect(repeatedBody.error.code).toBe('bad_request');
    expect(w.lastfm.calls.count({ nsid: 'auth.getSession' })).toBe(1);

    // The list shows the link without its credential.
    const list = await call(w, 'GET', '/api/v1/links', { token });
    expect(list.res.status).toBe(200);
    expect(checkResponse('GET', '/api/v1/links', { status: 200, headers: list.res.headers, body: list.body })).toBe(
      'valid',
    );
    expect(list.body).toEqual({
      items: [
        {
          id: row?.id,
          service: 'lastfm',
          remoteUser: 'alice_fm',
          forwardScrobbles: true,
          forwardNowPlaying: true,
          status: 'active',
          lastError: null,
          createdAt: '2026-01-15T12:00:00.000Z',
          updatedAt: '2026-01-15T12:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(list.body)).not.toContain(sk);
    // No log line carries the sk or the Last.fm token of the callback query.
    expect(w.app.log.lines.join('\n')).not.toContain(sk);
    expect(w.app.log.lines.join('\n')).not.toContain(lfToken);
  });

  it('a ListenBrainz token is validated upstream; an invalid one is 422; a valid one is stored sealed with user_name', async () => {
    const w = await world();
    const token = w.signIn(ALICE);
    const lbToken = '5c7f3a3e-2f1d-4c1b-9a77-0d1e2f3a4b5c';
    w.lb.addToken('Alice_LB', lbToken);

    const bad = await call(w, 'POST', '/api/v1/links/listenbrainz', {
      token,
      body: { token: 'ffffffff-ffff-4fff-bfff-ffffffffffff' },
    });
    expect(bad.res.status).toBe(422);
    expect(
      checkResponse('POST', '/api/v1/links/listenbrainz', { status: 422, headers: bad.res.headers, body: bad.body }),
    ).toBe('valid');
    expect((bad.body as { error: { fields?: Record<string, string> } }).error.fields).toHaveProperty('token');
    expect(w.lb.calls.count({ path: '/1/validate-token' })).toBe(1);
    expect(links(w)).toEqual([]);

    const good = await call(w, 'POST', '/api/v1/links/listenbrainz', { token, body: { token: lbToken } });
    expect(good.res.status).toBe(201);
    expect(
      checkResponse('POST', '/api/v1/links/listenbrainz', { status: 201, headers: good.res.headers, body: good.body }),
    ).toBe('valid');
    expect(good.body).toMatchObject({
      service: 'listenbrainz',
      remoteUser: 'Alice_LB',
      status: 'active',
      forwardScrobbles: true,
      forwardNowPlaying: true,
    });
    expect(w.lb.calls.filter({ path: '/1/validate-token' }).map((c) => c.status)).toEqual([200, 200]);

    const [row] = links(w);
    expect(row).toMatchObject({ id: good.body?.id, did: ALICE, service: 'listenbrainz', remote_user: 'Alice_LB' });
    const sealed = bytes(row?.credential_ciphertext as ArrayBuffer);
    expect(containsText(sealed, lbToken)).toBe(false);
    expect(w.box.openText('linked-listenbrainz', sealed, linkedAad(ALICE, 'listenbrainz'))).toBe(lbToken);
    expect(() => w.box.openText('linked-lastfm', sealed, linkedAad(ALICE, 'listenbrainz'))).toThrow(BoxError);
    expect(JSON.stringify(good.body)).not.toContain(lbToken);

    // A malformed body is refused before any upstream call.
    const unknownField = await call(w, 'POST', '/api/v1/links/listenbrainz', {
      token,
      body: { token: lbToken, user: 'x' },
    });
    expect(unknownField.res.status).toBe(422);
    expect(w.lb.calls.count({ path: '/1/validate-token' })).toBe(2);
    // Without CSRF the route is 403 and validates nothing.
    const noCsrf = await w.app.fetch('/api/v1/links/listenbrainz', {
      method: 'POST',
      headers: { ...w.headers(token), 'content-type': 'application/json' },
      body: JSON.stringify({ token: lbToken }),
    });
    expect(noCsrf.status).toBe(403);
    expect(w.lb.calls.count({ path: '/1/validate-token' })).toBe(2);
  });

  it('PATCH toggles forwarding; DELETE removes the credential and its queued rows; without the owner Last.fm key, Last.fm linking is 503 lastfm_not_configured', async () => {
    const w = await world();
    const token = w.signIn(ALICE);
    w.lb.addToken('alice', 'lb-token-1');
    const created = await call(w, 'POST', '/api/v1/links/listenbrainz', { token, body: { token: 'lb-token-1' } });
    const id = created.body?.id as string;

    const patched = await call(w, 'PATCH', `/api/v1/links/${id}`, { token, body: { forwardScrobbles: false } });
    expect(patched.res.status).toBe(200);
    expect(
      checkResponse('PATCH', `/api/v1/links/${id}`, { status: 200, headers: patched.res.headers, body: patched.body }),
    ).toBe('valid');
    expect(patched.body).toMatchObject({ id, forwardScrobbles: false, forwardNowPlaying: true });
    expect(links(w)[0]).toMatchObject({ forward_scrobbles: 0, forward_now_playing: 1 });

    // The flags decide which rows enqueueForwards (N2-05) creates.
    const random = seededRandom(5);
    const now = w.clock.nowMs();
    const scrobble = {
      kind: 'scrobble' as const,
      listenKey: 'lk-1',
      payload: { listen: { artist: 'A', track: 'T', listenedAt: '2026-01-15T11:55:00Z' } },
    };
    const nowPlaying = {
      kind: 'nowplaying' as const,
      startedAtMs: now,
      artist: 'A',
      track: 'T',
      payload: { track: { artist: 'A', track: 'T' }, startedAtMs: now },
    };
    expect(enqueueForwards(w.app.db, { did: ALICE, items: [scrobble, nowPlaying], now, random })).toBe(1);
    expect(w.app.db.all('SELECT kind FROM forward_outbox')).toEqual([{ kind: 'nowplaying' }]);

    const restored = await call(w, 'PATCH', `/api/v1/links/${id}`, { token, body: { forwardScrobbles: true } });
    expect(restored.body).toMatchObject({ forwardScrobbles: true, forwardNowPlaying: true });
    expect(enqueueForwards(w.app.db, { did: ALICE, items: [scrobble], now, random })).toBe(1);
    expect(w.app.db.one<{ n: number }>('SELECT count(*) AS n FROM forward_outbox WHERE link_id = ?', id)?.n).toBe(2);

    // Invalid patches and other owners' links.
    expect(
      (await call(w, 'PATCH', `/api/v1/links/${id}`, { token, body: { forwardScrobbles: 'no' } })).res.status,
    ).toBe(422);
    expect((await call(w, 'PATCH', `/api/v1/links/${id}`, { token, body: {} })).res.status).toBe(422);
    const bobToken = w.signIn(BOB);
    const foreign = await call(w, 'PATCH', `/api/v1/links/${id}`, {
      token: bobToken,
      body: { forwardScrobbles: false },
    });
    expect(foreign.res.status).toBe(404);
    expect((await call(w, 'DELETE', `/api/v1/links/${id}`, { token: bobToken })).res.status).toBe(404);
    expect(links(w)).toHaveLength(1);
    expect(w.journal.entries()).toEqual([]);

    // DELETE: 204, the credential and every queued row gone, the deletion journaled.
    const deleted = await call(w, 'DELETE', `/api/v1/links/${id}`, { token });
    expect(deleted.res.status).toBe(204);
    expect(deleted.body).toBeNull();
    expect(links(w)).toEqual([]);
    expect(w.app.db.one<{ n: number }>('SELECT count(*) AS n FROM forward_outbox')?.n).toBe(0);
    expect(w.journal.entries()).toEqual([{ kind: 'linked_account', id, did: ALICE, at: w.clock.nowMs() }]);
    expect((await call(w, 'DELETE', `/api/v1/links/${id}`, { token })).res.status).toBe(404);

    // Without the owner's Last.fm key.
    const bare = await world({ lastfmKey: false });
    const bareToken = bare.signIn(ALICE);
    const start = await call(bare, 'POST', '/api/v1/links/lastfm/start', { token: bareToken });
    expect(start.res.status).toBe(503);
    expect(
      checkResponse('POST', '/api/v1/links/lastfm/start', {
        status: 503,
        headers: start.res.headers,
        body: start.body,
      }),
    ).toBe('valid');
    expect((start.body as { error: { code: string } }).error.code).toBe('lastfm_not_configured');
    expect(linkStates(bare)).toEqual([]);
    const callback = await bare.app.fetch(
      `/api/v1/links/lastfm/callback?state=${'a'.repeat(64)}&token=${'b'.repeat(32)}`,
      {
        headers: bare.headers(bareToken),
      },
    );
    expect(callback.status).toBe(503);
    const callbackBody = (await callback.json()) as { error: { code: string } };
    expect(
      checkResponse('GET', '/api/v1/links/lastfm/callback', {
        status: 503,
        headers: callback.headers,
        body: callbackBody,
      }),
    ).toBe('valid');
    expect(callbackBody.error.code).toBe('lastfm_not_configured');
    expect(bare.lastfm.calls.count()).toBe(0);
    expect(links(bare)).toEqual([]);
    // ListenBrainz linking does not need the Last.fm key.
    bare.lb.addToken('alice', 'lb-token-2');
    expect(
      (await call(bare, 'POST', '/api/v1/links/listenbrainz', { token: bareToken, body: { token: 'lb-token-2' } })).res
        .status,
    ).toBe(201);
  });

  it('a Last.fm link callback whose state belongs to another session is 403 and stores nothing', async () => {
    const w = await world();
    const owner = w.signIn(ALICE);
    const { state } = await startLastfm(w, owner);
    const lfToken = w.lastfm.issueToken(undefined, API_KEY);
    w.lastfm.authorizeToken(lfToken, 'alice_fm');
    const before = linkStates(w);
    const callback = `/api/v1/links/lastfm/callback?state=${state}&token=${lfToken}`;

    // Another session of the same DID, and a session of another DID.
    for (const intruder of [w.signIn(ALICE), w.signIn(BOB)]) {
      const res = await w.app.fetch(callback, { headers: w.headers(intruder) });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(checkResponse('GET', '/api/v1/links/lastfm/callback', { status: 403, headers: res.headers, body })).toBe(
        'valid',
      );
      expect(body.error.code).toBe('csrf_failed');
    }
    // Nothing stored and nothing sent upstream; the state is untouched.
    expect(links(w)).toEqual([]);
    expect(w.lastfm.calls.count()).toBe(0);
    expect(linkStates(w)).toEqual(before);
    // Without any session the callback is 401 and touches nothing either.
    const anonymous = await w.app.fetch(callback);
    expect(anonymous.status).toBe(401);
    const anonymousBody = (await anonymous.json()) as { error: { code: string } };
    expect(checkResponse('GET', callback, { status: 401, headers: anonymous.headers, body: anonymousBody })).toBe(
      'valid',
    );
    expect(anonymousBody.error.code).toBe('unauthenticated');
    expect(linkStates(w)).toEqual(before);

    // The session that started the flow can still complete it.
    const done = await w.app.fetch(callback, { headers: w.headers(owner) });
    expect(done.status).toBe(303);
    expect(links(w).map((l) => [l.did, l.remote_user])).toEqual([[ALICE, 'alice_fm']]);

    // An expired state is refused like a used one.
    const { state: late } = await startLastfm(w, owner);
    w.clock.advance(LINK_STATE_TTL_MS);
    const expired = await w.app.fetch(`/api/v1/links/lastfm/callback?state=${late}&token=${lfToken}`, {
      headers: w.headers(owner),
    });
    expect(expired.status).toBe(400);
    const expiredBody = (await expired.json()) as { error: { code: string } };
    expect(checkResponse('GET', callback, { status: 400, headers: expired.headers, body: expiredBody })).toBe('valid');
    expect(expiredBody.error.code).toBe('bad_request');
    expect(w.lastfm.calls.count({ nsid: 'auth.getSession' })).toBe(1);
    // Abandoned states are removed by the expiry sweep once they are past 600 s.
    await startLastfm(w, owner);
    expect(sweepExpiredLinkStates(w.app.db, w.clock.nowMs())).toBe(0);
    w.clock.advance(LINK_STATE_TTL_MS);
    expect(sweepExpiredLinkStates(w.app.db, w.clock.nowMs())).toBe(1);
    expect(linkStates(w)).toEqual([]);
  });
});
