/**
 * Text a destination can accept: non-blank and free of U+0000. ListenBrainz
 * rejects a listen with a NUL anywhere in it (its recursive unicode-null
 * check covers additional_info), and the record validators admit NUL in
 * optional text, so such a field is left out rather than failing the listen.
 */
function forwardableText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !value.includes('\u0000');
}

/** Optional validated scrobble metadata shared by projection, imports and history backfill. */
export function forwardListenMetadata(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (target: string, camel: string, snake: string = camel) => {
    const value = fields[camel] ?? fields[snake];
    if (forwardableText(value)) out[target] = value;
  };
  copy('albumArtist', 'albumArtist', 'album_artist');
  const trackNumber = fields.trackNumber ?? fields.track_number;
  if (typeof trackNumber === 'number' && Number.isSafeInteger(trackNumber) && trackNumber > 0)
    out.trackNumber = trackNumber;
  let artists = fields.artistMbids ?? fields.artist_mbids;
  if (typeof artists === 'string') {
    try {
      artists = JSON.parse(artists) as unknown;
    } catch {
      artists = undefined;
    }
  }
  if (Array.isArray(artists) && artists.every(forwardableText)) out.artistMbids = artists;
  copy('releaseMbid', 'releaseMbid', 'release_mbid');
  copy('releaseGroupMbid', 'releaseGroupMbid', 'release_group_mbid');
  copy('isrc', 'isrc');
  copy('submissionClient', 'submissionClient', 'submission_client');
  copy('musicService', 'musicService', 'music_service');
  return out;
}
