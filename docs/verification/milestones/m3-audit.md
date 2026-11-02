# M3 issue-by-issue evidence record

**Scope:** M3 milestone/coordination issues #11–#15 and M3 leaf issues #62–#73 only. **M7 is explicitly excluded.** This is a read-only audit record: issue status is preserved as open; no production/test code or GitHub state was changed. The current working tree was already dirty and must not be described as clean.

## Evidence basis and limits

This record is based on `/tmp/goal-audit-M3.md` and the referenced repository documentation, inspected for clarification. No test, build, live request, GitHub command, or other execution was performed for this record. Prior execution receipts below are reported only as recorded; they are local dirty-tree evidence, not hosted CI, a release artifact, or live-PDS acceptance. Do not rerun build-producing commands as part of this evidence record.

The audit source reports the final `bash scripts/check-ts.sh` receipt as **exit 0; 904 passed, 224 files, 0 failed/skipped/todo**, all nine gate steps passed. That run was on a dirty tree based on recorded base SHA `29453f8e8763083a3e3d7b10d5090285ef2f9d63`; the SHA is not the dirty worktree's release identity. The scoped Node recovery receipt was `npx tsx scripts/acceptance/node-recovery.ts --out work/verification/implementation-agent-13/node-recovery-final`: **exit 0; one required journey executed/passed**, with scope `node-subprocess-recovery-only` and `dirty: true`. The audit record says neither receipt establishes hosted CI, release provenance, official Node/SQLite 3.54.0 execution, browser acceptance, or live external-PDS behavior. Counts from overlapping focused test runs are not additive.

Primary evidence and context paths:

- `docs/verification/implementation-agent-13.md` — local execution ledger and scope/limitations.
- `docs/verification/scrobble-fixtures.md` — historical Axum/Rust fixture description and commands; not current Node acceptance instructions.
- `docs/verification/scrobble-live.md` — live scrobble status, required observations, and explicit blocked state.
- `docs/verification/ts-case-map.json` — named M3 cases and current/legacy target mapping. It maps some cases to Rust-era or browser targets and calls out the missing `scripts/e2e/scrobbler-e2e.ts` target for `live_retries`.
- `docs/MILESTONE_STATUS.md` — explicitly labels its old Workers receipt historical, not current Node acceptance.
- Implementation paths cited by the audit: `worker/src/http/writes.ts`, `worker/src/http/scrobbles-read.ts`, `worker/src/outbox/scrobble-ops.ts`, `worker/src/outbox/delete-ops.ts`, `worker/src/outbox/runner.ts`.
- Test paths cited by the audit: `worker/test/node/http/writes.test.ts`, `worker/test/node/outbox/retry.test.ts`, `worker/test/node/outbox/recovery.test.ts`, `worker/test/node/outbox/delete.test.ts`, `worker/test/acceptance/read-model-acceptance.test.ts`, `scripts/test/node-recovery.test.ts`.

## Issue records

Each record separates (1) deterministic behavior tested, (2) remaining deterministic gap, (3) live/operator blocker, and (4) contract/documentation drift. “No specific gap identified” is limited to the named cases in the audited scope; it is not a closure or complete-contract claim.

### #11 — M3 milestone

- **Deterministic behavior tested:** Local create, retry, history, delete, and recovery portions have fixture and subprocess coverage; detailed leaf evidence is recorded under #62–#73. The reported dirty-tree TypeScript gate is 904 passing tests across 224 files, with no skips, failures, or todos.
- **Remaining deterministic gap:** Parent closure requires every child and inherited gate. Current Node tests now cover local-delete hiding during queued/running/blocked/failed states, a PDS-acknowledged delete hidden until signed absence proof, and persistence of that visibility across a child-process SIGKILL/restart; an end-to-end terminal PDS failure/status journey also exists. The full GitHub M3.4.2 matrix, Rust/Node contract reconciliation, and browser/live gates remain outstanding.
- **Operator/live blocker:** No recorded external-PDS lifecycle evidence for create, retry, history, delete, and interrupted-write recovery. The live gate remains unperformed.
- **Contract/doc drift:** The milestone issue remains open and retains the original Rust-era acceptance protocol, while the current implementation/evidence is Node-based. `docs/verification/scrobble-fixtures.md` is also Rust/Axum-oriented.

### #12 — M3.1 coordination

- **Deterministic behavior tested:** Node write admission and public history/cursor behavior have substantial test coverage; see #62–#64.
- **Remaining deterministic gap:** The shared Node read model now hides queued/running/blocked/failed local delete intents; the complete deletion lifecycle and published-contract reconciliation remain.
- **Operator/live blocker:** Live gate is inherited from the parent milestone; fixture coverage is not live PDS evidence.
- **Contract/doc drift:** Coordination body retains Rust file ownership and original acceptance wording; current implementation is Node.

### #13 — M3.2 coordination

- **Deterministic behavior tested:** Durable operations, bounded retry, DPoP-authorized writes, and ambiguous-create reconciliation are covered by Node tests; see #65–#67.
- **Remaining deterministic gap:** No specific M3.2 deterministic defect was found in reviewed scope. Closure nevertheless depends on the complete parent contract.
- **Operator/live blocker:** Fixture PDS tests do not establish live PDS interoperability.
- **Contract/doc drift:** GitHub names Rust-owned files while current implementation/evidence is Node-based.

### #14 — M3.3 coordination

- **Deterministic behavior tested:** Delete ordering, retries/reconciliation, externally verified deletions, and read-model removal after verified deletion are covered; see #68–#70.
- **Remaining deterministic gap:** The shared Node overlay covers queued/running/blocked/failed intents and a succeeded delete whose persisted swap CID still matches the projected CID. A packaged-process regression now holds absence proof across SIGKILL/restart and verifies proof-confirmed removal; a separate HTTP fixture test drives a terminal PDS failure and checks hidden public reads plus visible owner failure. Other fault combinations and the full issue-contract matrix remain.
- **Operator/live blocker:** External erasure is out of scope; live confirmation on the owner's PDS has not been performed.
- **Contract/doc drift:** Coordination requires tombstones and immediate filtering. The new read overlay implements pending/failed public hiding while retaining verified/indexed state; reconcile exact state/status and recovery semantics with the published contract.

### #15 — M3.4 coordination

- **Deterministic behavior tested:** Fixture lifecycle and process-restart tests exist. The scoped Node recovery runner records one required recovery journey.
- **Remaining deterministic gap:** The deterministic child journey now establishes persistence of the delete visibility overlay across an acknowledged-delete/proof-in-flight SIGKILL, followed by proof-confirmed absence. It remains a narrow local fixture journey, not the full M3.4.2 fault matrix or live acceptance.
- **Operator/live blocker:** Live run is blocked; no packaged, public-origin external-PDS evidence is recorded.
- **Contract/doc drift:** `docs/verification/scrobble-fixtures.md` describes Axum/Rust fixtures and Rust commands, whereas current evidence is Node-based.

### #62 — Admission and idempotency

- **Deterministic behavior tested:** `POST /api/v1/scrobbles` checks authentication/CSRF and idempotency-key validity, validates before admission, scopes idempotency by DID, returns the original operation for a matching retry, and conflicts on changed payload. Tests cover invalid inputs, retries, cross-DID keys, and repeated successful requests (`worker/test/node/http/writes.test.ts`).
- **Remaining deterministic gap:** No significant deterministic gap was identified for the named cases in current Node API scope. This does not prove live publication.
- **Operator/live blocker:** No issue-specific live blocker beyond the inherited live gate.
- **Contract/doc drift:** Issue specifies Rust paths and exact `400/409/422` behavior; implementation is Node and uses the v1.2 write contract. Reconciliation is not recorded.

### #63 — Public history and lookup

- **Deterministic behavior tested:** Tests cover expected ordering/traversal, limits, lookup, and absent-record behavior. Read routes return indexed records; `worker/src/http/scrobbles-read.ts` documents DTO and pagination behavior. `worker/test/acceptance/read-model-acceptance.test.ts` covers read-model behavior.
- **Remaining deterministic gap:** A durable local delete intent hides matching public read paths before remote proof; the #63 issue contract and all cursor/lifecycle semantics still require reconciliation.
- **Operator/live blocker:** No separate blocker identified beyond live lifecycle evidence.
- **Contract/doc drift:** Issue is Rust-owned and references the fixed shared contract; current API behavior is documented in Node source/docs.

### #64 — Opaque cursors

- **Deterministic behavior tested:** HMAC-bound cursors, tamper/version/binding rejection, and mutation semantics are tested. `worker/test/acceptance/read-model-acceptance.test.ts` covers insert/delete between pages and cursor reuse; restart coverage continues a pre-restart cursor.
- **Remaining deterministic gap:** No specific cursor gap was found in the reviewed M3 scope.
- **Operator/live blocker:** None specific identified.
- **Contract/doc drift:** GitHub Rust source ownership differs from Node implementation; fixture documentation is not current Node acceptance instruction.

### #65 — Durable outbox and operation status

- **Deterministic behavior tested:** Node outbox and HTTP tests cover operation admission, persisted identity, status ownership, restart, and recovery. Scrobble record identity/digest are persisted before the PDS attempt.
- **Remaining deterministic gap:** No named-case gap identified. Operation status must not be interpreted as remote confirmation.
- **Operator/live blocker:** Live PDS confirmation remains unproven.
- **Contract/doc drift:** GitHub's Rust ownership and response contract have not been explicitly reconciled with the Node API.

### #66 — Retry and DPoP writes

- **Deterministic behavior tested:** `worker/test/node/outbox/retry.test.ts` covers retry schedule, `Retry-After`, ten-attempt limit, terminal errors, interruption of the tenth attempt, and DPoP-authorized fixture writes.
- **Remaining deterministic gap:** No specific deterministic gap identified for the issue's named cases.
- **Operator/live blocker:** Fixture authorization does not prove interoperability with a live PDS.
- **Contract/doc drift:** GitHub names Rust files; current behavior is implemented/tested in Node outbox code.

### #67 — Ambiguous creates

- **Deterministic behavior tested:** `worker/test/node/outbox/recovery.test.ts` covers crash after remote commit, matching and conflicting remote records, and restart with one persisted rkey. Current-process recovery also kills a child after fixture-PDS commit.
- **Remaining deterministic gap:** Live equivalence and release-bound recovery remain untested.
- **Operator/live blocker:** No live PDS run or release-bound evidence.
- **Contract/doc drift:** GitHub's Rust test target is not current evidence target; `docs/verification/scrobble-fixtures.md` still gives Rust/Axum commands.

### #68 — Owner deletion and tombstone

- **Deterministic behavior tested:** Owner-bound delete admission, no remote write for another owner's URI, pending-create cancellation, and delete chaining are tested.
- **Remaining deterministic gap:** Shared Node reads hide queued/running/blocked/failed delete operations and keep an acknowledged delete hidden only while the projected CID matches its persisted swap CID. The new end-to-end fixture HTTP test verifies terminal PDS failure status while public reads remain hidden and remote/projection records remain present; the packaged child test verifies the acknowledged overlay survives restart until proof. Issue #68's wrong-owner contract requires **403**, while current Node contract/tests return **404**; see the [review-only contract proposal](m3-issue-68-contract-proposal.md) for owner reconciliation.
- **Operator/live blocker:** Live deletion has not been observed.
- **Contract/doc drift:** Issue requires a 403 and atomic tombstone. Current Node follows ADR 0005's 404 privacy contract and uses a CID-scoped query-time overlay without claiming remote absence. The owner must reconcile the GitHub issue status expectation with the ADR; see the review-only proposal. No implementation change is made pending that decision.

### #69 — Delete idempotency and races

- **Deterministic behavior tested:** Delete waits behind unsettled creates, uses `swapRecord`, reconciles `RecordNotFound`/changed CID, and retries durably. Node tests cover races, restart, and reconciliation paths.
- **Remaining deterministic gap:** The subprocess now verifies the succeeded delete's projected CID stays hidden while absence proof is held across SIGKILL/restart; the full M3.4.2 interruption/retry matrix and live PDS recovery remain unproven.
- **Operator/live blocker:** No live owner-PDS delete/restart evidence.
- **Contract/doc drift:** Issue's “local tombstone throughout” acceptance is not met by current visibility behavior.

### #70 — Deletion propagation and status

- **Deterministic behavior tested:** Verified external deletion removes records from reads and aggregate views; confirmed local deletion reconciliation is covered. The audited dirty-tree change in `worker/src/outbox/runner.ts` clears only matching successful-create payload/digest after confirmed deletion while retaining receipt identity and dedupe metadata. `worker/test/node/outbox/delete.test.ts` checks that failed deletion retains payload and successful deletion preserves receipt/dedupe identity across restart.
- **Remaining deterministic gap:** The end-to-end HTTP fixture test now injects a terminal fake-PDS 400, confirms the owner operation reports `failed`, and confirms feed/history/lookup/stats hide the record while the fake-PDS record and verified `record_state=present` remain. This does not constitute a general retention/erasure policy; full live acceptance remains.
- **Operator/live blocker:** Independent federation erasure is out of scope; live PDS absence is not recorded.
- **Contract/doc drift:** GitHub requires minimal status after confirmation and owner-visible failure with local hiding. Current tests prove retention/minimization mechanics, not complete visibility semantics.

### #71 — Deterministic HTTP lifecycle

- **Deterministic behavior tested:** Node HTTP tests cover admission, idempotency, owner-bound operation status, delete admission, and operation results. The scrobbler journey exercises a fixture-PDS write and verified indexing; read-model tests cover history/lookup.
- **Remaining deterministic gap:** Coverage is distributed across Node suites rather than the issue's specified single Rust lifecycle target. Complete reconciliation with the issue contract is not claimed.
- **Operator/live blocker:** No separate live-acceptance evidence is established here; deterministic fixtures cannot substitute for #73.
- **Contract/doc drift:** `docs/verification/scrobble-fixtures.md` says “actual Axum router,” gives Rust commands, and names Rust-owned targets; these are stale for current Node evidence.

### #72 — Fault, restart, and pagination

- **Deterministic behavior tested:** `scripts/test/node-recovery.test.ts` exercises actual Node child processes and SIGKILL around fixture-PDS create/delete commits; read-model tests exercise cursor mutation. Scoped runner records one required recovery journey.
- **Remaining deterministic gap:** The process test now proves immediate public hiding after remote acknowledgement and persistence through SIGKILL/restart until absence proof, but is not the complete named M3.4.2 suite contracted by GitHub.
- **Operator/live blocker:** No packaged live-PDS recovery run.
- **Contract/doc drift:** GitHub specifies a Rust child-server target; current work uses a Node bundle/fixture host. Fixture docs do not describe that as their primary evidence.

### #73 — Live lifecycle evidence

- **Deterministic behavior tested:** Deterministic fixture evidence and a blocked-status runbook exist. `docs/verification/scrobble-live.md` says “blocked; no live test executed.”
- **Remaining deterministic gap:** No live case passed; `live_retries` is a missing target in the case map, and the checkout has no current Node live scrobbler harness that closes the contract. The runbook's helper is partial and does not cover live process-failure recovery.
- **Operator/live blocker:** Blocked by absent dedicated external identity, public HTTPS OAuth origin, owned publication namespace, live PDS access, and sanitized artifact/commit-bound evidence. Required create/read, interrupted-write retry/recovery, and delete observations are not recorded.
- **Contract/doc drift:** GitHub requires a packaged server and live observation. `docs/verification/scrobble-live.md` documents a partial helper, explicitly says no live test executed, and requires dated sanitized observations tied to the artifact and commit. The audit source notes the missing current-Node live harness/case-map target.

## Overall disposition

All **17 issues** in this record remain open; no status change is proposed or made. M3 has broad deterministic Node implementation coverage but does not satisfy its complete contract. Queued/failed delete hiding, end-to-end terminal remote-failure reporting without false remote-absence claims, and acknowledged-delete visibility through a child-process restart until proof are now covered locally. The #68 wrong-owner 403-versus-404 conflict awaits owner reconciliation, the full issue fault matrix and Rust-versus-Node contract reconciliation remain, and #73's live external-PDS run is not performed. Local dirty-tree test receipts are not release or hosted-CI evidence. M7 is outside this record.

## Node-host documentation and verification addendum — 2026-10-28

`docs/verification/scrobble-fixtures.md` labels its Axum/Rust suite and commands as historical and documents the current Node host's exact fixture suites, scope, and evidence limits. At the time of this original addendum, pending/failed local deletes were not hidden; the subsequent deterministic Node follow-up below implements a query-time read overlay without mutating verified projection state. The owner's mismatch to the issue's 403 remains unresolved against the accepted 404 privacy contract.

Fresh focused local runs on the already dirty tree:

| Command | Result |
| --- | --- |
| `npx vitest run --project worker-node worker/test/node/http/writes.test.ts worker/test/node/outbox/retry.test.ts worker/test/node/outbox/recovery.test.ts worker/test/node/outbox/delete.test.ts` | **PASS**, 4 files / 26 tests. |
| `npx vitest run --project worker-acceptance worker/test/acceptance/read-model-acceptance.test.ts worker/test/acceptance/restart.test.ts` | **PASS**, 2 files / 8 tests. |
| `npx vitest run --project scripts scripts/test/node-recovery.test.ts` | **PASS**, 1 file / 1 child-process recovery test. |
| `bash scripts/check-ts.sh` | **PASS**, 224 files / 908 tests, zero failures/skips/todos; typecheck, lint, tests, contracts, case map, case-map regression suite, production bundle guard, Node build check, and Node bundle guard all passed. |

The full gate built/checked Node artifacts against base SHA `29453f8e8763083a3e3d7b10d5090285ef2f9d63`; the checkout still contained uncommitted and untracked changes, so the run is dirty-tree local evidence only. The emitted candidate bundle hashes do not establish an approved release or hosted CI. The fixture tests are in-process/out-of-process local fixtures, not a real PDS, live relay, public origin, or deployed server. The current live-helper gap and blocked production preflight remain unchanged.

## Query-time local-delete visibility follow-up — 2026-10-28

The baseline gaps above are partially addressed in the current dirty tree. `worker/src/do/read/visibility.ts::visibleScrobblesFrom` excludes a scrobble while a matching `scrobble.delete` operation is `queued`, `running`, `blocked`, or `failed`. Shared readers that compose this predicate now hide the row from feed, history, lookup, statistics/range statistics, and other indexed views without deleting or falsifying the verified projection or `record_state`. `worker/src/outbox/delete-ops.ts::enqueueScrobbleDelete` bumps the owner's `stats_version` in the same transaction as durable admission; `worker/src/outbox/operations.ts::cancelUnsent` bumps it when an unsent delete is canceled, so cached statistics are invalidated on both transitions. The API continues to expose the operation's failure independently from verified remote absence.

The deterministic read regression seeds the delete operation in SQLite, checks queued/running/blocked/failed visibility through global feed/history/lookup plus cached statistics, then cancels it and checks visibility/cache recovery. The status transitions in that read test are direct fixture SQL; this is not an end-to-end HTTP delete followed by an injected PDS failure. A separate outbox test verifies the production enqueue and cancellation helpers each bump `stats_version`. `worker/test/read/feed.test.ts` is declared in workers W3-01; the outbox regression is declared in Node wave N2-05. `docs/verification/ts-case-map.json` now maps M3.3.1/hide_immediately to the read regression and retains the historical A13 web overlay as supporting context. `docs/storage.md` and this audit distinguish query-time visibility from verified projection state.

This is deliberately scoped: states that have transitioned to `succeeded` are no longer hidden by this predicate while Jetstream/proof verification may still be pending. Persistent visibility from acknowledgement through verified absence, the full restart/fault matrix, end-to-end terminal failure/status behavior, and the #68 wrong-owner 403-vs-404 contract remain open; no GitHub issue or milestone was changed.

Fresh dirty-tree focused receipts after this follow-up:

| Command | Result |
| --- | --- |
| `npx vitest run --project worker-modules worker/test/read/feed.test.ts worker/test/read/history.test.ts worker/test/read/stats.test.ts` | **PASS**, 3 files / 17 tests. |
| `npx vitest run --project worker-node worker/test/node/outbox/delete.test.ts worker/test/node/outbox/recovery.test.ts worker/test/node/http/writes.test.ts` | **PASS**, 3 files / 21 tests. |
| `npx vitest run --project scripts scripts/test/node-interim.test.ts` | **PASS**, 1 file / 1 test; wave-0 pending-target expectation now reflects 75 target references / 65 cases. |
| `python3 -B scripts/test_validate_case_map.py` | **PASS**, 16 regression tests. |
| `python3 -B scripts/validate_case_map.py --check-tests --node-wave 4` | **PASS**, 258 unique cases; two later-wave targets pending. |
| `python3 -B scripts/validate_plan.py` | **PASS**, 7 milestones / 121 issues / 86 leaves / 258 test specifications. |
| `npx biome check worker/src/do/read/visibility.ts worker/src/outbox/delete-ops.ts worker/src/outbox/operations.ts worker/test/read/feed.test.ts worker/test/node/outbox/delete.test.ts scripts/test_validate_case_map.py scripts/test/node-interim.test.ts` | **PASS**, no fixes required. |
| `git diff --check` | **PASS**. |

All of these are local dirty-tree evidence. They do not change the live, hosted-CI, release, and issue-state limitations above.

## M3 delete-lifecycle follow-up — current Node evidence

This section supersedes the narrower baseline/addendum statements above about the absent end-to-end PDS-failure/read-model test and acknowledgement-through-proof process recovery; those statements described the earlier fixture set. The tests added to the existing dirty tree now establish the following deterministic behavior:

- `worker/test/node/http/writes.test.ts › an HTTP delete failure hides the local record while reporting failure without claiming remote absence` exercises real Node HTTP DELETE admission, a terminal fake-PDS 400 through the production outbox runner, and owner operation status `failed`. The same journey verifies public history, global feed, lookup, and stats hide the target while the fixture PDS still has it and verified `record_state` remains `present`. This is fixture evidence only; it does not prove live PDS behavior.
- `worker/test/read/feed.test.ts › a succeeded PDS delete remains hidden by its swap CID until absence proof, without hiding a recreated CID` verifies the successful-delete read overlay is limited to the stored `swap_cid`; the regular verifier applies signed absence before `record_state=absent`, and a new-CID recreation at the same URI is visible.
- `scripts/test/node-recovery.test.ts › packaged_recovery: SIGKILL after create and delete commits reconciles durable operations, views, cursor and checkpoint on the same database` holds the absence-proof request after PDS acknowledgement, confirms all relevant public read surfaces hide the projected CID, sends SIGKILL to the Node product child, restarts on the same database, and verifies hiding persists until proof-confirmed absence. This broadens deterministic recovery evidence; it is still not the full GitHub fault matrix, browser run, or live PDS acceptance.

The case map now points `M3.3.1/hide_immediately` at both pending/failed and acknowledged/proof-pending behavior, `M3.3.2/delete_restart` and `M3.4.2/kill_after_delete` at the actual Node child-process test, and `M3.3.3/remote_failure_status` at the end-to-end fake-PDS failure/status journey. `docs/planning/workers-waves.json` W3-01 and `docs/planning/node-waves.json` N3-02 declare the new tests. Wave-0 validator expectations now account for these two additional later-wave target references (77 target refs / 67 cases).

### #68 wrong-owner status reconciliation

The published #68 contract still calls for **403**; ADR 0005 §5.8, OpenAPI, and the current Node HTTP test specify **404 `not_found`** to avoid disclosing whether another DID owns an existing URI. The implementation remains unchanged. `docs/verification/milestones/m3-issue-68-contract-proposal.md` is a review-only recommendation to amend the issue to match the accepted ADR; an explicit owner decision is still required. No GitHub issue was edited, closed, or otherwise changed.

### Fresh local receipts

| Command | Result |
| --- | --- |
| `npx vitest run --project worker-node worker/test/node/http/writes.test.ts` | **PASS**, 1 file / 13 tests. |
| `npx vitest run --project worker-modules worker/test/read/feed.test.ts` | **PASS**, 1 file / 6 tests. |
| `npx vitest run --project scripts scripts/test/node-recovery.test.ts` | **PASS**, 1 file / 2 child-process tests / 2 journeys. |
| `python3 -B scripts/validate_case_map.py --check-tests --node-wave 4` | **PASS**, 258 unique cases; two later-wave targets pending. |
| `python3 -B scripts/test_validate_case_map.py` | **PASS**, 16 regressions. |
| `python3 -B scripts/validate_plan.py` | **PASS**, 7 milestones / 121 issues / 86 leaves / 258 test specifications. |
| `npx vitest run --project scripts scripts/test/node-recovery.test.ts scripts/test/node-interim.test.ts` | **PASS**, 2 files / 3 tests; wave-0 expectations now reflect 77 target references / 67 cases. |
| `bash scripts/check-ts.sh` | **PASS**, 224 test files / 918 tests; zero failures, skips or todos. Typecheck, lint, contract, case-map, production/Node bundle and build checks passed. |
| `git diff --check` | **PASS**. |

All receipts are local and dirty-tree scoped to sources based on recorded commit `29453f8e8763083a3e3d7b10d5090285ef2f9d63`. The Node build identifies the base commit and does not turn the modified working tree into an accepted release. No hosted CI, external-PDS/browser/live acceptance, release provenance, schema publication, GitHub mutation or production deployment is established. All 17 M3 issues remain open; M7 is excluded.