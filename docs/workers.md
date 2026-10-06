# Worker lifecycle and activation

`server::workers::runtime::WorkerRuntime` owns the outbox, backfill and relay tasks supplied in `WorkerSet`. It polls durable outbox work, retains notifications received during a batch, runs the existing bounded backfill batches, and awaits the relay worker's bounded reconnect delay after each session. Cancelling an upstream request leaves its durable operation or backfill job available for verified reconciliation on restart. The runtime creates no detached worker tasks.

Call `shutdown_until(deadline)` while SQLite writer admission is still open. The coordinator cancels active requests, awaits aborted backfill task guards, and persists relay `connected=false`, `pendingGap=true`, preserving the checkpoint and last event time. Use the same absolute deadline for subsequent HTTP/storage draining. Stopping writer admission first prevents this relay cleanup; `cleanup_failed` reports that failure. A deadline expiration reports unfinished tasks and aborts them. A transaction already admitted to the storage writer retains its commit even if its caller's acknowledgement future is cancelled.

Dropping the runtime aborts its owned tasks and sockets, but cannot perform asynchronous durable cleanup. Use orderly shutdown when possible. Startup must independently mark restored relay connection state disconnected before exposing readiness; a previous process's `connected=true` does not prove a live subscription.

With an owned configured publication namespace, production `serve` initializes the OAuth/PDS boundary, outbox polling and complete-repository backfills. `CurrentHeadResolver` freshly resolves the authenticated DID/PDS, obtains `getLatestCommit`, and binds the signing key to the exact revision and commit CID. Signature, CAR, CID and MST verification still apply. This proves one current head; it establishes no historical key interval. Without ownership evidence, publication remains unavailable and new writes return `503 outbox_not_ready`.

Backfills check authenticated current account status and PDS location before and after fetching the CAR. Head advancement, identity migration or changed account observations retain durable retry work. Account mutations use the backfill generation captured before upstream waits and check it transactionally. Generations come from a persistent global allocator, so disconnect/re-authorize cannot reuse an old generation. An interrupted or stale response cannot unsuppress an account, replace fresh OAuth recovery, or make an unverified snapshot visible.

An injected relay session can discover a previously unknown writer when a decoded commit contains a configured music operation. The operation is only a hint: one writer transaction admits an inactive owner and a bounded snapshot job, without applying the frame or advancing its checkpoint. Duplicate hints preserve the original generation, suppressed owners remain absent, and queue-full admission rolls back the provisional owner. Only a complete authenticated current-head snapshot can activate a new writer. Existing inactive owners retain their account policy; a commit hint cannot reactivate them. Nonmusic frames do not admit new owners. This bounded discovery path does not enable the production relay or establish its coverage.

`serve_application_until` stops API and metrics listeners together, then runs worker cleanup before stopping writer admission. Its one absolute 30-second deadline covers workers, both HTTP servers and storage closure. The production WSS adapter enforces shared public DNS/IP authorization, pinned destinations, validated Rustls hostname TLS, bounded messages/control reads and deadlines. Relay ingestion remains disabled pending a safe covered-event progress and recovery-barrier policy. Global indexing therefore remains recovering with `caughtUp=false`, even after a current-head backfill completes. These components do not execute the full packaged or external interoperability acceptance gates.

Focused validation:

```sh
cargo test --locked -p atmusic-server --test worker_runtime
cargo test --locked -p atmusic-server --test startup --test shutdown_runtime
cargo clippy --locked -p atmusic-server --lib --bin atmusic --test worker_runtime --test startup --test shutdown_runtime -- -D warnings
cargo test --locked -p atmusic-atproto --test relay_websocket
cargo test --locked -p atmusic-server --test relay_discovery
cargo test --locked -p atmusic-storage --test discovery
```

Runtime targets cover actual workers and signed PDS fixtures: notification/polling, cancellation after remote commit/restart, interrupted backfill recovery, relay checkpoint/socket cleanup, reconnect cancellation, account/PDS/head races, disconnect/re-authorization ordering, conditional startup and both listeners sharing the shutdown deadline. The WSS target uses controlled TLS fixtures. Executed command results belong in the final validation evidence; these fixtures do not constitute a packaged or live acceptance run.
