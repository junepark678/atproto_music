// Listening statistics with window tabs all / 7d / 30d / 365d (M7.3.2).
//
// Each tab fetches its own window; the panel always shows the answer for the
// selected window (a late answer for a previous tab is dropped). Totals, the
// asOf instant and the top lists are shown exactly as the server ranked them.
// An empty album list says so instead of inventing an album bucket.

import type { Did, Statistics, StatsWindow } from '@atmusic/core/api-types';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ApiClient } from '../api/client';
import { formatUtc, plural } from './format';
import { EmptyState, ErrorState, LoadingState } from './state-views';

export const WINDOWS: readonly { id: StatsWindow; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '365d', label: 'Last 365 days' },
];

type Load = { kind: 'loading' } | { kind: 'ready'; stats: Statistics } | { kind: 'error'; error: unknown };

export function StatsPanel({ api, did }: { api: ApiClient; did: Did }) {
  const [selected, setSelected] = useState<StatsWindow>('all');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const abort = new AbortController();
    setLoad({ kind: 'loading' });
    api.stats(did, { window: selected }, { signal: abort.signal }).then(
      (stats) => {
        if (!abort.signal.aborted) setLoad({ kind: 'ready', stats });
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setLoad({ kind: 'error', error });
      },
    );
    return () => abort.abort();
  }, [api, did, selected, attempt]);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + WINDOWS.length) % WINDOWS.length;
    setSelected(WINDOWS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div class="stats">
      <div class="tabs" role="tablist" aria-label="Statistics window">
        {WINDOWS.map((w, i) => (
          <button
            key={w.id}
            type="button"
            role="tab"
            id={`stats-tab-${w.id}`}
            aria-selected={w.id === selected}
            aria-controls="stats-panel"
            tabIndex={w.id === selected ? 0 : -1}
            data-window={w.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            onClick={() => setSelected(w.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {w.label}
          </button>
        ))}
      </div>
      <div id="stats-panel" role="tabpanel" aria-labelledby={`stats-tab-${selected}`}>
        {load.kind === 'loading' ? <LoadingState label="Loading statistics…" /> : null}
        {load.kind === 'error' ? (
          <ErrorState
            title="Statistics could not be loaded."
            error={load.error}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : null}
        {load.kind === 'ready' ? <StatsBody stats={load.stats} /> : null}
      </div>
    </div>
  );
}

function StatsBody({ stats }: { stats: Statistics }) {
  const windowLabel = WINDOWS.find((w) => w.id === stats.window)?.label ?? stats.window;
  return (
    <div class="stats-body" data-window={stats.window}>
      <p class="stats-asof">
        {windowLabel}, as of <time dateTime={stats.asOf}>{formatUtc(stats.asOf)}</time>.{' '}
        {stats.window === 'all' ? '' : 'Windows count back from that instant in UTC.'}
      </p>
      <dl class="stats-totals">
        <div>
          <dt>Scrobbles</dt>
          <dd data-total="scrobbles">{stats.totalScrobbles}</dd>
        </div>
        <div>
          <dt>Artists</dt>
          <dd data-total="artists">{stats.distinctArtists}</dd>
        </div>
        <div>
          <dt>Tracks</dt>
          <dd data-total="tracks">{stats.distinctTracks}</dd>
        </div>
      </dl>
      {stats.totalScrobbles === 0 ? (
        <EmptyState>No scrobbles in this window.</EmptyState>
      ) : (
        <>
          <h3 id="top-artists">Top artists</h3>
          <ol aria-labelledby="top-artists" class="top-artists">
            {stats.topArtists.map((a, i) => (
              <li key={`${i}`}>
                <span class="artist">{a.artist}</span> — {plural(a.scrobbleCount, 'scrobble')}
              </li>
            ))}
          </ol>
          <h3 id="top-tracks">Top tracks</h3>
          <ol aria-labelledby="top-tracks" class="top-tracks">
            {stats.topTracks.map((t, i) => (
              <li key={`${i}`}>
                <span class="track">{t.track}</span> by <span class="artist">{t.artist}</span> —{' '}
                {plural(t.scrobbleCount, 'scrobble')}
              </li>
            ))}
          </ol>
          <h3 id="top-albums">Top albums</h3>
          {stats.topAlbums.length === 0 ? (
            <EmptyState>No album information in this window.</EmptyState>
          ) : (
            <ol aria-labelledby="top-albums" class="top-albums">
              {stats.topAlbums.map((a, i) => (
                <li key={`${i}`}>
                  <span class="album">{a.album}</span> by <span class="artist">{a.artist}</span> —{' '}
                  {plural(a.scrobbleCount, 'scrobble')}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
