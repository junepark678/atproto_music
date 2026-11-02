# Scrobble HTTP lifecycle and restart fixtures

> **Historical section.** The Axum/Rust commands and test names below describe the pre-Node implementation; they are not commands for current milestone acceptance. The accepted Node-host fixture paths and exact current commands are added at the end of this file. Rust fixtures remain historical/oracle evidence and do not establish current Node or live acceptance.

The consolidated M3.4.1 and M3.4.2 suites exercise the actual Axum router on
port-zero listeners and temporary persistent SQLite databases. OAuth starts
through HTTP, follows a real PAR/PKCE/DPoP fixture exchange and callback, and uses
the resulting session, CSRF token and encrypted OAuth access-token material for
PDS publication. No confirmed row is injected into these journeys.

The separately owned PDS HTTP fixture validates the OAuth token signature,
owner, collection scope and DPoP signature, token hash and unique proof
identifier. Its creates and deletes change repositories signed using the
maintained AT repository library. The production CID, commit-signature and MST
verifier gates every outbox confirmation and full repository snapshot. The OAuth
fixture checks nonce challenges during PAR and token exchange. These journeys do
not prove rejection of a missing or wrong resource-server DPoP nonce; that
requires a separate resource nonce challenge fixture.

Run the exact targets from the repository root:

```sh
cargo test --locked -p atmusic-server --test scrobble_lifecycle --test scrobble_faults
cargo clippy --locked -p atmusic-server --test scrobble_lifecycle --test scrobble_faults -- -D warnings
```

| Target / case | Observable evidence |
| --- | --- |
| `scrobble_lifecycle::lifecycle` | OAuth sign-in; POST key `k1`; pending operation to verified success; AT URI/CID and record payload on remote get; five identical HTTP retries; GET/history/feed/statistics; immediate local hide; verified deletion; remote get returns RecordNotFound. |
| `scrobble_lifecycle::validation_matrix` | All checked invalid record fixtures and additional raw Unicode, timestamp, integer, UUID, null/type and closed-input boundaries return 422 with the expected field; zero operations and remote records. |
| `scrobble_lifecycle::same_time_distinct` | Two identical track/time inputs with keys `k1` and `k2` produce two AT URIs and listens, even when identical record content has the same CID. |
| `scrobble_faults::kill_after_create` | Parent PDS commits a signed create and holds its acknowledgement. SIGKILL only the owned test-server child. Restart against the same DB, keep the OAuth session, reconcile signed evidence and expose exactly one remote/local record with one remote create request. |
| `scrobble_faults::kill_after_delete` | Signed remote deletion commits while its acknowledgement is held. SIGKILL the owned child, restart the same DB, retain hidden history/feed/statistics, prove signed absence, and complete the original operation with one remote delete request. |
| `scrobble_faults::cursor_faults` | Seven equal-time HTTP-created records; first page anchors traversal; newer insertion and deletion of the next record between pages; exact remaining order, fixed asOf, no duplicate unchanged URI and no newly inserted URI in the old traversal. |

There are six acceptance tests. `fixture_child_server` is an ignored child
entrypoint explicitly invoked by the two restart tests; it is not an additional
acceptance test. Both SIGKILL cases run on Unix. Each child has an owned process
handle and teardown kills and reaps only that process, including readiness
failure. The parent PDS survives the child crash so its signed remote state and
request counts remain authoritative across restart.

The newer pagination insertion is within the allowed 300-second clock-skew
window. It appears on a fresh history page, while statistics at the frozen
receipt-time asOf exclude that future listen until its timestamp arrives.

These are host fixture tests. Their DNS/HTTP transport and revision-bound
signing-key evidence are explicitly injected and limited to fixture endpoints.
They do not exercise the packaged production executable, public PDS credentials
or a live relay. Production activation still needs an authenticated source of
signing-key validity by repository revision and the deployment/namespace/live
evidence required by M3.4.3 and the other milestone gates. Neither this suite nor
its controlled ownership assertion supplies that evidence.

---

## Current Node-host deterministic fixtures — 2026-10-28

The active host is the Node process in ADR 0005, not the historical Axum server above. Current deterministic evidence is split across Node Vitest projects and a real-child-process recovery test; no confirmed read-model row is injected into the OAuth sign-in journeys. The fixture PDS and OAuth AS are in-process, signing/proof code is real, and no production PDS credential or live relay is used.

Run the current M3 subsets from the repository root:

```sh
npx vitest run --project worker-node \
  worker/test/node/http/writes.test.ts \
  worker/test/node/outbox/retry.test.ts \
  worker/test/node/outbox/recovery.test.ts \
  worker/test/node/outbox/delete.test.ts
npx vitest run --project worker-acceptance \
  worker/test/acceptance/read-model-acceptance.test.ts \
  worker/test/acceptance/restart.test.ts
npx vitest run --project scripts scripts/test/node-recovery.test.ts
```

These suites establish (within local fixtures):

| Current Node target | Evidence boundary |
| --- | --- |
| `worker/test/node/http/writes.test.ts` | Actual Node HTTP admission, owner-scoped idempotency, key conflicts/replays, 100 concurrent distinct writes across 10 sessions, and durable operations/listen keys; the 100-write case is not evidence of a bounded writer queue or live PDS throughput. |
| `worker/test/node/outbox/retry.test.ts` | Persisted retry schedule, capped `Retry-After`, ten-attempt terminal handling, DPoP-authenticated fixture writes, and restartable operation state. |
| `worker/test/node/outbox/recovery.test.ts` | Ambiguous creates are reconciled by reading the owner's fixture PDS and comparing canonical payload/digest; persisted rkey prevents a duplicate. |
| `worker/test/node/outbox/delete.test.ts` | Delete ordering, `swapRecord`, changed-CID/`RecordNotFound` reconciliation, retry, verified external deletion, and clearing only confirmed successful-create payload/digest while retaining receipt/dedupe identity. Enqueueing a local delete invalidates the owner's statistics version. |
| `worker/test/read/feed.test.ts` | A durable delete intent hides the indexed row from public global feed, history, lookup, and statistics while queued, running, blocked, or failed; cancelling a never-sent delete restores visibility and invalidates the statistics cache. The fixture sets operation state directly; it is not the end-to-end deletion failure path. |
| `worker/test/acceptance/read-model-acceptance.test.ts` | Deterministic history, lookup, stats/feed projection, cursor insertion/deletion semantics, owner/public visibility and absent-record behavior over the read model. The shared read visibility predicate now combines active/unsuppressed owner state with the local delete overlay; it does not fabricate verified remote absence. |
| `worker/test/acceptance/restart.test.ts` | Same-file close/reopen of projection state and continuing a pre-restart cursor; this is not itself a child-process crash test. |
| `scripts/test/node-recovery.test.ts` | Actual Node bundle in owned child processes, SIGKILL around fixture-PDS create/delete commits, same-database restart and duplicate/loss reconciliation. It is local fixture-PDS recovery, not the public packed release or live PDS run. |

The exact dirty-tree verification executed for this addendum on 2026-10-28 was:

| Command | Result |
| --- | --- |
| `npx vitest run --project worker-node worker/test/node/http/writes.test.ts worker/test/node/outbox/retry.test.ts worker/test/node/outbox/recovery.test.ts worker/test/node/outbox/delete.test.ts` | **PASS**, 4 files / 26 tests. |
| `npx vitest run --project worker-acceptance worker/test/acceptance/read-model-acceptance.test.ts worker/test/acceptance/restart.test.ts` | **PASS**, 2 files / 8 tests. |
| `npx vitest run --project scripts scripts/test/node-recovery.test.ts` | **PASS**, 1 file / 1 recovery test. |

These receipts are local to the existing dirty working tree; none proves a clean checkout, hosted CI, packaged release provenance, real OAuth consent, real PDS create/delete, a live relay, or live recovery. Do not use the historic Rust acceptance output above as Node results. At the time of this original addendum, the query-time overlay itself did not include an end-to-end terminal PDS-failure/status journey or acknowledged-delete-through-proof process recovery; the later M3 follow-up below supersedes that limited statement. `docs/verification/m3-audit.md` records the current evidence and limits. M7 is excluded.

## M3 delete-lifecycle follow-up — current local fixture evidence

The subsequent deterministic additions complete two previously missing fixture-level assertions without changing the accepted 404 wrong-owner behavior:

- `worker/test/node/http/writes.test.ts › an HTTP delete failure hides the local record while reporting failure without claiming remote absence` drives a real fixture HTTP DELETE through durable admission and the production outbox runner, injects a terminal fake-PDS 400, and verifies the owner operation reports `failed`. Public history, global feed, lookup and stats omit the row while the fake PDS still contains it and `record_state` remains `present`; the test does not claim remote deletion.
- `worker/test/read/feed.test.ts › a succeeded PDS delete remains hidden by its swap CID until absence proof, without hiding a recreated CID` checks that a matching projection CID stays hidden after PDS acknowledgement and until the regular verifier applies signed absence; `record_state=absent` appears only after proof. A later recreation at the same URI with a different CID becomes visible despite the retained receipt.
- `scripts/test/node-recovery.test.ts › packaged_recovery: SIGKILL after create and delete commits reconciles durable operations, views, cursor and checkpoint on the same database` now pauses the signed absence-proof request after remote delete acknowledgement, confirms the projected record is hidden, kills and restarts the packaged Node child on the same database, then verifies it stays hidden until proof-confirmed absence. This is deterministic process recovery against local fake services—not a live independent PDS.
- `docs/verification/milestones/m3-issue-68-contract-proposal.md` records the unresolved published-issue **403** versus accepted ADR/current API **404** conflict for owner review. It is a draft only; implementation, OpenAPI and GitHub issue remain unchanged pending direction.

Current focused and broad dirty-tree receipts:

| Command | Result |
| --- | --- |
| `npx vitest run --project worker-node worker/test/node/http/writes.test.ts` | **PASS**, 1 file / 13 tests. |
| `npx vitest run --project worker-modules worker/test/read/feed.test.ts` | **PASS**, 1 file / 6 tests. |
| `npx vitest run --project scripts scripts/test/node-recovery.test.ts` | **PASS**, 1 file / 2 child-process tests / 2 journeys. |
| `python3 -B scripts/validate_case_map.py --check-tests --node-wave 4` | **PASS**, 258 unique cases, 0 required-wave amendments, two later-wave targets pending. |
| `python3 -B scripts/test_validate_case_map.py` | **PASS**, 16 validator regression tests. |
| `python3 -B scripts/validate_plan.py` | **PASS**, 7 milestones / 121 issues / 86 leaves / 258 test specifications. |
| `npx vitest run --project scripts scripts/test/node-recovery.test.ts scripts/test/node-interim.test.ts` | **PASS**, 2 files / 3 tests; wave-0 pending-target expectations include the two newly declared M3 regression targets (77 target references / 67 cases). |
| `bash scripts/check-ts.sh` | **PASS**, 224 test files / 918 tests, zero failed/skipped/todo; typecheck, lint, contracts, case-map checks, bundle guards and Node build checks passed. |
| `git diff --check` | **PASS**. |

All are local dirty-tree evidence against working sources with base commit `29453f8e8763083a3e3d7b10d5090285ef2f9d63`; built bundles identify that base commit, not the dirty source snapshot as an accepted release. No hosted CI, release provenance, external-PDS/browser/live lifecycle, namespace publication, issue-state change or production deployment is established. All M1–M6 GitHub issues remain open; M7 remains excluded.
