// Identity resolution contract (ADR 0004 §4.4). Frozen in Wave 0.

export interface ResolvedIdentity {
  did: string;
  /** `#atproto_pds` service endpoint, already accepted by the URL policy. */
  pds: string;
  /** `#atproto` verification method as a did:key multikey. */
  signingKey: string;
  /** Verified in both directions, otherwise null. */
  handle: string | null;
  fetchedAtMs: number;
}

export interface IdentityResolver {
  /** `fresh: true` bypasses every cache (key rotation retry, identity sweep). */
  resolveDid(did: string, o?: { fresh?: boolean }): Promise<ResolvedIdentity>;
  /** Handle to DID via DoH TXT or /.well-known/atproto-did; throws when unresolved. */
  resolveHandle(handle: string): Promise<string>;
}
