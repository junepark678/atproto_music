// Follow and unfollow (ADR 0004 §5.2 step 6; ports crates/atproto/src/pds/follow.rs).
//
// - Follow: createRecord at the deterministic rkey 'f' + hex(sha256(subject)).
//   When a record already exists there (a retry, a crash after the commit, or
//   another client), the existing-same-subject rule applies: the same subject is
//   success and keeps its original `createdAt`; a different subject is terminal
//   `remote_record_conflict` and is never overwritten.
// - Unfollow: listRecords over the owner's own `<prefix>.follow` collection on
//   their PDS (authoritative for the owner), then deleteRecord with swapRecord
//   for every record whose subject matches, including duplicates written at
//   other rkeys by other clients. Records with other subjects are kept. No
//   matching record means success with no delete.
// - Alternating follow/unfollow intents for one subject keep separate
//   operation ids and run FIFO after their unsent predecessors.

import type { AtUri, Did } from '@atmusic/core/api-types';
import { canonicalDigest } from '@atmusic/core/canonical';
import type { Clock, Random } from '@atmusic/core/deps';
import { buildFollowRecord, MSG_SELF_FOLLOW, validateDidSyntax } from '@atmusic/core/follow';
import { collectionsFor } from '@atmusic/core/namespace';
import { followRkey } from '@atmusic/core/record-key';
import { deleteVerdict, ownRecordKey } from './delete-ops';
import { type ExecContext, type Executor, failureOutcome, type Outcome } from './runner';
import { createVerdict, createWithReconcile, type EnqueueResult, hasIdentity, lookupCreate } from './scrobble-ops';
import {
  type DeleteTarget,
  freshOperation,
  isUnsent,
  newOperationId,
  type OutboxOperation,
  type OutboxStore,
} from './store';

export interface EnqueueFollowArgs {
  store: OutboxStore;
  did: Did;
  prefix: string;
  subject: string;
  clock: Clock;
  random: Random;
}

function isFollowOf(op: OutboxOperation, subject: string): boolean {
  return (op.kind === 'follow_create' || op.kind === 'follow_delete') && op.subject === subject;
}

async function enqueueFollowIntent(args: EnqueueFollowArgs, create: boolean): Promise<EnqueueResult> {
  const collection = collectionsFor(args.prefix).follow;
  let record: Record<string, unknown> | undefined;
  let digest: string | undefined;
  if (create) {
    const built = buildFollowRecord({ actor: args.did, subject: args.subject }, args.prefix, args.clock);
    if (!built.ok) return { ok: false, reason: built.reason };
    record = built.record as unknown as Record<string, unknown>;
    digest = await canonicalDigest(record);
  } else {
    const syntax = validateDidSyntax(args.subject);
    if (!syntax.ok) return { ok: false, reason: syntax.reason };
    if (args.subject === args.did) {
      return { ok: false, reason: { field: 'subject', code: 'invalid_field', message: MSG_SELF_FOLLOW } };
    }
  }
  const subject = args.subject as Did;
  const rkey = await followRkey(subject);
  const id = newOperationId(args.random);
  const now = args.clock.nowMs();
  const op = await args.store.enqueue(args.did, ({ seq, existing }) =>
    freshOperation(
      {
        id,
        did: args.did,
        kind: create ? 'follow_create' : 'follow_delete',
        collection,
        rkey,
        uri: `at://${args.did}/${collection}/${rkey}`,
        subject,
        predecessorIds: existing.filter((o) => isFollowOf(o, subject) && isUnsent(o.state)).map((o) => o.id),
        seq,
        ...(record !== undefined ? { record } : {}),
        ...(digest !== undefined ? { digest } : {}),
      },
      now,
    ),
  );
  return { ok: true, op };
}

/** Persists a follow of `subject` at the deterministic rkey. */
export function enqueueFollow(args: EnqueueFollowArgs): Promise<EnqueueResult> {
  return enqueueFollowIntent(args, true);
}

/** Persists an unfollow: every record with this subject in the owner's follow collection is deleted. */
export function enqueueUnfollow(args: EnqueueFollowArgs): Promise<EnqueueResult> {
  return enqueueFollowIntent(args, false);
}

/** The existing-same-subject rule: same `$type` and subject; `createdAt` may differ. */
function sameSubject(op: OutboxOperation): (remote: unknown) => Promise<boolean> {
  return async (remote) => {
    if (remote === null || typeof remote !== 'object') return false;
    const value = remote as { $type?: unknown; subject?: unknown };
    return value.$type === op.collection && value.subject === op.subject;
  };
}

async function followIdentity(op: OutboxOperation, ctx: ExecContext): Promise<boolean> {
  if (!hasIdentity(op, ctx, ctx.collections.follow) || typeof op.subject !== 'string') return false;
  if (op.subject === op.did) return false;
  try {
    return (await followRkey(op.subject)) === op.rkey;
  } catch {
    return false;
  }
}

export const followCreateExecutor: Executor = {
  async execute(op, ctx) {
    if (!(await followIdentity(op, ctx))) return { kind: 'permanent', code: 'invalid_follow_identity' };
    return createWithReconcile(op, ctx, sameSubject(op));
  },
  async reconcile(op, ctx) {
    if (!(await followIdentity(op, ctx))) return { kind: 'permanent', code: 'invalid_follow_identity' };
    return lookupCreate(op, ctx, sameSubject(op), 'attempts_exhausted');
  },
  trackUris: (op) => [op.uri],
  verdict: (_op, statuses) => createVerdict(statuses),
};

type Matching = { ok: true; targets: DeleteTarget[] } | { ok: false; outcome: Outcome };

/** The owner's follow records whose subject is `op.subject`, from listRecords. */
async function matchingRecords(op: OutboxOperation, ctx: ExecContext): Promise<Matching> {
  const listed = await ctx.pds.listAll(op.collection);
  if (!listed.ok) return listed;
  const targets: DeleteTarget[] = [];
  for (const r of listed.records) {
    const rkey = ownRecordKey(r.uri, op.did, op.collection);
    if (rkey === null) continue;
    const value = r.value as { subject?: unknown } | null;
    if (value !== null && typeof value === 'object' && value.subject === op.subject) {
      targets.push({ uri: r.uri as AtUri, rkey, cid: r.cid });
    }
  }
  return { ok: true, targets };
}

function mergeTargets(known: readonly DeleteTarget[], more: readonly DeleteTarget[]): DeleteTarget[] {
  const out = [...known];
  for (const t of more) if (!out.some((k) => k.uri === t.uri)) out.push(t);
  return out;
}

export const followDeleteExecutor: Executor = {
  async execute(op, ctx) {
    if (!(await followIdentity(op, ctx))) return { kind: 'permanent', code: 'invalid_follow_identity' };
    const found = await matchingRecords(op, ctx);
    if (!found.ok) return found.outcome;
    let deleted = op.targets ?? [];
    for (const target of found.targets) {
      const result = await ctx.pds.procedure(
        'com.atproto.repo.deleteRecord',
        { repo: op.did, collection: op.collection, rkey: target.rkey, swapRecord: target.cid },
        'delete',
      );
      if (!result.ok) {
        const failure = result.failure;
        // InvalidSwap: the record changed since the listing; relist on the next attempt.
        if (failure.code === 'repository_changed') {
          return { kind: 'transient', code: 'repository_changed', patch: { targets: deleted } };
        }
        // Already gone is what we wanted.
        if (failure.kind !== 'missing') return { ...failureOutcome(failure), patch: { targets: deleted } };
      }
      deleted = mergeTargets(deleted, [target]);
      await ctx.persist({ targets: deleted });
    }
    return { kind: 'published', patch: { targets: deleted } };
  },
  async reconcile(op, ctx) {
    if (!(await followIdentity(op, ctx))) return { kind: 'permanent', code: 'invalid_follow_identity' };
    const found = await matchingRecords(op, ctx);
    if (!found.ok) return found.outcome;
    return found.targets.length === 0
      ? { kind: 'published', patch: { targets: op.targets ?? [] } }
      : { kind: 'transient', code: 'remote_delete_unconfirmed' };
  },
  trackUris: (op) => (op.targets ?? []).map((t) => t.uri),
  verdict: (_op, statuses) => deleteVerdict(statuses),
};
