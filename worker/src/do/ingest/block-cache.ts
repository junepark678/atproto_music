// The snapshot block cache over `snapshot_blocks(did, cid, bytes)` (ADR 0004
// §5.7 steps 4 and 10, §6.1).
//
// The range walker (packages/atproto/src/snapshot/walker.ts) writes every MST
// node it fetches through `put` and reads nodes back through `get` in later
// slices; after a getRepo stream (the getBlocks fallback) the cache holds
// every block of the repository and the walker runs over it alone. Rows are
// derived data: the walker re-hashes every block it reads from the cache
// (`verifyBlock`), so a corrupted row is `cid_mismatch`, never a forged node.
//
// Writes are buffered. `put` keeps the block in memory and `flush` writes the
// buffer, so a snapshot slice writes the cache only inside its lease-guarded
// transactions (snapshot-job.ts): a slice that lost its job (a reclaim, a
// generation change) writes nothing at all, not even cache rows. When the
// buffer grows past `maxPendingBytes` (a getRepo stream of up to 32 MiB), the
// `onOverflow` hook lets the owner flush it under the guard in the middle of
// the stream, which bounds memory to the threshold plus one block.
//
// Synchronous throughout; `flush` and `clearBlockCache` run inside the
// caller's `db.tx`.

import type { BlockCache } from '@atmusic/atproto/snapshot/block-source';
import type { Db } from '../db';

/** Buffered bytes at which `onOverflow` is called (getRepo streams). */
export const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

export interface SnapshotBlockCacheOptions {
  /** Called synchronously from `put` once the buffer exceeds `maxPendingBytes`. */
  onOverflow?: (cache: SnapshotBlockCache) => void;
  maxPendingBytes?: number;
}

/** A BlockCache for one DID over `snapshot_blocks`, with buffered writes. */
export class SnapshotBlockCache implements BlockCache {
  private readonly pending = new Map<string, Uint8Array>();
  private pendingSize = 0;
  private readonly maxPendingBytes: number;

  constructor(
    private readonly db: Db,
    readonly did: string,
    private readonly o: SnapshotBlockCacheOptions = {},
  ) {
    this.maxPendingBytes = o.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    if (!Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes < 1) {
      throw new RangeError('maxPendingBytes must be a positive integer');
    }
  }

  get(cid: string): Uint8Array | null {
    const buffered = this.pending.get(cid);
    if (buffered !== undefined) return buffered;
    const row = this.db.one<{ bytes: ArrayBuffer }>(
      'SELECT bytes FROM snapshot_blocks WHERE did = ? AND cid = ?',
      this.did,
      cid,
    );
    return row === null ? null : new Uint8Array(row.bytes);
  }

  put(cid: string, bytes: Uint8Array): void {
    if (this.pending.has(cid)) return;
    this.pending.set(cid, bytes);
    this.pendingSize += bytes.length;
    if (this.pendingSize > this.maxPendingBytes) this.o.onOverflow?.(this);
  }

  /** Blocks buffered and not yet written. */
  get pendingBlocks(): number {
    return this.pending.size;
  }

  get pendingBytes(): number {
    return this.pendingSize;
  }

  /**
   * Write the buffered blocks (an existing row is kept: same CID, same bytes).
   * Call inside the slice's guarded transaction; the buffer is kept, so a
   * rolled-back transaction loses nothing. Call `discard` once it committed.
   * Returns the blocks written.
   */
  flush(): number {
    let n = 0;
    for (const [cid, bytes] of this.pending) {
      this.db.run(
        'INSERT INTO snapshot_blocks(did, cid, bytes) VALUES (?, ?, ?) ON CONFLICT(did, cid) DO NOTHING',
        this.did,
        cid,
        bytes.slice().buffer,
      );
      n++;
    }
    return n;
  }

  /** Drop the buffer: after the flushing transaction committed, or when the slice lost its job. */
  discard(): void {
    this.pending.clear();
    this.pendingSize = 0;
  }
}

/** Delete every cached block of `did` (a finished or abandoned walk). Returns the rows deleted. */
export function clearBlockCache(db: Db, did: string): number {
  // Counted first rather than RETURNING every row: a getRepo cache can hold a whole repository.
  const n = db.one<{ n: number }>('SELECT count(*) AS n FROM snapshot_blocks WHERE did = ?', did)?.n ?? 0;
  if (n > 0) db.run('DELETE FROM snapshot_blocks WHERE did = ?', did);
  return n;
}

/** Cached blocks of `did`: count and total bytes. */
export function blockCacheSize(db: Db, did: string): { blocks: number; bytes: number } {
  return (
    db.one<{ blocks: number; bytes: number }>(
      'SELECT count(*) AS blocks, coalesce(sum(length(bytes)), 0) AS bytes FROM snapshot_blocks WHERE did = ?',
      did,
    ) ?? { blocks: 0, bytes: 0 }
  );
}
