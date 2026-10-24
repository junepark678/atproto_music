// /oauth/callback (ADR 0004 §5.1 step 3; W2-06).
//
// The authorization server redirects here with `code`, `state` and `iss` as
// query parameters (responseMode query). `init()` in web/src/oauth/session.ts
// completes the exchange (main.tsx starts it on page load; this screen shares
// the same memoized run), the library removes the parameters from the address
// bar, and this screen records the session in the app state and replaces the
// history entry with /feed. Failures show fixed recovery text: an OAuth code,
// state or token never reaches the DOM.

import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import {
  callbackError,
  type InitResult,
  type SessionController,
  SIGN_IN_MESSAGES,
  type SignInErrorCode,
  session as spaSession,
} from '../oauth/session';
import { setSession, useAppState } from '../state/store';

/** Where a completed sign-in lands. */
export const AFTER_SIGN_IN = '/feed';

type Phase =
  | { kind: 'working' }
  | { kind: 'error'; code: SignInErrorCode }
  | { kind: 'no-callback' }
  | { kind: 'reauth-required' };

export interface CallbackProps {
  /** Injected session controller (tests); the page's controller otherwise. */
  controller?: SessionController;
}

export default function Callback({ controller }: CallbackProps) {
  const state = useAppState();
  const { route } = useLocation();
  // The effect runs once per controller; the latest `route` is read through a ref.
  const routeRef = useRef(route);
  routeRef.current = route;
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });

  useEffect(() => {
    const ctl = controller ?? spaSession();
    let live = true;
    ctl.init().then(
      (result: InitResult) => {
        if (!live) return;
        if (result.kind === 'signed-in' || result.kind === 'restored') {
          setSession(state, ctl.current());
          routeRef.current(AFTER_SIGN_IN, true);
        } else if (result.kind === 'reauth-required') {
          setSession(state, null);
          state.reauthRequired.value = true;
          setPhase({ kind: 'reauth-required' });
        } else {
          setPhase({ kind: 'no-callback' });
        }
      },
      (error: unknown) => {
        if (live) setPhase({ kind: 'error', code: callbackError(error).code });
      },
    );
    return () => {
      live = false;
    };
  }, [controller, state]);

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Signing in</h1>
      {phase.kind === 'working' ? <p role="status">Completing sign-in…</p> : null}
      {phase.kind === 'error' ? (
        <div role="alert">
          <h2>{SIGN_IN_MESSAGES[phase.code].title}</h2>
          <p>{SIGN_IN_MESSAGES[phase.code].message}</p>
          <p>
            <a href="/signin">Try signing in again</a>
          </p>
        </div>
      ) : null}
      {phase.kind === 'reauth-required' ? (
        <div role="alert">
          <h2>Your session has ended</h2>
          <p>Sign in again to keep publishing.</p>
          <p>
            <a href="/signin">Sign in again</a>
          </p>
        </div>
      ) : null}
      {phase.kind === 'no-callback' ? (
        <div>
          <p>There is no sign-in in progress.</p>
          <p>
            <a href="/signin">Sign in</a> or <a href={AFTER_SIGN_IN}>go to the feed</a>.
          </p>
        </div>
      ) : null}
    </section>
  );
}
