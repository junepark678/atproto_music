export const MUSICBRAINZ_SCROBBLE_JOIN = `LEFT JOIN mb_tracks mb ON mb.status='matched'
  AND mb.artist_key=s.artist_key AND mb.track_key=s.track_key AND mb.album_key=COALESCE(s.album_key,'')`;
export const MUSICBRAINZ_SCROBBLE_COLUMNS = `mb.recording_mbid AS mb_recording_mbid, mb.title AS mb_title,
  mb.artist_credit AS mb_artist_credit, mb.artist_mbids AS mb_artist_mbids, mb.release_mbid AS mb_release_mbid,
  mb.release_title AS mb_release_title, mb.release_group_mbid AS mb_release_group_mbid,
  mb.duration_ms AS mb_duration_ms, mb.matched_by AS mb_matched_by, mb.synced_at_ms AS mb_synced_at_ms`;
