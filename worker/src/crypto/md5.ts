// MD5 for Last.fm request signatures (ADR 0005 §7.4; N1-08).
//
// Last.fm's api_sig is md5(sorted name+value pairs + secret) rendered in hex.
// WebCrypto has no MD5, so this uses node:crypto (OpenSSL). MD5 is used only
// for this compatibility signature: it never protects a credential at rest
// (those are SHA-256, crypto/tokens.ts) and has no bearing on atproto
// signature, CID, MST or identity verification.

import { createHash } from 'node:crypto';

/** Lowercase hex MD5 of `input`; a string is hashed as its UTF-8 bytes. */
export function md5Hex(input: string | Uint8Array): string {
  return createHash('md5').update(input).digest('hex');
}
