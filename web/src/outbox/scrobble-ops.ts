// Scrobble creates (ADR 0004 §5.2 steps 1–3, §9 A11).
//
// - The form input is validated and the record built with @atmusic/core
//   (`buildScrobbleRecord`: closed input, White_Space trimming, +300 s bound).
//   Invalid input never creates an operation.
// - The TID rkey is allocated once from the injected clock/random, and the
//   canonical digest is computed, before the row is persisted; neither is ever
//   recomputed, so every retry and every resumed attempt sends the same key.
// - createRecord only; putRecord is never used for a create. "Already exists"
//   (or a missing answer) is reconciled with getRecord and a canonical digest
//   comparison: equal is success, different is terminal `remote_record_conflict`,
//   and the remote record is never overwritten.

import type { Did, RecordStatus } from '@atmusic/core/api-types';
import { canonicalDigest } from '@atmusic/core/canonical';
import type { Clock, Random } from '@atmusic/core/deps';
import { collectionsFor } from '@atmusic/core/namespace';
import { newTid } from '@atmusic/core/record-key';
import { buildScrobbleRecord, type ValidationFailure } from '@atmusic/core/scrobble';
import { type ExecContext, type Executor, failureOutcome, type Outcome, type TrackVerdict } from './runner';
import { freshOperation, newOperationId, type OutboxOperation, type OutboxStore } from './store';

export type EnqueueResult = { ok: true; op: OutboxOperation } | { ok: false; reason: ValidationFailure };

export interface EnqueueScrobbleArgs {
  store: OutboxStore;
  did: Did;
  prefix: string;
  /** The raw form input; unknown fields are rejected. */
  input: unknown;
  clock: Clock;
  random: Random;
}

/** Validates the form, allocates the TID rkey and persists the create before any attempt. */
export async function enqueueScrobble(args: EnqueueScrobbleArgs): Promise<EnqueueResult> {
  const built = buildScrobbleRecord(args.input, args.prefix, args.clock);
  if (!built.ok) return { ok: false, reason: built.reason };
  const record = built.record as unknown as Record<string, unknown>;
  const digest = await canonicalDigest(record);
  const collection = collectionsFor(args.prefix).scrobble;
  const rkey = newTid(args.clock, args.random);
  const id = newOperationId(args.random);
  const now = args.clock.nowMs();
  const op = await args.store.enqueue(args.did, ({ seq }) =>
    freshOperation(
      {
        id,
        did: args.did,
        kind: 'scrobble_create',
        collection,
        rkey,
        uri: `at://${args.did}/${collection}/${rkey}`,
        predecessorIds: [],
        seq,
        record,
        digest,
      },
      now,
    ),
  );
  return { ok: true, op };
}

/** The row names exactly `at://<session did>/<expected collection>/<rkey>`. */
export function hasIdentity(op: OutboxOperation, ctx: ExecContext, collection: string): boolean {
  return (
    op.did === ctx.pds.did && op.collection === collection && op.uri === `at://${op.did}/${op.collection}/${op.rkey}`
  );
}

/**
 * createRecord at the persisted rkey, reconciling an ambiguous answer with
 * getRecord and `matches(remoteValue)`. Shared with follow creates, which
 * match on the subject instead of the digest.
 */
export async function createWithReconcile(
  op: OutboxOperation,
  ctx: ExecContext,
  matches: (remote: unknown) => Promise<boolean>,
): Promise<Outcome> {
  if (op.record === undefined) return { kind: 'permanent', code: 'invalid_record' };
  const result = await ctx.pds.procedure(
    'com.atproto.repo.createRecord',
    { repo: op.did, collection: op.collection, rkey: op.rkey, record: op.record },
    'create',
  );
  if (result.ok) {
    const body = result.body as { uri?: unknown; cid?: unknown } | null;
    if (body !== null && typeof body === 'object' && typeof body.cid === 'string' && body.uri === op.uri) {
      return { kind: 'published', patch: { cid: body.cid } };
    }
    // A 2xx without a usable body: look instead of guessing.
    return lookupCreate(op, ctx, matches, 'remote_write_unconfirmed');
  }
  const failure = result.failure;
  if (failure.kind === 'ambiguous_create' || failure.kind === 'missing') {
    return lookupCreate(op, ctx, matches, 'remote_write_unconfirmed');
  }
  return failureOutcome(failure);
}

/** getRecord at the rkey: ours → published; someone else's → remote_record_conflict; absent → `absentCode`. */
export async function lookupCreate(
  op: OutboxOperation,
  ctx: ExecContext,
  matches: (remote: unknown) => Promise<boolean>,
  absentCode: string,
): Promise<Outcome> {
  const found = await ctx.pds.getRecord(op.collection, op.rkey);
  switch (found.kind) {
    case 'present':
      return (await matches(found.value))
        ? { kind: 'published', patch: { cid: found.cid } }
        : { kind: 'permanent', code: 'remote_record_conflict' };
    case 'absent':
      return { kind: 'transient', code: absentCode };
    case 'failed':
      return found.outcome;
  }
}

/** Equal canonical digest with the persisted one (`$type` included). */
async function sameDigest(op: OutboxOperation, remote: unknown): Promise<boolean> {
  if (op.digest === undefined) return false;
  try {
    return (await canonicalDigest(remote)) === op.digest;
  } catch {
    // Not an atproto data-model value (e.g. a float): certainly not our record.
    return false;
  }
}

/** Track verdict shared by every create: indexed, excluded, or stop when it can no longer be indexed. */
export function createVerdict(statuses: readonly (RecordStatus | null)[]): TrackVerdict {
  const s = statuses[0] ?? null;
  if (s === null) return { kind: 'continue' };
  if (s.state === 'indexed') return { kind: 'indexed' };
  if (s.state === 'excluded') return { kind: 'excluded', reason: s.reason ?? 'excluded' };
  // A suppressed DID is never indexed; an absent record was removed after publication.
  if (s.indexing.state === 'suppressed' || s.state === 'absent') return { kind: 'stop' };
  return { kind: 'continue' };
}

export const scrobbleCreateExecutor: Executor = {
  async execute(op, ctx) {
    if (!hasIdentity(op, ctx, ctx.collections.scrobble) || op.digest === undefined) {
      return { kind: 'permanent', code: 'invalid_record_identity' };
    }
    return createWithReconcile(op, ctx, (remote) => sameDigest(op, remote));
  },
  async reconcile(op, ctx) {
    if (!hasIdentity(op, ctx, ctx.collections.scrobble)) return { kind: 'permanent', code: 'invalid_record_identity' };
    return lookupCreate(op, ctx, (remote) => sameDigest(op, remote), 'attempts_exhausted');
  },
  trackUris: (op) => [op.uri],
  verdict: (_op, statuses) => createVerdict(statuses),
};
