# ADR 0006: Batched import records

Status: **accepted for implementation; batch publication remains closed.**
Date: 2026-11-07. This decision applies to import records only. Live scrobbles
and imported loves continue to use their existing single-record collections.

## Decision

Add the candidate schema `com.example.atmusic.scrobbleBatch`, configured at
runtime as `<prefix>.scrobbleBatch`. A batch is one repository record with a
`createdAt` envelope timestamp and 1–200 `listens`. Every entry has a unique
stable TID `id` and every field of a single scrobble except `$type`; this
includes the entry's own required `createdAt`. The core remote validator
reuses single-scrobble validation by synthesizing `<prefix>.scrobble` for each
entry. Invalid entries are dropped individually. Invalid envelope shape,
count, or duplicate valid IDs excludes the container. Unknown remote fields
remain ignored like single scrobbles.

The writer must cap a record at **64,000 DAG-CBOR bytes** and its exact
UTF-8-encoded `com.atproto.repo.createRecord` JSON body at **100,000 bytes**.
The body size includes `repo`, `collection`, `rkey`, and `record`; JavaScript
string length is not a byte count. `packages/core/src/scrobble-batch.ts`
exports the shared limits, record builder and validator, stable URI helpers,
and a stable-order packer. `packages/atproto/src/scrobble-batch-size.ts`
provides DAG-CBOR and exact request-body measurements for that packer.

An indexed listen identity is
`at://<did>/<prefix>.scrobbleBatch/<rkey>#<listenId>`. The fragment names an
AppView item, not an AT repository record. Proofs and repository operations
always use the fragment-free container URI. Helpers reject malformed DIDs,
collections, record keys, and TIDs.

## Publication and OAuth gate

The existing four-schema production receipt remains truthful and continues to
gate existing writes. Batch writes require the separate optional
`NAMESPACE_BATCH_PUBLICATION_REF=sha256:<64 lowercase hex>` setting in
addition to `NAMESPACE_PUBLICATION_REF`. The batch digest must differ from the
old digest and refer to a separately reviewed manifest containing successful
public retrieval evidence for all five production schemas, including
`<prefix>.scrobbleBatch`. Runtime validation checks the digest shape and
distinctness only; it is not remote cryptographic verification. With either
gate missing, batch publication is disabled. `meta.capabilities` adds
`batchPublication` only when both gates are open. OAuth metadata requests the
batch collection scope only under that same gate, so existing sessions must
reauthorize before writing batches.

The checked-in batch lexicon is an unpublished candidate. No publication,
record write, PDS request, or production environment change is part of this
ADR. See [publication instructions](../verification/lexicon-publication/README.md).

## Scope boundary

Live scrobbles and imported loves retain their existing single-record writes.
Batch visibility belongs to this AppView's collection-aware projection and
compatibility APIs. AppViews that subscribe only to `<prefix>.scrobble` will not
see batch entries; the service does not create duplicate single records for
them. Item identities use the container URI plus `#<listenId>` for local
operations, while proof, snapshots and repository writes always use the
fragment-free container URI.

## Ingest, projection, and removal behavior

The Node implementation validates a verified batch as one bounded container,
then replaces its projected entries atomically at the container's verified
revision. Individual entries are validated through the single-scrobble rules;
invalid entries are counted and excluded. Repository deletion removes every
projected entry. Batch provenance is stored in `scrobbles.record_uri` and
`listen_id`; the item URI is `record_uri || '#' || listen_id`. Snapshot and
Jetstream verification stay keyed by the container.

Removing a batch item admits a `scrobble.delete` operation with the batch
collection and durable entry-id intent. The visibility overlay hides only the
target item immediately; a whole-container delete hides every entry. Same
container operations depend on preceding unsettled operations and therefore
serialize without cancelling a shared create or its siblings. The executor
reads the owner's current record and uses `putRecord` with `swapRecord` to
remove selected entries while spreading the envelope and retaining all
untouched entry fields, including unknown remote fields. Removing the final
entry uses `deleteRecord` with the same compare-and-swap CID. On
`InvalidSwap`/repository change it re-reads and retries against the new CID;
the operation persists each read CID before its CAS write. If the process stops
after the PDS commits a whole-container delete but before local settlement,
read-only reconciliation completes from verified absence while retaining that
CID in the receipt, so stale projected listens stay hidden until newer proof
shows a later recreation. After an uncertain response it reads back before
retrying. A different writer's
record at a colliding rkey is never overwritten by a failed create path.

For a queued import batch that has never started sending, removal prepares a
replacement record and digest asynchronously, then rechecks the exact operation
snapshot and item/key memberships in one transaction before rewriting it. It
keeps sibling entry IDs stable and cancels only when the batch becomes empty.
If sending started, removal stays chained to the create and follows the item to
a child container if a definite rejection splits the batch. A failed create
with `remote_record_conflict` makes its dependent removal complete as
`record_not_ours`; it never mutates the colliding record.

Migration 7 is additive. It adds `listen_removals.operation_id` and
`removed_cid`, a container lookup index, and the durable `batch_delete_listens`
intent table. It also records `removal_operation_id`/`removed_at_ms` on the
batch-entry and import-item mappings. A never-sent rewrite records the removed
item timestamp, clears its stored record payload, and releases its `listen_keys`
row in the same transaction. A confirmed chained removal does the same after
PDS success. Sibling mappings, keys, payloads and import outcome counters
remain intact; removed items are excluded from queued-work counts and tracked
by their removal timestamp. A queued/running/blocked/failed intent remains
suppressed. A
succeeded intent suppresses only the previously verified CID until a newer
proof replaces the projection; if the owner deliberately restores the entry,
the new CID makes it visible. Legacy removal rows without an operation remain
conservatively suppressed. The existing four-schema publication receipt and
migrations 1–6 are unchanged.

The local outbox and read model define this AppView's result. PDS publication
does not imply that another AppView has indexed the custom collection, and
feedback clients must use this service's ListenBrainz/Last.fm endpoints to
resolve pending or indexed batch listens. OAuth sessions created before the
batch scope was enabled need reauthorization. The UI follow-up should advertise
the batch capability and explain the extra scope request; this slice does not
implement web UI changes.

## Operator rollout and rollback

1. Keep the four-schema `manifest.json` unchanged. Publish the production-ID
   `<prefix>.scrobbleBatch` lexicon under the namespace authority DID, then
   retrieve all five production schema records without authentication. Compare
   canonical content with the approved lexicons and record each URI, CID,
   retrieval URL, content digest, and UTC time in a reviewed, versioned copy of
   `docs/verification/lexicon-publication/batch-manifest.template.json` kept in
   the repository. Never make the rollout depend on a temporary file.
2. Review the five-record receipt and run the repository's lexicon publication
   checks. Its batch check must require exactly the four records in the
   existing receipt plus the separately evidenced batch record. Compute the
   SHA-256 from that reviewed file and set
   `NAMESPACE_BATCH_PUBLICATION_REF=sha256:<digest>` alongside the existing
   four-schema reference. Runtime validation checks syntax and distinctness;
   the operator-reviewed receipt is the trust source, not remote verification
   performed by the server.
3. Back up the Node database and deploy the compatible release with additive
   migrations while the batch gate remains closed. Confirm the schema version
   reported by that release; do not assume a fixed version because later
   additive migrations may be stacked. Confirm existing capabilities remain
   available and `batchPublication` remains absent.
4. Before closing an already-open batch gate, stop admitting new batch imports
   and drain every queued/running batch create and delete to a terminal state.
   The runner excludes **all** batch operations while the gate is closed, so
   closing it with outstanding writes suspends them until the gate is reopened;
   they cannot be drained after closure. Do not remove batch read and ingest
   support as part of gate closure.
5. Open the batch reference and restart/reload the service. Confirm `meta`
   advertises `batchPublication`, then have every account whose grant predates
   the batch scope re-consent to `repo:<prefix>.scrobbleBatch`. Verify the new
   grant through the OAuth session before resuming that account's held work.
   Only then enable the batch import writer/migrator. Unsent legacy import
   singles are eligible for rebatching only through the transactional
   eligibility checks; already-sent singles reconcile or finish as singles.
6. Monitor held imports, `batch_scope_required`, CAS retries, split outcomes,
   per-listen counters, and container-level proof convergence. A scope error
   holds the affected batch lane until re-consent; it does not discard intent.
7. To roll back, stop admitting new batch imports, drain all outstanding batch
   creates and deletes while the gate remains open, then close the batch
   reference. Do not roll back the SQLite file or install a binary that cannot
   read the schema version reported by the release. Retain batch reads,
   visibility and removal support. Published records remain on user PDSs;
   rollback does not explode them into singles or delete them remotely.
