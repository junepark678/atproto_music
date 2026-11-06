// CSRF protection for cookie-authenticated unsafe requests (ADR 0005 §5.6,
// §13; N2-04), ported from the Rust oracle crates/server/src/auth/csrf.rs.
//
// A cookie request with an unsafe method passes only when both hold:
//
// - **Exactly one `Origin` header, equal to PUBLIC_ORIGIN.** A Fetch `Headers`
//   object joins repeated headers with ", " (the Node bridge appends every raw
//   header, worker/src/node/http-bridge.ts), and a serialised origin never
//   contains a comma, so a comma in the value means the header was repeated.
//   `Origin: null`, an empty value, another scheme, host or port all fail. The
//   configured origin is compared without a trailing slash, as in Rust.
// - **`X-CSRF-Token` = hex(HMAC-SHA256(csrfKey, "atmusic.csrf.v1\0" ‖ sessionToken)).**
//   The key is the HKDF-derived CSRF key (salt `atmusic/csrf/v1`, info `hmac`,
//   worker/src/crypto/box.ts `csrfKey()`), the label is byte-identical to the
//   Rust `b"atmusic.csrf.v1\0"`, and the session token is the raw cookie value.
//   The supplied value must be exactly one header of 64 hex digits (either
//   case, like Rust's `hex::decode`); the digests are compared in constant
//   time (crypto/constant-time.ts).
//
// `checkOrigin` alone serves `POST /api/v1/auth/start`, which runs before any
// session exists (login CSRF, §5.6). Every failure is reported with a reason
// for logs and tests; the HTTP answer is always 403 `csrf_failed` (guard.ts).

import { createHmac } from 'node:crypto';
import { constantTimeEqual } from '../crypto/constant-time';

/** The domain-separation label, NUL included (crates/server/src/auth/csrf.rs). */
export const CSRF_LABEL = 'atmusic.csrf.v1\0';
export const CSRF_HEADER = 'x-csrf-token';
/** 32-byte HMAC-SHA256 as lowercase hex. */
export const CSRF_TOKEN_HEX_LENGTH = 64;

export type CsrfFailureReason =
  | 'origin_missing'
  | 'origin_duplicate'
  | 'origin_mismatch'
  | 'token_missing'
  | 'token_duplicate'
  | 'token_malformed'
  | 'token_mismatch';

export type CsrfCheck = { ok: true } | { ok: false; reason: CsrfFailureReason };

const HEX_64 = /^[0-9a-fA-F]{64}$/;

function rawKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new RangeError('the CSRF key must be 32 bytes (crypto/box.ts csrfKey())');
  }
  return key;
}

function mac(key: Uint8Array, sessionToken: string): Buffer {
  return createHmac('sha256', rawKey(key)).update(CSRF_LABEL, 'utf8').update(sessionToken, 'utf8').digest();
}

/** The X-CSRF-Token of a session: 64 lowercase hex characters. */
export function csrfToken(key: Uint8Array, sessionToken: string): string {
  return mac(key, sessionToken).toString('hex');
}

/** The configured origin as the Rust check compares it: no trailing slash. */
function expectedOrigin(publicOrigin: string): string {
  return publicOrigin.replace(/\/+$/, '');
}

/** Exactly one `Origin`, equal to `publicOrigin`. */
export function checkOrigin(headers: Headers, publicOrigin: string): CsrfCheck {
  const origin = headers.get('origin');
  if (origin === null || origin === '') return { ok: false, reason: 'origin_missing' };
  if (origin.includes(',')) return { ok: false, reason: 'origin_duplicate' };
  if (origin !== expectedOrigin(publicOrigin)) return { ok: false, reason: 'origin_mismatch' };
  return { ok: true };
}

export interface CsrfInput {
  publicOrigin: string;
  /** The 32-byte CSRF HMAC key. */
  key: Uint8Array;
  /** The raw session cookie value the request authenticated with. */
  sessionToken: string;
}

/** The full check for an unsafe cookie request: the Origin rule, then the HMAC token. */
export function checkCsrf(headers: Headers, input: CsrfInput): CsrfCheck {
  const origin = checkOrigin(headers, input.publicOrigin);
  if (!origin.ok) return origin;
  const supplied = headers.get(CSRF_HEADER);
  if (supplied === null || supplied === '') return { ok: false, reason: 'token_missing' };
  if (supplied.includes(',')) return { ok: false, reason: 'token_duplicate' };
  if (!HEX_64.test(supplied)) return { ok: false, reason: 'token_malformed' };
  const expected = mac(input.key, input.sessionToken);
  if (!constantTimeEqual(Buffer.from(supplied, 'hex'), expected)) return { ok: false, reason: 'token_mismatch' };
  return { ok: true };
}
