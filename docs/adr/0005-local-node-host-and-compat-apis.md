
# ADR 0005: Local Node host, confidential BFF, Last.fm and ListenBrainz compatibility

- **Status:** Proposed 2026-10-25, then **Accepted with interim decisions** (§18) on 2026-10-25. The owner delegated the open calls ("you may do what you think best").
- **Branch:** `feat/mvp-complete`.
- **Supersedes:** the deployment, OAuth and write-path parts of [ADR 0004](0004-cloudflare-workers.md): §1, §4.1, §4.2, §5.1, §5.2, §5.5 (pulse mode), §8 (user credentials and SSRF rows), §11, §13 items 1, 2, 4 and 7, and amendments A1, A2, A3, A4 (partly), A5, A11, A12, A15, A16, A18 and A19. §2 says what is kept. It also amends ADR 0002 (OAuth) again; see §5.
- **Driving requirement (the owner's words):** "host it locally then, systemd user service, listening at 127.2.0.1:8888".
- **Decision in one sentence:** atmusic becomes **one Node 26 process** (a systemd user service bound to `127.2.0.1:8888`, with one SQLite file on local disk). It is a **confidential atproto OAuth client (BFF)** that writes to users' PDSs on their behalf. It serves the existing `/api/v1`, a **Last.fm 2.0-compatible API** at `/2.0/` and a **ListenBrainz-compatible API** at `/1/`, imports history from both services, and forwards new scrobbles to linked accounts. Indexing still happens only after a signed proof.

---

## 0. Binding owner decisions (2026-10-25) and what follows from them

| # | Decision | Consequence in this ADR |
|---|---|---|
| D1 | No Workers Paid plan; cost $0. Production runs locally on the owner's Gentoo machine (systemd 261, Node v26.12.1, node:sqlite with SQLite 3.54.1) as a **systemd user service on 127.2.0.1:8888**. The public origin stays `https://music.214510.xyz`, and the client_id URL and the lexicon prefix `dev.pythonplayer123.music` are unchanged. The owner chooses how traffic reaches the port; the Cloudflare Free plan may keep serving DNS and TLS. | §2: Node-only. §3: the Node adapter. §14: ops, with exposure options documented and none required. |
| D2 | Required APIs: Last.fm scrobble API, Last.fm read API, ListenBrainz submit API, ListenBrainz read API, `/api/v1` (v1.1) kept compatible, and import plus linking/forwarding for both services. | §7, §8, §10, §11, §12. `/api/v1` becomes v1.2, additive only (§16). |
| D3 | Scrobbler apps send to our server, so the server must hold each user's OAuth write session. One client_id cannot be both public and confidential. | §5: one confidential client; the browser writes through the server. |
| D4 | Minimal ops: one Node process, SQLite on local disk, no other services. Jetstream, timers, imports and forwarding run in-process. Backups must be simple. | §3, §11, §12, §14. |
| Rules | Signature, CID, MST and identity verification are never weakened. Tests are deterministic and never touch a real network; Last.fm, ListenBrainz and PDS are fakes. No real third-party API is ever contacted, apart from reading public documentation. No deploys, no Cloudflare or DNS changes. | §13, §15. |

---

## 1. Context

ADR 0004 is fully implemented: `packages/core`, `packages/atproto`, `worker/` (one Worker plus one SQLite Durable Object) and `web/` (the browser public OAuth client with an IndexedDB outbox). `npm run check` and `scripts/acceptance/workers-backend.sh` pass at `3d953a9`, with 406 recorded vitest tests plus the Python regressions.

The Worker code already sits behind host-neutral seams:
- DO modules are plain functions of `ModuleDeps` (`db, clock, random, transport, identity, config, log`; `worker/src/do/contracts.ts`).
- `Db` is a synchronous facade (`worker/src/do/db.ts`).
- The alarm multiplexer needs only `setAlarm`/`deleteAlarm` (`worker/src/do/timers.ts:123`).
- The Jetstream socket state machine talks to a `JetstreamLink` (`worker/src/do/ingest/jetstream-socket.ts`).

About ten files depend on Workers. The publication gate has never been open (`NAMESPACE_OWNERSHIP_REF` is empty), so **no production user has signed in and no record exists under `dev.pythonplayer123.music`**. That is what makes the OAuth model change and the lexicon additions cheap now.

---

## 2. Host architecture

### 2.1 Decision: Node only, with host-neutral seams kept
The Workers adapter is **retired** (wave 6, N6-02). Everything runs on Node 26. The boundary that would let a second host come back later is kept and named:
- `ModuleDeps`;
- `Db`;
- a new `Host` interface: `db`, `alarm`, `connectJetstream`, `transport`, an optional `backup`, `log`, `clock` and `random` (`worker/src/app/host.ts`);
- `IndexRpc`, now an in-process interface.

**Why not a dual-host core (Workers and Node adapters both maintained)?**
1. The Free plan cannot host what D2 and D3 add: the BFF with encrypted sessions, DPoP signing per write, Last.fm MD5 signatures, ZIP imports, a resident Jetstream socket and multi-day jobs. Its 10 ms CPU and 50-subrequest limits were already the reason for `pulse` mode. Paid is excluded by D1. A Workers adapter would therefore have no production use.
2. A dual host doubles the storage-conformance, timer, composition and acceptance runs, and needs two bundle guards and two e2e stacks. The research estimate is 9–14 engineer-days against 6–9 for a single host, with no user-visible value.
3. Keeping the seams costs nothing and keeps the option open.

**Directory names.** The application package keeps its path `worker/` and its name `@atmusic/worker`. That keeps test ids, the case map and git history stable. New code goes into new subdirectories of `worker/src/`. A rename to `app/` is deferred (§18 Q12).

### 2.2 What happens to the ADR 0004 pieces

| ADR 0004 piece | Fate |
|---|---|
| `packages/core`, `packages/atproto`, verification (§7), range walker, identity, cursor codec, goldens, case map | **Kept unchanged.** core and atproto test projects run under `environment: 'node'` (N0-01, N1-04). |
| DO modules (`worker/src/do/{read,ingest,write}/**`), `schema.ts`, `migrate.ts`, `status.ts` | **Kept.** They run over the Node `Db`. The schema gains migration 2 (§6.4). |
| `IndexDO` (`worker/src/do/index-do.ts`) | **Body moved** to `worker/src/app/index-core.ts` (`IndexCore`, N1-02). In wave 1 the DO class becomes a thin wrapper, and N6-02 deletes it. `blockConcurrencyWhile(migrate)` becomes "migrate synchronously before `listen`". |
| Alarm multiplexer and `timers` table (§5.9) | **Kept.** It gains extension timers (§3.3). The cron trigger becomes an in-process 5-minute `ensureRunning()` interval. |
| Ingest modes `socket` / `pulse` / `off` | `socket` is the default and `off` stays (tests, development). **`pulse`, `PLAN` and `BUDGETS.free` are removed** (B17). |
| Static Assets, `_headers`, Q9 asset-miss rules | **Kept as behaviour.** A Node static server reads `web/dist/_headers` and reuses `assetMiss`/`matchSpaRoute` (§3.7). |
| PITR (`adminPitr`, `scripts/admin/pitr-restore.ts`, `docs/backup.md`) | **Replaced** by in-process `VACUUM INTO` backups and a file restore (§14.5, B8). |
| Browser public OAuth client, IndexedDB outbox (A3, A11, A12) | **Replaced** by the confidential BFF and a server outbox (§5). The outbox semantics are kept exactly. |
| SafeFetch with DoH pre-check and no pinning (A5) | **Strengthened.** Connections are pinned to checked addresses (§3.5). |
| Notify, record status, export, settings opt-out (N1–N4, A8, A9, A10, A13, A17, A20) | **Kept.** The server outbox calls the notify path internally after each write. |
| Workers Logs, `counters`, `/internal/admin/status` (A16) | journald JSON lines plus `counters`; admin moves to a unix socket (§3.11). |
| Live gates `scripts/live/workers_*` | **Ported** to Node gates that report `blocked` when prerequisites are missing (N6-03). |
| `wrangler`, `@cloudflare/*`, workerd test pool | **Removed** in N6-02, after every suite runs on Node. |

---

## 3. The Node adapter

### 3.1 Process and layout
- **One process:** `node --enable-source-maps worker/dist/node/main.mjs`. It holds one SQLite connection, the HTTP listener, the admin socket, the Jetstream socket and all timers.
- **New source directories under `worker/src/`:**
  - `node/`: the host adapter and composition;
  - `app/`: `IndexCore`, `Host`, `AppServices`;
  - `crypto/`;
  - `bff/`: OAuth, sessions, CSRF;
  - `outbox/`;
  - `credentials/`;
  - `lastfm/`;
  - `listenbrainz/`;
  - `forward/`;
  - `imports/`.
- **No barrel files**, as before.
- **Feature services** extend `AppServices` (`worker/src/app/services.ts`) by TypeScript interface merging, `declare module '../app/services' { interface AppServices { lastfm: … } }`. Feature packages therefore never edit a shared type file.
- **Request context.** `RequestCtx` (`worker/src/http/types.ts`, N2-01) gains `deps: ModuleDeps`, `app: AppServices`, `peer: string` (the socket address) and `clientIp`. `env` becomes the structural `AppEnv` `{LEXICON_PREFIX, NAMESPACE_OWNERSHIP_REF}`.

### 3.2 Storage: node:sqlite (`worker/src/node/sqlite-db.ts`, N1-01)
- **API.** Use the class exported as `Database` from `node:sqlite`; `DatabaseSync` is a deprecated alias (DEP0210). Open it with `{timeout: 5000}`, which sets the busy timeout. There is one connection per process.
- **Startup pragmas,** set by the adapter and read back and asserted at startup:
  - `journal_mode=WAL`;
  - `synchronous=FULL`, because a scrobble acknowledged with 200 must survive a power cut;
  - `foreign_keys=ON`;
  - `journal_size_limit=67108864`.

  They are never set in migrations.
- **`Db.tx` nests.** `runGc` calls `scheduleSnapshot` inside `db.tx`, and there are 78 `db.tx(` call sites. The outermost call is `BEGIN IMMEDIATE … COMMIT`; inner calls are `SAVEPOINT sp<n> … RELEASE`, with `ROLLBACK TO` on a throw. A callback that returns a Promise is refused and rolled back, matching the existing `no-async-tx` rule.
- **Contract kept exactly.** `SqlParam` and `checkParams` are unchanged: at most 100 parameters, safe integers only, booleans and non-finite numbers refused. BLOB reads are converted from `Uint8Array` to `ArrayBuffer`. `run()` returns `{rowsWritten: changes}`.
- **Refused statements.** The adapter refuses multi-statement text: a tokenizer finds a `;` outside string literals and comments that is not the final character. An authorizer (`setAuthorizer`) denies `SQLITE_TRANSACTION`, `SQLITE_SAVEPOINT`, `SQLITE_PRAGMA`, `SQLITE_ATTACH` and `SQLITE_DETACH` for module SQL, and exempts only the adapter's own statements while a private flag is set.
- **Integers above 2^53 on read** throw `ERR_OUT_OF_RANGE`, which the adapter wraps in a typed `SqlRangeError`. The DO silently lost precision instead. `sql-conformance.test.ts:339` changes its expectation (N2-02).
- **Statement cache:** an LRU of 256 prepared statements keyed by SQL text.
- **Migrations.** `migrate.ts` is retyped over `MigrationTarget {exec(sql), tx}`, and the old DO signature is kept until N6-02. Migrations run **synchronously before the HTTP listener binds**. A database newer than the code makes `/health/ready` return 503 `too_new` and starts no timers.
- **Single writer.** All SQL runs on the main thread, synchronously. Every await (PDS, Last.fm, ListenBrainz, AS) happens outside a transaction, as the DO rules already require.

### 3.3 Scheduler (`worker/src/node/alarm.ts`, N1-03)
- `NodeAlarm` implements `AlarmStorage` over a single `setTimeout`:
  - delays are clamped to 2^31−1 ms and re-armed until the wall-clock due time;
  - every callback error is caught and logged, and the alarm is re-armed at `now + backoff` (DO alarms retried automatically; Node timers do not);
  - `IndexCore.alarm()` re-arms in `finally`, as `index-do.ts:445-474` does today.
- **Heartbeat:** a 30 s `setInterval` compares `min(timers.due_at)` with the wall clock and fires anything overdue. This covers libuv timers that stall during a machine suspend.
- **Cron replacement:** a 5-minute `setInterval` calls `ensureRunning()`.
- **Extension timers.** `TIMER_NAMES` gains `outbox`, `forward`, `import`, `oauth-keepalive`, `expiry-sweep` and `backup`. Their handlers come from `CoreExtension`s passed to `IndexCore` at composition. They run after the core timers in that fixed order. A name with no handler is never armed.
- `TIMER_RUN_TIMEOUT_MS` and `ALARM_SLICE_MS` stay as fairness slices.

**Timer cadences:**

| Timer | Cadence | Bound per run |
|---|---|---|
| `outbox` | Immediately when kicked by a new operation, then as due | 32 operations, or 1 `applyWrites` batch per DID |
| `forward` | As due | 5 upstream requests |
| `import` | As due | 1 upstream page, or 1 staging→operations slice of 1,000 items |
| `oauth-keepalive` | Hourly | 20 refreshes |
| `expiry-sweep` | Every 10 min | Expired OAuth states, link states, Last.fm tokens, web sessions, now-playing rows |
| `backup` | Daily at 03:30 UTC (wall clock) | 1 backup |

### 3.4 Jetstream on Node (`worker/src/node/jetstream-ws.ts`, N1-04)
- Uses the `ws` package (pinned `8.22.0`, now a direct dependency). Node's `fetch` refuses `Upgrade`, and the global `WebSocket` hides the handshake status. `ws`'s `unexpected-response` event provides the status and body, so `JetstreamConnectError.cursorRejected` keeps working (for example a 400 with `{"error":"OutdatedCursor"}`).
- `https:` maps to `wss:`.
- Options: `perMessageDeflate: false`, `maxPayload: 1 MiB` (the 64 KiB parser bound and its counter are unchanged), and a 10 s handshake timeout.
- Only hosts listed in `JETSTREAM_URLS` are dialled.
- `Buffer` frames become `ArrayBuffer` for `LinkEvent`. The connector buffers until `start()`, as `linkOf` does today.
- Ingest mode is `socket`, with the existing watchdog, the 15-minute planned refresh, host rotation and Q11 continuity.
- On SIGTERM the link closes with code 1000.
- **Tests:** `packages/atproto/test-support/fake-jetstream.ts` gains an in-memory `JetstreamLink` connector that works on any host. The workerd `WebSocketPair` export stays until N6-02.

### 3.5 Outbound transport with pinning (`packages/atproto/src/net/pinned-transport.ts`, N1-05)
- On Node a bad fetch can reach the owner's LAN, `127.x` and our own listener.
- Every production `Transport` uses an undici `Agent` (pinned `undici@8.12.2`, the same as Node's bundled copy) whose `connect.lookup` applies `isAllowedAddress` to **every address it returns**. Only the address that was checked is connected. This closes the A5 TOCTOU residual and is a strengthening.
- Every existing `SafeFetch` rule still applies in front of it:
  - https only, default port;
  - no IP literals;
  - forbidden suffixes;
  - `redirect: manual`, with any 3xx an error;
  - body caps;
  - a 10 s deadline.
- The DoH A/AAAA pre-check is dropped for HTTP. Pinning against the system resolver supersedes it. DoH TXT stays for handle verification.
- Network failures reject with `TransportError {code}`, never a raw `TypeError`. `@atproto/oauth-client` deletes sessions on `TypeError` (`session-getter.js:60-68`), and a network blip must not sign anyone out.
- Fixed upstreams (`ws.audioscrobbler.com`, `api.listenbrainz.org`) use the same transport. Tests inject the router transport, which is test-support only.

### 3.6 HTTP listener and the 127.2.0.1:8888 bind (`worker/src/node/http-bridge.ts`, N1-06)
- **Server.** `node:http` server bridged to WHATWG `Request`/`Response`, so every existing handler is reused.
- **Request URL.** Built as `PUBLIC_ORIGIN + raw path and query`. `Host`, `X-Forwarded-Host` and `X-Forwarded-Proto` never change it.
- **Host check.** `Host` must equal the public host or the listen address, else 421 `misdirected_request`. This blocks DNS-rebinding pages in the owner's own browser.
- **Bodies** are streamed with a per-route cap:

  | Route group | Cap |
  |---|---|
  | Default | 64 KiB |
  | `/2.0/` | 1 MiB |
  | `/1/submit-listens` | 10,240,000 bytes |
  | Import upload | 64 MiB, streamed to disk |

  Over the cap: 413 after reading at most cap+1 bytes. A client disconnect aborts the handler's `AbortSignal`.
- **HEAD** returns the headers and no body.
- **Timeouts:** `keepAliveTimeout = 100 s` (above cloudflared's 90 s origin idle timeout), `headersTimeout = 60 s`, `requestTimeout = 600 s`.
- **Bind.** `ATMUSIC_LISTEN`, default `127.2.0.1:8888`. Only loopback addresses are accepted (`127.0.0.0/8` or `::1`); anything else is a startup error. Reverse proxies and tunnels run on the same host.
- **Socket activation.** If `LISTEN_FDS=1` and `LISTEN_PID` is our pid, `listen({fd: 3})` is used, after checking that the inherited socket's local address is loopback (§14.1 `atmusic.socket`).
- **Client IP** (`worker/src/node/client-ip.ts`):
  - `ATMUSIC_CLIENT_IP_HEADER` is `cf-connecting-ip` (default), `x-forwarded-for`, `x-real-ip` or `none`.
  - The header is honoured only when the socket peer is in `ATMUSIC_TRUSTED_PROXIES` (default `127.0.0.0/8,::1`).
  - In `x-forwarded-for` mode the **rightmost untrusted** entry is used, never the leftmost (port of `crates/server/src/http/limits.rs:138-191`).
  - Every inbound `x-atmusic-*` header is stripped.
  - Residual: any local process can forge the header. That is accepted on a single-user host and documented.

### 3.7 Dispatch and static web (`worker/src/node/static-assets.ts`, N1-06; dispatch in `compose.ts`, N2-01)
**Dispatch order:**
1. These router prefixes always reach the router first: `/api/`, `/health/`, `/oauth/` (client metadata, JWKS and the callback are now dynamic), `/2.0` and `/2.0/` (Last.fm), `/1/` (ListenBrainz) and `/audioscrobbler/` (§7.10).
2. Otherwise, an existing file in `ASSETS_DIR` (`web/dist`) is served.
3. Otherwise, `assetMiss` runs. It is exported from `router.ts` and unchanged: `index.html` for known SPA routes, else the JSON 404.

**`/api/auth` (Last.fm web/desktop approval)** is an explicit route that 302-redirects to the SPA page `/lastfm/authorize`, keeping the query string (§7.3).

**Static server:**
- Files are loaded into memory at startup, since `dist` is small. The ETag is the SHA-256 of the content, and `If-None-Match` gets a 304.
- MIME types come from a fixed table.
- `_headers` is parsed once; it carries the CSP, `nosniff`, `Referrer-Policy`, immutable caching for `/assets/*`, and no-cache for `/` and `/index.html`. `_headers` itself is never served.
- `/index.html` 301-redirects to `/`.
- A non-GET/HEAD request to an existing file gets 405 with `Allow: GET, HEAD` and the JSON error envelope.
- Traversal (`..`, `%2e%2e`, backslash, NUL) is refused before any filesystem access.

### 3.8 Configuration and secrets (`worker/src/node/{config,secrets}.ts`, N1-07)
**Non-secret configuration** comes from the unit's `Environment=` lines, or an `EnvironmentFile=` of non-secrets (`~/.config/atmusic/atmusic.env`):

| Variable | Default | Notes |
|---|---|---|
| `ATMUSIC_LISTEN` | `127.2.0.1:8888` | Loopback only |
| `ATMUSIC_PUBLIC_ORIGIN` | (required) | `https://music.214510.xyz`; https except in test entries |
| `ATMUSIC_DB` | `$STATE_DIRECTORY/atmusic.db` | Startup error if neither is set |
| `ATMUSIC_ASSETS_DIR` | `<release>/web/dist` | |
| `ATMUSIC_BACKUP_DIR` | `$STATE_DIRECTORY/backups` | |
| `ATMUSIC_UPLOAD_DIR` | `$STATE_DIRECTORY/imports` | |
| `ATMUSIC_ADMIN_SOCKET` | `$XDG_RUNTIME_DIR/atmusic/admin.sock` | |
| `ATMUSIC_CLIENT_IP_HEADER`, `ATMUSIC_TRUSTED_PROXIES` | see §3.6 | |
| `LEXICON_PREFIX`, `NAMESPACE_OWNERSHIP_REF` | as today | Namespace gate unchanged |
| `INGEST_MODE` | `socket` | `socket` or `off`; `pulse` is refused with a message citing ADR 0005 |
| `JETSTREAM_URLS`, `JETSTREAM_LOOKBACK_HOURS`, `RELAY_URL` | as today | |
| `LASTFM_API_ROOT` | `https://ws.audioscrobbler.com/2.0/` | https required |
| `LASTFM_AUTH_URL` | `https://www.last.fm/api/auth/` | https required |
| `LISTENBRAINZ_API_ROOT` | `https://api.listenbrainz.org/` | https required |
| `ATMUSIC_LASTFM_KNOWN_CLIENTS` | `panoScrobbler:panoScrobbler:Pano Scrobbler` | Public key:secret:name triples (§7.4) |
| `ATMUSIC_OAUTH_TRANSITION_GENERIC` | `0` | ADR 0004 Q5 flag, off |

**Secrets** are one JSON document read from `$CREDENTIALS_DIRECTORY/secrets`, delivered by `LoadCredentialEncrypted=` (default) or `LoadCredential=`. For development and tests it can come from `ATMUSIC_SECRETS_FILE`, which is refused unless the mode is 0600 or stricter. Secrets never go into `process.env`, so the `systemd-notify` children and D-Bus never see them.
```json
{ "cursorKey": "<base64, ≥32 bytes>",
  "encryptionKeys": [{"id": "e1", "key": "<base64, 32 bytes>"}],
  "oauthSigningKeys": [{"kty":"EC","crv":"P-256","kid":"k1","d":"…","x":"…","y":"…"}],
  "lastfm": {"apiKey": "<owner's Last.fm API key>", "sharedSecret": "<secret>"} }
```
- `encryptionKeys[0]` is the current key. Older entries can only decrypt.
- Derived keys use HKDF-SHA256:
  - OAuth: salt `atmusic/oauth/encryption/v1`, info `state` or `tokens` (Rust-compatible, `crates/atproto/src/oauth/token_store.rs:63-68`);
  - linked accounts: salt `atmusic/linked/encryption/v1`, info `lastfm` or `listenbrainz`;
  - issued Last.fm app secrets: salt `atmusic/credentials/encryption/v1`, info `lastfm-app`;
  - CSRF: salt `atmusic/csrf/v1`, info `hmac`.
- `lastfm` is optional. Without it, Last.fm linking, forwarding and API imports are off and say so (§7, §11, §12). The Last.fm JSON upload and everything else still work.
- `scripts/admin/gen-secrets.ts` writes a fresh 0600 secrets file with local randomness only. The owner adds the Last.fm pair by hand.

### 3.9 Build and bundle guard (N2-01)
- Node 26 cannot load this TypeScript by type stripping (parameter properties, extensionless imports). `scripts/build-server.ts` bundles `worker/src/node/main.ts` with esbuild (`0.28.2`, `platform: node`, `format: esm`, `target: node26`, source maps) into `worker/dist/node/main.mjs`.
- **`@atcute/crypto` build.** The Node resolution picks the `node:crypto` (OpenSSL) secp256k1 build. Tests and the bundle **must resolve the same build**. `scripts/check-bundle.ts` asserts the bundle's resolved `@atcute/crypto` entry equals the one the worker-node test project resolves. The real-crypto suites run under Node: Rust golden CARs, low-S enforcement, malleable signature rejection, P-256 and secp256k1 vectors, and the `@atproto/crypto` cross-check.
- **Fallback.** If any of those vectors fails on the `node:crypto` build, both esbuild and vitest set `conditions: ['browser']` and keep the noble build. Verification is never relaxed to make a vector pass.
- **The guard** (rewritten `scripts/check-bundle.ts`) runs over the esbuild output. It fails on:
  - `test-support`, `fixedClock` or `router-transport` code;
  - `com.example.atmusic` handling;
  - `cloudflare:` imports;
  - a crypto-build mismatch.

  It prints the bundle SHA-256 that evidence records carry.

### 3.10 Composition, readiness and shutdown (`worker/src/node/{main,compose,shutdown,systemd,features}.ts`)
**Startup order:**
1. Parse config and secrets. Any error exits with status 78 (`EX_CONFIG`) and names the variable.
2. Bind the admin socket (§3.11). If the path already answers, another instance owns the state directory: exit 1. A stale socket file is replaced.
3. Open the db. If a migration is pending, take a pre-migration backup (§14.5), then migrate.
4. Build the `Host` and `IndexCore`; `start()` runs `noteRestart`, reclaims leases, then `ensureTimers` and `armAlarm`.
5. Build the feature services and the route table (`features.ts`, N4-01).
6. `listen`.
7. `systemd-notify --ready`.

**Readiness** (`/health/ready`): the schema is current, config is parsed, the secrets loaded, the OAuth keyset is valid, and the db answers a write probe (a rolled-back transaction). Liveness (`/health/live`) means the process only.

**Watchdog:** `WATCHDOG=1` is sent every `WatchdogSec/3`, only after an event-loop-lag probe (< 5 s) and a `SELECT 1` succeed.

**SIGTERM:**
1. Send `STOPPING=1`.
2. Stop accepting connections.
3. Let in-flight requests finish, up to 25 s.
4. Close Jetstream with 1000.
5. Let the current timer slice end; slices are bounded.
6. Close the db.
7. Exit 0.

This restores the M1.4.3 drain that ADR 0004 §9.3 dropped. The unit's `TimeoutStopSec=30s` exceeds it.

### 3.11 Admin interface on a unix socket
- `/internal/admin/*` is **never** served on the TCP listener, which returns 404. A tunnel cannot tell admin traffic from public traffic, because every peer is loopback.
- Admin routes are served only on `ATMUSIC_ADMIN_SOCKET`: a directory of mode 0700 holding a socket of mode 0600. Filesystem permissions are the authentication, and `ADMIN_TOKEN` is retired.
- Routes: `GET /admin/status` (adminStatus plus backup age, Jetstream lag, outbox and forward queue depths, import jobs, link failures), `POST /admin/backup`, `POST /admin/resnapshot {did}`, `POST /admin/oauth/prune-kid {kid}`.
- `scripts/admin/atmusic-admin.ts` is the CLI client. `curl --unix-socket` also works.

---

## 4. Topology

```
Scrobbler apps (Pano, multi-scrobbler, Web Scrobbler, Navidrome, Jellyfin, Music Assistant, lastfm-ts-api…)
Browser (Preact SPA, cookie session; no OAuth library, no PDS access)
   │ https://music.214510.xyz   (owner-chosen: cloudflared tunnel | Caddy/nginx | proxied DNS → reverse proxy)
   ▼
127.2.0.1:8888  ── node worker/dist/node/main.mjs  (systemd user unit atmusic.service, linger on)
   ├─ /api/v1/*       public reads (v1.1) + cookie routes (auth, writes, account, links, imports, credentials)
   ├─ /oauth/*        client-metadata.json, jwks.json, callback        (confidential client, private_key_jwt)
   ├─ /2.0/           Last.fm 2.0 compatible (auth.*, track.scrobble, …, user.get*)
   ├─ /api/auth/      → 302 /lastfm/authorize (SPA approval page)
   ├─ /1/*            ListenBrainz compatible (submit-listens, validate-token, user/*, stats/*, feedback/*)
   ├─ static web/dist + SPA fallback (Q9 rules)
   ├─ IndexCore: Jetstream (ws) → hints → getRecord/getBlocks proof → apply → read models (unchanged)
   ├─ outbox → user's PDS (DPoP, applyWrites/createRecord/deleteRecord) → internal notify → proof → index
   ├─ forward → ws.audioscrobbler.com (signed track.scrobble) / api.listenbrainz.org (Token)
   ├─ import ← ws.audioscrobbler.com user.getRecentTracks / api.listenbrainz.org listens / uploaded exports
   └─ SQLite ~/.local/state/atmusic/atmusic.db (WAL, FULL) ; backups/ ; imports/
unix socket $XDG_RUNTIME_DIR/atmusic/admin.sock  (admin only)
```

---

## 5. OAuth: one confidential client (BFF)

### 5.1 Decision
**One confidential client at the unchanged client_id**, `https://music.214510.xyz/oauth/client-metadata.json`. The server holds each DID's OAuth session. **The browser no longer talks to PDSs at all**: it writes through cookie-authenticated `/api/v1` routes into the same server outbox that the scrobbler protocols use.

**Rejected alternative:** a second, public client_id for the browser. It would mean two consents, two OAuth sessions per DID competing for one PDS rate budget, two write paths and two outboxes. The reference AS also rejects any token request whose authentication method differs from the fetched metadata (`invalid_grant`, "Client authentication method mismatch", `oauth-provider.js:376-380`), so one URL cannot serve both models.

**What this gains:**
- one write path and one per-DID point scheduler;
- retries no longer need an open tab;
- confidential lifetimes: refresh tokens up to 3 months of inactivity and sessions up to 2 years in the reference AS, against 2 weeks for public clients;
- no forced consent prompt on every sign-in;
- SSRF pinning on all OAuth fetches.

**What it costs:**
- encrypted credentials at rest;
- a client signing key to protect;
- cookies and CSRF;
- every signed-in user signs in once more. Nobody has, because publication was never enabled.

### 5.2 Library
- **Library:** `@atproto/oauth-client-node` **0.5.10** (2026-10-17). That is the newest release at least 7 days old on 2026-10-25, and it matches the already-locked `@atproto/oauth-client` 0.8.10, so only one copy is installed. Its counterpart `@atproto/oauth-provider` is the reference AS behind the fake-AS shapes.
- **Construction:**
  ```
  new NodeOAuthClient({clientMetadata, keyset, stateStore, sessionStore, requestLock: requestLocalLock,
                       handleResolver: <our verified resolver>, fetch: <pinned transport>, responseMode: 'query'})
  ```
  `allowHttp` is never set.
- **Writes** use `client.restore(did)` → `session.fetchHandler(path, init)`, which handles DPoP, nonce retry and refresh.
- **Hooks:**
  - `onSessionUpdated` stores the session;
  - `onSessionDeleted(sub, cause)` sets `accounts.oauth_status='reauth_required'` and blocks that DID's operations without failing them (§5.8). The UI shows a re-sign-in banner.
- **Alternative kept documented:** `@atcute/oauth-node-client` 2.0.1 (ADR 0004 §15). Not chosen, because its key-rotation behaviour is undocumented and its source was not inspected.

### 5.3 Client metadata and JWKS (dynamic, `worker/src/bff/client-metadata.ts`)
`GET /oauth/client-metadata.json` serves exactly this document (with `<p> = dev.pythonplayer123.music`), with `Cache-Control: public, max-age=300` and no cookie:
```json
{"client_id":"https://music.214510.xyz/oauth/client-metadata.json","client_name":"AT Music","client_uri":"https://music.214510.xyz",
 "application_type":"web","redirect_uris":["https://music.214510.xyz/oauth/callback"],
 "grant_types":["authorization_code","refresh_token"],"response_types":["code"],
 "scope":"atproto repo:<p>.scrobble repo:<p>.follow repo:<p>.settings repo:<p>.love",
 "token_endpoint_auth_method":"private_key_jwt","token_endpoint_auth_signing_alg":"ES256",
 "jwks_uri":"https://music.214510.xyz/oauth/jwks.json","dpop_bound_access_tokens":true}
```
- `GET /oauth/jwks.json` serves the **public** JWKs of the published set: `kty, crv, x, y, kid, alg:"ES256", use:"sig"`, and never `d`.
- `client_name` keeps the existing `CLIENT_NAME` constant from `scripts/gen-config.ts`.
- `repo:<p>.love` is new (§6.3). Adding it now costs no re-consent, because nobody has consented yet.
- `transition:generic` is appended only when `ATMUSIC_OAUTH_TRANSITION_GENERIC=1` (ADR 0004 Q5).
- The `include:` permission set is deferred (§18 Q7).
- `scripts/gen-config.ts` stops emitting a static `oauth/client-metadata.json` (N5-01). The router prefix `/oauth/` would shadow it on Node anyway.
- Both documents must stay publicly reachable, because the AS re-fetches them at sign-in and on refresh, and caches them for 10 minutes. An origin outage longer than that blocks sign-ins and refreshes. It does not delete sessions.

### 5.4 Signing keys and rotation (`worker/src/bff/keyset.ts`)
- **Format.** Private ES256 JWKs with unique `kid`s, from `secrets.oauthSigningKeys`. New sessions bind to the first key. A session is bound to its key's kid, alg and thumbprint for its whole life, and the reference AS enforces that (`oauth-provider.js:403-411`).
- **Published set.** `jwks.json` publishes the public halves of the keyset plus `secrets.oauthAnnouncedKeys`, which holds public JWKs only, so a new key is announced before it is used.
- **Rotation runbook** (`docs/operations.md`, N4-02):
  1. Generate K2 (`gen-secrets.ts --oauth-key k2`).
  2. Add K2's public JWK to `oauthAnnouncedKeys`, restart, and wait at least 10 minutes.
  3. Set the keyset to [K2, K1] and restart.
  4. Keep K1 until `atmusic-admin status` shows no session with `client_kid='k1'`.
  5. Remove K1. Sessions still bound to it fail with `AuthMethodUnsatisfiableError`, which means `reauth_required`.
- **Compromise:** remove the key at once. Every session bound to it dies, and those users sign in again.
- **Storage.** The keys are never stored in the db, and never in db backups.

### 5.5 Session and state storage, encrypted at rest (`worker/src/bff/oauth-stores.ts`)
- **`oauth_states`** is a `SimpleStore` keyed by SHA-256 of the state key. Its value is AES-256-GCM ciphertext (HKDF info `state`), with AAD equal to the key hash. TTL is **600 s**, and the state is single-use: `get` deletes it. The reference AS uses 5 minutes for PAR and for authorization inactivity, so 600 s covers both.
- **`oauth_sessions`** is keyed by DID. Its value is the `NodeSavedSession` (token set, private DPoP JWK, `authMethod`) as AES-256-GCM ciphertext (info `tokens`), with AAD equal to the DID.
- The row also carries `client_kid`, `generation`, `last_refresh_ms` and `status`.
- **Writes are compare-and-swap on `generation`** (port of `crates/storage/src/repositories/oauth.rs`), so a stale refresh or revoke response can never overwrite a newer session.
- **Ciphertext format:** `keyId ‖ nonce(12) ‖ ciphertext ‖ tag(16)`. Decryption failure is a typed `BoxError`, and the session is treated as missing, which means `reauth_required`.
- **Callback revokes the previous session for the DID** before storing the new one (library behaviour, `oauth-client.js:196-205`). One OAuth session per DID serves many browser sessions and every protocol credential.
- **Keepalive** (`worker/src/bff/keepalive.ts`, the `oauth-keepalive` timer, hourly): refresh any active session whose `last_refresh_ms` is more than 30 days old, at most 20 per run. A scrobbler-only user who never opens the UI therefore never crosses the 3-month refresh-token inactivity window.
- **Callback binding check:** after `callback()`, the server resolves the session's `sub` with `identity.resolveDid(sub, {fresh: true})`. It requires that the PDS's authorization server is the session issuer and, when sign-in started from a handle, that the handle resolved to that DID. Otherwise the session is revoked and the user gets 403 `oauth_binding_mismatch`.

### 5.6 Browser sessions and CSRF (`worker/src/bff/{sessions,csrf,guard}.ts`)
- **Cookie:** `__Host-atmusic_session=<64 hex>`, `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` (30 days). It is renewed when it is more than 24 hours old.
- **Storage.** Only SHA-256(token) is stored, in `web_sessions`. Logout deletes the row. Logout-all deletes every row for the DID. Signing out also revokes the OAuth session upstream unless the DID still has active protocol credentials; the UI asks.
- **CSRF**, for every unsafe method on `/api/v1/*` that uses the cookie:
  - exactly one `Origin` header, equal to `PUBLIC_ORIGIN`;
  - `X-CSRF-Token` = hex(HMAC-SHA256(csrfKey, `"atmusic.csrf.v1\0" + sessionToken`)), as in the Rust `crates/server/src/auth/csrf.rs`. The token comes from `GET /api/v1/auth/session`.
  - Status: no session → 401 `unauthenticated`; CSRF failure → 403 `csrf_failed`.
  - The Rust 401/403/404 matrix is ported.
- **Scope.** `/2.0/` and `/1/` never read cookies. Their guard returns no session even if a valid cookie is present. They authenticate only with protocol credentials, so CSRF does not apply to them.
- **GET callbacks.** `/oauth/callback` and `/api/v1/links/lastfm/callback` are protected by their single-use `state`, bound to the session hash. A `SameSite=Lax` cookie arrives on that top-level navigation.

### 5.7 Routes restored or added under `/api/v1` (contract v1.2, §16)
**Auth:**
- `POST /api/v1/auth/start {handle}` → 200 `{authorizeUrl}`. Errors: 422 `fields.handle`; 429 at 10/min per IP.
- `GET /oauth/callback` → sets the cookie, then 303 to `/` (or to `returnTo` when it is a known SPA path). An AS error such as `access_denied` → 303 `/signin?error=denied`.
- `GET /api/v1/auth/session` → `Session {did, handle, username, csrfToken, status:"active"|"reauth_required", expiresAt}`, or 401.
- `POST /api/v1/auth/logout {everywhere?: boolean}` → 204.

**Writes** all return 202 `{operation: Operation}` and need the cookie plus CSRF. `POST /api/v1/scrobbles` also needs an `Idempotency-Key` (§5.8).
- `POST /api/v1/scrobbles` with `ScrobbleInput`: the v1.0 fields plus the optional fields of §6.2.
- `DELETE /api/v1/scrobbles/{id}`, where the id is a URL-encoded AT URI. Another DID's record gives 404.
- `PUT /api/v1/follows/{did}` and `DELETE /api/v1/follows/{did}`.
- `PUT /api/v1/loves {artist, track, album?, recordingMbid?}` and `DELETE /api/v1/loves?artist=&track=`.
- `PUT /api/v1/account/indexing {indexing:"enabled"|"disabled"}`, which writes the A10 settings record.

**Operations:** `GET /api/v1/operations/{id}` → `Operation {id, kind, origin, state:"queued"|"running"|"succeeded"|"failed"|"blocked", attempts, uri?, cid?, error?, createdAt, updatedAt}`. Owner only; anyone else gets 404.

**Account:**
- `GET /api/v1/account` → `Account {did, handle, username, oauthStatus, shareNowPlaying, importSharePercent, capabilities}`.
- `PATCH /api/v1/account` changes `username`, `shareNowPlaying` and `importSharePercent` (10–90). A taken username is 409 `username_taken`.

**Credentials (§7.3, §8.2):**
- `GET /api/v1/account/credentials` returns metadata only.
- `POST|DELETE /api/v1/account/app-passwords[/{id}]`.
- `POST|DELETE /api/v1/account/listenbrainz-tokens[/{id}]`.
- `POST|DELETE /api/v1/account/lastfm-apps[/{apiKey}]`.
- `DELETE /api/v1/account/lastfm-sessions/{id}`.
- `POST /api/v1/lastfm/authorize`.

Linking and imports are in §11 and §12.

**Not restored:** v1.0's `GET /api/v1/account/export` and `DELETE /api/v1/account/local-data`. A9 and A10 stay.

**Publication gate:** with the gate closed (`meta.capabilities` without `publication`), every write route answers 503 `publication_disabled`, and so do the protocol write methods (§7.7, §8.3).

### 5.8 Server outbox (`worker/src/outbox/*`, N2-05)
This is a port of `web/src/outbox/*`, which in turn ported the Rust `crates/server/src/workers/outbox.rs`. **Every ADR 0004 §5.2 semantic is kept, on the server:**
- **Persist before the first attempt.** `operations` holds the TID rkey, which is allocated once from the injected clock and random, together with the record and its canonical digest.
- **Retry:** `min(300 s, base + U[0, base/4])` with base 1, 2, 4 … s; a capped `Retry-After` can raise it. **Exactly 10 attempts.**
- **Ambiguous create:** `getRecord` plus a digest comparison. Equal means success; different means terminal `remote_record_conflict`. A record is **never overwritten**, and `putRecord` is never used for creates.
- Deletes use `swapRecord` from `record_state`. `InvalidSwap` re-fetches, reconciles and retries.
- **Predecessors:** a delete waits for its pending create, and follow PUT/DELETE intents run FIFO.
- Follow rkey `'f'+hex(sha256(subject))`. Unfollow deletes every matching follow it lists.
- After each success, the runner calls the internal notify path, so the verify drain indexes the record. **Indexing is still proof-gated.**

**Additions:**
- **Idempotency** (restores the v1.0 server rule while keeping A11's TID plus digest):
  - `Idempotency-Key`: 1–128 characters from `[A-Za-z0-9._~-]`, required on `POST /api/v1/scrobbles`. Missing → 400 `idempotency_key_required`.
  - Same key and the same request hash → the same operation.
  - Same key and a different hash → 409 `idempotency_conflict`.
  - Protocol ingress uses the listen key instead (§7.7).
- **Origins and priorities:** each operation has `origin` (`web`, `lastfm`, `listenbrainz` or `import`) and `priority` (0 for live, 1 for import). Due live operations always run first.
- **Batching:** `apply-writes.ts` sends `com.atproto.repo.applyWrites` with ≤ 200 writes and ≤ 1,000,000 bytes per call. It is used for imports and for protocol batches of more than one listen. Single live writes use `createRecord` or `deleteRecord`. A failed atomic batch is **bisected** down to single writes, and singles go through ambiguous-create reconciliation.
- **PDS point budget** (`budget.ts`; `pds_budget` per DID with hour and day windows):
  - Costs: create 3, update 2, delete 1.
  - Default limits: 5,000 points per hour and 35,000 per day (Bluesky's documented values).
  - When a PDS sends `RateLimit-Limit`, `-Remaining`, `-Reset` and `-Policy`, those headers win over the ledger.
  - Live writes may use up to 90% of the limit.
  - Imports may use `importSharePercent` (default 50%) and pause when `RateLimit-Remaining < (1 − share) × limit`.
  - A 429 honours `Retry-After` or `RateLimit-Reset`.
  - The budget is shared with the user's own Bluesky activity, which is why imports default to half.
- **Re-authentication:** a DID in `reauth_required` has its operations set to `blocked`. They are not failed and attempts do not count. They resume after sign-in.
- **Writer port.** `PdsWriter` is an interface; production uses `session.fetchHandler`, tests use the fake PDS.

### 5.9 Migrating the browser client code and tests (N5-01)
- **Removed:**
  - `@atproto/oauth-client-browser` from `web/package.json`;
  - `web/src/oauth/{client,session,types}.ts`;
  - `web/src/outbox/{runner,store,scrobble-ops,follow-ops,delete-ops,settings-ops}.ts`;
  - `web/src/routes/callback.tsx`, since the server owns `/oauth/callback`.
- **Added:**
  - `web/src/session/client.ts`: `GET /api/v1/auth/session`, a cached `csrfToken`, `credentials: 'same-origin'` and `X-CSRF-Token` on every mutation;
  - `web/src/api/writes.ts`: a fresh `Idempotency-Key` for each user action, persisted in `sessionStorage` until the response arrives.
- **Kept:** `overlay.ts`, the optimistic owner overlay, now fed by `GET /api/v1/operations/{id}` and `/records/status` polling (queued → published → indexed). The `SessionStatus` and reauth UI states.
- **New screens:** `/settings/links`, `/settings/imports`, `/settings/credentials`, and the Last.fm approval page `/lastfm/authorize`.
- **Legacy IndexedDB.** On first load the SPA deletes the legacy `atmusic*` IndexedDB databases and never contacts a PDS. No production outbox data can exist, because publication was never enabled, so migrating pending items is unnecessary.
- **CSP.** `connect-src` tightens from `'self' https:` to `'self'`. `scripts/gen-config.ts` emits `_headers` and the SPA route list only.
- **Tests:**
  - `web/test/oauth/session.test.ts` is deleted. Its behaviour now lives in `worker/test/node/bff/*` and `worker/test/node/http/auth.test.ts`.
  - `web/test/outbox/{retry,recovery,delete,follows,settings}.test.ts` move to `worker/test/node/outbox/*`, **keeping their titles** where the behaviour is kept.
  - `docs/verification/ts-case-map.json` remaps the moved ids in the same package. `docs/verification/node-port-inventory.json` (N2-02) records every pre-port test id and its replacement, and `scripts/test/test-inventory.test.ts` fails if an id vanishes without one.

### 5.10 OAuth in tests and development
- **Deterministic suites** use `packages/atproto/test-support/fake-oauth-as.ts`:
  - PAR, auto-approving authorize, token;
  - **private_key_jwt assertion verification** against our `jwks_uri`, fetched through the router transport;
  - DPoP nonce rotation, refresh, `invalid_grant`, revoke, and the 60 s assertion age and `jti` uniqueness rules.
- **The fake PDS** (`fake-pds.ts`) requires DPoP-bound access tokens for writes.
- **Playwright** uses the same fake AS and PDS behind the existing stack proxy (N6-01).
- **Interop with the real `@atproto/oauth-provider`** (in `@atproto/dev-env`) needs an https client_id that the dev-env PDS can fetch. Loopback clients must be public, and `127.2.0.1` is not a valid loopback redirect host. That interop run is the operator gate `scripts/live/devenv_oauth_check.ts`, which reports `blocked` when the https test origin cannot be provided (§18 Q8).
- **There is no public-client dev mode.** Local development uses a test entry with the fake AS.

---

## 6. Data model: lexicons and schema

### 6.1 Lexicon evolution rule
- atproto lexicon evolution, once published, allows only backward-compatible changes: **new optional fields**. It forbids new required fields, constraint tightening and type changes; a breaking change needs a new NSID.
- **Status of our NSIDs.** They are **not yet live**. The publication gate has never opened, no record exists in any repository, and no lexicon document has been published at `music.pythonplayer123.dev`. Breaking changes are therefore **still allowed**.
- **Decision.** We do not use that freedom, and this ADR makes **additive changes only**. The **freeze point** is the first production record (publication enabled in production). From then on, B13's additive-only rule binds, and `scripts/validate_contracts.py` enforces it against the last published copy kept in `lexicons/published/` (created at the freeze point).
- **Production prefix.** Lexicon files keep the fixture id `com.example.atmusic.*`. The production prefix is substituted when they are published.

### 6.2 `<p>.scrobble`: new optional fields
All existing fields and limits are unchanged.

| Field | Type and limits (validator) | Source mapping |
|---|---|---|
| `albumArtist` | string, 1–256 scalars, ≤ 1,024 bytes, trimmed non-empty | Last.fm `albumArtist[i]`; ListenBrainz `additional_info.release_artist_name` |
| `trackNumber` | integer 1–9999 | Last.fm `trackNumber[i]`; ListenBrainz `tracknumber` (int or numeric string) |
| `artistMbids` | array of UUID strings, ≤ 10, distinct | ListenBrainz `artist_mbids` |
| `releaseMbid` | UUID string | ListenBrainz `release_mbid` |
| `releaseGroupMbid` | UUID string | ListenBrainz `release_group_mbid` |
| `isrc` | string matching `^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$` | ListenBrainz `isrc` (uppercased) |
| `submissionClient` | string, 1–64 scalars, ≤ 256 bytes | ListenBrainz `submission_client` (+ ` ` + version); Last.fm session client name |
| `musicService` | lowercase DNS name ≤ 253 | ListenBrainz `music_service` |

Existing fields map as follows:
- `recordingMbid` ← Last.fm `mbid[i]` or ListenBrainz `recording_mbid`;
- `durationSeconds` ← Last.fm `duration[i]`, or ListenBrainz `duration`, or `duration_ms`/1000 rounded half-up (minimum 1);
- `album` ← Last.fm `album[i]` or ListenBrainz `release_name`.

**Not stored:**
- Last.fm `context`, `streamId`, `chosenByUser`;
- ListenBrainz `tags`, `origin_url` (privacy), `spotify_id`, `media_player*`, `work_mbids`, `track_mbid`.

**Validation rules:**
- An invalid optional field is **dropped**, never fatal, and never truncated.
- An invalid `artist` or `track` makes the listen invalid (§7.7, §8.3).
- Records read from a remote repository stay **open**: unknown fields are ignored.
- `buildScrobbleRecord` stays **closed**: unknown input fields are rejected.
- Canonical digests of records without the new fields are byte-identical to the goldens.

### 6.3 New collection `<p>.love`
- **Key** `tid`. **Record** `{artist (required), track (required), album?, recordingMbid?, createdAt (required)}`, with the scrobble limits.
- **Identity:** one love per `(artist_key, track_key)` per DID, enforced by the server writer. A love when one exists is a no-op success; unlove deletes every matching love record it lists, mirroring unfollow.
- Loves from other apps are indexed with the same proof rules.
- Loves are within the snapshot key range `[<p>., <p>/)` automatically. Jetstream `wantedCollections` adds `<p>.love`, and `config.collections` gains `love` (N3-11).
- Used by `track.love`/`unlove`, `user.getLovedTracks`, `track.getInfo userloved`, `extended=1 loved` and ListenBrainz feedback.

### 6.4 Migration 2 (`worker/src/do/schema.ts`, N1-10)
One migration creates everything this ADR needs, so later packages never edit the schema. Row types live in `worker/src/app/rows.ts`. Unless noted, times are INTEGER ms and listen times are TS30 text.

**Columns added to `scrobbles`:**
- `album_artist`, `album_artist_key`, `track_number`, `artist_mbids` (JSON text), `release_mbid`, `release_group_mbid`, `isrc`, `submission_client`, `music_service`, `recording_msid` (§8.4).

**Indexes added to `scrobbles`:**
- `scrobbles_msid(did, recording_msid, listened_at)`;
- `scrobbles_track_global(artist_key, track_key)`;
- `scrobbles_artist_global(artist_key)`;
- `scrobbles_album_stats(did, album_key, listened_at) WHERE album_key IS NOT NULL`.

**New tables:**

| Table | Columns (keys) | Purpose |
|---|---|---|
| `accounts` | `did` PK, `username` UNIQUE (lowercase `[a-z0-9][a-z0-9._-]{1,63}`), `oauth_status` (`active`, `reauth_required`, `signed_out`), `share_now_playing` (default 1), `import_share_pct` (default 50, 10–90), `daily_listen_cap` (default 3000), `created_at_ms`, `updated_at_ms` | Local account for each signed-in DID |
| `web_sessions` | `token_hash` BLOB PK, `did`, `created_at_ms`, `expires_at_ms`, `last_seen_ms`; indexes `(did)`, `(expires_at_ms)` | Cookie sessions |
| `oauth_states` | `key_hash` PK, `ciphertext`, `key_id`, `session_binding`, `expires_at_ms` | OAuth state store |
| `oauth_sessions` | `did` PK, `ciphertext`, `key_id`, `client_kid`, `generation`, `last_refresh_ms`, `status`, `created_at_ms`, `updated_at_ms` | OAuth session store |
| `operations` | `id` PK, `did`, `kind` (`scrobble.create`, `scrobble.delete`, `follow.put`, `follow.delete`, `settings.put`, `love.put`, `love.delete`), `origin`, `priority`, `collection`, `rkey`, `record_json`, `digest`, `swap_cid`, `state`, `attempts`, `due_at`, `last_error`, `result_uri`, `result_cid`, `idempotency_key`, `request_hash`, `import_job_id`, `created_at_ms`, `updated_at_ms`; UNIQUE(`did`, `idempotency_key`); indexes `(state, priority, due_at)`, `(did, state)` | Server outbox |
| `operation_deps` | `op_id`, `pred_id` PK | Predecessor ordering |
| `listen_keys` | (`did`, `dedupe_key`) PK, `operation_id`, `source`, `created_at_ms` | Idempotent listen ingress and import dedupe |
| `pds_budget` | (`did`, `window`) PK, `window_start_ms`, `points`, `limit_hint`, `remaining_hint`, `reset_at_ms` | Point ledger |
| `lastfm_tokens` | `token_hash` PK, `api_key`, `did`, `state` (`issued`, `authorized`, `consumed`), `created_at_ms`, `expires_at_ms` | `auth.getToken` / `getSession` |
| `lastfm_sessions` | `id` PK, `sk_hash` UNIQUE, `did`, `api_key`, `client_name`, `created_at_ms`, `last_used_ms` | Our issued Last.fm session keys |
| `lastfm_apps` | `api_key` PK, `did`, `name`, `secret_ciphertext`, `key_id`, `created_at_ms` | Per-user issued api_key/secret pairs |
| `app_passwords` | `id` PK, `did`, `label`, `hash` UNIQUE, `created_at_ms`, `last_used_ms` | `auth.getMobileSession` passwords |
| `lb_tokens` | `id` PK, `did`, `label`, `hash` UNIQUE, `created_at_ms`, `last_used_ms` | ListenBrainz user tokens |
| `now_playing` | `did` PK, `artist`, `track`, `album`, `album_artist`, `duration_seconds`, `recording_mbid`, `client`, `source`, `started_at_ms`, `expires_at_ms` | Ephemeral now playing (never a PDS record) |
| `loves` | `uri` PK, `did` → `users` ON DELETE CASCADE, `rkey`, `cid`, `artist`, `track`, `album`, `artist_key`, `track_key`, `recording_mbid`, `created_at`, `indexed_at`; indexes `(did, created_at DESC, uri DESC)`, `(did, artist_key, track_key)` | Love projection |
| `linked_accounts` | `id` PK, `did`, `service` (`lastfm`, `listenbrainz`), `remote_user`, `credential_ciphertext`, `key_id`, `forward_scrobbles`, `forward_now_playing`, `status` (`active`, `revoked`, `error`), `last_error`, `created_at_ms`, `updated_at_ms`; UNIQUE(`did`, `service`) | Linked accounts |
| `link_states` | `state_hash` PK, `did`, `service`, `session_hash`, `expires_at_ms` | Last.fm link callback state |
| `forward_outbox` | `id` PK, `link_id` → `linked_accounts` ON DELETE CASCADE, `did`, `kind` (`scrobble`, `nowplaying`, `love`, `unlove`), `dedupe_key`, `payload_json`, `state` (`queued`, `sent`, `ignored`, `failed`, `expired`, `held`), `attempts`, `due_at`, `last_error`, `created_at_ms`, `updated_at_ms`; UNIQUE(`link_id`, `kind`, `dedupe_key`); index `(state, due_at)` | Forwarding queue |
| `import_jobs` | `id` PK, `did`, `source` (`lastfm_api`, `lastfm_json`, `listenbrainz_api`, `listenbrainz_zip`), `remote_user`, `state` (`waiting_index`, `fetching`, `writing`, `paused`, `done`, `failed`, `cancelled`), `cursor_json`, `upload_path`, `fetched`, `staged`, `duplicates`, `invalid`, `written`, `failed_items`, `error`, `created_at_ms`, `updated_at_ms`, `finished_at_ms`; index `(did, state)` | Import jobs |
| `import_items` | (`job_id`, `seq`) PK, `dedupe_key`, `listened_at`, `record_json`, `state` (`staged`, `queued`, `written`, `duplicate`, `invalid`, `failed`), `operation_id`; UNIQUE(`job_id`, `dedupe_key`); index `(job_id, state, seq)` | Import staging |
| `range_stats_cache` | (`did`, `entity`, `range_key`) PK, `as_of`, `lower`, `upper`, `version`, `body`, `created_at_ms` | §10.3 |
| `backup_runs` | `id` PK, `started_at_ms`, `finished_at_ms`, `path`, `bytes`, `ok`, `error` | Backup history |

`TABLES` lists every table. Migration 2 keeps every v1 row byte-identical, and the new scrobble columns are NULL until a record is re-applied. A **re-projection** of existing rows is not needed, because no production rows exist; `POST /admin/resnapshot` can fill them later.

### 6.5 Projection changes (N3-11)
- `apply-record` and `apply-snapshot` project the §6.2 fields into the new columns and compute `recording_msid`.
- `album_artist_key` is the music key of `albumArtist`. The protocol album rankings group by `(coalesce(album_artist_key, artist_key), album_key)`. **The `/api/v1` stats keep grouping by `(artist_key, album_key)` unchanged** (§9.1 of ADR 0004).
- Love records project into `loves`, behind the same `record_state` revision guard.
- Excluded records keep their reason codes. New reason codes cover the new fields only when the field is required, so none are added.

---

## 7. Last.fm 2.0-compatible API (`worker/src/lastfm/*`)

### 7.1 Endpoint and transport
- **Root:** `https://music.214510.xyz/2.0/`, also matched as `/2.0`. Clients configure the root as follows:
  - Pano (GNU FM account type): `https://music.214510.xyz/`, and Pano appends `/2.0/`;
  - multi-scrobbler: `urlBase https://music.214510.xyz/2.0/`.
- **Methods:**
  - read methods accept GET or POST;
  - write and auth methods (`track.scrobble`, `track.updateNowPlaying`, `track.love`, `track.unlove`, `library.removeScrobble`, `auth.getMobileSession`) require POST. A GET gets error **3** "Invalid Method - this method must be called with POST".
- **Parameters** come from the query string and an `application/x-www-form-urlencoded` UTF-8 body. They are case-sensitive. A parameter that appears twice anywhere is error 6.
- **Bodies** are capped at 1 MiB.
- **Format:**
  - `format=json` (from the query or the body) gives JSON;
  - otherwise an `Accept` header containing `application/json` gives JSON (ArchiveTune);
  - otherwise XML.
  - `raw=true` drops the `<lfm>` wrapper in XML.
  - **`callback` (JSONP) is ignored**: the response is plain JSON with `nosniff`, because user-controlled script on our origin is never served.
- **Content types:** `text/xml; charset=utf-8` and `application/json; charset=utf-8`.
- **CORS:** reads get `Access-Control-Allow-Origin: *`. Write and auth methods get no CORS headers. Cookies are never read.

### 7.2 Encoding (`encode.ts`)
- Responses are built as a neutral element tree, then serialised to XML or to JSON. **Golden files** for every method pin the JSON and XML forms (`worker/test/node/lastfm/golden/`).
- **XML** escapes `& < > " '` and removes characters that XML 1.0 does not allow.
- **JSON rules:**
  - a leaf element with attributes becomes `{attr…, "#text": text}`, so an empty text is still `"#text":""`, which Pano requires;
  - a container's attributes and list attributes go under `"@attr"`;
  - repeated children become arrays, and a single child stays an object (track.scrobble with one input gives an object);
  - every number is a string, except `scrobbles.@attr.accepted`/`ignored` (numbers) and `user.registered.#text` (a number).
- **Error bodies:**
  - JSON: `{"error": <number>, "message": "<text>"}`;
  - XML: `<lfm status="failed"><error code="N">text</error></lfm>`.
- **Success:** `<lfm status="ok">…</lfm>`.

### 7.3 Authentication flows, mapped to our credentials (`worker/src/credentials/*`, `auth-methods.ts`)
**`api_key` handling.** Any non-empty `api_key` of at most 64 characters is accepted for identification. A missing one is error 10. The key never grants access on its own. Write and auth calls are authorised by **our** credentials: a session key, a token we issued, or an app password.

**Desktop flow:**
1. `auth.getToken` (signed, §7.4) returns `<token>` with 32 hex characters, valid for 60 min and single-use (`lastfm_tokens`, `issued`).
2. The client opens `https://music.214510.xyz/api/auth/?api_key=K&token=T`, which 302-redirects to the SPA page `/lastfm/authorize?api_key=K&token=T`.
3. The signed-in user sees the client name (from `ATMUSIC_LASTFM_KNOWN_CLIENTS`, the issued app's name, or `api_key` plus the request's User-Agent product) and approves. The page sends `POST /api/v1/lastfm/authorize {apiKey, token}` with cookie and CSRF, and the token becomes `authorized` for the DID.
4. `auth.getSession {token}` consumes the token and returns:
   ```
   <session><name>{username}</name><key>{sk}</key><subscriber>0</subscriber></session>
   ```
   JSON form: `{"session":{"name","key","subscriber":0}}`.

   Errors:
   - unknown or consumed token → **4**;
   - not yet authorized → **14**;
   - expired → **15**.

**Web flow:**
- `/api/auth/?api_key=K&cb=URL` → the same approval page. On approval the server creates an authorized token and the page navigates to `cb` with `?token=T`, or `&token=T` if `cb` already has a query string.
- `cb` must be an absolute URL whose scheme is not `javascript:`, `data:`, `vbscript:` or `file:`. App deep links such as `pano://` are allowed. The page shows the destination host before approval.
- If the user denies, the page does not redirect.

**Mobile flow:**
- `auth.getMobileSession {username, password}`, POST and signed. `username` is our username, a verified handle or a DID (§9). `password` is an **app password** issued in Settings, never an atproto credential.
- Errors:
  - wrong credentials → **4**;
  - `authToken` (deprecated; it would require storing `md5(password)`) → **4** "authToken is not supported; use password";
  - more than 10 attempts per username or 30 per IP in 15 min → **29**.
- The HTTPS requirement is satisfied by the public origin. Behind a tunnel the hop to us is plain loopback and is not checked.

**Session keys (`sk`):**
- 32 hex characters (128 bits), stored as SHA-256 in `lastfm_sessions`.
- No expiry. They are listed in Settings with the client name, creation time and last use, and the user revokes them there.
- A missing or unknown `sk` on an authenticated method → **9**.

**App passwords:**
- 24 base32 characters (120 bits), shown once and stored as SHA-256 (they are high-entropy, so no slow hash is needed).
- Compared in constant time.

**Issued applications (optional, Rocksky model):**
- A user can create `{api_key, shared_secret}` pairs in Settings for clients that let them enter both.
- The secret is sealed with the box (it has to be recoverable to verify signatures). With such a key, `api_sig` is **mandatory** and verified.

### 7.4 Signatures (`signature.ts`)
**Computation:**
1. Take every received parameter except `api_sig`, `format` and `callback`. `method` is included.
2. Sort by name in byte order. For example `artist[10]` sorts before `artist[1]`.
3. Concatenate `name + value`, using the decoded UTF-8 values.
4. Append the secret.
5. Take MD5 and render it in hex. The comparison is case-insensitive and constant-time.

Parameters that a client left out (Pano drops empty values) are simply absent, because **we sign exactly what we received**.

**Policy by `api_key`:**
- **Issued app key**, or a **known public pair** from `ATMUSIC_LASTFM_KNOWN_CLIENTS` (default `panoScrobbler:panoScrobbler`): `api_sig` must verify, else **13**.
- **Unknown `api_key`:** the client signed with its own embedded secret, which we cannot know. `api_sig` must be present and 32 hex characters, else **13**. It is not verified. Authorisation rests on the high-entropy `sk`, token or app password: the GNU FM, Libre.fm, Maloja and multi-scrobbler model.

This concerns only Last.fm-style request signatures. It has no bearing on atproto signature, CID, MST or identity verification, which are unchanged.

### 7.5 Methods

| Method | HTTP | Auth | Notes |
|---|---|---|---|
| `auth.getToken` | GET/POST | sig | §7.3 |
| `auth.getSession` | GET/POST | sig, `token` | §7.3 |
| `auth.getMobileSession` | POST | sig, `username`, `password` | §7.3 |
| `track.scrobble` | POST | sk, sig | §7.7 |
| `track.updateNowPlaying` | POST | sk, sig | §7.8 |
| `track.love`, `track.unlove` | POST | sk, sig | `track`, `artist` → love operations; response `<lfm status="ok"/>` / `{}` |
| `library.removeScrobble` | POST | sk, sig | GNU FM extension used by Pano: `artist`, `track`, `timestamp` → delete the owner's newest matching record at that second; no match → 6 |
| `user.getRecentTracks` | GET/POST | none | §7.9 |
| `user.getInfo` | GET/POST | none (`sk` → self when `user` is missing) | §7.9 |
| `user.getTopArtists`, `user.getTopAlbums`, `user.getTopTracks` | GET/POST | none | `period`, `limit` (default 50, clamped to 1000), `page` |
| `user.getLovedTracks` | GET/POST | none | `limit` (default 50, maximum 1000), `page` |
| `user.getWeeklyChartList` | GET/POST | none | §10.1 |
| `user.getWeeklyArtistChart`, `user.getWeeklyAlbumChart`, `user.getWeeklyTrackChart` | GET/POST | none | `from`, `to`; default is the most recent complete week |
| `user.getFriends` | GET/POST | none | The accounts the user follows (`<p>.follow`), paged |
| `library.getArtists` | GET/POST | none | Artist play counts, paged |
| `track.getInfo` | GET/POST | none | `artist`+`track` or `mbid` (a recordingMbid match), `username`, `autocorrect` (ignored) |
| `artist.getInfo`, `album.getInfo` | GET/POST | none | `username` adds `stats.userplaycount` |
| `user.getTopTags`, `artist.getTopTags`, `track.getTopTags`, `album.getTopTags` | GET/POST | none | Valid empty lists; we store no tags |

Any other method, or a missing `method`, gets error **3**. That covers the `geo.*`, `chart.*`, `tag.*` and `artist.getSimilar` packages and the rest of the 57.

### 7.6 Error codes and HTTP status
Clients must read `lfm/@status` or the JSON `error` member. The HTTP status is a convenience: Last.fm's own pairing is UNVERIFIED.

| Code | Message | HTTP |
|---|---|---|
| 2 | Invalid service | 400 |
| 3 | Invalid Method | 400 |
| 4 | Authentication Failed | 403 |
| 5 | Invalid format | 400 |
| 6 | Invalid parameters | 400 |
| 7 | Invalid resource specified | 400 |
| 8 | Operation failed | 500 |
| 9 | Invalid session key - Please re-authenticate | 403 |
| 10 | Invalid API key | 403 |
| 11 | Service Offline | 503 |
| 13 | Invalid method signature supplied | 403 |
| 14 | This token has not been authorized | 403 |
| 15 | This token has expired | 403 |
| 16 | There was a temporary error processing your request | 503 |
| 26 | Suspended API key | 403 |
| 29 | Rate Limit Exceeded | 429, with `Retry-After` |

The missing-resource cases (unknown user, unknown track, a no-match `removeScrobble`) use **6** with a specific message, as Last.fm does.

### 7.7 track.scrobble semantics (`write-methods.ts`)
**Parsing:**
- Entries are indexed `[i]` with i from 0 to 49, or a single unindexed set. Mixing the two forms, an index of 50 or more, or more than 50 entries → error **6**.
- A missing `artist`, `track` or `timestamp` in **any** entry → error **6**, and nothing is stored.

**Per entry, with Last.fm numbering for `ignoredMessage@code`.** The request still answers `status="ok"`.

| Condition | Code |
|---|---|
| `artist` invalid under the scrobble validator (empty after trim, over 256 scalars, malformed UTF-16) | 1 |
| `track` invalid | 2 |
| `timestamp < 1033430400` (2002-10-01) | 3, "too old" |
| `timestamp > receipt + 300 s` (the lexicon bound, stricter than Last.fm) | 4, "too new" |
| More than the account's `daily_listen_cap` (default 3,000 per rolling 24 h) | 5 |

Invalid optional fields are dropped (§6.2). `corrected` is always `"0"`, because we never correct.

**Accepted entries,** all in **one transaction** per request. This is the shared `acceptListens` in `worker/src/outbox/ingress.ts` (N2-05), which `/1/submit-listens` and web scrobbles use too:
1. Compute the listen key `sha256(did ‖ floor(timestamp) ‖ artist_key ‖ track_key)` (`packages/core/src/listen-key.ts`).
2. If `listen_keys` already has it, the entry is **accepted again with no new operation** (idempotent client resends).
3. Otherwise insert the `listen_keys` row, a `scrobble.create` operation (origin `lastfm`, priority 0, TID rkey allocated now, `createdAt` = receipt time, `submissionClient` = the session's client name), and the forward rows (§12).
4. The response is sent only after the commit. It means durably queued, not yet on the PDS, matching Last.fm's own asynchronous semantics.
5. The outbox timer is kicked.

**Gates:**
- With the publication gate closed → error **11**.
- An account in `reauth_required` still accepts: the operations wait as `blocked`, and the UI asks for sign-in.

Scrobbles become PDS records through the outbox (§5.8) and become visible to reads only once they are indexed (proof-gated).

### 7.8 Now playing and loves
**`track.updateNowPlaying`:**
- Upserts `now_playing`. It expires at `started + duration` when `duration` is between 30 and 5,400 s, otherwise at `started + 600 s`.
- An identical artist and track while the entry is still current only refreshes it.
- Response: `<nowplaying>` with `track`, `artist`, `album` and `albumArtist`, each with `corrected="0"`, and `ignoredMessage code="0"`; in JSON `"#text":""`.
- Never retried, never a PDS record. It is forwarded to links once (§12).
- Visible on reads only when `share_now_playing=1` (the default).

**`track.love` and `track.unlove`:** enqueue `love.put` and `love.delete` (§6.3) and forward rows.

### 7.9 Read semantics
**Users.** The `user` parameter is resolved as in §9. Unknown, inactive or suppressed users → **6** "User not found". Only indexed (proof-verified) data is ever shown. Pending operations and staged imports are not.

**URLs and images:**
- user `url` = `https://music.214510.xyz/u/<did>`;
- artist, track and album `url` = the Last.fm-style URL `https://www.last.fm/music/<enc artist>[/_/<enc track>]` (§18 Q10);
- `image` = the four sizes `small`, `medium`, `large`, `extralarge`, each with `"#text":""`;
- `streamable` = `"0"`; `mbid` = the stored MBID or `""`.

**`user.getRecentTracks`:**
- Parameters: `limit` (default 50, clamped to 1–200), `page` (≥ 1), `from` and `to` (UNIX s; exclusive bounds `from < t < to`), `extended` (0 or 1).
- Order is newest first by `(listened_at, uri)`. Paging is offset-based over the bounded set, and `@attr` carries `{user, page, perPage, totalPages, total}`.
- `date = {"uts": floor(s), "#text": "DD Mon YYYY, HH:MM"}` in UTC.
- A current now-playing entry is prepended **on page 1 only**, in addition to `limit`, with `@attr.nowplaying="true"` and no `date`.
- `extended=1` makes `artist` an object `{name, mbid, url, image}` and adds `"loved":"0"|"1"`.

**`user.getInfo`:**
- `name` (username), `realname` `""`, `url`, `country` `"None"`, `age` `"0"`, `gender` `"n"`, `subscriber` `"0"`, `playlists` `"0"`, `bootstrap` `"0"`, `type` `"user"`, `image`;
- `playcount`, `artist_count`, `track_count`, `album_count` (all-time distinct counts);
- `registered {unixtime: "<joinedAt s>", "#text": <number>}`.

**Top lists** (`getTopArtists`, `getTopAlbums`, `getTopTracks`): from the range engine (§10). Items carry `@attr.rank` and `playcount`. Tracks add `duration` (seconds, from the newest record with a duration, else `"0"`). Albums use the album-artist grouping.

**`track.getInfo`:**
- `name`, `mbid`, `url`, `duration` (**milliseconds**), `listeners` (distinct active DIDs in our index), `playcount` (all indexed listens);
- `artist {name, mbid, url}`, and `album` from the newest record carrying one;
- `toptags {tag: []}`;
- with `username`: `userplaycount` and `userloved`.

**`artist.getInfo` and `album.getInfo`:**
- `stats {listeners, playcount, userplaycount?}`, empty `similar` and `tags`, and `bio {summary: "", content: ""}`;
- albums add `tracks.track[]`, the distinct tracks seen on that album.

### 7.10 Audioscrobbler 1.2 / 1.2.1
**Not supported** in this ADR. A 1.2 handshake token is `md5(md5(password) + t)`, so the server would have to hold a password-equivalent per user.
- The path `/audioscrobbler/` is reserved.
- A handshake (`?hs=true`) answers `FAILED Protocol 1.2 is not supported; use the Last.fm 2.0 or ListenBrainz API`, plain text with status 200. 1.2 clients read the body, not the status.
- Clients that speak only 1.2 (mpdscribble, Quod Libet) are unsupported (§18 Q9).

---

## 8. ListenBrainz-compatible API (`worker/src/listenbrainz/*`)

### 8.1 Base URL and CORS
- The root is `https://music.214510.xyz/`, with every endpoint under `/1/`. That fits all three client conventions:
  - an API root, where the client appends `1/` (Pano, Jellyfin, Music Assistant, multi-scrobbler);
  - a base that already includes `/1/` (Navidrome `ND_LISTENBRAINZ_BASEURL=https://music.214510.xyz/1/`);
  - the full submit URL (Web Scrobbler `https://music.214510.xyz/1/submit-listens`).
- Every `/1/` response sends `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Authorization, Content-Type` and `Access-Control-Max-Age: 21600`. OPTIONS gets 200.
- Cookies are never read.

### 8.2 Tokens
- **Tokens** are UUIDv4 values we issue (122 random bits, `POST /api/v1/account/listenbrainz-tokens`). They are shown once, stored as SHA-256 in `lb_tokens`, and labelled. A user can hold several.
- **Header:** `Authorization: <scheme> <token>`, with the scheme `Token` matched case-insensitively. Pano sends lowercase `token`. `Bearer` is also accepted.
- **Errors**, with ListenBrainz's verbatim texts, all 401:
  - missing header: "You need to provide an Authorization header.";
  - no space: "Provided Authorization header is invalid.";
  - unknown token: "Invalid authorization token.".
- **`GET /1/validate-token`:**
  - reads the header when it starts with `token ` (case-insensitive), otherwise `?token=`;
  - valid → 200 `{"code":200,"message":"Token valid.","valid":true,"user_name":"<username>"}`;
  - invalid → 200 `{"code":200,"message":"Token invalid.","valid":false}`;
  - none → 400 `{"code":400,"error":"You need to provide an Authorization token."}`.
  - `valid` is a JSON boolean, which Music Assistant requires.
- MetaBrainz `meba_` OAuth tokens are not ours and are rejected as invalid.

### 8.3 `POST /1/submit-listens`
- **Envelope checks,** in ListenBrainz's order with its verbatim messages, all 400:
  1. body over 10,240,000 bytes;
  2. unparsable JSON;
  3. top level not an object;
  4. `payload` not a list;
  5. empty payload;
  6. more than 1,000 listens;
  7. raw body larger than 10,240 bytes × number of listens;
  8. bad `listen_type`;
  9. `single` or `playing_now` with more than one listen;
  10. a missing key → "Invalid JSON document submitted.".
- **Per-listen checks** follow ListenBrainz `validate_listen` exactly, with one deliberate difference:
  - `listened_at` is coerced with `int()` and must be ≥ 1033430400;
  - `listened_at` must be **≤ now + 300 s** ("Value for key listened_at is too high."). ListenBrainz allows 3,600 s, but our lexicon bound is +300 s, and a listen accepted here must never become a record that our own indexer excludes;
  - `playing_now` must omit `listened_at`;
  - only the allowed top-level keys;
  - `artist_name` and `track_name` are required, must be strings, are trimmed and must be non-empty;
  - an empty `release_name` is deleted;
  - `duration` and `duration_ms` together are rejected, and each is range-checked;
  - MBIDs: null or empty values are deleted, other invalid values give "`<key>` MBID format invalid.";
  - at most 50 tags of at most 64 characters (validated, then dropped);
  - NUL anywhere is rejected.
- **Our extra rule:** `artist_name` or `track_name` failing our scrobble validator (for example more than 256 scalars) → 400 "track_metadata.`<key>` is too long or invalid.". **One invalid listen rejects the whole request, and nothing is stored.**
- **Error body:** `{"code":400,"error":"…"}`. The offending listen's keys are not merged in.
- **`single` and `import`:** the same transaction as §7.7 (listen key, operation with origin `listenbrainz` and priority 0, forward rows). The daily cap gives 429 "Daily listen limit exceeded.". A client `import` (an offline cache flush) is a live submission, not an import job.
- **`playing_now`:** upserts `now_playing`. The TTL is `duration`, else `duration_ms`/1000, else 600 s. An identical current track is ignored but still answers ok.
- **`return_msid`:** any non-empty value counts (ListenBrainz's truthiness). Response `{"status":"ok","recording_msid":"<msid>"}`.
- **Success:** 200 `{"status":"ok"}`. Publication gate closed → 503 `{"code":503,"error":"Cannot submit listens to queue, please try again later."}`.

### 8.4 Reads
`{user}` is resolved as in §9. Unknown users get 404 `{"code":404,"error":"Cannot find user: <path value>"}`. `user_id` echoes the path value as typed.

**`GET /1/user/{user}/listens`:**
- `min_ts` and `max_ts` are exclusive bounds. `max_ts ≤ min_ts` → 400 "max_ts should be greater than min_ts".
- `count`: default 25, silently capped at 1,000; negative → 400.
- With `min_ts`, the query takes the oldest `count` listens after it, then reverses them, so output is always newest first.
- Payload: `{count, listens, latest_listen_ts, oldest_listen_ts, user_id}`.
- Each listen: `{listened_at, inserted_at (indexedAt s), recording_msid, user_name, track_metadata {artist_name, track_name, release_name?, additional_info {…mapped fields, submission_client?}}}`. `mbid_mapping` is omitted, because we do no MusicBrainz mapping.

**Other reads:**
- `GET /1/user/{user}/playing-now` → `{payload: {count, user_id, playing_now: true, listens: [{track_metadata, user_name, playing_now: true}]}}`, or count 0 and `[]`.
- `GET /1/user/{user}/listen-count` → `{payload: {count}}`.

**`recording_msid`** = UUIDv5(namespace `5d1f3e2a-8b47-4c6e-9f10-2a7c3b9d0e45`, `artist_key ‖ U+0000 ‖ track_key`) (`packages/core/src/msid.ts`). It is stable and equal for listens with the same normalised metadata, which matches ListenBrainz's per-metadata MSID semantics. It is stored in `scrobbles.recording_msid`.

### 8.5 Statistics
**Entity endpoints,** `GET /1/stats/user/{user}/{artists|releases|release-groups|recordings}`:
- Parameters: `range` (§10.1, default `all_time`; invalid → 400 "Invalid range: x"), `count` (default 25, cap 1,000), `offset`; non-negative integers else 400.
- **204** with an empty body when the range holds no listens; 404 for an unknown user.
- Payload: `{user_id, <entity list>, count, total_<artist|release|release_group|recording>_count, offset, range, from_ts, to_ts, last_updated (= now; computed on read)}`.
- Items carry the pydantic fields with nulls, never omitted:
  - **artists:** `artist_mbid`, `artist_name`, `listen_count`;
  - **releases:** `artist_mbids`, `release_mbid`, `release_name`, `listen_count`, `artist_name`, `artists`: null, `caa_id`: null, `caa_release_mbid`: null;
  - **release-groups:** group like releases and report `release_group_mbid` and `release_group_name` (= the album) from the newest record;
  - **recordings:** `artist_name`, `artist_mbids`, `recording_mbid`, `release_name`, `release_mbid`, `track_name`, `listen_count`, `caa_id`, `caa_release_mbid`, `artists`.

**`GET /1/stats/user/{user}/listening-activity`:** `{listening_activity: [{from_ts, to_ts, time_range, listen_count}], from_ts, to_ts, range, last_updated}`. Buckets and labels follow §10.1.

**`GET /1/stats/user/{user}/daily-activity`:** `{daily_activity: {Monday: [{hour, listen_count} × 24], …}}`, zero-filled, UTC.

**Not implemented (404):** `artist-map`, `era-activity`, `genre-activity`, `artist-evolution-activity`, and `/1/stats/sitewide/*`. They need MusicBrainz data we do not have.

### 8.6 Feedback, social, deletes
**Feedback:**
- `POST /1/feedback/recording-feedback {recording_msid | recording_mbid, score}` (token required):
  - score 1 = love;
  - 0 = unlove;
  - **-1 ("hate") clears a love**, documented as a deviation: we have no hate state;
  - the MSID is mapped back through `scrobbles.recording_msid` for the user's own listens; unknown → 400 "Recording not found.".
- `GET /1/feedback/user/{user}/get-feedback?score&count&offset&metadata` → `{feedback: [{recording_msid, recording_mbid, score: 1, created, track_metadata?}], count, total_count, offset}`.

**Social:** `GET /1/user/{user}/following` → `{following: [names], user}`, and `/followers` → `{followers: [names], count, user}`, from the follow records.

**Deletes and now playing:**
- `POST /1/delete-listen {listened_at, recording_msid}` (token) → a `scrobble.delete` operation for the newest matching own record at that second; `{"status":"ok"}`.
- `POST /1/playing-now/delete {client?}` (token) → clears it: `{"status":"ok","message":"Playing now cleared successfully"}`, "…already cleared" if nothing was playing, and 404 if `client` does not match.

**Not implemented (404):** `/1/metadata/*`, `/1/latest-import`, `/1/export/*` and playlists.

### 8.7 Rate limits
- Per IP: 30 requests per 10 s on `/1/`. Per token: 100 requests per 10 s.
- Headers: `X-RateLimit-Limit`, `-Remaining`, `-Reset`, `-Reset-In`, and `Access-Control-Expose-Headers` listing them.
- Over the limit: 429 `{"code":429,"error":"You have exceeded your rate limit. See the X-RateLimit-* response headers for more information on your current rate limit."}`.

---

## 9. User names across protocols
- Both protocols need a stable `user` name, and handles are mutable.
- Each signed-in DID gets `accounts.username`. On first sign-in it is derived from the verified handle: lowercased, characters outside `[a-z0-9._-]` removed, truncated to 64, with `-2`, `-3` … appended on collision. It never changes automatically. The user may rename it (409 if taken).
- A protocol `user` value (Last.fm `user`/`username`, ListenBrainz `{user}`, `getMobileSession username`) resolves, in this order, as:
  1. an `accounts.username`, case-insensitive;
  2. a currently verified handle, case-insensitive;
  3. a DID.
- Users who never signed in (indexed through Jetstream) have no username and are addressed by handle or DID.
- Responses name a user by username when one exists, else by verified handle, else by DID. ListenBrainz `user_id` echoes the path.

---

## 10. Statistics

### 10.1 Periods (`packages/core/src/periods.ts`)
All periods are UTC with half-open bounds `[lower, upper)` unless noted. `now` is the request clock.

**Last.fm rolling periods:**

| Period | Bounds |
|---|---|
| `overall` | `(−∞, now]` |
| `7day` | `[now − 7 d, now]` |
| `1month` | `[now − 30 d, now]` |
| `3month` | `[now − 90 d, now]` |
| `6month` | `[now − 180 d, now]` |
| `12month` | `[now − 365 d, now]` |

An unknown `period` is error 6.

**Last.fm weekly charts:**
- Week boundaries are **Sundays at 12:00 UTC**, matching the documented sample `1108296002`.
- `getWeeklyChartList` lists every week from the one containing the user's first listen to the current one.
- `from`/`to` select `[from, to)`. Without them the last complete week is used.

**ListenBrainz calendar ranges.** Computed on read and anchored on **now**, not on the latest listen. ListenBrainz's "if today is Monday, use last week" quirk is an artefact of its daily batch job, and is documented as a deviation.

| Range | Bounds |
|---|---|
| `this_week` | `[Monday 00:00 of the current week, now]` |
| `week` | The previous Monday-to-Monday week |
| `this_month` | `[1st of the month, now]` |
| `month` | The previous calendar month |
| `quarter` | The previous calendar quarter |
| `half_yearly` | The previous Jan–Jun or Jul–Dec |
| `this_year` | `[Jan 1, now]` |
| `year` | The previous calendar year |
| `all_time` | `[2002-01-01, now]` |

**ListenBrainz listening-activity windows and buckets:**

| Range | Window | Bucket | `time_range` label |
|---|---|---|---|
| `week`, `this_week` | The range and the one before | day | `%A %d %B %Y` |
| `month`, `this_month` | The range and the one before | day | `%d %B %Y` |
| `quarter` | The range and the one before | day | `%d %B %Y` |
| `half_yearly` | The range and the one before | month | `%B %Y` |
| `year`, `this_year` | The range and the one before | month | `%B %Y` |
| `all_time` | All years | year | `%Y` (only years with listens) |

**`/api/v1` windows** (`all`, `7d`, `30d`, `365d`, both bounds inclusive) are **unchanged**, as are their module (`worker/src/do/read/stats.ts`) and their TESTING.md assertions.

### 10.2 Engine (`worker/src/do/read/range-stats.ts`, N2-06)
- **Computed on read** with the ADR 0004 §5.8 SQL shape, generalised to arbitrary `[lower, upper)` bounds plus `LIMIT/OFFSET`, and to album-artist grouping.
- **Totals:** listens, distinct artists, tracks and albums.
- **Ordering:** count descending, then the normalised tuple ascending in byte order. Display text comes from the newest `(listened_at, uri)` row.
- **Paging:** offset-based. A deep offset costs O(offset) index steps, which is bounded by the user's history.
- **Global counts** (`listeners`, global `playcount`) use the new `scrobbles_*_global` indexes.

### 10.3 Cache: decision and budget
**Decision: compute on read with an exact cache, not pre-aggregated.**
- With no 10 ms CPU limit, one local process and SQLite on NVMe, a group-by over a 100k-listen user is tens of milliseconds.
- Pre-aggregation would add write amplification to every apply, delete and suppression path, plus re-aggregation on deletion, and it would make the proof-gated, revision-guarded projection harder to keep exact.

**`range_stats_cache`** holds the **full ranked list** per `(did, entity, range_key)`. Bodies over 4 MiB are not cached.
- Fixed calendar ranges are valid while `users.stats_version` is unchanged.
- Sliding ranges also need the two `EXISTS` probes of ADR 0004 §5.8: no row crossed the lower or the upper bound since the cached `as_of`.

A hit serves any page with the current `as_of`. Results equal the uncached computation; tests assert that.

**Budgets** (N4-03, report-only): on the 100k-listen fixture, uncached top tracks overall p95 < 250 ms, cached hit < 20 ms, `getRecentTracks` page 500 < 100 ms. The gate asserts query plans, not timings (§15).

---

## 11. Import from Last.fm and ListenBrainz (`worker/src/imports/*`)

### 11.1 Sources
| Source | How | Requirements |
|---|---|---|
| `lastfm_api` | `user.getRecentTracks` with `limit=200`, `extended=1`, our api_key, the `sk` of a linked Last.fm account when one exists (needed for hidden recent listening), and a fixed `to` set at job start. Paging walks **backward**: the next request's `to` is the page's oldest `uts` + 1, and listens at that boundary second are deduplicated. If a page brings nothing older, `to` becomes the oldest `uts`, so progress is guaranteed. The `nowplaying` row is skipped. | The owner's Last.fm key. Otherwise 503 `lastfm_not_configured`. |
| `lastfm_json` | Upload of the lastfm.ghan.nl export: a JSON array of getRecentTracks pages. | None |
| `listenbrainz_api` | `GET /1/user/{name}/listens?count=1000&max_ts=…`, walking backward. The next `max_ts` is the oldest `listened_at` + 1, deduplicated, with the same progress rule. The user's linked token is sent when present. | None. A 100k history is about 100 requests. |
| `listenbrainz_zip` | Upload of the ListenBrainz export ZIP: `listens/<YYYY>/<M>.jsonl`, float `listened_at`, null `mbid_mapping`. | None |

- **Upload limits:** body ≤ 64 MiB, streamed to `ATMUSIC_UPLOAD_DIR/<job>.upload` (mode 0600).
- **ZIP parsing** uses `fflate` (pinned exactly, newest ≥ 7 days at pin time) with bomb bounds: ≤ 10,000 entries, ≤ 512 MiB uncompressed in total, a ratio ≤ 100 per entry, and entry names restricted to `listens/\d{4}/\d{1,2}\.jsonl`, `user.json` and `feedback.jsonl`. Anything else is ignored.
- **Feedback** with score 1 in an upload is imported as loves.

### 11.2 Pipeline and dedupe
1. **Wait.** A job starts in `waiting_index` until the DID's `indexing_state='current'`. Its existing PDS records must be indexed before dedupe means anything.
2. **Fetch.** Each fetched or parsed listen is mapped (`protocol-map.ts`). Invalid listens are counted as `invalid`. Valid ones are staged in `import_items` with their listen key (§7.7).
3. **Dedupe** by listen key against:
   - the DID's indexed scrobbles (`scrobbles` joined on the second, `artist_key` and `track_key`);
   - `listen_keys` (anything already submitted through any ingress);
   - earlier items of the same job (UNIQUE).

   Duplicates are counted and never written. Matching is **exact to the second**. Rocksky's ±120 s window would drop legitimate repeats. The same listen imported from both services yields one record.
4. **Write.** Staged items become `scrobble.create` operations with **origin `import` and priority 1**, in slices of 1,000. The outbox sends them as 200-write `applyWrites` batches within the import share of the PDS budget (§5.8). `createdAt` is the operation's creation time.
5. **Never forwarded.** Imported listens go to no link, which prevents loops. A listen that was forwarded and is later re-imported is deduplicated by its listen key.

### 11.3 Pacing
- **Last.fm:** one global token bucket of 1 request per second for all Last.fm traffic, shared with forwarding, which goes first. Codes 29, 11, 16 and 8, HTTP 5xx and 429 back off at 30 s·2^n, capped at 1 h.
- **ListenBrainz:** at most 1 request per second, honouring `X-RateLimit-Remaining` and `X-RateLimit-Reset-In`.
- **At most 2 jobs fetch concurrently** server-wide. A DID has at most 1 active job: a second gets 409 `import_active`.
- **PDS:** at the default 50% share, a 100k import costs 300,000 points and takes about **17 days** (about 5,800 creates per day under the 35,000-point daily cap). The UI presents imports as a multi-day background job. Imported listens appear in history and stats as they are indexed. There is no staging view (§18 Q6).

### 11.4 Progress, control and resume
**Routes:**
- `POST /api/v1/imports {source: "lastfm"|"listenbrainz", username}` → 202 `ImportJob`;
- `POST /api/v1/imports/upload?source=lastfm_json|listenbrainz_zip` (raw body) → 202;
- `GET /api/v1/imports` and `GET /api/v1/imports/{id}` → `ImportJob {id, source, remoteUser, state, fetched, staged, duplicates, invalid, written, failed, etaSeconds, error, createdAt, updatedAt}`;
- `POST /api/v1/imports/{id}/cancel` stops new operations; already queued ones finish;
- `POST /api/v1/imports/{id}/resume` resumes a `paused` job.

**ETA** = remaining items × 3 points ÷ the current import points per hour.

The UI polls every 5 s.

**Resume after restart.** The cursor (`to`/`page` or `max_ts`), staged items and operations with their allocated rkeys are all in SQLite. After a restart the `import` timer continues from the stored cursor. An in-flight batch is retried with the same rkeys, and ambiguous-create digest reconciliation makes the retry idempotent.

**Pause:** `reauth_required` pauses the job, as do an upstream 401 and the upstream rate limit.

**Terms of use.** Last.fm's terms (non-commercial use, credit "powered by AudioScrobbler", the 100 MB stored-data cap) apply to the owner's key. Imported listens become the user's own PDS records, and we keep no Last.fm cache beyond staging. **Staging rows are deleted 7 days after a job finishes.** The UI shows "Data from Last.fm" with the credit on the import screen.

---

## 12. Forwarding to linked accounts (`worker/src/forward/*`)

### 12.1 Linking
**Last.fm** (needs the owner's key):
1. `POST /api/v1/links/lastfm/start` → `{authorizeUrl: LASTFM_AUTH_URL + "?api_key=<ours>&cb=" + enc("https://music.214510.xyz/api/v1/links/lastfm/callback?state=<S>")}`. `S` is single-use, valid 600 s, and bound to the session.
2. `GET /api/v1/links/lastfm/callback?state&token` calls signed `auth.getSession`, stores the `sk` sealed (HKDF info `lastfm`) with `remote_user = session.name`, then 303-redirects to `/settings/links`.

**ListenBrainz:** `POST /api/v1/links/listenbrainz {token}` is validated with `GET /1/validate-token` on `LISTENBRAINZ_API_ROOT`. Invalid → 422. Otherwise the token is stored sealed with `remote_user = user_name`.

**Management:**
- `GET /api/v1/links`;
- `PATCH /api/v1/links/{id} {forwardScrobbles, forwardNowPlaying}`, both default true;
- `DELETE /api/v1/links/{id}` deletes the credential and all its queued rows (cascade).

Last.fm has no revoke API, so the UI tells the user to revoke at last.fm/settings/applications. ListenBrainz tokens are revoked by resetting them at listenbrainz.org.

### 12.2 What is forwarded
Forwarded: scrobbles, now-playing and love/unlove **received through our server**, meaning the Last.fm-compatible API, the ListenBrainz-compatible API and the web form. The forward rows are created **in the same transaction as acceptance**, so forwarding does not wait for the PDS write.

Not forwarded:
- imports;
- records that other apps wrote and we only indexed;
- deletes, which Last.fm cannot represent through `track.scrobble`.

Each row's `dedupe_key` is the listen key, unique per `(link_id, kind, dedupe_key)`, so a client resend never double-forwards.

### 12.3 Delivery, retry and revocation

| | Last.fm | ListenBrainz |
|---|---|---|
| **Request** | Signed `track.scrobble` with ≤ 50 queued rows per link, oldest first, the original uncorrected input, and the global 1 request/s bucket. `updateNowPlaying` once. `track.love`/`track.unlove`. | `single` for one live listen; `import` with ≤ 100 rows for a backlog; `playing_now` once; `feedback/recording-feedback` by `recording_mbid` when known, otherwise not forwarded. One request per second per link. |
| **Success** | Per item: code 0 → `sent`; a non-zero `ignoredMessage` → `ignored`, recorded and not retried. | 200 → `sent`. |
| **Retry** | Codes 11, 16, 29, 8, HTTP 5xx or 429, network errors: backoff `30 s·2^n + U[0, 25%]`, capped at 6 h. Last.fm drops scrobbles older than about 14 days, so a row older than **13 days** becomes `expired`. | 5xx, 503 and network errors: the same backoff and expiry. 429: wait `X-RateLimit-Reset-In`. 400: row `failed` with the error, not retried. |
| **Revocation** | Codes 9 or 4: link `revoked`, its rows `held` (kept 30 days, resumed on relink). Codes 10 or 26 (our key is invalid or suspended): **all** Last.fm forwarding pauses, and `adminStatus` raises `lastfm_key_rejected`. | 401: link `revoked`, rows `held`. |
| **Now playing** | Sent once with no retry, skipped if more than 60 s old. | Same. |

**Idempotency upstream** is **at least once**. A request that times out after the upstream accepted it can be duplicated on retry. Neither service offers an idempotency key, and this is documented.

---

## 13. Security

| Concern | Realisation |
|---|---|
| **Verification** | Unchanged. No production flag can skip TLS, signature, CID, MST, DNS or IP policy, or the OAuth issuer check. Indexing is only through proofs. The Node build re-proves every crypto vector (§3.9). |
| **SSRF** | The pinned transport applies to every outbound fetch (§3.5): PDS, AS, PLC, Last.fm, ListenBrainz. Loopback, LAN, link-local, CGNAT, ULA, multicast and reserved addresses are refused at connect time. Admin routes are not on TCP at all. |
| **Secrets** | Delivered as a systemd credential (§3.8), never in the environment. User credentials at rest are AES-256-GCM with AAD: OAuth sessions and states, linked `sk` and ListenBrainz tokens, and issued app secrets. Our own issued bearer credentials (session keys, ListenBrainz tokens, app passwords, web sessions) are stored only as SHA-256, and their random values are shown once. |
| **No secret in logs** | The logger drops fields whose names match `/token\|sk\|password\|secret\|authorization\|cookie\|api_sig\|key\|dpop\|jwk/i`. Request logs record method, route pattern, status and duration, with **no query string and no body** on `/2.0`, `/1/`, `/oauth/` and `/api/v1/auth`. A test captures all log output of the in-process journeys and fails if any secret value seen in the run appears in it. Error envelopes never echo credentials. |
| **CSRF** | §5.6: exactly one Origin plus the HMAC token, on cookie routes only. Protocol routes ignore cookies. The OAuth and link callbacks use single-use state bound to the session. |
| **Cookies** | `__Host-` prefix, HttpOnly, Secure, SameSite=Lax. Only hashes are stored. 30 days with renewal. |
| **Trusted proxy headers** | §3.6. `PUBLIC_ORIGIN` is the only source of URLs and of the expected Origin. Behind a tunnel, `Host` and `X-Forwarded-*` are never trusted for security decisions. Host mismatch → 421. |
| **Rate limits** | In-memory buckets (`worker/src/http/limits.ts`, fail-open after a restart, documented), keyed by the trusted client IP and by credential: <br>• `/api/v1` notify: 60/min per IP and 600/h per DID (unchanged); <br>• `auth/start`: 10/min per IP; <br>• `getMobileSession`: 10 per 15 min per username and 30 per 15 min per IP; <br>• `/2.0`: 60/min per IP for reads and 120/min per `sk` for writes; <br>• `/1/`: §8.7; <br>• uploads: 3/h per DID. <br>Daily listen cap: 3,000 per DID. Cloudflare Free's single WAF rule can coarsely shield `/2.0/` and `/1/submit-listens` (owner's choice). |
| **Abuse** | Body caps per route, JSON depth ≤ 32, and ZIP bomb bounds. Only signed-in DIDs can hold protocol credentials. New DIDs enter ingestion only through admission (unchanged). The open `api_key` policy does not let anyone write without our credential. |
| **XSS** | The CSP tightens to `connect-src 'self'`. JSONP is not served. XML and JSON are encoded, never templated. `dangerouslySetInnerHTML` stays banned. The Last.fm approval page shows the callback host and requires a click. |
| **Open redirect** | The Last.fm `cb` is followed only after explicit approval, with dangerous schemes refused. `returnTo` after OAuth must be a known SPA path. |
| **Single instance** | The admin-socket probe at startup (§3.10). |
| **Residuals** | Local processes can reach `127.2.0.1:8888` and forge `CF-Connecting-IP` (single-user host; documented). A stolen db file or backup does not reveal sessions without the encryption key. A stolen secrets file plus the db does. |

---

## 14. Operations

### 14.1 systemd user units (`config/systemd/`, installed by `scripts/install-local.sh`, N4-02)
`~/.config/systemd/user/atmusic.service` follows. Every directive in it was tested on this host by the ops research, except where noted.
```ini
[Unit]
Description=atmusic (AT Protocol music AppView, Last.fm/ListenBrainz compatible)
StartLimitIntervalSec=10min
StartLimitBurst=10
[Service]
Type=notify
NotifyAccess=all
WatchdogSec=60s
WatchdogSignal=SIGKILL
WorkingDirectory=%h/.local/lib/atmusic/current
ExecStart=/usr/bin/node --enable-source-maps %h/.local/lib/atmusic/current/worker/dist/node/main.mjs
Environment=NODE_ENV=production ATMUSIC_LISTEN=127.2.0.1:8888 ATMUSIC_PUBLIC_ORIGIN=https://music.214510.xyz
EnvironmentFile=-%E/atmusic/atmusic.env
ConfigurationDirectory=atmusic
StateDirectory=atmusic
StateDirectoryMode=0700
RuntimeDirectory=atmusic
RuntimeDirectoryMode=0700
LoadCredentialEncrypted=secrets:%E/atmusic/secrets.cred
Restart=on-failure
RestartSec=2s
RestartSteps=5
RestartMaxDelaySec=2min
TimeoutStopSec=30s
KillMode=mixed
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
MemoryHigh=768M
MemoryMax=1G
TasksMax=256
LimitNOFILE=8192
SyslogIdentifier=atmusic
[Install]
WantedBy=default.target
```
**Forbidden or unreliable directives:**
- **Never** `MemoryDenyWriteExecute`: V8's JIT aborts under it.
- **No reliance** on `IPAddressDeny`/`IPAddressAllow`: they are not enforced in user units.
- **No** `PrivateNetwork`: outbound traffic is required.

**Unverified directive.** If `~@resources` causes EPERM under the full workload, drop only that line.

**Paths:**
- **State:** `~/.local/state/atmusic`, through `StateDirectory=`, the systemd-native choice. It holds `atmusic.db`, `backups/` and `imports/`. `ATMUSIC_DB` can point elsewhere, for example `~/.local/share/atmusic` with `ReadWritePaths=`.
- **Config:** `~/.config/atmusic` (`atmusic.env`, `secrets.cred`).
- **Runtime:** `$XDG_RUNTIME_DIR/atmusic/admin.sock`.

**Optional `atmusic.socket`** (`ListenStream=127.2.0.1:8888`, `Accept=no`) keeps the port open across restarts, so a tunnel sees queued connections instead of 502s.

**Linger:** `loginctl enable-linger` is required. It is allowed for self without authentication on this host (polkit `set-self-linger`). With linger, the user manager starts at boot without the Plasma session environment, so the unit sets everything it needs and does not depend on `graphical-session.target`.

**Activate:**
```sh
loginctl enable-linger
systemctl --user daemon-reload
systemctl --user enable --now atmusic
```
`install-local.sh` prints these commands. It runs them only with `--enable`, and it never touches linger without being asked.

**Logs:** `journalctl --user -u atmusic`, as JSON lines with `<N>` priority prefixes.

### 14.2 Secrets setup
```sh
npx tsx scripts/admin/gen-secrets.ts > secrets.json     # 0600; then add "lastfm": {apiKey, sharedSecret}
systemd-creds --user encrypt --name=secrets secrets.json ~/.config/atmusic/secrets.cred && shred -u secrets.json
```
- The credential is bound to this machine's TPM2 and host key plus the UID, so **keep the plaintext secrets in a password manager**. A `.cred` file is useless on another host.
- **Simpler fallback:** `LoadCredential=secrets:%E/atmusic/secrets.json` with a 0600 plaintext file.
- Losing the secrets costs the following:
  - **OAuth keys or encryption key:** every user signs in again and re-links;
  - **cursor key:** outstanding cursors are invalidated.

### 14.3 Upgrades and rollback
1. Build outside the service:
   ```sh
   git worktree add ~/.local/lib/atmusic/releases/<sha> <sha>
   cd ~/.local/lib/atmusic/releases/<sha>
   npm ci && npm run build:web && npx tsx scripts/build-server.ts
   ```
   `npm ci` never runs inside the sandboxed unit.
2. `atmusic-admin backup`. The server also takes a pre-migration backup itself when a migration is pending.
3. Switch the link atomically: `ln -sfn releases/<sha> current.tmp && mv -T current.tmp current`.
4. `systemctl --user restart atmusic`, then poll `/health/ready`.

**Rollback:** point the link back and restart. If the new release migrated the schema, the old code sees `too_new` (503), so rollback also restores the pre-migration backup (`scripts/admin/restore.ts`). Writes made since then are re-derived from PDSes by snapshots.

**Gentoo:** Node links against the system `libsqlite3` (`dev-db/sqlite-3.54.1`). After `emerge -u` of nodejs or sqlite, restart the service. The owner can pin versions with `package.mask`.

### 14.4 Health and monitoring
- `/health/live` and `/health/ready` (§3.10), plus the systemd watchdog. systemd has no HTTP health check, and none is needed.
- `atmusic-admin status` shows backup age, Jetstream lag, outbox and forward depths, import progress, `reauth_required` count, sessions per `client_kid`, and Last.fm key health.
- An optional external probe is documented, not installed.

### 14.5 Backups (`worker/src/node/backup.ts`, N2-01)
**In-process, daily at 03:30 UTC and on demand (`atmusic-admin backup`):**
1. `VACUUM INTO 'backups/atmusic-YYYYMMDDTHHMMZ.db.tmp'` on the writer's own connection.
2. `PRAGMA integrity_check` on the copy.
3. Rename, fsync the directory, and record a `backup_runs` row.
4. Retention: 7 daily and 4 weekly. Files are mode 0600.

**Pre-migration backup:** at startup when `SCHEMA_VERSION` is above the db's version.

**What a backup contains:** the derived index, which can be rebuilt from public repositories, plus the **non-derived** accounts, sessions, links, credentials hashes, operations, imports and forward queue. Credentials inside are ciphertext under keys that are **never in the backup**. This supersedes ADR 0004 A15 ("derived data, no file backup").

**Restore** (`scripts/admin/restore.ts <file>`):
1. Refuse while the admin socket answers.
2. Move the current db aside as `.pre-restore`, removing `-wal` and `-shm`.
3. Copy the backup in.
4. Start the service.

**Offsite copies** are the owner's choice (`rclone` to the R2 free tier, or an external disk), documented and not built. Litestream is opt-in only, since it is a second resident process, and needs `sync-interval ≥ 1m` to stay inside R2's free operations.

### 14.6 Public exposure (owner's choice; documented in `docs/deploy/exposure.md`)
**A. Cloudflare Tunnel (recommended):**
- `cloudflared` runs as a second user unit. Ingress: `hostname: music.214510.xyz → service: http://127.2.0.1:8888`, then a catch-all `http_status:404`.
- It is outbound-only (port 7844), needs no public IP, and sends `CF-Connecting-IP`.
- The edge read timeout is 125 s, so long work stays asynchronous.
- Set `ATMUSIC_CLIENT_IP_HEADER=cf-connecting-ip`.

**B. Caddy or nginx on this host:**
- Listens on `:443` and proxies to `127.2.0.1:8888`, with port forwarding and either ACME or Cloudflare proxied DNS plus Authenticated Origin Pulls.
- Needs a reachable public IP; CGNAT, dynamic IPs and port blocks are risks.
- Set `ATMUSIC_CLIENT_IP_HEADER=x-forwarded-for`.

**C. Cloudflare proxied DNS directly to the home IP:** only behind B.

**Common to all three:**
- The application never depends on which option is used.
- `/oauth/client-metadata.json` and `/oauth/jwks.json` must stay reachable for sign-ins and refreshes.
- Some scrobbler apps require HTTPS and a real domain, which every option provides.

**Machine sleep.** If the box sleeps, the tunnel drops and clients queue and retry. Jetstream resumes from its cursor, or gap recovery runs. In-process timers compare wall-clock due times on wake. Keep PowerDevil's AC auto-suspend off. Masking sleep targets needs root and is documented as optional.

---

## 15. Testing strategy

### 15.1 Runners
**Vitest projects after the port, all `environment: 'node'`:**
- `core` and `atproto` (environment switch only);
- `worker-modules` (the old DO module tests over the Node harness, N2-02);
- `worker-node` (new: `worker/test/node/**`);
- `worker-composition`, `worker-acceptance` and `worker-bench` (N3-07);
- `web` (happy-dom);
- `scripts` and `scripts-gate`.

The `sequence.groupOrder` isolation is kept.

**Harness mapping (N2-02):**

| DO helper | Node replacement |
|---|---|
| `runInDurableObject` | `withIndex(fn)` over a temporary-file database |
| `runDurableObjectAlarm` | `core.runAlarmNow()` |
| `evictDurableObject` | close and reopen the same file (TESTING.md's original "restart reopens same storage") |

Each test file gets its own database file.

**Playwright** runs against the Node stack built from the e2e test entry, with the fake AS, PDS, PLC, Jetstream, Last.fm and ListenBrainz behind the stack proxy (N6-01).

### 15.2 Determinism and fakes
- `fixedClock` and seeded `Random` everywhere. Timers are stepped, and nothing sleeps.
- **No network.** The router transport maps reserved hostnames to fakes:
  - `pds*.test`, `plc.test`, `as.test` (the fake AS);
  - `lastfm.test` (`fake-lastfm.ts`: signature-verifying `track.scrobble`/`updateNowPlaying`/`love`, `auth.getSession`, a paged `getRecentTracks`, and scripted error codes 4, 8, 9, 10, 11, 16, 26 and 29);
  - `listenbrainz.test` (`fake-listenbrainz.ts`: `validate-token`, recording `submit-listens`, paged listens, `X-RateLimit-*`, scripted 401, 429 and 503);
  - `jetstream.test`.

  The production SafeFetch and pinning stay on, and the fake resolver answers with public test-net addresses.
- **Loopback exceptions.** Only `jetstream-ws.test.ts` (a `ws` server on port 0) and the e2e and acceptance stacks use loopback sockets, always between our own processes.
- Real scrobbler client code (`lastfm-ts-api@2.6.2`) and byte-faithful replays of request shapes recorded from client sources (Pano, Web Scrobbler, Navidrome, multi-scrobbler) run only against the local server.

### 15.3 Keeping the existing tests
- **Policy.** The existing 406 vitest tests and the Python regressions are **kept**. A ported test keeps its file path and title unless this ADR names the change. `docs/verification/node-port-inventory.json` records every pre-port id and its replacement, and `scripts/test/test-inventory.test.ts` enforces it.
- **Named changes:**
  - `sql-conformance` expectations for >2^53 reads, multi-statement text, BEGIN/SAVEPOINT and PRAGMA;
  - `rowsRead` budgets (status, keyset, bench), re-derived as `EXPLAIN QUERY PLAN` pins on SQLite 3.54.1, because node:sqlite has no rows-read counter;
  - workerd-helper existence checks (`local-index.test.ts`, the isolation tests), replaced by Node harness checks;
  - `scheduled.test.ts`, which becomes the interval test;
  - the web OAuth and outbox suites, which move to the server (§5.9);
  - `scripts/test/{deploy,pitr-restore,check-bundle}.test.ts`, replaced;
  - the workerd e2e entry, replaced.
- **Case map.** `docs/verification/ts-case-map.json` keeps mapping all 258 cases. `scripts/validate_case_map.py` accepts test ids declared in `docs/planning/node-waves.json` (N0-02). Only one package per wave edits the map.
- **Goldens.** Rust-oracle goldens stay; `check_goldens.sh` is unchanged.

### 15.4 New suites (owned in node-waves.json)
- Node adapter conformance.
- BFF: metadata and JWKS, state TTL, callback binding, `invalid_grant`, rotation, encryption at rest, cookie and CSRF matrix, keepalive.
- Server outbox: the ported semantics plus batch, bisect, budget and priority.
- Last.fm per-method goldens and signature vectors.
- ListenBrainz validation messages verbatim.
- Range stats equal to the `/api/v1` stats on the shared fixture.
- Imports: paging, ZIP bombs, dedupe, resume.
- Forwarding: retry, revocation, expiry.
- Secret-in-log capture.
- In-process journeys.
- The real-client e2e in `scripts/acceptance/node-backend.sh` (N7-01).

---

## 16. Amendments (B-series)
N0-02 writes the issue-amendment texts in `docs/planning/AMENDMENTS-node.md`, in the style of AMENDMENTS-workers.md.

| Id | Amends | Text |
|---|---|---|
| **B1** | A1 deployment | One Node 26 process (systemd user unit, `127.2.0.1:8888`), one SQLite file, secrets as a systemd credential, public origin unchanged, exposure owner-chosen. Single instance; multi-writer stays deferred. |
| **B2** | A2 role | AppView, indexer **and write client**: the server writes for signed-in users from the web UI and the scrobbler protocols. |
| **B3** | A3 OAuth / ADR 0002 | Confidential client at the same client_id: `private_key_jwt` ES256, `jwks_uri`, a server callback at `/oauth/callback`, sessions encrypted at rest, 30-day cookie sessions, CSRF. |
| **B4** | A4 libraries | Adds `@atproto/oauth-client-node`, `ws`, `undici`, `fflate` and `esbuild`. `@atproto/oauth-client-browser`, `wrangler` and `@cloudflare/*` are removed. |
| **B5** | A5 SSRF | DNS-pinned connections restored on Node; the DoH HTTP pre-check is superseded. |
| **B6** | A11 idempotency | Server `Idempotency-Key` (400/409) on `POST /api/v1/scrobbles`, plus the TID allocated once with digest reconciliation, plus listen keys for protocol ingress. |
| **B7** | A12 outbox | Server outbox with the same formula, cap and crash barriers. It runs without a browser. |
| **B8** | A15 backup | In-process `VACUUM INTO` backups, pre-migration backups and file restore. The db holds non-derived data. |
| **B9** | A16 metrics | journald JSON lines, `counters` and the admin socket status. |
| **B10** | A18 harness | Node harness: temporary db file per test file, close/reopen for restarts, `environment: 'node'`. Commands are unchanged: `npm test`, `npm run test:e2e`, `npm run check`. |
| **B11** | A19 release | Release = git sha plus the Node bundle SHA-256 (`worker/dist/node/main.mjs`). |
| **B12** | M1.1.1 collections | Collections are exactly `<p>.scrobble`, `<p>.follow`, `<p>.settings` and **`<p>.love`**. |
| **B13** | Lexicons (§9.1 of ADR 0004) | The §6.2 optional scrobble fields; the new love lexicon; additive-only rule after the freeze point. |
| **B14** | API contract | v1.2 (`info.version: 1.2.0`): every v1.1 route and payload is unchanged except the additive optional Scrobble fields. Adds the §5.7 cookie routes and the link, import and credential routes; restores `Operation` and `Accepted`; `meta.capabilities` may add `writes`, `lastfm`, `listenbrainz`, `imports` and `forwarding`. The "no route reads a session" sentence is narrowed to "no v1.1 read route". `/2.0/` and `/1/` are specified in this ADR and in `docs/compat/{lastfm,listenbrainz}.md`, not in OpenAPI. |
| **B15** | Admin | Admin routes only on the unix socket; `ADMIN_TOKEN` retired. |
| **B16** | ADR 0004 §9.3 dropped list | Restores session cookies, CSRF and the Origin rules, server OAuth state (600 s), encrypted token storage, the SIGTERM drain and the trusted-proxy rule. |
| **B17** | ADR 0004 §5.5 and Q4 | `pulse` mode, `PLAN` and the plan tiers are removed. |
| **B18** | A20 meta | `stage` reflects the Node composition, and the capabilities follow B14. |

---

## 17. Work plan summary

`docs/planning/node-waves.json` holds the packages. Each wave leaves `npm run check` green.

| Wave | Contents |
|---|---|
| **0** | Node 26 toolchain, pinned dependencies, the `worker-node` test project, core under Node, and the gate (N0-01). Contract, lexicon and amendment texts, and a case-map validator that reads node-waves (N0-02). |
| **1** | Node SQLite `Db`; `IndexCore` extraction and extension timers; Node alarm; `ws` Jetstream connector and atproto under Node; pinned transport; HTTP bridge, static assets and client IP; config and secrets; crypto box and tokens; fake upstreams; migration 2; core scrobble/love fields; periods, MSID and listen keys. |
| **2** | Node composition, bundle, admin socket, backup and shutdown; port of worker-modules to Node; confidential OAuth client; sessions and CSRF; server outbox; range reads; Last.fm protocol core; ListenBrainz protocol core; credentials. |
| **3** | Auth routes; write and account routes; Last.fm auth and write methods; Last.fm reads; ListenBrainz submit; ListenBrainz reads, stats and feedback; composition, acceptance and bench on Node; forwarding plus link routes; imports plus import routes; credential routes; projection of loves and new fields. |
| **4** | Production feature wiring and in-process journeys; systemd units, install, restore and ops docs; protocol read benchmark. |
| **5** | Web migration to the cookie BFF, new settings screens, the Last.fm approval page, removal of the browser OAuth client and outbox, case-map remap. |
| **6** | Playwright on the Node stack; retirement of the Workers runtime; Node live gates. |
| **7** | `scripts/acceptance/node-backend.sh`, with the real scrobbler-protocol client e2e against fake upstreams, and case-map closure. |

**Critical path:** N0-01 → N1-01 → N2-05 → N3-03 → N4-01 → N5-01 → N6-01 → N7-01.

**First deployable Node release:** after wave 6. Between waves 3 and 5 the SPA still contains the old browser client and must not be deployed.

---

## 18. Open questions: interim decisions

The owner said "you may do what you think best". These are Claude's interim decisions of 2026-10-25. The owner may override any of them.

| # | Question | Interim decision |
|---|---|---|
| Q1 | Host shape | **Node only**, with the seams kept (§2). |
| Q2 | Browser writes | **Through the server** (one confidential client, §5.1). |
| Q3 | Breaking lexicon changes while the NSIDs are not live | Allowed, but **not used**: additive-only from now on. The freeze point is the first production record (§6.1). |
| Q4 | Loved tracks | **Supported** as `<p>.love` records (§6.3). ListenBrainz "hate" (−1) clears a love. |
| Q5 | Last.fm `api_sig` for unknown client keys | **Not verifiable; accepted when well-formed.** Authorisation rests on our high-entropy credentials. Verified for issued app keys and the known public pairs (§7.4). |
| Q6 | Showing staged or pending imports before they are indexed | **No.** Reads show indexed, proof-verified data only, and imports show progress. A staging view may be added later. |
| Q7 | `include:` permission set for a friendlier consent screen | **Deferred.** The four explicit `repo:` scopes are used. |
| Q8 | Confidential-client interop against the real `@atproto/oauth-provider` | The deterministic fake AS gates the work. The dev-env interop run is an operator gate that reports `blocked` when infeasible (§5.10). |
| Q9 | Audioscrobbler 1.2 (mpdscribble, Quod Libet) | **Not supported.** It would need a stored password-equivalent. `/audioscrobbler/` is reserved and answers `FAILED` (§7.10). |
| Q10 | Entity URLs in Last.fm responses | Last.fm-style `www.last.fm/music/...` URLs, because we have no entity pages. To revisit if entity pages are built. |
| Q11 | ListenBrainz `listened_at` skew | +300 s, the lexicon bound, instead of ListenBrainz's 3,600 s (§8.3). |
| Q12 | Rename `worker/` to `app/` | **Deferred**, to keep test ids and the case map stable. |
| Q13 | DB location | `~/.local/state/atmusic` via `StateDirectory=`. `ATMUSIC_DB` can move it. |
| Q14 | Default import share of the PDS budget | **50%**, user-adjustable from 10% to 90% (§5.8). |
| Q15 | Now-playing visibility | Public by default (Last.fm parity), with a per-account toggle. |
| Q16 | Daily listen cap | 3,000 per DID per rolling 24 h (abuse bound; Last.fm code 5, ListenBrainz 429). |

**The owner must supply:**
1. A **Last.fm API account** (API key and shared secret) registered for non-commercial use, with its callback at `https://music.214510.xyz/api/v1/links/lastfm/callback`. It is needed for Last.fm imports through the API and for Last.fm forwarding. Everything else works without it.
2. **Public ingress** to `127.2.0.1:8888`: a cloudflared tunnel (recommended), or a reverse proxy with TLS (§14.6).
3. **Secrets setup** (§14.2), and a password-manager copy of the plaintext secrets.
4. `loginctl enable-linger` and enabling the unit (§14.1).
5. **`NAMESPACE_OWNERSHIP_REF`** and the lexicon publication at `music.pythonplayer123.dev` before writes are enabled (unchanged from ADR 0004 Q3).
6. Optionally, an offsite backup target (§14.5).

---

## 19. Sources
- Repository at `3d953a9`:
  - `docs/adr/0004-cloudflare-workers.md`;
  - `worker/src/**` (`db.ts`, `index-do.ts`, `timers.ts`, `jetstream-socket.ts`, `router.ts`, `config.ts`, `schema.ts`);
  - `web/src/{oauth,outbox}/**`;
  - `scripts/{gen-config,check-bundle}.ts`;
  - `crates/server/src/{auth,workers,http/limits.rs}`;
  - `crates/storage/migrations/0001_initial.sql`;
  - `crates/atproto/src/oauth/token_store.rs`.
- Last.fm API documentation (read only): https://www.last.fm/api, /api/rest, /api/authspec, /api/webauth, /api/desktopauth, /api/mobileauth, /api/scrobbling, /api/show/track.scrobble, /api/show/track.updateNowPlaying, /api/errorcodes, /api/submissions, /api/tos.
- ListenBrainz server source at commit `7d9a3d6f9d52` (2026-10-22), `brainzutils-python` v3.0.0, and https://listenbrainz.readthedocs.io/en/latest/users/api/core.html.
- Client sources read: GNU FM, Maloja, Koito, multi-scrobbler, Pano Scrobbler, Rocksky, Navidrome, Jellyfin ListenBrainz plugin, Music Assistant, Web Scrobbler, Strawberry, mpdscribble, Quod Libet; `lastfm-ts-api@2.6.2` types.
- atproto: https://atproto.com/specs/oauth, https://atproto.com/specs/permission; installed `@atproto/oauth-client` 0.8.10, `@atproto/oauth-provider` 0.24.1, `@atproto/pds` 0.5.40, `@atproto-labs/fetch-node` 0.4.1; `@atproto/oauth-client-node` 0.5.9/0.5.10 (npm registry); Bluesky rate-limit documentation source (`bsky-docs/docs/advanced-guides/rate-limits.md`).
- systemd 261 man pages: systemd.exec(5), systemd.service(5), systemd.resource-control(5), systemd.unit(5), systemd-creds(1), systemd-notify(1), loginctl(1). Ops research ran tests on this host with transient units.
- SQLite: https://www.sqlite.org/pragma.html, https://www.sqlite.org/lang_vacuum.html, https://www.sqlite.org/backup.html; Node `node:sqlite` documentation (v26).
- Cloudflare (documentation only): Tunnel configuration, connection limits, HTTP headers, WAF rate-limiting rules, R2 pricing.
- XDG Base Directory specification: https://specifications.freedesktop.org/basedir/latest/.
