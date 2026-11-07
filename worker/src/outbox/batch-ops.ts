// Durable createRecord execution for import scrobbleBatch containers.
import { measureScrobbleBatch } from '@atmusic/atproto/scrobble-batch-size';
import {
  BATCH_MAX_LISTENS,
  MAX_CBOR_BYTES,
  MAX_CREATE_BODY_BYTES,
  type ScrobbleBatchRecord,
  scrobbleBatchCollection,
} from '@atmusic/core/scrobble-batch';
import type { OperationRow } from '../app/rows';
import { recordOf } from './operations';
import type { ExecContext, Executor } from './runner';
import { createWithReconcile, hasIdentity, lookupCreate, sameDigest } from './scrobble-ops';

function isBatchRecord(value: unknown, collection: string): value is ScrobbleBatchRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.$type === collection &&
    typeof record.createdAt === 'string' &&
    Array.isArray(record.listens) &&
    record.listens.length > 0 &&
    record.listens.length <= BATCH_MAX_LISTENS
  );
}

function valid(op: OperationRow, ctx: ExecContext, forSend = true): boolean {
  const prefix = ctx.m.config.prefix;
  if ((forSend && !ctx.m.config.batchPublication) || prefix === null) return false;
  const collection = scrobbleBatchCollection(prefix);
  if (!hasIdentity(op, ctx, collection) || op.digest === null) return false;
  const record = recordOf(op);
  if (!isBatchRecord(record, collection)) return false;
  try {
    const sizes = measureScrobbleBatch(record, { repo: op.did, collection, rkey: op.rkey as string });
    return sizes.cborBytes <= MAX_CBOR_BYTES && sizes.createBodyBytes <= MAX_CREATE_BODY_BYTES;
  } catch {
    return false;
  }
}

export const batchCreateExecutor: Executor = {
  async execute(op, ctx) {
    if (!valid(op, ctx)) return { kind: 'permanent', code: 'invalid_batch_record' };
    const outcome = await createWithReconcile(op, ctx, (remote) => sameDigest(op, remote));
    return outcome.kind === 'permanent' && outcome.code === 'forbidden_scope'
      ? { kind: 'reauth', code: 'batch_scope_required' }
      : outcome;
  },
  async reconcile(op, ctx) {
    if (!valid(op, ctx, false)) return { kind: 'permanent', code: 'invalid_batch_record' };
    return lookupCreate(op, ctx, (remote) => sameDigest(op, remote), 'attempts_exhausted');
  },
};
