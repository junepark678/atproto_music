# Deleting a scrobble

The server never deletes anything on a PDS: deletion is a write the owner's browser makes to the owner's own repository, through the SPA's IndexedDB outbox ([ADR 0004](adr/0004-cloudflare-workers.md) §5.2 step 5, amendments A12, A13). The index changes only when it has verified signed absence. The server-side `DELETE /api/v1/scrobbles/{uri}` route, its session/CSRF checks and the server outbox are gone (§9.3).

## In the browser

1. **Enqueue.** The delete is persisted in IndexedDB before the first attempt (`web/src/outbox/delete-ops.ts`). Only a URI in the signed-in DID's own scrobble collection can be deleted.
2. **Hide for the owner at once.** The owner's own pages overlay pending operations on the AppView's pages (`web/src/outbox/overlay.ts`), so the scrobble disappears from the owner's view immediately. Public views (history, feeds, statistics, other people's screens) change only after the AppView has verified the absence, typically within seconds through notify.
3. **Order.** A delete waits for every unsent operation on the same URI (`predecessorIds`), in particular a create that is still queued or in flight, so it never races that create. If the create it waited for ended in `remote_record_conflict` (someone else's record holds that rkey), the delete completes locally without any PDS request: the other record is never deleted.
4. **Send** `com.atproto.repo.deleteRecord` with `swapRecord` set to the record's CID, taken from `GET /api/v1/records/status`, or from the owner's PDS when the AppView does not have the record yet. The CID is persisted before the send, so a crash mid-delete resumes with the same `swapRecord`.
   - `InvalidSwap`: re-fetch from the PDS and reconcile. Absent means done; present with another CID retries, as a counted attempt, with that CID.
   - `RecordNotFound` or 404: look it up; absence completes the delete.
   - Network errors, 5xx and 429 retry after `min(300 s, base + U[0, base/4])` with base 1, 2, 4 … s (a capped `Retry-After` can raise the delay), with exactly 10 attempts and never an eleventh. Retries run only while a tab of the app is open.
5. **Confirm.** On success the SPA sends `POST /api/v1/notify {uri}` and polls `GET /api/v1/records/status?uri=` (backing off to 60 s) until the state is `absent`. The screen shows the operation's state; a delete that failed stays visible in the overlay with its failure code and does not claim removal.

One runner per DID, elected with `navigator.locks`, sends the operations, so two tabs never send the same delete twice.

## In the index

A notify hint, a Jetstream delete event or a reconcile makes the IndexDO fetch `com.atproto.sync.getRecord` for that URI from the owner's PDS and verify it against the current signed head. Absence is applied from exactly two sources:

- a verified **exclusion proof**: the signed MST path for `<collection>/<rkey>` is complete and the key is not in it;
- a **range snapshot** whose verified enumeration of the key range lacks the key.

Then one transaction deletes the projection row, writes `record_state = 'absent'` at that revision (so an older proof can never resurrect the record), bumps the DID's statistics version and drops the hint. A missing CAR, an unparseable CAR, a `RecordNotFound` without a proof or a path with missing blocks is **never** treated as absence: it schedules a snapshot for the DID instead (ADR F4). History, lookup, feeds, statistics and the export stop showing the record in the same transaction.

Local hiding in the owner's browser proves nothing about the PDS, and the AppView's absence proves only that the owner's current repository no longer holds the record. Copies held by other services are outside this AppView's control.

## Tests

`web/test/outbox/delete.test.ts` and `web/test/outbox/recovery.test.ts` cover ordering behind a create, `swapRecord` persistence, `InvalidSwap` and not-found reconciliation, the conflict rule and crashes during a delete (by re-creating the runner over the same IndexedDB); `web/test/outbox/retry.test.ts` covers the delay formula and the 10-attempt cap. `worker/test/write/apply-record.test.ts`, `worker/test/ingest/verify-drain.test.ts` and `worker/test/ingest/rejection-matrix.test.ts` cover verified absence, the per-URI revision guard and "no proof means snapshot, never absence". All run with `npm test`; the live delete-and-reconcile gate is W6-05.
