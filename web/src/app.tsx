// The application shell: skip link, banner with primary navigation, the main
// landmark that hosts the routed screen, and a footer (contentinfo).
//
// Accessibility: the skip link is the first focusable element and moves focus
// to <main>. After a client-side navigation has rendered, focus moves to
// <main> as well, so keyboard and screen-reader users start at the new
// screen. The current destination carries aria-current="page".

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo } from 'preact/hooks';
import { LocationProvider, useLocation } from 'preact-iso';
import { AppRouter, matchRoute } from './router';
import { type AppState, AppStateContext, createAppState, loadMeta, useAppState } from './state/store';

const APP_NAME = 'atmusic';

function NavLink({ href, children }: { href: string; children: ComponentChildren }) {
  const { path } = useLocation();
  const current = path === href || (href === '/feed' && path === '/');
  return (
    <a href={href} aria-current={current ? 'page' : undefined}>
      {children}
    </a>
  );
}

function titleFor(path: string): string {
  const entry = matchRoute(path);
  return entry ? `${entry.title} · ${APP_NAME}` : `Page not found · ${APP_NAME}`;
}

function focusMain(): void {
  document.getElementById('main')?.focus();
}

export function Shell() {
  const state = useAppState();
  const { path } = useLocation();
  const session = state.session.value;
  const handle = state.handle.value;
  const canPublish = state.canPublish.value;

  useEffect(() => {
    document.title = titleFor(path);
  }, [path]);

  return (
    <>
      {/* A plain fragment link (preact-iso leaves #… to the browser); <main tabindex=-1> takes focus. */}
      <a class="skip-link" href="#main">
        Skip to main content
      </a>
      <header class="site-header">
        <a class="brand" href="/feed">
          {APP_NAME}
        </a>
        <nav aria-label="Primary">
          <ul>
            <li>
              <NavLink href="/feed">Feed</NavLink>
            </li>
            {session ? (
              <>
                <li>
                  <NavLink href={`/u/${session.did}`}>My profile</NavLink>
                </li>
                {canPublish ? (
                  <li>
                    <NavLink href="/scrobble">Add scrobble</NavLink>
                  </li>
                ) : null}
                <li>
                  <NavLink href="/settings">Settings</NavLink>
                </li>
              </>
            ) : (
              <li>
                <NavLink href="/signin">Sign in</NavLink>
              </li>
            )}
          </ul>
        </nav>
        {session ? (
          <p class="session-identity">
            <span class="visually-hidden">Signed in as </span>
            {handle ? <span class="handle">@{handle}</span> : null} <code class="did">{session.did}</code>
          </p>
        ) : null}
        {state.reauthRequired.value ? (
          <p class="notice" role="alert">
            Your session has ended. <a href="/signin">Sign in again</a> to keep publishing.
          </p>
        ) : null}
      </header>
      <main id="main" tabIndex={-1}>
        <AppRouter onRouteChange={focusMain} />
      </main>
      <footer class="site-footer">
        <p>Listens are public records in your own AT Protocol repository.</p>
      </footer>
    </>
  );
}

export interface AppProps {
  /** Injected state (tests); a fresh same-origin state otherwise. */
  state?: AppState;
  /** Skip the initial meta request (tests that drive meta themselves). */
  loadMetaOnMount?: boolean;
}

export function App({ state: injected, loadMetaOnMount = true }: AppProps) {
  const state = useMemo(() => injected ?? createAppState(), [injected]);
  useEffect(() => {
    if (!loadMetaOnMount) return;
    const abort = new AbortController();
    void loadMeta(state, abort.signal);
    return () => abort.abort();
  }, [state, loadMetaOnMount]);

  return (
    <AppStateContext.Provider value={state}>
      <LocationProvider>
        <Shell />
      </LocationProvider>
    </AppStateContext.Provider>
  );
}
