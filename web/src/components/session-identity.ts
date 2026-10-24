// The shell shows the signed-in DID and, once known, its verified handle
// (state.handle). The AppView's profile carries the handle only after the
// bidirectional check (Profile.handle is null otherwise), so the screens ask
// for the session DID's profile once per session and record a verified
// handle. A profile that is not indexed yet (404) leaves the DID alone shown.

import type { Handle } from '@atmusic/core/api-types';
import { useEffect } from 'preact/hooks';
import type { PdsSession } from '../oauth/types';
import { type AppState, useAppState } from '../state/store';

const asked = new WeakMap<AppState, PdsSession>();

/** Records a verified handle for the session DID, when the profile reports one. */
export function recordVerifiedHandle(state: AppState, did: string, handle: Handle | null): void {
  const session = state.session.value;
  if (session === null || session.did !== did) return;
  if (state.handle.value !== handle) state.handle.value = handle;
}

export function useSessionHandle(): void {
  const state = useAppState();
  const session = state.session.value;
  useEffect(() => {
    if (session === null || asked.get(state) === session) return;
    asked.set(state, session);
    state.api.profile(session.did).then(
      (profile) => recordVerifiedHandle(state, profile.did, profile.handle),
      () => undefined,
    );
  }, [state, session]);
}
