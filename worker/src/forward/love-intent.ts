import type { Db } from '../do/db';

export interface ExplicitLoveIntentRecord {
  intent: string;
  operationId: string;
  updatedAtMs: number;
}

export function latestExplicitLoveIntentRecord(
  db: Db,
  did: string,
  artistKey: string,
  trackKey: string,
): ExplicitLoveIntentRecord | null {
  const row = db.one<{ intent: string; operation_id: string; updated_at_ms: number }>(
    'SELECT intent,operation_id,updated_at_ms FROM linked_love_intents WHERE did=? AND love_key=?',
    did,
    `${artistKey}\0${trackKey}`,
  );
  return row === null ? null : { intent: row.intent, operationId: row.operation_id, updatedAtMs: row.updated_at_ms };
}

/** Latest explicit API love decision for this normalized canonical key. */
export function latestExplicitLoveIntent(db: Db, did: string, artistKey: string, trackKey: string): string | null {
  return latestExplicitLoveIntentRecord(db, did, artistKey, trackKey)?.intent ?? null;
}
