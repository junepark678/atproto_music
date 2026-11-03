# Node backend acceptance gate

`scripts/acceptance/node-backend.sh` is the single acceptance gate for the Node
backend (ADR 0005 §15, wave N8-01 in `docs/planning/node-waves.json`). It
replaces the interim `scripts/acceptance/node-interim.sh` (N0-02, kept for the
earlier waves) and the retired Workers gate `scripts/acceptance/workers-backend.sh`
(W7-01, documented in `backend-workers.md`). The gate runs every deterministic
suite, resolves every case in `docs/verification/ts-case-map.json` to an executed
Node test, and reports the live gates as blocked unless independently verified
evidence is bound to this checkout's commit and Node bundle.

```sh
bash scripts/acceptance/node-backend.sh                       # work/acceptance/node-backend
bash scripts/acceptance/node-backend.sh --out /tmp/evidence   # any new or empty directory
bash scripts/acceptance/node-backend.sh --skip e2e            # negative control: always fails
```

- `--out DIR` chooses the evidence directory (relative paths resolve against
  the caller's working directory). The gate writes a `.node-backend-gate`
  marker into the directory it creates. It refuses, with exit 2, any `--out`
  that is non-empty and lacks that marker, so it never deletes foreign output.
  Inside its own directory it removes only the file names it writes.
- `--skip STEP` disables a step. A disabled step is recorded with status
  `skipped` and the gate **always** fails: a skipped step is never a pass.
- `--help`, an unknown option, an unknown step name, or a bad `--out` are
  usage errors (exit 2) and produce no evidence directory.
- The gate never contacts a live service. The live gate scripts run only with
  every `ATMUSIC_LIVE_*` variable unset, and the recorded live inventory is
  verified offline.
- A `.venv` in the repository root is activated when present. The commit is
  `git rev-parse HEAD`, suffixed `+dirty` when the working tree has changes, and
  exported to every step as `ATMUSIC_ACCEPTANCE_COMMIT`.

## Steps

Every step runs in the fixed order below, even after an earlier failure, so one
run shows every problem. Each step writes `<step>.command` (the command line),
`<step>.status` (`0`, the exit code, `skipped`, or `blocked`) and `<step>.log`
(its stdout and stderr) into the evidence directory.

| Step | Command | What it contributes |
| --- | --- | --- |
| `check-ts` | `bash scripts/check-ts.sh` | Typecheck, lint, contract validation, unit suites; produces `check-ts.jsonl` test records. |
| `node-tests` | `npx vitest run --project worker-node --project worker-acceptance` | Node runtime and acceptance suites; produces `node-tests-report.json` and `node-tests.jsonl`. |
| `e2e` | `npx playwright test` | Browser end-to-end suites; produces `e2e-report.json`. |
| `scrobbler-e2e` | `npx tsx scripts/e2e/scrobbler-e2e.ts` | Scrobbler end-to-end run against the fixture world; produces `scrobbler-e2e.jsonl` (the `PASS`/`FAIL <title>` log lines are the fallback). |
| `python` | `python3 -m unittest` over every `scripts/test_*.py` the case map or wave plan references | Python tooling suites; produces `python.jsonl`. |
| `check-node-bundle` | `npx tsx scripts/check-node-bundle.ts` | Guards the Node bundle and prints `bundle sha256 <hex>  main.mjs`, the SHA-256 the live step binds to. |
| `case-map` | `python3 scripts/validate_case_map.py --check-tests` | Unrestricted case-map check (no `--node-wave`): every one of the 258 cases must map to an existing Node test or a retirement with a reason. A pending target fails the gate (ADR 0005 §15.3). |
| `goldens` | `bash scripts/check_goldens.sh` | Golden-file equivalence. |
| `systemd` | `systemd-analyze --user verify config/systemd/atmusic.service config/systemd/atmusic.socket` | Unit-file verification. A missing unit fails; a missing `systemd-analyze` marks the step `blocked`, and a blocked deterministic step fails the gate. |
| `live-noenv` | `npx tsx scripts/live/<gate>.ts` with every `ATMUSIC_LIVE_*` unset | Every live gate under `scripts/live/` must answer exit 2 with `result: blocked` and a non-empty `missing` list; output is kept as `live-noenv-<gate>.json/.stderr/.exit`. |
| `live` | `python3 scripts/verify_live_evidence.py --node --commit HEAD --bundle-sha256 <check-node-bundle>` | Verifies the recorded live inventory (`docs/verification/live-evidence.json` or `ATMUSIC_LIVE_INVENTORY`) offline against this commit and bundle. Exit 0 (complete) or 2 (blocked) passes; exit 1 (a recorded failure) fails. |

## Closure and records

After the last step a Python closure reads the test records and resolves every
case-map entry:

- Test records come from `check-ts.jsonl`, `node-tests.jsonl`, `python.jsonl`,
  `scrobbler-e2e.jsonl` and the Playwright `e2e-report.json` (`expected` →
  passed, `unexpected`/`flaky` → failed, anything else → skipped).
- A target of the form `python3 scripts/validate_contracts.py › <check>`
  resolves to the `PASS <check>` line in the contracts section of the
  `check-ts` log. `npx tsx scripts/check-node-bundle.ts` resolves to a
  synthetic record that passes only when the step exited 0 and printed a
  bundle SHA-256. `python3 scripts/validate_case_map.py --check-tests` passes
  only when the step exited 0, reported `258 unique cases`, confirmed every
  referenced test file and name exists, and printed no `PENDING case map:`
  line. `npx tsx scripts/live/<gate>.ts (no env)` passes only when the
  `live-noenv` run of that gate exited 2 with a blocked document.
- The gate's own self-reference (`bash scripts/acceptance/node-backend.sh › exits 0
  with every step passed and live gates listed as blocked, never as passed`) is
  decided last: it counts the run and passes only if the whole gate passes.
- Any other target resolves to a record by exact id, then by title suffix,
  then by file prefix plus title.

Each case ends in one state:

- **passed**: its target and every `also` reference resolved to executed,
  passing records.
- **failed**: a reference did not execute, or a resolved record failed. Both
  add a problem and fail the gate.
- **blocked**: the case depends on a live gate (its target is a
  `scripts/live/<gate>.ts (no env)` reference, or it is `M6.4.3/live_inventory`)
  and the recorded inventory did not verify as complete for this commit and
  bundle. `M2.4.3/live_credentials_missing` and `M4.4.1/coverage_failure` are
  exempt: they pass on the deterministic no-env or coverage records alone.
- **retired**: the target starts with `retired:`; the retirement reason is the
  evidence and the case is never counted as executed.

Live gates (`oauth`, `ingest`, `pdsCompat`, `ssrfProbe`, `socketSoak`) are
reported `blocked` unless the inventory verifier exited 0 **and** recorded that
gate as passed for this bundle. A recorded failure adds a problem.

Problems that fail the gate:

- `step <s> was disabled with --skip; a disabled step is never a pass`
- `step <s> is blocked (<command>: tool unavailable); a blocked deterministic step is never a pass`
- `step <s> (<command>) exited <n>`
- `case map: … (ADR 0005 §15.3: no mapped target may be pending)`
- `case <id>: not executed: …` and `case <id>: failed: …`
- `live gate <g> recorded a failure for bundle …`
- `no Node bundle SHA-256: check-node-bundle did not pass`

Files in the evidence directory:

- `<step>.command`, `<step>.status`, `<step>.log` for each of the 11 steps.
- `tests.jsonl`: one record per executed test (`target`, `command`, `executed`,
  `result`, `commit`, `source`).
- `cases.jsonl`: one record per case-map entry (`case`, `state`, `count`,
  `commit`, `bundleSha256`, `command`, `target`, `reason`).
- `live.json`: the live gate table (`gate`, `script`, `result`, `missing`,
  `message`).
- `summary.json`: `{gate, commit, bundleSha256, steps, tests, cases, live, liveGates, result, problems}`.

Stdout is marked so a reader can grep it: `PASSED|FAILED|BLOCKED|RETIRED <case>
count=… commit=… bundle=… command=… target=…` per case, `LIVE BLOCKED <gate>
(<script>)` per blocked live gate, `FAIL acceptance: <problem>` per problem, the
counts, the `commit …; bundle …; summary …` line, and finally either
`PASS node-backend: every step passed and every mapped case executed; N live
gate(s) and M live case(s) are blocked, not passed` or
`FAIL node-backend: N problem(s)`.

Exit status: `0` when every step passed and every mapped case executed (live
gates may be blocked, never passed without verified evidence); `1` when any
step failed, was skipped or blocked, any case did not execute or failed, or a
live gate recorded a failure; `2` on a usage error or a refused `--out`.

## Live gates

The gate never runs a live gate body. `docs/verification/node-live.md`
describes how the live gates are run by an operator with credentials and how
their evidence is recorded in the inventory. The `live` step only re-verifies
that inventory with `scripts/verify_live_evidence.py --node`, bound to the
current commit and to the bundle SHA-256 printed by `check-node-bundle`. A live
gate therefore turns from `blocked` to `passed` only when verified evidence for
this exact bundle exists; stale or unbound evidence leaves it blocked.

## Executed evidence

Recorded 2026-11-03 on commit `c2da66aa0a8b90f5226751ed392fe7e0fcc2c87d+dirty`
(branch `t3/n8-backend-acceptance-gate`, dirty because the gate, its test and
this document were untracked at the time). **No passing Node run is recorded
yet.** The run below is the first complete execution of the gate against the
worktree; it exited `1` with 13 problems, every one of which is a worktree gap
outside the gate's own files.

Command: `bash scripts/acceptance/node-backend.sh --out /tmp/node-backend-evidence2`
(stderr empty; bundle `d92e80c636087a5c59c8965a634c19d94cf99965425b07246d7a5f0fd2640cbd`).

| Step | Exit | Note |
| --- | --- | --- |
| check-ts | 1 | 984 tests, 3 failed, 1 skipped; contracts step never reached |
| node-tests | 0 | 438 tests passed |
| e2e | 0 | 13 Playwright tests passed against the Node stack |
| scrobbler-e2e | 1 | `scripts/e2e/scrobbler-e2e.ts` does not exist |
| python | 0 | 44 unittest cases passed |
| check-node-bundle | 0 | bundle SHA-256 printed and bound |
| case-map | 1 | `M3.4.3/live_retries` cites the missing scrobbler suite |
| goldens | 0 | |
| systemd | 0 | both units verified by `systemd-analyze --user verify` |
| live-noenv | 0 | 7 gate scripts refused with exit 2 and a `blocked` document |
| live | 0 | inventory unbound: blocked (exit 2 from `verify_live_evidence.py`) |

Counts: tests executed 1478, passed 1475, failed 3, skipped 1; cases 258 =
233 passed, 10 failed, 9 blocked, 6 retired; live gates 0 passed, 0 failed,
5 blocked (`oauth`, `ingest`, `pdsCompat`, `ssrfProbe`, `socketSoak`).

Problems and their causes:

- `check-ts` exit 1: `scripts/test/deploy.test.ts` fails twice because
  `scripts/deploy.sh` now prints `Cannot read properties of undefined (reading
  'trim')` instead of its prefix refusal (Workers deploy path, pre-existing);
  `web/test/bundle.test.ts` times out in its 10 s `beforeAll` web build;
  `scripts/test/node-ingest.test.ts › Node ingest reaps the actual owned startup
  process before returning timeout evidence` fails with a missing pid file.
  Because vitest fails, `check-ts.sh` exits before the contracts step, so
  `M1.1.4/route_inventory` and `M1.1.4/response_examples` resolve as not
  executed. Cases `M1.4.1/invalid_config` and `M6.1.3/fresh_install` fail on
  the deploy tests.
- `scrobbler-e2e` exit 1 and `M3.4.3/live_retries` not executed: the scrobbler
  end-to-end suite required by N8-01 is not in this worktree, which also fails
  `case-map` and therefore `M6.4.2/unrun_gate`.
- Six case-map targets still name retired Workers commands and resolve as not
  executed until the N8-01 case-map update lands:
  `bash scripts/acceptance/workers-backend.sh › …` (`M1.2.2/ci_green`,
  `M6.4.2/packaged_flow`), `bash scripts/deploy.sh --dry-run › …`
  (`M1.4.1/invalid_config`, `M6.1.3/fresh_install`) and `npx tsx
  scripts/check-bundle.ts › production bundle passes guard`
  (`M2.4.1/no_prod_bypass`, `M6.4.1/checksum`).

A first run before the Python name fix also reported `M4.4.1/coverage_failure`
as not executed: unittest `shortDescription()` returns the method docstring
with its trailing period while the case map cites the module-docstring bullet
without one. The gate now strips that period and the case passes with four
records.

Gate self-tests (`scripts/test/node-backend.test.ts`, one vitest case driving a
disposable copy of the gate with stubbed step commands; see the `tests.jsonl`
record `bash scripts/acceptance/node-backend.sh › exits 0 with every step passed
and live gates listed as blocked, never as passed`):

- every stub passing with the live inventory unverifiable exits `0`, lists the
  five live gates as `blocked` and prints the `PASS node-backend` line;
- a stubbed `systemd-analyze` absence makes `systemd` return `75` and the gate
  exit `1` with `step systemd … blocked`;
- a stubbed `goldens` exit 1 exits `1`;
- omitting one mapped record from `node-tests` exits `1` with
  `not executed` for that case;
- `--skip systemd` exits `1` even though every executed step passed;
- an unknown flag, a missing `--out` value and an unknown `--skip` step exit
  `2`; a non-empty `--out` without the `.node-backend-gate` marker is refused
  with exit `2` and left untouched.
