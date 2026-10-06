# Scrobble HTTP lifecycle and restart fixtures

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
