// Lint for ADR 0004 F3: no read-check-write may span an await, so no source
// file may pass an async callback to db.tx / transactionSync. The type of
// Db.tx already rejects Promise-returning callbacks; this catches code that
// casts around it. Sources are loaded through Vite's import.meta.glob because
// the test itself runs inside workerd, which has no host filesystem.
import { describe, expect, it } from 'vitest';

const GLOBBED: Record<string, string> = {
  ...import.meta.glob('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob(['../**/*.ts', '!./no-async-tx.test.ts'], { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob(['../../../packages/*/src/**/*.ts', '../../../packages/*/test-support/**/*.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob(['../../../packages/*/test/**/*.ts'], { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob(['../../../web/src/**/*.{ts,tsx}', '../../../web/test/**/*.{ts,tsx}'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
};

/** Resolve a glob key (relative to this file) to a repository-relative path. */
function repoPath(key: string): string {
  const parts = ['worker', 'test', 'storage'];
  for (const segment of key.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(GLOBBED).map(([key, source]) => [repoPath(key), source]),
);

// `tx(async`, `tx<T>(async`, `transactionSync(async`, with any whitespace or
// newlines between the tokens; also `async function` callbacks.
const ASYNC_TX = /\b(?:tx|transactionSync)\s*(?:<[^>()]*>)?\s*\(\s*async\b/g;

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findAsyncTx(file: string, source: string): Violation[] {
  const lines = source.split('\n');
  const isTestFile = /(^|\/)test\//.test(file);
  const out: Violation[] = [];
  for (const match of source.matchAll(ASYNC_TX)) {
    const line = source.slice(0, match.index).split('\n').length;
    // Compile-time negative tests (`// @ts-expect-error` on the previous line)
    // are allowed in test files only; they document the type contract.
    if (isTestFile && (lines[line - 2] ?? '').includes('@ts-expect-error')) continue;
    out.push({ file, line, text: (lines[line - 1] ?? '').trim() });
  }
  return out;
}

describe('db.tx lint', () => {
  it('no source file passes an async callback to db.tx', () => {
    const files = Object.keys(SOURCES).sort();
    // The globs really cover the shared interfaces and the harness.
    for (const expected of [
      'worker/src/do/db.ts',
      'worker/src/do/migrate.ts',
      'worker/src/do/contracts.ts',
      'worker/test/harness/local-index.ts',
      'worker/test/storage/db.test.ts',
      'packages/core/src/deps.ts',
      'packages/core/test-support/clock.ts',
      'packages/atproto/src/verify/types.ts',
    ]) {
      expect(files).toContain(expected);
    }
    expect(files).not.toContain('worker/test/storage/no-async-tx.test.ts');
    for (const file of files) expect(typeof SOURCES[file]).toBe('string');

    const violations = files.flatMap((file) => findAsyncTx(file, SOURCES[file] ?? ''));
    expect(violations).toEqual([]);
  });

  it('detector flags async tx callbacks and nothing else', () => {
    const bad = [
      'db.tx(async () => { await x; })',
      'm.db.tx( async\n  () => 1)',
      'db.tx<number>(async () => 1)',
      'storage.transactionSync(async () => {})',
      'this.ctx.storage.transactionSync(\n\tasync function () {})',
    ];
    for (const sample of bad) expect(findAsyncTx('src/x.ts', sample), sample).toHaveLength(1);
    // The ts-expect-error exemption applies to test files only.
    const expectError = '// @ts-expect-error\ndb.tx(async () => 1);';
    expect(findAsyncTx('worker/test/x.test.ts', expectError)).toEqual([]);
    expect(findAsyncTx('worker/src/x.ts', expectError)).toEqual([
      { file: 'worker/src/x.ts', line: 2, text: 'db.tx(async () => 1);' },
    ]);

    const good = [
      'db.tx(() => { db.run("x"); })',
      'const asyncTx = 1; txAsync(async () => 1);',
      'await fetchProof(); db.tx(() => apply(db, proof));',
      'ctx.blockConcurrencyWhile(async () => migrate(storage))',
    ];
    for (const sample of good) expect(findAsyncTx('src/x.ts', sample), sample).toEqual([]);
  });
});
