# M1 GitHub amendment proposal — accepted Node architecture

**Status: draft / review-only / not published.** Prepared under the user's explicit objective to reconcile M1 issue requirements with accepted architecture. **No GitHub issue was changed, edited, commented on, or closed.** This proposal remains subject to review before publication. All **19 issues remain OPEN**: #1–5 and #36–49. **M7 is excluded** from amendment, implementation, acceptance, and closure scope.

## Sources and authority

- [ADR 0005 §16](../../adr/0005-local-node-host-and-compat-apis.md#16-amendments-b-series) supplies **accepted architectural decisions** B1–B20. Its status is “Accepted with interim decisions”; §18's interim choices remain owner-overridable. Relevant supporting sections are §3 (Node host), §5 (BFF), §6 (data model), and §15 (tests).
- [AMENDMENTS-node.md](../../planning/AMENDMENTS-node.md) is explicitly **draft, not published**. Its expanded B-series wording and leaf dispositions are proposed issue-amendment material, not proof that GitHub acceptance criteria changed. References below to a “leaf amendment” identify that draft section, not a published amendment.
- [MVP.md](../../planning/MVP.md) retains historical Rust/Workers requirements, current architecture notice, and binding completion/evidence rules. [m1-audit.md](m1-audit.md) records unresolved contract drift and local/dirty-tree evidence limits; it is not acceptance or a closure receipt.
- [ADR 0001's dated evidence](../../adr/0001-namespace.md#dated-namespace-authority-and-schema-publication-evidence) distinguishes present DNS authority proof from missing production schema publication.
- **Current GitHub bodies and status were fetched read-only**, using GitHub GraphQL `repository.issues` (not the local publication manifest), on **2026-10-28 at 12:49:21 UTC**. Every requested number was returned and assigned to the milestone **Backend foundation and fixed contracts**. Titles below are copied verbatim from that response. #1–5 bodies last changed on 2026-10-05 at 03:36:56–03:37:15 UTC; #36–49 at 03:35:26–03:35:40 UTC. A future publisher must re-read bodies/status before applying reviewed text.

## How to apply this proposal, if approved

Append an explicitly dated architecture-reconciliation section rather than replacing whole bodies, titles, task lists, or dependency links. Each item identifies the **only obsolete clauses it overrides**, gives B-series / draft-leaf provenance, and supplies proposed append text. All unmentioned acceptance criteria remain binding. This document proposes no issue renames or new issue scopes. Parents remain coordination-only; implementation stays with linked leaves. No checkboxes or relationships are changed by preparing this document.

**Shared append S — include with every applicable item below:**

> Architecture reconciliation (reviewed publication date to be supplied): ADR 0005 is the accepted Node-host decision; the historical Rust/Workers clauses identified in this amendment are superseded only as stated below. All other behavioral acceptance criteria, named regression cases, dependencies, verification/security rules, and merged-code/documentation/evidence requirements remain. Rust implementations and tests are historical/oracle evidence, not evidence that the active Node product meets these criteria. This amendment is not a completion claim; keep this issue OPEN pending accepted evidence and all inherited gates.

**Shared append T — also include for implementation leaves #36–49:**

> Replace the blanket “owning Rust crate” / Rust-workspace test-execution requirement for the active product with executable tests in the owning Node/npm project (or the existing Python contract validator where applicable), preserving each named case's observable assertions except the explicit amendments below. Use the Node harness, injected clock/transport, isolated temporary database, and close/reopen restart semantics of ADR 0005 B10. Run the exact affected targets and the current npm workspace checks; report real passed/failed/skipped/blocked results and preserve exit status. B19 requires traceability in the case map; a draft mapping, retired-case label, pending later-wave target, or passing validator alone is not executed acceptance evidence. Only B4/B11 cases explicitly named for retirement in the draft amendment may be proposed for that disposition; no blanket retirement under superseded A-series or restored D rules.

**Evidence and safety constraints (apply to every item):**

- Preserve fresh-checkout build/migration/start, meaningful CI negative controls, transaction durability, owner isolation, verification, and required artifact/live evidence. Do not turn local dirty-tree receipts into hosted CI or release evidence. The audit's Rust 1.99.0 receipts do not prove pinned Rust 1.90.0 behavior; if Rust checks remain required as an oracle/CI lane, obtain those results separately. The proposal does not decide away a still-required CI lane.
- Production publication stays **fail-closed**. The fixture prefix is never production-safe. A syntactically valid prefix, configured reference, DNS proof, passing tests, or this proposal alone does not enable writes. Retain reviewed namespace authority, publication of all four approved production schemas with correct IDs/content and public retrieval, and the remaining release/live prerequisites. No verification, TLS, signature, CID, MST, or identity rule is relaxed.
- Any translation beyond an explicit accepted ADR decision is labeled **proposal / review required** below. A missing equivalent test or constraint is a gap to resolve, not grounds to discard the original safety property. In particular #37 optional-field semantics, #43 referential integrity, #44 incompatible-schema behavior, and #46 bounded admission need explicit review.

## Issue-by-issue proposal (19 issues; all OPEN)

### #1 — [M1] Backend foundation and fixed contracts

[Current issue](https://github.com/junepark678/atproto_music/issues/1) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** amend host outcome only; retain milestone coordination and completion gate.

**Precise obsolete clause:** Outcome: “run a single Rust HTTP process backed by embedded SQLite.” The fresh-checkout gate and “Public record publication remains disabled until an owned NSID namespace is recorded” are valid, not obsolete.

**Authority:** accepted B1, B2, B4, B10, B11; child-specific B12–B19 as below. No dedicated draft M1-parent leaf amendment.

**Proposed append (plus S):**

> In Outcome, substitute “one Node 26 HTTP process under a systemd user service, with one local SQLite file” for “a single Rust HTTP process.” The server is the confidential AppView/indexer/write client of ADR 0005, not a replacement PDS. A fresh checkout must still build, initialize/migrate an empty database, start the actual bundled process, and pass contract/database checks under the documented Node toolchain. Record the git SHA and Node bundle SHA-256. Complete every linked child and retain the namespace gate; DNS authority proof does not replace production schema publication/review or release/live acceptance. No M7 work or gate is included here.

**Preserved:** every child, original evidence/merge/documentation rules, fresh-checkout gate, single-instance SQLite, and disabled publication until prerequisites are accepted.

### #2 — [M1.1] Specify lexicons, API v1, and MVP invariants

[Current issue](https://github.com/junepark678/atproto_music/issues/2) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** additive contract clarification, not a rewrite of the valid contract-freezing scope.

**Precise clauses needing qualification:** “versioned JSON lexicons” and “exact scrobble/follow field types” need the four-collection/additive-field clarification; “every API route … specified in MVP.md” must not mean its historical two-collection or removed-server-route inventory. Ownership, rejected fixtures, OpenAPI 3.1, and out-of-scope endpoint implementation remain valid.

**Authority:** accepted B12, B13, B14, B16, B18; draft leaf M1.1.4 / B16 and B12–B14 sections. No dedicated parent leaf amendment.

**Proposed append (plus S):**

> Interpret the contract deliverable using ADR 0005 B12–B14: four schema-v1 collections (scrobble, follow, settings, love), additive optional scrobble fields, and API v1.2, retaining compatible v1.1 reads. Freeze exact fields/status/security matrices and validate positive and negative examples; add the current BFF/session/write contract, not endpoint implementation. Last.fm `/2.0/` and ListenBrainz `/1/` contracts are specified separately in ADR 0005 and the compatibility documents, not as OpenAPI routes. Preserve the reviewed authority/publication prerequisites and fixture-only namespace rule.

**Preserved:** all four linked leaves, validation limits and negative examples, authentication/cursor/idempotency documentation, and no choice of domain on the owner's behalf.

### #3 — [M1.2] Create the Rust workspace and static executable build

[Current issue](https://github.com/junepark678/atproto_music/issues/3) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** amend active toolchain and artifact; retain reproducible build and real-runtime smoke obligations.

**Precise obsolete clauses:** Deliverable's four Rust crates and mandated Rust/Tokio/Axum/reqwest-rustls/serde/SQLx/tracing/clap stack, Cargo.lock/`cargo --locked`, and musl target as active product requirements; all four acceptance bullets' Rust commands, static ELF inspection, “without Node,” and musl prerequisites. “Dynamic linking” in Out of scope cannot prohibit Node/OpenSSL runtime dependencies. The absence of a database daemon and clean-runtime verification remain valid.

**Authority:** accepted B1, B4, B10, B11; draft M1.2.1 (B4) and M1.2.3 (B11/B16).

**Proposed append (plus S):**

> For the active product, replace the Rust/static-executable stack with the pinned Node 26/npm workspace toolchain, exact dependency versions and committed package-lock.json, `npm ci`, and the documented checks. Keep core pure and composition in the host. The release identity is the git SHA plus SHA-256 of worker/dist/node/main.mjs; there is no product ELF to inspect. Run the packaged bundle in a clean documented Linux Node runtime without Rust, a database daemon, or a source checkout; verify health, configuration failures, assets, and bounded shutdown as amended in #42. Document runtime prerequisites and reproducible build commands. This explicitly permits Node's runtime dependencies, but does not add a plugin ABI, cross-platform release, or frontend implementation task. Any retained Rust-oracle CI lane is separately reported, not silently waived.

**Preserved:** #40–42 dependencies/child completion, clean-runtime smoke, checksums, reproducibility, pinned installs, CI failure propagation, and no database daemon.

### #4 — [M1.3] Implement SQLite schema, migrations, and repositories

[Current issue](https://github.com/junepark678/atproto_music/issues/4) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** amend writer mechanism and schema-compatibility policy, not transactional safety.

**Precise obsolete clauses:** Deliverable's “single serialized writer queue” is a Rust mechanism, not the accepted Node main-thread writer. Acceptance “unknown future schema version fails startup without modification” is too broad under ADR 0005's compatible-newer-schema policy. WAL, foreign keys, five-second production busy timeout, uniqueness, atomicity and no-loss reopen checks remain valid.

**Authority:** accepted B1, B6, B7, B8 and ADR 0005 §3.2 / §6.4; draft leaves M1.3.1 (B6), M1.3.3 (B7), M1.3.4 (B1).

**Proposed append (plus S):**

> Use the Node Db adapter and embedded Node migration history: one connection, synchronous serialized main-thread transactions, exclusive lifetime database lock, WAL, synchronous=FULL, foreign keys and production busy_timeout=5000. Apply the compatibility rule and no-mutation safety tests of amended #44 rather than refusing every newer version. Retain uniqueness, rollback/reopen durability, owner isolation, concurrent-write correctness, and bounded contention/admission tests as amended in #43–46. The Rust and Node migration histories are separate; neither parity nor automatic migration from the Rust database is asserted. Document the active schema in docs/storage.md and preserve the Rust history separately.

**Preserved:** all storage subjects (including OAuth/private operations), constraints, transactional tests, no lost updates, and no destructive down migrations. See #46 for the review-required queue translation, not an implied retirement.

### #5 — [M1.4] Implement HTTP skeleton, configuration, and contract test harness

[Current issue](https://github.com/junepark678/atproto_music/issues/5) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** small host/CLI/harness clarification; keep health/config/error/drain requirements.

**Precise obsolete clause:** “Provide serve and migrate CLI commands” as the required Rust command shape. The actual-router/temp-SQLite harness and maximum 30-second shutdown are still appropriate; neither is dropped by the old Workers D amendment.

**Authority:** accepted B1, B3, B9, B10, B16, B18; ADR 0005 §3.8–§3.10. Draft M1.4.1 (B1) and M1.4.3 (B16).

**Proposed append (plus S):**

> Interpret the CLI/configuration deliverable as the bundled Node host's documented initialization/check/start interface, with migrations before HTTP admission, current environment names, systemd-delivered secrets, and actionable secret-free errors (#47). Exercise the actual Node router and temporary SQLite file (#49), not only helper functions. Preserve independent liveness, storage-gated readiness, uniform errors and request IDs (#48). SIGTERM has an injected production 25-second request drain and a 30-second service stop bound. Authentication and SPA feature implementation remain outside this skeleton unit; composing the BFF does not remove its security requirements or make M7 part of this amendment.

**Preserved:** startup validation, secret redaction, actual-router tests, migration readiness, upstream independence, resource closure and acknowledged-write durability.

### #36 — [M1.1.1] Gate production namespace and freeze schema version

[Current issue](https://github.com/junepark678/atproto_music/issues/36) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** amend collection inventory/config spelling and append corrected prerequisite evidence; do not relax the gate.

**Precise obsolete clauses:** Implementation unit's `ATMUSIC_LEXICON_PREFIX` is the historical Rust spelling; active Node config uses `LEXICON_PREFIX` and `NAMESPACE_OWNERSHIP_REF`. `version_policy` says “derive only <prefix>.scrobble and <prefix>.follow”; accepted B12 now requires four collections. “No implicit v2 record fields” and the ownership-evidence requirement remain valid.

**Authority:** accepted B12, B13, B1/B10 (host/tests); draft B12/B13 sections, **no separate M1.1.1 leaf section**. Current evidence: ADR 0001 dated 2026-10-28 and m1-audit #36.

**Proposed append (plus S and T):**

> For the active Node host use LEXICON_PREFIX plus the reviewable NAMESPACE_OWNERSHIP_REF. Amend version_policy to derive exactly <prefix>.scrobble, <prefix>.follow, <prefix>.settings and <prefix>.love; retain lexicon:1 and no invented schemaVersion field or implicit v2 behavior. Keep fixture_namespace and invalid_namespace rejection, including failure before any outbound publication call. Namespace syntax or an AT handle never proves control.
>
> Prerequisite status, observed 2026-10-28: DNS authority proof **exists**. The TXT delegation at _lexicon.music.pythonplayer123.dev resolves to did:plc:gsichz64a5qpjvmjktkltkw2 and agrees with the configured reference and sign-in allowlist. However, the authority DID's public PDS returned RecordNotFound for all four full schema rkeys: dev.pythonplayer123.music.scrobble, dev.pythonplayer123.music.follow, dev.pythonplayer123.music.settings and dev.pythonplayer123.music.love in com.atproto.lexicon.schema. This is missing schema publication, **not missing ownership evidence**. Owner publication/review of approved schemas, correct production IDs/content, and successful public retrieval remain required before enabling publication, together with the remaining release/live gates. Keep production writes fail-closed; do not publish fixture IDs or infer approval from this evidence note.

**Preserved:** owner-controlled reverse-domain authority, schema-v1 policy, reviewable evidence, no placeholder public writes, early rejection and separate live gates. This proposal performed no new DNS/PDS probes or writes; it cites the dated existing evidence.

### #37 — [M1.1.2] Define and validate the scrobble lexicon

[Current issue](https://github.com/junepark678/atproto_music/issues/37) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** amend additive fields and explicitly resolve optional-field acceptance semantics before publish.

**Precise obsolete/ambiguous clauses:** “fields exactly as MVP.md” cannot freeze only the historical field set. `optional_values` currently expects rejection of invalid duration/UUID values; B13 / ADR 0005 §6.2 says an invalid optional field is dropped, never fatal or truncated. That is a real semantic conflict, not merely a Rust path rename. Rust file ownership/test execution is historical for the product.

**Authority:** accepted B13, supporting §6.2; B4/B10 for Node execution. Draft B13 section; **no separate M1.1.2 leaf amendment**. The original required-field limits and timestamp bounds are not superseded.

**Proposed append (plus S and T; optional-field split requires explicit review):**

> Retain schema-v1 artist/track/listenedAt/createdAt requirements and explicitly preserve the existing optional `album`, `durationSeconds` and `recordingMbid` fields with their exact current types, optionality and limits unchanged, along with all original Unicode/byte and time bounds and no playback threshold or title/time deduplication. Add only the B13 optional fields: albumArtist, trackNumber, artistMbids, releaseMbid, releaseGroupMbid, isrc, submissionClient and musicService, with ADR 0005 §6.2's exact types/limits. Preserve old-field canonical digests. Test valid/invalid/omitted optional values and prove invalid values are never stored or truncated. For B13 record/protocol normalization, an invalid optional field is omitted without rejecting the listen. Keep local-input validation separate from remote open-record validation and reject unknown local input fields. After the first production record, enforce additive-only evolution against the published schema copies.

**Review required, not an asserted accepted split:** before publishing, reconcile the exact boundary between the old `optional_values` rejection expectation, B13's omission rule, and #39's retained 422 invalid-web-input matrix. Do not claim that B13 already specifies every local-input exception, or silently mark the original rejection case passed by a different assertion. Approve and document the per-surface outcomes and update the named case accordingly; if unresolved, leave the conflicting part pending. Valid bounds, omission acceptance, required-field failures, and original `unicode_limits` / `time_bounds` assertions remain.

**Proposed file-role clarification:** lexicons/scrobble.json and fixtures remain contract artifacts; active validation belongs to packages/core and its Node tests (with protocol mapping tested in its owning Node project). Historical crates/core/src/scrobble.rs remains oracle evidence, not the product implementation.

### #38 — [M1.1.3] Define and validate the music-follow lexicon

[Current issue](https://github.com/junepark678/atproto_music/issues/38) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** **no semantic amendment needed** to the follow schema or named cases; execution/file-role clarification only.

**Why:** B12 adds other collections and B13 adds scrobble/love fields, but neither changes this follow's subject DID, createdAt, schema-v1 policy, deterministic `f` + lowercase SHA-256 rkey, or the +300-second boundary. `follow_schema`, `follow_rkey`, and `follow_time` remain binding exactly as written. Do not invent a new follow scope.

**Precise obsolete clauses:** crates/core/src/follow.rs as the active implementation and the blanket Rust test-execution paragraph only.

**Authority:** accepted B4/B10 (runtime/tests); B12/B13 explicitly do not change follow semantics. **No separate M1.1.3 draft leaf amendment.**

**Proposed append (plus S and T):**

> No change to the follow protocol or any named expected outcome. Keep lexicons/follow.json as the schema artifact; use the shared packages/core follow/rkey implementation and its owning Node tests for active-product evidence. Preserve the Rust implementation as historical/oracle material. Do not extend this leaf to implement settings/love or weaken DID/time checks.

### #39 — [M1.1.4] Freeze OpenAPI v1 schemas and endpoint status matrices

[Current issue](https://github.com/junepark678/atproto_music/issues/39) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** reconcile route inventory and restore/retain security/status checks; keep schema validation rigor.

**Precise obsolete/ambiguous clauses:** `route_inventory` equates the exact route set to MVP.md's historical table, which is no longer the complete current API. The old blanket Rust execution paragraph does not fit the Python validator. The original async/cursor/CSRF/error requirements and `required_auth` are **not obsolete**; only the earlier Workers retirement of required_auth under D is obsolete.

**Authority:** accepted B3, B6, B7, B14, B16, B18, B19/B20 as applicable to the security matrix. Draft **M1.1.4 leaf / B16**, B14, and draft N0-02 fixture-layout / N3-02 web-429 package deviations.

**Proposed append (plus S and T):**

> Freeze OpenAPI 3.1 at info.version 1.2.0: keep compatible v1.1 routes/payloads with additive optional Scrobble fields; document the dynamic confidential OAuth metadata and JWKS, cookie/session/auth/write/operation/account, link/import/credential routes of ADR 0005. Operation (including cancelled) and Accepted are present again. Narrow “no route reads a session” to v1.1 public read routes only. Document Last.fm /2.0/ and ListenBrainz /1/ separately, outside OpenAPI. Replace route_inventory's historical-table comparison with the reviewed complete v1.2 route/method inventory, explicitly reconciling the retained v1.1 routes and the additions; no undocumented method is allowed.
>
> Keep response_examples and required_auth, with all documented success/error/async examples and wrong-type controls. Preserve 401 without a session, 403 for failed CSRF/Origin checks, 422 for invalid web fields, 400/409 idempotency outcomes, and 503 publication_disabled for a closed publication gate. The callback uses expiring single-use state bound to the OAuth cookie; auth/start checks Origin. Public reads remain public and private operation lookup remains owner-bound. Validate the current field/status/security matrices rather than treating the old D retirement as valid.

**Preserved / review limits:** pinned offline schema validation; every error/requestId/query/cursor assertion. The draft leaf's HTTP `required_auth` target supplements rather than replaces contract-wide matrix inspection. Review the draft fixture layout (`api/examples/v1.2/`) and daily-cap web 429 plus Retry-After against the owning contract before publication; their package-deviation wording is **draft**, not a separate accepted §16 decision. Do not discard still-valid v1.1 examples or invent restoration of dropped v1.0 account export/local-data routes (A9/A10 remain).

### #40 — [M1.2.1] Pin the Rust workspace, dependencies, and crate boundaries

[Current issue](https://github.com/junepark678/atproto_music/issues/40) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** replace active Rust toolchain/features; retain reproducibility and dependency direction.

**Precise obsolete clauses:** Implementation unit's Rust 1.90.0/edition/resolver/four-crate product stack; Cargo-only file ownership; `locked_build` cargo build; `dependency_direction` cargo metadata/four members; `sqlite_tls_features` SQLx/reqwest-rustls/**no OpenSSL** linkage. Node uses its own SQLite/OpenSSL; OpenSSL is not itself a security regression.

**Authority:** accepted B1, B4/B10; draft **M1.2.1 leaf / B4**, naming proposed retirements of M1.2.1/locked_build and /dependency_direction and restoration of /sqlite_tls_features.

**Proposed append (plus S and T):**

> Use the pinned Node 26 toolchain (.nvmrc), exact npm workspace dependencies and committed package-lock.json; clean npm ci must not modify the lockfile. Core remains pure with no higher-layer dependency/cycles; host owns composition and no barrel files are introduced. Check the actual Node runtime SQLite (at least 3.45, working WAL/STRICT/JSON) and OpenSSL TLS support, rather than SQLx feature selection or absence of OpenSSL. Record actual runtime versions and preserve TLS/signature verification. Active ownership is package manifests/lock/toolchain and the owning scaffold tests, not Cargo manifests alone.
>
> The Rust-specific locked_build and dependency_direction case identities may be retired only under the explicitly named B4 draft dispositions after review, with equivalent npm clean-install and layering evidence retained. sqlite_tls_features is restored and must run; do not retire it under A4. Rust pin/locked checks, if retained for the oracle, remain a distinct reported lane.

**Preserved:** checked-in pins, lockfile stability, no cycles, pure core, executable feature tests; no acceptance based solely on manifest inspection.

### #41 — [M1.2.2] Wire formatting, lint, and meaningful-test CI

[Current issue](https://github.com/junepark678/atproto_music/issues/41) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** amend product check commands and active file ownership; preserve meaningful-test and failure controls.

**Precise obsolete clauses:** “Run fmt, locked workspace clippy … locked workspace all-target tests” as the sole product gate; `ci_green`'s fixed “all four router tests” scaffold count. Rust-only scripts/scaffold file ownership is incomplete for Node. Pinned checkout actions and every command's true exit status remain valid.

**Authority:** accepted B4, B10, B19; draft B10 harness/gate and B19 traceability sections. **No separate M1.2.2 leaf amendment.**

**Proposed append (plus S and T):**

> Add the pinned Node/npm product lane: clean install, formatting/lint/type checks, actual affected Node router/storage/contract tests, and current workspace checks with true exit status and executed counts. Replace the frozen four-test scaffold expectation with the actual required named Node cases, not a lower or fabricated count. Keep pinned checkout actions and disposable-copy formatting and inverted-readiness-assertion negative controls: each must fail the relevant command/job without touching repository sources. If a Rust oracle lane remains required, keep its pinned fmt/clippy/locked all-target checks and report its results separately. Include the owning Node check scripts/tests alongside .github/workflows/ci.yml in the file-role record. A manual candidate workflow or local pass is not a hosted green CI receipt.

**Preserved:** `ci_green`, `ci_format_failure`, `ci_assertion_failure` behavioral obligations and exact failure propagation; no allowed silent skip, empty test run, or masked failure.

### #42 — [M1.2.3] Build and smoke-test a self-contained musl artifact

[Current issue](https://github.com/junepark678/atproto_music/issues/42) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** replace obsolete static ELF packaging, not packaged runtime acceptance.

**Precise obsolete clauses:** Linux x86_64 musl / --locked --release and ELF inspection; “do not … require Node”; Cargo release profile/smoke.py as the exclusive product tooling. `static_elf` has no product ELF target. `packaged_http` assumes an embedded placeholder, no adjacent asset directory and scaffold ready=503. `packaged_shutdown`'s fixed five seconds differs from the accepted production drain. “Do not add Preact” remains valid as a no-new-frontend-work boundary, not a ban on shipping existing assets.

**Authority:** accepted B1, B10, B11, B16; ADR 0005 §3.7–§3.10. Draft **M1.2.3 leaf / B11, B16**: static_elf proposed retired:B11; packaged_shutdown restored. B11 is not a retirement of all packaged smoke checks.

**Proposed append (plus S and T):**

> Build and identify the Node bundle worker/dist/node/main.mjs by git SHA and SHA-256; document the system Node 26 runtime. Retire only static_elf under B11, since no product executable has INTERP/NEEDED headers to inspect. Preserve reproducible packaging, checksums and a real-process smoke from a temporary working directory without a source checkout. With documented config/secrets, temporary initialized database and packaged existing assets (ATMUSIC_ASSETS_DIR), assert live=200, ready=200 after initialization, correct root/assets, unknown API JSON=404, and safe startup/readiness failures for invalid/missing prerequisites. Assets are filesystem release assets, not an embedded placeholder; missing index.html fails startup with exit 78 naming ATMUSIC_ASSETS_DIR. No new M7 feature work is authorized.
>
> For packaged_shutdown send SIGTERM to the actual bundle: STOPPING=1, stop admission, production request drain 25 seconds and exit 0 within the 30-second service bound; use an injected short drain for deterministic unit tests. Preserve early-death and timeout failures in the smoke runner. The published five-second expectation is superseded, not claimed satisfied by a different test. Keep packaged_http acceptance even though the draft leaf table does not list that case. Record clean artifact-bound smoke results before completion; candidate tooling alone is insufficient.

**Proposed file-role clarification:** active bundle/guard/build-server tests and candidate packaging/workflow replace Rust release-profile/static-ELF tooling for the product; actual paths include scripts/build-server.ts, scripts/check-node-bundle.ts and scripts/test/build-server.test.ts. Existing candidate-only packaging tools are not proof of production publication. Review the exact artifact manifest before publishing this amendment.

### #43 — [M1.3.1] Define SQLite schema and invariant constraints

[Current issue](https://github.com/junepark678/atproto_music/issues/43) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** reconcile active schema history; **do not remove existing integrity requirements**.

**Precise obsolete clauses:** crates/storage/migrations/0001_initial.sql as active product schema ownership, and any reading of `users` / “relay checkpoints” / “local-disconnect suppression” as requiring identical Rust table names/layout in Node. The uniqueness, per-owner idempotency and no-dangling-private-operation outcomes are valid.

**Authority:** accepted B1, B3, B6, B7, B8 and §6.4; draft **M1.3.1 leaf / B6** restores idempotency_scope. That draft HTTP scope test alone does not prove all original SQL constraint cases.

**Proposed append (plus S and T):**

> Document and test the active Node schema in worker/src/do/schema.ts, with row types in worker/src/app/rows.ts and docs/storage.md. Keep the separate Rust migration history documented in docs/storage-rust.md; do not claim cross-runtime parity or reuse Rust migration numbering as Node evidence. Retain unique AT URI, owner/collection/rkey identity, per-DID Idempotency-Key uniqueness, and owner/private-operation integrity. B6 restores server idempotency: duplicate same-key admission for one DID resolves to the same operation, different request hash conflicts, and the same key for two DIDs creates independent operations. Keep two distinct assertions: the original idempotency_scope storage case must show a direct duplicate Alice key fails the uniqueness constraint; an HTTP replay must show the existing operation is returned. API replay success alone does not prove the SQL constraint, and constraint rejection alone does not prove replay semantics. Test encrypted state/session storage, durable operation state and complete derived/non-derived table classification for restore safety.

**Deterministic evidence added, issue still open:** `worker/src/outbox/operations.ts::insertOperation` now checks for the owning `accounts` row inside the insertion transaction and rejects before the operation/dependency rows can be written. `worker/test/node/outbox/follows.test.ts` asserts that a missing-owner attempt leaves both tables empty. This is an application-boundary invariant, not a physical `operations.did` SQL foreign key; `rg` over production sources found `insertOperation` as the sole production `INSERT INTO operations` path. `worker/test/storage/schema-v2.test.ts` separately proves Alice's duplicate `(did, idempotency_key)` is constrained while Bob may use the same key, and the HTTP test proves same-key cross-DID operations are independent. The three behaviors remain separately asserted; do not call HTTP replay alone proof of SQL uniqueness. If owners require direct ad-hoc SQL inserts to be rejected too, that is a remaining schema-design review (including migration compatibility), not a claim made by this code. Retain `unique_record` and its one-row side effect. Account disconnect/auth-session revocation and signed settings indexing opt-out are distinct; do not reinterpret this leaf as restoration of the dropped v1.0 local-data route.

**Mapping status / owner review:** The application guard covers the no-dangling-owner invariant at the sole production insertion path, but it is not a database-level foreign-key constraint. Keep the named `foreign_key`/foreign-owner assertion pending unless the owner explicitly accepts the application-boundary test as an equivalent contract; do not retire it or claim a physical SQL constraint from this evidence.

### #44 — [M1.3.2] Implement embedded forward migrations and database open

[Current issue](https://github.com/junepark678/atproto_music/issues/44) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** amend adapter/pool and future-schema rule, retain transactional migration safety.

**Precise obsolete clauses:** “embedded SQLx migrations” and “maximum reader pool of four”; unconditional “Fail on future schema version before mutation,” including `future_schema`'s binary-version-only refusal and `schema_too_new` outcome. WAL/foreign keys/5000 ms production busy timeout and migration rollback/reopen remain valid.

**Authority:** accepted B1, B8 and ADR 0005 §3.2 / §3.10 / §6.4; B10 for tests. **No separate M1.3.2 draft leaf amendment.**

**Proposed append (plus S and T):**

> Use the Node Db adapter, one synchronous connection and embedded Node migration list, with WAL, synchronous=FULL, foreign_keys=ON, locking_mode=EXCLUSIVE and production busy_timeout=5000 (short injected timeout for tests). Run pending migrations before HTTP admission; a missing database is not silently created without --init. Preserve fresh_and_reopen and migration_rollback, including no partial data/version change. Additive migrations after version 2 retain schema_compat.min_compatible_version unless a separately approved non-additive ADR changes it.
>
> Amend future_schema into two explicit cases: a newer database compatible with the running version opens without applying migrations or losing rows; an incompatible newer database reports readiness 503 too_new and starts no timers. Preserve the original no-modification safety check for an incompatible database, verifying user/schema contents and the protected pre-open copy. Do not claim blanket unknown-version rejection. Test the production refusal/readiness path and the compatibility boundary rather than changing only a version comparison. Keep Rust and Node migration histories distinct; there is no asserted cross-runtime upgrade.

**Review required:** B8 permits opening a newer database only when its recorded compatibility floor is at or below this code version, without applying migrations or losing rows. The original no-mutation guarantee remains for incompatible, missing or malformed compatibility metadata. The exact Node startup/readiness response, timer/listener behavior, and a non-vacuous unchanged-database check (including WAL/open effects) are not established solely by B8. Specify and test those before calling this case mapped; keep `schema_too_new` pending until then. Migration-only CLI semantics are handled under #47, not silently assigned here.

### #45 — [M1.3.3] Implement typed repository operations and transactions

[Current issue](https://github.com/junepark678/atproto_music/issues/45) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** amend repository/file boundary; retain every transaction and privacy outcome.

**Precise obsolete clauses:** “Keep SQL out of server/AT crates” and Rust repository paths as the active layering mechanism. The atomic event/checkpoint, revision and owner-read requirements are not obsolete; the earlier A12 retirement of owner_private_read is obsolete on Node.

**Authority:** accepted B1, B4, B7, B16; draft **M1.3.3 leaf / B7** restores owner_private_read.

**Proposed append (plus S and T):**

> Implement typed storage operations over the Node Db / ModuleDeps boundaries in the owning worker storage/read/write/ingest and outbox modules. Keep SQL in the storage-owning modules, not protocol/HTTP presentation; core stays pure. Retain event_atomicity (record mutation plus checkpoint in one transaction), record_revision idempotence/newer-payload behavior, tombstones and owner-bound private operations. Keep owner_private_read and prove both the storage owner filter and HTTP behavior: the owner sees its operation; another session gets no row / 404. The server outbox persists and runs without a browser; it does not bypass proof verification for indexed data.

**Preserved:** all three named cases and their side effects; no SQL-layer or cross-owner safety retirement merely because the implementation paths differ. The draft HTTP target supplements the repository assertion.

### #46 — [M1.3.4] Serialize writes and bound database contention

[Current issue](https://github.com/junepark678/atproto_music/issues/46) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** replace the Rust writer-channel mechanism with an explicitly reviewed Node contention/admission contract.

**Precise obsolete clauses:** “one writer task with a bounded 1024-command channel,” channel acknowledgements and service_busy specifically from that channel; `queue_full` pausing/filling those 1024 slots; `locked_database` allowing a separately held external write lock during normal operation and later returning storage_busy. Node holds an exclusive database lock for its lifetime, so that lock test is not the same mechanism. No-loss, bounded admission, and no partial writes remain valid safety requirements.

**Authority:** accepted B1 and §3.2 / §3.10 (synchronous writer and exclusive lock), B7 (durable outbox), B10/B19 (tests/traceability). Draft **M1.3.4 leaf / B1** remaps locked_database only. It does **not** name queue_full for retirement.

**Proposed append (plus S and T; bounded-admission translation requires review):**

> Replace the Rust writer task/channel with one Node connection and synchronous main-thread transactions; every network await stays outside a transaction. Retain concurrent_writes: 100 distinct submissions from ten concurrent sessions/tasks yield exactly 100 durable operations and acknowledgements, without lost updates. The new deterministic regression drives the composed API dispatcher with 100 concurrent writes across ten session cookies and checks the exact operation/idempotency rows; it is not a socket-level child-process or bounded-queue test. Remap locked_database to the actual single-instance boundary: a second bundled process on the same database, even with another admin socket path, exits 75 database_locked after the production five-second busy timeout, without partial writes or modifying the first instance's data; test short injected timeouts separately and stale-socket recovery.
>
> The 1024-slot Rust channel itself is superseded, not recreated in Node. The existing ingestion/snapshot admission `queue_full` (503) is a different operation and does not test the original writer-command queue's `service_busy` result. Before this issue can complete, specify and test the active bounded write-admission/queue boundary and its documented full response: fill it, reject one extra request promptly, enqueue/persist no rejected work, and prove no lost acknowledged work. Keep the original queue_full/service_busy regression obligation pending that explicit mapping; do not retire it under B1, conflate it with ingest queue_full, or substitute a passing database-lock test.

**Review required:** approve the precise Node bound and error contract before replacing the old 1024/service_busy assertion. §16 does not by itself establish that replacement capacity/status. Do not conflate the ingestion `queue_full`, durable outbox limits, or an unrelated HTTP limit without demonstrating the intended coverage. Until then this is an unresolved requirement, not permission for unbounded buffering.

### #47 — [M1.4.1] Implement typed environment configuration and migrate CLI

[Current issue](https://github.com/junepark678/atproto_music/issues/47) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** replace obsolete CLI/env/default/precedence contract; retain configuration failures and migration-only intent pending explicit mapping.

**Precise obsolete clauses:** `serve`/`migrate` shape; ATMUSIC_BIND=127.0.0.1:3000, ATMUSIC_DATABASE_PATH=data/music.sqlite; general “CLI flags take precedence over env”; `bind_precedence` CLI 3002 versus env 3001 and invalid-address exit 2. `migrate_only` requires a no-listener command not automatically established by Node --init. The namespace variable spelling changes as in #36.

**Authority:** accepted B1, B3, B16, B17, B20 and §3.2 / §3.8 / §3.10; draft **M1.4.1 leaf / B1** remaps bind_precedence, not migrate_only.

**Proposed append (plus S and T):**

> Use the Node host's configuration: LISTEN_FDS inherited socket takes precedence over ATMUSIC_LISTEN, which takes precedence over the loopback default 127.2.0.1:8888. ATMUSIC_DB defaults to $STATE_DIRECTORY/atmusic.db and fails configuration if neither is provided; missing database needs explicit --init. Use LEXICON_PREFIX and NAMESPACE_OWNERSHIP_REF. Require HTTPS public origin, client-IP mode, valid allowlist policy/DIDs and sealed credential/key configuration. Secrets arrive through the systemd credential (or the strictly permission-checked development secrets file), not plain key environment variables. Invalid config exits 78 naming the offending field without secret values. Retain relay/public-origin/namespace/path/key checks and prohibit TLS/proxy/runtime-environment bypasses. Reject pulse/retired operator plan settings as specified by ADR 0005.
>
> Keep bind_precedence under the new inherited-socket/environment/default matrix, with invalid-address rejection. The accepted host performs its pre-migration backup and migrations synchronously before binding the HTTP listener. A new deterministic run test probes the real configured port during startup and proves every connection is refused until migration completes; after bind, the database is at the latest version and readiness is 200. However, the Node host has no standalone `--migrate-only` CLI, and the original case's no-listener command is not proven by `--init` or this startup-order test. Propose replacing that CLI-specific case with the migration-before-listen safety contract only if the issue owner accepts that architecture; otherwise add/test an explicit existing-database-only command that exits without binding. Keep `migrate_only` unresolved until that review decision is recorded.

**Preserved / review required:** invalid_config redaction and no accidental listener during migration. Do not retire migrate_only merely because the draft leaf table omits it; startup migration ordering is evidence for the accepted host, not a standalone no-listener CLI. File roles move to worker/src/node/{config,secrets,run,main}.ts and owning Node/process tests; historical Rust CLI remains separate.

### #48 — [M1.4.2] Implement health, metadata, and uniform HTTP errors

[Current issue](https://github.com/junepark678/atproto_music/issues/48) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** minimal runtime/readiness/meta clarification; no weakening of health/error cases.

**Precise obsolete clauses:** “writer initialization” if read as creation of the Rust writer task, and Rust HTTP file ownership. B18 changes stage/capability reporting; it does not obsolete UUID request IDs or safe_errors. None of the three named test outcomes requires retirement.

**Authority:** accepted B1, B9, B14, B18 and §3.10; B10 for tests. **No separate M1.4.2 draft leaf amendment.**

**Proposed append (plus S and T):**

> Readiness is evaluated by the Node composition after migration/compatibility checks, valid config/secrets/OAuth keyset, and a rolled-back database write probe. Preserve ready_before_storage (503 storage_not_ready for uninitialized/failed storage, live=200), upstream_outage (initialized healthy storage remains ready=200 with upstream degradation in metadata), and safe_errors (uniform code/message/requestId, valid consistent UUID, no stack traces/credentials). Add the accepted incompatible-schema behavior separately as in #44. low_disk and oauth_store_degraded are readiness warnings, not alone a status change. Meta stage reflects the Node composition and capabilities follow B14/B18 only when initialized; do not advertise publication before its gate is satisfied. Logs use secret-safe journald JSON, never query strings or bodies. Active file roles are the shared HTTP health/error/meta code plus Node composition and its tests.

**Preserved:** upstream-independent liveness, storage readiness failures, request-ID propagation/UUID assertion and exact safe-error/redaction checks. If current implementation uses a different ID or error code, that is a gap for review/fix, not an ADR-authorized relaxation.

### #49 — [M1.4.3] Add server harness and bounded shutdown

[Current issue](https://github.com/junepark678/atproto_music/issues/49) · **Observed status: OPEN. Proposed status: OPEN.**

**Disposition:** restore/retain real process shutdown, amend exact drain window and host harness.

**Precise obsolete clauses:** Rust harness/shutdown paths; `drain_timeout`'s “pause one writer beyond 30s” as a Rust channel mechanism and exact Node request-drain window. “At most 30 seconds,” isolated temporary files/port 0, and acknowledged-write recovery remain valid. Earlier Workers A18/D retirement is not valid now.

**Authority:** accepted B1, B10, B16; ADR 0005 §3.10. Draft **M1.4.3 leaf / B16** restores drain_timeout, rather than retiring the unit.

**Proposed append (plus S and T):**

> Use the actual Node router/composition with one temporary SQLite file per test file; listener tests bind ephemeral port 0 and return client/teardown handles. Retain harness_isolation (different files/ports, no leakage), and drain_success (three acknowledged writes durable after closing/reopening the same database). On SIGTERM send STOPPING=1, stop admission, drain in-flight requests with production drainMs=25000 and a service bound of 30 seconds, close Jetstream/current bounded timer slice and database, then exit 0. Inject a short drain and clock in deterministic tests; spawn the built main.mjs for packaged process acceptance with explicit test timeouts.
>
> Remap drain_timeout to a request held beyond the injected deadline: abort it, log and assert the exact unfinished in-flight request count (not merely `drained:false`), close resources and terminate. The current deterministic test asserts `inFlight: 1`, closes the database, and proves a separately committed pending operation survives reopening the same file; startup reconciliation leaves that row `blocked` with `attempts: 0` because the test intentionally has no OAuth session. It also proves a persisted ingestion hint remains available after restart. This is persistence evidence, not proof that the operation is unblocked and sent after sign-in. The reported `inFlight` field counts HTTP requests, not all queued/unfinished outbox work; any original aggregate unfinished-work count remains unproven and must not be inferred from this value. Verify persisted acknowledgements are not lost on either drain path. Keep the timeout/report/restart obligations, not just a successful exit assertion. The five-second packaged expectation in #42 is separately amended; no timing assertion is silently claimed passed.

**Explicit unresolved mapping — keep `drain_timeout` pending:** The current test's `shutdown.drain_expired.inFlight === 1` is an in-flight HTTP-request count, not the original aggregate unfinished-work count. It proves a pending outbox row and ingestion hint survive close/reopen, but the operation is `blocked` with `attempts: 0` because the fixture has no OAuth session; it does not show that persisted write becoming eligible, resuming/reconciling after restart, or avoiding a duplicate remote effect. Thus the issue's unfinished-work reporting and restart-recovery assertions are **not mapped by this test**. Before an owner-approved replacement can claim equivalence, add a named acceptance that defines and asserts the required unfinished-work count, then restarts with the prerequisites needed to resume/reconcile persisted work and proves no duplicate side effect. Otherwise leave the original requirement unchanged and open.

**Preserved:** all named isolation/durability/timeout cases, teardown, recoverable persisted work, and bounded shutdown. The draft leaf's abort/close/exit target does not alone prove original unfinished-work reporting and recovery; retain additional assertions/evidence for those properties.

## Review checklist before any future publication

- Approve exact overrides and shared S/T text against current bodies; keep every issue OPEN and leave titles, dependency/subissue relationships, and checkboxes intact. Resolve the explicitly marked semantic/mapping questions rather than publishing an implication that they are settled.
- Confirm named-case traceability including cases not listed in the draft leaf tables: #42 packaged_http, #46 queue_full, #47 migrate_only, and #49 recovery/reporting. For #49 specifically, the current `inFlight` request count and blocked-row persistence are not the original unfinished-work count or resumed-work proof; keep both criteria pending. Retain #43's named foreign-key/no-dangling-owner assertion unless an owner-approved equivalent is demonstrated, and preserve #48's UUID/error checks.
- Review and publish amendments only as a separate authorized action. Acceptance requires merged deliverables, actual affected tests and current toolchain/hosted/artifact evidence, and all inherited prerequisites; publication of an amendment itself completes no issue.
- Recheck the dated namespace evidence at release time and obtain owner-reviewed publication/public retrieval of all four production schemas. **DNS authority proof is present; schema publication remains outstanding. Keep the gate closed.**
- M7 remains excluded. No new build, CI, deployment, live acceptance run, DNS/PDS probe, or external write was performed for this proposal. Only the GitHub read and document preparation were performed.

**Final scope/status:** 19 M1 issues reviewed; 19 remain OPEN. #38 needs no semantic amendment, only active-runtime execution/file-role clarification. **No GitHub issue was changed.** This unpublished proposal was prepared under the user's explicit reconciliation objective and remains subject to review before publish.
