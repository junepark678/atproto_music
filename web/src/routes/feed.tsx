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
import { useCallback, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ListeningNow, NowPlayingCard } from '../components/now-playing';
import { withDueAt } from '../components/operation-status';
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
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  function navigateTab(event: KeyboardEvent, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let next: number;
    switch (event.key) {
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = SCOPES.length - 1;
        break;
      case 'ArrowRight':
        next = (index + 1) % SCOPES.length;
        break;
      case 'ArrowLeft':
        next = (index + SCOPES.length - 1) % SCOPES.length;
        break;
      default:
        return;
    }
    event.preventDefault();
    const tab = tabRefs.current[next];
    tab?.focus();
    tab?.click();
  }
  const session = state.session.value;
  const viewer = scope === 'following' ? (session?.did ?? null) : null;

  return (
    <section aria-labelledby="page-title">
      <header class="feed-masthead">
        <div class="masthead-record" aria-hidden="true">
          <span />
        </div>
        <h1 id="page-title">Feed</h1>
      </header>
      {session !== null ? (
        <>
          <NowPlayingCard api={state.api} did={session.did} owner />
          <ListeningNow key={session.did} api={state.api} viewer={session.did} />
        </>
      ) : null}
      <div class="tabs" role="tablist" aria-label="Feed scope">
        {SCOPES.map((s, index) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`feed-tab-${s.id}`}
            aria-selected={s.id === scope}
            tabIndex={s.id === scope ? 0 : -1}
            aria-controls="feed-panel"
            data-scope={s.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            onKeyDown={(event) => navigateTab(event, index)}
            onClick={() => setScope(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Tab must reach the active panel even when it contains only text. */}
      <div id="feed-panel" role="tabpanel" tabIndex={0} aria-labelledby={`feed-tab-${scope}`}>
        {scope === 'following' && session === null ? (
          <SignInPrompt>Sign in to see scrobbles from the accounts you follow.</SignInPrompt>
        ) : (
          <FeedList key={viewer ?? scope} scope={scope} viewer={viewer} />
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
      ? overlayScrobbles(paged.items, ops, session.did, { includePending: false }).items.map((item) =>
          item.local === undefined ? item : { ...item, local: withDueAt(item.local, ops) },
        )
      : paged.items.map((scrobble) => ({ scrobble }));

  return (
    <>
      {paged.indexing ? <StaleNotice indexing={paged.indexing} /> : null}
      {items.length === 0 && paged.nextCursor === null ? (
        <EmptyState>
          {scope === 'following' ? (
            'No scrobbles from the accounts you follow yet.'
          ) : (
            <>
              No scrobbles yet.
              {state.canPublish.value && session?.status === 'active' ? (
                <>
                  {' '}
                  <a href="/scrobble">Add a scrobble</a>
                </>
              ) : null}
            </>
          )}
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
