#!/usr/bin/env bash
# The TypeScript repository gate (ADR 0004 §10, A18; ADR 0005 §15.1). Every wave
# runs it via `npm run check`. Fails on the first failing step and preserves its
# status.
#
# Usage: scripts/check-ts.sh [--projects <list>]
#
#   --projects <list>  Run only these vitest projects (comma- or space-separated
#                      names, e.g. `worker-node` or `core,worker-node`) in the
#                      test step; every other step is unchanged. It exists for
#                      the nested negative controls in scripts/test/check-ts.test.ts,
#                      so that each control runs just the project it exercises
#                      instead of a second full gate. `npm run check` never
#                      passes it: the repository gate always runs every project.
#
# Writes work/gate-durations.json: one wall-clock duration per step that ran,
# in order, with the step's status, the exit code and the total (also when a
# step fails).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export LC_NUMERIC=C

usage() {
  echo 'usage: scripts/check-ts.sh [--projects <comma- or space-separated vitest project names>]' >&2
  exit 2
}

projects=()
projects_given=0
add_projects() {
  local list name
  IFS=', ' read -r -a list <<<"$1"
  for name in "${list[@]}"; do
    [[ -z "$name" ]] && continue
    if [[ ! "$name" =~ ^[a-z][a-z0-9-]*$ ]]; then
      echo "check-ts.sh: invalid vitest project name: $name" >&2
      exit 2
    fi
    projects+=("$name")
  done
}
while (($# > 0)); do
  case "$1" in
    --projects)
      (($# >= 2)) || usage
      projects_given=1
      add_projects "$2"
      shift 2
      ;;
    --projects=*)
      projects_given=1
      add_projects "${1#--projects=}"
      shift
      ;;
    *)
      echo "check-ts.sh: unknown argument: $1" >&2
      usage
      ;;
  esac
done
if ((projects_given == 1 && ${#projects[@]} == 0)); then
  echo 'check-ts.sh: --projects needs at least one project name' >&2
  exit 2
fi

# --- per-step wall-clock durations (work/gate-durations.json) ---------------
mkdir -p work
DURATIONS="work/gate-durations.json"
rm -f "$DURATIONS"
gate_start=$EPOCHREALTIME
step_names=()
step_seconds=()
step_statuses=()
current_step=''
current_start=''

seconds_between() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f", b - a }'; }
json_string() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}
finish_step() {
  [[ -z "$current_step" ]] && return 0
  step_names+=("$current_step")
  step_seconds+=("$(seconds_between "$current_start" "$EPOCHREALTIME")")
  step_statuses+=("$1")
  current_step=''
}
write_durations() {
  local rc=$1 i sep='' projects_json='null' result='passed'
  ((rc == 0)) || result='failed'
  if ((${#projects[@]} > 0)); then
    projects_json='['
    for i in "${!projects[@]}"; do
      ((i > 0)) && projects_json+=', '
      projects_json+="$(json_string "${projects[$i]}")"
    done
    projects_json+=']'
  fi
  {
    printf '{\n  "schemaVersion": 1,\n'
    printf '  "projects": %s,\n' "$projects_json"
    printf '  "result": "%s",\n  "exitCode": %d,\n' "$result" "$rc"
    printf '  "totalSeconds": %s,\n' "$(seconds_between "$gate_start" "$EPOCHREALTIME")"
    printf '  "steps": ['
    for i in "${!step_names[@]}"; do
      printf '%s\n    { "name": %s, "seconds": %s, "status": "%s" }' "$sep" \
        "$(json_string "${step_names[$i]}")" "${step_seconds[$i]}" "${step_statuses[$i]}"
      sep=','
    done
    printf '\n  ]\n}\n'
  } >"$DURATIONS.tmp"
  mv "$DURATIONS.tmp" "$DURATIONS"
}
on_exit() {
  local rc=$1
  if ((rc == 0)); then finish_step passed; else finish_step failed; fi
  write_durations "$rc" || echo "check-ts.sh: could not write $DURATIONS" >&2
  exit "$rc"
}
trap 'on_exit $?' EXIT

step() {
  finish_step passed
  printf '\n==> %s\n' "$*"
  current_step="$*"
  current_start=$EPOCHREALTIME
}

# validate_contracts.py needs its pinned deps (api/requirements-contracts.txt).
# Use an already active venv, else ./.venv, else the main checkout's .venv
# when running from a git worktree.
if [[ -z "${VIRTUAL_ENV:-}" ]]; then
  common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  for candidate in "$ROOT/.venv" "${common_dir:+$common_dir/../.venv}"; do
    if [[ -n "$candidate" && -f "$candidate/bin/activate" ]]; then
      # shellcheck disable=SC1091
      source "$candidate/bin/activate"
      break
    fi
  done
fi

step 'typecheck (tsc -b)'
npm run --silent typecheck

step 'lint (biome)'
npm run --silent lint

# Every project (core, atproto, worker-modules, worker-node, worker-composition,
# worker-acceptance, worker-bench, web, scripts, scripts-gate), or only the
# --projects ones.
vitest_args=(--reporter=default --reporter=json)
test_command='npm test'
if ((${#projects[@]} > 0)); then
  step "test (vitest, projects: ${projects[*]})"
  for name in "${projects[@]}"; do
    vitest_args+=(--project "$name")
    test_command+=" -- --project $name"
  done
else
  step 'test (vitest, all projects)'
fi
report="work/ts-test-report.json"
rm -f "$report"
set +e
npm test -- "${vitest_args[@]}" --outputFile.json="$report"
test_status=$?
# Per-case evidence; fails on zero executed tests, any failure, or a missing report.
npx tsx scripts/report-tests.ts "$report" --command "$test_command" --out work/ts-test-cases.jsonl
report_status=$?
set -e
# The gate fails with vitest's own status when vitest failed, else with the
# report's (for example zero executed tests).
if ((test_status != 0)); then
  echo "vitest exited with status $test_status" >&2
  exit "$test_status"
fi
if ((report_status != 0)); then
  exit "$report_status"
fi

step 'contracts (validate_contracts.py)'
python3 scripts/validate_contracts.py

if [[ -f scripts/validate_case_map.py ]]; then
  step 'case map (validate_case_map.py)'
  python3 scripts/validate_case_map.py
fi

# The case-map validator's own regression tests (W0-AMEND: they went stale
# unnoticed while no gate step ran them).
if [[ -f scripts/test_validate_case_map.py ]]; then
  step 'case map validator tests (test_validate_case_map.py)'
  python3 -m unittest discover -s scripts -p test_validate_case_map.py
fi

# The Workers bundle guard stays until N7-01 deletes it with deploy.sh.
if [[ -f scripts/check-bundle.ts ]]; then
  step 'production bundle guard (check-bundle.ts)'
  npx tsx scripts/check-bundle.ts
fi

# The Node host's build and bundle guard (ADR 0005 §3.9, both N3-07), wired here
# by N0-01 so that no later package edits this script before N7-01. Each runs
# only when its file exists. The build comes first because the guard reads the
# esbuild metafiles it writes.
if [[ -f scripts/build-server.ts ]]; then
  step 'Node server build (build-server.ts --check)'
  npx tsx scripts/build-server.ts --check
fi

if [[ -f scripts/check-node-bundle.ts ]]; then
  step 'Node bundle guard (check-node-bundle.ts)'
  npx tsx scripts/check-node-bundle.ts
fi

finish_step passed
if ((${#projects[@]} > 0)); then
  printf '\nPASS check-ts (vitest projects: %s)\n' "${projects[*]}"
else
  printf '\nPASS check-ts\n'
fi
