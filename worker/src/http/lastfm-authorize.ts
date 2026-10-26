// The Last.fm approval routes (ADR 0005 §3.7, §7.3, §13; N3-03):
//
// - `GET /api/auth` and `GET /api/auth/` (the desktop flow opens
//   `/api/auth/?api_key=K&token=T`, multi-scrobbler the slash-less web form
//   `/api/auth?api_key=K&cb=URL`): 302 to the SPA approval page
//   `/lastfm/authorize` with the query string kept byte for byte. They need
//   an `api_key` of 1–64 characters, and a `cb`, when present, must be an
//   acceptable callback (`checkCallback`); otherwise 422
//   `validation_failed` naming the field, and no redirect. The answers carry
//   `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, because a
//   desktop token in the URL is redeemable by whoever reads it.
// - `POST /api/v1/lastfm/authorize {apiKey, token?}` (contract v1.2,
//   cookie + CSRF): with `token` (desktop flow) the auth.getToken token,
//   bound to its api_key, becomes authorized for the session DID; without
//   (web flow) an already-authorized token is created for the page to append
//   to `cb`. 200 `{token}`. An unknown, consumed, expired, foreign or
//   other-api_key token is 404 `not_found`. The body is closed JSON of at
//   most 64 KiB: 400 `invalid_json`, 413, or 422 `validation_failed`.
//
// **Callbacks** (`checkCallback`, `callbackNavigation`): `cb` must be an
// absolute URL whose scheme is not `javascript:`, `data:`, `vbscript:` or
// `file:` (any letter case, leading spaces and control characters ignored
// as browsers ignore them); app deep links such as `pano://` are allowed. On
// approval the page navigates to `cb` + `?token=T`, or `&token=T` when `cb`
// already has a query string (multi-scrobbler's
// `http://localhost:9078/librefm/callback?state=x`); a fragment stays last.
// The page shows the destination host before approval and stays put when the
// user denies (web/, N5).
//
// `lastfmAuthFeature` composes these routes with the `lastfmAuth` service
// (lastfm/auth-methods.ts) for the Node composition (N4-01 adds it to the
// production feature list); the /2.0 dispatcher (N3-04) runs the method
// tables against the same service.

import { ApiError } from '@atmusic/core/errors';
import type { Revocations } from '../app/revocations';
import { requireSession, withSessionCookie } from '../bff/guard';
import { createWebSessions } from '../bff/sessions';
import { authorizeToken, createAuthorizedToken, isValidApiKey } from '../credentials/lastfm-auth';
import { createBox } from '../crypto/box';
import { createLastfmAuthServices, type FailureLimits, lastfmServices } from '../lastfm/auth-methods';
import type { Feature } from '../node/compose';
import { errorResponse, toErrorResponse } from './error';
import { json } from './json';
import { readJsonBody } from './params';
import { need, type RequestCtx, type RouteDef } from './types';

/** The SPA approval page (@atmusic/core/spa-routes, web N5). */
export const APPROVAL_PAGE = '/lastfm/authorize';
/** ADR §3.6 default body cap; the contract's x-maxBodyBytes. */
export const AUTHORIZE_MAX_BODY_BYTES = 64 * 1024;

const TOKEN_RE = /^[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------
// Callbacks

/** Schemes a `cb` may never have. */
export const REFUSED_CALLBACK_SCHEMES: readonly string[] = ['javascript:', 'data:', 'vbscript:', 'file:'];

export type CallbackCheck = { ok: true; url: URL } | { ok: false; reason: 'not_absolute' | 'refused_scheme' };

/** ADR §7.3: an absolute URL with an acceptable scheme. */
export function checkCallback(cb: string): CallbackCheck {
  // Browsers strip leading C0 controls and spaces and ignore tabs and newlines
  // anywhere in a URL; check the scheme they would see, not the raw text.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
  const seen = cb.replace(/^[\u0000- ]+/, '').replace(/[\t\n\r]/g, '');
  let url: URL;
  try {
    url = new URL(seen);
  } catch {
    return { ok: false, reason: 'not_absolute' };
  }
  if (REFUSED_CALLBACK_SCHEMES.includes(url.protocol.toLowerCase())) return { ok: false, reason: 'refused_scheme' };
  return { ok: true, url };
}

/**
 * Where the approval page sends the browser: `cb` with `token` appended as
 * `?token=T`, or `&token=T` when `cb` already has a query; the fragment, if
 * any, stays at the end. Null for a refused `cb`. The rest of `cb` is kept
 * as sent.
 */
export function callbackNavigation(cb: string, token: string): string | null {
  if (!checkCallback(cb).ok) return null;
  const hash = cb.indexOf('#');
  const base = hash < 0 ? cb : cb.slice(0, hash);
  const fragment = hash < 0 ? '' : cb.slice(hash);
  const sep = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
  return `${base}${sep}token=${encodeURIComponent(token)}${fragment}`;
}

// ---------------------------------------------------------------------------
// GET /api/auth, /api/auth/

const REDIRECT_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

function single(query: URLSearchParams, name: string): string | undefined {
  const values = query.getAll(name);
  if (values.length > 1)
    throw new ApiError('validation_failed', `${name} repeated`, { [name]: 'Parameter must occur only once.' });
  return values[0];
}

async function approvalRedirect(req: Request, ctx: RequestCtx): Promise<Response> {
  const url = new URL(req.url);
  const search = url.search;
  try {
    const query = new URLSearchParams(search);
    const apiKey = single(query, 'api_key');
    if (!isValidApiKey(apiKey)) {
      throw new ApiError('validation_failed', 'api_key is invalid', { api_key: 'Expected 1-64 characters.' });
    }
    const cb = single(query, 'cb');
    if (cb !== undefined && !checkCallback(cb).ok) {
      throw new ApiError('validation_failed', 'cb is refused', {
        cb: 'Expected an absolute URL; javascript:, data:, vbscript: and file: are refused.',
      });
    }
    single(query, 'token');
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
  return new Response(null, { status: 302, headers: { ...REDIRECT_HEADERS, location: `${APPROVAL_PAGE}${search}` } });
}

// ---------------------------------------------------------------------------
// POST /api/v1/lastfm/authorize

export interface AuthorizeInput {
  apiKey: string;
  token?: string;
}

/** The closed LastfmAuthorizeInput schema (api/openapi.yaml). */
export function parseAuthorizeInput(body: unknown): AuthorizeInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('validation_failed', 'body must be an object', { body: 'Expected a JSON object.' });
  }
  const object = body as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key !== 'apiKey' && key !== 'token') {
      throw new ApiError('validation_failed', 'unknown field', { [key.slice(0, 64)]: 'Unknown field.' });
    }
  }
  const { apiKey, token } = object;
  if (!isValidApiKey(apiKey)) {
    throw new ApiError('validation_failed', 'apiKey is invalid', { apiKey: 'Expected a string of 1-64 characters.' });
  }
  if (token === undefined) return { apiKey };
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    throw new ApiError('validation_failed', 'token is invalid', { token: 'Expected 32 lowercase hex characters.' });
  }
  return { apiKey, token };
}

async function authorize(req: Request, ctx: RequestCtx): Promise<Response> {
  const services = lastfmServices(ctx);
  const guard = requireSession(req, {
    requestId: ctx.requestId,
    sessions: services.sessions,
    publicOrigin: services.publicOrigin,
    csrfKey: services.csrfKey,
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let response: Response;
  try {
    const input = parseAuthorizeInput(await readJsonBody(req, AUTHORIZE_MAX_BODY_BYTES));
    const m = need(ctx, 'deps');
    if (input.token !== undefined) {
      const result = authorizeToken(m, { did: session.did, apiKey: input.apiKey, token: input.token });
      response = result.ok ? json({ token: input.token }) : errorResponse('not_found', undefined, ctx.requestId);
    } else {
      const result = createAuthorizedToken(m, { did: session.did, apiKey: input.apiKey });
      response = result.ok ? json({ token: result.value.token }) : errorResponse('not_found', undefined, ctx.requestId);
    }
  } catch (error) {
    response = toErrorResponse(error, ctx.requestId);
  }
  return withSessionCookie(response, session);
}

/** The approval routes (module comment). */
export const routes: RouteDef[] = [
  { method: 'GET', pattern: '/api/auth', handler: approvalRedirect },
  { method: 'GET', pattern: '/api/auth/', handler: approvalRedirect },
  { method: 'POST', pattern: '/api/v1/lastfm/authorize', handler: authorize },
];

// ---------------------------------------------------------------------------
// Composition

export interface LastfmAuthFeatureOptions {
  /** The revocation journal the cookie sessions record logouts in (shared with the other BFF features). */
  revocations: Revocations;
  /** Override of the getMobileSession failure limits (tests of the limiter itself). */
  failureLimits?: FailureLimits;
}

/**
 * The `lastfm-auth` feature: the approval routes and the `lastfmAuth`
 * service. The outbox kick goes through IndexCore's extension timers, so it
 * is a no-op until the outbox extension is composed.
 */
export function lastfmAuthFeature(options: LastfmAuthFeatureOptions): Feature {
  return {
    name: 'lastfm-auth',
    routes,
    services({ config, secrets, deps, core }) {
      const box = createBox(secrets.encryptionKeys, deps.random);
      const sessions = createWebSessions({
        db: deps.db,
        clock: deps.clock,
        random: deps.random,
        revocations: options.revocations,
      });
      return {
        lastfmAuth: createLastfmAuthServices({
          box,
          knownClients: config.lastfmKnownClients,
          sessions,
          publicOrigin: config.publicOrigin,
          clock: deps.clock,
          kickOutbox: () => {
            core.extensionTimers.kick('outbox');
          },
          ...(options.failureLimits !== undefined ? { failureLimits: options.failureLimits } : {}),
        }),
      };
    },
  };
}
