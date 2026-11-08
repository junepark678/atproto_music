import { render } from 'preact';
import { afterEach, expect, it, vi } from 'vitest';
import type { Link } from '../../src/api/account';
import { formatLocalTime } from '../../src/components/format';
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

function link(overrides: Partial<Link> = {}): Link {
  return {
    id: 'link-1',
    service: 'listenbrainz',
    remoteUser: 'alice',
    forwardScrobbles: true,
    forwardNowPlaying: true,
    status: 'active',
    lastError: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mount() {
  const state = createAppState();
  setSession(state, session);
  const root = document.createElement('div');
  render(
    <AppStateContext.Provider value={state}>
      <SettingsLinks />
    </AppStateContext.Provider>,
    root,
  );
  return { root, unmount: () => render(null, root) };
}

function stubLinks(initial: Link[]) {
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  let links = initial;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, ...(body === undefined ? {} : { body }) });
    if (path === '/api/v1/auth/session' && method === 'GET') return Response.json(session);
    if (path === '/api/v1/links' && method === 'GET') return Response.json({ items: links });
    const patchMatch = /^\/api\/v1\/links\/([^/]+)$/.exec(path);
    if (patchMatch && method === 'PATCH') {
      const id = decodeURIComponent(patchMatch[1]!);
      links = links.map((item) =>
        item.id === id
          ? {
              ...item,
              ...body,
              sync: item.sync
                ? { ...item.sync, ...(typeof body?.pullEnabled === 'boolean' ? { pullEnabled: body.pullEnabled } : {}) }
                : undefined,
            }
          : item,
      );
      return Response.json(links.find((item) => item.id === id));
    }
    if (path === '/api/v1/links/listenbrainz' && method === 'POST') {
      links = [link()];
      return Response.json(links[0], { status: 201 });
    }
    if (patchMatch && method === 'DELETE') {
      links = links.filter((item) => item.id !== decodeURIComponent(patchMatch[1]!));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${method} ${path}`);
  });
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

it('renders sync state, backfill progress, local time and PATCHes each setting toggle', async () => {
  const lastSyncedAt = '2026-01-15T12:00:00Z';
  const requests = stubLinks([
    link({
      service: 'lastfm',
      sync: {
        backfill: { state: 'running', done: 1240, total: 3000 },
        pullEnabled: true,
        lastSuccessAt: lastSyncedAt,
        queued: 10,
        failed: 0,
      },
    }),
  ]);
  const { root, unmount } = mount();
  await vi.waitFor(() => expect(root.textContent).toContain('Sending history: 1,240 of 3,000'));

  expect(root.textContent).toContain('Active');
  expect(root.textContent).toContain('Last synced');
  expect(root.textContent).toContain(formatLocalTime(lastSyncedAt));
  expect(root.textContent).toContain(
    "Last.fm accepts scrobbles from the last 14 days and doesn't support deleting them.",
  );
  const progress = root.querySelector('progress')!;
  expect(progress.tagName).toBe('PROGRESS');
  expect(progress.getAttribute('aria-label')).toBe('Sending history');
  expect(progress.getAttribute('aria-valuenow')).toBe('1240');
  expect(progress.getAttribute('aria-valuemax')).toBe('3000');
  expect(progress.getAttribute('aria-valuetext')).toBe('1240 of 3000 listens sent');
  expect(root.textContent).not.toContain('did:');

  const setToggle = async (labelText: string, checked: boolean) => {
    const patchCount = requests.filter((request) => request.method === 'PATCH').length;
    const label = [...root.querySelectorAll('label')].find((item) => item.textContent?.trim() === labelText)!;
    const input = label.querySelector('input')!;
    expect(input.checked).not.toBe(checked);
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(patchCount + 1),
    );
  };
  await setToggle('Send scrobbles and loves', false);
  await setToggle('Send now playing', false);
  await setToggle('Bring in new scrobbles from Last.fm', false);
  expect(requests.filter((request) => request.method === 'PATCH').map((request) => request.body)).toEqual([
    { forwardScrobbles: false },
    { forwardNowPlaying: false },
    { pullEnabled: false },
  ]);
  unmount();
});

it('shows reconnect guidance and scrubs DIDs from the server error', async () => {
  stubLinks([
    link({
      sync: {
        backfill: { state: 'done', done: 10, total: 10 },
        pullEnabled: true,
        lastError: 'Unable to sync did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
        needsReauth: true,
        queued: 0,
        failed: 1,
      },
    }),
  ]);
  const { root, unmount } = mount();
  await vi.waitFor(() => expect(root.textContent).toContain('Reconnect your account to keep importing.'));
  expect(root.textContent).toContain('Needs reconnect');
  expect(root.textContent).toContain('Unable to sync an account');
  expect(root.textContent).not.toContain('did:');
  unmount();
});

it('supports older responses without sync metadata and shows limits only for Last.fm', async () => {
  stubLinks([
    link({ id: 'lastfm-link', service: 'lastfm', remoteUser: 'last-user' }),
    link({ id: 'lb-link', service: 'listenbrainz', remoteUser: 'lb-user' }),
  ]);
  const { root, unmount } = mount();
  await vi.waitFor(() => expect(root.querySelectorAll('.link-card')).toHaveLength(2));
  expect(root.textContent?.match(/Not yet/g)).toHaveLength(2);
  expect(root.querySelector('progress')).toBeNull();
  const cards = [...root.querySelectorAll('.link-card')];
  expect(cards[0]!.textContent).toContain(
    "Last.fm accepts scrobbles from the last 14 days and doesn't support deleting them.",
  );
  expect(cards[1]!.textContent).not.toContain('Last.fm accepts scrobbles');
  expect(root.textContent).not.toContain('did:');
  unmount();
});

it('still connects and disconnects ListenBrainz links', async () => {
  const requests = stubLinks([]);
  vi.stubGlobal('confirm', () => true);
  const { root, unmount } = mount();
  await vi.waitFor(() => expect(root.textContent).toContain('Connect ListenBrainz'));
  const input = root.querySelector<HTMLInputElement>('#listenbrainz-token')!;
  input.value = 'secret-token';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('form button')?.disabled).toBe(false));
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(root.textContent).toContain('alice'));
  expect(requests.some((request) => request.path === '/api/v1/links/listenbrainz' && request.method === 'POST')).toBe(
    true,
  );
  [...root.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Disconnect listenbrainz'))
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await vi.waitFor(() => expect(root.textContent).toContain('No music services are connected.'));
  expect(requests.some((request) => request.path === '/api/v1/links/link-1' && request.method === 'DELETE')).toBe(true);
  unmount();
});
