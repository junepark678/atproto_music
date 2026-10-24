#!/usr/bin/env bash
# The TypeScript repository gate (ADR 0004 §10, A18). Every wave runs it via
# `npm run check`. Fails on the first failing step and preserves its status.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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

step() { printf '\n==> %s\n' "$*"; }

step 'typecheck (tsc -b)'
npm run --silent typecheck

step 'lint (biome)'
npm run --silent lint

step 'test (vitest, all projects)'
mkdir -p work
report="work/ts-test-report.json"
rm -f "$report"
set +e
npm test -- --reporter=default --reporter=json --outputFile.json="$report"
test_status=$?
set -e
# Per-case evidence; fails on zero executed tests, any failure, or a missing report.
npx tsx scripts/report-tests.ts "$report" --command "npm test" --out work/ts-test-cases.jsonl
if [[ $test_status -ne 0 ]]; then
  echo "vitest exited with status $test_status" >&2
  exit "$test_status"
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

if [[ -f scripts/check-bundle.ts ]]; then
  step 'production bundle guard (check-bundle.ts)'
  npx tsx scripts/check-bundle.ts
fi

printf '\nPASS check-ts\n'
