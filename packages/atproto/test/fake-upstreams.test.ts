// N1-09: the fake OAuth AS and the fake PDS write additions (ADR 0005 §5.10,
// §15.2). Every assertion goes through HTTP responses of the fakes over the
// router transport, the repositories' signed state, or the fakes' logs.

import {
  CLIENT_METADATA_TTL_MS,
  FakeOAuthAs,
  FIXTURE_CLIENT_KEYS,
  FIXTURE_DPOP_KEYS,
  FixtureOAuthClient,
  fixtureClientApp,
} from '@atmusic/atproto/test-support/fake-oauth-as';
import { FakePds, fixtureToken } from '@atmusic/atproto/test-support/fake-pds';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { createFixtureKit, FIXTURE_USERS, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { cidOf, SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';

const P = 'com.example.atmusic';
const SCROBBLE = `${P}.scrobble`;
const LOVE = `${P}.love`;
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const PDS_HOST = 'pds-alice.example.test';
const T0_SEC = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;

type Json = Record<string, unknown>;

const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (s: string | Uint8Array<ArrayBuffer>) =>
  hex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? new TextEncoder().encode(s) : s));
const json = async (res: Response) => (await res.json()) as Json;

const scrobble = (n: number | string, extra: Json = {}) => ({
  $type: SCROBBLE,
  artist: 'Artist',
  track: `Track ${n}`,
  listenedAt: '2026-01-15T11:00:00.000Z',
  ...extra,
});

/** The fake AS, a fixture client app, and one PDS with Alice (auth dpop) and Bob (fixture auth). */
async function world(o: { clock?: FixedClock; aliceAuth?: 'dpop' | 'fixture' } = {}) {
  const clock = o.clock ?? fixedClock();
  const random = seededRandom(9);
  const keys = await fixtureKeys();
  const as = new FakeOAuthAs({ clock, random });
  const app = fixtureClientApp({ scope: `atproto repo:${SCROBBLE}` });
  const pds = new FakePds(PDS_HOST, { clock, authorizationServer: as });
  const alice = new SignedRepo(ALICE, keys.alice, { clock });
  const bob = new SignedRepo(BOB, keys.bob, { clock });
  await pds.addAccount(alice, { handle: 'alice.test', auth: o.aliceAuth ?? 'dpop' });
  await pds.addAccount(bob, { handle: 'bob.test' });
  as.addAccount(ALICE, { handle: 'alice.test' });
  const transport = routerTransport({ pds: [pds], hosts: { [as.host]: as, [app.host]: app } });
  as.connect(transport);
  const client = new FixtureOAuthClient({ app, transport, clock, random });
  const xrpc = (nsid: string, body: unknown, auth?: string) =>
    transport(
      new Request(`${pds.origin}/xrpc/${nsid}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  return { clock, random, as, app, pds, alice, bob, transport, client, xrpc };
}

function parForm(app: { redirectUri: string }) {
  return {
    response_type: 'code',
    redirect_uri: app.redirectUri,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    state: 'st',
    scope: `atproto repo:${SCROBBLE}`,
  };
}

it("fake AS issues tokens only for a private_key_jwt assertion signed by a key in the client's jwks_uri; a replayed jti or 61 s old assertion is invalid_client", async () => {
  const w = await world();
  const { as, app, client, clock } = w;
  const metadataFetches = () => app.calls.count({ path: '/oauth/client-metadata.json' });
  const jwksFetches = () => app.calls.count({ path: '/oauth/jwks.json' });
  const invalidClient = async (res: Response, description: RegExp) => {
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('invalid_client');
    expect(String(body.error_description)).toMatch(description);
  };

  // k2 is not in the client's jwks_uri (which publishes k1 only).
  const parK2 = await client.par({ assertion: await client.assertion({ key: FIXTURE_CLIENT_KEYS.k2 }) });
  await invalidClient(parK2.res, /no key "k2" in the client's jwks_uri/);
  expect(parK2.requestUri).toBeNull();
  expect([metadataFetches(), jwksFetches()]).toEqual([1, 1]);
  // Claiming kid k1 while signing with k3's private key fails verification.
  const forged = await client.assertion({ key: { ...FIXTURE_CLIENT_KEYS.k3, kid: 'k1' } });
  await invalidClient((await client.par({ assertion: forged })).res, /signature verification failed/);
  // An assertion for another audience.
  await invalidClient(
    (await client.par({ assertion: await client.assertion({ aud: 'https://other-as.test' }) })).res,
    /unexpected "aud"/,
  );
  expect(as.sessions()).toEqual([]);

  // The k1 flow works: PAR 201, authorize 303 with code, state and iss, token 200.
  const par = await client.par({ loginHint: 'alice.test' });
  expect(par.res.status).toBe(201);
  expect(par.body).toEqual({
    request_uri: expect.stringMatching(/^urn:ietf:params:oauth:request_uri:req-/),
    expires_in: 300,
  });
  const auth = await client.authorize(par.requestUri!);
  expect(auth.res.status).toBe(303);
  expect(auth.params.get('state')).toBe(par.state);
  expect(auth.params.get('iss')).toBe('https://as.test');
  const tokenRes = await client.exchange(auth.params.get('code')!, par.verifier);
  expect(tokenRes.status).toBe(200);
  const tokens = await json(tokenRes);
  expect(tokens).toEqual({
    access_token: expect.stringMatching(/^at-[0-9a-f]{64}$/),
    token_type: 'DPoP',
    refresh_token: expect.stringMatching(/^ref-[0-9a-f]{64}$/),
    scope: `atproto repo:${SCROBBLE}`,
    sub: ALICE,
    expires_in: 3600,
  });
  expect(as.sessions(ALICE).map((s) => [s.clientKid, s.refreshCount])).toEqual([['k1', 0]]);
  // Metadata and JWKS were fetched once, through the router transport, and cached.
  expect([metadataFetches(), jwksFetches()]).toEqual([1, 1]);

  // A replayed jti is invalid_client, even on an otherwise valid refresh.
  const once = await client.assertion({ jti: 'jti-once' });
  const refreshed = await client.refresh(String(tokens.refresh_token), { assertion: once });
  expect(refreshed.status).toBe(200);
  const next = await json(refreshed);
  await invalidClient(await client.refresh(String(next.refresh_token), { assertion: once }), /jti reused/);
  expect(as.sessions(ALICE)[0]!.refreshCount).toBe(1);

  // The assertion age rule: 60 s old passes, 61 s old is invalid_client (exp set far enough not to matter).
  const now = Math.floor(clock.nowMs() / 1000);
  const at60 = await client.refresh(String(next.refresh_token), {
    assertion: await client.assertion({ iatSec: now - 60, expInSec: 120 }),
  });
  expect(at60.status).toBe(200);
  const latest = await json(at60);
  await invalidClient(
    await client.refresh(String(latest.refresh_token), {
      assertion: await client.assertion({ iatSec: now - 61, expInSec: 120 }),
    }),
    /"iat" claim timestamp check failed \(too far in the past\)/,
  );
  await invalidClient(
    await client.refresh(String(latest.refresh_token), { assertion: await client.assertion({ iatSec: now + 5 }) }),
    /it should be in the past/,
  );
  expect(as.sessions(ALICE)[0]!.refreshCount).toBe(2);

  // Publishing k2 does not help until the 10-minute client metadata cache expires.
  app.keys = [FIXTURE_CLIENT_KEYS.k1, FIXTURE_CLIENT_KEYS.k2];
  clock.advance(CLIENT_METADATA_TTL_MS - 1000);
  const k2 = () => client.assertion({ key: FIXTURE_CLIENT_KEYS.k2 });
  await invalidClient((await client.par({ assertion: await k2() })).res, /no key "k2"/);
  expect([metadataFetches(), jwksFetches()]).toEqual([1, 1]);
  clock.advance(1000);
  const parAfter = await client.par({ assertion: await k2() });
  expect(parAfter.res.status).toBe(201);
  expect([metadataFetches(), jwksFetches()]).toEqual([2, 2]);
  // A scripted OAuth error on PAR stores no request.
  as.failOAuth('/oauth/par', 'server_error', 'down', 503);
  const failed = await client.par();
  expect([failed.res.status, failed.body, failed.requestUri]).toEqual([
    503,
    { error: 'server_error', error_description: 'down' },
    null,
  ]);
  // Every successful token response came from a verified assertion: one session, never a second.
  expect(as.sessions()).toHaveLength(1);
});

it('fake AS rotates DPoP nonces, refreshes, answers invalid_grant for a revoked refresh token and records revocations', async () => {
  const w = await world();
  const { as, app, client, clock } = w;
  const tokenStatuses = () => as.calls.filter({ path: '/oauth/token' }).map((c) => c.status);

  // No nonce yet: PAR answers 400 use_dpop_nonce with a DPoP-Nonce header and stores nothing.
  const first = await client.post('par', parForm(app), { retry: false });
  expect(first.status).toBe(400);
  expect(await json(first)).toMatchObject({ error: 'use_dpop_nonce' });
  const n1 = first.headers.get('dpop-nonce');
  expect(n1).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // With it, the whole sign-in needs no retry: one more PAR, one token request.
  const s1 = await client.signIn('alice.test');
  expect(as.count('/oauth/par')).toBe(2);
  expect(tokenStatuses()).toEqual([200]);

  // A handed-out nonce stays valid for up to three 60 s rotations.
  clock.advance(120_000);
  const r1 = await client.refresh(s1.refresh_token);
  expect(r1.status).toBe(200);
  expect(tokenStatuses()).toEqual([200, 200]);
  const t1 = await json(r1);
  expect(t1.access_token).not.toBe(s1.access_token);
  expect(t1.refresh_token).not.toBe(s1.refresh_token);
  expect(as.introspect(s1.access_token)).toMatchObject({ active: false, reason: 'rotated' });
  expect(as.introspect(String(t1.access_token))).toMatchObject({ active: true, sub: ALICE });
  const stale = client.nonces.get('https://as.test')!;
  clock.advance(180_000);
  // Three rotations later the stored nonce is refused once, and the retry with the new one succeeds.
  const r2 = await client.refresh(String(t1.refresh_token));
  expect(r2.status).toBe(200);
  expect(tokenStatuses()).toEqual([200, 200, 400, 200]);
  expect(client.nonces.get('https://as.test')).not.toBe(stale);
  const t2 = await json(r2);
  // A forced rotation does the same.
  as.rotateNonces();
  const r3 = await client.refresh(String(t2.refresh_token));
  expect(r3.status).toBe(200);
  expect(tokenStatuses()).toEqual([200, 200, 400, 200, 400, 200]);
  const t3 = await json(r3);
  expect(as.sessions(ALICE)[0]!.refreshCount).toBe(3);

  const invalidGrant = async (res: Response, description: string) => {
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid_grant', error_description: description });
  };

  // Revocation endpoint: the refresh token is dead afterwards, and so is its access token.
  expect((await client.revoke(String(t3.refresh_token))).status).toBe(200);
  await invalidGrant(await client.refresh(String(t3.refresh_token)), 'Invalid refresh token');
  expect(as.introspect(String(t3.access_token))).toMatchObject({ active: false, reason: 'revoked' });

  // The user revoking the app at the AS.
  const s2 = await client.signIn('alice.test');
  expect(as.revokeSession(ALICE)).toBe(1);
  await invalidGrant(await client.refresh(s2.refresh_token), 'Invalid refresh token');

  // A replayed (rotated-out) refresh token revokes the session it belonged to.
  const s3 = await client.signIn('alice.test');
  const rotated = await json(await client.refresh(s3.refresh_token));
  await invalidGrant(await client.refresh(s3.refresh_token), 'Refresh token replayed');
  await invalidGrant(await client.refresh(String(rotated.refresh_token)), 'Invalid refresh token');

  // A refresh with the DPoP key of another session is a binding mismatch.
  const s4 = await client.signIn('alice.test');
  client.dpopKey = FIXTURE_DPOP_KEYS[1];
  await invalidGrant(await client.refresh(s4.refresh_token), 'DPoP proof does not match the expected JKT');
  client.dpopKey = FIXTURE_DPOP_KEYS[0];

  // Revoking an unknown token is 200 and still recorded.
  expect((await client.revoke('at-unknown')).status).toBe(200);

  const sessions = as.sessions(ALICE);
  expect(sessions.map((s) => s.revoked?.source)).toEqual([
    'endpoint',
    'operator',
    'refresh_replay',
    'binding_mismatch',
  ]);
  expect(
    as.revocations.map((r) => [
      r.source,
      r.sub,
      r.tokenType,
      r.known,
      r.sessionId === null ? null : sessions.findIndex((s) => s.id === r.sessionId),
    ]),
  ).toEqual([
    ['endpoint', ALICE, 'refresh_token', true, 0],
    ['operator', ALICE, null, true, 1],
    ['refresh_replay', ALICE, null, true, 2],
    ['binding_mismatch', ALICE, null, true, 3],
    ['endpoint', null, null, false, null],
  ]);
  expect(as.revocations.every((r) => r.atMs === clock.nowMs())).toBe(true);
});

it('fake PDS applyWrites is atomic (one existing rkey fails all 200) and rejects 201 writes and bodies over 1,000,000 bytes', async () => {
  const w = await world({ aliceAuth: 'fixture' });
  const { pds, alice, xrpc } = w;
  const token = `Bearer ${fixtureToken(ALICE)}`;
  /** Each commit the PDS's write endpoints made, as its ops. */
  const commits: string[][] = [];
  pds.onCommit((_did, c) => commits.push(c.ops.map((op) => `${op.action} ${op.rkey}`)));
  const create = (rkey: string, value: unknown = scrobble(rkey)) => ({
    $type: 'com.atproto.repo.applyWrites#create',
    collection: SCROBBLE,
    rkey,
    value,
  });
  const rk = (i: number) => `r${String(i).padStart(3, '0')}`;
  const applyWrites = (writes: unknown[]) => xrpc('com.atproto.repo.applyWrites', { repo: ALICE, writes }, token);
  const listed = async () => (await alice.list(SCROBBLE)).map((r) => r.rkey);

  expect(
    (
      await xrpc(
        'com.atproto.repo.createRecord',
        { repo: ALICE, collection: SCROBBLE, rkey: 'r100', record: scrobble(100) },
        token,
      )
    ).status,
  ).toBe(200);
  const head = alice.head!;
  expect(commits).toHaveLength(1);

  // One existing rkey among 200 creates: 400, and nothing at all is written.
  let res = await applyWrites(Array.from({ length: 200 }, (_, i) => create(rk(i))));
  expect(res.status).toBe(400);
  expect(await json(res)).toEqual({
    error: 'RecordAlreadyExists',
    message: `Record already exists: at://${ALICE}/${SCROBBLE}/r100`,
  });
  expect(alice.head).toEqual(head);
  expect(await listed()).toEqual(['r100']);
  expect(commits).toHaveLength(1);

  // 201 writes are refused before anything is checked or written.
  res = await applyWrites(Array.from({ length: 201 }, (_, i) => create(`n${String(i).padStart(3, '0')}`)));
  expect(res.status).toBe(400);
  expect(await json(res)).toEqual({ error: 'InvalidRequest', message: 'Too many writes. Max: 200' });
  expect(await listed()).toEqual(['r100']);

  // Bodies: exactly 1,000,000 bytes is accepted, 1,000,001 bytes is 413.
  const padded = (rkey: string, totalBytes: number) => {
    const shape = (pad: string) =>
      JSON.stringify({ repo: ALICE, writes: [create(rkey, scrobble(rkey, { comment: pad }))] });
    const body = shape('x'.repeat(totalBytes - shape('').length));
    expect(new TextEncoder().encode(body).length).toBe(totalBytes);
    return body;
  };
  res = await xrpc('com.atproto.repo.applyWrites', padded('big1', 1_000_001), token);
  expect(res.status).toBe(413);
  expect(await json(res)).toEqual({ error: 'PayloadTooLarge', message: 'request entity too large' });
  expect(await listed()).toEqual(['r100']);
  res = await xrpc('com.atproto.repo.applyWrites', padded('big0', 1_000_000), token);
  expect(res.status).toBe(200);
  expect(await listed()).toEqual(['big0', 'r100']);
  expect(commits).toHaveLength(2);

  // 200 new creates in one call: one signed commit holding all 200, with per-write results.
  const fresh = Array.from({ length: 200 }, (_, i) => rk(200 + i));
  res = await applyWrites(fresh.map((r) => create(r)));
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.commit).toEqual({ cid: alice.head!.cid, rev: alice.head!.rev });
  const results = body.results as Json[];
  expect(results).toHaveLength(200);
  expect(results[0]).toEqual({
    $type: 'com.atproto.repo.applyWrites#createResult',
    uri: `at://${ALICE}/${SCROBBLE}/r200`,
    cid: cidOf(scrobble('r200')),
    validationStatus: 'unknown',
  });
  for (const [i, r] of fresh.entries()) {
    expect((await alice.getRecord(SCROBBLE, r))?.cid).toBe(results[i]!.cid);
  }
  expect(commits).toHaveLength(3);
  expect(commits[2]).toEqual(fresh.map((r) => `create ${r}`));
  expect(alice.history).toHaveLength(4); // initial commit, r100, big0, the batch
  expect(await listed()).toEqual(['big0', 'r100', ...fresh]);

  // Mixed batch: create, update and delete in one commit; an update of an absent record fails it all.
  res = await applyWrites([
    create('m1'),
    { $type: 'com.atproto.repo.applyWrites#update', collection: SCROBBLE, rkey: 'r200', value: scrobble('u') },
    { $type: 'com.atproto.repo.applyWrites#update', collection: SCROBBLE, rkey: 'absent', value: scrobble('u') },
  ]);
  expect(res.status).toBe(400);
  expect((await json(res)).error).toBe('RecordNotFound');
  expect(await alice.getRecord(SCROBBLE, 'm1')).toBeNull();
  res = await applyWrites([
    create('m1'),
    { $type: 'com.atproto.repo.applyWrites#update', collection: SCROBBLE, rkey: 'r200', value: scrobble('u') },
    { $type: 'com.atproto.repo.applyWrites#delete', collection: SCROBBLE, rkey: 'r201' },
  ]);
  expect(res.status).toBe(200);
  expect(((await json(res)).results as Json[]).map((r) => r.$type)).toEqual([
    'com.atproto.repo.applyWrites#createResult',
    'com.atproto.repo.applyWrites#updateResult',
    'com.atproto.repo.applyWrites#deleteResult',
  ]);
  expect(alice.head!.cid).not.toBe(head.cid);
  expect((await alice.getRecord(SCROBBLE, 'r200'))?.cid).toBe(cidOf(scrobble('u')));
  expect(await alice.getRecord(SCROBBLE, 'r201')).toBeNull();
  expect(commits).toHaveLength(4);
  expect(commits[3]).toEqual(['create m1', 'update r200', 'delete r201']);
  expect(alice.history).toHaveLength(5);
});

it('fake PDS RateLimit-Remaining drops by 3 per create and answers 429 with RateLimit-Reset when exhausted', async () => {
  const clock = fixedClock();
  const keys = await fixtureKeys();
  const pds = new FakePds(PDS_HOST, { clock, rateLimits: [{ name: 'repo-write-hour', points: 9, windowSec: 3600 }] });
  const repo = new SignedRepo(ALICE, keys.alice, { clock });
  await pds.addAccount(repo);
  const t = routerTransport({ pds: [pds] });
  const write = (nsid: string, body: Json) =>
    t(
      new Request(`${pds.origin}/xrpc/${nsid}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${fixtureToken(ALICE)}` },
        body: JSON.stringify({ repo: ALICE, ...body }),
      }),
    );
  const create = (rkey: string) =>
    write('com.atproto.repo.createRecord', { collection: SCROBBLE, rkey, record: scrobble(rkey) });
  const limits = (res: Response) =>
    ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'ratelimit-policy'].map((h) => res.headers.get(h));
  const reset = String(T0_SEC + 3600);

  const seen: (string | null)[][] = [];
  for (const rkey of ['a', 'b', 'c']) {
    const res = await create(rkey);
    expect(res.status).toBe(200);
    seen.push(limits(res));
  }
  expect(seen).toEqual([
    ['9', '6', reset, '9;w=3600'],
    ['9', '3', reset, '9;w=3600'],
    ['9', '0', reset, '9;w=3600'],
  ]);
  expect(pds.pointsRemaining(ALICE)).toBe(0);

  // Exhausted: 429 with RateLimit-Reset, and nothing is written; a 1-point delete is refused too.
  clock.advance(60_000);
  const headBefore = repo.head!.cid;
  let res = await create('d');
  expect(res.status).toBe(429);
  expect(await json(res)).toEqual({ error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' });
  expect(limits(res)).toEqual(['9', '0', reset, '9;w=3600']);
  res = await write('com.atproto.repo.deleteRecord', { collection: SCROBBLE, rkey: 'a' });
  expect(res.status).toBe(429);
  expect(repo.head!.cid).toBe(headBefore);
  expect((await repo.list(SCROBBLE)).map((r) => r.rkey)).toEqual(['a', 'b', 'c']);

  // At RateLimit-Reset the window starts again.
  clock.set('2026-01-15T13:00:00Z');
  res = await create('d');
  expect(res.status).toBe(200);
  expect(limits(res)).toEqual(['9', '6', String(T0_SEC + 7200), '9;w=3600']);

  // With the default limits the hour window (5,000) is the tightest; applyWrites costs 3 + 3 + 2 + 1.
  const pds2 = new FakePds('pds-two.example.test', { clock });
  await pds2.addAccount(new SignedRepo(ALICE, keys.alice, { clock }));
  const t2 = routerTransport({ pds: [pds2] });
  const write2 = (nsid: string, body: Json) =>
    t2(
      new Request(`${pds2.origin}/xrpc/${nsid}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${fixtureToken(ALICE)}` },
        body: JSON.stringify({ repo: ALICE, ...body }),
      }),
    );
  res = await write2('com.atproto.repo.createRecord', { collection: SCROBBLE, rkey: 'x', record: scrobble('x') });
  expect(limits(res)).toEqual(['5000', '4997', String(T0_SEC + 7200), '5000;w=3600']);
  res = await write2('com.atproto.repo.applyWrites', {
    writes: [
      { $type: 'com.atproto.repo.applyWrites#create', collection: SCROBBLE, rkey: 'y', value: scrobble('y') },
      { $type: 'com.atproto.repo.applyWrites#create', collection: SCROBBLE, rkey: 'z', value: scrobble('z') },
      { $type: 'com.atproto.repo.applyWrites#update', collection: SCROBBLE, rkey: 'x', value: scrobble('x2') },
      { $type: 'com.atproto.repo.applyWrites#delete', collection: SCROBBLE, rkey: 'y' },
    ],
  });
  expect(res.status).toBe(200);
  expect(limits(res)).toEqual(['5000', '4988', String(T0_SEC + 7200), '5000;w=3600']);
  expect(pds2.pointsRemaining(ALICE)).toBe(4988);
});

it('existing fake PDS getRecord, getBlocks and getRepo responses for the read-model fixture are byte-identical to before', async () => {
  const kit = await createFixtureKit();
  const seed = await seedReadModels(kit);
  const lines: string[] = [];
  const statuses: number[] = [];
  const add = async (label: string, url: string) => {
    const res = await kit.transport(new Request(url));
    const body = new Uint8Array(await res.arrayBuffer());
    const headers = [...res.headers]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join(';');
    statuses.push(res.status);
    lines.push(`${label}|${res.status}|${headers}|${body.length}|${await sha256Hex(body)}`);
  };
  for (const n of FIXTURE_USERS) {
    const u = kit.users[n];
    await add(`sync.getRepo ${n}`, `${u.origin}/xrpc/com.atproto.sync.getRepo?did=${u.did}`);
    const own = [...seed.records.values()].filter((r) => r.did === u.did && r.state === 'present');
    const cids = [kit.repos[n].head!.cid, ...own.map((r) => r.cid)];
    await add(
      `sync.getBlocks ${n}`,
      `${u.origin}/xrpc/com.atproto.sync.getBlocks?did=${u.did}&${cids.map((c) => `cids=${c}`).join('&')}`,
    );
    await add(
      `sync.getRecord ${n} absent`,
      `${u.origin}/xrpc/com.atproto.sync.getRecord?did=${u.did}&collection=${kit.collections.scrobble}&rkey=zzzzzzzzzzzzz`,
    );
  }
  for (const r of seed.records.values()) {
    const u = kit.user(r.did);
    const q = `collection=${r.collection}&rkey=${r.rkey}`;
    await add(`sync.getRecord ${r.uri}`, `${u.origin}/xrpc/com.atproto.sync.getRecord?did=${r.did}&${q}`);
    if (r.state === 'present') {
      await add(`repo.getRecord ${r.uri}`, `${u.origin}/xrpc/com.atproto.repo.getRecord?repo=${r.did}&${q}`);
    }
  }
  expect(statuses.every((s) => s === 200)).toBe(true);
  expect(lines).toHaveLength(30);
  // Captured from the fake PDS before N1-09 changed it (status, every header, body bytes of all 30 responses).
  expect(await sha256Hex(lines.join('\n'))).toBe('1a5621c167e214b8321805838d30d0c2ccfb65193409d66324d5911e97beb128');
});

it('an account added with auth dpop rejects the fixture Bearer token and accepts a DPoP-bound token from the fake AS, while an account added without auth still accepts fixtureToken', async () => {
  const w = await world();
  const { as, pds, alice, bob, client, transport, xrpc, clock } = w;
  const createBody = (repo: string, rkey: string, collection = SCROBBLE) => ({
    repo,
    collection,
    rkey,
    record: { ...scrobble(rkey), $type: collection },
  });
  const url = (nsid: string) => `${pds.origin}/xrpc/${nsid}`;
  const errorOf = async (res: Response) => [res.status, (await json(res)).error];

  // The PDS names the fake AS as its authorization server.
  const prm = await transport(new Request(`${pds.origin}/.well-known/oauth-protected-resource`));
  expect(await json(prm)).toMatchObject({ resource: pds.origin, authorization_servers: ['https://as.test'] });

  // Alice (auth dpop): her fixture token is refused for createRecord, deleteRecord and applyWrites, as Bearer or DPoP.
  const fixture = fixtureToken(ALICE);
  expect(
    await errorOf(await xrpc('com.atproto.repo.createRecord', createBody(ALICE, 'a1'), `Bearer ${fixture}`)),
  ).toEqual([401, 'InvalidToken']);
  expect(
    await errorOf(await xrpc('com.atproto.repo.createRecord', createBody(ALICE, 'a1'), `DPoP ${fixture}`)),
  ).toEqual([401, 'InvalidToken']);
  expect(
    await errorOf(
      await xrpc(
        'com.atproto.repo.deleteRecord',
        { repo: ALICE, collection: SCROBBLE, rkey: 'a1' },
        `Bearer ${fixture}`,
      ),
    ),
  ).toEqual([401, 'InvalidToken']);
  expect(
    await errorOf(await xrpc('com.atproto.repo.applyWrites', { repo: ALICE, writes: [] }, `Bearer ${fixture}`)),
  ).toEqual([401, 'InvalidToken']);
  expect(alice.history).toHaveLength(1);

  // A DPoP-bound token from the fake AS works; the first write learns the PDS nonce (401 use_dpop_nonce) and is retried.
  const tokens = await client.signIn('alice.test');
  let res = await client.resource(
    url('com.atproto.repo.createRecord'),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody(ALICE, 'a1')) },
    tokens.access_token,
  );
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({
    uri: `at://${ALICE}/${SCROBBLE}/a1`,
    cid: cidOf(createBody(ALICE, 'a1').record),
  });
  const creates = pds.calls.filter({ nsid: 'com.atproto.repo.createRecord', did: ALICE }).map((c) => c.status);
  expect(creates).toEqual([401, 401, 401, 200]);
  expect(res.headers.get('dpop-nonce')).toBe(client.nonces.get(pds.origin));
  expect(res.headers.get('ratelimit-remaining')).toBe('4997');

  // deleteRecord and applyWrites with the same token (the nonce is known now: no retries).
  res = await client.resource(
    url('com.atproto.repo.applyWrites'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: ALICE,
        writes: [
          { $type: 'com.atproto.repo.applyWrites#create', collection: SCROBBLE, rkey: 'a2', value: scrobble('a2') },
        ],
      }),
    },
    tokens.access_token,
  );
  expect(res.status).toBe(200);
  res = await client.resource(
    url('com.atproto.repo.deleteRecord'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: ALICE, collection: SCROBBLE, rkey: 'a2' }),
    },
    tokens.access_token,
  );
  expect(res.status).toBe(200);
  expect((await alice.list(SCROBBLE)).map((r) => r.rkey)).toEqual(['a1']);

  // The access token alone (Bearer, no proof), a proof by another key, or a proof without ath are refused.
  const withProof = async (proof: string | null, scheme = 'DPoP') =>
    transport(
      new Request(url('com.atproto.repo.createRecord'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `${scheme} ${tokens.access_token}`,
          ...(proof === null ? {} : { dpop: proof }),
        },
        body: JSON.stringify(createBody(ALICE, 'a3')),
      }),
    );
  expect(await errorOf(await withProof(null, 'Bearer'))).toEqual([401, 'InvalidToken']);
  res = await withProof(null);
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toMatch(/^DPoP error="invalid_dpop_proof"/);
  res = await withProof(
    await client.proof('POST', url('com.atproto.repo.createRecord'), {
      key: FIXTURE_DPOP_KEYS[1],
      accessToken: tokens.access_token,
    }),
  );
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toMatch(/^DPoP error="invalid_token"/);
  res = await withProof(await client.proof('POST', url('com.atproto.repo.createRecord')));
  expect(await errorOf(res)).toEqual([401, 'invalid_dpop_proof']);
  // Alice's token cannot write Bob's repo, nor a collection outside its scope.
  res = await client.resource(
    url('com.atproto.repo.createRecord'),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody(BOB, 'b9')) },
    tokens.access_token,
  );
  expect(await errorOf(res)).toEqual([403, 'Forbidden']);
  res = await client.resource(
    url('com.atproto.repo.createRecord'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody(ALICE, 'l1', LOVE)),
    },
    tokens.access_token,
  );
  expect(await errorOf(res)).toEqual([403, 'ScopeMissingError']);
  expect((await alice.list(SCROBBLE)).map((r) => r.rkey)).toEqual(['a1']);
  expect(await alice.list(LOVE)).toEqual([]);

  // An expired access token is invalid_token (the client would refresh); a revoked one too.
  clock.advance(3600_000);
  res = await client.resource(
    url('com.atproto.repo.createRecord'),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody(ALICE, 'a4')) },
    tokens.access_token,
  );
  expect(await errorOf(res)).toEqual([401, 'ExpiredToken']);
  expect(res.headers.get('www-authenticate')).toMatch(/^DPoP error="invalid_token"/);
  const fresh = await json(await client.refresh(tokens.refresh_token));
  as.revokeSession(ALICE);
  res = await client.resource(
    url('com.atproto.repo.createRecord'),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody(ALICE, 'a5')) },
    String(fresh.access_token),
  );
  expect(await errorOf(res)).toEqual([401, 'InvalidToken']);
  expect((await alice.list(SCROBBLE)).map((r) => r.rkey)).toEqual(['a1']);

  // Bob (added without auth) still writes with fixtureToken, as before.
  expect(pds.account(BOB).auth).toBe('fixture');
  res = await xrpc('com.atproto.repo.createRecord', createBody(BOB, 'b1'), `Bearer ${fixtureToken(BOB)}`);
  expect(res.status).toBe(200);
  expect(await json(res)).toEqual({
    uri: `at://${BOB}/${SCROBBLE}/b1`,
    cid: cidOf(createBody(BOB, 'b1').record),
    commit: { cid: bob.head!.cid, rev: bob.head!.rev },
    validationStatus: 'unknown',
  });
});
