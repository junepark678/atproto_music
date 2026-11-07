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
// - It also carries `swapCommit`: the owner's repository head, read just
//   before and persisted as the receipt's `removal_head_rev` (removal-fence.ts),
//   so every revision at or below it precedes the removal.
// - InvalidSwap: re-fetch from the PDS and reconcile. Absent → done; present
//   at the same CID (only another commit moved the head) → retry in the same
//   attempt with a fresh head; present with another CID → retry (a counted
//   attempt) with that CID.
// - RecordNotFound (or a 404): look it up; absence completes the delete.
// - An unknown outcome (a crash after the send, a lost or invalid answer, a
//   5xx) leaves the exact request pinned (migration 14): it is re-sent only
//   while the head is still its root, and otherwise holds read-only until an
//   absence, a verified absence or a later explicit intent resolves it
//   (removal-fence.ts). Only a received 4xx of that same send allows a new fence.
// - Never another writer's record: a delete enqueued behind our own create of
//   the URI whose create ended `remote_record_conflict` completes locally with
//   no PDS request (`record_not_ours`), since our listen never existed there.
// - Removal of a create that is not indexed yet (library.removeScrobble):
//   one explicitly never sent (its `unsent` insertion receipt, no attempt) is
//   `cancelled` — nothing reaches the PDS, its listen key and its unsent
//   forward rows are deleted — while one that is running, was sent, or whose
//   send state is unknown (a migrated or refunded row, even at 0 attempts)
//   gets a `scrobble.delete` chained after it as a predecessor: the create is
//   reconciled at its original rkey and the delete then removes the record.

import { isTid } from '@atmusic/core/syntax';
import type { OperationRow, Origin } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import { bumpStatsVersion } from '../do/write/account-state';
import {
  cancelUnsent,
  insertOperation,
  loadOperation,
  newOperationId,
  outboxCollections,
  predecessorRows,
} from './operations';
import { failureOutcome, type Outcome, reportedCommitRev } from './pds-writer';
import {
  afterSend,
  answersRemoval,
  checkedHead,
  countedIfSent,
  definitelyRejected,
  keepRemovalCommit,
  keepRemovalDone,
  markReached,
  observeRemoval,
  type PinnedRequest,
  pinSend,
  type RepoHeadRef,
  refusedWhileUnknown,
  rejectSend,
  removalEstablished,
  removalPredecessors,
  removalReached,
  sendDenied,
  supersedeUncertain,
  type TargetRead,
  uncertainSend,
} from './removal-fence';
import type { ExecContext, Executor } from './runner';
import { hasIdentity, validRkey } from './scrobble-ops';

/** Splits `at://did/collection/rkey` when it names one record of `collection` owned by `did`. */
export function ownRecordKey(uri: string, did: string, collection: string): string | null {
  if (uri.includes('#')) return null;
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
  const op = m.db.tx(() => {
    const inserted = insertOperation(
      m.db,
      {
        id: newOperationId(m.random),
        did: args.did,
        kind: 'scrobble.delete',
        origin: args.origin,
        collection,
        rkey,
        dueAt: now,
        // Never behind a removal holding an unknown send (removal-fence.ts).
        predecessors: removalPredecessors(m.db, args.did, collection, rkey),
      },
      now,
    );
    // An earlier unresolved removal of the record never sends again.
    supersedeUncertain(m.db, inserted.id, now);
    // A newly admitted local tombstone changes public stats before the PDS
    // proof removes the verified projection row.
    bumpStatsVersion(m.db, args.did);
    return inserted;
  });
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
  args: { did: string; operationId: string; origin: Origin; listenId?: string; kick?: () => void },
): RemoveCreateResult {
  const now = m.clock.nowMs();
  const result = m.db.tx((): RemoveCreateResult => {
    const op = loadOperation(m.db, args.operationId);
    if (op === null || op.did !== args.did || op.kind !== 'scrobble.create' || op.rkey === null) {
      return { status: 'not_found' };
    }
    if (op.collection?.endsWith('.scrobbleBatch')) {
      // A batch create owns several listens. Never cancel it as though it were
      // one scrobble; a caller must name the exact entry to chain its removal.
      const id = args.listenId;
      if (id === undefined || !isTid(id)) return { status: 'not_found' };
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
          predecessors: [op.id, ...removalPredecessors(m.db, args.did, op.collection, op.rkey)],
        },
        now,
      );
      m.db.run('INSERT INTO batch_delete_listens(operation_id,listen_id) VALUES (?,?)', del.id, id);
      supersedeUncertain(m.db, del.id, now);
      const membership = m.db.one<{ job_id: string; seq: number }>(
        'SELECT job_id,seq FROM batch_entry_items WHERE operation_id = ? AND entry_id = ?',
        op.id,
        id,
      );
      if (membership !== null) {
        m.db.run(
          'UPDATE batch_entry_items SET removal_operation_id = ? WHERE operation_id = ? AND entry_id = ?',
          del.id,
          op.id,
          id,
        );
        m.db.run(
          'UPDATE import_items SET removal_operation_id = ? WHERE job_id = ? AND seq = ?',
          del.id,
          membership.job_id,
          membership.seq,
        );
      }
      const uri = `at://${args.did}/${op.collection}/${op.rkey}`;
      const cid =
        m.db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE record_uri=? AND listen_id=?', uri, id)?.cid ?? null;
      m.db.run(
        `INSERT INTO listen_removals(did,record_uri,listen_id,created_at_ms,operation_id,removed_cid)
        VALUES (?,?,?,?,?,?) ON CONFLICT(did,record_uri,listen_id) DO UPDATE SET
        created_at_ms=excluded.created_at_ms,operation_id=excluded.operation_id,removed_cid=excluded.removed_cid`,
        args.did,
        uri,
        id,
        now,
        del.id,
        cid,
      );
      return { status: 'delete_chained', operation: op, delete: del };
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
        predecessors: [op.id, ...removalPredecessors(m.db, args.did, op.collection, op.rkey)],
      },
      now,
    );
    supersedeUncertain(m.db, del.id, now);
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

/** The single record as a removal's target on the owner's PDS. */
async function readRecord(ctx: ExecContext, collection: string, rkey: string): Promise<TargetRead<{ cid: string }>> {
  const found = await ctx.xrpc.getRecord(collection, rkey);
  if (found.kind === 'failed') return { kind: 'outcome', outcome: failureOutcome(found.failure) };
  if (found.kind === 'absent') return { kind: 'absent' };
  return { kind: 'present', found: { cid: found.cid } };
}

/** The verified-membership target of a single record removal: the record itself. */
const RECORD_TARGET = ['*'] as const;

/**
 * deleteRecord with swapCommit and swapRecord, reconciling InvalidSwap and
 * RecordNotFound against the owner's PDS. A valid success answer (whatever
 * its commit metadata) or an absence is durable no-replay knowledge, persisted
 * before the read-back; it settles with an ordered boundary
 * (removal-fence.ts): an enforced commit, a stable head bracket, a verified
 * absence, or the first head read after the requested state was reached. A
 * success without a usable commit (the reference PDS's no-op delete of an
 * absent record checks no swap) is ordered by that read-back. Once reached,
 * no retry deletes again.
 */
async function deleteWithSwap(op: OperationRow, ctx: ExecContext, predecessors: OperationRow[]): Promise<Outcome> {
  const rkey = op.rkey as string;
  const uri = `at://${op.did}/${op.collection}/${rkey}`;
  const hints = [{ collection: op.collection, rkey }];
  const read = () => readRecord(ctx, op.collection, rkey);
  const observe = () => observeRemoval(ctx, op.id, uri, RECORD_TARGET, read);
  let swap = op.swap_cid;
  let sent = false;
  for (let tries = 0; tries < 5; tries++) {
    let head: RepoHeadRef;
    if (
      removalEstablished(ctx.m.db, op.id, uri, RECORD_TARGET, ctx.m.clock.nowMs()) ||
      removalReached(ctx.m.db, op.id)
    ) {
      // The requested state was reached already (an answered success, an
      // absence, a verified absence after a lost answer): never delete again;
      // a present record is a later incarnation. Read-only until ordered.
      const seen = await observe();
      if (seen.kind === 'outcome') return seen.outcome;
      return { kind: 'succeeded', uri, hints, ...(swap === null ? {} : { swapCid: swap }) };
    }
    let resend: PinnedRequest | undefined;
    if (swap === null) {
      swap = indexedCid(ctx, uri);
      if (swap === null) {
        const ours = predecessors.find(
          (p) => p.kind === 'scrobble.create' && p.rkey === rkey && p.state === 'succeeded' && p.result_cid !== null,
        );
        swap = ours?.result_cid ?? null;
      }
    }
    if (swap === null || uncertainSend(ctx.m.db, op.id) !== null) {
      // Nothing known locally, or an earlier send's outcome is unknown: the
      // owner's PDS decides. Gone there (ordered) completes the delete; with
      // an unknown send only its exact request may go again, at its own root.
      const seen = await observe();
      if (seen.kind === 'outcome') return countedIfSent(seen.outcome, sent);
      if (seen.kind === 'settled')
        return { kind: 'succeeded', uri, hints, ...(swap === null ? {} : { swapCid: swap }) };
      head = seen.head;
      resend = seen.resend;
      if (resend !== undefined) swap = String(resend.body.swapRecord);
      else if (swap === null) swap = seen.found.cid;
      if (op.swap_cid !== swap) ctx.persist({ swapCid: swap });
    } else {
      const checked = await checkedHead(ctx, uri, op.id);
      if (checked.kind === 'outcome') return countedIfSent(checked.outcome, sent);
      head = { cid: checked.cid, rev: checked.rev };
      if (op.swap_cid !== swap) ctx.persist({ swapCid: swap });
    }
    const request: PinnedRequest = resend ?? {
      method: 'com.atproto.repo.deleteRecord',
      body: { repo: op.did, collection: op.collection, rkey, swapCommit: head.cid, swapRecord: swap },
      head,
    };
    // Persisted before the send (with the fence): a crash, a lost or invalid
    // answer or a 5xx leaves exactly this request pending (removal-fence.ts).
    // The final gate (one synchronous transaction): still this running
    // attempt, and exactly the request this removal may send. Nothing is
    // awaited between a passed gate and the dispatch below.
    const gate = pinSend(ctx.m.db, op, request, ctx.m.clock.nowMs());
    if (!gate.ok) return countedIfSent(sendDenied(ctx, op.id, gate), sent);
    sent = true;
    const result = await ctx.xrpc.procedure(request.method, request.body, 'delete');
    // Only a received refusal of this very send proves it changed nothing.
    if (gate.original && definitelyRejected(result)) rejectSend(ctx.m.db, op.id);
    if (result.ok) {
      if (answersRemoval(result.body, { uri })) {
        const commit = reportedCommitRev(result.body, head.rev);
        // No-replay knowledge first, before anything else is awaited.
        markReached(ctx.m.db, op.id, commit === null ? 'success' : 'commit', ctx.m.clock.nowMs());
        if (commit !== null) {
          keepRemovalCommit(ctx.m.db, op.id, commit);
          keepRemovalDone(ctx.m.db, op.id, commit, 'commit');
          return { kind: 'succeeded', uri, hints, swapCid: swap };
        }
      }
      // No usable commit (a no-op that checked no swap, or a write whose
      // metadata was left out): the read-back orders it, read-only. A body
      // that does not answer this request is read back like a lost answer.
      const seen = await observe();
      if (seen.kind === 'outcome') return afterSend(ctx.m.db, op.id, seen.outcome);
      if (seen.kind === 'settled') return { kind: 'succeeded', uri, hints, swapCid: swap };
      return { kind: 'transient', code: 'remote_delete_unconfirmed', swapCid: seen.found.cid };
    }
    const failure = result.failure;
    // A received refusal while an earlier send is still unknown (this was its
    // exact re-send) proves nothing about that send: read back, and never fail
    // on it (refusedWhileUnknown). A sign-in failure blocks at once.
    const refusedUnknown =
      failure.kind !== 'reauth' && definitelyRejected(result) && uncertainSend(ctx.m.db, op.id) !== null;
    if (failure.code !== 'repository_changed' && failure.kind !== 'missing' && !refusedUnknown) {
      return failureOutcome(failure);
    }
    const seen = await observe();
    if (seen.kind === 'outcome') return afterSend(ctx.m.db, op.id, seen.outcome);
    if (seen.kind === 'settled') return { kind: 'succeeded', uri, hints, swapCid: swap };
    if (refusedUnknown && failure.code !== 'repository_changed' && failure.kind !== 'missing') {
      return refusedWhileUnknown(ctx, op.id, failureOutcome(failure));
    }
    // The record is unchanged and only the repository head moved: retry now
    // against a fresh head (no attempt spent on an unrelated commit).
    if (failure.code === 'repository_changed' && seen.found.cid === swap) continue;
    return {
      kind: 'transient',
      code: failure.code === 'repository_changed' ? 'repository_changed' : 'remote_delete_unconfirmed',
      swapCid: seen.found.cid,
    };
  }
  return { kind: 'transient', code: 'repository_changed', ...(swap === null ? {} : { swapCid: swap }) };
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

/**
 * Read-only: absent on the owner's PDS completes a delete (no-replay at once),
 * settled once ordered (a stable head bracket, or the first head read after
 * the absence; removal-fence.ts).
 */
export async function lookupDeleted(op: OperationRow, ctx: ExecContext): Promise<Outcome> {
  const rkey = op.rkey as string;
  const uri = `at://${op.did}/${op.collection}/${rkey}`;
  const seen = await observeRemoval(
    ctx,
    op.id,
    uri,
    RECORD_TARGET,
    () => readRecord(ctx, op.collection, rkey),
    'reconcile',
  );
  if (seen.kind === 'outcome') return seen.outcome;
  if (seen.kind === 'present') return { kind: 'transient', code: 'remote_delete_unconfirmed' };
  return { kind: 'succeeded', uri, hints: [{ collection: op.collection, rkey }] };
}
