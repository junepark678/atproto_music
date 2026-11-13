import { describe, expect, it, vi } from 'vitest';
import { mountOwned, ownTest, settleRouteImport } from './support';

const initialUrl = window.location.href;
const initialFetch = globalThis.fetch;

const gate = vi.hoisted(() => {
  let release!: () => void;
  let announceEntry!: () => void;
  let entered = false;
  const promise = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (announceEntry = resolve));
  return {
    promise,
    release,
    started,
    markEntered() {
      entered = true;
      announceEntry();
    },
    get entered() {
      return entered;
    },
  };
});
const control = import.meta.env.VITE_ROUTE_IMPORT_CONTROL ?? 'normal';

// This leaf is imported only when the real glob-loaded feed route is evaluated.
vi.mock('../../src/components/scrobble-list', async (importOriginal) => {
  gate.markEntered();
  await gate.promise;
  if (control === 'failed-chunk') throw new Error('controlled lazy route failure');
  const original = await importOriginal<typeof import('../../src/components/scrobble-list')>();
  return control === 'broken-list' ? { ...original, ScrobbleList: () => <p>controlled broken list</p> } : original;
});

describe('real cold feed route readiness', () => {
  it('refuses an already-aborted owner before touching the next test globals', () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = globalThis.fetch;
    const windowFetch = Object.getOwnPropertyDescriptor(window, 'fetch');
    const url = window.location.href;
    let failure: unknown;
    try {
      ownTest(controller.signal);
    } catch (error) {
      failure = error;
    }
    expect(globalThis.fetch).toBe(fetch);
    expect(Object.getOwnPropertyDescriptor(window, 'fetch')).toEqual(windowFetch);
    expect(window.location.href).toBe(url);
    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe('AbortError');
  });

  it.each(['before', 'after'] as const)('closes an owner aborted %s the global setup mutation', (when) => {
    const controller = new AbortController();
    const fetch = globalThis.fetch;
    const windowFetch = Object.getOwnPropertyDescriptor(window, 'fetch');
    const url = window.location.href;
    const stub = vi.stubGlobal.bind(vi);
    const spy = vi.spyOn(vi, 'stubGlobal').mockImplementation((name, value) => {
      if (when === 'before') controller.abort();
      const result = stub(name, value);
      if (when === 'after') controller.abort();
      return result;
    });
    try {
      const owner = ownTest(controller.signal);
      expect(owner.closed).toBe(true);
      expect(globalThis.fetch).toBe(fetch);
      expect(Object.getOwnPropertyDescriptor(window, 'fetch')).toEqual(windowFetch);
      owner.setUrl('/must-not-change');
      expect(window.location.href).toBe(url);
    } finally {
      spy.mockRestore();
      controller.abort();
    }
  });

  it('restores globals if the explicit window descriptor installation fails', () => {
    const controller = new AbortController();
    const fetch = globalThis.fetch;
    const windowFetch = Object.getOwnPropertyDescriptor(window, 'fetch');
    const define = Object.defineProperty;
    const failure = new Error('controlled window descriptor setup failure');
    let fetchDefinitions = 0;
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, descriptor) => {
      if (target === window && key === 'fetch' && ++fetchDefinitions === 2) throw failure;
      return define(target, key, descriptor);
    });
    try {
      expect(() => ownTest(controller.signal)).toThrow(failure);
      expect(globalThis.fetch).toBe(fetch);
      expect(Object.getOwnPropertyDescriptor(window, 'fetch')).toEqual(windowFetch);
    } finally {
      spy.mockRestore();
      controller.abort();
    }
    // Failed setup must also release exclusivity for a later valid owner.
    const next = new AbortController();
    expect(ownTest(next.signal).closed).toBe(false);
    next.abort();
  });

  it('refuses overlapping owners before mutation and allows a new owner after close', () => {
    const first = new AbortController();
    const second = new AbortController();
    const owner = ownTest(first.signal);
    owner.setUrl('/first-owner');
    const fetch = globalThis.fetch;
    const windowFetch = Object.getOwnPropertyDescriptor(window, 'fetch');
    try {
      expect(() => ownTest(second.signal)).toThrow('A route test owner is already active');
      expect(globalThis.fetch).toBe(fetch);
      expect(Object.getOwnPropertyDescriptor(window, 'fetch')).toEqual(windowFetch);
      expect(window.location.pathname).toBe('/first-owner');
    } finally {
      first.abort();
    }
    const next = ownTest(second.signal);
    next.setUrl('/second-owner');
    const nextFetch = globalThis.fetch;
    first.abort();
    expect(globalThis.fetch).toBe(nextFetch);
    expect(window.location.pathname).toBe('/second-owner');
    second.abort();
  });

  it('holds the real lazy route, then verifies cold and warm route behavior', async ({ signal }) => {
    const owner = ownTest(signal);
    owner.onCleanup(gate.release);
    const app = mountOwned(owner, '/feed');
    let settled = false;
    const readiness = settleRouteImport().then(() => {
      settled = true;
    });

    await gate.started;
    expect(gate.entered).toBe(true);
    await expect(
      vi.waitFor(() => expect(app.root.querySelector('ol.scrobble-list')).not.toBeNull(), { timeout: 25, interval: 5 }),
    ).rejects.toThrow();
    expect(app.root.querySelector('ol.scrobble-list')).toBeNull();
    expect(settled).toBe(false);

    if (control === 'stuck') await new Promise<void>(() => {});
    gate.release();
    await readiness;
    if (control === 'failed-chunk') expect(app.root.textContent).toContain('This screen could not be loaded');
    if (control !== 'failed-chunk') await vi.waitFor(() => expect(app.requests).toContain('/api/v1/feed?scope=global'));
    if (control === 'broken-list')
      await vi.waitFor(() => expect(app.root.textContent).toContain('controlled broken list'));
    await vi.waitFor(() => expect(app.root.querySelector('ol.scrobble-list')).not.toBeNull());
    expect(app.root.textContent).toContain('Jóga');
    expect(app.requests).toContain('/api/v1/feed?scope=global');
    if (control === 'assertion-throw') expect('forced cleanup control').toBe('pass');
    app.cleanup();

    const warm = mountOwned(owner, '/feed');
    let warmSettled = false;
    await settleRouteImport().then(() => {
      warmSettled = true;
    });
    expect(warmSettled).toBe(true);
    await vi.waitFor(() => expect(warm.root.querySelector('ol.scrobble-list')).not.toBeNull());
    expect(warm.root.textContent).toContain('Jóga');
    expect(warm.requests).toContain('/api/v1/feed?scope=global');
    warm.cleanup();
  });

  it('leaves no late route work or owned global state after the physical test', async () => {
    await vi.dynamicImportSettled();
    expect(document.querySelector('.site-header')).toBeNull();
    expect(window.location.href).toBe(initialUrl);
    expect(globalThis.fetch).toBe(initialFetch);
  });
});
