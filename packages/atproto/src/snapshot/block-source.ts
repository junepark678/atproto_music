// Block sources and the block cache for the range walker (ADR 0004 §5.7).
//
// A BlockSource answers CIDs with bytes: getBlocks over HTTP
// (getblocks-source.ts), a cache filled from a getRepo stream
// (getrepo-source.ts), or a memory map in tests. A source may omit a CID it
// cannot serve; the walker turns every omission into `missing_block`, never
// into absence. Sources hand back only CID-checked bytes, and the walker
// re-checks every block it uses regardless (`verifyBlock`), so a faulty
// source or a corrupted cache row is `cid_mismatch`, never a forged node.
//
// The BlockCache holds MST nodes across walker steps (and, after a getRepo
// stream, every block of the repository). The worker implements it over
// `snapshot_blocks(did, cid)`; MemoryBlockCache is the in-memory form.

import * as CID from '@atcute/cid';
import { VerifyError } from '../verify/types';

export interface BlockSource {
  /** Bytes for as many of `cids` as the source has. Omitted CIDs are missing. */
  get(cids: string[]): Promise<Map<string, Uint8Array>>;
}

export interface BlockCache {
  get(cid: string): Uint8Array | null;
  put(cid: string, bytes: Uint8Array): void;
}

export type BlockSourceErrorCode = 'unsupported';

/**
 * The source cannot serve blocks at all (getBlocks answered 501, 404 or
 * MethodNotImplemented). The snapshot job then switches to the getRepo stream.
 */
export class BlockSourceError extends Error {
  constructor(
    readonly code: BlockSourceErrorCode,
    msg?: string,
  ) {
    super(msg ?? code);
    this.name = 'BlockSourceError';
  }
}

export function isBlockSourceError(value: unknown, code?: BlockSourceErrorCode): value is BlockSourceError {
  return value instanceof BlockSourceError && (code === undefined || value.code === code);
}

/** A Map-backed BlockCache (tests, browser, a single-isolate job). */
export class MemoryBlockCache implements BlockCache {
  readonly blocks = new Map<string, Uint8Array>();
  get(cid: string): Uint8Array | null {
    return this.blocks.get(cid) ?? null;
  }
  put(cid: string, bytes: Uint8Array): void {
    this.blocks.set(cid, bytes);
  }
  get size(): number {
    return this.blocks.size;
  }
}

/** A source that serves only what `cache` holds (after a getRepo stream). */
export function cacheOnlySource(cache: BlockCache): BlockSource {
  return {
    get: async (cids) => {
      const out = new Map<string, Uint8Array>();
      for (const cid of cids) {
        const bytes = cache.get(cid);
        if (bytes !== null) out.set(cid, bytes);
      }
      return out;
    },
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Parse a CID string the walker may fetch: CIDv1, dag-cbor or raw, sha2-256, 32-byte digest. */
export function parseBlockCid(cid: string): CID.Cid {
  let parsed: CID.Cid;
  try {
    parsed = CID.fromString(cid);
  } catch {
    throw new VerifyError('car_malformed', `not a CID: ${cid}`);
  }
  if (
    parsed.version !== CID.CID_VERSION ||
    (parsed.codec !== CID.CODEC_DCBOR && parsed.codec !== CID.CODEC_RAW) ||
    parsed.digest.codec !== CID.HASH_SHA256 ||
    parsed.digest.contents.length !== 32
  ) {
    throw new VerifyError('car_malformed', `unsupported CID ${cid}`);
  }
  return parsed;
}

/** Throw `cid_mismatch` unless `bytes` hash to `cid` (CIDv1 dag-cbor/raw sha2-256). */
export function verifyBlock(cid: string, bytes: Uint8Array): void {
  const parsed = parseBlockCid(cid);
  const actual = CID.createSync(parsed.codec as typeof CID.CODEC_DCBOR | typeof CID.CODEC_RAW, bytes);
  if (!sameBytes(actual.digest.contents, parsed.digest.contents)) {
    throw new VerifyError('cid_mismatch', `block ${cid} hashes to ${CID.toString(actual)}`);
  }
}
