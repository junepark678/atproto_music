# Two-external-PDS federation acceptance

Status: **blocked; no live test executed**. [federation-fixtures.md](federation-fixtures.md) describes the executed isolated signed-PDS/relay harness. It does not establish M4.4.3 interoperability.

Required infrastructure is two dedicated identities on independently operated PDSs, an owned publication namespace, public HTTPS OAuth, and a supported relay whose coverage includes both PDSs. Record the executable checksum, source commit, upstream versions or retrieval dates, DIDs, sanitized AT URIs/CIDs and UTC observations. Supply credentials privately rather than placing them in evidence or command arguments.

| Required case | Observations required before recording a pass |
| --- | --- |
| `live_remote_arrival` | A second independent writer creates a valid record directly on its own PDS without this application's write API. Prove its signed repository membership and eventual appearance in this application's public history/global feed. |
| `live_remote_mutation` | Independently update and delete that record. Prove the changed CID and signed deletion, then verify history/feed/rankings converge without a local create operation. |
| `live_recovery` | Interrupt the owned relay consumer, restore it from durable state and verify no duplicate records and complete current snapshots. Exercise account status and identity/PDS migration where the dedicated infrastructure supports them; retain explicit coverage gaps. |

```sh
python3 scripts/live/federation_check.py --live
python3 scripts/verify_live_evidence.py --artifact target/x86_64-unknown-linux-musl/release/atmusic
```

The live command currently exits 2 and identifies its blockers. Production WSS transport exists, but relay application is disabled pending safe event progress and subscription coverage. A current-head witness does not authorize an older event. Completing snapshots before starting a fresh subscription can also miss a write in between; a durable connection/buffering barrier is required before claiming coverage. Resetting a cursor retains an unresolved gap and cannot establish `caughtUp=true`. Invalid signatures must never advance the checkpoint.

The metadata inventory checks that receipts are complete and artifact-bound; it does not run this matrix. The live harness still needs actual independent-writer controls and recovery execution. Neither fixture success nor a complete inventory closes this gate.
