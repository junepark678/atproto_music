import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app';
import { matchRoute } from '../../src/router';
import type { Session } from '../../src/session/client';
import { createAppState } from '../../src/state/store';

describe('web/test/routes/shell.test.tsx', () => {
  it('shows server session identity and the re-sign-in notice without browser OAuth state', async () => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/feed');
    const state = createAppState();
    state.session.value = {
      did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      handle: 'alice.test',
      username: 'alice',
      csrfToken: 'server-token',
      status: 'active',
      expiresAt: '2026-12-01T00:00:00Z',
    } satisfies Session;
    state.reauthRequired.value = true;
    const root = document.createElement('div');
    document.body.append(root);
    render(<App state={state} loadMetaOnMount={false} />, root);
    await vi.waitFor(() => expect(root.querySelector('.session-identity')).not.toBeNull());
    expect(root.querySelector('.session-identity')?.textContent).toContain(state.session.value?.did);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Sign in again');
    render(null, root);
    root.remove();
  });

  it('recognizes deep links for every settings screen and sends unknown paths to not found', async () => {
    expect(matchRoute('/settings/links')?.module).toBe('settings-links');
    expect(matchRoute('/settings/imports')?.module).toBe('settings-imports');
    expect(matchRoute('/settings/credentials')?.module).toBe('settings-credentials');
    expect(matchRoute('/lastfm/authorize')?.module).toBe('lastfm-authorize');
    expect(matchRoute('/not-a-route')).toBeUndefined();
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
      'https://music.test/not-a-route',
    );
    const root = document.createElement('div');
    document.body.append(root);
    render(<App state={createAppState()} loadMetaOnMount={false} />, root);
    await vi.waitFor(() => expect(root.textContent).toContain('Page not found'));
    render(null, root);
    root.remove();
  });

  it('the settings route gives signed-out users a sign-in prompt', async () => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/settings');
    const root = document.createElement('div');
    document.body.append(root);
    render(<App state={createAppState()} loadMetaOnMount={false} />, root);
    await vi.waitFor(() => expect(root.textContent).toContain('Sign in to manage your settings'));
    render(null, root);
    root.remove();
  });
});
