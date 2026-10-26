// Last.fm 2.0 user read methods (ADR 0005 §7.5, §7.9, §9; N3-04), plus the
// helpers the other read modules share (parameters, user resolution, URLs and
// element builders).
//
// Methods: user.getRecentTracks, user.getTrackScrobbles, user.getInfo,
// user.getLovedTracks, user.getFriends and library.getArtists.
//
// Rules shared by every read (§7.3, §7.9):
// - `user` (or `username` where Last.fm names it so) resolves as in §9
//   (do/read/user-lookup.ts). When it is absent, a valid `sk` names the caller
//   (`call.caller()`); an unknown `sk` is ignored. Unknown, inactive or
//   suppressed users are 6 "User not found". The name responses carry is
//   `displayName` (username, else verified handle, else DID; credentials/
//   accounts.ts).
// - Only indexed, proof-verified data is read (do/read/*): pending operations
//   and staged imports never appear.
// - `limit` and `page`: a malformed integer is 6; `limit` is clamped to the
//   method's range; `page` must be 1 … 1,000,000. Paging is offset-based and
//   every paged container carries @attr {user, page, perPage, totalPages,
//   total}; its list always serialises as a JSON array (encode.ts list flag).
// - URLs: users `<publicOrigin>/u/<did>`; artists, tracks and albums the
//   Last.fm-style `https://www.last.fm/music/<artist>[/_/<track>|/<album>]`
//   with form encoding (`+` for a space, §18 Q10). `image` is the four empty
//   sizes, `streamable` "0", `mbid` the stored MBID or "".
//
// user.getRecentTracks (§7.9): `limit` 1–200 (default 50), `from`/`to` UNIX
// seconds with exclusive bounds `from < t < to`, newest first by
// (listened_at, uri), `date {uts, #text "DD Mon YYYY, HH:MM"}`. A current,
// shared now-playing entry is prepended on page 1 only, in addition to
// `limit`, with @attr nowplaying="true" and no date. `extended=1` turns
// `artist` into `{url, name, image, mbid}` and adds `loved` "0"/"1" by music
// key: the caller's loves when a valid `sk` names one (§7.3: a supplied `sk`
// identifies the caller for `extended=1` loved flags), else the listed
// user's. An unknown `sk` is ignored, so it falls back to the listed user.
// user.getTrackScrobbles: the same engine with an `artist` + `track` filter
// (music-key match, so spelling variants count), root `trackscrobbles`, no
// now-playing row.

import type { ScrobbleRowV2 } from '../app/rows';
import { displayName } from '../credentials/accounts';
import type { ModuleDeps } from '../do/contracts';
import { allFollowing } from '../do/read/follows';
import { isLoved, lovedKeyIds, lovedTracks, loveKeyId } from '../do/read/loves';
import { currentNowPlaying } from '../do/read/now-playing';
import { rangeStats } from '../do/read/range-stats';
import { MAX_UNIX_SECONDS, recentPage, storageToUnixSeconds } from '../do/read/recent';
import { lookupUser } from '../do/read/user-lookup';
import { activeUser, visibleScrobblesFrom } from '../do/read/visibility';
import { images, type LfmDocument, type LfmElement, lastfmDate, leaf, lfmOk, node, paged } from './encode';
import { LastfmError } from './errors';
import type { LastfmParams } from './params';
import type { LastfmCall, LastfmMethodTable } from './routes';

// ---------------------------------------------------------------------------
// Parameters

export const RECENT_DEFAULT_LIMIT = 50;
export const RECENT_MAX_LIMIT = 200;
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 1000;
export const MAX_PAGE = 1_000_000;

const INTEGER = /^[+-]?\d{1,16}$/;

function parseInteger(params: LastfmParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === undefined || raw.trim() === '') return null;
  const value = raw.trim();
  if (!INTEGER.test(value)) throw new LastfmError(6, `Invalid parameters - ${name} must be an integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new LastfmError(6, `Invalid parameters - ${name} is out of range`);
  return n;
}

/** `limit`: default `def`, clamped to [1, max]. */
export function limitParam(params: LastfmParams, def: number, max: number): number {
  const n = parseInteger(params, 'limit');
  if (n === null) return def;
  return Math.min(max, Math.max(1, n));
}

/** `page`: default 1; 1 … MAX_PAGE, else 6. */
export function pageParam(params: LastfmParams): number {
  const n = parseInteger(params, 'page');
  if (n === null) return 1;
  if (n < 1 || n > MAX_PAGE) throw new LastfmError(6, `Invalid parameters - page must be from 1 to ${MAX_PAGE}`);
  return n;
}

/** A UNIX-seconds parameter (`from`, `to`), or null when absent. */
export function secondsParam(params: LastfmParams, name: string): number | null {
  const n = parseInteger(params, name);
  if (n === null) return null;
  if (n < 0 || n > MAX_UNIX_SECONDS) throw new LastfmError(6, `Invalid parameters - ${name} is out of range`);
  return n;
}

/** A required non-empty string parameter, else 6. */
export function requiredParam(params: LastfmParams, name: string): string {
  const value = params.get(name);
  if (value === undefined || value.trim() === '') {
    throw new LastfmError(6, `Invalid parameters - missing required parameter ${name}`);
  }
  return value;
}

/** `1` or `true`. */
export function flagParam(params: LastfmParams, name: string): boolean {
  const v = params.get(name)?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

// ---------------------------------------------------------------------------
// Users

export interface ResolvedUser {
  did: string;
  /** The protocol name (displayName). */
  name: string;
  /** users.joined_at, storage form. */
  joinedAt: string;
}

export const USER_NOT_FOUND = 'User not found';

/** `user` (or `paramName`), else the sk caller; 6 when neither names a visible user. */
export function resolveUser(call: LastfmCall, paramName = 'user'): ResolvedUser {
  const value = call.params.get(paramName);
  let lookupValue: string;
  if (value === undefined || value.trim() === '') {
    const caller = call.caller();
    if (caller === null) throw new LastfmError(6, `Invalid parameters - missing required parameter ${paramName}`);
    lookupValue = caller.did;
  } else {
    lookupValue = value.trim();
  }
  const user = lookupUser(call.deps, lookupValue);
  if (user === null) throw new LastfmError(6, USER_NOT_FOUND);
  return { did: user.did, name: displayName(call.deps.db, user.did), joinedAt: user.joinedAt };
}

/** An optional user parameter (`username` of the *.getInfo methods): null when absent, 6 when unknown. */
export function optionalUser(call: LastfmCall, paramName: string): ResolvedUser | null {
  const value = call.params.get(paramName);
  if (value === undefined || value.trim() === '') return null;
  const user = lookupUser(call.deps, value.trim());
  if (user === null) throw new LastfmError(6, USER_NOT_FOUND);
  return { did: user.did, name: displayName(call.deps.db, user.did), joinedAt: user.joinedAt };
}

// ---------------------------------------------------------------------------
// URLs and builders

/** Last.fm-style path component: form encoding with `+` for a space. */
export function lastfmComponent(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '+');
}

export const LASTFM_MUSIC_URL = 'https://www.last.fm/music/';

export function artistUrl(artist: string): string {
  return `${LASTFM_MUSIC_URL}${lastfmComponent(artist)}`;
}

export function trackUrl(artist: string, track: string): string {
  return `${artistUrl(artist)}/_/${lastfmComponent(track)}`;
}

export function albumUrl(artist: string, album: string): string {
  return `${artistUrl(artist)}/${lastfmComponent(album)}`;
}

export function userUrl(publicOrigin: string, did: string): string {
  return `${publicOrigin}/u/${did}`;
}

/** The first stored artist MBID (scrobbles.artist_mbids is JSON array text), or "". */
export function firstArtistMbid(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : '';
  } catch {
    return '';
  }
}

/** `{name, mbid, url}` (top tracks, loved tracks, track.getInfo). */
export function artistRef(name: string, mbid = ''): LfmElement {
  return node('artist', [leaf('name', name), leaf('mbid', mbid), leaf('url', artistUrl(name))]);
}

export interface PageInfo {
  user: string;
  page: number;
  perPage: number;
  total: number;
}

export function pageAttr(p: PageInfo) {
  return {
    user: p.user,
    page: p.page,
    perPage: p.perPage,
    totalPages: p.total === 0 ? 0 : Math.ceil(p.total / p.perPage),
    total: p.total,
  };
}

/** The far upper bound used for "all time" (every listen ever indexed, skewed ones included). */
export const ALL_TIME_UPPER_MS = MAX_UNIX_SECONDS * 1000;

// ---------------------------------------------------------------------------
// Recent tracks

interface TrackFields {
  artist: string;
  track: string;
  album: string | null;
  recordingMbid: string | null;
  releaseMbid: string | null;
  artistMbid: string;
}

function recentTrack(
  f: TrackFields,
  o: { extended: boolean; loved?: boolean; dateSeconds?: number; nowPlaying?: boolean },
): LfmElement {
  const children = [
    o.extended
      ? node('artist', [leaf('url', artistUrl(f.artist)), leaf('name', f.artist), images(), leaf('mbid', f.artistMbid)])
      : leaf('artist', f.artist, { mbid: f.artistMbid }),
    leaf('streamable', '0'),
    images(),
    leaf('mbid', f.recordingMbid ?? ''),
    leaf('album', f.album ?? '', { mbid: f.releaseMbid ?? '' }),
    leaf('name', f.track),
    leaf('url', trackUrl(f.artist, f.track)),
  ];
  if (o.extended) children.push(leaf('loved', o.loved === true ? '1' : '0'));
  if (o.dateSeconds !== undefined) children.push(lastfmDate(o.dateSeconds));
  return o.nowPlaying === true ? node('track', children, { nowplaying: 'true' }) : node('track', children);
}

function scrobbleFields(row: ScrobbleRowV2): TrackFields {
  return {
    artist: row.artist,
    track: row.track,
    album: row.album,
    recordingMbid: row.recording_mbid,
    releaseMbid: row.release_mbid ?? null,
    artistMbid: firstArtistMbid(row.artist_mbids),
  };
}

function recentTracksDoc(call: LastfmCall, root: 'recenttracks' | 'trackscrobbles'): LfmDocument {
  const { params, deps } = call;
  const user = resolveUser(call);
  const limit = limitParam(params, RECENT_DEFAULT_LIMIT, RECENT_MAX_LIMIT);
  const page = pageParam(params);
  const from = secondsParam(params, 'from');
  const to = secondsParam(params, 'to');
  const filter =
    root === 'trackscrobbles' ? { artist: requiredParam(params, 'artist'), track: requiredParam(params, 'track') } : {};
  const extended = root === 'recenttracks' && flagParam(params, 'extended');

  const result = recentPage(deps, { did: user.did, after: from, before: to, limit, page, ...filter });
  if (result === null) throw new LastfmError(6, USER_NOT_FOUND);

  // Whose loves the flags show (module comment): the caller, else the listed user.
  const lovesOf = extended ? (call.caller()?.did ?? user.did) : user.did;
  const loved = extended
    ? lovedKeyIds(
        deps,
        lovesOf,
        result.rows.map((r) => ({ artistKey: r.artist_key, trackKey: r.track_key })),
      )
    : new Set<string>();
  const items = result.rows.map((row) =>
    recentTrack(scrobbleFields(row), {
      extended,
      loved: loved.has(loveKeyId(row.artist_key, row.track_key)),
      dateSeconds: storageToUnixSeconds(row.listened_at),
    }),
  );

  if (root === 'recenttracks' && page === 1) {
    const np = currentNowPlaying(deps, user.did);
    if (np !== null) {
      items.unshift(
        recentTrack(
          {
            artist: np.artist,
            track: np.track,
            album: np.album,
            recordingMbid: np.recording_mbid,
            releaseMbid: null,
            artistMbid: '',
          },
          {
            extended,
            loved: extended && isLoved(deps, { did: lovesOf, artist: np.artist, track: np.track }),
            nowPlaying: true,
          },
        ),
      );
    }
  }
  return lfmOk(paged(root, pageAttr({ user: user.name, page, perPage: limit, total: result.total }), 'track', items));
}

// ---------------------------------------------------------------------------
// user.getInfo

/** Listens, distinct artists, tracks and albums of a visible user over all time (range engine totals). */
export function allTimeTotals(deps: ModuleDeps, did: string) {
  const stats = rangeStats(deps, {
    did,
    entity: 'artists',
    lower: null,
    upper: ALL_TIME_UPPER_MS,
    upperInclusive: true,
    limit: 1,
    offset: 0,
  });
  return stats?.totals ?? { listens: 0, artists: 0, tracks: 0, albums: 0 };
}

function userInfo(call: LastfmCall): LfmDocument {
  const user = resolveUser(call);
  const totals = allTimeTotals(call.deps, user.did);
  const registered = storageToUnixSeconds(user.joinedAt);
  return lfmOk(
    node('user', [
      leaf('name', user.name),
      leaf('realname', ''),
      leaf('url', userUrl(call.publicOrigin, user.did)),
      leaf('country', 'None'),
      leaf('age', '0'),
      leaf('gender', 'n'),
      leaf('subscriber', '0'),
      leaf('playcount', totals.listens),
      leaf('artist_count', totals.artists),
      leaf('track_count', totals.tracks),
      leaf('album_count', totals.albums),
      leaf('playlists', '0'),
      leaf('bootstrap', '0'),
      leaf('registered', registered, { unixtime: String(registered) }),
      leaf('type', 'user'),
      images(),
    ]),
  );
}

// ---------------------------------------------------------------------------
// user.getLovedTracks

function lovedTracksDoc(call: LastfmCall): LfmDocument {
  const user = resolveUser(call);
  const limit = limitParam(call.params, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const page = pageParam(call.params);
  const result = lovedTracks(call.deps, { did: user.did, limit, page });
  if (result === null) throw new LastfmError(6, USER_NOT_FOUND);
  const items = result.rows.map((row) =>
    node('track', [
      leaf('name', row.track),
      leaf('mbid', row.recording_mbid ?? ''),
      leaf('url', trackUrl(row.artist, row.track)),
      lastfmDate(storageToUnixSeconds(row.created_at)),
      artistRef(row.artist),
      images(),
      leaf('streamable', '0', { fulltrack: '0' }),
    ]),
  );
  return lfmOk(
    paged('lovedtracks', pageAttr({ user: user.name, page, perPage: limit, total: result.total }), 'track', items),
  );
}

// ---------------------------------------------------------------------------
// user.getFriends: the accounts the user follows (<p>.follow), paged

interface FriendRow {
  joined_at: string | null;
  plays: number;
}

function friendsDoc(call: LastfmCall): LfmDocument {
  const user = resolveUser(call);
  const limit = limitParam(call.params, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const page = pageParam(call.params);
  const db = call.deps.db;
  const edges = allFollowing(db, user.did);
  const offset = (page - 1) * limit;
  const items = edges.slice(offset, offset + limit).map((edge) => {
    const did = edge.subject;
    const row = db.one<FriendRow>(
      `SELECT (SELECT u.joined_at FROM users u WHERE u.did = ? AND ${activeUser('u')}) AS joined_at,
              (SELECT count(*) FROM ${visibleScrobblesFrom('s', 'u2')} WHERE s.did = ?) AS plays`,
      did,
      did,
    );
    const registered = row?.joined_at == null ? 0 : storageToUnixSeconds(row.joined_at);
    return node('user', [
      leaf('name', displayName(db, did)),
      leaf('realname', ''),
      images(),
      leaf('url', userUrl(call.publicOrigin, did)),
      leaf('country', 'None'),
      leaf('age', '0'),
      leaf('gender', 'n'),
      leaf('subscriber', '0'),
      leaf('playcount', row?.plays ?? 0),
      leaf('playlists', '0'),
      leaf('bootstrap', '0'),
      leaf('registered', String(registered), { unixtime: String(registered) }),
      leaf('type', 'user'),
    ]);
  });
  return lfmOk(
    paged('friends', pageAttr({ user: user.name, page, perPage: limit, total: edges.length }), 'user', items),
  );
}

// ---------------------------------------------------------------------------
// library.getArtists: artist play counts over all time, paged

function libraryArtistsDoc(call: LastfmCall): LfmDocument {
  const user = resolveUser(call);
  const limit = limitParam(call.params, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const page = pageParam(call.params);
  const stats = rangeStats(call.deps, {
    did: user.did,
    entity: 'artists',
    lower: null,
    upper: ALL_TIME_UPPER_MS,
    upperInclusive: true,
    limit,
    offset: (page - 1) * limit,
  });
  if (stats === null) throw new LastfmError(6, USER_NOT_FOUND);
  const items = stats.items.map((a) =>
    node('artist', [
      leaf('name', a.artist),
      leaf('playcount', a.count),
      leaf('tagcount', '0'),
      leaf('mbid', a.artistMbids?.[0] ?? ''),
      leaf('url', artistUrl(a.artist)),
      leaf('streamable', '0'),
      images(),
    ]),
  );
  return lfmOk(
    paged('artists', pageAttr({ user: user.name, page, perPage: limit, total: stats.total }), 'artist', items),
  );
}

/** The user read methods of §7.5. */
export const readUserMethods: LastfmMethodTable = Object.freeze({
  'user.getRecentTracks': (call: LastfmCall) => recentTracksDoc(call, 'recenttracks'),
  'user.getTrackScrobbles': (call: LastfmCall) => recentTracksDoc(call, 'trackscrobbles'),
  'user.getInfo': userInfo,
  'user.getLovedTracks': lovedTracksDoc,
  'user.getFriends': friendsDoc,
  'library.getArtists': libraryArtistsDoc,
});
