#!/usr/bin/env python3
"""Validate the 258-case TypeScript case map (ADR 0004 §10.4).

docs/verification/ts-case-map.json must map every named regression case in
docs/planning/github-plan.json, exactly once, either to a TypeScript test id
(`<file> › <name>`) declared in docs/planning/workers-waves.json or to
`retired:<A#|D>` with a reason. A retirement must cite an ADR 0004 §9
amendment (A1–A20) or the §9.3 dropped list (D), and the leaf's issue amendment
in docs/planning/AMENDMENTS-workers.md must list that id.

With --check-tests, every mapped test file must also exist and contain the
mapped test name. That final existence check is enforced by W7-01; until the
TypeScript suites exist it fails by design.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_CASES = 258
SEPARATOR = ' › '
ALLOWED_RETIREMENTS = {f'A{number}' for number in range(1, 21)} | {'D'}
RETIRED = re.compile(r'retired:(A(?:[1-9]|1[0-9]|20)|D)')
ENTRY_KEYS = {'case', 'target', 'reason', 'note'}
AMENDMENT_IDS = re.compile(r'\b(A(?:[1-9]|1[0-9]|20)|N[1-4]|D)\b')


class CaseMapError(Exception):
    """One or more case-map violations; the CLI exits nonzero."""

    def __init__(self, problems):
        self.problems = list(problems)
        super().__init__('\n'.join(self.problems))


def _reject_duplicate_keys(pairs):
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise CaseMapError([f'duplicate JSON key {key!r}'])
        seen[key] = value
    return seen


def load_json(path):
    """Parse JSON, rejecting duplicate object keys that json.loads would silently merge."""
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'), object_pairs_hook=_reject_duplicate_keys)
    except (OSError, ValueError) as error:
        raise CaseMapError([f'{path}: {error}']) from error


def plan_case_ids(plan):
    """Return the ordered `<leaf>/<name>` ids of every named case in github-plan.json."""
    ids = [f"{issue['key']}/{case['name']}"
           for issue in plan['issues'] if issue.get('role') == 'implementation'
           for case in issue['test_cases']]
    duplicates = sorted({case for case in ids if ids.count(case) > 1})
    problems = [f'github-plan.json: duplicate case id {case}' for case in duplicates]
    if len(set(ids)) != EXPECTED_CASES:
        problems.append(f'github-plan.json: expected exactly {EXPECTED_CASES} unique case ids, found {len(set(ids))}')
    if problems:
        raise CaseMapError(problems)
    return ids


def wave_test_ids(waves):
    return {test for wave in waves for package in wave['packages'] for test in package['tests']}


def amendment_sections(text):
    """Map each `### <leaf key> …` section to the ids on its `**Amendment ids:**` line."""
    sections = {}
    current = None
    for line in text.splitlines():
        if line.startswith('### '):
            current = line[4:].split(' ', 1)[0]
            sections.setdefault(current, set())
        elif line.startswith('## '):
            current = None
        elif current and line.startswith('**Amendment ids:**'):
            sections[current] |= set(AMENDMENT_IDS.findall(line))
    return sections


def test_location(target):
    """Return (path, name, is_test_file) for a mapped test id."""
    prefix, name = target.split(SEPARATOR, 1)
    if ' ' not in prefix:
        return prefix, name, True
    tokens = prefix.split()
    for token in tokens:
        if not token.startswith('-') and ('/' in token or re.search(r'\.(py|sh|ts|tsx|js|yml|yaml)$', token)):
            return token, name, False
    if tokens[:2] == ['cargo', 'run'] and '-p' in tokens and '--example' in tokens:
        crate = tokens[tokens.index('-p') + 1].removeprefix('atmusic-')
        return f'crates/{crate}/examples/{tokens[tokens.index("--example") + 1]}.rs', name, False
    raise CaseMapError([f'cannot locate the test file for {target!r}'])


def _unescape(text):
    return text.replace('\\\\', '\\').replace("\\'", "'").replace('\\"', '"')


def check_test_exists(root, target):
    path, name, is_test_file = test_location(target)
    location = root / path
    if not location.exists():
        return f'test file missing for {target!r}: {path}'
    if not is_test_file:
        return None
    files = [location] if location.is_file() else sorted(p for p in location.rglob('*') if p.is_file())
    if not any(name in _unescape(file.read_text(encoding='utf-8', errors='replace')) for file in files):
        return f'test name missing from {path}: {name!r}'
    return None


def validate(case_map, plan, waves, amendments_text, root=ROOT, check_tests=False):
    """Validate a parsed case map; return a summary or raise CaseMapError listing every problem."""
    expected = plan_case_ids(plan)
    known_tests = wave_test_ids(waves)
    sections = amendment_sections(amendments_text)
    problems = []
    if not isinstance(case_map, dict) or case_map.get('schemaVersion') != 1 or not isinstance(case_map.get('cases'), list):
        raise CaseMapError(['case map must be an object with schemaVersion 1 and a cases list'])
    seen = set()
    retired = mapped = 0
    for index, entry in enumerate(case_map['cases']):
        if not isinstance(entry, dict) or not isinstance(entry.get('case'), str) or not isinstance(entry.get('target'), str):
            problems.append(f'entry {index}: needs string case and target')
            continue
        case, target = entry['case'], entry['target']
        unknown_keys = sorted(set(entry) - ENTRY_KEYS)
        if unknown_keys:
            problems.append(f'{case}: unknown keys {unknown_keys}')
        if 'note' in entry and not (isinstance(entry['note'], str) and entry['note'].strip()):
            problems.append(f'{case}: note must be a nonempty string')
        if case in seen:
            problems.append(f'duplicate case id {case}')
            continue
        seen.add(case)
        if case not in expected:
            problems.append(f'unknown case id {case} (not a named case in github-plan.json)')
        if target.startswith('retired'):
            retired += 1
            match = RETIRED.fullmatch(target)
            if not match:
                problems.append(f'{case}: retired entry without amendment id ({target!r}); use retired:<A1–A20|D>')
                continue
            if not (isinstance(entry.get('reason'), str) and entry['reason'].strip()):
                problems.append(f'{case}: retired entry needs a nonempty reason')
            leaf = case.split('/', 1)[0]
            if match.group(1) not in sections.get(leaf, set()):
                problems.append(f'{case}: AMENDMENTS-workers.md section {leaf} does not list amendment id {match.group(1)}')
        else:
            mapped += 1
            if 'reason' in entry:
                problems.append(f'{case}: reason is only for retired entries')
            if target not in known_tests:
                problems.append(f'{case}: {target!r} is not a test id declared in workers-waves.json')
            elif check_tests:
                missing = check_test_exists(Path(root), target)
                if missing:
                    problems.append(f'{case}: {missing}')
    for case in expected:
        if case not in seen:
            problems.append(f'missing case id {case}')
    if not problems and len(seen) != EXPECTED_CASES:
        problems.append(f'expected exactly {EXPECTED_CASES} cases, found {len(seen)}')
    if problems:
        raise CaseMapError(problems)
    return {'cases': len(seen), 'mapped': mapped, 'retired': retired}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n', 1)[0])
    parser.add_argument('--check-tests', action='store_true', help='also require every mapped test file and name to exist')
    parser.add_argument('--root', type=Path, default=ROOT, help='repository root for --check-tests')
    parser.add_argument('--map', type=Path, default=ROOT / 'docs/verification/ts-case-map.json')
    parser.add_argument('--plan', type=Path, default=ROOT / 'docs/planning/github-plan.json')
    parser.add_argument('--waves', type=Path, default=ROOT / 'docs/planning/workers-waves.json')
    parser.add_argument('--amendments', type=Path, default=ROOT / 'docs/planning/AMENDMENTS-workers.md')
    args = parser.parse_args(argv)
    try:
        amendments = args.amendments.read_text(encoding='utf-8')
    except OSError as error:
        print(f'FAIL case map: {error}', file=sys.stderr)
        return 1
    try:
        summary = validate(load_json(args.map), load_json(args.plan), load_json(args.waves), amendments,
                           root=args.root, check_tests=args.check_tests)
    except CaseMapError as error:
        for problem in error.problems:
            print(f'FAIL case map: {problem}', file=sys.stderr)
        return 1
    suffix = '; every mapped test file and name exists' if args.check_tests else ''
    print(f"PASS case map: {summary['cases']} unique cases ({summary['mapped']} mapped to wave test ids, "
          f"{summary['retired']} retired with amendment ids){suffix}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
