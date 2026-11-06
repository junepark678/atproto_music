# Federation live acceptance (M4.4.3 / #85)

Status: **BLOCKED; no live M4 acceptance has run.** The active implementation is the Node host with Jetstream commit hints and signed-record proof in ADR 0005. This file supersedes the operational instructions in the former Rust/Workers-era section below; historical commands and requirements are retained only to explain prior evidence and are not a current-Node live gate.

No live mutation, deployment, external-PDS write, or Jetstream interruption was attempted for this record. Production remains independently gated: the public tunnel currently returns 502 because no application service/release/database is installed; production Lexicon records are missing; Jetstream configuration is absent. Do not use production as an acceptance target until the separate deployment safety preflight and owner authorization pass.

## Required live evidence

The following is the acceptance contract to reconcile and implement for the current Node release. A complete inventory or a fixture result alone cannot satisfy it.

| Case | Required observations |
| --- | --- |
| `live_remote_arrival` | A writer operated independently of the application creates a valid record directly on each of two independently operated PDSs. Record the PDS XRPC outcome, URI and CID without recording credentials. Prove signed repository membership, then observe the exact verified record in the Node service's public history and global feed. Measure arrival with a monotonic clock; the published 30-second bound applies. Show that no application write API was used for the independent writes. |
| `live_remote_mutation` | On each PDS, independently update and delete the test record. Verify the changed CID and signed proof; after deletion verify proof-confirmed absence and convergence of public history, feed, record status, and statistics. Include failure/retry/recovery behavior without claiming that a PDS acknowledgement alone proves absence. |
| `live_recovery` | Interrupt the Node Jetstream consumer under a pre-authorized, disposable acceptance deployment; commit mutations during the interruption; restart/reconnect from durable state; prove no omissions or duplicate projection rows and compare the exact remote and indexed URI/CID/payload sets. Record the source coverage claim for both PDSs, interruption interval, cursor/checkpoint, recovery lag, and cleanup. Do not treat a configured host list or an operator-supplied reference as proof that Jetstream actually carried both identities. |

The acceptance subject identities must be dedicated, disposable accounts on **two independently operated PDSs**. Record the tested Node release source commit, immutable candidate artifact digest, Node and SQLite versions, PDS implementation/version, configured Jetstream source/coverage evidence, sanitized URIs/CIDs and UTC observations, measured monotonic arrival/recovery latencies, and cleanup outcome. Never place OAuth tokens, app passwords, cookies, private keys, or other credentials in command arguments, source control, logs, or evidence. The live evidence must bind every result to the same release and endpoint under test.

## Current local evidence and limits

`docs/verification/federation-fixtures.md` documents current Node deterministic fixtures. In particular, `scripts/test/node-recovery.test.ts › federation_process_recovery: second-PDS create/update/delete survive SIGKILL during proof and converge` exercises fake PDSs and a fake Jetstream: the create path first receives a transient second-PDS `getRecord` 503 and retries; the fake PDS/PLC then rotate Bob's signing key before an update, and the successful update proof is held across SIGKILL to verify fresh DID resolution after restart. The journey also holds create/delete proofs across SIGKILL and commits a second-PDS record while Jetstream is disconnected, dies before reconnect, then verifies durable-cursor replay after restart. `npx tsx scripts/acceptance/node-recovery.ts --out <empty-dedicated-directory>` builds and guards local bundles and requires both subprocess recovery journeys. Its result is deterministic local fixture evidence, not live interoperability, hosted CI, clean-release provenance, or M4 live acceptance.

A controlled per-DID omission test additionally demonstrates a current architecture limitation: when Jetstream silently omits an identity, the app receives no gap signal and may leave that identity marked `current`. The fake test and the offline missing-coverage-reference preflight do not establish live coverage detection. Issue #83 requires owner reconciliation of this behavior; the [review-only coverage-contract proposal](milestones/m4-coverage-contract-proposal.md) records the alternatives without changing the issue. Do not label it `recovering` or `coverage proven` based on those tests.

## Current live tooling state

**There is no current-Node release-bound federation live runner.** In particular:

- `scripts/live/federation_check.py --live` is a legacy Rust relay gate that blocks around the old disabled-relay design. Its output is not a live failure or pass for the active Node service.
- `scripts/live/pds_compat_check.ts` and `scripts/live/live-gate.ts` use the older Workers-oriented evidence model and PDS compatibility checks; they do not execute the required Node direct-writer create/update/delete/reconnect matrix. A missing-environment refusal or a syntactically valid inventory is only fail-closed preflight/validator evidence.
- `ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF` in the legacy preflight is an operator-provided reference, not a network-verified proof that commits from both PDSs reach the configured Jetstream.
- Do not run the legacy commands below to claim M4 acceptance. They are retained in the historical subsection for provenance only.

Before requesting a live run, first reconcile the current Node live-runner/evidence schema with the accepted architecture and issue owner, then run it only against an explicitly approved disposable acceptance deployment. The runner must refuse before network access if the release identity, public Node origin, owned namespace/schema readiness, two independent PDS identities, PDS independence evidence, Jetstream coverage evidence, or test authorization is missing. Production deployment and test authorization are separate decisions; a working tunnel or available credentials is not authorization to write.

## Historical Rust/Workers-era requirements (not current Node instructions)

The historical live command was `python3 scripts/live/federation_check.py --live`; the historical artifact verifier was `python3 scripts/verify_live_evidence.py --artifact target/x86_64-unknown-linux-musl/release/atmusic`. Those scripts and the descriptions below are not the current Node acceptance path.

The former checklist required two dedicated PDS identities, an owned namespace, public HTTPS OAuth, and a supported relay; its observations asked for direct external creation, update/delete, and restart of an owned relay consumer. It also described a relay-application limitation around safe event progress, historical key trust, and a durable buffering barrier between snapshots and subscriptions. Those implementation claims describe the retired Rust path and must not be transferred to the active Jetstream commit-hint/current-proof design. Preserve the useful external-writer, mutation, recovery, independence, and release-bound evidence requirements above, but do not claim the old binary, relay, Workers analytics, worker-version ID, or admin-token model is current Node infrastructure.
