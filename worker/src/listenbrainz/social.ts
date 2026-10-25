// ListenBrainz-compatible social reads (ADR 0005 §8.6; N3-06):
//
//   GET /1/user/{user}/following  → {following: [names], user}
//   GET /1/user/{user}/followers  → {followers: [names], count, user}
//
// - From the follow records the index verified (`follows`), with the public
//   visibility rule (do/read/visibility.ts `visibleFollowEdge`): a hidden
//   actor's edges and edges to a suppressed or inactive subject are not
//   listed. Duplicate records of one edge collapse to one name.
// - Names are protocol names (accounts.ts `displayName`: username, else the
//   verified handle, else the DID), so a client can pass any of them back as
//   `{user}`. A subject this index has never seen is named by its DID.
// - Newest edge first (the representative record's `created_at`, then URI).
// - `{user}` resolves as in read.ts (404 "Cannot find user: x"); `user` is the
//   resolved user's protocol name, as ListenBrainz answers its canonical
//   `musicbrainz_id`. Neither list is paged (ListenBrainz's are not).

import { displayName } from '../credentials/accounts';
import type { Db } from '../do/db';
import { visibleFollowEdge } from '../do/read/visibility';
import { need, type RequestCtx } from '../http/types';
import { lbJson } from './errors';
import { resolveLbUser } from './read';
import type { LbRouteDef } from './routes';

/** Distinct DIDs on the other side of `did`'s visible edges, newest edge first. */
export function followNeighbours(db: Db, did: string, direction: 'following' | 'followers'): string[] {
  const [key, other] = direction === 'following' ? ['f.actor', 'f.subject'] : ['f.subject', 'f.actor'];
  return db
    .all<{ other: string }>(
      `SELECT ${other} AS other, max(f.created_at || ' ' || f.uri) AS newest FROM follows f
       WHERE ${key} = ? AND ${visibleFollowEdge('f')}
       GROUP BY ${other} ORDER BY newest DESC`,
      did,
    )
    .map((r) => r.other);
}

async function getFollowing(_req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  const m = need(ctx, 'deps');
  const user = resolveLbUser(m, params.user ?? '');
  const following = followNeighbours(m.db, user.did, 'following').map((did) => displayName(m.db, did));
  return lbJson({ following, user: displayName(m.db, user.did) });
}

async function getFollowers(_req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  const m = need(ctx, 'deps');
  const user = resolveLbUser(m, params.user ?? '');
  const followers = followNeighbours(m.db, user.did, 'followers').map((did) => displayName(m.db, did));
  return lbJson({ followers, count: followers.length, user: displayName(m.db, user.did) });
}

/** The social routes (mounted by routes.ts). */
export function socialRoutes(): LbRouteDef[] {
  return [
    { method: 'GET', pattern: '/1/user/{user}/following', handler: getFollowing },
    { method: 'GET', pattern: '/1/user/{user}/followers', handler: getFollowers },
  ];
}
