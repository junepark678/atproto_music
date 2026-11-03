// Minimal signals-based application state shared by the shell and the routes.
//
// One `AppState` per mounted app (tests create their own), handed down through
// `AppStateContext`. It holds only what several screens read: the API client,
// the current PDS session and its verified handle, and the server's meta.
// Screen-local state stays in the screens; outbox state lives in IndexedDB.

import type { Handle, Meta } from '@atmusic/core/api-types';
import { computed, type ReadonlySignal, type Signal, signal } from '@preact/signals';
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { type ApiClient, type ApiFailure, createApiClient, isApiFailure } from '../api/client';
import type { Session } from '../session/client';

export interface ScrobbleDraftValues {
  artist: string;
  track: string;
  album: string;
  listenedAt: string;
  durationSeconds: string;
  recordingMbid: string;
}

export interface ScrobbleDraft {
  /** Drafts belong to the account that started them and never cross accounts. */
  did: string;
  /** Changes on each edit so an older in-flight write cannot clear a newer draft. */
  revision: number;
  values: ScrobbleDraftValues;
}

export interface AppState {
  readonly api: ApiClient;
  /** The signed-in cookie BFF session, or null when anonymous. */
  readonly session: Signal<Session | null>;
  /** Non-secret scrobble form values kept in memory across a reauthentication. */
  readonly scrobbleDraft: Signal<ScrobbleDraft | null>;
  /** The session DID's verified handle (from /api/v1/resolve or the profile), when known. */
  readonly handle: Signal<Handle | null>;
  /** True when the session expired or refresh failed and the user must sign in again. */
  readonly reauthRequired: Signal<boolean>;
  /** `GET /api/v1/meta`, once loaded. */
  readonly meta: Signal<Meta | null>;
  readonly metaError: Signal<ApiFailure | null>;
  readonly signedIn: ReadonlySignal<boolean>;
  /**
   * The write UI is offered only when the deployment publishes under an owned
   * prefix: meta advertises `publication` (A20) and names the prefix.
   */
  readonly canPublish: ReadonlySignal<boolean>;
}

const draftRevision = new WeakMap<AppState, number>();

export function createAppState(options: { api?: ApiClient } = {}): AppState {
  const session = signal<Session | null>(null);
  const meta = signal<Meta | null>(null);
  return {
    api: options.api ?? createApiClient(),
    session,
    scrobbleDraft: signal<ScrobbleDraft | null>(null),
    handle: signal<Handle | null>(null),
    reauthRequired: signal(false),
    meta,
    metaError: signal<ApiFailure | null>(null),
    signedIn: computed(() => session.value !== null),
    canPublish: computed(() => {
      const m = meta.value;
      return m !== null && m.lexiconPrefix !== null && m.capabilities.includes('publication');
    }),
  };
}

/** Loads meta into the state. A failure is kept in `metaError`, never thrown. */
export async function loadMeta(state: AppState, abort?: AbortSignal): Promise<void> {
  try {
    state.meta.value = await state.api.meta(abort ? { signal: abort } : undefined);
    state.metaError.value = null;
  } catch (error) {
    if (!isApiFailure(error)) throw error;
    state.metaError.value = error;
  }
}

/** Records the session; only a reauthentication transition preserves its draft. */
export function setSession(
  state: AppState,
  session: Session | null,
  handle: Handle | null = null,
  options: { reauthRequired?: boolean } = {},
): void {
  const reauthRequired = options.reauthRequired ?? false;
  const draft = state.scrobbleDraft.value;
  if ((session === null && !reauthRequired) || (session !== null && draft !== null && draft.did !== session.did)) {
    state.scrobbleDraft.value = null;
  }
  state.session.value = session;
  state.handle.value = session ? handle : null;
  state.reauthRequired.value = reauthRequired;
}

/** Updates the active account's non-secret scrobble draft in memory. */
export function setScrobbleDraft(state: AppState, values: ScrobbleDraftValues): void {
  const did = state.session.value?.did;
  if (did === undefined) return;
  const revision = (draftRevision.get(state) ?? 0) + 1;
  draftRevision.set(state, revision);
  state.scrobbleDraft.value = { did, revision, values: { ...values } };
}

export function clearScrobbleDraft(state: AppState): void {
  state.scrobbleDraft.value = null;
}

export const AppStateContext = createContext<AppState | null>(null);

export function useAppState(): AppState {
  const state = useContext(AppStateContext);
  if (state === null) throw new Error('useAppState() needs an <AppStateContext.Provider> (see web/src/app.tsx)');
  return state;
}
