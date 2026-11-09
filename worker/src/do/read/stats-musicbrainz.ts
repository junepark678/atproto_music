import type { Statistics } from '@atmusic/core/api-types';
import { albumKey, artistKey, trackKey } from '@atmusic/core/music-key';
import type { Db } from '../db';

/**
 * Add IDs from local matched rows after stats-cache reads/writes. The cache
 * intentionally stores only count/display data, so a newly resolved match is
 * visible immediately without changing stats_version or serving stale IDs.
 */
export function withStatsMusicBrainz(db: Db, statistics: Statistics): Statistics {
  const artists = statistics.topArtists.map((row) => ({ row, key: artistKey(row.artist) }));
  const tracks = statistics.topTracks.map((row) => ({ row, key: trackKey(row.artist, row.track) }));
  const albums = statistics.topAlbums.map((row) => ({ row, key: albumKey(row.artist, row.album)! }));

  if (artists.length > 0) {
    const rows = db.all<{ key: string; mbid: string | null }>(
      `WITH requested AS (SELECT value AS key FROM json_each(?))
       SELECT r.key,
         CASE WHEN count(DISTINCT CASE WHEN json_array_length(m.artist_mbids)=1
                                       THEN json_extract(m.artist_mbids,'$[0]') END)=1
                   AND sum(CASE WHEN json_array_length(m.artist_mbids)>1 THEN 1 ELSE 0 END)=0
              THEN min(CASE WHEN json_array_length(m.artist_mbids)=1
                            THEN json_extract(m.artist_mbids,'$[0]') END) END AS mbid
       FROM requested r LEFT JOIN mb_tracks m ON m.artist_key=r.key AND m.status='matched'
       GROUP BY r.key`,
      JSON.stringify(artists.map(({ key }) => key)),
    );
    const byKey = new Map(rows.map((row) => [row.key, row.mbid]));
    for (const item of artists) {
      const mbid = byKey.get(item.key);
      if (mbid != null) item.row.artistMbid = mbid;
    }
  }

  if (tracks.length > 0) {
    const rows = db.all<{ artist_key: string; track_key: string; mbid: string | null }>(
      `WITH requested AS (
         SELECT json_extract(value,'$[0]') AS artist_key, json_extract(value,'$[1]') AS track_key
         FROM json_each(?))
       SELECT r.artist_key, r.track_key,
         CASE WHEN count(DISTINCT m.recording_mbid)=1 THEN min(m.recording_mbid) END AS mbid
       FROM requested r LEFT JOIN mb_tracks m ON m.artist_key=r.artist_key AND m.track_key=r.track_key
         AND m.status='matched' AND m.recording_mbid IS NOT NULL
       GROUP BY r.artist_key, r.track_key`,
      JSON.stringify(tracks.map(({ key }) => key)),
    );
    const byKey = new Map(rows.map((row) => [JSON.stringify([row.artist_key, row.track_key]), row.mbid]));
    for (const item of tracks) {
      const mbid = byKey.get(JSON.stringify(item.key));
      if (mbid != null) item.row.recordingMbid = mbid;
    }
  }

  if (albums.length > 0) {
    const rows = db.all<{
      artist_key: string;
      album_key: string;
      release_mbid: string | null;
      release_group_mbid: string | null;
    }>(
      `WITH requested AS (
         SELECT json_extract(value,'$[0]') AS artist_key, json_extract(value,'$[1]') AS album_key
         FROM json_each(?))
       SELECT r.artist_key, r.album_key,
         CASE WHEN count(DISTINCT m.release_mbid)=1 THEN min(m.release_mbid) END AS release_mbid,
         CASE WHEN count(DISTINCT m.release_group_mbid)=1 THEN min(m.release_group_mbid) END AS release_group_mbid
       FROM requested r LEFT JOIN mb_tracks m ON m.artist_key=r.artist_key AND m.album_key=r.album_key
         AND m.status='matched'
       GROUP BY r.artist_key, r.album_key`,
      JSON.stringify(albums.map(({ key }) => key)),
    );
    const byKey = new Map(rows.map((row) => [JSON.stringify([row.artist_key, row.album_key]), row]));
    for (const item of albums) {
      const match = byKey.get(JSON.stringify(item.key));
      if (match?.release_mbid != null) item.row.releaseMbid = match.release_mbid;
      if (match?.release_group_mbid != null) item.row.releaseGroupMbid = match.release_group_mbid;
    }
  }
  return statistics;
}
