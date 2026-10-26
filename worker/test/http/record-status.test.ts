// W4-04: GET /api/v1/records/status through the real route handler and the
// real DO module (worker/src/do/ingest/notify.ts recordStatus) over
// node:sqlite (a temporary-file database with the production migrations). Proves
// M3.2.1/status_contract (N2). Every CID and revision comes from a real signed
// repository (worker/test/write/support.ts) applied with W2-04
// applyRecordProof; every body is validated against the OpenAPI RecordStatus
// schema (including its if/then rules) and compared with hardcoded values.

import type { RecordProof } from '@atmusic/atproto/verify/types';
import { deriveCursorKey } from '@atmusic/core/cursor';
import { fixedClock } from '@atmusic/core/test-support/clock';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { beforeAll, expect, it } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import { parseCursorKey } from '../../src/config';
import type { Db } from '../../src/do/db';
import { enqueueHints } from '../../src/do/ingest/hints';
import { recordStatus } from '../../src/do/ingest/notify';
import { markInactive } from '../../src/do/write/account-state';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { routes as statusRoutes } from '../../src/http/record-status';
import type { RequestCtx } from '../../src/http/types';
import { HARNESS_ENV, inTestDb, makeDbIndex, openTestDb } from '../read/node-harness';
import {
  ALICE,
  BOB,
  CAROL,
  deleteProof,
  FOLLOW,
  fixtureScrobble,
  follow,
  OPTS,
  putProof,
  repoFor,
  SCROBBLE,
  SETTINGS,
  seedSnapshotJob,
  seedUser,
  settings,
  uriOf,
} from '../write/support';

function openapiValidator(schema: string) {
  const doc = JSON.parse(openapiText) as { components: unknown };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
  ajv.addFormat('at-record-uri', /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/[A-Za-z0-9.-]+\/[A-Za-z0-9._:~-]+$/);
  ajv.addFormat('at-record-cid', /^bafyrei[a-z2-7]{52}$/);
  ajv.addSchema({ $id: 'openapi', components: doc.components });
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`);
  if (validate === undefined) throw new Error(`no schema ${schema}`);
  return (value: unknown) => ((validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors));
}
const schemas = { RecordStatus: openapiValidator('RecordStatus'), Error: openapiValidator('Error') };

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated with AJV against api/openapi.yaml, then compared with toEqual.
type JsonBody = any;

const REQUEST_ID = '6f5e4d3c-2b1a-4098-8f7e-6d5c4b3a2918';
const ORIGIN = 'https://music.example.test';
const T0 = Date.parse('2026-01-15T12:00:00Z');
const DAVE = 'did:plc:dddddddddddddddddddddddd';
const TID = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

/** INGEST_MODE=off in the harness: the global state is honestly `stale`, never caught up. */
const STALE_ALICE = {
  state: 'stale',
  caughtUp: false,
  lastIndexedAt: '2026-01-15T12:00:00.000000000Z',
  lagSeconds: null,
};
const STALE_UNINDEXED = { state: 'stale', caughtUp: false, lastIndexedAt: null, lagSeconds: null };
const SUPPRESSED = { state: 'suppressed', caughtUp: false, lastIndexedAt: null, lagSeconds: null };

let cursorKey: CryptoKey;
beforeAll(async () => {
  cursorKey = await deriveCursorKey(parseCursorKey(HARNESS_ENV));
});

const statusRoute = (() => {
  const found = statusRoutes.find((r) => r.method === 'GET' && r.pattern === '/api/v1/records/status');
  if (found === undefined) throw new Error('no records/status route');
  return found;
})();

function cidOf(proof: RecordProof): string {
  if (proof.state !== 'present') throw new Error('expected a present proof');
  return proof.cid;
}

it('states indexed/pending/absent/excluded/unknown with cid and revision', async () => {
  const store = await openTestDb();
  const clock = fixedClock();
  const index = makeDbIndex({ db: store, clock }, { recordStatus: (m, uri) => recordStatus(m, uri) });
  const ctx: RequestCtx = { env: HARNESS_ENV, index, requestId: REQUEST_ID, clock, cursorKey, clientIp: '' };
  const inDo = <T>(fn: (db: Db) => T): Promise<T> => inTestDb(store, (db) => fn(db));
  const get = async (query: string) => {
    const res = await statusRoute.handler(new Request(`${ORIGIN}/api/v1/records/status?${query}`), ctx, {});
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: JSON.parse(text) as JsonBody };
  };
  const status = async (uri: string) => {
    const r = await get(new URLSearchParams({ uri }).toString());
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(schemas.RecordStatus(r.body)).toBe('valid');
    return r.body;
  };

  // Real signed records: Alice has a listen, a follow, an excluded (blank
  // artist) listen and a deleted one; Bob is indexed, then deactivated.
  const alice = await repoFor('alice');
  const r01 = await putProof(alice, SCROBBLE, 'r01', fixtureScrobble('r01'));
  const followBob = await putProof(alice, FOLLOW, '3lfollowbob22', follow(BOB));
  const blank = await putProof(alice, SCROBBLE, 'r03', { ...fixtureScrobble('r03'), artist: ' 　 ' });
  await putProof(alice, SCROBBLE, 'r04', fixtureScrobble('r04'));
  const gone = await deleteProof(alice, SCROBBLE, 'r04');
  const bob = await repoFor('bob');
  const bobListen = await putProof(bob, SCROBBLE, 'r20', fixtureScrobble('r01'));
  const carol = await repoFor('carol');
  const optOut = await putProof(carol, SETTINGS, 'self', settings('disabled'));
  const blankReason = 'artist: expected 1–256 Unicode scalars and at most 1024 UTF-8 bytes, with nonempty trimmed text';

  await inDo((db) => {
    seedUser(db, ALICE);
    seedUser(db, BOB);
    db.tx(() => {
      for (const p of [r01, followBob, blank, gone, bobListen, optOut]) applyRecordProof(db, p, OPTS);
    });
    markInactive(db, BOB, 'deactivated');
  });
  const before = await inDo((db) => ({
    users: db.all('SELECT * FROM users ORDER BY did'),
    hints: db.all('SELECT * FROM hints'),
    jobs: db.all('SELECT * FROM repo_jobs'),
  }));

  // indexed: a visible row with its verified cid and revision.
  const r01Uri = uriOf(ALICE, SCROBBLE, 'r01');
  expect(await status(r01Uri)).toEqual({
    uri: r01Uri,
    state: 'indexed',
    cid: cidOf(r01),
    revision: r01.commit.rev,
    indexing: STALE_ALICE,
  });
  expect(r01.commit.rev).toMatch(TID);
  const followUri = uriOf(ALICE, FOLLOW, '3lfollowbob22');
  expect(await status(followUri)).toEqual({
    uri: followUri,
    state: 'indexed',
    cid: cidOf(followBob),
    revision: followBob.commit.rev,
    indexing: STALE_ALICE,
  });

  // excluded: from record_state, with cid, revision and reason.
  const r03Uri = uriOf(ALICE, SCROBBLE, 'r03');
  expect(await status(r03Uri)).toEqual({
    uri: r03Uri,
    state: 'excluded',
    cid: cidOf(blank),
    revision: blank.commit.rev,
    reason: blankReason,
    indexing: STALE_ALICE,
  });

  // absent: verified absence at its revision; no cid, no reason.
  const r04Uri = uriOf(ALICE, SCROBBLE, 'r04');
  expect(await status(r04Uri)).toEqual({
    uri: r04Uri,
    state: 'absent',
    revision: gone.commit.rev,
    indexing: STALE_ALICE,
  });
  expect(gone.commit.rev > blank.commit.rev).toBe(true);

  // unknown: never seen; and a verified record of a hidden (deactivated) owner.
  const neverUri = uriOf(ALICE, SCROBBLE, 'r99');
  expect(await status(neverUri)).toEqual({ uri: neverUri, state: 'unknown', indexing: STALE_ALICE });
  const bobUri = uriOf(BOB, SCROBBLE, 'r20');
  expect(await status(bobUri)).toEqual({
    uri: bobUri,
    state: 'unknown',
    indexing: { state: 'stale', caughtUp: false, lastIndexedAt: '2026-01-15T12:00:00.000000000Z', lagSeconds: null },
  });
  const daveUri = uriOf(DAVE, SCROBBLE, 'r01');
  expect(await status(daveUri)).toEqual({ uri: daveUri, state: 'unknown', indexing: STALE_UNINDEXED });
  // A suppressed (opted-out) DID: nothing is kept, and indexing says why.
  const carolUri = uriOf(CAROL, SCROBBLE, 'r10');
  expect(await status(carolUri)).toEqual({ uri: carolUri, state: 'unknown', indexing: SUPPRESSED });
  expect(await status(uriOf(CAROL, SETTINGS, 'self'))).toMatchObject({ state: 'unknown', indexing: SUPPRESSED });

  // The reads wrote nothing.
  expect(
    await inDo((db) => ({
      users: db.all('SELECT * FROM users ORDER BY did'),
      hints: db.all('SELECT * FROM hints'),
      jobs: db.all('SELECT * FROM repo_jobs'),
    })),
  ).toEqual(before);

  // pending: a hint for the URI (an unseen record, or an update of an excluded one) ...
  await inDo((db) =>
    enqueueHints(db, [
      { did: ALICE, collection: SCROBBLE, rkey: 'r99', source: 'notify', receiptMs: T0 },
      { did: ALICE, collection: SCROBBLE, rkey: 'r03', source: 'notify', receiptMs: T0 },
    ]),
  );
  expect(await status(neverUri)).toEqual({ uri: neverUri, state: 'pending', indexing: STALE_ALICE });
  expect(await status(r03Uri)).toEqual({ uri: r03Uri, state: 'pending', indexing: STALE_ALICE });
  // ... while a visible row stays indexed with its verified version.
  await inDo((db) =>
    enqueueHints(db, [{ did: ALICE, collection: SCROBBLE, rkey: 'r01', source: 'jetstream', receiptMs: T0 }]),
  );
  expect(await status(r01Uri)).toMatchObject({ state: 'indexed', cid: cidOf(r01), revision: r01.commit.rev });
  // ... or an open snapshot job for the DID (Dave admitted, walk running).
  await inDo((db) => seedSnapshotJob(db, DAVE, seedUser(db, DAVE, { active: false })));
  expect(await status(daveUri)).toEqual({
    uri: daveUri,
    state: 'pending',
    indexing: { state: 'stale', caughtUp: false, lastIndexedAt: null, lagSeconds: null },
  });

  // Invalid queries are 422 fields.uri before the IndexDO is called.
  const callsBefore = index.calls.length;
  const invalid = [
    '',
    'uri=',
    `uri=${encodeURIComponent(`at://${ALICE}/app.bsky.feed.post/3l2a`)}`,
    `uri=${encodeURIComponent(`at://${ALICE}/${SCROBBLE}`)}`,
    `uri=${encodeURIComponent(`at://alice.example.com/${SCROBBLE}/r01`)}`,
    `uri=${encodeURIComponent('https://example.com/r01')}`,
    `uri=${encodeURIComponent(r01Uri)}&uri=${encodeURIComponent(r01Uri)}`,
    `uri=${encodeURIComponent(r01Uri)}&cid=x`,
  ];
  for (const q of invalid) {
    const r = await get(q);
    expect([q, r.status]).toEqual([q, 422]);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(schemas.Error(r.body)).toBe('valid');
    expect(r.body.error).toEqual({
      code: 'validation_failed',
      message: 'A request field is invalid.',
      requestId: REQUEST_ID,
      fields: { uri: 'Expected a record AT URI in a configured collection.' },
    });
  }
  expect(index.calls.length).toBe(callsBefore);
  expect(index.networkAttempts).toEqual([]);
});
