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
after an uncertain response it reads back before retrying. A different writer's
record at a colliding rkey is never overwritten by a failed create path.

Migration 7 is additive. It adds `listen_removals.operation_id` and
`removed_cid`, a container lookup index, and the durable `batch_delete_listens`
intent table. It also records `removal_operation_id`/`removed_at_ms` on the
batch-entry and import-item mappings. Only a confirmed removal sets
`removed_at_ms` and releases that item's `listen_keys` row; sibling mappings,
keys and import outcome counters remain intact. A queued/running/blocked/failed intent remains suppressed. A
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

1. Publish and independently review all five production lexicons, including
   `<prefix>.scrobbleBatch`; retain the existing four-schema receipt unchanged.
2. Create the separately reviewed five-schema publication manifest and set
   `NAMESPACE_BATCH_PUBLICATION_REF` to its digest alongside the existing
   `NAMESPACE_PUBLICATION_REF`. Runtime checks digest format and distinctness;
   the operator's reviewed manifest is the trust source, not an automatic
   remote cryptographic verification.
3. Back up the Node database, deploy the additive migrations, and verify schema
   version 7 before enabling batch publication. Existing sessions must
   reauthorize to receive the new repository scope.
4. Enable the batch publication reference, then enable/schedule the batch
   import job lane. Watch held jobs, batch scope errors, CAS retries, split
   outcomes, per-listen counters, and container-level proof convergence.
5. To roll back, first stop new batch imports and remove the batch publication
   reference. Do not roll back the SQLite file or restore an older binary that
   cannot read migration 7. Let already queued/running writes reconcile, then
   deploy a compatible build with batch reads and removals retained. Published
   batch records remain on user PDSs and require a current or future
   batch-aware reader; rollback does not explode them into singles or delete
   them remotely.
