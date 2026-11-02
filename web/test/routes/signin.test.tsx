import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app';
import { type ScreenServices, ServicesProvider } from '../../src/components/services';
import { createAppState } from '../../src/state/store';

function services(signIn: (handle: string) => Promise<void>): ScreenServices {
  return {
    clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
    random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
    ticker: { every: () => () => undefined },
    session: async () => ({ signIn, signOut: async () => undefined, expiry: async () => null }),
    outbox: async () => {
      throw new Error('not used');
    },
    closeOutbox: async () => undefined,
  };
}

describe('web/test/routes/signin.test.tsx', () => {
  it('posts the handle to auth start and performs a full page redirect to the authorize URL', async () => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/signin');
    const signIn = vi.fn(async () => undefined);
    const state = createAppState();
    state.reauthRequired.value = true;
    const root = document.createElement('div');
    document.body.append(root);
    render(
      <ServicesProvider value={services(signIn)}>
        <App state={state} loadMetaOnMount={false} />
      </ServicesProvider>,
      root,
    );
    await vi.waitFor(() => expect(root.querySelector('form')).not.toBeNull());
    expect(root.textContent).toContain('Your previous session has ended');
    const input = root.querySelector<HTMLInputElement>('[name="handle"]')!;
    input.value = 'alice.test';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(signIn).toHaveBeenCalledWith('alice.test'));
    render(null, root);
    root.remove();
  });
});
