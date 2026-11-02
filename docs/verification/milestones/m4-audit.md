# M4 milestone audit evidence record

## Disposition and scope

**M4 is substantially implemented and fixture-tested under the accepted Node/Jetstream architecture, but is not complete. Keep every issue in this record open.** Deterministic acceptance gaps, published-contract reconciliation, and genuine live federation evidence remain. Supplying credentials alone will not repair the stale live harness.

This record covers **17 issues: #16–20 and #74–85**. **M7 is explicitly excluded.** Cross-issue references below identify existing ownership or dependencies; they do not expand this record into another milestone audit.

- Read-only audit authority: `/tmp/goal-audit-M4.md` (Agent 4 — read-only M4 audit).
- Durable clarification references: `docs/verification/implementation-agent-13.md`, including both follow-up addenda; `docs/cursors.md`; `docs/verification/federation-live.md`; `docs/verification/federation-fixtures.md`.
- Source-audited base HEAD: `29453f8e8763083a3e3d7b10d5090285ef2f9d63`. The checkout includes prior tracked and untracked modifications and **is not clean**. Evidence includes those local modifications, not merely committed HEAD.
- Prior test receipts are **local/dirty-tree evidence**, not merged acceptance, hosted CI, release provenance, or proof against an immutable release artifact. In particular, credit the improved full-payload convergence assertions and the added follow journey/process-recovery tests without representing them as committed release evidence.
- This documentation pass does not rerun tests or build-producing commands, deploy, operate external PDSs, edit production/test code, amend GitHub contracts, or change issue states. Repository docs were inspected only to clarify the audit.

### Evidence vocabulary

Each issue separates:

1. **Tested deterministic behavior:** fixture/local coverage credited by the source audit.
2. **Remaining deterministic gap:** missing assertions, harness capability, or implementation semantics; “no additional gap identified” is not an acceptance or closure decision.
3. **Operator/live blocker:** what requires real infrastructure or live evidence, distinguished from locally fixable gaps.
4. **Contract/doc drift:** differences between original published requirements, amended architecture, mappings, and historical documentation.

For **#74–84**, live federation acceptance is inherited through **#85**. It is not a prerequisite for running their deterministic tests, and a missing live environment must not obscure their locally actionable gaps. Conversely, fixture success does not establish real Jetstream retention, coverage, independently operated PDS interoperability, or live convergence.

## Prior receipts and limits

The following commands/results are recorded by the audit source. They are **prior observations, not executions performed to write this record**.

| Source-supported prior command or receipt | Recorded result | What it does not establish |
| --- | --- | --- |
| `work/verification/implementation-agent-13/fix1-ts-test-report.json` and `work/verification/implementation-agent-13/fix1-check-ts-final.log` | Prior final receipt inspected by the auditor: **904 passed, zero failed/pending**, including federation, restart, ingestion, cursor, and subprocess tests. The auditor did **not** rerun the full gate. | No release-bound, hosted, clean-tree, or live acceptance claim; no per-issue completeness verdict from an aggregate count. |
| `python3 -B scripts/validate_case_map.py --check-tests --node-wave 4` | Exit **0**; **two later-wave targets pending**. | Structural mapping is not semantic acceptance and does not fill the feed/federation assertions identified below. |
| `python3 -B scripts/verify_live_evidence.py` | Exit **2/BLOCKED**: historical schema-v1 inventory versus legacy Workers schema-v2 verifier. **No live tests ran.** | Neither a live failure of the current Node product nor a live pass; the evidence tooling itself remains mismatched. |
| `git diff --check` | Exit **0**. | Whitespace validation does not mean the checkout is clean or the milestone is complete. |

No new execution receipt is implied by a test-file reference below. Historical Rust documentation is useful for identifying old requirements, but its endpoint-writer and relay claims are not transferred to current-Node tests.

## Coordination issues

### #16 — M4 milestone tracking

**Disposition: keep open.**

- **Tested deterministic behavior:** The source credits bounded Jetstream hint admission, signed repository verification, durable two-stage ingestion, reconnect/backfill/account reconciliation, core feeds/cursors, and substantial fixture federation coverage. The local 904-pass receipt includes relevant suites; improved full remote-payload comparisons and narrow subprocess recovery are credited.
- **Remaining deterministic gap:** The shared Node read model now hides queued/running/blocked/failed local delete intents, and the exact continued-cursor unfollow/feed timestamp-boundary regressions have been added. A controlled fake-Jetstream per-DID omission test now proves a missing Carol commit stays unindexed, but also shows the app remains `current` because the stream gives it no coverage-loss signal. Remaining M4 gaps include acknowledged-delete-through-proof/recovery semantics (#80, linked #68–70/#72), reconciliation of silent-coverage behavior (#83), the complete process-level federation fault/convergence matrix (#84), and current-Node live tooling/inventory (#85). An aggregate gate or structurally valid case map does not close these gaps.
- **Operator/live blocker:** #85 requires two independently operated PDSs, documented Jetstream coverage, dedicated identities, namespace authority, secure public Node hosting, controlled interruption/recovery, latency measurement, and sanitized release-bound evidence. No live federation pass exists.
- **Contract/doc drift:** Published subscribeRepos/Rust/Workers requirements are not automatically amended by the accepted Node/Jetstream implementation or draft amendments. Checkpoint guarantees, current-key trust, scheduler behavior, tombstones, public viewer input, and old federation docs require explicit reconciliation.
- **Evidence paths:** `docs/verification/implementation-agent-13.md`; `docs/verification/ts-case-map.json`; `docs/cursors.md`; `docs/verification/federation-live.md`; `docs/verification/federation-fixtures.md`; leaf evidence below.

### #17 — M4.1 bounded ingestion, proof, and atomicity coordination

**Disposition: keep open.**

- **Tested deterministic behavior:** #74–76 establish bounded JSON parsing and transport limits, CAR/hash/signature/MST verification, unchanged projection on rejection, durable hint/checkpoint transactions, and separately transactional verified projection with revision/replay protection.
- **Remaining deterministic gap:** No additional parser, verifier, or amended two-stage atomicity defect was confirmed by the audit. This is not proof that the original subscribeRepos matrix or verified-mutation/checkpoint transaction was implemented. Evidence covers current-key proof/range walking, not arbitrary historical revision-key authorization.
- **Operator/live blocker:** Inherits #85's real-source federation gate; deterministic parser/proof tests can run without those live inputs.
- **Contract/doc drift:** Reconcile subscribeRepos CBOR/CAR/event requirements with Jetstream commit hints; current-proof trust with revision-specific historical key wording; and checkpointing an untrusted durable hint with the original single transaction for verified mutation plus checkpoint. Draft A6/A17 references do not themselves amend published contracts.
- **Evidence paths:** `packages/atproto/src/jetstream/events.ts`; `packages/atproto/src/verify/`; `worker/src/do/ingest/{hints,jetstream,verify-drain}.ts`; `worker/src/do/write/apply-record.ts`; corresponding #74–76 tests below.

### #18 — M4.2 reconnect, backfill, and account coordination

**Disposition: keep open.**

- **Tested deterministic behavior:** #77–79 cover persisted-cursor replay, rejection/age recovery, rotation/backoff, durable gaps during snapshots, resumable verified snapshots, stale-update guards, migration, account state, suppression, and generation-safe reactivation.
- **Remaining deterministic gap:** No new defect was confirmed in those inspected paths under the accepted design. Fixture cursor refusal/replay is not actual retention evidence. Account detection is sweep/error-driven rather than immediate subscribed identity/account-event processing; the scheduler differs from the original arrangement.
- **Operator/live blocker:** Production continuity, configured coverage of both PDSs, and real recovery remain unverified through #85. They cannot be inferred from successful fixture snapshots or a stored status flag.
- **Contract/doc drift:** Relay sequence wording must be reconciled with Jetstream cursors; one-slice snapshot scheduling with the original four-repository scheduler; and verified identity-event wording with PDS checks/sweeps and status grace/backoff semantics. Historical disabled-Rust-relay descriptions do not describe the active Node path.
- **Evidence paths:** `worker/src/do/ingest/{jetstream-socket,checkpoint,snapshot-job,admission,accounts,generation,sweeps}.ts`; `worker/src/do/status.ts`; `worker/src/do/write/apply-snapshot.ts`; `packages/atproto/src/snapshot/`; #77–79 tests below.

### #19 — M4.3 feed and cursor coordination

**Disposition: keep open.**

- **Tested deterministic behavior:** #80–82 cover exact feed ordering/identity, URI ties, visibility exclusions, verified-follow membership, cursor scope/viewer binding, static traversal, above-anchor exclusion, and deletion of an unreturned row. The BFF follow journey distinguishes queued/acknowledged operations from proof-verified feed membership.
- **Remaining deterministic gap:** Follow-up tests cover the two exact feed-cursor mutation cases and a public-read overlay for queued/running/blocked/failed local delete intents. The overlay does not yet establish a persistent tombstone from PDS acknowledgement through verified absence, nor the full process-death matrix.
- **Operator/live blocker:** Inherits #85 for real external mutations and convergence. The three deterministic gaps above do not require live credentials to address.
- **Contract/doc drift:** Original deletion requirements are only partially met: a local-intent overlay is now active, but the full acknowledgement/proof/recovery lifecycle and published status wording still need reconciliation. Original session-derived viewer/anonymous 401 behavior differs from the accepted public `viewer=<did>` API, which requires 422 when following viewer input is missing. Cursor docs explicitly disclaim snapshot isolation and exactly-once behavior for mutable timestamps; retain that distinction.
- **Evidence paths:** `worker/src/do/read/{visibility,feed}.ts`; `worker/src/http/feed.ts`; `worker/test/read/{feed,cursor-http}.test.ts`; `worker/test/acceptance/{mutations,read-model-acceptance}.test.ts`; `worker/test/node/journey/follow-journey.test.ts`; `docs/cursors.md`.

### #20 — M4.4 federation acceptance coordination

**Disposition: keep open.**

- **Tested deterministic behavior:** #83/#84 use independent fixture signing keys/PDS hosts, real signed repositories, production proof/projection, externally introduced records, faults, and exact final indexed-set/statistics checks. A direct fake-PDS createRecord test exercises one independent XRPC writer path; a coverage-negative scenario omits Carol from replay/live delivery; and the child-process journey now interrupts create, update and delete proof handling at the second fake PDS. Credit the dirty-tree complete supported payload/follow comparisons.
- **Remaining deterministic gap:** The shared worker fixture has a direct fake-PDS createRecord XRPC case; the separate packaged child-process journey now exercises fake-PDS create/update/delete XRPCs across process deaths. `APP_WRITES` remains a PDS-XRPC counter, while the new `Acceptance.appHttpPosts` counter records POSTs sent through the app's acceptance HTTP helper; the independent-XRPC acceptance case asserts zero app POSTs separately from PDS writes. The unresolved deterministic/contract issue is silent per-DID coverage: the negative test leaves Carol unindexed while runtime status stays `current`, because Jetstream provides no per-DID coverage-loss signal. This does not satisfy a requirement for runtime `recovering`. The [review-only #83 coverage-contract proposal](m4-coverage-contract-proposal.md) records the owner decision needed; it is not a published amendment. In-process convergence, composition restart, and the create/update/delete proof-interruption journey still do not jointly constitute the full multi-PDS process-death/fault matrix. #85 also lacks a usable current-Node live runner/inventory.
- **Operator/live blocker:** Fixture isolation is not independently operated live interoperability. #85 remains blocked on both tooling and genuine two-PDS/Jetstream/release-bound operational evidence.
- **Contract/doc drift:** Rust fixture endpoint-writer documentation is historical, not current-Node endpoint evidence. Case-map restart credit and “process” comments overstate composition restart. Historical Rust relay and Workers administrative/analytics prerequisites need current-Node reconciliation.
- **Evidence paths:** `packages/atproto/test-support/read-models.ts`; `worker/test/acceptance/{federation,restart}.test.ts`; `worker/test/acceptance/support/seed.ts`; `scripts/test/node-recovery.test.ts`; `scripts/live/`; `docs/verification/{ts-case-map.json,federation-fixtures.md,federation-live.md,live-evidence.json}`.

## Leaf issues

### #74 — Parse bounded relay frames

**Disposition: keep open.**

- **Tested deterministic behavior:** Jetstream JSON parsing, collection filtering, malformed/oversize rejection, safe-integer/syntax checks, and counters. Parser messages are capped at **64 KiB**; the separate Node WebSocket transport payload cap is **1 MiB**. These are distinct limits at distinct layers.
- **Remaining deterministic gap:** No additional parser defect was confirmed against the accepted Jetstream design. This does not satisfy the original subscribeRepos dispatch matrix.
- **Operator/live blocker:** Inherits #85. Real configured Jetstream coverage remains unproven; it does not prevent deterministic parser/socket testing.
- **Contract/doc drift:** GitHub still requires subscribeRepos CBOR, **8-MiB** frames/CARs, **10,000** operations, and identity/account/tooBig dispatch. Current subscriptions deliberately use commit hints; identity/account changes are handled through PDS checks and sweeps. Reconcile the architecture explicitly rather than reporting the original matrix implemented. The audit references draft amendments A6/A17.
- **Evidence paths:** `packages/atproto/src/jetstream/events.ts`; `worker/src/do/ingest/jetstream.ts`; `worker/src/node/jetstream-ws.ts`; parser, Jetstream, and socket tests identified by the source audit.

### #75 — Verify signatures, CIDs, and MST membership

**Disposition: keep open.**

- **Tested deterministic behavior:** CAR framing/block limits, hash integrity, canonical signed commits, DID/version/revision checks, low-S signatures, MST inclusion/exclusion, and missing-block refusal. The rejection matrix checks unchanged projection/checkpoint tables and successful valid ingestion after rejection. Signature failure allows one fresh identity-resolution retry.
- **Remaining deterministic gap:** No new verifier defect was confirmed. The evidence establishes the **current-key proof/range-walk model**, not historical signing-key validity for arbitrary relay revisions.
- **Operator/live blocker:** Inherits #85's external-PDS and live verification gate. Fixture signatures do not establish current production interoperability or historical key authorization.
- **Contract/doc drift:** Original revision-specific key-trust wording differs from the accepted current-proof model. Fresh-current-key verification must not be described as historical key authorization.
- **Evidence paths:** `packages/atproto/src/verify/{car-bounds,commit,record-proof}.ts`; `worker/src/do/ingest/verify-drain.ts`; `packages/atproto/test/rust-golden-cars.test.ts`; `worker/test/ingest/{rejection-matrix,verify-drain}.test.ts`.

### #76 — Apply mutations and checkpoint atomically

**Disposition: keep open.**

- **Tested deterministic behavior:** Durable hint enqueue and stream checkpoint advancement share a transaction. Verified projection changes use synchronous transactions and revision guards. Replay does not duplicate listens.
- **Remaining deterministic gap:** No additional gap was identified against the amended **two-stage** design. The original combined verified-mutation/checkpoint guarantee is not demonstrated by these tests.
- **Operator/live blocker:** Inherits #85; local transactional/replay coverage is independent of live credentials.
- **Contract/doc drift:** The original issue requires verified mutation and checkpoint in the same transaction. Current code first checkpoints an **untrusted but durable hint**, then verifies/applies separately. A bad proof leaves the checkpoint at its already-enqueued position; it does not roll back hint admission. Distinguish rejection-matrix invariants from undoing the prior admission transaction. The audit references amendment A6.
- **Evidence paths:** `worker/src/do/ingest/{hints,jetstream,verify-drain}.ts`; `worker/src/do/write/apply-record.ts`; corresponding hints/replay/apply-record tests.

### #77 — Reconnect and gap detection

**Disposition: keep open.**

- **Tested deterministic behavior:** Persisted-cursor reconnect, inclusive replay, cursor-age/rejection recovery, host rotation, and injected-jitter backoff from **1 second to 60 seconds**. Gap recovery remains durable while snapshots run.
- **Remaining deterministic gap:** No new reconnect defect was confirmed. Fixture refusal and replay establish local recovery handling, not real Jetstream retention/continuity.
- **Operator/live blocker:** #85 must validate accepted continuity assumptions, configured source coverage, interruption, and recovery on real infrastructure.
- **Contract/doc drift:** Relay sequence terminology has been replaced by Jetstream cursor semantics. Historical federation docs describe disabled Rust relay progress rather than the active Node socket/proof path.
- **Evidence paths:** `worker/src/do/ingest/{jetstream-socket,checkpoint}.ts`; `worker/test/ingest/{jetstream-socket,gap-recovery}.test.ts`; `worker/test/acceptance/federation.test.ts`.

### #78 — Verified backfill and convergence

**Disposition: keep open.**

- **Tested deterministic behavior:** Resumable signed range snapshots, getRepo fallback, bounded admission, snapshot-floor/per-URI revision guards, stale-head refusal, and suppression/generation guards. Older snapshots cannot overwrite newer verified updates or deletions.
- **Remaining deterministic gap:** No new projection/convergence defect was confirmed in the inspected paths. Do not infer the original scheduler/test arrangement from amended bounded execution.
- **Operator/live blocker:** Inherits #85 for actual multi-PDS backfill, coverage, and convergence; fixture snapshots do not close that gate.
- **Contract/doc drift:** The original four-concurrent-repository scheduler is replaced by **one snapshot slice at a time**, retaining the **1,024 pending-job cap**. This respects an upper bound of four, but is not the original scheduling arrangement. The audit references amendment A7.
- **Evidence paths:** `packages/atproto/src/snapshot/`; `worker/src/do/ingest/{snapshot-job,admission}.ts`; `worker/src/do/write/apply-snapshot.ts`; snapshot-job, admission, gap-recovery, and apply-snapshot tests.

### #79 — Account, identity, and status reconciliation

**Disposition: keep open.**

- **Tested deterministic behavior:** PDS migration, identity refresh, account-status checks, immediate hiding **after detected deactivation**, generation-safe reactivation, suppression, and recovery status that does not trust a stored “current” flag.
- **Remaining deterministic gap:** No new account-state defect was confirmed. Detection is sweep/error-driven, not immediate response to subscribed identity/account events; the timing qualification matters.
- **Operator/live blocker:** Inherits #85 for real account/identity/PDS behavior and recovery evidence. Preserve explicit live coverage limitations where dedicated infrastructure cannot exercise a scenario.
- **Contract/doc drift:** Published wording still describes verified identity events. Current status includes grace/backoff rules and must not be summarized as proof that every pending hint has been indexed. The audit references amendment A17.
- **Evidence paths:** `worker/src/do/ingest/{accounts,generation,sweeps}.ts`; `worker/src/do/status.ts`; accounts, reactivation, sweeps, snapshot migration, and storage-status tests.

### #80 — Global feed

**Disposition: keep open.**

- **Tested deterministic behavior:** Exact global ordering, URI tie-breaking, authoritative URI/DID/CID/revision, pagination bounds, and exclusion of malformed, unverified, inactive, or suppressed content. The shared Node read predicate now also suppresses rows whose local delete operation is queued, running, blocked, or failed; cancellation restores visibility and delete admission invalidates stats cache versioning.
- **Remaining deterministic gap:** The pending/failed-intent visibility gap identified by the source audit is now covered for the shared Node read model. Remaining work includes an end-to-end state-transition test through PDS acknowledgement and proof-verified absence, persistence across the relevant recovery boundary, and confirmation that every legacy compatibility read obeys the same visibility rule. Existing **#68–70/#72** own the linked tombstone/all-view/failure-status work; no duplicate issue is needed.
- **Operator/live blocker:** Inherits #85 for live feed convergence. The local intent overlay is deterministic and independently tested; it does not provide live feed convergence or verify PDS deletion.
- **Contract/doc drift:** The new server-side overlay changes the behavior identified as missing in the baseline audit while keeping the verified projection untouched and avoiding a false `record_state=absent` claim. The historical Workers owner overlay is still separate. Reconcile the issue's exact status semantics with the accepted 404 privacy contract for wrong-owner deletes.
- **Evidence paths:** `worker/src/do/read/visibility.ts:51`; `worker/src/do/read/feed.ts`; `worker/test/read/feed.test.ts`; `worker/test/acceptance/mutations.test.ts`; explicit remaining-gap statement in `docs/verification/implementation-agent-13.md`.

### #81 — Following feed and viewer-bound cursors

**Disposition: keep open.**

- **Tested deterministic behavior:** Only verified effective music follows affect membership; self is not implicitly included; cursors bind scope/viewer and mismatches fail. The new BFF journey shows queued and acknowledged-but-unverified follows do not change the feed. The mapped `follow_change` test proves a fresh following query changes after unfollow.
- **Remaining deterministic gap:** No new gap was identified in the exact deterministic continuation semantics after adding the existing-cursor unfollow test. Live externally changed follow/feed convergence and original contract reconciliation remain separate.
- **Operator/live blocker:** Inherits #85 for actual externally changed follow/feed convergence. The local continuation assertion has deterministic fixture evidence.
- **Contract/doc drift:** Original anonymous request = **401** and session-derived viewer behavior are not implemented. Accepted A8 behavior is public `viewer=<did>`, with **422** when missing for a following feed. This is an intentional API divergence, not an authentication bypass under the current API. Reconcile the published contract rather than claiming the old one passes.
- **Evidence paths:** `worker/src/http/feed.ts:30`; `worker/test/read/{feed,cursor-http}.test.ts`; `worker/test/acceptance/mutations.test.ts`; locally untracked `worker/test/node/journey/follow-journey.test.ts` as identified by the audit; `docs/cursors.md`.

### #82 — Feed pagination during mutations

**Disposition: keep open.**

- **Tested deterministic behavior:** Exact static feed traversal, equal timestamps, exclusion of above-anchor arrivals, and removal of an unreturned deleted record. Documentation correctly disclaims snapshot isolation.
- **Remaining deterministic gap:** No new gap was identified in the moved-timestamp rule after adding an explicit `/api/v1/feed` update-through-boundary regression. The full mutable-row fault matrix remains broader than this one case.
- **Operator/live blocker:** Inherits #85 for live mutation/convergence evidence. The feed timestamp-boundary regression is deterministic fixture evidence.
- **Contract/doc drift:** No fundamental cursor-rule conflict was identified. Keep the documented possibility of omission/repetition after timestamp changes; do not claim exactly-once traversal over mutable rows. Fixed `asOf` metadata does not freeze versions, deletion, account state, or follow membership.
- **Evidence paths:** `worker/test/read/cursor-http.test.ts:195`; `worker/test/read/feed.test.ts`; `worker/test/acceptance/read-model-acceptance.test.ts`; `docs/cursors.md`.

### #83 — Independent-writer federation harness

**Disposition: keep open.**

- **Tested deterministic behavior:** Independent signing keys and fake PDS hosts, real signed repositories, production verification/projection, externally introduced Carol records, and exact public mutation/count checks.
- **Remaining deterministic gap:**
  1. `externalPut`/`externalDelete` helper scenarios still mutate the signed fixture repository directly, but dedicated fake-PDS XRPC paths now cover create in the acceptance harness and create/update/delete in the packaged child-process journey.
  2. `APP_WRITES` observes fake-PDS create/put/delete XRPC calls, not application HTTP POSTs. The acceptance harness now separately counts POSTs sent through its app HTTP helper as `appHttpPosts`; the independent-XRPC create test asserts this remains zero. This is deterministic fixture-level instrumentation, not live network traffic measurement.
  3. A controlled second-PDS coverage-negative integration scenario excludes Carol from fake Jetstream replay/live delivery after seeding. Her external commit stays absent from hints, proof fetches, projection and feed, while the app leaves her `indexing_state=current`: silent per-DID coverage loss is not detectable by this Jetstream path. The separate offline preflight still blocks when the coverage reference is absent. This does not meet any contract that requires runtime `recovering` status and does not establish real coverage.
- **Operator/live blocker:** Actual independently operated PDSs and verified configured Jetstream coverage remain required by #85. Fake independent keys/hosts do not establish independent live operation.
- **Contract/doc drift:** Rust fixture documentation describes historical endpoint writers and application POST counting; it is not evidence that the current Node harness exercises those endpoints/counters. Reconcile case-map/title claims with actual test scope.
- **Evidence paths:** `packages/atproto/test-support/read-models.ts:76–82,180–187,256–259`; `worker/test/acceptance/federation.test.ts:67`; `worker/test/acceptance/support/seed.ts`; `docs/verification/ts-case-map.json`; `docs/verification/federation-fixtures.md`.

### #84 — Federation fault/convergence suite

**Disposition: keep open.**

- **Tested deterministic behavior:** Duplicate delivery, socket drop, rejected stale cursor, signed snapshots, exact final indexed-set/statistics checks, and focused snapshot/live race guards. `worker/test/write/apply-snapshot.test.ts › live hint with newer revision survives snapshot sweep` applies newer live create/update/delete proofs before an older snapshot chunk and verifies final projection equality; the adjacent stale-head regression rejects an old live absence proof during a newer snapshot. **Credit the uncommitted improvement:** convergence compares all supported persisted scrobble payload fields and complete follow fields, not merely URI/CID/artist/track. The added subprocess SIGKILL journey materially improves durable outbox/recovery evidence.
- **Remaining deterministic gap:** Evidence remains split across three scopes; the focused snapshot/live test is not combined with the multi-PDS child-process outage/restart fault journey:
  - Federation convergence runs in-process.
  - Restart acceptance closes/reopens that composition.
  - The subprocess journey proves durable outbox/recovery and now includes a second-PDS commit missed during a controlled socket disconnect, followed by process death and durable-cursor replay on restart. It still does not implement the complete independent multi-PDS federation fault matrix and full remote-set equality across all fault modes after process death.

  No single current-Node process-level journey injects the complete snapshot/live race, duplicate/stale-cursor/identity-change faults and cross-PDS create/update/delete/outage while comparing all active record/follow sets after restart. The focused snapshot/live semantics are covered separately, not missing entirely. These tests must not be combined rhetorically into a single complete process-level federation acceptance run. Original #84/#108 acceptance scope remains incomplete.
- **Operator/live blocker:** Inherits #85 for real source interruptions, continuity, and independent-PDS convergence. Process-matrix completion is a separate deterministic harness task, not merely an operator prerequisite.
- **Contract/doc drift:** The case map still primarily credits composition restart. Some comments describe a “process” dying although the test recomposes in-process. Preserve the new SIGKILL credit while correcting this scope mismatch.
- **Evidence paths:** `worker/test/acceptance/federation.test.ts:402,495–499`; `worker/test/acceptance/restart.test.ts:44`; locally untracked `scripts/test/node-recovery.test.ts:277` as identified by the audit; ingestion snapshot/migration/rejection tests; `docs/verification/ts-case-map.json`; `docs/verification/implementation-agent-13.md`.

### #85 — Two-external-PDS live acceptance

**Disposition: keep open. No live federation pass exists.**

- **Tested deterministic behavior:** Prerequisite refusal and evidence-validator regressions. Refusal is correct fail-closed behavior but is not execution of the live federation matrix.
- **Remaining deterministic gap:** A **current-Node, release-bound live harness and inventory are missing**:
  - `scripts/live/federation_check.py --live` unconditionally blocks around historical Rust relay limitations. Credentials alone cannot make it execute a valid Node live run.
  - Workers ingest/soak scripts still depend on browser-public-client behavior, a TCP admin token, and/or Cloudflare analytics.
  - PDS compatibility checking alone does not perform the required create/update/delete/reconnect matrix.
  - The historical empty inventory and legacy verifier disagree on schema/product identity; metadata validation alone would not execute the matrix even after reconciliation.
- **Operator/live blocker:** Supply and prove, without recording secrets:
  - Owned namespace authority/publication evidence.
  - Public HTTPS **Node** metadata, JWKS, and callback, with secure configuration.
  - Dedicated identities on **two independently operated PDSs**.
  - Documented configured Jetstream coverage of both PDSs.
  - Independent create/update/delete activity and controlled interruption/recovery.
  - Monotonic arrival measurement meeting the **30-second** requirement.
  - Sanitized results bound to the actual release and evidence of cleanup.

  These operational inputs remain necessary **after** repairing the deterministic live tooling. No deployment or external-PDS operation was performed by the source audit or this documentation pass.
- **Contract/doc drift:** `docs/verification/federation-live.md` and `docs/verification/federation-fixtures.md` describe the old Rust path. Worker IDs, `ADMIN_TOKEN`, and Cloudflare billing analytics are not current Node prerequisites. Preserve useful acceptance requirements without treating obsolete infrastructure or disabled-Rust-relay explanations as the current Node blocker list.
- **Evidence paths:** `scripts/live/{federation_check.py,pds_compat_check.ts,workers_ingest_check.ts,workers_socket_soak.ts}`; `docs/verification/{federation-live.md,federation-fixtures.md,live-evidence.json}`. The audit's exact live-verifier command/result is recorded in the prior-receipts table above; no live-run result is inferred from it.

## Follow-up ordering and closure boundary

The source audit prioritizes the following implementation-owner actions; this record does not perform them:

1. Complete and reconcile #80/#68–70 delete visibility through PDS acknowledgement, proof-confirmed absence, failure, and recovery; the new local intent overlay is deterministic evidence but not the entire lifecycle.
2. Add the exact #81/#82 continued-feed-cursor mutation assertions.
3. Reconcile #83's demonstrated silent coverage-loss behavior and complete #84's broader current-Node process-level federation fault/convergence matrix.
4. Migrate #85/#109 live tooling and evidence identity to Node releases before requesting live inputs.
5. Reconcile published GitHub contracts with the accepted architecture. Draft amendment documents and structural case-map success do not themselves amend published requirements.

**All 17 covered issues remain open. No issue or milestone closure is justified by this audit. M7 is excluded.

## Deterministic Node follow-up — 2026-10-28

The current Node-host fixture docs in `docs/verification/federation-fixtures.md` explicitly separate legacy Rust/Axum receipts from current Node/Jetstream evidence. This addendum records deterministic feed-cursor regressions, a fake-PDS XRPC writer, controlled per-DID Jetstream omission, and child-process create/update/delete proof interruptions without changing the accepted architecture or published issue state.

- `worker/test/read/feed.test.ts › an existing following cursor continues after a verified unfollow between pages`: Alice starts a two-item following traversal (Bob then Carol), the fixture PDS commits Alice's unfollow of Bob, production verification applies it, and the same cursor still returns the followed Carol record. A fresh traversal contains only Carol's record. This is current-state pagination, not a promise of snapshot isolation.
- `worker/test/read/cursor-http.test.ts › global feed cursor applies the moved-row rule when an update crosses its timestamp boundary`: after the first global-feed page, an unreturned Alice record receives a verified update to a timestamp above the page's anchor. Continuation omits the moved record as the documented mutable-row rule predicts; a fresh traversal includes it in its new order. The previous history moved-row test remains mapped as additional evidence.
- `worker/test/acceptance/federation.test.ts › an independent XRPC createRecord reaches the index only through Jetstream and signed-record proof`: the fixture external writer calls Carol's fake PDS `com.atproto.repo.createRecord` endpoint, the app sees the commit via Jetstream, and the record remains absent until the production alarm obtains and verifies the record proof. It then appears with the returned CID in the index and feed. The acceptance helper separately counts app HTTP POSTs (`appHttpPosts`) and PDS call logs separately count PDS XRPC writes; both remain zero for application POSTs and application-initiated PDS writes in this direct-writer journey. This is fixture instrumentation, not independently-operated PDS interoperability or live network measurement.
- `scripts/test/node-recovery.test.ts › federation_process_recovery: second-PDS create/update/delete survive SIGKILL during proof and converge`: Bob is bootstrapped from a separate fake PDS. Independent PDS create, update and delete XRPCs each emit a Jetstream event; the create proof path first receives one transient 503, retries the durable hint, and then holds the successful `getRecord` response after the hint and cursor are durable while the child is SIGKILLed. Before the update, the fake PDS and fake PLC rotate Bob's signing key; the update proof is held across SIGKILL and restart must reject the persisted old cached key, fetch the changed DID document, and verify with the new key. Delete proof is also held across process death. Reopening the same database converges exact remote and projected state, including proof-confirmed absence in feed/history/stats after delete. The outage phase disconnects Jetstream, appends a second-PDS create while disconnected, SIGKILLs before reconnect, reconstructs the fake event log before socket startup, then proves cursor replay and exact remote/projection/feed/history/stats convergence after restart. It compares Bob's full active scrobble projection and follow set to the fake PDS (including the deleted URI remaining absent). This adds transient-proof retry, key-change re-resolution, durable reconnect/outage and exact per-actor set checks, but does not complete the full M4 multi-PDS fault matrix or live acceptance.
- `scripts/test_live_evidence.py › A complete PDS-compat preflight with no Jetstream coverage evidence is blocked offline`: using otherwise complete syntactically valid PDS-compat prerequisites, the test removes only `ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF`, confirms the blocked result names that prerequisite, and verifies the fetch trap saw no network attempt. This remains fail-closed preflight evidence, distinct from the separate controlled event-omission fixture.
- `docs/planning/workers-waves.json` W3-01 declares the two new read tests, W6-01 declares the external writer and coverage-negative tests, and W6-05 declares the offline coverage-prerequisite regression; the atproto fake-Jetstream test checks coverage on replay and live delivery. `docs/verification/ts-case-map.json` maps `M4.3.2/follow_change` and `M4.3.3/external_delete_update` to direct new evidence, retaining prior mutation/history tests as supporting cases. `M4.4.1/independent_write` retains the direct XRPC writer test while clarifying that the legacy `APP_WRITES` counter counts fake-PDS XRPCs, not application HTTP POSTs; `Acceptance.appHttpPosts` separately counts acceptance-helper POSTs and is asserted zero for the direct-writer case. `M4.4.1/coverage_failure` now maps to controlled per-DID event omission, with the offline missing-reference preflight as supporting evidence; it explicitly notes that runtime cannot detect the silent omission. `M4.4.2/worker_restart` maps to the child-process create/update/delete proof-interruption journey, retaining composition restart only as supporting evidence.

Fresh dirty-tree receipts on 2026-10-28:

| Command | Result |
| --- | --- |
| `npx vitest run --project worker-acceptance worker/test/acceptance/federation.test.ts worker/test/acceptance/mutations.test.ts worker/test/acceptance/restart.test.ts worker/test/acceptance/read-model-acceptance.test.ts` | **PASS**, 4 files / 19 tests (prior receipt before the new coverage-negative scenario). |
| `npx vitest run --project worker-modules worker/test/read/feed.test.ts worker/test/read/cursor-http.test.ts` | **PASS**, 2 files / 8 tests. |
| `npx vitest run --project scripts scripts/test/node-recovery.test.ts` | **PASS**, 1 file / 2 tests; the federation case now interrupts create/update/delete proofs at the second fake PDS across process restarts. |
| `python3 -B scripts/test_live_evidence.py` | **PASS**, 17 tests, including the offline missing-Jetstream-coverage-reference preflight regression; no live network attempt. |
| `npx vitest run --project worker-acceptance worker/test/acceptance/federation.test.ts` | **PASS**, 1 file / 7 tests, including controlled fake-stream event omission for Carol. Dirty-tree fixture evidence; no live PDS. |
| `npx vitest run --project atproto packages/atproto/test/fake-jetstream-link.test.ts` | **PASS**, 1 file / 2 tests, including replay/live coverage filtering and replay after coverage restoration. |
| `npx vitest run --project scripts scripts/test/node-recovery.test.ts` | **PASS**, 1 file / 2 tests; includes process death/restart during second-PDS create, update and delete proof fetches, plus a disconnected-stream second-PDS commit replayed from the durable cursor after process restart. |
| `python3 -B scripts/validate_case_map.py --check-tests --node-wave 4` | **PASS**, 258 cases; two later-wave targets correctly pending. |
| `python3 -B scripts/test_validate_case_map.py` | **PASS**, 16 regression tests. |

The latest full local gate passed after the transient-proof retry loop, DID signing-key rotation, complete per-actor projection comparison, M3 delete-lifecycle regressions, and receipt-doc updates: `bash scripts/check-ts.sh` completed with **224 test files / 918 tests passed, zero failed/skipped/todo**. It also passed typecheck, Biome (591 files), API/OpenAPI/lexicon contracts, case-map validation (258 unique cases) and all 16 validator regressions, the production bundle guard, Node server build check, and Node bundle guard. The Node build check reports main bundle SHA-256 prefix `3a78db7950d8…` and E2E bundle prefix `e8ad785541f4…`, both from dirty sources reporting base SHA `29453f8e8763083a3e3d7b10d5090285ef2f9d63`. These are local dirty-tree receipts, not hosted CI, a clean checkout, an accepted release, artifact provenance, or live acceptance.

Failed attempts and corrections: one full check failed because the secret-scan flagged full 64-hex artifact digests in the new evidence prose; the docs now retain only shortened digest prefixes. A subsequent full run exposed a timing assumption in the new 503 retry path (one fixture-clock pump followed by a wall-clock wait); the test now advances bounded manual-clock alarm slices until the next proof is held. An intervening lint-only run then requested formatting of that loop; formatting was corrected. The latest full gate above passed with the corrected versions.

Still outstanding: acknowledged-delete-through-proof and full deletion recovery semantics (#80 and linked M3 deletion issues); reconciling the controlled coverage-negative result (the current app stays `current` when Carol is silently omitted) (#83); the complete multi-PDS federation fault/convergence matrix across process death (#84), beyond the now-expanded proof-interruption and disconnected-stream replay scenarios; current-Node live tooling and genuine independent-PDS/Jetstream acceptance (#85). No production or GitHub mutation occurred. All M4 issues remain open; M7 is excluded.**

## Additional deterministic retry/restart evidence — 2026-10-28

The #84 child-process federation journey now injects one **503** response from Bob's fake PDS for the first `com.atproto.sync.getRecord` proof fetch after an external create. The test confirms the event hint and stream cursor are durable, allows the verifier's retry backoff to elapse on the fixture clock, and holds the next successful proof response while SIGKILL terminates the Node child. On restart, the same database replays the hint, verifies the record, and converges exact remote/projection state plus feed, history, and statistics. Before the update, the fake PDS and fake PLC rotate Bob's signing key; after the update proof is held across SIGKILL, restart must refresh DID resolution from the previously cached old key and converge on the new-key-signed record. Delete proof interruption and disconnected-stream cursor replay also run in this journey. After the outage replay, the test compares Bob's complete active scrobble projection and follow sets against the PDS, including the deleted URI remaining absent.

Receipts:

- `npx vitest run --project scripts scripts/test/node-recovery.test.ts` — **PASS, 1 file / 2 tests**, including the modified `federation_process_recovery` journey.
- `npx tsx scripts/acceptance/node-recovery.ts --out /tmp/atmusic-m4-recovery-final-pQg3e4` — **PASS**, 2 subprocess journeys executed, `dirty: true`, no problems. The summary identifies base commit `29453f8e8763083a3e3d7b10d5090285ef2f9d63`, Node `v26.12.1`, SQLite `3.54.1`, main bundle SHA-256 prefix `3a78db7950d8…`, and E2E bundle SHA-256 prefix `e8ad785541f4…`; the packaged report's `log` SHA-256 prefix `fd7e33fe6b01…` and `cases` SHA-256 prefix `26ff19550b7e…`. Its explicit uncovered list includes live PDS/Jetstream/OAuth/soak and other M6 acceptance areas; this is not full M4 acceptance.

Deterministic fake-PDS evidence only. It exercises one transient proof error/retry, key-change re-resolution, exact active scrobble/follow-set comparison, and outage replay through process death; it does not combine every #84 fault dimension into the same process-level journey (focused snapshot/live semantics are covered by the mapped `apply-snapshot.test.ts` case), reconcile #83's silent-coverage contract, or establish live acceptance. M4 issues remain open; no external service, production, GitHub issue, or milestone was mutated.
