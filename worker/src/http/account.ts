// The account routes of contract v1.2 (ADR 0005 §5.7, §8.3, §9; N3-02):
//
// - `GET /api/v1/account` → Account {did, handle, username, oauthStatus,
//   shareNowPlaying, importSharePercent, capabilities}, `Cache-Control:
//   no-store`. `handle` is the DID's verified handle (`users.handle`, kept
//   bidirectionally verified by the identity sweeps) or null. A session whose
//   DID has no account row (never the case after a sign-in callback) is 404.
// - `PATCH /api/v1/account` (cookie plus CSRF) with an AccountPatch: a closed
//   object of at least one of `username`, `shareNowPlaying` (boolean) and
//   `importSharePercent` (an integer 10..90). A malformed body is 400
//   `invalid_json`, an unknown or mistyped field 422 `validation_failed`
//   naming it. Usernames follow §9 through credentials/accounts.ts
//   `renameAccount`: lowercased; a name outside the Username pattern is 422
//   `validation_failed`; a dotted name other than the caller's own currently
//   verified handle (including another DID's verified handle) is 422
//   `username_invalid`; a name another account holds is 409
//   `username_taken`. Every change of one request is applied in one
//   transaction, so a refused username leaves the other fields unchanged too.
//   200 with the updated Account.
// - `GET /api/v1/account/ignored-listens?limit&cursor` → IgnoredListenPage:
//   the caller's `ignored_listens` rows (listens ListenBrainz accepts but our
//   validator refuses, written by N3-05 with the first 128 scalars of each
//   name), newest first (`created_at_ms DESC, id DESC`), only those inside
//   the 30-day retention (the expiry sweep deletes older rows, N4-01).
//   `limit` is 1..100 (default 20, 422 otherwise, never clamped). The cursor
//   is opaque and signed: base64url of the last row's `(created_at_ms, id)`
//   plus an HMAC-SHA256 over a domain label, the viewer DID and that payload,
//   keyed with the cursor key, so a cursor is bound to its viewer and route
//   and anything altered is 400 `invalid_cursor`. `Cache-Control: no-store`.
//
// All three need a session; GET has no CSRF check, PATCH does (cookieRoute).

import { Buffer } from 'node:buffer';
import type { Account } from '@atmusic/core/api-types';
import { ApiError } from '@atmusic/core/errors';
import { fromMs, parseRfc3339, toDto } from '@atmusic/core/timestamp';
import type { AccountRow, IgnoredListenRow } from '../app/rows';
import type { WebSession } from '../bff/sessions';
import { getAccount, renameAccount, storedVerifiedHandle, USERNAME_RE } from '../credentials/accounts';
import type { Db } from '../do/db';
import { errorResponse } from './error';
import { json } from './json';
import { type CookieHandler, cookieRoute, v12ErrorResponse, webWrites } from './operations';
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, parseLimit, readJsonBody, singleParam } from './params';
import { need, type RequestCtx, type RouteDef } from './types';

/** The request body cap of PATCH /api/v1/account (OpenAPI x-maxBodyBytes). */
export const ACCOUNT_MAX_BODY_BYTES = 65_536;
/** ignored_listens rows are kept and listed for 30 days (ADR §8.3). */
export const IGNORED_LISTEN_RETENTION_MS = 30 * 24 * 3_600_000;
export const IMPORT_SHARE_MIN = 10;
export const IMPORT_SHARE_MAX = 90;

const PATCH_FIELDS: ReadonlySet<string> = new Set(['username', 'shareNowPlaying', 'importSharePercent']);

/** The Account DTO of `account`. */
export function accountDto(db: Db, account: AccountRow, ctx: RequestCtx): Account {
  return {
    did: account.did,
    handle: storedVerifiedHandle(db, account.did),
    username: account.username,
    oauthStatus: account.oauth_status,
    shareNowPlaying: account.share_now_playing === 1,
    importSharePercent: account.import_share_pct,
    capabilities: [...webWrites(ctx).capabilities(account.did)],
  };
}

function accountResponse(db: Db, did: string, ctx: RequestCtx): Response {
  const account = getAccount(db, did);
  if (account === null) return errorResponse('not_found', 404, ctx.requestId);
  return json(accountDto(db, account, ctx), 200, { 'cache-control': 'no-store' });
}

export const getAccountRoute: CookieHandler = async (_req, ctx, _params, session) =>
  accountResponse(need(ctx, 'deps').db, session.did, ctx);

interface AccountPatch {
  username?: string;
  shareNowPlaying?: boolean;
  importSharePercent?: number;
}

/** The validated AccountPatch, or a 422 ApiError naming the field. */
export function parseAccountPatch(body: unknown): AccountPatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('validation_failed', 'account patch is not an object', { body: 'Expected a JSON object.' });
  }
  const object = body as Record<string, unknown>;
  const keys = Object.keys(object);
  for (const key of keys) {
    if (!PATCH_FIELDS.has(key)) throw new ApiError('validation_failed', 'unknown field', { [key]: 'Unknown field.' });
  }
  if (keys.length === 0) {
    throw new ApiError('validation_failed', 'empty patch', { body: 'Supply at least one field to change.' });
  }
  const patch: AccountPatch = {};
  if (Object.hasOwn(object, 'username')) {
    const name = object.username;
    if (typeof name !== 'string' || !USERNAME_RE.test(name.toLowerCase())) {
      throw new ApiError('validation_failed', 'invalid username', {
        username: 'Expected 2-64 characters from [a-z0-9._-], starting with a letter or digit.',
      });
    }
    patch.username = name;
  }
  if (Object.hasOwn(object, 'shareNowPlaying')) {
    if (typeof object.shareNowPlaying !== 'boolean') {
      throw new ApiError('validation_failed', 'invalid shareNowPlaying', { shareNowPlaying: 'Expected a boolean.' });
    }
    patch.shareNowPlaying = object.shareNowPlaying;
  }
  if (Object.hasOwn(object, 'importSharePercent')) {
    const pct = object.importSharePercent;
    if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < IMPORT_SHARE_MIN || pct > IMPORT_SHARE_MAX) {
      throw new ApiError('validation_failed', 'invalid importSharePercent', {
        importSharePercent: `Expected an integer between ${IMPORT_SHARE_MIN} and ${IMPORT_SHARE_MAX}.`,
      });
    }
    patch.importSharePercent = pct;
  }
  return patch;
}

type PatchOutcome = { ok: true } | { ok: false; response: Response };

class PatchRefused extends Error {
  constructor(readonly response: Response) {
    super('account patch refused');
    this.name = 'PatchRefused';
  }
}

export const patchAccountRoute: CookieHandler = async (req, ctx, _params, session) => {
  const patch = parseAccountPatch(await readJsonBody(req, ACCOUNT_MAX_BODY_BYTES));
  const m = need(ctx, 'deps');
  const db = m.db;
  let outcome: PatchOutcome;
  try {
    outcome = db.tx((): PatchOutcome => {
      if (getAccount(db, session.did) === null) {
        return { ok: false, response: errorResponse('not_found', 404, ctx.requestId) };
      }
      const now = m.clock.nowMs();
      if (patch.username !== undefined) {
        const renamed = renameAccount(m, { did: session.did, username: patch.username });
        if (!renamed.ok) {
          // Thrown, so the transaction rolls back and no other field of the request changes.
          throw new PatchRefused(
            renamed.error === 'username_taken'
              ? v12ErrorResponse('username_taken', ctx.requestId)
              : renamed.error === 'username_invalid'
                ? v12ErrorResponse('username_invalid', ctx.requestId, {
                    username: 'Dotted usernames are reserved for your own verified handle.',
                  })
                : errorResponse('not_found', 404, ctx.requestId),
          );
        }
      }
      if (patch.shareNowPlaying !== undefined) {
        db.run(
          'UPDATE accounts SET share_now_playing = ?, updated_at_ms = ? WHERE did = ?',
          patch.shareNowPlaying ? 1 : 0,
          now,
          session.did,
        );
      }
      if (patch.importSharePercent !== undefined) {
        db.run(
          'UPDATE accounts SET import_share_pct = ?, updated_at_ms = ? WHERE did = ?',
          patch.importSharePercent,
          now,
          session.did,
        );
      }
      return { ok: true };
    });
  } catch (error) {
    if (error instanceof PatchRefused) return error.response;
    throw error;
  }
  if (!outcome.ok) return outcome.response;
  return accountResponse(db, session.did, ctx);
};

// ---------------------------------------------------------------------------
// Ignored listens

/** One IgnoredListen of the v1.2 IgnoredListenPage. */
export interface IgnoredListenDto {
  id: string;
  source: IgnoredListenRow['source'];
  reason: IgnoredListenRow['reason'];
  listenedAt: string;
  artistPreview: string;
  trackPreview: string;
  createdAt: string;
}

function ignoredDto(row: IgnoredListenRow): IgnoredListenDto {
  const listened = parseRfc3339(row.listened_at);
  return {
    id: String(row.id),
    source: row.source,
    reason: row.reason,
    listenedAt: listened === null ? row.listened_at : toDto(listened),
    artistPreview: row.artist_preview,
    trackPreview: row.track_preview,
    createdAt: toDto(fromMs(row.created_at_ms)),
  };
}

const CURSOR_LABEL = 'atmusic.ignored-listens.cursor.v1\0';
const encoder = new TextEncoder();

interface IgnoredPosition {
  createdAtMs: number;
  id: number;
}

function invalidCursor(): ApiError {
  return new ApiError('invalid_cursor', 'ignored-listens cursor is invalid');
}

function macInput(did: string, payload: string): Uint8Array {
  return encoder.encode(`${CURSOR_LABEL}${did}\0${payload}`);
}

/** The signed cursor after `position`, bound to `did`. */
export async function encodeIgnoredCursor(key: CryptoKey, did: string, position: IgnoredPosition): Promise<string> {
  const payload = JSON.stringify({ c: position.createdAtMs, i: position.id });
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, macInput(did, payload)));
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${Buffer.from(mac).toString('base64url')}`;
}

/** The position a cursor names; 400 `invalid_cursor` for anything not signed for `did`. */
export async function decodeIgnoredCursor(key: CryptoKey, did: string, token: string): Promise<IgnoredPosition> {
  if (token.length === 0 || token.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw invalidCursor();
  }
  const [rawPayload, rawMac] = token.split('.') as [string, string];
  const payload = Buffer.from(rawPayload, 'base64url').toString('utf8');
  const mac = Buffer.from(rawMac, 'base64url');
  // Canonical encodings only: what decodes must re-encode to the same text.
  if (Buffer.from(payload, 'utf8').toString('base64url') !== rawPayload || mac.toString('base64url') !== rawMac) {
    throw invalidCursor();
  }
  if (mac.length !== 32 || !(await crypto.subtle.verify('HMAC', key, mac, macInput(did, payload)))) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw invalidCursor();
  }
  const value = parsed as { c?: unknown; i?: unknown } | null;
  if (
    value === null ||
    typeof value !== 'object' ||
    !Number.isSafeInteger(value.c) ||
    !Number.isSafeInteger(value.i) ||
    (value.c as number) < 0 ||
    (value.i as number) < 0
  ) {
    throw invalidCursor();
  }
  return { createdAtMs: value.c as number, id: value.i as number };
}

export const getIgnoredListens: CookieHandler = async (req, ctx, _params, session: WebSession) => {
  const q = new URL(req.url).searchParams;
  const limit = parseLimit(q, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
  const token = singleParam(q, 'cursor');
  const after = token === undefined ? null : await decodeIgnoredCursor(ctx.cursorKey, session.did, token);
  const m = need(ctx, 'deps');
  const since = m.clock.nowMs() - IGNORED_LISTEN_RETENTION_MS;
  const rows =
    after === null
      ? m.db.all<IgnoredListenRow>(
          `SELECT * FROM ignored_listens WHERE did = ? AND created_at_ms > ?
           ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
          session.did,
          since,
          limit + 1,
        )
      : m.db.all<IgnoredListenRow>(
          `SELECT * FROM ignored_listens WHERE did = ? AND created_at_ms > ?
             AND (created_at_ms < ? OR (created_at_ms = ? AND id < ?))
           ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
          session.did,
          since,
          after.createdAtMs,
          after.createdAtMs,
          after.id,
          limit + 1,
        );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? await encodeIgnoredCursor(ctx.cursorKey, session.did, { createdAtMs: last.created_at_ms, id: last.id })
      : null;
  return json({ items: page.map(ignoredDto), nextCursor }, 200, { 'cache-control': 'no-store' });
};

export const ACCOUNT_PATTERN = '/api/v1/account';
export const IGNORED_LISTENS_PATTERN = '/api/v1/account/ignored-listens';

export const routes: RouteDef[] = [
  { method: 'GET', pattern: ACCOUNT_PATTERN, handler: cookieRoute(getAccountRoute) },
  { method: 'PATCH', pattern: ACCOUNT_PATTERN, handler: cookieRoute(patchAccountRoute) },
  { method: 'GET', pattern: IGNORED_LISTENS_PATTERN, handler: cookieRoute(getIgnoredListens) },
];
