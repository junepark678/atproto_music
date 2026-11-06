import { expect, it } from 'vitest';
import { main, REQUIRED_RECOVERY_TARGETS, recoveryAccounting } from '../acceptance/node-recovery';
import { checkTag } from '../package-node-release';
import type { CaseRecord } from '../report-tests';

it('unrun_gate: every required recovery journey must be present and pass exactly once', () => {
  const passing = REQUIRED_RECOVERY_TARGETS.map(
    (target): CaseRecord => ({ target, result: 'passed', executed: 1, command: 'fixture', commit: 'test' }),
  );
  expect(recoveryAccounting(passing)).toEqual([]);
  for (let i = 0; i < passing.length; i++) {
    const target = passing[i]!.target;
    const other = passing.filter((_, index) => index !== i);
    for (const records of [
      other,
      [...other, { ...passing[i]!, executed: 0 }],
      [...other, { ...passing[i]!, result: 'skipped' as const }],
      [...other, { ...passing[i]!, result: 'failed' as const }],
      [...other, { ...passing[i]!, target: 'some other test' }],
      [...passing, passing[i]!],
    ]) {
      expect(recoveryAccounting(records)).toContain(`required case unexecuted or not passed: ${target}`);
    }
  }
});
it('recovery CLI refuses skip/filter arguments rather than silently omitting a required journey', async () => {
  expect(await main(['--skip', 'recovery'])).toBe(2);
});
it('Node candidate version validation rejects mismatching tags and lockfiles before packaging', () => {
  expect(() => checkTag('v0.0.0', '0.0.0', '0.0.0')).not.toThrow();
  for (const [tag, version, lock] of [
    ['v0.1.0', '0.0.0', '0.0.0'],
    ['v0.0.0', '0.0.0', '0.1.0'],
    ['v00.0.0', '00.0.0', '00.0.0'],
    ['v0.0.0-beta', '0.0.0-beta', '0.0.0-beta'],
  ]) {
    expect(() => checkTag(tag!, version!, lock!)).toThrow('version mismatch');
  }
});
