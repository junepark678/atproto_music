// Operator admin endpoints are available only through the protected Unix socket
// (ADR 0005 §3.11). The ordinary TCP dispatcher never exposes this surface.

import type { Did } from '@atmusic/core/api-types';
import type { Random } from '@atmusic/core/deps';
import { DEFAULT_STATUS } from '@atmusic/core/errors';
import { isSupportedDid } from '@atmusic/core/syntax';
import type { AdminStatus, BackupOutcome } from '../do/contracts';
import { errorResponse, toErrorResponse } from './error';
import { json } from './json';
import { invalidField, readJsonBody } from './params';
import { newRequestId } from './request-id';
import type { RouteDef } from './types';

export const ADMIN_MAX_BODY_BYTES = 1024;

export type ResnapshotOutcome =
  | { status: 'scheduled' | 'already' }
  | { status: 'unknown' }
  | { status: 'suppressed' }
  | { status: 'busy' };

/** The IndexCore method mounted on the Node admin socket. */
export interface AdminRpc {
  adminResnapshot(did: Did): Promise<ResnapshotOutcome>;
}

/** No TCP routes are registered; the Node host mounts socketAdminHandler separately. */
export const routes: RouteDef[] = [];

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
