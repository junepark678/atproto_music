// Portable constant-time comparison of digests and other fixed-length secrets
// (ADR 0005 §7.3, §7.4, §13; N1-08).
//
// Used for SHA-256 credential hashes, the Last.fm api_sig (after the caller
// lowercases both sides), the CSRF HMAC and the admin socket. It is plain
// JavaScript over bytes so that host-neutral modules can use it without
// node:crypto's timingSafeEqual, which throws on a length mismatch instead of
// answering false.
//
// The running time depends only on the lengths of the inputs, never on where
// the first differing byte is. A length mismatch returns false at once: every
// caller compares values whose length is public (a 32-byte digest, a
// 32-character signature), so the length is not a secret.

export type DigestLike = Uint8Array | ArrayBuffer | string;

const encoder = new TextEncoder();

/** Bytes of a digest-like value. A string is taken as its UTF-8 bytes, never decoded as hex. */
function bytesOf(value: DigestLike): Uint8Array {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('constantTimeEqual compares Uint8Array, ArrayBuffer or string values only');
}

/**
 * True exactly when `a` and `b` hold the same bytes. Different lengths are
 * false. Two strings compare by their UTF-8 bytes, so `'ABC'` and `'abc'`
 * differ: normalise case before calling when the format is case-insensitive.
 */
export function constantTimeEqual(a: DigestLike, b: DigestLike): boolean {
  const x = bytesOf(a);
  const y = bytesOf(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}
