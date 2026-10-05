# AT Protocol music MVP plan

Status: published and verified on GitHub. All 121 issues are published and verified: seven milestone parents, 28 coordination subissues, and 86 implementation leaves. All 114 subissue relationships, milestone assignments, leaf test matrices and native leaf dependency relationships were read back from GitHub.

## Scope and decisions

Build a Last.fm-style music listening application with public scrobbles, listening history, top artists/tracks/albums, profiles, music follows, and chronological global/following feeds. Existing AT Protocol accounts sign in via OAuth; their own external PDS stores their authoritative records. Our service is an AppView/indexer and write client, not a PDS or relay. Federation means interoperable AT records and ingestion from external writers, not a proprietary peer-to-peer database protocol.

Use one Rust HTTP process with embedded SQLite, embedded frontend assets, and an x86_64 Linux musl release executable. The user withdrew dynamic linking from the request; it is deferred. Preact SPA is in scope but lower priority: implementation starts after M6 backend acceptance. Define its API contract in M1. Use a reverse proxy for public HTTPS and provide an encryption key through operator configuration. SQLite is single-instance; scaling to multiple writers is deferred.

No recommendation engine, audio streaming/playback, hosted PDS/account creation, Last.fm API compatibility, Spotify/desktop player integrations, bulk historical imports, likes/comments/reposts, or native apps in this MVP. Manual scrobbling and externally published records are the first input paths. No external music catalog dependency is required.

## Protocol and data rules

- Production lexicon prefix must be an owner-controlled reverse-domain NSID. com.example.atmusic is fixture-only; do not publish public records under it. M1.1 explicitly tracks owner namespace selection as a required release prerequisite, without inventing ownership.
- Collections are <prefix>.scrobble and <prefix>.follow; lexicons use schema version 1. A follow contains subject (DID) and createdAt (UTC RFC3339). A scrobble contains artist (1–256 Unicode scalar values and at most 1,024 UTF-8 bytes), track (same limits), listenedAt, createdAt, optional album (same limits), optional durationSeconds (integer 1–86,400), and optional recordingMbid (UUID). Trim required strings and reject empty values. Artist is one credited display string in v1; multi-artist structured identities are deferred.
- listenedAt and createdAt are UTC RFC3339 timestamps. Reject timestamps more than five minutes ahead of server time; accept historical listens back to 1970-01-01. Validate ingestion against event receipt time rather than replay wall time. Remote malformed records are excluded with a reason metric. No duration threshold is enforced: scrobble records assert completed listening, and the client owns that judgment.
- Use DID for users and AT URI for public record identity. CID/repository revision are version evidence. Each legitimate record counts as one listen; repeated plays at equal timestamps are allowed. Transport deduplication uses AT URI and owner-scoped request idempotency, not artist/title/time heuristics.
- Local operation IDs are opaque random identifiers, distinct from AT URIs. POST requires Idempotency-Key (1–128 ASCII printable characters). Persist the payload digest/key with operation state until the account is disconnected. Derive ownership from the authenticated session, never the payload.
- Schema-valid verified repository records are public source of truth. A local queue acknowledgement is not a published scrobble. Updates/deletes adjust the index. Local pending deletion hides a record immediately while upstream failure remains visible to the owner.
- Normalize grouping strings with Unicode NFKC, full Unicode case-folding, trimming, and collapsed whitespace. Artist key = normalized artist; track key = tuple(normalized artist, normalized track); album key = tuple(normalized artist, normalized album). Missing albums are excluded from album rankings. MBIDs remain unverified optional metadata, not primary grouping keys. Retain original display values; choose the newest listen's display text with AT URI tie-break.
- Music follows use the custom collection, separate from app.bsky.graph.follow. A deterministic record key is 'f' followed by lowercase hex SHA-256(subject DID). Remote duplicate edges collapse to actor/subject; remove an edge only when no active matching record remains.
- Feed is this application's API over custom AT records. It is not a Bluesky feed-generator skeleton: Bluesky clients expect post records and cannot be assumed to render custom music lexicons. Third-party music clients can use the published lexicons and create compatible records directly.
- Require a supported relay covering the intended external PDSs. Verify repository signatures, CIDs, and record membership. Historical discovery is limited to known/seeded actors and configured relay coverage. Do not promise global discovery or complete historical coverage.

## API contract to freeze in M1

Exact endpoint payloads, field names and statuses are fixed in [API.md](API.md); M1.1.4 encodes that document in OpenAPI without independent payload design.

All JSON API routes use /api/v1. Standard errors: {error: {code, message, requestId, fields?}}. GET responses return 200; invalid JSON 400; invalid fields 422; authentication 401; ownership 403; absent resource 404; idempotency conflict 409; oversized input 413; rate limit 429; upstream permanent error 502 when synchronous. Async operation failures are represented in operation status, not fabricated HTTP success. Public collection endpoints have limit default 20/max 100 and opaque cursors. Response schemas must explicitly name every field in M1.1.

| Area | Routes |
| --- | --- |
| Health/config | GET /health/live; GET /health/ready; GET /api/v1/meta |
| Identity | GET /oauth/client-metadata.json; POST /api/v1/auth/start; GET /api/v1/auth/callback; GET /api/v1/auth/session; POST /api/v1/auth/logout; GET /api/v1/resolve?handle=... |
| Listening | POST /api/v1/scrobbles; GET /api/v1/scrobbles/{id}; DELETE /api/v1/scrobbles/{id}; GET /api/v1/users/{did}/scrobbles; GET /api/v1/operations/{id} |
| Read models | GET /api/v1/users/{did}/profile; GET /api/v1/users/{did}/stats?window=all\|7d\|30d\|365d&limit=...; GET /api/v1/feed?scope=global\|following |
| Social | PUT /api/v1/follows/{did}; DELETE /api/v1/follows/{did}; GET /api/v1/users/{did}/following; GET /api/v1/users/{did}/followers |
| User controls | GET /api/v1/account/export; DELETE /api/v1/account/local-data |

All user history/profile/stats and confirmed follows are public. Session, mutation, operation, export, and local-data endpoints require the relevant owner session. Every state-changing session endpoint requires same-origin validation and a CSRF token, except auth/start which validates Origin and creates one-time OAuth state. OAuth callback uses OAuth state validation. Scrobble {id} is the URL-encoded full AT URI. Queue status is pending/succeeded/failed with attempt count, timestamps, and sanitized failure code. Operation lookup returns 403 for a known operation owned by a different signed-in DID and 404 for an absent operation; anonymous requests return 401. Local scrobble input rejects unknown fields with 422. OAuth state expires at exactly 300 seconds. Outbox retry delay is min(300s, exponential base plus uniform jitter from 0 to one quarter of that base); zero injected jitter yields 1s,2s,4s,… . A capped Retry-After can increase that delay.

Statistics return totalScrobbles, distinctArtists, distinctTracks, topArtists, topTracks, topAlbums, window, and asOf. Top lists default to 10/max 100; ties use normalized grouping keys ascending. Feed/history cursors anchor a first-page upper ordering boundary and a last-seen (listenedAt, AT URI) tuple; delete/update visibility follows current state, so this is stable traversal without full historical snapshot isolation. Document this limit; never claim a cursor freezes mutable records.

## Completion and execution rules

Each implementation leaf specifies a single unit, exact file ownership, named test inputs/outcomes, and dependency links. Milestone parents and the 28 original broad issues are coordination only; implement their linked leaves. Link actual GitHub subissues, not only task-list references. Milestone order is M1 through M7 for closure; leaf dependencies are authoritative and permit prerequisite modules and fixture tasks to start across backend milestones. OAuth fixture/token/session storage precedes callback integration; cursor codec precedes history pagination. Do not infer a blanket start barrier from a milestone number; M7 alone retains the explicit backend acceptance start gate. Do not start frontend implementation before M6.4. No due dates or estimates are invented.

An issue is complete only when its deliverables are merged, acceptance checks actually pass, configuration/API changes are documented, and required live results are recorded. Report passed, failed, skipped, and blocked separately. Fixtures establish deterministic correctness; they do not replace required external-PDS/relay/browser compatibility evidence. Tests must exercise meaningful behavior and preserve real runner exit status. Missing domain ownership, OAuth callback HTTPS, test identities, relay access, or operator credentials are concrete blockers, not reasons to silently weaken scope.

Maintain protocol revisions/dependency versions explicitly and follow authoritative AT Protocol documentation for OAuth, identity, lexicons, repository verification, and sync. Library choices may change only with an issue amendment explaining a demonstrated compatibility gap; do not invent crypto or disable TLS/signature verification. Never put credentials into issue bodies, repository fixtures, or logs.

## GitHub publication

github-plan.json contains seven milestones, seven milestone parents, 28 coordination issues, and 86 implementation leaves. Keys M1…M7 and M1.1…M7.4 are permanent planning identifiers, not GitHub issue numbers. For repeat publication, first inspect existing milestones/issues, match exact keys, create missing milestones and issues, resolve dependency keys to issue links, attach every child through GitHub's subissue API, and record resulting URLs/IDs. Retry must reuse already-created objects. Preserve existing work; do not close or overwrite unrelated issues.

Network requirement api.github.com was saved in the environment configuration draft, preserving the package-manager preset. Runtime API connectivity and repository write permissions were subsequently verified, and GitHub publication completed. This does not claim that the environment snapshot itself was published. If future API access fails, distinguish proxy connectivity from authentication and configure access securely; never share tokens in chat.




## Refined implementation hierarchy

Every broad implementation issue now coordinates three or four smaller units. Exact test matrices are in the issue bodies and the machine-readable manifest. The original requirements remain binding.

### M1: Backend foundation and fixed contracts

Freeze the interoperable data model and run a single Rust HTTP process backed by embedded SQLite.

Completion gate: Fresh checkout builds, migrates an empty database, starts, and passes contract and database tests. Public record publication remains disabled until an owned NSID namespace is recorded.

#### [[M1.1] Specify lexicons, API v1, and MVP invariants](https://github.com/junepark678/atproto_music/issues/2)

- **[[M1.1.1] Gate production namespace and freeze schema version](https://github.com/junepark678/atproto_music/issues/36)** — docs/adr/0001-namespace.md; crates/core/src/namespace.rs
- **[[M1.1.2] Define and validate the scrobble lexicon](https://github.com/junepark678/atproto_music/issues/37)** — lexicons/scrobble.json; crates/core/src/scrobble.rs; tests/fixtures/scrobbles/
- **[[M1.1.3] Define and validate the music-follow lexicon](https://github.com/junepark678/atproto_music/issues/38)** — lexicons/follow.json; crates/core/src/follow.rs
- **[[M1.1.4] Freeze OpenAPI v1 schemas and endpoint status matrices](https://github.com/junepark678/atproto_music/issues/39)** — api/openapi.yaml; api/examples/; scripts/validate_contracts.py

#### [[M1.2] Create the Rust workspace and static executable build](https://github.com/junepark678/atproto_music/issues/3)

- **[[M1.2.1] Pin the Rust workspace, dependencies, and crate boundaries](https://github.com/junepark678/atproto_music/issues/40)** — Cargo.toml; Cargo.lock; rust-toolchain.toml; crates/*/Cargo.toml
- **[[M1.2.2] Wire formatting, lint, and meaningful-test CI](https://github.com/junepark678/atproto_music/issues/41)** — .github/workflows/ci.yml; scripts/check.sh; crates/server/tests/scaffold.rs
- **[[M1.2.3] Build and smoke-test a self-contained musl artifact](https://github.com/junepark678/atproto_music/issues/42)** — .github/workflows/ci.yml; scripts/smoke.py; Cargo.toml release profile

#### [[M1.3] Implement SQLite schema, migrations, and repositories](https://github.com/junepark678/atproto_music/issues/4)

- **[[M1.3.1] Define SQLite schema and invariant constraints](https://github.com/junepark678/atproto_music/issues/43)** — crates/storage/migrations/0001_initial.sql; docs/storage.md
- **[[M1.3.2] Implement embedded forward migrations and database open](https://github.com/junepark678/atproto_music/issues/44)** — crates/storage/src/database.rs; crates/storage/src/migrations.rs
- **[[M1.3.3] Implement typed repository operations and transactions](https://github.com/junepark678/atproto_music/issues/45)** — crates/storage/src/repositories/; crates/storage/tests/repositories.rs
- **[[M1.3.4] Serialize writes and bound database contention](https://github.com/junepark678/atproto_music/issues/46)** — crates/storage/src/writer.rs; crates/storage/tests/concurrency.rs

#### [[M1.4] Implement HTTP skeleton, configuration, and contract test harness](https://github.com/junepark678/atproto_music/issues/5)

- **[[M1.4.1] Implement typed environment configuration and migrate CLI](https://github.com/junepark678/atproto_music/issues/47)** — crates/server/src/config.rs; crates/server/src/main.rs
- **[[M1.4.2] Implement health, metadata, and uniform HTTP errors](https://github.com/junepark678/atproto_music/issues/48)** — crates/server/src/http/health.rs; crates/server/src/http/error.rs
- **[[M1.4.3] Add server harness and bounded shutdown](https://github.com/junepark678/atproto_music/issues/49)** — crates/server/tests/common/mod.rs; crates/server/src/shutdown.rs

### M2: AT Protocol sign-in and secure sessions

Authenticate existing accounts on external PDSs using AT Protocol OAuth and establish secure application sessions.

Completion gate: A browser sign-in against a controlled external test PDS succeeds; refresh, sign-out, and negative security cases pass. No app passwords are required.

#### [[M2.1] Implement identity discovery and safe outbound requests](https://github.com/junepark678/atproto_music/issues/7)

- **[[M2.1.1] Resolve handles and validate DID identity](https://github.com/junepark678/atproto_music/issues/50)** — crates/atproto/src/identity.rs
- **[[M2.1.2] Harden all metadata/PDS fetch destinations](https://github.com/junepark678/atproto_music/issues/51)** — crates/atproto/src/http/safe_client.rs
- **[[M2.1.3] Discover PDS and OAuth issuer metadata](https://github.com/junepark678/atproto_music/issues/52)** — crates/atproto/src/oauth/discovery.rs

#### [[M2.2] Implement AT Protocol OAuth authorization and callback](https://github.com/junepark678/atproto_music/issues/8)

- **[[M2.2.1] Choose maintained OAuth dependencies and serve client metadata](https://github.com/junepark678/atproto_music/issues/53)** — docs/adr/0002-oauth.md; crates/atproto/Cargo.toml; crates/server/src/http/oauth_metadata.rs
- **[[M2.2.2] Implement auth start, PKCE, state, and PAR](https://github.com/junepark678/atproto_music/issues/54)** — crates/atproto/src/oauth/start.rs; crates/server/src/http/auth_start.rs
- **[[M2.2.3] Implement callback verification and DPoP nonce retry](https://github.com/junepark678/atproto_music/issues/55)** — crates/atproto/src/oauth/callback.rs; crates/server/src/http/auth_callback.rs

#### [[M2.3] Implement encrypted token persistence and application sessions](https://github.com/junepark678/atproto_music/issues/9)

- **[[M2.3.1] Encrypt OAuth material and serialize token refresh](https://github.com/junepark678/atproto_music/issues/56)** — crates/atproto/src/oauth/token_store.rs; crates/storage/src/repositories/oauth.rs
- **[[M2.3.2] Issue hashed sessions and enforce CSRF](https://github.com/junepark678/atproto_music/issues/57)** — crates/server/src/auth/session.rs; crates/server/src/auth/csrf.rs
- **[[M2.3.3] Implement logout and upstream revocation behavior](https://github.com/junepark678/atproto_music/issues/58)** — crates/server/src/http/logout.rs; crates/atproto/src/oauth/revoke.rs

#### [[M2.4] Add OAuth integration fixtures and an external-PDS verification runbook](https://github.com/junepark678/atproto_music/issues/10)

- **[[M2.4.1] Build deterministic OAuth/PDS fixture servers](https://github.com/junepark678/atproto_music/issues/59)** — crates/atproto/tests/support/oauth_pds.rs; tests/fixtures/oauth/
- **[[M2.4.2] Add OAuth/session negative integration matrix](https://github.com/junepark678/atproto_music/issues/60)** — crates/server/tests/oauth_security.rs
- **[[M2.4.3] Run and record live external-PDS OAuth interoperability](https://github.com/junepark678/atproto_music/issues/61)** — docs/verification/oauth-live.md; scripts/live/oauth_check.*

### M3: Scrobble publishing and listening history

Accept authenticated scrobbles, publish them to the user's own PDS, and expose reliable paginated listening history.

Completion gate: Create, retry, list, and delete a scrobble through the application and verify the corresponding external PDS record, including recovery after interrupted writes.

#### [[M3.1] Implement scrobble validation and ingestion API](https://github.com/junepark678/atproto_music/issues/12)

- **[[M3.1.1] Implement authenticated scrobble input and idempotency admission](https://github.com/junepark678/atproto_music/issues/62)** — crates/server/src/http/scrobbles/create.rs; crates/storage/src/repositories/idempotency.rs
- **[[M3.1.2] Implement public history and record lookup](https://github.com/junepark678/atproto_music/issues/63)** — crates/server/src/http/scrobbles/read.rs; crates/storage/src/repositories/history.rs
- **[[M3.1.3] Implement opaque history cursors with mutation semantics](https://github.com/junepark678/atproto_music/issues/64)** — crates/core/src/cursor.rs; crates/server/tests/history_cursor.rs

#### [[M3.2] Implement durable PDS write outbox and idempotent recovery](https://github.com/junepark678/atproto_music/issues/13)

- **[[M3.2.1] Persist outbox state and expose owner-bound operation status](https://github.com/junepark678/atproto_music/issues/65)** — crates/storage/src/repositories/outbox.rs; crates/server/src/http/operations.rs
- **[[M3.2.2] Execute bounded retry and DPoP-authorized PDS writes](https://github.com/junepark678/atproto_music/issues/66)** — crates/atproto/src/pds/write.rs; crates/server/src/workers/outbox.rs
- **[[M3.2.3] Reconcile ambiguous creates and prevent duplicates after crashes](https://github.com/junepark678/atproto_music/issues/67)** — crates/atproto/src/pds/reconcile.rs; crates/server/tests/outbox_recovery.rs

#### [[M3.3] Implement owner deletion and cross-store reconciliation](https://github.com/junepark678/atproto_music/issues/14)

- **[[M3.3.1] Authorize deletion and atomically mark tombstones](https://github.com/junepark678/atproto_music/issues/68)** — crates/server/src/http/scrobbles/delete.rs; crates/storage/src/repositories/deletions.rs
- **[[M3.3.2] Handle remote delete idempotency and create/delete races](https://github.com/junepark678/atproto_music/issues/69)** — crates/atproto/src/pds/delete.rs; crates/server/src/workers/outbox.rs
- **[[M3.3.3] Propagate deletion to every read model and owner status](https://github.com/junepark678/atproto_music/issues/70)** — crates/storage/tests/deletion_views.rs; crates/server/tests/deletion.rs

#### [[M3.4] Validate the full scrobble lifecycle across an external PDS](https://github.com/junepark678/atproto_music/issues/15)

- **[[M3.4.1] Add deterministic scrobble HTTP lifecycle tests](https://github.com/junepark678/atproto_music/issues/71)** — crates/server/tests/scrobble_lifecycle.rs
- **[[M3.4.2] Add fault-injected restart and pagination acceptance tests](https://github.com/junepark678/atproto_music/issues/72)** — crates/server/tests/scrobble_faults.rs
- **[[M3.4.3] Record live external-PDS scrobble lifecycle evidence](https://github.com/junepark678/atproto_music/issues/73)** — docs/verification/scrobble-live.md; scripts/live/scrobble_check.*

### M4: Federated indexing and AT Protocol feed

Index music records published outside this application and serve a deterministic music feed from verified AT Protocol repository events.

Completion gate: A second independent writer publishes on another PDS; its records appear without calling this application's write API, and updates/deletes/reconnect/backfill behave correctly.

#### [[M4.1] Consume and verify AT Protocol repository events](https://github.com/junepark678/atproto_music/issues/17)

- **[[M4.1.1] Parse bounded relay frames and select music operations](https://github.com/junepark678/atproto_music/issues/74)** — crates/atproto/src/sync/frames.rs
- **[[M4.1.2] Verify commit signatures, CIDs, and MST membership](https://github.com/junepark678/atproto_music/issues/75)** — crates/atproto/src/sync/verify.rs; docs/adr/0003-repo-verification.md
- **[[M4.1.3] Apply verified mutations and checkpoint atomically](https://github.com/junepark678/atproto_music/issues/76)** — crates/storage/src/repositories/relay.rs; crates/server/tests/relay_apply.rs

#### [[M4.2] Implement reconnect, repository backfill, and account reconciliation](https://github.com/junepark678/atproto_music/issues/18)

- **[[M4.2.1] Implement cursor reconnect and gap detection](https://github.com/junepark678/atproto_music/issues/77)** — crates/atproto/src/sync/stream.rs; crates/server/src/workers/relay.rs
- **[[M4.2.2] Implement verified repository backfill and revision convergence](https://github.com/junepark678/atproto_music/issues/78)** — crates/atproto/src/sync/backfill.rs; crates/storage/src/repositories/backfill.rs
- **[[M4.2.3] Reconcile account state, identity changes, and status](https://github.com/junepark678/atproto_music/issues/79)** — crates/atproto/src/sync/accounts.rs; crates/server/src/http/index_status.rs

#### [[M4.3] Serve chronological global and following music feeds](https://github.com/junepark678/atproto_music/issues/19)

- **[[M4.3.1] Implement global chronological music feed queries](https://github.com/junepark678/atproto_music/issues/80)** — crates/storage/src/repositories/feed.rs; crates/server/src/http/feed.rs
- **[[M4.3.2] Implement following scope and viewer-bound cursors](https://github.com/junepark678/atproto_music/issues/81)** — crates/server/src/http/feed.rs; crates/core/src/cursor.rs
- **[[M4.3.3] Test feed pagination under updates and external deletes](https://github.com/junepark678/atproto_music/issues/82)** — crates/server/tests/feed_cursor.rs

#### [[M4.4] Prove federation with two independent PDS writers](https://github.com/junepark678/atproto_music/issues/20)

- **[[M4.4.1] Create independent-writer federation harness](https://github.com/junepark678/atproto_music/issues/83)** — crates/server/tests/support/federation.rs; scripts/live/federation_check.*
- **[[M4.4.2] Add federation fault and convergence suite](https://github.com/junepark678/atproto_music/issues/84)** — crates/server/tests/federation_faults.rs
- **[[M4.4.3] Run two-external-PDS live federation acceptance](https://github.com/junepark678/atproto_music/issues/85)** — docs/verification/federation-live.md

### M5: Music statistics, profiles, and follows

Provide the core Last.fm-style read experience: profiles, listening totals, top tracks/artists/albums, and a following feed.

Completion gate: Two accounts can follow/unfollow, browse each other's history, and see correct all-time and rolling-window statistics after remote updates and deletions.

#### [[M5.1] Implement deterministic music identity and aggregate queries](https://github.com/junepark678/atproto_music/issues/22)

- **[[M5.1.1] Implement exact Unicode music grouping keys](https://github.com/junepark678/atproto_music/issues/86)** — crates/core/src/music_key.rs
- **[[M5.1.2] Implement exact rolling-window totals and rankings](https://github.com/junepark678/atproto_music/issues/87)** — crates/storage/src/repositories/stats.rs; crates/server/src/http/stats.rs
- **[[M5.1.3] Test incremental mutation correctness and SQL plans](https://github.com/junepark678/atproto_music/issues/88)** — crates/storage/tests/stats_mutations.rs; docs/benchmarks/stats.md

#### [[M5.2] Implement public music profiles and handle lookup](https://github.com/junepark678/atproto_music/issues/23)

- **[[M5.2.1] Serve verified handle resolution and stable DID profiles](https://github.com/junepark678/atproto_music/issues/89)** — crates/server/src/http/resolve.rs; crates/server/src/http/profile.rs
- **[[M5.2.2] Define unknown, empty, and inactive profile behavior](https://github.com/junepark678/atproto_music/issues/90)** — crates/storage/src/repositories/profiles.rs; crates/server/tests/profile_states.rs
- **[[M5.2.3] Assert public profile privacy and caching rules](https://github.com/junepark678/atproto_music/issues/91)** — crates/server/tests/profile_privacy.rs; crates/server/src/http/profile.rs

#### [[M5.3] Publish and index music follows](https://github.com/junepark678/atproto_music/issues/24)

- **[[M5.3.1] Publish and delete idempotent music-follow records](https://github.com/junepark678/atproto_music/issues/92)** — crates/server/src/http/follows/write.rs; crates/atproto/src/pds/follow.rs
- **[[M5.3.2] Index external follows and serve followers/following lists](https://github.com/junepark678/atproto_music/issues/93)** — crates/storage/src/repositories/follows.rs; crates/server/src/http/follows/read.rs
- **[[M5.3.3] Integrate follow/account state into feed membership](https://github.com/junepark678/atproto_music/issues/94)** — crates/server/tests/follow_feed.rs

#### [[M5.4] Add read-model and social integration acceptance suite](https://github.com/junepark678/atproto_music/issues/25)

- **[[M5.4.1] Commit deterministic read-model fixtures and expected results](https://github.com/junepark678/atproto_music/issues/95)** — tests/fixtures/read_models.json; docs/planning/TESTING.md
- **[[M5.4.2] Add exact HTTP assertions for read models and social flows](https://github.com/junepark678/atproto_music/issues/96)** — crates/server/tests/read_model_acceptance.rs
- **[[M5.4.3] Verify persistence with packaged process restart](https://github.com/junepark678/atproto_music/issues/97)** — crates/server/tests/read_model_restart.rs

### M6: Deployable self-contained backend and operational safety

Release the single-binary backend with static asset serving, health/metrics, backups, resource limits, and repeatable deployment instructions.

Completion gate: Release executable runs with one persistent data directory and public HTTPS termination; backup/restore and failure recovery pass, with live federation/OAuth evidence recorded.

#### [[M6.1] Implement asset embedding, configuration, and deployment example](https://github.com/junepark678/atproto_music/issues/27)

- **[[M6.1.1] Embed compile-time assets and implement safe SPA routing](https://github.com/junepark678/atproto_music/issues/98)** — crates/server/src/http/assets.rs; crates/server/assets/; crates/server/build.rs
- **[[M6.1.2] Validate public-origin and trusted-proxy deployment settings](https://github.com/junepark678/atproto_music/issues/99)** — crates/server/src/config.rs; docs/deployment.md
- **[[M6.1.3] Document fresh install, upgrade, and restart workflow](https://github.com/junepark678/atproto_music/issues/100)** — docs/deployment.md; config/atmusic.env.example

#### [[M6.2] Add limits, observability, and safe degradation](https://github.com/junepark678/atproto_music/issues/28)

- **[[M6.2.1] Enforce body limits and bounded per-user/IP rates](https://github.com/junepark678/atproto_music/issues/101)** — crates/server/src/http/limits.rs
- **[[M6.2.2] Expose safe metrics and degrade on upstream outages](https://github.com/junepark678/atproto_music/issues/102)** — crates/server/src/metrics.rs; crates/server/src/http/meta.rs
- **[[M6.2.3] Add reproducible query latency benchmark](https://github.com/junepark678/atproto_music/issues/103)** — scripts/benchmark_read_models.*; docs/benchmarks/read_models.md

#### [[M6.3] Implement database backup, restore, export, and account disconnect](https://github.com/junepark678/atproto_music/issues/29)

- **[[M6.3.1] Implement consistent SQLite backup and verified restore](https://github.com/junepark678/atproto_music/issues/104)** — crates/storage/src/backup.rs; crates/server/src/main.rs; docs/backup.md
- **[[M6.3.2] Implement owner-only JSON account export](https://github.com/junepark678/atproto_music/issues/105)** — crates/server/src/http/account_export.rs
- **[[M6.3.3] Implement local-data disconnect and indexing suppression](https://github.com/junepark678/atproto_music/issues/106)** — crates/server/src/http/account_disconnect.rs; crates/storage/src/repositories/disconnect.rs

#### [[M6.4] Add release CI and the backend MVP acceptance run](https://github.com/junepark678/atproto_music/issues/30)

- **[[M6.4.1] Create versioned static release pipeline with checksums](https://github.com/junepark678/atproto_music/issues/107)** — .github/workflows/release.yml; docs/releases.md
- **[[M6.4.2] Run packaged backend fault/recovery acceptance](https://github.com/junepark678/atproto_music/issues/108)** — scripts/acceptance/backend.*; docs/verification/backend.md
- **[[M6.4.3] Record live backend MVP gate and operational limits](https://github.com/junepark678/atproto_music/issues/109)** — docs/verification/backend-live.md; docs/deployment.md

### M7: Preact SPA and integrated product MVP — lower priority

Implement the browser experience after the backend acceptance gate, using the frozen API contracts and embedded release assets.

Completion gate: A browser user can sign in, submit a scrobble, browse feeds/profiles/history/stats, follow/unfollow, delete their scrobble, export data, and sign out on the packaged binary.

#### [[M7.1] Scaffold the Preact SPA and contract-driven API client](https://github.com/junepark678/atproto_music/issues/32)

- **[[M7.1.1] Scaffold Preact/TypeScript/Vite only after backend gate](https://github.com/junepark678/atproto_music/issues/110)** — web/package.json; web/package-lock.json; web/tsconfig.json; web/vite.config.ts
- **[[M7.1.2] Generate typed API client and session/CSRF state](https://github.com/junepark678/atproto_music/issues/111)** — web/src/api/; web/src/session.ts
- **[[M7.1.3] Implement accessible route shell and state primitives](https://github.com/junepark678/atproto_music/issues/112)** — web/src/app.tsx; web/src/routes/; web/src/components/

#### [[M7.2] Implement sign-in, scrobble submission, and owner controls](https://github.com/junepark678/atproto_music/issues/33)

- **[[M7.2.1] Implement handle sign-in and secure sign-out screens](https://github.com/junepark678/atproto_music/issues/113)** — web/src/routes/signin.tsx; web/src/components/session_controls.tsx
- **[[M7.2.2] Implement manual scrobble form and publication states](https://github.com/junepark678/atproto_music/issues/114)** — web/src/routes/scrobble.tsx; web/src/components/operation_status.tsx
- **[[M7.2.3] Implement owner delete, export, and local disconnect UI](https://github.com/junepark678/atproto_music/issues/115)** — web/src/routes/settings.tsx; web/src/components/delete_scrobble.tsx

#### [[M7.3] Implement feeds, profiles, history, statistics, and follows](https://github.com/junepark678/atproto_music/issues/34)

- **[[M7.3.1] Render global/following feeds with cursor pagination](https://github.com/junepark678/atproto_music/issues/116)** — web/src/routes/feed.tsx; web/src/components/scrobble_list.tsx
- **[[M7.3.2] Render profiles, history, and time-window statistics](https://github.com/junepark678/atproto_music/issues/117)** — web/src/routes/profile.tsx; web/src/components/stats.tsx
- **[[M7.3.3] Implement follow/unfollow controls and index refresh](https://github.com/junepark678/atproto_music/issues/118)** — web/src/components/follow_button.tsx; web/src/routes/profile.tsx

#### [[M7.4] Embed production SPA assets and run the complete MVP journey](https://github.com/junepark678/atproto_music/issues/35)

- **[[M7.4.1] Build and embed production SPA in release executable](https://github.com/junepark678/atproto_music/issues/119)** — .github/workflows/release.yml; crates/server/build.rs; web/dist/
- **[[M7.4.2] Run complete browser journey against packaged executable](https://github.com/junepark678/atproto_music/issues/120)** — web/tests/mvp.spec.ts; playwright.config.ts; scripts/acceptance/browser.*
- **[[M7.4.3] Run accessibility and live product release gate](https://github.com/junepark678/atproto_music/issues/121)** — web/tests/accessibility.spec.ts; docs/verification/product-live.md


Full scope and named test matrices: [github-plan.json](github-plan.json).
