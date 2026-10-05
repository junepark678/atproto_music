# AT Protocol music

A Last.fm-style application using AT Protocol records for public scrobbles and music follows. Existing accounts retain their records on external PDSs. The intended backend is a self-contained Rust executable with embedded SQLite and, later, a Preact SPA.

**Current state: scaffold, not MVP.** There is no authentication, database schema, scrobbling, federation, or Preact implementation yet. Readiness deliberately returns HTTP 503.

## Development

Install Rust with rustup; the repository pins Rust 1.90.0. Linux builds need a C compiler. The static release additionally needs musl-tools (`musl-gcc`). No database service or Node runtime is needed for the scaffold.

```sh
cargo build --locked --workspace
bash scripts/check.sh
cargo run --locked -p atmusic-server -- serve --bind 127.0.0.1:3000
```

The server embeds a placeholder page at `/`, responds at `/health/live` and `/api/v1/meta`, and returns `503 not_initialized` at `/health/ready`. Unimplemented routes return JSON 404. `ATMUSIC_BIND` overrides the default bind address; `--bind` takes precedence. SIGINT and SIGTERM shut down the scaffold cleanly.

```sh
python3 scripts/smoke.py target/debug/atmusic
cargo build --locked --release --target x86_64-unknown-linux-musl -p atmusic-server
python3 scripts/smoke.py target/x86_64-unknown-linux-musl/release/atmusic
```

The smoke test starts its own server on a temporary port, checks real HTTP behavior, and stops it. It verifies the scaffold, not music features. CI checks formatting, clippy, tests, host startup, and static packaging. The Preact workspace is deferred until the backend acceptance milestone.

## Implementation plan

- [Milestones](https://github.com/junepark678/atproto_music/milestones)
- [MVP decisions and issue specifications](docs/planning/MVP.md)
- [Fixed API payload contract](docs/planning/API.md)
- [Detailed deterministic test contract](docs/planning/TESTING.md)
- [Scaffold validation evidence](docs/VALIDATION.md)
- [Machine-readable issue hierarchy](docs/planning/github-plan.json)

Leaf issues are the implementation unit. Parent issues coordinate their children. Follow explicit dependencies; do not substitute mock-only passes for live PDS/relay/browser gates.
