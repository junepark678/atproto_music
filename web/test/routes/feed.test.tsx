// Feed screen (W3-06; M7.3.1 feed_order / anonymous_following / feed_failure,
// M7.1.3 state_components, M7.4.2 browser_network). The real App, router and
// typed ApiClient run over an injected fetch serving the TESTING.md fixture
// feed (the Rust oracle's projection); assertions are on the requests sent
// and the rendered DOM.

import type { Did } from '@atmusic/core/api-types';
import { afterEach, describe, expect, it } from 'vitest';
import type { PdsSession } from '../../src/oauth/types';
import { createAppState, setSession } from '../../src/state/store';
import {
  ALICE,
  buttonByText,
  click,
  envelope,
  fakeApi,
  GLOBAL_FEED,
  json,
  listedRkeys,
  META_READ_ONLY,
  type Mounted,
  mount,
  page,
  testServices,
  text,
  until,
  words,
} from './support';

const CURSOR = 'djEuAbC-_~opaque/+=';
let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function readOnlySession(did: Did): PdsSession {
  return {
    did,
    fetchHandler: () => Promise.reject(new Error('no PDS writes in feed tests')),
    signOut: async () => undefined,
  };
}

function tab(root: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('[role="tab"]')).find((t) => text(t) === label);
  if (!found) throw new Error(`no tab ${label}`);
  return found as HTMLButtonElement;
}

describe('web/test/routes/feed.test.tsx', () => {
  it('renders items and loads next page via nextCursor', async () => {
    const api = fakeApi({ meta: META_READ_ONLY });
    api.on('GET /api/v1/feed', (req) =>
      req.query.cursor === undefined
        ? json(200, page(GLOBAL_FEED.slice(0, 5), CURSOR))
        : req.query.cursor === CURSOR
          ? json(200, page(GLOBAL_FEED.slice(5), null))
          : envelope(422, 'invalid_cursor'),
    );
    mounted = mount('/feed', createAppState({ api: api.api }), testServices());
    const main = mounted.main();

    await until(() => expect(listedRkeys(main)).toEqual(['r09', 'r10', 'r07', 'r01', 'r02']));
    const first = main.querySelector('ol.scrobble-list > li');
    expect(text(first)).toBe(
      `Teardrop by Massive Attack from Mezzanine · 2026-01-15 11:30 UTC · ${GLOBAL_FEED[0]!.did}`,
    );
    expect(first?.querySelector('time')?.getAttribute('datetime')).toBe('2026-01-15T11:30:00Z');
    expect(first?.querySelector('a.actor')?.getAttribute('href')).toBe(`/u/${GLOBAL_FEED[0]!.did}`);
    expect(api.calls('GET /api/v1/feed').map((r) => r.query)).toEqual([{ scope: 'global' }]);

    click(buttonByText(main, 'Load more'));
    await until(() =>
      expect(listedRkeys(main)).toEqual(['r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']),
    );
    // The opaque cursor went back byte for byte; nothing was re-sorted or duplicated.
    expect(api.calls('GET /api/v1/feed').map((r) => r.query)).toEqual([
      { scope: 'global' },
      { scope: 'global', cursor: CURSOR },
    ]);
    const uris = Array.from(main.querySelectorAll('ol.scrobble-list > li')).map((li) => li.getAttribute('data-uri'));
    expect(uris).toEqual(GLOBAL_FEED.map((s) => s.uri));
    expect(new Set(uris).size).toBe(9);
    // The last page has nextCursor null: no further page is offered.
    expect(buttonByText(main, 'Load more')).toBeNull();
    // Read-only deployment: no delete controls anywhere.
    expect(main.querySelectorAll('button.delete')).toHaveLength(0);
  });

  it('anonymous user selecting following sees a sign-in prompt and no scope=following request is sent', async () => {
    const api = fakeApi({ meta: META_READ_ONLY });
    api.on('GET /api/v1/feed', (req) =>
      req.query.scope === 'following'
        ? json(200, page(GLOBAL_FEED.slice(0, 1), null))
        : json(200, page(GLOBAL_FEED.slice(0, 2), null)),
    );
    const state = createAppState({ api: api.api });
    mounted = mount('/feed', state, testServices());
    const main = mounted.main();
    await until(() => expect(listedRkeys(main)).toEqual(['r09', 'r10']));

    click(tab(main, 'Following'));
    await until(() => expect(main.querySelector('[data-state="signin-required"]')).not.toBeNull());
    const prompt = main.querySelector('[data-state="signin-required"]');
    expect(words(prompt)).toBe('Sign in to see scrobbles from the accounts you follow. Sign in');
    expect(prompt?.querySelector('a')?.getAttribute('href')).toBe('/signin');
    expect(tab(main, 'Following').getAttribute('aria-selected')).toBe('true');
    expect(main.querySelector('ol.scrobble-list')).toBeNull();
    // Only the initial global page was requested; there is no viewer to send.
    expect(api.calls('GET /api/v1/feed').map((r) => r.query)).toEqual([{ scope: 'global' }]);
    expect(api.requests.some((r) => r.query.scope === 'following' || 'viewer' in r.query)).toBe(false);

    // Signed in, the viewer comes from the session DID (A8).
    setSession(state, readOnlySession(ALICE));
    await until(() => expect(listedRkeys(main)).toEqual(['r09']));
    expect(api.calls('GET /api/v1/feed').map((r) => r.query)).toEqual([
      { scope: 'global' },
      { scope: 'following', viewer: ALICE },
    ]);
  });

  it('page-2 503 keeps page 1, shows retry, and a successful retry appends page 2 once', async () => {
    const api = fakeApi({ meta: META_READ_ONLY });
    let page2Calls = 0;
    api.on('GET /api/v1/feed', (req) => {
      if (req.query.cursor === undefined) return json(200, page(GLOBAL_FEED.slice(0, 5), CURSOR));
      page2Calls++;
      return page2Calls === 1
        ? envelope(503, 'not_ready', 'Index storage is not initialized.')
        : json(200, page(GLOBAL_FEED.slice(5), null));
    });
    mounted = mount('/feed', createAppState({ api: api.api }), testServices());
    const main = mounted.main();
    await until(() => expect(listedRkeys(main)).toHaveLength(5));

    click(buttonByText(main, 'Load more'));
    await until(() => expect(main.querySelector('[role="alert"]')).not.toBeNull());
    const alert = main.querySelector('[role="alert"]');
    expect(words(alert)).toBe(
      `More scrobbles could not be loaded. The service is temporarily unavailable. Try again shortly. (not_ready, request a858325e-7dd0-4b1b-baaa-3b65af37f963) Try again`,
    );
    // Page 1 is kept as it was; nothing is still loading.
    expect(listedRkeys(main)).toEqual(['r09', 'r10', 'r07', 'r01', 'r02']);
    expect(main.querySelector('[data-state="loading"]')).toBeNull();
    expect(buttonByText(main, 'Load more')).toBeNull();

    click(buttonByText(alert!, 'Try again'));
    await until(() => expect(listedRkeys(main)).toHaveLength(9));
    expect(listedRkeys(main)).toEqual(['r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
    expect(main.querySelector('[role="alert"]')).toBeNull();
    // The retry asked for the same cursor once more; page 2 was appended exactly once.
    expect(api.calls('GET /api/v1/feed').map((r) => r.query.cursor ?? null)).toEqual([null, CURSOR, CURSOR]);
    expect(page2Calls).toBe(2);
    expect(buttonByText(main, 'Load more')).toBeNull();
  });

  it('loading, empty, error and stale states render labelled text and no spinner remains after an error', async () => {
    const api = fakeApi({ meta: META_READ_ONLY });
    const pending: Array<(r: Response) => void> = [];
    api.on('GET /api/v1/feed', () => new Promise<Response>((resolve) => pending.push(resolve)));
    mounted = mount('/feed', createAppState({ api: api.api }), testServices());
    const main = mounted.main();

    // Loading: a labelled status message.
    await until(() => expect(pending).toHaveLength(1));
    await until(() => expect(main.querySelector('[data-state="loading"]')).not.toBeNull());
    const loading = main.querySelector('[data-state="loading"]');
    expect(loading?.getAttribute('role')).toBe('status');
    expect(text(loading)).toBe('Loading the feed…');

    // Error: an alert with the reason and a retry; the loading message is gone.
    pending[0]!(envelope(503, 'not_ready', 'Index storage is not initialized.'));
    await until(() => expect(main.querySelector('[data-state="error"]')).not.toBeNull());
    const error = main.querySelector('[data-state="error"]');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(text(error)).toContain('The feed could not be loaded.');
    expect(text(error)).toContain('The service is temporarily unavailable.');
    expect(main.querySelector('[data-state="loading"]')).toBeNull();
    expect(main.querySelectorAll('[role="status"]')).toHaveLength(0);

    // Retry → an empty page: the empty state, nothing else.
    click(buttonByText(main, 'Try again'));
    await until(() => expect(pending).toHaveLength(2));
    expect(main.querySelector('[data-state="loading"]')).not.toBeNull();
    pending[1]!(json(200, page([], null)));
    await until(() => expect(main.querySelector('[data-state="empty"]')).not.toBeNull());
    expect(text(main.querySelector('[data-state="empty"]'))).toBe('No scrobbles yet.');
    expect(main.querySelector('[data-state="loading"]')).toBeNull();
    expect(main.querySelector('[data-state="error"]')).toBeNull();
    expect(main.querySelector('[data-state="stale"]')).toBeNull();

    // Stale index: the items plus a labelled notice with the last indexed time.
    mounted.unmount();
    const staleApi = fakeApi({ meta: META_READ_ONLY });
    staleApi.on('GET /api/v1/feed', () =>
      json(
        200,
        page(GLOBAL_FEED.slice(0, 2), null, {
          state: 'stale',
          caughtUp: false,
          lastIndexedAt: '2026-01-15T11:00:00Z',
          lagSeconds: 3600,
        }),
      ),
    );
    mounted = mount('/feed', createAppState({ api: staleApi.api }), testServices());
    const staleMain = mounted.main();
    await until(() => expect(staleMain.querySelector('[data-state="stale"]')).not.toBeNull());
    expect(text(staleMain.querySelector('[data-state="stale"]'))).toBe(
      'The index is behind. Recent scrobbles may be missing. Last indexed 2026-01-15 11:00 UTC. About 3600 s behind.',
    );
    expect(listedRkeys(staleMain)).toEqual(['r09', 'r10']);
    expect(staleMain.querySelector('[data-state="loading"]')).toBeNull();
  });
});
