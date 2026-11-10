import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { withMigratedDb } from '../node/support/node-db';

it('bounds actual binding dependency lookup across matching released history', async () => {
  const sourcePath = resolve(import.meta.dirname, '../../src/forward/love-api-maintenance.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const usedSql = source.match(/const used = db.one\(\s*`([^`]+)`/)?.[1];
  expect(usedSql).toBeDefined();
  const ddl = readFileSync(
    resolve(import.meta.dirname, '../../../docs/planning/finding32-source-origin-revised57-proposal.sql'),
    'utf8',
  );
  const probePath = resolve(import.meta.dirname, 'love-api-origin-retention-growth.py');
  const probe = spawnSync('python3', [probePath], {
    input: JSON.stringify({ usedSql, ddl }),
    cwd: resolve(import.meta.dirname, '../../..'),
    encoding: 'utf8',
  });
  expect(probe.status, probe.stderr + probe.stdout).toBe(0);
  console.log('L2_ORIGIN_RETENTION_GROWTH', probe.stdout);
  const result = JSON.parse(probe.stdout) as {
    results: Array<{
      history: number;
      currentDependent: { steps: number; rows: number };
      releasedOnly: { steps: number; rows: number };
      oldPrefixNegativeControl: { steps: number };
    }>;
  };
  expect(result.results.map((entry) => entry.history)).toEqual([100, 1000, 10000]);
  expect(new Set(result.results.map((entry) => entry.currentDependent.steps)).size).toBe(1);
  expect(new Set(result.results.map((entry) => entry.releasedOnly.steps)).size).toBe(1);
  expect(result.results[2]!.oldPrefixNegativeControl.steps).toBeGreaterThan(
    result.results[0]!.oldPrefixNegativeControl.steps * 50,
  );
  await withMigratedDb((db) => {
    const plan = db.all(`EXPLAIN QUERY PLAN ${usedSql}`, 'did', 'uri', 'inc', 'did', 'needle', 'needle') as Array<{
      detail: string;
    }>;
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.some((row) => /SCAN .*love_api_(recipients|recipient_members)|USE TEMP B-TREE/i.test(row.detail))).toBe(
      false,
    );
    expect(
      plan.some((row) =>
        /love_api_recipients.*did=\? AND uri=\? AND incarnation_key=\? AND link_id=\? AND generation=\?/.test(
          row.detail,
        ),
      ),
    ).toBe(true);
  });
});
