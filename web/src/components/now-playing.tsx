import type { Did, NowPlaying } from '@atmusic/core/api-types';
import { useCallback, useEffect, useState } from 'preact/hooks';
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
type FeedSnapshot = {
  api: ApiClient;
  viewer: Did;
  items: Array<{ did: Did; handle: string | null; nowPlaying: NowPlaying }>;
  skew: number;
};
function isUnexpired(item: NowPlaying | null | undefined, clientNow: number, skew: number): boolean {
  const expiry = item == null ? Number.NaN : Date.parse(item.expiresAt);
  return Number.isFinite(skew) && Number.isFinite(expiry) && expiry > clientNow + skew;
}
function discardExpiredEntries(snapshot: FeedSnapshot, clientNow: number): FeedSnapshot {
  const items = snapshot.items.filter(({ nowPlaying }) => isUnexpired(nowPlaying, clientNow, snapshot.skew));
  return items.length === snapshot.items.length ? snapshot : { ...snapshot, items };
}
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
  const reevaluate = useCallback(() => {
    const clientNow = Date.now();
    setNow(clientNow);
    setSnapshot((current) =>
      current?.api === api &&
      current.did === did &&
      current.owner === owner &&
      current.nowPlaying !== null &&
      !isUnexpired(current.nowPlaying, clientNow, current.skew)
        ? { ...current, nowPlaying: null }
        : current,
    );
  }, [api, did, owner]);
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
        const clientNow = Date.now();
        const skew = Date.parse(response.serverTime) - clientNow;
        setNow(clientNow);
        setSnapshot({
          api,
          did,
          owner,
          ...response,
          skew,
          nowPlaying: isUnexpired(response.nowPlaying, clientNow, skew) ? response.nowPlaying : null,
        });
        setError(false);
      } catch {
        if (active && sequence === requestSequence) {
          reevaluate();
          setError(true);
        }
      }
    };
    const syncTicker = () => {
      if (document.visibilityState === 'visible') {
        if (ticker === undefined) ticker = window.setInterval(reevaluate, 15_000);
      } else if (ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
    };
    if (document.visibilityState === 'visible') void refresh();
    syncTicker();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        reevaluate();
        void refresh();
      }
      syncTicker();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        reevaluate();
        void refresh();
      }
    }, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(interval);
      if (ticker !== undefined) clearInterval(ticker);
      active = false;
    };
  }, [api, did, owner, reevaluate]);
  const currentSnapshot = snapshot?.api === api && snapshot.did === did && snapshot.owner === owner ? snapshot : null;
  const item = currentSnapshot?.nowPlaying;
  const expired = !isUnexpired(item, now, currentSnapshot?.skew ?? Number.NaN);
  if (currentSnapshot === null)
    return owner ? (
      <p class="now-playing-empty" aria-live="polite">
        {error ? 'Now playing is unavailable.' : 'Loading now playing…'}
      </p>
    ) : null;
  if (item == null || expired) return owner ? <p class="now-playing-empty">Nothing playing right now</p> : null;
  const started = Date.parse(item.startedAt);
  const elapsed = Math.max(0, Math.floor((now + currentSnapshot.skew - started) / 1000));
  const duration = item.durationSeconds ?? item.musicbrainz?.durationSeconds;
  const progress = duration === undefined ? null : Math.min(duration, elapsed);
  const album = item.album ?? item.musicbrainz?.releaseTitle;
  const artistMbid = unambiguousMbid(item.artistMbids) ?? unambiguousMbid(item.musicbrainz?.artistMbids);
  const coverReleaseMbid = isMbid(item.musicbrainz?.releaseMbid)
    ? item.musicbrainz.releaseMbid
    : isMbid(item.releaseMbid)
      ? item.releaseMbid
      : undefined;
  return (
    <article class="now-playing-card" aria-label="Now playing">
      <div class="now-playing-art" aria-hidden="true">
        ♫{coverReleaseMbid ? <CoverArt key={coverReleaseMbid} releaseMbid={coverReleaseMbid} /> : null}
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

function CoverArt({ releaseMbid }: { releaseMbid: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      class="now-playing-cover"
      src={`/api/v1/cover-art/${releaseMbid}`}
      loading="lazy"
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

export function ListeningNow({ api, viewer }: { api: ApiClient; viewer: Did }) {
  const [feed, setFeed] = useState<FeedSnapshot | null>(null);
  const [now, setNow] = useState(Date.now());
  const [pollVersion, setPollVersion] = useState(0);
  const reevaluate = useCallback(() => {
    const clientNow = Date.now();
    setNow(clientNow);
    setFeed((current) =>
      current?.api === api && current.viewer === viewer ? discardExpiredEntries(current, clientNow) : current,
    );
  }, [api, viewer]);
  useEffect(() => {
    let active = true;
    let requestSequence = 0;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      const sequence = ++requestSequence;
      void api.nowPlayingFeed().then(
        (result) => {
          if (active && sequence === requestSequence) {
            const clientNow = Date.now();
            setFeed(
              discardExpiredEntries(
                { api, viewer, items: result.items, skew: Date.parse(result.serverTime) - clientNow },
                clientNow,
              ),
            );
            setNow(clientNow);
            setPollVersion((version) => version + 1);
          }
        },
        () => {
          if (active && sequence === requestSequence) {
            reevaluate();
            setPollVersion((version) => version + 1);
          }
        },
      );
    };
    refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        reevaluate();
        setPollVersion((version) => version + 1);
        refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      requestSequence += 1;
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(timer);
    };
  }, [api, viewer, reevaluate]);
  const items =
    feed?.api === api && feed.viewer === viewer
      ? feed.items.filter(({ nowPlaying }) => isUnexpired(nowPlaying, now, feed.skew))
      : [];
  useEffect(() => {
    if (feed?.api !== api || feed.viewer !== viewer || !Number.isFinite(feed.skew)) return;
    const nextExpiry = feed.items.reduce((next, row) => {
      const expiry = Date.parse(row.nowPlaying.expiresAt);
      return Number.isFinite(expiry) && expiry > now + feed.skew ? Math.min(next, expiry) : next;
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextExpiry)) return;
    const remaining = nextExpiry - (Date.now() + feed.skew);
    const delay = Math.min(2_147_483_647, Math.max(0, remaining));
    const timer = window.setTimeout(reevaluate, delay);
    return () => clearTimeout(timer);
  }, [api, viewer, feed, pollVersion, now, reevaluate]);
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
