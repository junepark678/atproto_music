# Deterministic federation evidence

> **Historical section:** the Rust/Axum suites and `cargo` commands below belong to the pre-Node implementation. They are not current milestone acceptance commands. The active Node-host fixture coverage and its limits are documented at the end of this file.

This is generated fixture evidence for M4.4.1/M4.4.2. It does not establish public
relay coverage, independently operated production PDS interoperability or the
live federation milestone gate.

`crates/server/tests/support/federation.rs` starts two separate port-zero HTTP PDS
listeners and a port-zero application listener. Alice and Carol repositories use
independent secp256k1 signing keys. Fixture clients publish only through
`com.atproto.repo.createRecord`, `putRecord` and `deleteRecord`; the application
middleware counts `/api/v1/scrobbles` POSTs. Real maintained repository mutations,
CARs, signatures, CIDs and revision-bound fixture trust reach the production
verification gate before a SQLite projection is written. The HTTP fixture source
is confined to this test module; it does not relax production HTTPS/DNS policy.

The expected final state is independently fetched from each fixture PDS through
`com.atproto.sync.getRepo` and verified again. Complete active scrobble/follow URI
and CID sets must match the SQLite projection. Known payload fields are compared
with UTC timestamp spelling normalized consistently; original artist/track/album
display strings remain exact. Public counts and statistics must equal the number
of verified active scrobbles. Signing-key rotation uses explicit test revision
ranges, never an invented validity interval from a current production DID doc.

| Leaf | Case | Asserted observable result |
| --- | --- | --- |
| M4.4.1 | `independent_write` | Carol's direct PDS record URI/CID appears in HTTP feed; both PDS writer request counts are one, application POST count is zero |
| M4.4.1 | `independent_mutation` | Direct PDS update changes exact CID/display; delete removes history and count; application POST count stays zero |
| M4.4.1 | `coverage_failure` | Excluding Carol from the controlled relay leaves her verified remote record absent from feed, indexing remains recovering, and live command returns blocked rather than a federation pass |
| M4.4.2 | `convergence` | Duplicate, disconnect, old snapshot/live update/delete, signing-key rotation/identity hint, expired cursor and complete backfill converge exact record/follow sets and totals |
| M4.4.2 | `signature_failure` | Wrong-key signed event never becomes public; relay gap/rejection recovery is explicit, then verified backfill equals valid remote state |
| M4.4.2 | `worker_restart` | Old HTTP AppView/worker/database are closed; reopened database/new worker/new HTTP AppView resume stored cursor, retain pending outbox operation, and converge to verified repositories |

Executed command:

```sh
cargo test --locked -p atmusic-server --test federation_faults -- --nocapture
```

Result: six passed, zero failed. Focused clippy for `federation_faults`,
`relay_recovery` and `backfill_recovery` also passed with `-D warnings`.

The separate `relay_discovery` target covers an actor that has never authorized
the application. Its independent client makes one actual PDS `putRecord` request;
a matching normal, too-big or rebased commit hint queues an inactive owner without
accepting records or a relay checkpoint. Fresh DID/PDS account checks, a signed
full CAR and exact current-head witness must then activate the verified record.
Seven cases check the exact URI/CID/revision and public counts, nonmusic/bare sync
and malformed hint rejection, duplicate coalescing, suppression, known inactive
actors, invalid signatures and disconnect during fetch. No OAuth tokens, sessions,
operations or outbox entries are created by discovery. Storage's seven `discovery`
cases separately prove bounded atomic admission and ordered OAuth races.

```sh
cargo test --locked -p atmusic-server --test relay_discovery
cargo test --locked -p atmusic-storage --test discovery
```

The production WSS adapter is implemented with exactly pinned
`tokio-tungstenite = 0.30.0` and validated Rustls certificates and hostnames. Its
separate deterministic transport target ran on 2026-10-05:

```sh
cargo test --locked -p atmusic-atproto --test relay_websocket
cargo clippy --locked -p atmusic-atproto --lib --test relay_websocket -- -D warnings
```

Result: 11 passed, zero failed, zero ignored; focused Clippy passed. These tests
use a real WSS/TLS fixture and deliver a genuinely signed CAR through the binary
wire decoder and repository verifier. The production adapter requires WSS,
rejects URL credentials and redirects, validates every DNS address through the
shared public-IP policy, and dials only that pinned address set without using an
HTTP proxy. Frame and assembled-message limits are 8 MiB; connect and receive
deadlines are ten seconds, control messages are limited to 32 per receive, and a
failed receive gets at most one additional second to close. Dropping a cancelled
worker releases the owned socket; there are no background reader tasks. Full
transport details and the remaining trust prerequisite are in
[ADR 0003](../adr/0003-repo-verification.md).

`python3 scripts/live/federation_check.py --fixture` runs the six-case federation
target above. `--live` returns exit code 2 and lists missing prerequisite names.
Current-head trust supports production outbox and snapshot workers. Production
federation activation, the safe progress/recovery policy for older relay events,
and the live acceptance runner remain blocked or unimplemented, so the script cannot
produce live success even when environment variables are present. An owned
namespace, dedicated real identities, public HTTPS callback, two independently
operated PDSs and verified configured relay coverage also remain necessary. These
prerequisites must be implemented or supplied and the live runner executed before
recording successful live evidence. Do not put credentials in fixture files or
command output.

---

## Current Node-host deterministic evidence — 2026-10-28

The current implementation is the Node/Jetstream design in ADR 0005. It ingests commit hints over the Jetstream socket, verifies signed repository state using the current proof path, and applies verified projections in the production composition. Fixtures use independent test signing keys and fake PDS hosts; they do not establish real relay retention, independent live PDS operation, or release-bound federation acceptance.

Current commands from the repository root:

```sh
npx vitest run --project worker-acceptance \
  worker/test/acceptance/federation.test.ts \
  worker/test/acceptance/mutations.test.ts \
  worker/test/acceptance/restart.test.ts \
  worker/test/acceptance/read-model-acceptance.test.ts
npx vitest run --project worker-modules \
  worker/test/read/feed.test.ts \
  worker/test/read/cursor-http.test.ts
```

The 2026-10-28 local dirty-tree receipts were **PASS, 4 files / 19 tests** for the worker-acceptance command and **PASS, 2 files / 8 tests** for the worker-modules command. They cover:

| Current Node evidence | Exact scope and limits |
| --- | --- |
| `federation.test.ts › an independent XRPC createRecord reaches the index only through Jetstream and signed-record proof` | Carol writes through her fake PDS's `com.atproto.repo.createRecord` endpoint; the emitted commit reaches the app via Jetstream, stays out of the projection until the production alarm obtains/verifies `getRecord`, then appears in the index/feed. The test separately asserts zero app HTTP POSTs through `Acceptance.appHttpPosts` and zero application-initiated PDS writes through PDS call logs. It remains an in-process fake PDS, not an independently operated production endpoint or live traffic counter. |
| `federation.test.ts › an external commit omitted by configured Jetstream DID coverage remains unindexed without a gap signal` plus `fake-jetstream-link.test.ts › test-only DID coverage filters both Jetstream replay and live delivery without erasing the event log` | The fake retains Carol's PDS XRPC commit in its event log but the configured coverage allowlist excludes Carol from live delivery. The package-level connector test also proves an excluded DID stays out of replay and both durable events reappear after coverage is restored. The production acceptance test proves no hint/proof fetch/projection/feed row is produced and the user's index remains `current`: Jetstream supplies no per-DID coverage-loss signal and the current Node app cannot infer silent omissions. This is controlled fixture evidence of the limitation, not a runtime detection/pass or live coverage proof. |
| `scripts/test/node-recovery.test.ts › federation_process_recovery: second-PDS create/update/delete survive SIGKILL during proof and converge` | Bob is bootstrapped from a separate fake PDS. Independent PDS create, update, and delete XRPCs each emit a Jetstream event; for each phase the successful `getRecord` response is held after durable hint/checkpoint admission, the child is SIGKILLed, and the same database is reopened. Exact remote state is then reconciled into the projection and feed/history/stats; the delete is proof-confirmed absent. The journey additionally closes Jetstream, writes a second-PDS record while disconnected, journals the event without delivery, SIGKILLs before reconnect, preloads the exact fixture event history before socket startup, and verifies durable-cursor replay plus exact remote/projection/feed/history/stats convergence. This extends but does not complete the full #84 fault matrix or live independent-PDS acceptance. |
| `feed.test.ts › an existing following cursor continues after a verified unfollow between pages` | A page is issued while Alice follows Bob and Carol; Alice→Bob is deleted and proof-applied; continuing the existing cursor still returns Carol's in-range record and a fresh traversal reflects the new membership. This is current-state continuation, not snapshot isolation. |
| `cursor-http.test.ts › global feed cursor applies the moved-row rule when an update crosses its timestamp boundary` | A verified update moves an unreturned row above the first global-feed page's anchor. The existing traversal omits it and a fresh traversal shows its new position. This makes feed-specific behavior explicit; it does not promise exactly-once traversal for mutable timestamps. |

The two read tests are declared under `docs/planning/workers-waves.json` W3-01; the independent XRPC writer and coverage-negative integration tests are declared under W6-01. `fake-jetstream-link.test.ts` is declared under the atproto fixture-test wave. `scripts/test_live_evidence.py › A complete PDS-compat preflight with no Jetstream coverage evidence is blocked offline` is declared under W6-05. M4 case IDs `M4.3.2/follow_change`, `M4.3.3/external_delete_update` and `M4.4.1/independent_write` map to direct new fixture evidence. `M4.4.1/coverage_failure` maps to the controlled per-DID omission test, with the offline missing-coverage-reference regression and no-environment refusal as supporting evidence. The omission test proves that silently missing events remain unindexed and that the current app does not mark a gap; it does not supply runtime coverage detection or validate a live coverage claim.

Fresh dirty-tree receipts after the coverage and process-recovery additions:

| Command | Result and limit |
| --- | --- |
| `npx vitest run --project worker-acceptance worker/test/acceptance/federation.test.ts` | **PASS**, 1 file / 7 tests; includes silent per-DID event omission and no runtime gap signal. Fake PDS/Jetstream only. |
| `npx vitest run --project atproto packages/atproto/test/fake-jetstream-link.test.ts` | **PASS**, 1 file / 2 tests; excludes Carol from replay/live delivery, then confirms retained events replay after restoring coverage. Fake transport only. |
| `npx vitest run --project scripts scripts/test/node-recovery.test.ts` | **PASS**, 1 file / 2 tests; create/update/delete against the second fake PDS each survive SIGKILL during held proof, reconverge across the same database, and tolerate duplicate update/delete events. The federation test also proves a second-PDS event missed during socket disconnect is replayed from the durable cursor after process restart. |
| `bash scripts/check-ts.sh` (latest run also includes the M3 delete-lifecycle regressions) | **PASS**, 224 test files / 918 passed, zero failed/skipped/todo; includes typecheck, Biome, API/OpenAPI/lexicon contracts, 258-case map validation plus 16 validator regressions, bundle guards and dirty-tree Node build checks. One earlier attempt exposed a timing assumption in retry sequencing; a separate first attempt's hash-literal scan finding was resolved by shortening doc digest prefixes. This final receipt is not hosted CI, clean-tree release evidence, or live acceptance. |

The `worker/test/read/feed.test.ts › a durable local delete hides a scrobble while queued, running, blocked, or failed, but cancellation restores visibility` regression now proves a local read-model overlay across feed, history, lookup and cached statistics for queued/running/blocked/failed intents; `enqueueScrobbleDelete` invalidates the owner's stats version. It does not cover the full acknowledged-delete-through-proof recovery lifecycle or live behavior. The new coverage-negative acceptance test is deterministic fake-fixture evidence only: it excludes Carol's DID from Jetstream replay/live delivery, then proves her successful external PDS `createRecord` remains unindexed, absent from feed and unaccompanied by a hint or proof fetch. The user remains marked `current`, exposing that the accepted Jetstream path cannot detect silent per-DID coverage loss; the missing-coverage-reference preflight still fails closed before live execution. It does not show an app runtime enters `recovering`, and it is not independent-PDS/live evidence. The `APP_WRITES` instrumentation counts fake-PDS XRPC create/put/delete calls; the acceptance harness separately counts HTTP POSTs issued through its app request helper as `appHttpPosts`, asserted as zero for the independent-XRPC create case. This is a fixture-level app-route counter, not a live proxy/network metric. #83 still needs owner reconciliation of the silent-coverage behavior, #84 still lacks the complete multi-PDS federation fault/convergence matrix across process death, and #85 still lacks reconciled current-Node live tooling plus genuine two-PDS/Jetstream/release-bound observations. Keep all M4 GitHub issues open until their contracts and gates are actually satisfied. M7 is excluded.

**Additional #84 retry/restart evidence:** `scripts/test/node-recovery.test.ts › federation_process_recovery: second-PDS create/update/delete survive SIGKILL during proof and converge` injects one `503` from Bob's fake PDS on the first `com.atproto.sync.getRecord` request for the external create. The durable hint remains available; the fixture clock advances through retry backoff, then the next successful proof response is held while the Node child is SIGKILLed. Restart replays proof and converges exact remote/projection/feed/history/stats state. Before the update, the fake PDS and fake PLC rotate Bob's DID signing key; after the update proof is held through SIGKILL, restart rejects the still-persisted old identity key, re-resolves the DID document, and verifies the new-key-signed proof. After the outage replay, the test compares Bob's complete active scrobble projection and follow sets against the independent fake PDS, including that the previously deleted URI remains absent. Existing delete proof interruption and disconnected-stream cursor replay remain in the same journey. `npx vitest run --project scripts scripts/test/node-recovery.test.ts` passed **1 file / 2 tests** after this addition. The packaged runner `npx tsx scripts/acceptance/node-recovery.ts --out /tmp/atmusic-m4-recovery-final-pQg3e4` also passed with **2 subprocess journeys executed**, `dirty: true`, and no problems; its receipt binds base commit `29453f8e8763083a3e3d7b10d5090285ef2f9d63`, Node `v26.12.1`, SQLite `3.54.1`, local main/E2E bundle SHA-256 prefixes `3a78db7950d8…` / `e8ad785541f4…`, and report log/case SHA-256 prefixes `fd7e33fe6b01…` / `26ff19550b7e…`. The runner labels itself `node-subprocess-recovery-only` and explicitly leaves live PDS/Jetstream/OAuth/soak uncovered. This adds deterministic transient-proof-failure/retry before process death; it does not satisfy the full #84 matrix or live acceptance.
