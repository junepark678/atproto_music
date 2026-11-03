import type { Did, Handle } from '@atmusic/core/api-types';

export interface Session {
  did: Did;
  handle: Handle | null;
  username: string;
  csrfToken: string;
  status: 'active' | 'reauth_required';
  expiresAt: string;
}

export class SessionClient {
  #csrfToken: string | null = null;
  #current: Session | null = null;
  #reauthRequired = false;
  #onChange: (session: Session | null, reauthRequired: boolean) => void;
  #listeners = new Set<(session: Session | null, reauthRequired: boolean) => void>();
  #fetch: typeof fetch;
  #sessionReadGeneration = 0;
  #sessionRevision = 0;

  constructor(
    options: { fetch?: typeof fetch; onChange?: (session: Session | null, reauthRequired: boolean) => void } = {},
  ) {
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#onChange = options.onChange ?? (() => undefined);
  }

  current(): Session | null {
    return this.#current;
  }
  sessionRevision(): number {
    return this.#sessionRevision;
  }
  subscribe(listener: (session: Session | null, reauthRequired: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async getSession(): Promise<Session | null> {
    if (this.#current !== null) return this.#current;
    const generation = ++this.#sessionReadGeneration;
    let response: Response;
    try {
      response = await this.#fetch('/api/v1/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    } catch (error) {
      if (generation !== this.#sessionReadGeneration) return this.#current;
      throw error;
    }
    if (generation !== this.#sessionReadGeneration) return this.#current;
    if (response.status === 401) {
      this.#set(null, this.#reauthRequired);
      return null;
    }
    if (!response.ok) throw new Error(`Session request failed (${response.status})`);
    let value: Session;
    try {
      value = (await response.json()) as Session;
    } catch (error) {
      if (generation !== this.#sessionReadGeneration) return this.#current;
      throw error;
    }
    if (generation !== this.#sessionReadGeneration) return this.#current;
    if (
      !value ||
      typeof value.did !== 'string' ||
      (value.handle !== null && typeof value.handle !== 'string') ||
      typeof value.username !== 'string' ||
      typeof value.csrfToken !== 'string' ||
      (value.status !== 'active' && value.status !== 'reauth_required') ||
      typeof value.expiresAt !== 'string'
    )
      throw new Error('Invalid session response');
    this.#csrfToken = value.csrfToken;
    this.#set(value, value.status === 'reauth_required');
    return value;
  }

  /** Discard the cached DTO and read the cookie session again, e.g. after OAuth in another tab. */
  async refresh(): Promise<Session | null> {
    this.#sessionReadGeneration++;
    this.#sessionRevision++;
    this.#current = null;
    this.#csrfToken = null;
    return this.getSession();
  }

  unauthorized(expectedRevision?: number): boolean {
    if (expectedRevision !== undefined && expectedRevision !== this.#sessionRevision) return false;
    this.#sessionReadGeneration++;
    this.#set(null, true);
    return true;
  }

  async mutate(path: string, init: RequestInit = {}, expectedDid: Did): Promise<Response> {
    if (this.#current === null) await this.getSession();
    const session = this.#current;
    const csrfToken = this.#csrfToken;
    if (session === null || csrfToken === null) throw new Error('Sign in to continue');
    if (session.did !== expectedDid) throw new SessionIdentityChangedError();
    if (session.status !== 'active' && path !== '/api/v1/auth/logout') throw new SessionReauthenticationRequiredError();
    const requestRevision = this.#sessionRevision;
    const headers = new Headers(init.headers);
    headers.set('X-CSRF-Token', csrfToken);
    const response = await this.#fetch(path, { ...init, headers, credentials: 'same-origin' });
    if (response.status === 401) this.unauthorized(requestRevision);
    return response;
  }

  async start(handle: string): Promise<string> {
    const response = await this.#fetch('/api/v1/auth/start', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
    if (!response.ok) throw new Error(`Sign-in could not be started (${response.status})`);
    const result = (await response.json()) as { authorizeUrl: string };
    if (typeof result.authorizeUrl !== 'string') throw new Error('Invalid sign-in response');
    return result.authorizeUrl;
  }

  async logout(): Promise<void> {
    const current = this.#current ?? (await this.getSession());
    if (current === null) throw new Error('Sign in to continue');
    const response = await this.mutate(
      '/api/v1/auth/logout',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
      current.did,
    );
    if (!response.ok && response.status !== 401) throw new Error(`Sign out failed (${response.status})`);
    if (response.status !== 401) {
      const latest = this.#current;
      this.#sessionReadGeneration++;
      if (latest === null || latest.did === current.did) {
        // `refresh()` clears the internal cache while keeping the last
        // published identity in the UI. Do not publish another anonymous
        // transition until the reconciliation read confirms there is no
        // account; doing so could erase a newer account's draft.
        if (latest !== null) this.#set(null, false);
        // A refresh may have been reading the same account while the logout
        // completed. Discard that response, then reconcile the cookie once so
        // a genuinely newer account is restored instead of being erased.
        try {
          await this.getSession();
        } catch {
          // The server accepted sign-out; keep the local session cleared until
          // a later explicit refresh if reconciliation is temporarily offline.
        }
      }
    }
  }

  #set(session: Session | null, reauth: boolean): void {
    if (
      this.#current?.did !== session?.did ||
      this.#current?.csrfToken !== session?.csrfToken ||
      this.#current?.status !== session?.status ||
      this.#reauthRequired !== reauth
    )
      this.#sessionRevision++;
    this.#current = session;
    this.#csrfToken = session?.csrfToken ?? null;
    this.#reauthRequired = reauth;
    this.#onChange(session, reauth);
    for (const listener of this.#listeners) listener(session, reauth);
  }
}

/** A fixed, non-secret error used when a stale account view tries to write. */
export class SessionIdentityChangedError extends Error {
  constructor() {
    super('The signed-in account changed. Reload before continuing.');
    this.name = 'SessionIdentityChangedError';
  }
}

/** A fixed error used when an expired account attempts a mutation. */
export class SessionReauthenticationRequiredError extends Error {
  constructor() {
    super('Sign in again before making changes.');
    this.name = 'SessionReauthenticationRequiredError';
  }
}

let singleton: SessionClient | null = null;
export function sessionClient(): SessionClient {
  singleton ??= new SessionClient();
  return singleton;
}

/** Fetch API requests through the Node session boundary. */
export async function sessionFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  expectedDid?: Did,
): Promise<Response> {
  const client = sessionClient();
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    const requestRevision = client.sessionRevision();
    const response = await globalThis.fetch(input, { ...init, credentials: 'same-origin' });
    if (response.status === 401) client.unauthorized(requestRevision);
    return response;
  }
  if (expectedDid === undefined) throw new Error('Account identity is required for a mutation');
  return client.mutate(input instanceof Request ? input.url : String(input), { ...init, method }, expectedDid);
}
