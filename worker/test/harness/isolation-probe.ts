// Shared probe for the harness isolation tests (M1.4.3/harness_isolation, A18:
// isolated storage per test file and a unique database name per test replace
// the port-0 harness). isolation.test.ts and isolation-peer.test.ts both run
// it: each writes a marker of its own under the same shared name and checks
// that the other file's marker, and every database the other file created,
// is absent. Storage shared between the two files would make whichever runs
// second fail.
//
// On Node (ADR 0005 §15.1, N4-04) a name is a migrated SQLite file in this
// test file's IndexSet (worker/test/node/support/with-index.ts
// `fileIndexes()`): vitest evaluates that module once per test file, so each
// file gets its own temporary directory.

import { expect } from 'vitest';
import { SCHEMA_VERSION } from '../../src/do/schema';
import type { SqliteDb } from '../../src/node/sqlite-db';
import { fileIndexes } from '../node/support/with-index';

/** The name both files write under. */
export const SHARED_DO_NAME = 'harness-isolation-shared';
export const T0 = '2026-01-15T12:00:00.000000000Z';

export type ProbeFile = 'isolation' | 'isolation-peer';

const markerDid = (file: ProbeFile) => (file === 'isolation' ? 'did:plc:isomain' : 'did:plc:isopeer');
const otherFile = (file: ProbeFile): ProbeFile => (file === 'isolation' ? 'isolation-peer' : 'isolation');

/** The named database of this test file (created and migrated on first use). */
export const stubFor = (name: string): SqliteDb => fileIndexes().get(name);

/** Users and timers rows of the named database, after asserting its migration is applied. */
export async function rowsUnder(name: string): Promise<{ users: unknown[]; timers: unknown[] }> {
  const db = stubFor(name);
  expect(fileIndexes().migrations(name).at(-1)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
  return {
    users: db.all('SELECT did, joined_at FROM users ORDER BY did'),
    timers: db.all('SELECT name, due_at FROM timers ORDER BY name'),
  };
}

async function writeMarker(name: string, did: string, timer: string): Promise<void> {
  const db = stubFor(name);
  db.tx(() => {
    db.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', did, T0);
    db.run('INSERT INTO timers(name, due_at) VALUES (?, ?)', timer, 1);
  });
}

/**
 * Runs the whole probe for one test file. It must be the first database
 * access in that file: it asserts that the file's storage starts empty.
 */
export async function probeIsolation(file: ProbeFile): Promise<void> {
  const own = markerDid(file);
  const other = markerDid(otherFile(file));
  const nameA = `${file}-a`;
  const nameB = `${file}-b`;
  const foreignNames = [`${otherFile(file)}-a`, `${otherFile(file)}-b`];

  // Nothing the other file created exists in this file's storage.
  expect(fileIndexes().names()).toEqual([]);

  // Under one name: a row written there is visible there ...
  await writeMarker(nameA, own, `${file}:a`);
  expect(await rowsUnder(nameA)).toEqual({
    users: [{ did: own, joined_at: T0 }],
    timers: [{ name: `${file}:a`, due_at: 1 }],
  });
  // ... and absent under another name, which is a separate migrated database.
  expect(await rowsUnder(nameB)).toEqual({ users: [], timers: [] });
  await writeMarker(nameB, `${own}-b`, `${file}:b`);
  expect(await rowsUnder(nameA)).toEqual({
    users: [{ did: own, joined_at: T0 }],
    timers: [{ name: `${file}:a`, due_at: 1 }],
  });
  expect(await rowsUnder(nameB)).toEqual({
    users: [{ did: `${own}-b`, joined_at: T0 }],
    timers: [{ name: `${file}:b`, due_at: 1 }],
  });

  // The shared name holds only this file's marker, never the other file's.
  const shared = await rowsUnder(SHARED_DO_NAME);
  expect(shared).toEqual({ users: [], timers: [] });
  await writeMarker(SHARED_DO_NAME, own, `${file}:shared`);
  const after = await rowsUnder(SHARED_DO_NAME);
  expect(after).toEqual({ users: [{ did: own, joined_at: T0 }], timers: [{ name: `${file}:shared`, due_at: 1 }] });
  expect(JSON.stringify(after)).not.toContain(other);

  // The other file's names are empty, freshly migrated databases here.
  for (const name of foreignNames) expect(await rowsUnder(name)).toEqual({ users: [], timers: [] });

  // Exactly the databases this file touched exist in its storage.
  expect(fileIndexes().names().sort()).toEqual([nameA, nameB, SHARED_DO_NAME, ...foreignNames].sort());
}
