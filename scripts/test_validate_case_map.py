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
        self.assertEqual(problems(case_map), [f"{entry['case']}: 'worker/test/read/history.test.ts › invented name' is not a test id declared in workers-waves.json"])

    def test_check_tests_requires_existing_files_and_names(self):
        """--check-tests reports a missing test file or name"""
        case_map, plan, waves, amendments = committed()
        mapped = [e for e in case_map['cases'] if not e['target'].startswith('retired')]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for entry in mapped:
                path, name, is_file = vcm.test_location(entry['target'])
                target = root / path
                if target.suffix == '' and not path.endswith('.sh'):
                    target = target / 'fixture.test.ts'
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('a', encoding='utf-8') as handle:
                    handle.write(f"it({json.dumps(name, ensure_ascii=False)}, () => {{}});\n")
            summary = vcm.validate(case_map, plan, waves, amendments, root=root, check_tests=True)
            self.assertEqual(summary, {'cases': 258, 'mapped': len(mapped), 'retired': 258 - len(mapped)})
            removed = root / 'worker/test/read/history.test.ts'
            removed.unlink()
            found = problems(case_map, root=root, check_tests=True)
            history = [e['case'] for e in mapped if e['target'].startswith('worker/test/read/history.test.ts')]
            self.assertEqual(len(found), len(history))
            self.assertTrue(all('test file missing' in p for p in found))
            feed = root / 'worker/test/read/feed.test.ts'
            feed.write_text("it('a different title', () => {});\n")
            self.assertTrue(any('test name missing from worker/test/read/feed.test.ts' in p
                                for p in problems(case_map, root=root, check_tests=True)))

    def test_accepts_the_committed_map_with_258_cases(self):
        """accepts the committed map with 258 cases"""
        case_map, plan, waves, amendments = committed()
        summary = vcm.validate(case_map, plan, waves, amendments)
        self.assertEqual(summary['cases'], 258)
        self.assertEqual(summary['mapped'] + summary['retired'], 258)
        self.assertEqual(len({e['case'] for e in case_map['cases']}), 258)
        result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        self.assertIn('PASS case map: 258 unique cases', result.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
