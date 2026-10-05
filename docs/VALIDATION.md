# Scaffold validation

Validated on 2026-10-05 with Rust 1.90.0 on Linux x86_64. This is evidence for the scaffold only; the 258 planned implementation test cases are not implemented or claimed to pass.

| Check | Actual result |
| --- | --- |
| `cargo build --workspace` | Passed; generated committed Cargo.lock |
| Locked workspace metadata | Passed; four members, core has no dependency on storage/AT/server |
| `cargo fmt --all --check` | Passed |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | Passed |
| `cargo test --locked --workspace --all-targets` | Four router integration tests passed; zero failed/ignored; empty library crates have no tests yet |
| Host `scripts/smoke.py` | Passed actual HTTP and SIGTERM checks |
| Locked release musl build | Passed |
| ELF program/dynamic headers | No INTERP segment; no NEEDED/shared-library entries |
| Musl `scripts/smoke.py` | Passed from an empty working directory without adjacent assets |
| `scripts/validate_plan.py` | Passed hierarchy/acyclic dependency checks and independent exact fixture history/feed/stat totals |

The packaged smoke test verified `/health/live` 200, `/health/ready` 503 `not_initialized`, `/api/v1/meta` stage scaffold, embedded placeholder HTML at `/`, unknown `/api/v1/scrobbles` JSON 404, and SIGTERM exit 0 within five seconds. No running service was left behind by that test.

The machine had no system musl compiler, root privileges or sudo. For local static validation, signed APT repository metadata was refreshed into temporary state directories; musl, musl-dev and musl-tools Debian packages were downloaded through APT with checksum verification, extracted into `/tmp`, and configured as a user-local compiler. Release CI installs musl-tools normally on its Ubuntu runner. The temporary local compiler path is not hardcoded into repository configuration.

OAuth, schema/migrations, real PDS/relay interoperability, scrobbling, statistics, follows, backup/restore and Preact remain unimplemented. Their future required tests and live gates are tracked in the refined issue hierarchy. Workflow execution on GitHub is reported separately from the local results above.
