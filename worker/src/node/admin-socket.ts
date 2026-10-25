// The admin interface on a unix socket (ADR 0005 §3.11, §14.4; N3-07).
//
// `/internal/admin/*` is never served on the TCP listener (a tunnel cannot
// tell admin traffic from public traffic: every peer is loopback). The admin
// routes (http/admin.ts `socketAdminHandler`) are served only here, on
// ATMUSIC_ADMIN_SOCKET (default `$XDG_RUNTIME_DIR/atmusic/admin.sock`), and
// filesystem permissions are the authentication:
//
// - the socket's directory is created 0700 when missing; an existing one must
//   belong to this user and have no group or other permission bits, or the
//   bind is refused (AdminSocketError, run() exits 78 naming
//   ATMUSIC_ADMIN_SOCKET), so the socket is never reachable by another user
//   even before its own mode is set;
// - the socket itself is chmod 0600 right after it is bound;
// - a stale socket file left by a killed instance is unlinked first: the
//   database lock run() already holds proves no other instance owns it
//   (ADR §3.10 step 3). Any other kind of file at the path is refused.
//
// Requests are bridged to WHATWG Request/Response like the TCP bridge, with a
// body cap of ADMIN_MAX_BODY_BYTES (413 above it). Until run() installs the
// handler (after composition) every request answers 503 `not_ready`.
//
// `hostStatus(deps)` is the host half of `GET /admin/status` (ADR §14.4):
// backup age and last run (node/backup.ts), queue depths by state (outbox
// operations, forward rows, import jobs), link failures, OAuth sessions per
// client_kid and status, upload-directory bytes, free space on the state
// filesystem and the readiness warnings. `pruneKidSessions(deps)` is the
// `POST /admin/oauth/prune-kid` default: it deletes, journaling each, the
// OAuth sessions bound to a kid that no longer signs (§5.4 step 5).

import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import * as http from 'node:http';
import { dirname, join } from 'node:path';
import type { Clock, Random } from '@atmusic/core/deps';
import { errorName } from '../app/index-core';
import type { Revocations } from '../app/revocations';
import type { Logger } from '../do/contracts';
import type { Db } from '../do/db';
import { ADMIN_MAX_BODY_BYTES, type PruneKidOutcome } from '../http/admin';
import { errorResponse } from '../http/error';
import { newRequestId } from '../http/request-id';
import type { BackupStatus } from './backup';
import { freeBytes, nodeStatfs, type StatfsFn } from './disk';

export const ADMIN_SOCKET_MODE = 0o600;
export const ADMIN_SOCKET_DIR_MODE = 0o700;
/** The origin of the Request URLs the socket builds (never sent anywhere). */
export const ADMIN_SOCKET_ORIGIN = 'http://admin.socket';

export class AdminSocketError extends Error {
  override readonly name = 'AdminSocketError';
  readonly variable = 'ATMUSIC_ADMIN_SOCKET';
}

export type AdminHandler = (request: Request) => Promise<Response>;

export interface AdminSocket {
  readonly path: string;
  /** Installs the request handler (until then: 503 not_ready). */
  setHandler(handler: AdminHandler): void;
  /** Stops listening, closes every connection and removes the socket file. */
  close(): Promise<void>;
}

export interface AdminSocketOptions {
  path: string;
  log: Logger;
  random: Random;
  /** Default: process.getuid(). */
  uid?: number;
}

function prepareDirectory(dir: string, uid: number | null): void {
  let created = false;
  try {
    lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new AdminSocketError(`its directory cannot be read (${(error as NodeJS.ErrnoException).code})`);
    }
    try {
      mkdirSync(dir, { recursive: true, mode: ADMIN_SOCKET_DIR_MODE });
      created = true;
    } catch (mkdirError) {
      throw new AdminSocketError(
        `its directory cannot be created (${(mkdirError as NodeJS.ErrnoException).code ?? 'error'})`,
      );
    }
  }
  if (created) chmodSync(dir, ADMIN_SOCKET_DIR_MODE);
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new AdminSocketError('its parent is not a directory');
  if (uid !== null && st.uid !== uid) throw new AdminSocketError('its directory belongs to another user');
  if ((st.mode & 0o077) !== 0) {
    throw new AdminSocketError(`its directory has mode 0${(st.mode & 0o777).toString(8)}; it must be 0700`);
  }
}

function removeStale(path: string, log: Logger): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new AdminSocketError(`cannot be inspected (${(error as NodeJS.ErrnoException).code})`);
  }
  if (!st.isSocket()) throw new AdminSocketError('names an existing file that is not a socket');
  unlinkSync(path);
  log.log('info', 'admin.stale_socket_removed', { path });
}

async function readCapped(req: http.IncomingMessage, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > cap) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeResponse(res: http.ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  const body = response.body === null ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
  res.setHeader('content-length', String(body.byteLength));
  res.end(body);
}

/** Binds the admin socket (module comment); throws AdminSocketError for a refused path. */
export async function bindAdminSocket(options: AdminSocketOptions): Promise<AdminSocket> {
  const { path, log, random } = options;
  const uid = options.uid ?? process.getuid?.() ?? null;
  prepareDirectory(dirname(path), uid);
  removeStale(path, log);

  let handler: AdminHandler | null = null;
  const server = http.createServer();
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    void (async () => {
      const requestId = newRequestId(random);
      try {
        const method = (req.method ?? 'GET').toUpperCase();
        const body = method === 'GET' || method === 'HEAD' ? null : await readCapped(req, ADMIN_MAX_BODY_BYTES);
        if (method !== 'GET' && method !== 'HEAD' && body === null) {
          await writeResponse(res, errorResponse('payload_too_large', 413, requestId));
          return;
        }
        if (handler === null) {
          await writeResponse(res, errorResponse('not_ready', 503, requestId));
          return;
        }
        const headers = new Headers();
        for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
          headers.append(req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string);
        }
        const target = (req.url ?? '/').startsWith('/') ? (req.url ?? '/') : '/';
        const request = new Request(`${ADMIN_SOCKET_ORIGIN}${target}`, {
          method,
          headers,
          ...(body === null || body.byteLength === 0 ? {} : { body: new Uint8Array(body) }),
        });
        await writeResponse(res, await handler(request));
      } catch (error) {
        log.log('error', 'admin.request_failed', { requestId, error: errorName(error) });
        if (!res.headersSent) await writeResponse(res, errorResponse('internal_error', 500, requestId));
        else res.destroy();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(new AdminSocketError(`cannot be bound (${error.code ?? 'error'})`));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
  chmodSync(path, ADMIN_SOCKET_MODE);
  log.log('info', 'admin.socket_listening', { path });

  let closed = false;
  return {
    path,
    setHandler(next) {
      handler = next;
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      try {
        // Only our own socket: a later instance may already have replaced it.
        if (lstatSync(path).isSocket()) unlinkSync(path);
      } catch {
        // already gone
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The host half of GET /admin/status

function tableExists(db: Db, name: string): boolean {
  return db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name) !== null;
}

function countsBy(db: Db, sql: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of db.all<{ k: string; n: number }>(sql)) out[row.k] = row.n;
  return out;
}

/** Total bytes of the regular files under `dir` (missing: 0). */
export function directoryBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(current, name);
      try {
        const st = lstatSync(path);
        if (st.isDirectory()) stack.push(path);
        else if (st.isFile()) total += st.size;
      } catch {
        // vanished
      }
    }
  }
  return total;
}

export interface HostStatusDeps {
  db: Db;
  clock: Clock;
  backups: { status(): BackupStatus };
  uploadDir: string;
  /** The state filesystem: the database's directory. */
  stateDir: string;
  minFreeBytes: number;
  statfs?: StatfsFn;
  /** The readiness warnings (compose's ready()). */
  warnings(): Promise<readonly string[]>;
}

export async function hostStatus(deps: HostStatusDeps): Promise<Record<string, unknown>> {
  const { db } = deps;
  const queues: Record<string, Record<string, number>> = {};
  for (const [name, table] of [
    ['outbox', 'operations'],
    ['forward', 'forward_outbox'],
    ['imports', 'import_jobs'],
  ] as const) {
    queues[name] = tableExists(db, table)
      ? countsBy(db, `SELECT state AS k, count(*) AS n FROM ${table} GROUP BY state ORDER BY state`)
      : {};
  }
  const links = tableExists(db, 'linked_accounts')
    ? countsBy(db, 'SELECT status AS k, count(*) AS n FROM linked_accounts GROUP BY status ORDER BY status')
    : {};
  const oauthSessions: Array<{ clientKid: string; status: string; count: number }> = tableExists(db, 'oauth_sessions')
    ? db
        .all<{ client_kid: string; status: string; n: number }>(
          'SELECT client_kid, status, count(*) AS n FROM oauth_sessions GROUP BY client_kid, status ORDER BY client_kid, status',
        )
        .map((r) => ({ clientKid: r.client_kid, status: r.status, count: r.n }))
    : [];
  let free: number | null = null;
  try {
    free = Number(freeBytes(deps.stateDir, deps.statfs ?? nodeStatfs));
  } catch {
    free = null;
  }
  const backup = deps.backups.status();
  return {
    backup: { ...backup, ageMs: backup.lastSuccess?.ageMs ?? null },
    queues,
    links,
    oauthSessions,
    uploads: { dir: deps.uploadDir, bytes: directoryBytes(deps.uploadDir) },
    disk: {
      path: deps.stateDir,
      freeBytes: free,
      minFreeBytes: deps.minFreeBytes,
      low: free === null || free < deps.minFreeBytes,
    },
    warnings: [...(await deps.warnings())],
  };
}

// ---------------------------------------------------------------------------
// POST /admin/oauth/prune-kid

export interface PruneKidDeps {
  db: Db;
  clock: Clock;
  /** The kids of secrets.oauthSigningKeys: a kid still signing is never pruned. */
  signingKids: readonly string[];
  revocations: Pick<Revocations, 'record'>;
  log: Logger;
}

/**
 * Deletes every OAuth session bound to `kid` and marks its account
 * `reauth_required`, journaling each DID before the transaction commits
 * (app/revocations.ts). Refused (`active_kid`) for a signing kid.
 */
export function pruneKidSessions(deps: PruneKidDeps, kid: string): PruneKidOutcome {
  if (deps.signingKids.includes(kid)) return { status: 'active_kid' };
  const { db } = deps;
  if (!tableExists(db, 'oauth_sessions')) return { status: 'pruned', kid, sessions: 0 };
  const now = deps.clock.nowMs();
  const sessions = db.tx(() => {
    const dids = db.all<{ did: string }>('SELECT did FROM oauth_sessions WHERE client_kid = ? ORDER BY did', kid);
    for (const { did } of dids) {
      deps.revocations.record({ kind: 'oauth_session', did });
      db.run('DELETE FROM oauth_sessions WHERE did = ? AND client_kid = ?', did, kid);
      db.run(
        "UPDATE accounts SET oauth_status = 'reauth_required', updated_at_ms = ? WHERE did = ? AND oauth_status = 'active'",
        now,
        did,
      );
    }
    return dids.length;
  });
  deps.log.log('info', 'admin.oauth_kid_pruned', { kid, sessions });
  return { status: 'pruned', kid, sessions };
}
