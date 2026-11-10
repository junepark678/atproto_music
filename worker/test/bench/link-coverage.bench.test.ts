// Growth fixtures are direct SQL in worker-bench; Node keeps small path/page samples.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ADMISSION_HIGH_WATER_SQL, GAP_ADMISSION_OWNER_SQL, NEWEST_LINK_GAP_SQL } from '../../src/forward/coverage';
import {
  FORWARD_OUTBOX_COVERAGE_SQL,
  FORWARD_RECEIPT_LOOKUP_SQL,
  releaseUnsentReceiptsSql,
} from '../../src/outbox/forward-receipts';
import { withMigratedDb } from '../node/support/node-db';

type Measurement = {
  steps: number;
  rows: number;
  changes: number;
  owned?: boolean;
  toSeqIsNull?: boolean;
  values?: unknown[][];
};

it('bounds exact receipt and gap queries across receipt and closed-gap growth, including miss controls', async () => {
  await withMigratedDb((db, context) => {
    db.close();
    const input = JSON.stringify({
      receipt: FORWARD_RECEIPT_LOOKUP_SQL,
      outbox: FORWARD_OUTBOX_COVERAGE_SQL,
      release: releaseUnsentReceiptsSql(1),
      gapOwner: GAP_ADMISSION_OWNER_SQL,
      newestGap: NEWEST_LINK_GAP_SQL,
      highWater: ADMISSION_HIGH_WATER_SQL,
    });
    const output = execFileSync(
      'python3',
      [fileURLToPath(new URL('./support/link-coverage-bench.py', import.meta.url)), context.path],
      { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    const reports = JSON.parse(output) as Array<{
      receiptSize: number;
      gapSize: number;
      plans: Record<string, string[]>;
      measurements: Record<string, Measurement>;
    }>;
    console.info(JSON.stringify(reports));
    expect(reports.map(({ receiptSize, gapSize }) => [receiptSize, gapSize])).toEqual([
      [1_000, 1_000],
      [1_000, 10_000],
      [1_000, 50_000],
      [100_000, 1_000],
      [100_000, 10_000],
      [100_000, 50_000],
    ]);

    for (const report of reports) {
      for (const details of Object.values(report.plans))
        expect(details.join(' ')).not.toMatch(/\bSCAN (?!CONSTANT ROW)|TEMP B-TREE/i);
      const m = report.measurements;
      expect(m.receiptHit!.rows).toBe(1);
      expect(m.receiptMiss!.rows).toBe(0);
      expect(m.outboxHit!.rows).toBe(1);
      expect(m.release!.changes).toBe(1);
      expect(m.ownerAfterAll).toMatchObject({ rows: 1, owned: false });
      expect(m.ownerBetween).toMatchObject({ rows: 1, owned: false });
      for (const key of ['ownerOldestHit', 'ownerMiddleHit', 'ownerNewestHit'])
        expect(m[key]).toMatchObject({ rows: 1, owned: true });
      expect(m.newestClosed!.values?.[0]?.[1]).not.toBeNull();
      expect(m.newestOpen).toMatchObject({ rows: 1, toSeqIsNull: true });
      for (const key of ['negativeOwnerAfterAll', 'negativeOwnerBetween', 'negativeNewestAllClosed'])
        expect(m[key]!.rows).toBe(0);
    }

    for (const gapSize of [1_000, 10_000, 50_000]) {
      const small = reports.find((report) => report.receiptSize === 1_000 && report.gapSize === gapSize)!.measurements;
      const large = reports.find(
        (report) => report.receiptSize === 100_000 && report.gapSize === gapSize,
      )!.measurements;
      for (const key of ['receiptHit', 'receiptMiss', 'outboxHit', 'release', 'highWater'] as const)
        expect(large[key]!.steps, `${key} with receipt growth at ${gapSize} gaps`).toBeLessThanOrEqual(
          small[key]!.steps * 1.5,
        );
    }

    for (const key of [
      'ownerAfterAll',
      'ownerBetween',
      'ownerOldestHit',
      'ownerMiddleHit',
      'ownerNewestHit',
    ] as const) {
      const small = reports.find((report) => report.receiptSize === 1_000 && report.gapSize === 1_000)!.measurements[
        key
      ]!.steps;
      const large = reports.find((report) => report.receiptSize === 1_000 && report.gapSize === 50_000)!.measurements[
        key
      ]!.steps;
      expect(large, `${key} with closed-gap growth`).toBeLessThanOrEqual(small * 1.5);
    }
    for (const key of ['negativeOwnerAfterAll', 'negativeOwnerBetween', 'negativeNewestAllClosed'] as const) {
      const small = reports.find((report) => report.receiptSize === 1_000 && report.gapSize === 1_000)!.measurements[
        key
      ]!.steps;
      const large = reports.find((report) => report.receiptSize === 1_000 && report.gapSize === 50_000)!.measurements[
        key
      ]!.steps;
      expect(large, `${key} residual-filter control`).toBeGreaterThan(small * 20);
    }
  });
}, 120_000);
