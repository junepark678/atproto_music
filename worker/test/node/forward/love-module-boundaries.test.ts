import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const require = createRequire(resolve(root, 'package.json'));
const tsx = require.resolve('tsx/cli');

const entries = [
  './worker/src/do/ingest/hints.ts',
  './worker/src/do/ingest/live-pending-removals.ts',
  './worker/src/bff/reconcile.ts',
  './worker/src/outbox/forward-enqueue.ts',
  './worker/src/outbox/love-ops.ts',
  './worker/src/outbox/forward-key.ts',
  './worker/src/outbox/forward-receipts.ts',
  './worker/src/forward/love-coverage-authority.ts',
  './worker/src/forward/love-api-recipients.ts',
  './worker/src/forward/forward-outbox.ts',
  './worker/src/outbox/operation-certainty.ts',
  './worker/src/forward/backfill.ts',
  './worker/src/forward/forwarder.ts',
  './worker/src/musicbrainz/revive-loves.ts',
  './worker/src/node/features.ts',
];

function smoke(order: readonly string[]): void {
  const imports = `(async()=>{${order.map((entry) => `await import(${JSON.stringify(entry)})`).join(';')}})().catch(error=>{console.error(error);process.exitCode=1})`;
  const result = spawnSync(process.execPath, [tsx, '-e', imports], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

describe('B2/L2 module boundaries', () => {
  it('loads producer, recipient leaf, executor, settlement, cleanup, backfill, forwarding and Node entries in both orders', () => {
    smoke(entries);
    smoke([...entries].reverse());
  }, 60_000);

  it('keeps the B2 dependency layers acyclic at runtime', () => {
    const runtimeImports = (file: string) =>
      readFileSync(resolve(root, file), 'utf8').matchAll(/^import (?!type ).+? from ['"]([^'"]+)['"];?$/gm);
    const forbidden: Record<string, string[]> = {
      'worker/src/forward/love-coverage-authority.ts': [
        'hints',
        'live-pending-removals',
        'forward-enqueue',
        'backfill',
        'forward-key',
        'forward-receipts',
        'love-deferral-storage',
      ],
      'worker/src/forward/love-api-recipients.ts': [
        'forward-enqueue',
        'love-ops',
        'backfill',
        'hints',
        'live-pending-removals',
        'forward-outbox',
        'forwarder',
      ],
      'worker/src/forward/love-deferral-storage.ts': [
        'forward-key',
        'forward-enqueue',
        'backfill',
        'love-coverage',
        'love-deferral-maintenance',
        'hints',
        'live-pending-removals',
      ],
      'worker/src/forward/love-deferral-maintenance.ts': [
        'love-coverage',
        'forward-enqueue',
        'backfill',
        'hints',
        'live-pending-removals',
      ],
      'worker/src/forward/love-coverage.ts': ['hints', 'live-pending-removals'],
      'worker/src/forward/love-delivery.ts': ['forward-enqueue', 'backfill', 'love-coverage', 'forward-key'],
      'worker/src/outbox/forward-identity.ts': [],
      'worker/src/outbox/operation-certainty.ts': [],
    };
    for (const [file, names] of Object.entries(forbidden)) {
      const imports = [...runtimeImports(file)].map((match) => match[1] ?? '');
      expect(
        imports.filter((specifier) => names.some((name) => specifier.endsWith(`/${name}`))),
        file,
      ).toEqual([]);
    }
  });
});
