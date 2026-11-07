# ADR 0006: Batched import records

Status: **accepted for implementation; batch publication remains closed.**
Date: 2026-11-07. This decision applies to import records only. Live scrobbles
and imported loves continue to use their existing single-record collections.

## Decision

Add the candidate schema `com.example.atmusic.scrobbleBatch`, configured at
runtime as `<prefix>.scrobbleBatch`. A batch is one repository record with a
`createdAt` envelope timestamp and 1–10,000 `listens` (amended; see
[Capacity](#capacity)). Every entry has a unique
stable TID `id` and every field of a single scrobble except `$type`; this
includes the entry's own required `createdAt`. The core remote validator
reuses single-scrobble validation by synthesizing `<prefix>.scrobble` for each
entry. Invalid entries are dropped individually. Invalid envelope shape,
count, or duplicate valid IDs excludes the container. Unknown remote fields
remain ignored like single scrobbles.

The writer fills a record by bytes up to the reference PDS's verified write
limit (amended; see [Capacity](#capacity)). The original 64,000-byte DAG-CBOR,
100,000-byte body and 200-entry caps are withdrawn. The body size includes
`repo`, `collection`, `rkey`, and `record`; JavaScript string length is not a
byte count. `packages/core/src/scrobble-batch.ts`
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
scrobble removal is admitted. Since migration 11 it decides only receipts that
settled without a server-checked head (below): such a legacy receipt stops
suppressing an entry or single once its membership records an absence newer
than that fence, and with no verified absence in between a present proof at
its evidence CIDs stays in the removed incarnation. A pending or failed intent
always hides. Settlement bumps `stats_version`, since it can make a later
incarnation visible at that moment. The table is derived and is purged on
disconnect; restoring an older backup only loses boundaries, which hides more,
never less.

Verified nonmembership survives first tracking. A batch entry that gets its
first membership row (a projection older than migration 10, or an entry first
seen after its container was removed) inherits as `last_absent_revision` the
container's own verified absence (`*`.last_absent_revision) and the revision
of the previous valid container version whose recorded membership did not
list it, whichever is newer. An entry the previous verified projection held
that a valid version no longer lists is recorded absent at that version even
without a row. Only a valid version's exact membership proves nonmembership:
an excluded (invalid) or absent container version proves nothing about
entries, and public visibility is never consulted.

Migration 11 is additive: `operations.removal_head_rev` and
`removal_commit_rev`. A locally observed revision is only a lower bound of the
repository state a removal write met, and no finite set of observed CIDs can
cover versions this index never saw, so every scrobble removal write (batch
listens and single records) is fenced by the owner's PDS itself:

1. read the repository head (`com.atproto.sync.getLatestCommit`, a public GET
   over the authenticated writer transport, no write points), then the target;
2. persist the head revision as `removal_head_rev` (never moved backwards)
   before the send;
3. send `putRecord`/`deleteRecord` with both `swapCommit` (that head CID) and
   `swapRecord` (the CID just read). The PDS commits it only while that head
   is current, so the removal is the next commit after it. Any intervening
   commit, to this record or any other, is `InvalidSwap`: nothing was written,
   and the next try reads a fresh head and record, so a remove-and-restore
   between the reads and the write (ABA) cannot slip through. An unrelated
   commit retries within the same attempt (at most five times);
4. keep a success response's `commit.rev` (a TID newer than the checked head)
   as `removal_commit_rev`.

Migration 12 (additive: `operations.removal_done_rev`, `removal_done_basis`)
separates completion from that provisional send fence. Two facts of the
reference PDS (`@atproto/pds` 0.5.40, `api/com/atproto/repo`) decide it.
First, a head read before an absent read does not order the absence: another
writer can commit a target-containing B after the head and remove it at D
before the read, so a boundary at the head would show a delayed proof of B.
Second, a 2xx without commit metadata does not prove a compare-and-swap: its
`deleteRecord` of an absent record and `putRecord` of the bytes already stored
return before `processWrites`, the only place `swapCommit` and `swapRecord`
are checked, and answer without `commit`. So a removal settles only with an
ordered completion boundary `removal_done_rev`, a revision at or after which
every target was proven absent, with its basis:

- `commit`: the write's success carried a well-formed commit newer than the
  checked head. Only `processWrites` returns one, after enforcing both swaps,
  so that commit removed the targets;
- `absent`: an absent read bracketed by the same head (CID and revision)
  before and after it, so nothing was committed during it;
- `verified`: after a send, verified membership (written only by verified
  ingest) records every target absent at a revision newer than the send
  fence `removal_head_rev`; the oldest such revision is the boundary;
- `after` (migration 13): the first repository head read after the requested
  state was known to be reached (below); a strict bound.

Migration 13 (additive: `operations.removal_reached`, `removal_reached_at_ms`)
separates durable no-replay knowledge from that ordering. The Astra 5e18a99
review showed two ways the migration 12 rule still failed. A moved closing
head recorded `absent_after` at the head read before the absence, and a later
present read settled the whole intent there, so with targets X and Y, B (both
present) after that head, D removing both and R recreating only X, a delayed
proof of B showed Y although Y was removed and never recreated (X's presence
released it). And a received success without commit metadata (the reference
no-op, or an actual commit whose metadata was left out) followed by a
recreation R before the read-back left nothing durable, so the retry wrote
again and removed R. The rule is now:

- No-replay knowledge (`removal_reached`: `commit`, `success`, `absent` or
  `verified`) is persisted the moment the evidence is in hand, before
  anything else is awaited: a semantically valid 2xx answer to this intent's
  own write (a JSON object for deleteRecord; for putRecord the same URI and
  the CID of exactly the bytes sent; commit metadata may be absent or
  malformed, unknown fields are ignored), an absent read of every target, an
  enforced commit, or a verified absence after the send fence. A body that
  does not answer the request certifies nothing and is read back like a lost
  answer. Once set, the intent never writes again, across a failed read-back
  or head read, reauth, crash, restart or a read-only tenth reconcile.
- Ordering (`removal_done_rev`) is write-once: a stable bracket around an
  absent read orders it exactly (`absent`); otherwise the first head read
  after the requested state was reached (the closing head of an absent read
  whose head moved, or the head read after a success answer, or after an
  unavailable closing head) is the `after` boundary. When that closing head
  moved, one more read bracketed by it and the next head can refine it to an
  exact `absent` at the same revision; nothing else ever moves a boundary, so
  a later head or absence never covers a genuine later incarnation.
- A reached removal with no head read after it yet (its closing head and the
  next head failed, or a 401 blocked it) holds read-only: queued with
  `removal_reached_unordered`, no attempt spent, its wait doubling with the
  time since the state was reached from 5 s up to 300 s; it stays pending, so
  every target stays hidden. After a send the hold keeps that attempt counted
  and is never failed for attempts. A sign-in failure blocks it as before.

A success without a usable commit, a failed write, a lost answer, an
InvalidSwap or RecordNotFound, and the read-only reconcile of an interrupted
tenth attempt therefore settle only through an ordered or verified absence or
the first head read after the requested state was reached; malformed and
missing commit metadata never order anything. A known commit still needs a
successful read-back before it settles (a failed read-back holds read-only,
never writes). No arbitrary delay, finite CID enumeration, settlement time or
"latest head" guess is used as evidence.

Unknown sends (migration 14, amendment after Astra a176da7 F1). Server
acknowledgement and local persistence are never atomic: a crash after the PDS
committed but before `markReached` was durable, a lost response, a 5xx, or a
2xx body that does not answer the request leaves no evidence whether the
conditional write happened. Re-sending the intent under a newer head was a
destructive replay: with D committed, R recreating the original bytes and the
retry fenced by R's root, the old intent removed R although no fresh user
intent was admitted. The rule is now:

- Before each write is awaited, the exact request is pinned with its fence
  (`removal_send_state = pending`, `removal_send_json` = {method, body
  (swapCommit, swapRecord, record bytes), head CID and revision},
  `removal_head_rev`), in one transaction.
- While the requested state is not known reached, a pending send decides
  every later attempt and the read-only reconcile: every target absent is
  `absent` no-replay knowledge (ordered as above); verified membership proving
  every target absent after the fence is `verified`; the head still at the
  pinned root means nothing was committed since, so the very same request is
  re-sent unchanged (one CAS on that root, so at most one of them can ever
  commit, a late original included); any other head holds read-only
  (`waiting`, `removal_send_uncertain`, no attempt spent by the hold itself,
  an attempt that sent stays counted, its wait doubling with the time since
  the pin from 5 s up to 300 s, never failed for attempts). A present target
  at a newer root cannot tell an unexecuted removal followed by unrelated
  commits from a completed one followed by an identical recreation, so the
  intent is never expanded to a newer root. A pinned swapRecord that does not
  match the record read after a head equal to its root proves nothing by
  itself: the original may have committed between the head read and the
  record read, and the record been recreated since (amendment after Astra
  de5abe1 F1). Only the same head read again after the record (a stable
  bracket) shows the read saw exactly the root, where that request can never
  commit; then it is released. A moved closing head holds as above; an
  unavailable one holds (`removal_send_unresolved`) and reads again.
- A read that cannot finish or answers a malformed value while a send is
  unknown holds the same way (bounded, read-only), never fails the removal
  (amendment after Astra de5abe1 F3); a sign-in failure still blocks it and a
  classified scope denial keeps its own handling. The read-only reconcile of
  an interrupted tenth attempt holds whenever a send is unknown, at its root
  too (the original may still arrive), and never sends; a transient outcome
  of the tenth attempt of such a removal holds instead of exhausting it. A
  received refusal (400, 403, 404, 429, …) of a later send, the exact re-send,
  is no evidence about the unknown original either: the removal never fails
  on it and keeps its pin and fence. A sign-in failure and the batch lane's
  scope hold still block (resumable); a scope denial of a single record asks
  for a new sign-in the same way; a rate limit keeps its Retry-After backoff;
  any other refusal holds with its attempt counted, so the exact request
  repeats only at its root and at most until the read-only tenth reconcile,
  and never loops within an attempt. Removals with no unknown send, and the
  definite refusal of an original send, keep the ordinary failure policy.
- A pin is only ever sent when it is fully this removal's request (amendment
  after Astra de5abe1 F6): exactly `{method, body, head}`, a CID and TID
  head, `swapCommit` equal to the head CID, a CID `swapRecord`, the
  removal's own repo, collection and rkey, `deleteRecord` for a single record
  or a whole container, and for a partial removal `deleteRecord` or a
  `putRecord` of a valid retained container (its `$type`, 1–10,000 entries none
  of which is a target, within the batch size limits; other fields are the
  owner's bytes). An invalid pin is never sent, never replaced and never
  released; it holds like any unknown send until resolved as below.
- Pinning is the final gate before the write (amendment after Astra de5abe1
  F7): one synchronous transaction checks that the operation is still this
  running attempt (state and attempt count), not known reached, and that the
  request is valid and equal to any existing pin; the write is initiated with
  nothing awaited in between, and a denied gate sends nothing. A supersession
  while the executor awaits its head or record read therefore stops it. A
  request already transmitted cannot be retracted and stays subject to its
  own CAS; its completion settles only a still-running operation, so a stale
  success never cleans the successor's receipts or counts statistics.
- Only a definite rejection of the pinned original send itself (a received
  4xx: InvalidSwap, RecordNotFound, a validation, scope or sign-in error, a
  rate limit) records `rejected`, after which a new fenced send may follow.
  Elapsed time, reauth, unblocking, a budget refund, a present read, an
  absence read that lacks ordering (it is reached, then ordered as above) or
  a definite rejection of a later re-send never clear an unknown send. A
  crash before the rejection was persisted stays unknown.
- A send fenced before migration 14 (a `removal_head_rev`, no send state, not
  reached) is pending with only its fence revision: at that same revision a
  fresh read and send is equally a single CAS on the unchanged root (and is
  pinned); any other head holds.
- Resolution of an indefinite hold is a later explicit intent. A new removal
  on the key never waits behind a removal holding an unknown send (it is left
  out of `operation_deps`), and an edge that already binds a removal to a
  removal of the same key that holds read-only and never sends again
  (`removal_send_uncertain`), directly or through another removal, no longer
  holds it back (amendment after Astra de5abe1 F4); a removal that may still
  re-send at its root, creates and ordinary writes keep binding. In the transaction that admits it, every earlier
  such removal whose targets are all covered by removals admitted after it
  (`*` covers every listen; a single record is covered by any later removal
  of it) is cancelled `removal_superseded` with `removal_superseded_by`, so it
  never sends again and the later intent carries the hiding and the write;
  one only partly covered keeps holding (and hiding) its remaining targets
  until they are covered too, absent or verified absent. The later intent is
  fenced by its own fresh head: it is the user's decision about whatever is
  there now. Protocol repeats stay sensible: Last.fm library.removeScrobble
  and ListenBrainz delete-listen absorb a repeated request into the held
  removal while no verified projection of the target is newer than its fence
  (a repeat of the same intent), and admit a fresh intent once one is (a
  provably newer verified incarnation, also one created outside this app
  with no local create receipt: ListenBrainz looks through the held
  removal's overlay, and only it, for a projection verified above its send
  fence, amendment after Astra de5abe1 F5); the web DELETE route is always an
  explicit intent. Operators resolve a held removal the same way: no flag or
  timeout marks it complete. Durable reached knowledge still forbids every
  replay, as above.

A succeeded receipt with an exact basis hides its targets at every projected
revision at or below `removal_done_rev`, whatever the CID: a delayed proof of
an intermediate version this index never saw, or of an absence and identical
restore that preceded the write, cannot resurface or retire it. An `after`
receipt hides them strictly below the boundary. The targets were all gone at
some version at or below that head, so every pre-removal version is below it
and any projection at or above it is a later incarnation; a later incarnation
committed between the absence and that head cannot be told apart from a
pre-removal version by revision, so it stays hidden until verified ingest
proves the record at or above the boundary (a re-proof of unchanged bytes
carries the newer revision, and settlement queues the record's verify hint).
Because that re-proof changes visibility without changing content, applying
unchanged scrobble bytes at a newer revision of a record that has a succeeded
removal receipt bumps `stats_version` in the proof's own transaction (single
and batch, live proofs and snapshots; amendment after Astra a176da7 F2), so
cached statistics filled after settlement converge with export, status and
visibility; the cutoffs themselves never move, and the per-owner and per-URI
revision guards are unchanged. A snapshot entry with the stored CID and no
body re-proves the same bytes, so it writes what a live proof of them writes
(amendment after Astra de5abe1 F2): record_state, every projection row's
revision, verified membership re-noted from the index's own verified version
of exactly those bytes (never invented without one), and that statistics
bump; a later hint at the same head is then a true no-op. Excluded versions
keep their exclusion and counters.
That unresolved region is deliberate, not a waiver: a plain getRecord
absence and a no-op answer carry no revision (the history H, D1 absent, B
present, D2 absent, R present gives identical observations whichever absence
was read), so only a head read after the fact orders them. A target projected
above an exact boundary, or at or above an `after` one, is visible at the
same or a new CID, even when its proof arrived before local settlement, and
Last.fm can remove it again. Neither settlement time, wall clock, CIDs nor a
sibling's presence order anything.

Trust and binding: the head is the owner's own PDS's report, checked for
CID/TID syntax and bound to the owner by the session's own repository; it is
not a verified proof. It bounds only how this receipt suppresses its own
targets and never writes `record_state` or `verified_membership`; status
endpoints keep reporting only verified state. The PDS enforces `swapCommit`
atomically with the write, so an honest PDS cannot commit the removal at any
other position; a PDS that lies about its head can only change how its own
owner's removal is displayed here. Fail closed: a removal never writes or
settles without a well-formed head, or against a head older than the target's
verified revision here or its own `removal_head_rev`/`removal_done_rev` (a
repository that went backwards). It waits instead (`last_error`
`repository_head_unavailable`, `repository_head_behind_index` or
`repository_head_behind_fence`, retried every 5 s, no attempt spent), and
stays hidden while it waits; after a send the same condition is a counted
transient failure (or, once the requested state is known reached, a counted
read-only hold), so a send is never uncounted. A `record_not_ours` receipt
carries no head, no boundary and no no-replay knowledge. A receipt left with
migration 12's `absent_after` basis (written only by the unreleased PR #161
rule; no deployment carries batch receipts) keeps the at-or-below rule; no new
operation writes that basis. Receipts that settled under migration 11 (a
head, no `removal_done_rev`) keep its rule (at or below `removal_head_rev`, or
below `removal_commit_rev`); receipts that settled before migration 11 keep
the migration 9/10 rules (CID evidence, verified-absence fence);
`listen_removal_cids` is still recorded as forensic evidence.

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

## Capacity

Amendment N12-01 (evidence and source permalinks:
[batch capacity](../verification/batch-capacity.md)). Containers remain inline
records. The reference PDS (bluesky-social/atproto `fe343a1b`, `@atproto/pds`
0.5.40) sets these limits:

- `jsonLimit: 1_000_000` decimal bytes on `createRecord`, `putRecord` and
  `applyWrites`; body-parser/raw-body refuse only a larger body;
- at most 200 `applyWrites` operations;
- at most 2,000,000 bytes of relevant blocks per commit;
- no per-record CBOR cap.

Accordingly:

- **Write ceiling.** Every scrobbleBatch `createRecord` or `putRecord` body
  sent is at most 990,000 exact UTF-8 bytes, a 10,000-byte (1 %) margin. The
  `applyWrites` body (single scrobbles only; containers never share it) uses
  the same ceiling and keeps the 200-write limit.
- **Packing target.** New containers pack to 989,454 create-body bytes, so a
  partial-removal `putRecord` still fits: it drops at least one entry and adds
  `swapCommit` and `swapRecord` (546 bytes reserved for 257-character CIDs).
  DAG-CBOR is checked exactly at 990,000. For validated entries it is always
  smaller than the JSON.
- **Entry count.** The 10,000-entry bound in the lexicon and validator is a
  resource ceiling. The shortest valid entry is 118 JSON bytes, so a record
  under 1,000,000 bytes holds at most 8,403 valid entries (ours at most
  8,314), and the count never binds before the bytes.
- **Ingest.** A verified container is accepted up to 2,000,000 DAG-CBOR bytes.
- **Packer.** The packer sums exact additive sizes and verifies each group
  boundary against the whole-group encoding (linear time).
- **Writer.** Each slice creates at most one container, the longest fitting
  prefix of the eligible staged listens, from a scan of at most 10,001 items.
  The listen that does not fit stays staged, so only a job's last container is
  short. The `WRITE_SLICE` back-pressure on queued items is unchanged.
- **Snapshots.** `getBlocks` bisects a batch whose response overflows its
  8 MiB cap.

For a representative ListenBrainz listen (507-byte entry), a container holds
1,947 listens. That is 3 points per 1,000 standalone, about 1.54 points per
1,000 in a large import, and 60 creates for 116,700 listens.

Unchanged by this amendment:

- containers of at most 200 entries written earlier stay valid, sendable and
  removable;
- unknown-history singles finish at their original rkey;
- written receipts are untouched.

The lexicon candidate changed, so the owner must publish and verify the new
candidate before the batch publication gate opens.

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
6. Removals need the PDS to serve `com.atproto.sync.getLatestCommit` and to
   honour `swapCommit` on `putRecord`/`deleteRecord` (the reference PDS does).
   A removal whose head is unavailable or behind the index waits with
   `repository_head_unavailable` / `repository_head_behind_index` and retries
   every 5 s without writing; it is never sent unfenced. Watch for operations
   held on these codes after deploy: they indicate a PDS without the standard
   head endpoint or a repository that went backwards, and they are resolved
   on the PDS side, not by editing rows.
7. Monitor held imports, `batch_scope_required`, CAS retries, split outcomes,
   per-listen counters, and container-level proof convergence. A scope denial
   classified permanent (HTTP 403 or a 4xx `ScopeMissing`/`InsufficientScope`/
   `Forbidden`) holds the affected batch lane until re-consent; it does not
   discard intent. A 5xx or transport failure retries with backoff whatever
   error name its body carries and never asks for re-consent.
8. To roll back, stop admitting new batch imports, drain all outstanding batch
   creates and deletes while the gate remains open, then close the batch
   reference. Do not roll back the SQLite file or install a binary that cannot
   read the schema version reported by the release. Retain batch reads,
   visibility and removal support. Published records remain on user PDSs;
   rollback does not explode them into singles or delete them remotely.
