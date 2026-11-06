// Record inclusion / exclusion proofs (ADR 0004 §7 step 3).
//
// verifyRecordProof(car) = readBoundedCar → verifyCommit → proveRecord:
//   - only CID-verified blocks enter the ReadonlyMemoryBlockStore;
//   - @atcute/mst findRpathAndBuildProof walks the signed MST from
//     commit.data to `collection/rkey`. Every node it loads must type l, e[].t
//     and e[].v as dag-cbor links (or null for l, t), as the Rust oracle does,
//     before the library decodes it; otherwise mst_invalid. A CID means
//     present; `null` means absent, and is only ever reached over a complete
//     path (every node the walk needs was loaded). A missing node throws MissingBlockError, which
//     maps to `missing_block` and is never treated as absence;
//   - a present record's block must exist (missing_block), hash to the CID the
//     MST commits to (record_cid_mismatch) and decode as dag-cbor into the
//     atproto JSON form, links as {$link} and bytes as {$bytes} (car_malformed).
//
// @atcute/repo verifyRecord is deliberately not used: it reports not-found
// for a missing path node and exposes no rev.

import { BytesWrapper, CidLinkWrapper, decode } from '@atcute/cbor';
import * as CID from '@atcute/cid';
import {
  BlockMismatchError,
  type BlockStore,
  findRpathAndBuildProof,
  MissingBlockError,
  NodeStore,
  type ReadonlyBlockStore,
  ReadonlyMemoryBlockStore,
} from '@atcute/mst';
import { isNsid, isRecordKey } from '@atmusic/core/syntax';
import { KIND_CAPS } from '../net/safe-fetch';
import { readBoundedCar } from './car-bounds';
import { verifyCommit } from './commit';
import { type RecordProof, type VerifiedCommit, VerifyError } from './types';

/** Default byte cap: a `com.atproto.sync.getRecord` body (SafeFetch `getRecord`, 1 MiB). */
export const RECORD_PROOF_MAX_BYTES = KIND_CAPS.getRecord;
/**
 * Default block cap: the commit, an MST path of at most 256 nodes (the ADR §7
 * depth bound) and the record, with headroom for PDSs that add sibling nodes.
 */
export const RECORD_PROOF_MAX_BLOCKS = 1024;
/** Nesting depth limit for a decoded record (the Rust oracle's MAX_CBOR_DEPTH). */
export const MAX_RECORD_DEPTH = 64;

export interface RecordProofOptions {
  did: string;
  collection: string;
  rkey: string;
  /** The current `#atproto` did:key from a fresh identity resolution. */
  signingKey: string;
  maxBytes?: number;
  maxBlocks?: number;
}

function checkPath(collection: string, rkey: string): string {
  if (!isNsid(collection)) throw new TypeError(`not an NSID: ${collection}`);
  if (!isRecordKey(rkey)) throw new TypeError(`not a record key: ${rkey}`);
  return `${collection}/${rkey}`;
}

/** dag-cbor value → atproto JSON form. Throws car_malformed beyond MAX_RECORD_DEPTH. */
function toJsonForm(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof CidLinkWrapper) return { $link: value.$link };
  if (value instanceof BytesWrapper) return { $bytes: value.$bytes };
  // `depth` counts enclosing containers, this one included.
  if (depth > MAX_RECORD_DEPTH) throw new VerifyError('car_malformed', `record nests deeper than ${MAX_RECORD_DEPTH}`);
  if (Array.isArray(value)) return value.map((v) => toJsonForm(v, depth + 1));
  // Object.fromEntries defines own data properties, so a `__proto__` key stays a plain key.
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonForm(v, depth + 1)]));
}

function codecOf(cid: string): number {
  return CID.fromString(cid).codec;
}

/** A dag-cbor link (tag 42) as @atcute/cbor decodes it. A plain `{$link}` map is not one. */
const isLink = (v: unknown): boolean => v instanceof CidLinkWrapper;
const isNullableLink = (v: unknown): boolean => v === null || isLink(v);
const isMap = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !isLink(v) && !(v instanceof BytesWrapper);

/**
 * The link-typing half of the Rust oracle's validate_mst_node: `l` and every
 * `e[].t` are a link or null, every `e[].v` is a link. @atcute/mst checks these
 * with isCidLink, which also accepts any map holding a string `$link`, so a
 * signed node built that way would otherwise be walked (or reported as a
 * missing block) instead of rejected. Keys, prefixes, sort order and heights
 * are left to MSTNode.deserialize.
 */
function assertNodeLinks(cid: string, bytes: Uint8Array): void {
  let node: unknown;
  try {
    node = decode(bytes);
  } catch (e) {
    throw new VerifyError(
      'mst_invalid',
      `MST node ${cid} is not dag-cbor: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isMap(node) || !Array.isArray(node.e)) throw new VerifyError('mst_invalid', `MST node ${cid} is not a node`);
  if (!isNullableLink(node.l)) throw new VerifyError('mst_invalid', `MST node ${cid}: l is not a link or null`);
  node.e.forEach((entry: unknown, i) => {
    if (!isMap(entry)) throw new VerifyError('mst_invalid', `MST node ${cid}: e[${i}] is not a map`);
    if (!isLink(entry.v)) throw new VerifyError('mst_invalid', `MST node ${cid}: e[${i}].v is not a link`);
    if (!isNullableLink(entry.t)) {
      throw new VerifyError('mst_invalid', `MST node ${cid}: e[${i}].t is not a link or null`);
    }
  });
}

/**
 * The block source NodeStore reads MST nodes through. NodeStore is typed over
 * a writable BlockStore but only calls `get`; every other method throws, so no
 * read can bypass the node check and no write can reach the proof store.
 *
 * `get` hands back bytes that do not hash to `cid` (as dag-cbor) unchecked:
 * NodeStore then raises BlockMismatchError, so a corrupt block stays
 * cid_mismatch rather than mst_invalid. Bytes that do hash to `cid` must pass
 * assertNodeLinks before NodeStore decodes them.
 */
function mstNodeSource(store: ReadonlyBlockStore): BlockStore {
  const refuse = (): never => {
    throw new Error('the MST proof block source only serves get');
  };
  return {
    get: async (cid) => {
      const bytes = await store.get(cid);
      if (bytes !== null && CID.toString(CID.createSync(CID.CODEC_DCBOR, bytes)) === cid) {
        assertNodeLinks(cid, bytes);
      }
      return bytes;
    },
    getMany: async () => refuse(),
    has: async () => refuse(),
    put: async () => refuse(),
    putMany: async () => refuse(),
    delete: async () => refuse(),
    deleteMany: async () => refuse(),
  };
}

/** Walk the signed MST; map library errors onto verification codes. */
async function lookup(store: ReadonlyBlockStore, dataCid: string, path: string): Promise<string | null> {
  try {
    const [value] = await findRpathAndBuildProof(new NodeStore(mstNodeSource(store)), dataCid, path);
    return value === null ? null : value.$link;
  } catch (e) {
    if (e instanceof VerifyError) throw e;
    if (e instanceof MissingBlockError) {
      throw new VerifyError('missing_block', `MST node ${e.cid} on the path to ${path} is missing`);
    }
    if (e instanceof BlockMismatchError) {
      // A dag-cbor CID whose bytes hash differently: a corrupt block. Any other
      // codec (raw) cannot name an MST node at all.
      if (codecOf(e.cid) === CID.CODEC_DCBOR) {
        throw new VerifyError('cid_mismatch', `MST node ${e.cid} hashes to ${e.actual}`);
      }
      throw new VerifyError('mst_invalid', `MST link ${e.cid} is not a dag-cbor node`);
    }
    // TypeError (malformed node, prefix, sort order, heights), InvalidMstKeyError,
    // CBOR decode errors, indeterminate root height: the signed tree is invalid.
    throw new VerifyError('mst_invalid', `MST on the path to ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Prove `collection/rkey` at an already verified commit over `store`. The
 * store should hold CID-verified blocks only; record bytes are re-hashed here
 * regardless, so a store that answers with the wrong bytes yields
 * `record_cid_mismatch`, never a forged record.
 */
export async function proveRecord(
  store: ReadonlyBlockStore,
  commit: VerifiedCommit,
  collection: string,
  rkey: string,
): Promise<RecordProof> {
  const path = checkPath(collection, rkey);
  const cid = await lookup(store, commit.dataCid, path);
  if (cid === null) return { commit, collection, rkey, state: 'absent' };

  const bytes = await store.get(cid);
  if (bytes === null) throw new VerifyError('missing_block', `record block ${cid} for ${path} is missing`);
  const codec = codecOf(cid);
  if (codec !== CID.CODEC_DCBOR && codec !== CID.CODEC_RAW) {
    throw new VerifyError('car_malformed', `record CID ${cid} has an unsupported codec`);
  }
  const actual = CID.toString(CID.createSync(codec as typeof CID.CODEC_DCBOR | typeof CID.CODEC_RAW, bytes));
  if (actual !== cid) {
    throw new VerifyError('record_cid_mismatch', `record block for ${path} hashes to ${actual}, MST commits to ${cid}`);
  }
  if (codec !== CID.CODEC_DCBOR) throw new VerifyError('car_malformed', `record ${cid} is not dag-cbor`);
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch (e) {
    throw new VerifyError(
      'car_malformed',
      `record ${cid} is not dag-cbor: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { commit, collection, rkey, state: 'present', cid, record: toJsonForm(decoded, 1) };
}

/**
 * Verify a `com.atproto.sync.getRecord`-style CAR (or a full repository CAR)
 * for `did` under `signingKey`, and prove `collection/rkey` present or absent
 * at its head.
 */
export async function verifyRecordProof(carBytes: Uint8Array, opts: RecordProofOptions): Promise<RecordProof> {
  checkPath(opts.collection, opts.rkey);
  const { root, blocks } = readBoundedCar(carBytes, {
    maxBytes: opts.maxBytes ?? RECORD_PROOF_MAX_BYTES,
    maxBlocks: opts.maxBlocks ?? RECORD_PROOF_MAX_BLOCKS,
  });
  const commit = await verifyCommit(blocks, root, { did: opts.did, signingKey: opts.signingKey });
  return proveRecord(new ReadonlyMemoryBlockStore(blocks), commit, opts.collection, opts.rkey);
}
