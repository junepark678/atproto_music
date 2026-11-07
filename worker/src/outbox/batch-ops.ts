// Durable createRecord execution for import scrobbleBatch containers.
import { measureScrobbleBatch } from '@atmusic/atproto/scrobble-batch-size';
import { newTid } from '@atmusic/core/record-key';
import {
  BATCH_MAX_LISTENS,
  MAX_CBOR_BYTES,
  MAX_CREATE_BODY_BYTES,
  type ScrobbleBatchRecord,
  scrobbleBatchCollection,
} from '@atmusic/core/scrobble-batch';
import type { OperationRow } from '../app/rows';
import { newOperationId, prepare, recordOf } from './operations';
import { failureOutcome } from './pds-writer';
import type { ExecContext, Executor } from './runner';
import { hasIdentity, lookupCreate, sameDigest } from './scrobble-ops';

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
    // Retried/uncertain creates must be read first. A failed read is not proof
    // of absence and therefore never authorizes another create or a split.
    if (op.attempts > 1) {
      const found = await ctx.xrpc.getRecord(op.collection, op.rkey as string);
      if (found.kind === 'failed') return failureOutcome(found.failure);
      if (found.kind === 'present')
        return (await sameDigest(op, found.value))
          ? {
              kind: 'succeeded',
              uri: found.uri,
              cid: found.cid,
              hints: [{ collection: op.collection, rkey: op.rkey as string }],
            }
          : { kind: 'permanent', code: 'remote_record_conflict' };
    }
    const record = recordOf(op) as unknown as ScrobbleBatchRecord;
    const result = await ctx.xrpc.procedure(
      'com.atproto.repo.createRecord',
      { repo: op.did, collection: op.collection, rkey: op.rkey, record },
      'create',
    );
    if (result.ok) {
      const body = result.body as { uri?: unknown; cid?: unknown } | null;
      const uri = `at://${op.did}/${op.collection}/${op.rkey}`;
      if (body !== null && body.uri === uri && typeof body.cid === 'string')
        return {
          kind: 'succeeded',
          uri,
          cid: body.cid,
          hints: [{ collection: op.collection, rkey: op.rkey as string }],
        };
      const read = await lookupCreate(op, ctx, (remote) => sameDigest(op, remote), 'remote_write_unconfirmed');
      return read.kind === 'transient' ? { kind: 'transient', code: 'remote_write_unconfirmed' } : read;
    }
    const failure = result.failure;
    if (failure.kind === 'permanent' && failure.code === 'forbidden_scope')
      return { kind: 'reauth', code: 'batch_scope_required' };
    if (failure.kind === 'ambiguous_create' || failure.kind === 'missing') {
      const read = await ctx.xrpc.getRecord(op.collection, op.rkey as string);
      if (read.kind === 'present')
        return (await sameDigest(op, read.value))
          ? {
              kind: 'succeeded',
              uri: read.uri,
              cid: read.cid,
              hints: [{ collection: op.collection, rkey: op.rkey as string }],
            }
          : { kind: 'permanent', code: 'remote_record_conflict' };
      return read.kind === 'absent' ? { kind: 'transient', code: 'batch_read_absent' } : failureOutcome(read.failure);
    }
    const rejectionMessage = failure.message?.toLowerCase() ?? '';
    const sizeInvalidRequest =
      failure.error === 'InvalidRequest' && /size|large|payload|byte|length|too big/.test(rejectionMessage);
    const schemaRejection =
      failure.status !== 413 &&
      ((failure.error === 'InvalidRequest' && !sizeInvalidRequest) ||
        (failure.error === 'InvalidRecord' && /schema|lexicon|unknown collection|record type/.test(rejectionMessage)));
    if (schemaRejection)
      return { kind: 'permanent', code: 'batch_schema_required', remoteError: 'BatchSchemaRejected' };
    const recordRejection =
      failure.status === 413 ||
      failure.error === 'InvalidRecord' ||
      sizeInvalidRequest ||
      failure.error === 'PayloadTooLarge';
    if (recordRejection && record.listens.length > 1) {
      const middle = Math.ceil(record.listens.length / 2);
      const parts = [record.listens.slice(0, middle), record.listens.slice(middle)];
      const children = [];
      for (const listens of parts) {
        const childRecord: ScrobbleBatchRecord = {
          ...record,
          createdAt: new Date(ctx.m.clock.nowMs()).toISOString(),
          listens,
        };
        const rkey = newTid(ctx.m.clock, ctx.m.random);
        children.push({
          id: newOperationId(ctx.m.random),
          rkey,
          prepared: await prepare(childRecord),
          entryIds: listens.map((entry) => entry.id),
        });
      }
      return { kind: 'split', children };
    }
    return failure.kind === 'reauth'
      ? { kind: 'reauth' }
      : failure.kind === 'transient'
        ? {
            kind: 'transient',
            code: failure.code,
            ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
          }
        : {
            kind: 'permanent',
            code: failure.code,
            ...(failure.error === undefined ? {} : { remoteError: failure.error }),
            ...(failure.message === undefined ? {} : { remoteMessage: failure.message }),
            ...(failure.status === undefined ? {} : { status: failure.status }),
          };
  },
  async reconcile(op, ctx) {
    if (!valid(op, ctx, false)) return { kind: 'permanent', code: 'invalid_batch_record' };
    return lookupCreate(op, ctx, (remote) => sameDigest(op, remote), 'attempts_exhausted');
  },
};
