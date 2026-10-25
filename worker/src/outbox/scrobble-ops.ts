// Scrobble creates (ADR 0005 §5.8, ADR 0004 §5.2 steps 1–3, A11; N2-05). Ports
// web/src/outbox/scrobble-ops.ts to the server.
//
// - The record is built with @atmusic/core `buildScrobbleRecord` (closed
//   input, White_Space trimming, the +300 s bound against `createdAt`). Its
//   TID rkey is allocated once from the injected clock and randomness and its
//   canonical digest computed before the row is persisted; neither is ever
//   recomputed.
// - createRecord only; putRecord is never used for a create. "Already exists"
//   (or an answer that cannot be read) is reconciled with getRecord and a
//   canonical digest comparison: equal is success, different is terminal
//   `remote_record_conflict`, and the remote record is never overwritten.
// - Several due creates of one DID go as one `applyWrites` batch
//   (apply-writes.ts); a single one uses createRecord.

import { canonicalDigest } from '@atmusic/core/canonical';
import type { Clock } from '@atmusic/core/deps';
import { newTid } from '@atmusic/core/record-key';
import { buildScrobbleRecord, type ScrobbleRecord, type ValidationFailure } from '@atmusic/core/scrobble';
import type { OperationRow, Origin } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import {
  type Idempotency,
  insertOperation,
  newOperationId,
  outboxCollections,
  type Prepared,
  prepare,
  recordOf,
} from './operations';
import { failureOutcome, type Outcome } from './pds-writer';
import type { ExecContext, Executor } from './runner';

const RKEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/;

export function validRkey(rkey: string | null): rkey is string {
  return rkey !== null && RKEY_RE.test(rkey) && rkey !== '.' && rkey !== '..';
}

export type PrepareResult = { ok: true; prepared: Prepared<ScrobbleRecord> } | { ok: false; reason: ValidationFailure };

/** Builds a scrobble record whose `createdAt` is `createdAtMs`, with its canonical digest. */
export async function prepareScrobble(input: unknown, prefix: string, createdAtMs: number): Promise<PrepareResult> {
  const clock: Clock = { nowMs: () => createdAtMs };
  const built = buildScrobbleRecord(input, prefix, clock);
  if (!built.ok) return { ok: false, reason: built.reason };
  return { ok: true, prepared: await prepare(built.record) };
}

export interface ScrobbleCreateArgs {
  /** The operation id, when the caller needs it first (a listen key row); fresh otherwise. */
  id?: string;
  did: string;
  origin: Origin;
  prepared: Prepared<object>;
  /** Not before (the deferred listens of ADR §8.3); defaults to now. */
  dueAt?: number;
  importJobId?: string | null;
  idempotency?: Idempotency | null;
}

/**
 * Persists one `scrobble.create` (synchronous; call inside the caller's tx):
 * a fresh operation id and TID rkey, the record and its digest.
 */
export function insertScrobbleCreate(m: ModuleDeps, args: ScrobbleCreateArgs, now: number): OperationRow {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  return insertOperation(
    m.db,
    {
      id: args.id ?? newOperationId(m.random),
      did: args.did,
      kind: 'scrobble.create',
      origin: args.origin,
      collection: outboxCollections(prefix).scrobble,
      rkey: newTid(m.clock, m.random),
      prepared: args.prepared,
      dueAt: args.dueAt ?? now,
      importJobId: args.importJobId ?? null,
      idempotency: args.idempotency ?? null,
    },
    now,
  );
}

export type EnqueueCreatesResult =
  | { ok: true; operations: OperationRow[] }
  | { ok: false; index: number; reason: ValidationFailure };

/**
 * Validates every input, then persists all creates in one transaction (the
 * import writer's slice, N3-09; live listens go through ingress.ts). Nothing
 * is written when any input is invalid.
 */
export async function enqueueScrobbleCreates(
  m: ModuleDeps,
  args: { did: string; origin: Origin; inputs: readonly unknown[]; importJobId?: string | null; kick?: () => void },
): Promise<EnqueueCreatesResult> {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const now = m.clock.nowMs();
  const prepared: Prepared<ScrobbleRecord>[] = [];
  for (const [index, input] of args.inputs.entries()) {
    const p = await prepareScrobble(input, prefix, now);
    if (!p.ok) return { ok: false, index, reason: p.reason };
    prepared.push(p.prepared);
  }
  const operations = m.db.tx(() =>
    prepared.map((p) =>
      insertScrobbleCreate(
        m,
        { did: args.did, origin: args.origin, prepared: p, importJobId: args.importJobId ?? null },
        now,
      ),
    ),
  );
  args.kick?.();
  return { ok: true, operations };
}

/** The row names exactly `at://<writer did>/<expected collection>/<valid rkey>`. */
export function hasIdentity(op: OperationRow, ctx: ExecContext, collection: string): boolean {
  return op.did === ctx.xrpc.did && op.collection === collection && validRkey(op.rkey);
}

/** Equal canonical digest with the persisted one (`$type` included). */
export async function sameDigest(op: Pick<OperationRow, 'digest'>, remote: unknown): Promise<boolean> {
  if (op.digest === null) return false;
  try {
    return (await canonicalDigest(remote)) === op.digest;
  } catch {
    // Not an atproto data-model value (e.g. a float): certainly not our record.
    return false;
  }
}

/** getRecord at the rkey: ours → succeeded; someone else's → remote_record_conflict; absent → `absentCode`. */
export async function lookupCreate(
  op: OperationRow,
  ctx: ExecContext,
  matches: (remote: unknown) => Promise<boolean>,
  absentCode: string,
): Promise<Outcome> {
  const rkey = op.rkey as string;
  const found = await ctx.xrpc.getRecord(op.collection, rkey);
  switch (found.kind) {
    case 'present':
      return (await matches(found.value))
        ? { kind: 'succeeded', uri: found.uri, cid: found.cid, hints: [{ collection: op.collection, rkey }] }
        : { kind: 'permanent', code: 'remote_record_conflict' };
    case 'absent':
      return { kind: 'transient', code: absentCode };
    case 'failed':
      return failureOutcome(found.failure);
  }
}

/**
 * createRecord at the persisted rkey, reconciling an ambiguous answer with
 * getRecord and `matches(remoteValue)`. Shared with follow and love creates.
 */
export async function createWithReconcile(
  op: OperationRow,
  ctx: ExecContext,
  matches: (remote: unknown) => Promise<boolean>,
): Promise<Outcome> {
  const record = recordOf(op);
  const rkey = op.rkey;
  if (record === null || rkey === null) return { kind: 'permanent', code: 'invalid_record' };
  const uri = `at://${op.did}/${op.collection}/${rkey}`;
  const result = await ctx.xrpc.procedure(
    'com.atproto.repo.createRecord',
    { repo: op.did, collection: op.collection, rkey, record },
    'create',
  );
  if (result.ok) {
    const body = result.body as { uri?: unknown; cid?: unknown } | null;
    if (body !== null && typeof body === 'object' && typeof body.cid === 'string' && body.uri === uri) {
      return { kind: 'succeeded', uri, cid: body.cid, hints: [{ collection: op.collection, rkey }] };
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

export const scrobbleCreateExecutor: Executor = {
  async execute(op, ctx) {
    if (!hasIdentity(op, ctx, ctx.collections.scrobble) || op.digest === null) {
      return { kind: 'permanent', code: 'invalid_record_identity' };
    }
    return createWithReconcile(op, ctx, (remote) => sameDigest(op, remote));
  },
  async reconcile(op, ctx) {
    if (!hasIdentity(op, ctx, ctx.collections.scrobble)) return { kind: 'permanent', code: 'invalid_record_identity' };
    return lookupCreate(op, ctx, (remote) => sameDigest(op, remote), 'attempts_exhausted');
  },
};
