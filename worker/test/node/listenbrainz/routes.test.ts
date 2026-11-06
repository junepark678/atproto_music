// N3-06: the /1/ dispatcher (ADR 0005 §8.1, §8.2, §8.6, §8.7): CORS and
// OPTIONS, the `{code, error}` 404 and 405 for every other /1/ path, the
// credential-first per-IP and per-token limits, the registry argument
// through which N3-05's routes are mounted, and the social reads.
//
// The whole composition runs in-process (support/app.ts) on 127.0.0.1:0 with
// client-IP mode `none`, so every request comes from the peer 127.0.0.1 (one
// per-IP bucket). The frozen clock 2026-01-15T12:00:00Z never moves unless a
// test advances it, so no bucket refills behind a test's back. Fixture records
// (tests/fixtures/read_models.json) are applied through the production
// verifier and apply path; Alice is the account `alice` and holds a real
// ListenBrainz token.

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { followRkey } from '@atmusic/atproto/test-support/read-models';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import { MemoryRevocations } from '../../../src/app/revocations';
import { ensureAccount, renameAccount } from '../../../src/credentials/accounts';
import { createLbToken } from '../../../src/credentials/lb-tokens';
import type { Db } from '../../../src/do/db';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { LB_RATE_LIMITED_MESSAGE, lbPreflight, lbTooManyRequests } from '../../../src/listenbrainz/errors';
import { ListenBrainzLimiter } from '../../../src/listenbrainz/limiter';
import { rateLimitHeaders } from '../../../src/listenbrainz/rate-headers';
import {
  LB_METHOD_NOT_ALLOWED_MESSAGE,
  LB_NOT_FOUND_MESSAGE,
  type LbRequest,
  type LbRouteDef,
  listenBrainzRoutes,
  routerLimiterFor,
} from '../../../src/listenbrainz/routes';
import { closeApps, startApp, type TestApp } from '../support/app';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
const FOLLOW = `${PREFIX}.follow`;
const ALICE = fixture.users.Alice.did;
const BOB = fixture.users.Bob.did;
const CAROL = fixture.users.Carol.did;
const NOW_ISO = '2026-01-15T12:00:00Z';
const NOW_NS = fromMs(Date.parse(NOW_ISO));
const OPTS = { receiptNs: NOW_NS, prefix: PREFIX, nowNs: NOW_NS };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-max-age': '21600',
};
const EXPOSE = 'X-RateLimit-Remaining,X-RateLimit-Limit,X-RateLimit-Reset,X-RateLimit-Reset-In';

function seedUser(db: Db, did: string, handle: string): void {
  db.run(
    `INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, ?, 1, 'active', 'current', 1)`,
    did,
    handle,
    toStorage(NOW_NS),
  );
}

async function apply(db: Db, repo: SignedRepo, collection: string, rkey: string): Promise<void> {
  const car = await repo.getRecordCar(collection, rkey);
  const proof = await verifyRecordProof(car, { did: repo.did, collection, rkey, signingKey: repo.key.didKey });
  const outcome = db.tx(() => applyRecordProof(db, proof, OPTS)).outcome;
  expect(outcome).toBe(proof.state === 'present' ? 'applied' : 'absent');
}

interface Rig {
  app: TestApp;
  clock: FixedClock;
  token: string;
  repos: Map<string, SignedRepo>;
  /** Calls of the registry route, with what the router handed it. */
  registryCalls: LbRequest[];
}

async function started(extraRegistry: readonly LbRouteDef[] = []): Promise<Rig> {
  const clock = fixedClock(NOW_ISO);
  const registryCalls: LbRequest[] = [];
  // A stand-in for N3-05's POST /1/submit-listens, mounted through the registry argument.
  const submit: LbRouteDef = {
    method: 'POST',
    pattern: '/1/submit-listens',
    auth: 'required',
    async handler(_req, _ctx, _params, lb) {
      registryCalls.push(lb);
      return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'content-type': 'application/json' } });
    },
  };
  const app = await startApp({ clock, routes: listenBrainzRoutes({ registry: [submit, ...extraRegistry] }) });
  const db = app.db;
  seedUser(db, ALICE, fixture.users.Alice.handle);
  seedUser(db, BOB, fixture.users.Bob.handle);
  seedUser(db, CAROL, fixture.users.Carol.handle);
  const keys = await fixtureKeys();
  const repos = new Map([
    [ALICE, new SignedRepo(ALICE, keys.alice, { clock: fixedClock() })],
    [BOB, new SignedRepo(BOB, keys.bob, { clock: fixedClock() })],
    [CAROL, new SignedRepo(CAROL, keys.carol, { clock: fixedClock() })],
  ]);
  for (const s of fixture.scrobbles) {
    const repo = repos.get(s.owner);
    if (repo === undefined) continue;
    await repo.put(SCROBBLE, s.rkey, { ...s.record });
    await apply(db, repo, SCROBBLE, s.rkey);
  }
  // The fixture follow: Alice → Bob at its deterministic rkey.
  for (const f of fixture.follows) {
    const repo = repos.get(f.actor)!;
    const rkey = await followRkey(f.subject);
    await repo.put(FOLLOW, rkey, { $type: FOLLOW, subject: f.subject, createdAt: '2025-01-01T00:00:00Z' });
    await apply(db, repo, FOLLOW, rkey);
  }
  const deps = { db, clock, random: seededRandom(11), revocations: new MemoryRevocations(clock) };
  ensureAccount(deps, { did: ALICE, verifiedHandle: fixture.users.Alice.handle });
  expect(renameAccount(deps, { did: ALICE, username: 'alice' })).toMatchObject({ ok: true });
  const { token } = createLbToken(deps, { did: ALICE, label: 'test' });
  return { app, clock, token, repos, registryCalls };
}

function expectCors(res: Response): void {
  for (const [name, value] of Object.entries(CORS)) expect(res.headers.get(name)).toBe(value);
}

afterEach(closeApps);

describe('the /1/ dispatcher (ADR §8.1, §8.7)', () => {
  it('OPTIONS is 200 with the CORS set; unknown /1/ paths are 404 {code,error}; per-IP 30/10 s and per-token 100/10 s limits answer 429 with headers', async () => {
    const { app, clock, token, registryCalls } = await started();

    // OPTIONS on known paths: 200, empty body, the CORS set and the path's methods.
    for (const [path, allow] of [
      ['/1/user/alice/listens', 'GET, OPTIONS'],
      ['/1/stats/user/alice/daily-activity', 'GET, OPTIONS'],
      ['/1/feedback/recording-feedback', 'OPTIONS, POST'],
      ['/1/submit-listens', 'OPTIONS, POST'],
    ] as const) {
      const res = await app.fetch(path, { method: 'OPTIONS' });
      expect(res.status).toBe(200);
      expectCors(res);
      expect(res.headers.get('allow')).toBe(allow);
      expect(res.headers.get('access-control-allow-methods')).toBe(allow);
      expect(await res.text()).toBe('');
    }

    // Every other /1/ path is ListenBrainz's {code, error} 404 with the CORS set, never the /api/v1 envelope.
    for (const path of [
      '/1/',
      '/1/nope',
      '/1/latest-import',
      '/1/stats/sitewide/artists',
      '/1/stats/user/alice/artist-map',
      '/1/metadata/recording/',
      '/1/user/alice/listens/extra',
      '/1/a/b/c/d/e/f/g/h/i/j',
    ]) {
      const res = await app.fetch(path);
      expect([path, res.status]).toEqual([path, 404]);
      expectCors(res);
      expect(await res.json()).toEqual({ code: 404, error: LB_NOT_FOUND_MESSAGE });
    }
    const unknownPreflight = await app.fetch('/1/nope', { method: 'OPTIONS' });
    expect([unknownPreflight.status, await unknownPreflight.json()]).toEqual([
      404,
      { code: 404, error: LB_NOT_FOUND_MESSAGE },
    ]);
    // A known path with another method: 405 with Allow.
    const wrong = await app.fetch('/1/user/alice/listens', { method: 'DELETE' });
    expect(wrong.status).toBe(405);
    expectCors(wrong);
    expect(wrong.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(await wrong.json()).toEqual({ code: 405, error: LB_METHOD_NOT_ALLOWED_MESSAGE });

    // The registry route: a required token is checked by the router before the handler runs.
    const anonymous = await app.fetch('/1/submit-listens', { method: 'POST', body: '{}' });
    expect([anonymous.status, await anonymous.json()]).toEqual([
      401,
      { code: 401, error: 'You need to provide an Authorization header.' },
    ]);
    expect(registryCalls).toHaveLength(0);
    const submitted = await app.fetch('/1/submit-listens', {
      method: 'POST',
      headers: { authorization: `Token ${token}` },
      body: '{}',
    });
    expect([submitted.status, await submitted.json()]).toEqual([200, { status: 'ok' }]);
    expectCors(submitted);
    expect(submitted.headers.get('x-ratelimit-limit')).toBe('100');
    expect(registryCalls).toHaveLength(1);
    expect(registryCalls[0]!.auth).toMatchObject({ status: 'valid', token: { did: ALICE, username: 'alice' } });
    expect(registryCalls[0]!.limit).toMatchObject({ allowed: true, scope: 'token' });

    // Per IP: a fresh window of 30 per 10 s for anonymous requests.
    clock.advance(10_000);
    const remaining: string[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await app.fetch('/1/user/alice/listen-count');
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-limit')).toBe('30');
      expect(res.headers.get('access-control-expose-headers')).toBe(EXPOSE);
      remaining.push(res.headers.get('x-ratelimit-remaining')!);
    }
    expect(remaining.slice(0, 3)).toEqual(['29', '28', '27']);
    expect(remaining.at(-1)).toBe('0');
    for (const path of ['/1/user/alice/listen-count', '/1/nope']) {
      const limited = await app.fetch(path);
      expect(limited.status).toBe(429);
      expectCors(limited);
      expect(await limited.json()).toEqual({ code: 429, error: LB_RATE_LIMITED_MESSAGE });
      expect(limited.headers.get('x-ratelimit-limit')).toBe('30');
      expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
      expect(limited.headers.get('access-control-expose-headers')).toBe(EXPOSE);
      const resetIn = Number(limited.headers.get('x-ratelimit-reset-in'));
      expect(resetIn).toBeGreaterThanOrEqual(1);
      expect(resetIn).toBeLessThanOrEqual(10);
      expect(Number(limited.headers.get('x-ratelimit-reset'))).toBe(clock.nowMs() / 1000 + resetIn);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    }
    // A token that is not ours is charged to the IP, and refused before its 401.
    const foreign = await app.fetch('/1/user/alice/listen-count', {
      headers: { authorization: 'Token 0b4f5c1e-8a1d-4c6e-9f10-2a7c3b9d0e45' },
    });
    expect(foreign.status).toBe(429);
    // A preflight is never limited.
    expect((await app.fetch('/1/user/alice/listens', { method: 'OPTIONS' })).status).toBe(200);

    // Per token: an authenticated request is charged to its token only, so the full per-IP bucket never refuses it.
    const auth = { headers: { authorization: `token ${token}` } };
    for (let i = 0; i < 99; i++) {
      const res = await app.fetch('/1/user/alice/listen-count', auth);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-limit')).toBe('100');
    }
    const last = await app.fetch('/1/user/alice/listen-count', auth);
    expect([last.status, last.headers.get('x-ratelimit-remaining')]).toEqual([200, '0']);
    const overToken = await app.fetch('/1/user/alice/listen-count', auth);
    expect(overToken.status).toBe(429);
    expectCors(overToken);
    expect(await overToken.json()).toEqual({ code: 429, error: LB_RATE_LIMITED_MESSAGE });
    expect(overToken.headers.get('x-ratelimit-limit')).toBe('100');
    expect(overToken.headers.get('retry-after')).not.toBeNull();
    // A refused token request never reached its handler.
    const refusedSubmit = await app.fetch('/1/submit-listens', { method: 'POST', ...auth, body: '{}' });
    expect(refusedSubmit.status).toBe(429);
    expect(registryCalls).toHaveLength(1);

    // The windows are 10 s: both buckets admit again after it.
    clock.advance(10_000);
    expect((await app.fetch('/1/user/alice/listen-count')).status).toBe(200);
    expect((await app.fetch('/1/user/alice/listen-count', auth)).status).toBe(200);
  });

  it('a registry OPTIONS route never authenticates or charges the per-IP bucket; a registry answer keeps its own X-RateLimit-* set', async () => {
    let preflightCalls = 0;
    const DAILY_RESET = 43_200;
    const registry: LbRouteDef[] = [
      // N3-05 lists an OPTIONS route next to each of its paths (submit.ts, token-routes.ts).
      {
        method: 'OPTIONS',
        pattern: '/1/submit-listens',
        async handler() {
          preflightCalls++;
          return lbPreflight(['POST']);
        },
      },
      // A stand-in for N3-05's daily-cap 429 (ADR §8.3): its X-RateLimit-* describes the daily window.
      {
        method: 'GET',
        pattern: '/1/daily-cap-probe',
        async handler(_req, ctx) {
          const daily = rateLimitHeaders({ limit: 3000, remaining: 0, resetInSeconds: DAILY_RESET }, ctx.clock.nowMs());
          return lbTooManyRequests(daily, DAILY_RESET, 'Daily listen limit exceeded.');
        },
      },
    ];
    const { app, clock, token, registryCalls } = await started(registry);

    // 31 preflights from one IP (one more than the per-IP budget): every one is the router's uncharged 200.
    for (let i = 0; i < 31; i++) {
      const res = await app.fetch('/1/submit-listens', { method: 'OPTIONS' });
      expect([i, res.status]).toEqual([i, 200]);
      expectCors(res);
      expect(res.headers.get('allow')).toBe('OPTIONS, POST');
      expect(res.headers.get('access-control-allow-methods')).toBe('OPTIONS, POST');
      expect(res.headers.get('x-ratelimit-limit')).toBeNull();
      expect(await res.text()).toBe('');
    }
    expect(preflightCalls).toBe(0);
    // The per-IP bucket is untouched: the first charged request still sees 29 left.
    const first = await app.fetch('/1/user/alice/listen-count');
    expect([first.status, first.headers.get('x-ratelimit-limit'), first.headers.get('x-ratelimit-remaining')]).toEqual([
      200,
      '30',
      '29',
    ]);
    // The token-authenticated POST the preflight precedes is admitted.
    const posted = await app.fetch('/1/submit-listens', {
      method: 'POST',
      headers: { authorization: `Token ${token}` },
      body: '{}',
    });
    expect([posted.status, await posted.json()]).toEqual([200, { status: 'ok' }]);
    expect(registryCalls).toHaveLength(1);

    // The handler's own 429 leaves with its daily-window headers, not the 10 s bucket's.
    const capped = await app.fetch('/1/daily-cap-probe', { headers: { authorization: `Token ${token}` } });
    expect([capped.status, await capped.json()]).toEqual([429, { code: 429, error: 'Daily listen limit exceeded.' }]);
    expectCors(capped);
    expect(capped.headers.get('retry-after')).toBe(String(DAILY_RESET));
    expect(capped.headers.get('x-ratelimit-limit')).toBe('3000');
    expect(capped.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(capped.headers.get('x-ratelimit-reset-in')).toBe(String(DAILY_RESET));
    expect(Number(capped.headers.get('x-ratelimit-reset'))).toBe(clock.nowMs() / 1000 + DAILY_RESET);
    expect(capped.headers.get('access-control-expose-headers')).toBe(EXPOSE);
    // It was still charged to the token's bucket (the POST before it was the first of 100).
    const next = await app.fetch('/1/user/alice/listen-count', { headers: { authorization: `Token ${token}` } });
    expect([next.headers.get('x-ratelimit-limit'), next.headers.get('x-ratelimit-remaining')]).toEqual(['100', '97']);
  });

  it("a registry answer other than a 429 leaves with the charged bucket's X-RateLimit-*; the limiter is one per composition or options.limiter", async () => {
    // A stand-in for an N3-05 handler that still runs its own guard against another limiter:
    // it stamps that limiter's X-RateLimit-* on its 200 (and on a 401).
    const stale = (status: number) =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status,
        headers: {
          'content-type': 'application/json',
          ...rateLimitHeaders({ limit: 100, remaining: 99, resetInSeconds: 1 }, Date.parse(NOW_ISO)),
        },
      });
    const seen: ListenBrainzLimiter[] = [];
    const registry: LbRouteDef[] = [
      {
        method: 'GET',
        pattern: '/1/stale-probe',
        async handler(_req, ctx) {
          seen.push(routerLimiterFor(ctx));
          return stale(200);
        },
      },
      { method: 'GET', pattern: '/1/stale-401', handler: async () => stale(401) },
    ];
    const { app, clock, token } = await started(registry);
    const auth = { headers: { authorization: `Token ${token}` } };

    // Anonymous: charged to the per-IP bucket, whose headers replace the handler's.
    for (let i = 0; i < 3; i++) {
      const res = await app.fetch('/1/stale-probe');
      expect([res.status, await res.json()]).toEqual([200, { status: 'ok' }]);
      expect(res.headers.get('x-ratelimit-limit')).toBe('30');
      expect(res.headers.get('x-ratelimit-remaining')).toBe(String(29 - i));
      const resetIn = Number(res.headers.get('x-ratelimit-reset-in'));
      expect(Number(res.headers.get('x-ratelimit-reset'))).toBe(clock.nowMs() / 1000 + resetIn);
      expect(res.headers.get('access-control-expose-headers')).toBe(EXPOSE);
    }
    const unauth = await app.fetch('/1/stale-401');
    expect(unauth.status).toBe(401);
    expect([unauth.headers.get('x-ratelimit-limit'), unauth.headers.get('x-ratelimit-remaining')]).toEqual([
      '30',
      '26',
    ]);
    // Authenticated: 60 token reads, then the probe reports the token bucket's 39, not the handler's 99.
    for (let i = 0; i < 60; i++) expect((await app.fetch('/1/user/alice/listen-count', auth)).status).toBe(200);
    const probed = await app.fetch('/1/stale-probe', auth);
    expect([
      probed.status,
      probed.headers.get('x-ratelimit-limit'),
      probed.headers.get('x-ratelimit-remaining'),
    ]).toEqual([200, '100', '39']);
    // Every request of this app was charged to the one limiter of its composition.
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(1);

    // A second app built from the same RouteDef[] has its own limiter (keyed on its ModuleDeps).
    const routes = listenBrainzRoutes({ registry });
    const one = await startApp({ clock: fixedClock(NOW_ISO), routes });
    const two = await startApp({ clock: fixedClock(NOW_ISO), routes });
    for (let i = 0; i < 2; i++)
      expect((await one.fetch('/1/stale-probe')).headers.get('x-ratelimit-remaining')).toBe(String(29 - i));
    expect((await two.fetch('/1/stale-probe')).headers.get('x-ratelimit-remaining')).toBe('29');
    expect(seen).toHaveLength(7);
    expect(seen[4]).toBe(seen[5]);
    expect(seen[6]).not.toBe(seen[4]);
    expect(seen.slice(4)).not.toContain(seen[0]);

    // options.limiter as a function of the request: the router charges what it returns.
    const sourceClock = fixedClock(NOW_ISO);
    const supplied = new ListenBrainzLimiter(sourceClock, { ipRule: { capacity: 2, windowMs: 10_000 } });
    let sourceCalls = 0;
    const custom = await startApp({
      clock: sourceClock,
      routes: listenBrainzRoutes({
        registry,
        limiter: () => {
          sourceCalls++;
          return supplied;
        },
      }),
    });
    const statuses: [number, string | null][] = [];
    for (let i = 0; i < 3; i++) {
      const res = await custom.fetch('/1/stale-probe');
      statuses.push([res.status, res.headers.get('x-ratelimit-limit')]);
    }
    expect(statuses).toEqual([
      [200, '2'],
      [200, '2'],
      [429, '2'],
    ]);
    expect(sourceCalls).toBe(3);
    expect(supplied.perIp.has('127.0.0.1')).toBe(true);
  });

  it('following and followers for Alice and Bob map the follow records', async () => {
    const { app, repos } = await started();
    const get = async (path: string) => {
      const res = await app.fetch(path);
      expect(res.status).toBe(200);
      expectCors(res);
      return res.json();
    };

    // The fixture: Alice (account `alice`) follows Bob (never signed in: his verified handle).
    expect(await get('/1/user/alice/following')).toEqual({ following: ['bob.test'], user: 'alice' });
    expect(await get('/1/user/alice/followers')).toEqual({ followers: [], count: 0, user: 'alice' });
    expect(await get('/1/user/bob.test/followers')).toEqual({ followers: ['alice'], count: 1, user: 'bob.test' });
    expect(await get(`/1/user/${BOB}/following`)).toEqual({ following: [], user: 'bob.test' });

    // A duplicate record of the same edge is one name; Carol's newer follow of Bob lists first.
    const alice = repos.get(ALICE)!;
    await alice.put(FOLLOW, '3ldupdupdupdu', { $type: FOLLOW, subject: BOB, createdAt: '2025-06-01T00:00:00Z' });
    await apply(app.db, alice, FOLLOW, '3ldupdupdupdu');
    const carol = repos.get(CAROL)!;
    await carol.put(FOLLOW, '3lcarolcarolc', { $type: FOLLOW, subject: BOB, createdAt: '2025-09-01T00:00:00Z' });
    await apply(app.db, carol, FOLLOW, '3lcarolcarolc');
    // A follow of a DID this index has never seen is named by the DID.
    const stranger = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz';
    await alice.put(FOLLOW, '3lstrangerstr', { $type: FOLLOW, subject: stranger, createdAt: '2025-03-01T00:00:00Z' });
    await apply(app.db, alice, FOLLOW, '3lstrangerstr');
    expect(app.db.one<{ n: number }>('SELECT count(*) AS n FROM follows')!.n).toBe(4);
    expect(await get('/1/user/bob.test/followers')).toEqual({
      followers: ['carol.test', 'alice'],
      count: 2,
      user: 'bob.test',
    });
    expect(await get('/1/user/alice/following')).toEqual({ following: ['bob.test', stranger], user: 'alice' });
    expect(await get('/1/user/carol.test/following')).toEqual({ following: ['bob.test'], user: 'carol.test' });

    // An inactive actor's edges are hidden; a deleted record removes its edge.
    app.db.run('UPDATE users SET active = 0 WHERE did = ?', CAROL);
    expect(await get('/1/user/bob.test/followers')).toEqual({ followers: ['alice'], count: 1, user: 'bob.test' });
    await alice.delete(FOLLOW, '3lstrangerstr');
    await apply(app.db, alice, FOLLOW, '3lstrangerstr');
    expect(await get('/1/user/alice/following')).toEqual({ following: ['bob.test'], user: 'alice' });

    // Unknown users are 404.
    for (const path of ['/1/user/x/following', '/1/user/x/followers']) {
      const res = await app.fetch(path);
      expect([res.status, await res.json()]).toEqual([404, { code: 404, error: 'Cannot find user: x' }]);
    }
  });
});
