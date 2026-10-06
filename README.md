# AT Protocol music

A Last.fm-style application using AT Protocol records for public scrobbles and music follows. Existing accounts retain their records on external PDSs. The intended backend is a self-contained Rust executable with embedded SQLite and, later, a Preact SPA.

**Current state: backend candidate, not a completed MVP.** The executable serves OAuth, listening history, feeds, statistics, profiles, follows and account controls over embedded SQLite. An owned publication namespace enables durable PDS writes and complete backfills verified against the exact current repository head and current DID key. Production relay delivery remains disabled pending safe historical-event recovery and subscription coverage. The root page is a placeholder; full packaged/live acceptance and the Preact product remain pending. See [validation evidence](docs/VALIDATION.md) for executed tests and limitations.

## Development

Install Rust with rustup; the repository pins Rust 1.90.0. Linux builds need a C compiler. The static release additionally needs musl-tools (`musl-gcc`). No database service or Node runtime is needed for the current backend.

```sh
cargo build --locked --workspace
bash scripts/check.sh
python3 scripts/test_ci.py
python3 scripts/test_smoke.py
```

Prepare a protected environment file using [`config/atmusic.env.example`](config/atmusic.env.example) and [deployment instructions](docs/deployment.md). `serve` requires an HTTPS public origin and a generated stable encryption key. `migrate` initializes storage without starting HTTP. The server embeds a placeholder page at `/`, reports local storage readiness at `/health/ready`, and returns typed JSON errors for unknown routes. CLI flags override environment values. SIGINT/SIGTERM stop admission and allow a bounded drain.

```sh
python3 scripts/smoke.py target/debug/atmusic
cargo build --locked --release --target x86_64-unknown-linux-musl -p atmusic-server
python3 scripts/smoke.py --static target/x86_64-unknown-linux-musl/release/atmusic
```

The smoke test starts its own server with temporary SQLite storage and configuration, checks real HTTP behavior, and stops it. CI checks formatting, clippy, real executed test counts, rejection of injected formatting/assertion failures, host startup and static packaging. The Preact workspace is deferred until the backend acceptance milestone.

## Implementation plan

- [Milestones](https://github.com/junepark678/atproto_music/milestones)
- [MVP decisions and issue specifications](docs/planning/MVP.md)
- [Fixed API payload contract](docs/planning/API.md)
- [Detailed deterministic test contract](docs/planning/TESTING.md)
- [Validation evidence](docs/VALIDATION.md)
- [Deployment and environment configuration](docs/deployment.md)
- [Machine-readable issue hierarchy](docs/planning/github-plan.json)

Leaf issues are the implementation unit. Parent issues coordinate their children. Follow explicit dependencies; do not substitute mock-only passes for live PDS/relay/browser gates.
