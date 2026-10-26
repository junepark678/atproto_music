// IdentityResolver over SafeFetch (ADR 0004 §4.4, §5.6; W2-02).
//
// resolveDid(did):
//   1. syntax gate (did:plc, hostname-level did:web) before any I/O;
//   2. unless `fresh: true`, the injected cache hook is asked first and a hit
//      is returned as is (freshness — TTL 5 min, negative 1 h — is the hook's
//      business: the worker backs it with the identity_cache table and the
//      injected clock);
//   3. otherwise the DID document is fetched (did-doc.ts), the `#atproto`
//      signing key and `#atproto_pds` endpoint are extracted, and the claimed
//      handle is verified in both directions (handle.ts) — null on mismatch;
//   4. the result is written back through the hook (also after a fresh
//      resolution, so a rotated key replaces the cached one).
// A failure is never cached here and never returns a partial identity.
//
// `fresh: true` (key-rotation retry, identity sweep) skips the cache read but
// still refreshes the cache with what it found.

import type { Clock } from '@atmusic/core/deps';
import { createSafeFetch, type DeadlineTimer, systemTimer } from '../net/safe-fetch';
import { isFixtureTransport } from '../net/url-policy';
import { fetchTransport, type Transport } from '../transport';
import { createDidDocumentFetcher, didDocumentUrl, parseIdentityDocument } from './did-doc';
import { createHandleResolver } from './handle';
import type { IdentityResolver, ResolvedIdentity } from './types';

export {
  IDENTITY_ERROR_CODES,
  IdentityError,
  type IdentityErrorCode,
  isIdentityError,
} from './did-doc';

/** Optional cache hook; the worker supplies an identity_cache-backed one. */
export interface IdentityCache {
  /** A still-valid cached identity for `did`, or null. */
  get(did: string): ResolvedIdentity | null | Promise<ResolvedIdentity | null>;
  /** Store a successful resolution; `docJson` is the validated document. */
  put(identity: ResolvedIdentity, docJson: string): void | Promise<void>;
}

export interface IdentityResolverOptions {
  /** Production: the global fetch. Tests: a fixture router transport. */
  transport?: Transport;
  clock: Clock;
  cache?: IdentityCache;
  /** Deadline source for every request; defaults to AbortSignal.timeout. */
  timer?: DeadlineTimer;
}

export function createIdentityResolver(options: IdentityResolverOptions): IdentityResolver {
  const transport = options.transport ?? fetchTransport;
  const clock = options.clock;
  const timer = options.timer ?? systemTimer;
  const fixture = isFixtureTransport(transport);
  const safeFetch = createSafeFetch({ transport, clock, timer });
  const documents = createDidDocumentFetcher(safeFetch);
  const handles = createHandleResolver({ transport, clock, timer, safeFetch });
  const cache = options.cache;

  async function fetchIdentity(did: string): Promise<ResolvedIdentity> {
    const { doc, json } = await documents.fetch(did);
    const parsed = parseIdentityDocument(doc, { fixture });
    const handle = await handles.verifyHandle(did, doc);
    const identity: ResolvedIdentity = {
      did,
      pds: parsed.pds,
      signingKey: parsed.signingKey,
      handle,
      fetchedAtMs: clock.nowMs(),
    };
    if (cache) await cache.put(identity, json);
    return identity;
  }

  return {
    async resolveDid(did, o) {
      didDocumentUrl(did); // throws invalid_did before the cache or the network
      if (cache && o?.fresh !== true) {
        const hit = await cache.get(did);
        if (hit !== null && hit.did === did) return hit;
      }
      return fetchIdentity(did);
    },
    resolveHandle: (handle) => handles.resolveHandle(handle),
  };
}
