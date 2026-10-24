// The SPA outbox's durable state (ADR 0004 §5.2 step 2, §9 A11/A12).
//
// One IndexedDB database with two object stores:
// - `operations`: one row per write intent, keyed by `id`. A row is written in
//   full (record, rkey, digest, predecessors) **before the first attempt**, so a
//   crash at any later point resumes the same operation with the same rkey.
// - `meta`: small counters, today only the FIFO sequence (`seq`).
//
// Every read-modify-write runs inside one readwrite transaction that awaits
// only IndexedDB requests (no other async work), so the transaction cannot
// auto-commit halfway and two tabs cannot interleave a half-applied update.
// Attempt accounting (`beginAttempt`) is persisted before the request is sent,
// exactly like the Rust oracle's `begin_attempt` (crates/storage/src/repositories/outbox.rs).

import type { AtUri, Did } from '@atmusic/core/api-types';
import { MAX_ATTEMPTS } from '@atmusic/core/write-policy';

export const OUTBOX_DB_NAME = 'atmusic-outbox';
export const OUTBOX_DB_VERSION = 1;

export type OperationKind =
  | 'scrobble_create'
  | 'scrobble_delete'
  | 'follow_create'
  | 'follow_delete'
  | 'settings_put'
  | 'settings_delete';

/**
 * - `queued`: waiting for its due time or its predecessors.
 * - `running`: an attempt was persisted and is (or was, before a crash) in flight.
 * - `published`: the PDS write is done; notify and records/status polling follow.
 * - `indexed`: the AppView reports the expected state (present, or absent for a delete).
 * - `failed`: terminal, with `failureCode`.
 */
export type OperationState = 'queued' | 'running' | 'published' | 'indexed' | 'failed';

/** A follow record found by unfollow's listRecords: deleted with `swapRecord: cid`. */
export interface DeleteTarget {
  uri: AtUri;
  rkey: string;
  cid: string;
}

export interface OutboxOperation {
  id: string;
  did: Did;
  kind: OperationKind;
  collection: string;
  /** The record key: a TID allocated once, the deterministic follow rkey, or `self`. */
  rkey: string;
  /** `at://did/collection/rkey`. */
  uri: AtUri;
  /** The exact record to create or put (never re-built after persisting). */
  record?: Record<string, unknown>;
  /** Lowercase hex sha256 of the canonical JSON of `record` (W1-03 canonical.ts). */
  digest?: string;
  /** The `swapRecord` CID a delete sends; re-fetched after InvalidSwap. */
  swapCid?: string;
  /** Follow and unfollow: the subject DID. */
  subject?: Did;
  /** Operations of the same DID that must be settled (published, indexed or failed) first. */
  predecessorIds: string[];
  /** Sends persisted so far; never exceeds MAX_ATTEMPTS. */
  attempts: number;
  /** Epoch ms of the next write attempt or status poll; null when nothing is scheduled. */
  dueAt: number | null;
  state: OperationState;
  failureCode?: string;
  /** Exclusion reason reported by records/status (failureCode `record_excluded`). */
  reason?: string;
  /**
   * Set when the operation finished without a PDS write because local state
   * already proved it (state `indexed`): `record_not_ours` for a delete whose
   * create ended `remote_record_conflict`.
   */
  localCompletion?: string;
  /** Code of the last transient failure, kept while retrying. */
  lastError?: string;
  /** CID of the published record (create/put). */
  cid?: string;
  /** Unfollow: the records deleted on the PDS, tracked until each is absent. */
  targets?: DeleteTarget[];
  /** Whether notify was accepted for this publication. */
  notified: boolean;
  /** records/status polls made since publication. */
  polls: number;
  /** FIFO order within the database. */
  seq: number;
  createdAt: number;
  updatedAt: number;
}

/** States after which a successor may run: the PDS write is decided. */
export function isSettled(state: OperationState): boolean {
  return state === 'published' || state === 'indexed' || state === 'failed';
}

/** States that still need a PDS write. */
export function isUnsent(state: OperationState): boolean {
  return state === 'queued' || state === 'running';
}

export interface OpenOutboxOptions {
  /** The IndexedDB factory; defaults to `globalThis.indexedDB`. Tests pass a fresh fake-indexeddb factory. */
  indexedDB?: IDBFactory;
  name?: string;
}

/** What `enqueue` hands the builder: the DID's current rows and the next sequence number. */
export interface EnqueueContext {
  existing: readonly OutboxOperation[];
  seq: number;
}

export class OutboxStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OutboxStoreError';
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new OutboxStoreError('IndexedDB request failed', { cause: req.error }));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(new OutboxStoreError('IndexedDB transaction aborted', { cause: tx.error }));
    tx.onerror = () => reject(new OutboxStoreError('IndexedDB transaction failed', { cause: tx.error }));
  });
}

function bySeq(a: OutboxOperation, b: OutboxOperation): number {
  return a.seq - b.seq;
}

export class OutboxStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(options: OpenOutboxOptions = {}): Promise<OutboxStore> {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (factory === undefined) throw new OutboxStoreError('IndexedDB is not available');
    const open = factory.open(options.name ?? OUTBOX_DB_NAME, OUTBOX_DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('operations')) {
        const ops = db.createObjectStore('operations', { keyPath: 'id' });
        ops.createIndex('did', 'did', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    const db = await request(open);
    return new OutboxStore(db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Persists one new operation. `build` runs inside the transaction with the
   * DID's current rows (to compute predecessors) and the allocated sequence
   * number; it must be synchronous. Throws whatever `build` throws, writing nothing.
   */
  async enqueue(did: Did, build: (ctx: EnqueueContext) => OutboxOperation): Promise<OutboxOperation> {
    const tx = this.db.transaction(['operations', 'meta'], 'readwrite');
    const finished = done(tx);
    try {
      const ops = tx.objectStore('operations');
      const meta = tx.objectStore('meta');
      const existing = ((await request(ops.index('did').getAll(did))) as OutboxOperation[]).sort(bySeq);
      const counter = (await request(meta.get('seq'))) as { key: 'seq'; value: number } | undefined;
      const seq = (counter?.value ?? 0) + 1;
      const op = build({ existing, seq });
      if (op.did !== did || op.seq !== seq) throw new OutboxStoreError('enqueue builder changed did or seq');
      meta.put({ key: 'seq', value: seq });
      ops.add(op);
      await finished;
      return op;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // already finished or aborted
      }
      await finished.catch(() => undefined);
      throw error;
    }
  }

  async get(id: string): Promise<OutboxOperation | null> {
    const tx = this.db.transaction('operations', 'readonly');
    const op = (await request(tx.objectStore('operations').get(id))) as OutboxOperation | undefined;
    return op ?? null;
  }

  /** Every operation of `did`, oldest first. */
  async list(did: Did): Promise<OutboxOperation[]> {
    const tx = this.db.transaction('operations', 'readonly');
    const ops = (await request(tx.objectStore('operations').index('did').getAll(did))) as OutboxOperation[];
    return ops.sort(bySeq);
  }

  /** Row count, optionally for one DID. */
  async count(did?: Did): Promise<number> {
    const tx = this.db.transaction('operations', 'readonly');
    const store = tx.objectStore('operations');
    return request(did === undefined ? store.count() : store.index('did').count(did));
  }

  /**
   * Atomic read-modify-write of one row. `mutate` gets a copy and returns the
   * new row, or null to leave it unchanged. Returns the stored row (or null
   * when the row does not exist or `mutate` declined).
   */
  async update(
    id: string,
    mutate: (op: OutboxOperation, predecessors: readonly (OutboxOperation | null)[]) => OutboxOperation | null,
  ): Promise<OutboxOperation | null> {
    const tx = this.db.transaction('operations', 'readwrite');
    const finished = done(tx);
    const store = tx.objectStore('operations');
    let result: OutboxOperation | null = null;
    try {
      const current = (await request(store.get(id))) as OutboxOperation | undefined;
      if (current !== undefined) {
        const predecessors: (OutboxOperation | null)[] = [];
        for (const pid of current.predecessorIds) {
          predecessors.push(((await request(store.get(pid))) as OutboxOperation | undefined) ?? null);
        }
        const next = mutate(structuredClone(current), predecessors);
        if (next !== null) {
          if (next.id !== id) throw new OutboxStoreError('update changed the operation id');
          store.put(next);
          result = next;
        }
      }
      await finished;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      await finished.catch(() => undefined);
      throw error;
    }
  }

  /**
   * Persists the start of an attempt before anything is sent: the row must be
   * queued (or running, left behind by a crashed runner), have attempts left,
   * and every predecessor must be settled. Sets `running` and `attempts + 1`.
   * Returns the updated row, or null when the attempt must not start.
   */
  beginAttempt(id: string, nowMs: number): Promise<OutboxOperation | null> {
    return this.update(id, (op, predecessors) => {
      if (!isUnsent(op.state) || op.attempts >= MAX_ATTEMPTS) return null;
      if (predecessors.some((p) => p !== null && !isSettled(p.state))) return null;
      op.state = 'running';
      op.attempts += 1;
      op.updatedAt = nowMs;
      return op;
    });
  }

  /** Deletes every row (sign-out clears the outbox with the rest of IndexedDB). */
  async clear(): Promise<void> {
    const tx = this.db.transaction(['operations', 'meta'], 'readwrite');
    const finished = done(tx);
    tx.objectStore('operations').clear();
    tx.objectStore('meta').clear();
    await finished;
  }
}

export function openOutboxStore(options?: OpenOutboxOptions): Promise<OutboxStore> {
  return OutboxStore.open(options);
}

/** A fresh operation id: a UUIDv4 shape from the injected random bytes. */
export function newOperationId(random: { bytes(n: number): Uint8Array }): string {
  const b = random.bytes(16);
  if (b.length !== 16) throw new RangeError('Random.bytes(16) returned the wrong length');
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The fields every new operation starts with. */
export function freshOperation(
  fields: Pick<OutboxOperation, 'id' | 'did' | 'kind' | 'collection' | 'rkey' | 'uri' | 'predecessorIds' | 'seq'> &
    Partial<Pick<OutboxOperation, 'record' | 'digest' | 'subject' | 'swapCid'>>,
  nowMs: number,
): OutboxOperation {
  const op: OutboxOperation = {
    ...fields,
    attempts: 0,
    dueAt: nowMs,
    state: 'queued',
    notified: false,
    polls: 0,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  return op;
}
