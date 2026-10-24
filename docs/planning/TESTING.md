# Deterministic MVP test protocol

The issue manifest contains 258 named regression cases. They remain the acceptance requirements; an aggregate test count does not prove every case passed. The working backend now has core, storage, OAuth, signed repository, API, recovery and operational integration suites. [Validation evidence](../VALIDATION.md) records the executed checks, artifact results and blocked live gates. The Preact and browser suites remain unstarted behind the backend live acceptance gate.

Amended by [ADR 0004](../adr/0004-cloudflare-workers.md) §9 and §10 (Workers only). The harness wording follows A18; every exact fixture assertion below is unchanged (§9.1). [`docs/verification/ts-case-map.json`](../verification/ts-case-map.json) maps each of the 258 named cases to a TypeScript test id or to a retirement with its amendment id, and `python3 scripts/validate_case_map.py` checks it.

## How every implementation leaf must report tests

For each named case, record the exact test target, command, executed count, result, and commit. TypeScript test files live under the owning workspace package: `packages/core/test/`, `packages/atproto/test/`, `worker/test/`, `web/test/`, and `web/tests/` for Playwright; table cases can share a test with individually labelled assertions. Use `npm test` (one vitest workspace; a single target is `npm test -- --project <project> <file>`) and `npm run test:e2e` for browser suites, then `bash scripts/check-ts.sh` (A18). `scripts/report-tests.ts` turns the vitest JSON report into these per-case records. The frozen Rust oracle keeps `cargo test --locked -p <crate> --test <target> -- --nocapture` and `bash scripts/check.sh` while it exists. Never use a zero-test filtered run as evidence.

Code changes must satisfy the issue's input/action/expected-outcome rows. A mocked helper returning `Ok` does not establish that the real HTTP route, database transaction or remote record behaved correctly. Assert HTTP status **and** response schema, DB state, count of remote calls, and final verified record state where applicable. A failed assertion must preserve the runner's nonzero exit code. On Workers every HTTP test validates the response with AJV against `api/openapi.yaml`, reads Durable Object table state through `runInDurableObject`, and asserts the fixture transport's remote-call counts.

Docs-only/CI tasks must validate the artifact they own: parse schema examples, execute the CLI/script, inspect the produced binary, or exercise failure cases in a disposable checkout. Do not permanently alter production files just to demonstrate a failing check.

## Time, randomness, temporary resources

- Freeze application time at **2026-01-15T12:00:00Z** (`asOf`), independently of the host timezone and wall clock. Inject time into validators, expiry, rate limits, retries and statistics. Advance fake time directly instead of sleeping for expiry/backoff windows.
- For timestamp bounds: `now+300s` is accepted; `now+301s` is rejected. All windows include both lower and upper bounds. Public scrobbles accepted slightly in the future are excluded from statistics until `listenedAt <= asOf`.
- Production keys/nonces/session secrets use secure randomness. Tests inject deterministic randomness where exact retry/proof payload assertions need it. Do not use a fixed nonce/key outside tests. Construct signed repository fixture blocks with real cryptography and validate them with the production verifier.
- Every test file gets isolated workerd storage from `@cloudflare/vitest-plugin`, and every test uses a unique Durable Object name (A18). Avoid shared fixed ports and external network in deterministic suites. Keep asynchronous ordering explicit with test barriers rather than timing guesses; step alarms with `runDurableObjectAlarm` after advancing the injected clock.
- Fault injection exists only in test harnesses (`worker/test/**/entry.ts`, `packages/*/test-support`). Never expose production flags to skip TLS, issuer checks, DNS/IP policy, repository signatures or CID validation. For local fixtures, inject the fixture `Transport` (`packages/atproto/src/transport.ts`) at the boundary instead of disabling production verification globally; the production SafeFetch policy stays on and the fixture DoH answers with public test-net addresses.
- A restart is a Durable Object eviction that keeps its storage (A18). The restarted object must reopen the **same** storage; the test byte-compares every projection table and the responses before and after, continues a cursor issued before the restart, and asserts that the alarm resumes. Browser suites that start `wrangler dev` or a local PDS stop only the processes they created, in `finally` handlers. Do not stop unrelated services.

## Shared read-model fixture

Source: [`tests/fixtures/read_models.json`](../../tests/fixtures/read_models.json). All DIDs/handles are reserved test identities served by a controlled identity fixture. They are not accounts to contact on the public network. The namespace `com.example.atmusic` is fixture-only and never permitted for real PDS publication.

| Alias | DID | Handle |
| --- | --- | --- |
| Alice | `did:plc:aaaaaaaaaaaaaaaaaaaaaaaa` | `alice.test` |
| Bob | `did:plc:bbbbbbbbbbbbbbbbbbbbbbbb` | `bob.test` |
| Carol | `did:plc:cccccccccccccccccccccccc` | `carol.test` |

AT URI = `at://<owner DID>/com.example.atmusic.scrobble/<rkey>`. CID/revision values must be generated by the signed-repo fixture, not fabricated authoritative evidence. `r01` etc. are valid fixture record keys; production scrobble writes allocate TID record keys once.

| rkey | Owner | Artist | Track | Album | listenedAt (UTC) | State |
| --- | --- | --- | --- | --- | --- | --- |
| r01 | Alice | Björk | Jóga | Homogenic | 2026-01-15 11:00:00 | confirmed |
| r02 | Alice | `  BJÖRK  ` | `jóga` | ` HOMOGENIC ` | 2026-01-14 11:00:00 | confirmed |
| r03 | Alice | Radiohead | Weird Fishes | In Rainbows | 2026-01-08 12:00:00 | confirmed |
| r04 | Alice | Radiohead | Karma Police | OK Computer | 2025-12-16 12:00:00 | confirmed |
| r05 | Alice | Kate Bush | Running Up That Hill | omitted | 2025-01-15 12:00:00 | confirmed |
| r06 | Alice | Kate Bush | Cloudbusting | Hounds of Love | 2025-01-14 11:00:00 | confirmed |
| r07 | Alice | Radiohead | No Surprises | OK Computer | 2026-01-15 11:00:00 | confirmed |
| r08 | Alice | Radiohead | Paranoid Android | OK Computer | 2026-01-15 11:45:00 | deleted |
| r09 | Bob | Massive Attack | Teardrop | Mezzanine | 2026-01-15 11:30:00 | confirmed |
| r10 | Carol | Portishead | Roads | Dummy | 2026-01-15 11:15:00 | confirmed, externally published |

Initial confirmed follow: Alice → Bob. No initial Alice → Carol follow. A follow is the custom music collection, not a Bluesky follow. r08 never contributes to public views. Carol's scrobble must be introduced via verified external repository ingestion in federation tests, not application POST.

### Exact initial history/feed assertions

- Alice history: **r07, r01, r02, r03, r04, r05, r06**. Equal timestamps use full AT URI descending, so r07 precedes r01. Limit 2 yields pages `[r07,r01]`, `[r02,r03]`, `[r04,r05]`, `[r06]`, then no next cursor.
- Global feed: **r09, r10, r07, r01, r02, r03, r04, r05, r06**.
- Alice following feed: **r09** only. Global feed includes Alice herself; following does not implicitly include self.
- Alice followers 0; Alice following 1; Bob followers 1; Bob following 0; Carol followers/following 0.
- Known empty user tests must clear Bob's r09 first or use a fourth recordless controlled identity; the shared dataset does not represent Bob as empty.

### Exact statistics assertions

Normalize NFKC → full Unicode case-fold → trim → collapse Unicode whitespace. Use typed tuple grouping keys. Never split credited artist strings, fuzzy-match titles, or trust MBIDs as verified identity. Display spelling comes from the newest record in its group, AT URI tie-break.

| Window | Total listens | Distinct artists | Distinct tracks | Included rkeys |
| --- | --- | --- | --- | --- |
| all | 7 | 3 | 6 | r01,r02,r03,r04,r05,r06,r07 |
| 7d | 4 | 2 | 3 | r01,r02,r03,r07 |
| 30d | 5 | 2 | 4 | r01,r02,r03,r04,r07 |
| 365d | 6 | 3 | 5 | r01,r02,r03,r04,r05,r07 |

Exact ordered top-artists `(normalized key,count)`:

- all/365d: `(radiohead,3)`, `(björk,2)`, `(kate bush,2)` for all; 365d has Kate Bush **1** instead of 2.
- 7d: `(björk,2)`, `(radiohead,2)`; the count tie sorts normalized key ascending.
- 30d: `(radiohead,3)`, `(björk,2)`.

Exact top-track ordering (group key includes artist):

- all: `Björk/Jóga:2`, then count-1 groups ordered `Kate Bush/Cloudbusting`, `Kate Bush/Running Up That Hill`, `Radiohead/Karma Police`, `Radiohead/No Surprises`, `Radiohead/Weird Fishes`.
- 7d: `Björk/Jóga:2`, `Radiohead/No Surprises:1`, `Radiohead/Weird Fishes:1`.
- 30d: `Björk/Jóga:2`, `Radiohead/Karma Police:1`, `Radiohead/No Surprises:1`, `Radiohead/Weird Fishes:1`.
- 365d: `Björk/Jóga:2`, `Kate Bush/Running Up That Hill:1`, `Radiohead/Karma Police:1`, `Radiohead/No Surprises:1`, `Radiohead/Weird Fishes:1`.

Exact top-album ordering (group key includes artist):

- all: `Björk/Homogenic:2`, `Radiohead/OK Computer:2`, `Kate Bush/Hounds of Love:1`, `Radiohead/In Rainbows:1`.
- 7d: `Björk/Homogenic:2`, `Radiohead/In Rainbows:1`, `Radiohead/OK Computer:1`.
- 30d/365d: `Björk/Homogenic:2`, `Radiohead/OK Computer:2`, `Radiohead/In Rainbows:1`.
- r05 has no album and creates no unknown-album bucket.

Boundary test lower bounds: 7d = `2026-01-08T12:00:00Z`; 30d = `2025-12-16T12:00:00Z`; 365d = `2025-01-15T12:00:00Z`. Add records one second before/at/after each boundary and compare exact membership. Do not infer expectations from the production query being tested.

### Mutation expectations

- Delete r01: Alice all-time listens **6**, tracks **6**, artists **3**, Homogenic listens **1**; public history becomes r07,r02,r03,r04,r05,r06.
- Change r03's artist from Radiohead to Björk: total stays **7**; artist ranking becomes `Björk:3`, `Kate Bush:2`, `Radiohead:2` (count tie by normalized key); track identity changes, but no extra listen is inserted.
- Remove Alice → Bob: Alice following feed becomes empty; global feed and Bob's own history remain unchanged.
- Introduce two active external Carol → Bob follow records: effective Bob follower count becomes **2**, not 3. Delete one duplicate: still 2. Delete the other: back to 1.
- Deactivate Alice: hide her public profile/content/follow edge; Bob's and Carol's records remain. Reactivation must reconcile verified repo state before declaring the index current.

## Cursor assertions and limitations

Cursors must bind version, query/viewer identity, scope, initial upper tuple anchor, and last tuple under HMAC. One-bit tamper, wrong DID/scope/viewer, unsupported version or malformed base64 produce HTTP 400 `invalid_cursor` without silently resetting pagination. Cursor signing key comes from separately derived application key material; secret material is never encoded into the cursor.

For an unchanged dataset, union all pages and compare **the complete ordered AT URI list** with the hardcoded fixture sequence. Assert no duplicate URI and no omission. Insert an arrival above the anchor between pages: it must not appear until a fresh traversal. Delete a not-yet-returned record: it disappears. Updating a record's ordering timestamp can move it across the traversal boundary; the API uses current-record filtering and does not promise full snapshot isolation. Tests must assert and document that behavior rather than claiming every mutable record is returned exactly once.

## Security and async side effects

- Invalid validation, notify-abuse and form requests must leave outbox counts, remote call counts and database data unchanged. Test one valid request after the failure to prove the worker is still healthy. The v1.0 Origin, CSRF and ownership rejections no longer exist because no route reads a session (ADR 0004 §9.3).
- Server OAuth state and application sessions are dropped (A3, §9.3). The browser library owns state, PKCE, DPoP, the issuer check and refresh; SPA tests assert the requested scope, the `notify {did}` after the callback, that sign-out clears IndexedDB, and the re-auth state after a failed refresh.
- The private-access matrix is dropped with the private routes (§9.3). Every v1.1 route is public, and `scripts/validate_contracts.py` rejects any route that declares a security requirement.
- Outbox tests assert attempts, dueAt, operation state, PDS URI/payload, local row count and visible aggregate count. With injected zero jitter, retry delays are base 1s,2s,4s,… cap300s; a Retry-After of20s raises the next delay to20s. Exactly ten total attempts; no eleventh request.
- Crash test stages are explicit barriers: before send; after PDS commit before local ack; after local commit; and during deletion. Ambiguous creates use persisted rkey + getRecord + canonical digest comparison. Conflicting remote payload must never be overwritten.
- SPA outbox obligations (A12; ADR 0004 §10.4). The outbox lives in `web/src/outbox` over IndexedDB and runs in vitest with happy-dom and `fake-indexeddb`, with the frozen clock and seeded randomness injected. The tests must show:
  - the delays and attempt cap above, counted as fetches against the fake PDS;
  - each crash barrier, simulated by discarding the runner and re-instantiating it over the same IndexedDB, then asserting the same operation id and rkey, one PDS record, and the final local state;
  - ambiguous-create success (equal digest) and conflict (`remote_record_conflict`, remote payload unchanged);
  - delete with `swapRecord`, `InvalidSwap` reconciliation, and verified absence after a crash during delete;
  - PUT, DELETE, PUT intents for one follow subject running in order with separate operation ids, and unfollow deleting every matching duplicate while keeping an unrelated subject;
  - the owner overlay hiding a pending deletion while a failure stays visible;
  - one runner per DID, elected with Web Locks.
- Verification rejection tests alter one signature/CID/MST/DID invariant at a time. Compare database/checkpoint before/after and assert no invalid record enters public views. A parser that merely tolerates malformed input is insufficient.
- Rejection-matrix tables rule (ADR 0004 §7.6, §10.4). Each case changes exactly one invariant, then asserts that the projection and checkpoint tables (`scrobbles`, `follows`, `record_state`, `users`, `suppression` and `ingest_checkpoint`) are byte-identical to a dump taken before the case. Only `hints.attempts`, `hints.last_error` and `counters` may change. Each case then shows that a valid hint still applies.

## Live compatibility gates

OAuth/scrobble/federation/backend/product live tasks require dedicated identities, owned production lexicon namespace, Jetstream coverage of the required external PDSs (A6) and a public HTTPS callback on a deployed Worker origin. Supply credentials through secure settings, never chat or fixtures. Different independently operated PDS endpoints are required for the live federation gate.

Each live command must record: commit, Worker version id and bundle SHA-256 (A19), test date, PDS/relay implementation/version where available, expected DID/AT URI, API result, independently fetched verified record evidence, monotonic lag, and cleanup outcome. Do not publish tokens/codes/cookies/private keys. Missing prerequisites produce a nonzero **blocked** result and list the missing names; they are not skipped successes. Live evidence is version-specific; fixture-only tests never satisfy these gates.

## Scaffold evidence versus future evidence

Workers commands (A18):

```sh
npm ci
npm test
npm run test:e2e
bash scripts/check-ts.sh
python3 scripts/validate_contracts.py
python3 scripts/validate_case_map.py
```

`bash scripts/check-ts.sh` runs typecheck, lint, the vitest workspace through `scripts/report-tests.ts` (which fails a zero-test run), the contract and case-map validators and the production bundle guard. `python3 scripts/validate_case_map.py --check-tests` additionally requires every mapped test file and name to exist; it fails until the wave packages land, and W7-01 enforces it.

The Rust candidate is the frozen golden-vector oracle (ADR 0004 §12). Until W7-02 retires it, its commands still validate the oracle only:

```sh
bash scripts/check.sh
cargo build --locked -p atmusic-server
python3 scripts/smoke.py target/debug/atmusic
```

The musl release build and its packaged smoke test are dropped (A19, §9.3). None of these commands validates live OAuth, Jetstream coverage, external PDS writers or the deployed Worker; those remain live gates.
