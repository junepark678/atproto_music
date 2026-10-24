#!/usr/bin/env python3
"""Regression tests for scripts/validate_case_map.py.

Each test mutates a temporary copy of the committed inputs and runs the real
validator, both as a function and as the CLI, asserting the exit status and the
exact problem it reports. The committed files are never modified.
"""

import copy
import json
from pathlib import Path
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


def committed():
    return (json.loads(MAP.read_text()), json.loads(PLAN.read_text()),
            json.loads(WAVES.read_text()), AMENDMENTS.read_text())


def run_cli(case_map=None, plan=None, map_text=None, amendments=None, extra=()):
    """Run the validator CLI on temporary inputs; return (exit code, stdout, stderr)."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        map_path, plan_path, amend_path = tmp / 'map.json', tmp / 'plan.json', tmp / 'amend.md'
        map_path.write_text(map_text if map_text is not None else json.dumps(case_map if case_map is not None else committed()[0]))
        plan_path.write_text(json.dumps(plan if plan is not None else committed()[1]))
        amend_path.write_text(amendments if amendments is not None else AMENDMENTS.read_text())
        result = subprocess.run(
            [sys.executable, str(SCRIPT), '--map', str(map_path), '--plan', str(plan_path),
             '--waves', str(WAVES), '--amendments', str(amend_path), *extra],
            capture_output=True, text=True, check=False)
        return result.returncode, result.stdout, result.stderr


def problems(case_map, plan=None, amendments=None, **kwargs):
    base_map, base_plan, waves, base_amend = committed()
    try:
        vcm.validate(case_map, plan or base_plan, waves, base_amend if amendments is None else amendments, **kwargs)
    except vcm.CaseMapError as error:
        return error.problems
    return []


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
        index = next(i for i, e in enumerate(base['cases']) if e['case'] == 'M1.1.4/required_auth')
        for target in ['retired', 'retired:', 'retired:A21', 'retired:A0', 'retired:X', 'retired: D', 'retired:D,A3']:
            case_map = copy.deepcopy(base)
            case_map['cases'][index]['target'] = target
            found = problems(case_map)
            self.assertEqual(len(found), 1, (target, found))
            self.assertIn('M1.1.4/required_auth: retired entry without amendment id', found[0])
        case_map = copy.deepcopy(base)
        case_map['cases'][index]['target'] = 'retired:'
        code, _, stderr = run_cli(case_map)
        self.assertEqual(code, 1)
        self.assertIn("FAIL case map: M1.1.4/required_auth: retired entry without amendment id ('retired:')", stderr)
        # A valid id still needs a reason ...
        case_map = copy.deepcopy(base)
        del case_map['cases'][index]['reason']
        self.assertEqual(problems(case_map), ['M1.1.4/required_auth: retired entry needs a nonempty reason'])
        # ... and the leaf's issue amendment must list that id.
        case_map = copy.deepcopy(base)
        case_map['cases'][index]['target'] = 'retired:A15'
        self.assertEqual(problems(case_map), ['M1.1.4/required_auth: AMENDMENTS-workers.md section M1.1.4 does not list amendment id A15'])
        amendments = AMENDMENTS.read_text().replace('### M1.1.4 ', '### M1.1.4-removed ', 1)
        self.assertEqual(problems(base, amendments=amendments),
                         ['M1.1.4/required_auth: AMENDMENTS-workers.md section M1.1.4 does not list amendment id D'])

    def test_rejects_a_test_id_outside_the_waves(self):
        """rejects a mapped target that is not a wave test id"""
        case_map = committed()[0]
        entry = next(e for e in case_map['cases'] if not e['target'].startswith('retired'))
        entry['target'] = 'worker/test/read/history.test.ts › invented name'
        self.assertEqual(problems(case_map), [f"{entry['case']}: 'worker/test/read/history.test.ts › invented name' is neither "
                                              "declared in workers-waves.json nor listed under Required wave amendments"])
        # An `also` id is held to the same rule as the target.
        case_map = committed()[0]
        entry = next(e for e in case_map['cases'] if e['case'] == 'M2.1.2/fetch_bounds')
        entry['also'] = ['worker/test/read/history.test.ts › invented also']
        self.assertEqual(problems(case_map), ["M2.1.2/fetch_bounds: 'worker/test/read/history.test.ts › invented also' is neither "
                                              "declared in workers-waves.json nor listed under Required wave amendments"])

    def test_check_tests_requires_existing_files_and_names(self):
        """--check-tests reports a missing test file or name"""
        case_map, plan, waves, amendments = committed()
        pending, parse_problems = vcm.wave_amendments(amendments)
        self.assertEqual(parse_problems, [])
        declared = vcm.wave_test_ids(waves)
        unapplied = sorted(test for test in pending if test not in declared)
        self.assertTrue(unapplied)
        # Until the owner applies the required wave amendments, --check-tests fails once per unapplied test id.
        found = problems(case_map, check_tests=True, root=Path('/nonexistent'))
        not_applied = [p for p in found if p.startswith('required wave amendment not applied:')]
        self.assertEqual(len(not_applied), len(unapplied))
        # Apply them to a copy of the wave plan, then build every referenced test file in a temporary root.
        applied = copy.deepcopy(waves)
        packages = {package['id']: package for wave in applied for package in wave['packages']}
        for test in unapplied:
            packages[pending[test]]['tests'].append(test)
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
            self.assertEqual(summary, {'cases': 258, 'mapped': len(mapped), 'awaiting': 0, 'retired': 258 - len(mapped), 'amendments': 0})
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
        index = next(i for i, e in enumerate(base['cases']) if e['case'] == 'M1.4.1/bind_precedence')
        for reason in ['There is no CLI (covered by worker/test/storage/migrate.test.ts).',
                       'The re-auth state is web/test/oauth/session.test.ts.',
                       'See worker/test/storage/migrate.test.ts › re-running migrate is a no-op.']:
            case_map = copy.deepcopy(base)
            case_map['cases'][index]['reason'] = reason
            self.assertEqual(problems(case_map),
                             ['M1.4.1/bind_precedence: retired reason claims test coverage; a covered case is mapped, not retired'])
        case_map = copy.deepcopy(base)
        case_map['cases'][index]['also'] = [next(e['target'] for e in base['cases'] if e['case'] == 'M1.4.1/migrate_only')]
        self.assertEqual(problems(case_map), ['M1.4.1/bind_precedence: also is only for mapped entries'])

    def test_required_wave_amendment_registry(self):
        """required wave amendments must be listed under a real package and referenced by a case"""
        case_map, _, waves, amendments = committed()
        pending, _ = vcm.wave_amendments(amendments)
        test = 'web/test/routes/feed.test.tsx › anonymous user selecting following sees a sign-in prompt and no scope=following request is sent'
        self.assertEqual(pending[test], 'W3-06')
        # Removing its registry line leaves the referencing case pointing at an unknown id.
        line = next(l for l in amendments.splitlines() if l.startswith(f'- `{test}`'))
        found = problems(case_map, amendments=amendments.replace(line + '\n', '', 1))
        self.assertEqual(found, [f"M7.3.1/anonymous_following: {test!r} is neither declared in workers-waves.json "
                                 "nor listed under Required wave amendments"])
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
        self.assertEqual(summary['amendments'], len(pending))
        result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        self.assertIn(f"PASS case map: 258 unique cases ({summary['mapped']} mapped to declared wave test ids, "
                      f"{summary['awaiting']} awaiting {len(pending)} required wave amendment tests, "
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
