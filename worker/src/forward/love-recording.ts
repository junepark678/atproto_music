import { albumKey, trackKey } from '@atmusic/core/music-key';
import type { Db } from '../do/db';
import { matchedRecordingMbid } from '../musicbrainz/store';

export type LoveRecordingResolution = { mbid: string } | { terminal: true } | { pending: true };

/** Resolve the tuple projection seeds first, then its compatible album tuple. */
export function resolveLoveRecording(
  db: Db,
  track: { artist: string; track: string; album?: string },
): LoveRecordingResolution {
  const [a, t] = trackKey(track.artist, track.track);
  const primary = { artistKey: a, trackKey: t, albumKey: '' };
  const primaryMbid = matchedRecordingMbid(db, primary);
  if (primaryMbid !== null) return { mbid: primaryMbid };
  const album = track.album ? albumKey(track.artist, track.album) : null;
  const fallback = album === null ? null : { artistKey: a, trackKey: t, albumKey: album[1] };
  if (fallback !== null) {
    const fallbackMbid = matchedRecordingMbid(db, fallback);
    if (fallbackMbid !== null) return { mbid: fallbackMbid };
  }
  const primaryState = db.one<{ status: string }>(
    'SELECT status FROM mb_tracks WHERE artist_key=? AND track_key=? AND album_key=?',
    a,
    t,
    '',
  )?.status;
  const fallbackState =
    fallback === null
      ? 'unmatched'
      : db.one<{ status: string }>(
          'SELECT status FROM mb_tracks WHERE artist_key=? AND track_key=? AND album_key=?',
          fallback.artistKey,
          fallback.trackKey,
          fallback.albumKey,
        )?.status;
  return primaryState === 'unmatched' && fallbackState === 'unmatched' ? { terminal: true } : { pending: true };
}

export function loveFallbackKey(track: { artist: string; track: string; album?: string }) {
  const [a, t] = trackKey(track.artist, track.track);
  const album = track.album ? albumKey(track.artist, track.album) : null;
  return album === null ? null : { artistKey: a, trackKey: t, albumKey: album[1] };
}

export function lovePrimaryKey(track: { artist: string; track: string }) {
  const [a, t] = trackKey(track.artist, track.track);
  return { artistKey: a, trackKey: t, albumKey: '' };
}
