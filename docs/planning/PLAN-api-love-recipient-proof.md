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

Implemented prerequisites are limited to the retained verified-authority helper
and the common settlement `UPDATE RETURNING` result contract. The old
`settleRows` return contract remains `void`; sent transitions still feed the
existing B2 delivery ledger. Age, stale-nowplaying, and held expiry now consume
exact changed rows from their transition statements. A narrow typed synchronous
callback can observe those rows inside the transition transaction; no L2 proof
hook is claimed before the recipient tables exist. The existing expiry report
shape is unchanged.

The existing enqueue path's post-state is still only exposed as a row count.
Its witness key is `(link_id,generation,operation_id)` and cannot safely encode
the required distinct `api-recipient` identity or four acknowledgements
(queued/deferred/replay/refused). Do not infer deferred/replay from an existing
witness alone. This checkpoint must add a narrowly scoped handoff only if it
can be derived from durable post-state without changing old caller behavior;
otherwise the seam remains an explicit next-stage gate for Sol to resolve before
recipient-table implementation. Existing source and link filters stay ahead of
witness recording.

## Read-cap relaxation and evidence gate

The 128 full-DECISION read cap is a provisional relaxation of the
Astra-approved 96-read cap, not unchanged policy. Actual measured B2 production
path used 25 facade read statements versus the model surrogate's 13:
`96 + (25 - 13) + 20 = 128`. The additional 20 statements are integration slack
for acknowledgement, envelope, and counter work; they are not measured
full-path proof.

The actual whole DECISION path must have a hard Node/bench assertion of at most
128 read statements across cold initialization, warm, replay, refusal,
partial-delete, completion, rejection, and cleanup paths. Include a deliberate
negative control that exceeds the bound and fails. The helper-only 24-scenario
probe (maximum 25 reads, 16 returned rows, changed rows active 12 / disabled 11 /
revoked 11) is real schema-56 evidence but does not satisfy this whole-path
gate. Whole-path traces, including the specifically required cold and
partial-delete scenarios, remain **pending**.

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

Before registering migration 57: durable four-way acknowledgement and identity
handoff; actual cold/warm/helper/refusal/replay/whole-path cost and mutation
traces; both service paused-dispatch zero-egress then exactly-once same-remote
resume; source exclusions and broad/narrow invocation orders; stale/current
generation and exact survivor/receipt semantics; module graph and both cold
import orders; shared settlement result assertions across SENT and all terminal
and expiry cases; deliberate-break controls; schema authorizer/FK scratch
upgrade validation. Small behavior fixtures belong in `worker-node`; growing
fixtures belong in `worker-bench` with VM/statement/returned-row bounds, not
elapsed-time claims. No schema-57 runtime behavior or full recipient/materializer
is part of this stage.
