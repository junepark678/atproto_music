// W2-05: indexing status truth (global and per-user Indexing) against real DO
// SQLite in workerd (the harness DO applies the production migrations).
// Ports crates/server/tests/relay_recovery.rs `status_truth` (M4.2.3), the
// reactivation backfill state (M5.2.2) and the upstream outage cases
// (M1.4.2 upstream_outage, M6.2.2 upstream_offline).
//
// Every result is validated against the OpenAPI `Indexing` schema, and every
// read is shown to leave the storage unchanged.

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
import { type Db, doDb } from '../../src/do/db';
import { GAP_REASON, indexing, internalStatus } from '../../src/do/status';
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

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const ALICE = 'did:plc:alice000000000000000000';
const BOB = 'did:plc:bob00000000000000000000000';
const CAROL = 'did:plc:carol0000000000000000000';
const DAVE = 'did:plc:dave00000000000000000000';
const P = 'com.example.atmusic';

const ts = (ms: number) => toStorage(fromMs(ms));

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
    updated_at_ms: now - SECOND,
  });
}

function insertUser(
  db: Db,
  did: string,
  o: { state?: Indexing['state']; active?: 0 | 1; indexedAt?: string | null } = {},
) {
  db.run(
    'INSERT INTO users(did, joined_at, indexed_at, active, account_status, indexing_state) VALUES (?, ?, ?, ?, ?, ?)',
    did,
    '2026-01-01T00:00:00.000000000Z',
    o.indexedAt ?? null,
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
      // A stored flag claims the index is current and caught up.
      db.run(
        `UPDATE indexing_status SET state = 'current', caught_up = 1, last_indexed_at = ?, lag_seconds = 0 WHERE scope = 'global'`,
        ts(now),
      );
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

      insertUser(db, ALICE, { state: 'current', indexedAt: ts(dropAt) });
      // The socket closed at dropAt, right after the last event; the gap is closed.
      setCheckpoint(db, {
        cursor: dropAt * 1000,
        last_event_time_us: dropAt * 1000,
        connected: 0,
        pending_gap: 0,
        connected_at_ms: now - 60 * MINUTE,
        updated_at_ms: dropAt,
      });

      // Exactly five minutes is not "more than five minutes".
      expect(read(db, clock.nowMs(), 'socket')).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T11:55:00.000000000Z',
        lagSeconds: 300,
      });

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

      // Reconnect: no longer stale; no event since connect, so lag is unknown.
      setCheckpoint(db, { connected: 1, connected_at_ms: clock.nowMs(), updated_at_ms: clock.nowMs() });
      expect(read(db, clock.nowMs(), 'socket')).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T11:55:00.000000000Z',
        lagSeconds: null,
      });
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
      // Two intervals since the last successful pulse: still current.
      expect(read(db, clock.nowMs(), 'pulse')).toMatchObject({ state: 'current', caughtUp: true, lagSeconds: 595 });
      clock.advance(1);
      expect(read(db, clock.nowMs(), 'pulse')).toMatchObject({ state: 'stale', caughtUp: false });
      // The same checkpoint in socket mode is stale too (disconnected for ~9m40s).
      expect(read(db, clock.nowMs(), 'socket').state).toBe('stale');

      // A pulse in progress is not stale.
      setCheckpoint(db, { connected: 1, connected_at_ms: clock.nowMs(), updated_at_ms: clock.nowMs() });
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
      insertUser(db, ALICE, { state: 'current', active: 0, indexedAt: '2026-01-14T09:00:00.000000000Z' });
      insertJob(db, ALICE, { reason: 'reactivation', reactivate: 1, dueAt: now });
      insertUser(db, BOB, { state: 'current' });
      insertScrobble(db, BOB, '3m4zm2ufr2222', '2026-01-15T11:30:00.000000000Z');
      insertFollow(db, BOB, ALICE, '2026-01-15T11:40:00.000000000Z');
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
      db.run(`UPDATE users SET active = 1, indexed_at = ? WHERE did = ?`, ts(now), ALICE);
      expect(read(db, now, 'socket', ALICE)).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: '2026-01-15T12:00:00.000000000Z',
        lagSeconds: 2,
      });
      expect(read(db, now, 'socket')).toMatchObject({ state: 'current', caughtUp: true });

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

      // Connected 30 s ago from a cursor whose last event (previous connection) is 10 min old.
      setCheckpoint(db, {
        cursor: (now - 10 * MINUTE) * 1000,
        last_event_time_us: (now - 10 * MINUTE) * 1000,
        connected: 1,
        pending_gap: 0,
        connected_at_ms: now - 30 * SECOND,
        updated_at_ms: now - 30 * SECOND,
      });
      expect(read(db, now, 'socket')).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: null,
        lagSeconds: null,
      });
      clock.advance(5 * MINUTE);
      expect(read(db, clock.nowMs(), 'socket').lagSeconds).toBeNull();

      // An event with time_us 2.999999 s before receipt arrives: floor gives 2.
      clock.set('2026-01-15T12:00:00Z');
      setCheckpoint(db, { last_event_time_us: now * 1000 - 2_999_999, updated_at_ms: now - SECOND });
      expect(read(db, now, 'socket')).toEqual({ state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: 2 });
      expect(internalStatus(db, now, { mode: 'socket' }).indexing.lagSeconds).toBe(2);
      // Exactly 3 s behind.
      setCheckpoint(db, { last_event_time_us: now * 1000 - 3_000_000 });
      expect(read(db, now, 'socket').lagSeconds).toBe(3);
      // Ten seconds later with no newer event, the lag is exactly 13.
      clock.advance(10 * SECOND);
      expect(read(db, clock.nowMs(), 'socket').lagSeconds).toBe(13);
      // An event stamped in the future (clock skew) never reports negative lag.
      setCheckpoint(db, { last_event_time_us: (clock.nowMs() + 5 * SECOND) * 1000, updated_at_ms: clock.nowMs() });
      expect(read(db, clock.nowMs(), 'socket').lagSeconds).toBe(0);

      // A new connection resets to unknown until its first event.
      clock.advance(MINUTE);
      setCheckpoint(db, { connected_at_ms: clock.nowMs(), updated_at_ms: clock.nowMs() });
      expect(read(db, clock.nowMs(), 'socket').lagSeconds).toBeNull();
      // Never any event: null even though connected long ago.
      setCheckpoint(db, { last_event_time_us: null, connected_at_ms: now - 60 * MINUTE });
      expect(read(db, clock.nowMs(), 'socket').lagSeconds).toBeNull();
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
      insertUser(db, ALICE, { indexedAt: '2026-01-15T11:59:00.000000000Z' });
      insertUser(db, BOB);
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
});
