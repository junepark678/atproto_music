// The verified_commits cache and the drain's record-proof verification
// (ADR 0004 §5.4 step 6, §6.1, §7).
//
// `verifyProof(db, car, opts, now)` is `verifyRecordProof` (W2-03) with one
// shortcut: when `(did, commit CID)` is in `verified_commits`, the commit's
// signature is not checked again. Everything else is checked every time:
// - readBoundedCar: byte and block caps, framing, CIDv1/dag-cbor/sha2-256, and
//   every block re-hashed against its CID. So the root block's bytes are the
//   exact bytes whose signature was verified before (the CID is their hash);
// - the root block is decoded and must still be a v3 commit of `did` whose
//   `rev` equals the cached rev and whose `data` is a dag-cbor link;
// - proveRecord: the MST inclusion or exclusion proof and the record CID.
// On a miss the full verifyCommit runs (signature under the current key) and
// the commit is remembered. A row is only ever written after verifyCommit
// succeeded. putIdentity (identity-cache.ts) forgets a DID's rows when its
// signing key changes, so a cached check never outlives the key it was made
// under. Rows older than 7 days are pruned by gc (`pruneVerifiedCommits`).

import { CidLinkWrapper, decode } from '@atcute/cbor';
import { readBoundedCar } from '@atmusic/atproto/verify/car-bounds';
import { verifyCommit } from '@atmusic/atproto/verify/commit';
import {
  proveRecord,
  RECORD_PROOF_MAX_BLOCKS,
  RECORD_PROOF_MAX_BYTES,
  type RecordProofOptions,
} from '@atmusic/atproto/verify/record-proof';
import { type RecordProof, type VerifiedCommit, VerifyError } from '@atmusic/atproto/verify/types';
import type { Db } from '../db';

export const VERIFIED_COMMIT_RETENTION_MS = 7 * 24 * 3_600_000;

export function lookupVerifiedCommit(db: Db, did: string, commitCid: string): { rev: string } | null {
  return db.one<{ rev: string }>('SELECT rev FROM verified_commits WHERE did = ? AND commit_cid = ?', did, commitCid);
}

export function rememberVerifiedCommit(db: Db, commit: VerifiedCommit, now: number): void {
  db.run(
    `INSERT INTO verified_commits(did, commit_cid, rev, verified_at_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(did, commit_cid) DO UPDATE SET verified_at_ms = excluded.verified_at_ms`,
    commit.did,
    commit.cid,
    commit.rev,
    now,
  );
}

/** Forget every cached signature check of `did` (its signing key changed, or it disconnected). */
export function forgetVerifiedCommits(db: Db, did: string): number {
  return db.all('DELETE FROM verified_commits WHERE did = ? RETURNING commit_cid', did).length;
}

/** gc: drop rows verified more than VERIFIED_COMMIT_RETENTION_MS ago. */
export function pruneVerifiedCommits(db: Db, now: number): number {
  return db.all(
    'DELETE FROM verified_commits WHERE verified_at_ms < ? RETURNING commit_cid',
    now - VERIFIED_COMMIT_RETENTION_MS,
  ).length;
}

type ProofStore = Parameters<typeof proveRecord>[0];

/** A read-only block store over CID-verified blocks (the shape proveRecord reads). */
function memoryStore(blocks: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): ProofStore {
  const store = {
    get: async (cid: string) => blocks.get(cid) ?? null,
    has: async (cid: string) => blocks.has(cid),
    getMany: async (cids: string[]) => {
      const found = new Map<string, Uint8Array<ArrayBuffer>>();
      const missing: string[] = [];
      for (const cid of cids) {
        const bytes = blocks.get(cid);
        if (bytes === undefined) missing.push(cid);
        else found.set(cid, bytes);
      }
      return { found, missing };
    },
  };
  return store as unknown as ProofStore;
}

/** The commit of an already verified CID, re-read from its (re-hashed) block. */
function cachedCommit(
  blocks: ReadonlyMap<string, Uint8Array>,
  root: string,
  did: string,
  rev: string,
): VerifiedCommit | null {
  const bytes = blocks.get(root);
  if (bytes === undefined) return null;
  let commit: unknown;
  try {
    commit = decode(bytes);
  } catch {
    return null;
  }
  if (commit === null || typeof commit !== 'object') return null;
  const c = commit as Record<string, unknown>;
  if (c.version !== 3 || c.did !== did || c.rev !== rev || !(c.data instanceof CidLinkWrapper)) return null;
  return { did, cid: root, rev, dataCid: c.data.$link, version: 3 };
}

export interface VerifiedProof {
  proof: RecordProof;
  /** The signature check was skipped because the commit was verified before. */
  cached: boolean;
}

/**
 * Verify a getRecord CAR for `opts.did` and prove `collection/rkey` present or
 * absent at its head. Throws VerifyError exactly as verifyRecordProof does.
 */
export async function verifyProof(
  db: Db,
  car: Uint8Array,
  opts: RecordProofOptions,
  now: number,
): Promise<VerifiedProof> {
  const { root, blocks } = readBoundedCar(car, {
    maxBytes: opts.maxBytes ?? RECORD_PROOF_MAX_BYTES,
    maxBlocks: opts.maxBlocks ?? RECORD_PROOF_MAX_BLOCKS,
  });
  const hit = lookupVerifiedCommit(db, opts.did, root);
  let commit = hit === null ? null : cachedCommit(blocks, root, opts.did, hit.rev);
  const cached = commit !== null;
  if (commit === null) {
    commit = await verifyCommit(blocks, root, { did: opts.did, signingKey: opts.signingKey });
    rememberVerifiedCommit(db, commit, now);
  }
  if (commit.did !== opts.did) throw new VerifyError('did_mismatch', `commit is for ${commit.did}`);
  const proof = await proveRecord(memoryStore(blocks), commit, opts.collection, opts.rkey);
  return { proof, cached };
}
