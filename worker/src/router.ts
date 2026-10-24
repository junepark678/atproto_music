// The Worker's HTTP front (ADR 0004 §1.1, §4.1, §4.3 "Route self-registration",
// §8; API.md v1.1). worker/src/index.ts exports `createWorker()` from here.
//
// Routes. Every worker/src/http/<name>.ts module exports `routes: RouteDef[]`;
// this is the only file that concatenates them. A pattern is matched segment
// by segment against the *raw* (still percent-encoded) path, so an encoded `/`
// (`%2F`, the AT URI of `/api/v1/scrobbles/{id}`) stays inside its segment; a
// `{name}` segment matches exactly one non-empty segment and is passed to the
// handler percent-decoded once (the raw form when it does not decode).
//
// `dispatch` outcomes:
// - a matching route: its handler. A handler that throws is answered with the
//   error envelope (`toErrorResponse`: an ApiError keeps its code, anything
//   else is a generic 500 that reveals nothing, M1.4.2 safe_errors) and the
//   failure is logged by request id, route and error name only;
// - a known path with another method: 405 `method_not_allowed` with `Allow`
//   (under `/internal/` the plain 404 instead, see http/admin.ts);
// - no route under a Worker-first prefix (`/api/`, `/health/`, `/internal/`,
//   the `run_worker_first` list of worker/wrangler.jsonc): the JSON 404
//   envelope, never the SPA's index.html.
//
// `handleFetch` (the Worker `fetch`):
// - inbound `x-atmusic-*` headers are stripped before anything reads the
//   request, and `x-atmusic-client-ip` is set from `CF-Connecting-IP` (the
//   address Cloudflare saw, which a client cannot forge); that address is also
//   RequestCtx.clientIp, the notify per-IP bucket key (ADR §8);
// - paths outside the Worker-first prefixes reach the Worker only on a Static
//   Assets miss (wrangler.jsonc `not_found_handling: "none"`). They are
//   answered by `assetMiss` (ADR 0004 §15 Q9), deciding by path as the Rust
//   oracle's asset fallback does (crates/server/src/http/assets.rs):
//   - a method other than GET/HEAD, or a path that fails the oracle's
//     `safe_path` (an encoded `/`, `\` or `%`, a control character, a `.` or
//     `..` segment, invalid UTF-8): the JSON not_found envelope, ASSETS
//     untouched;
//   - otherwise the request goes to ASSETS without any `x-atmusic-*` header;
//     any answer but 404 is returned as is;
//   - on a 404, a path of the SPA route table (@atmusic/core/spa-routes, the
//     table web/src/router.tsx renders: `/`, `/feed`, `/oauth/callback`,
//     `/u/<did>` raw or percent-encoded, ...) gets index.html, fetched from
//     ASSETS at `/` with the same method, as a 200 with no redirect; every
//     other miss (`/assets/*`, unknown paths) is the JSON not_found envelope;
//   - platform exception: a non-GET/HEAD to an existing file (`/` itself, a
//     hashed asset) is not a miss, so Static Assets answers it with its own
//     bare 405 and the Worker never runs (docs/deploy/routing.md);
// - every Worker response carries a v4 UUID request id (`x-request-id`) drawn
//   from the injected Random, the same id every error envelope carries;
// - `GET /health/live` is answered here, without the IndexDO or the key;
// - the cursor HMAC key is derived from CURSOR_KEY once per isolate (cached
//   per secret value); a CURSOR_KEY that does not parse makes every other
//   Worker route 503 `not_ready`, logged without its value;
// - the IndexDO stub is `INDEX.get(INDEX.idFromName('index-v1'),
//   {locationHint: DO_LOCATION_HINT})`, created only when a route needs it.
//
// Test entries reuse `createWorker` with a frozen clock, a seeded Random and a
// per-test IndexDO name (ADR §4.4, §10.2, A18); production passes nothing.

import { deriveCursorKey } from '@atmusic/core/cursor';
import { type Clock, cryptoRandom, type Random, systemClock } from '@atmusic/core/deps';
import { matchSpaRoute } from '@atmusic/core/spa-routes';
import { LOCATION_HINTS, parseCursorKey } from './config';
import type { IndexRpc, Logger } from './do/contracts';
import { envLogger, INDEX_NAME } from './do/index-do';
import type { Env } from './env';
import { routes as adminRoutes } from './http/admin';
import { errorResponse, toErrorResponse } from './http/error';
import { routes as exportRoutes } from './http/export';
import { routes as feedRoutes } from './http/feed';
import { routes as followsReadRoutes } from './http/follows-read';
import { routes as healthRoutes, live } from './http/health';
import { routes as metaRoutes } from './http/meta';
import { routes as notifyRoutes } from './http/notify';
import { routes as profileRoutes } from './http/profile';
import { routes as recordStatusRoutes } from './http/record-status';
import { newRequestId } from './http/request-id';
import { routes as resolveRoutes } from './http/resolve';
import { routes as scrobblesReadRoutes } from './http/scrobbles-read';
import { routes as statsRoutes } from './http/stats';
import type { RequestCtx, RouteDef } from './http/types';
import { scheduled } from './scheduled';

/** Every route the Worker serves, in registration order. */
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

/** Path prefixes the Worker answers itself (wrangler.jsonc `run_worker_first`). */
export const WORKER_PREFIXES: readonly string[] = ['/api/', '/health/', '/internal/'];

/** Header prefix reserved for values the Worker itself sets. */
export const INTERNAL_HEADER_PREFIX = 'x-atmusic-';
export const CLIENT_IP_HEADER = 'x-atmusic-client-ip';
export const REQUEST_ID_HEADER = 'x-request-id';
/** RequestCtx.clientIp when CF-Connecting-IP is absent (never in production). */
export const UNKNOWN_CLIENT_IP = 'unknown';

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

const COMPILED: readonly CompiledRoute[] = compileRoutes(ROUTES);

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
  | { kind: 'method_not_allowed'; allow: string[] }
  | { kind: 'none' };

/** Resolve `method` + raw `pathname` against ROUTES. */
export function matchRoute(method: string, pathname: string): RouteMatch {
  const path = pathname.split('/');
  const allow = new Set<string>();
  for (const compiled of COMPILED) {
    const params = matchSegments(compiled, path);
    if (params === null) continue;
    if (compiled.route.method === method) return { kind: 'route', route: compiled.route, params };
    allow.add(compiled.route.method);
  }
  if (allow.size > 0) return { kind: 'method_not_allowed', allow: [...allow].sort() };
  return { kind: 'none' };
}

/** Whether the Worker (not ASSETS) owns `pathname`. */
export function isWorkerPath(pathname: string): boolean {
  return WORKER_PREFIXES.some((p) => pathname.startsWith(p) || pathname === p.slice(0, -1));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Dispatch `req` (already stripped of inbound `x-atmusic-*` headers) through
 * ROUTES. Returns null when the path is not the Worker's (ASSETS serves it).
 */
export async function dispatch(req: Request, ctx: RequestCtx, log: Logger): Promise<Response | null> {
  const url = new URL(req.url);
  const match = matchRoute(req.method, url.pathname);
  if (match.kind === 'none') {
    return isWorkerPath(url.pathname) ? errorResponse('not_found', undefined, ctx.requestId) : null;
  }
  if (match.kind === 'method_not_allowed') {
    // The admin surface does not reveal which methods exist (http/admin.ts).
    if (url.pathname.startsWith('/internal/')) return errorResponse('not_found', undefined, ctx.requestId);
    return errorResponse('method_not_allowed', undefined, ctx.requestId, undefined, {
      headers: { allow: match.allow.join(', ') },
    });
  }
  const { route, params } = match;
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

// ---------------------------------------------------------------------------
// The Worker fetch

/** The IndexDO stub (ADR §4.1): `INDEX.get(INDEX.idFromName(name), {locationHint})`. */
export function indexStub(env: Pick<Env, 'INDEX' | 'DO_LOCATION_HINT'>, name: string = INDEX_NAME): IndexRpc {
  const hint = (env.DO_LOCATION_HINT ?? '').trim();
  const options =
    hint !== '' && (LOCATION_HINTS as readonly string[]).includes(hint)
      ? { locationHint: hint as DurableObjectLocationHint }
      : undefined;
  return env.INDEX.get(env.INDEX.idFromName(name), options) as unknown as IndexRpc;
}

export interface WorkerDeps {
  clock: Clock;
  random: Random;
  /** The IndexDO name (default `index-v1`). */
  indexName?: string;
  /** Default: the redacting Workers Logs logger for the request's env. */
  log?: (env: Env) => Logger;
}

export const PRODUCTION_DEPS: WorkerDeps = { clock: systemClock, random: cryptoRandom };

let cursorKeyCache: { raw: string; key: Promise<CryptoKey> } | null = null;

/** The cursor HMAC key for `env.CURSOR_KEY`, derived once per isolate and secret value. */
export function cursorKeyFor(env: Pick<Env, 'CURSOR_KEY'>): Promise<CryptoKey> {
  const raw = env.CURSOR_KEY ?? '';
  if (cursorKeyCache !== null && cursorKeyCache.raw === raw) return cursorKeyCache.key;
  const key = (async () => deriveCursorKey(parseCursorKey(env)))();
  const entry = { raw, key };
  cursorKeyCache = entry;
  // A failure is not cached: the next request derives again.
  key.catch(() => {
    if (cursorKeyCache === entry) cursorKeyCache = null;
  });
  return key;
}

/** A copy of `request` without inbound `x-atmusic-*` headers, plus the trusted client IP. */
export function sanitizeRequest(request: Request): { request: Request; clientIp: string } {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!name.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX)) headers.append(name, value);
  }
  const clientIp = request.headers.get('cf-connecting-ip')?.trim() || UNKNOWN_CLIENT_IP;
  headers.set(CLIENT_IP_HEADER, clientIp);
  return { request: new Request(request, { headers }), clientIp };
}

function withRequestId(response: Response, requestId: string): Response {
  const out = new Response(response.body, response);
  out.headers.set(REQUEST_ID_HEADER, requestId);
  return out;
}

// ---------------------------------------------------------------------------
// Static Assets misses (ADR 0004 §15 Q9)

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

/** Whether a Static Assets miss of `method` `rawPath` is answered with index.html. */
export function servesSpaIndex(method: string, rawPath: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = safeAssetPath(rawPath);
  return path !== null && matchSpaRoute(path) !== undefined;
}

function notFound(deps: WorkerDeps): Response {
  const requestId = newRequestId(deps.random);
  return withRequestId(errorResponse('not_found', undefined, requestId), requestId);
}

/** A request outside the Worker prefixes: what Static Assets did not serve (module comment). */
async function assetMiss(req: Request, url: URL, env: Env, deps: WorkerDeps): Promise<Response> {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || safeAssetPath(url.pathname) === null) return notFound(deps);
  const headers = new Headers(req.headers);
  headers.delete(CLIENT_IP_HEADER);
  const asset = await env.ASSETS.fetch(new Request(req, { headers }));
  if (asset.status !== 404) return asset;
  await asset.body?.cancel();
  if (!servesSpaIndex(req.method, url.pathname)) return notFound(deps);
  const index = await env.ASSETS.fetch(
    new Request(new URL('/', url), { method: req.method, headers, redirect: 'manual' }),
  );
  // Never a redirect: only index.html itself (or its 304 revalidation) is the SPA.
  if (index.status !== 200 && index.status !== 304) {
    (deps.log ?? envLogger)(env).log('error', 'assets.index_unavailable', { status: index.status });
    return notFound(deps);
  }
  const requestId = newRequestId(deps.random);
  return withRequestId(index, requestId);
}

export async function handleFetch(request: Request, env: Env, deps: WorkerDeps): Promise<Response> {
  const { request: req, clientIp } = sanitizeRequest(request);
  const url = new URL(req.url);
  if (!isWorkerPath(url.pathname)) return assetMiss(req, url, env, deps);

  const requestId = newRequestId(deps.random);
  if (req.method === 'GET' && url.pathname === '/health/live') return withRequestId(await live(), requestId);

  const log = (deps.log ?? envLogger)(env);
  let cursorKey: CryptoKey;
  try {
    cursorKey = await cursorKeyFor(env);
  } catch (error) {
    log.log('error', 'config.cursor_key_invalid', { requestId, error: errorName(error) });
    return withRequestId(errorResponse('not_ready', undefined, requestId), requestId);
  }

  let index: IndexRpc | null = null;
  const ctx: RequestCtx = {
    env,
    get index(): IndexRpc {
      index ??= indexStub(env, deps.indexName ?? INDEX_NAME);
      return index;
    },
    requestId,
    clock: deps.clock,
    cursorKey,
    clientIp,
  };
  let response: Response | null;
  try {
    response = await dispatch(req, ctx, log);
  } catch (error) {
    log.log('error', 'request.failed', { requestId, path: url.pathname, error: errorName(error) });
    response = errorResponse('internal_error', undefined, requestId);
  }
  // dispatch returns null only outside the Worker prefixes, handled above.
  return withRequestId(response ?? errorResponse('not_found', undefined, requestId), requestId);
}

/** The Worker's handlers over `deps` (production: system clock and crypto randomness). */
export function createWorker(deps: WorkerDeps = PRODUCTION_DEPS) {
  return {
    fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
      return handleFetch(request, env, deps);
    },
    scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
      return scheduled(controller, indexStub(env, deps.indexName ?? INDEX_NAME), (deps.log ?? envLogger)(env));
    },
  } satisfies ExportedHandler<Env>;
}
