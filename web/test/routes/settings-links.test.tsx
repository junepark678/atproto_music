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
  return { root, state, unmount: () => render(null, root) };
}

function stubLinks(initial: Link[], options: { failPatch?: boolean } = {}) {
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
      if (options.failPatch) return Response.json({ error: 'upstream_error' }, { status: 502 });
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
        backfill: { state: 'done', done: 10, total: 10, lastError: 'retry_exhausted' },
        pullEnabled: true,
        holdReason: 'reauth_required',
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
  expect(root.querySelector('.link-error')?.getAttribute('role')).toBeNull();
  expect(root.querySelector('[role="alert"]')).toBeNull();
  unmount();
});

it('shows known sync-error advice in plain words for each service', async () => {
  stubLinks([
    link({ id: 'lastfm-revoked', service: 'lastfm', status: 'revoked', lastError: 'session_revoked' }),
    link({ id: 'lb-revoked', service: 'listenbrainz', status: 'revoked', lastError: 'token_revoked' }),
    link({ id: 'credential-error', status: 'error', lastError: 'credential_unreadable' }),
    link({ id: 'lastfm-key-error', service: 'lastfm', status: 'error', lastError: 'lastfm_key_rejected' }),
  ]);
  const { root, unmount } = mount();
  await vi.waitFor(() => expect(root.querySelectorAll('.link-card')).toHaveLength(4));
  expect(root.textContent).toContain('Last.fm disconnected this app. Reconnect to resume syncing.');
  expect(root.textContent).toContain('ListenBrainz disconnected this app. Reconnect to resume syncing.');
  expect(root.textContent).toContain("Saved credentials couldn't be read. Reconnect to resume syncing.");
  expect(root.textContent).toContain("Last.fm is rejecting this server's API key. Syncing is paused.");
  expect(root.querySelectorAll('.link-error[role="alert"]')).toHaveLength(0);
  expect(root.textContent).not.toContain('did:');
  unmount();
});

it('shows terminal sync failures, transient holds, and independent backfill errors distinctly', async () => {
  stubLinks([
    link({
      id: 'pull-terminal',
      sync: {
        backfill: { state: 'done', done: 1, total: 1 },
        pullEnabled: true,
        holdReason: 'retry_exhausted',
        queued: 0,
        failed: 8,
      },
    }),
    link({
      id: 'backfill-terminal',
      sync: {
        backfill: { state: 'done', done: 1, total: 2, lastError: 'retry_exhausted' },
        pullEnabled: true,
        holdReason: 'staging_capacity',
        queued: 0,
        failed: 0,
      },
    }),
    link({
      id: 'combined',
      sync: {
        backfill: { state: 'done', done: 1, total: 2, lastError: 'retry_exhausted' },
        pullEnabled: true,
        holdReason: 'lastfm_error',
        queued: 0,
        failed: 8,
      },
    }),
    link({
      id: 'temporary',
      sync: {
        backfill: { state: 'pending', done: 0, total: 0 },
        pullEnabled: true,
        holdReason: 'session_restore_transient',
        queued: 0,
        failed: 0,
      },
    }),
  ]);
  const { root, unmount } = mount();
  await vi.waitFor(() => expect(root.querySelectorAll('.link-card')).toHaveLength(4));
  const cards = [...root.querySelectorAll<HTMLElement>('.link-card')];
  expect(cards[0]!.querySelector('.link-status-pill')?.textContent).toBe('Error');
  expect(cards[1]!.querySelector('.link-status-pill')?.textContent).toBe('Error');
  expect(cards[1]!.textContent).toContain('Repeated attempts to sync with ListenBrainz failed.');
  expect(cards[1]!.textContent).toContain('temporarily waiting for queue capacity');
  expect(cards[2]!.querySelector('.link-status-pill')?.textContent).toBe('Error');
  expect(cards[2]!.textContent).toContain('Last.fm stopped responding successfully.');
  expect(cards[2]!.textContent).toContain('Repeated attempts to sync with ListenBrainz failed.');
  expect(cards[3]!.querySelector('.link-status-pill')?.textContent).toBe('Active');
  expect(cards[3]!.textContent).toContain('restoring its session');
  expect(root.querySelectorAll('.link-error[role="alert"]')).toHaveLength(0);
  unmount();
});

it('keeps action errors announced as alerts', async () => {
  const requests = stubLinks([link()], { failPatch: true });
  const { root, unmount } = mount();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await vi.waitFor(() => expect(root.querySelectorAll('.link-card')).toHaveLength(1));
  const label = [...root.querySelectorAll('label')].find(
    (item) => item.textContent?.trim() === 'Send scrobbles and loves',
  )!;
  const input = label.querySelector('input')!;
  input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong.'));
  expect(requests.some((request) => request.method === 'PATCH')).toBe(true);
  expect(root.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
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

it('ignores a poll that began before a successful settings mutation', async () => {
  const pendingLists: Array<(value: Response) => void> = [];
  let finishPatch!: (value: Response) => void;
  const old = link();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    const method = init.method ?? 'GET';
    if (path === '/api/v1/auth/session') return Response.json(session);
    if (path === '/api/v1/links' && method === 'GET')
      return await new Promise<Response>((resolve) => pendingLists.push(resolve));
    if (path === '/api/v1/links/link-1' && method === 'PATCH')
      return await new Promise<Response>((resolve) => {
        finishPatch = resolve;
      });
    throw new Error(`unexpected request ${method} ${path}`);
  });
  const { root, unmount } = mount();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await vi.waitFor(() => expect(pendingLists).toHaveLength(1));
  pendingLists[0]!(Response.json({ items: [old] }));
  await vi.waitFor(() => expect(root.querySelector('.link-card')).not.toBeNull());
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(pendingLists).toHaveLength(2));
  const input = [...root.querySelectorAll('label')]
    .find((item) => item.textContent?.trim() === 'Send scrobbles and loves')!
    .querySelector('input')!;
  input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(finishPatch).toBeTypeOf('function'));
  finishPatch(Response.json({ ...old, forwardScrobbles: false }));
  await vi.waitFor(() => expect(pendingLists).toHaveLength(3));
  pendingLists[2]!(Response.json({ items: [{ ...old, forwardScrobbles: false }] }));
  await vi.waitFor(() => expect(input.checked).toBe(false));
  pendingLists[1]!(Response.json({ items: [old] }));
  await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false));
  unmount();
});

it('does not let an older list error replace a newer successful refresh', async () => {
  const pending: Array<{ resolve: (value: Response) => void; reject: (error: Error) => void }> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    if (path === '/api/v1/auth/session') return Response.json(session);
    if (path === '/api/v1/links')
      return await new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }));
    throw new Error(`unexpected request ${path}`);
  });
  const { root, unmount } = mount();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(pending.length).toBeGreaterThan(1));
  pending[pending.length - 1]!.resolve(Response.json({ items: [link()] }));
  await vi.waitFor(() => expect(root.querySelectorAll('.link-card')).toHaveLength(1));
  pending[0]!.reject(new Error('old list failed'));
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).toBeNull());
  expect(root.textContent).toContain('ListenBrainz');
  unmount();
});

it('applies the newest valid later poll', async () => {
  let listCount = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    if (path === '/api/v1/auth/session') return Response.json(session);
    if (path === '/api/v1/links') {
      listCount++;
      return Response.json({ items: [link({ remoteUser: listCount === 1 ? 'first result' : 'new poll result' })] });
    }
    throw new Error(`unexpected request ${path}`);
  });
  const { root, unmount } = mount();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await vi.waitFor(() => expect(root.textContent).toContain('first result'));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(root.textContent).toContain('new poll result'));
  expect(listCount).toBe(2);
  unmount();
});

it('fences list responses on unmount and owner-session change', async () => {
  const pending: Array<(value: Response) => void> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    if (path === '/api/v1/auth/session') return Response.json(session);
    if (path === '/api/v1/links') return await new Promise<Response>((resolve) => pending.push(resolve));
    throw new Error(`unexpected request ${path}`);
  });
  const { root, state, unmount } = mount();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  const nextOwner: Session = {
    ...session,
    did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
    handle: 'bob.test',
    username: 'bob',
  };
  setSession(state, nextOwner);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[1]!(Response.json({ items: [link({ remoteUser: 'new owner' })] }));
  await vi.waitFor(() => expect(root.textContent).toContain('new owner'));
  pending[0]!(Response.json({ items: [link({ remoteUser: 'old owner' })] }));
  await vi.waitFor(() => expect(root.textContent).toContain('new owner'));
  expect(root.textContent).not.toContain('old owner');
  unmount();

  const pendingUnmount: Array<(value: Response) => void> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'https://music.test').pathname;
    if (path === '/api/v1/auth/session') return Response.json(session);
    if (path === '/api/v1/links') return await new Promise<Response>((resolve) => pendingUnmount.push(resolve));
    throw new Error(`unexpected request ${path}`);
  });
  const removed = mount();
  await vi.waitFor(() => expect(pendingUnmount).toHaveLength(1));
  removed.unmount();
  pendingUnmount[0]!(Response.json({ items: [link()] }));
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
  expect(root.textContent).toContain('Disconnect ListenBrainz');
  expect(requests.some((request) => request.path === '/api/v1/links/listenbrainz' && request.method === 'POST')).toBe(
    true,
  );
  [...root.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Disconnect ListenBrainz'))
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await vi.waitFor(() => expect(root.textContent).toContain('No music services are connected.'));
  expect(requests.some((request) => request.path === '/api/v1/links/link-1' && request.method === 'DELETE')).toBe(true);
  unmount();
});
