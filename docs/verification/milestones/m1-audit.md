# M1 milestone evidence record

**Disposition: open; not ready to close.** This record captures the read-only M1 audit in `/tmp/goal-audit-M1.md`, clarified against repository documents and the existing implementation ledger. It does not change acceptance criteria, issue state, code, GitHub, or production. The repository was already dirty at audit time (`29453f8e8763083a3e3d7b10d5090285ef2f9d63`); all receipts below are historical local/dirty-tree evidence, not clean-checkout, hosted-CI, pinned-toolchain, or release evidence. No build-producing command was rerun for this record.

The M1 implementation has meaningful deterministic evidence, but acceptance against the published issue contracts is unresolved. The principal reconciliation is the published single Rust HTTP process/static-artifact direction versus the accepted Node host described in ADR 0005; draft Node amendments are not published GitHub amendments. A follow-up public DNS-over-HTTPS observation on 2026-10-28 confirmed that the selected authority TXT record resolves to the configured/sign-in-allowlisted DID; the four production Lexicon records are absent from that DID's public PDS. DNS authority evidence is therefore present, but production schema publication and owner review remain outstanding, so the fail-closed publication gate remains appropriate (see ADR 0001). M1 coordination and implementation issues remain open; this record makes no closure recommendation beyond preserving that status.

## Evidence interpretation and scope

- **Tested deterministic behavior** means only behavior and local receipts explicitly reported by the audit/implementation record. Local fixture tests do not establish hosted or live behavior.
- **Remaining deterministic gap** identifies unproven tests/toolchain/contract coverage, not an inferred defect. “None identified” is bounded to the audited evidence.
- **Operator/live blocker** distinguishes required owner or external evidence from deterministic implementation work. “None specific” does not remove the overall M1 namespace/host/CI gates.
- **Contract/doc drift** records differences between published issue wording and repository architecture/docs. A validator passing current files does not reconcile GitHub wording.
- All commands/results below are prior receipts from `docs/verification/implementation-agent-13.md`; they were not rerun. Receipts are local and were generated against a dirty working tree. Focused and broad runs overlap and counts must not be added.
- **M7 is explicitly excluded.** No M7 implementation, acceptance, or closure is covered by this record.

## Coordination issues #1–5

### #1 — M1: Backend foundation and fixed contracts

- **Tested deterministic behavior:** Contract, schema, storage, and server foundations have broad local Rust and Node evidence. The implementation ledger reports `bash scripts/check-ts.sh` exit 0 with 904 passed / 224 files / 0 failed, skipped, or todo (fix-findings agent 1 final receipt), and `cargo test --locked --workspace --all-targets` exit 0 with 345 passed / 1 ignored on local Rust 1.99.0. These are scoped local receipts, not milestone acceptance.
- **Remaining deterministic gap:** There is no demonstrated fresh-checkout completion pass against the published M1 product contract. No fresh hosted CI or exact pinned Rust 1.90.0 run is evidenced. The local Rust version differs from the pin; a Node candidate is not the published Rust completion outcome.
- **Operator/live blocker:** DNS authority evidence now matches the configured namespace reference and sign-in allowlist; the earlier missing-evidence finding is corrected. The four production Lexicon records remain absent from the authority DID's public PDS, so owner schema publication/review and public retrieval remain prerequisites while publication stays fail-closed. Hosted CI on the pinned toolchain and official Node remains outstanding. No M1 live acceptance is evidenced.
- **Contract/doc drift:** `docs/planning/MVP.md` still states the M1 completion gate as a single Rust HTTP process, while `docs/adr/0005-local-node-host-and-compat-apis.md` records the accepted Node host direction. `docs/planning/AMENDMENTS-node.md` is draft/unpublished; it does not amend published issues. Related leaves #40–42 and #47–49 have historical Rust-oriented acceptance wording. The issue remains open.

### #2 — M1.1: Contracts

- **Tested deterministic behavior:** Lexicons, OpenAPI, examples, validation, and namespace gate exist. Prior receipt: `.venv/bin/python scripts/validate_contracts.py` exited 0 for API 1.2 with 53 methods, 47 paths, 69 schemas, 67 fixtures, and 236 response/status cases, including negative controls (`agent13-contracts.log`).
- **Remaining deterministic gap:** The original issue matrices have not been reconciled with the amended API contract. Validator success establishes consistency with current files only; it does not establish agreement with published issue wording.
- **Operator/live blocker:** The authority TXT proof now matches the configured namespace reference and sign-in allowlist; this corrects the earlier audit's missing-evidence finding. The four production schema records still return RecordNotFound at the authority DID's PDS. Owner publication/review of those schemas and their IDs/content remains a prerequisite; do not relax the fail-closed gate. No separate live check is required to establish deterministic lexicon validation.
- **Contract/doc drift:** `docs/planning/MVP.md` labels Node amendments draft/unpublished and preserves historical acceptance wording. The API and lexicon leaves #36–39 have the relevant contract-level details. Issue remains open.

### #3 — M1.2: Rust workspace and static executable build

- **Tested deterministic behavior:** Rust workspace, pinned-version declaration, crate boundaries, locked dependencies, and CI workflows exist. Historical local receipts include `cargo fmt --all --check` exit 0 and `cargo test --locked --workspace --all-targets` exit 0 (345 passed / 1 ignored), executed using Rust 1.99.0.
- **Remaining deterministic gap:** No fresh-checkout release pass using pinned Rust 1.90.0 and no hosted CI result are recorded. The locally recorded `scripts/check.sh` did not pass: exit 101 at Clippy with 15 `double_must_use` errors under Rust/Clippy 1.99.0. That failure is not evidence of the result on pinned 1.90.0. A current Node candidate is not evidence of the issue's requested Rust/musl artifact.
- **Operator/live blocker:** Hosted CI on the pinned toolchain and clean packaged/runtime smoke evidence remain unverified. No release was made from the dirty checkout.
- **Contract/doc drift:** Published Rust/static-artifact direction conflicts with the accepted Node candidate direction documented in ADR 0005. Relevant paths: `rust-toolchain.toml`, `Cargo.toml`, `.github/workflows/ci.yml`, `.github/workflows/node-candidate.yml`. The Node candidate workflow is manual-only and candidate-only; the legacy Rust release workflow is not Node publication. Issue remains open.

### #4 — M1.3: SQLite storage

- **Tested deterministic behavior:** Rust schema, forward migrations, typed repositories, writer, and tests are present. Prior receipts: `cargo test --locked -p atmusic-storage --tests` exit 0 (38 passed) and workspace test exit 0 (345 passed / 1 ignored), both using local Rust 1.99.0.
- **Remaining deterministic gap:** No pinned-toolchain or hosted execution is evidenced. The Node and Rust schema/migration histories are separate implementations; the audit does not establish cross-runtime schema parity, nor a single unified migration contract.
- **Operator/live blocker:** No distinct M1 storage operator action is identified beyond overall host, namespace, and CI/release gates.
- **Contract/doc drift:** `docs/storage.md` describes Node storage, while `docs/storage-rust.md` documents the original Rust SQL schema. Relevant implementation paths include `crates/storage/` and `worker/src/do/schema.ts`; the Node working-tree schema adds migration 3 for follow-proof storage. Keep those histories distinct and do not infer parity. Issue remains open.

### #5 — M1.4: HTTP/config/harness

- **Tested deterministic behavior:** Rust CLI/configuration, HTTP health/errors, harness, shutdown, and named tests exist. The local workspace test receipt reports 345 passed / 1 ignored, and the audit identifies health, configuration, and shutdown test files.
- **Remaining deterministic gap:** No exact pinned-toolchain/hosted CI run is evidenced. Completion against the published issue cannot be asserted while the issue's active Rust-server role is unresolved against current architecture direction.
- **Operator/live blocker:** No live acceptance or hosted result is recorded; none is a leaf-specific operator action. DNS authority proof is present, but production schema publication/review remains an overall publication gate.
- **Contract/doc drift:** `crates/server/` is the historical Rust server implementation; ADR 0005 describes the current Node host. Published issue wording and current accepted host direction require explicit reconciliation. Issue remains open.

## Implementation issues #36–49

### #36 — Namespace/schema-version gate

- **Tested deterministic behavior:** `crates/core/src/namespace.rs` and `docs/adr/0001-namespace.md` document fixture-only `com.example.atmusic`, fail-closed production publication, and schema-v1 record policy. Named namespace regression tests are reported passing in the audit.
- **Remaining deterministic gap:** No deterministic defect is identified in the gate itself. Public DNS-over-HTTPS authority evidence was observed on 2026-10-28 and matches the configured reference and sign-in allowlist; the safe closed state is not a test failure.
- **Operator/live blocker:** DNS authority evidence is present, but the four production schema rkeys are absent from the authority DID's public PDS. The owner must publish/review approved production schemas and verify public retrieval before enabling publication.
- **Contract/doc drift:** ADR 0001 preserves the original Rust fixture-only contract and historical absence finding, but its dated current evidence supersedes the claim that DNS authority proof is absent. `docs/planning/MVP.md` likewise says `com.example.atmusic` is fixture-only. Issue remains open.

### #37 — Scrobble lexicon

- **Tested deterministic behavior:** `lexicons/scrobble.json`, `crates/core/src/scrobble.rs`, scrobble fixtures, and core contract tests cover schema/validation. The contract validation receipt passed as described under #2.
- **Remaining deterministic gap:** No specific deterministic gap is identified by this audit. This does not establish agreement with all published acceptance wording or external interoperability.
- **Operator/live blocker:** None specific to this leaf; public publication remains dependent on #36.
- **Contract/doc drift:** The leaf names historical Rust paths while the accepted host direction is Node; the lexicon remains the contract artifact. Broader issue amendment/reconciliation is outstanding. Issue remains open.

### #38 — Follow lexicon

- **Tested deterministic behavior:** `lexicons/follow.json`, `crates/core/src/follow.rs`, deterministic rkey helper, and contract tests are present. Current contract validation is reported passing.
- **Remaining deterministic gap:** No specific deterministic gap is identified in the audited evidence.
- **Operator/live blocker:** None specific to this leaf; publication remains gated on #36.
- **Contract/doc drift:** Published leaf paths are historical Rust paths; current host direction is Node, with no published Node amendment. Issue remains open.

### #39 — OpenAPI/status matrices

- **Tested deterministic behavior:** `api/openapi.yaml`, API examples, and `scripts/validate_contracts.py` exist. Prior exact receipt: `.venv/bin/python scripts/validate_contracts.py` exit 0; 53 methods, 47 paths, 69 schemas, 67 fixtures, 236 response/status cases, including negative controls.
- **Remaining deterministic gap:** Explicitly reconcile the published issue's original endpoint/status matrix with current API v1.1/v1.2 changes. The validator proves internal consistency of the current amended API, not reconciliation with the original issue.
- **Operator/live blocker:** No leaf-specific live blocker for deterministic OpenAPI validation. Overall namespace ownership remains a publication gate.
- **Contract/doc drift:** `docs/planning/MVP.md` describes later API changes and draft amendments; the plan also retains historical M1 contract text. #39 remains open, and neither local validation nor draft docs publish an amendment.

### #40 — Rust workspace/pinning

- **Tested deterministic behavior:** Four-crate workspace, `Cargo.lock`, Rust 1.90.0 pin, dependency boundaries, locked builds, formatting, and local all-target tests are evidenced. Prior receipts: `cargo fmt --all --check` exit 0; `cargo test --locked --workspace --all-targets` exit 0 (345 passed / 1 ignored).
- **Remaining deterministic gap:** Pinned Rust 1.90.0 was unavailable locally; the recorded test run used Rust 1.99.0. Exact execution under the required pinned toolchain is unproven.
- **Operator/live blocker:** A hosted/pinned-toolchain CI pass is required to establish the missing toolchain evidence.
- **Contract/doc drift:** `rust-toolchain.toml`, `Cargo.toml`, and `Cargo.lock` define the Rust workspace target, but the active Node-host direction creates a product-contract question not answered by local Rust tests. Issue remains open.

### #41 — CI/lint/tests

- **Tested deterministic behavior:** `.github/workflows/ci.yml` includes the TypeScript prerequisite-order fix and a static regression test. Prior local receipts include actionlint exit 0 and Rust workspace tests exit 0 (345 passed / 1 ignored, Rust 1.99.0). The final local TypeScript gate receipt is `bash scripts/check-ts.sh`: exit 0, 904 passed / 224 files / 0 failed, skipped, or todo (fix-findings agent 1 final ledger).
- **Remaining deterministic gap:** No fresh hosted green CI is evidenced. `scripts/check.sh` exited 101 at Clippy with 15 `double_must_use` errors under unpinned local Rust 1.99.0; the workspace-test command was run separately and passed, but this does not convert the failed gate to a pass or prove pinned 1.90.0 behavior.
- **Operator/live blocker:** Hosted CI with pinned Rust 1.90.0 and official Node is outstanding. No hosted workflow run is recorded.
- **Contract/doc drift:** Relevant paths are `scripts/check.sh`, `.github/workflows/ci.yml`, and `scripts/test/ci-workflow.test.ts`. The workflow prerequisite fix repairs ordering, not hosted-green evidence. Node amendments do not resolve published M1 acceptance wording. Issue remains open.

### #42 — Self-contained musl artifact

- **Tested deterministic behavior:** In the documented Node direction, candidate build/guard/package tooling and deterministic packaging tests exist: `scripts/package-node-release.ts`, `.github/workflows/node-candidate.yml`, and `scripts/test/build-server.test.ts`. Tests cover deterministic package behavior and refusal conditions, but the current dirty checkout was not released. The candidate workflow is manual-only and candidate-only.
- **Remaining deterministic gap:** Against the still-published issue wording, no self-contained musl/static ELF artifact or its requested clean-container smoke is demonstrated. A Node package is not a musl artifact. No release receipt from this dirty checkout exists.
- **Operator/live blocker:** Product/release direction has not been reconciled in the published issue. No production release evidence exists; hosted candidate workflow has not run.
- **Contract/doc drift:** `docs/planning/MVP.md` marks the Node amendment draft; it also records an ADR 0004/A19 supersession of the musl artifact in the earlier Workers direction. ADR 0005 then supersedes relevant ADR 0004 decisions with Node. `docs/releases.md`, `.github/workflows/node-candidate.yml`, and `scripts/package-node-release.ts` describe candidate tooling, not proof that #42's published contract changed. Issue remains open.

### #43 — SQLite schema/constraints

- **Tested deterministic behavior:** Rust migration SQL and schema/repository tests exist; `docs/storage-rust.md` records the Rust schema. Storage tests are reported passing locally (38 passed for the focused storage suite; workspace 345 passed / 1 ignored).
- **Remaining deterministic gap:** No specific missing schema constraint was established in this read-only audit. Do not infer Node/Rust schema parity or a unified cross-runtime schema from these tests.
- **Operator/live blocker:** None specific to the leaf. No hosted/pinned result is evidenced.
- **Contract/doc drift:** Relevant files: `crates/storage/migrations/0001_initial.sql`, `docs/storage-rust.md`, `docs/storage.md`, `worker/src/do/schema.ts`. The Node schema's working-tree migration 3 is distinct from Rust migration history. Published issue describes the Rust schema; explicit owner/reviewer reconciliation with Node remains. Issue remains open.

### #44 — Embedded migrations/database open

- **Tested deterministic behavior:** Rust embedded migrations, WAL/foreign-key/busy-timeout setup, future-version refusal, rollback/reopen tests are present. Prior local storage and workspace test receipts passed (38 focused storage tests; 345 workspace tests and 1 ignored).
- **Remaining deterministic gap:** No exact pinned-toolchain or hosted execution. Node and Rust migration histories remain separate; no cross-runtime migration compatibility is established.
- **Operator/live blocker:** No distinct operator action is identified for this leaf.
- **Contract/doc drift:** Relevant files are `crates/storage/src/database.rs`, `crates/storage/src/migrations.rs`, `worker/src/do/schema.ts`, and the implementation ledger. The Rust migration contract must not be silently substituted by Node migrations. Issue remains open.

### #45 — Typed repositories/transactions

- **Tested deterministic behavior:** Typed Rust repository modules and transaction/atomicity tests exist; prior local workspace tests passed (345 passed / 1 ignored).
- **Remaining deterministic gap:** Pinned-toolchain and hosted CI evidence remain absent. The audit identifies no additional leaf-specific deterministic gap.
- **Operator/live blocker:** None specific to this deterministic leaf.
- **Contract/doc drift:** `crates/storage/src/repositories/` and `crates/storage/tests/repositories.rs` implement the published Rust scope. Whether that remains the accepted product runtime must be reconciled at parent/contract level; current Node direction is not a published amendment. Issue remains open.

### #46 — Writer/contention

- **Tested deterministic behavior:** Bounded Rust writer implementation and concurrency tests exist; the local workspace test receipt passed (345 passed / 1 ignored).
- **Remaining deterministic gap:** Exact pinned CI evidence is absent; no other deterministic gap was established in the audit.
- **Operator/live blocker:** None specific to the leaf.
- **Contract/doc drift:** `crates/storage/src/writer.rs` and `crates/storage/tests/concurrency.rs` address the Rust issue scope. Product-host reconciliation is unresolved at parent level. Issue remains open.

### #47 — Config/migrate CLI

- **Tested deterministic behavior:** Rust CLI/configuration and tests exist; named config and migration cases are represented in `crates/server/tests/config.rs` and the local workspace test receipt (345 passed / 1 ignored).
- **Remaining deterministic gap:** No exact pinned-toolchain or hosted CI run is evidenced. Acceptance role is unresolved while published issue describes the active Rust server.
- **Operator/live blocker:** None specific to the deterministic leaf; overall live/namespace gates are separate.
- **Contract/doc drift:** Relevant paths: `crates/server/src/config.rs`, `crates/server/src/main.rs`, `crates/server/tests/config.rs`; compare ADR 0005's Node deployment direction. Issue remains open.

### #48 — Health/errors/metadata

- **Tested deterministic behavior:** Rust health, metadata, request/error handling, and tests exist; the local workspace test receipt passed (345 passed / 1 ignored).
- **Remaining deterministic gap:** No exact pinned-toolchain or hosted CI run is evidenced.
- **Operator/live blocker:** None specific to the deterministic leaf.
- **Contract/doc drift:** `crates/server/src/http/health.rs`, `crates/server/src/http/error.rs`, and `crates/server/tests/health.rs` are the historical Rust implementation. Current Node host direction and published acceptance wording require reconciliation. Issue remains open.

### #49 — Harness/shutdown

- **Tested deterministic behavior:** Rust temporary-database/server harness and shutdown/drain tests exist; prior local workspace tests passed (345 passed / 1 ignored).
- **Remaining deterministic gap:** No exact pinned/hosted CI run is evidenced. A local fixture test does not constitute live/server acceptance.
- **Operator/live blocker:** None specific to the harness.
- **Contract/doc drift:** `crates/server/tests/common/`, `crates/server/src/shutdown.rs`, and `crates/server/tests/shutdown*.rs` implement the original Rust server acceptance. The current architecture decision requires published contract reconciliation; issue remains open.

## Overall evidence limits and next reconciliation

The implementation ledger is explicitly a scoped implementation/check record, not milestone acceptance. Its receipts were executed against a dirty checkout based on the recorded SHA; no clean-tree status is claimed here. Local results do not substitute for hosted CI, pinned Rust 1.90.0, official Node/SQLite execution, a release artifact, owner-reviewed production schema publication, or live external-PDS/production evidence. In particular, the final TypeScript local gate and Rust workspace tests are evidence of deterministic local behavior only.

Before M1 closure is considered, owners/reviewers must explicitly reconcile the published #1–5 and #36–49 acceptance contracts with the accepted Node direction (including #39, #42, #43), obtain required hosted/pinned-toolchain evidence if Rust remains part of the acceptance gate, and publish/review the four approved production Lexicons with public retrieval evidence. DNS authority is already observed; do not weaken the fail-closed publication gate. Preserve all issue-open statuses until that reconciliation and evidence are accepted.

**Excluded scope:** M7 is excluded. No M7 files, issues, tests, browser acceptance, or closure status are assessed here.

## Additional deterministic contract validation — 2026-10-28

These non-build validators were run after the audit records were assembled, on the same dirty checkout based on `29453f8e8763083a3e3d7b10d5090285ef2f9d63`:

| Command | Result |
| --- | --- |
| `python3 scripts/validate_contracts.py` | **Exit 1**, environment-only prerequisite: the system interpreter lacks pinned `attrs==26.1.0`. No repository files were changed by the failed attempt. |
| `.venv/bin/python scripts/validate_contracts.py` | **PASS** — API 1.2.0; 53 methods / 47 paths, 69 schemas, 67 fixtures, 236 response/status cases, 54 accepted and 120 rejected schema cases, and all negative mutation controls passed. This validates consistency of current files, not reconciliation with GitHub wording or production publication. |
| `python3 -B scripts/validate_plan.py` | **PASS** — 7 milestones, 121 issues, 86 leaves, 258 test specifications, acyclic dependencies and fixture histories/feeds/statistics windows. |
| `python3 -B scripts/validate_case_map.py --check-tests --node-wave 4` | **PASS** — 258 unique cases, 252 mapped test IDs, 6 retired with amendment IDs; all targets through wave 4 exist. Two later-wave targets are pending: M3.4.3 `live_retries` (wave 8) and M7.1.2 `csrf_client` (wave 5). The M7 target is only reported as a pre-existing case-map entry by this global validator; no M7 implementation or acceptance work was performed. |

These validations do not replace the broad TypeScript test receipt, hosted CI, pinned Rust toolchain, official Node/SQLite execution, or any live acceptance. The environment-only initial failure is recorded rather than hidden.

## Follow-up deterministic M1 work — 2026-10-28

This addendum records narrowly scoped changes made after the read-only issue audit above. It supersedes only the stated deterministic gaps; it does **not** amend GitHub issue bodies, approve an architecture amendment, close any issue, or satisfy hosted/live gates. All receipts are from a dirty checkout based on `29453f8e8763083a3e3d7b10d5090285ef2f9d63`.

| M1 case | Follow-up behavior/evidence | Boundary and remaining qualification |
|---|---|---|
| #43 `idempotency_scope` | Case map now pairs the Node HTTP cross-DID replay test with the direct `UNIQUE(did, idempotency_key)` storage test: duplicate Alice insertion is rejected, Bob may use the same key, and row effects are asserted. | HTTP idempotency replay and SQL uniqueness are distinct invariants; neither is used as a substitute for the other. |
| #43 `foreign_key` | `insertOperation` checks that the owner account exists inside the transaction and rejects before writing an operation/dependency. The new regression asserts both tables remain empty. A source search found this as the sole production `INSERT INTO operations` path. | The check is at the application insertion boundary, **not** a physical SQL foreign key on `operations.did`; raw administrative SQL can bypass it. If the owner requires database-level rejection, migration compatibility and a schema design remain review items. Existing projection-row foreign-key tests are separate. |
| #46 `concurrent_writes` | Node API test now sends 100 distinct scrobbles concurrently across 10 distinct session cookies, then asserts all 100 202 responses, unique operation IDs/idempotency keys, exact durable rows/listen keys and no PDS writes. | It exercises the composed Node API dispatcher, not child-process sockets or a bounded writer queue. `queue_full` remains unresolved: the current 1,024-job tests exercise indexing/snapshot admission, not the old Rust writer-command queue/service_busy contract. No queue-full retirement or replacement capacity was approved. |
| #47 `migrate_only` | Existing `run()` regression proves pre-migration backup and migrations finish before the configured listener binds; connections are refused before migration, and readiness succeeds after bind. The case map now describes this as startup ordering evidence. | The accepted Node host has no standalone `--migrate-only` command. `--init` is a server-start mode and does not prove a no-listener command. Replacing the old CLI-specific acceptance with startup-before-listen is still a proposed owner-reviewed contract change; the published case remains unresolved. |
| #49 `drain_timeout` | Timeout test asserts `shutdown.drain_expired.inFlight === 1`, aborted client request, database release, and close/reopen persistence of a pending outbox operation and ingestion hint. On restart the operation is retained as `blocked`, `attempts: 0`, because the deterministic fixture has no OAuth session. | Persistence is demonstrated; unblocking/sending after sign-in is not. `inFlight` counts HTTP requests, not the total queued/unfinished outbox work. Do not claim an aggregate unfinished-work count from this log field. |

The per-case traceability notes are in `docs/verification/ts-case-map.json`; the unpublished issue wording and unresolved alternatives remain in `m1-github-amendment-proposal.md`. That proposal was updated to distinguish the new evidence from unresolved acceptance rather than to present the new tests as permission to retire queue-full, migrate-only, or reporting requirements. No GitHub write was made.

The broad TypeScript/workspace gate was rerun after the owner-boundary guard and fixture-account changes; it passed **906 tests in 224 files**. Later narrow reruns after increasing the concurrent batch to 100 and adding the pending outbox restart assertion passed (**12 tests** in `worker/test/node/http/writes.test.ts`; **2 tests** in `worker/test/node/shutdown.test.ts`). These are local dirty-tree results, not hosted CI, official SQLite 3.54.0, release, or live acceptance. A final verification refresh after the latest case-map/test-expectation edits is recorded below.

## Final local verification refresh — 2026-10-28

Executed against the existing dirty working tree based on `29453f8e8763083a3e3d7b10d5090285ef2f9d63`; no files were reset or overwritten. This refresh records deterministic local gates only.

| Exact command | Result and boundary |
| --- | --- |
| `bash scripts/check-ts.sh` | **PASS**, exit 0; **906 tests passed in 224 files**, report-tests `executed=906 passed=906 failed=0 skipped=0 todo=0`; all nine TypeScript gate steps passed, including contract validation, case map, Python validator tests, production bundle guard, Node build check, and Node bundle guard. Local dirty-tree gate; not hosted CI, a clean-checkout receipt, release provenance, pinned Rust 1.90.0 or official Node/SQLite 3.54.0 execution. |
| `npx vitest run --project scripts scripts/test/node-interim.test.ts` | **PASS**, 1 test file / 1 test; verifies wave-0 case-map pending-target expectation against the current runner using a disposable copy. |
| `python3 -B -m unittest discover -s scripts -p test_validate_case_map.py` | **PASS**, 16 tests. |
| `python3 -B scripts/validate_case_map.py --check-tests --node-wave 4` | **PASS**, 258 unique cases, 252 mapped, 6 retired with amendment IDs; all referenced targets through wave 4 exist. Two later-wave pending targets remain (M3 `live_retries`, wave 8; pre-existing M7 `csrf_client`, wave 5). No M7 implementation or acceptance work was performed. |
| `python3 -B scripts/validate_plan.py` | **PASS**, 7 milestones, 121 issues, 86 leaves, 258 test specifications, acyclic dependencies, fixture histories/feeds and statistics windows. |
| `git diff --check` | **PASS**, no whitespace errors. |

The gate emitted existing environment warnings (browser Locks API unavailable in jsdom, schema-format notices, and test-process TLS-warning output); these did not fail assertions or affect the exit-0 result. Current owner-review questions remain unresolved: #43 physical SQL foreign-key semantics versus the tested application insertion guard, #46 bounded writer queue/`queue_full`, #47 standalone `migrate_only`, #49 aggregate unfinished-work reporting, and the broader published Rust/static-artifact versus accepted Node architecture reconciliation.

A read-only `gh run list --limit 10 --json databaseId,workflowName,status,conclusion,headSha,event,createdAt` and `gh run view 40267654245 --json jobs,headSha,workflowName,event,createdAt` showed the latest listed hosted run is the **2026-10-26** `Rust scaffold` PR run for base SHA `29453f8e8763083a3e3d7b10d5090285ef2f9d63` (run `40267654245`). Its TypeScript gate failed; its Rust `Check workspace` step failed before the later smoke steps, which were skipped. The corresponding push run `40267649854` also concluded failure. This is fresh evidence that hosted CI is **not green**, not a hosted pass and not evidence for the current dirty tree. No workflow was dispatched and no GitHub issue was changed or closed.

## Latest local workspace refresh after lifecycle regression additions

The current M1 deterministic evidence paths were rerun after adding the M3 delete failure/status regression and updating its wave/map entries. This refresh is still local dirty-tree evidence; it does not change issue states or acceptance contracts.

| Exact command | Result |
| --- | --- |
| `npx vitest run --project worker-node worker/test/node/http/writes.test.ts worker/test/node/shutdown.test.ts worker/test/node/outbox/follows.test.ts worker/test/node/run.test.ts` | **PASS**, 4 files / 32 tests, including the owner-account insertion guard, concurrent writes, pre-listen migrations, and shutdown/restart persistence coverage. |
| `bash scripts/check-ts.sh` | **PASS**, 224 test files / 918 tests, zero failures/skips/todos; typecheck, Biome, contracts, case-map checks, production and Node bundle guards, Node server build check all passed. |
| `python3 -B scripts/validate_case_map.py --check-tests --node-wave 4` | **PASS**, 258 unique cases; two later-wave targets remain pending. |
| `python3 -B scripts/test_validate_case_map.py` | **PASS**, 16 regression tests. |
| `python3 -B scripts/validate_plan.py` | **PASS**, 7 milestones / 121 issues / 86 leaves / 258 test specifications. |
| `git diff --check` | **PASS**. |

This supersedes the older 906-test receipt as the latest local broad gate; historical counts above remain records of their original runs. The current receipt is based on dirty working sources reporting base commit `29453f8e8763083a3e3d7b10d5090285ef2f9d63`; it is not a clean-checkout or release identity. The issue owner/reviewer decisions remain outstanding for #43 physical SQL FK versus application insertion validation, #46 bounded queue/`queue_full`, #47 standalone `migrate_only`, #49 aggregate unfinished-work reporting, and published Rust/static-artifact versus accepted Node direction. Separate read-only publishability reviews reconfirmed these distinctions. The proposal explicitly preserves the existing #37 optional scrobble fields/types/limits, keeps #43 storage uniqueness distinct from HTTP replay and application-owner guards distinct from physical FKs, and keeps the #44 incompatible-schema behavior, #46 writer-queue mapping, #47 no-listener migration case, and #49 aggregate-count/restart-recovery assertions pending owner review. Production schema publication is still absent, so namespace writes stay fail-closed. No GitHub issue, production service, configuration, credential, DNS record or PDS record was changed.
