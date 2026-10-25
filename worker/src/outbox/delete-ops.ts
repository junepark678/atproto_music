// Scrobble deletes, cancellation and removal (ADR 0005 §5.8, §7.5
// library.removeScrobble; ADR 0004 §5.2 step 5, A13; N2-05). Ports
// web/src/outbox/delete-ops.ts to the server.
//
// - A delete waits (operation_deps) for every unsettled operation on the same
//   URI, in particular a create that is still queued or in flight, so it never
//   races the create and never leaves the record behind.
// - deleteRecord carries `swapRecord`: the CID in `record_state` (the verified
//   index), else the CID our own create of the URI published, else the CID the
//   owner's PDS reports. The CID is persisted before the send, so a crash
//   during the delete resumes with the same swapRecord.
// - InvalidSwap: re-fetch from the PDS and reconcile. Absent → done; present
//   with another CID → retry (a counted attempt) with that CID.
// - RecordNotFound (or a 404): look it up; absence completes the delete.
// - Never another writer's record: a delete enqueued behind our own create of
//   the URI whose create ended `remote_record_conflict` completes locally with
//   no PDS request (`record_not_ours`), since our listen never existed there.
// - Removal of a create that is not indexed yet (library.removeScrobble):
//   one never sent (queued or blocked, no attempt) is `cancelled` — nothing
//   reaches the PDS, its listen key and its unsent forward rows are deleted —
//   while one that is running or was already sent gets a `scrobble.delete`
//   chained after it as a predecessor.

import type { OperationRow, Origin } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import {
  cancelUnsent,
  insertOperation,
  loadOperation,
  newOperationId,
  outboxCollections,
  predecessorRows,
  unsettledAt,
} from './operations';
import { failureOutcome, type Outcome } from './pds-writer';
import type { ExecContext, Executor } from './runner';
import { hasIdentity, validRkey } from './scrobble-ops';

/** Splits `at://did/collection/rkey` when it names one record of `collection` owned by `did`. */
export function ownRecordKey(uri: string, did: string, collection: string): string | null {
  const prefix = `at://${did}/${collection}/`;
  if (!uri.startsWith(prefix)) return null;
  const rkey = uri.slice(prefix.length);
  return validRkey(rkey) ? rkey : null;
}

export class NotOwnRecordError extends RangeError {
  constructor() {
    super('expected one of your own scrobble records');
    this.name = 'NotOwnRecordError';
  }
}

/** Persists a `scrobble.delete` of one of the DID's own scrobbles, behind every unsettled operation on it. */
export function enqueueScrobbleDelete(
  m: ModuleDeps,
  args: { did: string; uri: string; origin: Origin; kick?: () => void },
): OperationRow {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const collection = outboxCollections(prefix).scrobble;
  const rkey = ownRecordKey(args.uri, args.did, collection);
  if (rkey === null) throw new NotOwnRecordError();
  const now = m.clock.nowMs();
  const op = m.db.tx(() =>
    insertOperation(
      m.db,
      {
        id: newOperationId(m.random),
        did: args.did,
        kind: 'scrobble.delete',
        origin: args.origin,
        collection,
        rkey,
        dueAt: now,
        predecessors: unsettledAt(m.db, args.did, collection, rkey),
      },
      now,
    ),
  );
  args.kick?.();
  return op;
}

export type RemoveCreateResult =
  | { status: 'cancelled'; operation: OperationRow }
  | { status: 'delete_chained'; operation: OperationRow; delete: OperationRow }
  | { status: 'not_found' };

/**
 * library.removeScrobble for one of the caller's own `scrobble.create`
 * operations that is not indexed yet: cancel it when it was never sent,
 * otherwise chain a delete after it. A failed or cancelled create left no
 * record of ours, so there is nothing to remove (`not_found`).
 */
export function removeScrobbleCreate(
  m: ModuleDeps,
  args: { did: string; operationId: string; origin: Origin; kick?: () => void },
): RemoveCreateResult {
  const now = m.clock.nowMs();
  const result = m.db.tx((): RemoveCreateResult => {
    const op = loadOperation(m.db, args.operationId);
    if (op === null || op.did !== args.did || op.kind !== 'scrobble.create' || op.rkey === null) {
      return { status: 'not_found' };
    }
    if (cancelUnsent(m.db, op.id, now)) return { status: 'cancelled', operation: loadOperation(m.db, op.id)! };
    if (op.state === 'failed' || op.state === 'cancelled') return { status: 'not_found' };
    const del = insertOperation(
      m.db,
      {
        id: newOperationId(m.random),
        did: args.did,
        kind: 'scrobble.delete',
        origin: args.origin,
        collection: op.collection,
        rkey: op.rkey,
        dueAt: now,
        predecessors: [op.id, ...unsettledAt(m.db, args.did, op.collection, op.rkey)],
      },
      now,
    );
    return { status: 'delete_chained', operation: op, delete: del };
  });
  if (result.status !== 'not_found') args.kick?.();
  return result;
}

/** Failure codes of a create that prove the record at its URI is not ours. */
const NOT_OURS_CODES: ReadonlySet<string> = new Set(['remote_record_conflict']);

/** The CID the verified index holds for a present record. */
function indexedCid(ctx: ExecContext, uri: string): string | null {
  const row = ctx.m.db.one<{ cid: string | null; state: string }>(
    'SELECT cid, state FROM record_state WHERE uri = ?',
    uri,
  );
  return row !== null && row.state === 'present' ? row.cid : null;
}

/** deleteRecord with swapRecord, reconciling InvalidSwap and RecordNotFound against the owner's PDS. */
async function deleteWithSwap(op: OperationRow, ctx: ExecContext, predecessors: OperationRow[]): Promise<Outcome> {
  const rkey = op.rkey as string;
  const uri = `at://${op.did}/${op.collection}/${rkey}`;
  const hints = [{ collection: op.collection, rkey }];
  let swap = op.swap_cid;
  if (swap === null) {
    swap = indexedCid(ctx, uri);
    if (swap === null) {
      const ours = predecessors.find(
        (p) => p.kind === 'scrobble.create' && p.rkey === rkey && p.state === 'succeeded' && p.result_cid !== null,
      );
      swap = ours?.result_cid ?? null;
    }
    if (swap === null) {
      const found = await ctx.xrpc.getRecord(op.collection, rkey);
      if (found.kind === 'failed') return failureOutcome(found.failure);
      // Nothing at the key on the owner's PDS: the delete is already complete.
      if (found.kind === 'absent') return { kind: 'succeeded', uri, hints };
      swap = found.cid;
    }
    ctx.persist({ swapCid: swap });
  }
  const result = await ctx.xrpc.procedure(
    'com.atproto.repo.deleteRecord',
    { repo: op.did, collection: op.collection, rkey, swapRecord: swap },
    'delete',
  );
  if (result.ok) return { kind: 'succeeded', uri, hints, swapCid: swap };
  const failure = result.failure;
  if (failure.code === 'repository_changed' || failure.kind === 'missing') {
    const found = await ctx.xrpc.getRecord(op.collection, rkey);
    if (found.kind === 'failed') return failureOutcome(found.failure);
    if (found.kind === 'absent') return { kind: 'succeeded', uri, hints, swapCid: swap };
    return {
      kind: 'transient',
      code: failure.code === 'repository_changed' ? 'repository_changed' : 'remote_delete_unconfirmed',
      swapCid: found.cid,
    };
  }
  return failureOutcome(failure);
}

/** A create this delete waits for ended with proof that another writer holds the rkey. */
function createLostRkey(op: OperationRow, predecessors: readonly OperationRow[]): boolean {
  return predecessors.some(
    (p) =>
      p.kind === 'scrobble.create' &&
      p.collection === op.collection &&
      p.rkey === op.rkey &&
      p.state === 'failed' &&
      p.last_error !== null &&
      NOT_OURS_CODES.has(p.last_error),
  );
}

export const scrobbleDeleteExecutor: Executor = {
  async execute(op, ctx) {
    if (!hasIdentity(op, ctx, ctx.collections.scrobble)) return { kind: 'permanent', code: 'invalid_record_identity' };
    const predecessors = predecessorRows(ctx.m.db, op.id);
    if (createLostRkey(op, predecessors)) return { kind: 'succeeded', hints: [], note: 'record_not_ours' };
    return deleteWithSwap(op, ctx, predecessors);
  },
  async reconcile(op, ctx) {
    if (!hasIdentity(op, ctx, ctx.collections.scrobble)) return { kind: 'permanent', code: 'invalid_record_identity' };
    if (createLostRkey(op, predecessorRows(ctx.m.db, op.id))) {
      return { kind: 'succeeded', hints: [], note: 'record_not_ours' };
    }
    return lookupDeleted(op, ctx);
  },
};

/** Read-only: absent on the owner's PDS completes a delete. */
export async function lookupDeleted(op: OperationRow, ctx: ExecContext): Promise<Outcome> {
  const rkey = op.rkey as string;
  const found = await ctx.xrpc.getRecord(op.collection, rkey);
  if (found.kind === 'failed') return failureOutcome(found.failure);
  return found.kind === 'absent'
    ? {
        kind: 'succeeded',
        uri: `at://${op.did}/${op.collection}/${rkey}`,
        hints: [{ collection: op.collection, rkey }],
      }
    : { kind: 'transient', code: 'remote_delete_unconfirmed' };
}
