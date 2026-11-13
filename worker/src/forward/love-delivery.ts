import type { Db } from '../do/db';
import { canonicalForwardDedupeKey } from '../outbox/forward-identity';

export const LOVE_STATE_ROW_SQL = `SELECT kind,created_at_ms,rowid FROM forward_outbox INDEXED BY forward_outbox_love_heads
WHERE link_id=? AND generation=? AND state=? AND love_artist_key=? AND love_track_key=? AND kind IN ('love','unlove')
ORDER BY created_at_ms DESC,rowid DESC LIMIT 1`;

export interface SentLoveRow {
  link_id: string;
  generation: number;
  kind: string;
  dedupe_key: string;
  love_artist_key: string | null;
  love_track_key: string | null;
  created_at_ms: number;
}

export function recordLoveDelivery(db: Db, rows: readonly SentLoveRow[], now: number): void {
  for (const row of rows) {
    if ((row.kind !== 'love' && row.kind !== 'unlove') || row.love_artist_key === null || row.love_track_key === null)
      continue;
    const dedupeKey = canonicalForwardDedupeKey(row.generation, row.dedupe_key) ?? row.dedupe_key;
    db.run(
      `INSERT INTO forward_love_delivery(link_id,generation,love_artist_key,love_track_key,last_sent_kind,
         last_sent_dedupe_key,row_created_at_ms,sent_at_ms)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(link_id,generation,love_artist_key,love_track_key) DO UPDATE SET
         last_sent_kind=excluded.last_sent_kind,last_sent_dedupe_key=excluded.last_sent_dedupe_key,
         row_created_at_ms=excluded.row_created_at_ms,sent_at_ms=excluded.sent_at_ms
       WHERE excluded.row_created_at_ms>=forward_love_delivery.row_created_at_ms`,
      row.link_id,
      row.generation,
      row.love_artist_key,
      row.love_track_key,
      row.kind,
      dedupeKey,
      row.created_at_ms,
      now,
    );
  }
}

export interface LoveLink {
  id: string;
  generation: number;
}

interface StateRow {
  kind: 'love' | 'unlove';
  created_at_ms: number;
  rowid: number;
}

function later(a: StateRow | null, b: StateRow | null): StateRow | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a.created_at_ms !== b.created_at_ms) return a.created_at_ms > b.created_at_ms ? a : b;
  return a.rowid >= b.rowid ? a : b;
}

/** Current remote fact for one track, including legacy sent rows and post-cleanup ledger state. */
export function remoteLoveState(
  db: Db,
  link: LoveLink,
  artistKey: string,
  trackKey: string,
): 'love' | 'unlove' | 'none' {
  let pending: StateRow | null = null;
  for (const state of ['queued', 'held'] as const)
    pending = later(
      pending,
      db.one<StateRow>(LOVE_STATE_ROW_SQL, link.id, link.generation, state, artistKey, trackKey),
    );
  if (pending !== null) return pending.kind;

  const sent = db.one<StateRow>(LOVE_STATE_ROW_SQL, link.id, link.generation, 'sent', artistKey, trackKey);
  const delivery = db.one<{ last_sent_kind: 'love' | 'unlove'; row_created_at_ms: number }>(
    `SELECT last_sent_kind,row_created_at_ms FROM forward_love_delivery
     WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
    link.id,
    link.generation,
    artistKey,
    trackKey,
  );
  if (delivery === null) return sent?.kind ?? 'none';
  if (sent === null || delivery.row_created_at_ms > sent.created_at_ms) return delivery.last_sent_kind;
  return sent.kind;
}
