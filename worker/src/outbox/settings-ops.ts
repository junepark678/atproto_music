// The signed opt-out record (ADR 0005 §5.7 `PUT /api/v1/account/indexing`,
// ADR 0004 §5.3, A10; N2-05). Ports web/src/outbox/settings-ops.ts.
//
// - `settings.put` writes `<prefix>.settings/self {indexing}` with putRecord:
//   the literal key is the owner's single, replaceable choice. `disabled`
//   opts out, `enabled` opts back in; every put is a new commit, so a later
//   choice lands at a newer repository revision.
// - After the write the record's hint is queued (source `notify`, through the
//   runner), so the verify drain applies the opt-out once it is proven.
// - The record is public and erases nothing on the PDS.
// - Settings intents of one DID run FIFO, so the last one wins on the PDS.

import { buildSettingsRecord, type Indexing, SETTINGS_RKEY } from '@atmusic/core/settings';
import type { Origin } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import type { EnqueueResult } from './follow-ops';
import { insertOperation, newOperationId, outboxCollections, prepare, unsettledOfKinds } from './operations';
import { failureOutcome } from './pds-writer';
import type { ExecContext, Executor } from './runner';
import { hasIdentity, lookupCreate, sameDigest } from './scrobble-ops';

/** Persists a write of `settings/self` with the given indexing choice. */
export async function enqueueSettings(
  m: ModuleDeps,
  args: { did: string; indexing: Indexing; origin: Origin; kick?: () => void },
): Promise<EnqueueResult> {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const built = buildSettingsRecord(args.indexing, prefix, m.clock);
  if (!built.ok) return { ok: false, reason: built.reason };
  const prepared = await prepare(built.record as unknown as Record<string, unknown>);
  const now = m.clock.nowMs();
  const operation = m.db.tx(() =>
    insertOperation(
      m.db,
      {
        id: newOperationId(m.random),
        did: args.did,
        kind: 'settings.put',
        origin: args.origin,
        collection: outboxCollections(prefix).settings,
        rkey: SETTINGS_RKEY,
        prepared,
        dueAt: now,
        predecessors: unsettledOfKinds(m.db, args.did, ['settings.put']).map((o) => o.id),
      },
      now,
    ),
  );
  args.kick?.();
  return { ok: true, operation };
}

function settingsIdentity(op: Parameters<Executor['execute']>[0], ctx: ExecContext): boolean {
  return hasIdentity(op, ctx, ctx.collections.settings) && op.rkey === SETTINGS_RKEY;
}

export const settingsPutExecutor: Executor = {
  async execute(op, ctx) {
    if (!settingsIdentity(op, ctx) || op.record_json === null) {
      return { kind: 'permanent', code: 'invalid_record_identity' };
    }
    const record: unknown = JSON.parse(op.record_json);
    const result = await ctx.xrpc.procedure(
      'com.atproto.repo.putRecord',
      { repo: op.did, collection: op.collection, rkey: SETTINGS_RKEY, record },
      'put',
    );
    const matches = (remote: unknown) => sameDigest(op, remote);
    if (result.ok) {
      const body = result.body as { cid?: unknown } | null;
      return typeof body?.cid === 'string'
        ? {
            kind: 'succeeded',
            uri: `at://${op.did}/${op.collection}/${SETTINGS_RKEY}`,
            cid: body.cid,
            hints: [{ collection: op.collection, rkey: SETTINGS_RKEY }],
          }
        : lookupCreate(op, ctx, matches, 'remote_write_unconfirmed');
    }
    if (result.failure.kind === 'missing') return lookupCreate(op, ctx, matches, 'remote_write_unconfirmed');
    return failureOutcome(result.failure);
  },
  async reconcile(op, ctx) {
    if (!settingsIdentity(op, ctx)) return { kind: 'permanent', code: 'invalid_record_identity' };
    return lookupCreate(op, ctx, (remote) => sameDigest(op, remote), 'attempts_exhausted');
  },
};
