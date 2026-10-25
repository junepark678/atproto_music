// Route contract (ADR 0004 §4.3, §4.4; ADR 0005 §3.1, N2-01).
// Each worker/src/http/<name>.ts exports `routes: RouteDef[]`; worker/src/
// http/routes.ts concatenates the /api/v1 table (ROUTES) and the Node
// composition (worker/src/node/compose.ts) adds the feature routes.
//
// RequestCtx (ADR 0005 §3.1):
// - `env` is the structural AppEnv: the two namespace variables meta, notify
//   and record-status read, plus the Workers-only ADMIN_TOKEN (removed by
//   N7-01). The Workers `Env` is assignable to it.
// - `deps`, `app` and `peer` are optional at the type level, so the RequestCtx
//   literals of the worker-modules suites keep compiling. The Node composition
//   always sets them; a handler that needs one reads it through
//   `need(ctx, key)`, which throws CtxWiringError (answered as a generic 500,
//   logged by error name) when the composition did not provide it.
//
// RouteDef.method is GET | POST | PUT | PATCH | DELETE | OPTIONS. HEAD is never
// registered: only the Node dispatcher (worker/src/node/dispatch.ts) maps a
// HEAD to the GET route of the same path.

import type { Clock } from '@atmusic/core/deps';
import type { AppServices } from '../app/services';
import type { IndexRpc, ModuleDeps } from '../do/contracts';
import type { EnvVars } from '../env';

/** What routes read of the environment (ADR 0005 §3.1); the Workers Env is assignable to it. */
export type AppEnv = Pick<EnvVars, 'LEXICON_PREFIX' | 'NAMESPACE_OWNERSHIP_REF'> & { ADMIN_TOKEN?: string };

export interface RequestCtx {
  env: AppEnv;
  index: IndexRpc;
  requestId: string;
  clock: Clock;
  /** HMAC key derived from the cursor key, imported once per process (isolate). */
  cursorKey: CryptoKey;
  /** The trusted client address: CF-Connecting-IP on Workers, the client-IP policy on Node (ADR 0005 §3.6). */
  clientIp: string;
  /** The core's module dependencies (db, clock, random, transport, identity, config, log). Node only. */
  deps?: ModuleDeps;
  /** The feature services (ADR 0005 §3.1). Node only. */
  app?: AppServices;
  /** The TCP peer address the socket reported. Node only. */
  peer?: string;
}

/** The methods a route may register (HEAD is the dispatcher's, never a route's). */
export const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];

export interface RouteDef {
  method: RouteMethod;
  /** Path pattern with `{name}` segments, e.g. `/api/v1/users/{did}/stats`. */
  pattern: string;
  handler(req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response>;
}

/** The optional context members `need` can demand. */
export type WiredKey = 'deps' | 'app' | 'peer';

/**
 * A handler ran without a context member the composition must provide. It is
 * not an ApiError, so the router answers the generic 500 `internal_error` and
 * logs only this error's name.
 */
export class CtxWiringError extends Error {
  override readonly name = 'CtxWiringError';
  constructor(readonly key: WiredKey) {
    super(`RequestCtx.${key} is not wired by this composition`);
  }
}

/** `ctx[key]`, or a CtxWiringError (500) when the composition did not set it. */
export function need<K extends WiredKey>(ctx: RequestCtx, key: K): NonNullable<RequestCtx[K]> {
  const value = ctx[key];
  if (value === undefined || value === null) throw new CtxWiringError(key);
  return value as NonNullable<RequestCtx[K]>;
}
