# Backend live acceptance: blocked

M6.4.3 remains open. No accepted live backend run exists, and M6.4.2's complete packaged journeys remain unexecuted. Controlled fixtures, packaged startup/smoke, benchmarks and dependency checks support a backend candidate; they do not establish external interoperability or a completed MVP.

Use the [candidate receipt](backend-candidate.json), [production input digests](backend-production-inputs.json) and [validation report](../VALIDATION.md) for the artifact and source actually checked. The [live inventory](live-evidence.json) currently has no accepted evidence. This document introduces no new executed result or artifact checksum.

## Unfinished code and acceptance work

| Area | Current boundary | Work still required |
| --- | --- | --- |
| Publication and snapshots | An owned configured namespace enables outbox delivery and account-checked backfills. Fresh DID/PDS discovery authenticates the exact current revision and CID; signatures, CAR hashes and MST membership remain mandatory. | Execute the required flow against the packaged artifact and external dedicated accounts. Current-head proof does not establish historical key intervals. |
| Relay ingestion | The bounded WSS/TLS adapter exists, but production startup does not run the relay worker. Restored connections are marked disconnected; global indexing remains recovering with `caughtUp=false`. | Implement safe subscription-first coverage, recovery barriers and verified progress, using authenticated historical-event trust or safe current-head recovery. An older rejected event must not advance its checkpoint. |
| Packaged journeys | The [backend runner](../../scripts/acceptance/backend.py) executes host fixtures and smoke against the supplied executable. It explicitly lists `packaged_flow` and `packaged_recovery` as unexecuted. | Implement and execute both complete journeys described in [packaged acceptance](backend.md). Its default blocked result cannot become a pass merely by supplying credentials. |
| Live drivers | The [OAuth helper](../../scripts/live/oauth_check.py) collects bounded phase observations. The [federation command](../../scripts/live/federation_check.py) explicitly reports unimplemented live execution. | Implement the complete live federation/backend matrix and obtain independently reviewed evidence. OAuth phase success alone does not close the backend gate. |

These are implementation gaps, distinct from missing operator inputs. An operator-configured driver needs a defined upstream control contract, not only endpoint strings. The packaged recovery case requires a controlled upstream to persist a signed remote commit, hold the response before acknowledgement, expose independently observable state, and release the barrier after the harness kills only its own child. Independent-writer mutations and cleanup must also be controllable and attributable.

The release CLI uses production public-DNS checks, pinned addresses and validated HTTPS/TLS. It has no injected DNS/transport or certificate bypass. Port-zero host fixtures inject the upstream boundary in-process and cannot substitute for the supplied static executable. Full packaged fixtures therefore require reachable controlled public infrastructure with valid TLS and identity/OAuth metadata. Defining and testing that controller is autonomous code work; validating the actual packaged journey requires its deployed infrastructure.

## Missing operator inputs

- An owned production lexicon prefix with reviewable domain ownership evidence.
- A public HTTPS application/callback origin and an operator-controlled deployment of the candidate executable.
- Dedicated identities on two independently operated external PDSs, with authenticated identity/PDS metadata and privately supplied authorization material.
- A supported relay and independently established coverage of both PDSs; a connection or one observed event does not prove complete coverage.
- Controlled public fixture endpoints and the agreed fault/barrier interface for deterministic packaged kill/restart acceptance.

Local artifact paths, source commits and evidence directories can be supplied from repository receipts; they are not external credential blockers. Tokens, cookies, encryption keys and private signing keys belong in operator-only configuration, not committed evidence.

## Evidence required to close the gate

An independent observer must verify OAuth/session behavior, local and independently authored external writes, follow/feed visibility, exact statistics, deletion, export/disconnect and backup/restore. Fetch remote repository evidence independently of the application's responses and validate identity, signatures, URI/CID/payload and required absence at the verified head. Prove exactly one original record after kill/restart, correct operation/read-model/checkpoint state, and verified restore with the original encryption key. Preserve the public-record and local-disconnect limits described in [account controls](../account-controls.md); local removal is not public repository erasure.

Every accepted inventory entry must name the same packaged SHA256 and exact source commit, timezone-qualified date, executed command, passed result, sanitized dedicated IDs/AT URIs, independent evidence reference and cleanup outcome, with `fixtureOnly:false`. Bind those inputs to the [production digest receipt](backend-production-inputs.json). Follow the [inventory instructions](README.md) and [test contract](../planning/TESTING.md).

```sh
python3 scripts/verify_live_evidence.py --artifact <candidate-binary>
python3 scripts/live/oauth_check.py --phase <requested-phase>
python3 scripts/live/federation_check.py --live
```

The inventory reader checks metadata and artifact binding; it does not execute or authenticate the referenced live observations. Missing prerequisites must report blocked/nonzero. Do not replace an unexecuted journey with a skipped test, a host fixture result or completed inventory fields.

## Frontend start gate

[MVP.md](../planning/MVP.md) explicitly says, “Do not start frontend implementation before M6.4.” M7.1.1 depends on M6.4.3 and requires `gate_enforcement` to keep an unresolved required live gate blocked. Preact screens, typed client, browser journey and accessibility remain unstarted under that dependency. This is a planning gate, not a claim that frontend code is technically impossible. Do not declare M7 or any milestone complete from this candidate handoff.
