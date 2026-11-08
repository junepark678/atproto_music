import type { Did, NowPlaying } from '@atmusic/core/api-types';
import { useEffect, useState } from 'preact/hooks';
import type { ApiClient } from '../api/client';
import { formatLocalClock } from './format';
import { isMbid, MusicBrainzLink, unambiguousMbid } from './musicbrainz-links';

type Snapshot = {
  api: ApiClient;
  did: Did;
  owner: boolean;
  nowPlaying: NowPlaying | null;
  serverTime: string;
  skew: number;
};
const durationLabel = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
};
const elapsedLabel = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
  return seconds < 60 ? `${seconds} sec` : `${minutes} min`;
};

export function NowPlayingCard({ api, did, owner }: { api: ApiClient; did: Did; owner: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    let requestSequence = 0;
    let ticker: number | undefined;
    setSnapshot(null);
    setError(false);
    const refresh = async () => {
      const sequence = ++requestSequence;
      try {
        const response = await api.nowPlaying(did);
        if (!active || sequence !== requestSequence) return;
        setSnapshot({ api, did, owner, ...response, skew: Date.parse(response.serverTime) - Date.now() });
        setError(false);
      } catch {
        if (active && sequence === requestSequence) setError(true);
      }
    };
    const syncTicker = () => {
      if (document.visibilityState === 'visible') {
        if (ticker === undefined) ticker = window.setInterval(() => setNow(Date.now()), 15_000);
      } else if (ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
    };
    if (document.visibilityState === 'visible') void refresh();
    syncTicker();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now());
        void refresh();
      }
      syncTicker();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now());
        void refresh();
      }
    }, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(interval);
      if (ticker !== undefined) clearInterval(ticker);
      active = false;
    };
  }, [api, did, owner]);
  const currentSnapshot = snapshot?.api === api && snapshot.did === did && snapshot.owner === owner ? snapshot : null;
  if (currentSnapshot === null)
    return owner ? (
      <p class="now-playing-empty" aria-live="polite">
        {error ? 'Now playing is unavailable.' : 'Loading now playing…'}
      </p>
    ) : null;
  const item = currentSnapshot.nowPlaying;
  if (item === null) return owner ? <p class="now-playing-empty">Nothing playing right now</p> : null;
  const started = Date.parse(item.startedAt);
  const elapsed = Math.max(0, Math.floor((now + currentSnapshot.skew - started) / 1000));
  const duration = item.durationSeconds;
  const progress = duration === undefined ? null : Math.min(duration, elapsed);
  const album = item.album ?? item.musicbrainz?.releaseTitle;
  const artistMbid = unambiguousMbid(item.artistMbids) ?? unambiguousMbid(item.musicbrainz?.artistMbids);
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
        <strong class="now-playing-track">
          <MusicBrainzLink
            kind="recording"
            mbid={isMbid(item.recordingMbid) ? item.recordingMbid : item.musicbrainz?.recordingMbid}
          >
            {item.track}
          </MusicBrainzLink>
        </strong>
        <p class="now-playing-byline">
          <MusicBrainzLink kind="artist" mbid={artistMbid}>
            {item.artist}
          </MusicBrainzLink>
          {album !== undefined ? (
            <>
              {' — '}
              {item.album !== undefined ? (
                <MusicBrainzLink
                  kind="release"
                  mbid={isMbid(item.releaseMbid) ? item.releaseMbid : item.musicbrainz?.releaseMbid}
                >
                  {item.album}
                </MusicBrainzLink>
              ) : (
                <span class="album-muted" title="From MusicBrainz">
                  <MusicBrainzLink kind="release" mbid={item.musicbrainz?.releaseMbid}>
                    {item.musicbrainz?.releaseTitle}
                  </MusicBrainzLink>
                </span>
              )}
            </>
          ) : null}
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
              // biome-ignore lint/a11y/noRedundantRoles: the progressbar role is explicit in the accessibility contract
              role="progressbar"
              aria-label="Track progress"
              aria-valuenow={progress}
              aria-valuemax={duration}
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
  const [feed, setFeed] = useState<{
    api: ApiClient;
    items: Array<{ did: Did; handle: string | null; nowPlaying: NowPlaying }>;
  } | null>(null);
  useEffect(() => {
    let active = true;
    let requestSequence = 0;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      const sequence = ++requestSequence;
      void api.nowPlayingFeed().then(
        (result) => {
          if (active && sequence === requestSequence) setFeed({ api, items: result.items });
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
      requestSequence += 1;
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(timer);
    };
  }, [api]);
  const items = feed?.api === api ? feed.items : [];
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
            <small>
              since <time dateTime={nowPlaying.startedAt}>{formatLocalClock(nowPlaying.startedAt)}</time>
            </small>
          </li>
        ))}
      </ul>
    </aside>
  );
}
