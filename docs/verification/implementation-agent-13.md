# M1–M6 deterministic gap implementation record (agent 13)

Base: `29453f8e8763083a3e3d7b10d5090285ef2f9d63` (`feat/mvp-complete`).
This is a scoped implementation/check record, **not milestone acceptance**.
The dated agent-2 and follow-up verification addenda below record later
changes/results and supersede only their corresponding initial statements;
the initial ledger is retained.
No deploys, live credentials, GitHub mutations or external-PDS requests were
performed. No new issue was needed: the verified gaps belong to existing
#41/#43, #58, #84, #103/#108 and their existing coordination issues.

## Changes

- CI Rust job installs `.nvmrc` Node and `npm ci` before Python regressions
  invoke TypeScript. A static workflow regression protects ordering in both
  CI jobs. This repairs a missing prerequisite, not proof of green hosted CI.
- SQLite query-plan gates accept the official Node build's 3.54.0 and the
  owner's system 3.54.1; all EXPLAIN/index/seek and no-index negative controls
  remain. Benchmark receipts record the actual engine, validate the two
  supported baselines and reject environment/plan version disagreement.
  Existing 3.54.1 test titles remain stable for inventory/case-map compatibility.
- SQLite adapter tests observe `raw.prepare` and statement `close()` instead
  of requiring `SQLITE_ENABLE_STMTVTAB` / `sqlite_stmt`. They prove refusal
  before prepare, LRU hits, exact eviction/finalization, bounded live statements
  and close finalization without adding a production test hook.
- Node HTTP logout injects revocation HTTP 500; checks local cookie/session
  invalidation, subsequent 401, journal entries, local sign-out logging and
  absence of tokens/CSRF/upstream-body secrets. The upstream fixture session
  remains active. The OAuth library swallows endpoint failures: a local
  `revoked` outcome is **not evidence of successful upstream revocation**.
  The case map now uses this test as primary, retaining the historical browser
  regression as additional baseline only; N3-01 declares the new test.
- Federation recovery compares the complete persisted remote payload set
  (all schema-v1 and v1.2 fields plus owner/rkey/URI/CID), and complete follow
  URI/CID/actor/subject/createdAt. Optional payload values are exercised in
  the gap-recovery record. Derived music keys, repository revision and local
  bookkeeping timestamps are not raw payload fields; their separate tests
  remain. Expected records come from the independent signers, not projector
  output.
- README now describes the accepted Node BFF and its unfinished browser port.
  Historical validation/milestone/MVP/namespace text is visibly scoped rather
  than silently re-counted. Storage docs distinguish Node migrations and
  private state from the Workers design; `storage-rust.md` documents the
  original SQL columns, constraints, foreign keys and indexes for #43.

## Execution ledger

Executed 2026-10-28 against the working tree based on the SHA above. Final
ledger edits are documentation-only. Local runtime: Node **v26.12.1**, SQLite
**3.54.1**, npm **11.20.0**; rustc/cargo **1.99.0**, Clippy **0.1.99**. Rustup
and pinned Rust 1.90.0 are unavailable. No pinned-toolchain or hosted-CI pass is
inferred. Optional LSP/AST navigation tools were unavailable in this harness;
TypeScript build diagnostics were used instead.

All commands below ran from the repository root. Logs and generated receipts
are retained locally (gitignored) under
`work/verification/implementation-agent-13/`. Focused runs overlap the broad
runs; their counts are **not additive**.

| Exact command | Result |
|---|---|
| `npm run --silent typecheck` | Exit 0 (also passed inside the final gate). |
| `npx vitest run --project scripts --project worker-node --project worker-acceptance scripts/test/ci-workflow.test.ts worker/test/node/sqlite-db.test.ts worker/test/node/http/auth.test.ts worker/test/acceptance/federation.test.ts` | Exit 0; **30 passed, 4 files** (`agent13-focused-final.log`). |
| `npx vitest run --project worker-bench` | Exit 0; **6 passed, 1 file** (`agent13-bench.log`). |
| `bash scripts/check-ts.sh` (final rerun) | Exit **0**; **888 passed / 0 failed / 0 skipped / 0 todo, 221 files**. All nine steps passed: typecheck, Biome, Vitest/report records, contracts, structural case map, 16 validator regressions, Workers bundle guard, Node build check and Node bundle guard. Total **227.788 s** (`agent13-check-ts-final2.log`, `gate-durations.json`, `ts-test-report.json`, `ts-test-cases.jsonl`). |
| `npx tsx scripts/benchmark-read-models.ts --no-docs --out work/verification/implementation-agent-13/benchmark.json` | Exit 0; **6 passed**, actual SQLite 3.54.1, 100,000-row fixture, 600 unpaced measured requests, 0 errors, HTTP p95 about **0.64827 ms**, report verdict passed. No benchmark docs overwritten. This is **not** the 2-vCPU/2-GiB paced acceptance workload (`agent13-benchmark-cli.log`, `benchmark.json`). |
| `.venv/bin/python scripts/validate_contracts.py` | Exit 0; API 1.2, **53 methods / 47 paths, 69 schemas, 67 fixtures, 236 response/status cases**, including negative controls. This proves the current amended API, not reconciliation with original GitHub wording (`agent13-contracts.log`). |
| `python3 scripts/validate_plan.py` | Exit 0; 7 milestones, 121 issues, 86 leaves, 258 specifications; acyclic graph and exact fixture expectations (`agent13-plan.log`). |
| `python3 scripts/validate_case_map.py --check-tests --node-wave 4` | Exit 0; **258 cases, 252 mapped, 6 retired, 2 later-wave targets pending** (`agent13-case-map-final2.log`). The new Node outage mapping is declared and exists. |
| `python3 -m unittest discover -s scripts -p test_validate_case_map.py` | Exit 0; **16 passed** after updating the expected wave-0 pending count to 51 targets / 49 unique cases (`agent13-case-map-regressions.log`). |
| `python3 scripts/test_live_evidence.py` | Exit 0; **16 passed**; deterministic refusal/validator regressions only (`agent13-live-regressions.log`). |
| `/home/june/go/bin/actionlint -no-color .github/workflows/ci.yml` | Exit 0, no diagnostics (`agent13-actionlint.log`). |
| `cargo fmt --all --check` | Exit 0, no diagnostics (`agent13-rust-fmt.log`). |
| `CARGO_TARGET_DIR=/tmp/agent13-rust-target CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_INCREMENTAL=false CARGO_PROFILE_TEST_INCREMENTAL=false cargo test --locked -p atmusic-storage --tests` | Exit 0; **38 passed**, no failures or ignored tests (`agent13-storage.log`). |
| `CARGO_TARGET_DIR=/tmp/agent13-rust-target CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_INCREMENTAL=false CARGO_PROFILE_TEST_INCREMENTAL=false cargo test --locked --workspace --all-targets` | Exit 0; **345 passed, 0 failed, 1 ignored**. The ignored `fixture_child_server` is an explicitly invoked fault-test child entrypoint, not a live acceptance pass (`agent13-rust-workspace.log`). |
| `python3 scripts/validate_case_map.py --check-tests` | Exit **1**: missing `scripts/e2e/scrobbler-e2e.ts` (M3 live_retries) and `web/test/session/client.test.ts` (M7 csrf_client). No placeholder was added to manufacture closure (`agent13-case-map-unrestricted.log`). |
| `python3 scripts/verify_live_evidence.py` | Exit **2/BLOCKED**: inventory is schemaVersion 1 while the legacy verifier expects Worker schemaVersion 2. **No live tests ran**. This is not a current Node evidence inventory (`agent13-live-blocked.log`). |

The fresh target directory was created before Rust checks, avoiding the audited
stale generated-asset cache. The Rust check-script invocation was:

```sh
export CARGO_TARGET_DIR=/tmp/agent13-rust-target
export PATH="$PWD/.venv/bin:$PATH"
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_PROFILE_DEV_INCREMENTAL=false CARGO_PROFILE_TEST_INCREMENTAL=false
bash scripts/check.sh
```

It exited **101** at Clippy: **15 `double_must_use` errors** in the existing
`crates/atproto/src/` async-trait code under **1.99.0**. Before that, plan,
contracts, read-fixture validation, 16 live-evidence regressions, 8 release-audit
regressions, 7 legacy OAuth-helper regressions, 2 acceptance-runner regressions,
formatting and build-graph validation passed. Its workspace-test step did not
run; the separate explicit workspace command above did. See
`agent13-check-rust.log`. No lint suppression or oracle change was made merely
to satisfy an unpinned local toolchain.

The benchmark CLI's external report validator was additionally checked with:

```sh
npx tsx -e 'import {readFileSync} from "node:fs"; import {reportErrors} from "./scripts/benchmark-read-models.ts"; const r=JSON.parse(readFileSync("work/verification/implementation-agent-13/benchmark.json","utf8")); if(reportErrors(r).length) throw Error("valid report rejected"); r.plans.sqlite=r.environment.sqlite==="3.54.1"?"3.54.0":"3.54.1"; const errors=reportErrors(r); if(!errors.some(e=>e.includes("must equal"))) throw Error("mismatch accepted"); console.log("PASS benchmark CLI validator accepts measured report and rejects cross-version mismatch");'
```

Exit **0** (`agent13-benchmark-validator.log`). Both the in-suite and external
report validators now reject a plan/environment version mismatch.

### Failed/interrupted development checks (not omitted from accounting)

- One exploratory full gate was interrupted before completion while the new
  test's wave declaration was being wired. It is not counted as a pass.
- The first completed broad rerun returned **1** with **884 passed / 4 failed**
  of 888 (`agent13-check-ts-final.log`). The failures were the newly increased
  pending-target count in validator/interim-gate expectations (and two nested
  gate controls inheriting that failure), plus the benchmark's duplicated
  in-suite validator missing the new version-equality check. These were fixed;
  the final full rerun above passed, with no skips or suppressed assertions.
- Early focused test-authoring runs caught a recursive driver spy (capture the
  original method before spying), a JSON-schema assertion on a no-body 204,
  and invalid fixture `musicService` values (the record requires a DNS name).
  The final tests use a non-recursive spy, explicit 204/body/cookie assertions
  and `music.example.test`; these were test-authoring mistakes, not product
  defects or claimed live failures.

The Node build/guard passed over **204 production sources**, but its embedded
SHA is the base HEAD while this work is uncommitted. The build check explicitly
reports the missing Node E2E entry. It is **not a release publication receipt**.
No Playwright/current-Node browser acceptance, installer activation, hosted CI,
official Node/SQLite 3.54.0 execution, or real PDS/Jetstream/soak run is claimed.

## Changed files

- CI/tooling: `.github/workflows/ci.yml`, `scripts/benchmark-read-models.ts`,
  `scripts/test/ci-workflow.test.ts`, `scripts/test/node-interim.test.ts`,
  `scripts/test_validate_case_map.py`.
- Backend tests: `worker/test/node/sqlite-db.test.ts`,
  `worker/test/node/http/auth.test.ts`, `worker/test/acceptance/federation.test.ts`,
  `worker/test/acceptance/query-plans.test.ts`,
  `worker/test/bench/read-models.bench.test.ts`, `worker/test/read/keyset.test.ts`,
  `worker/test/storage/status.test.ts`.
- Scope/mapping/docs: `README.md`, `docs/MILESTONE_STATUS.md`,
  `docs/VALIDATION.md`, `docs/adr/0001-namespace.md`, `docs/planning/MVP.md`,
  `docs/planning/node-waves.json`, `docs/storage.md`, `docs/storage-rust.md`,
  `docs/verification/ts-case-map.json`, and this record.

## Remaining work / no closure claims

- Hosted CI still needs a fresh green run with pinned Rust 1.90.0 and official
  Node. Accepting 3.54.0 is a portability correction, not a claim that this
  machine executed the official binary. Query-plan assertions remain fail-closed
  if that build differs.
- #39/#42 and original issue matrices still require explicit owner/reviewer
  reconciliation with ADR 0005; amendment documents remain draft/unpublished.
  No retirement, published issue body, performance/live acceptance threshold or issue state was changed.
- Browser server-session/CSRF and owner-operation overlays, final Node browser
  and packaged acceptance, Node live harness and bundle-bound evidence,
  current release workflow and complete semantic case-map refresh remain.
- M3 semantics/retention and process-kill lifecycle evidence, M5 repeated follow
  operation identity / queued-to-confirmed feed evidence, and M6 constrained
  paced benchmark evidence are not resolved by these scoped test changes.
- The Rust release workflow still packages the retired product and has the same
  mixed-language prerequisite concern; it is not a Node publication pipeline.
- Live #61/#73/#85/#109 stay open: public HTTPS Node origin/metadata/JWKS,
  namespace authority, secure configuration, dedicated identities on two
  independently operated PDSs, Jetstream coverage, OAuth refresh/revocation,
  create/update/delete/recovery, follow/feed/history/statistics, restore and soak
  require genuine sanitized evidence bound to the actual release commit/hash.
  Worker ids, ADMIN_TOKEN and Cloudflare Analytics are obsolete Node blockers.
- Namespace selection exists, but ownership evidence does not. The publication
  gate remains closed. That is distinct from M1's permitted fail-closed behavior.
- `live-evidence.json` remains an empty historical artifact inventory. A refusal
  or fixture pass does not count as a live result. No milestone/issue is closed.

---

## Addendum — milestone implementation agent 2 (2026-10-28)

This follow-up preserves the initial ledger above; statements there about the
then-missing tests/tooling are superseded **only in the scoped areas below**.
Same base HEAD and runtime: Node **26.12.1**, measured SQLite **3.54.1**,
Rust **1.99.0**. The checkout was already dirty; its prior edits were preserved.
No M7 implementation, deploy, live credentials, GitHub mutation or issue closure.
GitHub #72, #92, #96, #107 and #108 were inspected read-only. Existing issues
already cover every remaining actionable gap found here; no duplicate/new issue
was created. Published Rust/static ownership and acceptance wording remains
unreconciled; this record does not silently amend those contracts.

### Implemented and executable evidence

| Area | Exact scope now established | Primary executable proof |
|---|---|---|
| SQLite inventory consistency | The current query-plan/keyset titles, inventory replacements, wave declarations and ADR baseline wording now consistently allow **3.54.0/3.54.1**, distinguishing supported engines from measured execution. Baseline history/title identities in the original inventory remain intact. Version agreement and negative plan controls remain enforced. | `scripts/test/test-inventory.test.ts`, `worker/test/read/keyset.test.ts`, `worker/test/acceptance/query-plans.test.ts`, status/bench suites; final broad and focused runs below. **Only 3.54.1 was executed here.** |
| M5 repeated intent identity | Atomic latest-intent admission reuses consecutive same-kind queued/running/blocked/succeeded follow or unfollow receipts, preserving payload, attempts, backoff and dependencies. Opposite intents get distinct ids and preserve FIFO (`follow → unfollow → follow`). Failed/cancelled intents permit fresh admission. A strictly newer verified contradictory remote change also permits a fresh intent, so another client's change does not permanently suppress future writes. | New tests in `worker/test/node/outbox/follows.test.ts`: concurrent admission, retry, running/blocked replay, reopen, success, identity scoping, failed/cancelled re-admission; original FIFO/remote duplicate tests still pass. |
| M5 queued-to-confirmed feed | Node BFF sign-in and cookie/CSRF writes → real server outbox → DPoP-only fixture PDS → proof drain → public reads. Queued **and acknowledged-but-unverified** follows leave following feed empty. Proof-verified indexing includes Bob's exact indexed listen; self-follow is 422, duplicates share ids, unfollow removes Bob and global feed never changes. Verified external delete/recreate scenarios also exercise both contrary-proof admission branches. | `worker/test/node/journey/follow-journey.test.ts`. This is **in-process integration**, not browser/live acceptance. |
| M3 operation-payload minimization | Successful acknowledged/reconciled scrobble deletion clears only matching succeeded create receipts' `record_json` and `digest` in the settlement transaction. Minimal identity/status/result, request hash, idempotency key and listen dedupe remain durable. Failed deletion retains recovery data; unrelated payloads remain. A replay after deletion/restart returns the original operation and does not republish. | New `worker/test/node/outbox/delete.test.ts` test plus HTTP replays after deletion in the subprocess journey. **Not** general TTL pruning or erasure from imports/forwards/backups/third parties. |
| M3/M5 current-process recovery | Actual Node child processes are SIGKILLed after fixture PDS create/delete commits and before the response reaches the child; SQLite remains on disk, upstream fixtures survive in the parent. Restart resumes the same operation/rkey/digest/swap CID, reconciles one remote write/delete, preserves a second listen, history/follow lists/stats/session, pre-restart cursor traversal and checkpoint. | `scripts/test/node-recovery.test.ts` builds real main/e2e bundles and runs the guarded e2e subprocess. The guard verifies **204 production source inputs**, identical shared main/e2e content hashes and no fixture bypass in production main. `main.mjs` itself still has separate real-process readiness/shutdown tests. |
| M6 deterministic candidate tooling | `scripts/package-node-release.ts` checks `vX.Y.Z` against root Node manifest and both root lock versions; refuses dirty trees, stale inputs, guard/build-info/embedded-SHA mismatch and unpinned Node; inventories actual main bundle/hash, lockfile/runtime/assets; excludes e2e host; normalizes tar/gzip metadata and writes SHA256SUMS. | Extended `scripts/test/build-server.test.ts` builds production sources in a committed disposable checkout, proves byte-identical repeat archives, checks real `sha256sum -c`, rejects a one-byte tamper, mismatching version, dirty source and committed stale build. Root Node version is **0.0.0**, not Cargo's 0.1.0. This is a test candidate, not a release of this dirty checkout. |
| M6 scoped evidence runner | `scripts/acceptance/node-recovery.ts` builds/guards bundles, runs the subprocess test against those exact files, rejects omitted/skipped/failed/duplicate required cases, clears stale reports, hashes logs/case records, and records commit **plus dirty flag**, actual Node/SQLite and both bundle hashes. Summary explicitly lists untested acceptance areas. | Actual CLI run below, `scripts/test/node-recovery-runner.test.ts` positive/negative accounting controls and refusal of skip/filter arguments. **One executed journey**, not artificial per-assertion test counts or full case-map closure. |
| M6 candidate workflow | New `.github/workflows/node-candidate.yml`: manual-only, read-only, pinned Node + locked install, tag check, deterministic gate, unsuppressed production npm audit, asset build, scoped subprocess acceptance, candidate packaging/checksum and evidence upload. No activation/deploy/release publication. | Static workflow ordering/safety regression in `scripts/test/ci-workflow.test.ts` and actionlint. **No hosted execution, audit result or published release is claimed.** Legacy `release.yml` is still a Rust pipeline. |

The separate `worker/test/e2e/node-entry.ts` is an **IPC recovery fixture host**,
not the completed Playwright/browser migration. It imports the same production
`run()`/features, injects only fixture transport/Jetstream, clock and timers,
and adds no HTTP test route or production environment bypass. The production
entry was not relaxed. No frontend source file changed.

The case map/wave declarations now name the new evidence where appropriate;
partial kill-after-delete/packaged-restore cases explicitly retain limitations.
M6 tag/checksum mappings now use the actual Node candidate controls rather than
crediting only version printing or the retired Worker checksum. The ADR's
corresponding remap row and validator's exact expectations were updated together.
Wave-0 accounting is now **64 pending target refs / 57 distinct cases**;
wave-4 still has the same two genuinely missing later targets. The unchanged
258-case count is structural accounting, not a full acceptance verdict.

### Follow-up execution ledger

Logs/receipts are under `work/verification/implementation-agent-13/`, gitignored.
Focused runs overlap the broad run; counts are **not additive**.

| Command | Result |
|---|---|
| `bash scripts/check-ts.sh` (final, `agent2-check-ts-final3.log`) | **Exit 0; 898 passed, 224 files, 0 failed/skipped/todo**, all nine gate steps passed, **189.041 s** total. Includes typecheck, Biome, all Vitest projects, contracts, structural map, 16 Python validator regressions, Workers guard, Node main/e2e builds and shared-input guard. Copies: `agent2-gate-durations.json`, `agent2-ts-test-report.json`, `agent2-ts-test-cases.jsonl`. |
| `npx vitest run --project worker-node --project worker-modules --project scripts --project worker-bench worker/test/node/outbox worker/test/node/journey/follow-journey.test.ts worker/test/read/keyset.test.ts worker/test/storage/status.test.ts worker/test/node/sqlite-db.test.ts worker/test/bench/read-models.bench.test.ts scripts/test/test-inventory.test.ts` | **Exit 0; 75 passed, 15 files** (`agent2-focused-final.log`); includes six benchmark/validator tests on measured SQLite 3.54.1. No constrained paced benchmark claim. |
| `npx vitest run --project scripts scripts/test/{ci-workflow,test-inventory,node-recovery-runner,build-server}.test.ts` | **Exit 0; 15 passed, 4 files** (`agent2-tooling-final.log`). Candidate packaging tests use the actual production build in a disposable committed source copy, not a fabricated executable. Also included in final gate. |
| `npx tsx scripts/acceptance/node-recovery.ts --out work/verification/implementation-agent-13/node-recovery-final` | **Exit 0; 1 required journey executed/passed** against the emitted bundles; `summary.json`, `vitest.json`, `cases.jsonl`, `run.log` and bundles retained there (`agent2-runner-final.log`). Scope is `node-subprocess-recovery-only`, `dirty: true`. |
| `python3 scripts/validate_plan.py` | **Exit 0**; 7 milestones / 121 issues / 86 leaves / 258 specs and exact fixture calculations (`agent2-plan.log`). |
| `python3 scripts/validate_case_map.py --check-tests --node-wave 4` | **Exit 0**; 258 cases / 252 mapped / 6 retired / **2 later targets pending** (`agent2-case-map-final.log`). |
| `python3 -m unittest discover -s scripts -p test_validate_case_map.py` (after whitespace-only wave-file normalization) | **Exit 0; 16 passed** (`agent2-case-map-regressions-final.log`). |
| `python3 scripts/test_live_evidence.py` | **Exit 0; 16 passed**, validator/refusal regressions only; no live acceptance (`agent2-live-regressions.log`). |
| `/home/june/go/bin/actionlint -no-color .github/workflows/ci.yml .github/workflows/node-candidate.yml` | **Exit 0**, no diagnostics (`agent2-actionlint.log`). |
| `CARGO_TARGET_DIR=/tmp/agent13-rust-target CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_INCREMENTAL=false CARGO_PROFILE_TEST_INCREMENTAL=false cargo test --locked --workspace --all-targets` | **Exit 0; 345 passed / 0 failed / 1 ignored** child-server entrypoint (`agent2-rust-workspace.log`), on local Rust 1.99.0, not pinned 1.90.0. |
| `npx tsx scripts/package-node-release.ts --tag v0.0.0 --out work/verification/implementation-agent-13/release-refusal` | **Exit 1, expected refusal**: dirty checkout is not a candidate release (`agent2-dirty-release-refusal.log`). No release was generated from this checkout. |
| `python3 scripts/validate_case_map.py --check-tests` | **Exit 1**, still missing `scripts/e2e/scrobbler-e2e.ts` and `web/test/session/client.test.ts` (`agent2-case-map-unrestricted.log`). No placeholder or M7 implementation was added. |
| `python3 scripts/verify_live_evidence.py` | **Exit 2/BLOCKED**; historical schema-v1 inventory cannot satisfy legacy Worker schema-v2 verifier; **no live tests ran** (`agent2-live-blocked.log`). Current-Node live evidence migration remains absent. |
| `git diff --check` | **Exit 0**. |

Final scoped receipt identity (same hashes as final gate build):

- Embedded HEAD: `29453f8e8763083a3e3d7b10d5090285ef2f9d63`, **dirty tree**.
- Production `main.mjs` SHA-256 prefix: `12a8808e3bf6…`.
- Fixture `e2e.mjs` SHA-256 prefix: `da29ee626885…`.

Full digests remain in the local `node-recovery-final/summary.json` receipt;
only prefixes are in this doc to respect the operator-document credential scan.
These are executable dirty-tree evidence, **not final release provenance**.

### Failed development runs, retained in accounting

- Initial recovery-authoring runs caught an incorrect guard export name, API
  nanosecond timestamp normalization and `Follow.subject` versus `did` in
  expectations. The final assertions check the actual specified DTO fields.
- The first retention test used a nonexistent fixture `inject()` helper;
  corrected to the fixture's existing `fail()` interface. Final test proves a
  permanent delete failure retains the original payload before successful retry.
- Two broad runs returned **895 passed / 3 failed** (`agent2-check-ts.log`,
  `agent2-check-ts-final.log`): new mapping targets/pending counts disagreed with
  the old exact validator expectations. The second also reflects a failed edit
  command that matched single rather than double backticks in the ADR row;
  expectations had not yet changed. No pass is inferred from either run.
- The next broad run returned **897 passed / 1 failed**
  (`agent2-check-ts-final2.log`). Its pre-build-wave negative control removed
  build/guard modules but retained the new importers, so tsc correctly failed
  before the intended guard. The disposable pre-wave fixture now also removes
  those dependent recovery/candidate tooling files. Guard exit-code/order and
  repository-fingerprint assertions were **not weakened**. The focused `-t`
  recheck passed 1 test with 9 intentionally filtered tests; only the final
  unfiltered **898/898** gate is broad evidence.
- Optional LSP/AST tools/CLI were unavailable; TypeScript build diagnostics
  were used. No Rust lint suppression or acceptance-threshold change was made.

### Remaining M1–M6 gaps (not resolved by this phase)

- **M1:** Fresh hosted green checks with pinned Rust 1.90.0 and official Node
  remain absent. Official SQLite **3.54.0** was not executed here. Published
  #39/#41/#42/#43 contracts still require explicit owner/reviewer Node
  reconciliation. Namespace ownership evidence/publication remains fail-closed.
- **M2:** Real confidential OAuth metadata/JWKS, refresh/revocation, secure
  production-origin/browser/session behavior and live external-PDS evidence
  remain. Outage local invalidation is not proof of upstream token revocation.
- **M3 (baseline at the time of this report):** Immediate public hiding of
  locally requested pending/failed deletes was not implemented by the Node
  read-model visibility rule. A subsequent deterministic follow-up, recorded
  below, adds a query-time overlay and statistics-cache invalidation for
  queued/running/blocked/failed intents. It still does not prove the complete
  acknowledgement-through-proof/recovery lifecycle or the full HTTP/PDS-failure
  status matrix. Payload minimization is limited to succeeded create operation
  receipts after confirmed deletion; no complete private-copy retention/erasure
  policy is claimed. Current-Node browser lifecycle, the full release-bound
  replay harness and genuine live scrobble acceptance (#73) remain.
- **M4:** Fixtures (including inherited full remote-payload checks) do not prove
  live federation convergence, independently operated PDS compatibility or
  Jetstream gap recovery/soak. #84/#85 and published-contract reconciliation
  remain separate from the local deterministic runs.
- **M5:** Requested deterministic repeated-identity/feed-transition and
  subprocess durable-view/cursor evidence now exist. They do not establish
  browser UX, live social/feed/history/stats convergence, complete published
  Rust acceptance or the full local-delete lifecycle through acknowledgement,
  proof and restart. A separate Node read-model regression now covers queued and
  failed local intent hiding, but no M5 milestone is closed.
- **M6:** Candidate packaging and a **narrow** recovery runner exist, not a final
  Node release/publication/installer or full backend gate. Packaged backup
  restore and acknowledgement-through-proof tombstone recovery are still
  missing from that journey (a separate query-time overlay regression now covers
  queued/failed public hiding); full case-map closure, browser BFF
  migration/current-Node browser acceptance,
  constrained **2-vCPU/2-GiB paced** performance (#103), production npm-audit and
  hosted workflow results, current-Node live inventory and genuine
  release-bound external/restore/soak evidence (#107–#109) remain. The legacy
  Rust release workflow was not reinterpreted as Node publication.

No live acceptance was fabricated and no milestone/issue was closed.

---

## Addendum — fix findings agent 1 (2026-10-28)

Both high-severity independent-review findings in the uncommitted M1–M6 work
were repaired. This section supersedes only the corresponding follow receipt
and candidate prerequisite claims above. Existing dirty-tree changes were
preserved. No M7 implementation, deployment, release publication, credential
use outside deterministic fixtures, issue mutation/closure or duplicate issue
creation occurred. Optional LSP/AST tools and the ast-grep CLI are unavailable
in this harness; the TypeScript build supplied diagnostics instead.

### Causal follow receipt reuse

`worker/src/outbox/follow-ops.ts` no longer compares a proof's `verified_at`
with an operation's `updated_at_ms`. Settlement is not a causal boundary:
Jetstream/proof drain can see an external contradiction before a delayed PDS
acknowledgement, and multiple verified commits can share a millisecond.

Admission now atomically stores the current contrary proof identities
**(URI, repository revision)** with the operation. A succeeded latest
same-kind receipt coalesces unless a current contrary identity is absent from
that baseline. PUT examines the deterministic URI; DELETE examines all
verified actor/subject matches, including duplicate/non-deterministic rkeys.
An unchanged pre-admission contradiction is indexing lag and does not fork
repeated intents. A newly verified revision may conservatively refresh the
receipt even if only the repository head advanced; normal remote reconciliation
still prevents duplicate writes. Queued/running/blocked duplicates retain their
original payload, attempts, backoff and dependencies. Failed/cancelled retries
and distinct opposite-intent FIFO (`follow → unfollow → follow`) are preserved.

Additive migration **3**, `follow_proof_baseline`, adds nullable
`operations.follow_proof_json`; migrations 1/2 are unchanged and the
minimum-compatible version remains **2**. The baseline is private/non-derived
with its receipt, persists across restart/restore and never enters the remote
record, digest or public projection. Legacy NULL baselines conservatively
refresh when any contrary verified proof exists rather than manufacturing a
clock-based baseline. Storage docs and the schema test declaration in
`docs/planning/node-waves.json` were updated; no case/issue was added or retired.

Regressions in `worker/test/node/outbox/follows.test.ts` verify signed fixture
CAR proofs with the production verifier/projector. Both follow and unfollow
exercise (1) contrary proof before acknowledgement, with settlement strictly
later, and (2) contrary proof at exactly the settlement timestamp. They check
fresh identity after restart, no fork while running, unchanged-proof success
reuse and the final remote state. Unfollow covers both the original rkey and
a new duplicate rkey. A fifth regression proves v2 receipt migration without
data loss and conservative legacy refresh. Existing duplicate/retry/blocked,
FIFO, external-duplicate deletion and verified-feed journey tests remain.

### Candidate gate prerequisite

`.github/workflows/node-candidate.yml` installs actionlint **v1.7.7** using
`GOBIN="$RUNNER_TEMP/bin" go install` and adds that directory to `GITHUB_PATH`
**before** `bash scripts/check-ts.sh`, matching the existing TS CI job. The
workflow remains manual-only, read-only and candidate-only. The regression in
`scripts/test/ci-workflow.test.ts` checks the exact pin, path export, ordering
and absence of error suppression for both full-gate jobs. No hosted workflow
execution or production npm-audit result is inferred from local tests.

### Execution ledger

Same base HEAD, local Node **v26.12.1**, SQLite **3.54.1**; installed actionlint
reports **v1.7.7**. Logs/receipts are retained under the gitignored
`work/verification/implementation-agent-13/`. Counts overlap, not additive.

| Exact command | Result |
|---|---|
| `npm run --silent typecheck` | Exit **0** (`fix1-typecheck.log`); also passed in the final gate. |
| `npx vitest run --project worker-node --project worker-modules --project scripts worker/test/node/outbox worker/test/node/journey/follow-journey.test.ts worker/test/storage/schema-v2.test.ts worker/test/storage/migrate.test.ts scripts/test/ci-workflow.test.ts scripts/test/deploy.test.ts` | Exit **0**, **73 passed / 14 files**, no failed/skipped/todo (`fix1-focused-final.log`). Includes all five new follow/migration regressions and the workflow prerequisite regression. |
| `npx vitest run --project worker-node --project worker-modules --project scripts worker/test/node/outbox worker/test/node/journey/follow-journey.test.ts worker/test/storage/schema-v2.test.ts worker/test/storage/migrate.test.ts worker/test/node/compose.test.ts worker/test/node/admin-socket.test.ts scripts/test/ci-workflow.test.ts scripts/test/deploy.test.ts scripts/test/secret-scan.test.ts` | Post-documentation exit **0**, **82 passed / 17 files**, no failed/skipped/todo (`fix1-focused-post-docs.log`). Includes the unchanged credential scanner and both schema-version integration assertions. |
| `/home/june/go/bin/actionlint -no-color .github/workflows/ci.yml .github/workflows/node-candidate.yml` | Exit **0**, no diagnostics (`fix1-actionlint.log`). |
| `bash scripts/check-ts.sh` | Final exit **0**, **904 passed / 224 files**, **0 failed/skipped/todo**, all nine gate steps passed; **185.769 s** total (`fix1-check-ts-final.log`, `fix1-gate-durations.json`, `fix1-ts-test-report.json`, `fix1-ts-test-cases.jsonl`). Includes contracts, map, 16 Python validator regressions, builds/guards, packaging and subprocess-recovery tests. |
| `python3 scripts/validate_case_map.py --check-tests --node-wave 4` | Exit **0**, 258 cases / 252 mapped / 6 retired; the same **2 later-wave targets pending**. |
| `git diff --check` | Exit **0** after final documentation edits. |

The prior agent-2 bundle receipt above remains historical, not the new build.
The final gate rebuilt production/fixture bundles from this dirty tree (same
base HEAD); their SHA-256 prefixes are respectively `c612d600cb2e…` and
`b8665d17fd1a…`, with full values in `fix1-check-ts-final.log`. The recovery
CLI was **not rerun** in this phase, and no fresh CLI receipt or release
provenance is claimed. Official Node/SQLite 3.54.0, hosted CI, live PDS,
browser acceptance and all previously stated remaining M1–M6 gaps remain
unproven; no milestone closure is inferred.

### Failure/negative-control accounting

- The old timestamp-based admission condition was temporarily restored (then
  restored back to the fix) for
  `npx vitest run --project worker-node worker/test/node/outbox/follows.test.ts -t 'refreshes a succeeded receipt after contrary'`.
  Expected exit **1**, **all 4 regressions failed** on stale identity reuse,
  with 6 deliberately filtered tests (`fix1-old-clock-negative.log`). This
  rejects both the pre-ack and equal-timestamp bugs, for both intent kinds.
- The candidate's pinned install command was temporarily removed (then
  restored) for
  `npx vitest run --project scripts scripts/test/ci-workflow.test.ts -t 'every full TypeScript gate workflow'`.
  Expected exit **1**, **1 failed / 3 deliberately filtered**: the prerequisite
  regression detected the missing installer (`fix1-missing-actionlint-negative.log`).
- Early focused runs caught schema test authoring mistakes: expecting the
  additive migration to raise the v2 compatibility floor, and confusing the
  harness's migration invocation count with ledger length. Initial typechecks
  caught the missing row-shape declaration and untyped legacy-row spread.
  These were corrected; no production compatibility rule was relaxed.
- The first full gate returned **898 passed / 6 failed** (`fix1-check-ts.log`):
  two composition/admin tests hardcoded schema version 2, and three nested
  gate controls inherited those failures. They now assert `SCHEMA_VERSION`;
  migration tests still assert the explicit version **3** and compatibility
  floor **2**. The sixth failure was the existing addendum's inline full
  bundle digests, rejected by the unchanged credential scanner. That record
  now prints explicitly labelled prefixes and points to its original local
  full-digest receipt; no scanner rule/allowlist or assertion was weakened.

---

## Addendum — M6 follow-up evidence and documentation (2026-10-29)

This addendum records bounded work after the agent-2 ledger. It preserves the
same dirty base checkout (`29453f8e8763083a3e3d7b10d5090285ef2f9d63`); no
commit, tag, candidate release, GitHub state change, production mutation,
credential disclosure, or M7 implementation occurred.

- **M6.2.2 case map:** `M6.2.2/metrics_auth` remains mapped to the Node
  composition admin-status/TCP-404 case in N4-03. `M6.2.2/log_redaction`
  retains the historical Workers W5-01 primary target and adds both current
  Node credential-rich secret-log/error/public-response journeys as supporting
  targets. After the additional M6.3.2 export-secret-scan mapping, the
  validator/interim-runner expectations now reflect **70 wave-zero pending
  cases / 90 later Node-wave target references**; the full wave-4 map remains
  **258 unique cases, 252 mapped, 6 retired, 2 later-wave targets pending**.
  M7 requirements and implementation were not changed.
- **Package/stager integration:** the disposable committed checkout test now
  exercises package → independent static verifier → exact-byte offline stager,
  validates the manifest payload hashes, confirms verified release reuse,
  refuses reuse after modifying the staged main bundle, and succeeds after the
  test restores the exact bytes. This is deterministic local integration only;
  it performs no `current` switch and is not a trusted release, installer,
  activation, or deployment test. `npx vitest run scripts/test/build-server.test.ts`
  passed **7/7**; the expected diagnostic is the tampered-payload refusal.
- **Architecture documentation:** `docs/account-controls.md` now removes the
  false “no credentials on the server” premise, distinguishes the legacy
  Workers/IndexDO and SPA details from current Node BFF behavior, and records
  that public export, credential disconnect, and indexing suppression do not
  satisfy the unresolved owner-only-export or atomic disconnect contract.
  `docs/verification/backend.md` records the separate four-case current-Node
  fixture-host recovery receipt with a short digest prefix, dirty source/runtime
  identity, and explicit non-coverage; it does not upgrade that receipt to full
  #108 or packaged acceptance.
- **Final TypeScript gate after case-map, package-test, account-controls and
  backend evidence changes:** `bash scripts/check-ts.sh` exited **0** in
  **210.39 s**, with **225 files / 930 tests passed**, zero failed/skipped/todo;
  `scripts/report-tests.ts` accounted for 930/930. Receipt:
  `/tmp/atmusic-check-ts-final14.log`. The earlier case-map assertion failures
  and their corrections are detailed in `docs/verification/milestones/m6-audit.md`.
  This remains a local dirty-tree gate, not hosted CI or release provenance.
  `git diff --check`, the case-map validator, and secret-scan test also passed;
  active LSP full checks returned zero diagnostics for the five edited Markdown
  paths, not the full workspace.
- **Follow-up full TypeScript gate:** After correcting M5 #91 traceability and
  adding an exact public-profile field allowlist assertion while credential-rich
  fixtures are seeded, `bash scripts/check-ts.sh` exited **0** in **217.75 s**:
  **225 files / 930 tests passed**, zero failed/skipped/todo. Receipt:
  `/tmp/atmusic-check-ts-final15.log`; it supersedes `final14` as the latest full
  local receipt but remains dirty-tree evidence, not hosted CI or release
  provenance.
- **Initial M6 #105 traceability mapping:** The first supporting target paired
  the export fixture's marked non-projection rows, fake repository credentials
  and other-owner public records with the credential-rich anonymous Node
  journey. Its initial export/secret-log run passed **3/3**, case-map tests
  passed **16/16**, wave-zero validation reported **258 cases / 252 mapped / 6
  retired / 90 later-wave target references**, and the interim-runner regression
  passed **1/1**. This was subsequently strengthened with successful-export and
  Bob-owned private-operation assertions recorded below; the 3/3 result is not
  the latest focused receipt.
- **M5 #91 / M6 #105 assertion follow-up:** M5 `cache_invalidation` now maps separate immediate HTTP profile-freshness tests after an indexed create and delete. M6 `export_secret_scan` now plants a marked Bob-owned private operation, requires a successful anonymous export response before scanning seeded credentials, and keeps `export_owner` explicitly limited to public-payload coverage. The OpenAPI descriptions and source comment no longer claim the BFF holds no credentials or that the visibility helper never consults operations. Focused mutations/export/secret-journey tests passed **10/10**; case-map tests **16/16**; interim runner **1/1**; wave-zero validator **258 unique / 252 mapped / 6 retired / 90 later-wave targets pending**.
- **Latest full TypeScript gate:** `bash scripts/check-ts.sh` exited **0** in
  **193.83 s**, with **225 files / 931 tests passed**, zero failed/skipped/todo;
  report accounting was 931/931. Receipt `/tmp/atmusic-check-ts-final17.log`
  supersedes final16 as the latest local dirty-tree gate. It is not hosted CI,
  release provenance, or live acceptance.
- **Final safe-gap follow-up (2026-10-29):** A two-reviewer read-only M6 review found no remaining deterministic change that closes an acceptance gate without owner/architecture input, but identified bounded documentation and test work. The case map retains historical Workers targets and adds current Node support for origin rejection, body caps, auth-start IP throttling and the per-DID rolling listen cap; current wave-zero status is **258 unique / 252 mapped / 6 retired / 73 cases pending / 95 later-wave target refs**. Rollback wording in `docs/operations.md` and `docs/deploy/local-node.md` is now conditional on verified prior release identity, exact schema compatibility, operator approval and health checks; both link the NO-GO plan. Matrix wording reflects fixture-tested candidate startup/layout and separates `web/dist/` payload integrity from build provenance. `install-local.sh` now restores prior unit files on tested command failures before `current` commits; the fixture injects npm build, current-link rename and pre-init configuration failures, then verifies retry. Focused install/interim tests passed **3/3**, case-map Python tests **16/16**; this is not crash/power-loss or activation rollback evidence.
- **Previous full TypeScript gate (superseded by final22 below):** `bash scripts/check-ts.sh` exited **0**; **225 files / 932 tests passed**, zero failed/skipped/todo, `scripts/report-tests.ts` accounted **932/932**. The Vitest phase took **176.39 s**. Receipt `/tmp/atmusic-check-ts-final21.log`; this is dirty-tree local evidence, not hosted CI, clean-source provenance, or release acceptance. The installer fixture injected failure while restoring a unit and verified that recovery copies were retained/reported; manual recovery from the retained copies was untested.
- **Installer hardening and latest full TypeScript gate (2026-10-29):** Round-two independent reviewers (`installer-rollback-review-round2-mvsxvrdv-hxmsrj`; log `/home/june/.pi/workflows/projects/atproto_music-97e20c3d119a/runs/installer-rollback-review-round2-mvsxvrdv-hxmsrj.log`) found that `mv -T` could prompt on a read-only unit, and that the init cleanup fixture did not start a live child. The installer now uses unique private `mktemp` staging for unit files and the current symlink and `mv -Tf` for noninteractive replacement. The fixture verifies preservation of operator-owned fixed-temp sentinels, restoration/mode of a read-only prior unit, build and current-switch error paths, retry, and a stub `--init` child that times out without readiness; it asserts the child is reaped and its workdir removed. Restore failure still deliberately demonstrates a partially updated service plus retained/reported copies; manual recovery remains untested. Two focused-test failures were corrected before acceptance: the restore-failure shim initially intercepted unit installation and returned 24, so it was narrowed to the `.atmusic-unit-restore.*` staging path; then the expected command ledger omitted the intentional `node --init` call. Focused installer tests subsequently passed **2/2**, with Biome and `bash -n` clean. Latest `bash scripts/check-ts.sh` exited **0**: **225 files / 932 tests**, zero failures/skips/todo, report **932/932**, Vitest phase **703.09 s**. Receipt `/tmp/atmusic-check-ts-final22.log`. This is dirty-tree local evidence only, not hosted CI, artifact provenance, actual database-init recovery, or release acceptance. Production remains **NO-GO**; no production or GitHub state changed.
- **Disposition:** M6 remains incomplete; no candidate-bound installer,
  service/database restore rehearsal, constrained/attested benchmark, hosted
  green run/provenance, Node live inventory, live PDS acceptance, or production
  health/rollback evidence exists. Keep production **NO-GO**, all M1–M6 issues
  open, and M7 excluded. See the M6 audit and deployment plan for owner/operator
  prerequisites and the bounded preflight observations.
