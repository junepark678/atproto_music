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

  constructor(
    options: { fetch?: typeof fetch; onChange?: (session: Session | null, reauthRequired: boolean) => void } = {},
  ) {
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#onChange = options.onChange ?? (() => undefined);
  }

  current(): Session | null {
    return this.#current;
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
    this.#current = null;
    this.#csrfToken = null;
    return this.getSession();
  }

  unauthorized(): void {
    this.#sessionReadGeneration++;
    this.#set(null, true);
  }

  async mutate(path: string, init: RequestInit = {}, expectedDid?: Did): Promise<Response> {
    if (this.#current === null) await this.getSession();
    const session = this.#current;
    const csrfToken = this.#csrfToken;
    if (session === null || csrfToken === null) throw new Error('Sign in to continue');
    if (expectedDid !== undefined && session.did !== expectedDid) throw new SessionIdentityChangedError();
    const headers = new Headers(init.headers);
    headers.set('X-CSRF-Token', csrfToken);
    const response = await this.#fetch(path, { ...init, headers, credentials: 'same-origin' });
    if (response.status === 401) {
      this.#sessionReadGeneration++;
      this.#set(null, true);
    }
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
    const response = await this.mutate('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!response.ok && response.status !== 401) throw new Error(`Sign out failed (${response.status})`);
    this.#sessionReadGeneration++;
    this.#set(null, false);
  }

  #set(session: Session | null, reauth: boolean): void {
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

let singleton: SessionClient | null = null;
export function sessionClient(): SessionClient {
  singleton ??= new SessionClient();
  return singleton;
}

/** Fetch API requests through the Node session boundary. */
export async function sessionFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const client = sessionClient();
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    const response = await globalThis.fetch(input, { ...init, credentials: 'same-origin' });
    if (response.status === 401) client.unauthorized();
    return response;
  }
  return client.mutate(input instanceof Request ? input.url : String(input), { ...init, method });
}
