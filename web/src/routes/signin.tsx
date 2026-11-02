// /signin (M7.2.1; ADR 0004 §5.1 step 1).
//
// Takes a handle (or DID) and starts the browser OAuth redirect through the
// session controller, which asks for the granular repo scopes of the
// deployment's prefix. A failure shows the fixed recovery text for its code
// error is kept generic so upstream details and OAuth values are never shown.

import { useEffect, useRef, useState } from 'preact/hooks';
import { useServices } from '../components/services';
import { useAppState } from '../state/store';

type Phase = { kind: 'idle' } | { kind: 'redirecting' } | { kind: 'error' };

export default function SignIn() {
  const state = useAppState();
  const services = useServices();
  const session = state.session.value;
  const [handle, setHandleState] = useState('');
  // The latest input, updated synchronously, so a submit right after typing uses it.
  const handleRef = useRef(handle);
  const setHandle = (value: string) => {
    handleRef.current = value;
    setHandleState(value);
  };
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  // Back from the authorization server through the back/forward cache: the
  // redirect did not complete, so the form is usable again.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      busy.current = false;
      setPhase({ kind: 'idle' });
    };
    addEventListener('pageshow', onShow);
    return () => removeEventListener('pageshow', onShow);
  }, []);

  const start = async () => {
    if (busy.current) return;
    busy.current = true;
    setPhase({ kind: 'redirecting' });
    try {
      const port = await services.session();
      await port.signIn(handleRef.current);
      // The library is navigating away to the authorization server.
    } catch {
      busy.current = false;
      setPhase({ kind: 'error' });
      inputRef.current?.focus();
    }
  };

  if (session !== null) {
    return (
      <section aria-labelledby="page-title">
        <h1 id="page-title">Sign in</h1>
        <p>
          You are signed in as <code>{session.did}</code>. <a href="/feed">Go to the feed</a> or{' '}
          <a href="/settings">manage your session</a>.
        </p>
      </section>
    );
  }

  const callbackError = new URLSearchParams(window.location.search).get('error');
  const recoveryMessage = callbackError === null
    ? null
    : callbackError === 'denied'
      ? 'Authorization was cancelled. You can try signing in again.'
      : callbackError === 'expired'
        ? 'The sign-in request expired. Start again to get a new request.'
        : 'Sign-in did not complete. Check your handle and try again.';
  const message =
    phase.kind === 'error'
      ? { title: 'Sign-in could not be started', message: 'Check the handle and try again.' }
      : recoveryMessage !== null
        ? { title: 'Sign-in did not complete', message: recoveryMessage }
        : null;
  const fieldError = false;

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Sign in</h1>
      <p>
        Sign in with your AT Protocol account. Your provider asks you to allow this app to write music records to your
        repository; this app never sees your password.
      </p>
      {state.reauthRequired.value ? (
        <p role="status">Your previous session has ended. Sign in again to keep publishing.</p>
      ) : null}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <div class="field">
          <label for="signin-handle">Your handle</label>
          <input
            ref={inputRef}
            id="signin-handle"
            name="handle"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellcheck={false}
            required
            aria-invalid={fieldError ? 'true' : undefined}
            aria-describedby={message ? 'signin-hint signin-error' : 'signin-hint'}
            value={handle}
            onInput={(e) => setHandle((e.currentTarget as HTMLInputElement).value)}
          />
          <span class="field-hint" id="signin-hint">
            For example alice.example.social or your own domain.
          </span>
        </div>
        {message ? (
          <div class="state state-error" role="alert" id="signin-error">
            <p class="state-title">{message.title}</p>
            <p>{message.message}</p>
            <button type="submit">Try again</button>
          </div>
        ) : null}
        {phase.kind === 'redirecting' ? (
          <p role="status" data-state="loading">
            Contacting your account provider…
          </p>
        ) : null}
        {message ? null : (
          <button type="submit" disabled={phase.kind === 'redirecting'}>
            Sign in
          </button>
        )}
      </form>
    </section>
  );
}
