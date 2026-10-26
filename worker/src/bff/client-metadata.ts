// The confidential client's metadata document and JWKS (ADR 0005 §5.3; N2-03).
//
// `GET /oauth/client-metadata.json` serves exactly this document (key order
// included), with `<origin>` = ATMUSIC_PUBLIC_ORIGIN and `<p>` = LEXICON_PREFIX:
//
//   {"client_id":"<origin>/oauth/client-metadata.json","client_name":"AT Protocol Music",
//    "client_uri":"<origin>","application_type":"web",
//    "redirect_uris":["<origin>/oauth/callback"],
//    "grant_types":["authorization_code","refresh_token"],"response_types":["code"],
//    "scope":"atproto repo:<p>.scrobble repo:<p>.follow repo:<p>.settings repo:<p>.love",
//    "token_endpoint_auth_method":"private_key_jwt","token_endpoint_auth_signing_alg":"ES256",
//    "jwks_uri":"<origin>/oauth/jwks.json","dpop_bound_access_tokens":true}
//
// `transition:generic` is appended to the scope only with
// ATMUSIC_OAUTH_TRANSITION_GENERIC=1 (ADR 0004 Q5). With the namespace gate
// closed (no prefix) the scope is `atproto` alone, as scripts/gen-config.ts's
// `scopeFor` does: no repo scope can be requested for a collection that has no
// name.
//
// `GET /oauth/jwks.json` serves the published set of keyset.ts: public JWKs
// only. Both documents answer with `Cache-Control: public, max-age=300` and
// never set a cookie; the routes themselves are N3-01's (http/oauth-docs.ts),
// which use the response builders below.

import { CLIENT_NAME } from '@atmusic/core/client-name';
import type { OAuthKeyset, PublishedJwk } from './keyset';

export const OAUTH_METADATA_PATH = '/oauth/client-metadata.json';
export const OAUTH_JWKS_PATH = '/oauth/jwks.json';
export const OAUTH_CALLBACK_PATH = '/oauth/callback';
/** ADR §5.3: both documents may be cached for five minutes. */
export const OAUTH_DOCUMENT_CACHE_CONTROL = 'public, max-age=300';
export const TRANSITION_GENERIC_SCOPE = 'transition:generic';

/** The collections the client asks write access to (B12): exactly these four. */
export const OAUTH_REPO_COLLECTIONS = ['scrobble', 'follow', 'settings', 'love'] as const;

export interface ClientMetadataDocument {
  client_id: string;
  client_name: string;
  client_uri: string;
  application_type: 'web';
  redirect_uris: [string];
  grant_types: ['authorization_code', 'refresh_token'];
  response_types: ['code'];
  scope: string;
  token_endpoint_auth_method: 'private_key_jwt';
  token_endpoint_auth_signing_alg: 'ES256';
  jwks_uri: string;
  dpop_bound_access_tokens: true;
}

export interface ClientMetadataInput {
  /** ATMUSIC_PUBLIC_ORIGIN, e.g. https://music.214510.xyz (no path, no trailing slash). */
  publicOrigin: string;
  /** LEXICON_PREFIX; null while the namespace gate is closed. */
  prefix: string | null;
  /** ATMUSIC_OAUTH_TRANSITION_GENERIC=1. */
  transitionGeneric: boolean;
}

/** The requested scope: `atproto` plus one `repo:` scope per collection, then `transition:generic` if enabled. */
export function oauthScope(prefix: string | null, transitionGeneric: boolean): string {
  const parts = ['atproto'];
  if (prefix !== null) for (const c of OAUTH_REPO_COLLECTIONS) parts.push(`repo:${prefix}.${c}`);
  if (transitionGeneric) parts.push(TRANSITION_GENERIC_SCOPE);
  return parts.join(' ');
}

function originOf(publicOrigin: string): string {
  let url: URL;
  try {
    url = new URL(publicOrigin);
  } catch {
    throw new TypeError('publicOrigin must be an absolute origin');
  }
  if (url.origin !== publicOrigin) throw new TypeError('publicOrigin must be a bare origin without a trailing slash');
  return url.origin;
}

/** The ADR §5.3 document, members in the documented order. */
export function buildClientMetadata(input: ClientMetadataInput): ClientMetadataDocument {
  const origin = originOf(input.publicOrigin);
  return {
    client_id: `${origin}${OAUTH_METADATA_PATH}`,
    client_name: CLIENT_NAME,
    client_uri: origin,
    application_type: 'web',
    redirect_uris: [`${origin}${OAUTH_CALLBACK_PATH}`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: oauthScope(input.prefix, input.transitionGeneric),
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256',
    jwks_uri: `${origin}${OAUTH_JWKS_PATH}`,
    dpop_bound_access_tokens: true,
  };
}

/** The document for a parsed Node configuration (worker/src/node/config.ts). */
export function clientMetadataFor(config: {
  publicOrigin: string;
  oauthTransitionGeneric: boolean;
  app: { prefix: string | null };
}): ClientMetadataDocument {
  return buildClientMetadata({
    publicOrigin: config.publicOrigin,
    prefix: config.app.prefix,
    transitionGeneric: config.oauthTransitionGeneric,
  });
}

/** The JWKS document: the published set, every key rebuilt with public members only. */
export function jwksDocument(keyset: Pick<OAuthKeyset, 'jwks'>): { keys: PublishedJwk[] } {
  return {
    keys: keyset.jwks.keys.map((k) => ({
      kty: 'EC',
      crv: 'P-256',
      x: k.x,
      y: k.y,
      kid: k.kid,
      alg: 'ES256',
      use: 'sig',
    })),
  };
}

function documentResponse(body: unknown, method: string): Response {
  const text = JSON.stringify(body);
  return new Response(method === 'HEAD' ? null : text, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': OAUTH_DOCUMENT_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
    },
  });
}

/** `GET /oauth/client-metadata.json`: 200, application/json, five-minute public caching, no cookie. */
export function clientMetadataResponse(doc: ClientMetadataDocument, method = 'GET'): Response {
  return documentResponse(doc, method);
}

/** `GET /oauth/jwks.json`: the public keys, with the same caching and no cookie. */
export function jwksResponse(keyset: Pick<OAuthKeyset, 'jwks'>, method = 'GET'): Response {
  return documentResponse(jwksDocument(keyset), method);
}
