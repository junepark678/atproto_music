// The cookie guard for /api/v1 routes (ADR 0005 §5.6, §13; N2-04).
//
// `requireSession(req, ctx, {unsafe})` answers either the live session or the
// error response the route returns as is:
//
// | condition                                              | answer                    |
// |--------------------------------------------------------|---------------------------|
// | protocol path (/2.0, /2.0/…, /1, /1/…, /audioscrobbler/…) | 401 `unauthenticated`  |
// | no cookie, or an unknown, expired, malformed or repeated one | 401 `unauthenticated` |
// | unsafe request failing the Origin or X-CSRF-Token rule | 403 `csrf_failed`         |
// | otherwise                                              | the session               |
//
// The order is the Rust oracle's: authenticate first (401), then CSRF (403).
//
// - **Protocol paths never read cookies.** The Last.fm (`/2.0`), ListenBrainz
//   (`/1/`) and Audioscrobbler (`/audioscrobbler/`) surfaces authenticate only
//   with protocol credentials, so a browser cookie sent along to them is never
//   looked up, and the guard resolves to no session even when it is valid.
//   `/audioscrobbler/` is the Last.fm submissions protocol (§7.10) and is
//   treated like `/2.0` for that reason.
// - **Which requests need CSRF.** Every method other than GET, HEAD and OPTIONS.
//   `unsafe: true` adds the check to a safe method; `unsafe: false` can never
//   remove it from an unsafe one, so a route cannot opt a POST out by mistake.
// - **Envelopes.** `{error:{code, message, requestId}}`, JSON, `Cache-Control:
//   no-store`, with the fixed messages of api/examples/v1.2/error-401.json and
//   error-403-csrf.json. Those two v1.2 codes are not in the frozen v1.1
//   ErrorCode union (@atmusic/core/errors), so they are built here.
// - **Renewal.** When resolving renewed the session, `session.renewCookie` is
//   set; `withSessionCookie(response, session)` appends it.

import type { CsrfFailureReason } from './csrf';
import { checkCsrf } from './csrf';
import type { WebSession, WebSessions } from './sessions';

export type SessionErrorCode = 'unauthenticated' | 'csrf_failed';

export const SESSION_ERROR_MESSAGES: Readonly<Record<SessionErrorCode, string>> = {
  unauthenticated: 'No valid session cookie.',
  csrf_failed: 'Origin or X-CSRF-Token check failed.',
};

const SESSION_ERROR_STATUS: Readonly<Record<SessionErrorCode, number>> = {
  unauthenticated: 401,
  csrf_failed: 403,
};

/** What the guard needs from the request context. */
export interface SessionGuardCtx {
  requestId: string;
  sessions: Pick<WebSessions, 'resolveCookieHeader'>;
  /** ATMUSIC_PUBLIC_ORIGIN. */
  publicOrigin: string;
  /** The 32-byte CSRF HMAC key (crypto/box.ts csrfKey()). */
  csrfKey: Uint8Array;
}

export interface RequireSessionOptions {
  /** Require CSRF even for a safe method. It never removes the check from an unsafe one. */
  unsafe?: boolean;
}

export type SessionGuardFailure =
  | { reason: 'protocol_path' | 'no_session' }
  | { reason: 'csrf'; csrf: CsrfFailureReason };

export type SessionGuardResult =
  | { ok: true; session: WebSession }
  | { ok: false; response: Response; failure: SessionGuardFailure };

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True for paths whose routes authenticate only with protocol credentials. */
export function isProtocolPath(pathname: string): boolean {
  return (
    pathname === '/2.0' ||
    pathname.startsWith('/2.0/') ||
    pathname === '/1' ||
    pathname.startsWith('/1/') ||
    pathname === '/audioscrobbler' ||
    pathname.startsWith('/audioscrobbler/')
  );
}

/** True when a request with `method` must pass the CSRF check. */
export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** The 401/403 envelope of the cookie routes. */
export function sessionErrorResponse(code: SessionErrorCode, requestId: string): Response {
  return new Response(JSON.stringify({ error: { code, message: SESSION_ERROR_MESSAGES[code], requestId } }), {
    status: SESSION_ERROR_STATUS[code],
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * The session of `req`, or null. Protocol paths are null without reading the
 * cookie. Resolving may renew the session (see WebSession.renewCookie).
 */
export function resolveRequestSession(req: Request, ctx: Pick<SessionGuardCtx, 'sessions'>): WebSession | null {
  if (isProtocolPath(new URL(req.url).pathname)) return null;
  return ctx.sessions.resolveCookieHeader(req.headers.get('cookie'));
}

export function requireSession(
  req: Request,
  ctx: SessionGuardCtx,
  options: RequireSessionOptions = {},
): SessionGuardResult {
  if (isProtocolPath(new URL(req.url).pathname)) {
    return {
      ok: false,
      response: sessionErrorResponse('unauthenticated', ctx.requestId),
      failure: { reason: 'protocol_path' },
    };
  }
  const session = ctx.sessions.resolveCookieHeader(req.headers.get('cookie'));
  if (session === null) {
    return {
      ok: false,
      response: sessionErrorResponse('unauthenticated', ctx.requestId),
      failure: { reason: 'no_session' },
    };
  }
  if (isUnsafeMethod(req.method) || options.unsafe === true) {
    const check = checkCsrf(req.headers, {
      publicOrigin: ctx.publicOrigin,
      key: ctx.csrfKey,
      sessionToken: session.token,
    });
    if (!check.ok) {
      // A renewal already written by the resolve still reaches the browser.
      return {
        ok: false,
        response: withSessionCookie(sessionErrorResponse('csrf_failed', ctx.requestId), session),
        failure: { reason: 'csrf', csrf: check.reason },
      };
    }
  }
  return { ok: true, session };
}

/** `response` with the session's renewal Set-Cookie appended, when it was renewed. */
export function withSessionCookie(response: Response, session: Pick<WebSession, 'renewCookie'>): Response {
  if (session.renewCookie === null) return response;
  const headers = new Headers(response.headers);
  headers.append('set-cookie', session.renewCookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
