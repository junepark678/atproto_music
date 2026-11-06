// Feed read module (ADR 0004 §5.8 "Feeds", §9.2 A8, docs/cursors.md). A port
// of crates/storage/src/repositories/public.rs `feed` / `scrobble_page`.
//
// `feed(m, {scope, viewer?, upper?, last?, limit})`:
// - `global`: every visible owner's scrobbles, the viewer's own included,
//   ordered by `(listened_at DESC, uri DESC)` (`scrobbles_global_time`). A
//   viewer, if any, neither filters nor binds the global feed.
// - `following`: only owners the viewer follows through a visible follow
//   edge (actor and subject both visible users, ./visibility.ts):
//     s.did IN (SELECT f.subject FROM follows f WHERE f.actor = ?viewer AND <visible edge f>)
//   The viewer is never implicitly included: `follows` has
//   CHECK(actor != subject), so no edge can name the viewer as its subject.
//   An unknown (or inactive) viewer has no visible edges and gets an empty
//   page. Bluesky follows are not consulted.
// - Keyset bounds and the `limit + 1` probe are shared with history.ts.
// - The page carries the global Indexing truth (Rust feed.rs reads the
//   `global` scope for both scopes).

import { isDid } from '@atmusic/core/syntax';
import type { FeedQuery, ModuleDeps, RowsResult, ScrobbleRow } from '../contracts';
import { indexing } from '../status';
import { checkKeyset, keysetWhere, splitPage } from './history';
import { visibleFollowEdge, visibleScrobblesFrom } from './visibility';

export function feed(m: ModuleDeps, q: FeedQuery): RowsResult<ScrobbleRow> {
  checkKeyset(q);
  const keyset = keysetWhere(q, 's.listened_at', 's.uri');
  let rows: ScrobbleRow[];
  if (q.scope === 'global') {
    rows = m.db.all<ScrobbleRow>(
      `SELECT s.* FROM ${visibleScrobblesFrom('s', 'u')}
       WHERE 1 = 1${keyset.sql}
       ORDER BY s.listened_at DESC, s.uri DESC
       LIMIT ?`,
      ...keyset.params,
      q.limit + 1,
    );
  } else if (q.scope === 'following') {
    const viewer = q.viewer;
    if (typeof viewer !== 'string' || !isDid(viewer)) throw new RangeError('the following feed needs a viewer DID');
    rows = m.db.all<ScrobbleRow>(
      `SELECT s.* FROM ${visibleScrobblesFrom('s', 'u')}
       WHERE s.did IN (SELECT f.subject FROM follows f WHERE f.actor = ? AND ${visibleFollowEdge('f')})${keyset.sql}
       ORDER BY s.listened_at DESC, s.uri DESC
       LIMIT ?`,
      viewer,
      ...keyset.params,
      q.limit + 1,
    );
  } else {
    throw new RangeError(`unknown feed scope ${JSON.stringify(q.scope)}`);
  }
  const page = splitPage(rows, q.limit);
  return {
    rows: page.rows,
    hasMore: page.hasMore,
    indexing: indexing(m.db, m.clock.nowMs(), { mode: m.config.ingestMode }),
  };
}
