// Free space on the state filesystem (ADR 0005 §3.10 readiness `low_disk`,
// §5.5 keepalive and store, §11.1 upload floor, §14.5 backups; N1-07).
//
// `freeBytes(path)` is the space an unprivileged process may still allocate
// (`f_bavail * f_bsize` from statfs(2)), and `diskLow(path, minFree)` is true
// exactly when that is below the floor (ATMUSIC_MIN_FREE_BYTES). The statfs
// call is an injected function so tests decide the reported numbers; the
// default is node:fs `statfsSync` with bigint results, so no product of two
// large counts is ever rounded.
//
// A statfs failure (the directory vanished, EACCES) makes `freeBytes` throw.
// `diskLow` treats it as low: every caller uses the predicate to pause writing
// (keepalive, import writer, backups) or to warn (readiness), and pausing is the
// safe side when the free space cannot be known.

import { statfsSync } from 'node:fs';

/** The two statfs fields used, as numbers or bigints. */
export interface StatfsResult {
  /** Free blocks available to an unprivileged process. */
  bavail: number | bigint;
  /** Block size in bytes (the unit of bavail). */
  bsize: number | bigint;
}

export type StatfsFn = (path: string) => StatfsResult;

/** node:fs statfsSync with bigint fields. */
export const nodeStatfs: StatfsFn = (path) => statfsSync(path, { bigint: true });

/** Bytes an unprivileged process may still allocate on the filesystem holding `path`. */
export function freeBytes(path: string, statfs: StatfsFn = nodeStatfs): bigint {
  const { bavail, bsize } = statfs(path);
  const free = BigInt(bavail) * BigInt(bsize);
  if (free < 0n) throw new RangeError('statfs reported negative free space');
  return free;
}

/** True when fewer than `minFree` bytes are free at `path` (or statfs fails). */
export function diskLow(path: string, minFree: number | bigint, statfs: StatfsFn = nodeStatfs): boolean {
  let free: bigint;
  try {
    free = freeBytes(path, statfs);
  } catch {
    return true;
  }
  return free < BigInt(minFree);
}

/** The injected `diskLow()` predicate the keepalive, import writer and readiness take. */
export function diskLowProbe(path: string, minFree: number | bigint, statfs: StatfsFn = nodeStatfs): () => boolean {
  return () => diskLow(path, minFree, statfs);
}
