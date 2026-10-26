#!/usr/bin/env bash
# Workers backend acceptance gate and 258-case map closure (W7-01; ADR 0004
# §10.1, §10.4, A18, A19; docs/verification/backend-workers.md).
#
#   bash scripts/acceptance/workers-backend.sh [--out DIR] [--skip STEP]...
#
# Runs every deterministic suite, then closes docs/verification/ts-case-map.json
# over what actually executed:
#
#   check-ts      bash scripts/check-ts.sh (typecheck, lint, the whole vitest
#                 workspace with per-test records, contracts, case map, bundle)
#   acceptance    the worker-acceptance vitest project on its own (real IndexDO
#                 in workerd), with its own per-test records
#   e2e           npm run test:e2e (Playwright against wrangler dev and a local
#                 @atproto/dev-env; mapped browser cases need it)
#   python        the scripts/test_*.py regressions the case map references, one
#                 record per test
#   check-bundle  npx tsx scripts/check-bundle.ts (production guard; prints the
#                 Worker bundle SHA-256 that every record carries)
#   case-map      python3 scripts/validate_case_map.py --check-tests
#   goldens       bash scripts/check_goldens.sh (Rust-oracle goldens unchanged)
#   live-noenv    every scripts/live gate with all ATMUSIC_LIVE_* removed must
#                 exit 2 with a `blocked` document listing missing names, before
#                 any network request
#   live          live gate status: prerequisites missing from the operator's
#                 environment (computed with each gate's own requirement list,
#                 no gate body runs), else the recorded inventory checked by
#                 scripts/verify_live_evidence.py against this bundle hash
#
# This script never runs a live gate body, never deploys and never contacts
# Cloudflare, a PDS, a relay or Jetstream. The live gates are run separately by
# the operator (docs/verification/workers-live.md); their recorded evidence is
# classified here.
#
# Output (default work/acceptance/workers-backend/; a relative --out is
# relative to the caller's directory, and a non-empty --out without the gate's
# .workers-backend-gate marker is refused with exit 2): one log per step,
# tests.jsonl (every executed test record), cases.jsonl (one record per plan
# case: case, result, targets, commands, count, commit, bundleSha256),
# live.json and summary.json. stdout lists each case record and the summary,
# with passed, failed, skipped and blocked counted separately.
#
# Exit status: 0 when every step passed and every mapped case's tests executed
# and passed (live gates may be blocked; they are listed as blocked, never as
# passed); 1 on any failure, any mapped case whose test did not run (an omitted,
# filtered or skipped test is a failure that names the case), any live gate
# that recorded a failure for this bundle, or any --skip (a disabled step is
# never a pass); 2 on a usage error.
set -uo pipefail

# A relative --out is relative to the caller's directory, not the repo root.
CALLER_PWD="$PWD"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

STEPS=(check-ts acceptance e2e python check-bundle case-map goldens live-noenv live)
LIVE_GATES=(workers_oauth_check workers_ingest_check pds_compat_check ssrf_probe workers_socket_soak)
DEFAULT_OUT="$ROOT/work/acceptance/workers-backend"
OUT="$DEFAULT_OUT"
# Written into every output directory the gate owns. A non-empty --out
# directory without it is refused, so the cleanup below never touches a
# directory the gate did not create.
MARKER=".workers-backend-gate"
SKIP=()

usage() {
  echo "usage: $0 [--out DIR] [--skip STEP]...  (steps: ${STEPS[*]})" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      [[ $# -ge 2 ]] || usage
      OUT="$2"
      [[ -n "$OUT" ]] || usage
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
  echo "workers-backend: refusing --out $OUT: it is not empty and was not created by this gate" \
    "(no $MARKER); pass a new or empty directory" >&2
  exit 2
fi
echo "output directory of scripts/acceptance/workers-backend.sh; its known files are replaced on each run" \
  > "$OUT/$MARKER" || exit 2
# Remove the previous run's records: only the file names this gate writes.
stale=(check-ts.jsonl acceptance-report.json acceptance.jsonl e2e-report.json python.jsonl
  live-prerequisites.ts live-prerequisites.mts live-prerequisites.json live-inventory.txt live-inventory.exit
  tests.jsonl cases.jsonl live.json summary.json)
for s in "${STEPS[@]}"; do stale+=("$s.log" "$s.status" "$s.command"); done
for g in "${LIVE_GATES[@]}"; do stale+=("live-noenv-$g.json" "live-noenv-$g.stderr" "live-noenv-$g.exit"); done
for f in "${stale[@]}"; do rm -f -- "${OUT:?}/$f"; done

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
  rm -f work/ts-test-cases.jsonl
  bash scripts/check-ts.sh
  local status=$?
  if [[ -f work/ts-test-cases.jsonl ]]; then cp work/ts-test-cases.jsonl "$OUT/check-ts.jsonl"; fi
  return $status
}

step_acceptance() {
  local report="$OUT/acceptance-report.json" status
  npx vitest run --project worker-acceptance --reporter=default --reporter=json --outputFile.json="$report"
  status=$?
  npx tsx scripts/report-tests.ts "$report" --command "npx vitest run --project worker-acceptance" \
    --out "$OUT/acceptance.jsonl" || return 1
  return $status
}

step_e2e() {
  # The stack binds five loopback ports (scripts/e2e/dev-env.ts). Unless the
  # operator pinned them with E2E_*_PORT, take currently free ones so a
  # `wrangler dev` already on 8787 does not fail the run.
  local name ports i=0
  # Five distinct free ports, all held open until every one is chosen.
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

step_python() {
  python3 - "$ROOT" "$OUT/python.jsonl" <<'PY'
# One record per unittest in each scripts/test_*.py file the case map
# references; the record name is the test's docstring (its case-map name).
import importlib.util, json, os, sys, unittest
from pathlib import Path

root, out = Path(sys.argv[1]), Path(sys.argv[2])
commit = os.environ.get('ATMUSIC_ACCEPTANCE_COMMIT', 'unknown')
case_map = json.loads((root / 'docs/verification/ts-case-map.json').read_text())
files = sorted({ref.split(' › ', 1)[0] for entry in case_map['cases']
                for ref in [entry['target'], *entry.get('also', [])]
                if ref.split(' › ', 1)[0].startswith('scripts/test_') and ref.split(' › ', 1)[0].endswith('.py')})
records, ok = [], True
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

step_check_bundle() {
  npx tsx scripts/check-bundle.ts
}

step_case_map() {
  python3 scripts/validate_case_map.py --check-tests
}

step_goldens() {
  bash scripts/check_goldens.sh
}

step_live_noenv() {
  local gate unset_args=() name status all=0
  while IFS= read -r name; do unset_args+=(-u "$name"); done < <(compgen -e | grep '^ATMUSIC_LIVE_' || true)
  for gate in "${LIVE_GATES[@]}"; do
    env "${unset_args[@]}" npx tsx "scripts/live/$gate.ts" > "$OUT/live-noenv-$gate.json" 2> "$OUT/live-noenv-$gate.stderr"
    status=$?
    echo "$status" > "$OUT/live-noenv-$gate.exit"
    echo "$gate: exit $status"
    sed 's/^/  /' "$OUT/live-noenv-$gate.stderr"
    # Each must be exactly "blocked" (2); the closure checks the document.
    [[ $status -eq 2 ]] || all=1
  done
  return $all
}

step_live() {
  # Prerequisites from the operator's environment, through each gate's own
  # requirement list and redaction; no gate body runs and nothing is fetched.
  # .mts: always an ES module (top-level await), wherever --out puts it; a .ts
  # outside the repo has no "type": "module" package.json and compiles as CJS.
  cat > "$OUT/live-prerequisites.mts" <<'TS'
import { pathToFileURL } from 'node:url';
const root = process.argv[2] as string;
const harness = await import(pathToFileURL(`${root}/scripts/live/live-gate.ts`).href);
const gates = ['workers_oauth_check', 'workers_ingest_check', 'pds_compat_check', 'ssrf_probe', 'workers_socket_soak'];
const out: unknown[] = [];
for (const script of gates) {
  const { spec } = await import(pathToFileURL(`${root}/scripts/live/${script}.ts`).href);
  const missing: string[] = [
    ...harness.missingPrerequisites(process.env, spec.requirements),
    ...(spec.extraChecks?.(process.env) ?? []),
  ].map((m: string) => harness.redact(m, process.env));
  out.push({ gate: spec.gate, script: `scripts/live/${script}.ts`, missing });
}
console.log(JSON.stringify(out));
TS
  npx tsx "$OUT/live-prerequisites.mts" "$ROOT" > "$OUT/live-prerequisites.json" || return 1
  local bundle inventory="${ATMUSIC_LIVE_INVENTORY:-$ROOT/docs/verification/live-evidence.json}" status
  bundle="$(sed -n 's/^check-bundle: bundle sha256 \([0-9a-f]\{64\}\)$/\1/p' "$OUT/check-bundle.log" 2>/dev/null | tail -n 1)"
  if [[ -n "$bundle" ]]; then
    python3 scripts/verify_live_evidence.py "$inventory" --bundle-sha256 "$bundle" > "$OUT/live-inventory.txt" 2>&1
  else
    python3 scripts/verify_live_evidence.py "$inventory" > "$OUT/live-inventory.txt" 2>&1
  fi
  status=$?
  echo "$status" > "$OUT/live-inventory.exit"
  cat "$OUT/live-prerequisites.json" "$OUT/live-inventory.txt"
  # 0 passed, 2 blocked: both are reportable outcomes; 1 is a recorded failure.
  [[ $status -eq 0 || $status -eq 2 ]]
}

run_step check-ts 'bash scripts/check-ts.sh' step_check_ts
run_step acceptance 'npx vitest run --project worker-acceptance' step_acceptance
run_step e2e 'npm run test:e2e (npx playwright test)' step_e2e
run_step python 'python3 -m unittest <case-map scripts/test_*.py>' step_python
run_step check-bundle 'npx tsx scripts/check-bundle.ts' step_check_bundle
run_step case-map 'python3 scripts/validate_case_map.py --check-tests' step_case_map
run_step goldens 'bash scripts/check_goldens.sh' step_goldens
run_step live-noenv 'npx tsx scripts/live/<gate>.ts (no env)' step_live_noenv
run_step live 'scripts/live/* prerequisites + python3 scripts/verify_live_evidence.py' step_live

printf '\n==> closure: docs/verification/ts-case-map.json over executed records\n'
python3 - "$ROOT" "$OUT" "${STEPS[@]}" <<'PY'
import json, os, re, sys
from pathlib import Path

root, out, steps = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]
commit = os.environ.get('ATMUSIC_ACCEPTANCE_COMMIT', 'unknown')
SEP = ' › '
SELF = 'bash scripts/acceptance/workers-backend.sh'
GATE_NAMES = {'workers_oauth_check': 'oauth', 'workers_ingest_check': 'ingest', 'pds_compat_check': 'pdsCompat',
              'ssrf_probe': 'ssrfProbe', 'workers_socket_soak': 'socketSoak'}


def read(name, default=''):
    try:
        return (out / name).read_text(encoding='utf-8', errors='replace')
    except OSError:
        return default


status = {s: read(f'{s}.status', 'missing').strip() for s in steps}
command = {s: read(f'{s}.command', s).strip() for s in steps}
log = {s: read(f'{s}.log') for s in steps}
bundle_match = re.findall(r'^check-bundle: bundle sha256 ([0-9a-f]{64})$', log['check-bundle'], re.M)
bundle = bundle_match[-1] if bundle_match and 'PASS check-bundle' in log['check-bundle'] else None

# --- executed test records -------------------------------------------------
records = []
for name in ('check-ts.jsonl', 'acceptance.jsonl', 'python.jsonl'):
    for line in read(name).splitlines():
        if line.strip():
            records.append(json.loads(line))


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
        walk(top, [])  # the top-level suite is the file itself
    return found


try:
    records += playwright_records(json.loads(read('e2e-report.json', '{}') or '{}'))
except ValueError:
    pass


def synthetic(target, cmd, ok):
    return {'target': target, 'command': cmd, 'executed': 1, 'result': 'passed' if ok else 'failed', 'commit': commit}


# validate_contracts.py (run inside check-ts): one "PASS <name>: ..." line per check.
contracts_lines, in_contracts = [], False
for l in log['check-ts'].splitlines():
    if l.startswith('==> '):
        in_contracts = l.startswith('==> contracts')
    elif in_contracts and l.startswith('PASS '):
        contracts_lines.append(l[5:])

# Live gates with no environment: exit 2 and a blocked document listing missing names.
noenv = {}
for script in GATE_NAMES:
    try:
        exit_code = int(read(f'live-noenv-{script}.exit', '-1').strip())
        doc = json.loads(read(f'live-noenv-{script}.json', 'null') or 'null')
    except ValueError:
        exit_code, doc = -1, None
    ok = (status['live-noenv'] not in ('skipped', 'missing') and exit_code == 2 and isinstance(doc, dict)
          and doc.get('result') == 'blocked' and isinstance(doc.get('missing'), list) and len(doc['missing']) > 0)
    noenv[script] = {'ok': ok, 'exit': exit_code, 'missing': doc.get('missing') if isinstance(doc, dict) else None}


def resolve(test_id):
    """Executed records proving one case-map test id (empty: it did not run)."""
    prefix, name = test_id.split(SEP, 1)
    if prefix == SELF:
        return None  # the gate's own verdict, decided last
    if prefix == 'python3 scripts/validate_contracts.py':
        if status['check-ts'] in ('skipped', 'missing'):
            return []
        # "PASS <name>" then end, ':' or ' (' details; the name may itself hold a colon.
        hit = any(l == name or l.startswith(name + ':') or l.startswith(name + ' (') for l in contracts_lines)
        return [synthetic(test_id, prefix, True)] if hit else []
    if prefix == 'npx tsx scripts/check-bundle.ts':
        if status['check-bundle'] in ('skipped', 'missing'):
            return []
        return [synthetic(test_id, prefix, status['check-bundle'] == '0' and bundle is not None)]
    if prefix == 'python3 scripts/validate_case_map.py --check-tests':
        if status['case-map'] in ('skipped', 'missing'):
            return []
        text = log['case-map']
        ok = status['case-map'] == '0' and '258 unique cases' in text and 'every referenced test file and name exists' in text
        return [synthetic(test_id, prefix, ok)]
    live = re.fullmatch(r'npx tsx scripts/live/(\w+)\.ts \(no env\)', prefix)
    if live and live.group(1) in noenv:
        if status['live-noenv'] in ('skipped', 'missing'):
            return []
        return [synthetic(test_id, prefix, noenv[live.group(1)]['ok'])]
    file_prefix = prefix + SEP
    return [r for r in records
            if r['target'] == test_id or r['target'].endswith(SEP + test_id)
            or (r['target'].startswith(file_prefix) and r['target'].endswith(SEP + name))]


case_map = json.loads((root / 'docs/verification/ts-case-map.json').read_text(encoding='utf-8'))
cases, self_cases = [], []
for entry in case_map['cases']:
    if entry['target'].startswith('retired:'):
        cases.append({'case': entry['case'], 'result': 'retired', 'targets': [entry['target']], 'commands': [],
                      'count': 0, 'commit': commit, 'bundleSha256': bundle, 'reason': entry.get('reason')})
        continue
    refs = [entry['target'], *entry.get('also', [])]
    count, commands, omitted, failed, pending_self = 0, [], [], [], False
    for ref in refs:
        found = resolve(ref)
        if found is None:
            pending_self = True
            commands.append(SELF)
            continue
        ran = [r for r in found if r['executed'] > 0]
        count += len(ran)
        commands += sorted({r['command'] for r in ran} - set(commands))
        if not ran:
            omitted.append(ref)
        elif any(r['result'] != 'passed' for r in found):
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

# --- live gates ------------------------------------------------------------
live = []
try:
    prereq = json.loads(read('live-prerequisites.json', '[]') or '[]')
except ValueError:
    prereq = []
inventory_text = read('live-inventory.txt')
inventory_exit = read('live-inventory.exit', '').strip()
gate_states = dict(re.findall(r'(\w+)=(passed|failed|blocked)', ' '.join(
    l for l in inventory_text.splitlines() if 'gates:' in l)))
for item in prereq:
    gate = item['gate']
    if item['missing']:
        live.append({'gate': gate, 'script': item['script'], 'result': 'blocked', 'missing': item['missing']})
        continue
    state = gate_states.get(gate, 'blocked')
    if inventory_exit == '0':
        state = 'passed'
    live.append({'gate': gate, 'script': item['script'], 'result': state,
                 'missing': [] if state != 'blocked' else
                 [f'recorded evidence: no passing {gate} result bound to bundle {bundle or "(unknown)"} in the inventory; '
                  f'run npx tsx {item["script"]} and record its document']})
if status['live'] in ('skipped', 'missing') or not prereq:
    live = [{'gate': g, 'script': f'scripts/live/{s}.ts', 'result': 'blocked',
             'missing': [f'live step did not run (status {status["live"]})']} for s, g in GATE_NAMES.items()]

# Live-evidence cases. A case whose map entry rests on a live gate's blocked
# no-env behaviour is proven only up to that refusal; the case itself (a live
# sign-in, external write, delete, reconnect, product journey) needs recorded
# live evidence for this bundle. It is reported `blocked`, never `passed`,
# until scripts/verify_live_evidence.py passes the inventory for this bundle.
# Exempt: the cases whose plan expectation is the blocked refusal itself.
BLOCKED_IS_THE_EXPECTATION = {
    'M2.4.3/live_credentials_missing',  # "explicit blocked result, nonzero exit; no success report"
    'M4.4.1/coverage_failure',  # "never a federation pass": missing Jetstream coverage blocks
}
# Mapped to verifier regressions, but the plan case checks the real inventory.
INVENTORY_CASES = {'M6.4.3/live_inventory'}
inventory_passed = status['live'] == '0' and inventory_exit == '0'
for c in cases:
    if c['result'] != 'passed' or c['case'] in BLOCKED_IS_THE_EXPECTATION:
        continue
    if c['case'] in INVENTORY_CASES or any(re.search(r'^npx tsx scripts/live/\w+\.ts \(no env\)' + SEP, t)
                                           for t in c['targets']):
        if not inventory_passed:
            c['result'] = 'blocked'
            c['blockedBy'] = ('live evidence: no passing scripts/verify_live_evidence.py inventory for bundle '
                              f'{bundle or "(unknown)"}; the deterministic refusal check passed')

# --- verdict -----------------------------------------------------------------
problems = []
for s in steps:
    st = status[s]
    if st == 'skipped':
        problems.append(f'step {s} was disabled with --skip; a disabled step is never a pass')
    elif st != '0':
        problems.append(f'step {s} ({command[s]}) exited {st}')
for c in cases:
    if c in self_cases:
        continue
    if c.get('notRun'):
        problems.append(f"case {c['case']}: not executed: {'; '.join(c['notRun'])}")
    if c.get('failedTests'):
        problems.append(f"case {c['case']}: failed: {'; '.join(c['failedTests'])}")
for g in live:
    if g['result'] == 'failed':
        problems.append(f"live gate {g['gate']} recorded a failure for bundle {bundle}")
if bundle is None:
    problems.append('no Worker bundle SHA-256: check-bundle did not pass')
gate_ok = not problems
for c in self_cases:
    c['count'] += 1
    if not gate_ok:
        c['result'] = 'failed'
        c.setdefault('failedTests', []).append(f'{SELF} (the gate itself failed)')
if gate_ok:
    self_note = 'all deterministic suites passed'
else:
    self_note = f'{len(problems)} problem(s)'

tests_by_result = {k: sum(1 for r in records if r['result'] == k) for k in ('passed', 'failed', 'skipped', 'todo')}
summary = {
    'commit': commit,
    'bundleSha256': bundle,
    'steps': {s: {'command': command[s], 'exit': status[s]} for s in steps},
    'tests': {'executed': sum(r['executed'] for r in records), **tests_by_result,
              'bySource': {name: sum(1 for line in read(name).splitlines() if line.strip())
                           for name in ('check-ts.jsonl', 'acceptance.jsonl', 'python.jsonl')}
              | {'e2e': sum(1 for r in records if r['command'] == 'npx playwright test')}},
    'cases': {'total': len(cases), **{k: sum(1 for c in cases if c['result'] == k)
                                      for k in ('passed', 'failed', 'blocked', 'retired')}},
    'live': {k: sum(1 for g in live if g['result'] == k) for k in ('passed', 'failed', 'blocked')},
    'liveGates': live,
    'result': 'passed' if gate_ok else 'failed',
    'problems': problems,
}
(out / 'tests.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records), encoding='utf-8')
(out / 'cases.jsonl').write_text(''.join(json.dumps(c, ensure_ascii=False) + '\n' for c in cases), encoding='utf-8')
(out / 'live.json').write_text(json.dumps(live, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
(out / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

short = commit[:12] + ('+dirty' if commit.endswith('+dirty') else '')
for c in cases:
    detail = f" notRun={c['notRun']}" if c.get('notRun') else ''
    detail += f" failed={c['failedTests']}" if c.get('failedTests') else ''
    detail += f" blockedBy={c['blockedBy']!r}" if c.get('blockedBy') else ''
    print(f"{c['result'].upper():8} {c['case']} count={c['count']} commit={short} bundle={(bundle or 'none')[:16]} "
          f"command={'; '.join(c['commands']) or '-'} target={c['targets'][0]}{detail}")
print()
for g in live:
    print(f"LIVE {g['result'].upper():7} {g['gate']} ({g['script']})")
    if g['missing']:
        names = [m.split(':', 1)[0] if re.match(r'^[A-Z][A-Z0-9_]+:', m) else m for m in g['missing']]
        print(f"    missing ({len(names)}): {', '.join(names)}")
print()
for p in problems:
    print(f'FAIL acceptance: {p}')
t, cs, lv = summary['tests'], summary['cases'], summary['live']
print(f"tests: executed={t['executed']} passed={t['passed']} failed={t['failed']} skipped={t['skipped']} todo={t['todo']} "
      f"(check-ts {t['bySource']['check-ts.jsonl']}, acceptance {t['bySource']['acceptance.jsonl']}, "
      f"e2e {t['bySource']['e2e']}, python {t['bySource']['python.jsonl']})")
print(f"cases: {cs['total']} total, passed={cs['passed']} failed={cs['failed']} blocked={cs['blocked']} "
      f"retired={cs['retired']} (blocked: deterministic refusal checks passed; live evidence absent)")
print(f"live gates: passed={lv['passed']} failed={lv['failed']} blocked={lv['blocked']}")
print(f"commit {commit} bundle sha256 {bundle or 'none'}; records in {os.path.relpath(out, root)}")
if gate_ok:
    print(f"PASS workers-backend: {self_note}; {lv['blocked']} live gate(s) and {cs['blocked']} live case(s) "
          'are blocked, not passed')
    sys.exit(0)
print(f'FAIL workers-backend: {self_note}')
sys.exit(1)
PY
