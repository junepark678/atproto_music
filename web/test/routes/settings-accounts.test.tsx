import { render } from 'preact';
import { afterEach, expect, it, vi } from 'vitest';
import SettingsCredentials from '../../src/routes/settings-credentials';
import SettingsImports from '../../src/routes/settings-imports';
import LastfmAuthorize from '../../src/routes/lastfm-authorize';
import { AppStateContext, createAppState, setSession } from '../../src/state/store';
import type { Session } from '../../src/session/client';

const session: Session = { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', handle: 'alice.test', username: 'alice', csrfToken: 'csrf', status: 'active', expiresAt: '2026-12-01T00:00:00Z' };
const credentials = { appPasswords: [], listenbrainzTokens: [], lastfmApps: [], lastfmSessions: [] };
function mount(Component: typeof SettingsCredentials | typeof SettingsImports | typeof LastfmAuthorize) {
  const state = createAppState(); setSession(state, session);
  const root = document.createElement('div');
  render(<AppStateContext.Provider value={state}><Component /></AppStateContext.Provider>, root);
  return root;
}
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

it('creates an app password and keeps its one-time secret in the screen only', async () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    if (path === '/api/v1/auth/session') return Response.json(session);
    if (path === '/api/v1/account/credentials') return Response.json(credentials);
    if (path === '/api/v1/account/app-passwords') return Response.json({ id: 'pw-1', label: 'desktop', password: 'ABCD-EFGH', createdAt: '2026-01-01T00:00:00Z' }, { status: 201 });
    throw new Error(`unexpected request ${init.method ?? 'GET'} ${path}`);
  });
  const root = mount(SettingsCredentials);
  await vi.waitFor(() => expect(root.textContent).toContain('Create app password'));
  const input = root.querySelector<HTMLInputElement>('#credential-label')!;
  input.value = 'desktop'; input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(input.value).toBe('desktop'));
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => { expect(root.textContent).toContain('Save this secret now'); expect(root.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('ABCD-EFGH'); });
  expect(location.href).not.toContain('ABCD-EFGH');
  render(null, root);
});

it('starts a history import and shows its progress state', async () => {
  let poll: object = { items: [] };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    if (path === '/api/v1/imports' && init.method === 'POST') return Response.json({ id: 'job-1', source: 'lastfm_api', remoteUser: 'alice', state: 'fetching', fetched: 10, staged: 10, duplicates: 1, invalid: 0, written: 5, failed: 0, etaSeconds: 60, error: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }, { status: 202 });
    if (path === '/api/v1/imports' && init.method === 'GET') return Response.json(poll);
    if (path === '/api/v1/auth/session') return Response.json(session);
    throw new Error(`unexpected request ${init.method ?? 'GET'} ${path}`);
  });
  const root = mount(SettingsImports);
  await vi.waitFor(() => expect(root.textContent).toContain('Start import'));
  const username = root.querySelector<HTMLInputElement>('#import-username')!;
  username.value = 'alice'; username.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  poll = { items: [{ id: 'job-1', source: 'lastfm_api', remoteUser: 'alice', state: 'fetching', fetched: 10, staged: 10, duplicates: 1, invalid: 0, written: 5, failed: 0, etaSeconds: 60, error: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] };
  await vi.waitFor(() => expect(root.textContent).toContain('Estimated time remaining'));
  expect(root.querySelector('progress')).not.toBeNull();
  render(null, root);
});

it('labels unissued Last.fm clients and exposes the callback host without rendering the token', async () => {
  window.history.replaceState(null, '', '/lastfm/authorize?api_key=unissued&token=deadbeef&cb=https%3A%2F%2Fdesktop.example%2Fcallback');
  vi.stubGlobal('fetch', async () => Response.json(credentials));
  const root = mount(LastfmAuthorize);
  await vi.waitFor(() => expect(root.textContent).toContain('Unverified application'));
  expect(root.textContent).toContain('desktop.example');
  expect(root.textContent).not.toContain('deadbeef');
  expect(root.querySelector('button')?.textContent).toBe('Deny');
  render(null, root);
});
