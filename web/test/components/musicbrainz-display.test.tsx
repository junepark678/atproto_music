import type { Scrobble, Statistics } from '@atmusic/core/api-types';
import { render } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { isMbid, unambiguousMbid } from '../../src/components/musicbrainz-links';
import { ScrobbleText } from '../../src/components/scrobble-list';
import { StatsBody } from '../../src/components/stats-panel';

const recording = '00000000-0000-4000-8000-000000000001';
const artist = '00000000-0000-4000-8000-000000000002';
const release = '00000000-0000-4000-8000-000000000003';

function scrobble(overrides: Partial<Scrobble> = {}): Scrobble {
  return {
    uri: 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/one',
    cid: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
    revision: '1',
    artist: 'Submitted Artist',
    track: 'Submitted Track',
    listenedAt: '2026-11-08T12:00:00Z',
    createdAt: '2026-11-08T12:00:00Z',
    indexedAt: '2026-11-08T12:00:01Z',
    ...overrides,
  };
}

function stats(overrides: Partial<Statistics> = {}): Statistics {
  return {
    did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
    window: 'all',
    asOf: '2026-11-08T12:00:00Z',
    totalScrobbles: 1,
    distinctArtists: 1,
    distinctTracks: 1,
    topArtists: [{ artist: 'Stats Artist', scrobbleCount: 1, artistMbid: artist }],
    topTracks: [{ artist: 'Stats Artist', track: 'Stats Track', scrobbleCount: 1, recordingMbid: recording }],
    topAlbums: [{ artist: 'Stats Artist', album: 'Stats Album', scrobbleCount: 1, releaseMbid: release }],
    ...overrides,
  };
}

describe('MusicBrainz web display', () => {
  it('shows a missing submitted album from MusicBrainz with its title and subdued attribution', () => {
    const html = render(
      <ScrobbleText
        scrobble={scrobble({
          musicbrainz: {
            recordingMbid: recording,
            title: 'Canonical Track',
            artistCredit: 'Canonical Artist',
            artistMbids: [artist],
            releaseMbid: release,
            releaseTitle: 'Canonical Album',
            durationSeconds: 225,
            matchedBy: 'search',
            syncedAt: '2026-11-08T12:00:00Z',
          },
        })}
      />,
    );
    expect(html).toContain('title="From MusicBrainz"');
    expect(html).toContain('class="album album-muted"');
    expect(html).toContain('Canonical Album');
    expect(html).toContain('3:45');
    expect(html).toContain('Submitted Track');
    expect(html).not.toContain('Canonical Track</a>');
  });

  it('keeps a submitted album as primary text and links valid submitted IDs with safe rel', () => {
    const html = render(
      <ScrobbleText
        scrobble={scrobble({
          album: 'Submitted Album',
          recordingMbid: recording,
          artistMbids: [artist],
          releaseMbid: release,
          durationSeconds: 203,
        })}
      />,
    );
    expect(html).toContain('Submitted Album');
    expect(html).not.toContain('From MusicBrainz');
    expect(html).toContain(`href="https://musicbrainz.org/recording/${recording}"`);
    expect(html).toContain(`href="https://musicbrainz.org/artist/${artist}"`);
    expect(html).toContain(`href="https://musicbrainz.org/release/${release}"`);
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(3);
    expect(html).toContain('3:23');
    expect(html).not.toContain('did:plc:');
  });

  it('does not link invalid, missing or ambiguous IDs', () => {
    expect(isMbid('not-a-uuid')).toBe(false);
    expect(isMbid(undefined)).toBe(false);
    expect(unambiguousMbid([artist, release])).toBeUndefined();
    const html = render(
      <ScrobbleText
        scrobble={scrobble({ recordingMbid: 'invalid', artistMbids: [artist, release], releaseMbid: '' })}
      />,
    );
    expect(html).not.toContain('musicbrainz.org');
    expect(html).not.toContain('did:plc:');
  });

  it('links statistics only when each result has its unambiguous matching ID', () => {
    const html = render(
      <StatsBody
        stats={stats({
          topArtists: [
            { artist: 'Linked Artist', scrobbleCount: 2, artistMbid: artist },
            { artist: 'No ID Artist', scrobbleCount: 1 },
            { artist: 'Bad ID Artist', scrobbleCount: 1, artistMbid: 'invalid' },
          ],
        })}
      />,
    );
    expect(html).toContain(`href="https://musicbrainz.org/artist/${artist}"`);
    expect(html).toContain(`href="https://musicbrainz.org/recording/${recording}"`);
    expect(html).toContain(`href="https://musicbrainz.org/release/${release}"`);
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(3);
    expect(html).toContain('No ID Artist');
    expect(html).toContain('Bad ID Artist');
    expect(html).not.toContain('did:plc:');
  });
});
