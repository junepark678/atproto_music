// Bearer credentials we issue, and their at-rest hash (ADR 0005 §5.6, §7.3,
// §8.2, §13; N1-08).
//
// Every generator takes the injected Random (production passes cryptoRandom
// from @atmusic/core/deps; tests pass a seeded one), so no value here comes
// from Math.random or an implicit global source.
//
// | Credential                         | Format                     | Entropy  |
// |------------------------------------|----------------------------|----------|
// | web session token (cookie)         | 64 lowercase hex           | 256 bits |
// | OAuth login-binding cookie         | 64 lowercase hex           | 256 bits |
// | Last.fm desktop/web token          | 32 lowercase hex           | 128 bits |
// | Last.fm session key (`sk`)         | 32 lowercase hex           | 128 bits |
// | issued Last.fm api_key / secret    | 32 lowercase hex           | 128 bits |
// | ListenBrainz user token            | UUIDv4 (RFC 9562), lower   | 122 bits |
// | app password (getMobileSession)    | 24 base32 (RFC 4648, lower)| 120 bits |
//
// Our bearer credentials are stored only as hashToken() = SHA-256 of the
// token's UTF-8 bytes. They are high-entropy, so no slow hash is needed (ADR
// §7.3); verification compares digests with crypto/constant-time.ts.

import { createHash } from 'node:crypto';
import type { Random } from '@atmusic/core/deps';

/** Lowercase hex of `bytes`. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function randomBytes(random: Random, n: number): Uint8Array {
  const bytes = random.bytes(n);
  if (!(bytes instanceof Uint8Array) || bytes.length !== n) {
    throw new RangeError(`Random.bytes(${n}) returned ${bytes?.length ?? 'no'} bytes`);
  }
  return bytes;
}

/** 32 random bytes as 64 hex characters: the `__Host-atmusic_session` cookie value (ADR §5.6). */
export function newSessionToken(random: Random): string {
  return bytesToHex(randomBytes(random, 32));
}

/** 32 random bytes as 64 hex characters: the `__Host-atmusic_oauth` login-binding cookie (ADR §5.6). */
export function newOAuthBindingToken(random: Random): string {
  return bytesToHex(randomBytes(random, 32));
}

/** 16 random bytes as 32 hex characters, the Last.fm token / key shape (ADR §7.3). */
function hex32(random: Random): string {
  return bytesToHex(randomBytes(random, 16));
}

/** `auth.getToken` token: 32 hex characters (ADR §7.3). */
export function newLastfmToken(random: Random): string {
  return hex32(random);
}

/** Last.fm session key `sk`: 32 hex characters, 128 bits (ADR §7.3). */
export function newLastfmSessionKey(random: Random): string {
  return hex32(random);
}

/** Issued Last.fm `api_key`: 32 hex characters, the shape real Last.fm keys have. */
export function newLastfmApiKey(random: Random): string {
  return hex32(random);
}

/** Issued Last.fm shared secret: 32 hex characters, sealed at rest (crypto/box.ts, purpose lastfm-app). */
export function newLastfmSharedSecret(random: Random): string {
  return hex32(random);
}

/**
 * ListenBrainz user token: a version-4 UUID (RFC 9562 §5.4) with 122 random
 * bits, lowercase and hyphenated (ADR §8.2).
 */
export function newListenBrainzToken(random: Random): string {
  const b = Uint8Array.from(randomBytes(random, 16));
  b[6] = ((b[6] as number) & 0x0f) | 0x40; // version 4
  b[8] = ((b[8] as number) & 0x3f) | 0x80; // variant 10xx
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** RFC 4648 base32 alphabet, lowercase (easier to type on a phone; no padding is ever needed). */
export const APP_PASSWORD_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const APP_PASSWORD_LENGTH = 24;

/**
 * App password for `auth.getMobileSession`: 15 random bytes (120 bits) as 24
 * base32 characters, exactly 5 bits per character (ADR §7.3).
 */
export function newAppPassword(random: Random): string {
  const bytes = randomBytes(random, 15);
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += APP_PASSWORD_ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** SHA-256 of the token's UTF-8 bytes: the only form in which our bearer credentials are stored. */
export function hashToken(token: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
}

/** hashToken as 64 lowercase hex characters (the revocation journal's `hash`, ADR §14.5). */
export function hashTokenHex(token: string): string {
  return bytesToHex(hashToken(token));
}

/** hashToken as a standalone ArrayBuffer, the BLOB form the Db facade binds (worker/src/do/db.ts). */
export function hashTokenBlob(token: string): ArrayBuffer {
  return hashToken(token).slice().buffer;
}
