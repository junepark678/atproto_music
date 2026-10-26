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
//   are SHA-256 digested and the two 32-byte digests compared in constant
//   time, portably: with workerd's `crypto.subtle.timingSafeEqual` where the
//   runtime has it, else (Node, which has no such method on subtle) with an
//   XOR-accumulating loop that always visits every byte, so neither a prefix
//   match nor a length difference changes the work done.
// Neither the token nor the Authorization header is ever logged or echoed.
//
// IndexRpc (frozen in Wave 0) has no resnapshot method, so IndexDO exposes it
// as the extra RPC method AdminRpc.adminResnapshot below.
//
// The Node host (ADR 0005 §3.11; N3-07) serves its admin routes only on the
// unix socket ATMUSIC_ADMIN_SOCKET (node/admin-socket.ts), where filesystem
// permissions (a 0700 directory holding a 0600 socket) are the
// authentication, so those routes take no token:
//
//   GET  /admin/status               adminStatus plus the host half: backup age
//                                    and last run, queue depths (outbox,
//                                    forward, imports), link failures, OAuth
//                                    sessions per client_kid, upload-directory
//                                    bytes, free space and the readiness
//                                    warnings (low_disk, oauth_store_degraded)
//   POST /admin/backup               one manual backup (ADR 0005 §14.5)
//   POST /admin/resnapshot {did}     as the TCP route
//   POST /admin/oauth/prune-kid {kid} delete the OAuth sessions still bound to
//                                    a retired signing key (§5.4 step 5);
//                                    refused for a kid that still signs
//
// `socketAdminHandler(deps)` answers them. The Workers TCP routes above and
// ADMIN_TOKEN stay in ROUTES for the Workers entry and its workerd suite until
// N4-03 ports composition/admin.test.ts to the socket; N7-01 deletes them. The
// Node dispatcher never reaches them (`/internal/` is its JSON 404).

import type { Did } from '@atmusic/core/api-types';
import type { Random } from '@atmusic/core/deps';
import { ApiError, DEFAULT_STATUS } from '@atmusic/core/errors';
import { isSupportedDid } from '@atmusic/core/syntax';
import { PITR_WINDOW_MS } from '../app/index-core';
import type { AdminStatus, BackupOutcome, PitrResult } from '../do/contracts';
import { errorResponse, toErrorResponse } from './error';
import { json } from './json';
import { invalidField, readJsonBody } from './params';
import { newRequestId } from './request-id';
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

/** Equality of two equal-length byte strings that always compares every byte. */
export function bytesEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Constant-time string equality over SHA-256 digests (see the header); portable to workerd and Node. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  const native = (crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean })
    .timingSafeEqual;
  if (typeof native === 'function') return native.call(crypto.subtle, da, db);
  return bytesEqualConstantTime(new Uint8Array(da), new Uint8Array(db));
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

// ---------------------------------------------------------------------------
// Admin socket routes (Node host, ADR 0005 §3.11; see the header)

export const SOCKET_STATUS_PATH = '/admin/status';
export const SOCKET_BACKUP_PATH = '/admin/backup';
export const SOCKET_RESNAPSHOT_PATH = '/admin/resnapshot';
export const SOCKET_PRUNE_KID_PATH = '/admin/oauth/prune-kid';

const SOCKET_ROUTE_METHODS: Readonly<Record<string, 'GET' | 'POST'>> = {
  [SOCKET_STATUS_PATH]: 'GET',
  [SOCKET_BACKUP_PATH]: 'POST',
  [SOCKET_RESNAPSHOT_PATH]: 'POST',
  [SOCKET_PRUNE_KID_PATH]: 'POST',
};

export type PruneKidOutcome = { status: 'pruned'; kid: string; sessions: number } | { status: 'active_kid' };

/** What the socket routes need from the process (node/run.ts builds it). */
export interface SocketAdminDeps {
  index: {
    adminStatus(): Promise<AdminStatus>;
    adminBackup(): Promise<BackupOutcome>;
    adminResnapshot(did: Did): Promise<ResnapshotOutcome>;
  };
  /** The host half of the status (backup, queues, uploads, disk, warnings). */
  hostStatus(): Promise<Record<string, unknown>> | Record<string, unknown>;
  pruneKid(kid: string): Promise<PruneKidOutcome> | PruneKidOutcome;
  random: Random;
}

const KID = /^[A-Za-z0-9._~-]{1,128}$/;

async function discardBody(req: Request): Promise<void> {
  if (req.body !== null) await req.body.cancel().catch(() => undefined);
}

/**
 * The admin socket's request handler: 404 for an unknown path, 405 with
 * `Allow` for a wrong method, the error envelope for a thrown error, and an
 * `x-request-id` on every answer.
 */
export function socketAdminHandler(deps: SocketAdminDeps): (req: Request) => Promise<Response> {
  const handlers: Record<string, (req: Request, requestId: string) => Promise<Response>> = {
    [SOCKET_STATUS_PATH]: async () => {
      const [core, host] = await Promise.all([deps.index.adminStatus(), deps.hostStatus()]);
      return json({ ...core, ...host }, 200);
    },
    [SOCKET_BACKUP_PATH]: async (req) => {
      await discardBody(req);
      const outcome = await deps.index.adminBackup();
      if (outcome.status === 'ok') return json(outcome, 200);
      if (outcome.status === 'not_supported') return json(outcome, 501);
      return json(outcome, outcome.error === 'low_disk' ? 507 : 500);
    },
    [SOCKET_RESNAPSHOT_PATH]: async (req, requestId) => {
      const body = strictBody(await readJsonBody(req, ADMIN_MAX_BODY_BYTES), 'did');
      const did = body.did;
      if (typeof did !== 'string' || !isSupportedDid(did)) {
        throw invalidField('did', 'Expected a did:plc or did:web DID.');
      }
      const outcome = await deps.index.adminResnapshot(did);
      switch (outcome.status) {
        case 'scheduled':
        case 'already':
          return json({ did, status: outcome.status }, 202);
        case 'busy':
          return errorResponse('queue_full', DEFAULT_STATUS.queue_full, requestId);
        default:
          return errorResponse('not_found', DEFAULT_STATUS.not_found, requestId);
      }
    },
    [SOCKET_PRUNE_KID_PATH]: async (req) => {
      const body = strictBody(await readJsonBody(req, ADMIN_MAX_BODY_BYTES), 'kid');
      const kid = body.kid;
      if (typeof kid !== 'string' || !KID.test(kid)) throw invalidField('kid', 'Expected a key id.');
      const outcome = await deps.pruneKid(kid);
      if (outcome.status === 'active_kid') {
        throw invalidField('kid', 'This key still signs: remove it from oauthSigningKeys and restart first.');
      }
      return json({ kid: outcome.kid, sessions: outcome.sessions }, 200);
    },
  };

  return async (req) => {
    const requestId = newRequestId(deps.random);
    const path = new URL(req.url).pathname;
    const method = SOCKET_ROUTE_METHODS[path];
    const handler = handlers[path];
    let response: Response;
    try {
      if (method === undefined || handler === undefined) {
        await discardBody(req);
        response = errorResponse('not_found', DEFAULT_STATUS.not_found, requestId);
      } else if (req.method.toUpperCase() !== method) {
        await discardBody(req);
        response = errorResponse('method_not_allowed', DEFAULT_STATUS.method_not_allowed, requestId, undefined, {
          headers: { allow: method },
        });
      } else {
        response = await handler(req, requestId);
      }
    } catch (error) {
      response = toErrorResponse(error, requestId);
    }
    response.headers.set('x-request-id', requestId);
    return response;
  };
}
