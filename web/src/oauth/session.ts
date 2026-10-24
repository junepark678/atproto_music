// The SPA's OAuth session (ADR 0004 §5.1, A3; W2-06).
//
// Wraps the configured `BrowserOAuthClient` (web/src/oauth/client.ts) and
// adapts its `OAuthSession` to the narrow `PdsSession` the outbox and the
// screens use (web/src/oauth/types.ts):
//
// - `signIn(handle)` starts the redirect flow with the granular scope
//   `atproto repo:<p>.scrobble repo:<p>.follow repo:<p>.settings`, where `<p>`
//   is the lexicon prefix the AppView advertises in `GET /api/v1/meta`.
// - `init()` restores a stored session or completes the OAuth callback. After
//   a completed callback it sends `POST /api/v1/notify {did}` so the AppView
//   admits the DID and schedules a snapshot (§5.1 step 5). A restore sends
//   nothing.
// - `signOut()` revokes upstream (through the library), then clears every
//   IndexedDB object store of this origin and the library's localStorage
//   pointer. A failed or hanging revocation never keeps the session usable:
//   `current()` is null before the revocation is attempted, and the local
//   clearing runs whatever the revocation outcome (the Rust oracle's
//   "invalidate locally first" rule, crates/server/src/http/logout.rs).
// - `current()` is the adapted session or null; `status()` and `subscribe()`
//   expose the anonymous / signed-in / re-auth-required state; `expiry()`
//   exposes the access-token expiry and the latest possible session end (a
//   public client's session lasts at most 14 days, atproto OAuth spec).
//
// A session that ends without a sign-out (failed refresh, a token the PDS
// rejects after refresh, an expired stored session) moves the state to
// `reauth-required`; any `PdsSession` handed out earlier then refuses to send.
//
// `connect(state)` binds the session to an `AppState` (web/src/state/store.ts):
// it runs `init()` and keeps `state.session` and `state.reauthRequired` equal
// to the session status from then on, so a restore that needs re-auth and a
// refresh that fails mid-session both show the shell's "Your session has
// ended" banner and the anonymous navigation. main.tsx boots through it.

import type { Did } from '@atmusic/core/api-types';
import { type Clock, systemClock } from '@atmusic/core/deps';
import { isDid, isHandle, normalizeHandle } from '@atmusic/core/syntax';
import {
  type HandleResolver,
  OAuthCallbackError,
  OAuthResolverError,
  TokenInvalidError,
  TokenRefreshError,
  TokenRevokedError,
} from '@atproto/oauth-client-browser';
import { type ApiClient, createApiClient, isApiFailure } from '../api/client';
import { type AppState, setSession } from '../state/store';
import {
  createOAuthClient,
  LIBRARY_DATABASE,
  LIBRARY_SUB_KEY,
  type LibraryClient,
  type LibrarySession,
  type OAuthClientConfig,
  scopeFor,
} from './client';
import type { PdsSession } from './types';

/** A public client's maximum session lifetime (atproto OAuth spec; ADR §5.1 step 4). */
export const PUBLIC_CLIENT_MAX_SESSION_MS = 14 * 24 * 60 * 60 * 1000;
/** Upper bound on waiting for upstream revocation during sign-out. */
export const DEFAULT_REVOKE_TIMEOUT_MS = 10_000;
/** localStorage key prefix for the time a DID's current session was authorized. */
export const SIGNED_IN_AT_KEY_PREFIX = 'atmusic:oauth:signed-in-at:';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Why a session ended without a sign-out. */
export type ReauthReason = 'refresh_failed' | 'token_invalid';

export type SessionStatus =
  | { readonly state: 'anonymous' }
  | { readonly state: 'signed-in'; readonly did: Did }
  | { readonly state: 'reauth-required'; readonly did: Did; readonly reason: ReauthReason };

export type InitResult =
  | { readonly kind: 'anonymous' }
  /** A stored session was restored (no notify is sent). */
  | { readonly kind: 'restored'; readonly did: Did }
  /** The OAuth callback completed; `notified` says whether notify {did} was accepted (202). */
  | { readonly kind: 'signed-in'; readonly did: Did; readonly notified: boolean }
  | { readonly kind: 'reauth-required'; readonly did: Did; readonly reason: ReauthReason };

export interface SessionExpiry {
  /** When the current access token expires (the library refreshes it before use). */
  readonly tokenExpiresAtMs: number | null;
  /** The latest the session can last: authorization time + 14 days; null when the authorization time is unknown. */
  readonly sessionEndsAtMs: number | null;
}

export interface SignOutResult {
  /**
   * `completed`: the library's revoke-and-forget finished (the library treats
   * the revocation request itself as best effort); `failed`: it rejected or
   * timed out; `none`: there was no live session to revoke.
   */
  readonly revocation: 'completed' | 'failed' | 'none';
  /** Every cleared object store, as `<database>/<store>`. */
  readonly clearedStores: readonly string[];
}

export type SignInErrorCode =
  | 'invalid_handle'
  | 'unknown_handle'
  | 'cancelled'
  | 'expired_callback'
  | 'unavailable'
  | 'failed';

/** A sign-in failure with a fixed, user-safe message (never an OAuth code, state or token). */
export class SignInError extends Error {
  constructor(
    readonly code: SignInErrorCode,
    options?: { cause?: unknown },
  ) {
    super(SIGN_IN_MESSAGES[code].message, options);
    this.name = 'SignInError';
  }
}

/** Recovery text for each sign-in failure, shared by the callback and sign-in screens. */
export const SIGN_IN_MESSAGES: Readonly<Record<SignInErrorCode, { title: string; message: string }>> = {
  invalid_handle: {
    title: 'That is not a valid handle',
    message: 'Enter a handle such as alice.example.com, without spaces.',
  },
  unknown_handle: {
    title: 'Handle not found',
    message: 'No account could be found for that handle. Check the spelling and try again.',
  },
  cancelled: {
    title: 'Sign-in was cancelled',
    message: 'Authorization was not granted. You can try again whenever you are ready.',
  },
  expired_callback: {
    title: 'This sign-in link has expired',
    message: 'The authorization took too long or was already used. Start the sign-in again.',
  },
  unavailable: {
    title: 'Sign-in is unavailable',
    message: 'The service could not be reached. Check your connection and try again.',
  },
  failed: {
    title: 'Sign-in could not be completed',
    message: 'Something went wrong while signing in. Start the sign-in again.',
  },
};

/** Thrown by a `PdsSession` whose session has ended; nothing was sent to the PDS. */
export class ReauthRequiredError extends Error {
  constructor(
    readonly did: Did,
    readonly reason: ReauthReason | 'signed_out',
    options?: { cause?: unknown },
  ) {
    super(reason === 'signed_out' ? 'The session was signed out.' : 'The session has ended; sign in again.', options);
    this.name = 'ReauthRequiredError';
  }
}

export interface SessionDeps {
  /** AppView client (meta, resolve, notify). Defaults to a same-origin client. */
  api?: ApiClient;
  /** The SPA origin. Defaults to `location.origin`. */
  origin?: string;
  clock?: Clock;
  /** localStorage. Defaults to `globalThis.localStorage`; null disables it. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** IndexedDB factory cleared on sign-out. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory | null;
  /** Builds the library client. Defaults to `createOAuthClient` (web/src/oauth/client.ts). */
  loadClient?: (config: OAuthClientConfig) => Promise<LibraryClient>;
  /** Fallback handle resolver passed to the client (defaults to the library's DoH resolver). */
  fallbackResolver?: HandleResolver;
  revokeTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

type EndedKind = ReauthReason | 'revoked';

function endedKind(error: unknown): EndedKind | null {
  if (error instanceof TokenRevokedError) return 'revoked';
  if (error instanceof TokenInvalidError) return 'token_invalid';
  if (error instanceof TokenRefreshError) return 'refresh_failed';
  return null;
}

function errorSub(error: unknown): string | null {
  const sub = (error as { sub?: unknown } | null)?.sub;
  return typeof sub === 'string' && isDid(sub) ? sub : null;
}

/** Maps an `init()` (callback) failure to a SignInError. */
export function callbackError(error: unknown): SignInError {
  if (error instanceof SignInError) return error;
  if (error instanceof OAuthCallbackError) {
    const code = error.params.get('error');
    if (code === 'access_denied') return new SignInError('cancelled', { cause: error });
    if (code === null && error.message.startsWith('Unknown authorization session')) {
      return new SignInError('expired_callback', { cause: error });
    }
    return new SignInError('failed', { cause: error });
  }
  if (isApiFailure(error)) return new SignInError('unavailable', { cause: error });
  return new SignInError('failed', { cause: error });
}

function signInError(error: unknown): SignInError {
  if (error instanceof SignInError) return error;
  if (error instanceof OAuthResolverError && error.message.startsWith('Failed to resolve identity')) {
    return new SignInError('unknown_handle', { cause: error });
  }
  if (isApiFailure(error)) return new SignInError('unavailable', { cause: error });
  return new SignInError('failed', { cause: error });
}

// ---------------------------------------------------------------------------
// IndexedDB clearing
// ---------------------------------------------------------------------------

/** Opens an existing database without creating it; null when it does not exist. */
function openExisting(idb: IDBFactory, name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let created = false;
    const request = idb.open(name);
    request.onupgradeneeded = () => {
      // A missing database would be created empty at version 1, and the
      // library's own open (version 1 with an upgrade that creates its stores)
      // would then never run that upgrade. Abort the creation instead.
      created = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => {
      if (created) {
        event.preventDefault();
        resolve(null);
      } else {
        reject(request.error);
      }
    };
  });
}

async function clearDatabase(idb: IDBFactory, name: string): Promise<string[]> {
  const db = await openExisting(idb, name);
  if (db === null) return [];
  try {
    const stores = Array.from(db.objectStoreNames);
    if (stores.length === 0) return [];
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      for (const store of stores) tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error(`clearing ${name} was aborted`));
    });
    return stores.map((store) => `${name}/${store}`);
  } finally {
    db.close();
  }
}

/**
 * Clears every object store of every IndexedDB database of this origin (the
 * library's OAuth stores and the outbox), keeping the schemas so connections
 * other modules hold stay valid. Returns the cleared stores.
 */
export async function clearIndexedDb(idb: IDBFactory): Promise<string[]> {
  const names = new Set<string>([LIBRARY_DATABASE]);
  if (typeof idb.databases === 'function') {
    for (const info of await idb.databases()) if (info.name) names.add(info.name);
  }
  const cleared: string[] = [];
  for (const name of [...names].sort()) cleared.push(...(await clearDatabase(idb, name)));
  return cleared;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** Placeholder origin a `PdsSession` path is resolved against to prove it stays on the PDS. */
const PATH_CHECK_BASE = 'https://pds.invalid';

/**
 * Validates a `PdsSession.fetchHandler` path and returns its canonical form
 * (pathname and query). The library resolves the path with
 * `new URL(path, tokenSet.aud)`, so anything that URL parsing would turn into
 * another host (a full URL, `//host`, and the WHATWG equivalents `/\host`
 * and `/<tab>/host`, since backslash counts as a slash and tab, CR and LF are
 * stripped) would send the DPoP-bound token and proof there. Refused: any
 * backslash, ASCII control character or space, and any path that does not
 * resolve to the placeholder origin. The canonical form is what is sent, so
 * the library receives exactly the path that was checked.
 */
export function pdsPath(path: string): string {
  const refuse = (): never => {
    throw new TypeError('PdsSession.fetchHandler takes a path on the PDS such as /xrpc/…, never a URL');
  };
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) refuse();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
  if (/[\\\u0000-\u0020\u007f]/.test(path)) refuse();
  let url: URL;
  try {
    url = new URL(path, PATH_CHECK_BASE);
  } catch {
    return refuse();
  }
  if (url.origin !== PATH_CHECK_BASE || url.username !== '' || url.password !== '') refuse();
  return `${url.pathname}${url.search}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class SessionController {
  readonly #api: ApiClient;
  readonly #origin: string;
  readonly #clock: Clock;
  readonly #storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  readonly #idb: IDBFactory | null;
  readonly #loadClient: (config: OAuthClientConfig) => Promise<LibraryClient>;
  readonly #fallbackResolver: HandleResolver | undefined;
  readonly #revokeTimeoutMs: number;

  #client: Promise<LibraryClient> | null = null;
  #prefix: Promise<string | null> | null = null;
  #init: Promise<InitResult> | null = null;
  #session: LibrarySession | null = null;
  #pds: PdsSession | null = null;
  #status: SessionStatus = { state: 'anonymous' };
  readonly #listeners = new Set<(status: SessionStatus) => void>();

  constructor(deps: SessionDeps = {}) {
    this.#api = deps.api ?? createApiClient();
    this.#origin = deps.origin ?? globalThis.location.origin;
    this.#clock = deps.clock ?? systemClock;
    this.#storage = deps.storage === undefined ? defaultStorage() : deps.storage;
    this.#idb = deps.indexedDB === undefined ? (globalThis.indexedDB ?? null) : deps.indexedDB;
    this.#loadClient = deps.loadClient ?? createOAuthClient;
    this.#fallbackResolver = deps.fallbackResolver;
    this.#revokeTimeoutMs = deps.revokeTimeoutMs ?? DEFAULT_REVOKE_TIMEOUT_MS;
  }

  /** The adapted session, or null when anonymous or when re-authentication is required. */
  current(): PdsSession | null {
    return this.#pds;
  }

  status(): SessionStatus {
    return this.#status;
  }

  /** Calls `listener` on every status change; returns the unsubscribe function. */
  subscribe(listener: (status: SessionStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Restores a stored session or completes the OAuth callback in the current
   * URL. Memoized: main.tsx and the callback route share one run. Rejects with
   * a SignInError when a callback fails; a stored session that can no longer
   * be refreshed resolves `reauth-required`.
   */
  init(): Promise<InitResult> {
    this.#init ??= this.#runInit();
    return this.#init;
  }

  /**
   * Starts the redirect sign-in for a handle (or DID). The library navigates
   * the page to the authorization server; the flow ends in `init()` on
   * /oauth/callback.
   */
  async signIn(handle: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const input = handle.trim().replace(/^@/, '');
    const normalized = isDid(input) ? input : normalizeHandle(input);
    if (!(isDid(normalized) || isHandle(normalized))) throw new SignInError('invalid_handle');
    let scope: string;
    let client: LibraryClient;
    try {
      scope = scopeFor(await this.#lexiconPrefix());
      client = await this.#libraryClient();
    } catch (error) {
      throw signInError(error);
    }
    try {
      await client.signIn(normalized, { scope, ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
      throw signInError(error);
    }
  }

  /**
   * Signs out: forgets the session in memory, asks the library to revoke and
   * delete it (bounded by a timeout), then clears every IndexedDB store and
   * the library's localStorage pointer, whatever the revocation outcome.
   */
  async signOut(): Promise<SignOutResult> {
    const session = this.#session;
    const statusDid = this.#status.state === 'anonymous' ? null : this.#status.did;
    const did = session?.did ?? statusDid;
    this.#session = null;
    this.#pds = null;
    this.#init = null;
    this.#setStatus({ state: 'anonymous' });

    let revocation: SignOutResult['revocation'] = 'none';
    if (session !== null) {
      try {
        await withTimeout(session.signOut(), this.#revokeTimeoutMs);
        revocation = 'completed';
      } catch {
        revocation = 'failed';
      }
    }

    this.#forgetStorage(did);
    const clearedStores = this.#idb === null ? [] : await clearIndexedDb(this.#idb);
    // The library may report the deletion it performed after we already went
    // anonymous; make sure nothing it did re-entered a state.
    this.#setStatus({ state: 'anonymous' });
    return { revocation, clearedStores };
  }

  /** The session's expiry, or null when there is no live session. */
  async expiry(): Promise<SessionExpiry | null> {
    const session = this.#session;
    if (session === null) return null;
    let tokenExpiresAtMs: number | null = null;
    try {
      const info = await session.getTokenInfo(false);
      tokenExpiresAtMs = info.expiresAt ? info.expiresAt.getTime() : null;
    } catch (error) {
      if (this.#handleEnded(session.did, error)) return null;
      throw error;
    }
    const signedInAt = this.#signedInAt(session.did);
    return {
      tokenExpiresAtMs,
      sessionEndsAtMs: signedInAt === null ? null : signedInAt + PUBLIC_CLIENT_MAX_SESSION_MS,
    };
  }

  // -- internals -------------------------------------------------------------

  async #runInit(): Promise<InitResult> {
    let client: LibraryClient;
    try {
      client = await this.#libraryClient();
    } catch (error) {
      this.#init = null;
      throw callbackError(error);
    }
    let result: Awaited<ReturnType<LibraryClient['init']>>;
    try {
      result = await client.init();
    } catch (error) {
      const kind = endedKind(error);
      const sub = errorSub(error);
      if (kind !== null && kind !== 'revoked' && sub !== null) {
        this.#reauth(sub, kind);
        return { kind: 'reauth-required', did: sub, reason: kind };
      }
      if (kind === 'revoked') return { kind: 'anonymous' };
      throw callbackError(error);
    }
    if (result === undefined) {
      const status = this.#status;
      return status.state === 'reauth-required'
        ? { kind: 'reauth-required', did: status.did, reason: status.reason }
        : { kind: 'anonymous' };
    }

    const session = result.session;
    const did: Did = session.did;
    this.#adopt(session);
    if (!('state' in result)) return { kind: 'restored', did };

    // A completed callback: a new authorization.
    this.#writeStorage(`${SIGNED_IN_AT_KEY_PREFIX}${did}`, String(this.#clock.nowMs()));
    let notified = false;
    try {
      await this.#api.notify({ did });
      notified = true;
    } catch (error) {
      // Best effort: the AppView also learns the DID from the first write's
      // notify. A non-API failure is a bug and is rethrown.
      if (!isApiFailure(error)) throw error;
    }
    return { kind: 'signed-in', did, notified };
  }

  #libraryClient(): Promise<LibraryClient> {
    if (this.#client === null) {
      const attempt = (async () => {
        // Only the loopback client id embeds the scope; a deployed origin's
        // client id is its metadata URL and needs no meta request.
        const prefix = this.#origin.startsWith('http:') ? await this.#lexiconPrefix() : null;
        return this.#loadClient({
          origin: this.#origin,
          prefix,
          api: this.#api,
          ...(this.#fallbackResolver ? { fallbackResolver: this.#fallbackResolver } : {}),
          onSessionDeleted: (sub, cause) => this.#onSessionDeleted(sub, cause),
        });
      })();
      this.#client = attempt;
      attempt.catch(() => {
        if (this.#client === attempt) this.#client = null;
      });
    }
    return this.#client;
  }

  #lexiconPrefix(): Promise<string | null> {
    if (this.#prefix === null) {
      const attempt = this.#api.meta().then((meta) => meta.lexiconPrefix);
      this.#prefix = attempt;
      attempt.catch(() => {
        if (this.#prefix === attempt) this.#prefix = null;
      });
    }
    return this.#prefix;
  }

  #adopt(session: LibrarySession): void {
    const did: Did = session.did;
    this.#session = session;
    const pds: PdsSession = {
      did,
      fetchHandler: async (path: string, init?: RequestInit): Promise<Response> => {
        const target = pdsPath(path);
        if (this.#session !== session) {
          const status = this.#status;
          throw new ReauthRequiredError(did, status.state === 'reauth-required' ? status.reason : 'signed_out');
        }
        try {
          return await session.fetchHandler(target, init);
        } catch (error) {
          if (this.#handleEnded(did, error)) {
            const status = this.#status;
            throw new ReauthRequiredError(did, status.state === 'reauth-required' ? status.reason : 'signed_out', {
              cause: error,
            });
          }
          throw error;
        }
      },
      signOut: async () => {
        await this.signOut();
      },
    };
    this.#pds = pds;
    this.#setStatus({ state: 'signed-in', did });
  }

  /** Applies a session-ended error for `did`; true when `error` was one. */
  #handleEnded(did: Did, error: unknown): boolean {
    const kind = endedKind(error);
    if (kind === null) return false;
    if (kind === 'revoked') this.#drop(did);
    else this.#reauth(did, kind);
    return true;
  }

  /** The library deleted a stored session (here or in another tab). */
  #onSessionDeleted(sub: string, cause: unknown): void {
    const current = this.#session?.did ?? (this.#status.state === 'anonymous' ? null : this.#status.did);
    if (current !== sub) return;
    const kind = endedKind(cause);
    // Another tab signed out (TokenRevokedError): this tab is anonymous too.
    if (kind === 'revoked') this.#drop(sub);
    else this.#reauth(sub, kind ?? 'refresh_failed');
  }

  #drop(did: string): void {
    if (this.#session?.did === did) {
      this.#session = null;
      this.#pds = null;
    }
    this.#forgetStorage(did);
    this.#setStatus({ state: 'anonymous' });
  }

  #reauth(did: Did, reason: ReauthReason): void {
    if (this.#session?.did === did) {
      this.#session = null;
      this.#pds = null;
    }
    this.#removeStorage(`${SIGNED_IN_AT_KEY_PREFIX}${did}`);
    const status = this.#status;
    if (status.state === 'reauth-required' && status.did === did && status.reason === reason) return;
    this.#setStatus({ state: 'reauth-required', did, reason });
  }

  #setStatus(status: SessionStatus): void {
    if (sameStatus(this.#status, status)) return;
    this.#status = status;
    for (const listener of [...this.#listeners]) listener(status);
  }

  #signedInAt(did: Did): number | null {
    const raw = this.#readStorage(`${SIGNED_IN_AT_KEY_PREFIX}${did}`);
    if (raw === null || !/^\d+$/.test(raw)) return null;
    const ms = Number(raw);
    return Number.isSafeInteger(ms) ? ms : null;
  }

  #forgetStorage(did: string | null): void {
    if (did !== null) this.#removeStorage(`${SIGNED_IN_AT_KEY_PREFIX}${did}`);
    // Without its session record, a left-over pointer would make the next
    // restore fail and look like an expired session instead of a sign-out.
    this.#removeStorage(LIBRARY_SUB_KEY);
  }

  #readStorage(key: string): string | null {
    try {
      return this.#storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  #writeStorage(key: string, value: string): void {
    try {
      this.#storage?.setItem(key, value);
    } catch {
      // Storage may be unavailable (private mode); the expiry is then unknown.
    }
  }

  #removeStorage(key: string): void {
    try {
      this.#storage?.removeItem(key);
    } catch {
      // As above.
    }
  }
}

function sameStatus(a: SessionStatus, b: SessionStatus): boolean {
  if (a.state === 'anonymous' || b.state === 'anonymous') return a.state === b.state;
  if (a.did !== b.did || a.state !== b.state) return false;
  return a.state !== 'reauth-required' || b.state !== 'reauth-required' || a.reason === b.reason;
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createSession(deps: SessionDeps = {}): SessionController {
  return new SessionController(deps);
}

/**
 * Binds `controller` (the page's session by default) to `state` for the
 * page's lifetime and runs `init()`. main.tsx boots through it.
 *
 * - signed-in: `state.session` is the adapted session (recorded once per
 *   session, so a verified handle set later is kept), `reauthRequired` false;
 * - reauth-required: no session, `reauthRequired` true (the shell's banner);
 * - anonymous (signed out here or in another tab): no session, no banner.
 *
 * The state is applied after `init()` settles, whatever its outcome, and on
 * every later status change (a refresh that fails while the outbox writes, a
 * sign-out). A rejected callback is rethrown after the state is applied.
 */
export async function connect(state: AppState, controller: SessionController = session()): Promise<InitResult> {
  const apply = (status: SessionStatus): void => {
    if (status.state === 'signed-in') {
      const pds = controller.current();
      if (state.session.value !== pds) setSession(state, pds);
      state.reauthRequired.value = false;
      return;
    }
    if (state.session.value !== null || state.handle.value !== null) setSession(state, null);
    state.reauthRequired.value = status.state === 'reauth-required';
  };
  controller.subscribe(apply);
  try {
    return await controller.init();
  } finally {
    apply(controller.status());
  }
}

// ---------------------------------------------------------------------------
// The SPA's session (the SessionModule surface of web/src/oauth/types.ts)
// ---------------------------------------------------------------------------

let spaSession: SessionController | null = null;

/** The page's session controller (same origin, system clock, localStorage, IndexedDB). */
export function session(): SessionController {
  spaSession ??= createSession();
  return spaSession;
}

export function init(): Promise<InitResult> {
  return session().init();
}

export function signIn(handle: string, options?: { signal?: AbortSignal }): Promise<void> {
  return session().signIn(handle, options);
}

export function signOut(): Promise<SignOutResult> {
  return session().signOut();
}

export function current(): PdsSession | null {
  return session().current();
}

export function status(): SessionStatus {
  return session().status();
}

export function subscribe(listener: (status: SessionStatus) => void): () => void {
  return session().subscribe(listener);
}

export function expiry(): Promise<SessionExpiry | null> {
  return session().expiry();
}
