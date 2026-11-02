import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { ApiClient } from '../../src/api/client';
import { App } from '../../src/app';
import { OutboxService } from '../../src/components/outbox-service';
import { ServicesProvider, type ScreenServices } from '../../src/components/services';
import { AppStateContext, createAppState } from '../../src/state/store';
import { IndexingSection } from '../../src/routes/settings';
import { mount, META, SESSION } from './support';

describe('web/test/routes/settings.test.tsx', () => {
  it('shows server session identity and the public export link without a local browser outbox', async () => {
    const app = mount('/settings');
    app.state.session.value = SESSION;
    await vi.waitFor(() => expect(app.root.querySelector('a.export-link')).not.toBeNull());
    expect(app.root.textContent).toContain(SESSION.did);
    expect(app.root.querySelector('a.export-link')?.getAttribute('href')).toContain(
      `/api/v1/users/${SESSION.did}/export`,
    );
    app.cleanup();
  });

  it('disconnect confirmation explains the public opt-out and sends the confirmed choice', async () => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/settings');
    const api = new ApiClient({ fetch: async (input) => {
      const path = new URL(input, 'https://music.test').pathname;
      if (path === '/api/v1/records/status') return Response.json({ uri: `at://${SESSION.did}/com.example.atmusic.settings/self`, state: 'indexed', cid: 'bafyreieogjytekr7rpqty3rtkfjjglj35ub2ipqjh6ftn7rbxwqe5242jq', revision: '3mfixture', indexing: { state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: 0 } });
      throw new Error(`unexpected request ${path}`);
    } });
    const state = createAppState({ api });
    const outbox = new OutboxService(SESSION, META.lexiconPrefix);
    const disconnect = vi.fn(async () => ({ id: 'op-1' } as never));
    outbox.disconnect = disconnect;
    const services: ScreenServices = {
      clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
      random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
      ticker: { every: () => () => undefined },
      session: async () => ({ signIn: async () => undefined, signOut: async () => undefined, expiry: async () => null }),
      outbox: async () => outbox,
      closeOutbox: async () => undefined,
    };
    const root = document.createElement('div'); document.body.append(root);
    render(<AppStateContext.Provider value={state}><ServicesProvider value={services}><IndexingSection outbox={outbox} /></ServicesProvider></AppStateContext.Provider>, root);
    await vi.waitFor(() => expect(root.querySelector('[data-indexing="enabled"]')).not.toBeNull());
    [...root.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Disconnect'))!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-confirm="disconnect"]')).not.toBeNull());
    const copy = root.querySelector('[data-confirm="disconnect"]')!.textContent ?? '';
    expect(copy).toContain('remain in your PDS as public records');
    expect(copy).toContain('opt-out record is public too');
    expect(copy).not.toMatch(/erase|delete your public records/i);
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Confirm disconnect')!.click();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    render(null, root); root.remove();
  });

  it('sign out calls the server-session port and removes authenticated UI', async () => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/settings');
    const api = new ApiClient({ fetch: async () => Response.json({ error: { code: 'not_found', message: 'not found', requestId: '00000000-0000-4000-8000-000000000001' } }, { status: 404 }) });
    const state = createAppState({ api });
    state.session.value = SESSION;
    state.handle.value = SESSION.handle;
    const signOut = vi.fn(async () => undefined);
    const services: ScreenServices = {
      clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
      random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
      ticker: { every: () => () => undefined },
      session: async () => ({ signIn: async () => undefined, signOut, expiry: async () => null }),
      outbox: async () => { throw new Error('publishing is unavailable in this test'); },
      closeOutbox: async () => undefined,
    };
    const root = document.createElement('div'); document.body.append(root);
    render(<AppStateContext.Provider value={state}><ServicesProvider value={services}><App state={state} loadMetaOnMount={false} /></ServicesProvider></AppStateContext.Provider>, root);
    await vi.waitFor(() => expect(root.textContent).toContain(SESSION.did));
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Sign out')!.click();
    await vi.waitFor(() => expect(root.textContent).toContain('You have signed out'));
    expect(signOut).toHaveBeenCalledOnce();
    expect(root.textContent).not.toContain(`Signed in as @${SESSION.handle}`);
    render(null, root); root.remove();
  });
});
