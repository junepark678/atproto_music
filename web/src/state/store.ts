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
import type { PdsSession } from '../oauth/types';

export interface AppState {
  readonly api: ApiClient;
  /** The signed-in session, or null when anonymous. Set by web/src/oauth/session.ts. */
  readonly session: Signal<PdsSession | null>;
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

export function createAppState(options: { api?: ApiClient } = {}): AppState {
  const session = signal<PdsSession | null>(null);
  const meta = signal<Meta | null>(null);
  return {
    api: options.api ?? createApiClient(),
    session,
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

/** Records a new session (or null after sign-out) and clears per-session data. */
export function setSession(state: AppState, session: PdsSession | null, handle: Handle | null = null): void {
  state.session.value = session;
  state.handle.value = session ? handle : null;
  state.reauthRequired.value = false;
}

export const AppStateContext = createContext<AppState | null>(null);

export function useAppState(): AppState {
  const state = useContext(AppStateContext);
  if (state === null) throw new Error('useAppState() needs an <AppStateContext.Provider> (see web/src/app.tsx)');
  return state;
}
