# M5 issue-by-issue evidence record

**Scope:** M5 coordination issues **#21–#25** and leaves **#86–#97** (17 issues total). This record preserves their **OPEN** status; it is evidence accounting, not acceptance, closure, or a contract amendment. **M7 is explicitly excluded.**

## Evidence posture

The audit source is `/tmp/goal-audit-M5.md` (read-only). Its GitHub inspection found all 17 scoped issues open and reports no GitHub changes. The checkout was already dirty at base `29453f8e8763083a3e3d7b10d5090285ef2f9d63`; M5-relevant changes are uncommitted. Treat all receipts below as local/dirty-tree evidence, not clean committed, hosted CI, release provenance, or live acceptance. The original audit predates the HTTP rename/profile assertions and the targeted packaged-process rerun recorded below; use the updated local receipts, not the historical 47-test count. These deterministic results do **not** establish M5 GitHub closure or live acceptance.

Do not infer a clean working tree. The underlying read-only audit did not run tests or builds; the updated focused and packaged-process receipts below were executed locally on the dirty tree.

### Receipt stated by the audit source

The audit source reports this exact focused command and result:

```sh
npx vitest run --project worker-node --project worker-modules --project worker-acceptance \
  worker/test/read/stats.test.ts worker/test/read/stats-boundaries.test.ts \
  worker/test/read/stats-plan.test.ts worker/test/read/profile.test.ts \
  worker/test/read/resolve.test.ts worker/test/read/follows.test.ts \
  worker/test/read/feed.test.ts worker/test/acceptance/read-model-acceptance.test.ts \
  worker/test/acceptance/mutations.test.ts worker/test/acceptance/restart.test.ts \
  worker/test/node/outbox/follows.test.ts \
  worker/test/node/journey/follow-journey.test.ts
```

**Current focused result after the M5 HTTP assertions:** 52 passed across 12 files. This confirms deterministic fixture/test behavior on the dirty working tree only. It is not live, browser, hosted-CI, or clean-release acceptance. A separate packaged-process recovery test below passed its targeted run; it is evidence only for the asserted local child-process behavior, not hosted CI or live acceptance. Prior broader receipts are in `docs/verification/implementation-agent-13.md`; they are not reproduced here as M5 closure evidence.

A second scoped receipt exercised the packaged test-process path:

```sh
node_modules/.bin/vitest run scripts/test/node-recovery.test.ts -t 'packaged_recovery: SIGKILL after create and delete commits'
```

**Result:** 1 passed; 2 other tests skipped by the name filter; 1 file. The test builds/runs the guarded `worker/dist/node/e2e.mjs` fixture process against one temporary SQLite database and fake upstreams. It is deterministic local packaged-process evidence, not production `main.mjs` release provenance, hosted CI, or live acceptance.

## Issue evidence

For each issue, the four evidence dimensions are kept distinct:

- **Deterministic tested behavior:** what local tests/fixtures establish.
- **Remaining deterministic gap:** what the evidence does not yet establish, even locally.
- **Operator/live blocker:** external, hosted, browser, release-bound, or independently operated evidence still needed; `None specific` means no additional issue-specific live blocker was identified, not that the milestone is clear.
- **Contract/doc drift:** published issue/contract or repository documentation that differs from the current implementation/evidence.

### #21 — M5 milestone

- **Deterministic tested behavior:** Read-model APIs, profiles, statistics, follows and feeds have deterministic fixture, integration, mutation and restart tests. See the child issues below; primary areas include `worker/test/read/`, `worker/test/acceptance/`, and follow-specific tests.
- **Additional deterministic evidence:** `scripts/test/node-recovery.test.ts › packaged_follow_feed_recovery: second-PDS create, update and delete persist through process restarts` now exercises Alice following Bob while Bob's independent fixture PDS creates, updates, and deletes a scrobble. It compares following feed, Bob history/stats, and follow list across three stop/start boundaries; the test has a targeted passing receipt. Together with the #97 cursor/pending-delete journey and exact HTTP rename/profile tests, the mapped local two-account read/social behaviors now have deterministic coverage.
- **Remaining deterministic gap:** No additional deterministic behavior gap was identified for the task's mapped M5 cases. This does not reconcile the Rust-owned GitHub contracts or provide hosted, release-bound, browser, or live external-PDS acceptance.
- **Operator/live blocker:** No genuine external-PDS/live social-read acceptance or complete release-bound evidence.
- **Contract/doc drift:** The GitHub parent remains the governing published contract. Local Node work is not closure or amendment to it; its published architecture/acceptance requirements have not been reconciled.
- **Status:** OPEN (per audit-source GitHub inspection).

### #22 — M5.1 grouping and aggregates

- **Deterministic tested behavior:** TypeScript implementation is in `packages/core/src/music-key.ts`, `worker/src/do/write/keys.ts`, and `worker/src/do/read/stats.ts`. Statistics cover all/7d/30d/365d windows, inclusive UTC bounds, future exclusion, deterministic tie order, omitted albums, visibility, indexed queries, and cache behavior. Relevant tests: `worker/test/read/stats*.test.ts`, `worker/test/read/stats-plan.test.ts`, and acceptance tests.
- **Remaining deterministic gap:** The implementation is a Node/TypeScript port, not implementation in the leaf's named Rust files. Published wording and dependencies have not been reconciled to that architecture.
- **Operator/live blocker:** No separate live blocker for local algorithms; inherited release/live gates remain.
- **Contract/doc drift:** Leaf #86–88 specify Rust file ownership. `docs/benchmarks/stats.md` contains historical Rust-era text and should be read with current Node/ADR 0005 context.
- **Status:** OPEN.

### #23 — M5.2 profiles and handle lookup

- **Deterministic tested behavior:** Stable DID profiles, verified two-way handle resolution, unknown/inactive/empty/backfill behavior, and public-field serialization are implemented in `worker/src/do/read/profile.ts`, `worker/src/http/profile.ts`, and `worker/src/http/resolve.ts`. Coverage includes `worker/test/read/profile.test.ts`, `worker/test/read/resolve.test.ts`, identity-cache and account tests.
- **Remaining deterministic gap:** No specific missing local assertion has been identified for the mapped profile/handle/privacy cases; test placement across suites is not itself a contract gap. The leaf-specified Rust files are not the implementation, so architecture and owning-target reconciliation remains outstanding.
- **Operator/live blocker:** Live identity resolution and real PDS/handle interoperability are not evidenced.
- **Contract/doc drift:** `docs/profiles.md` describes the older Worker/no-session model; the current Node BFF has sessions. Reconcile with `docs/adr/0005-local-node-host-and-compat-apis.md` and published issue wording.
- **Status:** OPEN.

### #24 — M5.3 follows

- **Deterministic tested behavior:** Deterministic rkey, self-follow rejection, durable outbox, duplicate/external-follow indexing, distinct lists, visibility, account state, and proof-gated feed membership are tested. Current follow-outbox tests add atomic consecutive-intent reuse, FIFO across opposite intents, retry/restart, and fresh intent after a newer contrary proof. Relevant paths: `worker/src/outbox/follow-ops.ts`, `worker/src/do/schema.ts`, `worker/test/node/outbox/follows.test.ts`, `worker/test/read/follows.test.ts`, `worker/test/node/journey/follow-journey.test.ts`.
- **Additional deterministic evidence:** The new packaged `packaged_follow_feed_recovery` journey proves verified Alice→Bob membership and that Bob's independent-PDS create, update, and delete change following feed/history/stats correctly and persist across process restarts. The in-process journey separately proves queued/unverified/confirmed/unfollow feed membership. The prior `packaged_recovery` journey proves the follow list and cursor/pending-delete behavior across its restart sequence.
- **Remaining deterministic gap:** No further local behavior gap was identified for this task's follow identity/lifecycle/feed-transition contract. Live independently operated PDS behavior and release-bound acceptance remain unproven.
- **Operator/live blocker:** Real external-client/PDS behavior and release-bound social acceptance remain unproven.
- **Contract/doc drift:** `docs/follows.md` says the browser SPA writes directly to PDS and the server has no follow write routes; it also says same-kind requests keep separate IDs. Current Node BFF server-outbox/coalescing behavior supersedes that description. The published issue remains Rust-oriented.
- **Status:** OPEN.

### #25 — M5.4 acceptance

- **Deterministic tested behavior:** Shared fixture, exact read-model expectations, OpenAPI checks, follow/feed assertions, and durable composition-restart tests exist. Relevant paths include `tests/fixtures/read_models.json`, `worker/test/acceptance/read-model-acceptance.test.ts`, and `worker/test/acceptance/restart.test.ts`.
- **Remaining deterministic gap:** Unit/composition tests do not substitute for the published **packaged process** acceptance. The complete linked acceptance matrix is not demonstrated.
- **Operator/live blocker:** Deterministic fixture passes do not cover live social convergence.
- **Contract/doc drift:** GitHub suite/file ownership remains Rust-oriented, while current tests run in Worker/Node paths.
- **Status:** OPEN.

### #86 — Unicode grouping

- **Deterministic tested behavior:** NFKC, full Unicode 16 case-fold, whitespace normalization, typed tuple keys, newest display spelling, and album absence are implemented. Shared fixtures/core tests exercise grouping and collision behavior; Node/Worker compatibility is documented and tested. Key paths: `packages/core/src/music-key.ts` and `worker/src/do/write/keys.ts`.
- **Remaining deterministic gap:** The exact Rust-owned regression target in the issue is not the current execution target.
- **Operator/live blocker:** None specific to grouping.
- **Contract/doc drift:** Leaf names `crates/core/src/music_key.rs`; current implementation is TypeScript.
- **Status:** OPEN.

### #87 — rolling statistics

- **Deterministic tested behavior:** Exact windows, UTC `asOf`, bounds, totals/rankings, tie-breaking, and limits are covered by `worker/test/read/stats*.test.ts` and acceptance tests. Implementation is `worker/src/do/read/stats.ts`.
- **Remaining deterministic gap:** Published leaf requires Rust implementation and its named target; current equivalent is TypeScript/SQLite.
- **Operator/live blocker:** Current benchmark evidence does not establish live production performance or all release conditions.
- **Contract/doc drift:** Rust file ownership and the original contract require owner review; a port alone is not reconciliation.
- **Status:** OPEN.

### #88 — mutation correctness and plans

- **Deterministic tested behavior:** Update/delete aggregate effects and indexed plans are tested in mutation, statistics-plan, and acceptance query-plan suites, including negative controls. Paths include `worker/test/acceptance/mutations.test.ts`, `worker/test/read/stats-plan.test.ts`, and `worker/test/acceptance/query-plans.test.ts`.
- **Remaining deterministic gap:** Implementation/test ownership is Node rather than the Rust issue target. The implementation record reports local Node SQLite **3.54.1** only; official Node SQLite **3.54.0** execution is not established.
- **Operator/live blocker:** Hosted CI on pinned toolchains remains missing per `docs/verification/implementation-agent-13.md`.
- **Contract/doc drift:** `docs/benchmarks/stats.md` retains historical Rust wording alongside current Worker/Node tests; issue-owned Rust target differs from current path.
- **Status:** OPEN.

### #89 — verified handles / stable DID

- **Deterministic tested behavior:** Resolver enforces verified round trip; profile keys remain DID; handle rename/sweep behavior has deterministic coverage in `worker/test/read/resolve.test.ts`, `worker/test/read/profile.test.ts`, and identity sweep tests.
- **Additional deterministic evidence:** `worker/test/acceptance/mutations.test.ts › handle rename resolves the same DID over HTTP without changing its profile or cursor-paged history` now changes the fixture PLC/DoH/handle records, waits beyond the five-minute identity-cache TTL, verifies the new handle round trip and old-handle mismatch over HTTP, checks the exact public profile field set and stable DID/counts/join time, preserves complete DID-addressed history, and continues a pre-rename history cursor with the same rows/asOf. The delete acceptance in the same file also checks the immediate `no-store` profile response after projection removal and updated count/indexing state.
- **Remaining deterministic gap:** No remaining rename-specific HTTP gap was identified by this test. This is fixture evidence, not independent external resolver interoperability, and it does not resolve the Rust-owned target/architecture contract or the broader packaged M5 matrix.
- **Operator/live blocker:** No genuine public resolver/DID interoperability evidence.
- **Contract/doc drift:** Issue specifies Rust ownership; current implementation/tests use Node/Worker paths.
- **Status:** OPEN.

### #90 — unknown, empty, inactive

- **Deterministic tested behavior:** Unknown/inactive hidden profiles and recordless known profiles are covered; backfill/index state is reported. Visibility is checked before identity lookup. See `worker/test/read/profile.test.ts`, account-state tests, and resolver tests.
- **Remaining deterministic gap:** No deterministic behavior gap was identified for the mapped unknown, empty, and inactive cases. The published Rust test target is absent; the current implementation and tests use Node/Worker paths.
- **Operator/live blocker:** Live identity/backfill acceptance remains outside fixture evidence.
- **Contract/doc drift:** Rust-specific file ownership and Worker-era profile docs need reconciliation.
- **Status:** OPEN.

### #91 — privacy and caching

- **Deterministic tested behavior:** Public profile fields are whitelisted; profile reads are `no-store`, making local profile updates visible on the next read. Identity cache TTL is documented/tested. Security/journey tests check secret non-disclosure. Relevant paths include `worker/src/http/profile.ts`, `worker/test/read/profile.test.ts`, identity-cache, auth, and journey tests.
- **Additional deterministic evidence:** The delete acceptance obtains the public profile twice before deleting a record, then immediately reads it again and asserts `Cache-Control: no-store`, the exact eight-field whitelist, unchanged public identity/follow fields, and the updated total/indexing state. A separate `create r11` acceptance injects a new external PDS record, drains indexing without advancing the frozen clock, and asserts the next HTTP profile is `no-store`, retains the exact public-field allowlist, and immediately reports eight listens with current indexing. These are distinct fixture checks for create and delete.
- **Remaining deterministic gap:** The issue's three named deterministic cases are mapped to executable fixture tests: `sensitive_fields` to the credential-rich anonymous secret-redaction journey (including the exact eight-field profile allowlist), `owner_equality` to `worker/test/node/http/writes.test.ts › public v1.1 read responses are byte-identical with and without the owner's session cookie`, and `cache_invalidation` to separate direct HTTP profile-after-create and profile-after-delete acceptance tests. The owner-equality test compares anonymous, owner-session (with/without CSRF), and another user's session across eight populated public reads; the two cache tests assert freshness after indexing the new `r11` and deleting existing `r01`, with no wait/clock advance. Statistics-cache tests remain supporting evidence, not a substitute for the HTTP profile cases. No additional deterministic behavior gap was identified for these named cases; the published Rust target/architecture and external/live acceptance remain unresolved.
- **Operator/live blocker:** Live origin/session and external identity behavior remain outside deterministic proof.
- **Contract/doc drift:** `no-store` is stricter than the issue's maximum 60-second caching, but `docs/profiles.md` still describes a server with no sessions while the current architecture has sessions.
- **Status:** OPEN.

### #92 — publish/delete idempotent follows

- **Deterministic tested behavior:** The current diff adds duplicate same-intent identity, retry/restart, blocked/running, FIFO, failed/cancelled re-admission, and proof-revision refresh tests. `worker/src/outbox/follow-ops.ts` records an admission-time contrary-proof baseline in additive migration 3; tests in `worker/test/node/outbox/follows.test.ts` cover concurrent admission, receipt reuse, retries, restart, and contrary proofs. `worker/test/node/journey/follow-journey.test.ts` checks queued versus verified outcomes. Implementation record's later addenda clarify causal proof-baseline handling; do not use the superseded timestamp-based account.
- **Remaining deterministic gap:** Follow receipt identity/retry semantics now have deterministic coverage, but the follow journey is not the full packaged M5 read/feed acceptance. Restart-after-remote-write in this focused scope does not prove packaged feed/read-model persistence.
- **Operator/live blocker:** No live PDS run.
- **Contract/doc drift:** `docs/follows.md` describes direct browser PDS writes and distinct IDs, conflicting with current Node BFF server outbox and coalescing semantics. GitHub issue names Rust files.
- **Status:** OPEN.

### #93 — external follows and lists

- **Deterministic tested behavior:** External duplicate collapse/deletion, visible confirmed relationships, stable cursor pagination, and follow counts are covered in `worker/test/read/follows.test.ts`, acceptance, and account-state tests.
- **Remaining deterministic gap:** No unresolved deterministic behavior was identified in the focused run; tests use current TS/SQLite rather than the issue's Rust-owned paths.
- **Operator/live blocker:** External-client interoperability remains fixture-only.
- **Contract/doc drift:** Published Rust ownership differs from current Worker/Node paths.
- **Status:** OPEN.

### #94 — feed membership

- **Deterministic tested behavior:** `worker/test/node/journey/follow-journey.test.ts` proves queued and acknowledged-but-unverified follows do not enter following feed; proof-confirmed follow does; unfollow removes the target without changing global feed. External delete/re-add and account-state tests provide related coverage.
- **Remaining deterministic gap:** Journey is in-process fixture integration, not the full packaged restart or live acceptance matrix.
- **Operator/live blocker:** No independently operated PDS/real federation evidence.
- **Contract/doc drift:** `docs/follows.md` describes a public following feed but its browser/direct-write architecture is stale for the Node BFF.
- **Status:** OPEN.

### #95 — deterministic fixture

- **Deterministic tested behavior:** `tests/fixtures/read_models.json`, its validator, and `worker/test/acceptance/read-model-acceptance.test.ts` provide fixed data, hand-calculated expectations, and frozen-time behavior. `scripts/validate_read_fixture.py` validates integrity and reproducibility. Federation acceptance asserts complete signed payloads.
- **Remaining deterministic gap:** The named JSON fixture exists, but execution is TS/Python rather than the specified Rust fixture target.
- **Operator/live blocker:** Fixture validation does not substitute for live PDS acceptance.
- **Contract/doc drift:** Leaf contract names `tests/fixtures/read_models.json` and `docs/planning/TESTING.md`, but Rust owning-test contract is stale relative to Node implementation.
- **Status:** OPEN.

### #96 — exact HTTP read/social assertions

- **Deterministic tested behavior:** Exact API read payloads, global/following feeds, profiles, statistics, pagination, follow counts, and mutation consequences are tested across acceptance/read/follow suites; the updated focused run reports 52 passing tests across 12 files.
- **Additional deterministic evidence:** The new mutation acceptance directly covers handle rename over public HTTP, unchanged DID-addressed profile/history, a cursor continuation across the rename, and immediate public-profile freshness after a delete. The packaged-process test separately checks history, following list, statistics, cursor continuation, and pending-delete visibility across process restarts.
- **Additional deterministic evidence:** The new packaged two-account fixture journey exercises remote create/update/delete and follows feed membership across restarts; the mapped owner-equality test compares public HTTP reads with anonymous, owner, and another user's sessions. Read acceptance, mutation/rename, profile freshness, and cursor cases are mapped to executed tests.
- **Remaining deterministic gap:** No deterministic behavior gap was identified among the issue's three named acceptance cases after this addition. The executable tests remain Node/TypeScript rather than the Rust-owned file, and fixture evidence does not substitute for browser/live or release-bound acceptance; GitHub remains unchanged/open.
- **Operator/live blocker:** No browser/live release-bound acceptance.
- **Contract/doc drift:** Published Rust test filename differs from current Node/Worker test paths.
- **Status:** OPEN.

### #97 — packaged restart persistence

- **Deterministic tested behavior:** `scripts/test/node-recovery.test.ts › packaged_recovery: SIGKILL after create and delete commits reconciles durable operations, views, cursor and checkpoint on the same database` exercises the guarded `e2e.mjs` child process against the same temporary database across multiple restarts. It compares history pages, following-list and statistics responses across a clean restart at an unchanged injected clock, verifies cursor continuation without repeating the prior row, retains the app-session cookie, and SIGKILLs while delete proof is in flight; the deleted row stays hidden after restart and converges to absence without resurrection. Its targeted local run passed (1 test; 2 unrelated tests skipped by filter). Companion test `packaged_follow_feed_recovery` adds a second account's remote create/update/delete and compares its populated following feed, history, stats and follow list across restarts; targeted run passed (1 test; 3 unrelated tests skipped). `worker/test/acceptance/restart.test.ts` is composition-restart evidence and remains distinct.
- **Remaining deterministic gap:** No remaining local behavior gap was identified for the named durable-view, cursor, or pending-delete cases. The executed process is the guarded test `e2e.mjs` bundle with fake upstreams, not a clean production release artifact, hosted CI or live acceptance.
- **Operator/live blocker:** No hosted CI, clean release provenance, or live social acceptance is evidenced.
- **Contract/doc drift:** The executable path is TypeScript/Node rather than the issue's Rust-owned `crates/server/tests/read_model_restart.rs`; the GitHub issue remains open and architecture/acceptance direction is not amended.
- **Status:** OPEN.

## Cross-cutting blockers and drift

The implementation record says hosted CI with pinned Rust/official Node, live OAuth/PDS/federation evidence, Node live-evidence migration, and publication/release acceptance remain outstanding. These are operator/live gates, not failures of deterministic M5 fixture tests. In particular, the implementation record reports only local SQLite 3.54.1 execution, no official 3.54.0 execution, no hosted CI claim, no live PDS/Jetstream/soak run, and no clean release provenance.

The most consequential contract mismatch is architectural: GitHub leaf contracts still name Rust crates and Rust acceptance files, whereas current implementation is Node/TypeScript. `docs/follows.md` describes a direct-PDS browser SPA, while the Node BFF uses sessions and a server outbox, including consecutive same-intent coalescing. `docs/profiles.md` documents the Worker no-session model. `docs/benchmarks/stats.md` includes historical Rust wording alongside current Node/Worker tests. `docs/adr/0005-local-node-host-and-compat-apis.md` records the Node architecture, but is not itself a published amendment to the issue contracts. `docs/verification/implementation-agent-13.md` is the current scoped execution record and explicitly does not claim M5 closure or live acceptance.

## Evidence paths used or referenced

- Audit input: `/tmp/goal-audit-M5.md` (read-only source).
- Prior execution record: `docs/verification/implementation-agent-13.md`.
- Implementation: `worker/src/do/read/{stats,profile,follows,feed}.ts`, `worker/src/do/write/keys.ts`, `worker/src/outbox/follow-ops.ts`, `worker/src/do/schema.ts`, `packages/core/src/music-key.ts`.
- Deterministic tests: `worker/test/read/`, `worker/test/acceptance/` (including the new HTTP rename/profile assertions in `mutations.test.ts`), `worker/test/node/outbox/follows.test.ts`, `worker/test/node/journey/follow-journey.test.ts`, and `scripts/test/node-recovery.test.ts` for its specifically scoped subprocess journeys.
- Fixture/validation: `tests/fixtures/read_models.json`, `scripts/validate_read_fixture.py`.
- Contracts/docs: `docs/planning/MVP.md`, `docs/planning/TESTING.md`, `docs/follows.md`, `docs/profiles.md`, `docs/benchmarks/stats.md`, `docs/adr/0005-local-node-host-and-compat-apis.md`.
- Read-only GitHub inspection and issue-state summary are as reported by `/tmp/goal-audit-M5.md`; exact inspection commands/results are not expanded beyond that source.

### Post-audit #91 traceability correction

The published #91 `sensitive_fields` case explicitly requires both dummy secret **values** and private **field names** to be absent from an anonymous profile. The Node secret-logs journey already seeded credential-rich state and checked values over public read responses; it now additionally asserts the exact eight-field public-profile allowlist for the anonymous profile response. The case map's #91 `cache_invalidation` entry now maps direct HTTP profile freshness after both an indexed create and a delete (separate tests); statistics-cache tests remain supporting evidence only. This corrects traceability without implying that test colocation is a contract requirement.

- `npx vitest run --project worker-node worker/test/node/journey/secret-logs.test.ts`: **2 passed**.
- `npx vitest run scripts/test/node-interim.test.ts`: **1 passed**.
- `python3 scripts/test_validate_case_map.py`: **16 passed**. The initial module-style invocation did not import the script because `scripts/` was not on `sys.path`; the direct test-file invocation above is the successful receipt.
- `python3 scripts/validate_case_map.py --check-tests --node-wave 0`: **258 unique cases**, 252 mapped, 6 retired, all wave-zero names exist, **95** later Node-wave targets pending. The M5 profile test is in `workers-waves.json`; the latest M6 origin/body/rate supporting targets account for five additional Node-wave references.
- `npx vitest run worker/test/acceptance/mutations.test.ts worker/test/read/export.test.ts worker/test/node/journey/secret-logs.test.ts`: **10 passed** across three files, including immediate profile freshness after create/delete, Bob-owned private-operation marker exclusion, and a successful credential-rich anonymous export.
- Latest `bash scripts/check-ts.sh`: **exit 0**, **225 files / 932 tests passed**, zero failed/skipped/todo; report accounting 932/932. The Vitest phase took **703.09 s**. Receipt: `/tmp/atmusic-check-ts-final22.log`; it includes the M5 create/delete profile-freshness tests, M6 #105 export-secret assertions, additional M6 case-map evidence, and installer unique-temp/read-only-unit/`--init` child-timeout and recovery-copy regressions for command failures before the current-link commit. This is local dirty-tree evidence, not hosted CI, release provenance, or live acceptance.
- `git diff --check` and JSON parsing of `docs/verification/ts-case-map.json`: **pass**. These are local dirty-tree checks, not hosted CI, release provenance, or live acceptance.
