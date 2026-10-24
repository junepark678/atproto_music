// Profile screen (W3-06; M7.3.2 profile_stats / handle_change / empty_states,
// M7.3.3 follow_state / unfollow_failure / self_and_auth, M7.2.3
// delete_owner). Reads go through the real ApiClient over an injected fetch
// serving the TESTING.md fixture (the Rust oracle's projection of
// tests/fixtures/read_models.json). Writes go through the W2-07 outbox over
// the fake PDS; its runner is driven with runDue() and the frozen clock.

import type { Did, Follow, Profile, Scrobble, Statistics, StatsWindow } from '@atmusic/core/api-types';
import { followRkey } from '@atmusic/core/record-key';
import { afterEach, describe, expect, it } from 'vitest';
import type { PdsSession } from '../../src/oauth/types';
import { createAppState } from '../../src/state/store';
import { FOLLOW } from '../support/fake-pds-browser';
import {
  ALICE,
  ALICE_HISTORY,
  aliceStats,
  BOB,
  buttonByText,
  CAROL,
  click,
  emptyStats,
  type FakeApi,
  fakeApi,
  GLOBAL_FEED,
  json,
  linkByText,
  listedRkeys,
  META_READ_ONLY,
  type Mounted,
  mount,
  outboxWorld,
  page,
  profileOf,
  settle,
  testServices,
  text,
  UNKNOWN,
  until,
  words,
} from './support';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const BOBS: Scrobble[] = GLOBAL_FEED.filter((s) => s.did === BOB);

interface UserRoutes {
  profile?: () => Profile | null;
  history?: Scrobble[];
  stats?: (window: StatsWindow) => Statistics;
}

function serveUser(api: FakeApi, did: Did, routes: UserRoutes): void {
  api.on(`GET /api/v1/users/${did}/profile`, () => {
    const p = routes.profile?.() ?? null;
    return p === null
      ? json(404, {
          error: { code: 'not_found', message: 'absent', requestId: 'a858325e-7dd0-4b1b-baaa-3b65af37f963' },
        })
      : json(200, p);
  });
  api.on(`GET /api/v1/users/${did}/scrobbles`, () => json(200, page(routes.history ?? [], null)));
  api.on(`GET /api/v1/users/${did}/stats`, (req) =>
    json(200, (routes.stats ?? ((w) => emptyStats(did, w)))((req.query.window ?? 'all') as StatsWindow)),
  );
}

function readOnlySession(did: Did): PdsSession {
  return {
    did,
    fetchHandler: () => Promise.reject(new Error('no PDS writes here')),
    signOut: async () => undefined,
  };
}

function tab(root: ParentNode, label: string): HTMLElement {
  const found = Array.from(root.querySelectorAll('[role="tab"]')).find((t) => text(t) === label);
  if (!found) throw new Error(`no tab ${label}`);
  return found as HTMLElement;
}

function totals(root: ParentNode) {
  const at = (k: string) => text(root.querySelector(`#stats-panel [data-total="${k}"]`));
  return { scrobbles: at('scrobbles'), artists: at('artists'), tracks: at('tracks') };
}

function list(root: ParentNode, cls: string): string[] {
  return Array.from(root.querySelectorAll(`#stats-panel ol.${cls} > li`)).map((li) => text(li));
}

function expectedLists(s: Statistics) {
  const n = (c: number) => `${c} ${c === 1 ? 'scrobble' : 'scrobbles'}`;
  return {
    artists: s.topArtists.map((a) => `${a.artist} — ${n(a.scrobbleCount)}`),
    tracks: s.topTracks.map((t) => `${t.track} by ${t.artist} — ${n(t.scrobbleCount)}`),
    albums: s.topAlbums.map((a) => `${a.album} by ${a.artist} — ${n(a.scrobbleCount)}`),
  };
}

describe('web/test/routes/profile.test.tsx', () => {
  it('stats window switch fetches window and renders exact top lists', async () => {
    const api = fakeApi({ meta: META_READ_ONLY });
    let hold7d: ((r: Response) => void) | null = null;
    serveUser(api, ALICE, { profile: () => profileOf(ALICE, 'alice.test'), history: ALICE_HISTORY });
    api.on(`GET /api/v1/users/${ALICE}/stats`, (req) => {
      const w = (req.query.window ?? 'all') as StatsWindow;
      // The first 7d answer arrives late, after the 30d tab was chosen.
      if (w === '7d' && hold7d === null) return new Promise<Response>((resolve) => (hold7d = resolve));
      return json(200, aliceStats(w));
    });
    mounted = mount(`/u/${ALICE}`, createAppState({ api: api.api }), testServices());
    const main = mounted.main();

    await until(() => expect(totals(main)).toEqual({ scrobbles: '7', artists: '3', tracks: '6' }));
    expect(tab(main, 'All time').getAttribute('aria-selected')).toBe('true');
    expect(text(main.querySelector('.stats-asof'))).toBe('All time, as of 2026-01-15 12:00 UTC.');
    expect(list(main, 'top-artists')).toEqual([
      'Radiohead — 3 scrobbles',
      'Björk — 2 scrobbles',
      'Kate Bush — 2 scrobbles',
    ]);
    expect(list(main, 'top-tracks')).toEqual([
      'Jóga by Björk — 2 scrobbles',
      'Cloudbusting by Kate Bush — 1 scrobble',
      'Running Up That Hill by Kate Bush — 1 scrobble',
      'Karma Police by Radiohead — 1 scrobble',
      'No Surprises by Radiohead — 1 scrobble',
      'Weird Fishes by Radiohead — 1 scrobble',
    ]);
    expect(list(main, 'top-albums')).toEqual([
      'Homogenic by Björk — 2 scrobbles',
      'OK Computer by Radiohead — 2 scrobbles',
      'Hounds of Love by Kate Bush — 1 scrobble',
      'In Rainbows by Radiohead — 1 scrobble',
    ]);

    // 7d is slow; 30d is chosen before it answers. The late 7d answer is dropped.
    click(tab(main, 'Last 7 days'));
    await until(() => expect(hold7d).not.toBeNull());
    expect(main.querySelector('#stats-panel [data-state="loading"]')).not.toBeNull();
    click(tab(main, 'Last 30 days'));
    await until(() => expect(totals(main)).toEqual({ scrobbles: '5', artists: '2', tracks: '4' }));
    hold7d!(json(200, aliceStats('7d')));
    await settle();
    expect(totals(main)).toEqual({ scrobbles: '5', artists: '2', tracks: '4' });
    expect(main.querySelector('.stats-body')?.getAttribute('data-window')).toBe('30d');
    expect(list(main, 'top-artists')).toEqual(['Radiohead — 3 scrobbles', 'Björk — 2 scrobbles']);
    expect({
      artists: list(main, 'top-artists'),
      tracks: list(main, 'top-tracks'),
      albums: list(main, 'top-albums'),
    }).toEqual(expectedLists(aliceStats('30d')));

    click(tab(main, 'Last 7 days'));
    await until(() => expect(totals(main)).toEqual({ scrobbles: '4', artists: '2', tracks: '3' }));
    expect(list(main, 'top-artists')).toEqual(['Björk — 2 scrobbles', 'Radiohead — 2 scrobbles']);
    expect(list(main, 'top-tracks')).toEqual([
      'Jóga by Björk — 2 scrobbles',
      'No Surprises by Radiohead — 1 scrobble',
      'Weird Fishes by Radiohead — 1 scrobble',
    ]);
    expect(list(main, 'top-albums')).toEqual([
      'Homogenic by Björk — 2 scrobbles',
      'In Rainbows by Radiohead — 1 scrobble',
      'OK Computer by Radiohead — 1 scrobble',
    ]);
    expect(text(main.querySelector('.stats-asof'))).toBe(
      'Last 7 days, as of 2026-01-15 12:00 UTC. Windows count back from that instant in UTC.',
    );

    click(tab(main, 'Last 365 days'));
    await until(() => expect(totals(main)).toEqual({ scrobbles: '6', artists: '3', tracks: '5' }));
    expect({
      artists: list(main, 'top-artists'),
      tracks: list(main, 'top-tracks'),
      albums: list(main, 'top-albums'),
    }).toEqual(expectedLists(aliceStats('365d')));
    expect(tab(main, 'Last 365 days').getAttribute('aria-selected')).toBe('true');
    expect(main.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(1);

    // Every window was requested for Alice's DID, in the order chosen.
    expect(api.calls(`GET /api/v1/users/${ALICE}/stats`).map((r) => r.query.window)).toEqual([
      'all',
      '7d',
      '30d',
      '7d',
      '365d',
    ]);
  });

  it('new verified handle for the same DID updates the display on the same /u/:did route', async () => {
    const api = fakeApi({ meta: META_READ_ONLY });
    let handle: string | null = 'alice.test';
    serveUser(api, ALICE, { profile: () => profileOf(ALICE, handle), history: ALICE_HISTORY, stats: aliceStats });
    const state = createAppState({ api: api.api });
    state.session.value = readOnlySession(ALICE);
    mounted = mount(`/u/${ALICE}`, state, testServices());
    const main = mounted.main();
    const header = mounted.root.querySelector('header.site-header')!;

    await until(() => expect(text(main.querySelector('h1'))).toBe('@alice.test'));
    await until(() => expect(listedRkeys(main)).toHaveLength(7));
    expect(text(main.querySelector('.profile-did'))).toBe(ALICE);
    await until(() => expect(text(header.querySelector('.session-identity .handle'))).toBe('@alice.test'));
    const historyBefore = Array.from(main.querySelectorAll('ol.scrobble-list > li'));

    // The handle moved to a new verified name; the DID (and route) did not.
    handle = 'alice.example.org';
    click(buttonByText(main, 'Refresh profile'));
    await until(() => expect(text(main.querySelector('h1'))).toBe('@alice.example.org'));
    expect(location.pathname).toBe(`/u/${ALICE}`);
    expect(text(main.querySelector('.profile-did'))).toBe(ALICE);
    await until(() => expect(text(header.querySelector('.session-identity .handle'))).toBe('@alice.example.org'));
    expect(text(header.querySelector('.session-identity code.did'))).toBe(ALICE);
    // The same history: same nodes, same order, not refetched.
    expect(Array.from(main.querySelectorAll('ol.scrobble-list > li'))).toEqual(historyBefore);
    expect(listedRkeys(main)).toEqual(['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
    expect(api.count(`GET /api/v1/users/${ALICE}/scrobbles`)).toBe(1);

    // A handle that no longer verifies is not shown at all.
    handle = null;
    click(buttonByText(main, 'Refresh profile'));
    await until(() => expect(text(main.querySelector('h1'))).toBe('Handle not verified'));
    expect(main.textContent).not.toContain('alice.example.org');
    await until(() => expect(header.querySelector('.session-identity .handle')).toBeNull());
    expect(location.pathname).toBe(`/u/${ALICE}`);
    expect(api.calls(`GET /api/v1/users/${ALICE}/profile`).length).toBeGreaterThanOrEqual(3);
  });

  it('recordless user, no-album stats and unknown DID 404 render explicit empty and not-found states', async () => {
    const api = fakeApi({ meta: META_READ_ONLY });
    serveUser(api, BOB, {
      profile: () => profileOf(BOB, 'bob.test', { totalScrobbles: 0, followingCount: 0 }),
      history: [],
    });
    const carolStats: Statistics = {
      did: CAROL,
      window: 'all',
      asOf: '2026-01-15T12:00:00Z',
      totalScrobbles: 1,
      distinctArtists: 1,
      distinctTracks: 1,
      topArtists: [{ artist: 'Kate Bush', scrobbleCount: 1 }],
      topTracks: [{ artist: 'Kate Bush', track: 'Running Up That Hill', scrobbleCount: 1 }],
      topAlbums: [],
    };
    serveUser(api, CAROL, {
      profile: () => profileOf(CAROL, 'carol.test', { totalScrobbles: 1 }),
      history: [],
      stats: (w) => ({ ...carolStats, window: w }),
    });
    serveUser(api, UNKNOWN, { profile: () => null });

    // A recordless, active account: explicit empty history and stats.
    mounted = mount(`/u/${BOB}`, createAppState({ api: api.api }), testServices());
    let main = mounted.main();
    await until(() => expect(main.querySelectorAll('[data-state="empty"]')).toHaveLength(2));
    expect(text(main.querySelector('h1'))).toBe('@bob.test');
    expect(Array.from(main.querySelectorAll('[data-state="empty"]')).map((e) => text(e))).toEqual([
      'No scrobbles in this window.',
      'No scrobbles yet.',
    ]);
    expect(main.querySelector('ol.top-artists')).toBeNull();
    expect(main.querySelector('ol.scrobble-list')).toBeNull();
    expect(text(main.querySelector('[data-count="scrobbles"]'))).toBe('0');
    mounted.unmount();

    // Stats without any album: the album list says so; nothing is invented.
    mounted = mount(`/u/${CAROL}`, createAppState({ api: api.api }), testServices());
    main = mounted.main();
    await until(() => expect(totals(main)).toEqual({ scrobbles: '1', artists: '1', tracks: '1' }));
    expect(list(main, 'top-artists')).toEqual(['Kate Bush — 1 scrobble']);
    expect(list(main, 'top-tracks')).toEqual(['Running Up That Hill by Kate Bush — 1 scrobble']);
    expect(main.querySelector('ol.top-albums')).toBeNull();
    expect(text(main.querySelector('#stats-panel [data-state="empty"]'))).toBe('No album information in this window.');
    mounted.unmount();

    // An unknown DID: not found, with no zeroed profile, history or statistics.
    mounted = mount(`/u/${UNKNOWN}`, createAppState({ api: api.api }), testServices());
    main = mounted.main();
    await until(() => expect(main.querySelector('[data-state="not-found"]')).not.toBeNull());
    expect(text(main.querySelector('h1'))).toBe('Profile not found');
    expect(words(main.querySelector('[data-state="not-found"]'))).toContain(
      `The index has no active account for ${UNKNOWN}`,
    );
    expect(main.querySelector('dl')).toBeNull();
    expect(main.querySelector('[role="tablist"]')).toBeNull();
    expect(main.textContent).not.toMatch(/\b0\b/);
    expect(api.count(`GET /api/v1/users/${UNKNOWN}/profile`)).toBe(1);
    expect(api.count(`GET /api/v1/users/${UNKNOWN}/scrobbles`)).toBe(0);
    expect(api.count(`GET /api/v1/users/${UNKNOWN}/stats`)).toBe(0);
    expect(linkByText(main, 'Go to the feed')?.getAttribute('href')).toBe('/feed');
    mounted.unmount();

    // A path segment that is not a DID is not found without any request.
    mounted = mount('/u/not-a-did', createAppState({ api: api.api }), testServices());
    main = mounted.main();
    await until(() => expect(text(main.querySelector('h1'))).toBe('Profile not found'));
    expect(api.requests.filter((r) => r.path.includes('not-a-did'))).toEqual([]);
  });

  it('follow button shows pending then confirmed, and a permanently failed unfollow shows failed without claiming removal', async () => {
    const world = await outboxWorld();
    const { fx, api } = world;
    const rkey = await followRkey(BOB);
    serveUser(api, BOB, { profile: () => profileOf(BOB, 'bob.test'), history: BOBS });
    serveUser(api, ALICE, { profile: () => profileOf(ALICE, 'alice.test'), history: [] });
    // Alice's indexed following list mirrors her PDS (what the AppView verifies).
    api.on(`GET /api/v1/users/${ALICE}/following`, async () => {
      const rec = await fx.repo.getRecord(FOLLOW, rkey);
      const items: Follow[] =
        rec === null
          ? []
          : [
              {
                uri: `at://${ALICE}/${FOLLOW}/${rkey}`,
                cid: String(rec.cid),
                actor: ALICE,
                subject: BOB,
                createdAt: '2026-01-15T12:00:00Z',
              },
            ];
      return json(200, {
        items,
        nextCursor: null,
        asOf: '2026-01-15T12:00:00Z',
        indexing: profileOf(ALICE, null).indexing,
      });
    });
    mounted = mount(`/u/${BOB}`, world.state, world.services);
    const main = mounted.main();
    const status = () => text(main.querySelector('.follow-status'));
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      if (seen.at(-1) !== status()) seen.push(status());
    });
    observer.observe(main, { subtree: true, childList: true, characterData: true });

    await until(() => expect(status()).toBe('Not following'));
    click(buttonByText(main, 'Follow'));
    await until(() => expect(status()).toBe('Follow queued'));
    expect(buttonByText(main, 'Follow')).toBeNull();
    expect(buttonByText(main, 'Unfollow')).toBeNull();
    const [follow] = await fx.ops();
    expect(follow).toMatchObject({ kind: 'follow_create', subject: BOB, rkey, state: 'queued' });

    await world.outbox.runner.runDue();
    await until(() => expect(status()).toBe('Follow published to your PDS; waiting for the index'));
    expect(fx.pds.count('com.atproto.repo.createRecord')).toBe(1);
    fx.clock.advance(1_000);
    expect(await world.outbox.runner.runDue()).toBeNull();
    await until(() => expect(status()).toBe('Following (confirmed)'));
    expect(buttonByText(main, 'Unfollow')).not.toBeNull();
    expect(seen.indexOf('Follow queued')).toBeLessThan(seen.indexOf('Following (confirmed)'));
    expect(seen.slice(0, seen.indexOf('Following (confirmed)'))).not.toContain('Following');
    // The confirmation re-read the profile counts.
    await until(() => expect(api.count(`GET /api/v1/users/${BOB}/profile`)).toBe(2));

    // The PDS refuses the unfollow's delete permanently.
    fx.pds.fail(
      { nsid: 'com.atproto.repo.deleteRecord' },
      { kind: 'status', status: 403, error: 'Forbidden', message: 'scope' },
    );
    click(buttonByText(main, 'Unfollow'));
    await until(() => expect(status()).toBe('Unfollow queued'));
    expect(await world.outbox.runner.runDue()).toBeNull();
    await until(() =>
      expect(status()).toBe(
        'Unfollow failed (forbidden_scope). Your follow record was not removed; you still follow this account.',
      ),
    );
    observer.disconnect();
    const ops = await fx.ops();
    expect(ops.map((o) => [o.kind, o.state, o.failureCode ?? null])).toEqual([
      ['follow_create', 'indexed', null],
      ['follow_delete', 'failed', 'forbidden_scope'],
    ]);
    expect(fx.pds.count('com.atproto.repo.deleteRecord')).toBe(1);
    expect(await fx.repo.getRecord(FOLLOW, rkey)).not.toBeNull();
    // No removal is claimed at any point after the unfollow; the retry stays available.
    const afterUnfollow = seen.slice(seen.indexOf('Unfollow queued'));
    expect(afterUnfollow.some((s) => /^Not following|Unfollowed/.test(s))).toBe(false);
    expect(main.textContent).not.toMatch(/Not following|unfollow confirmed/);
    expect(buttonByText(main, 'Unfollow')).not.toBeNull();
  });

  it('own profile has no follow control and an anonymous viewer gets a sign-in action', async () => {
    // Anonymous viewer of Bob: a sign-in action, no follow control, no edge lookup.
    const api = fakeApi({ meta: META_READ_ONLY });
    serveUser(api, BOB, { profile: () => profileOf(BOB, 'bob.test'), history: BOBS });
    mounted = mount(`/u/${BOB}`, createAppState({ api: api.api }), testServices());
    let main = mounted.main();
    await until(() => expect(main.querySelector('[data-state="signin-required"]')).not.toBeNull());
    expect(words(main.querySelector('[data-state="signin-required"]'))).toBe(
      'Sign in to follow this account. Sign in to follow',
    );
    expect(linkByText(main, 'Sign in to follow')?.getAttribute('href')).toBe('/signin');
    expect(main.querySelector('.follow-control')).toBeNull();
    expect(buttonByText(main, 'Follow')).toBeNull();
    expect(api.requests.some((r) => r.path.endsWith('/following'))).toBe(false);
    mounted.unmount();

    // Alice on her own profile (publication available): no follow control at all.
    const world = await outboxWorld();
    serveUser(world.api, ALICE, { profile: () => profileOf(ALICE, 'alice.test'), history: ALICE_HISTORY });
    serveUser(world.api, BOB, { profile: () => profileOf(BOB, 'bob.test'), history: BOBS });
    world.api.on(`GET /api/v1/users/${ALICE}/following`, () =>
      json(200, {
        items: [],
        nextCursor: null,
        asOf: '2026-01-15T12:00:00Z',
        indexing: profileOf(ALICE, null).indexing,
      }),
    );
    mounted = mount(`/u/${ALICE}`, world.state, world.services);
    main = mounted.main();
    await until(() => expect(listedRkeys(main)).toHaveLength(7));
    await until(() => expect(main.querySelectorAll('button.delete')).toHaveLength(7));
    expect(main.querySelector('.follow-control')).toBeNull();
    expect(buttonByText(main, 'Follow')).toBeNull();
    expect(buttonByText(main, 'Unfollow')).toBeNull();
    expect(main.querySelector('[data-state="signin-required"]')).toBeNull();
    expect(world.api.count(`GET /api/v1/users/${ALICE}/following`)).toBe(0);
    mounted.unmount();

    // The same signed-in viewer on Bob's profile does get the control.
    mounted = mount(`/u/${BOB}`, world.state, world.services);
    main = mounted.main();
    await until(() => expect(text(main.querySelector('.follow-status'))).toBe('Not following'));
    expect(buttonByText(main, 'Follow')).not.toBeNull();
    expect(await world.fx.store.count()).toBe(0);
  });

  it("delete control appears only on the signed-in owner's own records", async () => {
    const world = await outboxWorld();
    const { api, fx } = world;
    serveUser(api, ALICE, { profile: () => profileOf(ALICE, 'alice.test'), history: ALICE_HISTORY });
    serveUser(api, BOB, { profile: () => profileOf(BOB, 'bob.test'), history: BOBS });
    api.on(`GET /api/v1/users/${ALICE}/following`, () =>
      json(200, {
        items: [],
        nextCursor: null,
        asOf: '2026-01-15T12:00:00Z',
        indexing: profileOf(ALICE, null).indexing,
      }),
    );
    api.on('GET /api/v1/feed', () => json(200, page(GLOBAL_FEED, null)));

    // Alice's own history: one delete control per record.
    mounted = mount(`/u/${ALICE}`, world.state, world.services);
    let main = mounted.main();
    await until(() => expect(main.querySelectorAll('button.delete')).toHaveLength(7));
    expect(
      Array.from(main.querySelectorAll('ol.scrobble-list > li')).map(
        (li) => li.querySelector('button.delete') !== null,
      ),
    ).toEqual([true, true, true, true, true, true, true]);
    expect(main.querySelector('button.delete')?.getAttribute('aria-label')).toBe('Delete “No Surprises” by Radiohead');
    mounted.unmount();

    // Bob's records, viewed by Alice: none.
    mounted = mount(`/u/${BOB}`, world.state, world.services);
    main = mounted.main();
    await until(() => expect(listedRkeys(main)).toEqual(['r09']));
    await until(() => expect(main.querySelector('.follow-control')).not.toBeNull());
    expect(main.querySelectorAll('button.delete')).toHaveLength(0);
    mounted.unmount();

    // The mixed global feed: only Alice's seven records carry the control.
    mounted = mount('/feed', world.state, world.services);
    main = mounted.main();
    await until(() => expect(main.querySelectorAll('button.delete')).toHaveLength(7));
    const owners = Array.from(main.querySelectorAll('ol.scrobble-list > li'))
      .filter((li) => li.querySelector('button.delete') !== null)
      .map((li) => GLOBAL_FEED.find((s) => s.uri === li.getAttribute('data-uri'))?.did);
    expect(new Set(owners)).toEqual(new Set([ALICE]));
    mounted.unmount();

    // Anonymous, or signed in on a read-only deployment: none.
    const anon = fakeApi({ meta: META_READ_ONLY });
    serveUser(anon, ALICE, { profile: () => profileOf(ALICE, 'alice.test'), history: ALICE_HISTORY });
    mounted = mount(`/u/${ALICE}`, createAppState({ api: anon.api }), testServices());
    main = mounted.main();
    await until(() => expect(listedRkeys(main)).toHaveLength(7));
    expect(main.querySelectorAll('button.delete')).toHaveLength(0);
    mounted.unmount();
    const readOnly = createAppState({ api: anon.api });
    readOnly.session.value = readOnlySession(ALICE);
    mounted = mount(`/u/${ALICE}`, readOnly, testServices());
    main = mounted.main();
    await until(() => expect(listedRkeys(main)).toHaveLength(7));
    await settle();
    expect(main.querySelectorAll('button.delete')).toHaveLength(0);
    mounted.unmount();

    // The owner deletes r01: confirmation first, then it is hidden at once and queued.
    mounted = mount(`/u/${ALICE}`, world.state, world.services);
    main = mounted.main();
    await until(() => expect(main.querySelectorAll('button.delete')).toHaveLength(7));
    const r01 = main.querySelector(`li[data-uri="${ALICE_HISTORY[1]!.uri}"]`)!;
    click(r01.querySelector('button.delete'));
    await until(() => expect(buttonByText(main, 'Confirm delete')).not.toBeNull());
    expect(await fx.store.count()).toBe(0);
    click(buttonByText(main, 'Confirm delete'));
    await until(() => expect(listedRkeys(main)).toEqual(['r07', 'r02', 'r03', 'r04', 'r05', 'r06']));
    const [del] = await fx.ops();
    expect(del).toMatchObject({ kind: 'scrobble_delete', uri: ALICE_HISTORY[1]!.uri, state: 'queued' });
    expect(fx.session.sent).toEqual([]);
  });
});
