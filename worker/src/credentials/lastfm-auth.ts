// Last.fm desktop/web tokens and session keys (ADR 0005 §7.3, §13; N2-09).
//
// **Tokens** (`lastfm_tokens`, keyed by SHA-256 of the token):
// - `issueToken` (auth.getToken): 32 hex characters, valid 60 min, bound to
//   the `api_key` that asked for it, state `issued`.
// - `authorizeToken` (POST /api/v1/lastfm/authorize, cookie + CSRF, N3-03):
//   the signed-in DID approves; the token becomes `authorized` for it.
// - `createAuthorizedToken` (the web flow's approval): a fresh token,
//   already `authorized`, handed to the client's `cb`.
// - `getSession` (auth.getSession) consumes an authorized token exactly once
//   and issues a session key. Errors, in this order: unknown, consumed or
//   another `api_key` → **4**; expired → **15**; not yet authorized → **14**.
// - `sweepLastfmTokens` is the expiry-sweep handler (ADR §3.3, wired by
//   N4-01): consumed tokens go at once, expired ones an hour after expiry, so
//   a client polling just after the hour still gets 15 rather than 4.
//
// **Session keys** (`lastfm_sessions`): 32 hex characters (128 bits), stored
// only as SHA-256, with no expiry. `verifySessionKey` compares digests in
// constant time and answers **9** for a missing, malformed, unknown or
// revoked key; `last_used_ms` is written at most once per minute.
// `revokeLastfmSession` journals `{kind: 'lastfm_session', id, did}` inside
// the deleting transaction, before it commits (ADR §14.5).
//
// **Mobile flow** (`getMobileSession`): our app password (app-passwords.ts)
// for a username, verified handle or DID; wrong credentials and the
// unsupported `authToken` form are **4**. The failure rate limit is the
// route's (N3-03).
//
// Results carry the Last.fm error code; the routes (N3-03) encode them.

import type { LastfmSessionRow, LastfmTokenRow } from '../app/rows';
import { constantTimeEqual } from '../crypto/constant-time';
import { hashToken, newLastfmSessionKey, newLastfmToken } from '../crypto/tokens';
import type { Db } from '../do/db';
import { type CredentialDeps, displayName, getAccount, newCredentialId, toBlob, touchLastUsed } from './accounts';
import { verifyAppPassword } from './app-passwords';
import { issuedAppName } from './lastfm-apps';

/** A desktop or web token is valid this long after it is issued (ADR §7.3). */
export const LASTFM_TOKEN_TTL_MS = 60 * 60 * 1000;
/** An expired, unconsumed token is kept this much longer so getSession can still answer 15. */
export const EXPIRED_TOKEN_RETENTION_MS = 60 * 60 * 1000;
/** `api_key` identifies a client only; any non-empty value of at most this length is accepted (ADR §7.3). */
export const MAX_API_KEY_LENGTH = 64;
/** Stored `client_name` values are cut to this many characters. */
export const MAX_CLIENT_NAME_LENGTH = 64;

/** The Last.fm error codes these flows produce (ADR §7.6). */
export type LastfmAuthCode = 4 | 9 | 10 | 14 | 15;

export type LastfmResult<T> = { ok: true; value: T } | { ok: false; code: LastfmAuthCode; message?: string };

const HEX32_RE = /^[0-9a-f]{32}$/;

const fail = (code: LastfmAuthCode, message?: string): { ok: false; code: LastfmAuthCode; message?: string } =>
  message === undefined ? { ok: false, code } : { ok: false, code, message };

export function isValidApiKey(apiKey: unknown): apiKey is string {
  return typeof apiKey === 'string' && apiKey.length > 0 && apiKey.length <= MAX_API_KEY_LENGTH;
}

/** A token or session key as we issue them (lowercase 32 hex), or null when it cannot be one of ours. */
function normaliseHex32(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return HEX32_RE.test(lower) ? lower : null;
}

/** A client name fit for Settings: control characters removed, trimmed, at most 64 characters; null if empty. */
export function sanitiseClientName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  const cleaned = [...name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()]
    .slice(0, MAX_CLIENT_NAME_LENGTH)
    .join('');
  return cleaned.length > 0 ? cleaned : null;
}

// --- tokens -----------------------------------------------------------------

export interface IssuedToken {
  token: string;
  expiresAtMs: number;
}

function insertToken(
  deps: Pick<CredentialDeps, 'db' | 'clock' | 'random'>,
  apiKey: string,
  did: string | null,
): IssuedToken {
  const token = newLastfmToken(deps.random);
  const now = deps.clock.nowMs();
  const expiresAtMs = now + LASTFM_TOKEN_TTL_MS;
  deps.db.run(
    'INSERT INTO lastfm_tokens (token_hash, api_key, did, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    toBlob(hashToken(token)),
    apiKey,
    did,
    did === null ? 'issued' : 'authorized',
    now,
    expiresAtMs,
  );
  return { token, expiresAtMs };
}

/** auth.getToken: a new single-use token bound to `apiKey`. An invalid `api_key` is 10. */
export function issueToken(
  deps: Pick<CredentialDeps, 'db' | 'clock' | 'random'>,
  apiKey: string,
): LastfmResult<IssuedToken> {
  if (!isValidApiKey(apiKey)) return fail(10);
  return { ok: true, value: deps.db.tx(() => insertToken(deps, apiKey, null)) };
}

function tokenRow(db: Db, token: string): { row: LastfmTokenRow; digest: Uint8Array } | null {
  const normalised = normaliseHex32(token);
  if (normalised === null) return null;
  const digest = hashToken(normalised);
  const row = db.one<LastfmTokenRow>('SELECT * FROM lastfm_tokens WHERE token_hash = ?', toBlob(digest));
  if (row === null || !constantTimeEqual(row.token_hash, digest)) return null;
  return { row, digest };
}

export type AuthorizeResult =
  | { ok: true }
  | { ok: false; reason: 'unknown_token' | 'api_key_mismatch' | 'expired' | 'already_authorized' | 'no_account' };

/**
 * The signed-in `did` approves desktop token `token` for `apiKey`. Approving a
 * token the same DID already approved is a no-op; one another DID approved,
 * or one already consumed, is refused.
 */
export function authorizeToken(
  deps: Pick<CredentialDeps, 'db' | 'clock'>,
  input: { did: string; apiKey: string; token: string },
): AuthorizeResult {
  const { db } = deps;
  return db.tx((): AuthorizeResult => {
    if (getAccount(db, input.did) === null) return { ok: false, reason: 'no_account' };
    const found = tokenRow(db, input.token);
    if (found === null || found.row.state === 'consumed') return { ok: false, reason: 'unknown_token' };
    const { row, digest } = found;
    if (row.api_key !== input.apiKey) return { ok: false, reason: 'api_key_mismatch' };
    if (deps.clock.nowMs() >= row.expires_at_ms) return { ok: false, reason: 'expired' };
    if (row.state === 'authorized') {
      return row.did === input.did ? { ok: true } : { ok: false, reason: 'already_authorized' };
    }
    db.run(
      "UPDATE lastfm_tokens SET state = 'authorized', did = ? WHERE token_hash = ? AND state = 'issued'",
      input.did,
      toBlob(digest),
    );
    return { ok: true };
  });
}

/** The web flow's approval (ADR §7.3): a new token for `apiKey`, already authorized for `did`. */
export function createAuthorizedToken(
  deps: Pick<CredentialDeps, 'db' | 'clock' | 'random'>,
  input: { did: string; apiKey: string },
): LastfmResult<IssuedToken> {
  if (!isValidApiKey(input.apiKey)) return fail(10);
  return deps.db.tx((): LastfmResult<IssuedToken> => {
    if (getAccount(deps.db, input.did) === null) return fail(4);
    return { ok: true, value: insertToken(deps, input.apiKey, input.did) };
  });
}

// --- session keys -----------------------------------------------------------

export interface IssuedSession {
  /** `lastfm_sessions.id` (Settings, the journal). */
  id: string;
  /** The `<session><name>`: username, else verified handle, else DID (ADR §9). */
  name: string;
  /** The session key `sk`: returned once, never stored. */
  key: string;
}

/**
 * Issue a session key for `did` under `apiKey` (getSession and
 * getMobileSession). `client_name` is the caller's, else the issued app's name.
 */
export function createSession(
  deps: Pick<CredentialDeps, 'db' | 'clock' | 'random'>,
  input: { did: string; apiKey: string; clientName?: string | null },
): IssuedSession {
  const { db } = deps;
  if (!isValidApiKey(input.apiKey)) throw new RangeError('api_key must be 1-64 characters');
  return db.tx(() => {
    const id = newCredentialId(deps.random);
    const key = newLastfmSessionKey(deps.random);
    const clientName = sanitiseClientName(input.clientName) ?? issuedAppName(db, input.apiKey);
    db.run(
      `INSERT INTO lastfm_sessions (id, sk_hash, did, api_key, client_name, created_at_ms, last_used_ms)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      id,
      toBlob(hashToken(key)),
      input.did,
      input.apiKey,
      clientName,
      deps.clock.nowMs(),
    );
    return { id, name: displayName(db, input.did), key };
  });
}

/**
 * auth.getSession: consume authorized token `token` (once) and issue a session
 * key. Unknown, consumed or another api_key → 4; expired → 15; unauthorized → 14.
 */
export function getSession(
  deps: Pick<CredentialDeps, 'db' | 'clock' | 'random'>,
  input: { apiKey: string; token: string; clientName?: string | null },
): LastfmResult<IssuedSession> {
  const { db } = deps;
  if (!isValidApiKey(input.apiKey)) return fail(10);
  return db.tx((): LastfmResult<IssuedSession> => {
    const found = tokenRow(db, input.token);
    if (found === null || found.row.state === 'consumed') return fail(4);
    const { row, digest } = found;
    if (row.api_key !== input.apiKey) return fail(4);
    if (deps.clock.nowMs() >= row.expires_at_ms) return fail(15);
    if (row.state !== 'authorized' || row.did === null) return fail(14);
    const { rowsWritten } = db.run(
      "UPDATE lastfm_tokens SET state = 'consumed' WHERE token_hash = ? AND state = 'authorized'",
      toBlob(digest),
    );
    if (rowsWritten !== 1) return fail(4);
    return {
      ok: true,
      value: createSession(deps, { did: row.did, apiKey: row.api_key, clientName: input.clientName }),
    };
  });
}

/** The getMobileSession message for the deprecated `authToken` form (ADR §7.3). */
export const AUTH_TOKEN_UNSUPPORTED = 'authToken is not supported; use password';

/**
 * auth.getMobileSession: `username` (username, verified handle or DID) and an
 * app password. Wrong credentials → 4; `authToken` instead of `password` → 4.
 */
export function getMobileSession(
  deps: Pick<CredentialDeps, 'db' | 'clock' | 'random'>,
  input: { apiKey: string; username?: string; password?: string; authToken?: string; clientName?: string | null },
): LastfmResult<IssuedSession> {
  if (!isValidApiKey(input.apiKey)) return fail(10);
  if (input.password === undefined && input.authToken !== undefined) return fail(4, AUTH_TOKEN_UNSUPPORTED);
  if (typeof input.username !== 'string' || typeof input.password !== 'string') return fail(4);
  const verified = verifyAppPassword(deps, { username: input.username, password: input.password });
  if (verified === null) return fail(4);
  return {
    ok: true,
    value: createSession(deps, { did: verified.did, apiKey: input.apiKey, clientName: input.clientName }),
  };
}

export interface VerifiedSession {
  id: string;
  did: string;
  apiKey: string;
  /** The user name responses use (ADR §9). */
  name: string;
}

/**
 * The session `sk` names, with a constant-time digest comparison, or 9 for a
 * missing, malformed, unknown or revoked key. Session keys never expire.
 * Writes `last_used_ms` at most once per minute.
 */
export function verifySessionKey(
  deps: Pick<CredentialDeps, 'db' | 'clock'>,
  sk: string | null | undefined,
): LastfmResult<VerifiedSession> {
  const { db } = deps;
  const normalised = normaliseHex32(sk);
  if (normalised === null) return fail(9);
  const digest = hashToken(normalised);
  const row = db.one<Pick<LastfmSessionRow, 'id' | 'did' | 'api_key' | 'sk_hash'>>(
    'SELECT id, did, api_key, sk_hash FROM lastfm_sessions WHERE sk_hash = ?',
    toBlob(digest),
  );
  if (row === null || !constantTimeEqual(row.sk_hash, digest)) return fail(9);
  touchLastUsed(db, 'lastfm_sessions', row.id, deps.clock.nowMs());
  return { ok: true, value: { id: row.id, did: row.did, apiKey: row.api_key, name: displayName(db, row.did) } };
}

export interface LastfmSessionInfo {
  id: string;
  apiKey: string;
  clientName: string | null;
  createdAtMs: number;
  lastUsedMs: number | null;
}

/** The DID's Last.fm sessions, newest first, metadata only (Settings, ADR §7.3). */
export function listLastfmSessions(db: Db, did: string): LastfmSessionInfo[] {
  return db
    .all<Pick<LastfmSessionRow, 'id' | 'api_key' | 'client_name' | 'created_at_ms' | 'last_used_ms'>>(
      `SELECT id, api_key, client_name, created_at_ms, last_used_ms FROM lastfm_sessions
       WHERE did = ? ORDER BY created_at_ms DESC, id`,
      did,
    )
    .map((r) => ({
      id: r.id,
      apiKey: r.api_key,
      clientName: r.client_name,
      createdAtMs: r.created_at_ms,
      lastUsedMs: r.last_used_ms,
    }));
}

/** Delete session `id` of `did`, journaling the revocation before the delete commits. False when there is none. */
export function revokeLastfmSession(
  deps: Pick<CredentialDeps, 'db' | 'revocations'>,
  did: string,
  id: string,
): boolean {
  return deps.db.tx(() => {
    const gone = deps.db.all<{ id: string }>(
      'DELETE FROM lastfm_sessions WHERE id = ? AND did = ? RETURNING id',
      id,
      did,
    );
    if (gone.length === 0) return false;
    deps.revocations.record({ kind: 'lastfm_session', id, did });
    return true;
  });
}

// --- expiry sweep -----------------------------------------------------------

/**
 * The `expiry-sweep` handler for `lastfm_tokens` (ADR §3.3; composed by
 * N4-01): deletes consumed tokens, and unconsumed tokens that expired more
 * than EXPIRED_TOKEN_RETENTION_MS ago. Returns how many rows it deleted.
 * Tokens are not journaled: every one expires within an hour of being issued.
 */
export function sweepLastfmTokens(db: Db, now: number): number {
  return db.run(
    "DELETE FROM lastfm_tokens WHERE state = 'consumed' OR expires_at_ms <= ?",
    now - EXPIRED_TOKEN_RETENTION_MS,
  ).rowsWritten;
}
