import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app';
import { createDefaultServices, type ScreenServices, ServicesProvider } from '../../src/components/services';
import type { Session } from '../../src/session/client';
import { createAppState, setSession } from '../../src/state/store';

function services(
  signIn: (handle: string) => Promise<void>,
  reauthenticate?: (handle: string) => Promise<void>,
): ScreenServices {
  return {
    clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
    random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
    ticker: { every: () => () => undefined },
    session: async () => ({ signIn, signOut: async () => undefined, expiry: async () => null }),
    reauthenticate,
    outbox: async () => {
      throw new Error('not used');
    },
    closeOutbox: async () => undefined,
  };
}

const roots = new Map<HTMLElement, () => void>();
function appRoot(signal: AbortSignal): HTMLDivElement {
  const root = document.createElement('div');
  const onAbort = () => cleanupRoot(root);
  roots.set(root, () => signal.removeEventListener('abort', onAbort));
  signal.addEventListener('abort', onAbort, { once: true });
  document.body.append(root);
  return root;
}
function cleanupRoot(root: HTMLElement): void {
  const detachAbort = roots.get(root);
  if (detachAbort === undefined) return;
  roots.delete(root);
  detachAbort();
  try {
    render(null, root);
  } finally {
    root.remove();
  }
}
afterEach(() => {
  for (const root of roots.keys()) cleanupRoot(root);
});

async function settleRouteImport(): Promise<void> {
  // AppRouter loads the screen through import.meta.glob and preact-iso's lazy().
  // Wait for Vite's tracked dynamic import, then let Preact commit its render.
  await vi.dynamicImportSettled();
  await act(async () => undefined);
}

describe('web/test/routes/signin.test.tsx', () => {
  it('reauthenticates in a separate window so the signed-out tab can keep its in-memory draft', async ({ signal }) => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/signin');
    const signIn = vi.fn(async () => undefined);
    const reauthenticate = vi.fn(async () => undefined);
    const state = createAppState();
    state.reauthRequired.value = true;
    const root = appRoot(signal);
    render(
      <ServicesProvider value={services(signIn, reauthenticate)}>
        <App state={state} loadMetaOnMount={false} />
      </ServicesProvider>,
      root,
    );
    try {
      // The behavioral cases also work when a previous case has warmed this route.
      await settleRouteImport();
      expect(root.querySelector('form')).not.toBeNull();
      expect(root.textContent).toContain('Your previous session has ended');
      const input = root.querySelector<HTMLInputElement>('[name="handle"]')!;
      input.value = 'alice.test';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(reauthenticate).toHaveBeenCalledWith('alice.test'));
      expect(signIn).not.toHaveBeenCalled();
      expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
      window.dispatchEvent(new Event('focus'));
      await vi.waitFor(() =>
        expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
      );
    } finally {
      cleanupRoot(root);
    }
  });

  it('keeps the sign-in retry form visible for a reauth_required server session', async ({ signal }) => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/signin');
    const reauthenticate = vi.fn(async () => undefined);
    const state = createAppState();
    setSession(
      state,
      {
        did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
        handle: null,
        username: 'alice',
        csrfToken: 'csrf-123',
        status: 'reauth_required',
        expiresAt: '2026-12-01T00:00:00Z',
      } satisfies Session,
      null,
      { reauthRequired: true },
    );
    const root = appRoot(signal);
    render(
      <ServicesProvider
        value={services(
          vi.fn(async () => undefined),
          reauthenticate,
        )}
      >
        <App state={state} loadMetaOnMount={false} />
      </ServicesProvider>,
      root,
    );
    try {
      await settleRouteImport();
      expect(root.querySelector('form')).not.toBeNull();
      expect(root.textContent).toContain('Your previous session has ended');
      expect(root.textContent).not.toContain('You are signed in as');
      root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(reauthenticate).toHaveBeenCalled());
    } finally {
      cleanupRoot(root);
    }
  });

  it('opens the reauthentication popup synchronously before requesting the authorize URL', async () => {
    const replace = vi.fn();
    const close = vi.fn();
    const popup = {
      location: { replace },
      sessionStorage: { setItem: vi.fn() },
      close,
    } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    let finishFetch!: (response: Response) => void;
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          finishFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);

    const result = createDefaultServices().reauthenticate!('alice.test');
    expect(open).toHaveBeenCalledWith('about:blank', '_blank', 'popup,width=520,height=720');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/auth/start');
    finishFetch(Response.json({ authorizeUrl: 'https://issuer.test/authorize?request_uri=opaque' }));
    await result;
    expect(replace).toHaveBeenCalledWith('https://issuer.test/authorize?request_uri=opaque');
    expect(popup.sessionStorage.setItem).toHaveBeenCalledWith('atmusic:reauth-popup', '1');
  });

  it('shows fixed recovery text for callback errors and never renders a code or token', async ({ signal }) => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
      'https://music.test/signin?error=denied&code=secret-code&token=secret-token',
    );
    const state = createAppState();
    const root = appRoot(signal);
    render(
      <ServicesProvider value={services(async () => undefined)}>
        <App state={state} loadMetaOnMount={false} />
      </ServicesProvider>,
      root,
    );
    try {
      await settleRouteImport();
      expect(root.textContent).toContain('Authorization was cancelled');
      expect(root.textContent).not.toContain('secret-code');
      expect(root.textContent).not.toContain('secret-token');
      expect(root.querySelector('button')?.textContent).toBe('Try again');
    } finally {
      cleanupRoot(root);
    }
  });
});
