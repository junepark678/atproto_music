// The SPA route table, shared by the SPA router (web/src/router.tsx) and the
// Worker's Static Assets miss handling (worker/src/router.ts, ADR 0004 §15 Q9).
// Pure data plus segment matching: no preact, no I/O, so the Worker can import
// it without bundling the SPA.
//
// Matching follows the preact-iso Router: a path matches a route when both
// have the same number of non-empty `/` segments and every literal segment is
// equal; a `:name` segment matches any one non-empty segment. `/u/:did`
// therefore matches the raw DID form (`/u/did:plc:…`, `/u/did:web:host`) and
// the percent-encoded one (`/u/did%3Aplc%3A…`) alike.

export type SpaRouteModule = 'feed' | 'signin' | 'callback' | 'profile' | 'scrobble' | 'settings';

export interface SpaRoute {
  path: string;
  module: SpaRouteModule;
  /** Human title used by the placeholder and the document title. */
  title: string;
}

/** Every SPA route. `/` is the global feed. */
export const SPA_ROUTES: readonly SpaRoute[] = [
  { path: '/', module: 'feed', title: 'Feed' },
  { path: '/feed', module: 'feed', title: 'Feed' },
  { path: '/signin', module: 'signin', title: 'Sign in' },
  { path: '/oauth/callback', module: 'callback', title: 'Signing in' },
  { path: '/u/:did', module: 'profile', title: 'Profile' },
  { path: '/scrobble', module: 'scrobble', title: 'Add a scrobble' },
  { path: '/settings', module: 'settings', title: 'Settings' },
];

/** The route a path renders (same segment rules as the preact-iso Router), if any. */
export function matchSpaRoute(path: string): SpaRoute | undefined {
  const segments = path.split('/').filter(Boolean);
  return SPA_ROUTES.find((entry) => {
    const pattern = entry.path.split('/').filter(Boolean);
    return (
      pattern.length === segments.length &&
      pattern.every((part, i) => (part.startsWith(':') ? segments[i] !== '' : part === segments[i]))
    );
  });
}
