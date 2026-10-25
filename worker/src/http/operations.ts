// The cookie routes' shared plumbing and `GET /api/v1/operations/{id}`
// (ADR 0005 §5.6, §5.7, §5.8; contract v1.2; N3-02).
//
// Every v1.2 cookie route of N3-02 (writes.ts, account.ts and this module)
// runs through `cookieRoute(handler, {unsafe})`:
//
// 1. The cookie guard (bff/guard.ts `requireSession`): no, an unknown or an
//    expired session cookie is 401 `unauthenticated`; an unsafe method (or
//    `unsafe: true`) that fails the exactly-one-Origin rule or the HMAC
//    X-CSRF-Token is 403 `csrf_failed`. Authentication comes first, as in the
//    Rust oracle. A refused request writes nothing.
// 2. The handler runs with the session. An ApiError it throws (the v1.1
//    vocabulary: invalid_json, payload_too_large, validation_failed, ...) is
//    answered with the envelope; anything else propagates to the router's
//    generic 500.
// 3. When the guard renewed the session (its term is more than 24 h old), the
//    renewal Set-Cookie is appended to whatever the handler answered.
//
// The service. These routes need the session store, the public origin and the
// CSRF key, which a RequestCtx does not carry. They read them from
// `ctx.app.webWrites` (`WebWritesServices`), which `writesFeature` (writes.ts)
// builds from the composition's FeatureContext. A composition without it
// answers a generic 500 (CtxWiringError), never a request without a guard.
// The member is not added to AppServices by declaration merging: compose.ts
// assigns services through a direct `AppServices` → `Record<string, unknown>`
// cast, which stops type-checking once AppServices has a member, so the
// accessor below narrows `ctx.app` itself.
//
// v1.2 error codes. The frozen v1.1 ErrorCode union (@atmusic/core/errors)
// does not hold idempotency_key_required, invalid_idempotency_key,
// idempotency_conflict, publication_disabled, username_taken or
// username_invalid, so `v12ErrorResponse` builds those envelopes here with
// the fixed messages of api/examples/v1.2/error-*.json, `Cache-Control:
// no-store` and sorted `fields`, exactly like http/error.ts.
//
// GET /api/v1/operations/{id}: the caller's own outbox operation as the v1.2
// Operation DTO (outbox/operations.ts `operationDto`), `Cache-Control:
// no-store`. An id of another DID, an unknown id and a malformed id are all
// the same 404 `not_found`, so a caller learns nothing about another
// account's operations (M1.3.3, M2.4.2). The Rust oracle answered 403 for
// another owner; ADR 0005 §5.7 binds 404.

import type { AccountCapability } from '@atmusic/core/api-types';
import { ApiError } from '@atmusic/core/errors';
import { requireSession, type SessionGuardCtx, withSessionCookie } from '../bff/guard';
import type { WebSession } from '../bff/sessions';
import { loadOperation, operationDto } from '../outbox/operations';
import { errorResponse, toErrorResponse } from './error';
import { json } from './json';
import { CtxWiringError, need, type RequestCtx, type RouteDef } from './types';

/** What the cookie guard needs of the session store (lookup without writing, then renew). */
export type GuardSessions = SessionGuardCtx['sessions'];

/** The per-process inputs of the N3-02 cookie routes. */
export interface WebWritesService {
  readonly sessions: GuardSessions;
  /** ATMUSIC_PUBLIC_ORIGIN (the only Origin an unsafe cookie request may carry). */
  readonly publicOrigin: string;
  /** The 32-byte CSRF HMAC key (crypto/box.ts `csrfKey()`). */
  readonly csrfKey: Uint8Array;
  /** Makes the `outbox` extension timer due now (after an operation was persisted). */
  kickOutbox(): void;
  /** The Account DTO's `capabilities` for a signed-in DID. */
  capabilities(did: string): readonly AccountCapability[];
}

/** The AppServices part writesFeature provides. */
export interface WebWritesServices {
  webWrites: WebWritesService;
}

/** The WebWritesService of the composition, or CtxWiringError (a generic 500). */
export function webWrites(ctx: RequestCtx): WebWritesService {
  const service = (need(ctx, 'app') as Partial<WebWritesServices>).webWrites;
  if (service === undefined || service === null) throw new CtxWiringError('app');
  return service;
}

// ---------------------------------------------------------------------------
// v1.2 errors

export type V12ErrorCode =
  | 'idempotency_key_required'
  | 'invalid_idempotency_key'
  | 'idempotency_conflict'
  | 'publication_disabled'
  | 'username_taken'
  | 'username_invalid';

/** Status and fixed message of each v1.2 code (api/examples/v1.2/error-*.json). */
export const V12_ERRORS: Readonly<Record<V12ErrorCode, { status: number; message: string }>> = {
  idempotency_key_required: { status: 400, message: 'Idempotency-Key header is required.' },
  invalid_idempotency_key: {
    status: 400,
    message: 'Idempotency-Key must be 1-128 characters from [A-Za-z0-9._~-].',
  },
  idempotency_conflict: { status: 409, message: 'This Idempotency-Key was used with a different request.' },
  publication_disabled: { status: 503, message: 'Publication is disabled on this server.' },
  username_taken: { status: 409, message: 'This username is taken.' },
  username_invalid: { status: 422, message: 'A dotted username must equal your own verified handle.' },
};

/** The envelope of a v1.2 code: `{error:{code, message, requestId, fields?}}`, no-store. */
export function v12ErrorResponse(
  code: V12ErrorCode,
  requestId: string,
  fields?: Readonly<Record<string, string>>,
): Response {
  const { status, message } = V12_ERRORS[code];
  const error: { code: string; message: string; requestId: string; fields?: Record<string, string> } = {
    code,
    message,
    requestId,
  };
  if (fields !== undefined && Object.keys(fields).length > 0) {
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(fields).sort()) sorted[key] = fields[key] as string;
    error.fields = sorted;
  }
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** 503 `publication_disabled` unless the namespace gate is open (meta.capabilities has `publication`). */
export function publicationGate(ctx: RequestCtx): Response | null {
  return need(ctx, 'deps').config.publication ? null : v12ErrorResponse('publication_disabled', ctx.requestId);
}

// ---------------------------------------------------------------------------
// The cookie route wrapper

export type CookieHandler = (
  req: Request,
  ctx: RequestCtx,
  params: Record<string, string>,
  session: WebSession,
) => Promise<Response>;

/** Wraps `handler` in the guard (see the header); `unsafe` adds CSRF to a safe method. */
export function cookieRoute(handler: CookieHandler, options: { unsafe?: boolean } = {}): RouteDef['handler'] {
  return async (req, ctx, params) => {
    const service = webWrites(ctx);
    const guard = requireSession(
      req,
      {
        requestId: ctx.requestId,
        sessions: service.sessions,
        publicOrigin: service.publicOrigin,
        csrfKey: service.csrfKey,
      },
      options.unsafe === true ? { unsafe: true } : {},
    );
    if (!guard.ok) return guard.response;
    let response: Response;
    try {
      response = await handler(req, ctx, params, guard.session);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      response = toErrorResponse(error, ctx.requestId);
    }
    return withSessionCookie(response, guard.session);
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/operations/{id}

/** OpenAPI `OperationId`. */
export const OPERATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const getOperation: CookieHandler = async (_req, ctx, params, session) => {
  const id = params.id ?? '';
  const op = OPERATION_ID_RE.test(id) ? loadOperation(need(ctx, 'deps').db, id) : null;
  // Another DID's operation is indistinguishable from an unknown one.
  if (op === null || op.did !== session.did) return errorResponse('not_found', 404, ctx.requestId);
  return json(operationDto(op), 200, { 'cache-control': 'no-store' });
};

export const OPERATION_PATTERN = '/api/v1/operations/{id}';

export const routes: RouteDef[] = [{ method: 'GET', pattern: OPERATION_PATTERN, handler: cookieRoute(getOperation) }];
