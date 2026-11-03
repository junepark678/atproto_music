#!/usr/bin/env bash
# Node backend acceptance gate (ADR 0005 §15; N8-01).
#
# Replaces the interim scripts/acceptance/node-interim.sh (N0-02) and the retired
# scripts/acceptance/workers-backend.sh (W7-01). Every deterministic suite runs
# for real; the live gates are only ever *checked* (their no-environment refusal
# and the recorded evidence inventory), never executed: no real network is
# contacted and nothing is deployed.
#
# Exit 0 only when every step passed and every case of
# docs/verification/ts-case-map.json maps to an executed, passing record (or a
# retirement with a reason) while the live gates are listed as blocked or carry
# bundle-bound verified evidence. Exit 1 on any step failure, any --skip, a
# blocked deterministic step (systemd-analyze unavailable), any unexecuted or
# pending mapped target, or a live gate recorded as failed. Exit 2 on usage
# errors (including a non-empty --out not created by this gate).
set -uo pipefail

CALLER_PWD="$PWD"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

STEPS=(check-ts node-tests e2e scrobbler-e2e python check-node-bundle case-map goldens systemd live-noenv live)
DEFAULT_OUT="$ROOT/work/acceptance/node-backend"
OUT="$DEFAULT_OUT"
MARKER=".node-backend-gate"
BLOCKED_EXIT=75
SKIP=()

usage() {
  echo "usage: $0 [--out DIR] [--skip STEP]...  (steps: ${STEPS[*]})" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

mkdir -p "$OUT" || exit 2
OUT="$(cd "$OUT" && pwd)" || exit 2
if [[ "$OUT" != "$DEFAULT_OUT" && ! -f "$OUT/$MARKER" && -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  echo "node-backend: refusing --out $OUT: it is not empty and was not created by this gate" \
    "(no $MARKER); pass a new or empty directory" >&2
  exit 2
fi
echo "output directory of scripts/acceptance/node-backend.sh; its known files are replaced on each run" > "$OUT/$MARKER" || exit 2

stale=(check-ts.jsonl node-tests-report.json node-tests.jsonl e2e-report.json scrobbler-e2e.jsonl python.jsonl
  live-gates.txt live-inventory.txt live-inventory.exit tests.jsonl cases.jsonl live.json summary.json)
for s in "${STEPS[@]}"; do stale+=("$s.log" "$s.status" "$s.command"); done
for f in "${stale[@]}"; do rm -f -- "${OUT:?}/$f"; done
rm -f -- "$OUT"/live-noenv-*.json "$OUT"/live-noenv-*.stderr "$OUT"/live-noenv-*.exit

# Python helpers live in the repository venv when one exists (this worktree's or the main checkout's).
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

# run_step NAME LABEL FUNCTION: writes NAME.command, NAME.log and NAME.status
# (the exit code, "skipped", or "blocked" when FUNCTION returned BLOCKED_EXIT).
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
  if [[ $status -eq $BLOCKED_EXIT ]]; then
    echo "blocked" > "$OUT/$name.status"
    printf '    BLOCKED after %ss (log %s); a blocked deterministic step fails the gate\n' "$((SECONDS - start))" "${OUT#"$ROOT"/}/$name.log"
    tail -n 25 "$OUT/$name.log" | sed 's/^/    | /'
    return
  fi
  echo "$status" > "$OUT/$name.status"
  printf '    exit %s after %ss (log %s)\n' "$status" "$((SECONDS - start))" "${OUT#"$ROOT"/}/$name.log"
  if [[ $status -ne 0 ]]; then tail -n 25 "$OUT/$name.log" | sed 's/^/    | /'; fi
}

step_check_ts() {
  rm -f work/ts-test-cases.jsonl
  bash scripts/check-ts.sh
  local status=$?
  if [[ -f work/ts-test-cases.jsonl ]]; then cp work/ts-test-cases.jsonl "$OUT/check-ts.jsonl"; fi
  return $status
}

step_node_tests() {
  local report="$OUT/node-tests-report.json" status
  npx vitest run --project worker-node --project worker-acceptance --reporter=default --reporter=json --outputFile.json="$report"
  status=$?
  npx tsx scripts/report-tests.ts "$report" --command "npx vitest run --project worker-node --project worker-acceptance" --out "$OUT/node-tests.jsonl" || return 1
  return $status
}

step_e2e() {
  local name ports i=0
  read -r -a ports < <(python3 -c '
import socket
held = [socket.socket() for _ in range(5)]
for s in held:
    s.bind(("127.0.0.1", 0))
print(" ".join(str(s.getsockname()[1]) for s in held))')
  for name in E2E_WORKER_PORT E2E_PLC_PORT E2E_PDS1_PORT E2E_PDS2_PORT E2E_PROXY_PORT; do
    if [[ -z "${!name:-}" ]]; then export "$name=${ports[$i]}"; fi
    i=$((i + 1))
    echo "$name=${!name}"
  done
  PLAYWRIGHT_JSON_OUTPUT_FILE="$OUT/e2e-report.json" npx playwright test --reporter=list,json
}

step_scrobbler_e2e() {
  if [[ ! -f scripts/e2e/scrobbler-e2e.ts ]]; then
    echo "scripts/e2e/scrobbler-e2e.ts does not exist; the scrobbler end-to-end suite did not run"
    return 1
  fi
  ATMUSIC_ACCEPTANCE_RECORDS="$OUT/scrobbler-e2e.jsonl" npx tsx scripts/e2e/scrobbler-e2e.ts
}

step_python() {
  python3 - "$ROOT" "$OUT/python.jsonl" <<'PY'
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
            # Method docstrings end with a period; the case map and validate_case_map.py cite the
            # module-docstring bullet, which does not.
            name = (test.shortDescription() or test.id().rsplit('.', 1)[-1]).rstrip('.')
            records.append({'target': f'{rel} › {name}', 'command': f'python3 -m unittest {rel}',
                            'executed': 0 if result == 'skipped' else 1, 'result': result, 'commit': commit})

        def addSuccess(self, test):
            super().addSuccess(test)
            self._record(test, 'passed')

        def addFailure(self, test, err):
            super().addFailure(test, err)
            self._record(test, 'failed')

        def addError(self, test, err):
            super().addError(test, err)
            self._record(test, 'failed')

        def addSkip(self, test, reason):
            super().addSkip(test, reason)
            self._record(test, 'skipped')

    print(f'--- {rel}')
    result = unittest.TextTestRunner(resultclass=Recorder, verbosity=2, stream=sys.stdout).run(suite)
    ok &= result.wasSuccessful() and result.testsRun > 0
out.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records))
executed = sum(r['executed'] for r in records)
print(f"python: {len(files)} files, executed={executed} failed={sum(r['result'] == 'failed' for r in records)}")
sys.exit(0 if ok and executed > 0 else 1)
PY
}

step_check_node_bundle() {
  npx tsx scripts/check-node-bundle.ts
}

# ADR 0005 §15.3: without --node-wave every mapped target must exist now; a
# pending target is a failure of this gate, never a deferral.
step_case_map() {
  python3 scripts/validate_case_map.py --check-tests
}

step_goldens() {
  bash scripts/check_goldens.sh
}

SYSTEMD_UNITS=(config/systemd/atmusic.service config/systemd/atmusic.socket)

step_systemd() {
  local unit missing=0
  for unit in "${SYSTEMD_UNITS[@]}"; do
    if [[ ! -f "$unit" ]]; then
      echo "systemd unit missing: $unit"
      missing=1
    fi
  done
  [[ $missing -eq 0 ]] || return 1
  if ! command -v systemd-analyze > /dev/null 2>&1; then
    echo "BLOCKED: systemd-analyze is not installed; the units were not verified (a blocked deterministic step fails the gate)"
    return $BLOCKED_EXIT
  fi
  systemd-analyze --user verify "${SYSTEMD_UNITS[@]}" && echo "PASS systemd: ${SYSTEMD_UNITS[*]} verified"
}

live_gates() {
  local file
  for file in scripts/live/*.ts; do
    grep -q '^export const spec' "$file" && basename "$file" .ts
  done
}

# Every live gate script, run with every ATMUSIC_LIVE_* variable unset, must
# answer exit 2 with a blocked document listing its missing prerequisites.
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

# The recorded live evidence inventory, verified independently against this
# checkout's commit and the bundle SHA-256 printed by check-node-bundle. The
# step passes on "complete" (0) or "blocked" (2); a recorded failure (1) fails.
step_live() {
  local inventory="${ATMUSIC_LIVE_INVENTORY:-$ROOT/docs/verification/live-evidence.json}" bundle head status args=(--node)
  bundle="$(sed -n 's/^bundle sha256 \([0-9a-f]\{64\}\)  main\.mjs$/\1/p' "$OUT/check-node-bundle.log" 2>/dev/null | tail -n 1)"
  head="$(git rev-parse HEAD 2>/dev/null || true)"
  if [[ "$head" =~ ^[0-9a-f]{40}$ ]]; then args+=(--commit "$head"); else echo "commit: not a git checkout; the inventory cannot be bound to a commit"; fi
  if [[ -n "$bundle" ]]; then args+=(--bundle-sha256 "$bundle"); else echo "bundle: check-node-bundle printed no bundle SHA-256; the inventory cannot be bound to a bundle"; fi
  echo "inventory: $inventory"
  python3 scripts/verify_live_evidence.py "$inventory" "${args[@]}" > "$OUT/live-inventory.txt" 2>&1
  status=$?
  echo "$status" > "$OUT/live-inventory.exit"
  cat "$OUT/live-inventory.txt"
  echo "verify_live_evidence: exit $status"
  [[ $status -eq 0 || $status -eq 2 ]]
}

echo "node-backend acceptance gate: commit $COMMIT, out ${OUT#"$ROOT"/}"
run_step check-ts 'bash scripts/check-ts.sh' step_check_ts
run_step node-tests 'npx vitest run --project worker-node --project worker-acceptance' step_node_tests
run_step e2e 'npx playwright test' step_e2e
run_step scrobbler-e2e 'npx tsx scripts/e2e/scrobbler-e2e.ts' step_scrobbler_e2e
run_step python 'python3 -m unittest (scripts/test_*.py referenced by the case map)' step_python
run_step check-node-bundle 'npx tsx scripts/check-node-bundle.ts' step_check_node_bundle
run_step case-map 'python3 scripts/validate_case_map.py --check-tests' step_case_map
run_step goldens 'bash scripts/check_goldens.sh' step_goldens
run_step systemd "systemd-analyze --user verify ${SYSTEMD_UNITS[*]}" step_systemd
run_step live-noenv 'npx tsx scripts/live/<gate>.ts (every ATMUSIC_LIVE_* unset)' step_live_noenv
run_step live 'python3 scripts/verify_live_evidence.py --node --commit HEAD --bundle-sha256 <check-node-bundle>' step_live

printf '\n==> closure: docs/verification/ts-case-map.json over executed records\n'
python3 - "$ROOT" "$OUT" "${STEPS[@]}" <<'PY'
import json, os, re, sys
from pathlib import Path

root, out, steps = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]
commit = os.environ.get('ATMUSIC_ACCEPTANCE_COMMIT', 'unknown')
SEP = ' › '
SELF = 'bash scripts/acceptance/node-backend.sh'
GATE_NAMES = ('oauth', 'ingest', 'pdsCompat', 'ssrfProbe', 'socketSoak')


def read(name, default=''):
    path = out / name
    if not path.is_file():
        return default
    return path.read_text(encoding='utf-8', errors='replace') or default


status = {s: read(f'{s}.status', 'missing').strip() for s in steps}
command = {s: read(f'{s}.command', s).strip() for s in steps}
log = {s: read(f'{s}.log') for s in steps}

bundle_match = re.findall(r'^bundle sha256 ([0-9a-f]{64})  main\.mjs$', log['check-node-bundle'], re.M)
bundle = bundle_match[-1] if bundle_match and 'PASS check-node-bundle' in log['check-node-bundle'] else None

# Executed records: vitest (check-ts and the Node projects), Python, Playwright and the scrobbler suite.
records, by_source = [], {}
for source in ('check-ts.jsonl', 'node-tests.jsonl', 'python.jsonl', 'scrobbler-e2e.jsonl'):
    lines = [l for l in read(source).splitlines() if l.strip()]
    by_source[source.rsplit('.', 1)[0]] = len(lines)
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and isinstance(rec.get('target'), str):
            rec.setdefault('command', source)
            rec.setdefault('executed', 1)
            rec.setdefault('result', 'failed')
            rec.setdefault('commit', commit)
            records.append(rec)


def playwright_records(report):
    base = Path(report.get('config', {}).get('rootDir') or root / 'web/tests')
    found = []

    def walk(suite, titles):
        for spec in suite.get('specs', []):
            rel = os.path.relpath(base / spec['file'], root).replace(os.sep, '/')
            for test in spec.get('tests', []):
                outcome = test.get('status')
                result = {'expected': 'passed', 'unexpected': 'failed', 'flaky': 'failed'}.get(outcome, 'skipped')
                found.append({'target': SEP.join([rel, *titles, spec['title']]), 'command': 'npx playwright test',
                              'executed': 0 if result == 'skipped' else 1, 'result': result, 'commit': commit})
        for child in suite.get('suites', []):
            walk(child, [*titles, child['title']])

    for top in report.get('suites', []):
        walk(top, [])
    return found


try:
    e2e_records = playwright_records(json.loads(read('e2e-report.json', '{}') or '{}'))
except (ValueError, TypeError, KeyError):
    e2e_records = []
records += e2e_records
by_source['e2e'] = len(e2e_records)

# The scrobbler suite without a records file: its "PASS <title>" / "FAIL <title>" lines stand in.
if by_source['scrobbler-e2e'] == 0 and status['scrobbler-e2e'] not in ('skipped', 'missing'):
    for line in log['scrobbler-e2e'].splitlines():
        m = re.fullmatch(r'(PASS|FAIL) (.+)', line.rstrip())
        if m and not m.group(2).startswith('scrobbler-e2e'):
            records.append({'target': 'scripts/e2e/scrobbler-e2e.ts' + SEP + m.group(2).strip(), 'command': command['scrobbler-e2e'],
                            'executed': 1, 'result': 'passed' if m.group(1) == 'PASS' else 'failed', 'commit': commit})
            by_source['scrobbler-e2e'] += 1


def synthetic(target, cmd, ok):
    return {'target': target, 'command': cmd, 'executed': 1, 'result': 'passed' if ok else 'failed', 'commit': commit}


contracts_lines, in_contracts = [], False
for l in log['check-ts'].splitlines():
    if l.startswith('==> '):
        in_contracts = l.startswith('==> contracts')
    elif in_contracts and l.startswith('PASS '):
        contracts_lines.append(l[5:])

case_map_text = log['case-map']
pending_lines = [l for l in case_map_text.splitlines() if l.startswith('PENDING case map:')]
case_map_ok = (status['case-map'] == '0' and '258 unique cases' in case_map_text
               and 'every referenced test file and name exists' in case_map_text and not pending_lines)

# live-noenv: one refusal document per live gate script.
noenv = {}
for script in [l.strip() for l in read('live-gates.txt').splitlines() if l.strip()]:
    exit_code = read(f'live-noenv-{script}.exit', 'missing').strip()
    try:
        doc = json.loads(read(f'live-noenv-{script}.json', '{}') or '{}')
    except ValueError:
        doc = {}
    if not isinstance(doc, dict):
        doc = {}
    missing = doc.get('missing') if isinstance(doc.get('missing'), list) else []
    ok = (status['live-noenv'] not in ('skipped', 'missing') and exit_code == '2' and doc.get('result') == 'blocked' and bool(missing))
    noenv[script] = {'ok': ok, 'exit': exit_code, 'missing': [str(m) for m in missing], 'gate': doc.get('gate') if isinstance(doc.get('gate'), str) else None}


def resolve(test_id):
    """Records answering one mapped target; [] when none executed; None for the gate itself."""
    if SEP not in test_id:
        return []
    prefix, name = test_id.split(SEP, 1)
    if prefix == SELF:
        return None
    if prefix == 'python3 scripts/validate_contracts.py':
        if status['check-ts'] in ('skipped', 'missing'):
            return []
        hit = any(l == name or l.startswith(name + ':') or l.startswith(name + ' (') for l in contracts_lines)
        return [synthetic(test_id, prefix, True)] if hit else []
    if prefix == 'npx tsx scripts/check-node-bundle.ts':
        if status['check-node-bundle'] in ('skipped', 'missing'):
            return []
        return [synthetic(test_id, prefix, status['check-node-bundle'] == '0' and bundle is not None)]
    if prefix == 'python3 scripts/validate_case_map.py --check-tests':
        if status['case-map'] in ('skipped', 'missing'):
            return []
        return [synthetic(test_id, prefix, case_map_ok)]
    live = re.fullmatch(r'npx tsx scripts/live/(\w+)\.ts \(no env\)', prefix)
    if live and live.group(1) in noenv:
        return [synthetic(test_id, prefix, noenv[live.group(1)]['ok'])]
    file_prefix = prefix + SEP
    return [r for r in records if r['target'] == test_id or r['target'].endswith(SEP + test_id)
            or (r['target'].startswith(file_prefix) and r['target'].endswith(SEP + name))]


case_map = json.loads((root / 'docs/verification/ts-case-map.json').read_text(encoding='utf-8'))
cases, self_cases = [], []
for entry in case_map['cases']:
    target = entry['target']
    if target.startswith('retired:'):
        cases.append({'case': entry['case'], 'result': 'retired', 'targets': [target], 'commands': [], 'count': 0,
                      'commit': commit, 'bundleSha256': bundle, 'reason': entry.get('reason', '')})
        continue
    refs = [target, *entry.get('also', [])]
    commands, count, omitted, failed, pending_self = [], 0, [], [], False
    for ref in refs:
        found = resolve(ref)
        if found is None:
            pending_self = True
            if SELF not in commands:
                commands.append(SELF)
            continue
        ran = [r for r in found if r.get('executed', 0) > 0]
        count += len(ran)
        commands += sorted({r['command'] for r in ran} - set(commands))
        if not ran:
            omitted.append(ref)
        elif any(r.get('result') != 'passed' for r in ran):
            failed.append(ref)
    record = {'case': entry['case'], 'result': 'failed' if omitted or failed else 'passed', 'targets': refs,
              'commands': commands, 'count': count, 'commit': commit, 'bundleSha256': bundle}
    if omitted:
        record['notRun'] = omitted
    if failed:
        record['failedTests'] = failed
    cases.append(record)
    if pending_self:
        self_cases.append(record)

# Live gates: blocked unless the independently verified inventory binds a passing result to this bundle.
inventory_text = read('live-inventory.txt')
inventory_exit = read('live-inventory.exit', 'missing').strip()
gate_states = dict(re.findall(r'(\w+)=(passed|failed|blocked)', ' '.join(l for l in inventory_text.splitlines() if 'gates:' in l)))
scripts_by_gate = {}
for script, info in noenv.items():
    gate = info['gate']
    if gate is None:
        gate = {'oauth': 'oauth', 'ingest': 'ingest', 'pds_compat': 'pdsCompat', 'ssrf': 'ssrfProbe', 'socket': 'socketSoak'}.get(
            next((k for k in ('oauth', 'ingest', 'pds_compat', 'ssrf', 'socket') if k in script), ''), None)
    if gate is None:
        continue
    current = scripts_by_gate.get(gate)
    if current is None or (script.startswith('node_') and not current.startswith('node_')):
        scripts_by_gate[gate] = script
live_ran = status['live'] not in ('skipped', 'missing')
live = []
for gate in GATE_NAMES:
    script = scripts_by_gate.get(gate)
    script_path = f'scripts/live/{script}.ts' if script else '(no live gate script found)'
    missing = noenv[script]['missing'] if script else []
    state = gate_states.get(gate, 'blocked')
    if not live_ran:
        state, message = 'blocked', f'live step did not run (status {status["live"]})'
    elif state == 'passed' and inventory_exit != '0':
        state, message = 'blocked', f'inventory reports {gate}=passed but verify_live_evidence.py exited {inventory_exit}; not accepted as passed'
    elif state == 'passed':
        message = f'recorded evidence: verified passing {gate} result bound to commit {commit} and bundle {bundle}'
    elif state == 'failed':
        message = f'recorded evidence: a failed {gate} result is bound to bundle {bundle or "(unknown)"} in the inventory'
    else:
        message = (f'recorded evidence: no passing {gate} result bound to bundle {bundle or "(unknown)"} in the inventory; '
                   f'run npx tsx {script_path} and record its document')
    live.append({'gate': gate, 'script': script_path, 'result': state, 'missing': missing, 'message': message})

BLOCKED_IS_THE_EXPECTATION = {'M2.4.3/live_credentials_missing', 'M4.4.1/coverage_failure'}
INVENTORY_CASES = {'M6.4.3/live_inventory'}
inventory_passed = live_ran and status['live'] == '0' and inventory_exit == '0'
noenv_target = re.compile(r'^npx tsx scripts/live/\w+\.ts \(no env\)' + re.escape(SEP))
for c in cases:
    if c['result'] != 'passed' or c['case'] in BLOCKED_IS_THE_EXPECTATION:
        continue
    if c['case'] in INVENTORY_CASES or any(noenv_target.match(t) for t in c['targets']):
        if not inventory_passed:
            c['result'] = 'blocked'
            c['blockedBy'] = (f'live evidence: no passing scripts/verify_live_evidence.py --node inventory for commit {commit} '
                              f'and bundle {bundle or "(unknown)"}; the deterministic refusal check passed')

problems = []
for s in steps:
    st = status[s]
    if st == 'skipped':
        problems.append(f'step {s} was disabled with --skip; a disabled step is never a pass')
    elif st == 'blocked':
        problems.append(f'step {s} is blocked ({command[s]}: tool unavailable); a blocked deterministic step is never a pass')
    elif st != '0':
        problems.append(f'step {s} ({command[s]}) exited {st}')
for l in pending_lines:
    problems.append(f'case map: {l[len("PENDING case map:"):].strip()} (ADR 0005 §15.3: no mapped target may be pending)')
for c in cases:
    if c in self_cases:
        continue
    if c.get('notRun'):
        problems.append(f"case {c['case']}: not executed: {'; '.join(c['notRun'])}")
    if c.get('failedTests'):
        problems.append(f"case {c['case']}: failed: {'; '.join(c['failedTests'])}")
for g in live:
    if g['result'] == 'failed':
        problems.append(f"live gate {g['gate']} recorded a failure for bundle {bundle or '(unknown)'}")
if bundle is None:
    problems.append('no Node bundle SHA-256: check-node-bundle did not pass')

gate_ok = not problems
for c in self_cases:
    c['count'] += 1
    if not gate_ok:
        c['result'] = 'failed'
        c.setdefault('failedTests', []).append(f'{SELF} (the gate itself failed)')
self_note = 'every step passed and every mapped case executed' if gate_ok else f'{len(problems)} problem(s)'

tests_by_result = {k: sum(1 for r in records if r.get('result') == k) for k in ('passed', 'failed', 'skipped', 'todo')}
summary = {
    'gate': 'node-backend',
    'commit': commit,
    'bundleSha256': bundle,
    'steps': {s: {'command': command[s], 'exit': status[s]} for s in steps},
    'tests': {'executed': sum(1 for r in records if r.get('executed', 0) > 0), **tests_by_result, 'bySource': by_source},
    'cases': {'total': len(cases), **{k: sum(1 for c in cases if c['result'] == k) for k in ('passed', 'failed', 'blocked', 'retired')}},
    'live': {k: sum(1 for g in live if g['result'] == k) for k in ('passed', 'failed', 'blocked')},
    'liveGates': live,
    'result': 'passed' if gate_ok else 'failed',
    'problems': problems,
}
(out / 'tests.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records), encoding='utf-8')
(out / 'cases.jsonl').write_text(''.join(json.dumps(c, ensure_ascii=False) + '\n' for c in cases), encoding='utf-8')
(out / 'live.json').write_text(json.dumps(live, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
(out / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

short = commit[:12]
for c in cases:
    detail = ''
    if c.get('notRun'):
        detail = f" notRun={'; '.join(c['notRun'])}"
    elif c.get('failedTests'):
        detail = f" failed={'; '.join(c['failedTests'])}"
    elif c.get('blockedBy'):
        detail = f" blockedBy={c['blockedBy']}"
    print(f"{c['result'].upper():8} {c['case']} count={c['count']} commit={short} bundle={(bundle or 'none')[:16]} "
          f"command={'; '.join(c['commands']) or '-'} target={c['targets'][0]}{detail}")
for g in live:
    print(f"LIVE {g['result'].upper():7} {g['gate']} ({g['script']})")
    names = [m.split(':', 1)[0] if re.match(r'^[A-Z][A-Z0-9_]+:', m) else m for m in g['missing']]
    if names:
        print(f"    missing ({len(names)}): {', '.join(names)}")
    print(f"    {g['message']}")
for p in problems:
    print(f'FAIL acceptance: {p}')
t, cs, lv = summary['tests'], summary['cases'], summary['live']
print(f"tests: executed={t['executed']} passed={t['passed']} failed={t['failed']} skipped={t['skipped']} "
      f"(sources: {', '.join(f'{k}={v}' for k, v in by_source.items())})")
print(f"cases: total={cs['total']} passed={cs['passed']} failed={cs['failed']} blocked={cs['blocked']} retired={cs['retired']}")
print(f"live gates: passed={lv['passed']} failed={lv['failed']} blocked={lv['blocked']}")
print(f"commit {commit}; bundle {bundle or '(none)'}; summary {out / 'summary.json'}")
if gate_ok:
    print(f"PASS node-backend: {self_note}; {lv['blocked']} live gate(s) and {cs['blocked']} live case(s) are blocked, not passed")
    sys.exit(0)
print(f'FAIL node-backend: {self_note}')
sys.exit(1)
PY
