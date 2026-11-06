// Record keys allocated by the client (ADR 0004 §5.2): scrobble TIDs and the
// deterministic follow rkey.
//
// - `newTid` follows https://atproto.com/specs/tid: a 64-bit integer whose top
//   bit is 0, then 53 bits of microseconds since the Unix epoch, then a 10-bit
//   clock identifier, written as 13 characters of base32-sortable
//   (`234567abcdefghijklmnopqrstuvwxyz`). Time and randomness are injected.
// - `followRkey` ports crates/core/src/follow.rs `follow_rkey`: DID syntax is
//   checked first (validate_did_syntax), then 'f' + lowercase hex SHA-256 of the
//   exact subject bytes, with no normalisation. It must equal
//   tests/goldens/follow_rkeys.json.

import type { Clock, Random } from './deps';

const B32_SORTABLE = '234567abcdefghijklmnopqrstuvwxyz';
const TID_LENGTH = 13;
/** Spec TID syntax: 13 base32-sortable characters, the first restricted so the top bit is 0. */
export const TID_PATTERN = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

const MAX_MICROS = 2n ** 53n - 1n;
const CLOCK_ID_BITS = 10n;
const CLOCK_ID_MASK = 0x3ff;

interface TidState {
  lastMicros: bigint;
  clockId: number;
}

// Monotonicity is per Clock instance: the production systemClock is one object
// (so one sequence per page), and each test's fixedClock gets its own sequence.
const tidStates = new WeakMap<Clock, TidState>();

function encodeB32Sortable(value: bigint): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < TID_LENGTH; i++) {
    out = B32_SORTABLE[Number(rest & 31n)] + out;
    rest >>= 5n;
  }
  return out;
}

/**
 * A fresh spec TID. Strictly increasing for a given clock, even when the clock
 * stands still or moves backwards: the timestamp part is
 * max(clock µs, previous + 1). The clock id is drawn once per clock from `random`.
 */
export function newTid(clock: Clock, random: Random): string {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError(`clock.nowMs() must be a non-negative safe integer, got ${nowMs}`);
  }
  let state = tidStates.get(clock);
  if (state === undefined) {
    const b = random.bytes(2);
    state = { lastMicros: -1n, clockId: ((b[0] ?? 0) | ((b[1] ?? 0) << 8)) & CLOCK_ID_MASK };
    tidStates.set(clock, state);
  }
  const fromClock = BigInt(nowMs) * 1000n;
  const micros = fromClock > state.lastMicros ? fromClock : state.lastMicros + 1n;
  if (micros > MAX_MICROS) throw new RangeError('TID timestamp exceeds 53 bits');
  state.lastMicros = micros;
  return encodeB32Sortable((micros << CLOCK_ID_BITS) | BigInt(state.clockId));
}

export function isTid(value: string): boolean {
  return TID_PATTERN.test(value);
}

/** Decodes a TID into its timestamp (µs since epoch) and clock id; throws on bad syntax. */
export function parseTid(tid: string): { micros: bigint; clockId: number } {
  if (!isTid(tid)) throw new SyntaxError(`not a TID: ${JSON.stringify(tid)}`);
  let value = 0n;
  for (const ch of tid) value = (value << 5n) | BigInt(B32_SORTABLE.indexOf(ch));
  return { micros: value >> CLOCK_ID_BITS, clockId: Number(value & BigInt(CLOCK_ID_MASK)) };
}

/** Field error with the shape of the Rust ValidationError JSON (`{code, field, message}`). */
export class RecordKeyError extends Error {
  readonly code = 'invalid_field' as const;
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'RecordKeyError';
  }
  toJSON(): { code: 'invalid_field'; field: string; message: string } {
    return { code: this.code, field: this.field, message: this.message };
  }
}

const isAsciiLower = (c: number) => c >= 0x61 && c <= 0x7a;
const isAsciiDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAsciiAlnum = (c: number) => isAsciiDigit(c) || isAsciiLower(c) || (c >= 0x41 && c <= 0x5a);
const isAsciiHex = (c: number) => isAsciiDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);

/**
 * Exact port of crates/core/src/follow.rs `validate_did_syntax`: `did:` +
 * lowercase method + identifier of `[A-Za-z0-9._:-]` or `%XX`, not ending in
 * ':', at most 2,048 bytes. No trimming or case folding.
 */
export function isDidSyntax(subject: string): boolean {
  // Any non-ASCII code unit is rejected below, so UTF-16 length = UTF-8 length here.
  if (subject.length > 2_048 || !subject.startsWith('did:')) return false;
  const rest = subject.slice(4);
  const colon = rest.indexOf(':');
  if (colon < 0) return false;
  const method = rest.slice(0, colon);
  const identifier = rest.slice(colon + 1);
  if (method.length === 0 || identifier.length === 0) return false;
  for (let i = 0; i < method.length; i++) if (!isAsciiLower(method.charCodeAt(i))) return false;
  let i = 0;
  while (i < identifier.length) {
    const c = identifier.charCodeAt(i);
    if (c === 0x25 /* % */) {
      // charCodeAt past the end is NaN, which is not hex: a truncated escape fails.
      const h1 = identifier.charCodeAt(i + 1);
      const h2 = identifier.charCodeAt(i + 2);
      if (!isAsciiHex(h1) || !isAsciiHex(h2)) return false;
      i += 3;
    } else if (isAsciiAlnum(c) || c === 0x2e || c === 0x5f || c === 0x2d || c === 0x3a) {
      i += 1;
    } else {
      return false;
    }
  }
  return identifier.charCodeAt(identifier.length - 1) !== 0x3a;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b];
  return out;
}

/** Lowercase hex SHA-256 through WebCrypto (workerd and the browser). */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  // Copy a caller view so a SharedArrayBuffer-backed or offset view digests exactly its bytes.
  const bytes: Uint8Array<ArrayBuffer> =
    typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/**
 * The deterministic follow rkey: 'f' + lowercase hex SHA-256 of the exact
 * subject DID. Throws RecordKeyError('subject', 'expected a DID') for anything
 * that is not DID syntax.
 */
export async function followRkey(subjectDid: string): Promise<string> {
  if (typeof subjectDid !== 'string' || !isDidSyntax(subjectDid)) {
    throw new RecordKeyError('subject', 'expected a DID');
  }
  return `f${await sha256Hex(subjectDid)}`;
}
