# Finding 32: API love recipient proof (L2)

## Scope and binding behavior

L2 is stacked on READY PR #209 at `5d573706bf07bb50e0c8b79cf1d34a3f6c56a975`.
Root orchestration thread: <t3-thread://v2/087fc341-1687-4dc7-ab25-e7c53896db5e/31bac5d7-edc0-4879-af3e-91e9f6e2600c>.
Migration 57 is not allocated in this checkpoint. Schema ceiling remains 56;
all existing migrations remain byte-identical. The unallocated proposal is
[the v4 DDL](finding32-l2-v4-proposed.sql): 17 statements, eight non-derived
tables and nine indexes. It is not registered or executed by application code.

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
all four actionable findings and directed this interface repair, without a
policy question or schema57 allocation. The retained
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

## Read-cap relaxation and evidence gate

The 128 full-DECISION read cap is a provisional relaxation of the
Astra-approved 96-read cap, not unchanged policy. Actual measured B2 production
path used 25 facade read statements versus the model surrogate's 13:
`96 + (25 - 13) + 20 = 128`. The additional 20 statements are integration slack
for acknowledgement, envelope, and counter work; they are not measured
full-path proof.

This is a full-L2 runtime/acceptance gate, not a prerequisite to registering
the reviewed schema-57 DDL. The actual whole DECISION path must have a hard
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
DECISION 28, and mandatory real schema-56-to-57 CLI upgrade/restore.

Probe artifacts: `/tmp/atproto-followup-sol/finding32-sol-actual209-cost-probe.ts.txt`,
`finding32-sol-actual209-cost-results.json`, and `finding32-sol-actual209-cost-probe.log`.
Those artifacts measured materialization plus one link-scoped enqueue only.

## Remaining gates

Before migration-57 registration, Sol must reconcile this stage-one checkpoint,
the measured 13-row handoff allowance, and the final DDL. The proposal hash is
`8f13e1943e5ad599-84c4bd9d783e299c-ce931963f4064330-3e0f30cce3768a5d`
(hyphen-separated groups of the SHA-256 value); the
existing schema-56 Node authorizer scratch-upgrade test executes all 17
statements and verifies eight tables, nine indexes, unchanged schema version 56,
and a clean foreign-key check on the rebuilt scratch database. The migration
is still unregistered. Before full-L2 acceptance/readiness, complete whole-path
128-read traces and countercontrol, real 56-to-57 CLI upgrade/restore, fresh
Astra review of the provisional cap/derivation/worst case, and remaining
terminal, cleanup, and scale gates. Small behavior fixtures belong in
`worker-node`; growing fixtures belong in `worker-bench` with VM/statement/
returned-row bounds, not elapsed-time claims. No schema-57 runtime behavior or
full recipient/materializer is part of this stage.


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
