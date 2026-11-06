# M3 #68 wrong-owner DELETE status: owner decision draft

**Status:** review-only proposal; not published to GitHub. No issue state or runtime behavior changes are authorized by this note.

## Conflict

- M3 issue #68's published acceptance contract calls for **403** when a signed-in user requests deletion of another DID's scrobble.
- The accepted Node-host contract in [ADR 0005 §5.8](../../adr/0005-local-node-host-and-compat-apis.md) specifies **404** for another DID's record. The current route also returns the same `404 not_found` for a URI that is not one of the caller's own scrobble records.
- `worker/test/node/http/writes.test.ts › DELETE /api/v1/scrobbles/{id} of another DID's record is 404 and of an own record is 202 scrobble.delete` verifies the 404, a different collection refusal, and that no delete operation or PDS delete is created for the unauthorized target.

Thus the current implementation follows the accepted ADR and privacy-preserving not-found behavior, but does not satisfy the published issue's literal 403 requirement. The two status codes are not interchangeable evidence.

## Decision requested from the issue owner

**Recommended reconciliation:** amend #68's wrong-owner status expectation from 403 to 404, retaining the accepted ADR 0005 contract. Keep the current behavior and add the ADR/test references to the issue amendment. This avoids revealing whether another DID's URI exists and keeps ownership refusals indistinguishable from unknown/non-owned targets.

If product/security ownership instead explicitly chooses 403, that is an architecture change—not a test-only repair. The owner should approve an ADR amendment, then the route, OpenAPI response contract, privacy/security rationale, tests, and case-map entry should be changed together. Do not change the implementation until that decision is recorded.

## Scope and evidence limit

This proposal does not assert M3 completion, live PDS behavior, or external acceptance. The route tests use local fake PDS/SQLite fixtures. No GitHub issue was edited, closed, or otherwise mutated; M7 is excluded.
