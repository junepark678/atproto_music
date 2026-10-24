// Request ids: an RFC 9562 version 4 UUID drawn from the injected Random
// (ADR 0004 §4.4, §10.2), like the Rust `Uuid::new_v4()` request-id middleware.
// Production passes cryptoRandom; tests pass a seeded Random.

import type { Random } from '@atmusic/core/deps';

/** Lowercase, hyphenated UUID text, the form the OpenAPI `Uuid` schema accepts. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newRequestId(random: Random): string {
  const bytes = random.bytes(16);
  if (bytes.length !== 16) throw new RangeError('Random.bytes(16) must return 16 bytes');
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 9562 variant
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
