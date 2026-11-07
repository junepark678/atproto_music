import type { Did } from '@atmusic/core/api-types';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  type CreatedLastfmApp,
  type CreatedSecret,
  type Credentials,
  createAppPassword,
  createLastfmApp,
  createListenbrainzToken,
  listCredentials,
  revokeAppPassword,
  revokeLastfmSession,
  revokeListenbrainzToken,
} from '../api/account';
import { formatLocalDate } from '../components/format';
import { EmptyState, ErrorState, LoadingState, SignInPrompt } from '../components/state-views';
import { useAppState } from '../state/store';

export default function SettingsCredentials() {
  const session = useAppState().session.value;
  const ownerDid = useRef(session?.did ?? null);
  if (ownerDid.current === null && session !== null) ownerDid.current = session.did;
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [secret, setSecret] = useState<CreatedSecret | CreatedLastfmApp | null>(null);
  const [secretDid, setSecretDid] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [tokenLabel, setTokenLabel] = useState('');
  const [appName, setAppName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const refresh = async () => {
    try {
      setCredentials(await listCredentials());
      setError(null);
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    if (session) void refresh();
  }, [session]);
  useEffect(() => {
    const clear = () => setSecret(null);
    window.addEventListener('popstate', clear);
    return () => window.removeEventListener('popstate', clear);
  }, []);
  if (!session)
    return (
      <section aria-labelledby="page-title">
        <h1 id="page-title">Credentials</h1>
        <SignInPrompt>Sign in to manage credentials.</SignInPrompt>
      </section>
    );
  const expectedDid = ownerDid.current ?? session.did;
  const canManage = session.status === 'active' && session.did === expectedDid;
  const visibleSecret = secretDid === expectedDid && session.did === expectedDid ? secret : null;
  const run = async (fn: () => Promise<unknown>) => {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const create = async (event: Event, fn: (value: string, did: Did) => Promise<CreatedSecret>) => {
    event.preventDefault();
    const value = label.trim();
    if (!value) return;
    await run(async () => {
      setSecret(await fn(value, expectedDid));
      setSecretDid(expectedDid);
      setLabel('');
    });
  };
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Credentials</h1>
      <p>New secrets are shown once. Copy and save them before leaving this page.</p>
      {!canManage && <p role="status">Sign in again before changing credentials.</p>}
      {error && <ErrorState title="Credentials could not be updated." error={error} onRetry={() => void refresh()} />}
      {visibleSecret && (
        <section aria-labelledby="secret-title">
          <h2 id="secret-title">Save this secret now</h2>
          {'password' in visibleSecret ? (
            <label>
              App password
              <input readOnly value={visibleSecret.password} onFocus={(e) => e.currentTarget.select()} />
            </label>
          ) : 'token' in visibleSecret ? (
            <label>
              ListenBrainz token
              <input readOnly value={visibleSecret.token} onFocus={(e) => e.currentTarget.select()} />
            </label>
          ) : (
            <>
              <label>
                Last.fm API key
                <input readOnly value={visibleSecret.apiKey} onFocus={(e) => e.currentTarget.select()} />
              </label>
              <label>
                Last.fm shared secret
                <input readOnly value={visibleSecret.sharedSecret} onFocus={(e) => e.currentTarget.select()} />
              </label>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setSecret(null);
              setSecretDid(null);
            }}
          >
            I’ve saved it
          </button>
        </section>
      )}
      <section aria-labelledby="passwords-title">
        <h2 id="passwords-title">App passwords</h2>
        {canManage ? (
          <form onSubmit={(e) => void create(e, (value, did) => createAppPassword(value, did))}>
            <label for="credential-label">Label</label>
            <input
              id="credential-label"
              value={label}
              onInput={(e) => setLabel((e.currentTarget as HTMLInputElement).value)}
              required
            />
            <button type="submit" disabled={busy || !label.trim()}>
              Create app password
            </button>
          </form>
        ) : null}
        {credentials === null ? (
          <LoadingState label="Loading credentials…" />
        ) : credentials.appPasswords.length === 0 ? (
          <EmptyState>No app passwords.</EmptyState>
        ) : (
          <ul>
            {credentials.appPasswords.map((item) => (
              <li key={item.id}>
                {item.label} · created {formatLocalDate(item.createdAt)}{' '}
                {canManage ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => revokeAppPassword(item.id, expectedDid))}
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="tokens-title">
        <h2 id="tokens-title">ListenBrainz tokens</h2>
        {canManage ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = tokenLabel.trim();
              if (value)
                void run(async () => {
                  setSecret(await createListenbrainzToken(value, expectedDid));
                  setSecretDid(expectedDid);
                  setTokenLabel('');
                });
            }}
          >
            <label for="token-label">Label</label>
            <input
              id="token-label"
              value={tokenLabel}
              onInput={(e) => setTokenLabel((e.currentTarget as HTMLInputElement).value)}
              required
            />
            <button type="submit" disabled={busy || !tokenLabel.trim()}>
              Create ListenBrainz token
            </button>
          </form>
        ) : null}
        {credentials &&
          (credentials.listenbrainzTokens.length === 0 ? (
            <EmptyState>No ListenBrainz tokens.</EmptyState>
          ) : (
            <ul>
              {credentials.listenbrainzTokens.map((item) => (
                <li key={item.id}>
                  {item.label} · created {formatLocalDate(item.createdAt)}{' '}
                  {canManage ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => revokeListenbrainzToken(item.id, expectedDid))}
                    >
                      Revoke
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ))}
      </section>
      <section aria-labelledby="lastfm-apps-title">
        <h2 id="lastfm-apps-title">Last.fm applications</h2>
        {canManage ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = appName.trim();
              if (name)
                void run(async () => {
                  setSecret(await createLastfmApp(name, expectedDid));
                  setSecretDid(expectedDid);
                  setAppName('');
                });
            }}
          >
            <label for="lastfm-app-name">Application name</label>
            <input
              id="lastfm-app-name"
              value={appName}
              onInput={(e) => setAppName((e.currentTarget as HTMLInputElement).value)}
              required
            />
            <button type="submit" disabled={busy || !appName.trim()}>
              Create Last.fm app
            </button>
          </form>
        ) : null}
        {credentials?.lastfmApps.length ? (
          <ul>
            {credentials.lastfmApps.map((app) => (
              <li key={app.apiKey}>
                {app.name} · created {formatLocalDate(app.createdAt)}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section aria-labelledby="sessions-title">
        <h2 id="sessions-title">Last.fm sessions</h2>
        {credentials?.lastfmSessions.length ? (
          <ul>
            {credentials.lastfmSessions.map((item) => (
              <li key={item.id}>
                {item.clientName} · created {formatLocalDate(item.createdAt)}{' '}
                {canManage ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => revokeLastfmSession(item.id, expectedDid))}
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : credentials ? (
          <EmptyState>No Last.fm sessions.</EmptyState>
        ) : null}
      </section>
    </section>
  );
}
