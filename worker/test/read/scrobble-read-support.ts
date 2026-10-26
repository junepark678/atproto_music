// Shared setup for the scrobble read suites (W3-01). TEST-ONLY.
//
// The index is seeded through the real ingestion path, minus the network:
// - tests/fixtures/read_models.json is published by
//   @atmusic/atproto/test-support/read-models as real signed commits on fake
//   PDSs (r08 created then deleted, Carol's r10 as an external writer, the
//   Alice→Bob follow at its deterministic rkey);
// - every Jetstream commit event is drained in order like a hint: the
//   getRecord CAR for that commit (the bytes the fake PDS serves) goes through
//   the production W2-03 verifier `verifyRecordProof` with the account's
//   did:key, and the verified proof through the production W2-04
//   `applyRecordProof`, in one transaction in the test database.
// No CID, revision or row is written by hand; the only test-only write is the
// three `users` rows (what admission plus a completed snapshot leave behind,
// worker/test/write/support.ts seedUser).
//
// Each fixture is a fresh migrated node:sqlite database in its own temporary
// file (node-harness.ts openTestDb, over node-db's withMigratedDb), closed
// and removed after the test file.

import {
  createFixtureKit,
  FIXTURE_USERS,
  type FixtureKit,
  type FixtureUser,
  type SeedResult,
  seedReadModels,
} from '@atmusic/atproto/test-support/read-models';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { deriveCursorKey } from '@atmusic/core/cursor';
import { fixedClock } from '@atmusic/core/test-support/clock';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { expect } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };
import { parseCursorKey } from '../../src/config';
import type { Db } from '../../src/do/db';
import { feed } from '../../src/do/read/feed';
import { history } from '../../src/do/read/history';
import { lookup } from '../../src/do/read/lookup';
import { type ApplyResult, applyRecordProof } from '../../src/do/write/apply-record';
import { routes as feedRoutes } from '../../src/http/feed';
import { routes as scrobbleRoutes } from '../../src/http/scrobbles-read';
import type { RequestCtx, RouteDef } from '../../src/http/types';
import { OPTS, seedUser } from '../write/support';
import { HARNESS_ENV, type LocalIndex, makeDbIndex, openTestDb, type TestDb } from './node-harness';

export const ALICE = fixture.users.Alice.did;
export const BOB = fixture.users.Bob.did;
export const CAROL = fixture.users.Carol.did;
export const SCROBBLE = 'com.example.atmusic.scrobble';
export const REQUEST_ID = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
export const ORIGIN = 'https://music.example.test';
/** The frozen clock in the 30-character storage/DTO form. */
export const NOW_DTO = '2026-01-15T12:00:00.000000000Z';
/**
 * Indexing in the harness: INGEST_MODE=off makes the global state `stale`,
 * every DRAINed proof was indexed at the frozen instant, and no event was
 * ever received (lag null).
 */
export const HARNESS_INDEXING = { state: 'stale', caughtUp: false, lastIndexedAt: NOW_DTO, lagSeconds: null };

export const uriOf = (did: string, rkey: string) => `at://${did}/${SCROBBLE}/${rkey}`;
/** The rkey of a fixture scrobble URI (`r01`…). */
export const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

// ---------------------------------------------------------------------------
// OpenAPI schemas (AJV against api/openapi.yaml)

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

export const schemas = {
  ScrobblePage: openapiValidator('ScrobblePage'),
  ScrobbleResult: openapiValidator('ScrobbleResult'),
  Error: openapiValidator('Error'),
};

// ---------------------------------------------------------------------------
// Fixture index

export interface ReadFixture {
  kit: FixtureKit;
  seed: SeedResult;
  /** The fixture's database (a migrated temporary file, open until the end of the test file). */
  db: TestDb;
  /** IndexRpc over the database: history, feed and lookup are the production modules. */
  index: LocalIndex;
  /** Every outcome of every drained proof, in event order. */
  outcomes: Array<{ uri: string; rev: string; outcome: ApplyResult['outcome'] }>;
  /** Verify and apply every Jetstream commit not yet drained; returns the new outcomes. */
  drain(): Promise<Array<{ uri: string; rev: string; outcome: ApplyResult['outcome'] }>>;
  /** Run `fn` against the database. */
  inDb<T>(fn: (db: Db) => T): Promise<T>;
}

function userByDid(kit: FixtureKit, did: string): FixtureUser {
  const name = FIXTURE_USERS.find((n) => kit.users[n].did === did);
  if (name === undefined) throw new Error(`no fixture user ${did}`);
  return name;
}

/**
 * A fresh database seeded with read_models.json through verify → apply.
 * `name` labelled the harness DO; every call now gets its own database file.
 */
export async function readFixture(_name: string): Promise<ReadFixture> {
  const kit = await createFixtureKit();
  const seed = await seedReadModels(kit);
  const db = await openTestDb();
  const inDb = async <T>(fn: (db: Db) => T): Promise<T> => fn(db.db);

  await inDb((db) => {
    for (const n of FIXTURE_USERS) seedUser(db, kit.users[n].did);
  });

  let drained = 0;
  const outcomes: ReadFixture['outcomes'] = [];
  const drain = async () => {
    const fresh: ReadFixture['outcomes'] = [];
    const events = kit.jetstream.events;
    for (; drained < events.length; drained++) {
      const ev = events[drained]!;
      if (ev.kind !== 'commit') continue;
      const owner = userByDid(kit, ev.did);
      const repo = kit.repos[owner];
      const commit = repo.history.find((c) => c.rev === ev.commit.rev);
      if (commit === undefined) throw new Error(`no commit ${ev.commit.rev} for ${ev.did}`);
      const { collection, rkey } = ev.commit;
      const car = await repo.getRecordCar(collection, rkey, { at: commit.cid });
      const proof = await verifyRecordProof(car, {
        did: ev.did,
        collection,
        rkey,
        signingKey: kit.users[owner].key.didKey,
      });
      expect(proof.commit.rev).toBe(ev.commit.rev);
      const applied = await inDb((db) => db.tx(() => applyRecordProof(db, proof, OPTS)));
      const entry = { uri: `at://${ev.did}/${collection}/${rkey}`, rev: proof.commit.rev, outcome: applied.outcome };
      fresh.push(entry);
      outcomes.push(entry);
    }
    return fresh;
  };
  await drain();

  const index = makeDbIndex({ db, clock: fixedClock() }, { history, feed, lookup });
  return { kit, seed, db, index, outcomes, drain, inDb };
}

// ---------------------------------------------------------------------------
// HTTP

let cursorKeyPromise: Promise<CryptoKey> | null = null;

/** The cursor key exactly as the Worker derives it from CURSOR_KEY (crates/core/src/cursor.rs). */
export function harnessCursorKey(): Promise<CryptoKey> {
  cursorKeyPromise ??= deriveCursorKey(parseCursorKey(HARNESS_ENV));
  return cursorKeyPromise;
}

export async function ctxFor(index: LocalIndex): Promise<RequestCtx> {
  return {
    env: HARNESS_ENV,
    index,
    requestId: REQUEST_ID,
    clock: fixedClock(),
    cursorKey: await harnessCursorKey(),
    clientIp: '203.0.113.7',
  };
}

export const ROUTES: RouteDef[] = [...scrobbleRoutes, ...feedRoutes];

/** Match a raw path against a `{name}` pattern; params are the decoded segments. */
function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const a = path.split('/');
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let k = 0; k < p.length; k++) {
    const part = p[k]!;
    const actual = a[k]!;
    if (part.startsWith('{') && part.endsWith('}')) {
      if (actual === '') return null;
      try {
        params[part.slice(1, -1)] = decodeURIComponent(actual);
      } catch {
        params[part.slice(1, -1)] = actual;
      }
    } else if (part !== actual) {
      return null;
    }
  }
  return params;
}

export interface HttpResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected structurally after schema validation.
  body: any;
  res: Response;
}

/** GET `pathAndQuery` through the routes exports, as worker/src/router.ts will dispatch it. */
export async function get(ctx: RequestCtx, pathAndQuery: string): Promise<HttpResult> {
  const url = new URL(pathAndQuery, ORIGIN);
  for (const def of ROUTES) {
    if (def.method !== 'GET') continue;
    const params = match(def.pattern, url.pathname);
    if (params === null) continue;
    const res = await def.handler(new Request(url), ctx, params);
    return { status: res.status, body: await res.clone().json(), res };
  }
  throw new Error(`no route for GET ${url.pathname}`);
}

/** Assert a 200 Page<Scrobble> (status, schema, headers) and return its rkeys. */
export function pageRkeys(r: HttpResult): string[] {
  expect(r.status).toBe(200);
  expect(schemas.ScrobblePage(r.body)).toBe('valid');
  expect(r.res.headers.get('content-type')).toBe('application/json');
  expect(r.res.headers.get('cache-control')).toBe('no-store');
  return (r.body.items as Array<{ uri: string }>).map((i) => rkeyOf(i.uri));
}

/** Assert an error envelope with `code`, `status` and exactly `fields` (when given). */
export function expectError(r: HttpResult, status: number, code: string, fields?: Record<string, string>): void {
  expect(r.status).toBe(status);
  expect(schemas.Error(r.body)).toBe('valid');
  expect(r.res.headers.get('cache-control')).toBe('no-store');
  expect(r.body.error.code).toBe(code);
  expect(r.body.error.requestId).toBe(REQUEST_ID);
  if (fields === undefined) expect(r.body.error.fields).toBeUndefined();
  else expect(r.body.error.fields).toEqual(fields);
}

/** Follow every nextCursor from `first` (a path with query, without cursor); returns the pages' rkeys. */
export async function traverse(ctx: RequestCtx, first: string): Promise<string[][]> {
  const pages: string[][] = [];
  let next: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const sep = first.includes('?') ? '&' : '?';
    const r = await get(ctx, next === null ? first : `${first}${sep}cursor=${encodeURIComponent(next)}`);
    pages.push(pageRkeys(r));
    expect(r.body.asOf).toBe(NOW_DTO);
    next = r.body.nextCursor;
    if (next === null) return pages;
  }
  throw new Error('traversal did not terminate');
}
