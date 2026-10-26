// The browser public OAuth client (ADR 0004 §5.1, A3; W2-06).
//
// `@atproto/oauth-client-browser` performs handle and DID resolution, PAR,
// PKCE S256, DPoP with server nonces (a non-extractable WebCrypto key), the
// issuer check and refresh, and keeps its state in IndexedDB. This module only
// configures it:
//
// - client_id: `https://<origin>/oauth/client-metadata.json` on a deployed
//   origin (the build-time static asset written by scripts/gen-config.ts, which
//   `BrowserOAuthClient.load` fetches), or the atproto loopback client id
//   `http://localhost?redirect_uri=…&scope=…` when the SPA runs on
//   http://127.0.0.1 or http://[::1] in development (§5.1 step 7).
// - handleResolver: our `GET /api/v1/resolve` (the AppView's verified,
//   bidirectional resolution), falling back to the library's DNS-over-HTTPS
//   resolver when our route is unavailable.
// - responseMode: `query`, so the callback arrives on /oauth/callback as query
//   parameters; the library strips them from the address bar before the
//   code exchange.
//
// Nothing here weakens the library's checks: no option disables issuer,
// PKCE, DPoP or identity verification, and `allowHttp` is never set.

import { isSupportedDid } from '@atmusic/core/syntax';
import {
  AtprotoDohHandleResolver,
  BrowserOAuthClient,
  type HandleResolver,
  type OAuthSession,
  type ResolvedHandle,
  type ResolveHandleOptions,
} from '@atproto/oauth-client-browser';
import { type ApiClient, ApiDecodeError, ApiError, ApiNetworkError } from '../api/client';

/** The client metadata document's path (the client_id of a deployed origin). */
export const METADATA_PATH = '/oauth/client-metadata.json';
/** The single redirect URI's path; an SPA route (web/src/routes/callback.tsx). */
export const CALLBACK_PATH = '/oauth/callback';
/** The IndexedDB database `@atproto/oauth-client-browser` keeps its stores in. */
export const LIBRARY_DATABASE = '@atproto-oauth-client';
/** The localStorage key under which the library remembers the signed-in DID. */
export const LIBRARY_SUB_KEY = '@@atproto/oauth-client-browser(sub)';
/**
 * DoH endpoint of the fallback handle resolver. The library ships no default
 * resolver; its DoH resolver against Cloudflare's public DoH (the provider
 * the Worker already uses, ADR §8) avoids sending handles to a third-party
 * PDS.
 */
export const FALLBACK_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

/** The granular scope of ADR §5.1 / Q5; `atproto` alone when no owned prefix is configured. */
export function scopeFor(prefix: string | null): string {
  if (prefix === null) return 'atproto';
  return `atproto repo:${prefix}.scrobble repo:${prefix}.follow repo:${prefix}.settings`;
}

/** `http://127.0.0.1[:port]` or `http://[::1][:port]` exactly (the atproto loopback redirect rule). */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === 'http:' && url.origin === origin && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

/** `https://host[:port]` exactly: no path, query, fragment or credentials. */
export function isHttpsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin;
  } catch {
    return false;
  }
}

/**
 * The loopback client id for local development. Same construction as
 * `buildLoopbackHint` in scripts/gen-config.ts (URLSearchParams encoding), so
 * the SPA and the generated hint name the same client.
 */
export function loopbackClientId(origin: string, prefix: string | null): string {
  const query = new URLSearchParams({ redirect_uri: `${origin}${CALLBACK_PATH}`, scope: scopeFor(prefix) });
  return `http://localhost?${query.toString()}`;
}

/** The client id for an origin: the metadata URL when deployed, the loopback id in development. */
export function clientIdFor(origin: string, prefix: string | null): string {
  if (isHttpsOrigin(origin)) return `${origin}${METADATA_PATH}`;
  if (isLoopbackOrigin(origin)) return loopbackClientId(origin, prefix);
  throw new TypeError(`OAuth needs an https origin or an http loopback IP origin, not ${origin}`);
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  const cause = error instanceof ApiNetworkError ? error.cause : error;
  return cause instanceof DOMException && cause.name === 'AbortError';
}

/**
 * Resolves a handle through `GET /api/v1/resolve`. 200 gives the verified DID;
 * 404 (unresolved) and 422 (handle and DID document disagree) are definitive
 * answers and give `null`, which the library reports as an unknown handle. Any
 * other outcome (network failure, 429, 5xx, a response that does not decode)
 * means our route could not answer, and the fallback resolver is asked. An
 * abort is rethrown and never falls back.
 */
export class AppViewHandleResolver implements HandleResolver {
  constructor(
    private readonly api: ApiClient,
    private readonly fallback: HandleResolver,
  ) {}

  async resolve(handle: string, options?: ResolveHandleOptions): Promise<ResolvedHandle> {
    const signal = options?.signal;
    try {
      const resolved = await this.api.resolve(handle, signal ? { signal } : undefined);
      return isSupportedDid(resolved.did) ? (resolved.did as ResolvedHandle) : null;
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      if (error instanceof ApiError && (error.status === 404 || error.status === 422)) return null;
      if (!(error instanceof ApiError || error instanceof ApiNetworkError || error instanceof ApiDecodeError)) {
        throw error;
      }
    }
    return this.fallback.resolve(handle, options);
  }
}

/** The library's DoH handle resolver, used when our route cannot answer. */
export function defaultFallbackResolver(fetch?: typeof globalThis.fetch): HandleResolver {
  return new AtprotoDohHandleResolver({ dohEndpoint: FALLBACK_DOH_ENDPOINT, ...(fetch ? { fetch } : {}) });
}

/** The parts of an `OAuthSession` the SPA uses. */
export type LibrarySession = Pick<OAuthSession, 'did' | 'fetchHandler' | 'signOut' | 'getTokenInfo'>;

/** What `BrowserOAuthClient.init()` resolves to. */
export type LibraryInitResult = { session: LibrarySession; state?: string | null } | undefined;

/** The parts of a `BrowserOAuthClient` the SPA uses. */
export interface LibraryClient {
  init(): Promise<LibraryInitResult>;
  signIn(input: string, options?: { scope?: string; signal?: AbortSignal }): Promise<unknown>;
}

export interface OAuthClientConfig {
  /** The SPA origin (`location.origin`). */
  origin: string;
  /** The owned lexicon prefix from `GET /api/v1/meta`; only the loopback client id embeds it. */
  prefix: string | null;
  /** The AppView client whose `/api/v1/resolve` resolves handles. */
  api: ApiClient;
  /** Overrides the fallback handle resolver (defaults to the library's DoH resolver). */
  fallbackResolver?: HandleResolver;
  /** Called by the library when a stored session is deleted (refresh failure, invalid token, revocation). */
  onSessionDeleted?: (sub: string, cause: unknown) => void;
  signal?: AbortSignal;
}

/** Creates the configured `BrowserOAuthClient`. */
export async function createOAuthClient(config: OAuthClientConfig): Promise<LibraryClient> {
  const clientId = clientIdFor(config.origin, config.prefix);
  const handleResolver = new AppViewHandleResolver(config.api, config.fallbackResolver ?? defaultFallbackResolver());
  const client = await BrowserOAuthClient.load({
    clientId,
    handleResolver,
    responseMode: 'query',
    ...(config.signal ? { signal: config.signal } : {}),
    ...(config.onSessionDeleted ? { onSessionDeleted: config.onSessionDeleted } : {}),
  });
  return client;
}
