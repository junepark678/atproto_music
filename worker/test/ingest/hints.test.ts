// W3-04 hints.ts against a real SQLite file (production migrations).
// Proves M1.3.3/event_atomicity and M4.1.3/atomic_fault (enqueue + checkpoint
// in one transaction) and the coalescing upsert. Expectations are hardcoded.

import { describe, expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import { enqueueHints, HINT_PRIORITY, type HintInput, takeDue } from '../../src/do/ingest/hints';
import hintsSource from '../../src/do/ingest/hints.ts?raw';
import { indexing, markConnected } from '../../src/do/status';
import { withIngestIndex } from './node-index';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const SCROBBLE = 'com.example.atmusic.scrobble';
const T0 = Date.parse('2026-01-15T12:00:00Z');
const REV_A = '3lbcdefghijkl';
const REV_B = '3lbcdefghijkz';

const hint = (rkey: string, extra: Partial<HintInput> = {}): HintInput => ({
  did: ALICE,
  collection: SCROBBLE,
  rkey,
  source: 'jetstream',
  receiptMs: T0,
  ...extra,
});

function hints(db: Db) {
  return db.all('SELECT * FROM hints ORDER BY uri');
}

function checkpoint(db: Db) {
  return db.one<Record<string, unknown>>("SELECT * FROM ingest_checkpoint WHERE stream = 'jetstream'");
}

/** A Db whose `run` throws on statements matching `pattern` (fault injection through the interface). */
function faultyDb(db: Db, pattern: RegExp): Db {
  return {
    all: (sql: string, ...p: SqlParam[]) => db.all(sql, ...p),
    one: (sql: string, ...p: SqlParam[]) => db.one(sql, ...p),
    run(sql: string, ...p: SqlParam[]) {
      if (pattern.test(sql)) throw new Error(`injected fault: ${sql.slice(0, 40)}`);
      return db.run(sql, ...p);
    },
    tx: (fn) => db.tx(fn),
  } as Db;
}

describe('enqueueHints', () => {
  it('duplicate hints for a URI coalesce to one row with min due_at', async () => {
    await withIngestIndex((i) => {
      const db = i.db;
      const uri = `at://${ALICE}/${SCROBBLE}/r1`;
      // A reconcile hint due in 60 s, then a jetstream hint due in 10 s with a
      // revision, then a notify hint due in 30 s with an older revision and a
      // later receipt, then a jetstream duplicate due in 90 s.
      expect(enqueueHints(db, [hint('r1', { source: 'reconcile', dueAt: T0 + 60_000 })])).toEqual([uri]);
      enqueueHints(db, [hint('r1', { dueAt: T0 + 10_000, hintRev: REV_B })]);
      enqueueHints(db, [hint('r1', { source: 'notify', receiptMs: T0 + 5_000, dueAt: T0 + 30_000, hintRev: REV_A })]);
      enqueueHints(db, [hint('r1', { dueAt: T0 + 90_000, hintRev: 'not-a-tid' }), hint('r2')]);

      expect(hints(db)).toEqual([
        {
          uri,
          did: ALICE,
          collection: SCROBBLE,
          rkey: 'r1',
          // The best priority wins and its source with it.
          source: 'notify',
          priority: HINT_PRIORITY.notify,
          // The newest claimed revision, the newest receipt, the earliest due time.
          hint_rev: REV_B,
          receipt_time: '2026-01-15T12:00:05.000000000Z',
          due_at: T0 + 10_000,
          attempts: 0,
          last_error: null,
        },
        {
          uri: `at://${ALICE}/${SCROBBLE}/r2`,
          did: ALICE,
          collection: SCROBBLE,
          rkey: 'r2',
          source: 'jetstream',
          priority: HINT_PRIORITY.jetstream,
          hint_rev: null,
          receipt_time: '2026-01-15T12:00:00.000000000Z',
          due_at: T0,
          attempts: 0,
          last_error: null,
        },
      ]);
      expect(db.one('SELECT count(*) AS n FROM hints WHERE uri = ?', uri)).toEqual({ n: 1 });
      // The drain timer is durable with them, at the earliest due time.
      expect(db.one("SELECT due_at FROM timers WHERE name = 'drain'")).toEqual({ due_at: T0 });
      // Priority order: notify (r1) before jetstream (r2); r1 is not due before T0+10 s.
      expect(takeDue(db, T0, 10).map((h) => h.rkey)).toEqual(['r2']);
      expect(takeDue(db, T0 + 10_000, 10).map((h) => h.rkey)).toEqual(['r1', 'r2']);
      expect(takeDue(db, T0 + 10_000, 10, new Set([uri])).map((h) => h.rkey)).toEqual(['r2']);
    });
  });

  it('enqueue and checkpoint advance commit atomically (throw rolls back both)', async () => {
    await withIngestIndex((i) => {
      const db = i.db;
      const before = { hints: hints(db), checkpoint: checkpoint(db), timers: db.all('SELECT * FROM timers') };
      expect(before.checkpoint).toMatchObject({ cursor: null, last_event_time_us: null });

      // 1. The checkpoint write fails after both hints were upserted: nothing persists.
      const failCheckpoint = faultyDb(db, /UPDATE ingest_checkpoint/);
      expect(() =>
        enqueueHints(failCheckpoint, [hint('r1'), hint('r2', { did: BOB })], {
          cursor: 1_700_000_000_000_001,
          timeUs: 1_700_000_000_000_000,
        }),
      ).toThrow(/injected fault/);
      expect({ hints: hints(db), checkpoint: checkpoint(db), timers: db.all('SELECT * FROM timers') }).toEqual(before);

      // 2. The second hint is invalid (rkey syntax): the first hint and the checkpoint roll back.
      expect(() =>
        enqueueHints(db, [hint('r1'), hint('bad key!')], {
          cursor: 1_700_000_000_000_001,
          timeUs: 1_700_000_000_000_000,
        }),
      ).toThrow(RangeError);
      expect({ hints: hints(db), checkpoint: checkpoint(db), timers: db.all('SELECT * FROM timers') }).toEqual(before);

      // 3. A hint upsert fails: the checkpoint does not advance either.
      const failHint = faultyDb(db, /INSERT INTO hints/);
      expect(() => enqueueHints(failHint, [hint('r1')], { cursor: 5, timeUs: 6 })).toThrow(/injected fault/);
      expect({ hints: hints(db), checkpoint: checkpoint(db), timers: db.all('SELECT * FROM timers') }).toEqual(before);

      // 4. Without a fault both commit together.
      enqueueHints(db, [hint('r1'), hint('r2', { did: BOB })], {
        cursor: 1_700_000_000_000_001,
        timeUs: 1_700_000_000_000_000,
      });
      expect(hints(db).map((h) => (h as { uri: string }).uri)).toEqual([
        `at://${ALICE}/${SCROBBLE}/r1`,
        `at://${BOB}/${SCROBBLE}/r2`,
      ]);
      expect(checkpoint(db)).toMatchObject({
        cursor: 1_700_000_000_000_001,
        last_event_time_us: 1_700_000_000_000_000,
      });
      // An ignored event (no hints) still advances the cursor.
      enqueueHints(db, [], { cursor: 1_700_000_000_000_002, timeUs: 1_700_000_000_000_500 });
      expect(checkpoint(db)).toMatchObject({
        cursor: 1_700_000_000_000_002,
        last_event_time_us: 1_700_000_000_000_500,
      });
      expect(hints(db)).toHaveLength(2);
    });
  });

  it('enqueueHints checkpoint advance goes through recordEvent: indexing() lagSeconds is exact after the first event since markConnected and updated_at_ms is unchanged', async () => {
    // Source guard: hints.ts holds no SQL that writes ingest_checkpoint.
    const sql = hintsSource.replace(/\/\/.*$/gm, '');
    expect(/\b(?:UPDATE|INSERT\s+INTO|REPLACE\s+INTO|DELETE\s+FROM)\s+ingest_checkpoint\b/i.test(sql)).toBe(false);
    expect(hintsSource).toContain("import { recordEvent } from '../status';");

    await withIngestIndex((i) => {
      const db = i.db;
      const connectedAt = T0;
      db.tx(() => markConnected(db, connectedAt));
      // No event since the connect: lag is null.
      expect(indexing(db, T0 + 1_000, { mode: 'socket' }).lagSeconds).toBeNull();

      // The first event, 4.5 s before the connect instant, enqueued with its checkpoint advance.
      const eventUs = (T0 - 4_500) * 1000;
      enqueueHints(db, [hint('r1')], { cursor: eventUs + 7, timeUs: eventUs });
      expect(
        db.one(
          "SELECT cursor, last_event_time_us, connected, connected_at_ms, updated_at_ms FROM ingest_checkpoint WHERE stream = 'jetstream'",
        ),
      ).toEqual({
        cursor: eventUs + 7,
        last_event_time_us: eventUs,
        connected: 1,
        connected_at_ms: connectedAt,
        // recordEvent never moves the stale reference instant.
        updated_at_ms: connectedAt,
      });
      // floor((T0 + 10 s − (T0 − 4.5 s)) / 1 s) = 14.
      expect(indexing(db, T0 + 10_000, { mode: 'socket' }).lagSeconds).toBe(14);
      expect(indexing(db, T0 + 10_499, { mode: 'socket' }).lagSeconds).toBe(14);
      expect(indexing(db, T0 + 10_500, { mode: 'socket' }).lagSeconds).toBe(15);

      // A later event (via an ignored message: no hints) moves the lag reference, not updated_at_ms.
      enqueueHints(db, [], { cursor: eventUs + 9, timeUs: (T0 + 8_000) * 1000 });
      expect(indexing(db, T0 + 10_000, { mode: 'socket' }).lagSeconds).toBe(2);
      expect(db.one("SELECT updated_at_ms FROM ingest_checkpoint WHERE stream = 'jetstream'")).toEqual({
        updated_at_ms: connectedAt,
      });
    });
  });
});
