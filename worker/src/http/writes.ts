// The cookie write routes of contract v1.2 (ADR 0005 §5.7, §5.8, §8.3; ADR
// 0004 §5.2; N3-02) and the feature that wires the N3-02 routes.
//
// Every route here needs the session cookie plus CSRF (operations.ts
// `cookieRoute`: 401 `unauthenticated`, then 403 `csrf_failed`), then the
// open publication gate (503 `publication_disabled` while meta.capabilities
// lacks `publication`), and answers 202 `{operation: Operation}` once the
// operation is durably persisted in the server outbox — not yet on the PDS.
// After the commit the `outbox` extension timer is kicked.
//
// - `POST /api/v1/scrobbles` with a ScrobbleInput (the v1.0 fields plus the
//   optional §6.2 fields; at most 64 KiB) and an `Idempotency-Key`:
//   - the key must be exactly one header of 1–128 characters from
//     `[A-Za-z0-9._~-]`: missing → 400 `idempotency_key_required`; empty,
//     longer, repeated or with any other character → 400
//     `invalid_idempotency_key`. Both are checked before the body is read,
//     so nothing is written and no PDS request is made;
//   - the body is validated by @atmusic/core `buildScrobbleRecord` (closed
//     input): a failure is 422 `validation_failed` whose `fields` names the
//     ScrobbleInput field (`artist`, `track`, `listenedAt`, `album`,
//     `durationSeconds`, `recordingMbid`, the §6.2 names, or the unknown
//     field), before any operation exists;
//   - the request hash is SHA-256 over a domain label and the canonical JSON
//     of the validated record without its `createdAt` (the receipt time), so
//     two requests hash alike exactly when they describe the same listen,
//     however the JSON was spelled;
//   - the listen goes through the one live ingress, outbox/ingress.ts
//     `acceptListens` with origin `web`: listen key, daily cap, a
//     `scrobble.create` at live priority and the forward rows for the DID's
//     active links, in one transaction. Keys are scoped per DID: the same key
//     and hash return the DID's existing operation (whatever its state, so a
//     retry after success gets the same operation and writes nothing); the
//     same key with another hash is 409 `idempotency_conflict`; the same key
//     from another DID is a new operation;
//   - the same listen re-sent under a new key is the listen key's existing
//     operation (an idempotent client resend, ADR §7.7); over the daily cap
//     is 429 `rate_limited` with `Retry-After` until the oldest listen of the
//     rolling 24 h window leaves it.
// - `DELETE /api/v1/scrobbles/{id}` with the URL-encoded AT URI: not an
//   `at://<did>/<collection>/<rkey>` URI → 422 `validation_failed`
//   (`fields.id`); another DID's record, another collection, or an own URI
//   the server knows nothing of (no present or excluded `record_state` row
//   and no live `scrobble.create` of ours) → 404 `not_found`, with no
//   operation and no PDS request. Otherwise a `scrobble.delete` behind every
//   unsettled operation on the URI (outbox/delete-ops.ts).
// - `PUT /api/v1/follows/{did}` / `DELETE /api/v1/follows/{did}`: a
//   `follow.put` / `follow.delete` (FIFO per subject); an invalid subject or
//   a self-follow is 422 with `fields.did`.
// - `PUT /api/v1/loves` with a LoveInput (`{artist, track, album?,
//   recordingMbid?}`, closed) → `love.put`; `DELETE
//   /api/v1/loves?artist=&track=` → `love.delete` of every matching love.
//   Missing or repeated query parameters and invalid names are 422.
// - `PUT /api/v1/account/indexing` with `{indexing: "enabled"|"disabled"}` →
//   `settings.put` of the A10 `<prefix>.settings/self` record.
//
// `writesFeature(options)` is the composition unit (wired by N4-01): the
// routes of this module, operations.ts and account.ts, and the
// `webWrites` service built from the FeatureContext — the session store the
// composition passes in, ATMUSIC_PUBLIC_ORIGIN, the CSRF key derived from
// the encryption keys (crypto/box.ts), the outbox kick and the Account
// capabilities.

import type { AccountCapability } from '@atmusic/core/api-types';
import { canonicalJson } from '@atmusic/core/canonical';
import { ApiError } from '@atmusic/core/errors';
import type { ValidationFailure } from '@atmusic/core/scrobble';
import { isDid } from '@atmusic/core/syntax';
import type { OperationRow } from '../app/rows';
import { createBox } from '../crypto/box';
import type { ModuleDeps } from '../do/contracts';
import type { Feature, FeatureContext } from '../node/compose';
import { enqueueScrobbleDelete } from '../outbox/delete-ops';
import { enqueueFollow, enqueueUnfollow } from '../outbox/follow-ops';
import { acceptListens, DAILY_CAP_WINDOW_MS } from '../outbox/ingress';
import { enqueueLove, enqueueUnlove } from '../outbox/love-ops';
import { IdempotencyConflictError, loadOperation, operationDto, outboxCollections } from '../outbox/operations';
import { prepareScrobble, validRkey } from '../outbox/scrobble-ops';
import { enqueueSettings } from '../outbox/settings-ops';
import { routes as accountRoutes } from './account';
import { errorResponse, rateLimitedResponse } from './error';
import { json } from './json';
import {
  type CookieHandler,
  cookieRoute,
  type GuardSessions,
  routes as operationRoutes,
  publicationGate,
  v12ErrorResponse,
  type WebWritesService,
  type WebWritesServices,
  webWrites,
} from './operations';
import { readJsonBody, singleParam } from './params';
import { need, type RequestCtx, type RouteDef } from './types';

/** The request body cap of the JSON write routes (OpenAPI x-maxBodyBytes). */
export const WRITE_MAX_BODY_BYTES = 65_536;
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** OpenAPI `IdempotencyKey`. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._~-]{1,128}$/;
/** Domain separation of the web scrobble request hash. */
export const REQUEST_HASH_LABEL = 'atmusic.idempotency.scrobble.v1\0';

const encoder = new TextEncoder();

/** 202 `{operation}` for a stored operation. */
function accepted(op: OperationRow): Response {
  return json({ operation: operationDto(op) }, 202);
}

function validationFailed(ctx: RequestCtx, field: string, message: string): Response {
  return errorResponse('validation_failed', 422, ctx.requestId, { [field]: message });
}

function failure(ctx: RequestCtx, reason: ValidationFailure): Response {
  return validationFailed(ctx, reason.field, reason.message);
}

/** The module deps of an open namespace (the gate guarantees a prefix). */
function deps(ctx: RequestCtx): ModuleDeps & { config: { prefix: string } } {
  const m = need(ctx, 'deps');
  if (m.config.prefix === null) throw new ApiError('not_ready', 'no lexicon prefix');
  return m as ModuleDeps & { config: { prefix: string } };
}

function kick(ctx: RequestCtx): () => void {
  const service = webWrites(ctx);
  return () => service.kickOutbox();
}

/** A write route: the guard, then the publication gate, then `handler`. */
function writeRoute(handler: CookieHandler): RouteDef['handler'] {
  return cookieRoute(async (req, ctx, params, session) => publicationGate(ctx) ?? handler(req, ctx, params, session));
}

// ---------------------------------------------------------------------------
// POST /api/v1/scrobbles

export type IdempotencyKeyCheck =
  | { ok: true; key: string }
  | { ok: false; code: 'idempotency_key_required' | 'invalid_idempotency_key' };

/** The Idempotency-Key of `headers` (repeated headers arrive joined with ", ", which the pattern refuses). */
export function idempotencyKeyOf(headers: Headers): IdempotencyKeyCheck {
  const value = headers.get(IDEMPOTENCY_KEY_HEADER);
  if (value === null) return { ok: false, code: 'idempotency_key_required' };
  if (!IDEMPOTENCY_KEY_RE.test(value)) return { ok: false, code: 'invalid_idempotency_key' };
  return { ok: true, key: value };
}

/** SHA-256 of the label and the canonical record without `createdAt` (32 bytes). */
export async function scrobbleRequestHash(record: Readonly<Record<string, unknown>>): Promise<ArrayBuffer> {
  const { createdAt: _receipt, ...listen } = record;
  return crypto.subtle.digest('SHA-256', encoder.encode(REQUEST_HASH_LABEL + canonicalJson(listen)));
}

/** Seconds until the oldest live listen of the DID's rolling 24 h window leaves it (at least 1). */
function capRetryAfterSeconds(m: ModuleDeps, did: string, now: number): number {
  const oldest = m.db.one<{ t: number | null }>(
    `SELECT min(created_at_ms) AS t FROM listen_keys WHERE did = ? AND source != 'import' AND created_at_ms > ?`,
    did,
    now - DAILY_CAP_WINDOW_MS,
  )?.t;
  return oldest === null || oldest === undefined
    ? 1
    : Math.max(1, Math.ceil((oldest + DAILY_CAP_WINDOW_MS - now) / 1000));
}

export const postScrobble: CookieHandler = async (req, ctx, _params, session) => {
  const key = idempotencyKeyOf(req.headers);
  if (!key.ok) {
    if (req.body !== null) void req.body.cancel().catch(() => undefined);
    return v12ErrorResponse(key.code, ctx.requestId);
  }
  const body = await readJsonBody(req, WRITE_MAX_BODY_BYTES);
  const m = deps(ctx);
  const receiptMs = m.clock.nowMs();
  const built = await prepareScrobble(body, m.config.prefix, receiptMs);
  if (!built.ok) return failure(ctx, built.reason);
  const requestHash = await scrobbleRequestHash(built.prepared.record as unknown as Record<string, unknown>);
  let outcome: Awaited<ReturnType<typeof acceptListens>>;
  try {
    outcome = await acceptListens(m, {
      did: session.did,
      origin: 'web',
      listens: [{ input: body }],
      receiptMs,
      idempotency: { key: key.key, requestHash },
      kick: kick(ctx),
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return v12ErrorResponse('idempotency_conflict', ctx.requestId);
    throw error;
  }
  const result = outcome.results[0];
  if (result === undefined) throw new Error('acceptListens returned no result for one listen');
  switch (result.status) {
    case 'invalid':
      return failure(ctx, result.reason);
    case 'over_cap':
      return rateLimitedResponse(ctx.requestId, capRetryAfterSeconds(m, session.did, receiptMs));
    case 'accepted': {
      const op = result.operationId === null ? null : loadOperation(m.db, result.operationId);
      // A listen key without an operation (an imported listen already on the PDS): nothing to queue.
      if (op === null) return validationFailed(ctx, 'listenedAt', 'This listen is already recorded.');
      return accepted(op);
    }
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/v1/scrobbles/{id}

/** `at://<did>/<collection>/<rkey>` split, or null when `uri` is not of that shape. */
export function splitRecordUri(uri: string): { did: string; collection: string; rkey: string } | null {
  if (!uri.startsWith('at://')) return null;
  const parts = uri.slice('at://'.length).split('/');
  if (parts.length !== 3) return null;
  const [did, collection, rkey] = parts as [string, string, string];
  if (!isDid(did) || collection === '' || !validRkey(rkey)) return null;
  return { did, collection, rkey };
}

/** True when the server knows `uri` as one of `did`'s records: verified on the PDS, or our own live create. */
function knownOwnRecord(m: ModuleDeps, did: string, uri: string, collection: string, rkey: string): boolean {
  const state = m.db.one<{ one: number }>(
    `SELECT 1 AS one FROM record_state WHERE uri = ? AND did = ? AND state IN ('present','excluded')`,
    uri,
    did,
  );
  if (state !== null) return true;
  return (
    m.db.one<{ one: number }>(
      `SELECT 1 AS one FROM operations WHERE did = ? AND kind = 'scrobble.create' AND collection = ? AND rkey = ?
         AND state NOT IN ('failed','cancelled') LIMIT 1`,
      did,
      collection,
      rkey,
    ) !== null
  );
}

export const deleteScrobble: CookieHandler = async (_req, ctx, params, session) => {
  const uri = params.id ?? '';
  const parts = splitRecordUri(uri);
  if (parts === null) return validationFailed(ctx, 'id', 'Supply an encoded full scrobble AT URI.');
  const m = deps(ctx);
  const collection = outboxCollections(m.config.prefix).scrobble;
  // Another DID's record, or not a scrobble, is not found for this caller.
  if (parts.did !== session.did || parts.collection !== collection) {
    return errorResponse('not_found', 404, ctx.requestId);
  }
  if (!knownOwnRecord(m, session.did, uri, collection, parts.rkey)) {
    return errorResponse('not_found', 404, ctx.requestId);
  }
  const op = enqueueScrobbleDelete(m, { did: session.did, uri, origin: 'web', kick: kick(ctx) });
  return accepted(op);
};

// ---------------------------------------------------------------------------
// Follows

function followRoute(create: boolean): CookieHandler {
  return async (_req, ctx, params, session) => {
    const m = deps(ctx);
    const args = { did: session.did, subject: params.did ?? '', origin: 'web' as const, kick: kick(ctx) };
    const result = create ? await enqueueFollow(m, args) : await enqueueUnfollow(m, args);
    if (!result.ok) return validationFailed(ctx, 'did', result.reason.message);
    return accepted(result.operation);
  };
}

// ---------------------------------------------------------------------------
// Loves

export const putLove: CookieHandler = async (req, ctx, _params, session) => {
  const body = await readJsonBody(req, WRITE_MAX_BODY_BYTES);
  const m = deps(ctx);
  const result = await enqueueLove(m, { did: session.did, input: body, origin: 'web', kick: kick(ctx) });
  if (!result.ok) return failure(ctx, result.reason);
  return accepted(result.operation);
};

export const deleteLove: CookieHandler = async (req, ctx, _params, session) => {
  const q = new URL(req.url).searchParams;
  const artist = singleParam(q, 'artist');
  const track = singleParam(q, 'track');
  if (artist === undefined) return validationFailed(ctx, 'artist', 'Required query parameter.');
  if (track === undefined) return validationFailed(ctx, 'track', 'Required query parameter.');
  const m = deps(ctx);
  const result = await enqueueUnlove(m, { did: session.did, artist, track, origin: 'web', kick: kick(ctx) });
  if (!result.ok) return failure(ctx, result.reason);
  return accepted(result.operation);
};

// ---------------------------------------------------------------------------
// PUT /api/v1/account/indexing

export const putIndexing: CookieHandler = async (req, ctx, _params, session) => {
  const body = await readJsonBody(req, WRITE_MAX_BODY_BYTES);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return validationFailed(ctx, 'body', 'Expected a JSON object.');
  }
  const object = body as Record<string, unknown>;
  for (const field of Object.keys(object)) {
    if (field !== 'indexing') return validationFailed(ctx, field, 'Unknown field.');
  }
  const indexing = object.indexing;
  if (indexing !== 'enabled' && indexing !== 'disabled') {
    return validationFailed(ctx, 'indexing', 'Expected enabled or disabled.');
  }
  const m = deps(ctx);
  const result = await enqueueSettings(m, { did: session.did, indexing, origin: 'web', kick: kick(ctx) });
  if (!result.ok) return failure(ctx, result.reason);
  return accepted(result.operation);
};

// ---------------------------------------------------------------------------
// Routes and the feature

export const SCROBBLES_PATTERN = '/api/v1/scrobbles';
export const SCROBBLE_PATTERN = '/api/v1/scrobbles/{id}';
export const FOLLOW_PATTERN = '/api/v1/follows/{did}';
export const LOVES_PATTERN = '/api/v1/loves';
export const INDEXING_PATTERN = '/api/v1/account/indexing';

export const routes: RouteDef[] = [
  { method: 'POST', pattern: SCROBBLES_PATTERN, handler: writeRoute(postScrobble) },
  { method: 'DELETE', pattern: SCROBBLE_PATTERN, handler: writeRoute(deleteScrobble) },
  { method: 'PUT', pattern: FOLLOW_PATTERN, handler: writeRoute(followRoute(true)) },
  { method: 'DELETE', pattern: FOLLOW_PATTERN, handler: writeRoute(followRoute(false)) },
  { method: 'PUT', pattern: LOVES_PATTERN, handler: writeRoute(putLove) },
  { method: 'DELETE', pattern: LOVES_PATTERN, handler: writeRoute(deleteLove) },
  { method: 'PUT', pattern: INDEXING_PATTERN, handler: writeRoute(putIndexing) },
];

/**
 * The Account capabilities a composition offers (ADR §5.7, B14): `writes`
 * while the publication gate is open; the Last.fm 2.0 and ListenBrainz APIs
 * and imports always; `forwarding` only with the owner's Last.fm key pair.
 */
export function defaultAccountCapabilities(context: FeatureContext): AccountCapability[] {
  const capabilities: AccountCapability[] = [];
  if (context.config.app.publication) capabilities.push('writes');
  capabilities.push('lastfm', 'listenbrainz', 'imports');
  if (context.secrets.lastfm !== null) capabilities.push('forwarding');
  return capabilities;
}

export interface WritesFeatureOptions {
  /** The composition's web session store (bff/sessions.ts, with its revocation journal). */
  sessions(context: FeatureContext): GuardSessions;
  /** Default `defaultAccountCapabilities`. */
  capabilities?(context: FeatureContext): readonly AccountCapability[];
}

/** The N3-02 routes and their `webWrites` service (module header). */
export function writesFeature(options: WritesFeatureOptions): Feature {
  return {
    name: 'web-writes',
    routes: [...routes, ...operationRoutes, ...accountRoutes],
    services(context) {
      const capabilities = Object.freeze([
        ...(options.capabilities ?? defaultAccountCapabilities)(context),
      ]) as readonly AccountCapability[];
      const webWritesService: WebWritesService = Object.freeze({
        sessions: options.sessions(context),
        publicOrigin: context.config.publicOrigin,
        csrfKey: createBox(context.secrets.encryptionKeys, context.deps.random).csrfKey(),
        kickOutbox: () => {
          context.core.extensionTimers.kick('outbox');
        },
        capabilities: () => capabilities,
      });
      const part: WebWritesServices = { webWrites: webWritesService };
      return part;
    },
  };
}
