// The shell around the screens (W3-06; M7.1.3 route_deep_links, M7.2.1
// signin_success / logout_ui, A20 write UI gating). The session is the real
// SessionController (web/src/oauth/session.ts) over an injected library
// client whose session talks to the fake PDS; IndexedDB is fake-indexeddb,
// shared by the OAuth controller and the outbox, so sign-out clearing is
// observable.

import type { Did } from '@atmusic/core/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOutboxService } from '../../src/components/outbox-service';
import type { LibraryClient, LibrarySession } from '../../src/oauth/client';
import { connect, createSession, PUBLIC_CLIENT_MAX_SESSION_MS, SIGNED_IN_AT_KEY_PREFIX } from '../../src/oauth/session';
import type { PdsSession } from '../../src/oauth/types';
import { createAppState } from '../../src/state/store';
import { outboxFixture, SCROBBLE_INPUT } from '../support/fake-pds-browser';
import {
  ALICE,
  ALICE_HISTORY,
  BOB,
  buttonByText,
  click,
  fakeApi,
  GLOBAL_FEED,
  json,
  linkByText,
  META_PUBLISH,
  META_READ_ONLY,
  type Mounted,
  mount,
  navLabels,
  ORIGIN,
  PREFIX,
  page,
  profileOf,
  settle,
  testServices,
  text,
  until,
  words,
} from './support';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const SIGNED_IN_NAV = ['Feed', 'My profile', 'Add scrobble', 'Settings'];
const ANONYMOUS_NAV = ['Feed', 'Sign in'];

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** A restored OAuth session for Alice through the real controller, writing to the fake PDS. */
async function signedInWorld(options: { meta?: typeof META_PUBLISH } = {}) {
  const fx = await outboxFixture({ jitter: 'zero' });
  const api = fakeApi({ meta: options.meta ?? META_PUBLISH, delegate: fx.appView.fetch });
  api.on(`GET /api/v1/users/${ALICE}/profile`, () => json(200, profileOf(ALICE, 'alice.test')));
  api.on(`GET /api/v1/users/${ALICE}/scrobbles`, () => json(200, page(ALICE_HISTORY, null)));
  api.on('GET /api/v1/feed', () => json(200, page(GLOBAL_FEED, null)));
  const storage = new MemoryStorage();
  // Authorized at the frozen instant: the session ends 14 days later at the latest.
  storage.setItem(`${SIGNED_IN_AT_KEY_PREFIX}${ALICE}`, String(fx.clock.nowMs()));
  const revoke = vi.fn(async () => undefined);
  const library: LibrarySession = {
    did: ALICE,
    fetchHandler: (path: string, init?: RequestInit) => fx.session.fetchHandler(path, init),
    signOut: revoke,
    getTokenInfo: async () => ({ expiresAt: new Date(fx.clock.nowMs() + 15 * 60_000) }),
  } as unknown as LibrarySession;
  const client: LibraryClient = { init: async () => ({ session: library }), signIn: async () => undefined };
  const controller = createSession({
    api: api.api,
    origin: ORIGIN,
    clock: fx.clock,
    storage,
    indexedDB: fx.idb,
    loadClient: async () => client,
  });
  const state = createAppState({ api: api.api });
  expect(await connect(state, controller)).toEqual({ kind: 'restored', did: ALICE });
  const session = state.session.value as PdsSession;
  const outbox = createOutboxService({
    store: fx.store,
    session,
    api: api.api,
    clock: fx.clock,
    random: fx.random,
    prefix: PREFIX,
    autoStart: false,
  });
  const services = testServices({ clock: fx.clock, outbox, session: controller });
  return { fx, api, storage, revoke, controller, state, session, outbox, services };
}

function readOnlySession(did: Did): PdsSession {
  return { did, fetchHandler: () => Promise.reject(new Error('no writes')), signOut: async () => undefined };
}

describe('web/test/routes/shell.test.tsx', () => {
  it('write UI hidden without publication capability', async () => {
    const api = fakeApi({ meta: META_READ_ONLY });
    api.on(`GET /api/v1/users/${ALICE}/profile`, () => json(200, profileOf(ALICE, 'alice.test')));
    api.on(`GET /api/v1/users/${BOB}/profile`, () => json(200, profileOf(BOB, 'bob.test')));
    api.on(`GET /api/v1/users/${ALICE}/scrobbles`, () => json(200, page(ALICE_HISTORY, null)));
    api.on('GET /api/v1/feed', () => json(200, page(GLOBAL_FEED, null)));
    const state = createAppState({ api: api.api });
    state.session.value = readOnlySession(ALICE);
    const services = testServices();

    const screens: Record<string, (main: HTMLElement) => void> = {
      '/feed': (main) => expect(main.querySelectorAll('ol.scrobble-list > li')).toHaveLength(9),
      '/scrobble': (main) => expect(main.querySelector('[data-state="publishing-unavailable"]')).not.toBeNull(),
      [`/u/${ALICE}`]: (main) => expect(main.querySelectorAll('ol.scrobble-list > li')).toHaveLength(7),
      [`/u/${BOB}`]: (main) => expect(text(main.querySelector('h1'))).toBe('@bob.test'),
      '/settings': (main) => expect(main.querySelector('a.export-link')).not.toBeNull(),
    };
    for (const [path, ready] of Object.entries(screens)) {
      mounted = mount(path, state, services);
      const root = mounted.root;
      const main = mounted.main();
      await until(() => ready(main));
      await until(() => expect(navLabels(root)).toEqual(['Feed', 'My profile', 'Settings']));
      await settle();
      // No write control of any kind.
      expect(main.querySelector('form')).toBeNull();
      expect(main.querySelectorAll('button.delete')).toHaveLength(0);
      expect(main.querySelector('.follow-control')).toBeNull();
      expect(buttonByText(main, 'Follow')).toBeNull();
      expect(buttonByText(main, 'Disconnect…')).toBeNull();
      expect(buttonByText(main, 'Publish scrobble')).toBeNull();
      mounted.unmount();
      mounted = null;
    }
    // The outbox was never even opened.
    expect(services.outboxRequests).toBe(0);
    expect(text(document.body)).not.toContain('Add scrobble');

    // With publication advertised, the same session gets the write UI.
    const publishing = await signedInWorld();
    mounted = mount('/scrobble', publishing.state, publishing.services);
    await until(() => expect(navLabels(mounted!.root)).toEqual(SIGNED_IN_NAV));
    await until(() => expect(buttonByText(mounted!.main(), 'Publish scrobble')).not.toBeNull());
  });

  it('unknown route renders the not-found view', async () => {
    const api = fakeApi({ meta: META_READ_ONLY });
    api.on('GET /api/v1/feed', () => json(200, page([], null)));
    api.on(`GET /api/v1/users/${ALICE}/profile`, () => json(200, profileOf(ALICE, 'alice.test')));
    const state = createAppState({ api: api.api });

    for (const path of ['/no/such/page', '/u', '/u/did:plc:x/extra', '/feeds']) {
      mounted = mount(path, state, testServices());
      const main = mounted.main();
      await until(() => expect(text(main.querySelector('h1'))).toBe('Page not found'));
      expect(text(main)).toContain('There is nothing at this address.');
      expect(linkByText(main, 'Go to the feed')?.getAttribute('href')).toBe('/feed');
      await until(() => expect(document.title).toBe('Page not found · atmusic'));
      // The shell stays usable around it.
      expect(navLabels(mounted.root)).toEqual(ANONYMOUS_NAV);
      mounted.unmount();
      mounted = null;
    }

    // Every SPA route deep-links to its own screen, never the not-found view.
    const routes: Record<string, string> = {
      '/': 'Feed',
      '/feed': 'Feed',
      '/signin': 'Sign in',
      [`/u/${ALICE}`]: '@alice.test',
      '/scrobble': 'Add a scrobble',
      '/settings': 'Settings',
    };
    for (const [path, title] of Object.entries(routes)) {
      mounted = mount(path, state, testServices());
      const main = mounted.main();
      await until(() => expect(text(main.querySelector('h1'))).toBe(title));
      expect(main.textContent).not.toContain('Page not found');
      expect(main.textContent).not.toContain('This screen is not available yet.');
      mounted.unmount();
      mounted = null;
    }
  });

  it('signed-in shell shows the verified handle and DID and the authenticated navigation', async () => {
    const world = await signedInWorld();
    let answer: ((r: Response) => void) | null = null;
    world.api.on(`GET /api/v1/users/${ALICE}/profile`, () => new Promise<Response>((resolve) => (answer = resolve)));
    mounted = mount('/feed', world.state, world.services);
    const header = mounted.root.querySelector('header.site-header')!;

    await until(() => expect(navLabels(mounted!.root)).toEqual(SIGNED_IN_NAV));
    expect(linkByText(header, 'My profile')?.getAttribute('href')).toBe(`/u/${ALICE}`);
    expect(linkByText(header, 'Sign in')).toBeNull();
    // The DID shows at once; the handle only once the AppView has verified it.
    expect(text(header.querySelector('.session-identity code.did'))).toBe(ALICE);
    expect(header.querySelector('.session-identity .handle')).toBeNull();
    await until(() => expect(answer).not.toBeNull());
    answer!(json(200, profileOf(ALICE, 'alice.test')));
    await until(() => expect(text(header.querySelector('.session-identity .handle'))).toBe('@alice.test'));
    expect(text(header.querySelector('.session-identity'))).toBe(`Signed in as @alice.test ${ALICE}`);
    expect(header.querySelector('[role="alert"]')).toBeNull();
    // One profile lookup for the session's DID, nothing sent to the PDS.
    expect(world.api.count(`GET /api/v1/users/${ALICE}/profile`)).toBe(1);
    expect(world.fx.session.sent).toEqual([]);

    // The authenticated destinations render their screens.
    click(linkByText(header, 'Settings'));
    await until(() => expect(text(mounted!.main().querySelector('h1'))).toBe('Settings'));
    expect(location.pathname).toBe('/settings');
    await until(() =>
      expect(words(mounted!.main().querySelector('[data-session-expiry]'))).toBe(
        'Your session ends no later than 2026-01-29 12:00 UTC; you will then need to sign in again.',
      ),
    );
    expect(world.fx.clock.nowMs() + PUBLIC_CLIENT_MAX_SESSION_MS).toBe(Date.parse('2026-01-29T12:00:00Z'));
    click(linkByText(header, 'Add scrobble'));
    await until(() => expect(buttonByText(mounted!.main(), 'Publish scrobble')).not.toBeNull());
  });

  it('after sign-out the shell shows anonymous navigation and the settings route shows a sign-in prompt', async () => {
    const world = await signedInWorld();
    // Something is in the outbox: sign-out must clear it with the rest of IndexedDB.
    const queued = await world.outbox.scrobble(SCROBBLE_INPUT);
    expect(queued.ok).toBe(true);
    expect(await world.fx.store.count()).toBe(1);

    mounted = mount('/settings', world.state, world.services);
    const main = mounted.main();
    await until(() => expect(buttonByText(main, 'Sign out')).not.toBeNull());
    await until(() => expect(navLabels(mounted!.root)).toEqual(SIGNED_IN_NAV));
    await until(() => expect(text(main.querySelector('[data-session-expiry]'))).toContain('2026-01-29 12:00 UTC'));

    click(buttonByText(main, 'Sign out'));
    await until(() => expect(navLabels(mounted!.root)).toEqual(ANONYMOUS_NAV));
    // Sign-out finished (revocation and IndexedDB clearing) once the screen says so.
    await until(() => expect(main.querySelector('[data-state="signed-out"]')).not.toBeNull());
    // The library revoked once, the runner was stopped first, and IndexedDB is empty.
    expect(world.revoke).toHaveBeenCalledTimes(1);
    expect(world.services.closed).toBe(1);
    expect(world.controller.current()).toBeNull();
    expect(world.controller.status()).toEqual({ state: 'anonymous' });
    expect(world.state.session.value).toBeNull();
    expect(world.state.handle.value).toBeNull();
    expect(await world.fx.store.count()).toBe(0);
    expect(world.storage.getItem(`${SIGNED_IN_AT_KEY_PREFIX}${ALICE}`)).toBeNull();
    const header = mounted.root.querySelector('header.site-header')!;
    expect(header.querySelector('.session-identity')).toBeNull();
    expect(header.querySelector('[role="alert"]')).toBeNull();

    // The settings route now asks for a sign-in and offers nothing else.
    await until(() => expect(main.querySelector('[data-state="signin-required"]')).not.toBeNull());
    expect(words(main.querySelector('[data-state="signin-required"]'))).toBe(
      'Sign in to manage your settings. Sign in',
    );
    expect(text(main.querySelector('[data-state="signed-out"]'))).toBe(
      'You have signed out. This browser no longer holds your session or your outbox.',
    );
    expect(buttonByText(main, 'Sign out')).toBeNull();
    expect(main.querySelector('a.export-link')).toBeNull();
    // A fresh visit to /settings shows the same prompt; the old session sends nothing.
    mounted.unmount();
    mounted = mount('/settings', world.state, world.services);
    await until(() => expect(mounted!.main().querySelector('[data-state="signin-required"]')).not.toBeNull());
    expect(navLabels(mounted.root)).toEqual(ANONYMOUS_NAV);
    await expect(
      world.session.fetchHandler('/xrpc/com.atproto.repo.createRecord', { method: 'POST' }),
    ).rejects.toMatchObject({
      name: 'ReauthRequiredError',
      reason: 'signed_out',
    });
    expect(world.fx.session.sent).toEqual([]);
  });
});
