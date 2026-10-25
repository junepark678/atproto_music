// The Node host's request dispatcher (ADR 0005 §3.1, §3.7, §3.10, §3.11, §13;
// N2-01): what runs behind the HTTP bridge (node/http-bridge.ts) for every
// request, in this order:
//
// 1. `/internal/` (and `/internal`) is the JSON 404 before anything else: the
//    admin routes exist only on the unix socket (ADR §3.11), so nothing about
//    them is revealed on TCP, not even which methods exist.
// 2. The router prefixes — `/api/`, `/health/`, `/oauth/`, `/2.0`, `/2.0/`,
//    `/1/`, `/audioscrobbler/` — and `GET /` (or HEAD) whose query has
//    `hs=true` (an Audioscrobbler 1.2 handshake at the root, ADR §7.10) always
//    reach the route table, even when a file of the same name exists in dist:
//    - a route of the method runs (`invokeRoute`: a throw is the error
//      envelope, a 5xx is logged by route pattern and error name);
//    - HEAD runs the GET route of the path with a body-less GET request, and
//      the answer keeps the status and headers but has no body;
//    - a path with other methods only is 405 `method_not_allowed` with
//      `Allow` listing the registered methods, plus `HEAD` appended when GET
//      is registered (only this dispatcher adds it; `matchRoute` is
//      unchanged);
//    - no route: the JSON 404 envelope, never index.html.
// 3. Otherwise an existing file of the static server (node/static-assets.ts)
//    is served, judged on the raw request target.
// 4. Otherwise `assetMiss` (http/routes.ts): index.html for the SPA routes,
//    else the JSON 404.
//
// Every routed answer carries `x-request-id`, the id of RequestCtx and of any
// error envelope. The request context is built by the composition
// (node/compose.ts) only when a route runs.
//
// Request logs (ADR §3.10, §13). One `request` line per request, at info:
// request id, method, the matched route pattern (or a fixed label for what
// no route answered: `(internal)`, `(not_found)`, `(static)`,
// `(asset_miss)`), status and duration. Never the path of an unrouted
// request, never a query string, never a header or body, on any route
// (credentials travel in the query of /api/auth, /lastfm/authorize,
// /api/v1/links/lastfm/callback, /2.0 and /oauth/callback). The one request
// parameter logged is the Last.fm `method` on `/2.0` and `/2.0/`: from the
// query, or as the /2.0 handler reported it with `noteLastfmMethod`, and only
// as an allowlisted name (`LASTFM_LOG_METHODS`), anything else as
// `(unlisted)`.

import { cryptoRandom, type Random } from '@atmusic/core/deps';
import type { Logger } from '../do/contracts';
import { errorResponse } from '../http/error';
import { newRequestId } from '../http/request-id';
import {
  type AssetFetcher,
  assetMiss,
  createRouteTable,
  invokeRoute,
  lastfmLogMethod,
  notedLastfmMethod,
  REQUEST_ID_HEADER,
  type RouteTable,
  withRequestId,
} from '../http/routes';
import type { RequestCtx, RouteDef } from '../http/types';
import type { StaticAssets } from './static-assets';

/** Prefixes the route table always answers (ADR 0005 §3.7). */
export const ROUTER_PREFIXES: readonly string[] = Object.freeze([
  '/api/',
  '/health/',
  '/oauth/',
  '/2.0/',
  '/1/',
  '/audioscrobbler/',
]);
/** Exact paths the route table answers besides the prefixes (`/2.0` without the slash, §7.1). */
export const ROUTER_EXACT_PATHS: readonly string[] = Object.freeze(['/2.0']);

/** Labels of the request log for answers no route gave. */
export const LOG_ROUTE = {
  internal: '(internal)',
  notFound: '(not_found)',
  static: '(static)',
  assetMiss: '(asset_miss)',
} as const;

/** What the dispatcher needs of the bridge's per-request info. */
export interface DispatchInfo {
  /** The TCP peer address. */
  readonly peer: string | undefined;
  /** The request target as received; the static server judges it, never `request.url`. */
  readonly rawTarget?: string;
}

export interface DispatcherOptions {
  /** The route table (or the routes to compile into one). */
  routes: RouteTable | readonly RouteDef[];
  /** The static files of dist; null serves none (every non-router path is an asset miss). */
  assets: StaticAssets | null;
  /** Builds the request context of a routed request (node/compose.ts). */
  context(request: Request, info: DispatchInfo, requestId: string): RequestCtx;
  log: Logger;
  /** Request ids; cryptoRandom in production. */
  random?: Random;
  /** A monotonic millisecond clock for the logged duration; performance.now by default. */
  now?: () => number;
}

export type Dispatcher = (request: Request, info: DispatchInfo) => Promise<Response>;

/** Whether `pathname` (still percent-encoded) belongs to the route table. */
export function isRouterPath(pathname: string): boolean {
  return ROUTER_EXACT_PATHS.includes(pathname) || ROUTER_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** `GET /?hs=true` (or HEAD): an Audioscrobbler 1.2 handshake sent to the root (ADR §7.10). */
export function isRootHandshake(method: string, url: URL): boolean {
  return (method === 'GET' || method === 'HEAD') && url.pathname === '/' && url.searchParams.get('hs') === 'true';
}

function isInternalPath(pathname: string): boolean {
  return pathname === '/internal' || pathname.startsWith('/internal/');
}

function isLastfmPath(pathname: string): boolean {
  return pathname === '/2.0' || pathname === '/2.0/';
}

/** The same request as a body-less GET (HEAD → the GET route). */
function asGet(request: Request): Request {
  return new Request(request.url, { method: 'GET', headers: request.headers, signal: request.signal });
}

async function withoutBody(response: Response): Promise<Response> {
  await response.body?.cancel().catch(() => undefined);
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** The static server as an AssetFetcher for `assetMiss`: a file, or a 404. */
function fetcherOf(assets: StaticAssets | null): AssetFetcher {
  return {
    async fetch(request) {
      return assets?.serve(request) ?? new Response(null, { status: 404 });
    },
  };
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const table = 'match' in options.routes ? options.routes : createRouteTable(options.routes);
  const random = options.random ?? cryptoRandom;
  const now = options.now ?? (() => performance.now());
  const { log, assets } = options;
  const fetcher = fetcherOf(assets);

  const logRequest = (fields: {
    requestId: string;
    method: string;
    route: string;
    status: number;
    startedMs: number;
    lastfmMethod?: string;
  }): void => {
    const { startedMs, lastfmMethod, ...rest } = fields;
    try {
      log.log('info', 'request', {
        ...rest,
        durationMs: Math.max(0, Math.round(now() - startedMs)),
        ...(lastfmMethod === undefined ? {} : { lastfmMethod }),
      });
    } catch {
      // A broken log sink never changes an answer.
    }
  };

  /** `response` with a request id: its own (an error envelope's), or a new one. */
  const stamped = (response: Response): Response =>
    response.headers.has(REQUEST_ID_HEADER) ? response : withRequestId(response, newRequestId(random));
  const idOf = (response: Response): string => response.headers.get(REQUEST_ID_HEADER) ?? '';

  const routed = async (request: Request, url: URL, info: DispatchInfo, startedMs: number): Promise<Response> => {
    const requestId = newRequestId(random);
    const method = request.method.toUpperCase();
    const head = method === 'HEAD';
    const match = table.match(head ? 'GET' : method, url.pathname);
    const queryMethod = isLastfmPath(url.pathname) ? url.searchParams.get('method') : null;
    const lastfm = queryMethod === null ? undefined : lastfmLogMethod(queryMethod);

    if (match.kind === 'none') {
      const response = withRequestId(errorResponse('not_found', undefined, requestId), requestId);
      logRequest({
        requestId,
        method,
        route: LOG_ROUTE.notFound,
        status: response.status,
        startedMs,
        lastfmMethod: lastfm,
      });
      return head ? withoutBody(response) : response;
    }
    if (match.kind === 'method_not_allowed') {
      const allow = match.allow.includes('GET') ? [...match.allow, 'HEAD'] : match.allow;
      const response = withRequestId(
        errorResponse('method_not_allowed', undefined, requestId, undefined, { headers: { allow: allow.join(', ') } }),
        requestId,
      );
      logRequest({ requestId, method, route: match.pattern, status: response.status, startedMs, lastfmMethod: lastfm });
      return head ? withoutBody(response) : response;
    }

    const handlerRequest = head ? asGet(request) : request;
    let response: Response;
    try {
      const ctx = options.context(handlerRequest, info, requestId);
      response = await invokeRoute(match.route, match.params, handlerRequest, ctx, log);
    } catch (error) {
      // The context builder failed: nothing ran, nothing is revealed.
      log.log('error', 'request.failed', {
        requestId,
        method,
        route: match.route.pattern,
        error: error instanceof Error ? error.name : typeof error,
      });
      response = errorResponse('internal_error', undefined, requestId);
    }
    response = withRequestId(response, requestId);
    logRequest({
      requestId,
      method,
      route: match.route.pattern,
      status: response.status,
      startedMs,
      lastfmMethod: notedLastfmMethod(handlerRequest) ?? lastfm,
    });
    return head ? withoutBody(response) : response;
  };

  return async (request, info) => {
    const startedMs = now();
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (isInternalPath(url.pathname)) {
      const requestId = newRequestId(random);
      const response = withRequestId(errorResponse('not_found', undefined, requestId), requestId);
      logRequest({ requestId, method, route: LOG_ROUTE.internal, status: 404, startedMs });
      return method === 'HEAD' ? withoutBody(response) : response;
    }

    if (isRouterPath(url.pathname) || isRootHandshake(method, url)) return routed(request, url, info, startedMs);

    const served = assets?.serve(request, info.rawTarget) ?? null;
    if (served !== null) {
      const response = stamped(served);
      logRequest({ requestId: idOf(response), method, route: LOG_ROUTE.static, status: response.status, startedMs });
      return response;
    }

    const missed = stamped(await assetMiss(request, url, fetcher, { random, log: () => log }));
    logRequest({ requestId: idOf(missed), method, route: LOG_ROUTE.assetMiss, status: missed.status, startedMs });
    return method === 'HEAD' ? withoutBody(missed) : missed;
  };
}
