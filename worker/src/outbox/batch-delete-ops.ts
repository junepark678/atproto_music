import { isTid } from '@atmusic/core/syntax';
import type { OperationRow, Origin } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import { bumpStatsVersion } from '../do/write/account-state';
import { insertOperation, newOperationId, outboxCollections, unsettledAt } from './operations';
import { failureOutcome, type Outcome } from './pds-writer';
import type { ExecContext, Executor } from './runner';
import { validRkey } from './scrobble-ops';

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
        predecessors: unsettledAt(m.db, args.did, collection, rkey),
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
      const cid =
        m.db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE record_uri = ? AND listen_id = ?', args.uri, id)
          ?.cid ?? null;
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
    bumpStatsVersion(m.db, args.did);
    return inserted;
  });
  args.kick?.();
  return op;
}

async function removeIds(op: OperationRow, ctx: ExecContext): Promise<Outcome> {
  const uri = `at://${op.did}/${op.collection}/${op.rkey}`;
  const ids = ctx.m.db
    .all<{ listen_id: string }>(
      'SELECT listen_id FROM batch_delete_listens WHERE operation_id=? ORDER BY listen_id',
      op.id,
    )
    .map((r) => r.listen_id);
  if (ids.length === 0) return { kind: 'permanent', code: 'missing_batch_delete_intent' };
  const wanted = new Set(ids);
  for (let attempt = 0; attempt < 5; attempt++) {
    const found = await ctx.xrpc.getRecord(op.collection!, op.rkey!);
    if (found.kind === 'failed') return failureOutcome(found.failure);
    if (found.kind === 'absent')
      return { kind: 'succeeded', uri, hints: [{ collection: op.collection!, rkey: op.rkey! }] };
    const record = found.value as { listens?: unknown[]; [key: string]: unknown };
    if (!Array.isArray(record.listens)) return { kind: 'permanent', code: 'invalid_batch_record' };
    const kept = record.listens.filter((item) => {
      const selected =
        wanted.has('*') ||
        (item !== null && typeof item === 'object' && wanted.has(String((item as { id?: unknown }).id)));
      return !selected;
    });
    if (kept.length === record.listens.length)
      return { kind: 'succeeded', uri, swapCid: found.cid, hints: [{ collection: op.collection!, rkey: op.rkey! }] };
    const budget = ctx.afford(kept.length === 0 ? 1 : 2);
    if (budget !== null) return budget;
    const body =
      kept.length === 0
        ? { repo: op.did, collection: op.collection, rkey: op.rkey, swapRecord: found.cid }
        : {
            repo: op.did,
            collection: op.collection,
            rkey: op.rkey,
            record: { ...record, listens: kept },
            swapRecord: found.cid,
          };
    const method = kept.length === 0 ? 'com.atproto.repo.deleteRecord' : 'com.atproto.repo.putRecord';
    const result = await ctx.xrpc.procedure(method, body, kept.length === 0 ? 'delete' : 'put');
    if (result.ok)
      return { kind: 'succeeded', uri, swapCid: found.cid, hints: [{ collection: op.collection!, rkey: op.rkey! }] };
    if (result.failure.code === 'repository_changed') continue;
    // A response can be lost after commit: prove whether the intended edit landed.
    const after = await ctx.xrpc.getRecord(op.collection!, op.rkey!);
    if (after.kind === 'present') {
      const afterListens = (after.value as { listens?: unknown[] }).listens;
      if (!Array.isArray(afterListens)) return { kind: 'permanent', code: 'invalid_batch_record' };
      const remaining = wanted.has('*')
        ? afterListens
        : afterListens.filter(
            (i) => i !== null && typeof i === 'object' && wanted.has(String((i as { id?: unknown }).id)),
          );
      if (remaining.length === 0)
        return { kind: 'succeeded', uri, swapCid: after.cid, hints: [{ collection: op.collection!, rkey: op.rkey! }] };
      if (result.failure.kind === 'transient' || result.failure.kind === 'missing') continue;
      return failureOutcome(result.failure);
    }
    if (after.kind === 'absent')
      return { kind: 'succeeded', uri, hints: [{ collection: op.collection!, rkey: op.rkey! }] };
    return failureOutcome(after.failure);
  }
  return { kind: 'transient', code: 'repository_changed' };
}

export const batchDeleteExecutor: Executor = {
  execute: removeIds,
  async reconcile(op, ctx) {
    const found = await ctx.xrpc.getRecord(op.collection!, op.rkey!);
    if (found.kind === 'failed') return failureOutcome(found.failure);
    const uri = `at://${op.did}/${op.collection}/${op.rkey}`;
    if (found.kind === 'absent')
      return { kind: 'succeeded', uri, hints: [{ collection: op.collection!, rkey: op.rkey! }] };
    const ids = new Set(
      ctx.m.db
        .all<{ listen_id: string }>('SELECT listen_id FROM batch_delete_listens WHERE operation_id = ?', op.id)
        .map((row) => row.listen_id),
    );
    const listens = (found.value as { listens?: { id?: unknown }[] }).listens;
    if (!Array.isArray(listens)) return { kind: 'permanent', code: 'invalid_batch_record' };
    const remains = ids.has('*') || listens.some((item) => ids.has(String(item.id)));
    return remains
      ? { kind: 'transient', code: 'batch_delete_unconfirmed' }
      : { kind: 'succeeded', uri, swapCid: found.cid, hints: [{ collection: op.collection!, rkey: op.rkey! }] };
  },
};
