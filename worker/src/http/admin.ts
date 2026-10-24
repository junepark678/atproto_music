// Operator routes (ADR 0004 §8 "Admin", A15 PITR, A16 metrics):
//
//   GET  /internal/admin/status      the IndexDO's AdminStatus (schema state,
//                                    indexing truth, ingest checkpoint, hint and
//                                    job counts, every counter)
//   POST /internal/admin/pitr        {atMs}: schedule a point-in-time restore of
//                                    the IndexDO to `atMs` (epoch ms, within the
//                                    last 30 days); the DO restarts into it
//   POST /internal/admin/resnapshot  {did}: re-walk a known DID from its signed
//                                    head (a fresh verified snapshot)
//
// Access:
// - the routes exist only while ADMIN_TOKEN is set (at least 32 characters, as
//   parseConfig requires): otherwise every one is the same JSON 404 as an
//   unknown path, so a deployment without the secret has no admin surface;
// - a request without `Authorization: Bearer <token>` is that same 404;
// - a wrong bearer token is 401 `unauthorized` (`WWW-Authenticate: Bearer`).
//   The comparison is constant-time in the token and its length: both sides
//   are SHA-256 digested and the 32-byte digests compared with
//   `crypto.subtle.timingSafeEqual`, so neither a prefix match nor a length
//   difference changes the work done.
// Neither the token nor the Authorization header is ever logged or echoed.
//
// IndexRpc (frozen in Wave 0) has no resnapshot method, so IndexDO exposes it
// as the extra RPC method AdminRpc.adminResnapshot below.

import type { Did } from '@atmusic/core/api-types';
import { ApiError, DEFAULT_STATUS } from '@atmusic/core/errors';
import { isSupportedDid } from '@atmusic/core/syntax';
import type { AdminStatus, PitrResult } from '../do/contracts';
import { PITR_WINDOW_MS } from '../do/index-do';
import { errorResponse, toErrorResponse } from './error';
import { json } from './json';
import { invalidField, readJsonBody } from './params';
import type { RequestCtx, RouteDef } from './types';

export const ADMIN_STATUS_PATTERN = '/internal/admin/status';
export const ADMIN_PITR_PATTERN = '/internal/admin/pitr';
export const ADMIN_RESNAPSHOT_PATTERN = '/internal/admin/resnapshot';

/** Same floor as parseConfig: a shorter ADMIN_TOKEN never enables the routes. */
export const MIN_ADMIN_TOKEN_CHARS = 32;
export const ADMIN_MAX_BODY_BYTES = 1024;

export type ResnapshotOutcome =
  | { status: 'scheduled' | 'already' }
  | { status: 'unknown' }
  | { status: 'suppressed' }
  | { status: 'busy' };

/** The admin methods IndexDO adds beyond IndexRpc. */
export interface AdminRpc {
  adminResnapshot(did: Did): Promise<ResnapshotOutcome>;
}

const encoder = new TextEncoder();

async function digest(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(text));
}

/** Constant-time string equality over SHA-256 digests (see the header). */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(da, db);
}

/** The configured ADMIN_TOKEN, or null while the admin routes are disabled. */
export function adminToken(env: { ADMIN_TOKEN?: string }): string | null {
  const token = env.ADMIN_TOKEN ?? '';
  return token.length >= MIN_ADMIN_TOKEN_CHARS ? token : null;
}

const BEARER = /^Bearer[ ]+([^\s]+)[ ]*$/i;

type Gate = { ok: true } | { ok: false; response: Response };

/** 404 while disabled or without a bearer token, 401 for a wrong one. */
export async function authorize(req: Request, ctx: RequestCtx): Promise<Gate> {
  const expected = adminToken(ctx.env);
  const presented = BEARER.exec(req.headers.get('authorization') ?? '')?.[1];
  if (expected === null || presented === undefined) {
    return { ok: false, response: errorResponse('not_found', DEFAULT_STATUS.not_found, ctx.requestId) };
  }
  if (!(await constantTimeEqual(presented, expected))) {
    return {
      ok: false,
      response: errorResponse('unauthorized', DEFAULT_STATUS.unauthorized, ctx.requestId, undefined, {
        headers: { 'www-authenticate': 'Bearer' },
      }),
    };
  }
  return { ok: true };
}

function guarded(
  handler: (req: Request, ctx: RequestCtx) => Promise<Response>,
): (req: Request, ctx: RequestCtx) => Promise<Response> {
  return async (req, ctx) => {
    const gate = await authorize(req, ctx);
    if (!gate.ok) {
      if (req.body !== null) await req.body.cancel().catch(() => undefined);
      return gate.response;
    }
    try {
      return await handler(req, ctx);
    } catch (error) {
      return toErrorResponse(error, ctx.requestId);
    }
  };
}

async function status(_req: Request, ctx: RequestCtx): Promise<Response> {
  const body: AdminStatus = await ctx.index.adminStatus();
  return json(body, 200);
}

function strictBody(body: unknown, field: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidField('body', `Expected a JSON object with one ${field} field.`);
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== field) {
    throw invalidField('body', `Expected a JSON object with one ${field} field.`);
  }
  return body as Record<string, unknown>;
}

async function pitr(req: Request, ctx: RequestCtx): Promise<Response> {
  const body = strictBody(await readJsonBody(req, ADMIN_MAX_BODY_BYTES), 'atMs');
  const atMs = body.atMs;
  const now = ctx.clock.nowMs();
  if (typeof atMs !== 'number' || !Number.isSafeInteger(atMs) || atMs > now || atMs < now - PITR_WINDOW_MS) {
    throw invalidField('atMs', 'Expected integer epoch milliseconds within the last 30 days.');
  }
  const result: PitrResult = await ctx.index.adminPitr(atMs);
  return json({ bookmark: result.bookmark, atMs, restart: true }, 202);
}

async function resnapshot(req: Request, ctx: RequestCtx): Promise<Response> {
  const body = strictBody(await readJsonBody(req, ADMIN_MAX_BODY_BYTES), 'did');
  const did = body.did;
  if (typeof did !== 'string' || !isSupportedDid(did)) throw invalidField('did', 'Expected a did:plc or did:web DID.');
  const rpc = ctx.index as RequestCtx['index'] & Partial<AdminRpc>;
  if (typeof rpc.adminResnapshot !== 'function') throw new ApiError('internal_error', 'resnapshot is unavailable');
  const outcome = await rpc.adminResnapshot(did);
  switch (outcome.status) {
    case 'scheduled':
    case 'already':
      return json({ did, status: outcome.status }, 202);
    case 'busy':
      return errorResponse('queue_full', DEFAULT_STATUS.queue_full, ctx.requestId);
    default:
      // Unknown or disconnected (suppressed): nothing this index may walk.
      return errorResponse('not_found', DEFAULT_STATUS.not_found, ctx.requestId);
  }
}

export const routes: RouteDef[] = [
  { method: 'GET', pattern: ADMIN_STATUS_PATTERN, handler: guarded(status) },
  { method: 'POST', pattern: ADMIN_PITR_PATTERN, handler: guarded(pitr) },
  { method: 'POST', pattern: ADMIN_RESNAPSHOT_PATTERN, handler: guarded(resnapshot) },
];
