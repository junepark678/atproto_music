# Issue amendments for the local Node host (ADR 0005)

Status: **draft, not published.** N0-02 wrote these texts from [ADR 0005 §16](../adr/0005-local-node-host-and-compat-apis.md#16-amendments-b-series), as MVP.md "Completion and execution rules" requires: a library or rule change needs an issue amendment that explains the demonstrated gap. Publishing them to the GitHub issues is an owner action; nothing here claims an issue was edited or closed.

The format follows [AMENDMENTS-workers.md](AMENDMENTS-workers.md), which stays in force for everything ADR 0005 §2 keeps. Each `### B<n>` section is one B-series amendment: what it amends, the demonstrated gap, and the amendment text. Each `### <leaf key>` section under [Leaf amendments](#leaf-amendments) gives the new disposition of the leaf's cases that cited a superseded ADR 0004 amendment. [`scripts/validate_case_map.py`](../../scripts/validate_case_map.py) reads this file:

- it rejects every case-map retirement that cites an id listed under [Superseded ADR 0004 amendments](#superseded-adr-0004-amendments), reporting the case and the superseding B id;
- it accepts `retired:B<n>` only when the `### B<n>` section below names the case (as `` `<leaf>/<case>` ``).

Amendment ids: B1–B20 are ADR 0005 §16. A1–A20, N1–N4 and D keep their ADR 0004 meaning in AMENDMENTS-workers.md.

## Superseded ADR 0004 amendments

ADR 0005 supersedes these ADR 0004 ids. A retirement that cites one is stale: its reason is no longer true on the Node host, so the case is mapped to a test of the package that implements it, or retired under a B amendment that names it (B19). This table is machine-readable: one row per superseded id.

| ADR 0004 id | Superseded by | What changed |
| --- | --- | --- |
| `A1` | `B1` | Deployment: one Node 26 process under a systemd user unit on 127.2.0.1:8888, not a Worker plus a Durable Object |
| `A2` | `B2` | Role: the server is also the write client |
| `A3` | `B3` | OAuth: one confidential client (BFF) at the same client_id, not the browser public client |
| `A4` | `B4` | Libraries: the Node additions and the Workers removals |
| `A5` | `B5` | SSRF: DNS-pinned connections restored; policyFetch for every non-SafeFetch request |
| `A11` | `B6` | Idempotency: the server Idempotency-Key is restored beside the TID and digest |
| `A12` | `B7` | Outbox: the outbox runs on the server, without a browser |
| `A15` | `B8` | Backup: in-process online backups and a merge-forward restore |
| `A16` | `B9` | Metrics: journald JSON lines, counters and the admin socket |
| `A18` | `B10` | Harness: the Node harness replaces workerd |
| `A19` | `B11` | Release: git sha plus the Node bundle SHA-256 |
| `D` | `B16` | The ADR 0004 §9.3 dropped list, as far as B16 restores it (sessions, CSRF and Origin rules, server OAuth state, encrypted token storage, the SIGTERM drain, the trusted-proxy rule) |

## B-series amendments

### B1 Deployment (amends A1)

**Demonstrated gap:** the owner excluded the Workers Paid plan (ADR 0005 D1), and the Free plan cannot host what D2 and D3 add: a BFF with encrypted sessions, DPoP signing on every write, Last.fm MD5 signatures, ZIP imports, a resident Jetstream socket and multi-day jobs, under a 10 ms CPU and 50-subrequest limit.

**Amendment text:** The product is one Node 26 process, `node --enable-source-maps worker/dist/node/main.mjs`, run as the systemd user unit `atmusic.service` and listening on `127.2.0.1:8888` (loopback only), with one SQLite file on local disk (`node:sqlite`, WAL, `synchronous=FULL`, `locking_mode=EXCLUSIVE`). Secrets arrive as one systemd credential. The public origin stays `https://music.214510.xyz`, and how traffic reaches the port (tunnel or reverse proxy) is the owner's choice. There is a single instance; a second process on the same database exits 75. Multi-writer operation stays deferred.

### B2 Role (amends A2)

**Demonstrated gap:** scrobbler apps (Pano, multi-scrobbler, Web Scrobbler, Navidrome, Jellyfin, Music Assistant) send listens to our server, not to a browser tab, so the server must be able to write to the user's PDS (ADR 0005 D3).

**Amendment text:** The server is the AppView, the indexer **and the write client**: it writes `<p>.scrobble`, `<p>.follow`, `<p>.settings` and `<p>.love` records for signed-in users, from the web UI and from the Last.fm and ListenBrainz protocols. Indexing still happens only after a signed proof; a record the server wrote is indexed like any other.

### B3 OAuth (amends A3 and ADR 0002)

**Demonstrated gap:** one client_id cannot be both public and confidential: the reference authorization server rejects a token request whose authentication method differs from the fetched metadata (`oauth-provider.js:376-380`). Scrobbler protocols need the server to hold the write session.

**Amendment text:** One confidential client at the unchanged client_id `https://<origin>/oauth/client-metadata.json`, served dynamically: `token_endpoint_auth_method: private_key_jwt` with ES256, `jwks_uri` `https://<origin>/oauth/jwks.json`, DPoP-bound tokens, and the server callback `/oauth/callback`. The library is `@atproto/oauth-client-node` 0.5.10 with our identity resolver and `policyFetch`. OAuth states (600 s, single use) and sessions are sealed with AES-256-GCM at rest, keyed by HKDF and bound by AAD to their row. Browser sessions are `__Host-atmusic_session` cookies of 30 days with renewal, stored only as SHA-256, and every unsafe cookie route checks exactly one `Origin` plus the HMAC `X-CSRF-Token`. The browser never talks to a PDS.

### B4 Libraries (amends A4)

**Demonstrated gap:** the Node host needs a WebSocket client that exposes the handshake status, a pinned-address HTTP agent, a streaming unzip and a bundler; the browser OAuth client, `wrangler` and the `@cloudflare/*` test pool have no use once the Workers runtime is retired.

**Amendment text:** The workspace adds `@atproto/oauth-client-node` 0.5.10, `ws` 8.22.0, `undici` 8.12.2 (equal to Node's bundled copy), `fflate` and `esbuild` 0.28.2, each pinned exactly. `@atproto/oauth-client-browser` is removed by N5-01, and `wrangler` and `@cloudflare/*` by N7-01. Every dependency stays pinned exactly, only the owning package regenerates `package-lock.json`, and CI runs `npm ci`. Layering is npm workspaces with no barrel files; `@atmusic/core` stays pure.

Retired cases (true on Node):

- `M1.2.1/locked_build`: the npm workspace pins every dependency exactly, only the owning package regenerates package-lock.json, and CI runs npm ci. The Rust locked-build check applies only to the frozen oracle.
- `M1.2.1/dependency_direction`: crate layering is replaced by npm workspaces with no barrel files, and @atmusic/core stays pure.

`M1.2.1/sqlite_tls_features`, which A4 also retired, is restored: the Node runtime has its own SQLite and OpenSSL, and N0-01 checks them.

### B5 SSRF (amends A5)

**Demonstrated gap:** on Node a bad fetch can reach the owner's LAN, `127.x` and our own listener, and the A5 residual (a DNS-rebinding race between the DoH pre-check and the connection) is real again.

**Amendment text:** Every production transport uses an undici `Agent` whose `connect.lookup` applies `isAllowedAddress` to every returned address and connects only to the checked one, with an explicit `rejectUnauthorized: true`. SafeFetch (GET reads) is unchanged and keeps its DoH pre-check. Every other request (OAuth, PDS writes, Last.fm, ListenBrainz, imports) goes through `policyFetch`, with the same URL policy, `redirect: 'manual'`, a 10 s deadline and body caps, and network failures are `TransportError`. `run()` replaces `globalThis.fetch` with a throwing stub, so no outbound path can fall back to the unpinned global `fetch`.

### B6 Idempotency (amends A11)

**Demonstrated gap:** with server writes, a client that retries `POST /api/v1/scrobbles` after a lost response needs the server to recognise the retry; the A11 rule assumed the SPA allocated the record key itself.

**Amendment text:** `POST /api/v1/scrobbles` requires `Idempotency-Key` (1–128 characters from `[A-Za-z0-9._~-]`, scoped per DID): missing is 400 `idempotency_key_required`, malformed is 400 `invalid_idempotency_key`, the same key with the same request hash returns the same operation, and the same key with another hash is 409 `idempotency_conflict`. The TID is still allocated once and persisted with the canonical digest before the first attempt, and ambiguous creates are still reconciled by `getRecord` and a digest comparison; a record is never overwritten. Protocol ingress uses the listen key `sha256(did ‖ floor(timestamp) ‖ artist_key ‖ track_key)` instead.

### B7 Outbox (amends A12)

**Demonstrated gap:** scrobbles from protocol clients arrive with no browser open, so retries cannot depend on a tab.

**Amendment text:** The outbox runs on the server with the same semantics as A12: persist before the first attempt, `min(300 s, base + U[0, base/4])` backoff with a capped `Retry-After`, exactly 10 attempts, `swapRecord` deletes, predecessor ordering, and the crash barriers. It adds origins and priorities (live before import), `applyWrites` batching with bisection, the per-DID PDS point budget, the `cancelled` state for unsent operations, and `blocked` operations that wait for re-authentication without counting attempts. After each success the record's hint is queued with `enqueueHints`, so indexing stays proof-gated.

### B8 Backup (amends A15)

**Demonstrated gap:** the database now holds non-derived state (accounts, sessions, credential hashes, operations, listen keys, imports, forward queue) that no public repository can rebuild, so "derived data, no file backup" no longer holds; and a naive restore would resurrect revoked credentials.

**Amendment text:** Backups are in-process and online (`node:sqlite` `backup()`, incremental, with `PRAGMA integrity_check` on the copy in a worker thread), daily at 03:30 UTC and on demand, with 7 daily and 4 weekly copies; pre-migration and pre-restore copies are kept outside that retention. Every migration after 2 is additive and `schema_compat.min_compatible_version` lets the previous release run on a migrated database, so rollback is a link switch, never a restore. A restore stops `atmusic.socket` and `atmusic.service`, keeps every live non-derived table wholesale (only the derived tables come from the backup), and with `--accept-loss` (live database unreadable) deletes every web session and replays the out-of-database revocation journal. Backups refuse to run below the free-space floor.

### B9 Metrics (amends A16)

**Demonstrated gap:** Workers Logs and the TCP admin route do not exist on the Node host, and a tunnel cannot tell admin traffic from public traffic because every peer is loopback.

**Amendment text:** Logs are journald JSON lines with priority prefixes; request logs carry method, route pattern, status, duration and request id, and never a query string or body. `counters` stays. Status and admin actions are served only on the unix socket `$XDG_RUNTIME_DIR/atmusic/admin.sock` (directory 0700, socket 0600), whose status adds backup age, Jetstream lag, queue depths, import progress, link failures and disk use.

### B10 Harness (amends A18 and TESTING.md)

**Demonstrated gap:** workerd, `@cloudflare/vitest-plugin`, Durable Object eviction and `runDurableObjectAlarm` disappear with the Workers runtime; the Node host has a real process, files and timers that tests must control without waiting for production durations.

**Amendment text:** Every vitest project runs under `environment: 'node'`. Each test file gets its own temporary database file; a restart closes and reopens the same file (TESTING.md's original "restart reopens same storage"); alarms are stepped with `core.runAlarmNow()` after advancing the injected clock. Busy timeout, drain window and alarm delays are injected, so no test waits for a production duration; process-level tests spawn the built `worker/dist/node/main.mjs` from `scripts/test/` with explicit timeouts. Commands are unchanged: `npm test`, `npm run test:e2e`, `npm run check`.

TESTING.md harness wording, replacing the A18 sentences of "How every implementation leaf must report tests" and "Time, randomness, temporary resources":

> On the Node host every HTTP test validates the response with AJV against `api/openapi.yaml`, reads database state through the Node harness (`withIndex`, a temporary database file per test file), and asserts the fixture transport's remote-call counts. Every test file gets its own temporary database file; avoid shared fixed ports and external network in deterministic suites, and bind only ephemeral localhost ports between our own processes. Step timers with `core.runAlarmNow()` after advancing the injected clock. A restart closes the database and reopens the **same** file; the test byte-compares every projection table and the responses before and after, continues a cursor issued before the restart, and asserts that the timers resume. Fault injection exists only in test harnesses (`worker/test/**`, `packages/*/test-support`) and through injected interfaces.

**Retirement of `scripts/acceptance/workers-backend.sh` from the gate (ADR 0005 §2.2, §15.3).** From wave 0 on, `workers-backend.sh` is no longer run by any gate. It stays on disk until N7-01 deletes it. Its `--check-tests` step fails as soon as N0-02 maps the 39 un-retired cases to tests that later waves write, and its Playwright step drives the browser OAuth client that N5-01 removes. Until N8-01, each wave's gate is `npm run check` plus `scripts/acceptance/node-interim.sh --wave <n>`, which runs `check-ts`, the Python case-map regressions, `python3 scripts/validate_case_map.py --check-tests --node-wave <n>`, `scripts/check_goldens.sh` and the live no-env checks, and Playwright only from wave 6; every step it does not run yet is printed as `pending until wave <m>`. From wave 8, `scripts/acceptance/node-backend.sh` (N8-01) is the gate and runs the case map without `--node-wave`.

### B11 Release (amends A19)

**Demonstrated gap:** a Node release is the bundled `worker/dist/node/main.mjs` run by the system Node 26; there is no Worker version id and no product executable.

**Amendment text:** A release is the git sha plus the SHA-256 of `worker/dist/node/main.mjs`, which `scripts/check-node-bundle.ts` prints and evidence records carry; `main.mjs --version` prints the sha recorded at build time. Releases are git worktrees under `~/.local/lib/atmusic/releases/<sha>` behind an atomic `current` link.

Retired cases (true on Node):

- `M1.2.3/static_elf`: a release is a git sha plus the Node bundle SHA-256 run by the system Node 26; no product ELF executable exists to inspect for an interpreter.
- `M6.4.1/static_release`: there is no product executable; the release artifact is the JavaScript bundle.

`M1.2.3/packaged_shutdown` and `M6.4.1/tag_version`, which A19 or D also retired, are restored: the bundled process can be started, stopped with SIGTERM and asked for `--version` (N3-07).

### B12 Collections (amends M1.1.1)

**Demonstrated gap:** loved tracks (Last.fm `track.love`, `user.getLovedTracks`, ListenBrainz feedback) need a record type of their own.

**Amendment text:** Collections derived from a valid owned prefix are exactly `<p>.scrobble`, `<p>.follow`, `<p>.settings` and **`<p>.love`** (`lexicons/love.json`, key `tid`). Jetstream `wantedCollections` and `config.collections` gain `love` (N3-11); the snapshot key range `[<p>., <p>/)` covers it already.

### B13 Lexicons (amends ADR 0004 §9.1 lexicon rules)

**Demonstrated gap:** the Last.fm and ListenBrainz protocols carry fields (album artist, track number, MusicBrainz ids, ISRC, submitting client, music service) that the v1 scrobble record cannot hold.

**Amendment text:** `lexicons/scrobble.json` gains only optional fields: `albumArtist`, `trackNumber` (1–9999), `artistMbids` (at most 10 distinct UUIDs), `releaseMbid`, `releaseGroupMbid`, `isrc`, `submissionClient` and `musicService`. Its required fields stay exactly `artist`, `track`, `listenedAt` and `createdAt`, every v1 field keeps its limits, an invalid optional field is dropped (never fatal, never truncated), and canonical digests of records without the new fields are byte-identical to the goldens. `lexicons/love.json` is new: key `tid`, `artist`, `track` and `createdAt` required, `album` and `recordingMbid` optional, with the scrobble limits. From the freeze point (the first production record), changes are additive only, checked by `scripts/validate_contracts.py` against the copies kept in `lexicons/published/`.

### B14 API contract (amends API.md and M1.1.4)

**Demonstrated gap:** server writes, cookie sessions, credentials, links and imports need HTTP routes, which ADR 0004 §9.3 dropped.

**Amendment text:** Contract v1.2 (`info.version: 1.2.0`): every v1.1 route and payload is unchanged except the additive optional Scrobble fields; `GET /oauth/client-metadata.json` becomes the dynamic confidential-client document and `GET /oauth/jwks.json` is added. It adds the ADR 0005 §5.7 cookie routes, including `DELETE /api/v1/account/connection` and `GET /api/v1/account/ignored-listens`, and the link, import and credential routes; it restores `Operation` (with the `cancelled` state) and `Accepted`. `meta.capabilities` may add `writes`, `lastfm`, `listenbrainz`, `imports` and `forwarding`. API.md's sentence "no route reads a session" is narrowed to "no v1.1 read route reads a session". `/2.0/` and `/1/` are specified in ADR 0005 §7, §8 and `docs/compat/{lastfm,listenbrainz}.md`, not in OpenAPI.

### B15 Admin (amends A16 admin routes)

**Demonstrated gap:** on the Node host every TCP peer is a loopback proxy, so a bearer-token admin route on the public listener cannot be told apart from public traffic.

**Amendment text:** Admin routes are served only on the unix socket; `/internal/` on TCP is always the JSON 404. The Workers TCP admin route and `ADMIN_TOKEN` stay only for the Workers entry and its workerd suite until N4-03 ports that suite, and are retired with the Workers entry (N7-01).

### B16 The ADR 0004 §9.3 dropped list (amends D)

**Demonstrated gap:** D followed from the browser public client (no server session, no server write path) and from the Workers runtime (no process of ours). ADR 0005 restores the server session, server writes and a process.

**Amendment text:** Restored: session cookies, CSRF and the Origin rules, the private-operation and cross-owner rules for owner routes, server OAuth state (600 s, single use), encrypted token storage, the SIGTERM drain (M1.4.3) and the trusted-proxy client-IP rule. Still dropped: v1.0's `GET /api/v1/account/export` and `DELETE /api/v1/account/local-data` (A9 and A10 stay), and the musl artifact.

### B17 Pulse mode and plan tiers (amends ADR 0004 §5.5 and Q4)

**Demonstrated gap:** `pulse` mode existed only for the Workers Free plan's limits.

**Amendment text:** `INGEST_MODE` is `socket` (default) or `off`; `pulse` is refused with a message citing ADR 0005. N7-01 removes `pulse`, `PLAN`, `DO_LOCATION_HINT` and `BUDGETS.free`; until then the Node config passes `PLAN='paid'` and `DO_LOCATION_HINT=''` to the embedded `parseConfig` and refuses any operator-set value.

### B18 Meta (amends A20)

**Demonstrated gap:** the Node composition has capabilities the Workers composition did not.

**Amendment text:** `meta.stage` reflects the Node composition, and `meta.capabilities` follow B14: `read`, `stats`, `follows`, `notify`, `indexing`, `publication` (owned prefix only), plus `writes`, `lastfm`, `listenbrainz`, `imports` and `forwarding` when initialized.

### B19 Case map (amends ADR 0004 §10.4)

**Demonstrated gap:** 43 case-map retirements cited amendments that ADR 0005 supersedes (26 under A1, A3, A11, A12, A15 and A19, 14 under D, 3 under A4); their reasons are no longer true.

**Amendment text:** A retirement citing an amendment superseded by ADR 0005 (A1, A2, A3, A4, A5, A11, A12, A15, A16, A18, A19, or D where B16 restores the item) is invalid. `retired:B<n>` is allowed when the `### B<n>` section of this file names the case. `scripts/validate_case_map.py` accepts test ids declared in `docs/planning/node-waves.json` as well as `workers-waves.json`; with `--check-tests --node-wave <n>`, a target declared by a node-waves package of a later wave is reported `pending (wave <m>, <package>)` and does not fail, while every other target must exist with its title; without `--node-wave` every target must exist. Of the 43 cases, 39 are mapped to the named tests listed in ADR 0005 §20.2, and 4 stay retired under B4 or B11 ([Leaf amendments](#leaf-amendments)).

### B20 Sign-in (new)

**Demonstrated gap:** every signed-in account holds credentials, upload quota and a share of the owner's home machine and Last.fm key; open registration would let anyone use them.

**Amendment text:** Sign-in is restricted to `ATMUSIC_SIGNIN_DIDS` unless `ATMUSIC_SIGNIN_POLICY=open`, and the policy is reconciled at startup and on every 10-minute expiry sweep: a removed DID loses its OAuth session, web sessions and protocol credentials, its links are revoked and its operations blocked. OAuth sessions are kept alive only while the DID is in use (a live web session, a protocol credential used within 90 days, an active link, pending operations or an unfinished import). Users can disconnect with `DELETE /api/v1/account/connection`. The OAuth callback is protected against login CSRF by the `__Host-atmusic_oauth` cookie bound to the state.

## Leaf amendments

Each section lists the cases of one leaf whose ADR 0004 retirement cited a superseded amendment, with their disposition in [`docs/verification/ts-case-map.json`](../verification/ts-case-map.json). A mapped case names its target test and the node-waves package that declares it; with `--check-tests --node-wave <n>` a target of a later wave is pending until that wave.

### M1.1.4 Freeze OpenAPI v1 schemas and endpoint status matrices

**Amendment ids:** B16

| Case | Was | Disposition |
| --- | --- | --- |
| `required_auth` | `retired:D` (superseded by B16) | `worker/test/node/http/writes.test.ts › no cookie is 401, missing CSRF is 403 csrf_failed, invalid fields are 422 with the v1.0 ScrobbleInput field names, a closed publication gate is 503 publication_disabled` (N3-02, wave 3) |

### M1.2.1 Pin the Rust workspace, dependencies, and crate boundaries

**Amendment ids:** B4

| Case | Was | Disposition |
| --- | --- | --- |
| `sqlite_tls_features` | `retired:A4` (superseded by B4) | `worker/test/node/scaffold.test.ts › process.versions.sqlite is 3.45 or newer with WAL, STRICT tables and JSON functions working, and process.versions.openssl is present for TLS` (N0-01, wave 0) |
| `locked_build` | `retired:A4` (superseded by B4) | `retired:B4`: the npm workspace pins every dependency exactly, only the owning package regenerates package-lock.json, and CI runs npm ci. |
| `dependency_direction` | `retired:A4` (superseded by B4) | `retired:B4`: crate layering is replaced by npm workspaces with no barrel files; @atmusic/core stays pure. |

### M1.2.3 Build and smoke-test a self-contained musl artifact

**Amendment ids:** B11, B16

| Case | Was | Disposition |
| --- | --- | --- |
| `packaged_shutdown` | `retired:D` (superseded by B16) | `scripts/test/build-server.test.ts › the bundled main.mjs started with --init on a temporary state directory answers /health/ready, then on SIGTERM sends STOPPING=1 and exits 0 within 30 s` (N3-07, wave 3) |
| `static_elf` | `retired:A19` (superseded by B11) | `retired:B11`: a release is a git sha plus the Node bundle SHA-256 run by the system Node 26; no product ELF executable exists to inspect for an interpreter. |

### M1.3.1 Define SQLite schema and invariant constraints

**Amendment ids:** B6

| Case | Was | Disposition |
| --- | --- | --- |
| `idempotency_scope` | `retired:A11` (superseded by B6) | `worker/test/node/http/writes.test.ts › the same Idempotency-Key from two DIDs creates two operations` (N3-02, wave 3) |

### M1.3.3 Implement typed repository operations and transactions

**Amendment ids:** B7

| Case | Was | Disposition |
| --- | --- | --- |
| `owner_private_read` | `retired:A12` (superseded by B7) | `worker/test/node/http/writes.test.ts › GET /api/v1/operations/{id} is 200 for its owner and 404 for any other session` (N3-02, wave 3) |

### M1.3.4 Serialize writes and bound database contention

**Amendment ids:** B1

| Case | Was | Disposition |
| --- | --- | --- |
| `locked_database` | `retired:A1` (superseded by B1) | `scripts/test/build-server.test.ts › a second main.mjs on the same database exits 75 database_locked after the production busy timeout even with a different ATMUSIC_ADMIN_SOCKET, and a stale socket file is replaced` (N3-07, wave 3) |

### M1.4.1 Implement typed environment configuration and migrate CLI

**Amendment ids:** B1

| Case | Was | Disposition |
| --- | --- | --- |
| `bind_precedence` | `retired:A1` (superseded by B1) | `worker/test/node/run.test.ts › an inherited LISTEN_FDS socket wins over ATMUSIC_LISTEN, which wins over the 127.2.0.1:8888 default` (N3-07, wave 3) |

### M1.4.3 Add server harness and bounded shutdown

**Amendment ids:** B16

| Case | Was | Disposition |
| --- | --- | --- |
| `drain_timeout` | `retired:D` (superseded by B16) | `worker/test/node/shutdown.test.ts › a request still running when the injected drain window ends after SIGTERM is aborted, the database is closed and exit(0) is called; the production drain window is 25 s` (N3-07, wave 3) |

### M2.1.3 Discover PDS and OAuth issuer metadata

**Amendment ids:** B3

| Case | Was | Disposition |
| --- | --- | --- |
| `issuer_mismatch` | `retired:A3` (superseded by B3) | `worker/test/node/bff/oauth-client.test.ts › a callback whose sub resolves to a PDS with a different authorization server is rejected and the token is revoked` (N2-03, wave 2) |
| `unsupported_server` | `retired:A3` (superseded by B3) | `worker/test/node/bff/oauth-client.test.ts › authorize refuses an authorization server whose metadata lacks PAR or S256 PKCE and stores no state` (N2-03, wave 2) |

### M2.2.2 Implement auth start, PKCE, state, and PAR

**Amendment ids:** B3, B16

| Case | Was | Disposition |
| --- | --- | --- |
| `par_pkce` | `retired:A3` (superseded by B3) | `worker/test/node/bff/oauth-client.test.ts › authorize sends PAR with an S256 code_challenge and a private_key_jwt assertion; the verifier and DPoP key exist only sealed in oauth_states` (N2-03, wave 2) |
| `par_failure` | `retired:A3` (superseded by B3) | `worker/test/node/bff/oauth-client.test.ts › a PAR error from the fake AS leaves no oauth_states row and surfaces oauth_upstream` (N2-03, wave 2) |
| `wrong_origin` | `retired:D` (superseded by B16) | `worker/test/node/http/auth.test.ts › POST /api/v1/auth/start with a foreign or duplicate Origin is 403 csrf_failed and stores no state; a valid start sets __Host-atmusic_oauth with HttpOnly, Secure, SameSite=Lax, Path=/ and Max-Age=600` (N3-01, wave 3) |

### M2.2.3 Implement callback verification and DPoP nonce retry

**Amendment ids:** B3, B16

| Case | Was | Disposition |
| --- | --- | --- |
| `issuer_subject` | `retired:A3` (superseded by B3) | `worker/test/node/bff/oauth-client.test.ts › a token response whose iss differs from the authorize issuer or whose sub differs from the handle-resolved DID stores no session` (N2-03, wave 2) |
| `nonce_retry` | `retired:A3` (superseded by B3) | `worker/test/node/bff/oauth-client.test.ts › a use_dpop_nonce error on the token request and on a PDS write is retried once with the new nonce and succeeds` (N2-03, wave 2) |
| `expired_and_replay` | `retired:D` (superseded by B16) | `worker/test/node/bff/oauth-client.test.ts › a replayed state and a state older than 600 s both fail and store no session` (N2-03, wave 2) |

### M2.3.1 Encrypt OAuth material and serialize token refresh

**Amendment ids:** B3, B16

| Case | Was | Disposition |
| --- | --- | --- |
| `refresh_race` | `retired:A3` (superseded by B3) | `worker/test/node/bff/oauth-client.test.ts › two concurrent restore() calls on an expired session send one refresh request and both use the new token` (N2-03, wave 2) |
| `encrypted_persistence` | `retired:D` (superseded by B16) | `worker/test/node/bff/oauth-stores.test.ts › the raw database file contains no access token, refresh token or DPoP private key bytes after a sign-in` (N2-03, wave 2) |

### M2.3.2 Issue hashed sessions and enforce CSRF

**Amendment ids:** B16

| Case | Was | Disposition |
| --- | --- | --- |
| `cookie_and_hash` | `retired:D` (superseded by B16) | `worker/test/node/bff/sessions.test.ts › create() sets __Host-atmusic_session with HttpOnly, Secure, SameSite=Lax, Path=/ and Max-Age=2592000, and stores only SHA-256 of the token` (N2-04, wave 2) |
| `csrf_matrix` | `retired:D` (superseded by B16) | `worker/test/node/bff/csrf.test.ts › the Rust matrix: no cookie 401; missing, duplicate or foreign Origin, missing or wrong X-CSRF-Token 403 csrf_failed; correct pair passes` (N2-04, wave 2) |

### M2.3.3 Implement logout and upstream revocation behavior

**Amendment ids:** B3

| Case | Was | Disposition |
| --- | --- | --- |
| `unsupported_revocation` | `retired:A3` (superseded by B3) | `worker/test/node/bff/oauth-client.test.ts › revoke against an AS without a revocation_endpoint deletes the local session and sends no request` (N2-03, wave 2) |

### M2.4.2 Add OAuth/session negative integration matrix

**Amendment ids:** B3, B16

| Case | Was | Disposition |
| --- | --- | --- |
| `refresh_persistence` | `retired:A3` (superseded by B3) | `worker/test/node/bff/oauth-stores.test.ts › a rotated refresh token is persisted sealed before use, and after close and reopen the next refresh sends the rotated token` (N2-03, wave 2) |
| `security_matrix` | `retired:D` (superseded by B16) | `worker/test/node/http/auth.test.ts › a callback with a replayed, expired or unknown state, or an AS error, stores no session, sets no session cookie and clears __Host-atmusic_oauth` (N3-01, wave 3) |
| `cross_owner` | `retired:D` (superseded by B16) | `worker/test/node/http/writes.test.ts › GET /api/v1/operations/{id} is 200 for its owner and 404 for any other session` (N3-02, wave 3) |

### M3.1.1 Implement authenticated scrobble input and idempotency admission

**Amendment ids:** B6

| Case | Was | Disposition |
| --- | --- | --- |
| `key_validation` | `retired:A11` (superseded by B6) | `worker/test/node/http/writes.test.ts › an Idempotency-Key of 129 characters or containing a character outside [A-Za-z0-9._~-] is 400 invalid_idempotency_key` (N3-02, wave 3) |

### M3.2.1 Persist outbox state and expose owner-bound operation status

**Amendment ids:** B7

| Case | Was | Disposition |
| --- | --- | --- |
| `admission_atomic` | `retired:A12` (superseded by B7) | `worker/test/node/outbox/ingress.test.ts › a throw after the operation insert rolls back the listen key and forward rows` (N2-05, wave 2) |

### M3.2.3 Reconcile ambiguous creates and prevent duplicates after crashes

**Amendment ids:** B6

| Case | Was | Disposition |
| --- | --- | --- |
| `five_retries` | `retired:A11` (superseded by B6) | `worker/test/node/http/writes.test.ts › five identical POSTs with one Idempotency-Key, two of them after the operation succeeded, return one operation and the fake PDS holds one record` (N3-02, wave 3) |

### M3.3.1 Authorize deletion and atomically mark tombstones

**Amendment ids:** B16

| Case | Was | Disposition |
| --- | --- | --- |
| `wrong_owner` | `retired:D` (superseded by B16) | `worker/test/node/http/writes.test.ts › DELETE /api/v1/scrobbles/{id} of another DID's record is 404 and of an own record is 202 scrobble.delete` (N3-02, wave 3) |

### M3.4.3 Record live external-PDS scrobble lifecycle evidence

**Amendment ids:** B6

| Case | Was | Disposition |
| --- | --- | --- |
| `live_retries` | `retired:A11` (superseded by B6) | `scripts/e2e/scrobbler-e2e.ts › five replays of one POST /api/v1/scrobbles with the same Idempotency-Key against the e2e bundle produce one operation and one PDS record` (N8-01, wave 8) |

### M5.2.3 Assert public profile privacy and caching rules

**Amendment ids:** B3, B16

| Case | Was | Disposition |
| --- | --- | --- |
| `sensitive_fields` | `retired:A3` (superseded by B3) | `worker/test/node/journey/secret-logs.test.ts › with sessions, sk values, app passwords, ListenBrainz tokens and linked credentials seeded, no public /api/v1, /2.0 or /1 response body in the journeys contains any of those values` (N4-01, wave 4) |
| `owner_equality` | `retired:D` (superseded by B16) | `worker/test/node/http/writes.test.ts › public v1.1 read responses are byte-identical with and without the owner's session cookie` (N3-02, wave 3) |

### M6.1.2 Validate public-origin and trusted-proxy deployment settings

**Amendment ids:** B16

| Case | Was | Disposition |
| --- | --- | --- |
| `trusted_proxy` | `retired:D` (superseded by B16) | `worker/test/node/client-ip.test.ts › CF-Connecting-IP is honoured only in cf-connecting-ip mode and only from a peer in ATMUSIC_TRUSTED_PROXIES; otherwise the peer address is used` (N1-06, wave 1) |

### M6.3.1 Implement consistent SQLite backup and verified restore

**Amendment ids:** B8

| Case | Was | Disposition |
| --- | --- | --- |
| `backup_during_write` | `retired:A15` (superseded by B8) | `worker/test/node/backup.test.ts › while a rate-limited backup runs, 1,000 committed writes and an HTTP request are served and WATCHDOG=1 is still sent, and the copy is a consistent snapshot that passes integrity_check` (N3-07, wave 3) |
| `restore_state` | `retired:A15` (superseded by B8) | `scripts/test/restore.test.ts › a restored database whose OAuth sessions and linked credentials open with the configured keys reports ready` (N4-02, wave 4) |
| `wrong_key` | `retired:A15` (superseded by B8) | `scripts/test/restore.test.ts › restoring with secrets that lack the backup's encryption key id starts the server, marks undecryptable sessions reauth_required and prints no ciphertext or key material` (N4-02, wave 4) |

### M6.4.1 Create versioned static release pipeline with checksums

**Amendment ids:** B11

| Case | Was | Disposition |
| --- | --- | --- |
| `tag_version` | `retired:A19` (superseded by B11) | `` scripts/test/build-server.test.ts › build-server writes worker/dist/node/main.mjs, `node main.mjs --check-config` with a test config exits 0, and `node main.mjs --version` prints the git sha recorded at build time `` (N3-07, wave 3) |
| `static_release` | `retired:A19` (superseded by B11) | `retired:B11`: there is no product executable; the release artifact is the JavaScript bundle. |

### M7.1.2 Generate typed API client and session/CSRF state

**Amendment ids:** B16

| Case | Was | Disposition |
| --- | --- | --- |
| `csrf_client` | `retired:D` (superseded by B16) | `web/test/session/client.test.ts › getSession caches csrfToken; every mutation sends X-CSRF-Token with same-origin credentials; 401 shows signed-out and reauth_required shows the re-sign-in banner` (N5-01, wave 5) |

### M7.4.1 Build and embed production SPA in release executable

**Amendment ids:** B1

| Case | Was | Disposition |
| --- | --- | --- |
| `embedded_dist` | `retired:A1` (superseded by B1) | `worker/test/node/compose.test.ts › the SPA and its assets are served from ATMUSIC_ASSETS_DIR (default <release>/web/dist) with the _headers rules` (N2-01, wave 2) |
| `missing_build` | `retired:A1` (superseded by B1) | `worker/test/node/run.test.ts › startup with an ATMUSIC_ASSETS_DIR lacking index.html exits 78 naming ATMUSIC_ASSETS_DIR and never listens` (N3-07, wave 3) |

## Package deviations

Places where a package's tree differs from its `files` entry in [node-waves.json](node-waves.json). Amending that entry is an owner action; until the owner does, this section is the record of where the files are.

### N0-02 v1.2 contract fixtures live in api/examples/v1.2/

**Declared:** the N0-02 `files` entry names `api/examples/{operation,session,account,link,import-job,credentials}.json` and `api/examples/response-cases.json` for the v1.2 fixtures and response cases.

**Tree:** every v1.2 payload fixture and the v1.2 response-case inventory are in `api/examples/v1.2/` (44 files). `api/examples/response-cases.json` stays the frozen v1.1 inventory and is unchanged; `api/examples/scrobble-input.json` and `api/examples/schema-cases.json` are where the entry says.

| Declared path | Actual path |
| --- | --- |
| `api/examples/operation.json` | `api/examples/v1.2/operation.json` |
| `api/examples/session.json` | `api/examples/v1.2/session.json` |
| `api/examples/account.json` | `api/examples/v1.2/account.json` |
| `api/examples/link.json` | `api/examples/v1.2/link.json` |
| `api/examples/import-job.json` | `api/examples/v1.2/import-job.json` |
| `api/examples/credentials.json` | `api/examples/v1.2/credentials.json` |
| `api/examples/response-cases.json` (v1.2 cases) | `api/examples/v1.2/response-cases.json` |
| not declared | the other 37 `api/examples/v1.2/*.json` fixtures: `accepted`, the v1.2 `error-*` envelopes, the `*-input` request bodies, `client-metadata`, `jwks` and the remaining link, import, credential and account payloads |

**Why:** `web/test/api-client.test.ts › every api/examples response decodes and a changed field type is rejected` (W1-10, case `M7.1.2/contract_drift`; not owned by N0-02) globs `api/examples/*.json` without recursing. It requires that the set of top-level response fixtures equals the set that `api/examples/response-cases.json` references, and that every route in that file has an `ApiClient` method. So any v1.2 payload at the top level, or any v1.2 case in the top-level inventory, fails that test until N5-01 gives the SPA its v1.2 client. N0-02 verified this: with `api/examples/operation.json` added at the top level, the test fails with `operation` missing from the referenced fixtures. `scripts/validate_contracts.py` (`example_inventory`) enforces the layout: an example lives directly in `api/examples` (v1.1) or in `api/examples/v1.2` (v1.2, with component example names prefixed `v1.2-`), and every file in either directory is a declared, validated component example.

**Requested owner amendment:** in the N0-02 `files` entry, replace the six `api/examples/{operation,session,account,link,import-job,credentials}.json` paths with `api/examples/v1.2/`, and leave `api/examples/response-cases.json` declared, since it stays the v1.1 inventory. Any later package that reads N0-02's fixtures should cite `api/examples/v1.2/<name>.json`.

### N3-02 POST /api/v1/scrobbles declares 429 for the daily listen cap

**Declared:** the N3-02 `files` entry owns only the write, operation and account routes and their tests; `api/openapi.yaml` (N0-02) declared POST `/api/v1/scrobbles` with {202, 400, 401, 403, 409, 413, 422, 503}.

**Tree:** the web scrobble goes through the one live ingress (`acceptListens`, ADR 0005 §7.7), whose daily cap (`accounts.daily_listen_cap`, default 3,000 live listens per rolling 24 h across every ingress, §6.4 and Q16) also binds web listens, and ADR 0005 §5.7 and §5.8 define no web status for it. N3-02 amends the contract additively (v1.2): POST `/api/v1/scrobbles` gains 429 `rate_limited` with a required `Retry-After` (seconds until the oldest live listen of the window leaves it), bound to the `error-429` fixture in `api/examples/v1.2/response-cases.json`, with the status matrix and required error code in `scripts/validate_contracts.py` and the row in [API.md](API.md). Nothing is written on a 429 and the Idempotency-Key stays unbound. This mirrors the ListenBrainz 429 and Last.fm error 5 of §8.3 and §7.7.

**Requested owner amendment:** add `api/openapi.yaml`, `api/examples/v1.2/response-cases.json`, `scripts/validate_contracts.py` and `docs/planning/API.md` to this change's record, or fold the 429 into the N0-02 contract.
