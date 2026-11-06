// Repository verification contract (ADR 0004 §4.4, §7). Frozen in Wave 0.

/** A v3 commit whose signature was checked against the current DID key. */
export interface VerifiedCommit {
  did: string;
  cid: string;
  rev: string;
  dataCid: string;
  version: 3;
}

/**
 * Result of a record proof at a verified head. `absent` is only ever produced
 * from a complete MST path (a proven exclusion), never from a missing block.
 */
export type RecordProof = { commit: VerifiedCommit; collection: string; rkey: string } & (
  | { state: 'present'; cid: string; record: unknown }
  | { state: 'absent' }
);

export type VerifyErrorCode =
  | 'car_malformed'
  | 'car_too_large'
  | 'cid_mismatch'
  | 'bad_signature'
  | 'did_mismatch'
  | 'bad_version'
  | 'bad_rev'
  | 'mst_invalid'
  | 'missing_block'
  | 'no_proof'
  | 'key_unavailable'
  | 'record_cid_mismatch';

export const VERIFY_ERROR_CODES: readonly VerifyErrorCode[] = [
  'car_malformed',
  'car_too_large',
  'cid_mismatch',
  'bad_signature',
  'did_mismatch',
  'bad_version',
  'bad_rev',
  'mst_invalid',
  'missing_block',
  'no_proof',
  'key_unavailable',
  'record_cid_mismatch',
];

export class VerifyError extends Error {
  constructor(
    readonly code: VerifyErrorCode,
    msg?: string,
  ) {
    super(msg ?? code);
    this.name = 'VerifyError';
  }
}

/** One record key enumerated by a verified range walk. */
export interface SnapshotEntry {
  /** `collection/rkey` */
  key: string;
  cid: string;
}
