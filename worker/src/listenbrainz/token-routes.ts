// ListenBrainz token routes and the shared token-first guard (ADR 0005 §8.2,
// §8.6, §8.7; N3-05):
//
//   GET  /1/validate-token       {code:200, message, valid, user_name?}
//   POST /1/delete-listen        {listened_at, recording_msid} → a scrobble.delete
//   POST /1/playing-now/delete   {client?} → clears the caller's now playing
//
// **Token first (`lbGuard`).** Every authenticated /1/ write runs this guard
// before it reads a single body byte (§8.3): the Authorization header is parsed
// (auth-header.ts), a well-formed token is looked up (`verifyLbToken`, SHA-256
// against `lb_tokens`), and the request is charged to the credential-first
// limiter (limiter.ts, N2-08): a live token's per-token bucket only, anything
// else the per-IP bucket. A refused charge is the 429 (verbatim body,
// X-RateLimit-*, Retry-After) before the 401 of a failed token check, as
// ListenBrainz's `@ratelimit` runs before the view. Every other answer carries
// the X-RateLimit-* set of the bucket that was charged.
//
// **One limiter per composition.** The buckets are in-memory state of the
// running app. `listenBrainzLimiterFor(ctx)` keys them on the composition's
// ModuleDeps object (one per IndexCore), driven by its injected clock, so every
// /1/ route of one app shares them and two test apps never do. A route factory
// may be given another limiter source (`LbRouteOptions.limiter`).
//
// **Under the /1/ dispatcher (N3-06 routes.ts, `registry`).** The dispatcher
// authenticates and charges every /1/ request before the handler runs and
// hands the outcome to the handler as its fourth argument (`LbDispatch`, the
// same shape as routes.ts `LbRequest`: `auth`, the token check, and `limit`,
// the allowed decision). When that argument is present a route of this module
// neither verifies the Authorization header again nor charges any limiter: it
// takes the token from `lb.auth` and the X-RateLimit-* set from `lb.limit`, so
// each request is verified once and charged once, to the bucket that enforces
// §8.7 and whose headers the client sees. The routes that need a token are
// marked `auth: 'required'`, so the dispatcher answers their 401 itself;
// should one still be reached without a live token, it answers the same 401.
// `lbGuard`'s own lookup and charge run only when a route is mounted without
// the dispatcher (no fourth argument). validate-token reuses `lb.auth` when
// its candidate is the header's token (a `token ` header is parsed the same
// way by both rules) and looks up only a `?token=` or `Bearer` candidate.
//
// **validate-token** reads the token as ListenBrainz does
// (`validateTokenCandidate`: a header starting with `token `, else `?token=`).
// Valid → 200 `{"code":200,"message":"Token valid.","valid":true,"user_name"}`;
// unknown → 200 `{"code":200,"message":"Token invalid.","valid":false}`; none →
// 400 `{"code":400,"error":"You need to provide an Authorization token."}`.
// `valid` is a JSON boolean (Music Assistant needs it).
//
// **delete-listen** (ListenBrainz `delete_listen`): the JSON body needs
// `listened_at` (Python `int()`) and `recording_msid` (`uuid.UUID()` syntax),
// with ListenBrainz's messages. The newest of the caller's own scrobbles at that
// second whose MSID matches gets a `scrobble.delete` operation (origin
// listenbrainz; enqueueScrobbleDelete). The MSID of each candidate is the
// stored `scrobbles.recording_msid`, else recomputed from its music keys (an
// MSID is a pure function of them, §8.4). With no indexed match, the caller's
// own not-yet-indexed `scrobble.create` at that second with that MSID is removed
// as library.removeScrobble does (never sent → cancelled; sent → a chained
// delete). No match at all answers 200 `{"status":"ok"}` and writes nothing, as
// ListenBrainz does for a listen it does not hold. Only the token owner's rows
// are ever looked at.
// delete-listen queues a PDS write, so it is behind the publication gate
// (§5.7, `lbPublicationOpen`): after the token guard and before any body byte
// is read, a closed gate answers 503 `{"code":503,"error":"Cannot submit
// listens to queue, please try again later."}` and writes nothing, as
// submit-listens does.
//
// **playing-now/delete** (§8.6), in ListenBrainz's order: no current entry →
// 200 `{"status":"ok","message":"Playing now already cleared"}`; an entry whose
// stored `submission_client` is set and differs from `client` → 404; otherwise
// (including an entry stored without a client) the entry is deleted → 200
// `{"status":"ok","message":"Playing now cleared successfully"}`.
//
// Neither the token nor the Authorization header is ever logged or echoed.

import { recordingMsid, recordingMsidOfKey } from '@atmusic/core/msid';
import { NS_PER_SECOND, parseRfc3339, toRecordDatetime, toStorage } from '@atmusic/core/timestamp';
import { IndexCore } from '../app/index-core';
import type { OperationRow } from '../app/rows';
import type { AppConfig } from '../config';
import { type VerifiedLbToken, verifyLbToken } from '../credentials/lb-tokens';
import type { ModuleDeps } from '../do/contracts';
import { clearNowPlaying } from '../do/read/now-playing';
import { need, type RequestCtx, type RouteDef } from '../http/types';
import { enqueueScrobbleDelete, removeScrobbleCreate } from '../outbox/delete-ops';
import { outboxCollections } from '../outbox/operations';
import {
  type AuthHeaderFailure,
  LB_AUTH_MESSAGES,
  parseAuthorization,
  unauthorized,
  validateTokenCandidate,
} from './auth-header';
import { LB_UNAVAILABLE_MESSAGE, lbError, lbJson, lbPreflight } from './errors';
import { type LimitDecision, ListenBrainzLimiter, refusal, type TokenResult } from './limiter';
import { isPythonUuid, pyInt } from './validate';

// ---------------------------------------------------------------------------
// The limiter of a composition

const LIMITERS = new WeakMap<ModuleDeps, ListenBrainzLimiter>();

/** The composition's /1/ limiter (module comment): one per ModuleDeps, on its clock. */
export function listenBrainzLimiterFor(ctx: RequestCtx): ListenBrainzLimiter {
  const deps = need(ctx, 'deps');
  let limiter = LIMITERS.get(deps);
  if (limiter === undefined) {
    limiter = new ListenBrainzLimiter(deps.clock);
    LIMITERS.set(deps, limiter);
  }
  return limiter;
}

export interface LbRouteOptions {
  /** Where the routes take their limiter from when mounted standalone; `listenBrainzLimiterFor` by default. */
  limiter?: (ctx: RequestCtx) => ListenBrainzLimiter;
}

// ---------------------------------------------------------------------------
// The dispatcher's outcome (module comment)

/** The dispatcher's token check (routes.ts `LbAuth`, structurally). */
export type LbDispatchAuth =
  | { status: 'absent'; failure: AuthHeaderFailure }
  | { status: 'invalid' }
  | { status: 'valid'; token: VerifiedLbToken };

/** What the /1/ dispatcher hands a registry route (routes.ts `LbRequest`, structurally). */
export interface LbDispatch {
  auth: LbDispatchAuth;
  /** The decision the dispatcher charged this request with. */
  limit: LimitDecision;
}

/** A route of this package: a RouteDef whose handler also takes the dispatcher's outcome (routes.ts `LbRouteDef`). */
export interface LbModuleRouteDef extends RouteDef {
  /** `required`: the dispatcher answers the 401 itself, before the handler. */
  auth?: 'required' | 'optional';
  handler(req: Request, ctx: RequestCtx, params: Record<string, string>, lb?: LbDispatch): Promise<Response>;
}

// ---------------------------------------------------------------------------
// The token-first guard

export type LbGuardResult =
  | { ok: true; token: VerifiedLbToken; rateHeaders: Record<string, string> }
  | { ok: false; response: Response };

/** Charges `token` to the limiter; the 429 answer when refused. */
function charge(
  limiter: ListenBrainzLimiter,
  ctx: RequestCtx,
  token: TokenResult,
): { ok: true; decision: LimitDecision } | { ok: false; response: Response } {
  const decision = limiter.limit({ clientIp: ctx.clientIp }, token);
  return decision.allowed ? { ok: true, decision } : { ok: false, response: refusal(decision) };
}

/** The guard's answer from the dispatcher's outcome: no lookup and no charge (module comment). */
function fromDispatch(lb: LbDispatch): LbGuardResult {
  if (!lb.limit.allowed) return { ok: false, response: refusal(lb.limit) };
  const rateHeaders = lb.limit.headers;
  if (lb.auth.status === 'valid') return { ok: true, token: lb.auth.token, rateHeaders };
  const failure = lb.auth.status === 'absent' ? lb.auth.failure : 'invalid_token';
  return { ok: false, response: unauthorized(failure, rateHeaders) };
}

/**
 * The Authorization header, the token lookup and the rate limit, in that order
 * and before any body byte is read (module comment). With the dispatcher's
 * outcome `lb`, that outcome is used instead and nothing is looked up or charged.
 */
export function lbGuard(req: Request, ctx: RequestCtx, options: LbRouteOptions = {}, lb?: LbDispatch): LbGuardResult {
  if (lb !== undefined) return fromDispatch(lb);
  const deps = need(ctx, 'deps');
  const limiter = (options.limiter ?? listenBrainzLimiterFor)(ctx);
  const header = parseAuthorization(req.headers.get('authorization'));
  const verified = header.ok ? verifyLbToken(deps, header.token) : null;
  const tokenResult: TokenResult =
    verified !== null
      ? { status: 'valid', tokenId: verified.id }
      : header.ok
        ? { status: 'invalid' }
        : { status: 'absent' };
  const charged = charge(limiter, ctx, tokenResult);
  if (!charged.ok) return charged;
  const rateHeaders = charged.decision.headers;
  if (!header.ok) return { ok: false, response: unauthorized(header.failure, rateHeaders) };
  if (verified === null) return { ok: false, response: unauthorized('invalid_token', rateHeaders) };
  return { ok: true, token: verified, rateHeaders };
}

/**
 * Whether /1/ writes may be queued for publication: exactly the namespace
 * gate's `publication` capability (ADR §5.7; an owned, non-fixture prefix with
 * NAMESPACE_OWNERSHIP_REF). Closed → 503 with LB_UNAVAILABLE_MESSAGE.
 */
export function lbPublicationOpen(config: Pick<AppConfig, 'prefix' | 'publication'>): boolean {
  return config.prefix !== null && config.publication;
}

/** Kicks the outbox timer of the composition (a no-op where the outbox extension is not registered). */
export function kickOutbox(ctx: RequestCtx): void {
  if (ctx.index instanceof IndexCore) ctx.index.extensionTimers.kick('outbox');
}

// ---------------------------------------------------------------------------
// Bodies

export const LB_JSON_INVALID = 'Invalid JSON document submitted.';

/** The JSON object body of a small /1/ request, or null when it is not one. `{}` for an empty body. */
async function objectBody(req: Request, emptyIsObject: boolean): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.trim() === '') return emptyIsObject ? {} : null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Python `str()` of a JSON value, as ListenBrainz's `"%s" % value` prints it in its messages. */
function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// GET /1/validate-token

export const LB_TOKEN_VALID = 'Token valid.';
export const LB_TOKEN_INVALID = 'Token invalid.';

/** The dispatcher's verdict on the validate-token candidate, when it is the header's `token ` token; else undefined. */
function dispatchedVerdict(header: string | null, lb: LbDispatch | undefined): VerifiedLbToken | null | undefined {
  if (lb === undefined || lb.auth.status === 'absent') return undefined;
  // A `token ` header: both rules take `split(' ')[1]`, so the dispatcher already looked this candidate up.
  if (!header?.toLowerCase().startsWith('token ')) return undefined;
  return lb.auth.status === 'valid' ? lb.auth.token : null;
}

async function validateToken(
  req: Request,
  ctx: RequestCtx,
  options: LbRouteOptions,
  lb?: LbDispatch,
): Promise<Response> {
  const deps = need(ctx, 'deps');
  const header = req.headers.get('authorization');
  const candidate = validateTokenCandidate(header, new URL(req.url).searchParams);
  const reused = candidate === null ? undefined : dispatchedVerdict(header, lb);
  const verified = candidate === null ? null : reused !== undefined ? reused : verifyLbToken(deps, candidate);
  let headers: Record<string, string>;
  if (lb !== undefined) {
    // Charged once, by the dispatcher (module comment).
    if (!lb.limit.allowed) return refusal(lb.limit);
    headers = lb.limit.headers;
  } else {
    const tokenResult: TokenResult =
      verified !== null
        ? { status: 'valid', tokenId: verified.id }
        : candidate === null
          ? { status: 'absent' }
          : { status: 'invalid' };
    const charged = charge((options.limiter ?? listenBrainzLimiterFor)(ctx), ctx, tokenResult);
    if (!charged.ok) return charged.response;
    headers = charged.decision.headers;
  }
  if (candidate === null) return lbError(400, LB_AUTH_MESSAGES.noToken, headers);
  if (verified === null) return lbJson({ code: 200, message: LB_TOKEN_INVALID, valid: false }, 200, headers);
  return lbJson({ code: 200, message: LB_TOKEN_VALID, valid: true, user_name: verified.username }, 200, headers);
}

// ---------------------------------------------------------------------------
// POST /1/delete-listen

export const LB_DELETE_MESSAGES = {
  timestampMissing: 'Listen timestamp missing.',
  timestampInvalid: (value: string) => `${value}: Listen timestamp invalid.`,
  msidMissing: 'Recording MSID missing.',
  msidInvalid: (value: string) => `${value}: Recording MSID format invalid.`,
} as const;

/** A `uuid.UUID()`-valid MSID in its canonical lowercase hyphenated form, or null for an exotic spelling. */
export function canonicalMsid(value: string): string | null {
  let hex = value.trim().toLowerCase().replaceAll('urn:', '').replaceAll('uuid:', '');
  hex = hex
    .replace(/^[{}]+/, '')
    .replace(/[{}]+$/, '')
    .replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type DeleteTarget = { kind: 'indexed'; uri: string } | { kind: 'pending'; operationId: string } | { kind: 'none' };

/** The newest own scrobble at second `seconds` with MSID `msid` (module comment). */
async function findDeleteTarget(m: ModuleDeps, did: string, seconds: bigint, msid: string): Promise<DeleteTarget> {
  const lowerNs = seconds * NS_PER_SECOND;
  const upperNs = lowerNs + NS_PER_SECOND;
  // listened_at is the fixed-width storage form, so string order is time order.
  const rows = m.db.all<{ uri: string; artist_key: string; track_key: string; recording_msid: string | null }>(
    `SELECT uri, artist_key, track_key, recording_msid FROM scrobbles
     WHERE did = ? AND listened_at >= ? AND listened_at < ?
     ORDER BY listened_at DESC, uri DESC`,
    did,
    toStorage(lowerNs),
    toStorage(upperNs),
  );
  for (const row of rows) {
    const candidate = row.recording_msid ?? (await recordingMsidOfKey([row.artist_key, row.track_key]));
    if (candidate === msid) return { kind: 'indexed', uri: row.uri };
  }

  const prefix = m.config.prefix;
  if (prefix === null) return { kind: 'none' };
  const collection = outboxCollections(prefix).scrobble;
  // Records carry the normalised UTC datetime (toRecordDatetime), so the
  // second is its first 19 characters; the exact bound is checked below.
  const second = toRecordDatetime(lowerNs).slice(0, 19);
  const ops = m.db.all<Pick<OperationRow, 'id' | 'record_json'>>(
    `SELECT id, record_json FROM operations
     WHERE did = ? AND kind = 'scrobble.create' AND collection = ? AND record_json IS NOT NULL
       AND state IN ('queued','running','blocked','succeeded')
       AND substr(json_extract(record_json, '$.listenedAt'), 1, 19) = ?
     ORDER BY created_at_ms DESC, id DESC`,
    did,
    collection,
    second,
  );
  let best: { ns: bigint; operationId: string } | null = null;
  for (const op of ops) {
    let record: { listenedAt?: unknown; artist?: unknown; track?: unknown };
    try {
      record = JSON.parse(op.record_json as string) as typeof record;
    } catch {
      continue;
    }
    if (
      typeof record.listenedAt !== 'string' ||
      typeof record.artist !== 'string' ||
      typeof record.track !== 'string'
    ) {
      continue;
    }
    const ns = parseRfc3339(record.listenedAt);
    if (ns === null || ns < lowerNs || ns >= upperNs) continue;
    let candidate: string;
    try {
      candidate = await recordingMsid(record.artist, record.track);
    } catch {
      continue;
    }
    // The newest listen of the second wins (the rows come newest submission first).
    if (candidate === msid && (best === null || ns > best.ns)) best = { ns, operationId: op.id };
  }
  return best === null ? { kind: 'none' } : { kind: 'pending', operationId: best.operationId };
}

async function deleteListen(
  req: Request,
  ctx: RequestCtx,
  options: LbRouteOptions,
  lb?: LbDispatch,
): Promise<Response> {
  const guard = lbGuard(req, ctx, options, lb);
  if (!guard.ok) return guard.response;
  const headers = guard.rateHeaders;
  const m = need(ctx, 'deps');
  // A delete is a PDS write: closed gate → 503 before any body byte is read (module comment).
  if (!lbPublicationOpen(m.config)) return lbError(503, LB_UNAVAILABLE_MESSAGE, headers);
  const body = await objectBody(req, false);
  if (body === null) return lbError(400, LB_JSON_INVALID, headers);
  if (!Object.hasOwn(body, 'listened_at')) return lbError(400, LB_DELETE_MESSAGES.timestampMissing, headers);
  const seconds = pyInt(body.listened_at);
  if (seconds === null) return lbError(400, LB_DELETE_MESSAGES.timestampInvalid(pyStr(body.listened_at)), headers);
  if (!Object.hasOwn(body, 'recording_msid')) return lbError(400, LB_DELETE_MESSAGES.msidMissing, headers);
  const rawMsid = body.recording_msid;
  if (!isPythonUuid(rawMsid)) return lbError(400, LB_DELETE_MESSAGES.msidInvalid(pyStr(rawMsid)), headers);
  const msid = canonicalMsid(rawMsid as string);

  const did = guard.token.did;
  // A timestamp outside the storable range cannot name any record.
  const inRange = seconds >= 0n && seconds <= 253_402_300_799n;
  const target = msid === null || !inRange ? { kind: 'none' as const } : await findDeleteTarget(m, did, seconds, msid);
  const kick = () => kickOutbox(ctx);
  if (target.kind === 'indexed') {
    enqueueScrobbleDelete(m, { did, uri: target.uri, origin: 'listenbrainz', kick });
  } else if (target.kind === 'pending') {
    removeScrobbleCreate(m, { did, operationId: target.operationId, origin: 'listenbrainz', kick });
  }
  return lbJson({ status: 'ok' }, 200, headers);
}

// ---------------------------------------------------------------------------
// POST /1/playing-now/delete

export const LB_PLAYING_NOW_MESSAGES = {
  alreadyCleared: 'Playing now already cleared',
  cleared: 'Playing now cleared successfully',
  clientMismatch: 'Playing now was submitted by another client.',
  clientNotString: 'client must be a string.',
} as const;

async function deletePlayingNow(
  req: Request,
  ctx: RequestCtx,
  options: LbRouteOptions,
  lb?: LbDispatch,
): Promise<Response> {
  const guard = lbGuard(req, ctx, options, lb);
  if (!guard.ok) return guard.response;
  const headers = guard.rateHeaders;
  const m = need(ctx, 'deps');
  const body = await objectBody(req, true);
  if (body === null) return lbError(400, LB_JSON_INVALID, headers);
  const client = body.client;
  if (client !== undefined && client !== null && typeof client !== 'string') {
    return lbError(400, LB_PLAYING_NOW_MESSAGES.clientNotString, headers);
  }
  const outcome = clearNowPlaying(m, guard.token.did, typeof client === 'string' && client !== '' ? client : null);
  if (outcome === 'client_mismatch') return lbError(404, LB_PLAYING_NOW_MESSAGES.clientMismatch, headers);
  const message = outcome === 'cleared' ? LB_PLAYING_NOW_MESSAGES.cleared : LB_PLAYING_NOW_MESSAGES.alreadyCleared;
  return lbJson({ status: 'ok', message }, 200, headers);
}

// ---------------------------------------------------------------------------
// Routes

/**
 * The token routes, with their OPTIONS answers (§8.1). Mountable standalone or
 * through the /1/ dispatcher's `registry` (module comment).
 */
export function createTokenRoutes(options: LbRouteOptions = {}): LbModuleRouteDef[] {
  return [
    {
      method: 'GET',
      pattern: '/1/validate-token',
      auth: 'optional',
      handler: (req, ctx, _params, lb) => validateToken(req, ctx, options, lb),
    },
    { method: 'OPTIONS', pattern: '/1/validate-token', handler: async () => lbPreflight(['GET']) },
    {
      method: 'POST',
      pattern: '/1/delete-listen',
      auth: 'required',
      handler: (req, ctx, _params, lb) => deleteListen(req, ctx, options, lb),
    },
    { method: 'OPTIONS', pattern: '/1/delete-listen', handler: async () => lbPreflight(['POST']) },
    {
      method: 'POST',
      pattern: '/1/playing-now/delete',
      auth: 'required',
      handler: (req, ctx, _params, lb) => deletePlayingNow(req, ctx, options, lb),
    },
    { method: 'OPTIONS', pattern: '/1/playing-now/delete', handler: async () => lbPreflight(['POST']) },
  ];
}

/** The token routes over the composition's shared limiter. */
export const routes: readonly LbModuleRouteDef[] = Object.freeze(createTokenRoutes());
