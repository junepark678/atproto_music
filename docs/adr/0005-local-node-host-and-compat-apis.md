
# ADR 0005: Local Node host, confidential BFF, Last.fm and ListenBrainz compatibility

- **Status:** Proposed 2026-10-25, then **Accepted with interim decisions** (§18) on 2026-10-25. The owner delegated the open calls ("you may do what you think best"). **Revised 2026-10-25 after design review rounds 1 and 2**; §20 records every finding and its disposition (round 2 in §20.4).
- **Branch:** `feat/mvp-complete`.
- **Supersedes:** the deployment, OAuth and write-path parts of [ADR 0004](0004-cloudflare-workers.md): §1, §4.1, §4.2, §5.1, §5.2, §5.5 (pulse mode), §8 (user credentials and SSRF rows), §11, §13 items 1, 2, 4 and 7, amendments A1, A2, A3, A4, A5, A11, A12, A15, A16, A18 and A19, and the ADR 0004 §9.3 dropped list (D) as far as B16 restores it. §2 says what is kept. It also amends ADR 0002 (OAuth) again; see §5.
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
The Workers adapter is **retired** (wave 7, N7-01). Everything runs on Node 26. The boundary that would let a second host come back later is kept and named:
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
| `IndexDO` (`worker/src/do/index-do.ts`) | **Body moved** to `worker/src/app/index-core.ts` (`IndexCore`, N1-02), together with **every non-class export** of `index-do.ts` (`envLogger`, `createLogger`, `INDEX_NAME`, `PITR_WINDOW_MS`, `IndexError`, `NotReadyError`, `runGc`, the GC and slice constants, `IndexDeps`). `index-do.ts` re-exports them and keeps `protected buildDeps(env, ctx): IndexDeps` as the test-entry override seam until N4-03 and N7-01. In wave 1 the DO class becomes a thin wrapper, and N7-01 deletes it. No host-neutral module imports `index-do.ts` after N2-01 (§3.9). `blockConcurrencyWhile(migrate)` becomes "migrate synchronously before `listen`". |
| Alarm multiplexer and `timers` table (§5.9) | **Kept.** `TIMER_NAMES` keeps the seven core names; a separate `EXTENSION_TIMER_NAMES` list holds the new ones (§3.3). The cron trigger becomes an in-process 5-minute `ensureRunning()` interval. |
| Ingest modes `socket` / `pulse` / `off` | `socket` is the default and `off` stays (tests, development). Until N7-01 the Node config passes `PLAN='paid'` and `DO_LOCATION_HINT=''` to the embedded `parseConfig` and refuses any operator-set `PLAN` (N1-07). **N7-01 removes `pulse`, `PLAN`, `DO_LOCATION_HINT` and `BUDGETS.free`** from `config.ts`, `ingest-mode.ts`, the `jetstream-socket.ts` pulse paths, `index-core.ts` and their tests (B17). |
| Static Assets, `_headers`, Q9 asset-miss rules | **Kept as behaviour.** A Node static server reads `web/dist/_headers` and reuses `assetMiss`/`matchSpaRoute` (§3.7). |
| PITR (`adminPitr`, `scripts/admin/pitr-restore.ts`, `docs/backup.md`) | **Replaced** by in-process online backups (`node:sqlite` `backup()`) and a restore that keeps the live non-derived state and replays the revocation journal (§14.5, B8). |
| Browser public OAuth client, IndexedDB outbox (A3, A11, A12) | **Replaced** by the confidential BFF and a server outbox (§5). The outbox semantics are kept exactly. |
| SafeFetch with DoH pre-check and no pinning (A5) | **Strengthened.** SafeFetch is unchanged, DoH pre-check included, and its connections are pinned to checked addresses. Every non-SafeFetch request (POSTs, OAuth, PDS writes, Last.fm, ListenBrainz) goes through the new `policyFetch`, which applies the same rules (§3.5). |
| Notify, record status, export, settings opt-out (N1–N4, A8, A9, A10, A13, A17, A20) | **Kept.** After each write the server outbox queues the record's hint directly with `enqueueHints` (source `notify`), bypassing the client abuse buckets (§5.8). |
| Workers Logs, `counters`, `/internal/admin/status` (A16) | journald JSON lines plus `counters`; admin moves to a unix socket (§3.11). The Workers TCP admin route and `ADMIN_TOKEN` stay for the Workers entry only until N7-01. |
| Live gates `scripts/live/workers_*` | **Ported** to Node gates that report `blocked` when prerequisites are missing (N6-02). |
| `wrangler`, `@cloudflare/*`, workerd test pool | **Removed** in N7-01 (its own wave, after the Playwright port N6-01, the live-gate port N6-02 and the de-shim packages N4-04 to N4-06), once every suite runs on Node without the `cloudflare:*` test shim (§15.1). |
| `scripts/acceptance/workers-backend.sh` | **Retired at wave 0** (N0-02): it is no longer part of the gate from wave 0 on, because its case-map `--check-tests` step and its Playwright step cannot pass while the port is under way. The interim per-wave acceptance `scripts/acceptance/node-interim.sh` replaces it until `node-backend.sh` (N8-01). N7-01 deletes the file (§17). |

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
- **Request context.** `RequestCtx` (`worker/src/http/types.ts`, N2-01) gains `deps?: ModuleDeps`, `app?: AppServices` and `peer?: string` (the socket address); `clientIp` stays. The new fields are **optional at the type level**, so the existing test `RequestCtx` literals (seven files under `worker/test/{http,read}`) keep compiling in wave 2. The Node composition always sets them, and a handler that needs one reads it through `need(ctx, 'app')`, which throws `CtxWiringError` (a 500) when it is absent. `env` becomes the structural `AppEnv` = `Pick<EnvVars, 'LEXICON_PREFIX' | 'NAMESPACE_OWNERSHIP_REF'> & {ADMIN_TOKEN?: string}`; the Workers `Env` is assignable to it. N7-01 drops `ADMIN_TOKEN` from it.
- **Route methods.** `RouteDef.method` widens from `GET | POST` to `GET | POST | PUT | PATCH | DELETE | OPTIONS` (N2-01). `matchRoute` keeps its current `Allow` set exactly (`POST /api/v1/meta` still answers `Allow: GET`, as `composition/routing.test.ts:252-254` pins on workerd). Only the **Node dispatcher** (`worker/src/node/dispatch.ts`) maps `HEAD` to the `GET` route, drops the body, and appends `HEAD` to the `Allow` header of its own 405 answers when `GET` is registered.
- **Route table split (N2-01).** `worker/src/router.ts` imports `envLogger` and `INDEX_NAME` from `index-do.ts`, which imports `cloudflare:workers`. N2-01 moves the host-neutral parts (`ROUTES`, `matchRoute`, `assetMiss`, `matchSpaRoute`) into `worker/src/http/routes.ts`, which imports only host-neutral modules; `router.ts` keeps only the Workers entry (`createWorker`, `handleFetch`) and re-exports the rest until N7-01. `http/admin.ts` imports `PITR_WINDOW_MS` from `app/index-core.ts` instead of `index-do.ts`.

- **Pinned toolchain and dependencies (N0-01, 2026-10-25).** `.nvmrc` is `26.12.1` (CI's `setup-node` reads it), `engines.node` is `>=26.12.0`, and every version is exact in `package-lock.json`. Rule: the newest release at least 7 days old on 2026-10-25 (published on or before 2026-10-18), unless this ADR names the version.

  | Package | Version | Published | Where | Note |
  |---|---|---|---|---|
  | `@atproto/oauth-client-node` | 0.5.10 | 2026-10-17 | `@atmusic/worker` dependency | §5.2; 0.5.11 and 0.5.12 are younger than 7 days; resolves the already-locked `@atproto/oauth-client` 0.8.10 |
  | `ws` | 8.22.0 | 2026-09-26 | `@atmusic/worker` dependency | §3.4 |
  | `@types/ws` | 8.18.2 | 2026-09-29 | `@atmusic/worker` devDependency | |
  | `undici` | 8.12.2 | 2026-10-15 | `@atmusic/worker` dependency | §3.5; equals `process.versions.undici` of Node 26.12.1 (8.12.3 is newer than Node's copy); asserted by `worker/test/node/scaffold.test.ts` |
  | `fflate` | 0.8.3 | 2026-05-16 | `@atmusic/worker` dependency | §11.1 |
  | `esbuild` | 0.28.2 | 2026-08-08 | root devDependency (direct) | §3.9, `scripts/build-server.ts` |
  | `lastfm-ts-api` | 2.6.2 | 2026-04-02 | root devDependency only | §15.2, the real-client e2e (N8-01) |
  | `@types/node` | 26.6.5 | 2026-10-09 | root devDependency | newest 26.x; it does not yet declare `node:sqlite`'s `Database` export (only the `DatabaseSync` alias), so code reads `Database` structurally until the types catch up |

### 3.2 Storage: node:sqlite (`worker/src/node/sqlite-db.ts`, N1-01)
- **API.** Use the class exported as `Database` from `node:sqlite`; `DatabaseSync` is a deprecated alias (DEP0210). Open it with `{timeout: busyTimeoutMs}`, which sets the busy timeout. `busyTimeoutMs` is an injected option: production passes 5000 (asserted at startup by reading `PRAGMA busy_timeout` back, and in the config test); tests pass about 200 ms, so no test waits 5 s in real time. There is one connection per process.
- **Startup pragmas,** set by the adapter and read back and asserted at startup:
  - `journal_mode=WAL`;
  - `synchronous=FULL`, because a scrobble acknowledged with 200 must survive a power cut;
  - `foreign_keys=ON`;
  - `journal_size_limit=67108864`;
  - `locking_mode=EXCLUSIVE`, set before the first WAL access, so WAL runs without shared memory and the process holds the database lock for its whole life. This is the **single-writer lock** (§3.10): a second process (or a second connection in the same process) opening the same file, whatever its admin socket path, gets `SQLITE_BUSY` after the busy timeout.

  They are never set in migrations.
- **`Db.tx` nests.** `runGc` calls `scheduleSnapshot` inside `db.tx`, and there are 78 `db.tx(` call sites. The outermost call is `BEGIN IMMEDIATE … COMMIT`; inner calls are `SAVEPOINT sp<n> … RELEASE`, with `ROLLBACK TO` on a throw. A callback that returns a Promise is refused and rolled back, matching the existing `no-async-tx` rule.
- **Contract kept exactly.** `SqlParam` and `checkParams` are unchanged: at most 100 parameters, safe integers only, booleans and non-finite numbers refused. BLOB reads are converted from `Uint8Array` to `ArrayBuffer`. `run()` returns `{rowsWritten: changes}`.
- **Refused statements.** The adapter refuses multi-statement text: a tokenizer finds a `;` outside string literals and comments that is not the final character. An authorizer (`setAuthorizer`) denies `SQLITE_TRANSACTION`, `SQLITE_SAVEPOINT`, `SQLITE_PRAGMA`, `SQLITE_ATTACH` and `SQLITE_DETACH` for module SQL, and exempts only the adapter's own statements while a private flag is set.
- **Integers above 2^53 on read** throw `ERR_OUT_OF_RANGE`, which the adapter wraps in a typed `SqlRangeError`. The DO silently lost precision instead. `sql-conformance.test.ts:339` changes its expectation (N2-02).
- **Statement cache:** an LRU of 256 prepared statements keyed by SQL text.
- **Migrations.** `migrate.ts` is retyped over `MigrationTarget {exec(sql), tx}`, and the old DO signature is kept until N7-01. Migrations run **synchronously before the HTTP listener binds**.
- **Additive migrations and compatibility.** Every migration after 2 is additive: only `CREATE TABLE`, `CREATE INDEX` and `ALTER TABLE … ADD COLUMN`, enforced by a static test (N1-10). Migration 2 creates `schema_compat(min_compatible_version)`, one row, set to 2. A later additive migration leaves it unchanged; only a non-additive one, which needs its own ADR, may raise it. Code at version *n* opening a database at version *m > n* runs normally when `min_compatible_version ≤ n`: older code ignores tables and columns it does not know. Otherwise `/health/ready` returns 503 `too_new` and no timer starts. A rollback is therefore a link switch and a restart, never a restore (§14.3).
- **No silent creation.** The server refuses to start (exit 78, naming `ATMUSIC_DB`) when the database file is missing, unless it was started with `--init`. `scripts/install-local.sh` runs `main.mjs --init` once. A restore that has moved the file aside can never be raced by a fresh empty database.
- **Single writer.** All SQL runs on the main thread, synchronously. Every await (PDS, Last.fm, ListenBrainz, AS) happens outside a transaction, as the DO rules already require.

### 3.3 Scheduler (`worker/src/node/alarm.ts`, N1-03)
- `NodeAlarm` implements `AlarmStorage` over a single `setTimeout`:
  - delays are clamped to 2^31−1 ms and re-armed until the wall-clock due time;
  - every callback error is caught and logged, and the alarm is re-armed at `now + backoff` (DO alarms retried automatically; Node timers do not);
  - `IndexCore.alarm()` re-arms in `finally`, as `index-do.ts:445-474` does today.
- **Heartbeat:** a 30 s `setInterval` compares `min(timers.due_at)` with the wall clock and fires anything overdue. This covers libuv timers that stall during a machine suspend.
- **Cron replacement:** a 5-minute `setInterval` calls `ensureRunning()`.
- **Extension timers.** `TIMER_NAMES` stays the seven core names, so `worker/test/storage/timers.test.ts` (which schedules every entry of `TIMER_NAMES` and pins the run order, `:261-272`) is unchanged. A new `EXTENSION_TIMER_NAMES` lists `outbox`, `forward`, `import`, `oauth-keepalive`, `expiry-sweep` and `backup`, in that order. Their handlers come from `CoreExtension`s passed to `IndexCore` at composition. A name with no handler is never armed.
- **Two lanes.** `runDue` holds a single-flight guard keyed on its `AlarmStorage` object and takes one snapshot of due rows per run, and `armAlarm` defers while a run is in flight. A DO has one alarm, so the core and extension timers shared that guard; on Node that would make a kicked outbox wait behind a five-minute snapshot slice. `runDue`, `armAlarm`, `nextDue`, `recoverOrphans` and the claim step therefore take a lane, `{names}`, which defaults to `TIMER_NAMES` (N1-02). `nextDue` today takes `min(due_at)` over every known name and its `~running:` row, and `recoverOrphans` force-reschedules every `~running:` row it finds and bumps `timer_failures`; unscoped, a core `runDue` started while the extension lane holds `~running:outbox` would treat the live claim as an orphan. With the lane scope, each function reads and writes only its lane's names and `~running:` rows. `IndexCore` drives two lanes from two `NodeAlarm` objects (`Host.alarm` and `Host.extensionAlarm`): the **core lane** (`TIMER_NAMES`: drain, snapshot, watchdog, discovery, gc, sweeps) and the **extension lane** (`EXTENSION_TIMER_NAMES`, in that fixed order). Each lane has its own guard, so neither waits for the other. Both run on the main thread; every await is outside a transaction.
- `AlarmStorage` becomes the structural `{setAlarm(ms: number): void | Promise<void>; deleteAlarm(): void | Promise<void>}` (N1-02), so `timers.ts` no longer needs the Workers types.
- `TIMER_RUN_TIMEOUT_MS` and `ALARM_SLICE_MS` stay as fairness slices within each lane.

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
- Options: `perMessageDeflate: false`, `maxPayload: 1 MiB` (the 64 KiB parser bound and its counter are unchanged), a 10 s handshake timeout, and an explicit `rejectUnauthorized: true`, so no environment default can disable certificate checks (§14.1).
- Only hosts listed in `JETSTREAM_URLS` are dialled.
- `Buffer` frames become `ArrayBuffer` for `LinkEvent`. The connector buffers until `start()`, as `linkOf` does today.
- Ingest mode is `socket`, with the existing watchdog, the 15-minute planned refresh, host rotation and Q11 continuity.
- On SIGTERM the link closes with code 1000.
- **Tests:** `packages/atproto/test-support/fake-jetstream.ts` gains an in-memory `JetstreamLink` connector that works on any host. The workerd `WebSocketPair` export stays until N7-01.

### 3.5 Outbound transport with pinning (`worker/src/node/pinned-transport.ts`, N1-05)
- On Node a bad fetch can reach the owner's LAN, `127.x` and our own listener.
- Every production `Transport` uses an undici `Agent` (pinned `undici@8.12.2`, the same as Node's bundled copy) whose `connect.lookup` applies `isAllowedAddress` to **every address it returns**. Only the address that was checked is connected. This closes the A5 TOCTOU residual and is a strengthening.
- It lives in `worker/src/node/`, not in `@atmusic/atproto`, because that package is Workers- and browser-safe with no Node built-ins (its tsconfig has no Node types and its package.json no undici). `undici` is a dependency of `@atmusic/worker` (N0-01).
- The `Agent` is built with an explicit `connect: {rejectUnauthorized: true}`, so `NODE_TLS_REJECT_UNAUTHORIZED` or `NODE_EXTRA_CA_CERTS` can never weaken it (and the unit unsets them, §14.1).
- **Two request paths share the pinned Agent.**
  - **`SafeFetch`** (`packages/atproto/src/net/safe-fetch.ts`) is **unchanged**: GET only, read kinds only, and it **keeps its DoH A/AAAA pre-check**. That check is redundant with pinning but costs one cached DoH query per host and is not worth a change to a verified module; this ADR does not touch `safe-fetch.ts`. Identity, record and block reads use it.
  - **`policyFetch(input, init)`** (`worker/src/node/policy-fetch.ts`, N1-05) is a fetch-shaped function for every other request, including POST: the OAuth client (PAR, token, revoke, metadata), `PdsWriter`, the forward clients and the import sources. It applies the same rules as SafeFetch: the URL policy (https only, default port, no IP literals, forbidden suffixes), `redirect: 'manual'` with every 3xx an error, a 10 s deadline, a request-body cap and a response-body cap per caller, and `TransportError` for every failure. It does no DoH pre-check; pinning is its address check.
- Network failures reject with `TransportError {code}`, never a raw `TypeError`. `@atproto/oauth-client` deletes sessions on `TypeError` (`session-getter.js:60-68`), and a network blip must not sign anyone out.
- Fixed upstreams (`ws.audioscrobbler.com`, `api.listenbrainz.org`) use the same path. Tests inject the router transport, which is test-support only.
- **No unpinned fallback.** `createIdentityResolver` (`identity/resolver.ts:52`), `createHandleResolver` (`identity/handle.ts:96`), `createSafeFetch` and `IndexDO.buildDeps` (`index-do.ts:328`) fall back to `fetchTransport`, which is the global `fetch` (undici without pinning on Node). Three rules close this:
  1. `run()` replaces `globalThis.fetch` with a stub that throws `TransportError('unpinned_fetch')` before it composes anything, so a forgotten option fails loudly instead of bypassing the SSRF policy;
  2. an N4-01 features test builds the production composition with a **spy** pinned transport and fails unless every outbound consumer (identity and handle resolvers, SafeFetch, the OAuth client, `PdsWriter`, forward clients, import sources, Jetstream) received it;
  3. the Node bundle guard (§3.9) fails when any `main.mjs` input other than `pinned-transport.ts`, `policy-fetch.ts` and the four fallback sites above references `globalThis.fetch`, a bare `fetch(` or `fetchTransport`, or when a production call to `createIdentityResolver`, `createHandleResolver`, `createSafeFetch` or `new NodeOAuthClient` omits its `transport` or `fetch` property.

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
  - `ATMUSIC_CLIENT_IP_HEADER` is `cf-connecting-ip`, `x-forwarded-for`, `x-real-ip` or `none`. It has **no default**: unset is a ConfigError (exit 78) naming it, because any default fails open under some exposure option (a same-host Caddy or nginx passes a client-supplied `CF-Connecting-IP` through). `docs/deploy/exposure.md` gives the value and the proxy directive for each option (§14.6).
  - The header is honoured only when the socket peer is in `ATMUSIC_TRUSTED_PROXIES` (default `127.0.0.0/8,::1`), and only the header named by the mode is read; every other client-IP header is ignored.
  - In `x-forwarded-for` mode the **rightmost untrusted** entry is used, never the leftmost (port of `crates/server/src/http/limits.rs:138-191`).
  - Every inbound `x-atmusic-*` header is stripped.
  - **Rate-limit key.** `rateKeyOf(ip)` (also in `client-ip.ts`) is the address itself for IPv4 and the **/64 prefix** for IPv6, because one IPv6 host normally controls a whole /64 and would otherwise get 2^64 fresh buckets. Every per-IP limit (§13) is keyed by `rateKeyOf`.
  - Residual: any local process can forge the header. That is accepted on a single-user host and documented.

### 3.7 Dispatch and static web (`worker/src/node/static-assets.ts`, N1-06; dispatch in `worker/src/node/dispatch.ts`, N2-01)
**Dispatch order:**
1. These router prefixes always reach the router first: `/api/`, `/health/`, `/oauth/` (client metadata, JWKS and the callback are now dynamic), `/2.0` and `/2.0/` (Last.fm), `/1/` (ListenBrainz) and `/audioscrobbler/` (§7.10). So does `GET /` when the query has `hs=true` (an Audioscrobbler 1.2 handshake sent to the root, §7.10). `/internal/` on the TCP listener is always the JSON 404 (§3.11).
2. Otherwise, an existing file in `ASSETS_DIR` (`web/dist`) is served.
3. Otherwise, `assetMiss` runs. It is exported from `router.ts` and unchanged: `index.html` for known SPA routes, else the JSON 404.

**`/api/auth` and `/api/auth/` (Last.fm web/desktop approval)** are both explicit routes that 302-redirect to the SPA page `/lastfm/authorize`, keeping the query string byte for byte (§7.3). multi-scrobbler opens the form without the slash.

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
| `ATMUSIC_PUBLIC_ORIGIN` | (required) | `https://music.214510.xyz`; always https in `main.mjs` (§3.9) |
| `ATMUSIC_DB` | `$STATE_DIRECTORY/atmusic.db` | Startup error if neither is set |
| `ATMUSIC_ASSETS_DIR` | `<release>/web/dist` | |
| `ATMUSIC_BACKUP_DIR` | `$STATE_DIRECTORY/backups` | |
| `ATMUSIC_UPLOAD_DIR` | `$STATE_DIRECTORY/imports` | |
| `ATMUSIC_ADMIN_SOCKET` | `$XDG_RUNTIME_DIR/atmusic/admin.sock` | |
| `ATMUSIC_CLIENT_IP_HEADER` | (required) | §3.6; no default |
| `ATMUSIC_TRUSTED_PROXIES` | `127.0.0.0/8,::1` | §3.6 |
| `ATMUSIC_SIGNIN_POLICY` | `allowlist` | `allowlist` or `open` (§5.7) |
| `ATMUSIC_SIGNIN_DIDS` | (empty) | Comma-separated DIDs; required and non-empty when the policy is `allowlist` |
| `ATMUSIC_UPLOAD_MAX_BYTES` | `1073741824` (1 GiB) | Global cap on `ATMUSIC_UPLOAD_DIR` (§11.1) |
| `ATMUSIC_MIN_FREE_BYTES` | `2147483648` (2 GiB) | Free-space floor on the state filesystem (§11.1) |
| `LEXICON_PREFIX`, `NAMESPACE_OWNERSHIP_REF` | as today | Namespace gate unchanged |
| `INGEST_MODE` | `socket` | `socket` or `off`; `pulse` is refused with a message citing ADR 0005 |
| `JETSTREAM_URLS`, `JETSTREAM_LOOKBACK_HOURS`, `RELAY_URL` | as today | |
| `LASTFM_API_ROOT` | `https://ws.audioscrobbler.com/2.0/` | https, DNS name, default port |
| `LASTFM_AUTH_URL` | `https://www.last.fm/api/auth/` | https, DNS name, default port |
| `LISTENBRAINZ_API_ROOT` | `https://api.listenbrainz.org/` | https, DNS name, default port |
| `ATMUSIC_LASTFM_KNOWN_CLIENTS` | `panoScrobbler:panoScrobbler:Pano Scrobbler` | Public key:secret:name triples (§7.4) |
| `ATMUSIC_OAUTH_TRANSITION_GENERIC` | `0` | ADR 0004 Q5 flag, off |

`parseNodeConfig(env, opts)` has no environment variable that relaxes any rule. Only the e2e entry (§3.9) passes the test-only option `{fixtureOrigins: true}`; `main.ts` never does.

**Workers-era variables.** `parseNodeConfig` embeds `parseConfig` from `worker/src/config.ts`, which still requires `PLAN` (`paid` or `free`) and `DO_LOCATION_HINT` and builds its slice budget from `BUDGETS[plan]`. Until N7-01 removes them, `parseNodeConfig` passes `PLAN='paid'` and `DO_LOCATION_HINT=''` internally and rejects any operator-set `PLAN` or `DO_LOCATION_HINT` with a ConfigError citing ADR 0005 (N1-07).

**Runtime environment hygiene.** Node itself reads `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `NODE_PATH`, `HTTP_PROXY`/`http_proxy`, `HTTPS_PROXY`/`https_proxy`, `NO_PROXY`/`no_proxy`, `ALL_PROXY`/`all_proxy`, `SSL_CERT_FILE` and `SSL_CERT_DIR`, and a user unit inherits the user manager's environment (63 variables on this host). Any of them could silently disable TLS verification, reroute traffic or inject code on the next restart. The unit unsets all of them (§14.1), and `run()` exits 78 naming the variable if any is still set (`FORBIDDEN_RUNTIME_ENV`, N1-07). The undici Agent and the `ws` client also pass `rejectUnauthorized: true` explicitly (§3.4, §3.5).

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
- **AAD binds every sealed value to its row:** OAuth states the key hash, OAuth sessions the DID (§5.5), linked credentials `linked/<did>/<service>`, issued app secrets `lastfm-app/<api_key>/<did>`. A ciphertext copied to another row fails to open.
- `lastfm` is optional. Without it, Last.fm linking, forwarding and API imports are off and say so (§7, §11, §12). The Last.fm JSON upload and everything else still work.
- `scripts/admin/gen-secrets.ts` writes a fresh 0600 secrets file with local randomness only. The owner adds the Last.fm pair by hand.

### 3.9 Build and bundle guard (N3-07)
- Node 26 cannot load this TypeScript by type stripping (parameter properties, extensionless imports). `scripts/build-server.ts` bundles `worker/src/node/main.ts` with esbuild (`0.28.2`, `platform: node`, `format: esm`, `target: node26`, source maps) into `worker/dist/node/main.mjs`.
- **Entry split.** `worker/src/node/run.ts` exports a side-effect-free `run(opts): Promise<ExitCode>` that does everything in §3.10. `worker/src/node/main.ts` is a few lines with the only top-level effect: it calls `run({argv: process.argv, env: process.env, …})` and exits with the result. Importing `run.ts` starts nothing.
- **`@atcute/crypto` build.** The Node resolution picks the `node:crypto` (OpenSSL) secp256k1 build. Tests and the bundle **must resolve the same build**. The guard asserts the bundle's resolved `@atcute/crypto` entry equals the one the worker-node test project resolves. The real-crypto suites run under Node: Rust golden CARs, low-S enforcement, malleable signature rejection, P-256 and secp256k1 vectors, and the `@atproto/crypto` cross-check.
- **Fallback.** If any of those vectors fails on the `node:crypto` build, both esbuild and vitest set `conditions: ['browser']` and keep the noble build. Verification is never relaxed to make a vector pass.
- **The guard is a new file**, `scripts/check-node-bundle.ts`, wired into `check-ts.sh` by N0-01 (the step runs when the file exists). `scripts/check-bundle.ts` stays untouched for the Workers bundle, because `scripts/deploy.sh:289` runs it and `scripts/test/deploy.test.ts:42` imports its `analyzeBundle`; N7-01 deletes all three together. The Node guard reads the esbuild metafiles and the sources they list, and fails on:
  - a `main.mjs` input under `test-support/`, `worker/test/` or any `router-transport` module, or a `fixedClock` or `seededRandom` reference;
  - `com.example.atmusic` handling;
  - a `cloudflare:` import, or a `main.mjs` input `worker/src/do/index-do.ts`, `worker/src/scheduled.ts`, `worker/src/env.ts`, `worker/src/index.ts` or `worker/src/router.ts` (host-neutral code imports only `http/routes.ts` and `app/index-core.ts`; types come in through `import type` only);
  - a crypto-build mismatch;
  - an unpinned fetch path (§3.5 rule 3).

  It prints the bundle SHA-256 that evidence records carry.
- **Fixture options are checked at call sites, not in bundle text.** The production sources legitimately contain fixture-mode code: `isFixtureTransport` and the `fixture` option in `url-policy.ts`, `safe-fetch.ts` and `identity/did-doc.ts:380`, and the `fixtureOrigins?: boolean` parameter of `parseNodeConfig`. Searching `main.mjs` for those words would either fail on that code or check nothing. The guard therefore follows `worker/test/acceptance/security.test.ts:392-407`: it strips comments from every `worker/src/**` and `packages/*/src/**` input of `main.mjs` and fails on call-site literals — `fixtureOrigins: true`, `fixture: true` passed as an option, `routerTransport`, `fixtureTransport`, an import from a `test-support` path, `fixedClock`, `seededRandom`. A non-vacuity check requires the scan to cover at least 60 files and to find the one opt-in parameter `fixtureOrigins?: boolean` in `worker/src/node/config.ts`.
- **e2e bundle.** Playwright (N6-01) and the scrobbler e2e (N8-01) never run `main.mjs`, because the production transport refuses loopback, IP literals and non-default ports, SafeFetch and `policyFetch` require https, and upstream roots must be https; any switch that let `main.mjs` reach a loopback fake would be the production IP-policy bypass §13 forbids. `scripts/build-server.ts --e2e` builds a **separate** `worker/dist/node/e2e.mjs` from `worker/test/e2e/node-entry.ts`, which imports `run.ts` (never `main.ts`) and passes the fixture-host transport (fixture hostnames → the loopback fakes), the `fixtureOrigins` config option and the test config. The guard additionally asserts, from the two metafiles, that every `worker/src/**` and `packages/*/src/**` input of `main.mjs` **except `worker/src/node/main.ts`** is an input of `e2e.mjs` with an identical content hash, and that `e2e.mjs` adds only `worker/test/e2e/**`, `worker/test/node/support/**` and `test-support` inputs. The feature and protocol code under test is therefore byte-identical to production, and the e2e bundle never executes the production entry.
- `main.mjs --version` prints the git sha recorded at build time; the guard prints that sha with the bundle SHA-256 (B11).

### 3.10 Composition, readiness and shutdown (`worker/src/node/{run,main,compose,dispatch,shutdown,systemd,features}.ts`)
`compose.ts` and `dispatch.ts` (N2-01) build the Host, `IndexCore` and the request handler; `run.ts`, `main.ts`, `shutdown.ts`, `systemd.ts`, the admin socket and backups (N3-07) are the process around them; `features.ts` (N4-01) is the production feature list.

**Startup order** (`run()`):
1. Refuse a forbidden runtime environment variable (§3.8), then parse config and secrets. Any error exits with status 78 (`EX_CONFIG`) and names the variable.
2. Replace `globalThis.fetch` with the throwing stub (§3.5). Open the db with `locking_mode=EXCLUSIVE` (§3.2). If another process holds it, exit **75** (`EX_TEMPFAIL`, `database_locked`) after the busy timeout. The lock is on the database file, so a second instance is detected whatever admin socket path it was given. A missing file without `--init` exits 78.
3. Bind the admin socket (§3.11). A stale socket file is replaced; the database lock already proves no other instance owns it.
4. If a migration is pending, take a pre-migration backup (§14.5), then migrate. While either runs, `EXTEND_TIMEOUT_USEC=60000000` is sent every 20 s through the notify helper, and the unit also sets `TimeoutStartSec=15min` (§14.1), so a large upgrade is never killed and restarted into a loop.
5. Build the `Host` and `IndexCore`; `start()` runs `noteRestart`, reclaims leases, then `ensureTimers` and `armAlarm` for both lanes.
6. Build the feature services and the route table (`features.ts`, N4-01).
7. `listen`.
8. `systemd-notify --ready`.

**Exit codes:** 0 after SIGTERM, 78 for configuration (never restarted: `RestartPreventExitStatus=78 75`), 75 when the database is locked by another instance, 1 otherwise.

**Request logs** record method, route pattern, status, duration and request id. They **never contain a query string or body on any route**; the only request parameter logged is the Last.fm `method` value on `/2.0`, from a fixed allowlist of method names.

**Readiness** (`/health/ready`): the schema is current, config is parsed, the secrets loaded, the OAuth keyset is valid, and the db answers a write probe (a rolled-back transaction). The body also reports the warnings `low_disk` (free space below `ATMUSIC_MIN_FREE_BYTES`) and `oauth_store_degraded` (§5.5); they do not change the status, so a tunnel keeps routing live scrobbles. Liveness (`/health/live`) means the process only.

**Watchdog:** `WATCHDOG=1` is sent every `WatchdogSec/3`, only after an event-loop-lag probe (< 5 s) and a `SELECT 1` succeed. No synchronous step may block the loop for seconds: backups use the incremental async `backup()` and the integrity check runs in a worker thread (§14.5).

**SIGTERM:**
1. Send `STOPPING=1`.
2. Stop accepting connections.
3. Let in-flight requests finish, up to the drain window (`drainMs`, injected; production 25 s, asserted in the config test; tests pass about 200 ms).
4. Close Jetstream with 1000.
5. Let the current timer slice end; slices are bounded.
6. Close the db.
7. Exit 0.

This restores the M1.4.3 drain that ADR 0004 §9.3 dropped. The unit's `TimeoutStopSec=30s` exceeds it.

**How process behaviour is tested.** `run()`, `shutdown()` and the notify helper take an injected `exit`, clock, busy timeout and drain window, so the worker-node tests drive them in-process with windows of about 200 ms and never wait for production durations. Tests that need a real second process (the exit-75 lock with the production busy timeout, SIGTERM on the bundled `main.mjs`, `--version`, the forbidden-environment exit) spawn the **built** `worker/dist/node/main.mjs` and live in `scripts/test/build-server.test.ts` (the `scripts` project) with explicit per-test timeouts (60 s). No test spawns `tsx`. Every worker-node test that starts a listener or a timer sets an explicit timeout when it needs more than vitest's 5 s default; the worker-node project config itself keeps the default (N0-01).

### 3.11 Admin interface on a unix socket
- `/internal/admin/*` is **never** served on the TCP listener, which returns 404. A tunnel cannot tell admin traffic from public traffic, because every peer is loopback.
- Admin routes are served only on `ATMUSIC_ADMIN_SOCKET`: a directory of mode 0700 holding a socket of mode 0600. Filesystem permissions are the authentication.
- **Transition.** N3-07 adds the socket routes next to the existing Workers TCP admin route. The TCP route and `ADMIN_TOKEN` stay in `ROUTES` for the Workers entry and its workerd suite (`composition/admin.test.ts`) until N4-03 ports that suite to the socket; N7-01 deletes them. The Node dispatcher never reaches them: `/internal/` on TCP is the JSON 404 before routing.
- Routes: `GET /admin/status` (adminStatus plus backup age, Jetstream lag, outbox and forward queue depths, import jobs, link failures, upload-directory bytes and free space), `POST /admin/backup`, `POST /admin/resnapshot {did}`, `POST /admin/oauth/prune-kid {kid}`.
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
   ├─ /api/auth[/]    → 302 /lastfm/authorize (SPA approval page)
   ├─ /1/*            ListenBrainz compatible (submit-listens, validate-token, user/*, stats/*, feedback/*)
   ├─ static web/dist + SPA fallback (Q9 rules)
   ├─ IndexCore: Jetstream (ws) → hints → getRecord/getBlocks proof → apply → read models (unchanged)
   ├─ outbox → user's PDS (DPoP, applyWrites/createRecord/deleteRecord) → enqueueHints(notify) → proof → index
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
                       identityResolver: <adapter over our identity module>, fetch: <policyFetch>,
                       responseMode: 'query'})
  ```
  `allowHttp` is never set.
- **Identity resolution goes through our resolver.** Given only `handleResolver`, the library builds its own `DidResolver` against `https://plc.directory/` (`@atproto-labs/did-resolver` `DidPlcMethod` default) with the bare `fetch`, and `verifyIssuer(sub)` runs it with `noCache: true` on every token response and every refresh (`oauth-server-agent.js:57,88,117-119`). Our identity checks (configured `RELAY_URL`/PLC host, did:web rules, handle bidirectional verification, the URL policy) would then be bypassed on the OAuth path. `worker/src/bff/identity-adapter.ts` (N2-03) implements the library's `IdentityResolver` interface over our `identity.resolveDid` and `identity.resolveHandle`, mapping `noCache: true` to `{fresh: true}`. A DID our rules reject fails the callback and the refresh.
- **Writes** use `client.restore(did)` → `session.fetchHandler(path, init)`, which handles DPoP, nonce retry and refresh.
- **Hooks:**
  - `onSessionUpdated(sub)` sets `accounts.oauth_status='active'` and moves that DID's `blocked` operations back to `queued` (the session store itself is written by `sessionStore.set`, §5.5);
  - `onSessionDeleted(sub, cause)` sets `accounts.oauth_status='reauth_required'` and blocks that DID's operations without failing them (§5.8). The UI shows a re-sign-in banner.
  - **Re-sign-in.** `OAuthClient.callback()` always calls `revoke(sub)` on the previous session before storing the new one (`oauth-client.js:196-205`), and that fires `onSessionDeleted` for the same DID. Our callback wrapper sets a per-sub *in-callback* flag for the duration of `callback()`; `onSessionDeleted` for a flagged sub only deletes the old row and does not set `reauth_required` or block operations. `onSessionUpdated` then marks the account active and unblocks its operations, so a user who signs in again with queued operations sees them run.
- **Alternative kept documented:** `@atcute/oauth-node-client` 2.0.1 (ADR 0004 §15). Not chosen, because its key-rotation behaviour is undocumented and its source was not inspected.

### 5.3 Client metadata and JWKS (dynamic, `worker/src/bff/client-metadata.ts`)
`GET /oauth/client-metadata.json` serves exactly this document (with `<p> = dev.pythonplayer123.music`), with `Cache-Control: public, max-age=300` and no cookie:
```json
{"client_id":"https://music.214510.xyz/oauth/client-metadata.json","client_name":"AT Protocol Music","client_uri":"https://music.214510.xyz",
 "application_type":"web","redirect_uris":["https://music.214510.xyz/oauth/callback"],
 "grant_types":["authorization_code","refresh_token"],"response_types":["code"],
 "scope":"atproto repo:<p>.scrobble repo:<p>.follow repo:<p>.settings repo:<p>.love",
 "token_endpoint_auth_method":"private_key_jwt","token_endpoint_auth_signing_alg":"ES256",
 "jwks_uri":"https://music.214510.xyz/oauth/jwks.json","dpop_bound_access_tokens":true}
```
- `GET /oauth/jwks.json` serves the **public** JWKs of the published set: `kty, crv, x, y, kid, alg:"ES256", use:"sig"`, and never `d`.
- `client_name` is the existing `CLIENT_NAME` constant (`'AT Protocol Music'`, `scripts/gen-config.ts:42`). It moves to `packages/core/src/client-name.ts` (N2-03), and `gen-config.ts` imports it from there (N5-01).
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
- **No compare-and-swap on the library write path.** The library's `sessionStore.set(sub, session)` carries no expected generation, and when `set()` throws after a refresh the library revokes the freshly issued tokens upstream and deletes the stored session (`session-getter.js:190-212`; the callback path does the same, `oauth-client.js:213-215`). A CAS conflict or a transient `SQLITE_FULL` would therefore sign users out en masse. Instead:
  - `set()` writes unconditionally and increments `generation` (kept for diagnostics only; restore no longer merges by it, §14.5). Concurrent refreshes are already serialised by `requestLocalLock` in our single process.
  - `set()` **never throws** for a storage failure. On a failed write it keeps the new session in an in-memory write-behind map, which `get()` consults first, logs `oauth_store_write_failed` (no secret fields), raises the `oauth_store_degraded` flag on `/health/ready` and `adminStatus`, and retries the write on every `get()`, `set()` and keepalive run until it succeeds. If the process stops before the retry succeeds, the rotated refresh token is lost and the next refresh fails with `invalid_grant`, which is `reauth_required` for that DID only.
  - **Free-space floor** (`ATMUSIC_MIN_FREE_BYTES`, §3.8) makes that case rare: the daily backup refuses to start unless free space is at least the database size plus the floor; `/health/ready` reports `low_disk` below the floor; the keepalive and the import writer pause below it, so the only writes left are live scrobbles and session updates.
- **Ciphertext format:** `keyId ‖ nonce(12) ‖ ciphertext ‖ tag(16)`. Decryption failure is a typed `BoxError`, and the session is treated as missing, which means `reauth_required`.
- **Callback revokes the previous session for the DID** before storing the new one (library behaviour, `oauth-client.js:196-205`). One OAuth session per DID serves many browser sessions and every protocol credential.
- **Keepalive** (`worker/src/bff/keepalive.ts`, the `oauth-keepalive` timer, hourly) refreshes an active session whose `last_refresh_ms` is more than 30 days old, at most 20 per run, **only when the DID is in use**: it has a live web session, a protocol credential used within the last 90 days, an `active` linked account, a `queued`, `running` or `blocked` operation, or an import job that is not finished. A scrobbler-only user who scrobbles at least every 90 days therefore never crosses the 3-month refresh-token inactivity window. A DID that is not in use is revoked upstream and marked `signed_out`; its protocol credentials stay, and a later scrobble is accepted and waits as `blocked` until the user signs in again (§5.8). The 90-day window is §18 Q19.
- **Callback binding check:** after `callback()`, the server resolves the session's `sub` with `identity.resolveDid(sub, {fresh: true})`. It requires that the PDS's authorization server is the session issuer and, when sign-in started from a handle, that the handle resolved to that DID.
  - A **definite mismatch** (a resolved document whose PDS names another issuer, or a handle that resolves to another DID) revokes the new session and answers 403 `oauth_binding_mismatch`.
  - An **identity-resolution error** (PLC or DNS timeout, 5xx, `TransportError`) revokes nothing: the new session stays stored (the library has already checked the issuer through our resolver, §5.2), no session cookie is set, and the user gets 502 `oauth_upstream` and can retry. The previous session was already revoked by the library, so revoking the new one on a transient failure would leave the DID with none.
- **Sign-in policy reconciliation** (`worker/src/bff/reconcile.ts`, N2-03). The allowlist is checked at sign-in (§5.7), and also at startup and on every `expiry-sweep` run: every `accounts` row whose DID the current policy refuses has its OAuth session revoked upstream and deleted, its web sessions and protocol credentials (Last.fm sessions, app passwords, ListenBrainz tokens, issued apps) deleted and journaled (§14.5), its links set `revoked`, its queued operations `blocked`, and `oauth_status='signed_out'`. Removing a DID from `ATMUSIC_SIGNIN_DIDS` therefore takes effect at the next restart or within 10 minutes.

### 5.6 Browser sessions and CSRF (`worker/src/bff/{sessions,csrf,guard}.ts`)
- **Cookie:** `__Host-atmusic_session=<64 hex>`, `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` (30 days). It is renewed when it is more than 24 hours old.
- **Storage.** Only SHA-256(token) is stored, in `web_sessions`. Logout deletes the row. Logout-all deletes every row for the DID. Signing out also revokes the OAuth session upstream unless the DID still has active protocol credentials; the UI asks. Every deletion is also appended to the revocation journal (§14.5).
- **Disconnect.** `DELETE /api/v1/account/connection` (cookie plus CSRF, §5.7) is the user's way to cut the server off completely.
- **CSRF**, for every unsafe method on `/api/v1/*` that uses the cookie:
  - exactly one `Origin` header, equal to `PUBLIC_ORIGIN`;
  - `X-CSRF-Token` = hex(HMAC-SHA256(csrfKey, `"atmusic.csrf.v1\0" + sessionToken`)), as in the Rust `crates/server/src/auth/csrf.rs`. The token comes from `GET /api/v1/auth/session`.
  - Status: no session → 401 `unauthenticated`; CSRF failure → 403 `csrf_failed`.
  - The Rust 401/403/404 matrix is ported.
- **Scope.** `/2.0/` and `/1/` never read cookies. Their guard returns no session even if a valid cookie is present. They authenticate only with protocol credentials, so CSRF does not apply to them.
- **GET callbacks and login CSRF.** Sign-in starts before any session exists, so binding the OAuth state to a session would bind nothing, and an attacker could send a victim the callback URL of a flow the attacker started, signing the victim in as the attacker. Instead:
  - `POST /api/v1/auth/start` requires exactly one `Origin` equal to `PUBLIC_ORIGIN` (else 403 `csrf_failed`, no state stored) and sets `__Host-atmusic_oauth=<32 random bytes, hex>` with `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`. (`__Host-` requires `Path=/`.) `oauth_states.session_binding` stores SHA-256 of that value.
  - `GET /oauth/callback` requires the cookie and that its hash equals the state's binding; otherwise 403 `oauth_binding_mismatch`, no session stored, and the state is consumed. It always clears the cookie. A `SameSite=Lax` cookie arrives on the AS's top-level redirect.
  - `/api/v1/links/lastfm/callback` runs inside an existing session: its single-use `state` is bound to that session's token hash (`link_states.session_hash`) and a mismatch is 403 with nothing stored.

### 5.7 Routes restored or added under `/api/v1` (contract v1.2, §16)
**Auth:**
- `POST /api/v1/auth/start {handle}` → 200 `{authorizeUrl}` and the `__Host-atmusic_oauth` cookie (§5.6). Errors: 403 `csrf_failed` (Origin); 403 `signin_not_allowed` when the handle resolves to a DID the sign-in policy refuses; 422 `fields.handle`; 429 at 10/min per IP; 502 `oauth_upstream` when AS discovery or PAR fails (no state is kept), or the AS lacks PAR or S256 PKCE.
- `GET /oauth/callback` → checks the login-CSRF cookie (§5.6), completes the code exchange, applies the sign-in policy to the session's `sub`, sets the session cookie, then 303 to `/` (or to `returnTo` when it is a known SPA path). An AS error such as `access_denied` → 303 `/signin?error=denied`. A refused DID → 403 `signin_not_allowed`: the OAuth session is revoked upstream and nothing is stored.
- **Sign-in policy.** `ATMUSIC_SIGNIN_POLICY=allowlist` (default) admits only `ATMUSIC_SIGNIN_DIDS`; `open` admits any atproto account. Each signed-in account holds credentials, upload quota, import jobs and a share of the owner's bandwidth and Last.fm key quota on the owner's home machine, so open registration is opt-in.
- **Admission at sign-in.** The callback calls `admit(db, did, 'notify', now)` so a signed-in DID with no records, or with records never hinted, still gets a `users` row and a snapshot that sets `indexing_state` (imports wait for it, §11.2). A `queue_full` answer is not an error: the DID is admitted later by the import timer or by the outbox's first write.
- `GET /api/v1/auth/session` → `Session {did, handle, username, csrfToken, status:"active"|"reauth_required", expiresAt}`, or 401.
- `POST /api/v1/auth/logout {everywhere?: boolean}` → 204.
- `DELETE /api/v1/account/connection` → 204. It needs the cookie plus CSRF. It revokes the OAuth session upstream and deletes it, deletes every web session, Last.fm session, app password, ListenBrainz token and issued app of the DID, deletes its linked accounts and their queued forward rows, cancels its not-yet-sent operations, journals every deletion (§14.5), sets `oauth_status='signed_out'` and clears the cookie. Records already on the PDS and the public index are not touched. A later sign-in starts afresh.

**Writes** all return 202 `{operation: Operation}` and need the cookie plus CSRF. `POST /api/v1/scrobbles` also needs an `Idempotency-Key` (§5.8).
- `POST /api/v1/scrobbles` with `ScrobbleInput`: the v1.0 fields plus the optional fields of §6.2.
- `DELETE /api/v1/scrobbles/{id}`, where the id is a URL-encoded AT URI. Another DID's record gives 404.
- `PUT /api/v1/follows/{did}` and `DELETE /api/v1/follows/{did}`.
- `PUT /api/v1/loves {artist, track, album?, recordingMbid?}` and `DELETE /api/v1/loves?artist=&track=`.
- `PUT /api/v1/account/indexing {indexing:"enabled"|"disabled"}`, which writes the A10 settings record.

**Operations:** `GET /api/v1/operations/{id}` → `Operation {id, kind, origin, state:"queued"|"running"|"succeeded"|"failed"|"blocked"|"cancelled", attempts, uri?, cid?, error?, createdAt, updatedAt}`. Owner only; anyone else gets 404.

**Account:**
- `GET /api/v1/account` → `Account {did, handle, username, oauthStatus, shareNowPlaying, importSharePercent, capabilities}`.
- `PATCH /api/v1/account` changes `username`, `shareNowPlaying` and `importSharePercent` (10–90). A taken username is 409 `username_taken`; a username containing a dot is 422 `username_invalid` unless it equals the caller's own currently verified handle (§9).

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
- After each success, the runner queues the record's hint with `enqueueHints` (source `notify`), so the verify drain indexes the record. It does **not** go through the client `notify` RPC: that path applies the abuse buckets (60/min per IP, 600/h per DID), and one 200-write batch or a day of import writes would exhaust them. If the DID has no `users` row yet, the runner calls `admit(…, 'notify', …)` instead and the snapshot indexes the record. **Indexing is still proof-gated.**

**Additions:**
- **Idempotency** (restores the v1.0 server rule while keeping A11's TID plus digest):
  - `Idempotency-Key`: 1–128 characters from `[A-Za-z0-9._~-]`, required on `POST /api/v1/scrobbles`. Missing → 400 `idempotency_key_required`; malformed → 400 `invalid_idempotency_key`. Keys are scoped per DID.
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
- **Cancellation:** an operation that has not been sent can become `cancelled` (used by `library.removeScrobble`, §7.5; import cancel only stops new operations, §11.4). A cancelled create writes nothing and its listen key is deleted, so a deliberate re-scrobble is accepted again.
- **Re-authentication:** a DID in `reauth_required` or `signed_out` has its operations set to `blocked`. They are not failed and attempts do not count. They resume after sign-in (`onSessionUpdated`, §5.2).
- **Writer port.** `PdsWriter` is an interface; production uses `session.fetchHandler`, whose requests go through `policyFetch` (§3.5); tests use the fake PDS.

### 5.9 Migrating the browser client code and tests (N5-01)
- **Removed:**
  - `@atproto/oauth-client-browser` from `web/package.json`;
  - `web/src/oauth/{client,session,types}.ts`. Their importers change in the same package: `web/src/main.tsx` imports `./oauth/types` and globs `./oauth/session.ts` (`main.tsx:10,14`), and `web/src/state/store.ts:13` imports `PdsSession` from `../oauth/types`. `main.tsx` instead boots `web/src/session/client.ts`, and the store holds the server `Session` DTO (`{did, handle, username, csrfToken, status, expiresAt}`) in place of `PdsSession`;
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
- **The fake PDS** (`fake-pds.ts`) accepts DPoP-bound access tokens from the fake AS for an account added with `{auth: 'dpop'}`. The default stays the fixture Bearer token (`fixtureToken(did)`), so `packages/atproto/test/fixture-kit.test.ts` (`:595-606`, `:853`) and the read-model `createRecord` helper (`test-support/read-models.ts:171`) keep working unchanged. The BFF, outbox and journey suites add their accounts with `auth: 'dpop'`.
- **Playwright** uses the same fake AS and PDS behind the existing stack proxy (N6-01).
- **Interop with the real `@atproto/oauth-provider`** (in `@atproto/dev-env`) needs an https client_id that the dev-env PDS can fetch. Loopback clients must be public, and `127.2.0.1` is not a valid loopback redirect host. That interop run is the operator gate `scripts/live/devenv_oauth_check.ts`, which reports `blocked` when the https test origin cannot be provided (§18 Q8).
- **There is no public-client dev mode.** Local development uses the e2e bundle (§3.9) with the fake AS.

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
| `oauth_states` | `key_hash` PK, `ciphertext`, `key_id`, `session_binding` (SHA-256 of the `__Host-atmusic_oauth` cookie, §5.6), `expires_at_ms` | OAuth state store |
| `oauth_sessions` | `did` PK, `ciphertext`, `key_id`, `client_kid`, `generation`, `last_refresh_ms`, `status`, `created_at_ms`, `updated_at_ms` | OAuth session store |
| `operations` | `id` PK, `did`, `kind` (`scrobble.create`, `scrobble.delete`, `follow.put`, `follow.delete`, `settings.put`, `love.put`, `love.delete`), `origin`, `priority`, `collection`, `rkey`, `record_json`, `digest`, `swap_cid`, `state` (`queued`, `running`, `succeeded`, `failed`, `blocked`, `cancelled`), `attempts`, `due_at`, `last_error`, `result_uri`, `result_cid`, `idempotency_key`, `request_hash`, `import_job_id`, `created_at_ms`, `updated_at_ms`; UNIQUE(`did`, `idempotency_key`); indexes `(state, priority, due_at)`, `(did, state)` | Server outbox |
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
| `import_jobs` | `id` PK, `did`, `source` (`lastfm_api`, `lastfm_json`, `listenbrainz_api`, `listenbrainz_zip`), `remote_user`, `state` (`waiting_index`, `fetching`, `writing`, `paused`, `done`, `failed`, `cancelled`), `cursor_json`, `upload_path`, `upload_bytes`, `fetched`, `staged`, `duplicates`, `invalid`, `invalid_reasons` (JSON counts by reason), `written`, `failed_items`, `attempts` (incomplete slice attempts, §11.4), `error`, `created_at_ms`, `updated_at_ms`, `finished_at_ms`; index `(did, state)` | Import jobs |
| `import_items` | (`job_id`, `seq`) PK, `dedupe_key`, `listened_at`, `record_json`, `state` (`staged`, `queued`, `written`, `duplicate`, `invalid`, `failed`), `operation_id`; UNIQUE(`job_id`, `dedupe_key`); index `(job_id, state, seq)` | Import staging |
| `ignored_listens` | `id` PK, `did`, `source` (`listenbrainz`), `reason` (`artist_invalid`, `track_invalid`), `listened_at`, `artist_preview`, `track_preview` (each the first 128 scalars), `created_at_ms`; index `(did, created_at_ms DESC)` | Listens that ListenBrainz would accept but our validator refuses (§8.3); kept 30 days |
| `range_stats_cache` | (`did`, `entity`, `range_key`) PK, `as_of`, `lower`, `upper`, `version`, `body`, `created_at_ms` | §10.3 |
| `backup_runs` | `id` PK, `kind` (`daily`, `manual`, `pre_migration`, `pre_restore`), `started_at_ms`, `finished_at_ms`, `path`, `bytes`, `ok`, `error` | Backup history |
| `schema_compat` | `min_compatible_version` (one row, 2) | §3.2 compatibility rule |

`TABLES` lists every table. **`TABLE_CLASS`** (also in `schema.ts`) classifies every table as `derived` (rebuildable from public repositories: the v1 index tables, `loves`, `range_stats_cache`, and the caches and queues of ingestion) or `non-derived` (local state: `accounts`, `web_sessions`, `oauth_states`, `oauth_sessions`, `operations`, `operation_deps`, `listen_keys`, `pds_budget`, the credential tables, `now_playing`, `linked_accounts`, `link_states`, `forward_outbox`, `import_jobs`, `import_items`, `ignored_listens`, `backup_runs`, `schema_compat`, `schema_migrations`, `counters`). A test fails when a table in `TABLES` has no class. Restore relies on it (§14.5). Tests that pinned schema version 1 derive their expectations from `SCHEMA_VERSION` and `MIGRATIONS` instead (N1-10 owns the five files). Migration 2 keeps every v1 row byte-identical, and the new scrobble columns are NULL until a record is re-applied. A **re-projection** of existing rows is not needed, because no production rows exist; `POST /admin/resnapshot` can fill them later.

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
  - multi-scrobbler: `urlBase https://music.214510.xyz/2.0/`. multi-scrobbler talks through `lastfm-ts-api`, which always uses `node:https` and takes only a hostname, a path and a timeout. Every `lastfm-ts-api` client therefore needs the public **https origin on port 443**; it can never use `http://127.2.0.1:8888` or any other port (`docs/compat/lastfm.md`).
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
  - **list elements carry a `list` flag in the tree.** A flagged child always serialises as a JSON array, including `[]` for zero items and a one-element array for one item. Every paged or list container is flagged: `recenttracks.track`, `trackscrobbles.track`, `lovedtracks.track`, `toptracks.track`, `topartists.artist`, `topalbums.album`, `weeklychartlist.chart`, `weeklyartistchart.artist`, `weeklyalbumchart.album`, `weeklytrackchart.track`, `friends.user`, `artists.artist` (`library.getArtists`), `toptags.tag`, `album.tracks.track`, `similar.artist` and `image`. Pano's `PageEntries<T>` decodes these as lists with no single-object fallback, so a 0- or 1-item page in object form would fail with a generic parse error;
  - every paged container carries `@attr {user, page, perPage, totalPages, total}` (strings), also when it is empty;
  - **only `scrobbles.scrobble` keeps the single-child-becomes-object quirk** (track.scrobble with one input gives an object), because that is what Last.fm returns and what clients parse; other unflagged repeated children become arrays when repeated;
  - every number is a string, except `scrobbles.@attr.accepted`/`ignored` (numbers), `user.registered.#text` (a number) and `session.subscriber` (a number, §7.3).
- **Error bodies:**
  - JSON: `{"error": <number>, "message": "<text>"}`;
  - XML: `<lfm status="failed"><error code="N">text</error></lfm>`.
- **Success:** `<lfm status="ok">…</lfm>`. `track.love` and `track.unlove` answer `<lfm status="ok"/>` in XML and `{}` in JSON (§7.5). The `library.removeScrobble` success body is still open (§20.5).

### 7.3 Authentication flows, mapped to our credentials (`worker/src/credentials/*`, `auth-methods.ts`)
**`api_key` handling.** Any non-empty `api_key` of at most 64 characters is accepted for identification. A missing one is error 10. The key never grants access on its own. Write and auth calls are authorised by **our** credentials: a session key, a token we issued, or an app password.

**Signatures are method-scoped.** `api_sig` is checked (§7.4) **only for methods whose §7.5 Auth column contains `sig`**: the `auth.*` methods and the write methods. For read methods it is ignored whether present, absent or wrong, and a supplied `sk` only identifies the caller (for example `user.getInfo` without `user`, or `extended=1` loved flags for the caller); an unknown `sk` on a read is ignored rather than error 9. Pano and multi-scrobbler (through `lastfm-ts-api`) send unsigned read GETs carrying `sk` and `api_key`, which a per-key policy would have answered with 13.

**Desktop flow:**
1. `auth.getToken` (signed, §7.4) returns `<token>` with 32 hex characters, valid for 60 min and single-use (`lastfm_tokens`, `issued`).
2. The client opens `https://music.214510.xyz/api/auth/?api_key=K&token=T` (or `/api/auth?…`, without the slash), which 302-redirects to the SPA page `/lastfm/authorize?api_key=K&token=T`.
3. The signed-in user sees the client name and approves. A name from an issued app is shown as the user's own; a name from a known public pair or from `api_key` plus the request's User-Agent product is labelled **unverified**, with the token's request time. The page sends `POST /api/v1/lastfm/authorize {apiKey, token}` with cookie and CSRF, and the token becomes `authorized` for the DID.
4. `auth.getSession {token}` consumes the token and returns:
   ```
   <session><name>{username}</name><key>{sk}</key><subscriber>0</subscriber></session>
   ```
   JSON form: `{"session":{"name","key","subscriber":0}}`.

   The token is bound to the `api_key` that called `auth.getToken`; `auth.getSession` with another `api_key` is **4**.

   Errors:
   - unknown or consumed token → **4**;
   - not yet authorized → **14**;
   - expired → **15**.

**Web flow:**
- `/api/auth?api_key=K&cb=URL` or `/api/auth/?api_key=K&cb=URL` → the same approval page. multi-scrobbler sends the slash-less form with a `cb` that already carries a query (`http://localhost:9078/librefm/callback?state=x`). On approval the server creates an authorized token and the page navigates to `cb` with `?token=T`, or `&token=T` if `cb` already has a query string.
- `cb` must be an absolute URL whose scheme is not `javascript:`, `data:`, `vbscript:` or `file:`. App deep links such as `pano://` are allowed. The page shows the destination host before approval.
- If the user denies, the page does not redirect.

**Mobile flow:**
- `auth.getMobileSession {username, password}`, POST and signed. `username` is our username, a verified handle or a DID (§9). `password` is an **app password** issued in Settings, never an atproto credential.
- Errors:
  - wrong credentials → **4**;
  - `authToken` (deprecated; it would require storing `md5(password)`) → **4** "authToken is not supported; use password";
  - more than 10 failed attempts per (username, IP) pair or 30 per IP in 15 min → **29**. The limit is keyed by the pair, so nobody can lock another user out by guessing at their name; app passwords have 120 bits, so the limit is not what stops guessing.
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

**Policy by `api_key`**, applied only to methods that require `sig` (§7.3):
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
| `library.removeScrobble` | POST | sk, sig | GNU FM extension used by Pano: `artist`, `track`, `timestamp`. Matches, at that second, the owner's newest indexed record **and** the caller's own `scrobble.create` operations not yet indexed: a still-`queued` create is `cancelled` (nothing reaches the PDS, its unsent forward rows are deleted); a `running` or `succeeded`-but-unindexed create gets a `scrobble.delete` chained after it as a predecessor; an indexed record gets a `scrobble.delete`. No match → **7** "Invalid resource specified", as GNU FM answers; Pano treats 7 and 3 as success, so a double tap, a retry or an indexer race never shows a failed unscrobble. |
| `user.getTrackScrobbles` | GET/POST | none | `user`, `artist`, `track`, `limit`, `page`, `from`, `to`: the user's listens of one track in the `getRecentTracks` shape (`trackscrobbles` root), from the same engine. Pano uses it for GNU FM accounts. |
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

Unknown users and unknown tracks use **6** with a specific message, as Last.fm does. A `removeScrobble` with no match uses **7** (§7.5).

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
- **Web Scrobbler supports scrobbles and now playing only.** Its ListenBrainz love and unlove ignore the custom URL and call `api.listenbrainz.org` with the user's token, so a love never reaches this server and the token we issued goes to MetaBrainz. `docs/compat/listenbrainz.md` tells users not to use love with the custom entry, and to revoke and re-create the token in Settings if they did. Our tokens are not ListenBrainz tokens, so MetaBrainz rejects them, but the value has still left our trust boundary.
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
- **Token first.** The `Authorization` header and the per-token rate limit are checked **before any body byte is read**, as ListenBrainz validates the header first. An unauthenticated or rate-limited submit gets its 401 or 429 with zero body bytes read, so nobody can make the server buffer 10 MB anonymously.
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
- **Per-listen checks** follow ListenBrainz `validate_listen` exactly. **A 400 is returned only for input ListenBrainz itself rejects**, because clients treat any 400 as fatal: Web Scrobbler maps every 400 to `ERROR_AUTH` and drops the whole batch.
  - `listened_at` is coerced with `int()` and must be ≥ 1033430400;
  - `listened_at` must be **≤ now + 3,600 s**, ListenBrainz's own bound ("Value for key listened_at is too high.");
  - `playing_now` must omit `listened_at`;
  - only the allowed top-level keys;
  - `artist_name` and `track_name` are required, must be strings, are trimmed and must be non-empty;
  - an empty `release_name` is deleted;
  - `duration` and `duration_ms` together are rejected, and each is range-checked;
  - MBIDs: null or empty values are deleted, other invalid values give "`<key>` MBID format invalid.";
  - at most 50 tags of at most 64 characters (validated, then dropped);
  - NUL anywhere is rejected.
- **Our stricter rules never fail the request** (Q11):
  - **Clock skew.** A listen with `now + 300 s < listened_at ≤ now + 3,600 s` passes ListenBrainz's rule but not our lexicon bound (`listenedAt ≤ createdAt + 300 s`). It is accepted and its `scrobble.create` operation is **deferred**: `due_at = createdAt = listened_at − 300 s`, so the record is never sent before it is valid and our own indexer never excludes it. The listen key, the forward rows and the 200 answer are immediate.
  - **Names.** A listen whose `artist_name` or `track_name` fails our scrobble validator (for example more than 256 scalars, or malformed UTF-16) but passes ListenBrainz's checks is **not written**. It is recorded in `ignored_listens` (reason `artist_invalid` or `track_invalid`, the first 128 scalars of each name, kept 30 days and listed by `GET /api/v1/account/ignored-listens`), and the other listens of the request are processed normally. The response is still 200 `{"status":"ok"}`.
  - So a batch of three with one over-long name answers 200, writes two operations and logs one ignored listen.
- **Error body:** `{"code":400,"error":"…"}`. The offending listen's keys are not merged in.
- **`single` and `import`:** the same transaction as §7.7 (listen key, operation with origin `listenbrainz` and priority 0, forward rows). The daily cap gives 429 "Daily listen limit exceeded." with `Retry-After`, `X-RateLimit-Limit`, `-Remaining`, `-Reset`, `-Reset-In` and `Access-Control-Expose-Headers` (the §8.7 set, describing the daily window). A client `import` (an offline cache flush) is a live submission, not an import job.
- **`playing_now`:** upserts `now_playing`. The TTL is `duration`, else `duration_ms`/1000, else 600 s. An identical current track is ignored but still answers ok.
- **`return_msid`:** honoured for `playing_now` only, as ListenBrainz does; any non-empty value counts (ListenBrainz's truthiness). Response `{"status":"ok","recording_msid":"<msid>"}`. For `single` and `import` it is ignored and the response is `{"status":"ok"}`.
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
  - the MSID is mapped back through `scrobbles.recording_msid` for the user's own indexed listens, then through the user's current `now_playing` row and their not-yet-indexed `scrobble.create` operations (an MSID is a pure function of the artist and track keys, so each candidate is checked by recomputing it). A love right after a scrobble or while playing therefore works. An MSID with no candidate answers 200 `{"status":"ok"}` and stores nothing, as ListenBrainz does for an MSID it cannot use.
- `GET /1/feedback/user/{user}/get-feedback?score&count&offset&metadata` → `{feedback: [{recording_msid, recording_mbid, score: 1, created, track_metadata?}], count, total_count, offset}`.

**Social:** `GET /1/user/{user}/following` → `{following: [names], user}`, and `/followers` → `{followers: [names], count, user}`, from the follow records.

**Deletes and now playing:**
- `POST /1/delete-listen {listened_at, recording_msid}` (token) → a `scrobble.delete` operation for the newest matching own record at that second; `{"status":"ok"}`.
- `POST /1/playing-now/delete {client?}` (token), in ListenBrainz's order: no current entry → 200 `{"status":"ok","message":"Playing now already cleared"}`; an entry whose stored `submission_client` is set and differs from `client` → 404; otherwise (including an entry with no stored client) the entry is cleared → 200 `{"status":"ok","message":"Playing now cleared successfully"}`.

**Not implemented (404):** `/1/metadata/*`, `/1/latest-import`, `/1/export/*` and playlists.

### 8.7 Rate limits
- Per IP (keyed by `rateKeyOf`, so an IPv6 /64 is one key, §3.6): 30 requests per 10 s on `/1/`. Per token: 100 requests per 10 s.
- **Order.** A request with a valid token is limited by its **per-token** bucket only, and the per-IP bucket applies to unauthenticated requests (and to the token check itself). An authenticated request is never denied because the per-IP bucket set is full: per-IP sets evict the least recently used bucket when they reach `MAX_BUCKET_KEYS` (10,000) instead of refusing every new key (`BucketSet` option `onFull: 'evict-lru'`, N1-06); per-credential sets keep the existing refusal.
- Headers: `X-RateLimit-Limit`, `-Remaining`, `-Reset`, `-Reset-In`, and `Access-Control-Expose-Headers` listing them.
- Over the limit: 429 `{"code":429,"error":"You have exceeded your rate limit. See the X-RateLimit-* response headers for more information on your current rate limit."}`.

---

## 9. User names across protocols
- Both protocols need a stable `user` name, and handles are mutable.
- Each signed-in DID gets `accounts.username`. On first sign-in it is derived from the verified handle: lowercased, characters outside `[a-z0-9._-]` removed, truncated to 64, with `-2`, `-3` … appended on collision. It never changes automatically.
- **Dots are reserved for handles.** A username containing a dot is assigned only when it equals the account's own verified handle at that moment (the first-sign-in derivation, or a rename to one's own current handle). Every other rename must be dotless (422 `username_invalid`); a taken name is 409. Otherwise a user could rename to `bob.com`, Bob's verified handle, before Bob signs in, and every client asking for `user=bob.com` would get the wrong account.
- A protocol `user` value (Last.fm `user`/`username`, ListenBrainz `{user}`, `getMobileSession username`) resolves as follows:
  1. a value starting with `did:` → that DID;
  2. a **dotless** value → an `accounts.username`, case-insensitive;
  3. a **dotted** value → an `accounts.username` equal to it only while its owner's currently verified handle still equals it; otherwise it falls through to
  4. a currently verified handle, case-insensitive.
  A stale dotted username (its owner changed handle) therefore never shadows the handle's real owner. The UI warns about a stale dotted username and offers a rename.
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

**Budgets** (N5-02, report-only): on the 100k-listen fixture, uncached top tracks overall p95 < 250 ms, cached hit < 20 ms, `getRecentTracks` page 500 < 100 ms. The gate asserts query plans, not timings (§15).

---

## 11. Import from Last.fm and ListenBrainz (`worker/src/imports/*`)

### 11.1 Sources
| Source | How | Requirements |
|---|---|---|
| `lastfm_api` | `user.getRecentTracks` with `limit=200`, `extended=1`, our api_key, the `sk` of a linked Last.fm account when one exists (needed for hidden recent listening), and a fixed `to` set at job start. Paging walks **backward**: the next request's `to` is the page's oldest `uts` + 1, and listens at that boundary second are deduplicated. If a page brings nothing older, `to` becomes the oldest `uts`, so progress is guaranteed. The `nowplaying` row is skipped. | The owner's Last.fm key. Otherwise 503 `lastfm_not_configured`. |
| `lastfm_json` | Upload of the lastfm.ghan.nl export: a JSON array of getRecentTracks pages. | None |
| `listenbrainz_api` | `GET /1/user/{name}/listens?count=1000&max_ts=…`, walking backward. The next `max_ts` is the oldest `listened_at` + 1, deduplicated, with the same progress rule. The user's linked token is sent when present. | None. A 100k history is about 100 requests. |
| `listenbrainz_zip` | Upload of the ListenBrainz export ZIP: `listens/<YYYY>/<M>.jsonl` with float `listened_at` and an `mbid_mapping` that is null or an object (`recording_mbid`, `release_mbid`, `artist_mbids`, …), plus `feedback.jsonl`. The record's MBIDs come from `track_metadata.additional_info` only (what the user's player submitted); `mbid_mapping` is ListenBrainz's own mapping and is used only to resolve feedback. | None |

- **Upload limits:** body ≤ 64 MiB, streamed to `ATMUSIC_UPLOAD_DIR/<job>.upload` (mode 0600). Before accepting an upload the server checks that the directory's total plus the declared length stays under `ATMUSIC_UPLOAD_MAX_BYTES` (1 GiB) and that the filesystem keeps `ATMUSIC_MIN_FREE_BYTES` (2 GiB) free; otherwise 507 `insufficient_storage` and nothing is written. The bytes actually received are counted against the same bounds while streaming. Below the floor the import writer also pauses (§5.5).
- **Upload lifetime.** The file is deleted as soon as it is fully parsed into staging, and when its job is cancelled or fails; `upload_path` is then NULL. A startup sweep deletes any file with no live job. `atmusic-admin status` reports the directory's size.
- **Streaming parse, bounded memory.** Nothing is inflated or parsed whole. ZIPs go through `fflate`'s streaming `Unzip` with `UnzipInflate` (pinned exactly, newest ≥ 7 days at pin time); JSONL is split line by line (a line over 1 MiB is invalid); the Last.fm JSON export (a top-level array of pages) is split into pages by a small depth-tracking tokenizer, and each page is parsed alone. Bomb bounds count **actual inflated bytes**, never the sizes declared in ZIP headers, which are attacker-controlled: ≤ 10,000 entries, ≤ 64 MiB inflated per entry, ≤ 256 MiB inflated in total (well under `MemoryMax=1G`), and a ratio ≤ 100 per entry. Crossing any bound aborts the parse and fails the job. Entry names are restricted to `listens/\d{4}/\d{1,2}\.jsonl`, `user.json` and `feedback.jsonl`; anything else is skipped unread.
- **Feedback** (`feedback.jsonl`) rows carry only `recording_msid`, `recording_mbid`, `score` and `created`, with no artist or track, so each is resolved against the same archive's listens: a `recording_msid` maps to the newest archive listen with that `recording_msid` and takes its `artist_name` and `track_name`; otherwise a `recording_mbid` maps to the newest archive listen whose `mbid_mapping.recording_mbid` or `additional_info.recording_mbid` equals it. Score 1 becomes a `love.put` with origin `import`. Scores 0 and −1 are skipped (nothing to undo in a fresh import). An unresolved row counts as `invalid` with reason `feedback_unresolved`. Resolution needs the whole archive, so feedback is processed after every listens entry.

### 11.2 Pipeline and dedupe
1. **Wait.** A job starts in `waiting_index` until the DID's `indexing_state='current'`. Its existing PDS records must be indexed before dedupe means anything. Sign-in admits the DID (§5.7); if the DID still has no `users` row (admission answered `queue_full`), each `import` timer run retries `admit(…, 'notify', …)` for that job's DID, with backoff, until it is admitted. The admission snapshot then sets `indexing_state`, including for a DID with zero records.
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

**Crash-loop guard.** `import_jobs.attempts` is incremented in its own committed transaction **before** each fetch, parse or write slice, and reset to 0 when the slice commits. A job found with `attempts ≥ 3` (three slices that never completed, for example an out-of-memory kill) becomes `failed` with error `crash_loop` and its upload is deleted, so one bad job cannot restart the service until `StartLimitBurst` takes it down for everyone.

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

`dedupe_key` is unique per `(link_id, kind, dedupe_key)` and is defined per kind:

| Kind | `dedupe_key` | Effect |
|---|---|---|
| `scrobble` | The listen key (§7.7) | A client resend never double-forwards |
| `nowplaying` | `sha256(did ‖ started_at_ms ‖ artist_key ‖ track_key)`, with `started_at_ms` from the `now_playing` row | A same-track refresh keeps `started_at_ms` and is not re-forwarded; the same track played again later is |
| `love`, `unlove` | The `love.put` / `love.delete` operation id | love, unlove, love forwards three calls in order |

A timestamp-free key for the last three kinds would make the UNIQUE constraint drop repeat toggles and repeat plays.

### 12.3 Delivery, retry and revocation

| | Last.fm | ListenBrainz |
|---|---|---|
| **Request** | Signed `track.scrobble` with ≤ 50 queued rows per link, oldest first, the original uncorrected input, and the global 1 request/s bucket. `updateNowPlaying` once. `track.love`/`track.unlove`. | `single` for one live listen; `import` with ≤ 100 rows for a backlog; `playing_now` once; `feedback/recording-feedback` by `recording_mbid` when known, otherwise not forwarded. One request per second per link. |
| **Success** | Per item: code 0 → `sent`; `ignoredMessage` code 5 (daily scrobble limit) → re-queued at the next 00:00 UTC, still subject to the 13-day expiry; any other non-zero code → `ignored`, recorded and not retried. | 200 → `sent`. |
| **Retry** | Codes 11, 16, 29, 8, HTTP 5xx or 429, network errors: backoff `30 s·2^n + U[0, 25%]`, capped at 6 h. Last.fm drops scrobbles older than about 14 days, so a row older than **13 days** becomes `expired`. | 5xx, 503 and network errors: the same backoff. ListenBrainz accepts old listens, so its rows expire after **30 days**. 429: wait `X-RateLimit-Reset-In`. 400: row `failed` with the error, not retried. |
| **Revocation** | Codes 9 or 4: link `revoked`, its rows `held` (kept 30 days, resumed on relink). Codes 10 or 26 (our key is invalid or suspended): **all** Last.fm forwarding pauses, and `adminStatus` raises `lastfm_key_rejected`. | 401: link `revoked`, rows `held`. |
| **Now playing** | Sent once with no retry, skipped if more than 60 s old. | Same. |

**Idempotency upstream** is **at least once**. A request that times out after the upstream accepted it can be duplicated on retry. Neither service offers an idempotency key, and this is documented.

---

## 13. Security

| Concern | Realisation |
|---|---|
| **Verification** | Unchanged. No production flag can skip TLS, signature, CID, MST, DNS or IP policy, or the OAuth issuer check. Nor can the runtime environment: the unit unsets the Node and OpenSSL variables that would disable TLS checks, add CAs, set proxies or inject code, `run()` exits 78 if any is present, and the undici Agent and `ws` pass `rejectUnauthorized: true` explicitly (§3.8, §14.1). The OAuth issuer check uses our identity resolver, not the library's default PLC resolver (§5.2). Indexing is only through proofs. The Node build re-proves every crypto vector (§3.9). |
| **SSRF** | The pinned transport applies to every outbound fetch (§3.5): PDS, AS, PLC, Last.fm, ListenBrainz. SafeFetch covers reads; `policyFetch` covers every POST and every OAuth, write, forward and import request with the same URL, redirect, deadline and size rules. Loopback, LAN, link-local, CGNAT, ULA, multicast and reserved addresses are refused at connect time. The global `fetch` is replaced by a throwing stub, a spy-transport test proves every consumer is wired, and the bundle guard rejects unpinned fetch paths. Admin routes are not on TCP at all. |
| **Secrets** | Delivered as a systemd credential (§3.8), never in the environment. User credentials at rest are AES-256-GCM with AAD: OAuth sessions and states, linked `sk` and ListenBrainz tokens, and issued app secrets. Our own issued bearer credentials (session keys, ListenBrainz tokens, app passwords, web sessions) are stored only as SHA-256, and their random values are shown once. |
| **No secret in logs** | The logger drops fields whose names match `/token\|sk\|password\|secret\|authorization\|cookie\|api_sig\|key\|dpop\|jwk/i`. Request logs record method, route pattern, status and duration, and **never a query string or body on any route** (§3.10); only the Last.fm `method` name is logged, from an allowlist. Credentials travel in query strings on `/api/auth`, `/lastfm/authorize` and `/api/v1/links/lastfm/callback` as well as on `/2.0` and `/oauth/callback`, and a desktop token is redeemable by whoever reads it, so no route is exempt. A test captures all log output of the in-process journeys, including the Last.fm desktop and web approval flows and the Last.fm link callback, and fails if any secret value seen in the run appears in it. Error envelopes never echo credentials. |
| **CSRF** | §5.6: exactly one Origin plus the HMAC token, on cookie routes and on `auth/start`. Protocol routes ignore cookies. **Login CSRF:** the OAuth callback requires the `__Host-atmusic_oauth` cookie whose hash is bound to the state. The link callback uses single-use state bound to the existing session. |
| **Cookies** | `__Host-` prefix, HttpOnly, Secure, SameSite=Lax. Only hashes are stored. 30 days with renewal. |
| **Trusted proxy headers** | §3.6. `PUBLIC_ORIGIN` is the only source of URLs and of the expected Origin. Behind a tunnel, `Host` and `X-Forwarded-*` are never trusted for security decisions. Host mismatch → 421. |
| **Rate limits** | In-memory buckets (`worker/src/http/limits.ts`, fail-open after a restart, documented), keyed by the trusted client IP (`rateKeyOf`: IPv4 address or IPv6 /64, §3.6) and by credential. Credential buckets are checked first; an authenticated request is never refused because the per-IP set is full, and per-IP sets evict their least recently used bucket at 10,000 keys instead of refusing new keys (§8.7). Behind proxied Cloudflare DNS the client IP must come from `CF-Connecting-IP` through the proxy's real-IP configuration, never from the edge address (§14.6): <br>• `/api/v1` notify: 60/min per IP and 600/h per DID (unchanged); <br>• `auth/start`: 10/min per IP; <br>• `getMobileSession`: 10 failures per 15 min per (username, IP) and 30 per 15 min per IP; <br>• `/2.0`: 60/min per IP for reads and 120/min per `sk` for writes; <br>• `/1/`: §8.7; <br>• uploads: 3/h per DID. <br>Daily listen cap: 3,000 per DID. Cloudflare Free's single WAF rule can coarsely shield `/2.0/` and `/1/submit-listens` (owner's choice). |
| **Abuse** | Body caps per route, JSON depth ≤ 32, streaming parses with ZIP bomb bounds on actual bytes, and the import crash-loop guard (§11). **Sign-in is an allowlist by default** (`ATMUSIC_SIGNIN_POLICY`, §5.7), so throwaway accounts cannot register on the owner's machine. Only signed-in DIDs can hold protocol credentials or upload. Upload files are deleted once parsed, with a global 1 GiB cap and a 2 GiB free-space floor (507). New DIDs enter ingestion only through admission (unchanged). The open `api_key` policy does not let anyone write without our credential. |
| **XSS** | The CSP tightens to `connect-src 'self'`. JSONP is not served. XML and JSON are encoded, never templated. `dangerouslySetInnerHTML` stays banned. The Last.fm approval page shows the callback host and requires a click. |
| **Open redirect** | The Last.fm `cb` is followed only after explicit approval, with dangerous schemes refused. `returnTo` after OAuth must be a known SPA path. |
| **Single instance** | `locking_mode=EXCLUSIVE` on the database file (§3.2, §3.10): a second process on the same db exits 75 whatever its admin socket path. Restore stops `atmusic.socket` and `atmusic.service` first (§14.5). |
| **Residuals** | Local processes can reach `127.2.0.1:8888` and, from a trusted proxy address, forge the configured client-IP header (single-user host; documented). A stolen db file or backup does not reveal sessions without the encryption key. A stolen secrets file plus the db does. **Same-UID exposure:** any process running as the owner's UID can read the database, ask `systemd-creds` to decrypt `secrets.cred` (it is bound to the UID, not to the service), and connect to the admin socket; `npm ci` install scripts run as that UID too. `docs/operations.md` documents this, recommends a dedicated `atmusic` user with linger for stronger isolation, and the install uses `npm ci --ignore-scripts`. |

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
# ATMUSIC_CLIENT_IP_HEADER and ATMUSIC_SIGNIN_DIDS are set in atmusic.env (required; §3.8, §14.6)
EnvironmentFile=-%E/atmusic/atmusic.env
# The user manager's environment is inherited; none of these may reach Node (§3.8). run() exits 78 if one does.
UnsetEnvironment=NODE_OPTIONS NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS NODE_USE_ENV_PROXY NODE_PATH
UnsetEnvironment=HTTP_PROXY http_proxy HTTPS_PROXY https_proxy NO_PROXY no_proxy ALL_PROXY all_proxy
UnsetEnvironment=SSL_CERT_FILE SSL_CERT_DIR
ConfigurationDirectory=atmusic
StateDirectory=atmusic
StateDirectoryMode=0700
RuntimeDirectory=atmusic
RuntimeDirectoryMode=0700
LoadCredentialEncrypted=secrets:%E/atmusic/secrets.cred
Restart=on-failure
RestartPreventExitStatus=78 75
RestartSec=2s
RestartSteps=5
RestartMaxDelaySec=2min
TimeoutStartSec=15min
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

**Unverified directives.** If `~@resources` causes EPERM under the full workload, drop only that line. `UnsetEnvironment=` was added in review round 2 and was not part of the ops research; `scripts/test/systemd-unit.test.ts` asserts the full list, and `systemd-analyze --user verify` in `node-backend.sh` (N8-01) checks the unit. `UnsetEnvironment=` applies after `EnvironmentFile=`, so `atmusic.env` cannot set these variables either.

**Paths:**
- **State:** `~/.local/state/atmusic`, through `StateDirectory=`, the systemd-native choice. It holds `atmusic.db`, `backups/` and `imports/`. `ATMUSIC_DB` can point elsewhere, for example `~/.local/share/atmusic` with `ReadWritePaths=`.
- **Config:** `~/.config/atmusic` (`atmusic.env`, `secrets.cred`).
- **Runtime:** `$XDG_RUNTIME_DIR/atmusic/admin.sock`.

**Optional `atmusic.socket`** (`ListenStream=127.2.0.1:8888`, `Accept=no`) keeps the port open across restarts, so a tunnel sees queued connections instead of 502s. Because an inbound connection starts the service, every tool that must keep the service stopped (restore, §14.5) stops the socket unit first.

**Exit codes and restarts:** 78 (configuration) and 75 (database locked by another instance) are never restarted; `TimeoutStartSec=15min` plus `EXTEND_TIMEOUT_USEC` covers a long pre-migration backup and migration (§3.10).

**Linger:** `loginctl enable-linger` is required. It is allowed for self without authentication on this host (polkit `set-self-linger`). With linger, the user manager starts at boot without the Plasma session environment, so the unit sets everything it needs and does not depend on `graphical-session.target`.

**Activate:**
```sh
loginctl enable-linger
systemctl --user daemon-reload
systemctl --user enable --now atmusic
```
`install-local.sh` prints these commands. It runs them only with `--enable`, and it never touches linger without being asked. When the database does not exist yet, it runs `node main.mjs --init` once (§3.2).

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
   npm ci --ignore-scripts && npm run build:web && npx tsx scripts/build-server.ts
   ```
   `npm ci` never runs inside the sandboxed unit, and never runs dependency install scripts.
2. `atmusic-admin backup`. The server also takes a pre-migration backup itself when a migration is pending.
3. Switch the link atomically: `ln -sfn releases/<sha> current.tmp && mv -T current.tmp current`.
4. `systemctl --user restart atmusic`, then poll `/health/ready`.

**Rollback:** point the link back and restart. Migrations are additive and `schema_compat.min_compatible_version` stays at or below the old release's version (§3.2), so the old code runs on the migrated database: it ignores the new tables and columns. **Rollback never restores a backup.** Restoring the pre-migration backup would silently undo security state (credentials and sessions revoked since then would come back; `oauth_sessions` would revert to refresh tokens the AS has already rotated, so refreshes fail with `invalid_grant`) and would lose operations, listen keys and forward rows acknowledged with 200 since the backup, contradicting §3.2. Restore is disaster recovery only (§14.5).

**Gentoo:** Node links against the system `libsqlite3` (`dev-db/sqlite-3.54.1`). After `emerge -u` of nodejs or sqlite, restart the service. The owner can pin versions with `package.mask`.

### 14.4 Health and monitoring
- `/health/live` and `/health/ready` (§3.10), plus the systemd watchdog. systemd has no HTTP health check, and none is needed.
- `atmusic-admin status` shows backup age, Jetstream lag, outbox and forward depths, import progress, `reauth_required` count, sessions per `client_kid`, and Last.fm key health.
- An optional external probe is documented, not installed.

### 14.5 Backups (`worker/src/node/backup.ts`, N3-07)
**In-process, daily at 03:30 UTC and on demand (`atmusic-admin backup`):**
0. **Free-space check.** The backup refuses to start (recorded as a failed `backup_runs` row with error `low_disk`, and surfaced by `adminStatus`) unless the backup filesystem has at least the database size plus `ATMUSIC_MIN_FREE_BYTES` free, so a backup can never fill the disk under the live database (§5.5).
1. `node:sqlite`'s async `backup(db, 'backups/atmusic-YYYYMMDDTHHMMZ.db.tmp', {rate: 100})` copies the live database incrementally, yielding to the event loop between steps, so HTTP, Jetstream pings, timers and `WATCHDOG=1` continue. (`VACUUM INTO` and an inline `integrity_check` would block the main thread for seconds to minutes on a large index, past `WatchdogSec=60s`.)
2. `PRAGMA integrity_check` runs in a `worker_thread` on its own read-only connection to the **copy**, never the live file.
3. Rename, fsync the file and the directory, and record a `backup_runs` row.
4. Retention: 7 daily and 4 weekly, counting `daily` and `manual` runs only. Pre-migration and pre-restore copies are kept until the owner deletes them and are listed by `atmusic-admin status`. Files are mode 0600.

**Pre-migration backup:** at startup when `SCHEMA_VERSION` is above the db's version, with the same `backup()` call and the same free-space check, before `READY=1`, under `EXTEND_TIMEOUT_USEC` (§3.10). If the free-space check fails, startup exits 78 naming `ATMUSIC_MIN_FREE_BYTES` rather than migrating without a backup.

**What a backup contains:** the derived index, which can be rebuilt from public repositories, plus the **non-derived** accounts, sessions, links, credentials hashes, operations, imports and forward queue (`TABLE_CLASS`, §6.4). Credentials inside are ciphertext under keys that are **never in the backup**. Because a backup holds security state, an unmerged restore would resurrect revoked credentials; that is why restore keeps the live non-derived state (step 3). This supersedes ADR 0004 A15 ("derived data, no file backup").

**Revocation journal** (`worker/src/app/revocations.ts`, N1-08). Every revocation or deletion of a credential is also appended, before the transaction that deletes the row commits, to `$STATE_DIRECTORY/revocations.log` (outside the database, mode 0600, one JSON line per event, `fsync` after each append): web session hashes (logout, logout-all, expiry is not journaled), Last.fm session ids, app password ids, ListenBrainz token ids, issued app keys, linked account ids, OAuth session DIDs, and account disconnects (§5.7). It carries hashes and ids only, never a secret. Backups do not include it, and restore replays it. When a backup completes it is truncated to the entries newer than the oldest backup file still present in `ATMUSIC_BACKUP_DIR` (pre-migration and pre-restore copies included), so every backup that can be restored has its journal.

**Restore** (`scripts/admin/restore.ts <file>`) is disaster recovery only (§14.3):
1. `systemctl --user stop atmusic.socket atmusic.service`, then require `systemctl --user is-active` to report both inactive. Without stopping the socket unit, an inbound connection during the restore would socket-activate the service while the db is moved aside or half copied. The single-writer lock (§3.2) is a second barrier: restore opens the live db with `locking_mode=EXCLUSIVE` and aborts if it cannot.
2. Copy the live db and its `-wal` to `atmusic.db.pre-restore` (a consistent `backup()` copy).
3. Build `atmusic.db.restore.tmp` from a copy of the backup. The copy is first migrated to the code's schema version (migrations are additive, §3.2), so it has every table the live db has.
   - **When the live db is readable**, every **non-derived** table of `TABLE_CLASS` is replaced wholesale by the live table's rows, and only the **derived** tables keep the backup's rows. This keeps every account rename, post-backup sign-in, credential, session, revocation, operation, listen key, forward row and import exactly as they are live; the backup contributes only the rebuildable index, and its Jetstream cursor and timers stay consistent with that index. A table missing from `TABLE_CLASS` aborts the restore (the N1-10 test makes that impossible in a released build).
   - **When the live db is unreadable** (the reason for most restores), restore prints what cannot be carried over (everything non-derived after the backup's time) and refuses unless `--accept-loss` is given. With it, **every `web_sessions` row is deleted** (everyone signs in to the web UI again), and `revocations.log` is **replayed**: each journaled revocation deletes its row from the restored copy, so a credential, link or OAuth session revoked after the backup stays revoked.
   - A per-table summary is printed.
4. Make the copy self-contained and swap it in, in this order:
   1. open `atmusic.db.restore.tmp` with `journal_mode=DELETE` (which checkpoints and removes its WAL), close it, and assert that no `atmusic.db.restore.tmp-wal`, `-shm` or `-journal` exists, so no merged row can be left behind in an unrenamed WAL;
   2. `fsync` the temporary file;
   3. delete the live `atmusic.db-wal`, `atmusic.db-shm` and `atmusic.db-journal` (the pre-restore copy of step 2 holds their content) and `fsync` the directory, so no stale WAL can ever be paired with the restored file;
   4. rename `atmusic.db.restore.tmp` over `atmusic.db` and `fsync` the directory again.

   A crash between any two steps leaves either the old file without a WAL (recoverable from `atmusic.db.pre-restore`) or the complete restored file, never a mispaired pair. The server sets `journal_mode=WAL` again at its next start (§3.2).
5. `systemctl --user start atmusic.socket atmusic.service`.

**Offsite copies** are the owner's choice (`rclone` to the R2 free tier, or an external disk), documented and not built. Litestream is opt-in only, since it is a second resident process, and needs `sync-interval ≥ 1m` to stay inside R2's free operations.

### 14.6 Public exposure (owner's choice; documented in `docs/deploy/exposure.md`)
**A. Cloudflare Tunnel (recommended):**
- `cloudflared` runs as a second user unit. Ingress: `hostname: music.214510.xyz → service: http://127.2.0.1:8888`, then a catch-all `http_status:404`.
- It is outbound-only (port 7844), needs no public IP, and sends `CF-Connecting-IP`, which the Cloudflare edge sets itself, overwriting any client-supplied value.
- The edge read timeout is 125 s, so long work stays asynchronous.
- Set `ATMUSIC_CLIENT_IP_HEADER=cf-connecting-ip`. No other process may listen on a trusted proxy address and relay public traffic.

**B. Caddy or nginx on this host, DNS only (no Cloudflare proxy):**
- Listens on `:443` with an ACME certificate and proxies to `127.2.0.1:8888`, with port forwarding. The Cloudflare record, if any, is **DNS only** (grey cloud), so the TCP peer is the real client.
- Needs a reachable public IP; CGNAT, dynamic IPs and port blocks are risks.
- Set `ATMUSIC_CLIENT_IP_HEADER=x-forwarded-for`, and make the proxy drop any client-supplied `CF-Connecting-IP` and replace `X-Forwarded-For` with the peer address:
  - Caddy: `reverse_proxy 127.2.0.1:8888 { header_up -CF-Connecting-IP; header_up X-Forwarded-For {remote_host} }`;
  - nginx: `proxy_set_header CF-Connecting-IP ""; proxy_set_header X-Forwarded-For $remote_addr;`.
- **These directives are only for DNS-only exposure.** Behind proxied Cloudflare DNS the peer is a Cloudflare edge address, so `{remote_host}` and `$remote_addr` would give every client the same few edge IPs, and one abuser would exhaust the per-IP buckets for everyone. Use C instead.

**C. Cloudflare proxied DNS (orange cloud) to a Caddy or nginx on this host:** all three of the following are **required**:
1. **Authenticated Origin Pulls** (mTLS: the proxy verifies Cloudflare's origin-pull client certificate) and a host firewall admitting `:443` only from Cloudflare's published IP ranges, so nobody can connect directly and forge `CF-Connecting-IP`;
2. the proxy derives the client IP from `CF-Connecting-IP`, trusting it only from Cloudflare ranges:
   - Caddy: global `servers { trusted_proxies static <Cloudflare ranges>; client_ip_headers Cf-Connecting-Ip }`, then `reverse_proxy 127.2.0.1:8888 { header_up -CF-Connecting-IP; header_up X-Forwarded-For {client_ip} }`;
   - nginx: `set_real_ip_from <each Cloudflare range>; real_ip_header CF-Connecting-IP;`, then `proxy_set_header CF-Connecting-IP ""; proxy_set_header X-Forwarded-For $remote_addr;` (after the realip module, `$remote_addr` is the client);
3. `ATMUSIC_CLIENT_IP_HEADER=x-forwarded-for`.

`docs/deploy/exposure.md` keeps the Cloudflare range list as a dated snapshot with the URL it came from and tells the owner to refresh it; the application never fetches it.

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
- `worker-modules` (the old DO module tests over the Node harness: first through the `cloudflare:*` shim, N2-02, then de-shimmed, N4-04 to N4-06);
- `worker-node` (new: `worker/test/node/**`);
- `worker-composition`, `worker-acceptance` and `worker-bench` (N4-03);
- `web` (happy-dom);
- `scripts` and `scripts-gate`.

The `sequence.groupOrder` isolation is kept.

**Two-step port of worker-modules.** The worker-modules suites are 52 files and about 17.7k lines with about 260 `runInDurableObject`, `runDurableObjectAlarm` and `evictDurableObject` calls. Rewriting them in one package would make the titles-kept guarantee depend on one huge mechanical edit, so:
1. **Shim (N2-02).** worker-modules switches to `environment: 'node'` with `resolve.alias` entries mapping `cloudflare:test` and `cloudflare:workers` to `worker/test/node/support/cloudflare-test-shim.ts` and `cloudflare-workers-shim.ts`. The shim implements `env` (the harness namespace bindings), `runInDurableObject`, `runDurableObjectAlarm`, `evictDurableObject` and a `DurableObject` base class over node-db, with a DO-storage facade whose `sql.exec` cursor runs on node:sqlite (so `doDb(state.storage)` keeps working), and a setup file defines an in-memory `WebSocketPair` for `worker/test/fixtures/jetstream-server.ts`. Most files then run **unchanged, with byte-identical titles**. N2-02 edits only the files with named changes (§15.3).
2. **De-shim (N4-04, N4-05, N4-06)**, split by directory, replaces the shimmed calls with the Node harness and removes every `cloudflare:*` import from those suites, keeping titles and the exported API of the shared helpers (`worker/test/write/support.ts`, `worker/test/fixtures/jetstream-server.ts`, owned by N4-04). N7-01 deletes the shim and the aliases.

| DO helper | Node replacement (after de-shim) |
|---|---|
| `runInDurableObject` | `withIndex(fn)` over a temporary-file database |
| `runDurableObjectAlarm` | `core.runAlarmNow()` |
| `evictDurableObject` | close and reopen the same file (TESTING.md's original "restart reopens same storage") |

Each test file gets its own database file, through the shim and after it.

**Timeouts.** No test waits for a production duration: busy timeout, drain window and alarm delays are injected (§3.2, §3.10). Process-level tests spawn the built `main.mjs` from `scripts/test/` with explicit timeouts.

**Playwright** runs against the e2e bundle `worker/dist/node/e2e.mjs` (§3.9), with the fake AS, PDS, PLC, Jetstream, Last.fm and ListenBrainz behind the stack proxy (N6-01).

**Gate duration.** Large-fixture suites live only in `worker-bench` (`worker/test/bench/**`), seeded with direct SQL as `acceptance/query-plans` is, with a small sample through the apply path; nothing under `worker/test/node/**` builds a 100k-listen user. The nested negative controls in `scripts/test/check-ts.test.ts` run the disposable gate with `--projects` limited to the project they exercise, and `check-ts.sh` writes a per-step duration report (`work/gate-durations.json`).

### 15.2 Determinism and fakes
- `fixedClock` and seeded `Random` everywhere. Timers are stepped, and nothing sleeps.
- **No network.** The router transport maps reserved hostnames to fakes:
  - `pds*.test`, `plc.test`, `as.test` (the fake AS);
  - `lastfm.test` (`worker/test/node/support/fake-lastfm.ts`, N1-13: signature-verifying `track.scrobble`/`updateNowPlaying`/`love`, `auth.getSession`, a paged `getRecentTracks`, and scripted error codes 4, 8, 9, 10, 11, 16, 26 and 29);
  - `listenbrainz.test` (`worker/test/node/support/fake-listenbrainz.ts`, N1-13: `validate-token`, recording `submit-listens`, paged listens, `X-RateLimit-*`, scripted 401, 429 and 503);
  - `jetstream.test`.

  The two protocol fakes live under `worker/test/node/support/`, not in `packages/atproto/test-support`, because Last.fm's `api_sig` is MD5, WebCrypto has no MD5, and atproto's test-support compiles without Node types; there they use `node:crypto` directly and are mounted through `routerTransport`'s existing `hosts` option. The AS, PDS and PLC fakes stay in `packages/atproto/test-support`.

  The production SafeFetch and pinning stay on, and the fake resolver answers with public test-net addresses.
- **Loopback exceptions.** Only `jetstream-ws.test.ts` (a `ws` server on port 0), the in-process route tests on `127.0.0.1:0`, and the e2e and acceptance stacks use loopback sockets, always between our own processes. The stacks run `e2e.mjs`, never `main.mjs` (§3.9).
- Real scrobbler client code (`lastfm-ts-api@2.6.2`) and byte-faithful replays of request shapes recorded from client sources (Pano, Web Scrobbler, Navidrome, multi-scrobbler) run only against the local server.
- **Reaching the loopback server with `lastfm-ts-api`.** The library always calls `node:https`'s `request` with a hostname and a path, so it cannot reach `http://127.2.0.1:<port>` by configuration. N8-01 runs it in a child process started with `node --import scripts/e2e/scrobbler-clients/https-to-loopback.mjs`. The preload replaces `https.request` on the `node:https` module object and calls `module.syncBuiltinESMExports()` (the library binds `request` by an ESM named import), so every call is reissued with `http.request` to `127.2.0.1:<port>` with the same method, path, headers and body bytes, `Host: music.214510.xyz` kept. It throws for any other hostname, so the child can never reach a real network. The client is configured exactly as a user would configure it (`hostname: 'music.214510.xyz'`, `path: '/2.0/'`).
- **Web Scrobbler** replays cover scrobbles and now playing only (§8.1).

### 15.3 Keeping the existing tests
- **Policy.** The existing 406 vitest tests and the Python regressions are **kept**. A ported test keeps its file path and title unless this ADR names the change. `docs/verification/node-port-inventory.json` records every pre-port id and its replacement, and `scripts/test/test-inventory.test.ts` enforces it.
- **Named changes:**
  - `sql-conformance` expectations for >2^53 reads, multi-statement text, BEGIN/SAVEPOINT and PRAGMA;
  - `rowsRead` budgets (status, keyset, bench), re-derived as `EXPLAIN QUERY PLAN` pins on SQLite 3.54.1, because node:sqlite has no rows-read counter;
  - workerd-helper existence checks (`local-index.test.ts`, the isolation tests), replaced by Node harness checks;
  - `scheduled.test.ts`, which becomes the interval test;
  - the web OAuth and outbox suites, which move to the server (§5.9);
  - `scripts/test/{deploy,pitr-restore,check-bundle}.test.ts`, deleted by N7-01 with `deploy.sh`, `pitr-restore.ts` and `check-bundle.ts`; the Node guard has its own `scripts/test/check-node-bundle.test.ts`;
  - the workerd e2e entry (`worker/test/e2e/entry.ts`, `wrangler.e2e.jsonc`), deleted by N6-01 and replaced by `node-entry.ts`;
  - **runtime identity checks** (round 2): `packages/core/test/unicode-runtime.test.ts:257,364` and `packages/atproto/test/scaffold.test.ts:9` assert `navigator.userAgent === 'Cloudflare-Workers'`, which is `Node.js/26` under Node. N0-01 (core) and N1-04 (atproto) replace that assertion with runtime-neutral checks, keeping the titles: ICU reports Unicode 17 or newer, WebCrypto ECDSA P-256 sign and verify work, and the NFKC oracle drift is 0 code points outside the documented unassigned set;
  - **`worker/test/storage/db.test.ts`** (round 2): it pins DO-billed `rowsWritten` (2 for one insert, 6 for three, counting PK index entries); node:sqlite reports `changes` (1 and 3). N2-02 ports it to `openSqliteDb` with `rowsWritten` equal to `changes`, titles kept.
- **Case map.** `docs/verification/ts-case-map.json` keeps mapping all 258 cases. `scripts/validate_case_map.py` accepts test ids declared in `docs/planning/node-waves.json` (N0-02). Only one package per wave edits the map.
- **Pending targets.** `validate_case_map.py --check-tests --node-wave <n>` treats a mapped target declared by a node-waves package of a wave **later than n** as `pending`: it is listed in the output and does not fail. A target of wave n or earlier must exist in its file. Without `--node-wave`, every target must exist; `node-backend.sh` (N8-01) runs it that way.
- **Interim acceptance.** `scripts/acceptance/workers-backend.sh` is **retired at wave 0** (§2.2): its `--check-tests` step would fail as soon as N0-02 remaps the 39 cases to tests that later waves write, and its Playwright step drives the browser OAuth client that N5-01 removes. Until N8-01, each wave's gate is `npm run check` plus `scripts/acceptance/node-interim.sh --wave <n>` (N0-02), which mirrors the workers-backend steps that stay meaningful: `check-ts` (all vitest projects, including worker-acceptance and worker-composition, on workerd until N4-03 ports them and on Node after; the Workers bundle guard until N7-01 removes it; the Node bundle guard once N3-07 adds it), the Python case-map regressions, `validate_case_map.py --check-tests --node-wave <n>`, the goldens and the live no-env checks, and Playwright only from wave 6 on (`--wave` ≥ 6, after N6-01). Each skipped step is printed as `pending until wave <m>`, so nothing the old acceptance run checked is silently dropped.
- **No stale retirements.** A retirement whose reason this ADR made false is not kept. `docs/planning/AMENDMENTS-node.md` lists the superseded ADR 0004 amendment ids (A1, A2, A3, A4, A5, A11, A12, A15, A16, A18, A19, and D for the §9.3 items B16 restores), and the validator (N0-02) rejects any retirement citing one, while accepting `retired:B<n>` for a B amendment that names the case. In wave 0, N0-02 handles the 43 affected cases (26 under A1, A3, A11, A12, A15 and A19; 14 under D; 3 under A4): 39 are un-retired and mapped to a named test of the package that implements them, and 4 stay retired with reasons that are true on Node, under B4 or B11. §20.2 lists the mapping.
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
- The real-client e2e in `scripts/acceptance/node-backend.sh` (N8-01).

---

## 16. Amendments (B-series)
N0-02 writes the issue-amendment texts in `docs/planning/AMENDMENTS-node.md`, in the style of AMENDMENTS-workers.md.

| Id | Amends | Text |
|---|---|---|
| **B1** | A1 deployment | One Node 26 process (systemd user unit, `127.2.0.1:8888`), one SQLite file, secrets as a systemd credential, public origin unchanged, exposure owner-chosen. Single instance; multi-writer stays deferred. |
| **B2** | A2 role | AppView, indexer **and write client**: the server writes for signed-in users from the web UI and the scrobbler protocols. |
| **B3** | A3 OAuth / ADR 0002 | Confidential client at the same client_id: `private_key_jwt` ES256, `jwks_uri`, a server callback at `/oauth/callback`, sessions encrypted at rest, 30-day cookie sessions, CSRF. |
| **B4** | A4 libraries | Adds `@atproto/oauth-client-node`, `ws`, `undici`, `fflate` and `esbuild`. `@atproto/oauth-client-browser`, `wrangler` and `@cloudflare/*` are removed. |
| **B5** | A5 SSRF | DNS-pinned connections restored on Node. SafeFetch (GET reads) is unchanged and keeps its DoH pre-check; every other request goes through `policyFetch` with the same URL, redirect, deadline and size rules; no outbound path falls back to the unpinned global `fetch`. |
| **B6** | A11 idempotency | Server `Idempotency-Key` (400/409) on `POST /api/v1/scrobbles`, plus the TID allocated once with digest reconciliation, plus listen keys for protocol ingress. |
| **B7** | A12 outbox | Server outbox with the same formula, cap and crash barriers. It runs without a browser. |
| **B8** | A15 backup | In-process online backups (`node:sqlite` `backup()`, integrity check in a worker thread), pre-migration backups excluded from retention, additive migrations with `min_compatible_version`, and a restore that stops the socket and service units, keeps every live non-derived table wholesale (only derived tables come from the backup), and with `--accept-loss` deletes all web sessions and replays an out-of-database revocation journal. Backups refuse to run below the free-space floor. The db holds non-derived data. |
| **B9** | A16 metrics | journald JSON lines, `counters` and the admin socket status. |
| **B10** | A18 harness | Node harness: temporary db file per test file, close/reopen for restarts, `environment: 'node'`. Commands are unchanged: `npm test`, `npm run test:e2e`, `npm run check`. |
| **B11** | A19 release | Release = git sha plus the Node bundle SHA-256 (`worker/dist/node/main.mjs`). |
| **B12** | M1.1.1 collections | Collections are exactly `<p>.scrobble`, `<p>.follow`, `<p>.settings` and **`<p>.love`**. |
| **B13** | Lexicons (§9.1 of ADR 0004) | The §6.2 optional scrobble fields; the new love lexicon; additive-only rule after the freeze point. |
| **B14** | API contract | v1.2 (`info.version: 1.2.0`): every v1.1 route and payload is unchanged except the additive optional Scrobble fields. Adds the §5.7 cookie routes (including `DELETE /api/v1/account/connection` and `GET /api/v1/account/ignored-listens`) and the link, import and credential routes; restores `Operation` and `Accepted`; `meta.capabilities` may add `writes`, `lastfm`, `listenbrainz`, `imports` and `forwarding`. The "no route reads a session" sentence is narrowed to "no v1.1 read route". `/2.0/` and `/1/` are specified in this ADR and in `docs/compat/{lastfm,listenbrainz}.md`, not in OpenAPI. |
| **B15** | Admin | Admin routes only on the unix socket; the Workers TCP admin route and `ADMIN_TOKEN` are retired with the Workers entry (N7-01). |
| **B16** | ADR 0004 §9.3 dropped list | Restores session cookies, CSRF and the Origin rules, server OAuth state (600 s), encrypted token storage, the SIGTERM drain and the trusted-proxy rule. |
| **B17** | ADR 0004 §5.5 and Q4 | `pulse` mode, `PLAN`, `DO_LOCATION_HINT` and the plan tiers are removed (N7-01); until then the Node config supplies `PLAN='paid'` internally and refuses an operator-set value. |
| **B18** | A20 meta | `stage` reflects the Node composition, and the capabilities follow B14. |
| **B19** | Case map (ADR 0004 §10.4) | A retirement citing an amendment superseded by this ADR (A1, A2, A3, A4, A5, A11, A12, A15, A16, A18, A19, or D where B16 restores the item) is invalid; `retired:B<n>` is allowed when B*n* names the case. |
| **B20** | Sign-in (new) | Sign-in is restricted to `ATMUSIC_SIGNIN_DIDS` unless `ATMUSIC_SIGNIN_POLICY=open`, and the policy is reconciled at startup and every 10 minutes (a removed DID loses its OAuth session, web sessions and credentials). OAuth sessions are kept alive only while the DID is in use. Users can disconnect with `DELETE /api/v1/account/connection`. The OAuth callback is protected against login CSRF by the `__Host-atmusic_oauth` cookie. |

---

## 17. Work plan summary

`docs/planning/node-waves.json` holds the packages. Packages in one wave own disjoint files and never depend on each other. **Each wave leaves the gate green**: `npm run check` plus `scripts/acceptance/node-interim.sh --wave <n>` until wave 7, and `scripts/acceptance/node-backend.sh` from wave 8. `scripts/acceptance/workers-backend.sh` is retired at wave 0 (§15.3).

| Wave | Contents |
|---|---|
| **0** | N0-01: Node 26 toolchain, pinned dependencies, the `worker-node` test project, core under Node (runtime-neutral `unicode-runtime` checks), and the gate (`check-ts.sh` runs worker-node, then `check-node-bundle.ts` and `build-server.ts --check` once they exist; per-step durations; filtered nested controls). N0-02: contract, lexicon and amendment texts; the case-map validator that reads node-waves, rejects superseded retirements and reports later-wave targets as pending; the case-map remap; `node-interim.sh`; the retirement of `workers-backend.sh` from the gate. |
| **1** | N1-01 SQLite `Db` (exclusive lock, injected busy timeout, compatibility rule); N1-02 `IndexCore` with every non-class `index-do` export, core and extension timer lanes; N1-03 Node alarm; N1-04 `ws` connector and atproto under Node; N1-05 pinned transport and `policyFetch`; N1-06 HTTP bridge, static assets, client IP with the IPv6 /64 rate key, LRU per-IP bucket sets; N1-07 config (env hygiene, internal `PLAN`) and secrets; N1-08 crypto box, tokens and the revocation journal; N1-09 fake AS and PDS (DPoP opt-in); N1-10 migration 2 with `TABLE_CLASS` and `ignored_listens`; N1-11 core scrobble/love fields and protocol mapping; N1-12 periods, MSID and listen keys; N1-13 fake Last.fm and ListenBrainz under `worker/test/node/support/`. |
| **2** | N2-01 HTTP types, the `routes.ts`/`router.ts` split, compose and the Node dispatcher, the in-process app harness; N2-02 worker-modules on Node through the `cloudflare:*` shim with the named changes; N2-03 confidential OAuth client (identity adapter, no-CAS stores, re-sign-in, binding errors, reconciliation, keepalive policy); N2-04 sessions and CSRF; N2-05 server outbox; N2-06 range reads; N2-07 Last.fm protocol core (list flag, method-scoped signatures); N2-08 ListenBrainz protocol core (reject only what ListenBrainz rejects); N2-09 credentials. |
| **3** | Auth routes with disconnect (N3-01); writes and account (N3-02); Last.fm auth and writes (N3-03); Last.fm reads (N3-04); ListenBrainz submit (N3-05); ListenBrainz reads, stats and feedback (N3-06); **the process host** — run/main, shutdown, systemd notify, admin socket, backups, `build-server.ts`, `check-node-bundle.ts` (N3-07); forwarding and links (N3-08); imports (N3-09); credential routes (N3-10); projection of loves and new fields (N3-11). Every wave-3 route package depends on N2-01 only for composition. |
| **4** | Production features and in-process journeys, the pinned-transport spy test (N4-01); systemd units, install, restore and ops docs (N4-02); composition, acceptance and bench suites on Node (N4-03); de-shim of harness, storage and the shared helpers (N4-04), of ingest (N4-05), and of read, write and http (N4-06). |
| **5** | Web migration to the cookie BFF (N5-01); protocol read benchmark (N5-02). |
| **6** | Playwright on the Node stack, deleting the workerd e2e entry (N6-01); Node live gates, replacing the wrangler path of `ssrf_probe.ts` (N6-02). |
| **7** | Retirement of the Workers runtime, the `cloudflare:*` shim, `pulse`, `PLAN` and `BUDGETS.free` (N7-01), alone in its wave because its no-Workers test observes the outcome of N4-03 to N4-06, N6-01 and N6-02. |
| **8** | `scripts/acceptance/node-backend.sh`, with the real scrobbler-protocol client e2e against fake upstreams, and case-map closure (N8-01). |

**Critical path:** N0-01 → N1-01 → N2-05 → N3-03 → N4-01 → N5-01 → N6-01 → N7-01 → N8-01.

**First deployable Node release:** after wave 7. Between waves 3 and 5 the SPA still contains the old browser client and must not be deployed.

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
| Q11 | ListenBrainz `listened_at` skew and names our validator refuses | **Never a 400 for input ListenBrainz accepts** (§8.3). Up to +3,600 s is accepted (ListenBrainz's bound); a listen beyond our +300 s lexicon bound is deferred until it is valid (`due_at = createdAt = listened_at − 300 s`). A name ListenBrainz accepts but our validator refuses is answered 200, not written, and logged to `ignored_listens`. Documented in `docs/compat/listenbrainz.md`. (Round 1 had a whole-request 400, which made Web Scrobbler drop the batch as an auth error.) |
| Q12 | Rename `worker/` to `app/` | **Deferred**, to keep test ids and the case map stable. |
| Q13 | DB location | `~/.local/state/atmusic` via `StateDirectory=`. `ATMUSIC_DB` can move it. |
| Q14 | Default import share of the PDS budget | **50%**, user-adjustable from 10% to 90% (§5.8). |
| Q15 | Now-playing visibility | Public by default (Last.fm parity), with a per-account toggle. |
| Q16 | Daily listen cap | 3,000 per DID per rolling 24 h (abuse bound; Last.fm code 5, ListenBrainz 429). |
| Q17 | Who may sign in | **Allowlist by default** (`ATMUSIC_SIGNIN_DIDS`); `open` is the owner's opt-in (§5.7). |
| Q18 | Rollback across a migration | **Link switch only**; migrations are additive and restore is disaster recovery that keeps live non-derived state (§3.2, §14.3, §14.5). |
| Q19 | Which OAuth sessions the keepalive keeps alive | Only DIDs **in use**: a live web session, a protocol credential used within **90 days**, an active link, pending operations or an unfinished import. Others are revoked upstream and marked `signed_out` (§5.5). |
| Q20 | Disk-full behaviour of the OAuth session store | `set()` never throws; a failed write is held in memory, retried and surfaced as `oauth_store_degraded`; backups, keepalive and the import writer stop below the free-space floor (§5.5, §14.5). |
| Q21 | Removing a DID from the allowlist | Takes effect at the next restart or within 10 minutes (expiry sweep): OAuth session revoked, web sessions and credentials deleted, operations blocked (§5.5). |

**The owner must supply:**
1. A **Last.fm API account** (API key and shared secret) registered for non-commercial use, with its callback at `https://music.214510.xyz/api/v1/links/lastfm/callback`. It is needed for Last.fm imports through the API and for Last.fm forwarding. Everything else works without it.
2. **Public ingress** to `127.2.0.1:8888`: a cloudflared tunnel (recommended), or a reverse proxy with TLS (§14.6).
3. **Secrets setup** (§14.2), and a password-manager copy of the plaintext secrets.
4. `loginctl enable-linger` and enabling the unit (§14.1).
5. **`ATMUSIC_SIGNIN_DIDS`** (at least the owner's DID) and **`ATMUSIC_CLIENT_IP_HEADER`** matching the chosen exposure option (§3.6, §14.6), both in `atmusic.env`.
6. **`NAMESPACE_OWNERSHIP_REF`** and the lexicon publication at `music.pythonplayer123.dev` before writes are enabled (unchanged from ADR 0004 Q3).
7. Optionally, an offsite backup target (§14.5).

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

---

## 20. Review log

### 20.1 Design review round 1 (2026-10-25)

Every must-fix finding was checked before it was fixed. "Confirmed in code" means it was reproduced against the repository at `e14cb17` or against the installed or packed dependency. "Accepted on citation" means it concerns a third-party client or service whose source was cited by the reviewer and not re-read in this round; the fix is cheap and safe either way. No finding was rejected.

| # | Finding | Verdict | Disposition |
|---|---|---|---|
| 1 | `lastfm-ts-api` 2.6.2 cannot reach `http://127.2.0.1:<port>`; multi-scrobbler works only against https on 443 | **Confirmed in code**: `dist/api-request.js` does `import { request } from 'node:https'` and builds `{hostname, path}` only | §7.1, §15.2: the child-process `--import` preload that reissues `https.request` over http to the loopback port (same method, path, headers, body bytes; other hostnames throw). N8-01 owns `https-to-loopback.mjs` and names the mechanism in its test title. N0-02's `docs/compat/lastfm.md` says lastfm-ts-api clients must use `https://music.214510.xyz/2.0/`. |
| 2 | multi-scrobbler opens `/api/auth` without the slash | Accepted on citation | §3.7, §4, §7.3: `/api/auth` and `/api/auth/` both 302 with the query kept. N3-03 adds the exact multi-scrobbler URL test ending in `&token=`. |
| 3 | `removeScrobble` no-match must be 7, and queued creates at that second must be matched | Accepted on citation (GNU FM, Pano) | §5.8 `cancelled` state; §7.5, §7.6: no match → 7; a queued create is cancelled, a running one gets a chained delete. N1-10 schema, N2-05 and N3-03 tests. |
| 4 | Forward `dedupe_key` undefined for nowplaying, love and unlove | **Confirmed** in §12.2 and the §6.4 UNIQUE | §12.2 per-kind table. N2-05 (`enqueueForwards`) and N3-08 (love, unlove, love → three calls) tests; N3-08 now depends on N2-05. |
| 5 | Web Scrobbler ListenBrainz love bypasses the custom URL | Accepted on citation | §8.1 and `docs/compat/listenbrainz.md`: scrobbles and now playing only; do not use love; revoke the token if used. Removed from the N8-01 replay and the N3-05 fixture title. |
| 6 | ListenBrainz `feedback.jsonl` has no artist/track; `mbid_mapping` can be an object | Accepted on citation | §11.1 resolution rules (MSID, then MBID via `mbid_mapping` or `additional_info`; unresolved → `feedback_unresolved`; 0 and −1 skipped). Record MBIDs come from `additional_info` only. N3-09 fixtures and tests. |
| 7 | MIGRATION_2 breaks five suites that hard-code version 1 | **Confirmed in code** (`isolation-probe.ts:28`, `timers.test.ts:654`, `local-index.test.ts:122,166,174`, `index-do.test.ts:101-102,123`, `admin.test.ts:119`) | N1-10 owns the five files and derives expectations from `SCHEMA_VERSION` and `MIGRATIONS`. |
| 8 | `METHODS: Record<keyof IndexRpc, true>` breaks when N1-02 adds and N7-01 removes RPCs | **Confirmed in code** (`local-index.ts:69-88`) | N1-02 and N7-01 own `worker/test/harness/local-index.ts`. |
| 9 | New `RequestCtx` fields break seven test literals; ADMIN_TOKEN retired while the workerd admin suite still runs | **Confirmed in code** (`http/types.ts`, the seven files, `admin.ts:80`) | §3.1: the new fields are optional with `need(ctx, …)`; `AppEnv` is structural so the Workers `Env` is assignable. §3.11: the TCP admin route and `ADMIN_TOKEN` stay until N4-03 ports the suite and N7-01 deletes them. |
| 10 | N7-01's file list misses Workers-dependent files | **Confirmed in code** (`do/db.ts:82` `doDb`, `do/timers.ts:123`, `worker/test/tsconfig.json`, core/atproto `package.json`, `deploy.yml`) | `AlarmStorage` becomes structural in N1-02; N7-01 gains `do/db.ts`, `worker/test/tsconfig.json`, both package files, `deploy.yml`, `local-index.ts`, `http/types.ts`, `http/admin.ts`, and (found while checking) `scripts/test/secret-scan.test.ts` (it scans `worker/wrangler.jsonc`), `web/vite.config.ts` (dev proxy to `wrangler dev`) and `.env.example`. |
| 11 | 26 retirements cite superseded amendments | **Confirmed in code**, and **larger than reported**: 14 more cite `D` for items B16 restores, and 3 cite A4 | §15.3, B19; N0-02 validator rule and remap of 43 cases (§20.2). |
| 12 | The production bundle cannot reach loopback fakes, and any switch to allow it would be an IP-policy bypass | **Confirmed** against §3.5, §3.8, §3.9 | §3.9: separate `e2e.mjs` from `worker/test/e2e/node-entry.ts`; check-bundle proves `main.mjs` has no fixture path and that both bundles share byte-identical `src` inputs; `fixtureOrigins` is an option, never an environment variable. N2-01, N1-07, N6-01 and N8-01 tests. |
| 13 | A signed-in DID is never admitted, so imports wait forever | **Confirmed in code** (`admission.ts:154` exists; nothing calls it at sign-in) | §5.7, §11.2: admission at the callback, retried by the import timer on `queue_full`; the outbox admits too. N3-01 and N3-09 tests. |
| 14 | Login CSRF on `/oauth/callback` | **Confirmed** (§5.6 bound state to a session that does not yet exist) | §5.6, §5.7, §13, B20: `__Host-atmusic_oauth` cookie bound to the state; Origin check on `auth/start`. **One correction to the suggested fix:** the `__Host-` prefix requires `Path=/`, so the cookie uses `Path=/`, not `Path=/oauth/`. N2-03 and N3-01 tests. |
| 15 | Rollback by restore resurrects revoked credentials, reverts rotated refresh tokens and loses acknowledged writes | **Confirmed** against §14.3 and §3.2 | §3.2 additive migrations and `schema_compat`; §14.3 rollback is a link switch; §14.5 merge-forward restore and `--accept-loss`; pre-migration copies excluded from retention. N1-01, N1-10, N2-01 and N4-02 tests. |
| 16 | Restore can race socket activation; single-instance detection keyed on the admin socket | **Confirmed** against §14.1, §14.5, §3.10 | §3.2 `locking_mode=EXCLUSIVE`, §3.10 exit 75, §3.2 `--init`, §14.5 restore stops both units and renames a fsynced temp file. N1-01, N2-01 and N4-02 tests. |
| 17 | Credentials in query strings outside the four suppressed prefixes | **Confirmed** against §7.3 and §12.1 | §3.10, §13: no query string on any route. N2-01 log test; the N4-01 secret-log journey adds the desktop and web flows and the link callback. The desktop token is also bound to its `api_key` (§7.3). |
| 18 | Default `cf-connecting-ip` fails open behind a same-host proxy | **Confirmed** against §3.6 and §14.6 | §3.6 no default (ConfigError); §14.6 per-option directives and AOP for option C. N1-06 and N1-07 tests. |
| 19 | Open registration on the owner's machine; uploads never deleted, no disk quota | **Confirmed** against §5.7, §11.1, §13 | §5.7 sign-in allowlist by default (B20, Q17); §11.1 upload deletion, 1 GiB cap, 2 GiB free floor (507), admin status size. N1-07, N3-01 and N3-09 tests. |
| 20 | Dotted usernames can squat another account's handle | **Confirmed** against §9 | §9 dots reserved for one's own handle; resolution order for dotted names. N2-06, N2-09 and N3-02 tests. |
| 21 | In-memory upload parsing can exceed `MemoryMax=1G` and crash-loop the service | **Confirmed** against §11.1 and §14.1 | §11.1 streaming parse, bounds on actual bytes (64 MiB per entry, 256 MiB total); §11.4 attempts counter and `crash_loop`. N1-10 column; N3-09 tests. |
| 22 | The runner's notify path hits the client abuse buckets | **Confirmed in code** (`ingest/notify.ts:213`, `http/limits.ts:28`) | §5.8: `enqueueHints` with source `notify`, or admission. N2-05 test that all 200 URIs of a batch are hinted. |
| 23 | `RouteDef.method` allows only GET and POST | **Confirmed in code** (`http/types.ts:21`) | §3.1; N2-01 widens the union, maps HEAD and answers 405 with `Allow`; compose test. |
| 24 | `write/support.ts` and `fixtures/jetstream-server.ts` are shared with workerd suites | **Confirmed in code** (`cloudflare:workers` imports; users listed) | N2-02 adds Node copies under `worker/test/node/support/` and leaves the workerd copies; N4-03 moves the rest and deletes them. |
| 25 | Love collection breaks `jetstream-socket.test.ts` and is rejected by notify and record status | **Confirmed in code** (`jetstream-socket.test.ts:106-148`, `http/notify.ts:102-105`) | N3-11 owns those files plus `ingest/notify.ts` and `node-port-inventory.json`; love URI record-status test. |
| 26 | The pinned transport in `@atmusic/atproto` violates that package's no-Node rule | **Confirmed in code** (`packages/atproto/tsconfig.json` comment and types) | §3.5: moved to `worker/src/node/pinned-transport.ts`, test to `worker/test/node/`. |
| 27 | `protocol-map.ts` depends on N1-11's validators within the same wave | **Confirmed** against the waves file | Moved into N1-11; N1-12 keeps periods, MSID and listen keys; N3-03 and N3-09 depend on N1-11. |
| 28 | One timer guard couples extension timers to slow core handlers | **Confirmed in code** (`timers.ts` `active` WeakMap, `armAlarm` and `runDue`) | §3.3 two lanes with a names subset and two `NodeAlarm` objects. N1-02 test that a kicked outbox runs while a snapshot handler is blocked. |
| 29 | `VACUUM INTO` and `integrity_check` block the loop past the watchdog; startup has no extended timeout | **Confirmed** against §14.5, §3.10, §14.1 | §14.5 async `backup()` and a worker-thread integrity check; §3.10 `EXTEND_TIMEOUT_USEC`; §14.1 `TimeoutStartSec=15min`. N2-01 and N4-02 tests. |
| 30 | A 100k-listen benchmark under `worker/test/node/**` runs in every gate | **Confirmed** (`check-ts.test.ts:263-267` and the recorded 48.4 s and 91.6 s runs) | N5-02's test moves to `worker/test/bench/` with direct-SQL seeding; N0-01 adds `--projects` for the nested controls and a duration report. |

### 20.2 Case-map remap (implemented by N0-02 in wave 0)

| Case | Was | Now maps to |
|---|---|---|
| `M1.1.4/required_auth` | `retired:D` | N3-02: `worker/test/node/http/writes.test.ts › no cookie is 401, missing CSRF is 403 csrf_failed, invalid fields are 422 with the v1.0 ScrobbleInput field names, a closed publication gate is 503 publication_disabled` |
| `M1.2.1/sqlite_tls_features` | `retired:A4` | N0-01: `worker/test/node/scaffold.test.ts › process.versions.sqlite is 3.45 or newer with WAL, STRICT tables and JSON functions working, and process.versions.openssl is present for TLS` |
| `M1.2.3/packaged_shutdown` | `retired:D` | N3-07: `scripts/test/build-server.test.ts › the bundled main.mjs started with --init on a temporary state directory answers /health/ready, then on SIGTERM sends STOPPING=1 and exits 0 within 30 s` |
| `M1.3.1/idempotency_scope` | `retired:A11` | N3-02: `worker/test/node/http/writes.test.ts › the same Idempotency-Key from two DIDs creates two operations` |
| `M1.3.3/owner_private_read` | `retired:A12` | N3-02: `worker/test/node/http/writes.test.ts › GET /api/v1/operations/{id} is 200 for its owner and 404 for any other session` |
| `M1.3.4/locked_database` | `retired:A1` | N3-07: `scripts/test/build-server.test.ts › a second main.mjs on the same database exits 75 database_locked after the production busy timeout even with a different ATMUSIC_ADMIN_SOCKET, and a stale socket file is replaced` |
| `M1.4.1/bind_precedence` | `retired:A1` | N3-07: `worker/test/node/run.test.ts › an inherited LISTEN_FDS socket wins over ATMUSIC_LISTEN, which wins over the 127.2.0.1:8888 default` |
| `M1.4.3/drain_timeout` | `retired:D` | N3-07: `worker/test/node/shutdown.test.ts › a request still running when the injected drain window ends after SIGTERM is aborted, the database is closed and exit(0) is called; the production drain window is 25 s` |
| `M2.1.3/issuer_mismatch` | `retired:A3` | N2-03: `worker/test/node/bff/oauth-client.test.ts › a callback whose sub resolves to a PDS with a different authorization server is rejected and the token is revoked` |
| `M2.1.3/unsupported_server` | `retired:A3` | N2-03: `worker/test/node/bff/oauth-client.test.ts › authorize refuses an authorization server whose metadata lacks PAR or S256 PKCE and stores no state` |
| `M2.2.2/par_pkce` | `retired:A3` | N2-03: `worker/test/node/bff/oauth-client.test.ts › authorize sends PAR with an S256 code_challenge and a private_key_jwt assertion; the verifier and DPoP key exist only sealed in oauth_states` |
| `M2.2.2/par_failure` | `retired:A3` | N2-03: `worker/test/node/bff/oauth-client.test.ts › a PAR error from the fake AS leaves no oauth_states row and surfaces oauth_upstream` |
| `M2.2.2/wrong_origin` | `retired:D` | N3-01: `worker/test/node/http/auth.test.ts › POST /api/v1/auth/start with a foreign or duplicate Origin is 403 csrf_failed and stores no state; a valid start sets __Host-atmusic_oauth with HttpOnly, Secure, SameSite=Lax, Path=/ and Max-Age=600` |
| `M2.2.3/issuer_subject` | `retired:A3` | N2-03: `worker/test/node/bff/oauth-client.test.ts › a token response whose iss differs from the authorize issuer or whose sub differs from the handle-resolved DID stores no session` |
| `M2.2.3/nonce_retry` | `retired:A3` | N2-03: `worker/test/node/bff/oauth-client.test.ts › a use_dpop_nonce error on the token request and on a PDS write is retried once with the new nonce and succeeds` |
| `M2.2.3/expired_and_replay` | `retired:D` | N2-03: `worker/test/node/bff/oauth-client.test.ts › a replayed state and a state older than 600 s both fail and store no session` |
| `M2.3.1/refresh_race` | `retired:A3` | N2-03: `worker/test/node/bff/oauth-client.test.ts › two concurrent restore() calls on an expired session send one refresh request and both use the new token` |
| `M2.3.1/encrypted_persistence` | `retired:D` | N2-03: `worker/test/node/bff/oauth-stores.test.ts › the raw database file contains no access token, refresh token or DPoP private key bytes after a sign-in` |
| `M2.3.2/cookie_and_hash` | `retired:D` | N2-04: `worker/test/node/bff/sessions.test.ts › create() sets __Host-atmusic_session with HttpOnly, Secure, SameSite=Lax, Path=/ and Max-Age=2592000, and stores only SHA-256 of the token` |
| `M2.3.2/csrf_matrix` | `retired:D` | N2-04: `worker/test/node/bff/csrf.test.ts › the Rust matrix: no cookie 401; missing, duplicate or foreign Origin, missing or wrong X-CSRF-Token 403 csrf_failed; correct pair passes` |
| `M2.3.3/unsupported_revocation` | `retired:A3` | N2-03: `worker/test/node/bff/oauth-client.test.ts › revoke against an AS without a revocation_endpoint deletes the local session and sends no request` |
| `M2.4.2/refresh_persistence` | `retired:A3` | N2-03: `worker/test/node/bff/oauth-stores.test.ts › a rotated refresh token is persisted sealed before use, and after close and reopen the next refresh sends the rotated token` |
| `M2.4.2/security_matrix` | `retired:D` | N3-01: `worker/test/node/http/auth.test.ts › a callback with a replayed, expired or unknown state, or an AS error, stores no session, sets no session cookie and clears __Host-atmusic_oauth` |
| `M2.4.2/cross_owner` | `retired:D` | N3-02: `worker/test/node/http/writes.test.ts › GET /api/v1/operations/{id} is 200 for its owner and 404 for any other session` |
| `M3.1.1/key_validation` | `retired:A11` | N3-02: `worker/test/node/http/writes.test.ts › an Idempotency-Key of 129 characters or containing a character outside [A-Za-z0-9._~-] is 400 invalid_idempotency_key` |
| `M3.2.1/admission_atomic` | `retired:A12` | N2-05: `worker/test/node/outbox/ingress.test.ts › a throw after the operation insert rolls back the listen key and forward rows` |
| `M3.2.3/five_retries` | `retired:A11` | N3-02: `worker/test/node/http/writes.test.ts › five identical POSTs with one Idempotency-Key, two of them after the operation succeeded, return one operation and the fake PDS holds one record` |
| `M3.3.1/wrong_owner` | `retired:D` | N3-02: `worker/test/node/http/writes.test.ts › DELETE /api/v1/scrobbles/{id} of another DID's record is 404 and of an own record is 202 scrobble.delete` |
| `M3.4.3/live_retries` | `retired:A11` | N8-01: `scripts/e2e/scrobbler-e2e.ts › five replays of one POST /api/v1/scrobbles with the same Idempotency-Key against the e2e bundle produce one operation and one PDS record` |
| `M5.2.3/sensitive_fields` | `retired:A3` | N4-01: `worker/test/node/journey/secret-logs.test.ts › with sessions, sk values, app passwords, ListenBrainz tokens and linked credentials seeded, no public /api/v1, /2.0 or /1 response body in the journeys contains any of those values` |
| `M5.2.3/owner_equality` | `retired:D` | N3-02: `worker/test/node/http/writes.test.ts › public v1.1 read responses are byte-identical with and without the owner's session cookie` |
| `M6.1.2/trusted_proxy` | `retired:D` | N1-06: `worker/test/node/client-ip.test.ts › CF-Connecting-IP is honoured only in cf-connecting-ip mode and only from a peer in ATMUSIC_TRUSTED_PROXIES; otherwise the peer address is used` |
| `M6.3.1/backup_during_write` | `retired:A15` | N3-07: `worker/test/node/backup.test.ts › while a rate-limited backup runs, 1,000 committed writes and an HTTP request are served and WATCHDOG=1 is still sent, and the copy is a consistent snapshot that passes integrity_check` |
| `M6.3.1/restore_state` | `retired:A15` | N4-02: `scripts/test/restore.test.ts › a restored database whose OAuth sessions and linked credentials open with the configured keys reports ready` |
| `M6.3.1/wrong_key` | `retired:A15` | N4-02: `scripts/test/restore.test.ts › restoring with secrets that lack the backup's encryption key id starts the server, marks undecryptable sessions reauth_required and prints no ciphertext or key material` |
| `M6.4.1/tag_version` | `retired:A19` | N3-07: ``scripts/test/build-server.test.ts › build-server writes worker/dist/node/main.mjs, `node main.mjs --check-config` with a test config exits 0, and `node main.mjs --version` prints the git sha recorded at build time`` |
| `M7.1.2/csrf_client` | `retired:D` | N5-01: `web/test/session/client.test.ts › getSession caches csrfToken; every mutation sends X-CSRF-Token with same-origin credentials; 401 shows signed-out and reauth_required shows the re-sign-in banner` |
| `M7.4.1/embedded_dist` | `retired:A1` | N2-01: `worker/test/node/compose.test.ts › the SPA and its assets are served from ATMUSIC_ASSETS_DIR (default <release>/web/dist) with the _headers rules` |
| `M7.4.1/missing_build` | `retired:A1` | N3-07: `worker/test/node/run.test.ts › startup with an ATMUSIC_ASSETS_DIR lacking index.html exits 78 naming ATMUSIC_ASSETS_DIR and never listens` |
| `M1.2.3/static_elf` | `retired:A19` | `retired:B11`: a release is a git sha plus the Node bundle SHA-256 run by the system Node 26; no product ELF executable exists to inspect for an interpreter. |
| `M6.4.1/static_release` | `retired:A19` | `retired:B11`: there is no product executable; the release artifact is the JavaScript bundle. |
| `M1.2.1/locked_build` | `retired:A4` | `retired:B4`: the npm workspace pins every dependency exactly, only the owning package regenerates package-lock.json, and CI runs npm ci. |
| `M1.2.1/dependency_direction` | `retired:A4` | `retired:B4`: crate layering is replaced by npm workspaces with no barrel files; @atmusic/core stays pure. |

### 20.3 Deferred items from round 1

Taken in this round, because each was cheap and touched a section already being edited:
- `user.getTrackScrobbles` (§7.5; N3-04 with a golden).
- Audioscrobbler 1.2 handshake at the root, `GET /?hs=true` (§3.7, §7.10; N2-01 dispatch, N3-04 test).
- ListenBrainz `return_msid` only for `playing_now` (§8.3; N3-05 negative case).
- ListenBrainz token and per-token limit checked before the body is read (§8.3; N3-05 test).
- `recording-feedback` resolving MSIDs through now playing and queued operations, and 200 for an unknown MSID (§8.6; N3-06).
- Last.fm ignored code 5 re-queued at the next UTC day, and ListenBrainz rows with their own 30-day expiry (§12.3; N3-08).
- `getMobileSession` limit keyed by (username, IP), so no targeted lockout (§7.3, §13; N3-03).
- `RestartPreventExitStatus=78 75` and the distinct exit code 75 (§3.10, §14.1; N4-02).
- AAD for linked credentials and issued app secrets (§3.8; N1-08). The admin **reseal** command stays deferred.
- Same-UID exposure documented, dedicated-user option, `npm ci --ignore-scripts` (§13, §14.3; N4-02).
- Approval page labels unverified client names and shows the request time (§7.3; N5-01).
- `Capability` union extended in N1-11 and `health-meta.test.ts` owned by N4-01, deriving its expectations from `ctx.app`.
- Plan pins asserted structurally by index name with `process.versions.sqlite` recorded (N2-02).
- The ListenBrainz `listened_at` +300 s bound and its whole-request failure are documented as a deviation (Q11, `docs/compat/listenbrainz.md`).

Still deferred:
- ListenBrainz stats response shapes beyond the documented keys (`stats_api.py` parity of `artist_mbids` defaults, the `release_groups` key, `duration_ms` in `additional_info`): to be pinned by N3-06 shape tests in a later round.
- The test-inventory check comparing against **executed** ids, and committing the frozen 406-id baseline outside `/work/`.
- An admin reseal command for rotating `encryptionKeys[0]` over existing rows.
- Shortening the unapproved Last.fm token lifetime below the documented 60 minutes; kept at 60 for Last.fm parity, with the unverified label as the mitigation.

### 20.4 Design review round 2 (2026-10-25)

Every must-fix finding was checked against the repository at `61f0397` or the installed dependency before it was fixed. "Confirmed in code" names what was read. "Accepted on citation" concerns third-party client behaviour (Pano, Web Scrobbler, multi-scrobbler) whose source was cited by the reviewer and not re-read; the fix is cheap and safe either way. **No finding was rejected.** The package ids in §20.1 and §20.2 were rewritten to this round's numbering: the old N6-02 (Workers retirement) is N7-01, the old N7-01 (acceptance) is N8-01, the old N6-03 (live gates) is N6-02, the old N3-07 (suite port) is N4-03, the old N4-03 (benchmark) is N5-02, and the process half of the old N2-01 is the new N3-07. The reviewer's suggested ids "N2-01a/N2-01b" became N2-01 and N3-07 to keep the `N<wave>-<nn>` pattern; N3-07 must be in wave 3 because `run.ts` depends on `compose`, and packages of one wave never depend on each other.

| # | Finding | Verdict | Disposition |
|---|---|---|---|
| 1 | Paged read lists use the single-child-becomes-object rule; Pano `PageEntries<T>` needs a list | Accepted on citation (Pano); the ADR rule was confirmed in §7.2 | §7.2 per-element `list` flag, always-array lists including `[]`, `@attr` on every paged container, object quirk only for `scrobbles.scrobble`. N2-07 0- and 1-item goldens; N3-04 Pano-shaped decode test. |
| 2 | `api_sig` policy per `api_key` with no method scope; unsigned read GETs would get 13 | Confirmed in the ADR text (§7.4 required `api_sig` for unknown keys on every method) | §7.3, §7.4: signatures enforced only for methods whose Auth column has `sig`; reads ignore `api_sig`, and `sk` only identifies the caller. Unsigned-read tests in N2-07 and N3-04. |
| 3 | Whole-request 400 for listens ListenBrainz accepts; Web Scrobbler maps 400 to `ERROR_AUTH` | Accepted on citation (Web Scrobbler); the ADR rule was confirmed in §8.3 | §8.3, Q11: 400 only for what ListenBrainz rejects; skew up to 3,600 s deferred to `listened_at − 300 s`; invalid names answered 200 and logged in `ignored_listens` (N1-10 table, N3-02 route). N2-08 and N3-05 test the batch of 3 → 200, 2 written, 1 logged. |
| 4 | `navigator.userAgent === 'Cloudflare-Workers'` assertions fail under Node, in files no package owned | **Confirmed in code** (`packages/core/test/unicode-runtime.test.ts:257,364`, `packages/atproto/test/scaffold.test.ts:9`) | N0-01 owns the core file and N1-04 the atproto file; runtime-neutral checks with titles kept; §15.3 named change and `node-port-inventory.json` (recorded by N2-02). |
| 5 | Six new names in `TIMER_NAMES` break `timers.test.ts`; `recoverOrphans` and `nextDue` ignore lanes | **Confirmed in code** (`timers.test.ts:261-272` schedules every name; `timers.ts` `nextDue` ~l.186-193 and `recoverOrphans` ~l.262-271 read every `~running:` row) | §3.3: `TIMER_NAMES` stays the core seven, `EXTENSION_TIMER_NAMES` added, and `runDue`, `armAlarm`, `nextDue`, `recoverOrphans` and claim are lane-scoped. N1-02 test that a core `runDue` during an outbox claim leaves `~running:outbox` untouched and records no failure. |
| 6 | `index-do.ts` keeps `cloudflare:workers` and the shared constants; `router.ts` and `admin.ts` import them | **Confirmed in code** (`index-do.ts:58`; `router.ts:62`; `http/admin.ts:31`) | §2.2: N1-02 moves every non-class export to `app/index-core.ts` (re-exported, `buildDeps` kept as the seam). §3.1: N2-01 splits `http/routes.ts` from the Workers-only `router.ts` and repoints `admin.ts`. §3.9: the Node guard fails on `index-do.ts`, `scheduled.ts`, `env.ts`, `index.ts` or `router.ts` inputs. |
| 7 | Rewriting `check-bundle.ts` in wave 2 breaks `deploy.test.ts` and `deploy.sh` until the Workers retirement | **Confirmed in code** (`deploy.test.ts:42,361-362,584`; `deploy.sh:289`) | §3.9: the Node guard is a new `scripts/check-node-bundle.ts`, wired by N0-01's `check-ts.sh` step; `check-bundle.ts` is deleted with `deploy.sh` by N7-01. |
| 8 | Adding `HEAD` to `matchRoute`'s `Allow` breaks `routing.test.ts:252-254` | **Confirmed in code** | §3.1: `matchRoute` unchanged; HEAD mapping and the extra `Allow` entry only in `worker/src/node/dispatch.ts`. |
| 9 | Deleting `web/src/oauth/*` breaks `main.tsx` and `state/store.ts` | **Confirmed in code** (`main.tsx:10,14`, `state/store.ts:13`) | §5.9; N5-01 owns `web/src/main.tsx` and `web/src/state/` and rewrites the session state. |
| 10 | DPoP-only fake PDS breaks suites that write with the fixture Bearer token | **Confirmed in code** (`fixture-kit.test.ts:595-606,853`, `read-models.ts:171`) | §5.10: DPoP is opt-in per account (`auth: 'dpop'`), Bearer stays the default; N1-09 tests both. |
| 11 | Per-IP buckets keyed by full IPv6 address; a full `BucketSet` refuses everyone | **Confirmed in code** (`limits.ts` `take`, ~l.140-155, `MAX_BUCKET_KEYS = 10_000`) | §3.6 `rateKeyOf` (/64), §8.7 and §13 credential buckets first and LRU eviction for per-IP sets (`onFull: 'evict-lru'`, existing default kept for `limits.test.ts`). N1-06 and N2-08 tests. |
| 12 | `sessionStore.set` throwing makes the library revoke and delete; CAS and `SQLITE_FULL` both throw | **Confirmed in code** (`session-getter.js:190-212`, `oauth-client.js:213-215`) | §5.5: no CAS; `set()` never throws (write-behind with `oauth_store_degraded`); free-space guards on backups, readiness, keepalive and imports. N2-03 test: a failing store write is surfaced and the fake AS sees no revoke. |
| 13 | Only `handleResolver` is passed, so the library resolves DIDs against `plc.directory` with `noCache` | **Confirmed in code** (`oauth-client.js` `createIdentityResolver(options)`; `DidPlcMethod` default `https://plc.directory/`; `oauth-server-agent.js:57,88,117-119`) | §5.2: `identityResolver` adapter over our identity module, `noCache` → `{fresh: true}`. N2-03 tests: no `plc.directory` request during sign-in and refresh; a DID our rules reject fails the callback. |
| 14 | `callback()` revokes the old session, firing `onSessionDeleted`; transient PLC errors in the binding check revoke the new one | **Confirmed in code** (`oauth-client.js:196-205`) | §5.2 `onSessionUpdated` reactivates and unblocks; per-sub in-callback flag; §5.5 identity errors give 502 `oauth_upstream` without revoking. N2-03 and N3-01 tests. |
| 15 | Allowlist only at sign-in; keepalive refreshes idle DIDs forever; no disconnect | **Confirmed** against §5.5, §5.7 | §5.5 reconciliation at startup and in the expiry sweep; keepalive only for DIDs in use (Q19); §5.7 `DELETE /api/v1/account/connection`. N2-03 and N3-01 tests. |
| 16 | Inherited `NODE_*`, proxy and `SSL_CERT_*` variables can disable TLS checks or inject code | **Confirmed** against §14.1 (no `UnsetEnvironment=`) | §14.1 `UnsetEnvironment=`; §3.8 `run()` exits 78; §3.4, §3.5 explicit `rejectUnauthorized: true`. N4-02 `systemd-unit.test.ts`, N3-07 `build-server.test.ts`, N1-05 and N1-04 tests. |
| 17 | `{remote_host}` / `$remote_addr` behind proxied Cloudflare DNS is the edge address | **Confirmed** against §14.6 | §14.6: B is DNS-only; C requires AOP, a Cloudflare-only firewall and `trusted_proxies`/`set_real_ip_from` with `CF-Connecting-IP`. N4-02 `exposure.md`. |
| 18 | Restore renames before removing the stale WAL, and merged rows can stay in `restore.tmp-wal` | **Confirmed** against §14.5 steps 3-4 | §14.5 step 4: `journal_mode=DELETE` and no temp WAL; delete live `-wal/-shm/-journal`, fsync, rename, fsync. N4-02 crash-between-steps test. |
| 19 | Merge rules miss accounts, new credentials, deleted sessions; `--accept-loss` resurrects revocations | **Confirmed** against §14.5 step 3 | §14.5: with a readable live db every non-derived table is taken wholesale from live (`TABLE_CLASS`, N1-10, unclassified tables fail a test); `--accept-loss` deletes all web sessions and replays `revocations.log` (N1-08). N4-02 tests for post-backup sign-in, app password and sign-out. |
| 20 | Shutdown and lock tests would wait 5 s and 25 s in real time; process-level test runner unspecified | **Confirmed** against N1-01, N2-01 and N0-01 | §3.2, §3.10, §15.1: busy timeout and drain window injected (about 200 ms in tests, production values asserted); process tests spawn the built `main.mjs` from `scripts/test/` with explicit timeouts. The lock and drain case targets moved accordingly (§20.2). |
| 21 | `workers-backend.sh` fails from wave 0 and loses Playwright at wave 5; nothing replaces it until the last wave | **Confirmed in code** (`workers-backend.sh:238` runs `--check-tests`; its e2e step drives the browser OAuth client) | §2.2, §15.3, §17: retired at wave 0; `--check-tests --node-wave <n>` reports later-wave targets as pending; `node-interim.sh` is the per-wave acceptance (N0-02). |
| 22 | The Workers retirement shares a wave with packages its no-Workers test depends on | **Confirmed in code** (`worker/test/e2e/entry.ts`, `wrangler.e2e.jsonc`, `scripts/live/ssrf_probe.ts:316-328`, `scripts/e2e/dev-env.ts`, `scripts/benchmark-read-models.ts:110`) | N7-01 is alone in wave 7 and depends on N6-01 and N6-02; N6-01 deletes the e2e entry and `wrangler.e2e.jsonc`; N6-02 replaces the `ssrf_probe.ts` wrangler path; N4-03 drops the workerd fields of the benchmark script. |
| 23 | SafeFetch is GET-only with DoH, but the ADR claimed its rules cover POSTs; the OAuth client got the bare transport | **Confirmed in code** (`safe-fetch.ts` hard-codes `method: 'GET'` and always runs `resolvePublic`) | §3.5: SafeFetch unchanged and keeps DoH (stated); new `policyFetch` for every other request (N1-05, POST tests), used by the OAuth client, `PdsWriter`, forward clients and import sources. |
| 24 | Constructors fall back to the global `fetch` | **Confirmed in code** (`resolver.ts:52`, `handle.ts:96`, `safe-fetch.ts:159`, `index-do.ts:328`) | §3.5: throwing `globalThis.fetch` stub, N4-01 spy-transport test, and the guard rule. |
| 25 | The fake Last.fm needs MD5; atproto test-support has no Node types; N1-09 would depend on N1-08 | **Confirmed in code** (`packages/atproto/tsconfig.json` lib `es2024`, `dom`) | §15.2: the Last.fm and ListenBrainz fakes live in `worker/test/node/support/` (new N1-13) using `node:crypto`, mounted through `routerTransport`'s existing `hosts` option. |
| 26 | Bundle-text checks for fixture options either fail on legitimate code or check nothing; an identical-input rule pulls `main.ts` into `e2e.mjs` | **Confirmed in code** (`url-policy.ts`, `safe-fetch.ts`, `did-doc.ts:380`; `security.test.ts:392-407`) | §3.9: call-site literal scan of production sources with a non-vacuity check; `run.ts`/`main.ts` split, `main.ts` exempt from the identical-input rule. |
| 27 | `parseConfig` requires `PLAN` and `DO_LOCATION_HINT`; nobody removes `pulse` and `BUDGETS.free` | **Confirmed in code** (`config.ts:182-251`) | §2.2, §3.8: N1-07 supplies them internally and refuses operator values; N7-01 owns the removal with a named test. |
| 28 | `db.test.ts` pins DO-billed `rowsWritten` | **Confirmed in code** (`db.test.ts:108-224`) | §15.3 named change, owned by N2-02 and recorded in `node-port-inventory.json`. |
| 29 | N2-02 is one 17.7k-line mechanical edit | **Confirmed** (52 files, 17,715 lines, 262 helper calls under `worker/test/{harness,storage,ingest,read,write,http}`) | §15.1: the `cloudflare:*` shim (N2-02) runs most files unchanged; de-shim split by directory into N4-04, N4-05, N4-06. |
| 30 | N2-01 is too large and lengthens the critical path | **Confirmed** against the waves file | Split into N2-01 (types, route split, compose, dispatch, app harness) and N3-07 (process host). Wave-3 route packages depend on N2-01 only. |

### 20.5 Deferred items from round 2

Taken in this round, because each was cheap and touched a section already being edited:
- `session.subscriber` added to the §7.2 JSON number exceptions (N2-07 golden).
- ListenBrainz daily-cap 429 carries `Retry-After`, the `X-RateLimit-*` set and `Access-Control-Expose-Headers` (§8.3; N3-05 assertion).
- ListenBrainz `playing-now/delete` follows ListenBrainz's order, including an entry with no stored client (§8.6; N3-05 case).
- `CLIENT_NAME` is `'AT Protocol Music'` in §5.3 and moves to `packages/core/src/client-name.ts` (N2-03; N5-01 imports it in `gen-config.ts`).

Still deferred (reasons in brackets):
- `library.removeScrobble` success body and whether Pano's `GnuFm.delete` reaches the `apiRoot` [needs the Pano source re-read; love and unlove bodies are specified].
- Static additive-migration test allowing `CREATE UNIQUE INDEX` and `NOT NULL` without `DEFAULT` on existing tables [no migration after 2 exists yet; to be tightened before migration 3].
- Authorizer exemption flag around every adapter statement execution, and a nested-tx-after-DDL test.
- N3-11 ownership of `ts-case-map.json` for its renamed title [it records the rename in `node-port-inventory.json`; the case map does not reference that title].
- `start-stack` `PUBLIC_ORIGIN` scheme for `__Host-` cookies in Playwright (https through the stack proxy with Chromium host mapping, cookie attributes asserted).
- Running the callback binding check inside `stateStore.get` with a request-scoped expected hash.
- `conditions: ['browser']` fallback resolution of `secp256k1-web` under Node.
- Per-IP limits before body buffering on unauthenticated `/2.0` traffic, an `auth.getToken` limit, a global in-flight body budget, per-route body deadlines and `maxConnections`.
- Query-string credentials on signed Last.fm GET reads and `?token=` validation, and proxy access-log formats that omit the query.
- `ConfigurationDirectory=atmusic::ro` and `ConfigurationDirectoryMode=0700` [not part of the ops research on this host; to be verified with `systemd-analyze` first].
- Rejecting a desktop approval whose `apiKey` differs from the token's bound key, and fetching display data server-side by token.
- An absolute 365-day web-session lifetime or token rotation on renewal.
- From round 1: ListenBrainz stats response shapes beyond the documented keys; the test-inventory check against executed ids; an admin reseal command; a shorter unapproved Last.fm token lifetime.
