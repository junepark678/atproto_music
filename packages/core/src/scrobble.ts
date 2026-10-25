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
// - ADR 0005 §6.2 adds eight optional fields (albumArtist, trackNumber,
//   artistMbids, releaseMbid, releaseGroupMbid, isrc, submissionClient,
//   musicService). They are checked after every schema-v1 field, so the
//   first failure of a v1 record is unchanged. On a remote record an invalid
//   new field is dropped (reported in `row.dropped`), never fatal and never
//   truncated; `buildScrobbleRecord` rejects it, and protocol mapping
//   (protocol-map.ts) drops it with a note via `validateDroppableField`.
//   Records without the new fields are byte-identical to the v1 goldens.

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

/** The optional ADR 0005 §6.2 fields, shared by the record and the local input. */
export interface ScrobbleExtras {
  albumArtist?: string;
  trackNumber?: number;
  artistMbids?: string[];
  releaseMbid?: string;
  releaseGroupMbid?: string;
  isrc?: string;
  submissionClient?: string;
  musicService?: string;
}

/** The scrobble record (known fields only): schema v1 plus the §6.2 optional fields. */
export interface ScrobbleRecord extends ScrobbleExtras {
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
  /**
   * Present only when the remote record carried an invalid §6.2 field: each
   * such field was dropped from `record`, never truncated, and is named here.
   */
  dropped?: ValidationFailure[];
}

/** Local scrobble form input accepted by `buildScrobbleRecord`. */
export interface ScrobbleInput extends ScrobbleExtras {
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
export const MIN_TRACK_NUMBER = 1;
export const MAX_TRACK_NUMBER = 9999;
export const MAX_ARTIST_MBIDS = 10;
export const MAX_SUBMISSION_CLIENT_SCALARS = 64;
export const MAX_SUBMISSION_CLIENT_BYTES = 256;
export const MAX_MUSIC_SERVICE_LENGTH = 253;

export const MSG_NOT_OBJECT = 'expected a JSON object';
export const MSG_UNKNOWN_FIELD = 'unknown field';
export const MSG_REQUIRED_STRING = 'required string field';
export const MSG_OPTIONAL_STRING = 'expected a string or omitted field';
export const MSG_DISPLAY = 'expected 1–256 Unicode scalars and at most 1024 UTF-8 bytes, with nonempty trimmed text';
export const MSG_DURATION = 'expected an integer between 1 and 86400';
export const MSG_UUID = 'expected a UUID';
export const MSG_HYPHENATED_UUID = 'expected a hyphenated UUID';
export const MSG_SCROBBLE_TYPE = 'record type does not match the configured scrobble collection';
export const MSG_TRACK_NUMBER = 'expected an integer between 1 and 9999';
export const MSG_ARTIST_MBIDS = 'expected an array of 1–10 distinct UUIDs';
export const MSG_ISRC = 'expected an uppercase ISRC matching ^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$';
export const MSG_SUBMISSION_CLIENT =
  'expected 1–64 Unicode scalars and at most 256 UTF-8 bytes, with nonempty trimmed text';
export const MSG_MUSIC_SERVICE = 'expected a lowercase DNS name of at most 253 characters';
/** No Rust string can hold a lone surrogate, so this message has no oracle counterpart. */
export const MSG_LONE_SURROGATE = 'expected well-formed Unicode text without lone surrogates';

/** The §6.2 optional fields, in the order they are checked. */
export const OPTIONAL_FIELDS = [
  'albumArtist',
  'trackNumber',
  'artistMbids',
  'releaseMbid',
  'releaseGroupMbid',
  'isrc',
  'submissionClient',
  'musicService',
] as const;
export type OptionalField = (typeof OPTIONAL_FIELDS)[number];

/** Every optional record field a protocol mapping may drop: the v1 optionals plus §6.2. */
export const DROPPABLE_FIELDS = ['album', 'durationSeconds', 'recordingMbid', ...OPTIONAL_FIELDS] as const;
export type DroppableField = (typeof DROPPABLE_FIELDS)[number];

const INPUT_FIELDS: readonly string[] = [
  'artist',
  'track',
  'listenedAt',
  'album',
  'durationSeconds',
  'recordingMbid',
  ...OPTIONAL_FIELDS,
];

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
export function has(object: JsonObject, field: string): boolean {
  return Object.hasOwn(object, field) && object[field] !== undefined;
}

export function requiredString(object: JsonObject, field: string): Field<string> {
  const value = has(object, field) ? object[field] : undefined;
  if (typeof value !== 'string') return fail(field, MSG_REQUIRED_STRING);
  if (!isWellFormed(value)) return fail(field, MSG_LONE_SURROGATE);
  return { ok: true, value };
}

export function optionalString(object: JsonObject, field: string): Field<string | undefined> {
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

// ---------------------------------------------------------------------------
// ADR 0005 §6.2 optional fields

/** The normalized value type of each droppable field. */
export interface DroppableValues extends ScrobbleExtras {
  album?: string;
  durationSeconds?: number;
  recordingMbid?: string;
}

/**
 * The verdict on one optional field. A failure is always `droppable`: leaving
 * the field out never makes the record or the listen invalid.
 */
export type DroppableResult<T> = { ok: true; value: T } | { ok: false; droppable: true; reason: ValidationFailure };

function droppable(field: string, message: string): { ok: false; droppable: true; reason: ValidationFailure } {
  return { ok: false, droppable: true, reason: { field, code: 'invalid_field', message } };
}

/** A display-like string with raw scalar and byte bounds; returns the trimmed value. */
function boundedText(
  field: string,
  value: unknown,
  maxScalars: number,
  maxBytes: number,
  message: string,
): DroppableResult<string> {
  if (typeof value !== 'string') return droppable(field, MSG_OPTIONAL_STRING);
  if (!isWellFormed(value)) return droppable(field, MSG_LONE_SURROGATE);
  const trimmed = trimWhiteSpace(value);
  if (trimmed === '' || scalarCount(value) > maxScalars || utf8Length(value) > maxBytes) {
    return droppable(field, message);
  }
  return { ok: true, value: trimmed };
}

function uuidField(field: string, value: unknown): DroppableResult<string> {
  if (typeof value !== 'string') return droppable(field, MSG_OPTIONAL_STRING);
  if (!isWellFormed(value)) return droppable(field, MSG_LONE_SURROGATE);
  const m = validateMbid(field, value);
  return m.ok ? m : droppable(field, m.reason.message);
}

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** At least two lowercase LDH labels (the OpenAPI `MusicService` pattern). */
const DNS_NAME = new RegExp(`^(?=.{1,${MAX_MUSIC_SERVICE_LENGTH}}$)${DNS_LABEL}(?:\\.${DNS_LABEL})+$`);

function artistMbidList(value: unknown): DroppableResult<string[]> {
  const field = 'artistMbids';
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARTIST_MBIDS) {
    return droppable(field, MSG_ARTIST_MBIDS);
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    // `Object.hasOwn` sees the holes of a sparse array.
    const item: unknown = Object.hasOwn(value, i) ? value[i] : undefined;
    if (typeof item !== 'string') return droppable(field, MSG_ARTIST_MBIDS);
    const m = uuidField(field, item);
    if (!m.ok) return m;
    // Distinct as UUIDs: two spellings that differ only in case are the same artist.
    if (out.includes(m.value)) return droppable(field, MSG_ARTIST_MBIDS);
    out.push(m.value);
  }
  return { ok: true, value: out };
}

/**
 * Validate one optional record field. The value returned is normalized the
 * way `buildScrobbleRecord` stores it (trimmed text, lowercase UUIDs); a
 * remote record keeps its own spelling instead. A failure names the record
 * field, has code `invalid_field` and is marked droppable.
 */
export function validateDroppableField<K extends DroppableField>(
  field: K,
  value: unknown,
): DroppableResult<NonNullable<DroppableValues[K]>> {
  type R = DroppableResult<NonNullable<DroppableValues[K]>>;
  switch (field) {
    case 'album':
    case 'albumArtist':
      return boundedText(field, value, MAX_DISPLAY_SCALARS, MAX_DISPLAY_BYTES, MSG_DISPLAY) as R;
    case 'submissionClient':
      return boundedText(
        field,
        value,
        MAX_SUBMISSION_CLIENT_SCALARS,
        MAX_SUBMISSION_CLIENT_BYTES,
        MSG_SUBMISSION_CLIENT,
      ) as R;
    case 'durationSeconds':
      return (isDuration(value) ? { ok: true, value } : droppable(field, MSG_DURATION)) as R;
    case 'trackNumber': {
      const ok =
        typeof value === 'number' && Number.isInteger(value) && value >= MIN_TRACK_NUMBER && value <= MAX_TRACK_NUMBER;
      return (ok ? { ok: true, value } : droppable(field, MSG_TRACK_NUMBER)) as R;
    }
    case 'recordingMbid':
    case 'releaseMbid':
    case 'releaseGroupMbid':
      return uuidField(field, value) as R;
    case 'artistMbids':
      return artistMbidList(value) as R;
    case 'isrc':
      if (typeof value !== 'string') return droppable(field, MSG_OPTIONAL_STRING) as R;
      return (ISRC.test(value) ? { ok: true, value } : droppable(field, MSG_ISRC)) as R;
    case 'musicService':
      if (typeof value !== 'string') return droppable(field, MSG_OPTIONAL_STRING) as R;
      return (DNS_NAME.test(value) ? { ok: true, value } : droppable(field, MSG_MUSIC_SERVICE)) as R;
  }
  throw new RangeError(`not a droppable scrobble field: ${String(field)}`);
}

/** The remote spelling of a validated field (arrays copied, so the row never aliases the input). */
function remoteSpelling(value: unknown): unknown {
  return Array.isArray(value) ? [...value] : value;
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
  // Open record: each §6.2 field is kept in its remote spelling when valid and
  // dropped when not (reported, never fatal, never truncated).
  const dropped: ValidationFailure[] = [];
  const extras = record as unknown as Record<string, unknown>;
  for (const name of OPTIONAL_FIELDS) {
    if (!has(object, name)) continue;
    const v = validateDroppableField(name, object[name]);
    if (v.ok) extras[name] = remoteSpelling(object[name]);
    else dropped.push(v.reason);
  }
  const row: ScrobbleRow = {
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
  };
  if (dropped.length > 0) row.dropped = dropped;
  return { ok: true, row };
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
  // Closed input: an invalid §6.2 field rejects the build (a 422 before any operation exists).
  const extras = record as unknown as Record<string, unknown>;
  for (const name of OPTIONAL_FIELDS) {
    if (!has(object, name)) continue;
    const v = validateDroppableField(name, object[name]);
    if (!v.ok) return { ok: false, reason: v.reason };
    extras[name] = v.value;
  }
  return { ok: true, record };
}

/** `field: message`, the text stored as an exclusion reason. */
export function reasonText(reason: ValidationFailure): string {
  return `${reason.field}: ${reason.message}`;
}
