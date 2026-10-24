// /feed and / (M7.3.1; ADR 0004 §9 A8).
//
// - Global: `GET /api/v1/feed?scope=global`, in server order, paginated with
//   the opaque nextCursor.
// - Following: `scope=following&viewer=<session DID>`. The viewer always
//   comes from the session; an anonymous user gets a sign-in prompt and no
//   request is sent.
// - A failed later page keeps the earlier items and offers a retry that asks
//   for the same cursor once more.
// - The signed-in owner's pending deletes are hidden through the outbox
//   overlay, and the owner's own records carry a delete control.

import type { Did, FeedScope, Scrobble } from '@atmusic/core/api-types';
import { useCallback, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { usePaged } from '../components/paged';
import { type ListItem, ScrobbleList } from '../components/scrobble-list';
import { useSessionHandle } from '../components/session-identity';
import { EmptyState, ErrorState, LoadingState, SignInPrompt, StaleNotice } from '../components/state-views';
import { useOutbox, useOutboxOps } from '../components/use-outbox';
import { overlayScrobbles } from '../outbox/overlay';
import { useAppState } from '../state/store';

const SCOPES: readonly { id: FeedScope; label: string }[] = [
  { id: 'global', label: 'Global' },
  { id: 'following', label: 'Following' },
];

export default function Feed() {
  const state = useAppState();
  const { query } = useLocation();
  useSessionHandle();
  const [scope, setScope] = useState<FeedScope>(query.scope === 'following' ? 'following' : 'global');
  const session = state.session.value;

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Feed</h1>
      <div class="tabs" role="tablist" aria-label="Feed scope">
        {SCOPES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`feed-tab-${s.id}`}
            aria-selected={s.id === scope}
            aria-controls="feed-panel"
            data-scope={s.id}
            onClick={() => setScope(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div id="feed-panel" role="tabpanel" aria-labelledby={`feed-tab-${scope}`}>
        {scope === 'following' && session === null ? (
          <SignInPrompt>Sign in to see scrobbles from the accounts you follow.</SignInPrompt>
        ) : (
          <FeedList scope={scope} viewer={scope === 'following' ? (session?.did ?? null) : null} />
        )}
      </div>
    </section>
  );
}

function FeedList({ scope, viewer }: { scope: FeedScope; viewer: Did | null }) {
  const state = useAppState();
  const session = state.session.value;
  const outboxState = useOutbox();
  const outbox = outboxState.status === 'ready' ? outboxState.outbox : null;
  const ops = useOutboxOps(outbox);
  const key = scope === 'following' ? (viewer === null ? null : `following|${viewer}`) : 'global';

  const load = useCallback(
    (cursor: string | null, signal: AbortSignal) =>
      state.api.feed(
        scope === 'following' && viewer !== null ? { scope, viewer, cursor } : { scope: 'global', cursor },
        { signal },
      ),
    [state, scope, viewer],
  );
  const paged = usePaged<Scrobble>(key, load);
  const label = scope === 'following' ? 'Scrobbles from accounts you follow' : 'Recent scrobbles';

  if (paged.phase === 'loading') return <LoadingState label="Loading the feed…" />;
  if (paged.phase === 'error') {
    return <ErrorState title="The feed could not be loaded." error={paged.error} onRetry={paged.retry} />;
  }

  const items: ListItem[] =
    session !== null && ops !== null
      ? overlayScrobbles(paged.items, ops, session.did, { includePending: false }).items
      : paged.items.map((scrobble) => ({ scrobble }));

  return (
    <>
      {paged.indexing ? <StaleNotice indexing={paged.indexing} /> : null}
      {items.length === 0 && paged.nextCursor === null ? (
        <EmptyState>
          {scope === 'following' ? 'No scrobbles from the accounts you follow yet.' : 'No scrobbles yet.'}
        </EmptyState>
      ) : (
        <ScrobbleList
          items={items}
          label={label}
          showActor
          canDelete={(s) => outbox !== null && s.did === outbox.did}
          onDelete={async (s) => {
            await outbox?.deleteScrobble(s.uri);
          }}
        />
      )}
      {paged.moreError !== null ? (
        <ErrorState title="More scrobbles could not be loaded." error={paged.moreError} onRetry={paged.retry} />
      ) : null}
      {paged.loadingMore ? <LoadingState label="Loading more…" /> : null}
      {paged.nextCursor !== null && !paged.loadingMore && paged.moreError === null ? (
        <button type="button" class="load-more" onClick={paged.loadMore}>
          Load more
        </button>
      ) : null}
    </>
  );
}
