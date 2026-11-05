import { expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ now: 1000, stepCalls: 0 }));

vi.mock('@atmusic/core/deps', () => ({ systemClock: {} }));
vi.mock('@atmusic/atproto/identity/resolver', () => ({
  createIdentityResolver: () => ({
    resolveDid: async () => ({ pds: 'https://pds.test', signingKey: {} }),
  }),
}));
vi.mock('@atmusic/atproto/net/safe-fetch', () => ({
  createSafeFetch: () => async () => ({ body: new Uint8Array() }),
}));
vi.mock('@atmusic/atproto/snapshot/block-source', () => ({
  MemoryBlockCache: class {
    get() {
      return new Uint8Array();
    }
  },
  cacheOnlySource: () => ({}),
}));
vi.mock('@atmusic/atproto/snapshot/getrepo-source', () => ({
  streamRepoIntoCache: async () => ({ root: 'bafyroot' }),
}));
vi.mock('@atmusic/atproto/snapshot/walker', () => ({
  initialState: () => ({}),
  step: async () => {
    state.stepCalls += 1;
    state.now = 1500;
    return { entries: [], state: {}, done: state.stepCalls > 1 };
  },
}));
vi.mock('@atmusic/atproto/verify/commit', () => ({
  verifyCommit: async () => ({ rev: '3', cid: 'bafyroot' }),
}));

import { verifyAbsentBySnapshot } from '../live/live-gate.ts';

test('snapshot proof checks its cooperative deadline after each awaited walk step', async () => {
  state.now = 1000;
  state.stepCalls = 0;
  const assertActive = () => {
    if (state.now >= 1400) throw new Error('OAuth live phase deadline exceeded');
  };

  await expect(
    verifyAbsentBySnapshot('did:plc:abcdefghijklmnopqrstuvwx', 'org.atproto.music.scrobble', 'key', {
      assertActive,
      timer: { timeout: () => AbortSignal.timeout(10_000) },
    }),
  ).rejects.toThrow('OAuth live phase deadline exceeded');
  // A second successful-looking iteration would otherwise have completed at
  // 1500 and allowed a late snapshot to be treated as verified absence.
  expect(state.stepCalls).toBe(1);
});
