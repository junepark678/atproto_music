// The server outbox's durable rows (ADR 0005 §5.8, §6.4; N2-05). Ports the
// IndexedDB store of web/src/outbox/store.ts and the Rust oracle's
// crates/storage/src/repositories/outbox.rs onto the `operations`,
// `operation_deps` and `listen_keys` tables of migration 2.
//
// - An operation is written in full (kind, collection, rkey, record and its
//   canonical digest, predecessors, due time) **before its first attempt**:
//   the TID rkey is allocated once from the injected clock and randomness and
//   never recomputed, so every retry and every resumed attempt after a crash
//   sends the same key and payload.
// - `record_json` and `digest` are set together. For creates and puts they
//   hold the record to write; for the delete intents that list their targets
//   when they run (follow.delete, love.delete) they hold the intent
//   (`{subject}` or `{artist, track}`) and its digest, never sent to a PDS.
// - Attempt accounting (`beginAttempt`) is persisted before the request is
//   sent, as the oracle's `begin_attempt`; there are exactly MAX_ATTEMPTS (10)
//   sends and never an eleventh.
// - States: queued → running → succeeded | failed; `blocked` while the DID's
//   OAuth session needs a new sign-in (attempts unchanged); `cancelled` for a
//   create that was never sent and was withdrawn (library.removeScrobble).
// - Predecessors (`operation_deps`): an operation runs only once every
//   predecessor is settled (succeeded, failed or cancelled). A delete waits
//   for the create of the same URI; follow, love and settings intents of one
//   target run FIFO.
//
// Every function here is synchronous and runs inside (or as) one `db.tx`, so
// no read-check-write spans an await.

import type { Operation } from '@atmusic/core/api-types';
import { canonicalDigest } from '@atmusic/core/canonical';
import type { Random } from '@atmusic/core/deps';
import { loveCollection } from '@atmusic/core/love';
import { collectionsFor } from '@atmusic/core/namespace';
import { fromMs, toDto } from '@atmusic/core/timestamp';
import { MAX_ATTEMPTS } from '@atmusic/core/write-policy';
import type { OperationKind, OperationRow, OperationState, Origin } from '../app/rows';
import type { Db } from '../do/db';

export { MAX_ATTEMPTS };

/** Live operations (web, Last.fm, ListenBrainz) run before imports (ADR §5.8). */
export const LIVE_PRIORITY = 0;
export const IMPORT_PRIORITY = 1;

export function priorityFor(origin: Origin): number {
  return origin === 'import' ? IMPORT_PRIORITY : LIVE_PRIORITY;
}

/** States after which a successor may run: the PDS write is decided (or withdrawn). */
export const SETTLED_STATES: readonly OperationState[] = ['succeeded', 'failed', 'cancelled'];
/** States that still hold their successors back. */
export const UNSETTLED_STATES: readonly OperationState[] = ['queued', 'running', 'blocked'];

export function isSettled(state: OperationState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

/** SQL list of the unsettled states, for `IN (...)`. */
export const UNSETTLED_SQL = `('queued','running','blocked')`;

/** The four collections the outbox writes. */
export interface OutboxCollections {
  scrobble: string;
  follow: string;
  settings: string;
  love: string;
}

export function outboxCollections(prefix: string): OutboxCollections {
  return { ...collectionsFor(prefix), love: loveCollection(prefix) };
}

/** A UUIDv4 from the injected randomness (OpenAPI `OperationId`: `^[A-Za-z0-9_-]{1,64}$`). */
export function newOperationId(random: Random): string {
  const b = random.bytes(16);
  if (b.length !== 16) throw new RangeError('Random.bytes(16) returned the wrong length');
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A record (or delete intent) with its canonical digest, computed before any transaction. */
export interface Prepared<T = Record<string, unknown>> {
  record: T;
  digest: string;
}

export async function prepare<T extends object>(record: T): Promise<Prepared<T>> {
  return { record, digest: await canonicalDigest(record) };
}

export interface Idempotency {
  /** 1–128 characters, scoped per DID. */
  key: string;
  /** SHA-256 of the request (32 bytes). */
  requestHash: ArrayBuffer;
}

/** Same Idempotency-Key, different request (409 `idempotency_conflict`). */
export class IdempotencyConflictError extends Error {
  constructor(readonly operationId: string) {
    super('idempotency key reused with a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export interface NewOperation {
  id: string;
  did: string;
  kind: OperationKind;
  origin: Origin;
  /** Defaults to `priorityFor(origin)`. */
  priority?: number;
  collection: string;
  rkey: string | null;
  prepared?: Prepared<object> | null;
  swapCid?: string | null;
  dueAt: number;
  importJobId?: string | null;
  idempotency?: Idempotency | null;
  predecessors?: readonly string[];
}

/** True when the DID's OAuth session needs a new sign-in (ADR §5.8 Re-authentication). */
export function accountNeedsSignIn(db: Db, did: string): boolean {
  const row = db.one<{ oauth_status: string }>('SELECT oauth_status FROM accounts WHERE did = ?', did);
  return row !== null && row.oauth_status !== 'active';
}

function equalBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * The existing operation for an Idempotency-Key: the same request gives the
 * same operation, another request throws IdempotencyConflictError. Null when
 * the key is new.
 */
export function idempotentOperation(db: Db, did: string, idempotency: Idempotency): OperationRow | null {
  const existing = db.one<OperationRow>(
    'SELECT * FROM operations WHERE did = ? AND idempotency_key = ?',
    did,
    idempotency.key,
  );
  if (existing === null) return null;
  if (existing.request_hash === null || !equalBytes(existing.request_hash, idempotency.requestHash)) {
    throw new IdempotencyConflictError(existing.id);
  }
  return existing;
}

/**
 * Persists one operation and its predecessors. A DID that must sign in again
 * gets it `blocked` at once; otherwise it is `queued`. Returns the stored row.
 */
export function insertOperation(db: Db, op: NewOperation, now: number): OperationRow {
  return db.tx(() => {
    const state: OperationState = accountNeedsSignIn(db, op.did) ? 'blocked' : 'queued';
    const prepared = op.prepared ?? null;
    db.run(
      `INSERT INTO operations(id, did, kind, origin, priority, collection, rkey, record_json, digest, swap_cid,
         state, attempts, due_at, idempotency_key, request_hash, import_job_id, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      op.id,
      op.did,
      op.kind,
      op.origin,
      op.priority ?? priorityFor(op.origin),
      op.collection,
      op.rkey,
      prepared === null ? null : JSON.stringify(prepared.record),
      prepared === null ? null : prepared.digest,
      op.swapCid ?? null,
      state,
      op.dueAt,
      op.idempotency?.key ?? null,
      op.idempotency?.requestHash ?? null,
      op.importJobId ?? null,
      now,
      now,
    );
    for (const pred of new Set(op.predecessors ?? [])) {
      if (pred === op.id) continue;
      db.run('INSERT OR IGNORE INTO operation_deps(op_id, pred_id) VALUES (?, ?)', op.id, pred);
    }
    return db.one<OperationRow>('SELECT * FROM operations WHERE id = ?', op.id)!;
  });
}

export function loadOperation(db: Db, id: string): OperationRow | null {
  return db.one<OperationRow>('SELECT * FROM operations WHERE id = ?', id);
}

/** The predecessors of `id`, in insertion order. */
export function predecessorRows(db: Db, id: string): OperationRow[] {
  return db.all<OperationRow>(
    `SELECT p.* FROM operation_deps d JOIN operations p ON p.id = d.pred_id WHERE d.op_id = ? ORDER BY p.rowid`,
    id,
  );
}

/** Unsettled operations of `did` at one record key (a delete waits for them). */
export function unsettledAt(db: Db, did: string, collection: string, rkey: string): string[] {
  return db
    .all<{ id: string }>(
      `SELECT id FROM operations WHERE did = ? AND collection = ? AND rkey = ? AND state IN ${UNSETTLED_SQL}
       ORDER BY rowid`,
      did,
      collection,
      rkey,
    )
    .map((r) => r.id);
}

/** Unsettled operations of `did` of the given kinds. */
export function unsettledOfKinds(db: Db, did: string, kinds: readonly OperationKind[]): OperationRow[] {
  const marks = kinds.map(() => '?').join(',');
  return db.all<OperationRow>(
    `SELECT * FROM operations WHERE did = ? AND kind IN (${marks}) AND state IN ${UNSETTLED_SQL} ORDER BY rowid`,
    did,
    ...kinds,
  );
}

/** The record (or intent) of an operation, parsed. */
export function recordOf(op: Pick<OperationRow, 'record_json'>): Record<string, unknown> | null {
  if (op.record_json === null) return null;
  const value: unknown = JSON.parse(op.record_json);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `at://did/collection/rkey` of an operation with a record key. */
export function operationUri(op: Pick<OperationRow, 'did' | 'collection' | 'rkey'>): string | null {
  return op.rkey === null ? null : `at://${op.did}/${op.collection}/${op.rkey}`;
}

const MAX_IDS_PER_STATEMENT = 90;

function chunks<T>(items: readonly T[], size = MAX_IDS_PER_STATEMENT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Persists the attempt before the send: `running`, attempts + 1. Only rows
 * still queued or left running by a crashed process, with attempts left,
 * start; returns the started rows (in the order of `ids`).
 */
export function beginAttempts(db: Db, ids: readonly string[], now: number): OperationRow[] {
  return db.tx(() => {
    const started = new Map<string, OperationRow>();
    for (const part of chunks(ids)) {
      const marks = part.map(() => '?').join(',');
      const rows = db.all<OperationRow>(
        `UPDATE operations SET state = 'running', attempts = attempts + 1, updated_at_ms = ?
         WHERE id IN (${marks}) AND state IN ('queued','running') AND attempts < ${MAX_ATTEMPTS}
         RETURNING *`,
        now,
        ...part,
      );
      for (const row of rows) started.set(row.id, row);
    }
    return ids.flatMap((id) => {
      const row = started.get(id);
      return row === undefined ? [] : [row];
    });
  });
}

/** Fields of the running row persisted before a send (the delete's `swapRecord`). */
export function persistRunning(db: Db, id: string, patch: { swapCid?: string }, now: number): void {
  if (patch.swapCid === undefined) return;
  db.run(
    `UPDATE operations SET swap_cid = ?, updated_at_ms = ? WHERE id = ? AND state = 'running'`,
    patch.swapCid,
    now,
    id,
  );
}

/**
 * Sets every queued (or orphaned running) operation of `did` to `blocked`.
 * Attempts are not touched. Returns how many were blocked.
 */
export function blockOperations(db: Db, did: string, now: number): number {
  return db.run(
    `UPDATE operations SET state = 'blocked', last_error = 'reauth_required', updated_at_ms = ?
     WHERE did = ? AND state IN ('queued','running')`,
    now,
    did,
  ).rowsWritten;
}

/**
 * After a new sign-in (`onSessionUpdated`, ADR §5.8): blocked operations of
 * `did` are queued again with their attempts and due times unchanged.
 */
export function unblockOperations(db: Db, did: string, now: number): number {
  return db.run(
    `UPDATE operations SET state = 'queued', last_error = NULL, updated_at_ms = ? WHERE did = ? AND state = 'blocked'`,
    now,
    did,
  ).rowsWritten;
}

/** An unsent operation: queued or blocked, never attempted. */
export function isUnsent(op: Pick<OperationRow, 'state' | 'attempts'>): boolean {
  return (op.state === 'queued' || op.state === 'blocked') && op.attempts === 0;
}

/**
 * Withdraws an operation that was never sent: `cancelled`, its listen keys
 * deleted (so a deliberate re-scrobble is accepted again) and its unsent
 * forward rows deleted. Returns false (changing nothing) when it was sent.
 */
export function cancelUnsent(db: Db, id: string, now: number): boolean {
  return db.tx(() => {
    const op = loadOperation(db, id);
    if (op === null || !isUnsent(op)) return false;
    db.run(`UPDATE operations SET state = 'cancelled', updated_at_ms = ? WHERE id = ?`, now, id);
    const keys = db.all<{ dedupe_key: string }>(
      'SELECT dedupe_key FROM listen_keys WHERE did = ? AND operation_id = ?',
      op.did,
      id,
    );
    for (const { dedupe_key } of keys) {
      db.run(
        `DELETE FROM forward_outbox WHERE did = ? AND kind = 'scrobble' AND dedupe_key = ? AND state IN ('queued','held')`,
        op.did,
        dedupe_key,
      );
    }
    // A love or unlove forward is keyed by the operation id (ADR §12.2).
    db.run(
      `DELETE FROM forward_outbox WHERE did = ? AND kind IN ('love','unlove') AND dedupe_key = ? AND state IN ('queued','held')`,
      op.did,
      id,
    );
    db.run('DELETE FROM listen_keys WHERE did = ? AND operation_id = ?', op.did, id);
    return true;
  });
}

/** Account disconnect (ADR §5.7): every never-sent operation of `did` is cancelled. Returns the ids. */
export function cancelUnsentForDid(db: Db, did: string, now: number): string[] {
  return db.tx(() => {
    const ids = db
      .all<{ id: string }>(
        `SELECT id FROM operations WHERE did = ? AND state IN ('queued','blocked') AND attempts = 0 ORDER BY rowid`,
        did,
      )
      .map((r) => r.id);
    return ids.filter((id) => cancelUnsent(db, id, now));
  });
}

/** The `GET /api/v1/operations/{id}` DTO (contract v1.2). */
export function operationDto(op: OperationRow): Operation {
  const base = {
    id: op.id,
    kind: op.kind,
    origin: op.origin,
    attempts: op.attempts,
    ...(op.result_uri !== null ? { uri: op.result_uri } : {}),
    ...(op.result_cid !== null ? { cid: op.result_cid } : {}),
    createdAt: toDto(fromMs(op.created_at_ms)),
    updatedAt: toDto(fromMs(op.updated_at_ms)),
  };
  switch (op.state) {
    case 'failed':
      return { ...base, state: 'failed', error: op.last_error ?? 'operation_failed' };
    case 'succeeded':
    case 'blocked':
      return { ...base, state: op.state, ...(op.last_error !== null ? { error: op.last_error } : {}) };
    default:
      return { ...base, state: op.state };
  }
}
