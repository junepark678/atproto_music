import { useEffect, useRef, useState } from 'preact/hooks';
import { cancelImport, type ImportJob, listImports, resumeImport, startImport, uploadImport } from '../api/account';
import { EmptyState, ErrorState, LoadingState, SignInPrompt } from '../components/state-views';
import { useAppState } from '../state/store';

const active = (job: ImportJob) => ['waiting_index', 'fetching', 'writing', 'paused'].includes(job.state);
const label = (job: ImportJob) => `${job.source.replaceAll('_', ' ')} import: ${job.state}`;

export default function SettingsImports() {
  const session = useAppState().session.value;
  const ownerDid = useRef(session?.did ?? null);
  if (ownerDid.current === null && session !== null) ownerDid.current = session.did;
  const [jobs, setJobs] = useState<ImportJob[] | null>(null);
  const [source, setSource] = useState<'lastfm' | 'listenbrainz'>('lastfm');
  const [username, setUsername] = useState('');
  const [fileSource, setFileSource] = useState<'lastfm_json' | 'listenbrainz_zip'>('lastfm_json');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const refresh = async () => {
    try {
      setJobs((await listImports()).items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    if (session) void refresh();
  }, [session]);
  useEffect(() => {
    if (!session || !jobs?.some((job) => active(job) && job.state !== 'paused')) return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [session, jobs]);
  if (!session)
    return (
      <section aria-labelledby="page-title">
        <h1 id="page-title">Import listening history</h1>
        <SignInPrompt>Sign in to import listening history.</SignInPrompt>
      </section>
    );
  const expectedDid = ownerDid.current ?? session.did;
  const canManage = session.status === 'active' && session.did === expectedDid;
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
  const upload = async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem('import-file') as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await run(() => uploadImport(fileSource, file, expectedDid));
    form.reset();
  };
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Import listening history</h1>
      {!canManage && <p role="status">Sign in again before changing imports.</p>}
      {error && <ErrorState title="Imports could not be updated." error={error} onRetry={() => void refresh()} />}
      <section aria-labelledby="account-import-title">
        <h2 id="account-import-title">Import from an account</h2>
        {canManage ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => startImport(source, username, expectedDid));
            }}
          >
            <label for="import-source">Service</label>
            <select
              id="import-source"
              value={source}
              onChange={(e) => setSource((e.currentTarget as HTMLSelectElement).value as typeof source)}
            >
              <option value="lastfm">Last.fm</option>
              <option value="listenbrainz">ListenBrainz</option>
            </select>
            <label for="import-username">Username</label>
            <input
              id="import-username"
              value={username}
              onInput={(e) => setUsername((e.currentTarget as HTMLInputElement).value)}
              required
            />
            <button type="submit" disabled={busy || !username.trim()}>
              Start import
            </button>
          </form>
        ) : null}
      </section>
      <section aria-labelledby="file-import-title">
        <h2 id="file-import-title">Import an export file</h2>
        {canManage ? (
          <form onSubmit={(e) => void upload(e)}>
            <label for="file-source">File type</label>
            <select
              id="file-source"
              value={fileSource}
              onChange={(e) => setFileSource((e.currentTarget as HTMLSelectElement).value as typeof fileSource)}
            >
              <option value="lastfm_json">Last.fm JSON</option>
              <option value="listenbrainz_zip">ListenBrainz ZIP</option>
            </select>
            <label for="import-file">Export file</label>
            <input id="import-file" name="import-file" type="file" required />
            <button type="submit" disabled={busy}>
              Upload and import
            </button>
          </form>
        ) : null}
      </section>
      <section aria-labelledby="import-jobs-title">
        <h2 id="import-jobs-title">Import activity</h2>
        {jobs === null ? (
          error ? null : (
            <LoadingState label="Loading imports…" />
          )
        ) : jobs.length === 0 ? (
          <EmptyState>No imports yet.</EmptyState>
        ) : (
          <ul>
            {jobs.map((job) => (
              <li key={job.id} aria-label={label(job)}>
                <strong>{label(job)}</strong>
                {job.remoteUser ? ` for ${job.remoteUser}` : ''}
                <p>
                  {job.fetched} fetched · {job.written} written · {job.duplicates} duplicates · {job.failed} failed
                </p>
                {active(job) && (
                  <progress
                    aria-label={`${label(job)} progress`}
                    value={job.fetched + job.failed}
                    max={Math.max(1, job.fetched + job.failed + (job.etaSeconds ? Math.ceil(job.etaSeconds * 2) : 1))}
                  />
                )}
                <p role="status" aria-live="polite">
                  {job.state === 'paused'
                    ? 'Import paused.'
                    : job.etaSeconds === null
                      ? job.state
                      : `Estimated time remaining: ${Math.ceil(job.etaSeconds / 60)} minutes.`}
                </p>
                {job.error && <p role="alert">{job.error}</p>}
                {canManage && job.state === 'paused' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => resumeImport(job.id, expectedDid))}
                  >
                    Resume import
                  </button>
                ) : null}
                {canManage && active(job) && job.state !== 'paused' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => cancelImport(job.id, expectedDid))}
                  >
                    Cancel import
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
