// Last.fm 2.0 chart read methods (ADR 0005 §7.5, §7.9, §10.1, §10.2; N3-04):
// user.getTopArtists, user.getTopAlbums, user.getTopTracks,
// user.getWeeklyChartList and user.getWeekly{Artist,Album,Track}Chart.
//
// Top lists come from the range engine (do/read/range-stats.ts) over the
// rolling period (`period`, packages/core/src/periods.ts; absent = overall,
// unknown = 6), with the exact cache under the range key `lastfm:<period>`.
// `limit` defaults to 50 and is clamped to 1–1000; `page` is offset paging.
// Items carry @attr.rank (1-based position in the full ranking) and
// `playcount`; tracks add `duration` in seconds (newest listen with a
// duration, else "0"); albums use the album-artist grouping.
//
// Weekly charts: weeks start on Sundays at 12:00 UTC. getWeeklyChartList lists
// every week from the one holding the user's first listen to the current one.
// The weekly charts take `from`/`to` (UNIX s, `[from, to)`; both or neither,
// else 6; past MAX_UNIX_SECONDS, 6) and default to the last complete week. They list the whole ranking
// of the window (Last.fm does not page them) and are not cached, since the
// window is the client's.

import {
  type LastfmPeriod,
  lastfmPeriodBounds,
  lastfmWeeklyChartList,
  lastfmWeeklyChartRange,
  parseLastfmPeriod,
} from '@atmusic/core/periods';
import {
  fromPeriod,
  type RangeAlbumItem,
  type RangeArtistItem,
  type RangeBounds,
  type RangeEntity,
  type RangeItemOf,
  type RangeStats,
  type RangeTrackItem,
  rangeStats,
} from '../do/read/range-stats';
import { listensByTimestamp, MAX_UNIX_SECONDS } from '../do/read/recent';
import { images, type LfmDocument, type LfmElement, leaf, lfmOk, list, node, paged } from './encode';
import { LastfmError } from './errors';
import {
  albumUrl,
  artistRef,
  artistUrl,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  limitParam,
  pageAttr,
  pageParam,
  type ResolvedUser,
  resolveUser,
  trackUrl,
  USER_NOT_FOUND,
} from './read-user';
import type { LastfmCall, LastfmMethodTable } from './routes';

export const INVALID_PERIOD_MESSAGE =
  'Invalid parameters - period must be one of overall, 7day, 1month, 3month, 6month, 12month';

function periodParam(call: LastfmCall): LastfmPeriod {
  const period = parseLastfmPeriod(call.params.get('period'));
  if (period === null) throw new LastfmError(6, INVALID_PERIOD_MESSAGE);
  return period;
}

function stats<E extends RangeEntity>(
  call: LastfmCall,
  user: ResolvedUser,
  entity: E,
  bounds: RangeBounds,
  page: { limit: number | null; offset: number },
  rangeKey?: string,
): RangeStats<E> {
  const result = rangeStats(call.deps, {
    did: user.did,
    entity,
    ...bounds,
    limit: page.limit,
    offset: page.offset,
    ...(rangeKey === undefined ? {} : { rangeKey }),
  });
  if (result === null) throw new LastfmError(6, USER_NOT_FOUND);
  return result;
}

// ---------------------------------------------------------------------------
// Top lists

const TOP_ROOTS = {
  artists: { root: 'topartists', item: 'artist' },
  albums: { root: 'topalbums', item: 'album' },
  tracks: { root: 'toptracks', item: 'track' },
} as const;

function topArtist(a: RangeArtistItem): LfmElement {
  return node(
    'artist',
    [
      leaf('name', a.artist),
      leaf('playcount', a.count),
      leaf('mbid', a.artistMbids?.[0] ?? ''),
      leaf('url', artistUrl(a.artist)),
      leaf('streamable', '0'),
      images(),
    ],
    { rank: a.rank },
  );
}

function topAlbum(a: RangeAlbumItem): LfmElement {
  return node(
    'album',
    [
      leaf('name', a.album),
      leaf('playcount', a.count),
      leaf('mbid', a.releaseMbid ?? ''),
      leaf('url', albumUrl(a.artist, a.album)),
      artistRef(a.artist, a.artistMbids?.[0] ?? ''),
      images(),
    ],
    { rank: a.rank },
  );
}

function topTrack(t: RangeTrackItem): LfmElement {
  return node(
    'track',
    [
      leaf('name', t.track),
      leaf('duration', t.durationSeconds ?? 0),
      leaf('playcount', t.count),
      leaf('mbid', t.recordingMbid ?? ''),
      leaf('url', trackUrl(t.artist, t.track)),
      leaf('streamable', '0', { fulltrack: '0' }),
      artistRef(t.artist, t.artistMbids?.[0] ?? ''),
      images(),
    ],
    { rank: t.rank },
  );
}

const TOP_ITEM: { [E in RangeEntity]: (item: RangeItemOf[E]) => LfmElement } = {
  artists: topArtist,
  albums: topAlbum,
  tracks: topTrack,
};

function topList<E extends RangeEntity>(call: LastfmCall, entity: E): LfmDocument {
  const user = resolveUser(call);
  const period = periodParam(call);
  const limit = limitParam(call.params, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const page = pageParam(call.params);
  const bounds = fromPeriod(lastfmPeriodBounds(period, call.deps.clock.nowMs()));
  const result = stats(call, user, entity, bounds, { limit, offset: (page - 1) * limit }, `lastfm:${period}`);
  const { root, item } = TOP_ROOTS[entity];
  const build = TOP_ITEM[entity] as (i: RangeItemOf[E]) => LfmElement;
  return lfmOk(
    paged(
      root,
      pageAttr({ user: user.name, page, perPage: limit, total: result.total }),
      item,
      result.items.map(build),
    ),
  );
}

// ---------------------------------------------------------------------------
// Weekly charts

function nowSeconds(call: LastfmCall): number {
  return Math.floor(call.deps.clock.nowMs() / 1000);
}

function weeklyChartList(call: LastfmCall): LfmDocument {
  const user = resolveUser(call);
  const span = listensByTimestamp(call.deps, { did: user.did, count: 0 });
  if (span === null) throw new LastfmError(6, USER_NOT_FOUND);
  const weeks = lastfmWeeklyChartList(span.oldestListenTs, nowSeconds(call));
  return lfmOk(
    node(
      'weeklychartlist',
      [
        list(
          'chart',
          weeks.map((w) => leaf('chart', '', { from: String(w.from), to: String(w.to) })),
        ),
      ],
      { user: user.name },
    ),
  );
}

const WEEKLY_ROOTS = {
  artists: { root: 'weeklyartistchart', item: 'artist' },
  albums: { root: 'weeklyalbumchart', item: 'album' },
  tracks: { root: 'weeklytrackchart', item: 'track' },
} as const;

function weeklyArtist(a: RangeArtistItem): LfmElement {
  return node(
    'artist',
    [
      leaf('name', a.artist),
      leaf('mbid', a.artistMbids?.[0] ?? ''),
      leaf('playcount', a.count),
      leaf('url', artistUrl(a.artist)),
    ],
    { rank: a.rank },
  );
}

function weeklyAlbum(a: RangeAlbumItem): LfmElement {
  return node(
    'album',
    [
      leaf('artist', a.artist, { mbid: a.artistMbids?.[0] ?? '' }),
      leaf('name', a.album),
      leaf('mbid', a.releaseMbid ?? ''),
      leaf('playcount', a.count),
      leaf('url', albumUrl(a.artist, a.album)),
    ],
    { rank: a.rank },
  );
}

function weeklyTrack(t: RangeTrackItem): LfmElement {
  return node(
    'track',
    [
      leaf('artist', t.artist, { mbid: t.artistMbids?.[0] ?? '' }),
      images(),
      leaf('name', t.track),
      leaf('mbid', t.recordingMbid ?? ''),
      leaf('playcount', t.count),
      leaf('url', trackUrl(t.artist, t.track)),
    ],
    { rank: t.rank },
  );
}

const WEEKLY_ITEM: { [E in RangeEntity]: (item: RangeItemOf[E]) => LfmElement } = {
  artists: weeklyArtist,
  albums: weeklyAlbum,
  tracks: weeklyTrack,
};

export const INVALID_WEEK_MESSAGE = 'Invalid parameters - from and to must both be UNIX timestamps, or both be absent';

function weeklyChart<E extends RangeEntity>(call: LastfmCall, entity: E): LfmDocument {
  const user = resolveUser(call);
  const range = lastfmWeeklyChartRange(call.params.get('from'), call.params.get('to'), nowSeconds(call));
  if (range === null) throw new LastfmError(6, INVALID_WEEK_MESSAGE);
  // The same ceiling as secondsParam (read-user.ts): past year 9999 the
  // window is an invalid parameter, not a range the engine can hold.
  for (const name of ['from', 'to'] as const) {
    if (range.week[name] > MAX_UNIX_SECONDS) {
      throw new LastfmError(6, `Invalid parameters - ${name} is out of range`);
    }
  }
  const result = stats(call, user, entity, fromPeriod(range.bounds), { limit: null, offset: 0 });
  const { root, item } = WEEKLY_ROOTS[entity];
  const build = WEEKLY_ITEM[entity] as (i: RangeItemOf[E]) => LfmElement;
  return lfmOk(
    node(root, [list(item, result.items.map(build))], {
      user: user.name,
      from: String(range.week.from),
      to: String(range.week.to),
    }),
  );
}

/** The chart read methods of §7.5. */
export const readChartMethods: LastfmMethodTable = Object.freeze({
  'user.getTopArtists': (call: LastfmCall) => topList(call, 'artists'),
  'user.getTopAlbums': (call: LastfmCall) => topList(call, 'albums'),
  'user.getTopTracks': (call: LastfmCall) => topList(call, 'tracks'),
  'user.getWeeklyChartList': weeklyChartList,
  'user.getWeeklyArtistChart': (call: LastfmCall) => weeklyChart(call, 'artists'),
  'user.getWeeklyAlbumChart': (call: LastfmCall) => weeklyChart(call, 'albums'),
  'user.getWeeklyTrackChart': (call: LastfmCall) => weeklyChart(call, 'tracks'),
});
