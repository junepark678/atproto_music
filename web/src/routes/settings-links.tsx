import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { addListenbrainzLink, type Link, listLinks, patchLink, startLastfmLink, unlink } from '../api/account';
import { formatLocalTime, scrubDids } from '../components/format';
import { EmptyState, ErrorState, LoadingState, SignInPrompt } from '../components/state-views';
import { useAppState } from '../state/store';

const serviceName = (service: Link['service']) => (service === 'lastfm' ? 'Last.fm' : 'ListenBrainz');

function syncStatus(link: Link) {
  if (link.status === 'revoked' || link.sync?.needsReauth) return { label: 'Needs reconnect', value: 'reconnect' };
  if (link.status === 'error' || terminalSyncError(link)) return { label: 'Error', value: 'error' };
  return { label: 'Active', value: 'active' };
}

const terminalPullHolds = new Set([
  'upstream_unauthorized',
  'retry_exhausted',
  'remote_user_not_found',
  'lastfm_key_rejected',
  'lastfm_error',
  'listenbrainz_page_saturated',
]);

function terminalSyncError(link: Link): boolean {
  return (
    Boolean(link.sync?.holdReason && terminalPullHolds.has(link.sync.holdReason)) ||
    link.sync?.backfill.lastError === 'retry_exhausted'
  );
}

function holdWords(reason: string, service: string): string | undefined {
  const copy: Record<string, string> = {
    upstream_unauthorized: `${service} rejected the saved connection. Reconnect your account to resume importing.`,
    retry_exhausted: `Repeated attempts to import from ${service} failed. Check the connection and try reconnecting.`,
    remote_user_not_found: `${service} could not find the connected account. Check the account details and reconnect it.`,
    lastfm_key_rejected: `Last.fm is rejecting this server's API key. Syncing is paused.`,
    lastfm_error: `Last.fm stopped responding successfully. Check its service status and try syncing again later.`,
    listenbrainz_page_saturated: `ListenBrainz returned more history than can be safely imported in one pass. Importing is paused.`,
    session_missing: `The server session needed to import from ${service} is unavailable. Try again after signing in.`,
    reauth_required: `Reconnect your ${service} account to resume importing.`,
    publication_disabled: `Importing from ${service} is disabled in this app's settings.`,
    scope_insufficient: `The saved ${service} connection lacks permission to import. Reconnect and grant the requested access.`,
    session_restore_transient: `The server is restoring its session with ${service}. Importing will resume when that finishes.`,
    legacy_dedupe_coverage: `Importing from ${service} is waiting for older history to be checked for duplicates.`,
    staging_capacity: `Importing from ${service} is temporarily waiting for queue capacity.`,
    credential_unavailable: `The saved ${service} connection is temporarily unavailable. Try again later.`,
    lastfm_not_configured: `Last.fm importing is not configured on this server.`,
    listenbrainz_not_configured: `ListenBrainz importing is not configured on this server.`,
    upstream_retry: `${service} could not be reached. Importing will retry later.`,
  };
  return copy[reason];
}

function lastSynced(link: Link): string | undefined {
  const candidates = [link.sync?.lastSuccessAt, link.sync?.lastPulledAt].filter(
    (value): value is string => value !== undefined && !Number.isNaN(Date.parse(value)),
  );
  return candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function errorWords(error: string, service: string): string {
  const advice =
    error === 'session_revoked' || error === 'token_revoked'
      ? `${service} disconnected this app. Reconnect to resume syncing.`
      : error === 'credential_unreadable'
        ? "Saved credentials couldn't be read. Reconnect to resume syncing."
        : error === 'lastfm_key_rejected'
          ? "Last.fm is rejecting this server's API key. Syncing is paused."
          : error === 'retry_exhausted'
            ? `Repeated attempts to sync with ${service} failed. Check the connection and try again.`
            : /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(error)
              ? `Syncing with ${service} stopped after an error. Check the connection and try again.`
              : error;
  const words = scrubDids(advice).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
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
  const requestGeneration = useRef(0);
  const mounted = useRef(true);
  const mutationInFlight = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const result = await listLinks();
      if (mounted.current && mutationInFlight.current === 0 && generation === requestGeneration.current) {
        setLinks(result.items);
        setError(null);
      }
    } catch (e) {
      if (mounted.current && mutationInFlight.current === 0 && generation === requestGeneration.current) setError(e);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    mounted.current = true;
    void refresh();
    let polling = false;
    const poll = async () => {
      if (document.visibilityState !== 'visible' || polling || mutationInFlight.current > 0) return;
      polling = true;
      const generation = ++requestGeneration.current;
      try {
        const result = await listLinks();
        if (mounted.current && mutationInFlight.current === 0 && generation === requestGeneration.current) {
          setLinks(result.items);
          setError(null);
        }
      } catch (e) {
        if (mounted.current && mutationInFlight.current === 0 && generation === requestGeneration.current) setError(e);
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
      mounted.current = false;
      requestGeneration.current++;
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
    const generation = ++requestGeneration.current;
    mutationInFlight.current++;
    try {
      await addListenbrainzLink(token, expectedDid);
      if (!mounted.current || generation !== requestGeneration.current) return;
      setToken('');
      setMessage('ListenBrainz connected.');
    } catch (e) {
      if (mounted.current && generation === requestGeneration.current) setError(e);
    } finally {
      mutationInFlight.current--;
      if (mounted.current && generation === requestGeneration.current) setBusy(false);
      if (mounted.current) void refresh();
    }
  }
  async function lastfm() {
    setBusy(true);
    setError(null);
    const generation = ++requestGeneration.current;
    try {
      const { authorizeUrl } = await startLastfmLink(expectedDid);
      if (!mounted.current || generation !== requestGeneration.current) return;
      window.location.assign(authorizeUrl);
    } catch (e) {
      if (mounted.current && generation === requestGeneration.current) setError(e);
      setBusy(false);
    }
  }
  async function remove(link: Link) {
    if (!window.confirm(`Disconnect ${serviceName(link.service)} account ${scrubDids(link.remoteUser)}?`)) return;
    setBusy(true);
    setError(null);
    const generation = ++requestGeneration.current;
    mutationInFlight.current++;
    try {
      await unlink(link.id, expectedDid);
      if (!mounted.current || generation !== requestGeneration.current) return;
      setMessage(`${serviceName(link.service)} disconnected.`);
    } catch (e) {
      if (mounted.current && generation === requestGeneration.current) setError(e);
    } finally {
      mutationInFlight.current--;
      if (mounted.current && generation === requestGeneration.current) setBusy(false);
      if (mounted.current) void refresh();
    }
  }
  async function changeSetting(link: Link, patch: Parameters<typeof patchLink>[1]) {
    const generation = ++requestGeneration.current;
    mutationInFlight.current++;
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
    let actionError: unknown = null;
    try {
      const updated = await patchLink(link.id, patch, expectedDid);
      if (!mounted.current || generation !== requestGeneration.current) return;
      setLinks((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current);
      setMessage(`${serviceName(link.service)} sync settings updated.`);
    } catch (e) {
      if (!mounted.current || generation !== requestGeneration.current) return;
      actionError = e;
    } finally {
      mutationInFlight.current--;
      if (mounted.current && generation === requestGeneration.current) setBusy(false);
      if (mounted.current) {
        await refresh();
        if (actionError && mounted.current) setError(actionError);
      }
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
            const holdMessage = link.sync?.holdReason ? holdWords(link.sync.holdReason, name) : undefined;
            const backfillError = backfill?.lastError ? errorWords(backfill.lastError, name) : undefined;
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
                {holdMessage ? <p class="link-error">{holdMessage}</p> : null}
                {backfillError ? <p class="link-error">{backfillError}</p> : null}
                {lastError ? <p class="link-error">{errorWords(lastError, name)}</p> : null}
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
                    Disconnect {name}
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
