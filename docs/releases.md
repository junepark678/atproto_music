# Current Node deterministic candidates (ADR 0005)

The product is Node, not the historical static Rust executable documented below.
`.github/workflows/node-candidate.yml` is **manual, candidate-only, read-only**;
it installs `.nvmrc` Node and locked dependencies, validates the tag against
root `package.json` and both root lockfile versions, runs the deterministic
TypeScript gate and production npm audit (failures require triage), builds
assets, runs scoped subprocess recovery, and creates checksummed candidates.
It never activates an install, deploys, publishes a GitHub release or bypasses
missing live evidence. Its execution on GitHub has not been established here.

```sh
# From a clean committed checkout with pinned Node and npm ci completed:
npm run check
npm run build:web
npx tsx scripts/acceptance/node-recovery.ts --out work/acceptance/node-recovery
npx tsx scripts/package-node-release.ts --tag v0.0.0 --out work/release-node
(cd work/release-node && sha256sum -c SHA256SUMS)
```

`package-node-release.ts` refuses dirty/uncommitted trees, stale production
source inputs, guard failures, mismatching embedded commit/build-info hash,
unpinned Node, symlinked assets and tag/lockfile mismatch. It packages the
real `main.mjs`, source map, input/metafile provenance, web assets and a
`candidate.json` inventory; it never packages the IPC test host. The archive
preserves the installed release layout: `worker/dist/node/main.mjs` (the same
path used by `atmusic.service`), its source/provenance files, and `web/dist/`
assets. The bundled default `releaseRoot` therefore resolves to the extracted
archive root, without setting `ATMUSIC_ASSETS_DIR`. The package test extracts a
candidate and starts that exact `main.mjs`, checks `/health/ready`, and fetches
the bundled home asset before stopping the process. Canonical tar metadata and
gzip produce identical bytes on repeated runs with identical inputs/runtime.
SHA256SUMS detects corruption, not authenticity. Tests also exercise the real
esbuild product and checksum tool, including a one-byte tamper control. For a
static, non-extracting preflight, `scripts/verify_node_candidate.py` (Python
3.13 or newer for streaming tar parsing) requires an independently trusted
archive SHA-256 plus the expected full commit and tag. It bounds compressed and
decompressed size, member/header counts and PAX metadata before/while streaming;
it checks archive paths/types, strict manifest identity, exact payload inventory,
per-file hashes and bundle identity, then emits a JSON receipt to stdout. It does not extract or execute the candidate, install units,
read credentials, access production state or establish release authenticity.
The sibling SHA256SUMS and the manifest are not independent trust anchors; the
expected digest must be bound to reviewed workflow/tag provenance. It is a
verifier, not an installer or an acceptance gate.

```sh
python3 scripts/verify_node_candidate.py \
  --archive work/release-node/atmusic-0.0.0-node-candidate.tar.gz \
  --trusted-sha256 <digest-from-independently-reviewed-workflow-provenance> \
  --commit <full-40-character-source-sha> \
  --tag v0.0.0
```

### Offline exact-byte staging helper (not a production installer)

`scripts/stage_node_candidate.py` is a separate local helper that consumes the
verifier's private snapshot rather than reopening the caller-controlled archive
path. It requires Python 3.13+ and Linux `renameat2(RENAME_NOREPLACE)`. Supply an
absolute, owner-controlled `--prefix` with mode 0700 (or stricter), beneath
non-symlink path components; the prefix and `releases/` are checked for owner
and permissions. Payload reads/writes use validated relative paths with
component-by-component directory descriptors and no-follow opens. A publication
is prevalidated in a private temporary release, then atomically renamed without
replacing an existing path. Directory-walk errors are fatal before publication;
no directory is silently skipped. The helper fsyncs staged files and directories
bottom-up. Each invocation re-fsyncs the parent entry for all prefix components
and `releases/`, so a retry does not mistake a prior failed or interrupted
directory-creation barrier for a durable entry. New release publication fsyncs
`releases/`; reuse revalidates and re-fsyncs that directory.
Before changing `current`, the helper revalidates both release identities and
fsyncs `releases/` under the switch lock; it refuses the link change if that
barrier fails. Each release keeps the exact verified `candidate.tar.gz`
alongside its inventoried `candidate.json` and payload, so staging uses
additional disk space approximately equal to the compressed archive plus the
extracted payload.

```sh
python3 scripts/stage_node_candidate.py stage \
  --archive <candidate.tar.gz> \
  --trusted-sha256 <digest-from-independently-reviewed-workflow-provenance> \
  --commit <full-source-sha> --tag <tag> \
  --prefix /absolute/path/to/private-candidate-prefix
```

The stage-only form does not modify `current`. Optional `--switch` updates only
a managed local `current` symlink and refuses a first-install switch. It also
requires `--current-trusted-sha256`, `--current-commit` and `--current-tag` from
an independent trust source; a marker inside an existing release is not proof
that its archive was ever verified. `rollback` likewise requires independent
SHA/commit/tag inputs for both the rollback target and current release. Reuse
revalidates the retained archive against the supplied trust inputs and binds
the staged manifest/bundle to that archive. A release-link rollback does not
restart a service, install units, migrate/restore a database, or establish
health. A reported `durabilityWarning` may describe an unresolved publication
or reuse `releases/` barrier, a post-replacement prefix `fsync` failure, or a
switch-lock close error after commit. Messages explicitly say when `current`
was already replaced; those warnings do not undo a committed link. An earlier
publication warning is cleared if the locked pre-switch `releases/` fsync
subsequently succeeds. If that pre-switch barrier fails, the switch is refused;
the error reports that the candidate remains staged, that this invocation did
not switch `current`, and any unresolved publication warning. Failures while
fsyncing a prefix or `releases/` parent entry abort before release publication,
and the next invocation retries those barriers even if the directories now
exist. A CLI stdout/receipt failure after the operation completed returns exit
3 (not `BLOCKED`) and best-effort writes `RECEIPT_FAILED` to stderr with the
release identity and current-link state. If either stream fails, it is detached
so CPython's final flush does not replace status 2/3; a broken stderr can still
prevent text diagnostics. Argument-parser output is flushed before returning
its normal status; a failed help/usage write returns 2 without running an
operation. Caught operation failures use exit 2 and best-effort report
`BLOCKED`. A verified-snapshot cleanup error after release publication also
returns 2, but explicitly reports that the release remains staged, its full
archive/source identity, and that this invocation did not switch `current`.
Thus exit 2 does not always mean the prefix was untouched; inspect the reported
state. Abrupt process/host termination can still prevent receipt output, so
re-verify the release and `current` before retrying. These deterministic tests
are not power-loss recovery evidence.

Switch locking coordinates cooperating invocations only. The operator must
prevent other same-user processes from modifying the private prefix concurrently;
this tool does not defend against a hostile process with the same user identity.
The helper never executes candidate code, installs systemd units, invokes
systemd, initializes a database, reads credentials, accesses production state,
or supplies release authenticity. It is deterministic staging/test support,
not an artifact-bound production installer or acceptance gate.

The root Node package currently has version **0.0.0**; Cargo's 0.1.0 is not
substituted as the Node version.

The recovery runner's `summary.json` records the actual main/e2e bundle hashes,
commit, dirty flag, measured Node/SQLite versions, executed-case records and
log/case digests. It removes stale reports and rejects missing, skipped, failed
or duplicate required cases. It proves a **narrow fixture-only subprocess
journey**, not full #108 acceptance: AS/PDS/PLC/DoH remain parent-process
fixtures; the child runs the actual built `run()`/production features. The
bundle guard proves main/e2e shared production source hashes agree. Only the
separate e2e entry can reach fixtures; `main.mjs` has no test bypass.

Outstanding release gates: full case-map accounting, packaged backup
restore/installer activation, constrained paced performance and genuine
release-bound live/soak evidence. M7 browser implementation is excluded from
this M6 scope. However, the current candidate workflow packages `web/dist/`
from the legacy browser application; do not present that asset as compatible
with the confidential Node BFF. Before any release, obtain owner approval for a
backend-only placeholder/asset strategy or separately approve the frontend
migration and its current-Node browser tests. The original published #107/#108
static-binary wording still requires owner reconciliation; these deterministic
candidates neither amend nor close issues.
The legacy `release.yml` below remains a Rust pipeline, not Node publication.

---

## Historical Rust static backend release candidates (not the Node product)

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
