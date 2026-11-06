// The OAuth library's IdentityResolver over our identity module (ADR 0005
// §5.2, §13; N2-03).
//
// Why: given only a `handleResolver`, @atproto/oauth-client builds its own
// DidResolver against https://plc.directory/ (the @atproto-labs/did-resolver
// DidPlcMethod default) and runs it with `noCache: true` in `verifyIssuer` on
// every token response and every refresh (oauth-server-agent.js:57,88,117-119).
// That would bypass our identity rules on the OAuth path: the document checks
// of packages/atproto/src/identity (did:plc / hostname did:web only, the
// `#atproto` key, the `#atproto_pds` URL policy), the bidirectional handle
// check and SafeFetch. So the client is constructed with `identityResolver`
// = this adapter, and every resolution — authorize, the issuer check after the
// code exchange, the issuer check before every refresh — goes through
// `identity.resolveDid` / `identity.resolveHandle`.
//
// Mapping:
// - `resolve(input, {noCache})` → `identity.resolveDid(did, {fresh: noCache})`;
//   a handle input is first resolved with `identity.resolveHandle` and must be
//   the verified handle of the resulting document (bidirectional, as the
//   library's AtprotoIdentityResolver.getDocumentFromHandle requires).
// - The library needs a DID document only for its `#atproto_pds` service
//   (`extractPdsUrl`). The adapter hands it a document built from what our
//   resolver accepted — the policy-checked PDS origin, the `#atproto` key and
//   the verified handle — never the raw upstream document, so nothing our
//   rules rejected can reach the library.
// - `handle` is our verified handle, or `handle.invalid` when there is none.
//
// Errors from our module propagate unchanged (IdentityError for a definite
// failure, SafeFetchError / TransportError for a transient one) as the
// `cause` of the library's OAuthResolverError, so callers can still tell them
// apart.

import { IdentityError } from '@atmusic/atproto/identity/resolver';
import type { IdentityResolver, ResolvedIdentity } from '@atmusic/atproto/identity/types';
import type { NodeOAuthClientOptions } from '@atproto/oauth-client-node';

/** The library's IdentityResolver interface. */
export type LibraryIdentityResolver = NonNullable<NodeOAuthClientOptions['identityResolver']>;
type LibraryIdentityInfo = Awaited<ReturnType<LibraryIdentityResolver['resolve']>>;

/** The library's marker for "no verified handle" (@atproto-labs/identity-resolver HANDLE_INVALID). */
export const HANDLE_INVALID = 'handle.invalid';

/** The minimal atproto DID document of an identity our resolver accepted. */
export function documentOf(identity: ResolvedIdentity) {
  const multibase = identity.signingKey.startsWith('did:key:')
    ? identity.signingKey.slice('did:key:'.length)
    : identity.signingKey;
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: identity.did,
    alsoKnownAs: identity.handle === null ? [] : [`at://${identity.handle}`],
    verificationMethod: [
      { id: `${identity.did}#atproto`, type: 'Multikey', controller: identity.did, publicKeyMultibase: multibase },
    ],
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: identity.pds }],
  };
}

export function createOAuthIdentityResolver(identity: IdentityResolver): LibraryIdentityResolver {
  return {
    async resolve(input, o) {
      o?.signal?.throwIfAborted();
      const fresh = o?.noCache === true;
      let did: string;
      let handleInput: string | null = null;
      if (input.startsWith('did:')) {
        did = input;
      } else {
        handleInput = input.toLowerCase();
        did = await identity.resolveHandle(handleInput);
        o?.signal?.throwIfAborted();
      }
      const resolved = await identity.resolveDid(did, { fresh });
      if (resolved.did !== did) throw new IdentityError('did_mismatch', 'resolved identity names another DID');
      if (handleInput !== null && resolved.handle !== handleInput) {
        throw new IdentityError('invalid_handle', 'the DID document does not verify the handle it was reached from');
      }
      return {
        did,
        didDoc: documentOf(resolved),
        handle: resolved.handle ?? HANDLE_INVALID,
      } as unknown as LibraryIdentityInfo;
    },
  };
}
