/// <reference types="vite/client" />
// ADR 0005 §6.2: the eight additive optional scrobble fields (N1-11).
import { canonicalDigest, canonicalJson } from '@atmusic/core/canonical';
import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import {
  buildScrobbleRecord,
  JsonFloat,
  MSG_ARTIST_MBIDS,
  MSG_DISPLAY,
  MSG_DURATION,
  MSG_HYPHENATED_UUID,
  MSG_ISRC,
  MSG_LONE_SURROGATE,
  MSG_MUSIC_SERVICE,
  MSG_OPTIONAL_STRING,
  MSG_SUBMISSION_CLIENT,
  MSG_TRACK_NUMBER,
  MSG_UNKNOWN_FIELD,
  MSG_UUID,
  OPTIONAL_FIELDS,
  parseLexiconJson,
  validateDroppableField,
  validateScrobbleRecord,
} from '@atmusic/core/scrobble';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { parseRfc3339 } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import validationJson from '../../../tests/goldens/validation.json?raw';

const P = FIXTURE_PREFIX;
const RECEIPT_NS = 1_768_478_400_000_000_000n; // 2026-01-15T12:00:00Z
const base = { artist: 'Björk', track: 'Jóga', listenedAt: '2026-01-15T11:00:00Z' };
const builtBase = {
  $type: `${P}.scrobble`,
  artist: 'Björk',
  track: 'Jóga',
  listenedAt: '2026-01-15T11:00:00.000000000Z',
  createdAt: '2026-01-15T12:00:00Z',
};
const remote = (over: Record<string, unknown> = {}) => ({
  $type: `${P}.scrobble`,
  ...base,
  createdAt: '2026-01-15T11:00:00Z',
  ...over,
});

const U = (n: number) => `${n.toString(16).padStart(8, '0')}-3c1d-4b9e-9a39-1f3a7c5b2d10`;
const UUID_UPPER = '3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10';
const UUID_LOWER = '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10';
const UUID_SIMPLE = '3f2f7f3e3c1d4b9e9a391f3a7c5b2d10';

const failure = (field: string, message: string) => ({
  ok: false,
  reason: { field, code: 'invalid_field', message },
});

it('albumArtist, trackNumber 1..9999, artistMbids (max 10, distinct UUIDs), releaseMbid, releaseGroupMbid, isrc, submissionClient and musicService accept valid and reject invalid values with exact codes', () => {
  const clock = fixedClock('2026-01-15T12:00:00Z');
  const build = (over: Record<string, unknown>) => buildScrobbleRecord({ ...base, ...over }, P, clock);

  // Accepted: [field, input value, stored value].
  const accepted: [string, unknown, unknown][] = [
    ['albumArtist', '  Björk　', 'Björk'],
    ['albumArtist', 'a'.repeat(256), 'a'.repeat(256)],
    ['trackNumber', 1, 1],
    ['trackNumber', 9999, 9999],
    ['artistMbids', [UUID_UPPER], [UUID_LOWER]],
    ['artistMbids', Array.from({ length: 10 }, (_, i) => U(i)), Array.from({ length: 10 }, (_, i) => U(i))],
    ['releaseMbid', UUID_UPPER, UUID_LOWER],
    ['releaseGroupMbid', UUID_LOWER, UUID_LOWER],
    ['isrc', 'USRC17607839', 'USRC17607839'],
    ['submissionClient', ' Web Scrobbler 3.4.0 ', 'Web Scrobbler 3.4.0'],
    ['submissionClient', '𝄞'.repeat(64), '𝄞'.repeat(64)],
    ['musicService', 'spotify.com', 'spotify.com'],
    ['musicService', 'music.youtube.com', 'music.youtube.com'],
  ];
  for (const [field, value, stored] of accepted) {
    expect({ field, value, result: build({ [field]: value }) }).toEqual({
      field,
      value,
      result: { ok: true, record: { ...builtBase, [field]: stored } },
    });
  }

  // Rejected: [field, input value, exact message]; the code is always invalid_field.
  const rejected: [string, unknown, string][] = [
    ['albumArtist', '   ', MSG_DISPLAY],
    ['albumArtist', '', MSG_DISPLAY],
    ['albumArtist', 'a'.repeat(257), MSG_DISPLAY],
    ['albumArtist', 5, MSG_OPTIONAL_STRING],
    ['albumArtist', 'x\uD800', MSG_LONE_SURROGATE],
    ['trackNumber', 0, MSG_TRACK_NUMBER],
    ['trackNumber', 10000, MSG_TRACK_NUMBER],
    ['trackNumber', 1.5, MSG_TRACK_NUMBER],
    ['trackNumber', '7', MSG_TRACK_NUMBER],
    ['trackNumber', new JsonFloat(7), MSG_TRACK_NUMBER],
    ['artistMbids', [], MSG_ARTIST_MBIDS],
    ['artistMbids', Array.from({ length: 11 }, (_, i) => U(i)), MSG_ARTIST_MBIDS],
    ['artistMbids', [UUID_LOWER, UUID_UPPER], MSG_ARTIST_MBIDS],
    ['artistMbids', UUID_LOWER, MSG_ARTIST_MBIDS],
    ['artistMbids', [5], MSG_ARTIST_MBIDS],
    ['artistMbids', ['not-a-uuid'], MSG_UUID],
    ['artistMbids', [UUID_SIMPLE], MSG_HYPHENATED_UUID],
    ['releaseMbid', 'nope', MSG_UUID],
    ['releaseMbid', UUID_SIMPLE, MSG_HYPHENATED_UUID],
    ['releaseMbid', 5, MSG_OPTIONAL_STRING],
    ['releaseGroupMbid', `{${UUID_LOWER}}`, MSG_HYPHENATED_UUID],
    ['releaseGroupMbid', 'x', MSG_UUID],
    ['isrc', 'usrc17607839', MSG_ISRC],
    ['isrc', 'USRC1760783', MSG_ISRC],
    ['isrc', 'US-RC1-76-07839', MSG_ISRC],
    ['isrc', 12, MSG_OPTIONAL_STRING],
    ['submissionClient', 'a'.repeat(65), MSG_SUBMISSION_CLIENT],
    ['submissionClient', ' ', MSG_SUBMISSION_CLIENT],
    ['submissionClient', null, MSG_OPTIONAL_STRING],
    ['musicService', 'Spotify.com', MSG_MUSIC_SERVICE],
    ['musicService', 'localhost', MSG_MUSIC_SERVICE],
    ['musicService', '-bad.com', MSG_MUSIC_SERVICE],
    ['musicService', `${'a.'.repeat(126)}com`, MSG_MUSIC_SERVICE],
    ['musicService', ['spotify.com'], MSG_OPTIONAL_STRING],
  ];
  for (const [field, value, message] of rejected) {
    expect({ field, value, result: build({ [field]: value }) }).toEqual({
      field,
      value,
      result: failure(field, message),
    });
    // The same verdict from the shared validator, marked droppable for protocol mapping.
    expect(validateDroppableField(field as (typeof OPTIONAL_FIELDS)[number], value)).toEqual({
      ok: false,
      droppable: true,
      reason: { field, code: 'invalid_field', message },
    });
  }
  // The 253-character bound itself is accepted.
  const longest = `${'a.'.repeat(125)}com`;
  expect(longest).toHaveLength(253);
  expect(build({ musicService: longest })).toEqual({ ok: true, record: { ...builtBase, musicService: longest } });

  // Every new field at once, and the v1 fields keep precedence over the new ones.
  const all = build({
    albumArtist: 'Björk',
    trackNumber: 7,
    artistMbids: [UUID_UPPER],
    releaseMbid: U(1),
    releaseGroupMbid: U(2),
    isrc: 'GBAYE0601498',
    submissionClient: 'Pano Scrobbler',
    musicService: 'tidal.com',
  });
  expect(all).toEqual({
    ok: true,
    record: {
      ...builtBase,
      albumArtist: 'Björk',
      trackNumber: 7,
      artistMbids: [UUID_LOWER],
      releaseMbid: U(1),
      releaseGroupMbid: U(2),
      isrc: 'GBAYE0601498',
      submissionClient: 'Pano Scrobbler',
      musicService: 'tidal.com',
    },
  });
  expect(build({ durationSeconds: 0, isrc: 'bad' })).toEqual(failure('durationSeconds', MSG_DURATION));
  expect(build({ trackNumber: 0, isrc: 'bad' })).toEqual(failure('trackNumber', MSG_TRACK_NUMBER));
});

it('a remote record with the new fields validates, an unknown field is still ignored, and buildScrobbleRecord rejects an unknown input field', () => {
  const extras = {
    albumArtist: '  Björk  ',
    trackNumber: 7,
    artistMbids: [UUID_UPPER, U(9)],
    releaseMbid: UUID_UPPER,
    releaseGroupMbid: U(2),
    isrc: 'USRC17607839',
    submissionClient: 'ListenBrainz 1.0',
    musicService: 'spotify.com',
  };
  const input = remote({ ...extras, mood: 'happy', release_mbid: U(3) });
  const r = validateScrobbleRecord(input, P, RECEIPT_NS);
  // Remote spelling is kept (untrimmed text, uppercase UUIDs); unknown keys are not in the record.
  expect(r).toEqual({
    ok: true,
    row: {
      record: remote(extras),
      artist: 'Björk',
      track: 'Jóga',
      album: null,
      listenedAt: '2026-01-15T11:00:00.000000000Z',
      listenedAtNs: 1_768_474_800_000_000_000n,
      createdAt: '2026-01-15T11:00:00.000000000Z',
      createdAtNs: 1_768_474_800_000_000_000n,
      durationSeconds: null,
      recordingMbid: null,
    },
  });
  if (!r.ok) throw new Error('unreachable');
  expect(Object.keys(r.row.record).sort()).toEqual(
    ['$type', 'artist', 'createdAt', 'listenedAt', 'track', ...OPTIONAL_FIELDS].sort(),
  );
  expect(r.row).not.toHaveProperty('dropped');
  // The row does not alias the caller's array.
  expect(r.row.record.artistMbids).not.toBe(extras.artistMbids);

  // An invalid new field on a remote record is dropped and reported, never fatal.
  const parsed = parseLexiconJson(
    JSON.stringify(remote({ isrc: 'usrc17607839', albumArtist: 'Björk', artistMbids: [] })).replace(
      '"artist":"Björk"',
      '"trackNumber":7.0,"artist":"Björk"',
    ),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  const d = validateScrobbleRecord(parsed.value, P, RECEIPT_NS);
  expect(d.ok).toBe(true);
  if (!d.ok) throw new Error('unreachable');
  expect(d.row.record).toEqual(remote({ albumArtist: 'Björk' }));
  expect(d.row.dropped).toEqual([
    { field: 'trackNumber', code: 'invalid_field', message: MSG_TRACK_NUMBER },
    { field: 'artistMbids', code: 'invalid_field', message: MSG_ARTIST_MBIDS },
    { field: 'isrc', code: 'invalid_field', message: MSG_ISRC },
  ]);
  // The v1 optional fields keep their v1 verdict: invalid is fatal (goldens).
  expect(validateScrobbleRecord(remote({ durationSeconds: 0, isrc: 'bad' }), P, RECEIPT_NS)).toEqual(
    failure('durationSeconds', MSG_DURATION),
  );

  // Closed local input: unknown fields are rejected by name, before any value check.
  const clock = fixedClock('2026-01-15T12:00:00Z');
  expect(buildScrobbleRecord({ ...base, mood: 'happy' }, P, clock)).toEqual(failure('mood', MSG_UNKNOWN_FIELD));
  expect(buildScrobbleRecord({ ...base, release_mbid: U(3) }, P, clock)).toEqual(
    failure('release_mbid', MSG_UNKNOWN_FIELD),
  );
  expect(buildScrobbleRecord({ ...base, isrc: 'bad', $type: `${P}.scrobble` }, P, clock)).toEqual(
    failure('$type', MSG_UNKNOWN_FIELD),
  );
  expect(buildScrobbleRecord({ ...base, createdAt: '2026-01-15T11:00:00Z', albumArtist: 'x' }, P, clock)).toEqual(
    failure('createdAt', MSG_UNKNOWN_FIELD),
  );
});

interface Vector {
  id: string;
  kind: string;
  json: string;
  receiptTime: string;
  verdict: 'accept' | 'reject';
  output: Record<string, unknown> | null;
}

it('records without the new fields keep the canonical digests in tests/goldens/validation.json', async () => {
  const golden = JSON.parse(validationJson) as { vectors: Vector[] };
  const accepted = golden.vectors.filter(
    (v) => v.verdict === 'accept' && (v.kind === 'scrobbleInput' || v.kind === 'scrobbleRecord'),
  );
  expect(accepted).toHaveLength(38);
  const digests = new Map<string, string>();
  for (const v of accepted) {
    const parsed = parseLexiconJson(v.json);
    if (!parsed.ok) throw new Error(`golden ${v.id} must parse`);
    const receiptNs = parseRfc3339(v.receiptTime);
    if (receiptNs === null) throw new Error(`bad receipt ${v.receiptTime}`);
    let output: unknown;
    if (v.kind === 'scrobbleInput') {
      const r = buildScrobbleRecord(parsed.value, P, fixedClock(v.receiptTime));
      expect({ id: v.id, ok: r.ok }).toEqual({ id: v.id, ok: true });
      output = r.ok ? r.record : null;
    } else {
      const r = validateScrobbleRecord(parsed.value, P, receiptNs);
      expect({ id: v.id, ok: r.ok }).toEqual({ id: v.id, ok: true });
      if (r.ok) expect({ id: v.id, dropped: r.row.dropped }).toEqual({ id: v.id, dropped: undefined });
      output = r.ok ? r.row.record : null;
    }
    for (const name of OPTIONAL_FIELDS) {
      expect({ id: v.id, has: Object.hasOwn(output as object, name) }).toEqual({ id: v.id, has: false });
    }
    // Byte-identical canonical JSON, hence the identical digest.
    expect({ id: v.id, json: canonicalJson(output) }).toEqual({ id: v.id, json: canonicalJson(v.output) });
    const digest = await canonicalDigest(output);
    expect({ id: v.id, digest }).toEqual({ id: v.id, digest: await canonicalDigest(v.output) });
    digests.set(v.id, digest);
  }
  // Pinned independently: sha256 of Python's sorted, compact json.dumps of the golden outputs.
  expect(digests.get('input_all_fields_valid')).toBe(
    '1202554ecf6104cea5b1b2962871162f6f2a24c33b6291eca257f3a3b4138fce',
  );
  expect(digests.get('record_remote_spelling_kept')).toBe(
    'c2086e041dc6211e259eef72c1f7552d26c21e87f11ead4d497721e95bd1fc38',
  );
});
