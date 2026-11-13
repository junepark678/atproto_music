// Exercise production-owned SQL against the real migrated database. The large
// transactional SQL fixtures and VM counters run only in worker-bench.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { LOVE_BRIDGE_EXCLUSION_SQL } from '../../src/forward/backfill';
import { RETAINED_RECORD_PROVENANCE_SQL, retainedRecordProvenance } from '../../src/forward/projection';
import { withMigratedDb } from '../node/support/node-db';

it('bounds production provenance and bridge query VM work at 1k and 10k with regression controls', async () => {
  await withMigratedDb((db, ctx) => {
    // Require the production entry point to execute the exported definition.
    const one = db.one.bind(db);
    let provenanceCalls = 0;
    db.one = ((sql, ...params) => {
      if (sql === RETAINED_RECORD_PROVENANCE_SQL) provenanceCalls++;
      return one(sql, ...params);
    }) as typeof db.one;
    expect(retainedRecordProvenance(db, 'did:test', 'love', 'missing')).toBeNull();
    expect(provenanceCalls).toBe(1);
    db.one = one;
    for (const [sql, args, index] of [
      [RETAINED_RECORD_PROVENANCE_SQL, ['did:test', 'love', 'target'], 'operations_record_target'],
      [LOVE_BRIDGE_EXCLUSION_SQL, ['did:test', 'at://did:test/love/r', 'inc', 1], '<expr>=?'],
    ] as const) {
      const plan = db
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...args)
        .map((r) => r.detail)
        .join(' ');
      expect(plan).toContain(index);
      expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
    }
    // Release the exclusive production handle before Python reads this same
    // migrated file. Python supplies the VM progress handler, not a schema.
    db.close();
    const output = execFileSync(
      process.env.PYTHON ?? 'python3',
      [fileURLToPath(new URL('./support/backfill-index-vm.py', import.meta.url)), ctx.path],
      {
        input: JSON.stringify({ bridge: LOVE_BRIDGE_EXCLUSION_SQL, provenance: RETAINED_RECORD_PROVENANCE_SQL }),
        encoding: 'utf8',
      },
    );
    const results = JSON.parse(output) as Array<{ size: number; [key: string]: unknown }>;
    expect(results.map((r) => r.size)).toEqual([1_000, 10_000]);
    console.log(JSON.stringify({ backfillIndexVm: results }));
  });
});
