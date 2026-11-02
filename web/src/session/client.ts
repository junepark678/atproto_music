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
  #onChange: (session: Session | null, reauthRequired: boolean) => void;
  #listeners = new Set<(session: Session | null, reauthRequired: boolean) => void>();
  #fetch: typeof fetch;

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
    const response = await this.#fetch('/api/v1/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) {
      this.#set(null, false);
      return null;
    }
    if (!response.ok) throw new Error(`Session request failed (${response.status})`);
    const value = (await response.json()) as Session;
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

  unauthorized(): void {
    this.#set(null, true);
  }

  async mutate(path: string, init: RequestInit = {}): Promise<Response> {
    if (this.#csrfToken === null) await this.getSession();
    if (this.#csrfToken === null) throw new Error('Sign in to continue');
    const headers = new Headers(init.headers);
    headers.set('X-CSRF-Token', this.#csrfToken);
    const response = await this.#fetch(path, { ...init, headers, credentials: 'same-origin' });
    if (response.status === 401) {
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
    this.#set(null, false);
  }

  #set(session: Session | null, reauth: boolean): void {
    this.#current = session;
    this.#csrfToken = session?.csrfToken ?? null;
    this.#onChange(session, reauth);
    for (const listener of this.#listeners) listener(session, reauth);
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
