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
Jetstream verification stay keyed by the container. A snapshot that no longer
holds a container sweeps it like a single: every projected listen is deleted,
the container is recorded absent at the snapshot head and `stats_version`
moves.

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
the operation persists each read CID before its CAS write. A success outcome
never replaces that pre-CAS `swap_cid` with a post-write CID. If the process stops
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
suppressed. A succeeded intent suppresses only the incarnation it removed
(migrations 9 and 10 below). Legacy removal rows without an operation remain
conservatively suppressed. The existing four-schema publication receipt and
migrations 1–6 are unchanged.

Migration 8 distinguishes historical operations with unknown send status from
new operations proven unsent. Every operation current code inserts carries the
explicit `unsent` receipt; the first attempt makes it `unknown` before anything
is sent, and nothing sets it back: not reauth, unblock, a budget deferral or an
attempt refund, and not an absence read or elapsed time. An accepted PDS request
can commit after any client deadline, so absence never proves a historical send
unsent. Only an explicitly unsent row (its receipt, no attempt, no send
timestamp) may be cancelled locally (`library.removeScrobble`, disconnect),
rewritten as a never-sent batch, or rebatched.

A legacy import single, or any import single attempted before, is read at its
persisted rkey before any write and never enters the write batcher or the
rebatcher. A matching remote record settles it; a conflict never overwrites
it; an unavailable read waits. When the key is absent the single is created at
that same original rkey: a late commit of the earlier request and this create
cannot both land (createRecord never overwrites; an ambiguous answer is
reconciled by digest). Retries stay bounded by the ten-attempt budget; an
interrupted tenth attempt is only read, and absence then fails the item
without an eleventh send. A removal of such a create chains a delete behind it
instead of a local cancellation, and an unsent import single with a dependency
runs in the normal lane, so neither side of a chain is stranded. On a live
upgrade the queued unknown-history singles therefore finish as singles, while
the staged majority and every new import are batched automatically.
Already-written import items and their receipts remain unchanged. Splitting
also partitions pending removals among child containers, with the original
removal receipt waiting for every child.

Migration 9 is additive. `listen_removal_cids(operation_id, cid)` records every
container CID at which a removal's targets were observed present before its
write: the projected CID at admission, each pre-CAS read, and a read-back that
still holds the targets. Nothing is captured at settlement, whose timing says
nothing about repository order (the projection may already hold a verified
later recreation). A succeeded partial or wildcard removal hides a listen whose
projected container CID is `swap_cid`, `removed_cid` or one of these, so a
delayed older proof does not resurface it, while a restoration at a new CID is
visible and a Last.fm `library.removeScrobble` of it admits a fresh intent. The
table is local suppression evidence; it never writes `record_state` absence.
`operations.legacy_absent_at_ms` belonged to an unreleased two-read absence
rule; it is no longer written or read, and a row carrying it is never treated
as explicitly unsent.

Migration 10 is additive. `verified_membership(record_uri, listen_id)` keeps
the verified membership of each batch container version, apart from public
visibility: every valid-TID entry is `present` or `excluded` (its fields failed
validation; exclusion is not absence), an entry a newer verified version drops
is `absent`, and a container proven absent marks itself (`listen_id='*'`) and
all its entries absent. `last_absent_revision` keeps the newest verified
revision of each absence across later present rows; it is the incarnation
boundary. A single scrobble record gets a `*` row once proven absent. Rows are
written only from verified proofs and snapshot entries/sweeps, behind the
per-URI revision guard, guarded again by the stored revision; never from local
intent or write completion, so a delayed older observation cannot move them.
`operations.removal_fence_rev` is the target's verified revision when a
scrobble removal is admitted, refreshed just before each removal write. A
succeeded removal stops suppressing an entry or single once its membership
records an absence newer than that fence: whatever is projected afterwards is a
later incarnation and is visible, even with byte-identical bytes and the same
CID, and Last.fm can remove it again. Every absence at or below the fence
preceded the write. With no verified absence in between, a present proof stays
in the removed incarnation (hidden) even at the same CID; a pending or failed
intent always hides. Settlement bumps `stats_version`, since a fence already
crossed can make the listen visible at that moment. The table is derived and
is purged on disconnect; restoring an older backup only loses boundaries,
which hides more, never less.

Record status for a listen fragment checks verified membership separately from
the common visibility overlay. For a visible owner's present container whose
membership is recorded at the exact container CID, an entry the version does
not hold is `absent` at the container revision and a held entry that failed
validation is `excluded` (container CID, revision, reason). A held listen hidden
by a local delete intent, a receipt, a cross-format duplicate or a hidden owner
reports `unknown`, as a hidden single does; a container projected before
migration 10 (no recorded membership) is `unknown` until re-proved; an inactive
owner discloses neither membership, exclusion nor absence.

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
   The writer and migrator run automatically once the gate and grant permit
   them; no separate migration command or replacement import job is needed.
   Resume the existing job through its import resume API only if it remains
   manually paused. Queued legacy import singles with unknown send history
   finish at their original rkeys (read first, then created there if absent);
   only explicitly unsent singles are rebatched, and staged items are batched.
   Already-published singles retain their original records.
6. Monitor held imports, `batch_scope_required`, CAS retries, split outcomes,
   per-listen counters, and container-level proof convergence. A scope denial
   classified permanent (HTTP 403 or a 4xx `ScopeMissing`/`InsufficientScope`/
   `Forbidden`) holds the affected batch lane until re-consent; it does not
   discard intent. A 5xx or transport failure retries with backoff whatever
   error name its body carries and never asks for re-consent.
7. To roll back, stop admitting new batch imports, drain all outstanding batch
   creates and deletes while the gate remains open, then close the batch
   reference. Do not roll back the SQLite file or install a binary that cannot
   read the schema version reported by the release. Retain batch reads,
   visibility and removal support. Published records remain on user PDSs;
   rollback does not explode them into singles or delete them remotely.
