// W3-03: public follow lists and counts over real DO SQLite (harness DO with
// the production migrations), through the HTTP routes and IndexRpc module
// functions (M5.3.2 external_duplicates, public_lists, list_pagination).
//
// Every follow row enters the projection the production way: a record is
// committed to a real signed repository (the shared fixture kit: @atcute/mst,
// deterministic keys), its getRecord CAR is verified by the W2-03 verifier
// (signature, CIDs, MST inclusion or exclusion) and the verified proof is
// applied with W2-04 applyRecordProof inside one db.tx. No CID or revision is
// invented. Expectations are hardcoded from TESTING.md, never computed by the
// code under test.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  createFixtureKit,
  type FixtureKit,
  type FixtureUser,
  FOLLOW_CREATED_AT,
  followRkey,
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
import { parseConfig, parseCursorKey } from '../../src/config';
import { doDb } from '../../src/do/db';
import { followers, following } from '../../src/do/read/follows';
import { profile } from '../../src/do/read/profile';
import { applyRecordProof } from '../../src/do/write/apply-record';
import type { Env } from '../../src/env';
import { routes as followRoutes } from '../../src/http/follows-read';
import { routes as profileRoutes } from '../../src/http/profile';
import type { RequestCtx, RouteDef } from '../../src/http/types';
import type { HarnessDO } from '../harness/harness-do';
import { type LocalIndex, makeLocalIndex } from '../harness/local-index';
import { OPTS, seedUser } from '../write/support';

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
const schemas = {
  FollowPage: openapiValidator('FollowPage'),
  Profile: openapiValidator('Profile'),
  Error: openapiValidator('Error'),
};

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated with AJV against api/openapi.yaml, then compared with toEqual.
type JsonBody = any;

const REQUEST_ID = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b';
const ORIGIN = 'https://music.example.test';
const FOLLOW = 'com.example.atmusic.follow';
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'did:plc:cccccccccccccccccccccccc';
const DAVE = 'did:plc:dddddddddddddddddddddddd';
/** FOLLOW_CREATED_AT (2025-01-01T00:00:00Z) in the 30-character storage form. */
const FOLLOW_TS = '2025-01-01T00:00:00.000000000Z';

let cursorKey: CryptoKey;
beforeAll(async () => {
  cursorKey = await deriveCursorKey(parseCursorKey(env));
});

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name)) as DurableObjectStub<HarnessDO>;

/** A verified getRecord proof for `collection/rkey` at the repository's current head. */
async function verifiedProof(repo: SignedRepo, signingKey: string, collection: string, rkey: string) {
  const head = repo.head;
  if (head === null) throw new Error('repository has no commit');
  const car = await repo.getRecordCar(collection, rkey, { at: head.cid });
  return verifyRecordProof(car, { did: repo.did, collection, rkey, signingKey });
}

async function applyProofs(stub: DurableObjectStub<HarnessDO>, proofs: RecordProof[]): Promise<string[]> {
  return runInDurableObject(stub, (_i: HarnessDO, s: DurableObjectState) => {
    const db = doDb(s.storage);
    return proofs.map((p) => db.tx(() => applyRecordProof(db, p, OPTS)).outcome);
  });
}

interface World {
  kit: FixtureKit;
  stub: DurableObjectStub<HarnessDO>;
  index: LocalIndex;
  ctx: RequestCtx;
  /** Verify and apply `collection/rkey` of a fixture account at its current head. */
  apply(name: FixtureUser, collection: string, rkey: string): Promise<string>;
}

/** The shared fixture, published as signed commits and applied through the verifier. */
async function world(name: string): Promise<World> {
  const kit = await createFixtureKit();
  const seed = await seedReadModels(kit);
  const stub = stubFor(name);
  await runInDurableObject(stub, (_i: HarnessDO, s: DurableObjectState) => {
    const db = doDb(s.storage);
    for (const did of [ALICE, BOB, CAROL]) db.tx(() => seedUser(db, did));
  });
  const proofs: RecordProof[] = [];
  for (const r of seed.records.values()) {
    const user = kit.user(r.did);
    proofs.push(await verifiedProof(kit.repos[user.name], user.key.didKey, r.collection, r.rkey));
  }
  const outcomes = await applyProofs(stub, proofs);
  // 9 present scrobbles + 1 follow applied; r08 proven absent.
  expect(outcomes.filter((o) => o === 'applied')).toHaveLength(10);
  expect(outcomes.filter((o) => o === 'absent')).toHaveLength(1);

  const clock = fixedClock();
  const index = makeLocalIndex(
    { stub, clock, config: parseConfig(env, { allowFixturePrefix: true }) },
    { following, followers, profile },
  );
  const ctx: RequestCtx = {
    env: { ...env } as unknown as Env,
    index,
    requestId: REQUEST_ID,
    clock,
    cursorKey,
    clientIp: '203.0.113.7',
  };
  return {
    kit,
    stub,
    index,
    ctx,
    async apply(user, collection, rkey) {
      const u = kit.users[user];
      const [outcome] = await applyProofs(stub, [await verifiedProof(kit.repos[user], u.key.didKey, collection, rkey)]);
      return outcome as string;
    },
  };
}

function route(list: RouteDef[], pattern: string): RouteDef {
  const found = list.find((r) => r.method === 'GET' && r.pattern === pattern);
  if (found === undefined) throw new Error(`no route GET ${pattern}`);
  return found;
}

async function get(def: RouteDef, ctx: RequestCtx, did: string, query = '') {
  const path = def.pattern.replace('{did}', did);
  const res = await def.handler(new Request(`${ORIGIN}${path}${query}`), ctx, { did });
  return { status: res.status, body: (await res.clone().json()) as JsonBody, res };
}

const followingRoute = route(followRoutes, '/api/v1/users/{did}/following');
const followersRoute = route(followRoutes, '/api/v1/users/{did}/followers');
const profileRoute = route(profileRoutes, '/api/v1/users/{did}/profile');

const uri = (actor: string, rkey: string) => `at://${actor}/${FOLLOW}/${rkey}`;

function followRows(stub: DurableObjectStub<HarnessDO>, subject: string) {
  return runInDurableObject(stub, (_i: HarnessDO, s: DurableObjectState) =>
    doDb(s.storage).all<{ uri: string; actor: string }>(
      'SELECT uri, actor FROM follows WHERE subject = ? ORDER BY uri',
      subject,
    ),
  );
}

async function counts(w: World, did: string) {
  const res = await get(profileRoute, w.ctx, did);
  expect(res.status).toBe(200);
  expect(schemas.Profile(res.body)).toBe('valid');
  return { followers: res.body.followerCount as number, following: res.body.followingCount as number };
}

/** Two external Carol→Bob follow records, the later-written one with the smaller URI. */
async function addCarolDuplicates(w: World): Promise<{ dup1: string; dup2: string }> {
  const followRecord = (createdAt: string) => ({ $type: FOLLOW, subject: BOB, createdAt });
  await w.kit.externalPut('Carol', FOLLOW, 'dup2', followRecord('2025-03-01T00:00:00Z'));
  await w.kit.externalPut('Carol', FOLLOW, 'dup1', followRecord('2025-02-01T00:00:00Z'));
  // Both proofs at Carol's newest head (one rev), as a drain would apply them.
  expect(await w.apply('Carol', FOLLOW, 'dup2')).toBe('applied');
  expect(await w.apply('Carol', FOLLOW, 'dup1')).toBe('applied');
  return { dup1: uri(CAROL, 'dup1'), dup2: uri(CAROL, 'dup2') };
}

it('two active Carol→Bob records count Bob followers 2 not 3; representative is min URI', async () => {
  const w = await world('follows-duplicates');
  const aliceBob = uri(ALICE, await followRkey(BOB));

  // Baseline: the fixture's single Alice→Bob edge.
  expect(await counts(w, BOB)).toEqual({ followers: 1, following: 0 });

  const { dup1, dup2 } = await addCarolDuplicates(w);
  // Three stored records point at Bob …
  expect(await followRows(w.stub, BOB)).toEqual([
    { uri: aliceBob, actor: ALICE },
    { uri: dup1, actor: CAROL },
    { uri: dup2, actor: CAROL },
  ]);
  // … but two distinct actors follow him.
  expect(await counts(w, BOB)).toEqual({ followers: 2, following: 0 });
  expect(await counts(w, CAROL)).toEqual({ followers: 0, following: 1 });

  const bobFollowers = await get(followersRoute, w.ctx, BOB);
  expect(bobFollowers.status).toBe(200);
  expect(schemas.FollowPage(bobFollowers.body)).toBe('valid');
  expect(bobFollowers.res.headers.get('cache-control')).toBe('no-store');
  // One item per edge; Carol's is her smallest URI (dup1) with its own createdAt.
  expect(bobFollowers.body.items).toEqual([
    {
      uri: dup1,
      cid: expect.any(String),
      actor: CAROL,
      subject: BOB,
      createdAt: '2025-02-01T00:00:00.000000000Z',
    },
    { uri: aliceBob, cid: expect.any(String), actor: ALICE, subject: BOB, createdAt: FOLLOW_TS },
  ]);
  expect(bobFollowers.body.nextCursor).toBeNull();
  expect(bobFollowers.body.asOf).toBe('2026-01-15T12:00:00.000000000Z');

  const carolFollowing = await get(followingRoute, w.ctx, CAROL);
  expect(carolFollowing.status).toBe(200);
  expect(schemas.FollowPage(carolFollowing.body)).toBe('valid');
  expect(carolFollowing.body.items.map((f: { uri: string }) => f.uri)).toEqual([dup1]);
  expect(carolFollowing.body.nextCursor).toBeNull();

  // The representative's CID is the verified CID of dup1, not of dup2.
  const cids = await runInDurableObject(w.stub, (_i: HarnessDO, s: DurableObjectState) =>
    doDb(s.storage).all<{ uri: string; cid: string }>(
      'SELECT uri, cid FROM follows WHERE actor = ? ORDER BY uri',
      CAROL,
    ),
  );
  expect(bobFollowers.body.items[0].cid).toBe(cids.find((r) => r.uri === dup1)?.cid);
  expect(cids.find((r) => r.uri === dup1)?.cid).not.toBe(cids.find((r) => r.uri === dup2)?.cid);

  // Exactly one RPC per HTTP read; the lists made no network call.
  expect(w.index.calls.map((c) => c.method)).toEqual(['profile', 'profile', 'profile', 'followers', 'following']);
  expect(w.index.networkAttempts).toEqual([]);
});

it('deleting one duplicate keeps 2; deleting both returns 1', async () => {
  const w = await world('follows-duplicate-deletes');
  const aliceBob = uri(ALICE, await followRkey(BOB));
  const { dup1, dup2 } = await addCarolDuplicates(w);
  expect(await counts(w, BOB)).toEqual({ followers: 2, following: 0 });
  const before = await get(followersRoute, w.ctx, BOB);
  expect(before.body.items.map((f: { uri: string }) => f.uri)).toEqual([dup1, aliceBob]);

  // Delete the representative: a verified exclusion proof removes only that record.
  await w.kit.externalDelete('Carol', FOLLOW, 'dup1');
  expect(await w.apply('Carol', FOLLOW, 'dup1')).toBe('absent');
  expect(await followRows(w.stub, BOB)).toEqual([
    { uri: aliceBob, actor: ALICE },
    { uri: dup2, actor: CAROL },
  ]);
  expect(await counts(w, BOB)).toEqual({ followers: 2, following: 0 });
  const afterOne = await get(followersRoute, w.ctx, BOB);
  expect(afterOne.status).toBe(200);
  expect(schemas.FollowPage(afterOne.body)).toBe('valid');
  // The surviving duplicate is now the representative, with its own createdAt.
  expect(afterOne.body.items.map((f: { uri: string; createdAt: string }) => [f.uri, f.createdAt])).toEqual([
    [dup2, '2025-03-01T00:00:00.000000000Z'],
    [aliceBob, FOLLOW_TS],
  ]);
  const state = await runInDurableObject(w.stub, (_i: HarnessDO, s: DurableObjectState) =>
    doDb(s.storage).one<{ state: string }>('SELECT state FROM record_state WHERE uri = ?', dup1),
  );
  expect(state).toEqual({ state: 'absent' });

  // Delete the other: the Carol→Bob edge is gone, Alice→Bob remains.
  await w.kit.externalDelete('Carol', FOLLOW, 'dup2');
  expect(await w.apply('Carol', FOLLOW, 'dup2')).toBe('absent');
  expect(await followRows(w.stub, BOB)).toEqual([{ uri: aliceBob, actor: ALICE }]);
  expect(await counts(w, BOB)).toEqual({ followers: 1, following: 0 });
  expect(await counts(w, CAROL)).toEqual({ followers: 0, following: 0 });
  const afterBoth = await get(followersRoute, w.ctx, BOB);
  expect(afterBoth.body.items.map((f: { uri: string }) => f.uri)).toEqual([aliceBob]);
  const carolFollowing = await get(followingRoute, w.ctx, CAROL);
  expect(carolFollowing.status).toBe(200);
  expect(schemas.FollowPage(carolFollowing.body)).toBe('valid');
  expect(carolFollowing.body.items).toEqual([]);
  expect(carolFollowing.body.nextCursor).toBeNull();
});

it('three edges with equal createdAt traverse completely at limit 1; tampered cursor → 400 invalid_cursor', async () => {
  const w = await world('follows-pagination');
  // A fourth active account (a follow subject only).
  await runInDurableObject(w.stub, (_i: HarnessDO, s: DurableObjectState) => {
    const db = doDb(s.storage);
    db.tx(() => seedUser(db, DAVE));
  });
  // Alice also follows Carol and Dave, all three at the same createdAt.
  for (const subject of [CAROL, DAVE]) {
    await w.kit.externalPut('Alice', FOLLOW, await followRkey(subject), {
      $type: FOLLOW,
      subject,
      createdAt: FOLLOW_CREATED_AT,
    });
  }
  for (const subject of [CAROL, DAVE]) {
    expect(await w.apply('Alice', FOLLOW, await followRkey(subject))).toBe('applied');
  }
  const expected = [
    uri(ALICE, await followRkey(BOB)),
    uri(ALICE, await followRkey(CAROL)),
    uri(ALICE, await followRkey(DAVE)),
  ].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // equal createdAt: full URI DESC

  const pages: string[][] = [];
  const cursors: Array<string | null> = [];
  let cursor: string | null = null;
  do {
    const query: string = `?limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page = await get(followingRoute, w.ctx, ALICE, query);
    expect(page.status).toBe(200);
    expect(schemas.FollowPage(page.body)).toBe('valid');
    // asOf is frozen by the first page even though the clock moves.
    expect(page.body.asOf).toBe('2026-01-15T12:00:00.000000000Z');
    for (const item of page.body.items) expect(item.createdAt).toBe(FOLLOW_TS);
    pages.push(page.body.items.map((f: { uri: string }) => f.uri));
    cursor = page.body.nextCursor;
    cursors.push(cursor);
    (w.ctx.clock as ReturnType<typeof fixedClock>).advance(60_000);
  } while (cursor !== null && pages.length < 10);

  expect(pages).toEqual([[expected[0]], [expected[1]], [expected[2]]]);
  expect(pages.flat()).toEqual(expected);
  expect(new Set(pages.flat()).size).toBe(3);
  expect(cursors[2]).toBeNull();
  expect(w.index.calls.map((c) => c.method)).toEqual(['following', 'following', 'following']);

  // One flipped bit in the payload: 400 invalid_cursor, and the DO is never asked.
  const token = cursors[0] as string;
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const at = 10;
  const flipped = B64[B64.indexOf(token[at] as string) ^ 1] as string;
  const tampered = `${token.slice(0, at)}${flipped}${token.slice(at + 1)}`;
  expect(tampered).not.toBe(token);
  const callsBefore = w.index.calls.length;
  const bad = await get(followingRoute, w.ctx, ALICE, `?limit=1&cursor=${encodeURIComponent(tampered)}`);
  expect(bad.status).toBe(400);
  expect(schemas.Error(bad.body)).toBe('valid');
  expect(bad.body).toEqual({
    error: {
      code: 'invalid_cursor',
      message: 'The pagination cursor is invalid for this request.',
      requestId: REQUEST_ID,
    },
  });
  expect(bad.res.headers.get('cache-control')).toBe('no-store');

  // A valid token bound to `following` of Alice is refused for followers, or for another DID.
  const wrongList = await get(followersRoute, w.ctx, ALICE, `?limit=1&cursor=${encodeURIComponent(token)}`);
  expect(wrongList.status).toBe(400);
  expect(wrongList.body.error.code).toBe('invalid_cursor');
  const wrongDid = await get(followingRoute, w.ctx, BOB, `?limit=1&cursor=${encodeURIComponent(token)}`);
  expect(wrongDid.status).toBe(400);
  expect(wrongDid.body.error.code).toBe('invalid_cursor');
  // Bad base64 too.
  const garbage = await get(followingRoute, w.ctx, ALICE, '?cursor=%%%');
  expect(garbage.status).toBe(400);
  expect(garbage.body.error.code).toBe('invalid_cursor');
  expect(w.index.calls.length).toBe(callsBefore);

  // Limit is validated, never clamped.
  for (const limit of ['0', '101', '-1', '1.5', '']) {
    const res = await get(followingRoute, w.ctx, ALICE, `?limit=${limit}`);
    expect(res.status).toBe(422);
    expect(schemas.Error(res.body)).toBe('valid');
    expect(res.body.error.fields).toEqual({ limit: 'Expected an integer between 1 and 100.' });
  }
  // A malformed path DID is 422 `fields.did`.
  const badDid = await get(followingRoute, w.ctx, 'alice.test');
  expect(badDid.status).toBe(422);
  expect(badDid.body.error.fields).toEqual({ did: 'Expected a DID.' });
  expect(w.index.calls.length).toBe(callsBefore);
});
