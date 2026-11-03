import { render } from 'preact';
import { afterEach, expect, it, vi } from 'vitest';
import LastfmAuthorize from '../../src/routes/lastfm-authorize';
import SettingsCredentials from '../../src/routes/settings-credentials';
import SettingsImports from '../../src/routes/settings-imports';
import SettingsLinks from '../../src/routes/settings-links';
import type { Session } from '../../src/session/client';
import { AppStateContext, createAppState, setSession } from '../../src/state/store';

const session: Session = {
  did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
  handle: 'alice.test',
  username: 'alice',
  csrfToken: 'csrf',
  status: 'active',
  expiresAt: '2026-12-01T00:00:00Z',
};
const credentials = { appPasswords: [], listenbrainzTokens: [], lastfmApps: [], lastfmSessions: [] };
function mount(Component: typeof SettingsCredentials | typeof SettingsImports | typeof LastfmAuthorize) {
  const state = createAppState();
  setSession(state, session);
  const root = document.createElement('div');
  render(
    <AppStateContext.Provider value={state}>
      <Component />
    </AppStateContext.Provider>,
    root,
  );
  return root;
}
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('creates an app password and keeps its one-time secret in the screen only', async () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    if (path === '/api/v1/auth/session') return Response.json(session);
    if (path === '/api/v1/account/credentials') return Response.json(credentials);
    if (path === '/api/v1/account/app-passwords')
      return Response.json(
        { id: 'pw-1', label: 'desktop', password: 'ABCD-EFGH', createdAt: '2026-01-01T00:00:00Z' },
        { status: 201 },
      );
    throw new Error(`unexpected request ${init.method ?? 'GET'} ${path}`);
  });
  const root = mount(SettingsCredentials);
  await vi.waitFor(() => expect(root.textContent).toContain('Create app password'));
  const input = root.querySelector<HTMLInputElement>('#credential-label')!;
  input.value = 'desktop';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(input.value).toBe('desktop'));
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => {
    expect(root.textContent).toContain('Save this secret now');
    expect(root.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('ABCD-EFGH');
  });
  expect(location.href).not.toContain('ABCD-EFGH');
  render(null, root);
});

it('the links, imports and credentials screens render server state; a created secret is shown once and gone after navigation', async () => {
  const state = createAppState();
  setSession(state, session);
  const root = document.createElement('div');
  document.body.append(root);
  let passwordCreated = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://music.test');
    if (url.pathname === '/api/v1/auth/session') return Response.json(session);
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
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false));
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
});

it('cancels an import through the authenticated route and refreshes to the cancelled server state', async () => {
  let stateName: 'fetching' | 'cancelled' = 'fetching';
  let releaseCancel!: (response: Response) => void;
  const cancelResponse = new Promise<Response>((resolve) => {
    releaseCancel = resolve;
  });
  const requests: { path: string; method: string; csrf: string | null; idempotency: string | null }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://music.test');
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push({
      path: url.pathname,
      method,
      csrf: new Headers(init.headers).get('X-CSRF-Token'),
      idempotency: new Headers(init.headers).get('Idempotency-Key'),
    });
    if (url.pathname === '/api/v1/auth/session') return Response.json(session);
    if (url.pathname === '/api/v1/imports' && method === 'GET')
      return Response.json({
        items: [
          {
            id: 'job-cancel',
            source: 'lastfm_api',
            remoteUser: 'alice',
            state: stateName,
            fetched: 3,
            staged: 3,
            duplicates: 0,
            invalid: 0,
            written: 0,
            failed: 0,
            etaSeconds: stateName === 'cancelled' ? null : 10,
            error: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });
    if (url.pathname === '/api/v1/imports/job-cancel/cancel' && method === 'POST') {
      expect(init.headers && new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf');
      stateName = 'cancelled';
      return cancelResponse;
    }
    throw new Error(`unexpected request ${method} ${url.pathname}`);
  });
  const root = mount(SettingsImports);
  await vi.waitFor(() =>
    expect([...root.querySelectorAll('button')].some((button) => button.textContent === 'Cancel import')).toBe(true),
  );
  const cancel = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Cancel import',
  )!;
  cancel.click();
  await vi.waitFor(() => expect(requests.some((request) => request.path.endsWith('/cancel'))).toBe(true));
  expect(cancel.disabled).toBe(true);
  releaseCancel(
    Response.json({
      id: 'job-cancel',
      source: 'lastfm_api',
      remoteUser: 'alice',
      state: 'cancelled',
      fetched: 3,
      staged: 3,
      duplicates: 0,
      invalid: 0,
      written: 0,
      failed: 0,
      etaSeconds: null,
      error: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
  );
  await vi.waitFor(() => expect(root.textContent).toContain('cancelled'));
  expect(root.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain('cancelled');
  expect(requests).toContainEqual({
    path: '/api/v1/imports/job-cancel/cancel',
    method: 'POST',
    csrf: 'csrf',
    idempotency: null,
  });
  expect(requests.filter((request) => request.path.endsWith('/cancel'))).toHaveLength(1);
  expect(
    requests.filter((request) => request.path === '/api/v1/imports' && request.method === 'GET').length,
  ).toBeGreaterThanOrEqual(2);
  render(null, root);
});

it('starts a history import and shows its progress state', async () => {
  let poll: object = { items: [] };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    if (path === '/api/v1/imports' && init.method === 'POST')
      return Response.json(
        {
          id: 'job-1',
          source: 'lastfm_api',
          remoteUser: 'alice',
          state: 'fetching',
          fetched: 10,
          staged: 10,
          duplicates: 1,
          invalid: 0,
          written: 5,
          failed: 0,
          etaSeconds: 60,
          error: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        { status: 202 },
      );
    if (path === '/api/v1/imports' && init.method === 'GET') return Response.json(poll);
    if (path === '/api/v1/auth/session') return Response.json(session);
    throw new Error(`unexpected request ${init.method ?? 'GET'} ${path}`);
  });
  const root = mount(SettingsImports);
  await vi.waitFor(() => expect(root.textContent).toContain('Start import'));
  const username = root.querySelector<HTMLInputElement>('#import-username')!;
  username.value = 'alice';
  username.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  poll = {
    items: [
      {
        id: 'job-1',
        source: 'lastfm_api',
        remoteUser: 'alice',
        state: 'fetching',
        fetched: 10,
        staged: 10,
        duplicates: 1,
        invalid: 0,
        written: 5,
        failed: 0,
        etaSeconds: 60,
        error: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  };
  await vi.waitFor(() => expect(root.textContent).toContain('Estimated time remaining'));
  expect(root.querySelector('progress')).not.toBeNull();
  render(null, root);
});

it('labels unissued Last.fm clients and exposes the callback host without rendering the token', async () => {
  window.history.replaceState(
    null,
    '',
    '/lastfm/authorize?api_key=unissued&token=deadbeef&cb=https%3A%2F%2Fdesktop.example%2Fcallback',
  );
  vi.stubGlobal('fetch', async () => Response.json(credentials));
  const root = mount(LastfmAuthorize);
  await vi.waitFor(() => expect(root.textContent).toContain('Unverified application'));
  expect(root.textContent).toContain('desktop.example');
  expect(root.textContent).not.toContain('deadbeef');
  expect(root.querySelector('button')?.textContent).toBe('Deny');
  render(null, root);
});
