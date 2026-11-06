// The admin CLI of the Node host (ADR 0005 §3.11, §14.3, §14.4; N4-02).
//
// Usage:
//   node scripts/admin/atmusic-admin.ts [--socket PATH] status
//   node scripts/admin/atmusic-admin.ts [--socket PATH] backup
//   node scripts/admin/atmusic-admin.ts [--socket PATH] resnapshot <did>
//   node scripts/admin/atmusic-admin.ts [--socket PATH] prune-kid <kid>
//   (npx tsx scripts/admin/atmusic-admin.ts … works too)
//
// It talks only to the admin unix socket the server binds (worker/src/node/
// admin-socket.ts): `--socket PATH`, else ATMUSIC_ADMIN_SOCKET, else
// `$XDG_RUNTIME_DIR/atmusic/admin.sock` (`/run/user/<uid>/atmusic/admin.sock`
// without XDG_RUNTIME_DIR). The admin routes are never on the TCP listener,
// and filesystem permissions (a 0700 directory, a 0600 socket) are the
// authentication, so the CLI sends no token and never opens a TCP connection.
//
//   status       GET  /admin/status                 backup age, Jetstream lag, queue depths, ...
//   backup       POST /admin/backup                 an online backup now (manual)
//   resnapshot   POST /admin/resnapshot {did}       re-walk one DID from its signed head
//   prune-kid    POST /admin/oauth/prune-kid {kid}  drop sessions bound to a retired OAuth key
//
// The server's JSON answer is printed to stdout (indented), whatever its
// status. Exit status: 0 for a 2xx answer, 1 for any other answer or when the
// socket cannot be reached, 2 for a usage error (nothing is sent).
//
// The file runs under Node's own type stripping: node built-ins only, no
// imports from the workspace.

import * as http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ADMIN_SOCKET_HOST = 'admin.socket';
/** A backup of a large index can take minutes; the other commands answer at once. */
export const BACKUP_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface AdminRequest {
  method: 'GET' | 'POST';
  path: string;
  body: Record<string, string> | null;
  timeoutMs: number;
}

export interface AdminAnswer {
  status: number;
  body: string;
}

export interface AdminCliDeps {
  env?: Readonly<Record<string, string | undefined>>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Default: an HTTP request over the unix socket at `socketPath`. */
  send?: (socketPath: string, request: AdminRequest) => Promise<AdminAnswer>;
  /** Default: process.getuid(). */
  uid?: number;
}

const USAGE = `usage: atmusic-admin [--socket PATH] <command>
commands:
  status              GET  /admin/status
  backup              POST /admin/backup
  resnapshot <did>    POST /admin/resnapshot {"did": <did>}
  prune-kid <kid>     POST /admin/oauth/prune-kid {"kid": <kid>}
The socket defaults to ATMUSIC_ADMIN_SOCKET, else $XDG_RUNTIME_DIR/atmusic/admin.sock.
`;

const DID = /^did:(?:plc:[a-z2-7]{24}|web:[A-Za-z0-9.:%-]+)$/;
const KID = /^[A-Za-z0-9._~-]{1,128}$/;

/** The default socket path (ADR §3.8 ATMUSIC_ADMIN_SOCKET). */
export function defaultSocketPath(env: Readonly<Record<string, string | undefined>>, uid: number | null): string {
  const configured = env.ATMUSIC_ADMIN_SOCKET ?? '';
  if (configured !== '') return configured;
  const runtime = (env.XDG_RUNTIME_DIR ?? '').split(':')[0] ?? '';
  const base = runtime !== '' ? runtime : `/run/user/${uid ?? 0}`;
  return join(base, 'atmusic', 'admin.sock');
}

type Parsed = { socket: string | null; request: AdminRequest } | { usage: string };

export function parseArgs(args: readonly string[]): Parsed {
  let socket: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--socket') {
      const value = args[i + 1];
      if (value === undefined || value === '') return { usage: '--socket needs a path' };
      socket = value;
      i++;
    } else if (arg.startsWith('--socket=')) {
      socket = arg.slice('--socket='.length);
      if (socket === '') return { usage: '--socket needs a path' };
    } else if (arg === '--help' || arg === '-h') {
      return { usage: '' };
    } else if (arg.startsWith('-')) {
      return { usage: `unknown option ${arg}` };
    } else {
      rest.push(arg);
    }
  }
  const [command, ...operands] = rest;
  const expect = (n: number): string | null =>
    operands.length === n ? null : `${command} takes ${n === 0 ? 'no argument' : `exactly ${n} argument`}`;
  switch (command) {
    case 'status': {
      const bad = expect(0);
      if (bad !== null) return { usage: bad };
      return { socket, request: { method: 'GET', path: '/admin/status', body: null, timeoutMs: DEFAULT_TIMEOUT_MS } };
    }
    case 'backup': {
      const bad = expect(0);
      if (bad !== null) return { usage: bad };
      return { socket, request: { method: 'POST', path: '/admin/backup', body: null, timeoutMs: BACKUP_TIMEOUT_MS } };
    }
    case 'resnapshot': {
      const bad = expect(1);
      if (bad !== null) return { usage: bad };
      const did = operands[0] as string;
      if (!DID.test(did)) return { usage: 'resnapshot needs a did:plc or did:web DID' };
      return {
        socket,
        request: { method: 'POST', path: '/admin/resnapshot', body: { did }, timeoutMs: DEFAULT_TIMEOUT_MS },
      };
    }
    case 'prune-kid': {
      const bad = expect(1);
      if (bad !== null) return { usage: bad };
      const kid = operands[0] as string;
      if (!KID.test(kid)) return { usage: 'prune-kid needs a key id ([A-Za-z0-9._~-], at most 128)' };
      return {
        socket,
        request: { method: 'POST', path: '/admin/oauth/prune-kid', body: { kid }, timeoutMs: DEFAULT_TIMEOUT_MS },
      };
    }
    case undefined:
      return { usage: 'a command is required' };
    default:
      return { usage: `unknown command ${JSON.stringify(command)}` };
  }
}

/** One HTTP/1.1 request over the unix socket (no TCP: `socketPath` only). */
export function sendOverSocket(socketPath: string, request: AdminRequest): Promise<AdminAnswer> {
  return new Promise((resolve, reject) => {
    const payload = request.body === null ? null : Buffer.from(JSON.stringify(request.body));
    const headers: Record<string, string> = { host: ADMIN_SOCKET_HOST, accept: 'application/json' };
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.byteLength);
    } else if (request.method === 'POST') {
      headers['content-length'] = '0';
    }
    const req = http.request(
      { socketPath, path: request.path, method: request.method, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.setTimeout(request.timeoutMs, () => req.destroy(new Error(`no answer within ${request.timeoutMs} ms`)));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

/** The answer body for stdout: indented JSON, or the raw text when it is not JSON. */
function formatBody(body: string): string {
  try {
    return `${JSON.stringify(JSON.parse(body), null, 2)}\n`;
  } catch {
    return body.endsWith('\n') || body === '' ? body : `${body}\n`;
  }
}

export async function main(argv: readonly string[], deps: AdminCliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((text: string) => void process.stdout.write(text));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const send = deps.send ?? sendOverSocket;
  const parsed = parseArgs(argv);
  if ('usage' in parsed) {
    if (parsed.usage === '') {
      out(USAGE);
      return 0;
    }
    err(`atmusic-admin: ${parsed.usage}\n${USAGE}`);
    return 2;
  }
  const uid = deps.uid ?? process.getuid?.() ?? null;
  const socketPath = parsed.socket ?? defaultSocketPath(env, uid);
  let answer: AdminAnswer;
  try {
    answer = await send(socketPath, parsed.request);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const hint = code === 'ENOENT' || code === 'ECONNREFUSED' ? ' (is atmusic running?)' : '';
    err(`atmusic-admin: cannot reach the admin socket ${socketPath}: ${code ?? (error as Error).message}${hint}\n`);
    return 1;
  }
  out(formatBody(answer.body));
  if (answer.status >= 200 && answer.status < 300) return 0;
  err(`atmusic-admin: ${parsed.request.method} ${parsed.request.path} answered ${answer.status}\n`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
