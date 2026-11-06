// POST /1/submit-listens body validation (ADR 0005 §8.3, Q11; N2-08).
//
// `validateSubmission(rawBody, nowMs)` answers exactly what ListenBrainz
// answers, then says what we do with each listen it accepts. The oracle is the
// ListenBrainz server source the ADR cites (§19, commit 7d9a3d6f9d52):
// `submit_listen` in listenbrainz/webserver/views/api.py and `validate_listen`
// and its helpers in views/api_tools.py.
//
// 1. Envelope checks, in `submit_listen`'s order, each with its verbatim
//    message (all 400 later):
//    body over 10,240,000 bytes; undecodable UTF-8 or unparsable JSON (as
//    orjson: lone surrogate escapes, numbers that overflow a double, and
//    nesting over 1,024 levels are parse errors too); top level not an object;
//    missing `payload` ("Invalid JSON document submitted."); `payload` not a
//    list; empty; more than 1,000 listens; body larger than 10,240 bytes x the
//    number of listens; missing or bad `listen_type`; `single` or
//    `playing_now` with more than one listen.
// 2. Per-listen checks, `validate_listen` for every listen in order; the first
//    failure is the request's error, so one bad listen rejects the whole
//    request and yields no listens (ListenBrainz does the same). Python
//    semantics are reproduced where they decide acceptance: `int()` coercion of
//    `listened_at` (numbers truncate, strings may carry whitespace, a sign,
//    underscores and Unicode decimal digits), `listened_at >= int(now) + 3600`
//    is too high, `int(float())` for durations, Python truthiness for
//    dropping MBIDs, `uuid.UUID()` for MBID syntax, `str.strip()` whitespace,
//    and the recursive NUL check. Where ListenBrainz would crash (a 500) on a
//    value of an unexpected JSON type inside `additional_info` (for example
//    `"additional_info": null` or numeric tags), the value is left alone and
//    validation goes on: only ListenBrainz's 400s are mirrored, and a crash is
//    not a verdict a client can rely on. A listen or `track_metadata` that is
//    not an object is rejected with the message ListenBrainz gives a string
//    there, because nothing can be mapped from it.
// 3. Classification of every listen ListenBrainz accepts. It never fails the
//    request (Q11: clients treat any 400 as fatal):
//    - `ignore` (artist_invalid / track_invalid): a name ListenBrainz accepts
//      but our scrobble display validator refuses (more than 256 scalars or
//      1,024 UTF-8 bytes). It is not written; the caller logs it to
//      `ignored_listens` with the first 128 scalars of each name.
//    - `defer`: `nowMs + 300 s < listened_at <= the ListenBrainz bound`. The
//      record is valid only once `createdAt >= listened_at - 300 s`, so its
//      write waits until `notBeforeMs = (listened_at - 300) s`.
//    - `accept`: everything else.
//    `playing_now` listens are `accept` or `ignore`; they carry no
//    listened_at, so `record` is null and only `track` is set.
//
// Only ListenBrainz-level errors are errors. The offending listen's keys are
// never merged into the error (ListenBrainz's APIError would).

import {
  type DroppedField,
  type InvalidListenReason,
  type MappedTrack,
  mapListenBrainzListen,
  mapListenBrainzTrack,
} from '@atmusic/core/protocol-map';
import type { JsonObject, ScrobbleInput, ValidationFailure } from '@atmusic/core/scrobble';
import { FUTURE_TOLERANCE_SECONDS } from '@atmusic/core/timestamp';

// ---------------------------------------------------------------------------
// ListenBrainz constants (api_tools.py, webserver/__init__.py, listenstore)

/** MAX_LISTEN_SIZE: bytes per listen, on average over the request. */
export const MAX_LISTEN_SIZE = 10_240;
/** MAX_LISTENS_PER_REQUEST. */
export const MAX_LISTENS_PER_REQUEST = 1_000;
/** MAX_LISTEN_PAYLOAD_SIZE = MAX_LISTEN_SIZE x MAX_LISTENS_PER_REQUEST. */
export const MAX_LISTEN_PAYLOAD_SIZE = MAX_LISTEN_SIZE * MAX_LISTENS_PER_REQUEST;
/** MAX_TAGS_PER_LISTEN and MAX_TAG_SIZE (characters). */
export const MAX_TAGS_PER_LISTEN = 50;
export const MAX_TAG_SIZE = 64;
/** MAX_DURATION_LIMIT (24 x 24 x 60 x 60 in the source) and MAX_DURATION_MS_LIMIT. */
export const MAX_DURATION_LIMIT = 24 * 24 * 60 * 60;
export const MAX_DURATION_MS_LIMIT = MAX_DURATION_LIMIT * 1000;
/** LISTEN_MINIMUM_TS: 2002-10-01T00:00:00Z. */
export const LISTEN_MINIMUM_TS = 1_033_430_400;
/** API_LISTENED_AT_ALLOWED_SKEW: listened_at must be below int(now) + this. */
export const API_LISTENED_AT_ALLOWED_SKEW = 3_600;
/** orjson's nesting limit. */
export const MAX_JSON_DEPTH = 1_024;
/** Scalars of each name kept in `ignored_listens` (ADR 0005 §6.4). */
export const IGNORED_PREVIEW_SCALARS = 128;

export const LISTEN_TYPES = ['single', 'import', 'playing_now'] as const;
export type ListenType = (typeof LISTEN_TYPES)[number];

/** ListenBrainz's verbatim messages. Parameterised ones are functions. */
export const LB_SUBMIT_MESSAGES = {
  payloadTooLarge: `Payload too large. Payload cannot exceed ${MAX_LISTEN_PAYLOAD_SIZE} bytes`,
  cannotParse: (detail: string) => `Cannot parse JSON document: ${detail}`,
  notObject: 'Invalid JSON document submitted. Top level of JSON document should be a json object.',
  invalidDocument: 'Invalid JSON document submitted.',
  payloadNotList: 'The payload in the JSON document should be a list of listens.',
  emptyPayload: 'JSON document does not contain any listens',
  tooManyListens: `Too many listens. You may not submit more than ${MAX_LISTENS_PER_REQUEST} listens at once.`,
  documentTooLarge: `JSON document is too large. Each listens may not be larger than ${MAX_LISTEN_SIZE} bytes.`,
  badListenType: 'JSON document requires a valid listen_type key.',
  moreThanOne: 'JSON document contains more than listen for a single/playing_now. It should contain only one.',
  listenEmpty: 'Listen is empty and cannot be validated.',
  missingListenedAt: 'JSON document must contain the key listened_at at the top level.',
  listenedAtNotInt: 'JSON document must contain an int value for listened_at.',
  listenedAtTooHigh: 'Value for key listened_at is too high.',
  // Verbatim, including ListenBrainz's own 1033410600 (the constant is 1033430400).
  listenedAtTooLow:
    'Value for key listened_at is too low. listened_at timestamp should be greater than 1033410600 (2002-10-01 00:00:00 UTC).',
  missingTrackMetadata: 'JSON document must contain the key track_metadata at the top level.',
  extraKeys: 'JSON document may only contain listened_at and track_metadata top level keys',
  playingNowListenedAt: 'JSON document must not contain listened_at while submitting playing_now.',
  playingNowExtraKeys: 'JSON document may only contain track_metadata as top level key when submitting playing_now.',
  nullTrackMetadata: 'JSON document may not have track_metadata with null value.',
  notString: (key: string) => `track_metadata.${key} must be a single string.`,
  emptyField: (key: string) => `field track_metadata.${key} is empty.`,
  missingField: (key: string) => `JSON document does not contain required field track_metadata.${key}.`,
  tooManyTags: `JSON document may not contain more than ${MAX_TAGS_PER_LISTEN} items in track_metadata.additional_info.tags.`,
  tagTooLong: `JSON document may not contain track_metadata.additional_info.tags longer than ${MAX_TAG_SIZE} characters.`,
  bothDurations: 'JSON document should not contain both duration and duration_ms.',
  durationInvalid: (key: string) => `Value for ${key} is invalid, should be a positive integer.`,
  durationTooLarge: (key: string, max: number) => `Value for ${key} is too large, max permitted value is ${max}`,
  mbidInvalid: (key: string) => `${key} MBID format invalid.`,
  unicodeNull: (value: string) => `${value} contains a unicode null`,
} as const;

// ---------------------------------------------------------------------------
// Result types

export interface SubmissionError {
  status: 400;
  message: string;
}

export type IgnoreReason = Exclude<InvalidListenReason, 'timestamp_invalid'>;

export type ListenDisposition =
  | { kind: 'accept' }
  | { kind: 'defer'; notBeforeMs: number }
  | {
      kind: 'ignore';
      reason: IgnoreReason;
      failure: ValidationFailure;
      /** The first 128 scalars of the (ListenBrainz-trimmed) names. */
      artistPreview: string;
      trackPreview: string;
    };

export interface ValidatedListen {
  /** The listen as ListenBrainz keeps it after `validate_listen` (coerced, trimmed, pruned). */
  listen: JsonObject;
  /** The scrobble input to write: `single`/`import` listens that are `accept` or `defer`; else null. */
  record: ScrobbleInput | null;
  /** The mapped track (artist, track, optional fields); null for `ignore`. */
  track: MappedTrack | null;
  /** listened_at in Unix seconds; null for `playing_now`. */
  listenedAtSeconds: number | null;
  /** Optional fields left out of `record`/`track`, with their source keys. */
  dropped: DroppedField[];
  disposition: ListenDisposition;
}

export type SubmissionResult =
  | { ok: true; listenType: ListenType; listens: ValidatedListen[] }
  | { ok: false; error: SubmissionError };

// ---------------------------------------------------------------------------
// Python semantics

/** Py_UNICODE_ISSPACE: what `str.strip()`, `str.isspace()` and `int()` treat as whitespace. */
const PY_WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function isPyWhitespace(cp: number): boolean {
  return PY_WHITESPACE.has(cp);
}

/** Python `str.strip()` with no argument. */
export function pyStrip(s: string): string {
  const cps = Array.from(s);
  let start = 0;
  let end = cps.length;
  while (start < end && isPyWhitespace(cps[start]!.codePointAt(0)!)) start++;
  while (end > start && isPyWhitespace(cps[end - 1]!.codePointAt(0)!)) end--;
  return cps.slice(start, end).join('');
}

/** Python `len()` of a str: code points. */
function pyStrLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

const ND = /^\p{Nd}$/u;

function isNd(cp: number): boolean {
  return cp >= 0 && cp <= 0x10ffff && ND.test(String.fromCodePoint(cp));
}

/**
 * The value of a Unicode decimal digit (general category Nd). Nd characters
 * come in contiguous runs of ten, zero first, so the value is the offset from
 * the start of the run, modulo ten.
 */
function ndValue(cp: number): number {
  let start = cp;
  while (isNd(start - 1)) start--;
  return (cp - start) % 10;
}

/**
 * CPython's `_PyUnicode_TransformDecimalAndSpaceToASCII`: whitespace becomes a
 * space, any decimal digit its ASCII digit; other non-ASCII characters can
 * never parse, so they become `?`.
 */
function toAsciiNumeric(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out += isPyWhitespace(cp) ? ' ' : ch;
    else if (isPyWhitespace(cp)) out += ' ';
    else if (isNd(cp)) out += String(ndValue(cp));
    else out += '?';
  }
  return out;
}

const PY_INT10 = /^[+-]?[0-9](?:_?[0-9])*$/;
const PY_FLOAT =
  /^[+-]?(?:(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?|inf|infinity|nan)$/i;

/** Python `int(value)` for a JSON value, or null where Python raises (ValueError / TypeError). */
export function pyInt(value: unknown): bigint | null {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
  if (typeof value !== 'string') return null;
  const t = toAsciiNumeric(value).trim();
  return PY_INT10.test(t) ? BigInt(t.replace(/_/g, '')) : null;
}

/** Python `float(value)` for a JSON value, or null where Python raises. */
export function pyFloat(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const t = toAsciiNumeric(value).trim();
  if (!PY_FLOAT.test(t)) return null;
  const lower = t.toLowerCase().replace(/^[+-]/, '');
  const negative = t.startsWith('-');
  if (lower === 'inf' || lower === 'infinity') return negative ? -Infinity : Infinity;
  if (lower === 'nan') return Number.NaN;
  return Number(t.replace(/_/g, ''));
}

/** Python truthiness of a JSON value. */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Python `len()` of a JSON value, or null where it raises TypeError. */
function pyLen(value: unknown): number | null {
  if (typeof value === 'string') return pyStrLen(value);
  if (Array.isArray(value)) return value.length;
  if (isObject(value)) return Object.keys(value).length;
  return null;
}

/** Python iteration of a JSON value (`for x in value`), or null where it raises TypeError. */
function pyIter(value: unknown): unknown[] | null {
  if (typeof value === 'string') return Array.from(value);
  if (Array.isArray(value)) return value;
  if (isObject(value)) return Object.keys(value);
  return null;
}

const PY_INT16 = /^[+-]?(?:0[xX](?:_?[0-9a-fA-F])+|[0-9a-fA-F](?:_?[0-9a-fA-F])*)$/;

/**
 * ListenBrainz `is_valid_uuid`: `uuid.UUID(value)` succeeds. Only a str can
 * (anything else raises AttributeError). `uuid.UUID` removes every `urn:` and
 * `uuid:`, strips `{` and `}` from both ends, removes every `-`, needs exactly
 * 32 code points and then `int(hex, 16)`, which allows surrounding whitespace,
 * a `+`, a `0x` prefix, single underscores between digits and Unicode decimal
 * digits.
 */
export function isPythonUuid(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let hex = value.replaceAll('urn:', '').replaceAll('uuid:', '');
  hex = hex.replace(/^[{}]+/, '').replace(/[{}]+$/, '');
  hex = hex.replaceAll('-', '');
  if (pyStrLen(hex) !== 32) return false;
  return PY_INT16.test(toAsciiNumeric(hex).trim());
}

// ---------------------------------------------------------------------------
// Decoding and parsing, as `raw_data.decode("utf-8")` then `orjson.loads`

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(o: JsonObject, key: string): boolean {
  return Object.hasOwn(o, key);
}

/** Where strict UTF-8 decoding first fails, worded as Python's UnicodeDecodeError. */
function utf8Error(bytes: Uint8Array): string | null {
  let i = 0;
  const n = bytes.length;
  const hex = (b: number) => `0x${b.toString(16).padStart(2, '0')}`;
  while (i < n) {
    const b = bytes[i]!;
    if (b < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lo = 0xa0;
      if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lo = 0x90;
      if (b === 0xf4) hi = 0x8f;
    } else {
      return `'utf-8' codec can't decode byte ${hex(b)} in position ${i}: invalid start byte`;
    }
    for (let k = 1; k <= need; k++) {
      if (i + k >= n) {
        const last = n - 1;
        return last > i
          ? `'utf-8' codec can't decode bytes in position ${i}-${last}: unexpected end of data`
          : `'utf-8' codec can't decode byte ${hex(b)} in position ${i}: unexpected end of data`;
      }
      const c = bytes[i + k]!;
      const min = k === 1 ? lo : 0x80;
      const max = k === 1 ? hi : 0xbf;
      if (c < min || c > max) {
        return k === 1
          ? `'utf-8' codec can't decode byte ${hex(b)} in position ${i}: invalid continuation byte`
          : `'utf-8' codec can't decode bytes in position ${i}-${i + k - 1}: invalid continuation byte`;
      }
    }
    i += need + 1;
  }
  return null;
}

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function hasLoneSurrogate(s: string): boolean {
  return !s.isWellFormed();
}

/**
 * The orjson rejections JSON.parse does not make: lone surrogate escapes (in
 * keys or values), numbers that overflow a double, and nesting deeper than
 * 1,024. Iterative, so a deeply nested document cannot exhaust the stack.
 */
function orjsonRejection(root: unknown): string | null {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value === 'string') {
      if (hasLoneSurrogate(value)) return 'no low surrogate in string';
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'number is infinity when parsed as double';
    } else if (Array.isArray(value)) {
      if (depth + 1 > MAX_JSON_DEPTH) return 'recursion limit exceeded';
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else if (isObject(value)) {
      if (depth + 1 > MAX_JSON_DEPTH) return 'recursion limit exceeded';
      for (const [key, item] of Object.entries(value)) {
        if (hasLoneSurrogate(key)) return 'no low surrogate in string';
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }
  return null;
}

function parseDocument(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false; detail: string } {
  let text: string;
  try {
    text = DECODER.decode(bytes);
  } catch {
    return { ok: false, detail: utf8Error(bytes) ?? "'utf-8' codec can't decode the document" };
  }
  if (text.length === 0) {
    return { ok: false, detail: 'Input is a zero-length, empty document: line 1 column 1 (char 0)' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  const rejection = orjsonRejection(value);
  return rejection === null ? { ok: true, value } : { ok: false, detail: rejection };
}

// ---------------------------------------------------------------------------
// validate_listen

class ListenValidationError extends Error {}

function reject(message: string): never {
  throw new ListenValidationError(message);
}

function validateListenedAt(listen: JsonObject, nowMs: number): void {
  if (!has(listen, 'listened_at')) reject(LB_SUBMIT_MESSAGES.missingListenedAt);
  const value = pyInt(listen.listened_at);
  if (value === null) reject(LB_SUBMIT_MESSAGES.listenedAtNotInt);
  if (value >= BigInt(Math.floor(nowMs / 1000) + API_LISTENED_AT_ALLOWED_SKEW)) {
    reject(LB_SUBMIT_MESSAGES.listenedAtTooHigh);
  }
  if (value < BigInt(LISTEN_MINIMUM_TS)) reject(LB_SUBMIT_MESSAGES.listenedAtTooLow);
  listen.listened_at = Number(value);
}

function validateBasicMetadata(meta: JsonObject, key: string, required: boolean): void {
  if (has(meta, key)) {
    const value = meta[key];
    if (typeof value !== 'string') reject(LB_SUBMIT_MESSAGES.notString(key));
    const stripped = pyStrip(value);
    meta[key] = stripped;
    if (stripped.length === 0) {
      if (required) reject(LB_SUBMIT_MESSAGES.emptyField(key));
      delete meta[key];
    }
  } else if (required) {
    reject(LB_SUBMIT_MESSAGES.missingField(key));
  }
}

function validateTags(info: JsonObject): void {
  if (!has(info, 'tags')) return;
  const tags = info.tags;
  const count = pyLen(tags);
  // len() of a number, bool or null would crash ListenBrainz; not a verdict.
  if (count === null) return;
  if (count > MAX_TAGS_PER_LISTEN) reject(LB_SUBMIT_MESSAGES.tooManyTags);
  for (const tag of pyIter(tags) ?? []) {
    const size = pyLen(tag);
    if (size !== null && size > MAX_TAG_SIZE) reject(LB_SUBMIT_MESSAGES.tagTooLong);
  }
}

function validateDurationField(info: JsonObject, key: string, max: number): void {
  if (!has(info, key)) return;
  const f = pyFloat(info[key]);
  // int(float(x)): NaN raises ValueError (the invalid message); ±inf raises
  // OverflowError, which ListenBrainz does not catch (a 500): rejected here
  // with the invalid message, the closest 400.
  if (f === null || !Number.isFinite(f)) reject(LB_SUBMIT_MESSAGES.durationInvalid(key));
  const value = Math.trunc(f);
  if (value <= 0) reject(LB_SUBMIT_MESSAGES.durationInvalid(key));
  if (value > max) reject(LB_SUBMIT_MESSAGES.durationTooLarge(key, max));
  info[key] = value;
}

function validateSingleMbid(info: JsonObject, key: string): void {
  if (!has(info, key)) return;
  const mbid = info[key];
  if (!pyTruthy(mbid)) {
    delete info[key];
    return;
  }
  if (!isPythonUuid(mbid)) reject(LB_SUBMIT_MESSAGES.mbidInvalid(key));
}

function validateMultipleMbids(info: JsonObject, key: string): void {
  if (!has(info, key)) return;
  const mbids = info[key];
  if (!pyTruthy(mbids)) {
    delete info[key];
    return;
  }
  const items = pyIter(mbids);
  // Iterating a number or `true` would crash ListenBrainz; the value is left
  // for the field mapper, which drops it with a note.
  if (items === null) return;
  const kept = items.filter(pyTruthy);
  for (const mbid of kept) if (!isPythonUuid(mbid)) reject(LB_SUBMIT_MESSAGES.mbidInvalid(key));
  info[key] = kept;
}

function nullCheck(value: unknown): void {
  if (typeof value === 'string' && value.includes('\u0000')) reject(LB_SUBMIT_MESSAGES.unicodeNull(value));
}

/** check_for_unicode_null_recursively: dicts recurse, list items and scalars are checked. */
function checkUnicodeNull(object: JsonObject): void {
  for (const value of Object.values(object)) {
    if (isObject(value)) checkUnicodeNull(value);
    else if (Array.isArray(value)) for (const item of value) nullCheck(item);
    else nullCheck(value);
  }
}

/** validate_listen: mutates `raw` as ListenBrainz does and returns it, or throws ListenValidationError. */
function validateListen(raw: unknown, listenType: ListenType, nowMs: number): JsonObject {
  if (raw === null) reject(LB_SUBMIT_MESSAGES.listenEmpty);
  // ListenBrainz's `key in listen` on a string or list never finds a dict key,
  // so a non-object listen fails as one without the key.
  const listen: JsonObject = isObject(raw) ? raw : {};
  if (listenType === 'single' || listenType === 'import') {
    validateListenedAt(listen, nowMs);
    if (!has(listen, 'track_metadata')) reject(LB_SUBMIT_MESSAGES.missingTrackMetadata);
    if (Object.keys(listen).length > 2) reject(LB_SUBMIT_MESSAGES.extraKeys);
  } else {
    if (has(listen, 'listened_at')) reject(LB_SUBMIT_MESSAGES.playingNowListenedAt);
    if (!has(listen, 'track_metadata')) reject(LB_SUBMIT_MESSAGES.missingTrackMetadata);
    if (Object.keys(listen).length > 1) reject(LB_SUBMIT_MESSAGES.playingNowExtraKeys);
  }
  if (listen.track_metadata === null) reject(LB_SUBMIT_MESSAGES.nullTrackMetadata);

  // A string track_metadata fails `key in` the same way.
  const meta: JsonObject = isObject(listen.track_metadata) ? listen.track_metadata : {};
  validateBasicMetadata(meta, 'track_name', true);
  validateBasicMetadata(meta, 'artist_name', true);
  validateBasicMetadata(meta, 'release_name', false);

  if (has(meta, 'additional_info') && isObject(meta.additional_info)) {
    const info = meta.additional_info;
    validateTags(info);
    if (has(info, 'duration') && has(info, 'duration_ms')) reject(LB_SUBMIT_MESSAGES.bothDurations);
    validateDurationField(info, 'duration', MAX_DURATION_LIMIT);
    validateDurationField(info, 'duration_ms', MAX_DURATION_MS_LIMIT);
    for (const key of ['release_mbid', 'recording_mbid', 'release_group_mbid', 'track_mbid']) {
      validateSingleMbid(info, key);
    }
    for (const key of ['artist_mbids', 'work_mbids']) validateMultipleMbids(info, key);
  }

  checkUnicodeNull(listen);
  return listen;
}

// ---------------------------------------------------------------------------
// Classification

function preview(value: unknown): string {
  return typeof value === 'string' ? Array.from(value).slice(0, IGNORED_PREVIEW_SCALARS).join('') : '';
}

function classify(listen: JsonObject, listenType: ListenType, nowMs: number): ValidatedListen {
  const meta = listen.track_metadata as JsonObject;
  const ignore = (reason: InvalidListenReason, failure: ValidationFailure): ValidatedListen => {
    if (reason === 'timestamp_invalid') {
      // listened_at already passed ListenBrainz's bounds, which lie inside the record datetime range.
      throw new Error('unreachable: a ListenBrainz-valid listened_at failed the record datetime range');
    }
    return {
      listen,
      record: null,
      track: null,
      listenedAtSeconds: typeof listen.listened_at === 'number' ? listen.listened_at : null,
      dropped: [],
      disposition: {
        kind: 'ignore',
        reason,
        failure,
        artistPreview: preview(meta.artist_name),
        trackPreview: preview(meta.track_name),
      },
    };
  };

  if (listenType === 'playing_now') {
    const mapped = mapListenBrainzTrack(meta);
    if (!mapped.ok) return ignore(mapped.reason, mapped.failure);
    return {
      listen,
      record: null,
      track: mapped.track,
      listenedAtSeconds: null,
      dropped: mapped.dropped,
      disposition: { kind: 'accept' },
    };
  }

  const mapped = mapListenBrainzListen(listen);
  if (!mapped.ok) return ignore(mapped.reason, mapped.failure);
  const { listenedAt: _listenedAt, ...track } = mapped.input;
  const listenedAtMs = mapped.listenedAtSeconds * 1000;
  const disposition: ListenDisposition =
    listenedAtMs <= nowMs + FUTURE_TOLERANCE_SECONDS * 1000
      ? { kind: 'accept' }
      : { kind: 'defer', notBeforeMs: listenedAtMs - FUTURE_TOLERANCE_SECONDS * 1000 };
  return {
    listen,
    record: mapped.input,
    track,
    listenedAtSeconds: mapped.listenedAtSeconds,
    dropped: mapped.dropped,
    disposition,
  };
}

// ---------------------------------------------------------------------------
// submit_listen

function fail(message: string): SubmissionResult {
  return { ok: false, error: { status: 400, message } };
}

const ENCODER = new TextEncoder();

/**
 * Validates a submit-listens body (the raw bytes, or text that is encoded as
 * UTF-8) at `nowMs`. Returns every listen with its disposition, or the first
 * ListenBrainz-level error.
 */
export function validateSubmission(rawBody: Uint8Array | string, nowMs: number): SubmissionResult {
  if (!Number.isSafeInteger(nowMs)) throw new RangeError(`validateSubmission needs integer ms, got ${nowMs}`);
  const bytes = typeof rawBody === 'string' ? ENCODER.encode(rawBody) : rawBody;
  if (bytes.byteLength > MAX_LISTEN_PAYLOAD_SIZE) return fail(LB_SUBMIT_MESSAGES.payloadTooLarge);

  const parsed = parseDocument(bytes);
  if (!parsed.ok) return fail(LB_SUBMIT_MESSAGES.cannotParse(parsed.detail));
  const data = parsed.value;
  if (!isObject(data)) return fail(LB_SUBMIT_MESSAGES.notObject);
  if (!has(data, 'payload')) return fail(LB_SUBMIT_MESSAGES.invalidDocument);
  const payload = data.payload;
  if (!Array.isArray(payload)) return fail(LB_SUBMIT_MESSAGES.payloadNotList);
  if (payload.length === 0) return fail(LB_SUBMIT_MESSAGES.emptyPayload);
  if (payload.length > MAX_LISTENS_PER_REQUEST) return fail(LB_SUBMIT_MESSAGES.tooManyListens);
  if (bytes.byteLength > payload.length * MAX_LISTEN_SIZE) return fail(LB_SUBMIT_MESSAGES.documentTooLarge);
  if (!has(data, 'listen_type')) return fail(LB_SUBMIT_MESSAGES.invalidDocument);
  const listenType = data.listen_type;
  if (typeof listenType !== 'string' || !(LISTEN_TYPES as readonly string[]).includes(listenType)) {
    return fail(LB_SUBMIT_MESSAGES.badListenType);
  }
  const type = listenType as ListenType;
  if (type !== 'import' && payload.length > 1) return fail(LB_SUBMIT_MESSAGES.moreThanOne);

  const validated: JsonObject[] = [];
  try {
    for (const raw of payload) validated.push(validateListen(raw, type, nowMs));
  } catch (e) {
    if (e instanceof ListenValidationError) return fail(e.message);
    throw e;
  }
  return { ok: true, listenType: type, listens: validated.map((listen) => classify(listen, type, nowMs)) };
}
