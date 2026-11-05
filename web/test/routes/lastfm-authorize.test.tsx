import { render } from 'preact';
import { afterEach, expect, it, vi } from 'vitest';
import LastfmAuthorize from '../../src/routes/lastfm-authorize';
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

function mount() {
  const state = createAppState();
  setSession(state, session);
  const root = document.createElement('div');
  render(
    <AppStateContext.Provider value={state}>
      <LastfmAuthorize />
    </AppStateContext.Provider>,
    root,
  );
  return root;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('the page shows the client name, labelled unverified unless it is an issued app, the token request time and the callback host; approve posts /api/v1/lastfm/authorize and navigates to the returned redirect; deny stays on the page', async () => {
  window.history.replaceState(
    null,
    '',
    '/lastfm/authorize?api_key=unissued&token=request-token&cb=https%3A%2F%2Fdesktop.example%2Fcallback%3Fsource%3Dapp',
  );
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    if (path === '/api/v1/auth/session') return Response.json(session);
    if (path === '/api/v1/account/credentials')
      return Response.json({
        appPasswords: [],
        listenbrainzTokens: [],
        lastfmApps: [],
        lastfmSessions: [],
      });
    if (path === '/api/v1/lastfm/authorize' && init.method === 'POST')
      return Response.json({ token: 'approved-token' });
    throw new Error(`unexpected request ${init.method ?? 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  const root = mount();
  await vi.waitFor(() => expect(root.textContent).toContain('Unverified application'));
  expect(root.textContent).toContain('desktop.example');
  expect(root.textContent).toContain('Requested');
  expect(root.textContent).not.toContain('request-token');
  expect(root.querySelector('button')?.textContent).toBe('Deny');

  const buttons = root.querySelectorAll('button');
  (buttons[1] as HTMLButtonElement).click();
  await vi.waitFor(() =>
    expect(assign).toHaveBeenCalledWith('https://desktop.example/callback?source=app&token=approved-token'),
  );
  expect(fetcher).toHaveBeenCalledWith(
    '/api/v1/lastfm/authorize',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ apiKey: 'unissued', token: 'request-token' }) }),
  );
  render(null, root);
  assign.mockRestore();

  window.history.replaceState(null, '', '/lastfm/authorize?api_key=unissued');
  const denyRoot = mount();
  await vi.waitFor(() => expect(denyRoot.textContent).toContain('Unverified application'));
  const requestsBeforeDeny = fetcher.mock.calls.filter(
    ([input]) => String(input) === '/api/v1/lastfm/authorize',
  ).length;
  (denyRoot.querySelector('button') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(denyRoot.textContent).toContain('Authorization denied.'));
  expect(fetcher.mock.calls.filter(([input]) => String(input) === '/api/v1/lastfm/authorize')).toHaveLength(
    requestsBeforeDeny,
  );
  render(null, denyRoot);
});
