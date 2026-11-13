import { buildScrobbleRecord } from '@atmusic/core/scrobble';
import { describe, expect, it } from 'vitest';
import { scrobblePayload } from '../../../src/forward/forward-outbox';
import { forwardListenMetadata } from '../../../src/outbox/forward-payload';

describe('forwardListenMetadata', () => {
  it('maps validated fields and stored columns to the shared forwarding shape', () => {
    const fields = {
      album_artist: 'Album Artist',
      track_number: 7,
      artist_mbids: '["00000000-0000-4000-8000-000000000001"]',
      release_mbid: '00000000-0000-4000-8000-000000000002',
      release_group_mbid: '00000000-0000-4000-8000-000000000003',
      isrc: 'USABC1234567',
      submission_client: 'Pano',
      music_service: 'Radio',
    };
    expect(forwardListenMetadata(fields)).toEqual({
      albumArtist: 'Album Artist',
      trackNumber: 7,
      artistMbids: ['00000000-0000-4000-8000-000000000001'],
      releaseMbid: fields.release_mbid,
      releaseGroupMbid: fields.release_group_mbid,
      isrc: fields.isrc,
      submissionClient: 'Pano',
      musicService: 'Radio',
    });
  });

  it('omits absent or malformed stored optional metadata safely', () => {
    expect(forwardListenMetadata({ artist_mbids: '{bad', release_mbid: null, track_number: 'bad' })).toEqual({});
  });

  it('omits optional text containing U+0000, which ListenBrainz rejects anywhere in a listen', () => {
    expect(
      forwardListenMetadata({
        album_artist: 'Album\u0000Artist',
        submission_client: 'Pano\u0000client',
        music_service: 'radio.example\u0000',
        artist_mbids: '["00000000-0000-4000-8000-000000000001\\u0000"]',
        isrc: 'USABC1234567',
      }),
    ).toEqual({ isrc: 'USABC1234567' });
  });

  it('a validated record whose submission client contains U+0000 still forwards, without that field', () => {
    const built = buildScrobbleRecord(
      {
        artist: 'Artist',
        track: 'Track',
        listenedAt: '2026-01-14T11:00:00Z',
        submissionClient: 'Pano\u0000client',
        albumArtist: 'Album Artist',
      },
      'com.example.atmusic',
      { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
    );
    if (!built.ok) throw new Error('the record validator accepts this submission client');
    const listen = {
      artist: 'Artist',
      track: 'Track',
      listenedAt: built.record.listenedAt,
      ...forwardListenMetadata(built.record as unknown as Record<string, unknown>),
    };
    const forwarded = scrobblePayload({ payload_json: JSON.stringify({ listen }) });
    expect(forwarded).not.toBeNull();
    expect(JSON.stringify(forwarded)).not.toContain('\\u0000');
    expect(forwarded).toMatchObject({ albumArtist: 'Album Artist' });
    expect(forwarded).not.toHaveProperty('submissionClient');
  });
});
