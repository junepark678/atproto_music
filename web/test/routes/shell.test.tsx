import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app';
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
});
