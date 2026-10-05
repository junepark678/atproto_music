# 0000 — Workspace scaffold and implementation boundaries

Status: accepted for the scaffold.

- Rust 1.90.0, edition 2024, resolver 3; exact direct dependency versions and Cargo.lock committed. Use locked build/test commands.
- `atmusic-core` owns domain and shared API types; it must not depend on storage, remote networking or the HTTP server.
- `atmusic-storage` owns embedded SQLite, migrations and typed repositories. `atmusic-atproto` owns discovery/OAuth/PDS/sync networking. `atmusic-server` composes them and owns HTTP/CLI/process lifecycle.
- Linux x86_64 musl is the first packaged target. TLS networking uses rustls; SQLite is bundled. The production artifact must not require shared libraries or adjacent frontend files.
- The scaffold intentionally has no application DB initialization. Liveness means its HTTP process responds; readiness returns 503 until the storage/writer implementation is supplied. Metadata advertises stage scaffold and no music capabilities.
- Compile-time placeholder HTML verifies asset embedding only. Preact is deferred behind backend milestone M6; there is no frontend package in this commit.
- Existing 28 broad implementation issues are coordination only. The 86 nested leaves specify file ownership, explicit dependencies and named expected test cases. [API.md](../planning/API.md) fixes endpoint payload choices; [TESTING.md](../planning/TESTING.md) fixes deterministic fixtures and gate evidence.

This decision does not choose a production lexicon namespace, invent account credentials, claim an implemented backend MVP, or close the planned live compatibility gates.
