// GET /oauth/client-metadata.json and GET /oauth/jwks.json (ADR 0005 §5.3,
// §5.4; contract v1.2 operations oauth_client_metadata and oauth_jwks; N3-01).
//
// - Both documents are built by worker/src/bff/client-metadata.ts (N2-03):
//   the metadata document from ATMUSIC_PUBLIC_ORIGIN and LEXICON_PREFIX, the
//   JWKS from the published set of the OAuth keyset (the signing keys' public
//   halves, then the announced keys; never `d`).
// - Each answers 200 `application/json` with `Cache-Control: public,
//   max-age=300`. The authorization server re-fetches both at sign-in and on
//   refresh and caches them for ten minutes, so they are public and cacheable.
// - Neither route reads a cookie, and neither response ever carries a
//   Set-Cookie: the handlers ignore the request headers entirely, and each
//   response is built fresh with only the documented headers.
// - HEAD is the dispatcher's (worker/src/node/dispatch.ts): it runs the GET
//   route and drops the body.
//
// The documents come from the `oauthDocs` service, which the auth feature
// (http/auth.ts `authFeature`) provides; production wiring is N4-01's.

import {
  type ClientMetadataDocument,
  clientMetadataResponse,
  jwksResponse,
  OAUTH_JWKS_PATH,
  OAUTH_METADATA_PATH,
} from '../bff/client-metadata';
import type { OAuthKeyset } from '../bff/keyset';
import { CtxWiringError, need, type RequestCtx, type RouteDef } from './types';

/** What the two document routes serve. */
export interface OAuthDocsService {
  /** The §5.3 document for this process's configuration. */
  readonly metadata: ClientMetadataDocument;
  /** The published key set (public JWKs only). */
  readonly keyset: Pick<OAuthKeyset, 'jwks'>;
}

declare module '../app/services' {
  interface AppServices {
    oauthDocs: OAuthDocsService;
  }
}

function docs(ctx: RequestCtx): OAuthDocsService {
  const service = need(ctx, 'app').oauthDocs as OAuthDocsService | undefined;
  // A composition without the auth feature: the same generic 500 as a missing ctx member.
  if (service === undefined) throw new CtxWiringError('app');
  return service;
}

export async function getClientMetadata(_req: Request, ctx: RequestCtx): Promise<Response> {
  return clientMetadataResponse(docs(ctx).metadata);
}

export async function getJwks(_req: Request, ctx: RequestCtx): Promise<Response> {
  return jwksResponse(docs(ctx).keyset);
}

export const routes: RouteDef[] = [
  { method: 'GET', pattern: OAUTH_METADATA_PATH, handler: getClientMetadata },
  { method: 'GET', pattern: OAUTH_JWKS_PATH, handler: getJwks },
];
