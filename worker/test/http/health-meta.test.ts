// GET /health/live, GET /health/ready and GET /api/v1/meta against real
// storage on the Node host (M1.4.2 ready_before_storage / upstream_outage,
// M1.2.3 packaged_http, M6.1.3 fresh_install, M6.2.2 upstream_offline, A20,
// ADR 0005 B14/B18; N4-01).
//
// Every composed app here is the production process run in-process
// (test/node/journey/world.ts: node/run.ts run() with the production feature
// list over a temporary SQLite file, the fixture network, the frozen clock and
// manual timers). The answers are checked over HTTP through the real bridge
// and dispatcher, and the route handlers are also called directly with a
// RequestCtx over the composed IndexCore and AppServices, for the namespace
// matrix. Expected capabilities and stage are derived from the composed
// `ctx.app` (its `meta` service, node/features.ts), never fixed: the v1.1
// set, `publication` for an owned prefix with evidence only, then the v1.2
// capabilities the composition initialised.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ACCOUNT_CAPABILITIES, type Indexing } from '@atmusic/core/api-types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import type { AppServices } from '../../src/app/services';
import { ConfigError, FIXTURE_PREFIX, parseConfig } from '../../src/config';
import type { IndexRpc } from '../../src/do/contracts';
import { migrate } from '../../src/do/migrate';
import { MIGRATIONS } from '../../src/do/schema';
import type { EnvVars } from '../../src/env';
import { routes as healthRoutes } from '../../src/http/health';
import { APP_VERSION, routes as metaRoutes, namespaceView } from '../../src/http/meta';
import type { AppEnv, RequestCtx, RouteDef } from '../../src/http/types';
import { openSqliteDb } from '../../src/node/sqlite-db';
import { closeWorlds, T0, World } from '../node/journey/world';
import { TEST_BUSY_TIMEOUT_MS } from '../node/support/node-db';

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
const OWNED_ENV = { LEXICON_PREFIX: OWNED, NAMESPACE_OWNERSHIP_REF: 'dns:_lexicon.music.example.org' };
/** The harness namespace: the fixture prefix, no ownership evidence (wrangler.harness.jsonc). */
const FIXTURE_ENV = { LEXICON_PREFIX: FIXTURE_PREFIX, NAMESPACE_OWNERSHIP_REF: '' };

/** The Workers-era variables parseConfig reads (wrangler.harness.jsonc). */
const VARS: EnvVars = {
  PUBLIC_ORIGIN: 'https://music.example.test',
  LEXICON_PREFIX: FIXTURE_PREFIX,
  NAMESPACE_OWNERSHIP_REF: '',
  INGEST_MODE: 'off',
  JETSTREAM_URLS: 'wss://jetstream.example.test',
  JETSTREAM_LOOKBACK_HOURS: '24',
  RELAY_URL: 'https://relay.example.test',
  PLAN: 'paid',
  DO_LOCATION_HINT: '',
} as EnvVars;

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
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await closeWorlds();
  vi.useRealTimers();
});

/** A RequestCtx over a composed index and services, with the namespace variables `vars`. */
function ctxFor(index: IndexRpc, vars: Partial<AppEnv> = {}, app?: AppServices): RequestCtx {
  return {
    env: {
      LEXICON_PREFIX: vars.LEXICON_PREFIX ?? FIXTURE_ENV.LEXICON_PREFIX,
      NAMESPACE_OWNERSHIP_REF: vars.NAMESPACE_OWNERSHIP_REF ?? FIXTURE_ENV.NAMESPACE_OWNERSHIP_REF,
    },
    index,
    requestId: REQUEST_ID,
    clock: fixedClock(),
    cursorKey,
    clientIp: '203.0.113.7',
    ...(app === undefined ? {} : { app }),
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

/** An IndexRpc that delegates to `index` and records every method called. */
function counting(index: IndexRpc): { index: IndexRpc; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(index, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { index: proxy, calls };
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

/** What meta must answer for `vars` over the composed services `app` (module comment). */
function expectedMeta(vars: Partial<AppEnv>, app: AppServices | undefined) {
  const namespace = namespaceView({
    LEXICON_PREFIX: vars.LEXICON_PREFIX ?? FIXTURE_ENV.LEXICON_PREFIX,
    NAMESPACE_OWNERSHIP_REF: vars.NAMESPACE_OWNERSHIP_REF ?? FIXTURE_ENV.NAMESPACE_OWNERSHIP_REF,
  });
  const composed = app?.meta?.capabilities;
  const capabilities = [
    ...BASE_CAPS,
    ...(namespace.publication ? ['publication'] : []),
    ...ACCOUNT_CAPABILITIES.filter((c) => composed?.includes(c) === true),
  ];
  const writes = composed === undefined ? namespace.publication : composed.includes('writes');
  return { capabilities, stage: writes ? 'product' : 'backend', lexiconPrefix: namespace.prefix };
}

/** A started world (the production process) with `env`; `prepare` runs on the database file first. */
async function world(env: Record<string, string>, prepare?: (path: string) => void): Promise<World> {
  const w = new World({ env });
  if (prepare !== undefined) {
    mkdirSync(dirname(w.dbPath), { recursive: true });
    prepare(w.dbPath);
  }
  await w.start();
  return w;
}

const live = route(healthRoutes, '/health/live');
const ready = route(healthRoutes, '/health/ready');
const meta = route(metaRoutes, '/api/v1/meta');

it('live 200; ready 503 when index reports too_new; meta capabilities omit publication without owned prefix', async () => {
  expect(healthRoutes.map((r) => `${r.method} ${r.pattern}`)).toEqual(['GET /health/live', 'GET /health/ready']);
  expect(metaRoutes.map((r) => `${r.method} ${r.pattern}`)).toEqual(['GET /api/v1/meta']);

  // Live is local: 200 {status:'live'} with no index call at all.
  const untouched = untouchableIndex();
  const liveRes = await call(live, ctxFor(untouched.index));
  expect(liveRes.status).toBe(200);
  expect(liveRes.body).toEqual({ status: 'live' });
  expect(schemas.Live(liveRes.body)).toBe('valid');
  expect(liveRes.res.headers.get('content-type')).toBe('application/json');
  expect(untouched.calls).toEqual([]);

  // A fresh install: run() creates and migrates the database before it listens; it is ready.
  const fresh = await world(FIXTURE_ENV);
  const liveHttp = await fresh.send('GET', '/health/live');
  expect(liveHttp.status).toBe(200);
  expect(liveHttp.body).toEqual({ status: 'live' });
  const readyHttp = await fresh.send('GET', '/health/ready');
  expect(readyHttp.status).toBe(200);
  expect(readyHttp.body).toEqual({ status: 'ready' });
  expect(schemas.Ready(readyHttp.body)).toBe('valid');
  const freshIndex = counting(fresh.core);
  const readyRes = await call(ready, ctxFor(freshIndex.index));
  expect(readyRes.status).toBe(200);
  expect(readyRes.body).toEqual({ status: 'ready' });
  expect(freshIndex.calls).toEqual(['ready']);

  // Storage written by newer, incompatible code (ADR 0005 §3.2: its
  // schema_compat.min_compatible_version is above this code's latest): run()
  // leaves it untouched, the index reports too_new, and ready is 503.
  const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  const future = await world(OWNED_ENV, (path) => {
    const db = openSqliteDb(path, { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS, create: true });
    expect(migrate(db).status).toBe('ready');
    db.run('INSERT INTO schema_migrations(version, name) VALUES (?, ?)', latest + 1, 'from-newer-code');
    db.run('UPDATE schema_compat SET min_compatible_version = ?', latest + 1);
    db.close();
  });
  expect((await future.core.ready()).status).toBe('too_new');
  const tooNewHttp = await future.send('GET', '/health/ready');
  expect(tooNewHttp.status).toBe(503);
  expect(tooNewHttp.headers.get('cache-control')).toBe('no-store');
  expect(schemas.Error(tooNewHttp.body)).toBe('valid');
  expect((tooNewHttp.body as { error: { code: string; message: string } }).error).toMatchObject({
    code: 'not_ready',
    message: 'Index storage is not initialized.',
  });
  const futureIndex = counting(future.core);
  const tooNew = await call(ready, ctxFor(futureIndex.index));
  expect(tooNew.status).toBe(503);
  expect(tooNew.body).toEqual({
    error: { code: 'not_ready', message: 'Index storage is not initialized.', requestId: REQUEST_ID },
  });
  expect(futureIndex.calls).toEqual(['ready']);
  const ledger = future.db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
  expect(ledger.map((r) => r.version)).toEqual([...MIGRATIONS.map((m) => m.version), latest + 1]);

  // An index that cannot answer is not ready either (503, not 500).
  const failing = untouchableIndex();
  const unavailable = await call(ready, ctxFor(failing.index));
  expect(unavailable.status).toBe(503);
  expect((unavailable.body as { error: { code: string } }).error.code).toBe('not_ready');
  expect(failing.calls).toEqual(['ready']);

  // Meta over too_new storage: scaffold, no capabilities, honest recovering, no indexing read.
  const scaffoldHttp = await future.send('GET', '/api/v1/meta');
  expect(scaffoldHttp.status).toBe(200);
  expect(schemas.Meta(scaffoldHttp.body)).toBe('valid');
  expect(scaffoldHttp.body).toEqual({
    name: 'atproto_music',
    version: APP_VERSION,
    stage: 'scaffold',
    capabilities: [],
    lexiconPrefix: OWNED,
    indexing: { state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: null },
  });
  const scaffoldIndex = counting(future.core);
  const scaffold = await call(meta, ctxFor(scaffoldIndex.index, OWNED_ENV, future.server.app.app));
  expect(scaffold.body).toEqual(scaffoldHttp.body);
  expect(scaffoldIndex.calls).toEqual(['ready']);

  // The composed services of the fresh (fixture-prefix) process: the v1.2 capabilities it initialised.
  const app = fresh.server.app.app;
  expect(app.meta?.capabilities).toEqual(['lastfm', 'listenbrainz', 'imports', 'forwarding']);
  const seeded: Indexing = await fresh.core.indexing();
  const metaFor = async (vars: Partial<AppEnv>) => {
    const counted = counting(fresh.core);
    const res = await call(meta, ctxFor(counted.index, vars, app));
    expect(res.status).toBe(200);
    expect(res.res.headers.get('cache-control')).toBe('no-store');
    expect(schemas.Meta(res.body)).toBe('valid');
    expect(counted.calls).toEqual(['ready', 'indexing']);
    return res.body as { capabilities: string[]; lexiconPrefix: string | null; stage: string; indexing: Indexing };
  };

  // Gate closed (empty prefix): no publication, lexiconPrefix null.
  const closed = await metaFor({ LEXICON_PREFIX: '' });
  expect(closed).toEqual({
    name: 'atproto_music',
    version: '0.1.0',
    ...expectedMeta({ LEXICON_PREFIX: '' }, app),
    indexing: seeded,
  });
  expect(closed.capabilities).not.toContain('publication');
  expect(closed.lexiconPrefix).toBeNull();

  // An owned prefix without ownership evidence: still no publication.
  const unproven = await metaFor({ LEXICON_PREFIX: OWNED, NAMESPACE_OWNERSHIP_REF: '' });
  expect(unproven).toMatchObject(expectedMeta({ LEXICON_PREFIX: OWNED, NAMESPACE_OWNERSHIP_REF: '' }, app));
  expect(unproven.capabilities).not.toContain('publication');
  expect(unproven.lexiconPrefix).toBe(OWNED);

  // The harness namespace over HTTP, through the dispatcher of the running process: the fixture prefix
  // is reported and never publishes; the stage is backend because this composition does not write.
  const harnessHttp = await fresh.send('GET', '/api/v1/meta');
  expect(harnessHttp.status).toBe(200);
  expect(harnessHttp.headers.get('cache-control')).toBe('no-store');
  expect(schemas.Meta(harnessHttp.body)).toBe('valid');
  expect(harnessHttp.body).toEqual({
    name: 'atproto_music',
    version: APP_VERSION,
    ...expectedMeta(FIXTURE_ENV, app),
    indexing: seeded,
  });
  expect((harnessHttp.body as { stage: string }).stage).toBe('backend');
  expect((harnessHttp.body as { capabilities: string[] }).capabilities).not.toContain('publication');
  // Even with ownership evidence beside it (which parseConfig refuses), the fixture prefix never publishes.
  const fixture = await metaFor({ LEXICON_PREFIX: FIXTURE_PREFIX, NAMESPACE_OWNERSHIP_REF: 'dns:txt' });
  expect(fixture.capabilities).not.toContain('publication');
  expect(fixture.lexiconPrefix).toBe(FIXTURE_PREFIX);
  expect(fixture).toMatchObject(
    expectedMeta({ LEXICON_PREFIX: FIXTURE_PREFIX, NAMESPACE_OWNERSHIP_REF: 'dns:txt' }, app),
  );

  // Positive control: an owned prefix plus evidence is the only way publication appears; that process
  // also writes, so its stage is product.
  const owned = await world({ ...OWNED_ENV, ATMUSIC_SIGNIN_DIDS: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' });
  const ownedApp = owned.server.app.app;
  expect(ownedApp.meta?.capabilities).toEqual(['writes', 'lastfm', 'listenbrainz', 'imports', 'forwarding']);
  const ownedHttp = await owned.send('GET', '/api/v1/meta');
  expect(schemas.Meta(ownedHttp.body)).toBe('valid');
  expect(ownedHttp.body).toMatchObject(expectedMeta(OWNED_ENV, ownedApp));
  expect((ownedHttp.body as { capabilities: string[] }).capabilities).toEqual([
    ...BASE_CAPS,
    'publication',
    ...(ownedApp.meta?.capabilities ?? []),
  ]);
  expect((ownedHttp.body as { stage: string }).stage).toBe('product');
  // The same namespace without the composition's services keeps the ADR 0004 rule (Workers entry).
  const workers = await call(meta, ctxFor(owned.core, OWNED_ENV));
  expect(workers.body).toMatchObject({ capabilities: [...BASE_CAPS, 'publication'], stage: 'product' });
}, 60_000);

it('ready 200 and meta indexing stale while the index reports the socket disconnected', async () => {
  const outage = await world({ ...FIXTURE_ENV, INGEST_MODE: 'socket' });
  const now = outage.clock.nowMs();

  // The socket dropped six minutes ago, right after its last event; the last record was indexed then.
  // Nothing marks the index stale by hand: the index derives `stale` from the disconnected socket.
  outage.db.run(
    `UPDATE ingest_checkpoint SET connected = 0, mode = 'socket', updated_at_ms = ?, connected_at_ms = ?,
       cursor = 41, last_event_time_us = ? WHERE stream = 'jetstream'`,
    now - 6 * 60_000,
    now - 60 * 60_000,
    (now - 6 * 60_000) * 1000,
  );
  outage.db.run(`UPDATE indexing_status SET last_indexed_at = ? WHERE scope = 'global'`, '2026-01-15T11:54:00Z');
  const checkpoint = outage.db.one<{ connected: number; updated_at_ms: number }>(
    `SELECT connected, updated_at_ms FROM ingest_checkpoint WHERE stream = 'jetstream'`,
  );
  expect(checkpoint).toEqual({ connected: 0, updated_at_ms: now - 360_000 });

  // Readiness is about storage, not the upstream: still 200 (the composition's probes and the index's).
  const readyHttp = await outage.send('GET', '/health/ready');
  expect(readyHttp.status).toBe(200);
  expect(readyHttp.body).toEqual({ status: 'ready' });
  expect(schemas.Ready(readyHttp.body)).toBe('valid');
  const counted = counting(outage.core);
  const readyRes = await call(ready, ctxFor(counted.index));
  expect(readyRes.status).toBe(200);
  expect(readyRes.body).toEqual({ status: 'ready' });

  // Meta keeps serving and reports the stale indexing truth verbatim, with the composition's capabilities.
  const app = outage.server.app.app;
  const stale = { state: 'stale', caughtUp: false, lastIndexedAt: '2026-01-15T11:54:00.000000000Z', lagSeconds: 360 };
  const metaHttp = await outage.send('GET', '/api/v1/meta');
  expect(metaHttp.status).toBe(200);
  expect(schemas.Meta(metaHttp.body)).toBe('valid');
  expect(metaHttp.body).toEqual({
    name: 'atproto_music',
    version: APP_VERSION,
    ...expectedMeta(FIXTURE_ENV, app),
    indexing: stale,
  });
  const metaRes = await call(meta, ctxFor(counted.index, { LEXICON_PREFIX: '' }, app));
  expect(metaRes.status).toBe(200);
  expect(schemas.Meta(metaRes.body)).toBe('valid');
  expect(metaRes.body).toEqual({
    name: 'atproto_music',
    version: APP_VERSION,
    ...expectedMeta({ LEXICON_PREFIX: '' }, app),
    indexing: stale,
  });
  expect(counted.calls).toEqual(['ready', 'ready', 'indexing']);
  // Nothing of this reached the network: the process made no outbound request at all.
  expect(outage.outbound).toEqual([]);
}, 60_000);

it('meta namespace equals the prefix and publication of every config parseConfig accepts for the env', async () => {
  // The route never parses config itself (the composition does, strictly in production), so for every
  // env either parse mode accepts, the route must report exactly that config's namespace.
  const prefixes = ['', '  ', OWNED, ` ${OWNED} `, FIXTURE_PREFIX, 'Org.Example.Music', 'nodots', 'org..music'];
  const refs = ['', ' ', 'dns:_lexicon.music.example.org'];
  let accepted = 0;
  let refused = 0;
  for (const LEXICON_PREFIX of prefixes) {
    for (const NAMESPACE_OWNERSHIP_REF of refs) {
      const vars = { ...VARS, LEXICON_PREFIX, NAMESPACE_OWNERSHIP_REF };
      for (const allowFixturePrefix of [false, true]) {
        let config: ReturnType<typeof parseConfig>;
        try {
          config = parseConfig(vars, { allowFixturePrefix });
        } catch (e) {
          expect(e).toBeInstanceOf(ConfigError);
          refused++;
          continue;
        }
        accepted++;
        expect(namespaceView(vars), `${LEXICON_PREFIX}|${NAMESPACE_OWNERSHIP_REF}|${allowFixturePrefix}`).toEqual({
          prefix: config.prefix,
          publication: config.publication,
        });
      }
      // The fixture prefix never publishes, whatever sits beside it.
      if (LEXICON_PREFIX.trim() === FIXTURE_PREFIX) expect(namespaceView(vars).publication).toBe(false);
    }
  }
  expect(accepted).toBe(22);
  expect(refused).toBe(26);
  // An invalid prefix fails every parse (so the process cannot start and meta is never served) and is never reported.
  for (const bad of ['Org.Example.Music', 'nodots', 'org..music']) {
    expect(namespaceView({ LEXICON_PREFIX: bad, NAMESPACE_OWNERSHIP_REF: 'dns:txt' })).toEqual({
      prefix: null,
      publication: false,
    });
  }

  // Over the route against real storage and the composed services: the same envs give the same
  // lexiconPrefix, and the capabilities and stage the composition's `meta` service implies.
  const store = await world(FIXTURE_ENV);
  const app = store.server.app.app;
  const expectations: Array<[Partial<AppEnv>, string | null, boolean]> = [
    [{ LEXICON_PREFIX: '' }, null, false],
    [{ LEXICON_PREFIX: FIXTURE_PREFIX, NAMESPACE_OWNERSHIP_REF: '' }, FIXTURE_PREFIX, false],
    [{ LEXICON_PREFIX: OWNED, NAMESPACE_OWNERSHIP_REF: '' }, OWNED, false],
    [{ LEXICON_PREFIX: ` ${OWNED} `, NAMESPACE_OWNERSHIP_REF: 'dns:txt' }, OWNED, true],
  ];
  const counted = counting(store.core);
  for (const [vars, prefix, publication] of expectations) {
    const res = await call(meta, ctxFor(counted.index, vars, app));
    expect(res.status).toBe(200);
    expect(schemas.Meta(res.body)).toBe('valid');
    const body = res.body as { lexiconPrefix: string | null; capabilities: string[]; stage: string };
    expect(body.lexiconPrefix).toBe(prefix);
    expect(body.capabilities.includes('publication')).toBe(publication);
    const want = expectedMeta(vars, app);
    expect(body.capabilities).toEqual(want.capabilities);
    expect(body.stage).toBe(want.stage);
  }
  expect(counted.calls).toEqual(expectations.flatMap(() => ['ready', 'indexing']));
}, 60_000);
