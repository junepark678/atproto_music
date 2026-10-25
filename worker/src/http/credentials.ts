// Credential management routes (ADR 0005 §5.7 "Credentials", §7.3, §8.2,
// §13, §14.5; contract v1.2; N3-10).
//
//   GET    /api/v1/account/credentials                 → 200 Credentials (metadata only)
//   POST   /api/v1/account/app-passwords               → 201 CreatedAppPassword
//   DELETE /api/v1/account/app-passwords/{id}          → 204
//   POST   /api/v1/account/listenbrainz-tokens         → 201 CreatedListenbrainzToken
//   DELETE /api/v1/account/listenbrainz-tokens/{id}    → 204
//   POST   /api/v1/account/lastfm-apps                 → 201 CreatedLastfmApp
//   DELETE /api/v1/account/lastfm-apps/{apiKey}        → 204
//   DELETE /api/v1/account/lastfm-sessions/{id}        → 204
//
// **Authentication.** Every route runs the cookie guard (bff/guard.ts) first,
// before any body byte is read: no valid session → 401 `unauthenticated`;
// every POST and DELETE also needs the CSRF rule (exactly one Origin equal to
// ATMUSIC_PUBLIC_ORIGIN and the session's X-CSRF-Token) → 403 `csrf_failed`.
// A refused request writes nothing. An admitted request that renewed the
// session carries the renewal Set-Cookie (guard.ts withSessionCookie).
//
// **Secrets are shown once.** A create answers 201 with the secret — the app
// password, the ListenBrainz token or the issued app's shared secret — and
// `Cache-Control: no-store`. Nothing keeps the plaintext: app passwords and
// tokens are stored as SHA-256, the shared secret only sealed with the box
// (credentials/*.ts, N2-09). No other response carries it: the listing returns
// ids, labels, names, client names and timestamps only, never a hash, a
// ciphertext or a key id.
//
// App passwords are issued as lowercase base32 (crypto/tokens.ts) and shown in
// the contract's uppercase spelling (`^[A-Z2-7]{24}$`, CreatedAppPassword);
// auth.getMobileSession folds case (credentials/app-passwords.ts
// normaliseAppPassword), so either spelling signs in.
//
// **Request bodies** (POST): JSON, at most 64 KiB (`x-maxBodyBytes`): over it
// 413 `payload_too_large`; empty, invalid UTF-8, a BOM or anything JSON.parse
// refuses 400 `invalid_json`. The body is strict: one object whose only
// member is `label` (app passwords, tokens) or `name` (issued apps). A
// non-object, an unknown member or a member given twice is 422 `fields.body`;
// a missing, non-string, blank, over-long (64 characters after trimming) or
// control-character value is 422 naming the field. Keys and values are never
// echoed.
//
// **Deletes** remove one credential of the session's DID and journal the
// revocation before the delete commits (credentials/*.ts, ADR §14.5): a
// journal failure rolls the delete back and the request is the generic 500.
// An id that is not the contract's shape (CredentialId `^[A-Za-z0-9_-]{1,64}$`,
// LastfmApiKey `^[0-9a-f]{32}$`), unknown, or another DID's is 404
// `not_found`. A deleted Last.fm session key is answered 9 by /2.0 and a
// deleted ListenBrainz token 401 by /1, because both verify against the rows
// these routes delete (credentials/lastfm-auth.ts verifySessionKey,
// credentials/lb-tokens.ts verifyLbToken).
//
// **Listing fallbacks.** The contract requires a non-empty `label` and
// `clientName`. Every credential these routes create has a label; a row
// created without one (the columns allow NULL) is listed as `(unlabelled)`,
// and a Last.fm session whose client gave no name and whose key is not an
// issued app's is listed under its `api_key`.
//
// **Wiring.** `credentialsFeature({ revocations })` is the Node composition's
// Feature (node/compose.ts): its `services` hook builds the routes' service
// once, from the db, clock and random of the core's ModuleDeps, the box over
// the operator's encryption keys (its CSRF key too), the public origin, and
// web sessions over the same journal. The routes reach it through the
// feature's own closure, not RequestCtx.app, so the feature adds no
// AppServices member. `credentialRoutes(resolve)` builds the same routes over
// any service (`createCredentialSettings`); a request before the service
// exists is the generic 500.
// The revocation journal is the caller's input (FileRevocations at
// $STATE_DIRECTORY/revocations.log in production; an in-memory or failing
// one in tests): fault injection is only through that interface.

import { ApiError } from '@atmusic/core/errors';
import { fromMs, toDto } from '@atmusic/core/timestamp';
import type { Revocations } from '../app/revocations';
import { requireSession, type SessionGuardCtx, sessionErrorResponse, withSessionCookie } from '../bff/guard';
import { createWebSessions, type WebSession, type WebSessions } from '../bff/sessions';
import { CredentialError, normaliseLabel } from '../credentials/accounts';
import { createAppPassword, listAppPasswords, revokeAppPassword } from '../credentials/app-passwords';
import { createLastfmApp, deleteLastfmApp, type LastfmAppDeps, listLastfmApps } from '../credentials/lastfm-apps';
import { listLastfmSessions, revokeLastfmSession } from '../credentials/lastfm-auth';
import { createLbToken, listLbTokens, revokeLbToken } from '../credentials/lb-tokens';
import { type Box, createBox } from '../crypto/box';
import type { Feature } from '../node/compose';
import { errorResponse, toErrorResponse } from './error';
import { json, NO_STORE } from './json';
import { topLevelKeys } from './notify';
import { invalidField, readJsonBody } from './params';
import type { RequestCtx, RouteDef } from './types';

export const CREDENTIALS_PATTERN = '/api/v1/account/credentials';
export const APP_PASSWORDS_PATTERN = '/api/v1/account/app-passwords';
export const LB_TOKENS_PATTERN = '/api/v1/account/listenbrainz-tokens';
export const LASTFM_APPS_PATTERN = '/api/v1/account/lastfm-apps';
export const LASTFM_SESSIONS_PATTERN = '/api/v1/account/lastfm-sessions';

/** The contract's `x-maxBodyBytes` of every credential create body. */
export const CREDENTIAL_MAX_BODY_BYTES = 65_536;

/** api/openapi.yaml CredentialId. */
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** api/openapi.yaml LastfmApiKey: an api_key this server issued. */
const ISSUED_API_KEY_RE = /^[0-9a-f]{32}$/;

/** Listed in place of a NULL label (module comment). */
export const UNLABELLED = '(unlabelled)';

const EXPECTED_LABEL = 'Expected 1 to 64 printable characters.';
const expectedBody = (member: string) => `Expected a JSON object with one string ${member} field and no other fields.`;

/** What the handlers need; built once by `credentialsFeature`, or directly with `createCredentialSettings`. */
export interface CredentialSettingsService {
  /** db, clock, random, the revocation journal and the box (the credential modules' deps). */
  readonly deps: LastfmAppDeps;
  readonly sessions: Pick<WebSessions, 'lookupCookieHeader' | 'renew'>;
  /** ATMUSIC_PUBLIC_ORIGIN. */
  readonly publicOrigin: string;
  /** The 32-byte CSRF HMAC key (crypto/box.ts csrfKey()). */
  readonly csrfKey: Uint8Array;
}

export interface CredentialSettingsInput {
  db: LastfmAppDeps['db'];
  clock: LastfmAppDeps['clock'];
  random: LastfmAppDeps['random'];
  revocations: Revocations;
  box: Box;
  publicOrigin: string;
  /** Default: web sessions over the same db, clock, random and journal. */
  sessions?: Pick<WebSessions, 'lookupCookieHeader' | 'renew'>;
}

export function createCredentialSettings(input: CredentialSettingsInput): CredentialSettingsService {
  const { db, clock, random, revocations, box } = input;
  return {
    deps: { db, clock, random, revocations, box },
    sessions: input.sessions ?? createWebSessions({ db, clock, random, revocations }),
    publicOrigin: input.publicOrigin,
    csrfKey: box.csrfKey(),
  };
}

// ---------------------------------------------------------------------------
// Shared steps

const iso = (ms: number): string => toDto(fromMs(ms));

/** The service is not built yet: the composition did not run the feature's `services` hook. */
export class CredentialSettingsUnavailable extends Error {
  override readonly name = 'CredentialSettingsUnavailable';
  constructor() {
    super('the credential-settings service is not composed');
  }
}

/** A credential handler: a RouteDef handler that also receives the service. */
type CredentialHandler = (
  svc: CredentialSettingsService,
  req: Request,
  ctx: RequestCtx,
  params: Record<string, string>,
) => Promise<Response>;

/**
 * Runs `handle` for the session `req` authenticates, or answers the guard's
 * 401/403. A CredentialError or ApiError becomes its envelope; anything else
 * (a journal failure, a database error) propagates to the router's generic
 * 500, which logs it by name.
 */
async function withSession(
  svc: CredentialSettingsService,
  req: Request,
  ctx: RequestCtx,
  handle: (session: WebSession) => Promise<Response> | Response,
): Promise<Response> {
  const guardCtx: SessionGuardCtx = {
    requestId: ctx.requestId,
    sessions: svc.sessions,
    publicOrigin: svc.publicOrigin,
    csrfKey: svc.csrfKey,
  };
  const guard = requireSession(req, guardCtx);
  if (!guard.ok) return guard.response;
  let response: Response;
  try {
    response = await handle(guard.session);
  } catch (error) {
    if (error instanceof ApiError) response = toErrorResponse(error, ctx.requestId);
    else if (error instanceof CredentialError) response = credentialErrorResponse(error, ctx.requestId);
    else throw error;
  }
  return withSessionCookie(response, guard.session);
}

function credentialErrorResponse(error: CredentialError, requestId: string): Response {
  switch (error.reason) {
    case 'label_invalid':
      return errorResponse('validation_failed', 422, requestId, { label: EXPECTED_LABEL });
    case 'name_invalid':
      return errorResponse('validation_failed', 422, requestId, { name: EXPECTED_LABEL });
    case 'no_account':
      // Only signed-in accounts hold credentials; signing in again creates the account.
      return sessionErrorResponse('unauthenticated', requestId);
    default:
      throw error;
  }
}

/**
 * The value of `member`, the only member of a strict JSON object body
 * (module comment), normalised as a credential label; throws the 400, 413 or
 * 422 ApiError otherwise.
 */
async function readLabelBody(req: Request, member: 'label' | 'name'): Promise<string> {
  const copy = req.clone();
  let body: unknown;
  try {
    body = await readJsonBody(req, CREDENTIAL_MAX_BODY_BYTES);
  } catch (error) {
    if (copy.body !== null) await copy.body.cancel().catch(() => undefined);
    throw error;
  }
  const text = await copy.text();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidField('body', expectedBody(member));
  }
  const keys = topLevelKeys(text);
  if (keys === null || keys.some((key) => key !== member) || keys.length > 1) {
    throw invalidField('body', expectedBody(member));
  }
  const value = (body as Record<string, unknown>)[member];
  if (typeof value !== 'string') throw invalidField(member, EXPECTED_LABEL);
  let label: string | null;
  try {
    label = normaliseLabel(value);
  } catch (error) {
    if (error instanceof CredentialError) throw invalidField(member, EXPECTED_LABEL);
    throw error;
  }
  if (label === null) throw invalidField(member, EXPECTED_LABEL);
  return label;
}

/** The 201 of a create: the secret is in this body only, never cached. */
function created(body: unknown): Response {
  return json(body, 201, { 'cache-control': NO_STORE });
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': NO_STORE } });
}

function notFound(requestId: string): Response {
  return errorResponse('not_found', 404, requestId);
}

// ---------------------------------------------------------------------------
// Handlers

export const getCredentials: CredentialHandler = (svc, req, ctx) =>
  withSession(svc, req, ctx, (session) => {
    const { db } = svc.deps;
    const did = session.did;
    const body = {
      appPasswords: listAppPasswords(db, did).map((p) => ({
        id: p.id,
        label: p.label ?? UNLABELLED,
        createdAt: iso(p.createdAtMs),
        lastUsedAt: p.lastUsedMs === null ? null : iso(p.lastUsedMs),
      })),
      listenbrainzTokens: listLbTokens(db, did).map((t) => ({
        id: t.id,
        label: t.label ?? UNLABELLED,
        createdAt: iso(t.createdAtMs),
        lastUsedAt: t.lastUsedMs === null ? null : iso(t.lastUsedMs),
      })),
      lastfmApps: listLastfmApps(db, did).map((a) => ({
        apiKey: a.apiKey,
        name: a.name,
        createdAt: iso(a.createdAtMs),
      })),
      lastfmSessions: listLastfmSessions(db, did).map((s) => ({
        id: s.id,
        apiKey: s.apiKey,
        clientName: s.clientName ?? s.apiKey,
        createdAt: iso(s.createdAtMs),
        lastUsedAt: s.lastUsedMs === null ? null : iso(s.lastUsedMs),
      })),
    };
    return json(body, 200, { 'cache-control': NO_STORE });
  });

export const postAppPassword: CredentialHandler = (svc, req, ctx) =>
  withSession(svc, req, ctx, async (session) => {
    const label = await readLabelBody(req, 'label');
    const made = createAppPassword(svc.deps, { did: session.did, label });
    return created({
      id: made.id,
      label: made.label ?? label,
      password: made.password.toUpperCase(),
      createdAt: iso(made.createdAtMs),
    });
  });

export const postLbToken: CredentialHandler = (svc, req, ctx) =>
  withSession(svc, req, ctx, async (session) => {
    const label = await readLabelBody(req, 'label');
    const made = createLbToken(svc.deps, { did: session.did, label });
    return created({ id: made.id, label: made.label ?? label, token: made.token, createdAt: iso(made.createdAtMs) });
  });

export const postLastfmApp: CredentialHandler = (svc, req, ctx) =>
  withSession(svc, req, ctx, async (session) => {
    const name = await readLabelBody(req, 'name');
    const made = createLastfmApp(svc.deps, { did: session.did, name });
    return created({
      apiKey: made.apiKey,
      sharedSecret: made.sharedSecret,
      name: made.name,
      createdAt: iso(made.createdAtMs),
    });
  });

type Revoke = (deps: CredentialSettingsService['deps'], did: string, id: string) => boolean;

function deleteHandler(param: 'id' | 'apiKey', shape: RegExp, revoke: Revoke): CredentialHandler {
  return (svc, req, ctx, params) =>
    withSession(svc, req, ctx, (session) => {
      const id = params[param];
      if (id === undefined || !shape.test(id)) return notFound(ctx.requestId);
      return revoke(svc.deps, session.did, id) ? noContent() : notFound(ctx.requestId);
    });
}

export const deleteAppPassword = deleteHandler('id', CREDENTIAL_ID_RE, revokeAppPassword);
export const deleteLbToken = deleteHandler('id', CREDENTIAL_ID_RE, revokeLbToken);
export const deleteIssuedLastfmApp = deleteHandler('apiKey', ISSUED_API_KEY_RE, deleteLastfmApp);
export const deleteLastfmSession = deleteHandler('id', CREDENTIAL_ID_RE, revokeLastfmSession);

const TABLE: readonly [RouteDef['method'], string, CredentialHandler][] = [
  ['GET', CREDENTIALS_PATTERN, getCredentials],
  ['POST', APP_PASSWORDS_PATTERN, postAppPassword],
  ['DELETE', `${APP_PASSWORDS_PATTERN}/{id}`, deleteAppPassword],
  ['POST', LB_TOKENS_PATTERN, postLbToken],
  ['DELETE', `${LB_TOKENS_PATTERN}/{id}`, deleteLbToken],
  ['POST', LASTFM_APPS_PATTERN, postLastfmApp],
  ['DELETE', `${LASTFM_APPS_PATTERN}/{apiKey}`, deleteIssuedLastfmApp],
  ['DELETE', `${LASTFM_SESSIONS_PATTERN}/{id}`, deleteLastfmSession],
];

/**
 * The credential routes over the service `resolve` answers; a request while
 * it answers null is the generic 500 (CredentialSettingsUnavailable).
 */
export function credentialRoutes(resolve: () => CredentialSettingsService | null): RouteDef[] {
  return TABLE.map(([method, pattern, handle]) => ({
    method,
    pattern,
    handler(req, ctx, params) {
      const svc = resolve();
      if (svc === null) throw new CredentialSettingsUnavailable();
      return handle(svc, req, ctx, params);
    },
  }));
}

// ---------------------------------------------------------------------------
// Feature

export const CREDENTIALS_FEATURE_NAME = 'credential-settings';

export interface CredentialsFeatureOptions {
  /** The revocation journal every delete appends to before it commits (ADR §14.5). */
  revocations: Revocations;
  /** Default: web sessions over the composed db, clock, random and `revocations`. */
  sessions?: Pick<WebSessions, 'lookupCookieHeader' | 'renew'>;
}

/** The credential routes and their service, for the Node composition (node/compose.ts Feature). */
export function credentialsFeature(options: CredentialsFeatureOptions): Feature {
  let svc: CredentialSettingsService | null = null;
  return {
    name: CREDENTIALS_FEATURE_NAME,
    routes: credentialRoutes(() => svc),
    services(context) {
      const { db, clock, random } = context.deps;
      svc = createCredentialSettings({
        db,
        clock,
        random,
        revocations: options.revocations,
        box: createBox(context.secrets.encryptionKeys, random),
        publicOrigin: context.config.publicOrigin,
        ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
      });
      return {};
    },
  };
}
