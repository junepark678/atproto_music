// M1.4.3/harness_isolation. The peer file is isolation-peer.test.ts.
//
// On Node (ADR 0005 §15.1, N2-02) the isolation comes from the `cloudflare:*`
// shim: vitest evaluates the shim once per test file, and each evaluation
// keeps its Durable Objects' SQLite files in a new temporary directory. The
// second test checks that mechanism directly (the probe of the first test and
// of isolation-peer.test.ts checks its outcome across the two real files).

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { doDb } from '../../src/do/db';
import * as workersShim from '../node/support/cloudflare-workers-shim';
import type { HarnessDO } from './harness-do';
import { probeIsolation, SHARED_DO_NAME, T0 } from './isolation-probe';

describe('worker/test/harness', () => {
  it('rows written under one DO name are absent under another DO name and in another test file', async () => {
    await probeIsolation('isolation');
  });

  it('each test file gets its own temporary database file and a write in one is invisible to another', async () => {
    const MARKER = 'did:plc:isofilemarker';
    const stub = env.HARNESS.get(env.HARNESS.idFromName(SHARED_DO_NAME));
    await runInDurableObject(stub, (_i: HarnessDO, state) => {
      doDb(state.storage).run('INSERT INTO users(did, joined_at) VALUES (?, ?)', MARKER, T0);
    });

    // This file's objects live in one temporary directory of its own: one
    // SQLite file per Durable Object this file created, nothing else.
    const dir = workersShim.shimStorageDir();
    expect(dirname(dir)).toBe(tmpdir());
    expect(basename(dir)).toMatch(/^atmusic-shim-/);
    const entry = workersShim.shimObject(workersShim.stubId(stub));
    expect(dirname(entry.path)).toBe(dir);
    expect(existsSync(entry.path)).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite'));
    expect(files.sort()).toEqual(
      workersShim
        .shimObjects()
        .map((o) => basename(o.path))
        .sort(),
    );
    expect(files.length).toBeGreaterThanOrEqual(5); // the probe's objects and the shared one

    // Another test file gets a fresh evaluation of the shim (vitest isolates
    // the module graph per file): a new directory, and the same DO name opens
    // a different, freshly migrated database without this file's marker.
    vi.resetModules();
    const other = await import('../node/support/cloudflare-workers-shim');
    const otherTest = await import('../node/support/cloudflare-test-shim');
    try {
      expect(other).not.toBe(workersShim);
      const otherStub = other.env.HARNESS.get(other.env.HARNESS.idFromName(SHARED_DO_NAME));
      const seen = await otherTest.runInDurableObject(otherStub, (_i, state) => {
        const db = doDb(state.storage);
        const users = db.all('SELECT did FROM users ORDER BY did');
        db.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', 'did:plc:otherfile', T0);
        return users;
      });
      expect(seen).toEqual([]);
      const otherDir = other.shimStorageDir();
      expect(otherDir).not.toBe(dir);
      expect(dirname(otherDir)).toBe(tmpdir());
      const otherPath = other.shimObject(other.stubId(otherStub)).path;
      expect(otherPath).not.toBe(entry.path);
      expect(basename(otherPath)).toBe(basename(entry.path)); // same object id, different file
      // The other file's teardown removes its directory, and only that.
      other.shimTeardown();
      expect(existsSync(otherDir)).toBe(false);
    } finally {
      other.shimTeardown();
    }
    expect(existsSync(entry.path)).toBe(true);

    // The other file's write is invisible here; this file's marker is intact.
    const users = await runInDurableObject(stub, (_i: HarnessDO, state) =>
      doDb(state.storage).all<{ did: string }>('SELECT did FROM users ORDER BY did'),
    );
    expect(users.map((u) => u.did)).toContain(MARKER);
    expect(users.map((u) => u.did)).not.toContain('did:plc:otherfile');
  });
});
