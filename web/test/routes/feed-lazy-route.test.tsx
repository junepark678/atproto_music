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
