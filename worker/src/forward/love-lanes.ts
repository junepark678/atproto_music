import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import type { ForwardOutboxRow } from '../app/rows';
import type { Db } from '../do/db';

export const MAX_LOVE_FRAMING_PER_RUN = 64;
export const MAX_LOVE_LANES_PER_LINK_PER_RUN = 32;
export const LOVE_KINDS = ['love', 'unlove'] as const;

export const UNKEYED_SQL = `SELECT rowid AS seq,* FROM forward_outbox INDEXED BY forward_outbox_love_unkeyed
  WHERE link_id=? AND generation=? AND kind=? AND state='queued'
    AND (love_artist_key IS NULL OR love_track_key IS NULL)
  ORDER BY created_at_ms LIMIT ?`;
export const UNFRAMED_SQL = `SELECT rowid AS seq,* FROM forward_outbox INDEXED BY forward_outbox_love_unframed
  WHERE link_id=? AND generation=? AND kind=? AND state='queued' AND love_lane IS NULL
  ORDER BY created_at_ms LIMIT ?`;
export const TOUCH_SQL = `INSERT INTO forward_love_lanes(link_id,generation,love_artist_key,love_track_key,priority,due_at,head_created_at_ms)
  VALUES(?,?,?,?,?,?,?) ON CONFLICT(link_id,generation,love_artist_key,love_track_key) DO UPDATE SET
  priority=min(priority,excluded.priority),due_at=min(due_at,excluded.due_at),
  head_created_at_ms=min(head_created_at_ms,excluded.head_created_at_ms)`;
export const HEAD_SQL = `SELECT f.*,f.rowid AS seq FROM forward_outbox f INDEXED BY forward_outbox_love_heads
  WHERE f.link_id=? AND f.generation=? AND f.state='queued' AND f.love_artist_key=? AND f.love_track_key=?
    AND f.kind IN ('love','unlove')
  ORDER BY f.created_at_ms,f.rowid LIMIT 1`;
export const LANE_PICK_SQL = `SELECT rowid,love_artist_key,love_track_key,priority,due_at,head_created_at_ms
  FROM forward_love_lanes INDEXED BY forward_love_lanes_due
  WHERE link_id=? AND generation=? AND priority=? AND due_at<=? ORDER BY due_at,rowid LIMIT ?`;

export interface LoveLaneHint {
  linkId: string;
  generation: number;
  artistKey: string;
  trackKey: string;
  priority: 0 | 1;
  dueAt: number;
  createdAtMs: number;
}

export function touchLoveLane(db: Db, lane: LoveLaneHint): void {
  db.run(
    TOUCH_SQL,
    lane.linkId,
    lane.generation,
    lane.artistKey,
    lane.trackKey,
    lane.priority,
    lane.dueAt,
    lane.createdAtMs,
  );
}

export function refreshLoveLane(
  db: Db,
  linkId: string,
  generation: number,
  artistKey: string,
  trackKeyValue: string,
): QueuedRow | null {
  const head = db.one<QueuedRow>(HEAD_SQL, linkId, generation, artistKey, trackKeyValue);
  if (head === null) {
    db.run(
      'DELETE FROM forward_love_lanes WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?',
      linkId,
      generation,
      artistKey,
      trackKeyValue,
    );
    return null;
  }
  db.run(
    `UPDATE forward_love_lanes SET priority=?,due_at=?,head_created_at_ms=?
    WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
    head.priority,
    head.due_at,
    head.created_at_ms,
    linkId,
    generation,
    artistKey,
    trackKeyValue,
  );
  return head;
}

export function noteForwardLoveCurrent(
  db: Db,
  linkId: string,
  artistKey: string,
  trackKeyValue: string,
  rowid: number,
): void {
  db.run(
    `INSERT INTO mb_forward_love_current(link_id,love_artist_key,love_track_key,forward_rowid) VALUES(?,?,?,?)
    ON CONFLICT(link_id,love_artist_key,love_track_key) DO UPDATE SET forward_rowid=excluded.forward_rowid
    WHERE excluded.forward_rowid>mb_forward_love_current.forward_rowid`,
    linkId,
    artistKey,
    trackKeyValue,
    rowid,
  );
}

export function hasUnkeyedLoves(db: Db, linkId: string, generation: number): boolean {
  return LOVE_KINDS.some((kind) => db.all(UNKEYED_SQL, linkId, generation, kind, 1).length > 0);
}

export type QueuedRow = ForwardOutboxRow & { seq: number };
export { MusicKeyError, trackKey };
