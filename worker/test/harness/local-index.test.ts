// The Node harness of the de-shimmed worker-modules suites (ADR 0005 §15.1
// step 2, N4-04): worker/test/node/support/with-index.ts. `withIndex`
// replaces runInDurableObject (a migrated temporary-file database per call),
// `runAlarmNow(core)` replaces runDurableObjectAlarm (IndexCore.runAlarmNow),
// `reopen` replaces evictDurableObject (close and reopen the same file), and
// `nodeIndex` replaces the local-index adapter for these suites (the module
// function runs on the test's own database). The titles of the workerd-era
// tests are kept (node-port-inventory.json); the helper existence check is
// the named §15.3 change "replaced by Node harness checks".

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import type { HistoryQuery, ModuleDeps, RowsResult, ScrobbleRow } from '../../src/do/contracts';
import type { SqlParam } from '../../src/do/db';
import { migrate } from '../../src/do/migrate';
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from '../../src/do/schema';
import { armAlarm, CORE_LANE, nextDue, schedule } from '../../src/do/timers';
import { ENSURE_RUNNING_INTERVAL_MS, startEnsureRunning } from '../../src/node/alarm';
import type { SqliteDb } from '../../src/node/sqlite-db';
import { dumpDb } from '../node/support/node-db';
import {
  indexCore,
  NODE_INDEX_METHODS,
  NotWiredError,
  nodeIndex,
  type RpcImpl,
  reopen,
  runAlarmNow,
  TEST_BUSY_TIMEOUT_MS,
  withIndex,
} from '../node/support/with-index';

const T0 = '2026-01-15T12:00:00.000000000Z';
const NOW = Date.parse('2026-01-15T12:00:00Z');
const DAY = 24 * 3_600_000;
const SCROBBLE = 'com.example.atmusic.scrobble';
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';

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

const blob = (byte: number, length = 32): ArrayBuffer => new Uint8Array(length).fill(byte).buffer;

/**
 * One valid row for every table migration 1 and 2 create that the migrations
 * do not already seed (indexing_status, backfill_generation, ingest_checkpoint,
 * schema_migrations and schema_compat hold their seed rows).
 */
const SEED_ROWS: Record<string, Record<string, SqlParam>[]> = {
  users: [
    { did: ALICE, joined_at: T0, active: 1, account_status: 'active', indexing_state: 'current', generation: 1 },
    { did: BOB, joined_at: T0 },
  ],
  scrobbles: [
    {
      uri: `at://${ALICE}/${SCROBBLE}/3lb2aaaaaaa2a`,
      cid: 'bafyscrobble',
      did: ALICE,
      rkey: '3lb2aaaaaaa2a',
      revision: '3lb2aaaaaaa2a',
      artist: 'Björk',
      track: 'Jóga',
      album: 'Homogenic',
      listened_at: T0,
      created_at: T0,
      duration_seconds: 305,
      indexed_at: T0,
      artist_key: 'björk',
      track_key: 'jóga',
      album_key: 'homogenic',
    },
  ],
  follows: [
    {
      uri: `at://${ALICE}/com.example.atmusic.follow/3lb2aaaaaaa2b`,
      cid: 'bafyfollow',
      actor: ALICE,
      subject: BOB,
      revision: '3lb2aaaaaaa2b',
      created_at: T0,
      indexed_at: T0,
    },
  ],
  record_state: [
    {
      uri: `at://${ALICE}/${SCROBBLE}/3lb2aaaaaaa2a`,
      did: ALICE,
      collection: SCROBBLE,
      revision: '3lb2aaaaaaa2a',
      cid: 'bafyscrobble',
      state: 'present',
      verified_at: T0,
    },
  ],
  suppression: [{ did: 'did:plc:cccccccccccccccccccccccc', suppressed_at: T0 }],
  repo_jobs: [{ did: ALICE, kind: 'snapshot', state: 'complete', generation: 1, due_at: NOW, updated_at_ms: NOW }],
  hints: [
    {
      uri: `at://${BOB}/${SCROBBLE}/3lb2aaaaaaa2c`,
      did: BOB,
      collection: SCROBBLE,
      rkey: '3lb2aaaaaaa2c',
      source: 'notify',
      priority: 1,
      receipt_time: T0,
      due_at: NOW + DAY,
    },
  ],
  snapshot_blocks: [{ did: ALICE, cid: 'bafyblock', bytes: blob(7, 5) }],
  identity_cache: [{ did: ALICE, pds: 'https://pds.example.test', handle: 'alice.test', fetched_at_ms: NOW }],
  verified_commits: [{ did: ALICE, commit_cid: 'bafycommit', rev: '3lb2aaaaaaa2a', verified_at_ms: NOW }],
  host_backoff: [{ host: 'pds.example.test', until_ms: NOW + 60_000 }],
  admission: [{ window_start_ms: NOW, admitted: 2 }],
  timers: [{ name: 'outbox', due_at: NOW + DAY }],
  stats_cache: [{ did: ALICE, win: 'all', lim: 10, as_of: T0, version: 1, body: '{}' }],
  counters: [{ name: 'events', label: 'commit', value: 3 }],
  accounts: [{ did: ALICE, username: 'alice', created_at_ms: NOW, updated_at_ms: NOW }],
  web_sessions: [{ token_hash: blob(1), did: ALICE, created_at_ms: NOW, expires_at_ms: NOW + DAY, last_seen_ms: NOW }],
  oauth_states: [
    { key_hash: blob(2), ciphertext: blob(3, 8), key_id: 'k1', session_binding: blob(4), expires_at_ms: NOW + 600_000 },
  ],
  oauth_sessions: [
    {
      did: ALICE,
      ciphertext: blob(5, 8),
      key_id: 'k1',
      client_kid: 'c1',
      last_refresh_ms: NOW,
      created_at_ms: NOW,
      updated_at_ms: NOW,
    },
  ],
  operations: [
    {
      id: 'op1',
      did: ALICE,
      kind: 'scrobble.create',
      origin: 'web',
      priority: 0,
      collection: SCROBBLE,
      record_json: '{}',
      digest: 'd1',
      due_at: NOW + DAY,
      created_at_ms: NOW,
      updated_at_ms: NOW,
    },
    {
      id: 'op2',
      did: ALICE,
      kind: 'scrobble.delete',
      origin: 'web',
      priority: 0,
      collection: SCROBBLE,
      rkey: '3lb2aaaaaaa2a',
      due_at: NOW + DAY,
      created_at_ms: NOW,
      updated_at_ms: NOW,
    },
  ],
  operation_deps: [{ op_id: 'op2', pred_id: 'op1' }],
  listen_keys: [{ did: ALICE, dedupe_key: 'k1', operation_id: 'op1', source: 'web', created_at_ms: NOW }],
  pds_budget: [{ did: ALICE, window: 'hour', window_start_ms: NOW, points: 3 }],
  lastfm_tokens: [{ token_hash: blob(6), api_key: 'apikey', created_at_ms: NOW, expires_at_ms: NOW + 3_600_000 }],
  lastfm_sessions: [{ id: 's1', sk_hash: blob(8), did: ALICE, api_key: 'apikey', created_at_ms: NOW }],
  lastfm_apps: [
    { api_key: 'apikey', did: ALICE, name: 'app', secret_ciphertext: blob(9, 8), key_id: 'k1', created_at_ms: NOW },
  ],
  app_passwords: [{ id: 'ap1', did: ALICE, hash: blob(10), created_at_ms: NOW }],
  lb_tokens: [{ id: 'lb1', did: ALICE, hash: blob(11), created_at_ms: NOW }],
  now_playing: [
    { did: ALICE, artist: 'Björk', track: 'Jóga', source: 'web', started_at_ms: NOW, expires_at_ms: NOW + 300_000 },
  ],
  loves: [
    {
      uri: `at://${ALICE}/com.example.atmusic.love/3lb2aaaaaaa2d`,
      did: ALICE,
      rkey: '3lb2aaaaaaa2d',
      cid: 'bafylove',
      artist: 'Björk',
      track: 'Jóga',
      artist_key: 'björk',
      track_key: 'jóga',
      created_at: T0,
      indexed_at: T0,
    },
  ],
  linked_accounts: [
    {
      id: 'l1',
      did: ALICE,
      service: 'lastfm',
      remote_user: 'alice',
      credential_ciphertext: blob(12, 8),
      key_id: 'k1',
      created_at_ms: NOW,
      updated_at_ms: NOW,
    },
  ],
  link_states: [
    { state_hash: blob(13), did: ALICE, service: 'listenbrainz', session_hash: blob(14), expires_at_ms: NOW },
  ],
  forward_outbox: [
    {
      id: 'f1',
      link_id: 'l1',
      did: ALICE,
      kind: 'scrobble',
      dedupe_key: 'k1',
      payload_json: '{}',
      due_at: NOW + DAY,
      created_at_ms: NOW,
      updated_at_ms: NOW,
    },
  ],
  import_jobs: [{ id: 'j1', did: ALICE, source: 'lastfm_api', created_at_ms: NOW, updated_at_ms: NOW }],
  import_items: [{ job_id: 'j1', seq: 0, dedupe_key: 'k0', listened_at: T0, record_json: '{}' }],
  ignored_listens: [
    {
      did: ALICE,
      source: 'listenbrainz',
      reason: 'artist_invalid',
      listened_at: T0,
      artist_preview: '',
      track_preview: 'x',
      created_at_ms: NOW,
    },
  ],
  range_stats_cache: [
    { did: ALICE, entity: 'artists', range_key: 'week', as_of: T0, version: 1, body: '{}', created_at_ms: NOW },
  ],
  backup_runs: [{ kind: 'manual', started_at_ms: NOW, finished_at_ms: NOW + 1, path: '/tmp/x.db', bytes: 1, ok: 1 }],
};

function insertRow(db: SqliteDb, table: string, row: Record<string, SqlParam>): void {
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    ...keys.map((k) => row[k] as SqlParam),
  );
}

const rowCount = (db: SqliteDb, table: string) => db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n;

describe('worker/test/harness', () => {
  it('local-index adapter executes a module function inside the harness DO', async () => {
    await withIndex(async (db) => {
      const clock = fixedClock();
      const index = nodeIndex(db, { history: historyModule }, { clock });

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

      // The writes landed in the test's own database file.
      expect(db.all('SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([
        { rkey: 'r1768478400000' },
        { rkey: 'r1768478401000' },
      ]);

      // Deterministic deps were injected: fixture config, recorded logs, no network.
      expect(index.deps.db).toBe(db);
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
      expect(NODE_INDEX_METHODS).toHaveLength(17);
      for (const method of NODE_INDEX_METHODS) expect(typeof index[method]).toBe('function');

      // A module error rolls its transaction back and surfaces to the caller.
      const failing = nodeIndex(db, {
        history: (m) =>
          m.db.tx(() => {
            m.db.run("INSERT INTO timers(name, due_at) VALUES ('drain', 1)");
            throw new Error('module failed');
          }),
      });
      await expect(failing.history({ did: 'did:plc:alice', limit: 1 })).rejects.toThrow('module failed');
      expect(db.all('SELECT * FROM timers')).toEqual([]);
    });
  });

  it('local-index adapter also accepts the frozen Partial<IndexRpc> form', async () => {
    await withIndex(async (db) => {
      const ready = { status: 'ready', version: SCHEMA_VERSION } as const;
      const impl: RpcImpl = {
        // A canned answer.
        ready: async () => ready,
        // Delegation to a module function through `this` (the ModuleDeps over the test database).
        history(q) {
          return Promise.resolve(historyModule(this, q));
        },
      };
      const index = nodeIndex(db, impl, { form: 'rpc', clock: fixedClock() });

      expect(await index.ready()).toEqual(ready);
      const page = await index.history({ did: 'did:plc:bob', limit: 5 });
      expect(page.rows.map((r) => [r.did, r.rkey])).toEqual([['did:plc:bob', 'r1768478400000']]);
      // The delegated write went to the test's database.
      expect(db.all('SELECT did, rkey FROM scrobbles')).toEqual([{ did: 'did:plc:bob', rkey: 'r1768478400000' }]);
      await expect(index.feed({ scope: 'global', limit: 1 })).rejects.toBeInstanceOf(NotWiredError);
      expect(index.calls).toEqual([
        { method: 'ready', args: [] },
        { method: 'history', args: [{ did: 'did:plc:bob', limit: 5 }] },
        { method: 'feed', args: [{ scope: 'global', limit: 1 }] },
      ]);
      expect(index.networkAttempts).toEqual([]);
    });
  });

  // ADR 0005 §15.3: the workerd-helper existence check, replaced by checks of
  // the Node harness that replaces each helper (N4-04).
  it('pinned cloudflare:test exposes the DO, alarm, eviction and cron helpers', async () => {
    for (const [name, helper] of Object.entries({ withIndex, runAlarmNow, reopen, indexCore, startEnsureRunning })) {
      expect(typeof helper, name).toBe('function');
    }
    let seenDir = '';
    await withIndex(async (db, ix) => {
      seenDir = ix.dir;
      // The "Durable Object": the production adapter over a migrated file in a temporary directory.
      expect(dirname(ix.dir)).toBe(tmpdir());
      expect(ix.path).toBe(join(ix.dir, 'atmusic.db'));
      expect(db.path).toBe(ix.path);
      expect(existsSync(ix.path)).toBe(true);
      expect(db.pragmas()).toMatchObject({
        journal_mode: 'wal',
        foreign_keys: 1,
        locking_mode: 'exclusive',
        busy_timeout: TEST_BUSY_TIMEOUT_MS,
      });
      expect(db.one('SELECT count(*) AS n FROM schema_migrations')).toEqual({ n: MIGRATIONS.length });

      // The alarm: IndexCore's core lane over a NodeAlarm on manual timers.
      const t = indexCore(db);
      expect(t.alarm.nextDueMs()).toBeNull();
      // No timer is due, so nothing runs.
      expect(await runAlarmNow(t.core)).toEqual({
        ran: [],
        failed: [],
        deferred: [],
        recovered: [],
        superseded: false,
      });
      // An armed alarm is run (and re-armed to the next due row) by runAlarmNow.
      schedule(db, 'gc', NOW);
      expect(armAlarm(t.alarm, db, CORE_LANE)).toBe(NOW);
      expect(t.alarm.nextDueMs()).toBe(NOW);
      expect(t.timers.pending().map((p) => [p.kind, p.delayMs])).toEqual([['timeout', 0]]);
      const report = await runAlarmNow(t.core);
      expect(report?.ran).toEqual(['gc']);
      expect(db.all('SELECT name, due_at FROM timers')).toEqual([{ name: 'gc', due_at: NOW + DAY }]);
      expect(t.alarm.nextDueMs()).toBe(NOW + DAY);
      expect(t.log.entries.filter((e) => e.event === 'gc.done')).toHaveLength(1);

      // The cron: the 5-minute ensureRunning interval restores a lost timer and re-arms the alarm.
      t.core.markMigrated(migrate(db));
      const interval = startEnsureRunning(t.core, undefined, { log: t.log, timers: t.timers });
      const tick = t.timers.pending().find((p) => p.kind === 'interval');
      expect(tick?.delayMs).toBe(ENSURE_RUNNING_INTERVAL_MS);
      db.run('DELETE FROM timers');
      await t.alarm.deleteAlarm();
      tick?.callback();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(db.all<{ name: string }>('SELECT name FROM timers ORDER BY name').map((r) => r.name)).toEqual([
        'discovery',
        'gc',
        'identity-sweep',
        'jetstream-watchdog',
        'status-sweep',
      ]);
      expect(t.alarm.nextDueMs()).toBe(nextDue(db));
      interval.stop();
      expect(t.timers.pending().filter((p) => p.kind === 'interval')).toEqual([]);

      // Eviction: close and reopen the same file; the old handle is closed and the reopen migrated again.
      const again = ix.reopen();
      expect(again).not.toBe(db);
      expect(ix.db).toBe(again);
      expect(again.path).toBe(ix.path);
      expect(() => db.all('SELECT 1 AS x')).toThrow();
      expect(again.one('SELECT count(*) AS n FROM schema_migrations')).toEqual({ n: MIGRATIONS.length });
      expect(ix.opens).toBe(2);
    });
    // The directory goes with the call.
    expect(seenDir).not.toBe('');
    expect(existsSync(seenDir)).toBe(false);
  });

  // N1-10: suites that pinned schema version 1 derive it from the schema.
  it('the ready status and the schema_migrations ledger equal SCHEMA_VERSION and one row per entry of MIGRATIONS', async () => {
    // The schema itself: contiguous versions from 1, the last is SCHEMA_VERSION.
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_m, i) => i + 1));
    expect(SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(2);

    const expectedLedger = MIGRATIONS.map((m) => ({ version: m.version, name: m.name }));
    await withIndex(async (db, ix) => {
      // The status the first open's migration reports, and the one IndexCore serves.
      expect(ix.migration).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      expect(await indexCore(db).core.ready()).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      const ledger = (d: SqliteDb) => d.all('SELECT version, name FROM schema_migrations ORDER BY version');
      expect(ledger(db)).toEqual(expectedLedger);

      // A restart reopens the same file and re-runs migrate: same status, no extra ledger row.
      const again = ix.reopen();
      expect(migrate(again)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      expect(await indexCore(again).core.ready()).toEqual({ status: 'ready', version: SCHEMA_VERSION });
      expect(ledger(again)).toEqual(expectedLedger);
    });
  });

  it('withIndex, runAlarmNow and reopen replace runInDurableObject, runDurableObjectAlarm and evictDurableObject, and reopen preserves every table', async () => {
    // withIndex: each call is its own migrated file, removed afterwards, also when the callback throws.
    const dirs: string[] = [];
    await withIndex((a, ia) =>
      withIndex((b, ib) => {
        dirs.push(ia.dir, ib.dir);
        expect(ia.path).not.toBe(ib.path);
        a.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', ALICE, T0);
        expect(b.all('SELECT did FROM users')).toEqual([]);
        expect(a.all('SELECT did FROM users')).toEqual([{ did: ALICE }]);
      }),
    );
    await expect(
      withIndex((_db, ix) => {
        dirs.push(ix.dir);
        throw new Error('test body failed');
      }),
    ).rejects.toThrow('test body failed');
    expect(dirs).toHaveLength(3);
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);

    await withIndex(async (db, ix) => {
      // runAlarmNow: a started IndexCore's core lane runs every due timer and re-arms the alarm.
      const t = indexCore(db);
      t.core.start();
      expect(db.all<{ name: string }>('SELECT name FROM timers ORDER BY name').map((r) => r.name)).toEqual([
        'discovery',
        'gc',
        'identity-sweep',
        'jetstream-watchdog',
        'status-sweep',
      ]);
      expect(t.alarm.nextDueMs()).toBe(NOW);
      const report = await runAlarmNow(t.core);
      expect(report).toEqual({
        ran: ['jetstream-watchdog', 'status-sweep', 'identity-sweep', 'discovery', 'gc'],
        failed: [],
        deferred: [],
        recovered: [],
        superseded: false,
      });
      expect(t.core.lastAlarm).toEqual(report);
      // Ingestion is off: the watchdog recorded the mode; gc rescheduled itself a day out.
      expect(db.one("SELECT mode FROM ingest_checkpoint WHERE stream = 'jetstream'")).toEqual({ mode: 'off' });
      expect(db.one("SELECT due_at FROM timers WHERE name = 'gc'")).toEqual({ due_at: NOW + DAY });
      // The alarm follows the earliest remaining row; no network and no Jetstream connect was attempted.
      expect(t.alarm.nextDueMs()).toBe(nextDue(db));
      expect(t.transport.attempts).toEqual([]);
      expect(t.jetstream.attempts).toEqual([]);

      // reopen: every table and its rows survive close and reopen of the same file.
      for (const [table, rows] of Object.entries(SEED_ROWS)) for (const row of rows) insertRow(db, table, row);
      for (const table of TABLES) expect([table, rowCount(db, table)]).not.toEqual([table, 0]);
      const before = dumpDb(db);
      const tableNames = before.objects.filter((o) => o.type === 'table').map((o) => o.name);
      expect([...tableNames].sort()).toEqual([...TABLES].sort());
      const timersBefore = db.all('SELECT name, due_at FROM timers ORDER BY name');

      const again = ix.reopen();
      expect(again).not.toBe(db);
      expect(() => db.all('SELECT 1 AS x')).toThrow();
      expect(again.path).toBe(ix.path);
      expect(dumpDb(again)).toEqual(before);
      expect(again.pragmas()).toMatchObject({ journal_mode: 'wal', foreign_keys: 1, locking_mode: 'exclusive' });

      // A new IndexCore on the reopened file re-arms its alarm from the preserved timers.
      const restarted = indexCore(again);
      expect(restarted.alarm.nextDueMs()).toBeNull();
      restarted.core.start();
      expect(restarted.alarm.nextDueMs()).toBe(nextDue(again));
      expect(again.all('SELECT name, due_at FROM timers ORDER BY name')).toEqual(
        expect.arrayContaining(timersBefore.filter((r) => (r as { name: string }).name !== 'jetstream-watchdog')),
      );

      // The module-level reopen does the same for a handle passed in.
      const third = reopen(again);
      expect(dumpDb(third).tables.users).toEqual(before.tables.users);
      expect(ix.db).toBe(third);
    });
  });
});
