/// <reference types="vite/client" />
// ADR 0005 §6.3: `<p>.love` records (N1-11).
import { buildLoveRecord, loveCollection, MSG_LOVE_TYPE, validateLoveRecord } from '@atmusic/core/love';
import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import {
  buildScrobbleRecord,
  MSG_DISPLAY,
  MSG_LONE_SURROGATE,
  MSG_NOT_OBJECT,
  MSG_OPTIONAL_STRING,
  MSG_REQUIRED_STRING,
  MSG_UNKNOWN_FIELD,
  MSG_UUID,
  parseLexiconJson,
} from '@atmusic/core/scrobble';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { MSG_AT_DATETIME, MSG_BOUNDS } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import validationJson from '../../../tests/goldens/validation.json?raw';

const P = FIXTURE_PREFIX;
const LOVE = `${P}.love`;
const RECEIPT_NS = 1_768_478_400_000_000_000n; // 2026-01-15T12:00:00Z
const failure = (field: string, message: string) => ({ ok: false, reason: { field, code: 'invalid_field', message } });

it('a love needs artist and track within scrobble limits and createdAt at most receipt+300 s; album and recordingMbid are optional', () => {
  const clock = fixedClock('2026-01-15T12:00:00Z');
  const build = (input: unknown) => buildLoveRecord(input, P, clock);
  expect(loveCollection(P)).toBe('com.example.atmusic.love');
  expect(() => loveCollection('Not A Prefix')).toThrow(RangeError);

  // Minimal love: artist and track only; createdAt is the clock, $type the prefix.
  expect(build({ artist: '  Björk\u0085', track: 'Jóga' })).toEqual({
    ok: true,
    record: { $type: LOVE, artist: 'Björk', track: 'Jóga', createdAt: '2026-01-15T12:00:00Z' },
  });
  // album and recordingMbid are optional, trimmed and lowercased when present.
  expect(
    build({
      artist: 'Björk',
      track: 'Jóga',
      album: ' Homogenic ',
      recordingMbid: '3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10',
    }),
  ).toEqual({
    ok: true,
    record: {
      $type: LOVE,
      artist: 'Björk',
      track: 'Jóga',
      album: 'Homogenic',
      recordingMbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
      createdAt: '2026-01-15T12:00:00Z',
    },
  });

  // Required names and the scrobble display limits.
  expect(build({ track: 'Jóga' })).toEqual(failure('artist', MSG_REQUIRED_STRING));
  expect(build({ artist: 'Björk' })).toEqual(failure('track', MSG_REQUIRED_STRING));
  expect(build({ artist: 'a'.repeat(256), track: 't' })).toMatchObject({ ok: true });
  expect(build({ artist: 'a'.repeat(257), track: 't' })).toEqual(failure('artist', MSG_DISPLAY));
  expect(build({ artist: 'é'.repeat(256), track: 't' })).toMatchObject({ ok: true }); // 512 bytes
  expect(build({ artist: 'Björk', track: ' \t ' })).toEqual(failure('track', MSG_DISPLAY));
  expect(build({ artist: 'Björk', track: 'x\uDC00' })).toEqual(failure('track', MSG_LONE_SURROGATE));
  expect(build({ artist: 'Björk', track: 'Jóga', album: '' })).toEqual(failure('album', MSG_DISPLAY));
  expect(build({ artist: 'Björk', track: 'Jóga', album: 3 })).toEqual(failure('album', MSG_OPTIONAL_STRING));
  expect(build({ artist: 'Björk', track: 'Jóga', recordingMbid: 'nope' })).toEqual(failure('recordingMbid', MSG_UUID));
  // Closed input.
  expect(build({ artist: 'Björk', track: 'Jóga', listenedAt: '2026-01-15T11:00:00Z' })).toEqual(
    failure('listenedAt', MSG_UNKNOWN_FIELD),
  );
  expect(build({ artist: 'Björk', track: 'Jóga', createdAt: '2026-01-15T11:00:00Z' })).toEqual(
    failure('createdAt', MSG_UNKNOWN_FIELD),
  );
  expect(build([])).toEqual(failure('body', MSG_NOT_OBJECT));

  // The limits are exactly the scrobble ones: every golden scrobble-input vector
  // that fails on artist or track fails the love builder with the same reason.
  const golden = JSON.parse(validationJson) as {
    vectors: { id: string; kind: string; json: string; error: { field: string | null; stage: string } | null }[];
  };
  let compared = 0;
  for (const v of golden.vectors) {
    if (v.kind !== 'scrobbleInput' || v.error?.stage !== 'validation') continue;
    if (v.error.field !== 'artist' && v.error.field !== 'track') continue;
    const parsed = parseLexiconJson(v.json);
    if (!parsed.ok) continue;
    const { artist, track } = parsed.value as Record<string, unknown>;
    const love = build({ artist, track });
    const scrobble = buildScrobbleRecord({ artist, track, listenedAt: '2026-01-15T11:00:00Z' }, P, clock);
    expect({ id: v.id, love: love.ok ? 'ok' : love.reason }).toEqual({
      id: v.id,
      love: scrobble.ok ? 'ok' : scrobble.reason,
    });
    expect({ id: v.id, ok: love.ok }).toEqual({ id: v.id, ok: false });
    compared++;
  }
  expect(compared).toBeGreaterThanOrEqual(10);

  // Remote love records: open, remote spelling kept, createdAt ≤ receipt + 300 s.
  const remote = (over: Record<string, unknown> = {}) => ({
    $type: LOVE,
    artist: '  BJÖRK  ',
    track: 'Jóga',
    createdAt: '2026-01-15T12:05:00Z',
    ...over,
  });
  expect(validateLoveRecord(remote({ mood: 'happy' }), P, RECEIPT_NS)).toEqual({
    ok: true,
    row: {
      record: remote(),
      artist: '  BJÖRK  ',
      track: 'Jóga',
      album: null,
      recordingMbid: null,
      createdAt: '2026-01-15T12:05:00.000000000Z',
      createdAtNs: 1_768_478_700_000_000_000n,
    },
  });
  const withOptionals = validateLoveRecord(
    remote({ album: ' Homogenic', recordingMbid: '3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10' }),
    P,
    RECEIPT_NS,
  );
  expect(withOptionals).toMatchObject({
    ok: true,
    row: { album: ' Homogenic', recordingMbid: '3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10' },
  });
  expect(validateLoveRecord(remote({ createdAt: '2026-01-15T12:05:01Z' }), P, RECEIPT_NS)).toEqual(
    failure('createdAt', MSG_BOUNDS),
  );
  expect(validateLoveRecord(remote({ createdAt: '1969-12-31T23:59:59Z' }), P, RECEIPT_NS)).toEqual(
    failure('createdAt', MSG_BOUNDS),
  );
  expect(validateLoveRecord(remote({ createdAt: '2026-01-15T12:00:00+01:00' }), P, RECEIPT_NS)).toMatchObject({
    ok: false,
    reason: { field: 'createdAt', code: 'invalid_field', message: MSG_AT_DATETIME },
  });
  expect(validateLoveRecord(remote({ createdAt: undefined }), P, RECEIPT_NS)).toEqual(
    failure('createdAt', MSG_REQUIRED_STRING),
  );
  expect(validateLoveRecord(remote({ $type: `${P}.scrobble` }), P, RECEIPT_NS)).toEqual(
    failure('$type', MSG_LOVE_TYPE),
  );
  expect(validateLoveRecord(remote({ artist: 'a'.repeat(257) }), P, RECEIPT_NS)).toEqual(
    failure('artist', MSG_DISPLAY),
  );
  expect(validateLoveRecord(remote({ track: undefined }), P, RECEIPT_NS)).toEqual(
    failure('track', MSG_REQUIRED_STRING),
  );
  expect(validateLoveRecord(remote({ recordingMbid: 'x' }), P, RECEIPT_NS)).toEqual(failure('recordingMbid', MSG_UUID));
});
