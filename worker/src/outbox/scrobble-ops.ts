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
  LEGACY_ABSENCE_RECHECK_MS,
  legacyImportNeedsReconcile,
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

/**
 * Authoritative absence of a legacy import single (migration 8 `unknown` send
 * history), inside its running attempt or tenth-attempt reconcile. A send made
 * by a pre-upgrade process could still be committing when the first read runs,
 * so one absence read is not enough: the first records `legacy_absent_at_ms`
 * and asks to look again LEGACY_ABSENCE_RECHECK_MS later; a request that lands
 * meanwhile is then found present and settles the single. A second absence
 * read at least that long after the first is the explicit certainty
 * transition to `send_state='unsent'`, which the rebatcher accepts whatever
 * the historical attempt count (rebatch.ts); the row itself is never sent
 * again (the runner keeps unsent import singles out of the write lane). The
 * returned `deferred` refunds this read-only attempt and leaves `due_at`.
 */
function legacyAbsent(op: OperationRow, ctx: ExecContext): Outcome {
  const now = ctx.m.clock.nowMs();
  const first = op.legacy_absent_at_ms;
  if (first === null || now < first + LEGACY_ABSENCE_RECHECK_MS) {
    const since = first ?? now;
    const due = since + LEGACY_ABSENCE_RECHECK_MS;
    ctx.m.db.run(
      "UPDATE operations SET legacy_absent_at_ms=?, due_at=? WHERE id=? AND state='running' AND send_state='unknown'",
      since,
      due,
      op.id,
    );
    return { kind: 'deferred', untilMs: due };
  }
  ctx.m.db.run(
    "UPDATE operations SET send_state='unsent', send_started_at_ms=NULL, last_error=NULL, due_at=? WHERE id=? AND state='running' AND send_state='unknown'",
    now,
    op.id,
  );
  return { kind: 'deferred', untilMs: now };
}

export const scrobbleCreateExecutor: Executor = {
  async execute(op, ctx) {
    const expected =
      op.collection === ctx.collections.scrobbleBatch
        ? ctx.m.config.batchPublication
          ? ctx.collections.scrobbleBatch
          : null
        : ctx.collections.scrobble;
    if (expected === null || !hasIdentity(op, ctx, expected) || op.digest === null) {
      return { kind: 'permanent', code: 'invalid_record_identity' };
    }
    // Migration-8 legacy rows have no trustworthy send history. Reconcile the
    // persisted key before any retry; a matching record settles without a
    // second create, while a conflict is terminal and never overwritten.
    if (op.collection === ctx.collections.scrobble && legacyImportNeedsReconcile(ctx.m.db, op)) {
      const found = await ctx.xrpc.getRecord(op.collection, op.rkey as string);
      if (found.kind === 'present')
        return (await sameDigest(op, found.value))
          ? {
              kind: 'succeeded',
              uri: found.uri,
              cid: found.cid,
              hints: [{ collection: op.collection, rkey: op.rkey as string }],
            }
          : { kind: 'permanent', code: 'remote_record_conflict' };
      if (found.kind === 'failed')
        return found.failure.kind === 'transient'
          ? { kind: 'waiting', untilMs: ctx.m.clock.nowMs() + 5_000 }
          : failureOutcome(found.failure);
      return legacyAbsent(op, ctx);
    }
    return createWithReconcile(op, ctx, (remote) => sameDigest(op, remote));
  },
  async reconcile(op, ctx) {
    const expected =
      op.collection === ctx.collections.scrobbleBatch ? ctx.collections.scrobbleBatch : ctx.collections.scrobble;
    if (!hasIdentity(op, ctx, expected)) return { kind: 'permanent', code: 'invalid_record_identity' };
    const found = await ctx.xrpc.getRecord(op.collection, op.rkey as string);
    if (found.kind === 'failed')
      return found.failure.kind === 'transient'
        ? { kind: 'waiting', untilMs: ctx.m.clock.nowMs() + 5_000 }
        : failureOutcome(found.failure);
    if (found.kind === 'absent') {
      // A legacy import single never sends again (it is only read); proven
      // absence moves it to the rebatcher instead of failing the listen.
      if (op.collection === ctx.collections.scrobble && legacyImportNeedsReconcile(ctx.m.db, op))
        return legacyAbsent(op, ctx);
      return { kind: 'permanent', code: 'attempts_exhausted' };
    }
    return (await sameDigest(op, found.value))
      ? {
          kind: 'succeeded',
          uri: found.uri,
          cid: found.cid,
          hints: [{ collection: op.collection, rkey: op.rkey as string }],
        }
      : { kind: 'permanent', code: 'remote_record_conflict' };
  },
};
