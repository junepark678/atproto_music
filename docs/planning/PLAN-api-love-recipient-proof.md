# Finding 32: API love recipient proof (L2)

## Current acceptance ledger (test-only matrix checkpoint on `e057645`)

Production and schema are frozen at `e057645ac1a2229c0d1d69189ae0128de9df84fa`; Sol verified `worker/src` matches narrowly accepted `8a406a2bf7b6e20ed82b73ddf1ff5e570ffc1b9a` byte-for-byte. Recipient source SHA-256: `ea26de81e4439d48d5dfce3e7aa661fb99dd6b58f139db173b026d1089c83622`. Migration57 remains frozen at SHA-256 `54dc2d344097763e055b0f8f7f10d8f85993ccdaf0e31620b699726c35256a96`; migrations1–56 are unchanged.

| Requirement | Current evidence | State |
| --- | --- | --- |
| Per-decision whole transaction read/change/visit bounds | `astra-core-cdb.bench.test.ts`: production cold/queued/deferred/replay/refusal/expiry/veto/awaiting/alias and partial-delete traces; exact128 commit, actual129 rollback, actual29-change rollback | scoped pass |
| Whole-invocation changed rows and visits | production eight-decision/orphan fixture reaches16 visits; `rejects an actual seventeenth invocation visit after earlier scheduler phases committed` injects a seventh valid query row against a six-row reservation, totals17 actual visited rows, and proves the current reclaim transaction rolls back while earlier phase commits remain | scoped pass; RECLAIM 7/6 preguard fires before the shared invocation assertion, so a mutation removing only the global assertion is not independently demonstrated |
| Broad-covered paused recipient and narrow SENT proof | `listenbrainz-forward.test.ts`: paused broad B2 acceptance is asserted by exact deferred intent+witness, with no narrow effect; `loves.test.ts`: source-excluded narrow recipient still gets an exact API SENT proof path | scoped pass |
| Schema57 migration ledger and all-table reopen | `local-index.test.ts`: exact historical 1–56 prefix plus 57 tail; coherent rows in all eight non-derived L2 tables survive close/reopen with exact dump equality | scoped pass, 5/5 |
| Real producer batching across two current services | actual API/PDS/direct-delete tests cover a web API love sent to both services and broad route suppression of duplicate narrow effects; producer-derived restore covers imported Last.fm exclusion from broad route plus same-remote transport resume. Two-recipient fact-pin rollback is covered at the pending-removal producer-function seam. The multiple-API-operation, mixed member-status signed producer batch remains incomplete | scoped partial; broader batch remains |
| Restore | producer-derived schema56 capture/real CLI 56→57 and schema57 restore/dispatch proofs exist; populated-state pre-swap merge failure, FK and accept-loss cleanup tests exist; full `scripts/test/restore.test.ts` passes26/26. Some test worlds boot the current server before CLI entry, migrating that live DB first; those live inputs are schema57, not all schema56. The separate #209 archive case is the actual schema56 producer input | scoped proofs; full restore matrix remains |

The read cap is still a provisional relaxation: `96 + (25 - 13) + 20 = 128`; the20 is integration slack, not full-path measurement. Whole-decision<=128, changedRows<=28, invocation<=96 changed rows/16 visits, and metadata reserve12 are unchanged. The 229-read lifecycle receipt is informational wrong-unit evidence. PR210 is not ready and no full-L2 acceptance is claimed.

The root-owned full `check-ts` attempt on `e057645` failed with 2463 passed,
10 failed, and 1 skipped. The preserved inventory is
`/tmp/atproto-followup-sol/pr210-e057645-full-failure/{ts-test-report.json,ts-test-cases.jsonl,gate-durations.json}`
and `pr210-sol-check-ts-e057645.log`. Failures identified two stale broad-
coverage recipient expectations (three instances), two local-index schema57
fixture/ledger assertions, and four nested-gate cascades from those failures.
Sol separately fixed the Last.fm test carrier assumption in test-only commit
`499ca6efec972d7d5962ce1ef9cd99dc8f3fe7fe`; its full 27/27 Last.fm result and
mutation evidence are in `pr210-sol-lastfm-oracle-{green,mutant,typecheck,secret}.log`.
The commit is not yet merged into this candidate at this ledger entry. The
current scoped repairs pass the complete three-file Node set (87/87), the
local-index module suite (5/5), and the full Astra CDB bench file (78/78).
The nested gate was not rerun; those checks remain Sol-owned.

## Scope and binding behavior

L2 is stacked on READY PR #209 at `5d573706bf07bb50e0c8b79cf1d34a3f6c56a975`.
Root orchestration thread: <t3-thread://v2/087fc341-1687-4dc7-ab25-e7c53896db5e/31bac5d7-edc0-4879-af3e-91e9f6e2600c>.
Migration 57 is registered and pushed with the planner-authorized
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
Its receipts are preserved as superseded evidence. New-hash real CLI 56→57
upgrade and older-live restore passed. Populated-L2 restore and whole-path
readiness remain pending.

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
The guarded materializer now reconstructs its handoff only from the exact
sealed recipient, current link generation, persisted SENT API binding,
immutable payload, retained clean fact, original minimum horizon, and
alias/session/epoch guards. A production transport regression creates and
forwards a love through the actual API executor and ListenBrainz fake, applies
verified present and absent repository proofs, records the retained delete
comparison, gets a deferred acknowledgement with zero egress while paused,
then sends one unlove after the same remote resumes and sends nothing on rerun.
This does not yet cover the whole caller matrix or producer-batch pinning.

The timer now runs a bounded keyset reclamation pass over migration57's
existing binding/fact sequence frontiers. It retains original API origin while
an exact selected aggregate/member/decision still depends on it, and keeps
expired comparison facts while a decision or B2 authority still references
them. Small Node regressions verify retained-origin and post-release cleanup,
plus zero-write repeated empty ticks. Large-growth work/fairness controls and
full maintenance lane accounting remain pending.

The current materializer branch trace from the actual Node DB facade measured
8 changed rows, 53 read statements, eight mutation statements, and 21 returned
rows for one created decision. This is a warm created-decision branch only,
not the hard whole-path proof.

The first composed API-create→PDS SENT→present proof→partial-delete→
materializer run was measured from before API admission through handoff. The
old receipt reported 229 reads, 105 mutation statements, 87 changed rows, 110
returned rows, and one deferred handoff. That meter crossed multiple API,
PDS/SENT, proof-ingest, and L2 handoff transactions. It is an informational
lifecycle total and is **not comparable** to the per-decision 128-read cap.
Its original trace and failing-test log remain preserved, unchanged, at
`/tmp/atproto-followup-sol/pr210-whole-decision-overcap-trace.json` and
`/tmp/atproto-followup-sol/pr210-whole-decision-overcap-test.log`; classify
these as wrong-unit evidence, not a cap breach. A corrected Node facade meter
records inclusive actual transaction rows and their nested savepoints in
`/tmp/atproto-followup-sol/pr210-cold-phase-table-v2.json`.

| Actual phase / transaction | Reads | Mutation statements | Changed rows | Returned rows | Visits / outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| Cold scenario: `enqueueLove` API acceptance | 13 | 14 | 13 | 9 | — |
| Cold scenario: `insertOperation` nested in `enqueueLove` | 4 | 2 | 2 | 4 | nested inclusive |
| Cold scenario: `admitForwardIdentity` nested in `enqueueLove` | 1 | 3 | 3 | 1 | nested inclusive |
| Cold scenario: `enqueueForwards` nested in `enqueueLove` | 6 | 5 | 5 | 3 | nested inclusive |
| Outbox `beginAttempts` transaction | 0 | 1 | 1 | 1 | — |
| Preflight `Object.execute` transaction | 2 | 0 | 0 | 0 | — |
| `chargePoints` transaction | 2 | 2 | 2 | 0 | — |
| Cold scenario: API `Object.execute` enclosing transaction | 11 | 10 | 9 | 6 | — |
| Nested `bindApiLoveCreatedOperation` savepoint (included in its parent) | 11 | 10 | 9 | 6 | — |
| Nested `bindApiLoveOperation` savepoint (included in both parents) | 9 | 8 | 7 | 6 | — |
| Proof settlement `admit` nested transaction | 4 | 6 | 5 | 2 | nested inclusive |
| Outbox `Run.settle` transaction | 5 | 7 | 6 | 2 | — |
| `expireRows` transaction | 13 | 0 | 0 | 1 | — |
| `advanceLoveRecordingHistory` transaction | 5 | 8 | 5 | 5 | — |
| `frameLoveRows` transaction | 8 | 0 | 0 | 0 | — |
| `pickJob` transaction | 6 | 0 | 0 | 2 | — |
| `inSlices` nested in ListenBrainz send | 4 | 5 | 4 | 4 | nested inclusive |
| `sendListenbrainz` transaction | 4 | 6 | 5 | 4 | — |
| Forwarder final `runForward` transaction | 1 | 1 | 1 | 0 | — |
| `patchLink` transaction | 5 | 2 | 2 | 3 | — |
| Partial-delete proof-ingest host transaction (includes L2 fact hook) | 47 | 33 | 23 | 25 | — |
| Nested `recordLoveApiComparisonFact` savepoint (included in host transaction) | 2 | 3 | 2 | 1 | — |
| Partial-delete `admitForwardIdentity` savepoint | 1 | 3 | 2 | 1 | nested inclusive |
| Partial-delete `enqueueForwards` savepoint | 27 | 14 | 11 | 12 | nested inclusive |
| Recipient `enqueueForwards` nested in adapter | 21 | 4 | 4 | 11 | nested inclusive |
| `enqueueApiRecipientUnlove` nested in decision | 44 | 4 | 4 | 18 | nested inclusive |
| L2 `materializeLoveApiRecipientDecisions` transaction, including nested enqueue and acknowledgement | 55 | 7 | 7 | 26 | visited 1, deferred 1 |

Nested rows are inclusive at their own boundary and are already included in
their parent totals; never sum them again into the lifecycle. This cold
materializer transaction is within 128 reads, 96 changed rows, DECISION28,
and visits16. It is one recipient/one outcome branch and does not prove the
whole DECISION matrix. Partial-delete is its own proof-ingest transaction,
not an L2 decision unit; its exact parent and hook attribution are measured below.

The planner withdrew its unmeasured `+4/+4` API guess and replaced it with
matched-source, measured N0/N1/N2 limits. The former failed receipt stays
preserved as **superseded**, not a current cap violation. The exact #209 source
archive (`5d573706bf07bb50e0c8b79cf1d34a3f6c56a975`) and current production
path use the same reused-snapshot fixture.

| API acceptance transaction | Recipient count | #209 reads / mutations / changed / returned | Current reads / mutations / changed / returned | L2 delta reads / mutations / changed / returned |
| --- | ---: | ---: | ---: | ---: |
| No active recipient links (N0) | 0 | 22 / 11 / 9 / 16 | 24 / 13 / 11 / 17 | +2 / +2 / +2 / +1 |
| Reused snapshot (N1) | 1 | 26 / 15 / 13 / 19 | 36 / 25 / 22 / 26 | +10 / +10 / +9 / +7 |
| Reused snapshot (N2) | 2 | 30 / 19 / 17 / 22 | 43 / 34 / 30 / 31 | +13 / +15 / +13 / +9 |

N0 remains bounded by +3 reads/+2 changed rows and passes at +2/+2. N1 is
hard-bounded by +12 reads/+11 changed rows and passes at +10/+9. Its 10/9
measurement is also the frozen marginal reference for N2. N2's second-recipient
marginal is +3 reads/+4 changed rows, no greater than that reference; its total
is bounded by `12 + 3 + 1 = 16` reads and `11 + 4 + 1 = 16` changed rows. The
actual N2 total +13/+13 passes. The API per-recipient count is not normalized
for zero recipients; N0 is measured directly. Node negative controls separately
trip each N0/N1/N2 read and changed-row limit.

N2 per-transaction rows (reads / mutation statements / changed rows / returned rows): `enqueueLove` enclosing transaction 17/16/14/12, with nested `insertOperation` 4/1/1/4, `admitForwardIdentity` 1/3/2/1, and `enqueueForwards` 10/8/8/6; `Object.execute` 16/14/12/11, including nested `bindApiLoveOperation` 11/13/11/6; `beginAttempts` 0/1/1/1; `Run.settle` 1/3/3/2, including `enqueueHints` 0/2/2/1. Nested rows are inclusive and must not be summed again. These rows account for the actual two-recipient API path, not a synthetic adapter-only model.

The direct-SQL `worker-bench` growth fixture seeds 100/1,000/10,000 prior loves
and bindings for the same DID, then measures the production `enqueueLove` path
against the exact #209 archive. At every size, N1 is +10 reads/+8 changed rows
(36/25 mutation statements/21 total changed rows/26 returned rows versus
26/15/13/19); N2 is +13 reads/+12 changed rows (43/34/29/31 versus
30/19/17/22). The N2 marginal is +3/+4. N1 and N2 read, mutation, and changed
row counts are identical across all three history sizes. This seeded-history
fixture has an existing proof-state singleton, so its N1 changed-row delta is
8; the fresh-singleton N1 acceptance measurement remains 10/9 and is the frozen
marginal reference above. All 20 N1 and 28 N2 SQL statements captured from
`love-api-recipients.ts` were checked with actual `EXPLAIN QUERY PLAN`; none
scans an L2 table or uses a temp B-tree. Load-bearing controls trip N1 delta,
per-history growth, scan, and sort oracles. The exact parent comparison uses the
archived source at each history size, not current code with hooks disabled.

The synchronous pending-removal producer now has a sibling-recipient rollback
regression. Two exact current recipient owners share the same verified event
fact; a deliberate failure on the second recipient fact read rolls back the
first insertion and event cursor, while retaining the pre-existing owner rows.
A successful retry persists the single sticky fact with the minimum horizon
across both eligible windows and authorizes both. The fixture exercises the
actual `recordPendingRemovals` and `authorizePendingRemovals` producer functions;
API executor/SENT provenance remains separately covered by the real PDS/fake
transport case above.

The independently measured partial-delete proof-ingest transaction also has an
exact parent comparison: #209 is 15 reads/15 mutation statements/8 changed
rows/10 returned rows; current is 17/18/10/12. Its L2 comparison-fact hook
accounts for exactly +2 reads/+3 mutation statements/+2 changed rows. Both the
whole transaction delta and the hook-owned statements are asserted, with the
parent fixture on the archived #209 source. PDS execution, proof ingest, and B2
delivery continue to be checked for only their declared L2 hooks.

The actual cold L2 decision remains 55 reads/7 mutation statements/7 changed
rows/26 returned rows, visited 1/deferred 1. Its transaction begins at L2 entry
and ends at commit, includes nested decision/enqueue work, and stays within
128 reads/96 changed rows/DECISION28/visits16. Independent negative controls
trip each read, changed-row, decision, and visit bound. These path-local rows
are distinct from the 229-read cross-transaction lifecycle total above.

The 229-read lifecycle receipt remains informational and is not an over-cap
negative control. No whole-path128 or full-L2 budget proof is claimed. The
independent 96-write/16-visit/DECISION28 limits and provisional whole-read128
gate remain unchanged.

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
are current. The cold and partial-delete phases are now separately attributed
in the table above; the rest of the whole-path scenario matrix and the
over-cap control remain pending.

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

## Independent CORE audit repair progress (pinned `cdb78de`; fresh source acceptance pending)

The independent Astra CORE/runtime/accounting audit found seven source defects;
Sol accepted the findings and repair direction. The source changes below are
implemented on top of the preserved `cdb78def7e4d7abf832bfe7a9587c9bc1c1f0af3`
head and await fresh source acceptance. They do not establish whole-L2
acceptance or readiness. The audit and repair direction are
`/tmp/atproto-followup-sol/pr210-astra-core-cdb78de.md` and
`/tmp/atproto-followup-sol/pr210-sol-core-cdb-repair-direction.md`.

1. A shared production maintenance scheduler now runs decision, stale-owner
   sweep, and binding/fact reclamation under one 96 changed-row/16-visit
   invocation budget, reserving 12 rows for metadata. It includes cold
   singleton initialization, counter/cursor changes, nested savepoints, and
   actual SQLite `total_changes()` checks before each phase commit. Each
   decision remains at most 28 changed rows and 128 reads; sweep/reclaim use
   finite cursors and bounded rows. A real injected trigger-like 40-row
   amplification makes the decision exceed 28, throws before commit, and
   proves the recipient, decision, outbox, and amplification rows all roll
   back. The prior audit's real 90+18=108 timer reproduction is not relabeled
   as a lifecycle-meter issue; the scheduler now splits work over bounded
   invocations. Current measured fixtures show cold one-decision invocation
   25 changed rows/1 visit (including singleton initialization), warm
   one-decision 24/2, and eight acknowledgements across bounded invocations.
   The follow-up eight-decision/eight-orphan production-scheduler boundary
   charges every reclaim row as a visit (previously reclaim reported zero
   visits to the shared budget). Across seven actual invocations it
   acknowledges all eight decisions and removes all eight orphan bindings;
   each invocation stays at or below 96 changed rows and 16 visits, with one
   invocation using the full 16-visit allowance. Transaction traces list
   decision, sweep, reclaim, and lane-turn phases separately.
   A production SQL over-visit control returns six real ordered binding rows
   against a five-visit reservation; the scheduler trips its visit oracle and
   rolls the attempted reclamation back, preserving all six bindings and the
   unchanged cursor.
   Full cold/partial-delete/replay/refusal/completion/cleanup decision matrix
   and one negative control for every whole-invocation bound remain required.
2. Direct and delayed local re-love checks now recognize only the exact bound
   current-generation API operation/member, including while it is pending.
   The direct producer test proves signed SENT before absence and SENT after
   absence; in the latter order the sealed decision first returns awaiting
   with no unlove effect, then queues after the exact SENT settlement. The
   delayed producer test likewise checks zero effect before SENT and queued
   handoff afterward. The delayed-window case now applies actual signed
   present/absence proofs, executes `recordPendingRemoval` plus the production
   authorization/executor path, asserts awaiting with zero unlove before SENT,
   then observes one queued recipient effect after exact SENT. This does not
   authorize arbitrary unbound or alias intent.
3. Materialization now connects the validated persisted comparison fact to
   `recordVerifiedDeferredLoveAuthority` inside the same handoff transaction,
   before the adapter. Missing, corrupt, conflict, and expired facts still
   fail closed; there is no A2 reconstruction or horizon extension. Existing
   sticky-fact, sibling rollback, no-A2-source, and clean retained-fact tests
   cover the seam. More full real producer-batch coverage remains pending.
   A producer-backed regression deletes the actual A2 event and B2 authority
   after a signed PDS absence seals the decision, then proves the real handoff
   recreates only exact active authority from the retained L2 fact. Its
   materializer/enqueue trace is 55 reads, 11 mutation statements, and 10
   changed rows; this is a materializer unit trace, not a whole-decision
   acceptance claim. Partial-delete attribution is split: the fact-owner
   transaction is 1 read/3 mutation statements/2 changed rows; all statements
   from `love-api-recipients.ts` total 3/5/4; and the archived exact-#209
   whole-call comparison is 3 added reads/6 mutation statements/5 changed
   rows. The old 2/3/2 assertion described the fact-owner transaction, not the
   whole call. The remaining one statement/row in the whole-call delta stays
   visible for Sol's reconciliation; no SQL was hidden or excluded.
4. Handoff loads and persists the minimum original horizon before pending
   member, payload, generation, alias, and replay guards. Expired pending
   members complete as expired and the bounded sweep reclaims stale children
   before their aggregate; current-generation recipients survive. Envelope
   mismatch shortens an existing deadline and refuses without rebinding or
   inventing a sticky authority conflict. Missing/corrupt/conflict and all
   horizon ordering combinations still need the complete producer matrix.
5. Origin-retention lookup now joins exact current link generation and uses
   composite primary-key member seeks; it no longer scans every old recipient
   prefix or unions current and obsolete generations. Production SQL in the
   direct-SQL worker-bench fixture is flat with 100/1k/10k matching released
   history: current-dependent VM steps 71/71/71, released-only 53/53/53,
   while the deliberate old-query control grows 1,294/12,094/120,094. EQP
   shows indexed link and recipient/member seeks without a scan or temp
   B-tree. The production materializer and cleanup use finite aggregate
   cursors; full restored-origin cleanup/reconstruction coverage remains
   pending. Migration57 remains frozen at the approved hash above.
6. Timer wake classification now uses useful semantic outcomes, not visits,
   due rows, or cursor movement: useful L2 work requests a 1-second wake and
   quiet/metadata-only work requests 30 seconds. Timer tests record the 30,100
   ms metadata-only wake and 1,100 ms useful decision wake. An injected L2
   initialization failure after a committed B2 `rr` frontier pass leaves that
   B2 pass intact and preserves the earlier 5,100 ms retry deadline. This
   covers one failure ordering; broader B2 independence and deadline scenarios
   remain pending.
7. A replay mismatch now persists a shorter existing horizon before refusing.
   Payload-only mismatch does not create an authorization comparison conflict;
   only an actual action/CID disagreement records sticky negative authority.
   The regression checks the shorter stored horizon, unchanged immutable
   payload, and clean fact; a later wider matching replay succeeds without
   restoring the original deadline.

Scoped evidence for the earlier repair slice: six worker-node files / 72 tests
pass; four worker-bench files / 16 tests pass. The follow-up bench and origin
growth suites now pass 16/16, including production guard controls for >96
invocation rows, >16 visits,
>128 decision reads, and >28 decision changed rows, plus a real 40-row
amplification injected inside the decision transaction that rolls back its
decision, outbox, and amplified rows. The B2 failure control verifies a
committed `rr` frontier transaction survives the L2 failure. The full restore
file passes 25/25, including producer-derived proof, schema57 CLI restore,
revoked Last.fm plus disabled ListenBrainz zero-egress, same-remote/same-
generation resume, one unlove per remote, and zero-request rerun. Seven
relevant worker-node files pass 112/112; `loves.test.ts` now passes 28/28 with
the fact-owner 2/3/2 and complete partial-delete source trace explicitly
separated. A broader eight-file run passed
138/139; the unchanged Last.fm key-rejection scenario failed its existing
per-link error assertion (global pause counter was recorded, but the link row
retained its prior error fields). That failure is recorded and remains open;
the test is outside this diff and no assertion was relaxed. `npm run
typecheck`, scoped Biome, `git diff --check`, and `scripts/test/secret-scan.test.ts`
pass. These controls do not replace the remaining invocation-wide and full
decision matrix scenarios. The audit's
archived red tests remain the source for the findings; no failing control is
weakened. The whole restoration/caller matrix is still in progress: populate
all eight L2 tables from real API admission, exact PDS/SENT and verified
absence producers, clean operation/outbox rows, then exercise actual CLI
restore into schema56/57 and real timer/backfill/dispatch/resume with fresh
session state and both fake transports. Direct SQL remains limited to
legacy/rollback/corruption setup and growth fixtures. Populated schema-57
producer-derived CLI restore, restored coverage/dispatch/resume, fresh-session
rescan after normal reopen and injected restore rollback, and invocation
accounting now pass. Schema-56 producer-derived L2 restore, the complete
whole-decision scenario matrix,
over-128 negative control, and fresh Astra review remain gates.

The direct-SQL worker-bench retention proof runs the production reclaimer over
100/1,000/10,000 same-DID API bindings with one selected SENT aggregate held at
the final sequence. Each page is fixed at 10 reads, 17 mutation statements, 16
changed rows, 9 returned rows, and at most 8 visits at all three sizes. Cleanup
finishes in 13/125/1,250 fair finite passes respectively; the selected
`listenbrainz` origin survives the pass and is removed in two additional lane
passes after its aggregate is released. Actual query plans for the production
page have no L2 table scan or temp sort. The scan/sort negative controls now run
deliberately unbounded L2 SQL through SQLite's real `EXPLAIN QUERY PLAN` and the
same plan checker; per-page read/mutation/changed-row/visit and scan/sort
controls trip their own guards.

## Remaining gates

For Sol's reconciliation against the cdb78de audit pin, the earlier source
diff SHA-256 `4fec39a75cb84187beb34f3613c7c38d554f2ba024ec1f418cc22782e1bd1b55`
is retained as the pre-backfill-fix receipt and is superseded. The current
working-tree source diff SHA-256 is
`6c2177fb05a370d66a6ff1ab5caae761e9074f381eac78f2f68aa02980f6e872` across 7
files, 904 insertions and 125 deletions. It adds 24 net lines to
`backfill.ts`: an actual scoped run exposed a duplicate synthetic backfill for
an API incarnation already admitted to the exact current recipient. Backfill
now skips only when the persisted binding has an exact current-generation
recipient with that operation as its SENT proof or pending member. A later
ListenBrainz link without that recipient still receives ordinary backfill; the
positive and negative cases pass. This production source change is post-cdb and
must be included in Sol's fresh audit. The other six source files remain as in
the prior source digest; no schema, DDL, or cap change was made.

Migration57 is registered at the planner-authorized revised hash above. The
old-hash authorizer/CLI receipts are preserved and explicitly superseded; the
new-hash authorizer, real 56→57 CLI upgrade, and older-live restore passed on
the amended migration slice. A populated schema-57 restore test verifies all
eight L2 tables survive. The separate producer-derived case creates binding,
recipient/member, fact, window-owner, decision, and epoch/state rows through
real API/PDS/SENT/verified-absence producers; after operation and SENT outbox
cleanup it restores through the real CLI, reopens a fresh server, proves the
origin and SENT authorization joins, invokes actual scheduler/timer/backfill,
and delivers through both fake transports after same-remote resume. The restored
path now has per-transaction invocation accounting and bounded origin cleanup
coverage. A seeded real-CLI failure injection compares all eight L2 tables in
both live and backup files at the post-merge/pre-swap rollback point.
Whole-path128 scenario matrix and over-cap control, fresh Astra review of that
gate, schema-56 producer-derived L2 restoration, producer-batch pinning,
remaining maintenance scenarios, and scale gates remain pending. Small
behavior fixtures belong in `worker-node`; growing fixtures belong in
`worker-bench` with VM/statement/returned-row bounds, not elapsed-time claims.


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

## Producer-derived CLI restore progress

A new restore integration case now produces the live L2 rows through the real
`enqueueLove` API admission, `runOutbox` PDS executor and fake PDS, actual
ListenBrainz and Last.fm transport clients, verified present and delete proofs,
the pending-removal owner producer, and direct-absence fact/decision producer.
It leaves a second actual API operation PDS-SENT with its B2 recipient member
still pending. Before restore it deletes the selected operation row and both
selected SENT love outbox rows; the binding's persisted `api_origin` and
aggregate's exact SENT operation ID remain. No L2 table rows are directly
seeded in this case.
The existing populated-row test remains separate restore coverage.

Before the real PDS absence, the Last.fm link is revoked through the production
revocation function and ListenBrainz forwarding is disabled through
`patchLink`. The real restore CLI merges the readable schema-57 live DB into a
fresh server composition. The restored production backfill timer materializes
the decisions with no unlove outbox rows or remote requests. The test resumes
the same remote identities at unchanged generations, runs actual link-backfill
coverage over the sealed fixture history frontier, and observes one unlove
per recipient across the fake Last.fm and ListenBrainz transports; a rerun
sends zero. The coverage-frontier setup is explicit fixture state; API
admission, PDS SENT, absence, L2 binding/fact/decision, CLI restore, timer, and
dispatch are production paths. Foreign keys are checked after shutdown. This
restore case also checks both exact service/link/generation rows joined to the
single original API binding, selected SENT operation ID, immutable delete
authorization/fact, accepted payload origin, and window-owner identities. It
asserts the selected operation/outbox rows and member are gone; origin and
SENT proof are recovered from durable L2 rows after fresh-server reopen. It
also runs one actual scheduler invocation and checks per-phase reads, mutation
statements, changed rows, returned rows, visits, total writes, and acknowledgements
before the production timer/transport steps. A separate seeded CLI failure-stage
regression covers eight-table atomicity and, after the injected failure, opens
the untouched live DB and proves `prepareLoveApiRecipientHandoff` replaces the
persisted old alias session/cursor with a fresh token and rescans to a valid
handoff. The normal-reopen Node integration separately proves a full 16-row
alias page is revisited. Schema-56 producer-generated L2 state remains
uncovered.

The previous active-at-absence fixture emitted both broad live-delete and
narrow API-recipient effects for each remote. That observed four-effect result
is retained as historical evidence, not erased by this revised paused/revoked
restore path; active-at-absence broad/narrow coexistence still needs Sol's
reconciliation and is not claimed as exactly-once per remote. No broad
producer behavior changed here.

The producer-derived restore case now also verifies the retention endpoint:
after fresh-composition timer work, paused/revoked zero-egress, same-remote
resume, one dispatch per remote, and a zero-request rerun, the original
`love_api_bindings` row is gone once both recipient aggregates are released.
The bounded reclaimer may reach that row during a later lane turn, so the test
asserts the durable post-progress state instead of requiring the dispatch
transaction itself to reclaim it. A separate production-handoff test checks
the direct single-page reclaim result after the final dependency releases.

After real API admission, PDS SENT, verified absence, source-row cleanup, and
schema-57 CLI reopen, one actual fresh-session scheduler invocation is now
measured before the production timer takes over. Its transaction rows
(phase: reads / mutation statements / changed rows / returned rows / visits)
are: singleton-init `2/1/0/2/0`, decision `63/8/8/34/1`, sweep
`11/1/1/11/1`, reclaim `24/6/3/26/5`, second decision `2/0/0/2/0`, second
sweep `2/0/0/2/0`, second reclaim `8/2/1/8/1`, and lane-turn
`3/1/1/3/0`. The complete invocation is 135 reads across its separate
transactions, 19 mutation statements, 14 changed rows, 108 returned rows, and
8 visits. The two decision units are individually 63/8 and 2/0 reads/changed
rows, within the per-unit 128-read/28-changed-row hard bounds; invocation-wide
reads are not compared to the per-decision cap. The first acknowledgement is
deferred, and the second candidate is not due in that invocation. The following
production timer and fake transports still prove zero egress while paused,
then one unlove per same remote after resume and zero on rerun.

The large 100/1k/10k production-reclaimer fixture now gives every historical
binding a matching released generation-1 recipient row, advances the linked
account to generation 2, and keeps one exact current-generation recipient
live. The reclaimer retains that binding through history cleanup, then deletes
it only after the current-generation recipient releases. This exercises the
matching old-generation dependency history that was absent from the earlier
fixture; production query plans and read/return/VM growth bounds remain flat,
with the deliberately unbounded scan/sort controls still failing their plan
oracle.

Restore failure injection now snapshots all eight L2 tables from both the
readable live DB and backup and compares their complete rows after an injected
failure at the real CLI `merged` stage (after B2/L2 merge and before file swap).
This is rollback/atomicity coverage using seeded rows; it does not replace the
producer-derived restore and dispatch scenario. The unreadable-live
`--accept-loss` case now seeds all eight L2 tables for restore-cascade
verification: revocation cascades recipient/member/window/decision rows,
bounded reclaim deletes the orphan binding, and the unexpired verified fact,
intent epoch, and allocator frontiers remain intact. The retained-fact Node integration now creates a
full 16-row alias page through real API admissions, cancels those unsent
operations through the production cancellation path, closes/reopens the actual
Node DB, and proves a new session rescans the full page rather than trusting
the persisted old cursor. It then continues the active-alias veto and
producer-backed handoff assertions.

## Current post-audit verification (2026-11-11)

The seven findings and repair direction were accepted by Sol; the implementation awaits fresh source acceptance. The exact source-only `git diff cdb78de..b2aa525 -- worker/src` SHA-256 is `6c2177fb05a370d66a6ff1ab5caae761e9074f381eac78f2f68aa02980f6e872` (7 files, 904 insertions, 125 deletions). The backfill correction is included. No schema, DDL, or budget change occurred in that source delta; the frozen57 hash remains `54dc2d344097763e055b0f8f7f10d8f85993ccdaf0e31620b699726c35256a96`.

Current scoped reruns passed: core/retention accounting 48/48 Node tests and 19/19 worker-bench tests; producer, handoff, module-boundary, backfill, and delayed-removal suites 96/96; producer-derived real CLI restore 25/25. Typecheck, scoped Biome (10 files), diff check, and secret-scan test passed. The eight-decision/eight-orphan actual scheduler bench acknowledges all eight and removes all eight orphan bindings over bounded invocations; each reported invocation is at most 96 changed rows and 16 visits, and one reaches 16 visits. The production reclaim over-visit control rolls back six fetched rows against a five-visit reservation. The decision amplification control rolls back the durable recipient/decision/outbox and all 40 injected row updates after exceeding 28 changed rows. Matching released-history query work remains flat at 100/1k/10k while the old-prefix negative control grows 1,294/12,094/120,094 SQLite VM steps.

The real schema-57 restore/transport evidence remains as previously recorded: production API admission, PDS SENT, signed absence, real CLI restore, fresh server/session, paused/revoked zero egress, same-remote resume, one delivery per remote, and zero-request rerun. The actual restored scheduler transaction table is retained above. No full repository gate or nested check-ts run was performed.

These reruns do not close the whole-decision acceptance matrix. In particular, actual cold/partial-delete/two-recipient and replay/refusal/completion/rejection/cleanup per-decision traces, a whole-decision production over-128-read control, full producer-batch combinations, schema-56 producer-derived restore, and fresh Astra review remain pending. The helper-level `assertLoveApiDecisionBudget(129, ...)` test is not counted as a whole-decision over-cap proof. The provisional 128 cap and its derivation remain unchanged; the preserved 229-read lifecycle trace remains informational wrong-unit evidence, not a decision-cap breach. The source delta above is sent for Sol's fresh review; no readiness or full-L2 acceptance is claimed.


## Actionable b2 review defects and current repair evidence

Sol reconciled Astra's b2aa525 review as actionable production defects and accepted the repair direction only. These changes await fresh source acceptance; they are not Sol-accepted repairs. The archived b2 source-only diff hash `6c2177fb05a370d66a6ff1ab5caae761e9074f381eac78f2f68aa02980f6e872` (7 files, 904 additions/125 deletions) is preserved as review provenance. The current uncommitted source delta against that head is SHA-256 `dda9ca32a4bc2e96b2896ec14157f6cc0cf19d3fafedf08b6b2a2cfec20f8643` (5 source files, 417 additions/33 deletions). Frozen migration57 proposal SHA-256 remains `54dc2d344097763e055b0f8f7f10d8f85993ccdaf0e31620b699726c35256a96`; no DDL or budget changed.

- R1: a decision now owns a single scheduler transaction, and the hard 128-read/28-changed-row check includes transaction-entry metering, actual materializer and callback SQL, coverage counters, phase accounting, and final `total_changes()` measurement before commit. The actual partial-removal branch passes at exactly 128 reads; the same real observed-Db probe at 129 throws before commit and preserves recipient/decision/outbox/authority/counter state. Lane and transaction reports both record 128 reads. Cold singleton initialization is separately reported with both meter reads inside its own transaction; the first cold invocation test asserts that row. Invocation 96 changed rows/16 visits and the 12-row metadata reserve remain independent.
- R2: owned sealed aggregates now page pending members with the registered recipient `validate_after_seq` cursor before awaiting. Exact current-generation, DID/URI/incarnation, operation binding, and outbox state are checked. Missing and failed members are removed; exact SENT members are promoted through the existing terminal-row consumer; exact queued members remain awaiting. The persisted selected-SENT plus missing-outbox case accepts once after bounded passes; a genuine queued member remains pending; exact SENT promotion accepts once; failed terminal state cannot create positive proof. Stale-generation cleanup still removes the aggregate and children through bounded sweep.
- R3: origin-binding reclamation no longer joins every same-incarnation decision and filters selected operation IDs afterwards. The production DELETE uses an indexed prefix `EXISTS ... LIMIT 1`, conservatively retaining any binding while any decision for that same incarnation remains; after the last decision is gone, ordinary bounded reclaim deletes the binding. Direct-SQL worker-bench applies the exact exported production SQL to 100/1k/10k matching old-generation decisions: current matching lookup is 35/35/35 VM steps, nonmatching is 48/48/48, while the archived old-query countercontrol is 1,687/16,087/160,087. These are execution-work counts, not timings or exact opcode pins. A separate bounded-maintenance test proves retention during dependency and eventual release.
- R4: direct absence preparation now returns the minimum of current evidence and the clean retained fact. That minimum is persisted on the decision before payload-mismatch refusal. The test with existing decision10,000/fact50/evidence500 at now30 returns50, refuses a mismatched payload while preserving its payload and clean fact, then proves a wider matching replay remains at50.
- R5: the real direct and delayed producers release a recipient only after the exact broad unlove has durable same-link/current-generation acceptance. The internal broad/narrow operation identities remain distinct, and source-excluded imported recipients still use the narrow path. A real signed API/PDS and fake-transport test covers love SENT before absence and absence before love SENT: each case sends one Last.fm `track.unlove` and one ListenBrainz score0, and rerun sends zero. The existing import-source exclusion and sibling-fact rollback controls remain passing.

Current targeted evidence after these changes: worker-bench core/accounting/growth 26/26; existing `loves.test.ts` 28/28; real fake-transport active broad producer 2/2; TypeScript project-reference typecheck passes. Previous failing R1–R4 archived probes remain untouched as historical red receipts; current positive and negative controls are tracked in worker-bench/Node tests. Scoped Biome and pre-push scans are still to be rerun for the complete checkpoint.

These repairs do not close the full L2 acceptance matrix. Whole-decision cold/partial-delete/two-recipient and all-outcome transaction rows, the over-128 production negative control at every required scenario, full producer-batch combinations, schema-56 producer-derived restore, complete CLI restore/rollback/accept-loss matrix, restored coverage/dispatch/resume, and fresh Astra source acceptance remain pending. The 229-read lifecycle receipt remains informational wrong-unit evidence, not a cap breach; the superseded +4/+4 API guess remains withdrawn. No readiness or full-L2 acceptance is claimed.

## Latest preserved producer-restore and repair rerun

The schema-57 restore integration starts with a signed PDS LOVE projection and records its original Last.fm import source through the production `admitForwardIdentity(path='import')` helper. It then invokes API `love.put` with a different request rkey and verifies that the successful operation reuses the projection URI. After exact SENT, signed absence, operation/outbox cleanup, and real CLI restore, only the Last.fm import-source recipient has a narrow L2 decision; the broad route covers ListenBrainz. Both recipient rows and their immutable origin binding survive cleanup/reopen. The fresh production timer defers while the Last.fm link is revoked and ListenBrainz forwarding is disabled, both transports observe zero requests, and the same-remote resume emits exactly one unlove for each service with a zero-request rerun. At that earlier checkpoint, the producer-derived schema-56 restore remained pending; its scoped completion is recorded below.

The restored decision transaction table changed with the added fact-minimum preparation and source-aware route. The actual rows are decision `69 reads / 12 changed rows / 1 visit` and the second decision `3 / 0 / 0`; both are under128/28. The complete cold invocation still totals135 reads across separate transactions and is informational at invocation scope, not compared against the per-decision bound. The 229-read lifecycle receipt remains preserved as wrong-unit informational evidence.

R5's earlier active broad+narrow duplicate receipt is superseded for current source by the real active signed-producer/fake-transport regression: both SENT-before-absence and absence-before-SENT send one Last.fm `track.unlove` and one ListenBrainz score0, then rerun sends zero. The restore scenario additionally proves exact broad coverage releases ListenBrainz while the original Last.fm import-source recipient stays narrow because broad routing excludes that source. This does not claim the remaining held/paused/B2-deferred/both-producer-order batch matrix is complete.

Latest scoped reruns: full `scripts/test/restore.test.ts` 25/25; worker-bench core/accounting/growth 26/26; `loves.test.ts` plus active transport 30/30. A bench harness path issue was corrected so the 100/1k/10k direct-SQL growth fixture locates repository source relative to its own file, independent of test runner cwd. These results are scoped progress only. The current b2 source delta remains SHA-256 `dda9ca32a4bc2e96b2896ec14157f6cc0cf19d3fafedf08b6b2a2cfec20f8643`; the current full-L2 gates and fresh source review remain pending.

The accounting matrix now also has independent cold-singleton boundary controls: with the singleton absent at invocation start, production initialization reports one changed row in its separate transaction, while the decision transaction commits at128 reads and a second fresh fixture with one extra observed Db read throws at129. The over-bound case preserves the sealed recipient, decision, outbox and lane-turn state; singleton initialization remains its separate committed phase. The real producer-derived restore table above is the current two-recipient scenario: both recipient rows are restored, with actual decision transactions69/12/1 and3/0/0 (reads/changed rows/visits). This does not yet provide the complete two-recipient outcome matrix or every-path over-cap control.

## Bounded sweep ownership correction

Sol's review found that `sweepOne` selected `validate_after_seq` from `love_api_recipients` itself and then treated row presence as decision ownership. The sweep now uses one exact aggregate-key `LEFT JOIN` to `love_api_unlove_decisions`, returning both the aggregate cursor and an actual decision-owner marker without adding another read. Ownerless sealed aggregates are eligible for bounded stale-member and aggregate cleanup only when no live window owner protects them. An actual decision owner continues bounded member validation; exact queued members still wait and only exact SENT can promote. Targeted worker-bench controls pass for ownerless current-generation absent cleanup through member/aggregate/binding/expired-fact reclamation, window-owner protection, owned stale-member progress, queued waiting, exact SENT promotion and stale-generation cleanup. No DDL or query/read/write budget changed. This is a scoped cleanup fix; broader L2 matrix and fresh R1–R5 source review remain pending.

## 2b source-repair checkpoint (fresh acceptance pending)

Astra's full report at `pr210-astra-core-2b84472.md` requested changes for five executable defects. Sol accepted the repair direction; source acceptance is still pending. The archived red receipts and probe manifest remain unchanged. This checkpoint starts from pushed HEAD `2b84472a68f2b1ae947e8c3ec1d2a2e2087dee2b`. The current scheduler/recipient source diff SHA-256 is `a65de59684e92a17508021f24f7783168fc5eb4c70c749a41705b3f6b1ea42ff` (117 additions/25 deletions across two source files). Migration57 remains frozen at `54dc2d344097763e055b0f8f7f10d8f85993ccdaf0e31620b699726c35256a96`; all budgets are unchanged.

- Generation-2 member validation derives the stored forward dedupe key through `storedForwardDedupeKey`, then separately validates the canonical binding operation against exact DID, URI, and incarnation. Queued/held members remain pending; exact SENT promotes through the existing actual-row settlement contract. Negative controls cover wrong stored key, outbox DID, binding DID, URI and incarnation, and a late SENT transition.
- Delayed preparation returns the horizon captured by the retained-fact write, including an earlier stored minimum. The shared sealer joins the exact retained fact and recipient decision, persists the minimum before any payload-mismatch refusal, and keeps the immutable envelope and clean fact. A fact50/window500/event500/existing decision10000 case at now30 remains at50 after refusal and wider replay.
- Sweep deletion keeps the17-row changed-row ceiling when deleting a full16-member page could cascade both decision and aggregate. The full page is drained first; the parent and decision finish on a later bounded visit. Expired and unexpired fact controls prove eventual cleanup without positive SENT claims.
- Broad candidate discovery starts from current `linked_accounts` and probes recipients by exact link/current generation plus DID/URI/incarnation before the exact decision lookup. The production full-schema plan and direct-SQL 100/1k/10k generation-history growth controls cover current hits, misses and incarnation mismatches; a deliberately old prefix query remains the growing negative control.
- Lane metadata now reserves the mandatory final turn before further units and avoids cycling an empty reclaim frontier. The actual unexpired-fact 15-member stale aggregate test verifies a successful lane-turn commit, total changed rows, visits and the12-row metadata reserve.

Scoped verification on this candidate: worker-bench scheduler/accounting suite47/47; archived independent 2b defect matrix19/19; production active transport plus love outbox tests30/30; current broad-query full-schema plan and growth tests pass as part of the scheduler suite; `npm run typecheck` passed after the final source and test edits. The exact-bound fixture now injects64 extra observed reads because the actual full production transaction baseline is64; it still commits at128, while the production129-read control rolls back. A restored obsolete scratch growth pair still uses the former seven-parameter query and failed against the current eight-parameter source; those temporary files were removed, their archived receipts were preserved, and the current tracked production-query plan/growth tests pass.

No new Astra source acceptance or full-L2 acceptance was claimed at the dfa repair checkpoint. The whole-decision scenario matrix, full CLI restore/rollback/accept-loss matrix, complete producer batch controls, and independent review remain pending. The schema56 producer-derived restore checkpoint is now recorded below. The provisional128 read cap and `96 + (25 - 13) + 20 = 128` derivation, 96 changed rows,16 visits,12 metadata reserve, DECISION28, and frozen DDL are unchanged. The preserved229-read cross-transaction lifecycle receipt remains informational and is not comparable to the per-decision cap.

## dfa retained-minimum repair checkpoint (fresh review pending)

Sol's reconciliation of Astra's full `pr210-astra-core-dfa1e73.md` confirms scoped closure for the 2b generation-key, sweep17, broad-growth and metadata-reserve findings; the earlier R1 final-128 boundary, R3 binding-delete growth, and R5 one-unlove-per-remote controls also pass. That review still requests changes for the retained-minimum contract family and the tracked restore count. The archived dfa red probes and manifest remain preserved. This repair starts from pushed HEAD `dfa1e73367ccb038623e33cf8d52a445f99ec5f2`. Current `love-api-recipients.ts` diff SHA-256 is `cd97158599a9edb1e5f2a6164a4308c3373185182ab176fc5ca7ee6602be2dcb` (286 additions/55 deletions). Migration57 stays frozen at `54dc2d344097763e055b0f8f7f10d8f85993ccdaf0e31620b699726c35256a96`; no schema or budget changes.

- Direct and delayed preparation now shortens an exact current recipient decision using the clean original authorization fact and any matching clean incoming fact before returning an expired/refused result. At horizons50 and now30/50/60 the decision stays50, the comparison fact stays clean, and no witness or unlove outbox effect appears. The update uses the already loaded exact current recipient/decision row; it adds no SELECT or broad history query.
- The shared sealer's single indexed query loads the incoming fact, exact decision and that decision's original authorization fact independently. For an existing decision it first persists min(existing expiry, clean original fact, matching clean incoming fact), before revision/payload refusal. A missing or conflicted original fact fails closed. It uses the computed persisted minimum for both new INSERT and replay UPDATE, so prepared data at500 cannot renew a subsequently shortened fact at50.
- Durable bench controls cover direct and delayed now30/50/60, old revision fact50 versus a different verified revision fact500, same-revision prepared object followed by fact shortening before insert/same/mismatch sealer paths, unrelated URI isolation, clean-fact/payload immutability, and missing-lookup/conflicted-original fail-closed controls. The missing lookup test injects a missing original-fact result at the exact production query boundary; the registered FK prevents creating a dangling decision through ordinary module SQL.
- The producer-derived schema57 restore receipt was stale only in decision read counts. The tracked test now attributes the production pre-unit metadata SELECT and expects70/4 reads; changed rows remain12/0 and visits1/0. Its per-decision128/28 assertions and real CLI/fake-systemd/fresh-composition/origin/op-GC/revoked-zero/resume transport assertions remain intact.

Current scoped evidence: full scheduler/accounting worker-bench60/60; direct+delayed/replay/original-fact focused controls12/12 (within that suite); Node lifecycle/handoff/module-boundary/outbox/active transport83/83; actual producer-derived restore case1/1; typecheck and scoped Biome pass. Existing measured decision bounds remain unchanged. The archived dfa defect probe showed five prior retained-minimum failures before this repair; its red receipt is preserved. These current controls are not fresh Astra source acceptance.

The later schema-56 producer-derived restore test/docs checkpoint is recorded below. Full CLI restore/rollback/accept-loss coverage remains queued. Fresh Astra review `pr210-astra-core-333e8ae.md` reports the earlier dfa A/B/C and tracked restore count as passing, while requesting the direct/window/event early-expiry and sibling batch-minimum repairs recorded next. No readiness or whole-L2 acceptance is claimed. The 128-read cap and derivation `96 + (25 - 13) + 20 = 128`, 96 changed rows,16 visits, reserve12, DECISION28, SWEEP17 and RECLAIM8 remain unchanged. The prior 229-read lifecycle receipt remains informational wrong-unit evidence.

## Schema-56 producer-derived restore checkpoint

The scoped restore case now creates its pre-L2 database by extracting exact
READY #209 source `5d573706bf07bb50e0c8b79cf1d34a3f6c56a975` with `git
archive` into a temporary directory and running a generated test through that
archive's Node harness. The parent producer performs an actual API love
admission, sends it through the fake PDS, verifies and projects the signed
record, then imports a separate snapshot and performs an API acceptance that
reuses that projection without another PDS request. The captured DB reports
schema56, has no `love_api_*` tables, and contains both succeeded operation
rows plus the imported-source projection. No L2 rows are seeded.

The captured file is copied as both backup and stopped live state and passed
through the real restore CLI. The CLI reports 56→57, checks all eight L2 tables
empty, and starts a fresh current server composition. Both pre-upgrade API
operation IDs remain absent from `love_api_bindings`; old API SENT and old
reuse state do not gain authority during migration. The current production
PDS helper then accepts a new API operation against a legacy imported
projection at the same URI with a different request rkey. The test verifies
the current binding origin, both recipient identities and generations, exact
SENT love rows and payloads, signed PDS absence, retained delete fact and
decision source. The original Last.fm import exclusion leaves its narrow
recipient while broad acceptance covers ListenBrainz. Revoked/paused links
produce zero egress; resuming the same remotes through the fresh server timer
produces exactly one Last.fm unlove and one ListenBrainz score-zero delivery,
then a zero-request rerun. Foreign-key checks run after the current server
closes.

The selected schema56 case and the existing schema57 producer-derived restore
case both passed together (2/2) with one worker on CPUs8–11. This checkpoint
adds test code and this evidence only: production runtime, migration57, and
migrations1–56 are unchanged from `333e8ae`. It does not close the queued
whole-decision outcome/cost matrix, producer-batch matrix, or full restore
acceptance matrix, and it makes no readiness or whole-L2 claim. Project
typecheck, scoped Biome, `git diff --check`, the secret-scan test, and a
credential-shaped scan of added lines also passed; the scan reported no
matches. The test-only source delta was checked against `worker/src` and
`worker/migrations`, with no changes in either tree.

## Astra 333 retained-minimum repair checkpoint (fresh review pending)

The independently pinned `pr210-astra-core-333e8ae.md` review closed the
earlier dfa preparation/sealer minimum defects and the tracked restore-count
regression, with the scoped budget, generation, cascade, metadata, growth and
source-exclusion controls still passing. It identified two remaining source
obligations. Direct evidence expiry, and exact delayed-window/event expiry,
now persist a minimum derived from the exact accepted decision and its clean
original fact before refusal. Wrong identity or owner fences still return
without updating an unrelated decision; expired inputs return no prepared
proof and create no B2 authority, witness, or unlove outbox effect.

The shared sealer now preflights all exact recipient decisions before a
batch-wide refusal. Each recipient minimum is persisted before returning for
a sibling payload mismatch, while immutable envelope fields, fact state, and
handoff state remain unchanged. The test matrix covers each position in a
two-recipient batch, reversed order, a matching-batch control, and rollback
through the caller-owned transaction. Exact source-expiry controls cover
direct evidence, delayed window, and delayed event at the expired boundary.
The full scoped `astra-core-cdb.bench.test.ts` suite passed69/69; the focused
Node recipient lifecycle/handoff suites passed51/51; the two producer-derived
restore cases passed2/2. Project typecheck, scoped Biome, and the secret-scan
test passed. A sanitized credential-shaped added-line scan returned no
matches.
The archived pre-fix red receipt remains at
`/tmp/pr210-655be27-astra333-repro.log`; its five failures are historical
evidence and are not described as current failures. The source and targeted
regressions are now pending fresh independent review; they do not establish
that upstream callers reach every seam or close the full producer-batch
matrix.

Schema57 remains frozen at SHA-256
`54dc2d344097763e055b0f8f7f10d8f85993ccdaf0e31620b699726c35256a96`, and
migrations1–56 remain byte-identical. The read128, changed-row96, visits16,
reserve12, DECISION28, SWEEP17 and RECLAIM8 limits are unchanged. Whole-decision
scenario/cost acceptance, over-128 production control, complete producer
batching, and the broader CLI restore/rollback/accept-loss matrix remain
pending. This is a scoped repair checkpoint, not readiness or whole-L2
acceptance.

## Whole-decision matrix checkpoint (test/doc only)

The matrix was initially measured on pushed production source `8717d349e918edafd6f825383df9622ccabfb18e`. Sol's direct-expiry fix `8a406a2bf7b6e20ed82b73ddf1ff5e570ffc1b9a` was normally forward-merged as `c2172d5ffa9783f6bd4d7c6885204a4dd1c6eeb8`; the merged production and migration trees compare byte-for-byte to that accepted source (recipient module SHA-256 `ea26de81e4439d48d5dfce3e7aa661fb99dd6b58f139db173b026d1089c83622`). The matrix and scoped suites were rerun on the merged candidate. The direct-expiry fix has narrow Astra acceptance: 7 tracked and 19 independent controls passed; two expected-null-argument mutation controls failed as intended. This is a scoped source acceptance receipt, not GitHub approval or whole-L2 review. The decision cap remains the provisional `96 + (25 - 13) + 20 = 128` read derivation. The 20 reads are integration slack, not a measured whole-path proof. Writes96, visits16, reserve12, per-decision changed rows28, and frozen migration57 remain unchanged.

The production `l2-decision` transaction table below includes its own meter and finalization SQL. Each row is one scheduler-owned decision transaction; the cold singleton initialization is a separate transaction. Values are reads / mutation statements / changed rows / returned rows / visits / acknowledgement.

| Scenario | Actual transaction path | Cost | Result and fixture provenance |
| --- | --- | ---: | --- |
| active queued | `runLoveApiMaintenance` | 64 / 13 / 12 / 27 / 1 | queued; semantic proof state arranged by direct SQL |
| paused deferred, retained fact after A2 cleanup | `runLoveApiMaintenance` | 69 / 17 / 14 / 30 / 1 | deferred; event insert/delete is direct-SQL cleanup setup, not a claimed A2 caller run |
| cold paused deferred | singleton init, then decision | 2 / 1 / 1 / 2 / 0; then 69 / 17 / 14 / 30 / 1 | deferred; actual cold initialization separately metered |
| terminal replay | `runLoveApiMaintenance` | 34 / 3 / 3 / 22 / 1 | replay; adapter creates the exact effect and fixture marks it terminal |
| malformed envelope refused | `runLoveApiMaintenance` | 14 / 3 / 3 / 14 / 1 | refused; direct-SQL corruption fixture |
| expired fact | `runLoveApiMaintenance` | 13 / 3 / 3 / 13 / 1 | expired; direct-SQL expiry fixture |
| conflicted fact refused | `runLoveApiMaintenance` | 13 / 3 / 3 / 13 / 1 | refused; direct-SQL conflict fixture |
| stale generation refused | `runLoveApiMaintenance` | 13 / 3 / 3 / 13 / 1 | refused; direct-SQL generation fixture |
| newer incarnation refused | `runLoveApiMaintenance` | 18 / 3 / 3 / 15 / 1 | refused; direct-SQL incarnation fixture |
| newer re-love veto | `runLoveApiMaintenance` | 17 / 3 / 3 / 15 / 1 | refused; direct-SQL canonical love fixture |
| active love.put awaiting | `runLoveApiMaintenance` | 13 / 1 / 1 / 13 / 1 | awaiting; direct-SQL operation fixture |
| retained-fact lookup fault control | `runLoveApiMaintenance` | 13 / 3 / 3 / 12 / 1 | refused; query is executed then fault-injected as missing |
| alias page session A, first page | `runLoveApiMaintenance` | 19 / 3 / 3 / 30 / 1 | awaiting; direct-SQL aliases |
| alias epoch reset, session A | `runLoveApiMaintenance` | 19 / 3 / 3 / 30 / 1 | awaiting; direct-SQL epoch bump |
| alias fresh session B, first page | `runLoveApiMaintenance` | 19 / 3 / 3 / 30 / 1 | awaiting; new session invalidates cursor |
| alias session B, completion page | `runLoveApiMaintenance` | 71 / 17 / 14 / 32 / 1 | deferred; bounded page completion |
| delayed partial-delete producer path | actual Node producer, pending-removal executor and signed B2 settlement, then `runLoveApiMaintenance` | 60 / 13 / 12 / 32 / 1 | queued; producer/source/authorization transaction is separately 16 reads / 14 mutation statements / 12 changes / 12 returned rows |
| selected SENT before late proof | scheduler pass before settlement | 11 / 1 / 1 / 11 / 1 | awaiting; exact queued/held members also remain awaiting |
| late selected SENT after settlement | real `settleRowsReturning`, then scheduler | 69 / 17 / 14 / 30 / 1 | deferred; settlement transaction is separate |

Every populated decision row is asserted against the production transaction report at reads<=128, changedRows<=28, and one visit; the full maintenance report separately asserts writes<=96, visits<=16, and metadata reserve<=12. The exact-bound real partial-delete decision commits at128 reads. The production observed-Db 129th-SELECT control throws and rolls the decision, outbox/effect, and counters back. A new observed-Db injection adds exactly15 changed rows to a 14-row deferred decision; it reaches29, throws, and rolls back the recipient release, decision effects, injected rows, outbox and coverage counter. The actual reclaim-page local overvisit control remains: six rows against a five-visit reservation roll back. A separate multi-phase database-backed invocation reaches ten committed visit rows, then injects seven valid reclaim rows against a six-row reservation, proving17 attempted visits and rollback of the owned reclaim transaction while earlier phase changes/counters remain durable. This hits the production per-page preguard before the shared 16-visit assertion; therefore this proves the outer-bound scenario is refused, but does not independently demonstrate mutation of only the shared assertion.

Additional production paths are recorded by transaction rather than charged to the decision cap: source-excluded broad/narrow enqueue in both orders measured broad `21/10/9` and recipient `38/5/5` (reads/mutation statements/changed rows) in one order, and broad `18/5/5` and recipient `41/10/9` in reverse order; broad acceptance measured `21/10/9` and covered-recipient release `2/2/2` (reads/mutation statements/changed rows). These are enqueue/release transactions, not L2 decisions. Generation-2 queued/held awaiting measured `11/1/1/11/1`; failed-member refusal measured `13/3/3/13/1`. The actual delayed partial-delete producer test proves enqueue and signed settlement provenance; the separate matrix replay and terminal arrangements are test fixtures.

The preserved cross-transaction lifecycle receipt `229 reads / 105 mutation statements / 87 changed rows / 110 returned rows / 1 visit / 1 deferred` remains informational wrong-unit evidence; it is not compared with the per-decision cap. The earlier +4/+4 API-path guess remains superseded by the measured N0/N1/N2 bounds documented above.

Merged-source scoped verification before this test-only matrix delta: worker-bench suite78/78; Node handoff/removal/love producer suites89/89; full restore suite26/26; project typecheck, scoped Biome, diff check and secret-scan test passed. For this delta, the complete three-file Node set passed87/87, local-index passed5/5, and the whole Astra CDB bench file passed78/78. The sanitized credential-shaped added-line scan must be repeated before push. This is a scoped whole-decision matrix checkpoint, not a complete L2 caller or lifecycle matrix. Still pending are the multiple-operation producer-batch combinations (mixed sent/pending/ignored/failed/cancelled siblings, early/late SENT, batch-pin rollback and all refusal/source-order variants), additional caller-derived cold/partial-delete/two-recipient outcome combinations, and any remaining restore/journal cases after reconciling the full26/26 restore suite against the plan. Fresh independent whole-L2 review remains pending. The direct-expiry narrow Astra acceptance covers only that residual. No full-L2 acceptance or readiness is claimed.
