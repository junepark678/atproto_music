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
function mount(
  Component: typeof SettingsCredentials | typeof SettingsImports | typeof SettingsLinks | typeof LastfmAuthorize,
  currentSession: Session = session,
) {
  const state = createAppState();
  setSession(state, currentSession, null, { reauthRequired: currentSession.status === 'reauth_required' });
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

it('reauth_required settings pages show account data without mutation forms', async () => {
  const reauth = { ...session, handle: null, status: 'reauth_required' as const };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    if (path === '/api/v1/account/credentials') return Response.json(credentials);
    if (path === '/api/v1/imports') return Response.json({ items: [] });
    if (path === '/api/v1/links') return Response.json({ items: [] });
    throw new Error(`unexpected request GET ${path}`);
  });

  for (const Component of [SettingsCredentials, SettingsImports] as const) {
    const root = mount(Component, reauth);
    await vi.waitFor(() => expect(root.textContent).toContain('Sign in again'));
    expect(root.querySelector('form')).toBeNull();
    expect([...root.querySelectorAll('button')].map((button) => button.textContent?.trim())).not.toContain('Revoke');
    render(null, root);
  }

  const links = mount(SettingsLinks, reauth);
  await vi.waitFor(() => expect(links.textContent).toContain('Sign in again'));
  expect(links.querySelector('form')).toBeNull();
  expect(links.querySelector('button')).toBeNull();
  render(null, links);

  window.history.replaceState(null, '', '/lastfm/authorize?api_key=app-key');
  const authorize = mount(LastfmAuthorize, reauth);
  await vi.waitFor(() => expect(authorize.textContent).toContain('Sign in again'));
  expect(authorize.querySelector<HTMLButtonElement>('button:last-child')?.disabled).toBe(true);
  render(null, authorize);
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
