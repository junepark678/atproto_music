// ADR 0005 §6.2: Last.fm parameters and ListenBrainz listens to a scrobble input (N1-11).
import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import {
  durationMsToSeconds,
  MSG_LISTEN_TIME,
  mapLastfmScrobble,
  mapLastfmTrack,
  mapListenBrainzListen,
  mapListenBrainzTrack,
} from '@atmusic/core/protocol-map';
import {
  buildScrobbleRecord,
  MSG_ARTIST_MBIDS,
  MSG_DISPLAY,
  MSG_DURATION,
  MSG_ISRC,
  MSG_LONE_SURROGATE,
  MSG_MUSIC_SERVICE,
  MSG_REQUIRED_STRING,
  MSG_SUBMISSION_CLIENT,
  MSG_TRACK_NUMBER,
  MSG_UUID,
} from '@atmusic/core/scrobble';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';

const P = FIXTURE_PREFIX;
const T = 1_768_474_800; // 2026-01-15T11:00:00Z
const UUID_UPPER = '3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10';
const UUID_LOWER = '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10';
const U = (n: number) => `${n.toString(16).padStart(8, '0')}-3c1d-4b9e-9a39-1f3a7c5b2d10`;

/** buildScrobbleRecord at the frozen receipt: every mapped input must be accepted by it. */
function build(input: unknown) {
  return buildScrobbleRecord(input, P, fixedClock('2026-01-15T12:00:00Z'));
}

it('Last.fm mbid, albumArtist, trackNumber and duration map to recordingMbid, albumArtist, trackNumber and durationSeconds; context, streamId and chosenByUser are dropped', () => {
  const params = {
    artist: 'Björk',
    track: 'Jóga',
    timestamp: String(T),
    album: 'Homogenic',
    albumArtist: 'Björk',
    trackNumber: '7',
    mbid: UUID_UPPER,
    duration: '305',
    context: 'playlist:123',
    streamId: '987654',
    chosenByUser: '0',
  };
  const mapped = mapLastfmScrobble(params, { submissionClient: 'Pano Scrobbler' });
  const input = {
    artist: 'Björk',
    track: 'Jóga',
    listenedAt: '2026-01-15T11:00:00Z',
    album: 'Homogenic',
    albumArtist: 'Björk',
    trackNumber: 7,
    recordingMbid: UUID_LOWER,
    durationSeconds: 305,
    submissionClient: 'Pano Scrobbler',
  };
  expect(mapped).toEqual({ ok: true, input, listenedAtSeconds: T, dropped: [] });
  if (!mapped.ok) throw new Error('unreachable');
  for (const key of ['context', 'streamId', 'chosenByUser', 'mbid', 'duration', 'timestamp']) {
    expect({ key, present: Object.hasOwn(mapped.input, key) }).toEqual({ key, present: false });
  }
  // The mapped input is a valid closed scrobble input; the record carries exactly the mapped fields.
  expect(build(mapped.input)).toEqual({
    ok: true,
    record: {
      $type: `${P}.scrobble`,
      ...input,
      listenedAt: '2026-01-15T11:00:00.000000000Z',
      createdAt: '2026-01-15T12:00:00Z',
    },
  });

  // Empty optional parameters (as many clients send them) are simply absent, without a note.
  expect(
    mapLastfmScrobble({ artist: 'Björk', track: 'Jóga', timestamp: String(T), album: '', mbid: '', duration: '' }),
  ).toEqual({
    ok: true,
    input: { artist: 'Björk', track: 'Jóga', listenedAt: '2026-01-15T11:00:00Z' },
    listenedAtSeconds: T,
    dropped: [],
  });
  // updateNowPlaying maps the same track fields without a timestamp; names are trimmed.
  expect(mapLastfmTrack({ artist: ' Björk ', track: 'Jóga', duration: '305', streamId: '1' })).toEqual({
    ok: true,
    track: { artist: 'Björk', track: 'Jóga', durationSeconds: 305 },
    dropped: [],
  });
});

it("ListenBrainz release_name, duration_ms 222500 (to 223), artist_mbids, release_mbid, release_group_mbid, isrc, tracknumber '7' and submission_client map; tags, origin_url and mbid_mapping are not copied into the record", () => {
  const listen = {
    listened_at: T,
    track_metadata: {
      artist_name: 'Björk',
      track_name: 'Jóga',
      release_name: 'Homogenic',
      additional_info: {
        release_artist_name: 'Björk',
        duration_ms: 222500,
        artist_mbids: [UUID_UPPER, U(1)],
        recording_mbid: U(2),
        release_mbid: U(3),
        release_group_mbid: U(4),
        isrc: 'usrc17607839',
        tracknumber: '7',
        submission_client: 'BrainzPlayer',
        submission_client_version: '1.2.3',
        music_service: 'Spotify.com',
        tags: ['electronic', 'icelandic'],
        origin_url: 'https://open.spotify.com/track/abc',
        spotify_id: 'https://open.spotify.com/track/abc',
        media_player: 'Firefox',
        media_player_version: '130',
        work_mbids: [U(5)],
        track_mbid: U(6),
      },
      mbid_mapping: {
        recording_mbid: U(7),
        release_mbid: U(8),
        artist_mbids: [U(9)],
        recording_name: 'Joga',
      },
    },
  };
  const input = {
    artist: 'Björk',
    track: 'Jóga',
    listenedAt: '2026-01-15T11:00:00Z',
    album: 'Homogenic',
    albumArtist: 'Björk',
    durationSeconds: 223,
    artistMbids: [UUID_LOWER, U(1)],
    recordingMbid: U(2),
    releaseMbid: U(3),
    releaseGroupMbid: U(4),
    isrc: 'USRC17607839',
    trackNumber: 7,
    submissionClient: 'BrainzPlayer 1.2.3',
    musicService: 'spotify.com',
  };
  const mapped = mapListenBrainzListen(listen);
  expect(mapped).toEqual({ ok: true, input, listenedAtSeconds: T, dropped: [] });
  if (!mapped.ok) throw new Error('unreachable');
  const built = build(mapped.input);
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error('unreachable');
  const json = JSON.stringify(built.record);
  for (const absent of ['electronic', 'open.spotify.com', 'Firefox', U(5), U(6), U(7), U(8), U(9), 'Joga']) {
    expect({ absent, found: json.includes(absent) }).toEqual({ absent, found: false });
  }
  expect(Object.keys(built.record).sort()).toEqual(['$type', 'createdAt', ...Object.keys(input)].sort());

  // mbid_mapping is never a fallback, even when additional_info has no MBIDs.
  expect(
    mapListenBrainzListen({
      listened_at: String(T),
      track_metadata: {
        artist_name: 'Björk',
        track_name: 'Jóga',
        mbid_mapping: { recording_mbid: U(7), release_mbid: U(8), artist_mbids: [U(9)] },
      },
    }),
  ).toEqual({
    ok: true,
    input: { artist: 'Björk', track: 'Jóga', listenedAt: '2026-01-15T11:00:00Z' },
    listenedAtSeconds: T,
    dropped: [],
  });

  // duration (seconds) wins over duration_ms; duration_ms rounds half up, minimum 1;
  // an integer tracknumber maps too; empty release_name and null MBIDs are absent.
  expect(durationMsToSeconds(222_499)).toBe(222);
  expect(durationMsToSeconds(222_500)).toBe(223);
  expect(durationMsToSeconds(1)).toBe(1);
  expect(
    mapListenBrainzTrack({
      artist_name: 'Björk',
      track_name: 'Jóga',
      release_name: '',
      additional_info: { duration: 300, duration_ms: 1, tracknumber: 12, recording_mbid: null, artist_mbids: [] },
    }),
  ).toEqual({
    ok: true,
    track: { artist: 'Björk', track: 'Jóga', durationSeconds: 300, trackNumber: 12 },
    dropped: [],
  });
  expect(
    mapListenBrainzTrack({ artist_name: 'Björk', track_name: 'Jóga', additional_info: { duration_ms: 400 } }),
  ).toEqual({ ok: true, track: { artist: 'Björk', track: 'Jóga', durationSeconds: 1 }, dropped: [] });
});

it('an invalid optional field is dropped with a note; an invalid artist or track makes the listen invalid with its reason', () => {
  const note = (field: string, source: string, message: string) => ({
    field,
    source,
    code: 'invalid_field',
    message,
    droppable: true,
  });

  // Last.fm: each invalid optional is dropped (not truncated), the listen stays valid.
  const lastfm = mapLastfmScrobble(
    {
      artist: 'Björk',
      track: 'Jóga',
      timestamp: String(T),
      album: '   ',
      albumArtist: 'Björk',
      trackNumber: '0',
      mbid: 'not-a-uuid',
      duration: '12.5',
    },
    { submissionClient: 'c'.repeat(65) },
  );
  expect(lastfm).toEqual({
    ok: true,
    input: { artist: 'Björk', track: 'Jóga', listenedAt: '2026-01-15T11:00:00Z', albumArtist: 'Björk' },
    listenedAtSeconds: T,
    dropped: [
      note('album', 'album', MSG_DISPLAY),
      note('trackNumber', 'trackNumber', MSG_TRACK_NUMBER),
      note('recordingMbid', 'mbid', MSG_UUID),
      note('durationSeconds', 'duration', MSG_DURATION),
      note('submissionClient', 'session.client_name', MSG_SUBMISSION_CLIENT),
    ],
  });
  if (!lastfm.ok) throw new Error('unreachable');
  expect(build(lastfm.input)).toMatchObject({ ok: true });

  // ListenBrainz: the same rule for every additional_info field.
  const longClient = 'BrainzPlayer'.padEnd(60, 'x');
  const lb = mapListenBrainzListen({
    listened_at: T,
    track_metadata: {
      artist_name: 'Björk',
      track_name: 'Jóga',
      release_name: 'Homogenic',
      additional_info: {
        release_artist_name: 'b'.repeat(257),
        tracknumber: '7/12',
        artist_mbids: [U(1), U(1).toUpperCase()],
        release_mbid: 'nope',
        isrc: 'XX',
        duration_ms: 0,
        submission_client: longClient,
        submission_client_version: '10.0.0',
        music_service: 'not a host',
      },
    },
  });
  expect(lb).toEqual({
    ok: true,
    input: { artist: 'Björk', track: 'Jóga', listenedAt: '2026-01-15T11:00:00Z', album: 'Homogenic' },
    listenedAtSeconds: T,
    dropped: [
      note('albumArtist', 'additional_info.release_artist_name', MSG_DISPLAY),
      note('trackNumber', 'additional_info.tracknumber', MSG_TRACK_NUMBER),
      note('artistMbids', 'additional_info.artist_mbids', MSG_ARTIST_MBIDS),
      note('releaseMbid', 'additional_info.release_mbid', MSG_UUID),
      note('isrc', 'additional_info.isrc', MSG_ISRC),
      note('durationSeconds', 'additional_info.duration_ms', MSG_DURATION),
      note('submissionClient', 'additional_info.submission_client', MSG_SUBMISSION_CLIENT),
      note('musicService', 'additional_info.music_service', MSG_MUSIC_SERVICE),
    ],
  });
  if (!lb.ok) throw new Error('unreachable');
  expect(build(lb.input)).toMatchObject({ ok: true });

  // Invalid names make the listen invalid, artist before track.
  const invalid = (reason: string, field: string, message: string) => ({
    ok: false,
    reason,
    failure: { field, code: 'invalid_field', message },
  });
  expect(mapLastfmScrobble({ artist: 'a'.repeat(257), track: 'Jóga', timestamp: String(T) })).toEqual(
    invalid('artist_invalid', 'artist', MSG_DISPLAY),
  );
  expect(mapLastfmScrobble({ artist: 'Björk', track: ' 　 ', timestamp: String(T) })).toEqual(
    invalid('track_invalid', 'track', MSG_DISPLAY),
  );
  expect(mapLastfmScrobble({ artist: '', track: '', timestamp: String(T) })).toEqual(
    invalid('artist_invalid', 'artist', MSG_DISPLAY),
  );
  expect(mapLastfmTrack({ track: 'Jóga' })).toEqual(invalid('artist_invalid', 'artist', MSG_REQUIRED_STRING));
  expect(
    mapListenBrainzListen({ listened_at: T, track_metadata: { artist_name: 'x'.repeat(300), track_name: 'Jóga' } }),
  ).toEqual(invalid('artist_invalid', 'artist', MSG_DISPLAY));
  expect(
    mapListenBrainzListen({ listened_at: T, track_metadata: { artist_name: 'Björk', track_name: 'J\uD800' } }),
  ).toEqual(invalid('track_invalid', 'track', MSG_LONE_SURROGATE));
  expect(mapListenBrainzListen({ listened_at: T, track_metadata: { artist_name: 'Björk', track_name: 7 } })).toEqual(
    invalid('track_invalid', 'track', MSG_REQUIRED_STRING),
  );
  // A listen time that is not whole seconds is invalid too.
  expect(mapLastfmScrobble({ artist: 'Björk', track: 'Jóga', timestamp: '17684748OO' })).toEqual(
    invalid('timestamp_invalid', 'listenedAt', MSG_LISTEN_TIME),
  );
  expect(
    mapListenBrainzListen({ listened_at: 1.5, track_metadata: { artist_name: 'Björk', track_name: 'Jóga' } }),
  ).toEqual(invalid('timestamp_invalid', 'listenedAt', MSG_LISTEN_TIME));
});
