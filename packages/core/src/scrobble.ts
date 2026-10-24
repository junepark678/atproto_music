// Schema-v1 scrobble validation, ported from crates/core/src/scrobble.rs. Every
// verdict, field and message equals tests/goldens/validation.json.
//
// - Display strings (artist, track, album) allow 1–256 Unicode scalars and at
//   most 1,024 UTF-8 bytes, counted on the raw value; the trimmed value must be
//   nonempty. Trimming uses the Unicode White_Space property (Rust `str::trim`),
//   never JS `trim()` or `\s`: U+0085 is trimmed, U+FEFF / U+200B / U+180E are not.
// - Lone surrogates are rejected. Rust's JSON decoder refuses such documents
//   outright (`parseLexiconJson` does the same); the validators also reject
//   them in every field they read, for values that never went through JSON.
// - Timestamps: see timestamp.ts (+300 s / 1970 bounds against receipt time).
// - Remote records (`validateScrobbleRecord`) are open lexicon objects: unknown
//   fields are ignored and the remote spelling is kept. Local SPA input
//   (`buildScrobbleRecord`) is closed: every unknown field is rejected by name,
//   display strings are trimmed and the MBID is lowercased.

import type { Clock } from './deps';
import { collectionsFor, isValidPrefix } from './namespace';
import { nowNs, toRecordDatetime, toStorage, validateTimestamp } from './timestamp';

export interface ValidationFailure {
  field: string;
  code: 'invalid_field';
  message: string;
}

export type Validation<T> = { ok: true; row: T } | { ok: false; reason: ValidationFailure };
export type Build<T> = { ok: true; record: T } | { ok: false; reason: ValidationFailure };

/** The schema-v1 scrobble record (known fields only). */
export interface ScrobbleRecord {
  $type: string;
  artist: string;
  track: string;
  listenedAt: string;
  createdAt: string;
  album?: string;
  durationSeconds?: number;
  recordingMbid?: string;
}

/** A validated remote scrobble, shaped for the `scrobbles` table. */
export interface ScrobbleRow {
  /** The validated record: known fields only, remote spelling kept. */
  record: ScrobbleRecord;
  artist: string;
  track: string;
  album: string | null;
  /** 30-character storage form. */
  listenedAt: string;
  listenedAtNs: bigint;
  /** 30-character storage form. */
  createdAt: string;
  createdAtNs: bigint;
  durationSeconds: number | null;
  recordingMbid: string | null;
}

/** Local scrobble form input accepted by `buildScrobbleRecord`. */
export interface ScrobbleInput {
  artist: string;
  track: string;
  listenedAt: string;
  album?: string;
  durationSeconds?: number;
  recordingMbid?: string;
}

export const MAX_DISPLAY_SCALARS = 256;
export const MAX_DISPLAY_BYTES = 1024;
export const MIN_DURATION_SECONDS = 1;
export const MAX_DURATION_SECONDS = 86_400;

export const MSG_NOT_OBJECT = 'expected a JSON object';
export const MSG_UNKNOWN_FIELD = 'unknown field';
export const MSG_REQUIRED_STRING = 'required string field';
export const MSG_OPTIONAL_STRING = 'expected a string or omitted field';
export const MSG_DISPLAY = 'expected 1–256 Unicode scalars and at most 1024 UTF-8 bytes, with nonempty trimmed text';
export const MSG_DURATION = 'expected an integer between 1 and 86400';
export const MSG_UUID = 'expected a UUID';
export const MSG_HYPHENATED_UUID = 'expected a hyphenated UUID';
export const MSG_SCROBBLE_TYPE = 'record type does not match the configured scrobble collection';
/** No Rust string can hold a lone surrogate, so this message has no oracle counterpart. */
export const MSG_LONE_SURROGATE = 'expected well-formed Unicode text without lone surrogates';

const INPUT_FIELDS: readonly string[] = ['artist', 'track', 'listenedAt', 'album', 'durationSeconds', 'recordingMbid'];

// ---------------------------------------------------------------------------
// Unicode helpers

/** The Unicode White_Space property (PropList.txt), which Rust `char::is_whitespace` uses. */
export function isWhiteSpace(codePoint: number): boolean {
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    codePoint === 0x20 ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

/** Rust `str::trim`: strip leading and trailing White_Space code points. */
export function trimWhiteSpace(value: string): string {
  let start = 0;
  let end = value.length;
  // Every White_Space code point is in the BMP, so code units suffice.
  while (start < end && isWhiteSpace(value.charCodeAt(start))) start++;
  while (end > start && isWhiteSpace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

export function isWellFormed(value: string): boolean {
  return value.isWellFormed();
}

function scalarCount(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

// ---------------------------------------------------------------------------
// Lexicon JSON decoding

/**
 * A JSON number written with a fraction or exponent (`60.0`, `1e3`). Lexicon
 * integers are integer-typed, so such a number never satisfies one, exactly as
 * Rust `Value::as_u64` refuses an f64 even when it is integral.
 */
export class JsonFloat {
  constructor(readonly value: number) {
    Object.freeze(this);
  }
}

export type LexiconJson = { ok: true; value: unknown } | { ok: false; message: string };

interface ReviverContext {
  source?: string;
}

/**
 * Strict JSON decoding for record bodies supplied as JSON text. It mirrors the
 * serde_json decoder the oracle uses: a lone surrogate in any string or key
 * rejects the whole document, and float-spelled numbers become `JsonFloat`.
 */
export function parseLexiconJson(text: string): LexiconJson {
  let surrogate = false;
  let value: unknown;
  try {
    value = JSON.parse(text, function (this: unknown, key: string, v: unknown, context?: ReviverContext) {
      if (!key.isWellFormed()) surrogate = true;
      if (typeof v === 'string' && !v.isWellFormed()) surrogate = true;
      if (typeof v === 'number') {
        const source = context?.source;
        if (source === undefined) throw new Error('JSON.parse source text access is unavailable');
        if (/[.eE]/.test(source)) return new JsonFloat(v);
      }
      return v;
    });
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, message: 'invalid JSON' };
    throw error;
  }
  if (surrogate) return { ok: false, message: 'lone surrogates are not representable' };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Field access (shared with follow.ts and settings.ts)

export type JsonObject = Record<string, unknown>;

export function fail(field: string, message: string): { ok: false; reason: ValidationFailure } {
  return { ok: false, reason: { field, code: 'invalid_field', message } };
}

/** A plain JSON object (not an array, null or a class instance such as JsonFloat). */
export function recordObject(value: unknown): JsonObject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? (value as JsonObject) : null;
}

/** Code-point order, the order Rust's BTreeMap<String, _> iterates keys in. */
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx - cy;
  }
}

/** The first field outside `allowed`, in the oracle's (sorted) key order. */
export function firstUnknownField(object: JsonObject, allowed: readonly string[]): string | null {
  const unknown = Object.keys(object)
    .filter((k) => object[k] !== undefined && !allowed.includes(k))
    .sort(compareCodePoints);
  return unknown[0] ?? null;
}

type Field<T> = { ok: true; value: T } | { ok: false; reason: ValidationFailure };

/** Present and JSON-representable: an own property whose value is not `undefined` (JSON omits those). */
function has(object: JsonObject, field: string): boolean {
  return Object.hasOwn(object, field) && object[field] !== undefined;
}

export function requiredString(object: JsonObject, field: string): Field<string> {
  const value = has(object, field) ? object[field] : undefined;
  if (typeof value !== 'string') return fail(field, MSG_REQUIRED_STRING);
  if (!isWellFormed(value)) return fail(field, MSG_LONE_SURROGATE);
  return { ok: true, value };
}

function optionalString(object: JsonObject, field: string): Field<string | undefined> {
  if (!has(object, field)) return { ok: true, value: undefined };
  const value = object[field];
  if (typeof value !== 'string') return fail(field, MSG_OPTIONAL_STRING);
  if (!isWellFormed(value)) return fail(field, MSG_LONE_SURROGATE);
  return { ok: true, value };
}

/** validate_display_string: raw bounds, then nonempty trimmed text; returns the trimmed value. */
export function validateDisplayString(field: string, value: string): Field<string> {
  if (!isWellFormed(value)) return fail(field, MSG_LONE_SURROGATE);
  const trimmed = trimWhiteSpace(value);
  if (trimmed === '' || scalarCount(value) > MAX_DISPLAY_SCALARS || utf8Length(value) > MAX_DISPLAY_BYTES) {
    return fail(field, MSG_DISPLAY);
  }
  return { ok: true, value: trimmed };
}

const HEX = /^[0-9A-Fa-f]+$/;

function isHyphenatedUuid(value: string): boolean {
  if (value.length !== 36) return false;
  for (const at of [8, 13, 18, 23]) if (value[at] !== '-') return false;
  return HEX.test(value.slice(0, 8) + value.slice(9, 13) + value.slice(14, 18) + value.slice(19, 23) + value.slice(24));
}

/**
 * `Uuid::parse_str` accepts simple (32 hex), hyphenated, `{hyphenated}` and
 * `urn:uuid:hyphenated`; the oracle then requires the hyphenated spelling.
 * Returns the lowercase hyphenated UUID.
 */
export function validateMbid(field: string, value: string): Field<string> {
  const bytes = utf8Length(value);
  let parses = false;
  if (bytes === 32) parses = HEX.test(value);
  else if (bytes === 36) parses = isHyphenatedUuid(value);
  else if (bytes === 38) parses = value.startsWith('{') && value.endsWith('}') && isHyphenatedUuid(value.slice(1, -1));
  else if (bytes === 45) parses = value.startsWith('urn:uuid:') && isHyphenatedUuid(value.slice(9));
  if (!parses) return fail(field, MSG_UUID);
  if (!isHyphenatedUuid(value)) return fail(field, MSG_HYPHENATED_UUID);
  return { ok: true, value: value.toLowerCase() };
}

function isDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_DURATION_SECONDS &&
    value <= MAX_DURATION_SECONDS
  );
}

interface Fields {
  artist: string;
  track: string;
  listenedAt: string;
  album: string | undefined;
  durationSeconds: number | undefined;
  recordingMbid: string | undefined;
}

/** input_from_object: duration first, then the string fields, in the oracle's order. */
function inputFromObject(object: JsonObject): Field<Fields> {
  let durationSeconds: number | undefined;
  if (has(object, 'durationSeconds')) {
    const d = object.durationSeconds;
    if (!isDuration(d)) return fail('durationSeconds', MSG_DURATION);
    durationSeconds = d;
  }
  const artist = requiredString(object, 'artist');
  if (!artist.ok) return artist;
  const track = requiredString(object, 'track');
  if (!track.ok) return track;
  const listenedAt = requiredString(object, 'listenedAt');
  if (!listenedAt.ok) return listenedAt;
  const album = optionalString(object, 'album');
  if (!album.ok) return album;
  const recordingMbid = optionalString(object, 'recordingMbid');
  if (!recordingMbid.ok) return recordingMbid;
  return {
    ok: true,
    value: {
      artist: artist.value,
      track: track.value,
      listenedAt: listenedAt.value,
      album: album.value,
      durationSeconds,
      recordingMbid: recordingMbid.value,
    },
  };
}

interface Checked {
  artist: string;
  track: string;
  album: string | undefined;
  listenedAtNs: bigint;
  recordingMbid: string | undefined;
}

/** ScrobbleInput::validate: display strings, listenedAt, duration, MBID. */
function validateFields(fields: Fields, receiptNs: bigint): Field<Checked> {
  const artist = validateDisplayString('artist', fields.artist);
  if (!artist.ok) return artist;
  const track = validateDisplayString('track', fields.track);
  if (!track.ok) return track;
  let album: string | undefined;
  if (fields.album !== undefined) {
    const a = validateDisplayString('album', fields.album);
    if (!a.ok) return a;
    album = a.value;
  }
  const listenedAt = validateTimestamp('listenedAt', fields.listenedAt, receiptNs);
  if (!listenedAt.ok) return listenedAt;
  if (fields.durationSeconds !== undefined && !isDuration(fields.durationSeconds)) {
    return fail('durationSeconds', MSG_DURATION);
  }
  let recordingMbid: string | undefined;
  if (fields.recordingMbid !== undefined) {
    const m = validateMbid('recordingMbid', fields.recordingMbid);
    if (!m.ok) return m;
    recordingMbid = m.value;
  }
  return {
    ok: true,
    value: { artist: artist.value, track: track.value, album, listenedAtNs: listenedAt.ns, recordingMbid },
  };
}

function requirePrefix(prefix: string): string {
  return collectionsFor(prefix).scrobble;
}

function assertReceipt(receiptNs: bigint): void {
  if (typeof receiptNs !== 'bigint') throw new TypeError('receiptNs must be a bigint (nanoseconds since the epoch)');
}

/**
 * ScrobbleRecord::from_json for a remote record. `receiptNs` is the repository
 * event's receipt time, never a later replay clock.
 */
export function validateScrobbleRecord(json: unknown, prefix: string, receiptNs: bigint): Validation<ScrobbleRow> {
  const collection = requirePrefix(prefix);
  assertReceipt(receiptNs);
  const object = recordObject(json);
  if (object === null) return fail('body', MSG_NOT_OBJECT);
  const type = requiredString(object, '$type');
  if (!type.ok) return type;
  if (type.value !== collection) return fail('$type', MSG_SCROBBLE_TYPE);
  const createdAt = requiredString(object, 'createdAt');
  if (!createdAt.ok) return createdAt;
  const created = validateTimestamp('createdAt', createdAt.value, receiptNs);
  if (!created.ok) return created;
  const fields = inputFromObject(object);
  if (!fields.ok) return fields;
  const checked = validateFields(fields.value, receiptNs);
  if (!checked.ok) return checked;

  // The remote spelling stays authoritative after the bounds and trim checks.
  const f = fields.value;
  const record: ScrobbleRecord = {
    $type: type.value,
    artist: f.artist,
    track: f.track,
    listenedAt: f.listenedAt,
    createdAt: createdAt.value,
  };
  if (f.album !== undefined) record.album = f.album;
  if (f.durationSeconds !== undefined) record.durationSeconds = f.durationSeconds;
  if (f.recordingMbid !== undefined) record.recordingMbid = f.recordingMbid;
  return {
    ok: true,
    row: {
      record,
      artist: f.artist,
      track: f.track,
      album: f.album ?? null,
      listenedAt: toStorage(checked.value.listenedAtNs),
      listenedAtNs: checked.value.listenedAtNs,
      createdAt: toStorage(created.ns),
      createdAtNs: created.ns,
      durationSeconds: f.durationSeconds ?? null,
      recordingMbid: f.recordingMbid ?? null,
    },
  };
}

/**
 * The SPA's record builder: the Rust `POST /scrobbles` path (closed input,
 * trimmed strings, listenedAt canonicalized to the 9-digit UTC form,
 * lowercase MBID), with `createdAt` and `$type` derived from the clock and the
 * prefix. Building is allowed for any valid prefix; publishing additionally
 * requires `requirePublication` (namespace.ts).
 */
export function buildScrobbleRecord(input: unknown, prefix: string, clock: Clock): Build<ScrobbleRecord> {
  if (!isValidPrefix(prefix)) throw new RangeError(`invalid lexicon prefix ${JSON.stringify(prefix)}`);
  const receiptNs = nowNs(clock);
  const object = recordObject(input);
  if (object === null) return fail('body', MSG_NOT_OBJECT);
  const unknown = firstUnknownField(object, INPUT_FIELDS);
  if (unknown !== null) return fail(unknown, MSG_UNKNOWN_FIELD);
  const fields = inputFromObject(object);
  if (!fields.ok) return fields;
  const checked = validateFields(fields.value, receiptNs);
  if (!checked.ok) return checked;
  const c = checked.value;
  const record: ScrobbleRecord = {
    $type: requirePrefix(prefix),
    artist: c.artist,
    track: c.track,
    listenedAt: toStorage(c.listenedAtNs),
    createdAt: toRecordDatetime(receiptNs),
  };
  if (c.album !== undefined) record.album = c.album;
  if (fields.value.durationSeconds !== undefined) record.durationSeconds = fields.value.durationSeconds;
  if (c.recordingMbid !== undefined) record.recordingMbid = c.recordingMbid;
  return { ok: true, record };
}

/** `field: message`, the text stored as an exclusion reason. */
export function reasonText(reason: ValidationFailure): string {
  return `${reason.field}: ${reason.message}`;
}
