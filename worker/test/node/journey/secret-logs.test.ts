// Secret capture over the journeys (ADR 0005 §3.10 "Request logs", §7.3,
// §13, §15.4 "Secret-in-log capture"; N4-01).
//
// The whole production process runs in-process (journey/world.ts) with a
// capturing logger that has NO redaction list, so any credential that reached
// a log call at all would be in `w.log.lines`. One run drives every flow that
// handles a credential:
//   - the web sign-in (binding cookie, authorization code and state, session
//     cookie, CSRF token) and a web scrobble;
//   - Pano's mobile flow (app password → auth.getMobileSession → sk) and its
//     scrobble;
//   - the Last.fm desktop flow: auth.getToken, /api/auth/?api_key&token,
//     the /lastfm/authorize page, the cookie approval, auth.getSession;
//   - the Last.fm web flow: /api/auth?api_key&cb, the approval, auth.getSession;
//   - the Last.fm link callback (?state&token) and the ListenBrainz link;
//   - a ListenBrainz token, validate-token and a submit;
//   - and the refusals that carry credentials in their requests: a replayed
//     OAuth callback, a replayed link callback, a wrong sk, a wrong app
//     password, a consumed token, an unknown ListenBrainz token, a write
//     without CSRF.
// Every value seen is then searched for in every log line and in every error
// body (test 1), and in every public /api/v1, /2.0 and /1 read (test 2).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testSecretsDocument } from '../support/app';
import { md5Hex } from '../support/fake-lastfm';
import {
  closeWorlds,
  LASTFM_SECRET,
  lastfmSig,
  PANO,
  SCROBBLE,
  type Signed,
  startWorld,
  T0,
  type User,
  type World,
} from './world';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await closeWorlds();
  vi.useRealTimers();
});

const T0_S = T0 / 1000;
const LB_LINK_TOKEN = 'alice-listenbrainz-user-token-0001';

interface Run {
  w: World;
  alice: User;
  session: Signed;
  sks: string[];
  lbToken: string;
  /** Every credential value the run saw, labelled. */
  secrets: Map<string, string>;
}

function add(secrets: Map<string, string>, label: string, value: string | null | undefined): void {
  if (typeof value !== 'string' || value.length < 8) throw new Error(`${label}: no usable secret value (${value})`);
  secrets.set(value, label);
}

async function journeys(): Promise<Run> {
  const { w, alice } = await startWorld();
  const secrets = new Map<string, string>();

  // The web sign-in and a web scrobble.
  const session = await w.signIn(alice);
  const scrobbled = await w.send('POST', '/api/v1/scrobbles', {
    as: session,
    body: { artist: 'Björk', track: 'Hunter', listenedAt: '2026-01-15T11:50:00Z' },
    headers: { 'idempotency-key': 'secret-logs-1' },
  });
  expect(scrobbled.status).toBe(202);

  // Pano's mobile flow.
  const created = await w.send('POST', '/api/v1/account/app-passwords', { as: session, body: { label: 'Pano' } });
  expect(created.status).toBe(201);
  const password = (created.body as { password: string }).password;
  add(secrets, 'app password', password);
  add(secrets, 'app password (lowercase)', password.toLowerCase());
  const mobile = await w.lastfm2({ method: 'auth.getMobileSession', username: alice.handle, password });
  expect(mobile.status).toBe(200);
  const sk = (mobile.body as { session: { key: string } }).session.key;
  add(secrets, 'sk (mobile)', sk);
  const lfScrobble = await w.lastfm2({
    method: 'track.scrobble',
    sk,
    'artist[0]': 'Portishead',
    'track[0]': 'Roads',
    'timestamp[0]': String(T0_S - 900),
  });
  expect(lfScrobble.status).toBe(200);

  // The Last.fm desktop flow.
  const tokenAnswer = await w.lastfm2({ method: 'auth.getToken' });
  expect(tokenAnswer.status).toBe(200);
  const desktopToken = (tokenAnswer.body as { token: string }).token;
  add(secrets, 'desktop token', desktopToken);
  const redirect = await w.send('GET', `/api/auth/?api_key=${PANO}&token=${desktopToken}`);
  expect(redirect.status).toBe(302);
  const page = redirect.headers.get('location') as string;
  expect(page).toBe(`/lastfm/authorize?api_key=${PANO}&token=${desktopToken}`);
  // The approval page itself is the SPA's (web/, N5); whatever answers it never echoes the query.
  await w.send('GET', page);
  const approved = await w.send('POST', '/api/v1/lastfm/authorize', {
    as: session,
    body: { apiKey: PANO, token: desktopToken },
  });
  expect(approved.status).toBe(200);
  const desktopSession = await w.lastfm2({ method: 'auth.getSession', token: desktopToken });
  expect(desktopSession.status).toBe(200);
  const desktopSk = (desktopSession.body as { session: { key: string } }).session.key;
  add(secrets, 'sk (desktop)', desktopSk);

  // The Last.fm web flow (multi-scrobbler's slash-less form with a cb).
  const cb = 'http://localhost:9078/lastfm/callback?state=client-state-123456';
  const webRedirect = await w.send('GET', `/api/auth?api_key=${PANO}&cb=${encodeURIComponent(cb)}`);
  expect(webRedirect.status).toBe(302);
  await w.send('GET', webRedirect.headers.get('location') as string);
  const webApproved = await w.send('POST', '/api/v1/lastfm/authorize', { as: session, body: { apiKey: PANO } });
  expect(webApproved.status).toBe(200);
  const webToken = (webApproved.body as { token: string }).token;
  add(secrets, 'web flow token', webToken);
  const webSession = await w.lastfm2({ method: 'auth.getSession', token: webToken });
  expect(webSession.status).toBe(200);
  const webSk = (webSession.body as { session: { key: string } }).session.key;
  add(secrets, 'sk (web flow)', webSk);

  // The Last.fm link (its callback query carries the state and Last.fm's token) and the ListenBrainz link.
  const start = await w.send('POST', '/api/v1/links/lastfm/start', { as: session });
  expect(start.status).toBe(200);
  const linkCb = new URL(
    new URL((start.body as { authorizeUrl: string }).authorizeUrl).searchParams.get('cb') as string,
  );
  add(secrets, 'link state', linkCb.searchParams.get('state'));
  const lfToken = w.lastfm.issueToken();
  add(secrets, 'Last.fm link token', lfToken);
  w.lastfm.authorizeToken(lfToken, 'alice_fm');
  const callbackPath = `${linkCb.pathname}${linkCb.search}&token=${lfToken}`;
  expect((await w.send('GET', callbackPath, { as: session })).status).toBe(303);
  add(secrets, 'linked Last.fm sk', md5Hex('fake-lastfm-session:alice_fm:1'));
  w.lb.addToken('alice_lb', LB_LINK_TOKEN);
  add(secrets, 'linked ListenBrainz token', LB_LINK_TOKEN);
  const lbLink = await w.send('POST', '/api/v1/links/listenbrainz', { as: session, body: { token: LB_LINK_TOKEN } });
  expect(lbLink.status).toBe(201);

  // A ListenBrainz token of ours, validate-token and a submit.
  const lbCreated = await w.send('POST', '/api/v1/account/listenbrainz-tokens', {
    as: session,
    body: { label: 'Navidrome' },
  });
  expect(lbCreated.status).toBe(201);
  const lbToken = (lbCreated.body as { token: string }).token;
  add(secrets, 'ListenBrainz token', lbToken);
  const auth = { authorization: `Token ${lbToken}` };
  expect((await w.send('GET', '/1/validate-token', { headers: auth })).status).toBe(200);
  expect((await w.send('GET', `/1/validate-token?token=${lbToken}`)).status).toBe(200);
  const submitted = await w.send('POST', '/1/submit-listens', {
    headers: auth,
    body: {
      listen_type: 'single',
      payload: [{ listened_at: T0_S - 1200, track_metadata: { artist_name: 'Aphex Twin', track_name: 'Xtal' } }],
    },
  });
  expect(submitted.status).toBe(200);

  // The timers: the outbox writes with the DPoP session, forwarding signs with the owner's secret.
  await w.until(
    () =>
      w.count('scrobbles', 'did = ?', alice.did) === 3 &&
      w.lastfm.scrobbles.length >= 1 &&
      w.lb.submissions.some((s) => s.listenType === 'single'),
  );

  // Refusals whose requests carry credentials.
  const replay = w.lastCallback as { path: string; binding: string };
  const replayed = await w.send('GET', replay.path, { headers: { cookie: `__Host-atmusic_oauth=${replay.binding}` } });
  expect(replayed.status).toBe(403);
  expect((await w.send('GET', callbackPath, { as: session })).status).toBe(400);
  const forgedSk = 'f'.repeat(32);
  add(secrets, 'forged sk', forgedSk);
  const wrongSk = await w.lastfm2({ method: 'track.updateNowPlaying', sk: forgedSk, artist: 'A', track: 'B' });
  expect(wrongSk.status).toBe(403);
  const wrongPassword = 'WRONGWRONGWRONGWRONGWRON';
  add(secrets, 'wrong app password', wrongPassword);
  const refusedLogin = await w.lastfm2({
    method: 'auth.getMobileSession',
    username: alice.handle,
    password: wrongPassword,
  });
  expect(refusedLogin.status).toBe(403);
  expect((await w.lastfm2({ method: 'auth.getSession', token: desktopToken })).status).toBeGreaterThanOrEqual(400);
  const forgedLb = 'not-a-real-listenbrainz-token-0002';
  add(secrets, 'forged ListenBrainz token', forgedLb);
  const unknownLb = await w.send('POST', '/1/submit-listens', {
    headers: { authorization: `Token ${forgedLb}` },
    body: { listen_type: 'single', payload: [] },
  });
  expect(unknownLb.status).toBe(401);
  const noCsrf = await w.send('POST', '/api/v1/scrobbles', {
    headers: { cookie: `__Host-atmusic_session=${session.token}`, 'idempotency-key': 'secret-logs-2' },
    body: { artist: 'X', track: 'Y', listenedAt: '2026-01-15T11:00:00Z' },
  });
  expect(noCsrf.status).toBe(403);

  // What the sign-in handled, the OAuth session's tokens and DPoP key, and the process's own keys.
  for (const value of w.credentials) add(secrets, 'sign-in credential', value);
  const oauth = w.server.features.oauth();
  const saved = oauth?.sessionStore.get(alice.did);
  add(secrets, 'OAuth access token', saved?.tokenSet.access_token);
  add(secrets, 'OAuth refresh token', saved?.tokenSet.refresh_token);
  add(secrets, 'DPoP private key', (saved?.dpopJwk as { d?: string } | undefined)?.d);
  const doc = testSecretsDocument() as {
    cursorKey: string;
    encryptionKeys: Array<{ key: string }>;
    oauthSigningKeys: Array<{ d: string }>;
  };
  add(secrets, 'client signing key', doc.oauthSigningKeys[0]?.d);
  add(secrets, 'encryption key', doc.encryptionKeys[0]?.key);
  add(secrets, 'cursor key', doc.cursorKey);
  add(secrets, 'owner Last.fm shared secret', LASTFM_SECRET);

  return { w, alice, session, sks: [sk, desktopSk, webSk], lbToken, secrets };
}

/** The labels of the secrets `text` contains. */
function leaks(secrets: Map<string, string>, text: string): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const [value, label] of secrets) if (lower.includes(value.toLowerCase())) found.push(label);
  return found;
}

describe('secrets in logs and bodies', () => {
  it('no captured log line or error body from the journeys, including the Last.fm desktop flow (auth.getToken, /api/auth, /lastfm/authorize, approve, getSession), the web flow and the Last.fm link callback, contains any token, sk, app password, cookie, DPoP key or client key value seen in the run', async () => {
    const run = await journeys();
    const { w, secrets } = run;
    expect(secrets.size).toBeGreaterThanOrEqual(25);

    // The run produced logs: one request line per answer the run received (with the Last.fm method
    // name only), plus the process, sign-in, Jetstream and snapshot events.
    expect(w.log.logs.filter((l) => l.event === 'request')).toHaveLength(w.seen.length);
    expect(w.seen.length).toBeGreaterThanOrEqual(30);
    const lastfmCalls = w.seen.filter((s) => s.path.startsWith('/2.0')).length;
    expect(lastfmCalls).toBe(8);
    expect(w.log.logs.filter((l) => l.event === 'request' && typeof l.lastfmMethod === 'string')).toHaveLength(
      lastfmCalls,
    );
    const events = new Set(w.log.logs.map((l) => l.event));
    for (const event of ['oauth_authorize', 'run.ready', 'run.signin_reconciled']) expect(events).toContain(event);
    const leakedLines = w.log.lines.flatMap((line) => leaks(secrets, line).map((label) => `${label}: ${line}`));
    expect(leakedLines).toEqual([]);
    // No log line carries a query string of the credential-bearing routes.
    for (const line of w.log.lines) {
      expect(line).not.toMatch(/[?&](token|state|code|sk|api_sig|password|cb)=/);
    }

    // Every error answer the run received, the refusals above included.
    const errors = w.seen.filter((s) => s.status >= 400);
    expect(errors.length).toBeGreaterThanOrEqual(8);
    const leakedBodies = errors.flatMap((e) =>
      leaks(secrets, e.text).map((label) => `${label}: ${e.method} ${e.status}`),
    );
    expect(leakedBodies).toEqual([]);
    // The redirects carry the query to the approval page only (Location), never in a body.
    for (const s of w.seen.filter((x) => x.status === 302 || x.status === 303))
      expect(leaks(secrets, s.text)).toEqual([]);
  }, 120_000);

  it('with sessions, sk values, app passwords, ListenBrainz tokens and linked credentials seeded, no public /api/v1, /2.0 or /1 response body in the journeys contains any of those values', async () => {
    const run = await journeys();
    const { w, alice, secrets } = run;
    expect(w.count('web_sessions', 'did = ?', alice.did)).toBeGreaterThanOrEqual(1);
    expect(w.count('lastfm_sessions', 'did = ?', alice.did)).toBe(3);
    expect(w.count('app_passwords', 'did = ?', alice.did)).toBe(1);
    expect(w.count('lb_tokens', 'did = ?', alice.did)).toBe(1);
    expect(w.count('linked_accounts', "did = ? AND status = 'active'", alice.did)).toBe(2);

    const uri = w.db.one<{ uri: string }>('SELECT uri FROM scrobbles WHERE did = ? ORDER BY uri LIMIT 1', alice.did)
      ?.uri as string;
    expect(uri.startsWith(`at://${alice.did}/${SCROBBLE}/`)).toBe(true);
    const user = alice.handle;
    const reads: Array<{ path: string; headers?: Record<string, string> }> = [
      { path: '/api/v1/meta' },
      { path: `/api/v1/resolve?handle=${alice.handle}` },
      { path: `/api/v1/users/${alice.did}/scrobbles` },
      { path: `/api/v1/users/${alice.did}/stats` },
      { path: `/api/v1/users/${alice.did}/profile` },
      { path: `/api/v1/users/${alice.did}/following` },
      { path: `/api/v1/users/${alice.did}/followers` },
      { path: `/api/v1/users/${alice.did}/export` },
      { path: `/api/v1/scrobbles/${encodeURIComponent(uri)}` },
      { path: `/api/v1/records/status?uri=${encodeURIComponent(uri)}` },
      { path: `/api/v1/feed?dids=${alice.did}` },
      { path: `/1/user/${user}/listens` },
      { path: `/1/user/${user}/playing-now` },
      { path: `/1/user/${user}/listen-count` },
      { path: `/1/stats/user/${user}/artists?range=all_time` },
      { path: `/1/stats/user/${user}/recordings?range=all_time` },
      { path: `/1/user/${user}/following` },
      { path: `/1/user/${user}/followers` },
      { path: '/1/validate-token', headers: { authorization: `Token ${run.lbToken}` } },
      { path: `/1/user/${user}/listens`, headers: { authorization: `Token ${run.lbToken}` } },
    ];
    const lastfmReads = [
      'user.getRecentTracks',
      'user.getInfo',
      'user.getTopArtists',
      'user.getTopTracks',
      'user.getLovedTracks',
      'user.getFriends',
      'library.getArtists',
    ];
    for (const method of lastfmReads) {
      reads.push({ path: `/2.0/?method=${method}&user=${user}&api_key=${PANO}&format=json` });
      // A read may carry an sk (to identify the caller): it is never echoed.
      for (const sk of run.sks) {
        const params: Record<string, string> = { method, user, api_key: PANO, sk };
        params.api_sig = lastfmSig(params, PANO);
        reads.push({ path: `/2.0/?${new URLSearchParams({ ...params, format: 'json' }).toString()}` });
      }
    }
    reads.push({
      path: `/2.0/?method=track.getInfo&artist=Portishead&track=Roads&username=${user}&api_key=${PANO}&format=json`,
    });

    let ok = 0;
    for (const read of reads) {
      const res = await w.send('GET', read.path, { ...(read.headers === undefined ? {} : { headers: read.headers }) });
      if (res.status === 200) ok++;
      expect(leaks(secrets, res.text), `${read.path} → ${res.status}`).toEqual([]);
    }
    // The reads answered with content (not a wall of errors), so the scan saw real bodies.
    expect(ok).toBeGreaterThanOrEqual(reads.length - 4);
    const recent = await w.lastfmRead({ method: 'user.getRecentTracks', user });
    expect((recent.body as { recenttracks: { track: unknown[] } }).recenttracks.track.length).toBe(3);
  }, 120_000);
});
