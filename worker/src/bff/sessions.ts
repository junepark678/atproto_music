// Browser sessions: the `__Host-atmusic_session` cookie (ADR 0005 §5.6, §13,
// §14.5; N2-04). The Node successor of crates/server/src/auth/session.rs.
//
// - **Token.** 32 random bytes from the injected Random as 64 lowercase hex
//   (crypto/tokens.ts newSessionToken). It encodes no account identifier.
// - **Storage.** Only SHA-256(token) is stored (`web_sessions.token_hash`, a
//   32-byte BLOB), never the token or anything derived from it with a key.
// - **Cookie.** `__Host-atmusic_session=<token>; HttpOnly; Secure;
//   SameSite=Lax; Path=/; Max-Age=2592000`. The `__Host-` prefix requires
//   Secure, Path=/ and no Domain attribute; none is ever set.
// - **Lifetime.** 30 days from the last renewal. A resolve of a session whose
//   current 30-day term began more than 24 hours ago renews it in place: same
//   token, same row, `expires_at_ms = now + 30 days`, `last_seen_ms = now`,
//   and a fresh Set-Cookie for the caller to send. `created_at_ms` keeps the
//   original sign-in time (the revocation replay compares it, §14.5). Between
//   renewals a resolve writes nothing, so a read costs no database write.
//   `resolve` is `lookup` (never writes) followed by `renew` (writes only
//   when due); the cookie guard calls the two separately so that a request it
//   refuses (403 csrf_failed) writes nothing and sets no cookie.
// - **DID.** create() accepts only a DID with the generic syntax of
//   @atmusic/core/syntax isDid, which is contained in what the revocation
//   journal accepts, so every stored session can be journaled and logged out.
// - **Expiry.** A session with `expires_at_ms <= now` resolves to nothing.
//   `sweepExpiredWebSessions` (the expiry-sweep timer, N4-01) deletes such
//   rows; expiry is not journaled (§14.5).
// - **Logout / logout-all.** Delete one row, or every row of the DID. Inside
//   the deleting transaction each deleted hash is first appended to the
//   revocation journal (app/revocations.ts); a journal failure throws, the
//   transaction rolls back and the session stays valid, so no session is ever
//   deleted without its journal entry and a restore never resurrects one.
//
// A cookie value that is not exactly one well-formed 64-hex token (absent,
// repeated, uppercase, the wrong length) resolves to no session without
// touching the database, like the Rust `authenticate`.

import type { Clock, Random } from '@atmusic/core/deps';
import { isDid } from '@atmusic/core/syntax';
import type { Revocations } from '../app/revocations';
import type { WebSessionRow } from '../app/rows';
import { bytesToHex, hashTokenBlob, newSessionToken } from '../crypto/tokens';
import type { Db } from '../do/db';

export const SESSION_COOKIE = '__Host-atmusic_session';
/** 30 days, the cookie's Max-Age (ADR §5.6). */
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
export const SESSION_TTL_MS = SESSION_MAX_AGE_S * 1000;
/** A session is renewed once its current term is more than this old. */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

const TOKEN_RE = /^[0-9a-f]{64}$/;
const COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/';

/** The Set-Cookie value that installs (or renews) `token` for 30 days. */
export function sessionCookie(token: string): string {
  if (!TOKEN_RE.test(token)) throw new RangeError('a session token is 64 lowercase hex characters');
  return `${SESSION_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_MAX_AGE_S}`;
}

/** The Set-Cookie value that removes the session cookie. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}

/**
 * The session token a Cookie header carries: exactly one `__Host-atmusic_session`
 * pair whose value is 64 lowercase hex, else null. Repeated Cookie headers
 * arrive joined (with "; " by Fetch, ", " by some proxies); cookie values
 * never contain either separator (RFC 6265 cookie-octet), so both split.
 */
export function sessionTokenFromCookies(cookieHeader: string | null): string | null {
  if (cookieHeader === null || cookieHeader === '') return null;
  const values: string[] = [];
  for (const pair of cookieHeader.split(/[;,]/)) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === SESSION_COOKIE) values.push(pair.slice(eq + 1).trim());
  }
  if (values.length !== 1) return null;
  const token = values[0] as string;
  return TOKEN_RE.test(token) ? token : null;
}

/** A resolved, live session. */
export interface WebSession {
  did: string;
  /** The raw cookie value (needed for the CSRF HMAC); never stored or logged. */
  token: string;
  /** SHA-256(token) as 64 lowercase hex. */
  tokenHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastSeenMs: number;
  /** Set when this resolve renewed the session: the Set-Cookie the response must carry. */
  renewCookie: string | null;
}

/** A newly created session. */
export interface IssuedWebSession {
  did: string;
  token: string;
  tokenHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  /** The Set-Cookie for the response. */
  setCookie: string;
}

export interface WebSessionsDeps {
  db: Db;
  clock: Clock;
  random: Random;
  revocations: Revocations;
}

export interface WebSessions {
  /** Create a session for `did` and return its cookie. */
  create(did: string): IssuedWebSession;
  /** The live session of a raw token, renewing it when due; null when unknown, expired or malformed. */
  resolve(token: string | null): WebSession | null;
  /** The live session a Cookie header carries (see sessionTokenFromCookies), renewing it when due. */
  resolveCookieHeader(cookieHeader: string | null): WebSession | null;
  /** Like resolve, but never renews and never writes (`renewCookie` is always null). */
  lookup(token: string | null): WebSession | null;
  /** Like resolveCookieHeader, but never renews and never writes. */
  lookupCookieHeader(cookieHeader: string | null): WebSession | null;
  /**
   * Renew a looked-up session when its term is more than 24 h old. Returns the
   * session (with `renewCookie` set when it was renewed), or null when it was
   * deleted or expired since the lookup.
   */
  renew(session: WebSession): WebSession | null;
  /** Delete the session of `token`, journaling it first. True when a row was deleted. */
  logout(token: string): boolean;
  /** Delete every session of `did`, journaling each first. Returns how many were deleted. */
  logoutAll(did: string): number;
}

function blobHex(blob: ArrayBuffer | Uint8Array): string {
  return bytesToHex(blob instanceof Uint8Array ? blob : new Uint8Array(blob));
}

export function createWebSessions(deps: WebSessionsDeps): WebSessions {
  const { db, clock, random, revocations } = deps;

  const lookup = (token: string | null): WebSession | null => {
    if (token === null || !TOKEN_RE.test(token)) return null;
    const row = db.one<WebSessionRow>(
      'SELECT token_hash, did, created_at_ms, expires_at_ms, last_seen_ms FROM web_sessions WHERE token_hash = ?',
      hashTokenBlob(token),
    );
    if (row === null || row.expires_at_ms <= clock.nowMs()) return null;
    return {
      did: row.did,
      token,
      tokenHash: blobHex(row.token_hash),
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
      lastSeenMs: row.last_seen_ms,
      renewCookie: null,
    };
  };

  const renew = (session: WebSession): WebSession | null => {
    if (!TOKEN_RE.test(session.token)) return null;
    const hash = hashTokenBlob(session.token);
    const now = clock.nowMs();
    return db.tx(() => {
      // Re-read inside the transaction: the row is the authority, not the argument.
      const row = db.one<WebSessionRow>(
        'SELECT token_hash, did, created_at_ms, expires_at_ms, last_seen_ms FROM web_sessions WHERE token_hash = ?',
        hash,
      );
      if (row === null || row.expires_at_ms <= now) return null;
      const termStart = row.expires_at_ms - SESSION_TTL_MS;
      let expiresAtMs = row.expires_at_ms;
      let lastSeenMs = row.last_seen_ms;
      let renewCookie: string | null = null;
      if (now - termStart > SESSION_RENEW_AFTER_MS) {
        expiresAtMs = now + SESSION_TTL_MS;
        lastSeenMs = now;
        db.run(
          'UPDATE web_sessions SET expires_at_ms = ?, last_seen_ms = ? WHERE token_hash = ?',
          expiresAtMs,
          now,
          hash,
        );
        renewCookie = sessionCookie(session.token);
      }
      return {
        did: row.did,
        token: session.token,
        tokenHash: blobHex(row.token_hash),
        createdAtMs: row.created_at_ms,
        expiresAtMs,
        lastSeenMs,
        renewCookie,
      };
    });
  };

  const resolve = (token: string | null): WebSession | null => {
    const found = lookup(token);
    return found === null ? null : renew(found);
  };

  return {
    create(did) {
      // The same DID the revocation journal will accept on logout (isDid is
      // contained in its rule), so no stored session is unrevocable.
      if (typeof did !== 'string' || !isDid(did)) throw new TypeError('create() needs a DID');
      const token = newSessionToken(random);
      const now = clock.nowMs();
      const expiresAtMs = now + SESSION_TTL_MS;
      const hash = hashTokenBlob(token);
      db.run(
        'INSERT INTO web_sessions (token_hash, did, created_at_ms, expires_at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)',
        hash,
        did,
        now,
        expiresAtMs,
        now,
      );
      return { did, token, tokenHash: blobHex(hash), createdAtMs: now, expiresAtMs, setCookie: sessionCookie(token) };
    },

    resolve,

    resolveCookieHeader(cookieHeader) {
      return resolve(sessionTokenFromCookies(cookieHeader));
    },

    lookup,

    lookupCookieHeader(cookieHeader) {
      return lookup(sessionTokenFromCookies(cookieHeader));
    },

    renew,

    logout(token) {
      if (!TOKEN_RE.test(token)) return false;
      const hash = hashTokenBlob(token);
      return db.tx(() => {
        const row = db.one<{ did: string }>('SELECT did FROM web_sessions WHERE token_hash = ?', hash);
        if (row === null) return false;
        // Journal first: a failed append throws and rolls this transaction back.
        revocations.record({ kind: 'web_session', hash: blobHex(hash), did: row.did });
        db.run('DELETE FROM web_sessions WHERE token_hash = ?', hash);
        return true;
      });
    },

    logoutAll(did) {
      return db.tx(() => {
        const rows = db.all<{ token_hash: ArrayBuffer }>(
          'SELECT token_hash FROM web_sessions WHERE did = ? ORDER BY created_at_ms, token_hash',
          did,
        );
        for (const row of rows) revocations.record({ kind: 'web_session', hash: blobHex(row.token_hash), did });
        if (rows.length > 0) db.run('DELETE FROM web_sessions WHERE did = ?', did);
        return rows.length;
      });
    },
  };
}

/**
 * Delete web sessions that expired at or before `nowMs` (the expiry-sweep,
 * ADR §3.3). Expiry is not a revocation, so nothing is journaled. Returns how
 * many rows were deleted.
 */
export function sweepExpiredWebSessions(db: Db, nowMs: number, limit = 1000): number {
  return db.all<{ one: number }>(
    `DELETE FROM web_sessions WHERE token_hash IN
       (SELECT token_hash FROM web_sessions WHERE expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?)
     RETURNING 1 AS one`,
    nowMs,
    limit,
  ).length;
}
