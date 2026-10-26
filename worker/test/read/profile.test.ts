// W3-03: GET /api/v1/users/{did}/profile over node:sqlite (a temporary-file database with
// the production migrations) and the real identity resolver on the fixture
// network (M5.2.1 profile_fields / unverified_alias, M5.2.2 unknown_empty,
// M5.3.2 public_lists).
//
// Records enter the projection the production way: committed to real signed
// repositories (shared fixture kit), their getRecord CARs verified by the
// W2-03 verifier, then applied with W2-04 applyRecordProof in one db.tx. The
// handle comes from the production IdentityResolver (PLC document → DoH TXT →
// the same DID) over the fixture transport. Expectations are hardcoded from
// TESTING.md and docs/profiles.md.

import { createIdentityResolver } from '@atmusic/atproto/identity/resolver';
import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import {
  createFixtureKit,
  type FixtureKit,
  type FixtureUser,
  seedReadModels,
} from '@atmusic/atproto/test-support/read-models';
import type { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import type { RecordProof } from '@atmusic/atproto/verify/types';
import { deriveCursorKey } from '@atmusic/core/cursor';
import { fixedClock } from '@atmusic/core/test-support/clock';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { beforeAll, expect, it } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import { type AppConfig, parseConfig, parseCursorKey } from '../../src/config';
import type { Db } from '../../src/do/db';
import { exportUser } from '../../src/do/read/export';
import { profile } from '../../src/do/read/profile';
import { markConnected, recordEvent, updateCheckpointBookkeeping } from '../../src/do/status';
import { markInactive } from '../../src/do/write/account-state';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { routes as profileRoutes } from '../../src/http/profile';
import type { RequestCtx, RouteDef } from '../../src/http/types';
import { OPTS, seedUser } from '../write/support';
import { HARNESS_ENV, inTestDb, type LocalIndex, makeDbIndex, openTestDb, type TestDb } from './node-harness';

// ---------------------------------------------------------------------------
// Shared setup

function openapiValidator(schema: string) {
  const doc = JSON.parse(openapiText) as { components: unknown };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
  ajv.addSchema({ $id: 'openapi', components: doc.components });
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`);
  if (validate === undefined) throw new Error(`no schema ${schema}`);
  return (value: unknown) => ((validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors));
}
const schemas = { Profile: openapiValidator('Profile'), Error: openapiValidator('Error') };

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated with AJV against api/openapi.yaml, then compared with toEqual.
type JsonBody = any;

const REQUEST_ID = '2d7e4c1a-9b3f-4a5e-8c6d-7e8f9a0b1c2d';
const ORIGIN = 'https://music.example.test';
const SETTINGS = 'com.example.atmusic.settings';
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'did:plc:cccccccccccccccccccccccc';
const UNKNOWN = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz';
const NOW_MS = Date.parse('2026-01-15T12:00:00Z');
/** The frozen instant in the stored/DTO 30-character form. */
const NOW = '2026-01-15T12:00:00.000000000Z';
const CURRENT = { state: 'current', caughtUp: true, lastIndexedAt: NOW, lagSeconds: 0 };
const NOT_FOUND = {
  error: { code: 'not_found', message: 'The resource is absent or inactive.', requestId: REQUEST_ID },
};

let cursorKey: CryptoKey;
beforeAll(async () => {
  cursorKey = await deriveCursorKey(parseCursorKey(HARNESS_ENV));
});

/** Socket ingest mode: with a connected, caught-up checkpoint the global truth is `current`. */
const SOCKET_CONFIG: AppConfig = parseConfig({ ...HARNESS_ENV, INGEST_MODE: 'socket' }, { allowFixturePrefix: true });

function inDo<T>(store: TestDb, fn: (db: Db) => T): Promise<T> {
  return inTestDb(store, (db) => fn(db));
}

async function verifiedProof(repo: SignedRepo, signingKey: string, collection: string, rkey: string) {
  const head = repo.head;
  if (head === null) throw new Error('repository has no commit');
  const car = await repo.getRecordCar(collection, rkey, { at: head.cid });
  return verifyRecordProof(car, { did: repo.did, collection, rkey, signingKey });
}

/** An IdentityResolver that counts every call before delegating. */
function countingResolver(inner: IdentityResolver) {
  const calls: string[] = [];
  const resolver: IdentityResolver = {
    resolveDid(did, o) {
      calls.push(`resolveDid ${did}`);
      return inner.resolveDid(did, o);
    },
    resolveHandle(handle) {
      calls.push(`resolveHandle ${handle}`);
      return inner.resolveHandle(handle);
    },
  };
  return { resolver, calls };
}

interface World {
  kit: FixtureKit;
  store: TestDb;
  index: LocalIndex;
  ctx: RequestCtx;
  identityCalls: string[];
  apply(name: FixtureUser, collection: string, rkey: string): Promise<void>;
}

/**
 * A database with a connected, caught-up ingest checkpoint and the given
 * accounts known and active. `seed` publishes and applies the shared fixture.
 */
async function world(o: { users: string[]; seed: boolean }): Promise<World> {
  const kit = await createFixtureKit();
  const seed = o.seed ? await seedReadModels(kit) : null;
  const store = await openTestDb();
  await inDo(store, (db) =>
    db.tx(() => {
      markConnected(db, NOW_MS);
      recordEvent(db, { cursor: 1, timeUs: NOW_MS * 1000 });
      updateCheckpointBookkeeping(db, { pendingGap: false });
      for (const did of o.users) seedUser(db, did);
    }),
  );
  const applyProofs = (proofs: RecordProof[]) =>
    inDo(store, (db) => proofs.map((p) => db.tx(() => applyRecordProof(db, p, OPTS)).outcome));
  if (seed !== null) {
    const proofs: RecordProof[] = [];
    for (const r of seed.records.values()) {
      const u = kit.user(r.did);
      proofs.push(await verifiedProof(kit.repos[u.name], u.key.didKey, r.collection, r.rkey));
    }
    const outcomes = await applyProofs(proofs);
    expect(outcomes.filter((x) => x === 'applied')).toHaveLength(10);
    expect(outcomes.filter((x) => x === 'absent')).toHaveLength(1);
  }
  kit.resetCalls();

  const clock = fixedClock();
  const identity = countingResolver(createIdentityResolver({ transport: kit.transport, clock }));
  const index = makeDbIndex(
    { db: store, clock, identity: identity.resolver, transport: kit.transport, config: SOCKET_CONFIG },
    { profile, exportUser },
  );
  const ctx: RequestCtx = {
    env: { ...HARNESS_ENV },
    index,
    requestId: REQUEST_ID,
    clock,
    cursorKey,
    clientIp: '203.0.113.7',
  };
  return {
    kit,
    store,
    index,
    ctx,
    identityCalls: identity.calls,
    async apply(user, collection, rkey) {
      const u = kit.users[user];
      await applyProofs([await verifiedProof(kit.repos[user], u.key.didKey, collection, rkey)]);
    },
  };
}

const profileRoute: RouteDef = (() => {
  const found = profileRoutes.find((r) => r.method === 'GET' && r.pattern === '/api/v1/users/{did}/profile');
  if (found === undefined) throw new Error('no profile route');
  return found;
})();

async function getProfile(ctx: RequestCtx, did: string) {
  const res = await profileRoute.handler(new Request(`${ORIGIN}/api/v1/users/${did}/profile`), ctx, { did });
  return { status: res.status, body: (await res.clone().json()) as JsonBody, res };
}

it('Alice followers 0 following 1; Bob followers 1 following 0; Carol 0/0', async () => {
  const w = await world({ users: [ALICE, BOB, CAROL], seed: true });

  const alice = await getProfile(w.ctx, ALICE);
  expect(alice.status).toBe(200);
  expect(schemas.Profile(alice.body)).toBe('valid');
  expect(alice.res.headers.get('cache-control')).toBe('no-store');
  expect(alice.res.headers.get('content-type')).toBe('application/json');
  // Exactly the eight documented fields, in the Rust order; r08 (deleted) is not counted.
  expect(Object.keys(alice.body)).toEqual([
    'did',
    'handle',
    'joinedAt',
    'indexedAt',
    'totalScrobbles',
    'followerCount',
    'followingCount',
    'indexing',
  ]);
  expect(alice.body).toEqual({
    did: ALICE,
    handle: 'alice.test',
    joinedAt: NOW,
    indexedAt: NOW,
    totalScrobbles: 7,
    followerCount: 0,
    followingCount: 1,
    indexing: CURRENT,
  });

  const bob = await getProfile(w.ctx, BOB);
  expect(bob.status).toBe(200);
  expect(schemas.Profile(bob.body)).toBe('valid');
  expect(bob.body).toEqual({
    did: BOB,
    handle: 'bob.test',
    joinedAt: NOW,
    indexedAt: NOW,
    totalScrobbles: 1,
    followerCount: 1,
    followingCount: 0,
    indexing: CURRENT,
  });

  const carol = await getProfile(w.ctx, CAROL);
  expect(carol.status).toBe(200);
  expect(schemas.Profile(carol.body)).toBe('valid');
  expect(carol.body).toEqual({
    did: CAROL,
    handle: 'carol.test',
    joinedAt: NOW,
    indexedAt: NOW,
    totalScrobbles: 1,
    followerCount: 0,
    followingCount: 0,
    indexing: CURRENT,
  });

  // Every timestamp is RFC 3339 UTC.
  for (const p of [alice.body, bob.body, carol.body]) {
    for (const t of [p.joinedAt, p.indexedAt, p.indexing.lastIndexedAt]) {
      expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/);
    }
  }
  // One RPC and one identity resolution per profile; the handles were verified over the network.
  expect(w.index.calls.map((c) => [c.method, c.args])).toEqual([
    ['profile', [ALICE]],
    ['profile', [BOB]],
    ['profile', [CAROL]],
  ]);
  expect(w.identityCalls).toEqual([`resolveDid ${ALICE}`, `resolveDid ${BOB}`, `resolveDid ${CAROL}`]);
  for (const did of [ALICE, BOB, CAROL]) expect(w.kit.plc.count(did)).toBe(1);
  expect(w.kit.doh.count('_atproto.alice.test', 'TXT')).toBe(1);
  // The read wrote nothing: the users rows are as seeded (no handle stored).
  expect(await inDo(w.store, (db) => db.all('SELECT did, handle, active FROM users ORDER BY did'))).toEqual([
    { did: ALICE, handle: null, active: 1 },
    { did: BOB, handle: null, active: 1 },
    { did: CAROL, handle: null, active: 1 },
  ]);
});

it('unknown/inactive DID → 404 with zero identity transport calls', async () => {
  const w = await world({ users: [ALICE, BOB, CAROL], seed: true });
  // Alice is deactivated (what the status sweep applies); Carol opts out with a signed settings record.
  await inDo(w.store, (db) => db.tx(() => markInactive(db, ALICE, 'deactivated')));
  await w.kit.externalPut('Carol', SETTINGS, 'self', {
    $type: SETTINGS,
    indexing: 'disabled',
    createdAt: '2026-01-15T11:00:00Z',
  });
  await w.apply('Carol', SETTINGS, 'self');
  expect(await inDo(w.store, (db) => db.all('SELECT did FROM suppression'))).toEqual([{ did: CAROL }]);
  w.kit.resetCalls();

  for (const did of [UNKNOWN, ALICE, CAROL]) {
    const res = await getProfile(w.ctx, did);
    expect(res.status).toBe(404);
    expect(schemas.Error(res.body)).toBe('valid');
    expect(res.body).toEqual(NOT_FOUND);
    expect(res.res.headers.get('cache-control')).toBe('no-store');
  }
  // The DO decided before any identity request: no resolver call, no network call at all.
  expect(w.index.calls.map((c) => c.args[0])).toEqual([UNKNOWN, ALICE, CAROL]);
  expect(w.identityCalls).toEqual([]);
  expect(w.kit.transport.calls.entries).toEqual([]);
  expect(w.index.networkAttempts).toEqual([]);

  // Bob is still visible, and his follower edge from the now hidden Alice no longer counts.
  const bob = await getProfile(w.ctx, BOB);
  expect(bob.status).toBe(200);
  expect(bob.body.followerCount).toBe(0);
  expect(bob.body.totalScrobbles).toBe(1);

  // A malformed DID never reaches the DO.
  const before = w.index.calls.length;
  const bad = await getProfile(w.ctx, 'alice.test');
  expect(bad.status).toBe(422);
  expect(schemas.Error(bad.body)).toBe('valid');
  expect(bad.body.error).toEqual({
    code: 'validation_failed',
    message: 'A request field is invalid.',
    requestId: REQUEST_ID,
    fields: { did: 'Expected a DID.' },
  });
  expect(w.index.calls.length).toBe(before);
});

it('Cache-Control no-store and handle null when unverified', async () => {
  const w = await world({ users: [ALICE, BOB, CAROL], seed: true });
  // A stored alias is not evidence: even with users.handle set, verification decides.
  await inDo(w.store, (db) => db.run("UPDATE users SET handle = 'alice.test' WHERE did = ?", ALICE));
  // alice.test now points at Bob's DID: Alice's document claim no longer verifies.
  w.kit.doh.setTxt('_atproto.alice.test', [`did=${BOB}`]);

  const unverified = await getProfile(w.ctx, ALICE);
  expect(unverified.status).toBe(200);
  expect(schemas.Profile(unverified.body)).toBe('valid');
  expect(unverified.res.headers.get('cache-control')).toBe('no-store');
  expect(unverified.body).toEqual({
    did: ALICE,
    handle: null,
    joinedAt: NOW,
    indexedAt: NOW,
    totalScrobbles: 7,
    followerCount: 0,
    followingCount: 1,
    indexing: CURRENT,
  });
  // The resolver did ask: PLC document, then the TXT lookup that disagreed.
  expect(w.kit.plc.count(ALICE)).toBe(1);
  expect(w.kit.doh.count('_atproto.alice.test', 'TXT')).toBe(1);

  // An unavailable identity upstream also yields handle null, never an error or hidden data.
  w.kit.plc.fail({ did: BOB }, { kind: 'status', status: 500, error: 'InternalServerError' }, Infinity);
  const unavailable = await getProfile(w.ctx, BOB);
  expect(unavailable.status).toBe(200);
  expect(schemas.Profile(unavailable.body)).toBe('valid');
  expect(unavailable.res.headers.get('cache-control')).toBe('no-store');
  expect(unavailable.body.handle).toBeNull();
  expect(unavailable.body.totalScrobbles).toBe(1);
  expect(unavailable.body.followerCount).toBe(1);

  // Restored identity: the next read verifies again (no response caching).
  w.kit.doh.setTxt('_atproto.alice.test', [`did=${ALICE}`]);
  const verified = await getProfile(w.ctx, ALICE);
  expect(verified.status).toBe(200);
  expect(verified.body.handle).toBe('alice.test');
  expect(w.identityCalls).toEqual([`resolveDid ${ALICE}`, `resolveDid ${BOB}`, `resolveDid ${ALICE}`]);
});

it('known recordless user → 200 with zero totals and empty history', async () => {
  // Only Bob is known; his repository has no music records.
  const w = await world({ users: [BOB], seed: false });

  const unknown = await getProfile(w.ctx, ALICE);
  expect(unknown.status).toBe(404);
  expect(unknown.body).toEqual(NOT_FOUND);
  expect(w.identityCalls).toEqual([]);

  // While a snapshot of Bob is still running his indexing is unfinished.
  await inDo(w.store, (db) =>
    db.run(
      `INSERT INTO repo_jobs(did, kind, state, generation, due_at, updated_at_ms)
       VALUES (?, 'snapshot', 'running', 1, ?, ?)`,
      BOB,
      NOW_MS,
      NOW_MS,
    ),
  );
  const running = await getProfile(w.ctx, BOB);
  expect(running.status).toBe(200);
  expect(schemas.Profile(running.body)).toBe('valid');
  expect(running.body).toEqual({
    did: BOB,
    handle: 'bob.test',
    joinedAt: NOW,
    indexedAt: null,
    totalScrobbles: 0,
    followerCount: 0,
    followingCount: 0,
    indexing: { state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: 0 },
  });

  await inDo(w.store, (db) => db.run("UPDATE repo_jobs SET state = 'complete' WHERE did = ?", BOB));
  const done = await getProfile(w.ctx, BOB);
  expect(done.status).toBe(200);
  expect(done.body.totalScrobbles).toBe(0);
  expect(done.body.indexing).toEqual({ state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: 0 });

  // Empty history: no stored rows, and the public record read returns none.
  expect(await inDo(w.store, (db) => db.all('SELECT uri FROM scrobbles WHERE did = ?', BOB))).toEqual([]);
  const records = await w.index.exportUser(BOB);
  expect(records?.scrobbles).toEqual([]);
  expect(records?.follows).toEqual([]);
});
