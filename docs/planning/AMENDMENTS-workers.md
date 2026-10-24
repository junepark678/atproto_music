# Issue amendments for the Workers-only rebuild (ADR 0004)

Status: **draft, not published.** W0-02 drafted these texts from [ADR 0004 §9](../adr/0004-cloudflare-workers.md#9-amended-mvp--api--adr-rules), as MVP.md "Completion and execution rules" requires: a library or rule change needs an issue amendment that explains the demonstrated gap. Publishing them to the GitHub issues is an owner action; nothing here claims an issue was edited or closed.

Each section below is the amendment text for one `github-plan.json` leaf key. It names the amendment ids, the demonstrated gap, the amended requirement, and the disposition of the leaf's three named cases. The dispositions come from [`docs/verification/ts-case-map.json`](../verification/ts-case-map.json), which `scripts/validate_case_map.py` checks against this file: every `retired:<id>` case must have its id on its leaf's **Amendment ids** line, and every test id a case references must be declared in `workers-waves.json` or listed under [Required wave amendments](#required-wave-amendments).

Amendment ids: A1–A20 are ADR 0004 §9.2, N1–N4 are §9.4, and D is the §9.3 dropped list.

## Amendment applying to every leaf: implementation location

**Amendment ids:** A1, A4, A18

**Demonstrated gap:** tokio, sqlx and a bound TCP listener do not run on Cloudflare Workers; the single SQLite Durable Object is the only Workers store with synchronous transactions (`transactionSync`), and D1 rejects `BEGIN`/`SAVEPOINT` (ADR 0004 §1.2). The Rust crates cannot run on Workers, and `@atproto/repo`, `@atproto/identity` and `oauth-client-node` are Node-bound (pino, Node streams, undici); ADR 0004 §4.5 pins the replacements.

**Amendment text:** The "File ownership" paths that name `crates/*` now name the TypeScript files listed for the corresponding package in [`docs/planning/workers-waves.json`](workers-waves.json). The Rust crates stay frozen as the golden-vector oracle (Q6). The test execution contract becomes: implement executable tests in the owning workspace package (`packages/*/test`, `worker/test`, `web/test`, `web/tests`), run them with `npm test` or `npm run test:e2e`, then `bash scripts/check-ts.sh`. Every other part of each issue body, including "do not weaken verification" and "report passed, failed, skipped and blocked separately", is unchanged.

## Leaf amendments

### M1.1.1 Gate production namespace and freeze schema version

**Amendment ids:** A10

**Demonstrated gap:** (A10) A server-side disconnect needs an authenticated owner request; with no session (A3) the owner proves intent with a repo-signed `<prefix>.settings/self` record (ADR 0004 F10, §5.3).

**Amendment text:** Collections derived from a valid owned prefix are exactly `<prefix>.scrobble`, `<prefix>.follow` and `<prefix>.settings`. Schema version 1 and the fixture-only rule for `com.example.atmusic` are unchanged. Implementation: `packages/core/src/namespace.ts` (W1-01) and `worker/src/config.ts` (W0-01).

| Case | Disposition |
| --- | --- |
| `fixture_namespace` | `packages/core/test/namespace.test.ts › fixture prefix blocks publication; owned prefix with ownership ref allows it` |
| `invalid_namespace` | `worker/test/config.test.ts › one-segment, uppercase and embedded-slash LEXICON_PREFIX values are rejected naming LEXICON_PREFIX; empty yields prefix null` (required wave amendment, W0-01); also `packages/core/test/syntax.test.ts › DID/handle/NSID/AT-URI/TID accept and reject spec vectors` |
| `version_policy` | `worker/test/ingest/jetstream-socket.test.ts › subscribe URL has kinds=commit and the three collections only` (A10 adds `<prefix>.settings`, so a valid prefix derives exactly the scrobble, follow and settings collections.) |

### M1.1.4 Freeze OpenAPI v1 schemas and endpoint status matrices

**Amendment ids:** A3, A8, A9, A10, N1, N2, N3, D

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB. (A8) There is no server session to identify the viewer (A3); follow records are already public (Q7). (A9) Owner-only export needs a server session, which no longer exists (A3); the exported records are all public. (A10) A server-side disconnect needs an authenticated owner request; with no session (A3) the owner proves intent with a repo-signed `<prefix>.settings/self` record (ADR 0004 F10, §5.3). (N1) Without server writes the AppView needs an untrusted, rate-limited way to learn about a new record promptly (ADR 0004 §5.2 step 4). (N2) The SPA needs to see when its record is indexed or excluded, which the dropped operation status used to report. (N3) A9 moves export to a public per-DID route. (D) ADR 0004 §9.3 drops the server auth, write, operation and account routes with the session, CSRF and Origin rules and the private-access matrix, because under Q1 (browser public client) the Worker has no session and no write path; the §15 BFF fallback would restore the nine routes, sessions and CSRF.

**Amendment text:** `api/openapi.yaml` moves to `info.version` 1.1.0. The auth, server write, operation and account routes are removed with the `Accepted`, `Operation` and `Session` schemas. `POST /api/v1/notify`, `GET /api/v1/records/status` and `GET /api/v1/users/{did}/export` are added. `GET /api/v1/feed` takes `viewer`. `/oauth/client-metadata.json` is a static asset with `application_type: "web"` and the `/oauth/callback` redirect. Every remaining route is public; `required_auth` becomes the check that no route declares a security requirement, and `scripts/validate_contracts.py` still rejects the dropped paths.

| Case | Disposition |
| --- | --- |
| `route_inventory` | `python3 scripts/validate_contracts.py › route_inventory: exact MVP/API route and status matrices` (required wave amendment, W0-02); also `python3 scripts/validate_contracts.py › dropped paths (/api/v1/auth/*, POST /api/v1/scrobbles, /api/v1/operations/{id}, /api/v1/account/*) are absent` |
| `response_examples` | `python3 scripts/validate_contracts.py › all api/examples validate against openapi 1.1.0 components` |
| `required_auth` | `retired:D`: Session cookies, CSRF, Origin rules and the private-access matrix are dropped (ADR 0004 §9.3); every v1.1 route is public and validate_contracts.py asserts that no route declares a security requirement. |

### M1.2.1 Pin the Rust workspace, dependencies, and crate boundaries

**Amendment ids:** A4

**Demonstrated gap:** (A4) The Rust crates cannot run on Workers, and `@atproto/repo`, `@atproto/identity` and `oauth-client-node` are Node-bound (pino, Node streams, undici); ADR 0004 §4.5 pins the replacements.

**Amendment text:** The locked-build, layering and TLS/SQLite feature checks apply to the frozen Rust oracle only. The TypeScript workspace pins every dependency exactly, W0-01 alone regenerates `package-lock.json`, and `@atmusic/core` has no I/O dependency.

| Case | Disposition |
| --- | --- |
| `locked_build` | `retired:A4`: The Rust workspace is a frozen oracle; the TypeScript workspace pins every dependency exactly and only W0-01 regenerates package-lock.json (ADR 0004 §4.5); CI runs npm ci. |
| `dependency_direction` | `retired:A4`: Crate layering is replaced by npm workspaces with no barrel files (ADR 0004 §4.3); @atmusic/core is pure and has no I/O dependency. |
| `sqlite_tls_features` | `retired:A4`: sqlx, reqwest/rustls and OpenSSL do not exist on Workers; storage is DO SQLite and TLS is Workers fetch. |

### M1.2.2 Wire formatting, lint, and meaningful-test CI

**Amendment ids:** A18

**Demonstrated gap:** (A18) Workers tests run in workerd through `@cloudflare/vitest-plugin`; there is no process, port or `LD_PRELOAD` to control, and restart is DO eviction.

**Amendment text:** The CI gate is `npm ci` and `bash scripts/check-ts.sh` (typecheck, biome lint, vitest through `scripts/report-tests.ts`, contract and case-map validators, bundle guard). A zero-test run fails. The Rust `check` job stays for the oracle until W7-02. The disposable-copy negative controls are kept: a misformatted file fails the biome step and an inverted assertion fails the gate, each without changing the repository.

| Case | Disposition |
| --- | --- |
| `ci_green` | `bash scripts/acceptance/workers-backend.sh › exits 0 with all deterministic suites passing and lists live gates as blocked when prerequisites absent` |
| `ci_format_failure` | `scripts/test/check-ts.test.ts › a misformatted file in a disposable copy fails the biome step and leaves the repository unchanged` (required wave amendment, W0-01) (A18: formatting is the biome step of scripts/check-ts.sh; rustfmt applies only to the frozen oracle.) |
| `ci_assertion_failure` | `scripts/test/check-ts.test.ts › an inverted assertion in a disposable copy makes check-ts.sh exit nonzero` (required wave amendment, W0-01) |

### M1.2.3 Build and smoke-test a self-contained musl artifact

**Amendment ids:** A19, D

**Demonstrated gap:** (A19) A Worker has no executable artifact; a release is a Worker version id and the bundle SHA-256. (D) ADR 0004 §9.3 drops the musl artifact and its smoke tests because the Workers runtime runs no process of ours: there is no ELF to link statically, no port to probe from a child process and no SIGTERM to deliver; `wrangler versions upload` ships a bundled script instead. The drop follows from the runtime, not from Q1, so the §15 BFF fallback would not restore it.

**Amendment text:** Superseded. The musl artifact and its smoke test are dropped. Release evidence is the Worker version id and bundle SHA-256; HTTP liveness, readiness and the unknown-API 404 are covered by the composition routing tests.

| Case | Disposition |
| --- | --- |
| `static_elf` | `retired:A19`: No musl executable exists; a release is a Worker version id plus a bundle SHA-256 (wrangler versions upload). |
| `packaged_http` | `worker/test/composition/routing.test.ts › every API.md v1.1 route dispatches; unknown /api/x → JSON 404; non-API path → ASSETS`; also `worker/test/http/health-meta.test.ts › live 200; ready 503 when index reports too_new; meta capabilities omit publication without owned prefix` (The musl smoke harness is dropped (ADR 0004 §9.3); live, ready, root asset and unknown-API behaviour are asserted on the Worker.) |
| `packaged_shutdown` | `retired:D`: The SIGTERM drain is dropped (ADR 0004 §9.3): Workers have no shutdown hook and every DO step is durable before it acknowledges. |

### M1.3.1 Define SQLite schema and invariant constraints

**Amendment ids:** A1, A11, A12

**Demonstrated gap:** (A1) tokio, sqlx and a bound TCP listener do not run on Cloudflare Workers; the single SQLite Durable Object is the only Workers store with synchronous transactions (`transactionSync`), and D1 rejects `BEGIN`/`SAVEPOINT` (ADR 0004 §1.2). (A11) The server no longer receives writes (A2), so it cannot hold an `Idempotency-Key` table; the PDS rejects a reused rkey, which preserves "same key, changed payload" detection. (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers.

**Amendment text:** The schema is the DO SQLite migration 1 of ADR 0004 §6. The `operations`, `outbox`, `idempotency` and `operation_dependencies` tables are dropped, so the idempotency-scope case is retired and foreign-key enforcement is asserted on `scrobbles.did` and `follows.actor`.

| Case | Disposition |
| --- | --- |
| `unique_record` | `worker/test/storage/sql-conformance.test.ts › second plain INSERT of one scrobbles.uri fails with a constraint error and the row count stays one` (required wave amendment, W0-01) |
| `idempotency_scope` | `retired:A11`: The server Idempotency-Key table is dropped; the SPA allocates a TID rkey once and uses PDS existence plus a digest comparison. |
| `foreign_key` | `worker/test/storage/sql-conformance.test.ts › INSERT of a scrobble or follow whose users row is missing is rejected and leaves no row` (required wave amendment, W0-01); also `worker/test/storage/sql-conformance.test.ts › FK ON DELETE CASCADE is enforced for scrobbles.did and follows.actor` (Private operations no longer exist (A12); the owner foreign key is on scrobbles.did and follows.actor.) |

### M1.3.2 Implement embedded forward migrations and database open

**Amendment ids:** A1

**Demonstrated gap:** (A1) tokio, sqlx and a bound TCP listener do not run on Cloudflare Workers; the single SQLite Durable Object is the only Workers store with synchronous transactions (`transactionSync`), and D1 rejects `BEGIN`/`SAVEPOINT` (ADR 0004 §1.2).

**Amendment text:** Migrations are an ordered array in `worker/src/do/schema.ts`, applied in the DO constructor under `blockConcurrencyWhile` inside one `transactionSync` and recorded in `schema_migrations`. A schema newer than the code reports `too_new` and `/health/ready` returns 503.

| Case | Disposition |
| --- | --- |
| `fresh_and_reopen` | `worker/test/storage/migrate.test.ts › re-running migrate is a no-op` |
| `migration_rollback` | `worker/test/storage/migrate.test.ts › a migration whose second statement is invalid persists neither statement and keeps the previous schema version` (required wave amendment, W0-01); also `worker/test/storage/db.test.ts › tx rolls back all writes when the callback throws` |
| `future_schema` | `worker/test/storage/migrate.test.ts › schema newer than code reports too_new` |

### M1.3.3 Implement typed repository operations and transactions

**Amendment ids:** A1, A12

**Demonstrated gap:** (A1) tokio, sqlx and a bound TCP listener do not run on Cloudflare Workers; the single SQLite Durable Object is the only Workers store with synchronous transactions (`transactionSync`), and D1 rejects `BEGIN`/`SAVEPOINT` (ADR 0004 §1.2). (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers.

**Amendment text:** Repository operations are DO module functions over `Db.tx`; no read-check-write may span an `await`. Owner-private operation reads are retired because operations live in the SPA outbox.

| Case | Disposition |
| --- | --- |
| `event_atomicity` | `worker/test/ingest/hints.test.ts › enqueue and checkpoint advance commit atomically (throw rolls back both)` |
| `owner_private_read` | `retired:A12`: Operations live in the SPA IndexedDB outbox; the server has no private operation rows to read. |
| `record_revision` | `worker/test/write/apply-record.test.ts › applying the same revision twice changes nothing and a newer revision replaces the payload with one listen` (required wave amendment, W2-04); also `worker/test/write/apply-record.test.ts › r03 artist change updates keys without inserting a second listen` |

### M1.3.4 Serialize writes and bound database contention

**Amendment ids:** A1

**Demonstrated gap:** (A1) tokio, sqlx and a bound TCP listener do not run on Cloudflare Workers; the single SQLite Durable Object is the only Workers store with synchronous transactions (`transactionSync`), and D1 rejects `BEGIN`/`SAVEPOINT` (ADR 0004 §1.2).

**Amendment text:** The single DO serialises every transition through synchronous `transactionSync`, so the writer queue and the SQLite lock wait are replaced. The bounded resource is admission: 1,024 pending snapshot jobs, then 503 `queue_full`.

| Case | Disposition |
| --- | --- |
| `concurrent_writes` | `worker/test/ingest/verify-drain.test.ts › 100 hints for distinct URIs from interleaved alarm and RPC calls yield exactly 100 rows` (required wave amendment, W3-04); also `worker/test/ingest/verify-drain.test.ts › two concurrent proofs for one URI arriving out of order end with newest revision` (A1: every write is a synchronous transactionSync call in the single DO.) |
| `queue_full` | `worker/test/ingest/admission.test.ts › 1,024 pending jobs → next admission busy and writes nothing`; also `worker/test/ingest/notify.test.ts › did notify for unknown DID admits snapshot; busy → 503 queue_full` (A1: the bounded writer queue becomes bounded admission (1,024 jobs) in the single DO.) |
| `locked_database` | `retired:A1`: DO SQLite has no external file lock and transactionSync is synchronous; there is no storage_busy wait to bound. |

### M1.4.1 Implement typed environment configuration and migrate CLI

**Amendment ids:** A1

**Demonstrated gap:** (A1) A Worker binds no address or port and has no command-line entry point: configuration arrives as Worker vars and secrets in `env`, and the single SQLite Durable Object migrates itself in its constructor, so there is no listener precedence to resolve and no separate migrate command to run (ADR 0004 §1.2, §6).

**Amendment text:** Configuration is Worker vars and secrets parsed by `parseConfig(env)` (W0-01) and refused by `scripts/deploy.sh --dry-run` (W6-04). There is no listener, port or migrate CLI; `migrate_only` becomes the DO constructor migration, which is current on first run and a no-op on rerun.

| Case | Disposition |
| --- | --- |
| `bind_precedence` | `retired:A1`: A Worker binds no address or port. |
| `migrate_only` | `worker/test/storage/migrate.test.ts › re-running migrate is a no-op`; also `worker/test/storage/migrate.test.ts › fresh DO applies migration 1 and seeds indexing_status/backfill_generation/ingest_checkpoint` (A1: there is no CLI or listener; the DO constructor runs migrate under blockConcurrencyWhile.) |
| `invalid_config` | `worker/test/config.test.ts › http PUBLIC_ORIGIN and invalid LEXICON_PREFIX fail parseConfig naming each field without echoing any secret value` (required wave amendment, W0-01); also `bash scripts/deploy.sh --dry-run › refuses empty/fixture prefix and missing secret with nonzero exit`, `packages/core/test/cursor.test.ts › key shorter than 32 bytes is rejected` |

### M1.4.2 Implement health, metadata, and uniform HTTP errors

**Amendment ids:** A1

**Demonstrated gap:** (A1) The embedded SQLite pool opened at process start is replaced by the single SQLite Durable Object, so readiness is the DO schema state reported over RPC (`too_new` gives 503) rather than a database open; with Jetstream as the upstream, an outage is the socket disconnect time reported through `Indexing`.

**Amendment text:** Health and the error envelope are unchanged in shape. Readiness reports 503 when the DO schema is `too_new`; upstream degradation is reported through `Indexing` (`stale` when the socket has been disconnected for more than 5 minutes).

| Case | Disposition |
| --- | --- |
| `ready_before_storage` | `worker/test/http/health-meta.test.ts › live 200; ready 503 when index reports too_new; meta capabilities omit publication without owned prefix` |
| `upstream_outage` | `worker/test/http/health-meta.test.ts › ready 200 and meta indexing stale while the index reports the socket disconnected` (required wave amendment, W1-07); also `worker/test/storage/status.test.ts › socket disconnected >5min reports stale` |
| `safe_errors` | `worker/test/http/error.test.ts › envelope matches openapi Error schema with requestId UUID`; also `worker/test/composition/routing.test.ts › forced storage error → 500 envelope with UUID requestId and no stack trace or file path` (required wave amendment, W5-01), `worker/test/composition/routing.test.ts › every API.md v1.1 route dispatches; unknown /api/x → JSON 404; non-API path → ASSETS` |

### M1.4.3 Add server harness and bounded shutdown

**Amendment ids:** A18, D

**Demonstrated gap:** (A18) Workers tests run in workerd through `@cloudflare/vitest-plugin`; there is no process, port or `LD_PRELOAD` to control, and restart is DO eviction. (D) ADR 0004 §9.3 drops the SIGTERM drain because neither a Worker nor a Durable Object receives a signal or has a shutdown hook, and every DO step is durable before it acknowledges, so there is no in-flight work to drain. The drop follows from the runtime, not from Q1, so the §15 BFF fallback would not restore it.

**Amendment text:** Superseded. The server harness becomes isolated workerd storage per test file and a unique DO name per test, and isolation stays a tested property: rows written under one DO name never appear under another. The SIGTERM drain is dropped. Durability across restart is asserted by DO eviction tests.

| Case | Disposition |
| --- | --- |
| `harness_isolation` | `worker/test/harness › rows written under one DO name are absent under another DO name and in another test file` (required wave amendment, W0-01) (A18: isolated workerd storage per test file and a unique DO name per test replace the port-0 harness.) |
| `drain_success` | `worker/test/composition/index-do.test.ts › restart (eviction) preserves state and resumes alarm` (The SIGTERM drain is dropped (ADR 0004 §9.3); durability across restart is DO eviction (A18).) |
| `drain_timeout` | `retired:D`: The SIGTERM drain is dropped (ADR 0004 §9.3); there is no process to drain. |

### M2.1.1 Resolve handles and validate DID identity

**Amendment ids:** A4

**Demonstrated gap:** (A4) The Rust crates cannot run on Workers, and `@atproto/repo`, `@atproto/identity` and `oauth-client-node` are Node-bound (pino, Node streams, undici); ADR 0004 §4.5 pins the replacements.

**Amendment text:** Identity resolution is `@atmusic/atproto/identity` over `@atcute/identity-resolver` with an `identity_cache` TTL of 5 minutes and a 1-hour negative TTL. The round-trip and spoofed-handle rules are unchanged.

| Case | Disposition |
| --- | --- |
| `round_trip` | `worker/test/read/resolve.test.ts › verified handle 200; unresolved 404; mismatch 422` |
| `spoofed_handle` | `packages/atproto/test/identity.test.ts › handle verified only when TXT/well-known and alsoKnownAs agree; mismatch yields null` |
| `cache_expiry` | `worker/test/ingest/identity-cache.test.ts › cached identity served at 299 s and refreshed at 301 s with the injected clock` (required wave amendment, W3-04); also `packages/atproto/test/identity.test.ts › fresh:true bypasses cache after key rotation` (identity_cache TTL is 5 min (ADR 0004 §5.4).) |

### M2.1.2 Harden all metadata/PDS fetch destinations

**Amendment ids:** A5

**Demonstrated gap:** (A5) Workers `fetch` resolves DNS itself, so the pinned-address client of ADR 0002 cannot be built (ADR 0004 §8, §13.1).

**Amendment text:** DNS pinning becomes the SafeFetch host policy plus a DoH A/AAAA pre-check that rejects private, loopback, link-local, CGNAT, ULA, multicast and reserved answers; `redirect: "manual"` with every 3xx an error; a 10 s deadline; streamed body caps. The DNS-rebinding TOCTOU residual is documented and probed live (W6-05).

| Case | Disposition |
| --- | --- |
| `ssrf_destinations` | `packages/atproto/test/url-policy.test.ts › rejects http, non-default port, credentials, fragment, IP literals (v4/v6/mapped/decimal), localhost, .internal, single label` |
| `redirect_rebinding` | `packages/atproto/test/safe-fetch.test.ts › 3xx response is refused and Location is not followed`; also `packages/atproto/test/doh.test.ts › mixed public+private answer set is rejected` (DNS pinning is impossible on Workers (A5); the rebinding TOCTOU residual is probed live (W6-05).) |
| `fetch_bounds` | `packages/atproto/test/safe-fetch.test.ts › body over cap aborts with body_too_large and does not buffer the rest`; also `packages/atproto/test/safe-fetch.test.ts › 10s deadline yields timeout`, `packages/atproto/test/safe-fetch.test.ts › 3xx response is refused and Location is not followed` (Any 3xx is an error (A5), so the four-redirect input becomes the 3xx refusal.) |

### M2.1.3 Discover PDS and OAuth issuer metadata

**Amendment ids:** A3

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB.

**Amendment text:** PDS discovery from the DID document stays in `@atmusic/atproto/identity`. Authorization-server metadata, PAR/PKCE support and the issuer check are performed by the browser OAuth library; the server never initiates OAuth.

| Case | Disposition |
| --- | --- |
| `valid_chain` | `packages/atproto/test/identity.test.ts › plc and did:web documents resolve signing key and PDS` |
| `issuer_mismatch` | `retired:A3`: Authorization-server discovery and the issuer check are performed by @atproto/oauth-client-browser in the browser; the live OAuth gate (W6-05) covers interoperability. |
| `unsupported_server` | `retired:A3`: PAR/PKCE S256 capability checks are performed by @atproto/oauth-client-browser; the server never initiates OAuth. |

### M2.2.1 Choose maintained OAuth dependencies and serve client metadata

**Amendment ids:** A3, A10

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB. (A10) A server-side disconnect needs an authenticated owner request; with no session (A3) the owner proves intent with a repo-signed `<prefix>.settings/self` record (ADR 0004 F10, §5.3).

**Amendment text:** `/oauth/client-metadata.json` is a build-time static asset at the same path, generated by `scripts/gen-config.ts` with `application_type: "web"`, `token_endpoint_auth_method: "none"`, `dpop_bound_access_tokens: true` and `redirect_uris: ["https://<host>/oauth/callback"]`. The scope is `atproto repo:<p>.scrobble repo:<p>.follow repo:<p>.settings`.

| Case | Disposition |
| --- | --- |
| `metadata_origin` | `scripts/test/gen-config.test.ts › production metadata equals expected JSON for https://music.example.org with prefix org.example.music` |
| `metadata_contract` | `scripts/test/gen-config.test.ts › production metadata equals expected JSON for https://music.example.org with prefix org.example.music` (Metadata is a build-time static asset (A3); validate_contracts.py also fixes application_type web and the /oauth/callback redirect.) |
| `scope_inventory` | `web/test/oauth/session.test.ts › signIn requests scope 'atproto repo:<p>.scrobble repo:<p>.follow repo:<p>.settings'` |

### M2.2.2 Implement auth start, PKCE, state, and PAR

**Amendment ids:** A3, D

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB. (D) ADR 0004 §9.3 drops `POST /api/v1/auth/start` and its Origin check because under Q1 the authorization request starts in the browser; the §15 BFF fallback would restore the route.

**Amendment text:** `POST /api/v1/auth/start` is dropped. PAR and PKCE S256 are performed by `@atproto/oauth-client-browser`; no verifier or key reaches the server.

| Case | Disposition |
| --- | --- |
| `par_pkce` | `retired:A3`: PAR and PKCE are performed by @atproto/oauth-client-browser; no verifier or key reaches the server. |
| `wrong_origin` | `retired:D`: POST /api/v1/auth/start is dropped (ADR 0004 §9.3). |
| `par_failure` | `retired:A3`: PAR failure handling belongs to the browser library; the server stores no OAuth state to clean up. |

### M2.2.3 Implement callback verification and DPoP nonce retry

**Amendment ids:** A3, D

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB. (D) ADR 0004 §9.3 drops `GET /api/v1/auth/callback` and the 300 s server OAuth state because under Q1 the code exchange completes in the browser at `/oauth/callback`; the §15 BFF fallback would restore the callback route and its state.

**Amendment text:** `GET /api/v1/auth/callback` and server OAuth state are dropped. `/oauth/callback` is an SPA route served through the asset fallback; the library completes the exchange, the issuer check and DPoP nonce retries.

| Case | Disposition |
| --- | --- |
| `expired_and_replay` | `retired:D`: Server OAuth state (300 s) and GET /api/v1/auth/callback are dropped (ADR 0004 §9.3). |
| `issuer_subject` | `retired:A3`: Issuer and subject binding are enforced by @atproto/oauth-client-browser; the server creates no session. |
| `nonce_retry` | `retired:A3`: DPoP nonce retry is performed by @atproto/oauth-client-browser. |

### M2.3.1 Encrypt OAuth material and serialize token refresh

**Amendment ids:** A3, D

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB. (D) ADR 0004 §9.3 drops encrypted server token storage and the operator encryption key because under Q1 no token reaches the Worker; the §15 BFF fallback would restore both (it adds `ENCRYPTION_KEY`).

**Amendment text:** Encrypted server token storage and the operator encryption key are dropped. Tokens and the non-extractable DPoP key live in the browser; the library serialises refresh across tabs with Web Locks. A failed refresh surfaces the re-auth state.

| Case | Disposition |
| --- | --- |
| `encrypted_persistence` | `retired:D`: Encrypted server token storage and the operator encryption key are dropped (ADR 0004 §9.3); no token reaches the server. |
| `refresh_race` | `retired:A3`: Refresh is serialised across tabs with Web Locks inside @atproto/oauth-client-browser. |
| `refresh_restart` | `web/test/oauth/session.test.ts › expired/refresh-failed session surfaces re-auth state` |

### M2.3.2 Issue hashed sessions and enforce CSRF

**Amendment ids:** A3, D

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB. (D) ADR 0004 §9.3 drops application session cookies, the CSRF token and the Origin rules because under Q1 the Worker has no session and no mutation route; the §15 BFF fallback would restore sessions and CSRF.

**Amendment text:** Application sessions, cookies and CSRF are dropped. Sessions follow library and spec limits (at most 14 days for public clients) instead of the 7-day cookie; the SPA shows the expiry and re-prompts.

| Case | Disposition |
| --- | --- |
| `cookie_and_hash` | `retired:D`: Application session cookies are dropped (ADR 0004 §9.3). |
| `session_expiry` | `web/test/oauth/session.test.ts › expired/refresh-failed session surfaces re-auth state` (A3: sessions follow library and spec limits (at most 14 days for public clients) instead of the 7-day app cookie.) |
| `csrf_matrix` | `retired:D`: CSRF and Origin rules are dropped with the server mutation routes (ADR 0004 §9.3). |

### M2.3.3 Implement logout and upstream revocation behavior

**Amendment ids:** A3

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB.

**Amendment text:** Sign-out calls `session.signOut()`, which revokes upstream, and clears IndexedDB whether or not revocation succeeds. The revocation endpoint is chosen by the library from authorization-server metadata.

| Case | Disposition |
| --- | --- |
| `logout_local` | `web/test/oauth/session.test.ts › signOut calls revoke and clears IndexedDB stores` |
| `revocation_outage` | `web/test/oauth/session.test.ts › signOut clears IndexedDB stores when revoke fails with 500` (required wave amendment, W2-06); also `web/test/oauth/session.test.ts › signOut calls revoke and clears IndexedDB stores` |
| `unsupported_revocation` | `retired:A3`: The revocation endpoint is chosen from authorization-server metadata by @atproto/oauth-client-browser. |

### M2.4.1 Build deterministic OAuth/PDS fixture servers

**Amendment ids:** A3, A18

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB. (A18) Workers tests run in workerd through `@cloudflare/vitest-plugin`; there is no process, port or `LD_PRELOAD` to control, and restart is DO eviction.

**Amendment text:** The fixture kit (W1-05) builds real signed repositories for two curves and fake PDS, PLC, DoH, relay and Jetstream endpoints behind the injected `Transport`. OAuth fault modes belong to the browser library. The production bundle guard proves no test seam ships.

| Case | Disposition |
| --- | --- |
| `fixture_isolation` | `packages/atproto/test/fixture-kit.test.ts › a record signed by one fixture account fails verification under another account's key` (required wave amendment, W1-05) (Token isolation is retired with server OAuth (A3).) |
| `fault_controls` | `packages/atproto/test/fixture-kit.test.ts › fake PDS createRecord with existing rkey returns RecordAlreadyExists; deleteRecord with stale swap returns InvalidSwap` (Nonce, wrong-issuer and refresh-rotation modes belong to the browser OAuth library (A3).) |
| `no_prod_bypass` | `scripts/test/check-bundle.test.ts › fails when a test-support import is injected into a temp copy of the entry`; also `npx tsx scripts/check-bundle.ts › production bundle passes guard` |

### M2.4.2 Add OAuth/session negative integration matrix

**Amendment ids:** A3, D

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB. (D) ADR 0004 §9.3 drops the server OAuth state, callback, sessions, cookies and the private-access 401/403/404 matrix that this negative matrix exercised, because under Q1 none of them exists on the Worker; the §15 BFF fallback would restore them.

**Amendment text:** The server OAuth/session negative matrix is retired with the routes it exercised. Token rotation and persistence belong to `@atproto/oauth-client-browser`, and live OAuth interoperability is a W6-05 gate.

| Case | Disposition |
| --- | --- |
| `security_matrix` | `retired:D`: Server OAuth state, callback and sessions are dropped (ADR 0004 §9.3). |
| `refresh_persistence` | `retired:A3`: Token rotation and persistence are owned by @atproto/oauth-client-browser in IndexedDB. |
| `cross_owner` | `retired:D`: Cookies and private operations are dropped (ADR 0004 §9.3); writes go to the owner's own PDS. |

### M2.4.3 Run and record live external-PDS OAuth interoperability

**Amendment ids:** A3, A19

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB. (A19) A Worker has no executable artifact; a release is a Worker version id and the bundle SHA-256.

**Amendment text:** The live OAuth gate signs in through the browser public client on two independent PDSs and records evidence per Worker version id (W6-05). Missing prerequisites report blocked with a nonzero exit.

| Case | Disposition |
| --- | --- |
| `live_round_trip` | `npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names` (Live OAuth sign-in on two PDSs is a W6-05 live gate; without its prerequisites the gate reports blocked.) |
| `live_disposable_record` | `npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names` (Live create/get/delete evidence is recorded per Worker version id (W6-05).) |
| `live_credentials_missing` | `npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names` |

### M3.1.1 Implement authenticated scrobble input and idempotency admission

**Amendment ids:** A2, A11, A12

**Demonstrated gap:** (A2) Under Q1 (ADR 0004 §15) the browser SPA writes directly to the user's PDS through the atproto OAuth session; the server holds no credential to write with. (A11) The server no longer receives writes (A2), so it cannot hold an `Idempotency-Key` table; the PDS rejects a reused rkey, which preserves "same key, changed payload" detection. (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers.

**Amendment text:** `POST /api/v1/scrobbles` and the `Idempotency-Key` header are dropped. The SPA validates with `@atmusic/core/scrobble`, allocates the TID rkey once, persists the operation and digest in IndexedDB before the first attempt, and treats a reused rkey with a different digest as the terminal `remote_record_conflict`. Ownership is the authenticated PDS repository.

| Case | Disposition |
| --- | --- |
| `key_validation` | `retired:A11`: The Idempotency-Key header and its 400 invalid_idempotency_key are dropped with POST /api/v1/scrobbles. |
| `retry_collision` | `web/test/outbox/recovery.test.ts › remote record with different payload at rkey → remote_record_conflict, never overwritten`; also `web/test/outbox/recovery.test.ts › crash after PDS commit before local ack: ambiguous create reconciles to success via digest` (A11: a changed payload at the same rkey is the client-side terminal remote_record_conflict instead of 409.) |
| `owner_and_validation` | `web/test/routes/scrobble.test.tsx › invalid input shows field errors and creates no outbox operation`; also `packages/core/test/scrobble.test.ts › buildScrobbleRecord rejects unknown input fields` (The owner is the authenticated PDS repository (A2).) |

### M3.2.1 Persist outbox state and expose owner-bound operation status

**Amendment ids:** A12, N2

**Demonstrated gap:** (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers. (N2) The SPA needs to see when its record is indexed or excluded, which the dropped operation status used to report.

**Amendment text:** Operation persistence moves to the SPA outbox (`web/src/outbox/store.ts`). `GET /api/v1/operations/{id}` is replaced for public indexing status by `GET /api/v1/records/status`.

| Case | Disposition |
| --- | --- |
| `admission_atomic` | `retired:A12`: The server operation/outbox rows are dropped; the SPA persists one IndexedDB operation before the first attempt. |
| `status_contract` | `worker/test/http/record-status.test.ts › states indexed/pending/absent/excluded/unknown with cid and revision` (GET /api/v1/operations/{id} is dropped; public indexing status is GET /api/v1/records/status (N2).) |
| `rkey_persistence` | `web/test/outbox/recovery.test.ts › crash before send: operation resumes with same rkey` |

### M3.2.2 Execute bounded retry and DPoP-authorized PDS writes

**Amendment ids:** A12

**Demonstrated gap:** (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers.

**Amendment text:** The retry formula `min(300 s, base + U[0, base/4])`, the capped `Retry-After` raise and exactly 10 attempts are unchanged in the SPA runner (`web/src/outbox`). Retries run only while a tab is open.

| Case | Disposition |
| --- | --- |
| `transient_schedule` | `web/test/outbox/retry.test.ts › Retry-After 20 raises next delay to 20s` |
| `terminal_attempt` | `web/test/outbox/retry.test.ts › zero jitter delays 1,2,4,…,256,300 and exactly 10 attempts with no 11th request` |
| `permanent_error` | `web/test/outbox/retry.test.ts › nonrecoverable PDS error fails the operation after exactly one request` (required wave amendment, W2-07); also `packages/core/test/write-policy.test.ts › classify maps 429/5xx/network to transient and RecordAlreadyExists to ambiguous_create` |

### M3.2.3 Reconcile ambiguous creates and prevent duplicates after crashes

**Amendment ids:** A11, A12

**Demonstrated gap:** (A11) The server no longer receives writes (A2), so it cannot hold an `Idempotency-Key` table; the PDS rejects a reused rkey, which preserves "same key, changed payload" detection. (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers.

**Amendment text:** Ambiguous creates reconcile with `getRecord` and a canonical digest comparison: equal is success, different is `remote_record_conflict`, and the record is never overwritten. There is no server request to replay five times.

| Case | Disposition |
| --- | --- |
| `crash_after_remote` | `web/test/outbox/recovery.test.ts › crash after PDS commit before local ack: ambiguous create reconciles to success via digest` |
| `conflicting_rkey` | `web/test/outbox/recovery.test.ts › remote record with different payload at rkey → remote_record_conflict, never overwritten` |
| `five_retries` | `retired:A11`: There is no server request to resubmit; the SPA allocates the rkey once per operation and replays only that operation. |

### M3.3.1 Authorize deletion and atomically mark tombstones

**Amendment ids:** A13, A12, D

**Demonstrated gap:** (A13) The AppView only reflects verified repository state; an unverified local delete cannot change public views without weakening "verified repository records are the public source of truth". (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers. (D) ADR 0004 §9.3 drops `DELETE /api/v1/scrobbles/{id}` with the other server write routes because under Q1 the SPA deletes from the owner's own PDS; the §15 BFF fallback would restore the route and its owner check.

**Amendment text:** `DELETE /api/v1/scrobbles/{id}` is dropped. The owner's view hides the record immediately through the outbox overlay; public views change once signed absence is verified. A delete queued behind a pending create waits for it (`predecessorIds`).

| Case | Disposition |
| --- | --- |
| `wrong_owner` | `retired:D`: DELETE /api/v1/scrobbles/{id} is dropped (ADR 0004 §9.3); a user can delete only from their own PDS repository. |
| `hide_immediately` | `web/test/outbox/delete.test.ts › pending deletion hidden in owner overlay; failure visible` (A13: owner-side optimistic overlay; public views change after verified absence.) |
| `pending_create_delete` | `web/test/outbox/delete.test.ts › delete behind an unsent or in-flight create runs after it and leaves no record on the fake PDS` (required wave amendment, W2-07) (A12: predecessor ordering through predecessorIds.) |

### M3.3.2 Handle remote delete idempotency and create/delete races

**Amendment ids:** A12

**Demonstrated gap:** (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers.

**Amendment text:** The SPA deletes with `swapRecord` set to the CID from `records/status`. `InvalidSwap` re-fetches and reconciles; `RecordNotFound` is success; the runner verifies absence after a crash during delete.

| Case | Disposition |
| --- | --- |
| `already_absent` | `web/test/outbox/recovery.test.ts › RecordNotFound on first and repeated delete completes the operation as success` (required wave amendment, W2-07) |
| `create_in_flight` | `web/test/outbox/delete.test.ts › delete behind an unsent or in-flight create runs after it and leaves no record on the fake PDS` (required wave amendment, W2-07); also `web/test/outbox/delete.test.ts › pending deletion hidden in owner overlay; failure visible` (A12 predecessor ordering; the A13 owner overlay keeps the record hidden meanwhile.) |
| `delete_restart` | `web/test/outbox/recovery.test.ts › crash during delete resumes with swapRecord and verifies absence` |

### M3.3.3 Propagate deletion to every read model and owner status

**Amendment ids:** A13

**Demonstrated gap:** (A13) The AppView only reflects verified repository state; an unverified local delete cannot change public views without weakening "verified repository records are the public source of truth".

**Amendment text:** Deletion propagates to every read model when a verified exclusion proof or a snapshot applies. A permanent remote failure stays visible to the owner and is never presented as a PDS delete.

| Case | Disposition |
| --- | --- |
| `read_model_removal` | `worker/test/acceptance/mutations.test.ts › delete r01 → 6/6/3, Homogenic 1, history r07,r02,…` |
| `remote_failure_status` | `web/test/outbox/delete.test.ts › pending deletion hidden in owner overlay; failure visible` |
| `external_delete` | `worker/test/ingest/verify-drain.test.ts › deleted record with exclusion proof → absent and removed from views` |

### M3.4.1 Add deterministic scrobble HTTP lifecycle tests

**Amendment ids:** A2, A12

**Demonstrated gap:** (A2) Under Q1 (ADR 0004 §15) the browser SPA writes directly to the user's PDS through the atproto OAuth session; the server holds no credential to write with. (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers.

**Amendment text:** The lifecycle runs through the SPA outbox, the owner's PDS, notify and the verified drain, ending with `records/status` reporting `indexed` and then `absent`.

| Case | Disposition |
| --- | --- |
| `lifecycle` | `web/tests/mvp.spec.ts › full journey sign-in → scrobble indexed → stats → follow/unfollow → delete → export → disconnect/reconnect → sign-out` |
| `validation_matrix` | `web/test/routes/scrobble.test.tsx › invalid input shows field errors and creates no outbox operation` |
| `same_time_distinct` | `worker/test/write/apply-record.test.ts › two records with identical track and listenedAt under different rkeys are two rows and two listens` (required wave amendment, W2-04); also `packages/core/test/record-key.test.ts › TIDs are monotonic and valid for fixed clock and seeded random` |

### M3.4.2 Add fault-injected restart and pagination acceptance tests

**Amendment ids:** A12, A18

**Demonstrated gap:** (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers. (A18) Workers tests run in workerd through `@cloudflare/vitest-plugin`; there is no process, port or `LD_PRELOAD` to control, and restart is DO eviction.

**Amendment text:** Crash barriers are simulated by re-instantiating the SPA runner over the same IndexedDB; server restart is DO eviction with storage kept.

| Case | Disposition |
| --- | --- |
| `kill_after_create` | `web/test/outbox/recovery.test.ts › crash after PDS commit before local ack: ambiguous create reconciles to success via digest` |
| `kill_after_delete` | `web/test/outbox/recovery.test.ts › crash during delete resumes with swapRecord and verifies absence` |
| `cursor_faults` | `worker/test/read/cursor-http.test.ts › arrival above anchor absent until fresh traversal; deleted unreturned record disappears` |

### M3.4.3 Record live external-PDS scrobble lifecycle evidence

**Amendment ids:** A11, A19

**Demonstrated gap:** (A11) The server no longer receives writes (A2), so it cannot hold an `Idempotency-Key` table; the PDS rejects a reused rkey, which preserves "same key, changed payload" detection. (A19) A Worker has no executable artifact; a release is a Worker version id and the bundle SHA-256.

**Amendment text:** Live evidence is recorded per Worker version id. The five-request replay case is retired with server idempotency.

| Case | Disposition |
| --- | --- |
| `live_create_read` | `npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names` (Live publish-and-index evidence is a W6-05 gate.) |
| `live_retries` | `retired:A11`: Server idempotency keys are dropped; there is no five-request replay to observe live. |
| `live_delete` | `npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names` (Live delete-and-reconcile evidence is a W6-05 gate.) |

### M4.1.1 Parse bounded relay frames and select music operations

**Amendment ids:** A6, A17

**Demonstrated gap:** (A6) Full relay `subscribeRepos` verification is about 2k events/s, too much for one DO (ADR 0004 §2); Jetstream carries unsigned events, so every event is a hint and authority comes from a signed proof. (A17) Jetstream does not narrow identity/account events by collection, so subscribing would deliver the whole network's stream to one DO (ADR 0004 F1).

**Amendment text:** Relay frames are replaced by bounded Jetstream JSON events (`kinds=commit`, messages over 64 KiB dropped and counted). Identity and account events are not subscribed; they are detected by errors and sweeps.

| Case | Disposition |
| --- | --- |
| `collection_filter` | `packages/atproto/test/jetstream-events.test.ts › identity/account/sync kinds and foreign collections are ignored`; also `packages/atproto/test/jetstream-events.test.ts › commit create/update/delete for configured collection yields hint with seq and time_us` |
| `frame_limits` | `packages/atproto/test/jetstream-events.test.ts › oversize, malformed JSON, bad DID, unsafe integer are invalid` |
| `event_types` | `packages/atproto/test/jetstream-events.test.ts › buildSubscribeUrl always contains kinds=commit and every collection, never identity/account`; also `packages/atproto/test/jetstream-events.test.ts › identity/account/sync kinds and foreign collections are ignored`, `worker/test/ingest/accounts.test.ts › deactivated status hides Alice immediately; Bob and Carol unaffected` (A17: identity and account events are not subscribed (kinds=commit); account changes come from errors and the getRepoStatus sweep.) |

### M4.1.2 Verify commit signatures, CIDs, and MST membership

**Amendment ids:** A6, A7

**Demonstrated gap:** (A6) Full relay `subscribeRepos` verification is about 2k events/s, too much for one DO (ADR 0004 §2); Jetstream carries unsigned events, so every event is a hint and authority comes from a signed proof. (A7) The full-CAR snapshot is capped at 8 MiB / 10,000 records, so heavy scrobblers never finish (`crates/atproto/src/sync/frames.rs:16`, ADR 0004 F5); a `getBlocks` walk over our key range has no record ceiling.

**Amendment text:** Verification is the `getRecord` inclusion/exclusion proof or the range walk at the current signed head under the current DID key. The tampering matrix extends to the rejection-matrix rule: projection and checkpoint tables byte-identical, then a valid hint applies.

| Case | Disposition |
| --- | --- |
| `valid_signed_repo` | `packages/atproto/test/rust-golden-cars.test.ts › every tests/goldens/signed_cars manifest entry yields the expected verdict and error code` |
| `tampering_matrix` | `worker/test/ingest/rejection-matrix.test.ts › each single-invariant corruption leaves scrobbles/follows/record_state/users/ingest_checkpoint byte-identical, then a valid hint applies` |
| `key_rotation` | `worker/test/ingest/verify-drain.test.ts › key rotation: first verify fails, fresh resolve succeeds` |

### M4.1.3 Apply verified mutations and checkpoint atomically

**Amendment ids:** A6

**Demonstrated gap:** (A6) Full relay `subscribeRepos` verification is about 2k events/s, too much for one DO (ADR 0004 §2); Jetstream carries unsigned events, so every event is a hint and authority comes from a signed proof.

**Amendment text:** A hint and the checkpoint advance commit in one `transactionSync`; the cursor can never run ahead of a durable hint. Applying a proof is idempotent under the per-URI revision guard.

| Case | Disposition |
| --- | --- |
| `duplicate_commit` | `worker/test/ingest/jetstream.test.ts › hint durable before cursor advance; replay of inclusive cursor creates no duplicate rows` |
| `atomic_fault` | `worker/test/ingest/hints.test.ts › enqueue and checkpoint advance commit atomically (throw rolls back both)` |
| `update_delete` | `worker/test/ingest/verify-drain.test.ts › deleted record with exclusion proof → absent and removed from views`; also `worker/test/write/apply-record.test.ts › r03 artist change updates keys without inserting a second listen` |

### M4.2.1 Implement cursor reconnect and gap detection

**Amendment ids:** A6

**Demonstrated gap:** (A6) Full relay `subscribeRepos` verification is about 2k events/s, too much for one DO (ADR 0004 §2); Jetstream carries unsigned events, so every event is a hint and authority comes from a signed proof.

**Amendment text:** The relay sequence cursor becomes the Jetstream `time_us` cursor. Reconnect only on close or error plus a planned refresh every 15 minutes; backoff 1 s base, 60 s cap, injected jitter; a cursor older than `JETSTREAM_LOOKBACK_HOURS` enters gap recovery.

| Case | Disposition |
| --- | --- |
| `resume` | `worker/test/ingest/jetstream.test.ts › hint durable before cursor advance; replay of inclusive cursor creates no duplicate rows` |
| `expired_cursor` | `worker/test/ingest/jetstream-socket.test.ts › cursor older than lookback sets pending_gap and resumes from live tail`; also `worker/test/ingest/gap-recovery.test.ts › gap schedules all known DIDs within 1,024 bound and clears pending_gap only after all complete` |
| `bounded_reconnect` | `worker/test/ingest/jetstream-socket.test.ts › close triggers reconnect delays 1,2,4,…,60s and rotates us-east→us-west` |

### M4.2.2 Implement verified repository backfill and revision convergence

**Amendment ids:** A7

**Demonstrated gap:** (A7) The full-CAR snapshot is capped at 8 MiB / 10,000 records, so heavy scrobblers never finish (`crates/atproto/src/sync/frames.rs:16`, ADR 0004 F5); a `getBlocks` walk over our key range has no record ceiling.

**Amendment text:** Backfill is a resumable `getBlocks` range walk with a 32 MiB streamed `getRepo` fallback and no record ceiling. Admission keeps the 1,024 pending-job bound; the DO runs one job slice per alarm.

| Case | Disposition |
| --- | --- |
| `historical_seed` | `worker/test/ingest/snapshot-job.test.ts › new DID snapshot imports r01–r07 and activates; r08 absent` |
| `snapshot_live_race` | `worker/test/write/apply-snapshot.test.ts › live hint with newer revision survives snapshot sweep` |
| `backfill_limits` | `worker/test/ingest/admission.test.ts › 1,024 pending jobs → next admission busy and writes nothing` (A7: the single DO runs one snapshot slice per alarm, so the four-active bound becomes one active slice.) |

### M4.2.3 Reconcile account state, identity changes, and status

**Amendment ids:** A17

**Demonstrated gap:** (A17) Jetstream does not narrow identity/account events by collection, so subscribing would deliver the whole network's stream to one DO (ADR 0004 F1).

**Amendment text:** Account state comes from error-driven detection and the `getRepoStatus` sweep (at most 1 h for DIDs active in the last 30 days, 24 h for others). Reactivation stays hidden until a complete snapshot commits under the generation guard.

| Case | Disposition |
| --- | --- |
| `pds_migration` | `worker/test/ingest/snapshot-job.test.ts › PDS migration A→B fetches from B and preserves URIs/CIDs` |
| `deactivate_reactivate` | `worker/test/ingest/reactivation.test.ts › deactivate Alice hides her; reactivation stays hidden until snapshot completes, then current` |
| `status_truth` | `worker/test/storage/status.test.ts › pending_gap overrides a stored current flag` |

### M4.3.2 Implement following scope and viewer-bound cursors

**Amendment ids:** A8

**Demonstrated gap:** (A8) There is no server session to identify the viewer (A3); follow records are already public (Q7).

**Amendment text:** `scope=following` requires `viewer=<did>` instead of a session: public, 422 `fields.viewer` when missing or invalid, and the cursor binds the viewer. An unknown viewer gets an empty page.

| Case | Disposition |
| --- | --- |
| `following_membership` | `worker/test/read/feed.test.ts › Alice following feed is r09 only and excludes self` |
| `scope_security` | `worker/test/read/feed.test.ts › missing viewer for following → 422 fields.viewer`; also `worker/test/read/cursor-http.test.ts › cursor from history used on feed or with different viewer → 400 invalid_cursor` (A8: the anonymous 401 becomes 422 fields.viewer.) |
| `follow_change` | `worker/test/acceptance/mutations.test.ts › remove Alice→Bob → following feed empty; global unchanged` |

### M4.4.1 Create independent-writer federation harness

**Amendment ids:** A6

**Demonstrated gap:** (A6) Full relay `subscribeRepos` verification is about 2k events/s, too much for one DO (ADR 0004 §2); Jetstream carries unsigned events, so every event is a hint and authority comes from a signed proof.

**Amendment text:** Federation evidence is an external writer published through its own PDS and ingested through Jetstream hints or notify plus signed proofs. Missing Jetstream coverage is reported blocked, never a pass.

| Case | Disposition |
| --- | --- |
| `independent_write` | `worker/test/acceptance/federation.test.ts › Carol r10 appears only through external ingestion with zero app write calls` |
| `independent_mutation` | `worker/test/acceptance/mutations.test.ts › r03 artist→Björk → Björk 3, Kate Bush 2, Radiohead 2, total 7`; also `worker/test/acceptance/mutations.test.ts › delete r01 → 6/6/3, Homogenic 1, history r07,r02,…`, `worker/test/acceptance/mutations.test.ts › Carol→Bob duplicates 2, then 2, then 1` (A2: every write, the SPA's included, reaches the index only through verified ingestion.) |
| `coverage_failure` | `npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names` (A6: Jetstream coverage is a live prerequisite; missing coverage is reported blocked, never a federation pass.) |

### M4.4.2 Add federation fault and convergence suite

**Amendment ids:** A6, A18

**Demonstrated gap:** (A6) Full relay `subscribeRepos` verification is about 2k events/s, too much for one DO (ADR 0004 §2); Jetstream carries unsigned events, so every event is a hint and authority comes from a signed proof. (A18) Workers tests run in workerd through `@cloudflare/vitest-plugin`; there is no process, port or `LD_PRELOAD` to control, and restart is DO eviction.

**Amendment text:** Convergence runs through gap recovery and snapshots; restart is DO eviction with byte-identical tables and a continuing cursor.

| Case | Disposition |
| --- | --- |
| `convergence` | `worker/test/acceptance/federation.test.ts › duplicate events, socket drop and expired cursor converge to the exact URI/CID/payload set with no double-counted stats` (required wave amendment, W6-01); also `worker/test/ingest/gap-recovery.test.ts › gap schedules all known DIDs within 1,024 bound and clears pending_gap only after all complete` |
| `signature_failure` | `worker/test/acceptance/federation.test.ts › bad signature / changed block / wrong MST path leave projection and cursor byte-identical` |
| `worker_restart` | `worker/test/acceptance/restart.test.ts › eviction preserves byte-identical tables, pre-restart cursor continues, alarm resumes` |

### M4.4.3 Run two-external-PDS live federation acceptance

**Amendment ids:** A6, A19

**Demonstrated gap:** (A6) Full relay `subscribeRepos` verification is about 2k events/s, too much for one DO (ADR 0004 §2); Jetstream carries unsigned events, so every event is a hint and authority comes from a signed proof. (A19) A Worker has no executable artifact; a release is a Worker version id and the bundle SHA-256.

**Amendment text:** The live federation gate uses Jetstream coverage instead of a configured relay and records evidence per Worker version id.

| Case | Disposition |
| --- | --- |
| `live_remote_arrival` | `npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names` (External-writer arrival is a W6-05 live gate.) |
| `live_remote_mutation` | `npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names` (External update/delete is a W6-05 live gate.) |
| `live_recovery` | `npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names` (Socket reconnect convergence is the W6-05 24 h soak.) |

### M5.2.1 Serve verified handle resolution and stable DID profiles

**Amendment ids:** A17

**Demonstrated gap:** (A17) Jetstream does not narrow identity/account events by collection, so subscribing would deliver the whole network's stream to one DO (ADR 0004 F1).

**Amendment text:** Handle changes are picked up by the daily identity sweep, verified in both directions; the DID and its URLs are unchanged.

| Case | Disposition |
| --- | --- |
| `handle_rename` | `worker/test/ingest/sweeps.test.ts › renamed handle verifies on the next identity sweep and resolves to the same DID with unchanged history` (required wave amendment, W4-03); also `worker/test/ingest/sweeps.test.ts › handle that no longer verifies becomes null; history retained` (A17 identity sweep.) |
| `unverified_alias` | `worker/test/read/resolve.test.ts › verified handle 200; unresolved 404; mismatch 422` |
| `profile_fields` | `worker/test/read/profile.test.ts › Alice followers 0 following 1; Bob followers 1 following 0; Carol 0/0` |

### M5.2.3 Assert public profile privacy and caching rules

**Amendment ids:** A3, D

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential, cookie or private payload to leak into a profile. (D) ADR 0004 §9.3 drops application sessions under Q1, so no request carries a caller identity that could make the owner's view of a public profile differ from anyone else's; the §15 BFF fallback would restore sessions and with them the owner-equality case.

**Amendment text:** The server holds no tokens, cookies or private payloads, and no request carries a caller identity, so the sensitive-field and owner-equality cases are retired. Profile caching stays `no-store`.

| Case | Disposition |
| --- | --- |
| `sensitive_fields` | `retired:A3`: The server receives and stores no tokens, cookies or private payloads (A3, ADR 0004 §8), so there is no seeded secret that a profile response could expose. |
| `owner_equality` | `retired:D`: Sessions are dropped (ADR 0004 §9.3), so no request carries a caller identity that could change a public payload. |
| `cache_invalidation` | `worker/test/read/stats-cache.test.ts › cache hit only when version unchanged and no row crossed either bound; result equals uncached`; also `worker/test/read/stats-cache.test.ts › delete r01 invalidates: all → 6 listens, Homogenic 1` |

### M5.3.1 Publish and delete idempotent music-follow records

**Amendment ids:** A2, A12

**Demonstrated gap:** (A2) Under Q1 (ADR 0004 §15) the browser SPA writes directly to the user's PDS through the atproto OAuth session; the server holds no credential to write with. (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers.

**Amendment text:** `PUT/DELETE /api/v1/follows/{did}` are dropped. The SPA writes the deterministic follow rkey; an existing record with the same subject is success and keeps its `createdAt`. Unfollow lists the owner's follow records with `listRecords` and deletes every matching record with `swapRecord`.

| Case | Disposition |
| --- | --- |
| `self_and_duplicate` | `packages/core/test/follow.test.ts › follow validation and self-follow rejection`; also `packages/core/test/record-key.test.ts › followRkey equals follow_rkeys.json` |
| `restart_follow` | `web/test/outbox/recovery.test.ts › crash after follow createRecord before local ack reconciles to one record at the deterministic rkey` (required wave amendment, W2-07); also `packages/core/test/record-key.test.ts › followRkey equals follow_rkeys.json` |
| `unfollow_absent` | `web/test/outbox/follows.test.ts › unfollow deletes all duplicate matching records and keeps unrelated subject`; also `web/test/outbox/follows.test.ts › unfollow with no matching record succeeds with zero deleteRecord calls` (required wave amendment, W2-07) |

### M5.3.3 Integrate follow/account state into feed membership

**Amendment ids:** A2, A12

**Demonstrated gap:** (A2) Under Q1 (ADR 0004 §15) the browser SPA writes directly to the user's PDS through the atproto OAuth session; the server holds no credential to write with. (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers.

**Amendment text:** A queued follow lives in the SPA outbox; the following feed changes only after the follow record's proof applies.

| Case | Disposition |
| --- | --- |
| `pending_confirmed` | `worker/test/ingest/verify-drain.test.ts › known active DID hint → one getRecord call → row applied with receipt-time validation`; also `worker/test/ingest/admission.test.ts › unknown DID admitted inactive with snapshot job; hint itself not projected` (A2/A12: the queued follow lives in the SPA outbox; the edge appears only after its proof applies.) |
| `unfollow_target` | `worker/test/acceptance/mutations.test.ts › remove Alice→Bob → following feed empty; global unchanged` |
| `account_state` | `worker/test/ingest/accounts.test.ts › reactivated status schedules snapshot and keeps hidden until completion` |

### M5.4.3 Verify persistence with packaged process restart

**Amendment ids:** A18

**Demonstrated gap:** (A18) Workers tests run in workerd through `@cloudflare/vitest-plugin`; there is no process, port or `LD_PRELOAD` to control, and restart is DO eviction.

**Amendment text:** Restart is DO eviction with storage kept: byte-compare every projection table, continue a pre-restart cursor and assert the alarm resumes.

| Case | Disposition |
| --- | --- |
| `durable_views` | `worker/test/acceptance/restart.test.ts › eviction preserves byte-identical tables, pre-restart cursor continues, alarm resumes` |
| `durable_cursor` | `worker/test/acceptance/restart.test.ts › eviction preserves byte-identical tables, pre-restart cursor continues, alarm resumes` |
| `durable_delete` | `worker/test/write/apply-record.test.ts › older revision proof after newer delete is noop (no resurrection)`; also `worker/test/acceptance/restart.test.ts › eviction preserves byte-identical tables, pre-restart cursor continues, alarm resumes`, `web/test/outbox/recovery.test.ts › crash during delete resumes with swapRecord and verifies absence` |

### M6.1.1 Embed compile-time assets and implement safe SPA routing

**Amendment ids:** A1, D

**Demonstrated gap:** (A1) The SPA ships as Workers Static Assets uploaded with the Worker version, not as files compiled into a Rust executable, so asset lookup, traversal rejection and the SPA fallback are the Static Assets router's (`not_found_handling: single-page-application`, with `run_worker_first` only for `/api/*`, `/health/*` and `/internal/*`). (D) ADR 0004 §9.3 drops build.rs embedding because Static Assets replace it; the drop follows from the runtime, not from Q1. The cache policy is not dropped: Static Assets do not mark hashed files immutable by default, so the policy moves to the generated `_headers` file (W1-09).

**Amendment text:** Superseded. build.rs embedding is replaced by Workers Static Assets with SPA fallback; `run_worker_first` covers only `/api/*`, `/health/*` and `/internal/*`. An unknown `/api/*` path is a JSON 404 from the Worker. The cache policy is kept and moves to the generated `web/public/_headers` (W1-09): hashed `/assets/*` files are `public, max-age=31536000, immutable`, and `index.html` and `/oauth/client-metadata.json` are `no-cache`.

| Case | Disposition |
| --- | --- |
| `asset_missing_traversal` | `web/tests/mvp.spec.ts › non-navigation GET /assets/missing.js and encoded ../ traversal return 404, never index.html` (required wave amendment, W6-03); also `worker/test/composition/routing.test.ts › every API.md v1.1 route dispatches; unknown /api/x → JSON 404; non-API path → ASSETS` (Asset lookup is Workers Static Assets behaviour (ADR 0004 §9.3 drops build.rs embedding).) |
| `spa_deep_link` | `web/tests/mvp.spec.ts › GET /u/<did> and /feed serve index.html 200 and POST /feed never returns SPA HTML` (required wave amendment, W6-03) |
| `asset_cache` | `scripts/test/gen-config.test.ts › _headers marks /assets/* public, max-age=31536000, immutable and /index.html and /oauth/client-metadata.json no-cache` (required wave amendment, W1-09); also `web/tests/mvp.spec.ts › hashed /assets/*.js returns 200 with a JavaScript content type and immutable Cache-Control` (required wave amendment, W6-03) (Workers Static Assets do not mark hashed files immutable by default, so the policy moves to the generated _headers file.) |

### M6.1.2 Validate public-origin and trusted-proxy deployment settings

**Amendment ids:** D

**Demonstrated gap:** (D) ADR 0004 §9.3 drops the trusted-proxy settings because Cloudflare terminates TLS in front of every Worker and supplies the client address in `CF-Connecting-IP`; there is no operator reverse proxy whose `Forwarded` or `X-Forwarded-For` headers could be trusted, and the Worker reads no Host header because OAuth metadata is generated at build time from `PUBLIC_ORIGIN`. The drop follows from the runtime, not from Q1, so the §15 BFF fallback would not restore it.

**Amendment text:** Superseded. The trusted reverse proxy is replaced by Cloudflare: the Worker strips inbound `x-atmusic-*` headers and copies `CF-Connecting-IP`. OAuth metadata is generated at build time from `PUBLIC_ORIGIN`, so no Host header is read.

| Case | Disposition |
| --- | --- |
| `untrusted_forwarded` | `worker/test/composition/routing.test.ts › inbound x-atmusic-client-ip is stripped and CF-Connecting-IP used`; also `scripts/test/gen-config.test.ts › production metadata equals expected JSON for https://music.example.org with prefix org.example.music` (Metadata is generated at build time from PUBLIC_ORIGIN, so no forwarded header reaches it.) |
| `trusted_proxy` | `retired:D`: The trusted reverse proxy is dropped; Cloudflare terminates TLS and supplies CF-Connecting-IP (ADR 0004 §9.3). |
| `origin_mismatch` | `scripts/test/gen-config.test.ts › production metadata equals expected JSON for https://music.example.org with prefix org.example.music` (Metadata is generated at build time from PUBLIC_ORIGIN, so no Host header is read; wrong-Origin mutations are dropped (D).) |

### M6.1.3 Document fresh install, upgrade, and restart workflow

**Amendment ids:** A1, A15

**Demonstrated gap:** (A1) There is no binary to install, database file to migrate or service to restart: a deploy is `wrangler` uploading a Worker version bound to one SQLite Durable Object, a custom domain and the `CURSOR_KEY` secret, and the DO migrates itself on first use. (A15) A Durable Object has no file to copy; DO point-in-time recovery covers 30 days and the index is re-derivable from public repositories.

**Amendment text:** The install flow is `wrangler` deploy with a custom domain, `CURSOR_KEY` and an owned prefix; `scripts/deploy.sh --dry-run` refuses an empty or fixture prefix and a missing secret. Recovery from a bad upgrade is DO point-in-time recovery.

| Case | Disposition |
| --- | --- |
| `fresh_install` | `bash scripts/deploy.sh --dry-run › valid owned prefix and CURSOR_KEY run gen-config, the web build and wrangler deploy --dry-run with exit 0` (required wave amendment, W6-04); also `worker/test/storage/migrate.test.ts › fresh DO applies migration 1 and seeds indexing_status/backfill_generation/ingest_checkpoint`, `worker/test/http/health-meta.test.ts › live 200; ready 503 when index reports too_new; meta capabilities omit publication without owned prefix` |
| `upgrade_failure` | `worker/test/storage/migrate.test.ts › a migration whose second statement is invalid persists neither statement and keeps the previous schema version` (required wave amendment, W0-01) (A15: recovery after a bad deploy is DO point-in-time recovery, an operator action outside the deterministic suite.) |
| `secret_example_scan` | `scripts/test/secret-scan.test.ts › worker/.dev.vars.example, .env.example and docs contain no credential-shaped values` (required wave amendment, W6-04) |

### M6.2.1 Enforce body limits and bounded per-user/IP rates

**Amendment ids:** A1, N1

**Demonstrated gap:** (A1) There is no per-process rate limiter in front of a server: the single Worker runs in many isolates, so the only shared place for buckets is the singleton SQLite Durable Object, and the client IP comes from `CF-Connecting-IP`. (N1) Without server writes the AppView needs an untrusted, rate-limited way to learn about a new record promptly (ADR 0004 §5.2 step 4); notify is therefore the only JSON body left to cap.

**Amendment text:** The only JSON body is notify, capped at 2 KiB (413 above). Notify is limited to 60/min per IP (`CF-Connecting-IP`) and 600/h per DID with 429 and `Retry-After`; buckets live in the singleton DO and fail open after a restart.

| Case | Disposition |
| --- | --- |
| `body_boundary` | `worker/test/ingest/notify.test.ts › 2,048-byte body reaches the parser and 2,049-byte body → 413 with no DB change` (required wave amendment, W4-04); also `worker/test/http/params.test.ts › body over cap → 413; malformed JSON → 400`, `worker/test/ingest/notify.test.ts › foreign collection or bad URI → 422; oversize → 413; unknown field → 422` (N1: the only JSON body is notify, capped at 2 KiB.) |
| `rate_boundary` | `worker/test/ingest/notify.test.ts › 61st request per IP per minute → 429 and no DB change`; also `worker/test/http/limits.test.ts › bucket refills exactly with injected clock; 61st request in a minute is limited` (Only notify is rate-limited (M6.2.1 amendment, ADR 0004 §8).) |
| `bounded_state` | `worker/test/http/limits.test.ts › 10,001 distinct IP keys keep BucketSet at its cap and expired buckets are evicted` (required wave amendment, W1-07); also `worker/test/composition/routing.test.ts › inbound x-atmusic-client-ip is stripped and CF-Connecting-IP used` (Buckets fail open after a DO restart (ADR 0004 §8).) |

### M6.2.2 Expose safe metrics and degrade on upstream outages

**Amendment ids:** A16

**Demonstrated gap:** (A16) A Worker cannot run a Prometheus listener; Workers Logs, the `counters` table and `/internal/admin/status` replace it.

**Amendment text:** Superseded. Metrics are Workers Logs, the `counters` table and `/internal/admin/status`, which exists only when `ADMIN_TOKEN` is set and compares the bearer token in constant time. Log redaction is kept: ADR 0004 §8 requires that `CURSOR_KEY` and `ADMIN_TOKEN` are never logged or serialised, and the Worker has an injected `Logger` and receives the admin bearer token, so the redaction case maps to a W5-01 captured-log test instead of being retired.

| Case | Disposition |
| --- | --- |
| `metrics_auth` | `worker/test/composition/admin.test.ts › admin routes 404 without ADMIN_TOKEN; wrong token 401 constant-time; status JSON shape`; also `worker/test/composition/logging.test.ts › captured logs and error bodies contain no CURSOR_KEY, ADMIN_TOKEN or bearer marker and logs contain no track-title marker` (required wave amendment, W5-01) (A16: metrics become /internal/admin/status.) |
| `upstream_offline` | `worker/test/storage/status.test.ts › socket disconnected >5min reports stale`; also `worker/test/http/health-meta.test.ts › ready 200 and meta indexing stale while the index reports the socket disconnected` (required wave amendment, W1-07) |
| `log_redaction` | `worker/test/composition/logging.test.ts › captured logs and error bodies contain no CURSOR_KEY, ADMIN_TOKEN or bearer marker and logs contain no track-title marker` (required wave amendment, W5-01) (There are no OAuth codes or cookies to mark (A3).) |

### M6.2.3 Add reproducible query latency benchmark

**Amendment ids:** A1

**Demonstrated gap:** (A1) Queries run on DO SQLite inside workerd rather than through an sqlx pool in a native process, so the Rust wall-clock numbers do not transfer; Workers bill and bound rows read, so rows read per query and the index plan are the reproducible quantities, with workerd latency recorded beside them.

**Amendment text:** The benchmark runs on DO SQLite in workerd and reports rows read, CPU and latency; the slow-query check is the `EXPLAIN QUERY PLAN` negative control.

| Case | Disposition |
| --- | --- |
| `benchmark_dataset` | `worker/test/bench/read-models.bench.test.ts › seeded generator yields exactly 100,000 valid active rows with the documented per-user distribution` (required wave amendment, W6-02) |
| `benchmark_results` | `worker/test/bench/read-models.bench.test.ts › 600 measured requests with zero errors report p95 and check it against the target` (required wave amendment, W6-02) |
| `slow_query_detection` | `worker/test/acceptance/query-plans.test.ts › 100×1,000 seeded records: history/feed/stats plans use indexes; negative control scans` |

### M6.3.1 Implement consistent SQLite backup and verified restore

**Amendment ids:** A15

**Demonstrated gap:** (A15) A Durable Object has no file to copy; DO point-in-time recovery covers 30 days and the index is re-derivable from public repositories.

**Amendment text:** Superseded. File backup and verified restore are replaced by DO point-in-time recovery (`getBookmarkForTime` / `onNextSessionRestoreBookmark` behind admin) plus a full rebuild from public repositories.

| Case | Disposition |
| --- | --- |
| `backup_during_write` | `retired:A15`: File backup becomes DO point-in-time recovery plus a full rebuild from public repositories. |
| `restore_state` | `retired:A15`: PITR restores the whole DO; there is no encrypted auth to decrypt (A3). |
| `wrong_key` | `retired:A15`: There is no operator encryption key to restore with (ADR 0004 §9.3). |

### M6.3.2 Implement owner-only JSON account export

**Amendment ids:** A9, N3

**Demonstrated gap:** (A9) Owner-only export needs a server session, which no longer exists (A3); the exported records are all public. (N3) A9 moves export to a public per-DID route.

**Amendment text:** `GET /api/v1/account/export` becomes `GET /api/v1/users/{did}/export`: public, the same payload, attachment `music-export.json`, `no-store`, 404 for unknown or inactive users.

| Case | Disposition |
| --- | --- |
| `export_owner` | `worker/test/read/export.test.ts › export contains only indexed public records, attachment header, 404 for inactive` |
| `export_auth` | `retired:A9`: Export becomes the public GET /api/v1/users/{did}/export with the same payload; there is no owner check to reject. |
| `export_secret_scan` | `worker/test/read/export.test.ts › export contains only indexed public records, attachment header, 404 for inactive` |

### M6.3.3 Implement local-data disconnect and indexing suppression

**Amendment ids:** A10

**Demonstrated gap:** (A10) A server-side disconnect needs an authenticated owner request; with no session (A3) the owner proves intent with a repo-signed `<prefix>.settings/self` record (ADR 0004 F10, §5.3).

**Amendment text:** `DELETE /api/v1/account/local-data` becomes the signed `<prefix>.settings/self` record with `indexing: "disabled"` (`lexicons/settings.json`). Once verified, one transaction deletes the DID's local data and keeps only the suppression marker. Deleting the record, or `enabled` at a newer revision, reconnects through a fresh snapshot.

| Case | Disposition |
| --- | --- |
| `disconnect_effect` | `worker/test/write/suppression.test.ts › disabled settings deletes local data and keeps only suppression marker; other owners' follows to DID hidden` |
| `suppression` | `worker/test/acceptance/federation.test.ts › settings disabled disconnects Carol; settings deleted reconnects after snapshot` |
| `explicit_reconnect` | `worker/test/write/suppression.test.ts › enabled/absent settings with newer rev clears suppression and requests admission` |

### M6.4.1 Create versioned static release pipeline with checksums

**Amendment ids:** A19

**Demonstrated gap:** (A19) A Worker has no executable artifact; a release is a Worker version id and the bundle SHA-256.

**Amendment text:** Superseded. The release is a Worker version uploaded with `wrangler versions upload`, identified by its version id and bundle SHA-256. The checksum obligation is kept in that form: `scripts/check-bundle.ts` prints the bundle SHA-256, and live evidence without the version id or bundle hash is rejected.

| Case | Disposition |
| --- | --- |
| `tag_version` | `retired:A19`: Releases are Worker versions (wrangler versions upload), not tagged musl artifacts. |
| `checksum` | `npx tsx scripts/check-bundle.ts › production bundle passes guard`; also `scripts/test_live_evidence.py › evidence missing version id or bundle hash is rejected` (A19: the release checksum is the bundle SHA-256 that check-bundle prints and the live evidence records with the Worker version id.) |
| `static_release` | `retired:A19`: There is no ELF executable to inspect. |

### M6.4.2 Run packaged backend fault/recovery acceptance

**Amendment ids:** A18, A19

**Demonstrated gap:** (A18) Workers tests run in workerd through `@cloudflare/vitest-plugin`; there is no process, port or `LD_PRELOAD` to control, and restart is DO eviction. (A19) A Worker has no executable artifact; a release is a Worker version id and the bundle SHA-256.

**Amendment text:** The acceptance run is `scripts/acceptance/workers-backend.sh` (W7-01) and the case map closure; an unmapped case or a missing test fails it.

| Case | Disposition |
| --- | --- |
| `packaged_flow` | `bash scripts/acceptance/workers-backend.sh › exits 0 with all deterministic suites passing and lists live gates as blocked when prerequisites absent` |
| `packaged_recovery` | `worker/test/acceptance/restart.test.ts › eviction preserves byte-identical tables, pre-restart cursor continues, alarm resumes` |
| `unrun_gate` | `scripts/test_validate_case_map.py › --check-tests reports a missing test file or name` (required wave amendment, W0-02); also `python3 scripts/validate_case_map.py --check-tests › every mapped test file and name exists; 258 cases covered` |

### M6.4.3 Record live backend MVP gate and operational limits

**Amendment ids:** A6, A19

**Demonstrated gap:** (A6) Full relay `subscribeRepos` verification is about 2k events/s, too much for one DO (ADR 0004 §2); Jetstream carries unsigned events, so every event is a hint and authority comes from a signed proof. (A19) A Worker has no executable artifact; a release is a Worker version id and the bundle SHA-256.

**Amendment text:** Live evidence is keyed by Worker version id and bundle hash; Jetstream coverage replaces relay coverage as a prerequisite.

| Case | Disposition |
| --- | --- |
| `live_inventory` | `scripts/test_live_evidence.py › evidence missing version id or bundle hash is rejected` |
| `blocked_gate` | `scripts/test_live_evidence.py › blocked result is distinguished from pass and fail` |
| `privacy_consistency` | `web/test/routes/settings.test.tsx › disconnect confirmation states that public PDS records and the opt-out record remain and claims no erasure` (required wave amendment, W3-06); also `web/test/routes/settings.test.tsx › disconnect requires confirmation and enqueues settings op` |

### M7.1.1 Scaffold Preact/TypeScript/Vite only after backend gate

**Amendment ids:** A14

**Demonstrated gap:** (A14) The SPA is now the only write client (A2), so the write path cannot wait for M6.4.

**Amendment text:** The SPA scaffold starts in Wave 1 (W1-10) with npm workspaces; there is no backend-gate precondition. Browser end-to-end tests still follow backend composition.

| Case | Disposition |
| --- | --- |
| `web_build` | `scripts/test/check-ts.test.ts › npm ci, tsc -b and the web production build pass and leave package-lock.json unchanged` (required wave amendment, W0-01) |
| `strict_type_failure` | `scripts/test/check-ts.test.ts › a wrong API field type in a disposable copy fails tsc -b` (required wave amendment, W0-01) |
| `gate_enforcement` | `retired:A14`: "No frontend before M6.4" is dropped; the SPA write path is core and starts in Wave 1. |

### M7.1.2 Generate typed API client and session/CSRF state

**Amendment ids:** A3, D

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB. (D) ADR 0004 §9.3 drops the CSRF token and Origin rules with the server mutation routes because under Q1 the SPA sends no mutation to the Worker; the §15 BFF fallback would restore CSRF and the client's CSRF state.

**Amendment text:** The typed client covers every v1.1 route including notify and records/status. CSRF state is dropped; session loss is the OAuth library's re-auth state.

| Case | Disposition |
| --- | --- |
| `contract_drift` | `web/test/api-client.test.ts › every api/examples response decodes and a changed field type is rejected` (required wave amendment, W1-10); also `web/test/api-client.test.ts › decodes Page<Scrobble> and passes nextCursor unchanged` |
| `csrf_client` | `retired:D`: CSRF and Origin rules are dropped (ADR 0004 §9.3); the SPA sends no server mutation. |
| `session_loss` | `web/test/oauth/session.test.ts › expired/refresh-failed session surfaces re-auth state` |

### M7.1.3 Implement accessible route shell and state primitives

**Amendment ids:** A1

**Demonstrated gap:** (A1) The SPA is served by Workers Static Assets rather than by a fallback route in the Rust process, so deep links resolve through the Static Assets single-page-application fallback before the Worker runs.

**Amendment text:** Deep links are served by the Static Assets SPA fallback.

| Case | Disposition |
| --- | --- |
| `route_deep_links` | `web/tests/mvp.spec.ts › GET /u/<did> and /feed serve index.html 200 and POST /feed never returns SPA HTML` (required wave amendment, W6-03); also `web/test/routes/shell.test.tsx › unknown route renders the not-found view` (required wave amendment, W3-06) |
| `keyboard_shell` | `web/tests/accessibility.spec.ts › Tab and Enter reach every navigation destination with visible focus` (required wave amendment, W6-03) |
| `state_components` | `web/test/routes/feed.test.tsx › loading, empty, error and stale states render labelled text and no spinner remains after an error` (required wave amendment, W3-06) |

### M7.2.1 Implement handle sign-in and secure sign-out screens

**Amendment ids:** A3

**Demonstrated gap:** (A3) Q1 (ADR 0004 §15) places the OAuth client in the browser so the Worker holds no user credential; `@atproto/oauth-client-browser` performs discovery, PAR, PKCE, DPoP nonces, the issuer check and refresh, and stores the session in IndexedDB.

**Amendment text:** Sign-in uses `BrowserOAuthClient`; after the callback the SPA posts `notify {did}`. Sign-out revokes and clears IndexedDB.

| Case | Disposition |
| --- | --- |
| `signin_success` | `web/test/routes/shell.test.tsx › signed-in shell shows the verified handle and DID and the authenticated navigation` (required wave amendment, W3-06); also `web/test/oauth/session.test.ts › successful callback stores session and posts notify {did}` |
| `signin_failures` | `web/test/routes/signin.test.tsx › cancelled authorization, expired callback and unknown handle show specific recovery text with retry and no code or token in the DOM` (required wave amendment, W3-06); also `web/test/oauth/session.test.ts › expired/refresh-failed session surfaces re-auth state` |
| `logout_ui` | `web/test/oauth/session.test.ts › signOut calls revoke and clears IndexedDB stores`; also `web/test/routes/shell.test.tsx › after sign-out the shell shows anonymous navigation and the settings route shows a sign-in prompt` (required wave amendment, W3-06) |

### M7.2.2 Implement manual scrobble form and publication states

**Amendment ids:** A12, N2

**Demonstrated gap:** (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers. (N2) The SPA needs to see when its record is indexed or excluded, which the dropped operation status used to report.

**Amendment text:** Publication states are *queued → published → indexed* or *excluded (reason)*, read from the outbox and `GET /api/v1/records/status`.

| Case | Disposition |
| --- | --- |
| `form_validation` | `web/test/routes/scrobble.test.tsx › invalid input shows field errors and creates no outbox operation` |
| `submit_retry` | `web/test/outbox/recovery.test.ts › crash after PDS commit before local ack: ambiguous create reconciles to success via digest`; also `web/test/routes/scrobble.test.tsx › status progresses queued→published→indexed from mocked records/status` |
| `poll_terminal` | `web/test/routes/scrobble.test.tsx › status progresses queued→published→indexed from mocked records/status`; also `web/test/routes/scrobble.test.tsx › excluded or failed status shows the failure code, stops polling and never shows published success` (required wave amendment, W3-06) |

### M7.2.3 Implement owner delete, export, and local disconnect UI

**Amendment ids:** A9, A10, A13

**Demonstrated gap:** (A9) Owner-only export needs a server session, which no longer exists (A3); the exported records are all public. (A10) A server-side disconnect needs an authenticated owner request; with no session (A3) the owner proves intent with a repo-signed `<prefix>.settings/self` record (ADR 0004 F10, §5.3). (A13) The AppView only reflects verified repository state; an unverified local delete cannot change public views without weakening "verified repository records are the public source of truth".

**Amendment text:** Delete uses the outbox overlay; export downloads the public `users/{did}/export`; disconnect writes `settings/self` with `indexing: "disabled"` after offering an export and states that the opt-out record is public.

| Case | Disposition |
| --- | --- |
| `delete_owner` | `web/test/routes/profile.test.tsx › delete control appears only on the signed-in owner's own records` (required wave amendment, W3-06); also `web/test/outbox/delete.test.ts › pending deletion hidden in owner overlay; failure visible` (The forced Bob call is dropped with the server delete route (D).) |
| `export_download` | `web/test/routes/settings.test.tsx › export action downloads /api/v1/users/<did>/export as music-export.json` (required wave amendment, W3-06); also `worker/test/read/export.test.ts › export contains only indexed public records, attachment header, 404 for inactive` |
| `disconnect_text` | `web/test/routes/settings.test.tsx › disconnect confirmation states that public PDS records and the opt-out record remain and claims no erasure` (required wave amendment, W3-06); also `web/test/routes/settings.test.tsx › disconnect requires confirmation and enqueues settings op`, `web/test/outbox/settings.test.ts › disconnect writes settings/self disabled and notifies` |

### M7.3.1 Render global/following feeds with cursor pagination

**Amendment ids:** A8

**Demonstrated gap:** (A8) There is no server session to identify the viewer (A3); follow records are already public (Q7).

**Amendment text:** The following feed is public with `viewer=<did>`; the signed-in DID is the default viewer. An anonymous user has no viewer, so selecting following shows a sign-in prompt and sends no `scope=following` request.

| Case | Disposition |
| --- | --- |
| `feed_order` | `web/test/routes/feed.test.tsx › renders items and loads next page via nextCursor` |
| `anonymous_following` | `web/test/routes/feed.test.tsx › anonymous user selecting following sees a sign-in prompt and no scope=following request is sent` (required wave amendment, W3-06) (A8: the following feed needs viewer=<did>, and the SPA takes the viewer from the session.) |
| `feed_failure` | `web/test/routes/feed.test.tsx › page-2 503 keeps page 1, shows retry, and a successful retry appends page 2 once` (required wave amendment, W3-06) |

### M7.3.3 Implement follow/unfollow controls and index refresh

**Amendment ids:** A12

**Demonstrated gap:** (A12) Writes go from the browser to the owner's PDS (A2), so the outbox moves to the SPA IndexedDB store with the same retry formula, cap and crash barriers.

**Amendment text:** Follow and unfollow run through the SPA outbox; a permanent remote failure is shown as failed.

| Case | Disposition |
| --- | --- |
| `follow_state` | `web/test/routes/profile.test.tsx › follow button shows pending then confirmed, and a permanently failed unfollow shows failed without claiming removal` (required wave amendment, W3-06); also `web/test/outbox/follows.test.ts › PUT, DELETE, PUT for one subject execute in order with separate ids` |
| `unfollow_failure` | `web/test/routes/profile.test.tsx › follow button shows pending then confirmed, and a permanently failed unfollow shows failed without claiming removal` (required wave amendment, W3-06) |
| `self_and_auth` | `web/test/routes/profile.test.tsx › own profile has no follow control and an anonymous viewer gets a sign-in action` (required wave amendment, W3-06); also `packages/core/test/follow.test.ts › follow validation and self-follow rejection` |

### M7.4.1 Build and embed production SPA in release executable

**Amendment ids:** A1

**Demonstrated gap:** (A1) There is no release executable to embed the SPA in: the Vite `dist/` directory is uploaded as Workers Static Assets with each Worker version, so an embedded-dist or missing-build check has nothing to inspect.

**Amendment text:** Superseded deliverable: the SPA is served by Workers Static Assets, not embedded in an executable.

| Case | Disposition |
| --- | --- |
| `embedded_dist` | `retired:A1`: The SPA is served by Workers Static Assets, not embedded in an executable. |
| `missing_build` | `retired:A1`: There is no product executable; wrangler deploys the asset directory with the Worker. |
| `asset_links` | `web/tests/mvp.spec.ts › hashed /assets/*.js returns 200 with a JavaScript content type and immutable Cache-Control` (required wave amendment, W6-03); also `web/tests/mvp.spec.ts › GET /u/<did> and /feed serve index.html 200 and POST /feed never returns SPA HTML` (required wave amendment, W6-03) |

### M7.4.2 Run complete browser journey against packaged executable

**Amendment ids:** A1, A18

**Demonstrated gap:** (A1) There is no packaged executable to run the journey against; the deployable unit is the Worker plus its Static Assets and Durable Object, which `wrangler dev` runs locally in workerd. (A18) Workers tests run in workerd through `@cloudflare/vitest-plugin`; there is no process, port or `LD_PRELOAD` to control, and restart is DO eviction.

**Amendment text:** The browser journey runs with Playwright against `wrangler dev` and a local PDS (`@atproto/dev-env`).

| Case | Disposition |
| --- | --- |
| `browser_journey` | `web/tests/mvp.spec.ts › full journey sign-in → scrobble indexed → stats → follow/unfollow → delete → export → disconnect/reconnect → sign-out` |
| `browser_restart` | `worker/test/acceptance/restart.test.ts › eviction preserves byte-identical tables, pre-restart cursor continues, alarm resumes`; also `web/test/outbox/recovery.test.ts › crash after PDS commit before local ack: ambiguous create reconciles to success via digest` (A18: restart is DO eviction; the browser journey runs against wrangler dev.) |
| `browser_network` | `web/test/oauth/session.test.ts › expired/refresh-failed session surfaces re-auth state`; also `web/test/routes/feed.test.tsx › page-2 503 keeps page 1, shows retry, and a successful retry appends page 2 once` (required wave amendment, W3-06), `web/test/routes/feed.test.tsx › loading, empty, error and stale states render labelled text and no spinner remains after an error` (required wave amendment, W3-06) |

### M7.4.3 Run accessibility and live product release gate

**Amendment ids:** A6, A19

**Demonstrated gap:** (A6) Full relay `subscribeRepos` verification is about 2k events/s, too much for one DO (ADR 0004 §2); Jetstream carries unsigned events, so every event is a hint and authority comes from a signed proof. (A19) A Worker has no executable artifact; a release is a Worker version id and the bundle SHA-256.

**Amendment text:** The live product gate uses Jetstream coverage and records evidence per Worker version id.

| Case | Disposition |
| --- | --- |
| `a11y_screens` | `web/tests/accessibility.spec.ts › no serious/critical axe violations on all routes` |
| `keyboard_journey` | `web/tests/accessibility.spec.ts › keyboard-only journey reaches sign-in, scrobble submit, window tabs, follow and sign-out with visible focus` (required wave amendment, W6-03) |
| `live_product` | `npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names` |

## Error code vocabulary

Recorded by W0-AMEND (a deferred Wave 0 review item). API.md fixes the envelope `{error: {code, message, requestId, fields?}}` and OpenAPI types `code` as a plain string; the codes themselves are fixed by `api/examples/error-*.json` and by `packages/core/src/errors.ts` (`ERROR_CODES`, `DEFAULT_STATUS`). For the kept routes, the TypeScript rebuild renames these codes of the frozen Rust oracle (`crates/server/src/http/*`). Statuses are unchanged.

| Rust oracle code | TypeScript code | Status |
| --- | --- | --- |
| `invalid_query`, `invalid_path` | `validation_failed` (`fields` names the parameter) | 422 |
| `body_too_large` | `payload_too_large` | 413 |
| `invalid_body` | `bad_request` | 400 |
| `upstream_unavailable` | `upstream_error` | 502 |
| `storage_not_ready`, `storage_unavailable` | `not_ready` | 503 |

`invalid_cursor`, `invalid_json`, `identity_mismatch`, `method_not_allowed`, `rate_limited` and `not_found` keep their names. `queue_full` (503) is new with N1. The OAuth, session, write and operation codes go with the routes ADR 0004 §9.3 drops. `scripts/validate_contracts.py` (`error_codes`) checks that every code in `api/examples` is defined in `errors.ts` and is served with its `DEFAULT_STATUS`.

## Leaves with no rule change

These leaves keep every rule and case unchanged; only the global implementation-location amendment applies. Their case targets are in the case map.

`M1.1.2`, `M1.1.3`, `M3.1.2`, `M3.1.3`, `M4.3.1`, `M4.3.3`, `M5.1.1`, `M5.1.2`, `M5.1.3`, `M5.2.2`, `M5.3.2`, `M5.4.1`, `M5.4.2`, `M7.3.2`.

## Dispositions for leaves with no rule change

The rule is unchanged for these leaves, but their cases still need TypeScript tests. Each disposition below comes from the case map.

| Case | Disposition |
| --- | --- |
| `M1.1.2/unicode_limits` | `packages/core/test/scrobble.test.ts › validation.json vectors match Rust verdicts and reasons` (The W0-03 description of validation.json lists the 256/257-scalar, 1,024-byte and trim-to-empty vectors.) |
| `M1.1.2/time_bounds` | `packages/core/test/scrobble.test.ts › now+300s accepted and now+301s rejected at 2026-01-15T12:00:00Z receipt`; also `packages/core/test/scrobble.test.ts › validation.json vectors match Rust verdicts and reasons` (The W0-03 description of validation.json lists the 1970 bounds vectors.) |
| `M1.1.2/optional_values` | `packages/core/test/scrobble.test.ts › duration 1 and 86400 accepted; 0, 86401 and 1.5 rejected; invalid MBID rejected; omitted album accepted` (required wave amendment, W1-01); also `packages/core/test/scrobble.test.ts › validation.json vectors match Rust verdicts and reasons` |
| `M1.1.3/follow_schema` | `packages/core/test/follow.test.ts › follow validation and self-follow rejection` |
| `M1.1.3/follow_rkey` | `packages/core/test/record-key.test.ts › followRkey equals follow_rkeys.json` |
| `M1.1.3/follow_time` | `packages/core/test/follow.test.ts › follow createdAt now+300s accepted and now+301s rejected at 2026-01-15T12:00:00Z receipt` (required wave amendment, W1-01) |
| `M3.1.2/history_exact_order` | `worker/test/read/history.test.ts › limit 2 pages [r07,r01],[r02,r03],[r04,r05],[r06] then nextCursor null` |
| `M3.1.2/visibility` | `worker/test/read/history.test.ts › r08 deleted never appears; lookup of r08 is 404` (A12: a pending record exists only in the SPA outbox, so the index never holds it.) |
| `M3.1.2/lookup_and_limits` | `worker/test/http/params.test.ts › limit 0, -1, 1.5, 101 → 422 fields.limit; default 20; stats default 10`; also `worker/test/read/history.test.ts › lookup of encoded r01 AT URI returns the exact Scrobble; unknown URI → 404` (required wave amendment, W3-01), `worker/test/read/history.test.ts › r08 deleted never appears; lookup of r08 is 404` |
| `M3.1.3/equal_timestamp` | `worker/test/read/history.test.ts › Alice history r07,r01,r02,r03,r04,r05,r06 (equal timestamps by URI desc)`; also `worker/test/acceptance/read-model-acceptance.test.ts › union of all pages equals hardcoded URI list with no duplicates` |
| `M3.1.3/between_pages` | `worker/test/read/cursor-http.test.ts › arrival above anchor absent until fresh traversal; deleted unreturned record disappears` |
| `M3.1.3/cursor_binding` | `packages/core/test/cursor.test.ts › one-bit tamper, wrong did/scope/viewer, version 2, malformed base64 → invalid_cursor` |
| `M4.3.1/global_order` | `worker/test/read/feed.test.ts › global feed r09,r10,r07,r01,r02,r03,r04,r05,r06` |
| `M4.3.1/feed_visibility` | `worker/test/write/apply-record.test.ts › invalid remote record is excluded with reason and not visible`; also `worker/test/acceptance/federation.test.ts › Carol r10 appears only through external ingestion with zero app write calls`, `worker/test/write/account-state.test.ts › deactivation hides profile/content/follow edge immediately and bumps generation` (A12: pending records never reach the index.) |
| `M4.3.1/feed_limits` | `worker/test/http/params.test.ts › invalid window/scope → 422 with field name`; also `worker/test/http/params.test.ts › limit 0, -1, 1.5, 101 → 422 fields.limit; default 20; stats default 10` |
| `M4.3.3/page_union` | `worker/test/acceptance/read-model-acceptance.test.ts › union of all pages equals hardcoded URI list with no duplicates` |
| `M4.3.3/arrival_boundary` | `worker/test/read/cursor-http.test.ts › arrival above anchor absent until fresh traversal; deleted unreturned record disappears` |
| `M4.3.3/external_delete_update` | `worker/test/read/cursor-http.test.ts › arrival above anchor absent until fresh traversal; deleted unreturned record disappears`; also `worker/test/read/cursor-http.test.ts › record whose listenedAt moves across the anchor between pages follows the documented moved-row rule` (required wave amendment, W3-01) |
| `M5.1.1/unicode_grouping` | `packages/core/test/music-key.test.ts › Björk / '  BJÖRK  ' / 'jóga' group together; Homogenic/' HOMOGENIC ' group together` |
| `M5.1.1/tuple_collision` | `packages/core/test/music-key.test.ts › artist a\|b with title c and artist a with title b\|c yield distinct track keys` (required wave amendment, W1-02); also `packages/core/test/music-key.test.ts › every music_keys.json vector equals the Rust key` |
| `M5.1.1/album_absence` | `packages/core/test/music-key.test.ts › missing album yields null album key`; also `worker/test/read/stats.test.ts › top tracks and top albums for every window equal TESTING.md exactly; r05 creates no album bucket`, `packages/core/test/scrobble.test.ts › validation.json vectors match Rust verdicts and reasons` |
| `M5.1.2/window_totals` | `worker/test/acceptance/read-model-acceptance.test.ts › statistics tables for all/7d/30d/365d equal TESTING.md exactly (totals, artists, tracks, albums)` |
| `M5.1.2/boundary_seconds` | `worker/test/read/stats-boundaries.test.ts › records at lower bound −1s/0s/+1s for 7d/30d/365d have exact membership`; also `worker/test/read/stats-boundaries.test.ts › record at asOf+300s excluded until asOf passes it` |
| `M5.1.2/ranking_ties` | `worker/test/read/stats.test.ts › 7d: 4/2/3; artists (björk,2),(radiohead,2); tracks Björk/Jóga:2, Radiohead/No Surprises:1, Radiohead/Weird Fishes:1`; also `worker/test/http/params.test.ts › invalid window/scope → 422 with field name`, `worker/test/http/params.test.ts › limit 0, -1, 1.5, 101 → 422 fields.limit; default 20; stats default 10` |
| `M5.1.3/delete_effect` | `worker/test/read/stats-cache.test.ts › delete r01 invalidates: all → 6 listens, Homogenic 1` |
| `M5.1.3/update_artist` | `worker/test/acceptance/mutations.test.ts › r03 artist→Björk → Björk 3, Kate Bush 2, Radiohead 2, total 7` |
| `M5.1.3/query_plan` | `worker/test/read/stats-plan.test.ts › EXPLAIN QUERY PLAN uses scrobbles_owner_time/scrobbles_stats; negative control without indexes shows SCAN` |
| `M5.2.2/unknown_empty` | `worker/test/read/profile.test.ts › unknown/inactive DID → 404 with zero identity transport calls`; also `worker/test/read/profile.test.ts › known recordless user → 200 with zero totals and empty history` (required wave amendment, W3-03) |
| `M5.2.2/backfill_state` | `worker/test/storage/status.test.ts › user with pending reactivation snapshot reports recovering` |
| `M5.2.2/inactive_state` | `worker/test/write/account-state.test.ts › deactivation hides profile/content/follow edge immediately and bumps generation` |
| `M5.3.2/external_duplicates` | `worker/test/read/follows.test.ts › deleting one duplicate keeps 2; deleting both returns 1` |
| `M5.3.2/public_lists` | `worker/test/read/profile.test.ts › Alice followers 0 following 1; Bob followers 1 following 0; Carol 0/0`; also `worker/test/acceptance/read-model-acceptance.test.ts › follower/following counts Alice 0/1, Bob 1/0, Carol 0/0` (A12: a pending follow exists only in the SPA outbox.) |
| `M5.3.2/list_pagination` | `worker/test/read/follows.test.ts › three edges with equal createdAt traverse completely at limit 1; tampered cursor → 400 invalid_cursor` (required wave amendment, W3-03) |
| `M5.4.1/fixture_integrity` | `packages/atproto/test/fixture-kit.test.ts › seedReadModels publishes r01–r10 with r08 deleted and the Alice→Bob follow` |
| `M5.4.1/manual_expectations` | `worker/test/acceptance/read-model-acceptance.test.ts › statistics tables for all/7d/30d/365d equal TESTING.md exactly (totals, artists, tracks, albums)` (Expectations stay hardcoded from TESTING.md; scripts/validate_plan.py remains the independent calculator.) |
| `M5.4.1/time_reproducibility` | `packages/core/test/scaffold.test.ts › fixedClock starts at 2026-01-15T12:00:00Z and advance/set are exact` |
| `M5.4.2/read_acceptance` | `worker/test/acceptance/read-model-acceptance.test.ts › statistics tables for all/7d/30d/365d equal TESTING.md exactly (totals, artists, tracks, albums)`; also `worker/test/acceptance/read-model-acceptance.test.ts › global feed r09,r10,r07,r01,r02,r03,r04,r05,r06 and Alice following r09 only` |
| `M5.4.2/social_acceptance` | `worker/test/acceptance/mutations.test.ts › remove Alice→Bob → following feed empty; global unchanged` |
| `M5.4.2/mutation_acceptance` | `worker/test/acceptance/mutations.test.ts › delete r01 → 6/6/3, Homogenic 1, history r07,r02,…`; also `worker/test/acceptance/mutations.test.ts › r03 artist→Björk → Björk 3, Kate Bush 2, Radiohead 2, total 7`, `worker/test/ingest/sweeps.test.ts › renamed handle verifies on the next identity sweep and resolves to the same DID with unchanged history` (required wave amendment, W4-03) |
| `M7.3.2/profile_stats` | `web/test/routes/profile.test.tsx › stats window switch fetches window and renders exact top lists` |
| `M7.3.2/handle_change` | `web/test/routes/profile.test.tsx › new verified handle for the same DID updates the display on the same /u/:did route` (required wave amendment, W3-06) |
| `M7.3.2/empty_states` | `web/test/routes/profile.test.tsx › recordless user, no-album stats and unknown DID 404 render explicit empty and not-found states` (required wave amendment, W3-06) |

## Required wave amendments

Some cases have no wave test whose title asserts their outcome. For each one, the owning package needs one more test in its `tests` list in [`docs/planning/workers-waves.json`](workers-waves.json), plus a new test file in its `files` list where one is named. W0-02 does not own workers-waves.json, so applying these additions is an owner action, like publishing the issue amendments. The case map refers to these test ids exactly as listed. `scripts/validate_case_map.py` accepts an id only if it is declared in workers-waves.json or listed here under its owning package. With `--check-tests` (enforced by W7-01) it fails until every addition below is declared in workers-waves.json and every referenced test file contains its test name. A case-map `note` is informational only, and the validator rejects a note that states an obligation.

**W0-01** (new files: `worker/test/config.test.ts`, `scripts/test/check-ts.test.ts`)

- `worker/test/config.test.ts › one-segment, uppercase and embedded-slash LEXICON_PREFIX values are rejected naming LEXICON_PREFIX; empty yields prefix null` — covers `M1.1.1/invalid_namespace`
- `worker/test/config.test.ts › http PUBLIC_ORIGIN and invalid LEXICON_PREFIX fail parseConfig naming each field without echoing any secret value` — covers `M1.4.1/invalid_config`
- `worker/test/storage/sql-conformance.test.ts › second plain INSERT of one scrobbles.uri fails with a constraint error and the row count stays one` — covers `M1.3.1/unique_record`
- `worker/test/storage/sql-conformance.test.ts › INSERT of a scrobble or follow whose users row is missing is rejected and leaves no row` — covers `M1.3.1/foreign_key`
- `worker/test/storage/migrate.test.ts › a migration whose second statement is invalid persists neither statement and keeps the previous schema version` — covers `M1.3.2/migration_rollback`, `M6.1.3/upgrade_failure`
- `worker/test/harness › rows written under one DO name are absent under another DO name and in another test file` — covers `M1.4.3/harness_isolation`
- `scripts/test/check-ts.test.ts › a misformatted file in a disposable copy fails the biome step and leaves the repository unchanged` — covers `M1.2.2/ci_format_failure`
- `scripts/test/check-ts.test.ts › an inverted assertion in a disposable copy makes check-ts.sh exit nonzero` — covers `M1.2.2/ci_assertion_failure`
- `scripts/test/check-ts.test.ts › a wrong API field type in a disposable copy fails tsc -b` — covers `M7.1.1/strict_type_failure`
- `scripts/test/check-ts.test.ts › npm ci, tsc -b and the web production build pass and leave package-lock.json unchanged` — covers `M7.1.1/web_build`

**W0-02**

- `python3 scripts/validate_contracts.py › route_inventory: exact MVP/API route and status matrices` — covers `M1.1.4/route_inventory`
- `scripts/test_validate_case_map.py › --check-tests reports a missing test file or name` — covers `M6.4.2/unrun_gate`

**W1-01**

- `packages/core/test/follow.test.ts › follow createdAt now+300s accepted and now+301s rejected at 2026-01-15T12:00:00Z receipt` — covers `M1.1.3/follow_time`
- `packages/core/test/scrobble.test.ts › duration 1 and 86400 accepted; 0, 86401 and 1.5 rejected; invalid MBID rejected; omitted album accepted` — covers `M1.1.2/optional_values`

**W1-02**

- `packages/core/test/music-key.test.ts › artist a|b with title c and artist a with title b|c yield distinct track keys` — covers `M5.1.1/tuple_collision`

**W1-05**

- `packages/atproto/test/fixture-kit.test.ts › a record signed by one fixture account fails verification under another account's key` — covers `M2.4.1/fixture_isolation`

**W1-07**

- `worker/test/http/health-meta.test.ts › ready 200 and meta indexing stale while the index reports the socket disconnected` — covers `M1.4.2/upstream_outage`, `M6.2.2/upstream_offline`
- `worker/test/http/limits.test.ts › 10,001 distinct IP keys keep BucketSet at its cap and expired buckets are evicted` — covers `M6.2.1/bounded_state`

**W1-09**

- `scripts/test/gen-config.test.ts › _headers marks /assets/* public, max-age=31536000, immutable and /index.html and /oauth/client-metadata.json no-cache` — covers `M6.1.1/asset_cache`

**W1-10**

- `web/test/api-client.test.ts › every api/examples response decodes and a changed field type is rejected` — covers `M7.1.2/contract_drift`

**W2-04**

- `worker/test/write/apply-record.test.ts › applying the same revision twice changes nothing and a newer revision replaces the payload with one listen` — covers `M1.3.3/record_revision`
- `worker/test/write/apply-record.test.ts › two records with identical track and listenedAt under different rkeys are two rows and two listens` — covers `M3.4.1/same_time_distinct`

**W2-06**

- `web/test/oauth/session.test.ts › signOut clears IndexedDB stores when revoke fails with 500` — covers `M2.3.3/revocation_outage`

**W2-07**

- `web/test/outbox/retry.test.ts › nonrecoverable PDS error fails the operation after exactly one request` — covers `M3.2.2/permanent_error`
- `web/test/outbox/delete.test.ts › delete behind an unsent or in-flight create runs after it and leaves no record on the fake PDS` — covers `M3.3.1/pending_create_delete`, `M3.3.2/create_in_flight`
- `web/test/outbox/recovery.test.ts › RecordNotFound on first and repeated delete completes the operation as success` — covers `M3.3.2/already_absent`
- `web/test/outbox/recovery.test.ts › crash after follow createRecord before local ack reconciles to one record at the deterministic rkey` — covers `M5.3.1/restart_follow`
- `web/test/outbox/follows.test.ts › unfollow with no matching record succeeds with zero deleteRecord calls` — covers `M5.3.1/unfollow_absent`

**W3-01**

- `worker/test/read/history.test.ts › lookup of encoded r01 AT URI returns the exact Scrobble; unknown URI → 404` — covers `M3.1.2/lookup_and_limits`
- `worker/test/read/cursor-http.test.ts › record whose listenedAt moves across the anchor between pages follows the documented moved-row rule` — covers `M4.3.3/external_delete_update`

**W3-03**

- `worker/test/read/profile.test.ts › known recordless user → 200 with zero totals and empty history` — covers `M5.2.2/unknown_empty`
- `worker/test/read/follows.test.ts › three edges with equal createdAt traverse completely at limit 1; tampered cursor → 400 invalid_cursor` — covers `M5.3.2/list_pagination`

**W3-04** (new files: `worker/test/ingest/identity-cache.test.ts`)

- `worker/test/ingest/identity-cache.test.ts › cached identity served at 299 s and refreshed at 301 s with the injected clock` — covers `M2.1.1/cache_expiry`
- `worker/test/ingest/verify-drain.test.ts › 100 hints for distinct URIs from interleaved alarm and RPC calls yield exactly 100 rows` — covers `M1.3.4/concurrent_writes`

**W3-06**

- `web/test/routes/feed.test.tsx › anonymous user selecting following sees a sign-in prompt and no scope=following request is sent` — covers `M7.3.1/anonymous_following`
- `web/test/routes/feed.test.tsx › page-2 503 keeps page 1, shows retry, and a successful retry appends page 2 once` — covers `M7.3.1/feed_failure`, `M7.4.2/browser_network`
- `web/test/routes/feed.test.tsx › loading, empty, error and stale states render labelled text and no spinner remains after an error` — covers `M7.1.3/state_components`, `M7.4.2/browser_network`
- `web/test/routes/profile.test.tsx › new verified handle for the same DID updates the display on the same /u/:did route` — covers `M7.3.2/handle_change`
- `web/test/routes/profile.test.tsx › recordless user, no-album stats and unknown DID 404 render explicit empty and not-found states` — covers `M7.3.2/empty_states`
- `web/test/routes/profile.test.tsx › follow button shows pending then confirmed, and a permanently failed unfollow shows failed without claiming removal` — covers `M7.3.3/follow_state`, `M7.3.3/unfollow_failure`
- `web/test/routes/profile.test.tsx › own profile has no follow control and an anonymous viewer gets a sign-in action` — covers `M7.3.3/self_and_auth`
- `web/test/routes/profile.test.tsx › delete control appears only on the signed-in owner's own records` — covers `M7.2.3/delete_owner`
- `web/test/routes/settings.test.tsx › disconnect confirmation states that public PDS records and the opt-out record remain and claims no erasure` — covers `M6.4.3/privacy_consistency`, `M7.2.3/disconnect_text`
- `web/test/routes/settings.test.tsx › export action downloads /api/v1/users/<did>/export as music-export.json` — covers `M7.2.3/export_download`
- `web/test/routes/scrobble.test.tsx › excluded or failed status shows the failure code, stops polling and never shows published success` — covers `M7.2.2/poll_terminal`
- `web/test/routes/shell.test.tsx › unknown route renders the not-found view` — covers `M7.1.3/route_deep_links`
- `web/test/routes/shell.test.tsx › signed-in shell shows the verified handle and DID and the authenticated navigation` — covers `M7.2.1/signin_success`
- `web/test/routes/shell.test.tsx › after sign-out the shell shows anonymous navigation and the settings route shows a sign-in prompt` — covers `M7.2.1/logout_ui`
- `web/test/routes/signin.test.tsx › cancelled authorization, expired callback and unknown handle show specific recovery text with retry and no code or token in the DOM` — covers `M7.2.1/signin_failures`

**W4-03**

- `worker/test/ingest/sweeps.test.ts › renamed handle verifies on the next identity sweep and resolves to the same DID with unchanged history` — covers `M5.2.1/handle_rename`, `M5.4.2/mutation_acceptance`

**W4-04**

- `worker/test/ingest/notify.test.ts › 2,048-byte body reaches the parser and 2,049-byte body → 413 with no DB change` — covers `M6.2.1/body_boundary`

**W5-01** (new files: `worker/test/composition/logging.test.ts`)

- `worker/test/composition/logging.test.ts › captured logs and error bodies contain no CURSOR_KEY, ADMIN_TOKEN or bearer marker and logs contain no track-title marker` — covers `M6.2.2/metrics_auth`, `M6.2.2/log_redaction`
- `worker/test/composition/routing.test.ts › forced storage error → 500 envelope with UUID requestId and no stack trace or file path` — covers `M1.4.2/safe_errors`

**W6-01**

- `worker/test/acceptance/federation.test.ts › duplicate events, socket drop and expired cursor converge to the exact URI/CID/payload set with no double-counted stats` — covers `M4.4.2/convergence`

**W6-02**

- `worker/test/bench/read-models.bench.test.ts › seeded generator yields exactly 100,000 valid active rows with the documented per-user distribution` — covers `M6.2.3/benchmark_dataset`
- `worker/test/bench/read-models.bench.test.ts › 600 measured requests with zero errors report p95 and check it against the target` — covers `M6.2.3/benchmark_results`

**W6-03**

- `web/tests/mvp.spec.ts › GET /u/<did> and /feed serve index.html 200 and POST /feed never returns SPA HTML` — covers `M6.1.1/spa_deep_link`, `M7.1.3/route_deep_links`, `M7.4.1/asset_links`
- `web/tests/mvp.spec.ts › non-navigation GET /assets/missing.js and encoded ../ traversal return 404, never index.html` — covers `M6.1.1/asset_missing_traversal`
- `web/tests/mvp.spec.ts › hashed /assets/*.js returns 200 with a JavaScript content type and immutable Cache-Control` — covers `M6.1.1/asset_cache`, `M7.4.1/asset_links`
- `web/tests/accessibility.spec.ts › Tab and Enter reach every navigation destination with visible focus` — covers `M7.1.3/keyboard_shell`
- `web/tests/accessibility.spec.ts › keyboard-only journey reaches sign-in, scrobble submit, window tabs, follow and sign-out with visible focus` — covers `M7.4.3/keyboard_journey`

**W6-04** (new files: `scripts/test/secret-scan.test.ts`)

- `bash scripts/deploy.sh --dry-run › valid owned prefix and CURSOR_KEY run gen-config, the web build and wrangler deploy --dry-run with exit 0` — covers `M6.1.3/fresh_install`
- `scripts/test/secret-scan.test.ts › worker/.dev.vars.example, .env.example and docs contain no credential-shaped values` — covers `M6.1.3/secret_example_scan`

## Status writer contract (W2-05)

**Demonstrated gap:** W2-05's `indexing()` derives `stale` from `ingest_checkpoint.updated_at_ms` (the 1→0 disconnect instant), `lagSeconds` from `last_event_time_us` (the newest event of the most recent connection) and the global `lastIndexedAt` from the `indexing_status('global').last_indexed_at` high-water mark. Review of W2-05 found that no production module was required to maintain them: the W2-04 branch set only `users.indexed_at`, so the global `lastIndexedAt` would stay null, and W4-02 was told to write `ingest_checkpoint` fields directly, which would let an event or a host rotation move the 5-minute stale instant.

**Amendment text:** `worker/src/do/status.ts` owns every write of `ingest_checkpoint`, of `indexing_status` values and of `users.indexed_at`. W2-04 calls `noteIndexed` wherever it stamps `indexed_at`; W3-04's checkpoint advance calls `recordEvent`; W4-01's gap bookkeeping calls `updateCheckpointBookkeeping`; W4-02 calls `markConnected`, `recordEvent`, `markDisconnected` and `updateCheckpointBookkeeping`; W5-01's constructor calls `markDisconnected`. These obligations and one named test per package are declared in [`workers-waves.json`](workers-waves.json), W2-05 is a dependency of W2-04, W3-04, W4-01 and W4-02, and the end-to-end check is W5-01's `worker/test/composition/index-do.test.ts › status truth through production writers: …` test. `worker/test/storage/status.test.ts › source guard: …` fails CI as soon as another `worker/src` module writes these columns directly, or projection rows are inserted while no module calls `noteIndexed`. No case-map disposition changes.
