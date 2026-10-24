// Read-model benchmark (W6-02) in real workerd against the real IndexDO.
//
// It reuses the composition Worker (test/composition/wrangler.composition.jsonc:
// INDEX bound to TestIndexDO, the production IndexDO whose only override is
// `buildDeps`), so the HTTP measurements go through the production Worker
// handlers, JS RPC and DO SQLite. Two Node-side inputs:
// - `provide.bench`: the report schema (scripts/benchmark-read-models.ts), the
//   pacing (`ATMUSIC_BENCH_PACED=1`: 100 ms between requests; otherwise none,
//   so the repository gate never sleeps) and facts about the host that a
//   Worker cannot observe (CPU, memory, cgroup limits, runtime versions).
// - `BENCH_SINK`: a service binding that runs here in Node. The suite POSTs
//   its report to it; the sink validates it against the same schema, writes
//   it to `ATMUSIC_BENCH_OUT` (default work/bench/read-models.json) and
//   answers with the SHA-256 of the bytes it wrote.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import {
  BENCH_REPORT_SCHEMA,
  DEFAULT_REPORT_PATH,
  PACED_INTERVAL_MS,
  REPO_ROOT,
  reportErrors,
} from '../scripts/benchmark-read-models.ts';

const version = (pkg: string) =>
  (JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', pkg, 'package.json'), 'utf8')) as { version: string })
    .version;
const cgroup = (file: string) => {
  const path = `/sys/fs/cgroup/${file}`;
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
};

const outPath = process.env.ATMUSIC_BENCH_OUT ?? DEFAULT_REPORT_PATH;
const paced = process.env.ATMUSIC_BENCH_PACED === '1';

export interface BenchProvided {
  schema: typeof BENCH_REPORT_SCHEMA;
  intervalMs: number;
  host: {
    node: string;
    platform: string;
    arch: string;
    osRelease: string;
    cpuModel: string;
    logicalCpus: number;
    totalMemoryBytes: number;
    cgroupCpuMax: string | null;
    cgroupMemoryMax: string | null;
    workerd: string;
    wrangler: string;
    vitestPlugin: string;
  };
}

const bench: BenchProvided = {
  schema: BENCH_REPORT_SCHEMA,
  intervalMs: paced ? PACED_INTERVAL_MS : 0,
  host: {
    node: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpuModel: cpus()[0]?.model.trim() || 'unknown',
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    cgroupCpuMax: cgroup('cpu.max'),
    cgroupMemoryMax: cgroup('memory.max'),
    workerd: version('workerd'),
    wrangler: version('wrangler'),
    vitestPlugin: version('@cloudflare/vitest-plugin'),
  },
};

async function sink(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const text = await request.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return Response.json({ errors: ['body is not JSON'] }, { status: 422 });
  }
  const errors = reportErrors(value);
  if (errors.length > 0) return Response.json({ errors }, { status: 422 });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  const written = readFileSync(outPath);
  return Response.json({
    path: outPath,
    bytes: written.length,
    sha256: createHash('sha256').update(written).digest('hex'),
  });
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/composition/wrangler.composition.jsonc' },
      miniflare: { serviceBindings: { BENCH_SINK: sink } },
    }),
  ],
  test: {
    name: 'worker-bench',
    include: ['test/bench/**/*.test.ts'],
    provide: { bench },
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
