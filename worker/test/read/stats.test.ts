// W3-02: exact statistics over all/7d/30d/365d (ADR 0004 §5.8, TESTING.md
// "Exact statistics assertions", M5.1.1 album_absence, M5.1.2 ranking_ties).
//
// The shared fixture (tests/fixtures/read_models.json) is published into real
// signed repositories, every record proof is checked by the production
// verifier (verifyRecordProof over the getRecord CAR) and applied by the
// production apply path into node:sqlite. Requests go through the real
// route handler with the stats DO module behind a local IndexRpc. Every
// expectation is hardcoded from TESTING.md, never computed by the code under
// test. Each request asserts the status, the OpenAPI schema (AJV), DO table
// state (stats_cache, scrobbles) and the remote-call count (zero).

import type { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import type { RecordProof } from '@atmusic/atproto/verify/types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { beforeAll, expect, it } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { ModuleDeps, StatsQuery } from '../../src/do/contracts';
import { computeStatistics, stats } from '../../src/do/read/stats';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { routes, STATS_PATTERN } from '../../src/http/stats';
import type { RequestCtx } from '../../src/http/types';
import { ALICE, BOB, NOW_NS, OPTS, repoFor, SCROBBLE, scrobble, seedUser, uriOf } from '../write/support';
import { HARNESS_ENV, inTestDb, makeDbIndex, openTestDb, type TestDb } from './node-harness';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function openapiValidator(schema: string) {
  const doc = JSON.parse(openapiText) as { components: unknown };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
  ajv.addFormat('at-did', /^did:[a-z]+:[A-Za-z0-9._:%-]*[A-Za-z0-9._-]$/);
  ajv.addFormat('music-text', /^[\s\S]*\S[\s\S]*$/u);
  ajv.addSchema({ $id: 'openapi', components: doc.components });
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`);
  if (validate === undefined) throw new Error(`no schema ${schema}`);
  return (value: unknown) => ((validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors));
}
const schemas = { Statistics: openapiValidator('Statistics'), Error: openapiValidator('Error') };

const REQUEST_ID = '3c1d7e52-8a4b-4f6e-9d20-6b7a8c9d0e1f';
const AS_OF = '2026-01-15T12:00:00.000000000Z';
const route = routes.find((r) => r.method === 'GET' && r.pattern === STATS_PATTERN)!;

let cursorKey: CryptoKey;
beforeAll(async () => {
  cursorKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(32).fill(9),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
});

/** A verified getRecord proof at the repo head, through the production verifier. */
async function verifiedProof(repo: SignedRepo, collection: string, rkey: string): Promise<RecordProof> {
  const car = await repo.getRecordCar(collection, rkey);
  return verifyRecordProof(car, { did: repo.did, collection, rkey, signingKey: repo.key.didKey });
}

/** Apply a verified proof through the production apply path; returns the outcome. */
async function applyVerified(store: TestDb, repo: SignedRepo, rkey: string): Promise<string> {
  const proof = await verifiedProof(repo, SCROBBLE, rkey);
  return inTestDb(store, (db) => db.tx(() => applyRecordProof(db, proof, OPTS)).outcome);
}

async function put(store: TestDb, repo: SignedRepo, rkey: string, record: Record<string, unknown>) {
  await repo.put(SCROBBLE, rkey, record);
  expect(await applyVerified(store, repo, rkey)).toBe('applied');
}

/** Alice's r01..r08 (r08 created then deleted) and Bob's r09, from the shared fixture. */
async function seedFixture() {
  const store = await openTestDb();
  await inTestDb(store, (db) => {
    seedUser(db, ALICE);
    seedUser(db, BOB);
  });
  const alice = await repoFor('alice');
  const bob = await repoFor('bob');
  for (const s of fixture.scrobbles) {
    if (s.owner === ALICE) await put(store, alice, s.rkey, { ...s.record });
    else if (s.owner === BOB) await put(store, bob, s.rkey, { ...s.record });
  }
  await alice.delete(SCROBBLE, 'r08');
  expect(await applyVerified(store, alice, 'r08')).toBe('absent');
  const rows = await inTestDb(store, (db) =>
    db.all<{ uri: string }>('SELECT uri FROM scrobbles WHERE did = ? ORDER BY uri', ALICE).map((r) => r.uri),
  );
  expect(rows).toEqual(['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07'].map((k) => uriOf(ALICE, SCROBBLE, k)));
  return { store, alice, bob };
}

function ctxFor(store: TestDb, iso = '2026-01-15T12:00:00Z') {
  const index = makeDbIndex({ db: store }, { stats });
  const ctx: RequestCtx = {
    env: HARNESS_ENV,
    index,
    requestId: REQUEST_ID,
    clock: fixedClock(iso),
    cursorKey,
    clientIp: '203.0.113.9',
  };
  return { ctx, index };
}

interface Got {
  status: number;
  body: Record<string, unknown>;
  res: Response;
  calls: number;
  network: number;
  query: StatsQuery | undefined;
}

/** GET the stats route as the router would dispatch it. */
async function getStats(store: TestDb, did: string, query = '', iso?: string): Promise<Got> {
  const { ctx, index } = ctxFor(store, iso);
  const path = STATS_PATTERN.replace('{did}', encodeURIComponent(did));
  const res = await route.handler(new Request(`https://music.example.test${path}${query}`), ctx, { did });
  const body = (await res.clone().json()) as Record<string, unknown>;
  return {
    status: res.status,
    body,
    res,
    calls: index.calls.length,
    network: index.networkAttempts.length,
    query: index.calls[0]?.args[0] as StatsQuery | undefined,
  };
}

/** 200 Statistics: status, schema, headers, exactly one RPC, no remote call. */
function expectOk(got: Got, window: string): void {
  expect(got.status).toBe(200);
  expect(schemas.Statistics(got.body)).toBe('valid');
  expect(got.res.headers.get('content-type')).toBe('application/json');
  expect(got.res.headers.get('cache-control')).toBe('no-store');
  expect(got.calls).toBe(1);
  expect(got.network).toBe(0);
  expect(got.body.did).toBe(ALICE);
  expect(got.body.window).toBe(window);
  expect(got.body.asOf).toBe(AS_OF);
}

async function expectError(got: Got, status: number, code: string, fields?: Record<string, string>) {
  expect(got.status).toBe(status);
  expect(schemas.Error(got.body)).toBe('valid');
  expect(got.res.headers.get('cache-control')).toBe('no-store');
  const error = got.body.error as { code: string; requestId: string; fields?: Record<string, string> };
  expect(error.code).toBe(code);
  expect(error.requestId).toBe(REQUEST_ID);
  expect(error.fields).toEqual(fields);
  expect(got.network).toBe(0);
}

/** The stats_cache row the request left behind. */
function cacheRow(store: TestDb, did: string, win: string, lim: number) {
  return inTestDb(store, (db) =>
    db.one<{ as_of: string; lower: string | null; version: number; body: string }>(
      'SELECT as_of, lower, version, body FROM stats_cache WHERE did = ? AND win = ? AND lim = ?',
      did,
      win,
      lim,
    ),
  );
}

function statsVersion(store: TestDb, did: string) {
  return inTestDb(store, (db) => db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', did)!.v);
}

const artist = (a: string, n: number) => ({ artist: a, scrobbleCount: n });
const track = (a: string, t: string, n: number) => ({ artist: a, track: t, scrobbleCount: n });
const album = (a: string, al: string, n: number) => ({ artist: a, album: al, scrobbleCount: n });

// TESTING.md "Exact statistics assertions", hardcoded.
const EXPECTED = {
  all: {
    totals: [7, 3, 6],
    artists: [artist('Radiohead', 3), artist('Björk', 2), artist('Kate Bush', 2)],
    tracks: [
      track('Björk', 'Jóga', 2),
      track('Kate Bush', 'Cloudbusting', 1),
      track('Kate Bush', 'Running Up That Hill', 1),
      track('Radiohead', 'Karma Police', 1),
      track('Radiohead', 'No Surprises', 1),
      track('Radiohead', 'Weird Fishes', 1),
    ],
    albums: [
      album('Björk', 'Homogenic', 2),
      album('Radiohead', 'OK Computer', 2),
      album('Kate Bush', 'Hounds of Love', 1),
      album('Radiohead', 'In Rainbows', 1),
    ],
  },
  '7d': {
    totals: [4, 2, 3],
    artists: [artist('Björk', 2), artist('Radiohead', 2)],
    tracks: [track('Björk', 'Jóga', 2), track('Radiohead', 'No Surprises', 1), track('Radiohead', 'Weird Fishes', 1)],
    albums: [
      album('Björk', 'Homogenic', 2),
      album('Radiohead', 'In Rainbows', 1),
      album('Radiohead', 'OK Computer', 1),
    ],
  },
  '30d': {
    totals: [5, 2, 4],
    artists: [artist('Radiohead', 3), artist('Björk', 2)],
    tracks: [
      track('Björk', 'Jóga', 2),
      track('Radiohead', 'Karma Police', 1),
      track('Radiohead', 'No Surprises', 1),
      track('Radiohead', 'Weird Fishes', 1),
    ],
    albums: [
      album('Björk', 'Homogenic', 2),
      album('Radiohead', 'OK Computer', 2),
      album('Radiohead', 'In Rainbows', 1),
    ],
  },
  '365d': {
    totals: [6, 3, 5],
    artists: [artist('Radiohead', 3), artist('Björk', 2), artist('Kate Bush', 1)],
    tracks: [
      track('Björk', 'Jóga', 2),
      track('Kate Bush', 'Running Up That Hill', 1),
      track('Radiohead', 'Karma Police', 1),
      track('Radiohead', 'No Surprises', 1),
      track('Radiohead', 'Weird Fishes', 1),
    ],
    albums: [
      album('Björk', 'Homogenic', 2),
      album('Radiohead', 'OK Computer', 2),
      album('Radiohead', 'In Rainbows', 1),
    ],
  },
} as const;

function totalsOf(body: Record<string, unknown>) {
  return [body.totalScrobbles, body.distinctArtists, body.distinctTracks];
}

/** The normalized artist key of each displayed artist, read from the projection. */
function artistKeys(store: TestDb, names: string[]) {
  return inTestDb(store, (db) =>
    names.map(
      (n) => db.one<{ k: string }>('SELECT artist_key AS k FROM scrobbles WHERE did = ? AND artist = ?', ALICE, n)!.k,
    ),
  );
}

// ---------------------------------------------------------------------------
// Named cases
// ---------------------------------------------------------------------------

it('all: 7 listens, 3 artists, 6 tracks; artists (radiohead,3),(björk,2),(kate bush,2)', async () => {
  const { store } = await seedFixture();
  const got = await getStats(store, ALICE);
  expectOk(got, 'all');
  // Defaults: window all, limit 10, asOf = the injected clock, as integer ns.
  expect(got.query).toEqual({ did: ALICE, window: 'all', limit: 10, asOfNs: NOW_NS });
  expect(totalsOf(got.body)).toEqual([7, 3, 6]);
  expect(got.body.topArtists).toEqual(EXPECTED.all.artists);
  expect(await artistKeys(store, ['Radiohead', 'Björk', 'Kate Bush'])).toEqual(['radiohead', 'björk', 'kate bush']);
  // Bob's r09 never leaks into Alice's statistics.
  expect(JSON.stringify(got.body)).not.toContain('Massive Attack');
  // The computed body was cached under the current version, with no lower bound.
  const row = await cacheRow(store, ALICE, 'all', 10);
  expect(row).not.toBeNull();
  expect(row!.as_of).toBe(AS_OF);
  expect(row!.lower).toBeNull();
  expect(row!.version).toBe(await statsVersion(store, ALICE));
});

it('7d: 4/2/3; artists (björk,2),(radiohead,2); tracks Björk/Jóga:2, Radiohead/No Surprises:1, Radiohead/Weird Fishes:1', async () => {
  const { store } = await seedFixture();
  const got = await getStats(store, ALICE, '?window=7d');
  expectOk(got, '7d');
  expect(got.query).toEqual({ did: ALICE, window: '7d', limit: 10, asOfNs: NOW_NS });
  expect(totalsOf(got.body)).toEqual([4, 2, 3]);
  // Count tie: normalized key ascending ('björk' < 'radiohead').
  expect(got.body.topArtists).toEqual([artist('Björk', 2), artist('Radiohead', 2)]);
  expect(got.body.topTracks).toEqual([
    track('Björk', 'Jóga', 2),
    track('Radiohead', 'No Surprises', 1),
    track('Radiohead', 'Weird Fishes', 1),
  ]);
  const row = await cacheRow(store, ALICE, '7d', 10);
  expect(row!.as_of).toBe(AS_OF);
  expect(row!.lower).toBe('2026-01-08T12:00:00.000000000Z');
});

it('30d: 5/2/4 and 365d: 6/3/5 with Kate Bush 1 in 365d', async () => {
  const { store } = await seedFixture();
  const d30 = await getStats(store, ALICE, '?window=30d');
  expectOk(d30, '30d');
  expect(totalsOf(d30.body)).toEqual([5, 2, 4]);
  expect(d30.body.topArtists).toEqual([artist('Radiohead', 3), artist('Björk', 2)]);

  const d365 = await getStats(store, ALICE, '?window=365d');
  expectOk(d365, '365d');
  expect(totalsOf(d365.body)).toEqual([6, 3, 5]);
  expect(d365.body.topArtists).toEqual([artist('Radiohead', 3), artist('Björk', 2), artist('Kate Bush', 1)]);

  expect((await cacheRow(store, ALICE, '30d', 10))!.lower).toBe('2025-12-16T12:00:00.000000000Z');
  expect((await cacheRow(store, ALICE, '365d', 10))!.lower).toBe('2025-01-15T12:00:00.000000000Z');
});

it('top tracks and top albums for every window equal TESTING.md exactly; r05 creates no album bucket', async () => {
  const { store } = await seedFixture();
  for (const window of ['all', '7d', '30d', '365d'] as const) {
    const got = await getStats(store, ALICE, `?window=${window}&limit=100`);
    expectOk(got, window);
    const want = EXPECTED[window];
    expect(totalsOf(got.body)).toEqual(want.totals);
    expect(got.body.topArtists).toEqual(want.artists);
    expect(got.body.topTracks).toEqual(want.tracks);
    expect(got.body.topAlbums).toEqual(want.albums);
    // No album bucket for r05 (album omitted): no entry without an album, nothing named "unknown".
    const albums = got.body.topAlbums as Array<{ album: unknown; artist: string }>;
    expect(albums.every((a) => typeof a.album === 'string' && a.album.trim() !== '')).toBe(true);
    expect(albums.filter((a) => a.artist === 'Kate Bush').map((a) => a.album)).toEqual(
      window === 'all' ? ['Hounds of Love'] : [],
    );
  }
  // In 365d Kate Bush's only listen is r05: one track, no album.
  const r05 = await inTestDb(store, (db) =>
    db.one<{ album: string | null; album_key: string | null }>(
      'SELECT album, album_key FROM scrobbles WHERE uri = ?',
      uriOf(ALICE, SCROBBLE, 'r05'),
    ),
  );
  expect(r05).toEqual({ album: null, album_key: null });

  // `limit` truncates every ranking but never the totals.
  const one = await getStats(store, ALICE, '?limit=1');
  expectOk(one, 'all');
  expect(totalsOf(one.body)).toEqual([7, 3, 6]);
  expect(one.body.topArtists).toEqual([artist('Radiohead', 3)]);
  expect(one.body.topTracks).toEqual([track('Björk', 'Jóga', 2)]);
  expect(one.body.topAlbums).toEqual([album('Björk', 'Homogenic', 2)]);
});

it('display spelling is newest record (Björk not BJÖRK) with URI tie-break', async () => {
  const { store, alice } = await seedFixture();
  const all = await getStats(store, ALICE, '?limit=100');
  expectOk(all, 'all');
  // r01 (2026-01-15, "Björk"/"Jóga"/"Homogenic") is newer than r02 ("  BJÖRK  "/"jóga"/" HOMOGENIC ").
  expect(all.body.topArtists).toContainEqual(artist('Björk', 2));
  expect(all.body.topTracks).toContainEqual(track('Björk', 'Jóga', 2));
  expect(all.body.topAlbums).toContainEqual(album('Björk', 'Homogenic', 2));
  expect(JSON.stringify(all.body)).not.toMatch(/BJÖRK|jóga|HOMOGENIC/);

  // Equal listenedAt: the greater AT URI wins, whatever the insertion order.
  const at = '2026-01-15T11:50:00Z';
  await put(
    store,
    alice,
    'u2',
    scrobble({ artist: 'MASSIVE attack', track: 'TEARDROP', album: 'MEZZANINE', listenedAt: at }),
  );
  await put(
    store,
    alice,
    'u1',
    scrobble({ artist: 'Massive Attack', track: 'Teardrop', album: 'Mezzanine', listenedAt: at }),
  );
  // An older listen with yet another spelling never displays.
  await put(
    store,
    alice,
    'u3',
    scrobble({ artist: 'massive attack', track: 'teardrop', album: 'mezzanine', listenedAt: '2026-01-15T10:00:00Z' }),
  );
  const tie = await getStats(store, ALICE, '?limit=100');
  expectOk(tie, 'all');
  expect(totalsOf(tie.body)).toEqual([10, 4, 7]);
  expect(tie.body.topArtists).toEqual([
    artist('MASSIVE attack', 3),
    artist('Radiohead', 3),
    artist('Björk', 2),
    artist('Kate Bush', 2),
  ]);
  expect(tie.body.topTracks).toContainEqual(track('MASSIVE attack', 'TEARDROP', 3));
  expect(tie.body.topAlbums).toContainEqual(album('MASSIVE attack', 'MEZZANINE', 3));
  // The displayed row is the one at the greater URI (u2 > u1) among the newest.
  const display = await inTestDb(store, (db) =>
    db.all<{ rkey: string; artist: string; listened_at: string }>(
      `SELECT rkey, artist, listened_at FROM scrobbles WHERE did = ? AND artist_key = 'massive attack'
       ORDER BY listened_at DESC, uri DESC`,
      ALICE,
    ),
  );
  expect(display.map((r) => r.rkey)).toEqual(['u2', 'u1', 'u3']);
  // The data changed, so the cached body was recomputed (version bumped, row rewritten).
  const row = await cacheRow(store, ALICE, 'all', 100);
  expect(row!.version).toBe(await statsVersion(store, ALICE));
  expect(JSON.parse(row!.body).statistics.topArtists[0]).toEqual(artist('MASSIVE attack', 3));
});

// ---------------------------------------------------------------------------
// Route contract (supporting)
// ---------------------------------------------------------------------------

it('invalid did, window, limit, cursor and repeated parameters are 422 naming the field, before any RPC', async () => {
  const store = await openTestDb();
  const limitReason = 'Expected an integer between 1 and 100.';
  const cases: Array<[string, string, Record<string, string>]> = [
    ['alice', '', { did: 'Expected a DID.' }],
    [ALICE, '?window=1d', { window: 'Expected all, 7d, 30d or 365d.' }],
    [ALICE, '?window=', { window: 'Expected all, 7d, 30d or 365d.' }],
    [ALICE, '?limit=0', { limit: limitReason }],
    [ALICE, '?limit=-1', { limit: limitReason }],
    [ALICE, '?limit=1.5', { limit: limitReason }],
    [ALICE, '?limit=101', { limit: limitReason }],
    [ALICE, '?limit=', { limit: limitReason }],
    [ALICE, '?window=all&window=7d', { window: 'Parameter must occur only once.' }],
    [ALICE, '?limit=1&limit=2', { limit: 'Parameter must occur only once.' }],
    [ALICE, '?cursor=abc', { cursor: 'Statistics do not use cursors.' }],
  ];
  for (const [did, query, fields] of cases) {
    const got = await getStats(store, did, query);
    await expectError(got, 422, 'validation_failed', fields);
    expect(got.calls).toBe(0);
  }
  // Limit 100 is accepted (the maximum, no clamping), and so is limit 1.
  await inTestDb(store, (db) => seedUser(db, ALICE));
  for (const limit of [1, 100]) {
    const got = await getStats(store, ALICE, `?limit=${limit}`);
    expect(got.status).toBe(200);
    expect(got.query?.limit).toBe(limit);
  }
});

it('unknown, inactive and suppressed users are 404 not_found and leave no cache row', async () => {
  const store = await openTestDb();
  const unknown = 'did:plc:dddddddddddddddddddddddd';
  const got = await getStats(store, unknown);
  await expectError(got, 404, 'not_found', undefined);
  expect(got.calls).toBe(1);

  // Inactive (no complete snapshot yet) with rows present: still 404.
  const { store: s2 } = await seedFixture();
  await inTestDb(s2, (db) => db.run('UPDATE users SET active = 0 WHERE did = ?', ALICE));
  await expectError(await getStats(s2, ALICE), 404, 'not_found', undefined);
  // Suppressed marker present: 404 as well, even if a users row were active.
  await inTestDb(s2, (db) => {
    db.run('UPDATE users SET active = 1 WHERE did = ?', ALICE);
    db.run('INSERT INTO suppression(did, suppressed_at) VALUES (?, ?)', ALICE, AS_OF);
  });
  await expectError(await getStats(s2, ALICE, '?window=7d'), 404, 'not_found', undefined);
  const rows = await inTestDb(s2, (db) =>
    db.one<{ n: number }>('SELECT count(*) AS n FROM stats_cache WHERE did = ?', ALICE),
  );
  expect(rows).toEqual({ n: 0 });
});

it('module stats equals the uncached computation for every window', async () => {
  const { store } = await seedFixture();
  await inTestDb(store, (db) => {
    const m = { db } as ModuleDeps;
    for (const window of ['all', '7d', '30d', '365d'] as const) {
      const q: StatsQuery = { did: ALICE, window, limit: 10, asOfNs: NOW_NS };
      const first = stats(m, q);
      const second = stats(m, q);
      const direct = computeStatistics(db, ALICE, window, 10, NOW_NS);
      expect(first).toEqual(direct);
      expect(second).toEqual(direct);
      expect(direct.totalScrobbles).toBe(EXPECTED[window].totals[0]);
    }
  });
});
