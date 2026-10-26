// ListenBrainz-compatible statistics (ADR 0005 §8.5, §10.1, §10.2; N3-06):
//
//   GET /1/stats/user/{user}/artists | releases | release-groups | recordings
//   GET /1/stats/user/{user}/listening-activity
//   GET /1/stats/user/{user}/daily-activity
//
// - ListenBrainz `_validate_stats_user_params` order: the user first (404
//   "Cannot find user: x"), then `range` (§10.1, default `all_time`; anything
//   else, the empty string included, is 400 "Invalid range: x"), then
//   `offset` and `count` (non-negative integers, read.ts `nonNegativeArg`;
//   `count` defaults to 25 and is capped at 1,000).
// - Computed on read and anchored on the request clock (no batch job), through
//   the generalised engine and its exact cache (do/read/range-stats.ts,
//   range key `lb:<range>`): releases and release-groups both rank the
//   album-artist album groups, recordings rank tracks, artists rank artists.
// - **204** with an empty body when the range holds no listens.
// - Payload `{user_id (the path value), <entity list>, count, total_<entity>_count,
//   offset, range, from_ts, to_ts, last_updated}` with `from_ts`/`to_ts` the
//   range bounds in UNIX s and `last_updated` = now (computed on read).
// - Items carry ListenBrainz's pydantic fields, never omitted: MBIDs we do not
//   have are null (`artist_mbids`, a list in pydantic, defaults to []),
//   `artists`, `caa_id` and `caa_release_mbid` are always null (they need
//   MusicBrainz and Cover Art Archive data we do not have).
// - listening-activity: the range and the one before it in buckets labelled
//   per §10.1 (do/read/activity.ts); `all_time` lists only years with listens.
//   204 when no bucket holds a listen.
// - daily-activity: the zero-filled Monday-first 7 × 24 UTC grid of the range;
//   204 when the range holds no listens.
// - Not implemented, so the router's 404: artist-map, era-activity,
//   genre-activity, artist-evolution-activity and /1/stats/sitewide/*.

import {
  type ListenBrainzRange,
  listenBrainzRangeBounds,
  type PeriodBounds,
  parseListenBrainzRange,
} from '@atmusic/core/periods';
import { dailyActivity, listeningActivity } from '../do/read/activity';
import {
  fromPeriod,
  type RangeAlbumItem,
  type RangeArtistItem,
  type RangeEntity,
  type RangeTrackItem,
  rangeStatsWithCache,
} from '../do/read/range-stats';
import { need, type RequestCtx } from '../http/types';
import { applyLbCors, lbJson } from './errors';
import {
  LB_DEFAULT_COUNT,
  LB_MAX_COUNT,
  LbHttpError,
  nonNegativeArg,
  queryOf,
  resolveLbUser,
  unixSeconds,
} from './read';
import type { LbRouteDef } from './routes';

/** The 204 of a range without listens: no body, no content type. */
export function noContent(): Response {
  return new Response(null, { status: 204, headers: applyLbCors(new Headers({ 'cache-control': 'no-store' })) });
}

function rangeOf(q: URLSearchParams): ListenBrainzRange {
  const raw = q.get('range');
  const range = parseListenBrainzRange(raw ?? undefined);
  if (range === null) throw new LbHttpError(400, `Invalid range: ${raw ?? ''}`);
  return range;
}

function boundsTs(bounds: PeriodBounds): { from_ts: number; to_ts: number } {
  return { from_ts: bounds.lowerMs === null ? 0 : unixSeconds(bounds.lowerMs), to_ts: unixSeconds(bounds.upperMs) };
}

// ---------------------------------------------------------------------------
// Entity rankings

type Serialise<E extends RangeEntity> = (
  item: E extends 'artists' ? RangeArtistItem : E extends 'albums' ? RangeAlbumItem : RangeTrackItem,
) => Record<string, unknown>;

interface EntityEndpoint<E extends RangeEntity = RangeEntity> {
  path: string;
  entity: E;
  /** The payload key of the list. */
  listKey: string;
  /** The payload key of the ranking length. */
  totalKey: string;
  serialise: Serialise<E>;
}

const artistItem = (i: RangeArtistItem) => ({
  artist_mbid: i.artistMbids?.[0] ?? null,
  artist_name: i.artist,
  listen_count: i.count,
});

const releaseItem = (i: RangeAlbumItem) => ({
  artist_mbids: i.artistMbids ?? [],
  release_mbid: i.releaseMbid,
  release_name: i.album,
  listen_count: i.count,
  artist_name: i.artist,
  artists: null,
  caa_id: null,
  caa_release_mbid: null,
});

const releaseGroupItem = (i: RangeAlbumItem) => ({
  artist_mbids: i.artistMbids ?? [],
  release_group_mbid: i.releaseGroupMbid,
  release_group_name: i.album,
  listen_count: i.count,
  artist_name: i.artist,
  artists: null,
  caa_id: null,
  caa_release_mbid: null,
});

const recordingItem = (i: RangeTrackItem) => ({
  artist_name: i.artist,
  artist_mbids: i.artistMbids ?? [],
  recording_mbid: i.recordingMbid,
  release_name: i.album,
  release_mbid: i.releaseMbid,
  track_name: i.track,
  listen_count: i.count,
  caa_id: null,
  caa_release_mbid: null,
  artists: null,
});

export const ENTITY_ENDPOINTS: readonly EntityEndpoint[] = [
  { path: 'artists', entity: 'artists', listKey: 'artists', totalKey: 'total_artist_count', serialise: artistItem },
  { path: 'releases', entity: 'albums', listKey: 'releases', totalKey: 'total_release_count', serialise: releaseItem },
  {
    path: 'release-groups',
    entity: 'albums',
    listKey: 'release_groups',
    totalKey: 'total_release_group_count',
    serialise: releaseGroupItem,
  },
  {
    path: 'recordings',
    entity: 'tracks',
    listKey: 'recordings',
    totalKey: 'total_recording_count',
    serialise: recordingItem,
  },
] as EntityEndpoint[];

function entityHandler(endpoint: EntityEndpoint) {
  return async (req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> => {
    const m = need(ctx, 'deps');
    const pathUser = params.user ?? '';
    const user = resolveLbUser(m, pathUser);
    const q = queryOf(req);
    const range = rangeOf(q);
    const offset = nonNegativeArg(q, 'offset', 0);
    const count = Math.min(nonNegativeArg(q, 'count', LB_DEFAULT_COUNT), LB_MAX_COUNT);
    const nowMs = m.clock.nowMs();
    const bounds = listenBrainzRangeBounds(range, nowMs);
    const result = rangeStatsWithCache(m, {
      did: user.did,
      entity: endpoint.entity,
      ...fromPeriod(bounds),
      // The engine pages with a positive limit; count 0 is an empty page of the same ranking.
      limit: Math.max(count, 1),
      offset,
      rangeKey: `lb:${range}`,
    });
    const stats = result.stats;
    if (stats === null) throw new LbHttpError(404, `Cannot find user: ${pathUser}`);
    if (stats.totals.listens === 0) return noContent();
    const items = (count === 0 ? [] : stats.items).map((item) =>
      (endpoint.serialise as (i: typeof item) => Record<string, unknown>)(item),
    );
    return lbJson({
      payload: {
        user_id: pathUser,
        [endpoint.listKey]: items,
        count: items.length,
        [endpoint.totalKey]: stats.total,
        offset,
        range,
        ...boundsTs(bounds),
        last_updated: unixSeconds(nowMs),
      },
    });
  };
}

// ---------------------------------------------------------------------------
// Activity

async function getListeningActivity(req: Request, ctx: RequestCtx, params: Record<string, string>) {
  const m = need(ctx, 'deps');
  const pathUser = params.user ?? '';
  const user = resolveLbUser(m, pathUser);
  const range = rangeOf(queryOf(req));
  const activity = listeningActivity(m, { did: user.did, range });
  if (activity === null) throw new LbHttpError(404, `Cannot find user: ${pathUser}`);
  if (activity.buckets.every((b) => b.count === 0)) return noContent();
  return lbJson({
    payload: {
      user_id: pathUser,
      listening_activity: activity.buckets.map((b) => ({
        from_ts: unixSeconds(b.fromMs),
        to_ts: unixSeconds(b.toMs),
        time_range: b.label,
        listen_count: b.count,
      })),
      ...boundsTs(activity.window),
      range,
      last_updated: unixSeconds(m.clock.nowMs()),
    },
  });
}

async function getDailyActivity(req: Request, ctx: RequestCtx, params: Record<string, string>) {
  const m = need(ctx, 'deps');
  const pathUser = params.user ?? '';
  const user = resolveLbUser(m, pathUser);
  const range = rangeOf(queryOf(req));
  const result = dailyActivity(m, { did: user.did, range });
  if (result === null) throw new LbHttpError(404, `Cannot find user: ${pathUser}`);
  const total = Object.values(result.activity).reduce(
    (n, hours) => n + hours.reduce((h, c) => h + c.listen_count, 0),
    0,
  );
  if (total === 0) return noContent();
  return lbJson({
    payload: {
      user_id: pathUser,
      daily_activity: result.activity,
      ...boundsTs(result.bounds),
      range,
      last_updated: unixSeconds(m.clock.nowMs()),
    },
  });
}

/** The statistics routes (mounted by routes.ts). */
export function statsRoutes(): LbRouteDef[] {
  return [
    ...ENTITY_ENDPOINTS.map(
      (e): LbRouteDef => ({ method: 'GET', pattern: `/1/stats/user/{user}/${e.path}`, handler: entityHandler(e) }),
    ),
    { method: 'GET', pattern: '/1/stats/user/{user}/listening-activity', handler: getListeningActivity },
    { method: 'GET', pattern: '/1/stats/user/{user}/daily-activity', handler: getDailyActivity },
  ];
}
