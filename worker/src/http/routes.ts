// The host-neutral route table and the asset-miss rules (ADR 0004 §4.3, §15
// Q9; ADR 0005 §3.1, §3.7; N2-01), moved out of worker/src/router.ts so the
// Node composition never imports the Workers entry. router.ts re-exports
// everything here until N7-01 deletes it.
//
// This module imports only host-neutral code: the route modules under http/,
// @atmusic/core and type-only imports. It never imports do/index-do.ts,
// env.ts (except as types), router.ts, scheduled.ts or any `cloudflare:*`
// module; worker/test/node/compose.test.ts proves that over the bundled import
// graph, and the Node bundle guard (ADR §3.9) does it for main.mjs.
//
// Routes. Every worker/src/http/<name>.ts module exports `routes: RouteDef[]`;
// ROUTES concatenates the /api/v1 ones. A pattern is matched segment by
// segment against the *raw* (still percent-encoded) path, so an encoded `/`
// (`%2F`, the AT URI of `/api/v1/scrobbles/{id}`) stays inside its segment; a
// `{name}` segment matches exactly one non-empty segment and is passed to the
// handler percent-decoded once (the raw form when it does not decode).
// `createRouteTable` compiles any list (the Node composition adds the feature
// routes); two routes of one method and shape are refused.
//
// `matchRoute(method, path)`:
// - a route of that method: the route and its params;
// - a known path with other methods only: `method_not_allowed` with the
//   registered methods, sorted (`POST /api/v1/meta` → `Allow: GET`, pinned on
//   workerd by composition/routing.test.ts). HEAD is not added here: only the
//   Node dispatcher maps HEAD and appends it to its own 405 answers;
// - otherwise `none`.
//
// `invokeRoute` runs a matched handler: a handler that throws is answered with
// the error envelope (`toErrorResponse`: an ApiError keeps its code, anything
// else is a generic 500 that reveals nothing, M1.4.2 safe_errors) and the
// failure is logged by request id, method, route pattern and error name only.
//
// Asset misses (ADR 0004 §15 Q9), deciding by path as the Rust oracle's asset
// fallback does (crates/server/src/http/assets.rs). `assetMiss` answers a
// request the host's static files did not serve:
//   - a method other than GET/HEAD, or a path that fails the oracle's
//     `safe_path` (an encoded `/`, `\` or `%`, a control character, a `.` or
//     `..` segment, invalid UTF-8): the JSON not_found envelope, the assets
//     untouched;
//   - otherwise the request goes to the assets without any `x-atmusic-*`
//     header; any answer but 404 is returned as is;
//   - on a 404, a path of the SPA route table (@atmusic/core/spa-routes, the
//     table web/src/router.tsx renders: `/`, `/feed`, `/oauth/callback`,
//     `/u/<did>` raw or percent-encoded, ...) gets index.html, fetched from
//     the assets at `/` with the same method, as a 200 with no redirect;
//     every other miss (`/assets/*`, unknown paths) is the JSON not_found
//     envelope.
// The assets are any `AssetFetcher`: the Workers ASSETS binding, or the Node
// static server (worker/src/node/static-assets.ts) through node/dispatch.ts.

import type { Random } from '@atmusic/core/deps';
import { matchSpaRoute } from '@atmusic/core/spa-routes';
import type { Logger } from '../do/contracts';
import { routes as adminRoutes } from './admin';
import { errorResponse, toErrorResponse } from './error';
import { routes as exportRoutes } from './export';
import { routes as feedRoutes } from './feed';
import { routes as followsReadRoutes } from './follows-read';
import { routes as healthRoutes } from './health';
import { routes as metaRoutes } from './meta';
import { routes as notifyRoutes } from './notify';
import { routes as profileRoutes } from './profile';
import { routes as recordStatusRoutes } from './record-status';
import { newRequestId } from './request-id';
import { routes as resolveRoutes } from './resolve';
import { routes as scrobblesReadRoutes } from './scrobbles-read';
import { routes as statsRoutes } from './stats';
import type { RequestCtx, RouteDef } from './types';

export { matchSpaRoute };

/** Every /api/v1, health and (Workers-only, until N7-01) admin route, in registration order. */
export const ROUTES: readonly RouteDef[] = [
  ...healthRoutes,
  ...metaRoutes,
  ...resolveRoutes,
  ...scrobblesReadRoutes,
  ...feedRoutes,
  ...profileRoutes,
  ...statsRoutes,
  ...followsReadRoutes,
  ...exportRoutes,
  ...notifyRoutes,
  ...recordStatusRoutes,
  ...adminRoutes,
];

/** Header prefix reserved for values the server itself sets. */
export const INTERNAL_HEADER_PREFIX = 'x-atmusic-';
export const REQUEST_ID_HEADER = 'x-request-id';

// ---------------------------------------------------------------------------
// Route matching

interface CompiledRoute {
  route: RouteDef;
  segments: readonly string[];
}

function isParam(segment: string): boolean {
  return segment.length > 2 && segment.startsWith('{') && segment.endsWith('}');
}

function compileRoutes(routes: readonly RouteDef[]): CompiledRoute[] {
  const seen = new Set<string>();
  return routes.map((route) => {
    if (!route.pattern.startsWith('/')) throw new TypeError(`route pattern must start with '/': ${route.pattern}`);
    const segments = route.pattern.split('/');
    // Two routes of one method and shape would make dispatch order-dependent.
    const shape = `${route.method} ${segments.map((s) => (isParam(s) ? '{}' : s)).join('/')}`;
    if (seen.has(shape)) throw new Error(`duplicate route ${shape}`);
    seen.add(shape);
    return { route, segments };
  });
}

function decodeOnce(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Params of `compiled` for the raw path segments, or null when it does not match. */
function matchSegments(compiled: CompiledRoute, path: readonly string[]): Record<string, string> | null {
  if (compiled.segments.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < path.length; i++) {
    const want = compiled.segments[i] as string;
    const got = path[i] as string;
    if (isParam(want)) {
      if (got === '') return null;
      params[want.slice(1, -1)] = decodeOnce(got);
    } else if (want !== got) {
      return null;
    }
  }
  return params;
}

export type RouteMatch =
  | { kind: 'route'; route: RouteDef; params: Record<string, string> }
  | {
      kind: 'method_not_allowed';
      /** The registered methods of the path, sorted (the `Allow` value, comma-joined). */
      allow: string[];
      /** The first pattern of the path in registration order (for request logs). */
      pattern: string;
    }
  | { kind: 'none' };

/** A compiled route list. */
export interface RouteTable {
  readonly routes: readonly RouteDef[];
  /** Resolve `method` + raw `pathname` (module comment). */
  match(method: string, pathname: string): RouteMatch;
}

/** Compiles `routes`; throws on a pattern without a leading `/` or a duplicate method and shape. */
export function createRouteTable(routes: readonly RouteDef[]): RouteTable {
  const compiled = compileRoutes(routes);
  const frozen = Object.freeze([...routes]);
  return {
    routes: frozen,
    match(method, pathname) {
      const path = pathname.split('/');
      const allow = new Set<string>();
      let pattern: string | null = null;
      for (const entry of compiled) {
        const params = matchSegments(entry, path);
        if (params === null) continue;
        if (entry.route.method === method) return { kind: 'route', route: entry.route, params };
        allow.add(entry.route.method);
        pattern ??= entry.route.pattern;
      }
      if (pattern !== null) return { kind: 'method_not_allowed', allow: [...allow].sort(), pattern };
      return { kind: 'none' };
    },
  };
}

const TABLE: RouteTable = createRouteTable(ROUTES);

/** Resolve `method` + raw `pathname` against ROUTES. */
export function matchRoute(method: string, pathname: string): RouteMatch {
  return TABLE.match(method, pathname);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Runs a matched route's handler; a throw becomes the error envelope (module comment). */
export async function invokeRoute(
  route: RouteDef,
  params: Record<string, string>,
  req: Request,
  ctx: RequestCtx,
  log: Logger,
): Promise<Response> {
  let response: Response;
  try {
    response = await route.handler(req, ctx, params);
  } catch (error) {
    response = toErrorResponse(error, ctx.requestId);
    if (response.status >= 500) {
      log.log('error', 'request.failed', {
        requestId: ctx.requestId,
        method: route.method,
        route: route.pattern,
        status: response.status,
        error: errorName(error),
      });
    }
    return response;
  }
  if (response.status >= 500) {
    log.log('warn', 'request.server_error', {
      requestId: ctx.requestId,
      method: route.method,
      route: route.pattern,
      status: response.status,
    });
  }
  return response;
}

/** `response` with `x-request-id: requestId` (a copy, so immutable platform headers are never touched). */
export function withRequestId(response: Response, requestId: string): Response {
  const out = new Response(response.body, response);
  out.headers.set(REQUEST_ID_HEADER, requestId);
  return out;
}

// ---------------------------------------------------------------------------
// Asset misses (ADR 0004 §15 Q9)

const HEX = /^[0-9A-Fa-f]{2}$/;
// fatal: invalid UTF-8 is rejected; ignoreBOM: a BOM is kept, as Rust's from_utf8 keeps it.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The oracle's `safe_path` (crates/server/src/http/assets.rs): `rawPath`
 * percent-decoded once, or null when it encodes `/`, `\` or `%`, holds a
 * control character or `\`, has a malformed escape, does not decode to UTF-8,
 * or has a `.` or `..` segment.
 */
export function safeAssetPath(rawPath: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < rawPath.length; ) {
    let byte: number;
    if (rawPath[i] === '%') {
      const hex = rawPath.slice(i + 1, i + 3);
      if (!HEX.test(hex)) return null;
      byte = Number.parseInt(hex, 16);
      if (byte === 0x2f || byte === 0x5c || byte === 0x25) return null;
      i += 3;
    } else {
      byte = rawPath.charCodeAt(i);
      // A URL pathname is ASCII; anything else did not come from the URL parser.
      if (byte > 0x7f) return null;
      i += 1;
    }
    if (byte < 0x20 || byte === 0x7f || byte === 0x5c) return null;
    bytes.push(byte);
  }
  let path: string;
  try {
    path = UTF8.decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return path;
}

/** Whether an asset miss of `method` `rawPath` is answered with index.html. */
export function servesSpaIndex(method: string, rawPath: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = safeAssetPath(rawPath);
  return path !== null && matchSpaRoute(path) !== undefined;
}

/** The static files: the Workers ASSETS binding, or the Node static server. A miss is a 404. */
export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface AssetMissDeps {
  /** Request ids of the not_found envelopes. */
  random: Random;
  /** The logger, built only when something must be logged. */
  log: () => Logger;
}

function notFound(random: Random): Response {
  const requestId = newRequestId(random);
  return withRequestId(errorResponse('not_found', undefined, requestId), requestId);
}

/** A request the static files did not serve (module comment). */
export async function assetMiss(req: Request, url: URL, assets: AssetFetcher, deps: AssetMissDeps): Promise<Response> {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || safeAssetPath(url.pathname) === null) {
    return notFound(deps.random);
  }
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    if (!name.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX)) headers.append(name, value);
  }
  const asset = await assets.fetch(new Request(req, { headers }));
  if (asset.status !== 404) return asset;
  await asset.body?.cancel();
  if (!servesSpaIndex(req.method, url.pathname)) return notFound(deps.random);
  const index = await assets.fetch(new Request(new URL('/', url), { method: req.method, headers, redirect: 'manual' }));
  // Never a redirect: only index.html itself (or its 304 revalidation) is the SPA.
  if (index.status !== 200 && index.status !== 304) {
    await index.body?.cancel();
    deps.log().log('error', 'assets.index_unavailable', { status: index.status });
    return notFound(deps.random);
  }
  const requestId = newRequestId(deps.random);
  return withRequestId(index, requestId);
}

// ---------------------------------------------------------------------------
// Request-log annotations (ADR 0005 §3.10, §13)

/**
 * The Last.fm 2.0 method names a request log may carry (ADR 0005 §7.5): the
 * only request parameter that is ever logged, and only on `/2.0`. Any other
 * value is logged as `(unlisted)`, never verbatim.
 */
export const LASTFM_LOG_METHODS: readonly string[] = Object.freeze([
  'auth.getToken',
  'auth.getSession',
  'auth.getMobileSession',
  'track.scrobble',
  'track.updateNowPlaying',
  'track.love',
  'track.unlove',
  'library.removeScrobble',
  'user.getTrackScrobbles',
  'user.getRecentTracks',
  'user.getInfo',
  'user.getTopArtists',
  'user.getTopAlbums',
  'user.getTopTracks',
  'user.getLovedTracks',
  'user.getWeeklyChartList',
  'user.getWeeklyArtistChart',
  'user.getWeeklyAlbumChart',
  'user.getWeeklyTrackChart',
  'user.getFriends',
  'library.getArtists',
  'track.getInfo',
  'artist.getInfo',
  'album.getInfo',
  'user.getTopTags',
  'artist.getTopTags',
  'track.getTopTags',
  'album.getTopTags',
]);

const LASTFM_BY_LOWER: ReadonlyMap<string, string> = new Map(LASTFM_LOG_METHODS.map((m) => [m.toLowerCase(), m]));
export const UNLISTED_LASTFM_METHOD = '(unlisted)';

/** The allowlisted spelling of a Last.fm `method` value, or `(unlisted)`. */
export function lastfmLogMethod(value: string): string {
  return LASTFM_BY_LOWER.get(value.toLowerCase()) ?? UNLISTED_LASTFM_METHOD;
}

const notedLastfmMethods = new WeakMap<Request, string>();

/**
 * Lets a /2.0 handler report the `method` it parsed from a form body, which
 * the dispatcher never reads. Only the allowlisted name (or `(unlisted)`)
 * reaches the request log.
 */
export function noteLastfmMethod(request: Request, method: string): void {
  notedLastfmMethods.set(request, lastfmLogMethod(method));
}

/** What `noteLastfmMethod` recorded for `request`, if anything. */
export function notedLastfmMethod(request: Request): string | undefined {
  return notedLastfmMethods.get(request);
}
