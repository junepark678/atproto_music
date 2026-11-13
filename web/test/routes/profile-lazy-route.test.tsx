import { describe, expect, it, vi } from 'vitest';
import { DID, mountOwned, ownTest, settleRouteImport } from './support';

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

vi.mock('../../src/components/stats-panel', async (importOriginal) => {
  gate.markEntered();
  await gate.promise;
  return importOriginal<typeof import('../../src/components/stats-panel')>();
});

describe('real cold profile route readiness', () => {
  it('holds the real lazy route, then verifies cold and warm route behavior', async ({ signal }) => {
    const owner = ownTest(signal);
    owner.onCleanup(gate.release);
    const app = mountOwned(owner, `/u/${DID}`);
    let settled = false;
    const readiness = settleRouteImport().then(() => {
      settled = true;
    });

    await gate.started;
    expect(gate.entered).toBe(true);
    await expect(
      vi.waitFor(() => expect(app.root.querySelector('.profile-header')).not.toBeNull(), { timeout: 25, interval: 5 }),
    ).rejects.toThrow();
    expect(app.root.querySelector('.profile-header')).toBeNull();
    expect(settled).toBe(false);

    gate.release();
    await readiness;
    await vi.waitFor(() => expect(app.root.querySelector('.profile-header')).not.toBeNull());
    expect(app.requests).toContain(`/api/v1/users/${DID}/profile`);
    app.cleanup();

    const warm = mountOwned(owner, `/u/${DID}`);
    let warmSettled = false;
    await settleRouteImport().then(() => {
      warmSettled = true;
    });
    expect(warmSettled).toBe(true);
    await vi.waitFor(() => expect(warm.root.querySelector('.profile-header')).not.toBeNull());
    expect(warm.requests).toContain(`/api/v1/users/${DID}/profile`);
    warm.cleanup();
  });

  it('leaves no late route work or owned global state after the physical test', async () => {
    await vi.dynamicImportSettled();
    expect(document.querySelector('.site-header')).toBeNull();
    expect(window.location.href).toBe(initialUrl);
    expect(globalThis.fetch).toBe(initialFetch);
  });
});
