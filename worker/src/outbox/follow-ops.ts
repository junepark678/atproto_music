// Follow and unfollow (ADR 0005 §5.8, ADR 0004 §5.2 step 6; N2-05). Ports
// web/src/outbox/follow-ops.ts and crates/atproto/src/pds/follow.rs.
//
// - Follow (`follow.put`): createRecord at the deterministic rkey
//   'f' + hex(sha256(subject)). When a record already exists there (a retry,
//   a crash after the commit, or another client), the existing-same-subject
//   rule applies: the same subject is success and keeps its original
//   `createdAt`; a different subject is terminal `remote_record_conflict` and
//   is never overwritten.
// - Unfollow (`follow.delete`): listRecords over the owner's own
//   `<prefix>.follow` collection, then deleteRecord with swapRecord for every
//   record whose subject matches, including duplicates written at other rkeys
//   by other clients. Records with other subjects are kept. No matching record
//   is success with no delete. The intent `{subject}` is stored as the
//   operation's record_json (never sent); its rkey is the deterministic one.
// - Follow intents for one subject keep separate operation ids and run FIFO
//   behind their unsettled predecessors.

import { buildFollowRecord, MSG_SELF_FOLLOW, validateDidSyntax } from '@atmusic/core/follow';
import { followRkey } from '@atmusic/core/record-key';
import type { ValidationFailure } from '@atmusic/core/scrobble';
import type { OperationRow, Origin } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import { WRITE_COST } from './budget';
import { ownRecordKey } from './delete-ops';
import { insertOperation, newOperationId, outboxCollections, prepare, recordOf, unsettledAt } from './operations';
import { failureOutcome, type HintTarget, type Outcome } from './pds-writer';
import type { ExecContext, Executor } from './runner';
import { createWithReconcile, hasIdentity, lookupCreate } from './scrobble-ops';

export type EnqueueResult = { ok: true; operation: OperationRow } | { ok: false; reason: ValidationFailure };

export interface EnqueueFollowArgs {
  did: string;
  subject: string;
  origin: Origin;
  kick?: () => void;
}

async function enqueueFollowIntent(m: ModuleDeps, args: EnqueueFollowArgs, create: boolean): Promise<EnqueueResult> {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const collection = outboxCollections(prefix).follow;
  let record: Record<string, unknown>;
  if (create) {
    const built = buildFollowRecord({ actor: args.did, subject: args.subject }, prefix, m.clock);
    if (!built.ok) return { ok: false, reason: built.reason };
    record = built.record as unknown as Record<string, unknown>;
  } else {
    const syntax = validateDidSyntax(args.subject);
    if (!syntax.ok) return { ok: false, reason: syntax.reason };
    if (args.subject === args.did) {
      return { ok: false, reason: { field: 'subject', code: 'invalid_field', message: MSG_SELF_FOLLOW } };
    }
    record = { subject: args.subject };
  }
  const prepared = await prepare(record);
  const rkey = await followRkey(args.subject);
  const now = m.clock.nowMs();
  const operation = m.db.tx(() =>
    insertOperation(
      m.db,
      {
        id: newOperationId(m.random),
        did: args.did,
        kind: create ? 'follow.put' : 'follow.delete',
        origin: args.origin,
        collection,
        rkey,
        prepared,
        dueAt: now,
        // FIFO per subject: every unsettled follow intent at the same deterministic rkey.
        predecessors: unsettledAt(m.db, args.did, collection, rkey),
      },
      now,
    ),
  );
  args.kick?.();
  return { ok: true, operation };
}

/** Persists a follow of `subject` at the deterministic rkey. */
export function enqueueFollow(m: ModuleDeps, args: EnqueueFollowArgs): Promise<EnqueueResult> {
  return enqueueFollowIntent(m, args, true);
}

/** Persists an unfollow: every record with this subject in the owner's follow collection is deleted. */
export function enqueueUnfollow(m: ModuleDeps, args: EnqueueFollowArgs): Promise<EnqueueResult> {
  return enqueueFollowIntent(m, args, false);
}

function subjectOf(op: OperationRow): string | null {
  const subject = recordOf(op)?.subject;
  return typeof subject === 'string' ? subject : null;
}

/** The existing-same-subject rule: same `$type` and subject; `createdAt` may differ. */
function sameSubject(op: OperationRow): (remote: unknown) => Promise<boolean> {
  return async (remote) => {
    if (remote === null || typeof remote !== 'object') return false;
    const value = remote as { $type?: unknown; subject?: unknown };
    return value.$type === op.collection && value.subject === subjectOf(op);
  };
}

async function followIdentity(op: OperationRow, ctx: ExecContext): Promise<boolean> {
  const subject = subjectOf(op);
  if (!hasIdentity(op, ctx, ctx.collections.follow) || subject === null || subject === op.did) return false;
  try {
    return (await followRkey(subject)) === op.rkey;
  } catch {
    return false;
  }
}

export const followPutExecutor: Executor = {
  async execute(op, ctx) {
    if (!(await followIdentity(op, ctx))) return { kind: 'permanent', code: 'invalid_follow_identity' };
    return createWithReconcile(op, ctx, sameSubject(op));
  },
  async reconcile(op, ctx) {
    if (!(await followIdentity(op, ctx))) return { kind: 'permanent', code: 'invalid_follow_identity' };
    return lookupCreate(op, ctx, sameSubject(op), 'attempts_exhausted');
  },
};

interface Target {
  rkey: string;
  cid: string;
}

/**
 * Lists the owner's records of `op.collection` and deletes (with swapRecord)
 * every one `matches` accepts. Shared by unfollow and unlove.
 */
export async function deleteMatching(
  op: OperationRow,
  ctx: ExecContext,
  matches: (value: unknown) => boolean,
  alwaysHint: readonly HintTarget[] = [],
): Promise<Outcome> {
  const listed = await ctx.xrpc.listAll(op.collection);
  if (!listed.ok) return failureOutcome(listed.failure);
  const targets: Target[] = [];
  for (const r of listed.records) {
    const rkey = ownRecordKey(r.uri, op.did, op.collection);
    if (rkey !== null && matches(r.value)) targets.push({ rkey, cid: r.cid });
  }
  const hints: HintTarget[] = [...alwaysHint];
  for (const target of targets) {
    // Each delete is budget-checked; one the budget stops waits, and the next attempt lists again.
    const refused = ctx.afford(WRITE_COST.delete);
    if (refused !== null) return refused;
    const result = await ctx.xrpc.procedure(
      'com.atproto.repo.deleteRecord',
      { repo: op.did, collection: op.collection, rkey: target.rkey, swapRecord: target.cid },
      'delete',
    );
    if (!result.ok) {
      const failure = result.failure;
      // InvalidSwap: the record changed since the listing; relist on the next attempt.
      if (failure.code === 'repository_changed') return { kind: 'transient', code: 'repository_changed' };
      // Already gone is what we wanted.
      if (failure.kind !== 'missing') return failureOutcome(failure);
    }
    if (!hints.some((h) => h.rkey === target.rkey)) hints.push({ collection: op.collection, rkey: target.rkey });
  }
  return { kind: 'succeeded', hints };
}

/** Read-only check: no matching record is left. */
export async function noneMatching(
  op: OperationRow,
  ctx: ExecContext,
  matches: (value: unknown) => boolean,
): Promise<Outcome> {
  const listed = await ctx.xrpc.listAll(op.collection);
  if (!listed.ok) return failureOutcome(listed.failure);
  const left = listed.records.some((r) => ownRecordKey(r.uri, op.did, op.collection) !== null && matches(r.value));
  return left ? { kind: 'transient', code: 'remote_delete_unconfirmed' } : { kind: 'succeeded', hints: [] };
}

function subjectMatches(op: OperationRow): (value: unknown) => boolean {
  const subject = subjectOf(op);
  return (value) => value !== null && typeof value === 'object' && (value as { subject?: unknown }).subject === subject;
}

export const followDeleteExecutor: Executor = {
  async execute(op, ctx) {
    if (!(await followIdentity(op, ctx))) return { kind: 'permanent', code: 'invalid_follow_identity' };
    return deleteMatching(op, ctx, subjectMatches(op), [{ collection: op.collection, rkey: op.rkey as string }]);
  },
  async reconcile(op, ctx) {
    if (!(await followIdentity(op, ctx))) return { kind: 'permanent', code: 'invalid_follow_identity' };
    return noneMatching(op, ctx, subjectMatches(op));
  },
};
