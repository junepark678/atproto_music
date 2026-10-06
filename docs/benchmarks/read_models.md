# Packaged read-model latency evidence

The final Linux x86_64 musl backend candidate was measured on 2026-10-06 UTC. Artifact SHA256: `34e351ad18658732cddd13668af3ae969ea6e4a85dcb80d0f6cccfd86083b666`. This is controlled fixture performance evidence for M6.2.3, not live federation or full packaged acceptance.

| Measurement | Actual result |
| --- | --- |
| Verified fixture dataset | 100,000 confirmed records, 100 users × 1,000 records |
| Container limits | 2 CPU quota, 2 GiB memory; memory plus swap also capped at 2 GiB |
| Warmup | 30 seconds, nominal 10 requests/second; 0 errors |
| Measurement | 600 requests, 60-second phase, nominal 10 requests/second |
| Errors | 0 |
| p95 | 6.443 ms; target below 300 ms |
| Median | 2.657 ms |
| Result | Passed |

The runner builds an owned scratch image containing the actual static executable, applies Docker resource limits, mounts the controlled dataset, and alternates real HTTP history and global-feed requests with `limit=20`. Every response must be 200 with twenty items. An owner session uses the ordinary authentication path so the independent anonymous quota does not reject the specified load. The 30-second warmup is excluded from the measured 600 latencies. p95 uses the nearest-rank observation at index 569 of the sorted 600 observations. The shared Linux build host was also compiling the workspace; the container's resource limits remained in effect. This measures the backend HTTP/SQLite read path with fixture authentication and publication workers disabled; it excludes a public reverse proxy, external network, browser rendering and active upstream write traffic.

Dataset generation uses seed 7 and the maintained CAR/MST/signing helpers. All 100,000 rows enter SQLite through production repository verification and atomic application. The known fixture session/key file remains private under `work/` and is not included in release output. The runner stops/removes its own container and image in `finally`.

```sh
cargo run --locked --release -p atmusic-server --example benchmark_seed -- work/benchmark-data
python3 scripts/benchmark_read_models.py target/x86_64-unknown-linux-musl/release/atmusic work/benchmark-data --output work/benchmark-results.json
python3 scripts/test_benchmark.py work/benchmark-data --report work/benchmark-results.json
cargo test --locked -p atmusic-server --test stats_mutations
```

The generator requires a new directory. The recorded sanitized result is [read_models.json](read_models.json). Dataset/distribution checks, actual benchmark-result checks and a missing-index negative control passed. The negative control removes indexes only in a disposable copy and verifies the original remains indexed. History/feed plans use `scrobbles_owner_time` and `scrobbles_global_time`; the signed 100,000-row statistics acceptance target separately captures the actual production SQL for all four windows and rejects global table scans. See [statistics query-plan evidence](stats.md).
