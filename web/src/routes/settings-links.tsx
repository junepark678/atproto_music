import { useEffect, useRef, useState } from 'preact/hooks';
import { addListenbrainzLink, type Link, listLinks, startLastfmLink, unlink } from '../api/account';
import { EmptyState, ErrorState, LoadingState, SignInPrompt } from '../components/state-views';
import { useAppState } from '../state/store';

export default function SettingsLinks() {
  const session = useAppState().session.value;
  const ownerDid = useRef(session?.did ?? null);
  if (ownerDid.current === null && session !== null) ownerDid.current = session.did;
  const [links, setLinks] = useState<Link[] | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  async function refresh() {
    setError(null);
    try {
      setLinks((await listLinks()).items);
    } catch (e) {
      setError(e);
    }
  }
  useEffect(() => {
    if (session) void refresh();
  }, [session]);
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
    if (!window.confirm(`Disconnect ${link.service} account ${link.remoteUser}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await unlink(link.id, expectedDid);
      setMessage(`${link.service} disconnected.`);
      await refresh();
    } catch (e) {
      setError(e);
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
        <ul>
          {links.map((link) => (
            <li key={link.id}>
              <strong>{link.service === 'lastfm' ? 'Last.fm' : 'ListenBrainz'}</strong> — {link.remoteUser} (
              {link.status}){' '}
              {canManage ? (
                <button type="button" disabled={busy} onClick={() => void remove(link)}>
                  Disconnect {link.service}
                </button>
              ) : null}
            </li>
          ))}
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
