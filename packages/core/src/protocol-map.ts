// Last.fm and ListenBrainz listens to a scrobble record input (ADR 0005 §6.2,
// §7.7, §8.3, §11.2). Pure: the protocol layers (/2.0, /1) and the importers
// call it after their own envelope checks.
//
// - artist and track must pass the scrobble display validator, else the
//   listen is invalid with reason artist_invalid or track_invalid (Last.fm
//   ignored codes 1 and 2; ListenBrainz ignored_listens reasons). A listen
//   time that is not a whole number of seconds in the record datetime range
//   is timestamp_invalid. The +300 s and 2002 bounds are the callers' (codes
//   3 and 4, ListenBrainz deferral), because they depend on the receipt time.
// - Every optional field is validated with `validateDroppableField`: an
//   invalid one is dropped with a note (`dropped`), never fatal and never
//   truncated. An absent, null or empty-string value is simply absent (as
//   ListenBrainz deletes empty release_name and null or empty MBIDs).
// - Mapped values are normalized as `buildScrobbleRecord` stores them, so
//   `buildScrobbleRecord(input, …)` accepts every mapped input whose
//   listenedAt is within its receipt bound.
// - Not stored: Last.fm context, streamId, chosenByUser; ListenBrainz tags,
//   origin_url, spotify_id, media_player*, work_mbids, track_mbid. Record
//   MBIDs come from `additional_info` only: `mbid_mapping` (ListenBrainz's
//   own MusicBrainz lookup) is never copied.

import {
  type DroppableField,
  type DroppableValues,
  type JsonObject,
  MSG_REQUIRED_STRING,
  recordObject,
  type ScrobbleInput,
  type ValidationFailure,
  validateDisplayString,
  validateDroppableField,
} from './scrobble';
import { NS_PER_SECOND, toRecordDatetime } from './timestamp';

export type InvalidListenReason = 'artist_invalid' | 'track_invalid' | 'timestamp_invalid';

/** An optional field left out of the record, with the protocol key it came from. */
export interface DroppedField extends ValidationFailure {
  field: DroppableField;
  /** The protocol parameter or JSON path, e.g. `mbid` or `additional_info.isrc`. */
  source: string;
  droppable: true;
}

/** The track fields of a scrobble input (everything but listenedAt). */
export type MappedTrack = Omit<ScrobbleInput, 'listenedAt'>;

export interface InvalidListen {
  ok: false;
  reason: InvalidListenReason;
  failure: ValidationFailure;
}

export type TrackMapping = { ok: true; track: MappedTrack; dropped: DroppedField[] } | InvalidListen;

export type ListenMapping =
  | { ok: true; input: ScrobbleInput; listenedAtSeconds: number; dropped: DroppedField[] }
  | InvalidListen;

/** One Last.fm entry's parameters, without the `[i]` suffix (track.scrobble, updateNowPlaying). */
export type LastfmParams = Readonly<Record<string, string | undefined>>;

export interface LastfmOptions {
  /** The client name of the Last.fm session (`lastfm_sessions.client_name`). */
  submissionClient?: string;
}

/** The latest second a record datetime can hold (9999-12-31T23:59:59Z). */
export const MAX_LISTEN_SECONDS = 253_402_300_799;

export const MSG_LISTEN_TIME = 'expected whole seconds since the epoch';

const DIGITS = /^[0-9]+$/;

// ---------------------------------------------------------------------------
// Shared helpers

class Mapper {
  readonly track: Record<string, unknown> = {};
  readonly dropped: DroppedField[] = [];

  /** Validate and keep one optional field, or drop it with a note. */
  put(field: DroppableField, source: string, value: unknown): void {
    const v = validateDroppableField(field, value);
    if (v.ok) this.track[field] = v.value;
    else this.dropped.push({ ...v.reason, field, source, droppable: true });
  }

  /** Record a value that could not even be converted to the field's type. */
  drop(field: DroppableField, source: string, value: unknown): void {
    const v = validateDroppableField(field, value);
    // A value of the wrong type always fails its validator, so this yields a note.
    if (!v.ok) this.dropped.push({ ...v.reason, field, source, droppable: true });
  }
}

/** Absent for our purposes: missing, null or the empty string. */
function absent(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** A whole number from a JSON integer or an all-digit string; otherwise null. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && DIGITS.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function names(artist: unknown, track: unknown): { ok: true; artist: string; track: string } | InvalidListen {
  const a =
    typeof artist === 'string'
      ? validateDisplayString('artist', artist)
      : ({ ok: false, reason: invalidField('artist', MSG_REQUIRED_STRING) } as const);
  if (!a.ok) return { ok: false, reason: 'artist_invalid', failure: a.reason };
  const t =
    typeof track === 'string'
      ? validateDisplayString('track', track)
      : ({ ok: false, reason: invalidField('track', MSG_REQUIRED_STRING) } as const);
  if (!t.ok) return { ok: false, reason: 'track_invalid', failure: t.reason };
  return { ok: true, artist: a.value, track: t.value };
}

function invalidField(field: string, message: string): ValidationFailure {
  return { field, code: 'invalid_field', message };
}

function listenTime(value: unknown): { ok: true; seconds: number; listenedAt: string } | InvalidListen {
  const seconds = wholeNumber(value);
  if (seconds === null || seconds < 0 || seconds > MAX_LISTEN_SECONDS) {
    return { ok: false, reason: 'timestamp_invalid', failure: invalidField('listenedAt', MSG_LISTEN_TIME) };
  }
  return { ok: true, seconds, listenedAt: toRecordDatetime(BigInt(seconds) * NS_PER_SECOND) };
}

function finish(artist: string, track: string, m: Mapper): TrackMapping {
  return { ok: true, track: { artist, track, ...(m.track as DroppableValues) }, dropped: m.dropped };
}

function withTime(mapped: TrackMapping, time: unknown): ListenMapping {
  if (!mapped.ok) return mapped;
  const t = listenTime(time);
  if (!t.ok) return t;
  const { artist, track, ...rest } = mapped.track;
  const input: ScrobbleInput = { artist, track, listenedAt: t.listenedAt, ...rest };
  return { ok: true, input, listenedAtSeconds: t.seconds, dropped: mapped.dropped };
}

// ---------------------------------------------------------------------------
// Last.fm

/** A Last.fm integer parameter: all digits, else dropped under `field`'s message. */
function lastfmInteger(m: Mapper, field: DroppableField, source: string, raw: string): void {
  const n = DIGITS.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(n)) m.put(field, source, n);
  else m.drop(field, source, raw);
}

/**
 * The track of one Last.fm entry: `artist`, `track`, `album`, `albumArtist`,
 * `trackNumber`, `mbid` and `duration` (seconds), plus the session's client
 * name. `context`, `streamId` and `chosenByUser` (and any other key) are not
 * stored.
 */
export function mapLastfmTrack(params: LastfmParams, options: LastfmOptions = {}): TrackMapping {
  const n = names(params.artist, params.track);
  if (!n.ok) return n;
  const m = new Mapper();
  const p = (key: string): string | undefined => {
    const v = Object.hasOwn(params, key) ? params[key] : undefined;
    return absent(v) ? undefined : v;
  };
  const album = p('album');
  if (album !== undefined) m.put('album', 'album', album);
  const albumArtist = p('albumArtist');
  if (albumArtist !== undefined) m.put('albumArtist', 'albumArtist', albumArtist);
  const trackNumber = p('trackNumber');
  if (trackNumber !== undefined) lastfmInteger(m, 'trackNumber', 'trackNumber', trackNumber);
  const mbid = p('mbid');
  if (mbid !== undefined) m.put('recordingMbid', 'mbid', mbid);
  const duration = p('duration');
  if (duration !== undefined) lastfmInteger(m, 'durationSeconds', 'duration', duration);
  if (!absent(options.submissionClient)) m.put('submissionClient', 'session.client_name', options.submissionClient);
  return finish(n.artist, n.track, m);
}

/** One track.scrobble entry: the track plus its `timestamp` (Unix seconds). */
export function mapLastfmScrobble(params: LastfmParams, options: LastfmOptions = {}): ListenMapping {
  return withTime(mapLastfmTrack(params, options), Object.hasOwn(params, 'timestamp') ? params.timestamp : undefined);
}

// ---------------------------------------------------------------------------
// ListenBrainz

/** ASCII-only uppercase, so a non-ASCII letter can never be folded into a valid ISRC. */
function asciiUpper(value: string): string {
  return value.replace(/[a-z]/g, (c) => c.toUpperCase());
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** duration_ms to whole seconds, rounded half up, at least 1. */
export function durationMsToSeconds(ms: number): number {
  return Math.max(1, Math.floor((ms + 500) / 1000));
}

/**
 * A ListenBrainz `track_metadata` object: `artist_name`, `track_name`,
 * `release_name` and the mapped `additional_info` keys (§6.2).
 */
export function mapListenBrainzTrack(trackMetadata: unknown): TrackMapping {
  const meta: JsonObject = recordObject(trackMetadata) ?? {};
  const get = (o: JsonObject, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);
  const n = names(get(meta, 'artist_name'), get(meta, 'track_name'));
  if (!n.ok) return n;
  const m = new Mapper();
  const release = get(meta, 'release_name');
  if (!absent(release)) m.put('album', 'release_name', release);

  // mbid_mapping is deliberately never read.
  const info: JsonObject = recordObject(get(meta, 'additional_info')) ?? {};
  const at = (key: string): unknown => {
    const v = get(info, key);
    return absent(v) ? undefined : v;
  };
  const src = (key: string) => `additional_info.${key}`;

  const releaseArtist = at('release_artist_name');
  if (releaseArtist !== undefined) m.put('albumArtist', src('release_artist_name'), releaseArtist);

  const trackNumber = at('tracknumber');
  if (trackNumber !== undefined) {
    const t = wholeNumber(trackNumber);
    if (t !== null) m.put('trackNumber', src('tracknumber'), t);
    else m.drop('trackNumber', src('tracknumber'), trackNumber);
  }

  const artistMbids = at('artist_mbids');
  if (artistMbids !== undefined && !(Array.isArray(artistMbids) && artistMbids.length === 0)) {
    m.put('artistMbids', src('artist_mbids'), artistMbids);
  }
  for (const [key, field] of [
    ['recording_mbid', 'recordingMbid'],
    ['release_mbid', 'releaseMbid'],
    ['release_group_mbid', 'releaseGroupMbid'],
  ] as const) {
    const v = at(key);
    if (v !== undefined) m.put(field, src(key), v);
  }

  const isrc = at('isrc');
  if (isrc !== undefined) m.put('isrc', src('isrc'), typeof isrc === 'string' ? asciiUpper(isrc) : isrc);

  // duration (seconds) first, else duration_ms rounded half up.
  const duration = at('duration');
  const durationMs = at('duration_ms');
  if (duration !== undefined) {
    const d = wholeNumber(duration);
    if (d !== null) m.put('durationSeconds', src('duration'), d);
    else m.drop('durationSeconds', src('duration'), duration);
  } else if (durationMs !== undefined) {
    const ms = wholeNumber(durationMs);
    if (ms !== null && ms >= 1) m.put('durationSeconds', src('duration_ms'), durationMsToSeconds(ms));
    else m.drop('durationSeconds', src('duration_ms'), durationMs);
  }

  const client = at('submission_client');
  if (client !== undefined) {
    const version = at('submission_client_version');
    const full = typeof client === 'string' && typeof version === 'string' ? `${client} ${version}` : client;
    m.put('submissionClient', src('submission_client'), full);
  }

  const service = at('music_service');
  if (service !== undefined) {
    // DNS names are case-insensitive, so lowercasing loses nothing.
    m.put('musicService', src('music_service'), typeof service === 'string' ? asciiLower(service) : service);
  }
  return finish(n.artist, n.track, m);
}

/** One ListenBrainz listen (`single` or `import`): its track_metadata plus `listened_at`. */
export function mapListenBrainzListen(listen: unknown): ListenMapping {
  const object: JsonObject = recordObject(listen) ?? {};
  const get = (key: string): unknown => (Object.hasOwn(object, key) ? object[key] : undefined);
  return withTime(mapListenBrainzTrack(get('track_metadata')), get('listened_at'));
}
