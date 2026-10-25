import {
  createExecutionContext,
  createScheduledController,
  evictAllDurableObjects,
  evictDurableObject,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import type { HistoryQuery, ModuleDeps, RowsResult, ScrobbleRow } from '../../src/do/contracts';
import { doDb } from '../../src/do/db';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/do/schema';
import * as testShim from '../node/support/cloudflare-test-shim';
import { shimObject, shimStorageDir, stubId } from '../node/support/cloudflare-workers-shim';
import { isFacade } from '../node/support/do-storage-facade';
import type { HarnessDO } from './harness-do';
import { INDEX_RPC_METHODS, makeLocalIndex, NotWiredError, type RpcImpl } from './local-index';

const T0 = '2026-01-15T12:00:00.000000000Z';
const SCROBBLE = 'com.example.atmusic.scrobble';

/** A toy DO module with the real module signature `(m, args)`: it writes, then reads, synchronously. */
function historyModule(m: ModuleDeps, q: HistoryQuery): RowsResult<ScrobbleRow> {
  return m.db.tx(() => {
    m.db.run('INSERT OR IGNORE INTO users(did, joined_at, active) VALUES (?, ?, 1)', q.did, T0);
    m.db.run(
      `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      `at://${q.did}/${SCROBBLE}/r${m.clock.nowMs()}`,
      'bafy-local',
      q.did,
      `r${m.clock.nowMs()}`,
      '3lb2aaaaaaa2a',
      'Björk',
      'Jóga',
      T0,
      T0,
      T0,
      'björk',
      'jóga',
    );
    m.log.log('info', 'history.module', { did: q.did, prefix: m.config.prefix });
    const rows = m.db.all<ScrobbleRow>(
      'SELECT * FROM scrobbles WHERE did = ? ORDER BY listened_at DESC, uri DESC LIMIT ?',
      q.did,
      q.limit + 1,
    );
    return {
      rows: rows.slice(0, q.limit),
      hasMore: rows.length > q.limit,
      indexing: { state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: null },
    };
  });
}

describe('worker/test/harness', () => {
  it('local-index adapter executes a module function inside the harness DO', async () => {
    const stub = env.HARNESS.get(env.HARNESS.idFromName('local-index'));
    const clock = fixedClock();
    const index = makeLocalIndex({ stub, clock }, { history: historyModule });

    const first = await index.history({ did: 'did:plc:alice', limit: 1 });
    expect(first.hasMore).toBe(false);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({
      uri: 'at://did:plc:alice/com.example.atmusic.scrobble/r1768478400000',
      did: 'did:plc:alice',
      artist: 'Björk',
      album: null,
      duration_seconds: null,
    });

    clock.advance(1000);
    const second = await index.history({ did: 'did:plc:alice', limit: 1 });
    expect(second.hasMore).toBe(true);
    expect(second.rows.map((r) => r.rkey)).toEqual(['r1768478401000']);

    // The writes landed in the harness DO's own durable storage.
    await runInDurableObject(stub, (_instance, state) => {
      expect(doDb(state.storage).all('SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([
        { rkey: 'r1768478400000' },
        { rkey: 'r1768478401000' },
      ]);
    });

    // Deterministic deps were injected: fixture config, recorded logs, no network.
    expect(index.deps.config.prefix).toBe('com.example.atmusic');
    expect(index.deps.config.publication).toBe(false);
    expect(index.logs).toEqual([
      { level: 'info', event: 'history.module', fields: { did: 'did:plc:alice', prefix: 'com.example.atmusic' } },
      { level: 'info', event: 'history.module', fields: { did: 'did:plc:alice', prefix: 'com.example.atmusic' } },
    ]);
    await expect(index.deps.transport(new Request('https://pds.example.test/xrpc/x'))).rejects.toThrow(
      /no network in tests/,
    );
    expect(index.networkAttempts).toEqual(['https://pds.example.test/xrpc/x']);

    // An unwired method rejects instead of silently returning.
    await expect(index.profile('did:plc:alice')).rejects.toBeInstanceOf(NotWiredError);
    expect(index.calls.map((c) => c.method)).toEqual(['history', 'history', 'profile']);
    expect(INDEX_RPC_METHODS).toHaveLength(17);
    for (const method of INDEX_RPC_METHODS) expect(typeof index[method]).toBe('function');

    // A module error inside the DO rolls its transaction back and surfaces to the caller.
    const failing = makeLocalIndex(
      { stub },
      {
        history: (m) =>
          m.db.tx(() => {
            m.db.run("INSERT INTO timers(name, due_at) VALUES ('drain', 1)");
            throw new Error('module failed');
          }),
      },
    );
    await expect(failing.history({ did: 'did:plc:alice', limit: 1 })).rejects.toThrow('module failed');
    await runInDurableObject(stub, (_instance, state) => {
      expect(doDb(state.storage).all('SELECT * FROM timers')).toEqual([]);
    });
  });

  it('local-index adapter also accepts the frozen Partial<IndexRpc> form', async () => {
    const stub = env.HARNESS.get(env.HARNESS.idFromName('local-index-rpc'));
    const ready = { status: 'ready', version: SCHEMA_VERSION } as const;
    const impl: RpcImpl = {
      // A canned answer.
      ready: async () => ready,
      // Delegation to a module function through `this` (the ModuleDeps inside the DO).
      history(q) {
        return Promise.resolve(historyModule(this, q));
      },
    };
    const index = makeLocalIndex({ stub, clock: fixedClock() }, impl, { form: 'rpc' });

    expect(await index.ready()).toEqual(ready);
    const page = await index.history({ did: 'did:plc:bob', limit: 5 });
    expect(page.rows.map((r) => [r.did, r.rkey])).toEqual([['did:plc:bob', 'r1768478400000']]);
    // The delegated write went to the harness DO's storage.
    await runInDurableObject(stub, (_instance, state) => {
      expect(doDb(state.storage).all('SELECT did, rkey FROM scrobbles')).toEqual([
        { did: 'did:plc:bob', rkey: 'r1768478400000' },
      ]);
    });
    await expect(index.feed({ scope: 'global', limit: 1 })).rejects.toBeInstanceOf(NotWiredError);
    expect(index.calls).toEqual([
      { method: 'ready', args: [] },
      { method: 'history', args: [{ did: 'did:plc:bob', limit: 5 }] },
      { method: 'feed', args: [{ scope: 'global', limit: 1 }] },
    ]);
    expect(index.networkAttempts).toEqual([]);
  });

  // ADR 0005 §15.3 (N2-02): the workerd-helper existence check, replaced by
  // checks of the Node shim that `cloudflare:test` resolves to.
  it('pinned cloudflare:test exposes the DO, alarm, eviction and cron helpers', async () => {
    const shimHelpers = {
      runInDurableObject: testShim.runInDurableObject,
      runDurableObjectAlarm: testShim.runDurableObjectAlarm,
      evictDurableObject: testShim.evictDurableObject,
      evictAllDurableObjects: testShim.evictAllDurableObjects,
      createScheduledController: testShim.createScheduledController,
      createExecutionContext: testShim.createExecutionContext,
      waitOnExecutionContext: testShim.waitOnExecutionContext,
      listDurableObjectIds: testShim.listDurableObjectIds,
    };
    const helpers = {
      runInDurableObject,
      runDurableObjectAlarm,
      evictDurableObject,
      evictAllDurableObjects,
      createScheduledController,
      createExecutionContext,
      waitOnExecutionContext,
      listDurableObjectIds,
    };
    // `cloudflare:test` is the shim (worker/vitest.modules.config.ts alias), not workerd.
    for (const [name, helper] of Object.entries(helpers)) {
      expect(typeof helper, name).toBe('function');
      expect(helper, name).toBe(shimHelpers[name as keyof typeof helpers]);
    }
    const stub = env.HARNESS.get(env.HARNESS.idFromName('helpers'));
    const entry = shimObject(stubId(stub));
    // The harness DO's storage is the DO-storage facade over this file's own SQLite file.
    const first = await runInDurableObject(stub, (instance: HarnessDO, state) => {
      expect(isFacade(state.storage)).toBe(true);
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM schema_migrations').one()).toEqual({
        n: MIGRATIONS.length,
      });
      return instance;
    });
    expect(entry.path.startsWith(`${shimStorageDir()}/`)).toBe(true);
    // No alarm is armed after migration, so none runs.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    // An armed alarm is run (and removed) by runDurableObjectAlarm: the harness
    // DO has no alarm() handler, so running it is an error, and the alarm is gone.
    await runInDurableObject(stub, (_i, state) => state.storage.setAlarm(1_768_478_400_000));
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(/no alarm\(\) handler/);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);

    const controller = createScheduledController({ scheduledTime: 1_768_478_400_000, cron: '*/5 * * * *' });
    expect(controller.cron).toBe('*/5 * * * *');
    expect(controller.scheduledTime).toBe(1_768_478_400_000);
    const ctx = createExecutionContext();
    let settled = false;
    ctx.waitUntil(Promise.resolve().then(() => (settled = true)));
    await waitOnExecutionContext(ctx);
    expect(settled).toBe(true);

    // Eviction reopens the same file with a new instance, which migrated again.
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance: HarnessDO) => {
      expect(instance).not.toBe(first);
      expect(instance.migration).toEqual({ status: 'ready', version: SCHEMA_VERSION });
    });
    expect(entry.constructions).toBe(2);
    expect((await listDurableObjectIds(env.HARNESS)).map(String)).toContain(stubId(stub).toString());
  });

  // N1-10: suites that pinned schema version 1 derive it from the schema.
  it('the ready status and the schema_migrations ledger equal SCHEMA_VERSION and one row per entry of MIGRATIONS', async () => {
    // The schema itself: contiguous versions from 1, the last is SCHEMA_VERSION.
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_m, i) => i + 1));
    expect(SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(2);

    const stub = env.HARNESS.get(env.HARNESS.idFromName('local-index-ledger'));
    const expectedLedger = MIGRATIONS.map((m) => ({ version: m.version, name: m.name }));
    // The status the harness DO's constructor migration reports over fetch.
    const res = await stub.fetch('https://harness.test/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ migration: { status: 'ready', version: SCHEMA_VERSION } });
    const inDo = () =>
      runInDurableObject(stub, (instance: HarnessDO, state) => ({
        migration: instance.migration,
        ledger: doDb(state.storage).all('SELECT version, name FROM schema_migrations ORDER BY version'),
      }));
    expect(await inDo()).toEqual({ migration: { status: 'ready', version: SCHEMA_VERSION }, ledger: expectedLedger });

    // A restarted instance re-runs migrate on the same storage: same status, no extra ledger row.
    await evictDurableObject(stub);
    expect(await inDo()).toEqual({ migration: { status: 'ready', version: SCHEMA_VERSION }, ledger: expectedLedger });
  });
});
