import { describe, expect, it } from 'vitest';
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
});
