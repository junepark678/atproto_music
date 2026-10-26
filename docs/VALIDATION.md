# Validation evidence and remaining gates

The backend runs on Cloudflare Workers only (ADR 0004): one Worker, one SQLite Durable Object (`IndexDO`), Static Assets for the Preact SPA, and one Cron. The SPA is the write client; it writes signed records straight to the user's PDS. The Rust crates under `crates/` are kept as the golden-vector oracle (ADR §15 Q6) and are not deployed.

**Status: every deterministic gate passes, and every live gate is blocked.** All 258 named cases are accounted for by the acceptance gate. Live interoperability has not been established, because no live gate has run. No milestone is closed by this document.

## Acceptance run (W7-01)

`bash scripts/acceptance/workers-backend.sh` ran on 2026-10-25, at commit `6f95c536bfc356ac5ef12524cd3cd6f6c3c34847` on a clean tree. The Worker bundle SHA-256 was `e796e5a5a4cf210f94c9b64dfeb8b0a271b54978133ac8b74b7c1aeff007ab36` (the production env, origin `https://music.214510.xyz`, prefix `dev.pythonplayer123.music`). It **exited 0**. The [gate description and full record](verification/backend-workers.md) explains each step and the closure rules.

| Suite | Command | Executed | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| Repository gate: typecheck, Biome, vitest workspace, contracts, case map, validator tests, bundle guard | `bash scripts/check-ts.sh` | 406 | 406 | 0 | 0 |
| Backend acceptance in workerd (real `IndexDO`) | `npx vitest run --project worker-acceptance` | 21 | 21 | 0 | 0 |
| Browser journey and accessibility (`wrangler dev`, local `@atproto/dev-env`) | `npx playwright test` | 9 | 9 | 0 | 0 |
| Case-map and live-evidence regressions | `python3 -m unittest scripts/test_live_evidence.py scripts/test_validate_case_map.py` | 25 | 25 | 0 | 0 |
| Production bundle guard | `npx tsx scripts/check-bundle.ts` | 1 | 1 | 0 | 0 |
| Case-map existence | `python3 scripts/validate_case_map.py --check-tests` | 1 | 1 | 0 | 0 |
| Rust-oracle goldens | `bash scripts/check_goldens.sh` | 1 | 1 | 0 | 0 |
| Live gates without environment (each must refuse with `blocked`) | `npx tsx scripts/live/<gate>.ts` with `ATMUSIC_LIVE_*` removed | 5 | 5 | 0 | 0 |

The test-record total is 461 executed records, all passed. The 21 acceptance tests run both inside `check-ts.sh` and on their own, so they appear twice.

The cases come from `docs/verification/ts-case-map.json`:

| Result | Cases |
|---|---|
| Passed | 204 |
| Failed | 0 |
| Blocked | 9 |
| Retired | 45 |
| **Total** | **258** |

- **Passed:** every mapped test executed, with a nonzero count, and passed.
- **Blocked:** the case needs live evidence. Its deterministic proof is the refusal check, and that check passed.
- **Retired:** each retirement cites an ADR 0004 §9 amendment or the §9.3 dropped list. They break down as:

  | Amendment | Cases |
  |---|---|
  | D | 14 |
  | A3 | 10 |
  | A1 | 4 |
  | A11 | 4 |
  | A4 | 3 |
  | A15 | 3 |
  | A19 | 3 |
  | A12 | 2 |
  | A9 | 1 |
  | A14 | 1 |

The live gates are 0 passed, 0 failed and 5 blocked.

The gate fails on any mapped test that did not run, so an aggregate test count cannot stand in for a case. Two negative controls confirmed this:

- One executed record was removed from a replay of the records. The gate exited 1 and named `M1.1.1/fixture_namespace`.
- A run with disabled steps exited 1.

The first full run exited 1 on a real matcher bug, which is fixed in `6f95c53`.

## Reproduce

```sh
npm ci
bash scripts/acceptance/workers-backend.sh   # everything below, plus the closure
bash scripts/check-ts.sh                     # the repository gate alone (npm run check)
npm run test:e2e                             # Playwright alone
python3 scripts/validate_case_map.py --check-tests
bash scripts/check_goldens.sh
python3 scripts/verify_live_evidence.py      # exits 2, BLOCKED, until live evidence is recorded
```

`.nvmrc` pins Node 24 LTS. The recorded run used Node v26.12.1, and it did not run under Node 24. `validate_contracts.py` needs the pinned Python dependencies in `api/requirements-contracts.txt`, and `check_goldens.sh` needs cargo. Tests use the frozen clock `2026-01-15T12:00:00Z`, seeded randomness, and the fixture transport. The production SafeFetch policy stays on, and tests make no external network request. The fixture prefix `com.example.atmusic` is never published; the bundle guard refuses any production build that uses it, or whose prefix or origin differs from the configured values.

## Remaining gates

1. **Live gates (W6-05; [workers-live.md](verification/workers-live.md)).** Five gates are blocked by missing operator inputs:
   - `oauth`: sign-in on two independent PDSs;
   - `ingest`: Jetstream path, external writer, delete and reconcile;
   - `pdsCompat`: `getRecord` inclusion and exclusion proofs, `getBlocks`, `getRepoStatus`;
   - `ssrfProbe`: Workers `fetch` toward private addresses;
   - `socketSoak`: a 24 h soak and the socket-versus-pulse decision.

   The inputs are:
   - a deployed Worker version id with its bundle hash;
   - the production origin and owned prefix;
   - dedicated identities on two independently operated PDSs, with evidence that they are independent;
   - Jetstream coverage evidence;
   - `ADMIN_TOKEN`;
   - for `socketSoak`, Cloudflare Analytics access.

   `docs/verification/live-evidence.json` is still the schemaVersion 1 inventory from the Rust/musl candidate, so it cannot bind Worker evidence. The nine blocked cases are listed in [backend-workers.md](verification/backend-workers.md#closure-and-records).
2. **Deployment.** Nothing has been deployed. The operator deploys with their own credentials ([deployment.md](deployment.md), [docs/deploy](deploy/)). Production uses Workers Paid (ADR §15 Q4).
3. **Rust retirement (W7-02).** This is gated on the owner. Until the owner approves it, the Rust crates stay as the oracle, and `check_goldens.sh` keeps running.

## Rust candidate (historical)

The earlier Rust/musl backend candidate was validated on 2026-10-06. It passed 345 Rust tests, and the fixture-only acceptance runner `scripts/acceptance/backend.py` passed. Its packaged and live gates were blocked. That candidate is superseded by the Workers deployment (ADR 0004 A1, A19). Its receipts remain in [backend-candidate.json](verification/backend-candidate.json) and [backend.md](verification/backend.md) as a record. They are not evidence for the Workers backend.
