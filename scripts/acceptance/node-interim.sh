#!/usr/bin/env bash
# Interim per-wave acceptance for the ADR 0005 Node port (N0-02; ADR 0005 §2.2,
# §15.3, §17, B10). It replaces scripts/acceptance/workers-backend.sh in the
# gate from wave 0 until scripts/acceptance/node-backend.sh (N8-01):
#
#   bash scripts/acceptance/node-interim.sh --wave <n> [--out DIR] [--skip STEP]...
#
# Each wave's gate is `npm run check` plus this script. It runs the
# workers-backend steps that stay meaningful while the port is under way:
#
#   check-ts    npm run check (scripts/check-ts.sh: typecheck, lint, every vitest
#               project with per-test records, contracts, case map, the bundle
#               guards that exist)
#   python      the scripts/test_*.py regressions that the case map or
#               node-waves.json references, one record per test
#   case-map    python3 scripts/validate_case_map.py --check-tests --node-wave <n>
#               (targets of later node waves are reported pending)
#   goldens     bash scripts/check_goldens.sh (Rust-oracle goldens unchanged)
#   live-noenv  every scripts/live gate (a module exporting `spec`) with all
#               ATMUSIC_LIVE_* removed must exit 2 with a `blocked` document
#               listing missing names, before any network request
#   e2e         npx playwright test, only from wave 6 (N6-01 ports the browser
#               journeys to the Node stack)
#
# A step this wave does not run yet is printed as `pending until wave <m>`:
# e2e and the live-evidence inventory until wave 6 (N6-01, N6-02), and the
# case-map closure over executed records until wave 8 (N8-01). Nothing the old
# acceptance run checked is silently dropped.
#
# This script never runs a live gate body, never deploys, never binds the
# production address and never contacts a PDS, relay, Jetstream, Last.fm or
# ListenBrainz.
#
# Output (default work/acceptance/node-interim/; a relative --out is relative
# to the caller's directory, and a non-empty --out without the gate's
# .node-interim-gate marker is refused with exit 2): one log, status and
# command file per step, python.jsonl, the live-noenv documents and
# summary.json.
#
# Exit status: 0 when every step of this wave ran and passed; 1 when any step
# failed or was disabled with --skip (a disabled step is never a pass); 2 on a
# usage error.
set -uo pipefail

CALLER_PWD="$PWD"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

STEPS=(check-ts python case-map goldens live-noenv e2e)
E2E_WAVE=6
LIVE_EVIDENCE_WAVE=6
CLOSURE_WAVE=8
DEFAULT_OUT="$ROOT/work/acceptance/node-interim"
OUT="$DEFAULT_OUT"
MARKER=".node-interim-gate"
WAVE=""
SKIP=()

usage() {
  echo "usage: $0 --wave <n> [--out DIR] [--skip STEP]...  (n: 0-7; steps: ${STEPS[*]})" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wave)
      [[ $# -ge 2 && "$2" =~ ^[0-7]$ ]] || usage
      WAVE="$2"
      shift 2
      ;;
    --out)
      [[ $# -ge 2 && -n "$2" ]] || usage
      OUT="$2"
      [[ "$OUT" == /* ]] || OUT="$CALLER_PWD/$OUT"
      shift 2
      ;;
    --skip)
      [[ $# -ge 2 ]] || usage
      known=0
      for s in "${STEPS[@]}"; do [[ "$s" == "$2" ]] && known=1; done
      [[ $known -eq 1 ]] || usage
      SKIP+=("$2")
      shift 2
      ;;
    *) usage ;;
  esac
done
[[ -n "$WAVE" ]] || usage

mkdir -p "$OUT" || exit 2
OUT="$(cd "$OUT" && pwd)" || exit 2
if [[ "$OUT" != "$DEFAULT_OUT" && ! -f "$OUT/$MARKER" && -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  echo "node-interim: refusing --out $OUT: it is not empty and was not created by this gate" \
    "(no $MARKER); pass a new or empty directory" >&2
  exit 2
fi
echo "output directory of scripts/acceptance/node-interim.sh; its known files are replaced on each run" \
  > "$OUT/$MARKER" || exit 2
stale=(python.jsonl live-gates.txt summary.json e2e-report.json)
for s in "${STEPS[@]}"; do stale+=("$s.log" "$s.status" "$s.command"); done
for f in "${stale[@]}"; do rm -f -- "${OUT:?}/$f"; done
rm -f -- "$OUT"/live-noenv-*.json "$OUT"/live-noenv-*.stderr "$OUT"/live-noenv-*.exit

# Python contract deps (api/requirements-contracts.txt), as in check-ts.sh.
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

COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then COMMIT="$COMMIT+dirty"; fi
export ATMUSIC_ACCEPTANCE_COMMIT="$COMMIT"

skipped() {
  local s
  for s in "${SKIP[@]}"; do [[ "$s" == "$1" ]] && return 0; done
  return 1
}

# pending NAME WAVE LABEL: a step this wave does not run yet.
pending() {
  printf '%s\n' "$3" > "$OUT/$1.command"
  echo "pending until wave $2" > "$OUT/$1.status"
  printf '\n==> %s: pending until wave %s (%s)\n' "$1" "$2" "$3"
}

# run_step NAME COMMAND-LABEL FUNCTION: runs FUNCTION with its output in
# NAME.log and its exit status in NAME.status ("skipped" with --skip).
run_step() {
  local name="$1" label="$2" fn="$3" start status
  printf '%s\n' "$label" > "$OUT/$name.command"
  if skipped "$name"; then
    echo "skipped" > "$OUT/$name.status"
    printf '\n==> %s: SKIPPED (--skip %s; a disabled step fails the gate)\n' "$name" "$name"
    return
  fi
  printf '\n==> %s: %s\n' "$name" "$label"
  start=$SECONDS
  "$fn" > "$OUT/$name.log" 2>&1
  status=$?
  echo "$status" > "$OUT/$name.status"
  printf '    exit %s after %ss (log %s)\n' "$status" "$((SECONDS - start))" "${OUT#"$ROOT"/}/$name.log"
  if [[ $status -ne 0 ]]; then tail -n 25 "$OUT/$name.log" | sed 's/^/    | /'; fi
}

step_check_ts() {
  npm run --silent check
}

step_python() {
  python3 - "$ROOT" "$OUT/python.jsonl" <<'PY'
# One record per unittest in each scripts/test_*.py file that the case map or
# node-waves.json references; the record name is the test's docstring.
import importlib.util, json, os, sys, unittest
from pathlib import Path

root, out = Path(sys.argv[1]), Path(sys.argv[2])
commit = os.environ.get('ATMUSIC_ACCEPTANCE_COMMIT', 'unknown')
case_map = json.loads((root / 'docs/verification/ts-case-map.json').read_text())
node_waves = json.loads((root / 'docs/planning/node-waves.json').read_text())
refs = [ref for entry in case_map['cases'] for ref in [entry['target'], *entry.get('also', [])]]
refs += [test for wave in node_waves for package in wave['packages'] for test in package['tests']]
files = sorted({ref.split(' › ', 1)[0] for ref in refs
                if ref.split(' › ', 1)[0].startswith('scripts/') and ref.split(' › ', 1)[0].endswith('.py')
                and Path(ref.split(' › ', 1)[0]).name.startswith('test_') and (root / ref.split(' › ', 1)[0]).is_file()})
records, ok = [], bool(files)
for rel in files:
    path = root / rel
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    suite = unittest.defaultTestLoader.loadTestsFromModule(module)

    class Recorder(unittest.TextTestResult):
        def _record(self, test, result):
            name = test.shortDescription() or test.id().rsplit('.', 1)[-1]
            records.append({'target': f'{rel} › {name}', 'command': f'python3 -m unittest {rel}',
                            'executed': 0 if result == 'skipped' else 1, 'result': result, 'commit': commit})
        def addSuccess(self, test):
            super().addSuccess(test); self._record(test, 'passed')
        def addFailure(self, test, err):
            super().addFailure(test, err); self._record(test, 'failed')
        def addError(self, test, err):
            super().addError(test, err); self._record(test, 'failed')
        def addSkip(self, test, reason):
            super().addSkip(test, reason); self._record(test, 'skipped')

    print(f'--- {rel}')
    result = unittest.TextTestRunner(resultclass=Recorder, verbosity=2, stream=sys.stdout).run(suite)
    ok &= result.wasSuccessful() and result.testsRun > 0
out.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records))
executed = sum(r['executed'] for r in records)
print(f"python: {len(files)} files, executed={executed} failed={sum(r['result'] == 'failed' for r in records)}")
sys.exit(0 if ok and executed > 0 else 1)
PY
}

step_case_map() {
  python3 scripts/validate_case_map.py --check-tests --node-wave "$WAVE"
}

step_goldens() {
  bash scripts/check_goldens.sh
}

# The live gates: every scripts/live/*.ts module that exports its gate `spec`.
live_gates() {
  local file
  for file in scripts/live/*.ts; do
    grep -q '^export const spec' "$file" && basename "$file" .ts
  done
}

step_live_noenv() {
  local gate unset_args=() name status all=0 count=0
  while IFS= read -r name; do unset_args+=(-u "$name"); done < <(compgen -e | grep '^ATMUSIC_LIVE_' || true)
  live_gates > "$OUT/live-gates.txt"
  while IFS= read -r gate; do
    count=$((count + 1))
    env "${unset_args[@]}" npx tsx "scripts/live/$gate.ts" > "$OUT/live-noenv-$gate.json" 2> "$OUT/live-noenv-$gate.stderr"
    status=$?
    echo "$status" > "$OUT/live-noenv-$gate.exit"
    echo "$gate: exit $status"
    sed 's/^/  /' "$OUT/live-noenv-$gate.stderr"
    # Exactly "blocked" (2), with a document that lists the missing names.
    if [[ $status -ne 2 ]] || ! python3 -c '
import json, sys
doc = json.load(open(sys.argv[1]))
sys.exit(0 if isinstance(doc, dict) and doc.get("result") == "blocked" and isinstance(doc.get("missing"), list) and doc["missing"] else 1)
' "$OUT/live-noenv-$gate.json" 2>/dev/null; then
      echo "$gate: expected exit 2 with a blocked document listing missing prerequisites"
      all=1
    fi
  done < "$OUT/live-gates.txt"
  if [[ $count -eq 0 ]]; then
    echo "no live gate found under scripts/live"
    all=1
  fi
  return $all
}

step_e2e() {
  PLAYWRIGHT_JSON_OUTPUT_FILE="$OUT/e2e-report.json" npx playwright test --reporter=list,json
}

printf 'node-interim: wave %s, commit %s\n' "$WAVE" "$COMMIT"
run_step check-ts 'npm run check' step_check_ts
run_step python 'python3 -m unittest <case-map and node-waves scripts/test_*.py>' step_python
run_step case-map "python3 scripts/validate_case_map.py --check-tests --node-wave $WAVE" step_case_map
run_step goldens 'bash scripts/check_goldens.sh' step_goldens
run_step live-noenv 'npx tsx scripts/live/<gate>.ts (no env)' step_live_noenv
if [[ $WAVE -ge $E2E_WAVE ]]; then
  run_step e2e 'npx playwright test' step_e2e
else
  pending e2e "$E2E_WAVE" 'npx playwright test (Playwright browser journeys on the Node stack, N6-01)'
fi
printf '\n==> live evidence: pending until wave %s (Node live gates and evidence keyed by the Node bundle, N6-02)\n' "$LIVE_EVIDENCE_WAVE"
printf '==> case-map closure over executed test records: pending until wave %s (scripts/acceptance/node-backend.sh, N8-01)\n' "$CLOSURE_WAVE"

python3 - "$OUT" "$WAVE" "$COMMIT" "$LIVE_EVIDENCE_WAVE" "$CLOSURE_WAVE" "${STEPS[@]}" <<'PY'
import json, sys
from pathlib import Path

out, wave, commit, live_wave, closure_wave = Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
steps = sys.argv[6:]


def read(name, default=''):
    try:
        return (out / name).read_text(encoding='utf-8', errors='replace').strip()
    except OSError:
        return default


summary_steps, problems = {}, []
for step in steps:
    status = read(f'{step}.status', 'missing')
    entry = {'command': read(f'{step}.command', step)}
    if status.startswith('pending until wave '):
        entry.update(result='pending', pendingUntilWave=int(status.rsplit(' ', 1)[1]))
    elif status == 'skipped':
        entry.update(result='skipped')
        problems.append(f'step {step} was disabled with --skip; a disabled step is never a pass')
    elif status == '0':
        entry.update(result='passed', exit=0)
    else:
        entry.update(result='failed', exit=int(status) if status.lstrip('-').isdigit() else None)
        problems.append(f"step {step} ({entry['command']}) exited {status}")
    summary_steps[step] = entry
records = [json.loads(line) for line in read('python.jsonl').splitlines() if line.strip()]
summary = {
    'gate': 'scripts/acceptance/node-interim.sh',
    'wave': wave,
    'commit': commit,
    'steps': summary_steps,
    'pending': {'e2e': summary_steps['e2e'].get('pendingUntilWave'), 'liveEvidence': live_wave, 'caseMapClosure': closure_wave},
    'python': {k: sum(1 for r in records if r['result'] == k) for k in ('passed', 'failed', 'skipped')},
    'liveGates': [g for g in read('live-gates.txt').splitlines() if g],
    'result': 'passed' if not problems else 'failed',
    'problems': problems,
}
(out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print()
for step, entry in summary_steps.items():
    detail = f" until wave {entry['pendingUntilWave']}" if entry['result'] == 'pending' else ''
    print(f"{entry['result'].upper():8} {step}{detail}: {entry['command']}")
for problem in problems:
    print(f'FAIL node-interim: {problem}')
if problems:
    print(f'FAIL node-interim: wave {wave}, {len(problems)} problem(s); summary {out / "summary.json"}')
    sys.exit(1)
print(f'PASS node-interim: wave {wave}; every step of this wave passed; summary {out / "summary.json"}')
sys.exit(0)
PY
