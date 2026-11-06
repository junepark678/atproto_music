// The durable hint queue (ADR 0004 §5.4, §6.1 `hints`). Synchronous.
//
// A hint is an untrusted `(did, collection, rkey)` that only makes the drain
// fetch and verify public signed truth (Jetstream events, notify, reconcile and
// coalescing all land here). It is never projected itself.
//
// - `enqueueHints(db, hints, checkpoint?)` is one `db.tx`: a coalescing upsert
//   per URI and, when `checkpoint` is given, the Jetstream cursor advance
//   through the W2-05 writer `recordEvent` (worker/src/do/status.ts). So the
//   cursor can never run ahead of a durable hint, and a throw anywhere rolls
//   back every hint and the checkpoint together. The same transaction also
//   schedules the `drain` timer at the earliest new due time (timers.ts), so a
//   durable hint always has a durable timer. This module holds no SQL that
//   writes `ingest_checkpoint` (the W2-05 source guard in
//   worker/test/storage/status.test.ts enforces that): `recordEvent` writes
//   only `cursor` and `last_event_time_us`, so an event can never move the
//   stale reference instant (`updated_at_ms`).
// - Coalescing (one row per URI, `ON CONFLICT(uri)`):
//   - `due_at = min(due_at, new)`: a fresh hint pulls a backed-off one forward;
//   - `priority = min(...)`, and `source` follows the winning priority
//     (notify 0 < jetstream 1 < reconcile 2, the drain's order);
//   - `hint_rev = max(...)`, NULL-aware (the newest revision any event claimed;
//     a proof older than it is stale);
//   - `receipt_time = max(...)`: the proof the drain fetches is at least as new
//     as the newest event, so the newest receipt is the +300 s validation bound
//     for it (receipt time is our clock, never in the future);
//   - `attempts` and `last_error` are kept, so the give-up bound still holds
//     for a URI that keeps being hinted.
// - `takeDue(db, now, n)`: due hints in priority order, then due time, then URI.
// - `backoffHint`, `deferHint`, `deleteHint`, `deleteHintsForDid`, `countByDid`
//   are the drain's helpers; every caller runs them inside its own `db.tx` or
//   as one atomic statement, never across an await.

import { isTid } from '@atmusic/core/syntax';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import type { Db } from '../db';
import { recordEvent } from '../status';
import { schedule } from '../timers';
import { recordUri } from '../write/keys';

export type HintSource = 'jetstream' | 'notify' | 'reconcile';

/** Drain priority: lower runs first (ADR §5.4: notify, then jetstream, then reconcile). */
export const HINT_PRIORITY: Readonly<Record<HintSource, number>> = { notify: 0, jetstream: 1, reconcile: 2 };

export interface HintInput {
  did: string;
  collection: string;
  rkey: string;
  source: HintSource;
  /** The commit revision the event claimed (a TID), when known; anything else is dropped. */
  hintRev?: string | null;
  /** When we received it (epoch ms, injected clock): the +300 s validation bound. */
  receiptMs: number;
  /** When it becomes due (epoch ms); defaults to `receiptMs`. */
  dueAt?: number;
}

/** The Jetstream checkpoint advance written in the same transaction (W2-05 `recordEvent`). */
export interface CheckpointAdvance {
  cursor: number;
  timeUs: number;
}

export interface HintRow {
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  source: HintSource;
  priority: number;
  hint_rev: string | null;
  /** 30-character storage timestamp. */
  receipt_time: string;
  due_at: number;
  attempts: number;
  last_error: string | null;
}

function assertEpochMs(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer of epoch ms, got ${value}`);
  }
}

const UPSERT = `INSERT INTO hints(uri, did, collection, rkey, source, priority, hint_rev, receipt_time, due_at, attempts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT(uri) DO UPDATE SET
    due_at = min(hints.due_at, excluded.due_at),
    source = CASE WHEN excluded.priority < hints.priority THEN excluded.source ELSE hints.source END,
    priority = min(hints.priority, excluded.priority),
    hint_rev = CASE
      WHEN hints.hint_rev IS NULL THEN excluded.hint_rev
      WHEN excluded.hint_rev IS NULL THEN hints.hint_rev
      ELSE max(hints.hint_rev, excluded.hint_rev) END,
    receipt_time = max(hints.receipt_time, excluded.receipt_time)`;

function upsertHint(db: Db, h: HintInput): string {
  if (!Object.hasOwn(HINT_PRIORITY, h.source)) throw new TypeError(`unknown hint source: ${String(h.source)}`);
  assertEpochMs('receiptMs', h.receiptMs);
  const dueAt = h.dueAt ?? h.receiptMs;
  assertEpochMs('dueAt', dueAt);
  // Throws a RangeError on invalid DID / NSID / record key syntax (rolls back the batch).
  const uri = recordUri(h.did, h.collection, h.rkey);
  const hintRev = typeof h.hintRev === 'string' && isTid(h.hintRev) ? h.hintRev : null;
  db.run(
    UPSERT,
    uri,
    h.did,
    h.collection,
    h.rkey,
    h.source,
    HINT_PRIORITY[h.source],
    hintRev,
    toStorage(fromMs(h.receiptMs)),
    dueAt,
  );
  return uri;
}

/**
 * Upsert every hint and, optionally, advance the Jetstream checkpoint, in one
 * transaction. Returns the hinted URIs in input order.
 */
export function enqueueHints(db: Db, hints: readonly HintInput[], checkpoint?: CheckpointAdvance): string[] {
  return db.tx(() => {
    const uris = hints.map((h) => upsertHint(db, h));
    // The drain timer is durable with the hints it will work (W5-01 arms the alarm).
    const due = hints.reduce((min, h) => Math.min(min, h.dueAt ?? h.receiptMs), Number.POSITIVE_INFINITY);
    if (Number.isFinite(due)) schedule(db, 'drain', due);
    if (checkpoint !== undefined) recordEvent(db, checkpoint);
    return uris;
  });
}

/** One hint row by URI. */
export function readHint(db: Db, uri: string): HintRow | null {
  return db.one<HintRow>('SELECT * FROM hints WHERE uri = ?', uri);
}

/**
 * Up to `n` hints due at `now`, in drain priority order (priority, then due
 * time, then URI). `exclude` skips URIs already in flight.
 */
export function takeDue(db: Db, now: number, n: number, exclude: ReadonlySet<string> = new Set()): HintRow[] {
  assertEpochMs('now', now);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`n must be a non-negative safe integer, got ${n}`);
  if (n === 0) return [];
  const out: HintRow[] = [];
  // Page past excluded rows without loading the whole queue.
  let offset = 0;
  const page = Math.min(Math.max(n + exclude.size, 1), 500);
  while (out.length < n) {
    const rows = db.all<HintRow>(
      'SELECT * FROM hints WHERE due_at <= ? ORDER BY priority ASC, due_at ASC, uri ASC LIMIT ? OFFSET ?',
      now,
      page,
      offset,
    );
    for (const row of rows) {
      if (!exclude.has(row.uri)) out.push(row);
      if (out.length >= n) break;
    }
    if (rows.length < page) break;
    offset += page;
  }
  return out;
}

/** Pending hints of one DID (the coalescing threshold input). */
export function countByDid(db: Db, did: string): number {
  return db.one<{ n: number }>('SELECT count(*) AS n FROM hints WHERE did = ?', did)?.n ?? 0;
}

/** The earliest `due_at` of any hint, or null when the queue is empty (for the drain timer). */
export function nextHintDue(db: Db): number | null {
  return db.one<{ next: number | null }>('SELECT min(due_at) AS next FROM hints')?.next ?? null;
}

export const HINT_BACKOFF_BASE_MS = 1_000;
export const HINT_BACKOFF_CAP_MS = 300_000;

/** Delay after the `attempts`-th failure: 1 s, 2 s, 4 s, ... capped at 5 min. */
export function hintBackoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 30);
  return Math.min(HINT_BACKOFF_CAP_MS, HINT_BACKOFF_BASE_MS * 2 ** exponent);
}

/**
 * A failed attempt: `attempts += 1`, `last_error`, and `due_at = max(now +
 * backoff(attempts), notBefore)`. Returns the new attempt count, or null when
 * the hint no longer exists.
 */
export function backoffHint(db: Db, uri: string, now: number, error: string, notBefore = 0): number | null {
  assertEpochMs('now', now);
  const row = db.one<{ attempts: number }>('SELECT attempts FROM hints WHERE uri = ?', uri);
  if (row === null) return null;
  const attempts = row.attempts + 1;
  const dueAt = Math.max(now + hintBackoffMs(attempts), notBefore);
  db.run('UPDATE hints SET attempts = ?, last_error = ?, due_at = ? WHERE uri = ?', attempts, error, dueAt, uri);
  return attempts;
}

/** Postpone a hint to `dueAt` without counting an attempt (e.g. its host is paused). */
export function deferHint(db: Db, uri: string, dueAt: number, reason: string | null = null): void {
  assertEpochMs('dueAt', dueAt);
  db.run(
    'UPDATE hints SET due_at = max(due_at, ?), last_error = coalesce(?, last_error) WHERE uri = ?',
    dueAt,
    reason,
    uri,
  );
}

/** Make a hint due again at `now` (a newer event arrived while its proof was in flight). */
export function rearmHint(db: Db, uri: string, now: number): void {
  assertEpochMs('now', now);
  db.run('UPDATE hints SET due_at = min(due_at, ?) WHERE uri = ?', now, uri);
}

export function deleteHint(db: Db, uri: string): boolean {
  return db.all<{ uri: string }>('DELETE FROM hints WHERE uri = ? RETURNING uri', uri).length > 0;
}

/** Delete every hint of `did` (coalesced into a snapshot); returns how many. */
export function deleteHintsForDid(db: Db, did: string): number {
  return db.all<{ uri: string }>('DELETE FROM hints WHERE did = ? RETURNING uri', did).length;
}
