// Kept in its own isolated file so prior behavioral cases cannot warm the lazy route.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../src/app';
import { type ScreenServices, ServicesProvider } from '../../src/components/services';
import { createAppState } from '../../src/state/store';

let root: HTMLDivElement | null = null;
let detachAbort: (() => void) | undefined;
function cleanupRoot(): void {
  detachAbort?.();
  detachAbort = undefined;
  if (root === null) return;
  try {
    render(null, root);
  } finally {
    root.remove();
    root = null;
  }
}
afterEach(cleanupRoot);

it('renders the real cold sign-in route after its tracked module import settles', async ({ signal }) => {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/signin');
  const state = createAppState();
  state.reauthRequired.value = true;
  const services: ScreenServices = {
    clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
    random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
    ticker: { every: () => () => undefined },
    session: async () => ({ signIn: async () => undefined, signOut: async () => undefined, expiry: async () => null }),
    outbox: async () => {
      throw new Error('not used');
    },
    closeOutbox: async () => undefined,
  };
  root = document.createElement('div');
  signal.addEventListener('abort', cleanupRoot, { once: true });
  detachAbort = () => signal.removeEventListener('abort', cleanupRoot);
  document.body.append(root);
  render(
    <ServicesProvider value={services}>
      <App state={state} loadMetaOnMount={false} />
    </ServicesProvider>,
    root,
  );
  expect(root.querySelector('form')).toBeNull();
  await vi.dynamicImportSettled();
  await act(async () => undefined);
  expect(root.querySelector('form')).not.toBeNull();
  expect(root.textContent).toContain('Your previous session has ended');
});
