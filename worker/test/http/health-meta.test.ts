// GET /health/live, GET /health/ready and GET /api/v1/meta against real DO
// storage in the harness DO (M1.4.2 ready_before_storage / upstream_outage,
// M1.2.3 packaged_http, M6.1.3 fresh_install, M6.2.2 upstream_offline, A20).

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Indexing } from '@atmusic/core/api-types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { beforeAll, expect, it } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import { ConfigError, FIXTURE_PREFIX, parseConfig } from '../../src/config';
import type { IndexRpc, ModuleDeps } from '../../src/do/contracts';
import { type MigrateResult, migrate } from '../../src/do/migrate';
import { MIGRATIONS } from '../../src/do/schema';
import type { Env, EnvVars } from '../../src/env';
import { routes as healthRoutes } from '../../src/http/health';
import { APP_VERSION, createMetaRoutes, routes as metaRoutes } from '../../src/http/meta';
import type { RequestCtx, RouteDef } from '../../src/http/types';
import type { HarnessDO } from '../harness/harness-do';
import { makeLocalIndex } from '../harness/local-index';

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
  Live: openapiValidator('Live'),
  Ready: openapiValidator('Ready'),
  Meta: openapiValidator('Meta'),
  Error: openapiValidator('Error'),
};

const REQUEST_ID = '0b8a5d3c-2e1f-4a6b-9c7d-8e9f0a1b2c3d';
const BASE_CAPS = ['read', 'stats', 'follows', 'notify', 'indexing'];
const OWNED = 'org.example.music';

let cursorKey: CryptoKey;
beforeAll(async () => {
  cursorKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(32).fill(7),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
});

const VARS: EnvVars = {
  PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
  LEXICON_PREFIX: env.LEXICON_PREFIX,
  NAMESPACE_OWNERSHIP_REF: env.NAMESPACE_OWNERSHIP_REF,
  INGEST_MODE: env.INGEST_MODE,
  JETSTREAM_URLS: env.JETSTREAM_URLS,
  JETSTREAM_LOOKBACK_HOURS: env.JETSTREAM_LOOKBACK_HOURS,
  RELAY_URL: env.RELAY_URL,
  PLAN: env.PLAN,
  DO_LOCATION_HINT: env.DO_LOCATION_HINT,
};

/** A Worker Env for the handlers; the INDEX and ASSETS bindings are never touched by these routes. */
function workerEnv(vars: Partial<EnvVars>): Env {
  return { ...VARS, ...vars, CURSOR_KEY: env.CURSOR_KEY } as unknown as Env;
}

function ctxFor(index: IndexRpc, vars: Partial<EnvVars> = {}): RequestCtx {
  return {
    env: workerEnv(vars),
    index,
    requestId: REQUEST_ID,
    clock: fixedClock(),
    cursorKey,
    clientIp: '203.0.113.7',
  };
}

function route(list: RouteDef[], pattern: string): RouteDef {
  const found = list.find((r) => r.pattern === pattern);
  if (found === undefined) throw new Error(`no route ${pattern}`);
  expect(found.method).toBe('GET');
  return found;
}

async function call(def: RouteDef, ctx: RequestCtx): Promise<{ status: number; body: unknown; res: Response }> {
  const res = await def.handler(new Request(`https://music.example.test${def.pattern}`), ctx, {});
  return { status: res.status, body: await res.clone().json(), res };
}

/** DO module: the global Indexing row exactly as stored. */
function globalIndexing(m: ModuleDeps): Indexing {
  const row = m.db.one<{
    state: Indexing['state'];
    caught_up: number;
    last_indexed_at: string | null;
    lag_seconds: number | null;
  }>('SELECT state, caught_up, last_indexed_at, lag_seconds FROM indexing_status WHERE scope = ?', 'global');
  if (row === null) throw new Error('indexing_status has no global row');
  return {
    state: row.state,
    caughtUp: row.caught_up === 1,
    lastIndexedAt: row.last_indexed_at,
    lagSeconds: row.lag_seconds,
  };
}

/**
 * An IndexRpc over one harness DO: `ready()` runs the production migrate()
 * against its storage, `indexing()` reads the stored global row, and every
 * other method rejects. `readyCalls` counts readiness checks.
 */
function harnessIndex(name: string) {
  const stub = env.HARNESS.get(env.HARNESS.idFromName(name)) as DurableObjectStub<HarnessDO>;
  const local = makeLocalIndex({ stub }, { indexing: globalIndexing });
  const state = { readyCalls: 0 };
  const index: IndexRpc = {
    ...local,
    ready: async (): Promise<MigrateResult> => {
      state.readyCalls++;
      return runInDurableObject(stub, (_i: HarnessDO, s: DurableObjectState) => migrate(s.storage));
    },
  };
  return { stub, local, index, state };
}

/** An IndexRpc whose every method rejects and is counted (proves a route stays local). */
function untouchableIndex() {
  const calls: string[] = [];
  const index = new Proxy({} as IndexRpc, {
    get(_t, prop) {
      return async () => {
        calls.push(String(prop));
        throw new Error(`IndexRpc.${String(prop)} must not be called`);
      };
    },
  });
  return { index, calls };
}

const live = route(healthRoutes, '/health/live');
const ready = route(healthRoutes, '/health/ready');
const meta = route(metaRoutes, '/api/v1/meta');

it('live 200; ready 503 when index reports too_new; meta capabilities omit publication without owned prefix', async () => {
  expect(healthRoutes.map((r) => `${r.method} ${r.pattern}`)).toEqual(['GET /health/live', 'GET /health/ready']);
  expect(metaRoutes.map((r) => `${r.method} ${r.pattern}`)).toEqual(['GET /api/v1/meta']);

  // Live is local: 200 {status:'live'} with no IndexDO call at all.
  const untouched = untouchableIndex();
  const liveRes = await call(live, ctxFor(untouched.index));
  expect(liveRes.status).toBe(200);
  expect(liveRes.body).toEqual({ status: 'live' });
  expect(schemas.Live(liveRes.body)).toBe('valid');
  expect(liveRes.res.headers.get('content-type')).toBe('application/json');
  expect(untouched.calls).toEqual([]);

  // A freshly migrated DO is ready.
  const fresh = harnessIndex('health-fresh');
  const readyRes = await call(ready, ctxFor(fresh.index));
  expect(readyRes.status).toBe(200);
  expect(readyRes.body).toEqual({ status: 'ready' });
  expect(schemas.Ready(readyRes.body)).toBe('valid');
  expect(fresh.state.readyCalls).toBe(1);

  // Storage written by newer code: migrate() reports too_new and leaves it untouched; ready is 503.
  const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  const future = harnessIndex('health-too-new');
  await runInDurableObject(future.stub, (_i: HarnessDO, s: DurableObjectState) => {
    s.storage.sql.exec('INSERT INTO schema_migrations(version, name) VALUES (?, ?)', latest + 1, 'from-newer-code');
  });
  const tooNew = await call(ready, ctxFor(future.index));
  expect(tooNew.status).toBe(503);
  expect(tooNew.res.headers.get('cache-control')).toBe('no-store');
  expect(schemas.Error(tooNew.body)).toBe('valid');
  expect(tooNew.body).toEqual({
    error: { code: 'not_ready', message: 'Index storage is not initialized.', requestId: REQUEST_ID },
  });
  expect(future.state.readyCalls).toBe(1);
  const ledger = await runInDurableObject(future.stub, (_i: HarnessDO, s: DurableObjectState) =>
    s.storage.sql.exec<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').toArray(),
  );
  expect(ledger.map((r) => r.version)).toEqual([...MIGRATIONS.map((m) => m.version), latest + 1]);

  // A DO that cannot answer is not ready either (503, not 500).
  const failing = untouchableIndex();
  const unavailable = await call(ready, ctxFor(failing.index));
  expect(unavailable.status).toBe(503);
  expect((unavailable.body as { error: { code: string } }).error.code).toBe('not_ready');
  expect(failing.calls).toEqual(['ready']);

  // Meta over too_new storage: scaffold, no capabilities, honest recovering, no indexing read.
  const scaffold = await call(
    meta,
    ctxFor(future.index, { LEXICON_PREFIX: OWNED, NAMESPACE_OWNERSHIP_REF: 'dns:txt' }),
  );
  expect(scaffold.status).toBe(200);
  expect(schemas.Meta(scaffold.body)).toBe('valid');
  expect(scaffold.body).toEqual({
    name: 'atproto_music',
    version: APP_VERSION,
    stage: 'scaffold',
    capabilities: [],
    lexiconPrefix: OWNED,
    indexing: { state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: null },
  });
  expect(future.local.calls).toEqual([]);

  const seeded: Indexing = { state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: null };
  const metaFor = async (def: RouteDef, vars: Partial<EnvVars>) => {
    const res = await call(def, ctxFor(fresh.index, vars));
    expect(res.status).toBe(200);
    expect(res.res.headers.get('cache-control')).toBe('no-store');
    expect(schemas.Meta(res.body)).toBe('valid');
    return res.body as { capabilities: string[]; lexiconPrefix: string | null; stage: string; indexing: Indexing };
  };

  // Gate closed (empty prefix): no publication, lexiconPrefix null; the frozen api/examples/meta.json.
  const closed = await metaFor(meta, { LEXICON_PREFIX: '' });
  expect(closed).toEqual({
    name: 'atproto_music',
    version: '0.1.0',
    stage: 'backend',
    capabilities: BASE_CAPS,
    lexiconPrefix: null,
    indexing: seeded,
  });

  // An owned prefix without ownership evidence: still no publication.
  const unproven = await metaFor(meta, { LEXICON_PREFIX: OWNED, NAMESPACE_OWNERSHIP_REF: '' });
  expect(unproven.capabilities).toEqual(BASE_CAPS);
  expect(unproven.lexiconPrefix).toBe(OWNED);
  expect(unproven.stage).toBe('backend');

  // The fixture prefix never enables publication, even with test-entry config and evidence
  // (which parseConfig refuses for the fixture prefix).
  const testEntryMeta = route(
    createMetaRoutes((e) => parseConfig(e, { allowFixturePrefix: true })),
    '/api/v1/meta',
  );
  const fixture = await metaFor(testEntryMeta, { LEXICON_PREFIX: FIXTURE_PREFIX, NAMESPACE_OWNERSHIP_REF: '' });
  expect(fixture.capabilities).toEqual(BASE_CAPS);
  expect(fixture.capabilities).not.toContain('publication');
  expect(fixture.lexiconPrefix).toBe(FIXTURE_PREFIX);
  // The production routes refuse the fixture prefix outright.
  await expect(
    meta.handler(new Request('https://music.example.test/api/v1/meta'), ctxFor(fresh.index), {}),
  ).rejects.toBeInstanceOf(ConfigError);

  // Positive control: an owned prefix plus evidence is the only way publication appears.
  const owned = await metaFor(meta, {
    LEXICON_PREFIX: OWNED,
    NAMESPACE_OWNERSHIP_REF: 'dns:_lexicon.music.example.org',
  });
  expect(owned.capabilities).toEqual([...BASE_CAPS, 'publication']);
  expect(owned.lexiconPrefix).toBe(OWNED);
  expect(owned.stage).toBe('product');

  // Each ready meta read the DO's global indexing exactly once.
  expect(fresh.local.calls.map((c) => c.method)).toEqual(['indexing', 'indexing', 'indexing', 'indexing']);
});

it('ready 200 and meta indexing stale while the index reports the socket disconnected', async () => {
  const clock = fixedClock();
  const now = clock.nowMs();
  const outage = harnessIndex('health-socket-down');

  // The socket dropped six minutes ago and the index has marked global indexing stale.
  await runInDurableObject(outage.stub, (_i: HarnessDO, s: DurableObjectState) => {
    s.storage.sql.exec(
      `UPDATE ingest_checkpoint SET connected = 0, mode = 'socket', updated_at_ms = ?, connected_at_ms = ? WHERE stream = 'jetstream'`,
      now - 6 * 60_000,
      now - 60 * 60_000,
    );
    s.storage.sql.exec(
      `UPDATE indexing_status SET state = 'stale', caught_up = 0, last_indexed_at = ?, lag_seconds = ? WHERE scope = 'global'`,
      '2026-01-15T11:54:00Z',
      360,
    );
  });
  const checkpoint = await runInDurableObject(outage.stub, (_i: HarnessDO, s: DurableObjectState) =>
    s.storage.sql
      .exec<{ connected: number; updated_at_ms: number }>(
        `SELECT connected, updated_at_ms FROM ingest_checkpoint WHERE stream = 'jetstream'`,
      )
      .one(),
  );
  expect(checkpoint).toEqual({ connected: 0, updated_at_ms: now - 360_000 });

  // Readiness is about storage, not the upstream: still 200.
  const readyRes = await call(ready, ctxFor(outage.index));
  expect(readyRes.status).toBe(200);
  expect(readyRes.body).toEqual({ status: 'ready' });
  expect(schemas.Ready(readyRes.body)).toBe('valid');

  // Meta keeps serving and reports the stale indexing truth verbatim.
  const metaRes = await call(meta, ctxFor(outage.index, { LEXICON_PREFIX: '' }));
  expect(metaRes.status).toBe(200);
  expect(schemas.Meta(metaRes.body)).toBe('valid');
  expect(metaRes.body).toEqual({
    name: 'atproto_music',
    version: APP_VERSION,
    stage: 'backend',
    capabilities: BASE_CAPS,
    lexiconPrefix: null,
    indexing: { state: 'stale', caughtUp: false, lastIndexedAt: '2026-01-15T11:54:00Z', lagSeconds: 360 },
  });
  expect(outage.state.readyCalls).toBe(2);
  expect(outage.local.calls.map((c) => c.method)).toEqual(['indexing']);
  expect(outage.local.networkAttempts).toEqual([]);
});
