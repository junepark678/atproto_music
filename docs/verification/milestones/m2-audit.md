# M2 audit evidence record — OAuth, identity, sessions, and interoperability

## Disposition, scope, and provenance

**M2 is substantially implemented, but is not ready for acceptance or closure. All 17 issues recorded here remain OPEN: #6–10 and #50–61.** This record neither closes issues nor amends their published acceptance contracts. Remaining work includes autonomous deterministic implementation/evidence work and contract reconciliation, not merely operator credentials.

The authoritative audit source for this record is **`/tmp/goal-audit-M2.md`**, “Agent 2 — read-only M2 audit.” This document preserves its findings in the repository rather than requiring that temporary file to remain available. Repository documentation was inspected only to clarify context: `docs/verification/README.md`, `docs/verification/implementation-agent-13.md`, `docs/verification/oauth-live.md`, and relevant portions of `docs/adr/0005-local-node-host-and-compat-apis.md`. Those clarifications do not constitute new test execution or new acceptance evidence. Issue descriptions below are descriptive subjects, not assertions of exact GitHub title text.

**M7 is explicitly excluded.** Other milestones mentioned by the source are not assessed here. This record concerns M2 and its dependencies only.

### Evidence integrity and limitations

- The source reports HEAD **`29453f8` (`wave 4: integrate`)** and an **already dirty checkout**. This is local/dirty-tree evidence, not evidence from a clean checkout, merged revision, hosted CI, or release-bound live run. The checkout used to write this record also contains prior modifications; it is not represented as clean.
- The source read the milestone and M2 issue bodies/comments from GitHub and found the M2 issues still open. It reports that the inspected issue bodies retain Rust ownership/test contracts without published Node amendments. This record preserves that status; it does not independently refresh or mutate GitHub.
- The source's M2-specific uncommitted improvement is principally the **#58 revocation-HTTP-500 regression**, its case-map entry, and wave declaration—not a new OAuth implementation.
- Retained final local evidence reports **904 passed, 224 files, zero failed/skipped/todo** in `work/verification/implementation-agent-13/fix1-ts-test-report.json`. These are aggregate retained results, not per-issue pass counts or fresh acceptance results.
- The source reports a read-only comparison in which **204/204 current production-source hashes matched** `worker/dist/node/main.inputs.json`. Bundle SHA-256 prefixes matched the retained final ledger: `main.mjs` **`c612d600cb2e…`**, `e2e.mjs` **`b8665d17fd1a…`**. Prefixes are not full release checksums. Matching production sources does not make uncommitted tests/docs clean or establish release provenance.
- No build-producing, test, deployment, or live command was rerun to create this record. The source likewise did not rerun artifact-producing test/build/live commands. No credentials were used; no production/test code or GitHub state was changed for this record.
- Paths and line references below are those supported by the audit source. Line references are audit-time locators and can move. Historical Rust/browser tests and structural case-map coverage are not equivalent to current-Node integration evidence.

### Reading the categories

Each issue separates **tested deterministic behavior** (retained executed evidence interpreted by the source), **remaining deterministic gap** (including missing regression evidence, not necessarily a confirmed implementation defect), **operator/live blocker**, and **contract/doc drift**. “None confirmed” is bounded by the inspection; it is not a universal proof of completeness.

Every leaf inherits the outstanding external-PDS/browser acceptance gate in **#61 / #6**. That inherited gate does not reclassify missing autonomous tests, live-driver implementation, or documentation repair as operator-only work.

## Milestone and coordination issues

### #6 — M2 milestone acceptance

**Status: OPEN — not ready for acceptance or closure.**

- **Tested deterministic behavior:** The current Node BFF has substantial identity, protected transport, confidential OAuth, encrypted storage, session/CSRF, logout, and fixture coverage, detailed in #50–60. The aggregate local receipt and source-hash comparison above support a substantial implementation, not milestone completion. The uncommitted #58 outage regression is included only as scoped local evidence.
- **Remaining deterministic gap:** Complete the initiation-time discovery assertions (#52), stalled-PAR cleanup (#54), exact state/nonce negative cases (#55), published refresh-race cardinality (#56), independent-fixture token rejection (#59), and full Node HTTP negative matrix (#60). Resolve #50 admission semantics. Implement a usable current-Node live OAuth driver and evidence contract (#61).
- **Operator/live blocker:** No accepted current-Node external/browser run is established. Public HTTPS metadata/JWKS, protected credentials, dedicated independent-PDS identities, owned publication namespace, independent observations and cleanup, and exact release binding remain prerequisites under #61.
- **Contract/doc drift:** Rust/public-client/Workers contracts and stale case-map entries remain mixed with current Node BFF behavior. State/session lifetimes, scopes, metadata/client authentication, callbacks, cookies, errors, redirect policy, and revocation interpretation require explicit reconciliation. Do not infer closure from the 904-test receipt, structural mapping counts, historical passes, or fail-closed live refusal tests.
- **Evidence paths:** `docs/verification/implementation-agent-13.md` (including both addenda); `docs/verification/ts-case-map.json`; `docs/verification/oauth-live.md`; `docs/verification/live-evidence.json`; `work/verification/implementation-agent-13/fix1-ts-test-report.json`; leaf evidence below.

### #7 — Identity and protected discovery coordination

**Status: OPEN.**

- **Tested deterministic behavior:** Identity resolution, DID/PDS validation, verified-handle round trips and cache rotation are implemented (#50). Node DNS pinning, mixed-answer rejection, rebinding protection, bounded HTTPS requests, and protected production composition are exercised (#51).
- **Remaining deterministic gap:** Reconcile the published spoofed-handle rejection with stable-DID/null-handle behavior and establish the intended OAuth-admission outcome (#50). No missing pinning implementation was confirmed in #51; do not invent a transport implementation blocker where the finding is evidence/contract correction.
- **Operator/live blocker:** Inherits #61's external identity/PDS/browser acceptance gate. The autonomous handle-admission and mapping work is not blocked on live credentials.
- **Contract/doc drift:** Published `handle_mismatch` rejection is not the tested null-handle outcome. Redirect and Workers rebinding notes do not describe the current Node transport. Correct those contracts/notes rather than crediting unlike behavior as the same case.
- **Evidence paths:** `packages/atproto/src/identity/{handle,resolver,did-doc}.ts`; `packages/atproto/test/identity.test.ts`; `worker/src/node/{pinned-transport,policy-fetch}.ts`; `worker/test/node/{pinned-transport,policy-fetch,features}.test.ts`; `docs/verification/ts-case-map.json`, `M2.1.2/*`.

### #8 — OAuth protocol and client coordination

**Status: OPEN.**

- **Tested deterministic behavior:** Confidential Node metadata/JWKS, ES256 `private_key_jwt`, PAR/S256, sealed state material, callback binding, issuer/subject checks, and successful nonce retry exist (#52–55).
- **Remaining deterministic gap:** Establish the complete initiation-time metadata chain and mismatch outcome (#52), stalled-PAR deadline cleanup (#54), exact revised state-expiry boundary, endless-nonce termination with no session, and changed DPoP `jti` (#55). These are current-Node evidence gaps, not interchangeable with historical Rust or lower-layer tests.
- **Operator/live blocker:** Publicly reachable metadata/JWKS, securely provisioned signing material, actual PDS consent/grants and write privileges, and browser callbacks remain unverified. The current live-driver mismatch must be fixed independently of operator inputs (#61).
- **Contract/doc drift:** Published metadata/scopes and public-client assumptions differ from the confidential BFF; state TTL is 600 seconds, response field is `authorizeUrl`, and current error vocabulary differs. Primary mappings still credit retired or narrower boundaries.
- **Evidence paths:** `worker/src/bff/{identity-adapter,oauth-client,client-metadata,keyset,oauth-stores}.ts`; `worker/src/http/{auth,oauth-docs}.ts`; `worker/test/node/bff/oauth-client.test.ts`; `worker/test/node/http/auth.test.ts`; `docs/adr/0002-oauth.md`; ADR 0005 §5.2–5.4; `docs/verification/ts-case-map.json`.

### #9 — Encrypted storage, sessions, and logout coordination

**Status: OPEN.**

- **Tested deterministic behavior:** Row-bound encrypted OAuth storage, secret scans, serialized refresh and close/reopen persistence, hashed secure-cookie sessions, Origin/HMAC-CSRF checks, local logout, journaling, and the local dirty-tree revocation-outage regression are covered (#56–58).
- **Remaining deterministic gap:** Current Node refresh-race evidence uses two restores, not the published ten (#56). Do not promise durable rotated-token replacement during storage failure: degradation/write-behind can require reauthentication after process loss. The source confirms no additional accepted-Node session-policy gap for #57. #58 still needs clear operator-facing revocation-outage/retry semantics.
- **Operator/live blocker:** Real browser/proxy cookie behavior, live refresh/rotation, and independently observed upstream revocation remain unverified. Local logout success does not prove upstream token invalidation.
- **Contract/doc drift:** Seven-day absolute non-sliding published sessions conflict with 30-day sessions renewed after 24 hours. Browser mappings and the obsolete fourteen-day note remain. A local outcome named `revoked` is not upstream-success evidence; there is no durable remote-revocation retry queue.
- **Evidence paths:** `worker/src/crypto/box.ts`; `worker/src/bff/{oauth-stores,sessions,csrf,guard,oauth-client}.ts`; `worker/src/http/auth.ts`; `worker/test/node/bff/{oauth-client,oauth-stores,sessions,csrf}.test.ts`; `worker/test/node/http/auth.test.ts`; ADR 0005 §5.6.

### #10 — Fixtures, security integration, and live verification coordination

**Status: OPEN.**

- **Tested deterministic behavior:** Test-only AS/PDS fixtures exercise real cryptographic proofs/assertions and token lifecycles; actual Node HTTP composition, temporary SQLite, callback/session rejection, owner isolation, logout, and secret-free responses/logs have coverage (#59–60). Historical live helpers have deterministic refusal/redaction regressions (#61).
- **Remaining deterministic gap:** Add independent-fixture token rejection, account for current Node fixture fault controls, reproduce the published wrong-issuer/wrong-DID/corrupted-proof cases at the actual HTTP boundary with zero-session/zero-accepted-write effects, and migrate the live driver/inventory to the Node contract. The subprocess recovery journey is not refresh-rotation-across-process-restart proof.
- **Operator/live blocker:** No accepted live run is recorded. Independent PDS/browser observations, disposable create/delete with independent verification/cleanup, and release-bound provenance remain necessary after tooling is repaired.
- **Contract/doc drift:** Fixture documentation and primary case mappings retain Rust/browser assumptions. Public-client live scripts and incompatible inventory schema expectations cannot establish current Node acceptance.
- **Evidence paths:** `packages/atproto/test-support/{fake-oauth-as,fake-pds,router-transport}.ts`; `packages/atproto/test/fake-upstreams.test.ts`; `worker/test/node/bff/oauth-world.ts`; `worker/test/node/http/{auth,writes}.test.ts`; `scripts/test/node-recovery.test.ts`; `scripts/live/{oauth_check.py,workers_oauth_check.ts,pds_compat_check.ts,live-gate.ts}`; `docs/verification/live-evidence.json`.

## Leaf issues

### #50 — Identity resolution

**Status: OPEN.**

- **Tested deterministic behavior:** DNS TXT and HTTPS handle resolution; `did:plc` and hostname-level `did:web`; DID-document, key, and PDS validation; verified-handle round trips; five-minute positive caching; fresh resolution after rotation. Current tests deliberately preserve the DID while returning `handle: null` for a mismatched verified handle.
- **Remaining deterministic gap:** The published `spoofed_handle` case requires `handle_mismatch` and no authenticated user. OAuth `authorize()` resolves the supplied handle to a DID and then discovers using that DID; it does not require the original supplied handle to equal the document's verified handle. The published rejection outcome is not preserved. Either retain that rejection contract and test OAuth admission accordingly, or explicitly reconcile stable-DID/null-handle admission. This discrepancy is **not evidence of a demonstrated account-takeover vulnerability**.
- **Operator/live blocker:** Inherits external identity/PDS/browser acceptance under #61/#6. Live credentials are not required to decide and test the deterministic admission contract.
- **Contract/doc drift:** Null-handle identity resolution must not be represented as a passing `handle_mismatch`/no-user rejection. Published issue semantics and current tests differ.
- **Evidence paths:** `packages/atproto/src/identity/{handle,resolver,did-doc}.ts`; `packages/atproto/test/identity.test.ts:585`; `worker/src/bff/oauth-client.ts:515–565`; `worker/test/ingest/identity-cache.test.ts`; `worker/test/read/resolve.test.ts`.

### #51 — SSRF and bounded outbound requests

**Status: OPEN.**

- **Tested deterministic behavior:** Node transport checks every DNS answer and connects only to a checked address; mixed public/private answers fail closed. Tests exercise HTTPS/TLS validation, IP-literal/local-host restrictions, ten-second deadlines, body bounds, redirect refusal, typed failures, explicit rebinding protection, and production injection of protected transport with global-fetch fallback blocked.
- **Remaining deterministic gap:** No missing pinning implementation was confirmed. The source identifies evidence/contract correction as the important remaining work, not an established transport-code defect.
- **Operator/live blocker:** Inherits #61/#6's external acceptance gate. No separate missing deterministic pinning capability is established as an operator dependency.
- **Contract/doc drift:** GitHub permits up to three redirects; current policy refuses every redirect. `M2.1.2/*` case-map notes still claim Workers cannot pin and describe a rebinding residual, despite implemented and tested Node pinning.
- **Evidence paths:** `worker/src/node/{pinned-transport,policy-fetch}.ts`; `worker/test/node/{pinned-transport,policy-fetch,features}.test.ts`; `packages/atproto/test/{safe-fetch,url-policy,doh}.test.ts`; `docs/verification/ts-case-map.json`, `M2.1.2/*`.

### #52 — PDS / issuer discovery

**Status: OPEN.**

- **Tested deterministic behavior:** Discovery uses the application's identity adapter and protected fetch path. Missing PAR/S256 is rejected before state insertion. A callback DID/PDS identifying another authorization server is rejected and its new tokens revoked.
- **Remaining deterministic gap:** The mapped `valid_chain` test proves DID/key/PDS resolution, not the full OAuth metadata chain. The mapped `issuer_mismatch` test proves callback-time inconsistency, not the published initiation-time rejection. Add direct initiation-time chain and mismatched-metadata assertions; do not substitute callback coverage for that boundary.
- **Operator/live blocker:** External PDS/issuer interoperability remains under #61/#6. The direct initiation-time regressions are autonomous work.
- **Contract/doc drift:** Current safe API errors are `oauth_upstream` / `oauth_binding_mismatch`, not the original named error vocabulary. The mapping overstates equivalence between initiation and callback cases.
- **Evidence paths:** `worker/src/bff/{identity-adapter,oauth-client}.ts`; `worker/test/node/bff/oauth-client.test.ts:168,310,547`; `docs/verification/ts-case-map.json`, `M2.1.3/*`.

### #53 — Maintained dependencies, metadata, and scopes

**Status: OPEN.**

- **Tested deterministic behavior:** Confidential Node client, ES256 `private_key_jwt`, dynamic metadata/public-only JWKS, configured-origin URLs, key rotation, and collection-specific scopes are implemented/tested. Dependency/protocol decisions are documented. `transition:generic` is explicit and off by default, not a silent fallback.
- **Remaining deterministic gap:** No missing metadata/JWKS implementation was confirmed. Actual external grants and write privileges remain unproven; fixture success cannot supply that evidence.
- **Operator/live blocker:** Publicly reachable metadata/JWKS, protected signing credentials, and real-PDS grant verification are required, together with the shared #61 gate.
- **Contract/doc drift:** Current scopes cover scrobble, follow, settings, and love; published M2 wording specifies two music collections. Several primary mappings still credit static public-client generation or browser OAuth instead of dynamic BFF metadata/JWKS tests.
- **Evidence paths:** `worker/src/bff/{client-metadata,keyset}.ts`; `worker/src/http/oauth-docs.ts`; `worker/test/node/http/auth.test.ts:536`; `worker/test/node/bff/oauth-client.test.ts:235,339`; `docs/adr/0002-oauth.md`; ADR 0005 §5.2–5.4.

### #54 — Auth start, PKCE, state, and PAR

**Status: OPEN.**

- **Tested deterministic behavior:** Origin enforcement precedes state/PAR; login cookie binds state; PKCE uses S256; verifier/DPoP material is sealed; confidential-client assertion, sign-in policy, rate limiting, and cleanup after PAR HTTP 400/503 are covered.
- **Remaining deterministic gap:** Current Node evidence lacks a stalled PAR through its deadline followed by state cleanup. Generic transport timeout coverage and historical Rust `par_timeout_cleanup` do not prove this complete current-Node failure path.
- **Operator/live blocker:** Real consent/PAR/browser interoperability remains under #61/#6; stalled-PAR cleanup is independently testable without operator credentials.
- **Contract/doc drift:** Five-minute state became **600 seconds** under ADR 0005. Current auth-start response is `authorizeUrl`, not the legacy helper's `authorizationUrl`.
- **Evidence paths:** `worker/src/http/auth.ts`; `worker/src/bff/{oauth-client,oauth-stores}.ts`; `worker/test/node/bff/oauth-client.test.ts:339,410`; `worker/test/node/http/auth.test.ts:287,581`.

### #55 — Callback binding and nonce retry

**Status: OPEN.**

- **Tested deterministic behavior:** Single-use state, replay/expiry rejection, login-cookie binding, issuer/subject checks, fresh identity binding, successful nonce challenge/retry, and explicit transient-resolution handling are covered.
- **Remaining deterministic gap:** Expiry coverage uses **600,001 ms**, not the revised exact just-before/at boundary. Challenge→success coverage does not establish endless-challenge termination with no session. Tests check a changed nonce but not explicitly a changed DPoP `jti`. The installed library has one retry, so the source identifies principally missing application-level regression evidence, not a confirmed unbounded-retry implementation.
- **Operator/live blocker:** Real external callback and nonce behavior remains under #61/#6. Boundary and repeated-challenge tests do not depend on live access.
- **Contract/doc drift:** Published **299/300-second** boundary conflicts with the accepted **600-second** storage TTL; success-path retry must not be mapped as the complete published negative case.
- **Evidence paths:** `worker/src/bff/oauth-client.ts:571–665`; `worker/src/bff/oauth-stores.ts:68`; `worker/test/node/bff/oauth-client.test.ts:130,428,462`; `node_modules/@atproto/oauth-client/dist/fetch-dpop.js`.

### #56 — Encryption and refresh serialization

**Status: OPEN.**

- **Tested deterministic behavior:** AES-256-GCM/HKDF, random nonces, row-bound AAD, encrypted tokens/private DPoP material, raw-file secret scans, wrong-owner rejection, serialized refresh, rotated-token persistence across close/reopen, `invalid_grant`, and degraded write-behind behavior are covered.
- **Remaining deterministic gap:** The Node race regression runs **two concurrent restores**, not the published **ten**. The historical Rust oracle is not production-Node evidence for that cardinality. Close/reopen persistence is supported; do not extend it into proof of refresh rotation across a subprocess restart or guaranteed persistence during storage failure.
- **Operator/live blocker:** Actual external refresh grants/rotation remain under #61/#6. The race-cardinality regression is autonomous work.
- **Contract/doc drift:** `refresh_restart` still primarily maps to a browser expired-session test despite stronger Node store coverage. Accepted write-behind differs from unconditional durable replacement: disk failure raises degradation, and process loss before recovery can require reauthentication. Do not describe that failure window as guaranteed rotation durability.
- **Evidence paths:** `worker/src/crypto/box.ts`; `worker/src/bff/oauth-stores.ts`; `worker/test/node/{crypto,secrets}.test.ts`; `worker/test/node/bff/oauth-client.test.ts:191,499`; `worker/test/node/bff/oauth-stores.test.ts`.

### #57 — Sessions and CSRF

**Status: OPEN.**

- **Tested deterministic behavior:** Hash-only random session tokens; `__Host-`, Secure, HttpOnly, SameSite=Lax, Path=/ cookies; exact Origin and HMAC-CSRF validation; no renewal/write on rejected requests; cross-owner isolation; expiry and renewal boundaries are covered.
- **Remaining deterministic gap:** None confirmed for the **accepted Node policy** in this inspection. This does not mean the published seven-day/non-sliding requirement was tested and passed.
- **Operator/live blocker:** Real browser/proxy HTTPS cookie behavior remains unverified, in addition to #61/#6's shared external gate.
- **Contract/doc drift:** GitHub requires a **seven-day absolute, non-sliding** lifetime. Node implements **30 days with renewal after 24 hours** under ADR 0005 §5.6. The case map still credits browser session behavior and an obsolete fourteen-day public-client note. Explicitly reconcile the contract; do not label the policies equivalent.
- **Evidence paths:** `worker/src/bff/{sessions,csrf,guard}.ts`; `worker/test/node/bff/{sessions,csrf}.test.ts`; `worker/test/node/http/auth.test.ts`; ADR 0005 §5.6.

### #58 — Logout and revocation

**Status: OPEN — includes an uncommitted local regression, not release acceptance.**

- **Tested deterministic behavior:** Local session removal and cookie clearing, subsequent 401, revocation journaling, supported/unsupported endpoint handling, preservation of shared sessions for remaining credentials, and concurrent re-sign-in protection are covered. The source specifically confirms the new HTTP-500 regression checks local logout, sanitized logging, and **the upstream fixture session remaining active**.
- **Remaining deterministic gap:** No additional missing logout-code behavior is established by this finding. The outage/retry policy still needs an operator-facing statement: revocation is best effort, local deletion completes, and **there is no durable remote-revocation retry queue**. The revocation journal must not be confused with such a queue.
- **Operator/live blocker:** Actual upstream revocation must be independently observed during #61's live run. Local deletion, cookie clearing, subsequent local 401, and a local result named `revoked` are not proof of upstream success.
- **Contract/doc drift:** The library swallows endpoint errors; `revoked` can therefore be misleading operationally. The implementation record warns about it, but operator documentation must be equally clear. `logout_local` still primarily maps to the retired browser/IndexedDB flow.
- **Evidence paths:** `worker/src/http/auth.ts`, `postAuthLogout`; `worker/src/bff/oauth-client.ts:492–507`; `worker/test/node/http/auth.test.ts:411,488`; `worker/test/node/bff/oauth-client.test.ts:521,674,715`; `node_modules/@atproto/oauth-client/dist/oauth-server-agent.js:34`; `docs/verification/implementation-agent-13.md` and `docs/verification/ts-case-map.json`.

### #59 — OAuth/PDS fixtures

**Status: OPEN.**

- **Tested deterministic behavior:** Test-only AS/PDS fixtures support real ES256 assertions/proofs, metadata/JWKS fetching, nonce rotation, rotating refresh tokens, revocation, DPoP-only PDS writes, record operations, and fault controls. Production bundle guards exclude fixture inputs.
- **Remaining deterministic gap:** The exact **two-independent-fixture token rejection** case is not established by the current primary mapping, which only proves repository-signature isolation. Add the cross-AS/PDS token test and current Node fault-control accounting. Fixture capabilities alone do not prove every published fault matrix case.
- **Operator/live blocker:** Fixtures cannot replace independent real-PDS acceptance under #61/#6. No live credential is needed to add the missing deterministic isolation case.
- **Contract/doc drift:** Case-map notes incorrectly say server-token isolation was retired and nonce/refresh modes belong to browser OAuth. `tests/fixtures/oauth/README.md` documents the Rust fixture rather than the current Node one.
- **Evidence paths:** `packages/atproto/test-support/{fake-oauth-as,fake-pds,router-transport}.ts`; `packages/atproto/test/fake-upstreams.test.ts`; `worker/test/node/bff/oauth-world.ts`; `scripts/check-node-bundle.ts`; `docs/verification/ts-case-map.json`, `M2.4.1/*`; `tests/fixtures/oauth/README.md`.

### #60 — HTTP security integration matrix

**Status: OPEN.**

- **Tested deterministic behavior:** Actual Node HTTP composition with temporary SQLite covers login-cookie confusion, replay, expiry, denial, policy rejection, logout, owner-bound operation access, and secret-free logs/public responses. Refresh persistence and web-session survival have separate evidence.
- **Remaining deterministic gap:** The mapped HTTP matrix does not reproduce the complete published **wrong-issuer/wrong-DID/corrupted-proof** matrix with HTTP outcomes, zero-session effects, and zero accepted writes. Service-level and fake-upstream cases do not substitute for that integration boundary. The new subprocess recovery journey does **not** itself prove refresh rotation across process restart.
- **Operator/live blocker:** External browser/PDS outcomes remain under #61/#6. Completing the exact local HTTP matrix does not require those operator prerequisites.
- **Contract/doc drift:** Current mappings and recovery descriptions must distinguish narrower service/fixture checks, close/reopen store persistence, web-session survival, and actual subprocess refresh-rotation evidence. Historical Rust's exact matrix is reference evidence, not a current Node pass.
- **Evidence paths:** `worker/test/node/http/auth.test.ts:618,661,706`; `worker/test/node/http/writes.test.ts`; `worker/test/node/bff/{oauth-client,oauth-stores}.test.ts`; `worker/test/node/journey/secret-logs.test.ts`; `scripts/test/node-recovery.test.ts`; historical exact matrix in `crates/server/tests/oauth_security.rs`.

### #61 — Live interoperability

**Status: OPEN — blocked by both autonomous tooling work and external/operator prerequisites.**

- **Tested deterministic behavior:** Historical live helpers and deterministic refusal/redaction regressions exist. The inventory records **no accepted live run**. Refusal/redaction regressions prove local guard behavior, not consent, refresh, revocation, or record lifecycle interoperability.
- **Remaining deterministic gap:** There is no reconciled current-Node OAuth live driver/evidence contract. Migrate the driver and inventory/verifier expectations before treating credential supply as sufficient. `pds_compat_check.ts` is a read-only PDS/proof compatibility check; it does not sign in with OAuth or create/delete disposable records. The historical schema-v1 inventory cannot satisfy the legacy Worker schema-v2 verifier, much less bind a current Node release.
- **Operator/live blocker:** A public HTTPS BFF with reachable metadata/JWKS; securely supplied encryption/signing material; dedicated identities on independent PDSs; an owned publication namespace; coverage evidence; real consent, grant, refresh, rotation, and revocation observations; disposable record lifecycle with independent verification and cleanup; and exact release binding are still required. None is established by the retained local aggregate test receipt or source-hash match.
- **Contract/doc drift:** `scripts/live/oauth_check.py` expects public-client `none`, the old callback, two collection scopes, `authorizationUrl`, and `atmusic_session`. Node serves confidential metadata/JWKS, `/oauth/callback`, four collection scopes, `authorizeUrl`, and `__Host-atmusic_session`. `workers_oauth_check.ts` expects browser-visible OAuth/token exchanges and a public client. The published live instructions and inventory lineage are not a usable current-Node acceptance contract.
- **Evidence paths:** `docs/verification/oauth-live.md`; `scripts/live/{oauth_check.py,workers_oauth_check.ts,pds_compat_check.ts,live-gate.ts}`; `docs/verification/live-evidence.json`; `work/verification/implementation-agent-13/fix1-check-ts-final.log`; `work/verification/implementation-agent-13/agent2-live-blocked.log`.

## Prior commands and retained results: attribution only

The audit source explicitly lists these as **executed read-only during that prior audit**:

```sh
git status --short
git diff --stat
git diff -- worker/test/node/http/auth.test.ts docs/verification/ts-case-map.json
git diff --check
gh api repos/junepark678/atproto_music/milestones
gh issue view <number> --json number,title,body,state,comments
```

`<number>` is the source's placeholder, not a claim of one literal invocation. The source reports open issue status and the dirty checkout, but does not provide exact stdout or an individual exit status for every command; none is invented here. It also reports parsing retained test-report JSON and recomputing source hashes without writes, but gives no exact command for those operations. Their supported results are recorded in the provenance section.

The source lists `npx vitest run --project atproto …`, `npx vitest run --project worker-node …`, `bash scripts/check-ts.sh`, and `python3 scripts/validate_case_map.py --check-tests --node-wave 4` as **commands for a subsequent authorized verification run, not executed in that audit**. They are not receipts for this record and were not rerun here. The reported **904 passed / 224 files / zero failed/skipped/todo** is attributed to the retained report, not to a newly executed command. Likewise, naming the blocked-live log is not a claim of a fresh live attempt or an invented exit code.

## Follow-up and acceptance boundary

1. Migrate the OAuth live driver/inventory to the confidential Node BFF contract and refresh the semantic case map.
2. Complete the missing current-Node negative and exact-boundary integration evidence; preserve the distinction between a missing regression and a confirmed defect.
3. Explicitly reconcile published issue contracts, ADR policy, primary evidence mappings, and operator-facing limits, especially handle admission, state/session lifetimes, scopes, redirects, and best-effort revocation.
4. Obtain genuine independent-PDS/browser observations with verified disposable-write cleanup and exact release provenance.

These steps are follow-up requirements, not work performed by this documentation record. **All 17 issues remain open. M7 is excluded.** Historical Rust/browser passes, structural mapping totals, blocked-live refusals, dirty-tree tests, and production-source hash matches alone do not authorize closure.

## M2 follow-up deterministic evidence — 2026-10-28

This addendum records current-Node follow-up regressions for issue #52's OAuth discovery chain, issue #54's named `par_failure`, issue #55's named `expired_and_replay` / `nonce_retry`, issue #56's named `refresh_race`, issue #59's named `fixture_isolation`, and part of issue #60's HTTP security matrix. The original audit findings above are superseded only for initiation-time discovery, stalled-PAR timeout cleanup, Node-policy state boundary, nonce `jti`/retry exhaustion, concurrent refresh cardinality, cross-AS/PDS token isolation, and current HTTP-boundary coverage for wrong issuer/subject and corrupted DPoP; other #52–60/M2 gaps remain.

- Updated `worker/test/node/bff/oauth-client.test.ts` case `PAR HTTP failures and a stalled request surface oauth_upstream and leave no oauth_states row or late PAR` to cover both the existing HTTP 400/503 refusal paths and a PAR request held past the injected deadline. Before the timeout, the test observes the sealed-state row; after timeout it asserts `oauth_upstream` / HTTP 502 with a `TransportError(timeout)` cause, zero persisted states, no session, and no PAR reaching the AS even when the held fixture request is released after the timeout.
- `worker/test/node/bff/oauth-world.ts::gatedService` now refuses to forward a released held `Request` if its signal was already aborted. This keeps the negative control faithful to request cancellation and prevents an artificial post-deadline request from reaching the fake AS.
- Updated the `M2.2.2/par_failure` primary traceability target in `docs/verification/ts-case-map.json` and the N2-03 declared test target in `docs/planning/node-waves.json`. The GitHub case ID and requirement are unchanged; no extra case or new issue was created.
- Added `worker/test/node/bff/oauth-client.test.ts` case `authorization start follows identity-to-PDS-to-AS metadata and refuses an AS that does not protect the PDS`. It observes requests to the PDS OAuth protected-resource metadata and the advertised AS metadata before PAR; after the AS metadata is changed to list an unrelated protected resource, a fresh client rejects sign-in before adding another state or issuing another PAR. `M2.1.3/valid_chain` now points primarily to this end-to-end discovery test and also retains the existing DID-document/signing-key/PDS test. This is deterministic metadata-path evidence, not external issuer interoperability.
- Reworked `M2.2.3/expired_and_replay`: a replay remains rejected before a second token request; at **599,999 ms** the state is still accepted by the callback's explicit `access_denied` branch (so fake-AS authorization-code expiry cannot mask state TTL), and at **600,000 ms** the state is `state_expired`, consumed, and refused before token exchange. This proves the accepted Node 600-second boundary, **not** the published issue's distinct 299/300-second boundary; that contract conflict still requires owner reconciliation.
- Expanded `M2.2.3/nonce_retry`: the successful token retry now asserts both a changed DPoP nonce and a changed `jti`. The same case rotates the AS nonce before each token request, confirms exactly two HTTP 400 challenge responses (the initial request plus one permitted retry), and asserts safe failure, no leaked state/new session, with the prior session unchanged. This establishes the current library's retry limit under the fixture, not real-AS behavior.
- Updated `worker/test/node/bff/oauth-client.test.ts` case `ten concurrent restore() calls on an expired session send one refresh request and all use the new token` for #56 `refresh_race`: ten simultaneous restores issue exactly one successful token refresh, all ten returned session handles successfully use the rotated token at the PDS, and the stored session matches it. The `M2.3.1/refresh_race` case-map target and N2-03 declared test target were updated without changing the issue's case ID or scope. This proves fixture concurrency/cardinality, not process-restart token rotation or external refresh behavior.
- Added #59's `M2.4.1/fixture_isolation` evidence: the `oauth-client.test.ts` regression uses two fake AS/PDS pairs, separate Alice/Bob repository signing keys, and hosts both repositories at both fixture PDSs. Each account's own PDS accepts its DPoP token (including an initial nonce challenge); the other AS/PDS rejects that token with 401 and the attempted cross-server record is absent. `oauth-world.ts::addUser` now allows a test-only signing-key override, and the case map replaces the obsolete A3 retirement claim while retaining the original signed-repository key-isolation test as additional evidence. This is in-memory fixture isolation, not a claim about independently operated production PDSs.
- Refreshed `M2.3.1/refresh_restart` to point to `worker/test/node/bff/oauth-stores.test.ts` instead of the retired browser banner test. The Node test rotates a token, closes/reopens the same SQLite file, constructs a new OAuth client, and proves the next refresh uses the persisted rotated token; the `invalid_grant` test is additionally mapped for session removal/reauth state. This is local close/reopen evidence, not a child-process restart or live PDS result.
- Expanded the current Node HTTP route matrix for #60 in `worker/test/node/http/auth.test.ts`: the same endpoint-level test now covers replayed/expired/unknown state, AS denial, wrong issuer before token exchange, wrong subject after exchange with the wrong-subject token revoked, and a transport-mutated malformed DPoP proof at the token endpoint. Each failure leaves only Alice's pre-existing local session, creates no Bob account/session, and produces no accepted PDS write. The malformed proof maps to the API's documented HTTP **502 `oauth_upstream`**, whereas published issue #60 says expected 4xx for each bad-proof matrix case; this is a real contract/API status difference and remains for owner reconciliation, not silently counted as published-contract pass. The case-map target was updated and still includes the separate callback cookie-confusion regression.
- Exact focused receipts after these changes: `npx vitest run --project worker-node worker/test/node/bff/oauth-client.test.ts` — **exit 0, 22 tests passed, 1 file**; `npx vitest run --project worker-node worker/test/node/http/auth.test.ts -t 'stale state, AS denial'` — **exit 0, 1 test passed**. Isolated OAuth regressions also passed for initiation-time discovery, DPoP nonce retries, the 600 s state boundary, and independent OAuth/PDS isolation (1 test each). An earlier authoring run with a separate temporary PAR test is not counted as final evidence.
- All results in this addendum are deterministic local fixture evidence only. They are not real PDS/issuer/browser acceptance, hosted CI, a release-bound live observation, or evidence that unrelated M2 contracts have been reconciled. All M2 GitHub issues remain open; M7 remains excluded.

### Refreshed full local TypeScript gate — 2026-10-28

After the M2 additions and traceability refresh, `bash scripts/check-ts.sh` completed successfully on the still-dirty working tree: **224 test files, 908 passed, 0 failed/skipped/todo**. Typecheck and Biome passed; the full Vitest suite passed; API/lexicon contracts passed; the 258-case map and 16 Python case-map regressions passed; the production bundle guard passed; Node server build `--check` and Node bundle guard passed. The Node candidate build reported base SHA `29453f8e8763083a3e3d7b10d5090285ef2f9d63`, with `main.mjs` SHA-256 prefix `eb1409eef3d80aa1…` and `e2e.mjs` prefix `41c49befe28786b0…`. These are locally emitted dirty-tree check artifacts, not release provenance, hosted CI, or clean-checkout evidence.

During that gate, the test's nested case-map check exposed stale copies of several renamed M2 case titles in `ADR 0005 §20.2` and `docs/planning/AMENDMENTS-node.md`, plus pending target-count expectations in `scripts/test_validate_case_map.py` and `scripts/test/node-interim.test.ts`. Those references now track the declared tests: PAR failure, state boundary/replay, nonce retry, ten-way refresh race, and the expanded security matrix. The case IDs and published GitHub issues were not changed. The 16 Python regressions and node-interim test pass, and the full gate passes with these synchronized references.

This is local dirty-tree evidence only. M2 issue/architecture conflicts remain open for owner reconciliation, and real independent-PDS/browser OAuth acceptance is not established.

### M2 additional deterministic evidence and semantic mapping corrections — 2026-10-28

The following follow-up closes two deterministic evidence gaps named above; it does not resolve the published-contract conflicts or external acceptance requirements.

- Added `worker/test/node/bff/oauth-client.test.ts › authorization start rejects AS metadata whose issuer differs from the advertised issuer before state or PAR`. It exercises the authorization-server metadata `issuer` equality check during the initiation-time protected-resource → AS discovery chain. The fake AS advertises an attacker-controlled, valid HTTPS issuer; the actual resolver's `TypeError` cause is asserted. The request fails as `oauth_upstream` before state insertion, PAR or token exchange, with no session. `M2.1.3/issuer_mismatch` now maps this as primary evidence and retains the distinct callback-time PDS/AS migration-and-revocation test as additional evidence. This is a deterministic library/fake-AS regression, not independently operated issuer interoperability.
- Added `scripts/test/node-recovery.test.ts › oauth_refresh_recovery: rotated refresh credentials and the same app-session cookie survive a child-process restart`. The current packaged Node test host signs in once, expires the access token, performs a write that rotates the AS refresh token, SIGKILLs the product process, restarts it on the same SQLite database, retains the original `__Host-atmusic_session` cookie/CSRF token, and performs a second expired-token write. The second refresh succeeds with the rotated credential; replay would invalidate/revoke the fake-AS session. No new PAR occurs and the fixture AS reports two rotations with no revocations. The fixture AS/PDS remain in the parent test process. This proves local subprocess persistence/recovery, not external PDS interoperability or browser/live acceptance. `M2.3.1/refresh_restart` and `M2.4.2/refresh_persistence` retain the lower-layer close/reopen test and add this child-process journey.
- Corrected two overbroad test titles and their copies in `docs/verification/ts-case-map.json`, `docs/planning/node-waves.json`, `docs/planning/AMENDMENTS-node.md`, and ADR 0005 §20.2. The 599,999 ms state result demonstrates that callback denial handling sees a still-valid state, not a successful sign-in; the ten-way restore test demonstrates one successful refresh rotation, not one total wire request including DPoP nonce challenges. The issue #55 300-second versus ADR 0005 600-second conflict remains unchanged.
- These are test and traceability changes only. No production OAuth behavior, M2 GitHub issue state, live credential, or production resource was changed. Evidence remains local and fixture-bound; M7 remains excluded.

### Schema-publication fail-closed gate and refreshed local verification — 2026-10-28

This follow-up makes the namespace write/publication prerequisite explicit in the shared Worker/Node config path; it does not resolve M2 issue contracts or authorize deployment.

- `worker/src/config.ts` now enables `publication` only when a valid non-fixture prefix, `NAMESPACE_OWNERSHIP_REF`, and `NAMESPACE_PUBLICATION_REF` are all present. The latter must match `sha256:<64 lowercase hex digits>`. Supplying a syntactically valid publication reference without ownership evidence, or for the fixture prefix, is rejected. The parser checks **shape only**: it does not load the manifest, recompute the digest, prove the records were published, or attest owner review. A configured digest is an operator assertion and must remain unset until the evidence has actually been reviewed.
- `namespaceView`/`/api/v1/meta`, the Node composition context, `runOutbox`, and the Node PDS-writer factory use the same gate. Production/example Worker vars, Node environment examples and deployment docs now describe the two-evidence rule. Fixture-only tests use synthetic digests; these do not represent production schema evidence. The dedicated auth/outbox fixture that needs successful writes now opts into an explicit synthetic non-fixture namespace rather than relying on the default closed fixture prefix.
- `worker/test/config.test.ts` pins the ownership-only closed state, malformed/missing-evidence rejection and the two-reference open state; `worker/test/http/health-meta.test.ts` checks config/meta parity across valid/refused inputs; the outbox retry suite checks the closed gate. The test inventory was updated to the renamed gate assertions. The 14-file focused run passed **80 tests**, and `scripts/test/test-inventory.test.ts` passed **2 tests**.
- Fresh broad local receipt: `bash scripts/check-ts.sh` completed **exit 0: 224 test files, 921 passed, 0 failed/skipped/todo**. Typecheck, Biome, OpenAPI/lexicon contract checks, the 258-case map and 16 Python map regressions, Worker bundle guard, Node build `--check`, and Node bundle guard all passed. The gate includes fake-service and local child-process recovery tests; those remain deterministic fixture/process evidence, not independently operated PDS, browser, hosted-CI, or live acceptance.
- Verification ran on the still-dirty checkout based at `29453f8e8763083a3e3d7b10d5090285ef2f9d63`. The `build-server --check` output is not an accepted candidate: source is dirty and no clean, artifact-bound release or hosted provenance was produced. No production configuration, credential, external PDS/DNS resource, running service, deployment, or GitHub issue state was changed. The production schemas are still missing at the queried authority repository; preserve the publication gate closed.

This deterministic gate change does not resolve #50–61's published contract differences, replace the current-Node OAuth live-driver work, prove upstream revocation, or establish browser/external-PDS interoperability. All M2 issues remain OPEN pending owner reconciliation and their separate acceptance gates; M7 remains excluded.
