// W3-03: GET /api/v1/users/{did}/export over real DO SQLite (harness DO with
// the production migrations) (A9, N3; M6.3.2 export_owner and
// export_secret_scan, M7.2.3 export_download).
//
// The shared fixture is published as real signed commits; every record is
// verified by the W2-03 verifier and applied with W2-04 applyRecordProof. On
// top of it the test plants records and rows that must never reach an export:
// an excluded (invalid) record, an edge to an unknown account, another
// owner's records, and marker strings in every non-projection table.
// Expectations are hardcoded from TESTING.md.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  createFixtureKit,
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
import { type Db, doDb } from '../../src/do/db';
import { exportUser } from '../../src/do/read/export';
import { markConnected, recordEvent, updateCheckpointBookkeeping } from '../../src/do/status';
import { markInactive } from '../../src/do/write/account-state';
import { applyRecordProof } from '../../src/do/write/apply-record';
import type { Env } from '../../src/env';
import { routes as exportRoutes } from '../../src/http/export';
import type { RequestCtx } from '../../src/http/types';
import type { HarnessDO } from '../harness/harness-do';
import { makeLocalIndex } from '../harness/local-index';
import { OPTS, seedUser } from '../write/support';

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
const schemas = { Export: openapiValidator('Export'), Error: openapiValidator('Error') };

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated with AJV against api/openapi.yaml, then compared with toEqual.
type JsonBody = any;

const REQUEST_ID = '4c3b2a19-0f8e-4d7c-ab6a-5f4e3d2c1b0a';
const ORIGIN = 'https://music.example.test';
const SCROBBLE = 'com.example.atmusic.scrobble';
const FOLLOW = 'com.example.atmusic.follow';
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'did:plc:cccccccccccccccccccccccc';
/** A syntactically valid DID that is not a known account. */
const DAVE = 'did:plc:dddddddddddddddddddddddd';
const NOW_MS = Date.parse('2026-01-15T12:00:00Z');
const NOW = '2026-01-15T12:00:00.000000000Z';
const MARKER = 'SECRET-MARKER';
const DISPOSITION = 'attachment; filename="music-export.json"';

let cursorKey: CryptoKey;
beforeAll(async () => {
  cursorKey = await deriveCursorKey(parseCursorKey(env));
});

function inDo<T>(stub: DurableObjectStub<HarnessDO>, fn: (db: Db) => T): Promise<T> {
  return runInDurableObject(stub, (_i: HarnessDO, s: DurableObjectState) => fn(doDb(s.storage)));
}

async function verifiedProof(repo: SignedRepo, signingKey: string, collection: string, rkey: string) {
  const head = repo.head;
  if (head === null) throw new Error('repository has no commit');
  const car = await repo.getRecordCar(collection, rkey, { at: head.cid });
  return verifyRecordProof(car, { did: repo.did, collection, rkey, signingKey });
}

const exportRoute = (() => {
  const found = exportRoutes.find((r) => r.method === 'GET' && r.pattern === '/api/v1/users/{did}/export');
  if (found === undefined) throw new Error('no export route');
  return found;
})();

async function getExport(ctx: RequestCtx, did: string) {
  const res = await exportRoute.handler(new Request(`${ORIGIN}/api/v1/users/${did}/export`), ctx, { did });
  const text = await res.clone().text();
  return { status: res.status, text, body: JSON.parse(text) as JsonBody, res };
}

it('export contains only indexed public records, attachment header, 404 for inactive', async () => {
  const kit = await createFixtureKit();
  const seed = await seedReadModels(kit);
  // Records that exist in repositories but must not be exported for Alice:
  // an invalid scrobble (excluded at apply), an edge to an unknown account,
  // and Bob's own (other-owner) listen.
  await kit.externalPut('Alice', SCROBBLE, 'rx1', {
    $type: SCROBBLE,
    artist: `${MARKER}-excluded`,
    track: '',
    listenedAt: '2026-01-15T10:00:00Z',
    createdAt: '2026-01-15T10:00:00Z',
  });
  const daveRkey = await followRkey(DAVE);
  await kit.externalPut('Alice', FOLLOW, daveRkey, { $type: FOLLOW, subject: DAVE, createdAt: FOLLOW_CREATED_AT });
  await kit.externalPut('Bob', SCROBBLE, 'rb2', {
    $type: SCROBBLE,
    artist: `${MARKER}-bob`,
    track: 'Other owner',
    listenedAt: '2026-01-15T10:30:00Z',
    createdAt: '2026-01-15T10:30:00Z',
  });

  const stub = env.HARNESS.get(env.HARNESS.idFromName('export')) as DurableObjectStub<HarnessDO>;
  await inDo(stub, (db) =>
    db.tx(() => {
      markConnected(db, NOW_MS);
      recordEvent(db, { cursor: 1, timeUs: NOW_MS * 1000 });
      updateCheckpointBookkeeping(db, { pendingGap: false });
      for (const did of [ALICE, BOB, CAROL]) seedUser(db, did);
    }),
  );
  const targets: Array<{ did: string; collection: string; rkey: string }> = [
    ...seed.records.values(),
    { did: ALICE, collection: SCROBBLE, rkey: 'rx1' },
    { did: ALICE, collection: FOLLOW, rkey: daveRkey },
    { did: BOB, collection: SCROBBLE, rkey: 'rb2' },
  ];
  const proofs: RecordProof[] = [];
  for (const t of targets) {
    const u = kit.user(t.did);
    proofs.push(await verifiedProof(kit.repos[u.name], u.key.didKey, t.collection, t.rkey));
  }
  const outcomes = await inDo(stub, (db) => proofs.map((p) => db.tx(() => applyRecordProof(db, p, OPTS)).outcome));
  // r01–r07, r08 (proven absent), r09, r10, Alice→Bob, then rx1 (invalid), Alice→Dave, Bob's rb2.
  expect(outcomes).toEqual([
    ...Array<string>(7).fill('applied'),
    'absent',
    'applied',
    'applied',
    'applied',
    'excluded',
    'applied',
    'applied',
  ]);

  // Marker strings in every table an export must never read.
  await inDo(stub, (db) =>
    db.tx(() => {
      db.run(
        `INSERT INTO identity_cache(did, doc_json, signing_key, pds, handle, fetched_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ALICE,
        `{"marker":"${MARKER}-identity"}`,
        `${MARKER}-key`,
        'https://pds-alice.example.test',
        'alice.test',
        NOW_MS,
      );
      db.run(
        `INSERT INTO hints(uri, did, collection, rkey, source, priority, receipt_time, due_at, last_error)
         VALUES (?, ?, ?, ?, 'notify', 0, ?, ?, ?)`,
        `at://${ALICE}/${SCROBBLE}/rhint`,
        ALICE,
        SCROBBLE,
        'rhint',
        NOW,
        NOW_MS + 3_600_000,
        `${MARKER}-hint-error`,
      );
      db.run(
        `INSERT INTO repo_jobs(did, kind, state, generation, due_at, updated_at_ms, failure_code)
         VALUES (?, 'status', 'failed', 0, ?, ?, ?)`,
        ALICE,
        NOW_MS + 3_600_000,
        NOW_MS,
        `${MARKER}-job`,
      );
      db.run(`INSERT INTO counters(name, label, value) VALUES ('excluded', ?, 1)`, `${MARKER}-counter`);
    }),
  );

  const clock = fixedClock();
  const index = makeLocalIndex(
    { stub, clock, config: parseConfig({ ...env, INGEST_MODE: 'socket' }, { allowFixturePrefix: true }) },
    { exportUser },
  );
  const ctx: RequestCtx = {
    env: { ...env } as unknown as Env,
    index,
    requestId: REQUEST_ID,
    clock,
    cursorKey,
    clientIp: '203.0.113.7',
  };

  // --- Alice's export.
  const res = await getExport(ctx, ALICE);
  expect(res.status).toBe(200);
  expect(schemas.Export(res.body)).toBe('valid');
  expect(res.res.headers.get('content-disposition')).toBe(DISPOSITION);
  expect(res.res.headers.get('cache-control')).toBe('no-store');
  expect(res.res.headers.get('content-type')).toBe('application/json');
  expect(Object.keys(res.body)).toEqual(['schemaVersion', 'did', 'exportedAt', 'indexing', 'scrobbles', 'follows']);
  expect(res.body.schemaVersion).toBe(1);
  expect(res.body.did).toBe(ALICE);
  expect(res.body.exportedAt).toBe(NOW);
  expect(res.body.indexing).toEqual({ state: 'current', caughtUp: true, lastIndexedAt: NOW, lagSeconds: 0 });

  // Exactly Alice's seven indexed listens, newest first (TESTING.md history order); r08 was deleted.
  const r = (rkey: string) => `at://${ALICE}/${SCROBBLE}/${rkey}`;
  expect(res.body.scrobbles.map((s: { uri: string }) => s.uri)).toEqual(
    ['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06'].map(r),
  );
  const r01 = seed.records.get(r('r01'));
  const aliceRev = kit.repos.Alice.head?.rev;
  expect(res.body.scrobbles[1]).toEqual({
    uri: r('r01'),
    cid: r01?.cid,
    did: ALICE,
    revision: aliceRev,
    artist: 'Björk',
    track: 'Jóga',
    album: 'Homogenic',
    listenedAt: '2026-01-15T11:00:00.000000000Z',
    createdAt: '2026-01-15T11:00:00.000000000Z',
    indexedAt: NOW,
  });
  for (const s of res.body.scrobbles) {
    expect(s.did).toBe(ALICE);
    expect(s.revision).toBe(aliceRev);
    expect(Object.keys(s)).not.toContain('artistKey');
  }
  // Only the visible Alice→Bob edge; the edge to the unknown DID is hidden.
  const aliceBob = `at://${ALICE}/${FOLLOW}/${await followRkey(BOB)}`;
  expect(res.body.follows).toEqual([
    {
      uri: aliceBob,
      cid: seed.records.get(aliceBob)?.cid,
      actor: ALICE,
      subject: BOB,
      createdAt: '2025-01-01T00:00:00.000000000Z',
    },
  ]);

  // Secret scan: nothing from other tables, other owners, credentials or config.
  expect(res.text).not.toContain(MARKER);
  expect(res.text).not.toContain(kit.users.Alice.token);
  expect(res.text).not.toContain(kit.users.Bob.token);
  expect(res.text).not.toContain(env.CURSOR_KEY);
  expect(res.text).not.toContain(r('r08'));
  expect(res.text).not.toContain(r('rx1'));
  expect(res.text).not.toContain(DAVE);
  expect(res.text).not.toContain(`at://${BOB}/${SCROBBLE}`);
  // The excluded and hidden rows are really stored; the export left them alone.
  const stored = await inDo(stub, (db) => ({
    excluded: db.one('SELECT state FROM record_state WHERE uri = ?', r('rx1')),
    hiddenEdge: db.one('SELECT subject FROM follows WHERE subject = ?', DAVE),
    bob: db.all('SELECT uri FROM scrobbles WHERE did = ? ORDER BY uri', BOB),
  }));
  expect(stored).toEqual({
    excluded: { state: 'excluded' },
    hiddenEdge: { subject: DAVE },
    bob: [{ uri: `at://${BOB}/${SCROBBLE}/r09` }, { uri: `at://${BOB}/${SCROBBLE}/rb2` }],
  });

  // --- 404 for unknown and inactive accounts; 422 for a malformed DID.
  const unknown = await getExport(ctx, DAVE);
  expect(unknown.status).toBe(404);
  expect(schemas.Error(unknown.body)).toBe('valid');
  expect(unknown.res.headers.get('content-disposition')).toBeNull();

  await inDo(stub, (db) => db.tx(() => markInactive(db, ALICE, 'deactivated')));
  const inactive = await getExport(ctx, ALICE);
  expect(inactive.status).toBe(404);
  expect(schemas.Error(inactive.body)).toBe('valid');
  expect(inactive.body).toEqual({
    error: { code: 'not_found', message: 'The resource is absent or inactive.', requestId: REQUEST_ID },
  });
  expect(inactive.res.headers.get('cache-control')).toBe('no-store');
  expect(inactive.res.headers.get('content-disposition')).toBeNull();
  expect(inactive.text).not.toContain(MARKER);

  // Bob's export no longer carries anything of the now hidden Alice.
  const bob = await getExport(ctx, BOB);
  expect(bob.status).toBe(200);
  expect(schemas.Export(bob.body)).toBe('valid');
  expect(bob.body.scrobbles.map((s: { uri: string }) => s.uri)).toEqual([
    `at://${BOB}/${SCROBBLE}/r09`,
    `at://${BOB}/${SCROBBLE}/rb2`,
  ]);
  expect(bob.body.follows).toEqual([]);
  expect(bob.text).not.toContain(ALICE);

  const before = index.calls.length;
  const bad = await getExport(ctx, 'not-a-did');
  expect(bad.status).toBe(422);
  expect(schemas.Error(bad.body)).toBe('valid');
  expect(bad.body.error.fields).toEqual({ did: 'Expected a DID.' });
  expect(index.calls.length).toBe(before);
  expect(index.calls.map((c) => c.args[0])).toEqual([ALICE, DAVE, ALICE, BOB]);
});
