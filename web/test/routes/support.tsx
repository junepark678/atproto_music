import type { Did, Meta } from '@atmusic/core/api-types';
import { type ComponentChildren, render } from 'preact';
import { act } from 'preact/test-utils';
import { onTestFinished, vi } from 'vitest';
import { ApiClient } from '../../src/api/client';
import { App } from '../../src/app';
import type { Session } from '../../src/session/client';
import { createAppState } from '../../src/state/store';

const examples = import.meta.glob<unknown>('../../../api/examples/*.json', { eager: true, import: 'default' });
export function example<T>(name: string): T {
  const value = examples[`../../../api/examples/${name}.json`];
  if (value === undefined) throw new Error(`Missing fixture: ${name}`);
  return structuredClone(value) as T;
}
export const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' as Did;
export const SESSION: Session = {
  did: DID,
  handle: 'alice.test',
  username: 'alice',
  csrfToken: 'csrf-token',
  status: 'active',
  expiresAt: '2026-12-01T00:00:00Z',
};
export const META: Meta = {
  name: 'atproto_music',
  version: '0.1.0',
  stage: 'product',
  capabilities: ['read', 'stats', 'follows', 'indexing'],
  lexiconPrefix: 'com.example.atmusic',
  indexing: { state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: 0 },
};
export function mount(
  path: string,
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response | undefined>,
) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`https://music.test${path}`);
  const requests: string[] = [];
  const api = new ApiClient({
    fetch: async (input, init) => {
      const custom = await fetcher?.(input, init);
      if (custom) return custom;
      const url = new URL(String(input), 'https://music.test');
      requests.push(`${url.pathname}${url.search}`);
      const p = url.pathname;
      if (p === '/api/v1/meta') return Response.json(META);
      if (p === '/api/v1/feed' || p.endsWith('/scrobbles')) return Response.json(example('scrobble-page'));
      if (p.endsWith('/profile')) return Response.json(example('profile'));
      if (p.endsWith('/stats')) return Response.json(example('stats'));
      if (p.endsWith('/following') || p.endsWith('/followers')) return Response.json(example('follow-page'));
      if (p.endsWith('/export')) return Response.json(example('export'));
      return Response.json({ error: { code: 'not_found', message: 'not found', requestId: 'test' } }, { status: 404 });
    },
  });
  const state = createAppState({ api });
  const root = document.createElement('div');
  document.body.append(root);
  render(<App state={state} />, root);
  return {
    root,
    state,
    requests,
    cleanup: () => {
      render(null, root);
      root.remove();
    },
  };
}

type OwnedTest = ReturnType<typeof ownTest>;

/** Register test-owned roots and global state before the first render. */
export function ownTest(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Test owner closed', 'AbortError');
  type Root = { element: HTMLElement; mounted: boolean };
  const roots = new Set<Root>();
  const releases = new Set<() => void>();
  const initialUrl = window.location.href;
  const initialFetch = globalThis.fetch;
  const initialWindowFetch = Object.getOwnPropertyDescriptor(window, 'fetch');
  const unexpectedFetches: string[] = [];
  const imageFetches: string[] = [];
  let closed = false;
  const guard = ((input: RequestInfo | URL) => {
    const label = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    unexpectedFetches.push(label);
    return Promise.reject(new Error(`Unexpected global fetch in owned route test: ${label}`));
  }) as typeof fetch;
  vi.stubGlobal('fetch', guard);
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    writable: true,
    value: ((input: RequestInfo | URL) => {
      const label = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      imageFetches.push(label);
      return Promise.reject(new Error(`Unexpected HappyDOM window.fetch in owned route test: ${label}`));
    }) as typeof fetch,
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', cleanup);
    let failure: unknown;
    for (const release of releases) {
      try {
        release();
      } catch (error) {
        failure ??= error;
      }
    }
    releases.clear();
    for (const entry of roots) {
      try {
        if (entry.mounted) render(null, entry.element);
      } catch (error) {
        failure ??= error;
      } finally {
        entry.element.remove();
        entry.mounted = false;
      }
    }
    roots.clear();
    try {
      (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(initialUrl);
      window.history.replaceState(null, '', initialUrl);
    } catch (error) {
      failure ??= error;
    }
    vi.stubGlobal('fetch', initialFetch);
    if (initialWindowFetch) Object.defineProperty(window, 'fetch', initialWindowFetch);
    else Reflect.deleteProperty(window, 'fetch');
    if (unexpectedFetches.length)
      failure ??= new Error(`Unexpected global fetch calls: ${unexpectedFetches.join(', ')}`);
    if (imageFetches.length)
      failure ??= new Error(`Unexpected HappyDOM window.fetch calls: ${imageFetches.join(', ')}`);
    if (failure) throw failure;
  };
  signal.addEventListener('abort', cleanup, { once: true });
  onTestFinished(cleanup);

  return {
    get closed() {
      return closed;
    },
    setUrl(path: string) {
      if (closed) return;
      (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`https://music.test${path}`);
    },
    onCleanup(release: () => void) {
      if (closed) release();
      else releases.add(release);
    },
    registerRoot(element: HTMLElement) {
      if (closed || signal.aborted) {
        return {
          mount(_node: ComponentChildren) {},
          cleanup() {},
        };
      }
      const entry = { element, mounted: false };
      roots.add(entry);
      const unmount = () => {
        if (!roots.delete(entry)) return;
        try {
          if (entry.mounted) render(null, element);
        } finally {
          element.remove();
          entry.mounted = false;
        }
      };
      return {
        mount(node: ComponentChildren) {
          if (closed || signal.aborted) return;
          document.body.append(element);
          entry.mounted = true;
          render(node, element);
        },
        cleanup: unmount,
      };
    },
    requestAllowed() {
      return !closed && !signal.aborted;
    },
    wrapFetch(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
      return async (input: RequestInfo | URL, init?: RequestInit) => {
        if (closed || signal.aborted) throw new DOMException('Test owner closed', 'AbortError');
        const response = await fetcher(input, init);
        if (closed || signal.aborted) throw new DOMException('Test owner closed', 'AbortError');
        return response;
      };
    },
  };
}

export async function settleRouteImport(): Promise<void> {
  await vi.dynamicImportSettled();
  await act(async () => undefined);
}

export function mountOwned(
  owner: OwnedTest,
  path: string,
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response | undefined>,
) {
  owner.setUrl(path);
  const requests: string[] = [];
  const api = new ApiClient({
    fetch: owner.wrapFetch(async (input, init) => {
      if (!owner.requestAllowed()) throw new DOMException('Test owner closed', 'AbortError');
      const custom = await fetcher?.(input, init);
      if (!owner.requestAllowed()) throw new DOMException('Test owner closed', 'AbortError');
      if (custom) return custom;
      const url = new URL(String(input), 'https://music.test');
      requests.push(`${url.pathname}${url.search}`);
      const p = url.pathname;
      if (p === '/api/v1/meta') return Response.json(META);
      if (p === '/api/v1/feed' || p.endsWith('/scrobbles')) return Response.json(example('scrobble-page'));
      if (p.endsWith('/profile')) return Response.json(example('profile'));
      if (p.endsWith('/stats')) return Response.json(example('stats'));
      if (p.endsWith('/following') || p.endsWith('/followers')) return Response.json(example('follow-page'));
      if (p.endsWith('/export')) return Response.json(example('export'));
      return Response.json({ error: { code: 'not_found', message: 'not found', requestId: 'test' } }, { status: 404 });
    }),
  });
  const state = createAppState({ api });
  const root = document.createElement('div');
  const registration = owner.registerRoot(root);
  registration.mount(<App state={state} />);
  return { root, state, requests, cleanup: registration.cleanup };
}
