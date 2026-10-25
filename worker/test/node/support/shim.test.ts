// The `cloudflare:*` test shim itself (ADR 0005 §15.1, N2-02): what the
// worker-modules suites rely on when they run on Node unchanged. This file is
// in the worker-node project, which has no `cloudflare:*` aliases; it mocks
// `cloudflare:workers` with the shim so the harness DO class
// (worker/test/harness/harness-do.ts) loads as it does in worker-modules.

import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { doDb } from '../../../src/do/db';
import { SCHEMA_VERSION, TABLES } from '../../../src/do/schema';
import type { HarnessDO } from '../../harness/harness-do';
import {
  evictDurableObject,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
} from './cloudflare-test-shim';
import { env, exports, harnessConfig, shimObject, shimStorageDir, stubId } from './cloudflare-workers-shim';
import { isFacade, isSchemaIntrospection, RowsReadUnavailableError, sqliteDbOf } from './do-storage-facade';
import { WorkerdWebSocketPair } from './workerd-globals';

vi.mock('cloudflare:workers', async () => await import('./cloudflare-workers-shim'));

const T0 = '2026-01-15T12:00:00.000000000Z';
const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

/** Tables of the schema (sqlite_master), sorted. */
function tableNames(state: DurableObjectState): string[] {
  return state.storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .toArray()
    .map((r) => r.name)
    .sort();
}

/** Runs one event-loop task, after which a pair's queued frames have been delivered. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('cloudflare:* test shim', () => {
  it('runInDurableObject gives a state whose storage.sql runs on node:sqlite in a per-file temporary database, runDurableObjectAlarm calls alarm(), and evictDurableObject reopens the same file with every table preserved', async () => {
    // env carries the harness vars and the HARNESS binding of wrangler.harness.jsonc.
    expect(env.LEXICON_PREFIX).toBe(harnessConfig.vars.LEXICON_PREFIX);
    expect(env.LEXICON_PREFIX).toBe('com.example.atmusic');
    expect(harnessConfig.durable_objects.bindings).toEqual([{ name: 'HARNESS', class_name: 'HarnessDO' }]);
    expect(env.HARNESS.idFromName('shim-a').toString()).toBe(env.HARNESS.idFromName('shim-a').toString());
    expect(env.HARNESS.idFromName('shim-a').toString()).toMatch(/^[0-9a-f]{64}$/);
    expect(env.HARNESS.idFromName('shim-a').toString()).not.toBe(env.HARNESS.idFromName('shim-b').toString());

    const stub = stubFor('shim-a');
    const entry = shimObject(stubId(stub));
    expect(await listDurableObjectIds(env.HARNESS)).toEqual([]);
    expect(existsSync(entry.path)).toBe(false);

    // First delivery: the constructor ran migrate (blockConcurrencyWhile) on a
    // new SQLite file in this test file's temporary directory.
    const first = await runInDurableObject(stub, (instance: HarnessDO, state) => {
      expect(instance.migration).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      expect(isFacade(state.storage)).toBe(true);
      // storage.sql runs on node:sqlite through the production adapter.
      const sqlite = sqliteDbOf(state.storage);
      expect(sqlite.path).toBe(entry.path);
      expect(sqlite.pragmas()).toMatchObject({ journal_mode: 'wal', foreign_keys: 1, locking_mode: 'exclusive' });
      expect(state.storage.sql.exec('SELECT sqlite_version() AS v').one()).toEqual({ v: process.versions.sqlite });
      // The cursor: toArray, one, raw, columnNames, rowsWritten = changes, no rowsRead.
      const insert = state.storage.sql.exec(
        "INSERT INTO timers(name, due_at) VALUES ('a', 1), ('b', 2) RETURNING name, due_at",
      );
      expect(insert.columnNames).toEqual(['name', 'due_at']);
      expect(insert.rowsWritten).toBe(2);
      expect([...insert.raw()]).toEqual([
        ['a', 1],
        ['b', 2],
      ]);
      expect(() => insert.rowsRead).toThrow(RowsReadUnavailableError);
      expect(state.storage.sql.exec('SELECT name FROM timers ORDER BY name').toArray()).toEqual([
        { name: 'a' },
        { name: 'b' },
      ]);
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM timers').one()).toEqual({ n: 2 });
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM timers').rowsWritten).toBe(0);
      expect(() => state.storage.sql.exec('SELECT name FROM timers').one()).toThrow(/multiple results/);
      expect(() => state.storage.sql.exec("SELECT name FROM timers WHERE name = 'z'").one()).toThrow(/no results/);
      expect(state.storage.sql.exec("SELECT name FROM timers WHERE name = 'z'").columnNames).toEqual(['name']);
      // transactionSync is the adapter's tx: a throw rolls back.
      expect(() =>
        state.storage.transactionSync(() => {
          state.storage.sql.exec("INSERT INTO timers(name, due_at) VALUES ('c', 3)");
          throw new Error('roll back');
        }),
      ).toThrow('roll back');
      // doDb over the facade keeps working.
      const db = doDb(state.storage);
      db.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', 'did:plc:shim', T0);
      expect(db.all('SELECT name FROM timers ORDER BY name')).toEqual([{ name: 'a' }, { name: 'b' }]);
      // A PRAGMA statement is denied; schema introspection is answered (schema-only replica).
      expect(() => state.storage.sql.exec('PRAGMA table_info(timers)')).toThrow(/pragma/);
      expect(() => state.storage.sql.exec('SELECT * FROM pragma_foreign_key_check')).toThrow(/pragma/);
      expect(
        state.storage.sql
          .exec<{ name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid', 'timers')
          .toArray(),
      ).toEqual([{ name: 'name' }, { name: 'due_at' }]);
      expect(isSchemaIntrospection('SELECT "from", "table" FROM pragma_foreign_key_list(?)')).toBe(true);
      expect(isSchemaIntrospection('SELECT * FROM users, pragma_table_info(?)')).toBe(false);
      expect(isSchemaIntrospection('SELECT * FROM pragma_table_info(?) WHERE name IN (SELECT did FROM users)')).toBe(
        false,
      );
      return instance;
    });
    const dir = shimStorageDir();
    expect(dirname(dir)).toBe(tmpdir());
    expect(dirname(entry.path)).toBe(dir);
    expect(readdirSync(dir).filter((f) => f.endsWith('.sqlite'))).toEqual([basename(entry.path)]);
    expect((await listDurableObjectIds(env.HARNESS)).map(String)).toEqual([stubId(stub).toString()]);
    expect(entry.constructions).toBe(1);

    // The harness entry's default fetch reaches the same object.
    const res = await exports.default.fetch('https://harness.test/harness/shim-a');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ migration: { status: 'ready', version: SCHEMA_VERSION } });
    expect(entry.constructions).toBe(1);

    // runDurableObjectAlarm: false and no call with no alarm; with one armed it
    // clears it and calls the instance's alarm() once.
    const alarmCalls: unknown[] = [];
    (first as unknown as { alarm: (info: unknown) => void }).alarm = (info) => {
      alarmCalls.push(info);
    };
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(alarmCalls).toEqual([]);
    await runInDurableObject(stub, (_i, state) => state.storage.setAlarm(new Date('2026-01-15T12:05:00Z')));
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBe(
      Date.parse('2026-01-15T12:05:00Z'),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(alarmCalls).toEqual([{ retryCount: 0, isRetry: false }]);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(alarmCalls).toHaveLength(1);

    // An alarm armed before eviction survives it, like a DO alarm.
    await runInDurableObject(stub, (_i, state) => state.storage.setAlarm(1_768_478_700_000));
    const tablesBefore = await runInDurableObject(stub, (_i, state) => tableNames(state));
    expect(tablesBefore).toEqual([...TABLES].sort());
    const oldStorage = await runInDurableObject(stub, (_i, state) => state.storage);

    // evictDurableObject closes the connection and drops the instance; the next
    // delivery reopens the same file: a new instance, every table and row kept.
    await evictDurableObject(stub);
    expect(entry.live).toBeNull();
    expect(() => oldStorage.sql.exec('SELECT 1')).toThrow(/evicted/);
    await expect(evictDurableObject(stub)).rejects.toThrow(/not running/);
    await runInDurableObject(stub, (instance: HarnessDO, state) => {
      expect(instance).not.toBe(first);
      expect(instance.migration).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      expect(sqliteDbOf(state.storage).path).toBe(entry.path);
      expect(tableNames(state)).toEqual(tablesBefore);
      const db = doDb(state.storage);
      expect(db.all('SELECT name, due_at FROM timers ORDER BY name')).toEqual([
        { name: 'a', due_at: 1 },
        { name: 'b', due_at: 2 },
      ]);
      expect(db.all('SELECT did FROM users')).toEqual([{ did: 'did:plc:shim' }]);
      expect(db.all('SELECT version FROM schema_migrations ORDER BY version').length).toBe(SCHEMA_VERSION);
    });
    expect(entry.constructions).toBe(2);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBe(1_768_478_700_000);
    expect(readdirSync(dir).filter((f) => f.endsWith('.sqlite'))).toEqual([basename(entry.path)]);

    // A second name is a second database file in the same directory.
    const other = stubFor('shim-b');
    expect(await runInDurableObject(other, (_i, state) => doDb(state.storage).all('SELECT did FROM users'))).toEqual(
      [],
    );
    expect(readdirSync(dir).filter((f) => f.endsWith('.sqlite')).length).toBe(2);
  });

  it('the in-memory WebSocketPair delivers frames in order both ways and close codes reach the other end', async () => {
    // The setup file (workerd-globals.ts) installs it as the global WebSocketPair.
    expect((globalThis as { WebSocketPair?: unknown }).WebSocketPair).toBe(WorkerdWebSocketPair);
    const pair = new WorkerdWebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const got: Record<'client' | 'server', unknown[]> = { client: [], server: [] };
    const record = (end: 'client' | 'server', ws: EventTarget) => {
      ws.addEventListener('message', (ev) => got[end].push((ev as MessageEvent).data));
      ws.addEventListener('close', (ev) => {
        const close = ev as CloseEvent;
        got[end].push({ close: close.code, reason: close.reason });
      });
    };
    record('client', client);
    record('server', server);

    // Frames sent before accept() queue; nothing is delivered until then.
    server.send('s1');
    server.send(new Uint8Array([1, 2, 3]));
    client.send('c1');
    await nextTask();
    expect(got).toEqual({ client: [], server: [] });
    client.accept();
    server.accept();
    expect(() => client.accept()).toThrow(/already accepted/);
    // Delivery is never in the sender's own microtasks (workerd delivers on a later task).
    server.send('s2');
    client.send('c2');
    await Promise.resolve();
    expect(got).toEqual({ client: [], server: [] });
    await nextTask();
    expect(got.client).toEqual(['s1', new Uint8Array([1, 2, 3]).buffer, 's2']);
    expect(got.server).toEqual(['c1', 'c2']);
    // Binary data is copied: a later change to the sender's buffer is not seen.
    const bytes = new Uint8Array([9, 9]);
    client.send(bytes);
    bytes[0] = 0;
    await nextTask();
    expect(new Uint8Array(got.server.at(-1) as ArrayBuffer)).toEqual(new Uint8Array([9, 9]));

    // close(code, reason) reaches the other end with that code; the closer may not send again.
    server.close(4001, 'server done');
    expect(server.readyState).toBe(2);
    expect(() => server.send('late')).toThrow(/after close/);
    await nextTask();
    expect(got.client.at(-1)).toEqual({ close: 4001, reason: 'server done' });
    expect(client.readyState).toBe(2);
    client.close(1000, 'bye');
    await nextTask();
    expect(got.server.at(-1)).toEqual({ close: 1000, reason: 'bye' });
    expect(client.readyState).toBe(3);
    expect(server.readyState).toBe(3);

    // A close without a code arrives as 1005, in order after the frames before it.
    const p2 = new WorkerdWebSocketPair();
    const seen: unknown[] = [];
    p2[0].addEventListener('message', (ev) => seen.push((ev as MessageEvent).data));
    p2[0].addEventListener('close', (ev) => seen.push((ev as CloseEvent).code));
    p2[0].accept();
    p2[1].send('x');
    p2[1].send('y');
    p2[1].close();
    await nextTask();
    expect(seen).toEqual(['x', 'y', 1005]);
  });
});
