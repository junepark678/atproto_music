#!/usr/bin/env python3
"""Validate hierarchy integrity and independently check hand-calculated fixtures."""
from collections import Counter
from datetime import datetime, timedelta
import json
from pathlib import Path
import unicodedata

root = Path(__file__).resolve().parents[1]
plan = json.loads((root / 'docs/planning/github-plan.json').read_text())
issues = {i['key']: i for i in plan['issues']}
assert len(issues) == len(plan['issues']), 'duplicate issue keys'
milestones = {m['key'] for m in plan['milestones']}
for issue in issues.values():
    assert issue['milestone'] in milestones
    if issue['parent']:
        assert issue['parent'] in issues
        assert issues[issue['parent']]['milestone'] == issue['milestone']
    assert all(d in issues for d in issue.get('dependencies', []))
    if issue.get('role') == 'implementation':
        cases = issue['test_cases']
        assert len(cases) == 3
        assert len({t['name'] for t in cases}) == 3
        assert all(t['action'] and t['expected'] for t in cases)
        assert issue['paths']
    if issue.get('child_keys'):
        actual = {i['key'] for i in issues.values() if i['parent'] == issue['key']}
        assert actual == set(issue['child_keys'])
done = set()
def visit(key, stack):
    assert key not in stack, f'dependency cycle: {key}'
    if key in done:
        return
    for dep in issues[key].get('dependencies', []):
        visit(dep, stack | {key})
    done.add(key)
for key in issues:
    visit(key, set())

fixture = json.loads((root / 'tests/fixtures/read_models.json').read_text())
def at(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))
def norm(value):
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())
now = at(fixture['asOf'])
alice = fixture['users']['Alice']['did']
active = [r for r in fixture['scrobbles'] if r['state'] == 'confirmed']
assert len({r['uri'] for r in fixture['scrobbles']}) == len(fixture['scrobbles'])
order = lambda r: (at(r['record']['listenedAt']), r['uri'])
history = sorted([r for r in active if r['owner'] == alice], key=order, reverse=True)
assert [r['rkey'] for r in history] == fixture['expected']['aliceHistory']
assert [r['rkey'] for r in sorted(active, key=order, reverse=True)] == fixture['expected']['globalFeed']
targets = {f['subject'] for f in fixture['follows'] if f['actor'] == alice and f['state'] == 'confirmed'}
assert [r['rkey'] for r in sorted(active, key=order, reverse=True) if r['owner'] in targets] == fixture['expected']['aliceFollowingFeed']
for window, days in [('all', None), ('7d', 7), ('30d', 30), ('365d', 365)]:
    records = [r['record'] for r in history if at(r['record']['listenedAt']) <= now and
               (days is None or at(r['record']['listenedAt']) >= now - timedelta(days=days))]
    actual = {'totalScrobbles': len(records),
              'distinctArtists': len({norm(r['artist']) for r in records}),
              'distinctTracks': len({(norm(r['artist']), norm(r['track'])) for r in records})}
    assert actual == fixture['expected']['aliceStats'][window], (window, actual)
artists = Counter(norm(r['record']['artist']) for r in history)
assert artists == {'björk': 2, 'radiohead': 3, 'kate bush': 2}
leaves = [i for i in issues.values() if i.get('role') == 'implementation']
print(f'PASS: {len(milestones)} milestones, {len(issues)} issues, {len(leaves)} leaves, '
      f'{sum(len(i["test_cases"]) for i in leaves)} test specifications, acyclic dependencies, '
      'exact fixture histories/feeds and all four statistics windows')
