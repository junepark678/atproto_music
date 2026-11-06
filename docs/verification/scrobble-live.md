# External-PDS scrobble acceptance

Status: **blocked; no live test executed**. Deterministic lifecycle and restart evidence is recorded in [scrobble-fixtures.md](scrobble-fixtures.md). It does not establish the M3.4.3 external-PDS gate.

Use a dedicated external account, an owner-controlled publication namespace, a publicly reachable HTTPS OAuth callback, and one packaged executable identified by SHA256 and source commit. Keep credentials and browser cookies in protected operator files. Follow [oauth-live.md](oauth-live.md) to authorize the account and run the bounded record observation helper.

| Required case | Observations required before recording a pass |
| --- | --- |
| `live_create_read` | Publish through the application with a unique idempotency key. Record operation completion and identical owner, AT URI, CID and content in public application history and the external PDS. Independently verify signed repository membership against the exact current head and current DID key, or authenticated historical evidence. |
| `live_retries` | Interrupt an owned application process after the external write commits but before acknowledgement. Restart the same data directory, replay the same key/payload and verify the same operation and one remote record. Record bounded attempts and confirmed local history; an HTTP acceptance alone is insufficient. |
| `live_delete` | Delete the disposable record through its owner session. Verify successful signed absence, external PDS lookup absence and removal from history, feeds, profile totals and rankings. Clean up any URI retained after a timeout using the dedicated account. |

The OAuth helper's record phase automates public record/content and deletion observations. It does not inject live process failures, verify arbitrary historical commits, or execute the entire table. Those controls and independently reviewed evidence remain required. Record dated, sanitized observations in the [live inventory](live-evidence.json), tied to the same artifact and commit. Missing configuration or unexecuted observations keep the issue open.
