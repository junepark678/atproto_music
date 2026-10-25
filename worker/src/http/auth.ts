// The sign-in, session and disconnect routes of the confidential client (ADR
// 0005 §5.5–§5.7, §14.5; contract v1.2; N3-01):
//
//   POST   /api/v1/auth/start          {handle} → 200 {authorizeUrl} + __Host-atmusic_oauth
//   GET    /oauth/callback             → 303 / + __Host-atmusic_session
//   GET    /api/v1/auth/session        → 200 Session
//   POST   /api/v1/auth/logout         {everywhere?} → 204
//   DELETE /api/v1/account/connection  → 204
//
// **auth/start**, in order:
//   1. 10 requests per minute per client IP (`rateKeyOf(ctx.clientIp)`, an
//      evict-LRU bucket set like every per-IP set of the Node host): 429 with
//      Retry-After. Every request counts, whatever it is refused for later.
//   2. Exactly one `Origin`, equal to ATMUSIC_PUBLIC_ORIGIN (bff/csrf.ts
//      `checkOrigin`, the login-CSRF rule of §5.6): 403 `csrf_failed`, before
//      the body is read and before anything is stored.
//   3. The body: JSON (64 KiB cap; 400 `invalid_json`, 413), exactly
//      `{handle}` with a syntactic handle outside the reserved TLDs (the
//      contract's closed AuthStartInput): 422 `validation_failed` with
//      `fields.handle` otherwise. A handle that does not resolve to an
//      acceptable DID is the same 422.
//   4. A fresh `__Host-atmusic_oauth` value (32 random bytes, hex); its
//      SHA-256 goes to `OAuthService.authorize` as the state binding
//      (`oauth_states.session_binding`). authorize resolves the handle through
//      our identity module, applies the sign-in policy to the resolved DID
//      (403 `signin_not_allowed`, nothing stored), refuses an AS without PAR or
//      S256 PKCE and maps discovery or PAR failures to 502 `oauth_upstream`
//      (no state kept).
//   5. 200 `{authorizeUrl}` with `Set-Cookie: __Host-atmusic_oauth=<hex>;
//      HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`. `Path=/` is what
//      the `__Host-` prefix demands. No refused request sets the cookie.
//
// **oauth/callback**. Every answer clears `__Host-atmusic_oauth` and is
// `Cache-Control: no-store`.
//   1. `OAuthService.callback(params, {bindingHash})` with SHA-256 of the one
//      well-formed `__Host-atmusic_oauth` the request carries (null for none
//      or a malformed or repeated one). It refuses a missing, replayed,
//      expired or unknown state and a binding mismatch before the code
//      exchange (403 `oauth_binding_mismatch`, the state consumed), exchanges
//      the code and runs the binding check (§5.5): a definite mismatch revokes
//      the new session (403 `oauth_binding_mismatch`); an identity-resolution
//      error keeps it and is 502 `oauth_upstream`; an AS-reported error (such
//      as access_denied) is 303 to `/signin?error=denied`.
//   2. The sign-in policy on the session's `sub`: a refused DID has its new
//      OAuth session revoked upstream and deleted, and the answer is 403
//      `signin_not_allowed` with nothing stored (no account, no users row, no
//      web session).
//   3. The account (`ensureAccount`, the §9 username from the verified handle
//      of the binding check), then `admit(db, did, 'notify', now)` so a DID
//      with no records, or with records never hinted, gets a users row and a
//      snapshot (imports wait for its indexing_state, §11.2). A `busy` answer
//      (the queue_full condition) is not an error: the import timer or the
//      outbox's first write admits the DID later. An admitted DID's snapshot
//      timer is armed at once (`IndexRpc.ensureRunning`).
//   4. A web session (`__Host-atmusic_session`, bff/sessions.ts) and 303 to
//      `/`. (The contract's closed AuthStartInput carries no `returnTo`, so
//      the redirect is always `/`.)
//
// **auth/session** (cookie; no CSRF on GET): `{did, handle, username,
// csrfToken, status, expiresAt}`, `Cache-Control: no-store`, plus the
// renewal Set-Cookie when the session was renewed. `handle` is the verified
// handle the index holds (`users.handle`), else the identity module's cached
// verified handle, else null; `status` is `active` while the account's OAuth
// session is usable and `reauth_required` otherwise.
//
// **auth/logout** (cookie plus CSRF): deletes this web session, or every web
// session of the DID with `{everywhere: true}`, each journaled first
// (sessions.ts). Then the DID's OAuth session is revoked upstream and deleted
// unless the DID still has a live web session or a protocol credential (a
// Last.fm session, an app password or a ListenBrainz token); the check runs
// under the DID's OAuth lock (`revoke(did, {unless})`), so a concurrent sign-in
// or credential is never cut off. 204 with the cookie cleared. A body is
// optional; one that is not `{}` or `{everywhere: boolean}` is 400
// `bad_request`.
//
// **account/connection DELETE** (cookie plus CSRF): in one transaction, every
// web session, Last.fm session, app password, ListenBrainz token and issued
// app of the DID is journaled and deleted, its pending Last.fm desktop tokens
// and link states are deleted, its linked accounts are journaled and deleted
// together with their forward rows, its never-sent operations are cancelled
// (`cancelUnsentForDid`), an `account_disconnect` event is journaled and the
// account is set `signed_out`. Then the OAuth session is revoked upstream and
// deleted (journaled as `oauth_session` by the session store). 204 with the
// cookie cleared. Records on the PDS and the public index are not touched.
//
// The v1.2 codes that are not in the frozen v1.1 ErrorCode union
// (csrf_failed, unauthenticated, signin_not_allowed, oauth_binding_mismatch,
// oauth_upstream) are built here with the fixed messages of
// api/examples/v1.2/error-*.json; everything else uses http/error.ts. No
// response or log line carries a query string, a cookie value or a token.
//
// Services. The routes read `ctx.app.auth` (declared below by interface
// merging). `authFeature(secrets, options)` builds it, together with the
// `oauthDocs` service of http/oauth-docs.ts, over the composition's module
// deps: the OAuth service of bff/oauth-client.ts (policyFetch over the
// composition's transport, the core's identity resolver, the sealed stores),
// the web sessions, the CSRF key derived from the first encryption key, the
// sign-in policy of the configuration and the auth/start limiter. N4-01 adds
// the feature to the production list; a composition that already built an
// OAuthService (for the outbox writers or the keepalive) passes it in
// `options.oauth`.

import type { DeadlineTimer } from '@atmusic/atproto/net/safe-fetch';
import { isDisallowedHandleTld, isHandle } from '@atmusic/core/syntax';
import { fromMs, toDto } from '@atmusic/core/timestamp';
import type { Revocations } from '../app/revocations';
import { clientMetadataFor } from '../bff/client-metadata';
import { checkOrigin, csrfToken } from '../bff/csrf';
import { requireSession, type SessionGuardCtx, withSessionCookie } from '../bff/guard';
import { loadOAuthKeyset, type OAuthKeyset } from '../bff/keyset';
import { createOAuthService, OAuthFlowError, type OAuthService } from '../bff/oauth-client';
import { type SignInPolicy, signInAllowed } from '../bff/reconcile';
import { clearSessionCookie, createWebSessions, type WebSessions } from '../bff/sessions';
import { ensureAccount, getAccount, storedVerifiedHandle } from '../credentials/accounts';
import { createBox } from '../crypto/box';
import { hashToken, newOAuthBindingToken } from '../crypto/tokens';
import type { Logger } from '../do/contracts';
import type { Db } from '../do/db';
import { admit } from '../do/ingest/admission';
import { rateKeyOf } from '../node/client-ip';
import type { Feature, FeatureContext } from '../node/compose';
import { createPolicyFetch } from '../node/policy-fetch';
import type { Secrets } from '../node/secrets';
import { cancelUnsentForDid } from '../outbox/operations';
import { errorResponse, rateLimitedResponse, toErrorResponse } from './error';
import { json } from './json';
import { BucketSet, type RateRule } from './limits';
import { routes as oauthDocsRoutes } from './oauth-docs';
import { invalidField, readJsonBody } from './params';
import { CtxWiringError, need, type RequestCtx, type RouteDef } from './types';

// ---------------------------------------------------------------------------
// Constants

export const AUTH_START_PATH = '/api/v1/auth/start';
export const OAUTH_CALLBACK_ROUTE = '/oauth/callback';
export const AUTH_SESSION_PATH = '/api/v1/auth/session';
export const AUTH_LOGOUT_PATH = '/api/v1/auth/logout';
export const ACCOUNT_CONNECTION_PATH = '/api/v1/account/connection';

/** The login-CSRF cookie (§5.6). */
export const OAUTH_BINDING_COOKIE = '__Host-atmusic_oauth';
/** Its lifetime: the oauth_states TTL (600 s). */
export const OAUTH_BINDING_MAX_AGE_S = 600;
/** The attributes `__Host-` requires (Secure, Path=/, no Domain), plus HttpOnly and SameSite=Lax. */
const COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/';
const BINDING_RE = /^[0-9a-f]{64}$/;

/** auth/start: 10 per minute per client IP (§5.7). */
export const AUTH_START_RATE: Readonly<RateRule> = Object.freeze({ capacity: 10, windowMs: 60_000 });
/** Request bodies of the auth routes (x-maxBodyBytes in the contract). */
export const AUTH_BODY_MAX_BYTES = 65_536;

/** Where the callback sends a signed-in browser, and a refused one. */
export const SIGNED_IN_LOCATION = '/';
export const DENIED_LOCATION = '/signin?error=denied';

const EXPECTED_HANDLE = 'Expected a handle.';
const HANDLE_UNRESOLVED = 'The handle does not resolve to an account.';

// ---------------------------------------------------------------------------
// Envelopes for the v1.2 codes

export type AuthErrorCode =
  | 'unauthenticated'
  | 'csrf_failed'
  | 'signin_not_allowed'
  | 'oauth_binding_mismatch'
  | 'oauth_upstream';

/** The fixed messages of api/examples/v1.2/error-*.json. */
export const AUTH_ERROR_MESSAGES: Readonly<Record<AuthErrorCode, string>> = Object.freeze({
  unauthenticated: 'No valid session cookie.',
  csrf_failed: 'Origin or X-CSRF-Token check failed.',
  signin_not_allowed: 'This account may not sign in here.',
  oauth_binding_mismatch: 'The sign-in could not be bound to this browser or identity.',
  oauth_upstream: 'The authorization server or identity lookup failed.',
});

export const AUTH_ERROR_STATUS: Readonly<Record<AuthErrorCode, number>> = Object.freeze({
  unauthenticated: 401,
  csrf_failed: 403,
  signin_not_allowed: 403,
  oauth_binding_mismatch: 403,
  oauth_upstream: 502,
});

/** `{error:{code, message, requestId}}`, JSON, no-store, with optional Set-Cookie values. */
export function authErrorResponse(code: AuthErrorCode, requestId: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(JSON.stringify({ error: { code, message: AUTH_ERROR_MESSAGES[code], requestId } }), {
    status: AUTH_ERROR_STATUS[code],
    headers,
  });
}

function withCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function redirect(location: string, cookies: readonly string[]): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 303, headers });
}

function noContent(cookies: readonly string[]): Response {
  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 204, headers });
}

// ---------------------------------------------------------------------------
// The login-binding cookie

/** The Set-Cookie that installs the login-binding value for 600 s. */
export function oauthBindingCookie(value: string): string {
  if (!BINDING_RE.test(value)) throw new RangeError('the login-binding value is 64 lowercase hex characters');
  return `${OAUTH_BINDING_COOKIE}=${value}; ${COOKIE_ATTRIBUTES}; Max-Age=${OAUTH_BINDING_MAX_AGE_S}`;
}

/** The Set-Cookie that removes it. */
export function clearOAuthBindingCookie(): string {
  return `${OAUTH_BINDING_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}

/**
 * The login-binding value a Cookie header carries: exactly one
 * `__Host-atmusic_oauth` pair of 64 lowercase hex, else null (absent, empty,
 * repeated or malformed), like sessions.ts `sessionTokenFromCookies`.
 */
export function oauthBindingFromCookies(cookieHeader: string | null): string | null {
  if (cookieHeader === null || cookieHeader === '') return null;
  const values: string[] = [];
  for (const pair of cookieHeader.split(/[;,]/)) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === OAUTH_BINDING_COOKIE) values.push(pair.slice(eq + 1).trim());
  }
  if (values.length !== 1) return null;
  const value = values[0] as string;
  return BINDING_RE.test(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Services

/** What the auth routes need (ctx.app.auth). */
export interface AuthServices {
  /** The confidential OAuth client (the outbox writers and the keepalive may share it). */
  readonly oauth: OAuthService;
  readonly sessions: WebSessions;
  readonly revocations: Revocations;
  /** ATMUSIC_PUBLIC_ORIGIN. */
  readonly publicOrigin: string;
  /** The 32-byte CSRF HMAC key (crypto/box.ts csrfKey()). */
  readonly csrfKey: Uint8Array;
  /** The sign-in policy (§5.7), read on every sign-in. */
  readonly signIn: SignInPolicy;
  /** auth/start's per-IP limiter. */
  readonly startLimiter: BucketSet;
}

declare module '../app/services' {
  interface AppServices {
    auth: AuthServices;
  }
}

function authOf(ctx: RequestCtx): AuthServices {
  const service = need(ctx, 'app').auth as AuthServices | undefined;
  if (service === undefined) throw new CtxWiringError('app');
  return service;
}

function guardCtx(auth: AuthServices, ctx: RequestCtx): SessionGuardCtx {
  return { requestId: ctx.requestId, sessions: auth.sessions, publicOrigin: auth.publicOrigin, csrfKey: auth.csrfKey };
}

function logOf(ctx: RequestCtx): Logger {
  return need(ctx, 'deps').log;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// ---------------------------------------------------------------------------
// POST /api/v1/auth/start

/** The `{handle}` of an AuthStartInput, or a 422 `fields.handle` ApiError. */
function startHandle(body: unknown): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalidField('handle', EXPECTED_HANDLE);
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'handle') throw invalidField('handle', EXPECTED_HANDLE);
  const handle = (body as { handle: unknown }).handle;
  if (typeof handle !== 'string' || handle.length > 253 || !isHandle(handle) || isDisallowedHandleTld(handle)) {
    throw invalidField('handle', EXPECTED_HANDLE);
  }
  return handle;
}

export async function postAuthStart(req: Request, ctx: RequestCtx): Promise<Response> {
  const auth = authOf(ctx);
  const log = logOf(ctx);
  const rate = auth.startLimiter.take(rateKeyOf(ctx.clientIp));
  if (!rate.allowed) return rateLimitedResponse(ctx.requestId, rate.retryAfterSeconds);

  const origin = checkOrigin(req.headers, auth.publicOrigin);
  if (!origin.ok) {
    log.log('warn', 'auth_start_refused', { requestId: ctx.requestId, reason: origin.reason });
    return authErrorResponse('csrf_failed', ctx.requestId);
  }

  let handle: string;
  try {
    handle = startHandle(await readJsonBody(req, AUTH_BODY_MAX_BYTES));
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }

  const binding = newOAuthBindingToken(need(ctx, 'deps').random);
  try {
    const started = await auth.oauth.authorize(handle, {
      bindingHash: hashToken(binding),
      allow: (did) => signInAllowed(auth.signIn, did),
    });
    return json({ authorizeUrl: started.url.href }, 200, { 'set-cookie': oauthBindingCookie(binding) });
  } catch (error) {
    if (!(error instanceof OAuthFlowError)) throw error;
    log.log('warn', 'auth_start_failed', { requestId: ctx.requestId, code: error.code, reason: error.reason });
    switch (error.code) {
      case 'invalid_handle':
        return errorResponse('validation_failed', 422, ctx.requestId, { handle: EXPECTED_HANDLE });
      case 'handle_unresolved':
        return errorResponse('validation_failed', 422, ctx.requestId, { handle: HANDLE_UNRESOLVED });
      case 'signin_not_allowed':
        return authErrorResponse('signin_not_allowed', ctx.requestId);
      default:
        return authErrorResponse('oauth_upstream', ctx.requestId);
    }
  }
}

// ---------------------------------------------------------------------------
// GET /oauth/callback

export async function getOAuthCallback(req: Request, ctx: RequestCtx): Promise<Response> {
  const auth = authOf(ctx);
  const deps = need(ctx, 'deps');
  const log = deps.log;
  const clear = [clearOAuthBindingCookie()];
  const binding = oauthBindingFromCookies(req.headers.get('cookie'));
  const params = new URL(req.url).searchParams;

  let did: string;
  let verifiedHandle: string | null;
  try {
    const result = await auth.oauth.callback(params, { bindingHash: binding === null ? null : hashToken(binding) });
    did = result.did;
    verifiedHandle = result.handle;
  } catch (error) {
    if (!(error instanceof OAuthFlowError)) {
      log.log('error', 'oauth_callback_failed', { requestId: ctx.requestId, error: errorName(error) });
      return withCookies(toErrorResponse(error, ctx.requestId), clear);
    }
    log.log('warn', 'oauth_callback_refused', { requestId: ctx.requestId, code: error.code, reason: error.reason });
    switch (error.code) {
      case 'oauth_denied':
        return redirect(DENIED_LOCATION, clear);
      case 'oauth_binding_mismatch':
        return authErrorResponse('oauth_binding_mismatch', ctx.requestId, clear);
      case 'signin_not_allowed':
        return authErrorResponse('signin_not_allowed', ctx.requestId, clear);
      default:
        return authErrorResponse('oauth_upstream', ctx.requestId, clear);
    }
  }

  try {
    // The sign-in policy on the session's subject: the new session is revoked and nothing is stored.
    if (!signInAllowed(auth.signIn, did)) {
      log.log('warn', 'oauth_callback_refused', { requestId: ctx.requestId, code: 'signin_not_allowed', did });
      await auth.oauth.revoke(did);
      return authErrorResponse('signin_not_allowed', ctx.requestId, clear);
    }

    const { db, clock } = deps;
    ensureAccount({ db, clock }, { did, verifiedHandle });
    const admitted = admit(db, did, 'notify', clock.nowMs());
    if (admitted.status === 'busy') log.log('info', 'signin_admission_deferred', { did, reason: admitted.reason });
    if (admitted.status === 'admitted') await armSnapshot(ctx, log);
    const issued = auth.sessions.create(did);
    log.log('info', 'signed_in', { requestId: ctx.requestId, did, admission: admitted.status });
    return redirect(SIGNED_IN_LOCATION, [...clear, issued.setCookie]);
  } catch (error) {
    // No session cookie; the login-binding cookie is still cleared.
    log.log('error', 'oauth_callback_failed', { requestId: ctx.requestId, did, error: errorName(error) });
    return withCookies(toErrorResponse(error, ctx.requestId), clear);
  }
}

/**
 * A new snapshot job was queued outside an alarm: align the core timers with
 * the queues and arm the core lane now (the same RPC as the Node 5-minute
 * interval), so the snapshot does not wait for that interval. A failure is
 * logged only; the interval catches up.
 */
async function armSnapshot(ctx: RequestCtx, log: Logger): Promise<void> {
  try {
    await ctx.index.ensureRunning();
  } catch (error) {
    log.log('warn', 'signin_snapshot_arm_failed', { requestId: ctx.requestId, error: errorName(error) });
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/auth/session

async function sessionHandle(ctx: RequestCtx, db: Db, did: string): Promise<string | null> {
  const stored = storedVerifiedHandle(db, did);
  if (stored !== null) return stored;
  try {
    // Cached right after sign-in by the binding check's fresh resolution.
    const identity = await need(ctx, 'deps').identity.resolveDid(did);
    return identity.handle !== null && isHandle(identity.handle) ? identity.handle.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function getAuthSession(req: Request, ctx: RequestCtx): Promise<Response> {
  const auth = authOf(ctx);
  const guard = requireSession(req, guardCtx(auth, ctx));
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const db = need(ctx, 'deps').db;
  const account = getAccount(db, session.did);
  if (account === null) return authErrorResponse('unauthenticated', ctx.requestId);
  const body = {
    did: session.did,
    handle: await sessionHandle(ctx, db, session.did),
    username: account.username,
    csrfToken: csrfToken(auth.csrfKey, session.token),
    status: account.oauth_status === 'active' ? 'active' : 'reauth_required',
    expiresAt: toDto(fromMs(session.expiresAtMs)),
  };
  return withSessionCookie(json(body), session);
}

// ---------------------------------------------------------------------------
// POST /api/v1/auth/logout

class BadLogoutBody extends Error {}

/** `everywhere` of an optional LogoutInput body. */
async function logoutEverywhere(req: Request): Promise<boolean> {
  if (req.body === null || req.headers.get('content-length') === '0') return false;
  const body = await readJsonBody(req, AUTH_BODY_MAX_BYTES);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BadLogoutBody();
  for (const key of Object.keys(body)) if (key !== 'everywhere') throw new BadLogoutBody();
  const everywhere = (body as { everywhere?: unknown }).everywhere;
  if (everywhere !== undefined && typeof everywhere !== 'boolean') throw new BadLogoutBody();
  return everywhere === true;
}

/** True while the DID still needs its OAuth session: a live web session or a protocol credential. */
export function oauthSessionStillNeeded(db: Db, did: string, nowMs: number): boolean {
  return (
    db.one<{ one: number }>(
      `SELECT 1 AS one WHERE
         EXISTS (SELECT 1 FROM web_sessions WHERE did = ? AND expires_at_ms > ?)
         OR EXISTS (SELECT 1 FROM lastfm_sessions WHERE did = ?)
         OR EXISTS (SELECT 1 FROM app_passwords WHERE did = ?)
         OR EXISTS (SELECT 1 FROM lb_tokens WHERE did = ?)`,
      did,
      nowMs,
      did,
      did,
      did,
    ) !== null
  );
}

export async function postAuthLogout(req: Request, ctx: RequestCtx): Promise<Response> {
  const auth = authOf(ctx);
  const guard = requireSession(req, guardCtx(auth, ctx));
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let everywhere: boolean;
  try {
    everywhere = await logoutEverywhere(req);
  } catch (error) {
    if (error instanceof BadLogoutBody) return errorResponse('bad_request', 400, ctx.requestId);
    return toErrorResponse(error, ctx.requestId);
  }
  const { db, clock, log } = need(ctx, 'deps');
  const deleted = everywhere ? auth.sessions.logoutAll(session.did) : auth.sessions.logout(session.token) ? 1 : 0;
  const outcome = await auth.oauth.revoke(session.did, {
    unless: () => oauthSessionStillNeeded(db, session.did, clock.nowMs()),
  });
  log.log('info', 'signed_out', { requestId: ctx.requestId, did: session.did, sessions: deleted, oauth: outcome });
  return noContent([clearSessionCookie()]);
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/account/connection

const hexOf = (blob: ArrayBuffer | Uint8Array): string =>
  Buffer.from(blob instanceof Uint8Array ? blob : new Uint8Array(blob)).toString('hex');

export interface DisconnectReport {
  /** Rows deleted or changed per table. */
  changed: Record<string, number>;
  /** The cancelled operation ids. */
  cancelled: string[];
}

/**
 * The local half of a disconnect (module comment), in one transaction: every
 * deletion is journaled before the transaction commits, so a journal failure
 * rolls everything back.
 */
export function disconnectLocally(
  deps: { db: Db; revocations: Revocations },
  did: string,
  nowMs: number,
): DisconnectReport {
  const { db, revocations } = deps;
  const changed: Record<string, number> = {};
  const add = (table: string, n: number) => {
    if (n > 0) changed[table] = (changed[table] ?? 0) + n;
  };
  let cancelled: string[] = [];
  db.tx(() => {
    for (const r of db.all<{ token_hash: ArrayBuffer }>(
      'SELECT token_hash FROM web_sessions WHERE did = ? ORDER BY created_at_ms, token_hash',
      did,
    )) {
      revocations.record({ kind: 'web_session', hash: hexOf(r.token_hash), did });
    }
    add('web_sessions', db.run('DELETE FROM web_sessions WHERE did = ?', did).rowsWritten);
    for (const [table, kind, idCol] of [
      ['lastfm_sessions', 'lastfm_session', 'id'],
      ['app_passwords', 'app_password', 'id'],
      ['lb_tokens', 'lb_token', 'id'],
      ['lastfm_apps', 'lastfm_app', 'api_key'],
    ] as const) {
      for (const r of db.all<{ id: string }>(`SELECT ${idCol} AS id FROM ${table} WHERE did = ? ORDER BY 1`, did)) {
        revocations.record({ kind, id: r.id, did });
      }
      add(table, db.run(`DELETE FROM ${table} WHERE did = ?`, did).rowsWritten);
    }
    add('lastfm_tokens', db.run('DELETE FROM lastfm_tokens WHERE did = ?', did).rowsWritten);
    add('link_states', db.run('DELETE FROM link_states WHERE did = ?', did).rowsWritten);
    // Never-sent operations first: cancelling one also deletes its unsent forward rows.
    cancelled = cancelUnsentForDid(db, did, nowMs);
    add('operations', cancelled.length);
    for (const r of db.all<{ id: string }>('SELECT id FROM linked_accounts WHERE did = ? ORDER BY id', did)) {
      revocations.record({ kind: 'linked_account', id: r.id, did });
    }
    // The forward rows cascade with their link; deleted explicitly so the count is exact.
    add(
      'forward_outbox',
      db.run('DELETE FROM forward_outbox WHERE link_id IN (SELECT id FROM linked_accounts WHERE did = ?)', did)
        .rowsWritten,
    );
    add('linked_accounts', db.run('DELETE FROM linked_accounts WHERE did = ?', did).rowsWritten);
    revocations.record({ kind: 'account_disconnect', did });
    add(
      'accounts',
      db.run(
        "UPDATE accounts SET oauth_status = 'signed_out', updated_at_ms = ? WHERE did = ? AND oauth_status != 'signed_out'",
        nowMs,
        did,
      ).rowsWritten,
    );
  });
  return { changed, cancelled };
}

export async function deleteAccountConnection(req: Request, ctx: RequestCtx): Promise<Response> {
  const auth = authOf(ctx);
  const guard = requireSession(req, guardCtx(auth, ctx));
  if (!guard.ok) return guard.response;
  const did = guard.session.did;
  const { db, clock, log } = need(ctx, 'deps');
  // Local first: nothing of the DID is usable while the upstream revocation awaits the AS.
  const report = disconnectLocally({ db, revocations: auth.revocations }, did, clock.nowMs());
  const outcome = await auth.oauth.revoke(did);
  log.log('info', 'account_disconnected', {
    requestId: ctx.requestId,
    did,
    changed: report.changed,
    cancelled: report.cancelled.length,
    oauth: outcome,
  });
  return noContent([clearSessionCookie()]);
}

// ---------------------------------------------------------------------------
// Route table and feature

export const routes: RouteDef[] = [
  { method: 'POST', pattern: AUTH_START_PATH, handler: postAuthStart },
  { method: 'GET', pattern: OAUTH_CALLBACK_ROUTE, handler: getOAuthCallback },
  { method: 'GET', pattern: AUTH_SESSION_PATH, handler: getAuthSession },
  { method: 'POST', pattern: AUTH_LOGOUT_PATH, handler: postAuthLogout },
  { method: 'DELETE', pattern: ACCOUNT_CONNECTION_PATH, handler: deleteAccountConnection },
];

export interface AuthFeatureOptions {
  /** The revocation journal (production: the file journal under $STATE_DIRECTORY, N1-08). */
  revocations: Revocations;
  /**
   * An OAuth service the composition already built (it must share this
   * feature's database and journal); otherwise one is built over the
   * composition's module deps with policyFetch over its transport.
   */
  oauth?: (context: FeatureContext, parts: { keyset: OAuthKeyset }) => OAuthService;
  /** The sign-in policy; the configuration's (ATMUSIC_SIGNIN_POLICY, ATMUSIC_SIGNIN_DIDS) by default. */
  signIn?: SignInPolicy;
  /** policyFetch's deadline source; AbortSignal.timeout by default. */
  timer?: DeadlineTimer;
  /** Called after a sign-in moved a DID's blocked operations back to queued; default kicks the outbox timer. */
  onAccountActive?: (did: string, context: FeatureContext) => void;
}

/** The OAuth service, web sessions and documents of the auth routes, as one Feature (`auth`). */
export async function authFeature(secrets: Secrets, options: AuthFeatureOptions): Promise<Feature> {
  const keyset = await loadOAuthKeyset(secrets);
  let oauth: OAuthService | null = null;
  return {
    name: 'auth',
    routes: [...routes, ...oauthDocsRoutes],
    services(context) {
      const { deps, config } = context;
      const box = createBox(secrets.encryptionKeys, deps.random);
      const clientMetadata = clientMetadataFor(config);
      oauth =
        options.oauth?.(context, { keyset }) ??
        createOAuthService({
          db: deps.db,
          clock: deps.clock,
          random: deps.random,
          log: deps.log,
          identity: deps.identity,
          policyFetch: createPolicyFetch({
            transport: deps.transport,
            ...(options.timer === undefined ? {} : { timer: options.timer }),
          }),
          box,
          keyset,
          clientMetadata,
          revocations: options.revocations,
          onAccountActive: (did) =>
            options.onAccountActive
              ? options.onAccountActive(did, context)
              : void context.core.extensionTimers.kick('outbox'),
        });
      const auth: AuthServices = {
        oauth,
        sessions: createWebSessions({
          db: deps.db,
          clock: deps.clock,
          random: deps.random,
          revocations: options.revocations,
        }),
        revocations: options.revocations,
        publicOrigin: config.publicOrigin,
        csrfKey: box.csrfKey(),
        signIn: options.signIn ?? { signinPolicy: config.signinPolicy, signinDids: config.signinDids },
        startLimiter: new BucketSet(AUTH_START_RATE, deps.clock, { onFull: 'evict-lru' }),
      };
      return { auth, oauthDocs: { metadata: clientMetadata, keyset } };
    },
    readiness() {
      return oauth?.degraded() === true ? { warnings: ['oauth_store_degraded'] } : {};
    },
  };
}
