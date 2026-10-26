// Link routes and the forwarding feature (ADR 0005 §12.1, §5.6, §13;
// api/openapi.yaml v1.2 `links_*`; N3-08).
//
// | route                                   | auth           | answer                                  |
// |-----------------------------------------|----------------|-----------------------------------------|
// | GET    /api/v1/links                    | cookie         | 200 LinkList                            |
// | POST   /api/v1/links/lastfm/start       | cookie + CSRF  | 200 LinkStart; 503 lastfm_not_configured|
// | GET    /api/v1/links/lastfm/callback    | cookie         | 303 /settings/links; 400; 403; 502; 503 |
// | POST   /api/v1/links/listenbrainz       | cookie + CSRF  | 201 Link; 422 fields.token              |
// | PATCH  /api/v1/links/{id}               | cookie + CSRF  | 200 Link; 404                           |
// | DELETE /api/v1/links/{id}               | cookie + CSRF  | 204; 404                                |
//
// The cookie guard (bff/guard.ts) answers 401 `unauthenticated` and 403
// `csrf_failed` first, in that order; nothing below runs for a refused
// request.
//
// **Last.fm linking** needs the owner's key (secrets.lastfm); without it both
// Last.fm routes answer 503 `lastfm_not_configured` and store nothing.
// `start` stores a single-use state (forward/links.ts, 600 s) bound to the
// SHA-256 of this session's token and returns
// `LASTFM_AUTH_URL?api_key=<ours>&cb=<enc(PUBLIC_ORIGIN/api/v1/links/lastfm/callback?state=S)>`.
// The callback checks `state` (64 hex) and `token` (32 hex) — a malformed one
// is 400 — then consumes the state: unknown, used or expired is 400
// `bad_request`; a state bound to another session is 403 `csrf_failed` and
// leaves everything (the state included) unchanged. A good state is deleted
// before the upstream call, so it can never be replayed, then signed
// `auth.getSession` runs; the `sk` is stored sealed with `remote_user` =
// session.name and the answer is 303 to /settings/links. An upstream failure
// is 502 `upstream_error` and stores nothing. These statuses (400, 403, 502,
// 503) are the ones api/openapi.yaml declares for link_lastfm_callback.
//
// **ListenBrainz linking** validates `{token}` with `GET 1/validate-token` on
// LISTENBRAINZ_API_ROOT: `valid: false` is 422 `fields.token`; otherwise the
// token is stored sealed with `remote_user` = user_name (201 Link). An
// upstream failure is 502.
//
// **PATCH** sets `forwardScrobbles` / `forwardNowPlaying` (a closed object of
// booleans, at least one); they decide which new rows enqueueForwards
// (N2-05) creates. Rows already queued are still delivered. **DELETE**
// journals the link (ADR §14.5) and deletes it with its credential and every
// forward row.
//
// The credential never appears in an answer, a log line or an error.
// Request logs never carry the query string (node/dispatch.ts), so the
// callback's `token` stays out of the journal.

import { ApiError } from '@atmusic/core/errors';
import type { Revocations } from '../app/revocations';
import type { AppServices } from '../app/services';
import { requireSession, type SessionGuardCtx, withSessionCookie } from '../bff/guard';
import { createWebSessions, type WebSession, type WebSessions } from '../bff/sessions';
import { CredentialError } from '../credentials/accounts';
import { type Box, createBox } from '../crypto/box';
import { hashToken } from '../crypto/tokens';
import type { Db } from '../do/db';
import type { ForwardRuntime } from '../forward/forwarder';
import { forwardExtension } from '../forward/forwarder';
import { LASTFM_CAPS, LastfmClient } from '../forward/lastfm-client';
import {
  consumeLinkState,
  createLinkState,
  deleteLink,
  type LinkPatch,
  linkDto,
  listLinks,
  patchLink,
  saveLink,
} from '../forward/links';
import { LISTENBRAINZ_CAPS, ListenbrainzClient } from '../forward/listenbrainz-client';
import { UpstreamPacing } from '../forward/upstream-pacing';
import type { Feature, FeatureContext } from '../node/compose';
import { bindPolicyFetch, createPolicyFetch } from '../node/policy-fetch';
import { errorResponse, toErrorResponse } from './error';
import { json } from './json';
import { readJsonBody } from './params';
import { CtxWiringError, need, type RequestCtx, type RouteDef } from './types';

/** The JSON body cap of the link routes (the contract's x-maxBodyBytes). */
export const LINK_BODY_MAX_BYTES = 65_536;
/** Where the Last.fm callback sends the browser. */
export const LINKS_SETTINGS_PATH = '/settings/links';
export const LASTFM_CALLBACK_PATH = '/api/v1/links/lastfm/callback';

const STATE_RE = /^[0-9a-f]{64}$/;
const LASTFM_TOKEN_RE = /^[0-9a-f]{32}$/;
const MAX_LB_TOKEN_CHARS = 256;

/** What the link routes need, built once per process (`linksFeature`). */
export interface LinksService {
  db: Db;
  box: Box;
  sessions: Pick<WebSessions, 'lookupCookieHeader' | 'renew'>;
  revocations: Revocations;
  /** ATMUSIC_PUBLIC_ORIGIN. */
  publicOrigin: string;
  /** LASTFM_AUTH_URL. */
  lastfmAuthUrl: string;
  /** Null without the owner's Last.fm key. */
  lastfm: LastfmClient | null;
  listenbrainz: ListenbrainzClient;
  /** The forwarding runtime the `forward` timer runs. */
  forwarding: ForwardRuntime;
}

/**
 * The link service from `RequestCtx.app`. It is reached through this accessor
 * rather than by declaration merging into AppServices, so `ctx.app` is
 * narrowed through `unknown` (AppServices has members by interface merging).
 */
export function linksServiceOf(ctx: RequestCtx): LinksService {
  const service = (need(ctx, 'app') as unknown as Record<string, unknown>).links as LinksService | undefined;
  if (service === undefined) throw new CtxWiringError('app');
  return service;
}

// ---------------------------------------------------------------------------
// Envelopes of the v1.2 codes outside the frozen v1.1 union

function v12Error(
  code: 'lastfm_not_configured' | 'csrf_failed',
  status: number,
  message: string,
  requestId: string,
): Response {
  return new Response(JSON.stringify({ error: { code, message, requestId } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const notConfigured = (requestId: string) =>
  v12Error('lastfm_not_configured', 503, 'Last.fm is not configured on this server.', requestId);

// ---------------------------------------------------------------------------
// Handlers

type Handler = (
  req: Request,
  ctx: RequestCtx,
  service: LinksService,
  session: WebSession,
  params: Record<string, string>,
) => Promise<Response>;

/** Runs `handler` behind the cookie guard (CSRF on unsafe methods), renewing the cookie on the answer. */
function guarded(handler: Handler): RouteDef['handler'] {
  return async (req, ctx, params) => {
    const service = linksServiceOf(ctx);
    const guardCtx: SessionGuardCtx = {
      requestId: ctx.requestId,
      sessions: service.sessions,
      publicOrigin: service.publicOrigin,
      csrfKey: service.box.csrfKey(),
    };
    const admitted = requireSession(req, guardCtx);
    if (!admitted.ok) return admitted.response;
    let res: Response;
    try {
      res = await handler(req, ctx, service, admitted.session, params);
    } catch (error) {
      // An account that disconnected between the guard and here holds no links.
      if (error instanceof CredentialError && error.reason === 'no_account') {
        res = errorResponse('not_found', 404, ctx.requestId);
      } else {
        res = toErrorResponse(error, ctx.requestId);
      }
    }
    return withSessionCookie(res, admitted.session);
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fieldError(field: string, reason: string): ApiError {
  return new ApiError('validation_failed', `body field ${field} is invalid`, { [field]: reason });
}

const listRoute: Handler = async (_req, _ctx, service, session) =>
  json({ items: listLinks(service.db, session.did).map(linkDto) });

const lastfmStart: Handler = async (_req, ctx, service, session) => {
  if (service.lastfm === null) return notConfigured(ctx.requestId);
  const state = createLinkState(
    { db: service.db, random: service.forwarding.random },
    { did: session.did, sessionTokenHash: hashToken(session.token), service: 'lastfm', now: ctx.clock.nowMs() },
  );
  const cb = `${service.publicOrigin}${LASTFM_CALLBACK_PATH}?state=${state}`;
  const authorizeUrl = `${service.lastfmAuthUrl}?api_key=${encodeURIComponent(service.lastfm.apiKey)}&cb=${encodeURIComponent(cb)}`;
  return json({ authorizeUrl });
};

const lastfmCallback: Handler = async (req, ctx, service, session) => {
  if (service.lastfm === null) return notConfigured(ctx.requestId);
  const q = new URL(req.url).searchParams;
  const states = q.getAll('state');
  const tokens = q.getAll('token');
  if (
    states.length !== 1 ||
    tokens.length !== 1 ||
    !STATE_RE.test(states[0] as string) ||
    !LASTFM_TOKEN_RE.test(tokens[0] as string)
  ) {
    return errorResponse('bad_request', 400, ctx.requestId);
  }
  const consumed = consumeLinkState(service.db, {
    state: states[0] as string,
    sessionTokenHash: hashToken(session.token),
    did: session.did,
    service: 'lastfm',
    now: ctx.clock.nowMs(),
  });
  if (!consumed.ok) {
    if (consumed.reason === 'other_session') {
      return v12Error('csrf_failed', 403, 'The link state belongs to another session.', ctx.requestId);
    }
    return errorResponse('bad_request', 400, ctx.requestId);
  }
  const out = await service.lastfm.getSession(tokens[0] as string);
  if (!out.ok) return errorResponse('upstream_error', 502, ctx.requestId);
  saveLink(
    { db: service.db, clock: ctx.clock, random: service.forwarding.random, box: service.box },
    { did: session.did, service: 'lastfm', remoteUser: out.value.name, credential: out.value.key },
  );
  return new Response(null, { status: 303, headers: { location: LINKS_SETTINGS_PATH, 'cache-control': 'no-store' } });
};

const listenbrainzLink: Handler = async (req, ctx, service, session) => {
  const body = await readJsonBody(req, LINK_BODY_MAX_BYTES);
  if (!isObject(body))
    throw new ApiError('validation_failed', 'body must be an object', { body: 'Expected an object.' });
  for (const key of Object.keys(body)) if (key !== 'token') throw fieldError(key, 'Unknown field.');
  const token = body.token;
  if (typeof token !== 'string' || token.length < 1 || token.length > MAX_LB_TOKEN_CHARS || /\s/.test(token)) {
    throw fieldError('token', 'Expected a ListenBrainz user token.');
  }
  const out = await service.listenbrainz.validateToken(token);
  if (!out.ok) return errorResponse('upstream_error', 502, ctx.requestId);
  if (!out.value.valid) throw fieldError('token', 'ListenBrainz does not accept this token.');
  const saved = saveLink(
    { db: service.db, clock: ctx.clock, random: service.forwarding.random, box: service.box },
    { did: session.did, service: 'listenbrainz', remoteUser: out.value.userName, credential: token },
  );
  return json(linkDto(saved.link), 201);
};

const patchRoute: Handler = async (req, ctx, service, session, params) => {
  const body = await readJsonBody(req, LINK_BODY_MAX_BYTES);
  if (!isObject(body))
    throw new ApiError('validation_failed', 'body must be an object', { body: 'Expected an object.' });
  const keys = Object.keys(body);
  if (keys.length === 0)
    throw new ApiError('validation_failed', 'empty patch', { body: 'Expected at least one field.' });
  const patch: LinkPatch = {};
  for (const key of keys) {
    if (key !== 'forwardScrobbles' && key !== 'forwardNowPlaying') throw fieldError(key, 'Unknown field.');
    const value = body[key];
    if (typeof value !== 'boolean') throw fieldError(key, 'Expected a boolean.');
    patch[key] = value;
  }
  const row = patchLink({ db: service.db, clock: ctx.clock }, session.did, params.id as string, patch);
  if (row === null) return errorResponse('not_found', 404, ctx.requestId);
  return json(linkDto(row));
};

const deleteRoute: Handler = async (_req, ctx, service, session, params) => {
  const id = params.id as string;
  if (!deleteLink({ db: service.db, revocations: service.revocations }, session.did, id)) {
    return errorResponse('not_found', 404, ctx.requestId);
  }
  service.forwarding.pacing.forgetListenbrainz(`link:${id}`);
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};

export const routes: RouteDef[] = [
  { method: 'GET', pattern: '/api/v1/links', handler: guarded(listRoute) },
  { method: 'POST', pattern: '/api/v1/links/lastfm/start', handler: guarded(lastfmStart) },
  { method: 'GET', pattern: LASTFM_CALLBACK_PATH, handler: guarded(lastfmCallback) },
  { method: 'POST', pattern: '/api/v1/links/listenbrainz', handler: guarded(listenbrainzLink) },
  { method: 'PATCH', pattern: '/api/v1/links/{id}', handler: guarded(patchRoute) },
  { method: 'DELETE', pattern: '/api/v1/links/{id}', handler: guarded(deleteRoute) },
];

// ---------------------------------------------------------------------------
// The feature

export interface LinksFeatureOptions {
  /** The process's revocation journal (app/revocations.ts). */
  revocations: Revocations;
  /** The process's upstream pacer, shared with imports (N3-09); a new one by default. */
  pacing?: UpstreamPacing;
  /** The web sessions; by default built over the composed db, clock and random with `revocations`. */
  sessions?: Pick<WebSessions, 'lookupCookieHeader' | 'renew'>;
}

/** Builds the link service and the forwarding runtime from the composition. */
export function buildLinksService(context: FeatureContext, options: LinksFeatureOptions): LinksService {
  const { config, secrets, deps } = context;
  const box = createBox(secrets.encryptionKeys, deps.random);
  const policyFetch = createPolicyFetch({ transport: deps.transport });
  const lastfm =
    secrets.lastfm === null
      ? null
      : new LastfmClient({
          apiRoot: config.lastfmApiRoot,
          apiKey: secrets.lastfm.apiKey,
          sharedSecret: secrets.lastfm.sharedSecret,
          fetch: bindPolicyFetch(policyFetch, LASTFM_CAPS),
        });
  const listenbrainz = new ListenbrainzClient({
    apiRoot: config.listenbrainzApiRoot,
    fetch: bindPolicyFetch(policyFetch, LISTENBRAINZ_CAPS),
  });
  const forwarding: ForwardRuntime = {
    db: deps.db,
    clock: deps.clock,
    random: deps.random,
    log: deps.log,
    box,
    pacing: options.pacing ?? new UpstreamPacing(deps.clock),
    lastfm,
    listenbrainz,
  };
  return {
    db: deps.db,
    box,
    sessions:
      options.sessions ??
      createWebSessions({ db: deps.db, clock: deps.clock, random: deps.random, revocations: options.revocations }),
    revocations: options.revocations,
    publicOrigin: config.publicOrigin,
    lastfmAuthUrl: config.lastfmAuthUrl,
    lastfm,
    listenbrainz,
    forwarding,
  };
}

/** The link routes, the link service and the `forward` extension timer, as one feature. */
export function linksFeature(options: LinksFeatureOptions): Feature {
  let runtime: ForwardRuntime | null = null;
  return {
    name: 'links',
    routes,
    extensions: [forwardExtension(() => runtime)],
    services(context) {
      const service = buildLinksService(context, options);
      runtime = service.forwarding;
      return { links: service } as Partial<AppServices>;
    },
  };
}
