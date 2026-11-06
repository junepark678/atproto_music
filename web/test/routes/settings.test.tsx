import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../src/api/client';
import { App } from '../../src/app';
import { OutboxService } from '../../src/components/outbox-service';
import { type ScreenServices, ServicesProvider } from '../../src/components/services';
import { IndexingSection } from '../../src/routes/settings';
import SettingsCredentials from '../../src/routes/settings-credentials';
import SettingsImports from '../../src/routes/settings-imports';
import SettingsLinks from '../../src/routes/settings-links';
import { AppStateContext, createAppState, setSession } from '../../src/state/store';
import { META, mount, SESSION } from './support';

describe('web/test/routes/settings.test.tsx', () => {
  it('shows server session identity and the public export link without a local browser outbox', async () => {
    const app = mount('/settings');
    app.state.session.value = SESSION;
    await vi.waitFor(() => expect(app.root.querySelector('a.export-link')).not.toBeNull());
    expect(app.root.textContent).toContain(SESSION.did);
    expect(app.root.querySelector('a.export-link')?.getAttribute('href')).toContain(
      `/api/v1/users/${SESSION.did}/export`,
    );
    app.cleanup();
  });

  it('disconnect confirmation explains the public opt-out and sends the confirmed choice', async () => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/settings');
    const api = new ApiClient({
      fetch: async (input) => {
        const path = new URL(input, 'https://music.test').pathname;
        if (path === '/api/v1/records/status')
          return Response.json({
            uri: `at://${SESSION.did}/com.example.atmusic.settings/self`,
            state: 'indexed',
            cid: 'bafyreieogjytekr7rpqty3rtkfjjglj35ub2ipqjh6ftn7rbxwqe5242jq',
            revision: '3mfixture',
            indexing: { state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: 0 },
          });
        throw new Error(`unexpected request ${path}`);
      },
    });
    const state = createAppState({ api });
    const outbox = new OutboxService(SESSION, META.lexiconPrefix!);
    const disconnect = vi.fn(async () => ({ id: 'op-1' }) as never);
    outbox.disconnect = disconnect;
    const services: ScreenServices = {
      clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
      random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
      ticker: { every: () => () => undefined },
      session: async () => ({
        signIn: async () => undefined,
        signOut: async () => undefined,
        expiry: async () => null,
      }),
      outbox: async () => outbox,
      closeOutbox: async () => undefined,
    };
    const root = document.createElement('div');
    document.body.append(root);
    render(
      <AppStateContext.Provider value={state}>
        <ServicesProvider value={services}>
          <IndexingSection outbox={outbox} />
        </ServicesProvider>
      </AppStateContext.Provider>,
      root,
    );
    await vi.waitFor(() => expect(root.querySelector('[data-indexing="enabled"]')).not.toBeNull());
    [...root.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Disconnect'))!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-confirm="disconnect"]')).not.toBeNull());
    const copy = root.querySelector('[data-confirm="disconnect"]')!.textContent ?? '';
    expect(copy).toContain('remain in your PDS as public records');
    expect(copy).toContain('opt-out record is public too');
    expect(copy).not.toMatch(/erase|delete your public records/i);
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Confirm disconnect')!.click();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    render(null, root);
    root.remove();
  });

  it('sign out calls the server-session port and removes authenticated UI', async () => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/settings');
    const api = new ApiClient({
      fetch: async () =>
        Response.json(
          { error: { code: 'not_found', message: 'not found', requestId: '00000000-0000-4000-8000-000000000001' } },
          { status: 404 },
        ),
    });
    const state = createAppState({ api });
    state.session.value = SESSION;
    state.handle.value = SESSION.handle;
    const signOut = vi.fn(async () => setSession(state, null, null, { kind: 'signed_out' }));
    const services: ScreenServices = {
      clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
      random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
      ticker: { every: () => () => undefined },
      session: async () => ({ signIn: async () => undefined, signOut, expiry: async () => null }),
      outbox: async () => {
        throw new Error('publishing is unavailable in this test');
      },
      closeOutbox: async () => undefined,
    };
    const root = document.createElement('div');
    document.body.append(root);
    render(
      <AppStateContext.Provider value={state}>
        <ServicesProvider value={services}>
          <App state={state} loadMetaOnMount={false} />
        </ServicesProvider>
      </AppStateContext.Provider>,
      root,
    );
    await vi.waitFor(() => expect(root.textContent).toContain(SESSION.did));
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Sign out')!.click();
    await vi.waitFor(() => expect(root.textContent).toContain('You have signed out'));
    expect(signOut).toHaveBeenCalledOnce();
    expect(root.textContent).not.toContain(`Signed in as @${SESSION.handle}`);
    render(null, root);
    root.remove();
  });

  it('does not show signed-out UI or erase a different account after a late sign-out', async () => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/settings');
    const api = new ApiClient({ fetch: async () => new Response(null, { status: 404 }) });
    const state = createAppState({ api });
    state.session.value = SESSION;
    const other = { ...SESSION, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as typeof SESSION.did, handle: 'bob.test' };
    let finishSignOut!: () => void;
    const signOut = vi.fn(() => new Promise<void>((resolve) => (finishSignOut = resolve)));
    const services: ScreenServices = {
      clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
      random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
      ticker: { every: () => () => undefined },
      session: async () => ({ signIn: async () => undefined, signOut, expiry: async () => null }),
      outbox: async () => {
        throw new Error('publishing is unavailable in this test');
      },
      closeOutbox: async () => undefined,
    };
    const root = document.createElement('div');
    document.body.append(root);
    render(
      <AppStateContext.Provider value={state}>
        <ServicesProvider value={services}>
          <App state={state} loadMetaOnMount={false} />
        </ServicesProvider>
      </AppStateContext.Provider>,
      root,
    );
    await vi.waitFor(() => expect(root.textContent).toContain(SESSION.did));
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Sign out')!.click();
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    setSession(state, other);
    finishSignOut();
    await vi.waitFor(() => expect(root.textContent).toContain(other.did));
    expect(root.textContent).not.toContain('You have signed out');
    render(null, root);
    root.remove();
  });

  it('the links, imports and credentials screens render server state; a created secret is shown once and gone after navigation', async () => {
    const state = createAppState();
    setSession(state, SESSION);
    const root = document.createElement('div');
    document.body.append(root);
    let passwordCreated = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'https://music.test');
      if (url.pathname === '/api/v1/auth/session') return Response.json(SESSION);
      if (url.pathname === '/api/v1/links')
        return Response.json({
          items: [
            {
              id: 'link-1',
              service: 'lastfm',
              remoteUser: 'alice.fm',
              forwardScrobbles: true,
              forwardNowPlaying: false,
              status: 'active',
              lastError: null,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        });
      if (url.pathname === '/api/v1/imports')
        return Response.json({
          items: [
            {
              id: 'job-server',
              source: 'lastfm_api',
              remoteUser: 'alice.fm',
              state: 'paused',
              fetched: 4,
              staged: 4,
              duplicates: 0,
              invalid: 0,
              written: 2,
              failed: 0,
              etaSeconds: null,
              error: null,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        });
      if (url.pathname === '/api/v1/account/credentials')
        return Response.json({
          appPasswords: passwordCreated
            ? [{ id: 'pw-1', label: 'desktop', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null }]
            : [],
          listenbrainzTokens: [],
          lastfmApps: [],
          lastfmSessions: [],
        });
      if (url.pathname === '/api/v1/account/app-passwords' && init.method === 'POST') {
        passwordCreated = true;
        return Response.json(
          { id: 'pw-1', label: 'desktop', password: 'ABCD-EFGH', createdAt: '2026-01-01T00:00:00Z' },
          { status: 201 },
        );
      }
      throw new Error(`unexpected request ${init.method ?? 'GET'} ${url.pathname}`);
    });

    const show = (Component: typeof SettingsCredentials | typeof SettingsImports | typeof SettingsLinks) =>
      render(
        <AppStateContext.Provider value={state}>
          <Component />
        </AppStateContext.Provider>,
        root,
      );
    show(SettingsLinks);
    await vi.waitFor(() => expect(root.textContent).toContain('alice.fm'));
    expect(root.textContent).toContain('Last.fm');
    show(SettingsImports);
    await vi.waitFor(() => expect(root.textContent).toContain('Import paused.'));
    show(SettingsCredentials);
    await vi.waitFor(() => expect(root.textContent).toContain('No app passwords.'));
    const label = root.querySelector<HTMLInputElement>('#credential-label')!;
    label.value = 'desktop';
    label.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(label.value).toBe('desktop'));
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
    );
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('ABCD-EFGH'));
    expect(root.textContent).toContain('desktop');
    expect(location.href).not.toContain('ABCD-EFGH');
    expect(JSON.stringify(window.history.state)).not.toContain('ABCD-EFGH');
    expect(JSON.stringify(state)).not.toContain('ABCD-EFGH');
    expect(JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)))).not.toContain('ABCD-EFGH');

    window.history.pushState({ page: 'imports' }, '', '/settings/imports');
    render(null, root);
    show(SettingsImports);
    await vi.waitFor(() => expect(root.textContent).toContain('Import paused.'));
    render(null, root);
    show(SettingsCredentials);
    await vi.waitFor(() => expect(root.textContent).toContain('desktop'));
    expect(root.textContent).not.toContain('ABCD-EFGH');
    expect(root.querySelector('input[readonly]')).toBeNull();
    expect(location.href).not.toContain('ABCD-EFGH');
    expect(JSON.stringify(window.history.state)).not.toContain('ABCD-EFGH');
    expect(JSON.stringify([state.session.value, state.handle.value, state.meta.value])).not.toContain('ABCD-EFGH');
    expect(JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)))).not.toContain('ABCD-EFGH');
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });
});
