import type { Random } from '@atmusic/core/deps';
import type { LinkedAccountRow } from '../app/rows';
import type { Db } from '../do/db';
import type { ForwardItem } from '../outbox/forward-enqueue';
import { enqueueForwards } from '../outbox/forward-enqueue';
import { countLinkCoverage } from './coverage';
import { armLoveCoverage, validDeferredAuthorization } from './love-deferral-storage';
import { remoteLoveState } from './love-delivery';
import { latestExplicitLoveIntentRecord } from './love-intent';

const TOP_WINDOW = 17;

interface DeferredIntent {
  intent_seq: number;
  kind: 'love' | 'unlove';
  operation_id: string;
  origin_class: 'operation' | 'authorized' | 'live_love' | 'unclassified';
  payload_json: string;
  authorization_uri: string | null;
  authorization_rev: string | null;
  intent_at_ms: number;
}

function operationCancelled(db: Db, operationId: string): boolean {
  return db.one<{ state: string }>('SELECT state FROM operations WHERE id=?', operationId)?.state === 'cancelled';
}

function liveLoveSucceeded(db: Db, row: DeferredIntent): boolean {
  return (
    row.origin_class === 'live_love' &&
    db.one<{ state: string }>('SELECT state FROM operations WHERE id=?', row.operation_id)?.state === 'succeeded'
  );
}

export function desiredLoved(
  db: Db,
  link: LinkedAccountRow,
  intent: DeferredIntent,
  artistKey: string,
  trackKey: string,
): boolean {
  const explicit = latestExplicitLoveIntentRecord(db, link.did, artistKey, trackKey);
  if (explicit !== null && explicit.updatedAtMs >= intent.intent_at_ms) {
    if (!operationCancelled(db, explicit.operationId)) return explicit.intent === 'love';
    // A cancelled newer API intent must not hide this surviving ordered
    // deferral. The projection can still reflect the earlier remote love.
    return intent.kind === 'love';
  }
  return (
    db.one(
      'SELECT 1 AS present FROM loves WHERE did=? AND artist_key=? AND track_key=? LIMIT 1',
      link.did,
      artistKey,
      trackKey,
    ) !== null
  );
}

function valid(db: Db, row: DeferredIntent): boolean {
  if (row.origin_class === 'authorized') {
    return (
      row.authorization_uri !== null &&
      row.authorization_rev !== null &&
      validDeferredAuthorization(db, row.authorization_uri, row.authorization_rev)
    );
  }
  if (row.origin_class === 'unclassified') return false;
  return !operationCancelled(db, row.operation_id);
}

function setRunningIfCompleted(db: Db, link: LinkedAccountRow): void {
  db.run(
    `UPDATE linked_accounts SET backfill_state='pending',backfill_cursor=NULL,backfill_total=0,backfill_done=0,
       backfill_failures=0,backfill_next_attempt_ms=NULL,backfill_run_revision=backfill_run_revision+1,
       backfill_discovery_cursor=NULL,backfill_discovery_done=0,backfill_last_error=NULL
     WHERE id=? AND generation=? AND backfill_run_revision=? AND backfill_state='done'
       AND status='active' AND forward_scrobbles=1`,
    link.id,
    link.generation,
    link.backfill_run_revision,
  );
}

/** Arms a current head and reopens a completed history run when necessary. */
export function armLoveCoverageForHead(db: Db, link: LinkedAccountRow, artistKey: string, trackKey: string): boolean {
  const armed = armLoveCoverage(db, link, artistKey, trackKey);
  if (armed) setRunningIfCompleted(db, link);
  return armed;
}

/** Settles a bounded FIFO page of armed current-generation heads. */
export function runLoveCoverageChunk(
  db: Db,
  link: LinkedAccountRow,
  now: number,
  random: Random,
  limit: number,
): number {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError('love coverage limit must be a non-negative safe integer');
  if (limit === 0) return 0;
  return db.tx(() => {
    const fence = db.one<{
      generation: number;
      backfill_run_revision: number;
      backfill_state: string;
      status: string;
      forward_scrobbles: number;
    }>(
      'SELECT generation,backfill_run_revision,backfill_state,status,forward_scrobbles FROM linked_accounts WHERE id=?',
      link.id,
    );
    if (
      fence === null ||
      fence.generation !== link.generation ||
      fence.backfill_run_revision !== link.backfill_run_revision ||
      fence.backfill_state !== 'running' ||
      fence.status !== 'active' ||
      fence.forward_scrobbles !== 1
    )
      return 0;

    const heads = db.all<{ love_artist_key: string; love_track_key: string }>(
      `SELECT love_artist_key,love_track_key FROM forward_deferred_love_heads
       WHERE link_id=? AND generation=? AND armed_seq IS NOT NULL ORDER BY armed_seq,head_seq LIMIT ?`,
      link.id,
      link.generation,
      Math.min(128, limit),
    );
    for (const head of heads) {
      const rows = db.all<DeferredIntent>(
        `SELECT intent_seq,kind,operation_id,origin_class,payload_json,authorization_uri,authorization_rev,intent_at_ms
         FROM forward_deferred_love_intents WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?
           AND intent_seq>=coalesce((SELECT live_from_seq FROM forward_deferred_love_heads WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?),1)
         ORDER BY intent_seq DESC LIMIT ?`,
        link.id,
        link.generation,
        head.love_artist_key,
        head.love_track_key,
        link.id,
        link.generation,
        head.love_artist_key,
        head.love_track_key,
        TOP_WINDOW,
      );
      let newest: DeferredIntent | null = null;
      let barrier: DeferredIntent | null = null;
      for (const row of rows) {
        if (!valid(db, row)) continue;
        if (row.origin_class === 'live_love') {
          barrier ??= row;
          newest ??= row;
        } else newest ??= row;
      }
      const next = db.one<{ next_seq: number; live_from_seq: number }>(
        `SELECT next_seq,live_from_seq FROM forward_deferred_love_heads
         WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
        link.id,
        link.generation,
        head.love_artist_key,
        head.love_track_key,
      );
      if (next === null) continue;
      let floor = next.live_from_seq;
      if (newest === null) {
        if (rows.length < TOP_WINDOW) floor = next.next_seq;
      } else if (liveLoveSucceeded(db, newest)) floor = next.next_seq;
      else if (barrier !== null) floor = Math.max(floor, barrier.intent_seq);

      if (
        newest !== null &&
        newest.kind === 'unlove' &&
        newest.authorization_uri !== null &&
        newest.authorization_rev !== null &&
        !desiredLoved(db, link, newest, head.love_artist_key, head.love_track_key) &&
        remoteLoveState(db, link, head.love_artist_key, head.love_track_key) === 'love'
      ) {
        const item: ForwardItem = {
          kind: 'unlove',
          operationId: newest.operation_id,
          payload: JSON.parse(newest.payload_json) as unknown,
          authorization: { uri: newest.authorization_uri, rev: newest.authorization_rev },
        };
        enqueueForwards(db, { did: link.did, linkId: link.id, priority: 1, now, random, items: [item] });
        countLinkCoverage(db, 'deferred_coverage_unlove');
      } else if (newest !== null && newest.kind === 'unlove' && newest.authorization_uri === null) {
        if (
          !desiredLoved(db, link, newest, head.love_artist_key, head.love_track_key) &&
          remoteLoveState(db, link, head.love_artist_key, head.love_track_key) === 'love'
        ) {
          const item: ForwardItem = {
            kind: 'unlove',
            operationId: newest.operation_id,
            payload: JSON.parse(newest.payload_json) as unknown,
          };
          enqueueForwards(db, { did: link.did, linkId: link.id, priority: 1, now, random, items: [item] });
          countLinkCoverage(db, 'deferred_coverage_unlove');
        }
      } else if (newest === null) countLinkCoverage(db, 'deferred_coverage_pruned');

      const nextMaintenance = floor > next.live_from_seq || rows.length === TOP_WINDOW;
      db.run(
        `UPDATE forward_deferred_love_heads SET armed_seq=NULL,decided_seq=?,live_from_seq=?,
           maintenance_seq=CASE WHEN ? THEN coalesce(maintenance_seq,head_seq) ELSE maintenance_seq END
         WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=? AND armed_seq IS NOT NULL`,
        newest?.intent_seq ?? null,
        floor,
        nextMaintenance ? 1 : 0,
        link.id,
        link.generation,
        head.love_artist_key,
        head.love_track_key,
      );
    }
    return heads.length;
  });
}
