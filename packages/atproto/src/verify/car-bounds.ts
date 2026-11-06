// CAR bounds (ADR 0004 §7 step 1). Every untrusted CAR enters through here.
//
// Two passes over the bytes:
//   1. Bounds. Before anything is decoded or hashed, the whole CAR is framed
//      with our own varint reader: the total size against `maxBytes`, the
//      header and every section length against the bytes that remain, the
//      CID prefix of every section (CIDv1, dag-cbor 0x71 or raw 0x55, sha2-256,
//      32-byte digest) and the block count against `maxBlocks`. A malformed
//      or oversize CAR is rejected here, without decoding a single byte.
//   2. Read. Only then does @atcute/car read the archive (header decode, CID
//      parse); its sections must coincide exactly with the framing of pass 1,
//      and every block is re-hashed here against its CID.
//
// The result holds copies of the block bytes, so later mutation of the input
// buffer cannot change a verified block. Only the first header root is used
// (it is the commit); further roots are ignored, as in the Rust oracle.
//
// Codes (VerifyErrorCode): car_too_large (byte or block cap), car_malformed
// (framing, header, unsupported CID), cid_mismatch (a block does not hash to
// its CID).

import { fromUint8Array } from '@atcute/car';
import * as CID from '@atcute/cid';
import { VerifyError } from './types';

export interface CarBounds {
  /** Byte cap for this call site; a longer input is `car_too_large`. */
  maxBytes: number;
  /** Block (section) cap; more sections is `car_too_large`. */
  maxBlocks: number;
}

export interface BoundedCar {
  /** The first header root (the commit CID), base32. */
  root: string;
  /** CID string → block bytes; every entry hashes to its key. */
  blocks: Map<string, Uint8Array<ArrayBuffer>>;
}

/** Length of a CIDv1 sha2-256 CID in binary form: version, codec, hash code, digest size, 32 bytes. */
const CID_BYTES = 36;
/** A varint longer than this cannot describe a length that fits in a CAR we would accept. */
const MAX_VARINT_BYTES = 8;

const malformed = (msg: string) => new VerifyError('car_malformed', msg);

/**
 * Unsigned LEB128 varint at `offset`, as the CAR spec (multiformats
 * unsigned-varint): at most 8 bytes, minimally encoded.
 */
function readVarint(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    const at = offset + i;
    if (at >= bytes.length) throw malformed(`truncated varint at ${offset}`);
    const b = bytes[at]!;
    value += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) {
      if (b === 0 && i > 0) throw malformed(`non-minimal varint at ${offset}`);
      return [value, at + 1];
    }
    scale *= 0x80;
  }
  throw malformed(`overlong varint at ${offset}`);
}

interface Frame {
  /** Offset of the section's length varint. */
  start: number;
  /** Offset of the CID. */
  cidStart: number;
  /** One past the section's last byte. */
  end: number;
}

function checkCidPrefix(bytes: Uint8Array, at: number): void {
  const version = bytes[at];
  const codec = bytes[at + 1];
  const hash = bytes[at + 2];
  const size = bytes[at + 3];
  if (version !== CID.CID_VERSION) throw malformed(`section at ${at}: not a CIDv1 (version byte ${version})`);
  if (codec !== CID.CODEC_DCBOR && codec !== CID.CODEC_RAW) {
    throw malformed(`section at ${at}: unsupported CID codec 0x${(codec ?? 0).toString(16)}`);
  }
  if (hash !== CID.HASH_SHA256) throw malformed(`section at ${at}: unsupported hash 0x${(hash ?? 0).toString(16)}`);
  if (size !== 32) throw malformed(`section at ${at}: digest size ${size}, expected 32`);
}

/** Pass 1: frame the CAR from lengths alone. Throws before any decode or hash. */
function frame(bytes: Uint8Array, bounds: CarBounds): { headerEnd: number; frames: Frame[] } {
  if (bytes.length > bounds.maxBytes) {
    throw new VerifyError('car_too_large', `CAR is ${bytes.length} bytes, cap ${bounds.maxBytes}`);
  }
  const [headerLen, headerStart] = readVarint(bytes, 0);
  if (headerLen === 0) throw malformed('empty CAR header');
  if (headerLen > bytes.length - headerStart) throw malformed('CAR header overruns input');
  const headerEnd = headerStart + headerLen;

  const frames: Frame[] = [];
  let at = headerEnd;
  while (at < bytes.length) {
    if (frames.length === bounds.maxBlocks) {
      throw new VerifyError('car_too_large', `CAR has more than ${bounds.maxBlocks} blocks`);
    }
    const [len, cidStart] = readVarint(bytes, at);
    if (len < CID_BYTES) throw malformed(`section at ${at} is ${len} bytes, shorter than a CID`);
    if (len > bytes.length - cidStart) throw malformed(`section at ${at} overruns input`);
    checkCidPrefix(bytes, cidStart);
    frames.push({ start: at, cidStart, end: cidStart + len });
    at = cidStart + len;
  }
  return { headerEnd, frames };
}

function sameDigest(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Bound, frame, read and hash-check a CARv1. Returns the first root and the
 * CID-verified blocks. Never returns a block whose bytes do not hash to its CID.
 */
export function readBoundedCar(bytes: Uint8Array, bounds: CarBounds): BoundedCar {
  if (!Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 1) throw new RangeError('maxBytes must be ≥ 1');
  if (!Number.isSafeInteger(bounds.maxBlocks) || bounds.maxBlocks < 0) throw new RangeError('maxBlocks must be ≥ 0');

  const { headerEnd, frames } = frame(bytes, bounds);

  // Pass 2: the lengths are known to be in bounds; now decode.
  let reader: ReturnType<typeof fromUint8Array>;
  try {
    reader = fromUint8Array(bytes, { verifyBlocks: false });
  } catch (e) {
    throw malformed(`CAR header: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (reader.header.headerEnd !== headerEnd) throw malformed('CAR header framing disagrees');
  const first = reader.roots[0];
  if (!first) throw malformed('CAR header has no roots');
  let root: CID.Cid;
  try {
    root = CID.fromCidLink(first);
  } catch (e) {
    throw malformed(`CAR root: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (root.codec !== CID.CODEC_DCBOR || root.digest.codec !== CID.HASH_SHA256 || root.digest.contents.length !== 32) {
    throw malformed('CAR root is not a dag-cbor sha2-256 CID');
  }

  const blocks = new Map<string, Uint8Array<ArrayBuffer>>();
  let i = 0;
  try {
    for (const entry of reader) {
      const f = frames[i++];
      if (!f || entry.entryStart !== f.start || entry.cidStart !== f.cidStart || entry.entryEnd !== f.end) {
        throw malformed(`CAR section ${i - 1} framing disagrees`);
      }
      const actual = CID.createSync(entry.cid.codec as 0x55 | 0x71, entry.bytes);
      const cid = CID.toString(entry.cid);
      if (!sameDigest(actual.digest.contents, entry.cid.digest.contents)) {
        throw new VerifyError('cid_mismatch', `block ${cid} hashes to ${CID.toString(actual)}`);
      }
      if (!blocks.has(cid)) blocks.set(cid, new Uint8Array(entry.bytes));
    }
  } catch (e) {
    if (e instanceof VerifyError) throw e;
    throw malformed(`CAR section ${i}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (i !== frames.length) throw malformed('CAR section count disagrees');
  return { root: CID.toString(root), blocks };
}
