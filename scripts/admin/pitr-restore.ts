// Point-in-time restore of the IndexDO (ADR 0004 §3.2, §8 "Admin", §9.2 A15;
// W6-04). Operator tool for POST /internal/admin/pitr (worker/src/http/admin.ts).
//
// Usage:
//   ADMIN_TOKEN=… npx tsx scripts/admin/pitr-restore.ts --at <ISO-8601 | epoch-ms>
//     [--env production|staging|free] [--origin https://host] [--dry-run | --yes]
//   npx tsx scripts/admin/pitr-restore.ts --help
//
// - ADMIN_TOKEN comes only from the environment (never a flag, so it stays out
//   of shell history and process listings). It must be the Worker's
//   ADMIN_TOKEN secret: the admin routes exist only while it is set, and are a
//   404 otherwise. The token is never printed.
// - The origin: an explicit --env always resolves to that env's PUBLIC_ORIGIN
//   in worker/wrangler.jsonc, and an ambient PUBLIC_ORIGIN or an --origin that
//   names a different origin is refused (status 2), so a stray variable can
//   never redirect a restore meant for staging to production. Without --env
//   the origin is --origin, else PUBLIC_ORIGIN, else production's
//   PUBLIC_ORIGIN. It must be an https origin, or an http loopback origin for
//   a local `wrangler dev`. The resolved env and origin are printed before
//   anything is sent.
// - --at must lie within the last 30 days (the DO PITR window) and not in the
//   future; the Worker re-checks this (422 `fields.atMs`).
// - The restore replaces the whole index with its state at that instant and
//   restarts the IndexDO, so it needs --yes; --dry-run prints the request and
//   sends nothing. Afterwards GET /internal/admin/status shows the restored
//   state; index changes made after --at are recovered from the network by
//   the normal hint, snapshot and gap-recovery paths (docs/backup.md).
//
// Exit status: 0 scheduled (or dry run), 1 the Worker refused or failed, or
// the request was sent and its outcome is unknown (for example a 202 whose
// body is not JSON: the restore may have been accepted, so check
// GET /internal/admin/status before retrying), 2 usage or configuration error.
// Nothing is sent for status 2: any error after the POST left is status 1.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_WRANGLER_CONFIG,
  isHttpsOrigin,
  isLoopbackOrigin,
  readJsonc,
  wranglerEnvSection,
} from '../gen-config.ts';

export const PITR_PATH = '/internal/admin/pitr';
/** The Durable Object point-in-time recovery window, as worker/src/do/index-do.ts PITR_WINDOW_MS. */
export const PITR_WINDOW_MS = 30 * 24 * 3_600_000;
/** Same floor as worker/src/http/admin.ts: a shorter token never enables the routes. */
export const MIN_ADMIN_TOKEN_CHARS = 32;
export const REQUEST_TIMEOUT_MS = 30_000;

export const USAGE = `Usage: ADMIN_TOKEN=<token> npx tsx scripts/admin/pitr-restore.ts --at <ISO-8601|epoch-ms>
         [--env production|staging|free] [--origin https://host] [--dry-run | --yes]
       npx tsx scripts/admin/pitr-restore.ts --help

Schedules a Durable Object point-in-time restore of the atmusic IndexDO through
POST /internal/admin/pitr. The IndexDO restarts into its state at --at.

  --at <time>     restore point: ISO-8601 with a timezone (2026-01-15T11:00:00Z)
                  or epoch milliseconds; within the last 30 days, not in the future
  --env <env>     wrangler env whose PUBLIC_ORIGIN is used (default production);
                  refused when PUBLIC_ORIGIN or --origin names another origin
  --origin <url>  explicit origin (without --env: overrides PUBLIC_ORIGIN)
  --dry-run       print the request without sending it
  --yes           send it (required: the restore replaces the whole index)
  --help          this text

Environment:
  ADMIN_TOKEN     required; the Worker's ADMIN_TOKEN secret (at least ${MIN_ADMIN_TOKEN_CHARS} characters).
                  The admin routes exist only while that secret is set.
  PUBLIC_ORIGIN   optional default origin when --env is not given
`;

export interface PitrDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  nowMs: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Reads the wrangler config (injected in tests). */
  readConfig?: (path: string) => unknown;
}

class UsageError extends Error {}

interface Args {
  help: boolean;
  at: string | null;
  env: 'production' | 'staging' | 'free';
  /** --env was given on the command line. */
  envExplicit: boolean;
  origin: string | null;
  config: string;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    help: false,
    at: null,
    env: 'production',
    envExplicit: false,
    origin: null,
    config: DEFAULT_WRANGLER_CONFIG,
    dryRun: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--yes':
        args.yes = true;
        break;
      case '--at':
      case '--env':
      case '--origin':
      case '--config':
        if (value === undefined) throw new UsageError(`${flag} needs a value`);
        if (flag === '--at') args.at = value;
        else if (flag === '--origin') args.origin = value;
        else if (flag === '--config') args.config = resolve(value);
        else if (value === 'production' || value === 'staging' || value === 'free') {
          if (args.envExplicit && args.env !== value) throw new UsageError('--env given twice with different values');
          args.env = value;
          args.envExplicit = true;
        } else throw new UsageError(`--env must be production, staging or free (got ${value})`);
        i++;
        break;
      default:
        throw new UsageError(`unknown argument ${flag}`);
    }
  }
  return args;
}

/** Epoch ms from `--at`: an integer, or ISO-8601 that names its timezone. */
export function parseAt(value: string): number {
  if (/^\d{1,16}$/.test(value)) return Number(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new UsageError('--at must be epoch milliseconds or ISO-8601 with a timezone (e.g. 2026-01-15T11:00:00Z)');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new UsageError(`--at ${value} is not a valid time`);
  return ms;
}

const trimOrigin = (value: string): string => value.replace(/\/+$/, '');

interface Target {
  /** The wrangler env the origin came from, or null for an --origin/PUBLIC_ORIGIN override. */
  env: Args['env'] | null;
  origin: string;
}

function configOrigin(args: Args, deps: PitrDeps): string {
  const config = (deps.readConfig ?? readJsonc)(args.config);
  return trimOrigin(wranglerEnvSection(config, args.env).vars.PUBLIC_ORIGIN ?? '');
}

/**
 * The restore target. An explicit --env is authoritative: its configured
 * origin is used, and a PUBLIC_ORIGIN or --origin naming another origin is a
 * usage error rather than silently winning.
 */
function targetFor(args: Args, env: NodeJS.ProcessEnv, deps: PitrDeps): Target {
  const ambient = trimOrigin(env.PUBLIC_ORIGIN ?? '');
  const flag = args.origin === null ? null : trimOrigin(args.origin);
  let target: Target;
  if (args.envExplicit) {
    const origin = configOrigin(args, deps);
    if (origin === '') throw new UsageError(`wrangler env ${args.env} has no PUBLIC_ORIGIN`);
    if (flag !== null && flag !== origin) {
      throw new UsageError(`--origin ${flag} disagrees with --env ${args.env} (PUBLIC_ORIGIN ${origin}); refusing`);
    }
    if (ambient !== '' && ambient !== origin) {
      throw new UsageError(
        `PUBLIC_ORIGIN ${ambient} in the environment disagrees with --env ${args.env} (PUBLIC_ORIGIN ${origin}); unset it or drop --env`,
      );
    }
    target = { env: args.env, origin };
  } else if (flag !== null) {
    target = { env: null, origin: flag };
  } else if (ambient !== '') {
    target = { env: null, origin: ambient };
  } else {
    target = { env: args.env, origin: configOrigin(args, deps) };
  }
  if (!isHttpsOrigin(target.origin) && !isLoopbackOrigin(target.origin)) {
    throw new UsageError(
      `origin ${target.origin || '(empty)'} must be an https origin (or http loopback for wrangler dev)`,
    );
  }
  return target;
}

async function errorSummary(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; requestId?: string } };
    const e = body.error;
    if (e !== undefined)
      return `${e.code ?? 'error'}: ${e.message ?? ''}${e.requestId ? ` (requestId ${e.requestId})` : ''}`;
  } catch {
    // not the JSON error envelope
  }
  return `HTTP ${res.status}`;
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, deps: PitrDeps): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    deps.err(`pitr-restore: ${(error as Error).message}`);
    deps.err(USAGE);
    return 2;
  }
  if (args.help) {
    deps.out(USAGE);
    return 0;
  }

  const token = env.ADMIN_TOKEN ?? '';
  /** The POST has left this process: from here on no outcome may be reported as "nothing sent". */
  let sent = false;
  try {
    if (token === '') {
      throw new UsageError(
        'ADMIN_TOKEN is required: export the Worker ADMIN_TOKEN secret value in the environment (never as a flag)',
      );
    }
    if (token.length < MIN_ADMIN_TOKEN_CHARS) {
      throw new UsageError(`ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_CHARS} characters, as on the Worker`);
    }
    if (args.at === null) throw new UsageError('--at is required');
    if (args.dryRun && args.yes) throw new UsageError('--dry-run and --yes are exclusive');
    const atMs = parseAt(args.at);
    // The target first: a conflicting env/origin is refused whatever --at is.
    const target = targetFor(args, env, deps);
    const now = deps.nowMs();
    if (!Number.isSafeInteger(atMs) || atMs > now || atMs < now - PITR_WINDOW_MS) {
      throw new UsageError(
        `--at ${new Date(atMs).toISOString()} is outside the restore window [${new Date(now - PITR_WINDOW_MS).toISOString()}, ${new Date(now).toISOString()}]`,
      );
    }
    const source =
      target.env !== null ? `env ${target.env}` : args.origin !== null ? 'env (--origin)' : 'env (PUBLIC_ORIGIN)';
    deps.out(`pitr-restore: target ${source} origin ${target.origin}`);
    const url = `${target.origin}${PITR_PATH}`;
    const body = JSON.stringify({ atMs });
    deps.out(`pitr-restore: POST ${url} ${body} (restore point ${new Date(atMs).toISOString()})`);
    if (args.dryRun) {
      deps.out('pitr-restore: dry run: nothing sent');
      return 0;
    }
    if (!args.yes) {
      throw new UsageError('refusing without --yes: the restore replaces the whole index and restarts the IndexDO');
    }

    let res: Response;
    sent = true;
    try {
      res = await deps.fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      deps.err(`pitr-restore: request failed: ${(error as Error).message}`);
      return 1;
    }
    if (res.status === 202) {
      let accepted: { bookmark?: string; atMs?: number; restart?: boolean };
      try {
        const parsed: unknown = await res.json();
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('the 202 body is not a JSON object');
        }
        accepted = parsed as typeof accepted;
      } catch (error) {
        deps.err(
          `pitr-restore: the Worker answered 202 but its body could not be read (${(error as Error).message}): the restore may have been accepted; check GET /internal/admin/status before retrying`,
        );
        return 1;
      }
      deps.out(`pitr-restore: scheduled: bookmark ${accepted.bookmark ?? '(none)'} atMs ${accepted.atMs ?? atMs}`);
      deps.out(
        'pitr-restore: the IndexDO restarts into the restored state; check GET /internal/admin/status and /api/v1/meta',
      );
      return 0;
    }
    const summary = await errorSummary(res);
    if (res.status === 404) {
      deps.err(`pitr-restore: 404 (${summary}): the admin routes are disabled (no ADMIN_TOKEN secret on this Worker)`);
    } else if (res.status === 401) {
      deps.err(`pitr-restore: 401 (${summary}): ADMIN_TOKEN does not match the Worker secret`);
    } else {
      deps.err(`pitr-restore: refused with ${res.status} (${summary})`);
    }
    return 1;
  } catch (error) {
    if (sent) {
      // Whatever failed, the request was already sent: never claim nothing was.
      deps.err(
        `pitr-restore: ${(error as Error).message}: the request was sent and the restore may have been accepted; check GET /internal/admin/status before retrying`,
      );
      return 1;
    }
    if (error instanceof UsageError) {
      deps.err(`pitr-restore: ${error.message}`);
      return 2;
    }
    deps.err(`pitr-restore: ${(error as Error).message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2), process.env, {
    fetch: (input, init) => fetch(input, init),
    nowMs: () => Date.now(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }).then((code) => {
    process.exitCode = code;
  });
}
