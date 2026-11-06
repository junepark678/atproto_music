// M1.4.3/harness_isolation. The peer file is isolation-peer.test.ts.
//
// On Node (ADR 0005 §15.1; the shim of N2-02, de-shimmed by N4-04) the
// isolation comes from worker/test/node/support/with-index.ts: vitest
// evaluates it once per test file, and each evaluation keeps its named
// databases (`fileIndexes()`) in a new temporary directory. The second test
// checks that mechanism directly (the probe of the first test and of
// isolation-peer.test.ts checks its outcome across the two real files).

import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../src/do/schema';
import * as withIndexModule from '../node/support/with-index';
import { probeIsolation, SHARED_DO_NAME, T0 } from './isolation-probe';

afterAll(() => withIndexModule.closeFileIndexes());

describe('worker/test/harness', () => {
  it('rows written under one DO name are absent under another DO name and in another test file', async () => {
    await probeIsolation('isolation');
  });

  it('each test file gets its own temporary database file and a write in one is invisible to another', async () => {
    const MARKER = 'did:plc:isofilemarker';
    const set = withIndexModule.fileIndexes();
    set.get(SHARED_DO_NAME).run('INSERT INTO users(did, joined_at) VALUES (?, ?)', MARKER, T0);

    // This file's databases live in one temporary directory of its own: one
    // SQLite file per name this file created, nothing else.
    const dir = set.dir;
    expect(dirname(dir)).toBe(tmpdir());
    expect(basename(dir)).toMatch(/^atmusic-file-/);
    const path = set.pathOf(SHARED_DO_NAME);
    expect(dirname(path)).toBe(dir);
    expect(existsSync(path)).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite'));
    expect(files.sort()).toEqual(
      set
        .names()
        .map((name) => basename(set.pathOf(name)))
        .sort(),
    );
    expect(files.length).toBeGreaterThanOrEqual(5); // the probe's databases and the shared one

    // Another test file gets a fresh evaluation of the harness module (vitest
    // isolates the module graph per file): a new directory, and the same name
    // opens a different, freshly migrated database without this file's marker.
    vi.resetModules();
    const other = await import('../node/support/with-index');
    const otherSet = other.fileIndexes();
    try {
      expect(other).not.toBe(withIndexModule);
      expect(otherSet).not.toBe(set);
      expect(otherSet.names()).toEqual([]);
      const otherDb = otherSet.get(SHARED_DO_NAME);
      expect(otherSet.migrations(SHARED_DO_NAME)).toEqual([{ status: 'ready', version: SCHEMA_VERSION }]);
      expect(otherDb.all('SELECT did FROM users ORDER BY did')).toEqual([]);
      otherDb.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', 'did:plc:otherfile', T0);
      const otherDir = otherSet.dir;
      expect(otherDir).not.toBe(dir);
      expect(dirname(otherDir)).toBe(tmpdir());
      const otherPath = otherSet.pathOf(SHARED_DO_NAME);
      expect(otherPath).not.toBe(path);
      expect(basename(otherPath)).toBe(basename(path)); // same name, different file
      // The other file's teardown removes its directory, and only that.
      other.closeFileIndexes();
      expect(existsSync(otherDir)).toBe(false);
    } finally {
      other.closeFileIndexes();
    }
    expect(existsSync(path)).toBe(true);

    // The other file's write is invisible here; this file's marker is intact.
    const users = set.get(SHARED_DO_NAME).all<{ did: string }>('SELECT did FROM users ORDER BY did');
    expect(users.map((u) => u.did)).toContain(MARKER);
    expect(users.map((u) => u.did)).not.toContain('did:plc:otherfile');
  });
});
