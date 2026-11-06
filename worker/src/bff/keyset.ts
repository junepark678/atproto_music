// The confidential client's signing keys (ADR 0005 §5.4; N2-03).
//
// `secrets.oauthSigningKeys` (worker/src/node/secrets.ts, N1-07) holds private
// ES256 JWKs with unique kids, already validated there (P-256, d consistent
// with x/y). They become the @atproto/oauth-client keyset: new sessions bind
// to the first key, and a session keeps the kid it was created with for its
// whole life (the library stores it in the session's `authMethod`, the
// reference AS enforces the binding). A session whose kid is no longer in the
// keyset fails with AuthMethodUnsatisfiableError, which is `reauth_required`.
//
// The **published set** (`/oauth/jwks.json`, client-metadata.ts) is the public
// half of every signing key followed by `secrets.oauthAnnouncedKeys` (public
// keys only), so a new key is announced before it signs anything (rotation
// runbook, ADR §5.4). Every published JWK carries exactly
// `kty, crv, x, y, kid, alg: "ES256", use: "sig"`; a private member can never
// reach it, because each entry is rebuilt field by field.
//
// The keys are never written to the database or to a backup.

import { JoseKey, Keyset } from '@atproto/oauth-client-node';
import type { PrivateEs256Jwk, PublicEs256Jwk, Secrets } from '../node/secrets';

/** A JWK as /oauth/jwks.json publishes it. */
export interface PublishedJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

export interface OAuthKeyset {
  /** The library keyset (private keys, signing order). */
  readonly keyset: Keyset;
  /** Kids of the signing keys, in order; `signingKids[0]` binds new sessions. */
  readonly signingKids: readonly string[];
  /** The kid new sessions bind to. */
  readonly currentKid: string;
  /** The published JWKS document: signing keys' public halves, then the announced keys. */
  readonly jwks: { keys: readonly PublishedJwk[] };
}

export class KeysetError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeysetError';
  }
}

function published(jwk: PrivateEs256Jwk | PublicEs256Jwk): PublishedJwk {
  // Field by field: `d` (or any other member) can never be copied.
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: jwk.kid, alg: 'ES256', use: 'sig' };
}

/**
 * Build the keyset from the secrets document. Throws KeysetError (never
 * quoting key material) when there is no signing key or a key cannot be
 * imported; readiness reports such a keyset as not valid.
 */
export async function loadOAuthKeyset(
  secrets: Pick<Secrets, 'oauthSigningKeys' | 'oauthAnnouncedKeys'>,
): Promise<OAuthKeyset> {
  const signing = secrets.oauthSigningKeys;
  if (signing.length === 0) throw new KeysetError('the OAuth keyset needs at least one signing key');
  const kids = new Set<string>();
  const keys: JoseKey[] = [];
  for (const [i, jwk] of signing.entries()) {
    if (kids.has(jwk.kid)) throw new KeysetError(`OAuth signing key ${i} repeats a kid`);
    kids.add(jwk.kid);
    try {
      keys.push(
        await JoseKey.fromJWK({
          kty: 'EC',
          crv: 'P-256',
          kid: jwk.kid,
          alg: 'ES256',
          d: jwk.d,
          x: jwk.x,
          y: jwk.y,
        }),
      );
    } catch (cause) {
      throw new KeysetError(`OAuth signing key ${i} cannot be imported`, { cause });
    }
  }
  const keyset = new Keyset(keys);
  const out: PublishedJwk[] = signing.map(published);
  for (const jwk of secrets.oauthAnnouncedKeys) {
    // During rotation step 3 a key is both announced and signing; publish it once.
    if (!kids.has(jwk.kid)) {
      kids.add(jwk.kid);
      out.push(published(jwk));
    }
  }
  return Object.freeze({
    keyset,
    signingKids: Object.freeze(signing.map((k) => k.kid)),
    currentKid: (signing[0] as PrivateEs256Jwk).kid,
    jwks: Object.freeze({ keys: Object.freeze(out) }),
  });
}
