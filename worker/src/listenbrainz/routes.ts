// The /1/ dispatcher of the ListenBrainz-compatible API (ADR 0005 §8.1, §8.2,
// §8.7; N3-06).
//
//   const routes = listenBrainzRoutes({ registry: submitAndTokenRoutes, kick });
//   // → RouteDef[] for the composition (node/compose.ts Feature.routes)
//
// It mounts every /1/ route: the reads (read.ts), statistics (stats.ts),
// feedback (feedback.ts) and social reads (social.ts) of this package, and
// the routes handed in through `registry` (N3-05's submit-listens,
// validate-token, delete-listen and playing-now/delete; wired in N4-01, so no
// module of this package imports theirs). Every /1/ route gets, in order:
//
// 1. **Authentication, then the limit, before the handler runs** (and so
//    before any body byte is read, ADR §8.3). The Authorization header is
//    parsed (auth-header.ts); a well-formed one is looked up (lb-tokens.ts
//    `verifyLbToken`, constant-time). The credential-first limiter (N2-08,
//    limiter.ts) then charges a request with a live token to that token's
//    bucket only (100 per 10 s), and every other request to the per-IP bucket
//    (30 per 10 s, keyed by `rateKeyOf(ctx.clientIp)`, LRU-evicting). An
//    authenticated request is therefore never refused because of the per-IP
//    set. A refusal is the 429 with the verbatim brainzutils body,
//    X-RateLimit-* and Retry-After, before any 401 (brainzutils `@ratelimit`
//    runs before the view).
// 2. A route marked `auth: 'required'` then answers a missing, malformed or
//    unknown token with its 401 (ListenBrainz's verbatim texts) without
//    running the handler. Other routes see the outcome in `lb.auth`.
// 3. The handler. An `LbHttpError` it throws is answered `{code, error}`; any
//    other throw is logged by error name and answered 500 `{code: 500, error}`.
// 4. Every answer gets the CORS set (errors.ts) and the X-RateLimit-* set of
//    the bucket that was charged, unless the handler's answer already carries
//    an X-RateLimit-Limit of its own: then its whole set is kept (the daily
//    listen cap's 429 describes the daily window, ADR §8.3, and its
//    X-RateLimit-* must agree with its Retry-After).
//
// OPTIONS on a known /1/ path is 200 with the CORS set and Allow /
// Access-Control-Allow-Methods listing the path's methods. It is never
// authenticated or limited, as ListenBrainz's `crossdomain` answers it before
// `@ratelimit`, so a browser's preflight never spends the budget of the
// request it precedes. The router answers every preflight itself: an OPTIONS
// route in `registry` (N3-05 lists one per path) is not mounted, and its path
// gets the router's uncharged preflight with the methods of its other routes.
// Any other /1/ path, up to
// MAX_FALLBACK_DEPTH non-empty segments with or without a trailing slash, is
// answered by fallback routes registered after every real route: 405 `{code,
// error}` with Allow for a known path and another method, else 404 `{code,
// error}` (werkzeug's texts, as ListenBrainz's API error handler sends them),
// both limited like any request. Unimplemented ListenBrainz endpoints
// (metadata, playlists, sitewide statistics, …) are such 404s.
//
// Registry routes are plain RouteDefs or LbRouteDefs: a RouteDef's handler
// simply ignores the fourth argument. They must not authenticate or charge the
// limiter themselves: this router already has (`lb.auth` is the token check,
// `lb.limit` the decision), and a second guard would verify every token twice
// and charge each request to two limiters.
//
// The limiter lives in memory, one per `listenBrainzRoutes` call (one per
// process), created on the first request from the composition's clock unless
// one is passed in. Cookies are never read.

import type { Clock } from '@atmusic/core/deps';
import { type VerifiedLbToken, verifyLbToken } from '../credentials/lb-tokens';
import { createRouteTable, type RouteTable } from '../http/routes';
import { need, type RequestCtx, ROUTE_METHODS, type RouteDef, type RouteMethod } from '../http/types';
import { type AuthHeaderFailure, parseAuthorization, unauthorized } from './auth-header';
import { applyLbCors, lbError, lbPreflight } from './errors';
import { type FeedbackOptions, feedbackRoutes } from './feedback';
import { type LimitDecision, ListenBrainzLimiter, refusal, type TokenResult } from './limiter';
import { applyRateLimitHeaders } from './rate-headers';
import { LbHttpError, readRoutes } from './read';
import { socialRoutes } from './social';
import { statsRoutes } from './stats';

/** The outcome of a request's token check. */
export type LbAuth =
  /** No usable credential: no header, a malformed one, or one we never look up (another scheme, `meba_`). */
  | { status: 'absent'; failure: AuthHeaderFailure }
  /** A well-formed token that is not a live token. */
  | { status: 'invalid' }
  /** A live token. */
  | { status: 'valid'; token: VerifiedLbToken };

/** What the router hands every /1/ handler. */
export interface LbRequest {
  auth: LbAuth;
  /** The limiter decision this request was charged with (allowed). */
  limit: LimitDecision;
}

/** A /1/ route. A plain RouteDef is one (its handler ignores `lb`). */
export interface LbRouteDef {
  method: RouteMethod;
  /** A pattern under `/1/`. */
  pattern: string;
  /** `required`: the router answers the 401 itself, before the handler (and any body read). */
  auth?: 'required' | 'optional';
  handler(req: Request, ctx: RequestCtx, params: Record<string, string>, lb: LbRequest): Promise<Response>;
}

export interface ListenBrainzRoutesOptions {
  /** More /1/ routes (N3-05's), mounted with the same CORS, limits and fallbacks. */
  registry?: readonly LbRouteDef[];
  /** Default: one created from the composition's clock on the first request. */
  limiter?: ListenBrainzLimiter;
  /** Kicks the outbox after feedback queued a love or unlove. */
  kick?: FeedbackOptions['kick'];
}

/** werkzeug NotFound.description, ListenBrainz's API 404 text. */
export const LB_NOT_FOUND_MESSAGE =
  'The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.';
/** werkzeug MethodNotAllowed.description. */
export const LB_METHOD_NOT_ALLOWED_MESSAGE = 'The method is not allowed for the requested URL.';
/** The 500 text (no ListenBrainz original applies). */
export const LB_INTERNAL_ERROR_MESSAGE = 'An internal server error occurred.';
/** The deepest unknown /1/ path the fallback routes answer with `{code, error}`. */
export const MAX_FALLBACK_DEPTH = 10;

const API_PREFIX = '/1/';

// ---------------------------------------------------------------------------
// Authentication and response decoration

/** Parses the header and looks a well-formed token up (never logged, never echoed). */
export function authenticate(m: Parameters<typeof verifyLbToken>[0], header: string | null): LbAuth {
  const parsed = parseAuthorization(header);
  if (!parsed.ok) return { status: 'absent', failure: parsed.failure };
  const token = verifyLbToken(m, parsed.token);
  return token === null ? { status: 'invalid' } : { status: 'valid', token };
}

function tokenResultOf(auth: LbAuth): TokenResult {
  if (auth.status === 'valid') return { status: 'valid', tokenId: auth.token.id };
  return { status: auth.status };
}

/**
 * `response` with the CORS set and `rateHeaders` (a copy; bodies are streamed
 * through). A response with an X-RateLimit-Limit of its own keeps its set.
 */
function decorate(response: Response, rateHeaders: Readonly<Record<string, string>> | undefined): Response {
  const headers = applyLbCors(new Headers(response.headers));
  if (rateHeaders !== undefined && !headers.has('x-ratelimit-limit')) applyRateLimitHeaders(headers, rateHeaders);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

type Guarded = (lb: LbRequest) => Promise<Response>;

// ---------------------------------------------------------------------------
// The router

/** Every /1/ route of the API, ready for the composition. */
export function listenBrainzRoutes(options: ListenBrainzRoutesOptions = {}): RouteDef[] {
  let limiter: ListenBrainzLimiter | null = options.limiter ?? null;
  const limiterFor = (clock: Clock): ListenBrainzLimiter => {
    limiter ??= new ListenBrainzLimiter(clock);
    return limiter;
  };

  const own: LbRouteDef[] = [
    ...readRoutes(),
    ...statsRoutes(),
    ...feedbackRoutes({ kick: options.kick }),
    ...socialRoutes(),
  ];
  const all: LbRouteDef[] = [...own, ...(options.registry ?? [])];
  for (const route of all) {
    if (!route.pattern.startsWith(API_PREFIX)) throw new TypeError(`not a /1/ route: ${route.pattern}`);
  }

  /** Authenticate, limit, run, decorate (module comment, steps 1, 3 and 4). */
  const guarded = async (req: Request, ctx: RequestCtx, label: string, run: Guarded): Promise<Response> => {
    let rateHeaders: Record<string, string> | undefined;
    try {
      const m = need(ctx, 'deps');
      const auth = authenticate(m, req.headers.get('authorization'));
      const decision = limiterFor(ctx.clock).limit({ clientIp: ctx.clientIp }, tokenResultOf(auth));
      if (!decision.allowed) return refusal(decision);
      rateHeaders = decision.headers;
      return decorate(await run({ auth, limit: decision }), rateHeaders);
    } catch (error) {
      if (error instanceof LbHttpError) return decorate(lbError(error.status, error.message), rateHeaders);
      try {
        ctx.deps?.log.log('error', 'listenbrainz.failed', {
          requestId: ctx.requestId,
          route: label,
          error: errorName(error),
        });
      } catch {
        // A broken log sink never changes an answer.
      }
      return decorate(lbError(500, LB_INTERNAL_ERROR_MESSAGE), rateHeaders);
    }
  };

  const wrap = (route: LbRouteDef): RouteDef => ({
    method: route.method,
    pattern: route.pattern,
    handler: (req, ctx, params) =>
      guarded(req, ctx, route.pattern, async (lb) => {
        if (route.auth === 'required' && lb.auth.status !== 'valid') {
          return unauthorized(lb.auth.status === 'absent' ? lb.auth.failure : 'invalid_token');
        }
        return route.handler(req, ctx, params, lb);
      }),
  });

  // The router's own uncharged OPTIONS for every known path shape (module comment).
  const mounted = all.filter((route) => route.method !== 'OPTIONS');
  const shapeOf = (pattern: string) =>
    pattern
      .split('/')
      .map((s) => (s.length > 2 && s.startsWith('{') && s.endsWith('}') ? '{}' : s))
      .join('/');
  const methodsByShape = new Map<string, { pattern: string; methods: Set<string> }>();
  for (const route of all) {
    const shape = shapeOf(route.pattern);
    const entry = methodsByShape.get(shape) ?? { pattern: route.pattern, methods: new Set<string>() };
    if (route.method !== 'OPTIONS') entry.methods.add(route.method);
    methodsByShape.set(shape, entry);
  }
  const preflights: RouteDef[] = [];
  for (const { pattern, methods } of methodsByShape.values()) {
    const allow = [...methods];
    preflights.push({ method: 'OPTIONS', pattern, handler: async () => lbPreflight(allow) });
  }

  const routes: RouteDef[] = [...mounted.map(wrap), ...preflights];
  const known: RouteTable = createRouteTable(routes);
  return [...routes, ...fallbackRoutes(known, guarded)];
}

/** `/1/`, then `/1/{p0}` … with up to MAX_FALLBACK_DEPTH segments, each with and without a trailing slash. */
export function fallbackPatterns(): string[] {
  const patterns = [API_PREFIX];
  for (let depth = 1; depth <= MAX_FALLBACK_DEPTH; depth++) {
    const path = `${API_PREFIX}${Array.from({ length: depth }, (_, i) => `{p${i}}`).join('/')}`;
    patterns.push(path, `${path}/`);
  }
  return patterns;
}

function fallbackRoutes(
  known: RouteTable,
  guarded: (req: Request, ctx: RequestCtx, label: string, run: Guarded) => Promise<Response>,
): RouteDef[] {
  const answer = (method: RouteMethod, pathname: string): Response => {
    const match = known.match(method, pathname);
    if (match.kind === 'method_not_allowed') {
      const allow = match.allow.includes('GET') ? [...match.allow, 'HEAD'] : match.allow;
      return lbError(405, LB_METHOD_NOT_ALLOWED_MESSAGE, { allow: [...new Set(allow)].sort().join(', ') });
    }
    return lbError(404, LB_NOT_FOUND_MESSAGE);
  };
  const out: RouteDef[] = [];
  for (const method of ROUTE_METHODS) {
    for (const pattern of fallbackPatterns()) {
      out.push({
        method,
        pattern,
        handler: async (req, ctx) => {
          const pathname = new URL(req.url).pathname;
          // A preflight is never limited (module comment).
          if (method === 'OPTIONS') return decorate(answer(method, pathname), undefined);
          return guarded(req, ctx, '(unknown /1/ path)', async () => answer(method, pathname));
        },
      });
    }
  }
  return out;
}
