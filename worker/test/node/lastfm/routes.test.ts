// N3-04: the /2.0 endpoint and its method dispatcher (ADR 0005 §7.1, §7.3,
// §7.5, §7.6, §13), over the real Node composition (support/app.ts).
//
// Users are seeded directly (users + accounts rows; Alice with one signed
// fixture listen applied through the production verifier). Session keys,
// tokens and app passwords are issued by the production credential modules
// (N2-09) with the injected seeded Random. The auth/write tables of N3-03 are
// stood in for by a counting fake handler passed through the registry
// argument, which is exactly how the composition wires the real ones.

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { artistKey, trackKey } from '@atmusic/core/music-key';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { Revocations } from '../../../src/app/revocations';
import { createAppPassword } from '../../../src/credentials/app-passwords';
import { createSession, issueToken } from '../../../src/credentials/lastfm-auth';
import type { Db } from '../../../src/do/db';
import { type ApplyOptions, applyRecordProof } from '../../../src/do/write/apply-record';
import { lfmOk } from '../../../src/lastfm/encode';
import {
  LASTFM_READ_IP_RATE,
  type LastfmCall,
  type LastfmRegistry,
  lastfmRoutes,
  READ_METHOD_TABLE,
  verifySessionCaller,
} from '../../../src/lastfm/routes';
import { computeSignature, READ_METHODS } from '../../../src/lastfm/signature';
import { closeApps, startApp, TEST_PUBLIC_ORIGIN, type TestApp } from '../support/app';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
const ALICE = fixture.users.Alice.did;
const BOB = fixture.users.Bob.did;
const NOW_NS = fromMs(Date.parse('2026-01-15T12:00:00Z'));
const OPTS: ApplyOptions = { receiptNs: NOW_NS, prefix: PREFIX, nowNs: NOW_NS };
const API_KEY = 'routes-test-key';
const XML_OK_PREFIX = '<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="ok">';

function seedUser(db: Db, did: string, handle: string, username: string): void {
  const gen = db.one<{ g: number }>(
    'UPDATE backfill_generation SET last_generation = last_generation + 1 WHERE singleton = 1 RETURNING last_generation AS g',
  )!.g;
  db.run(
    `INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, ?, 1, 'active', 'current', ?)`,
    did,
    handle,
    toStorage(NOW_NS),
    gen,
  );
  db.run('INSERT INTO accounts(did, username, created_at_ms, updated_at_ms) VALUES (?, ?, 1, 1)', did, username);
}

async function seed(db: Db): Promise<void> {
  seedUser(db, ALICE, 'alice.test', 'alice');
  seedUser(db, BOB, 'bob.test', 'bob');
  const repo = new SignedRepo(ALICE, (await fixtureKeys()).alice, { clock: fixedClock() });
  const r01 = fixture.scrobbles.find((s) => s.rkey === 'r01')!;
  await repo.put(SCROBBLE, 'r01', { ...r01.record });
  const proof = await verifyRecordProof(await repo.getRecordCar(SCROBBLE, 'r01'), {
    did: ALICE,
    collection: SCROBBLE,
    rkey: 'r01',
    signingKey: repo.key.didKey,
  });
  expect(db.tx(() => applyRecordProof(db, proof, OPTS)).outcome).toBe('applied');
}

interface FakeWrites {
  calls: LastfmCall[];
  registry: LastfmRegistry;
}

/** A stand-in for N3-03's writeMethods: track.love answers ok and records each call. */
function fakeWrites(): FakeWrites {
  const calls: LastfmCall[] = [];
  return {
    calls,
    registry: {
      writeMethods: {
        'track.love': (call) => {
          calls.push(call);
          return lfmOk();
        },
        'track.unlove': (call) => {
          calls.push(call);
          // A failing handler: its message must never reach a body or a log line.
          throw new Error(`boom ${call.params.get('sk') ?? ''} ${call.params.get('api_sig') ?? ''}`);
        },
      },
      signature: { knownClients: [{ apiKey: 'known-key', sharedSecret: 'known-secret' }], issuedSecret: () => null },
    },
  };
}

async function app(registry?: LastfmRegistry): Promise<TestApp> {
  const a = await startApp({ routes: lastfmRoutes(registry) });
  await seed(a.db);
  return a;
}

const qs = (p: Record<string, string>) => new URLSearchParams(p).toString();
const form = (p: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: qs(p),
});

afterEach(async () => {
  await closeApps();
});

describe('Last.fm /2.0 dispatcher', () => {
  it('/2.0 and /2.0/ accept GET and POST; unknown or missing method gives 3; missing api_key gives 10; unknown user gives 6; reads send Access-Control-Allow-Origin: *', async () => {
    const writes = fakeWrites();
    const a = await app(writes.registry);
    const info = { method: 'user.getInfo', user: 'alice', api_key: API_KEY };

    // The four transports answer the same document.
    const bodies: string[] = [];
    for (const [path, init] of [
      [`/2.0?${qs(info)}`, undefined],
      [`/2.0/?${qs(info)}`, undefined],
      ['/2.0', form(info)],
      ['/2.0/', form(info)],
    ] as const) {
      const res = await a.fetch(path, init);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('text/xml; charset=utf-8');
      expect(res.headers.get('access-control-allow-origin'), path).toBe('*');
      const text = await res.text();
      expect(text.startsWith(`${XML_OK_PREFIX}\n  <user>\n    <name>alice</name>`), path).toBe(true);
      bodies.push(text);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain(`<url>${TEST_PUBLIC_ORIGIN}/u/${ALICE}</url>`);
    expect(bodies[0]).toContain('<playcount>1</playcount>');
    // Method names match without regard to case; Accept selects JSON; raw drops <lfm>.
    const lower = await a.fetch(`/2.0/?${qs({ ...info, method: 'USER.getinfo' })}`, {
      headers: { accept: 'application/json' },
    });
    expect([lower.status, lower.headers.get('content-type')]).toEqual([200, 'application/json; charset=utf-8']);
    expect(((await lower.json()) as { user: { name: string } }).user.name).toBe('alice');
    const raw = await (await a.fetch(`/2.0/?${qs({ ...info, raw: 'true' })}`)).text();
    expect(raw.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<user>\n')).toBe(true);
    // JSONP is never served.
    const jsonp = await a.fetch(`/2.0/?${qs({ ...info, format: 'json', callback: 'alert' })}`);
    expect([jsonp.headers.get('content-type'), jsonp.headers.get('x-content-type-options')]).toEqual([
      'application/json; charset=utf-8',
      'nosniff',
    ]);
    expect((await jsonp.text()).startsWith('{"user":')).toBe(true);

    // Unknown or missing method: 3, no CORS.
    for (const params of [
      { method: 'geo.getTopArtists', api_key: API_KEY } as Record<string, string>,
      { method: 'artist.getSimilar', api_key: API_KEY, artist: 'Björk' },
      { api_key: API_KEY, user: 'alice' },
      { method: '', api_key: API_KEY },
    ]) {
      const res = await a.fetch(`/2.0/?${qs({ ...params, format: 'json' })}`);
      expect([res.status, await res.json()], JSON.stringify(params)).toEqual([
        400,
        { error: 3, message: 'Invalid Method - No method with that name in this package' },
      ]);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    const xml3 = await (await a.fetch(`/2.0/?${qs({ method: 'chart.getTopArtists', api_key: API_KEY })}`)).text();
    expect(xml3).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="failed"><error code="3">Invalid Method - No method with that name in this package</error></lfm>\n',
    );

    // Missing (or too long) api_key: 10 — a read, so CORS still applies.
    for (const params of [
      { method: 'user.getInfo', user: 'alice' },
      { ...info, api_key: 'k'.repeat(65) },
    ]) {
      const res = await a.fetch(`/2.0/?${qs({ ...params, format: 'json' })}`);
      expect([res.status, await res.json()]).toEqual([403, { error: 10, message: 'Invalid API key' }]);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }

    // Unknown user: 6, with CORS.
    const unknown = await a.fetch(`/2.0/?${qs({ ...info, user: 'nobody', format: 'json' })}`);
    expect([unknown.status, await unknown.json()]).toEqual([400, { error: 6, message: 'User not found' }]);
    expect(unknown.headers.get('access-control-allow-origin')).toBe('*');
    // A duplicate parameter is 6.
    const dup = await a.fetch(`/2.0/?${qs(info)}&user=bob&format=json`);
    expect([dup.status, ((await dup.json()) as { error: number }).error]).toEqual([400, 6]);

    // A POST-only write via GET: 3 with the POST message, handler not called, no CORS.
    const loveParams = { method: 'track.love', api_key: API_KEY, artist: 'Björk', track: 'Jóga', sk: 'x'.repeat(32) };
    const viaGet = await a.fetch(`/2.0/?${qs({ ...loveParams, api_sig: 'a'.repeat(32), format: 'json' })}`);
    expect([viaGet.status, await viaGet.json()]).toEqual([
      400,
      { error: 3, message: 'Invalid Method - this method must be called with POST' },
    ]);
    expect(writes.calls).toHaveLength(0);
    // POST: the §7.4 policy runs before the handler — unknown key needs a 32-hex api_sig (13 otherwise).
    const unsigned = await a.fetch('/2.0/', form({ ...loveParams, format: 'json' }));
    expect([unsigned.status, ((await unsigned.json()) as { error: number }).error]).toEqual([403, 13]);
    expect(writes.calls).toHaveLength(0);
    const signed = await a.fetch('/2.0/', form({ ...loveParams, api_sig: 'a'.repeat(32), format: 'json' }));
    expect([signed.status, await signed.text()]).toEqual([200, '{}']);
    expect(signed.headers.get('access-control-allow-origin')).toBeNull();
    expect(writes.calls.map((c) => [c.method, c.apiKey, c.signature])).toEqual([
      ['track.love', API_KEY, { required: true, keyKind: 'unknown', verified: false }],
    ]);
    // A known pair must verify.
    const known = { ...loveParams, api_key: 'known-key' };
    const wrong = await a.fetch('/2.0/', form({ ...known, api_sig: 'a'.repeat(32), format: 'json' }));
    expect(((await wrong.json()) as { error: number }).error).toBe(13);
    const good = await a.fetch(
      '/2.0/',
      form({ ...known, api_sig: computeSignature(Object.entries(known), 'known-secret') }),
    );
    expect([good.status, await good.text()]).toEqual([
      200,
      '<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="ok"/>\n',
    ]);
    expect(writes.calls).toHaveLength(2);
    // A signed method this composition does not mount: still POST-only, then 3.
    const scrobbleGet = await a.fetch(`/2.0/?${qs({ method: 'track.scrobble', api_key: API_KEY, format: 'json' })}`);
    expect(((await scrobbleGet.json()) as { message: string }).message).toBe(
      'Invalid Method - this method must be called with POST',
    );
    const scrobblePost = await a.fetch('/2.0/', form({ method: 'track.scrobble', api_key: API_KEY, format: 'json' }));
    expect([scrobblePost.status, ((await scrobblePost.json()) as { error: number }).error]).toEqual([400, 3]);
    // Every §7.5 read method is served by this package, and nothing else is.
    expect(Object.keys(READ_METHOD_TABLE).sort()).toEqual([...READ_METHODS].sort());
    // Mounting a signed handler without the signature inputs is refused.
    expect(() => lastfmRoutes({ writeMethods: { 'track.love': () => lfmOk() } })).toThrow(TypeError);
    expect(() =>
      lastfmRoutes({ writeMethods: { 'user.getInfo': () => lfmOk() }, signature: writes.registry.signature }),
    ).toThrow(TypeError);
  });

  it('no response body or captured log line from this suite contains an sk, api_sig, token or app password value', async () => {
    const writes = fakeWrites();
    const a = await app(writes.registry);
    const deps = { db: a.db, clock: a.clock, random: seededRandom(0xc0ffee) };
    const sk = createSession(deps, { did: ALICE, apiKey: API_KEY }).key;
    const token = issueToken(deps, API_KEY);
    if (!token.ok) throw new Error('token not issued');
    const password = createAppPassword(
      { ...deps, revocations: undefined as unknown as Revocations },
      { did: ALICE },
    ).password;
    const apiSig = computeSignature([['method', 'track.love']], 'whatever-secret');
    const unknownSk = 'f'.repeat(32);
    const secrets = [sk, token.value.token, password, apiSig, unknownSk];

    const requests: Array<[string, RequestInit | undefined]> = [
      [`/2.0/?${qs({ method: 'user.getInfo', api_key: API_KEY, sk, api_sig: apiSig })}`, undefined],
      [
        `/2.0/?${qs({ method: 'user.getRecentTracks', user: 'alice', api_key: API_KEY, sk: unknownSk, format: 'json' })}`,
        undefined,
      ],
      [`/2.0/?${qs({ method: 'user.getInfo', api_key: API_KEY, sk: unknownSk })}`, undefined],
      [
        `/2.0/?${qs({ method: 'auth.getSession', api_key: API_KEY, token: token.value.token, api_sig: apiSig })}`,
        undefined,
      ],
      [
        '/2.0/',
        form({ method: 'auth.getMobileSession', username: 'alice', password, api_key: API_KEY, api_sig: apiSig }),
      ],
      ['/2.0/', form({ method: 'track.love', artist: 'A', track: 'T', api_key: API_KEY, sk, api_sig: apiSig })],
      ['/2.0/', form({ method: 'track.unlove', artist: 'A', track: 'T', api_key: API_KEY, sk, api_sig: apiSig })],
      [`/2.0/?${qs({ method: `user.${sk}`, api_key: API_KEY, sk })}`, undefined],
      [
        `/2.0/?${qs({ method: 'user.getInfo', api_key: password, user: 'alice' })}&user=${token.value.token}`,
        undefined,
      ],
      [
        `/2.0/?${qs({ method: 'track.getInfo', api_key: API_KEY, artist: sk, track: password, username: token.value.token })}`,
        undefined,
      ],
      [`/2.0?${qs({ method: 'track.love', api_key: API_KEY, sk, api_sig: apiSig })}`, undefined],
    ];
    const statuses: number[] = [];
    const bodies: string[] = [];
    for (const [path, init] of requests) {
      const res = await a.fetch(path, init);
      statuses.push(res.status);
      bodies.push(await res.text());
      for (const [name, value] of res.headers) bodies.push(`${name}: ${value}`);
    }
    // The requests did what they should (so the absence below is not vacuous).
    expect(statuses).toEqual([200, 200, 400, 400, 400, 200, 500, 400, 400, 400, 400]);
    expect(bodies[0]).toContain('<name>alice</name>');
    expect(bodies).toContain(
      '<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="failed"><error code="8">Operation failed</error></lfm>\n',
    );
    expect(writes.calls).toHaveLength(2);
    const failure = a.log.logs.filter((l) => l.event === 'lastfm.method_failed');
    expect(failure.map((l) => [l.method, l.error])).toEqual([['track.unlove', 'Error']]);
    const requestLines = a.log.logs.filter((l) => l.event === 'request');
    expect(requestLines).toHaveLength(requests.length);
    expect(requestLines.map((l) => l.lastfmMethod)).toEqual([
      'user.getInfo',
      'user.getRecentTracks',
      'user.getInfo',
      'auth.getSession',
      'auth.getMobileSession',
      'track.love',
      'track.unlove',
      '(unlisted)',
      'user.getInfo',
      'track.getInfo',
      'track.love',
    ]);

    const everything = [...bodies, ...a.log.lines].join('\n');
    for (const secret of secrets) {
      expect(everything.includes(secret), `a credential value leaked (${secret.length} chars)`).toBe(false);
      expect(everything.toLowerCase().includes(secret.toLowerCase())).toBe(false);
    }
  });

  it('an unsigned Pano-shaped GET user.getRecentTracks with sk and api_key and an unsigned lastfm-ts-api-shaped GET user.getInfo with sk and no user answer status ok, the latter for the sk owner, and neither returns 13 or 9', async () => {
    const a = await app();
    const deps = { db: a.db, clock: a.clock, random: seededRandom(7) };
    const bobSk = createSession(deps, { did: BOB, apiKey: 'pano-key' }).key;
    // Bob (the sk owner) loves Jóga; Alice (the listed user) loves nothing.
    a.db.run(
      `INSERT INTO loves(uri, did, rkey, cid, artist, track, album, artist_key, track_key, recording_mbid, created_at, indexed_at)
       VALUES (?, ?, '3lbbbbbbbbbb1', 'bafyreilove', 'Björk', 'Jóga', NULL, ?, ?, NULL, ?, ?)`,
      `at://${BOB}/${PREFIX}.love/3lbbbbbbbbbb1`,
      BOB,
      artistKey('Björk'),
      trackKey('Björk', 'Jóga')[1],
      toStorage(NOW_NS),
      toStorage(NOW_NS),
    );

    // Pano (GNU FM account type): its root plus /2.0/, unsigned, sk and api_key, JSON.
    const panoQuery = { method: 'user.getRecentTracks', user: 'alice', limit: '50', page: '1', extended: '1' };
    const pano = await a.fetch(`/2.0/?${qs({ ...panoQuery, api_key: 'pano-key', sk: bobSk, format: 'json' })}`);
    expect(pano.status).toBe(200);
    type RecentBody = { recenttracks: { track: Array<{ name: string; loved: string }>; '@attr': { user: string } } };
    const panoBody = (await pano.json()) as RecentBody;
    expect(panoBody.recenttracks['@attr'].user).toBe('alice');
    // Alice's listens, with the caller's (Bob's) loved flags (§7.3).
    expect(panoBody.recenttracks.track.map((t) => [t.name, t.loved])).toEqual([['Jóga', '1']]);
    const anonymous = (await (
      await a.fetch(`/2.0/?${qs({ ...panoQuery, api_key: 'pano-key', format: 'json' })}`)
    ).json()) as RecentBody;
    expect(anonymous.recenttracks.track.map((t) => [t.name, t.loved])).toEqual([['Jóga', '0']]);

    // lastfm-ts-api: path /2.0, `format=json` first, then the method's params, api_key, method, sk.
    const tsApi = await a.fetch(
      `/2.0?${qs({ format: 'json', api_key: 'mscrobbler-key', method: 'user.getInfo', sk: bobSk })}`,
    );
    expect(tsApi.status).toBe(200);
    expect(tsApi.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const tsBody = (await tsApi.json()) as { user: { name: string; url: string; playcount: string } };
    expect([tsBody.user.name, tsBody.user.url, tsBody.user.playcount]).toEqual([
      'bob',
      `${TEST_PUBLIC_ORIGIN}/u/${BOB}`,
      '0',
    ]);
    // lastfm-ts-api also signs reads with whatever secret it holds; a wrong api_sig is ignored on a read.
    const signedWrong = await a.fetch(
      `/2.0?${qs({ format: 'json', api_key: 'mscrobbler-key', method: 'user.getInfo', sk: bobSk, api_sig: 'not-a-signature' })}`,
    );
    expect(((await signedWrong.json()) as { user: { name: string } }).user.name).toBe('bob');
    // The sk identified the caller: the session's last use is recorded (identification only).
    expect(a.db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_sessions WHERE last_used_ms IS NOT NULL')!.n).toBe(
      1,
    );

    // An unknown sk on a read is ignored, never 9; with no user it is the missing user (6).
    const stale = await a.fetch(
      `/2.0/?${qs({ method: 'user.getRecentTracks', user: 'alice', api_key: 'pano-key', sk: '0'.repeat(32), format: 'json' })}`,
    );
    expect(stale.status).toBe(200);
    const noUser = await a.fetch(
      `/2.0?${qs({ format: 'json', api_key: 'k', method: 'user.getInfo', sk: 'nonsense' })}`,
    );
    const noUserBody = (await noUser.json()) as { error: number };
    expect([noUser.status, noUserBody.error]).toEqual([400, 6]);
    for (const res of [panoBody, tsBody]) {
      expect(JSON.stringify(res)).not.toMatch(/"error":(13|9)\b/);
    }
  });

  it("delegated tables (N3-03's definitions with their own runner) get an untouched copy of the request, and only signed methods may be delegated", async () => {
    // N3-03's shape: {name, postOnly, signed, handle}, answered by its handleLastfmMethod runner.
    type Def = { name: string; postOnly: boolean; signed: boolean; handle(): Promise<unknown> };
    const def = (name: string, postOnly: boolean): Def => ({
      name,
      postOnly,
      signed: true,
      handle: async () => lfmOk(),
    });
    const authTable: Readonly<Record<string, Def>> = { 'auth.getToken': def('auth.getToken', false) };
    const writeTable: Readonly<Record<string, Def>> = { 'track.scrobble': def('track.scrobble', true) };
    const ran: Array<{ table: string; method: string; body: string; search: string }> = [];
    const run = async (table: Readonly<Record<string, Def>>, request: Request) => {
      ran.push({
        table: table === authTable ? 'auth' : 'write',
        method: request.method,
        body: await request.text(),
        search: new URL(request.url).search,
      });
      return new Response('<delegated/>', { status: 299, headers: { 'content-type': 'text/xml; charset=utf-8' } });
    };
    const a = await startApp({ routes: lastfmRoutes({ delegated: { tables: [authTable, writeTable], run } }) });
    await seed(a.db);

    const body = qs({ method: 'track.scrobble', api_key: API_KEY, 'artist[0]': 'Björk', 'track[0]': 'Jóga' });
    const post = await a.fetch('/2.0/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect([post.status, await post.text(), post.headers.get('access-control-allow-origin')]).toEqual([
      299,
      '<delegated/>',
      null,
    ]);
    const tokenQuery = qs({ method: 'AUTH.GETTOKEN', api_key: API_KEY });
    const token = await a.fetch(`/2.0/?${tokenQuery}`);
    expect(token.status).toBe(299);
    expect(ran).toEqual([
      { table: 'write', method: 'POST', body, search: '' },
      { table: 'auth', method: 'GET', body: '', search: `?${tokenQuery}` },
    ]);
    // Reads are still this module's; an undelegated signed method is still known.
    const info = await a.fetch(
      `/2.0/?${qs({ method: 'user.getInfo', user: 'alice', api_key: API_KEY, format: 'json' })}`,
    );
    expect([info.status, ((await info.json()) as { user: { name: string } }).user.name]).toEqual([200, 'alice']);
    const love = await a.fetch(`/2.0/?${qs({ method: 'track.love', api_key: API_KEY, format: 'json' })}`);
    expect(((await love.json()) as { message: string }).message).toBe(
      'Invalid Method - this method must be called with POST',
    );
    expect(ran).toHaveLength(2);
    // The request log carries each method's allowlisted name.
    expect(a.log.logs.filter((l) => l.event === 'request').map((l) => l.lastfmMethod)).toEqual([
      'track.scrobble',
      'auth.getToken',
      'user.getInfo',
      'track.love',
    ]);

    // A read (or any unsigned name) can never be delegated, nor a method twice.
    expect(() =>
      lastfmRoutes({ delegated: { tables: [{ 'user.getInfo': def('user.getInfo', false) }], run } }),
    ).toThrow(TypeError);
    expect(() => lastfmRoutes({ delegated: { tables: [writeTable, writeTable], run } })).toThrow(TypeError);
  });

  it('reads are limited to 60 per minute per client IP (IPv6 by /64) with 29, Retry-After and CORS before any handler work; writes and unknown methods are not charged', async () => {
    const writes = fakeWrites();
    let resolved = 0;
    const clock = fixedClock();
    const a = await startApp({
      clock,
      routes: lastfmRoutes({
        ...writes.registry,
        resolveCaller: (deps, sk) => {
          resolved += 1;
          return verifySessionCaller(deps, sk);
        },
      }),
      // The harness peer (127.0.0.1) is a trusted proxy, so X-Forwarded-For names the client.
      env: { ATMUSIC_CLIENT_IP_HEADER: 'x-forwarded-for' },
    });
    await seed(a.db);
    const bobSk = createSession(
      { db: a.db, clock: a.clock, random: seededRandom(3) },
      { did: BOB, apiKey: API_KEY },
    ).key;
    // user.getInfo with sk and no user: the handler resolves the caller, so `resolved` counts handler runs.
    const read = (ip: string) =>
      a.fetch(`/2.0/?${qs({ method: 'user.getInfo', api_key: API_KEY, sk: bobSk, format: 'json' })}`, {
        headers: { 'x-forwarded-for': ip },
      });

    expect(LASTFM_READ_IP_RATE).toEqual({ capacity: 60, windowMs: 60_000 });
    for (let i = 0; i < 60; i++) {
      const res = await read('203.0.113.7');
      expect(res.status, `read ${i + 1}`).toBe(200);
      expect(((await res.json()) as { user: { name: string } }).user.name).toBe('bob');
    }
    expect(resolved).toBe(60);

    const refused = await read('203.0.113.7');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(refused.headers.get('access-control-allow-origin')).toBe('*');
    expect(await refused.json()).toEqual({ error: 29, message: 'Rate Limit Exceeded' });
    // The refusal came before the handler: no caller lookup, no session use recorded after the 60th.
    expect(resolved).toBe(60);
    const xml = await a.fetch(`/2.0/?${qs({ method: 'user.getInfo', user: 'alice', api_key: API_KEY })}`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(xml.status).toBe(429);
    expect(await xml.text()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="failed"><error code="29">Rate Limit Exceeded</error></lfm>\n',
    );
    // A missing api_key is not checked first: the limit runs before it.
    const noKey = await a.fetch(`/2.0/?${qs({ method: 'user.getInfo', user: 'alice', format: 'json' })}`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(((await noKey.json()) as { error: number }).error).toBe(29);

    // Writes (limited per sk elsewhere) and unknown methods are not charged to the read bucket.
    const love = await a.fetch('/2.0/', {
      ...form({
        method: 'track.love',
        artist: 'A',
        track: 'T',
        api_key: 'known-key',
        sk: bobSk,
        api_sig: 'a'.repeat(32),
        format: 'json',
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.7' },
    });
    // It reaches the signature policy (13 for a wrong api_sig), not the read limit.
    expect([love.status, ((await love.json()) as { error: number }).error]).toEqual([403, 13]);
    const unknown = await a.fetch(`/2.0/?${qs({ method: 'user.nope', api_key: API_KEY, format: 'json' })}`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(((await unknown.json()) as { error: number }).error).toBe(3);

    // Another IPv4 client has its own bucket.
    expect((await read('198.51.100.20')).status).toBe(200);
    // IPv6 is keyed by /64: two hosts of one /64 share a bucket, another /64 does not.
    for (let i = 0; i < 60; i++) expect((await read('2001:db8:1:2::1')).status).toBe(200);
    expect((await read('2001:db8:1:2::ffff')).status).toBe(429);
    expect((await read('2001:db8:1:3::1')).status).toBe(200);

    // One token returns every second (60/min, injected clock).
    clock.advance(1_000);
    expect((await read('203.0.113.7')).status).toBe(200);
    expect((await read('203.0.113.7')).status).toBe(429);
    clock.advance(60_000);
    for (let i = 0; i < 60; i++) expect((await read('203.0.113.7')).status).toBe(200);
    expect(resolved).toBe(60 + 1 + 60 + 1 + 1 + 60);
  });
});
