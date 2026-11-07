// Owner rule: a DID is never shown to the user outside of URLs. These routes
// render with fixture DIDs; no visible text or accessible-name attribute may
// contain one (hrefs and other URL attributes are allowed).
import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { OperationStatus } from '../../src/components/operation-status';
import SettingsImports from '../../src/routes/settings-imports';
import { AppStateContext, createAppState, setSession } from '../../src/state/store';
import { DID, example, mount, SESSION } from './support';

const NAME_ATTRIBUTES = ['title', 'aria-label', 'aria-description', 'alt', 'placeholder', 'value'];

function assertNoDid(root: HTMLElement): void {
  expect(root.textContent ?? '').not.toMatch(/did:(plc|web):/);
  for (const element of root.querySelectorAll('*')) {
    for (const name of NAME_ATTRIBUTES) {
      expect(element.getAttribute(name) ?? '', `${element.tagName}[${name}]`).not.toMatch(/did:(plc|web):/);
    }
  }
}

const notFound = () =>
  Response.json(
    { error: { code: 'not_found', message: 'not found', requestId: '00000000-0000-4000-8000-000000000001' } },
    { status: 404 },
  );

describe('web/test/routes/no-dids.test.tsx', () => {
  it('feed, profile, not-found profile and settings never render a DID as visible text or an accessible name', async () => {
    const feed = mount('/feed');
    feed.state.session.value = SESSION;
    await vi.waitFor(() => expect(feed.root.querySelector('a.actor')).not.toBeNull());
    assertNoDid(feed.root);
    feed.cleanup();

    const profile = example<Record<string, unknown>>('profile');
    const unverified = mount(`/u/${DID}`, async (input) => {
      if (new URL(String(input), 'https://music.test').pathname.endsWith('/profile'))
        return Response.json({ ...profile, handle: null });
      return undefined;
    });
    await vi.waitFor(() => expect(unverified.root.querySelector('.profile-header')).not.toBeNull());
    expect(unverified.root.querySelector('h1')?.textContent).toBe('Unknown account');
    assertNoDid(unverified.root);
    unverified.cleanup();

    for (const signedIn of [false, true]) {
      const missing = mount(`/u/${DID}`, async (input) =>
        new URL(String(input), 'https://music.test').pathname.endsWith('/profile') ? notFound() : undefined,
      );
      if (signedIn) missing.state.session.value = SESSION;
      await vi.waitFor(() => expect(missing.root.textContent).toContain('Profile not found'));
      assertNoDid(missing.root);
      missing.cleanup();
    }

    const settings = mount('/settings');
    settings.state.session.value = SESSION;
    await vi.waitFor(() => expect(settings.root.querySelector('a.export-link')).not.toBeNull());
    assertNoDid(settings.root);
    settings.cleanup();
  });

  it('server-provided messages (import job errors, operation retry and failure reasons) never show a DID', async () => {
    const leak = `could not resolve ${DID} via did:web:music.example.com`;
    const op = document.createElement('div');
    render(<OperationStatus op={{ kind: 'scrobble_create', state: 'queued', lastError: leak }} />, op);
    expect(op.textContent).toContain('an account');
    assertNoDid(op);
    render(<OperationStatus op={{ kind: 'scrobble_create', state: 'failed', reason: leak, failureCode: 'x' }} />, op);
    assertNoDid(op);
    render(null, op);

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://music.test');
      if (url.pathname === '/api/v1/auth/session') return Response.json(SESSION);
      if (url.pathname === '/api/v1/imports')
        return Response.json({
          items: [
            {
              id: 'job-1',
              source: 'lastfm_api',
              remoteUser: 'alice',
              state: 'failed',
              fetched: 0,
              staged: 0,
              duplicates: 0,
              invalid: 0,
              written: 0,
              failed: 0,
              etaSeconds: null,
              error: leak,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        });
      return Response.json({ items: [] });
    });
    const state = createAppState();
    setSession(state, SESSION);
    const root = document.createElement('div');
    render(
      <AppStateContext.Provider value={state}>
        <SettingsImports />
      </AppStateContext.Provider>,
      root,
    );
    await vi.waitFor(() => expect(root.textContent).toContain('could not resolve an account'));
    assertNoDid(root);
    render(null, root);
  });
});
