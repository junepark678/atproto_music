// W3-03: GET /api/v1/resolve?handle= through the IndexRpc module function
// and the production IdentityResolver on the fixture network (M2.1.1
// round_trip, M5.2.1 unverified_alias; docs/profiles.md).
//
// The resolver is the real one (SafeFetch, DoH TXT, PLC documents) over the
// fixture transport, given an identity cache the way the DO's resolver is, so
// the test can show the module reads the cached identity instead of forcing a
// fresh one. Expectations are hardcoded.

import { createIdentityResolver, type IdentityCache } from '@atmusic/atproto/identity/resolver';
import type { ResolvedIdentity } from '@atmusic/atproto/identity/types';
import { createFixtureKit } from '@atmusic/atproto/test-support/read-models';
import type { Transport } from '@atmusic/atproto/transport';
import { deriveCursorKey } from '@atmusic/core/cursor';
import { fixedClock } from '@atmusic/core/test-support/clock';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { beforeAll, expect, it } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import { parseConfig, parseCursorKey } from '../../src/config';

import { resolveHandle } from '../../src/do/read/profile';
import { routes as resolveRoutes } from '../../src/http/resolve';
import type { RequestCtx } from '../../src/http/types';
import { HARNESS_ENV, inTestDb, makeDbIndex, openTestDb } from './node-harness';

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
const schemas = { ResolvedIdentity: openapiValidator('ResolvedIdentity'), Error: openapiValidator('Error') };

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated with AJV against api/openapi.yaml, then compared with toEqual.
type JsonBody = any;

const REQUEST_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';
const ORIGIN = 'https://music.example.test';
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
/** A handle whose host answers 404 for /.well-known/atproto-did and publishes no TXT record. */
const GONE = 'gone.test';

let cursorKey: CryptoKey;
beforeAll(async () => {
  cursorKey = await deriveCursorKey(parseCursorKey(HARNESS_ENV));
});

/** A Map-backed identity cache, standing in for the DO's identity_cache hook. */
function memoryCache() {
  const map = new Map<string, ResolvedIdentity>();
  const cache: IdentityCache = {
    get: (did) => map.get(did) ?? null,
    put: (identity) => {
      map.set(identity.did, identity);
    },
  };
  return { cache, map };
}

async function setup() {
  const kit = await createFixtureKit();
  // The fixture network plus one host that has no DID for its handle.
  const transport: Transport = Object.assign(
    async (req: Request) => {
      const url = new URL(req.url);
      if (url.hostname === GONE) {
        return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      return kit.transport(req);
    },
    { fixture: true as const },
  );
  const clock = fixedClock();
  const { cache, map } = memoryCache();
  const identity = createIdentityResolver({ transport, clock, cache });
  const store = await openTestDb();
  const index = makeDbIndex(
    { db: store, clock, identity, transport, config: parseConfig(HARNESS_ENV, { allowFixturePrefix: true }) },
    { resolveHandle },
  );
  const ctx: RequestCtx = {
    env: { ...HARNESS_ENV },
    index,
    requestId: REQUEST_ID,
    clock,
    cursorKey,
    clientIp: '203.0.113.7',
  };
  return { kit, store, index, ctx, cacheMap: map };
}

const resolveRoute = (() => {
  const found = resolveRoutes.find((r) => r.method === 'GET' && r.pattern === '/api/v1/resolve');
  if (found === undefined) throw new Error('no resolve route');
  return found;
})();

async function resolve(ctx: RequestCtx, query: string) {
  const res = await resolveRoute.handler(new Request(`${ORIGIN}/api/v1/resolve${query}`), ctx, {});
  return { status: res.status, body: (await res.clone().json()) as JsonBody, res };
}

function errorOf(code: string, message: string, fields?: Record<string, string>) {
  return { error: { code, message, requestId: REQUEST_ID, ...(fields === undefined ? {} : { fields }) } };
}

it('verified handle 200; unresolved 404; mismatch 422', async () => {
  const { kit, store, index, ctx, cacheMap } = await setup();

  // --- Verified round trip (case-insensitive input, normalised output).
  const ok = await resolve(ctx, '?handle=Alice.TEST');
  expect(ok.status).toBe(200);
  expect(schemas.ResolvedIdentity(ok.body)).toBe('valid');
  expect(ok.body).toEqual({ did: ALICE, handle: 'alice.test', verified: true });
  expect(Object.keys(ok.body)).toEqual(['did', 'handle', 'verified']);
  expect(ok.res.headers.get('cache-control')).toBe('no-store');
  // handle → DID (TXT), the DID document (PLC), then the document's claim back to the DID (TXT again).
  expect(kit.doh.count('_atproto.alice.test', 'TXT')).toBe(2);
  expect(kit.plc.count(ALICE)).toBe(1);
  expect(cacheMap.get(ALICE)?.handle).toBe('alice.test');

  // A second resolve reads the cached identity: no new DID document fetch.
  const again = await resolve(ctx, '?handle=alice.test');
  expect(again.status).toBe(200);
  expect(again.body).toEqual({ did: ALICE, handle: 'alice.test', verified: true });
  expect(kit.plc.count(ALICE)).toBe(1);
  expect(kit.doh.count('_atproto.alice.test', 'TXT')).toBe(3);

  // --- Unresolved: no TXT record and the well-known lookup is 404.
  const missing = await resolve(ctx, `?handle=${GONE}`);
  expect(missing.status).toBe(404);
  expect(schemas.Error(missing.body)).toBe('valid');
  expect(missing.body).toEqual(errorOf('not_found', 'The resource is absent or inactive.'));
  expect(missing.res.headers.get('cache-control')).toBe('no-store');
  expect(kit.doh.count(`_atproto.${GONE}`, 'TXT')).toBe(1);

  // --- Mismatch (unverified alias): mallory.test points at Alice's DID, but
  // Alice's document claims alice.test, so the alias is never confirmed.
  kit.doh.setTxt('_atproto.mallory.test', [`did=${ALICE}`]);
  const spoof = await resolve(ctx, '?handle=mallory.test');
  expect(spoof.status).toBe(422);
  expect(schemas.Error(spoof.body)).toBe('valid');
  expect(spoof.body).toEqual(
    errorOf('identity_mismatch', 'The handle and DID do not verify in both directions.', {
      handle: 'Handle verification failed.',
    }),
  );
  expect(spoof.res.headers.get('cache-control')).toBe('no-store');
  // The response never echoes the DID the attacker pointed at.
  expect(JSON.stringify(spoof.body)).not.toContain(ALICE);

  // Ambiguous TXT answers (two DIDs) are a mismatch too, with no HTTPS fallback.
  kit.doh.setTxt('_atproto.twins.test', [`did=${ALICE}`, `did=${BOB}`]);
  const twins = await resolve(ctx, '?handle=twins.test');
  expect(twins.status).toBe(422);
  expect(twins.body.error.code).toBe('identity_mismatch');

  // An unavailable upstream is 502, not a fabricated answer.
  kit.doh.setTxt('_atproto.bob.test', [`did=${BOB}`]);
  kit.plc.fail({ did: BOB }, { kind: 'status', status: 500, error: 'InternalServerError' }, Infinity);
  const outage = await resolve(ctx, '?handle=bob.test');
  expect(outage.status).toBe(502);
  expect(schemas.Error(outage.body)).toBe('valid');
  expect(outage.body).toEqual(errorOf('upstream_error', 'The upstream request permanently failed.'));
  expect(index.logs).toEqual([
    { level: 'warn', event: 'resolve_upstream_error', fields: { stage: 'did', code: 'http_status' } },
  ]);

  // --- Query admission: 422 fields.handle, and the DO is never asked.
  const rpcBefore = index.calls.length;
  for (const query of [
    '',
    '?handle=',
    '?handle=not_a_handle',
    '?handle=a.test&handle=b.test',
    '?handle=alice.test&x=1',
    '?handle=printer.local',
  ]) {
    const bad = await resolve(ctx, query);
    expect(bad.status).toBe(422);
    expect(schemas.Error(bad.body)).toBe('valid');
    expect(bad.body).toEqual(
      errorOf('validation_failed', 'A request field is invalid.', { handle: 'Expected a handle.' }),
    );
  }
  expect(index.calls.length).toBe(rpcBefore);
  expect(index.calls.map((c) => c.args[0])).toEqual([
    'alice.test',
    'alice.test',
    GONE,
    'mallory.test',
    'twins.test',
    'bob.test',
  ]);

  // Resolution creates no music user, hint or job.
  const rows = await inTestDb(store, (db) => {
    return {
      users: db.all('SELECT did FROM users'),
      hints: db.all('SELECT uri FROM hints'),
      jobs: db.all('SELECT did FROM repo_jobs'),
    };
  });
  expect(rows).toEqual({ users: [], hints: [], jobs: [] });
});
