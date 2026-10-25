// applyWrites batching (ADR 0005 §5.8 "Batching"; N2-05).
//
// - Several due `scrobble.create` operations of one DID (an import slice, or
//   a protocol batch of more than one listen) go as one
//   `com.atproto.repo.applyWrites` call with at most MAX_BATCH_WRITES (200)
//   writes and a JSON body of at most MAX_BATCH_BYTES (1,000,000) bytes, the
//   reference PDS's limits. `planBatch` takes the longest FIFO prefix that
//   fits; the bytes counted are exactly the bytes sent (`encodeBatch`).
// - Each write is a create at the operation's persisted TID rkey with its
//   persisted record: a retried batch is the same batch.
// - An atomic batch that fails with a per-record answer (an existing rkey,
//   an invalid record, a too-large body) wrote nothing, so it is **bisected**:
//   each half is sent again, down to single operations, which go through
//   createRecord with ambiguous-create reconciliation (getRecord + digest).
//   Bisecting reuses the attempt the batch persisted; it never counts more.
// - A transient failure (network, 5xx, 429) may or may not have committed: the
//   whole batch is retried later as it is, and a batch that did land then
//   fails with RecordAlreadyExists and is bisected into reconciles.
// - A success whose `results` do not name every expected URI is treated as
//   unconfirmed (transient), never as success.

import type { OperationRow } from '../app/rows';
import { recordOf } from './operations';
import { type Failure, failureOutcome, type Outcome } from './pds-writer';
import type { ExecContext } from './runner';

export const MAX_BATCH_WRITES = 200;
export const MAX_BATCH_BYTES = 1_000_000;
export const APPLY_WRITES = 'com.atproto.repo.applyWrites';
const CREATE_TYPE = 'com.atproto.repo.applyWrites#create';

const encoder = new TextEncoder();

function writeJson(op: OperationRow): string {
  return JSON.stringify({ $type: CREATE_TYPE, collection: op.collection, rkey: op.rkey, value: recordOf(op) });
}

function envelope(did: string, writes: readonly string[]): string {
  return `{"repo":${JSON.stringify(did)},"writes":[${writes.join(',')}]}`;
}

/** The exact applyWrites body for `ops` and its UTF-8 size. */
export function encodeBatch(did: string, ops: readonly OperationRow[]): { body: string; bytes: number } {
  const body = envelope(did, ops.map(writeJson));
  return { body, bytes: encoder.encode(body).length };
}

/**
 * The longest prefix of `ops` with at most `maxWrites` writes whose body is at
 * most `maxBytes`. Always at least the first operation (a lone oversize record
 * then goes as a single createRecord, which the PDS refuses as 413).
 */
export function planBatch(
  did: string,
  ops: readonly OperationRow[],
  maxWrites = MAX_BATCH_WRITES,
  maxBytes = MAX_BATCH_BYTES,
): OperationRow[] {
  const out: OperationRow[] = [];
  let bytes = encoder.encode(envelope(did, [])).length;
  for (const op of ops) {
    if (out.length >= maxWrites) break;
    const size = encoder.encode(writeJson(op)).length + (out.length > 0 ? 1 : 0);
    if (out.length > 0 && bytes + size > maxBytes) break;
    out.push(op);
    bytes += size;
  }
  return out;
}

const PER_RECORD_ERRORS: ReadonlySet<string> = new Set([
  'RecordAlreadyExists',
  'AlreadyExists',
  'InvalidRecord',
  'InvalidRequest',
  'PayloadTooLarge',
]);

/** A failure that one of the writes caused, so the atomic batch wrote nothing and can be split. */
function bisectable(failure: Failure): boolean {
  if (failure.kind === 'ambiguous_create' || failure.kind === 'missing') return true;
  if (failure.status === 413) return true;
  return failure.kind === 'permanent' && failure.error !== undefined && PER_RECORD_ERRORS.has(failure.error);
}

/** Every op gets the same outcome. */
function all(ops: readonly OperationRow[], outcome: Outcome): Map<string, Outcome> {
  return new Map(ops.map((op) => [op.id, outcome]));
}

/**
 * Sends `ops` (creates of one DID, already started) as one applyWrites call,
 * bisecting a per-record failure down to `single(op)`. Returns an outcome per
 * operation id.
 */
export async function sendCreateBatch(
  ctx: ExecContext,
  ops: readonly OperationRow[],
  single: (op: OperationRow) => Promise<Outcome>,
): Promise<Map<string, Outcome>> {
  if (ops.length === 0) return new Map();
  if (ops.length === 1) {
    const op = ops[0] as OperationRow;
    return new Map([[op.id, await single(op)]]);
  }
  const did = ctx.xrpc.did;
  const { body } = encodeBatch(did, ops);
  const writes = ops.map((op) => ({ $type: CREATE_TYPE, collection: op.collection, rkey: op.rkey }));
  const result = await ctx.xrpc.procedure(APPLY_WRITES, { repo: did, writes }, 'create', body);
  if (result.ok) {
    const results = (result.body as { results?: unknown } | null)?.results;
    if (!Array.isArray(results) || results.length !== ops.length) {
      return all(ops, { kind: 'transient', code: 'remote_write_unconfirmed' });
    }
    const out = new Map<string, Outcome>();
    for (const [i, op] of ops.entries()) {
      const r = results[i] as { uri?: unknown; cid?: unknown } | null;
      const uri = `at://${op.did}/${op.collection}/${op.rkey}`;
      if (r === null || typeof r !== 'object' || r.uri !== uri || typeof r.cid !== 'string') {
        return all(ops, { kind: 'transient', code: 'remote_write_unconfirmed' });
      }
      out.set(op.id, { kind: 'succeeded', uri, cid: r.cid, hints: [{ collection: op.collection, rkey: op.rkey! }] });
    }
    return out;
  }
  if (!bisectable(result.failure)) return all(ops, failureOutcome(result.failure));
  const half = Math.ceil(ops.length / 2);
  const out = new Map<string, Outcome>();
  for (const part of [ops.slice(0, half), ops.slice(half)]) {
    for (const [id, outcome] of await sendCreateBatch(ctx, part, single)) out.set(id, outcome);
  }
  return out;
}
