// SPA route table (preact-iso). On a Static Assets miss the Worker serves
// index.html (200, no redirect) for a GET or HEAD of exactly these paths and
// the JSON not_found envelope for anything else (ADR 0004 §15 Q9), so these
// paths are deep-linkable.
//
// Route screens are owned by later packages and load lazily:
//   web/src/routes/feed.tsx, signin.tsx, profile.tsx, scrobble.tsx,
//   settings.tsx (W3-06) and callback.tsx (W2-06).
// Each module default-exports its screen component. They are discovered with
// `import.meta.glob`, so adding a screen file needs no edit here; until a file
// exists, its route renders a labelled placeholder.

import {
  SPA_ROUTES as ROUTES,
  type SpaRoute as RouteEntry,
  type SpaRouteModule as RouteModule,
} from '@atmusic/core/spa-routes';
import { type AnyComponent, Component, type ComponentChildren } from 'preact';
import { lazy, Route, Router, useLocation } from 'preact-iso';

// The route table itself lives in @atmusic/core/spa-routes, so the Worker's
// asset-miss handling (worker/src/router.ts, ADR 0004 §15 Q9) serves
// index.html for exactly these paths without importing preact.
export {
  matchSpaRoute as matchRoute,
  SPA_ROUTES as ROUTES,
  type SpaRoute as RouteEntry,
  type SpaRouteModule as RouteModule,
} from '@atmusic/core/spa-routes';

type ScreenModule = { default: AnyComponent<Record<string, unknown>> };

const screenLoaders = import.meta.glob<ScreenModule>('./routes/*.tsx');

function placeholder(title: string): AnyComponent<Record<string, unknown>> {
  function Placeholder() {
    return (
      <section aria-labelledby="page-title">
        <h1 id="page-title">{title}</h1>
        <p>This screen is not available yet.</p>
      </section>
    );
  }
  Placeholder.displayName = `Placeholder(${title})`;
  return Placeholder;
}

const screens = new Map<RouteModule, AnyComponent<Record<string, unknown>>>();

/** The (lazy) component for a route module, or a placeholder when the module does not exist yet. */
export function screenFor(entry: RouteEntry): AnyComponent<Record<string, unknown>> {
  let screen = screens.get(entry.module);
  if (!screen) {
    const load = screenLoaders[`./routes/${entry.module}.tsx`];
    // A failed chunk load renders ScreenLoadError instead of suspending forever.
    screen = load
      ? lazy(() =>
          load().then(
            (m) => m.default,
            (): AnyComponent<Record<string, unknown>> => ScreenLoadError,
          ),
        )
      : placeholder(entry.title);
    screens.set(entry.module, screen);
  }
  return screen;
}

export function NotFound() {
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Page not found</h1>
      <p>There is nothing at this address.</p>
      <p>
        <a href="/feed">Go to the feed</a>
      </p>
    </section>
  );
}

export function ScreenLoadError() {
  return (
    <section aria-labelledby="page-title" role="alert">
      <h1 id="page-title">This screen could not be loaded</h1>
      <p>Check your connection and reload the page.</p>
    </section>
  );
}

interface BoundaryProps {
  children?: ComponentChildren;
  /** The current location; a change clears a previous failure. */
  url: string;
  onError?: (error: unknown) => void;
}

/** Catches a render error in a screen so the shell (navigation, skip link) stays usable. */
class ScreenBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static override getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  override componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.failed && previous.url !== this.props.url) this.setState({ failed: false });
  }

  override render() {
    return this.state.failed ? <ScreenLoadError /> : this.props.children;
  }
}

export interface AppRouterProps {
  onRouteChange?: (url: string) => void;
  onScreenError?: (error: unknown) => void;
}

export function AppRouter({ onRouteChange, onScreenError }: AppRouterProps) {
  const { url } = useLocation();
  return (
    <ScreenBoundary url={url} onError={onScreenError}>
      <Router onRouteChange={onRouteChange}>
        {[
          ...ROUTES.map((entry) => <Route key={entry.path} path={entry.path} component={screenFor(entry)} />),
          <Route key="not-found" default component={NotFound} />,
        ]}
      </Router>
    </ScreenBoundary>
  );
}
