# Workers backend acceptance gate

`scripts/acceptance/workers-backend.sh` is the acceptance gate for the Cloudflare Workers backend (ADR 0004 §10, A18, A19; package W7-01). It runs every deterministic suite. Then it closes the [258-case map](ts-case-map.json) over the tests that actually ran. Every named case in `docs/planning/github-plan.json` ends as passed, failed, blocked or retired, with its own record.

```sh
bash scripts/acceptance/workers-backend.sh            # records in work/acceptance/workers-backend/
bash scripts/acceptance/workers-backend.sh --out DIR  # another output directory
bash scripts/acceptance/workers-backend.sh --skip e2e # negative control: always exits 1
```

`--out DIR` may be inside or outside the repository. A relative `DIR` is resolved against the caller's working directory. The gate writes a `.workers-backend-gate` marker into its output directory. It refuses (exit 2) a non-empty `DIR` that has no marker, so `--out .` or `--out docs/verification` deletes nothing. On each run it removes only the file names it writes itself, such as `<step>.log`, `<step>.status`, `cases.jsonl` and `summary.json`. Other files in the directory are left in place.

The script never deploys and never runs a live gate body. It never contacts Cloudflare, a PDS, a relay or Jetstream. Everything it starts listens on 127.0.0.1: workerd under vitest, plus `wrangler dev` and `@atproto/dev-env` for Playwright.

## Steps

| Step | Command | What it contributes |
|---|---|---|
| `check-ts` | `bash scripts/check-ts.sh` | Typecheck, Biome, the whole vitest workspace with per-test records (`scripts/report-tests.ts`), contracts, case map and bundle guard. Each `PASS <check>` line of `validate_contracts.py` becomes a record. |
| `acceptance` | `npx vitest run --project worker-acceptance` | The real `IndexDO` in workerd, run on its own (W6-01) with its own per-test records. |
| `e2e` | `npx playwright test` (`npm run test:e2e`) | The browser journey and accessibility suites (W6-03). The mapped M3.4.1, M6.1.1, M7.1.3 and M7.4.x cases depend on them. If `E2E_*_PORT` is unset, the gate picks five free loopback ports, so a `wrangler dev` already on 8787 does not break the run. |
| `python` | `python3 -m unittest` over every `scripts/test_*.py` file the case map references | One record per test, named by its docstring, which is its case-map name. |
| `check-bundle` | `npx tsx scripts/check-bundle.ts` | The production guard (origin `https://music.214510.xyz`, prefix `dev.pythonplayer123.music`, no test seam). It prints the Worker bundle SHA-256 (A19) that every record carries. |
| `case-map` | `python3 scripts/validate_case_map.py --check-tests` | Every mapped test file and name exists, and all 258 cases are covered. |
| `goldens` | `bash scripts/check_goldens.sh` | The Rust-oracle goldens regenerate byte-identically (§10.4 golden parity). |
| `live-noenv` | each `npx tsx scripts/live/<gate>.ts`, with every `ATMUSIC_LIVE_*` variable removed | Each gate must exit 2 with a `blocked` document that lists the missing names, before any network request. |
| `live` | Prerequisites, then `python3 scripts/verify_live_evidence.py <inventory> --bundle-sha256 <bundle>` | See [Live gates](#live-gates). |

## Closure and records

For every entry in `ts-case-map.json`, the gate resolves each test id (`target` and `also`) to the executed records that prove it:

- **vitest and Playwright ids** match on the file and the test title, including a `describe` chain.
- **`python3 scripts/validate_contracts.py › <check>`** matches a `PASS <check>` line of the contracts step.
- **Command ids** (`check-bundle.ts`, `validate_case_map.py --check-tests`, `scripts/live/<gate>.ts (no env)`) match the outcome of their step.
- **The gate's own id**, `bash scripts/acceptance/workers-backend.sh › exits 0 with all deterministic suites passing and lists live gates as blocked when prerequisites absent`, used by M1.2.2/ci_green and M6.4.2/packaged_flow, is decided last. It passes only if everything else passed.

A case is one of:

- **passed:** every test id ran, with a nonzero count, and all its records passed. A test that ran in two steps (the acceptance files run in `check-ts` and in `acceptance`) must pass both times.
- **failed:** a test id did not run, or did not pass. A filtered, skipped, renamed or deleted test, a disabled step (`--skip`) or a failed suite fails the gate, and the gate names the case and the missing test. That is M6.4.2/unrun_gate, enforced on the real run.
- **blocked:** the case needs live evidence. Its deterministic proof is the live gate's refusal to run without prerequisites, and that check passed. These cases are M2.4.3/live_round_trip, live_disposable_record, M3.4.3/live_create_read, live_delete, M4.4.3/live_remote_arrival, live_remote_mutation, live_recovery, M6.4.3/live_inventory and M7.4.3/live_product. They turn passed only when `verify_live_evidence.py` passes the inventory for this bundle. Two cases are exempt, because their plan expectation is the blocked refusal itself: M2.4.3/live_credentials_missing and M4.4.1/coverage_failure.
- **retired:** `retired:<A#|D>` with the reason from the map (ADR 0004 §9). The gate lists these but does not count them as passed.

Output in the output directory:

- `cases.jsonl` holds one record per plan case: `case`, `result`, `targets`, `commands`, `count`, `commit` (with `+dirty` for an uncommitted tree) and `bundleSha256`, plus `notRun`, `failedTests` or `blockedBy` where they apply.
- `tests.jsonl` holds every executed test record.
- `live.json` holds the live gate statuses.
- `summary.json` holds the step exits and the counts.
- There is one log per step.

stdout prints every case record, the live gates and the counts. It reports passed, failed, skipped and blocked separately.

Exit status:

- **0:** every step passed and no mapped case failed. Live gates and live cases may be blocked, and they are listed as blocked.
- **1:** any failure, including a live gate that recorded a failure for this bundle, or any `--skip`.
- **2:** a usage error.

## Live gates

The gate never runs a live gate body. A live gate needs the operator's deployment and credentials, and the socket soak runs for 24 h. See [workers-live.md](workers-live.md). For each of `oauth`, `ingest`, `pdsCompat`, `ssrfProbe` and `socketSoak`, the gate does two things:

1. It computes the prerequisites that are missing from the current environment, using the gate's own `spec.requirements`, its `extraChecks` and its redaction. If any are missing, the gate is **blocked**, and those names are listed.
2. Otherwise, it reads the recorded inventory (`ATMUSIC_LIVE_INVENTORY`, default `docs/verification/live-evidence.json`), checked by `verify_live_evidence.py` against this bundle's SHA-256:
   - a gate passes only if the inventory passes;
   - a failure recorded for this bundle fails the acceptance gate;
   - anything else stays blocked.

## Executed evidence

The run below was recorded on 2026-10-25 at commit `6f95c536bfc356ac5ef12524cd3cd6f6c3c34847` (clean tree), with Worker bundle SHA-256 `e796e5a5a4cf210f…7ab36` (production env, gzip 143,667 bytes). [VALIDATION.md](../VALIDATION.md) records the full digest. The command was `./scripts/acceptance/workers-backend.sh`, which runs the same script as `bash scripts/acceptance/workers-backend.sh`. It **exited 0**.

| Step | Result |
|---|---|
| `check-ts` | exit 0; vitest 103 files, **406 passed**, 0 failed, 0 skipped (packages 81, worker 237, web 60, scripts 28); contracts, case map, validator tests and bundle guard passed |
| `acceptance` | exit 0; 6 files, **21 passed** |
| `e2e` | exit 0; Playwright **9 passed** (chromium) |
| `python` | exit 0; `test_live_evidence.py` and `test_validate_case_map.py`, **25 passed** |
| `check-bundle` | exit 0; `PASS check-bundle`, origin `https://music.214510.xyz`, prefix `dev.pythonplayer123.music` |
| `case-map` | exit 0; `PASS case map: 258 unique cases (213 mapped to declared wave test ids, 0 awaiting 0 required wave amendment tests, 45 retired with amendment ids); every referenced test file and name exists` |
| `goldens` | exit 0; `PASS check_goldens: regenerated Rust-oracle goldens are byte-identical to tests/goldens` |
| `live-noenv` | exit 0; all five gates exited 2 with `blocked` documents listing their missing names |
| `live` | exit 0; prerequisites missing for all five gates; the inventory is BLOCKED (it is still the schemaVersion 1 musl inventory) |

**Tests:** 461 executed records, all passed: 0 failed, 0 skipped, 0 todo. The 21 acceptance tests are counted twice, once in each run, so they are not 461 distinct tests.

**Cases (258):** passed 204, failed 0, blocked 9, retired 45.

| Milestone | Passed | Blocked | Retired |
|---|---|---|---|
| M1 | 31 | 0 | 11 |
| M2 | 18 | 2 | 16 |
| M3 | 29 | 2 | 5 |
| M4 | 33 | 3 | 0 |
| M5 | 34 | 0 | 2 |
| M6 | 28 | 1 | 7 |
| M7 | 31 | 1 | 4 |

**Live gates:** passed 0, failed 0, blocked 5. Each gate's missing prerequisites:

- `oauth`: 15
- `ingest`: 17
- `pdsCompat`: 12
- `ssrfProbe`: 7
- `socketSoak`: 9

The common release inputs are missing for all five gates: `ATMUSIC_LIVE_ORIGIN`, `ATMUSIC_LIVE_LEXICON_PREFIX`, `ATMUSIC_LIVE_WORKER_VERSION_ID` and `ATMUSIC_LIVE_BUNDLE_SHA256`. Beyond those, the gates need these inputs:

- `oauth`, `ingest` and `pdsCompat`: two identities on independent PDSs and the PDS implementations;
- `ingest`, `pdsCompat` and `socketSoak`: Jetstream coverage;
- `ingest`, `ssrfProbe` and `socketSoak`: `ADMIN_TOKEN`;
- `oauth` and `ingest`: sign-in credentials;
- `ssrfProbe`: the probe Worker and DNS names;
- `socketSoak`: Cloudflare Analytics access.

**Negative controls executed:**

- **A dropped test record.** The closure was replayed over a copy of the commit `fa6aaca` records with one test removed: `namespace.test.ts › fixture prefix blocks publication…`. The gate exited 1 with `case M1.1.1/fixture_namespace: not executed`. M1.2.2/ci_green and M6.4.2/packaged_flow turned failed.
- **Disabled steps.** A run with `--skip check-ts --skip acceptance --skip goldens` exited 1. It named each disabled step and every case left unexecuted. That run used the uncommitted working tree that later became `fa6aaca`.
- **A broken matcher.** The first full run, at `fa6aaca`, exited 1. Its matcher did not recognise the `route_inventory` contract line, so the gate reported M1.1.4/route_inventory as not executed instead of passing it. Commit `6f95c53` fixed the matcher.
- **`--out` outside the repository (review round 1).** At `1210d61` the live step wrote its helper as a `.ts` file into `DIR`. Outside the repository no `package.json` with `"type": "module"` applied, so tsx compiled the helper as CJS. Top-level await failed, the live step exited 1, and the gate exited 1. Commit `3f547ec` writes the helper as `.mts`. A full run at `3f547ec` (clean tree) with `--out` in a scratch directory outside the repository **exited 0**: 461 records passed, and the cases came out at 204 passed, 0 failed, 9 blocked and 45 retired, with the same bundle SHA-256 `e796e5a5…7ab36`. A second full run at `3f547ec` with the default `--out` also exited 0, with identical counts.
- **A foreign `--out` directory (review round 1).** At `1210d61` the startup cleanup globbed `*.json`, `*.ts`, `*.txt` and other patterns in `DIR`. Each of the following runs, at `3f547ec`, exited 2 and deleted nothing:
  - `--out .` from the repository root;
  - `--out docs/verification`;
  - `--out` naming a scratch directory that held `package.json`, `vitest.config.ts`, `notes.txt` and `keep.md`.

  A relative `--out relgate`, run from another directory, created `relgate` there and not in the repository. After `package.json` and `notes.txt` were added to that marked directory, a rerun left both files in place.

This is deterministic evidence only. It does not establish:

- OAuth interoperability;
- Jetstream coverage;
- external-writer ingestion on real PDSs;
- Workers `fetch` behaviour toward private addresses;
- the socket-versus-pulse decision.

Those questions stay open until the live gates pass for a deployed Worker version.
