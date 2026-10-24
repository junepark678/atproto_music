// Authenticated pagination cursors (ADR 0004 §4.3, §5 read path, docs/cursors.md).
// A port of crates/core/src/cursor.rs: tokens, key derivation, validation
// limits and verdicts equal the Rust oracle, so tests/goldens/cursors.json
// tokens decode here and tokens encoded here are byte-identical to Rust's.
//
// - The signing key is HMAC-SHA256(applicationKey, "atmusic:cursor:hmac-sha256:v1"),
//   imported as a non-extractable WebCrypto HMAC key. Application keys need at
//   least 32 bytes.
// - The token is `base64url(JSON).base64url(HMAC-SHA256(key, JSON))`, without
//   padding. The JSON is serde_json's rendering of the Rust CursorPayload:
//   `{"version":1,"binding":{"query","did","scope","viewer"},"upper":{"timestamp","uri"},
//   "last":{…},"asOf"}`, with absent binding fields written as `null`.
// - Decoding checks sizes and strict base64url (no padding, no non-zero trailing
//   bits, as the base64 crate's URL_SAFE_NO_PAD), then verifies the HMAC with
//   `crypto.subtle.verify` (constant time) before it reads any JSON. Only then
//   does it parse the payload with serde_json's grammar and the derived
//   Deserialize rules (deny_unknown_fields, duplicate fields rejected, Option
//   fields may be omitted, struct sequence form and the enum map form accepted),
//   check version 1 and the exact binding, and re-validate the tuples.
// - Every failure is one InvalidCursorError (an ApiError with code
//   `invalid_cursor`, HTTP 400). A short application key is a CursorKeyError.
// - Timestamps are parsed as chrono's `DateTime::parse_from_rfc3339` (the cursor
//   oracle uses it directly, not the AT-datetime validator): `T`, `t` or space
//   separator, `Z`/`z` or a zero offset (`+00:00`, U+2212 `−00:00`, never
//   `-00:00`), any number of fraction digits (truncated after nine), leap second
//   `:60`, at most 64 bytes, years 1970..9999. They are stored in chrono's
//   `SecondsFormat::Nanos` form `YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ`, so comparing
//   the canonical strings orders instants exactly as chrono does.
// - URIs compare by code point (Rust `String` byte order), not UTF-16 units.
//
// Uses only ES2024 and WebCrypto, so it runs in workerd and the browser.

import { ApiError } from './errors';
import { isDid } from './syntax';

export const CURSOR_VERSION = 1;
export const CURSOR_KEY_CONTEXT = 'atmusic:cursor:hmac-sha256:v1';
export const MIN_APPLICATION_KEY_BYTES = 32;
export const MAX_TOKEN_BYTES = 32_768;
export const MAX_PAYLOAD_BYTES = 16_384;
export const MAX_FIELD_BYTES = 4_096;
const MAX_TIMESTAMP_BYTES = 64;
/** U+2212, which chrono accepts as an offset sign (`allow_tz_minus_sign`). */
const MINUS_SIGN = String.fromCharCode(0x2212);
const SIGNATURE_BYTES = 32;

/** The Rust `CursorError::InvalidKey` Display text. */
export const MSG_INVALID_KEY = 'cursor application key must contain at least 32 bytes';

/** The one public cursor failure, independent of cause. Routes serve it as 400 `invalid_cursor`. */
export class InvalidCursorError extends ApiError {
  constructor() {
    super('invalid_cursor', 'invalid_cursor');
    this.name = 'InvalidCursorError';
  }
}

/** The application key is too short (a deployment error, never a request error). */
export class CursorKeyError extends Error {
  readonly code = 'invalid_key';
  constructor(message = MSG_INVALID_KEY) {
    super(message);
    this.name = 'CursorKeyError';
  }
}

export type CursorQuery = 'history' | 'feed' | 'following' | 'followers';

const QUERIES: ReadonlySet<string> = new Set<CursorQuery>(['history', 'feed', 'following', 'followers']);

/** Identity and route context authenticated with every page boundary. */
export interface CursorBinding {
  readonly query: CursorQuery;
  readonly did: string | null;
  readonly scope: string | null;
  readonly viewer: string | null;
}

/** Input form of a binding: absent fields mean `null` (serde `Option::None`). */
export interface CursorBindingInput {
  readonly query: CursorQuery;
  readonly did?: string | null;
  readonly scope?: string | null;
  readonly viewer?: string | null;
}

/** An ordering timestamp plus the full AT URI, compared in that order. */
export interface CursorPosition {
  readonly timestamp: string;
  readonly uri: string;
}

/**
 * A traversal: the first page's upper tuple and `asOf` are retained; later
 * pages contain current rows at or below `upper` and strictly below `last`.
 */
export interface PageCursor {
  readonly binding: CursorBinding;
  readonly upper: CursorPosition;
  readonly last: CursorPosition;
  readonly asOf: string;
}

function invalid(): never {
  throw new InvalidCursorError();
}

function binding(query: CursorQuery, did: string | null, scope: string | null, viewer: string | null): CursorBinding {
  return Object.freeze({ query, did, scope, viewer });
}

/** The Rust `CursorBinding` constructors. */
export const cursorBindings = {
  history: (did: string): CursorBinding => binding('history', did, null, null),
  globalFeed: (): CursorBinding => binding('feed', null, 'global', null),
  followingFeed: (viewer: string): CursorBinding => binding('feed', null, 'following', viewer),
  following: (did: string): CursorBinding => binding('following', did, null, null),
  followers: (did: string): CursorBinding => binding('followers', did, null, null),
} as const;

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalid();
  return value;
}

/** `CursorBinding::validate`, after normalizing absent fields to `null`. */
function validBinding(input: CursorBindingInput): CursorBinding {
  if (typeof input !== 'object' || input === null) invalid();
  const query = input.query;
  if (typeof query !== 'string' || !QUERIES.has(query)) invalid();
  const did = optionalString(input.did);
  const scope = optionalString(input.scope);
  const viewer = optionalString(input.viewer);
  const validDid = (value: string | null) => value !== null && isDid(value);
  const valid =
    query === 'feed'
      ? did === null && ((scope === 'global' && viewer === null) || (scope === 'following' && validDid(viewer)))
      : validDid(did) && scope === null && viewer === null;
  if (!valid) invalid();
  return binding(query, did, scope, viewer);
}

function sameBinding(a: CursorBinding, b: CursorBinding): boolean {
  return a.query === b.query && a.did === b.did && a.scope === b.scope && a.viewer === b.viewer;
}

// ---------------------------------------------------------------------------
// Timestamps: chrono parse_from_rfc3339 + the cursor.rs restrictions.
// ---------------------------------------------------------------------------

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * The canonical `SecondsFormat::Nanos` rendering of a cursor timestamp, or null
 * when cursor.rs `parse_timestamp` rejects it.
 */
export function canonicalCursorTimestamp(value: string): string | null {
  if (typeof value !== 'string' || utf8Length(value) > MAX_TIMESTAMP_BYTES || value.endsWith('-00:00')) {
    return null;
  }
  let i = 0;
  const isDigit = (at: number) => {
    const c = value.charCodeAt(at);
    return c >= 0x30 && c <= 0x39;
  };
  const digits = (count: number): number | null => {
    let n = 0;
    for (let k = 0; k < count; k++) {
      if (!isDigit(i + k)) return null;
      n = n * 10 + (value.charCodeAt(i + k) - 0x30);
    }
    i += count;
    return n;
  };
  const char = (expected: string): boolean => {
    if (value[i] !== expected) return false;
    i += 1;
    return true;
  };

  const year = digits(4);
  if (year === null || !char('-')) return null;
  const month = digits(2);
  if (month === null || !char('-')) return null;
  const day = digits(2);
  if (day === null) return null;
  const separator = value[i];
  if (separator !== 'T' && separator !== 't' && separator !== ' ') return null;
  i += 1;
  const hour = digits(2);
  if (hour === null || !char(':')) return null;
  const minute = digits(2);
  if (minute === null || !char(':')) return null;
  const second = digits(2);
  if (second === null) return null;

  let nanos = 0;
  if (value[i] === '.') {
    i += 1;
    const start = i;
    while (isDigit(i)) i += 1;
    if (i === start) return null;
    // chrono keeps the first nine digits and skips the rest.
    nanos = Number(value.slice(start, Math.min(i, start + 9)).padEnd(9, '0'));
  }

  // chrono scan::timezone_offset(colon required, Z allowed, minutes required, U+2212 allowed).
  let offsetSeconds: number;
  const sign = value[i];
  if (sign === 'Z' || sign === 'z') {
    i += 1;
    offsetSeconds = 0;
  } else if (sign === '+' || sign === '-' || sign === MINUS_SIGN) {
    i += 1;
    const offsetHours = digits(2);
    if (offsetHours === null || !char(':')) return null;
    const m1 = value.charCodeAt(i);
    if (!(m1 >= 0x30 && m1 <= 0x35) || !isDigit(i + 1)) return null;
    const offsetMinutes = (m1 - 0x30) * 10 + (value.charCodeAt(i + 1) - 0x30);
    i += 2;
    const magnitude = offsetHours * 3600 + offsetMinutes * 60;
    if (magnitude > (23 * 60 + 59) * 60) return null;
    offsetSeconds = sign === '+' ? magnitude : -magnitude;
  } else {
    return null;
  }
  if (i !== value.length) return null;

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  if (day > daysInMonth(year, month)) return null;
  // cursor.rs: UTC only, years 1970..=9999.
  if (offsetSeconds !== 0 || year < 1970 || year > 9999) return null;

  // With a zero offset chrono renders the parsed fields unchanged (a leap
  // second stays `:60`). Fixed width makes string order equal chrono order.
  const two = (n: number) => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}:${two(second)}.${String(nanos).padStart(9, '0')}Z`;
}

function timestampOrInvalid(value: string): string {
  return canonicalCursorTimestamp(value) ?? invalid();
}

/** cursor.rs `valid_field`: non-empty, ≤ 4096 UTF-8 bytes, no whitespace or control characters. */
function validField(value: string): boolean {
  return (
    value.length > 0 &&
    value.isWellFormed() &&
    utf8Length(value) <= MAX_FIELD_BYTES &&
    !/[\p{White_Space}\p{Cc}]/u.test(value)
  );
}

function validPosition(position: CursorPosition): CursorPosition {
  if (typeof position !== 'object' || position === null) invalid();
  const { timestamp, uri } = position;
  if (typeof timestamp !== 'string' || typeof uri !== 'string') invalid();
  const canonical = timestampOrInvalid(timestamp);
  if (!uri.startsWith('at://') || !validField(uri)) invalid();
  return Object.freeze({ timestamp: canonical, uri });
}

/** Rust `str` ordering: UTF-8 bytes, which is code point order. */
function compareCodePoints(a: string, b: string): -1 | 0 | 1 {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

function compareValid(a: CursorPosition, b: CursorPosition): -1 | 0 | 1 {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return compareCodePoints(a.uri, b.uri);
}

/** `CursorPosition::new`: validated, with the timestamp canonicalized. */
export function cursorPosition(timestamp: string, uri: string): CursorPosition {
  return validPosition({ timestamp, uri });
}

/**
 * `CursorPosition::compare`: ascending (instant, URI) order; read queries
 * reverse it for DESC. Both positions are validated; spellings of the same
 * instant compare equal.
 */
export function comparePositions(a: CursorPosition, b: CursorPosition): -1 | 0 | 1 {
  return compareValid(validPosition(a), validPosition(b));
}

/** `PageCursor::new`: validates the binding, both tuples (last ≤ upper) and asOf, then normalizes. */
export function pageCursor(
  bindingInput: CursorBindingInput,
  upper: CursorPosition,
  last: CursorPosition,
  asOf: string,
): PageCursor {
  const b = validBinding(bindingInput);
  if (typeof asOf !== 'string') invalid();
  const canonicalAsOf = timestampOrInvalid(asOf);
  const u = validPosition(upper);
  const l = validPosition(last);
  if (compareValid(l, u) > 0) invalid();
  return Object.freeze({ binding: b, upper: u, last: l, asOf: canonicalAsOf });
}

function validCursor(cursor: PageCursor): PageCursor {
  if (typeof cursor !== 'object' || cursor === null) invalid();
  return pageCursor(cursor.binding, cursor.upper, cursor.last, cursor.asOf);
}

/**
 * `PageCursor::contains`: the row is at or below the initial upper tuple and
 * strictly below the last returned tuple. Availability, deletion and query
 * membership stay storage predicates.
 */
export function cursorContains(cursor: PageCursor, position: CursorPosition): boolean {
  const c = validCursor(cursor);
  const p = validPosition(position);
  return compareValid(p, c.upper) <= 0 && compareValid(p, c.last) < 0;
}

/** `PageCursor::advance`: a new last tuple, keeping the anchor, binding and frozen asOf. */
export function advanceCursor(cursor: PageCursor, last: CursorPosition): PageCursor {
  if (!cursorContains(cursor, last)) invalid();
  return pageCursor(cursor.binding, cursor.upper, last, cursor.asOf);
}

/** The exact serde_json payload text that is signed (field order and `null`s as Rust). */
export function cursorPayloadJson(cursor: PageCursor): string {
  const c = validCursor(cursor);
  const s = JSON.stringify;
  const pos = (p: CursorPosition) => `{"timestamp":${s(p.timestamp)},"uri":${s(p.uri)}}`;
  const b = c.binding;
  return (
    `{"version":${CURSOR_VERSION},` +
    `"binding":{"query":${s(b.query)},"did":${s(b.did)},"scope":${s(b.scope)},"viewer":${s(b.viewer)}},` +
    `"upper":${pos(c.upper)},"last":${pos(c.last)},"asOf":${s(c.asOf)}}`
  );
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const HMAC_SHA256 = { name: 'HMAC', hash: 'SHA-256' } as const;

function toBytes(key: Uint8Array | ArrayBuffer): Uint8Array {
  if (key instanceof Uint8Array) return key;
  if (key instanceof ArrayBuffer) return new Uint8Array(key);
  throw new CursorKeyError();
}

/**
 * `CursorCodec::from_application_key`: the signing key is
 * HMAC-SHA256(applicationKey, CURSOR_KEY_CONTEXT). The derived bytes are only
 * held long enough to import them as a non-extractable key.
 */
export async function deriveCursorKey(applicationKey: Uint8Array | ArrayBuffer): Promise<CryptoKey> {
  const material = toBytes(applicationKey);
  if (material.length < MIN_APPLICATION_KEY_BYTES) throw new CursorKeyError();
  const appKey = await crypto.subtle.importKey('raw', material.slice(), HMAC_SHA256, false, ['sign']);
  const derived = new Uint8Array(await crypto.subtle.sign('HMAC', appKey, encoder.encode(CURSOR_KEY_CONTEXT)));
  try {
    return await crypto.subtle.importKey('raw', derived, HMAC_SHA256, false, ['sign', 'verify']);
  } finally {
    derived.fill(0);
  }
}

function assertCursorKey(key: CryptoKey): void {
  const algorithm = key?.algorithm as HmacKeyAlgorithm | undefined;
  if (algorithm?.name !== 'HMAC' || algorithm.hash?.name !== 'SHA-256') {
    throw new CursorKeyError('cursor key must be an HMAC SHA-256 CryptoKey from deriveCursorKey');
  }
}

// ---------------------------------------------------------------------------
// base64url without padding (base64 0.22 URL_SAFE_NO_PAD)
// ---------------------------------------------------------------------------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_VALUE = new Int8Array(128).fill(-1);
for (let k = 0; k < B64URL.length; k++) B64URL_VALUE[B64URL.charCodeAt(k)] = k;

function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let k = 0;
  for (; k + 3 <= bytes.length; k += 3) {
    const n = ((bytes[k] as number) << 16) | ((bytes[k + 1] as number) << 8) | (bytes[k + 2] as number);
    out += B64URL[n >>> 18]! + B64URL[(n >>> 12) & 63]! + B64URL[(n >>> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - k;
  if (rest === 1) {
    const n = (bytes[k] as number) << 16;
    out += B64URL[n >>> 18]! + B64URL[(n >>> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((bytes[k] as number) << 16) | ((bytes[k + 1] as number) << 8);
    out += B64URL[n >>> 18]! + B64URL[(n >>> 12) & 63]! + B64URL[(n >>> 6) & 63]!;
  }
  return out;
}

/** Strict decode: alphabet only, no padding, canonical trailing bits. Null on any violation. */
function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let buffer = 0;
  let o = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    const v = c < 128 ? (B64URL_VALUE[c] as number) : -1;
    if (v < 0) return null;
    buffer = ((buffer << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >>> bits) & 0xff;
    }
  }
  // Leftover bits (2 or 4) must be zero, as decode_allow_trailing_bits(false).
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

// ---------------------------------------------------------------------------
// serde_json-compatible, schema-directed payload parser
// ---------------------------------------------------------------------------

class Malformed extends Error {}

function malformed(): never {
  throw new Malformed();
}

class Reader {
  pos = 0;
  constructor(readonly text: string) {}

  ws(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos += 1;
      else return;
    }
  }

  peek(): string | undefined {
    this.ws();
    return this.text[this.pos];
  }

  expect(ch: string): void {
    if (this.peek() !== ch) malformed();
    this.pos += 1;
  }

  /** Consumes `ch` when it is next (after whitespace). */
  eat(ch: string): boolean {
    if (this.peek() !== ch) return false;
    this.pos += 1;
    return true;
  }

  literal(word: string): void {
    this.ws();
    if (!this.text.startsWith(word, this.pos)) malformed();
    this.pos += word.length;
  }

  hex4(): number {
    const h = this.text.slice(this.pos, this.pos + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(h)) malformed();
    this.pos += 4;
    return Number.parseInt(h, 16);
  }

  string(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (Number.isNaN(c) || c < 0x20) malformed();
      this.pos += 1;
      if (c === 0x22) return out;
      if (c !== 0x5c) {
        out += String.fromCharCode(c);
        continue;
      }
      const e = this.text[this.pos];
      this.pos += 1;
      switch (e) {
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const unit = this.hex4();
          if (unit >= 0xdc00 && unit <= 0xdfff) malformed();
          if (unit >= 0xd800 && unit <= 0xdbff) {
            // serde_json requires the low half of a pair to follow as an escape.
            if (this.text[this.pos] !== '\\' || this.text[this.pos + 1] !== 'u') malformed();
            this.pos += 2;
            const low = this.hex4();
            if (low < 0xdc00 || low > 0xdfff) malformed();
            out += String.fromCharCode(unit, low);
          } else {
            out += String.fromCharCode(unit);
          }
          break;
        }
        default:
          malformed();
      }
    }
  }

  /** A JSON number lexeme (RFC 8259 grammar, as serde_json). */
  number(): string {
    this.ws();
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.pos, this.pos + 512));
    if (m === null) malformed();
    // A digit directly after the match means a leading zero ("01") or an over-long lexeme.
    const next = this.text.charCodeAt(this.pos + m[0].length);
    if (next >= 0x30 && next <= 0x39) malformed();
    this.pos += m[0].length;
    return m[0];
  }

  nullableString(): string | null {
    if (this.peek() === 'n') {
      this.literal('null');
      return null;
    }
    return this.string();
  }
}

interface Field<T> {
  readonly name: string;
  /** serde `Option<T>`: may be omitted in the map form. */
  readonly optional: boolean;
  readonly parse: (r: Reader) => T;
}

/**
 * A serde-derived struct with `deny_unknown_fields`: either a JSON object
 * (unknown or duplicate keys rejected, omitted Option fields are null) or a JSON
 * array holding exactly every field in declaration order.
 */
function struct(r: Reader, fields: readonly Field<unknown>[]): unknown[] {
  const values: unknown[] = new Array(fields.length);
  const seen: boolean[] = new Array(fields.length).fill(false);
  if (r.eat('[')) {
    fields.forEach((field, k) => {
      if (k > 0) r.expect(',');
      if (r.peek() === ']') malformed();
      values[k] = field.parse(r);
      seen[k] = true;
    });
    r.expect(']');
    return values;
  }
  r.expect('{');
  if (!r.eat('}')) {
    do {
      r.ws();
      const key = r.string();
      const k = fields.findIndex((field) => field.name === key);
      if (k < 0 || seen[k]) malformed();
      r.expect(':');
      values[k] = (fields[k] as Field<unknown>).parse(r);
      seen[k] = true;
    } while (r.eat(','));
    r.expect('}');
  }
  fields.forEach((field, k) => {
    if (seen[k]) return;
    if (!field.optional) malformed();
    values[k] = null;
  });
  return values;
}

/** A unit-variant enum: `"history"`, or serde_json's map form `{"history":null}`. */
function parseQuery(r: Reader): CursorQuery {
  let name: string;
  if (r.eat('{')) {
    r.ws();
    name = r.string();
    r.expect(':');
    r.literal('null');
    r.expect('}');
  } else {
    name = r.string();
  }
  if (!QUERIES.has(name)) malformed();
  return name as CursorQuery;
}

const parseString = (r: Reader) => r.string();
const parseNullableString = (r: Reader) => r.nullableString();

const BINDING_FIELDS: readonly Field<unknown>[] = [
  { name: 'query', optional: false, parse: parseQuery },
  { name: 'did', optional: true, parse: parseNullableString },
  { name: 'scope', optional: true, parse: parseNullableString },
  { name: 'viewer', optional: true, parse: parseNullableString },
];

const POSITION_FIELDS: readonly Field<unknown>[] = [
  { name: 'timestamp', optional: false, parse: parseString },
  { name: 'uri', optional: false, parse: parseString },
];

function parseBinding(r: Reader): CursorBinding {
  const [query, did, scope, viewer] = struct(r, BINDING_FIELDS) as [
    CursorQuery,
    string | null,
    string | null,
    string | null,
  ];
  return { query, did, scope, viewer };
}

function parsePosition(r: Reader): CursorPosition {
  const [timestamp, uri] = struct(r, POSITION_FIELDS) as [string, string];
  return { timestamp, uri };
}

/** `version: u8`: any other number, or a non-number, fails; only `1` is supported. */
function parseVersion(r: Reader): number {
  const lexeme = r.number();
  if (lexeme !== '1') malformed();
  return CURSOR_VERSION;
}

const PAYLOAD_FIELDS: readonly Field<unknown>[] = [
  { name: 'version', optional: false, parse: parseVersion },
  { name: 'binding', optional: false, parse: parseBinding },
  { name: 'upper', optional: false, parse: parsePosition },
  { name: 'last', optional: false, parse: parsePosition },
  { name: 'asOf', optional: false, parse: parseString },
];

interface Payload {
  binding: CursorBinding;
  upper: CursorPosition;
  last: CursorPosition;
  asOf: string;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** `serde_json::from_slice::<CursorPayload>`, or null. */
function parsePayload(bytes: Uint8Array): Payload | null {
  let text: string;
  try {
    // serde_json::from_slice rejects invalid UTF-8; a BOM is kept so it fails as a syntax error.
    text = strictUtf8.decode(bytes);
  } catch {
    return null;
  }
  try {
    const r = new Reader(text);
    const [, b, upper, last, asOf] = struct(r, PAYLOAD_FIELDS) as [
      number,
      CursorBinding,
      CursorPosition,
      CursorPosition,
      string,
    ];
    r.ws();
    if (r.pos !== r.text.length) return null;
    return { binding: b, upper, last, asOf };
  } catch (error) {
    if (error instanceof Malformed) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/** `CursorCodec::encode`: normalizes, serializes as serde_json, signs. */
export async function encodeCursor(key: CryptoKey, cursor: PageCursor): Promise<string> {
  assertCursorKey(key);
  const payload = encoder.encode(cursorPayloadJson(cursor));
  if (payload.length > MAX_PAYLOAD_BYTES) invalid();
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
  return `${base64UrlEncode(payload)}.${base64UrlEncode(signature)}`;
}

/**
 * `CursorCodec::decode`: authenticate before decoding JSON, then enforce the
 * caller's route context. Every failure is InvalidCursorError; callers serve
 * 400 `invalid_cursor` and never restart the traversal.
 */
export async function decodeCursor(key: CryptoKey, token: string, expected: CursorBindingInput): Promise<PageCursor> {
  assertCursorKey(key);
  if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES || utf8Length(token) > MAX_TOKEN_BYTES) invalid();
  const expectedBinding = validBinding(expected);
  const dot = token.indexOf('.');
  if (dot < 0) invalid();
  const payload = base64UrlDecode(token.slice(0, dot));
  const signature = base64UrlDecode(token.slice(dot + 1));
  if (
    payload === null ||
    signature === null ||
    payload.length === 0 ||
    payload.length > MAX_PAYLOAD_BYTES ||
    signature.length !== SIGNATURE_BYTES
  ) {
    invalid();
  }
  // WebCrypto verify compares the MAC in constant time.
  if (!(await crypto.subtle.verify('HMAC', key, signature, payload))) invalid();

  const parsed = parsePayload(payload) ?? invalid();
  if (!sameBinding(parsed.binding, expectedBinding)) invalid();
  return pageCursor(parsed.binding, parsed.upper, parsed.last, parsed.asOf);
}
