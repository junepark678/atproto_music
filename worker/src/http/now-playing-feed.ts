import type { NowPlayingFeed } from '@atmusic/core/api-types';
import { fromMs, toDto } from '@atmusic/core/timestamp';
import { nowPlayingDto } from './profile';
import { json } from './json';
import { cookieRoute, type CookieHandler } from './operations';
import type { RouteDef } from './types';

export const NOW_PLAYING_FEED_PATTERN = '/api/v1/feed/now-playing';

const getFeed: CookieHandler = async (_req, ctx, _params, session) => {
  const rows = await ctx.index.followedNowPlaying(session.did);
  const handles = await ctx.index.verifiedHandles(rows.map((item) => item.did));
  const result: NowPlayingFeed = {
    items: rows.map(({ did, row }) => ({ did, handle: handles[did] ?? null, nowPlaying: nowPlayingDto(row, true) })),
    serverTime: toDto(fromMs(ctx.clock.nowMs())),
  };
  return json(result, 200);
};

export const routes: RouteDef[] = [{ method: 'GET', pattern: NOW_PLAYING_FEED_PATTERN, handler: cookieRoute(getFeed) }];
