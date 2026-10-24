// W2-05: indexing status truth (global and per-user Indexing) against real DO
// SQLite in workerd (the harness DO applies the production migrations).
// Ports crates/server/tests/relay_recovery.rs `status_truth` (M4.2.3), the
// reactivation backfill state (M5.2.2) and the upstream outage cases
// (M1.4.2 upstream_outage, M6.2.2 upstream_offline).
//
// Every result is validated against the OpenAPI `Indexing` schema, and every
// read is shown to leave the storage unchanged. The checkpoint writers and the
// lastIndexedAt high-water mark are exercised through their DB effects, and the
// reads are shown to be index lookups whose rows read do not grow with the
// scrobbles/follows tables (ADR §10.4 query plans, with a negative control).
// A source guard keeps every other production module off the checkpoint and
// high-water-mark columns, so the writer contract cannot be bypassed silently.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Indexing } from '@atmusic/core/api-types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import type { IngestMode } from '../../src/config';
import { type Db, doDb, type SqlParam } from '../../src/do/db';
import {
  GAP_REASON,
  indexing,
  internalStatus,
  markConnected,
  markDisconnected,
  noteIndexed,
  recordEvent,
  updateCheckpointBookkeeping,
} from '../../src/do/status';
import type { HarnessDO } from '../harness/harness-do';

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
const validIndexing = openapiValidator('Indexing');

/** Production sources, keyed by repository path (workerd has no host filesystem). */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
  ).map(([key, source]) => [key.replace(/^\.\.\/\.\.\//, 'worker/'), source]),
);
/** The modules that own the checkpoint and high-water-mark writes. */
const WRITER_OWNERS = new Set(['worker/src/do/status.ts', 'worker/src/do/schema.ts']);

/**
 * Splits a TS source into its string and template literals (with their line)
 * and its code with comments and literal bodies removed.
 */
function scan(source: string): { literals: Array<{ line: number; text: string }>; code: string } {
  const literals: Array<{ line: number; text: string }> = [];
  let code = '';
  let i = 0;
  const lineAt = (index: number) => source.slice(0, index).split('\n').length;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl;
    } else if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      literals.push({ line: lineAt(i), text: source.slice(i + 1, j) });
      code += `${c}${c}`;
      i = j + 1;
    } else {
      code += c;
      i += 1;
    }
  }
  return { literals, code };
}

const GUARDS: Array<{ rule: string; test: (sql: string) => boolean }> = [
  {
    rule: 'writes ingest_checkpoint',
    test: (sql) =>
      /\b(?:UPDATE|INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM)\s+ingest_checkpoint\b/i.test(sql),
  },
  {
    // Deleting a per-DID scope row (disconnect) is allowed; setting a value is not.
    rule: 'writes indexing_status',
    test: (sql) => /\b(?:UPDATE|INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO)\s+indexing_status\b/i.test(sql),
  },
  {
    rule: 'sets users.indexed_at',
    test: (sql) =>
      (/\bUPDATE\s+users\s+SET\b/i.test(sql) ||
        (/\bINTO\s+users\b/i.test(sql) && /\bDO\s+UPDATE\s+SET\b/i.test(sql))) &&
      /\bindexed_at\s*=/i.test(sql),
  },
];
const PROJECTION_INSERT = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:scrobbles|follows)\b/i;

function guardViolations(file: string, source: string): string[] {
  return scan(source).literals.flatMap(({ line, text }) =>
    GUARDS.filter((guard) => guard.test(text)).map((guard) => `${file}:${line} ${guard.rule}`),
  );
}

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const ALICE = 'did:plc:alice000000000000000000';
const BOB = 'did:plc:bob00000000000000000000000';
const CAROL = 'did:plc:carol0000000000000000000';
const DAVE = 'did:plc:dave00000000000000000000';
const P = 'com.example.atmusic';

const ts = (ms: number) => toStorage(fromMs(ms));
const ns = (iso: string) => fromMs(Date.parse(iso));

/** Reads one Indexing and checks it against the OpenAPI schema and that the read wrote nothing. */
function read(db: Db, nowMs: number, mode: IngestMode, did?: string): Indexing {
  const before = dump(db);
  const result = did === undefined ? indexing(db, nowMs, { mode }) : indexing(db, nowMs, { mode, did });
  expect(validIndexing(result)).toBe('valid');
  expect(dump(db)).toEqual(before);
  return result;
}

function dump(db: Db) {
  return {
    status: db.all('SELECT * FROM indexing_status ORDER BY scope'),
    checkpoint: db.all('SELECT * FROM ingest_checkpoint ORDER BY stream'),
    jobs: db.all('SELECT * FROM repo_jobs ORDER BY did, kind'),
    hints: db.all('SELECT * FROM hints ORDER BY uri'),
    users: db.all('SELECT * FROM users ORDER BY did'),
  };
}

interface CheckpointFields {
  cursor?: number | null;
  last_event_time_us?: number | null;
  connected?: 0 | 1;
  pending_gap?: 0 | 1;
  host_index?: number;
  connected_at_ms?: number | null;
  updated_at_ms?: number;
}

function setCheckpoint(db: Db, fields: CheckpointFields) {
  for (const [column, value] of Object.entries(fields)) {
    db.run(`UPDATE ingest_checkpoint SET ${column} = ? WHERE stream = 'jetstream'`, value as number | null);
  }
}

/** A healthy, connected, caught-up socket: cursor set, no gap, events flowing. */
function healthySocket(db: Db, now: number) {
  setCheckpoint(db, {
    cursor: (now - 2 * SECOND) * 1000,
    last_event_time_us: (now - 2 * SECOND) * 1000,
    connected: 1,
    pending_gap: 0,
    connected_at_ms: now - 10 * MINUTE,
    updated_at_ms: now - 10 * MINUTE,
  });
}

function insertUser(db: Db, did: string, o: { state?: Indexing['state']; active?: 0 | 1 } = {}) {
  db.run(
    'INSERT INTO users(did, joined_at, indexed_at, active, account_status, indexing_state) VALUES (?, ?, ?, ?, ?, ?)',
    did,
    '2026-01-01T00:00:00.000000000Z',
    null,
    o.active ?? 1,
    'active',
    o.state ?? 'current',
  );
}

function insertJob(
  db: Db,
  did: string,
  o: { state?: string; reason?: string; reactivate?: 0 | 1; kind?: string; dueAt: number },
) {
  db.run(
    'INSERT INTO repo_jobs(did, kind, state, reason, reactivate, due_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    did,
    o.kind ?? 'snapshot',
    o.state ?? 'pending',
    o.reason ?? null,
    o.reactivate ?? 0,
    o.dueAt,
    o.dueAt,
  );
}

function insertHint(db: Db, did: string, rkey: string, receiptMs: number, dueMs: number) {
  db.run(
    'INSERT INTO hints(uri, did, collection, rkey, source, priority, receipt_time, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `at://${did}/${P}.scrobble/${rkey}`,
    did,
    `${P}.scrobble`,
    rkey,
    'jetstream',
    1,
    ts(receiptMs),
    dueMs,
  );
}

function insertScrobble(db: Db, did: string, rkey: string, indexedAt: string) {
  db.run(
    `INSERT INTO scrobbles(uri, cid, did, rkey, revision, artist, track, listened_at, created_at, indexed_at, artist_key, track_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `at://${did}/${P}.scrobble/${rkey}`,
    'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
    did,
    rkey,
    '3m4zm2ufr2223',
    'Björk',
    'Jóga',
    '2026-01-15T11:00:00.000000000Z',
    '2026-01-15T11:00:00.000Z',
    indexedAt,
    'björk',
    'jóga',
  );
}

function insertFollow(db: Db, actor: string, subject: string, indexedAt: string) {
  db.run(
    'INSERT INTO follows(uri, cid, actor, subject, revision, created_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    `at://${actor}/${P}.follow/3m4zm2ufr2223`,
    'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
    actor,
    subject,
    '3m4zm2ufr2223',
    '2026-01-15T11:00:00.000000000Z',
    indexedAt,
  );
}

function checkpointRow(db: Db) {
  return db.one<Record<string, unknown>>(
    `SELECT cursor, last_event_time_us, connected, pending_gap, gap_scan_after_did, mode, host_index,
            connected_at_ms, updated_at_ms FROM ingest_checkpoint WHERE stream = 'jetstream'`,
  );
}

interface Executed {
  sql: string;
  params: SqlParam[];
  rowsRead: number;
}

/**
 * A Db over the raw DO SQL cursor that records every statement and its
 * `rowsRead` (the billed rows-read count), so a test can see what a read costs.
 */
function countingDb(storage: DurableObjectStorage): { db: Db; executed: Executed[] } {
  const executed: Executed[] = [];
  const exec = (sql: string, params: SqlParam[]) => {
    const cursor = storage.sql.exec(sql, ...params);
    const rows = cursor.toArray();
    executed.push({ sql, params, rowsRead: cursor.rowsRead });
    return { rows, rowsWritten: cursor.rowsWritten };
  };
  const db: Db = {
    all: <T>(sql: string, ...p: SqlParam[]) => exec(sql, p).rows as T[],
    one: <T>(sql: string, ...p: SqlParam[]) => (exec(sql, p).rows[0] as T | undefined) ?? null,
    run: (sql: string, ...p: SqlParam[]) => ({ rowsWritten: exec(sql, p).rowsWritten }),
    tx: () => {
      throw new Error('countingDb is read-only');
    },
  };
  return { db, executed };
}

function queryPlan(db: Db, sql: string, params: SqlParam[]): string[] {
  return db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => row.detail);
}

/** Seeds `n` scrobbles and `n` follows for `did` in one statement each (row i indexed i seconds into 2026-01-14). */
function seedRows(db: Db, did: string, n: number, offset: number) {
  db.run(
    `WITH RECURSIVE k(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM k WHERE i < ?)
     INSERT INTO scrobbles(uri, cid, did, rkey, revision, artist, track, listened_at, created_at, indexed_at, artist_key, track_key)
     SELECT 'at://' || ? || '/${P}.scrobble/r' || i, 'bafy' || i, ?, 'r' || i, '3m4zm2ufr2223', 'A', 'T',
            '2026-01-15T11:00:00.000000000Z', '2026-01-15T11:00:00.000Z',
            printf('2026-01-14T%02d:%02d:%02d.000000000Z', (i / 3600) % 24, (i / 60) % 60, i % 60), 'a', 't'
     FROM k`,
    offset + 1,
    offset + n,
    did,
    did,
  );
  db.run(
    `WITH RECURSIVE k(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM k WHERE i < ?)
     INSERT INTO follows(uri, cid, actor, subject, revision, created_at, indexed_at)
     SELECT 'at://' || ? || '/${P}.follow/f' || i, 'bafy' || i, ?, 'did:plc:subject' || i, '3m4zm2ufr2223',
            '2026-01-15T11:00:00.000000000Z',
            printf('2026-01-14T%02d:%02d:%02d.000000000Z', (i / 3600) % 24, (i / 60) % 60, i % 60)
     FROM k`,
    offset + 1,
    offset + n,
    did,
    did,
  );
}

describe('indexing status truth', () => {
  it('fresh DO reports recovering, caughtUp=false', async () => {
    await runInDurableObject(stubFor('status-fresh'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const clock = fixedClock();
      const fresh: Indexing = { state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: null };

      // The migration seeds a recovering global row and a pending-gap checkpoint with no cursor.
      expect(db.one('SELECT state, caught_up FROM indexing_status WHERE scope = ?', 'global')).toEqual({
        state: 'recovering',
        caught_up: 0,
      });
      expect(
        db.one(
          'SELECT cursor, pending_gap, connected, updated_at_ms FROM ingest_checkpoint WHERE stream = ?',
          'jetstream',
        ),
      ).toEqual({ cursor: null, pending_gap: 1, connected: 0, updated_at_ms: 0 });

      expect(read(db, clock.nowMs(), 'socket')).toEqual(fresh);
      expect(read(db, clock.nowMs(), 'pulse')).toEqual(fresh);
      // A never-written checkpoint has no reference instant: first start stays recovering, not stale.
      clock.advance(60 * MINUTE);
      expect(read(db, clock.nowMs(), 'socket')).toEqual(fresh);
      expect(read(db, clock.nowMs(), 'pulse')).toEqual(fresh);
      // An unknown DID reports the global truth.
      expect(read(db, clock.nowMs(), 'socket', ALICE)).toEqual(fresh);

      // Even with pending_gap cleared, no cursor yet is first start.
      setCheckpoint(db, { pending_gap: 0 });
      expect(read(db, clock.nowMs(), 'socket')).toEqual(fresh);

      const admin = internalStatus(db, clock.nowMs(), { mode: 'socket' });
      expect(admin).toEqual({
        indexing: fresh,
        ingest: {
          mode: 'socket',
          cursor: null,
          lastEventTimeUs: null,
          connected: false,
          pendingGap: false,
          hostIndex: 0,
        },
        hints: { total: 0, due: 0 },
        jobs: { snapshot: {}, status: {}, identity: {} },
        counters: [],
      });
    });
  });

  it('pending_gap overrides a stored current flag', async () => {
    await runInDurableObject(stubFor('status-pending-gap'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const clock = fixedClock();
      const now = clock.nowMs();

      // One live session delivered one event at `now` (Rust status_truth), but the gap is still open.
      setCheckpoint(db, {
        cursor: now * 1000,
        last_event_time_us: now * 1000,
        connected: 1,
        pending_gap: 1,
        connected_at_ms: now - 30 * SECOND,
        updated_at_ms: now,
      });
      // A stored flag claims the index is current and caught up. (Its last_indexed_at
      // column is the high-water mark noteIndexed maintains, and nothing was indexed.)
      db.run(`UPDATE indexing_status SET state = 'current', caught_up = 1, lag_seconds = 0 WHERE scope = 'global'`);
      insertUser(db, ALICE, { state: 'current' });

      expect(read(db, now, 'socket')).toEqual({
        state: 'recovering',
        caughtUp: false,
        lastIndexedAt: null,
        lagSeconds: 0,
      });
      // A current user never reports better than the recovering global state.
      expect(read(db, now, 'socket', ALICE)).toEqual({
        state: 'recovering',
        caughtUp: false,
        lastIndexedAt: null,
        lagSeconds: 0,
      });

      // Rust status_truth part two: a scheduled backfill keeps that user recovering.
      insertJob(db, ALICE, { reason: 'activation', dueAt: now });
      expect(read(db, now, 'socket', ALICE).state).toBe('recovering');

      // The gap closes, but a gap-recovery snapshot job is still outstanding.
      setCheckpoint(db, { pending_gap: 0 });
      insertJob(db, BOB, { reason: GAP_REASON, state: 'failed', dueAt: now + MINUTE });
      expect(read(db, now, 'socket')).toMatchObject({ state: 'recovering', caughtUp: false });

      // Every gap job complete: only now is the global state current.
      db.run(`UPDATE repo_jobs SET state = 'complete' WHERE did = ?`, BOB);
      expect(read(db, now, 'socket')).toEqual({ state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: 0 });
      // Alice's own snapshot is still pending.
      expect(read(db, now, 'socket', ALICE)).toMatchObject({ state: 'recovering', caughtUp: false });
      db.run(`UPDATE repo_jobs SET state = 'complete' WHERE did = ?`, ALICE);
      expect(read(db, now, 'socket', ALICE)).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: null,
        lagSeconds: 0,
      });

      // Re-opening the gap overrides everything again, whatever is stored.
      setCheckpoint(db, { pending_gap: 1 });
      expect(read(db, now, 'socket')).toMatchObject({ state: 'recovering', caughtUp: false });
      expect(read(db, now, 'socket', ALICE)).toMatchObject({ state: 'recovering', caughtUp: false });
      expect(db.one('SELECT state, caught_up FROM indexing_status WHERE scope = ?', 'global')).toEqual({
        state: 'current',
        caught_up: 1,
      });
    });
  });

  it('socket disconnected >5min reports stale', async () => {
    await runInDurableObject(stubFor('status-socket-stale'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const clock = fixedClock();
      const now = clock.nowMs();
      const dropAt = now - 5 * MINUTE;

      insertUser(db, ALICE, { state: 'current' });
      noteIndexed(db, ALICE, fromMs(dropAt));
      // The socket closed at dropAt, right after the last event; the gap is closed.
      setCheckpoint(db, {
        cursor: dropAt * 1000,
        last_event_time_us: dropAt * 1000,
        connected: 0,
        pending_gap: 0,
        connected_at_ms: now - 60 * MINUTE,
        updated_at_ms: dropAt,
      });

      // Exactly five minutes is not "more than five minutes": not stale yet, but a
      // dropped socket is a potential gap and is never caught up (Rust: !connected
      // forces caught_up=false), globally or per user.
      expect(read(db, clock.nowMs(), 'socket')).toEqual({
        state: 'current',
        caughtUp: false,
        lastIndexedAt: '2026-01-15T11:55:00.000000000Z',
        lagSeconds: 300,
      });
      expect(read(db, clock.nowMs(), 'socket', ALICE)).toEqual({
        state: 'current',
        caughtUp: false,
        lastIndexedAt: '2026-01-15T11:55:00.000000000Z',
        lagSeconds: 300,
      });
      // One second after the drop it is already not caught up.
      expect(read(db, dropAt + SECOND, 'socket')).toMatchObject({ state: 'current', caughtUp: false });

      clock.advance(1);
      const stale = read(db, clock.nowMs(), 'socket');
      expect(stale).toEqual({
        state: 'stale',
        caughtUp: false,
        lastIndexedAt: '2026-01-15T11:55:00.000000000Z',
        lagSeconds: 300,
      });
      // The outage case of M1.4.2: six minutes after the drop, lag keeps growing.
      clock.set('2026-01-15T12:01:00Z');
      expect(read(db, clock.nowMs(), 'socket')).toEqual({
        state: 'stale',
        caughtUp: false,
        lastIndexedAt: '2026-01-15T11:55:00.000000000Z',
        lagSeconds: 360,
      });
      // A current user reports the stale global state too.
      expect(read(db, clock.nowMs(), 'socket', ALICE)).toMatchObject({ state: 'stale', caughtUp: false });

      // Stale outranks recovering: an outage during gap recovery is still reported stale.
      setCheckpoint(db, { pending_gap: 1 });
      expect(read(db, clock.nowMs(), 'socket').state).toBe('stale');
      setCheckpoint(db, { pending_gap: 0 });

      // Reconnect: no longer stale and caught up again; no event since connect, so lag is unknown.
      db.tx(() => markConnected(db, clock.nowMs()));
      expect(read(db, clock.nowMs(), 'socket')).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T11:55:00.000000000Z',
        lagSeconds: null,
      });
      expect(read(db, clock.nowMs(), 'socket', ALICE)).toMatchObject({ state: 'current', caughtUp: true });
      expect(internalStatus(db, clock.nowMs(), { mode: 'socket' }).ingest.connected).toBe(true);
    });
  });

  it('pulse overdue by more than two intervals, and off mode, report stale', async () => {
    await runInDurableObject(stubFor('status-pulse-off'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const clock = fixedClock();
      const now = clock.nowMs();
      const pulseAt = now - 10 * MINUTE;

      setCheckpoint(db, {
        cursor: (pulseAt + 5 * SECOND) * 1000,
        last_event_time_us: (pulseAt + 5 * SECOND) * 1000,
        connected: 0,
        pending_gap: 0,
        connected_at_ms: pulseAt,
        updated_at_ms: pulseAt + 20 * SECOND,
      });
      // Two intervals since the last successful pulse: still current, and caught up
      // (connected=0 between pulses is normal in pulse mode).
      expect(read(db, clock.nowMs(), 'pulse')).toMatchObject({ state: 'current', caughtUp: true, lagSeconds: 595 });
      clock.advance(1);
      expect(read(db, clock.nowMs(), 'pulse')).toMatchObject({ state: 'stale', caughtUp: false });
      // The same checkpoint in socket mode is stale too (disconnected for ~9m40s).
      expect(read(db, clock.nowMs(), 'socket').state).toBe('stale');

      // A pulse in progress is not stale (and has no event yet, so its lag is unknown).
      db.tx(() => markConnected(db, clock.nowMs()));
      expect(read(db, clock.nowMs(), 'pulse')).toMatchObject({ state: 'current', caughtUp: true, lagSeconds: null });

      // Off mode is stale however healthy the checkpoint looks, and also during a gap.
      healthySocket(db, clock.nowMs());
      expect(read(db, clock.nowMs(), 'socket')).toMatchObject({ state: 'current', caughtUp: true });
      expect(read(db, clock.nowMs(), 'off')).toMatchObject({ state: 'stale', caughtUp: false });
      setCheckpoint(db, { pending_gap: 1 });
      expect(read(db, clock.nowMs(), 'off').state).toBe('stale');
      expect(internalStatus(db, clock.nowMs(), { mode: 'off' }).indexing.state).toBe('stale');
    });
  });

  it('user with pending reactivation snapshot reports recovering', async () => {
    await runInDurableObject(stubFor('status-reactivation'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const clock = fixedClock();
      const now = clock.nowMs();
      healthySocket(db, now);

      // Alice was current before deactivation; reactivation keeps her hidden with a pending snapshot.
      insertUser(db, ALICE, { state: 'current', active: 0 });
      noteIndexed(db, ALICE, ns('2026-01-14T09:00:00Z'));
      insertJob(db, ALICE, { reason: 'reactivation', reactivate: 1, dueAt: now });
      insertUser(db, BOB, { state: 'current' });
      // Each projection write raises the high-water marks in its transaction.
      db.tx(() => {
        insertScrobble(db, BOB, '3m4zm2ufr2222', '2026-01-15T11:30:00.000000000Z');
        noteIndexed(db, BOB, ns('2026-01-15T11:30:00Z'));
      });
      db.tx(() => {
        insertFollow(db, BOB, ALICE, '2026-01-15T11:40:00.000000000Z');
        noteIndexed(db, BOB, ns('2026-01-15T11:40:00Z'));
      });
      insertUser(db, CAROL, { state: 'current' });
      db.run('INSERT INTO suppression(did, suppressed_at) VALUES (?, ?)', CAROL, ts(now - MINUTE));

      expect(read(db, now, 'socket', ALICE)).toEqual({
        state: 'recovering',
        caughtUp: false,
        lastIndexedAt: '2026-01-14T09:00:00.000000000Z',
        lagSeconds: 2,
      });
      // Other users and the global state are unaffected by a pending (not running) snapshot.
      expect(read(db, now, 'socket', BOB)).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T11:40:00.000000000Z',
        lagSeconds: 2,
      });
      expect(read(db, now, 'socket')).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T11:40:00.000000000Z',
        lagSeconds: 2,
      });
      // A suppressed DID reports suppressed whatever its stored state.
      expect(read(db, now, 'socket', CAROL)).toEqual({
        state: 'suppressed',
        caughtUp: false,
        lastIndexedAt: null,
        lagSeconds: null,
      });
      // A suppression marker without a users row (local data deleted) is still suppressed.
      db.run('INSERT INTO suppression(did, suppressed_at) VALUES (?, ?)', DAVE, ts(now - MINUTE));
      expect(read(db, now, 'socket', DAVE).state).toBe('suppressed');

      // The snapshot starts running: still recovering; the global index is current but not caught up.
      db.run(`UPDATE repo_jobs SET state = 'running' WHERE did = ?`, ALICE);
      expect(read(db, now, 'socket', ALICE)).toMatchObject({ state: 'recovering', caughtUp: false });
      expect(read(db, now, 'socket')).toMatchObject({ state: 'current', caughtUp: false });
      expect(read(db, now, 'socket', BOB)).toMatchObject({ state: 'current', caughtUp: true });
      expect(internalStatus(db, now, { mode: 'socket' }).jobs.snapshot).toEqual({ running: 1 });

      // completeSnapshot: active again, current; the job is complete.
      db.run(`UPDATE repo_jobs SET state = 'complete', reactivate = 0 WHERE did = ?`, ALICE);
      db.run(`UPDATE users SET active = 1 WHERE did = ?`, ALICE);
      noteIndexed(db, ALICE, fromMs(now));
      expect(read(db, now, 'socket', ALICE)).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T12:00:00.000000000Z',
        lagSeconds: 2,
      });
      expect(read(db, now, 'socket')).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T12:00:00.000000000Z',
        lagSeconds: 2,
      });

      // A user stored as recovering (e.g. freshly admitted) stays recovering without a job.
      insertUser(db, 'did:plc:erin0000000000000000000', { state: 'recovering' });
      expect(read(db, now, 'socket', 'did:plc:erin0000000000000000000').state).toBe('recovering');
    });
  });

  it('lagSeconds null when idle and exact when events flowing', async () => {
    await runInDurableObject(stubFor('status-lag'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const clock = fixedClock();
      const now = clock.nowMs();
      const event = (timeUs: number) => ({ cursor: timeUs, timeUs });
      const idle: Indexing = { state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: null };

      // A previous connection delivered an event 10 min ago and closed; the gap is closed.
      db.tx(() => {
        markConnected(db, now - 20 * MINUTE);
        recordEvent(db, event((now - 10 * MINUTE) * 1000));
        updateCheckpointBookkeeping(db, { pendingGap: false });
      });
      db.tx(() => markDisconnected(db, now - 10 * MINUTE + SECOND));

      // Reconnected 30 s ago from that cursor: no event since connect, so the lag is unknown,
      // not the previous connection's 600 s. The resume cursor is kept.
      db.tx(() => markConnected(db, now - 30 * SECOND));
      expect(read(db, now, 'socket')).toEqual(idle);
      expect(internalStatus(db, now, { mode: 'socket' }).ingest).toMatchObject({
        cursor: (now - 10 * MINUTE) * 1000,
        lastEventTimeUs: null,
        connected: true,
      });
      // Silence is not lag: five quiet minutes later it is still unknown.
      clock.advance(5 * MINUTE);
      expect(read(db, clock.nowMs(), 'socket')).toEqual(idle);

      // An event with time_us 2.999999 s before now arrives: floor gives 2.
      clock.set('2026-01-15T12:00:00Z');
      db.tx(() => recordEvent(db, event(now * 1000 - 2_999_999)));
      expect(read(db, now, 'socket')).toEqual({ state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: 2 });
      expect(internalStatus(db, now, { mode: 'socket' }).indexing.lagSeconds).toBe(2);
      // Exactly 3 s behind.
      db.tx(() => recordEvent(db, event(now * 1000 - 3_000_000)));
      expect(read(db, now, 'socket').lagSeconds).toBe(3);
      // Ten seconds later with no newer event, the lag is exactly 13.
      clock.advance(10 * SECOND);
      expect(read(db, clock.nowMs(), 'socket').lagSeconds).toBe(13);
      // An event stamped in the future (clock skew) never reports negative lag.
      db.tx(() => recordEvent(db, event((clock.nowMs() + 5 * SECOND) * 1000)));
      expect(read(db, clock.nowMs(), 'socket').lagSeconds).toBe(0);

      // The socket drops after events: the closed connection's lag keeps growing.
      db.tx(() => recordEvent(db, event((clock.nowMs() - SECOND) * 1000)));
      const dropAt = clock.nowMs();
      db.tx(() => markDisconnected(db, dropAt));
      expect(read(db, dropAt + 30 * SECOND, 'socket')).toEqual({
        state: 'current',
        caughtUp: false,
        lastIndexedAt: null,
        lagSeconds: 31,
      });

      // Reconnect, no event, then drop: lag is unknown during the quiet connection
      // and stays unknown after it closes (never the older connection's event).
      const t1 = dropAt + MINUTE;
      db.tx(() => markConnected(db, t1));
      expect(read(db, t1 + 10 * SECOND, 'socket')).toEqual(idle);
      expect(db.tx(() => markDisconnected(db, t1 + 20 * SECOND))).toBe(true);
      expect(read(db, t1 + 40 * SECOND, 'socket')).toEqual({ ...idle, caughtUp: false });
      expect(read(db, t1 + 20 * SECOND + 5 * MINUTE + 1, 'socket')).toEqual({
        state: 'stale',
        caughtUp: false,
        lastIndexedAt: null,
        lagSeconds: null,
      });
      expect(checkpointRow(db)).toMatchObject({
        connected: 0,
        cursor: (dropAt - SECOND) * 1000,
        last_event_time_us: null,
        connected_at_ms: t1,
        updated_at_ms: t1 + 20 * SECOND,
      });

      // Pulse mode (the Free default). Six hours ago a pulse delivered an event.
      const T = now + 6 * 60 * MINUTE;
      db.tx(() => markConnected(db, T - 6 * 60 * MINUTE));
      db.tx(() => recordEvent(db, event((T - 6 * 60 * MINUTE) * 1000)));
      db.tx(() => markDisconnected(db, T - 6 * 60 * MINUTE + 20 * SECOND));
      // A quiet pulse (no event) runs and closes: unknown during it and after it.
      db.tx(() => markConnected(db, T - MINUTE));
      expect(read(db, T - 50 * SECOND, 'pulse')).toEqual(idle);
      db.tx(() => markDisconnected(db, T - 40 * SECOND));
      expect(read(db, T, 'pulse')).toEqual(idle);
      expect(read(db, T, 'pulse').lagSeconds).not.toBe(6 * 60 * 60);
      // The next pulse delivers an event 2 s old and closes after 20 s: between pulses the
      // lag is measured from that pulse's newest event.
      const pulse = T + 4 * MINUTE;
      db.tx(() => markConnected(db, pulse));
      db.tx(() => recordEvent(db, event((pulse - 2 * SECOND) * 1000)));
      db.tx(() => markDisconnected(db, pulse + 20 * SECOND));
      expect(read(db, pulse + MINUTE, 'pulse')).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: null,
        lagSeconds: 62,
      });
    });
  });

  it('an unknown DID reports recovering with no lastIndexedAt while the global index is current', async () => {
    await runInDurableObject(stubFor('status-unknown-did'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const now = fixedClock().nowMs();
      healthySocket(db, now);
      insertUser(db, BOB, { state: 'current' });
      db.tx(() => {
        insertScrobble(db, BOB, '3m4zm2ufr2222', ts(now - SECOND));
        noteIndexed(db, BOB, fromMs(now - SECOND));
      });

      // The global index is current, caught up and has indexed other DIDs' rows.
      expect(read(db, now, 'socket')).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T11:59:59.000000000Z',
        lagSeconds: 2,
      });
      // Nothing of an unknown DID is indexed (Rust: a missing scope is recovering,
      // caught_up=false, last_indexed_at=null); the ingest lag is still the global one.
      const unknown = { state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: 2 };
      expect(read(db, now, 'socket', ALICE)).toEqual(unknown);
      expect(read(db, now, 'pulse', ALICE)).toEqual(unknown);
      // A stale global state still outranks recovering for it.
      expect(read(db, now, 'off', ALICE)).toEqual({ ...unknown, state: 'stale' });

      // Once admitted (users row recovering, snapshot pending) and snapshotted, it reports its own truth.
      insertUser(db, ALICE, { state: 'recovering', active: 0 });
      insertJob(db, ALICE, { reason: 'activation', dueAt: now });
      expect(read(db, now, 'socket', ALICE)).toEqual(unknown);
      db.tx(() => {
        db.run(`UPDATE repo_jobs SET state = 'complete' WHERE did = ?`, ALICE);
        db.run(`UPDATE users SET active = 1, indexing_state = 'current' WHERE did = ?`, ALICE);
        noteIndexed(db, ALICE, fromMs(now));
      });
      expect(read(db, now, 'socket', ALICE)).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T12:00:00.000000000Z',
        lagSeconds: 2,
      });
      expect(read(db, now, 'socket', BOB).lastIndexedAt).toBe('2026-01-15T11:59:59.000000000Z');
    });
  });

  it('caughtUp is false only while a due hint was received more than 60 s ago', async () => {
    await runInDurableObject(stubFor('status-hints'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const clock = fixedClock();
      const now = clock.nowMs();
      healthySocket(db, now);
      insertUser(db, ALICE);
      insertUser(db, BOB);

      // Received exactly 60 s ago and due now: within the grace.
      insertHint(db, ALICE, '3m4zm2ufr2221', now - 60 * SECOND, now);
      // Received 10 min ago but in backoff (not due).
      insertHint(db, BOB, '3m4zm2ufr2222', now - 10 * MINUTE, now + MINUTE);
      expect(read(db, now, 'socket')).toMatchObject({ state: 'current', caughtUp: true });
      expect(read(db, now, 'socket', ALICE)).toMatchObject({ state: 'current', caughtUp: true });

      clock.advance(1);
      expect(read(db, clock.nowMs(), 'socket')).toMatchObject({ state: 'current', caughtUp: false });
      expect(read(db, clock.nowMs(), 'socket', ALICE)).toMatchObject({ state: 'current', caughtUp: false });
      // Bob's own backlog is not due yet.
      expect(read(db, clock.nowMs(), 'socket', BOB)).toMatchObject({ state: 'current', caughtUp: true });
      expect(internalStatus(db, clock.nowMs(), { mode: 'socket' }).hints).toEqual({ total: 2, due: 1 });

      // Bob's backoff ends: his old hint is due now.
      clock.advance(MINUTE);
      expect(read(db, clock.nowMs(), 'socket', BOB)).toMatchObject({ state: 'current', caughtUp: false });
      expect(internalStatus(db, clock.nowMs(), { mode: 'socket' }).hints).toEqual({ total: 2, due: 2 });

      // Drained: caught up again.
      db.run('DELETE FROM hints');
      expect(read(db, clock.nowMs(), 'socket')).toMatchObject({ state: 'current', caughtUp: true });
    });
  });

  it('internalStatus reports the checkpoint, hint and job counts and counters', async () => {
    await runInDurableObject(stubFor('status-internal'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const now = fixedClock().nowMs();
      healthySocket(db, now);
      setCheckpoint(db, { host_index: 2 });
      insertUser(db, ALICE);
      insertUser(db, BOB);
      noteIndexed(db, ALICE, ns('2026-01-15T11:59:00Z'));
      insertJob(db, ALICE, { dueAt: now });
      insertJob(db, BOB, { state: 'running', dueAt: now });
      insertJob(db, ALICE, { kind: 'status', state: 'complete', dueAt: now });
      insertJob(db, BOB, { kind: 'status', state: 'failed', dueAt: now });
      insertJob(db, ALICE, { kind: 'identity', dueAt: now });
      insertHint(db, ALICE, '3m4zm2ufr2221', now - SECOND, now);
      insertHint(db, ALICE, '3m4zm2ufr2222', now - SECOND, now + SECOND);
      insertHint(db, BOB, '3m4zm2ufr2223', now - SECOND, now + MINUTE);
      db.run(`INSERT INTO counters(name, label, value) VALUES ('excluded', 'invalid_artist', 3), ('dropped', '', 1)`);

      expect(internalStatus(db, now, { mode: 'socket' })).toEqual({
        indexing: { state: 'current', caughtUp: false, lastIndexedAt: '2026-01-15T11:59:00.000000000Z', lagSeconds: 2 },
        ingest: {
          mode: 'socket',
          cursor: (now - 2 * SECOND) * 1000,
          lastEventTimeUs: (now - 2 * SECOND) * 1000,
          connected: true,
          pendingGap: false,
          hostIndex: 2,
        },
        hints: { total: 3, due: 1 },
        jobs: {
          snapshot: { pending: 1, running: 1 },
          status: { complete: 1, failed: 1 },
          identity: { pending: 1 },
        },
        counters: [
          { name: 'dropped', label: '', value: 1 },
          { name: 'excluded', label: 'invalid_artist', value: 3 },
        ],
      });
    });
  });

  it('checkpoint writers: host rotation, gap-scan progress and pending_gap clears leave updated_at_ms unchanged', async () => {
    await runInDurableObject(stubFor('status-writers'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const clock = fixedClock();
      const t0 = clock.nowMs();

      // Constructor on first start: nothing was connected, so nothing is written and
      // the fresh checkpoint keeps no reference instant (recovering, never stale).
      expect(db.tx(() => markDisconnected(db, t0))).toBe(false);
      expect(checkpointRow(db)).toMatchObject({ connected: 0, connected_at_ms: null, updated_at_ms: 0 });
      expect(read(db, t0 + 60 * MINUTE, 'socket')).toMatchObject({ state: 'recovering', caughtUp: false });

      // Connect; the first event arrives in the connect millisecond and still counts.
      db.tx(() => markConnected(db, t0));
      expect(checkpointRow(db)).toMatchObject({
        connected: 1,
        connected_at_ms: t0,
        updated_at_ms: t0,
        last_event_time_us: null,
      });
      expect(read(db, t0, 'socket').lagSeconds).toBeNull();
      db.tx(() => {
        recordEvent(db, { cursor: t0 * 1000 - 1_500_000, timeUs: t0 * 1000 - 1_500_000 });
        updateCheckpointBookkeeping(db, { pendingGap: false, mode: 'socket' });
      });
      expect(checkpointRow(db)).toEqual({
        cursor: t0 * 1000 - 1_500_000,
        last_event_time_us: t0 * 1000 - 1_500_000,
        connected: 1,
        pending_gap: 0,
        gap_scan_after_did: null,
        mode: 'socket',
        host_index: 0,
        connected_at_ms: t0,
        // An event never moves the connection-state instant.
        updated_at_ms: t0,
      });
      expect(read(db, t0, 'socket')).toEqual({ state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: 1 });

      // The socket closes at t1. A second disconnect write (failed reconnect,
      // constructor after eviction) does not move the instant.
      clock.advance(10 * SECOND);
      const t1 = clock.nowMs();
      expect(db.tx(() => markDisconnected(db, t1))).toBe(true);
      expect(db.tx(() => markDisconnected(db, t1 + 30 * SECOND))).toBe(false);
      expect(checkpointRow(db)).toMatchObject({ connected: 0, connected_at_ms: t0, updated_at_ms: t1 });

      // During the outage: host rotation, a gap opened and scanned in batches, then cleared.
      db.tx(() => updateCheckpointBookkeeping(db, { hostIndex: 1 }));
      db.tx(() => updateCheckpointBookkeeping(db, { pendingGap: true, gapScanAfterDid: ALICE }));
      db.tx(() => updateCheckpointBookkeeping(db, { gapScanAfterDid: BOB }));
      db.tx(() => updateCheckpointBookkeeping(db, { pendingGap: false, gapScanAfterDid: null }));
      db.tx(() => updateCheckpointBookkeeping(db, {}));
      expect(checkpointRow(db)).toEqual({
        cursor: t0 * 1000 - 1_500_000,
        last_event_time_us: t0 * 1000 - 1_500_000,
        connected: 0,
        pending_gap: 0,
        gap_scan_after_did: null,
        mode: 'socket',
        host_index: 1,
        connected_at_ms: t0,
        updated_at_ms: t1,
      });
      // So the permanent outage still turns stale exactly 5 min after the drop.
      expect(read(db, t1 + 5 * MINUTE, 'socket')).toMatchObject({ state: 'current', caughtUp: false });
      expect(read(db, t1 + 5 * MINUTE + 1, 'socket')).toMatchObject({ state: 'stale', caughtUp: false });
      expect(read(db, t1 + 60 * MINUTE, 'socket')).toMatchObject({ state: 'stale', caughtUp: false, lagSeconds: 3611 });

      // Reconnect at t2, then rotate back: no event since connect, lag stays unknown.
      // The resume cursor survives; only this connection's event time is cleared.
      const t2 = t1 + 60 * MINUTE;
      db.tx(() => markConnected(db, t2));
      db.tx(() => updateCheckpointBookkeeping(db, { hostIndex: 0 }));
      expect(checkpointRow(db)).toMatchObject({
        connected: 1,
        connected_at_ms: t2,
        updated_at_ms: t2,
        host_index: 0,
        cursor: t0 * 1000 - 1_500_000,
        last_event_time_us: null,
      });
      expect(read(db, t2 + MINUTE, 'socket')).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: null,
        lagSeconds: null,
      });
      // The first event after the reconnect makes the lag exact again.
      db.tx(() => recordEvent(db, { cursor: (t2 - 4 * SECOND) * 1000, timeUs: (t2 - 4 * SECOND) * 1000 }));
      expect(checkpointRow(db)).toMatchObject({
        updated_at_ms: t2,
        cursor: (t2 - 4 * SECOND) * 1000,
        last_event_time_us: (t2 - 4 * SECOND) * 1000,
      });
      expect(read(db, t2 + SECOND, 'socket').lagSeconds).toBe(5);
    });
  });

  it('lastIndexedAt is a monotone high-water mark that deletions do not lower', async () => {
    await runInDurableObject(stubFor('status-high-water'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const now = fixedClock().nowMs();
      healthySocket(db, now);
      insertUser(db, ALICE);
      insertUser(db, BOB);

      db.tx(() => {
        insertScrobble(db, ALICE, '3m4zm2ufr2222', '2026-01-15T11:50:00.000000000Z');
        noteIndexed(db, ALICE, ns('2026-01-15T11:50:00Z'));
      });
      // An older write (a slow snapshot chunk committing late) never lowers either mark.
      db.tx(() => noteIndexed(db, ALICE, ns('2026-01-15T11:00:00Z')));
      db.tx(() => noteIndexed(db, BOB, ns('2026-01-15T11:10:00Z')));
      // A write for a DID without a users row raises only the global mark.
      db.tx(() => noteIndexed(db, DAVE, ns('2026-01-15T11:20:00Z')));
      expect(db.all('SELECT did, indexed_at FROM users ORDER BY did')).toEqual([
        { did: ALICE, indexed_at: '2026-01-15T11:50:00.000000000Z' },
        { did: BOB, indexed_at: '2026-01-15T11:10:00.000000000Z' },
      ]);
      expect(db.one('SELECT last_indexed_at FROM indexing_status WHERE scope = ?', 'global')).toEqual({
        last_indexed_at: '2026-01-15T11:50:00.000000000Z',
      });

      // Deleting the newest row is indexing work too: the mark stays.
      db.run('DELETE FROM scrobbles WHERE did = ?', ALICE);
      expect(read(db, now, 'socket')).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T11:50:00.000000000Z',
        lagSeconds: 2,
      });
      expect(read(db, now, 'socket', ALICE).lastIndexedAt).toBe('2026-01-15T11:50:00.000000000Z');
      expect(read(db, now, 'socket', BOB).lastIndexedAt).toBe('2026-01-15T11:10:00.000000000Z');
      // Sub-millisecond precision survives the round trip.
      db.tx(() => noteIndexed(db, BOB, ns('2026-01-15T11:59:00Z') + 123_456n));
      expect(read(db, now, 'socket', BOB).lastIndexedAt).toBe('2026-01-15T11:59:00.000123456Z');
      expect(read(db, now, 'socket').lastIndexedAt).toBe('2026-01-15T11:59:00.000123456Z');
    });
  });

  it('status reads are index lookups: rows read do not grow with scrobbles/follows; negative control scans', async () => {
    await runInDurableObject(stubFor('status-query-plan'), async (_i: HarnessDO, state) => {
      const db = doDb(state.storage);
      const now = fixedClock().nowMs();
      healthySocket(db, now);
      insertUser(db, ALICE);
      insertUser(db, BOB);
      noteIndexed(db, ALICE, ns('2026-01-15T11:58:00Z'));
      insertJob(db, BOB, { reason: GAP_REASON, state: 'complete', dueAt: now });
      insertHint(db, BOB, '3m4zm2ufr2221', now - SECOND, now);

      const cost = () => {
        const { db: counting, executed } = countingDb(state.storage);
        const global = indexing(counting, now, { mode: 'socket' });
        const user = indexing(counting, now, { mode: 'socket', did: ALICE });
        return { global, user, executed, rowsRead: executed.reduce((sum, e) => sum + e.rowsRead, 0) };
      };

      seedRows(db, ALICE, 2_000, 0);
      const small = cost();
      expect(small.global).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T11:58:00.000000000Z',
        lagSeconds: 2,
      });
      expect(small.user).toEqual(small.global);
      // Every statement is a primary-key or index seek: no table SCAN in any plan
      // (`SCAN CONSTANT ROW` is the `SELECT EXISTS(...)` wrapper, not a table).
      expect(small.executed.length).toBeGreaterThan(0);
      for (const { sql, params } of small.executed) {
        const plan = queryPlan(db, sql, params);
        expect(
          plan.filter((detail) => /\bSCAN\b/.test(detail) && detail !== 'SCAN CONSTANT ROW'),
          `${sql}\n${plan.join('\n')}`,
        ).toEqual([]);
        for (const detail of plan.filter((d) => d.startsWith('SEARCH '))) expect(detail).toMatch(/ USING /);
        expect(sql).not.toMatch(/\b(scrobbles|follows)\b/);
      }
      expect(small.rowsRead).toBeLessThan(40);

      // Ten times the rows: the reads cost exactly the same.
      seedRows(db, ALICE, 18_000, 2_000);
      expect(db.one('SELECT count(*) AS n FROM scrobbles')).toEqual({ n: 20_000 });
      const large = cost();
      expect(large.global).toEqual(small.global);
      expect(large.user).toEqual(small.user);
      expect(large.rowsRead).toBe(small.rowsRead);

      // Negative control: a max(indexed_at) read scans. Globally the plan uses no
      // index (there is no indexed_at index); per owner it seeks the DID but then
      // reads every row the owner has. Both costs grow with the table.
      const { db: counting, executed } = countingDb(state.storage);
      const globalMax = 'SELECT max(indexed_at) AS m FROM scrobbles';
      const ownerMax = 'SELECT max(indexed_at) AS m FROM follows WHERE actor = ?';
      expect(counting.one(globalMax)).toEqual({ m: '2026-01-14T05:33:20.000000000Z' });
      expect(counting.one(ownerMax, ALICE)).toEqual({ m: '2026-01-14T05:33:20.000000000Z' });
      // SQLite renders the unindexed min/max access as a bare `SEARCH scrobbles`
      // (or `SCAN scrobbles`): neither names an index, unlike every status read above.
      expect(queryPlan(db, globalMax, []).filter((detail) => /\b(SEARCH|SCAN) scrobbles\b/.test(detail))).toEqual([
        expect.not.stringContaining('USING'),
      ]);
      expect(executed[0]?.rowsRead).toBeGreaterThanOrEqual(20_000);
      expect(executed[1]?.rowsRead).toBeGreaterThanOrEqual(20_000);
    });
  });

  it('source guard: only status.ts writes ingest_checkpoint, indexing_status and users.indexed_at, and projection inserts have a noteIndexed caller', () => {
    const files = Object.keys(SOURCES).sort();
    expect(files).toContain('worker/src/do/status.ts');
    expect(files).toContain('worker/src/do/schema.ts');
    expect(files).toContain('worker/src/do/db.ts');

    // The patterns match the real writers (status.ts is the owner, so it is exempt below).
    const own = guardViolations('worker/src/do/status.ts', SOURCES['worker/src/do/status.ts'] ?? '');
    expect(own.filter((v) => v.endsWith('writes ingest_checkpoint')).length).toBe(4);
    expect(own.filter((v) => v.endsWith('writes indexing_status')).length).toBe(1);
    expect(own.filter((v) => v.endsWith('sets users.indexed_at')).length).toBe(1);
    // Negative controls: direct writes in another module are flagged; reads and other columns are not.
    expect(
      guardViolations(
        'x.ts',
        [
          "db.run('UPDATE ingest_checkpoint SET cursor = ?, last_event_time_us = ? WHERE stream = ?')",
          'db.run(`INSERT OR REPLACE INTO indexing_status(scope, state) VALUES (?, ?)`)',
          "db.run(`UPDATE users SET indexing_state = 'current',\n       indexed_at = ?, last_activity_ms = ? WHERE did = ?`)",
          'db.run(`INSERT INTO users(did, joined_at) VALUES (?, ?) ON CONFLICT(did) DO UPDATE SET indexed_at = ?`)',
          "db.run('DELETE FROM ingest_checkpoint')",
        ].join('\n'),
      ),
    ).toEqual([
      'x.ts:1 writes ingest_checkpoint',
      'x.ts:2 writes indexing_status',
      'x.ts:3 sets users.indexed_at',
      'x.ts:5 sets users.indexed_at',
      'x.ts:6 writes ingest_checkpoint',
    ]);
    expect(
      guardViolations(
        'y.ts',
        [
          "db.one('SELECT cursor, updated_at_ms FROM ingest_checkpoint WHERE stream = ?')",
          "db.run('UPDATE users SET handle = ? WHERE did = ?', handle, did); // indexed_at = untouched",
          "db.one('SELECT last_indexed_at FROM indexing_status')",
          "db.run('DELETE FROM indexing_status WHERE scope = ?', did)",
          '// a comment may say UPDATE ingest_checkpoint SET cursor = ? without being code',
          "/* or UPDATE users SET indexed_at = ? */ const url = 'https://example.com/x'; // it's fine",
        ].join('\n'),
      ),
    ).toEqual([]);

    // No other production module bypasses the writers.
    const violations = files
      .filter((file) => !WRITER_OWNERS.has(file))
      .flatMap((file) => guardViolations(file, SOURCES[file] ?? ''));
    expect(violations).toEqual([]);

    // Once any module projects rows, some module other than status.ts must raise the
    // lastIndexedAt high-water marks (W2-04 applyRecordProof / applySnapshotChunk / completeSnapshot).
    const callsNoteIndexed = (source: string) => /\bnoteIndexed\s*\(/.test(scan(source).code);
    expect(callsNoteIndexed("// noteIndexed(db, did, at) in a comment\nconst s = 'noteIndexed(x)';")).toBe(false);
    expect(callsNoteIndexed('db.tx(() => {\n  noteIndexed(db, did, nowNs);\n});')).toBe(true);
    const projecting = files.filter((file) =>
      scan(SOURCES[file] ?? '').literals.some(({ text }) => PROJECTION_INSERT.test(text)),
    );
    const noting = files.filter((file) => file !== 'worker/src/do/status.ts' && callsNoteIndexed(SOURCES[file] ?? ''));
    expect(
      projecting.length === 0 || noting.length > 0,
      `${projecting.join(', ')} insert projection rows but no module calls noteIndexed`,
    ).toBe(true);
  });
});
