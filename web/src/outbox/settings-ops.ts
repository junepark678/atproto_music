// The signed opt-out record (ADR 0004 §5.3, §9 A10; lexicons/settings.json).
//
// - Disconnect writes `<prefix>.settings/self {indexing: "disabled"}` with
//   putRecord (the literal key is the owner's single, replaceable choice) and
//   sends notify; once the AppView has verified it, records/status reports the
//   DID as `suppressed`.
// - Reconnect writes `indexing: "enabled"`, or deletes `settings/self`.
// - The record is public and erases nothing on the PDS; the screens say so.
// - Settings intents for one DID run FIFO, so the last one wins on the PDS.

import type { Did, RecordStatus } from '@atmusic/core/api-types';
import { canonicalDigest } from '@atmusic/core/canonical';
import type { Clock, Random } from '@atmusic/core/deps';
import { collectionsFor } from '@atmusic/core/namespace';
import { buildSettingsRecord, type Indexing, SETTINGS_RKEY } from '@atmusic/core/settings';
import { lookupDeleted } from './delete-ops';
import { type ExecContext, type Executor, failureOutcome, type TrackVerdict } from './runner';
import { type EnqueueResult, hasIdentity, lookupCreate } from './scrobble-ops';
import { freshOperation, isUnsent, newOperationId, type OutboxOperation, type OutboxStore } from './store';

export interface EnqueueSettingsArgs {
  store: OutboxStore;
  did: Did;
  prefix: string;
  clock: Clock;
  random: Random;
}

async function enqueueSettingsOp(args: EnqueueSettingsArgs, indexing: Indexing | null): Promise<EnqueueResult> {
  const collection = collectionsFor(args.prefix).settings;
  let record: Record<string, unknown> | undefined;
  let digest: string | undefined;
  if (indexing !== null) {
    const built = buildSettingsRecord(indexing, args.prefix, args.clock);
    if (!built.ok) return { ok: false, reason: built.reason };
    record = built.record as unknown as Record<string, unknown>;
    digest = await canonicalDigest(record);
  }
  const id = newOperationId(args.random);
  const now = args.clock.nowMs();
  const op = await args.store.enqueue(args.did, ({ seq, existing }) =>
    freshOperation(
      {
        id,
        did: args.did,
        kind: indexing === null ? 'settings_delete' : 'settings_put',
        collection,
        rkey: SETTINGS_RKEY,
        uri: `at://${args.did}/${collection}/${SETTINGS_RKEY}`,
        predecessorIds: existing
          .filter((o) => (o.kind === 'settings_put' || o.kind === 'settings_delete') && isUnsent(o.state))
          .map((o) => o.id),
        seq,
        ...(record !== undefined ? { record } : {}),
        ...(digest !== undefined ? { digest } : {}),
      },
      now,
    ),
  );
  return { ok: true, op };
}

/** Writes `settings/self` with the given indexing choice. */
export function enqueueSettings(args: EnqueueSettingsArgs & { indexing: Indexing }): Promise<EnqueueResult> {
  return enqueueSettingsOp(args, args.indexing);
}

/** Disconnect: `settings/self {indexing: "disabled"}`, then notify. */
export function enqueueDisconnect(args: EnqueueSettingsArgs): Promise<EnqueueResult> {
  return enqueueSettingsOp(args, 'disabled');
}

/** Reconnect by writing `indexing: "enabled"`. */
export function enqueueReconnect(args: EnqueueSettingsArgs): Promise<EnqueueResult> {
  return enqueueSettingsOp(args, 'enabled');
}

/** Reconnect by deleting `settings/self`. */
export function enqueueSettingsDelete(args: EnqueueSettingsArgs): Promise<EnqueueResult> {
  return enqueueSettingsOp(args, null);
}

function settingsIdentity(op: OutboxOperation, ctx: ExecContext): boolean {
  return hasIdentity(op, ctx, ctx.collections.settings) && op.rkey === SETTINGS_RKEY;
}

async function sameSettings(op: OutboxOperation, remote: unknown): Promise<boolean> {
  try {
    return op.digest !== undefined && (await canonicalDigest(remote)) === op.digest;
  } catch {
    return false;
  }
}

/** The indexing choice the operation asks for. */
function wanted(op: OutboxOperation): Indexing {
  return op.kind === 'settings_put' && op.record?.indexing === 'disabled' ? 'disabled' : 'enabled';
}

function settingsVerdict(op: OutboxOperation, statuses: readonly (RecordStatus | null)[]): TrackVerdict {
  const s = statuses[0] ?? null;
  if (s === null) return { kind: 'continue' };
  if (s.state === 'excluded') return { kind: 'excluded', reason: s.reason ?? 'excluded' };
  const suppressed = s.indexing.state === 'suppressed';
  return suppressed === (wanted(op) === 'disabled') ? { kind: 'indexed' } : { kind: 'continue' };
}

export const settingsPutExecutor: Executor = {
  async execute(op, ctx) {
    if (!settingsIdentity(op, ctx) || op.record === undefined) {
      return { kind: 'permanent', code: 'invalid_record_identity' };
    }
    const result = await ctx.pds.procedure(
      'com.atproto.repo.putRecord',
      { repo: op.did, collection: op.collection, rkey: op.rkey, record: op.record },
      'put',
    );
    if (result.ok) {
      const body = result.body as { cid?: unknown } | null;
      return typeof body?.cid === 'string'
        ? { kind: 'published', patch: { cid: body.cid } }
        : lookupCreate(op, ctx, (remote) => sameSettings(op, remote), 'remote_write_unconfirmed');
    }
    if (result.failure.kind === 'missing') {
      return lookupCreate(op, ctx, (remote) => sameSettings(op, remote), 'remote_write_unconfirmed');
    }
    return failureOutcome(result.failure);
  },
  async reconcile(op, ctx) {
    if (!settingsIdentity(op, ctx)) return { kind: 'permanent', code: 'invalid_record_identity' };
    return lookupCreate(op, ctx, (remote) => sameSettings(op, remote), 'attempts_exhausted');
  },
  trackUris: (op) => [op.uri],
  verdict: settingsVerdict,
};

export const settingsDeleteExecutor: Executor = {
  async execute(op, ctx) {
    if (!settingsIdentity(op, ctx)) return { kind: 'permanent', code: 'invalid_record_identity' };
    const result = await ctx.pds.procedure(
      'com.atproto.repo.deleteRecord',
      { repo: op.did, collection: op.collection, rkey: op.rkey },
      'delete',
    );
    if (result.ok || result.failure.kind === 'missing') return { kind: 'published' };
    return failureOutcome(result.failure);
  },
  reconcile(op, ctx) {
    if (!settingsIdentity(op, ctx)) return Promise.resolve({ kind: 'permanent', code: 'invalid_record_identity' });
    return lookupDeleted(op, ctx);
  },
  trackUris: (op) => [op.uri],
  verdict: settingsVerdict,
};
