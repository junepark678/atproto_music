import { isTid } from '@atmusic/core/syntax';
import type { OperationRow, Origin } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import type { Db } from '../do/db';
import { bumpStatsVersion } from '../do/write/account-state';
import {
  explicitlyUnsent,
  insertOperation,
  newOperationId,
  outboxCollections,
  prepare as prepareBatchRecord,
} from './operations';
import { type Failure, failureOutcome, type Outcome, reportedCommitRev } from './pds-writer';
import {
  afterSend,
  answersRemoval,
  countedIfSent,
  definitelyRejected,
  keepRemovalCommit,
  keepRemovalDone,
  markReached,
  observeRemoval,
  type PinnedRequest,
  pinSend,
  rejectSend,
  removalPredecessors,
  sendDenied,
  supersedeUncertain,
  type TargetRead,
} from './removal-fence';
import type { ExecContext, Executor } from './runner';
import { validRkey } from './scrobble-ops';

/**
 * Transport classification decides first: only a failure classified as a
 * permanent scope denial (403, or a 4xx ScopeMissing/InsufficientScope/
 * Forbidden body, write-policy classify) holds the batch lane for re-consent.
 * A 5xx or transport failure whose body merely names a scope error stays
 * retryable; it never blocks the intent or asks the owner to sign in again.
 */
export function isBatchScopeDenial(failure: Failure): boolean {
  return failure.kind === 'permanent' && failure.code === 'forbidden_scope';
}

function batchFailure(failure: Failure): Outcome {
  return isBatchScopeDenial(failure) ? { kind: 'reauth', code: 'batch_scope_required' } : failureOutcome(failure);
}

/**
 * Durable suppression evidence (migration 9): the targets of removal
 * `operationId` were observed present in the container at `cid` before its
 * write (the admission projection, a pre-CAS read, a read-back that still
 * showed them). Only a receipt settled without a server-checked head
 * (migration 11 `removal_head_rev`, i.e. before that migration) is still
 * decided by these CIDs (read/visibility); current receipts keep them as
 * forensic evidence. Never recorded at settlement, and never a claim about
 * record_state.
 */
export function recordRemovalEvidence(db: Db, operationId: string, cid: string | null | undefined): void {
  if (typeof cid !== 'string' || cid.length === 0) return;
  db.run('INSERT OR IGNORE INTO listen_removal_cids(operation_id,cid) VALUES (?,?)', operationId, cid);
}

function selectedIn(listens: readonly unknown[], wanted: ReadonlySet<string>): boolean {
  return listens.some(
    (item) =>
      wanted.has('*') ||
      (item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as { id?: unknown }).id === 'string' &&
        wanted.has((item as { id: string }).id)),
  );
}

export interface BatchListenRemovalPlan {
  operationId: string;
  listenId: string;
  snapshot: Pick<
    OperationRow,
    | 'did'
    | 'kind'
    | 'origin'
    | 'collection'
    | 'rkey'
    | 'state'
    | 'attempts'
    | 'send_started_at_ms'
    | 'record_json'
    | 'digest'
    | 'updated_at_ms'
  >;
  replacement: { record: object; digest: string } | null;
  members: Array<{ job_id: string; seq: number; dedupe_key: string }>;
}

/** Prepare a never-sent import batch edit outside a transaction. */
export async function prepareUnsentBatchListenRemoval(
  m: ModuleDeps,
  args: { did: string; operationId: string; listenId: string },
): Promise<BatchListenRemovalPlan | null> {
  const op = m.db.one<OperationRow>('SELECT * FROM operations WHERE id = ?', args.operationId);
  if (
    op === null ||
    op.did !== args.did ||
    op.kind !== 'scrobble.create' ||
    op.origin !== 'import' ||
    op.collection !== (m.config.prefix === null ? null : outboxCollections(m.config.prefix).scrobbleBatch) ||
    op.rkey === null ||
    op.state !== 'queued' ||
    !explicitlyUnsent(op) ||
    op.result_uri !== null ||
    op.idempotency_key !== null ||
    op.last_error !== null ||
    op.record_json === null
  )
    return null;
  const uri = `at://${op.did}/${op.collection}/${op.rkey}`;
  if (
    m.db.one('SELECT 1 AS x FROM operation_deps WHERE op_id = ? OR pred_id = ?', op.id, op.id) !== null ||
    m.db.one('SELECT 1 AS x FROM record_state WHERE uri = ?', uri) !== null ||
    m.db.one('SELECT 1 AS x FROM scrobbles WHERE record_uri = ?', uri) !== null
  )
    return null;
  let record: { listens?: unknown[]; [key: string]: unknown };
  try {
    record = JSON.parse(op.record_json) as typeof record;
  } catch {
    return null;
  }
  if (!Array.isArray(record.listens)) return null;
  const matches = record.listens.filter(
    (entry) => entry !== null && typeof entry === 'object' && (entry as { id?: unknown }).id === args.listenId,
  );
  if (matches.length !== 1) return null;
  const mapped = m.db.all<{ job_id: string; seq: number; dedupe_key: string }>(
    `SELECT i.job_id,i.seq,i.dedupe_key FROM batch_entry_items b JOIN import_items i
       ON i.job_id=b.job_id AND i.seq=b.seq
     WHERE b.operation_id=? AND b.entry_id=? AND i.operation_id=? AND i.state='queued' AND i.removed_at_ms IS NULL`,
    op.id,
    args.listenId,
    op.id,
  );
  if (mapped.length === 0) return null;
  const listens = record.listens.filter(
    (entry) => !(entry !== null && typeof entry === 'object' && (entry as { id?: unknown }).id === args.listenId),
  );
  const replacement = listens.length === 0 ? null : await prepareBatchRecord({ ...record, listens });
  return {
    operationId: op.id,
    listenId: args.listenId,
    snapshot: {
      did: op.did,
      kind: op.kind,
      origin: op.origin,
      collection: op.collection,
      rkey: op.rkey,
      state: op.state,
      attempts: op.attempts,
      send_started_at_ms: op.send_started_at_ms,
      record_json: op.record_json,
      digest: op.digest,
      updated_at_ms: op.updated_at_ms,
    },
    replacement,
    members: mapped,
  };
}

export function commitUnsentBatchListenRemoval(m: ModuleDeps, plan: BatchListenRemovalPlan): OperationRow | null {
  const now = m.clock.nowMs();
  return m.db.tx(() => {
    const op = m.db.one<OperationRow>('SELECT * FROM operations WHERE id = ?', plan.operationId);
    if (
      op === null ||
      op.did !== plan.snapshot.did ||
      op.kind !== plan.snapshot.kind ||
      op.origin !== plan.snapshot.origin ||
      op.collection !== plan.snapshot.collection ||
      op.rkey !== plan.snapshot.rkey ||
      op.state !== plan.snapshot.state ||
      op.attempts !== plan.snapshot.attempts ||
      op.send_started_at_ms !== plan.snapshot.send_started_at_ms ||
      op.record_json !== plan.snapshot.record_json ||
      op.digest !== plan.snapshot.digest ||
      op.updated_at_ms !== plan.snapshot.updated_at_ms ||
      op.state !== 'queued' ||
      !explicitlyUnsent(op) ||
      op.rkey === null ||
      op.record_json === null ||
      op.result_uri !== null ||
      op.idempotency_key !== null ||
      op.last_error !== null
    )
      return null;
    const uri = `at://${op.did}/${op.collection}/${op.rkey}`;
    if (
      m.db.one('SELECT 1 AS x FROM operation_deps WHERE op_id = ? OR pred_id = ?', op.id, op.id) !== null ||
      m.db.one('SELECT 1 AS x FROM record_state WHERE uri = ?', uri) !== null ||
      m.db.one('SELECT 1 AS x FROM scrobbles WHERE record_uri = ?', uri) !== null
    )
      return null;
    const actual = m.db.all<{ job_id: string; seq: number; dedupe_key: string }>(
      `SELECT i.job_id,i.seq,i.dedupe_key FROM batch_entry_items b JOIN import_items i
         ON i.job_id=b.job_id AND i.seq=b.seq
       WHERE b.operation_id=? AND b.entry_id=? AND i.operation_id=? AND i.state='queued' AND i.removed_at_ms IS NULL`,
      op.id,
      plan.listenId,
      op.id,
    );
    if (
      actual.length !== plan.members.length ||
      actual.some(
        (member) =>
          !plan.members.some(
            (saved) =>
              saved.job_id === member.job_id && saved.seq === member.seq && saved.dedupe_key === member.dedupe_key,
          ),
      )
    )
      return null;
    m.db.run('DELETE FROM batch_entry_items WHERE operation_id = ? AND entry_id = ?', op.id, plan.listenId);
    for (const member of plan.members) {
      m.db.run(
        `UPDATE import_items SET removal_operation_id = NULL, removed_at_ms = ?, record_json = '{}'
         WHERE job_id = ? AND seq = ? AND operation_id = ? AND removed_at_ms IS NULL`,
        now,
        member.job_id,
        member.seq,
        op.id,
      );
      m.db.run(
        'DELETE FROM listen_keys WHERE did = ? AND operation_id = ? AND dedupe_key = ?',
        op.did,
        op.id,
        member.dedupe_key,
      );
    }
    if (plan.replacement === null) {
      if (
        (m.db.one<{ n: number }>('SELECT count(*) AS n FROM batch_entry_items WHERE operation_id = ?', op.id)?.n ??
          0) !== 0
      ) {
        throw new Error('empty batch removal left sibling mappings');
      }
      m.db.run(
        `UPDATE operations SET state='cancelled',last_error='batch_item_removed_before_send',record_json=NULL,digest=NULL,updated_at_ms=?
         WHERE id=? AND state='queued' AND attempts=0 AND send_started_at_ms IS NULL`,
        now,
        op.id,
      );
    } else {
      m.db.run(
        `UPDATE operations SET record_json=?,digest=?,updated_at_ms=?
         WHERE id=? AND state='queued' AND attempts=0 AND send_started_at_ms IS NULL`,
        JSON.stringify(plan.replacement.record),
        plan.replacement.digest,
        now,
        op.id,
      );
    }
    return m.db.one<OperationRow>('SELECT * FROM operations WHERE id = ?', op.id);
  });
}

function batchUri(did: string, uri: string, collection: string): string | null {
  const prefix = `at://${did}/${collection}/`;
  if (!uri.startsWith(prefix)) return null;
  const rkey = uri.slice(prefix.length);
  return validRkey(rkey) ? rkey : null;
}

export class NotOwnBatchError extends RangeError {
  constructor() {
    super('expected one of your own batch listen records');
    this.name = 'NotOwnBatchError';
  }
}

export function enqueueBatchListenDelete(
  m: ModuleDeps,
  args: {
    did: string;
    uri: string;
    listenIds: string[];
    origin: Origin;
    kick?: () => void;
  },
): OperationRow {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const collection = outboxCollections(prefix).scrobbleBatch;
  const rkey = batchUri(args.did, args.uri, collection);
  if (rkey === null || args.listenIds.length === 0 || args.listenIds.some((id) => id !== '*' && !isTid(id))) {
    throw new NotOwnBatchError();
  }
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
    for (const id of [...new Set(args.listenIds)]) {
      m.db.run('INSERT INTO batch_delete_listens(operation_id,listen_id) VALUES (?,?)', inserted.id, id);
      if (id !== '*') {
        const memberships = m.db.all<{ create_id: string; job_id: string; seq: number }>(
          `SELECT b.operation_id AS create_id,b.job_id,b.seq FROM batch_entry_items b
           JOIN operations c ON c.id=b.operation_id
           WHERE c.did=? AND c.collection=? AND c.rkey=? AND c.kind='scrobble.create' AND b.entry_id=?`,
          args.did,
          collection,
          rkey,
          id,
        );
        for (const member of memberships) {
          m.db.run(
            'UPDATE batch_entry_items SET removal_operation_id = ? WHERE operation_id = ? AND entry_id = ? AND job_id = ? AND seq = ?',
            inserted.id,
            member.create_id,
            id,
            member.job_id,
            member.seq,
          );
          m.db.run(
            'UPDATE import_items SET removal_operation_id = ? WHERE job_id = ? AND seq = ?',
            inserted.id,
            member.job_id,
            member.seq,
          );
        }
      } else {
        const memberships = m.db.all<{ create_id: string; entry_id: string; job_id: string; seq: number }>(
          `SELECT b.operation_id AS create_id,b.entry_id,b.job_id,b.seq FROM batch_entry_items b
           JOIN operations c ON c.id=b.operation_id
           WHERE c.did=? AND c.collection=? AND c.rkey=? AND c.kind='scrobble.create'`,
          args.did,
          collection,
          rkey,
        );
        for (const member of memberships) {
          m.db.run(
            'UPDATE batch_entry_items SET removal_operation_id = ? WHERE operation_id = ? AND entry_id = ?',
            inserted.id,
            member.create_id,
            member.entry_id,
          );
          m.db.run(
            'UPDATE import_items SET removal_operation_id = ? WHERE job_id = ? AND seq = ?',
            inserted.id,
            member.job_id,
            member.seq,
          );
        }
      }
      // The admission CID: the item's projected container CID, or for a
      // whole-container intent the container's projected CID.
      const cid =
        (id === '*'
          ? m.db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE record_uri = ? LIMIT 1', args.uri)?.cid
          : m.db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE record_uri = ? AND listen_id = ?', args.uri, id)
              ?.cid) ?? null;
      recordRemovalEvidence(m.db, inserted.id, cid);
      m.db.run(
        `INSERT INTO listen_removals(did,record_uri,listen_id,created_at_ms,operation_id,removed_cid)
        VALUES (?,?,?,?,?,?) ON CONFLICT(did,record_uri,listen_id) DO UPDATE SET
        created_at_ms=excluded.created_at_ms, operation_id=excluded.operation_id, removed_cid=excluded.removed_cid`,
        args.did,
        args.uri,
        id,
        now,
        inserted.id,
        cid,
      );
    }
    // An earlier unresolved removal whose targets this intent covers never
    // sends again; this one carries the hiding and the write.
    supersedeUncertain(m.db, inserted.id, now);
    bumpStatsVersion(m.db, args.did);
    return inserted;
  });
  args.kick?.();
  return op;
}

/**
 * The owner's current batch container at the operation's key, validated, or a
 * terminal/retry outcome. Shared by execution and read-only reconciliation.
 */
type ContainerRead =
  | { kind: 'absent' }
  | { kind: 'present'; cid: string; record: Record<string, unknown>; listens: unknown[] }
  | { kind: 'outcome'; outcome: Outcome };

async function readContainer(op: OperationRow, ctx: ExecContext, uri: string): Promise<ContainerRead> {
  const found = await ctx.xrpc.getRecord(op.collection!, op.rkey!);
  if (found.kind === 'failed') return { kind: 'outcome', outcome: batchFailure(found.failure) };
  if (found.kind === 'absent') return { kind: 'absent' };
  if (found.uri !== uri)
    return { kind: 'outcome', outcome: { kind: 'permanent', code: 'invalid_batch_record_identity' } };
  const record = found.value;
  if (
    record === null ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    (record as Record<string, unknown>).$type !== ctx.collections.scrobbleBatch ||
    !Array.isArray((record as { listens?: unknown }).listens)
  )
    return { kind: 'outcome', outcome: { kind: 'permanent', code: 'invalid_batch_record' } };
  return {
    kind: 'present',
    cid: found.cid,
    record: record as Record<string, unknown>,
    listens: (record as { listens: unknown[] }).listens,
  };
}

type PresentContainer = Extract<ContainerRead, { kind: 'present' }>;

/** The container read as a removal's targets: gone when absent or none of `wanted` is listed. */
async function readTargets(
  op: OperationRow,
  ctx: ExecContext,
  uri: string,
  wanted: ReadonlySet<string>,
): Promise<TargetRead<PresentContainer>> {
  const found = await readContainer(op, ctx, uri);
  if (found.kind === 'outcome') return found;
  if (found.kind === 'absent' || !selectedIn(found.listens, wanted)) return { kind: 'absent' };
  return { kind: 'present', found };
}

function removalIds(db: Db, id: string): string[] {
  return db
    .all<{ listen_id: string }>(
      'SELECT listen_id FROM batch_delete_listens WHERE operation_id=? ORDER BY listen_id',
      id,
    )
    .map((r) => r.listen_id);
}

// Success outcomes never carry a post-write or post-removal CID: the persisted
// `swap_cid` stays the last pre-CAS CID. Every write is fenced by the owner's
// repository head (removal-fence.ts): `swapCommit` = the head read just before
// the container, persisted as `removal_head_rev` before the send. A valid
// success answer (any commit metadata) or an absence is durable no-replay
// knowledge, persisted before the read-back is awaited; settlement then needs
// an ordered boundary (`removal_done_rev`): an enforced commit, a stable
// head/read/head bracket, a verified absence, or the first head read after
// the requested state was reached (`observeRemoval`). Once reached, no retry
// writes again, whatever the read-back finds.
async function removeIds(op: OperationRow, ctx: ExecContext): Promise<Outcome> {
  const collection = ctx.collections.scrobbleBatch;
  if (op.did !== ctx.xrpc.did || op.collection !== collection || !validRkey(op.rkey))
    return { kind: 'permanent', code: 'invalid_record_identity' };
  const uri = `at://${op.did}/${op.collection}/${op.rkey}`;
  const hints = [{ collection, rkey: op.rkey }];
  const collidedCreate = ctx.m.db.one<{ id: string }>(
    `SELECT p.id FROM operation_deps d JOIN operations p ON p.id = d.pred_id
     WHERE d.op_id = ? AND p.did = ? AND p.collection = ? AND p.rkey = ?
       AND p.kind = 'scrobble.create' AND p.state = 'failed' AND p.last_error = 'remote_record_conflict'
     LIMIT 1`,
    op.id,
    op.did,
    op.collection,
    op.rkey,
  );
  if (collidedCreate !== null) {
    return { kind: 'succeeded', uri, note: 'record_not_ours', hints };
  }
  const ids = removalIds(ctx.m.db, op.id);
  if (ids.length === 0) return { kind: 'permanent', code: 'missing_batch_delete_intent' };
  const wanted = new Set(ids);
  const read = () => readTargets(op, ctx, uri, wanted);
  let sent = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    // Head first, then the container: the CAS below commits only while this
    // head is current, so the container read is the state the write replaces.
    // Once the requested state is known to be reached this answers only
    // `settled` or an outcome (a read-only hold): never a write. An earlier
    // send with an unknown outcome allows only its own exact request, and
    // only while the head is still its root (removal-fence.ts).
    const seen = await observeRemoval(ctx, op.id, uri, ids, read);
    if (seen.kind === 'outcome') return countedIfSent(seen.outcome, sent);
    if (seen.kind === 'settled') return { kind: 'succeeded', uri, hints };
    const { head, found } = seen;
    let request: PinnedRequest;
    if (seen.resend !== undefined) {
      request = seen.resend;
    } else {
      const remoteListens = found.listens;
      const kept = wanted.has('*') ? [] : remoteListens.filter((item) => !selectedIn([item], wanted));
      const record = kept.length === 0 ? undefined : { ...found.record, listens: kept };
      request = {
        method: record === undefined ? 'com.atproto.repo.deleteRecord' : 'com.atproto.repo.putRecord',
        body:
          record === undefined
            ? { repo: op.did, collection: op.collection, rkey: op.rkey, swapCommit: head.cid, swapRecord: found.cid }
            : {
                repo: op.did,
                collection: op.collection,
                rkey: op.rkey,
                record,
                swapCommit: head.cid,
                swapRecord: found.cid,
              },
        head,
      };
    }
    const record = request.body.record as object | undefined;
    const budget = ctx.afford(record === undefined ? 1 : 2);
    if (budget !== null) return countedIfSent(budget, sent);
    // Persisted before the send: a restart after this write keeps the exact
    // request (swapCommit, swapRecord, bytes) and its head fence even if the
    // PDS committed and the success response was lost.
    recordRemovalEvidence(ctx.m.db, op.id, found.cid);
    ctx.persist({ swapCid: found.cid });
    // The final gate (one synchronous transaction): still this running
    // attempt, and exactly the request this removal may send. Nothing is
    // awaited between a passed gate and the dispatch below.
    const gate = pinSend(ctx.m.db, op, request, ctx.m.clock.nowMs());
    if (!gate.ok) return countedIfSent(sendDenied(ctx, op.id, gate), sent);
    sent = true;
    const result = await ctx.xrpc.procedure(request.method, request.body, record === undefined ? 'delete' : 'put');
    // Only a received refusal of this very send proves it changed nothing
    // (a refusal of a re-send says nothing about the first one).
    if (gate.original && definitelyRejected(result)) rejectSend(ctx.m.db, op.id);
    // InvalidSwap: something (this record or any other) was committed after
    // the head; nothing was written. Read a fresh head and container.
    if (!result.ok && result.failure.code === 'repository_changed') continue;
    // A valid success answer is no-replay knowledge at once, before anything
    // else is awaited. Only a well-formed commit newer than the head also
    // orders it (the PDS enforced the swaps and wrote); a no-op or metadata
    // left out is ordered by the read-back. A body that does not answer this
    // request certifies nothing and is read back like a lost answer.
    const answered = result.ok && answersRemoval(result.body, record === undefined ? { uri } : { uri, record });
    if (answered) {
      const commit = reportedCommitRev(result.body, head.rev);
      markReached(ctx.m.db, op.id, commit === null ? 'success' : 'commit', ctx.m.clock.nowMs());
      if (commit !== null) {
        keepRemovalCommit(ctx.m.db, op.id, commit);
        keepRemovalDone(ctx.m.db, op.id, commit, 'commit');
      }
    }
    // Always read back the owner-scoped URI before marking intent complete.
    const after = await observeRemoval(ctx, op.id, uri, ids, read);
    if (after.kind === 'outcome') {
      // A classified write failure decides first (a scope denial holds the
      // lane); otherwise the read-back failure does.
      if (!result.ok && isBatchScopeDenial(result.failure)) return batchFailure(result.failure);
      return afterSend(ctx.m.db, op.id, after.outcome);
    }
    if (after.kind === 'settled') return { kind: 'succeeded', uri, hints };
    // The targets are still there and nothing proves this write happened:
    // that CID is pre-removal evidence too.
    recordRemovalEvidence(ctx.m.db, op.id, after.found.cid);
    if (result.ok) return { kind: 'transient', code: 'remote_delete_unconfirmed' };
    if (result.failure.kind === 'missing') continue;
    // A transient (5xx/transport) failure retries with backoff whatever its
    // body names; only a classified permanent denial holds for re-consent.
    return batchFailure(result.failure);
  }
  return { kind: 'transient', code: 'repository_changed' };
}

export const batchDeleteExecutor: Executor = {
  async execute(op, ctx) {
    return removeIds(op, ctx);
  },
  async reconcile(op, ctx) {
    const collection = ctx.collections.scrobbleBatch;
    if (op.did !== ctx.xrpc.did || op.collection !== collection || !validRkey(op.rkey))
      return { kind: 'permanent', code: 'invalid_record_identity' };
    const uri = `at://${op.did}/${op.collection}/${op.rkey}`;
    const hints = [{ collection, rkey: op.rkey! }];
    // Read-only: never a write. An absence is no-replay knowledge and settles
    // once ordered (a stable bracket, or the first head read after it); a
    // lost tenth send keeps the send fence persisted before it.
    const ids = removalIds(ctx.m.db, op.id);
    const seen = await observeRemoval(ctx, op.id, uri, ids, () => readTargets(op, ctx, uri, new Set(ids)), 'reconcile');
    if (seen.kind === 'outcome') return seen.outcome;
    if (seen.kind === 'settled') return { kind: 'succeeded', uri, hints };
    recordRemovalEvidence(ctx.m.db, op.id, seen.found.cid);
    return { kind: 'transient', code: 'batch_delete_unconfirmed' };
  },
};
