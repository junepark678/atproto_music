import type { Did, NowPlaying } from '@atmusic/core/api-types';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ApiClient } from '../api/client';
import { formatLocalClock } from './format';

type Snapshot = { nowPlaying: NowPlaying | null; serverTime: string; skew: number };
const durationLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const elapsedLabel = (seconds: number) => (seconds < 60 ? `${seconds} sec` : `${Math.floor(seconds / 60)} min`);

export function NowPlayingCard({ api, did, owner }: { api: ApiClient; did: Did; owner: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await api.nowPlaying(did);
      setSnapshot({ ...response, skew: Date.parse(response.serverTime) - Date.now() });
      setError(false);
    } catch {
      setError(true);
    }
  }, [api, did]);
  useEffect(() => {
    if (document.visibilityState === 'visible') void refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now());
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now());
        void refresh();
      }
    }, 30_000);
    const ticker = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(interval);
      clearInterval(ticker);
    };
  }, [refresh]);
  if (snapshot === null)
    return owner ? (
      <p class="now-playing-empty" aria-live="polite">
        {error ? 'Now playing is unavailable.' : 'Loading now playing…'}
      </p>
    ) : null;
  const item = snapshot.nowPlaying;
  if (item === null) return owner ? <p class="now-playing-empty">Nothing playing right now</p> : null;
  const started = Date.parse(item.startedAt);
  const elapsed = Math.max(0, Math.floor((now + snapshot.skew - started) / 1000));
  const duration = item.durationSeconds;
  const progress = duration === undefined ? null : Math.min(duration, elapsed);
  return (
    <article class="now-playing-card" aria-label="Now playing">
      <div class="now-playing-art" aria-hidden="true">
        ♫
      </div>
      <div class="now-playing-content">
        <p class="now-playing-overline">
          <span class="equalizer" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>{' '}
          Now playing
        </p>
        <strong class="now-playing-track">{item.track}</strong>
        <p class="now-playing-byline">
          {item.artist}
          {item.album ? ` — ${item.album}` : ''}
        </p>
        <p class="now-playing-meta">
          <span>
            Playing since <time dateTime={item.startedAt}>{formatLocalClock(item.startedAt)}</time>
          </span>
          <span>· for {elapsedLabel(elapsed)}</span>
          {item.client ? (
            <span>
              · via {item.client.name}
              {item.client.version ? ` ${item.client.version}` : ''}
              {item.musicService ? ` · ${item.musicService}` : ''}
            </span>
          ) : item.musicService ? (
            <span>· via {item.musicService}</span>
          ) : null}
          {item.scrobbledAt ? <span class="scrobbled-chip">Scrobbled</span> : null}
        </p>
        {progress !== null && duration !== undefined ? (
          <div class="now-playing-progress">
            <span>
              {durationLabel(progress)} / {durationLabel(duration)}
            </span>
            <progress
              aria-label="Track progress"
              aria-valuetext={`${durationLabel(progress)} / ${durationLabel(duration)}`}
              value={progress}
              max={duration}
            />
          </div>
        ) : null}
        {owner && item.shared === false ? (
          <p class="private-now-playing">
            <span>Only you can see this</span> · <a href="/settings">Settings</a>
          </p>
        ) : null}
      </div>
    </article>
  );
}

export function ListeningNow({ api }: { api: ApiClient }) {
  const [items, setItems] = useState<Array<{ did: Did; handle: string | null; nowPlaying: NowPlaying }>>([]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void api.nowPlayingFeed().then(
        (result) => {
          if (active) setItems(result.items);
        },
        () => {},
      );
    };
    refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(timer);
    };
  }, [api]);
  if (items.length === 0) return null;
  return (
    <aside class="listening-now" aria-labelledby="listening-now-title">
      <h2 id="listening-now-title">Listening now</h2>
      <ul>
        {items.map(({ did, handle, nowPlaying }) => (
          <li key={did}>
            <a href={`/u/${encodeURIComponent(did)}`}>{handle ? `@${handle}` : 'this account'}</a>
            <span>
              {nowPlaying.track} — {nowPlaying.artist}
            </span>
            <small>since {formatLocalClock(nowPlaying.startedAt)}</small>
          </li>
        ))}
      </ul>
    </aside>
  );
}
