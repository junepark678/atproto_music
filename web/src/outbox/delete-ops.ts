// Scrobble deletes (ADR 0004 §5.2 step 5, §9 A13; API.md deletion clarification).
//
// - The owner's view hides the record as soon as the delete is enqueued
//   (overlay.ts); public views change once the AppView verifies absence.
// - A delete waits (predecessorIds) for every unsent operation on the same URI,
//   in particular a create that is still queued or in flight, so it never races
//   the create and never leaves the record behind.
// - deleteRecord carries `swapRecord`: the CID from GET /api/v1/records/status,
//   or, when the AppView does not have the record yet, the CID the owner's PDS
//   reports. The CID is persisted before the send, so a crash during the delete
//   resumes with the same swapRecord.
// - InvalidSwap: re-fetch from the PDS and reconcile. Absent → done; present
//   with another CID → retry (a counted attempt) with that CID.
// - RecordNotFound (or a 404): look it up; absence completes the delete.
// - Never another writer's record: when our create of this URI ended
//   `remote_record_conflict`, the record at the rkey is someone else's and
//   ours never existed there. The delete then completes locally with no PDS
//   request (`localCompletion: 'record_not_ours'`), so the conflict rule
//   (never overwrite, never delete the other record) holds for deletes too.

import type { AtUri, Did, RecordStatus } from '@atmusic/core/api-types';
import type { Clock, Random } from '@atmusic/core/deps';
import { collectionsFor } from '@atmusic/core/namespace';
import type { ValidationFailure } from '@atmusic/core/scrobble';
import { type ExecContext, type Executor, failureOutcome, type Outcome, type TrackVerdict } from './runner';
import { hasIdentity } from './scrobble-ops';
import { freshOperation, isUnsent, newOperationId, type OutboxOperation, type OutboxStore } from './store';

export interface EnqueueDeleteArgs {
  store: OutboxStore;
  did: Did;
  prefix: string;
  /** The scrobble's AT URI; it must be in the signed-in DID's own scrobble collection. */
  uri: AtUri;
  clock: Clock;
  random: Random;
}

export type EnqueueDeleteResult = { ok: true; op: OutboxOperation } | { ok: false; reason: ValidationFailure };

const RKEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/;

/** Splits `at://did/collection/rkey` when it names one record of `collection` owned by `did`. */
export function ownRecordKey(uri: string, did: Did, collection: string): string | null {
  const prefix = `at://${did}/${collection}/`;
  if (!uri.startsWith(prefix)) return null;
  const rkey = uri.slice(prefix.length);
  return RKEY_RE.test(rkey) && rkey !== '.' && rkey !== '..' ? rkey : null;
}

/** Persists a delete behind every unsent operation on the same URI. */
export async function enqueueScrobbleDelete(args: EnqueueDeleteArgs): Promise<EnqueueDeleteResult> {
  const collection = collectionsFor(args.prefix).scrobble;
  const rkey = ownRecordKey(args.uri, args.did, collection);
  if (rkey === null) {
    return {
      ok: false,
      reason: { field: 'uri', code: 'invalid_field', message: 'expected one of your own scrobble records' },
    };
  }
  const id = newOperationId(args.random);
  const now = args.clock.nowMs();
  const op = await args.store.enqueue(args.did, ({ seq, existing }) =>
    freshOperation(
      {
        id,
        did: args.did,
        kind: 'scrobble_delete',
        collection,
        rkey,
        uri: args.uri,
        predecessorIds: existing.filter((o) => o.uri === args.uri && isUnsent(o.state)).map((o) => o.id),
        seq,
      },
      now,
    ),
  );
  return { ok: true, op };
}

/** Failure codes of a create that prove the record at its URI is not ours. */
const NOT_OURS_CODES: ReadonlySet<string> = new Set(['remote_record_conflict']);

/** Our create of this URI ended with proof that another writer holds the rkey. */
export function createLostRkey(op: OutboxOperation, earlier: readonly OutboxOperation[]): boolean {
  return earlier.some(
    (o) =>
      o.kind === 'scrobble_create' &&
      o.uri === op.uri &&
      o.state === 'failed' &&
      o.failureCode !== undefined &&
      NOT_OURS_CODES.has(o.failureCode),
  );
}

/** The AppView's CID for the record, when it has it indexed. */
async function indexedCid(ctx: ExecContext, uri: AtUri): Promise<string | undefined> {
  try {
    const status = await ctx.api.recordStatus(uri);
    return status.state === 'indexed' ? status.cid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * deleteRecord with swapRecord, reconciling InvalidSwap and RecordNotFound
 * against the owner's PDS.
 */
export async function deleteWithSwap(op: OutboxOperation, ctx: ExecContext): Promise<Outcome> {
  let swap = op.swapCid;
  if (swap === undefined) {
    swap = await indexedCid(ctx, op.uri);
    if (swap === undefined) {
      const found = await ctx.pds.getRecord(op.collection, op.rkey);
      if (found.kind === 'failed') return found.outcome;
      // Nothing at the key on the owner's PDS: the delete is already complete.
      if (found.kind === 'absent') return { kind: 'published' };
      swap = found.cid;
    }
    await ctx.persist({ swapCid: swap });
  }
  const result = await ctx.pds.procedure(
    'com.atproto.repo.deleteRecord',
    { repo: op.did, collection: op.collection, rkey: op.rkey, swapRecord: swap },
    'delete',
  );
  if (result.ok) return { kind: 'published' };
  const failure = result.failure;
  if (failure.code === 'repository_changed' || failure.kind === 'missing') {
    const found = await ctx.pds.getRecord(op.collection, op.rkey);
    if (found.kind === 'failed') return found.outcome;
    if (found.kind === 'absent') return { kind: 'published' };
    return {
      kind: 'transient',
      code: failure.code === 'repository_changed' ? 'repository_changed' : 'remote_delete_unconfirmed',
      patch: { swapCid: found.cid },
    };
  }
  return failureOutcome(failure);
}

/** Read-only: absent on the owner's PDS completes the delete. */
export async function lookupDeleted(op: OutboxOperation, ctx: ExecContext): Promise<Outcome> {
  const found = await ctx.pds.getRecord(op.collection, op.rkey);
  if (found.kind === 'failed') return found.outcome;
  return found.kind === 'absent' ? { kind: 'published' } : { kind: 'transient', code: 'remote_delete_unconfirmed' };
}

/** Every tracked URI is gone from the AppView (absent, never known, or the DID is suppressed). */
export function deleteVerdict(statuses: readonly (RecordStatus | null)[]): TrackVerdict {
  const gone = statuses.every(
    (s) => s !== null && (s.state === 'absent' || s.state === 'unknown' || s.indexing.state === 'suppressed'),
  );
  return gone ? { kind: 'indexed' } : { kind: 'continue' };
}

export const scrobbleDeleteExecutor: Executor = {
  async execute(op, ctx) {
    if (!hasIdentity(op, ctx, ctx.collections.scrobble)) return { kind: 'permanent', code: 'invalid_record_identity' };
    if (createLostRkey(op, ctx.earlier)) return { kind: 'completed_locally', code: 'record_not_ours' };
    return deleteWithSwap(op, ctx);
  },
  async reconcile(op, ctx) {
    if (!hasIdentity(op, ctx, ctx.collections.scrobble)) return { kind: 'permanent', code: 'invalid_record_identity' };
    if (createLostRkey(op, ctx.earlier)) return { kind: 'completed_locally', code: 'record_not_ours' };
    return lookupDeleted(op, ctx);
  },
  trackUris: (op) => [op.uri],
  verdict: (_op, statuses) => deleteVerdict(statuses),
};
