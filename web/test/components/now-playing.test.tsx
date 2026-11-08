import type { Did, NowPlaying } from '@atmusic/core/api-types';
import { render } from 'preact';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { NowPlayingCard } from '../../src/components/now-playing';

const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' as Did;
const item: NowPlaying = {
  artist: 'Björk',
  track: 'Jóga',
  album: 'Homogenic',
  startedAt: '2026-01-15T11:48:00Z',
  updatedAt: '2026-01-15T11:58:00Z',
  expiresAt: '2026-01-15T12:03:00Z',
  durationSeconds: 180,
  source: 'web',
  client: { name: 'Web Scrobbler', version: '3.1' },
  musicService: 'Spotify',
  shared: false,
};
const response = { nowPlaying: item, serverTime: '2026-01-15T12:00:00Z' };
function setup(value: typeof response = response) {
  const nowPlaying = vi.fn(async () => ({ ...value, serverTime: new Date().toISOString() }));
  const api = { nowPlaying } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  render(<NowPlayingCard api={api} did={did} owner />, root);
  return {
    root,
    nowPlaying,
    cleanup: () => {
      render(null, root);
      root.remove();
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

it('ticks elapsed time against the server clock skew and refreshes on visibility', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const app = setup();
  await vi.waitFor(() => expect(app.root.textContent).toContain('for 11 min'));
  expect(app.root.querySelector('time')?.getAttribute('datetime')).toBe(item.startedAt);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(app.root.textContent).toContain('for 12 min');
  await vi.advanceTimersByTimeAsync(45_000);
  expect(app.root.textContent).toContain('for 13 min');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  const calls = app.nowPlaying.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(app.nowPlaying).toHaveBeenCalledTimes(calls);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(app.nowPlaying.mock.calls.length).toBe(calls + 1));
  app.cleanup();
});

it('clamps progress, exposes progress values, and displays private sharing without DID text', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:10:00Z'));
  const app = setup({ ...response, serverTime: '2026-01-15T12:10:00Z' });
  await vi.waitFor(() => expect(app.root.querySelector('progress')).not.toBeNull());
  const bar = app.root.querySelector('progress')!;
  expect(bar.value).toBe(180);
  expect(bar.max).toBe(180);
  expect(bar.getAttribute('aria-valuetext')).toBe('3:00 / 3:00');
  expect(app.root.textContent).toContain('Only you can see this');
  expect(app.root.textContent).not.toContain(did);
  app.cleanup();
});

it('omits progress when duration is unknown', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const { durationSeconds: _durationSeconds, ...withoutDuration } = item;
  const app = setup({ nowPlaying: withoutDuration, serverTime: response.serverTime });
  await vi.waitFor(() => expect(app.root.textContent).toContain('Jóga'));
  expect(app.root.querySelector('[role="progressbar"]')).toBeNull();
  app.cleanup();
});
