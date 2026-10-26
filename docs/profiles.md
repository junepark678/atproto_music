# Public identity and music profiles

Profiles are keyed by DID. A handle is shown only when it is verified in both directions. Both routes are public, answered by the Worker with one IndexDO RPC each, and served with `Cache-Control: no-store` ([ADR 0004](adr/0004-cloudflare-workers.md) §5.8, §9.1).

## `GET /api/v1/users/{did}/profile`

- The path must hold a syntactic DID; anything else is 422 `fields.did`, with no IndexDO call.
- **Visibility is decided first, in one synchronous read**: an unknown, inactive (deactivated, taken down, suspended, deleted, or reactivating without a complete snapshot yet) or opted-out DID is 404 *before any identity request is made*. So a profile lookup can never be used to make the server contact an arbitrary DID's PDS or PLC entry.
- The same transaction reads the counts and the indexing state: `totalScrobbles` (visible scrobbles), `followerCount` and `followingCount` (distinct visible edges, uncapped; [follows.md](follows.md)), `joinedAt`, `indexedAt` and `indexing`. A known user with no records is 200 with zero counts; a user whose indexing has not finished reports `recovering` with `caughtUp: false`.
- Only then is the identity resolved, through the IndexDO's cached resolver (`identity_cache`: 5-minute TTL, 1-hour negative TTL). `handle` is set only when the DID document's alias resolves back to the same DID (DNS TXT `_atproto.<handle>` over DoH, or `https://<handle>/.well-known/atproto-did`). A stored alias alone, a mismatch, or an unavailable resolver or upstream gives `handle: null`, and never hides the user's music data.
- The payload is exactly the eight public `Profile` fields; there is no private variant, because the server has no sessions.

`no-store` means a newly verified listen, a deletion or a deactivation shows on the next read; identity results are at most 300 seconds old.

## `GET /api/v1/resolve?handle=`

Explicit handle resolution for clients such as the SPA. Exactly one `handle` parameter, a syntactic handle outside the reserved TLDs, is accepted (otherwise 422 `fields.handle`). The handle is lowercased, resolved to a DID, the DID's document fetched, and the document's verified handle must be the requested one.

| Outcome | Response |
| --- | --- |
| verified round trip | 200 `{did, handle, verified: true}` |
| no DID for the handle, or the document is gone | 404 `not_found` |
| the two directions disagree | 422 `identity_mismatch`, `fields.handle` |
| timeout, 5xx, a blocked or unsafe destination, a malformed document | 502 `upstream_error` |

Resolution creates no user, hint or job and starts no crawl. Every outbound request goes through SafeFetch: https only on the default port, hostnames only (no IP literals, `localhost`, `.local`, `.internal`, `.arpa` or single-label names), a DoH pre-check that refuses private, loopback, link-local, CGNAT, ULA, multicast and reserved answers, no redirects, a 10 s deadline and body caps (64 KiB for DID documents). DNS pinning is impossible on Workers; the residual DNS-rebinding window is documented and probed live (A5, W6-05).

## Account state

The account-status sweep (hourly for users active in the last 30 days, daily for the rest) and error-driven detection hide a deactivated account from profiles, history, feeds, statistics, follow lists and counts as soon as it is observed. Reactivation stays hidden until a complete verified snapshot commits ([workers.md](workers.md)). The daily identity sweep clears a handle that no longer verifies, and a PDS change re-snapshots the account.

## Tests

`worker/test/read/profile.test.ts` covers 404 for unknown and inactive DIDs with zero identity transport calls, `no-store` with an unverified handle, recordless users and the fixture's follow counts, each response validated against `api/openapi.yaml`; `worker/test/read/resolve.test.ts` covers verified 200, unresolved 404 and mismatch 422; `worker/test/ingest/identity-cache.test.ts` covers the 299/301-second TTL boundary with the frozen clock. All run with `npm test`, in workerd, with no network.
