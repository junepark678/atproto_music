// N1-02 worker/src/app/index-core.ts: IndexCore, the host-neutral body of the
// index (ADR 0005 §2.2, §3.1, §3.3), on the Node host (ported by N4-03).
//
// - Read equivalence: the shared fixture is ingested through the production
//   Node composition (support.ts: compose over node:sqlite, the HTTP bridge,
//   the fixture transport), then every IndexRpc read method is called once on
//   the composed app's IndexCore (what every route's ctx.index is) and once on
//   a second IndexCore built over the same database file with test
//   dependencies; the bodies must be equal.
// - start(): a recording Host (a Db wrapper that logs every statement and two
//   recording alarm storages, all writing into one ordered event log) over
//   the harness database.
// - adminBackup without a backup port: `not_supported` and a byte-identical
//   database before and after.
// - Static: index-core.ts imports no cloudflare: module and no value from
//   env.ts, and defines every name it took over from the Workers wrapper.

import type { Transport } from '@atmusic/atproto/transport';
import { fromMs } from '@atmusic/core/timestamp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CoreExtension, Host } from '../../src/app/host';
import hostSource from '../../src/app/host.ts?raw';
import * as coreModule from '../../src/app/index-core';
import { IndexCore } from '../../src/app/index-core';
import indexCoreSource from '../../src/app/index-core.ts?raw';
import servicesSource from '../../src/app/services.ts?raw';
import type { IndexRpc, LogLevel } from '../../src/do/contracts';
import type { Db, SqlParam } from '../../src/do/db';
import { migrate } from '../../src/do/migrate';
import { markConnected } from '../../src/do/status';
import { type AlarmStorage, nextDue, TIMER_NAMES } from '../../src/do/timers';
import {
  ALICE,
  BOB,
  closeHarnesses,
  control,
  type Harness,
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

it("every IndexRpc read method returns the same body through the composed app's IndexCore as through a second IndexCore over the same database file", async () => {
  const kit = await kitControl();
  const h = await harness('core-reads');
  await ingestFixture(h, kit);
  const asOfNs = fromMs(control.clock.nowMs());
  const r01 = uriOf(ALICE, 'r01');
  const calls: { [K in keyof IndexRpc]?: Parameters<IndexRpc[K]>[] } = {
    ready: [[]],
    indexing: [[], [ALICE], [DAVE]],
    history: [[{ did: ALICE, limit: 3 }], [{ did: BOB, limit: 50 }]],
    feed: [[{ scope: 'global', limit: 5 }], [{ scope: 'following', viewer: ALICE, limit: 5 }]],
    lookup: [[r01], [uriOf(ALICE, 'zz-missing')]],
    recordStatus: [[r01], [uriOf(DAVE, 'r01')]],
    stats: [[{ did: ALICE, window: 'all', limit: 10, asOfNs }], [{ did: ALICE, window: '7d', limit: 2, asOfNs }]],
    profile: [[ALICE], [DAVE]],
    following: [[{ did: ALICE, limit: 10 }]],
    followers: [[{ did: BOB, limit: 10 }]],
    exportUser: [[ALICE], [DAVE]],
    resolveHandle: [['alice.test']],
    adminStatus: [[]],
  };
  expect(Object.keys(calls).sort()).toEqual([...READ_METHODS].sort());

  // The composed core is the one the routes reach (ctx.index); the second one shares only the file.
  const second = secondCore(h);
  expect(second).not.toBe(h.core);
  expect(second.host.alarm).not.toBe(h.core.host.alarm);
  const composed = h.core as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const other = second as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const compared: string[] = [];
  for (const method of READ_METHODS) {
    for (const args of calls[method] as unknown[][]) {
      const viaComposed = await composed[method]!(...args);
      const viaSecond = await other[method]!(...args);
      expect(viaSecond, `${method}(${JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))})`).toEqual(
        viaComposed,
      );
      compared.push(method);
    }
  }
  expect(new Set(compared)).toEqual(new Set(READ_METHODS));

  // The bodies are real data, not two empty answers.
  const page = (await h.core.history({ did: ALICE, limit: 3 })) as { rows: unknown[]; hasMore: boolean };
  expect(page.rows).toHaveLength(3);
  expect(page.hasMore).toBe(true);
  expect(await h.core.lookup(r01)).toMatchObject({ uri: r01, did: ALICE, track: 'Jóga' });
  expect(await h.core.resolveHandle('alice.test')).toEqual({ status: 'ok', did: ALICE, handle: 'alice.test' });
  expect((await h.core.stats({ did: ALICE, window: 'all', limit: 10, asOfNs }))?.totalScrobbles).toBeGreaterThan(0);
  expect(await h.core.profile(DAVE)).toBeNull();
  // And the HTTP route answers from the same data.
  const http = await h.request(`/api/v1/users/${ALICE}/scrobbles?limit=3`);
  expect(http.status).toBe(200);
  expect((http.body as { items: unknown[] }).items).toHaveLength(3);

  // Argument errors reject identically through both.
  const bad = { did: ALICE, limit: 0 };
  const errorOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: Error) => ({ name: e.name, message: e.message }),
    );
  const composedError = await errorOf(h.core.history(bad));
  expect(composedError).not.toBeNull();
  expect(await errorOf(second.history(bad))).toEqual(composedError);
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

it('app/index-core.ts imports no cloudflare: module and no value from env.ts, and defines every name it took over from the Workers wrapper', () => {
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
    // Defined in index-core.ts itself, not re-exported from elsewhere.
    const definition = new RegExp(`export\\s+(?:const|function|class|async function)\\s+${name}\\b`);
    expect(indexCoreSource, name).toMatch(definition);
  }
  for (const name of MOVED_TYPES) {
    expect(indexCoreSource, name).toMatch(new RegExp(`export\\s+interface\\s+${name}\\b`));
  }
  // The error constants still describe the class.
  const error = new coreModule.IndexError();
  expect([error.name, error.message]).toEqual([coreModule.INDEX_ERROR_NAME, coreModule.INDEX_ERROR_MESSAGE]);
  // Compile-time: the moved types resolve from index-core.ts.
  const deps: coreModule.IndexDeps | null = null;
  const sink: coreModule.LogSink | null = null;
  const report: coreModule.GcReport | null = null;
  expect([deps, sink, report]).toEqual([null, null, null]);
});
