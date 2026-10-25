// Loves (ADR 0005 §5.8 additions, §6.3, §7.8; N2-05).
//
// - Identity: one love per (artist_key, track_key) per DID, enforced here
//   from local state, never by listing the PDS collection (a listing per put
//   would cost one listRecords per 100 loves on every attempt, quadratic in an
//   import's size). A `love.put` decides from, in order:
//   1. the DID's last succeeded love operation for the key (love intents of
//      one key run FIFO, so it is the newest of our own decisions): a love.put
//      whose record the index has not seen deleted means the love exists; a
//      love.delete means ours are gone;
//   2. with no such operation, the `loves` projection (loves by other apps,
//      or ours from before this database).
//   An existing love makes the operation succeed with that record, writing
//   nothing, and hints it. Otherwise it creates the record at its persisted
//   TID rkey with ambiguous-create reconciliation (getRecord at that rkey +
//   digest), as a scrobble, so a create whose answer was lost is found
//   without a listing. The operation index is read once per DID per outbox
//   run (`ExecContext.memo`) and updated as love operations succeed in it.
//   Best effort against other apps: a love another app wrote after our last
//   unlove, not yet indexed, may be duplicated (unlove deletes every match).
// - `love.delete` (unlove) lists the same collection, page by page, and
//   deletes, with swapRecord, every record matching the key, mirroring
//   unfollow; each confirmed delete is hinted at once. Its intent
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
import { ownRecordKey } from './delete-ops';
import { deleteMatching, type EnqueueResult, noneMatching } from './follow-ops';
import { enqueueForwards } from './forward-enqueue';
import { insertOperation, newOperationId, outboxCollections, prepare, recordOf, unsettledOfKinds } from './operations';
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

/** The last succeeded love operation of a DID for one key. */
interface LoveDecision {
  kind: 'love.put' | 'love.delete';
  uri: string | null;
  cid: string | null;
}

/** Key → last succeeded love operation of `did`, read once per run and kept current by `remember`. */
function decisions(ctx: ExecContext, did: string): Map<string, LoveDecision> {
  return ctx.memo(`love-decisions|${did}`, () => {
    const map = new Map<string, LoveDecision>();
    const rows = ctx.m.db.all<{
      kind: 'love.put' | 'love.delete';
      record_json: string | null;
      result_uri: string | null;
      result_cid: string | null;
    }>(
      `SELECT kind, record_json, result_uri, result_cid FROM operations
       WHERE did = ? AND kind IN ('love.put','love.delete') AND state = 'succeeded' ORDER BY rowid`,
      did,
    );
    for (const row of rows) {
      const key = keyOfOperation(row);
      if (key !== null) map.set(key, { kind: row.kind, uri: row.result_uri, cid: row.result_cid });
    }
    return map;
  });
}

function remember(ctx: ExecContext, did: string, key: string, decision: LoveDecision): void {
  decisions(ctx, did).set(key, decision);
}

interface ExistingLove {
  uri: string;
  cid: string;
  rkey: string;
}

/** The love of `key` the DID already has, from local state only (see the header); null when none. */
function existingLove(op: OperationRow, ctx: ExecContext, key: string): ExistingLove | null {
  const db = ctx.m.db;
  const last = decisions(ctx, op.did).get(key);
  if (last !== undefined) {
    if (last.kind === 'love.delete' || last.uri === null || last.cid === null) return null;
    const rkey = ownRecordKey(last.uri, op.did, op.collection);
    const gone =
      db.one<{ x: number }>(`SELECT 1 AS x FROM record_state WHERE uri = ? AND state = 'absent'`, last.uri) !== null;
    if (rkey !== null && !gone) return { uri: last.uri, cid: last.cid, rkey };
    // Our love was deleted elsewhere (seen by the index): fall back to the projection.
  }
  const record = recordOf(op);
  const [artistKey, trackKeyPart] = trackKey(record?.artist as string, record?.track as string);
  const row = db.one<{ uri: string; cid: string }>(
    `SELECT uri, cid FROM loves WHERE did = ? AND artist_key = ? AND track_key = ? ORDER BY created_at, uri LIMIT 1`,
    op.did,
    artistKey,
    trackKeyPart,
  );
  if (row === null) return null;
  const rkey = ownRecordKey(row.uri, op.did, op.collection);
  return rkey === null ? null : { uri: row.uri, cid: row.cid, rkey };
}

export const lovePutExecutor: Executor = {
  async execute(op, ctx) {
    const key = keyOfOperation(op);
    if (!hasIdentity(op, ctx, ctx.collections.love) || op.digest === null || key === null) {
      return { kind: 'permanent', code: 'invalid_record_identity' };
    }
    const existing = existingLove(op, ctx, key);
    if (existing !== null) {
      // One love per key: an existing love is this love; nothing is written. It
      // is hinted like a written one (hinting an indexed record is harmless),
      // so an unknown DID is admitted too.
      remember(ctx, op.did, key, { kind: 'love.put', uri: existing.uri, cid: existing.cid });
      return {
        kind: 'succeeded',
        uri: existing.uri,
        cid: existing.cid,
        hints: [{ collection: op.collection, rkey: existing.rkey }],
      };
    }
    const outcome = await createWithReconcile(op, ctx, (remote) => sameDigest(op, remote));
    if (outcome.kind === 'succeeded') {
      remember(ctx, op.did, key, { kind: 'love.put', uri: outcome.uri ?? null, cid: outcome.cid ?? null });
    }
    return outcome;
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
    const outcome = await deleteMatching(op, ctx, loveMatches(key));
    if (outcome.kind === 'succeeded') remember(ctx, op.did, key, { kind: 'love.delete', uri: null, cid: null });
    return outcome;
  },
  async reconcile(op, ctx) {
    const key = unloveIdentity(op, ctx);
    if (key === null) return { kind: 'permanent', code: 'invalid_record_identity' };
    const outcome = await noneMatching(op, ctx, loveMatches(key));
    if (outcome.kind === 'succeeded') remember(ctx, op.did, key, { kind: 'love.delete', uri: null, cid: null });
    return outcome;
  },
};
