// `<p>.love` records (ADR 0005 §6.3, B12): validation of remote records and
// the server writer's builder.
//
// - Record `{artist, track, album?, recordingMbid?, createdAt}`, key `tid`.
// - artist, track and album use the scrobble display limits exactly
//   (`validateDisplayString`: 1–256 raw scalars, ≤ 1,024 raw UTF-8 bytes,
//   nonempty after White_Space trim); recordingMbid uses `validateMbid`.
// - createdAt is an explicit UTC RFC 3339 datetime between 1970 and the
//   receipt time plus 300 s (`validateTimestamp`, as for scrobbles).
// - Field checks run in the scrobble order ($type, createdAt, then the
//   fields) with the same codes and messages. album and recordingMbid are
//   schema-v1-style optionals: when present they must be valid (as for a
//   scrobble's album and recordingMbid), never silently repaired.
// - Remote records are open (unknown fields ignored, remote spelling kept);
//   `buildLoveRecord` is closed (unknown fields rejected by name), trims the
//   display strings and lowercases the MBID.
// - The love collection is `<prefix>.love` (namespace.ts derives the v1
//   collections; N3-11 adds love to config.collections).

import type { Clock } from './deps';
import { isValidPrefix } from './namespace';
import {
  type Build,
  fail,
  firstUnknownField,
  MSG_NOT_OBJECT,
  MSG_UNKNOWN_FIELD,
  optionalString,
  recordObject,
  requiredString,
  type Validation,
  type ValidationFailure,
  validateDisplayString,
  validateMbid,
} from './scrobble';
import { nowNs, toRecordDatetime, toStorage, validateTimestamp } from './timestamp';

export interface LoveRecord {
  $type: string;
  artist: string;
  track: string;
  album?: string;
  recordingMbid?: string;
  createdAt: string;
}

/** A validated remote love, shaped for the `loves` table. */
export interface LoveRow {
  /** Known fields only, remote spelling kept. */
  record: LoveRecord;
  artist: string;
  track: string;
  album: string | null;
  recordingMbid: string | null;
  /** 30-character storage form. */
  createdAt: string;
  createdAtNs: bigint;
}

/** The writer's input (`PUT /api/v1/loves`, `track.love`, ListenBrainz feedback). */
export interface LoveInput {
  artist: string;
  track: string;
  album?: string;
  recordingMbid?: string;
}

export const MSG_LOVE_TYPE = 'record type does not match the configured love collection';

const LOVE_INPUT_FIELDS: readonly string[] = ['artist', 'track', 'album', 'recordingMbid'];

/** `<prefix>.love` for a valid lexicon prefix. */
export function loveCollection(prefix: string): string {
  if (!isValidPrefix(prefix)) throw new RangeError(`invalid lexicon prefix ${JSON.stringify(prefix)}`);
  return `${prefix}.love`;
}

interface Checked {
  artist: { raw: string; trimmed: string };
  track: { raw: string; trimmed: string };
  album: { raw: string; trimmed: string } | undefined;
  recordingMbid: { raw: string; lower: string } | undefined;
}

type Fields = { ok: true; value: Checked } | { ok: false; reason: ValidationFailure };

/** Types first (artist, track, album, recordingMbid), then bounds in the same order. */
function checkFields(object: Record<string, unknown>): Fields {
  const artist = requiredString(object, 'artist');
  if (!artist.ok) return artist;
  const track = requiredString(object, 'track');
  if (!track.ok) return track;
  const album = optionalString(object, 'album');
  if (!album.ok) return album;
  const recordingMbid = optionalString(object, 'recordingMbid');
  if (!recordingMbid.ok) return recordingMbid;

  const a = validateDisplayString('artist', artist.value);
  if (!a.ok) return a;
  const t = validateDisplayString('track', track.value);
  if (!t.ok) return t;
  let albumChecked: Checked['album'];
  if (album.value !== undefined) {
    const al = validateDisplayString('album', album.value);
    if (!al.ok) return al;
    albumChecked = { raw: album.value, trimmed: al.value };
  }
  let mbidChecked: Checked['recordingMbid'];
  if (recordingMbid.value !== undefined) {
    const m = validateMbid('recordingMbid', recordingMbid.value);
    if (!m.ok) return m;
    mbidChecked = { raw: recordingMbid.value, lower: m.value };
  }
  return {
    ok: true,
    value: {
      artist: { raw: artist.value, trimmed: a.value },
      track: { raw: track.value, trimmed: t.value },
      album: albumChecked,
      recordingMbid: mbidChecked,
    },
  };
}

/**
 * A remote love record. `receiptNs` is the repository event's receipt time,
 * never a later replay clock.
 */
export function validateLoveRecord(json: unknown, prefix: string, receiptNs: bigint): Validation<LoveRow> {
  const collection = loveCollection(prefix);
  if (typeof receiptNs !== 'bigint') throw new TypeError('receiptNs must be a bigint (nanoseconds since the epoch)');
  const object = recordObject(json);
  if (object === null) return fail('body', MSG_NOT_OBJECT);
  const type = requiredString(object, '$type');
  if (!type.ok) return type;
  if (type.value !== collection) return fail('$type', MSG_LOVE_TYPE);
  const createdAt = requiredString(object, 'createdAt');
  if (!createdAt.ok) return createdAt;
  const created = validateTimestamp('createdAt', createdAt.value, receiptNs);
  if (!created.ok) return created;
  const fields = checkFields(object);
  if (!fields.ok) return fields;
  const f = fields.value;
  const record: LoveRecord = {
    $type: type.value,
    artist: f.artist.raw,
    track: f.track.raw,
    createdAt: createdAt.value,
  };
  if (f.album !== undefined) record.album = f.album.raw;
  if (f.recordingMbid !== undefined) record.recordingMbid = f.recordingMbid.raw;
  return {
    ok: true,
    row: {
      record,
      artist: f.artist.raw,
      track: f.track.raw,
      album: f.album?.raw ?? null,
      recordingMbid: f.recordingMbid?.raw ?? null,
      createdAt: toStorage(created.ns),
      createdAtNs: created.ns,
    },
  };
}

/**
 * The server writer's love builder: closed input, trimmed display strings,
 * lowercase MBID, `createdAt` from the clock and `$type` from the prefix.
 * Publishing additionally requires `requirePublication` (namespace.ts).
 */
export function buildLoveRecord(input: unknown, prefix: string, clock: Clock): Build<LoveRecord> {
  const collection = loveCollection(prefix);
  const receiptNs = nowNs(clock);
  const object = recordObject(input);
  if (object === null) return fail('body', MSG_NOT_OBJECT);
  const unknown = firstUnknownField(object, LOVE_INPUT_FIELDS);
  if (unknown !== null) return fail(unknown, MSG_UNKNOWN_FIELD);
  const fields = checkFields(object);
  if (!fields.ok) return fields;
  const f = fields.value;
  const record: LoveRecord = {
    $type: collection,
    artist: f.artist.trimmed,
    track: f.track.trimmed,
    createdAt: toRecordDatetime(receiptNs),
  };
  if (f.album !== undefined) record.album = f.album.trimmed;
  if (f.recordingMbid !== undefined) record.recordingMbid = f.recordingMbid.lower;
  return { ok: true, record };
}
