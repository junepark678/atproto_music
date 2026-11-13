import type { Did, NowPlaying } from '@atmusic/core/api-types';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { ListeningNow, NowPlayingCard } from '../../src/components/now-playing';

const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' as Did;
const recordingMbid = '00000000-0000-4000-8000-000000000001';
const artistMbid = '00000000-0000-4000-8000-000000000002';
const releaseMbid = '00000000-0000-4000-8000-000000000003';
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
async function setup(
  value: typeof response = response,
  profileDid: Did = did,
  serverOffsetMs = 0,
  serverTimeNow = false,
) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const nowPlaying = vi.fn(async () => ({
    ...value,
    serverTime: serverTimeNow
      ? new Date(Date.now() + serverOffsetMs).toISOString()
      : serverOffsetMs === 0
        ? value.serverTime
        : new Date(Date.now() + serverOffsetMs).toISOString(),
  }));
  const api = { nowPlaying } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  const renderProfile = (nextDid: Did, owner = true) =>
    render(<NowPlayingCard api={api} did={nextDid} owner={owner} />, root);
  await act(async () => {
    renderProfile(profileDid);
    await Promise.resolve();
  });
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
  const app = await setup({ nowPlaying: clockItem, serverTime: response.serverTime }, did, 30_000);
  await vi.waitFor(() => expect(app.root.textContent).toContain('for 11 min'));
  expect(app.root.querySelector('time')?.getAttribute('datetime')).toBe(clockItem.startedAt);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
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
  await act(async () => {
    newer.resolve({ nowPlaying: null, serverTime: response.serverTime });
    await newer.promise;
  });
  expect(root.textContent).toContain('Nothing playing right now');
  await act(async () => {
    older.resolve({ ...response, nowPlaying: { ...item, track: 'Old stale track' } });
    await older.promise;
  });
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const older = deferred<{ items: (typeof feedItem)[]; serverTime: string }>();
  const newer = deferred<{ items: (typeof feedItem)[]; serverTime: string }>();
  const nowPlayingFeed = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const api = { nowPlayingFeed } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  render(<ListeningNow api={api} viewer={did} />, root);
  await vi.waitFor(() => expect(nowPlayingFeed).toHaveBeenCalledTimes(1));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(nowPlayingFeed).toHaveBeenCalledTimes(2));
  await act(async () => {
    newer.resolve({ items: [], serverTime: response.serverTime });
    await newer.promise;
  });
  await act(async () => {
    older.resolve({ items: [feedItem], serverTime: response.serverTime });
    await older.promise;
  });
  expect(root.querySelector('.listening-now')).toBeNull();
  render(null, root);
  root.remove();
});

it('clears listening feed state on API replacement and ignores old API responses', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const oldRefresh = deferred<{ items: (typeof feedItem)[]; serverTime: string }>();
  const oldApi = {
    nowPlayingFeed: vi
      .fn()
      .mockResolvedValueOnce({ items: [feedItem], serverTime: response.serverTime })
      .mockReturnValueOnce(oldRefresh.promise),
  };
  const newApi = { nowPlayingFeed: vi.fn().mockRejectedValue(new Error('session unavailable')) };
  const root = document.createElement('div');
  document.body.append(root);
  const renderFeed = (api: ApiClient) => render(<ListeningNow api={api} viewer={did} />, root);
  renderFeed(oldApi as unknown as ApiClient);
  await vi.waitFor(() => expect(root.textContent).toContain('Jóga'));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(oldApi.nowPlayingFeed).toHaveBeenCalledTimes(2));
  renderFeed(newApi as unknown as ApiClient);
  expect(root.querySelector('.listening-now')).toBeNull();
  oldRefresh.resolve({ items: [feedItem], serverTime: response.serverTime });
  await Promise.resolve();
  await vi.waitFor(() => expect(newApi.nowPlayingFeed).toHaveBeenCalledTimes(1));
  expect(root.querySelector('.listening-now')).toBeNull();
  render(null, root);
  root.remove();
});

it('clamps progress, exposes progress values, and displays private sharing without DID text', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:10:00Z'));
  const app = await setup({
    nowPlaying: { ...item, expiresAt: '2026-01-15T12:13:00Z' },
    serverTime: '2026-01-15T12:10:00Z',
  });
  await act(async () => {
    await Promise.resolve();
  });
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
  const app = await setup({
    nowPlaying: {
      ...withoutDuration,
      musicbrainz: {
        recordingMbid,
        title: 'Resolved track title',
        artistCredit: 'Resolved artist',
        artistMbids: [artistMbid],
        matchedBy: 'search',
        syncedAt: '2026-01-15T11:59:00Z',
      },
    },
    serverTime: response.serverTime,
  });
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
  const app = await setup({ nowPlaying: longTrack, serverTime: '2026-01-15T12:00:30Z' });
  await vi.waitFor(() => expect(app.root.textContent).toContain('for 1 hr 15 min'));
  expect(app.root.querySelector('progress')?.getAttribute('aria-valuetext')).toBe('1:01:40 / 1:01:40');
  app.cleanup();
});

it('fills an absent submitted album with a muted MusicBrainz release title', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const { album: _album, ...withoutAlbum } = item;
  const { durationSeconds: _duration, ...withoutDuration } = withoutAlbum;
  const app = await setup({
    nowPlaying: {
      ...withoutDuration,
      musicbrainz: {
        recordingMbid,
        title: 'Resolved track title',
        artistCredit: 'Resolved artist',
        artistMbids: [artistMbid],
        releaseMbid,
        releaseTitle: 'Resolved release title',
        durationSeconds: 225,
        matchedBy: 'search',
        syncedAt: '2026-01-15T11:59:00Z',
      },
    },
    serverTime: response.serverTime,
  });
  await vi.waitFor(() => expect(app.root.textContent).toContain('Resolved release title'));
  expect(app.root.querySelector('[title="From MusicBrainz"]')?.textContent).toContain('Resolved release title');
  expect(app.root.querySelector('.now-playing-track')?.textContent).toContain('Jóga');
  expect(app.root.querySelector('progress')?.max).toBe(225);
  expect(app.root.querySelector('progress')?.getAttribute('aria-valuetext')).toBe('3:45 / 3:45');
  app.cleanup();
});

it('keeps submitted album text ahead of the matched MusicBrainz release title', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const app = await setup({
    nowPlaying: {
      ...item,
      musicbrainz: {
        recordingMbid,
        title: 'Resolved track title',
        artistCredit: 'Resolved artist',
        artistMbids: [artistMbid],
        releaseMbid,
        releaseTitle: 'Resolved release title',
        durationSeconds: 225,
        matchedBy: 'search',
        syncedAt: '2026-01-15T11:59:00Z',
      },
    },
    serverTime: response.serverTime,
  });
  await vi.waitFor(() => expect(app.root.textContent).toContain('Homogenic'));
  expect(app.root.querySelector('.now-playing-byline')?.textContent).toContain('Homogenic');
  expect(app.root.querySelector('.now-playing-byline')?.textContent).not.toContain('Resolved release title');
  expect(app.root.querySelector('[title="From MusicBrainz"]')).toBeNull();
  expect(app.root.querySelector('progress')?.max).toBe(180);
  expect(app.root.querySelector('progress')?.getAttribute('aria-valuetext')).toBe('3:00 / 3:00');
  app.cleanup();
});

it('links current track, artist and release with validated IDs and safe external-link attributes', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const app = await setup({
    nowPlaying: {
      ...item,
      recordingMbid,
      artistMbids: [artistMbid],
      releaseMbid,
    },
    serverTime: response.serverTime,
  });
  await vi.waitFor(() => expect(app.root.querySelectorAll('.now-playing-card a.musicbrainz-link')).toHaveLength(3));
  expect(app.root.querySelector('.now-playing-track a')?.getAttribute('href')).toBe(
    `https://musicbrainz.org/recording/${recordingMbid}`,
  );
  expect(app.root.querySelector('.now-playing-byline a[href*="/artist/"]')?.getAttribute('href')).toBe(
    `https://musicbrainz.org/artist/${artistMbid}`,
  );
  expect(app.root.querySelector('.now-playing-byline a[href*="/release/"]')?.getAttribute('href')).toBe(
    `https://musicbrainz.org/release/${releaseMbid}`,
  );
  for (const link of app.root.querySelectorAll('.now-playing-card a.musicbrainz-link')) {
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.querySelector('.external-link')?.getAttribute('aria-hidden')).toBe('true');
  }
  const trackLink = app.root.querySelector('.now-playing-track a.musicbrainz-link');
  expect(trackLink).not.toBeNull();
  const accessibleName = [...(trackLink?.childNodes ?? [])]
    .filter((node) => !(node instanceof Element && node.getAttribute('aria-hidden') === 'true'))
    .map((node) => node.textContent)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  expect(accessibleName).toBe('Jóga (MusicBrainz)');
  app.cleanup();
});

it('loads matched release art from the same-origin cache endpoint with a decorative lazy image', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const app = await setup({
    nowPlaying: {
      ...item,
      releaseMbid: artistMbid,
      musicbrainz: {
        recordingMbid,
        title: 'Resolved track title',
        artistCredit: 'Resolved artist',
        artistMbids: [artistMbid],
        releaseMbid,
        releaseTitle: 'Resolved release',
        matchedBy: 'search',
        syncedAt: '2026-01-15T11:59:00Z',
      },
    },
    serverTime: response.serverTime,
  });
  const art = await vi.waitFor(() => {
    const image = app.root.querySelector<HTMLImageElement>('.now-playing-cover');
    expect(image).not.toBeNull();
    return image!;
  });
  expect(art.getAttribute('src')).toBe(`/api/v1/cover-art/${releaseMbid}`);
  expect(art.getAttribute('loading')).toBe('lazy');
  expect(art.getAttribute('alt')).toBe('');
  expect(art.getAttribute('src')).not.toMatch(/^https?:/);
  expect(app.root.textContent).not.toContain(did);
  app.cleanup();
});

it('uses a valid submitted release ID when no matched release ID exists', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const app = await setup({ nowPlaying: { ...item, releaseMbid }, serverTime: response.serverTime });
  await vi.waitFor(() =>
    expect(app.root.querySelector('.now-playing-cover')?.getAttribute('src')).toBe(`/api/v1/cover-art/${releaseMbid}`),
  );
  app.cleanup();
});

it('omits cover art when the release ID is missing or invalid', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const app = await setup({ nowPlaying: { ...item, releaseMbid: 'not-a-uuid' }, serverTime: response.serverTime });
  await vi.waitFor(() => expect(app.root.textContent).toContain('Jóga'));
  expect(app.root.querySelector('.now-playing-cover')).toBeNull();
  app.cleanup();
});

it('falls back to the glyph after an image error and resets when the release changes', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  let current = { ...item, releaseMbid };
  const nowPlaying = vi.fn(async () => ({ nowPlaying: current, serverTime: response.serverTime }));
  const api = { nowPlaying } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  render(<NowPlayingCard api={api} did={did} owner />, root);
  const first = await vi.waitFor(() => {
    const image = root.querySelector<HTMLImageElement>('.now-playing-cover');
    expect(image).not.toBeNull();
    return image!;
  });
  await act(async () => {
    first.dispatchEvent(new Event('error'));
  });
  expect(root.querySelector('.now-playing-cover')).toBeNull();
  expect(root.querySelector('.now-playing-art')?.textContent).toContain('♫');

  const nextRelease = recordingMbid;
  current = { ...item, releaseMbid: nextRelease };
  document.dispatchEvent(new Event('visibilitychange'));
  const next = await vi.waitFor(() => {
    const image = root.querySelector<HTMLImageElement>('.now-playing-cover');
    expect(image?.getAttribute('src')).toBe(`/api/v1/cover-art/${nextRelease}`);
    return image!;
  });
  expect(next.getAttribute('alt')).toBe('');
  expect(root.textContent).not.toContain(did);
  render(null, root);
  root.remove();
});

it('drops the listening rail synchronously on viewer change and fences the prior request', async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const oldViewer = did;
  const nextViewer = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Did;
  const oldRead = deferred<{ items: (typeof feedItem)[]; serverTime: string }>();
  const nextRead = deferred<{ items: (typeof feedItem)[]; serverTime: string }>();
  const nowPlayingFeed = vi
    .fn()
    .mockResolvedValueOnce({ items: [feedItem], serverTime: response.serverTime })
    .mockReturnValueOnce(oldRead.promise)
    .mockReturnValueOnce(nextRead.promise);
  const api = { nowPlayingFeed } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  const renderViewer = (viewer: Did) => render(<ListeningNow api={api} viewer={viewer} />, root);
  renderViewer(oldViewer);
  await act(async () => {
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(nowPlayingFeed).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(root.textContent).toContain('Jóga'));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(nowPlayingFeed).toHaveBeenCalledTimes(2));
  renderViewer(nextViewer);
  expect(root.querySelector('.listening-now')).toBeNull();
  await vi.waitFor(() => expect(nowPlayingFeed).toHaveBeenCalledTimes(3));
  oldRead.resolve({ items: [feedItem], serverTime: response.serverTime });
  nextRead.resolve({ items: [], serverTime: response.serverTime });
  await Promise.resolve();
  expect(root.querySelector('.listening-now')).toBeNull();
  render(null, root);
  root.remove();
});

it('expires a profile at the next existing elapsed tick and treats equality as expired', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:02:45Z'));
  const app = await setup({ nowPlaying: item, serverTime: '2026-01-15T12:02:45Z' }, did, 0, true);
  await vi.waitFor(() => expect(app.root.querySelector('.now-playing-card')).not.toBeNull());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(app.root.querySelector('.now-playing-card')).toBeNull();
  expect(app.root.textContent).toContain('Nothing playing right now');
  app.cleanup();

  vi.setSystemTime(new Date('2026-01-15T12:03:00Z'));
  const equal = await setup({ nowPlaying: item, serverTime: '2026-01-15T12:03:00Z' });
  await vi.waitFor(() => expect(equal.root.textContent).toContain('Nothing playing right now'));
  expect(equal.root.querySelector('.now-playing-card')).toBeNull();
  equal.cleanup();
});

it('uses server skew on both sides of client time at the expiry boundary', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:02:30Z'));
  const ahead = await setup({ nowPlaying: item, serverTime: response.serverTime }, did, 30_000);
  expect(ahead.root.querySelector('.now-playing-card')).toBeNull();
  expect(ahead.root.textContent).toContain('Nothing playing right now');
  ahead.cleanup();

  vi.setSystemTime(new Date('2026-01-15T12:03:30Z'));
  const behind = await setup({ nowPlaying: item, serverTime: response.serverTime }, did, -30_000);
  expect(behind.root.querySelector('.now-playing-card')).toBeNull();
  expect(behind.root.textContent).toContain('Nothing playing right now');
  behind.cleanup();

  vi.setSystemTime(new Date('2026-01-15T12:02:59.999Z'));
  const before = await setup({ nowPlaying: item, serverTime: response.serverTime }, did, 0, true);
  expect(before.root.querySelector('.now-playing-card')).not.toBeNull();
  before.cleanup();
});

it('expires rail entries at successive skew-corrected deadlines without renewing on poll failure', async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const first = { ...item, track: 'First expires', expiresAt: '2026-01-15T12:01:00Z' };
  const second = { ...item, track: 'Second expires', expiresAt: '2026-01-15T12:02:00Z' };
  const nowPlayingFeed = vi
    .fn()
    .mockResolvedValueOnce({
      items: [
        { ...feedItem, nowPlaying: first },
        { ...feedItem, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Did, handle: 'second.example', nowPlaying: second },
      ],
      serverTime: '2026-01-15T12:00:00Z',
    })
    .mockRejectedValue(new Error('temporary read failure'));
  const api = { nowPlayingFeed } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  render(<ListeningNow api={api} viewer={did} />, root);
  await vi.waitFor(() => expect(root.textContent).toContain('First expires'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(root.textContent).not.toContain('First expires');
  expect(root.textContent).toContain('Second expires');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(root.querySelector('.listening-now')).toBeNull();
  expect(nowPlayingFeed).toHaveBeenCalledTimes(5);
  render(null, root);
  root.remove();
});

it('keeps expired rail entries discarded after a backward clock adjustment and failed refresh', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const nowPlayingFeed = vi
    .fn()
    .mockResolvedValueOnce({
      items: [{ ...feedItem, nowPlaying: { ...item, expiresAt: '2026-01-15T12:00:01.001Z' } }],
      serverTime: response.serverTime,
    })
    .mockRejectedValue(new Error('temporary read failure'));
  const api = { nowPlayingFeed } as unknown as ApiClient;
  const root = document.createElement('div');
  document.body.append(root);
  try {
    await act(async () => {
      render(<ListeningNow api={api} viewer={did} />, root);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(root.textContent).toContain('Jóga'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(root.querySelector('.listening-now')).toBeNull();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(nowPlayingFeed).toHaveBeenCalledTimes(2);
    expect(root.querySelector('.listening-now')).toBeNull();
    expect(root.textContent).not.toContain('did:');
  } finally {
    await act(async () => render(null, root));
    root.remove();
  }
});

it('keeps an expired profile empty after a backward clock adjustment and failed refresh', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  const app = await setup({
    nowPlaying: { ...item, expiresAt: '2026-01-15T12:00:01.001Z' },
    serverTime: response.serverTime,
  });
  try {
    expect(app.root.querySelector('.now-playing-card')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(app.root.querySelector('.now-playing-card')).toBeNull();
    app.nowPlaying.mockRejectedValue(new Error('temporary read failure'));
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(app.root.querySelector('.now-playing-card')).toBeNull();
    expect(app.root.textContent).toContain('Nothing playing right now');
    expect(app.root.textContent).not.toContain('did:');
  } finally {
    await act(async () => app.cleanup());
  }
});
