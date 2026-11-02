import { render } from 'preact';
import { afterEach, expect, it, vi } from 'vitest';
import SettingsLinks from '../../src/routes/settings-links';
import { AppStateContext, createAppState, setSession } from '../../src/state/store';
import type { Session } from '../../src/session/client';

const session: Session = { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', handle: 'alice.test', username: 'alice', csrfToken: 'csrf', status: 'active', expiresAt: '2026-12-01T00:00:00Z' };
afterEach(() => vi.unstubAllGlobals());

it('lists links, adds a ListenBrainz token, and unlinks through the BFF', async () => {
  const requests: Array<{ path: string; method: string }> = [];
  let links: Array<{ id: string; service: 'listenbrainz'; remoteUser: string; forwardScrobbles: boolean; forwardNowPlaying: boolean; status: 'active'; lastError: null; createdAt: string; updatedAt: string }> = [];
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    const method = init.method ?? 'GET';
    requests.push({ path, method });
    if (path === '/api/v1/links' && method === 'GET') return Response.json({ items: links });
    if (path === '/api/v1/auth/session') return Response.json(session);
    if (path === '/api/v1/links/listenbrainz' && method === 'POST') {
      links = [{ id: 'link-1', service: 'listenbrainz', remoteUser: 'alice', forwardScrobbles: true, forwardNowPlaying: false, status: 'active', lastError: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }];
      return Response.json(links[0]!, { status: 201 });
    }
    if (path === '/api/v1/links/link-1' && method === 'DELETE') { links = []; return new Response(null, { status: 204 }); }
    throw new Error(`unexpected request ${method} ${path}`);
  });
  const state = createAppState();
  setSession(state, session);
  const root = document.createElement('div');
  render(<AppStateContext.Provider value={state}><SettingsLinks /></AppStateContext.Provider>, root);
  await vi.waitFor(() => expect(root.textContent).toContain('Connect ListenBrainz'));
  const input = root.querySelector<HTMLInputElement>('#listenbrainz-token')!;
  input.value = 'secret-token'; input.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(root.textContent).toContain('alice'));
  expect(requests.some((request) => request.path === '/api/v1/links/listenbrainz' && request.method === 'POST')).toBe(true);
  [...root.querySelectorAll('button')].find((button) => button.textContent?.includes('Disconnect listenbrainz'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await vi.waitFor(() => expect(root.textContent).toContain('No music services are connected.'));
  expect(requests.some((request) => request.path === '/api/v1/links/link-1' && request.method === 'DELETE')).toBe(true);
  render(null, root);
});
