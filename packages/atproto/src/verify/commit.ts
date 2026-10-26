// Commit verification (ADR 0004 §7 step 2): current-head trust under the
// current DID key.
//
// Checks, in order, each with its own VerifyErrorCode:
//   - the commit block is present (missing_block) and hashes to the root CID
//     as dag-cbor (cid_mismatch), and decodes to a dag-cbor map whose
//     canonical re-encoding is byte-identical to the block (car_malformed).
//     The signature is checked over a re-encoding, so a non-canonical block
//     (e.g. version written as float64 3.0, which decodes to the number 3)
//     would otherwise get a second CID that verifies under the same
//     signature; the Rust oracle rejects it too (version must be
//     Ipld::Integer(3));
//   - version === 3 (bad_version), did === the requested DID (did_mismatch),
//     rev a TID (bad_rev), data a dag-cbor CID link (mst_invalid);
//   - the signing key is a parseable did:key of a supported curve
//     (key_unavailable);
//   - sig is 64 bytes, low-S on its curve, and verifies with @atcute/crypto
//     (P-256 via WebCrypto, secp256k1 via noble) over the dag-cbor encoding
//     of the commit without `sig` (bad_signature). Malleable (high-S)
//     signatures are refused twice: explicitly here, and by the library with
//     `allowMalleableSig: false`.

import { BytesWrapper, CidLinkWrapper, decode, encode } from '@atcute/cbor';
import * as CID from '@atcute/cid';
import { type FoundPublicKey, parseDidKey, verifySig } from '@atcute/crypto';
import { isTid } from '@atmusic/core/syntax';
import { type VerifiedCommit, VerifyError } from './types';

export interface VerifyCommitOptions {
  /** The DID the commit must belong to. */
  did: string;
  /** The `#atproto` signing key from a fresh identity resolution, as a did:key. */
  signingKey: string;
}

/** Curve orders; a signature with s > n/2 is the malleable twin and is refused. */
const CURVE_ORDER: Record<FoundPublicKey['type'], bigint> = {
  secp256k1: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  p256: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
};

function isLowS(sig: Uint8Array, curve: FoundPublicKey['type']): boolean {
  let s = 0n;
  for (const b of sig.subarray(32, 64)) s = (s << 8n) | BigInt(b);
  return s >= 1n && s <= CURVE_ORDER[curve] >> 1n;
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof CidLinkWrapper) &&
    !(value instanceof BytesWrapper)
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function parseKey(signingKey: string): FoundPublicKey {
  if (typeof signingKey !== 'string' || !signingKey.startsWith('did:key:')) {
    throw new VerifyError('key_unavailable', 'signing key is not a did:key');
  }
  try {
    return parseDidKey(signingKey);
  } catch (e) {
    throw new VerifyError('key_unavailable', `unusable signing key: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Verify the signed commit `rootCid` among CID-verified `blocks` (from
 * readBoundedCar or another CID-checked source).
 */
export async function verifyCommit(
  blocks: ReadonlyMap<string, Uint8Array>,
  rootCid: string,
  opts: VerifyCommitOptions,
): Promise<VerifiedCommit> {
  const bytes = blocks.get(rootCid);
  if (!bytes) throw new VerifyError('missing_block', `commit block ${rootCid} is not in the CAR`);

  // Defence in depth: the commit must be the dag-cbor block its CID names.
  let root: CID.Cid;
  try {
    root = CID.fromString(rootCid);
  } catch {
    throw new VerifyError('car_malformed', `commit CID ${rootCid} does not parse`);
  }
  if (root.codec !== CID.CODEC_DCBOR) throw new VerifyError('car_malformed', 'commit CID is not dag-cbor');
  if (CID.toString(CID.createSync(CID.CODEC_DCBOR, bytes)) !== rootCid) {
    throw new VerifyError('cid_mismatch', `commit block does not hash to ${rootCid}`);
  }

  let commit: unknown;
  try {
    commit = decode(bytes);
  } catch (e) {
    throw new VerifyError('car_malformed', `commit is not dag-cbor: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isPlainMap(commit)) throw new VerifyError('car_malformed', 'commit is not a map');
  // Canonical round trip: what is signed below (a re-encoding) must be
  // exactly what the CID names. Rejects float-encoded integers, non-minimal
  // lengths, unsorted keys, indefinite lengths and any other non-canonical
  // form that decodes to the same value.
  let canonical: Uint8Array;
  try {
    canonical = encode(commit);
  } catch (e) {
    throw new VerifyError('car_malformed', `commit does not re-encode: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!bytesEqual(canonical, bytes)) {
    throw new VerifyError('car_malformed', 'commit block is not canonical dag-cbor');
  }

  if (commit.version !== 3) throw new VerifyError('bad_version', `commit version ${String(commit.version)}`);
  if (typeof commit.did !== 'string' || commit.did !== opts.did) {
    throw new VerifyError('did_mismatch', `commit is for ${String(commit.did)}, expected ${opts.did}`);
  }
  if (typeof commit.rev !== 'string' || !isTid(commit.rev)) {
    throw new VerifyError('bad_rev', `commit rev ${String(commit.rev)} is not a TID`);
  }
  const data = commit.data;
  if (!(data instanceof CidLinkWrapper)) throw new VerifyError('mst_invalid', 'commit data is not a CID link');
  const dataCid = data.$link;
  if (CID.fromString(dataCid).codec !== CID.CODEC_DCBOR) {
    throw new VerifyError('mst_invalid', 'commit data is not a dag-cbor CID');
  }

  const key = parseKey(opts.signingKey);

  const sigField = commit.sig;
  if (!(sigField instanceof BytesWrapper) || sigField.buf.length !== 64) {
    throw new VerifyError('bad_signature', 'commit sig is not 64 bytes');
  }
  const sig = new Uint8Array(sigField.buf);
  if (!isLowS(sig, key.type)) throw new VerifyError('bad_signature', 'commit signature is not low-S');

  const { sig: _sig, ...unsigned } = commit;
  const signed = new Uint8Array(encode(unsigned));
  let ok = false;
  try {
    ok = await verifySig(key, sig, signed, { allowMalleableSig: false });
  } catch {
    ok = false;
  }
  if (!ok) throw new VerifyError('bad_signature', `commit signature does not verify under ${opts.signingKey}`);

  return { did: opts.did, cid: rootCid, rev: commit.rev, dataCid, version: 3 };
}
