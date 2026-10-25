#!/usr/bin/env python3
"""Regression tests for scripts/validate_case_map.py.

Each test mutates a temporary copy of the committed inputs and runs the real
validator, both as a function and as the CLI, asserting the exit status and the
exact problem it reports. The committed files are never modified.
"""

import copy
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import validate_case_map as vcm

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/validate_case_map.py'
MAP = ROOT / 'docs/verification/ts-case-map.json'
PLAN = ROOT / 'docs/planning/github-plan.json'
WAVES = ROOT / 'docs/planning/workers-waves.json'
AMENDMENTS = ROOT / 'docs/planning/AMENDMENTS-workers.md'
NODE_WAVES = ROOT / 'docs/planning/node-waves.json'
NODE_AMENDMENTS = ROOT / 'docs/planning/AMENDMENTS-node.md'
# scripts/test/check-ts.test.ts runs the whole gate in a disposable copy that omits this one file.
CHECK_TS_TEST = 'scripts/test/check-ts.test.ts'
SUPERSEDED = ('A1', 'A2', 'A3', 'A4', 'A5', 'A11', 'A12', 'A15', 'A16', 'A18', 'A19', 'D')


def committed():
    return (json.loads(MAP.read_text()), json.loads(PLAN.read_text()),
            json.loads(WAVES.read_text()), AMENDMENTS.read_text())


def run_cli(case_map=None, plan=None, map_text=None, amendments=None, waves=None, extra=(), node_waves=None,
            node_amendments=None):
    """Run the validator CLI on temporary inputs; return (exit code, stdout, stderr)."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        map_path, plan_path, amend_path = tmp / 'map.json', tmp / 'plan.json', tmp / 'amend.md'
        waves_path, node_waves_path, node_amend_path = tmp / 'waves.json', tmp / 'node-waves.json', tmp / 'node-amend.md'
        map_path.write_text(map_text if map_text is not None else json.dumps(case_map if case_map is not None else committed()[0]))
        plan_path.write_text(json.dumps(plan if plan is not None else committed()[1]))
        amend_path.write_text(amendments if amendments is not None else AMENDMENTS.read_text())
        waves_path.write_text(json.dumps(waves if waves is not None else committed()[2]))
        node_waves_path.write_text(json.dumps(node_waves if node_waves is not None else json.loads(NODE_WAVES.read_text())))
        node_amend_path.write_text(node_amendments if node_amendments is not None else NODE_AMENDMENTS.read_text())
        result = subprocess.run(
            [sys.executable, str(SCRIPT), '--map', str(map_path), '--plan', str(plan_path),
             '--waves', str(waves_path), '--amendments', str(amend_path), '--node-waves', str(node_waves_path),
             '--node-amendments', str(node_amend_path), *extra],
            capture_output=True, text=True, check=False)
        return result.returncode, result.stdout, result.stderr


def problems(case_map, plan=None, amendments=None, waves=None, **kwargs):
    base_map, base_plan, base_waves, base_amend = committed()
    try:
        vcm.validate(case_map, plan or base_plan, base_waves if waves is None else waves,
                     base_amend if amendments is None else amendments, **kwargs)
    except vcm.CaseMapError as error:
        return error.problems
    return []


def unapplied_waves():
    """The committed wave plan with every required wave amendment test taken out again.

    The owner has applied the amendments to workers-waves.json; this rebuilds
    the state before that, so the tests below exercise both states whatever the
    committed plan currently holds.
    """
    waves = committed()[2]
    pending, _ = vcm.wave_amendments(AMENDMENTS.read_text())
    for wave in waves:
        for package in wave['packages']:
            package['tests'] = [test for test in package['tests'] if test not in pending]
    return waves


def applied_waves():
    """The committed wave plan with every required wave amendment declared by its owning package."""
    waves = committed()[2]
    pending, _ = vcm.wave_amendments(AMENDMENTS.read_text())
    declared = vcm.wave_test_ids(waves)
    packages = {package['id']: package for wave in waves for package in wave['packages']}
    for test, package in sorted(pending.items()):
        if test not in declared:
            packages[package]['tests'].append(test)
    return waves


def node_waves():
    return json.loads(NODE_WAVES.read_text())


def node_declared():
    """Test ids declared only by node-waves.json (not by workers-waves.json), with (wave, package)."""
    workers = vcm.wave_test_ids(committed()[2])
    return {test: owner for test, owner in vcm.node_wave_test_ids(node_waves()).items() if test not in workers}


def remapped_cases():
    """The cases whose target is declared only by node-waves.json (the ADR 0005 §20.2 remap, N0-02)."""
    declared = node_declared()
    return {e['case']: e['target'] for e in committed()[0]['cases'] if e['target'] in declared}


def build_tree(root, tests):
    """Write a test file holding each test name, as the real suites declare it, under a temporary root."""
    for test in tests:
        path, name, _ = vcm.test_location(test)
        target = root / path
        if target.suffix == '' and not path.endswith('.sh'):
            target = target / 'fixture.test.ts'
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('a', encoding='utf-8') as handle:
            handle.write(f"it({json.dumps(name, ensure_ascii=False)}, () => {{}});\n")


def vcm_problems(case_map, plan, waves, amendments, **kwargs):
    try:
        vcm.validate(case_map, plan, waves, amendments, **kwargs)
    except vcm.CaseMapError as error:
        return error.problems
    return []


class CaseMapTests(unittest.TestCase):
    def test_rejects_a_missing_case_id(self):
        """rejects a missing case id"""
        case_map = committed()[0]
        removed = case_map['cases'].pop(17)
        self.assertEqual(len(case_map['cases']), 257)
        self.assertIn(f"missing case id {removed['case']}", problems(case_map))
        code, stdout, stderr = run_cli(case_map)
        self.assertEqual(code, 1)
        self.assertEqual(stdout, '')
        self.assertIn(f"FAIL case map: missing case id {removed['case']}", stderr)
        # A plan whose leaves no longer total 258 unique cases is itself rejected.
        plan = committed()[1]
        leaf = next(i for i in plan['issues'] if i.get('role') == 'implementation')
        leaf['test_cases'].pop()
        self.assertIn('github-plan.json: expected exactly 258 unique case ids, found 257', problems(committed()[0], plan=plan))

    def test_rejects_a_duplicate_case_id(self):
        """rejects a duplicate case id"""
        case_map = committed()[0]
        duplicate = copy.deepcopy(case_map['cases'][3])
        case_map['cases'].append(duplicate)
        self.assertEqual(problems(case_map), [f"duplicate case id {duplicate['case']}"])
        code, _, stderr = run_cli(case_map)
        self.assertEqual(code, 1)
        self.assertIn(f"FAIL case map: duplicate case id {duplicate['case']}", stderr)
        # A duplicated JSON key inside one entry is rejected rather than silently merged.
        text = MAP.read_text().replace('"case": "M1.1.1/fixture_namespace",',
                                       '"case": "M1.1.1/fixture_namespace", "case": "M1.1.1/invalid_namespace",', 1)
        code, _, stderr = run_cli(map_text=text)
        self.assertEqual(code, 1)
        self.assertIn("duplicate JSON key 'case'", stderr)
        # Duplicate case names inside github-plan.json are rejected too.
        plan = committed()[1]
        leaves = [i for i in plan['issues'] if i.get('role') == 'implementation']
        leaves[1]['test_cases'][0]['name'] = leaves[0]['test_cases'][0]['name']
        leaves[1]['key'] = leaves[0]['key']
        self.assertIn(f"github-plan.json: duplicate case id {leaves[0]['key']}/{leaves[0]['test_cases'][0]['name']}",
                      problems(committed()[0], plan=plan))

    def test_rejects_retired_entry_without_amendment_id(self):
        """rejects retired entry without amendment id"""
        base = committed()[0]
        index = next(i for i, e in enumerate(base['cases']) if e['case'] == 'M6.3.2/export_auth')
        self.assertEqual(base['cases'][index]['target'], 'retired:A9')
        for target in ['retired', 'retired:', 'retired:A21', 'retired:A0', 'retired:X', 'retired: D', 'retired:D,A3',
                       'retired:B0', 'retired:B21', 'retired:B4,B11']:
            case_map = copy.deepcopy(base)
            case_map['cases'][index]['target'] = target
            found = problems(case_map)
            self.assertEqual(len(found), 1, (target, found))
            self.assertIn('M6.3.2/export_auth: retired entry without amendment id', found[0])
        case_map = copy.deepcopy(base)
        case_map['cases'][index]['target'] = 'retired:'
        code, _, stderr = run_cli(case_map)
        self.assertEqual(code, 1)
        self.assertIn("FAIL case map: M6.3.2/export_auth: retired entry without amendment id ('retired:')", stderr)
        # A valid id still needs a reason ...
        case_map = copy.deepcopy(base)
        del case_map['cases'][index]['reason']
        self.assertEqual(problems(case_map), ['M6.3.2/export_auth: retired entry needs a nonempty reason'])
        # ... and the leaf's issue amendment must list a (not superseded) ADR 0004 id.
        case_map = copy.deepcopy(base)
        case_map['cases'][index]['target'] = 'retired:A14'
        self.assertEqual(problems(case_map), ['M6.3.2/export_auth: AMENDMENTS-workers.md section M6.3.2 does not list amendment id A14'])
        amendments = AMENDMENTS.read_text().replace('### M6.3.2 ', '### M6.3.2-removed ', 1)
        self.assertEqual(problems(base, amendments=amendments),
                         ['M6.3.2/export_auth: AMENDMENTS-workers.md section M6.3.2 does not list amendment id A9'])

    def test_rejects_a_test_id_outside_the_waves(self):
        """rejects a mapped target that is not a wave test id"""
        case_map = committed()[0]
        entry = next(e for e in case_map['cases'] if not e['target'].startswith('retired'))
        entry['target'] = 'worker/test/read/history.test.ts › invented name'
        self.assertEqual(problems(case_map), [f"{entry['case']}: 'worker/test/read/history.test.ts › invented name' is declared in "
                                              "neither workers-waves.json nor node-waves.json and is not listed under Required wave amendments"])
        # An `also` id is held to the same rule as the target.
        case_map = committed()[0]
        entry = next(e for e in case_map['cases'] if e['case'] == 'M2.1.2/fetch_bounds')
        entry['also'] = ['worker/test/read/history.test.ts › invented also']
        self.assertEqual(problems(case_map), ["M2.1.2/fetch_bounds: 'worker/test/read/history.test.ts › invented also' is declared in "
                                              "neither workers-waves.json nor node-waves.json and is not listed under Required wave amendments"])

    def test_check_tests_requires_existing_files_and_names(self):
        """--check-tests reports a missing test file or name"""
        case_map, plan, _, amendments = committed()
        pending, parse_problems = vcm.wave_amendments(amendments)
        self.assertEqual(parse_problems, [])
        self.assertTrue(pending)
        # Before the owner applies the required wave amendments, --check-tests fails once per unapplied test id.
        before = unapplied_waves()
        self.assertFalse(set(pending) & set(vcm.wave_test_ids(before)))
        found = problems(case_map, waves=before, check_tests=True, root=Path('/nonexistent'))
        not_applied = [p for p in found if p.startswith('required wave amendment not applied:')]
        self.assertEqual(len(not_applied), len(pending))
        self.assertIn("required wave amendment not applied: W0-01 does not declare 'worker/test/config.test.ts › "
                      "one-segment, uppercase and embedded-slash LEXICON_PREFIX values are rejected naming "
                      "LEXICON_PREFIX; empty yields prefix null' in workers-waves.json", not_applied)
        # Once applied, build every referenced test file in a temporary root.
        applied = applied_waves()
        self.assertEqual(problems(case_map, waves=applied), [])
        mapped = [e for e in case_map['cases'] if not e['target'].startswith('retired')]
        refs = sorted({test for e in mapped for test in [e['target'], *e.get('also', [])]})
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for test in refs:
                path, name, is_file = vcm.test_location(test)
                target = root / path
                if target.suffix == '' and not path.endswith('.sh'):
                    target = target / 'fixture.test.ts'
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('a', encoding='utf-8') as handle:
                    handle.write(f"it({json.dumps(name, ensure_ascii=False)}, () => {{}});\n")
            summary = vcm.validate(case_map, plan, applied, amendments, root=root, check_tests=True)
            self.assertEqual(summary, {'cases': 258, 'mapped': len(mapped), 'awaiting': 0, 'retired': 258 - len(mapped), 'amendments': 0,
                                       'pending': []})
            removed = root / 'worker/test/read/history.test.ts'
            removed.unlink()
            found = vcm_problems(case_map, plan, applied, amendments, root=root, check_tests=True)
            history = [(e['case'], t) for e in mapped for t in [e['target'], *e.get('also', [])]
                       if t.startswith('worker/test/read/history.test.ts')]
            self.assertEqual(len(found), len(history))
            self.assertTrue(all('test file missing' in p for p in found))
            feed = root / 'web/test/routes/feed.test.tsx'
            feed.write_text("it('a different title', () => {});\n")
            self.assertTrue(any('M7.3.1/anonymous_following: test name missing from web/test/routes/feed.test.tsx' in p
                                for p in vcm_problems(case_map, plan, applied, amendments, root=root, check_tests=True)))
            # The CLI exits nonzero, prints no PASS line, and lists each omitted case.
            code, stdout, stderr = run_cli(case_map, waves=applied, extra=('--check-tests', '--root', str(root)))
            self.assertEqual((code, stdout), (1, ''))
            for case, target in history:
                self.assertIn(f'FAIL case map: {case}: test file missing for {target!r}: worker/test/read/history.test.ts', stderr)
            self.assertIn('FAIL case map: M7.3.1/anonymous_following: test name missing from web/test/routes/feed.test.tsx', stderr)
            # Restoring the file and the name makes the same CLI run pass again.
            for test in refs:
                path, name, _ = vcm.test_location(test)
                if path in ('worker/test/read/history.test.ts', 'web/test/routes/feed.test.tsx'):
                    with (root / path).open('a', encoding='utf-8') as handle:
                        handle.write(f"it({json.dumps(name, ensure_ascii=False)}, () => {{}});\n")
            code, stdout, stderr = run_cli(case_map, waves=applied, extra=('--check-tests', '--root', str(root)))
            self.assertEqual((code, stderr), (0, ''))
            self.assertIn('; every referenced test file and name exists', stdout)

    def test_rejects_a_note_that_states_an_obligation(self):
        """rejects a note that states an obligation instead of a test id"""
        case_map = committed()[0]
        entry = next(e for e in case_map['cases'] if e['case'] == 'M7.3.1/feed_order')
        for note, word in [('W3-06 must keep page 1 on a page-2 503.', 'must'),
                           ('The feed test should also render the stale state.', 'should'),
                           ('W2-07 needs to assert absence.', 'needs to')]:
            entry['note'] = note
            self.assertEqual(problems(case_map), [f"M7.3.1/feed_order: note states an obligation ({word!r}); "
                                                  "map the obligation to a declared or required-amendment test id instead"])
        code, stdout, stderr = run_cli(case_map)
        self.assertEqual((code, stdout), (1, ''))
        self.assertIn('FAIL case map: M7.3.1/feed_order: note states an obligation', stderr)
        # Informational notes are accepted, and no committed note states an obligation.
        entry['note'] = 'A8: the SPA takes the viewer from the session.'
        self.assertEqual(problems(case_map), [])
        self.assertFalse([e['case'] for e in committed()[0]['cases'] if vcm.OBLIGATION.search(e.get('note', ''))])

    def test_rejects_retired_reason_that_claims_coverage(self):
        """rejects a retired entry whose reason says a test covers it"""
        base = committed()[0]
        index = next(i for i, e in enumerate(base['cases']) if e['case'] == 'M6.3.2/export_auth')
        for reason in ['There is no owner check (covered by worker/test/read/export.test.ts).',
                       'The re-auth state is web/test/oauth/session.test.ts.',
                       'See worker/test/storage/migrate.test.ts › re-running migrate is a no-op.']:
            case_map = copy.deepcopy(base)
            case_map['cases'][index]['reason'] = reason
            self.assertEqual(problems(case_map),
                             ['M6.3.2/export_auth: retired reason claims test coverage; a covered case is mapped, not retired'])
        case_map = copy.deepcopy(base)
        case_map['cases'][index]['also'] = [next(e['target'] for e in base['cases'] if e['case'] == 'M1.4.1/migrate_only')]
        self.assertEqual(problems(case_map), ['M6.3.2/export_auth: also is only for mapped entries'])

    def test_required_wave_amendment_registry(self):
        """required wave amendments must be listed under a real package and referenced by a case"""
        case_map, _, waves, amendments = committed()
        pending, _ = vcm.wave_amendments(amendments)
        test = 'web/test/routes/feed.test.tsx › anonymous user selecting following sees a sign-in prompt and no scope=following request is sent'
        self.assertEqual(pending[test], 'W3-06')
        # Before the amendment is applied, removing its registry line leaves the
        # referencing case pointing at an unknown id ...
        line = next(l for l in amendments.splitlines() if l.startswith(f'- `{test}`'))
        found = problems(case_map, amendments=amendments.replace(line + '\n', '', 1), waves=unapplied_waves())
        self.assertEqual(found, [f"M7.3.1/anonymous_following: {test!r} is declared in neither workers-waves.json "
                                 "nor node-waves.json and is not listed under Required wave amendments"])
        # ... and once W3-06 declares it, the declaration alone admits the id.
        self.assertEqual(problems(case_map, amendments=amendments.replace(line + '\n', '', 1), waves=applied_waves()), [])
        # An unreferenced registry entry, an unknown package and a package mismatch are each rejected.
        extra = amendments.replace(line, line + '\n- `web/test/routes/feed.test.tsx › orphan`', 1)
        self.assertEqual(problems(case_map, amendments=extra),
                         ["required wave amendment 'web/test/routes/feed.test.tsx › orphan' is referenced by no case"])
        self.assertIn(f'required wave amendment {test!r}: unknown package W9-99',
                      problems(case_map, amendments=amendments.replace('**W3-06**', '**W9-99**', 1)))
        declared = 'web/test/routes/feed.test.tsx › renders items and loads next page via nextCursor'
        relisted = amendments.replace(line, line + f'\n- `{declared}` — covers `M7.3.1/feed_order`', 1)
        # An amendment that the owner already applied under the same package is accepted ...
        self.assertEqual(problems(case_map, amendments=relisted), [])
        # ... but one listed under a different package than the one declaring it is rejected.
        moved = amendments.replace('**W0-01**', '**W0-01**\n\n- `' + declared + '` — covers `M7.3.1/feed_order`', 1)
        self.assertEqual(problems(case_map, amendments=moved),
                         [f'required wave amendment {declared!r} is listed under W0-01 but declared by W3-06'])

    def test_accepts_the_committed_map_with_258_cases(self):
        """accepts the committed map with 258 cases"""
        case_map, plan, waves, amendments = committed()
        summary = vcm.validate(case_map, plan, waves, amendments)
        self.assertEqual(summary['cases'], 258)
        self.assertEqual(summary['mapped'] + summary['awaiting'] + summary['retired'], 258)
        self.assertEqual(len({e['case'] for e in case_map['cases']}), 258)
        pending, _ = vcm.wave_amendments(amendments)
        declared = vcm.wave_test_ids(waves)
        self.assertEqual(summary['amendments'], len([test for test in pending if test not in declared]))
        # The same map is accepted before the amendments are applied, with every one counted as awaiting.
        before = vcm.validate(case_map, plan, unapplied_waves(), amendments)
        self.assertEqual((before['cases'], before['amendments']), (258, len(pending)))
        self.assertGreater(before['awaiting'], 0)
        self.assertEqual(before['mapped'] + before['awaiting'] + before['retired'], 258)
        result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        self.assertIn(f"PASS case map: 258 unique cases ({summary['mapped']} mapped to declared wave test ids, "
                      f"{summary['awaiting']} awaiting {summary['amendments']} required wave amendment tests, "
                      f"{summary['retired']} retired with amendment ids)", result.stdout)
        entries = {e['case']: e for e in case_map['cases']}
        # Review round 2: cases whose coverage exists are mapped, not retired.
        self.assertEqual(entries['M1.4.1/migrate_only']['target'], 'worker/test/storage/migrate.test.ts › re-running migrate is a no-op')
        self.assertEqual(entries['M2.3.2/session_expiry']['target'], 'web/test/oauth/session.test.ts › expired/refresh-failed session surfaces re-auth state')
        self.assertEqual(entries['M6.4.1/checksum']['target'], 'npx tsx scripts/check-bundle.ts › production bundle passes guard')
        self.assertEqual(pending.get(entries['M7.3.1/anonymous_following']['target']), 'W3-06')
        # ... and a case no longer maps to an unrelated wave test.
        self.assertEqual(pending.get(entries['M6.1.1/asset_cache']['target']), 'W1-09')
        self.assertEqual(pending.get(entries['M6.2.2/log_redaction']['target']), 'W5-01')


def adr_remap():
    """ADR 0005 §20.2, parsed independently of the validator: {case: ('map', package, target) | ('retire', B id)}."""
    text = (ROOT / 'docs/adr/0005-local-node-host-and-compat-apis.md').read_text(encoding='utf-8')
    section = text.split('### 20.2', 1)[1].split('### 20.3', 1)[0]
    rows = {}
    for line in section.splitlines():
        row = re.match(r'^\| `([^`]+)` \| `retired:[A-Z0-9]+` \| (.*) \|$', line)
        if not row:
            continue
        case, now = row.groups()
        retired = re.match(r'^`retired:(B\d+)`:', now)
        if retired:
            rows[case] = ('retire', retired.group(1))
        else:
            mapped = re.match(r'^(N\d-\d\d): `+(.*?)`+$', now)
            rows[case] = ('map', mapped.group(1), mapped.group(2).strip())
    return rows


def copy_targets(root, tests):
    """Copy each referenced file or directory from the repository into a temporary root."""
    missing = []
    for test in tests:
        path, _, _ = vcm.test_location(test)
        source, target = ROOT / path, root / path
        if target.exists():
            continue
        if not source.exists():
            missing.append(test)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
    return missing


class NodeWavesTests(unittest.TestCase):
    """ADR 0005 §15.3 and B19: node-waves.json targets, superseded retirements, B retirements, pending targets."""

    CASE = 'M2.2.2/wrong_origin'  # remapped to N3-01 (wave 3) by ADR 0005 §20.2

    def test_node_waves_only_target_accepted(self):
        """a case target declared only in node-waves.json is accepted"""
        case_map = committed()[0]
        entry = next(e for e in case_map['cases'] if e['case'] == 'M2.2.2/par_pkce')
        target = entry['target']
        self.assertNotIn(target, vcm.wave_test_ids(committed()[2]))
        self.assertEqual(vcm.node_wave_test_ids(node_waves())[target], (2, 'N2-03'))
        self.assertEqual(problems(case_map), [])
        # It is the node-waves declaration that admits it: without it the id is unknown.
        stripped = node_waves()
        for wave in stripped:
            for package in wave['packages']:
                package['tests'] = [t for t in package['tests'] if t != target]
        found = problems(case_map, node_waves=stripped)
        self.assertEqual(found, [f"M2.2.2/par_pkce: {target!r} is declared in neither workers-waves.json nor node-waves.json "
                                 "and is not listed under Required wave amendments"])
        # A new id declared by a node-waves package is accepted for an `also` too, through the CLI.
        extended = node_waves()
        extra = 'worker/test/node/bff/oauth-client.test.ts › an extra assertion of the PAR request'
        next(p for w in extended for p in w['packages'] if p['id'] == 'N2-03')['tests'].append(extra)
        entry['also'] = [extra]
        self.assertEqual(problems(case_map, node_waves=extended), [])
        code, stdout, stderr = run_cli(case_map, node_waves=extended)
        self.assertEqual((code, stderr), (0, ''))
        self.assertIn('PASS case map: 258 unique cases', stdout)
        code, _, stderr = run_cli(case_map)
        self.assertEqual(code, 1)
        self.assertIn(f"FAIL case map: M2.2.2/par_pkce: {extra!r} is declared in neither", stderr)

    def test_neither_waves_file_reports_case(self):
        """a case target declared in neither waves file is reported with its case name"""
        case_map = committed()[0]
        invented = 'worker/test/node/http/auth.test.ts › an invented title that no waves file declares'
        for name in [self.CASE, 'M6.3.2/export_auth']:
            entry = next(e for e in case_map['cases'] if e['case'] == name)
            entry.pop('reason', None)
            entry['target'] = invented
        message = "is declared in neither workers-waves.json nor node-waves.json and is not listed under Required wave amendments"
        self.assertEqual(problems(case_map), [f'{self.CASE}: {invented!r} {message}', f'M6.3.2/export_auth: {invented!r} {message}'])
        code, stdout, stderr = run_cli(case_map)
        self.assertEqual((code, stdout), (1, ''))
        self.assertIn(f'FAIL case map: {self.CASE}: {invented!r} {message}', stderr)
        self.assertIn(f'FAIL case map: M6.3.2/export_auth: {invented!r} {message}', stderr)

    def test_superseded_retirement_reports_case_and_b_id(self):
        """a retirement citing a superseded amendment (A3 or D) is reported with its case name and the superseding B id"""
        base = committed()[0]
        superseded, _, parse_problems = vcm.node_amendments(NODE_AMENDMENTS.read_text())
        self.assertEqual(parse_problems, [])
        self.assertEqual(superseded, {'A1': 'B1', 'A2': 'B2', 'A3': 'B3', 'A4': 'B4', 'A5': 'B5', 'A11': 'B6', 'A12': 'B7',
                                      'A15': 'B8', 'A16': 'B9', 'A18': 'B10', 'A19': 'B11', 'D': 'B16'})
        reason = 'The browser library performs this check.'
        for case, amendment, b_id in [('M2.2.2/par_pkce', 'A3', 'B3'), ('M1.1.4/required_auth', 'D', 'B16')]:
            case_map = copy.deepcopy(base)
            entry = next(e for e in case_map['cases'] if e['case'] == case)
            entry['target'], entry['reason'] = f'retired:{amendment}', reason
            expected = (f'{case}: retired:{amendment} cites ADR 0004 amendment {amendment}, superseded by {b_id} (ADR 0005 B19); '
                        'map the case to a declared test or retire it under a B amendment that names it')
            self.assertEqual(problems(case_map), [expected])
            code, stdout, stderr = run_cli(case_map)
            self.assertEqual((code, stdout), (1, ''))
            self.assertIn(f'FAIL case map: {expected}', stderr)
        # Every superseded id is rejected the same way, even where the leaf's ADR 0004 section lists it.
        for amendment in SUPERSEDED:
            case_map = copy.deepcopy(base)
            entry = next(e for e in case_map['cases'] if e['case'] == 'M6.3.2/export_auth')
            entry['target'] = f'retired:{amendment}'
            found = problems(case_map)
            self.assertEqual(len(found), 1, found)
            self.assertTrue(found[0].startswith(f'M6.3.2/export_auth: retired:{amendment} cites ADR 0004 amendment {amendment}, '
                                                f'superseded by {superseded[amendment]} '), found[0])
        # A non-superseded ADR 0004 id is still accepted where its leaf section lists it.
        self.assertEqual(next(e for e in base['cases'] if e['case'] == 'M6.3.2/export_auth')['target'], 'retired:A9')
        self.assertEqual(problems(base), [])
        # The superseded list itself is required to name every ADR 0005 §15.3 id.
        text = NODE_AMENDMENTS.read_text()
        row = next(line for line in text.splitlines() if line.startswith('| `A3` | `B3` |'))
        found = problems(base, node_amendments_text=text.replace(row + '\n', '', 1))
        self.assertEqual(found, ['AMENDMENTS-node.md: the superseded list lacks A3 (ADR 0005 §15.3)'])

    def test_b11_retirement_needs_naming_section(self):
        """retired:B11 is accepted only when the B11 section of AMENDMENTS-node.md names the case"""
        base = committed()[0]
        entries = {e['case']: e for e in base['cases']}
        self.assertEqual(entries['M1.2.3/static_elf']['target'], 'retired:B11')
        self.assertEqual(entries['M6.4.1/static_release']['target'], 'retired:B11')
        self.assertEqual(problems(base), [])
        _, sections, _ = vcm.node_amendments(NODE_AMENDMENTS.read_text())
        self.assertEqual(sections['B11'], {'M1.2.3/static_elf', 'M6.4.1/static_release'})
        self.assertEqual(sections['B4'], {'M1.2.1/locked_build', 'M1.2.1/dependency_direction'})
        text = NODE_AMENDMENTS.read_text()
        b11 = text.split('### B11 ', 1)[1].split('\n### ', 1)[0]
        reason = 'The release artifact is the bundle; its checksum is printed by the Node guard.'
        # A case the B11 section does not name is rejected ...
        case_map = copy.deepcopy(base)
        checksum = next(e for e in case_map['cases'] if e['case'] == 'M6.4.1/checksum')
        checksum.pop('also', None)
        checksum.pop('note', None)
        checksum['target'], checksum['reason'] = 'retired:B11', reason
        expected = 'M6.4.1/checksum: retired:B11 but the B11 section of AMENDMENTS-node.md does not name M6.4.1/checksum'
        self.assertEqual(problems(case_map), [expected])
        code, _, stderr = run_cli(case_map)
        self.assertEqual(code, 1)
        self.assertIn(f'FAIL case map: {expected}', stderr)
        # ... even one the section mentions in prose rather than in its list of retired cases ...
        self.assertIn('`M1.2.3/packaged_shutdown`', b11)
        case_map = copy.deepcopy(base)
        shutdown = next(e for e in case_map['cases'] if e['case'] == 'M1.2.3/packaged_shutdown')
        shutdown['target'], shutdown['reason'] = 'retired:B11', reason
        self.assertEqual(problems(case_map),
                         ['M1.2.3/packaged_shutdown: retired:B11 but the B11 section of AMENDMENTS-node.md does not name M1.2.3/packaged_shutdown'])
        # ... and naming the case in the B11 list admits it, through the CLI as well.
        named = text.replace('- `M6.4.1/static_release`:', '- `M6.4.1/checksum`: the bundle SHA-256 is the release checksum.\n- `M6.4.1/static_release`:', 1)
        self.assertEqual(problems(case_map_with(base, 'M6.4.1/checksum', 'retired:B11', reason), node_amendments_text=named), [])
        code, stdout, stderr = run_cli(case_map_with(base, 'M6.4.1/checksum', 'retired:B11', reason), node_amendments=named)
        self.assertEqual((code, stderr), (0, ''))
        self.assertIn('7 retired with amendment ids', stdout)
        # The section of another B id does not count, and removing the name from B11 rejects the committed retirement.
        self.assertEqual(problems(case_map_with(base, 'M1.2.3/static_elf', 'retired:B4', reason)),
                         ['M1.2.3/static_elf: retired:B4 but the B4 section of AMENDMENTS-node.md does not name M1.2.3/static_elf'])
        unnamed = text.replace(next(line for line in b11.splitlines() if line.startswith('- `M1.2.3/static_elf`')) + '\n', '', 1)
        self.assertEqual(problems(base, node_amendments_text=unnamed),
                         ['M1.2.3/static_elf: retired:B11 but the B11 section of AMENDMENTS-node.md does not name M1.2.3/static_elf'])
        self.assertEqual(problems(base, node_amendments_text=text.replace('### B11 ', '### B11-removed ', 1)),
                         ['M1.2.3/static_elf: retired:B11 but AMENDMENTS-node.md has no B11 section',
                          'M6.4.1/static_release: retired:B11 but AMENDMENTS-node.md has no B11 section'])

    def test_node_wave_pending_targets(self):
        """with --check-tests --node-wave 0, a target declared by a wave-3 package whose file does not exist yet is reported pending with its package id and the run passes; with --node-wave 3 or without --node-wave it fails naming the case"""
        case_map, plan, waves, amendments = committed()
        target = next(e['target'] for e in case_map['cases'] if e['case'] == self.CASE)
        self.assertEqual(vcm.node_wave_test_ids(node_waves())[target], (3, 'N3-01'))
        later = {test for test, (wave, _) in node_declared().items() if wave > 0}
        refs = sorted({t for e in case_map['cases'] if not e['target'].startswith('retired') for t in [e['target'], *e.get('also', [])]})
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Every target that wave 0 requires exists; no later-wave file exists.
            build_tree(root, [t for t in refs if t not in later])
            self.assertFalse((root / 'worker/test/node/http/auth.test.ts').exists())
            summary = vcm.validate(case_map, plan, waves, amendments, root=root, check_tests=True, node_wave=0)
            self.assertIn({'case': self.CASE, 'target': target, 'wave': 3, 'package': 'N3-01'}, summary['pending'])
            self.assertEqual({p['target'] for p in summary['pending']}, {t for t in refs if t in later})
            self.assertTrue(all(p['wave'] > 0 for p in summary['pending']))
            code, stdout, stderr = run_cli(case_map, extra=('--check-tests', '--node-wave', '0', '--root', str(root)))
            self.assertEqual((code, stderr), (0, ''))
            self.assertIn(f'PENDING case map: {self.CASE}: {target!r} pending (wave 3, N3-01)', stdout)
            self.assertIn(f"targets of later node waves pending", stdout)
            missing = f'FAIL case map: {self.CASE}: test file missing for {target!r}: worker/test/node/http/auth.test.ts'
            for extra in [('--check-tests', '--node-wave', '3', '--root', str(root)), ('--check-tests', '--root', str(root))]:
                code, stdout, stderr = run_cli(case_map, extra=extra)
                self.assertEqual((code, stdout), (1, ''), extra)
                self.assertIn(missing, stderr)
            # Once wave 3 has written the test, --node-wave 3 no longer names the case.
            build_tree(root, [target])
            code, _, stderr = run_cli(case_map, extra=('--check-tests', '--node-wave', '3', '--root', str(root)))
            self.assertNotIn(f'FAIL case map: {self.CASE}:', stderr)
            # A wave-0 target is never pending: removing it fails the wave-0 run.
            wave0 = next(t for t in refs if t not in later and t.startswith('worker/test/read/history.test.ts'))
            (root / 'worker/test/read/history.test.ts').unlink()
            code, _, stderr = run_cli(case_map, extra=('--check-tests', '--node-wave', '0', '--root', str(root)))
            self.assertEqual(code, 1)
            self.assertIn(f'test file missing for {wave0!r}', stderr)
        # --node-wave needs --check-tests.
        code, _, stderr = run_cli(case_map, extra=('--node-wave', '0'))
        self.assertEqual(code, 2)
        self.assertIn('--node-wave takes a wave number >= 0 and requires --check-tests', stderr)

    def test_committed_map_has_no_superseded_retirement(self):
        """passes with no case retired under A1, A2, A3, A4, A5, A11, A12, A15, A16, A18, A19 or D and every remapped case pointing at a test declared in node-waves.json"""
        case_map = committed()[0]
        entries = {e['case']: e for e in case_map['cases']}
        stale = [c for c, e in entries.items() if e['target'].startswith('retired:') and e['target'].split(':', 1)[1] in SUPERSEDED]
        self.assertEqual(stale, [])
        remap = adr_remap()
        self.assertEqual(len(remap), 43)
        self.assertEqual(sum(1 for r in remap.values() if r[0] == 'map'), 39)
        declared = vcm.node_wave_test_ids(node_waves())
        for case, row in remap.items():
            if row[0] == 'map':
                self.assertEqual(entries[case]['target'], row[2], case)
                self.assertEqual(declared[row[2]][1], row[1], case)
                self.assertNotIn('reason', entries[case])
            else:
                self.assertEqual(entries[case]['target'], f'retired:{row[1]}', case)
        retired = sorted(e['target'] for e in entries.values() if e['target'].startswith('retired:'))
        self.assertEqual(retired, ['retired:A14', 'retired:A9', 'retired:B11', 'retired:B11', 'retired:B4', 'retired:B4'])
        result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, check=False)
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        self.assertEqual(result.stdout, 'PASS case map: 258 unique cases (252 mapped to declared wave test ids, '
                                        '0 awaiting 0 required wave amendment tests, 6 retired with amendment ids)\n')

    def test_end_of_wave_0_check_tests_passes(self):
        """passes at the end of wave 0 with every remapped case reported pending under its owning package"""
        case_map = committed()[0]
        later = {test for test, (wave, _) in node_declared().items() if wave > 0}
        refs = sorted({t for e in case_map['cases'] if not e['target'].startswith('retired') for t in [e['target'], *e.get('also', [])]})
        declared = vcm.node_wave_test_ids(node_waves())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # The real files of every target wave 0 requires, N0-01's included: a missing wave-0 target fails.
            absent = copy_targets(root, [t for t in refs if t not in later])
            # Only inside check-ts.test.ts's disposable copy, which omits that file by design (so its nested
            # gate never recurses), are that file's titles restored; nothing else may be absent.
            omitted = [t for t in absent if t.startswith(f'{CHECK_TS_TEST} › ') and not (ROOT / CHECK_TS_TEST).exists()]
            self.assertEqual([t for t in absent if t not in omitted], [])
            build_tree(root, omitted)
            code, stdout, stderr = run_cli(case_map, extra=('--check-tests', '--node-wave', '0', '--root', str(root)))
        self.assertEqual((code, stderr), (0, ''))
        pending = dict(re.findall(r"^PENDING case map: (\S+): .* pending \(wave \d, (N\d-\d\d)\)$", stdout, re.M))
        for case, row in adr_remap().items():
            if row[0] != 'map':
                continue
            if declared[row[2]][0] > 0:
                self.assertEqual(pending.get(case), row[1], case)
            else:
                self.assertNotIn(case, pending)
        self.assertEqual(len(pending), 38)
        self.assertIn('PASS case map: 258 unique cases', stdout)
        self.assertIn('every referenced test file and name of node waves <= 0 exists; 38 targets of later node waves pending', stdout)


def case_map_with(base, case, target, reason):
    case_map = copy.deepcopy(base)
    entry = next(e for e in case_map['cases'] if e['case'] == case)
    for key in ('also', 'note'):
        entry.pop(key, None)
    entry['target'], entry['reason'] = target, reason
    return case_map


if __name__ == '__main__':
    unittest.main(verbosity=2)
