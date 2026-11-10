# Finding 32: API love recipient proof (L2)

## Scope and binding behavior

L2 is stacked on READY PR #209 at `5d573706bf07bb50e0c8b79cf1d34a3f6c56a975`.
Root orchestration thread: <t3-thread://v2/087fc341-1687-4dc7-ab25-e7c53896db5e/31bac5d7-edc0-4879-af3e-91e9f6e2600c>.
Migration 57 is allocated but not yet pushed with the planner-authorized
original-origin amendment. Its exact revised proposal is
[finding32-source-origin-revised57-proposal.sql](finding32-source-origin-revised57-proposal.sql):
17 statements, eight non-derived tables, and nine indexes.
Current proposal SHA-256:
`54dc2d344097763e055b0f8f7f10d8f85993ccdaf0e31620b699726c35256a96`.
Migration 57 adds only `api_origin` to `love_api_bindings`, constrained to
`web`, `lastfm`, or `listenbrainz`; the binding transaction must capture the
accepted operation's actual origin, with no default or inferred history.
Migrations 1–56 remain byte-identical. Superseded proposal SHA-256:
`8f13e1943e5ad59984c4bd9d783e299cce931963f40643303e0f30cce3768a5d`.
Its receipts are preserved as superseded evidence. Prior old-hash 56→57 CLI
receipts do not prove the amended migration; rerun them against the new hash.
Populated-L2 restore and whole-path readiness remain pending.

### Pre-amendment database audit

Audit scope was this PR worktree (including ignored files, excluding generated
dependency/build trees), the sibling project worktrees under
`/home/june/.t3/worktrees/atproto_music`, the source checkout
`/home/june/atproto_music`, and the project-owned state location
`/home/june/.local/state/atmusic` and its backups. No tracked `.db`, `.sqlite`,
or `.sqlite3` files were found. Tracked binary goldens were signed CAR test
fixtures, not database files. No database-like file was found in this PR
worktree. Ignored E2E `work/e2e/state/atmusic.db` candidates in sibling
worktrees were classified as disposable E2E state; read-only `schema_migrations`
maximums ranged from 3 to 38, all below 57. Exact ignored E2E candidates and
ledger maxima were: `p136` (3), `t3-00ce61ee` (14), `t3-086c3461` (3),
`t3-0b3bd325` (3), `t3-1f53053e` (3), `t3-2432087f` (3), `t3-26cbf84d` (3),
`t3-416384ed` (20), `t3-6c3de083` (21), `t3-afc4ba59` (15),
`t3-bb756701` (38), `t3-c0086f15` (4), `t3-cbd00b22` (4),
`t3-cf20597c` (3), and source checkout `/home/june/atproto_music` (3); each
candidate is at `work/e2e/state/atmusic.db`. They are ignored generated E2E
state, not production databases. Project-state backups, including the
pre-migration backup, were read-only inspected through their schema ledger;
`atmusic-20261105T0508Z.db`, `atmusic-20261106T0827Z.db`,
`atmusic-20261107T0330Z.db`, and `atmusic-20261107T1356Z.pre-migration.db`
reported max3; `atmusic-20261108T0330Z.db`,
`atmusic-20261109T0330Z.db`, and `atmusic-20261110T0330Z.db` reported max14.
All are below57.

The non-disposable live candidate
`/home/june/.local/state/atmusic/atmusic.db` could not be ledger-read because
SQLite reported `database is locked`; it and its WAL were not modified. Per
owner-provided provenance, live release `41ee496` predates this stack and
master has not shipped migration 57. This local lock leaves its current ledger
unverified; no global filesystem scan or network access to the live system was
performed. The planner's owner-provided release provenance plus the readable
project backup ledgers found no old-57 database to protect from amendment.

Binding design is replay addendum > batch addendum > Opus v4 plan. Q1 is YES
(proof is independent of egress pause), Q2 is NO (no opaque revival proof).
Only exact SENT API-operation delivery establishes positive recipient proof.
B1 receipt/local acceptance/B2 delivery ledger/older unrelated backfill do not.
Use exact incarnation, current link/generation, immutable projection envelope,
and the minimum original horizon. Keep comparison facts sticky through cleanup
and conflicts, pin them across synchronous producer batches, preserve safe
current-and-successor integer checks and the shared core `trackKey`, validation,
and mapper. Keep source/link prefilters before witnesses; broad and narrow
identity invocation orders must both be covered. Preserve the #209 canonical
survivor veto at enqueue and dispatch, and explicit API unlove user intent.
There is no LOVE UPDATE producer, pending-negative transfer to B2, compensation,
receipt resend, or DID in rendered UI.

## Stage 1 checkpoint

Implemented stage-one prerequisites are the retained verified-authority helper,
the common settlement `UPDATE RETURNING` result contract, and the narrow
`enqueueApiRecipientUnlove` acknowledgement handoff. The old `settleRows`
return contract remains `void`; sent transitions still feed the existing B2
delivery ledger. Age, stale-nowplaying, and held expiry consume exact changed
rows from their transition statements. A typed synchronous observer sees those
rows inside the transition transaction; no L2 proof hook is claimed before the
recipient tables exist. The existing expiry report shape is unchanged.

Fresh Astra stage-one review of
`0e61254bb0f8a53af3a0e5986efbb1791f34d45e` returned **REJECT**. Sol accepted
all four actionable findings and directed this interface repair. The exact
047b1c6 stage-one recheck independently accepted stage-one compatibility only;
it did not accept full L2, the 128-read whole-path gate, CLI/restore readiness,
or finding32 closure. Sol then explicitly authorized migration57 allocation
and full L2 implementation in the same PR. The retained
verified-authority helper and shared settlement `UPDATE RETURNING` contract
remain accepted.

`enqueueApiRecipientUnlove` preserves ordinary `enqueueForwards`' row-count
contract. It now consumes a trusted accepted API-recipient envelope from the
future L2 binding owner. The envelope carries DID, projected record URI and
incarnation, API operation ID, projection rkey,
source/exclusion context, immutable projected track fields, and exact A2
authorization. The adapter validates URI/DID/rkey/incarnation/key/auth/current
link generation consistency, then maps that envelope to the B2 payload. It
does not read current incarnation path/source, operations, or import-bridge
history. Stage-one tests validate this contract but cannot claim that the
future binder/table producer supplies it or that original API delivery has
been proved SENT. No public caller or L2 proof hook is present.

Current API-love forwarding from web, Last.fm, and ListenBrainz has no source
exclusion. An API origin label does not imply import provenance or exclude the
same-named recipient service. Only exclusions captured in the accepted
envelope can refuse the target, before witnesses/effects. Broad import
exclusions remain unchanged. The production `love.put` executor test also
proves that a reused record can have a request `rkey` different from its
projection URI `rkey`. The handoff does not require the original request rkey:
that diagnostic is absent from the approved durable schema and cannot be
reconstructed after operation cleanup. Snapshot/import reuse fixtures and operation-GC/mutable-
source controls exercise the adapter without consulting those mutable rows.

Effect acknowledgements use exact `(link_id,kind,dedupe_key)` seeks without
rowid ordering. Wrong-kind collisions use bounded exact seeks for the four
existing forward kinds. There is no bridge-history query, broad link-history
scan, new index, or schema change. Durable Node coverage exercises both
broad/narrow orders, all three API origin labels, both services,
active/disabled/revoked targets, current/stale generation,
queued/deferred/replay/refused acknowledgements, exact payload/auth/key checks,
wrong-kind collision, receipt/witness/ledger non-proof, source exclusions,
authority and survivor negatives, and zero-egress paused then exactly-once
same-remote resume through both production fake transports. Executor reuse and
transport tests do not establish the future immutable L2 binding or
positive-SENT producer proof.

Current schema-56 cold/warm helper-plus-adapter costs are measured around the
actual adapter with SQLite `total_changes()` and facade row/call accounting.
At both 1k and 10k unrelated same-link outbox rows plus matching import bridges,
the traces were identical: cold deferred 11 changed rows /45 read calls /14
mutation calls /19 returned rows; warm deferred 0 /13 /0 /8; missing-authority
refusal 1 /14 /1 /1; explicit target-exclusion refusal 0 /1 /0 /1; queued 6
/39 /7 /15; terminal replay 0 /12 /0 /8. The 13 changed-row allowance holds;
counters and pointer/receipt/cascade changes are included. The adapter issued
zero bridge-history queries and zero unbounded outbox-identity queries.

Worker-bench direct-SQL growth controls connect the instrumented production
adapter and its exported exact-effect SQL to 1k/10k fixtures. Exact miss/hit
and exact-kind VM work stayed at 15/28/28 steps with the same full unique-index
plan at both sizes. The rejected outbox miss grew 5,021→50,021 VM steps; the
rejected matching-bridge history query grew 6,038→60,038 steps and rows
1,000→10,000. Break controls prove production-query monitors catch each old
shape. Ratios and bounded work are asserted, not elapsed time or exact opcode
pins. The previous 43-read/11-row report from rejected head `0e61254` is
historical; the current adapter remeasured at 45 reads/11 rows.

The terminal observer rejects Promise/thenable results before transaction
commit. The old `settleRows` return contract remains `void`; sent transitions
still feed the existing B2 ledger. Age, stale-nowplaying, and held expiry
consume exact changed rows, and the expiry report shape is unchanged. Three
durable regressions verify rollback of settlement/SENT ledger, age expiry, and
held expiry; they fail when only the Promise guard is bypassed. The observer is
a trusted synchronous contract, not cancellation of arbitrary async work.
Empty transition batches do not invoke it.

## Stage 2 implementation progress

The amended schema57 commit `f94c749` is pushed. The production `love.put`
reuse path runs the existing-record lookup, current incarnation and exact
API-admission reads, import bridge updates, L2 binding/member writes, and
admission deletion in one synchronous transaction; runner memo state changes
only after commit. Successful new API creates now also retain their exact URI,
operation origin, and current recipient members inside an executor transaction
before the API admission can be removed. The binding reads the exact
`operations.origin`, accepts only API origins, validates URI/incarnation and
API admission identity, and stores origin without a default. It seeks only
exact current-link/current-generation love rows. SENT rows at binding create
positive proof; queued/held rows create pending members. A production executor
regression projects a created love, settles its exact current-generation
forward row, persists a signed delete event, and observes the sealed immutable
decision through `applyRecordProof`. Operation-GC/reopen coverage for reuse
spans all three API origins and verifies import does not create API bindings.

The shared terminal `UPDATE RETURNING` result now feeds the L2 member consumer
inside the same transaction for settlement and age/held expiry. Only exact
SENT transitions promote an aggregate; every terminal result removes its
matching pending member. Existing B2 delivery ledger behavior and expiry
report shape remain covered. Hint comparison invokes retained L2 comparison
before A2 pending-removal authorization and ORs its sticky conflict result into
the existing gate. The current slice adds a direct-absence preparation
and sealing seam in `applyRecordTarget`: it requires the exact unexpired
`live_record_evidence` delete tuple, retains the comparison fact, validates the
selected SENT operation's persisted API origin, and stores immutable projection
fields and the original evidence horizon before projection cleanup. Exact SENT
settlement can promote a pending member and attach that member's persisted API
origin to the sealed decision in the same transaction. The production
executor/projector test covers new API binding, exact current-generation SENT
settlement, persisted delete evidence, and decision sealing before projection
cleanup. The same actual executor test now deletes the bound operation and SENT
outbox row before repository deletion; the persisted L2 binding reconstructs
the exact `listenbrainz` source for decision sealing after both mutable source
rows are gone. This does not prove producer-batch pinning, a materializer, or
an egress handoff. Production caller matrix and whole-path costs remain
pending. Bounded API-origin binding retention and reclamation remain pending.

The next slice now records exact current-generation `love_api_window_owners`
when a pending love-removal window is persisted. Authorization compares the
retained delete/update event before A2 advances, records the exact recipient
comparison fact with the minimum event/window horizon, and seals an immutable
decision only after the existing survivor, newer-intent, and local-re-love
guards allow the delayed removal. Owner rows cascade with the exact pending
window and stale link generations cannot acquire ownership. An actual Node DB
integration test binds an API-origin love, settles its forward row to SENT,
creates/replays the delayed window, authorizes the retained event, executes the
window, checks the sealed payload/source, verifies owner cascade, and rotates
the link generation to prove stale recipient exclusion. This is delayed-window
ownership/sealing evidence only; batch pinning, materialization, egress, and
full cost bounds remain pending. The scoped owner plus authorization trace is
12 changed rows, 16 reads, 15 mutation statements, and 12 returned rows,
including the idempotent repeated-window call; decision sealing is outside
that trace.

The executor's reuse, snapshot, and import-incarnation tests exercise actual
binding for each API origin. An instrumented real Node DB helper trace measured
7 SQLite changed rows, 9 read calls, 8 mutation statements, and 6 returned
rows, including singleton initialization and allocator changes. The new API
create binder measured 9 changed rows, 11 reads, 10 mutation statements, and 6
returned rows; exact replay measured 0 changed rows /3 reads, and URI rebind
refusal measured 0 changed rows /3 reads. These helper traces stay within the
13-row handoff allowance. They are not the composed whole DECISION path.
Focused suites cover production love executor, recipient
handoff/module boundaries, sticky facts, SENT/failed/age/held settlement, and
direct-absence fact/envelope sealing. Migration authorizer/shape/storage,
restore CLI 56→57 plus older-live merge, secret scan, typecheck, scoped Biome,
and diff check passed for their recorded commits. Full cold/warm/refusal/replay
handoff combinations, producer-batch pinning, and complete actual whole-path
traces remain pending.
No whole-path128 or full-L2 budget proof is claimed. The next stages must
measure actual helper, handoff and whole decision costs, retaining the hard
96-write/16-visit/DECISION28 limits and provisional whole-read128 gate.

## Read-cap relaxation and evidence gate

The 128 full-DECISION read cap is a provisional relaxation of the
Astra-approved 96-read cap, not unchanged policy. Actual measured B2 production
path used 25 facade read statements versus the model surrogate's 13:
`96 + (25 - 13) + 20 = 128`. The additional 20 statements are integration slack
for acknowledgement, envelope, and counter work; they are not measured
full-path proof.

This remains a full-L2 runtime/acceptance gate after schema57 registration. The actual whole DECISION path must have a hard
Node/bench assertion of at most 128 read statements across cold initialization,
warm, replay, refusal, partial-delete, completion, rejection, and cleanup
paths. Include a deliberate negative control that exceeds the bound and fails.
The older helper-only 24-scenario probe (maximum 25 reads, 16 returned rows,
changed rows active 12 / disabled 11 / revoked 11) measures the previous #209
path and does not satisfy this whole-path gate. Stage-one adapter traces above
are current; whole-path traces, including cold and partial-delete scenarios,
remain **pending** until that runtime exists.

Fresh Astra L2 acceptance must explicitly review the 128 cap, this derivation,
actual worst-case traces, hard assertion, and failing over-cap negative control;
it cannot inherit the earlier 96-read model or presume 128 is unchanged policy.
If any actual whole-path scenario exceeds 128, stop that path and return the
trace to the planner through Sol. Neither Sol nor implementation may raise the
cap again independently. Other limits remain 96 writes/invocation, 16 visits,
DECISION 28, and mandatory populated real schema-56-to-57 CLI upgrade/restore acceptance.

Probe artifacts: `/tmp/atproto-followup-sol/finding32-sol-actual209-cost-probe.ts.txt`,
`finding32-sol-actual209-cost-results.json`, and `finding32-sol-actual209-cost-probe.log`.
Those artifacts measured materialization plus one link-scoped enqueue only.

## Remaining gates

Migration57 is registered at the planner-authorized revised hash above. The
old-hash authorizer/CLI receipts are preserved and explicitly superseded; the
new-hash authorizer, real 56→57 CLI upgrade, and older-live restore passed on
the amended migration slice. Full L2 behavior, whole-path128 traces and
countercontrol, fresh Astra review of that gate, populated-L2 restore,
producer-batch pinning, bounded retention/reclamation, scheduler/maintenance,
terminal cleanup, and scale gates remain pending. Small behavior fixtures
belong in `worker-node`; growing fixtures belong in `worker-bench` with
VM/statement/returned-row bounds, not elapsed-time claims.


## Narrow request-metadata correction

The stage-one recheck rejected `4979eda` only because the envelope required
`apiRequestRkey`, which has no storage in the approved binding/aggregate/decision
contract after operation GC. The field and its unconditional validator are
removed, with no new schema or reconstruction query. Exact API operation ID
remains part of the trusted binding contract; projection rkey still matches
the stored record URI. The executor distinct-request/projection-rkey regression
is retained. A new regression serializes an envelope with no request metadata,
deletes the operation and reopens the real Node database before handoff. It
fails before the correction and passes afterward. This is stage-one envelope/
reopen evidence, not real L2 table reconstruction or CLI restore acceptance.
Fresh independent acceptance and all stage-two gates remain required.
