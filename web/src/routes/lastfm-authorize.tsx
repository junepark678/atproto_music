import { useEffect, useState } from 'preact/hooks';
import { approveLastfmAuthorization, listCredentials } from '../api/account';
import { ErrorState, LoadingState, SignInPrompt } from '../components/state-views';
import { useAppState } from '../state/store';

export default function LastfmAuthorize() {
  const session = useAppState().session.value;
  const params = new URLSearchParams(window.location.search);
  const apiKey = params.get('api_key') ?? '';
  const token = params.get('token') ?? undefined;
  const callback = params.get('cb');
  const callbackHost = (() => { try { return callback ? new URL(callback).host : 'No callback requested'; } catch { return 'Invalid callback'; } })();
  const [clientName, setClientName] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    if (!session) return;
    void listCredentials().then((value) => setClientName(value.lastfmApps.find((app) => app.apiKey === apiKey)?.name ?? null), (e) => { setClientName(null); setError(e); });
  }, [session, apiKey]);
  if (!session) return <section aria-labelledby="page-title"><h1 id="page-title">Last.fm authorization</h1><SignInPrompt>Sign in before authorizing a Last.fm application.</SignInPrompt></section>;
  const approve = async () => {
    setBusy(true); setError(null);
    try {
      const result = await approveLastfmAuthorization(apiKey, token);
      if (!callback) { setDenied(true); return; }
      const hash = callback.indexOf('#');
      const base = hash < 0 ? callback : callback.slice(0, hash);
      const fragment = hash < 0 ? '' : callback.slice(hash);
      const separator = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
      window.location.assign(`${base}${separator}token=${encodeURIComponent(result.token)}${fragment}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const deny = () => {
    setDenied(true);
    const clean = `${window.location.pathname}`;
    window.history.replaceState(null, '', clean);
  };
  return <main aria-labelledby="page-title">
    <h1 id="page-title">Authorize Last.fm application</h1>
    {error && <ErrorState title="Authorization could not be completed." error={error} />}
    {denied ? <p role="status">Authorization denied. This application was not given access.</p> : <>
      <p>Allow this application to use your Last.fm account?</p>
      <dl><dt>Application</dt><dd>{clientName === null ? <><strong>Unverified application</strong> <span>(not issued by this service)</span></> : clientName}</dd>
        <dt>Requested</dt><dd>{new Date().toLocaleString()}</dd>
        <dt>Callback host</dt><dd><strong>{callbackHost}</strong></dd></dl>
      {clientName === null && <p role="note">Only approve if you recognize and trust this application.</p>}
      <div><button type="button" disabled={busy || !apiKey} onClick={deny} autoFocus>Deny</button> <button type="button" disabled={busy || !apiKey} onClick={() => void approve()}>{busy ? 'Authorizing…' : 'Approve'}</button></div>
    </>}
    {clientName === undefined && !error && <LoadingState label="Checking application details…" />}
  </main>;
}
