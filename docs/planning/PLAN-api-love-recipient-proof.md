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

The handoff preserves ordinary `enqueueForwards`' row-count return contract.
It preflights current link generation, API operation/source lineage, source
exclusions, track keys, canonical survivor, identity collisions, and trusted
authority before recording a witness or effect. Its four acknowledgements come
from exact durable current-generation state; a witness alone is never deferred
or replay acceptance. The witness key `(link_id,generation,operation_id)` holds
distinct broad and `:api-recipient` identities without schema changes. Durable
Node coverage exercises both orders, active/disabled/revoked targets and both
services, stale/current generation, refused/replayed/queued/deferred states,
receipt and B2-ledger non-proof, source exclusions, collisions, survivor
checks, and paused zero-egress then exactly-once same-remote resume through
ListenBrainz and Last.fm test transports.

Actual schema-56 cold/warm adapter traces are asserted in worker-node. Across
the service, status, and invocation-order matrix, the maximum was 11 SQLite
changed rows (the handoff allowance is 13), 43 facade read calls, 14 facade
mutation calls, and 21 returned rows. The cold active queued handoff measured
9 changed rows; cold disabled/revoked deferred handoffs measured 11. Warm
queued, terminal replay, stale-receipt refusal and retired-receipt replay
measured zero changed rows. SQLite `total_changes()` is sampled around the
adapter call, so counters, pointer changes and trigger/cascade effects are
included. `one`/read `all` calls, mutating method calls, returned rows and
changed rows are reported separately. A deliberate 14-row injected-write
control crosses 13 and trips the hard assertion. Sol's older 24-case probe
remains evidence for the prior #209 materialization-plus-enqueue path only.

The terminal observer rejects Promise/thenable results before transaction
commit. Three regressions verify rollback of ordinary settlement and SENT
ledger, age expiry, and held expiry. The new hook is a trusted synchronous
internal contract, not cancellation of arbitrary asynchronous callback work.
Sol's pre-guard probe reproduced the missing rejection; all three durable cases
fail when only the Promise guard is bypassed and pass with the guard. Empty
transition batches do not invoke the observer; expiry controls each observe
the actual changed love row before verifying rollback.

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
