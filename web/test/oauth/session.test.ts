// SPA OAuth session tests (W2-06; ADR 0004 §5.1, A3; TESTING.md "Security and
// async side effects": requested scope, notify {did} after the callback,
// sign-out clears IndexedDB, re-auth state after a failed refresh).
//
// `@atproto/oauth-client-browser` is mocked at the module boundary by a fake
// that behaves like the library where this package depends on it: it keeps
// its state, session and cache records in the real IndexedDB database
// `@atproto-oauth-client` (fake-indexeddb) with the library's seven stores,
// remembers the signed-in DID under the library's localStorage key, resolves
// handles through the `handleResolver` it is given, exchanges the code, and
// refreshes, revokes and calls `onSessionDeleted` against a fake
// authorization server whose answers each test sets. The AppView is an
// injected fetch serving contract-shaped responses. Time is the frozen clock;
// nothing reaches the network. Each test asserts requests sent (AppView,
// authorization server, PDS), IndexedDB and localStorage contents, and the
// session state.

import { fixedClock } from '@atmusic/core/test-support/clock';
import { IDBFactory } from 'fake-indexeddb';
import { h, render } from 'preact';
import { LocationProvider } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, type FetchLike } from '../../src/api/client';
import { LIBRARY_DATABASE, LIBRARY_SUB_KEY } from '../../src/oauth/client';
import {
  createSession,
  PUBLIC_CLIENT_MAX_SESSION_MS,
  ReauthRequiredError,
  type SessionStatus,
  SIGNED_IN_AT_KEY_PREFIX,
  SignInError,
} from '../../src/oauth/session';
import Callback from '../../src/routes/callback';
import { AppStateContext, createAppState } from '../../src/state/store';

// ---------------------------------------------------------------------------
// The library fake (hoisted: vi.mock's factory runs before the imports)
// ---------------------------------------------------------------------------

const lib = vi.hoisted(() => {
  const STORES = [
    'state',
    'session',
    'didCache',
    'dpopNonceCache',
    'handleCache',
    'authorizationServerMetadataCache',
    'protectedResourceMetadataCache',
  ] as const;
  const DB_NAME = '@atproto-oauth-client';
  const SUB_KEY = '@@atproto/oauth-client-browser(sub)';
  const AS_ISSUER = 'https://auth.pds.example.org';
  const PDS_ORIGIN = 'https://pds.example.org';
  const TOKEN_LIFETIME_MS = 15 * 60 * 1000;

  interface StoredSession {
    tokenSet: {
      sub: string;
      iss: string;
      aud: string;
      scope: string;
      access_token: string;
      refresh_token: string;
      expires_at: number;
    };
  }

  const world = {
    idb: null as IDBFactory | null,
    storage: null as Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
    nowMs: (): number => {
      throw new Error('world.nowMs not set');
    },
    /** Query parameters of the current URL when it is an OAuth callback. */
    callbackParams: null as URLSearchParams | null,
    loads: [] as Record<string, unknown>[],
    authorizations: [] as { input: string; did: string; scope: string | undefined; clientId: unknown; state: string }[],
    /** Requests the fake authorization server received. */
    asRequests: [] as { endpoint: 'token:code' | 'token:refresh' | 'revoke'; status: number; token?: string }[],
    refreshStatus: 200,
    revokeStatus: 200,
    revokeHangs: false,
    /** Requests the fake PDS received. */
    pdsRequests: [] as { url: string; authorization: string }[],
    pdsStatus: 200,
    dohResolvers: [] as unknown[],
    dohCalls: [] as string[],
    dohAnswers: new Map<string, string>(),
    tokenCounter: 0,
  };

  function idb(): IDBFactory {
    if (world.idb === null) throw new Error('world.idb not set');
    return world.idb;
  }

  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = idb().open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        for (const name of STORES) {
          const store = request.result.createObjectStore(name, { autoIncrement: true });
          store.createIndex('expiresAt', 'expiresAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction([store], mode);
        const request = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  const put = (store: string, key: string, value: unknown) =>
    run(store, 'readwrite', (s) => s.put({ value }, key)).then(() => undefined);
  const get = async <T>(store: string, key: string): Promise<T | undefined> =>
    ((await run(store, 'readonly', (s) => s.get(key))) as { value: T } | undefined)?.value;
  const del = (store: string, key: string) => run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);

  function storage() {
    if (world.storage === null) throw new Error('world.storage not set');
    return world.storage;
  }

  class TokenRefreshError extends Error {
    constructor(
      readonly sub: string,
      message: string,
    ) {
      super(message);
      this.name = 'TokenRefreshError';
    }
  }
  class TokenInvalidError extends Error {
    constructor(readonly sub: string) {
      super(`The session for "${sub}" is invalid`);
      this.name = 'TokenInvalidError';
    }
  }
  class TokenRevokedError extends Error {
    constructor(readonly sub: string) {
      super(`The session for "${sub}" was successfully revoked`);
      this.name = 'TokenRevokedError';
    }
  }
  class OAuthCallbackError extends Error {
    constructor(
      readonly params: URLSearchParams,
      message?: string,
      readonly state?: string,
    ) {
      super(message ?? params.get('error_description') ?? 'OAuth callback error');
      this.name = 'OAuthCallbackError';
    }
  }
  class OAuthResolverError extends Error {
    override name = 'OAuthResolverError';
  }

  class AtprotoDohHandleResolver {
    constructor(readonly options: unknown) {
      world.dohResolvers.push(options);
    }
    async resolve(handle: string): Promise<string | null> {
      world.dohCalls.push(handle);
      return world.dohAnswers.get(handle) ?? null;
    }
  }

  type Hook = (sub: string, cause: unknown) => unknown;

  class FakeOAuthSession {
    constructor(
      readonly did: string,
      private readonly hooks: { onSessionDeleted?: Hook },
    ) {}

    get sub(): string {
      return this.did;
    }

    async #deleteStored(cause: unknown): Promise<void> {
      await del('session', this.did);
      if (storage().getItem(SUB_KEY) === this.did) storage().removeItem(SUB_KEY);
      await this.hooks.onSessionDeleted?.(this.did, cause);
    }

    async getTokenSet(refresh: boolean | 'auto'): Promise<StoredSession['tokenSet']> {
      const stored = await get<StoredSession>('session', this.did);
      if (stored === undefined) {
        const cause = new TokenRefreshError(this.did, 'The session was deleted by another process');
        await this.hooks.onSessionDeleted?.(this.did, cause);
        throw cause;
      }
      const due = refresh === true || (refresh === 'auto' && stored.tokenSet.expires_at <= world.nowMs());
      if (!due) return stored.tokenSet;
      world.asRequests.push({ endpoint: 'token:refresh', status: world.refreshStatus });
      if (world.refreshStatus !== 200) {
        const cause = new TokenRefreshError(this.did, 'The refresh token was rejected (invalid_grant)');
        await this.#deleteStored(cause);
        throw cause;
      }
      world.tokenCounter += 1;
      const tokenSet = {
        ...stored.tokenSet,
        access_token: `at-${world.tokenCounter}`,
        refresh_token: `rt-${world.tokenCounter}`,
        expires_at: world.nowMs() + TOKEN_LIFETIME_MS,
      };
      await put('session', this.did, { tokenSet });
      return tokenSet;
    }

    async getTokenInfo(refresh: boolean | 'auto' = 'auto') {
      const t = await this.getTokenSet(refresh);
      return { expiresAt: new Date(t.expires_at), scope: t.scope, iss: t.iss, aud: t.aud, sub: t.sub };
    }

    async fetchHandler(pathname: string, _init?: RequestInit): Promise<Response> {
      const send = (t: StoredSession['tokenSet']) => {
        world.pdsRequests.push({ url: new URL(pathname, t.aud).href, authorization: `DPoP ${t.access_token}` });
        return world.pdsStatus === 401
          ? new Response('{"error":"InvalidToken"}', {
              status: 401,
              headers: { 'WWW-Authenticate': 'DPoP error="invalid_token"' },
            })
          : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const first = send(await this.getTokenSet('auto'));
      if (first.status !== 401) return first;
      // Like the library: force a refresh, retry once, and drop the session
      // when the PDS still rejects the fresh token.
      const second = send(await this.getTokenSet(true));
      if (second.status === 401) await this.#deleteStored(new TokenInvalidError(this.did));
      return second;
    }

    async signOut(): Promise<void> {
      const t = await this.getTokenSet(false);
      world.asRequests.push({ endpoint: 'revoke', status: world.revokeStatus, token: t.access_token });
      if (world.revokeHangs) return new Promise<void>(() => {});
      // The real library swallows revocation errors and deletes the stored
      // session in `finally`. This fake fails harder (rejects and keeps the
      // record), so the tests prove the SPA's own clearing, not the library's.
      if (world.revokeStatus >= 500) throw new Error(`revocation endpoint answered ${world.revokeStatus}`);
      await this.#deleteStored(new TokenRevokedError(this.did));
    }
  }

  class BrowserOAuthClient {
    static async load(options: Record<string, unknown>): Promise<BrowserOAuthClient> {
      world.loads.push(options);
      return new BrowserOAuthClient(options);
    }

    readonly #ready: Promise<void>;

    constructor(readonly options: Record<string, unknown>) {
      this.#ready = openDb().then((db) => db.close());
    }

    get #hooks(): { onSessionDeleted?: Hook } {
      const hook = this.options.onSessionDeleted as Hook | undefined;
      return hook ? { onSessionDeleted: hook } : {};
    }

    async signIn(input: string, options?: { scope?: string }): Promise<void> {
      await this.#ready;
      const resolver = this.options.handleResolver as { resolve(h: string): Promise<string | null> };
      const did = input.startsWith('did:') ? input : await resolver.resolve(input);
      if (!did) throw new OAuthResolverError(`Failed to resolve identity: ${input}`);
      await put('handleCache', input, did);
      await put('didCache', did, { id: did, service: [{ serviceEndpoint: PDS_ORIGIN }] });
      await put('authorizationServerMetadataCache', AS_ISSUER, { issuer: AS_ISSUER });
      await put('protectedResourceMetadataCache', PDS_ORIGIN, { authorization_servers: [AS_ISSUER] });
      await put('dpopNonceCache', AS_ISSUER, 'nonce-1');
      const state = `state-${world.authorizations.length + 1}`;
      await put('state', state, { did, scope: options?.scope });
      world.authorizations.push({ input, did, scope: options?.scope, clientId: this.options.clientId, state });
      // The real library now assigns window.location.href (the PAR redirect).
    }

    async init(): Promise<{ session: FakeOAuthSession; state?: string | null } | undefined> {
      await this.#ready;
      const params = world.callbackParams;
      if (params !== null) {
        world.callbackParams = null; // the library replaces the history entry first
        if (params.has('error')) throw new OAuthCallbackError(params);
        const state = params.get('state') ?? '';
        const pending = await get<{ did: string; scope: string }>('state', state);
        if (pending === undefined) throw new OAuthCallbackError(params, `Unknown authorization session "${state}"`);
        await del('state', state);
        world.asRequests.push({ endpoint: 'token:code', status: 200 });
        world.tokenCounter += 1;
        await put('session', pending.did, {
          tokenSet: {
            sub: pending.did,
            iss: AS_ISSUER,
            aud: PDS_ORIGIN,
            scope: pending.scope,
            access_token: `at-${world.tokenCounter}`,
            refresh_token: `rt-${world.tokenCounter}`,
            expires_at: world.nowMs() + TOKEN_LIFETIME_MS,
          },
        });
        storage().setItem(SUB_KEY, pending.did);
        return { session: new FakeOAuthSession(pending.did, this.#hooks), state: null };
      }
      const sub = storage().getItem(SUB_KEY);
      if (!sub) return undefined;
      const session = new FakeOAuthSession(sub, this.#hooks);
      try {
        await session.getTokenSet('auto');
      } catch (error) {
        storage().removeItem(SUB_KEY);
        throw error;
      }
      return { session };
    }
  }

  const reset = () => {
    world.callbackParams = null;
    world.loads = [];
    world.authorizations = [];
    world.asRequests = [];
    world.refreshStatus = 200;
    world.revokeStatus = 200;
    world.revokeHangs = false;
    world.pdsRequests = [];
    world.pdsStatus = 200;
    world.dohResolvers = [];
    world.dohCalls = [];
    world.dohAnswers = new Map();
    world.tokenCounter = 0;
  };

  return {
    world,
    reset,
    put,
    STORES,
    PDS_ORIGIN,
    TOKEN_LIFETIME_MS,
    module: {
      BrowserOAuthClient,
      AtprotoDohHandleResolver,
      OAuthCallbackError,
      OAuthResolverError,
      TokenInvalidError,
      TokenRefreshError,
      TokenRevokedError,
    },
  };
});

vi.mock('@atproto/oauth-client-browser', () => lib.module);

// ---------------------------------------------------------------------------
// Fixtures: origin, AppView, storage, IndexedDB inspection
// ---------------------------------------------------------------------------

const ORIGIN = 'https://music.example.org';
const PREFIX = 'com.example.atmusic';
const SCOPE = `atproto repo:${PREFIX}.scrobble repo:${PREFIX}.follow repo:${PREFIX}.settings`;
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const REQUEST_ID = 'a858325e-7dd0-4b1b-baaa-3b65af37f963';
const NOW_MS = Date.parse('2026-01-15T12:00:00Z');

const META = {
  name: 'atproto_music',
  version: '0.1.0',
  stage: 'backend',
  capabilities: ['read', 'stats', 'follows', 'notify', 'indexing', 'publication'],
  lexiconPrefix: PREFIX,
  indexing: { state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: null },
};

interface AppViewRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function envelope(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message, requestId: REQUEST_ID } });
}

function fakeAppView() {
  const requests: AppViewRequest[] = [];
  const config = { resolveStatus: 200, handles: new Map([['alice.test', ALICE]]) };
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const method = init.method ?? 'GET';
    requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    switch (`${method} ${url.pathname}`) {
      case 'GET /api/v1/meta':
        return json(200, META);
      case 'GET /api/v1/resolve': {
        if (config.resolveStatus === 503) return envelope(503, 'not_ready', 'Index storage is not initialized.');
        const handle = url.searchParams.get('handle') ?? '';
        const did = config.handles.get(handle);
        if (config.resolveStatus === 404 || did === undefined) {
          return envelope(404, 'not_found', 'The resource is absent or inactive.');
        }
        return json(200, { did, handle, verified: true });
      }
      case 'POST /api/v1/notify':
        return json(202, { state: 'queued' });
      default:
        return envelope(404, 'not_found', 'The resource is absent or inactive.');
    }
  };
  const count = (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path).length;
  return { api: new ApiClient({ baseUrl: ORIGIN, fetch }), requests, config, count };
}

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

function openDb(idb: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = idb.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Record count per object store of a database. */
async function storeCounts(idb: IDBFactory, name: string): Promise<Record<string, number>> {
  const db = await openDb(idb, name);
  try {
    const counts: Record<string, number> = {};
    for (const store of Array.from(db.objectStoreNames)) {
      counts[store] = await new Promise<number>((resolve, reject) => {
        const request = db.transaction([store], 'readonly').objectStore(store).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return counts;
  } finally {
    db.close();
  }
}

/** A second database standing in for the outbox (web/src/outbox, W2-07) with one queued operation. */
async function seedOutbox(idb: IDBFactory): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open('atmusic-outbox', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('operations', { keyPath: 'id' });
      request.result.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['operations', 'meta'], 'readwrite');
    tx.objectStore('operations').put({ id: 'op-1', did: ALICE, kind: 'scrobble.create', state: 'queued' });
    tx.objectStore('meta').put(1, 'version');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Sets the page URL (happy-dom's test API). */
function setUrl(url: string): void {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

const allLibraryStores = (n: number) => Object.fromEntries(lib.STORES.map((s) => [s, n]));

let idb: IDBFactory;
let storage: MemoryStorage;
let clock: ReturnType<typeof fixedClock>;
let appView: ReturnType<typeof fakeAppView>;

function newController(origin = ORIGIN) {
  return createSession({ api: appView.api, origin, clock, storage, indexedDB: idb });
}

/** signIn on one page, then the callback on a fresh page load; returns the callback page's controller. */
async function signInThroughCallback() {
  await newController().signIn('alice.test');
  const auth = lib.world.authorizations.at(-1);
  if (!auth) throw new Error('no authorization recorded');
  lib.world.callbackParams = new URLSearchParams({ code: 'code-secret-1', state: auth.state, iss: 'x' });
  const controller = newController();
  const result = await controller.init();
  return { controller, result };
}

beforeEach(() => {
  lib.reset();
  idb = new IDBFactory();
  storage = new MemoryStorage();
  clock = fixedClock();
  appView = fakeAppView();
  lib.world.idb = idb;
  lib.world.storage = storage;
  lib.world.nowMs = () => clock.nowMs();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Named tests
// ---------------------------------------------------------------------------

describe('web/test/oauth/session.test.ts', () => {
  it("signIn requests scope 'atproto repo:<p>.scrobble repo:<p>.follow repo:<p>.settings'", async () => {
    const controller = newController();
    await controller.signIn('@Alice.Test');

    // The client: the deployed metadata URL as client_id, query response mode.
    expect(lib.world.loads).toHaveLength(1);
    expect(lib.world.loads[0]).toMatchObject({
      clientId: 'https://music.example.org/oauth/client-metadata.json',
      responseMode: 'query',
    });
    expect(lib.world.loads[0]).not.toHaveProperty('allowHttp');

    // The authorization request: exactly the granular scope for the prefix
    // advertised by meta, for the DID our /api/v1/resolve returned.
    expect(lib.world.authorizations).toEqual([
      {
        input: 'alice.test',
        did: ALICE,
        scope: SCOPE,
        clientId: 'https://music.example.org/oauth/client-metadata.json',
        state: 'state-1',
      },
    ]);
    expect(SCOPE).toBe(
      'atproto repo:com.example.atmusic.scrobble repo:com.example.atmusic.follow repo:com.example.atmusic.settings',
    );
    expect(appView.requests).toEqual([
      { method: 'GET', path: '/api/v1/meta', query: {}, body: undefined },
      { method: 'GET', path: '/api/v1/resolve', query: { handle: 'alice.test' }, body: undefined },
    ]);
    expect(lib.world.dohCalls).toEqual([]);
    expect((await storeCounts(idb, LIBRARY_DATABASE)).state).toBe(1);
    // Nothing is signed in until the callback completes, and nothing was notified.
    expect(controller.current()).toBeNull();
    expect(controller.status()).toEqual({ state: 'anonymous' });
    expect(appView.count('POST', '/api/v1/notify')).toBe(0);

    // An invalid handle is refused before any request or authorization.
    await expect(controller.signIn('not a handle')).rejects.toMatchObject({
      name: 'SignInError',
      code: 'invalid_handle',
    });
    expect(appView.requests).toHaveLength(2);
    expect(lib.world.authorizations).toHaveLength(1);

    // Development: the loopback client id embeds the same scope and the
    // current origin's /oauth/callback (same encoding as scripts/gen-config.ts).
    const dev = newController('http://127.0.0.1:5173');
    await dev.signIn('alice.test');
    const loopbackId =
      'http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A5173%2Foauth%2Fcallback' +
      '&scope=atproto+repo%3Acom.example.atmusic.scrobble+repo%3Acom.example.atmusic.follow+repo%3Acom.example.atmusic.settings';
    expect(lib.world.loads[1]).toMatchObject({ clientId: loopbackId, responseMode: 'query' });
    expect(new URL(loopbackId).searchParams.get('scope')).toBe(SCOPE);
    expect(lib.world.authorizations[1]).toMatchObject({ did: ALICE, scope: SCOPE, clientId: loopbackId });
  });

  it('successful callback stores session and posts notify {did}', async () => {
    const { controller, result } = await signInThroughCallback();

    expect(result).toEqual({ kind: 'signed-in', did: ALICE, notified: true });
    // Exactly one notify, with exactly {did}.
    const notifies = appView.requests.filter((r) => r.path === '/api/v1/notify');
    expect(notifies).toEqual([{ method: 'POST', path: '/api/v1/notify', query: {}, body: { did: ALICE } }]);
    expect(lib.world.asRequests).toEqual([{ endpoint: 'token:code', status: 200 }]);

    // Stored: the library's session record and DID pointer, the consumed
    // state removed, and the authorization time for the expiry.
    const counts = await storeCounts(idb, LIBRARY_DATABASE);
    expect(counts.session).toBe(1);
    expect(counts.state).toBe(0);
    expect(storage.getItem(LIBRARY_SUB_KEY)).toBe(ALICE);
    expect(storage.getItem(`${SIGNED_IN_AT_KEY_PREFIX}${ALICE}`)).toBe(String(NOW_MS));

    // The adapted session.
    expect(controller.status()).toEqual({ state: 'signed-in', did: ALICE });
    const pds = controller.current();
    expect(pds?.did).toBe(ALICE);
    expect(await controller.expiry()).toEqual({
      tokenExpiresAtMs: NOW_MS + lib.TOKEN_LIFETIME_MS,
      sessionEndsAtMs: NOW_MS + PUBLIC_CLIENT_MAX_SESSION_MS,
    });
    const response = await pds?.fetchHandler('/xrpc/com.atproto.repo.createRecord', { method: 'POST' });
    expect(response?.status).toBe(200);
    expect(lib.world.pdsRequests).toEqual([
      { url: `${lib.PDS_ORIGIN}/xrpc/com.atproto.repo.createRecord`, authorization: 'DPoP at-1' },
    ]);
    // A full URL would send the token elsewhere: refused before the library is called.
    await expect(pds?.fetchHandler('https://evil.example.net/xrpc/x')).rejects.toBeInstanceOf(TypeError);
    await expect(pds?.fetchHandler('//evil.example.net/xrpc/x')).rejects.toBeInstanceOf(TypeError);
    expect(lib.world.pdsRequests).toHaveLength(1);

    // init() is memoized: a second call (the callback route) shares the run.
    expect(await controller.init()).toBe(result);
    expect(lib.world.asRequests).toHaveLength(1);

    // A reload restores the stored session without another notify or exchange.
    const reloaded = newController();
    expect(await reloaded.init()).toEqual({ kind: 'restored', did: ALICE });
    expect(reloaded.current()?.did).toBe(ALICE);
    expect(appView.count('POST', '/api/v1/notify')).toBe(1);
    expect(lib.world.asRequests).toHaveLength(1);
  });

  it('signOut calls revoke and clears IndexedDB stores', async () => {
    const { controller } = await signInThroughCallback();
    await seedOutbox(idb);
    const held = controller.current();
    const statuses: SessionStatus[] = [];
    controller.subscribe((s) => statuses.push(s));
    // Every library store holds something before sign-out.
    await lib.put('state', 'state-unused', { did: ALICE });
    expect(Object.values(await storeCounts(idb, LIBRARY_DATABASE)).every((n) => n >= 1)).toBe(true);
    expect(await storeCounts(idb, 'atmusic-outbox')).toEqual({ meta: 1, operations: 1 });

    const result = await controller.signOut();

    expect(result.revocation).toBe('completed');
    expect(lib.world.asRequests.filter((r) => r.endpoint === 'revoke')).toEqual([
      { endpoint: 'revoke', status: 200, token: 'at-1' },
    ]);
    expect(await storeCounts(idb, LIBRARY_DATABASE)).toEqual(allLibraryStores(0));
    expect(await storeCounts(idb, 'atmusic-outbox')).toEqual({ meta: 0, operations: 0 });
    expect([...result.clearedStores].sort()).toEqual(
      [...lib.STORES.map((s) => `${LIBRARY_DATABASE}/${s}`), 'atmusic-outbox/meta', 'atmusic-outbox/operations'].sort(),
    );
    expect(storage.getItem(LIBRARY_SUB_KEY)).toBeNull();
    expect(storage.getItem(`${SIGNED_IN_AT_KEY_PREFIX}${ALICE}`)).toBeNull();
    expect(controller.current()).toBeNull();
    expect(controller.status()).toEqual({ state: 'anonymous' });
    expect(statuses).toEqual([{ state: 'anonymous' }]);
    expect(await controller.expiry()).toBeNull();

    // A session handed out before sign-out refuses to send.
    await expect(held?.fetchHandler('/xrpc/com.atproto.repo.createRecord')).rejects.toMatchObject({
      name: 'ReauthRequiredError',
      reason: 'signed_out',
    });
    expect(lib.world.pdsRequests).toHaveLength(0);

    // A reload is anonymous; the stores keep their schema for the library.
    const reloaded = newController();
    expect(await reloaded.init()).toEqual({ kind: 'anonymous' });
    expect(reloaded.current()).toBeNull();
    expect(Object.keys(await storeCounts(idb, LIBRARY_DATABASE)).sort()).toEqual([...lib.STORES].sort());
  });

  it('expired/refresh-failed session surfaces re-auth state', async () => {
    await signInThroughCallback();

    // 1. Restore of a stored session whose token expired and whose refresh is rejected.
    clock.advance(lib.TOKEN_LIFETIME_MS + 1);
    lib.world.refreshStatus = 400;
    const restoring = newController();
    const restoreStatuses: SessionStatus[] = [];
    restoring.subscribe((s) => restoreStatuses.push(s));
    expect(await restoring.init()).toEqual({ kind: 'reauth-required', did: ALICE, reason: 'refresh_failed' });
    expect(restoring.status()).toEqual({ state: 'reauth-required', did: ALICE, reason: 'refresh_failed' });
    expect(restoreStatuses).toEqual([{ state: 'reauth-required', did: ALICE, reason: 'refresh_failed' }]);
    expect(restoring.current()).toBeNull();
    expect(await restoring.expiry()).toBeNull();
    expect(lib.world.asRequests.filter((r) => r.endpoint === 'token:refresh')).toEqual([
      { endpoint: 'token:refresh', status: 400 },
    ]);
    expect((await storeCounts(idb, LIBRARY_DATABASE)).session).toBe(0);
    expect(storage.getItem(LIBRARY_SUB_KEY)).toBeNull();
    expect(storage.getItem(`${SIGNED_IN_AT_KEY_PREFIX}${ALICE}`)).toBeNull();
    expect(appView.count('POST', '/api/v1/notify')).toBe(1); // only the original sign-in

    // The callback route shows the re-auth prompt and records it in the app state.
    const state = createAppState({ api: appView.api });
    const host = document.createElement('div');
    render(
      h(AppStateContext.Provider, { value: state }, h(LocationProvider, null, h(Callback, { controller: restoring }))),
      host,
    );
    await vi.waitFor(() => expect(host.textContent).toContain('Your session has ended'));
    expect(state.reauthRequired.value).toBe(true);
    expect(state.session.value).toBeNull();
    render(null, host);

    // 2. A live session whose refresh fails when the outbox next writes.
    lib.world.refreshStatus = 200;
    clock.advance(1000);
    const { controller } = await signInThroughCallback();
    const pds = controller.current();
    expect(pds).not.toBeNull();
    const statuses: SessionStatus[] = [];
    controller.subscribe((s) => statuses.push(s));
    clock.advance(lib.TOKEN_LIFETIME_MS + 1);
    lib.world.refreshStatus = 400;
    const pdsBefore = lib.world.pdsRequests.length;
    const failure = await pds?.fetchHandler('/xrpc/com.atproto.repo.createRecord', { method: 'POST' }).catch((e) => e);
    expect(failure).toBeInstanceOf(ReauthRequiredError);
    expect(failure).toMatchObject({ did: ALICE, reason: 'refresh_failed' });
    expect(lib.world.pdsRequests).toHaveLength(pdsBefore); // nothing sent without a valid token
    expect(controller.status()).toEqual({ state: 'reauth-required', did: ALICE, reason: 'refresh_failed' });
    expect(statuses).toEqual([{ state: 'reauth-required', did: ALICE, reason: 'refresh_failed' }]);
    expect(controller.current()).toBeNull();
    // The held session keeps refusing, without another refresh attempt.
    const refreshes = lib.world.asRequests.length;
    await expect(pds?.fetchHandler('/xrpc/com.atproto.repo.deleteRecord')).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(lib.world.asRequests).toHaveLength(refreshes);
    expect(lib.world.pdsRequests).toHaveLength(pdsBefore);

    // 3. The PDS rejects even a refreshed token: the library drops the
    // session (TokenInvalidError through onSessionDeleted).
    lib.world.refreshStatus = 200;
    const third = (await signInThroughCallback()).controller;
    lib.world.pdsStatus = 401;
    const response = await third.current()?.fetchHandler('/xrpc/com.atproto.repo.createRecord');
    expect(response?.status).toBe(401);
    expect(third.status()).toEqual({ state: 'reauth-required', did: ALICE, reason: 'token_invalid' });
    expect(third.current()).toBeNull();
    expect((await storeCounts(idb, LIBRARY_DATABASE)).session).toBe(0);
  });

  it('signOut clears IndexedDB stores when revoke fails with 500', async () => {
    const { controller } = await signInThroughCallback();
    await seedOutbox(idb);
    lib.world.revokeStatus = 500;

    const result = await controller.signOut();

    expect(result.revocation).toBe('failed');
    expect(lib.world.asRequests.filter((r) => r.endpoint === 'revoke')).toEqual([
      { endpoint: 'revoke', status: 500, token: 'at-1' },
    ]);
    // The fake library kept its session record after the failed revocation;
    // the SPA's clearing removed it and everything else.
    expect(await storeCounts(idb, LIBRARY_DATABASE)).toEqual(allLibraryStores(0));
    expect(await storeCounts(idb, 'atmusic-outbox')).toEqual({ meta: 0, operations: 0 });
    expect(storage.getItem(LIBRARY_SUB_KEY)).toBeNull();
    expect(controller.current()).toBeNull();
    expect(controller.status()).toEqual({ state: 'anonymous' });

    // A reload is anonymous (not "session ended") and talks to no server.
    const asBefore = lib.world.asRequests.length;
    const reloaded = newController();
    expect(await reloaded.init()).toEqual({ kind: 'anonymous' });
    expect(reloaded.status()).toEqual({ state: 'anonymous' });
    expect(lib.world.asRequests).toHaveLength(asBefore);
  });
});

// ---------------------------------------------------------------------------
// Supporting behaviour
// ---------------------------------------------------------------------------

describe('session support', () => {
  it('handle resolution falls back to the library DoH resolver only when /api/v1/resolve cannot answer', async () => {
    appView.config.resolveStatus = 503;
    lib.world.dohAnswers.set('alice.test', ALICE);
    await newController().signIn('alice.test');
    expect(appView.count('GET', '/api/v1/resolve')).toBe(1);
    expect(lib.world.dohCalls).toEqual(['alice.test']);
    expect(lib.world.dohResolvers).toEqual([{ dohEndpoint: 'https://cloudflare-dns.com/dns-query' }]);
    expect(lib.world.authorizations).toMatchObject([{ did: ALICE, scope: SCOPE }]);

    // 404 is a definitive "unresolved": no fallback, a specific error, no authorization.
    appView.config.resolveStatus = 404;
    const error = await newController()
      .signIn('bob.test')
      .catch((e) => e);
    expect(error).toBeInstanceOf(SignInError);
    expect(error).toMatchObject({ code: 'unknown_handle' });
    expect(lib.world.dohCalls).toEqual(['alice.test']);
    expect(lib.world.authorizations).toHaveLength(1);
  });

  it('a revocation that never answers is abandoned after the timeout and the stores are still cleared', async () => {
    const { controller } = await signInThroughCallback();
    lib.world.revokeHangs = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = controller.signOut();
    // Signed out locally before the revocation answers.
    expect(controller.current()).toBeNull();
    expect(controller.status()).toEqual({ state: 'anonymous' });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.revocation).toBe('failed');
    expect(await storeCounts(idb, LIBRARY_DATABASE)).toEqual(allLibraryStores(0));
  });

  it('the callback route records the session and replaces the entry with /feed; failures show fixed text only', async () => {
    setUrl(`${ORIGIN}/oauth/callback`);
    await newController().signIn('alice.test');
    lib.world.callbackParams = new URLSearchParams({ code: 'code-secret-1', state: 'state-1', iss: 'x' });
    const controller = newController();
    const state = createAppState({ api: appView.api });
    const host = document.createElement('div');
    render(h(AppStateContext.Provider, { value: state }, h(LocationProvider, null, h(Callback, { controller }))), host);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Completing sign-in…');
    await vi.waitFor(() => expect(location.pathname).toBe('/feed'));
    expect(state.session.value?.did).toBe(ALICE);
    expect(appView.count('POST', '/api/v1/notify')).toBe(1);
    render(null, host);

    // A cancelled authorization.
    setUrl(`${ORIGIN}/oauth/callback`);
    lib.world.callbackParams = new URLSearchParams({ error: 'access_denied', state: 'state-9', iss: 'x' });
    const denied = createAppState({ api: appView.api });
    render(
      h(
        AppStateContext.Provider,
        { value: denied },
        h(LocationProvider, null, h(Callback, { controller: newController() })),
      ),
      host,
    );
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('Sign-in was cancelled'),
    );
    expect(host.querySelector('a[href="/signin"]')).not.toBeNull();
    expect(denied.session.value).toBeNull();
    render(null, host);

    // An expired (unknown) authorization state; the code never reaches the DOM.
    lib.world.callbackParams = new URLSearchParams({ code: 'code-secret-2', state: 'state-gone', iss: 'x' });
    render(
      h(
        AppStateContext.Provider,
        { value: denied },
        h(LocationProvider, null, h(Callback, { controller: newController() })),
      ),
      host,
    );
    await vi.waitFor(() => expect(host.textContent).toContain('This sign-in link has expired'));
    expect(host.innerHTML).not.toContain('code-secret');
    expect(host.innerHTML).not.toContain('state-gone');
    render(null, host);
    expect(appView.count('POST', '/api/v1/notify')).toBe(1);
  });
});
