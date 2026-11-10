// B1 bounded receipt/gap lookup evidence. Growth fixtures live only in worker-bench.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  ADMISSION_HIGH_WATER_SQL,
  GAP_ADMISSION_OWNER_SQL,
  NEWEST_OPEN_LINK_GAP_SQL,
} from '../../src/forward/coverage';
import {
  FORWARD_OUTBOX_COVERAGE_SQL,
  FORWARD_RECEIPT_LOOKUP_SQL,
  releaseUnsentReceiptsSql,
} from '../../src/outbox/forward-receipts';
import { withMigratedDb } from '../node/support/node-db';

it('keeps receipt and admission ownership VM work bounded through 100k rows per link', async () => {
  await withMigratedDb((db, context) => {
    db.close();
    const input = JSON.stringify({
      receipt: FORWARD_RECEIPT_LOOKUP_SQL,
      outbox: FORWARD_OUTBOX_COVERAGE_SQL,
      release: releaseUnsentReceiptsSql(1),
      gapOwner: GAP_ADMISSION_OWNER_SQL,
      newestGap: NEWEST_OPEN_LINK_GAP_SQL,
      highWater: ADMISSION_HIGH_WATER_SQL,
    });
    const output = execFileSync(
      'python3',
      [fileURLToPath(new URL('./support/link-coverage-bench.py', import.meta.url)), context.path],
      { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    const reports = JSON.parse(output) as Array<{
      sizePerLink: number;
      plans: Record<string, string[]>;
      measurements: Record<string, { steps: number; rows: number; changes: number }>;
    }>;
    console.info(JSON.stringify(reports));
    expect(reports.map((report) => report.sizePerLink)).toEqual([1_000, 100_000]);
    for (const report of reports) {
      for (const details of Object.values(report.plans)) expect(details.join(' ')).not.toMatch(/\bSCAN\b|TEMP B-TREE/i);
      expect(report.measurements.receiptHit!.rows).toBe(1);
      expect(report.measurements.receiptMiss!.rows).toBe(0);
      expect(report.measurements.outboxHit!.rows).toBe(1);
      expect(report.measurements.gapOwner!.rows).toBe(1);
      expect(report.measurements.newestGap!.rows).toBe(1);
      expect(report.measurements.release!.changes).toBe(1);
      expect(report.measurements.negativeControl!.rows).toBe(0);
    }
    for (const key of [
      'receiptHit',
      'receiptMiss',
      'outboxHit',
      'gapOwner',
      'newestGap',
      'highWater',
      'release',
    ] as const) {
      const small = reports[0]!.measurements[key]!.steps;
      const large = reports[1]!.measurements[key]!.steps;
      expect(large, `${key} VM steps at 100k rows/link`).toBeLessThanOrEqual(small * 1.5);
    }
    expect(reports[1]!.measurements.negativeControl!.steps).toBeGreaterThan(
      reports[0]!.measurements.negativeControl!.steps * 5,
    );
  });
});
