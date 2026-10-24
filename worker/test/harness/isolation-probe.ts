// Shared probe for the harness isolation tests (M1.4.3/harness_isolation, A18:
// isolated workerd storage per test file and a unique DO name per test replace
// the port-0 harness). isolation.test.ts and isolation-peer.test.ts both run
// it: each writes a marker of its own under the same shared DO name and checks
// that the other file's marker, and every DO the other file created, is absent.
// Storage shared between the two files would make whichever runs second fail.

import { listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { doDb } from '../../src/do/db';
import type { HarnessDO } from './harness-do';

/** The DO name both files write under. */
export const SHARED_DO_NAME = 'harness-isolation-shared';
export const T0 = '2026-01-15T12:00:00.000000000Z';

export type ProbeFile = 'isolation' | 'isolation-peer';

const markerDid = (file: ProbeFile) => (file === 'isolation' ? 'did:plc:isomain' : 'did:plc:isopeer');
const otherFile = (file: ProbeFile): ProbeFile => (file === 'isolation' ? 'isolation-peer' : 'isolation');

export const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

/** Users and timers rows of the named DO, after asserting its migration is applied. */
export async function rowsUnder(name: string): Promise<{ users: unknown[]; timers: unknown[] }> {
  return runInDurableObject(stubFor(name), (instance: HarnessDO, state) => {
    expect(instance.migration).toEqual({ status: 'ready', version: 1 });
    const db = doDb(state.storage);
    return {
      users: db.all('SELECT did, joined_at FROM users ORDER BY did'),
      timers: db.all('SELECT name, due_at FROM timers ORDER BY name'),
    };
  });
}

async function writeMarker(name: string, did: string, timer: string): Promise<void> {
  await runInDurableObject(stubFor(name), (_instance: HarnessDO, state) => {
    const db = doDb(state.storage);
    db.tx(() => {
      db.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', did, T0);
      db.run('INSERT INTO timers(name, due_at) VALUES (?, ?)', timer, 1);
    });
  });
}

/**
 * Runs the whole probe for one test file. It must be the first DO access in
 * that file: it asserts that the file's storage starts with no Durable Object.
 */
export async function probeIsolation(file: ProbeFile): Promise<void> {
  const own = markerDid(file);
  const other = markerDid(otherFile(file));
  const nameA = `${file}-a`;
  const nameB = `${file}-b`;
  const foreignNames = [`${otherFile(file)}-a`, `${otherFile(file)}-b`];

  // Nothing the other file created exists in this file's storage.
  expect(await listDurableObjectIds(env.HARNESS)).toEqual([]);

  // Under one DO name: a row written there is visible there ...
  await writeMarker(nameA, own, `${file}:a`);
  expect(await rowsUnder(nameA)).toEqual({
    users: [{ did: own, joined_at: T0 }],
    timers: [{ name: `${file}:a`, due_at: 1 }],
  });
  // ... and absent under another DO name, which is a separate migrated database.
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

  // The shared DO name holds only this file's marker, never the other file's.
  const shared = await rowsUnder(SHARED_DO_NAME);
  expect(shared).toEqual({ users: [], timers: [] });
  await writeMarker(SHARED_DO_NAME, own, `${file}:shared`);
  const after = await rowsUnder(SHARED_DO_NAME);
  expect(after).toEqual({ users: [{ did: own, joined_at: T0 }], timers: [{ name: `${file}:shared`, due_at: 1 }] });
  expect(JSON.stringify(after)).not.toContain(other);

  // The other file's DO names are empty, freshly migrated databases here.
  for (const name of foreignNames) expect(await rowsUnder(name)).toEqual({ users: [], timers: [] });

  // Exactly the DOs this file touched exist in its storage.
  const ids = (await listDurableObjectIds(env.HARNESS)).map((id) => id.toString()).sort();
  const expected = [nameA, nameB, SHARED_DO_NAME, ...foreignNames]
    .map((name) => env.HARNESS.idFromName(name).toString())
    .sort();
  expect(ids).toEqual(expected);
}
