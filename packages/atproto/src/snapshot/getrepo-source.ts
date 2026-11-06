// `com.atproto.sync.getRepo` fallback (ADR 0004 §5.7 step 10), for PDSs whose
// getBlocks is unsupported.
//
// The repository CAR is streamed through SafeFetch kind `getRepo` (32 MiB
// cap, enforced while streaming: the upstream body is cancelled the moment
// the cap is crossed). Sections are parsed incrementally, so no more than one
// section (≤ 2 MiB) plus one transport chunk is buffered. Each block gets the
// car-bounds checks — CIDv1, dag-cbor or raw, sha2-256, 32-byte digest,
// lengths against the section, bytes re-hashed against the CID — and only
// then is written to the BlockCache. A block that fails stops the stream
// before it, or anything after it, reaches the cache.
//
// Afterwards the source is cache-only: the walker reads every node and record
// from the cache, and anything the CAR lacked is `missing_block`.
//
// Errors: car_too_large (byte cap, block cap), car_malformed (framing, header,
// unsupported CID, truncation), cid_mismatch (a block that does not hash to
// its CID). Other SafeFetchErrors (HTTP status, timeout) propagate.

import { CidLinkWrapper, decode } from '@atcute/cbor';
import * as CID from '@atcute/cid';
import { KIND_CAPS, type SafeFetch, SafeFetchError } from '../net/safe-fetch';
import { VerifyError } from '../verify/types';
import { type BlockCache, type BlockSource, cacheOnlySource } from './block-source';

export const GET_REPO_MAX_BYTES = KIND_CAPS.getRepo;
/** Largest single CAR section accepted from a stream (bounds what is buffered). */
export const MAX_STREAM_SECTION_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const CID_BYTES = 36;
const NSID = 'com.atproto.sync.getRepo';

export interface CarStreamOptions {
  /** Section cap; more sections is car_too_large. Default: unbounded (the byte cap bounds it). */
  maxBlocks?: number;
}

export interface CarStreamResult {
  /** The first header root (the commit), base32. */
  root: string;
  /** Sections read (duplicates included). */
  blocks: number;
  /** Bytes read. */
  bytes: number;
}

const malformed = (msg: string) => new VerifyError('car_malformed', msg);

/** Bytes received but not yet consumed, kept as the chunks they arrived in. */
class ByteQueue {
  private readonly chunks: Uint8Array[] = [];
  private offset = 0; // into chunks[0]
  length = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  peek(index: number): number {
    let i = index + this.offset;
    for (const c of this.chunks) {
      if (i < c.length) return c[i]!;
      i -= c.length;
    }
    throw new RangeError('peek past the buffered bytes');
  }

  /** Remove and return the next `n` bytes as one fresh copy. */
  take(n: number): Uint8Array<ArrayBuffer> {
    if (n > this.length) throw new RangeError('take past the buffered bytes');
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const c = this.chunks[0]!;
      const avail = c.length - this.offset;
      const k = Math.min(avail, n - filled);
      out.set(c.subarray(this.offset, this.offset + k), filled);
      filled += k;
      this.offset += k;
      if (this.offset === c.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    this.length -= n;
    return out;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Parse a CARv1 stream section by section, handing each CID-verified block to
 * `onBlock` before the next section is read. Cancels `stream` on any failure.
 */
export async function readCarStream(
  stream: ReadableStream<Uint8Array>,
  onBlock: (cid: string, bytes: Uint8Array<ArrayBuffer>) => void,
  opts: CarStreamOptions = {},
): Promise<CarStreamResult> {
  const maxBlocks = opts.maxBlocks ?? Number.POSITIVE_INFINITY;
  const reader = stream.getReader();
  const queue = new ByteQueue();
  let ended = false;
  let total = 0;

  /** Buffer at least `n` bytes; false when the stream ended first. */
  const fill = async (n: number): Promise<boolean> => {
    while (queue.length < n && !ended) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (e) {
        if (e instanceof SafeFetchError && e.code === 'body_too_large') {
          throw new VerifyError('car_too_large', `getRepo CAR exceeds ${e.maxBytes ?? GET_REPO_MAX_BYTES} bytes`);
        }
        throw e;
      }
      if (step.done) ended = true;
      else {
        total += step.value.length;
        queue.push(step.value);
      }
    }
    return queue.length >= n;
  };

  /** A minimal unsigned LEB128 varint of at most 8 bytes, or null at a clean end of stream. */
  const varint = async (what: string, atEndOk: boolean): Promise<number | null> => {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      if (!(await fill(i + 1))) {
        if (i === 0 && atEndOk) return null;
        throw malformed(`truncated ${what} length`);
      }
      const b = queue.peek(i);
      value += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) {
        if (b === 0 && i > 0) throw malformed(`non-minimal ${what} length`);
        queue.take(i + 1);
        return value;
      }
      scale *= 0x80;
    }
    throw malformed(`overlong ${what} length`);
  };

  try {
    const headerLen = (await varint('CAR header', false))!;
    if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) throw malformed(`CAR header length ${headerLen}`);
    if (!(await fill(headerLen))) throw malformed('truncated CAR header');
    let header: unknown;
    try {
      header = decode(queue.take(headerLen));
    } catch (e) {
      throw malformed(`CAR header: ${e instanceof Error ? e.message : String(e)}`);
    }
    const h = header as { version?: unknown; roots?: unknown } | null;
    if (h === null || typeof h !== 'object' || Array.isArray(h) || h.version !== 1 || !Array.isArray(h.roots)) {
      throw malformed('CAR header is not a version 1 header with a roots array');
    }
    const first: unknown = h.roots[0];
    if (!(first instanceof CidLinkWrapper)) throw malformed('CAR header has no root link');
    const root = CID.fromCidLink(first);
    if (root.codec !== CID.CODEC_DCBOR || root.digest.codec !== CID.HASH_SHA256 || root.digest.contents.length !== 32) {
      throw malformed('CAR root is not a dag-cbor sha2-256 CID');
    }

    let blocks = 0;
    for (;;) {
      const len = await varint('CAR section', true);
      if (len === null) break;
      if (blocks === maxBlocks) throw new VerifyError('car_too_large', `CAR has more than ${maxBlocks} blocks`);
      if (len < CID_BYTES) throw malformed(`section ${blocks} is ${len} bytes, shorter than a CID`);
      if (len > MAX_STREAM_SECTION_BYTES) {
        throw new VerifyError('car_too_large', `section ${blocks} is ${len} bytes, cap ${MAX_STREAM_SECTION_BYTES}`);
      }
      if (!(await fill(len))) throw malformed(`section ${blocks} is truncated`);
      const section = queue.take(len);
      const [version, codec, hash, size] = section;
      if (version !== CID.CID_VERSION) throw malformed(`section ${blocks}: not a CIDv1`);
      if (codec !== CID.CODEC_DCBOR && codec !== CID.CODEC_RAW) {
        throw malformed(`section ${blocks}: unsupported CID codec 0x${(codec ?? 0).toString(16)}`);
      }
      if (hash !== CID.HASH_SHA256)
        throw malformed(`section ${blocks}: unsupported hash 0x${(hash ?? 0).toString(16)}`);
      if (size !== 32) throw malformed(`section ${blocks}: digest size ${size}, expected 32`);
      const digest = section.subarray(4, CID_BYTES);
      const bytes = section.slice(CID_BYTES);
      const actual = CID.createSync(codec, bytes);
      const declared = CID.toString(CID.fromDigest(codec, digest));
      if (!sameBytes(actual.digest.contents, digest)) {
        throw new VerifyError('cid_mismatch', `block ${declared} hashes to ${CID.toString(actual)}`);
      }
      onBlock(declared, bytes);
      blocks++;
    }
    return { root: CID.toString(root), blocks, bytes: total };
  } catch (e) {
    reader.cancel(e).catch(() => {});
    throw e;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read keeps the lock; the stream is already cancelled.
    }
  }
}

export interface GetRepoSourceOptions {
  safeFetch: SafeFetch;
  /** PDS origin, e.g. `https://pds.example.com`. */
  pds: string;
  did: string;
  /** Every verified block of the stream is written here. */
  cache: BlockCache;
  maxBlocks?: number;
}

/** Stream the repository CAR into `cache`. Returns its root (the served head commit). */
export async function streamRepoIntoCache(o: GetRepoSourceOptions): Promise<CarStreamResult> {
  const url = new URL(`/xrpc/${NSID}`, o.pds);
  url.searchParams.set('did', o.did);
  let body: ReadableStream<Uint8Array>;
  try {
    ({ body } = await o.safeFetch.stream(url, { kind: 'getRepo' }));
  } catch (e) {
    if (e instanceof SafeFetchError && e.code === 'body_too_large') {
      throw new VerifyError('car_too_large', `getRepo CAR exceeds ${GET_REPO_MAX_BYTES} bytes`);
    }
    throw e;
  }
  return readCarStream(body, (cid, bytes) => o.cache.put(cid, bytes), { maxBlocks: o.maxBlocks });
}

export interface GetRepoSource extends BlockSource {
  /** Stream the CAR into the cache (once; later calls return the same result). */
  load(): Promise<CarStreamResult>;
}

/** A BlockSource that streams getRepo into the cache on first use, then serves the cache only. */
export function getRepoSource(o: GetRepoSourceOptions): GetRepoSource {
  let loading: Promise<CarStreamResult> | null = null;
  const cached = cacheOnlySource(o.cache);
  const load = () => {
    loading ??= streamRepoIntoCache(o);
    return loading;
  };
  return {
    load,
    async get(cids) {
      await load();
      return cached.get(cids);
    },
  };
}
