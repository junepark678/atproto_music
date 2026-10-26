// Last.fm 2.0 authentication methods and the method-table runner
// (ADR 0005 §7.1, §7.3, §7.4, §7.5, §13; N3-03).
//
// **Method tables.** `authMethods` (here) and `writeMethods`
// (write-methods.ts) map a Last.fm method name to a `LastfmMethodDef`: whether
// it must be POSTed, whether its §7.5 Auth column contains `sig`, and its
// handler. The /2.0 dispatcher (N3-04, lastfm/routes.ts) receives both tables
// at composition through a registry argument and runs them with
// `handleLastfmMethod`, which applies, in order:
//   1. the parameters (query plus form body, params.ts; a duplicate or a
//      malformed body is 6) and the response format (format, Accept);
//   2. the method: unknown or missing → 3;
//   3. `api_key`: missing, empty or over 64 characters → 10 (§7.3);
//   4. POST-only methods called otherwise → 3 "Invalid Method - this method
//      must be called with POST" (§7.1);
//   5. the method-scoped signature policy (signature.ts, §7.4): an issued key
//      or a known public pair must verify, an unknown key needs a 32-hex
//      api_sig, else 13. It runs only for methods whose Auth column contains
//      `sig`, which every method of these two tables does;
//   6. the handler, whose LastfmError is the answer; any other failure is
//      logged by error name and answered 8 "Operation failed".
// Write and auth methods never carry CORS headers and never read cookies.
//
// **auth.getToken** (GET or POST): a fresh 32-hex token bound to the api_key,
// valid 60 minutes, single-use (credentials/lastfm-auth.ts).
//
// **auth.getSession {token}**: consumes an authorized token and answers
// `<session><name/><key/><subscriber>0</subscriber></session>` (JSON
// `session.subscriber` is the number 0). Unknown, consumed or another
// api_key → 4; expired → 15; not yet authorized → 14.
//
// **auth.getMobileSession {username, password}** (POST only): our app
// password for a username, verified handle or DID (§9). Wrong credentials →
// 4; `authToken` → 4 "authToken is not supported; use password". Failed
// attempts are limited per (user, client IP) and per client IP over a sliding
// 15 minutes: the 11th failure for one (user, IP) pair, or the 31st for one IP,
// is refused with 29 and Retry-After before the password is looked at. The
// user part of the key is the DID the name resolves to (else the lowercased
// name), so spelling the same account as username, handle or DID shares one
// budget; the IP part is `rateKeyOf` (IPv4 address or IPv6 /64). Keying by the
// pair means nobody can lock another user out by guessing at their name from
// elsewhere (§7.3, §13). An `authToken` call is not counted as a guess.
//
// **Client names.** A session's `client_name` is the issued app's name, else
// the known public pair's name (ATMUSIC_LASTFM_KNOWN_CLIENTS), else the
// product token of the request's User-Agent; it is shown in Settings and
// becomes the records' `submissionClient`.
//
// **Services.** Everything request-scoped that these methods, the write
// methods and the approval route need is the `lastfmAuth` AppServices member,
// built once by `createLastfmAuthServices` (composed by
// `lastfmAuthFeature`, lastfm-authorize.ts): the box (issued app secrets),
// the known pairs, the cookie sessions and CSRF key, the in-memory failure and
// write limiters, and the outbox kick.
//
// No credential (sk, token, password, api_sig, shared secret) is ever logged
// or put in an error message (§13).

import type { Clock } from '@atmusic/core/deps';
import type { WebSessions } from '../bff/sessions';
import { resolveUserDid } from '../credentials/accounts';
import { issuedAppSecret } from '../credentials/lastfm-apps';
import {
  AUTH_TOKEN_UNSUPPORTED,
  getMobileSession,
  getSession,
  issueToken,
  isValidApiKey,
  type LastfmAuthCode,
  sanitiseClientName,
} from '../credentials/lastfm-auth';
import type { Box } from '../crypto/box';
import type { ModuleDeps } from '../do/contracts';
import { BucketSet, type RateRule } from '../http/limits';
import { CtxWiringError, need, type RequestCtx } from '../http/types';
import { rateKeyOf } from '../node/client-ip';
import { type LfmDocument, lastfmResponse, leaf, lfmOk, node } from './encode';
import { isLastfmError, LastfmError, POST_REQUIRED_MESSAGE } from './errors';
import { type LastfmFormat, type LastfmParams, negotiateFormat, readLastfmParams, wantsRawXml } from './params';
import { enforceSignaturePolicy, type KnownClientPair, type SignatureCheck } from './signature';

// ---------------------------------------------------------------------------
// Services

/** A known public pair with its display name (node/config.ts LastfmKnownClient). */
export interface NamedKnownClient extends KnownClientPair {
  readonly name: string;
}

/** What the Last.fm auth and write methods and the approval route share (module comment). */
export interface LastfmAuthServices {
  /** Opens issued app secrets (purpose `lastfm-app`). */
  readonly box: Box;
  /** ATMUSIC_LASTFM_KNOWN_CLIENTS. */
  readonly knownClients: readonly NamedKnownClient[];
  /** Cookie sessions, for POST /api/v1/lastfm/authorize. */
  readonly sessions: Pick<WebSessions, 'lookupCookieHeader' | 'renew'>;
  /** The CSRF HMAC key (box.csrfKey()). */
  readonly csrfKey: Uint8Array;
  /** ATMUSIC_PUBLIC_ORIGIN: the only accepted Origin. */
  readonly publicOrigin: string;
  /** getMobileSession failure limits. */
  readonly mobileFailures: FailureLimiter;
  /** 120 write calls per minute per session key (§13). */
  readonly writeRate: BucketSet;
  /** Makes the outbox timer due now (a no-op when no outbox is composed). */
  kickOutbox(): void;
}

declare module '../app/services' {
  interface AppServices {
    lastfmAuth: LastfmAuthServices;
  }
}

/** ADR §13: `/2.0` writes, 120 per minute per `sk`. */
export const WRITE_RATE: Readonly<RateRule> = { capacity: 120, windowMs: 60_000 };

export interface LastfmAuthServicesInput {
  box: Box;
  knownClients: readonly NamedKnownClient[];
  sessions: Pick<WebSessions, 'lookupCookieHeader' | 'renew'>;
  publicOrigin: string;
  clock: Clock;
  kickOutbox?: () => void;
  /** Default MOBILE_FAILURE_LIMITS. */
  failureLimits?: FailureLimits;
}

export function createLastfmAuthServices(input: LastfmAuthServicesInput): LastfmAuthServices {
  return {
    box: input.box,
    knownClients: [...input.knownClients],
    sessions: input.sessions,
    csrfKey: input.box.csrfKey(),
    publicOrigin: input.publicOrigin,
    mobileFailures: new FailureLimiter(input.clock, input.failureLimits ?? MOBILE_FAILURE_LIMITS),
    writeRate: new BucketSet(WRITE_RATE, input.clock, { onFull: 'refuse' }),
    kickOutbox: input.kickOutbox ?? (() => undefined),
  };
}

/** The `lastfmAuth` service of a request, or a CtxWiringError (500) when the composition lacks it. */
export function lastfmServices(ctx: RequestCtx): LastfmAuthServices {
  const services: LastfmAuthServices | undefined = need(ctx, 'app').lastfmAuth;
  if (services === undefined) throw new CtxWiringError('app');
  return services;
}

// ---------------------------------------------------------------------------
// Failure limiter (getMobileSession)

export interface FailureLimits {
  /** Sliding window, ms. */
  windowMs: number;
  /** Failures allowed per (user, IP) pair in the window. */
  perPair: number;
  /** Failures allowed per IP in the window. */
  perIp: number;
  /** Bound on tracked keys per map; the least recently used key is dropped beyond it. */
  maxKeys: number;
}

/** ADR §7.3, §13: 10 failures per 15 min per (username, IP), 30 per IP. */
export const MOBILE_FAILURE_LIMITS: Readonly<FailureLimits> = {
  windowMs: 15 * 60_000,
  perPair: 10,
  perIp: 30,
  maxKeys: 10_000,
};

export type FailureDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Counts failures per key over a sliding window (exact timestamps, so "more
 * than N failures in 15 minutes" means exactly that). In memory and driven
 * only by the injected clock; it starts empty after a restart (fail-open, as
 * every bucket of http/limits.ts, ADR §13). Both maps are bounded and evict
 * their least recently used key, so a flood of fresh keys never grows memory.
 */
export class FailureLimiter {
  private readonly pairs = new Map<string, number[]>();
  private readonly ips = new Map<string, number[]>();

  constructor(
    private readonly clock: Clock,
    readonly limits: Readonly<FailureLimits> = MOBILE_FAILURE_LIMITS,
  ) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`invalid failure limit ${name}=${value}`);
    }
  }

  private live(map: Map<string, number[]>, key: string, now: number): number[] {
    const list = map.get(key);
    if (list === undefined) return [];
    const kept = list.filter((t) => t > now - this.limits.windowMs);
    map.delete(key);
    if (kept.length > 0) map.set(key, kept);
    return kept;
  }

  private retryAfter(list: readonly number[], limit: number, now: number): number {
    // The failure that must age out before one more is allowed.
    const oldest = list[list.length - limit] ?? now;
    return Math.max(1, Math.ceil((oldest + this.limits.windowMs - now) / 1000));
  }

  /** Whether one more attempt for (pair, ip) may be checked at all. */
  check(pairKey: string, ipKey: string): FailureDecision {
    const now = this.clock.nowMs();
    const pair = this.live(this.pairs, pairKey, now);
    const ip = this.live(this.ips, ipKey, now);
    let wait = 0;
    if (pair.length >= this.limits.perPair) wait = Math.max(wait, this.retryAfter(pair, this.limits.perPair, now));
    if (ip.length >= this.limits.perIp) wait = Math.max(wait, this.retryAfter(ip, this.limits.perIp, now));
    return wait > 0 ? { allowed: false, retryAfterSeconds: wait } : { allowed: true };
  }

  /** Records one failed attempt for (pair, ip). */
  fail(pairKey: string, ipKey: string): void {
    const now = this.clock.nowMs();
    for (const [map, key] of [
      [this.pairs, pairKey],
      [this.ips, ipKey],
    ] as const) {
      const list = this.live(map, key, now);
      list.push(now);
      map.delete(key);
      map.set(key, list);
      while (map.size > this.limits.maxKeys) {
        const lru = map.keys().next();
        if (lru.done === true) break;
        map.delete(lru.value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Method tables and the runner

/** One call of a table method, after the runner's checks. */
export interface LastfmCall {
  /** The canonical method name (the table's). */
  readonly method: string;
  readonly req: Request;
  readonly ctx: RequestCtx;
  readonly params: LastfmParams;
  readonly format: LastfmFormat;
  /** The validated api_key. */
  readonly apiKey: string;
  /** The core's module dependencies (db, clock, random, config, log, ...). */
  readonly m: ModuleDeps;
  readonly services: LastfmAuthServices;
  readonly signature: SignatureCheck;
}

export interface LastfmMethodDef {
  /** The canonical method name. */
  readonly name: string;
  /** ADR §7.1: GET answers 3. */
  readonly postOnly: boolean;
  /** ADR §7.5: the Auth column contains `sig`. */
  readonly signed: boolean;
  /** The success document; a LastfmError is the protocol answer. */
  handle(call: LastfmCall): Promise<LfmDocument>;
}

/** Method name → definition (looked up case-insensitively). */
export type LastfmMethodTable = Readonly<Record<string, LastfmMethodDef>>;

/** The table entry for `method`, ignoring case, or null. */
export function findMethod(table: LastfmMethodTable, method: string): LastfmMethodDef | null {
  const exact = Object.hasOwn(table, method) ? table[method] : undefined;
  if (exact !== undefined) return exact;
  const lower = method.toLowerCase();
  for (const def of Object.values(table)) if (def.name.toLowerCase() === lower) return def;
  return null;
}

/** The response format when the parameters themselves could not be read. */
function fallbackFormat(req: Request): LastfmFormat {
  const query = new URL(req.url).searchParams;
  let format: string | null = null;
  try {
    format = query.get('format');
  } catch {
    format = null;
  }
  if (format?.trim().toLowerCase() === 'json') return 'json';
  if (format?.trim().toLowerCase() === 'xml') return 'xml';
  return req.headers.get('accept')?.toLowerCase().includes('application/json') ? 'json' : 'xml';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Runs one /2.0 request against `table` (module comment, steps 1–6). Answers
 * a Response in the negotiated format; never throws.
 */
export async function handleLastfmMethod(table: LastfmMethodTable, req: Request, ctx: RequestCtx): Promise<Response> {
  let format: LastfmFormat = fallbackFormat(req);
  let raw = false;
  let methodName: string | undefined;
  try {
    const params = await readLastfmParams(req);
    format = negotiateFormat(params, req.headers.get('accept'));
    raw = wantsRawXml(params);
    const method = params.get('method');
    const def = method === undefined ? null : findMethod(table, method);
    if (def === null) throw new LastfmError(3, 'Invalid Method - No method with that name in this package');
    methodName = def.name;
    const apiKey = params.get('api_key');
    if (!isValidApiKey(apiKey)) throw new LastfmError(10);
    if (def.postOnly && req.method !== 'POST') throw new LastfmError(3, POST_REQUIRED_MESSAGE);
    const services = lastfmServices(ctx);
    const m = need(ctx, 'deps');
    const signature = await enforceSignaturePolicy(def.name, params, {
      knownClients: services.knownClients,
      issuedSecret: (key) => issuedAppSecret({ db: m.db, box: services.box }, key)?.secret ?? null,
    });
    // A table entry marked signed whose name signature.ts does not list would
    // run unsigned: refuse it rather than skip the check.
    if (def.signed && !signature.required) throw new TypeError(`${def.name} is signed but not in SIGNED_METHODS`);
    const doc = await def.handle({ method: def.name, req, ctx, params, format, apiKey, m, services, signature });
    return lastfmResponse(doc, format, { raw });
  } catch (error) {
    if (isLastfmError(error)) return lastfmResponse(error, format);
    ctx.deps?.log.log('error', 'lastfm.method_failed', {
      requestId: ctx.requestId,
      ...(methodName === undefined ? {} : { lastfmMethod: methodName }),
      error: errorName(error),
    });
    return lastfmResponse(new LastfmError(8), format);
  }
}

/** A credentials-module failure as the protocol error. */
export function authFailure(code: LastfmAuthCode, message?: string): LastfmError {
  return new LastfmError(code, message);
}

/** The name sessions are stored under (module comment "Client names"). */
export function clientNameFor(call: Pick<LastfmCall, 'req' | 'apiKey' | 'services' | 'signature'>): string | null {
  if (call.signature.required && call.signature.keyKind === 'issued') return null; // the issued app's own name
  const known = call.services.knownClients.find((c) => c.apiKey === call.apiKey);
  if (known !== undefined) return sanitiseClientName(known.name);
  return userAgentProduct(call.req.headers.get('user-agent'));
}

/** The product token of a User-Agent (`multi-scrobbler/0.9 (…)` → `multi-scrobbler`), sanitised; null if none. */
export function userAgentProduct(userAgent: string | null): string | null {
  if (userAgent === null) return null;
  const product = userAgent.trim().split(/[\s/]/, 1)[0] ?? '';
  return sanitiseClientName(product);
}

function required(params: LastfmParams, name: string): string {
  const value = params.get(name);
  if (value === undefined || value === '') {
    throw new LastfmError(6, `Invalid parameters - missing required parameter ${JSON.stringify(name)}`);
  }
  return value;
}

/** `<session><name/><key/><subscriber>0</subscriber></session>`. */
function sessionDocument(name: string, key: string): LfmDocument {
  return lfmOk(node('session', [leaf('name', name), leaf('key', key), leaf('subscriber', 0)]));
}

// ---------------------------------------------------------------------------
// The methods

const getTokenMethod: LastfmMethodDef = {
  name: 'auth.getToken',
  postOnly: false,
  signed: true,
  async handle(call) {
    const issued = issueToken(call.m, call.apiKey);
    if (!issued.ok) throw authFailure(issued.code, issued.message);
    return lfmOk(leaf('token', issued.value.token));
  },
};

const getSessionMethod: LastfmMethodDef = {
  name: 'auth.getSession',
  postOnly: false,
  signed: true,
  async handle(call) {
    const token = required(call.params, 'token');
    const result = getSession(call.m, { apiKey: call.apiKey, token, clientName: clientNameFor(call) });
    if (!result.ok) throw authFailure(result.code, result.message);
    return sessionDocument(result.value.name, result.value.key);
  },
};

/** The (user, IP) and IP keys of the failure limiter. */
function failureKeys(call: LastfmCall, username: string): { pair: string; ip: string } {
  const did = resolveUserDid(call.m.db, username);
  const user = did ?? username.toLowerCase();
  const ip = rateKeyOf(call.ctx.clientIp);
  return { pair: `${user}\u0000${ip}`, ip };
}

const getMobileSessionMethod: LastfmMethodDef = {
  name: 'auth.getMobileSession',
  postOnly: true,
  signed: true,
  async handle(call) {
    const { params } = call;
    const username = required(params, 'username');
    const password = params.get('password');
    const authToken = params.get('authToken');
    if (password === undefined || password === '') {
      if (authToken !== undefined) throw new LastfmError(4, AUTH_TOKEN_UNSUPPORTED);
      throw new LastfmError(6, 'Invalid parameters - missing required parameter "password"');
    }
    const keys = failureKeys(call, username);
    const allowed = call.services.mobileFailures.check(keys.pair, keys.ip);
    if (!allowed.allowed) throw new LastfmError(29, undefined, { retryAfterSeconds: allowed.retryAfterSeconds });
    const result = getMobileSession(call.m, {
      apiKey: call.apiKey,
      username,
      password,
      clientName: clientNameFor(call),
    });
    if (!result.ok) {
      if (result.code === 4) call.services.mobileFailures.fail(keys.pair, keys.ip);
      throw authFailure(result.code, result.message);
    }
    return sessionDocument(result.value.name, result.value.key);
  },
};

/** The ADR §7.5 `auth.*` methods. */
export const authMethods: LastfmMethodTable = Object.freeze({
  [getTokenMethod.name]: getTokenMethod,
  [getSessionMethod.name]: getSessionMethod,
  [getMobileSessionMethod.name]: getMobileSessionMethod,
});
