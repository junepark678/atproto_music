import type { Did, NowPlaying } from '@atmusic/core/api-types';
import { render } from 'preact';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { ListeningNow, NowPlayingCard } from '../../src/components/now-playing';

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
type NowPlayingResponse = { nowPlaying: NowPlaying | null; serverTime: string };
function setup(value: typeof response = response, profileDid: Did = did, serverOffsetMs = 0) {
  const nowPlaying = vi.fn(async () => ({
    ...value,
    serverTime: serverOffsetMs === 0 ? value.serverTime : new Date(Date.now() + serverOffsetMs).toISOString(),
  }));
  const api = { nowPlaying } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  const renderProfile = (nextDid: Did, owner = true) =>
    render(<NowPlayingCard api={api} did={nextDid} owner={owner} />, root);
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const feedItem = { did, handle: 'bjork.example', nowPlaying: item };
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

it('ticks elapsed time against the server clock skew and refreshes on visibility', async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const clockItem = { ...item, startedAt: '2026-01-15T11:48:31Z' };
  const app = setup({ nowPlaying: clockItem, serverTime: response.serverTime }, did, 30_000);
  await vi.waitFor(() => expect(app.root.textContent).toContain('for 11 min'));
  expect(app.root.querySelector('time')?.getAttribute('datetime')).toBe(clockItem.startedAt);
  await vi.advanceTimersByTimeAsync(15_000);
  await vi.waitFor(() => expect(app.root.textContent).toContain('for 12 min'));
  await vi.advanceTimersByTimeAsync(45_000);
  await vi.waitFor(() => expect(app.root.textContent).toContain('for 12 min'));
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
  const oldResponse = deferred<typeof response>();
  const nextResponse = deferred<typeof response>();
  const nowPlaying = vi.fn((profileDid: Did) => (profileDid === oldDid ? oldResponse.promise : nextResponse.promise));
  const api = { nowPlaying } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  const renderProfile = (profileDid: Did) => render(<NowPlayingCard api={api} did={profileDid} owner />, root);
  renderProfile(oldDid);
  await vi.waitFor(() => expect(nowPlaying).toHaveBeenCalledWith(oldDid));
  renderProfile(nextDid);
  expect(root.textContent).not.toContain('Old private track');
  await vi.waitFor(() => expect(nowPlaying).toHaveBeenCalledWith(nextDid));
  nextResponse.resolve({ ...response, nowPlaying: { ...item, track: 'New profile track' } });
  await vi.waitFor(() => expect(root.textContent).toContain('New profile track'));
  oldResponse.resolve({ ...response, nowPlaying: { ...item, track: 'Old private track' } });
  await Promise.resolve();
  expect(root.textContent).toContain('New profile track');
  expect(root.textContent).not.toContain('Old private track');
  render(null, root);
  root.remove();
});

it('ignores an older card refresh when a newer visibility refresh returns empty', async () => {
  const older = deferred<NowPlayingResponse>();
  const newer = deferred<NowPlayingResponse>();
  const nowPlaying = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const api = { nowPlaying } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  render(<NowPlayingCard api={api} did={did} owner />, root);
  await vi.waitFor(() => expect(nowPlaying).toHaveBeenCalledTimes(1));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(nowPlaying).toHaveBeenCalledTimes(2));
  newer.resolve({ nowPlaying: null, serverTime: response.serverTime });
  await vi.waitFor(() => expect(root.textContent).toContain('Nothing playing right now'));
  older.resolve({ ...response, nowPlaying: { ...item, track: 'Old stale track' } });
  await Promise.resolve();
  expect(root.textContent).toContain('Nothing playing right now');
  expect(root.textContent).not.toContain('Old stale track');
  render(null, root);
  root.remove();
});

it('clears an owner-only snapshot synchronously and fences its old session response', async () => {
  const staleSessionRefresh = deferred<NowPlayingResponse>();
  const nextSession = deferred<NowPlayingResponse>();
  const nowPlaying = vi
    .fn()
    .mockResolvedValueOnce({
      ...response,
      nowPlaying: { ...item, track: 'Private track' },
    })
    .mockReturnValueOnce(staleSessionRefresh.promise)
    .mockReturnValueOnce(nextSession.promise);
  const api = { nowPlaying } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  const renderCard = (owner: boolean) => render(<NowPlayingCard api={api} did={did} owner={owner} />, root);
  renderCard(true);
  await vi.waitFor(() => expect(root.textContent).toContain('Private track'));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(nowPlaying).toHaveBeenCalledTimes(2));
  renderCard(false);
  expect(root.textContent).not.toContain('Private track');
  await vi.waitFor(() => expect(nowPlaying).toHaveBeenCalledTimes(3));
  staleSessionRefresh.resolve({ ...response, nowPlaying: { ...item, track: 'Late private track' } });
  await Promise.resolve();
  expect(root.textContent).not.toContain('Late private track');
  nextSession.resolve({ nowPlaying: null, serverTime: response.serverTime });
  await Promise.resolve();
  expect(root.textContent).not.toContain('Late private track');
  render(null, root);
  root.remove();
});

it('keeps the newer empty listening feed when an older request completes later', async () => {
  const older = deferred<{ items: (typeof feedItem)[] }>();
  const newer = deferred<{ items: (typeof feedItem)[] }>();
  const nowPlayingFeed = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const api = { nowPlayingFeed } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  render(<ListeningNow api={api} />, root);
  await vi.waitFor(() => expect(nowPlayingFeed).toHaveBeenCalledTimes(1));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(nowPlayingFeed).toHaveBeenCalledTimes(2));
  newer.resolve({ items: [] });
  await Promise.resolve();
  older.resolve({ items: [feedItem] });
  await Promise.resolve();
  expect(root.querySelector('.listening-now')).toBeNull();
  render(null, root);
  root.remove();
});

it('clears listening feed state on API replacement and ignores old API responses', async () => {
  const oldRefresh = deferred<{ items: (typeof feedItem)[] }>();
  const oldApi = {
    nowPlayingFeed: vi
      .fn()
      .mockResolvedValueOnce({ items: [feedItem] })
      .mockReturnValueOnce(oldRefresh.promise),
  };
  const newApi = { nowPlayingFeed: vi.fn().mockRejectedValue(new Error('session unavailable')) };
  const root = document.createElement('div');
  document.body.append(root);
  const renderFeed = (api: ApiClient) => render(<ListeningNow api={api} />, root);
  renderFeed(oldApi as unknown as ApiClient);
  await vi.waitFor(() => expect(root.textContent).toContain('Jóga'));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(oldApi.nowPlayingFeed).toHaveBeenCalledTimes(2));
  renderFeed(newApi as unknown as ApiClient);
  expect(root.querySelector('.listening-now')).toBeNull();
  oldRefresh.resolve({ items: [feedItem] });
  await Promise.resolve();
  await vi.waitFor(() => expect(newApi.nowPlayingFeed).toHaveBeenCalledTimes(1));
  expect(root.querySelector('.listening-now')).toBeNull();
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

it('formats elapsed and track duration labels beyond one hour', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const longTrack = {
    ...item,
    startedAt: '2026-01-15T10:45:00Z',
    durationSeconds: 3700,
  };
  const app = setup({ nowPlaying: longTrack, serverTime: '2026-01-15T12:00:30Z' });
  await vi.waitFor(() => expect(app.root.textContent).toContain('for 1 hr 15 min'));
  expect(app.root.querySelector('progress')?.getAttribute('aria-valuetext')).toBe('1:01:40 / 1:01:40');
  app.cleanup();
});
