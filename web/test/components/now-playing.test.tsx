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
function setup(value: typeof response = response, profileDid: Did = did) {
  const nowPlaying = vi.fn(async () => ({ ...value, serverTime: new Date().toISOString() }));
  const api = { nowPlaying } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  const renderProfile = (nextDid: Did) => render(<NowPlayingCard api={api} did={nextDid} owner />, root);
  renderProfile(profileDid);
  return {
    root,
    nowPlaying,
    renderProfile,
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
  const elapsedBeforeHidden = app.root.querySelector('.now-playing-meta')?.textContent;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(app.nowPlaying).toHaveBeenCalledTimes(calls);
  expect(app.root.querySelector('.now-playing-meta')?.textContent).toBe(elapsedBeforeHidden);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(app.nowPlaying.mock.calls.length).toBe(calls + 1));
  app.cleanup();
});

it('drops the previous profile immediately and ignores its deferred response after switching DID', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const oldDid = did;
  const nextDid = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Did;
  let resolveOld!: (value: typeof response) => void;
  let resolveNext!: (value: typeof response) => void;
  const oldResponse = new Promise<typeof response>((resolve) => (resolveOld = resolve));
  const nextResponse = new Promise<typeof response>((resolve) => (resolveNext = resolve));
  const nowPlaying = vi.fn((profileDid: Did) => (profileDid === oldDid ? oldResponse : nextResponse));
  const api = { nowPlaying } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  const renderProfile = (profileDid: Did) => render(<NowPlayingCard api={api} did={profileDid} owner />, root);
  renderProfile(oldDid);
  await vi.waitFor(() => expect(nowPlaying).toHaveBeenCalledWith(oldDid));
  resolveOld({ ...response, nowPlaying: { ...item, track: 'Old private track' } });
  await vi.waitFor(() => expect(root.textContent).toContain('Old private track'));

  renderProfile(nextDid);
  expect(root.textContent).not.toContain('Old private track');
  await vi.waitFor(() => expect(nowPlaying).toHaveBeenCalledWith(nextDid));
  resolveNext({ ...response, nowPlaying: { ...item, track: 'New profile track' } });
  await vi.waitFor(() => expect(root.textContent).toContain('New profile track'));
  expect(root.textContent).not.toContain('Old private track');
  render(null, root);
  root.remove();
});

it('clamps progress, exposes progress values, and displays private sharing without DID text', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:10:00Z'));
  const app = setup({ ...response, serverTime: '2026-01-15T12:10:00Z' });
  await vi.waitFor(() => expect(app.root.querySelector('progress')).not.toBeNull());
  const bar = app.root.querySelector('progress')!;
  expect(bar.value).toBe(180);
  expect(bar.max).toBe(180);
  expect(bar.getAttribute('role')).toBe('progressbar');
  expect(bar.getAttribute('aria-valuenow')).toBe('180');
  expect(bar.getAttribute('aria-valuemax')).toBe('180');
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
