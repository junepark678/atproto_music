// /api/v1 import routes and the imports feature (ADR 0005 §11.4, contract
// v1.2; N3-09).
//
//   POST /api/v1/imports                 {source: lastfm|listenbrainz, username} → 202 ImportJob
//   POST /api/v1/imports/upload?source=lastfm_json|listenbrainz_zip (raw body) → 202 ImportJob
//   GET  /api/v1/imports                 → {items: ImportJob[]}, newest first
//   GET  /api/v1/imports/{id}            → ImportJob (another DID's id is 404)
//   POST /api/v1/imports/{id}/cancel     → ImportJob (no new operations; queued ones finish)
//   POST /api/v1/imports/{id}/resume     → ImportJob (a paused job continues; other states unchanged)
//
// Every route needs the session cookie (bff/guard.ts); the POSTs also the
// Origin + X-CSRF-Token pair. Answers are `Cache-Control: no-store`.
//
// - 503 `publication_disabled` while the lexicon prefix cannot be written
//   (no prefix, or a non-fixture prefix without ownership evidence: the
//   `publication` capability). A fixture prefix, which only test entries can
//   enable (config.ts `allowFixturePrefix`), counts as writable, as the
//   outbox writes it.
// - 503 `lastfm_not_configured` for a Last.fm API import without the owner's
//   Last.fm pair in the secrets.
// - 409 `import_active` while the DID has a job in waiting_index, fetching,
//   writing or paused.
// - Uploads: 413 past 64 MiB; 507 `insufficient_storage` when the upload
//   directory would pass ATMUSIC_UPLOAD_MAX_BYTES or the filesystem would fall
//   below ATMUSIC_MIN_FREE_BYTES, with nothing written (imports/uploads.ts);
//   429 `rate_limited` past 3 uploads per hour per DID.
//
// `importsFeature(options)` is the composition unit: these routes, the
// `import` extension timer (imports/jobs.ts) and the `imports` service.

import { dirname } from 'node:path';
import type { ImportJob } from '@atmusic/core/api-types';
import { ApiError } from '@atmusic/core/errors';
import { requireSession, type SessionGuardCtx, withSessionCookie } from '../bff/guard';
import type { WebSessions } from '../bff/sessions';
import { createBox } from '../crypto/box';
import {
  activeJob,
  cancelJob,
  createJob,
  IMPORT_FETCH_CAPS,
  ImportActiveError,
  type ImportRuntime,
  importExtension,
  intervalPacer,
  jobDto,
  listJobs,
  loadJob,
  type Pacer,
  resumeJob,
} from '../imports/jobs';
import { fsUploadStore, receiveUpload, type UploadStore } from '../imports/uploads';
import type { Feature, FeatureContext } from '../node/compose';
import { diskLowProbe, freeBytes as statfsFreeBytes } from '../node/disk';
import { type BoundPolicyFetch, bindPolicyFetch, createPolicyFetch } from '../node/policy-fetch';
import { newOperationId } from '../outbox/operations';
import { errorResponse, toErrorResponse } from './error';
import { json } from './json';
import { BucketSet } from './limits';
import { readJsonBody, singleParam } from './params';
import type { RequestCtx, RouteDef } from './types';
import { need } from './types';

/** What the imports feature offers other features (ADR §3.1). */
export interface ImportService {
  readonly runtime: ImportRuntime;
  /** Makes the `import` timer due now. */
  kick(): void;
}

declare module '../app/services' {
  interface AppServices {
    imports?: ImportService;
  }
}

/** 3 uploads per hour per DID (ADR §13). */
export const UPLOAD_RATE = Object.freeze({ capacity: 3, windowMs: 3_600_000 });
export const IMPORT_INPUT_MAX_BYTES = 64 * 1024;

const V12_MESSAGES = {
  import_active: 'An import job is already active.',
  lastfm_not_configured: 'Last.fm is not configured on this server.',
  insufficient_storage: 'The upload would exceed the storage limits.',
  publication_disabled: 'Publication is disabled on this server.',
} as const;

type V12Code = keyof typeof V12_MESSAGES;

const V12_STATUS: Readonly<Record<V12Code, number>> = {
  import_active: 409,
  lastfm_not_configured: 503,
  insufficient_storage: 507,
  publication_disabled: 503,
};

/** The envelope for the v1.2 codes the frozen v1.1 ErrorCode union lacks. */
export function v12Error(code: V12Code, requestId: string): Response {
  return new Response(JSON.stringify({ error: { code, message: V12_MESSAGES[code], requestId } }), {
    status: V12_STATUS[code],
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export interface ImportsFeatureOptions {
  /** The cookie sessions (bff/sessions.ts). */
  sessions: Pick<WebSessions, 'lookupCookieHeader' | 'renew'>;
  /** The Last.fm pacer is shared with forwarding in production (N3-08); default one per feature. */
  pacers?: { lastfm?: Pacer; listenbrainz?: Pacer };
  /** Default: statfs of the database's directory against ATMUSIC_MIN_FREE_BYTES. */
  diskLow?: () => boolean;
  /** Free bytes for the upload check; default statfs (node/disk.ts). */
  freeBytes?: (path: string) => bigint;
  uploads?: UploadStore;
  /** Default: policyFetch over the core's transport with IMPORT_FETCH_CAPS. */
  fetch?: BoundPolicyFetch;
}

interface Wired {
  runtime: ImportRuntime;
  guard: Omit<SessionGuardCtx, 'requestId'>;
  writable: boolean;
  uploadMaxBytes: number;
  minFreeBytes: number;
  freeBytes: (path: string) => bigint;
  uploadLimits: BucketSet;
  kick(): void;
}

const SOURCES = { lastfm: 'lastfm_api', listenbrainz: 'listenbrainz_api' } as const;
const UPLOAD_SOURCES = new Set(['lastfm_json', 'listenbrainz_zip']);
/** True when `text` holds a C0 control character or DEL. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function validation(field: string): ApiError {
  return new ApiError('validation_failed', 'invalid field', { [field]: 'invalid' });
}

/** The ImportInput body (additionalProperties false). */
function parseInput(body: unknown): { source: 'lastfm' | 'listenbrainz'; username: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw validation('body');
  const o = body as Record<string, unknown>;
  for (const key of Object.keys(o)) if (key !== 'source' && key !== 'username') throw validation(key);
  if (o.source !== 'lastfm' && o.source !== 'listenbrainz') throw validation('source');
  const username = o.username;
  if (typeof username !== 'string') throw validation('username');
  const scalars = [...username].length;
  if (scalars < 1 || scalars > 64 || username.trim() === '' || hasControl(username) || !username.isWellFormed()) {
    throw validation('username');
  }
  return { source: o.source, username };
}

function cancelBody(req: Request): void {
  if (req.body !== null) void req.body.cancel().catch(() => undefined);
}

function declaredLength(req: Request): number | null {
  const raw = req.headers.get('content-length');
  return raw !== null && /^[0-9]{1,16}$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

/** The imports feature: routes, the `import` timer and the `imports` service. */
export function importsFeature(options: ImportsFeatureOptions): Feature {
  let wired: Wired | null = null;
  const get = (): Wired => {
    if (wired === null) throw new TypeError('the imports feature was not composed');
    return wired;
  };

  const services = (context: FeatureContext) => {
    const { config, secrets, deps, core } = context;
    const box = createBox(secrets.encryptionKeys, deps.random);
    const fetch = options.fetch ?? bindPolicyFetch(createPolicyFetch({ transport: deps.transport }), IMPORT_FETCH_CAPS);
    const runtime: ImportRuntime = {
      m: deps,
      uploadDir: config.uploadDir,
      lastfm:
        secrets.lastfm === null
          ? null
          : { apiRoot: config.lastfmApiRoot, apiKey: secrets.lastfm.apiKey, sharedSecret: secrets.lastfm.sharedSecret },
      listenbrainzApiRoot: config.listenbrainzApiRoot,
      fetch,
      pacers: {
        lastfm: options.pacers?.lastfm ?? intervalPacer(),
        listenbrainz: options.pacers?.listenbrainz ?? intervalPacer(),
      },
      diskLow: options.diskLow ?? diskLowProbe(dirname(config.dbPath), config.minFreeBytes),
      uploads: options.uploads ?? fsUploadStore,
      box,
    };
    const kick = () => {
      core.extensionTimers.kick('import');
    };
    const app = config.app;
    wired = {
      runtime,
      guard: { sessions: options.sessions, publicOrigin: config.publicOrigin, csrfKey: box.csrfKey() },
      writable: app.prefix !== null && (app.publication || app.fixturePrefix),
      uploadMaxBytes: config.uploadMaxBytes,
      minFreeBytes: config.minFreeBytes,
      freeBytes: options.freeBytes ?? ((path: string) => statfsFreeBytes(path)),
      uploadLimits: new BucketSet(UPLOAD_RATE, deps.clock),
      kick,
    };
    return { imports: { runtime, kick } satisfies ImportService };
  };

  const ok = (body: ImportJob | { items: ImportJob[] }, status: number, session: { renewCookie: string | null }) =>
    withSessionCookie(json(body, status), session);

  const handle =
    (fn: (req: Request, ctx: RequestCtx, params: Record<string, string>, w: Wired) => Promise<Response>) =>
    async (req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> => {
      try {
        return await fn(req, ctx, params, get());
      } catch (error) {
        if (error instanceof ApiError) return toErrorResponse(error, ctx.requestId);
        throw error;
      }
    };

  const routes: RouteDef[] = [
    {
      method: 'POST',
      pattern: '/api/v1/imports',
      handler: handle(async (req, ctx, _params, w) => {
        const guard = requireSession(req, { ...w.guard, requestId: ctx.requestId });
        if (!guard.ok) {
          cancelBody(req);
          return guard.response;
        }
        if (!w.writable) {
          cancelBody(req);
          return v12Error('publication_disabled', ctx.requestId);
        }
        const input = parseInput(await readJsonBody(req, IMPORT_INPUT_MAX_BYTES));
        if (input.source === 'lastfm' && w.runtime.lastfm === null) {
          return v12Error('lastfm_not_configured', ctx.requestId);
        }
        const deps = need(ctx, 'deps');
        const now = deps.clock.nowMs();
        try {
          const job = createJob(deps.db, {
            id: newOperationId(deps.random),
            did: guard.session.did,
            source: SOURCES[input.source],
            remoteUser: input.username,
            now,
          });
          w.kick();
          return ok(jobDto(deps.db, job, now), 202, guard.session);
        } catch (error) {
          if (error instanceof ImportActiveError) return v12Error('import_active', ctx.requestId);
          throw error;
        }
      }),
    },
    {
      method: 'POST',
      pattern: '/api/v1/imports/upload',
      handler: handle(async (req, ctx, _params, w) => {
        const guard = requireSession(req, { ...w.guard, requestId: ctx.requestId });
        if (!guard.ok) {
          cancelBody(req);
          return guard.response;
        }
        if (!w.writable) {
          cancelBody(req);
          return v12Error('publication_disabled', ctx.requestId);
        }
        const source = singleParam(new URL(req.url).searchParams, 'source');
        if (source === undefined || !UPLOAD_SOURCES.has(source)) {
          cancelBody(req);
          throw validation('source');
        }
        const deps = need(ctx, 'deps');
        const did = guard.session.did;
        if (activeJob(deps.db, did) !== null) {
          cancelBody(req);
          return v12Error('import_active', ctx.requestId);
        }
        const rate = w.uploadLimits.take(did);
        if (!rate.allowed) {
          cancelBody(req);
          return errorResponse('rate_limited', 429, ctx.requestId, undefined, {
            headers: { 'retry-after': String(rate.retryAfterSeconds) },
          });
        }
        const jobId = newOperationId(deps.random);
        const received = await receiveUpload(req.body, {
          dir: w.runtime.uploadDir,
          jobId,
          dirMaxBytes: w.uploadMaxBytes,
          minFreeBytes: w.minFreeBytes,
          freeBytes: w.freeBytes,
          declaredLength: declaredLength(req),
        });
        if (!received.ok) {
          return received.code === 'payload_too_large'
            ? errorResponse('payload_too_large', 413, ctx.requestId)
            : v12Error('insufficient_storage', ctx.requestId);
        }
        const now = deps.clock.nowMs();
        try {
          const job = createJob(deps.db, {
            id: jobId,
            did,
            source: source as 'lastfm_json' | 'listenbrainz_zip',
            remoteUser: null,
            uploadPath: received.path,
            uploadBytes: received.bytes,
            now,
          });
          w.kick();
          return ok(jobDto(deps.db, job, now), 202, guard.session);
        } catch (error) {
          await w.runtime.uploads.remove(received.path);
          if (error instanceof ImportActiveError) return v12Error('import_active', ctx.requestId);
          throw error;
        }
      }),
    },
    {
      method: 'GET',
      pattern: '/api/v1/imports',
      handler: handle(async (req, ctx, _params, w) => {
        const guard = requireSession(req, { ...w.guard, requestId: ctx.requestId });
        if (!guard.ok) return guard.response;
        const deps = need(ctx, 'deps');
        const now = deps.clock.nowMs();
        const items = listJobs(deps.db, guard.session.did).map((job) => jobDto(deps.db, job, now));
        return ok({ items }, 200, guard.session);
      }),
    },
    {
      method: 'GET',
      pattern: '/api/v1/imports/{id}',
      handler: handle(async (req, ctx, params, w) => {
        const guard = requireSession(req, { ...w.guard, requestId: ctx.requestId });
        if (!guard.ok) return guard.response;
        const deps = need(ctx, 'deps');
        const job = loadJob(deps.db, params.id ?? '');
        if (job === null || job.did !== guard.session.did) return errorResponse('not_found', 404, ctx.requestId);
        return ok(jobDto(deps.db, job, deps.clock.nowMs()), 200, guard.session);
      }),
    },
    {
      method: 'POST',
      pattern: '/api/v1/imports/{id}/cancel',
      handler: handle(async (req, ctx, params, w) => {
        const guard = requireSession(req, { ...w.guard, requestId: ctx.requestId });
        cancelBody(req);
        if (!guard.ok) return guard.response;
        const deps = need(ctx, 'deps');
        const now = deps.clock.nowMs();
        const job = await cancelJob(w.runtime, guard.session.did, params.id ?? '', now);
        if (job === null) return errorResponse('not_found', 404, ctx.requestId);
        w.kick();
        return ok(jobDto(deps.db, job, now), 200, guard.session);
      }),
    },
    {
      method: 'POST',
      pattern: '/api/v1/imports/{id}/resume',
      handler: handle(async (req, ctx, params, w) => {
        const guard = requireSession(req, { ...w.guard, requestId: ctx.requestId });
        cancelBody(req);
        if (!guard.ok) return guard.response;
        const deps = need(ctx, 'deps');
        const now = deps.clock.nowMs();
        const job = resumeJob(deps.db, guard.session.did, params.id ?? '', now);
        if (job === null) return errorResponse('not_found', 404, ctx.requestId);
        w.kick();
        return ok(jobDto(deps.db, job, now), 200, guard.session);
      }),
    },
  ];

  return {
    name: 'imports',
    routes,
    extensions: [importExtension(() => wired?.runtime ?? null)],
    services,
  };
}
