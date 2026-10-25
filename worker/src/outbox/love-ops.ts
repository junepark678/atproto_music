// Loves (ADR 0005 §5.8 additions, §6.3, §7.8; N2-05).
//
// - Identity: one love per (artist_key, track_key) per DID, enforced here. A
//   `love.put` first lists the owner's `<prefix>.love` records on their PDS;
//   when one already matches the key (written by us earlier or by another
//   app) the operation succeeds with that record and writes nothing.
//   Otherwise it creates the record at its persisted TID rkey with
//   ambiguous-create reconciliation (getRecord + digest), as a scrobble.
// - `love.delete` (unlove) lists the same collection and deletes, with
//   swapRecord, every record matching the key, mirroring unfollow. Its intent
//   `{artist, track}` is stored as record_json (never sent); its rkey is NULL.
// - Love intents for one key run FIFO behind their unsettled predecessors.
// - Live loves and unloves (not imports) queue forward rows in the same
//   transaction (forward-enqueue.ts), keyed by the operation id, so love,
//   unlove, love forwards three calls in order.

import { buildLoveRecord } from '@atmusic/core/love';
import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import { newTid } from '@atmusic/core/record-key';
import type { ValidationFailure } from '@atmusic/core/scrobble';
import { validateDisplayString } from '@atmusic/core/scrobble';
import type { OperationRow, Origin } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import { deleteMatching, type EnqueueResult, noneMatching } from './follow-ops';
import { enqueueForwards } from './forward-enqueue';
import { insertOperation, newOperationId, outboxCollections, prepare, recordOf, unsettledOfKinds } from './operations';
import { failureOutcome } from './pds-writer';
import type { ExecContext, Executor } from './runner';
import { createWithReconcile, hasIdentity, lookupCreate, sameDigest } from './scrobble-ops';

/** `artist_key ‖ U+0000 ‖ track_key`, or null when either name is not a valid display string. */
export function loveKeyOf(artist: unknown, track: unknown): string | null {
  if (typeof artist !== 'string' || typeof track !== 'string') return null;
  try {
    const [a, t] = trackKey(artist, track);
    return `${a}\u0000${t}`;
  } catch (error) {
    if (error instanceof MusicKeyError) return null;
    throw error;
  }
}

function keyOfOperation(op: Pick<OperationRow, 'record_json'>): string | null {
  const record = recordOf(op);
  return record === null ? null : loveKeyOf(record.artist, record.track);
}

/** Unsettled love intents of `did` for the same key (FIFO predecessors). */
function lovePredecessors(m: ModuleDeps, did: string, key: string): string[] {
  return unsettledOfKinds(m.db, did, ['love.put', 'love.delete'])
    .filter((o) => keyOfOperation(o) === key)
    .map((o) => o.id);
}

export interface EnqueueLoveArgs {
  did: string;
  /** `{artist, track, album?, recordingMbid?}` (closed). */
  input: unknown;
  origin: Origin;
  kick?: () => void;
}

/** Persists a `love.put` (and, for live origins, its forward rows). */
export async function enqueueLove(m: ModuleDeps, args: EnqueueLoveArgs): Promise<EnqueueResult> {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const built = buildLoveRecord(args.input, prefix, m.clock);
  if (!built.ok) return { ok: false, reason: built.reason };
  const record = built.record as unknown as Record<string, unknown>;
  const key = loveKeyOf(record.artist, record.track);
  if (key === null) return { ok: false, reason: { field: 'artist', code: 'invalid_field', message: 'invalid name' } };
  const prepared = await prepare(record);
  const now = m.clock.nowMs();
  const operation = m.db.tx(() => {
    const op = insertOperation(
      m.db,
      {
        id: newOperationId(m.random),
        did: args.did,
        kind: 'love.put',
        origin: args.origin,
        collection: outboxCollections(prefix).love,
        rkey: newTid(m.clock, m.random),
        prepared,
        dueAt: now,
        predecessors: lovePredecessors(m, args.did, key),
      },
      now,
    );
    if (args.origin !== 'import') {
      const { $type: _type, createdAt: _created, ...payload } = record;
      enqueueForwards(m.db, {
        did: args.did,
        items: [{ kind: 'love', operationId: op.id, payload: { ...payload, origin: args.origin } }],
        now,
        random: m.random,
      });
    }
    return op;
  });
  args.kick?.();
  return { ok: true, operation };
}

function displayFailure(field: 'artist' | 'track', value: unknown): ValidationFailure | null {
  if (typeof value !== 'string') return { field, code: 'invalid_field', message: 'required string field' };
  const checked = validateDisplayString(field, value);
  return checked.ok ? null : checked.reason;
}

/** Persists a `love.delete` of every love matching (artist, track), and its forward rows for live origins. */
export async function enqueueUnlove(
  m: ModuleDeps,
  args: { did: string; artist: string; track: string; origin: Origin; kick?: () => void },
): Promise<EnqueueResult> {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const bad = displayFailure('artist', args.artist) ?? displayFailure('track', args.track);
  if (bad !== null) return { ok: false, reason: bad };
  const key = loveKeyOf(args.artist, args.track);
  if (key === null) return { ok: false, reason: { field: 'artist', code: 'invalid_field', message: 'invalid name' } };
  const intent = { artist: args.artist.trim(), track: args.track.trim() };
  const prepared = await prepare(intent);
  const now = m.clock.nowMs();
  const operation = m.db.tx(() => {
    const op = insertOperation(
      m.db,
      {
        id: newOperationId(m.random),
        did: args.did,
        kind: 'love.delete',
        origin: args.origin,
        collection: outboxCollections(prefix).love,
        rkey: null,
        prepared,
        dueAt: now,
        predecessors: lovePredecessors(m, args.did, key),
      },
      now,
    );
    if (args.origin !== 'import') {
      enqueueForwards(m.db, {
        did: args.did,
        items: [{ kind: 'unlove', operationId: op.id, payload: { ...intent, origin: args.origin } }],
        now,
        random: m.random,
      });
    }
    return op;
  });
  args.kick?.();
  return { ok: true, operation };
}

function loveMatches(key: string): (value: unknown) => boolean {
  return (value) => {
    if (value === null || typeof value !== 'object') return false;
    const v = value as { artist?: unknown; track?: unknown };
    return loveKeyOf(v.artist, v.track) === key;
  };
}

export const lovePutExecutor: Executor = {
  async execute(op, ctx) {
    const key = keyOfOperation(op);
    if (!hasIdentity(op, ctx, ctx.collections.love) || op.digest === null || key === null) {
      return { kind: 'permanent', code: 'invalid_record_identity' };
    }
    const listed = await ctx.xrpc.listAll(op.collection);
    if (!listed.ok) return failureOutcome(listed.failure);
    const matches = loveMatches(key);
    const existing = listed.records.find(
      (r) => r.uri.startsWith(`at://${op.did}/${op.collection}/`) && matches(r.value),
    );
    // One love per key: an existing love is this love; nothing is written.
    if (existing !== undefined) return { kind: 'succeeded', uri: existing.uri, cid: existing.cid, hints: [] };
    return createWithReconcile(op, ctx, (remote) => sameDigest(op, remote));
  },
  async reconcile(op, ctx) {
    if (!hasIdentity(op, ctx, ctx.collections.love)) return { kind: 'permanent', code: 'invalid_record_identity' };
    return lookupCreate(op, ctx, (remote) => sameDigest(op, remote), 'attempts_exhausted');
  },
};

function unloveIdentity(op: OperationRow, ctx: ExecContext): string | null {
  if (op.did !== ctx.xrpc.did || op.collection !== ctx.collections.love || op.rkey !== null) return null;
  return keyOfOperation(op);
}

export const loveDeleteExecutor: Executor = {
  async execute(op, ctx) {
    const key = unloveIdentity(op, ctx);
    if (key === null) return { kind: 'permanent', code: 'invalid_record_identity' };
    return deleteMatching(op, ctx, loveMatches(key));
  },
  async reconcile(op, ctx) {
    const key = unloveIdentity(op, ctx);
    if (key === null) return { kind: 'permanent', code: 'invalid_record_identity' };
    return noneMatching(op, ctx, loveMatches(key));
  },
};
