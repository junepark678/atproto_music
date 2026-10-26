# Static backend release candidates

The pipeline builds one Linux x86_64 musl executable with SQLite migrations and public assets embedded. It needs neither Node nor a separate database server; Outbound HTTPS uses bundled public CA roots through rustls and requires DNS. The embedded page remains a backend placeholder until the M7 start gate is met.

Push a `vX.Y.Z` tag matching every Cargo package's version, or manually run the workflow with a matching tag to obtain a candidate. A mismatch exits before packaging or publication. Locked format/build/clippy/tests and pinned contract checks run before the musl build. The release workflow runs pinned `cargo-audit` 0.22.2 against RustSec, preserves the full audit JSON/stderr, and fails on every finding/warning in the Linux x86_64 musl server normal/build dependency graph. Version 0.21.2 could not parse a current CVSS 4.0 advisory during local verification; the pin was advanced to 0.22.2 instead of skipping that advisory. Triage any finding in the change's evidence: state the advisory, affected path, exploit conditions and dependency fix or reviewed disposition. Do not remove the scan, silently add ignores or treat a local build as a successful security scan. `audit_release.py` obtains the actual graph with `cargo metadata --locked --filter-platform x86_64-unknown-linux-musl`, walks normal and build edges from the server, and unions the GNU Linux build-host graph conservatively so host-conditional build dependencies cannot escape the scan. It verifies the actual feature-resolved `cargo tree --edges normal,build` name/version identities against those metadata graphs; metadata alone includes disabled optional SQLx drivers. It lists every finding outside both graphs in `release-scope.json` and the workflow log. The full raw report remains available as a workflow artifact even when the release scan fails. No advisory ID is allowlisted: if an affected package becomes a selected normal/build dependency, the same finding blocks the release. The `test_lru_on_selected_release_target_blocks` regression proves this behavior. This scope is for the Linux musl executable; it does not certify a future wasm build or development tools.

The static smoke rejects ELF interpreters and shared dependencies, starts the executable from a fresh temporary directory, requires initialized readiness, checks embedded HTML/JS and JSON errors, and terminates only that child. Packaging creates `atmusic`, `atmusic.sha256`, a versioned `.tar.gz` preserving executable permissions, and `SHA256SUMS` for the archive and raw executable. `test_release.py` checks the actual output with `sha256sum -c`, proves repeat archives identical, and rejects one-byte tampering.

```sh
python3 scripts/check_release.py v0.1.0
cargo build --locked --release --target x86_64-unknown-linux-musl -p atmusic-server
python3 scripts/smoke.py --static target/x86_64-unknown-linux-musl/release/atmusic
python3 scripts/package_release.py target/x86_64-unknown-linux-musl/release/atmusic --tag v0.1.0 --output work/release
python3 scripts/test_release.py target/x86_64-unknown-linux-musl/release/atmusic
```

Download the archive and `SHA256SUMS` from the same candidate artifact. Check the archive line before extracting (or use the complete set when also downloading `atmusic`), then verify the executable checksum inside it:

```sh
sha256sum -c SHA256SUMS
tar -xzf atmusic-0.1.0-linux-x86_64-musl.tar.gz
sha256sum -c atmusic.sha256
./atmusic --version
```

GitHub's raw artifact format can lose executable permissions; the tar archive preserves mode 755. Checksums detect corruption and must be compared to the trusted workflow/tag provenance; a matching checksum alone does not authenticate an arbitrary download. Follow [deployment](deployment.md) and [backup](backup.md) before installing or upgrading.

Candidate upload and public release are separate workflow steps. Tagged publication also requires `verify_live_evidence.py --artifact` to accept the live inventory for that exact executable checksum and the [backend acceptance runner](verification/backend.md) to pass its full packaged gate. The current incomplete full packaged gate exits blocked, preventing publication even if somebody fills inventory metadata. Missing dedicated identities, owned namespace, public HTTPS, independent PDS/relay coverage or accepted evidence blocks publication with a nonzero result. The inventory validator checks recorded metadata, not authenticity of the cited external evidence; reviewers must inspect that evidence before declaring M6 complete. Manual candidates do not publish a release or close the live acceptance gate. Workflow execution and the final artifact checksum must be recorded separately from local fixture tests.

## Initial security scan and dependency scope

The compatible audit against RustSec commit `ef6173cbc5c50ec8166f9a5b28f07834144373ee` (database updated 2026-10-03) ran on 2026-10-05 and exited nonzero. It reported RUSTSEC-2026-0119 in `hickory-proto` 0.24.4 (patched in 0.26.1+), RUSTSEC-2023-0071 in `rsa` 0.9.10 (no patched version), RUSTSEC-2026-0253 in `lru` 0.16.4 (patched in 0.18.2+) and RUSTSEC-2026-0097 in `rand` 0.8.5 (patched in 0.8.6+ on that release line). These are findings, not approved exceptions. Preserve the scan failure until dependency fixes or an explicit documented review resolves each applicable finding, then rerun the compatible scan on the final lockfile.

The follow-up scoped scan after the Hickory/rand/JWT changes finds no affected packages in the selected Linux musl/GNU host normal/build graphs. The raw lock scan still reports disabled optional RSA and wasm-only LRU; their exclusion is proven by the retained feature-resolved Cargo trees, not an advisory allowlist. Any affected package entering either selected graph blocks the gate. Repeat this check on the final lockfile after all dependency changes.
