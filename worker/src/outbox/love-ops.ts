// Loves (ADR 0005 §5.8 additions, §6.3, §7.8; N2-05).
//
// - Identity: one love per (artist_key, track_key) per DID, enforced here
//   from local state, never by listing the PDS collection (a listing per put
//   would cost one listRecords per 100 loves on every attempt, quadratic in an
//   import's size). A `love.put` decides from, in order:
//   1. the DID's last succeeded love operation for the key (love intents of
//      one key run FIFO, so it is the newest of our own decisions). A still
//      unindexed put is reusable; once a proof exists, the current projected
//      identity and CID decide whether its historic receipt is still current;
//   2. the `loves` projection (loves by other apps, or ours from before this
//      database).
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
import { admitForwardIdentity } from '../forward/projection';
import { bindPullLoveAdmission, retirePullLoveAdmissions } from '../sync/pull-love-admissions';
import { tombstoneLove } from '../sync/tombstones';
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
    // A fresh explicit API love is a new user intent and supersedes prior
    // unlove tombstones. Imported/pulled loves cannot clear them.
    if (args.origin !== 'import')
      m.db.run(
        `DELETE FROM linked_pull_tombstones WHERE did=? AND kind='love'
         AND (love_key=? OR (? IS NOT NULL AND recording_mbid=?) OR
           (? IS NOT NULL AND love_key IN (
             SELECT love_key FROM linked_pull_love_admissions WHERE did=? AND recording_mbid=?
           )))`,
        args.did,
        key,
        typeof record.recordingMbid === 'string' ? record.recordingMbid : null,
        typeof record.recordingMbid === 'string' ? record.recordingMbid : null,
        typeof record.recordingMbid === 'string' ? record.recordingMbid : null,
        args.did,
        typeof record.recordingMbid === 'string' ? record.recordingMbid : null,
      );
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
    if (args.origin !== 'import')
      m.db.run(
        `INSERT INTO linked_love_intents(did,love_key,intent,operation_id,updated_at_ms,recording_mbid)
        VALUES(?,?,'love',?,?,?)
        ON CONFLICT(did,love_key) DO UPDATE SET intent='love',operation_id=excluded.operation_id,
          updated_at_ms=excluded.updated_at_ms,recording_mbid=coalesce(excluded.recording_mbid,linked_love_intents.recording_mbid)`,
        args.did,
        key,
        op.id,
        now,
        typeof record.recordingMbid === 'string' ? record.recordingMbid : null,
      );
    admitForwardIdentity(m.db, {
      did: args.did,
      identityKey: `love-uri:${args.did}:${outboxCollections(prefix).love}:${op.rkey}`,
      path: args.origin === 'import' ? 'import' : 'api',
      now,
    });
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
    const [artistKeyValue, trackKeyValue] = trackKey(intent.artist, intent.track);
    const mbids = m.db.all<{ recording_mbid: string | null }>(
      'SELECT recording_mbid FROM loves WHERE did=? AND artist_key=? AND track_key=?',
      args.did,
      artistKeyValue,
      trackKeyValue,
    );
    let knownRecordingMbid = mbids.find((row) => row.recording_mbid !== null)?.recording_mbid ?? null;
    const previousIntent = m.db.one<{ recording_mbid: string | null }>(
      'SELECT recording_mbid FROM linked_love_intents WHERE did=? AND love_key=?',
      args.did,
      key,
    );
    knownRecordingMbid ??= previousIntent?.recording_mbid ?? null;
    if (args.origin !== 'import') {
      const acceptedPulls = retirePullLoveAdmissions(m.db, { did: args.did, loveKey: key, nowMs: now });
      knownRecordingMbid ??=
        acceptedPulls.find((admission) => admission.recording_mbid !== null)?.recording_mbid ?? null;
      tombstoneLove(m.db, { did: args.did, identity: `key:${key}`, loveKey: key, recordingMbid: null, nowMs: now });
      for (const [i, admission] of acceptedPulls.entries())
        if (admission.recording_mbid)
          tombstoneLove(m.db, {
            did: args.did,
            identity: `mbid:${admission.recording_mbid}`,
            loveKey: admission.love_key,
            recordingMbid: admission.recording_mbid,
            nowMs: now + i,
          });
      for (const [i, row] of mbids.entries())
        if (row.recording_mbid)
          tombstoneLove(m.db, {
            did: args.did,
            identity: `mbid:${row.recording_mbid}`,
            loveKey: key,
            recordingMbid: row.recording_mbid,
            nowMs: now + i,
          });
      for (const pending of unsettledOfKinds(m.db, args.did, ['love.put'])) {
        const record = recordOf(pending);
        if (!record || loveKeyOf(record.artist, record.track) !== key || typeof record.recordingMbid !== 'string')
          continue;
        knownRecordingMbid ??= record.recordingMbid;
        tombstoneLove(m.db, {
          did: args.did,
          identity: `mbid:${record.recordingMbid}`,
          loveKey: key,
          recordingMbid: record.recordingMbid,
          nowMs: now,
        });
      }
    }
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
    if (args.origin !== 'import')
      m.db.run(
        `INSERT INTO linked_love_intents(did,love_key,intent,operation_id,updated_at_ms,recording_mbid)
        VALUES(?,?,'unlove',?,?,?)
        ON CONFLICT(did,love_key) DO UPDATE SET intent='unlove',operation_id=excluded.operation_id,
          updated_at_ms=excluded.updated_at_ms,recording_mbid=coalesce(excluded.recording_mbid,linked_love_intents.recording_mbid)`,
        args.did,
        key,
        op.id,
        now,
        knownRecordingMbid,
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
    // A completed unlove supersedes the still-visible projection until its
    // deletion hint is verified. Re-loving must write its new persisted key.
    if (
      last.kind === 'love.delete' &&
      db.one(
        `SELECT 1 AS hit FROM loves l JOIN record_state r ON r.uri=l.uri AND r.cid=l.cid AND r.state='present'
       JOIN love_delete_bridges b ON b.did=l.did AND b.uri=l.uri
       WHERE l.did=? AND b.state='obsolete' AND b.delete_rev IS NOT NULL AND r.revision>b.delete_rev
         AND l.artist_key=? AND l.track_key=? LIMIT 1`,
        op.did,
        ...trackKey(recordOf(op)?.artist as string, recordOf(op)?.track as string),
      ) === null
    )
      return null;
    if (last.kind === 'love.put' && last.uri !== null && last.cid !== null) {
      const rkey = ownRecordKey(last.uri, op.did, op.collection);
      if (rkey !== null) {
        const fencedDelete =
          db.one(
            `SELECT 1 AS hit FROM love_delete_bridges WHERE did=? AND uri=?
             AND state IN ('pending','succeeded') LIMIT 1`,
            op.did,
            last.uri,
          ) !== null;
        const state = db.one<{ cid: string | null; state: string }>(
          `SELECT cid, state FROM record_state WHERE uri = ?`,
          last.uri,
        );
        if (state === null && !fencedDelete) {
          // A successful write can be ahead of its proof. Keep that receipt
          // reusable across runs so a second intent cannot duplicate it.
          return { uri: last.uri, cid: last.cid, rkey };
        }
        if (!fencedDelete && state?.state === 'present' && state.cid !== null) {
          const projected = db.one<{
            uri: string;
            cid: string;
            artist_key: string;
            track_key: string;
          }>(`SELECT uri, cid, artist_key, track_key FROM loves WHERE uri = ? AND did = ?`, last.uri, op.did);
          const record = recordOf(op);
          const [artistKey, trackKeyPart] = trackKey(record?.artist as string, record?.track as string);
          if (
            projected !== null &&
            projected.cid === state.cid &&
            projected.artist_key === artistKey &&
            projected.track_key === trackKeyPart
          ) {
            // A same-rkey metadata rewrite is still this love, but its
            // verified current CID replaces the historic operation receipt.
            return { uri: projected.uri, cid: projected.cid, rkey };
          }
        }
        // An absent/excluded proof, or a present proof for another identity,
        // invalidates the old success. The current matching projection below
        // may still contain the requested love at a different URI.
      }
    }
  }
  const record = recordOf(op);
  const [artistKey, trackKeyPart] = trackKey(record?.artist as string, record?.track as string);
  const row = db.one<{ uri: string; cid: string }>(
    `SELECT uri, cid FROM loves
     WHERE did = ? AND artist_key = ? AND track_key = ?
       AND NOT EXISTS (
         SELECT 1 FROM love_delete_bridges AS bridge
         WHERE bridge.did=loves.did AND bridge.uri=loves.uri AND bridge.state IN ('pending','succeeded')
       )
     ORDER BY created_at, uri LIMIT 1`,
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
      const currentIncarnation = ctx.m.db.one<{ incarnation_key: string }>(
        "SELECT incarnation_key FROM love_incarnations WHERE uri=? AND state='present'",
        existing.uri,
      );
      let incarnationKey = currentIncarnation?.incarnation_key ?? null;
      if (currentIncarnation === null) {
        const accepted = ctx.m.db.one<{ path: string; source_service: string | null }>(
          'SELECT path,source_service FROM forward_admissions WHERE did=? AND identity_key=?',
          op.did,
          `love-uri:${op.did}:${op.collection}:${op.rkey}`,
        );
        const isImport = accepted?.path === 'import';
        incarnationKey = `love:${existing.uri}:${isImport ? `import:${op.id}` : `api:${op.id}`}`;
        admitForwardIdentity(ctx.m.db, {
          did: op.did,
          identityKey: incarnationKey,
          path: isImport ? 'import' : 'api',
          ...(isImport && accepted?.source_service !== null ? { sourceService: accepted?.source_service } : {}),
          now: ctx.m.clock.nowMs(),
        });
        ctx.m.db.run(
          `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms) VALUES (?,?,'present',?,?,?)
           ON CONFLICT(uri) DO NOTHING`,
          existing.uri,
          incarnationKey,
          isImport ? 'import' : 'api',
          isImport ? (accepted?.source_service ?? null) : null,
          ctx.m.clock.nowMs(),
        );
      }
      const accepted = ctx.m.db.one<{ path: string; source_service: string | null }>(
        'SELECT path,source_service FROM forward_admissions WHERE did=? AND identity_key=?',
        op.did,
        `love-uri:${op.did}:${op.collection}:${op.rkey}`,
      );
      if (accepted?.path === 'import' && incarnationKey !== null) {
        ctx.m.db.run(
          `INSERT INTO love_import_bridges(did,operation_id,uri,incarnation_key,source_service,state,created_at_ms)
           VALUES (?,?,?,?,?,'bound',?) ON CONFLICT(did,operation_id) DO UPDATE SET
             uri=excluded.uri,incarnation_key=excluded.incarnation_key,source_service=excluded.source_service,state='bound'`,
          op.did,
          op.id,
          existing.uri,
          incarnationKey,
          accepted.source_service,
          ctx.m.clock.nowMs(),
        );
        bindPullLoveAdmission(ctx.m.db, {
          did: op.did,
          operationId: op.id,
          uri: existing.uri,
          incarnationKey,
          nowMs: ctx.m.clock.nowMs(),
        });
      }
      ctx.m.db.run(
        'DELETE FROM forward_admissions WHERE did=? AND identity_key=?',
        op.did,
        `love-uri:${op.did}:${op.collection}:${op.rkey}`,
      );
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
      if (outcome.uri !== undefined && outcome.uri !== null)
        bindPullLoveAdmission(ctx.m.db, {
          did: op.did,
          operationId: op.id,
          uri: outcome.uri,
          incarnationKey: `love:${outcome.uri}:import:${op.id}`,
          nowMs: ctx.m.clock.nowMs(),
        });
    }
    return outcome;
  },
  async reconcile(op, ctx) {
    if (!hasIdentity(op, ctx, ctx.collections.love)) return { kind: 'permanent', code: 'invalid_record_identity' };
    const outcome = await lookupCreate(op, ctx, (remote) => sameDigest(op, remote), 'attempts_exhausted');
    if (outcome.kind === 'succeeded' && outcome.uri !== undefined && outcome.uri !== null)
      bindPullLoveAdmission(ctx.m.db, {
        did: op.did,
        operationId: op.id,
        uri: outcome.uri,
        incarnationKey: `love:${outcome.uri}:import:${op.id}`,
        nowMs: ctx.m.clock.nowMs(),
      });
    return outcome;
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
    const bridgeBeforeDelete = ({ uri, cid }: { uri: string; cid: string }) => {
      const incarnation = ctx.m.db.one<{ incarnation_key: string; state: string }>(
        'SELECT incarnation_key,state FROM love_incarnations WHERE uri=?',
        uri,
      );
      const incarnationKey = incarnation?.state === 'present' ? incarnation.incarnation_key : `love:${uri}:cid:${cid}`;
      if (incarnation?.state !== 'present') {
        ctx.m.db.run(
          `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
           VALUES (?,?,'present','api',NULL,?) ON CONFLICT(uri) DO NOTHING`,
          uri,
          incarnationKey,
          ctx.m.clock.nowMs(),
        );
      }
      ctx.m.db.run(
        `INSERT INTO love_delete_bridges(did,uri,incarnation_key,expected_cid,operation_id,state,created_at_ms,delete_rev)
         VALUES (?,?,?,?,?,'pending',?,NULL) ON CONFLICT(did,uri,incarnation_key,operation_id)
         DO UPDATE SET expected_cid=excluded.expected_cid,state='pending',delete_rev=NULL`,
        op.did,
        uri,
        incarnationKey,
        cid,
        op.id,
        ctx.m.clock.nowMs(),
      );
    };
    const bridgeFailed = ({ uri, cid }: { uri: string; cid: string }) => {
      ctx.m.db.run(
        "UPDATE love_delete_bridges SET state='obsolete' WHERE did=? AND uri=? AND expected_cid=? AND operation_id=? AND state='pending'",
        op.did,
        uri,
        cid,
        op.id,
      );
    };
    const deleteSucceeded = ({ uri, cid }: { uri: string; cid: string }, commitRev: string | null) => {
      ctx.m.db.run(
        `UPDATE love_delete_bridges SET delete_rev=coalesce(?,delete_rev)
         WHERE did=? AND uri=? AND expected_cid=? AND operation_id=? AND state='pending'`,
        commitRev,
        op.did,
        uri,
        cid,
        op.id,
      );
    };
    const outcome = await deleteMatching(
      op,
      ctx,
      loveMatches(key),
      [],
      bridgeBeforeDelete,
      bridgeFailed,
      deleteSucceeded,
    );
    if (outcome.kind === 'succeeded') {
      ctx.m.db.run(
        "UPDATE love_delete_bridges SET state='succeeded' WHERE did=? AND operation_id=? AND state='pending'",
        op.did,
        op.id,
      );
      remember(ctx, op.did, key, { kind: 'love.delete', uri: null, cid: null });
    }
    return outcome;
  },
  async reconcile(op, ctx) {
    const key = unloveIdentity(op, ctx);
    if (key === null) return { kind: 'permanent', code: 'invalid_record_identity' };
    const outcome = await noneMatching(op, ctx, loveMatches(key));
    if (outcome.kind === 'succeeded') {
      ctx.m.db.run(
        "UPDATE love_delete_bridges SET state='succeeded' WHERE did=? AND operation_id=? AND state='pending'",
        op.did,
        op.id,
      );
      remember(ctx, op.did, key, { kind: 'love.delete', uri: null, cid: null });
    }
    return outcome;
  },
};
