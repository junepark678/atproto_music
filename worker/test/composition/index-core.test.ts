// N1-02 worker/src/app/index-core.ts: IndexCore, the host-neutral body of the
// index (ADR 0005 §2.2, §3.1, §3.3), on the Node host (ported by N4-03).
//
// - Read equivalence: the shared fixture is ingested through the production
//   Node composition (support.ts: compose over node:sqlite, the HTTP bridge,
//   the fixture transport). On the Node host there is no IndexDO: the
//   boundary every IndexRpc read crosses is its HTTP route (dispatcher, route
//   handler, DTO projection and JSON over the real listener), or for
//   adminStatus the production admin-socket handler. Each read method is
//   called directly on the composed app's IndexCore and through its route,
//   and the route's body must be the direct result under that route's
//   production projection (scrobbleDto, followToDto, the RecordStatus member
//   rules, the not_found envelope for null).
// - start(): a recording Host (a Db wrapper that logs every statement and two
//   recording alarm storages, all writing into one ordered event log) over
//   the harness database.
// - adminBackup without a backup port: `not_supported` and a byte-identical
//   database before and after.
// - Static: index-core.ts imports no cloudflare: module and no value from
//   env.ts and defines every name it took over from the Workers wrapper, and
//   index-do.ts (kept until N7-01) re-exports every one of them from
//   ../app/index-core. index-do.ts imports cloudflare:workers, so it is read
//   as source and checked by type (`import type`), never loaded on Node.

import type { Transport } from '@atmusic/atproto/transport';
import { fromMs } from '@atmusic/core/timestamp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CoreExtension, Host } from '../../src/app/host';
import hostSource from '../../src/app/host.ts?raw';
import * as coreModule from '../../src/app/index-core';
import { IndexCore } from '../../src/app/index-core';
import indexCoreSource from '../../src/app/index-core.ts?raw';
import servicesSource from '../../src/app/services.ts?raw';
import type { IndexRpc, LogLevel, ScrobbleRow } from '../../src/do/contracts';
import type { Db, SqlParam } from '../../src/do/db';
import type * as doModule from '../../src/do/index-do';
import indexDoSource from '../../src/do/index-do.ts?raw';
import { migrate } from '../../src/do/migrate';
import { followToDto } from '../../src/do/read/follows';
import { markConnected } from '../../src/do/status';
import { type AlarmStorage, nextDue, TIMER_NAMES } from '../../src/do/timers';
import { SOCKET_STATUS_PATH, socketAdminHandler } from '../../src/http/admin';
import { scrobbleDto } from '../../src/http/scrobbles-read';
import {
  ALICE,
  BOB,
  closeHarnesses,
  control,
  type Harness,
  type HttpResult,
  harness,
  ingestFixture,
  kitControl,
  resetControl,
  seedSnapshotJob,
  seedUser,
  T0,
  uriOf,
} from './support';

const DAVE = 'did:plc:dddddddddddddddddddddddd';

/** Which IndexRpc methods only read. Record<keyof IndexRpc, …>: a new method fails tsc until classified. */
const KIND: Record<keyof IndexRpc, 'read' | 'write'> = {
  ready: 'read',
  indexing: 'read',
  history: 'read',
  feed: 'read',
  lookup: 'read',
  recordStatus: 'read',
  stats: 'read',
  profile: 'read',
  following: 'read',
  followers: 'read',
  exportUser: 'read',
  resolveHandle: 'read',
  adminStatus: 'read',
  notify: 'write',
  ensureRunning: 'write',
  adminPitr: 'write',
  adminBackup: 'write',
};
const READ_METHODS = (Object.keys(KIND) as (keyof IndexRpc)[]).filter((m) => KIND[m] === 'read');

type Event = { kind: 'sql'; sql: string } | { kind: 'alarm'; lane: 'core' | 'extension'; at: number | null };

/** A Db wrapper that appends every statement to `events`. */
function recordingDb(inner: Db, events: Event[]): Db {
  const note = (sql: string) => events.push({ kind: 'sql', sql });
  return {
    all<T>(sql: string, ...p: SqlParam[]): T[] {
      note(sql);
      return inner.all<T>(sql, ...p);
    },
    one<T>(sql: string, ...p: SqlParam[]): T | null {
      note(sql);
      return inner.one<T>(sql, ...p);
    },
    run(sql: string, ...p: SqlParam[]) {
      note(sql);
      return inner.run(sql, ...p);
    },
    tx: (fn) => inner.tx(fn),
  };
}

function recordingAlarm(lane: 'core' | 'extension', events: Event[]): AlarmStorage {
  return {
    setAlarm(at: number | Date) {
      events.push({ kind: 'alarm', lane, at: typeof at === 'number' ? at : at.getTime() });
    },
    deleteAlarm() {
      events.push({ kind: 'alarm', lane, at: null });
    },
  };
}

/** The harness's dependencies (support.ts), as a Host over `db`. */
function testHost(db: Db, o: { alarm?: AlarmStorage; extensionAlarm?: AlarmStorage } = {}): Host {
  const transport: Transport & { fixture: true } = Object.assign((req: Request) => control.transport(req), {
    fixture: true as const,
  });
  const logs: Array<{ level: LogLevel; event: string }> = [];
  return {
    db,
    alarm: o.alarm ?? recordingAlarm('core', []),
    extensionAlarm: o.extensionAlarm ?? recordingAlarm('extension', []),
    connectJetstream: (url) => control.connectJetstream(url),
    transport,
    log: { log: (level, event) => logs.push({ level, event }) },
    clock: control.clock,
    random: control.random,
  };
}

/** A second IndexCore over the harness database, migrated (a no-op on the migrated file). */
function secondCore(h: Harness, host: Host = testHost(h.db), extensions: CoreExtension[] = []): IndexCore {
  const core = new IndexCore(h.config.app, host, extensions);
  core.markMigrated(migrate(h.db));
  return core;
}

beforeEach(() => {
  resetControl();
});
afterEach(closeHarnesses);

/** Every row of every table (sqlite_master order), for before/after comparisons. */
function dumpAll(db: Db): Record<string, unknown[]> {
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, db.all(`SELECT * FROM "${t}" ORDER BY rowid`)]));
}

it('every IndexRpc read method returns the same body through its HTTP or admin-socket route as through a direct IndexCore call over the same database', async () => {
  const kit = await kitControl();
  const h = await harness('core-reads');
  await ingestFixture(h, kit);
  const asOfNs = fromMs(control.clock.nowMs());
  const r01 = uriOf(ALICE, 'r01');
  const missing = uriOf(ALICE, 'zz-missing');
  const enc = encodeURIComponent;

  // The route side of each read, normalised to what the direct result determines: list
  // routes add a cursor and asOf, so they are compared as items + indexing + "more".
  type Seen = { status: number; body?: unknown; code?: string };
  const whole = (r: HttpResult): Seen => ({ status: r.status, body: r.body });
  const errorCode = (r: HttpResult): Seen => ({
    status: r.status,
    code: (r.body as { error?: { code?: string } } | null)?.error?.code,
  });
  const listView = (r: HttpResult): Seen => {
    const b = r.body as { items: unknown[]; nextCursor: unknown; indexing: unknown };
    return { status: r.status, body: { items: b.items, indexing: b.indexing, more: typeof b.nextCursor === 'string' } };
  };
  const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;
  const nullIs404 = (v: unknown, ok: (v: unknown) => Seen): Seen =>
    v === null ? { status: 404, code: 'not_found' } : ok(v);
  const rowsView = (map: (row: never) => unknown, limit: number) => (v: unknown) => {
    const r = v as { rows: never[]; hasMore: boolean; indexing: unknown };
    return {
      status: 200,
      body: { items: json(r.rows.slice(0, limit).map(map)), indexing: json(r.indexing), more: r.hasMore },
    };
  };
  const statusBody = (v: unknown) => {
    // RecordStatus (record-status.ts): cid and revision unless unknown, reason only when excluded.
    const s = v as { uri: string; state: string; cid?: string; revision?: string; reason?: string; indexing: unknown };
    const out: Record<string, unknown> = { uri: s.uri, state: s.state, indexing: s.indexing };
    if (s.state !== 'unknown') {
      if (s.cid !== undefined) out.cid = s.cid;
      if (s.revision !== undefined) out.revision = s.revision;
    }
    if (s.state === 'excluded' && s.reason !== undefined) out.reason = s.reason;
    return { status: 200, body: json(out) };
  };

  // The admin-socket route: the production handler over the composed IndexCore (the host
  // half of the status is empty here, so the body is the index half only).
  const socket = socketAdminHandler({
    index: h.core,
    hostStatus: () => ({}),
    pruneKid: () => ({ status: 'active_kid' }),
    random: control.random,
  });
  const viaSocket = async (path: string): Promise<HttpResult> => {
    const res = await socket(new Request(`http://admin.invalid${path}`));
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: JSON.parse(text) as unknown };
  };

  interface Case {
    method: keyof IndexRpc;
    args: unknown[];
    route: () => Promise<HttpResult>;
    seen: (r: HttpResult) => Seen;
    expected: (direct: unknown) => Seen;
  }
  const get = (target: string) => () => h.request(target);
  const cases: Case[] = [
    {
      method: 'ready',
      args: [],
      route: get('/health/ready'),
      seen: whole,
      expected: (v) =>
        (v as { status: string }).status === 'ready' ? { status: 200, body: { status: 'ready' } } : { status: 503 },
    },
    {
      method: 'indexing',
      args: [],
      route: get('/api/v1/meta'),
      seen: (r) => ({ status: r.status, body: (r.body as { indexing: unknown }).indexing }),
      expected: (v) => ({ status: 200, body: json(v) }),
    },
    {
      method: 'history',
      args: [{ did: ALICE, limit: 3 }],
      route: get(`/api/v1/users/${ALICE}/scrobbles?limit=3`),
      seen: listView,
      expected: rowsView(scrobbleDto as (row: never) => unknown, 3),
    },
    {
      method: 'history',
      args: [{ did: BOB, limit: 50 }],
      route: get(`/api/v1/users/${BOB}/scrobbles?limit=50`),
      seen: listView,
      expected: rowsView(scrobbleDto as (row: never) => unknown, 50),
    },
    {
      method: 'feed',
      args: [{ scope: 'global', limit: 5 }],
      route: get('/api/v1/feed?scope=global&limit=5'),
      seen: listView,
      expected: rowsView(scrobbleDto as (row: never) => unknown, 5),
    },
    {
      method: 'feed',
      args: [{ scope: 'following', viewer: ALICE, limit: 5 }],
      route: get(`/api/v1/feed?scope=following&viewer=${enc(ALICE)}&limit=5`),
      seen: listView,
      expected: rowsView(scrobbleDto as (row: never) => unknown, 5),
    },
    {
      method: 'lookup',
      args: [r01],
      route: get(`/api/v1/scrobbles/${enc(r01)}`),
      seen: whole,
      expected: (v) =>
        nullIs404(v, (row) => ({ status: 200, body: json({ scrobble: scrobbleDto(row as ScrobbleRow) }) })),
    },
    {
      method: 'lookup',
      args: [missing],
      route: get(`/api/v1/scrobbles/${enc(missing)}`),
      seen: errorCode,
      expected: (v) => nullIs404(v, () => ({ status: 200 })),
    },
    {
      method: 'recordStatus',
      args: [r01],
      route: get(`/api/v1/records/status?uri=${enc(r01)}`),
      seen: whole,
      expected: statusBody,
    },
    {
      method: 'recordStatus',
      args: [uriOf(DAVE, 'r01')],
      route: get(`/api/v1/records/status?uri=${enc(uriOf(DAVE, 'r01'))}`),
      seen: whole,
      expected: statusBody,
    },
    {
      method: 'stats',
      args: [{ did: ALICE, window: 'all', limit: 10, asOfNs }],
      route: get(`/api/v1/users/${ALICE}/stats?window=all&limit=10`),
      seen: whole,
      expected: (v) => nullIs404(v, (x) => ({ status: 200, body: json(x) })),
    },
    {
      method: 'stats',
      args: [{ did: ALICE, window: '7d', limit: 2, asOfNs }],
      route: get(`/api/v1/users/${ALICE}/stats?window=7d&limit=2`),
      seen: whole,
      expected: (v) => nullIs404(v, (x) => ({ status: 200, body: json(x) })),
    },
    {
      method: 'profile',
      args: [ALICE],
      route: get(`/api/v1/users/${ALICE}/profile`),
      seen: whole,
      expected: (v) => nullIs404(v, (x) => ({ status: 200, body: json(x) })),
    },
    {
      method: 'profile',
      args: [DAVE],
      route: get(`/api/v1/users/${DAVE}/profile`),
      seen: errorCode,
      expected: (v) => nullIs404(v, () => ({ status: 200 })),
    },
    {
      method: 'following',
      args: [{ did: ALICE, limit: 10 }],
      route: get(`/api/v1/users/${ALICE}/following?limit=10`),
      seen: listView,
      expected: rowsView(followToDto as (row: never) => unknown, 10),
    },
    {
      method: 'followers',
      args: [{ did: BOB, limit: 10 }],
      route: get(`/api/v1/users/${BOB}/followers?limit=10`),
      seen: listView,
      expected: rowsView(followToDto as (row: never) => unknown, 10),
    },
    {
      method: 'exportUser',
      args: [ALICE],
      route: get(`/api/v1/users/${ALICE}/export`),
      seen: whole,
      expected: (v) => nullIs404(v, (x) => ({ status: 200, body: json(x) })),
    },
    {
      method: 'exportUser',
      args: [DAVE],
      route: get(`/api/v1/users/${DAVE}/export`),
      seen: errorCode,
      expected: (v) => nullIs404(v, () => ({ status: 200 })),
    },
    {
      method: 'resolveHandle',
      args: ['alice.test'],
      route: get('/api/v1/resolve?handle=alice.test'),
      seen: whole,
      expected: (v) => {
        const o = v as { status: string; did?: string; handle?: string };
        return o.status === 'ok'
          ? { status: 200, body: { did: o.did, handle: o.handle, verified: true } }
          : { status: 0 };
      },
    },
    {
      method: 'adminStatus',
      args: [],
      route: () => viaSocket(SOCKET_STATUS_PATH),
      seen: whole,
      expected: (v) => ({ status: 200, body: json(v) }),
    },
  ];
  expect(new Set(cases.map((c) => c.method))).toEqual(new Set(READ_METHODS));

  const core = h.core as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const seen: Array<{ name: string; route: Seen; core: Seen }> = [];
  for (const c of cases) {
    const name = `${c.method}(${JSON.stringify(c.args, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))})`;
    const direct = await core[c.method]!(...c.args);
    const viaRoute = c.seen(await c.route());
    expect(viaRoute, name).toEqual(c.expected(direct));
    seen.push({ name, route: viaRoute, core: c.expected(direct) });
  }

  // The comparison is not vacuous: the bodies are real data, and a route answer is not
  // equal to the projection of a different direct call.
  const byName = (name: string) => seen.find((x) => x.name.startsWith(name)) as (typeof seen)[number];
  const alicePage = byName('history([{"did":"did:plc:aaaa').route.body as { items: unknown[]; more: boolean };
  expect(alicePage.items).toHaveLength(3);
  expect(alicePage.more).toBe(true);
  expect(byName('lookup(["at://did:plc:aaaa').route.body).toMatchObject({
    scrobble: { uri: r01, did: ALICE, track: 'Jóga' },
  });
  expect(byName('resolveHandle').route).toEqual({
    status: 200,
    body: { did: ALICE, handle: 'alice.test', verified: true },
  });
  expect(
    (byName('stats([{"did":"did:plc:aaaa').route.body as { totalScrobbles: number }).totalScrobbles,
  ).toBeGreaterThan(0);
  expect(byName('profile(["did:plc:dddd').route).toEqual({ status: 404, code: 'not_found' });
  expect((byName('following').route.body as { items: unknown[] }).items.length).toBeGreaterThan(0);
  const bobPage = rowsView(scrobbleDto as (row: never) => unknown, 50)(await h.core.history({ did: BOB, limit: 50 }));
  expect((bobPage.body.items as unknown[]).length).toBeGreaterThan(0);
  expect(listView(await h.request(`/api/v1/users/${ALICE}/scrobbles?limit=50`))).not.toEqual(bobPage);

  // Argument errors: the route refuses before the core is called (422), and the core
  // itself rejects the same out-of-range limit.
  const bad = await h.request(`/api/v1/users/${ALICE}/scrobbles?limit=0`);
  expect(errorCode(bad)).toEqual({ status: 422, code: 'validation_failed' });
  const rejected = await h.core.history({ did: ALICE, limit: 0 }).then(
    () => null,
    (e: Error) => e.name,
  );
  expect(rejected).not.toBeNull();
});

it('IndexCore.start() calls noteRestart, lease reclaim, ensureTimers and armAlarm in that order on a recording host', async () => {
  const h = await harness('core-start');
  expect((await h.request('/health/ready')).status).toBe(200);
  const db = h.db;
  // What a previous process left behind: an open socket and two running leases.
  db.run('DELETE FROM timers');
  db.tx(() => markConnected(db, T0 - 60_000));
  const gen = seedUser(db, ALICE);
  seedSnapshotJob(db, ALICE, gen);
  db.run(
    `INSERT INTO repo_jobs(did, kind, state, generation, reactivate, due_at, updated_at_ms)
       VALUES (?, 'status', 'running', ?, 0, ?, ?)`,
    BOB,
    gen,
    T0,
    T0,
  );

  const events: Event[] = [];
  const host = testHost(recordingDb(db, events), {
    alarm: recordingAlarm('core', events),
    extensionAlarm: recordingAlarm('extension', events),
  });
  const seeded: number[] = [];
  const outbox: CoreExtension = {
    name: 'outbox',
    timers: { outbox: async () => {} },
    start(ctx, now) {
      seeded.push(now);
      ctx.schedule('outbox', now + 30_000);
    },
  };
  const core = new IndexCore(h.config.app, host, [outbox]);
  core.markMigrated(migrate(db));
  expect(events).toEqual([]);
  core.start();

  const first = (test: (e: Event) => boolean) => events.findIndex(test);
  const sql = (re: RegExp) => (e: Event) => e.kind === 'sql' && re.test(e.sql);
  const s = {
    noteRestart: first(sql(/UPDATE ingest_checkpoint SET connected = 0/)),
    reclaimSnapshot: first(sql(/UPDATE repo_jobs SET state = 'pending'[\s\S]*kind = 'snapshot' AND state = 'running'/)),
    reclaimStatus: first(sql(/UPDATE repo_jobs SET state = 'pending'[\s\S]*kind = 'status' AND state = 'running'/)),
    ensureTimers: first(sql(/INSERT INTO timers/)),
    armCore: first((e) => e.kind === 'alarm' && e.lane === 'core'),
    armExtension: first((e) => e.kind === 'alarm' && e.lane === 'extension'),
  };
  for (const [name, index] of Object.entries(s)) expect(index, name).toBeGreaterThanOrEqual(0);
  expect(s.noteRestart).toBeLessThan(s.reclaimSnapshot);
  expect(s.reclaimSnapshot).toBeLessThan(s.reclaimStatus);
  expect(s.reclaimStatus).toBeLessThan(s.ensureTimers);
  expect(s.ensureTimers).toBeLessThan(s.armCore);
  expect(s.armCore).toBeLessThan(s.armExtension);

  // Observable outcomes of each step.
  const alarms = events.filter((e) => e.kind === 'alarm');
  expect(db.one("SELECT connected FROM ingest_checkpoint WHERE stream = 'jetstream'")).toEqual({ connected: 0 });
  expect(db.all('SELECT did, kind, state FROM repo_jobs ORDER BY kind, did')).toEqual([
    { did: ALICE, kind: 'snapshot', state: 'pending' },
    { did: BOB, kind: 'status', state: 'pending' },
  ]);
  const timers = db.all<{ name: string }>('SELECT name FROM timers ORDER BY name').map((r) => r.name);
  expect(timers).toEqual(expect.arrayContaining(['discovery', 'gc', 'identity-sweep', 'status-sweep', 'outbox']));
  expect(timers.every((n) => (TIMER_NAMES as readonly string[]).includes(n) || n === 'outbox')).toBe(true);
  // Each lane is armed at its own minimum: the core alarm first, then the extension alarm.
  expect(alarms[0]).toEqual({ kind: 'alarm', lane: 'core', at: nextDue(db) });
  expect(alarms.at(-1)).toEqual({ kind: 'alarm', lane: 'extension', at: T0 + 30_000 });
  expect(alarms.filter((e) => e.kind === 'alarm' && e.lane === 'core')).toHaveLength(1);
  expect(seeded).toEqual([T0]);
  expect(db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name = 'outbox'")?.due_at).toBe(T0 + 30_000);
});

it('adminBackup on a host without a backup port answers not_supported and changes nothing', async () => {
  const h = await harness('core-backup');
  expect((await h.request('/health/ready')).status).toBe(200);
  // Through the composed app's IndexCore (compose was given no backup port).
  const before = dumpAll(h.db);
  expect(Object.keys(before)).toEqual(expect.arrayContaining(['timers', 'counters', 'ingest_checkpoint']));
  expect(await h.core.adminBackup()).toEqual({ status: 'not_supported' });
  expect(dumpAll(h.db)).toEqual(before);

  // On an IndexCore over a recording host: no statement beyond the dump, no alarm, no log.
  const events: Event[] = [];
  const host = testHost(recordingDb(h.db, events), {
    alarm: recordingAlarm('core', events),
    extensionAlarm: recordingAlarm('extension', events),
  });
  const logged: string[] = [];
  host.log = { log: (_level, event) => logged.push(event) };
  const recorded = secondCore(h, host);
  const pre = dumpAll(h.db);
  const outcome = await recorded.adminBackup();
  expect({ outcome, events, logged, same: JSON.stringify(dumpAll(h.db)) === JSON.stringify(pre) }).toEqual({
    outcome: { status: 'not_supported' },
    events: [],
    logged: [],
    same: true,
  });

  // With a backup port the call reaches it once, as a manual backup.
  const seen: string[] = [];
  const withPort = testHost(h.db);
  withPort.backup = {
    async run(kind) {
      seen.push(kind);
      return { status: 'ok', kind, path: '/backups/x.db', bytes: 1, startedAtMs: T0, finishedAtMs: T0 };
    },
  };
  expect({ outcome: await secondCore(h, withPort).adminBackup(), seen }).toEqual({
    outcome: { status: 'ok', kind: 'manual', path: '/backups/x.db', bytes: 1, startedAtMs: T0, finishedAtMs: T0 },
    seen: ['manual'],
  });

  // adminPitr on a host without a PITR port is not_supported too (rejects, nothing scheduled).
  const pitr = await secondCore(h)
    .adminPitr(T0 - 1_000)
    .then(
      () => null,
      (e: Error) => ({ name: e.name, message: e.message }),
    );
  expect(pitr).toEqual({
    name: 'NotSupportedError',
    message: 'not_supported: this host has no point-in-time restore',
  });
  expect(dumpAll(h.db)).toEqual(before);
});

it('app/index-core.ts imports no cloudflare: module and no value from env.ts, and index-do.ts re-exports every name it moved', () => {
  const importsOf = (source: string) =>
    [...source.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)';/gm)].map((m) => ({
      typeOnly: m[2] !== undefined,
      clause: m[3] as string,
      from: m[4] as string,
    }));
  for (const [file, source] of [
    ['app/index-core.ts', indexCoreSource],
    ['app/host.ts', hostSource],
    ['app/services.ts', servicesSource],
  ] as const) {
    const imports = importsOf(source);
    expect(
      imports.filter((i) => i.from.startsWith('cloudflare:')),
      file,
    ).toEqual([]);
    expect(source, file).not.toMatch(/['"]cloudflare:/);
    expect(source, file).not.toMatch(/\bimport\s*\(/);
    // env.ts only through `import type`.
    expect(
      imports.filter((i) => /(^|\/)env$/.test(i.from) && !i.typeOnly),
      file,
    ).toEqual([]);
  }
  // Non-vacuity: the parser does see index-core's imports, including its type-only config import.
  const coreImports = importsOf(indexCoreSource);
  expect(coreImports.length).toBeGreaterThan(20);
  expect(coreImports).toContainEqual({ typeOnly: true, clause: '{ AppConfig }', from: '../config' });
  // The Workers wrapper is still the Workers wrapper (and so is never loaded here).
  expect(importsOf(indexDoSource).some((i) => i.from === 'cloudflare:workers')).toBe(true);

  const MOVED_VALUES = [
    'envLogger',
    'createLogger',
    'INDEX_NAME',
    'GC_INTERVAL_MS',
    'GC_BLOCK_DIDS_PER_RUN',
    'GC_HINTS_PER_RUN',
    'HINT_ERROR_RETENTION_MS',
    'HINT_EXPIRED_REASON',
    'HINT_EXPIRED_COUNTER',
    'ALARM_SLICE_MS',
    'PITR_WINDOW_MS',
    'PITR_RESTART_DELAY_MS',
    'ADMIN_RESNAPSHOT_REASON',
    'NotReadyError',
    'IndexError',
    'INDEX_ERROR_NAME',
    'INDEX_ERROR_MESSAGE',
    'runGc',
  ] as const;
  const MOVED_TYPES = ['LogSink', 'IndexDeps', 'GcReport'] as const;
  const core = coreModule as unknown as Record<string, unknown>;
  for (const name of MOVED_VALUES) {
    expect(core[name], name).toBeDefined();
    // Defined in index-core.ts itself, not re-exported from elsewhere, and not in index-do.ts.
    const definition = new RegExp(`export\\s+(?:const|function|class|async function)\\s+${name}\\b`);
    expect(indexCoreSource, name).toMatch(definition);
    expect(indexDoSource, name).not.toMatch(definition);
  }
  for (const name of MOVED_TYPES) {
    expect(indexCoreSource, name).toMatch(new RegExp(`export\\s+interface\\s+${name}\\b`));
    expect(indexDoSource, name).not.toMatch(new RegExp(`(?:interface|type)\\s+${name}\\b\\s*[={<]`));
  }
  // index-do.ts re-exports every moved name from ../app/index-core in one export clause.
  const reexport = /export\s*\{([\s\S]*?)\}\s*from\s*'\.\.\/app\/index-core';/.exec(indexDoSource);
  expect(reexport).not.toBeNull();
  const reexported = new Set(
    (reexport?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^type\s+/, ''))
      .filter((s) => s.length > 0),
  );
  expect(reexported.size).toBeGreaterThanOrEqual(MOVED_VALUES.length + MOVED_TYPES.length);
  for (const name of [...MOVED_VALUES, ...MOVED_TYPES]) expect([name, reexported.has(name)]).toEqual([name, true]);
  // Non-vacuity: the parser finds no clause in a source without one, and a dropped name is seen.
  expect(/export\s*\{([\s\S]*?)\}\s*from\s*'\.\.\/app\/index-core';/.exec(indexCoreSource)).toBeNull();
  const dropped = indexDoSource.replace(/^\s*runGc,\n/m, '');
  expect(dropped).not.toBe(indexDoSource);
  const droppedClause = /export\s*\{([\s\S]*?)\}\s*from\s*'\.\.\/app\/index-core';/.exec(dropped)?.[1] ?? '';
  expect(droppedClause.split(',').map((x) => x.trim())).not.toContain('runGc');
  // The error constants still describe the class.
  const error = new coreModule.IndexError();
  expect([error.name, error.message]).toEqual([coreModule.INDEX_ERROR_NAME, coreModule.INDEX_ERROR_MESSAGE]);
  // Compile-time: the moved types resolve from index-core.ts and through index-do.ts, and every
  // moved value is exported by index-do.ts with index-core's type (tsc -b checks this file).
  const deps: coreModule.IndexDeps | null = null;
  const sink: coreModule.LogSink | null = null;
  const report: coreModule.GcReport | null = null;
  const viaDoDeps: doModule.IndexDeps | null = deps;
  const viaDoSink: doModule.LogSink | null = sink;
  const viaDoReport: doModule.GcReport | null = report;
  const viaDo: Pick<typeof doModule, (typeof MOVED_VALUES)[number]> = coreModule;
  expect([viaDoDeps, viaDoSink, viaDoReport]).toEqual([null, null, null]);
  expect(Object.keys(viaDo).length).toBeGreaterThanOrEqual(MOVED_VALUES.length);
});
