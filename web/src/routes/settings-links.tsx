import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { addListenbrainzLink, type Link, listLinks, patchLink, startLastfmLink, unlink } from '../api/account';
import { formatLocalTime, scrubDids } from '../components/format';
import { EmptyState, ErrorState, LoadingState, SignInPrompt } from '../components/state-views';
import { useAppState } from '../state/store';

const serviceName = (service: Link['service']) => (service === 'lastfm' ? 'Last.fm' : 'ListenBrainz');

function syncStatus(link: Link) {
  if (link.status === 'revoked' || link.sync?.needsReauth) return { label: 'Needs reconnect', value: 'reconnect' };
  if (link.status === 'error') return { label: 'Error', value: 'error' };
  return { label: 'Active', value: 'active' };
}

function lastSynced(link: Link): string | undefined {
  const candidates = [link.sync?.lastSuccessAt, link.sync?.lastPulledAt].filter(
    (value): value is string => value !== undefined && !Number.isNaN(Date.parse(value)),
  );
  return candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function errorWords(error: string): string {
  const words = scrubDids(error).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0]!.toLocaleUpperCase() + words.slice(1) : '';
}

export default function SettingsLinks() {
  const session = useAppState().session.value;
  const ownerDid = useRef(session?.did ?? null);
  if (ownerDid.current === null && session !== null) ownerDid.current = session.did;
  const [links, setLinks] = useState<Link[] | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const refresh = useCallback(async () => {
    try {
      setLinks((await listLinks()).items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void refresh();
    let polling = false;
    const poll = async () => {
      if (document.visibilityState !== 'visible' || polling) return;
      polling = true;
      try {
        setLinks((await listLinks()).items);
        setError(null);
      } catch (e) {
        setError(e);
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [session, refresh]);

  if (!session)
    return (
      <section aria-labelledby="page-title">
        <h1 id="page-title">Connected services</h1>
        <SignInPrompt>Sign in to manage connected services.</SignInPrompt>
      </section>
    );
  const expectedDid = ownerDid.current ?? session.did;
  const canManage = session.status === 'active' && session.did === expectedDid;
  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addListenbrainzLink(token, expectedDid);
      setToken('');
      setMessage('ListenBrainz connected.');
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function lastfm() {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await startLastfmLink(expectedDid);
      window.location.assign(authorizeUrl);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  async function remove(link: Link) {
    if (!window.confirm(`Disconnect ${serviceName(link.service)} account ${scrubDids(link.remoteUser)}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await unlink(link.id, expectedDid);
      setMessage(`${serviceName(link.service)} disconnected.`);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function changeSetting(link: Link, patch: Parameters<typeof patchLink>[1]) {
    setLinks(
      (current) =>
        current?.map((item) =>
          item.id === link.id
            ? {
                ...item,
                ...(patch.forwardScrobbles === undefined ? {} : { forwardScrobbles: patch.forwardScrobbles }),
                ...(patch.forwardNowPlaying === undefined ? {} : { forwardNowPlaying: patch.forwardNowPlaying }),
                ...(item.sync && patch.pullEnabled !== undefined
                  ? { sync: { ...item.sync, pullEnabled: patch.pullEnabled } }
                  : {}),
              }
            : item,
        ) ?? current,
    );
    setBusy(true);
    setError(null);
    try {
      const updated = await patchLink(link.id, patch, expectedDid);
      setLinks((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current);
      setMessage(`${serviceName(link.service)} sync settings updated.`);
    } catch (e) {
      setError(e);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Connected services</h1>
      {!canManage && <p role="status">Sign in again before changing connected services.</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <ErrorState title="Connected services could not be updated." error={error} onRetry={() => void refresh()} />
      )}
      {links === null ? (
        error ? null : (
          <LoadingState label="Loading connected services…" />
        )
      ) : links.length === 0 ? (
        <EmptyState>No music services are connected.</EmptyState>
      ) : (
        <ul class="link-card-list">
          {links.map((link) => {
            const name = serviceName(link.service);
            const status = syncStatus(link);
            const syncedAt = lastSynced(link);
            const backfill = link.sync?.backfill;
            const lastError = link.sync?.lastError ?? link.lastError;
            const pullEnabled = link.sync?.pullEnabled ?? true;
            return (
              <li key={link.id} class="link-card">
                <div class="link-card-heading">
                  <div>
                    <h2>{name}</h2>
                    <p class="link-account">{scrubDids(link.remoteUser)}</p>
                  </div>
                  <span class="link-status-pill" data-status={status.value}>
                    {status.label}
                  </span>
                </div>
                <p class="link-last-synced">
                  <strong>Last synced</strong>{' '}
                  {syncedAt ? <time dateTime={syncedAt}>{formatLocalTime(syncedAt)}</time> : 'Not yet'}
                </p>
                {backfill?.state === 'running' ? (
                  <div class="link-backfill">
                    <p>
                      Sending history: {backfill.done.toLocaleString()} of {backfill.total.toLocaleString()}
                    </p>
                    <progress
                      aria-label="Sending history"
                      aria-valuemax={Math.max(backfill.total, 1)}
                      aria-valuenow={Math.min(backfill.done, Math.max(backfill.total, 1))}
                      aria-valuetext={`${backfill.done} of ${backfill.total} listens sent`}
                      class="link-progress"
                      max={Math.max(backfill.total, 1)}
                      value={Math.min(backfill.done, Math.max(backfill.total, 1))}
                    />
                  </div>
                ) : null}
                {link.sync?.needsReauth ? <p role="status">Reconnect your account to keep importing.</p> : null}
                {lastError ? (
                  <p class="link-error" role="alert">
                    {errorWords(lastError)}
                  </p>
                ) : null}
                <fieldset class="link-settings" disabled={!canManage || busy}>
                  <legend>Sync settings</legend>
                  <label>
                    <input
                      checked={link.forwardScrobbles}
                      onChange={(event) =>
                        void changeSetting(link, {
                          forwardScrobbles: (event.currentTarget as HTMLInputElement).checked,
                        })
                      }
                      type="checkbox"
                    />
                    Send scrobbles and loves
                  </label>
                  <label>
                    <input
                      checked={link.forwardNowPlaying}
                      onChange={(event) =>
                        void changeSetting(link, {
                          forwardNowPlaying: (event.currentTarget as HTMLInputElement).checked,
                        })
                      }
                      type="checkbox"
                    />
                    Send now playing
                  </label>
                  <label>
                    <input
                      checked={pullEnabled}
                      onChange={(event) =>
                        void changeSetting(link, { pullEnabled: (event.currentTarget as HTMLInputElement).checked })
                      }
                      type="checkbox"
                    />
                    Bring in new scrobbles from {name}
                  </label>
                </fieldset>
                {link.service === 'lastfm' ? (
                  <p class="link-limit-note">
                    Last.fm accepts scrobbles from the last 14 days and doesn't support deleting them.
                  </p>
                ) : null}
                {canManage ? (
                  <button type="button" disabled={busy} onClick={() => void remove(link)}>
                    Disconnect {link.service}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <section aria-labelledby="listenbrainz-title">
        <h2 id="listenbrainz-title">Connect ListenBrainz</h2>
        {canManage ? (
          <form onSubmit={submit}>
            <label for="listenbrainz-token">ListenBrainz user token</label>
            <input
              id="listenbrainz-token"
              type="password"
              autocomplete="off"
              value={token}
              onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)}
              required
            />
            <button type="submit" disabled={busy || !token}>
              Connect ListenBrainz
            </button>
          </form>
        ) : null}
      </section>
      <section aria-labelledby="lastfm-title">
        <h2 id="lastfm-title">Connect Last.fm</h2>
        {canManage ? (
          <button type="button" disabled={busy} onClick={() => void lastfm()}>
            Connect Last.fm
          </button>
        ) : null}
      </section>
    </section>
  );
}
