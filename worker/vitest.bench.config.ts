// Read-model benchmark on Node 26 (W6-02, ported by N4-03; ADR 0005 §15.1,
// §15.3).
//
// The suite runs in plain Node over node:sqlite: the data enters through the
// production verify + apply path, the module reads are timed in-process, and
// the HTTP measurements go through the production Node composition
// (test/composition/support.ts: compose, the dispatcher and the HTTP bridge on
// 127.0.0.1:0). Inputs, through `provide.bench`: the report schema and
// constants of scripts/benchmark-read-models.ts (which the suite validates its
// report against before it writes it), the output path (ATMUSIC_BENCH_OUT,
// default work/bench/read-models.json), the pacing (ATMUSIC_BENCH_PACED=1:
// 100 ms between requests; otherwise none, so the repository gate never
// sleeps), the host facts and the suite's named tests. Large fixtures live
// only in this project (ADR 0005 §15.1 gate duration).

import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import {
  BENCH_REPORT_SCHEMA,
  DEFAULT_REPORT_PATH,
  hostFacts,
  namedTests,
  PACED_INTERVAL_MS,
  PINNED_SQLITE,
  REPO_ROOT,
  REPORT_SCHEMA_ID,
} from '../scripts/benchmark-read-models.ts';

const readIfPresent = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : null);

export default defineConfig({
  test: {
    name: 'worker-bench',
    environment: 'node',
    include: ['test/bench/**/*.test.ts'],
    provide: {
      bench: {
        schema: BENCH_REPORT_SCHEMA,
        schemaId: REPORT_SCHEMA_ID,
        pinnedSqlite: PINNED_SQLITE,
        outPath: process.env.ATMUSIC_BENCH_OUT ?? DEFAULT_REPORT_PATH,
        intervalMs: process.env.ATMUSIC_BENCH_PACED === '1' ? PACED_INTERVAL_MS : 0,
        repoRoot: REPO_ROOT,
        host: hostFacts(readIfPresent),
        namedTests: namedTests(),
      },
    },
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
