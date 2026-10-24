
# ADR 0004: Cloudflare Workers-only deployment

- **Status:** Accepted with interim owner decisions (§15), 2026-10-24.
- **Branch:** `feat/mvp-complete`. It supersedes the deployment parts of MVP.md, ADR 0002 and ADR 0003; see §9.
- **Driving requirement (the user's words):** "use as little infrastructure as possible, especially just cf workers if possible."
- **Decision in one sentence:** a **TypeScript**, read-only AppView runs in **one Worker plus one SQLite-backed Durable Object** with Static Assets, one Cron Trigger and one secret. The **browser SPA** is the atproto OAuth client and writes to the user's own PDS. Every record is indexed only after a **signed current-head proof** (`getRecord`) or a **verified range snapshot** (`getBlocks` MST walk).

---

## 1. Decision

### 1.1 What we operate

| Piece | Cloudflare primitive | Role |
|---|---|---|
| `atmusic` Worker | Workers (Paid in production) | Edge entry point. It routes `/api/*`, `/health/*` and `/internal/*`, validates query parameters, encodes and decodes HMAC cursors, renders the error envelope and copies `CF-Connecting-IP` into the request it forwards. Its `scheduled()` handler is the watchdog. |
| SPA, `/oauth/client-metadata.json`, `_headers` | Workers Static Assets | The Preact app, the OAuth client metadata (a build-time static file) and the CSP. Asset requests are free and do not invoke the Worker. |
| `IndexDO` | One SQLite-backed Durable Object class, a single instance from `idFromName("index-v1")` with a `locationHint` | It holds the entire index (17 tables, §6) and runs ingestion: the Jetstream socket, the hint queue, proof verification, range snapshots and account sweeps. It multiplexes all timers onto its one alarm, keeps the in-memory rate buckets and serves every read through JS RPC. |
| Cron | One trigger, `*/5 * * * *` | Calls `IndexDO.ensureRunning()`, which re-arms the alarm chain if it was ever lost. In `pulse` ingest mode it also starts a drain. |
| Secrets | `CURSOR_KEY` (required, at least 32 bytes) and `ADMIN_TOKEN` (optional) | Cursor HMAC key material, derived exactly as `crates/core/src/cursor.rs` does it. The admin routes exist only when `ADMIN_TOKEN` is set. |

Not used:
- **D1.** There is no interactive transaction, and it would add a second store with a non-atomic handoff from the DO.
- **KV.** It is eventually consistent.
- **Queues.** The DO `hints` table is an ordered, coalescing, durable queue with no extra binding.
- **R2, Containers, Rate Limiting binding.** Not needed.

There are **no server-side user credentials**: no OAuth tokens, DPoP keys, sessions, CSRF secrets or encryption key.

### 1.2 Why this shape
1. **Minimal infrastructure.** The footprint is the smallest of the three candidates: one Worker, one DO class, assets, one cron, one required secret.
2. **Only DO SQLite gives real transactions.** It offers synchronous `transactionSync`, which rolls back on a throw. D1 rejects `BEGIN`/`SAVEPOINT`, and its `batch()` cannot branch on intermediate results. Every read-check-write invariant therefore lives inside the DO, in one synchronous transaction.
3. **One ingestion path.** Our own SPA writes exactly as a third-party scrobbler does: PDS, then hint, then proof, then index. Interoperability is exercised by our own product.
4. **TypeScript fits the platform natively.** It shares one `packages/core` with the SPA. Tests run in real workerd with real DO SQLite through `@cloudflare/vitest-plugin`. Nothing has to be ported from tokio or sqlx to wasm.
5. **Integrity is equal or stronger.** Range snapshots prove completeness, deletions included, with memory bounded by the walk frontier. That removes the old 8 MiB / 10,000-record snapshot ceiling (`crates/atproto/src/sync/frames.rs:16`).

---

## 2. Alternatives considered (judge scores)

Three designs were scored by three judges on minimal infrastructure, integrity and security, feasibility on Workers, delivery risk and effort, maintainability, and user experience.

| Design | Judge 1 | Judge 2 | Judge 3 | Mean | Verdict |
|---|---|---|---|---|---|
| **ts-workers-native**: TypeScript, singleton SQLite DO, browser OAuth writes, getRecord proofs plus getBlocks range snapshots | 57 | 59.5 | 59.25 | **58.6** | **Chosen base.** All three judges ranked it first. |
| workers-rust-port-single-do: workers-rs 0.8.7, existing axum and repositories on DO SQL through a hand-written `transactionSync` shim, server-side OAuth and outbox | 55.5 | 57 | 56 | 56.2 | Rejected as the primary path. Its server-side BFF semantics are kept as the documented fallback (§15, Q1). |
| minimal-surface: TypeScript, D1 plus an Indexer DO as single writer, day/month rollups, listRecords backfill | 47 | 52.5 | 48.25 | 49.3 | Rejected. It adds D1, its rollups conflict with M5.1.2, its listRecords backfill cannot prove completeness, and it has interleaving hazards across awaits. |

Other options rejected:
- **Queues** for the outbox or hints: no coalescing, an extra binding, and the outbox no longer exists.
- **A separate ingest DO:** about 332k extra GB-s per month plus cross-DO RPC.
- **The workers-rs Emscripten target:** experimental.
- **Full `subscribeRepos` firehose verification:** about 2k events/s, too much for one DO.
- **Relay `subscribeRepos` with Sync 1.1:** not needed, because we never verify historical commits.

---

## 3. Judge findings and their resolutions

### 3.1 Fatal flaws and gating risks

| # | Finding (design) | Resolution in this ADR |
|---|---|---|
| F1 | ts-native subscribed with `kinds=identity&kinds=account`. Jetstream does not narrow those by `collections`, so the singleton DO would receive the whole network's identity and account stream (https://bsky.network/docs/jetstream/). | **Fixed.** We subscribe with `kinds=commit` only. Account and identity changes are detected in four ways (§5.6): (a) error-driven, when `getRecord`/`getBlocks` returns `RepoDeactivated`/`RepoTakendown`/`RepoSuspended`/`RepoNotFound`; (b) a fresh DID resolution on every proof (cache TTL 5 min); (c) a bounded `getRepoStatus` sweep, hourly for DIDs active in the last 30 days and daily for all known DIDs; (d) a daily identity and handle sweep. A second `dids=` subscription was rejected: 10k DIDs do not fit in a URL query. |
| F2 | ts-native reconnected whenever the socket had been silent for more than 90 s, which churns on a stream that is legitimately quiet. | **Fixed.** We reconnect only on close or error, plus one **planned refresh every 15 minutes** that reconnects from the stored cursor. That costs 96 cheap connects a day and bounds detection of a half-open TCP connection. A `pulse` ingest mode (connect from the cursor, drain at most 20 s or to the live tail, close) and an `off` mode are configuration options (§5.5). |
| F3 | minimal-surface: "the single writer makes read-then-write safe" is false across awaits. | **Rule (enforced).** No read-check-write may span an `await`. Fetching and verification are async. Every state transition then runs inside one `db.tx(() => …)` built on `ctx.storage.transactionSync`, which re-reads the guards it depends on: the per-URI revision, the per-DID revision floor, `users.generation`, suppression and job generation. `Db.tx` is typed so that it rejects a callback returning a Promise. A lint test (`worker/test/storage/no-async-tx.test.ts`) fails on `tx(async`. An in-memory in-flight set de-duplicates concurrent fetches; it is an optimisation, not what makes the design correct. |
| F4 | minimal-surface deleted only on a verified exclusion proof; "RecordNotFound without a CAR, eventually dropped" left deleted scrobbles public forever. | **Fixed.** Absence is applied from exactly two sources: a verified exclusion proof (`@atcute/mst` `findRpathAndBuildProof` returns `null` on a complete path), or a range snapshot whose verified enumeration lacks the key. If `getRecord` returns no CAR, an unparseable CAR, `RecordNotFound` without a proof, or a path with missing blocks, we **schedule a snapshot** for that DID. We never treat those as absence and never drop them silently. |
| F5 | Rust port: `MAX_OPERATIONS = 10_000` meant heavy scrobblers never finished a snapshot. | **Not inherited.** The range walker has **no per-repository record ceiling**. Each alarm slice is bounded (≤ 40 subrequests on Free, ≤ 200 on Paid, ≤ 2,000 entries applied), and the frontier persists in `repo_jobs.frontier_json`. The only global guard is DO storage. |
| F6 | Rust port: a full `getRepo` of up to 256 MiB, hashed in the singleton. | **Avoided.** The primary path is a `getBlocks` walk over our key range only. The `getRepo` fallback (§5.4) is capped at **32 MiB**. It is streamed block by block into the `snapshot_blocks` cache in DO SQLite rather than held in memory, and then the same range walker runs over that cache. |
| F7 | Rust port: the hand-written wasm-bindgen `transactionSync` shim, where a panic could poison the isolate. | **Not applicable.** TypeScript calls the native `ctx.storage.transactionSync`. |
| F8 | ts-native: its value depends on the owner accepting a large contract amendment (nine routes dropped, server idempotency, sessions and CSRF). | **Open question Q1.** The fallback is a confidential BFF on the same infrastructure: `@atcute/oauth-node-client` in the Worker, the DO as refresh lock and outbox, a ported Rust outbox, idempotency and session semantics, and two more secrets. §15 says which work packages change. |
| F9 | ts-native: the range-snapshot walker is new, security-critical code. | **Mitigated.** (a) An adversarial matrix changes one invariant per case. (b) A differential oracle: `crates/atproto/examples/export_signed_cars.rs` exports Rust-signed CARs, and the record set that the Rust `verify_snapshot` enumerates for each, as `tests/goldens/snapshot_enumeration.json`; the TS walker must produce an identical set. (c) Live compatibility checks against a Bluesky-hosted PDS and an independent PDS (W6-05) gate acceptance. |
| F10 | ts-native: owner disconnect through `getServiceAuth` with `rpc:` scopes is unverified across PDSs. | **Replaced.** Disconnect uses a repo-signed `<prefix>.settings/self` record (§5.3). It needs only the `repo:` scope we already request, goes through the single verifier, and survives an index rebuild. Service-auth JWTs are not used at all, so there is no `did.json`, no JWT verifier and no replay store. |
| F11 | minimal-surface: persisted rollups conflict with M5.1.2 "avoid divergent counter stores". | **Not adopted.** Statistics are exact read-time `GROUP BY` queries. The only addition is an **exact** cache, valid only when provably equal (§5.8). |
| F12 | minimal-surface: listRecords completeness is unprovable. | **Not adopted for authority.** `listRecords` and `listReposByCollection` are hints or discovery only. Activation and reactivation require a complete verified range snapshot, as ADR 0003 already requires. |

### 3.2 Ideas grafted from the runners-up

Adopted:
- From the Rust port:
  - A **SQL conformance suite** on real DO SQLite. It covers 52-bit numeric precision (documented: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), bindings applying only to the last statement of a multi-statement `exec`, FK enforcement, partial unique index, `RETURNING`, `ON CONFLICT … WHERE`, rollback on a throw, and a typed error for 101 parameters.
  - **Coalescing** of ≥25 pending hints for one DID into one snapshot.
  - "**No CAR → snapshot**".
  - The **adversarial corruption matrix**, generated from Rust-signed golden CARs.
  - **PITR restore** behind a constant-time compared `ADMIN_TOKEN`.
  - **CI proof** that the production bundle excludes test seams.
  - A bounded **getRepo streaming fallback**.
  - A **BFF fallback** (Q1).
- From minimal-surface:
  - `kinds=commit`.
  - **us-east/us-west rotation** on reconnect.
  - **Per-PDS-host backoff** honouring `RateLimit-Reset`/`Retry-After`.
  - A **verified-commit cache** keyed `(did, commitCid)`.
  - The **settings opt-out record**, promoted from fallback to primary (F10).
  - **`pulse` mode**.
  - AJV validation against OpenAPI in every HTTP test.
  - `EXPLAIN QUERY PLAN` tests with a negative control.
  - The 258-case map enforced in CI.

Rejected:
- D1.
- Rollups.
- listRecords backfill.
- A `dids=` second subscription.
- An admin logical dump. The index, including suppression, is fully re-derivable from public repositories, and PITR covers 30 days.

---

## 4. Components, bindings and layout

### 4.1 Topology
```
Browser (Preact SPA, @atproto/oauth-client-browser, IndexedDB outbox)
  │  static: /, /feed, /oauth/callback, /oauth/client-metadata.json, /assets/*  ──► Static Assets (free)
  │  /api/*, /health/*, /internal/*  (run_worker_first)  ──► Worker `atmusic`
  │                                                            │ JS RPC (stub = INDEX.get(idFromName("index-v1"), {locationHint}))
  │                                                            ▼
  │                                     IndexDO (SQLite) ── alarm multiplexer (timers table)
  │                                       ├─ read modules (history, feed, stats, profile, follows, export, status)
  │                                       ├─ ingest: jetstream socket → hints → verify-drain → apply (transactionSync)
  │                                       ├─ snapshot jobs (getBlocks range walk), account/identity sweeps, discovery
  │                                       └─ in-memory token buckets, DoH answer cache, in-flight set
  │                                                            │ SafeFetch (https, DoH precheck, manual redirect, caps, 10 s)
  ▼ createRecord/deleteRecord (DPoP)                          ▼
User's PDS ◄──────── getRecord / getBlocks / getRepo / getLatestCommit / getRepoStatus / plc.directory / DoH ────────
wss://jetstream.us-{east,west}.bsky.network (kinds=commit, collections=<prefix>.scrobble|follow|settings)
https://relay1.us-east.bsky.network listReposByCollection (discovery only)
```

### 4.2 `worker/wrangler.jsonc` (sketch, owned by W0-01)
```jsonc
{
  "$schema": "../node_modules/wrangler/config-schema.json",
  "name": "atmusic",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",          // ≥2025-04-01: navigations prefer assets
  "assets": {
    "directory": "../web/dist", "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/health/*", "/internal/*"]
  },
  "durable_objects": { "bindings": [{ "name": "INDEX", "class_name": "IndexDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["IndexDO"] }],
  "triggers": { "crons": ["*/5 * * * *"] },
  "limits": { "cpu_ms": 30000 },                // Paid only; omitted in env.free
  "observability": { "enabled": true },
  "vars": {
    "PUBLIC_ORIGIN": "https://music.example.org",
    "LEXICON_PREFIX": "",                     // empty ⇒ publication + ingestion disabled (namespace gate)
    "NAMESPACE_OWNERSHIP_REF": "",
    "INGEST_MODE": "socket",                  // socket | pulse | off
    "JETSTREAM_URLS": "wss://jetstream.us-east.bsky.network,wss://jetstream.us-west.bsky.network",
    "JETSTREAM_LOOKBACK_HOURS": "24",         // conservative; docs state only "bounded"
    "RELAY_URL": "https://relay1.us-east.bsky.network",
    "PLAN": "paid",                           // paid | free → slice budgets
    "DO_LOCATION_HINT": "enam"
  },
  "routes": [{ "pattern": "music.example.org", "custom_domain": true }],
  "env": {
    "free":    { /* re-declare durable_objects + vars (non-inheritable); PLAN=free, INGEST_MODE=pulse; no limits */ },
    "staging": { /* own hostname ⇒ own client_id, own DO namespace */ }
  }
}
```
- Secrets are set with `wrangler secret put CURSOR_KEY` and, optionally, `ADMIN_TOKEN`.
- Local development uses `.dev.vars`.
- `run_worker_first` deliberately omits `/oauth/*`. The browser library handles `/oauth/callback` inside the SPA, so falling back to `index.html` on navigation is correct (https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).
- `_headers` applies only to asset responses, so API responses set their headers in code (https://developers.cloudflare.com/workers/static-assets/headers/).
- A custom domain on an owned zone is mandatory. The NSID authority must be owned, and the OAuth `client_id` (`https://<host>/oauth/client-metadata.json`) must never change.

### 4.3 Repository layout (npm workspaces; Node 24 LTS pinned in `.nvmrc`)
```
packages/core/     @atmusic/core   pure, no I/O: deps (Clock/Random), api-types, errors, timestamp, syntax,
                                   scrobble/follow/settings validation, namespace, music-key + unicode tables,
                                   cursor codec, write-policy, record-key, canonical digest; test-support/{clock,random}
packages/atproto/  @atmusic/atproto  Workers+browser-safe I/O: transport, net/{url-policy,safe-fetch,doh,body},
                                   identity/*, verify/*, snapshot/*, jetstream/events; test-support/ (signed repo kit, fakes)
worker/            @atmusic/worker   wrangler.jsonc, src/{index,router,scheduled,env}.ts, src/http/*, src/do/**
web/               @atmusic/web      Preact SPA (Vite), oauth/, outbox/, routes/, components/
tests/goldens/                       Rust-oracle golden vectors and signed CARs (read-only inputs)
tests/fixtures/read_models.json      unchanged shared fixture
crates/                              frozen Rust candidate: oracle only (§12)
```

**Rules that keep parallel work conflict-free:**
- **No barrel files.** Every package's `exports` is `{"./*": "./src/*.ts", "./test-support/*": "./test-support/*.ts"}`, so a new module never edits a shared file.
- **Route self-registration.** Each `worker/src/http/<name>.ts` exports `routes: RouteDef[]`. Only `worker/src/router.ts` (W5-01) concatenates them.
- **DO module signature.** DO modules are plain functions of `(m: ModuleDeps, args)`. Only `worker/src/do/index-do.ts` (W5-01) exposes them as RPC methods that match `IndexRpc` from `worker/src/do/contracts.ts` (W0-01).
- **Schema ownership.** The schema is complete in Wave 0. Any later change needs a new migration entry and an amendment to W0-01's `schema.ts` ownership.
- **Dependencies.** `package-lock.json` is regenerated only by W0-01, which pre-declares every dependency listed in §4.5. A later package that needs a new dependency must amend W0-01.

### 4.4 Shared interfaces (frozen in Wave 0)
```ts
// packages/core/src/deps.ts
export interface Clock { nowMs(): number }                     // epoch ms
export interface Random { bytes(n: number): Uint8Array; float(): number } // float ∈ [0,1)
export const systemClock: Clock; export const cryptoRandom: Random;
// packages/core/test-support/clock.ts
export function fixedClock(iso = "2026-01-15T12:00:00Z"): Clock & { set(iso: string): void; advance(ms: number): void };
// packages/atproto/src/transport.ts
export type Transport = (req: Request) => Promise<Response>;
// packages/atproto/src/identity/types.ts
export interface ResolvedIdentity { did: string; pds: string; signingKey: string /* did:key multikey */; handle: string | null; fetchedAtMs: number }
export interface IdentityResolver { resolveDid(did: string, o?: { fresh?: boolean }): Promise<ResolvedIdentity>; resolveHandle(handle: string): Promise<string> }
// packages/atproto/src/verify/types.ts
export interface VerifiedCommit { did: string; cid: string; rev: string; dataCid: string; version: 3 }
export type RecordProof = { commit: VerifiedCommit; collection: string; rkey: string } &
  ({ state: "present"; cid: string; record: unknown } | { state: "absent" });
export type VerifyErrorCode = "car_malformed" | "car_too_large" | "cid_mismatch" | "bad_signature" | "did_mismatch" |
  "bad_version" | "bad_rev" | "mst_invalid" | "missing_block" | "no_proof" | "key_unavailable" | "record_cid_mismatch";
export class VerifyError extends Error { constructor(readonly code: VerifyErrorCode, msg?: string) }
export interface SnapshotEntry { key: string /* collection/rkey */; cid: string }
// worker/src/do/db.ts
export type SqlParam = string | number | null | ArrayBuffer;   // numbers must be safe integers or finite reals
export interface Db { all<T>(sql: string, ...p: SqlParam[]): T[]; one<T>(sql: string, ...p: SqlParam[]): T | null;
  run(sql: string, ...p: SqlParam[]): { rowsWritten: number }; tx<T>(fn: () => T extends Promise<unknown> ? never : T): T }
export function doDb(storage: DurableObjectStorage): Db;      // asserts ≤100 params, Number.isSafeInteger
// worker/src/do/contracts.ts
export interface ModuleDeps { db: Db; clock: Clock; random: Random; transport: Transport; identity: IdentityResolver; config: AppConfig; log: Logger }
export interface IndexRpc { ready(); indexing(did?); history(q); feed(q); lookup(uri); recordStatus(uri); stats(q); profile(did);
  following(q); followers(q); exportUser(did); resolveHandle(handle); notify(input, ip); ensureRunning(); adminStatus(); adminPitr(atMs) }
// worker/src/http/types.ts
export interface RequestCtx { env: Env; index: IndexRpc; requestId: string; clock: Clock; cursorKey: CryptoKey; clientIp: string }
export interface RouteDef { method: "GET" | "POST"; pattern: string; handler(req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> }
```
**Test seam.** `IndexDO` builds its dependencies in a `protected buildDeps(env, ctx)` method. Test entry modules under `worker/test/**/entry.ts` subclass it to inject a `fixedClock`, a seeded `Random`, the fixture `Transport` and a fake Jetstream connector. Production `worker/src/index.ts` never imports `test-support`, and `scripts/check-bundle.ts` asserts this against the bundle.

### 4.5 Dependency pins (W0-01)

Every version is pinned exactly. Choose the newest release that is at least 7 days old at pin time, and record the choice.

Versions verified on the npm registry on 2026-10-24, for reference:

| Package | Version |
|---|---|
| `wrangler` | 4.152.0 (published 10-22) |
| `@cloudflare/vitest-plugin` | 1.4.7 (10-22; peer `vitest ^4.1 \|\| ^5`) |
| `@cloudflare/vite-plugin` | 1.65.0 |
| `vitest` | 5.0.5 |
| `vite` | 8.3.5 |
| `preact` | 11.0.2 (10-23) |
| `@playwright/test` | 1.64.1 |
| `@atproto/oauth-client-browser` | 0.5.10 (10-17) |
| `@atcute/car` | 6.1.0 |
| `@atcute/cbor` | 2.3.8 |
| `@atcute/cid` | 2.5.0 |
| `@atcute/mst` | 1.1.1 |
| `@atcute/crypto` | 2.4.4 |
| `@atcute/identity-resolver` | 2.0.3 |
| `@atcute/jetstream` | 2.2.0 (used for types only; our parser is bounded) |
| `typescript` | 7.0.2 |

Test-only dependencies: `@atproto/crypto`, used as a cross-check; `@atproto/dev-env`, for end-to-end tests only; `ajv`; `fast-check`; `happy-dom`; `fake-indexeddb`.

`@atproto/repo` and `@atproto/identity` are **not** used. They are Node-bound (pino, Node streams, undici), and that is the demonstrated compatibility gap that MVP.md requires before a library change.

---

## 5. Data flows

### 5.1 Sign-in (browser public client)
1. `/signin` takes a handle. `BrowserOAuthClient` uses:
   - `client_id = https://<host>/oauth/client-metadata.json`, generated by `scripts/gen-config.ts` with `application_type: "web"`, `token_endpoint_auth_method: "none"`, `dpop_bound_access_tokens: true`, `redirect_uris: ["https://<host>/oauth/callback"]`;
   - scope `atproto repo:<p>.scrobble repo:<p>.follow repo:<p>.settings` (https://atproto.com/specs/permission).
2. The library performs handle and DID resolution, PAR, PKCE S256, DPoP with server nonces (a non-extractable WebCrypto key) and the issuer check. It stores the session in IndexedDB and serialises refresh across tabs with Web Locks.
3. `/oauth/callback` is served the SPA through the asset fallback, and `client.init()` completes the exchange.
4. Sessions follow the library and spec limits (public clients: at most 2 weeks, https://atproto.com/specs/oauth). Today's Rust candidate is also a public client (ADR 0002), so this is no regression in refresh lifetime. The SPA shows the expiry and re-prompts.
5. After sign-in the SPA sends `POST /api/v1/notify {did}`, which admits the DID, subject to budget, and schedules a snapshot if the DID is unknown or its last snapshot is more than 24 h old.
6. **Sign-out** calls `session.signOut()`, which revokes upstream, and clears IndexedDB.
7. **Local development** uses the loopback `client_id` `http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Foauth%2Fcallback&scope=…`.

### 5.2 Scrobble and follow writes (SPA outbox; the server never sees a write)

1. **Validate.** The form is checked with `@atmusic/core/scrobble`, which ports the `crates/core/src/scrobble.rs` rules:
   - 1–256 scalar values and ≤ 1,024 UTF-8 bytes;
   - trimming uses the Unicode White_Space set;
   - well-formed UTF-16;
   - `listenedAt` ≤ now + 300 s and ≥ 1970;
   - optional duration 1–86,400;
   - UUID MBID.

   Unknown fields cannot exist, because the form builds the record itself.
2. **Persist the operation before the first attempt.** It is written to IndexedDB (`web/src/outbox/store.ts`) as `{id, did, kind, collection, rkey (TID allocated once from injected clock/random), record, digest = sha256(canonical JSON), attempts, dueAt, state, predecessorIds}`.
3. **Run.** A single runner per DID, elected with `navigator.locks.request('atmusic-outbox:'+did)`, calls `com.atproto.repo.createRecord {repo, collection, rkey, record}`.
   - Transient failures (network, 5xx, 429) retry after `min(300 s, base + U[0, base/4])` with base 1, 2, 4 … s. A capped `Retry-After` can raise that. There are **exactly 10 attempts**.
   - **Ambiguous create** ("already exists"): `getRecord`, then a canonical digest comparison. Equal means success; different means terminal `remote_record_conflict`. The record is **never overwritten**, and `putRecord` is never used for creates. This is how "same key, changed payload" stays detected: the PDS rejects the reused rkey and the digest differs.
4. **Track indexing.** On success the SPA sends `POST /api/v1/notify {uri}`, then polls `GET /api/v1/records/status?uri=`, backing off up to 60 s. The UI shows *queued → published → indexed*, or *excluded (reason)*.
5. **Delete.** The owner's view hides the record immediately through an outbox overlay (`overlay.ts`). The SPA then calls `deleteRecord {swapRecord: <cid from records/status>}`.
   - `InvalidSwap`: re-fetch, reconcile, retry.
   - Success: notify, then poll until the status is `absent`.
   - A delete queued behind a pending create waits for it (`predecessorIds`).
6. **Follow.** The rkey is `'f' + hex(sha256(subjectDid))`.
   - An existing record with the same subject is success and keeps its original `createdAt`.
   - A different subject is a conflict and is never overwritten.
   - **Unfollow** lists the owner's own `<p>.follow` records from their PDS with `com.atproto.repo.listRecords` (authoritative for the owner) and deletes every record whose subject matches, each with `swapRecord`. A record with an unrelated subject is kept.
   - Alternating PUT and DELETE intents keep separate operation ids and run in FIFO order after their predecessors.

### 5.3 Disconnect and reconnect (signed opt-out record)
- **Lexicon.** A new `lexicons/settings.json`, `<p>.settings`, with key `literal:self`: `{indexing: "enabled"|"disabled", createdAt}`.
- **Disconnect.** The SPA offers an export first, then writes `settings/self {indexing:"disabled"}` and sends notify. Once the settings proof verifies, the DO runs one `transactionSync` that:
  - deletes the DID's `scrobbles`, actor `follows`, `record_state`, `hints`, `repo_jobs`, `stats_cache` and `users` row;
  - inserts `suppression(did, settings_uri, settings_rev, suppressed_at)`;
  - keeps `backfill_generation`.

  Other owners' follows that point at the DID stay stored but are hidden, because the subject is not active.
- **While suppressed,** only hints for `<p>.settings` are processed for that DID.
- **Reconnect.** The owner deletes the record or sets `indexing:"enabled"`. A verified exclusion, or `enabled` with a revision above `settings_rev`, deletes the suppression row and admits a snapshot with a fresh generation.
- **Privacy note.** The opt-out is a public record, and it is honoured even after a full index rebuild.

### 5.4 Ingestion: hints, then proof, then apply
**Hint sources, all untrusted, each naming only `(did, collection, rkey)`:**
- Jetstream commit events;
- `POST /api/v1/notify`;
- reconcile and coalescing;
- relay `listReposByCollection` (DID only).

**Jetstream message handler** (synchronous, no await):
1. Parse with `@atmusic/atproto/jetstream/events`. Messages over 64 KiB are dropped and counted.
2. Ignore collections that are not configured.
3. In one `transactionSync`:
   - `INSERT INTO hints … ON CONFLICT(uri) DO UPDATE SET due_at=min(due_at,excluded.due_at), hint_rev=max(…)`;
   - `UPDATE ingest_checkpoint SET cursor=?, last_event_time_us=?`.

The cursor can never run ahead of a durable hint. Jetstream's inclusive cursor and at-least-once delivery are harmless because hints are idempotent.

**Verify drain** (timer `drain`):
- **Budget per alarm.** Paid: up to 200 hints, 4 concurrent fetches, at most 2 per PDS host. Free: at most 40 subrequests. Priority order: notify, then jetstream, then reconcile.
- **Per hint:**
  1. **Suppressed DID:** drop the hint unless its collection is `settings`.
  2. **Unknown DID → admission.**
     - Budget: 50 new DIDs per hour, and at most 1,024 pending snapshot jobs (the candidate's bound).
     - On admission, insert `users(active=0, indexing_state='recovering')` plus a `repo_jobs(snapshot)` row in one transaction. When the budget is full, both are rolled back.
     - The hint itself is never projected; activation needs a complete snapshot.
  3. **Coalescing:** if 25 or more hints are pending for one DID, delete them and schedule a snapshot (`reason='coalesced'`).
  4. **Identity:** `identity.resolveDid(did)`, using `identity_cache` with a 5-minute TTL and a 1-hour negative TTL.
  5. **Fetch:** `GET {pds}/xrpc/com.atproto.sync.getRecord?did&collection&rkey` through SafeFetch, with a 1 MiB cap and a 10 s deadline.
  6. **Verify:** `verifyRecordProof()` (§7). The `verified_commits` cache skips a repeated signature check for the same `(did, commitCid)`.
  7. **Apply** in one `transactionSync`, after re-reading the guards:
     - If `proof.commit.rev < users.max_rev`, the PDS is stale: retry with backoff, and after 5 attempts schedule a snapshot.
     - If `record_state.revision ≥ rev`: no-op.
     - **Present and valid:** validate with `@atmusic/core`, using the **hint receipt time** for the +300 s bound; upsert with keys from `@atmusic/core/music-key`; `record_state='present'`; `stats_version++`.
     - **Present and invalid:** delete the projection; `record_state='excluded', reason`; increment `counters('excluded', reason)`.
     - **Absent:** delete the projection; `record_state='absent'`.
     - **Settings record:** suppression logic (§5.3).
     - Then `users.max_rev = max(…)`, `last_activity_ms`, and delete the hint.
- **Errors:**
  - 5xx, 429 or timeout: hint backoff plus `host_backoff` honouring `Retry-After`/`RateLimit-Reset`; give up after 20 attempts with a counter, and schedule a snapshot.
  - `bad_signature`: one `resolveDid({fresh:true})` retry, then fail closed. The projection is unchanged and the failure is counted.
  - `RepoDeactivated`, `RepoTakendown`, `RepoSuspended` or `RepoNotFound`: a `status` job.
  - `no_proof`, `missing_block`, or an unparseable CAR: schedule a snapshot (F4).

### 5.5 Socket lifecycle and ingest modes
- **`socket` (Paid default).**
  - The DO opens `fetch("https://<host>/xrpc/network.bsky.jetstream.subscribeEvents?kinds=commit&collections=<p>.scrobble&collections=<p>.follow&collections=<p>.settings&cursor=<seq>", {headers:{Upgrade:"websocket"}})` and accepts `resp.webSocket`.
  - A `jetstream-watchdog` timer runs every 60 s. It reconnects if the socket is closed. Every 15 min it does a planned refresh, rotating hosts on failure, with reconnect backoff of 1 s base, exponential, 60 s cap and injected jitter.
  - The alarm cadence keeps the DO resident. An outbound connection alone keeps it alive for at most 15 min (https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/).
  - Deploys and runtime updates cut the socket; we resume from the cursor.
- **`pulse` (Free default).** Each cron tick and each 5-minute timer connects from the cursor, drains until an event's `time_us` is at least the connect time or 20 s pass, then closes. Lag is at most about 5 min, and DO duration drops sharply.
- **`off`.** Only notify, sweeps and snapshots run.
- **Gap.** The DO enters gap recovery if any of these hold on (re)connect:
  - the stored cursor time is older than `JETSTREAM_LOOKBACK_HOURS`;
  - Jetstream rejects the cursor;
  - there is no cursor (first start).

  Gap recovery:
  - set `pending_gap=1`;
  - resume from the live tail;
  - schedule snapshots for every known active DID, in bounded batches through `ingest_checkpoint.gap_scan_after_did`;
  - run one `listReposByCollection` discovery pass.

  `pending_gap` clears only once all of that work completes, as `relay_recovery` does today.

### 5.6 Accounts, identity and discovery
- **`status-sweep` (hourly).** Takes 200 DIDs per run, round-robin by `last_status_check_ms`. DIDs active in the last 30 days are due hourly; all others daily. The check is `com.atproto.sync.getRepoStatus`:
  - inactive (deactivated, takendown, suspended or deleted): `active=0` at once, and the user is hidden;
  - active again: `reactivate=1` plus a snapshot. The user stays hidden until a complete snapshot commits, guarded by generation (ADR 0003).
- **`identity-sweep` (daily).** Re-resolves the DID document and verifies the handle in both directions: DoH TXT `_atproto.<handle>` via `https://cloudflare-dns.com/dns-query` JSON, or `https://<handle>/.well-known/atproto-did`.
  - On mismatch, `handle=NULL`.
  - A changed PDS triggers a snapshot (PDS migration).
  - A conflict on the unique handle index clears the older holder's handle.
- **`discovery` (daily, and during gap recovery).** Pages relay `listReposByCollection?collection=<p>.scrobble`, then `<p>.follow`, into admission, bounded per day.
- **Deactivation latency** is at most 1 h for active users and at most 24 h for others, unless a proof fetch reports the change sooner (amendment A17).

### 5.7 Range snapshot (activation, reactivation, gap recovery, PDS migration, coalesced bursts)
The job is resumable, with one `repo_jobs(did,'snapshot')` row.
1. `getRepoStatus` must be active, then `getLatestCommit` gives `{cid, rev}`.
2. `getBlocks?did&cids=<commit>` returns the commit, which is verified (§7).
3. **The key range is `[<p>., <p>/)`.** `.` is 0x2E and `/` is 0x2F, so every key under our prefix is one contiguous range.
4. **Walk:** an iterative, in-order MST walk from `commit.data`.
   - It descends only into subtrees whose key bounds overlap the range.
   - Nodes and records come from `getBlocks` in batches of up to 100 CIDs (8 MiB response cap), and every block is CID-checked.
   - MST nodes are cached in `snapshot_blocks(did, cid)`.
   - A record is fetched only when its CID differs from the stored `scrobbles.cid`, `follows.cid` or `record_state.cid`. Re-snapshots therefore cost in proportion to changes.
5. **Ordered output:** `(key, cid)` entries, grouped in chunks with explicit key intervals `(prevKey, lastKey]`.
6. **Per chunk:** `applySnapshotChunk` in one transaction.
   - Upsert the verified present records with `revision = head_rev`, behind the per-URI guard.
   - Delete rows of that DID whose URI falls in the interval, whose key is absent from the chunk, and whose revision is below `head_rev`. A newer live hint always wins.
7. **Persist the frontier:** stack, last key and head go into `frontier_json`, so the next alarm resumes there.
8. **Blocks missing mid-walk** (`BlockNotFound`, because the PDS garbage-collected the old head): restart at the new head, reusing the CID cache. At most 5 restarts, then `failure_code='repository_changed'` with a backoff.
9. **Finish:** `getRepoStatus` again, then `completeSnapshot()`. If `job.generation == users.generation` and the DID is not suppressed:
   - `active=1` (or it stays hidden if the status is inactive);
   - `indexing_state='current'`;
   - `last_snapshot_at_ms`;
   - clear the cache.
10. **Fallback.** If `getBlocks` is unsupported (`MethodNotImplemented`, 404 or 501), stream `com.atproto.sync.getRepo` with a 32 MiB cap. Each block is CID-checked into `snapshot_blocks`, and then the same walker runs with a cache-only block source.

Memory is bounded by the frontier and the batch size, not by the repository.

### 5.8 Reads and statistics (Worker → one DO RPC → synchronous SQL)

**Request handling.**
1. The Worker validates parameters. Errors are 422 with `fields.limit`, `fields.window`, `fields.scope` or `fields.viewer`, and 400 `invalid_cursor`. There is no clamping.
2. It decodes the cursor with `@atmusic/core/cursor`. The token format and key derivation are identical to Rust's, so golden tokens decode.
3. It calls one RPC and builds `Page<T>` with `indexing`.

**History** (`scrobbles_owner_time`):
```sql
SELECT s.* FROM scrobbles s JOIN users u ON u.did=s.did AND u.active=1
WHERE s.did=?1 AND (s.listened_at,s.uri) <= (?2,?3) AND (?4 IS NULL OR (s.listened_at,s.uri) < (?4,?5))
ORDER BY s.listened_at DESC, s.uri DESC LIMIT ?6+1
```

**Feeds.**
- The global feed uses `scrobbles_global_time`.
- `scope=following&viewer=<did>` adds `s.did IN (SELECT f.subject FROM follows f JOIN users a ON a.did=f.actor AND a.active=1 WHERE f.actor=?viewer)`. It does not include the viewer, and the cursor binds the viewer.
- An unknown viewer gets 200 with an empty page.

**Statistics** are exact and read-time. The window is `listened_at ∈ [asOf − N·86400 s, asOf]`, both bounds inclusive. Future rows are excluded until `listened_at ≤ asOf`.
```sql
WITH w AS (SELECT s.* FROM scrobbles s JOIN users u ON u.did=s.did AND u.active=1
           WHERE s.did=?1 AND s.listened_at <= ?2 AND (?3 IS NULL OR s.listened_at >= ?3)),
g AS (SELECT artist_key, count(*) c, max(listened_at||' '||uri) newest FROM w GROUP BY artist_key)
SELECT g.artist_key, g.c, s.artist FROM g JOIN scrobbles s ON s.uri = substr(g.newest, 32)
ORDER BY g.c DESC, g.artist_key ASC LIMIT ?4;
```
- **Tracks** group by `(artist_key, track_key)`.
- **Albums** group by `(artist_key, album_key)` with `album_key IS NOT NULL`.
- **Totals:** `count(*)`, `count(DISTINCT artist_key)`, and the number of `(artist_key, track_key)` groups.
- **Ordering:** SQLite BINARY collation is UTF-8 byte order, which is code-point order, which equals Rust `String`/tuple `Ord`. Any JavaScript-side sort must use `unicode/compare.ts`.
- **Display spelling** comes from the newest `(listened_at, uri)` row, because the fixed-width 30-character timestamp sorts correctly.

**Exact stats cache.** `stats_cache(did, win, lim)` holds `{as_of, lower, version, body}`. A cached body is reused at `asOf1` only when all of these hold:
- `users.stats_version` is unchanged;
- no row of that DID has `listened_at ∈ (as_of0, asOf1]`;
- no row has `listened_at ∈ [lower0, lower1)`.

Those are two indexed `EXISTS` probes. The result is then provably identical, and the response carries `asOf1`.

**Profiles** (docs/profiles.md):
- 404 for unknown or inactive users *before* any identity request.
- `Cache-Control: no-store` on profile and resolve.
- The handle appears only when verified in both directions.
- Counts use distinct, confirmed, active edges.

**Follow lists:** one representative per `(actor, subject)`, the smallest active URI, ordered by the representative's `(created_at, uri)` descending. Carol→Bob twice counts once.

### 5.9 Background schedule (one alarm, `timers` table)

`alarm()` calls `tick(now)`. It runs due timers in this priority order: `drain`, `snapshot`, `jetstream-watchdog`, `status-sweep`, `identity-sweep`, `discovery`, `gc`. Each step is bounded and durable before it acknowledges anything. The alarm is re-armed at `min(due_at)`. Alarms are at-least-once (https://developers.cloudflare.com/durable-objects/api/alarms/), and every step is idempotent.

| Timer | Cadence | Bound per run |
|---|---|---|
| `drain` | While hints are due, at most every 2 s | 200 hints (Paid) / 40 subrequests (Free) |
| `snapshot` | While jobs are pending | 1 job slice: ≤ 200 / 40 subrequests, ≤ 2,000 entries |
| `jetstream-watchdog` | 60 s (`socket`) / 5 min (`pulse`) | One connect |
| `status-sweep` | Hourly | 200 DIDs |
| `identity-sweep` | Daily | 200 DIDs |
| `discovery` | Daily | 10 pages |
| `gc` | Daily | Old `hints` errors, `snapshot_blocks` of finished jobs, `verified_commits` older than 7 d, `identity_cache` |

Cron (`*/5`) calls `ensureRunning()`, a cheap check that re-arms the alarm. It is not load-bearing.

---

## 6. Storage: DO SQLite schema and mapping from the existing SQL

D1 is **not used**. The schema stays D1-dialect compatible (same 100-parameter, 100 KB statement and 2 MB row limits, https://developers.cloudflare.com/durable-objects/platform/limits/), so per-DID sharding or a D1 read replica stays possible later.

**Conventions:**
- Ordering timestamps are TEXT in fixed-width UTC with 9 fractional digits, `YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ` (30 characters), as docs/cursors.md already specifies. Responses render timestamps exactly as the Rust DTOs do, pinned by the golden `tests/goldens/timestamps.json`.
- Internal timers are INTEGER epoch milliseconds.
- Every integer is a safe JS integer. Jetstream `seq` and `time_us` are about 1.8e15, below 2^53.

**Migrations:**
- They live in `worker/src/do/schema.ts` as an ordered array.
- They run in the DO constructor under `ctx.blockConcurrencyWhile`, inside one `transactionSync`.
- `schema_migrations` replaces `PRAGMA user_version`.
- A schema newer than the code gives `/health/ready` 503.

### 6.1 Mapping

| Existing table (crates/storage/migrations 0001–0004) | Fate | New table and changes |
|---|---|---|
| `users` | **Kept, extended** | Adds `pds`, `handle_checked_at_ms`, `account_status`, `max_rev` (was `revision`), `generation`, `stats_version`, `last_snapshot_at_ms`, `last_status_check_ms`, `last_activity_ms`. `active` now defaults to **0** until the first complete snapshot. |
| `scrobbles` | **Kept** | Drops `confirmed` (only verified present rows exist). Adds `rkey`. Same three indexes. |
| `follows` | **Kept** | Drops `confirmed`. Same indexes. |
| `tombstones` | **Replaced** | By `record_state(uri, did, collection, revision, cid, state present\|absent\|excluded, reason, verified_at)`, the per-URI monotonic guard. It also backs `/records/status`. |
| `suppression` | **Kept, extended** | Adds `settings_uri` and `settings_rev`. |
| `indexing_status` | **Kept** | Seeded `('global','recovering',0)` as today. |
| `backfill_generation` | **Kept** | Global generation counter. |
| `repo_backfills` | **Replaced** | By `repo_jobs(did, kind snapshot\|status\|identity, PK(did,kind))`, with `state`, `generation`, `reason`, `head_rev`, `head_cid`, `frontier_json`, `restarts`, `reactivate`, `due_at`, `attempts`, `failure_code`, `updated_at_ms`. |
| `relay_checkpoints`, `relay_recovery` | **Merged** | Into `ingest_checkpoint(stream PK, cursor, last_event_time_us, connected, pending_gap DEFAULT 1, gap_scan_after_did, mode, host_index, connected_at_ms, updated_at_ms)`. |
| `operations`, `outbox`, `idempotency`, `operation_dependencies` | **Dropped (A11/A12)** | Their behaviour moves to `web/src/outbox` (IndexedDB). |
| `oauth_states`, `oauth_tokens`, `sessions` | **Dropped (A3)** | No server credentials. |
| *(new)* `hints` | | `uri PK, did, collection, rkey, source jetstream\|notify\|reconcile, priority, hint_rev, receipt_time, due_at, attempts, last_error`; indexes `(due_at)` and `(did)`. |
| *(new)* `snapshot_blocks` | | `did, cid, bytes BLOB, PK(did,cid)`: MST-node and fallback block cache. |
| *(new)* `identity_cache` | | `did PK, doc_json, signing_key, pds, handle, fetched_at_ms, neg_until_ms`. |
| *(new)* `verified_commits` | | `did, commit_cid, rev, verified_at_ms, PK(did,commit_cid)`. |
| *(new)* `host_backoff` | | `host PK, until_ms`. |
| *(new)* `admission` | | `window_start_ms PK, admitted`: hourly admission budget. |
| *(new)* `timers` | | `name PK, due_at`. |
| *(new)* `stats_cache` | | `did, win, lim, as_of, lower, version, body, PK(did,win,lim)`. |
| *(new)* `counters` | | `name, label, value, PK(name,label)`. Replaces the Prometheus metrics. |

Foreign keys: `scrobbles.did` and `follows.actor` reference `users(did) ON DELETE CASCADE`. Enforcement is asserted by the conformance suite. Disconnect still deletes explicitly; nothing relies on a cascade the test does not check.

---

## 7. Verification strategy

All repository trust is **current-head trust** under the **current DID key**, as in ADR 0003.

1. **CAR bounds** (`verify/car-bounds.ts`):
   - a byte cap per call site;
   - varint header and section lengths checked against the remaining bytes before `@atcute/car` reads them;
   - a block-count cap;
   - CIDv1 only, dag-cbor (0x71) for nodes and commits, dag-cbor or raw for records, sha2-256, 32-byte digests;
   - every block re-hashed against its CID;
   - root = the first root only.
2. **Commit** (`verify/commit.ts`):
   - `version === 3`, `did === requested`, `rev` a valid TID, `data` a CID link;
   - the signature is checked over `dagCbor(unsigned commit)` with the `#atproto` multikey from a fresh resolution, using `@atcute/crypto` (P-256 via WebCrypto, secp256k1 via noble);
   - low-S is enforced (`allowMalleableSig=false`);
   - `@atproto/crypto` serves as a test cross-check.
3. **Record proof** (`verify/record-proof.ts`):
   - Only CID-verified blocks go into a memory store.
   - `@atcute/mst` `findRpathAndBuildProof(store, commit.data, "coll/rkey")` returns a CID, which means present, or `null`, which means **proven** absent. An incomplete path throws `missing_block`.
   - A present record block must match that CID. It is then decoded and passed to schema validation.
   - `@atcute/repo` `verifyRecord` is **not** used: it reports not-found for a missing path node and exposes no `rev`.
4. **Range walk** (`snapshot/walker.ts`):
   - It descends only through signed CIDs.
   - It checks MST invariants: entries in strictly ascending order, a key-prefix compression check, layer and depth consistency, depth ≤ 256, and no repeated node CID within one walk.
   - Any missing block is a typed error, never treated as absence.
5. **Monotonicity:**
   - per DID, `commit.rev ≥ users.max_rev` (stale-PDS defence);
   - per URI, `record_state.revision` (an older proof can never resurrect or overwrite newer state).
6. **Fail closed.** A rejection leaves the projection and checkpoint tables byte-identical. Only `hints.attempts`/`last_error` and `counters` may change.
7. **Oracle parity.** Rust-signed golden CARs are produced by the existing `tests/support/signed_repo.rs` keys (W0-03), one valid set plus one per corruption: signature byte, block byte, MST node, DID, version, rev, root, truncation, oversize, and a record CID swap. The TS verifier must accept exactly the valid ones. The walker must enumerate exactly the Rust `verify_snapshot` record set.

---

## 8. Security model

| Concern | Realisation |
|---|---|
| Server secrets | `CURSOR_KEY` only (HKDF-style derivation matching `cursor.rs`, context `atmusic:cursor:hmac-sha256:v1`), plus an optional `ADMIN_TOKEN`. Never logged or serialised. |
| User credentials | **None on the server.** OAuth tokens and the non-extractable DPoP key live in the user's browser (IndexedDB) under `@atproto/oauth-client-browser`. "No API exposes tokens" holds trivially. |
| SSRF (amends ADR 0002, A5) | Workers `fetch` resolves DNS itself, so DNS pinning is **impossible**. `SafeFetch` policy:<br>• https only, default port;<br>• hostnames only: IPv4/IPv6/mapped literals rejected, as are `localhost`, `.local`, `.internal`, `.arpa`, `.test` (outside the fixture transport) and single-label names;<br>• a DoH A/AAAA pre-check against `cloudflare-dns.com` that rejects any private, loopback, link-local, CGNAT, ULA, multicast or reserved answer (cached per host for min(TTL, 300 s));<br>• `redirect:"manual"`, and any 3xx is an error (Workers throws on `redirect:"error"`, https://developers.cloudflare.com/workers/runtime-apis/request/);<br>• `AbortSignal.timeout(10_000)`;<br>• streamed body caps: DID doc 64 KiB, JSON 1 MiB, getRecord 1 MiB, getBlocks 8 MiB, getRepo fallback 32 MiB;<br>• no credentials on any outbound request.<br>**Residual:** DNS-rebinding TOCTOU. Impact is low because the Worker has no private network and holds no user credentials. A live probe (W6-05) records how Workers `fetch` behaves toward RFC 1918 and loopback targets. |
| XSS (browser token custody) | Strict CSP in `_headers`: `default-src 'self'; script-src 'self'; connect-src 'self' https:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'`. Also `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. No third-party scripts. A lint rule bans `dangerouslySetInnerHTML`. Residual: XSS can act in-page; that is documented. |
| Notify abuse | Body ≤ 2 KiB (413). Strict JSON; unknown fields 422. AT-URI and DID syntax checked; configured collections only. Per-IP 60/min (`CF-Connecting-IP`, copied by the Worker after stripping any inbound `x-atmusic-*`). Per-DID 600/h. New DIDs only through admission (50/h, 1,024 jobs): 503 `queue_full` when exhausted, 429 when rate-limited. Notify can only make us check public signed truth; it cannot inject data. |
| Rate buckets | In memory in the singleton DO. This is correct because exactly one instance is live. Buckets fail open after a restart, which is documented. |
| Namespace gate | With `LEXICON_PREFIX` empty, ingestion and publication are disabled and `meta.lexiconPrefix=null`. The fixture prefix `com.example.atmusic` is refused outside test entries. The SPA hides the write UI unless it was built with an owned prefix. |
| Admin | `/internal/admin/{status,pitr,resnapshot}` exist only when `ADMIN_TOKEN` is set. Bearer token, constant-time compare. Durable Objects have no public address. |
| Test seams | Fault injection lives only in `worker/test/**/entry.ts` and `packages/*/test-support`. `scripts/check-bundle.ts` fails CI if the production bundle contains `test-support`, `fixedClock`, `com.example.atmusic` handling or `node:crypto`. Wrangler's default esbuild `browser` platform selects the noble build of `@atcute/crypto`. |
| Verification | No production flag can skip TLS, signature, CID, MST, DNS or IP policy, or the issuer check (the issuer check is the library's, in the browser). |

---

## 9. Amended MVP / API / ADR rules

Each amendment needs an issue amendment that cites the demonstrated gap (MVP.md "Completion and execution rules"). W0-02 drafts them in `docs/planning/AMENDMENTS-workers.md`. The case map refers to them by id.

### 9.1 Kept unchanged
- **Lexicons.** `<p>.scrobble` and `<p>.follow` v1 with all field limits. Trimming and non-empty rules. The +300 s / 1970 bounds checked against **receipt time**. Remote malformed records excluded with a reason.
- **Namespace.** The owned-NSID prerequisite. `com.example.atmusic` is fixture-only.
- **Identity.** DID and AT URI identity. CID and revision as version evidence. One record is one listen; equal timestamps are allowed.
- **Grouping.** NFKC, then full case-fold, then White_Space trim and collapse. Typed tuple keys. No album bucket. Newest-display with the URI tie-break. MBIDs are not keys.
- **Follows.** The deterministic follow rkey. Duplicate edges collapse, with the min-URI representative. An edge is removed only when no active record remains.
- **API envelope.** The error envelope and status semantics for every remaining route. List limits: default 20, max 100, 422 with no clamping. Stats limits: default 10, max 100.
- **Cursors.** Format, HMAC binding, mutation semantics and their documented limits.
- **Payloads.** Every public read payload is unchanged: `Scrobble`, `Follow`, `Page`, `Profile`, `Statistics`, `Indexing`, `meta`, `resolve`, `health`.
- **Profiles.** 404 before any identity request; `no-store` on profile and resolve; verified-handle rule.
- **Disconnect.** Keeps only the suppression marker and claims no erasure.
- **Verification.** "Verify repository signatures, CIDs and record membership" and "complete verified snapshot before activation or reactivation" both stay, and are strengthened (§7).
- **Discovery.** Historical discovery is limited to seeded actors and relay coverage. No global or completeness promise.
- **Outbox semantics.** The retry formula, the exactly-10-attempts cap, crash-stage safety, ambiguous-create reconciliation, never-overwrite, and predecessor ordering are all kept as behaviour. Their location changes (A12).
- **TESTING.md.** The frozen clock `2026-01-15T12:00:00Z`; deterministic randomness; the shared fixture; every exact history, feed, stats, boundary, mutation and cursor assertion; real-crypto fixtures; assertions on status, schema, DB and remote calls; live gates that report `blocked`.

### 9.2 Amended
- **A1 Deployment.** "One Rust HTTP process, embedded SQLite, musl executable, reverse proxy, encryption key" becomes "one Worker, one SQLite Durable Object, Static Assets, one Cron, `CURSOR_KEY`, custom domain". Single instance; multi-writer stays deferred.
- **A2 Role.** "AppView/indexer **and write client**" becomes "AppView/indexer; **the SPA** is our write client".
- **A3 ADR 0002 OAuth.** The server-side public client becomes a browser public client (`@atproto/oauth-client-browser`). The callback moves to `/oauth/callback`, an SPA route. `client-metadata.json` becomes a build-time static asset at the **same path**. Sessions follow library and spec limits (at most 14 days for public clients) instead of a 7-day app cookie.
- **A4 Libraries.** atrium, jwt-compact, hickory, reqwest and tungstenite are replaced by `@atcute/{car,cbor,cid,mst,crypto,identity-resolver}`, `@atproto/oauth-client-browser`, and Workers `fetch`/WebSocket. Demonstrated gap: tokio and sqlx do not run on Workers, and `@atproto/repo`, `@atproto/identity` and `oauth-client-node` are Node-bound.
- **A5 ADR 0002 SSRF.** DNS pinning becomes the host policy plus a DoH pre-check, with no pinning (§8).
- **A6 MVP "require a supported relay".** Jetstream events (`kinds=commit`), notify, relay `listReposByCollection` and coalescing are **hints only**. Authority comes from a `getRecord` proof or a range snapshot at the current signed head. Gap recovery and discovery remain required.
- **A7 ADR 0003 snapshot.** The full `getRepo` CAR (8 MiB / 10,000 records) becomes a `getBlocks` range walk with no record ceiling, with a 32 MiB streamed `getRepo` fallback. Relay frame verification is no longer on the production path.
- **A8 Feed.** `scope=following` changes from "requires session" to "requires `viewer=<did>`" (public; 422 `fields.viewer` if missing or invalid; the cursor binds the viewer).
- **A9 Export.** `GET /api/v1/account/export` (owner cookie) becomes `GET /api/v1/users/{did}/export`: public, the same payload, an attachment, `no-store`, and 404 for unknown or inactive users.
- **A10 Disconnect.** `DELETE /api/v1/account/local-data` becomes the signed `<p>.settings/self` opt-out record (§5.3), plus the new `lexicons/settings.json`.
- **A11 Idempotency.** The server `Idempotency-Key` (400/409) becomes a client TID rkey allocated once plus PDS existence and a digest comparison. A conflict is the client-side terminal `remote_record_conflict`.
- **A12 Outbox.** The server outbox becomes the SPA IndexedDB outbox, with the same formula, cap and crash barriers. Retries run only while a tab is open.
- **A13 Pending deletion.** "Hides immediately" becomes an owner-side optimistic overlay. Public visibility changes once signed absence is verified, typically within seconds through notify.
- **A14 M7 ordering.** "No frontend before M6.4" is dropped. The SPA write path is core, and starts in Wave 1. Browser end-to-end tests still follow backend composition.
- **A15 Backup (M6.3.1).** File backup becomes DO point-in-time recovery (30 days; `getBookmarkForTime` / `onNextSessionRestoreBookmark` behind admin) plus a full rebuild from public repositories. The index, including suppression, is derived data.
- **A16 Metrics (M6.2.2).** The Prometheus listener becomes Workers Logs, the `counters` table, and `/internal/admin/status`.
- **A17 Account events.** Relay account events become error-driven detection plus the `getRepoStatus` sweep (≤ 1 h for active users, ≤ 24 h for others). The fixture drives this deterministically by stepping the timer.
- **A18 TESTING.md harness wording.**
  - "Port 0 / child process / LD_PRELOAD restart" becomes "isolated workerd storage per test file, a unique DO name per test, and DO eviction for restarts". Restarts must still reopen the same storage.
  - The fixture transport is injected at the `Transport` boundary.
  - Commands become `npm test`, `npm run test:e2e` and `bash scripts/check-ts.sh`.
- **A19 Release (M1.2.3, M6.4.1).** The static musl artifact and checksums become a Worker version id plus a bundle SHA-256 (`wrangler versions upload`).
- **A20 Meta.** `stage` and `capabilities` reflect the Workers composition: `read`, `stats`, `follows`, `notify`, `indexing`, and `publication` only with an owned prefix.

### 9.3 Dropped
- **Server auth routes:** `POST /api/v1/auth/start`, `GET /api/v1/auth/callback`, `GET /api/v1/auth/session`, `POST /api/v1/auth/logout`.
- **Server write routes:** `POST /api/v1/scrobbles`, `DELETE /api/v1/scrobbles/{id}`, `PUT/DELETE /api/v1/follows/{did}`, `GET /api/v1/operations/{id}`.
- **Account routes and schemas:** `GET /api/v1/account/export` and `DELETE /api/v1/account/local-data`, both replaced (A9, A10); the `Accepted` and `Operation` schemas.
- **Server auth rules:**
  - session cookies, the CSRF token and Origin rules, and the private-access 401/403/404 matrix;
  - server OAuth state (300 s);
  - encrypted token storage and the operator encryption key.
- **Operational deliverables:**
  - M1.2.3 musl artifact and smoke tests;
  - M1.4.3 SIGTERM drain;
  - M6.1.1 build.rs embedding (replaced by Static Assets);
  - M6.1.2 trusted proxy (replaced by `CF-Connecting-IP`);
  - the `backup` CLI;
  - the relay `subscribeRepos` production path.

### 9.4 Added
- **N1** `POST /api/v1/notify`: body `{uri}` or `{did}`. Returns 202 `{state:"queued"}`; 400, 413, 422, 429, or 503 `queue_full`.
- **N2** `GET /api/v1/records/status?uri=`: 200 `{uri, state:"indexed"|"pending"|"absent"|"excluded"|"unknown", cid?, revision?, reason?, indexing}`, `no-store`.
- **N3** `GET /api/v1/users/{did}/export` (A9).
- **N4** `lexicons/settings.json` (A10).

The `/api/v1` prefix is kept, because no deployed clients exist. `api/openapi.yaml` moves to `info.version: 1.1.0`.

---

## 10. Testing strategy

### 10.1 Runners
- **Workspace.** The root `vitest.config.ts` uses `projects: ["packages/*", "worker/vitest.*.config.ts", "web"]` with `passWithNoTests: false`.
- **workerd projects.** `packages/core`, `packages/atproto` and the worker run under `cloudflareTest` from `@cloudflare/vitest-plugin`. That gives real workerd ICU (`normalize`), real WebCrypto, real DO SQLite, real alarms, and per-file isolated storage. The plugin API and config are unchanged from `vitest-pool-workers` (https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/).
- **`cloudflare:test` helpers:** `runInDurableObject`, `runDurableObjectAlarm`, DO eviction, and `createScheduledController`. W0-01 asserts that each helper exists in the pinned version.
- **Worker test entries:**
  - `worker/vitest.modules.config.ts` runs against the **harness DO**, which has migrations applied and exposes `doDb`.
  - `worker/vitest.acceptance.config.ts` (W6-01) runs against the real `IndexDO`, subclassed by the test entry.
- **SPA:** vitest with happy-dom and `fake-indexeddb`.
- **Browser:** Playwright against `wrangler dev` with the e2e entry, plus `@atproto/dev-env` (a local PDS and PLC; test-only Node infrastructure).
- **Reporting.** `scripts/report-tests.ts` converts the vitest JSON reporter output into per-case records (target, command, executed count, result, commit), as TESTING.md requires. A zero-test filtered run fails.

### 10.2 Determinism
- **Clock.** `fixedClock("2026-01-15T12:00:00Z")` is injected into validators, retry, buckets, caches, stats, timers and TID generation. Time is advanced directly and nothing sleeps. Alarms are stepped with `runDurableObjectAlarm` after `clock.advance`.
- **Randomness.** A seeded `Random` covers TIDs, jitter (zero jitter for the exact delay tests) and request ids.
- **No network.** `router-transport.ts` maps reserved fixture hostnames to the fake PDS, PLC, DoH, relay and Jetstream. The production SafeFetch policy stays on, and the fixture DoH answers with public test-net addresses.
- **Restart.** Evict the DO and keep its storage. Byte-compare all projection tables and the responses before and after, continue a cursor issued before the restart, and assert the alarm resumes. This replaces `read_model_restart`'s child-process restart.

### 10.3 Shared fixture through the real ingestion path
- `tests/fixtures/read_models.json` is used **unchanged**.
- `packages/atproto/test-support/read-models.ts` publishes Alice's, Bob's and Carol's records as **real signed commits**: real MSTs with `@atcute/mst`, deterministic secp256k1 and P-256 keys. They go on fake PDSs.
  - r08 is created and then deleted.
  - Alice→Bob is a follow record.
  - Carol's r10 enters **only** as an external writer.
- Fake Jetstream emits the commits, then the production drain verifies and applies them. CIDs and revisions come from the fixture signer and are never fabricated.

**Exact assertions, hardcoded from TESTING.md and never computed by the code under test:**

- **History and feeds:**
  - Alice's history is r07, r01, r02, r03, r04, r05, r06. At limit 2 the pages are `[r07,r01] [r02,r03] [r04,r05] [r06]`, then `nextCursor: null`.
  - The global feed is r09, r10, r07, r01, r02, r03, r04, r05, r06.
  - Alice's following feed is r09 only.
  - Follow counts: Alice 0/1, Bob 1/0, Carol 0/0.
- **Statistics:**
  - Totals:

    | Window | Listens | Artists | Tracks |
    |---|---|---|---|
    | all | 7 | 3 | 6 |
    | 7d | 4 | 2 | 3 |
    | 30d | 5 | 2 | 4 |
    | 365d | 6 | 3 | 5 |

  - Every ordered top-artists, top-tracks and top-albums list for every window.
  - Lower bounds `2026-01-08T12:00:00Z`, `2025-12-16T12:00:00Z` and `2025-01-15T12:00:00Z`, each with records at −1 s, 0 s and +1 s.
  - Future records (+300 s) are excluded.
- **Mutations:**
  - Delete r01 → 6/6/3 and Homogenic 1.
  - r03's artist becomes Björk → Björk 3, Kate Bush 2, Radiohead 2.
  - Remove Alice→Bob → her following feed is empty.
  - Two Carol→Bob duplicates → 2, still 2 after one is deleted, back to 1 after both.
  - Deactivate Alice → hidden. Reactivate → hidden until the snapshot completes.
- **Cursors:**
  - Union of all pages is the exact URI list, with no duplicates.
  - An arrival above the anchor does not appear.
  - Deleting a record not yet returned removes it.
  - The reorder behaviour is asserted as documented.
  - One-bit tamper, wrong DID/scope/viewer, wrong version and bad base64 all give 400 `invalid_cursor`.
  - Golden Rust tokens decode.

**Every HTTP test asserts:**
- the status;
- **schema**, through AJV against `api/openapi.yaml`;
- DO table state, through `runInDurableObject`;
- fixture remote-call counts.

### 10.4 Other required suites
- **Rejection matrix:** change exactly one invariant, then assert the projection and checkpoint tables are byte-identical, then show that a valid hint still applies.
- **Query plans:** seed 100 DIDs × 1,000 records with one snapshot each. `EXPLAIN QUERY PLAN` must use the indexes for history, feeds and stats. A negative control drops the indexes.
- **SPA outbox:**
  - delays of 1, 2, 4 … s capped at 300 s;
  - `Retry-After: 20` gives 20 s;
  - exactly 10 attempts and no 11th fetch;
  - crash barriers before send, after the PDS commit but before the local ack, after the local commit, and during delete, simulated by re-instantiating the runner over the same IndexedDB;
  - ambiguous-create success and conflict;
  - PUT, DELETE, PUT for one subject run in order.
- **Golden parity:** music keys, validation, timestamps, follow rkeys, windows, cursors and signed CARs from the Rust oracle. `scripts/check_goldens.sh` regenerates and diffs them in CI for as long as the Rust code remains.
- **Case map:** `docs/verification/ts-case-map.json` maps all 258 named cases from `github-plan.json` to a TS test id or `retired:<A#>`. `scripts/validate_case_map.py` fails CI on an unmapped case, a duplicate, or a test id missing from the repository.
- **Live gates** (`scripts/live/*.ts`) exit nonzero as **blocked** when prerequisites are missing:
  - owned NSID;
  - a deployed HTTPS origin;
  - identities on two independent PDSs;
  - Jetstream coverage.

  The gates cover:
  - OAuth sign-in on both PDSs;
  - publishing and indexing a scrobble;
  - an external writer;
  - delete and reconcile;
  - support for `getRecord` exclusion proofs, `getBlocks` and `repo:` scopes per PDS;
  - the SSRF probe;
  - a 24 h socket soak measuring reconnects, lag, billed DO requests and CPU per alarm.

  Evidence is recorded per Worker version id.

---

## 11. Cost and plan tier

Sources:
- https://developers.cloudflare.com/durable-objects/platform/pricing/ (checked 2026-10-24). DO allowances on Free: 100k requests/day, 13k GB-s/day, 5M rows read/day, 100k rows written/day, 5 GB. On Paid: 1M requests and 400k GB-s per month, 25B rows read, 50M rows written, 5 GB-month. Overages: $0.15/M requests, $12.50/M GB-s, $0.001/M rows read, $1.00/M rows written, $0.20/GB-month. Incoming WebSocket messages are billed 20:1; this is documented for inbound sockets and undocumented for outbound.
- https://developers.cloudflare.com/workers/platform/limits/: Free has 10 ms CPU, 50 subrequests and 100k requests/day. Paid allows up to 5 min CPU and 10k subrequests. Both: 6 simultaneous connections, 128 MB per isolate, 64 MiB script, 1 s startup.

**Free plan: development, staging and private hobby use only.**
- The Worker's per-request work (routing, HMAC, JSON) fits in 10 ms.
- `PLAN=free` sets alarm slices to 40 subrequests or fewer, and `INGEST_MODE=pulse` keeps DO duration well under 13k GB-s/day. An always-on socket DO uses about 11k.
- Capacity is roughly 8k ingested records/day (about 12 rows written per record) and about 90k API calls/day.
- Quotas fail hard: `/api/*` errors while assets keep serving.
- Free-plan DO CPU and per-object storage are inconsistently documented (the FAQ says 1 GB per object on Free).

**Workers Paid ($5/month minimum) is required for production.** Estimate for 1,000 users, 30k scrobbles/day and 300k API calls/day:

| Item | Usage | Cost |
|---|---|---|
| Base | — | $5.00 |
| Worker requests | ~9M/month (10M included) | $0 |
| DO requests | ~9M API + ~0.9M socket messages (worst case 1:1) + ~0.1M alarms ≈ 10M (1M included) | ≈ $1.35 |
| DO duration | One resident DO ≈ 332k GB-s (400k included) | $0 |
| Rows written | ~12 × 0.9M ≈ 11M (50M included) | $0 |
| Rows read | Stats-dominated, ≈ 5–15B (25B included). The exact cache cuts this. | $0 |
| Storage | ~1 KB/scrobble with indexes ≈ 0.9 GB/month growth (5 GB included) | $0, then ~$0.20/GB-month |
| Static assets | — | Free |
| **Total** | | **≈ $6–8/month**, plus a domain at about $10/year |

**Hobby scale** (100 users, 1k scrobbles/day): **$5 flat**.

**Ceiling.** A DO holds 10 GB, about 10M scrobbles. At 30k/day that is reached in about 11 months; at hobby scale it is decades away.

**The way out is per-DID shards.** History, profile and stats are per-DID, so they can move to shard DOs keyed by DID hash. The global feed would keep slim `(listened_at, uri, did)` rows. Module functions already take an explicit `did` to allow this. Sharding is deferred, consistent with "multi-writer deferred", and not built.

---

## 12. Fate of the existing Rust crates

| Crate | Fate |
|---|---|
| `crates/core` (about 1k src lines) | **Kept as the oracle.** A new `examples/export_goldens.rs` (W0-03) exports music keys, validation verdicts, timestamp renderings, follow rkeys, window bounds, cursor tokens and stats read models. Optional retirement after acceptance (W7-02, owner decision). |
| `crates/atproto` | **Frozen, oracle only.** A new `examples/export_signed_cars.rs` exports Rust-signed valid and corrupted CARs and the `verify_snapshot` enumerations. No new features. |
| `crates/storage`, `crates/server` | **Frozen.** Their named test cases are the specification for the case map. They are **retired** in W7-02 after the Workers acceptance gate, with owner approval; git history keeps them. |
| musl and release tooling (`scripts/smoke.py`, `package_release.py`, `audit_release.py`, `check_release.py`, `validate_build.py`, the `release.yml` and `ci.yml` static-linux job) | The static-linux CI job is removed in W0-01. The remaining release scripts and `release.yml` are retired in W7-02. |

Nothing is ported line by line. TypeScript re-implements against the frozen specification, and the oracle checks parity.

---

## 13. What Workers cannot do, and residual risks
1. **DNS-pinned outbound connections.** Impossible; the policy is amended (A5), with a TOCTOU residual.
2. **An uninterrupted socket.** Deploys and runtime updates cut it, outbound sockets do not hibernate, and there are no shutdown hooks. Correctness rests on cursor replay within Jetstream's bounded lookback, which its documentation does not quantify. A longer outage triggers gap recovery: snapshots of known DIDs plus relay discovery. A DID that wrote only during the gap, and that the relay does not list, can be missed until it writes again.
3. **Coverage.** Coverage equals Bluesky relay and Jetstream coverage. PDSs that are not crawled reach us only through notify (our SPA always sends it).
4. **Writes after the tab closes, and sessions over 14 days.** Both need the BFF fallback (Q1).
5. **Unicode.** NFKC comes from workerd's ICU, not a pinned table. Golden tests run in workerd on every upgrade. Case folding uses a vendored `CaseFolding-16.0.0` table.
6. **Scale.** One DO location (API latency of about 100–250 ms for distant users; assets are edge-served), a soft limit of about 1,000 req/s, and a 10 GB cap.
7. **Undocumented platform behaviour.** For outbound sockets: message billing, and whether CPU is reset. The 24 h soak (W6-05) settles both, with `pulse` mode as the fallback.
8. **PDS behaviour.** Support for exclusion proofs, `getBlocks` and granular `repo:` scopes varies across non-reference PDSs. Fallbacks: snapshot, then `getRepo`, then the `transition:generic` scope (needs an amendment, Q5). All are gated live.
9. **Third-party libraries.** `@atcute/*` is mostly single-maintainer. Mitigations: exact pins, oracle parity, and cross-checks against `@atproto/crypto`.

---

## 14. Work plan summary

The orchestrator holds the full package list. The waves are:

| Wave | Contents |
|---|---|
| **0** | Skeleton, shared interfaces, complete DO schema with the SQL conformance suite, test harness and CI (W0-01); contract and plan amendments plus the case map (W0-02); Rust oracle goldens (W0-03). |
| **1** | Pure foundations: core validation, music keys, write policy and record keys, SafeFetch, signed-repo fixture kit, Jetstream parser, HTTP foundation, timers, build config and bundle guard, SPA scaffold. |
| **2** | Cursor codec, identity, record-proof verifier, projection apply, indexing status, SPA OAuth, SPA outbox. |
| **3** | Read routes (history and feed; stats; profile, follows and export), hint queue and verify drain, range walker, SPA screens. |
| **4** | Snapshot jobs, Jetstream ingestor and modes, account and identity sweeps plus discovery, notify and record-status. |
| **5** | Composition: Worker entry, router, `IndexDO` RPC, cron, admin. |
| **6** | Backend acceptance in workerd, benchmark, browser end-to-end tests, deploy and operations docs, live gates. |
| **7** | Acceptance gate and case-map closure; Rust retirement, gated on the owner. |

Critical path: W0-01 → W1-01 → W2-04 → W3-04 → W4-01 → W5-01 → W6-01 → W7-01.

---

## 15. Open questions: interim decisions

The owner delegated these architecture calls ("you may do what you think best"). These are the interim defaults Claude chose on 2026-10-24. The owner may override any of them. The §9 amendments bind under these defaults.

| # | Question | Interim decision |
|---|---|---|
| Q1 | Browser writes versus a confidential BFF | **Browser public client.** The SPA writes directly to the user's PDS, and the Worker has no user credentials. The BFF fallback below stays documented. |
| Q2 | Disconnect mechanism | **A public, repo-signed `<prefix>.settings/self` record** with indexing disabled. The opt-out is public, and that is documented in the user-facing settings screen. |
| Q3 | Production domain and NSID prefix | **Unresolved; the owner must supply it.** Everything is configurable. `com.example.atmusic` stays fixture-only. The production bundle guard refuses to build or deploy until a real domain and owned prefix are configured. |
| Q4 | Plan tier | **Workers Paid for production.** The Free plan is supported for dev and staging in `pulse` ingest mode. |
| Q5 | OAuth scope fallback | Request granular `repo:<nsid>` scopes. `transition:generic` is allowed only behind an explicit build-time flag that is off by default. |
| Q6 | Rust crates | **Kept** as the golden-vector oracle. W7-02 (retiring the Rust code) is not executed without explicit owner approval. |
| Q7 | Public following feed via `?viewer=<did>` | **Accepted.** Follow records are already public. |
| Q8 | Dependency on Bluesky Jetstream | **Accepted**, with the documented fallbacks: notify, listReposByCollection discovery and snapshot gap recovery. |

If the owner rejects browser writes, the fallback is as follows:
- **Packages replaced:** W2-06 and W2-07 become a Worker BFF: `@atcute/oauth-node-client` and a DO-alarm outbox that reuses the Rust semantics for idempotency 409/400, sessions, CSRF and operations.
- **Restored routes:** the nine dropped routes come back, and A2, A3 (partly), A8–A13 and A11–A12 are reverted.
- **New secrets:** `ENCRYPTION_KEY`, plus a client key if the client is confidential.

All other packages are unchanged.

---

## 16. Sources (retrieved 2026-10-24 unless noted)
- DO pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- DO limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- DO SQLite storage API (`transactionSync`, 52-bit precision, multi-statement bindings, PITR): https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- DO alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Outbound connections keep DOs alive (15 min): https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- SPA routing and `run_worker_first`: https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
- Static Assets `_headers`: https://developers.cloudflare.com/workers/static-assets/headers/
- Static Assets billing: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- D1 Worker API (no BEGIN, batch): https://developers.cloudflare.com/d1/worker-api/d1-database/
- Request `redirect` behaviour: https://developers.cloudflare.com/workers/runtime-apis/request/
- DoH JSON: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
- vitest-plugin migration: https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/
- Jetstream: https://bsky.network/docs/jetstream/
- getRecord lexicon: https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/com/atproto/sync/getRecord.json
- getBlocks lexicon: https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/com/atproto/sync/getBlocks.json
- atproto specs: https://atproto.com/specs/oauth, https://atproto.com/specs/permission, https://atproto.com/specs/repository, https://atproto.com/specs/sync
- workers-rs Storage (no `transactionSync`): https://docs.rs/worker/0.8.7/worker/durable/struct.Storage.html
- npm registry version checks: https://registry.npmjs.org/
