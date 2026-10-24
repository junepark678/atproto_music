// /signin (M7.2.1; ADR 0004 §5.1 step 1).
//
// Takes a handle (or DID) and starts the browser OAuth redirect through the
// session controller, which asks for the granular repo scopes of the
// deployment's prefix. A failure shows the fixed recovery text for its code
// (web/src/oauth/session.ts SIGN_IN_MESSAGES) and a retry; no library message,
// OAuth code, state or token is ever rendered. The callback's own failures
// (cancelled authorization, an expired or reused callback) are shown by
// /oauth/callback with a link back here.

import { useEffect, useRef, useState } from 'preact/hooks';
import { useServices } from '../components/services';
import { SIGN_IN_MESSAGES, SignInError, type SignInErrorCode } from '../oauth/session';
import { useAppState } from '../state/store';

type Phase = { kind: 'idle' } | { kind: 'redirecting' } | { kind: 'error'; code: SignInErrorCode };

function errorCode(error: unknown): SignInErrorCode {
  return error instanceof SignInError ? error.code : 'failed';
}

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
    } catch (error) {
      busy.current = false;
      setPhase({ kind: 'error', code: errorCode(error) });
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

  const message = phase.kind === 'error' ? SIGN_IN_MESSAGES[phase.code] : null;
  const fieldError = phase.kind === 'error' && (phase.code === 'invalid_handle' || phase.code === 'unknown_handle');

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
            For example alice.bsky.social or your own domain.
          </span>
        </div>
        {message ? (
          <div
            class="state state-error"
            role="alert"
            id="signin-error"
            data-signin-error={phase.kind === 'error' ? phase.code : undefined}
          >
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
