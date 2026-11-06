// `com.atproto.sync.getBlocks` as a BlockSource (ADR 0004 §5.7 step 4).
//
// - At most 100 CIDs per request; a larger `get` is split into batches.
// - Each request goes through SafeFetch kind `getBlocks` (8 MiB body cap,
//   URL/DoH policy, no redirects, 10 s deadline).
// - Each response CAR is framed, bounded and hash-checked by
//   verify/car-bounds (readBoundedCar). getBlocks CARs carry no root (the
//   reference PDS writes `roots: []`), while readBoundedCar requires one for
//   commit CARs; the header is therefore checked here (a dag-cbor map with
//   version 1 and a roots array) and replaced by a fixed one-root header
//   before readBoundedCar sees the sections. Every section is still framed,
//   CID-prefix-checked and re-hashed by car-bounds; the root is never used.
// - Only requested CIDs are returned; extra blocks are dropped. A CID the CAR
//   lacks is simply omitted, and the walker reports it as `missing_block`.
//
// Errors: XRPC `BlockNotFound` → VerifyError `missing_block`; HTTP 501 or 404,
// or XRPC `MethodNotImplemented` → BlockSourceError `unsupported`. Any other
// SafeFetchError (rate limit, 5xx, timeout, oversize body) propagates for the
// job's retry policy.

import { decode, encode } from '@atcute/cbor';
import * as CID from '@atcute/cid';
import { KIND_CAPS, type SafeFetch, SafeFetchError } from '../net/safe-fetch';
import { readBoundedCar } from '../verify/car-bounds';
import { VerifyError } from '../verify/types';
import { type BlockSource, BlockSourceError } from './block-source';

/** The atproto getBlocks batch limit used for every request. */
export const GET_BLOCKS_BATCH = 100;
/** Response body cap: SafeFetch kind `getBlocks`. */
export const GET_BLOCKS_MAX_BYTES = KIND_CAPS.getBlocks;
const NSID = 'com.atproto.sync.getBlocks';
const MAX_HEADER_BYTES = 64 * 1024;

export interface GetBlocksSourceOptions {
  safeFetch: SafeFetch;
  /** PDS origin, e.g. `https://pds.example.com`. */
  pds: string;
  did: string;
  /** CIDs per request, 1..100 (default 100). */
  batchSize?: number;
}

export interface GetBlocksSource extends BlockSource {
  /** HTTP requests made so far. */
  readonly requests: number;
}

const malformed = (msg: string) => new VerifyError('car_malformed', msg);

function varint(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Uint8Array.from(out);
}

function readVarint(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 8; i++) {
    const at = offset + i;
    if (at >= bytes.length) throw malformed('truncated CAR header length');
    const b = bytes[at]!;
    value += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) {
      if (b === 0 && i > 0) throw malformed('non-minimal CAR header length');
      return [value, at + 1];
    }
    scale *= 0x80;
  }
  throw malformed('overlong CAR header length');
}

/** A fixed root for the replacement header: the CID of dag-cbor `null`. It is never looked up. */
const PLACEHOLDER_ROOT = CID.toCidLink(CID.createSync(CID.CODEC_DCBOR, encode(null)));
const PLACEHOLDER_HEADER = encode({ version: 1, roots: [PLACEHOLDER_ROOT] });
const PLACEHOLDER_PREFIX = Uint8Array.from([...varint(PLACEHOLDER_HEADER.length), ...PLACEHOLDER_HEADER]);

/**
 * Bound and hash-check a getBlocks CAR through car-bounds. Returns every
 * block it holds, each keyed by the CID its bytes hash to.
 */
export function readGetBlocksCar(body: Uint8Array, maxBlocks: number): Map<string, Uint8Array> {
  if (body.length > GET_BLOCKS_MAX_BYTES) {
    throw new VerifyError('car_too_large', `getBlocks CAR is ${body.length} bytes, cap ${GET_BLOCKS_MAX_BYTES}`);
  }
  const [headerLen, headerStart] = readVarint(body, 0);
  if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) throw malformed(`CAR header length ${headerLen}`);
  if (headerLen > body.length - headerStart) throw malformed('CAR header overruns input');
  const sectionsStart = headerStart + headerLen;
  let header: unknown;
  try {
    header = decode(body.subarray(headerStart, sectionsStart));
  } catch (e) {
    throw malformed(`CAR header: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (
    header === null ||
    typeof header !== 'object' ||
    Array.isArray(header) ||
    (header as { version?: unknown }).version !== 1 ||
    !Array.isArray((header as { roots?: unknown }).roots)
  ) {
    throw malformed('CAR header is not a version 1 header with a roots array');
  }
  const sections = body.length - sectionsStart;
  const reframed = new Uint8Array(PLACEHOLDER_PREFIX.length + sections);
  reframed.set(PLACEHOLDER_PREFIX, 0);
  reframed.set(body.subarray(sectionsStart), PLACEHOLDER_PREFIX.length);
  const { blocks } = readBoundedCar(reframed, { maxBytes: reframed.length, maxBlocks });
  return blocks;
}

function classify(error: unknown, did: string): unknown {
  if (!(error instanceof SafeFetchError) || error.code !== 'http_status') return error;
  if (error.xrpcError === 'BlockNotFound') {
    return new VerifyError('missing_block', `getBlocks for ${did}: ${error.xrpcMessage ?? 'BlockNotFound'}`);
  }
  if (error.status === 501 || error.status === 404 || error.xrpcError === 'MethodNotImplemented') {
    return new BlockSourceError('unsupported', `getBlocks unsupported (HTTP ${error.status})`);
  }
  return error;
}

export function getBlocksSource(o: GetBlocksSourceOptions): GetBlocksSource {
  const batchSize = o.batchSize ?? GET_BLOCKS_BATCH;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > GET_BLOCKS_BATCH) {
    throw new RangeError(`batchSize must be an integer in [1, ${GET_BLOCKS_BATCH}]`);
  }
  const base = new URL(`/xrpc/${NSID}`, o.pds);
  let requests = 0;

  async function fetchBatch(cids: string[], out: Map<string, Uint8Array>): Promise<void> {
    const url = new URL(base);
    url.searchParams.set('did', o.did);
    for (const cid of cids) url.searchParams.append('cids', cid);
    requests++;
    let body: Uint8Array;
    try {
      ({ body } = await o.safeFetch(url, { kind: 'getBlocks' }));
    } catch (e) {
      throw classify(e, o.did);
    }
    // A well-behaved PDS returns exactly the requested blocks; allow slack, not an unbounded count.
    const blocks = readGetBlocksCar(body, cids.length * 2 + 8);
    for (const cid of cids) {
      const bytes = blocks.get(cid);
      if (bytes !== undefined) out.set(cid, bytes);
    }
  }

  return {
    get requests() {
      return requests;
    },
    async get(cids) {
      const unique = [...new Set(cids)];
      const out = new Map<string, Uint8Array>();
      for (let i = 0; i < unique.length; i += batchSize) {
        await fetchBatch(unique.slice(i, i + batchSize), out);
      }
      return out;
    },
  };
}
