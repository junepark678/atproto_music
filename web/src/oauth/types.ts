// The narrow session interface the SPA's PDS writers depend on (ADR 0004 §5.2).
//
// The outbox (W2-07) and the screens use only this, never the OAuth library,
// so tests can drive them with a fake PDS. web/src/oauth/session.ts (W2-06)
// adapts an @atproto/oauth-client-browser `OAuthSession`, whose `did`,
// `fetchHandler` and `signOut` already have these shapes.

import type { Did } from '@atmusic/core/api-types';

export interface PdsSession {
  /** The signed-in account's DID; every write goes to this DID's own PDS. */
  readonly did: Did;
  /**
   * Sends an authenticated (DPoP-bound) request to the user's PDS. `path` is a
   * path on the PDS such as `/xrpc/com.atproto.repo.createRecord`, never a full
   * URL: the session decides the PDS origin from the verified identity.
   */
  fetchHandler(path: string, init?: RequestInit): Promise<Response>;
  /** Revokes the tokens (best effort) and forgets the session locally. */
  signOut(): Promise<void>;
}
