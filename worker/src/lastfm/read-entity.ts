// Last.fm 2.0 entity read methods (ADR 0005 §7.5, §7.9, §10.2; N3-04):
// track.getInfo, artist.getInfo, album.getInfo and the getTopTags family.
//
// Every count is over the visible, indexed listens of every user (only
// proof-verified rows exist in `scrobbles`; do/read/visibility.ts hides
// inactive and suppressed owners): `listeners` is the number of distinct
// DIDs, `playcount` the number of listens (the global indexes of §10.2).
// Entities are matched by music key (packages/core music-key.ts), so every
// spelling variant counts; a name without a key, or one nobody listened to, is
// 6 with Last.fm's specific message. `autocorrect` is ignored: we never
// correct. Display text comes from the newest `(listened_at, uri)` listen.
//
// - track.getInfo: `artist` + `track`, or `mbid` (a recordingMbid match).
//   `duration` is in MILLISECONDS (from the newest listen with a duration,
//   else "0"), `album` from the newest listen carrying one, `toptags` empty.
//   With `username`: `userplaycount` and `userloved` ("0"/"1").
// - artist.getInfo: `artist`, or `mbid` (an artist MBID of a listen).
//   `stats {listeners, playcount, userplaycount?}`, empty `similar` and
//   `tags`, `bio {summary: "", content: ""}`.
// - album.getInfo: `artist` + `album` (the album-artist grouping, §6.5), or
//   `mbid` (a releaseMbid match). As artist.getInfo, plus `tracks.track[]`,
//   the distinct tracks seen on the album, and Last.fm's top-level
//   `listeners`/`playcount`/`userplaycount` which album clients read.
// - user/artist/track/album.getTopTags: valid empty `toptags` lists; we store
//   no tags. user.getTopTags still resolves its user (6 when unknown).

import { albumKey, artistKey, MusicKeyError, trackKey } from '@atmusic/core/music-key';
import type { ScrobbleRowV2 } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import type { SqlParam } from '../do/db';
import { isLovedKey } from '../do/read/loves';
import { globalArtistCounts, globalTrackCounts } from '../do/read/range-stats';
import { visibleScrobblesFrom } from '../do/read/visibility';
import { images, type LfmDocument, type LfmElement, type LfmValue, leaf, lfmOk, list, node } from './encode';
import { LastfmError } from './errors';
import {
  albumUrl,
  artistRef,
  artistUrl,
  firstArtistMbid,
  optionalUser,
  requiredParam,
  resolveUser,
  trackUrl,
} from './read-user';
import type { LastfmCall, LastfmMethodTable } from './routes';

export const TRACK_NOT_FOUND = 'Track not found';
export const ARTIST_NOT_FOUND = 'The artist you supplied could not be found';
export const ALBUM_NOT_FOUND = 'Album not found';

function keyOr<T>(fn: () => T, message: string): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof MusicKeyError) throw new LastfmError(6, message);
    throw err;
  }
}

function present(call: LastfmCall, name: string): string | null {
  const v = call.params.get(name);
  return v === undefined || v.trim() === '' ? null : v;
}

interface Where {
  sql: string;
  params: SqlParam[];
}

/** The newest visible listen matching `where` (optionally also `extra`), or null. */
function newest(deps: ModuleDeps, where: Where, extra = ''): ScrobbleRowV2 | null {
  return deps.db.one<ScrobbleRowV2>(
    `SELECT s.* FROM ${visibleScrobblesFrom('s', 'u')} WHERE ${where.sql}${extra}
     ORDER BY s.listened_at DESC, s.uri DESC LIMIT 1`,
    ...where.params,
  );
}

function countFor(deps: ModuleDeps, where: Where, did: string): number {
  return (
    deps.db.one<{ n: number }>(
      `SELECT count(*) AS n FROM ${visibleScrobblesFrom('s', 'u')} WHERE ${where.sql} AND s.did = ?`,
      ...where.params,
      did,
    )?.n ?? 0
  );
}

function emptyTags(name = 'tags'): LfmElement {
  return node(name, [list('tag', [])]);
}

function stats(listeners: number, playcount: number, userplaycount: number | null): LfmElement {
  const children = [leaf('listeners', listeners), leaf('playcount', playcount)];
  if (userplaycount !== null) children.push(leaf('userplaycount', userplaycount));
  return node('stats', children);
}

function bio(): LfmElement {
  return node('bio', [leaf('summary', ''), leaf('content', '')]);
}

// ---------------------------------------------------------------------------
// track.getInfo

function trackWhere(call: LastfmCall): Where {
  const mbid = present(call, 'mbid');
  const artist = present(call, 'artist');
  const track = present(call, 'track');
  if (artist === null && track === null && mbid !== null) {
    const row = newest(call.deps, { sql: 's.recording_mbid = ?', params: [mbid] });
    if (row === null) throw new LastfmError(6, TRACK_NOT_FOUND);
    return { sql: 's.artist_key = ? AND s.track_key = ?', params: [row.artist_key, row.track_key] };
  }
  const key = keyOr(
    () => trackKey(requiredParam(call.params, 'artist'), requiredParam(call.params, 'track')),
    TRACK_NOT_FOUND,
  );
  return { sql: 's.artist_key = ? AND s.track_key = ?', params: [key[0], key[1]] };
}

function trackInfo(call: LastfmCall): LfmDocument {
  const where = trackWhere(call);
  const user = optionalUser(call, 'username');
  const [ak, tk] = where.params as [string, string];
  const counts = globalTrackCounts(call.deps.db, ak, tk);
  const display = newest(call.deps, where);
  if (counts.playcount === 0 || display === null) throw new LastfmError(6, TRACK_NOT_FOUND);
  const withDuration = newest(call.deps, where, ' AND s.duration_seconds IS NOT NULL');
  const withAlbum = newest(call.deps, where, ' AND s.album IS NOT NULL');

  const children: LfmElement[] = [
    leaf('name', display.track),
    leaf('mbid', display.recording_mbid ?? ''),
    leaf('url', trackUrl(display.artist, display.track)),
    leaf('duration', (withDuration?.duration_seconds ?? 0) * 1000),
    leaf('streamable', '0', { fulltrack: '0' }),
    leaf('listeners', counts.listeners),
    leaf('playcount', counts.playcount),
    artistRef(display.artist, firstArtistMbid(display.artist_mbids)),
  ];
  if (withAlbum?.album != null) {
    const albumArtist = withAlbum.album_artist ?? withAlbum.artist;
    children.push(
      node('album', [
        leaf('artist', albumArtist),
        leaf('title', withAlbum.album),
        leaf('mbid', withAlbum.release_mbid ?? ''),
        leaf('url', albumUrl(albumArtist, withAlbum.album)),
        images(),
      ]),
    );
  }
  if (user !== null) {
    children.push(leaf('userplaycount', countFor(call.deps, where, user.did)));
    children.push(leaf('userloved', isLovedKey(call.deps, user.did, ak, tk) ? '1' : '0'));
  }
  children.push(emptyTags('toptags'));
  return lfmOk(node('track', children));
}

// ---------------------------------------------------------------------------
// artist.getInfo

function artistInfo(call: LastfmCall): LfmDocument {
  const mbid = present(call, 'mbid');
  let ak: string;
  if (present(call, 'artist') === null && mbid !== null) {
    const row = newest(call.deps, {
      sql: 's.artist_mbids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(s.artist_mbids) j WHERE j.value = ?)',
      params: [mbid],
    });
    if (row === null) throw new LastfmError(6, ARTIST_NOT_FOUND);
    ak = row.artist_key;
  } else {
    ak = keyOr(() => artistKey(requiredParam(call.params, 'artist')), ARTIST_NOT_FOUND);
  }
  const user = optionalUser(call, 'username');
  const where: Where = { sql: 's.artist_key = ?', params: [ak] };
  const counts = globalArtistCounts(call.deps.db, ak);
  const display = newest(call.deps, where);
  if (counts.playcount === 0 || display === null) throw new LastfmError(6, ARTIST_NOT_FOUND);
  const userplaycount = user === null ? null : countFor(call.deps, where, user.did);
  return lfmOk(
    node('artist', [
      leaf('name', display.artist),
      leaf('mbid', firstArtistMbid(display.artist_mbids)),
      leaf('url', artistUrl(display.artist)),
      images(),
      leaf('streamable', '0'),
      leaf('ontour', '0'),
      stats(counts.listeners, counts.playcount, userplaycount),
      node('similar', [list('artist', [])]),
      emptyTags(),
      bio(),
    ]),
  );
}

// ---------------------------------------------------------------------------
// album.getInfo

const ALBUM_GROUP = 'coalesce(s.album_artist_key, s.artist_key) = ? AND s.album_key = ?';

function albumWhere(call: LastfmCall): Where {
  const mbid = present(call, 'mbid');
  if (present(call, 'artist') === null && present(call, 'album') === null && mbid !== null) {
    const row = newest(call.deps, { sql: 's.release_mbid = ? AND s.album_key IS NOT NULL', params: [mbid] });
    if (row === null || row.album_key === null) throw new LastfmError(6, ALBUM_NOT_FOUND);
    return { sql: ALBUM_GROUP, params: [row.album_artist_key ?? row.artist_key, row.album_key] };
  }
  const key = keyOr(
    () => albumKey(requiredParam(call.params, 'artist'), requiredParam(call.params, 'album')),
    ALBUM_NOT_FOUND,
  );
  if (key === null) throw new LastfmError(6, ALBUM_NOT_FOUND);
  return { sql: ALBUM_GROUP, params: [key[0], key[1]] };
}

interface AlbumTrackRow {
  artist: string;
  track: string;
  artist_mbids: string | null;
  duration_seconds: number | null;
}

function albumInfo(call: LastfmCall): LfmDocument {
  const where = albumWhere(call);
  const user = optionalUser(call, 'username');
  const db = call.deps.db;
  const counts = db.one<{ listeners: number; playcount: number }>(
    `SELECT count(DISTINCT s.did) AS listeners, count(*) AS playcount FROM ${visibleScrobblesFrom('s', 'u')}
     WHERE ${where.sql}`,
    ...where.params,
  ) ?? { listeners: 0, playcount: 0 };
  const display = newest(call.deps, where);
  if (counts.playcount === 0 || display === null || display.album === null) {
    throw new LastfmError(6, ALBUM_NOT_FOUND);
  }
  const albumArtist = display.album_artist ?? display.artist;
  const userplaycount = user === null ? null : countFor(call.deps, where, user.did);

  // The distinct tracks of the album: track number first (when known), then the key tuple.
  const tracks = db.all<AlbumTrackRow>(
    `WITH w AS (SELECT s.uri, s.listened_at, s.artist_key, s.track_key, s.track_number, s.duration_seconds
                FROM ${visibleScrobblesFrom('s', 'u')} WHERE ${where.sql}),
          g AS (SELECT artist_key, track_key, min(track_number) AS n, max(listened_at || ' ' || uri) AS newest,
                       max(CASE WHEN duration_seconds IS NOT NULL THEN listened_at || ' ' || uri END) AS newest_dur
                FROM w GROUP BY artist_key, track_key)
     SELECT d.artist AS artist, d.track AS track, d.artist_mbids AS artist_mbids, dd.duration_seconds AS duration_seconds
     FROM g JOIN scrobbles d ON d.uri = substr(g.newest, 32)
     LEFT JOIN scrobbles dd ON dd.uri = substr(g.newest_dur, 32)
     ORDER BY g.n IS NULL, g.n, g.artist_key, g.track_key`,
    ...where.params,
  );
  const trackItems = tracks.map((t, i) =>
    node(
      'track',
      [
        leaf('name', t.track),
        leaf('url', trackUrl(t.artist, t.track)),
        leaf('duration', t.duration_seconds ?? 0),
        leaf('streamable', '0', { fulltrack: '0' }),
        artistRef(t.artist, firstArtistMbid(t.artist_mbids)),
      ],
      { rank: i + 1 },
    ),
  );

  const children: LfmElement[] = [
    leaf('name', display.album),
    leaf('artist', albumArtist),
    leaf('mbid', display.release_mbid ?? ''),
    leaf('url', albumUrl(albumArtist, display.album)),
    images(),
    leaf('listeners', counts.listeners),
    leaf('playcount', counts.playcount),
  ];
  if (userplaycount !== null) children.push(leaf('userplaycount', userplaycount));
  children.push(
    stats(counts.listeners, counts.playcount, userplaycount),
    node('tracks', [list('track', trackItems)]),
    node('similar', [list('artist', [])]),
    emptyTags(),
    bio(),
  );
  return lfmOk(node('album', children));
}

// ---------------------------------------------------------------------------
// getTopTags (empty)

function topTags(attrs: Record<string, LfmValue>): LfmDocument {
  return lfmOk(node('toptags', [list('tag', [])], attrs));
}

/** The entity read methods of §7.5. */
export const readEntityMethods: LastfmMethodTable = Object.freeze({
  'track.getInfo': trackInfo,
  'artist.getInfo': artistInfo,
  'album.getInfo': albumInfo,
  'user.getTopTags': (call: LastfmCall) => topTags({ user: resolveUser(call).name }),
  'artist.getTopTags': (call: LastfmCall) =>
    topTags({
      artist: present(call, 'artist') ?? (present(call, 'mbid') === null ? requiredParam(call.params, 'artist') : ''),
    }),
  'track.getTopTags': (call: LastfmCall) =>
    topTags({ artist: requiredParam(call.params, 'artist'), track: requiredParam(call.params, 'track') }),
  'album.getTopTags': (call: LastfmCall) =>
    topTags({ artist: requiredParam(call.params, 'artist'), album: requiredParam(call.params, 'album') }),
});
