# Backend validation and remaining gates

The working tree implements backend contracts and deterministic modules for M1–M6. It is a **backend candidate, not a completed MVP**. An owned publication namespace enables outbox delivery and complete repository backfills authenticated against the exact current head. Production relay delivery remains disabled pending safe historical-event recovery and subscription coverage. The embedded page is a placeholder. M7's explicit start gate is the real M6 backend acceptance run.

Validation uses Rust 1.90.0 on Linux x86_64. Fixtures use isolated SQLite files, port-0 listeners, injected application clocks and real signed CAR/CID/MST proofs through the production verifier. Fixture identities, keys and namespaces are reserved test data; no external account was contacted by these suites.

## Implemented and checked components

- Schema-v1 scrobble/follow lexicons, owned-namespace publication gate, fixed OpenAPI schemas/status matrices and negative contract checks.
- Schema-v4 SQLite migrations, constraints, typed transactions, bounded writer, encrypted OAuth material, durable operations/dependencies, tombstones, repository checkpoints, backfill state and local suppression.
- Safe public HTTPS/DNS discovery; PAR, PKCE, one-time OAuth state, ES256 DPoP, issuer/subject verification, refresh serialization, hashed sessions, Origin/CSRF enforcement and logout behavior.
- Owner idempotency, signed PDS write/reconciliation, bounded retries, deletion visibility, history/feed cursors, external mutation ingestion and recovery.
- Unicode grouping, exact ranking/windows, public profiles, verified handles, duplicate music-follow edges, ordered aggregate unfollow, export/disconnect.
- Explicit trusted-proxy CIDRs, body/rate limits, private aggregate metrics, embedded assets, bounded shutdown, consistent backup and verified restore.
- Exact current-head DID/revision/CID proofs, fresh DID/PDS checks, signature/CAR/MST validation, transient head-race reconciliation and owned-namespace production outbox/backfill startup. Eleven current-head and five write-recovery cases passed.
- Durable global backfill generations and account-status compare-and-swap prevent stale completion after disconnect or fresh authorization, including deleted/recreated accounts.
- DNS-pinned production WSS transport with hostname-validating Rustls, bounded frame/message/control handling and owned socket cancellation. Its controlled TLS target executes eleven genuine integration cases.

The fresh workspace check completed successfully on 2026-10-06 UTC: **331 executed Rust tests, zero failures, one ignored helper entrypoint, zero filtered tests**. The ignored entrypoint is explicitly invoked by the two SIGKILL recovery tests; it is excluded from the 331 count. The check also passed 21 Python regressions (live inventory 4, release audit scope 8, OAuth helper 7, acceptance runner 2), three independent read-model fixture validators with nine corruption controls, OpenAPI/fixture validation, formatting, locked build/crate boundaries and all-target Clippy. Host builds used debug=0 and incremental=false after clearing disposable build caches to fit this workspace; this changes build storage, not test selection. CI uses the same host/test profile settings.

The rebuilt static executable passed ELF, required-configuration, real HTTP/read/assets and clean-SIGTERM smoke checks. Packaging checks passed version mismatch rejection, original checksums, repeat-archive equality and one-byte tamper rejection. Host smoke and both startup-exit/invalid-ELF negative controls passed. The constrained benchmark completed 600 measured requests with zero errors and **p95 6.443 ms**, below the 300 ms target; [exact artifact-bound benchmark evidence](benchmarks/read_models.md) records the dataset and limits.

The final explicit fixture acceptance run passed **190 Rust tests across 35 owning-crate targets**, including all 148 required named cases, with zero filtered cases and one excluded child-helper entrypoint. Its three independent validators and smoke against the supplied static executable also passed. These 190 tests are a selected rerun of workspace tests, not additional distinct tests. The runner records `fixtureOnly=true`, `fullPackagedGate=blocked` and `liveGate=blocked`; it does not certify M6 acceptance. The [machine-readable candidate receipt](verification/backend-candidate.json) binds this evidence to implementation commit `b34af377e3d7f5815104f305022c73bf44f17567` and the exact packaged checksum. All [103 production input digests](verification/backend-production-inputs.json) match that commit and the current source.

## Reproduce the checks

```sh
bash scripts/check.sh
python3 scripts/test_ci.py
python3 scripts/test_smoke.py
python3 scripts/audit_release.py --audit-bin work/audit-tools/bin/cargo-audit
cargo build --locked --release --target x86_64-unknown-linux-musl -p atmusic-server
python3 scripts/smoke.py --static target/x86_64-unknown-linux-musl/release/atmusic
python3 scripts/test_release.py target/x86_64-unknown-linux-musl/release/atmusic
python3 scripts/acceptance/backend.py target/x86_64-unknown-linux-musl/release/atmusic --fixture-only
```

`check.sh` validates the 121-issue hierarchy, exact read-model fixtures and OpenAPI examples, runs script regressions, formatting, locked build/crate boundaries, all-target Clippy and workspace tests, and rejects a zero-test run. The acceptance runner also requires specific named cases: filtering or omitting a required target fails. CI negative controls edit disposable copies and require real formatting/assertion failures with preserved exit codes.

The 2026-10-06 scoped release audit passed with no active findings in the selected Linux musl/GNU build-host graphs. The unfiltered lock audit remains nonzero for disabled optional RSA and WebAssembly-only LRU; neither appears in either selected graph. The release audit retains the unfiltered RustSec lockfile report and compares every finding with Cargo's actual feature-resolved musl and GNU build-host normal/build graphs, cross-checking package identities against metadata. Disabled optional dependencies and WebAssembly-only dependencies remain visible in the raw report; they are not compiled into the Linux executable. No advisory ID is allowlisted. A finding in either selected graph blocks release; see [the security disposition](releases.md).

## Remaining production and live gates

1. **Relay trust and coverage:** fresh DID/PDS discovery and an exact revision/CID head witness enable current snapshots and signed write reconciliation without inventing historical key intervals. `serve` starts outbox and backfill workers only with an owned publication namespace; unavailable ownership still returns `503 outbox_not_ready`. Older relay events remain untrusted, and pre-subscription snapshots can miss a quiet actor’s intervening commit. Safe verified progress needs subscription-first coverage, bounded buffering and an authoritative coverage policy. Relay startup remains disabled, restored flags become disconnected, and global indexing stays recovering with `caughtUp=false`.
2. **Full packaged acceptance:** the static executable's smoke covers packaging, configuration, initialized storage, reads, assets and shutdown. Host Rust fixtures exercise protocol and worker flows. Neither substitutes for the complete static-executable OAuth/write/relay journey and kill-after-write recovery required by M6.4.2. The acceptance runner reports these separately and exits blocked unless explicitly asked for its fixture subset.
3. **Real external acceptance:** no accepted live run exists. Required inputs are an owned NSID with ownership evidence, public HTTPS callback, dedicated identities on two independently operated external PDSs, a supported relay with verified coverage, and privately configured operator credentials. OAuth, local/external writes, follows, stats, deletion and restore require sanitized independent evidence tied to one binary checksum and source commit.
4. **Frontend:** Preact screens, API client, browser journey, accessibility and product live acceptance remain unstarted under the explicit M6 start gate.

```sh
python3 scripts/live/oauth_check.py
python3 scripts/live/federation_check.py --live
python3 scripts/verify_live_evidence.py
```

Without prerequisites these commands report blocked; no live tests ran. The inventory validator checks metadata only. The OAuth helper supports bounded observations against an operator-owned deployment and requires separately reviewed browser, refresh and signed-repository evidence. See [OAuth live verification](verification/oauth-live.md), [federation fixture scope](verification/federation-fixtures.md) and [backend acceptance scope](verification/backend.md).

No milestone is declared closed by this document. The plan also requires merged deliverables and each applicable executed gate. The 258 named requirements are not converted into passed cases by counting test functions. GitHub workflow execution, release publication and live/browser acceptance are recorded separately from local deterministic evidence. The `privacy_consistency` documentation/API/source review confirms the public-record model, limited indexing coverage, owner-only export and local-disconnect limits, including the retained minimal suppression marker; see [account controls](account-controls.md).

## Final candidate artifact

- Executable SHA256: `34e351ad18658732cddd13668af3ae969ea6e4a85dcb80d0f6cccfd86083b666`; 14,273,152 bytes, mode 755.
- Archive SHA256: `a46506a69d4e0a264693f6ef3a67b82d3432df269222def8eb56b2755473ba27` for `atmusic-0.1.0-linux-x86_64-musl.tar.gz`.
- The final build's 103 production/build input digests remained unchanged through verification.
- Live OAuth helper, federation command and artifact-bound evidence inventory each returned **2, blocked**. No live test executed and no milestone/release was closed.

The shutdown regression explicitly polls the serving future before advancing its paused clock and allows Tokio's documented one-millisecond timer rounding around the configured 30-second deadline. It still requires admission closure, timeout, handler cancellation and keepalive EOF. Test-only diagnostic and clock corrections do not alter the packaged production inputs. The additional exact static CLI check enables owned-namespace workers with an empty queue, verifies relay-disabled/recovering status and schema 4, and confirms both listeners close after SIGTERM. It performs no external account traffic or record publication. A full packaged/live pass is not inferred from a fixture-subset pass.
