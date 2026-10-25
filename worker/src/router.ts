// The Worker's HTTP front (ADR 0004 §1.1, §4.1, §4.3 "Route self-registration",
// §8; API.md v1.1). worker/src/index.ts exports `createWorker()` from here.
//
// The Workers entry only (ADR 0005 §3.1, N2-01). The host-neutral parts —
// ROUTES, matchRoute and the route matching rules, invokeRoute, assetMiss,
// safeAssetPath, servesSpaIndex and matchSpaRoute — live in
// worker/src/http/routes.ts and are re-exported from here unchanged, so the
// workerd suites and the Workers entry keep their imports until N7-01 deletes
// this file. The Node composition (worker/src/node/compose.ts) never imports
// this module.
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
import { LOCATION_HINTS, parseCursorKey } from './config';
import type { IndexRpc, Logger } from './do/contracts';
import { envLogger, INDEX_NAME } from './do/index-do';
import type { Env } from './env';
import { errorResponse } from './http/error';
import { live } from './http/health';
import { newRequestId } from './http/request-id';
import { assetMiss, INTERNAL_HEADER_PREFIX, invokeRoute, matchRoute, withRequestId } from './http/routes';
import type { RequestCtx } from './http/types';
import { scheduled } from './scheduled';

export {
  type AssetFetcher,
  type AssetMissDeps,
  assetMiss,
  createRouteTable,
  INTERNAL_HEADER_PREFIX,
  invokeRoute,
  matchRoute,
  matchSpaRoute,
  REQUEST_ID_HEADER,
  ROUTES,
  type RouteMatch,
  type RouteTable,
  safeAssetPath,
  servesSpaIndex,
  withRequestId,
} from './http/routes';

/** Path prefixes the Worker answers itself (wrangler.jsonc `run_worker_first`). */
export const WORKER_PREFIXES: readonly string[] = ['/api/', '/health/', '/internal/'];

export const CLIENT_IP_HEADER = 'x-atmusic-client-ip';
/** RequestCtx.clientIp when CF-Connecting-IP is absent (never in production). */
export const UNKNOWN_CLIENT_IP = 'unknown';

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
  return invokeRoute(match.route, match.params, req, ctx, log);
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

export async function handleFetch(request: Request, env: Env, deps: WorkerDeps): Promise<Response> {
  const { request: req, clientIp } = sanitizeRequest(request);
  const url = new URL(req.url);
  if (!isWorkerPath(url.pathname)) {
    return assetMiss(req, url, env.ASSETS, { random: deps.random, log: () => (deps.log ?? envLogger)(env) });
  }

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
