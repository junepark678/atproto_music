import { useEffect, useState } from 'preact/hooks';
import { addListenbrainzLink, type Link, listLinks, startLastfmLink, unlink } from '../api/account';
import { EmptyState, ErrorState, LoadingState, SignInPrompt } from '../components/state-views';
import { useAppState } from '../state/store';

export default function SettingsLinks() {
  const session = useAppState().session.value;
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
  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addListenbrainzLink(token);
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
      const { authorizeUrl } = await startLastfmLink();
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
      await unlink(link.id);
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
              <button type="button" disabled={busy} onClick={() => void remove(link)}>
                Disconnect {link.service}
              </button>
            </li>
          ))}
        </ul>
      )}
      <section aria-labelledby="listenbrainz-title">
        <h2 id="listenbrainz-title">Connect ListenBrainz</h2>
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
      </section>
      <section aria-labelledby="lastfm-title">
        <h2 id="lastfm-title">Connect Last.fm</h2>
        <button type="button" disabled={busy} onClick={() => void lastfm()}>
          Connect Last.fm
        </button>
      </section>
    </section>
  );
}
