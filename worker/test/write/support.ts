// Shared setup for the projection-apply suites (W2-04). TEST-ONLY.
//
// Every CID and revision comes from a real signed repository
// (@atmusic/atproto/test-support/signed-repo: @atcute/mst trees, dag-cbor
// records, deterministic fixture keys). A RecordProof is built from the
// repository's head and its MST lookup, the same values the W2-03 verifier
// returns after checking that CAR; nothing here invents a CID or a rev.
//
// Node (ADR 0005 §15.1, N4-04): this module no longer imports
// `cloudflare:workers`. Its exported API is unchanged: `stubFor(name)` still
// returns the harness Durable Object stub of the `cloudflare:*` test shim
// (the very module that id resolves to in worker-modules), for the suites
// that N4-05 and N4-06 de-shim; the de-shimmed suites use
// worker/test/node/support/with-index.ts. The shim is loaded only where it
// can run (Node); a host without it (the workerd composition project, which
// never calls stubFor) gets a stubFor that throws.

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import type { RecordProof } from '@atmusic/atproto/verify/types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { Db } from '../../src/do/db';
import type { ApplyOptions } from '../../src/do/write/apply-record';

export const PREFIX = 'com.example.atmusic';
export const SCROBBLE = `${PREFIX}.scrobble`;
export const FOLLOW = `${PREFIX}.follow`;
export const SETTINGS = `${PREFIX}.settings`;

export const ALICE = fixture.users.Alice.did;
export const BOB = fixture.users.Bob.did;
export const CAROL = fixture.users.Carol.did;

/** The frozen test instant, 2026-01-15T12:00:00Z. */
export const NOW_MS = Date.parse('2026-01-15T12:00:00Z');
export const NOW_NS = fromMs(NOW_MS);
export const NOW_STORAGE = toStorage(NOW_NS);
export const OPTS: ApplyOptions = { receiptNs: NOW_NS, prefix: PREFIX, nowNs: NOW_NS };

type ShimEnv = typeof import('../node/support/cloudflare-workers-shim')['env'];

/** The shim's harness env on Node; null on a host where the shim cannot load (workerd). */
const shimEnv: ShimEnv | null = await (async () => {
  if ((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === 'Cloudflare-Workers') return null;
  try {
    return (await import('../node/support/cloudflare-workers-shim')).env;
  } catch {
    return null;
  }
})();

export const stubFor = (name: string) => {
  if (shimEnv === null) throw new Error('stubFor needs the cloudflare:* test shim (the worker-modules project)');
  return shimEnv.HARNESS.get(shimEnv.HARNESS.idFromName(name));
};

type Name = 'alice' | 'bob' | 'carol';
const DIDS: Record<Name, string> = { alice: ALICE, bob: BOB, carol: CAROL };

/** A fresh signed repository for a fixture account, revs from the frozen clock. */
export async function repoFor(name: Name): Promise<SignedRepo> {
  const keys = await fixtureKeys();
  return new SignedRepo(DIDS[name], keys[name], { clock: fixedClock() });
}

/** The proof of `collection/rkey` at the repository's current head (present or proven absent). */
export async function proofAt(repo: SignedRepo, collection: string, rkey: string): Promise<RecordProof> {
  const head = repo.head;
  if (head === null) throw new Error('repository has no commit');
  const commit = { did: repo.did, cid: head.cid, rev: head.rev, dataCid: head.data, version: 3 as const };
  const found = await repo.getRecord(collection, rkey);
  return found === null
    ? { commit, collection, rkey, state: 'absent' }
    : { commit, collection, rkey, state: 'present', cid: found.cid, record: found.value };
}

/** Put a record (one signed commit) and return its proof at the new head. */
export async function putProof(repo: SignedRepo, collection: string, rkey: string, record: unknown) {
  await repo.put(collection, rkey, record);
  return proofAt(repo, collection, rkey);
}

/** Delete a record (one signed commit) and return its exclusion proof at the new head. */
export async function deleteProof(repo: SignedRepo, collection: string, rkey: string) {
  await repo.delete(collection, rkey);
  return proofAt(repo, collection, rkey);
}

/** A fixture scrobble record by rkey (tests/fixtures/read_models.json). */
export function fixtureScrobble(rkey: string): Record<string, unknown> {
  const s = fixture.scrobbles.find((x) => x.rkey === rkey);
  if (!s) throw new Error(`no fixture scrobble ${rkey}`);
  return { ...s.record };
}

export function scrobble(fields: Record<string, unknown>): Record<string, unknown> {
  return { $type: SCROBBLE, createdAt: '2026-01-15T11:00:00Z', listenedAt: '2026-01-15T11:00:00Z', ...fields };
}

export function follow(subject: string): Record<string, unknown> {
  return { $type: FOLLOW, subject, createdAt: '2025-01-01T00:00:00Z' };
}

export function settings(indexing: 'enabled' | 'disabled'): Record<string, unknown> {
  return { $type: SETTINGS, indexing, createdAt: '2026-01-15T11:00:00Z' };
}

/**
 * Test setup only: a known account row (what admission plus a completed
 * snapshot leave behind), with a generation from the global allocator.
 */
export function seedUser(db: Db, did: string, o: { active?: boolean } = {}): number {
  const row = db.one<{ last_generation: number }>(
    'UPDATE backfill_generation SET last_generation = last_generation + 1 WHERE singleton = 1 RETURNING last_generation',
  )!;
  const active = o.active ?? true;
  db.run(
    `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, ?, ?, ?, ?)`,
    did,
    NOW_STORAGE,
    active ? 1 : 0,
    active ? 'active' : 'unknown',
    active ? 'current' : 'recovering',
    row.last_generation,
  );
  return row.last_generation;
}

/**
 * Test setup only: the `repo_jobs(did,'snapshot')` row W4-01 holds while a
 * snapshot runs (running, at `generation`, head not yet recorded).
 */
export function seedSnapshotJob(db: Db, did: string, generation: number, o: { reactivate?: boolean } = {}): void {
  db.run(
    `INSERT INTO repo_jobs(did, kind, state, generation, reactivate, due_at, updated_at_ms)
     VALUES (?, 'snapshot', 'running', ?, ?, ?, ?)`,
    did,
    generation,
    o.reactivate ? 1 : 0,
    NOW_MS,
    NOW_MS,
  );
}

export const PROJECTION_TABLES = [
  'users',
  'scrobbles',
  'follows',
  'record_state',
  'suppression',
  'counters',
  'repo_jobs',
  'hints',
  'stats_cache',
  'indexing_status',
  'backfill_generation',
] as const;

/** Every row of the projection tables in a stable order, for byte-identical comparisons. */
export function dump(db: Db): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of PROJECTION_TABLES) out[t] = db.all(`SELECT * FROM ${t} ORDER BY 1, 2`);
  return out;
}

export function userRow(db: Db, did: string) {
  return db.one<{
    active: number;
    account_status: string;
    max_rev: string | null;
    indexing_state: string;
    generation: number;
    stats_version: number;
    last_snapshot_at_ms: number | null;
  }>(
    'SELECT active, account_status, max_rev, indexing_state, generation, stats_version, last_snapshot_at_ms FROM users WHERE did = ?',
    did,
  );
}

export function recordState(db: Db, uri: string) {
  return db.one<{ revision: string; cid: string | null; state: string; reason: string | null; collection: string }>(
    'SELECT revision, cid, state, reason, collection FROM record_state WHERE uri = ?',
    uri,
  );
}

export const uriOf = (did: string, collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;
