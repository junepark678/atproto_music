// /u/:did (M7.3.2, M7.3.3, M7.2.3 delete_owner).
//
// - Identity is the DID in the URL. The handle shown is the AppView's
//   verified handle (Profile.handle), and "Refresh" re-reads the no-store
//   profile, so a new verified handle for the same DID updates the header
//   without leaving the route or reloading the history.
// - A DID the AppView does not know (404) gets an explicit not-found view:
//   no zeroed counts, no history, no statistics.
// - History is paginated with nextCursor; statistics have window tabs.
// - Follow: signed-in viewers of another account get the follow control
//   (outbox state), anonymous viewers a sign-in action, and the owner none.
// - Delete: only the signed-in owner, and only with publication, sees delete
//   controls; pending deletes are hidden through the outbox overlay and the
//   owner's not-yet-indexed creates are listed with their state.

import type { Did, Profile, Scrobble } from '@atmusic/core/api-types';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { isDid } from '../api/client';
import { FollowButton, type FollowEdge } from '../components/follow-button';
import { formatUtc, isNotFound } from '../components/format';
import { isPending, OperationStatus, withDueAt } from '../components/operation-status';
import type { OutboxService } from '../components/outbox-service';
import { usePaged } from '../components/paged';
import { type ListItem, ScrobbleList, ScrobbleText } from '../components/scrobble-list';
import { recordVerifiedHandle, useSessionHandle } from '../components/session-identity';
import { EmptyState, ErrorState, LoadingState, SignInPrompt, StaleNotice } from '../components/state-views';
import { StatsPanel } from '../components/stats-panel';
import { useOutbox, useOutboxOps } from '../components/use-outbox';
import { overlayScrobbles } from '../outbox/overlay';
import type { OutboxOperation } from '../outbox/store';
import { useAppState } from '../state/store';

type ProfileLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; profile: Profile; refreshing: boolean; refreshError: unknown }
  | { kind: 'not-found' }
  | { kind: 'error'; error: unknown };

export default function ProfileScreen() {
  const { params } = useRoute();
  const did = params.did ?? '';
  useSessionHandle();
  if (!isDid(did)) return <NotFoundProfile did={did} reason="invalid" />;
  return <ProfileForDid did={did} />;
}

function NotFoundProfile({ did, reason }: { did: string; reason: 'invalid' | 'unknown' }) {
  const own = useAppState().session.value?.did === did;
  return (
    <section aria-labelledby="page-title" data-state="not-found">
      <h1 id="page-title">Profile not found</h1>
      {reason === 'invalid' ? (
        <p>This address does not contain a valid DID.</p>
      ) : own ? (
        <p>
          Your account (<code>{did}</code>) is not in the index yet. Records you publish appear here once the index has
          verified them.
        </p>
      ) : (
        <p>
          The index has no active account for <code>{did}</code>. It may not have published any music records yet, it
          may have opted out of indexing, or the DID may be wrong.
        </p>
      )}
      <p>
        <a href="/feed">Go to the feed</a>
      </p>
    </section>
  );
}

function ProfileForDid({ did }: { did: Did }) {
  const state = useAppState();
  const [load, setLoad] = useState<ProfileLoad>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setLoad({ kind: 'loading' });
    state.api.profile(did, { signal: abort.signal }).then(
      (profile) => {
        if (abort.signal.aborted) return;
        recordVerifiedHandle(state, profile.did, profile.handle);
        setLoad({ kind: 'ready', profile, refreshing: false, refreshError: null });
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        setLoad(isNotFound(error) ? { kind: 'not-found' } : { kind: 'error', error });
      },
    );
    return () => abort.abort();
  }, [state, did, attempt]);

  /** Re-reads the profile in place (header only; history and statistics stay). */
  const refresh = useCallback(() => {
    setLoad((current) => (current.kind === 'ready' ? { ...current, refreshing: true, refreshError: null } : current));
    state.api.profile(did).then(
      (profile) => {
        recordVerifiedHandle(state, profile.did, profile.handle);
        setLoad((current) =>
          current.kind === 'ready' && current.profile.did === did
            ? { kind: 'ready', profile, refreshing: false, refreshError: null }
            : current,
        );
      },
      (error: unknown) => {
        setLoad((current) =>
          isNotFound(error)
            ? { kind: 'not-found' }
            : current.kind === 'ready'
              ? { ...current, refreshing: false, refreshError: error }
              : current,
        );
      },
    );
  }, [state, did]);

  if (load.kind === 'loading') {
    return (
      <section aria-labelledby="page-title">
        <h1 id="page-title">Profile</h1>
        <LoadingState label="Loading the profile…" />
      </section>
    );
  }
  if (load.kind === 'not-found') return <NotFoundProfile did={did} reason="unknown" />;
  if (load.kind === 'error') {
    return (
      <section aria-labelledby="page-title">
        <h1 id="page-title">Profile</h1>
        <ErrorState
          title="The profile could not be loaded."
          error={load.error}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      </section>
    );
  }
  return (
    <ProfileView
      profile={load.profile}
      refreshing={load.refreshing}
      refreshError={load.refreshError}
      onRefresh={refresh}
    />
  );
}

interface ProfileViewProps {
  profile: Profile;
  refreshing: boolean;
  refreshError: unknown;
  onRefresh(): void;
}

function ProfileView({ profile, refreshing, refreshError, onRefresh }: ProfileViewProps) {
  const state = useAppState();
  const session = state.session.value;
  const own = session !== null && session.did === profile.did;
  const outboxState = useOutbox();
  const outbox = outboxState.status === 'ready' ? outboxState.outbox : null;
  const ops = useOutboxOps(outbox);

  return (
    <section aria-labelledby="page-title" class="profile">
      <header class="profile-header">
        <h1 id="page-title">{profile.handle !== null ? `@${profile.handle}` : 'Handle not verified'}</h1>
        <p class="profile-did">
          <code>{profile.did}</code>
        </p>
        <dl class="stats-totals profile-counts">
          <div>
            <dt>Scrobbles</dt>
            <dd data-count="scrobbles">{profile.totalScrobbles}</dd>
          </div>
          <div>
            <dt>Following</dt>
            <dd data-count="following">{profile.followingCount}</dd>
          </div>
          <div>
            <dt>Followers</dt>
            <dd data-count="followers">{profile.followerCount}</dd>
          </div>
        </dl>
        <p class="scrobble-meta">
          Joined <time dateTime={profile.joinedAt}>{formatUtc(profile.joinedAt)}</time>
          {profile.indexedAt !== null ? (
            <>
              {' · '}last indexed <time dateTime={profile.indexedAt}>{formatUtc(profile.indexedAt)}</time>
            </>
          ) : null}
        </p>
        <StaleNotice indexing={profile.indexing} />
        <div class="actions">
          <button type="button" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh profile'}
          </button>
        </div>
        {refreshError !== null ? <ErrorState title="The profile could not be refreshed." error={refreshError} /> : null}
        {session === null ? (
          <SignInPrompt action="Sign in to follow">Sign in to follow this account.</SignInPrompt>
        ) : !own && outbox !== null ? (
          <ProfileFollow viewer={session.did} subject={profile.did} outbox={outbox} ops={ops} onSettled={onRefresh} />
        ) : null}
      </header>

      <section aria-labelledby="stats-title">
        <h2 id="stats-title">Statistics</h2>
        <StatsPanel api={state.api} did={profile.did} />
      </section>

      <section aria-labelledby="history-title">
        <h2 id="history-title">History</h2>
        <History did={profile.did} outbox={own ? outbox : null} ops={own ? ops : null} />
      </section>
    </section>
  );
}

/** Pages of 100 scanned before the edge is reported unknown. */
const EDGE_SCAN_PAGES = 10;

/**
 * Whether the viewer's indexed following list contains `subject` (bounded scan
 * of pages of 100). Reaching the page cap with more pages left is 'unknown',
 * not false: the subject may be on a page that was not read.
 */
async function indexedEdge(
  state: ReturnType<typeof useAppState>,
  viewer: Did,
  subject: Did,
  signal: AbortSignal,
): Promise<true | false | 'unknown'> {
  let cursor: string | null = null;
  for (let page = 0; page < EDGE_SCAN_PAGES; page++) {
    const result = await state.api.following(viewer, { limit: 100, cursor }, { signal });
    if (result.items.some((f) => f.subject === subject)) return true;
    if (result.nextCursor === null) return false;
    cursor = result.nextCursor;
  }
  return 'unknown';
}

function ProfileFollow({
  viewer,
  subject,
  outbox,
  ops,
  onSettled,
}: {
  viewer: Did;
  subject: Did;
  outbox: OutboxService;
  ops: OutboxOperation[] | null;
  onSettled(): void;
}) {
  const state = useAppState();
  const [edge, setEdge] = useState<FollowEdge>(null);
  const [check, setCheck] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setEdge(null);
    indexedEdge(state, viewer, subject, abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setEdge(value);
      },
      () => {
        // A failed lookup is unknown, never "not following": the control
        // says it could not check and offers a re-check.
        if (!abort.signal.aborted) setEdge('unknown');
      },
    );
    return () => abort.abort();
  }, [state, viewer, subject, check]);

  // When the newest intent settles or stops being polled, re-read the edge and the counts.
  const newest = ops
    ?.filter((op) => op.subject === subject && (op.kind === 'follow_create' || op.kind === 'follow_delete'))
    .at(-1);
  // Settled includes a published row whose polling stopped (dueAt null): the
  // edge is then what decides the offered action, so it is read again.
  const settledKey = newest !== undefined && !isPending(newest) ? newest.id : null;
  // undefined until the rows are first read: an intent settled before this view opened triggers nothing.
  const seen = useRef<string | null | undefined>(undefined);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const loaded = ops !== null;
  useEffect(() => {
    if (!loaded) return;
    if (seen.current === undefined) {
      seen.current = settledKey;
      return;
    }
    if (settledKey === seen.current) return;
    seen.current = settledKey;
    if (settledKey === null) return;
    setCheck((n) => n + 1);
    settledRef.current();
  }, [loaded, settledKey]);

  return (
    <FollowButton
      viewer={viewer}
      subject={subject}
      ops={ops}
      edge={edge}
      onFollow={() => outbox.follow(subject)}
      onUnfollow={() => outbox.unfollow(subject)}
      onRecheck={() => setCheck((n) => n + 1)}
    />
  );
}

function History({ did, outbox, ops }: { did: Did; outbox: OutboxService | null; ops: OutboxOperation[] | null }) {
  const state = useAppState();
  const load = useCallback(
    (cursor: string | null, signal: AbortSignal) => state.api.userScrobbles(did, { cursor }, { signal }),
    [state, did],
  );
  const paged = usePaged<Scrobble>(did, load);

  if (paged.phase === 'loading') return <LoadingState label="Loading the history…" />;
  if (paged.phase === 'error') {
    return <ErrorState title="The history could not be loaded." error={paged.error} onRetry={paged.retry} />;
  }
  const overlay = outbox !== null && ops !== null ? overlayScrobbles(paged.items, ops, did) : null;
  const items: ListItem[] =
    overlay !== null && ops !== null
      ? overlay.items.map((item) => (item.local === undefined ? item : { ...item, local: withDueAt(item.local, ops) }))
      : paged.items.map((scrobble) => ({ scrobble }));
  const pending = overlay?.pending ?? [];

  return (
    <>
      {paged.indexing ? <StaleNotice indexing={paged.indexing} /> : null}
      {pending.length > 0 ? (
        <>
          <h3 id="pending-title">Not in the index yet</h3>
          <ul class="scrobble-list" aria-labelledby="pending-title">
            {pending.map((p) => (
              <li key={p.uri} data-uri={p.uri}>
                <ScrobbleText scrobble={pendingText(p.record, did)} />
                <OperationStatus op={ops !== null ? withDueAt(p.local, ops) : p.local} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {items.length === 0 && paged.nextCursor === null ? (
        <EmptyState>No scrobbles yet.</EmptyState>
      ) : (
        <ScrobbleList
          items={items}
          label="Listening history"
          canDelete={(s) => outbox !== null && s.did === outbox.did}
          onDelete={async (s) => {
            await outbox?.deleteScrobble(s.uri);
          }}
        />
      )}
      {paged.moreError !== null ? (
        <ErrorState title="More history could not be loaded." error={paged.moreError} onRetry={paged.retry} />
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

function pendingText(record: Record<string, unknown>, did: Did) {
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const album = typeof record.album === 'string' ? record.album : undefined;
  return {
    did,
    artist: text('artist'),
    track: text('track'),
    listenedAt: text('listenedAt'),
    ...(album !== undefined ? { album } : {}),
  };
}
