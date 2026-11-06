// Music grouping keys, ported exactly from crates/core/src/music_key.rs (W1-02,
// ADR 0004 §9.1 "Grouping", TESTING.md "Normalize NFKC → full Unicode case-fold
// → trim → collapse Unicode whitespace").
//
// - NFKC comes from the runtime's ICU (`String.prototype.normalize`), which may be
//   a newer Unicode version than 16.0.0 (workerd's ICU is Unicode 17). Only runs of
//   code points assigned in Unicode 16.0.0 (vendored DerivedAge-16.0.0) are handed
//   to it: by the Unicode normalization stability policy their NFKC is the same in
//   every version >= 16.0.0. A code point unassigned in 16.0.0 is copied verbatim
//   and splits the runs, which is exactly how Unicode 16.0.0 NFKC treats it (no
//   decomposition, combining class 0, no composition). The workerd test
//   (test/unicode-runtime.test.ts) compares every scalar value in several contexts
//   with the Rust oracle and catches any remaining ICU drift (ADR §13.5).
// - Full default case folding uses the vendored CaseFolding-16.0.0 C+F table, the
//   same data the Rust `caseless` crate applies.
// - Trim and collapse use the Unicode White_Space set (Rust `split_whitespace`).
//
// The artist key is one string; track and album keys are typed tuples, so
// separators inside display strings can never merge two groups. Storage columns
// hold the normalized component strings; sorting must use `compareCodePoints`.
// MBIDs are not keys and multi-artist credits are not split.

import { isAssigned } from './unicode/assigned-16.0.0';
import { CASE_FOLDING_C_F } from './unicode/casefold-16.0.0';
import { compareCodePoints, compareCodePointTuples, type Ordering } from './unicode/compare';
import { collapseWhiteSpace, trimWhiteSpace } from './unicode/white-space';

export { compareCodePoints, compareCodePointTuples, type Ordering };

/**
 * Unicode version of the whole grouping pipeline (Rust GROUPING_UNICODE_VERSION):
 * vendored case folding, White_Space and assigned-code-point data, and NFKC as
 * Unicode 16.0.0 defines it. NFKC uses the runtime, so this holds only where
 * `nfkcRuntimeSupportsGroupingVersion()` is true (workerd: tested; a browser with
 * an older ICU is not, and must not be trusted to produce storage keys).
 */
export const GROUPING_UNICODE_VERSION = '16.0.0';

/** Rust `validate_display_string` message, byte-for-byte. */
export const DISPLAY_STRING_MESSAGE =
  'expected 1–256 Unicode scalars and at most 1024 UTF-8 bytes, with nonempty trimmed text';

export const MAX_DISPLAY_SCALARS = 256;
export const MAX_DISPLAY_UTF8_BYTES = 1024;

export type MusicField = 'artist' | 'track' | 'album';

/** A display string a key cannot be built from; mirrors the Rust `ValidationError`. */
export class MusicKeyError extends Error {
  readonly code = 'invalid_field' as const;
  constructor(readonly field: MusicField) {
    super(DISPLAY_STRING_MESSAGE);
    this.name = 'MusicKeyError';
  }
}

/** The normalized credited-artist string. */
export type ArtistKey = string;
/** (normalized artist, normalized track); compare with `compareMusicKeys`. */
export type TrackKey = readonly [artist: string, track: string];
/** (normalized artist, normalized album); compare with `compareMusicKeys`. */
export type AlbumKey = readonly [artist: string, album: string];

let foldMap: Map<number, string> | undefined;

function caseFoldMap(): Map<number, string> {
  if (foldMap === undefined) {
    foldMap = new Map();
    for (const [source, ...target] of CASE_FOLDING_C_F) foldMap.set(source!, String.fromCodePoint(...target));
  }
  return foldMap;
}

/** Full (non-Turkic) default Unicode case folding, Unicode 16.0.0. No normalization. */
export function caseFold(s: string): string {
  const map = caseFoldMap();
  let out = '';
  for (const ch of s) out += map.get(ch.codePointAt(0)!) ?? ch;
  return out;
}

/**
 * True when the runtime's NFKC knows Unicode 16.0.0 additions, which the
 * assigned-only guard in `nfkc16` relies on: a compatibility mapping (U+1CCD6
 * OUTLINED LATIN CAPITAL LETTER A -> A) and a canonical composition (Kirat Rai
 * U+16D63 U+16D67 -> U+16D69), both new in 16.0.0. A necessary check, not a proof;
 * the exhaustive workerd test is the proof for the worker.
 */
export function nfkcRuntimeSupportsGroupingVersion(): boolean {
  return '\u{1CCD6}'.normalize('NFKC') === 'A' && '\u{16D63}\u{16D67}'.normalize('NFKC') === '\u{16D69}';
}

/**
 * Unicode 16.0.0 NFKC on a runtime whose ICU is Unicode 16.0.0 or newer: each
 * maximal run of code points assigned in 16.0.0 is normalized by the runtime, and
 * every code point unassigned in 16.0.0 is kept as is between the runs.
 */
function nfkc16(s: string): string {
  let out = '';
  let runStart = 0;
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    if (!isAssigned(cp)) {
      out += s.slice(runStart, i).normalize('NFKC') + s.slice(i, i + width);
      runStart = i + width;
    }
    i += width;
  }
  return runStart === 0 ? s.normalize('NFKC') : out + s.slice(runStart).normalize('NFKC');
}

/**
 * Rust `music_key::normalize`: NFKC, then full case folding, then White_Space trim
 * and collapse of inner runs to one U+0020. Has no length limit of its own.
 * Throws a RangeError for a string with lone surrogates, which no Rust string can
 * hold and which must already have been rejected at the input boundary.
 */
export function normalizeMusic(s: string): string {
  if (!s.isWellFormed()) throw new RangeError('music key input contains a lone surrogate');
  return collapseWhiteSpace(caseFold(nfkc16(s)));
}

function utf8Length(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Rust `validate_display_string`: nonempty after White_Space trim, at most 256
 * scalar values and 1024 UTF-8 bytes (measured before trimming). Lone surrogates
 * are not scalar values, so they are rejected with the same error.
 */
function checkDisplayString(field: MusicField, value: string): void {
  if (!value.isWellFormed()) throw new MusicKeyError(field);
  // Code units bound scalars from above and bytes from below, so this is a cheap pre-check.
  if (value.length > MAX_DISPLAY_UTF8_BYTES) throw new MusicKeyError(field);
  let scalars = 0;
  for (const _ of value) scalars++;
  if (trimWhiteSpace(value) === '' || scalars > MAX_DISPLAY_SCALARS || utf8Length(value) > MAX_DISPLAY_UTF8_BYTES) {
    throw new MusicKeyError(field);
  }
}

/** Rust `ArtistKey::new`. Throws `MusicKeyError` (field `artist`). */
export function artistKey(artist: string): ArtistKey {
  checkDisplayString('artist', artist);
  return normalizeMusic(artist);
}

/** Rust `TrackKey::new`: the track is validated before the artist, as in Rust. */
export function trackKey(artist: string, track: string): TrackKey {
  checkDisplayString('track', track);
  return [artistKey(artist), normalizeMusic(track)];
}

/**
 * Rust `AlbumKey::optional`. An omitted album (`undefined` or `null`) has no
 * ranking key and yields `null`; a supplied album that is empty or White_Space
 * only is invalid. The artist is validated first, even when the album is omitted.
 */
export function albumKey(artist: string, album?: string | null): AlbumKey | null {
  const artistPart = artistKey(artist);
  if (album === undefined || album === null) return null;
  checkDisplayString('album', album);
  return [artistPart, normalizeMusic(album)];
}

/** Rust tuple `Ord` of track or album keys (code-point order per component). */
export function compareMusicKeys(a: TrackKey | AlbumKey, b: TrackKey | AlbumKey): Ordering {
  return compareCodePointTuples(a, b);
}

/** An injective string id for a tuple key, for Map/Set grouping in JavaScript. */
export function musicKeyId(key: TrackKey | AlbumKey): string {
  return JSON.stringify(key);
}

/** A confirmed record's original display text with its ordering evidence. */
export interface DisplayCandidate {
  /** listenedAt as nanoseconds since the Unix epoch (UTC). */
  readonly listenedAtNs: bigint;
  readonly uri: string;
}

/**
 * Rust `newest_display`: the newest listen wins, then the code-point-greatest full
 * AT URI on an equal timestamp (the public descending listen order). The display
 * spelling of the winner is returned unnormalized by the caller. `null` if empty.
 */
export function newestDisplay<T extends DisplayCandidate>(candidates: Iterable<T>): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      candidate.listenedAtNs > best.listenedAtNs ||
      (candidate.listenedAtNs === best.listenedAtNs && compareCodePoints(candidate.uri, best.uri) >= 0)
    ) {
      best = candidate;
    }
  }
  return best;
}
