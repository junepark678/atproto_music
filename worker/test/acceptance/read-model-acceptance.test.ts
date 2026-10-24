// W6-01 read-model acceptance (ADR 0004 §10.3; TESTING.md "Shared read-model
// fixture", "Exact initial history/feed assertions", "Exact statistics
// assertions", "Cursor assertions"). Proves M4.3.3/page_union,
// M5.1.2/window_totals, M5.4.1/manual_expectations, M5.4.2/read_acceptance and
// the acceptance halves of M3.1.3/equal_timestamp and M5.3.2/public_lists.
//
// tests/fixtures/read_models.json reaches the real IndexDO only as fake
// Jetstream events, verified and applied by the production alarm
// (support/seed.ts). Every expected value below is hardcoded from TESTING.md
// (CIDs come from the fixture signer, never from the code under test). Every
// response is validated against api/openapi.yaml; each test also asserts DO
// table state and the fixture network's call counts.

import { followRkey } from '@atmusic/atproto/test-support/read-models';
import { describe, expect, it } from 'vitest';
import {
  ALICE,
  AS_OF,
  BOB,
  CAROL,
  FOLLOW,
  inSocket,
  rkeyOf,
  SCROBBLE,
  type Seeded,
  seedAcceptance,
  storedScrobbles,
  uriOf,
} from './support/seed';

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated against api/openapi.yaml before they reach a test.
type Json = any;

const ALICE_HISTORY = ['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06'];
const GLOBAL_FEED = ['r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06'];
const OWNER: Record<string, string> = {
  r01: ALICE,
  r02: ALICE,
  r03: ALICE,
  r04: ALICE,
  r05: ALICE,
  r06: ALICE,
  r07: ALICE,
  r08: ALICE,
  r09: BOB,
  r10: CAROL,
};
const U = (rkey: string) => uriOf(OWNER[rkey] as string, rkey);

const rkeys = (body: Json): string[] => (body.items as Array<{ uri: string }>).map((s) => rkeyOf(s.uri));
const enc = encodeURIComponent;

/** The signer's CID for a fixture URI (never computed by the index). */
function cidOf(a: Seeded, uri: string): string {
  const r = a.seed.records.get(uri);
  if (r === undefined) throw new Error(`no seeded record ${uri}`);
  return r.cid;
}

/** Exactly what the stored scrobbles table must hold after seeding: the confirmed records, r08 absent. */
function expectedStored(a: Seeded, did?: string) {
  return Object.keys(OWNER)
    .filter((k) => k !== 'r08' && (did === undefined || OWNER[k] === did))
    .map((k) => ({ uri: U(k), cid: cidOf(a, U(k)) }))
    .sort((x, y) => (x.uri < y.uri ? -1 : 1));
}

async function pages(a: Seeded, base: string, limit: number): Promise<{ pages: string[][]; uris: string[] }> {
  const out: string[][] = [];
  const uris: string[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 50; n++) {
    const sep = base.includes('?') ? '&' : '?';
    const r = await a.request(`${base}${sep}limit=${limit}${cursor === null ? '' : `&cursor=${enc(cursor)}`}`);
    expect(r.status).toBe(200);
    out.push(rkeys(r.body));
    uris.push(...(r.body as Json).items.map((s: { uri: string }) => s.uri));
    cursor = (r.body as Json).nextCursor;
    if (cursor === null) return { pages: out, uris };
  }
  throw new Error('pagination did not end');
}

describe('read-model acceptance', () => {
  it('Alice history exact order and limit-2 pages over HTTP', async () => {
    const a = await seedAcceptance('history');

    // DO tables: the seven confirmed records with the signer's CIDs; r08 verified absent.
    const tables = await a.inDo((db) => ({
      stored: storedScrobbles(db, ALICE),
      r08: db.one('SELECT state, revision FROM record_state WHERE uri = ?', U('r08')),
      user: db.one('SELECT active, indexing_state FROM users WHERE did = ?', ALICE),
    }));
    expect(tables.stored).toEqual(expectedStored(a, ALICE));
    expect(tables.r08).toEqual({ state: 'absent', revision: a.seed.records.get(U('r08'))?.rev });
    expect(tables.user).toEqual({ active: 1, indexing_state: 'current' });

    // One full page (default limit 20).
    const all = await a.request(`/api/v1/users/${ALICE}/scrobbles`);
    expect(all.status).toBe(200);
    expect(rkeys(all.body)).toEqual(ALICE_HISTORY);
    expect((all.body as Json).nextCursor).toBeNull();
    expect((all.body as Json).asOf).toBe('2026-01-15T12:00:00.000000000Z');
    // Equal timestamps (r07 and r01 at 11:00:00) order by full AT URI descending.
    const first = (all.body as Json).items.slice(0, 2);
    expect(first.map((s: Json) => s.listenedAt)).toEqual([
      '2026-01-15T11:00:00.000000000Z',
      '2026-01-15T11:00:00.000000000Z',
    ]);
    expect(first.map((s: Json) => s.uri)).toEqual([U('r07'), U('r01')]);
    // Every item is the verified record: signer CID, fixture fields.
    expect(
      (all.body as Json).items.map((s: Json) => ({
        uri: s.uri,
        cid: s.cid,
        did: s.did,
        artist: s.artist,
        track: s.track,
        album: s.album ?? null,
        listenedAt: s.listenedAt,
      })),
    ).toEqual([
      {
        uri: U('r07'),
        cid: cidOf(a, U('r07')),
        did: ALICE,
        artist: 'Radiohead',
        track: 'No Surprises',
        album: 'OK Computer',
        listenedAt: '2026-01-15T11:00:00.000000000Z',
      },
      {
        uri: U('r01'),
        cid: cidOf(a, U('r01')),
        did: ALICE,
        artist: 'Björk',
        track: 'Jóga',
        album: 'Homogenic',
        listenedAt: '2026-01-15T11:00:00.000000000Z',
      },
      {
        uri: U('r02'),
        cid: cidOf(a, U('r02')),
        did: ALICE,
        // Payloads are the verified record as written; only grouping keys are normalized.
        artist: '  BJÖRK  ',
        track: 'jóga',
        album: ' HOMOGENIC ',
        listenedAt: '2026-01-14T11:00:00.000000000Z',
      },
      {
        uri: U('r03'),
        cid: cidOf(a, U('r03')),
        did: ALICE,
        artist: 'Radiohead',
        track: 'Weird Fishes',
        album: 'In Rainbows',
        listenedAt: '2026-01-08T12:00:00.000000000Z',
      },
      {
        uri: U('r04'),
        cid: cidOf(a, U('r04')),
        did: ALICE,
        artist: 'Radiohead',
        track: 'Karma Police',
        album: 'OK Computer',
        listenedAt: '2025-12-16T12:00:00.000000000Z',
      },
      {
        uri: U('r05'),
        cid: cidOf(a, U('r05')),
        did: ALICE,
        artist: 'Kate Bush',
        track: 'Running Up That Hill',
        album: null,
        listenedAt: '2025-01-15T12:00:00.000000000Z',
      },
      {
        uri: U('r06'),
        cid: cidOf(a, U('r06')),
        did: ALICE,
        artist: 'Kate Bush',
        track: 'Cloudbusting',
        album: 'Hounds of Love',
        listenedAt: '2025-01-14T11:00:00.000000000Z',
      },
    ]);
    // r05 omits album: the key is absent, not an empty string.
    expect(Object.hasOwn((all.body as Json).items[5], 'album')).toBe(false);

    // Limit 2: [r07,r01] [r02,r03] [r04,r05] [r06], then no next cursor.
    const paged = await pages(a, `/api/v1/users/${ALICE}/scrobbles`, 2);
    expect(paged.pages).toEqual([['r07', 'r01'], ['r02', 'r03'], ['r04', 'r05'], ['r06']]);

    // Limits are not clamped.
    for (const bad of ['0', '101', '-1', '1.5']) {
      const r = await a.request(`/api/v1/users/${ALICE}/scrobbles?limit=${bad}`);
      expect([bad, r.status, (r.body as Json).error.code, (r.body as Json).error.fields]).toEqual([
        bad,
        422,
        'validation_failed',
        { limit: expect.any(String) },
      ]);
    }

    // Reads never touch the network; every response was schema-checked.
    expect(a.kit.transport.calls.entries).toEqual([]);
    expect(a.validated).toBe(1 + 4 + 4);
  });

  it('global feed r09,r10,r07,r01,r02,r03,r04,r05,r06 and Alice following r09 only', async () => {
    const a = await seedAcceptance('feeds');
    const tables = await a.inDo((db) => ({
      stored: storedScrobbles(db),
      follows: db.all('SELECT uri, cid, actor, subject FROM follows ORDER BY uri'),
      active: db.all('SELECT did FROM users WHERE active = 1 ORDER BY did'),
    }));
    expect(tables.stored).toEqual(expectedStored(a));
    const followUri = uriOf(ALICE, await followRkey(BOB), FOLLOW);
    expect(tables.follows).toEqual([{ uri: followUri, cid: cidOf(a, followUri), actor: ALICE, subject: BOB }]);
    expect(tables.active).toEqual([{ did: ALICE }, { did: BOB }, { did: CAROL }]);

    const global = await a.request('/api/v1/feed?scope=global');
    expect(global.status).toBe(200);
    expect(rkeys(global.body)).toEqual(GLOBAL_FEED);
    expect((global.body as Json).nextCursor).toBeNull();
    expect((global.body as Json).items.map((s: Json) => [s.uri, s.cid])).toEqual(
      GLOBAL_FEED.map((k) => [U(k), cidOf(a, U(k))]),
    );
    // The default scope is global, and the global feed includes Alice herself.
    const dflt = await a.request('/api/v1/feed');
    expect(dflt.status).toBe(200);
    expect(rkeys(dflt.body)).toEqual(GLOBAL_FEED);
    const paged = await pages(a, '/api/v1/feed?scope=global', 4);
    expect(paged.pages).toEqual([['r09', 'r10', 'r07', 'r01'], ['r02', 'r03', 'r04', 'r05'], ['r06']]);

    // Following: only Bob's r09; never Alice's own records, never Carol's.
    const following = await a.request(`/api/v1/feed?scope=following&viewer=${enc(ALICE)}`);
    expect(following.status).toBe(200);
    expect(rkeys(following.body)).toEqual(['r09']);
    expect((following.body as Json).nextCursor).toBeNull();
    // Bob follows nobody; an unknown viewer gets an empty 200 page.
    for (const viewer of [BOB, CAROL, 'did:plc:dddddddddddddddddddddddd']) {
      const r = await a.request(`/api/v1/feed?scope=following&viewer=${enc(viewer)}`);
      expect([viewer, r.status, rkeys(r.body)]).toEqual([viewer, 200, []]);
    }
    // A following feed without a viewer is 422 fields.viewer (A8).
    const missing = await a.request('/api/v1/feed?scope=following');
    expect(missing.status).toBe(422);
    expect((missing.body as Json).error.fields).toEqual({ viewer: expect.any(String) });

    expect(a.kit.transport.calls.entries).toEqual([]);
    expect(a.validated).toBe(2 + 3 + 1 + 3 + 1);
  });

  it('follower/following counts Alice 0/1, Bob 1/0, Carol 0/0', async () => {
    const a = await seedAcceptance('counts');
    const followUri = uriOf(ALICE, await followRkey(BOB), FOLLOW);
    expect(
      await a.inDo((db) => db.all('SELECT uri, cid, actor, subject, created_at FROM follows ORDER BY uri')),
    ).toEqual([
      {
        uri: followUri,
        cid: cidOf(a, followUri),
        actor: ALICE,
        subject: BOB,
        created_at: '2025-01-01T00:00:00.000000000Z',
      },
    ]);

    const expected: Array<[string, string, number, number, number]> = [
      [ALICE, 'alice.test', 0, 1, 7],
      [BOB, 'bob.test', 1, 0, 1],
      [CAROL, 'carol.test', 0, 0, 1],
    ];
    for (const [did, handle, followers, followingCount, total] of expected) {
      const p = await a.request(`/api/v1/users/${did}/profile`);
      expect(p.status).toBe(200);
      expect(p.headers.get('cache-control')).toBe('no-store');
      const body = p.body as Json;
      expect([did, body.did, body.handle, body.followerCount, body.followingCount, body.totalScrobbles]).toEqual([
        did,
        did,
        handle,
        followers,
        followingCount,
        total,
      ]);

      const fr = await a.request(`/api/v1/users/${did}/followers`);
      const fg = await a.request(`/api/v1/users/${did}/following`);
      expect([fr.status, fg.status]).toEqual([200, 200]);
      expect([did, (fr.body as Json).items.length, (fg.body as Json).items.length]).toEqual([
        did,
        followers,
        followingCount,
      ]);
    }
    // The one edge, from both ends, with the signer's CID.
    const edge = {
      uri: followUri,
      cid: cidOf(a, followUri),
      actor: ALICE,
      subject: BOB,
      createdAt: '2025-01-01T00:00:00.000000000Z',
    };
    expect((await a.request(`/api/v1/users/${ALICE}/following`)).body).toMatchObject({
      items: [edge],
      nextCursor: null,
    });
    expect((await a.request(`/api/v1/users/${BOB}/followers`)).body).toMatchObject({ items: [edge], nextCursor: null });

    // Profiles show a handle only when it verifies both ways; the identity
    // resolved two minutes ago is still within the 5-minute identity_cache TTL,
    // so these reads make no remote call at all (no PDS, PLC or DoH request).
    expect(a.kit.transport.calls.entries.map((c) => `${c.service} ${c.host} ${c.path}`)).toEqual([]);
    expect(a.kit.plc.calls.entries).toEqual([]);
    expect(a.validated).toBe(3 * 3 + 2);
  });

  it('statistics tables for all/7d/30d/365d equal TESTING.md exactly (totals, artists, tracks, albums)', async () => {
    const a = await seedAcceptance('stats');

    // Stored grouping keys (NFKC → case fold → trim/collapse), hardcoded per record.
    const keys = await a.inDo((db) =>
      db.all<{ rkey: string; artist_key: string; track_key: string; album_key: string | null }>(
        'SELECT rkey, artist_key, track_key, album_key FROM scrobbles WHERE did = ? ORDER BY rkey',
        ALICE,
      ),
    );
    expect(keys).toEqual([
      { rkey: 'r01', artist_key: 'björk', track_key: 'jóga', album_key: 'homogenic' },
      { rkey: 'r02', artist_key: 'björk', track_key: 'jóga', album_key: 'homogenic' },
      { rkey: 'r03', artist_key: 'radiohead', track_key: 'weird fishes', album_key: 'in rainbows' },
      { rkey: 'r04', artist_key: 'radiohead', track_key: 'karma police', album_key: 'ok computer' },
      { rkey: 'r05', artist_key: 'kate bush', track_key: 'running up that hill', album_key: null },
      { rkey: 'r06', artist_key: 'kate bush', track_key: 'cloudbusting', album_key: 'hounds of love' },
      { rkey: 'r07', artist_key: 'radiohead', track_key: 'no surprises', album_key: 'ok computer' },
    ]);

    const A = (artist: string, n: number) => ({ artist, scrobbleCount: n });
    const T = (artist: string, track: string, n: number) => ({ artist, track, scrobbleCount: n });
    const L = (artist: string, album: string, n: number) => ({ artist, album, scrobbleCount: n });
    const EXPECTED = {
      all: {
        totalScrobbles: 7,
        distinctArtists: 3,
        distinctTracks: 6,
        topArtists: [A('Radiohead', 3), A('Björk', 2), A('Kate Bush', 2)],
        topTracks: [
          T('Björk', 'Jóga', 2),
          T('Kate Bush', 'Cloudbusting', 1),
          T('Kate Bush', 'Running Up That Hill', 1),
          T('Radiohead', 'Karma Police', 1),
          T('Radiohead', 'No Surprises', 1),
          T('Radiohead', 'Weird Fishes', 1),
        ],
        topAlbums: [
          L('Björk', 'Homogenic', 2),
          L('Radiohead', 'OK Computer', 2),
          L('Kate Bush', 'Hounds of Love', 1),
          L('Radiohead', 'In Rainbows', 1),
        ],
      },
      '7d': {
        totalScrobbles: 4,
        distinctArtists: 2,
        distinctTracks: 3,
        topArtists: [A('Björk', 2), A('Radiohead', 2)],
        topTracks: [T('Björk', 'Jóga', 2), T('Radiohead', 'No Surprises', 1), T('Radiohead', 'Weird Fishes', 1)],
        topAlbums: [L('Björk', 'Homogenic', 2), L('Radiohead', 'In Rainbows', 1), L('Radiohead', 'OK Computer', 1)],
      },
      '30d': {
        totalScrobbles: 5,
        distinctArtists: 2,
        distinctTracks: 4,
        topArtists: [A('Radiohead', 3), A('Björk', 2)],
        topTracks: [
          T('Björk', 'Jóga', 2),
          T('Radiohead', 'Karma Police', 1),
          T('Radiohead', 'No Surprises', 1),
          T('Radiohead', 'Weird Fishes', 1),
        ],
        topAlbums: [L('Björk', 'Homogenic', 2), L('Radiohead', 'OK Computer', 2), L('Radiohead', 'In Rainbows', 1)],
      },
      '365d': {
        totalScrobbles: 6,
        distinctArtists: 3,
        distinctTracks: 5,
        topArtists: [A('Radiohead', 3), A('Björk', 2), A('Kate Bush', 1)],
        topTracks: [
          T('Björk', 'Jóga', 2),
          T('Kate Bush', 'Running Up That Hill', 1),
          T('Radiohead', 'Karma Police', 1),
          T('Radiohead', 'No Surprises', 1),
          T('Radiohead', 'Weird Fishes', 1),
        ],
        topAlbums: [L('Björk', 'Homogenic', 2), L('Radiohead', 'OK Computer', 2), L('Radiohead', 'In Rainbows', 1)],
      },
    } as const;

    for (const window of ['all', '7d', '30d', '365d'] as const) {
      const r = await a.request(`/api/v1/users/${ALICE}/stats?window=${window}&limit=100`);
      expect([window, r.status]).toEqual([window, 200]);
      expect(r.body).toEqual({ did: ALICE, window, asOf: '2026-01-15T12:00:00.000000000Z', ...EXPECTED[window] });
    }
    // The default window is all, the default limit 10.
    const dflt = await a.request(`/api/v1/users/${ALICE}/stats`);
    expect(dflt.status).toBe(200);
    expect(dflt.body).toEqual({ did: ALICE, window: 'all', asOf: '2026-01-15T12:00:00.000000000Z', ...EXPECTED.all });
    // limit=1 truncates each ranking to its head; limit is never clamped.
    const one = await a.request(`/api/v1/users/${ALICE}/stats?window=all&limit=1`);
    expect(one.body).toMatchObject({
      totalScrobbles: 7,
      topArtists: [A('Radiohead', 3)],
      topTracks: [T('Björk', 'Jóga', 2)],
      topAlbums: [L('Björk', 'Homogenic', 2)],
    });
    for (const bad of ['window=90d', 'limit=0', 'limit=101']) {
      const r = await a.request(`/api/v1/users/${ALICE}/stats?${bad}`);
      expect([bad, r.status]).toEqual([bad, 422]);
    }

    // The exact cache now holds one body per (window, limit) computed at asOf.
    const cache = await a.inDo((db) =>
      db.all<{ win: string; lim: number }>('SELECT win, lim FROM stats_cache WHERE did = ? ORDER BY win, lim', ALICE),
    );
    expect(cache).toEqual([
      { win: '30d', lim: 100 },
      { win: '365d', lim: 100 },
      { win: '7d', lim: 100 },
      { win: 'all', lim: 1 },
      { win: 'all', lim: 10 },
      { win: 'all', lim: 100 },
    ]);
    expect(a.kit.transport.calls.entries).toEqual([]);
    expect(a.validated).toBe(4 + 1 + 1 + 3);
  });

  it('boundary seconds and future exclusion', async () => {
    const a = await seedAcceptance('boundaries');
    expect(a.kit.clock.nowMs()).toBe(Date.parse(AS_OF));

    // Bob gains one record one second before, at and after each window's lower
    // bound, one exactly at asOf, and three in the future (+1 s, +300 s
    // accepted; +301 s rejected at receipt), each through a Jetstream event
    // received at asOf.
    const boundary: Array<[string, string]> = [
      ['b007m', '2026-01-08T11:59:59Z'],
      ['b007z', '2026-01-08T12:00:00Z'],
      ['b007p', '2026-01-08T12:00:01Z'],
      ['b030m', '2025-12-16T11:59:59Z'],
      ['b030z', '2025-12-16T12:00:00Z'],
      ['b030p', '2025-12-16T12:00:01Z'],
      ['b365m', '2025-01-15T11:59:59Z'],
      ['b365z', '2025-01-15T12:00:00Z'],
      ['b365p', '2025-01-15T12:00:01Z'],
      ['asof0', '2026-01-15T12:00:00Z'],
      ['fut001', '2026-01-15T12:00:01Z'],
      ['fut300', '2026-01-15T12:05:00Z'],
      ['fut301', '2026-01-15T12:05:01Z'],
    ];
    await inSocket(a, async () => {
      for (const [rkey, at] of boundary) {
        await a.kit.createRecord('Bob', SCROBBLE, rkey, {
          $type: SCROBBLE,
          artist: 'Boundary',
          track: rkey,
          listenedAt: at,
          // createdAt stays at receipt time, so only listenedAt is under test.
          createdAt: AS_OF,
        });
      }
    });
    expect(await a.inDo((db) => db.one('SELECT count(*) AS n FROM hints WHERE did = ?', BOB))).toEqual({
      n: boundary.length,
    });
    // One drain at asOf verifies all 13 (one getRecord each).
    expect(await a.alarm()).toBe(true);
    expect(a.kit.clock.nowMs()).toBe(Date.parse(AS_OF));
    const state = await a.inDo((db) => ({
      hints: db.one<{ n: number }>('SELECT count(*) AS n FROM hints')?.n,
      bob: db.all<{ rkey: string }>('SELECT rkey FROM scrobbles WHERE did = ? ORDER BY rkey', BOB).map((r) => r.rkey),
      excluded: db.all('SELECT uri, state, reason FROM record_state WHERE state = ? ORDER BY uri', 'excluded'),
    }));
    expect(state.hints).toBe(0);
    // +300 s is accepted (stored), +301 s is excluded with a reason and never stored.
    expect(state.bob).toEqual([
      'asof0',
      'b007m',
      'b007p',
      'b007z',
      'b030m',
      'b030p',
      'b030z',
      'b365m',
      'b365p',
      'b365z',
      'fut001',
      'fut300',
      'r09',
    ]);
    expect(state.excluded).toEqual([
      {
        uri: uriOf(BOB, 'fut301'),
        state: 'excluded',
        reason: 'listenedAt: timestamp must be between 1970-01-01 and receipt time plus 300 seconds',
      },
    ]);
    expect(await a.inDo((db) => db.all("SELECT label, value FROM counters WHERE name = 'excluded'"))).toEqual([
      { label: 'listenedAt: timestamp must be between 1970-01-01 and receipt time plus 300 seconds', value: 1 },
    ]);
    expect(a.kit.pds.Bob.calls.count({ nsid: 'com.atproto.sync.getRecord' })).toBe(boundary.length);
    expect(a.kit.pds.Bob.calls.count({ nsid: 'com.atproto.repo.createRecord' })).toBe(boundary.length);
    expect(a.kit.pds.Alice.calls.entries.length + a.kit.pds.Carol.calls.entries.length).toBe(0);

    const members = async (window: string) => {
      const r = await a.request(`/api/v1/users/${BOB}/stats?window=${window}&limit=100`);
      expect([window, r.status]).toEqual([window, 200]);
      const body = r.body as Json;
      return {
        total: body.totalScrobbles,
        tracks: (body.topTracks as Array<{ artist: string; track: string }>).map((t) => `${t.artist}/${t.track}`),
      };
    };
    // Exact membership: both bounds inclusive, future rows excluded until listenedAt <= asOf.
    expect(await members('7d')).toEqual({
      total: 4,
      tracks: ['Boundary/asof0', 'Boundary/b007p', 'Boundary/b007z', 'Massive Attack/Teardrop'],
    });
    expect(await members('30d')).toEqual({
      total: 7,
      tracks: [
        'Boundary/asof0',
        'Boundary/b007m',
        'Boundary/b007p',
        'Boundary/b007z',
        'Boundary/b030p',
        'Boundary/b030z',
        'Massive Attack/Teardrop',
      ],
    });
    expect(await members('365d')).toEqual({
      total: 10,
      tracks: [
        'Boundary/asof0',
        'Boundary/b007m',
        'Boundary/b007p',
        'Boundary/b007z',
        'Boundary/b030m',
        'Boundary/b030p',
        'Boundary/b030z',
        'Boundary/b365p',
        'Boundary/b365z',
        'Massive Attack/Teardrop',
      ],
    });
    expect(await members('all')).toEqual({
      total: 11,
      tracks: [
        'Boundary/asof0',
        'Boundary/b007m',
        'Boundary/b007p',
        'Boundary/b007z',
        'Boundary/b030m',
        'Boundary/b030p',
        'Boundary/b030z',
        'Boundary/b365m',
        'Boundary/b365p',
        'Boundary/b365z',
        'Massive Attack/Teardrop',
      ],
    });
    // The future rows are public records nonetheless (history is not a statistic).
    const history = await a.request(`/api/v1/users/${BOB}/scrobbles?limit=3`);
    expect(rkeys(history.body)).toEqual(['fut300', 'fut001', 'asof0']);

    // Five minutes later both accepted future rows count; +301 s never does.
    a.kit.clock.set('2026-01-15T12:05:00Z');
    const later = await a.request(`/api/v1/users/${BOB}/stats?window=all&limit=100`);
    expect(later.status).toBe(200);
    expect(later.body).toMatchObject({ asOf: '2026-01-15T12:05:00.000000000Z', totalScrobbles: 13 });
    expect((later.body as Json).topTracks.map((t: Json) => t.track)).toEqual([
      'asof0',
      'b007m',
      'b007p',
      'b007z',
      'b030m',
      'b030p',
      'b030z',
      'b365m',
      'b365p',
      'b365z',
      'fut001',
      'fut300',
      'Teardrop',
    ]);
    // Alice's table is untouched by Bob's records.
    const alice = await a.request(`/api/v1/users/${ALICE}/stats?window=all`);
    expect(alice.body).toMatchObject({ totalScrobbles: 7, distinctArtists: 3, distinctTracks: 6 });
    expect(a.validated).toBe(4 + 1 + 1 + 1);
  });

  it('union of all pages equals hardcoded URI list with no duplicates', async () => {
    const a = await seedAcceptance('union');
    const HISTORY_URIS = ALICE_HISTORY.map(U);
    const GLOBAL_URIS = GLOBAL_FEED.map(U);

    // Every page size: the union is the complete ordered list, nothing twice, nothing missing.
    for (const limit of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = await pages(a, `/api/v1/users/${ALICE}/scrobbles`, limit);
      expect([limit, h.uris]).toEqual([limit, HISTORY_URIS]);
      expect(new Set(h.uris).size).toBe(HISTORY_URIS.length);
      const g = await pages(a, '/api/v1/feed?scope=global', limit);
      expect([limit, g.uris]).toEqual([limit, GLOBAL_URIS]);
      expect(new Set(g.uris).size).toBe(GLOBAL_URIS.length);
    }

    // Cursor binding: a tampered bit, another DID, another scope or viewer, a
    // wrong version and bad base64 are 400 invalid_cursor, never a reset.
    const p1 = await a.request(`/api/v1/users/${ALICE}/scrobbles?limit=2`);
    const cursor = (p1.body as Json).nextCursor as string;
    const g1 = await a.request('/api/v1/feed?scope=global&limit=2');
    const gCursor = (g1.body as Json).nextCursor as string;
    const f1 = await a.request(`/api/v1/feed?scope=following&viewer=${enc(BOB)}&limit=1`);
    expect((f1.body as Json).nextCursor).toBeNull();
    const flip = (c: string, i: number) => {
      const ch = c[i] as string;
      return c.slice(0, i) + (ch === 'A' ? 'B' : 'A') + c.slice(i + 1);
    };
    const [payload, mac] = cursor.split('.') as [string, string];
    const payloadJson = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    const reencode = (v: unknown) =>
      `${btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${mac}`;
    const refused: Array<[string, string]> = [
      ['mac bit', `/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${enc(flip(cursor, cursor.length - 3))}`],
      ['payload bit', `/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${enc(flip(cursor, 10))}`],
      ['other did', `/api/v1/users/${BOB}/scrobbles?limit=2&cursor=${enc(cursor)}`],
      ['history cursor on feed', `/api/v1/feed?scope=global&limit=2&cursor=${enc(cursor)}`],
      [
        'global cursor on following',
        `/api/v1/feed?scope=following&viewer=${enc(ALICE)}&limit=2&cursor=${enc(gCursor)}`,
      ],
      ['version 2', `/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${enc(reencode({ ...payloadJson, version: 2 }))}`],
      ['bad base64', `/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${enc('***.***')}`],
    ];
    for (const [label, path] of refused) {
      const r = await a.request(path);
      expect([label, r.status, (r.body as Json).error.code]).toEqual([label, 400, 'invalid_cursor']);
    }

    // An arrival above the anchor does not appear in this traversal; a delete of a
    // not-yet-returned record removes it. Both reach the index as Jetstream events.
    const r05 = a.seed.records.get(U('r05'));
    await inSocket(a, async () => {
      await a.kit.createRecord('Alice', SCROBBLE, 'r11', {
        $type: SCROBBLE,
        artist: 'Björk',
        track: 'Hyperballad',
        listenedAt: '2026-01-15T11:59:00Z',
        createdAt: '2026-01-15T11:59:00Z',
      });
      await a.kit.deleteRecord('Alice', SCROBBLE, 'r05', r05?.cid);
    });
    expect(await a.alarm()).toBe(true);
    const after = await a.inDo((db) => ({
      r11: db.one('SELECT uri FROM scrobbles WHERE uri = ?', uriOf(ALICE, 'r11')),
      r05: db.one('SELECT state FROM record_state WHERE uri = ?', U('r05')),
      hints: db.one<{ n: number }>('SELECT count(*) AS n FROM hints')?.n,
    }));
    expect(after).toEqual({ r11: { uri: uriOf(ALICE, 'r11') }, r05: { state: 'absent' }, hints: 0 });
    expect(a.kit.pds.Alice.calls.count({ nsid: 'com.atproto.sync.getRecord' })).toBe(2);

    const rest: string[] = [...rkeys(p1.body)];
    let next: string | null = cursor;
    while (next !== null) {
      const r = await a.request(`/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${enc(next)}`);
      expect(r.status).toBe(200);
      rest.push(...rkeys(r.body));
      next = (r.body as Json).nextCursor;
    }
    expect(rest).toEqual(['r07', 'r01', 'r02', 'r03', 'r04', 'r06']);
    // A fresh traversal sees the arrival.
    const fresh = await pages(a, `/api/v1/users/${ALICE}/scrobbles`, 2);
    expect(fresh.pages).toEqual([['r11', 'r07'], ['r01', 'r02'], ['r03', 'r04'], ['r06']]);
  });
});
