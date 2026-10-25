// The Last.fm 2.0 endpoint and its method dispatcher (ADR 0005 §7.1, §7.3,
// §7.5, §7.6, §13; N3-04).
//
// Mounting. `lastfmRoutes(registry)` answers GET and POST on `/2.0` and `/2.0/`
// (Pano appends `/2.0/` to its root, lastfm-ts-api uses `/2.0`). The read
// methods are this package's (read-user.ts, read-charts.ts, read-entity.ts);
// the auth and write tables (`authMethods`, `writeMethods`, N3-03) arrive
// through the registry argument at composition time, so this module never
// imports them and there is no import cycle.
//
// Per request, in this order:
//  1. The parameters: query plus form body (params.ts; a duplicate, malformed
//     encoding or a body over 1 MiB is 6). Format negotiation (§7.1):
//     `format=json`, else an Accept header with application/json, else XML;
//     `raw=true` drops the `<lfm>` wrapper; `callback` is never honoured.
//     When the parameters themselves fail, the format comes from the query's
//     `format` and the Accept header.
//  2. `method`: matched without regard to case against the read, auth and
//     write tables and the §7.5 signed list; missing or unknown is 3. The
//     method a form body carried is reported to the request log with
//     `noteLastfmMethod` (only allowlisted names are ever logged).
//  3. POST-only methods (track.scrobble, track.updateNowPlaying, track.love,
//     track.unlove, library.removeScrobble, auth.getMobileSession) called
//     with GET: 3 "Invalid Method - this method must be called with POST",
//     before any credential is looked at.
//  4. `api_key`: missing, empty or over 64 characters is 10 (§7.3). It never
//     grants anything on its own.
//  5. Signed methods only (requiresSignature, §7.4): the signature policy runs
//     with the registry's `signature` inputs before the handler; 13 on
//     failure. A registry that mounts a signed handler without those inputs is
//     refused when the routes are built (fail closed).
//     Read methods ignore `api_sig` whether present, absent or wrong.
//  6. The handler. A read handler gets `call.caller()`: the owner of a valid
//     `sk`, or null — an unknown, malformed or revoked `sk` on a read is
//     ignored, never 9 (§7.3). Write and auth handlers verify their own `sk`,
//     token or password (N3-03).
//
// Delegated tables. N3-03 ships its tables as definitions (`{name, postOnly,
// signed, handle}`) together with their own runner, `handleLastfmMethod(table,
// request, ctx)`, which applies steps 1–6 itself (its api_key, POST-only and
// signature checks, with the issued-app box and the known pairs it owns). The
// composition passes them as `registry.delegated = {tables: [authMethods,
// writeMethods], run: handleLastfmMethod}`. Only §7.5 signed methods may be
// delegated (anything else is refused when the routes are built), so a read
// can never be shadowed and a delegated method is never answered unsigned by
// this module. A delegated request is routed by its method name only: the
// runner receives an untouched copy of the request (cloned before the body is
// read) and its answer is returned as is, without CORS.
//
// Answers. A LastfmError becomes the §7.2 error envelope with the §7.6 HTTP
// status (Retry-After on 29). Anything else a handler throws is 8 "Operation
// failed", logged by request id, canonical method name and error name only.
// Read methods (success and error) carry `Access-Control-Allow-Origin: *`;
// write and auth methods and requests whose method is unknown carry no CORS
// header (§7.1). Cookies are never read.
//
// Logging (§3.10, §13). This module logs only failures, by error name. The
// dispatcher (node/dispatch.ts) writes the request line with the route
// pattern and the allowlisted method name, never a query string or body.
// Error messages name parameters, never their values, so no sk, api_sig,
// token or password ever reaches a body or a log line.

import { verifySessionKey } from '../credentials/lastfm-auth';
import type { Logger, ModuleDeps } from '../do/contracts';
import { noteLastfmMethod } from '../http/routes';
import { need, type RequestCtx, type RouteDef } from '../http/types';
import { type LfmDocument, lastfmResponse } from './encode';
import { LastfmError, POST_REQUIRED_MESSAGE } from './errors';
import { type LastfmFormat, type LastfmParams, negotiateFormat, readLastfmParams, wantsRawXml } from './params';
import { readChartMethods } from './read-charts';
import { readEntityMethods } from './read-entity';
import { readUserMethods } from './read-user';
import {
  enforceSignaturePolicy,
  requiresSignature,
  SIGNED_METHODS,
  type SignatureCheck,
  type SignaturePolicyDeps,
} from './signature';

/** The paths the endpoint answers (§7.1). */
export const LASTFM_PATHS = ['/2.0', '/2.0/'] as const;

/** §7.1: these methods must be called with POST. */
export const POST_ONLY_METHODS: readonly string[] = Object.freeze([
  'track.scrobble',
  'track.updateNowPlaying',
  'track.love',
  'track.unlove',
  'library.removeScrobble',
  'auth.getMobileSession',
]);

/** §7.3: an `api_key` is any non-empty value of at most this many characters. */
export const MAX_API_KEY_CHARS = 64;

/** CORS on read methods (§7.1). */
export const READ_CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'access-control-allow-origin': '*',
});

export const UNKNOWN_METHOD_MESSAGE = 'Invalid Method - No method with that name in this package';

/** The identity a valid `sk` names on a read (§7.3). */
export interface LastfmCaller {
  readonly did: string;
  /** lastfm_sessions.id */
  readonly sessionId: string;
  readonly apiKey: string;
}

/** Everything a method handler receives. */
export interface LastfmCall {
  /** The canonical method name (`user.getRecentTracks`), whatever case the client sent. */
  readonly method: string;
  readonly params: LastfmParams;
  readonly format: LastfmFormat;
  /** The validated `api_key`. */
  readonly apiKey: string;
  readonly request: Request;
  readonly ctx: RequestCtx;
  /** `need(ctx, 'deps')`. */
  readonly deps: ModuleDeps;
  /** The public origin (user URLs). */
  readonly publicOrigin: string;
  /** The §7.4 result; `{required: false}` for read methods. */
  readonly signature: SignatureCheck;
  /** Read methods: the owner of a valid `sk`, else null (never error 9). Memoised. */
  caller(): LastfmCaller | null;
}

/** A method: a success document, or a finished Response; a LastfmError throw is the error envelope. */
export type LastfmMethodHandler = (call: LastfmCall) => LfmDocument | Response | Promise<LfmDocument | Response>;

/** Canonical method name → handler. */
export type LastfmMethodTable = Readonly<Record<string, LastfmMethodHandler>>;

/** Identifies a caller from `sk` (credentials/lastfm-auth.ts verifySessionKey), or null. */
export type CallerResolver = (deps: ModuleDeps, sk: string) => LastfmCaller | null;

/** A method definition of a delegated table (N3-03's LastfmMethodDef, structurally). */
export interface DelegatedMethodDef {
  readonly name: string;
}

/** A delegated table: method name → definition. */
export type DelegatedTable = Readonly<Record<string, DelegatedMethodDef>>;

/** Tables that come with their own runner (module comment, "Delegated tables"). */
export interface DelegatedTables<T extends DelegatedTable> {
  readonly tables: readonly T[];
  /** Answers one request against `table`; never throws (N3-03 handleLastfmMethod). */
  run(table: T, request: Request, ctx: RequestCtx): Promise<Response>;
}

export interface LastfmRegistry<T extends DelegatedTable = DelegatedTable> {
  /** Signed methods with their own runner (N3-03's authMethods and writeMethods). */
  readonly delegated?: DelegatedTables<T>;
  /** Signed handlers in this module's call shape (auth.getToken … auth.getMobileSession). */
  readonly authMethods?: LastfmMethodTable;
  /** Signed handlers in this module's call shape (track.scrobble … library.removeScrobble). */
  readonly writeMethods?: LastfmMethodTable;
  /** The §7.4 policy inputs; required as soon as a signed method is mounted. */
  readonly signature?: SignaturePolicyDeps | ((call: Omit<LastfmCall, 'signature' | 'caller'>) => SignaturePolicyDeps);
  /** Default: `verifySessionCaller`. */
  readonly resolveCaller?: CallerResolver;
}

/** Every read method of §7.5, canonical name → handler. */
export const READ_METHOD_TABLE: LastfmMethodTable = Object.freeze({
  ...readUserMethods,
  ...readChartMethods,
  ...readEntityMethods,
});

interface Entry {
  readonly name: string;
  readonly kind: 'read' | 'auth' | 'write';
  readonly handler: LastfmMethodHandler | null;
  /** Set for a delegated method: the table its runner answers from. */
  readonly delegatedTable?: DelegatedTable;
}

/** The answer for a signed method this composition does not mount. */
function unmounted(): never {
  throw new LastfmError(3, 'Invalid Method - this method is not available on this server');
}

function buildTable<T extends DelegatedTable>(
  registry: LastfmRegistry<T>,
  signedNames: readonly string[],
): Map<string, Entry> {
  const table = new Map<string, Entry>();
  const add = (name: string, kind: Entry['kind'], handler: LastfmMethodHandler | null, delegatedTable?: T) => {
    const key = name.toLowerCase();
    const existing = table.get(key);
    if (existing !== undefined && (existing.handler !== null || existing.delegatedTable !== undefined)) {
      throw new TypeError(`Last.fm method ${name} is registered twice`);
    }
    // A signed method keeps its canonical §7.5 spelling.
    const canonical = existing?.name ?? name;
    table.set(
      key,
      delegatedTable === undefined
        ? { name: canonical, kind, handler }
        : { name: canonical, kind, handler, delegatedTable },
    );
  };
  // The §7.5 signed methods are known even when not mounted: a GET of a
  // POST-only one is still 3 with the POST message, never "unknown".
  for (const name of signedNames) add(name, name.startsWith('auth.') ? 'auth' : 'write', null);
  for (const [name, handler] of Object.entries(READ_METHOD_TABLE)) {
    if (requiresSignature(name)) throw new TypeError(`read method ${name} is a signed method`);
    add(name, 'read', handler);
  }
  for (const [kind, methods] of [
    ['auth', registry.authMethods],
    ['write', registry.writeMethods],
  ] as const) {
    for (const [name, handler] of Object.entries(methods ?? {})) {
      if (!requiresSignature(name)) {
        throw new TypeError(`${kind} method ${name} is not a §7.5 signed method`);
      }
      if (registry.signature === undefined) {
        throw new TypeError(`signed method ${name} needs the registry's signature policy inputs`);
      }
      add(name, kind, handler);
    }
  }
  for (const delegated of registry.delegated?.tables ?? []) {
    for (const [key, def] of Object.entries(delegated)) {
      for (const name of new Set([key, def.name])) {
        if (!requiresSignature(name)) throw new TypeError(`delegated method ${name} is not a §7.5 signed method`);
      }
      add(def.name, def.name.toLowerCase().startsWith('auth.') ? 'auth' : 'write', null, delegated);
    }
  }
  return table;
}

function isPostOnly(name: string): boolean {
  return POST_ONLY_METHODS.some((m) => m.toLowerCase() === name.toLowerCase());
}

/** The format of a request whose parameters could not be parsed: the query's `format`, then Accept. */
function fallbackFormat(request: Request): LastfmFormat {
  let format: string | null = null;
  try {
    format = new URL(request.url).searchParams.get('format');
  } catch {
    format = null;
  }
  const f = format?.trim().toLowerCase();
  if (f === 'json') return 'json';
  if (f === 'xml') return 'xml';
  return request.headers.get('accept')?.toLowerCase().includes('application/json') === true ? 'json' : 'xml';
}

function withCors(response: Response, cors: boolean): Response {
  if (!cors) return response;
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(READ_CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The default caller resolver: credentials/lastfm-auth.ts verifySessionKey over the request's db and clock. */
export const verifySessionCaller: CallerResolver = (deps, sk) => {
  const verified = verifySessionKey({ db: deps.db, clock: deps.clock }, sk);
  return verified.ok ? { did: verified.value.did, sessionId: verified.value.id, apiKey: verified.value.apiKey } : null;
};

function failureLog(log: Logger, fields: Record<string, unknown>): void {
  try {
    log.log('error', 'lastfm.method_failed', fields);
  } catch {
    // A broken log sink never changes an answer.
  }
}

/** The /2.0 request handler over `registry` (module comment). */
export function createLastfmHandler<T extends DelegatedTable = DelegatedTable>(
  registry: LastfmRegistry<T> = {},
): RouteDef['handler'] {
  const table = buildTable(registry, SIGNED_METHODS);
  const delegated = registry.delegated;

  return async (request, ctx) => {
    const deps = need(ctx, 'deps');
    let format = fallbackFormat(request);
    let entry: Entry | null = null;
    // The delegated runner reads the request itself: keep an untouched copy.
    let copy: Request | null = delegated === undefined ? null : request.clone();
    try {
      const params = await readLastfmParams(request);
      format = negotiateFormat(params, request.headers.get('accept'));
      const raw = wantsRawXml(params);

      const methodValue = params.get('method');
      if (methodValue !== undefined) noteLastfmMethod(request, methodValue);
      if (methodValue === undefined || methodValue.trim() === '') throw new LastfmError(3, UNKNOWN_METHOD_MESSAGE);
      const found = table.get(methodValue.trim().toLowerCase());
      if (found === undefined) throw new LastfmError(3, UNKNOWN_METHOD_MESSAGE);
      entry = found;
      if (found.delegatedTable !== undefined && delegated !== undefined && copy !== null) {
        const forward = copy;
        copy = null;
        return await delegated.run(found.delegatedTable as T, forward, ctx);
      }

      if (isPostOnly(found.name) && request.method !== 'POST') throw new LastfmError(3, POST_REQUIRED_MESSAGE);

      const apiKey = params.get('api_key');
      if (apiKey === undefined || apiKey === '' || [...apiKey].length > MAX_API_KEY_CHARS) {
        throw new LastfmError(10);
      }
      if (found.handler === null) unmounted();

      const base = {
        method: found.name,
        params,
        format,
        apiKey,
        request,
        ctx,
        deps,
        publicOrigin: deps.config.publicOrigin,
      };
      let signature: SignatureCheck = { required: false };
      if (found.kind !== 'read') {
        const inputs = typeof registry.signature === 'function' ? registry.signature(base) : registry.signature;
        if (inputs === undefined) unmounted();
        signature = await enforceSignaturePolicy(found.name, params, inputs);
      }

      const resolver: CallerResolver = registry.resolveCaller ?? verifySessionCaller;
      let resolved = false;
      let caller: LastfmCaller | null = null;
      const call: LastfmCall = {
        ...base,
        signature,
        caller() {
          if (!resolved) {
            resolved = true;
            const sk = params.get('sk');
            caller = sk === undefined || sk === '' ? null : resolver(deps, sk);
          }
          return caller;
        },
      };

      const result = await found.handler(call);
      if (result instanceof Response) return withCors(result, found.kind === 'read');
      return withCors(lastfmResponse(result, format, { raw }), found.kind === 'read');
    } catch (error) {
      const cors = entry?.kind === 'read';
      if (error instanceof LastfmError) return withCors(lastfmResponse(error, format), cors);
      failureLog(deps.log, {
        requestId: ctx.requestId,
        method: entry?.name ?? null,
        error: errorName(error),
      });
      return withCors(lastfmResponse(new LastfmError(8), format), cors);
    } finally {
      // A copy nobody forwarded is released.
      await copy?.body?.cancel().catch(() => undefined);
    }
  };
}

/** GET and POST on `/2.0` and `/2.0/` (module comment). */
export function lastfmRoutes<T extends DelegatedTable = DelegatedTable>(registry: LastfmRegistry<T> = {}): RouteDef[] {
  const handler = createLastfmHandler(registry);
  return LASTFM_PATHS.flatMap((pattern) => [
    { method: 'GET' as const, pattern, handler },
    { method: 'POST' as const, pattern, handler },
  ]);
}
